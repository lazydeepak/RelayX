/**
 * THE OBSERVATIONALLY-TERMINAL RUNTIME — a locally-derived state that permanently wedged the relay.
 * ============================================================================================
 *
 * ## The live defect this file reproduces
 *
 * The live Pair "RelayX Development" sat at:
 *
 *     decision: session_identity_unproven
 *     "The planner runtime is in the terminal 'terminated' state, so RelayX will not
 *      address its session."
 *
 * with the Planner holding the baton after a DELIVERED Worker -> Planner handoff, and the
 * runtime row carrying:
 *
 *     status = terminated
 *     consecutive_observation_failures = 3
 *     external_session_id = 6ac1362e-bc34-83ee-af03-2f52ee2b88af   (present, authoritative)
 *     session_url = https://chatgpt.com/g/g-p-.../c/6ac1362e-...    (present, authoritative)
 *
 * ## The causal chain, which is what these tests pin down
 *
 *   1. `RuntimeSession.recordObservationFailure()` escalates to `terminated` after 3 consecutive
 *      failures. Those failures come from `inspectRuntime` — AppleScript window/process
 *      enumeration. That measures RelayX's OBSERVATION CHANNEL, not the conversation.
 *   2. `resolveBatonSide()` refused on `status === 'terminated'` and returned
 *      `session_identity_unproven` BEFORE attempting any observation.
 *   3. The refusal was ABSORBING: nothing on the automated path (`runSupervisionTick`,
 *      `recoverOnStartup`) ever calls `inspectRuntime`, the only observation that could move a
 *      runtime out of `terminated`. So the state was a one-way door.
 *
 * The conversation was live throughout. These tests assert the corrected contract, and — just as
 * importantly — assert everything that must NOT change while fixing it.
 *
 * ## The invariants preserved here
 *
 *   - Never resend an `ambiguous` Delivery.
 *   - Never advance the baton from unproven evidence.
 *   - Never create a new Assignment to recover a relay.
 *   - Recovery is idempotent across repeated restarts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import type { AssignmentId, PairId, RuntimeSessionId } from '../src/relay/domain/types.ts';

interface Fx {
  db: SqliteRelayDatabase;
  engine: RelayEngine;
  pairId: PairId;
  plannerRuntimeId: RuntimeSessionId;
  workerRuntimeId: RuntimeSessionId;
  planner: MockProvider;
  worker: MockProvider;
}

/** The Planner's authoritative conversation id, shaped like a real ChatGPT one. */
const PLANNER_CONVERSATION = '6ac1362e-bc34-83ee-af03-2f52ee2b88af';

async function fixture(): Promise<Fx> {
  const db = new SqliteRelayDatabase(':memory:');
  const engine = new RelayEngine(db);
  const planner = new MockProvider('chatgpt');
  const worker = new MockProvider('opencode');
  engine.registerProvider(planner);
  engine.registerProvider(worker);

  const project = await engine.createProject('Terminal Runtime Project');
  const plannerRuntime = await engine.registerRuntimeSession('chatgpt', 'Planner');
  const workerRuntime = await engine.registerRuntimeSession('opencode', 'Worker');
  const pair = await engine.createPair(project.id, 'RelayX Development', plannerRuntime.id, workerRuntime.id);
  plannerRuntime.updateExternalIdentity(PLANNER_CONVERSATION, 'https://chatgpt.com/g/g-p-x/project');
  workerRuntime.updateExternalIdentity('ses_worker_1', '/dev/relayx');
  await db.runtimes.save(plannerRuntime);
  await db.runtimes.save(workerRuntime);
  await engine.loadAndActivate(pair.id);
  await engine.startPair(pair.id);

  return {
    db,
    engine,
    pairId: pair.id,
    plannerRuntimeId: plannerRuntime.id,
    workerRuntimeId: workerRuntime.id,
    planner,
    worker,
  };
}

/**
 * Drive the relay to the exact live shape: a DELIVERED Worker -> Planner handoff, so the
 * Planner holds the baton and the baton Delivery targets the Planner runtime.
 */
