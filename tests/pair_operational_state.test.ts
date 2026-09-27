/**
 * S1 — Session Pair operational semantics.
 *
 * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md
 *   I-1  persistent operational state is exactly two values
 *   I-2  IDLE means zero external provider contact
 *   I-3  IDLE displays persisted evidence only
 *   I-4  ACTIVE permits, but does not imply, activity
 *   I-5  readiness is derived, never persisted as authority
 *   I-10 Make Idle preserves everything
 *   §4.1 the two orthogonal dimensions and the single-source-of-truth rule
 *   §4.2 transitions; no third persisted value
 *   §4.5 Make Idle is idempotent and preserves everything
 *   §10.2 additive schema step
 *   §17.2 single owner per dimension
 *   §17.3 existing Pairs backfill to IDLE
 *
 * This suite proves the persisted MODEL only. It does not implement Load &
 * Activate, readiness, observation, or supervision (S2-S8).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import {
  Pair,
  Assignment,
  Project,
  RuntimeSession,
  RuntimeProjectAssociation,
} from '../src/relay/domain/entities.ts';
import {
  PAIR_OPERATIONAL_STATES,
  DEFAULT_PAIR_OPERATIONAL_STATE,
  isPairOperationalState,
  PairId,
  ProjectId,
  RuntimeSessionId,
  ProviderType,
  PairOperationalState,
  ObservableEvidence,
} from '../src/relay/domain/types.ts';
import { MockProvider } from './MockProvider.ts';

/**
 * Counts every provider capability invocation, so a test can prove that an
 * operation contacted nothing external. This is the executable form of I-2.
 */
class CountingProvider extends MockProvider {
  public readonly calls: string[] = [];

  get totalCalls(): number {
    return this.calls.length;
  }

  reset(): void {
    this.calls.length = 0;
  }

  async findRuntime(descriptor: any): Promise<any> {
    this.calls.push('findRuntime');
    return super.findRuntime(descriptor);
  }
  async findAllRuntimes(): Promise<any> {
    this.calls.push('findAllRuntimes');
    return super.findAllRuntimes();
  }
  async matchSessionsByPath(projectPath: string, gitRoot?: string): Promise<any> {
    this.calls.push('matchSessionsByPath');
    return super.matchSessionsByPath(projectPath, gitRoot);
  }
  async inspectRuntime(id: RuntimeSessionId): Promise<any> {
    this.calls.push('inspectRuntime');
    return super.inspectRuntime(id);
  }
  async activateRuntime(id: RuntimeSessionId): Promise<any> {
    this.calls.push('activateRuntime');
    return super.activateRuntime(id);
  }
  async deliverInstruction(req: any): Promise<any> {
    this.calls.push('deliverInstruction');
    return super.deliverInstruction(req);
  }
  async detectWorkingState(id: RuntimeSessionId): Promise<any> {
    this.calls.push('detectWorkingState');
    return super.detectWorkingState(id);
  }
  async detectCompletionState(id: RuntimeSessionId): Promise<any> {
    this.calls.push('detectCompletionState');
    return super.detectCompletionState(id);
  }
  async captureEvidence(id: RuntimeSessionId, action: string): Promise<any> {
    this.calls.push('captureEvidence');
    return super.captureEvidence(id, action);
  }
}

function freshDb(): SqliteRelayDatabase {
  return new SqliteRelayDatabase(':memory:');
}

async function seedProject(db: SqliteRelayDatabase, name: string, path: string): Promise<Project> {
  const project = Project.create(name, '', path, path);
  await db.projects.save(project);
  return project;
}

function pathOf(externalSessionId: string): string {
  return externalSessionId.startsWith('ses_') ? '/dev/s1' : 'https://chatgpt.com/g/g-p-s1';
}

async function seedRuntime(
  db: SqliteRelayDatabase,
  providerType: ProviderType,
  name: string,
  externalSessionId: string,
  projectId: ProjectId,
): Promise<RuntimeSession> {
  const runtime = RuntimeSession.create(providerType, name);
  runtime.updateExternalIdentity(externalSessionId, pathOf(externalSessionId));
  await db.runtimes.save(runtime);
  await db.associations.save(
    RuntimeProjectAssociation.create(
      runtime.id,
      projectId,
      externalSessionId,
      'verified',
      'adoption',
      providerType,
    ),
  );
  return runtime;
}

