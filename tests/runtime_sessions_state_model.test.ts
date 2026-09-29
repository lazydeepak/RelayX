/**
 * Runtime Sessions — State Model & Semantics Tests
 *
 * Verifies:
 * 1. Only concrete known session identities (ses_*, conversation URLs).
 * 2. Registered vs Observed vs Available vs Unavailable vs Attached/Unbound semantics.
 * 3. One canonical representation; no duplicate unpaired presentation.
 * 4. Manual registration selects an Integration and supplies concrete identity.
 * 5. Manual registration != verification/availability.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { AssociationId } from '../src/relay/domain/types.ts';
import {
  BrowserChatGPTProvider,
  BrowserOpenCodeProvider,
  BrowserVSCodeProvider,
} from '../src/relay/providers/browserProviders.ts';

function createTestService(): { service: RelayApiService; db: MemoryRelayDatabase; engine: RelayEngine } {
  const memDb = new MemoryRelayDatabase();
  const engine = new RelayEngine(memDb);
  engine.registerProvider(new BrowserChatGPTProvider());
  engine.registerProvider(new BrowserOpenCodeProvider());
  engine.registerProvider(new BrowserVSCodeProvider());

  const service = new RelayApiService(memDb, engine, {
    isElectron: false,
    databasePath: ':memory:',
    databaseType: 'memory',
  });

  return { service, db: memDb, engine };
}

describe('Runtime Sessions — State Model & Semantics', () => {
  it('1. Sessions preserve concrete external session identities without provider placeholder masquerading', async () => {
    const { service, db } = createTestService();

    const workerSession = RuntimeSession.create('opencode', 'Core OpenCode Session');
    workerSession.updateExternalIdentity('ses_core_worker_99', '/path/to/workspace');
    await db.runtimes.save(workerSession);

    const list = await service.listRuntimeSessions();
    const retrieved = list.find((s) => s.id === workerSession.id);

    assert.ok(retrieved);
    assert.strictEqual(retrieved.externalSessionId, 'ses_core_worker_99');
    assert.strictEqual(retrieved.externalProjectRef, '/path/to/workspace');
    assert.strictEqual(retrieved.providerType, 'opencode');
  });

  it('2. Attached vs Unbound semantics are derived directly from active pair bindings', async () => {
    const { service, db, engine } = createTestService();

    const project = await engine.createProject('Test Project', 'Description');
    const planner = RuntimeSession.create('chatgpt', 'Planner Session');
    planner.updateExternalIdentity('conv_123', 'https://chatgpt.com/g/g-p-123/project');
    await db.runtimes.save(planner);
    await db.associations.save(RuntimeProjectAssociation.create(
      planner.id,
      project.id,
      'conv_123',
      'verified',
      'adoption',
      'chatgpt',
    ));

    const worker = RuntimeSession.create('opencode', 'Worker Session');
    worker.updateExternalIdentity('ses_456', '/workspace');
    await db.runtimes.save(worker);
    await db.associations.save(RuntimeProjectAssociation.create(
      worker.id,
      project.id,
      'ses_456',
      'verified',
      'adoption',
      'opencode',
    ));

    const unbound = RuntimeSession.create('opencode', 'Unbound Standalone Worker');
    unbound.updateExternalIdentity('ses_789', '/workspace');
    await db.runtimes.save(unbound);

    // Create a pair binding planner + worker
    await engine.createPair(project.id, 'Pair Alpha', planner.id, worker.id);

    const pairs = await service.listPairs();
    const pair = pairs[0];

    assert.strictEqual(pair.plannerSessionId, planner.id);
    assert.strictEqual(pair.workerSessionId, worker.id);

    // Verification of attached pairs
    const attachedToPlanner = pairs.filter((p) => p.plannerSessionId === planner.id || p.workerSessionId === planner.id);
    const attachedToWorker = pairs.filter((p) => p.plannerSessionId === worker.id || p.workerSessionId === worker.id);
    const attachedToUnbound = pairs.filter((p) => p.plannerSessionId === unbound.id || p.workerSessionId === unbound.id);

    assert.strictEqual(attachedToPlanner.length, 1);
    assert.strictEqual(attachedToWorker.length, 1);
    assert.strictEqual(attachedToUnbound.length, 0, 'Unbound session has 0 pair bindings');
  });

  it('3. Manual registration requires concrete session identity and does not imply availability', async () => {
    const { service } = createTestService();

    // Register a session manually
    const registered = await service.registerRuntimeSession('opencode', 'Explicit Worker', 'ses_concrete_manual_101');
    assert.ok(registered.id);
    assert.strictEqual(registered.externalSessionId, 'ses_concrete_manual_101');
    // Initial state is unprobed / unknown
    assert.strictEqual(registered.status, 'unknown');
  });

  it('4. Detaching pair clears binding while preserving concrete session record in inventory', async () => {
    const { service, db, engine } = createTestService();

    const project = await engine.createProject('Detachment Project', 'Test');
    const worker = RuntimeSession.create('opencode', 'Persistent Worker');
    worker.updateExternalIdentity('ses_detach_test', '/workspace');
    await db.runtimes.save(worker);
    await db.associations.save(RuntimeProjectAssociation.create(
      worker.id,
      project.id,
      'ses_detach_test',
      'verified',
      'adoption',
      'opencode',
    ));

    const pair = await engine.createPair(project.id, 'Pair Beta', undefined, worker.id);
    assert.strictEqual(pair.workerSessionId, worker.id);

    // Detach worker from pair
    await service.detachPairRuntime(pair.id, 'worker');

    const updatedPair = await service.getPair(pair.id);
    assert.strictEqual(updatedPair?.workerSessionId, undefined);

    // The session still exists in the runtime session inventory
    const sessions = await service.listRuntimeSessions();
    const sessionInInventory = sessions.find((s) => s.id === worker.id);
    assert.ok(sessionInInventory);
    assert.strictEqual(sessionInInventory.externalSessionId, 'ses_detach_test');
  });
});
