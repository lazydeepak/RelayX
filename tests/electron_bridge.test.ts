import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import {
  ChatGPTProvider,
  OpenCodeProvider,
  VSCodeProvider,
} from '../src/relay/providers/adapters.ts';
import { RELAY_IPC_CHANNELS } from '../electron/ipc/contracts.ts';

describe('Electron IPC & RelayApiService Integration Tests', () => {
  test('Fresh RelayApiService starts with honest empty state (no fake initial resources)', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    engine.registerProvider(new ChatGPTProvider());
    engine.registerProvider(new OpenCodeProvider());
    engine.registerProvider(new VSCodeProvider());

    const api = new RelayApiService(db, engine, {
      isElectron: true,
      databasePath: '/tmp/test-relay.sqlite',
      databaseType: 'sqlite_wal',
      userDataPath: '/tmp/test-user-data',
    });

    const status = await api.getAppStatus();
    assert.equal(status.isElectron, true);
    assert.equal(status.databaseType, 'sqlite_wal');

    const dash = await api.getDashboardState();
    assert.equal(dash.metrics.totalProjects, 0);
    assert.equal(dash.metrics.totalPairs, 0);
    assert.equal(dash.metrics.totalRuntimes, 0);
    assert.equal(dash.metrics.activeWorkers, 0);
    assert.equal(dash.metrics.activeAssignments, 0);
    assert.equal(dash.metrics.openAttentionItems, 0);
    assert.equal(dash.recentEvents.length, 0);
  });

  test('Truthful provider integration status reporting', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const chatgpt = new ChatGPTProvider();
    const opencode = new OpenCodeProvider();
    const vscode = new VSCodeProvider();

    assert.equal(chatgpt.integrationStatus, 'partial');
    const openCodeStatus = process.platform === 'darwin' ? 'partial' : 'unsupported';
    assert.equal(opencode.integrationStatus, openCodeStatus);
    assert.equal(vscode.integrationStatus, 'partial');

    engine.registerProvider(chatgpt);
    engine.registerProvider(opencode);
    engine.registerProvider(vscode);

    const api = new RelayApiService(db, engine);

    const r1 = await api.registerRuntimeSession('chatgpt', 'ChatGPT Desktop Planner');
    assert.equal(r1.integrationStatus, 'partial');

    const r2 = await api.registerRuntimeSession('opencode', 'OpenCode CLI');
    assert.equal(r2.integrationStatus, openCodeStatus);

    const list = await api.listRuntimeSessions();
    assert.equal(list.length, 2);
  });

  test('Demo seeding is idempotent and does not create duplicate events on repeated invocation', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    engine.registerProvider(new ChatGPTProvider());
    engine.registerProvider(new OpenCodeProvider());
    engine.registerProvider(new VSCodeProvider());

    const api = new RelayApiService(db, engine);

    const firstSeed = await api.seedDemoEnvironment();
    assert.equal(firstSeed.seeded, true);

    const dash1 = await api.getDashboardState();
    const eventCountAfterFirstSeed = dash1.recentEvents.length;
    assert.ok(dash1.metrics.totalProjects >= 1);
    assert.ok(dash1.metrics.totalPairs >= 1);
    assert.ok(dash1.metrics.totalRuntimes >= 2);

    // Call seed again — must be a no-op!
    const secondSeed = await api.seedDemoEnvironment();
    assert.equal(secondSeed.seeded, false);

    const dash2 = await api.getDashboardState();
    assert.equal(dash2.recentEvents.length, eventCountAfterFirstSeed);
    assert.equal(dash2.metrics.totalProjects, dash1.metrics.totalProjects);
    assert.equal(dash2.metrics.totalPairs, dash1.metrics.totalPairs);
  });

  test('Supervision tick and pair state transitions operate over real SQLite storage', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    engine.registerProvider(new ChatGPTProvider());
    engine.registerProvider(new OpenCodeProvider());
    engine.registerProvider(new VSCodeProvider());

    const api = new RelayApiService(db, engine);
    await api.seedDemoEnvironment();

    const pairs = await api.listPairs();
    assert.equal(pairs.length, 1);
    const targetPair = pairs[0];

    // Pause pair
    const paused = await api.pausePair(targetPair.id);
    assert.equal(paused.status, 'paused');

    // Resume pair. The demo pair deliberately selects no runtime sessions, so it
    // has no active assignment and nothing to execute.
    //
    // CONTRACT CHANGE (S6): Start Pair is execution authority only and never grants
    // ACTIVE (§4.4 "Changes operational state: No"). On an IDLE Pair it refuses
    // truthfully instead of silently becoming a path into ACTIVE. This demo pair is
    // additionally UNBOUND, so the refusal must name that fact rather than advise
    // Load & Activate, which could not succeed for a pair with nothing bound.
    await assert.rejects(
      () => api.resumePair(targetPair.id),
      (err: any) => {
        assert.strictEqual(err?.code, 'PAIR_OPERATIONAL_STATE_IDLE');
        assert.match(err?.message ?? '', /no bound planner or worker runtime/);
        return true;
      },
      'Start Pair must refuse an IDLE pair and must not activate it',
    );
    // The refusal must not have mutated the stored pair: this is the real-SQLite
    // round-trip claim this test exists to make.
    const stillStored = await db.pairs.findById(targetPair.id as any);
    assert.equal(stillStored?.operationalState, 'IDLE');
    assert.equal(stillStored?.status, 'paused', 'a refused Start must leave the persisted lifecycle state alone');
    assert.equal(stillStored?.plannerSessionId, undefined);
    assert.equal(stillStored?.workerSessionId, undefined);

    // Run supervision tick
    const tickResult = await api.runSupervisionTick();
    assert.ok(tickResult.inspectedRuntimes >= 0);
  });

  test('All IPC channel constants are defined and unique', () => {
    const channels = Object.values(RELAY_IPC_CHANNELS);
    const uniqueChannels = new Set(channels);
    assert.equal(channels.length, uniqueChannels.size);
    assert.ok(channels.includes('relay:get-app-status'));
    assert.ok(channels.includes('relay:get-dashboard-state'));
    assert.ok(channels.includes('relay:run-supervision-tick'));
    assert.ok(channels.includes('relay:query-events'));
    assert.ok(channels.includes('relay:list-activities'));
    assert.ok(channels.includes('relay:run-archive-cycle'));
    assert.ok(channels.includes('relay:get-archive-policy'));
    assert.ok(channels.includes('relay:set-archive-policy'));
    assert.ok(channels.includes('relay:clear-logs'));
    assert.ok(channels.includes('relay:get-storage-accounting'));
    assert.ok(channels.includes('relay:export-audit-data'));
    assert.ok(channels.includes('relay:get-auxiliary-logs-info'));
    assert.ok(channels.includes('relay:read-auxiliary-log'));
    assert.ok(channels.includes('relay:clear-auxiliary-log'));
  });

  test('relayBridge exposes browser-safe observability methods without a backend', async () => {
    const { relayBridge } = await import('../src/services/relayBridge.ts');
    assert.ok(typeof relayBridge.queryEvents === 'function');
    assert.ok(typeof relayBridge.listActivities === 'function');
    assert.ok(typeof relayBridge.runArchiveCycle === 'function');
    assert.ok(typeof relayBridge.getArchivePolicy === 'function');
    assert.ok(typeof relayBridge.setArchivePolicy === 'function');
    assert.ok(typeof relayBridge.clearLogs === 'function');
    assert.ok(typeof relayBridge.getStorageAccounting === 'function');
    assert.ok(typeof relayBridge.exportAuditData === 'function');
    assert.ok(typeof relayBridge.getAuxiliaryLogsInfo === 'function');
    assert.ok(typeof relayBridge.readAuxiliaryLog === 'function');
    assert.ok(typeof relayBridge.clearAuxiliaryLog === 'function');

    const policy = await relayBridge.getArchivePolicy();
    assert.ok(policy.interval);

    const storage = await relayBridge.getStorageAccounting();
    assert.ok(typeof storage.totalEvents === 'number');

    const activities = await relayBridge.listActivities(10);
    assert.ok(Array.isArray(activities));
  });
});