async function driveToPlannerBatonWithDelivery(f: Fx): Promise<{ deliveryId: string; assignmentId: AssignmentId }> {
  const assignment = await f.engine.createAssignment(f.pairId, 'Next Planner Iteration', 'Do the work');
  const { delivery } = await f.engine.dispatchAssignment(assignment.id);
  assert.equal(delivery.status, 'delivered');

  // The Worker completes; its turn is handed to the Planner and confirmed. This is the only
  // honest way to obtain a Worker -> Planner confirmed Delivery.
  f.worker.isWorking = false;
  f.worker.isComplete = true;
  const record = await f.engine.runSupervisionTick();
  assert.equal(record.batonDecisions[0]?.action.kind, 'handoff_created');

  const handOver = await f.engine.runSupervisionTick();
  assert.equal(handOver.batonDecisions[0]?.action.kind, 'handoff_advanced');
  assert.equal(handOver.batonDecisions[0]?.action.deliveryConfirmed, true);

  const baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
  assert.equal(baton.owner, 'planner', 'the Planner must hold the baton');
  assert.equal(baton.direction, 'worker_to_planner');

  return { deliveryId: baton.delivery!.id, assignmentId: baton.assignment!.id };
}

/** Drive the Planner runtime observationally to `terminated` — exactly as the live DB was. */
async function terminatePlannerObservationally(f: Fx): Promise<void> {
  const runtime = (await f.db.runtimes.findById(f.plannerRuntimeId))!;
  runtime.recordObservationFailure();
  runtime.recordObservationFailure();
  runtime.recordObservationFailure();
  assert.equal(runtime.status, 'terminated');
  assert.equal(runtime.consecutiveObservationFailures, 3);
  // The authoritative conversation identity survives the observation failure — this is the
  // whole point: losing sight of a window is not losing the conversation.
  assert.equal(runtime.externalSessionId, PLANNER_CONVERSATION);
  await f.db.runtimes.save(runtime);
}

