/**
 * Phase G — Exact Planner Transport Tests
 *
 * Proves that:
 * 1. Exact Planner transport successfully delivers handoff summaries to the bound Planner runtime session (`ses_planner_*`) with provider evidence.
 * 2. Successful delivery results in `externally_confirmed` outcome and successfully transitions handoff via `markDeliveredToPlanner()`.
 * 3. Lacking an authoritative external session ID results in unverified attempt with capability gap explanation.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import { RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { AssociationId, createId } from '../src/relay/domain/types.ts';

describe('Phase G — Exact Planner Transport', () => {
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

  it('G1: Successfully delivers handoff to exact bound Planner session and confirms externally', async () => {
    const project = await engine.createProject('Phase G Proj');
    
    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'chatgpt',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ses_planner_abc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);

    const worker = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ses_worker_xyz',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(worker);

    await db.associations.save(
      new RuntimeProjectAssociation({
        id: 'assoc_g1_pl' as AssociationId,
        runtimeSessionId: planner.id,
        projectId: project.id,
        providerType: 'chatgpt',
        externalSessionId: 'ses_planner_abc',
        verificationState: 'verified',
        provenance: 'setup',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await db.associations.save(
      new RuntimeProjectAssociation({
        id: 'assoc_g1_wk' as AssociationId,
        runtimeSessionId: worker.id,
        projectId: project.id,
        providerType: 'opencode',
        externalSessionId: 'ses_worker_xyz',
        verificationState: 'verified',
        provenance: 'setup',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const pair = await engine.createPair(project.id, 'Phase G Pair', planner.id, worker.id);

    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');

    const assignment = await engine.createAssignment(pair.id, 'Task G', 'Build feature');
    await engine.dispatchAssignment(assignment.id);

    workerProvider.isComplete = true;
    workerProvider.responseSummary = 'Worker completed implementation successfully.';
    await engine.runSupervisionTick();

    const assignmentAfterTick = await db.assignments.findById(assignment.id);
    assert.strictEqual(assignmentAfterTick?.status, 'waiting_for_handoff');
    assert.ok(assignmentAfterTick.activeHandoffId);

    const handoff = await db.handoffs.findById(assignmentAfterTick.activeHandoffId);
    assert.ok(handoff);
    assert.strictEqual(handoff.status, 'ready');

    // Attempt delivery to planner
    const attempt = await engine.attemptPlannerDelivery(handoff.id);
    assert.strictEqual(attempt.outcome, 'externally_confirmed');
    assert.ok(attempt.evidence);
    assert.strictEqual(attempt.handoff.status, 'delivered');
    assert.ok(attempt.handoff.plannerDeliveryEvidence);
  });

  it('G2: Fails closed and reports unverified when bound Planner session lacks authoritative externalSessionId', async () => {
    const project = await engine.createProject('Phase G Proj 2');
    
    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'chatgpt',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: null, // No external session ID
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);

    const worker = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ses_worker_xyz',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(worker);

    await db.associations.save(
      new RuntimeProjectAssociation({
        id: 'assoc_g2_wk' as AssociationId,
        runtimeSessionId: worker.id,
        projectId: project.id,
        providerType: 'opencode',
        externalSessionId: 'ses_worker_xyz',
        verificationState: 'verified',
        provenance: 'setup',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );

    const pair = await engine.createPair(project.id, 'Phase G Pair 2', planner.id, worker.id);

    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');

    const assignment2 = await engine.createAssignment(pair.id, 'Task G2', 'Build feature 2');
    await engine.dispatchAssignment(assignment2.id);

    workerProvider.isComplete = true;
    workerProvider.responseSummary = 'Worker completed task.';
    await engine.runSupervisionTick();

    const assignmentAfterTick = await db.assignments.findById(assignment2.id);
    assert.ok(assignmentAfterTick?.activeHandoffId);

    const handoff = await db.handoffs.findById(assignmentAfterTick.activeHandoffId);
    assert.ok(handoff);

    const attempt = await engine.attemptPlannerDelivery(handoff.id);
    assert.strictEqual(attempt.outcome, 'unverified');
    assert.ok(attempt.reason);
    assert.strictEqual(handoff.status, 'ready'); // Unchanged
  });
});