describe('S1 — Pair operational state is exactly IDLE | ACTIVE (I-1, §4.1, §4.2)', () => {
  it('declares exactly two operational values and no third', () => {
    assert.deepStrictEqual([...PAIR_OPERATIONAL_STATES], ['IDLE', 'ACTIVE']);
    assert.strictEqual(PAIR_OPERATIONAL_STATES.length, 2);
  });

  it('defaults a new Pair to IDLE, never to ACTIVE (§17.3)', () => {
    const pair = Pair.create('proj_1' as ProjectId, 'Default Pair');
    assert.strictEqual(pair.operationalState, 'IDLE');
    assert.strictEqual(DEFAULT_PAIR_OPERATIONAL_STATE, 'IDLE');
  });

  it('a Pair constructed without an operational value reads IDLE', () => {
    const pair = new Pair({
      id: 'pair_legacy' as PairId,
      projectId: 'proj_1' as ProjectId,
      name: 'Legacy Shape',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    });
    assert.strictEqual(pair.operationalState, 'IDLE');
  });

  it('rejects a third persisted value at construction', () => {
    assert.throws(
      () =>
        new Pair({
          id: 'pair_bad' as PairId,
          projectId: 'proj_1' as ProjectId,
          name: 'Activating',
          status: 'idle',
          // 'ACTIVATING' is exactly the transient value I-1 prohibits.
          operationalState: 'ACTIVATING' as PairOperationalState,
          createdAt: 1,
          updatedAt: 1,
        }),
      /must be exactly IDLE or ACTIVE/,
    );
  });

  it('rejects a third value on assignment, so it is unrepresentable rather than discouraged', () => {
    const pair = Pair.create('proj_1' as ProjectId, 'Unforgeable');
    for (const bogus of ['ACTIVATING', 'LOADING', 'checking', 'READY', 'ready', 'idle', 'active', '']) {
      assert.throws(
        () => {
          pair.operationalState = bogus as PairOperationalState;
        },
        /must be exactly IDLE or ACTIVE/,
        `'${bogus}' must not be assignable as an operational state`,
      );
      assert.strictEqual(pair.operationalState, 'IDLE', 'a rejected value must not be applied');
    }
  });

  it('exposes a runtime guard that is exact in both directions', () => {
    assert.strictEqual(isPairOperationalState('IDLE'), true);
    assert.strictEqual(isPairOperationalState('ACTIVE'), true);
    assert.strictEqual(isPairOperationalState('ACTIVATING'), false);
    assert.strictEqual(isPairOperationalState('idle'), false);
    assert.strictEqual(isPairOperationalState(undefined), false);
    assert.strictEqual(isPairOperationalState(null), false);
    assert.strictEqual(isPairOperationalState(1), false);
  });

  it('round-trips both values through SQLite without widening the set', async () => {
    const db = freshDb();
    try {
      const project = await seedProject(db, 'Fresh', '/dev/fresh');
      const pair = Pair.create(project.id, 'Round Trip');
      await db.pairs.save(pair);

      for (const state of ['ACTIVE', 'IDLE', 'ACTIVE'] as PairOperationalState[]) {
        pair.operationalState = state;
        await db.pairs.save(pair);
        const reloaded = await db.pairs.findById(pair.id);
        assert.strictEqual(reloaded?.operationalState, state);
        assert.ok(isPairOperationalState(reloaded?.operationalState));
      }
    } finally {
      db.close();
    }
  });
});

