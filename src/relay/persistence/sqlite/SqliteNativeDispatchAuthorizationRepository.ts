import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { COST_DIMENSIONS, evaluateEligibility, sameRoute, type EligibilityRequest } from '../../model-intelligence/eligibility';
import { SqliteNativeDispatchIntentRepository } from './SqliteNativeDispatchIntentRepository';
import { SqliteNativeServerRepository } from './SqliteNativeServerRepository';
import { SqliteNativeTranscriptRepository } from './SqliteNativeTranscriptRepository';
import { SqliteNativeQuestionRepository } from './SqliteNativeQuestionRepository';

export interface NativeOperationalEvidence {
  verifiedAt: number;
  expiresAt: number;
  taskQuotaEvidenceHash: string;
  privacyEvidenceHash: string;
  runtimeEvidenceHash: string;
}
export interface NativeDispatchAuthorization {
  dispatchKey: string;
  intentHash: string;
  eligibilityDigest: string;
  accountPolicyHash: string;
  pricingEvidenceHash: string;
  accountEvidenceHash: string;
  qualificationEvidenceHash: string;
  taskQuotaEvidenceHash: string;
  privacyEvidenceHash: string;
  runtimeEvidenceHash: string;
  taskClass: string;
  authorizedAt: number;
  expiresAt: number;
  state: 'AUTHORIZED_UNCONSUMED';
}

/** Authorization is a separate immutable permit. It cannot mutate the prepared
 * intent or send it, and future send code must recheck this permit at use time. */
