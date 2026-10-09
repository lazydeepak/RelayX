import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { providerMessageIdFor } from '../../providers/nativePromptSubmission';
import { SqliteNativeDispatchIntentRepository } from './SqliteNativeDispatchIntentRepository';
import { SqliteNativeDispatchReconciliationRepository } from './SqliteNativeDispatchReconciliationRepository';
import { SqliteNativeTranscriptRepository } from './SqliteNativeTranscriptRepository';

export interface NativeExecutionObservation {
  dispatchKey: string;
  userMessageId: string;
  assistantMessageId: string;
  transcriptDigest: string;
  observedAt: number;
  state: 'EXECUTION_STARTED';
}

export class SqliteNativeExecutionObservationRepository {
  constructor(private readonly db: DatabaseSync) {}
  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_execution_observations (
      dispatch_key TEXT PRIMARY KEY REFERENCES native_dispatch_claims(dispatch_key) ON DELETE CASCADE,
      assistant_message_id TEXT NOT NULL, observed_at REAL NOT NULL, transcript_digest TEXT NOT NULL,
      observation_hash TEXT NOT NULL, observation_json TEXT NOT NULL
    );`);
  }
  get(dispatchKey: string): NativeExecutionObservation | undefined {
    const row = this.db.prepare('SELECT * FROM native_execution_observations WHERE dispatch_key=?').get(dispatchKey);
    if (!row) return undefined;
    const result = this.validate(JSON.parse(String(row.observation_json)));
    if (result.dispatchKey !== row.dispatch_key || result.assistantMessageId !== row.assistant_message_id
      || result.observedAt !== row.observed_at || result.transcriptDigest !== row.transcript_digest
      || this.hash(result) !== row.observation_hash) throw new Error('Native execution observation index mismatch');
    return result;
  }
  observe(dispatchKey: string): { observed: boolean; observation?: NativeExecutionObservation } {
    const existing = this.get(dispatchKey);
    if (existing) return { observed: true, observation: existing };
    const intent = new SqliteNativeDispatchIntentRepository(this.db).get(dispatchKey);
    const delivery = intent && this.db.prepare('SELECT status FROM deliveries WHERE id=?').get(intent.deliveryId);
    const reconciliation = new SqliteNativeDispatchReconciliationRepository(this.db).latest(dispatchKey);
    if (!intent || delivery?.status !== 'delivered' || reconciliation?.verdict !== 'DELIVERED') {
      throw new Error('Native delivered dispatch evidence unavailable');
    }
    const transcript = new SqliteNativeTranscriptRepository(this.db).latest(intent.serverId,intent.sessionId,intent.directory);
    if (!transcript || transcript.observedAt < reconciliation.observedAt
      || transcript.serverRevision !== intent.serverRevision || transcript.apiSpecHash !== intent.boundary.apiSpecHash) {
      throw new Error('Native execution transcript unavailable');
    }
    const userMessageId = providerMessageIdFor(dispatchKey);
    const deliveredRow = this.db.prepare(`SELECT payload_hash,page_json FROM native_transcript_observations
      WHERE server_id=? AND session_id=? AND directory=? AND observed_at=?`).get(
        intent.serverId,intent.sessionId,intent.directory,reconciliation.observedAt);
    if (!deliveredRow || deliveredRow.payload_hash !== reconciliation.transcriptDigest) {
      throw new Error('Native delivered transcript evidence mismatch');
    }
    const deliveredPage = JSON.parse(String(deliveredRow.page_json)) as { messages?: Array<{
      id?: string; role?: string; createdAt?: number;
    }> };
    if (this.hash(deliveredPage) !== deliveredRow.payload_hash) throw new Error('Native delivered transcript evidence mismatch');
    const user = deliveredPage.messages?.find(message => message.id === userMessageId);
    if (!user || user.role !== 'user' || !Number.isFinite(user.createdAt)) throw new Error('Native delivered message missing from execution transcript');
    const candidates = transcript.messages.filter(message => message.role === 'assistant' && message.parentId === userMessageId);
    if (candidates.length === 0) return { observed: false };
    if (candidates.length !== 1) throw new Error('Ambiguous native execution evidence');
    const assistant = candidates[0];
    if (assistant.providerId !== intent.modelRoute.providerId || assistant.modelId !== intent.modelRoute.publishedModelId
      || assistant.createdAt < user.createdAt!) throw new Error('Native execution route mismatch');
    const result = this.validate({ dispatchKey, userMessageId, assistantMessageId: assistant.id,
      transcriptDigest: this.hash(transcript), observedAt: transcript.observedAt, state: 'EXECUTION_STARTED' });
    this.db.exec('SAVEPOINT native_execution_observe');
    try {
      const raced = this.get(dispatchKey);
      if (raced) { this.db.exec('RELEASE native_execution_observe'); return { observed: true, observation: raced }; }
      const evidence = JSON.stringify({ id: `native_execution_${this.hash(result).slice(0,24)}`, timestamp: result.observedAt,
        source: 'reconciliation_probe', details: { executionState: 'running', userMessageId,
          assistantMessageId: assistant.id, transcriptDigest: result.transcriptDigest } });
      const changed = this.db.prepare(`UPDATE attempts SET status='running',evidence_json=?
        WHERE id=? AND assignment_id=? AND status='prepared' AND external_session_id=?`).run(
          evidence,intent.attemptId,intent.assignmentId,intent.sessionId);
      if (changed.changes !== 1) throw new Error('Native attempt execution authority changed');
      this.db.prepare(`INSERT INTO native_execution_observations
        (dispatch_key,assistant_message_id,observed_at,transcript_digest,observation_hash,observation_json)
        VALUES (?,?,?,?,?,?)`).run(result.dispatchKey,result.assistantMessageId,result.observedAt,
          result.transcriptDigest,this.hash(result),JSON.stringify(result));
      this.db.exec('RELEASE native_execution_observe'); return { observed: true, observation: result };
    } catch (error) { this.db.exec('ROLLBACK TO native_execution_observe'); this.db.exec('RELEASE native_execution_observe'); throw error; }
  }
  private validate(value: NativeExecutionObservation): NativeExecutionObservation {
    if (!value?.dispatchKey?.trim() || !/^msg_relayx_[a-f0-9]{48}$/.test(value.userMessageId)
      || !value.assistantMessageId?.trim() || value.assistantMessageId === value.userMessageId
      || !/^[a-f0-9]{64}$/.test(value.transcriptDigest) || !Number.isFinite(value.observedAt)
      || value.state !== 'EXECUTION_STARTED') throw new Error('Invalid native execution observation');
    return { dispatchKey: value.dispatchKey, userMessageId: value.userMessageId,
      assistantMessageId: value.assistantMessageId, transcriptDigest: value.transcriptDigest,
      observedAt: value.observedAt, state: 'EXECUTION_STARTED' };
  }
  private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
