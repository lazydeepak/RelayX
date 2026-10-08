/**
 * THE EXECUTION SLOT vs. THE RELAY RESUME NOTICE.
 * =========================================================================
 *
 * ## The invariant under test, quoted from the code that owns it
 *
 * `RelayEngine.assertExecutionSlotAvailable` (its own docstring):
 *
 *   "`Pair.activeAssignmentId` is the Pair's single execution slot. At most one Assignment
 *    with a non-terminal status may hold it. Two holders mean two Assignments each believe
 *    they own the Pair's work, and the newer one silently overwrote the older one at the
 *    moment of dispatch — which is how an Assignment ends up orphaned while still `active`."
 *
 * `RelayEngine.createAssignment` (its own docstring):
 *
 *   "Creating a `pending` Assignment does not take the Pair's execution slot, so this is
 *    legal even while another Assignment is active — a Pair may legitimately have a backlog."
 *
 * `RelayEngine.reconcilePairAssignmentAuthority`, rule 3:
 *
 *   "Every OTHER unresolved Assignment is transitioned explicitly, with an event each.
 *    `pending` with no Attempt is `cancelled` (superseded, never dispatched); `active`/
 *    `waiting_for_handoff` with dispatch evidence is ... otherwise `cancelled` with the
 *    ambiguity named in the event."
 *
 * So, precisely, and established here rather than inferred:
 *
 *   CAN more than one non-terminal Assignment legally exist for one Pair while only one
 *   owns `active_assignment_id`?
 *
 *   YES — but only if every OTHER non-terminal Assignment is `pending` with no Attempt
 *   (legal backlog, never dispatched). A Pair may hold any number of those.
 *
 *   NO — a non-terminal Assignment that HAS been dispatched (it has an Attempt, or a
 *   `currentAttemptId`) may exist ONLY as the execution-slot holder. If a second one appears,
 *   the first has been silently orphaned: it still reports `active` with its own
 *   `currentAttemptId` while `pairs.active_assignment_id` names somebody else. That is the
 *   contradictory durable state, and it is what these tests exist to forbid.
 *
 * ## Why the resume notice was the violator
 *
 * `issueRecoveryNotice` claimed the slot with `pair.assignWork(...)` — an unconditional
 * setter — without going through `assertExecutionSlotAvailable` and without making the
 * previous holder terminal. In case A3 the previous holder is always dispatched and always
 * non-terminal: the Worker Assignment, `active`, with its own Attempt and a CONFIRMED
 * Delivery. So the notice orphaned it on every single recovery notice.
 *
 * It was not transient. It survived a real SQLite close/reopen, it outlived the whole relay
 * chain continuing normally, and `reconcilePairAssignmentAuthority` — the engine's own
 * repair — classified the Pair as corrupt and cancelled the Worker Assignment, destroying
 * that episode's records while doing it.
 *
 * ## What these tests assert
 *
 *   - the previous slot holder is made TERMINAL in the same transaction that grants the
 *     slot, with a stated reason in the event stream
 *   - `reconcilePairAssignmentAuthority` reports ZERO transitions afterwards: the engine's
 *     own repair agrees there is nothing corrupt left
 *   - `cancelled` is used, and the reason asserts nothing about the work
 *   - the Delivery stays `delivered`, the boundary watermark is byte-identical, and baton
 *     derivation is unchanged
 *   - a `pending` no-Attempt backlog item is NOT collateral damage
 *   - all of it holds across a real process restart
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Assignment, Attempt } from '../src/relay/domain/entities.ts';
import { MockProvider } from './MockProvider.ts';
import type { PairId } from '../src/relay/domain/types.ts';
import type { ReconciliationMessage } from '../src/relay/providers/exactSessionReconciliation.ts';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

interface World {
  dbPath: string;
  db: SqliteRelayDatabase;
  engine: RelayEngine;
  plannerProvider: MockProvider;
  workerProvider: MockProvider;
  pairId: PairId;
}

function openProcess(
  dbPath: string,
  carry?: { planner: ReconciliationMessage[]; worker: ReconciliationMessage[] },
) {
  const db = new SqliteRelayDatabase(dbPath);
  const engine = new RelayEngine(db);
  const plannerProvider = new MockProvider('chatgpt');
  const workerProvider = new MockProvider('opencode');
  plannerProvider.adoptTranscript(carry?.planner ?? []);
  workerProvider.adoptTranscript(carry?.worker ?? []);
  engine.registerProvider(plannerProvider);
  engine.registerProvider(workerProvider);
  return { db, engine, plannerProvider, workerProvider };
}

async function bootstrap(p: ReturnType<typeof openProcess>): Promise<PairId> {
  const project = await p.engine.createProject('Slot Project');
  const planner = await p.engine.registerRuntimeSession('chatgpt', 'Planner');
  const worker = await p.engine.registerRuntimeSession('opencode', 'Worker');
  const pair = await p.engine.createPair(project.id, 'Slot Pair', planner.id, worker.id);
  planner.updateExternalIdentity('ses_planner', '/dev/planner');
  worker.updateExternalIdentity('ses_worker', '/dev/worker');
  await p.db.runtimes.save(planner);
  await p.db.runtimes.save(worker);
  await p.engine.loadAndActivate(pair.id);
  await p.engine.startPair(pair.id);
  return pair.id;
}

async function world(): Promise<World> {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relayx-slot-')), 'relay.sqlite');
  const p = openProcess(dbPath);
  return { dbPath, ...p, pairId: await bootstrap(p) };
}

function restart(w: World): World {
  return { ...w, ...openProcess(w.dbPath, { planner: w.plannerProvider.messages, worker: w.workerProvider.messages }) };
}

function halt(w: World): void {
  w.engine.stopSupervisionLoop();
  w.db.db.close();
}

/**
 * THE INVARIANT, as an executable predicate.
 *
 * Every non-terminal Assignment that has dispatch evidence must be the execution-slot
 * holder. Returns the offending Assignments so a failure can name them.
 */
