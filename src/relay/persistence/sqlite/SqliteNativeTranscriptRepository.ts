import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NativeTranscriptPage, NativeTranscriptStore } from '../../providers/nativeTranscriptReconciliation';
import { SqliteNativeServerRepository } from './SqliteNativeServerRepository';

/** Append-only page observations; no Assignment/Attempt/Delivery state. */
export class SqliteNativeTranscriptRepository implements NativeTranscriptStore {
  constructor(private readonly db: DatabaseSync) {}
  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_transcript_observations (
      id INTEGER PRIMARY KEY, server_id TEXT NOT NULL, server_revision INTEGER NOT NULL,
      session_id TEXT NOT NULL, directory TEXT NOT NULL, observed_at REAL NOT NULL,
      payload_hash TEXT NOT NULL, page_json TEXT NOT NULL,
      FOREIGN KEY (server_id,server_revision) REFERENCES native_server_history(server_id,revision),
      UNIQUE (server_id,session_id,directory,observed_at)
    );`);
  }
  private canonical(page: NativeTranscriptPage): NativeTranscriptPage {
    const validTime = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const validText = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
    if (page.status !== 'READ' || page.completeHistory !== false || !validText(page.serverId)
      || !Number.isSafeInteger(page.serverRevision) || page.serverRevision < 1 || !validText(page.apiSpecHash)
      || !validTime(page.observedAt) || !/^ses_[A-Za-z0-9_-]+$/.test(page.session?.id)
      || !validText(page.session.directory) || !Array.isArray(page.messages)) throw new Error('Invalid transcript observation');
    const messages = new Set<string>(); const parts = new Set<string>();
    const normalized: NativeTranscriptPage = {
      status: 'READ', serverId: page.serverId, serverRevision: page.serverRevision, apiSpecHash: page.apiSpecHash,
      observedAt: page.observedAt, session: { id: page.session.id, directory: page.session.directory,
        ...(validText(page.session.title) ? { title: page.session.title } : {}) },
      messages: page.messages.map(message => {
        if (!validText(message.id) || messages.has(message.id) || message.sessionId !== page.session.id
          || !['user','assistant'].includes(message.role) || !validTime(message.createdAt)
          || !validText(message.providerId) || !validText(message.modelId) || !Array.isArray(message.parts)
          || (message.role === 'assistant' && (!validText(message.parentId) || message.parentId === message.id))
          || (message.completedAt !== undefined && (message.role !== 'assistant' || !validTime(message.completedAt) || message.completedAt < message.createdAt))) throw new Error('Invalid transcript message');
        messages.add(message.id);
        return { id: message.id, sessionId: message.sessionId, role: message.role, createdAt: message.createdAt,
          ...(message.completedAt !== undefined ? { completedAt: message.completedAt } : {}),
          ...(message.role === 'assistant' ? { parentId: message.parentId } : {}),
          providerId: message.providerId, modelId: message.modelId, parts: message.parts.map(part => {
            if (!validText(part.id) || parts.has(part.id) || !validText(part.type)
              || (['text','reasoning'].includes(part.type) && typeof part.text !== 'string')) throw new Error('Invalid transcript part');
            parts.add(part.id);
            return { id: part.id, type: part.type, ...(['text','reasoning'].includes(part.type) ? { text: part.text } : {}) };
          }) };
      }), completeHistory: false,
    };
    return normalized;
  }
  latest(serverId: string, sessionId: string, directory: string): NativeTranscriptPage | undefined {
    const row = this.db.prepare('SELECT * FROM native_transcript_observations WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1').get(serverId, sessionId, directory);
    if (!row) return undefined;
    const page = this.canonical(JSON.parse(String(row.page_json)));
    if (page.serverId !== serverId || page.session.id !== sessionId || page.session.directory !== directory
      || page.serverRevision !== row.server_revision || page.observedAt !== row.observed_at
      || this.hash(page) !== row.payload_hash) throw new Error('Transcript evidence mismatch');
    return page;
  }
  save(input: NativeTranscriptPage): void {
    const page = this.canonical(input);
    this.db.exec('SAVEPOINT native_transcript_save');
    try {
      const server = new SqliteNativeServerRepository(this.db).get(page.serverId);
      if (!server || server.lifecycle !== 'INSPECTED' || server.revision !== page.serverRevision
        || server.inspection?.apiSpecHash !== page.apiSpecHash || !server.projectRoots.includes(page.session.directory)
        || server.inspection.compatibility?.sessionRead !== true || server.inspection.compatibility?.messageRead !== true
        || page.observedAt < server.updatedAt) throw new Error('Transcript server evidence superseded');
      const previous = this.latest(page.serverId, page.session.id, page.session.directory);
      const hash = this.hash(page);
      if (previous && page.observedAt < previous.observedAt) throw new Error('Transcript clock moved backwards');
      if (previous && page.observedAt === previous.observedAt) {
        if (this.hash(previous) !== hash) throw new Error('Conflicting transcript observation');
      } else this.db.prepare('INSERT INTO native_transcript_observations (server_id,server_revision,session_id,directory,observed_at,payload_hash,page_json) VALUES (?,?,?,?,?,?,?)')
        .run(page.serverId, page.serverRevision, page.session.id, page.session.directory, page.observedAt, hash, JSON.stringify(page));
      this.db.exec('RELEASE native_transcript_save');
    } catch (error) { this.db.exec('ROLLBACK TO native_transcript_save'); this.db.exec('RELEASE native_transcript_save'); throw error; }
  }
  private hash(page: NativeTranscriptPage): string { return createHash('sha256').update(JSON.stringify(page)).digest('hex'); }
}
