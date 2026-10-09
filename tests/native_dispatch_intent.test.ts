import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase';
import type { NativeTranscriptPage } from '../src/relay/providers/nativeTranscriptReconciliation';
import type { NativeQuestionObservation } from '../src/relay/providers/nativeQuestionReconciliation';
import type { NativeEventRead } from '../src/relay/providers/nativeEventObserver';
import { COST_DIMENSIONS, type EligibilityRequest } from '../src/relay/model-intelligence/eligibility';
import { claimAndSubmitNativePrompt, providerMessageIdFor } from '../src/relay/providers/nativePromptSubmission';

function setup() {
  const db = new SqliteRelayDatabase();
  db.nativeServers.register({ serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED', authKeyRef: 'key', projectRoots: ['/project'], registeredBy: 'operator', ownershipEvidenceRef: 'evidence', now: 100 });
  db.nativeServers.applyDiscovery('server', 1, 200, { status: 'INSPECTED', server: { serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED' }, observedAt: 200,
    serverVersion: '1', apiVersion: '1', apiSpecHash: 'digest', rawApiSpec: '{}', providers: [], declaredOperations: [], dispatchAuthorized: false,
    compatibility: { sessionRead: true, messageRead: true, messageSend: true, questionRead: true, questionReply: true, eventStream: true, blockers: [] } });
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

describe('native dispatch one-shot claim', () => {
  function authorize(value: ReturnType<typeof setup>) {
    value.db.nativeDispatchIntents.prepare(value.input);
    value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence });
  }
  const claimEvidence = { now: 320, accountPolicyHash: 'account-policy', taskQuotaEvidenceHash: operationalEvidence.taskQuotaEvidenceHash,
    privacyEvidenceHash: operationalEvidence.privacyEvidenceHash, runtimeEvidenceHash: operationalEvidence.runtimeEvidenceHash };

  it('atomically claims the authorized key and moves only its Delivery to delivering', () => {
    const value = setup(); try { authorize(value);
      const result = value.db.nativeDispatchClaims.claim('dispatch:key', claimEvidence);
      assert.equal(result.acquired, true); assert.equal(result.claim.state, 'SEND_CLAIMED_RECONCILIATION_REQUIRED');
      assert.deepEqual(value.db.nativeDispatchClaims.get('dispatch:key'), result.claim);
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status, 'delivering');
      assert.equal(value.db.db.prepare("SELECT status FROM attempts WHERE id='attempt'").get()?.status, 'prepared');
      assert.equal(value.db.nativeDispatchAuthorizations.get('dispatch:key')?.state, 'AUTHORIZED_UNCONSUMED');
    } finally { value.db.close(); }
  });

  it('never reacquires an existing key, including after evidence expiry or change', () => {
    const value = setup(); try { authorize(value);
      const first = value.db.nativeDispatchClaims.claim('dispatch:key', claimEvidence);
      const second = value.db.nativeDispatchClaims.claim('dispatch:key', { ...claimEvidence, now: 999, accountPolicyHash: 'changed' });
      assert.equal(first.acquired, true); assert.equal(second.acquired, false); assert.deepEqual(second.claim, first.claim);
      assert.equal(value.db.db.prepare('SELECT COUNT(*) AS n FROM native_dispatch_claims').get()?.n, 1);
    } finally { value.db.close(); }
  });

  it('fails before mutation when authorization is absent, expired or authority changed', () => {
    let value = setup(); try { value.db.nativeDispatchIntents.prepare(value.input);
      assert.throws(() => value.db.nativeDispatchClaims.claim('dispatch:key', claimEvidence), /authorization not found/);
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status, 'pending');
    } finally { value.db.close(); }
    value = setup(); try { authorize(value);
      assert.throws(() => value.db.nativeDispatchClaims.claim('dispatch:key', { ...claimEvidence, now: 450 }), /AUTHORIZATION_NOT_CURRENT/);
      assert.equal(value.db.nativeDispatchClaims.get('dispatch:key'), undefined);
    } finally { value.db.close(); }
    value = setup(); try { authorize(value); value.db.db.exec("UPDATE assignments SET active_delivery_id='other'");
      assert.throws(() => value.db.nativeDispatchClaims.claim('dispatch:key', claimEvidence), /RELAY_AUTHORITY_CHANGED/);
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status, 'pending');
    } finally { value.db.close(); }
  });

  it('rolls the claim and Delivery transition back with outer RelayX work', async () => {
    const value = setup(); try { authorize(value);
      await assert.rejects(value.db.runInTransaction(async () => { value.db.nativeDispatchClaims.claim('dispatch:key', claimEvidence); throw new Error('abort'); }));
      assert.equal(value.db.nativeDispatchClaims.get('dispatch:key'), undefined);
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status, 'pending');
    } finally { value.db.close(); }
  });

  it('detects indexed and serialized claim tampering', () => {
    let value = setup(); try { authorize(value); value.db.nativeDispatchClaims.claim('dispatch:key', claimEvidence);
      value.db.db.exec('UPDATE native_dispatch_claims SET claimed_at=321');
      assert.throws(() => value.db.nativeDispatchClaims.get('dispatch:key'), /index mismatch/);
    } finally { value.db.close(); }
    value = setup(); try { authorize(value); value.db.nativeDispatchClaims.claim('dispatch:key', claimEvidence);
      const row = value.db.db.prepare('SELECT claim_json FROM native_dispatch_claims').get(); const parsed = JSON.parse(String(row?.claim_json)); parsed.state = 'SEND_COMPLETE';
      value.db.db.prepare('UPDATE native_dispatch_claims SET claim_json=?').run(JSON.stringify(parsed));
      assert.throws(() => value.db.nativeDispatchClaims.get('dispatch:key'), /Invalid native dispatch claim/);
    } finally { value.db.close(); }
  });
});

