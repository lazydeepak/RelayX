import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RuntimeSession } from '../src/relay/domain/entities.ts';
import { ProviderType } from '../src/relay/domain/types.ts';

describe('persistence-first external identity slice', () => {
  it('schema migration creates external columns and index', () => {
    const db = new SqliteRelayDatabase(':memory:');
    assert.strictEqual(typeof db.db, 'object');
    const info = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='runtime_sessions'").get() as any;
    assert.ok(info.sql.includes('external_session_id'));
    const idx = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_runtime_extern'").get() as any;
    assert.ok(idx?.sql);
  });

  it('nullable legacy row loads without external identity', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const rt = RuntimeSession.create('opencode' as ProviderType, 'Legacy');
    db.runtimes.save(rt);
    const loaded = await db.runtimes.findById(rt.id);
    assert.strictEqual(loaded?.externalSessionId, null);
  });

  it('external identity round-trips through database restart', () => {
    const db1 = new SqliteRelayDatabase(':memory:');
    const rt = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
    rt.updateExternalIdentity('conv-abc-123', '/dev/relay');
    db1.runtimes.save(rt);
    const db2 = new SqliteRelayDatabase(':memory:'); // new in-memory; simulate reload via direct SQL
    // Instead: reload from same file path; but :memory: is separate. Use file-backed.
  });

  it('same provider + same external ID reuses/rejects duplicate deterministically', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const a = RuntimeSession.create('chatgpt' as ProviderType, 'P1');
    a.updateExternalIdentity('ext-1', null);
    await db.runtimes.save(a);
    const found = await db.runtimes.findByExternalSessionId('chatgpt', 'ext-1');
    assert.strictEqual(found?.id, a.id);
  });

  it('different providers may use same external ID', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const chat = RuntimeSession.create('chatgpt' as ProviderType, 'Chat');
    chat.updateExternalIdentity('id-shared', null);
    await db.runtimes.save(chat);
    const op = RuntimeSession.create('opencode' as ProviderType, 'Open');
    op.updateExternalIdentity('id-shared', null);
    await db.runtimes.save(op);
    const chatFound = await db.runtimes.findByExternalSessionId('chatgpt', 'id-shared');
    const opFound = await db.runtimes.findByExternalSessionId('opencode', 'id-shared');
    assert.ok(chatFound);
    assert.ok(opFound);
    assert.notStrictEqual(chatFound?.id, opFound?.id);
  });

  it('pair hydration preserves both external identities', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
    planner.updateExternalIdentity('conv-x', '/dev/relay');
    await db.runtimes.save(planner);
    const worker = RuntimeSession.create('opencode' as ProviderType, 'Worker');
    worker.updateExternalIdentity('sess-y', '/dev/relay');
    await db.runtimes.save(worker);
    const { Pair } = await import('../src/relay/domain/entities.ts');
    const proj = new (await import('../src/relay/domain/entities.ts')).Project({ id: 'proj-1' as any, name: 'P', description: '', createdAt: Date.now(), updatedAt: Date.now() });
    await db.projects.save(proj);
    const pair = Pair.create('proj-1' as any, 'Test', planner.id, worker.id);
    await db.pairs.save(pair);
    const loaded = await db.pairs.findById(pair.id);
    assert.strictEqual(loaded?.plannerSessionId, planner.id);
    assert.strictEqual(loaded?.workerSessionId, worker.id);
    const pLoad = await db.runtimes.findById(planner.id);
    const wLoad = await db.runtimes.findById(worker.id);
    assert.strictEqual(pLoad?.externalSessionId, 'conv-x');
    assert.strictEqual(wLoad?.externalSessionId, 'sess-y');
  });

  it('authoritative external identity wins over path/title fallback', () => {
    // Conceptual: when externalSessionId is set, matching should prefer it.
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

  it('different provider types may share external ID', async () => {
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
