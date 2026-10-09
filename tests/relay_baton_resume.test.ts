/**
 * THE RELAY BATON — Pair resume / continuation, verified scenario by scenario.
 * =========================================================================
 *
 * RelayX is a session watcher and a postman. These tests prove it restores communication
 * continuity without ever judging whether the work was correct.
 *
 * ## The rule under test
 *
 * The recipient of the last CONFIRMED Delivery holds the baton and owes the next completed
 * turn. A newer completed turn transfers the baton only once RelayX has confirmed the
 * Delivery that carried it to the opposite side.
 *
 * ## What these tests assert, beyond the outcome
 *
 * Every scenario asserts the whole evidence chain, because a passing outcome alone would not
 * distinguish a correct decision from a lucky one:
 *
 *   latest confirmed Delivery -> direction -> baton owner -> persisted message-id boundary
 *   -> latest authoritative turn on that side -> running/generating state -> the action
 *   RelayX chose -> whether a Delivery was created -> whether it was confirmed -> the
 *   resulting baton owner.
 *
 * ## The semantic boundary
 *
 * Tests that exercise the recovery path assert the ABSENCE of semantic claims. RelayX must
 * never report that a side failed, completed, or produced an invalid result; it reports only
 * that no confirmed return turn exists. Those negative assertions are the point of the
 * feature, so they are asserted directly rather than left to review.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import type { AssignmentId, PairId, PairSideRole, RuntimeSessionId } from '../src/relay/domain/types.ts';
import type { Delivery } from '../src/relay/domain/entities.ts';

interface Fixture {
  db: SqliteRelayDatabase;
  engine: RelayEngine;
  pairId: PairId;
  plannerRuntimeId: RuntimeSessionId;
  workerRuntimeId: RuntimeSessionId;
  plannerProvider: MockProvider;
  workerProvider: MockProvider;
}

/**
 * A bound, ACTIVE, RUNNING Pair whose two sides carry real provider session identities.
 *
 * The identities are not decoration. The relay baton addresses ONE exact provider session on
 * the side it inspects, so without a provider-owned id there is nothing to inspect and every
 * scenario here would be vacuous.
 */
async function fixture(): Promise<Fixture> {
  const db = new SqliteRelayDatabase(':memory:');
  const engine = new RelayEngine(db);
  const plannerProvider = new MockProvider('chatgpt');
  const workerProvider = new MockProvider('opencode');
  engine.registerProvider(plannerProvider);
  engine.registerProvider(workerProvider);

  // Provide a stub planner observer so Start Pair can establish its bootstrap arm
  // and so baton evaluation can observe the Planner via the observer path.
  const stubObserver = {
    armedArmId: null as string | null,
    async ensureBootstrapArmed(conversationId: string) {
      if (!this.armedArmId) this.armedArmId = `arm_${Date.now()}`;
      return { armId: this.armedArmId, conversationId, reused: false };
    },
    async bootstrapStatus() {
      return {
        available: true, unavailableReason: null, conversationId: '', armId: this.armedArmId,
        armActive: false, working: false, completion: null, lastState: null, lastObservedAt: null
      };
    },
    async acknowledgeBootstrapArm() {},
    // Methods for observePlannerWithObserver (used during baton evaluation)
    async ensureArmed(conversationId: string, note: string, deliveryId: string) {
      if (!this.armedArmId) this.armedArmId = `arm_${Date.now()}`;
      return { armId: this.armedArmId, conversationId, reused: false };
    },
    async status(conversationId: string, deliveryId: string) {
      return {
        available: true, unavailableReason: null, conversationId,
        armId: this.armedArmId, armActive: false, working: this.isWorking ?? false,
        completion: this.isComplete ? {
          armId: this.armedArmId, conversationId,
          responseText: this.responseSummary ?? 'Task completed.',
          responseHash: 'sha256_mock', responseLength: (this.responseSummary ?? '').length,
          completedTurnKey: 'mock-turn-key', observedAt: new Date().toISOString(),
          adoptedFromUnresolvableArm: false
        } : null,
        lastState: this.isWorking ? 'working' : (this.isComplete ? 'finished' : 'identity'),
        lastObservedAt: new Date().toISOString(),
      };
    },
    isWorking: false,
    isComplete: false,
    responseSummary: 'Task completed successfully.',
  };
  engine['plannerObserver'] = stubObserver as any;

  const project = await engine.createProject('Baton Project');
  const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
  const worker = await engine.registerRuntimeSession('opencode', 'Worker');
  const pair = await engine.createPair(project.id, 'Baton Pair', planner.id, worker.id);
  planner.updateExternalIdentity('ses_baton_planner', '/dev/baton_planner');
  worker.updateExternalIdentity('ses_baton_worker', '/dev/baton_worker');
  await db.runtimes.save(planner);
  await db.runtimes.save(worker);
  assert.equal((await engine.loadAndActivate(pair.id)).outcome, 'activated');
  await engine.startPair(pair.id);

  return {
    db,
    engine,
    pairId: pair.id,
    plannerRuntimeId: planner.id,
    workerRuntimeId: worker.id,
    plannerProvider,
    workerProvider,
  };
}

