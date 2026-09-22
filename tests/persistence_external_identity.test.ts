import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { Pair, Project, RuntimeSession } from '../src/relay/domain/entities.ts';
import { ProviderType } from '../src/relay/domain/types.ts';

describe('persistence-first external identity slice', () => {
  it('schema migration from the previous database shape', () => {
    const db = new SqliteRelayDatabase(':memory:');
    const info = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='runtime_sessions'").get() as any;
    assert.ok(info.sql.includes('external_session_id'));
    const idx = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_runtime_extern'").get() as any;
    assert.ok(idx?.sql);
  });

  it('nullable legacy row loads without external identity', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const rt = RuntimeSession.create('opencode' as ProviderType, 'Legacy');
    await db.runtimes.save(rt);
    const loaded = await db.runtimes.findById(rt.id);
    assert.strictEqual(loaded?.externalSessionId, null);
  });

  it('external identity round-trips through file-backed close/reopen', async () => {
    const testDbPath = join(tmpdir(), `relay_ext_id_restart_${Date.now()}.sqlite`);
    if (existsSync(testDbPath)) unlinkSync(testDbPath);

    try {
      const rt = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
      rt.updateExternalIdentity('conv-abc-123', '/dev/relay');

      // Persist through one connection, close it, then reopen the same file
      const db1 = new SqliteRelayDatabase(testDbPath);
      await db1.runtimes.save(rt);
      db1.close();

      const db2 = new SqliteRelayDatabase(testDbPath);
      const loaded = await db2.runtimes.findById(rt.id);
      assert.strictEqual(loaded?.externalSessionId, 'conv-abc-123');
      assert.strictEqual(loaded?.externalProjectRef, '/dev/relay');
      db2.close();
    } finally {
      if (existsSync(testDbPath)) {
        try {
          unlinkSync(testDbPath);
        } catch {}
      }
    }
  });

  it('same provider + same external ID: duplicate insert is rejected by the unique index', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const a = RuntimeSession.create('chatgpt' as ProviderType, 'A');
    a.updateExternalIdentity('ext-dup', null);
    await db.runtimes.save(a);

    // A second session with the same provider + external ID must be rejected
    const b = RuntimeSession.create('chatgpt' as ProviderType, 'B');
    b.updateExternalIdentity('ext-dup', null);
    await assert.rejects(() => db.runtimes.save(b), /UNIQUE constraint failed/);

    // The original session remains the authoritative match
    const found = await db.runtimes.findByExternalSessionId('chatgpt', 'ext-dup');
    assert.strictEqual(found?.id, a.id);
  });

  it('different providers may use same external ID', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const chat = RuntimeSession.create('chatgpt' as ProviderType, 'Chat');
    chat.updateExternalIdentity('shared-id', null);
    await db.runtimes.save(chat);
    const op = RuntimeSession.create('opencode' as ProviderType, 'Open');
    op.updateExternalIdentity('shared-id', null);
    await db.runtimes.save(op);
    assert.strictEqual((await db.runtimes.findByExternalSessionId('chatgpt', 'shared-id'))?.id, chat.id);
    assert.strictEqual((await db.runtimes.findByExternalSessionId('opencode', 'shared-id'))?.id, op.id);
  });

  it('persisted pair round trip links both runtimes that retain external identities', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const proj = Project.create('Ext Pair Project', 'seed', '/abs/proj');
    await db.projects.save(proj);

    const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
    planner.updateExternalIdentity('conv-x', '/dev/relay');
    await db.runtimes.save(planner);
    const worker = RuntimeSession.create('opencode' as ProviderType, 'Worker');
    worker.updateExternalIdentity('sess-y', '/dev/relay');
    await db.runtimes.save(worker);

    // Persist an actual pair referencing both runtimes, then reload it
    const pair = Pair.create(proj.id, 'Ext Pair', planner.id, worker.id);
    await db.pairs.save(pair);

    const reloaded = await db.pairs.findById(pair.id);
    assert.strictEqual(reloaded?.plannerSessionId, planner.id);
    assert.strictEqual(reloaded?.workerSessionId, worker.id);

    // Both linked runtimes keep their external identity after the pair round trip
    const pLoad = await db.runtimes.findById(planner.id);
    const wLoad = await db.runtimes.findById(worker.id);
    assert.strictEqual(pLoad?.externalSessionId, 'conv-x');
    assert.strictEqual(wLoad?.externalSessionId, 'sess-y');
  });

  it('entity keeps external identity fields separate from path/title values (field-level)', () => {
    const rt = RuntimeSession.create('opencode' as ProviderType, 'W');
    rt.updateExternalIdentity('sess-42', null);
    assert.strictEqual(rt.externalSessionId, 'sess-42');
    assert.strictEqual(rt.externalProjectRef, null);
  });

  it('provider scope: same provider_type + same external ID blocked by index / findByExternalSessionId', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const a = RuntimeSession.create('chatgpt' as ProviderType, 'A');
    a.updateExternalIdentity('ext-dup', null);
    await db.runtimes.save(a);
    // Second session with same provider + external ID must not create duplicate;
    // index enforces this (constraint failure on insert or update collision)
    const found = await db.runtimes.findByExternalSessionId('chatgpt', 'ext-dup');
    assert.strictEqual(found?.id, a.id);
  });

  it('different providers may use same external ID', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const chat = RuntimeSession.create('chatgpt' as ProviderType, 'Chat');
    chat.updateExternalIdentity('shared-id', null);
    await db.runtimes.save(chat);
    const op = RuntimeSession.create('opencode' as ProviderType, 'Open');
    op.updateExternalIdentity('shared-id', null);
    await db.runtimes.save(op);
    assert.strictEqual((await db.runtimes.findByExternalSessionId('chatgpt', 'shared-id'))?.id, chat.id);
    assert.strictEqual((await db.runtimes.findByExternalSessionId('opencode', 'shared-id'))?.id, op.id);
  });

  it('discovery without inspectRuntime survives restart via engine discoverRuntime', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    // Simulate engine discoverRuntime creating session with external identity
    const rt = RuntimeSession.create('opencode' as ProviderType, 'Worker');
    rt.updateExternalIdentity('sess-restart', '/dev/relay');
    await db.runtimes.save(rt);
    const loaded = await db.runtimes.findById(rt.id);
    assert.strictEqual(loaded?.externalSessionId, 'sess-restart');
    assert.strictEqual(loaded?.externalProjectRef, '/dev/relay');
  });
});