describe('a locally-derived terminal state must not permanently wedge the relay', () => {
  it('REGRESSION: reproduces the live blocker exactly — terminated planner, delivered handoff', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);
    await terminatePlannerObservationally(f);

    const report = await f.engine.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });

    assert.notEqual(
      report.decision,
      'session_identity_unproven',
      'a runtime that failed three local probes must not be treated as a dead conversation',
    );
    assert.ok(
      report.relayDecisionTrail.some((line) => /terminal state, but the provider/.test(line)),
      `the decision trail must record the authoritative re-address, got: ${JSON.stringify(
        report.relayDecisionTrail,
      )}`,
    );

    const runtime = (await f.db.runtimes.findById(f.plannerRuntimeId))!;
    assert.notEqual(runtime.status, 'terminated', 'the runtime must be revived on that evidence');
    assert.equal(runtime.consecutiveObservationFailures, 0);
  });

  it('revives the runtime ONLY from authoritative evidence, and records that evidence', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);
    await terminatePlannerObservationally(f);

    await f.engine.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });

    const runtime = (await f.db.runtimes.findById(f.plannerRuntimeId))!;
    assert.notEqual(runtime.status, 'terminated');
    assert.ok(runtime.lastObservedAt, 'a revival is an observation and must be timestamped');

    const events = await f.db.events.findByResourceId(runtime.id);
    const revived = events.filter((e) => e.eventType === 'runtime.revived');
    assert.equal(revived.length, 1, 'the revival must be a durable, auditable transition');
    assert.equal(revived[0]!.previousState, 'terminated');
  });

  it('continues the EXISTING assignment and handoff lifecycle — no new work, no resend', async () => {
    const f = await fixture();
    const before = await driveToPlannerBatonWithDelivery(f);
    await terminatePlannerObservationally(f);

    const assignmentsBefore = await f.db.assignments.findByPairId(f.pairId);
    const deliveriesBefore = (await f.db.deliveries.findByAssignmentId(before.assignmentId)).length;

    const report = await f.engine.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });

    const assignmentsAfter = await f.db.assignments.findByPairId(f.pairId);

    // The ORIGINAL work Assignment is untouched — recovery never clones or replaces it.
    const original = assignmentsAfter.find((a) => a.id === before.assignmentId)!;
    assert.ok(original, 'the existing Assignment must still exist');
    assert.equal(original.title, assignmentsBefore.find((a) => a.id === before.assignmentId)!.title);

    // Its Delivery is NOT resent: exactly as many as before.
    assert.equal(
      (await f.db.deliveries.findByAssignmentId(before.assignmentId)).length,
      deliveriesBefore,
      'recovering a relay must never resend the baton Delivery',
    );

    // If anything new was created, it must be the ESTABLISHED recovery continuation, keyed to
    // this episode's Delivery — not an ad-hoc Assignment invented to recover the relay. The
    // unique index on `source_recovery_delivery_id` makes that structurally once-per-episode.
    const created = assignmentsAfter.filter((a) => !assignmentsBefore.some((b) => b.id === a.id));
    for (const a of created) {
      assert.equal(
        a.sourceRecoveryDeliveryId,
        before.deliveryId,
        `unexpected Assignment ${a.id} created during recovery: it is not keyed to the baton episode`,
      );
    }
    assert.ok(
      created.length <= 1,
      `at most one recovery continuation per episode, got ${created.length}`,
    );

    // And that continuation is itself idempotent.
    const second = await f.engine.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });
    const assignmentsAfterSecond = await f.db.assignments.findByPairId(f.pairId);
    assert.equal(
      assignmentsAfterSecond.length,
      assignmentsAfter.length,
      'a second evaluation must not create a further Assignment for the same episode',
    );
    assert.ok(
      ['recovery_notice_already_issued', 'recovery_notice_unresolved', 'awaiting_unresolved_delivery'].includes(
        second.decision,
      ) || second.action.kind === 'recovery_notice_redispatched',
      `the second evaluation must not re-prompt: got ${second.decision}`,
    );
  });

  it('never advances the baton from unproven evidence', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);
    await terminatePlannerObservationally(f);

    const report = await f.engine.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });

    // The Planner transcript IS readable now (the side is addressable again), but it has no
    // completed turn after the recorded boundary. The honest outcome is a recovery notice sent
    // to the Planner asking for the missing turn — NOT a fabricated completion, and NOT a
    // hand-over of a turn RelayX never observed.
    assert.notEqual(report.decision, 'session_identity_unproven');
    assert.equal(report.decision, 'send_recovery_notice');
    assert.equal(report.action.kind, 'recovery_notice_issued');
    assert.equal(report.observation?.transcriptReadable, true);

    // The baton is still the SAME confirmed Delivery. Recovery did not re-derive it from a
    // fabricated turn, and it did not create work out of thin air.
    const baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(baton.owner, 'planner');
    assert.equal(baton.direction, 'worker_to_planner');
  });

  it('IDEMPOTENT: repeated restarts converge, and never duplicate the revival', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);
    await terminatePlannerObservationally(f);

    // Five "restarts": each a brand-new engine over the same durable state.
    for (let i = 0; i < 5; i += 1) {
      const restarted = new RelayEngine(f.db);
      restarted.registerProvider(f.planner);
      restarted.registerProvider(f.worker);
      const report = await restarted.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });
      assert.notEqual(report.decision, 'session_identity_unproven', `restart ${i} regressed`);
    }

    const runtime = (await f.db.runtimes.findById(f.plannerRuntimeId))!;
    assert.notEqual(runtime.status, 'terminated');

    const revived = (await f.db.events.findByResourceId(runtime.id)).filter(
      (e) => e.eventType === 'runtime.revived',
    );
    assert.equal(
      revived.length,
      1,
      `the revival must be recorded exactly once across restarts, got ${revived.length}`,
    );

    const assignments = await f.db.assignments.findByPairId(f.pairId);
    const baton = await f.engine.derivePairBaton((await f.db.pairs.findById(f.pairId))!);
    assert.equal(
      assignments.filter((a) => a.id === baton.assignment!.id).length,
      1,
      'no duplicate Assignment may appear',
    );
  });

  it('refuses when the provider positively reports the conversation is GONE', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);
    await terminatePlannerObservationally(f);
    f.planner.deadConversations = [PLANNER_CONVERSATION];

    const report = await f.engine.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });

    assert.equal(report.decision, 'session_identity_unproven');
    assert.match(report.reason, /no longer exists/i);
    assert.match(report.reason, /PairCheckpoint|runtime replacement/i);

    const runtime = (await f.db.runtimes.findById(f.plannerRuntimeId))!;
    assert.equal(runtime.status, 'terminated', 'a genuinely gone conversation must NOT be revived');
  });

  it('refuses WITHOUT concluding the conversation died when the provider cannot check', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);
    await terminatePlannerObservationally(f);
    f.planner.reachabilityFailure = 'AppleScript access to Chrome is not permitted.';

    const report = await f.engine.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });

    assert.equal(report.decision, 'session_identity_unproven');
    assert.match(
      report.reason,
      /could not establish whether/i,
      '"could not check" must never be reported as "checked and found gone"',
    );
    assert.doesNotMatch(report.reason, /no longer exists/i);

    const runtime = (await f.db.runtimes.findById(f.plannerRuntimeId))!;
    assert.equal(runtime.status, 'terminated', 'no evidence means no revival');
  });

  it('a provider WITHOUT the reachability capability is a capability gap, not a dead session', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);
    await terminatePlannerObservationally(f);
    // Remove the capability entirely (LEVEL 0).
    (f.planner as any).confirmExactSessionReachable = undefined;

    const report = await f.engine.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });

    assert.equal(report.decision, 'session_identity_unproven');
    assert.match(report.reason, /no exact-conversation reachability check/i);
    assert.doesNotMatch(report.reason, /no longer exists/i);
  });
});

