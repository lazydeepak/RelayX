import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase';
import { parseCatalog } from '../src/relay/model-intelligence/catalog';
import { refreshStoredCatalog } from '../src/relay/model-intelligence/refreshStoredCatalog';

const raw = '{"data":[{"id":"vendor/model","pricing":{"prompt":"0","completion":"0.00000000001"}}]}';
const snapshot = () => parseCatalog('OPENROUTER', raw, 100, '"v1"');
describe('durable catalog evidence in RelayX database', () => {
  it('adds the cache to a v6 database and preserves relay data across reopens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-catalog-')); let db: SqliteRelayDatabase | undefined;
    try {
      const path = join(dir, 'relay.sqlite'); db = new SqliteRelayDatabase(path);
      db.db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES ('project','Existing',1,1)");
      db.db.exec('DROP TABLE model_catalog_snapshots'); db.close(); db = new SqliteRelayDatabase(path);
      assert.equal(db.db.prepare('PRAGMA user_version').get()?.user_version, 6);
      db.modelCatalogs.save(snapshot()); db.close(); db = new SqliteRelayDatabase(path);
      assert.equal(db.db.prepare('SELECT name FROM projects WHERE id = ?').get('project')?.name, 'Existing');
      const restored = db.modelCatalogs.latest('OPENROUTER')!;
      assert.equal(restored.rawBody, raw); assert.equal(restored.fetchedAt, 100); assert.equal(restored.etag, '"v1"');
      assert.equal(restored.models[0].publishedPricing?.completion, '0.00000000001');
      assert.equal(db.modelCatalogs.latest('MODELS_DEV'), undefined);
    } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('is idempotent, append-only and rejects backwards/conflicting observations', () => {
    const db = new SqliteRelayDatabase();
    try {
      const first = snapshot(); db.modelCatalogs.save(first); db.modelCatalogs.save(first);
      db.modelCatalogs.save({ ...first, checkedAt: 200 });
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM model_catalog_snapshots').get()?.n, 2);
      assert.throws(() => db.modelCatalogs.save(first), /backwards/);
      assert.throws(() => db.modelCatalogs.save(parseCatalog('OPENROUTER', '{"data":[]}', 200)), /Conflicting/);
      assert.equal(db.modelCatalogs.latest('OPENROUTER')?.rawBody, raw);
    } finally { db.close(); }
  });
  it('rejects forged normalized prices, provenance and corrupt persisted evidence', () => {
    const db = new SqliteRelayDatabase();
    try {
      const value = snapshot(); value.models[0].publishedPricing!.completion = '0';
      assert.throws(() => db.modelCatalogs.save(value), /evidence mismatch/);
      const provenance = snapshot(); provenance.contentHash = 'forged';
      assert.throws(() => db.modelCatalogs.save(provenance), /evidence mismatch/);
      db.modelCatalogs.save(snapshot());
      db.db.prepare('UPDATE model_catalog_snapshots SET snapshot_json = ?').run(JSON.stringify(provenance));
      assert.throws(() => db.modelCatalogs.latest('OPENROUTER'), /evidence mismatch/);
    } finally { db.close(); }
  });
  it('participates in existing relay transactions without committing outer work', async () => {
    const db = new SqliteRelayDatabase();
    try {
      await assert.rejects(db.runInTransaction(async () => { db.modelCatalogs.save(snapshot()); throw new Error('abort'); }), /abort/);
      assert.equal(db.modelCatalogs.latest('OPENROUTER'), undefined);
      db.modelCatalogs.save(snapshot()); assert.ok(db.modelCatalogs.latest('OPENROUTER'));
    } finally { db.close(); }
  });
  it('rejects persisted index timestamps that disagree with evidence', () => {
    const db = new SqliteRelayDatabase();
    try {
      db.modelCatalogs.save(snapshot());
      db.db.exec('UPDATE model_catalog_snapshots SET checked_at = 300');
      assert.throws(() => db.modelCatalogs.latest('OPENROUTER'), /index mismatch/);
    } finally { db.close(); }
  });
  it('refreshes using durable ETag and retains old evidence during outage', async () => {
    const db = new SqliteRelayDatabase();
    try {
      db.modelCatalogs.save(snapshot());
      const result = await refreshStoredCatalog(db.modelCatalogs, 'OPENROUTER', { now: 200, signal: AbortSignal.timeout(1000), fetch: (async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>)['If-None-Match'], '"v1"');
        return new Response(null, { status: 304 });
      }) as typeof fetch });
      assert.equal(result.status, 'NOT_MODIFIED');
      assert.equal(db.modelCatalogs.latest('OPENROUTER')?.fetchedAt, 100);
      assert.equal(db.modelCatalogs.latest('OPENROUTER')?.checkedAt, 200);
      const failed = await refreshStoredCatalog(db.modelCatalogs, 'OPENROUTER', { now: 300, signal: AbortSignal.timeout(1000), fetch: (async () => new Response(null, { status: 429 })) as typeof fetch });
      assert.equal(failed.status, 'UNAVAILABLE');
      assert.equal(db.modelCatalogs.latest('OPENROUTER')?.checkedAt, 200);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM model_catalog_snapshots').get()?.n, 2);
    } finally { db.close(); }
  });
  it('surfaces persistence errors instead of claiming refresh success', async () => {
    await assert.rejects(refreshStoredCatalog({ latest: () => undefined, save: () => { throw new Error('disk full'); } }, 'OPENROUTER', {
      now: 100, signal: AbortSignal.timeout(1000), fetch: (async () => new Response(raw)) as typeof fetch,
    }), /disk full/);
  });
});
