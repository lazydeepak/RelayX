/**
 * Dispatch-intent reconciliation.
 *
 * The invariant under test:
 *
 *   Every durable dispatch intent must eventually reach a terminal, operator-visible
 *   disposition. A Delivery must not remain `delivering` indefinitely after process
 *   interruption without either being resolved from authoritative evidence or surfaced
 *   as ambiguity requiring attention.
 *
 * ## The window
 *
 * `dispatchAssignment` is three-phase (ATTEMPT_LIFECYCLE.md Case 1/2):
 *
 *   Phase 1  txn   prepared Attempt + Delivery(pending -> delivering)   COMMIT
 *   Phase 2  ---   provider.deliverInstruction()   <-- EXTERNAL SIDE EFFECT
 *   Phase 3  txn   confirmDelivered | markAmbiguous | markFailed      COMMIT
 *
 * A crash inside Phase 2 leaves `Attempt = prepared`, `Delivery = delivering`, WorkUnit
 * not advanced, while the external worker may or may not have received the instruction.
 * The duplicate-dispatch guards correctly refuse to resend, so nothing was ever lost to
 * duplication — but before this tranche nothing resolved the stranded record, so the
 * assignment was wedged with no operator signal.
 *
 * ## What these tests deliberately do NOT do
 *
 * They do not exercise `reconcileUncertainDeliveries`. That method exists in no ref, no
 * dangling commit and no dangling blob; `core_slice2` encodes a speculative API whose
 * fixtures never reach it (it dies in `assertPrePairAuthoritativeAssociation` and in a
 * UNIQUE-constraint violation before the call site). These tests target the accepted
 * invariant through the real production engine instead.
 *
 * Every stranded state below is produced the only honest way: by running a real Phase 1
 * dispatch and then rolling the Delivery back to `delivering`, which is precisely the
 * durable state a crash inside Phase 2 leaves behind.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import { Pair, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { AmbiguousDeliveryResendError, DuplicateDeliveryAttemptError } from '../src/relay/domain/errors.ts';
import type {
  AssociationId,
  AssignmentId,
  ObservableEvidence,
  ProjectId,
  ProviderType,
  RuntimeSessionId,
} from '../src/relay/domain/types.ts';
import type { IRuntimeProvider } from '../src/relay/providers/interfaces.ts';

type ReconcileOutcome =
  | 'delivered'
  | 'not_delivered'
  | 'supporting_evidence_only'
  | 'unknown'
  | 'unsupported';

/**
 * A MockProvider with a controllable reconciliation probe.
 *
 * `MockProvider` itself has no `reconcileDispatch`, which is exactly the R5 case, so the
 * hook is added here rather than changing the shared fixture. `sendCount` proves that
 * reconciliation never performs a dispatch.
 */
class ReconcileProvider extends MockProvider {
  public outcome: ReconcileOutcome = 'unknown';
  public throwOnProbe = false;
  public withEvidence = true;
  public sendCount = 0;
  public probeCount = 0;
  public lastRequest: Record<string, unknown> | null = null;

  constructor(type: ProviderType = 'opencode') {
    super(type);
  }

  override async deliverInstruction(req: Parameters<MockProvider['deliverInstruction']>[0]) {
    this.sendCount++;
    return super.deliverInstruction(req);
  }

  async reconcileDispatch(request: {
    sessionId: RuntimeSessionId;
    deliveryId?: string;
    instructionSnippet?: string;
    externalSessionId?: string | null;
    idempotencyKey?: string;
  }): Promise<{
    outcome: ReconcileOutcome;
    evidence?: ObservableEvidence;
    reason?: string;
  }> {
    this.probeCount++;
    this.lastRequest = { ...request };
    if (this.throwOnProbe) {
      throw new Error('reconciliation probe exploded');
    }
    const evidence: ObservableEvidence = {
      id: `ev_recon_${this.probeCount}`,
      timestamp: 1700000000000 + this.probeCount,
      source: 'reconciliation_probe',
      runtimeSessionId: request.sessionId,
      details: { outcome: this.outcome },
    };
    return {
      outcome: this.outcome,
      evidence: this.withEvidence ? evidence : undefined,
      reason: `probe says ${this.outcome}`,
    };
  }
}

