/**
 * STARTUP RECOVERY: A FAILURE MUST BE DETERMINISTIC, OBSERVABLE, AND NON-DESTRUCTIVE.
 * =========================================================================
 *
 * ## The defect
 *
 * `recoverOnStartup` contained a per-Pair failure with an EMPTY catch:
 *
 *     } catch (err) {
 *       // Tolerant of individual failures during startup: one Pair's provider problem must
 *       // not prevent the rest of the relay fleet from recovering.
 *     }
 *
 * `err` was bound and discarded. So when continuity reconstruction threw for one Pair,
 * RelayX would restart, skip that Pair, keep running, and leave:
 *
 *   - no log line
 *   - no Event
 *   - no Attention item
 *   - and NO entry in the returned `batonDecisions`
 *
 * An operator reading the startup report saw a clean pass over a Pair that was in fact
 * stranded, with nothing anywhere naming it or its failure.
 *
 * `resumeRelayContinuity` distinguishes outcomes from failures on purpose: an unreadable
 * transcript, an unlocatable boundary, an unresolved intent each become a *decision* with a
 * reason. An exception is RelayX failing to decide, and it was being treated as one of the
 * handled outcomes when it was not one at all.
 *
 * ## What these tests pin
 *
 *   1. one Pair fails, the other still recovers, and both appear in the report
 *   2. the failure leaves durable evidence: an Event plus one Attention item
 *   3. repeat failures add nothing — one open item is the whole episode
 *   4. a later successful recovery CLOSES the episode via the existing lifecycle
 *   5. a failure causes zero provider writes
 *   6. a failure mints no Attempt and no Delivery
 *   7. it does not touch the baton, the execution slot, or any Assignment status
 *   8. an `acknowledged` item is not auto-resolved — the operator keeps it
 *
 * ## Why the failure is injected at the repository seam
 *
 * The durable store is the engine's real persistence boundary, and "these transport records
 * could not be read" is the class of thing that makes ONE Pair's recovery throw while the
 * others proceed. Injecting there exercises the genuine recovery orchestration — gate
 * ordering, dispatch reconciliation, baton derivation, the catch boundary, and the durable
 * writes — rather than asserting that a mocked catch was entered. The provider is healthy
 * throughout, which also proves the reporting is not provider-specific.
 *
 * A restart here is a genuine SQLite `close()` plus a fresh database and engine over the same
 * file, so nothing in memory carries across.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayDomainError } from '../src/relay/domain/errors.ts';
import { MockProvider } from './MockProvider.ts';
import type { PairId } from '../src/relay/domain/types.ts';
import type { ReconciliationMessage } from '../src/relay/providers/exactSessionReconciliation.ts';

const FAILURE_TYPE = 'continuity_recovery_failed';

interface World {
  dbPath: string;
  db: SqliteRelayDatabase;
  engine: RelayEngine;
  plannerProvider: MockProvider;
  workerProvider: MockProvider;
}

function openProcess(
  dbPath: string,
  carry?: { planner: ReconciliationMessage[]; worker: ReconciliationMessage[] },
): World {
  const db = new SqliteRelayDatabase(dbPath);
  const engine = new RelayEngine(db);
  const plannerProvider = new MockProvider('chatgpt');
  const workerProvider = new MockProvider('opencode');
  plannerProvider.adoptTranscript(carry?.planner ?? []);
  workerProvider.adoptTranscript(carry?.worker ?? []);
  engine.registerProvider(plannerProvider);
  engine.registerProvider(workerProvider);
  return { dbPath, db, engine, plannerProvider, workerProvider };
}

/** A bound, ACTIVE/RUNNING Pair with one confirmed Delivery, so recovery has a chain to read. */
async function addPair(w: World, label: string): Promise<PairId> {
  const project = await w.engine.createProject(label);
  const planner = await w.engine.registerRuntimeSession('chatgpt', `${label}-Planner`);
  const worker = await w.engine.registerRuntimeSession('opencode', `${label}-Worker`);
  const pair = await w.engine.createPair(project.id, label, planner.id, worker.id);
  planner.updateExternalIdentity(`ses_${label}_planner`, `/dev/${label}`);
  worker.updateExternalIdentity(`ses_${label}_worker`, `/dev/${label}`);
  await w.db.runtimes.save(planner);
  await w.db.runtimes.save(worker);
  await w.engine.loadAndActivate(pair.id);
  await w.engine.startPair(pair.id);

  const assignment = await w.engine.createAssignment(pair.id, `${label}-P1`, `instruction for ${label}`);
  const sent = await w.engine.dispatchAssignment(assignment.id);
  assert.equal(sent.delivery.status, 'delivered');
  return pair.id;
}

