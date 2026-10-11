/**
 * RELAY TRANSPORT DETERMINISM ACROSS STOP / START.
 * =========================================================================
 *
 * The chain this file proves, end to end and in order:
 *
 *   Project -> Session Pair -> Planner/Worker Sessions -> Assignment -> Attempt
 *   -> Transport/Delivery -> recipient ownership (baton) -> consumed watermark
 *   -> next Assignment/Attempt -> continuous relay loop
 *
 * ## What is being claimed
 *
 * A restart is not a new relay cycle. It is a change of process around an
 * UNCHANGED durable relay chain. Every assertion below is about that single
 * claim: whatever the baton said before the process stopped, it says the same
 * thing afterwards, from persisted records alone, and the relay continues with
 * exactly one next Assignment/Attempt.
 *
 * ## Why these tests construct a REAL restart
 *
 * A restart here is a genuine SQLite `close()` followed by a fresh
 * `SqliteRelayDatabase` + `RelayEngine` over the same file. It is not a second
 * engine sharing one in-memory handle, because that would prove only that the
 * objects are still in memory. Every in-memory field the relay relies on
 * (orchestration re-entrancy sets, the supervision timer, the provider registry,
 * the running tick flag) is gone, exactly as it is after a real quit.
 *
 * The provider transcripts are carried across explicitly. That is a property of
 * the MOCK, not of the system: the conversation lives in the provider's
 * application, so a restarted RelayX finds the same transcript. A mock that
 * started empty would make the baton correctly find nothing after the boundary,
 * which would prove nothing.
 *
 * ## What each test pins
 *
 *   1. the full requested chain across a stop/start, with exactly-once counting
 *   2. the baton holder is byte-identical before and after the restart
 *   3. an inert baton owner yields ONE recovery notice, not a new cycle per tick
 *   4. a crash inside the provider send is never resent and never re-attempted
 *   5. a crash between handoff conversion and dispatch is continued exactly once
 *   6. pause stops all provider contact; resume continues the SAME chain
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Assignment } from '../src/relay/domain/entities.ts';
import { MockProvider } from './MockProvider.ts';
import type { PairId } from '../src/relay/domain/types.ts';
import type { ReconciliationMessage } from '../src/relay/providers/exactSessionReconciliation.ts';

interface Fixture {
  dir: string;
  dbPath: string;
  db: SqliteRelayDatabase;
  engine: RelayEngine;
  plannerProvider: MockProvider;
  workerProvider: MockProvider;
  pairId: PairId;
}

/** A file-backed database path, so `close()` + reopen is a real process restart. */
function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relayx-resume-'));
  return path.join(dir, 'relay.sqlite');
}

/**
 * Open the durable database and wire a fresh process around it.
 *
 * `carry` is the provider-side conversation as it stood when the previous
 * process was running. Omitting it means "this session has no history", which is
 * only true for a genuinely new session.
 */
function openProcess(
  dbPath: string,
  carry?: { planner: ReconciliationMessage[]; worker: ReconciliationMessage[] },
): { db: SqliteRelayDatabase; engine: RelayEngine; plannerProvider: MockProvider; workerProvider: MockProvider } {
  const db = new SqliteRelayDatabase(dbPath);
  const engine = new RelayEngine(db);
  const plannerProvider = new MockProvider('chatgpt');
  const workerProvider = new MockProvider('opencode');
  plannerProvider.adoptTranscript(carry?.planner ?? []);
  workerProvider.adoptTranscript(carry?.worker ?? []);
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

  return { db, engine, plannerProvider, workerProvider };
}

/** Project + two bound runtime sessions + one ACTIVE/RUNNING Session Pair. */
async function bootstrapPair(f: { db: SqliteRelayDatabase; engine: RelayEngine }): Promise<PairId> {
  const project = await f.engine.createProject('Resume Project');
  const planner = await f.engine.registerRuntimeSession('chatgpt', 'Planner');
  const worker = await f.engine.registerRuntimeSession('opencode', 'Worker');
  const pair = await f.engine.createPair(project.id, 'Resume Pair', planner.id, worker.id);

  // Both sides need a provider-owned identity: the baton addresses ONE exact
  // session on the side it inspects, so without these every assertion is vacuous.
  planner.updateExternalIdentity('ses_planner', '/dev/resume/planner');
  worker.updateExternalIdentity('ses_worker', '/dev/resume/worker');
  await f.db.runtimes.save(planner);
  await f.db.runtimes.save(worker);

  assert.equal((await f.engine.loadAndActivate(pair.id)).outcome, 'activated');
  await f.engine.startPair(pair.id);
  // Remove the planner observer after Start Pair so baton evaluation uses the
  // transcript read path (which these tests were written for) rather than the
  // observer path which assumes "armed but no completion = in flight".
  f.engine['plannerObserver'] = null;
  return pair.id;
}

