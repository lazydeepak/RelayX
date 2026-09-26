/**
 * PLAN_FIRST_DOMAIN_FREEZE.md §H — the persistent multi-unit operational milestone.
 *
 * This is the authoritative proof that the frozen Plan-First model works end to end
 * through the REAL production controller on a REAL file-backed SQLite database:
 *
 *   Boundary 0  setup: project, pair, authoritative associations, approved revision,
 *                        run, WU1(ordinal 1), WU2(ordinal 2)
 *   Boundary 1  WU1 dispatch: exactly one Assignment, exactly one Attempt
 *   Boundary 2  WU1 verify + accept (the ONLY path to completed)
 *   Boundary 3  close DB, reopen from the same file, recover
 *   Boundary 4  WU2 executes to completion -> run completed
 *   Boundary 5  restart + tick again: no duplicate dispatch, no duplicate attempt
 *   Boundary 6  negative: verification failure blocks the run and stops WU2
 *   Boundary 7  idempotency under repeated setup and repeated ticks
 *
 * Replaces the three superseded `core_slice9*` speculative files, which encoded concepts
 * the freeze rejected (Strategy §B.6, dependsOn/DAG N9) and obsolete constructor
 * signatures (§B.1 `create(projectId, semanticFields, sourceRef?)`, §B.2
 * `create(projectId, revision, sessionPairId)`).
 *
 * On verification: the frozen controller delegates to a deterministic evaluator
 * (§G step 10). The real correctness check is explicitly deferred to §15 step 11, so the
 * production default is fail-closed. This proof therefore injects a deterministic
 * evaluator, which is the seam §G describes, and asserts the controller's behaviour
 * around it. It never reads provider UI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import {
  ContractRevision,
  PlanFirstRun,
  RuntimeProjectAssociation,
  WorkUnit,
  deriveCurrentWorkUnit,
} from '../src/relay/domain/entities.ts';
import type { AssociationId, AssignmentId, AttemptId } from '../src/relay/domain/types.ts';
import type { PlanFirstVerificationEvaluator } from '../src/relay/domain/planFirstVerification.ts';
import { MockProvider } from './MockProvider.ts';

/**
 * Deterministic, UI-free evaluator. Milestone-1 stand-in for the real check: it keys off
 * the WorkUnit's own declared expectation, which is durable RelayX state, never a
 * provider observation.
 */
function makeEvaluator(outcomes: Record<number, 'passed' | 'failed'>): PlanFirstVerificationEvaluator {
  return {
    evaluate({ attempt, unit }) {
      const outcome = outcomes[unit.ordinal] ?? 'failed';
      return {
        outcome,
        checkId: `file:${unit.objective}.txt`,
        evidence: { attemptId: attempt.id, workUnitId: unit.id, ordinal: unit.ordinal },
      };
    },
  };
}

interface Fixture {
  dir: string;
  dbPath: string;
  projectId: string;
  pairId: string;
  revisionId: string;
  runId: string;
  wu1: WorkUnit;
  wu2: WorkUnit;
  digest: string;
  workerId: string;
  workerExternalId: string;
  plannerId: string;
}

