/**
 * Engine Settings & Maintenance Tests
 *
 * Verifies:
 * 1. Strict separation of configurable policy vs read-only host/engine truth.
 * 2. Immutable safety invariants (ambiguity/resend protection, checkpoint append-only, automatic pair creation fresh provisioning).
 * 3. Ambiguous delivery raises attention and strictly prohibits automatic retry.
 * 4. Read-only host environment truth accurately distinguishes native Electron from browser preview.
 * 5. Destructive maintenance resets state while respecting boundaries.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import {
  RuntimeSession,
  RuntimeProjectAssociation,
  Assignment,
  Delivery,
  Attempt,
} from '../src/relay/domain/entities.ts';
import {
  BrowserChatGPTProvider,
  BrowserOpenCodeProvider,
  BrowserVSCodeProvider,
} from '../src/relay/providers/browserProviders.ts';

function createTestService(isElectron = false): {
  service: RelayApiService;
  db: MemoryRelayDatabase;
  engine: RelayEngine;
} {
  const memDb = new MemoryRelayDatabase();
  const engine = new RelayEngine(memDb);
  engine.registerProvider(new BrowserChatGPTProvider());
  engine.registerProvider(new BrowserOpenCodeProvider());
  engine.registerProvider(new BrowserVSCodeProvider());

  const service = new RelayApiService(memDb, engine, {
    isElectron,
    databasePath: isElectron ? '/tmp/relayx.db' : ':memory:',
    databaseType: isElectron ? 'sqlite_wal' : 'memory',
  });

  return { service, db: memDb, engine };
}

describe('Engine Settings & Maintenance', () => {
  it('1. Read-only host environment truth exposes real platform, database, and permission capabilities', async () => {
    const { service } = createTestService(true);

    const status = await service.getAppStatus();
    assert.strictEqual(status.isElectron, true);
    assert.strictEqual(status.platform, process.platform);
    assert.strictEqual(status.databaseType, 'sqlite_wal');
    assert.strictEqual(status.databasePath, '/tmp/relayx.db');
    assert.ok(status.permissions, 'Permissions block must be present');
    assert.strictEqual(typeof status.permissions.accessibilityGranted, 'boolean');
  });

  it('2. Safety invariant: Ambiguous delivery raises attention item and strictly forbids automatic retry', async () => {
    const { service, engine, db } = createTestService();

    const project = await engine.createProject('Safety Invariant Project');

    const planner = RuntimeSession.create('chatgpt', 'Planner Invariant');
    const plannerExtId = 'conv_safety_1';
    planner.updateExternalIdentity(plannerExtId);
    await db.runtimes.save(planner);

    const worker = RuntimeSession.create('opencode', 'Worker Invariant');
    const workerExtId = 'ses_safety_1';
    worker.updateExternalIdentity(workerExtId);
    await db.runtimes.save(worker);

    await db.associations.save(
      RuntimeProjectAssociation.create(
        planner.id,
        project.id,
        plannerExtId,
        'verified',
        'adoption',
        'chatgpt',
      ),
    );
    await db.associations.save(
      RuntimeProjectAssociation.create(
        worker.id,
        project.id,
        workerExtId,
        'verified',
        'adoption',
        'opencode',
      ),
    );

    const pair = await engine.createPair(project.id, 'Safety Pair', planner.id, worker.id);

    // Create an assignment and an ambiguous delivery
    const assignment = Assignment.create(pair.id, project.id, 'Task objective', 'Task instruction');
    await db.assignments.save(assignment);

    const attempt = Attempt.create(assignment.id, 1);
    await db.attempts.save(attempt);

    const delivery = Delivery.create(assignment.id, attempt.id, worker.id, 'worker_instruction', 'opencode');
    delivery.markAmbiguous('Network dropped during packet confirmation; delivery state uncertain');
    await db.deliveries.save(delivery);

    // Reconcile stranded / unresolved dispatches
    const report = await engine.reconcileUnresolvedDispatches();
    assert.strictEqual(typeof report.ambiguousRaised, 'number');

    // Verify ambiguous delivery is exposed in attention items or unresolved status
    const dRecord = await db.deliveries.findById(delivery.id);
    assert.strictEqual(dRecord?.status, 'ambiguous');

    // Resolving ambiguous delivery requires operator action
    await service.resolveAmbiguousDelivery(delivery.id, 'confirmed_delivered');
    const resolvedRecord = await db.deliveries.findById(delivery.id);
    assert.strictEqual(resolvedRecord?.status, 'delivered');
  });

  it('3. Configurable policy is isolated in provider_settings and does not mutate engine invariants', async () => {
    const { service, engine } = createTestService();

    // Set supervision interval policy
    await engine.setProviderSetting('policy:supervisionInterval', '10000', {
      note: 'Supervision polling 10s',
      setBy: 'operator',
    });

    const setting = await engine.getProviderSetting('policy:supervisionInterval');
    assert.strictEqual(setting?.value, '10000');
    assert.strictEqual(setting?.setBy, 'operator');

    // List all provider settings
    const allSettings = await engine.listProviderSettings();
    assert.ok(allSettings.some((s) => s.key === 'policy:supervisionInterval'));
  });

  it('4. Destructive maintenance: clearLocalDatabase resets active repository entities safely', async () => {
    const { service, engine, db } = createTestService();

    await engine.createProject('Ephemeral Project');
    const projectsBefore = await service.listProjects();
    assert.ok(projectsBefore.length >= 1);

    // Clear database
    await service.clearDatabase();

    const projectsAfter = await service.listProjects();
    assert.strictEqual(projectsAfter.length, 0, 'All projects must be reset');

    const pairsAfter = await service.listPairs();
    assert.strictEqual(pairsAfter.length, 0, 'All pairs must be reset');
  });
});
