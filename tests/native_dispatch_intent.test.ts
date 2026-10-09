import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase';
import type { NativeTranscriptPage } from '../src/relay/providers/nativeTranscriptReconciliation';
import type { NativeQuestionObservation } from '../src/relay/providers/nativeQuestionReconciliation';
import type { NativeEventRead } from '../src/relay/providers/nativeEventObserver';

function setup() {
  const db = new SqliteRelayDatabase();
  db.nativeServers.register({ serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED', authKeyRef: 'key', projectRoots: ['/project'], registeredBy: 'operator', ownershipEvidenceRef: 'evidence', now: 100 });
  db.nativeServers.applyDiscovery('server', 1, 200, { status: 'INSPECTED', server: { serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED' }, observedAt: 200,
    serverVersion: '1', apiVersion: '1', apiSpecHash: 'digest', rawApiSpec: '{}', providers: [], declaredOperations: [], dispatchAuthorized: false,
    compatibility: { sessionRead: true, messageRead: true, questionRead: true, questionReply: true, eventStream: true, blockers: [] } });
  const transcript: NativeTranscriptPage = { status: 'READ', serverId: 'server', serverRevision: 2, apiSpecHash: 'digest', observedAt: 250,
    session: { id: 'ses_exact', directory: '/project' }, messages: [], completeHistory: false };
  const questions: NativeQuestionObservation = { status: 'READ', serverId: 'server', serverRevision: 2, apiSpecHash: 'digest', observedAt: 250,
    sessionId: 'ses_exact', directory: '/project', questions: [], completePendingSet: true };
  const rawEvent = JSON.stringify({ directory: '/project', payload: { id: 'event-1', type: 'session.updated', properties: { sessionID: 'ses_exact' } } });
  const events: Extract<NativeEventRead,{status:'READ'}> = { status: 'READ', serverId: 'server', serverRevision: 2, apiSpecHash: 'digest', observedAt: 250,
    sessionId: 'ses_exact', directory: '/project', events: [{ providerEventId: 'event-1', eventType: 'session.updated', sessionId: 'ses_exact', dataHash: createHash('sha256').update(rawEvent).digest('hex'), observedOrder: 0 }],
    lastEventId: 'event-1', continuity: 'INITIAL', connectionEnded: true, streamBoundary: 'EOF', requiresAuthoritativeReconciliation: true };
  db.nativeTranscripts.save(transcript); db.nativeQuestions.save(questions); db.nativeEvents.save(events);
  db.db.exec(`
    INSERT INTO projects(id,name,status,created_at,updated_at) VALUES('project','Project','active',1,1);
    INSERT INTO runtime_sessions(id,provider_type,name,status,external_session_id,created_at,updated_at) VALUES('runtime','opencode','Worker','available','ses_exact',1,1);
    INSERT INTO pairs(id,project_id,name,worker_session_id,status,operational_state,relay_state,stable_pair_id,created_at,updated_at)
      VALUES('pair','project','Pair','runtime','active','ACTIVE','RUNNING','pair',1,1);
    INSERT INTO assignments(id,pair_id,project_id,title,instruction,target_side_role,priority,status,current_attempt_id,active_delivery_id,created_at,updated_at)
      VALUES('assignment','pair','project','Task','Do work','worker','normal','active','attempt','delivery',1,1);
    INSERT INTO attempts(id,assignment_id,attempt_number,status,session_pair_id,worker_session_id,external_session_id,started_at)
      VALUES('attempt','assignment',1,'prepared','pair','runtime','ses_exact',1);
    INSERT INTO deliveries(id,assignment_id,attempt_id,target_runtime_id,status,idempotency_key,instruction_snippet,created_at,updated_at)
      VALUES('delivery','assignment','attempt','runtime','pending','dispatch:key','Do work',1,1);
  `);
  const input = { dispatchKey: 'dispatch:key', deliveryId: 'delivery', assignmentId: 'assignment', attemptId: 'attempt', serverId: 'server',
    sessionId: 'ses_exact', directory: '/project', modelRoute: { providerId: 'provider', endpointId: 'endpoint', publishedModelId: 'model', accountId: 'opaque-account', runtimeConfigFingerprint: 'runtime-hash' },
    policyVersion: 'policy-v1', payload: { parts: [{ type: 'text' as const, text: 'Do work' }] }, createdAt: 300 };
  return { db, input };
}
describe('native dispatch intent preparation', () => {
  it('freezes exact authority, payload and combined pre-send boundary without authorizing send', () => {
    const value = setup(); try {
      const intent = value.db.nativeDispatchIntents.prepare(value.input);
      assert.equal(intent.state, 'PREPARED_UNAUTHORIZED');
      assert.equal(intent.payloadDigest, createHash('sha256').update(JSON.stringify(intent.payload)).digest('hex'));
      assert.deepEqual(intent.boundary, { observedAt: 250, apiSpecHash: 'digest', transcriptDigest: value.db.db.prepare('SELECT payload_hash FROM native_transcript_observations').get()?.payload_hash,
        questionDigest: value.db.db.prepare('SELECT payload_hash FROM native_question_observations').get()?.payload_hash, eventCursor: 'event-1' });
      assert.deepEqual(value.db.nativeDispatchIntents.get('dispatch:key'), intent);
      assert.equal(value.db.db.prepare('SELECT COUNT(*) AS n FROM native_dispatch_intents').get()?.n, 1);
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status, 'pending');
    } finally { value.db.close(); }
  });
  it('is idempotent for identical preparation and rejects changed payload under the same key', () => {
    const value = setup(); try {
      value.db.nativeDispatchIntents.prepare(value.input); value.db.nativeDispatchIntents.prepare(value.input);
      assert.equal(value.db.db.prepare('SELECT COUNT(*) AS n FROM native_dispatch_intents').get()?.n, 1);
      assert.throws(() => value.db.nativeDispatchIntents.prepare({ ...value.input, payload: { parts: [{ type: 'text', text: 'Different' }] } }), /Conflicting/);
    } finally { value.db.close(); }
  });
  for (const mutation of [
    (db: SqliteRelayDatabase) => db.db.exec("UPDATE attempts SET external_session_id='ses_other'"),
    (db: SqliteRelayDatabase) => db.db.exec("UPDATE attempts SET status='running'"),
    (db: SqliteRelayDatabase) => db.db.exec("UPDATE deliveries SET status='delivering'"),
    (db: SqliteRelayDatabase) => db.db.exec("UPDATE deliveries SET idempotency_key='other'"),
    (db: SqliteRelayDatabase) => db.db.exec("UPDATE assignments SET active_delivery_id='other'"),
  ]) it('rejects mismatched or non-pre-send relay authority', () => {
    const value = setup(); try { mutation(value.db); assert.throws(() => value.db.nativeDispatchIntents.prepare(value.input), /authority mismatch/); } finally { value.db.close(); }
  });
  it('requires one combined latest checkpoint rather than mixed observations', () => {
    const value = setup(); try {
      value.db.db.exec('UPDATE native_question_observations SET observed_at=249');
      assert.throws(() => value.db.nativeDispatchIntents.prepare(value.input), /boundary unavailable/);
    } finally { value.db.close(); }
  });
  it('rejects stale/revoked server evidence and a preparation clock before the boundary', () => {
    let value = setup(); try { value.db.nativeServers.revoke('server',2,260); assert.throws(() => value.db.nativeDispatchIntents.prepare(value.input), /not authorized/); } finally { value.db.close(); }
    value = setup(); try { assert.throws(() => value.db.nativeDispatchIntents.prepare({ ...value.input, createdAt: 249 }), /boundary unavailable/); } finally { value.db.close(); }
  });
  it('requires all five exact model-route fields and a nonempty text payload', () => {
    const value = setup(); try {
      assert.throws(() => value.db.nativeDispatchIntents.prepare({ ...value.input, modelRoute: { ...value.input.modelRoute, accountId: '' } }), /model route/);
      assert.throws(() => value.db.nativeDispatchIntents.prepare({ ...value.input, payload: { parts: [] } }), /payload/);
    } finally { value.db.close(); }
  });
  it('rolls back with outer RelayX work and does not alter Delivery or Attempt state', async () => {
    const value = setup(); try {
      await assert.rejects(value.db.runInTransaction(async () => { value.db.nativeDispatchIntents.prepare(value.input); throw new Error('abort'); }));
      assert.equal(value.db.nativeDispatchIntents.get('dispatch:key'), undefined);
      assert.equal(value.db.db.prepare("SELECT status FROM attempts WHERE id='attempt'").get()?.status, 'prepared');
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status, 'pending');
    } finally { value.db.close(); }
  });
  it('detects altered indexed or serialized intent evidence', () => {
    const value = setup(); try {
      value.db.nativeDispatchIntents.prepare(value.input);
      value.db.db.exec("UPDATE native_dispatch_intents SET payload_digest='forged'");
      assert.throws(() => value.db.nativeDispatchIntents.get('dispatch:key'), /index mismatch/);
    } finally { value.db.close(); }
  });
  it('detects serialized policy tampering and strips unknown preparation fields', () => {
    const value = setup(); try {
      const withSecret = { ...value.input, authorization: 'Basic secret' };
      value.db.nativeDispatchIntents.prepare(withSecret);
      const stored = String(value.db.db.prepare('SELECT intent_json FROM native_dispatch_intents').get()?.intent_json);
      assert.equal(stored.includes('Basic secret'), false);
      const parsed = JSON.parse(stored); parsed.policyVersion = 'forged';
      value.db.db.prepare('UPDATE native_dispatch_intents SET intent_json=?').run(JSON.stringify(parsed));
      assert.throws(() => value.db.nativeDispatchIntents.get('dispatch:key'), /index mismatch/);
    } finally { value.db.close(); }
  });
});
