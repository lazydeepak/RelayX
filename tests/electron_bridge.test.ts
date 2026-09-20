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
    assert.equal(opencode.integrationStatus, 'unsupported');
    assert.equal(vscode.integrationStatus, 'partial');

    engine.registerProvider(chatgpt);
    engine.registerProvider(opencode);
    engine.registerProvider(vscode);

    const api = new RelayApiService(db, engine);

    const r1 = await api.registerRuntimeSession('chatgpt', 'ChatGPT Desktop Planner');
    assert.equal(r1.integrationStatus, 'partial');

    const r2 = await api.registerRuntimeSession('opencode', 'OpenCode CLI');
    assert.equal(r2.integrationStatus, 'unsupported');

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

    // Resume pair
    const resumed = await api.resumePair(targetPair.id);
    assert.equal(resumed.status, 'active');

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
  });
});