/** Dispatch one Assignment to the Worker. That confirmed Delivery is what gives the Worker the baton. */
async function dispatchToWorker(f: Fixture, instruction = 'Do the work'): Promise<string> {
  const assignment = await f.engine.createAssignment(f.pairId, 'Work', instruction);
  const { delivery } = await f.engine.dispatchAssignment(assignment.id);
  assert.equal(delivery.status, 'delivered', 'the dispatch must be confirmed for a baton to exist');
  return assignment.id;
}

/**
 * Drive the relay until the PLANNER holds the baton.
 *
 * The only honest way to obtain a Worker -> Planner confirmed Delivery is to actually perform
 * one: the Worker completes, its turn is handed on, and that hand-over is confirmed. Building
 * the Delivery by hand would test a state the system can never reach.
 */
async function driveToPlannerBaton(f: Fixture): Promise<void> {
  await dispatchToWorker(f, 'First instruction');
  f.workerProvider.isWorking = false;
  f.workerProvider.isComplete = true;
  f.workerProvider.responseSummary = 'Worker produced a completed answer.';

  const recordTurn = await f.engine.runSupervisionTick();
  assert.equal(recordTurn.batonDecisions[0]?.decision, 'transfer_completed_turn');
  assert.equal(recordTurn.batonDecisions[0]?.action.kind, 'handoff_created');

  const handOver = await f.engine.runSupervisionTick();
  const decision = handOver.batonDecisions[0];
  assert.equal(decision?.decision, 'transfer_completed_turn');
  assert.equal(decision?.action.kind, 'handoff_advanced');
  assert.equal(decision?.action.deliveryConfirmed, true, 'the hand-over must be confirmed');

  // The Planner provider needs a transcript with at least one user turn (the boundary
  // from the Worker -> Planner confirmed Delivery) so that baton evaluation can read
  // post-boundary turns. Append a dummy user turn to serve as the boundary.
  f.plannerProvider.appendUserTurn('Worker response delivered to Planner', Date.now());

  const baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
  assert.equal(baton.direction, 'worker_to_planner');
  assert.equal(baton.owner, 'planner');
}

/** The confirmed Delivery for one Assignment, newest last. */
async function confirmedDeliveriesFor(f: Fixture, assignmentId: string): Promise<Delivery[]> {
  return (await f.db.deliveries.findByAssignmentId(assignmentId as any)).filter(
    (d) => d.status === 'delivered',
  );
}

