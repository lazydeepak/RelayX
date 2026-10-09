import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase';
import { recoverNativeObservationCheckpoint, type NativeRecoveryStores } from '../src/relay/providers/nativeObservationRecovery';

function register(db: SqliteRelayDatabase) {
  db.nativeServers.register({ serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED', authKeyRef: 'key', projectRoots: ['/project'], registeredBy: 'operator', ownershipEvidenceRef: 'evidence', now: 100 });
  db.nativeServers.applyDiscovery('server', 1, 200, { status: 'INSPECTED', server: { serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED' }, observedAt: 200,
    serverVersion: '1', apiVersion: '1', apiSpecHash: 'digest', rawApiSpec: '{}', providers: [], declaredOperations: [], dispatchAuthorized: false,
    compatibility: { sessionRead: true, messageRead: true, messageSend: false, executionTerminalRead: false, questionRead: true, questionReply: true, eventStream: true, blockers: [] } });
}
function fixture() {
  const db = new SqliteRelayDatabase(); register(db); const calls: string[] = [];
  const event = { directory: '/project', payload: { id: 'event-1', type: 'message.updated', properties: { sessionID: 'ses_exact', info: { id: 'message', sessionID: 'ses_exact' } } } };
  const transcript = [{ info: { id: 'message', sessionID: 'ses_exact', role: 'assistant', time: { created: 220 }, parentID: 'user', providerID: 'provider', modelID: 'model' }, parts: [] }];
  const questions = [{ id: 'request', sessionID: 'ses_exact', tool: { messageID: 'message', callID: 'call' }, questions: [{ question: 'Choose?', header: 'Choice', options: [{ label: 'One', description: 'First' }] }] }];
  const options = { serverId: 'server', sessionId: 'ses_exact', directory: '/project', observedAt: 250, maximumInspectionAgeMs: 100,
    messageLimit: 10, maximumEvents: 10, maximumEventBytes: 10000, signal: AbortSignal.timeout(1000), resolveAuthorization: async () => 'Basic secret',
    fetch: (async url => {
      const path = new URL(String(url)).pathname; calls.push(path);
      if (path === '/event') return new Response(`id: event-1\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      if (path === '/session/ses_exact') return new Response(JSON.stringify({ id: 'ses_exact', directory: '/project' }));
      if (path.endsWith('/message')) return new Response(JSON.stringify(transcript));
      if (path === '/question') return new Response(JSON.stringify(questions));
      return new Response(null, { status: 404 });
    }) as typeof fetch };
  const stores: NativeRecoveryStores = { servers: db.nativeServers, events: db.nativeEvents, transcripts: db.nativeTranscripts, questions: db.nativeQuestions,
    transaction: <T>(work: () => Promise<T>) => db.runInTransaction(work) };
  return { db, stores, options, calls };
}
function counts(db: SqliteRelayDatabase) {
  return ['native_event_batches','native_event_observations','native_transcript_observations','native_question_observations']
    .map(table => Number(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n));
}
describe('combined native observation recovery checkpoint', () => {
  it('commits event, transcript and question evidence in one checkpoint', async () => {
    const value = fixture(); try {
      const result = await recoverNativeObservationCheckpoint(value.stores, value.options);
      assert.equal(result.status, 'RECORDED'); assert.deepEqual(value.calls, ['/event','/session/ses_exact','/session/ses_exact/message','/question']);
      assert.deepEqual(counts(value.db), [1,1,1,1]);
      if (result.status === 'RECORDED') {
        assert.deepEqual(result.eventChanges, { inserted: ['event-1'], duplicates: [] });
        assert.deepEqual(result.transcriptChanges.added, ['message']); assert.deepEqual(result.questionChanges.appeared, ['request']);
        assert.equal(result.taskStateChanged, false); assert.equal(result.dispatchAttempted, false);
      }
      for (const table of ['assignments','attempts','deliveries']) assert.equal(value.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
    } finally { value.db.close(); }
  });
  it('persists nothing when transcript reconciliation is blocked', async () => {
    const value = fixture(); value.options.fetch = (async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/event') return new Response(': end\n\n', { headers: { 'content-type': 'text/event-stream' } });
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    try {
      const result = await recoverNativeObservationCheckpoint(value.stores, value.options);
      assert.deepEqual(result, { status: 'BLOCKED', phase: 'TRANSCRIPT', reason: 'SERVER_UNAVAILABLE' });
      assert.deepEqual(counts(value.db), [0,0,0,0]);
    } finally { value.db.close(); }
  });
  it('persists nothing when question reconciliation is blocked', async () => {
    const value = fixture(); const original = value.options.fetch;
    value.options.fetch = (async (url, init) => new URL(String(url)).pathname === '/question' ? new Response(null, { status: 500 }) : original(url, init)) as typeof fetch;
    try {
      const result = await recoverNativeObservationCheckpoint(value.stores, value.options);
      assert.deepEqual(result, { status: 'BLOCKED', phase: 'QUESTIONS', reason: 'SERVER_UNAVAILABLE' });
      assert.deepEqual(counts(value.db), [0,0,0,0]);
    } finally { value.db.close(); }
  });
  it('rolls all evidence back if the final repository write fails', async () => {
    const value = fixture();
    value.db.db.exec("CREATE TRIGGER reject_question_checkpoint BEFORE INSERT ON native_question_observations BEGIN SELECT RAISE(ABORT,'question write failed'); END");
    try {
      await assert.rejects(recoverNativeObservationCheckpoint(value.stores, value.options), /question write failed/);
      assert.deepEqual(counts(value.db), [0,0,0,0]);
    } finally { value.db.close(); }
  });
  it('rolls all evidence back when ownership changes after reads', async () => {
    const value = fixture(); const save = value.stores.events.save.bind(value.stores.events);
    value.stores.events = { latestCursor: value.stores.events.latestCursor.bind(value.stores.events), save: batch => { value.db.nativeServers.revoke('server', 2, 240); return save(batch); } };
    try {
      await assert.rejects(recoverNativeObservationCheckpoint(value.stores, value.options), /superseded/);
      assert.deepEqual(counts(value.db), [0,0,0,0]);
    } finally { value.db.close(); }
  });
  it('uses a durable reconnect cursor and classifies unchanged evidence', async () => {
    const value = fixture(); try {
      const first = await recoverNativeObservationCheckpoint(value.stores, value.options); assert.equal(first.status, 'RECORDED');
      value.options.observedAt = 260; value.calls.length = 0;
      const original = value.options.fetch; let cursor: string | undefined;
      value.options.fetch = (async (url, init) => { if (new URL(String(url)).pathname === '/event') cursor = (init?.headers as Record<string,string>)['Last-Event-ID']; return original(url, init); }) as typeof fetch;
      const second = await recoverNativeObservationCheckpoint(value.stores, value.options);
      assert.equal(second.status, 'RECORDED'); assert.equal(cursor, 'event-1');
      if (second.status === 'RECORDED') {
        assert.deepEqual(second.eventChanges.duplicates, ['event-1']);
        assert.deepEqual(second.transcriptChanges.unchanged, ['message']);
        assert.deepEqual(second.questionChanges.unchanged, ['request']);
      }
      assert.deepEqual(counts(value.db), [2,1,2,2]);
    } finally { value.db.close(); }
  });
});
