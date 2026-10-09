import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase';
import { readNativePendingQuestions } from '../src/relay/providers/nativeQuestionReader';
import { compareNativeQuestionObservations, reconcileNativeQuestions, type NativeQuestionObservation } from '../src/relay/providers/nativeQuestionReconciliation';

function register(db: SqliteRelayDatabase) {
  db.nativeServers.register({ serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED', authKeyRef: 'key', projectRoots: ['/project'], registeredBy: 'operator', ownershipEvidenceRef: 'evidence', now: 100 });
  db.nativeServers.applyDiscovery('server', 1, 200, { status: 'INSPECTED', server: { serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED' }, observedAt: 200,
    serverVersion: '1', apiVersion: '1', apiSpecHash: 'digest', rawApiSpec: '{}', providers: [], declaredOperations: [], dispatchAuthorized: false,
    compatibility: { sessionRead: true, messageRead: true, questionRead: true, questionReply: true, eventStream: false, blockers: [] } });
}
function observation(at = 250): NativeQuestionObservation {
  return { status: 'READ', serverId: 'server', serverRevision: 2, apiSpecHash: 'digest', observedAt: at, sessionId: 'ses_exact', directory: '/project', completePendingSet: true,
    questions: [{ requestId: 'request', sessionId: 'ses_exact', messageId: 'message', callId: 'call', questions: [{ question: 'Choose?', header: 'Choice', options: [{ label: 'One', description: 'First' }], multiple: false, custom: false }] }] };
}
function readSetup(raw: unknown) {
  const db = new SqliteRelayDatabase(); register(db); const calls: string[] = [];
  return { db, calls, options: { serverId: 'server', sessionId: 'ses_exact', directory: '/project', observedAt: 250, maximumInspectionAgeMs: 100,
    signal: AbortSignal.timeout(1000), resolveAuthorization: async () => 'Basic secret', fetch: (async (url, init) => {
      calls.push(String(url)); assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined);
      return new Response(JSON.stringify(raw));
    }) as typeof fetch } };
}
describe('native pending question observation', () => {
  it('reads exact-session questions and strips unrelated sessions and extra fields', async () => {
    const value = readSetup([{ id: 'other', sessionID: 'ses_other', questions: [], secret: 'omit' }, { id: 'request', sessionID: 'ses_exact', tool: { messageID: 'message', callID: 'call' }, secret: 'omit',
      questions: [{ question: 'Choose?', header: 'Choice', options: [{ label: 'One', description: 'First', secret: 'omit' }] }] }]);
    try {
      const result = await readNativePendingQuestions(value.db.nativeServers, value.options);
      assert.equal(result.status, 'READ'); if (result.status === 'READ') { assert.equal(result.questions.length, 1); assert.equal(result.completePendingSet, true); assert.equal(JSON.stringify(result).includes('secret'), false); }
      assert.equal(new URL(value.calls[0]).searchParams.get('directory'), '/project');
    } finally { value.db.close(); }
  });
  for (const candidate of [
    { id: 'request', sessionID: 'ses_exact', questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: 'D' }] }] },
    { id: 'request', sessionID: 'ses_exact', tool: { messageID: '', callID: 'call' }, questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: 'D' }] }] },
  ]) it('rejects missing tool/run correlation', async () => {
    const value = readSetup([candidate]); try { assert.deepEqual(await readNativePendingQuestions(value.db.nativeServers, value.options), { status: 'BLOCKED', reason: 'QUESTION_CORRELATION_MISSING' }); } finally { value.db.close(); }
  });
  it('rejects duplicate request and tool-call identities', async () => {
    const item = { id: 'request', sessionID: 'ses_exact', tool: { messageID: 'message', callID: 'call' }, questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: 'D' }] }] };
    let value = readSetup([item, item]); try { assert.equal((await readNativePendingQuestions(value.db.nativeServers, value.options) as { reason: string }).reason, 'QUESTION_IDENTITY_MISMATCH'); } finally { value.db.close(); }
    value = readSetup([item, { ...item, id: 'request-2' }]); try { assert.equal((await readNativePendingQuestions(value.db.nativeServers, value.options) as { reason: string }).reason, 'QUESTION_CORRELATION_DUPLICATE'); } finally { value.db.close(); }
  });
  it('rejects malformed options and duplicate labels', async () => {
    const value = readSetup([{ id: 'request', sessionID: 'ses_exact', tool: { messageID: 'message', callID: 'call' }, questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: 'D' }, { label: 'A', description: 'Again' }] }] }]);
    try { assert.deepEqual(await readNativePendingQuestions(value.db.nativeServers, value.options), { status: 'BLOCKED', reason: 'RESPONSE_INVALID' }); } finally { value.db.close(); }
  });
  it('blocks unsupported, stale, wrong-scope and revoked reads before network', async () => {
    const value = readSetup([]); try {
      const server = value.db.nativeServers.get('server')!; server.inspection!.compatibility!.questionRead = false;
      assert.equal((await readNativePendingQuestions({ get: () => server }, value.options) as { reason: string }).reason, 'API_UNSUPPORTED');
      assert.equal((await readNativePendingQuestions(value.db.nativeServers, { ...value.options, observedAt: 300 }) as { reason: string }).reason, 'INSPECTION_NOT_CURRENT');
      assert.equal((await readNativePendingQuestions(value.db.nativeServers, { ...value.options, sessionId: '../other' }) as { reason: string }).reason, 'SESSION_SCOPE_NOT_AUTHORIZED');
      assert.equal(value.calls.length, 0);
    } finally { value.db.close(); }
  });
  it('persists append-only observations and resolution across restart-style reconciliation', async () => {
    const value = readSetup([]); try {
      value.db.nativeQuestions.save(observation());
      const result = await reconcileNativeQuestions(value.db.nativeServers, value.db.nativeQuestions, { ...value.options, observedAt: 260 });
      assert.equal(result.status, 'RECORDED'); if (result.status === 'RECORDED') assert.deepEqual(result.changes.resolved, ['request']);
      assert.equal(value.db.nativeQuestions.latest('server', 'ses_exact', '/project')?.questions.length, 0);
      assert.equal(value.db.db.prepare('SELECT COUNT(*) AS n FROM native_question_observations').get()?.n, 2);
    } finally { value.db.close(); }
  });
  it('classifies appeared, changed, unchanged and resolved identities', () => {
    const before = observation(); const current = observation(260); current.questions[0].questions[0].header = 'Changed';
    current.questions.push({ ...before.questions[0], requestId: 'new', messageId: 'new-message', callId: 'new-call' });
    assert.deepEqual(compareNativeQuestionObservations(before, current), { appeared: ['new'], changed: ['request'], unchanged: [], resolved: [] });
    current.questions = []; assert.deepEqual(compareNativeQuestionObservations(before, current).resolved, ['request']);
  });
  it('rejects conflicts, backwards time, tampering and stale ownership', () => {
    const db = new SqliteRelayDatabase(); try {
      register(db); db.nativeQuestions.save(observation()); db.nativeQuestions.save(observation());
      const conflict = observation(); conflict.questions[0].questions[0].header = 'Different'; assert.throws(() => db.nativeQuestions.save(conflict), /Conflicting/);
      assert.throws(() => db.nativeQuestions.save(observation(240)), /backwards/);
      db.db.exec('UPDATE native_question_observations SET observed_at=500'); assert.throws(() => db.nativeQuestions.latest('server','ses_exact','/project'), /evidence mismatch/);
    } finally { db.close(); }
  });
  it('rejects stored scope changed without matching lookup identity', () => {
    const db = new SqliteRelayDatabase(); try {
      register(db); db.nativeQuestions.save(observation());
      const changed = observation(); changed.sessionId = 'ses_other'; changed.questions[0].sessionId = 'ses_other';
      db.db.prepare('UPDATE native_question_observations SET observation_json=?').run(JSON.stringify(changed));
      assert.throws(() => db.nativeQuestions.latest('server','ses_exact','/project'), /evidence mismatch/);
    } finally { db.close(); }
  });
  it('rolls back with outer work and never changes task tables', async () => {
    const db = new SqliteRelayDatabase(); try {
      register(db); await assert.rejects(db.runInTransaction(async () => { db.nativeQuestions.save(observation()); throw new Error('abort'); }));
      assert.equal(db.nativeQuestions.latest('server','ses_exact','/project'), undefined);
      for (const table of ['assignments','attempts','deliveries']) assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
    } finally { db.close(); }
  });
  it('does not record success when ownership changes before persistence', async () => {
    const value = readSetup([]); try {
      await assert.rejects(reconcileNativeQuestions(value.db.nativeServers, { latest: () => undefined, save: result => { value.db.nativeServers.revoke('server',2,240); value.db.nativeQuestions.save(result); } }, value.options), /superseded/);
      assert.equal(value.db.nativeQuestions.latest('server','ses_exact','/project'), undefined);
    } finally { value.db.close(); }
  });
});