describe('native async prompt submission', () => {
  const claimEvidence = { now: 320, accountPolicyHash: 'account-policy', taskQuotaEvidenceHash: operationalEvidence.taskQuotaEvidenceHash,
    privacyEvidenceHash: operationalEvidence.privacyEvidenceHash, runtimeEvidenceHash: operationalEvidence.runtimeEvidenceHash };
  function ready() { const value = setup(); value.db.nativeDispatchIntents.prepare(value.input);
    value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence }); return value; }
  const stores = (value: ReturnType<typeof setup>) => ({ servers: value.db.nativeServers, intents: value.db.nativeDispatchIntents, claims: value.db.nativeDispatchClaims });

  it('posts the frozen text and exact model once, then requires transcript reconciliation', async () => {
    const value = ready(); try { const calls: Array<{ url: string; init?: RequestInit }> = [];
      const result = await claimAndSubmitNativePrompt(stores(value), { dispatchKey: 'dispatch:key', claimEvidence,
        resolveAuthorization: async key => { assert.equal(key, 'key'); return 'Basic secret'; }, signal: AbortSignal.timeout(1000),
        fetch: (async (url, init) => { calls.push({ url: String(url), init }); return new Response(null, { status: 204 }); }) as typeof fetch });
      assert.deepEqual(result, { status: 'RECONCILIATION_REQUIRED', dispatchKey: 'dispatch:key', providerMessageId: providerMessageIdFor('dispatch:key'), transport: 'ATTEMPTED_204', httpStatus: 204 });
      assert.equal(calls.length, 1); const request = calls[0]; const url = new URL(request.url);
      assert.equal(url.pathname, '/session/ses_exact/prompt_async'); assert.equal(url.searchParams.get('directory'), '/project');
      assert.equal(request.init?.method, 'POST'); assert.equal((request.init?.headers as Record<string,string>).Authorization, 'Basic secret');
      assert.deepEqual(JSON.parse(String(request.init?.body)), { messageID: providerMessageIdFor('dispatch:key'),
        model: { providerID: 'provider', modelID: 'model' }, parts: [{ type: 'text', text: 'Do work' }] });
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status, 'delivering');
      assert.equal(value.db.db.prepare("SELECT status FROM attempts WHERE id='attempt'").get()?.status, 'prepared');
    } finally { value.db.close(); }
  });

  it('does not POST an existing claim and ignores changed or expired reacquisition evidence', async () => {
    const value = ready(); try { value.db.nativeDispatchClaims.claim('dispatch:key', claimEvidence); let calls = 0; let authCalls = 0;
      value.db.nativeServers.revoke('server', 2, 330);
      const result = await claimAndSubmitNativePrompt(stores(value), { dispatchKey: 'dispatch:key',
        claimEvidence: { ...claimEvidence, now: 999, accountPolicyHash: 'changed' }, resolveAuthorization: async () => { authCalls++; throw new Error('unavailable'); },
        signal: AbortSignal.timeout(1000), fetch: (async () => { calls++; return new Response(null, { status: 204 }); }) as typeof fetch });
      assert.equal(result.status, 'RECONCILIATION_REQUIRED'); if (result.status === 'RECONCILIATION_REQUIRED') assert.equal(result.transport, 'NOT_ATTEMPTED_EXISTING_CLAIM');
      assert.equal(calls, 0); assert.equal(authCalls, 0);
    } finally { value.db.close(); }
  });

  for (const response of [new Response(null, { status: 400 }), new Response(null, { status: 500 })]) {
    it(`keeps HTTP ${response.status} non-authoritative and reconciliation-required`, async () => {
      const value = ready(); try { const result = await claimAndSubmitNativePrompt(stores(value), { dispatchKey: 'dispatch:key', claimEvidence,
        resolveAuthorization: async () => 'Basic secret', signal: AbortSignal.timeout(1000), fetch: (async () => response) as typeof fetch });
        assert.equal(result.status, 'RECONCILIATION_REQUIRED'); if (result.status === 'RECONCILIATION_REQUIRED') {
          assert.equal(result.transport, 'ATTEMPTED_HTTP_ERROR'); assert.equal(result.httpStatus, response.status);
        }
      } finally { value.db.close(); }
    });
  }

  it('treats thrown transport errors as ambiguous without leaking their text', async () => {
    const value = ready(); try { const result = await claimAndSubmitNativePrompt(stores(value), { dispatchKey: 'dispatch:key', claimEvidence,
      resolveAuthorization: async () => 'Basic secret', signal: AbortSignal.timeout(1000), fetch: (async () => { throw new Error('Basic secret leak'); }) as typeof fetch });
      assert.equal(result.status, 'RECONCILIATION_REQUIRED'); assert.equal(JSON.stringify(result).includes('secret'), false);
      if (result.status === 'RECONCILIATION_REQUIRED') assert.equal(result.transport, 'ATTEMPTED_NETWORK_ERROR');
    } finally { value.db.close(); }
  });

  it('blocks unsupported contracts, missing auth and pre-claim abort without consuming the key', async () => {
    for (const kind of ['contract','auth','abort'] as const) { const value = ready(); try {
      if (kind === 'contract') { const server = value.db.nativeServers.get('server')!; assert.ok(server.inspection?.compatibility); server.inspection.compatibility.messageSend = false;
        value.db.db.prepare('UPDATE native_servers SET record_json=? WHERE server_id=?').run(JSON.stringify(server),'server'); }
      const controller = new AbortController(); if (kind === 'abort') controller.abort(); let calls = 0;
      const result = await claimAndSubmitNativePrompt(stores(value), { dispatchKey: 'dispatch:key', claimEvidence,
        resolveAuthorization: async () => kind === 'auth' ? undefined : 'Basic secret', signal: controller.signal,
        fetch: (async () => { calls++; return new Response(null, { status: 204 }); }) as typeof fetch });
      assert.equal(result.status, 'BLOCKED'); assert.equal(calls, 0); assert.equal(value.db.nativeDispatchClaims.get('dispatch:key'), undefined);
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status, 'pending');
    } finally { value.db.close(); } }
  });
});

