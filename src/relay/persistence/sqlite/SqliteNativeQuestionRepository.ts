import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NativeQuestionObservation, NativeQuestionStore } from '../../providers/nativeQuestionReconciliation';
import { SqliteNativeServerRepository } from './SqliteNativeServerRepository';

export class SqliteNativeQuestionRepository implements NativeQuestionStore {
  constructor(private readonly db: DatabaseSync) {}
  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_question_observations (
      id INTEGER PRIMARY KEY, server_id TEXT NOT NULL, server_revision INTEGER NOT NULL,
      session_id TEXT NOT NULL, directory TEXT NOT NULL, observed_at REAL NOT NULL,
      payload_hash TEXT NOT NULL, observation_json TEXT NOT NULL,
      FOREIGN KEY (server_id,server_revision) REFERENCES native_server_history(server_id,revision),
      UNIQUE (server_id,session_id,directory,observed_at)
    );`);
  }
  private canonical(input: NativeQuestionObservation): NativeQuestionObservation {
    const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
    const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (input.status !== 'READ' || input.completePendingSet !== true || !text(input.serverId)
      || !Number.isSafeInteger(input.serverRevision) || input.serverRevision < 1 || !text(input.apiSpecHash)
      || !time(input.observedAt) || !/^ses_[A-Za-z0-9_-]+$/.test(input.sessionId)
      || !text(input.directory) || !Array.isArray(input.questions)) throw new Error('Invalid question observation');
    const requestIds = new Set<string>(); const correlations = new Set<string>();
    const questions = input.questions.map(request => {
      if (!text(request.requestId) || requestIds.has(request.requestId) || request.sessionId !== input.sessionId
        || !text(request.messageId) || !text(request.callId) || !Array.isArray(request.questions) || request.questions.length === 0) throw new Error('Invalid pending question');
      requestIds.add(request.requestId);
      const correlation = `${request.messageId}\u0000${request.callId}`;
      if (correlations.has(correlation)) throw new Error('Duplicate question correlation');
      correlations.add(correlation);
      return { requestId: request.requestId, sessionId: request.sessionId, messageId: request.messageId, callId: request.callId,
        questions: request.questions.map(question => {
          if (!text(question.question) || !text(question.header) || typeof question.multiple !== 'boolean'
            || typeof question.custom !== 'boolean' || !Array.isArray(question.options) || question.options.length === 0) throw new Error('Invalid question content');
          const labels = new Set<string>();
          return { question: question.question, header: question.header, multiple: question.multiple, custom: question.custom,
            options: question.options.map(option => {
              if (!text(option.label) || !text(option.description) || labels.has(option.label)) throw new Error('Invalid question option');
              labels.add(option.label); return { label: option.label, description: option.description };
            }) };
        }) };
    });
    return { status: 'READ', serverId: input.serverId, serverRevision: input.serverRevision, apiSpecHash: input.apiSpecHash,
      observedAt: input.observedAt, sessionId: input.sessionId, directory: input.directory, questions, completePendingSet: true };
  }
  latest(serverId: string, sessionId: string, directory: string): NativeQuestionObservation | undefined {
    const row = this.db.prepare('SELECT * FROM native_question_observations WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1').get(serverId, sessionId, directory);
    if (!row) return undefined;
    const observation = this.canonical(JSON.parse(String(row.observation_json)));
    if (observation.serverId !== serverId || observation.sessionId !== sessionId || observation.directory !== directory
      || observation.serverRevision !== row.server_revision || observation.observedAt !== row.observed_at
      || this.hash(observation) !== row.payload_hash) throw new Error('Question evidence mismatch');
    return observation;
  }
  save(input: NativeQuestionObservation): void {
    const observation = this.canonical(input);
    this.db.exec('SAVEPOINT native_question_save');
    try {
      const server = new SqliteNativeServerRepository(this.db).get(observation.serverId);
      if (!server || server.lifecycle !== 'INSPECTED' || server.revision !== observation.serverRevision
        || server.inspection?.apiSpecHash !== observation.apiSpecHash || server.inspection.compatibility?.questionRead !== true
        || !server.projectRoots.includes(observation.directory) || observation.observedAt < server.updatedAt) throw new Error('Question server evidence superseded');
      const previous = this.latest(observation.serverId, observation.sessionId, observation.directory);
      const hash = this.hash(observation);
      if (previous && observation.observedAt < previous.observedAt) throw new Error('Question clock moved backwards');
      if (previous && observation.observedAt === previous.observedAt) {
        if (this.hash(previous) !== hash) throw new Error('Conflicting question observation');
      } else this.db.prepare('INSERT INTO native_question_observations (server_id,server_revision,session_id,directory,observed_at,payload_hash,observation_json) VALUES (?,?,?,?,?,?,?)')
        .run(observation.serverId, observation.serverRevision, observation.sessionId, observation.directory,
          observation.observedAt, hash, JSON.stringify(observation));
      this.db.exec('RELEASE native_question_save');
    } catch (error) { this.db.exec('ROLLBACK TO native_question_save'); this.db.exec('RELEASE native_question_save'); throw error; }
  }
  private hash(value: NativeQuestionObservation): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
