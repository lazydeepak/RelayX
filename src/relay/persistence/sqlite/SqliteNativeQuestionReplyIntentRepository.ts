import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NativePendingQuestion } from '../../providers/nativeQuestionReader';
import { SqliteNativeDispatchClaimRepository } from './SqliteNativeDispatchClaimRepository';
import { SqliteNativeDispatchIntentRepository } from './SqliteNativeDispatchIntentRepository';
import { SqliteNativeQuestionRepository } from './SqliteNativeQuestionRepository';
import { SqliteNativeServerRepository } from './SqliteNativeServerRepository';

export interface NativeQuestionReplyIntent {
  replyKey: string; dispatchKey: string; assignmentId: string; attemptId: string;
  serverId: string; serverRevision: number; sessionId: string; directory: string;
  requestId: string; messageId: string; callId: string; answers: string[][]; answerDigest: string;
  questionObservation: { observedAt: number; payloadDigest: string };
  plannerDecisionId: string; policyVersion: string;
  state: 'PREPARED_UNAUTHORIZED'; createdAt: number;
}

/** Freezes an exact answer to one currently pending native question. Preparation
 * records no authority to reply and performs no transport operation. */
export class SqliteNativeQuestionReplyIntentRepository {
  constructor(private readonly db: DatabaseSync) {}
  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_question_reply_intents (
      reply_key TEXT PRIMARY KEY,
      dispatch_key TEXT NOT NULL REFERENCES native_dispatch_claims(dispatch_key) ON DELETE CASCADE,
      assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL, server_revision INTEGER NOT NULL,
      session_id TEXT NOT NULL, directory TEXT NOT NULL,
      request_id TEXT NOT NULL, answer_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state='PREPARED_UNAUTHORIZED'), created_at REAL NOT NULL,
      intent_hash TEXT NOT NULL, intent_json TEXT NOT NULL,
      FOREIGN KEY(server_id,server_revision) REFERENCES native_server_history(server_id,revision),
      UNIQUE(server_id,session_id,request_id)
    );`);
  }
  get(replyKey: string): NativeQuestionReplyIntent | undefined {
    const row = this.db.prepare('SELECT * FROM native_question_reply_intents WHERE reply_key=?').get(replyKey);
    if (!row) return undefined;
    const intent = this.validate(JSON.parse(String(row.intent_json)));
    if (intent.replyKey !== row.reply_key || intent.dispatchKey !== row.dispatch_key
      || intent.assignmentId !== row.assignment_id || intent.attemptId !== row.attempt_id
      || intent.serverId !== row.server_id || intent.serverRevision !== row.server_revision
      || intent.sessionId !== row.session_id || intent.directory !== row.directory
      || intent.requestId !== row.request_id || intent.answerDigest !== row.answer_digest
      || intent.state !== row.state || intent.createdAt !== row.created_at
      || this.hash(intent) !== row.intent_hash) throw new Error('Native question reply intent index mismatch');
    return intent;
  }
  prepare(input: Omit<NativeQuestionReplyIntent, 'assignmentId' | 'attemptId' | 'serverId' | 'serverRevision'
    | 'sessionId' | 'directory' | 'messageId' | 'callId' | 'answerDigest' | 'questionObservation' | 'state'>): NativeQuestionReplyIntent {
    if (!/^[A-Za-z0-9._:-]+$/.test(input.replyKey) || !input.dispatchKey?.trim()
      || !input.requestId?.trim() || !input.plannerDecisionId?.trim() || !input.policyVersion?.trim()
      || !Number.isFinite(input.createdAt) || input.createdAt < 0) throw new Error('Invalid native question reply preparation');
    const dispatch = new SqliteNativeDispatchIntentRepository(this.db).get(input.dispatchKey);
    const claim = new SqliteNativeDispatchClaimRepository(this.db).get(input.dispatchKey);
    if (!dispatch || !claim) throw new Error('Native question reply dispatch authority unavailable');
    const attempt = this.db.prepare('SELECT status FROM attempts WHERE id=? AND assignment_id=?').get(dispatch.attemptId, dispatch.assignmentId);
    const delivery = this.db.prepare('SELECT status FROM deliveries WHERE id=? AND attempt_id=?').get(dispatch.deliveryId, dispatch.attemptId);
    const assignment = this.db.prepare('SELECT current_attempt_id,active_delivery_id FROM assignments WHERE id=?').get(dispatch.assignmentId);
    const execution = this.db.prepare('SELECT dispatch_key FROM native_execution_observations WHERE dispatch_key=?').get(input.dispatchKey);
    if (attempt?.status !== 'running' || delivery?.status !== 'delivered' || !execution
      || assignment?.current_attempt_id !== dispatch.attemptId || assignment?.active_delivery_id !== dispatch.deliveryId) {
      throw new Error('Native question reply run is not waiting-capable');
    }
    const server = new SqliteNativeServerRepository(this.db).get(dispatch.serverId);
    if (!server || server.lifecycle !== 'INSPECTED' || server.revision !== dispatch.serverRevision
      || server.inspection?.compatibility?.questionReply !== true) throw new Error('Native question reply API authority unavailable');
    const observation = new SqliteNativeQuestionRepository(this.db).latest(dispatch.serverId, dispatch.sessionId, dispatch.directory);
    const row = this.db.prepare(`SELECT observed_at,payload_hash FROM native_question_observations
      WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`).get(
      dispatch.serverId, dispatch.sessionId, dispatch.directory);
    if (!row || input.createdAt < Number(row.observed_at)) throw new Error('Native pending question evidence unavailable');
    if (!observation || observation.serverRevision !== dispatch.serverRevision
      || observation.apiSpecHash !== dispatch.boundary.apiSpecHash) throw new Error('Native pending question authority changed');
    const matches = observation.questions.filter((candidate: NativePendingQuestion) => candidate?.requestId === input.requestId);
    if (matches.length !== 1) throw new Error('Native question is not currently pending');
    const question = matches[0]; const answers = this.answers(input.answers, question);
    const intent = this.validate({ replyKey: input.replyKey, dispatchKey: input.dispatchKey,
      assignmentId: dispatch.assignmentId, attemptId: dispatch.attemptId,
      serverId: dispatch.serverId, serverRevision: dispatch.serverRevision,
      sessionId: dispatch.sessionId, directory: dispatch.directory, requestId: input.requestId,
      messageId: question.messageId, callId: question.callId, answers, answerDigest: this.hash(answers),
      questionObservation: { observedAt: Number(row.observed_at), payloadDigest: String(row.payload_hash) },
      plannerDecisionId: input.plannerDecisionId, policyVersion: input.policyVersion,
      state: 'PREPARED_UNAUTHORIZED', createdAt: input.createdAt });
    this.db.exec('SAVEPOINT native_question_reply_prepare');
    try {
      const existing = this.get(intent.replyKey);
      if (existing) { if (JSON.stringify(existing) !== JSON.stringify(intent)) throw new Error('Conflicting native question reply key'); }
      else this.db.prepare(`INSERT INTO native_question_reply_intents
        (reply_key,dispatch_key,assignment_id,attempt_id,server_id,server_revision,session_id,directory,request_id,answer_digest,state,created_at,intent_hash,intent_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(intent.replyKey, intent.dispatchKey, intent.assignmentId,
          intent.attemptId, intent.serverId, intent.serverRevision, intent.sessionId, intent.directory,
          intent.requestId, intent.answerDigest, intent.state, intent.createdAt, this.hash(intent), JSON.stringify(intent));
      this.db.exec('RELEASE native_question_reply_prepare'); return intent;
    } catch (error) { this.db.exec('ROLLBACK TO native_question_reply_prepare'); this.db.exec('RELEASE native_question_reply_prepare'); throw error; }
  }
  private answers(value: string[][], request: NativePendingQuestion): string[][] {
    if (!Array.isArray(value) || value.length !== request.questions.length) throw new Error('Native question answer count mismatch');
    return value.map((answer, index) => {
      const question = request.questions[index];
      if (!Array.isArray(answer) || answer.length === 0 || (!question.multiple && answer.length !== 1)) throw new Error('Invalid native question answer cardinality');
      const normalized = answer.map(item => {
        if (typeof item !== 'string' || !item.trim()) throw new Error('Invalid native question answer');
        if (!question.custom && !question.options.some(option => option.label === item)) throw new Error('Native question answer is not an allowed option');
        return item;
      });
      if (new Set(normalized).size !== normalized.length) throw new Error('Duplicate native question answer');
      return normalized;
    });
  }
  private validate(value: NativeQuestionReplyIntent): NativeQuestionReplyIntent {
    if (!value || !/^[A-Za-z0-9._:-]+$/.test(value.replyKey) || !value.dispatchKey?.trim()
      || !value.assignmentId?.trim() || !value.attemptId?.trim() || !value.serverId?.trim()
      || !Number.isSafeInteger(value.serverRevision) || value.serverRevision < 1
      || !/^ses_[A-Za-z0-9_-]+$/.test(value.sessionId) || !value.directory?.startsWith('/')
      || !value.requestId?.trim() || !value.messageId?.trim() || !value.callId?.trim()
      || !Array.isArray(value.answers) || value.answers.length === 0
      || value.answerDigest !== this.hash(value.answers) || !Number.isFinite(value.questionObservation?.observedAt)
      || !/^[a-f0-9]{64}$/.test(value.questionObservation?.payloadDigest)
      || !value.plannerDecisionId?.trim() || !value.policyVersion?.trim()
      || value.state !== 'PREPARED_UNAUTHORIZED' || !Number.isFinite(value.createdAt)
      || value.createdAt < value.questionObservation.observedAt) throw new Error('Invalid native question reply intent');
    return structuredClone(value);
  }
  private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
