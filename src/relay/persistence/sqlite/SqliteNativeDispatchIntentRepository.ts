import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelRoute } from '../../model-intelligence/eligibility';
import { SqliteNativeServerRepository } from './SqliteNativeServerRepository';

export interface NativeDispatchPayload {
  parts: Array<{ type: 'text'; text: string }>;
}
export interface NativeDispatchIntent {
  dispatchKey: string;
  deliveryId: string;
  assignmentId: string;
  attemptId: string;
  serverId: string;
  serverRevision: number;
  sessionId: string;
  directory: string;
  modelRoute: ModelRoute;
  policyVersion: string;
  payload: NativeDispatchPayload;
  payloadDigest: string;
  boundary: {
    observedAt: number;
    apiSpecHash: string;
    transcriptDigest: string;
    questionDigest: string;
    eventCursor?: string;
  };
  state: 'PREPARED_UNAUTHORIZED';
  createdAt: number;
}

/** Transport adjunct to the existing Delivery ledger. Preparation records exact
 * evidence and payload but deliberately grants no permission to send. */
export class SqliteNativeDispatchIntentRepository {
  constructor(private readonly db: DatabaseSync) {}
  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_dispatch_intents (
      dispatch_key TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id) ON DELETE CASCADE,
      assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL, server_revision INTEGER NOT NULL,
      session_id TEXT NOT NULL, directory TEXT NOT NULL,
      payload_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state='PREPARED_UNAUTHORIZED'),
      created_at REAL NOT NULL, intent_hash TEXT NOT NULL, intent_json TEXT NOT NULL,
      FOREIGN KEY(server_id,server_revision) REFERENCES native_server_history(server_id,revision)
    );`);
  }
  get(dispatchKey: string): NativeDispatchIntent | undefined {
    const row = this.db.prepare('SELECT * FROM native_dispatch_intents WHERE dispatch_key=?').get(dispatchKey);
    if (!row) return undefined;
    const intent = this.validate(JSON.parse(String(row.intent_json)));
    if (intent.dispatchKey !== row.dispatch_key || intent.deliveryId !== row.delivery_id
      || intent.assignmentId !== row.assignment_id || intent.attemptId !== row.attempt_id
      || intent.serverId !== row.server_id || intent.serverRevision !== row.server_revision
      || intent.sessionId !== row.session_id || intent.directory !== row.directory
      || intent.payloadDigest !== row.payload_digest || intent.state !== row.state || intent.createdAt !== row.created_at
      || this.hash(intent) !== row.intent_hash) throw new Error('Native dispatch intent index mismatch');
    return intent;
  }
  prepare(input: Omit<NativeDispatchIntent, 'serverRevision' | 'payloadDigest' | 'boundary' | 'state'>): NativeDispatchIntent {
    if (!/^[A-Za-z0-9._:-]+$/.test(input.dispatchKey) || !input.deliveryId.trim() || !input.assignmentId.trim()
      || !input.attemptId.trim() || !input.policyVersion.trim() || !Number.isFinite(input.createdAt) || input.createdAt < 0
      || !/^ses_[A-Za-z0-9_-]+$/.test(input.sessionId) || !input.directory.startsWith('/')) throw new Error('Invalid native dispatch preparation');
    const payload = this.payload(input.payload);
    const payloadDigest = this.hash(payload);
    const route = this.route(input.modelRoute);
    const server = new SqliteNativeServerRepository(this.db).get(input.serverId);
    if (!server || server.lifecycle !== 'INSPECTED' || !server.inspection
      || !server.projectRoots.includes(input.directory)) throw new Error('Native server is not authorized for dispatch preparation');
    const delivery = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(input.deliveryId);
    const attempt = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(input.attemptId);
    const assignment = this.db.prepare('SELECT * FROM assignments WHERE id=?').get(input.assignmentId);
    if (!delivery || !attempt || !assignment || delivery.assignment_id !== input.assignmentId
      || delivery.attempt_id !== input.attemptId || attempt.assignment_id !== input.assignmentId
      || delivery.idempotency_key !== input.dispatchKey || delivery.status !== 'pending'
      || attempt.status !== 'prepared' || attempt.external_session_id !== input.sessionId
      || attempt.session_pair_id !== assignment.pair_id || attempt.worker_session_id !== delivery.target_runtime_id
      || assignment.current_attempt_id !== input.attemptId || assignment.active_delivery_id !== input.deliveryId) throw new Error('Native dispatch authority mismatch');
    const transcript = this.db.prepare(`SELECT observed_at,payload_hash,server_revision FROM native_transcript_observations
      WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`).get(input.serverId, input.sessionId, input.directory);
    const questions = this.db.prepare(`SELECT observed_at,payload_hash,server_revision FROM native_question_observations
      WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`).get(input.serverId, input.sessionId, input.directory);
    const events = this.db.prepare(`SELECT observed_at,last_event_id,server_revision,api_spec_hash FROM native_event_batches
      WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`).get(input.serverId, input.sessionId, input.directory);
    if (!transcript || !questions || !events || transcript.observed_at !== questions.observed_at || transcript.observed_at !== events.observed_at
      || transcript.server_revision !== server.revision || questions.server_revision !== server.revision || events.server_revision !== server.revision
      || events.api_spec_hash !== server.inspection.apiSpecHash || input.createdAt < Number(events.observed_at)) throw new Error('Combined pre-send boundary unavailable');
    const intent: NativeDispatchIntent = this.validate({ dispatchKey: input.dispatchKey, deliveryId: input.deliveryId,
      assignmentId: input.assignmentId, attemptId: input.attemptId, serverId: input.serverId,
      sessionId: input.sessionId, directory: input.directory, modelRoute: route, policyVersion: input.policyVersion,
      payload, createdAt: input.createdAt, serverRevision: server.revision, payloadDigest,
      boundary: { observedAt: Number(events.observed_at),
        apiSpecHash: server.inspection.apiSpecHash, transcriptDigest: String(transcript.payload_hash),
        questionDigest: String(questions.payload_hash), ...(events.last_event_id ? { eventCursor: String(events.last_event_id) } : {}) },
      state: 'PREPARED_UNAUTHORIZED' });
    this.db.exec('SAVEPOINT native_dispatch_prepare');
    try {
      const existing = this.get(intent.dispatchKey);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(intent)) throw new Error('Conflicting native dispatch key');
      } else this.db.prepare(`INSERT INTO native_dispatch_intents
        (dispatch_key,delivery_id,assignment_id,attempt_id,server_id,server_revision,session_id,directory,payload_digest,state,created_at,intent_hash,intent_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(intent.dispatchKey, intent.deliveryId, intent.assignmentId, intent.attemptId,
          intent.serverId, intent.serverRevision, intent.sessionId, intent.directory, intent.payloadDigest, intent.state,
          intent.createdAt, this.hash(intent), JSON.stringify(intent));
      this.db.exec('RELEASE native_dispatch_prepare'); return intent;
    } catch (error) { this.db.exec('ROLLBACK TO native_dispatch_prepare'); this.db.exec('RELEASE native_dispatch_prepare'); throw error; }
  }
  private payload(value: NativeDispatchPayload): NativeDispatchPayload {
    if (!value || !Array.isArray(value.parts) || value.parts.length === 0) throw new Error('Invalid native dispatch payload');
    return { parts: value.parts.map(part => {
      if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text.trim()) throw new Error('Invalid native dispatch payload');
      return { type: 'text' as const, text: part.text };
    }) };
  }
  private route(value: ModelRoute): ModelRoute {
    const keys: Array<keyof ModelRoute> = ['providerId','endpointId','publishedModelId','accountId','runtimeConfigFingerprint'];
    if (!value || !keys.every(key => typeof value[key] === 'string' && value[key].trim())) throw new Error('Invalid native model route');
    return Object.fromEntries(keys.map(key => [key, value[key]])) as unknown as ModelRoute;
  }
  private validate(value: NativeDispatchIntent): NativeDispatchIntent {
    const canonicalPayload = this.payload(value.payload); const canonicalRoute = this.route(value.modelRoute);
    if (!value || !/^[A-Za-z0-9._:-]+$/.test(value.dispatchKey) || !value.deliveryId?.trim()
      || !value.assignmentId?.trim() || !value.attemptId?.trim() || !value.serverId?.trim()
      || !/^ses_[A-Za-z0-9_-]+$/.test(value.sessionId) || !value.directory?.startsWith('/') || !value.policyVersion?.trim()
      || value.state !== 'PREPARED_UNAUTHORIZED' || value.payloadDigest !== this.hash(canonicalPayload)
      || !Number.isSafeInteger(value.serverRevision) || value.serverRevision < 1 || !Number.isFinite(value.createdAt)
      || !value.boundary || !Number.isFinite(value.boundary.observedAt) || !value.boundary.apiSpecHash?.trim()
      || value.createdAt < value.boundary.observedAt || !/^[a-f0-9]{64}$/.test(value.boundary.transcriptDigest)
      || !/^[a-f0-9]{64}$/.test(value.boundary.questionDigest)
      || (value.boundary.eventCursor !== undefined && !value.boundary.eventCursor.trim())) throw new Error('Invalid native dispatch intent');
    return { dispatchKey: value.dispatchKey, deliveryId: value.deliveryId, assignmentId: value.assignmentId,
      attemptId: value.attemptId, serverId: value.serverId, serverRevision: value.serverRevision,
      sessionId: value.sessionId, directory: value.directory, modelRoute: canonicalRoute,
      policyVersion: value.policyVersion, payload: canonicalPayload, payloadDigest: value.payloadDigest,
      boundary: { observedAt: value.boundary.observedAt, apiSpecHash: value.boundary.apiSpecHash,
        transcriptDigest: value.boundary.transcriptDigest, questionDigest: value.boundary.questionDigest,
        ...(value.boundary.eventCursor !== undefined ? { eventCursor: value.boundary.eventCursor } : {}) },
      state: 'PREPARED_UNAUTHORIZED', createdAt: value.createdAt };
  }
  private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