async function orphanedNonTerminalAssignments(
  w: World,
): Promise<Array<{ id: string; status: string; currentAttemptId?: string; attempts: number }>> {
  const pair = (await w.db.pairs.findById(w.pairId))!;
  const orphans: Array<{ id: string; status: string; currentAttemptId?: string; attempts: number }> = [];
  for (const a of await w.db.assignments.findByPairId(w.pairId)) {
    if (TERMINAL.has(a.status)) continue;
    if (a.currentAttemptId === undefined && (await w.db.attempts.findByAssignmentId(a.id)).length === 0) {
      continue; // `pending` backlog with no Attempt is legal
    }
    if (pair.activeAssignmentId !== a.id) {
      orphans.push({
        id: a.id,
        status: a.status,
        currentAttemptId: a.currentAttemptId,
        attempts: (await w.db.attempts.findByAssignmentId(a.id)).length,
      });
    }
  }
  return orphans;
}

async function slotHolder(w: World) {
  return (await w.db.pairs.findById(w.pairId))!.activeAssignmentId ?? null;
}

async function noticeAssignments(w: World) {
  return (await w.db.assignments.findByPairId(w.pairId)).filter((a) => a.sourceRecoveryDeliveryId !== undefined);
}

/** Dispatch one worker Assignment and leave the Worker inert, so A3 requires a notice. */
async function inertWorkerRequiringNotice(w: World, instruction = 'Planner instruction #1') {
  const a = await w.engine.createAssignment(w.pairId, 'P1', instruction);
  const sent = await w.engine.dispatchAssignment(a.id);
  assert.equal(sent.delivery.status, 'delivered', 'a confirmed Delivery is what puts the baton on the Worker');
  w.workerProvider.isWorking = false;
  w.workerProvider.isComplete = false;
  return a;
}

