/**
 * Phase H — End-to-End Exact-Session Pair Execution Proof
 *
 * Proves the authoritative execution loop:
 * - H1: Full Causal Loop (Planner -> Worker Dispatch [E] -> Execution -> Response Extraction [F] -> Exact Planner Delivery [G] -> Completion)
 * - H2: Duplicate Dispatch Prevention & Attempt Authority (Idempotency and anti-duplicate guards)
 * - H3: Full-Loop Engine Restart Durability & State Persistence
 * - H4: Ambiguous Delivery Handling & Honest Ambiguity Retention
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import { RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { AssociationId, createId } from '../src/relay/domain/types.ts';

describe('Phase H — End-to-End Exact-Session Pair Execution Proof', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let plannerProvider: MockProvider;
  let workerProvider: MockProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    plannerProvider = new MockProvider('chatgpt');
    workerProvider = new MockProvider('opencode');
    engine.registerProvider(plannerProvider);
    engine.registerProvider(workerProvider);
  });

  async function setupVerifiedPair(projectName: string, pairName: string) {
    const project = await engine.createProject(projectName);

    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'chatgpt',
      name: 'Planner Session',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ses_planner_h_auth',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);

    const worker = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Worker Session',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ses_worker_h_auth',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(worker);

    await db.associations.save(
      new RuntimeProjectAssociation({
        id: `assoc_${Date.now()}_pl` as AssociationId,
        runtimeSessionId: planner.id,
        projectId: project.id,
        providerType: 'chatgpt',
        externalSessionId: 'ses_planner_h_auth',
        verificationState: 'verified',
        provenance: 'setup',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await db.associations.save(
      new RuntimeProjectAssociation({
        id: `assoc_${Date.now()}_wk` as AssociationId,
        runtimeSessionId: worker.id,
        projectId: project.id,
        providerType: 'opencode',
        externalSessionId: 'ses_worker_h_auth',
        verificationState: 'verified',
        provenance: 'setup',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const pair = await engine.createPair(project.id, pairName, planner.id, worker.id);
    const activation = await engine.loadAndActivate(pair.id);
    assert.strictEqual(activation.outcome, 'activated');

    return { project, planner, worker, pair };
  }

  it('H1: Complete Causal Round-Trip Execution (E -> F -> G -> Completion)', async () => {
    const { pair, planner, worker } = await setupVerifiedPair('Project H1', 'Pair H1');

    // 1. Planner creates assignment
    const instructionText = 'Implement authentication middleware with unit tests';
    const assignment = await engine.createAssignment(pair.id, 'Task Auth Middleware', instructionText);
    assert.strictEqual(assignment.status, 'pending');

    // 2. Exact Worker Dispatch (Phase E)
    let capturedDeliveryRequest: any = null;
    const origDeliver = workerProvider.deliverInstruction.bind(workerProvider);
    workerProvider.deliverInstruction = async (req) => {
      capturedDeliveryRequest = req;
      return origDeliver(req);
    };

    const dispatchResult = await engine.dispatchAssignment(assignment.id);
    assert.ok(dispatchResult.attempt);
    assert.ok(dispatchResult.delivery);
    assert.strictEqual(dispatchResult.delivery.status, 'delivered');
    assert.strictEqual(capturedDeliveryRequest?.externalSessionId, worker.externalSessionId);
    assert.strictEqual(capturedDeliveryRequest?.runtimeSessionId, worker.id);

    // Verify assignment transitioned to active
    const activeAssignment = await db.assignments.findById(assignment.id);
    assert.strictEqual(activeAssignment?.status, 'active');

    // 3. Worker Execution & Actual Response Extraction (Phase F)
    workerProvider.isComplete = true;
    workerProvider.responseSummary = 'Authentication middleware implemented and verified with 5 tests.';

    await engine.runSupervisionTick();

    const handoffAssignment = await db.assignments.findById(assignment.id);
    assert.strictEqual(handoffAssignment?.status, 'waiting_for_handoff');
    assert.ok(handoffAssignment.activeHandoffId);

    const handoff = await db.handoffs.findById(handoffAssignment.activeHandoffId);
    assert.ok(handoff);
    assert.strictEqual(handoff.status, 'ready');
    assert.strictEqual(handoff.resultSummary, 'Authentication middleware implemented and verified with 5 tests.');

    // 4. Exact Planner Delivery (Phase G)
    let capturedPlannerDeliveryRequest: any = null;
    const origPlannerDeliver = plannerProvider.deliverInstruction.bind(plannerProvider);
    plannerProvider.deliverInstruction = async (req) => {
      capturedPlannerDeliveryRequest = req;
      return origPlannerDeliver(req);
    };

    const plannerAttempt = await engine.attemptPlannerDelivery(handoff.id);
    assert.strictEqual(plannerAttempt.outcome, 'externally_confirmed');
    assert.ok(plannerAttempt.evidence);
    assert.strictEqual(capturedPlannerDeliveryRequest?.externalSessionId, planner.externalSessionId);
    assert.strictEqual(capturedPlannerDeliveryRequest?.runtimeSessionId, planner.id);
    assert.ok(capturedPlannerDeliveryRequest?.instructionText.includes(handoff.resultSummary));

    // Verify handoff state transitioned to delivered with external evidence
    const deliveredHandoff = await db.handoffs.findById(handoff.id);
    assert.strictEqual(deliveredHandoff?.status, 'delivered');
    assert.ok(deliveredHandoff?.plannerDeliveryEvidence);

    // 5. Complete Handoff
    const completedHandoff = await engine.completeHandoff(handoff.id);
    assert.strictEqual(completedHandoff.status, 'complete');
  });

  it('H2: Duplicate-Dispatch Prevention and Attempt Authority', async () => {
    const { pair } = await setupVerifiedPair('Project H2', 'Pair H2');

    // 1. In-flight delivering prevents duplicate dispatch
    const assignment1 = await engine.createAssignment(pair.id, 'Task In-Flight Guard', 'Test in flight guard');
    
    // Simulate stranded in-flight delivery
    const { delivery } = await engine.dispatchAssignment(assignment1.id);
    delivery.status = 'delivering';
    await db.deliveries.save(delivery);

    await assert.rejects(
      async () => {
        await engine.dispatchAssignment(assignment1.id);
      },
      (err: any) => {
        return err.name === 'DuplicateDeliveryAttemptError' || err.message.includes('in-flight delivery');
      }
    );

    // 2. Ambiguous delivery blocks automated resend
    const assignment2 = await engine.createAssignment(pair.id, 'Task Ambiguity Resend Guard', 'Test ambiguous resend guard');
    workerProvider.deliveryOutcome = 'ambiguous';
    await engine.dispatchAssignment(assignment2.id);

    await assert.rejects(
      async () => {
        await engine.dispatchAssignment(assignment2.id);
      },
      (err: any) => {
        return err.name === 'AmbiguousDeliveryResendError' || err.message.includes('ambiguous delivery');
      }
    );
  });

  it('H3: Full-Loop Engine Restart Durability & State Persistence', async () => {
    const { pair, planner, worker } = await setupVerifiedPair('Project H3', 'Pair H3');

    const assignment = await engine.createAssignment(pair.id, 'Task Restart Resilience', 'Perform work across engine restart');
    const dispatchResult = await engine.dispatchAssignment(assignment.id);
    assert.strictEqual(dispatchResult.delivery.status, 'delivered');

    // Simulate complete process restart with fresh RelayEngine over same SQLite database
    const freshEngine = new RelayEngine(db);
    const freshPlannerProvider = new MockProvider('chatgpt');
    const freshWorkerProvider = new MockProvider('opencode');
    freshEngine.registerProvider(freshPlannerProvider);
    freshEngine.registerProvider(freshWorkerProvider);

    // Verify assignment state and attempt persisted cleanly
    const persistedAssignment = await db.assignments.findById(assignment.id);
    assert.strictEqual(persistedAssignment?.status, 'active');
    assert.strictEqual(persistedAssignment.currentAttemptId, dispatchResult.attempt.id);

    // Complete work post-restart
    freshWorkerProvider.isComplete = true;
    freshWorkerProvider.responseSummary = 'Post-restart worker output successfully delivered.';

    await freshEngine.runSupervisionTick();

    const postRestartAssignment = await db.assignments.findById(assignment.id);
    assert.strictEqual(postRestartAssignment?.status, 'waiting_for_handoff');
    assert.ok(postRestartAssignment.activeHandoffId);

    const handoff = await db.handoffs.findById(postRestartAssignment.activeHandoffId);
    assert.ok(handoff);
    assert.strictEqual(handoff.resultSummary, 'Post-restart worker output successfully delivered.');

    // Complete planner delivery on fresh engine
    const plannerAttempt = await freshEngine.attemptPlannerDelivery(handoff.id);
    assert.strictEqual(plannerAttempt.outcome, 'externally_confirmed');
    assert.strictEqual(plannerAttempt.handoff.status, 'delivered');
  });

  it('H4: Ambiguous Worker Transport Handling & Attention Generation', async () => {
    const { pair } = await setupVerifiedPair('Project H4', 'Pair H4');

    const assignment = await engine.createAssignment(pair.id, 'Task Ambiguity', 'Simulate delivery ambiguity');

    // Simulate provider returning ambiguous delivery outcome
    workerProvider.deliveryOutcome = 'ambiguous';
    workerProvider.deliveryFailureReason = 'Network socket closed unexpectedly during send';

    const dispatchResult = await engine.dispatchAssignment(assignment.id);
    assert.strictEqual(dispatchResult.delivery.status, 'ambiguous');

    // Invariant: Automated resend blocked; ambiguity preserved honestly
    const updatedAssignment = await db.assignments.findById(assignment.id);
    // Assignment remains active or flagged with ambiguity, never marked completed or delivered
    assert.ok(updatedAssignment);
    assert.strictEqual(updatedAssignment?.activeHandoffId, undefined);
  });
});