describe('terminal runtime state is not a proxy for a dead conversation', () => {
  it('revival is refused without observable evidence — the invariant is structural', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    const runtime = await engine.registerRuntimeSession('chatgpt', 'Planner');
    runtime.recordObservationFailure();
    runtime.recordObservationFailure();
    runtime.recordObservationFailure();
    assert.equal(runtime.status, 'terminated');

    assert.throws(
      () => (runtime as any).recordExternalRevival('available', undefined),
      /without observable evidence/i,
      'a terminal runtime must not be revivable on a fabricated positive',
    );
    assert.equal(runtime.status, 'terminated', 'the failed revival must change nothing');
  });

  it('a runtime with no conversation id is refused before any reachability question', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);
    const runtime = (await f.db.runtimes.findById(f.plannerRuntimeId))!;
    runtime.externalSessionId = null;
    runtime.recordObservationFailure();
    runtime.recordObservationFailure();
    runtime.recordObservationFailure();
    await f.db.runtimes.save(runtime);

    const report = await f.engine.resumeRelayContinuity(f.pairId, { context: 'AUTOMATED' });
    assert.equal(report.decision, 'session_identity_unproven');
    assert.match(report.reason, /no external session id/i);
  });
});

describe('dispatch reconciliation is no longer blocked by a local terminal state', () => {
  it('an ambiguous intent targeting a terminally-observed runtime is probed, not silently skipped', async () => {
    const f = await fixture();
    f.worker.deliveryOutcome = 'ambiguous';
    const assignment = await f.engine.createAssignment(f.pairId, 'Work', 'Do the work');
    const { delivery } = await f.engine.dispatchAssignment(assignment.id);
    assert.equal(delivery.status, 'ambiguous', 'the mock is configured to be ambiguous here');

    const worker = (await f.db.runtimes.findById(f.workerRuntimeId))!;
    worker.recordObservationFailure();
    worker.recordObservationFailure();
    worker.recordObservationFailure();
    assert.equal(worker.status, 'terminated');
    await f.db.runtimes.save(worker);

    const report = await f.engine.reconcileUnresolvedDispatches({ context: 'AUTOMATED' });

    assert.equal(report.examined, 1, 'the intent must actually be re-examined');
    assert.equal(
      (await f.db.deliveries.findById(delivery.id))!.status,
      'ambiguous',
      'it must still not be resolved without evidence',
    );

    const disposition = report.dispositions[0]!;
    assert.equal(disposition.disposition, 'ambiguous_raised');
  });

  it('re-examinations that change nothing write NO durable event (idempotent across restarts)', async () => {
    const f = await fixture();
    const assignment = await f.engine.createAssignment(f.pairId, 'Work', 'Do the work');
    const { delivery } = await f.engine.dispatchAssignment(assignment.id);
    f.worker.deliveryOutcome = 'ambiguous';

    await f.engine.reconcileUnresolvedDispatches({ context: 'AUTOMATED' });
    const first = (await f.db.events.findByResourceId(delivery.id)).length;

    // Many further passes — the supervision loop does exactly this on a fixed interval.
    for (let i = 0; i < 10; i += 1) {
      await f.engine.reconcileUnresolvedDispatches({ context: 'AUTOMATED' });
    }
    const after = (await f.db.events.findByResourceId(delivery.id)).length;

    assert.equal(
      after,
      first,
      'ten unchanged re-examinations must not append ten rows to the durable event stream',
    );

    const open = await f.db.attention.findOpen();
    const ambiguousItems = open.filter(
      (i) => i.type === 'ambiguous_delivery' && i.assignmentId === assignment.id,
    );
    assert.ok(
      ambiguousItems.length <= 1,
      `repeated unchanged re-examinations must never duplicate the operator-visible attention item, got ${ambiguousItems.length}`,
    );
  });
});

