/**
 * PLAN_FIRST_DOMAIN_FREEZE.md §E (schema) and §F (repositories) — acceptance proof.
 *
 * Runs against a REAL file-backed SQLite database, including a real close/reopen, because
 * the frozen migration and the frozen constraints are only meaningful on a database that
 * outlives a process.
 *
 * NOTE ON SYNC vs ASYNC: every repository method is async, so a constraint violation
 * surfaces as a REJECTION and must be asserted with `assert.rejects`. Only raw
 * `DatabaseSync` statements (`db.db.prepare(...).run()`) throw synchronously and use
 * `assert.throws`. Mixing these up leaks unhandled rejections.
 *
 * Covered:
 *   §E.1 contract_revisions    — UNIQUE (project_id, canonical_digest)
 *   §E.2 plan_first_runs       — RESTRICT on the revision FK, soft pair ref, partial unique
 *   §E.3 work_units            — UNIQUE (contract_revision_id, ordinal), partial unique,
 *                                NOT NULL instruction, ON DELETE RESTRICT on the assignment
 *   §E.4.1 verification_results — UNIQUE (attempt_id)
 *   §E.5 migration order       — v3 lands after v2; legacy tables dropped only when empty
 *   §F    typed repositories    — round-trip, ordering, lookups, immutability at the write
 *                                layer, and the removal of `findNextEligible`/`updateStatus`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import {
  Assignment,
  Attempt,
  ContractRevision,
  Pair,
  PlanFirstRun,
  Project,
  RuntimeProjectAssociation,
  RuntimeSession,
  WorkUnit,
} from '../src/relay/domain/entities.ts';
import type {
  AssignmentId,
  AttemptId,
  ContractRevisionId,
  PairId,
  PlanFirstRunId,
  ProjectId,
  WorkUnitId,
} from '../src/relay/domain/types.ts';

const now = () => Date.now();

/** Runs `fn` in a fresh temp dir and always cleans up, even when the body throws. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'relay_pf_schema_'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Minimal project + pair so the FK targets resolve. */
async function seedOwner(db: SqliteRelayDatabase): Promise<{ projectId: ProjectId; pairId: PairId }> {
  const project = Project.create('Schema Project');
  await db.projects.save(project);
  const planner = RuntimeSession.create('chatgpt', 'Planner');
  const worker = RuntimeSession.create('opencode', 'Worker');
  await db.runtimes.save(planner);
  await db.runtimes.save(worker);
  const pair = Pair.create(project.id, 'Pair', planner.id, worker.id);
  await db.pairs.save(pair);
  return { projectId: project.id, pairId: pair.id };
}

async function seedAssignment(
  db: SqliteRelayDatabase,
  pairId: PairId,
  projectId: ProjectId,
): Promise<AssignmentId> {
  const assignment = Assignment.create(pairId, projectId, 'title', 'instruction');
  await db.assignments.save(assignment);
  return assignment.id;
}

async function approvedRevision(
  db: SqliteRelayDatabase,
  projectId: ProjectId,
  fields: Record<string, unknown>,
) {
  const rev = ContractRevision.create(projectId, fields);
  rev.approve('human');
  await db.contractRevisions.save(rev);
  return rev;
}