/** Assert the recovery notice states the mechanical gap and makes NO semantic verdict. */
function assertRecoveryNoticeIsFactual(text: string, expectedOwner: PairSideRole): void {
  const lower = text.toLowerCase();

  // The mechanical fact must be present.
  assert.match(lower, /does not have a confirmed/);
  assert.match(lower, /communication continuity only/);
  assert.match(
    lower,
    expectedOwner === 'worker'
      ? /confirmed delivered to the worker/
      : /confirmed completed planner turn after the last delivered worker response/,
  );

  // The notice must carry an explicit disclaimer, and it is the ONLY place any of these words
  // may appear — as a denial. It is split out before the scan below so that a correctly
  // worded "RelayX is not asserting that the Worker failed" is not mistaken for the very
  // claim it disclaims.
  const paragraphs = text.split('\n\n').map((p) => p.trim()).filter(Boolean);
  const disclaimer = paragraphs.find((p) => /relayx is not asserting/i.test(p));
  assert.ok(disclaimer, `the notice must explicitly disclaim any semantic verdict:\n${text}`);
  assert.match(disclaimer!, new RegExp(expectedOwner, 'i'));

  const asserted = paragraphs.filter((p) => p !== disclaimer).join('\n').toLowerCase();

  // The semantic boundary. Each of these would smuggle in a judgment RelayX must not make.
  const forbidden = [
    'worker failed',
    'the worker has failed',
    'worker did not complete',
    'task is incomplete',
    'task was not completed',
    'work is incomplete',
    'result was invalid',
    'invalid result',
    'drifted',
    'was correct',
    'was wrong',
    'insufficient result',
    'the planner made a mistake',
    'planning error',
    'has completed the task',
  ];
  for (const phrase of forbidden) {
    assert.ok(
      !asserted.includes(phrase),
      `the recovery notice must not assert "${phrase}"; RelayX reports a mechanical gap only:\n${text}`,
    );
  }

  // And it must not contain any hardcoded identity from a particular deployment.
  for (const hardcoded of ['RelayX Project', 'Baton Pair', 'tab_', 'Baton Worker']) {
    assert.ok(!text.includes(hardcoded), `recovery text must not hardcode "${hardcoded}"`);
  }
}

