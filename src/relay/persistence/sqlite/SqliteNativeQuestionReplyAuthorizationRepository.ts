import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteNativeQuestionReplyIntentRepository, type NativeQuestionReplyIntent } from './SqliteNativeQuestionReplyIntentRepository';
import { SqliteNativeQuestionRepository } from './SqliteNativeQuestionRepository';
import { SqliteNativeServerRepository } from './SqliteNativeServerRepository';

export interface NativeQuestionReplyAuthorization {
  replyKey: string;
  intentHash: string;
  plannerApprovalEvidenceHash: string;
  privacyEvidenceHash: string;
  runtimeEvidenceHash: string;
  authorizedAt: number;
  expiresAt: number;
  state: 'AUTHORIZED_UNCONSUMED';
}

export interface NativeQuestionReplyAuthorizationEvidence {
  now: number;
  expiresAt: number;
  plannerApprovalEvidenceHash: string;
  privacyEvidenceHash: string;
  runtimeEvidenceHash: string;
}

/** A bounded permit for an exact prepared answer. It neither consumes the permit
 * nor sends a reply; the future claim boundary must call checkUsable immediately
 * before any transport operation. */
export class SqliteNativeQuestionReplyAuthorizationRepository {
  constructor(private readonly db: DatabaseSync) {}

  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_question_reply_authorizations (
      reply_key TEXT PRIMARY KEY REFERENCES native_question_reply_intents(reply_key) ON DELETE CASCADE,
      intent_hash TEXT NOT NULL, authorized_at REAL NOT NULL, expires_at REAL NOT NULL,
      state TEXT NOT NULL CHECK(state='AUTHORIZED_UNCONSUMED'),
      authorization_hash TEXT NOT NULL, authorization_json TEXT NOT NULL
    );`);
  }

  get(replyKey: string): NativeQuestionReplyAuthorization | undefined {
    const row = this.db.prepare('SELECT * FROM native_question_reply_authorizations WHERE reply_key=?').get(replyKey);
    if (!row) return undefined;
    const authorization = this.validate(JSON.parse(String(row.authorization_json)));
    if (authorization.replyKey !== row.reply_key || authorization.intentHash !== row.intent_hash
      || authorization.authorizedAt !== row.authorized_at || authorization.expiresAt !== row.expires_at
      || authorization.state !== row.state || this.hash(authorization) !== row.authorization_hash) {
      throw new Error('Native question reply authorization index mismatch');
    }
    return authorization;
  }

  authorize(replyKey: string, evidence: NativeQuestionReplyAuthorizationEvidence): NativeQuestionReplyAuthorization {
    const intent = new SqliteNativeQuestionReplyIntentRepository(this.db).get(replyKey);
    if (!intent) throw new Error('Native question reply intent not found');
    if (!Number.isFinite(evidence?.now) || evidence.now < intent.createdAt
      || !Number.isFinite(evidence.expiresAt) || evidence.now >= evidence.expiresAt
      || !this.digest(evidence.plannerApprovalEvidenceHash) || !this.digest(evidence.privacyEvidenceHash)
      || !this.digest(evidence.runtimeEvidenceHash)) throw new Error('Invalid native question reply authorization evidence');
    const reasons = this.authorityReasons(intent);
    if (reasons.length) throw new Error(`Native question reply authority superseded: ${reasons.join(',')}`);
    const authorization = this.validate({ replyKey, intentHash: this.hash(intent),
      plannerApprovalEvidenceHash: evidence.plannerApprovalEvidenceHash,
      privacyEvidenceHash: evidence.privacyEvidenceHash, runtimeEvidenceHash: evidence.runtimeEvidenceHash,
      authorizedAt: evidence.now, expiresAt: evidence.expiresAt, state: 'AUTHORIZED_UNCONSUMED' });
    this.db.exec('SAVEPOINT native_question_reply_authorize');
    try {
      const existing = this.get(replyKey);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(authorization)) throw new Error('Conflicting native question reply authorization');
      } else this.db.prepare(`INSERT INTO native_question_reply_authorizations
        (reply_key,intent_hash,authorized_at,expires_at,state,authorization_hash,authorization_json)
        VALUES (?,?,?,?,?,?,?)`).run(authorization.replyKey, authorization.intentHash,
          authorization.authorizedAt, authorization.expiresAt, authorization.state,
          this.hash(authorization), JSON.stringify(authorization));
      this.db.exec('RELEASE native_question_reply_authorize'); return authorization;
    } catch (error) {
      this.db.exec('ROLLBACK TO native_question_reply_authorize');
      this.db.exec('RELEASE native_question_reply_authorize');
      throw error;
    }
  }

  checkUsable(replyKey: string, evidence: Omit<NativeQuestionReplyAuthorizationEvidence, 'expiresAt'>): { usable: boolean; reasons: string[] } {
    const authorization = this.get(replyKey);
    if (!authorization) return { usable: false, reasons: ['AUTHORIZATION_MISSING'] };
    const reasons: string[] = [];
    const intent = new SqliteNativeQuestionReplyIntentRepository(this.db).get(replyKey);
    if (!intent || this.hash(intent) !== authorization.intentHash) reasons.push('INTENT_CHANGED');
    if (!Number.isFinite(evidence.now) || evidence.now < authorization.authorizedAt || evidence.now >= authorization.expiresAt) reasons.push('AUTHORIZATION_NOT_CURRENT');
    if (evidence.plannerApprovalEvidenceHash !== authorization.plannerApprovalEvidenceHash) reasons.push('PLANNER_APPROVAL_CHANGED');
    if (evidence.privacyEvidenceHash !== authorization.privacyEvidenceHash) reasons.push('PRIVACY_EVIDENCE_CHANGED');
    if (evidence.runtimeEvidenceHash !== authorization.runtimeEvidenceHash) reasons.push('RUNTIME_EVIDENCE_CHANGED');
    if (intent) reasons.push(...this.authorityReasons(intent));
    return { usable: reasons.length === 0, reasons: [...new Set(reasons)] };
  }

  private authorityReasons(intent: NativeQuestionReplyIntent): string[] {
    const reasons: string[] = [];
    const server = new SqliteNativeServerRepository(this.db).get(intent.serverId);
    if (!server || server.lifecycle !== 'INSPECTED' || server.revision !== intent.serverRevision
      || server.inspection?.compatibility?.questionReply !== true) reasons.push('SERVER_AUTHORITY_CHANGED');
    const assignment = this.db.prepare('SELECT current_attempt_id,active_delivery_id FROM assignments WHERE id=?').get(intent.assignmentId);
    const attempt = this.db.prepare('SELECT status FROM attempts WHERE id=?').get(intent.attemptId);
    const dispatch = this.db.prepare('SELECT delivery_id FROM native_dispatch_intents WHERE dispatch_key=?').get(intent.dispatchKey);
    const delivery = dispatch ? this.db.prepare('SELECT status FROM deliveries WHERE id=?').get(dispatch.delivery_id) : undefined;
    const execution = this.db.prepare('SELECT dispatch_key FROM native_execution_observations WHERE dispatch_key=?').get(intent.dispatchKey);
    if (attempt?.status !== 'running' || delivery?.status !== 'delivered' || !execution
      || assignment?.current_attempt_id !== intent.attemptId || assignment?.active_delivery_id !== dispatch?.delivery_id) {
      reasons.push('RELAY_AUTHORITY_CHANGED');
    }
    let questions;
    try { questions = new SqliteNativeQuestionRepository(this.db).latest(intent.serverId, intent.sessionId, intent.directory); }
    catch { reasons.push('QUESTION_EVIDENCE_INVALID'); }
    const row = this.db.prepare(`SELECT observed_at,payload_hash FROM native_question_observations
      WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`).get(
      intent.serverId, intent.sessionId, intent.directory);
    const request = questions?.questions.filter(question => question.requestId === intent.requestId);
    if (!questions || !row || Number(row.observed_at) !== intent.questionObservation.observedAt
      || String(row.payload_hash) !== intent.questionObservation.payloadDigest || request?.length !== 1
      || request[0].messageId !== intent.messageId || request[0].callId !== intent.callId) reasons.push('QUESTION_BOUNDARY_CHANGED');
    return reasons;
  }

  private validate(value: NativeQuestionReplyAuthorization): NativeQuestionReplyAuthorization {
    if (!value?.replyKey?.trim() || !this.digest(value.intentHash)
      || !this.digest(value.plannerApprovalEvidenceHash) || !this.digest(value.privacyEvidenceHash)
      || !this.digest(value.runtimeEvidenceHash) || !Number.isFinite(value.authorizedAt)
      || !Number.isFinite(value.expiresAt) || value.authorizedAt >= value.expiresAt
      || value.state !== 'AUTHORIZED_UNCONSUMED') throw new Error('Invalid native question reply authorization');
    return { replyKey: value.replyKey, intentHash: value.intentHash,
      plannerApprovalEvidenceHash: value.plannerApprovalEvidenceHash,
      privacyEvidenceHash: value.privacyEvidenceHash, runtimeEvidenceHash: value.runtimeEvidenceHash,
      authorizedAt: value.authorizedAt, expiresAt: value.expiresAt, state: 'AUTHORIZED_UNCONSUMED' };
  }
  private digest(value: unknown): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
  private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