describe('Plan-First schema — frozen constraints (§E)', () => {
  it('S1 — a clean database creates all three tables and stamps user_version 3', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'clean.sqlite'));
      const version = (db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      assert.strictEqual(version, 3);

      const tables = (
        db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((t) => t.name);
      for (const t of ['contract_revisions', 'plan_first_runs', 'work_units', 'verification_results']) {
        assert.ok(tables.includes(t), `${t} must exist`);
      }
      db.close();
    });
  });

  it('S2 — UNIQUE (project_id, canonical_digest): same intent, one revision per project', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'digest.sqlite'));
      const { projectId } = await seedOwner(db);
      const fields = { objective: 'build', criteria: 'pass' };
      await approvedRevision(db, projectId, fields);

      // Key order must not create a second revision for the same intent.
      const dup = ContractRevision.create(projectId, { criteria: 'pass', objective: 'build' });
      dup.approve('human');
      assert.strictEqual(dup.canonicalDigest, ContractRevision.create(projectId, fields).canonicalDigest);
      await assert.rejects(
        () => db.contractRevisions.save(dup),
        /UNIQUE constraint failed/,
        'the same semantic intent in the same project is the same revision',
      );

      // A DIFFERENT project may hold the identical intent.
      const otherProject = Project.create('Other');
      await db.projects.save(otherProject);
      const other = ContractRevision.create(otherProject.id, fields);
      other.approve('human');
      await db.contractRevisions.save(other);
      assert.strictEqual(
        (await db.contractRevisions.findByDigest(otherProject.id, other.canonicalDigest))?.id,
        other.id,
        'uniqueness is project-scoped, not global',
      );

      db.close();
    });
  });

  it('S3 — UNIQUE (contract_revision_id, ordinal) and non-contiguous ordinal ordering', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'ordinal.sqlite'));
      const { projectId } = await seedOwner(db);
      const rev = await approvedRevision(db, projectId, { objective: 'o' });

      await db.workUnits.save(WorkUnit.create(rev.id, 1, 'first', 'do first'));
      await db.workUnits.save(WorkUnit.create(rev.id, 2, 'second', 'do second'));
      await assert.rejects(
        () => db.workUnits.save(WorkUnit.create(rev.id, 1, 'clash', 'clash')),
        /UNIQUE constraint failed/,
        'ordinal is unique within a revision',
      );

      // Retrieval is ordinal-ordered, and non-contiguous ordinals are fine.
      await db.workUnits.save(WorkUnit.create(rev.id, 10, 'tenth', 'do tenth'));
      const ordered = await db.workUnits.findByContractRevisionId(rev.id);
      assert.deepStrictEqual(ordered.map((u) => u.ordinal), [1, 2, 10]);

      // instruction is NOT NULL at the SCHEMA level (the domain also guards it).
      assert.throws(() =>
        db.db
          .prepare(
            `INSERT INTO work_units (id, contract_revision_id, ordinal, objective, instruction, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, 'pending', ?, ?)`,
          )
          .run('wu_null', rev.id, 99, 'obj', now(), now()),
        /NOT NULL constraint failed/,
      );

      db.close();
    });
  });

  it('S4 — at most ONE in_progress unit per revision (strictly sequential, no parallelism)', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'sequential.sqlite'));
      const { projectId, pairId } = await seedOwner(db);
      const rev = await approvedRevision(db, projectId, { objective: 'seq' });
      const assignmentId = await seedAssignment(db, pairId, projectId);

      const a = WorkUnit.create(rev.id, 1, 'a', 'do a');
      const b = WorkUnit.create(rev.id, 2, 'b', 'do b');
      await db.workUnits.save(a);
      await db.workUnits.save(b);

      a.startExecution(assignmentId);
      await db.workUnits.save(a);
      assert.strictEqual((await db.workUnits.findInProgressByContractRevisionId(rev.id))?.id, a.id);

      b.startExecution(assignmentId);
      await assert.rejects(
        () => db.workUnits.save(b),
        /UNIQUE constraint failed/,
        'a second concurrent in_progress unit must be impossible',
      );

      // Releasing A lets B proceed.
      a.accept();
      await db.workUnits.save(a);
      await db.workUnits.save(b);
      assert.strictEqual((await db.workUnits.findInProgressByContractRevisionId(rev.id))?.id, b.id);

      db.close();
    });
  });

  it('S5 — at most ONE non-terminal run per (project, revision)', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'one_run.sqlite'));
      const { projectId, pairId } = await seedOwner(db);
      const rev = await approvedRevision(db, projectId, { objective: 'one run' });

      const first = PlanFirstRun.create(projectId, rev, pairId);
      await db.planFirstRuns.save(first);

      await assert.rejects(
        () => db.planFirstRuns.save(PlanFirstRun.create(projectId, rev, pairId)),
        /UNIQUE constraint failed/,
      );

      // A TERMINAL run frees the slot.
      first.cancel();
      await db.planFirstRuns.save(first);
      const second = PlanFirstRun.create(projectId, rev, pairId);
      await db.planFirstRuns.save(second);
      assert.strictEqual(
        (await db.planFirstRuns.findActiveByContractRevisionId(projectId, rev.id))?.id,
        second.id,
      );

      db.close();
    });
  });

  it('S6 — the revision FK is ON DELETE RESTRICT: executed intent is not deletable', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'restrict.sqlite'));
      const { projectId, pairId } = await seedOwner(db);
      const rev = await approvedRevision(db, projectId, { objective: 'restrict' });
      const run = PlanFirstRun.create(projectId, rev, pairId);
      await db.planFirstRuns.save(run);

      assert.throws(
        () => db.db.prepare('DELETE FROM contract_revisions WHERE id = ?').run(rev.id),
        /FOREIGN KEY constraint failed/,
        'a revision backing a run must not be deletable',
      );
      assert.ok(await db.contractRevisions.findById(rev.id), 'the revision survives the refused delete');

      // Deleting the PROJECT cascades — that is the frozen intent: the whole project,
      // including its executed intent, is what gets removed.
      db.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
      assert.strictEqual(await db.planFirstRuns.findById(run.id), null);
      assert.ok(pairId.length > 0);

      db.close();
    });
  });

  it('S7 — session_pair_id is a SOFT reference: the run survives pair deletion', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'softref.sqlite'));
      const { projectId, pairId } = await seedOwner(db);
      const rev = await approvedRevision(db, projectId, { objective: 'soft' });
      const run = PlanFirstRun.create(projectId, rev, pairId);
      await db.planFirstRuns.save(run);

      // No FK on session_pair_id: deleting the pair must NOT cascade the run.
      db.db.prepare('DELETE FROM pairs WHERE id = ?').run(pairId);

      const after = await db.planFirstRuns.findById(run.id);
      assert.ok(after, 'the run retains its immutable origin pair reference');
      assert.strictEqual(after!.sessionPairId, pairId, 'historical provenance is preserved verbatim');

      db.close();
    });
  });

  it('S8 — the assignment binding is ON DELETE RESTRICT (no orphaned silent re-dispatch)', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'assign_restrict.sqlite'));
      const { projectId, pairId } = await seedOwner(db);
      const rev = await approvedRevision(db, projectId, { objective: 'binding' });
      const assignmentId = await seedAssignment(db, pairId, projectId);

      const unit = WorkUnit.create(rev.id, 1, 'a', 'do a');
      unit.startExecution(assignmentId);
      await db.workUnits.save(unit);

      assert.throws(
        () => db.db.prepare('DELETE FROM assignments WHERE id = ?').run(assignmentId),
        /FOREIGN KEY constraint failed/,
        'a bound Assignment must not be deletable, or the unit would silently re-dispatch',
      );

      db.close();
    });
  });

  it('S9 — the write layer keeps immutable columns immutable (ON CONFLICT update set)', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'immutable.sqlite'));
      const { projectId, pairId } = await seedOwner(db);
      const rev = await approvedRevision(db, projectId, { objective: 'immutable' });
      const run = PlanFirstRun.create(projectId, rev, pairId);
      await db.planFirstRuns.save(run);

      // Re-saving must only ever update MUTABLE columns. A tampered copy that changes the
      // frozen binding is therefore ignored, not persisted. This is the runtime half of
      // the compile-time `readonly` guarantee asserted in plan_first_domain.test.ts.
      await db.planFirstRuns.save(
        new PlanFirstRun({
          id: run.id,
          projectId,
          contractRevisionId: 'rev_TAMPERED' as ContractRevisionId,
          contractDigest: 'deadbeef',
          sessionPairId: 'pair_TAMPERED' as PairId,
          status: 'running',
          createdAt: run.createdAt,
          updatedAt: now(),
        }),
      );

      const stored = await db.planFirstRuns.findById(run.id);
      assert.strictEqual(stored!.contractRevisionId, rev.id, 'revision binding cannot be rewritten');
      assert.strictEqual(stored!.contractDigest, rev.canonicalDigest, 'digest snapshot cannot be rewritten');
      assert.strictEqual(stored!.sessionPairId, pairId, 'origin pair cannot be rewritten');
      assert.strictEqual(stored!.status, 'running', 'but the mutable status DOES update');

      // Same guarantee for the revision's canonical identity.
      await db.contractRevisions.save(
        new ContractRevision({
          id: rev.id,
          projectId,
          canonicalText: '{"objective":"hijacked"}',
          canonicalDigest: 'hijacked',
          status: 'approved',
          approvedBy: 'human',
          approvedAt: now(),
          createdAt: rev.createdAt,
        }),
      );
      const storedRev = await db.contractRevisions.findById(rev.id);
      assert.strictEqual(storedRev!.canonicalDigest, rev.canonicalDigest, 'revision identity cannot be rewritten');
      assert.strictEqual(storedRev!.canonicalText, rev.canonicalText);
      assert.strictEqual(storedRev!.status, 'approved', 'status IS mutable');

      // And the WorkUnit ordinal is the ordering primitive, so it must not move.
      const unit = WorkUnit.create(rev.id, 1, 'a', 'do a');
      await db.workUnits.save(unit);
      await db.workUnits.save(
        new WorkUnit({
          id: unit.id,
          contractRevisionId: rev.id,
          ordinal: 42,
          objective: 'a',
          instruction: 'do a',
          status: 'blocked',
          createdAt: unit.createdAt,
          updatedAt: now(),
        }),
      );
      const storedUnit = await db.workUnits.findById(unit.id);
      assert.strictEqual(storedUnit!.ordinal, 1, 'the ordinal cannot be rewritten');
      assert.strictEqual(storedUnit!.status, 'blocked', 'but the status DOES update');

      db.close();
    });
  });

  it('S10 — UNIQUE (attempt_id) on verification_results: one result per attempt', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'verif.sqlite'));
      const { projectId, pairId } = await seedOwner(db);
      const assignmentId = await seedAssignment(db, pairId, projectId);

      const attempt = Attempt.create(assignmentId, 1);
      attempt.startRunning();
      attempt.completePhysical();
      await db.attempts.save(attempt);

      const ts = now();
      await db.verificationResults.save({
        id: 'verif_1' as never,
        attemptId: attempt.id,
        checkId: 'file:a.txt',
        result: 'passed',
        evidence: { n: 1 },
        createdAt: ts,
        updatedAt: ts,
      });

      // A second result for the same attempt would break the controller's resume
      // idempotency guard, so it must be impossible. The repository uses a PLAIN INSERT
      // (no upsert) precisely so a conflicting second verdict is refused rather than
      // silently overwriting the first.
      await assert.rejects(
        () =>
          db.verificationResults.save({
            id: 'verif_2' as never,
            attemptId: attempt.id,
            checkId: 'other',
            result: 'failed',
            createdAt: ts,
            updatedAt: ts,
          }),
        /UNIQUE constraint failed/,
        'two conflicting verdicts for one attempt must be impossible',
      );

      // The FIRST verdict is untouched by the rejected insert.
      const kept = await db.verificationResults.findByAttemptId(attempt.id);
      assert.strictEqual(kept!.result, 'passed', 'the recorded verdict is not overwritten');
      assert.strictEqual(kept!.id, 'verif_1');
      const total = (
        db.db.prepare('SELECT COUNT(*) AS n FROM verification_results WHERE attempt_id = ?').get(attempt.id) as {
          n: number;
        }
      ).n;
      assert.strictEqual(total, 1, 'exactly one row per attempt');

      db.close();
    });
  });
});

