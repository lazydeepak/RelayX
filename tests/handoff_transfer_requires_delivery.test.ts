/**
 * A HAND-OVER IS NOT A TRANSFER UNTIL ITS DELIVERY IS CONFIRMED.
 * =========================================================================
 *
 * ## The rule under test
 *
 * `hasCompletedTurnBeenTransferred` decides whether a completed Worker turn has already been
 * handed to the Planner. It used to answer "yes" on the derived Assignment's EXISTENCE — the
 * record that the Handoff was converted. That is a record of intent, not of delivery, and
 * conflating them deadlocked the Pair permanently:
 *
 *   Handoff recorded -> converted into the Planner Assignment -> the send FAILS
 *     -> the derived Assignment exists and stays `active` forever
 *     -> every later tick answers "already transferred" and acts on nothing
 *
 * The completed turn sat recorded in a Handoff that no Delivery would ever carry, the Planner
 * never received it, and RelayX reported the episode as correctly finished. Nothing could break
 * it: the baton is derived from confirmed Deliveries, so the failed send could never take the
 * baton, and the "already transferred" answer blocked the very retry that would have delivered it.
 *
 * The invariant restored here:
 *
 *   transferred  <=>  the derived Assignment has a confirmed `delivered` Delivery
 *
 * Assignment existence alone is NOT sufficient. Absent, `failed`, `pending`, `delivering`, and
 * `ambiguous` Deliveries all mean the hand-over is incomplete, and all of them return false.
 *
 * ## What each test is really about
 *
 * The four cases below are the truth table of that predicate, and between them they pin down the
 * two things that must NOT change while fixing it:
 *
 *   1. a real transfer still reads as transferred, and is never handed on twice;
 *   2. a definitively failed send continues the EXISTING Assignment — no duplicate Assignment,
 *      no duplicate Handoff, no recreation of the recorded turn — and reaches the Planner as soon
 *      as the transport works again;
 *   3. an Assignment converted but never dispatched (the crash-between-conversion-and-dispatch
 *      window) is continued, not mistaken for a finished transfer;
 *   4. an `ambiguous` Delivery — an outcome RelayX has NOT established — is still never blind-
 *      resent. Fixing the deadlock must not become a licence to guess.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Assignment } from '../src/relay/domain/entities.ts';
import { MockProvider } from './MockProvider.ts';
import type { AssignmentId, PairId, RuntimeSessionId } from '../src/relay/domain/types.ts';
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

/** A bound, ACTIVE, RUNNING Pair whose two sides carry real provider session identities. */
async function fixture(): Promise<Fixture> {
  const db = new SqliteRelayDatabase(':memory:');
  const engine = new RelayEngine(db);
  const plannerProvider = new MockProvider('chatgpt');
  const workerProvider = new MockProvider('opencode');
  engine.registerProvider(plannerProvider);
  engine.registerProvider(workerProvider);

  const project = await engine.createProject('Transfer Project');
  const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
  const worker = await engine.registerRuntimeSession('opencode', 'Worker');
  const pair = await engine.createPair(project.id, 'Transfer Pair', planner.id, worker.id);
  planner.updateExternalIdentity('ses_transfer_planner', '/dev/transfer_planner');
  worker.updateExternalIdentity('ses_transfer_worker', '/dev/transfer_worker');
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

/**
 * The Worker's answer text, used as a marker in the Planner's transcript.
 *
 * A distinct constant because several scenarios let the Planner hold the baton without answering
 * it, and RelayX then legitimately sends a continuity notice. Counting raw user turns would fold
 * that different message into the duplicate count; counting this text does not.
 */
const WORKER_ANSWER = 'THE-WORKER-COMPLETED-ANSWER';

/**
 * The instruction the crash-window Assignment in scenario 3 is created with.
 *
 * In production this text is the Handoff's `resultSummary` (the Worker's turn, verbatim). The
 * scenario builds the Assignment by hand to reproduce the crash window, so it carries its own
 * marker instead — which is what makes the "delivered exactly once" assertion below meaningful.
 */
const CRASH_WINDOW_INSTRUCTION = 'CRASH-WINDOW-HANDOFF-BODY';

/** Dispatch to the Worker; that confirmed Delivery is what gives the Worker the baton. */
async function dispatchToWorker(f: Fixture): Promise<AssignmentId> {
  const assignment = await f.engine.createAssignment(f.pairId, 'Work', 'Do the work');
  const { delivery } = await f.engine.dispatchAssignment(assignment.id);
  assert.equal(delivery.status, 'delivered', 'the dispatch must be confirmed for a baton to exist');
  return assignment.id;
}

/** The Worker completes a turn, so the next tick has a completed turn to hand on. */
function workerCompletes(f: Fixture, answer = 'The full Worker answer.'): void {
  f.workerProvider.isWorking = false;
  f.workerProvider.isComplete = true;
  f.workerProvider.responseSummary = answer;
}

/**
 * Run ticks until the Planner holds the baton, or give up and report how far it got.
 *
 * `beforeEachTick` runs before each tick and lets a test make a retry eligible without knowing the
 * backoff schedule.
 */
async function tickUntilPlannerHoldsTheBaton(
  f: Fixture,
  maxTicks = 8,
  beforeEachTick?: () => void,
): Promise<{ ticks: number; owner: string | null }> {
  for (let i = 0; i < maxTicks; i++) {
    beforeEachTick?.();
    await f.engine.runSupervisionTick();
    const baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    if (baton.owner === 'planner') return { ticks: i + 1, owner: baton.owner };
  }
  const baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
  return { ticks: maxTicks, owner: baton.owner };
}

const allDeliveriesFor = (f: Fixture, assignmentId: string): Promise<Delivery[]> =>
  f.db.deliveries.findByAssignmentId(assignmentId as any);

const deliveriesWithStatus = (deliveries: readonly Delivery[], status: Delivery['status']): Delivery[] =>
  deliveries.filter((d) => d.status === status);

/** The opposite-side Assignment converted from a Handoff — there must never be more than one. */
async function derivedAssignments(f: Fixture, handoffId: string) {
  return (await f.db.assignments.findByPairId(f.pairId)).filter((a) => a.sourceHandoffId === handoffId);
}

/** How many user turns this provider session shows. */
function userTurns(provider: MockProvider): number {
  return provider.messages.filter((m) => m.role === 'user').length;
}

/**
 * Make this Assignment's newest Delivery look old enough that any backoff has elapsed.
 *
 * The retry DELAY is proved in `handoff_retry_schedule.test.ts`. These tests are about the deadlock
 * and the uniqueness invariants, so they need the retry to be ELIGIBLE without asserting when it
 * became so — aging the persisted timestamp is the same thing a real 30 minutes would do, and it
 * keeps the two files from having to agree on a backoff value.
 */
function makeRetryEligible(f: Fixture, assignmentId: AssignmentId): void {
  const newest = f.db.db
    .prepare('SELECT id, created_at FROM deliveries WHERE assignment_id=? ORDER BY created_at DESC LIMIT 1')
    .get(assignmentId) as { id: string; created_at: number } | undefined;
  assert.ok(newest, 'the Assignment must have a Delivery to age');
  f.db.db
    .prepare('UPDATE deliveries SET created_at=? WHERE id=?')
    .run(Date.now() - 60 * 60_000, newest.id);
}

/**
 * How many user turns carry this exact text.
 *
 * Distinct from {@link userTurns} wherever a session may legitimately receive a second, DIFFERENT
 * message: a continuity notice about a later baton episode is a different message, and counting it
 * as another copy of the handed-over turn would hide a real duplicate behind an unrelated one.
 */
function userTurnsWithText(provider: MockProvider, text: string): number {
  return provider.messages.filter((m) => m.role === 'user' && m.text?.includes(text)).length;
}

describe('A completed turn counts as transferred only on a confirmed delivered Delivery', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  /* ---- Case 1: delivered => transferred ----------------------------------------- */

  it('1: derived Assignment + delivered Delivery => transferred=true, and never handed on twice', async () => {
    const workerAssignmentId = await dispatchToWorker(f);
    workerCompletes(f, WORKER_ANSWER);

    // Tick 1 records the completed turn as a Handoff. Tick 2 converts it and delivers it.
    const recorded = await f.engine.runSupervisionTick();
    assert.equal(recorded.batonDecisions[0]!.decision, 'transfer_completed_turn');
    assert.equal(recorded.batonDecisions[0]!.action.kind, 'handoff_created');

    const handOver = await f.engine.runSupervisionTick();
    assert.equal(handOver.batonDecisions[0]!.action.kind, 'handoff_advanced');
    assert.equal(
      handOver.batonDecisions[0]!.action.deliveryConfirmed,
      true,
      'the hand-over Delivery is confirmed, so this IS a transfer',
    );

    const handoffId = handOver.batonDecisions[0]!.action.handoffId!;
    const [derived] = await derivedAssignments(f, handoffId);
    assert.ok(derived, 'the Handoff became one opposite-side Assignment');
    assert.equal(deliveriesWithStatus(await allDeliveriesFor(f, derived.id), 'delivered').length, 1);

    const baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(baton.owner, 'planner', 'the baton moved on the confirmed Delivery');

    // Now that it IS transferred, further ticks must do nothing at all. This is the property the
    // broken version got right for the wrong reason, and it must survive the fix.
    for (let i = 0; i < 3; i++) {
      const tick = await f.engine.runSupervisionTick();
      assert.notEqual(
        tick.batonDecisions[0]!.action.kind,
        'handoff_advanced',
        'a confirmed hand-over is never repeated',
      );
    }
    assert.equal((await derivedAssignments(f, handoffId)).length, 1, 'still exactly one derived Assignment');
    assert.equal((await f.db.handoffs.findByAssignmentId(workerAssignmentId)).length, 1, 'no duplicate Handoff');
    assert.equal(
      userTurnsWithText(f.plannerProvider, WORKER_ANSWER),
      1,
      "the Planner received the Worker's turn exactly once",
    );
    assert.equal(
      (await f.db.assignments.findByPairId(f.pairId)).filter((a) => a.sourceHandoffId === handoffId).length,
      1,
      'and no second hand-on was created for the same Handoff',
    );
  });

  /* ---- Case 2: failed => not transferred, and the existing Assignment continues ---- */

  it('2: derived Assignment + failed Delivery => transferred=false, and the existing Assignment is retried', async () => {
    const workerAssignmentId = await dispatchToWorker(f);
    workerCompletes(f, 'ANSWER-CARRIED-BY-THE-HANDOFF');

    await f.engine.runSupervisionTick(); // Handoff recorded
    // NOTE: the retry is subject to the backoff ladder covered in handoff_retry_schedule.test.ts.
    // These tests assert the DEADLOCK is gone and the invariants hold, so they age the persisted
    // timestamp forward rather than asserting a particular delay.

    // The hand-over send is conclusively refused. `failed` is a definitive statement that the
    // instruction did NOT reach the conversation, so it is safe — and necessary — to retry.
    f.plannerProvider.deliveryOutcome = 'failed';
    f.plannerProvider.deliveryFailureReason = 'planner composer unavailable';
    const failed = await f.engine.runSupervisionTick();

    const handoffId = failed.batonDecisions[0]!.action.handoffId!;
    assert.equal(failed.batonDecisions[0]!.action.kind, 'handoff_advanced');
    assert.equal(
      failed.batonDecisions[0]!.action.deliveryConfirmed,
      false,
      'a failed Delivery is not a transfer',
    );

    const [derived] = await derivedAssignments(f, handoffId);
    assert.ok(derived, 'the derived Assignment exists — and that alone must not read as transferred');
    assert.equal(
      deliveriesWithStatus(await allDeliveriesFor(f, derived.id), 'failed').length,
      1,
      'the failed Delivery is on the record',
    );
    assert.equal(
      deliveriesWithStatus(await allDeliveriesFor(f, derived.id), 'delivered').length,
      0,
      'and nothing has been handed over',
    );

    // The whole point: the next tick must NOT answer "already transferred" and stop.
    const stuck = await f.engine.runSupervisionTick();
    assert.notEqual(
      stuck.batonDecisions[0]!.decision,
      'completed_turn_already_transferred',
      'a failed Delivery must never be reported as a completed transfer',
    );

    // Transport recovers. The retry must now land on the SAME Assignment. The failed Delivery is
    // aged so the retry is eligible; asserting WHEN it became eligible is the other file's job.
    f.plannerProvider.deliveryOutcome = 'delivered';
    f.plannerProvider.deliveryFailureReason = undefined;
    const { owner } = await tickUntilPlannerHoldsTheBaton(f, 8, () => makeRetryEligible(f, derived!.id));

    assert.equal(owner, 'planner', 'the baton eventually moves once a Delivery is confirmed');
    assert.equal(
      (await derivedAssignments(f, handoffId)).length,
      1,
      'the existing Assignment is reused — no duplicate Assignment for one Handoff',
    );
    assert.equal(
      (await f.db.handoffs.findByAssignmentId(workerAssignmentId)).length,
      1,
      'the Handoff is reused — it is never recreated',
    );

    const [retried] = await derivedAssignments(f, handoffId);
    const deliveries = await allDeliveriesFor(f, retried.id);
    assert.ok(deliveries.length > 1, 'the retry is a new Delivery, not a rewritten one');
    assert.ok(
      deliveriesWithStatus(deliveries, 'failed').length >= 1,
      'every failed intent is retained on the record',
    );
    assert.equal(
      deliveriesWithStatus(deliveries, 'delivered').length,
      1,
      'exactly one Delivery ever carried the turn to the Planner',
    );

    // Auditable: the failed attempts and the successful retry are separate Attempts on one
    // Assignment, so an operator can see each of them without any being erased.
    const attempts = await f.db.attempts.findByAssignmentId(retried.id);
    assert.equal(attempts.length, deliveries.length, 'one Attempt per Delivery, none overwritten');
    assert.equal(
      new Set(attempts.map((a) => a.attemptNumber)).size,
      attempts.length,
      'attempt numbers are distinct, so each retry is individually addressable',
    );

    // And nothing was duplicated into the receiving conversation.
    assert.equal(
      userTurns(f.plannerProvider),
      1,
      'the Planner conversation carries the turn exactly once despite the failed attempts',
    );
    assert.equal(userTurns(f.workerProvider), 1, 'the Worker session is not written to again');
  });

  /* ---- Case 3: no Delivery at all => not transferred ----------------------------- */

  it('3: derived Assignment + NO Delivery => transferred=false, and the pending Assignment is dispatched', async () => {
    const workerAssignmentId = await dispatchToWorker(f);
    workerCompletes(f, WORKER_ANSWER);

    await f.engine.runSupervisionTick(); // Handoff recorded
    const handoff = (await f.db.handoffs.findByAssignmentId(workerAssignmentId))[0]!;

    // The crash-between-conversion-and-dispatch window, reproduced exactly: the Handoff has been
    // converted into the opposite-side Assignment and the process died before `dispatchAssignment`
    // ran, so the Assignment exists and has NO Delivery at all.
    const pair = (await f.db.pairs.findById(f.pairId))!;
    const derived = Assignment.create(
      f.pairId,
      pair.projectId,
      'derived',
      CRASH_WINDOW_INSTRUCTION,
      'normal',
      'planner',
      handoff.id,
    );
    await f.db.assignments.save(derived);
    const source = (await f.db.assignments.findById(workerAssignmentId))!;
    source.complete();
    await f.db.assignments.save(source);
    handoff.completeHandoff();
    await f.db.handoffs.save(handoff);
    pair.clearWork();
    await f.db.pairs.save(pair);

    assert.equal((await allDeliveriesFor(f, derived.id)).length, 0, 'nothing was ever sent');

    // The verdict under test, asserted directly. An Assignment with no Delivery is not a
    // completed transfer, so the decision must NOT be `completed_turn_already_transferred` —
    // that value is the deadlock: it tells the caller to do nothing about work still undelivered.
    //
    // It is asserted before anything else because the continuation itself may be rescued by
    // another step in the same tick (an undispatched Assignment is `pending`, and orchestration
    // dispatches pending work regardless). The predicate is what must be correct on its own.
    const firstTick = await f.engine.runSupervisionTick();
    assert.notEqual(
      firstTick.batonDecisions[0]!.decision,
      'completed_turn_already_transferred',
      'a derived Assignment with no Delivery must not read as a completed transfer',
    );

    const { owner } = await tickUntilPlannerHoldsTheBaton(f);

    assert.equal(owner, 'planner', 'an undelivered Assignment is continued, not abandoned');
    assert.equal(
      (await derivedAssignments(f, handoff.id)).length,
      1,
      'the existing Assignment is continued; no second one is created for it',
    );
    assert.equal(
      (await f.db.handoffs.findByAssignmentId(workerAssignmentId)).length,
      1,
      'the Handoff is reused, never recreated',
    );
    assert.equal(
      deliveriesWithStatus(await allDeliveriesFor(f, derived.id), 'delivered').length,
      1,
      'exactly one confirmed Delivery is produced by the continuation',
    );
    assert.equal(
      userTurnsWithText(f.plannerProvider, CRASH_WINDOW_INSTRUCTION),
      1,
      'the Planner receives the turn exactly once',
    );
    assert.equal(userTurns(f.workerProvider), 1, 'the Worker is not written to again');
  });

  /* ---- Case 4: ambiguous => not transferred, and never blind-resent --------------- */

  it('4: an ambiguous Delivery stays protected — no blind resend, no duplicate Assignment', async () => {
    const workerAssignmentId = await dispatchToWorker(f);
    workerCompletes(f);

    await f.engine.runSupervisionTick(); // Handoff recorded

    // The send was attempted and RelayX could not establish whether it landed. This is the one
    // outcome that is NOT retryable: a second send could duplicate real work inside a
    // conversation, and the design forbids making progress by guessing.
    f.plannerProvider.deliveryOutcome = 'ambiguous';
    const ambiguous = await f.engine.runSupervisionTick();

    const handoffId = ambiguous.batonDecisions[0]!.action.handoffId!;
    const [derived] = await derivedAssignments(f, handoffId);
    assert.ok(derived);
    assert.deepEqual(
      (await allDeliveriesFor(f, derived.id)).map((d) => d.status),
      ['ambiguous'],
      'the ambiguous intent stands',
    );
    assert.equal(userTurns(f.plannerProvider), 0, 'nothing is known to have landed');

    // Repeated ticks must not resolve the ambiguity by sending again.
    for (let i = 0; i < 4; i++) {
      await f.engine.runSupervisionTick();
    }

    const deliveries = await allDeliveriesFor(f, derived.id);
    assert.equal(
      deliveries.filter((d) => d.status !== 'ambiguous').length,
      0,
      'no Delivery was created to force progress past an uncertain outcome',
    );
    assert.equal(
      deliveries.length,
      1,
      'the ambiguous Delivery is never resolved by a second send',
    );
    assert.equal(
      (await f.db.attempts.findByAssignmentId(derived.id)).length,
      1,
      'no duplicate Attempt is minted for an uncertain send',
    );
    assert.equal((await derivedAssignments(f, handoffId)).length, 1, 'still one Assignment, not a second one');
    assert.equal(
      (await f.db.handoffs.findByAssignmentId(workerAssignmentId)).length,
      1,
      'the Handoff is not recreated either',
    );

    // It stays operator-visible rather than silently dropped, which is what "uncertain" requires.
    const open = await f.db.attention.findOpen();
    assert.ok(
      open.some((i) => i.type === 'ambiguous_delivery'),
      'an unestablished outcome must remain operator-visible',
    );

    // And the baton has not moved on an outcome RelayX never confirmed.
    const baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(baton.owner, 'worker', 'an unconfirmed send never takes the baton');
  });
});