describe('Execution slot vs. the relay resume notice', () => {
  /* ================================================================== */
  /* 1. The defect, reproduced and now closed                           */
  /* ================================================================== */

  it('closing: the resume notice terminates the previous slot holder in the same transaction', async () => {
    const w = await world();
    const workerAssignment = await inertWorkerRequiringNotice(w);

    // Before: the Worker Assignment holds the slot and is the only dispatched one.
    assert.equal(await slotHolder(w), workerAssignment.id);
    assert.deepEqual(await orphanedNonTerminalAssignments(w), [], 'baseline is clean');

    const tick = await w.engine.runSupervisionTick();
    const report = tick.batonDecisions[0]!;
    assert.equal(report.decision, 'send_recovery_notice');
    assert.equal(report.action.kind, 'recovery_notice_issued');

    const notices = await noticeAssignments(w);
    assert.equal(notices.length, 1);
    const notice = notices[0]!;

    // ---- THE INVARIANT HOLDS ----
    assert.deepEqual(
      await orphanedNonTerminalAssignments(w),
      [],
      'no dispatched Assignment may be non-terminal while the slot names another',
    );

    // A: the previous holder is EXPLICITLY transitioned, not merely displaced.
    const previous = (await w.db.assignments.findById(workerAssignment.id))!;
    assert.equal(previous.status, 'cancelled', 'the previous slot holder must be made terminal');
    assert.equal(previous.currentAttemptId !== undefined, true, 'its dispatch evidence is untouched');
    assert.equal(
      (await w.db.attempts.findByAssignmentId(workerAssignment.id)).length,
      1,
      'its Attempt survives — the episode records are preserved, not destroyed',
    );
    assert.equal(
      (await w.db.deliveries.findByAssignmentId(workerAssignment.id))[0]!.status,
      'delivered',
      'its Delivery stays confirmed; only the Assignment moved on',
    );

    // The slot names the notice, and the notice is the only non-terminal dispatched Assignment.
    assert.equal(await slotHolder(w), notice.id);
    assert.equal(notice.status, 'active');

    // The transition is recorded with a stated reason, not applied silently.
    const events = await w.db.events.findRecent(200);
    const cancelled = events.find(
      (e) => e.eventType === 'assignment.cancelled' && e.resourceId === workerAssignment.id,
    );
    assert.ok(cancelled, 'the terminal transition is in the event stream');
    assert.equal(cancelled!.previousState, 'active');
    assert.equal(cancelled!.newState, 'cancelled');
    assert.equal(String(cancelled!.details?.supersededBy), notice.id);
    assert.equal(cancelled!.details?.wasBatonAssignment, true);
    assert.ok(String(cancelled!.details?.reason ?? '').length > 0, 'and it carries a reason');

    // ---- The engine's OWN repair agrees there is nothing corrupt ----
    // `reconcilePairAssignmentAuthority` cancels orphans. Before the fix it cancelled the
    // Worker Assignment here, which is how the state was proven to be corrupt.
    const repair = await w.engine.reconcilePairAssignmentAuthority(w.pairId);
    assert.deepEqual(
      repair.transitions,
      [],
      'the existing repair operation must find nothing to repair',
    );
    assert.equal(repair.adoptedAssignmentId, notice.id);
    assert.equal(
      (await w.db.assignments.findById(workerAssignment.id))!.status,
      'cancelled',
      'and it changes nothing: the state is already coherent',
    );
  });

  it('the cancellation asserts nothing about the work — it closes an episode, it does not judge it', async () => {
    const w = await world();
    const workerAssignment = await inertWorkerRequiringNotice(w);

    const batonBefore = await w.engine.derivePairBaton((await w.db.pairs.findById(w.pairId))!);
    assert.equal(batonBefore.owner, 'worker');

    await w.engine.runSupervisionTick();

    const cancelled = (await w.db.events.findRecent(200)).find(
      (e) => e.eventType === 'assignment.cancelled' && e.resourceId === workerAssignment.id,
    )!;
    const reason = String(cancelled.details?.reason);

    // `cancelled` is used rather than `completed` or `failed`, and the reason says so.
    assert.equal((await w.db.assignments.findById(workerAssignment.id))!.status, 'cancelled');
    assert.doesNotMatch(reason, /\b(worker|task|work) (failed|completed)\b/i);
    assert.doesNotMatch(reason, /\bresult was invalid\b/i);
    assert.doesNotMatch(reason, /\bdrifted\b/i);
    assert.match(reason, /asserts nothing about whether the work/i);
    assert.match(reason, /baton moved on/i);
    assert.equal(cancelled.details?.explicitlyNotAsserted, undefined, 'no verdict list is needed here');

    // The consumed watermark is byte-identical across the transition, read back through the
    // same accessor the engine uses. The Worker Assignment's Delivery stays in the chain.
    const batonAfter = await w.engine.derivePairBaton((await w.db.pairs.findById(w.pairId))!);
    const workerLinkBefore = batonBefore.chain.find((l) => l.assignment.id === workerAssignment.id)!;
    const workerLinkAfter = batonAfter.chain.find((l) => l.assignment.id === workerAssignment.id)!;
    assert.ok(workerLinkAfter, 'the Worker Assignment is still a chain link after being cancelled');
    assert.deepEqual(
      [...workerLinkAfter.boundary!.messageIds],
      [...workerLinkBefore.boundary!.messageIds],
      'the recorded message-id boundary is unchanged',
    );
    assert.equal(workerLinkAfter.boundary!.provenance, 'captured_pre_dispatch');
    assert.equal(workerLinkAfter.delivery.status, 'delivered');
    assert.equal(
      batonAfter.confirmedDeliveryCount,
      batonBefore.confirmedDeliveryCount + 1,
      'the chain grew by exactly the notice, not by a re-send',
    );
    assert.equal(
      (await w.db.deliveries.findByAssignmentId(workerAssignment.id)).length,
      1,
      'the Worker was sent exactly one message for that episode',
    );
  });

  it('a legal `pending` backlog Assignment is NOT collateral damage', async () => {
    const w = await world();
    // Created before dispatch, so it is a `pending` no-Attempt backlog item, never dispatched.
    const backlog = await w.engine.createAssignment(w.pairId, 'backlog', 'never dispatched');
    assert.equal((await w.db.assignments.findById(backlog.id))!.status, 'pending');

    await inertWorkerRequiringNotice(w);
    await w.engine.runSupervisionTick();

    assert.equal(
      (await w.db.assignments.findById(backlog.id))!.status,
      'pending',
      'legal backlog must survive the episode closure untouched',
    );
    assert.equal((await w.db.attempts.findByAssignmentId(backlog.id)).length, 0);
    assert.deepEqual(await orphanedNonTerminalAssignments(w), []);
  });

  /* ================================================================== */
  /* 2. Interaction with normal continuation (cases 1-5)                */
  /* ================================================================== */

  it('Case 1: active Assignment -> completed work -> normal next Assignment, with no orphan', async () => {
    const w = await world();
    const first = await w.engine.createAssignment(w.pairId, 'P1', 'instruction');
    await w.engine.dispatchAssignment(first.id);

    w.workerProvider.isWorking = false;
    w.workerProvider.isComplete = true;
    w.workerProvider.responseSummary = 'WORKER RESULT';

    await w.engine.runSupervisionTick(); // Handoff recorded
    await w.engine.runSupervisionTick(); // converted + dispatched to the Planner

    assert.equal((await w.db.assignments.findById(first.id))!.status, 'completed');
    const notices = await noticeAssignments(w);
    assert.equal(notices.length, 0, 'a completing worker needs no resume notice');
    assert.deepEqual(await orphanedNonTerminalAssignments(w), []);

    const holder = await slotHolder(w);
    assert.ok(holder, 'the next Assignment holds the slot');
    assert.notEqual(holder, first.id);
    const baton = await w.engine.derivePairBaton((await w.db.pairs.findById(w.pairId))!);
    assert.equal(baton.owner, 'planner');
    assert.equal(baton.assignment!.id, holder, 'the slot holder IS the baton Assignment');
  });

  it('Case 2: active Assignment -> recovery notice required, ends coherent', async () => {
    const w = await world();
    const workerAssignment = await inertWorkerRequiringNotice(w);
    await w.engine.runSupervisionTick();

    assert.deepEqual(await orphanedNonTerminalAssignments(w), []);
    assert.equal((await w.db.assignments.findById(workerAssignment.id))!.status, 'cancelled');

    const notice = (await noticeAssignments(w))[0]!;
    assert.equal(await slotHolder(w), notice.id);

    // The baton moved to the Planner and the notice is what holds it.
    const baton = await w.engine.derivePairBaton((await w.db.pairs.findById(w.pairId))!);
    assert.equal(baton.owner, 'planner');
    assert.equal(baton.assignment!.id, notice.id);
  });

  it('Case 3: notice already delivered -> repeated ticks change nothing at all', async () => {
    const w = await world();
    const workerAssignment = await inertWorkerRequiringNotice(w);
    await w.engine.runSupervisionTick();

    const snapshot = {
      slot: await slotHolder(w),
      notices: (await noticeAssignments(w)).map((n) => n.id).sort(),
      deliveries: (await w.db.assignments.findByPairId(w.pairId)).length,
      plannerUserTurns: w.plannerProvider.messages.filter((m) => m.role === 'user').length,
      workerStatus: (await w.db.assignments.findById(workerAssignment.id))!.status,
    };

    for (let i = 0; i < 4; i++) {
      const tick = await w.engine.runSupervisionTick();
      assert.equal(
        tick.batonDecisions[0]!.decision,
        'recovery_notice_already_issued',
        'the delivered notice closes its own episode',
      );
      assert.equal(tick.batonDecisions[0]!.action.kind, 'none');
      assert.deepEqual(await orphanedNonTerminalAssignments(w), []);
    }

    assert.equal(await slotHolder(w), snapshot.slot, 'the slot does not churn');
    assert.deepEqual((await noticeAssignments(w)).map((n) => n.id).sort(), snapshot.notices);
    assert.equal((await w.db.assignments.findByPairId(w.pairId)).length, snapshot.deliveries);
    assert.equal(
      w.plannerProvider.messages.filter((m) => m.role === 'user').length,
      snapshot.plannerUserTurns,
      'no duplicate notice is written to the Planner',
    );
    assert.equal((await w.db.assignments.findById(workerAssignment.id))!.status, snapshot.workerStatus);
  });

  it('Case 4: restart after the notice was delivered keeps the slot, the baton and the watermark', async () => {
    let w = await world();
    const workerAssignment = await inertWorkerRequiringNotice(w);
    await w.engine.runSupervisionTick();

    const before = {
      slot: await slotHolder(w),
      baton: await w.engine.derivePairBaton((await w.db.pairs.findById(w.pairId))!),
      statuses: Object.fromEntries(
        (await w.db.assignments.findByPairId(w.pairId)).map((a) => [a.id, a.status]),
      ),
    };
    const plannerUserTurnsBefore = w.plannerProvider.messages.filter((m) => m.role === 'user').length;

    halt(w);
    w = restart(w); // real close + reopen

    assert.deepEqual(await orphanedNonTerminalAssignments(w), [], 'no orphan appears on reload');
    assert.equal(await slotHolder(w), before.slot, 'the slot points at the same Assignment');

    const reloaded = await w.engine.derivePairBaton((await w.db.pairs.findById(w.pairId))!);
    assert.equal(reloaded.delivery!.id, before.baton.delivery!.id, 'the same Delivery holds the baton');
    assert.equal(reloaded.owner, before.baton.owner);
    assert.equal(reloaded.assignment!.id, before.baton.assignment!.id);
    assert.deepEqual(
      [...reloaded.boundary!.messageIds],
      [...before.baton.boundary!.messageIds],
      'the consumed watermark is unchanged across the restart',
    );

    assert.deepEqual(
      Object.fromEntries((await w.db.assignments.findByPairId(w.pairId)).map((a) => [a.id, a.status])),
      before.statuses,
      'no Assignment changed state merely because the process restarted',
    );

    const recovery = await w.engine.recoverOnStartup();
    assert.equal(recovery.batonDecisions[0]!.decision, 'recovery_notice_already_issued');
    await w.engine.runSupervisionTick();
    await w.engine.runSupervisionTick();

    assert.deepEqual(await orphanedNonTerminalAssignments(w), []);
    assert.equal(await slotHolder(w), before.slot, 'orchestration did not resurrect or replace anything');
    assert.equal((await noticeAssignments(w)).length, 1, 'no duplicate recovery notice');
    assert.equal(
      w.plannerProvider.messages.filter((m) => m.role === 'user').length,
      plannerUserTurnsBefore,
      'the Planner was not written to again',
    );
    assert.equal((await w.db.assignments.findById(workerAssignment.id))!.status, 'cancelled');
  });

  it('Case 5: a LEGACY orphan (written before the fix) is deterministic to repair and never compounds', async () => {
    // Reproduce the exact pre-fix durable shape by hand: the Pair slot names the notice, and
    // the Worker Assignment is still `active` with its own Attempt and a confirmed Delivery.
    let w = await world();
    const workerAssignment = await inertWorkerRequiringNotice(w);
    await w.engine.runSupervisionTick();
    const notice = (await noticeAssignments(w))[0]!;

    const legacy = (await w.db.assignments.findById(workerAssignment.id))!;
    legacy.status = 'active';
    await w.db.assignments.save(legacy);

    const orphans = await orphanedNonTerminalAssignments(w);
    assert.equal(orphans.length, 1, 'the legacy shape IS the invariant violation, and it is detectable');
    assert.equal(orphans[0]!.id, workerAssignment.id);

    // Restart must not make it worse: no new claimant, no new Delivery.
    halt(w);
    w = restart(w);
    await w.engine.recoverOnStartup();
    await w.engine.runSupervisionTick();

    assert.equal((await orphanedNonTerminalAssignments(w)).length, 1, 'restart does not compound it');
    assert.equal((await noticeAssignments(w)).length, 1, 'and does not send another notice');
    assert.equal(await slotHolder(w), notice.id, 'the real holder keeps the slot');

    // The existing repair resolves it deterministically, keeping the real holder.
    const repair = await w.engine.reconcilePairAssignmentAuthority(w.pairId);
    assert.equal(repair.adoptedAssignmentId, notice.id, 'the real holder is kept, not replaced');
    assert.equal(repair.transitions.length, 1);
    assert.equal(repair.transitions[0]!.assignmentId, workerAssignment.id);
    assert.equal(repair.transitions[0]!.to, 'cancelled');
    assert.deepEqual(await orphanedNonTerminalAssignments(w), [], 'the violation is now gone');

    // Idempotent, and a healthy Pair is untouched by the repair.
    const again = await w.engine.reconcilePairAssignmentAuthority(w.pairId);
    assert.deepEqual(again.transitions, []);
    assert.equal(await slotHolder(w), notice.id);
  });

  it('the whole relay chain after a resume notice never contains an orphan, at any step', async () => {
    // One long run through: notice -> planner answers -> hand-over -> next worker Assignment.
    // The invariant is asserted after EVERY step, so a violation cannot hide between checks.
    let w = await world();
    const workerAssignment = await inertWorkerRequiringNotice(w);
    await w.engine.runSupervisionTick();
    assert.deepEqual(await orphanedNonTerminalAssignments(w), [], 'after the notice');

    w.plannerProvider.isWorking = false;
    w.plannerProvider.isComplete = true;
    w.plannerProvider.responseSummary = 'PLANNER ANSWER';
    await w.engine.runSupervisionTick();
    assert.deepEqual(await orphanedNonTerminalAssignments(w), [], 'after the planner turn is recorded');
    await w.engine.runSupervisionTick();
    assert.deepEqual(await orphanedNonTerminalAssignments(w), [], 'after the hand-over is dispatched');

    const notice = (await noticeAssignments(w))[0]!;
    assert.equal((await w.db.assignments.findById(notice.id))!.status, 'completed');
    assert.equal((await w.db.assignments.findById(workerAssignment.id))!.status, 'cancelled');

    // Restart mid-chain, then keep going.
    halt(w);
    w = restart(w);
    await w.engine.recoverOnStartup();
    assert.deepEqual(await orphanedNonTerminalAssignments(w), [], 'after recoverOnStartup');
    await w.engine.runSupervisionTick();
    assert.deepEqual(await orphanedNonTerminalAssignments(w), [], 'after the first tick');

    const holder = await slotHolder(w)!;
    assert.equal(
      (await w.engine.derivePairBaton((await w.db.pairs.findById(w.pairId))!)).assignment!.id,
      holder,
      'the slot holder and the baton Assignment agree: one authority, not two',
    );
  });

  /* ================================================================== */
  /* 3. The other assignWork site: audited, and proven not to orphan    */
  /* ================================================================== */

  it('the other unconditional assignWork (baton re-adoption) keeps the slot on its own Assignment', async () => {
    // `transferCompletedTurn` also calls `pair.assignWork` unconditionally, to re-adopt the
    // baton Assignment onto the slot after recording a Handoff. It must never displace a
    // dispatched non-terminal Assignment. Here the holder before it is the same Assignment,
    // and a legal `pending` backlog item sits alongside.
    const w = await world();
    const backlog = await w.engine.createAssignment(w.pairId, 'backlog', 'never dispatched');
    const a = await w.engine.createAssignment(w.pairId, 'P1', 'instruction');
    await w.engine.dispatchAssignment(a.id);

    w.workerProvider.isWorking = false;
    w.workerProvider.isComplete = true;
    w.workerProvider.responseSummary = 'WORKER RESULT';
    await w.engine.runSupervisionTick(); // Handoff recorded; slot re-adopted onto `a`

    assert.equal(await slotHolder(w), a.id, 'the baton Assignment keeps its own slot');
    assert.equal((await w.db.assignments.findById(a.id))!.status, 'waiting_for_handoff');
    assert.equal((await w.db.assignments.findById(backlog.id))!.status, 'pending');
    assert.deepEqual(await orphanedNonTerminalAssignments(w), []);
  });

  it('a resume notice closes the baton episode AND displaces a foreign slot holder, neither silently', async () => {
    // Two distinct claims, both of which the notice's slot claim would otherwise orphan:
    // the baton Assignment (whose episode this notice reports) and whatever else is
    // currently holding the slot. Each is made terminal with its own stated reason.
    const w = await world();
    const workerAssignment = await inertWorkerRequiringNotice(w);

    // Sanity: before the corruption is introduced, the Worker Assignment legitimately holds
    // the slot, so there is nothing to report.
    assert.deepEqual(await orphanedNonTerminalAssignments(w), [], 'the clean setup has no orphan');

    // Manufacture a second, unrelated dispatched non-terminal Assignment and point the slot
    // at it — the corrupt shape `reconcilePairAssignmentAuthority` exists to remove. This
    // pre-orphans the Worker Assignment; the notice must not deepen that.
    const stray = Assignment.create(
      w.pairId,
      (await w.db.pairs.findById(w.pairId))!.projectId,
      'stray',
      'stray',
      'normal',
      'planner',
    );
    await w.db.assignments.save(stray);
    const strayAttempt = Attempt.create(stray.id, 1);
    await w.db.attempts.save(strayAttempt);
    stray.startAttempt(strayAttempt);
    await w.db.assignments.save(stray);

    const pair = (await w.db.pairs.findById(w.pairId))!;
    pair.activeAssignmentId = stray.id;
    await w.db.pairs.save(pair);
    assert.equal(
      (await orphanedNonTerminalAssignments(w)).length,
      1,
      'the slot now names `stray`, so the Worker Assignment is the orphan: two claimants, one slot',
    );

    await w.engine.runSupervisionTick();

    const notice = (await noticeAssignments(w))[0]!;
    assert.equal(await slotHolder(w), notice.id);

    const events = await w.db.events.findRecent(200);

    // (1) The baton Assignment's episode is closed, with the episode reason.
    assert.equal((await w.db.assignments.findById(workerAssignment.id))!.status, 'cancelled');
    const batonEvent = events.find(
      (e) => e.eventType === 'assignment.cancelled' && e.resourceId === workerAssignment.id,
    )!;
    assert.equal(batonEvent.details?.wasBatonAssignment, true);
    assert.match(String(batonEvent.details?.reason), /reported this Assignment's mechanical gap/i);

    // (2) The foreign slot holder is displaced explicitly, and named as pre-existing.
    assert.equal((await w.db.assignments.findById(stray.id))!.status, 'cancelled');
    const strayEvent = events.find(
      (e) => e.eventType === 'assignment.cancelled' && e.resourceId === stray.id,
    )!;
    assert.equal(strayEvent.details?.wasBatonAssignment, false);
    assert.equal(strayEvent.details?.wasExecutionSlotHolder, true);
    assert.match(String(strayEvent.details?.reason), /displaced by Relay resume notice/i);
    assert.match(String(strayEvent.details?.reason), /already in the orphan state/i);

    // The invariant is restored even from a doubly-corrupt starting point.
    assert.deepEqual(await orphanedNonTerminalAssignments(w), []);
    assert.equal(await w.engine.reconcilePairAssignmentAuthority(w.pairId).then((r) => r.transitions.length), 0);
  });
});

/* ==================================================================== */
/* 4. The same invariant, second violating path: checkpoint continuation */
/* ==================================================================== */

describe('Execution slot vs. checkpoint continuation', () => {
  it('REFUSES to displace an unresolved slot holder instead of orphaning it', async () => {
    // `deliverCheckpointContinuation` hand-rolls its Attempt and Delivery rather than routing
    // through `dispatchAssignment`, so it has to consult the execution-slot authority itself.
    // It did not, and produced byte-for-byte the same contradiction as the resume notice:
    // the prior Assignment stayed `active` with its own Attempt while `active_assignment_id`
    // named the new one, and `reconcilePairAssignmentAuthority` then called the Pair corrupt.
    const w = await world();
    const holder = await w.engine.createAssignment(w.pairId, 'P1', 'instruction');
    await w.engine.dispatchAssignment(holder.id);
    assert.equal(await slotHolder(w), holder.id);

    const checkpoint = await w.engine.createPairCheckpoint(w.pairId, 'restore', { objective: 'continue' });

    await assert.rejects(
      async () => w.engine.deliverCheckpointContinuation(w.pairId, checkpoint.id),
      (err: any) => {
        assert.equal(err.code, 'PAIR_ACTIVE_ASSIGNMENT_EXISTS');
        assert.ok(err.message.includes(holder.id), 'the refusal names the Assignment that holds the slot');
        return true;
      },
      'the claim must be refused by the existing authority, not applied over a live holder',
    );

    // ---- NOTHING MOVED ----
    assert.equal(await slotHolder(w), holder.id, 'the slot is unchanged');
    const after = (await w.db.assignments.findById(holder.id))!;
    assert.equal(after.status, 'active', 'the holder is untouched, not cancelled');
    assert.equal((await w.db.attempts.findByAssignmentId(holder.id)).length, 1);
    assert.deepEqual(await orphanedNonTerminalAssignments(w), [], 'no orphan was created');

    // ---- The refusal leaves only legal backlog, and no Attempt at all ----
    const backlog = (await w.db.assignments.findByPairId(w.pairId)).find((a) => a.id !== holder.id)!;
    assert.equal(backlog.status, 'pending');
    assert.equal(backlog.currentAttemptId, undefined);
    assert.deepEqual(await w.db.attempts.findByAssignmentId(backlog.id), [], 'no Attempt was minted');
    assert.deepEqual(await w.db.deliveries.findByAssignmentId(backlog.id), [], 'nothing was sent');
    assert.equal(w.workerProvider.messages.filter((m) => m.role === 'user').length, 1, 'the session was written to once');

    // The model's own repair treats the leftover as superseded backlog, not as corruption.
    const repair = await w.engine.reconcilePairAssignmentAuthority(w.pairId);
    assert.equal(repair.adoptedAssignmentId, holder.id);
    assert.equal(repair.transitions.length, 1);
    assert.equal(repair.transitions[0]!.assignmentId, backlog.id);
    assert.equal(repair.transitions[0]!.to, 'cancelled');
    assert.equal((await w.db.assignments.findById(holder.id))!.status, 'active', 'the real holder survives');
  });

  it('claims the slot normally when no unresolved Assignment holds it', async () => {
    const w = await world();
    const checkpoint = await w.engine.createPairCheckpoint(w.pairId, 'fresh', { objective: 'start here' });

    const { assignment, attempt, delivery } = await w.engine.deliverCheckpointContinuation(
      w.pairId,
      checkpoint.id,
    );
    assert.equal(delivery.status, 'delivered');
    assert.equal(assignment.status, 'active');
    assert.equal(assignment.currentAttemptId, attempt.id);
    assert.equal(await slotHolder(w), assignment.id);
    assert.deepEqual(await orphanedNonTerminalAssignments(w), []);
  });

  it('a TERMINAL holder is released explicitly rather than refused, so a restore is never dead-ended', async () => {
    const w = await world();
    const holder = await w.engine.createAssignment(w.pairId, 'P1', 'instruction');
    await w.engine.dispatchAssignment(holder.id);
    await w.engine.completeAssignment(holder.id);

    // Re-point the slot at the completed Assignment: a stale ownership claim.
    const pair = (await w.db.pairs.findById(w.pairId))!;
    pair.activeAssignmentId = holder.id;
    await w.db.pairs.save(pair);

    const checkpoint = await w.engine.createPairCheckpoint(w.pairId, 'after', { objective: 'resume' });
    const { assignment, delivery } = await w.engine.deliverCheckpointContinuation(w.pairId, checkpoint.id);

    assert.equal(delivery.status, 'delivered', 'a terminal holder must not deadlock a restore');
    assert.equal(await slotHolder(w), assignment.id);
    assert.equal((await w.db.assignments.findById(holder.id))!.status, 'completed', 'and it is not mutated');
    const events = await w.db.events.findRecent(200);
    assert.ok(
      events.some((e) => e.eventType === 'pair.assignment_slot_released'),
      'the release is recorded, not silent',
    );
    assert.deepEqual(await orphanedNonTerminalAssignments(w), []);
  });
});