/**
 * AN UNREADABLE TRANSCRIPT MUST NEVER BECOME A DEAD CONVERSATION.
 * ==========================================================================
 *
 * This is where the live `terminated` state was actually manufactured.
 *
 * On the live Pair the Planner runtime reached `consecutive_observation_failures = 3` NOT because
 * `inspectRuntime` was failing, but because `observeBatonOwner` could not PARSE ChatGPT's
 * transcript, and that parse failure was recorded with `recordObservationFailure()` — the same
 * counter that means "the process is gone". Three unreadable ticks produced a terminal belief
 * about a conversation that was open, titled "Planner session ready", and perfectly reachable.
 *
 * ChatGPT's transcript is unreadable for a structural reason that will not change: history is
 * virtualized behind a "Loading older messages…" control and the rendered turns carry no stable
 * per-turn ids. So the supervision path hits this branch on EVERY tick, forever. Before the fix
 * that meant terminate/revive/terminate every 15 seconds — churning the durable event stream with
 * a runtime lifecycle event each cycle.
 *
 * The contract asserted here: unreadable transcript -> `suspended`, count it, keep it visible, and
 * NEVER reach `terminated`. Liveness belief is not something a parser failure may move.
 */
describe('an unreadable transcript is not a dead conversation', () => {
  it('many unreadable supervision ticks suspend but NEVER terminate the runtime', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);

    // Structural unreadability: the conversation is reachable, its transcript is not parseable.
    f.planner.transcriptReadable = false;
    f.planner.transcriptFailure = 'no stable per-turn ids in the rendered transcript';

    for (let i = 0; i < 25; i += 1) {
      await f.engine.runSupervisionTick();
    }

    const runtime = (await f.db.runtimes.findById(f.plannerRuntimeId))!;
    assert.notEqual(
      runtime.status,
      'terminated',
      'an unparseable transcript must never manufacture a terminal belief about a live conversation',
    );
    assert.equal(runtime.status, 'suspended', 'it must still be visible as not-currently-readable');
    assert.equal(
      runtime.externalSessionId,
      PLANNER_CONVERSATION,
      'and the authoritative identity must be untouched throughout',
    );
  });

  it('the unreadable side stays VISIBLE — an operator is still told', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);
    f.planner.transcriptReadable = false;

    await f.engine.runSupervisionTick();

    const open = await f.db.attention.findOpen();
    assert.ok(
      open.some((i) => i.type === 'runtime_suspended'),
      'losing terminal escalation must not make an unreadable side silent',
    );

    const events = await f.db.events.findByResourceId(f.plannerRuntimeId);
    assert.ok(
      events.some((e) => e.eventType === 'runtime.suspended'),
      'the transition must remain a durable, auditable event',
    );
  });

  it('does not churn a revival loop — one unreachable side does not oscillate the runtime', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);
    f.planner.transcriptReadable = false;

    for (let i = 0; i < 30; i += 1) {
      await f.engine.runSupervisionTick();
    }

    const events = await f.db.events.findByResourceId(f.plannerRuntimeId);
    const revivals = events.filter((e) => e.eventType === 'runtime.revived');
    assert.equal(
      revivals.length,
      0,
      `a conversation that is reachable but unparseable must not oscillate available/terminated; saw ${revivals.length} revivals`,
    );
  });

  it('repeated unreadability yields ONE operator task, not one per tick', async () => {
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);
    f.planner.transcriptReadable = false;

    for (let i = 0; i < 25; i += 1) {
      await f.engine.runSupervisionTick();
    }

    const suspended = (await f.db.attention.findOpen()).filter((i) => i.type === 'runtime_suspended');
    assert.equal(
      suspended.length,
      1,
      `"not currently readable" is one fact about one runtime; 25 ticks must not become 25 operator tasks (got ${suspended.length})`,
    );
    assert.ok(
      suspended[0]!.title.includes('Planner'),
      `the task must name the side that is actually unreadable, not always "Worker": ${suspended[0]!.title}`,
    );
    assert.ok(
      suspended[0]!.title.includes(f.plannerRuntimeId),
      `the task must be keyed to the exact runtime: both runtimes of this pair are named ` +
        `"RelayX Development", so a name-only key cannot tell the two sides apart (title: ${suspended[0]!.title})`,
    );
  });

  it('a healthy side reading cleanly must NOT resolve the OTHER side open task', async () => {
    // Both runtimes in this pair are named "RelayX Development" — that is the live Pair's actual
    // configuration, not a fixture quirk. A dedupe/resolution key built from the name alone
    // therefore cannot distinguish the Planner's unreadable transcript from the Worker's, and a
    // successful Worker read would silence the Planner's open operator task.
    const f = await fixture();
    await driveToPlannerBatonWithDelivery(f);

    f.planner.transcriptReadable = false;
    await f.engine.runSupervisionTick();

    const openAfterPlannerFailure = (await f.db.attention.findOpen()).filter(
      (i) => i.type === 'runtime_suspended',
    );
    assert.equal(openAfterPlannerFailure.length, 1, 'the Planner task must exist to be protected');

    // Now the Planner reads cleanly again. A suspended runtime backs off for 30s before it is
    // re-probed, so the confirming read is scheduled rather than immediate — that backoff is
    // correct behaviour and is not what this test is about.
    f.planner.transcriptReadable = true;
    for (let i = 0; i < 3; i += 1) {
      const runtime = (await f.db.runtimes.findById(f.plannerRuntimeId))!;
      runtime.lastObservedAt = Date.now() - 31000;
      await f.db.runtimes.save(runtime);
      await f.engine.runSupervisionTick();
    }

    const stillOpen = (await f.db.attention.findOpen()).filter((i) => i.type === 'runtime_suspended');
    assert.equal(
      stillOpen.length,
      0,
      'the Planner being readable again must resolve exactly its own task',
    );
  });
});

