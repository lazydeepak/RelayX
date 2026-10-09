import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase';
import type { NativeTranscriptPage } from '../src/relay/providers/nativeTranscriptReconciliation';
import type { NativeQuestionObservation } from '../src/relay/providers/nativeQuestionReconciliation';
import type { NativeEventRead } from '../src/relay/providers/nativeEventObserver';
import { COST_DIMENSIONS, type EligibilityRequest } from '../src/relay/model-intelligence/eligibility';

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
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function eligibility(now = 310): EligibilityRequest {
  const route = { providerId: 'provider', endpointId: 'endpoint', publishedModelId: 'model', accountId: 'opaque-account', runtimeConfigFingerprint: 'runtime-hash' };
  const source = { sourceUrl: 'https://provider.example/account', fetchedAt: 290, contentHash: digest('source'), parserVersion: '1' };
  return { route, now, accountPolicyHash: 'account-policy', taskClass: 'coding', purpose: 'TASK',
    lease: { route: { ...route }, verifiedAt: 300, expiresAt: 500, verdict: 'VERIFIED_FREE', pricingEvidence: { ...source, contentHash: digest('pricing') }, accountEvidence: { ...source, contentHash: digest('account') },
      accountPolicyHash: 'account-policy', costs: Object.fromEntries(COST_DIMENSIONS.map(key => [key,'FREE'])) as NonNullable<EligibilityRequest['lease']>['costs'], conflicts: [] },
    qualification: { route: { ...route }, taskClass: 'coding', verifiedAt: 300, expiresAt: 480, accepted: true, evidenceHash: digest('qualification') },
    taskQuota: 'AVAILABLE', evaluationQuota: 'UNKNOWN', privacy: 'APPROVED', runtime: 'HEALTHY' };
}
const operationalEvidence = { verifiedAt: 305, expiresAt: 450, taskQuotaEvidenceHash: digest('quota'), privacyEvidenceHash: digest('privacy'), runtimeEvidenceHash: digest('runtime') };
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

