import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';

async function fixture() {
  const db = new SqliteRelayDatabase(':memory:');
  const engine = new RelayEngine(db);
  const plannerProvider = new MockProvider('chatgpt');
  const workerProvider = new MockProvider('opencode');
  engine.registerProvider(plannerProvider);
  engine.registerProvider(workerProvider);

  const project = await engine.createProject('Start orchestration');
  const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
  const worker = await engine.registerRuntimeSession('opencode', 'Worker');
  const pair = await engine.createPair(project.id, 'Pair', planner.id, worker.id);
  // The relay baton addresses ONE exact provider session per side, so these fixtures bind a
  // real external session identity (I-11). Binding happens AFTER createPair on purpose:
  // createPair demands verified project-association evidence for a session that already has an
  // external id, and these fixtures exercise the relay loop rather than pairing authority.
  planner.updateExternalIdentity('ses_chatgpt_start_orchestration_lifecycle_pl1', '/dev/start_orchestration_lifecycle_pl1');
  worker.updateExternalIdentity('ses_opencode_start_orchestration_lifecycle_wr1', '/dev/start_orchestration_lifecycle_wr1');
  await db.runtimes.save(planner);
  await db.runtimes.save(worker);
  assert.equal((await engine.loadAndActivate(pair.id)).outcome, 'activated');
  return { db, engine, pair, planner, worker, plannerProvider, workerProvider };
}

describe('Start begins orchestration', () => {
  it('dispatches the oldest executable Assignment and keeps delivery separate from execution', async () => {
    const { db, engine, pair } = await fixture();
    await engine.createAssignment(pair.id, 'First', 'Do the first task');
    await engine.createAssignment(pair.id, 'Second', 'Do the second task');
    const expected = (await db.assignments.findByPairId(pair.id))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];

    await engine.startPair(pair.id);

    const stored = await db.assignments.findById(expected.id);
    assert.equal(stored?.status, 'active');
    assert.ok(stored?.currentAttemptId);
    const attempt = await db.attempts.findById(stored!.currentAttemptId!);
    const delivery = await db.deliveries.findById(stored!.activeDeliveryId!);
    assert.equal(delivery?.status, 'delivered');
    assert.equal(attempt?.status, 'prepared', 'delivery confirmation is not execution evidence');
    const rejected = await engine.promoteAttemptToRunning(stored!.id, delivery!.evidence!);
    assert.equal(rejected.promoted, false, 'delivery evidence cannot be reused as execution evidence');
    assert.equal((await db.attempts.findById(stored!.currentAttemptId!))?.status, 'prepared');
  });

  it('promotes on execution evidence, completes physically, then relays to the opposite side', async () => {
    const { db, engine, pair, planner, workerProvider } = await fixture();
    const first = await engine.createAssignment(pair.id, 'Build', 'Build the requested change');
    await engine.startPair(pair.id);

    workerProvider.isWorking = true;
    workerProvider.isComplete = false;
    await engine.runSupervisionTick();
    let stored = await db.assignments.findById(first.id);
    let attempt = await db.attempts.findById(stored!.currentAttemptId!);
    assert.equal(attempt?.status, 'running');

    workerProvider.isWorking = false;
    workerProvider.isComplete = true;
    workerProvider.responseSummary = 'Implementation and tests are complete.';
    await engine.runSupervisionTick();
    stored = await db.assignments.findById(first.id);
    attempt = await db.attempts.findById(stored!.currentAttemptId!);
    assert.equal(attempt?.status, 'completed_physical');
    assert.equal(stored?.status, 'waiting_for_handoff');
    assert.ok(stored?.activeHandoffId);

    await engine.runSupervisionTick();
    const all = await db.assignments.findByPairId(pair.id);
    const next = all.find((assignment) => assignment.sourceHandoffId === stored!.activeHandoffId);
    assert.ok(next, 'the ready Handoff must become exactly one next Assignment');
    assert.equal(next?.targetSideRole, 'planner');
    assert.equal((await db.deliveries.findById(next!.activeDeliveryId!))?.targetRuntimeId, planner.id);

    await engine.runSupervisionTick();
    const afterRetry = await db.assignments.findByPairId(pair.id);
    assert.equal(
      afterRetry.filter((assignment) => assignment.sourceHandoffId === stored!.activeHandoffId).length,
      1,
      'repeated ticks must not duplicate Handoff conversion',
    );
  });

  it('pause prevents new automated work and resume continues the deterministic queue', async () => {
    const { db, engine, pair } = await fixture();
    await engine.startPair(pair.id);
    await engine.pausePair(pair.id);
    const queued = await engine.createAssignment(pair.id, 'Queued while paused', 'Do this after resume');

    await engine.runSupervisionTick();
    assert.equal((await db.assignments.findById(queued.id))?.status, 'pending');
    assert.equal((await db.attempts.findByAssignmentId(queued.id)).length, 0);

    await engine.resumePair(pair.id);
    const resumed = await db.assignments.findById(queued.id);
    assert.equal(resumed?.status, 'active');
    assert.equal((await db.attempts.findByAssignmentId(queued.id)).length, 1);
  });
});
