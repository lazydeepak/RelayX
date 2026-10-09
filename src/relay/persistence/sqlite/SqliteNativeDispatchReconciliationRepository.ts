import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { providerMessageIdFor } from '../../providers/nativePromptSubmission';
import { SqliteNativeDispatchIntentRepository } from './SqliteNativeDispatchIntentRepository';
import { SqliteNativeDispatchClaimRepository } from './SqliteNativeDispatchClaimRepository';
import { SqliteNativeTranscriptRepository } from './SqliteNativeTranscriptRepository';

export interface NativeDispatchReconciliation {
  dispatchKey: string;
  providerMessageId: string;
  transcriptDigest: string;
  observedAt: number;
  verdict: 'DELIVERED' | 'AMBIGUOUS';
  reason: 'EXACT_MESSAGE_PERSISTED' | 'MESSAGE_ABSENT_FROM_PARTIAL_PAGE' | 'MESSAGE_EVIDENCE_MISMATCH';
}

export class SqliteNativeDispatchReconciliationRepository {
  constructor(private readonly db: DatabaseSync) {}
  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_dispatch_reconciliations (
      dispatch_key TEXT NOT NULL REFERENCES native_dispatch_claims(dispatch_key) ON DELETE CASCADE,
      observed_at REAL NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('DELIVERED','AMBIGUOUS')),
      provider_message_id TEXT NOT NULL, transcript_digest TEXT NOT NULL,
      reconciliation_hash TEXT NOT NULL, reconciliation_json TEXT NOT NULL,
      PRIMARY KEY(dispatch_key,observed_at)
    );`);
  }
  latest(dispatchKey: string): NativeDispatchReconciliation | undefined {
    const row = this.db.prepare(`SELECT * FROM native_dispatch_reconciliations
      WHERE dispatch_key=? ORDER BY observed_at DESC LIMIT 1`).get(dispatchKey);
    if (!row) return undefined;
    const result = this.validate(JSON.parse(String(row.reconciliation_json)));
    if (result.dispatchKey !== row.dispatch_key || result.observedAt !== row.observed_at
      || result.verdict !== row.verdict || result.providerMessageId !== row.provider_message_id
      || result.transcriptDigest !== row.transcript_digest || this.hash(result) !== row.reconciliation_hash) {
      throw new Error('Native dispatch reconciliation index mismatch');
    }
    return result;
  }
  reconcile(dispatchKey: string): NativeDispatchReconciliation {
    const intent = new SqliteNativeDispatchIntentRepository(this.db).get(dispatchKey);
    const claim = new SqliteNativeDispatchClaimRepository(this.db).get(dispatchKey);
    if (!intent || !claim) throw new Error('Native claimed dispatch not found');
    const transcript = new SqliteNativeTranscriptRepository(this.db).latest(intent.serverId,intent.sessionId,intent.directory);
    if (!transcript || transcript.observedAt <= claim.claimedAt) throw new Error('Post-claim transcript unavailable');
    if (transcript.serverRevision !== intent.serverRevision || transcript.apiSpecHash !== intent.boundary.apiSpecHash) {
      throw new Error('Post-claim transcript authority mismatch');
    }
    const pre = this.db.prepare(`SELECT payload_hash,page_json FROM native_transcript_observations
      WHERE server_id=? AND session_id=? AND directory=? AND observed_at=?`).get(
        intent.serverId,intent.sessionId,intent.directory,intent.boundary.observedAt);
    if (!pre || pre.payload_hash !== intent.boundary.transcriptDigest
      || this.hash(JSON.parse(String(pre.page_json))) !== pre.payload_hash) throw new Error('Pre-dispatch transcript boundary mismatch');
    const prePage = JSON.parse(String(pre.page_json)) as { messages?: Array<{ id?: string }> };
    const providerMessageId = providerMessageIdFor(dispatchKey);
    if (prePage.messages?.some(message => message.id === providerMessageId)) throw new Error('Provider message ID predates dispatch');
    const transcriptDigest = this.hash(transcript);
    const found = transcript.messages.find(message => message.id === providerMessageId);
    const exact = !!found && found.createdAt >= claim.claimedAt && found.role === 'user' && found.providerId === intent.modelRoute.providerId
      && found.modelId === intent.modelRoute.publishedModelId && found.parts.length === intent.payload.parts.length
      && found.parts.every((part,index) => part.type === 'text' && part.text === intent.payload.parts[index].text);
    const result = this.validate({ dispatchKey, providerMessageId, transcriptDigest, observedAt: transcript.observedAt,
      verdict: exact ? 'DELIVERED' : 'AMBIGUOUS', reason: exact ? 'EXACT_MESSAGE_PERSISTED'
        : found ? 'MESSAGE_EVIDENCE_MISMATCH' : 'MESSAGE_ABSENT_FROM_PARTIAL_PAGE' });
    this.db.exec('SAVEPOINT native_dispatch_reconcile');
    try {
      const previous = this.latest(dispatchKey);
      if (previous?.verdict === 'DELIVERED') {
        this.db.exec('RELEASE native_dispatch_reconcile'); return previous;
      }
      const same = this.db.prepare('SELECT reconciliation_json FROM native_dispatch_reconciliations WHERE dispatch_key=? AND observed_at=?').get(dispatchKey,result.observedAt);
      if (same) {
        const stored = this.validate(JSON.parse(String(same.reconciliation_json)));
        if (JSON.stringify(stored) !== JSON.stringify(result)) throw new Error('Conflicting native dispatch reconciliation');
        this.db.exec('RELEASE native_dispatch_reconcile'); return stored;
      }
      this.db.prepare(`INSERT INTO native_dispatch_reconciliations
        (dispatch_key,observed_at,verdict,provider_message_id,transcript_digest,reconciliation_hash,reconciliation_json)
        VALUES (?,?,?,?,?,?,?)`).run(result.dispatchKey,result.observedAt,result.verdict,result.providerMessageId,
          result.transcriptDigest,this.hash(result),JSON.stringify(result));
      const evidence = JSON.stringify({ id: `native_dispatch_${this.hash(result).slice(0,24)}`, timestamp: result.observedAt,
        source: 'reconciliation_probe', details: { serverId: intent.serverId, sessionId: intent.sessionId,
          providerMessageId, transcriptDigest, verdict: result.verdict } });
      const changed = result.verdict === 'DELIVERED'
        ? this.db.prepare(`UPDATE deliveries SET status='delivered',evidence_json=?,delivered_at=?,failure_reason=NULL,updated_at=?
            WHERE id=? AND status IN ('delivering','ambiguous')`).run(evidence,result.observedAt,result.observedAt,intent.deliveryId)
        : this.db.prepare(`UPDATE deliveries SET status='ambiguous',evidence_json=?,failure_reason=?,updated_at=?
            WHERE id=? AND status IN ('delivering','ambiguous')`).run(evidence,result.reason,result.observedAt,intent.deliveryId);
      if (changed.changes !== 1) throw new Error('Native delivery reconciliation authority changed');
      this.db.exec('RELEASE native_dispatch_reconcile'); return result;
    } catch (error) { this.db.exec('ROLLBACK TO native_dispatch_reconcile'); this.db.exec('RELEASE native_dispatch_reconcile'); throw error; }
  }
  private validate(value: NativeDispatchReconciliation): NativeDispatchReconciliation {
    const verdicts = ['DELIVERED','AMBIGUOUS']; const reasons = ['EXACT_MESSAGE_PERSISTED','MESSAGE_ABSENT_FROM_PARTIAL_PAGE','MESSAGE_EVIDENCE_MISMATCH'];
    if (!value?.dispatchKey?.trim() || !/^msg_relayx_[a-f0-9]{48}$/.test(value.providerMessageId)
      || !/^[a-f0-9]{64}$/.test(value.transcriptDigest) || !Number.isFinite(value.observedAt)
      || !verdicts.includes(value.verdict) || !reasons.includes(value.reason)
      || (value.verdict === 'DELIVERED') !== (value.reason === 'EXACT_MESSAGE_PERSISTED')) throw new Error('Invalid native dispatch reconciliation');
    return { dispatchKey: value.dispatchKey, providerMessageId: value.providerMessageId, transcriptDigest: value.transcriptDigest,
      observedAt: value.observedAt, verdict: value.verdict, reason: value.reason };
  }
  private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
