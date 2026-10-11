import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { Pair, Project, RuntimeSession, RelayEvent, Attempt } from '../src/relay/domain/entities.ts';
import { ProviderType, EventId, AttemptId, AssignmentId, PairId, RuntimeSessionId } from '../src/relay/domain/types.ts';

describe('RelayX SQLite Migration & Legacy Schema Upgrade', () => {
  it('repairs relay_ingress for an already-versioned v6 database', () => {
    const testDbPath = join(tmpdir(), `relay_ingress_repair_${Date.now()}.sqlite`);
    let db: SqliteRelayDatabase | undefined;
    try {
      db = new SqliteRelayDatabase(testDbPath);
      db.db.exec('DROP TABLE relay_ingress; PRAGMA user_version = 6;');
      db.close(); db = undefined;
      db = new SqliteRelayDatabase(testDbPath);
      assert.strictEqual(db.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='relay_ingress'").get()?.n,1);
      assert.deepStrictEqual(db.db.prepare('SELECT * FROM relay_ingress').all(),[]);
      assert.strictEqual(db.db.prepare('PRAGMA user_version').get()?.user_version,6);
    } finally { db?.close(); if (existsSync(testDbPath)) unlinkSync(testDbPath); }
  });
  it('repairs missing identity anchors in v6 files without rewriting identities or permissions', () => {
    const testDbPath = join(tmpdir(), `relay_identity_repair_${Date.now()}.sqlite`);
    let db: SqliteRelayDatabase | undefined;
    try {
      db = new SqliteRelayDatabase(testDbPath);
      db.db.exec(`
        INSERT INTO projects (id, name, created_at, updated_at) VALUES ('project', 'Project', 1, 1);
        INSERT INTO pairs (id, project_id, name, status, operational_state, stable_pair_id, created_at, updated_at)
        VALUES ('missing', 'project', 'Missing', 'idle', 'IDLE', NULL, 1, 1),
               ('empty', 'project', 'Empty', 'idle', 'IDLE', '', 1, 1),
               ('bound', 'project', 'Bound', 'idle', 'ACTIVE', 'original-anchor', 1, 1);
      `);
      db.close();
      db = undefined;
      for (let reopen = 0; reopen < 2; reopen++) {
        db = new SqliteRelayDatabase(testDbPath);
        const rows = db.db.prepare('SELECT id, stable_pair_id, operational_state FROM pairs ORDER BY id').all();
        assert.deepStrictEqual(rows.map(row => ({ ...row })), [
          { id: 'bound', stable_pair_id: 'original-anchor', operational_state: 'ACTIVE' },
          { id: 'empty', stable_pair_id: 'empty', operational_state: 'IDLE' },
          { id: 'missing', stable_pair_id: 'missing', operational_state: 'IDLE' },
        ]);
        assert.strictEqual(db.db.prepare('PRAGMA user_version').get()?.user_version, 6);
        db.close();
        db = undefined;
      }
    } finally {
      db?.close();
      if (existsSync(testDbPath)) unlinkSync(testDbPath);
    }
  });

  it('migrates an old Relay database schema (missing canonical_path, git_root, archived_at, etc.), preserves data, and supports Add Project', async () => {
    const testDbPath = join(tmpdir(), `relay_legacy_migration_test_${Date.now()}.sqlite`);
    if (existsSync(testDbPath)) unlinkSync(testDbPath);

    try {
      // 1. Create an OLD Relay database schema manually (v0 schema without canonical_path, git_root, archived_at, etc.)
      const rawDb = new DatabaseSync(testDbPath);
      rawDb.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE runtime_sessions (
          id TEXT PRIMARY KEY,
          provider_type TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        PRAGMA user_version = 0;
      `);

      // Insert legacy records into the old schema
      const legacyProjId = 'proj_legacy_123';
      const now = Date.now();
      rawDb.prepare(
        'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(legacyProjId, 'Legacy Project Name', 'Created in v0 schema', now, now);

      const legacySessionId = 'sess_legacy_456';
      rawDb.prepare(
        'INSERT INTO runtime_sessions (id, provider_type, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(legacySessionId, 'chatgpt', 'Legacy Session', 'available', now, now);

      rawDb.close();

      // 2. Open the legacy database with SqliteRelayDatabase (triggering migration)
      const db = new SqliteRelayDatabase(testDbPath);

      // 3. Verify existing records survived and schema was upgraded
      const recoveredProject = await db.projects.findById(legacyProjId as any);
      assert.ok(recoveredProject, 'Legacy project must survive migration');
      assert.strictEqual(recoveredProject.name, 'Legacy Project Name');
      assert.strictEqual(recoveredProject.description, 'Created in v0 schema');
      assert.strictEqual(recoveredProject.canonicalPath, undefined);

      const recoveredSession = await db.runtimes.findById(legacySessionId as any);
      assert.ok(recoveredSession, 'Legacy runtime session must survive migration');
      assert.strictEqual(recoveredSession.name, 'Legacy Session');
      assert.strictEqual(recoveredSession.status, 'available');

      // 4. Test Add Project against the migrated DB (using new canonical_path and git_root fields)
      const newProject = Project.create('New Upgraded Project', 'Added post-migration', '/absolute/path/to/project', '/absolute/path/to/project');
      await db.projects.save(newProject);

      const loadedNewProject = await db.projects.findById(newProject.id);
      assert.ok(loadedNewProject, 'Newly added project must be saved and retrieved successfully');
      assert.strictEqual(loadedNewProject.name, 'New Upgraded Project');
      assert.strictEqual(loadedNewProject.canonicalPath, '/absolute/path/to/project');
      assert.strictEqual(loadedNewProject.gitRoot, '/absolute/path/to/project');

      // Test findByPath
      const foundByPath = await db.projects.findByPath('/absolute/path/to/project');
      assert.ok(foundByPath, 'Project must be queryable by canonical_path on migrated DB');
      assert.strictEqual(foundByPath.id, newProject.id);

      // Verify user_version is updated.
      // v3 is the Plan-First execution-domain schema version
      // (PLAN_FIRST_DOMAIN_FREEZE.md §E.5); v4 is the Session Pair operations
      // schema (DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §10.2); v5 is the
      // per-side identity evidence table (same freeze §10.3, S5); v6 is the S2
      // observation dimensions on that same table. A v0 database must migrate all
      // the way up.
      const versionCheck = db.db.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.strictEqual(versionCheck.user_version, 6);

      // The Plan-First tables must exist after migrating from v0.
      const pfTables = (
        db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((t) => t.name);
      for (const table of ['contract_revisions', 'plan_first_runs', 'work_units']) {
        assert.ok(pfTables.includes(table), `${table} must exist after migration to v3`);
      }

      db.close();
    } finally {
      if (existsSync(testDbPath)) {
        try {
          unlinkSync(testDbPath);
        } catch {}
      }
    }
  });

  it('migrated database nullifies pair session references when runtimes are deleted (orphan triggers)', async () => {
    const testDbPath = join(tmpdir(), `relay_orphan_trigger_test_${Date.now()}.sqlite`);
    if (existsSync(testDbPath)) unlinkSync(testDbPath);

    try {
      // Start from a v0 schema so the v0 -> v2 migration (incl. orphan triggers) runs.
      const rawDb = new DatabaseSync(testDbPath);
      rawDb.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE runtime_sessions (
          id TEXT PRIMARY KEY,
          provider_type TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        PRAGMA user_version = 0;
      `);
      rawDb.close();

      const db = new SqliteRelayDatabase(testDbPath);

      // 1. The orphan-nullification triggers must exist after migration
      const triggerNames = (
        db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]
      ).map((t) => t.name);
      assert.ok(triggerNames.includes('set_null_planner_session'), 'planner trigger must exist');
      assert.ok(triggerNames.includes('set_null_worker_session'), 'worker trigger must exist');

      // 2. Deleting a runtime must nullify pair references (never delete the pair)
      const proj = Project.create('Orphan Project', 'seed', '/abs/proj');
      await db.projects.save(proj);

      const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
      const worker = RuntimeSession.create('opencode' as ProviderType, 'Worker');
      await db.runtimes.save(planner);
      await db.runtimes.save(worker);

      const pair = Pair.create(proj.id, 'Orphan Pair', planner.id, worker.id);
      await db.pairs.save(pair);

      await db.runtimes.delete(planner.id);
      const afterPlannerDelete = await db.pairs.findById(pair.id);
      assert.ok(afterPlannerDelete, 'pair must survive planner runtime deletion');
      assert.strictEqual(afterPlannerDelete?.plannerSessionId, undefined);
      assert.strictEqual(afterPlannerDelete?.workerSessionId, worker.id);

      await db.runtimes.delete(worker.id);
      const afterWorkerDelete = await db.pairs.findById(pair.id);
      assert.ok(afterWorkerDelete, 'pair must survive worker runtime deletion');
      assert.strictEqual(afterWorkerDelete?.workerSessionId, undefined);

      db.close();
    } finally {
      if (existsSync(testDbPath)) {
        try {
          unlinkSync(testDbPath);
        } catch {}
      }
    }
  });

  it('fresh database creation completes the full migration chain (version, triggers, index, Plan-First schema)', async () => {
    const db = new SqliteRelayDatabase(':memory:');

    const version = (db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.strictEqual(version, 6);

    // Plan-First schema must be present on a fresh database too.
    const pfTables = (
      db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((t) => t.name);
    for (const table of ['contract_revisions', 'plan_first_runs', 'work_units']) {
      assert.ok(pfTables.includes(table), `${table} must exist on a fresh database`);
    }

    const triggerNames = (
      db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]
    ).map((t) => t.name);
    assert.ok(triggerNames.includes('set_null_planner_session'), 'planner trigger must exist on fresh DB');
    assert.ok(triggerNames.includes('set_null_worker_session'), 'worker trigger must exist on fresh DB');

    const idx = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_runtime_extern'").get() as { sql: string } | undefined;
    assert.ok(idx?.sql, 'external-identity unique index must exist on fresh DB');

    // Nullification also applies on a fresh database
    const proj = Project.create('Fresh Project', 'seed');
    await db.projects.save(proj);
    const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
    await db.runtimes.save(planner);
    const pair = Pair.create(proj.id, 'Fresh Pair', planner.id);
    await db.pairs.save(pair);

    await db.runtimes.delete(planner.id);
    const reloaded = await db.pairs.findById(pair.id);
    assert.ok(reloaded, 'pair must survive runtime deletion on fresh DB');
    assert.strictEqual(reloaded?.plannerSessionId, undefined);

    db.close();
  });

  it('upgrades a v1-stamped database to v2 (skips the v0 step, stamps 2, gains triggers)', async () => {
    const testDbPath = join(tmpdir(), `relay_v1_upgrade_test_${Date.now()}.sqlite`);
    if (existsSync(testDbPath)) unlinkSync(testDbPath);

    try {
      // Simulate a database left by the v1-era code: no orphan triggers and user_version = 1.
      // Opening it must run only the v1 -> v2 step (the column audit is version-independent).
      const rawDb = new DatabaseSync(testDbPath);
      rawDb.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE runtime_sessions (
          id TEXT PRIMARY KEY,
          provider_type TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        PRAGMA user_version = 1;
      `);
      const legacyProjId = 'proj_v1_789';
      const now = Date.now();
      rawDb.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(legacyProjId, 'V1 Project', 'Created while on user_version 1', now, now);
      rawDb.close();

      const db = new SqliteRelayDatabase(testDbPath);

      const version = (db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      assert.strictEqual(version, 6);

      const triggerNames = (
        db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]
      ).map((t) => t.name);
      assert.ok(triggerNames.includes('set_null_planner_session'), 'planner trigger must exist after v1 -> v2 upgrade');
      assert.ok(triggerNames.includes('set_null_worker_session'), 'worker trigger must exist after v1 -> v2 upgrade');

      // v1-era data must survive the upgrade
      const recovered = await db.projects.findById(legacyProjId as any);
      assert.ok(recovered, 'v1-era project must survive the v1 -> v2 upgrade');
      assert.strictEqual(recovered.name, 'V1 Project');

      db.close();
    } finally {
      if (existsSync(testDbPath)) {
        try {
          unlinkSync(testDbPath);
        } catch {}
      }
    }
  });

  it('migrates an existing database with legacy events table (missing severity/area/is_archived) and legacy attempts table', async () => {
    const testDbPath = join(tmpdir(), `relay_legacy_events_migration_${Date.now()}.sqlite`);
    if (existsSync(testDbPath)) unlinkSync(testDbPath);

    try {
      // 1. Construct an older database where events was created before severity/area/outcome/is_archived existed,
      // and attempts was created before session_pair_id/worker_session_id/external_session_id existed.
      const rawDb = new DatabaseSync(testDbPath);
      rawDb.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          canonical_path TEXT,
          git_root TEXT,
          planner_project_url TEXT,
          worker_workspace_path TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE runtime_sessions (
          id TEXT PRIMARY KEY,
          provider_type TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE pairs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          planner_session_id TEXT REFERENCES runtime_sessions(id),
          worker_session_id TEXT REFERENCES runtime_sessions(id),
          active_assignment_id TEXT,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE assignments (
          id TEXT PRIMARY KEY,
          pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          instruction TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- Legacy attempts table without session_pair_id, worker_session_id, external_session_id, repo_baseline_json, repo_observation_json
        CREATE TABLE attempts (
          id TEXT PRIMARY KEY,
          assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
          attempt_number INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          failure_reason TEXT,
          evidence_json TEXT
        );

        -- Legacy events table without severity, area, outcome, is_archived
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          actor TEXT NOT NULL,
          previous_state TEXT,
          new_state TEXT,
          evidence_json TEXT,
          correlation_id TEXT,
          details_json TEXT
        );

        PRAGMA user_version = 2;
      `);

      const now = Date.now();
      const projId = 'proj_mig_1';
      const pairId = 'pair_mig_1';
      const assignId = 'assign_mig_1';
      const attemptId = 'attempt_mig_1';
      const legacyEvent1Id = 'evt_legacy_001';
      const legacyEvent2Id = 'evt_legacy_002';

      rawDb.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(projId, 'Migration Project', now, now);
      rawDb.prepare('INSERT INTO pairs (id, project_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(pairId, projId, 'Migration Pair', 'active', now, now);
      rawDb.prepare('INSERT INTO assignments (id, pair_id, project_id, title, instruction, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(assignId, pairId, projId, 'Task', 'Do work', 'active', now, now);
      rawDb.prepare('INSERT INTO attempts (id, assignment_id, attempt_number, status, started_at) VALUES (?, ?, ?, ?, ?)').run(attemptId, assignId, 1, 'running', now);

      rawDb.prepare(`
        INSERT INTO events (id, timestamp, resource_type, resource_id, event_type, actor, correlation_id, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(legacyEvent1Id, now - 1000, 'project', projId, 'project.created', 'user', 'corr_1', JSON.stringify({ key: 'val1' }));

      rawDb.prepare(`
        INSERT INTO events (id, timestamp, resource_type, resource_id, event_type, actor, correlation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(legacyEvent2Id, now - 500, 'pair', pairId, 'pair.created', 'engine', 'corr_2');

      rawDb.close();

      // 2. Open with SqliteRelayDatabase — this runs initSchema() on the older database!
      // Previously, this threw: Unhandled Rejection: Error: no such column: severity
      const db = new SqliteRelayDatabase(testDbPath);

      // 3. Verify legacy events survived and were safely upgraded with correct defaults
      const ev1 = await db.events.findById(legacyEvent1Id as EventId);
      assert.ok(ev1, 'Legacy event 1 must survive migration');
      assert.strictEqual(ev1.severity, 'info', 'Legacy event must default severity to info');
      assert.strictEqual(ev1.area, 'engine', 'Legacy event area defaults to engine as per schema');
      assert.strictEqual(ev1.isArchived, false, 'Legacy event must default isArchived to false');
      assert.strictEqual(ev1.correlationId, 'corr_1');

      const ev2 = await db.events.findById(legacyEvent2Id as EventId);
      assert.ok(ev2, 'Legacy event 2 must survive migration');
      assert.strictEqual(ev2.severity, 'info');
      assert.strictEqual(ev2.isArchived, false);

      // 4. Verify indexes were created and exist in the database
      const indexes = (
        db.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
      ).map((i) => i.name);
      assert.ok(indexes.includes('idx_events_severity'), 'idx_events_severity must exist');
      assert.ok(indexes.includes('idx_events_area'), 'idx_events_area must exist');
      assert.ok(indexes.includes('idx_events_archived'), 'idx_events_archived must exist');

      // 5. Test filtered query on upgraded events
      const filtered = await db.events.findFiltered({ severity: 'info' });
      assert.ok(filtered.total >= 2, 'Filtered query by severity must find legacy events');

      // 6. Test inserting a new event with explicit non-default severity/area
      const newEvent = RelayEvent.create('assignment', assignId, 'assignment.dispatched', {
        severity: 'warn',
        area: 'supervisor',
        actor: 'supervisor',
      });
      await db.events.save(newEvent);

      const loadedNewEvent = await db.events.findById(newEvent.id);
      assert.ok(loadedNewEvent, 'New event must be saved');
      assert.strictEqual(loadedNewEvent.severity, 'warn');
      assert.strictEqual(loadedNewEvent.area, 'supervisor');

      // 7. Verify legacy attempts survived and upgraded columns are functional
      const legacyAttempt = await db.attempts.findById(attemptId as AttemptId);
      assert.ok(legacyAttempt, 'Legacy attempt must survive migration');
      assert.ok(!legacyAttempt.sessionPairId, 'Legacy attempt has no session pair initially');

      // Save an attempt with newly added columns populated
      const newAttempt = Attempt.create(assignId as AssignmentId, 2, {
        sessionPairId: pairId as PairId,
        workerSessionId: 'sess_wk_1' as RuntimeSessionId,
        externalSessionId: 'ext_ses_1',
      });
      await db.attempts.save(newAttempt);

      const reloadedAttempt = await db.attempts.findById(newAttempt.id);
      assert.ok(reloadedAttempt, 'Attempt must be reloaded');
      assert.strictEqual(reloadedAttempt.sessionPairId, pairId);
      assert.strictEqual(reloadedAttempt.workerSessionId, 'sess_wk_1');
      assert.strictEqual(reloadedAttempt.externalSessionId, 'ext_ses_1');

      db.close();

      // 8. Test Idempotency: Re-opening the upgraded database must succeed without errors
      const reopenedDb = new SqliteRelayDatabase(testDbPath);
      const recheckedEv = await reopenedDb.events.findById(legacyEvent1Id as EventId);
      assert.ok(recheckedEv, 'Event must still exist after idempotent reopen');
      assert.strictEqual(recheckedEv.severity, 'info');
      reopenedDb.close();
    } finally {
      if (existsSync(testDbPath)) {
        try {
          unlinkSync(testDbPath);
        } catch {}
      }
    }
  });
});