describe('native dispatch zero-cost authorization', () => {
  it('binds a bounded authorization to the exact immutable intent and verified evidence', () => {
    const value = setup(); try {
      value.db.nativeDispatchIntents.prepare(value.input);
      const authorization = value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence });
      assert.equal(authorization.state, 'AUTHORIZED_UNCONSUMED'); assert.equal(authorization.expiresAt, 450);
      assert.deepEqual(value.db.nativeDispatchAuthorizations.get('dispatch:key'), authorization);
      assert.deepEqual(value.db.nativeDispatchAuthorizations.checkUsable('dispatch:key', { now: 320, accountPolicyHash: 'account-policy', ...operationalEvidence }), { usable: true, reasons: [] });
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status, 'pending');
      assert.equal(value.db.db.prepare("SELECT status FROM attempts WHERE id='attempt'").get()?.status, 'prepared');
    } finally { value.db.close(); }
  });
  for (const mutate of [
    (request: EligibilityRequest) => { request.lease!.costs.output = 'PAID'; },
    (request: EligibilityRequest) => { request.taskQuota = 'UNKNOWN'; },
    (request: EligibilityRequest) => { request.privacy = 'UNKNOWN'; },
    (request: EligibilityRequest) => { request.runtime = 'UNAVAILABLE'; },
    (request: EligibilityRequest) => { request.qualification!.accepted = false; },
  ]) it('fails closed when any eligibility dimension is not verified', () => {
    const value = setup(); try { value.db.nativeDispatchIntents.prepare(value.input); const request = eligibility(); mutate(request);
      assert.throws(() => value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: request, operationalEvidence }), /eligibility denied/);
      assert.equal(value.db.nativeDispatchAuthorizations.get('dispatch:key'), undefined);
    } finally { value.db.close(); }
  });
  it('rejects another route, clock, policy purpose or unbounded operational claims', () => {
    const value = setup(); try { value.db.nativeDispatchIntents.prepare(value.input);
      let request = eligibility(); request.route = { ...request.route, accountId: 'other' };
      assert.throws(() => value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: request, operationalEvidence }), /intent mismatch/);
      request = eligibility(311); assert.throws(() => value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: request, operationalEvidence }), /intent mismatch/);
      request = eligibility(); request.purpose = 'EVALUATION'; assert.throws(() => value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: request, operationalEvidence }), /intent mismatch/);
      assert.throws(() => value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence: { ...operationalEvidence, expiresAt: 310 } }), /operational/);
    } finally { value.db.close(); }
  });
  it('blocks authorization when the pre-send boundary advanced or has a pending question', () => {
    let value = setup(); try { value.db.nativeDispatchIntents.prepare(value.input); value.db.db.exec('UPDATE native_event_batches SET observed_at=320');
      assert.throws(() => value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 330, eligibility: eligibility(330), operationalEvidence: { ...operationalEvidence, expiresAt: 450 } }), /boundary superseded/);
    } finally { value.db.close(); }
    value = setup(); try { value.db.nativeDispatchIntents.prepare(value.input);
      const row = value.db.nativeQuestions.latest('server','ses_exact','/project')!;
      row.observedAt = 260; row.questions.push({ requestId: 'request', sessionId: 'ses_exact', messageId: 'message', callId: 'call', questions: [{ question: 'Q?', header: 'Q', options: [{ label: 'Yes', description: 'Proceed' }], multiple: false, custom: false }] });
      value.db.nativeQuestions.save(row);
      assert.throws(() => value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence }), /boundary superseded/);
    } finally { value.db.close(); }
  });
  it('expires at the earliest evidence boundary and detects changed use-time evidence', () => {
    const value = setup(); try { value.db.nativeDispatchIntents.prepare(value.input);
      value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence });
      assert.deepEqual(value.db.nativeDispatchAuthorizations.checkUsable('dispatch:key', { now: 450, accountPolicyHash: 'changed', ...operationalEvidence, runtimeEvidenceHash: digest('new-runtime') }),
        { usable: false, reasons: ['AUTHORIZATION_NOT_CURRENT','ACCOUNT_POLICY_CHANGED','RUNTIME_EVIDENCE_CHANGED'] });
      value.db.db.exec("UPDATE deliveries SET status='delivering'");
      assert.ok(value.db.nativeDispatchAuthorizations.checkUsable('dispatch:key', { now: 320, accountPolicyHash: 'account-policy', ...operationalEvidence }).reasons.includes('RELAY_AUTHORITY_CHANGED'));
    } finally { value.db.close(); }
  });
  it('invalidates authorization when relay pointers or the observation boundary advance before use', () => {
    let value = setup(); try { value.db.nativeDispatchIntents.prepare(value.input);
      value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence });
      value.db.db.exec("UPDATE assignments SET active_delivery_id='other'");
      assert.ok(value.db.nativeDispatchAuthorizations.checkUsable('dispatch:key', { now: 320, accountPolicyHash: 'account-policy', ...operationalEvidence }).reasons.includes('RELAY_AUTHORITY_CHANGED'));
    } finally { value.db.close(); }
    value = setup(); try { value.db.nativeDispatchIntents.prepare(value.input);
      value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence });
      value.db.db.exec('UPDATE native_event_batches SET observed_at=320');
      assert.ok(value.db.nativeDispatchAuthorizations.checkUsable('dispatch:key', { now: 320, accountPolicyHash: 'account-policy', ...operationalEvidence }).reasons.includes('OBSERVATION_BOUNDARY_CHANGED'));
    } finally { value.db.close(); }
  });
  it('is idempotent for identical evidence, rejects conflicts and rolls back with outer work', async () => {
    const value = setup(); try { value.db.nativeDispatchIntents.prepare(value.input); const args = { dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence };
      value.db.nativeDispatchAuthorizations.authorize(args); value.db.nativeDispatchAuthorizations.authorize(args);
      assert.equal(value.db.db.prepare('SELECT COUNT(*) AS n FROM native_dispatch_authorizations').get()?.n, 1);
      assert.throws(() => value.db.nativeDispatchAuthorizations.authorize({ ...args, operationalEvidence: { ...operationalEvidence, runtimeEvidenceHash: digest('other') } }), /Conflicting/);
    } finally { value.db.close(); }
    const rollback = setup(); try { rollback.db.nativeDispatchIntents.prepare(rollback.input);
      await assert.rejects(rollback.db.runInTransaction(async () => { rollback.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence }); throw new Error('abort'); }));
      assert.equal(rollback.db.nativeDispatchAuthorizations.get('dispatch:key'), undefined);
    } finally { rollback.db.close(); }
  });
  it('detects serialized authorization tampering', () => {
    const value = setup(); try { value.db.nativeDispatchIntents.prepare(value.input);
      value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence });
      const row = value.db.db.prepare('SELECT authorization_json FROM native_dispatch_authorizations').get(); const parsed = JSON.parse(String(row?.authorization_json)); parsed.taskClass = 'forged';
      value.db.db.prepare('UPDATE native_dispatch_authorizations SET authorization_json=?').run(JSON.stringify(parsed));
      assert.throws(() => value.db.nativeDispatchAuthorizations.get('dispatch:key'), /index mismatch/);
    } finally { value.db.close(); }
  });
});
