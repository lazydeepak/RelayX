import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { Pair, Project, RuntimeSession } from '../src/relay/domain/entities.ts';
import { ProviderType } from '../src/relay/domain/types.ts';

describe('Relay SQLite Migration & Legacy Schema Upgrade', () => {
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

      // Verify user_version is updated
      const versionCheck = db.db.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.strictEqual(versionCheck.user_version, 2);

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

  it('fresh database creation completes the v0->v2 migration (version, triggers, index)', async () => {
    const db = new SqliteRelayDatabase(':memory:');

    const version = (db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.strictEqual(version, 2);

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
      assert.strictEqual(version, 2);

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
});