describe('S1 — operational state and lifecycle state are orthogonal, one owner each (§4.1, §4.2, §17.2)', () => {
  it('lifecycle transitions never change operational state', async () => {
    const pair = Pair.create('proj_1' as ProjectId, 'Orthogonal');
    pair.makeActive();
    assert.strictEqual(pair.operationalState, 'ACTIVE');

    const assignment = Assignment.create(pair.id, 'proj_1' as ProjectId, 'Task', 'Instruction');
    pair.assignWork(assignment.id);
    assert.strictEqual(pair.operationalState, 'ACTIVE', 'assignWork must not touch operational state');
    assert.strictEqual(pair.status, 'active');

    pair.pause();
    assert.strictEqual(pair.operationalState, 'ACTIVE', 'a Pair may be ACTIVE and paused');
    assert.strictEqual(pair.status, 'paused');

    pair.resume();
    pair.clearWork();
    pair.archive();
    assert.strictEqual(pair.operationalState, 'ACTIVE', 'a Pair may be ACTIVE and archived');
    assert.strictEqual(pair.status, 'archived');

    pair.makeIdle();
    pair.unarchive();
    assert.strictEqual(pair.operationalState, 'IDLE');
    assert.strictEqual(pair.status, 'idle');
  });

  it('operational transitions never change lifecycle state or the work record (I-9, §4.2)', () => {
    const pair = Pair.create('proj_1' as ProjectId, 'Independent');
    const assignment = Assignment.create(pair.id, 'proj_1' as ProjectId, 'Task', 'Instruction');
    pair.assignWork(assignment.id);
    const statusBefore = pair.status;
    const activeAssignmentBefore = pair.activeAssignmentId;

    pair.makeActive();
    assert.strictEqual(pair.status, statusBefore, 'operational state must not move the lifecycle dimension');
    assert.strictEqual(pair.activeAssignmentId, activeAssignmentBefore);

    pair.makeIdle();
    assert.strictEqual(pair.status, statusBefore);
    assert.strictEqual(pair.activeAssignmentId, activeAssignmentBefore);
  });

  it('the deprecated status aliases cannot act as a second source of operational truth (U-6 retain)', () => {
    // `status` still carries 'idle'/'active' as deprecated aliases (U-6 resolved as
    // "retain", per the Plan-First precedent of refusing destructive change). The
    // frozen requirement is that operational state has exactly ONE source, so the
    // provider-contact gate must be blind to `status` entirely.
    const pair = Pair.create('proj_1' as ProjectId, 'Single Source');
    pair.makeActive();
    pair.status = 'paused';
    assert.strictEqual(pair.isProviderContactPermitted(), true, 'status must not be able to withdraw ACTIVE');

    pair.makeIdle();
    pair.status = 'active';
    assert.strictEqual(
      pair.isProviderContactPermitted(),
      false,
      'a stale/legacy status of "active" must NOT be able to grant provider contact',
    );
  });
});

describe('S1 — IDLE means zero external provider contact (I-2, I-3)', () => {
  it('an IDLE Pair refuses provider contact and an ACTIVE Pair permits it', () => {
    const pair = Pair.create('proj_1' as ProjectId, 'Gate');
    assert.strictEqual(pair.operationalState, 'IDLE');
    assert.strictEqual(pair.isProviderContactPermitted(), false);
    assert.throws(() => pair.assertProviderContactPermitted(), /Pair is IDLE/);

    pair.makeActive();
    assert.strictEqual(pair.isProviderContactPermitted(), true);
    assert.doesNotThrow(() => pair.assertProviderContactPermitted());
  });

  it('the gate ignores stale last-known runtime evidence, so an IDLE Pair cannot be talked into contact', async () => {
    const db = freshDb();
    try {
      const project = await seedProject(db, 'Stale', '/dev/stale');
      const planner = await seedRuntime(db, 'chatgpt', 'Planner', 'conv-stale', project.id);
      const worker = await seedRuntime(db, 'opencode', 'Worker', 'ses_stale', project.id);

      // Persisted provider information claiming everything is reachable right now.
      const freshEvidence = (id: string): ObservableEvidence => ({
        id,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: worker.id,
      });
      planner.recordObservationSuccess('working', { ...freshEvidence('ev_planner_working'), runtimeSessionId: planner.id });
      await db.runtimes.save(planner);
      worker.recordObservationSuccess('working', freshEvidence('ev_stale_working'));
      await db.runtimes.save(worker);

      const pair = Pair.create(project.id, 'Stale Pair', planner.id, worker.id);
      await db.pairs.save(pair);

      const reloaded = await db.pairs.findById(pair.id);
      assert.strictEqual(reloaded?.operationalState, 'IDLE');
      assert.strictEqual(reloaded?.isProviderContactPermitted(), false);
      assert.throws(() => reloaded!.assertProviderContactPermitted(), /last-known evidence only/);

      // Flipping every last-known signal to "definitely reachable" changes nothing.
      worker.recordObservationSuccess('available', freshEvidence('ev_stale_available'));
      await db.runtimes.save(worker);
      const stillIdle = await db.pairs.findById(pair.id);
      assert.strictEqual(stillIdle?.isProviderContactPermitted(), false);
      assert.strictEqual(
        (await db.runtimes.findById(worker.id))?.lastEvidence?.id,
        'ev_stale_available',
        'last-known evidence is retained as evidence (I-3), not used as a permission',
      );
    } finally {
      db.close();
    }
  });

  it('operational-state transitions contact no provider at all', async () => {
    const db = freshDb();
    const provider = new CountingProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(provider);
    try {
      const project = await seedProject(db, 'No Contact', '/dev/nocontact');
      const planner = await seedRuntime(db, 'chatgpt', 'Planner', 'conv-nc', project.id);
      const worker = await seedRuntime(db, 'opencode', 'Worker', 'ses_nc', project.id);
      const pair = Pair.create(project.id, 'No Contact Pair', planner.id, worker.id);
      await db.pairs.save(pair);

      provider.reset();

      pair.makeActive('operator');
      await db.pairs.save(pair);
      pair.makeIdle('operator');
      await db.pairs.save(pair);
      pair.makeIdle('operator is idempotent'); // §4.5
      await db.pairs.save(pair);

      assert.strictEqual(provider.totalCalls, 0, 'operational transitions must contact nothing');
      assert.deepStrictEqual(provider.calls, []);
    } finally {
      db.close();
    }
  });

  it('merely persisting, listing, and displaying a Pair contacts no provider', async () => {
    const db = freshDb();
    const provider = new CountingProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(provider);
    try {
      const project = await seedProject(db, 'Display', '/dev/display');
      const planner = await seedRuntime(db, 'chatgpt', 'Planner', 'conv-d', project.id);
      const worker = await seedRuntime(db, 'opencode', 'Worker', 'ses-d', project.id);
      const pair = await engine.createPair(project.id, 'Display Pair', planner.id, worker.id);

      provider.reset();

      // Read-only surfaces: the pair exists, is listed, and is re-read.
      await db.pairs.findById(pair.id);
      await db.pairs.findByProjectId(project.id);
      await db.pairs.findAll();

      assert.strictEqual(
        provider.totalCalls,
        0,
        'a Pair existing or being displayed must not contact the Planner or the Worker',
      );
      assert.strictEqual((await db.pairs.findById(pair.id))?.operationalState, 'IDLE');
    } finally {
      db.close();
    }
  });
});

