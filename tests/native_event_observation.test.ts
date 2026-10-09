import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase';
import { observeNativeEvents, type NativeEventRead } from '../src/relay/providers/nativeEventObserver';
import { recoverNativeEventConnection } from '../src/relay/providers/nativeEventRecovery';

function register(db: SqliteRelayDatabase) {
  db.nativeServers.register({ serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED', authKeyRef: 'key', projectRoots: ['/project'], registeredBy: 'operator', ownershipEvidenceRef: 'evidence', now: 100 });
  db.nativeServers.applyDiscovery('server', 1, 200, { status: 'INSPECTED', server: { serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED' }, observedAt: 200,
    serverVersion: '1', apiVersion: '1', apiSpecHash: 'digest', rawApiSpec: '{}', providers: [], declaredOperations: [], dispatchAuthorized: false,
    compatibility: { sessionRead: true, messageRead: true, messageSend: false, questionRead: true, questionReply: true, eventStream: true, blockers: [] } });
}
function envelope(id: string, sessionID = 'ses_exact', extra: Record<string, unknown> = {}) {
  return { directory: '/project', payload: { id, type: 'message.updated', properties: { sessionID, info: { id: `msg_${id}`, sessionID }, ...extra } } };
}
function sse(...values: unknown[]): string { return values.map(value => `id: ${(value as ReturnType<typeof envelope>).payload.id}\ndata: ${JSON.stringify(value)}\n\n`).join(''); }
function setup(body: string, status = 200, contentType = 'text/event-stream; charset=utf-8') {
  const db = new SqliteRelayDatabase(); register(db); const calls: Array<{ url: string; headers: Record<string,string> }> = [];
  const options = { serverId: 'server', sessionId: 'ses_exact', directory: '/project', observedAt: 250, maximumInspectionAgeMs: 100,
    maximumEvents: 10, maximumBytes: 10000, priorEventId: undefined as string | undefined,
    signal: AbortSignal.timeout(1000), resolveAuthorization: async () => 'Basic secret',
    fetch: (async (url, init) => { calls.push({ url: String(url), headers: init?.headers as Record<string,string> });
      return new Response(body, { status, headers: { 'content-type': contentType } }); }) as typeof fetch };
  return { db, calls, options };
}
describe('native SSE event observation and recovery evidence', () => {
  it('filters exact-session events, hashes payloads and marks ended streams for reconciliation', async () => {
    const own = envelope('event-1'); const value = setup(`: heartbeat\n\n${sse(envelope('other','ses_other'), own)}`);
    try {
      const result = await observeNativeEvents(value.db.nativeServers, value.options);
      assert.equal(result.status, 'READ'); if (result.status !== 'READ') return;
      assert.equal(result.events.length, 1); assert.equal(result.events[0].providerEventId, 'event-1');
      assert.equal(result.events[0].messageId, 'msg_event-1');
      assert.equal(result.events[0].dataHash, createHash('sha256').update(JSON.stringify(own)).digest('hex'));
      assert.equal(result.connectionEnded, true); assert.equal(result.requiresAuthoritativeReconciliation, true);
      assert.equal(result.streamBoundary, 'EOF');
      assert.equal(result.continuity, 'INITIAL'); assert.equal(JSON.stringify(result).includes('Basic secret'), false);
      assert.equal(new URL(value.calls[0].url).searchParams.get('directory'), '/project');
    } finally { value.db.close(); }
  });
  it('requests a prior cursor but reports reconnect continuity as unverified', async () => {
    const value = setup(sse(envelope('event-2'))); value.options.priorEventId = 'event-1';
    try {
      const result = await observeNativeEvents(value.db.nativeServers, value.options);
      assert.equal(value.calls[0].headers['Last-Event-ID'], 'event-1');
      assert.equal(result.status, 'READ'); if (result.status === 'READ') {
        assert.equal(result.continuity, 'UNVERIFIED_RECONNECT'); assert.equal(result.requiresAuthoritativeReconciliation, true);
      }
    } finally { value.db.close(); }
  });
  it('parses chunked CRLF and multiline SSE data', async () => {
    const raw = JSON.stringify(envelope('event-1')); const split = raw.indexOf(',') + 1;
    const chunks = [`id: event-1\r\ndata: ${raw.slice(0, split)}\r\n`, `data: ${raw.slice(split)}\r\n\r\n`];
    const value = setup(''); value.options.fetch = (async () => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    try { assert.equal((await observeNativeEvents(value.db.nativeServers, value.options)).status, 'READ'); } finally { value.db.close(); }
  });
  it('rejects mismatched SSE/payload identity and conflicting duplicate IDs', async () => {
    let value = setup(`id: wrong\ndata: ${JSON.stringify(envelope('event-1'))}\n\n`);
    try { assert.equal((await observeNativeEvents(value.db.nativeServers, value.options) as { reason: string }).reason, 'EVENT_IDENTITY_MISMATCH'); } finally { value.db.close(); }
    value = setup(sse(envelope('event-1'), envelope('event-1','ses_exact',{ messageID: 'changed' })));
    try { assert.equal((await observeNativeEvents(value.db.nativeServers, value.options) as { reason: string }).reason, 'CONFLICTING_EVENT_ID'); } finally { value.db.close(); }
  });
  for (const [status, contentType, reason] of [[401,'text/event-stream','AUTH_FAILED'],[500,'text/event-stream','SERVER_UNAVAILABLE'],[200,'application/json','RESPONSE_INVALID']] as const) {
    it(`blocks HTTP/content response ${status} ${contentType}`, async () => {
      const value = setup('secret body', status, contentType); try {
        assert.deepEqual(await observeNativeEvents(value.db.nativeServers, value.options), { status: 'BLOCKED', reason });
      } finally { value.db.close(); }
    });
  }
  it('enforces byte limits and explicit supported server scope', async () => {
    const value = setup(sse(envelope('event-1'))); value.options.maximumBytes = 2;
    try {
      assert.equal((await observeNativeEvents(value.db.nativeServers, value.options) as { reason: string }).reason, 'EVENT_LIMIT_EXCEEDED');
      const server = value.db.nativeServers.get('server')!; server.inspection!.compatibility!.eventStream = false;
      assert.equal((await observeNativeEvents({ get: () => server }, { ...value.options, maximumBytes: 1000 }) as { reason: string }).reason, 'API_UNSUPPORTED');
    } finally { value.db.close(); }
  });
  it('cancels at the event limit and still requires authoritative reconciliation', async () => {
    const value = setup(sse(envelope('event-1'), envelope('event-2'))); value.options.maximumEvents = 1;
    try {
      const result = await observeNativeEvents(value.db.nativeServers, value.options);
      assert.equal(result.status, 'READ'); if (result.status === 'READ') {
        assert.equal(result.events.length, 1); assert.equal(result.connectionEnded, false);
        assert.equal(result.streamBoundary, 'EVENT_LIMIT'); assert.equal(result.requiresAuthoritativeReconciliation, true);
      }
    } finally { value.db.close(); }
  });
  it('persists provider IDs once and records duplicate replay separately', async () => {
    const value = setup(sse(envelope('event-1'))); try {
      const first = await observeNativeEvents(value.db.nativeServers, value.options) as Extract<NativeEventRead,{status:'READ'}>;
      assert.deepEqual(value.db.nativeEvents.save(first), { inserted: ['event-1'], duplicates: [] });
      const second = { ...first, observedAt: 260, priorEventId: 'event-1', continuity: 'UNVERIFIED_RECONNECT' as const, requiresAuthoritativeReconciliation: true };
      assert.deepEqual(value.db.nativeEvents.save(second), { inserted: [], duplicates: ['event-1'] });
      assert.equal(value.db.nativeEvents.latestCursor('server','ses_exact','/project'), 'event-1');
      assert.equal(value.db.db.prepare('SELECT COUNT(*) AS n FROM native_event_observations').get()?.n, 1);
      assert.equal(value.db.db.prepare('SELECT COUNT(*) AS n FROM native_event_batches').get()?.n, 2);
    } finally { value.db.close(); }
  });
  it('restart recovery uses the durable cursor and requires both authoritative reads', async () => {
    const firstValue = setup(sse(envelope('event-1'))); try {
      const first = await observeNativeEvents(firstValue.db.nativeServers, firstValue.options) as Extract<NativeEventRead,{status:'READ'}>;
      firstValue.db.nativeEvents.save(first);
      const headers: Record<string,string>[] = [];
      const result = await recoverNativeEventConnection(firstValue.db.nativeServers, firstValue.db.nativeEvents, {
        ...firstValue.options, observedAt: 260, fetch: (async (_url, init) => { headers.push(init?.headers as Record<string,string>); return new Response(sse(envelope('event-2')), { headers: { 'content-type': 'text/event-stream' } }); }) as typeof fetch,
      });
      assert.equal(headers[0]['Last-Event-ID'], 'event-1'); assert.equal(result.status, 'RECORDED');
      if (result.status === 'RECORDED') {
        assert.equal(result.batch.continuity, 'UNVERIFIED_RECONNECT');
        assert.equal(result.reconcileTranscript, true); assert.equal(result.reconcileQuestions, true);
      }
    } finally { firstValue.db.close(); }
  });
  it('rejects conflicting replay, clock rollback and stale ownership atomically', async () => {
    const value = setup(sse(envelope('event-1'))); try {
      const first = await observeNativeEvents(value.db.nativeServers, value.options) as Extract<NativeEventRead,{status:'READ'}>; value.db.nativeEvents.save(first);
      const conflict = structuredClone(first); conflict.observedAt = 260; conflict.events[0].dataHash = 'a'.repeat(64);
      assert.throws(() => value.db.nativeEvents.save(conflict), /Conflicting provider/);
      const old = structuredClone(first); old.observedAt = 240; assert.throws(() => value.db.nativeEvents.save(old), /backwards/);
      value.db.nativeServers.revoke('server',2,270); const stale = structuredClone(first); stale.observedAt = 280;
      assert.throws(() => value.db.nativeEvents.save(stale), /superseded/);
      assert.equal(value.db.db.prepare('SELECT COUNT(*) AS n FROM native_event_observations').get()?.n, 1);
    } finally { value.db.close(); }
  });
  it('rolls back event and batch writes with outer RelayX work and leaves task state alone', async () => {
    const value = setup(sse(envelope('event-1'))); try {
      const batch = await observeNativeEvents(value.db.nativeServers, value.options) as Extract<NativeEventRead,{status:'READ'}>;
      await assert.rejects(value.db.runInTransaction(async () => { value.db.nativeEvents.save(batch); throw new Error('abort'); }));
      assert.equal(value.db.nativeEvents.latestCursor('server','ses_exact','/project'), undefined);
      for (const table of ['assignments','attempts','deliveries']) assert.equal(value.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
    } finally { value.db.close(); }
  });
});