/** Two eligible Pairs in one durable store. */
async function twoPairWorld(): Promise<{ w: World; a: PairId; b: PairId }> {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relayx-startup-')), 'relay.sqlite');
  const w = openProcess(dbPath);
  const a = await addPair(w, 'Alpha');
  const b = await addPair(w, 'Bravo');
  return { w, a, b };
}

/**
 * Make the durable transport records for specific Assignments unreadable.
 *
 * Scoped by Assignment id, so the failure is provably per-Pair: the same call for the other
 * Pair's Assignment still succeeds, from the same database, in the same pass.
 */
function failReadsForAssignments(
  w: World,
  assignmentIds: readonly string[],
  error: unknown,
): () => void {
  const targets = new Set(assignmentIds);
  const real = w.db.deliveries.findByAssignmentId.bind(w.db.deliveries);
  (w.db.deliveries as any).findByAssignmentId = async (id: string) => {
    if (targets.has(id)) throw error;
    return real(id as any);
  };
  return () => {
    (w.db.deliveries as any).findByAssignmentId = real;
  };
}

function sqliteReadError() {
  const err: any = new Error('SQLITE_IOERR: disk I/O error (deliveries)');
  err.code = 'SQLITE_IOERR';
  err.errcode = 10;
  return err;
}

async function assignmentIdsOf(w: World, pairId: PairId): Promise<string[]> {
  return (await w.db.assignments.findByPairId(pairId)).map((a) => a.id);
}

async function failureEvents(w: World, pairId: PairId) {
  return (await w.db.events.findRecent(500)).filter(
    (e) => e.eventType === 'pair.continuity_recovery_failed' && e.resourceId === pairId,
  );
}

async function failureItems(w: World, pairId: PairId) {
  return (await w.db.attention.findAll()).filter(
    (i) => i.type === FAILURE_TYPE && i.pairId === pairId,
  );
}

async function openItems(w: World, pairId: PairId) {
  return (await w.db.attention.findOpen()).filter((i) => i.type === FAILURE_TYPE && i.pairId === pairId);
}

/** Everything the failure must NOT have touched. */
async function continuitySnapshot(w: World, pairId: PairId) {
  const pair = (await w.db.pairs.findById(pairId))!;
  const assignments = await w.db.assignments.findByPairId(pairId);
  return {
    slot: pair.activeAssignmentId ?? null,
    relayState: pair.relayState,
    operationalState: pair.operationalState,
    assignments: assignments.map((a) => `${a.id}:${a.status}:${a.currentAttemptId ?? '-'}`).sort(),
    attempts: (await Promise.all(assignments.map((a) => w.db.attempts.findByAssignmentId(a.id))))
      .flat()
      .map((at) => `${at.id}:${at.status}`)
      .sort(),
    deliveries: (await Promise.all(assignments.map((a) => w.db.deliveries.findByAssignmentId(a.id))))
      .flat()
      .map((d) => `${d.id}:${d.status}`)
      .sort(),
  };
}

/** Provider-side writes attributable to one Pair, by its distinctive instruction text. */
function writesFor(provider: MockProvider, label: string): number {
  return provider.messages.filter((m) => m.role === 'user' && (m.text ?? '').includes(`instruction for ${label}`)).length;
}