/**
 * THE SAME FAILURE MODE, ONE LAYER DOWN: the probe must work in the SHIPPED artifact.
 * =====================================================================================
 *
 * Reviving a terminal runtime is only possible if the provider probe actually executes. On the
 * live Pair, the first run of the fixed code reported:
 *
 *     "Could not enumerate Chrome tabs: The argument 'filename' must be a file URL object,
 *      file URL string, or absolute path string. Received undefined."
 *
 * which is `createRequire(undefined)`. The code had resolved `child_process` via
 * `createRequire(import.meta.url)` to repair a bare-`require` bug in ESM source mode — but the
 * Electron main process runs the esbuild **CommonJS** bundle, where `import.meta` does not exist
 * and esbuild substitutes `{}`. So the repair that fixed source mode silently disabled EVERY
 * AppleScript probe in the shipped app.
 *
 * That failure is doubly dangerous because it is invisible: the probe returns
 * `{ success: false }`, the safety path reports "could not check" (correctly refusing to conclude
 * the conversation was dead), and the relay simply stays put with no error anywhere. A green test
 * suite running under `tsx` cannot see it, because `tsx` runs the ESM source where the broken form
 * works.
 *
 * So this test bundles the adapter the way the app is actually shipped and executes the probe
 * through the bundle. It is the only assertion in this file that observes the artifact rather than
 * the source.
 */
