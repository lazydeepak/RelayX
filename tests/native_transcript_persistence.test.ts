import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase';
import { compareNativeTranscriptPages, reconcileNativeTranscript, type NativeTranscriptPage } from '../src/relay/providers/nativeTranscriptReconciliation';

function register(db: SqliteRelayDatabase) {
  db.nativeServers.register({ serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED', authKeyRef: 'key-ref', projectRoots: ['/project'], registeredBy: 'operator', ownershipEvidenceRef: 'adoption', now: 100 });
  db.nativeServers.applyDiscovery('server', 1, 200, { status: 'INSPECTED', server: { serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED' },
    observedAt: 200, serverVersion: '1', apiVersion: '1', apiSpecHash: 'digest', rawApiSpec: '{}', providers: [], declaredOperations: [], dispatchAuthorized: false,
    compatibility: { sessionRead: true, messageRead: true, messageSend: false, questionRead: false, questionReply: false, eventStream: false, blockers: [] } });
}
function page(): NativeTranscriptPage {
  return { status: 'READ', serverId: 'server', serverRevision: 2, apiSpecHash: 'digest', observedAt: 250, session: { id: 'ses_exact', directory: '/project', title: 'Title' },
    messages: [{ id: 'msg_user', sessionId: 'ses_exact', role: 'user', createdAt: 200, providerId: 'provider', modelId: 'model', parts: [{ id: 'part_user', type: 'text', text: 'Instruction' }] },
      { id: 'msg_answer', sessionId: 'ses_exact', role: 'assistant', createdAt: 220, parentId: 'msg_user', providerId: 'provider', modelId: 'model', parts: [{ id: 'part_answer', type: 'text', text: 'Streaming' }] }], completeHistory: false };
}
describe('durable native transcript observations', () => {
  it('preserves partial observations across reopen and reconciles streaming revisions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-transcript-')); let db: SqliteRelayDatabase | undefined;
    try {
      const path = join(dir, 'relay.sqlite'); db = new SqliteRelayDatabase(path); register(db); db.nativeTranscripts.save(page());
      db.close(); db = new SqliteRelayDatabase(path);
      const previous = db.nativeTranscripts.latest('server', 'ses_exact', '/project')!;
      const next = page(); next.observedAt = 300; next.messages[1].parts[0].text = 'Final answer'; next.messages[1].completedAt = 280;
      assert.deepEqual(compareNativeTranscriptPages(previous, next), { added: [], changed: ['msg_answer'], unchanged: ['msg_user'], notInCurrentPage: [] });
      db.nativeTranscripts.save(next);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM native_transcript_observations').get()?.n, 2);
      const original = JSON.parse(String(db.db.prepare('SELECT page_json FROM native_transcript_observations ORDER BY observed_at LIMIT 1').get()?.page_json));
      assert.equal(original.messages[1].parts[0].text, 'Streaming');
      assert.equal(db.nativeTranscripts.latest('server', 'ses_other', '/project'), undefined);
      assert.equal(db.nativeTranscripts.latest('server', 'ses_exact', '/another'), undefined);
    } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('is idempotent and rejects same-time conflicts or backwards observations', () => {
    const db = new SqliteRelayDatabase();
    try {
      register(db); db.nativeTranscripts.save(page()); db.nativeTranscripts.save(page());
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM native_transcript_observations').get()?.n, 1);
      const conflict = page(); conflict.messages[1].parts[0].text = 'Changed';
      assert.throws(() => db.nativeTranscripts.save(conflict), /Conflicting/);
      const old = page(); old.observedAt = 240; assert.throws(() => db.nativeTranscripts.save(old), /backwards/);
    } finally { db.close(); }
  });
  it('does not infer deletion from a missing partial-page turn', () => {
    const before = page(); const next = page(); next.messages.shift();
    assert.deepEqual(compareNativeTranscriptPages(before, next), { added: [], changed: [], unchanged: ['msg_answer'], notInCurrentPage: ['msg_user'] });
    assert.equal(next.completeHistory, false);
  });
  it('does not merge observations across sessions or projects', () => {
    const before = page(); const next = page(); next.session.directory = '/other';
    assert.throws(() => compareNativeTranscriptPages(before, next), /scope mismatch/);
  });
  it('rejects stale server revisions and revoked ownership at persistence boundary', () => {
    const db = new SqliteRelayDatabase();
    try {
      register(db); db.nativeServers.revoke('server', 2, 240);
      assert.throws(() => db.nativeTranscripts.save(page()), /superseded/);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM native_transcript_observations').get()?.n, 0);
    } finally { db.close(); }
  });
  it('rejects malformed message identities and strips extra response fields', () => {
    const db = new SqliteRelayDatabase();
    try {
      register(db); const invalid = page(); invalid.messages[0].sessionId = 'ses_other';
      assert.throws(() => db.nativeTranscripts.save(invalid), /Invalid transcript message/);
      const valid = Object.assign(page(), { authorization: 'Basic secret' }); db.nativeTranscripts.save(valid);
      assert.equal(String(db.db.prepare('SELECT page_json FROM native_transcript_observations').get()?.page_json).includes('Basic secret'), false);
    } finally { db.close(); }
  });
  it('detects changed evidence or index timestamps instead of trusting cached content', () => {
    const db = new SqliteRelayDatabase();
    try {
      register(db); db.nativeTranscripts.save(page());
      db.db.exec('UPDATE native_transcript_observations SET observed_at = 500');
      assert.throws(() => db.nativeTranscripts.latest('server', 'ses_exact', '/project'), /evidence mismatch/);
    } finally { db.close(); }
  });
  it('detects transcript text changed without a matching evidence digest', () => {
    const db = new SqliteRelayDatabase();
    try {
      register(db); db.nativeTranscripts.save(page());
      const forged = page(); forged.messages[1].parts[0].text = 'Forged';
      db.db.prepare('UPDATE native_transcript_observations SET page_json = ?').run(JSON.stringify(forged));
      assert.throws(() => db.nativeTranscripts.latest('server', 'ses_exact', '/project'), /evidence mismatch/);
    } finally { db.close(); }
  });
  it('rolls observations back with outer RelayX work', async () => {
    const db = new SqliteRelayDatabase();
    try {
      register(db); await assert.rejects(db.runInTransaction(async () => { db.nativeTranscripts.save(page()); throw new Error('abort'); }));
      assert.equal(db.nativeTranscripts.latest('server', 'ses_exact', '/project'), undefined);
    } finally { db.close(); }
  });
  it('records a restart read without changing task state or issuing sends', async () => {
    const db = new SqliteRelayDatabase();
    try {
      register(db); db.nativeTranscripts.save(page()); const calls: string[] = [];
      const result = await reconcileNativeTranscript(db.nativeServers, db.nativeTranscripts, {
        serverId: 'server', sessionId: 'ses_exact', directory: '/project', observedAt: 300, maximumInspectionAgeMs: 200, messageLimit: 10,
        signal: AbortSignal.timeout(1000), resolveAuthorization: async () => 'Basic secret', fetch: (async (url, init) => {
          assert.equal(init?.method, 'GET'); calls.push(new URL(String(url)).pathname);
          const response = String(url).includes('/message') ? [{ info: { id: 'msg_user', sessionID: 'ses_exact', role: 'user', time: { created: 200 }, model: { providerID: 'provider', modelID: 'model' } },
            parts: [{ id: 'part_user', sessionID: 'ses_exact', messageID: 'msg_user', type: 'text', text: 'Instruction' }] }] : { id: 'ses_exact', directory: '/project' };
          return new Response(JSON.stringify(response));
        }) as typeof fetch,
      });
      assert.equal(result.status, 'RECORDED'); if (result.status === 'RECORDED') assert.deepEqual(result.changes.notInCurrentPage, ['msg_answer']);
      assert.deepEqual(calls, ['/session/ses_exact', '/session/ses_exact/message']);
      for (const table of ['assignments','attempts','deliveries']) assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
    } finally { db.close(); }
  });
  it('keeps durable observations during provider outage', async () => {
    const db = new SqliteRelayDatabase();
    try {
      register(db); db.nativeTranscripts.save(page());
      const result = await reconcileNativeTranscript(db.nativeServers, db.nativeTranscripts, {
        serverId: 'server', sessionId: 'ses_exact', directory: '/project', observedAt: 300, maximumInspectionAgeMs: 200, messageLimit: 10,
        signal: AbortSignal.timeout(1000), resolveAuthorization: async () => 'Basic secret', fetch: (async () => new Response(null, { status: 500 })) as typeof fetch,
      });
      assert.equal(result.status, 'BLOCKED'); assert.equal(db.nativeTranscripts.latest('server', 'ses_exact', '/project')?.observedAt, 250);
    } finally { db.close(); }
  });
  it('does not claim reconciliation success if ownership changes before persistence', async () => {
    const db = new SqliteRelayDatabase();
    try {
      register(db);
      await assert.rejects(reconcileNativeTranscript(db.nativeServers, {
        latest: (...args) => db.nativeTranscripts.latest(...args),
        save: result => { db.nativeServers.revoke('server', 2, 290); db.nativeTranscripts.save(result); },
      }, {
        serverId: 'server', sessionId: 'ses_exact', directory: '/project', observedAt: 300, maximumInspectionAgeMs: 200, messageLimit: 10,
        signal: AbortSignal.timeout(1000), resolveAuthorization: async () => 'Basic secret', fetch: (async url => new Response(JSON.stringify(
          String(url).includes('/message') ? [] : { id: 'ses_exact', directory: '/project' }
        ))) as typeof fetch,
      }), /superseded/);
      assert.equal(db.nativeTranscripts.latest('server', 'ses_exact', '/project'), undefined);
    } finally { db.close(); }
  });
});