async function setupBoundary0(
  dbPath: string,
  dir: string,
  evaluator: PlanFirstVerificationEvaluator,
): Promise<{ db: SqliteRelayDatabase; engine: RelayEngine; fx: Fixture; mock: MockProvider }> {
  const db = new SqliteRelayDatabase(dbPath);
  const engine = new RelayEngine(db, evaluator);
  const mock = new MockProvider('opencode');
  engine.registerProvider(mock);
  engine.registerProvider(new MockProvider('chatgpt'));

  const project = await engine.createProject('PF Operational', '', dir);

  const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
  planner.updateExternalIdentity('pf_op_planner');
  await db.runtimes.save(planner);

  const worker = await engine.registerRuntimeSession('opencode', 'Worker');
  worker.updateExternalIdentity('pf_op_worker');
  await db.runtimes.save(worker);

  // Authoritative (not `pair_binding`) pre-pair association evidence. The pairing guard is
  // deliberately NOT weakened: `pair_binding` is not proof of project membership.
  const assoc = (
    id: AssociationId,
    sessionId: string,
    providerType: 'chatgpt' | 'opencode',
    externalSessionId: string,
  ) =>
    new RuntimeProjectAssociation({
      id,
      runtimeSessionId: sessionId as never,
      projectId: project.id,
      providerType,
      externalSessionId,
      verificationState: 'verified',
      provenance: 'setup',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  await db.associations.save(assoc('assoc_pf_pl' as AssociationId, planner.id, 'chatgpt', 'pf_op_planner'));
  await db.associations.save(assoc('assoc_pf_wk' as AssociationId, worker.id, 'opencode', 'pf_op_worker'));

  const pair = await engine.createPair(project.id, 'Pair', planner.id, worker.id);

  const semanticFields = {
    wu1: { objective: 'a.txt', expect: 'A' },
    wu2: { objective: 'b.txt', expect: 'B' },
  };
  const revision = ContractRevision.create(project.id, semanticFields, join(dir, 'plan.md'));
  revision.approve('human');
  await db.contractRevisions.save(revision);

  const wu1 = WorkUnit.create(revision.id, 1, 'a.txt', 'Create a.txt containing A');
  const wu2 = WorkUnit.create(revision.id, 2, 'b.txt', 'Create b.txt containing B');
  await db.workUnits.save(wu1);
  await db.workUnits.save(wu2);

  const run = PlanFirstRun.create(project.id, revision, pair.id);
  await db.planFirstRuns.save(run);

  return {
    db,
    engine,
    mock,
    fx: {
      dir,
      dbPath,
      projectId: project.id,
      pairId: pair.id,
      revisionId: revision.id,
      runId: run.id,
      wu1,
      wu2,
      digest: revision.canonicalDigest,
      workerId: worker.id,
      workerExternalId: 'pf_op_worker',
      plannerId: planner.id,
    },
  };
}

/** The worker finished physical execution. This is the frozen production transition. */
async function markWorkerFinished(
  db: SqliteRelayDatabase,
  workUnitId: string,
): Promise<{ attemptId: string; assignmentId: string }> {
  const unit = await db.workUnits.findById(workUnitId as never);
  assert.ok(unit?.assignmentId, 'unit must be bound to an assignment before physical completion');
  const assignment = await db.assignments.findById(unit.assignmentId);
  assert.ok(assignment?.currentAttemptId, 'assignment must have a current attempt');
  const attempt = await db.attempts.findById(assignment.currentAttemptId);
  assert.ok(attempt, 'attempt must exist');
  attempt.completePhysical({
    id: `ev_done_${attempt.id}`,
    timestamp: Date.now(),
    source: 'reconciliation_probe',
    runtimeSessionId: attempt.workerSessionId!,
  });
  await db.attempts.save(attempt);
  return { attemptId: attempt.id, assignmentId: assignment.id };
}

describe('Plan-First Operational Qualification (PLAN_FIRST_DOMAIN_FREEZE.md §H)', () => {
  it('Boundaries 0-5 — WU1 -> restart -> WU2 -> completion -> restart/no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay_pf_op_'));
    writeFileSync(join(dir, 'README.md'), 'Plan-First operational proof');
    const dbPath = join(dir, 'relay.sqlite');
    const evaluator = makeEvaluator({ 1: 'passed', 2: 'passed' });

    let assignmentsForWu1 = 0;
    let attemptsForWu1 = 0;
    let wu1AssignmentId = '' as AssignmentId;
    let wu1AttemptId = '' as AttemptId;

    // ---------------- Boundary 0 — setup ----------------
    let { db, engine, fx } = await setupBoundary0(dbPath, dir, evaluator);
    {
      const run = await db.planFirstRuns.findById(fx.runId as never);
      assert.ok(run, 'run persisted');
      assert.strictEqual(run!.status, 'ready');
      assert.strictEqual(run!.contractDigest, fx.digest);

      const units = await db.workUnits.findByContractRevisionId(fx.revisionId as never);
      assert.strictEqual(units.length, 2);
      assert.deepStrictEqual(units.map((u) => u.ordinal), [1, 2]);
      // No persisted mutable cursor exists anywhere.
      assert.strictEqual((run as unknown as { currentWorkUnitId?: string }).currentWorkUnitId, undefined);
      assert.deepStrictEqual(deriveCurrentWorkUnit(units), { kind: 'next', unit: units[0] });
    }

    // ---------------- Boundary 1 — WU1 dispatch ----------------
    {
      const tick1 = await engine.runPlanFirstTick(fx.runId as never);
      // A confirmed delivery only means the instruction arrived; physical execution is
      // still running, so this tick must NOT verify or advance (§H Boundary 1).
      assert.strictEqual(tick1.transition, 'dispatch_in_flight');
      assert.strictEqual(tick1.runId, fx.runId);
      assert.strictEqual(tick1.workUnitId, fx.wu1.id);
      assert.strictEqual(typeof tick1.transition, 'string');

      // No hidden authority: the tick alone must not invent a pair, a runtime session, or
      // an association. It may only create the one Assignment for the selected unit.
      assert.strictEqual((await db.pairs.findAll()).length, 1, 'no extra Pair invented');
      assert.strictEqual((await db.runtimes.findAll()).length, 2, 'no extra runtime session');
      const allAssocs = await db.associations.findByProjectId(fx.projectId as never);
      assert.strictEqual(allAssocs.length, 2, 'no extra association invented');

      const wu1 = await db.workUnits.findById(fx.wu1.id as never);
      assert.strictEqual(wu1!.status, 'in_progress');
      wu1AssignmentId = wu1!.assignmentId!;

      // EXACTLY ONE Assignment for WU1, created by the frozen selection transaction.
      const allAssignments = await db.assignments.findAll();
      assignmentsForWu1 = allAssignments.filter((a) => a.id === wu1AssignmentId).length;
      assert.strictEqual(assignmentsForWu1, 1, 'exactly one Assignment for WU1');
      assert.strictEqual(allAssignments.length, 1, 'no other Assignment may exist yet');
      assert.strictEqual(allAssignments[0].pairId, fx.pairId);
      assert.strictEqual(allAssignments[0].projectId, fx.projectId);

      // EXACTLY ONE Attempt, created by the established dispatch path (never by the tick).
      const attempts = await db.attempts.findByAssignmentId(wu1AssignmentId);
      assert.strictEqual(attempts.length, 1, 'exactly one Attempt for the WU1 dispatch');
      assert.strictEqual(attempts[0].attemptNumber, 1);
      assert.strictEqual(attempts[0].status, 'running');
      assert.strictEqual(attempts[0].sessionPairId, fx.pairId);
      assert.strictEqual(attempts[0].workerSessionId, fx.workerId);
      assert.strictEqual(attempts[0].externalSessionId, fx.workerExternalId);
      wu1AttemptId = attempts[0].id;
      attemptsForWu1 = attempts.length;

      const deliveries = await db.deliveries.findByAssignmentId(wu1AssignmentId);
      assert.strictEqual(deliveries.length, 1);
      assert.strictEqual(deliveries[0].status, 'delivered');
      assert.strictEqual(deliveries[0].attemptId, wu1AttemptId);

      const inProgress = await db.workUnits.findInProgressByContractRevisionId(fx.revisionId as never);
      assert.strictEqual(inProgress?.id, fx.wu1.id, 'exactly one in_progress unit');
      const run = await db.planFirstRuns.findById(fx.runId as never);
      assert.strictEqual(run!.status, 'running');
    }

    // Repeated tick while in flight must be idempotent (Boundary 7 discipline).
    {
      const again = await engine.runPlanFirstTick(fx.runId as never);
      assert.strictEqual(again.transition, 'dispatch_in_flight');
      const attempts = await db.attempts.findByAssignmentId(wu1AssignmentId);
      assert.strictEqual(attempts.length, 1, 'in-flight re-tick must not create a second Attempt');
      assert.strictEqual((await db.assignments.findAll()).length, 1);
    }

    // ---------------- Boundary 2 — WU1 verify + accept ----------------
    {
      const { attemptId } = await markWorkerFinished(db, fx.wu1.id);
      assert.strictEqual(attemptId, wu1AttemptId);

      const tick2 = await engine.runPlanFirstTick(fx.runId as never);
      assert.strictEqual(tick2.transition, 'work_unit_completed');
      assert.strictEqual(tick2.workUnitId, fx.wu1.id);
      assert.strictEqual(tick2.assignmentId, wu1AssignmentId);
      assert.strictEqual(tick2.attemptId, wu1AttemptId);
      assert.strictEqual(tick2.plannerUpdateRequired, false);

      const verification = await db.verificationResults.findByAttemptId(wu1AttemptId as never);
      assert.ok(verification, 'a VerificationResult must exist for the attempt');
      assert.strictEqual(verification!.result, 'passed');
      assert.strictEqual(verification!.checkId, 'file:a.txt.txt');

      const wu1 = await db.workUnits.findById(fx.wu1.id as never);
      assert.strictEqual(wu1!.status, 'completed');
      assert.strictEqual(wu1!.assignmentId, wu1AssignmentId, 'binding retained');

      const assignment = await db.assignments.findById(wu1AssignmentId);
      assert.strictEqual(assignment!.status, 'completed');

      // Verification must NOT have mutated physical execution state.
      const attempt = await db.attempts.findById(wu1AttemptId as never);
      assert.strictEqual(attempt!.status, 'completed_physical');

      // Run is still running: WU2 is pending.
      const run = await db.planFirstRuns.findById(fx.runId as never);
      assert.strictEqual(run!.status, 'running');

      const units = await db.workUnits.findByContractRevisionId(fx.revisionId as never);
      const cursor = deriveCurrentWorkUnit(units);
      assert.strictEqual(cursor.kind, 'next');
      assert.strictEqual(cursor.kind === 'next' ? cursor.unit.id : null, fx.wu2.id);
    }

    // ---------------- Boundary 3 — close DB, reopen, recover ----------------
    db.close();
    {
      db = new SqliteRelayDatabase(dbPath);
      engine = new RelayEngine(db, evaluator);
      engine.registerProvider(new MockProvider('opencode'));
      engine.registerProvider(new MockProvider('chatgpt'));

      const run2 = await db.planFirstRuns.findById(fx.runId as never);
      assert.ok(run2, 'run survives reopen');
      assert.strictEqual(run2!.id, fx.runId);
      assert.strictEqual(run2!.status, 'running');
      assert.strictEqual(run2!.contractRevisionId, fx.revisionId);
      assert.strictEqual(run2!.contractDigest, fx.digest);
      assert.strictEqual(run2!.sessionPairId, fx.pairId);

      const units2 = await db.workUnits.findByContractRevisionId(fx.revisionId as never);
      assert.strictEqual(units2.length, 2, 'no duplicate work units');
      assert.strictEqual(units2[0].id, fx.wu1.id);
      assert.strictEqual(units2[0].status, 'completed');
      assert.strictEqual(units2[1].id, fx.wu2.id);
      assert.strictEqual(units2[1].status, 'pending');
      assert.strictEqual(
        await db.workUnits.findInProgressByContractRevisionId(fx.revisionId as never),
        null,
        'no in-progress unit after restart',
      );

      const cursor2 = deriveCurrentWorkUnit(units2);
      assert.strictEqual(cursor2.kind === 'next' ? cursor2.unit.id : null, fx.wu2.id);

      const wu1After = await db.workUnits.findById(fx.wu1.id as never);
      assert.strictEqual(wu1After!.assignmentId, wu1AssignmentId, 'same Assignment after restart');

      const attemptsAfter = await db.attempts.findByAssignmentId(wu1AssignmentId);
      assert.strictEqual(attemptsAfter.length, 1, 'no duplicate Attempt after restart');
      assert.strictEqual(attemptsAfter[0].id, wu1AttemptId, 'same Attempt after restart');
      assert.strictEqual(attemptsAfter[0].sessionPairId, fx.pairId);
      assert.strictEqual(attemptsAfter[0].externalSessionId, fx.workerExternalId);
      assert.strictEqual(attemptsAfter[0].status, 'completed_physical');

      const verification = await db.verificationResults.findByAttemptId(wu1AttemptId as never);
      assert.strictEqual(verification?.result, 'passed', 'verification survived restart');

      const revision = await db.contractRevisions.findById(fx.revisionId as never);
      assert.strictEqual(revision?.canonicalDigest, fx.digest);
      run2!.assertBindingIntact(revision!);
    }

    // ---------------- Boundary 4 — WU2 executes to completion ----------------
    {
      const tick3 = await engine.runPlanFirstTick(fx.runId as never);
      assert.strictEqual(tick3.transition, 'dispatch_in_flight');
      assert.strictEqual(tick3.workUnitId, fx.wu2.id);

      const wu2 = await db.workUnits.findById(fx.wu2.id as never);
      assert.strictEqual(wu2!.status, 'in_progress');
      const wu2AssignmentId = wu2!.assignmentId!;
      assert.notStrictEqual(wu2AssignmentId, wu1AssignmentId, 'each unit gets its own Assignment');

      // WU1 was NOT redispatched.
      const wu1Attempts = await db.attempts.findByAssignmentId(wu1AssignmentId);
      assert.strictEqual(wu1Attempts.length, 1);
      assert.strictEqual(wu1Attempts[0].id, wu1AttemptId);
      const wu2Attempts = await db.attempts.findByAssignmentId(wu2AssignmentId);
      assert.strictEqual(wu2Attempts.length, 1, 'exactly one Attempt for the WU2 dispatch');
      assert.strictEqual(wu2Attempts[0].attemptNumber, 1);

      await markWorkerFinished(db, fx.wu2.id);
      const tick4 = await engine.runPlanFirstTick(fx.runId as never);
      assert.strictEqual(tick4.transition, 'run_completed', 'last unit completed -> run completed');

      const wu2After = await db.workUnits.findById(fx.wu2.id as never);
      assert.strictEqual(wu2After!.status, 'completed');
      const run3 = await db.planFirstRuns.findById(fx.runId as never);
      assert.strictEqual(run3!.status, 'completed');
      const wu1After = await db.workUnits.findById(fx.wu1.id as never);
      assert.strictEqual(wu1After!.status, 'completed', 'WU1 stays completed');
    }

    // ---------------- Boundary 5 — second restart + tick is a no-op ----------------
    db.close();
    {
      db = new SqliteRelayDatabase(dbPath);
      engine = new RelayEngine(db, evaluator);
      engine.registerProvider(new MockProvider('opencode'));
      engine.registerProvider(new MockProvider('chatgpt'));

      const assignmentCountBefore = (await db.assignments.findAll()).length;
      const allAttemptsBefore = (await db.assignments.findAll()).reduce(
        async (acc, a) => acc.then(async (n) => n + (await db.attempts.findByAssignmentId(a.id)).length),
        Promise.resolve(0),
      );
      const resolved = await allAttemptsBefore;
      assert.strictEqual(assignmentCountBefore, 2, 'WU1 + WU2 assignments');
      assert.strictEqual(resolved, 2, 'one attempt per assignment');

      const tick5 = await engine.runPlanFirstTick(fx.runId as never);
      assert.strictEqual(tick5.transition, 'run_terminal', 'terminal run never executes again');

      assert.strictEqual((await db.assignments.findAll()).length, assignmentCountBefore, 'no new Assignment');
      const after = (await db.assignments.findAll()).reduce(
        async (acc, a) => acc.then(async (n) => n + (await db.attempts.findByAssignmentId(a.id)).length),
        Promise.resolve(0),
      );
      assert.strictEqual(await after, resolved, 'no new Attempt');
      assert.strictEqual((await db.workUnits.findById(fx.wu1.id as never))!.status, 'completed');
      assert.strictEqual((await db.workUnits.findById(fx.wu2.id as never))!.status, 'completed');

      // No revision drift, no pair mutation.
      const run4 = await db.planFirstRuns.findById(fx.runId as never);
      assert.strictEqual(run4!.contractRevisionId, fx.revisionId);
      assert.strictEqual(run4!.contractDigest, fx.digest);
      assert.strictEqual(run4!.sessionPairId, fx.pairId);
      const revision4 = await db.contractRevisions.findById(fx.revisionId as never);
      assert.strictEqual(revision4!.canonicalDigest, fx.digest);
      const pair4 = await db.pairs.findById(fx.pairId as never);
      assert.strictEqual(pair4!.projectId, fx.projectId);
      assert.strictEqual(pair4!.workerSessionId, fx.workerId);
    }

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('Boundary 6 — negative: verification failure blocks the run and stops WU2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay_pf_neg_'));
    writeFileSync(join(dir, 'README.md'), 'Plan-First negative proof');
    const dbPath = join(dir, 'relay.sqlite');
    // WU1's deterministic check fails.
    const { db, engine, fx } = await setupBoundary0(dbPath, dir, makeEvaluator({ 1: 'failed', 2: 'passed' }));

    const tick1 = await engine.runPlanFirstTick(fx.runId as never);
    assert.strictEqual(tick1.transition, 'dispatch_in_flight');

    await markWorkerFinished(db, fx.wu1.id);
    const tick2 = await engine.runPlanFirstTick(fx.runId as never);
    assert.strictEqual(tick2.transition, 'verification_failed');
    assert.strictEqual(tick2.plannerUpdateRequired, true);
    assert.strictEqual(tick2.blocker, 'verification_failed');

    // Blocked, NOT completed, and NOT advanced to WU2.
    assert.strictEqual((await db.workUnits.findById(fx.wu1.id as never))!.status, 'blocked');
    assert.strictEqual((await db.workUnits.findById(fx.wu2.id as never))!.status, 'pending');
    const run = await db.planFirstRuns.findById(fx.runId as never);
    assert.strictEqual(run!.status, 'blocked');

    // The attempt keeps its physical truth; only verification disagreed.
    const wu1 = await db.workUnits.findById(fx.wu1.id as never);
    const assignment = await db.assignments.findById(wu1!.assignmentId!);
    const attempt = await db.attempts.findById(assignment!.currentAttemptId!);
    assert.strictEqual(attempt!.status, 'completed_physical');
    assert.notStrictEqual(assignment!.status, 'completed', 'assignment stays unresolved');

    // A further tick waits for the planner; it must not self-declare or advance.
    const tick3 = await engine.runPlanFirstTick(fx.runId as never);
    assert.strictEqual(tick3.transition, 'blocked_awaiting_planner');
    assert.strictEqual(tick3.plannerUpdateRequired, true);
    assert.strictEqual((await db.workUnits.findById(fx.wu2.id as never))!.status, 'pending');
    assert.strictEqual((await db.assignments.findAll()).length, 1, 'WU2 never dispatched');

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('Boundary 7 — idempotency: repeated setup and repeated ticks never duplicate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay_pf_idem_'));
    writeFileSync(join(dir, 'README.md'), 'Plan-First idempotency proof');
    const dbPath = join(dir, 'relay.sqlite');
    const evaluator = makeEvaluator({ 1: 'passed', 2: 'passed' });
    const { db, engine, fx } = await setupBoundary0(dbPath, dir, evaluator);

    // UNIQUE (project_id, canonical_digest): the same semantic intent is the same revision.
    const sameIntent = ContractRevision.create(
      fx.projectId as never,
      {
        wu1: { objective: 'a.txt', expect: 'A' },
        wu2: { objective: 'b.txt', expect: 'B' },
      },
      'other-source.md',
    );
    sameIntent.approve('human');
    await assert.rejects(
      () => db.contractRevisions.save(sameIntent),
      /UNIQUE constraint failed/,
      'a duplicate semantic digest must be rejected',
    );

    // UNIQUE (contract_revision_id, ordinal)
    const dupOrdinal = WorkUnit.create(fx.revisionId as never, 1, 'dup', 'dup instruction');
    await assert.rejects(
      () => db.workUnits.save(dupOrdinal),
      /UNIQUE constraint failed/,
      'a duplicate ordinal must be rejected',
    );

    // Ordinal must be an explicit integer >= 1.
    assert.throws(() => WorkUnit.create(fx.revisionId as never, 0, 'x', 'y'), /integer >= 1/);
    assert.throws(() => WorkUnit.create(fx.revisionId as never, 1.5, 'x', 'y'), /integer >= 1/);

    // At most one non-terminal run per (project, revision).
    const secondRun = PlanFirstRun.create(fx.projectId as never, (await db.contractRevisions.findById(fx.revisionId as never))!, fx.pairId as never);
    await assert.rejects(
      () => db.planFirstRuns.save(secondRun),
      /UNIQUE constraint failed/,
      'a second active run for the same revision must be rejected',
    );

    // Repeated ticks on a fresh run are stable and never duplicate work.
    for (let i = 0; i < 3; i++) {
      await engine.runPlanFirstTick(fx.runId as never);
    }
    assert.strictEqual((await db.assignments.findAll()).length, 1, 'exactly one Assignment');
    const attempts = await db.attempts.findByAssignmentId((await db.workUnits.findById(fx.wu1.id as never))!.assignmentId!);
    assert.strictEqual(attempts.length, 1, 'exactly one Attempt');

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