describe('S1 — ACTIVE is a permission, not an activity level (I-4, I-5)', () => {
  it('ACTIVE implies neither execution, nor work in flight, nor readiness, nor polling', async () => {
    const db = freshDb();
    const provider = new CountingProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(provider);
    try {
      const project = await seedProject(db, 'Active Only', '/dev/activeonly');
      const planner = await seedRuntime(db, 'chatgpt', 'Planner', 'conv-ao', project.id);
      const worker = await seedRuntime(db, 'opencode', 'Worker', 'ses-ao', project.id);
      const pair = await engine.createPair(project.id, 'Active Only Pair', planner.id, worker.id);

      pair.makeActive();
      await db.pairs.save(pair);
      const active = await db.pairs.findById(pair.id);
      assert.strictEqual(active?.operationalState, 'ACTIVE');

      // No work is executing and no external record exists.
      assert.strictEqual(active?.activeAssignmentId, undefined);
      assert.deepStrictEqual(await db.assignments.findAll(), []);
      assert.deepStrictEqual(await db.assignments.findActive(), []);
      assert.deepStrictEqual(await db.deliveries.findUnresolved(), []);
      assert.deepStrictEqual(await db.handoffs.findPending(), []);

      // ACTIVE does not mean READY, and readiness is never persisted as authority (I-5).
      const keys = Object.keys(active as unknown as Record<string, unknown>);
      assert.ok(
        !keys.some((k) => /readi|ready|health|reachab|connect/i.test(k)),
        `no readiness-shaped field may be persisted on a Pair; found: ${keys.join(', ')}`,
      );

      // ACTIVE does not imply polling or observation.
      assert.strictEqual(engine.isSupervisingLoopActive(), false);
      assert.strictEqual(provider.totalCalls, 0, 'becoming ACTIVE must not start any observation');

      // The only record that exists is the internal creation fact, and it carries
      // no evidence: becoming ACTIVE asserted nothing about the outside world.
      const events = await db.events.findRecent();
      assert.deepStrictEqual(
        events.map((e) => e.eventType),
        ['pair.created'],
      );
      assert.strictEqual(events[0]!.evidence, undefined, 'no event may carry external-effect evidence');
    } finally {
      db.close();
    }
  });

  it('an IDLE Pair retains bindings, work record, and last-known evidence (I-10, §4.5)', async () => {
    const db = freshDb();
    try {
      const project = await seedProject(db, 'Preserve', '/dev/preserve');
      const planner = await seedRuntime(db, 'chatgpt', 'Planner', 'conv-p', project.id);
      const worker = await seedRuntime(db, 'opencode', 'Worker', 'ses_p', project.id);
      const pair = Pair.create(project.id, 'Preserved Pair', planner.id, worker.id);
      await db.pairs.save(pair);

      const assignment = Assignment.create(pair.id, project.id, 'Task', 'Instruction');
      await db.assignments.save(assignment);
      pair.assignWork(assignment.id);
      pair.makeActive();
      await db.pairs.save(pair);

      worker.lastEvidence = {
        id: 'ev_last_known',
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: worker.id,
      };
      await db.runtimes.save(worker);

      const before = await db.pairs.findById(pair.id);
      assert.ok(before);

      before!.makeIdle('operator stopped the pair');
      await db.pairs.save(before!);

      const after = await db.pairs.findById(pair.id);
      assert.ok(after);
      assert.strictEqual(after!.operationalState, 'IDLE');
      assert.strictEqual(after!.plannerSessionId, planner.id, 'planner binding is preserved');
      assert.strictEqual(after!.workerSessionId, worker.id, 'worker binding is preserved');
      assert.strictEqual(after!.activeAssignmentId, assignment.id, 'the work record is preserved');
      assert.strictEqual(after!.name, before!.name, 'nothing is destroyed or renamed');
      assert.strictEqual(after!.id, before!.id);
      assert.strictEqual(after!.stableId, before!.stableId);
      assert.strictEqual(after!.status, before!.status, 'Make Idle does not touch the lifecycle dimension');
      assert.strictEqual(
        (await db.runtimes.findById(worker.id))?.lastEvidence?.id,
        'ev_last_known',
        'last-known evidence is preserved, not cleared',
      );
      assert.strictEqual(
        (await db.assignments.findById(assignment.id))?.id,
        assignment.id,
        'assignment history is preserved',
      );

      // Idempotent (§4.5).
      after!.makeIdle('again');
      after!.makeIdle('and again');
      await db.pairs.save(after!);
      assert.strictEqual((await db.pairs.findById(pair.id))?.operationalState, 'IDLE');
      assert.strictEqual((await db.pairs.findById(pair.id))?.activeAssignmentId, assignment.id);
    } finally {
      db.close();
    }
  });
});