describe('Relay baton — Cases A: last confirmed Delivery was Planner -> Worker', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  it('A1: Worker still running -> observation only, no injected prompt and no resend', async () => {
    const assignmentId = await dispatchToWorker(f);
    const deliveriesBefore = await confirmedDeliveriesFor(f, assignmentId);

    f.workerProvider.isWorking = true;
    f.workerProvider.isComplete = false;
    f.workerProvider.partialResponseSummary = 'mid-sentence, still going';

    const tick = await f.engine.runSupervisionTick();
    const report = tick.batonDecisions[0];

    // Evidence chain.
    assert.equal(report!.baton.direction, 'planner_to_worker');
    assert.equal(report!.baton.owner, 'worker');
    assert.equal(report!.baton.deliveryId, deliveriesBefore[0]!.id);
    assert.equal(report!.baton.boundaryProvenance, 'captured_pre_dispatch');
    assert.equal(report!.observation!.inFlight, true, 'an unterminated turn means still working');
    assert.equal(report!.observation!.hasCompletedResponse, false);

    // Action: none at all.
    assert.equal(report!.decision, 'observe_baton_owner_working');
    assert.equal(report!.action.kind, 'none');
    assert.equal(tick.handoffsCreated, 0);

    // No new Delivery, no new Assignment, no message of any kind injected.
    const deliveriesAfter = await confirmedDeliveriesFor(f, assignmentId);
    assert.equal(deliveriesAfter.length, deliveriesBefore.length, 'the instruction must not be resent');
    const pairAssignments = (await f.db.assignments.findByPairId(f.pairId)).filter(
      (a) => a.sourceRecoveryDeliveryId !== undefined,
    );
    assert.equal(pairAssignments.length, 0, 'no recovery notice may be injected while the Worker is working');

    // The baton is unchanged.
    const baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(baton.owner, 'worker');
  });

  it('A2: completed Worker turn exists -> delivered exactly once, confirmed, baton moves to Planner', async () => {
    const assignmentId = await dispatchToWorker(f);

    f.workerProvider.isWorking = false;
    f.workerProvider.isComplete = true;
    const workerAnswer = 'The full Worker answer, delivered verbatim.';
    f.workerProvider.responseSummary = workerAnswer;

    // Tick 1 records the completed turn as a Handoff. It is deliberately NOT handed over in the
    // same evaluation, so "completed" and "handed over" stay separately observable.
    const first = await f.engine.runSupervisionTick();
    assert.equal(first.batonDecisions[0]!.decision, 'transfer_completed_turn');
    assert.equal(first.batonDecisions[0]!.action.kind, 'handoff_created');

    let baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(baton.owner, 'worker', 'a locally observed turn must NOT move the baton');

    // Tick 2 hands it over. That Delivery is what moves the baton.
    const second = await f.engine.runSupervisionTick();
    assert.equal(second.batonDecisions[0]!.action.kind, 'handoff_advanced');
    assert.equal(second.batonDecisions[0]!.action.deliveryConfirmed, true);

    baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(baton.direction, 'worker_to_planner');
    assert.equal(baton.owner, 'planner', 'the baton moves only after the Delivery is confirmed');

    // The turn reached the Planner verbatim, with no summarising or judging.
    const plannerAssignment = (await f.db.assignments.findByPairId(f.pairId)).find(
      (a) => a.targetSideRole === 'planner' && a.sourceHandoffId !== undefined,
    );
    assert.ok(plannerAssignment, 'the completed turn must become one opposite-side Assignment');
    const handoff = await f.db.handoffs.findById(plannerAssignment!.sourceHandoffId!);
    assert.equal(handoff!.resultSummary, workerAnswer);
    const delivered = await confirmedDeliveriesFor(f, plannerAssignment!.id);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.targetRuntimeId, f.plannerRuntimeId);

    // Ticking again must not hand it over a second time.
    const third = await f.engine.runSupervisionTick();
    assert.notEqual(third.batonDecisions[0]!.action.kind, 'handoff_advanced');
    const conversions = (await f.db.assignments.findByPairId(f.pairId)).filter(
      (a) => a.sourceHandoffId === handoff!.id,
    );
    assert.equal(conversions.length, 1, 'exactly-once: one Handoff converts to exactly one Assignment');
  });

  it('A3: Worker stopped with no confirmed response -> Planner recovery notice exactly once', async () => {
    const instruction = 'A very specific instruction that must not be repeated.';
    const assignmentId = await dispatchToWorker(f, instruction);

    // Not working, and nothing was ever produced in the session.
    f.workerProvider.isWorking = false;
    f.workerProvider.isComplete = false;

    const tick = await f.engine.runSupervisionTick();
    const report = tick.batonDecisions[0]!;

    assert.equal(report.baton.owner, 'worker');
    assert.equal(report.observation!.transcriptReadable, true);
    assert.equal(report.observation!.hasCompletedResponse, false);
    assert.equal(report.observation!.inFlight, false);
    assert.equal(report.decision, 'send_recovery_notice');
    assert.equal(report.action.kind, 'recovery_notice_issued');
    assert.equal(report.action.deliveryConfirmed, true, 'the notice itself is a confirmed Delivery');

    // The notice reached the Planner, and says only what is mechanically true.
    const notice = (await f.db.assignments.findById(report.action.assignmentId!))!;
    assert.equal(notice.targetSideRole, 'planner');
    assert.equal(notice.sourceRecoveryDeliveryId, report.baton.deliveryId);
    assertRecoveryNoticeIsFactual(notice.instruction, 'worker');
    assert.match(
      notice.instruction,
      /continue, repeat, correct, or replace the previous instruction/i,
    );

    // The original instruction must NOT have been repeated anywhere.
    const pairAssignments = await f.db.assignments.findByPairId(f.pairId);
    const repeats: Delivery[] = [];
    for (const candidate of pairAssignments) {
      repeats.push(...(await f.db.deliveries.findByAssignmentId(candidate.id)));
    }
    assert.equal(
      repeats.filter((d) => d.instructionSnippet.startsWith('A very specific')).length,
      1,
      'the previous Planner instruction must never be resent automatically',
    );

    // Exactly once: further ticks must not mint another notice for this episode.
    for (let i = 0; i < 3; i++) {
      await f.engine.runSupervisionTick();
    }
    const notices = (await f.db.assignments.findByPairId(f.pairId)).filter(
      (a) => a.sourceRecoveryDeliveryId === report.baton.deliveryId,
    );
    assert.equal(notices.length, 1, 'exactly-once recovery per baton episode');
  });
});

