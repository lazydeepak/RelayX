import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import { AmbiguousDeliveryResendError } from '../src/relay/domain/errors.ts';

describe('RelayX Engine Application Lifecycle & Supervision', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let mockProvider: MockProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    mockProvider = new MockProvider('opencode');
    engine.registerProvider(mockProvider);
    engine.registerProvider(new MockProvider('chatgpt'));
  });

  it('orchestrates project, pair, runtime and successful assignment delivery', async () => {
    const project = await engine.createProject('Engine Test Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'ChatGPT Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'OpenCode Worker');
    const pair = await engine.createPair(project.id, 'Pair 1', planner.id, worker.id);

    const assignment = await engine.createAssignment(pair.id, 'Refactor Engine', 'Organize into modules');
    assert.strictEqual(assignment.status, 'pending');

    // Dispatch assignment
    const { assignment: activeAsgn, attempt, delivery } = await engine.dispatchAssignment(assignment.id);
    assert.strictEqual(activeAsgn.status, 'active');
    assert.strictEqual(attempt.status, 'running');
    assert.strictEqual(delivery.status, 'delivered');
    assert.ok(delivery.evidence, 'Confirmed delivery must record observable evidence');

    // Worker runtime status updated
    const updatedWorker = await db.runtimes.findById(worker.id);
    assert.strictEqual(updatedWorker?.status, 'working');

    // Events emitted
    const events = await db.events.findRecent();
    const eventTypes = events.map((e) => e.eventType);
    assert.ok(eventTypes.includes('project.created'));
    assert.ok(eventTypes.includes('pair.created'));
    assert.ok(eventTypes.includes('assignment.created'));
    assert.ok(eventTypes.includes('delivery.started'));
    assert.ok(eventTypes.includes('delivery.confirmed'));
    assert.ok(eventTypes.includes('worker.started'));
  });

  it('marks uncertain delivery as ambiguous and blocks automated resend', async () => {
    mockProvider.deliveryOutcome = 'ambiguous';
    mockProvider.deliveryFailureReason = 'Window unfocused during click; composer not cleared';

    const project = await engine.createProject('Ambiguity Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine.createPair(project.id, 'Pair 1', planner.id, worker.id);

    const assignment = await engine.createAssignment(pair.id, 'Uncertain Task', 'Execute risky command');

    // Dispatch will encounter ambiguous delivery
    const { delivery } = await engine.dispatchAssignment(assignment.id);
    assert.strictEqual(delivery.status, 'ambiguous');

    // Verify Attention Item was created
    const attentionItems = await db.attention.findOpen();
    const ambiguousItem = attentionItems.find((i) => i.type === 'ambiguous_delivery');
    assert.ok(ambiguousItem, 'Critical attention item must be generated for ambiguous delivery');
    assert.strictEqual(ambiguousItem?.severity, 'critical');

    // Attempting to dispatch the same assignment again MUST throw AmbiguousDeliveryResendError!
    await assert.rejects(
      async () => engine.dispatchAssignment(assignment.id),
      AmbiguousDeliveryResendError,
      'Automated resend on ambiguous delivery must be prohibited by the engine',
    );

    // Operator performs Tier 1 reconciliation resolution
    await engine.resolveAmbiguousDelivery(delivery.id, 'confirmed_delivered');
    const resolvedDelivery = await db.deliveries.findById(delivery.id);
    assert.strictEqual(resolvedDelivery?.status, 'delivered');

    const openItemsAfter = await db.attention.findOpen();
    assert.strictEqual(openItemsAfter.length, 0, 'Attention item must be marked resolved');
  });

  it('runs supervision loop, detects completed worker, and delivers handoff to planner', async () => {
    const project = await engine.createProject('Supervision Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine.createPair(project.id, 'Pair 1', planner.id, worker.id);

    const assignment = await engine.createAssignment(pair.id, 'Build Component', 'Write React button');
    await engine.dispatchAssignment(assignment.id);

    // Worker finishes execution in external runtime
    mockProvider.isWorking = false;
    mockProvider.isComplete = true;
    mockProvider.stopButtonVisible = false;
    mockProvider.sendButtonVisible = true;
    mockProvider.responseSummary = 'Component code and unit tests are complete.';

    // Run supervisor tick
    const tickResult = await engine.runSupervisionTick();
    assert.strictEqual(tickResult.handoffsCreated, 1);

    // Assignment must now be waiting for handoff
    const updatedAsgn = await db.assignments.findById(assignment.id);
    assert.strictEqual(updatedAsgn?.status, 'waiting_for_handoff');
    assert.ok(updatedAsgn?.activeHandoffId);

    // Verify Handoff is ready for planner
    const handoff = await db.handoffs.findById(updatedAsgn!.activeHandoffId!);
    assert.ok(handoff);
    assert.strictEqual(handoff?.status, 'ready');
    assert.strictEqual(handoff?.resultSummary, 'Component code and unit tests are complete.');

    // Planner reviews and accepts handoff
    await engine.deliverHandoffToPlanner(handoff!.id);
    await engine.completeHandoff(handoff!.id);

    // Invariant check: assignment is still waiting_for_handoff or active until explicit completion
    const asgnAfterHandoff = await db.assignments.findById(assignment.id);
    assert.strictEqual(asgnAfterHandoff?.status, 'waiting_for_handoff');

    // Planner completes assignment
    await engine.completeAssignment(assignment.id);
    const finalAsgn = await db.assignments.findById(assignment.id);
    assert.strictEqual(finalAsgn?.status, 'completed');
  });

  it('supervisor detects temporary missing runtime, transitions to suspended without killing', async () => {
    const project = await engine.createProject('Missing Runtime Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine.createPair(project.id, 'Pair 1', planner.id, worker.id);

    const assignment = await engine.createAssignment(pair.id, 'Task', 'Run script');
    await engine.dispatchAssignment(assignment.id);

    // Simulate runtime window temporarily closed or hidden
    mockProvider.shouldFailInspection = true;

    // Run supervisor tick
    await engine.runSupervisionTick();

    const runtime = await db.runtimes.findById(worker.id);
    assert.strictEqual(runtime?.status, 'suspended', 'Single failure must transition to suspended, NOT terminated');

    // Warning attention item generated
    const openItems = await db.attention.findOpen();
    const suspendedItem = openItems.find((i) => i.type === 'runtime_suspended');
    assert.ok(suspendedItem, 'Suspension attention item should be raised');

    // Tier 1 deterministic recovery: window reopened
    mockProvider.shouldFailInspection = false;
    mockProvider.inspectionStatus = 'available';
    mockProvider.isWorking = false;
    await engine.reconcileAndRecoverRuntime(worker.id);

    const recovered = await db.runtimes.findById(worker.id);
    assert.strictEqual(recovered?.status, 'available');
  });
});
