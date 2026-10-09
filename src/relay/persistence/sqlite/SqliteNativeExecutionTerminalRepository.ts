import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteNativeDispatchIntentRepository } from './SqliteNativeDispatchIntentRepository';
import { SqliteNativeExecutionObservationRepository } from './SqliteNativeExecutionObservationRepository';
import { SqliteNativeTranscriptRepository } from './SqliteNativeTranscriptRepository';

export interface NativeExecutionTerminal {
  dispatchKey: string;
  assistantMessageId: string;
  transcriptDigest: string;
  observedAt: number;
  completedAt: number;
  outcome: 'COMPLETED_PHYSICAL' | 'INTERRUPTED';
  terminalCode: string;
}

export class SqliteNativeExecutionTerminalRepository {
  constructor(private readonly db: DatabaseSync) {}
  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_execution_terminals (
      dispatch_key TEXT PRIMARY KEY REFERENCES native_execution_observations(dispatch_key) ON DELETE CASCADE,
      outcome TEXT NOT NULL CHECK(outcome IN ('COMPLETED_PHYSICAL','INTERRUPTED')),
      assistant_message_id TEXT NOT NULL, observed_at REAL NOT NULL, completed_at REAL NOT NULL,
      transcript_digest TEXT NOT NULL, terminal_hash TEXT NOT NULL, terminal_json TEXT NOT NULL
    );`);
  }
  get(dispatchKey: string): NativeExecutionTerminal | undefined {
    const row = this.db.prepare('SELECT * FROM native_execution_terminals WHERE dispatch_key=?').get(dispatchKey);
    if (!row) return undefined;
    const result = this.validate(JSON.parse(String(row.terminal_json)));
    if (result.dispatchKey !== row.dispatch_key || result.outcome !== row.outcome
      || result.assistantMessageId !== row.assistant_message_id || result.observedAt !== row.observed_at
      || result.completedAt !== row.completed_at || result.transcriptDigest !== row.transcript_digest
      || this.hash(result) !== row.terminal_hash) throw new Error('Native execution terminal index mismatch');
    return result;
  }
  observe(dispatchKey: string): { terminal: boolean; observation?: NativeExecutionTerminal } {
    const existing = this.get(dispatchKey);
    if (existing) return { terminal: true, observation: existing };
    const intent = new SqliteNativeDispatchIntentRepository(this.db).get(dispatchKey);
    const started = new SqliteNativeExecutionObservationRepository(this.db).get(dispatchKey);
    if (!intent || !started) throw new Error('Native execution-start evidence unavailable');
    const history = this.db.prepare('SELECT record_json FROM native_server_history WHERE server_id=? AND revision=?').get(intent.serverId,intent.serverRevision);
    const server = history ? JSON.parse(String(history.record_json)) as { inspection?: { compatibility?: { executionTerminalRead?: boolean } } } : undefined;
    if (server?.inspection?.compatibility?.executionTerminalRead !== true) throw new Error('Native terminal contract unsupported');
    const transcript = new SqliteNativeTranscriptRepository(this.db).latest(intent.serverId,intent.sessionId,intent.directory);
    if (!transcript || transcript.observedAt < started.observedAt
      || transcript.serverRevision !== intent.serverRevision || transcript.apiSpecHash !== intent.boundary.apiSpecHash) {
      throw new Error('Native terminal transcript unavailable');
    }
    const assistant = transcript.messages.find(message => message.id === started.assistantMessageId);
    if (!assistant) return { terminal: false };
    if (assistant.role !== 'assistant' || assistant.parentId !== started.userMessageId
      || assistant.providerId !== intent.modelRoute.providerId || assistant.modelId !== intent.modelRoute.publishedModelId) {
      throw new Error('Native terminal assistant authority mismatch');
    }
    if (assistant.completedAt === undefined) return { terminal: false };
    const outcome = assistant.errorType ? 'INTERRUPTED' : assistant.finish ? 'COMPLETED_PHYSICAL' : undefined;
    if (!outcome) return { terminal: false };
    const result = this.validate({ dispatchKey, assistantMessageId: assistant.id,
      transcriptDigest: this.hash(transcript), observedAt: transcript.observedAt, completedAt: assistant.completedAt,
      outcome, terminalCode: assistant.errorType ?? assistant.finish! });
    this.db.exec('SAVEPOINT native_execution_terminal');
    try {
      const raced = this.get(dispatchKey);
      if (raced) { this.db.exec('RELEASE native_execution_terminal'); return { terminal: true, observation: raced }; }
      const evidence = JSON.stringify({ id: `native_terminal_${this.hash(result).slice(0,24)}`, timestamp: result.observedAt,
        source: 'reconciliation_probe', details: { executionState: outcome === 'COMPLETED_PHYSICAL' ? 'completed' : 'terminal_error',
          assistantMessageId: assistant.id, terminalCode: result.terminalCode, transcriptDigest: result.transcriptDigest } });
      const changed = this.db.prepare(`UPDATE attempts SET status=?,finished_at=?,failure_reason=?,evidence_json=?
        WHERE id=? AND assignment_id=? AND status='running' AND external_session_id=?`).run(
          outcome === 'COMPLETED_PHYSICAL' ? 'completed_physical' : 'interrupted', result.completedAt,
          outcome === 'INTERRUPTED' ? `Provider execution error: ${result.terminalCode}` : null, evidence,
          intent.attemptId,intent.assignmentId,intent.sessionId);
      if (changed.changes !== 1) throw new Error('Native terminal Attempt authority changed');
      this.db.prepare(`INSERT INTO native_execution_terminals
        (dispatch_key,outcome,assistant_message_id,observed_at,completed_at,transcript_digest,terminal_hash,terminal_json)
        VALUES (?,?,?,?,?,?,?,?)`).run(result.dispatchKey,result.outcome,result.assistantMessageId,result.observedAt,
          result.completedAt,result.transcriptDigest,this.hash(result),JSON.stringify(result));
      this.db.exec('RELEASE native_execution_terminal'); return { terminal: true, observation: result };
    } catch (error) { this.db.exec('ROLLBACK TO native_execution_terminal'); this.db.exec('RELEASE native_execution_terminal'); throw error; }
  }
  private validate(value: NativeExecutionTerminal): NativeExecutionTerminal {
    if (!value?.dispatchKey?.trim() || !value.assistantMessageId?.trim() || !/^[a-f0-9]{64}$/.test(value.transcriptDigest)
      || !Number.isFinite(value.observedAt) || !Number.isFinite(value.completedAt) || value.completedAt > value.observedAt
      || !['COMPLETED_PHYSICAL','INTERRUPTED'].includes(value.outcome)
      || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value.terminalCode)) {
      throw new Error('Invalid native execution terminal');
    }
    return { dispatchKey:value.dispatchKey,assistantMessageId:value.assistantMessageId,transcriptDigest:value.transcriptDigest,
      observedAt:value.observedAt,completedAt:value.completedAt,outcome:value.outcome,terminalCode:value.terminalCode };
  }
  private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