describe('native dispatch transcript reconciliation', () => {
  const claimEvidence = { now: 320, accountPolicyHash: 'account-policy', taskQuotaEvidenceHash: operationalEvidence.taskQuotaEvidenceHash,
    privacyEvidenceHash: operationalEvidence.privacyEvidenceHash, runtimeEvidenceHash: operationalEvidence.runtimeEvidenceHash };
  function claimed() { const value = setup(); value.db.nativeDispatchIntents.prepare(value.input);
    value.db.nativeDispatchAuthorizations.authorize({ dispatchKey: 'dispatch:key', authorizedAt: 310, eligibility: eligibility(), operationalEvidence });
    value.db.nativeDispatchClaims.claim('dispatch:key',claimEvidence); return value; }
  function observe(value: ReturnType<typeof setup>, observedAt: number, kind: 'exact'|'absent'|'mismatch'|'old') {
    const messages: NativeTranscriptPage['messages'] = [];
    if (kind !== 'absent') messages.push({ id: providerMessageIdFor('dispatch:key'), sessionId: 'ses_exact', role: 'user', createdAt: kind === 'old' ? 319 : 325,
      providerId: 'provider', modelId: 'model', parts: [{ id: `part-${observedAt}`, type: 'text', text: kind === 'mismatch' ? 'Wrong work' : 'Do work' }] });
    value.db.nativeTranscripts.save({ status: 'READ',serverId:'server',serverRevision:2,apiSpecHash:'digest',observedAt,
      session:{id:'ses_exact',directory:'/project'},messages,completeHistory:false });
  }
  it('confirms only the exact deterministic post-claim user message and leaves execution unproven', () => {
    const value = claimed(); try { observe(value,350,'exact'); const result = value.db.nativeDispatchReconciliations.reconcile('dispatch:key');
      assert.equal(result.verdict,'DELIVERED'); assert.equal(result.reason,'EXACT_MESSAGE_PERSISTED');
      assert.deepEqual(value.db.nativeDispatchReconciliations.latest('dispatch:key'),result);
      const delivery = value.db.db.prepare("SELECT status,delivered_at,failure_reason,evidence_json FROM deliveries WHERE id='delivery'").get();
      assert.equal(delivery?.status,'delivered'); assert.equal(delivery?.delivered_at,350); assert.equal(delivery?.failure_reason,null);
      const evidence = JSON.parse(String(delivery?.evidence_json)); assert.equal(evidence.source,'reconciliation_probe');
      assert.equal(evidence.details.providerMessageId,providerMessageIdFor('dispatch:key')); assert.equal(JSON.stringify(evidence).includes('Do work'),false);
      assert.equal(value.db.db.prepare("SELECT status FROM attempts WHERE id='attempt'").get()?.status,'prepared');
    } finally { value.db.close(); }
  });
  it('marks a partial-page absence ambiguous and permits later exact evidence to recover it', () => {
    const value = claimed(); try { observe(value,350,'absent'); const first = value.db.nativeDispatchReconciliations.reconcile('dispatch:key');
      assert.equal(first.verdict,'AMBIGUOUS'); assert.equal(first.reason,'MESSAGE_ABSENT_FROM_PARTIAL_PAGE');
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status,'ambiguous');
      observe(value,360,'exact'); const second = value.db.nativeDispatchReconciliations.reconcile('dispatch:key');
      assert.equal(second.verdict,'DELIVERED'); assert.equal(value.db.db.prepare('SELECT COUNT(*) AS n FROM native_dispatch_reconciliations').get()?.n,2);
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status,'delivered');
    } finally { value.db.close(); }
  });
  it('treats a deterministic ID with changed payload as ambiguous', () => {
    const value = claimed(); try { observe(value,350,'mismatch'); const result = value.db.nativeDispatchReconciliations.reconcile('dispatch:key');
      assert.equal(result.verdict,'AMBIGUOUS'); assert.equal(result.reason,'MESSAGE_EVIDENCE_MISMATCH');
    } finally { value.db.close(); }
  });
  it('does not accept a deterministic ID whose provider timestamp predates the claim', () => {
    const value = claimed(); try { observe(value,350,'old'); const result = value.db.nativeDispatchReconciliations.reconcile('dispatch:key');
      assert.equal(result.verdict,'AMBIGUOUS'); assert.equal(result.reason,'MESSAGE_EVIDENCE_MISMATCH');
    } finally { value.db.close(); }
  });
  it('requires a newer transcript and an intact pre-dispatch boundary', () => {
    let value = claimed(); try { assert.throws(() => value.db.nativeDispatchReconciliations.reconcile('dispatch:key'),/Post-claim transcript unavailable/);
      assert.equal(value.db.nativeDispatchReconciliations.latest('dispatch:key'),undefined);
    } finally { value.db.close(); }
    value = claimed(); try { observe(value,350,'exact'); value.db.db.exec("UPDATE native_transcript_observations SET payload_hash='" + digest('forged') + "' WHERE observed_at=250");
      assert.throws(() => value.db.nativeDispatchReconciliations.reconcile('dispatch:key'),/boundary mismatch/);
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status,'delivering');
    } finally { value.db.close(); }
  });
  it('is idempotent for one observation, terminal after delivery, and rolls back with outer work', async () => {
    let value = claimed(); try { observe(value,350,'exact'); const first = value.db.nativeDispatchReconciliations.reconcile('dispatch:key');
      assert.deepEqual(value.db.nativeDispatchReconciliations.reconcile('dispatch:key'),first); observe(value,360,'absent');
      assert.deepEqual(value.db.nativeDispatchReconciliations.reconcile('dispatch:key'),first);
      assert.equal(value.db.db.prepare('SELECT COUNT(*) AS n FROM native_dispatch_reconciliations').get()?.n,1);
    } finally { value.db.close(); }
    value = claimed(); try { observe(value,350,'exact');
      await assert.rejects(value.db.runInTransaction(async () => { value.db.nativeDispatchReconciliations.reconcile('dispatch:key'); throw new Error('abort'); }));
      assert.equal(value.db.nativeDispatchReconciliations.latest('dispatch:key'),undefined);
      assert.equal(value.db.db.prepare("SELECT status FROM deliveries WHERE id='delivery'").get()?.status,'delivering');
    } finally { value.db.close(); }
  });
  it('detects stored reconciliation tampering', () => {
    const value = claimed(); try { observe(value,350,'exact'); value.db.nativeDispatchReconciliations.reconcile('dispatch:key');
      value.db.db.exec("UPDATE native_dispatch_reconciliations SET verdict='AMBIGUOUS'");
      assert.throws(() => value.db.nativeDispatchReconciliations.latest('dispatch:key'),/index mismatch/);
    } finally { value.db.close(); }
  });
});
