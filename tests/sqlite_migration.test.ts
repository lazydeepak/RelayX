import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { Project } from '../src/relay/domain/entities.ts';

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
      assert.strictEqual(versionCheck.user_version, 1);

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