/** A fixture with the Pair already created and running. */
async function fixture(): Promise<Fixture> {
  const dbPath = tempDbPath();
  const process = openProcess(dbPath);
  const pairId = await bootstrapPair(process);
  return { dir: path.dirname(dbPath), dbPath, ...process, pairId };
}

/** Tear the process down the way `will-quit` does: stop the loop, close the file. */
function haltProcess(f: Fixture): void {
  f.engine.stopSupervisionLoop();
  f.db.db.close();
}

/** Re-open the SAME durable state in a new process. */
function resumeProcess(f: Fixture): Fixture {
  const resumed = {
    ...f,
    ...openProcess(f.dbPath, {
      planner: f.plannerProvider.messages,
      worker: f.workerProvider.messages,
    }),
  };
  // The resumed process doesn't need the planner observer (no Start Pair called).
  // Remove it so baton evaluation uses the transcript read path.
  resumed.engine['plannerObserver'] = null;
  return resumed;
}

/** Confirmed deliveries recorded for one Assignment, oldest first. */
async function confirmedDeliveries(f: Fixture, assignmentId: string) {
  return (await f.db.deliveries.findByAssignmentId(assignmentId as any)).filter(
    (d) => d.status === 'delivered',
  );
}

/** How many confirmed Deliveries exist across the whole Pair chain. */
async function confirmedDeliveryCount(f: Fixture): Promise<number> {
  const assignments = await f.db.assignments.findByPairId(f.pairId);
  let total = 0;
  for (const assignment of assignments) {
    total += (await confirmedDeliveries(f, assignment.id)).length;
  }
  return total;
}

/** How many user turns the provider session actually shows — the transport's own view. */
function userTurns(provider: MockProvider): number {
  return provider.messages.filter((m) => m.role === 'user').length;
}

/**
 * How many user turns carry this exact text.
 *
 * Distinct from {@link userTurns} wherever a session may legitimately receive a second, different
 * message: a continuity notice about a later baton episode is a different message, and counting it
 * as another copy of the Worker's turn would hide a real duplicate behind an unrelated one.
 */
function userTurnsWithText(provider: MockProvider, text: string): number {
  return provider.messages.filter((m) => m.role === 'user' && m.text?.includes(text)).length;
}

/** Every Attempt minted for one Assignment. */
async function attemptsFor(f: Fixture, assignmentId: string) {
  return f.db.attempts.findByAssignmentId(assignmentId as any);
}