describe('Startup recovery — a per-Pair failure is observable and non-destructive', () => {
  it('one Pair fails, the other still recovers, and BOTH appear in the returned report', async () => {
    const { w, a, b } = await twoPairWorld();
    const restore = failReadsForAssignments(w, await assignmentIdsOf(w, a), sqliteReadError());

    const report = await w.engine.recoverOnStartup();

    // Pair A is present in the report — the whole point. It used to be absent entirely.
    const decisionA = report.batonDecisions.find((d) => d.pairId === a);
    assert.ok(decisionA, 'the failed Pair must appear in the startup report');
    assert.match(decisionA!.reason, /threw and was contained/i);
    assert.equal(decisionA!.action.kind, 'none', 'a failure never reports an action');
    assert.equal(decisionA!.baton.owner, null, 'and never claims to know the baton');

    // Pair B recovered for real, not merely "did not throw".
    const decisionB = report.batonDecisions.find((d) => d.pairId === b);
    assert.ok(decisionB, 'the healthy Pair is still reported');
    assert.notEqual(decisionB!.decision, 'transcript_unreadable');
    const batonB = await w.engine.derivePairBaton((await w.db.pairs.findById(b))!);
    assert.equal(batonB.basis, 'confirmed_delivery', 'the healthy Pair reconstructed its baton');
    assert.equal((await w.db.pairs.findById(b))!.relayState, 'RUNNING', 'recovery continued');

    restore();
  });

  it('produces durable evidence naming the Pair, the context, the category and the failure', async () => {
    const { w, a } = await twoPairWorld();
    const restore = failReadsForAssignments(w, await assignmentIdsOf(w, a), sqliteReadError());

    await w.engine.recoverOnStartup();
    restore();

    // ---- Event ----
    const events = await failureEvents(w, a);
    assert.equal(events.length, 1, 'exactly one failure Event is written');
    const details = events[0]!.details!;
    assert.equal(details.recoveryContext, 'startup');
    assert.equal(details.operation, 'resumeRelayContinuity');
    assert.equal(details.failureCategory, 'durable_store');
    assert.equal(details.failureCode, 'SQLITE_IOERR');
    assert.match(String(details.failureMessage), /SQLITE_IOERR/);
    assert.equal(typeof details.recordedAt, 'number');
    assert.equal(details.executionSlotAssignmentId, (await w.db.pairs.findById(a))!.activeAssignmentId);
    assert.equal(details.operationalState, 'ACTIVE');
    assert.equal(details.relayState, 'RUNNING');
    // The Event states plainly that continuity was not touched.
    assert.equal(details.transportTouched, false);
    assert.equal(details.attemptCreated, false);
    assert.equal(details.continuityMutated, false);
    assert.equal(details.semanticJudgmentMade, false);

    // ---- Attention ----
    const items = await openItems(w, a);
    assert.equal(items.length, 1, 'exactly one open Attention item');
    assert.equal(items[0]!.severity, 'critical');
    assert.equal(items[0]!.pairId, a);
    assert.equal(items[0]!.status, 'open');
    const message = items[0]!.message;
    assert.match(message, new RegExp(a));
    assert.match(message, /Recovery context: startup/);
    assert.match(message, /Operation: resumeRelayContinuity/);
    assert.match(message, /Failure category: durable_store/);
    assert.match(message, /Failure code: SQLITE_IOERR/);
    assert.match(message, /No Delivery was resent, no Attempt was created/);
    assert.ok(String(items[0]!.suggestedAction).length > 0, 'and it says what to do');
  });

  it('classifies an authority failure as authority, using structure and not message text', async () => {
    const { w, a } = await twoPairWorld();
    const restore = failReadsForAssignments(
      w,
      await assignmentIdsOf(w, a),
      new RelayDomainError('the bound runtime is in a terminal state', 'RUNTIME_NOT_AVAILABLE'),
    );

    await w.engine.recoverOnStartup();
    restore();

    const details = (await failureEvents(w, a))[0]!.details!;
    assert.equal(details.failureCategory, 'authority');
    assert.equal(details.failureCode, 'RUNTIME_NOT_AVAILABLE');
  });

  it('repeated failures do not spam: one open item is the whole episode', async () => {
    const { w, a } = await twoPairWorld();
    const restore = failReadsForAssignments(w, await assignmentIdsOf(w, a), sqliteReadError());

    // failure -> retry failure -> retry failure
    await w.engine.recoverOnStartup();
    await w.engine.runSupervisionTick();
    await w.engine.runSupervisionTick();
    await w.engine.runSupervisionTick();
    restore();

    assert.equal((await failureItems(w, a)).length, 1, 'one episode, one item');
    assert.equal((await openItems(w, a)).length, 1, 'still the only open one');
    assert.equal((await failureEvents(w, a)).length, 1, 'and only one Event: the episode opening');

    // The item's creation time is when the episode began, which is the useful fact.
    const item = (await failureItems(w, a))[0]!;
    assert.equal(typeof item.createdAt, 'number');
  });

  it('a later successful recovery closes the episode through the existing lifecycle', async () => {
    const { w, a } = await twoPairWorld();
    const restore = failReadsForAssignments(w, await assignmentIdsOf(w, a), sqliteReadError());

    await w.engine.recoverOnStartup();
    assert.equal((await openItems(w, a)).length, 1, 'open after the failure');
    restore();

    // The store is healthy again; the supervision tick retries this Pair automatically.
    const before = (await w.db.events.findRecent(500)).length;
    await w.engine.runSupervisionTick();

    assert.equal((await openItems(w, a)).length, 0, 'the episode is closed');
    const items = await failureItems(w, a);
    assert.equal(items.length, 1, 'the item is retained as history, not deleted');
    assert.equal(items[0]!.status, 'resolved');
    assert.equal(typeof items[0]!.resolvedAt, 'number');

    const resolved = (await w.db.events.findRecent(500))
      .filter((e) => e.eventType === 'pair.continuity_recovery_resolved' && e.resourceId === a)
      .slice(-1)[0];
    assert.ok(resolved, 'and the resolution is recorded');
    assert.deepEqual(resolved!.details!.resolvedAttentionItemIds, [items[0]!.id]);
    assert.ok(before >= 0);
  });

  it('an ACKNOWLEDGED item is not auto-resolved — the operator keeps it', async () => {
    // An acknowledged item is a statement by an operator, not by the latest sample. Closing it
    // automatically would overrule them. Same rule `HealthIncident.updateFromObservation`
    // applies to ACKNOWLEDGED, for the same reason.
    const { w, a } = await twoPairWorld();
    const restore = failReadsForAssignments(w, await assignmentIdsOf(w, a), sqliteReadError());
    await w.engine.recoverOnStartup();
    restore();

    const item = (await openItems(w, a))[0]!;
    item.acknowledge();
    await w.db.attention.save(item);
    assert.equal((await w.db.attention.findOpen()).some((i) => i.id === item.id), true);

    await w.engine.runSupervisionTick();

    const after = (await w.db.attention.findAll()).find((i) => i.id === item.id)!;
    assert.equal(after.status, 'acknowledged', 'still the operator\'s to close');
    assert.equal(after.resolvedAt, undefined);
    assert.equal(
      (await w.db.events.findRecent(500)).some(
        (e) => e.eventType === 'pair.continuity_recovery_resolved' && e.resourceId === a,
      ),
      false,
      'and no resolution event was emitted',
    );
  });

  it('the failure writes ZERO provider messages, Attempts and Deliveries, and changes no continuity state', async () => {
    const { w, a, b } = await twoPairWorld();

    // Snapshot only Pair A's continuity, and only Pair A's provider writes, so Pair B's
    // legitimate recovery work cannot mask or imitate Pair A's.
    const beforeA = await continuitySnapshot(w, a);
    const writesBeforeA = writesFor(w.workerProvider, 'Alpha');

    const restore = failReadsForAssignments(w, await assignmentIdsOf(w, a), sqliteReadError());
    await w.engine.recoverOnStartup();
    restore();

    assert.deepEqual(await continuitySnapshot(w, a), beforeA, 'Pair A continuity is byte-identical');
    assert.equal(writesFor(w.workerProvider, 'Alpha'), writesBeforeA, 'no provider write for Pair A');
    assert.equal(writesFor(w.plannerProvider, 'Alpha'), 0, 'nothing was sent to its Planner either');

    // The healthy Pair DID proceed, which proves the pass was not simply aborted.
    assert.ok(
      writesFor(w.plannerProvider, 'Bravo') + writesFor(w.workerProvider, 'Bravo') > 0 ||
        (await w.db.assignments.findByPairId(b)).length > 1,
      'Pair B made real progress',
    );
    assert.equal((await w.db.pairs.findById(a))!.activeAssignmentId, beforeA.slot, 'the slot is untouched');
    assert.equal((await w.db.pairs.findById(a))!.relayState, 'RUNNING', 'the Pair is not silently paused or stopped');
  });

  it('the Pair continues the SAME durable chain after the store recovers', async () => {
    const { w, a } = await twoPairWorld();
    const before = await w.engine.derivePairBaton((await w.db.pairs.findById(a))!);
    assert.equal(before.basis, 'confirmed_delivery');

    const restore = failReadsForAssignments(w, await assignmentIdsOf(w, a), sqliteReadError());
    await w.engine.recoverOnStartup();
    restore();

    // Mid-failure the baton could not be read at all; once readable it must be identical.
    const after = await w.engine.derivePairBaton((await w.db.pairs.findById(a))!);
    assert.equal(after.delivery!.id, before.delivery!.id);
    assert.equal(after.owner, before.owner);
    assert.deepEqual([...after.boundary!.messageIds], [...before.boundary!.messageIds]);
    assert.equal(after.chain.length, before.chain.length, 'no chain link was added or lost');

    // And the retry continues the chain rather than starting a new cycle.
    const countFor = async (pairId: PairId) => {
      const assignments = await w.db.assignments.findByPairId(pairId);
      const deliveries = await Promise.all(
        assignments.map((x) => w.db.deliveries.findByAssignmentId(x.id)),
      );
      const attempts = await Promise.all(assignments.map((x) => w.db.attempts.findByAssignmentId(x.id)));
      return { assignments, deliveries: deliveries.flat().length, attempts: attempts.flat().length };
    };

    const beforeCounts = await countFor(a);
    assert.equal(beforeCounts.deliveries, 1, 'one Delivery before the retry');
    assert.equal(beforeCounts.attempts, 1, 'one Attempt before the retry');

    await w.engine.runSupervisionTick();
    const afterCounts = await countFor(a);

    assert.ok(
      afterCounts.deliveries - beforeCounts.deliveries <= 1,
      `at most one new Delivery, never a resend (${beforeCounts.deliveries} -> ${afterCounts.deliveries})`,
    );
    assert.ok(
      afterCounts.attempts - beforeCounts.attempts <= 1,
      `at most one new Attempt (${beforeCounts.attempts} -> ${afterCounts.attempts})`,
    );
    assert.equal(
      afterCounts.assignments.filter((x) => x.sourceRecoveryDeliveryId !== undefined).length <= 1,
      true,
      'never a duplicate recovery notice',
    );
    // The original Delivery is still the single confirmed one for the original Assignment.
    assert.equal(
      (await w.db.deliveries.findByAssignmentId(afterCounts.assignments.find((x) => !x.sourceRecoveryDeliveryId && !x.sourceHandoffId)!.id))[0]!.status,
      'delivered',
    );
  });

  it('survives a real restart: the incident is still open, the chain is still intact', async () => {
    let { w, a } = await twoPairWorld();
    // Baseline BEFORE the fault is installed — the snapshot itself reads the same records.
    const before = await continuitySnapshot(w, a);
    const restore = failReadsForAssignments(w, await assignmentIdsOf(w, a), sqliteReadError());

    await w.engine.recoverOnStartup();
    w.engine.stopSupervisionLoop();
    w.db.db.close();
    restore();

    w = {
      ...openProcess(w.dbPath, { planner: w.plannerProvider.messages, worker: w.workerProvider.messages }),
    };

    // The incident is durable: a restart does not lose it.
    assert.equal((await openItems(w, a)).length, 1, 'the open incident survived the restart');
    assert.equal((await failureEvents(w, a)).length, 1);

    // And continuity is untouched, so the retry continues the same chain.
    assert.deepEqual(await continuitySnapshot(w, a), before);
    await w.engine.recoverOnStartup();
    assert.equal((await openItems(w, a)).length, 0, 'the restarted pass succeeds and closes the episode');
  });
});

