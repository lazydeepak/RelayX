import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from '../src/relay/providers/MockProvider.ts';
import { RuntimeNotAvailableError } from '../src/relay/domain/errors.ts';

describe('Relay Architectural Scenarios & Recovery Invariants', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let mockWorker: MockProvider;
  let mockPlanner: MockProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    mockWorker = new MockProvider('opencode');
    mockPlanner = new MockProvider('chatgpt');
    engine.registerProvider(mockWorker);
    engine.registerProvider(mockPlanner);
  });

  it('Scenario 1: Worker finishes while Relay is offline / between checks', async () => {
    const project = await engine.createProject('Offline Recovery Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner Alpha');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker Beta');
    const pair = await engine.createPair(project.id, 'Pair 1', planner.id, worker.id);

    const assignment = await engine.createAssignment(pair.id, 'Async Job', 'Compute long batch');
    await engine.dispatchAssignment(assignment.id);

    // External worker finishes offline
    mockWorker.isWorking = false;
    mockWorker.isComplete = true;
    mockWorker.responseSummary = 'Batch complete: 450 items processed';

    // Supervisor wakes up and inspects reality
    const tick = await engine.runSupervisionTick();
    assert.strictEqual(tick.handoffsCreated, 1);

    const updatedAsgn = await db.assignments.findById(assignment.id);
    assert.strictEqual(updatedAsgn?.status, 'waiting_for_handoff');

    const handoffs = await db.handoffs.findByAssignmentId(assignment.id);
    assert.strictEqual(handoffs.length, 1);
    assert.strictEqual(handoffs[0].resultSummary, 'Batch complete: 450 items processed');
  });

  it('Scenario 2: Runtime permanent termination requires exceeding failure thresholds', async () => {
    const project = await engine.createProject('Threshold Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner Alpha');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker Beta');
    const pair = await engine.createPair(project.id, 'Pair 1', planner.id, worker.id);

    const assignment = await engine.createAssignment(pair.id, 'Job', 'Run script');
    await engine.dispatchAssignment(assignment.id);

    // Fail 1: suspended
    mockWorker.shouldFailInspection = true;
    await engine.runSupervisionTick();
    let runtime = await db.runtimes.findById(worker.id);
    assert.strictEqual(runtime?.status, 'suspended');

    // Fail 2: still suspended
    await engine.runSupervisionTick();
    runtime = await db.runtimes.findById(worker.id);
    assert.strictEqual(runtime?.status, 'suspended');

    // Fail 3: now marked terminated
    await engine.runSupervisionTick();
    runtime = await db.runtimes.findById(worker.id);
    assert.strictEqual(runtime?.status, 'terminated');

    // Dispatching to terminated runtime must be blocked
    const newAsgn = await engine.createAssignment(pair.id, 'Job 2', 'Run next');
    await assert.rejects(
      async () => engine.dispatchAssignment(newAsgn.id),
      RuntimeNotAvailableError,
      'Dispatching to terminated runtime must be rejected',
    );
  });

  it('Scenario 3: Event timeline captures complete traceable lineage with evidence', async () => {
    const project = await engine.createProject('Observability Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner Alpha');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker Beta');
    const pair = await engine.createPair(project.id, 'Pair 1', planner.id, worker.id);

    const assignment = await engine.createAssignment(pair.id, 'Tracing Task', 'Log steps');
    await engine.dispatchAssignment(assignment.id);

    const events = await db.events.findRecent(50);
    assert.ok(events.length >= 5);

    // Confirm that delivery event has correlationId and evidence
    const deliveryConfirmedEvent = events.find((e) => e.eventType === 'delivery.confirmed');
    assert.ok(deliveryConfirmedEvent);
    assert.ok(deliveryConfirmedEvent?.correlationId);
    assert.ok(deliveryConfirmedEvent?.evidence);
    assert.strictEqual(deliveryConfirmedEvent?.evidence?.source, 'macos_accessibility');
  });
});