describe('Relay transport determinism across a process stop/start', () => {
  it('continues the SAME chain with exactly one next Assignment/Attempt and no duplicate Delivery', async () => {
    const f = await fixture();

    // ---- 1. P1 assignment -> worker, delivery CONFIRMED -------------------------
    const p1 = await f.engine.createAssignment(f.pairId, 'P1', 'Planner instruction #1');
    const first = await f.engine.dispatchAssignment(p1.id);
    assert.equal(first.delivery.status, 'delivered', 'a confirmed Delivery is what gives the Worker the baton');
    assert.equal((await attemptsFor(f, p1.id)).length, 1);

    let baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(baton.owner, 'worker', 'the recipient of the last confirmed Delivery holds the baton');
    assert.equal(baton.direction, 'planner_to_worker');

    // ---- 2. Worker result consumed ----------------------------------------------
    f.workerProvider.isWorking = false;
    f.workerProvider.isComplete = true;
    f.workerProvider.responseSummary = 'WORKER RESULT';

    const consumeTick = await f.engine.runSupervisionTick();
    assert.equal(consumeTick.batonDecisions[0]!.decision, 'transfer_completed_turn');
    assert.equal(consumeTick.batonDecisions[0]!.action.kind, 'handoff_created');

    // ---- 3. Planner-return Delivery CONFIRMED -----------------------------------
    const returnTick = await f.engine.runSupervisionTick();
    assert.equal(returnTick.batonDecisions[0]!.action.kind, 'handoff_advanced');
    assert.equal(returnTick.batonDecisions[0]!.action.deliveryConfirmed, true);

    const plannerAssignmentId = returnTick.batonDecisions[0]!.action.assignmentId!;
    const plannerAssignment = (await f.db.assignments.findById(plannerAssignmentId as any))!;
    assert.equal(plannerAssignment.targetSideRole, 'planner', 'the baton must return to the Planner');

    baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(baton.owner, 'planner');
    assert.equal(baton.direction, 'worker_to_planner');
    // The baton advanced by exactly one link: the Delivery that carried the turn across.
    assert.notEqual(
      baton.delivery!.id,
      returnTick.batonDecisions[0]!.baton.deliveryId,
      'the return Delivery, not the Delivery it replaced, now holds the baton',
    );
    assert.equal(baton.assignment!.id, plannerAssignmentId);

    // ---- 4. The Planner produced its next turn (all work happens BEFORE the stop) --
    //
    // Recorded as a real message in the session rather than as a provider flag. A completed
    // turn is durable in the provider's own conversation; a "currently composing" UI flag is
    // not, and a restarted process has to re-derive that. Modelling it as a flag would let
    // this test pass or fail on mock bookkeeping instead of on the relay.
    f.plannerProvider.isWorking = false;
    f.plannerProvider.isComplete = false;
    f.plannerProvider.appendAssistantTurn('PLANNER RESULT', { finish: 'stop' });

    const before = {
      batonDeliveryId: baton.delivery!.id,
      batonDirection: baton.direction,
      batonOwner: baton.owner,
      boundaryMessageIds: [...baton.boundary!.messageIds],
      assignments: (await f.db.assignments.findByPairId(f.pairId)).map((a) => a.id).sort(),
      confirmedDeliveries: await confirmedDeliveryCount(f),
      plannerUserTurns: userTurns(f.plannerProvider),
      workerUserTurns: userTurns(f.workerProvider),
      pairOperational: (await f.db.pairs.findById(f.pairId))!.operationalState,
      pairRelay: (await f.db.pairs.findById(f.pairId))!.relayState,
    };

    // ---- 5. PROCESS STOPS --------------------------------------------------------
    haltProcess(f);

    // ---- 6. PROCESS STARTS AGAIN -------------------------------------------------
    const restarted = resumeProcess(f);

    // The Session Pair and its continuity chain are reloaded from the same file.
    const reloadedPair = (await restarted.db.pairs.findById(restarted.pairId))!;
    assert.equal(reloadedPair.id, f.pairId, 'the same Session Pair is reloaded');
    assert.equal(reloadedPair.operationalState, before.pairOperational);
    assert.equal(reloadedPair.relayState, before.pairRelay);
    assert.deepEqual(
      (await restarted.db.assignments.findByPairId(restarted.pairId)).map((a) => a.id).sort(),
      before.assignments,
      'no Assignment is invented or lost by the restart',
    );

    // ---- 7. NO DUPLICATE DELIVERY OCCURS ----------------------------------------
    assert.equal(
      await confirmedDeliveryCount(restarted),
      before.confirmedDeliveries,
      'restart must not re-send anything that was already confirmed',
    );

    // ---- 8. BATON OWNER RECONSTRUCTED CORRECTLY ---------------------------------
    const reloadedBaton = await restarted.engine.derivePairBaton(reloadedPair);
    assert.equal(reloadedBaton.basis, 'confirmed_delivery');
    assert.equal(reloadedBaton.delivery!.id, before.batonDeliveryId, 'the same Delivery still holds the baton');
    assert.equal(reloadedBaton.direction, before.batonDirection);
    assert.equal(reloadedBaton.owner, before.batonOwner, 'the baton holder survives the restart unchanged');
    assert.deepEqual(
      [...reloadedBaton.boundary!.messageIds],
      before.boundaryMessageIds,
      'the persisted message-id boundary survives the restart',
    );

    // ---- 9. RELAY CONTINUES WITH EXACTLY ONE NEXT ASSIGNMENT/ATTEMPT ------------
    //
    // `recoverOnStartup` reconciles and observes; it deliberately does not convert
    // the recovered Handoff, so the conversion happens on the first supervision tick.
    // That boundary is asserted, not assumed.
    const recovery = await restarted.engine.recoverOnStartup();
    assert.equal(recovery.batonDecisions.length, 1);
    assert.equal(recovery.batonDecisions[0]!.baton.owner, 'planner', 'the baton owner is reconstructed, not re-decided');
    assert.equal(recovery.batonDecisions[0]!.baton.deliveryId, before.batonDeliveryId);
    assert.equal(recovery.batonDecisions[0]!.decision, 'transfer_completed_turn');
    assert.equal(recovery.batonDecisions[0]!.action.kind, 'handoff_created');
    assert.equal(
      (await restarted.db.assignments.findByPairId(restarted.pairId)).length,
      before.assignments.length,
      'startup observes; it does not originate the next Assignment',
    );

    const resumeTick = await restarted.engine.runSupervisionTick();
    assert.equal(resumeTick.batonDecisions[0]!.action.kind, 'handoff_advanced');
    assert.equal(resumeTick.batonDecisions[0]!.action.deliveryConfirmed, true);

    // Exactly ONE new Assignment, with exactly ONE Attempt and ONE confirmed Delivery.
    const allAfter = await restarted.db.assignments.findByPairId(restarted.pairId);
    const created = allAfter.filter((a) => !before.assignments.includes(a.id));
    assert.equal(created.length, 1, 'continuation creates exactly one Assignment, not a new cycle');

    const next = created[0]!;
    assert.equal(next.targetSideRole, 'worker', 'the baton is with the Planner, so the next work is for the Worker');
    assert.equal(next.status, 'active');
    assert.ok(next.sourceHandoffId, 'it is the conversion of the recovered Handoff, not a fresh task');

    const attempts = await attemptsFor(restarted, next.id);
    assert.equal(attempts.length, 1, 'exactly one Attempt — never a duplicate');
    assert.equal((await confirmedDeliveries(restarted, next.id)).length, 1, 'exactly one confirmed Delivery');

    // The worker's completed turn reached the Worker verbatim, exactly once.
    const handoff = await restarted.db.handoffs.findById(next.sourceHandoffId!);
    assert.equal(handoff!.resultSummary, 'PLANNER RESULT');

    // The transport's own view agrees: one new Worker turn, no new Planner turn.
    assert.equal(userTurns(restarted.plannerProvider), before.plannerUserTurns, 'the Planner is not written to again');
    assert.equal(userTurns(restarted.workerProvider), before.workerUserTurns + 1, 'exactly one new Worker turn');

    // The baton has moved on — by exactly one link.
    const finalBaton = await restarted.engine.derivePairBaton(
      (await restarted.db.pairs.findById(restarted.pairId))!,
    );
    assert.equal(finalBaton.owner, 'worker');
    assert.equal(finalBaton.direction, 'planner_to_worker');
    assert.equal(finalBaton.confirmedDeliveryCount, before.confirmedDeliveries + 1);
  });

  it('reconstructs the baton owner from durable records alone, with no process state carried over', async () => {
    const f = await fixture();
    const p1 = await f.engine.createAssignment(f.pairId, 'P1', 'Instruction');
    await f.engine.dispatchAssignment(p1.id);
    f.workerProvider.isWorking = false;
    f.workerProvider.isComplete = true;
    f.workerProvider.responseSummary = 'WORKER RESULT';
    await f.engine.runSupervisionTick();
    await f.engine.runSupervisionTick();

    const before = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(before.owner, 'planner');

    haltProcess(f);
    const restarted = resumeProcess(f);
    const after = await restarted.engine.derivePairBaton((await restarted.db.pairs.findById(f.pairId))!);

    assert.equal(after.basis, before.basis);
    assert.equal(after.direction, before.direction);
    assert.equal(after.owner, before.owner);
    assert.equal(after.delivery!.id, before.delivery!.id);
    assert.equal(after.assignment!.id, before.assignment!.id);
    assert.equal(after.attempt!.id, before.attempt!.id);
    assert.deepEqual([...after.boundary!.messageIds], [...before.boundary!.messageIds]);

    // The chain is read back link by link, oldest first, with direction intact.
    assert.deepEqual(
      after.chain.map((link) => `${link.assignment.targetSideRole}:${link.delivery.status}`),
      ['worker:delivered', 'planner:delivered'],
    );
  });

  it('sends exactly ONE recovery notice for an inert owner across a restart, not a new relay cycle per tick', async () => {
    // The regression: the resume notice is itself a confirmed Delivery, so it becomes
    // the new baton. Treating that as a fresh baton episode re-opened recovery each
    // tick and minted another Assignment + Attempt + Delivery — an unbounded stream of
    // duplicate notices in the Planner session, with the consumed watermark ignored.
    const f = await fixture();
    const p1 = await f.engine.createAssignment(f.pairId, 'P1', 'Instruction');
    await f.engine.dispatchAssignment(p1.id);

    // The Worker never answers.
    f.workerProvider.isWorking = false;
    f.workerProvider.isComplete = false;

    const first = await f.engine.runSupervisionTick();
    assert.equal(first.batonDecisions[0]!.decision, 'send_recovery_notice');
    const noticesAfterFirstTick = (await f.db.assignments.findByPairId(f.pairId)).filter(
      (a) => a.sourceRecoveryDeliveryId !== undefined,
    );
    assert.equal(noticesAfterFirstTick.length, 1);
    const notice = noticesAfterFirstTick[0]!;

    const plannerTurnsAfterFirstNotice = userTurns(f.plannerProvider);

    // Stop and start with the gap still open.
    haltProcess(f);
    const restarted = resumeProcess(f);
    const recovery = await restarted.engine.recoverOnStartup();
    assert.equal(
      recovery.batonDecisions[0]!.decision,
      'recovery_notice_already_issued',
      'a confirmed resume notice closes its own episode',
    );
    assert.equal(recovery.batonDecisions[0]!.action.kind, 'none');

    for (let i = 0; i < 3; i++) await restarted.engine.runSupervisionTick();

    const notices = (await restarted.db.assignments.findByPairId(restarted.pairId)).filter(
      (a) => a.sourceRecoveryDeliveryId !== undefined,
    );
    assert.equal(notices.length, 1, 'the episode is not re-opened: no new relay cycle');
    assert.deepEqual(notices.map((n) => n.id), [notice.id]);
    assert.equal((await attemptsFor(restarted, notice.id)).length, 1, 'exactly one Attempt for the notice');
    assert.equal((await confirmedDeliveries(restarted, notice.id)).length, 1);
    assert.equal(
      userTurns(restarted.plannerProvider),
      plannerTurnsAfterFirstNotice,
      'the already-consumed notice is never written to the Planner again',
    );
  });

  it('never resends a Delivery stranded mid-send by a crash, and never mints a second Attempt for it', async () => {
    const f = await fixture();
    const p1 = await f.engine.createAssignment(f.pairId, 'P1', 'Instruction');
    const sent = await f.engine.dispatchAssignment(p1.id);
    assert.equal(sent.delivery.status, 'delivered');

    // A crash inside the provider call leaves the durable intent exactly as Phase 1
    // committed it: Attempt prepared, Delivery `delivering`. The message may or may
    // not have landed, and nothing in the database can tell us which.
    f.db.db.prepare(`UPDATE deliveries SET status='delivering', delivered_at=NULL WHERE id=?`).run(
      sent.delivery.id,
    );
    haltProcess(f);

    const restarted = resumeProcess(f);
    const before = await restarted.db.assignments.findByPairId(restarted.pairId);
    const recovery = await restarted.engine.recoverOnStartup();

    assert.ok(
      recovery.dispatchIntents.dispositions.some((d) => d.disposition === 'ambiguous_raised'),
      'the stranded intent is resolved to ambiguity, never to a resend',
    );
    const stranded = (await restarted.db.deliveries.findByAssignmentId(p1.id))[0]!;
    assert.equal(stranded.status, 'ambiguous');

    // The ambiguity is operator-visible rather than silently cleared.
    const open = await restarted.db.attention.findOpen();
    assert.ok(open.some((i) => i.type === 'ambiguous_delivery'));

    await restarted.engine.runSupervisionTick();
    await restarted.engine.runSupervisionTick();

    const after = await restarted.db.assignments.findByPairId(restarted.pairId);
    assert.deepEqual(after.map((a) => a.id).sort(), before.map((a) => a.id).sort(), 'no Assignment is created');
    assert.equal((await restarted.db.deliveries.findByAssignmentId(p1.id)).length, 1, 'no second Delivery');
    assert.equal((await attemptsFor(restarted, p1.id)).length, 1, 'no duplicate Attempt');
    assert.equal(
      userTurns(restarted.workerProvider),
      1,
      'the Worker session is written to exactly once, by the pre-crash send',
    );
  });

  it('continues a converted Handoff exactly once when the crash lands between conversion and dispatch', async () => {
    const f = await fixture();
    const p1 = await f.engine.createAssignment(f.pairId, 'P1', 'Instruction');
    await f.engine.dispatchAssignment(p1.id);
    f.workerProvider.isWorking = false;
    f.workerProvider.isComplete = true;
    f.workerProvider.responseSummary = 'WORKER RESULT';
    await f.engine.runSupervisionTick(); // Handoff recorded

    // Reproduce the narrow window: the Handoff has been converted into the opposite
    // side's Assignment, but the process died before `dispatchAssignment` ran. The
    // execution slot is released and the new Assignment is still `pending`.
    const handoff = (await f.db.handoffs.findByAssignmentId(p1.id))[0]!;
    const pair = (await f.db.pairs.findById(f.pairId))!;
    const derived = Assignment.create(
      f.pairId,
      pair.projectId,
      'derived',
      'Handoff from worker: P1',
      'normal',
      'planner',
      handoff.id,
    );
    await f.db.assignments.save(derived);
    const source = (await f.db.assignments.findById(p1.id))!;
    source.complete();
    await f.db.assignments.save(source);
    handoff.completeHandoff();
    await f.db.handoffs.save(handoff);
    pair.clearWork();
    await f.db.pairs.save(pair);

    haltProcess(f);
    const restarted = resumeProcess(f);

    // The decision here is `transfer_completed_turn`, not `completed_turn_already_transferred`,
    // and the difference is the whole point of the crash window.
    //
    // The derived Assignment exists but NOTHING has been sent on it: there is no Delivery at
    // all. "Converted" is not "handed over" — a completed turn counts as transferred only once
    // its Delivery is confirmed `delivered` — so this is a continuation of the in-flight
    // hand-over, not a second hand-on. The exactly-once guarantees this test exists to protect
    // are asserted below and are unchanged: still 2 Assignments, still 1 Attempt, still 1
    // confirmed Delivery, still 1 Handoff, and the Planner still receives the turn once.
    const recovery = await restarted.engine.recoverOnStartup();
    assert.equal(
      recovery.batonDecisions[0]!.decision,
      'transfer_completed_turn',
      'an undelivered derived Assignment is continued, not mistaken for a completed transfer',
    );

    // The exactly-once guarantees are read HERE, immediately after the recovery pass, because
    // that is the moment the in-flight hand-over is completed. The state is sampled at this
    // point rather than after further ticks, which would be measuring the NEXT baton episode.
    const afterRecovery = await restarted.db.assignments.findByPairId(restarted.pairId);
    const next = afterRecovery.find((a) => a.id === derived.id)!;
    assert.ok(next, 'the existing derived Assignment is reused, not replaced');
    assert.equal(next.status, 'active');
    assert.equal((await attemptsFor(restarted, next.id)).length, 1, 'exactly one Attempt');
    assert.equal((await confirmedDeliveries(restarted, next.id)).length, 1, 'exactly one confirmed Delivery');
    assert.equal((await restarted.db.handoffs.findByAssignmentId(p1.id)).length, 1, 'no duplicate Handoff');
    assert.equal(
      afterRecovery.filter((a) => a.sourceHandoffId !== undefined).length,
      1,
      'the Handoff still converts into exactly one Assignment across the restart',
    );
    assert.equal(
      recovery.batonDecisions[0]!.action.deliveryConfirmed,
      true,
      'the continued hand-over is itself a confirmed Delivery',
    );
    assert.equal(userTurns(restarted.plannerProvider), 1, 'the Planner receives the Worker turn exactly once');
    assert.equal(userTurns(restarted.workerProvider), 1, 'the Worker is not written to again');

    // Further ticks must not hand the Worker's turn over a second time. The Planner, now holding
    // the baton, has produced nothing in this fixture — so a continuity notice about THAT episode
    // is legitimate on a later tick. What must not recur is a second hand-on of this turn, which
    // is why the count is taken on the Handoff-derived Assignment and not on every Delivery.
    const resumeTick = await restarted.engine.runSupervisionTick();
    assert.notEqual(
      resumeTick.batonDecisions[0]!.action.kind,
      'handoff_advanced',
      'the completed turn is not handed on a second time after the restart',
    );
    assert.equal(
      (await restarted.db.assignments.findByPairId(restarted.pairId)).filter(
        (a) => a.sourceHandoffId === handoff.id,
      ).length,
      1,
      'still exactly one Assignment converted from that Handoff',
    );
    assert.equal((await restarted.db.handoffs.findByAssignmentId(p1.id)).length, 1, 'still no duplicate Handoff');
    assert.equal(
      userTurnsWithText(restarted.plannerProvider, 'Handoff from worker: P1'),
      1,
      'the Worker turn still reaches the Planner exactly once',
    );
    assert.equal(userTurns(restarted.workerProvider), 1, 'the Worker is still not written to again');

    const baton = await restarted.engine.derivePairBaton(
      (await restarted.db.pairs.findById(f.pairId))!,
    );
    assert.equal(baton.owner, 'planner', 'the baton moved exactly one link');
  });

  it('pause halts all provider contact and resume continues the SAME chain, not a new one', async () => {
    const f = await fixture();
    const p1 = await f.engine.createAssignment(f.pairId, 'P1', 'Instruction');
    await f.engine.dispatchAssignment(p1.id);
    f.workerProvider.isWorking = false;
    f.workerProvider.isComplete = true;
    f.workerProvider.responseSummary = 'WORKER RESULT';
    await f.engine.runSupervisionTick();
    await f.engine.runSupervisionTick();

    const chainBefore = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(chainBefore.owner, 'planner');
    const confirmedBefore = await confirmedDeliveryCount(f);
    const plannerTurnsBefore = userTurns(f.plannerProvider);

    // ---- PAUSE ------------------------------------------------------------------
    const paused = await f.engine.pausePair(f.pairId);
    assert.equal(paused.relayState, 'PAUSED');
    assert.equal(paused.operationalState, 'ACTIVE', 'pause is a relay-state change, not an operational one');

    const pausedTick = await f.engine.runSupervisionTick();
    assert.deepEqual(pausedTick.batonDecisions, [], 'a PAUSED pair is refused by the automated authority gate');
    assert.equal(await confirmedDeliveryCount(f), confirmedBefore, 'nothing is sent while paused');
    assert.equal(userTurns(f.plannerProvider), plannerTurnsBefore);

    // ---- RESUME -----------------------------------------------------------------
    const resumed = await f.engine.resumePair(f.pairId);
    assert.equal(resumed.relayState, 'RUNNING');

    const batonAfterResume = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(
      batonAfterResume.owner,
      chainBefore.owner,
      'resume does not re-decide ownership: the Planner still owes the next turn',
    );
    // The Planner still has produced nothing, so resume closes the open mechanical gap
    // with ONE notice. That notice is itself a confirmed Delivery, so it becomes the new
    // baton — which is why its id differs and why no further notice may follow.
    assert.notEqual(
      batonAfterResume.delivery!.id,
      chainBefore.delivery!.id,
      'the notice, not the previous link, now holds the baton',
    );
    assert.equal(batonAfterResume.assignment!.sourceRecoveryDeliveryId, chainBefore.delivery!.id);

    const chain = await f.db.assignments.findByPairId(f.pairId);
    const added = chain.filter((a) => a.sourceHandoffId === undefined && a.sourceRecoveryDeliveryId === undefined);
    assert.equal(added.length, 1, 'the only addition is the resume notice for the still-open gap; no work Assignment');

    const notice = chain.filter((a) => a.sourceRecoveryDeliveryId !== undefined);
    assert.equal(notice.length, 1, 'exactly one resume notice, never one per pause/resume cycle');
    assert.equal((await attemptsFor(f, notice[0]!.id)).length, 1);
    assert.equal(userTurns(f.plannerProvider), plannerTurnsBefore + 1);

    // Repeated resumes must not accumulate anything.
    await f.engine.resumePair(f.pairId);
    await f.engine.resumePair(f.pairId);
    assert.equal(
      (await f.db.assignments.findByPairId(f.pairId)).filter((a) => a.sourceRecoveryDeliveryId !== undefined).length,
      1,
    );
    assert.equal(userTurns(f.plannerProvider), plannerTurnsBefore + 1);
  });
});