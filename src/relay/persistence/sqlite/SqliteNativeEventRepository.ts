import type { DatabaseSync } from 'node:sqlite';
import type { NativeEventRead } from '../../providers/nativeEventObserver';
import { SqliteNativeServerRepository } from './SqliteNativeServerRepository';

export type NativeEventBatch = Extract<NativeEventRead, { status: 'READ' }>;
export class SqliteNativeEventRepository {
  constructor(private readonly db: DatabaseSync) {}
  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_event_batches (
      id INTEGER PRIMARY KEY, server_id TEXT NOT NULL, server_revision INTEGER NOT NULL,
      session_id TEXT NOT NULL, directory TEXT NOT NULL, observed_at REAL NOT NULL,
      api_spec_hash TEXT NOT NULL,
      prior_event_id TEXT, last_event_id TEXT, continuity TEXT NOT NULL,
      connection_ended INTEGER NOT NULL, stream_boundary TEXT NOT NULL,
      requires_reconciliation INTEGER NOT NULL,
      FOREIGN KEY (server_id,server_revision) REFERENCES native_server_history(server_id,revision),
      UNIQUE(server_id,session_id,directory,observed_at)
    );
    CREATE TABLE IF NOT EXISTS native_event_observations (
      server_id TEXT NOT NULL, session_id TEXT NOT NULL, provider_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL, message_id TEXT, part_id TEXT, data_hash TEXT NOT NULL,
      first_observed_at REAL NOT NULL, PRIMARY KEY(server_id,session_id,provider_event_id)
    );`);
  }
  latestCursor(serverId: string, sessionId: string, directory: string): string | undefined {
    const row = this.db.prepare(`SELECT last_event_id FROM native_event_batches
      WHERE server_id=? AND session_id=? AND directory=? AND last_event_id IS NOT NULL
      ORDER BY observed_at DESC LIMIT 1`).get(serverId, sessionId, directory);
    return row ? String(row.last_event_id) : undefined;
  }
  save(batch: NativeEventBatch): { inserted: string[]; duplicates: string[] } {
    if (batch.status !== 'READ' || !Number.isSafeInteger(batch.serverRevision) || batch.serverRevision < 1
      || !Number.isFinite(batch.observedAt) || batch.observedAt < 0 || !/^ses_[A-Za-z0-9_-]+$/.test(batch.sessionId)
      || !batch.serverId.trim() || !batch.directory.trim() || !batch.apiSpecHash.trim() || !Array.isArray(batch.events)
      || !['INITIAL','UNVERIFIED_RECONNECT'].includes(batch.continuity)
      || batch.requiresAuthoritativeReconciliation !== true
      || !['EOF','EVENT_LIMIT'].includes(batch.streamBoundary)
      || (batch.streamBoundary === 'EOF') !== batch.connectionEnded
      || (batch.continuity === 'INITIAL') !== (batch.priorEventId === undefined)
      || batch.lastEventId !== (batch.events.length ? batch.events[batch.events.length - 1].providerEventId : undefined)) throw new Error('Invalid native event batch');
    const ids = new Set<string>();
    for (let index = 0; index < batch.events.length; index++) {
      const event = batch.events[index];
      if (!event.providerEventId?.trim() || !event.eventType?.trim() || event.sessionId !== batch.sessionId
        || !/^[a-f0-9]{64}$/.test(event.dataHash) || event.observedOrder !== index || ids.has(event.providerEventId)) throw new Error('Invalid native event observation');
      ids.add(event.providerEventId);
    }
    const inserted: string[] = []; const duplicates: string[] = [];
    this.db.exec('SAVEPOINT native_event_save');
    try {
      const server = new SqliteNativeServerRepository(this.db).get(batch.serverId);
      if (!server || server.lifecycle !== 'INSPECTED' || server.revision !== batch.serverRevision
        || server.inspection?.apiSpecHash !== batch.apiSpecHash || server.inspection.compatibility?.eventStream !== true
        || !server.projectRoots.includes(batch.directory) || batch.observedAt < server.updatedAt) throw new Error('Event server evidence superseded');
      const previous = this.db.prepare(`SELECT * FROM native_event_batches WHERE server_id=? AND session_id=? AND directory=? ORDER BY observed_at DESC LIMIT 1`)
        .get(batch.serverId, batch.sessionId, batch.directory);
      if (previous && batch.observedAt < Number(previous.observed_at)) throw new Error('Event clock moved backwards');
      if (previous && batch.observedAt === Number(previous.observed_at)) throw new Error('Duplicate event batch time');
      for (const event of batch.events) {
        const prior = this.db.prepare('SELECT data_hash,event_type,message_id,part_id FROM native_event_observations WHERE server_id=? AND session_id=? AND provider_event_id=?')
          .get(batch.serverId, batch.sessionId, event.providerEventId);
        if (prior) {
          if (prior.data_hash !== event.dataHash || prior.event_type !== event.eventType
            || (prior.message_id ?? undefined) !== event.messageId || (prior.part_id ?? undefined) !== event.partId) throw new Error('Conflicting provider event ID');
          duplicates.push(event.providerEventId);
        } else {
          this.db.prepare(`INSERT INTO native_event_observations
            (server_id,session_id,provider_event_id,event_type,message_id,part_id,data_hash,first_observed_at)
            VALUES (?,?,?,?,?,?,?,?)`).run(batch.serverId, batch.sessionId, event.providerEventId, event.eventType,
              event.messageId ?? null, event.partId ?? null, event.dataHash, batch.observedAt);
          inserted.push(event.providerEventId);
        }
      }
      this.db.prepare(`INSERT INTO native_event_batches
        (server_id,server_revision,session_id,directory,observed_at,api_spec_hash,prior_event_id,last_event_id,continuity,connection_ended,stream_boundary,requires_reconciliation)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(batch.serverId, batch.serverRevision, batch.sessionId, batch.directory,
          batch.observedAt, batch.apiSpecHash, batch.priorEventId ?? null, batch.lastEventId ?? null, batch.continuity,
          batch.connectionEnded ? 1 : 0, batch.streamBoundary, batch.requiresAuthoritativeReconciliation ? 1 : 0);
      this.db.exec('RELEASE native_event_save');
      return { inserted, duplicates };
    } catch (error) { this.db.exec('ROLLBACK TO native_event_save'); this.db.exec('RELEASE native_event_save'); throw error; }
  }
}