describe('S1/S6 — v4 operational-state and v5 side-identity migrations (additive, gated, backfill IDLE) (§10.2, §10.3, §17.1, §17.3)', () => {
  it('stamps user_version 5 on a fresh database and adds only the v4 columns plus the v5 table', () => {
    const db = freshDb();
    try {
      const version = (db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      assert.strictEqual(version, 5);

      const cols = (
        db.db.prepare("SELECT name FROM pragma_table_info('pairs')").all() as { name: string }[]
      ).map((c) => c.name);
      assert.ok(cols.includes('operational_state'));
      assert.ok(cols.includes('stable_pair_id'));
      // Additive only: nothing pre-existing was dropped.
      for (const preserved of [
        'id',
        'project_id',
        'name',
        'planner_session_id',
        'worker_session_id',
        'active_assignment_id',
        'status',
        'last_supervised_at',
        'created_at',
        'updated_at',
      ]) {
        assert.ok(cols.includes(preserved), `pre-existing pairs column ${preserved} must survive`);
      }

      // v5 adds one table and alters nothing. It is the S5 subset of the §10.3
      // `side_observations` proposal: dimensions 1-3 plus mandatory 8 and 9.
      const tables = (
        db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((t) => t.name);
      assert.ok(tables.includes('pair_side_identity'), 'v5 must create pair_side_identity');

      const sideCols = (
        db.db.prepare("SELECT name FROM pragma_table_info('pair_side_identity')").all() as { name: string }[]
      ).map((c) => c.name);
      for (const required of [
        'session_pair_id',
        'side_role',
        'provider_type',
        'identity_state',
        'verification_state',
        'existence_state',
        'capability',
        'source_capability', // §5.2 dimension 8 — mandatory
        'observed_at', // §5.2 dimension 9 — mandatory
      ]) {
        assert.ok(sideCols.includes(required), `pair_side_identity must carry ${required}`);
      }
      // I-5: no readiness column is persisted, and S3/S7 checkpoints are absent.
      for (const forbidden of ['readiness', 'is_ready', 'checkpoint', 'cursor']) {
        assert.ok(!sideCols.includes(forbidden), `pair_side_identity must NOT carry ${forbidden}`);
      }
    } finally {
      db.close();
    }
  });

  it('backfills pre-existing Pairs to IDLE and gives each a stable identity, preserving their rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay_s1_migration_'));
    const path = join(dir, 'legacy.sqlite');
    try {
      const raw = new DatabaseSync(path);
      raw.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
          canonical_path TEXT, git_root TEXT, planner_project_url TEXT,
          worker_workspace_path TEXT, status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE runtime_sessions (
          id TEXT PRIMARY KEY, provider_type TEXT NOT NULL, name TEXT NOT NULL,
          bundle_identifier TEXT, window_title TEXT, application_pid INTEGER,
          status TEXT NOT NULL, consecutive_observation_failures INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE pairs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          planner_session_id TEXT,
          worker_session_id TEXT,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        PRAGMA user_version = 0;
      `);
      const now = 1_700_000_000_000;
      raw
        .prepare('INSERT INTO projects (id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)')
        .run('proj_legacy', 'Legacy', 'kept', now, now);
      // Two pre-existing Pairs, one already in lifecycle 'active'. The deprecated
      // alias must NOT be promoted into an operational permission.
      const insert = raw.prepare(
        'INSERT INTO pairs (id,project_id,name,planner_session_id,worker_session_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      );
      insert.run('pair_a', 'proj_legacy', 'Legacy Idle Pair', null, null, 'idle', now, now);
      insert.run('pair_b', 'proj_legacy', 'Legacy Active Status', null, null, 'active', now, now);
      raw.close();

      const db = new SqliteRelayDatabase(path);
      try {
        assert.strictEqual((db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5);

        const rows = db.db
          .prepare('SELECT id, name, status, operational_state, stable_pair_id FROM pairs ORDER BY id')
          .all() as Array<Record<string, string>>;
        assert.strictEqual(rows.length, 2, 'no pre-existing Pair row may be dropped');
        for (const row of rows) {
          assert.strictEqual(
            row.operational_state,
            'IDLE',
            `${row.id} must backfill to IDLE: ACTIVE would grant an unjustifiable provider-contact permission`,
          );
          assert.strictEqual(row.stable_pair_id, row.id, 'stable identity backfills to the row id');
        }
        // Lifecycle data is untouched by the migration.
        assert.strictEqual(rows.find((r) => r.id === 'pair_a')?.status, 'idle');
        assert.strictEqual(rows.find((r) => r.id === 'pair_b')?.status, 'active');
        assert.strictEqual(rows.find((r) => r.id === 'pair_b')?.name, 'Legacy Active Status');
      } finally {
        db.close();
      }
    } finally {
      if (existsSync(path)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: reopening a migrated database never re-backfills a decided value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay_s1_idempotent_'));
    const path = join(dir, 'twice.sqlite');
    try {
      const first = new SqliteRelayDatabase(path);
      const project = Project.create('Twice', '', '/dev/twice', '/dev/twice');
      await first.projects.save(project);
      const pair = Pair.create(project.id, 'Twice Pair');
      await first.pairs.save(pair);
      pair.makeActive();
      await first.pairs.save(pair);
      first.close();

      const second = new SqliteRelayDatabase(path);
      try {
        assert.strictEqual((second.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5);
        const reloaded = await second.pairs.findById(pair.id);
        assert.strictEqual(reloaded?.operationalState, 'ACTIVE', 'a decided value is never re-backfilled');
        assert.strictEqual(reloaded?.stableId, pair.id);

        // A hand-corrupted third value is coerced to the one safe default rather
        // than admitted into the persisted set.
        second.db.prepare("UPDATE pairs SET operational_state = 'ACTIVATING' WHERE id = ?").run(pair.id);
        const coerced = await second.pairs.findById(pair.id);
        assert.strictEqual(coerced?.operationalState, 'IDLE');
        assert.ok(isPairOperationalState(coerced?.operationalState));
      } finally {
        second.close();
      }
    } finally {
      if (existsSync(path)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