describe('the AppleScript probe survives the shipped CommonJS bundle', () => {
  it('runAppleScript really executes osascript when loaded from an esbuild CJS bundle', async (t) => {
    if (process.platform !== 'darwin') {
      t.skip('AppleScript only exists on macOS');
      return;
    }

    const { build } = await import('esbuild');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');

    // Bundled INSIDE the project so that `packages: 'external'` still resolves against this
    // repo's node_modules. A bundle written to the OS temp dir cannot resolve its own
    // dependencies, which would fail for reasons unrelated to what this test is about.
    const dir = mkdtempSync(join(process.cwd(), 'node_modules', '.cjs-probe-'));
    const outfile = join(dir, 'adapters.cjs');
    try {
      await build({
        entryPoints: [new URL('../src/relay/providers/adapters.ts', import.meta.url).pathname],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        packages: 'external',
        outfile,
        logLevel: 'silent',
      });

      const mod = await import(pathToFileURL(outfile).href);
      const BaseProvider = mod.BaseRuntimeProvider ?? Object.values(mod).find((v: any) => typeof v === 'function' && typeof v.prototype?.runAppleScript === 'function');
      assert.ok(BaseProvider, 'the bundle must export a class carrying runAppleScript');

      const probe = new (BaseProvider as any)();
      const result = probe.runAppleScript('return "relayx-applescript-alive"', 5000);

      assert.equal(
        result.error,
        undefined,
        `the probe must not fail in the shipped bundle format: ${result.error}`,
      );
      assert.equal(result.success, true);
      assert.equal(result.output, 'relayx-applescript-alive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no bare require() may sit on the AppleScript probe path', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(new URL('../src/relay/providers/adapters.ts', import.meta.url), 'utf8');

    // Comments are stripped first: this file's own documentation NAMES both banned forms in
    // order to explain why they are banned, and a scanner that cannot tell prose from code
    // would simply be disabled by the explanation.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    // `createRequire(import.meta.url)` is banned outright: it is correct under tsx/ESM and
    // undefined under the CJS bundle the app ships, so it trades one silent failure for another.
    assert.ok(
      !/createRequire\s*\(\s*import\.meta\.url\s*\)/.test(code),
      'createRequire(import.meta.url) throws in the shipped CommonJS bundle; use a static import',
    );

    const probeBody = code.slice(
      code.indexOf('public runAppleScript('),
      code.indexOf('protected probeMacOSProcess('),
    );
    assert.ok(probeBody.length > 0, 'the probe body must be locatable for this guard to mean anything');
    assert.ok(
      !/(?<![.\w])require\s*\(/.test(probeBody),
      'runAppleScript must not call a bare require(); resolve child_process with a static import',
    );
  });
});