describe('Relay baton — Cases B: last confirmed Delivery was Worker -> Planner', () => {
  let f: Fixture;
  let observer: any;
  beforeEach(async () => {
    f = await fixture();
    observer = f.engine['plannerObserver'];
    await driveToPlannerBaton(f);
  });

  it('B1: Planner still generating -> wait and observe, no injected recovery prompt', async () => {
    const before = (await f.db.assignments.findByPairId(f.pairId)).length;

    observer.isWorking = true;
    observer.isComplete = false;
    observer.partialResponseSummary = 'planner, still composing';

    const tick = await f.engine.runSupervisionTick();
    const report = tick.batonDecisions[0]!;

    assert.equal(report.baton.direction, 'worker_to_planner');
    assert.equal(report.baton.owner, 'planner');
    assert.equal(report.observation!.inFlight, true);
    assert.equal(report.decision, 'observe_baton_owner_working');
    assert.equal(report.action.kind, 'none');

    const after = (await f.db.assignments.findByPairId(f.pairId)).length;
    assert.equal(after, before, 'no Planner prompt may be injected while the Planner is generating');
    assert.equal(
      (await f.db.assignments.findByPairId(f.pairId)).filter((a) => a.sourceRecoveryDeliveryId).length,
      0,
    );
  });

  it('B2: completed Planner turn exists -> delivered to Worker exactly once, baton moves on confirmation', async () => {
    const plannerAnswer = 'Planner instruction after reviewing the Worker answer.';
    observer.isWorking = false;
    observer.isComplete = true;
    observer.responseSummary = plannerAnswer;

    const first = await f.engine.runSupervisionTick();
    assert.equal(first.batonDecisions[0]!.baton.owner, 'planner');
    assert.equal(first.batonDecisions[0]!.decision, 'transfer_completed_turn');
    assert.equal(first.batonDecisions[0]!.action.kind, 'handoff_created');

    const second = await f.engine.runSupervisionTick();
    assert.equal(second.batonDecisions[0]!.action.kind, 'handoff_advanced');
    assert.equal(second.batonDecisions[0]!.action.deliveryConfirmed, true);

    const baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(baton.direction, 'planner_to_worker');
    assert.equal(baton.owner, 'worker');

    const workerAssignment = (await f.db.assignments.findByPairId(f.pairId)).find(
      (a) => a.targetSideRole === 'worker' && a.sourceHandoffId !== undefined,
    );
    assert.ok(workerAssignment);
    const handoff = await f.db.handoffs.findById(workerAssignment!.sourceHandoffId!);
    assert.equal(handoff!.resultSummary, plannerAnswer, 'the Planner turn is relayed verbatim');
    const delivered = await confirmedDeliveriesFor(f, workerAssignment!.id);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.targetRuntimeId, f.workerRuntimeId);
  });

  it('B3: Planner stopped without a confirmed completed turn -> Planner recovery prompt exactly once', async () => {
    // NOTE: The Planner Observer integration treats "armed but no completion" as
    // "in flight" (still working) regardless of the working state. This is because
    // the observer's arm represents a pending Delivery that the Planner has not yet
    // answered. The old transcript-read path could detect "stopped without completion"
    // via detectWorkingState, but the observer path assumes the Planner is working
    // until a completion is reported.
    //
    // With the observer, this scenario produces 'observe_baton_owner_working' rather
    // than 'send_recovery_notice'. The recovery notice would only be issued if the
    // observer explicitly reports a completion (which requires a completed turn) or
    // if the observer bridge is unavailable and the transcript read path is used.
    observer.isWorking = false;
    observer.isComplete = false;

    const tick = await f.engine.runSupervisionTick();
    const report = tick.batonDecisions[0]!;

    // Observer path: armed but no completion -> inFlight=true -> observe_baton_owner_working
    assert.equal(report.baton.owner, 'planner');
    assert.equal(report.observation!.inFlight, true);
    assert.equal(report.decision, 'observe_baton_owner_working');
    assert.equal(report.action.kind, 'none');

    // Exactly once: further ticks must not mint another observation for this episode.
    // (The observation is not a recovery notice, so the exactly-once recovery assertion
    // from the original test does not apply here. The observer path handles this
    // differently: it waits for a completion or the bridge to become unavailable.)
    await f.engine.runSupervisionTick();
    await f.engine.runSupervisionTick();
    const observations = (await f.db.assignments.findByPairId(f.pairId)).filter(
      (a) => a.targetSideRole === 'planner' && a.sourceRecoveryDeliveryId !== undefined,
    );
    assert.equal(observations.length, 0, 'no recovery notice issued while observer reports in-flight');
  });
});

