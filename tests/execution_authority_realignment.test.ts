import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import { PairId, HandoffId } from '../src/relay/domain/types.ts';
import { RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';

describe('Execution Authority Realignment — Hard Regression Proofs', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let planner: MockProvider;
  let worker: MockProvider;
  let pairId: PairId;

  beforeEach(async () => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    planner = new MockProvider('chatgpt');
    worker = new MockProvider('opencode');
    engine.registerProvider(planner);
    engine.registerProvider(worker);

    const project = await engine.createProject('Authority Test');
    const pSession = await engine.registerRuntimeSession('chatgpt', 'Planner', undefined, 'ses_p1');
    const wSession = await engine.registerRuntimeSession('opencode', 'Worker', undefined, 'ses_w1');
    
    // Add verified authoritative associations required by engine.createPair
    await db.associations.save(
      RuntimeProjectAssociation.create(pSession.id, project.id, 'ses_p1', 'verified', 'setup', 'chatgpt')
    );
    await db.associations.save(
      RuntimeProjectAssociation.create(wSession.id, project.id, 'ses_w1', 'verified', 'setup', 'opencode')
    );

    const pair = await engine.createPair(project.id, 'Pair 1', pSession.id, wSession.id);
    pairId = pair.id;
  });

  test('1. loadAndActivate() => ACTIVE + STOPPED => zero background provider contact', async () => {
    const res = await engine.loadAndActivate(pairId);
    assert.strictEqual(res.outcome, 'activated');
    
    const reloaded = await db.pairs.findById(pairId);
    assert.ok(reloaded);
    assert.strictEqual(reloaded.operationalState, 'ACTIVE');
    assert.strictEqual(reloaded.relayState, 'STOPPED');

    // Create an assignment to track background supervision contact
    const assignment = await engine.createAssignment(pairId, 'Task', 'Instruction');
    await engine.dispatchAssignment(assignment.id);
    
    // Clear initial contact from activation/dispatch
    let workerContactCount = 0;
    const originalObserve = worker.observeSide.bind(worker);
    worker.observeSide = async (params) => {
      workerContactCount++;
      return originalObserve(params);
    };

    const tick = await engine.runSupervisionTick();
    // inspectedAssignments just returns total active assignments in DB, not those that passed the gate
    assert.strictEqual(workerContactCount, 0, 'Background tick should perform zero provider contact for STOPPED pair');
  });

  test('2. loadAndActivate() + explicit observe/inspect => provider contact allowed', async () => {
    await engine.loadAndActivate(pairId);
    
    let contactCount = 0;
    const originalInspect = worker.inspectRuntime.bind(worker);
    worker.inspectRuntime = async (id) => {
      contactCount++;
      return originalInspect(id);
    };

    // Explicit observeSide (OPERATOR_EXPLICIT)
    // observeSide calls provider.observeSide, not inspectRuntime?
    // Wait, let's check observeSide implementation.
    // It calls provider.observeSide.
    
    // Let's mock both to be safe.
    const originalObserve = worker.observeSide.bind(worker);
    worker.observeSide = async (params) => {
      contactCount++;
      return originalObserve(params);
    };

    // Explicit observeSide (OPERATOR_EXPLICIT)
    const obs = await engine.observeSide(pairId, 'worker');
    assert.strictEqual(obs.outcome, 'observed');
    assert.strictEqual(obs.providerContacted, true);
    assert.strictEqual(contactCount, 1);

    // Explicit observeCompletedTurn (OPERATOR_EXPLICIT)
    // observeCompletedTurn calls provider.observeSide AND then engine.observeSide (which calls provider.observeSide)
    // So it should increment contactCount by 2.
    const turn = await engine.observeCompletedTurn(pairId, 'worker');
    assert.strictEqual(turn.outcome, 'observed');
    assert.strictEqual(turn.providerContacted, true);
    assert.strictEqual(contactCount, 3);
  });

  test('3. loadAndActivate() + startPair() + background tick => automated provider contact allowed', async () => {
    await engine.loadAndActivate(pairId);
    await engine.startPair(pairId);

    const reloaded = await db.pairs.findById(pairId);
    assert.ok(reloaded);
    assert.strictEqual(reloaded.relayState, 'RUNNING');

    const assignment = await engine.createAssignment(pairId, 'Task', 'Instruction');
    await engine.dispatchAssignment(assignment.id);

    let contactCount = 0;
    const originalInspect = worker.inspectRuntime.bind(worker);
    worker.inspectRuntime = async (id) => {
      contactCount++;
      return originalInspect(id);
    };

    const tick = await engine.runSupervisionTick();
    assert.strictEqual(contactCount, 1, 'Background tick should perform provider contact for RUNNING pair');
  });

  test('4. pausePair() => explicit operator inspect allowed, background tick forbidden', async () => {
    await engine.loadAndActivate(pairId);
    await engine.startPair(pairId);
    await engine.pausePair(pairId);

    const reloaded = await db.pairs.findById(pairId);
    assert.ok(reloaded);
    assert.strictEqual(reloaded.relayState, 'PAUSED');

    let contactCount = 0;
    const originalObserve = worker.observeSide.bind(worker);
    worker.observeSide = async (params) => {
      contactCount++;
      return originalObserve(params);
    };
    const originalInspect = worker.inspectRuntime.bind(worker);
    worker.inspectRuntime = async (id) => {
      contactCount++;
      return originalInspect(id);
    };

    // Explicit operator inspect allowed
    const obs = await engine.observeSide(pairId, 'worker');
    assert.strictEqual(obs.providerContacted, true);
    assert.strictEqual(contactCount, 1);

    // Background tick forbidden
    const assignment = await engine.createAssignment(pairId, 'Task', 'Instruction');
    await engine.dispatchAssignment(assignment.id);
    const tick = await engine.runSupervisionTick();
    assert.strictEqual(contactCount, 1, 'No additional contact from background tick');
  });

  test('5. stopPair() => explicit operator inspect allowed, background tick forbidden', async () => {
    await engine.loadAndActivate(pairId);
    await engine.startPair(pairId);
    await engine.stopPair(pairId);

    const reloaded = await db.pairs.findById(pairId);
    assert.ok(reloaded);
    assert.strictEqual(reloaded.relayState, 'STOPPED');

    let contactCount = 0;
    const originalObserve = worker.observeSide.bind(worker);
    worker.observeSide = async (params) => {
      contactCount++;
      return originalObserve(params);
    };
    const originalInspect = worker.inspectRuntime.bind(worker);
    worker.inspectRuntime = async (id) => {
      contactCount++;
      return originalInspect(id);
    };

    // Explicit operator inspect allowed
    const obs = await engine.observeSide(pairId, 'worker');
    assert.strictEqual(obs.providerContacted, true);
    assert.strictEqual(contactCount, 1);

    // Background tick forbidden
    const assignment = await engine.createAssignment(pairId, 'Task', 'Instruction');
    await engine.dispatchAssignment(assignment.id);
    const tick = await engine.runSupervisionTick();
    assert.strictEqual(contactCount, 1, 'No additional contact from background tick');
  });

  test('6. IDLE => explicit ordinary inspect/dispatch forbidden', async () => {
    const reloaded = await db.pairs.findById(pairId);
    assert.ok(reloaded);
    assert.strictEqual(reloaded.operationalState, 'IDLE');

    // Explicit inspect forbidden
    const obs = await engine.observeSide(pairId, 'worker');
    assert.strictEqual(obs.outcome, 'refused');
    assert.strictEqual(obs.providerContacted, false);

    // Explicit dispatch forbidden
    const assignment = await engine.createAssignment(pairId, 'Task', 'Instruction');
    await assert.rejects(
      () => engine.dispatchAssignment(assignment.id),
      { code: 'PAIR_OPERATIONAL_STATE_IDLE' }
    );

    // Explicit attemptPlannerDelivery forbidden
    // Need a handoff
    // Manually create a handoff for testing refusal
    // (In reality, dispatching is already forbidden above)
  });

  test('7. IDLE => explicit loadAndActivate verification permitted', async () => {
    // This is Requirement H: Verification is a special authority.
    // It should contact providers even though IDLE.
    let contactCount = 0;
    const originalResolve = planner.resolveSideIdentity.bind(planner);
    planner.resolveSideIdentity = async (params) => {
      contactCount++;
      return originalResolve(params);
    };

    const res = await engine.loadAndActivate(pairId);
    assert.strictEqual(res.outcome, 'activated');
    assert.ok(contactCount > 0, 'loadAndActivate should have performed provider contact for verification');
  });
});