export class SqliteNativeDispatchAuthorizationRepository {
  constructor(private readonly db: DatabaseSync) {}
  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_dispatch_authorizations (
      dispatch_key TEXT PRIMARY KEY REFERENCES native_dispatch_intents(dispatch_key) ON DELETE CASCADE,
      intent_hash TEXT NOT NULL, eligibility_digest TEXT NOT NULL,
      account_policy_hash TEXT NOT NULL, authorized_at REAL NOT NULL, expires_at REAL NOT NULL,
      state TEXT NOT NULL CHECK(state='AUTHORIZED_UNCONSUMED'),
      authorization_hash TEXT NOT NULL, authorization_json TEXT NOT NULL
    );`);
  }
  get(dispatchKey: string): NativeDispatchAuthorization | undefined {
    const row = this.db.prepare('SELECT * FROM native_dispatch_authorizations WHERE dispatch_key=?').get(dispatchKey);
    if (!row) return undefined;
    const authorization = this.canonical(JSON.parse(String(row.authorization_json)));
    if (authorization.dispatchKey !== row.dispatch_key || authorization.intentHash !== row.intent_hash
      || authorization.eligibilityDigest !== row.eligibility_digest || authorization.accountPolicyHash !== row.account_policy_hash
      || authorization.authorizedAt !== row.authorized_at || authorization.expiresAt !== row.expires_at
      || authorization.state !== row.state || this.hash(authorization) !== row.authorization_hash) throw new Error('Native dispatch authorization index mismatch');
    return authorization;
  }
  authorize(input: {
    dispatchKey: string;
    authorizedAt: number;
    eligibility: EligibilityRequest;
    operationalEvidence: NativeOperationalEvidence;
  }): NativeDispatchAuthorization {
    const intent = new SqliteNativeDispatchIntentRepository(this.db).get(input.dispatchKey);
    if (!intent) throw new Error('Native dispatch intent not found');
    if (!Number.isFinite(input.authorizedAt) || input.authorizedAt < intent.createdAt
      || input.eligibility.now !== input.authorizedAt || input.eligibility.purpose !== 'TASK'
      || !sameRoute(intent.modelRoute, input.eligibility.route)) throw new Error('Native authorization intent mismatch');
    const decision = evaluateEligibility(input.eligibility);
    if (!decision.dispatchable || !input.eligibility.lease || !input.eligibility.qualification) {
      throw new Error(`Native dispatch eligibility denied: ${decision.reasons.join(',') || 'MISSING_EVIDENCE'}`);
    }
    const operational = input.operationalEvidence;
    if (!Number.isFinite(operational?.verifiedAt) || !Number.isFinite(operational?.expiresAt)
      || operational.verifiedAt > input.authorizedAt || input.authorizedAt >= operational.expiresAt
      || !this.digest(operational.taskQuotaEvidenceHash) || !this.digest(operational.privacyEvidenceHash)
      || !this.digest(operational.runtimeEvidenceHash)) throw new Error('Invalid operational authorization evidence');
    const server = new SqliteNativeServerRepository(this.db).get(intent.serverId);
    const assignment = this.db.prepare('SELECT current_attempt_id,active_delivery_id FROM assignments WHERE id=?').get(intent.assignmentId);
    const delivery = this.db.prepare('SELECT status,idempotency_key FROM deliveries WHERE id=?').get(intent.deliveryId);
    const attempt = this.db.prepare('SELECT status,external_session_id FROM attempts WHERE id=?').get(intent.attemptId);
    if (!server || server.lifecycle !== 'INSPECTED' || server.revision !== intent.serverRevision
      || server.inspection?.apiSpecHash !== intent.boundary.apiSpecHash || delivery?.status !== 'pending'
      || delivery.idempotency_key !== intent.dispatchKey || attempt?.status !== 'prepared'
      || attempt.external_session_id !== intent.sessionId || assignment?.current_attempt_id !== intent.attemptId
      || assignment.active_delivery_id !== intent.deliveryId) throw new Error('Native authorization authority superseded');
    const transcriptRow = this.db.prepare(`SELECT observed_at,payload_hash FROM native_transcript_observations
      WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`).get(intent.serverId,intent.sessionId,intent.directory);
    const questionRow = this.db.prepare(`SELECT observed_at,payload_hash FROM native_question_observations
      WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`).get(intent.serverId,intent.sessionId,intent.directory);
    const events = this.db.prepare(`SELECT observed_at,last_event_id FROM native_event_batches
      WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`).get(intent.serverId,intent.sessionId,intent.directory);
    const transcript = new SqliteNativeTranscriptRepository(this.db).latest(intent.serverId,intent.sessionId,intent.directory);
    const questions = new SqliteNativeQuestionRepository(this.db).latest(intent.serverId,intent.sessionId,intent.directory);
    if (!transcriptRow || !questionRow || !events || !transcript || !questions
      || transcript.observedAt !== intent.boundary.observedAt || questions.observedAt !== intent.boundary.observedAt
      || events.observed_at !== intent.boundary.observedAt || transcriptRow.payload_hash !== intent.boundary.transcriptDigest
      || questionRow.payload_hash !== intent.boundary.questionDigest || (events.last_event_id ?? undefined) !== intent.boundary.eventCursor
      || questions.questions.length !== 0) throw new Error('Native authorization boundary superseded');
    const expiresAt = Math.min(input.eligibility.lease.expiresAt, input.eligibility.qualification.expiresAt, operational.expiresAt);
    if (!(input.authorizedAt < expiresAt)) throw new Error('Native authorization has no usable lifetime');
    const eligibility = this.eligibility(input.eligibility);
    const intentHash = this.hash(intent);
    const authorization = this.canonical({ dispatchKey: input.dispatchKey, intentHash,
      eligibilityDigest: this.hash(eligibility), accountPolicyHash: input.eligibility.accountPolicyHash,
      pricingEvidenceHash: input.eligibility.lease.pricingEvidence.contentHash,
      accountEvidenceHash: input.eligibility.lease.accountEvidence.contentHash,
      qualificationEvidenceHash: input.eligibility.qualification.evidenceHash,
      taskQuotaEvidenceHash: operational.taskQuotaEvidenceHash, privacyEvidenceHash: operational.privacyEvidenceHash,
      runtimeEvidenceHash: operational.runtimeEvidenceHash, taskClass: input.eligibility.taskClass,
      authorizedAt: input.authorizedAt, expiresAt, state: 'AUTHORIZED_UNCONSUMED' });
    this.db.exec('SAVEPOINT native_dispatch_authorize');
    try {
      const existing = this.get(input.dispatchKey);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(authorization)) throw new Error('Conflicting native dispatch authorization');
      } else this.db.prepare(`INSERT INTO native_dispatch_authorizations
        (dispatch_key,intent_hash,eligibility_digest,account_policy_hash,authorized_at,expires_at,state,authorization_hash,authorization_json)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(authorization.dispatchKey, authorization.intentHash, authorization.eligibilityDigest,
          authorization.accountPolicyHash, authorization.authorizedAt, authorization.expiresAt, authorization.state,
          this.hash(authorization), JSON.stringify(authorization));
      this.db.exec('RELEASE native_dispatch_authorize'); return authorization;
    } catch (error) { this.db.exec('ROLLBACK TO native_dispatch_authorize'); this.db.exec('RELEASE native_dispatch_authorize'); throw error; }
  }
  checkUsable(dispatchKey: string, input: { now: number; accountPolicyHash: string; taskQuotaEvidenceHash: string; privacyEvidenceHash: string; runtimeEvidenceHash: string }): { usable: boolean; reasons: string[] } {
    const reasons: string[] = []; const authorization = this.get(dispatchKey);
    if (!authorization) return { usable: false, reasons: ['AUTHORIZATION_MISSING'] };
    const intent = new SqliteNativeDispatchIntentRepository(this.db).get(dispatchKey);
    if (!intent || this.hash(intent) !== authorization.intentHash) reasons.push('INTENT_CHANGED');
    if (!Number.isFinite(input.now) || input.now < authorization.authorizedAt || input.now >= authorization.expiresAt) reasons.push('AUTHORIZATION_NOT_CURRENT');
    if (input.accountPolicyHash !== authorization.accountPolicyHash) reasons.push('ACCOUNT_POLICY_CHANGED');
    for (const key of ['taskQuotaEvidenceHash','privacyEvidenceHash','runtimeEvidenceHash'] as const) if (input[key] !== authorization[key]) reasons.push(`${key.replace('EvidenceHash','').toUpperCase()}_EVIDENCE_CHANGED`);
    if (intent) {
      const server = new SqliteNativeServerRepository(this.db).get(intent.serverId);
      const assignment = this.db.prepare('SELECT current_attempt_id,active_delivery_id FROM assignments WHERE id=?').get(intent.assignmentId);
      const delivery = this.db.prepare('SELECT status FROM deliveries WHERE id=?').get(intent.deliveryId);
      const attempt = this.db.prepare('SELECT status FROM attempts WHERE id=?').get(intent.attemptId);
      if (!server || server.lifecycle !== 'INSPECTED' || server.revision !== intent.serverRevision) reasons.push('SERVER_AUTHORITY_CHANGED');
      if (delivery?.status !== 'pending' || attempt?.status !== 'prepared'
        || assignment?.current_attempt_id !== intent.attemptId || assignment.active_delivery_id !== intent.deliveryId) reasons.push('RELAY_AUTHORITY_CHANGED');
      const transcript = this.db.prepare(`SELECT observed_at,payload_hash FROM native_transcript_observations
        WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`).get(intent.serverId,intent.sessionId,intent.directory);
      const questions = this.db.prepare(`SELECT observed_at,payload_hash FROM native_question_observations
        WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`).get(intent.serverId,intent.sessionId,intent.directory);
      const events = this.db.prepare(`SELECT observed_at,last_event_id FROM native_event_batches
        WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`).get(intent.serverId,intent.sessionId,intent.directory);
      let validatedTranscript; let validatedQuestions;
      try {
        validatedTranscript = new SqliteNativeTranscriptRepository(this.db).latest(intent.serverId,intent.sessionId,intent.directory);
        validatedQuestions = new SqliteNativeQuestionRepository(this.db).latest(intent.serverId,intent.sessionId,intent.directory);
      } catch { /* corrupt evidence fails closed */ }
      if (!transcript || !questions || !events || !validatedTranscript || !validatedQuestions
        || transcript.observed_at !== intent.boundary.observedAt
        || questions.observed_at !== intent.boundary.observedAt || events.observed_at !== intent.boundary.observedAt
        || transcript.payload_hash !== intent.boundary.transcriptDigest || questions.payload_hash !== intent.boundary.questionDigest
        || validatedTranscript.observedAt !== intent.boundary.observedAt || validatedQuestions.observedAt !== intent.boundary.observedAt
        || (events.last_event_id ?? undefined) !== intent.boundary.eventCursor
        || validatedQuestions.questions.length !== 0) reasons.push('OBSERVATION_BOUNDARY_CHANGED');
    }
    return { usable: reasons.length === 0, reasons };
  }
  private eligibility(value: EligibilityRequest): unknown {
    const lease = value.lease!; const qualification = value.qualification!;
    const source = (item: typeof lease.pricingEvidence) => ({ sourceUrl: item.sourceUrl, fetchedAt: item.fetchedAt, contentHash: item.contentHash, parserVersion: item.parserVersion });
    const route = { providerId: value.route.providerId, endpointId: value.route.endpointId, publishedModelId: value.route.publishedModelId, accountId: value.route.accountId, runtimeConfigFingerprint: value.route.runtimeConfigFingerprint };
    return { route, now: value.now, accountPolicyHash: value.accountPolicyHash, taskClass: value.taskClass, purpose: value.purpose,
      lease: { route: { ...route }, verifiedAt: lease.verifiedAt, expiresAt: lease.expiresAt, verdict: lease.verdict,
        pricingEvidence: source(lease.pricingEvidence), accountEvidence: source(lease.accountEvidence), accountPolicyHash: lease.accountPolicyHash,
        costs: Object.fromEntries(COST_DIMENSIONS.map(key => [key, lease.costs[key]])), conflicts: [...lease.conflicts] },
      qualification: { route: { ...route }, taskClass: qualification.taskClass, verifiedAt: qualification.verifiedAt,
        expiresAt: qualification.expiresAt, accepted: qualification.accepted, evidenceHash: qualification.evidenceHash },
      taskQuota: value.taskQuota, evaluationQuota: value.evaluationQuota, privacy: value.privacy, runtime: value.runtime };
  }
  private canonical(value: NativeDispatchAuthorization): NativeDispatchAuthorization {
    const hashes = ['intentHash','eligibilityDigest','pricingEvidenceHash','accountEvidenceHash','qualificationEvidenceHash','taskQuotaEvidenceHash','privacyEvidenceHash','runtimeEvidenceHash'] as const;
    if (!value?.dispatchKey?.trim() || value.state !== 'AUTHORIZED_UNCONSUMED' || !value.accountPolicyHash?.trim()
      || !value.taskClass?.trim() || !Number.isFinite(value.authorizedAt) || !Number.isFinite(value.expiresAt)
      || value.authorizedAt >= value.expiresAt || !hashes.every(key => this.digest(value[key]))) throw new Error('Invalid native dispatch authorization');
    return Object.fromEntries(['dispatchKey',...hashes,'accountPolicyHash','taskClass','authorizedAt','expiresAt','state'].map(key => [key, value[key as keyof NativeDispatchAuthorization]])) as unknown as NativeDispatchAuthorization;
  }
  private digest(value: unknown): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
  private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