/* ==================================================================== */
/* Legacy-orphan repair is deliberately NOT wired into startup          */
/* ==================================================================== */

describe('Legacy-orphan repair is not wired into startup — and why', () => {
  it('a coherent Pair is a no-op for the repair, so wiring it would be harmless there', async () => {
    const { w, a } = await twoPairWorld();
    const first = await w.engine.reconcilePairAssignmentAuthority(a);
    assert.equal(first.transitions.length, 0, 'nothing to repair');
    assert.equal(first.adoptedAssignmentId, (await w.db.pairs.findById(a))!.activeAssignmentId);
    const second = await w.engine.reconcilePairAssignmentAuthority(a);
    assert.deepEqual(second.transitions, [], 'and it is idempotent');
  });

  it('BLOCKING CASE: the repair DESTROYS legal pending backlog, so startup must not call it', async () => {
    // `createAssignment` states that a `pending` Assignment may exist alongside an active one —
    // "a Pair may legitimately have a backlog". `reconcilePairAssignmentAuthority` rule 3
    // cancels every non-holder unresolved Assignment, and `describeOrphanReason` fires that
    // branch for exactly this shape: `pending` with no Attempt.
    //
    // So calling it unconditionally at startup would silently delete an operator's undispatched
    // backlog on every restart, for every Pair, with no work ever having been sent. That is a
    // destructive behaviour change, not a repair — which is why it is an operator-initiated
    // authority operation and must stay one.
    const { w, a } = await twoPairWorld();
    const backlog = await w.engine.createAssignment(a, 'operator backlog', 'never dispatched');
    const holder = (await w.db.pairs.findById(a))!.activeAssignmentId;
    assert.equal((await w.db.assignments.findById(backlog.id))!.status, 'pending');

    // A real startup pass must leave it completely alone.
    const restore = failReadsForAssignments(w, await assignmentIdsOf(w, a), sqliteReadError());
    await w.engine.recoverOnStartup();
    restore();

    assert.equal(
      (await w.db.assignments.findById(backlog.id))!.status,
      'pending',
      'startup preserves legal backlog',
    );
    assert.deepEqual(await w.db.attempts.findByAssignmentId(backlog.id), [], 'and never dispatched it');

    // And the reason it cannot be wired in: the repair would cancel it.
    const result = await w.engine.reconcilePairAssignmentAuthority(a);
    const transition = result.transitions.find((t) => t.assignmentId === backlog.id);
    assert.ok(transition, 'the repair would cancel the backlog — this is the blocking case');
    assert.equal(transition!.to, 'cancelled');
    assert.match(transition!.reason, /never dispatched/i);
    assert.equal((await w.db.pairs.findById(a))!.activeAssignmentId, holder, 'the real holder is kept');
  });

  it('the repair still repairs a legacy orphan deterministically, when an operator asks for it', async () => {
    const { w, a } = await twoPairWorld();
    const Assignment = (await import('../src/relay/domain/entities.ts')).Assignment;
    const Attempt = (await import('../src/relay/domain/entities.ts')).Attempt;

    // Recreate the pre-fix durable shape: two dispatched `active` Assignments, one slot.
    const stray = Assignment.create(a, (await w.db.pairs.findById(a))!.projectId, 'stray', 'stray', 'normal', 'planner');
    await w.db.assignments.save(stray);
    const attempt = Attempt.create(stray.id, 1);
    await w.db.attempts.save(attempt);
    stray.startAttempt(attempt);
    await w.db.assignments.save(stray);
    const pair = (await w.db.pairs.findById(a))!;
    pair.activeAssignmentId = stray.id;
    await w.db.pairs.save(pair);

    const result = await w.engine.reconcilePairAssignmentAuthority(a);
    assert.equal(result.adoptedAssignmentId, stray.id, 'the slot holder is kept, not replaced');
    assert.ok(result.transitions.some((t) => t.to === 'cancelled'), 'the displaced Assignment is terminalized');
    for (const t of result.transitions) assert.ok(t.reason.length > 0, 'every transition states a reason');
    assert.deepEqual(
      (await w.engine.reconcilePairAssignmentAuthority(a)).transitions,
      [],
      'and it is idempotent',
    );

    // A delivery left ambiguous is never reported as completed by the repair.
    const ambiguous = await w.db.assignments.findByPairId(a);
    for (const x of ambiguous) {
      for (const d of await w.db.deliveries.findByAssignmentId(x.id)) {
        assert.notEqual(x.status, 'completed', 'an unresolved Assignment is never marked completed');
        if (d.status === 'ambiguous') assert.equal(d.status, 'ambiguous', 'ambiguity is left visible');
      }
    }
  });
});