describe('Dispatch-intent reconciliation', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let provider: ReconcileProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    provider = new ReconcileProvider('opencode');
    engine.registerProvider(provider);
    engine.registerProvider(new MockProvider('chatgpt'));
  });

  async function bindPair(
    projectId: ProjectId,
    plannerId: RuntimeSessionId,
    workerId: RuntimeSessionId,
  ): Promise<Pair> {
    const planner = await db.runtimes.findById(plannerId);
    planner?.updateExternalIdentity('bind_planner');
    if (planner) await db.runtimes.save(planner);

    const worker = await db.runtimes.findById(workerId);
    worker?.updateExternalIdentity('bind_worker');
    if (worker) await db.runtimes.save(worker);

    const stamp = Date.now();
    await db.associations.save(
      new RuntimeProjectAssociation({
        id: ('assoc_' + stamp + '_pl') as AssociationId,
        runtimeSessionId: plannerId,
        projectId,
        providerType: 'chatgpt',
        externalSessionId: planner?.externalSessionId ?? 'bind_planner',
        verificationState: 'verified',
        provenance: 'discovery',
        createdAt: stamp,
        updatedAt: stamp,
      }),
    );
    await db.associations.save(
      new RuntimeProjectAssociation({
        id: ('assoc_' + stamp + '_wk') as AssociationId,
        runtimeSessionId: workerId,
        projectId,
        providerType: 'opencode',
        externalSessionId: worker?.externalSessionId ?? 'bind_worker',
        verificationState: 'verified',
        provenance: 'discovery',
        createdAt: stamp,
        updatedAt: stamp,
      }),
    );
    const pair = Pair.create(projectId, 'Pair', plannerId, workerId);
    await db.pairs.save(pair);
    // I-2 (S6): reconciliation calls `provider.reconcileDispatch`, which is real
    // external contact and is gated on operational_state = ACTIVE. Load & Activate
    // is the ONLY authorized grantor (freeze §4.4, §11.5), so the Pair must be
    // activated before dispatch/reconciliation here can exercise their real
    // behaviour rather than being refused at the gate.
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    await engine.startPair(pair.id);
    return pair;
  }

  /**
   * Produces the real crash-window state: a genuine Phase 1 dispatch (prepared Attempt +
   * Delivery), with the Delivery rolled back to `delivering` to model a crash inside
   * Phase 2 before the outcome was committed.
   */
  async function strandDispatch(label: string) {
    const project = await engine.createProject(`${label} Project`);
    const planner = await engine.registerRuntimeSession('chatgpt', `${label} Planner`);
    const worker = await engine.registerRuntimeSession('opencode', `${label} Worker`);
    const pair = await bindPair(project.id, planner.id, worker.id);
    const assignment = await engine.createAssignment(pair.id, 'A', 'Do X');

    const { attempt, delivery } = await engine.dispatchAssignment(assignment.id);
    provider.sendCount = 0; // ignore the setup dispatch itself

    // Model the crash: outcome never committed.
    // `delivered_at` is cleared with the status because Phase 3 is what sets it — a crash
    // inside Phase 2 commits NO outcome, which is why the live stranded record carries a
    // NULL `delivered_at`.
    db.db.prepare(`UPDATE deliveries SET status = 'delivering', delivered_at = NULL WHERE id = ?`).run(delivery.id);
    db.db.prepare(`UPDATE attempts SET status = 'prepared' WHERE id = ?`).run(attempt.id);

    const stranded = await db.deliveries.findById(delivery.id);
    assert.strictEqual(stranded?.status, 'delivering', 'precondition: stranded dispatch intent');

    return { project, pair, assignment, attemptId: attempt.id, deliveryId: delivery.id };
  }

  async function countDeliveries(assignmentId: AssignmentId): Promise<number> {
    return (await db.deliveries.findByAssignmentId(assignmentId)).length;
  }

  async function countAttempts(assignmentId: AssignmentId): Promise<number> {
    return (await db.attempts.findByAssignmentId(assignmentId)).length;
  }

  it('R1 — confirmed delivered resolves the intent but keeps the SAME attempt prepared', async () => {
    const { assignment, attemptId, deliveryId } = await strandDispatch('R1');
    provider.outcome = 'delivered';

    const report = await engine.reconcileUnresolvedDispatches();

    assert.strictEqual(report.examined, 1);
    assert.strictEqual(report.deliveredConfirmed, 1);
    assert.strictEqual(report.notDeliveredConfirmed, 0);
    assert.strictEqual(report.ambiguousRaised, 0);

    const delivery = await db.deliveries.findById(deliveryId);
    assert.strictEqual(delivery?.status, 'delivered');
    assert.ok(delivery?.evidence, 'delivered must carry observable evidence');

    // The SAME attempt stays prepared. No execution evidence, new attempt, assignment, or resend.
    const attempt = await db.attempts.findById(attemptId);
    assert.strictEqual(attempt?.status, 'prepared');
    assert.strictEqual(await countAttempts(assignment.id), 1);
    assert.strictEqual(await countDeliveries(assignment.id), 1);
    assert.strictEqual(provider.sendCount, 0, 'reconciliation must never dispatch');
  });

  it('R1b — delivered WITHOUT evidence is not authoritative and stays unresolved as ambiguity', async () => {
    const { attemptId, deliveryId } = await strandDispatch('R1b');
    provider.outcome = 'delivered';
    provider.withEvidence = false; // bare claim, no observable evidence

    const report = await engine.reconcileUnresolvedDispatches();

    assert.strictEqual(report.deliveredConfirmed, 0, 'a bare `delivered` claim is not authoritative');
    assert.strictEqual(report.ambiguousRaised, 1);
    assert.strictEqual((await db.deliveries.findById(deliveryId))?.status, 'ambiguous');
    // The attempt is NOT promoted to running on a non-authoritative claim.
    assert.strictEqual((await db.attempts.findById(attemptId))?.status, 'prepared');
  });

  it('R2 — confirmed not delivered makes exactly one clean re-dispatch possible', async () => {
    const { assignment, attemptId, deliveryId } = await strandDispatch('R2');
    provider.outcome = 'not_delivered';

    const report = await engine.reconcileUnresolvedDispatches();

    assert.strictEqual(report.notDeliveredConfirmed, 1);
    assert.strictEqual(report.ambiguousRaised, 0);

    const delivery = await db.deliveries.findById(deliveryId);
    assert.strictEqual(delivery?.status, 'failed');

    // Attempt deliberately stays `prepared` (ATTEMPT_LIFECYCLE.md Case 1: intent stored,
    // external send not performed). Reconciliation establishes truth; it does not resend.
    assert.strictEqual((await db.attempts.findById(attemptId))?.status, 'prepared');
    assert.strictEqual(provider.sendCount, 0, 'reconciliation must not resend');

    // Normal dispatch machinery decides subsequent execution, and may now proceed.
    const { attempt: second, delivery: secondDelivery } = await engine.dispatchAssignment(assignment.id);
    assert.notStrictEqual(second.id, attemptId, 'a clean dispatch mints a NEW attempt');
    assert.strictEqual(second.attemptNumber, 2, 'attempt numbering continues from max, not count');
    assert.notStrictEqual(secondDelivery.id, deliveryId);
    assert.strictEqual(provider.sendCount, 1, 'exactly one legitimate dispatch, issued by dispatchAssignment');
    assert.strictEqual(await countAttempts(assignment.id), 2);
  });

  it('R3 — unknown resolves conservatively to ambiguous plus a critical Attention item', async () => {
    const { assignment, deliveryId } = await strandDispatch('R3');
    provider.outcome = 'unknown';

    const report = await engine.reconcileUnresolvedDispatches();

    assert.strictEqual(report.ambiguousRaised, 1);
    assert.strictEqual((await db.deliveries.findById(deliveryId))?.status, 'ambiguous');
    assert.strictEqual(provider.sendCount, 0, 'no resend on ambiguity');

    const open = await db.attention.findOpen();
    const critical = open.filter((a) => a.severity === 'critical' && a.type === 'ambiguous_delivery');
    assert.strictEqual(critical.length, 1, 'exactly one critical attention item');
    assert.strictEqual(critical[0].assignmentId, assignment.id);

    // The item must carry enough durable context for operator/recovery handling.
    const msg = critical[0].message;
    for (const token of ['Project:', 'Assignment:', 'Attempt:', 'Delivery:', 'Target runtime:', 'Reason:']) {
      assert.ok(msg.includes(token), `attention message must include '${token}'`);
    }
    assert.ok(msg.includes(deliveryId), 'attention must name the delivery');

    // And automatic resend stays blocked. The existing Phase 1 guards own this: an
    // ambiguous record trips AmbiguousDeliveryResendError before any send.
    await assert.rejects(
      async () => engine.dispatchAssignment(assignment.id),
      (err: unknown) => {
        assert.ok(
          err instanceof AmbiguousDeliveryResendError,
          `ambiguity must block resend, got ${String(err)}`,
        );
        return true;
      },
    );
    assert.strictEqual(provider.sendCount, 0, 'ambiguity must never resend');
    assert.strictEqual(await countDeliveries(assignment.id), 1);
  });

  it('R4 — supporting evidence only is NOT treated as delivered', async () => {
    const { attemptId, deliveryId } = await strandDispatch('R4');
    provider.outcome = 'supporting_evidence_only';

    const report = await engine.reconcileUnresolvedDispatches();

    assert.strictEqual(report.deliveredConfirmed, 0);
    assert.strictEqual(report.ambiguousRaised, 1);
    assert.strictEqual((await db.deliveries.findById(deliveryId))?.status, 'ambiguous');
    assert.strictEqual((await db.attempts.findById(attemptId))?.status, 'prepared');
  });

  it('R5 — a provider with no reconciliation hook still cannot leave the intent invisible', async () => {
    const { deliveryId } = await strandDispatch('R5');
    // Bare MockProvider: no reconcileDispatch at all.
    const bare = new MockProvider('opencode') as MockProvider;
    assert.strictEqual((bare as unknown as IRuntimeProvider).reconcileDispatch, undefined);
    engine.registerProvider(bare);

    const report = await engine.reconcileUnresolvedDispatches();

    assert.strictEqual(report.ambiguousRaised, 1, 'an unprobeable provider is still an unresolved dispatch');
    assert.strictEqual((await db.deliveries.findById(deliveryId))?.status, 'ambiguous');
    const critical = (await db.attention.findOpen()).filter((a) => a.severity === 'critical');
    assert.strictEqual(critical.length, 1, 'operator visibility is the invariant');
    assert.ok(critical[0].message.includes('no dispatch reconciliation probe'));
  });

  it('R5b — a provider that explicitly reports `unsupported` is surfaced the same way', async () => {
    const { deliveryId } = await strandDispatch('R5b');
    provider.outcome = 'unsupported';

    const report = await engine.reconcileUnresolvedDispatches();

    assert.strictEqual(report.ambiguousRaised, 1);
    assert.strictEqual((await db.deliveries.findById(deliveryId))?.status, 'ambiguous');
    assert.strictEqual((await db.attention.findOpen()).filter((a) => a.severity === 'critical').length, 1);
  });

  it('R6 — a throwing probe resolves conservatively rather than escaping', async () => {
    const { deliveryId } = await strandDispatch('R6');
    provider.throwOnProbe = true;

    const report = await engine.reconcileUnresolvedDispatches();

    assert.strictEqual(report.ambiguousRaised, 1);
    assert.strictEqual((await db.deliveries.findById(deliveryId))?.status, 'ambiguous');
    const critical = (await db.attention.findOpen()).filter((a) => a.severity === 'critical');
    assert.strictEqual(critical.length, 1);
    assert.ok(critical[0].message.includes('reconciliation probe exploded'));
  });

  it('R7 — repeated reconciliation never duplicates anything and never dispatches', async () => {
    const { assignment, attemptId, deliveryId } = await strandDispatch('R7');
    provider.outcome = 'unknown';

    const first = await engine.reconcileUnresolvedDispatches();
    assert.strictEqual(first.ambiguousRaised, 1);

    const afterFirst = {
      delivery: await db.deliveries.findById(deliveryId),
      attempt: await db.attempts.findById(attemptId),
      critical: (await db.attention.findOpen()).filter((a) => a.severity === 'critical').length,
    };
    const criticalId = (await db.attention.findOpen())[0]?.id;

    // Repeated passes.
    const second = await engine.reconcileUnresolvedDispatches();
    const third = await engine.reconcileUnresolvedDispatches();

    // `ambiguous` IS re-examined: it means "ground truth unresolved", which is exactly the
    // open question a probe answers, so the intent is not finished work. What must hold on
    // every repeat is that re-examining CHANGES NOTHING unless the probe becomes
    // authoritative — no duplicate attention, no status change, no rewritten evidence.
    assert.strictEqual(second.ambiguousRaised, 1, 'the intent is still reported as unresolved');
    assert.strictEqual(third.ambiguousRaised, 1);
    assert.strictEqual(
      second.dispositions[0]?.attentionItemId,
      criticalId,
      'a repeat pass must reuse the existing Attention item, never mint a new one',
    );
    assert.strictEqual(third.dispositions[0]?.attentionItemId, criticalId);
    assert.strictEqual(provider.probeCount, 3, 'each pass re-probes the unresolved intent');
    assert.strictEqual(provider.sendCount, 0, 'no dispatch, ever');

    assert.strictEqual((await db.deliveries.findById(deliveryId))?.status, afterFirst.delivery?.status);
    assert.strictEqual(
      (await db.deliveries.findById(deliveryId))?.failureReason,
      afterFirst.delivery?.failureReason,
      'an inconclusive re-probe must not rewrite the recorded reason',
    );
    assert.strictEqual((await db.attempts.findById(attemptId))?.status, afterFirst.attempt?.status);
    assert.strictEqual(
      (await db.attention.findOpen()).filter((a) => a.severity === 'critical').length,
      afterFirst.critical,
      'attention items must not duplicate',
    );
    assert.strictEqual(await countAttempts(assignment.id), 1);
    assert.strictEqual(await countDeliveries(assignment.id), 1);
  });

  it('R9 — an intent left ambiguous ONLY because the probe was missing is re-resolved', async () => {
    // The real-world wedge: R5 strands an intent as `ambiguous` with the reason
    // "exposes no dispatch reconciliation probe". Nothing about the external world has
    // settled it — RelayX simply could not look. Once a probe exists, re-examination must
    // resolve it, with NO resend.
    const { attemptId, deliveryId } = await strandDispatch('R9');

    // Pass 1: no probe at all → ambiguous + operator visibility.
    const bare = new MockProvider('opencode') as MockProvider;
    assert.strictEqual((bare as unknown as IRuntimeProvider).reconcileDispatch, undefined);
    engine.registerProvider(bare);
    const stranded = await engine.reconcileUnresolvedDispatches();
    assert.strictEqual(stranded.ambiguousRaised, 1);
    assert.strictEqual((await db.deliveries.findById(deliveryId))?.status, 'ambiguous');
    assert.strictEqual((await db.attempts.findById(attemptId))?.status, 'prepared');
    assert.strictEqual((await db.deliveries.findById(deliveryId))?.deliveredAt, undefined);

    // Pass 2: the probe exists and answers authoritatively.
    engine.registerProvider(provider);
    provider.outcome = 'delivered';
    const sendsBefore = provider.sendCount;
    const resolved = await engine.reconcileUnresolvedDispatches();

    assert.strictEqual(resolved.deliveredConfirmed, 1);
    assert.strictEqual(resolved.ambiguousRaised, 0);
    const delivery = await db.deliveries.findById(deliveryId);
    assert.strictEqual(delivery?.status, 'delivered');
    assert.ok(delivery?.deliveredAt, 'delivered_at must be populated from reconciliation evidence');
    assert.ok(delivery?.evidence, 'delivery evidence is the probe evidence, not a synthetic id');
    assert.strictEqual(delivery?.evidence?.source, 'reconciliation_probe');
    assert.strictEqual(
      (await db.attempts.findById(attemptId))?.status,
      'prepared',
      'delivery is not execution proof — the Attempt is never promoted here',
    );
    assert.strictEqual(provider.sendCount, sendsBefore, 'resolution must never resend');

    // The doubt the CRITICAL item expressed is answered, so it must not stay open.
    assert.strictEqual(
      (await db.attention.findOpen()).filter((a) => a.severity === 'critical').length,
      0,
      'a resolved ambiguity must not leave a CRITICAL item open',
    );

    // Terminal state must not be revisited.
    const settled = await engine.reconcileUnresolvedDispatches();
    assert.strictEqual(settled.examined, 0, 'a delivered intent is no longer examined');
  });

  it('R7b — repeated reconciliation of a DELIVERED intent does not regress the terminal state', async () => {
    const { attemptId, deliveryId } = await strandDispatch('R7b');
    provider.outcome = 'delivered';

    await engine.reconcileUnresolvedDispatches();
    const evidenceId = (await db.deliveries.findById(deliveryId))?.evidence?.id;
    const deliveredAt = (await db.deliveries.findById(deliveryId))?.deliveredAt;

    await engine.reconcileUnresolvedDispatches();
    await engine.reconcileUnresolvedDispatches();

    const delivery = await db.deliveries.findById(deliveryId);
    assert.strictEqual(delivery?.status, 'delivered', 'terminal state must not regress');
    assert.strictEqual(delivery?.evidence?.id, evidenceId, 'evidence must not be rewritten');
    assert.strictEqual(delivery?.deliveredAt, deliveredAt);
    assert.strictEqual((await db.attempts.findById(attemptId))?.status, 'prepared');
  });

  it('R8 — real restart: stranded intent is resolved through the actual startup path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay_recon_'));
    const path = join(dir, 'relay.db');

    let strandedIds: { attemptId: string; deliveryId: string; assignmentId: AssignmentId };
    try {
      // --- Session 1: dispatch, then crash inside Phase 2 -------------------
      {
        const db1 = new SqliteRelayDatabase(path);
        const engine1 = new RelayEngine(db1);
        const p1 = new ReconcileProvider('opencode');
        engine1.registerProvider(p1);
        engine1.registerProvider(new MockProvider('chatgpt'));

        const project = await engine1.createProject('R8 Project');
        const planner = await engine1.registerRuntimeSession('chatgpt', 'Planner');
        const worker = await engine1.registerRuntimeSession('opencode', 'Worker');

        const stamp = Date.now();
        for (const [rid, rtype, ext] of [
          [planner.id, 'chatgpt', 'bind_planner'],
          [worker.id, 'opencode', 'bind_worker'],
        ] as const) {
          await db1.associations.save(
            new RuntimeProjectAssociation({
              id: ('assoc_r8_' + rid) as AssociationId,
              runtimeSessionId: rid,
              projectId: project.id,
              providerType: rtype,
              externalSessionId: ext,
              verificationState: 'verified',
              provenance: 'discovery',
              createdAt: stamp,
              updatedAt: stamp,
            }),
          );
        }
        const pair = Pair.create(project.id, 'Pair', planner.id, worker.id);
        await db1.pairs.save(pair);
        // Same I-2 reason as bindPair: activation must precede dispatch.
        assert.strictEqual((await engine1.loadAndActivate(pair.id)).outcome, 'activated');
        await engine1.startPair(pair.id);
        const assignment = await engine1.createAssignment(pair.id, 'A', 'Do X');
        const { attempt, delivery } = await engine1.dispatchAssignment(assignment.id);

        // Crash inside Phase 2: the outcome is never committed.
        db1.db.prepare(`UPDATE deliveries SET status = 'delivering' WHERE id = ?`).run(delivery.id);
        db1.db.prepare(`UPDATE attempts SET status = 'prepared' WHERE id = ?`).run(attempt.id);

        strandedIds = { attemptId: attempt.id, deliveryId: delivery.id, assignmentId: assignment.id };
        db1.close();
      }

      // --- Session 2: reconstruct and run the REAL startup path -------------
      {
        const db2 = new SqliteRelayDatabase(path);
        const engine2 = new RelayEngine(db2);
        const p2 = new ReconcileProvider('opencode');
        p2.outcome = 'delivered';
        engine2.registerProvider(p2);
        engine2.registerProvider(new MockProvider('chatgpt'));

        const report = await engine2.recoverOnStartup();

        assert.strictEqual(report.dispatchIntents.examined, 1);
        assert.strictEqual(report.dispatchIntents.deliveredConfirmed, 1);
        assert.strictEqual(report.dispatchIntents.ambiguousRaised, 0);
        assert.strictEqual(p2.sendCount, 0, 'startup recovery must never dispatch');

        const delivery = await db2.deliveries.findById(strandedIds.deliveryId as never);
        assert.strictEqual(delivery?.status, 'delivered');
        const attempt = await db2.attempts.findById(strandedIds.attemptId as never);
        assert.strictEqual(attempt?.status, 'prepared', 'delivery recovery does not invent execution evidence');
        assert.strictEqual((await db2.attempts.findByAssignmentId(strandedIds.assignmentId)).length, 1);
        assert.strictEqual((await db2.deliveries.findByAssignmentId(strandedIds.assignmentId)).length, 1);
        db2.close();
      }

      // --- Session 3: ambiguity durability across another reopen ------------
      {
        const db3 = new SqliteRelayDatabase(path);
        const engine3 = new RelayEngine(db3);
        // Providers must be registered before Load & Activate can satisfy its
        // §4.4 "provider capabilities present" precondition. The other sessions in
        // this restart test already do this; session 3 now matches them.
        engine3.registerProvider(new ReconcileProvider('opencode'));
        engine3.registerProvider(new MockProvider('chatgpt'));
        const project = await engine3.createProject('R8b Project');
        const planner = await engine3.registerRuntimeSession('chatgpt', 'P2');
        const worker = await engine3.registerRuntimeSession('opencode', 'W2');
        const stamp = Date.now();
        for (const [rid, rtype, ext] of [
          [planner.id, 'chatgpt', 'ext_p2'],
          [worker.id, 'opencode', 'ext_w2'],
        ] as const) {
          await db3.associations.save(
            new RuntimeProjectAssociation({
              id: ('assoc_r8b_' + rid) as AssociationId,
              runtimeSessionId: rid,
              projectId: project.id,
              providerType: rtype,
              externalSessionId: ext,
              verificationState: 'verified',
              provenance: 'discovery',
              createdAt: stamp,
              updatedAt: stamp,
            }),
          );
        }
        const pair2 = Pair.create(project.id, 'Pair2', planner.id, worker.id);
        await db3.pairs.save(pair2);
        // Same I-2 reason as bindPair: activation must precede dispatch.
        assert.strictEqual((await engine3.loadAndActivate(pair2.id)).outcome, 'activated');
        await engine3.startPair(pair2.id);
        const asg2 = await engine3.createAssignment(pair2.id, 'B', 'Do Y');
        const { attempt: a2, delivery: d2 } = await engine3.dispatchAssignment(asg2.id);
        db3.db.prepare(`UPDATE deliveries SET status = 'delivering' WHERE id = ?`).run(d2.id);
        db3.db.prepare(`UPDATE attempts SET status = 'prepared' WHERE id = ?`).run(a2.id);
        db3.close();

        // Reopen once more and resolve to ambiguity.
        const db4 = new SqliteRelayDatabase(path);
        const engine4 = new RelayEngine(db4);
        const p4 = new ReconcileProvider('opencode');
        p4.outcome = 'unknown';
        engine4.registerProvider(p4);
        engine4.registerProvider(new MockProvider('chatgpt'));
        await engine4.recoverOnStartup();
        db4.close();

        // Third reopen: the critical Attention item is durable.
        const db5 = new SqliteRelayDatabase(path);
        const critical = (await db5.attention.findOpen()).filter(
          (a) => a.severity === 'critical' && a.assignmentId === asg2.id,
        );
        assert.strictEqual(critical.length, 1, 'critical attention survives another reopen');
        assert.strictEqual((await db5.deliveries.findById(d2.id))?.status, 'ambiguous');

        // And a further startup pass does not duplicate it.
        const engine5 = new RelayEngine(db5);
        engine5.registerProvider(p4);
        engine5.registerProvider(new MockProvider('chatgpt'));
        await engine5.recoverOnStartup();
        assert.strictEqual(
          (await db5.attention.findOpen()).filter((a) => a.assignmentId === asg2.id).length,
          1,
          'still exactly one',
        );
        db5.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