describe('Plan-First schema — migration (§E.5)', () => {
  it('S11 — the v3 migration runs AFTER the v0->v2 step, so orphan triggers still land', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'legacy.sqlite');
      // A v0 database, exactly as an old RelayX install would look.
      const raw = new DatabaseSync(path);
      raw.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
          canonical_path TEXT, git_root TEXT, planner_project_url TEXT, worker_workspace_path TEXT,
          status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
        );
        CREATE TABLE runtime_sessions (
          id TEXT PRIMARY KEY, provider_type TEXT NOT NULL, name TEXT NOT NULL,
          status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE pairs (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
          planner_session_id TEXT, worker_session_id TEXT, status TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 0;
      `);
      raw
        .prepare('INSERT INTO projects (id, name, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('proj_legacy', 'Legacy', 'kept', 'active', now(), now());
      raw.close();

      const db = new SqliteRelayDatabase(path);
      assert.strictEqual((db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);

      // The regression this guards: stamping 3 first would make `version < 2` false and
      // silently skip the orphan triggers.
      const triggers = (
        db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]
      ).map((t) => t.name);
      assert.ok(triggers.includes('set_null_planner_session'), 'v0->v2 must still run');
      assert.ok(triggers.includes('set_null_worker_session'), 'v0->v2 must still run');

      // Legacy data survives.
      assert.strictEqual((await db.projects.findById('proj_legacy' as ProjectId))?.name, 'Legacy');
      db.close();
    });
  });

  it('S12 — the speculative legacy Plan-First tables are dropped and replaced', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'legacy_pf.sqlite');
      const raw = new DatabaseSync(path);
      // Reproduce the scaffolding shape: a dangling FK to a table that never existed.
      raw.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
          canonical_path TEXT, git_root TEXT, planner_project_url TEXT, worker_workspace_path TEXT,
          status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
        );
        CREATE TABLE plan_first_runs (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, contract_revision_id TEXT NOT NULL,
          current_work_unit_id TEXT, current_strategy_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE work_units (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, contract_revision_id TEXT NOT NULL,
          objective TEXT, instruction TEXT, dependencies TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      raw.close();

      const db = new SqliteRelayDatabase(path);
      assert.strictEqual((db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);

      // The dropped columns are gone, the frozen ones are present.
      const runCols = (
        db.db.prepare("SELECT name FROM pragma_table_info('plan_first_runs')").all() as { name: string }[]
      ).map((c) => c.name);
      assert.ok(!runCols.includes('current_work_unit_id'), 'the persisted cursor is gone');
      assert.ok(!runCols.includes('current_strategy_id'), 'Strategy is rejected');
      assert.ok(runCols.includes('contract_digest'), 'the digest snapshot is present');
      assert.ok(runCols.includes('session_pair_id'));

      const unitCols = (
        db.db.prepare("SELECT name FROM pragma_table_info('work_units')").all() as { name: string }[]
      ).map((c) => c.name);
      assert.ok(!unitCols.includes('dependencies'), 'no DAG in V1');
      assert.ok(!unitCols.includes('project_id'), 'derivable through the revision');
      assert.ok(unitCols.includes('ordinal'));
      assert.ok(unitCols.includes('assignment_id'));

      // The rebuilt tables are actually writable, which the legacy pair never was
      // (their FK pointed at a table that did not exist).
      const { projectId } = await seedOwner(db);
      const rev = await approvedRevision(db, projectId, { objective: 'writable' });
      await db.workUnits.save(WorkUnit.create(rev.id, 1, 'a', 'do a'));
      assert.strictEqual((await db.workUnits.findByContractRevisionId(rev.id)).length, 1);

      db.close();
    });
  });

  it('S13 — DATA-LOSS GUARD: a legacy Plan-First table holding rows is never dropped', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'legacy_rows.sqlite');
      const raw = new DatabaseSync(path);
      raw.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
          canonical_path TEXT, git_root TEXT, planner_project_url TEXT, worker_workspace_path TEXT,
          status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
        );
        CREATE TABLE plan_first_runs (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, contract_revision_id TEXT NOT NULL,
          current_work_unit_id TEXT, current_strategy_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      raw
        .prepare(
          'INSERT INTO plan_first_runs (id, project_id, contract_revision_id, status, created_at) VALUES (?,?,?,?,?)',
        )
        .run('run_legacy', 'proj_x', 'rev_x', 'running', now());
      raw.close();

      // Migrating must REFUSE rather than silently discard the row.
      assert.throws(
        () => new SqliteRelayDatabase(path),
        /holds 1 row|will not drop/i,
        'RelayX must not destroy data it cannot interpret',
      );

      // The row is still there for manual reconciliation.
      const check = new DatabaseSync(path);
      const row = check.prepare('SELECT COUNT(*) AS n FROM plan_first_runs').get() as { n: number };
      assert.strictEqual(row.n, 1, 'the data was not destroyed');
      check.close();
    });
  });
});

describe('Plan-First repositories — typed round-trip and lookups (§F)', () => {
  it('S14 — every Plan-First record survives a real close/reopen, field for field', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'repo.sqlite');
      let db = new SqliteRelayDatabase(path);
      const { projectId, pairId } = await seedOwner(db);
      const rev = await approvedRevision(db, projectId, { objective: 'persist', criteria: 'tests pass' });
      const assignmentId = await seedAssignment(db, pairId, projectId);

      const wu1 = WorkUnit.create(rev.id, 1, 'first', 'do first');
      const wu2 = WorkUnit.create(rev.id, 2, 'second', 'do second');
      await db.workUnits.save(wu1);
      await db.workUnits.save(wu2);

      const run = PlanFirstRun.create(projectId, rev, pairId);
      await db.planFirstRuns.save(run);
      run.start();
      await db.planFirstRuns.save(run);
      wu1.startExecution(assignmentId);
      await db.workUnits.save(wu1);

      const attempt = Attempt.create(assignmentId, 1);
      attempt.startRunning();
      attempt.completePhysical();
      await db.attempts.save(attempt);
      const ts = now();
      await db.verificationResults.save({
        id: 'verif_persist' as never,
        attemptId: attempt.id,
        checkId: 'file:first.txt',
        result: 'passed',
        evidence: { kind: 'fixture' },
        createdAt: ts,
        updatedAt: ts,
      });

      db.close();

      // --- reopen ---
      db = new SqliteRelayDatabase(path);

      const storedRev = await db.contractRevisions.findById(rev.id);
      assert.ok(storedRev);
      assert.strictEqual(storedRev!.projectId, projectId);
      assert.strictEqual(storedRev!.canonicalText, rev.canonicalText);
      assert.strictEqual(storedRev!.canonicalDigest, rev.canonicalDigest);
      assert.strictEqual(storedRev!.status, 'approved');
      assert.strictEqual(storedRev!.approvedBy, 'human');
      assert.ok(typeof storedRev!.approvedAt === 'number');
      assert.strictEqual(storedRev!.sourceRef, rev.sourceRef);

      const storedRun = await db.planFirstRuns.findById(run.id);
      assert.ok(storedRun);
      assert.strictEqual(storedRun!.status, 'running');
      assert.strictEqual(storedRun!.contractRevisionId, rev.id);
      assert.strictEqual(storedRun!.contractDigest, rev.canonicalDigest);
      assert.strictEqual(storedRun!.sessionPairId, pairId);

      const units = await db.workUnits.findByContractRevisionId(rev.id);
      assert.strictEqual(units.length, 2);
      assert.deepStrictEqual(units.map((u) => u.ordinal), [1, 2], 'ordinal order is total and preserved');
      assert.strictEqual(units[0].id, wu1.id);
      assert.strictEqual(units[0].status, 'in_progress');
      assert.strictEqual(units[0].assignmentId, assignmentId, 'the assignment binding is persisted');
      assert.strictEqual(units[0].objective, 'first');
      assert.strictEqual(units[0].instruction, 'do first');
      assert.strictEqual(units[1].id, wu2.id);
      assert.strictEqual(units[1].status, 'pending');
      assert.strictEqual(units[1].assignmentId, null);

      const verif = await db.verificationResults.findByAttemptId(attempt.id as AttemptId);
      assert.ok(verif);
      assert.strictEqual(verif!.result, 'passed');
      assert.strictEqual(verif!.checkId, 'file:first.txt');
      assert.deepStrictEqual(verif!.evidence, { kind: 'fixture' });

      // Ownership-key lookups.
      assert.strictEqual((await db.contractRevisions.findByDigest(projectId, rev.canonicalDigest))?.id, rev.id);
      assert.strictEqual((await db.contractRevisions.findByProjectId(projectId)).length, 1);
      assert.strictEqual((await db.planFirstRuns.findByProjectId(projectId)).length, 1);
      assert.strictEqual((await db.planFirstRuns.findByContractRevisionId(rev.id)).length, 1);
      assert.strictEqual((await db.planFirstRuns.findActiveByContractRevisionId(projectId, rev.id))?.id, run.id);
      assert.strictEqual((await db.workUnits.findInProgressByContractRevisionId(rev.id))?.id, wu1.id);
      assert.strictEqual((await db.workUnits.findById(wu2.id as WorkUnitId))?.id, wu2.id);
      assert.strictEqual((await db.planFirstRuns.findById(run.id as PlanFirstRunId))?.id, run.id);

      db.close();
    });
  });

  it('S15 — the removed query methods stay removed (no eligibility logic in SQL)', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'noqueries.sqlite'));
      // §F explicitly deletes these three. Their absence is the point: eligibility is a
      // pure domain function over an ordinal-ordered list, not a status-filtered query.
      const repo = db.workUnits as unknown as Record<string, unknown>;
      for (const method of ['findNextEligible', 'updateStatus', 'findByContractAndStatus']) {
        assert.strictEqual(repo[method], undefined, `${method} must not exist`);
      }
      db.close();
    });
  });

  it('S16 — the repositories return real domain entities, not untyped rows', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'typed.sqlite'));
      const { projectId, pairId } = await seedOwner(db);
      const rev = await approvedRevision(db, projectId, { objective: 'typed' });
      await db.workUnits.save(WorkUnit.create(rev.id, 1, 'a', 'do a'));
      const run = PlanFirstRun.create(projectId, rev, pairId);
      await db.planFirstRuns.save(run);

      // The observable consequence of typed repositories: a lookup hands back a live
      // domain object, so the frozen behaviour is reachable and cannot be bypassed.
      // An `any`-typed repository returning a raw row would fail every line here.
      const loadedRev = await db.contractRevisions.findById(rev.id);
      assert.strictEqual(typeof loadedRev!.approve, 'function', 'revisions come back as entities');
      assert.strictEqual(loadedRev!.isApproved(), true);

      const loadedRun = await db.planFirstRuns.findById(run.id);
      assert.strictEqual(typeof loadedRun!.assertBindingIntact, 'function', 'runs come back as entities');
      loadedRun!.assertBindingIntact(rev);
      assert.throws(() => loadedRun!.assertBindingIntact(ContractRevision.create(projectId, { x: 1 })));

      const [unit] = await db.workUnits.findByContractRevisionId(rev.id);
      assert.strictEqual(typeof unit!.accept, 'function', 'work units come back as entities');
      assert.strictEqual(unit!.isTerminal(), false);

      // Both engines expose the same four Plan-First repositories.
      for (const name of ['contractRevisions', 'planFirstRuns', 'workUnits', 'verificationResults'] as const) {
        const repo = db[name] as unknown as Record<string, unknown>;
        assert.ok(repo, `${name} must be exposed by the database`);
        for (const method of ['findById', 'save']) {
          assert.strictEqual(typeof repo[method], 'function', `${name}.${method} must exist`);
        }
      }
      db.close();
    });
  });

  it('S17 — memory and SQLite repositories agree on the frozen constraints', async () => {
    const { MemoryRelayDatabase } = await import('../src/relay/persistence/memory/MemoryDatabase.ts');
    const mem = new MemoryRelayDatabase();

    const project = Project.create('Mem Project');
    await mem.projects.save(project);
    const planner = RuntimeSession.create('chatgpt', 'Planner');
    const worker = RuntimeSession.create('opencode', 'Worker');
    await mem.runtimes.save(planner);
    await mem.runtimes.save(worker);
    const pair = Pair.create(project.id, 'Pair', planner.id, worker.id);
    await mem.pairs.save(pair);

    const rev = ContractRevision.create(project.id, { objective: 'mem' });
    rev.approve('human');
    await mem.contractRevisions.save(rev);

    // Parity: project-scoped digest uniqueness.
    const dup = ContractRevision.create(project.id, { objective: 'mem' });
    dup.approve('human');
    await assert.rejects(() => mem.contractRevisions.save(dup), /duplicates the semantic digest/);

    const run = PlanFirstRun.create(project.id, rev, pair.id);
    await mem.planFirstRuns.save(run);
    await assert.rejects(
      () => mem.planFirstRuns.save(PlanFirstRun.create(project.id, rev, pair.id)),
      /second active run/,
      'Parity: at most one non-terminal run per (project, revision)',
    );

    // Parity: ordinal uniqueness.
    await mem.workUnits.save(WorkUnit.create(rev.id, 1, 'a', 'do a'));
    await assert.rejects(() => mem.workUnits.save(WorkUnit.create(rev.id, 1, 'b', 'do b')), /reuses ordinal/);

    // Parity: no concurrent in_progress units.
    const a = WorkUnit.create(rev.id, 2, 'b', 'do b');
    const b = WorkUnit.create(rev.id, 3, 'c', 'do c');
    a.startExecution('asgn_a' as AssignmentId);
    await mem.workUnits.save(a);
    b.startExecution('asgn_b' as AssignmentId);
    await assert.rejects(() => mem.workUnits.save(b), /concurrently|strictly sequential/);

    // Parity: one verification result per attempt.
    await mem.verificationResults.save({
      id: 'v1' as never,
      attemptId: 'at_1' as AttemptId,
      result: 'passed',
      createdAt: now(),
      updatedAt: now(),
    });
    await assert.rejects(
      () =>
        mem.verificationResults.save({
          id: 'v2' as never,
          attemptId: 'at_1' as AttemptId,
          result: 'failed',
          createdAt: now(),
          updatedAt: now(),
        }),
      /already has verification result/,
    );

    // Memory lookups mirror the SQLite ones.
    assert.deepStrictEqual(
      (await mem.workUnits.findByContractRevisionId(rev.id)).map((u) => u.ordinal),
      [1, 2],
    );
    assert.strictEqual((await mem.workUnits.findInProgressByContractRevisionId(rev.id))?.id, a.id);
    assert.strictEqual((await mem.verificationResults.findByAttemptId('at_1' as AttemptId))?.result, 'passed');
    assert.strictEqual((await mem.planFirstRuns.findActiveByContractRevisionId(project.id, rev.id))?.id, run.id);
  });

  it('S18 — associations remain a separate concern; Plan-First never invents one', async () => {
    await withTempDir(async (dir) => {
      const db = new SqliteRelayDatabase(join(dir, 'assoc.sqlite'));
      const project = Project.create('Assoc Project');
      await db.projects.save(project);
      const worker = RuntimeSession.create('opencode', 'Worker');
      await db.runtimes.save(worker);
      await db.associations.save(
        new RuntimeProjectAssociation({
          id: 'assoc_1' as never,
          runtimeSessionId: worker.id,
          projectId: project.id,
          providerType: 'opencode',
          externalSessionId: 'ses_1',
          verificationState: 'verified',
          provenance: 'setup',
          createdAt: now(),
          updatedAt: now(),
        }),
      );
      const found = await db.associations.findBySessionId(worker.id);
      assert.strictEqual(found.length, 1);
      assert.strictEqual(found[0].provenance, 'setup');
      db.close();
    });
  });
});