describe('The transferred verdict is derived from Delivery status, not Assignment existence', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  it('a terminal baton Assignment with no derived Assignment is still reported as transferred', async () => {
    // The other half of the predicate, unchanged. A terminal baton Assignment whose Handoff was
    // never converted has nothing in flight to continue, so the episode is closed — and reporting
    // otherwise would reopen it and duplicate the turn.
    const workerAssignmentId = await dispatchToWorker(f);
    workerCompletes(f);
    await f.engine.runSupervisionTick();

    const handoffs = await f.db.handoffs.findByAssignmentId(workerAssignmentId);
    assert.equal(handoffs.length, 1, 'the turn was recorded');
    assert.equal(
      (await f.db.assignments.findByPairId(f.pairId)).filter((a) => a.sourceHandoffId !== undefined).length,
      0,
      'but it was never converted into an opposite-side Assignment',
    );

    const workerAssignment = (await f.db.assignments.findById(workerAssignmentId))!;
    workerAssignment.complete();
    await f.db.assignments.save(workerAssignment);

    const tick = await f.engine.runSupervisionTick();
    assert.equal(
      tick.batonDecisions[0]!.decision,
      'completed_turn_already_transferred',
      'a closed episode with nothing to deliver is not reopened',
    );
    assert.equal(
      (await f.db.assignments.findByPairId(f.pairId)).filter((a) => a.sourceHandoffId !== undefined).length,
      0,
      'reopening would have created an Assignment for an already-closed episode',
    );
  });

  it('the failed intent and its reason survive the retry, and reconciliation evidence is not weakened', async () => {
    const workerAssignmentId = await dispatchToWorker(f);
    workerCompletes(f);
    await f.engine.runSupervisionTick();

    f.plannerProvider.deliveryOutcome = 'failed';
    f.plannerProvider.deliveryFailureReason = 'planner composer unavailable';
    const failed = await f.engine.runSupervisionTick();
    const handoffId = failed.batonDecisions[0]!.action.handoffId!;
    const [derived] = await derivedAssignments(f, handoffId);

    const [firstAttempt] = deliveriesWithStatus(await allDeliveriesFor(f, derived.id), 'failed');
    assert.match(firstAttempt!.failureReason ?? '', /planner composer unavailable/);

    // Reconciliation evidence must not be weakened by the retry: the failed Delivery keeps its own
    // evidence row and reason, and the retry is a separate record beside it.
    f.plannerProvider.deliveryOutcome = 'delivered';
    await tickUntilPlannerHoldsTheBaton(f, 8, () => makeRetryEligible(f, derived!.id));

    const deliveries = await allDeliveriesFor(f, derived.id);
    const failedAgain = deliveriesWithStatus(deliveries, 'failed');
    assert.ok(failedAgain.length >= 1, 'the failed intent is still there');
    for (const d of failedAgain) {
      assert.match(d.failureReason ?? '', /planner composer unavailable/, 'its reason is intact');
      assert.ok(d.evidence, 'each failed Delivery keeps its own evidence');
    }
    const delivered = deliveriesWithStatus(deliveries, 'delivered');
    assert.equal(delivered.length, 1);
    assert.ok(delivered[0]!.evidence, 'the successful retry carries its own confirmation evidence');
    assert.ok(delivered[0]!.deliveredAt, 'and is a genuinely confirmed Delivery, not a re-labelled one');
  });
});