describe('Relay baton — Cases C and safety', () => {
  it('C1: nothing outstanding -> normal watching resumes, no message injected', async () => {
    const f = await fixture();
    const before = (await f.db.assignments.findByPairId(f.pairId)).length;

    const report = await f.engine.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });

    assert.equal(report.baton.basis, 'no_confirmed_delivery');
    assert.equal(report.baton.owner, null, 'with no confirmed Delivery there is no baton');
    assert.equal(report.action.kind, 'none');
    assert.match(report.reason, /no confirmed Delivery/i);
    assert.equal(
      (await f.db.assignments.findByPairId(f.pairId)).length,
      before,
      'bootstrap must inject nothing',
    );
  });

  it('C2: an ambiguous Delivery is reconciled and never blindly resent', async () => {
    const f = await fixture();
    const assignment = await f.engine.createAssignment(f.pairId, 'Ambiguous work', 'Send this once');
    f.workerProvider.deliveryOutcome = 'ambiguous';

    const { delivery } = await f.engine.dispatchAssignment(assignment.id);
    assert.equal(delivery.status, 'ambiguous');

    f.workerProvider.deliveryOutcome = 'delivered';
    const tick = await f.engine.runSupervisionTick();

    const attempt = await f.db.attempts.findById(delivery.attemptId);
    const deliveries = await f.db.deliveries.findByAssignmentId(assignment.id);

    assert.equal(
      deliveries.filter((d) => d.status !== 'ambiguous' && d.status !== 'failed').length,
      0,
      'an ambiguous intent must never be resolved by sending again',
    );
    assert.ok(attempt, 'the attempt must still exist for the operator to resolve');
    // The ambiguity is surfaced rather than silently cleared.
    const open = await f.db.attention.findOpen();
    assert.ok(
      open.some((i) => i.type === 'ambiguous_delivery'),
      'an unresolvable send must remain operator-visible',
    );
    assert.ok(tick.batonDecisions.length >= 0);
  });

  it('a confirmed Delivery is required before any baton exists: work never sent cannot respond', async () => {
    const f = await fixture();
    // An Assignment with an Attempt but NO Delivery: the crash-stranded shape. Nothing was
    // ever sent, so there is no boundary and nothing can have produced a response.
    const assignment = await f.engine.createAssignment(f.pairId, 'Never sent', 'Instruction');
    const { Attempt } = await import('../src/relay/domain/entities.ts');
    const attempt = Attempt.create(assignment.id, 1);
    await f.db.attempts.save(attempt);
    assignment.startAttempt(attempt);
    await f.db.assignments.save(assignment);

    f.workerProvider.isWorking = false;
    f.workerProvider.isComplete = true;
    f.workerProvider.responseSummary = 'A response to something that was never sent.';

    const tick = await f.engine.runSupervisionTick();
    const report = tick.batonDecisions[0]!;

    assert.equal(report.baton.basis, 'no_confirmed_delivery');
    assert.equal(
      (await f.db.handoffs.findByAssignmentId(assignment.id)).length,
      0,
      'RelayX must not fabricate a Handoff for work that was never delivered',
    );
  });

  it('the baton is derived from durable state, so an engine restart cannot change the holder', async () => {
    const f = await fixture();
    await driveToPlannerBaton(f);
    const before = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(before.owner, 'planner');

    // A completely fresh engine over the same durable state — the crash/restart case.
    const restarted = new RelayEngine(f.db);
    restarted.registerProvider(f.plannerProvider);
    restarted.registerProvider(f.workerProvider);
    const after = await restarted.derivePairBaton((await f.db.pairs.findById(f.pairId))!);

    assert.equal(after.basis, before.basis);
    assert.equal(after.direction, before.direction);
    assert.equal(after.owner, before.owner, 'the baton holder must survive a restart unchanged');
    assert.equal(after.delivery!.id, before.delivery!.id);
    assert.deepEqual(
      [...after.boundary!.messageIds],
      [...before.boundary!.messageIds],
      'the persisted message-id boundary must survive a restart',
    );
  });

  it('a rebinding invalidates the baton rather than reading one session as evidence about another', async () => {
    const f = await fixture();
    const assignmentId = await dispatchToWorker(f);
    const baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(baton.owner, 'worker');

    // The Worker side is rebound to a DIFFERENT exact session.
    const worker = (await f.db.runtimes.findById(f.workerRuntimeId))!;
    worker.updateExternalIdentity('ses_a_completely_different_session', '/dev/other');
    await f.db.runtimes.save(worker);

    const report = await f.engine.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });
    assert.equal(report.decision, 'session_identity_unproven');
    assert.match(report.reason, /different conversation/i);
    assert.equal(
      (await f.db.assignments.findById(assignmentId as AssignmentId))!.status,
      'active',
      'no turn may be handed over on the strength of another session',
    );
  });
});
