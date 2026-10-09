import type { DatabaseSync } from 'node:sqlite';
import { normalizeNativeEndpoint, type NativeDiscovery } from '../../providers/nativeOpenCodeDiscovery';
import type { NativeServerRecord, NativeServerStore } from '../../providers/nativeServerLifecycle';

export class SqliteNativeServerRepository implements NativeServerStore {
  constructor(private readonly db: DatabaseSync) {}
  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_servers (
      server_id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, revision INTEGER NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('REGISTERED','INSPECTED','BLOCKED','REVOKED')),
      record_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS native_server_active_endpoint ON native_servers(endpoint) WHERE lifecycle != 'REVOKED';
    CREATE TABLE IF NOT EXISTS native_server_history (
      server_id TEXT NOT NULL REFERENCES native_servers(server_id), revision INTEGER NOT NULL,
      record_json TEXT NOT NULL, PRIMARY KEY (server_id,revision)
    );`);
  }
  get(serverId: string): NativeServerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM native_servers WHERE server_id = ?').get(serverId);
    if (!row) return undefined;
    const record = JSON.parse(String(row.record_json)) as NativeServerRecord;
    if (record.serverId !== row.server_id || record.endpoint !== row.endpoint || record.revision !== row.revision || record.lifecycle !== row.lifecycle) throw new Error('Native server index mismatch');
    return record;
  }
  register(input: {
    serverId: string; endpoint: string; ownership: 'MANAGED' | 'ADOPTED'; authKeyRef: string;
    projectRoots: string[]; registeredBy: string; ownershipEvidenceRef: string; now: number;
  }): NativeServerRecord {
    for (const value of [input.serverId, input.authKeyRef, input.registeredBy, input.ownershipEvidenceRef]) {
      if (typeof value !== 'string' || !value.trim()) throw new Error('Missing server ownership evidence');
    }
    if (!['MANAGED', 'ADOPTED'].includes(input.ownership) || !Number.isFinite(input.now) || input.now < 0
      || !Array.isArray(input.projectRoots) || !input.projectRoots.every(root => typeof root === 'string' && root.startsWith('/'))) throw new Error('Invalid native server registration');
    const record: NativeServerRecord = {
      serverId: input.serverId, endpoint: normalizeNativeEndpoint(input.endpoint), ownership: input.ownership,
      authKeyRef: input.authKeyRef, projectRoots: [...new Set(input.projectRoots)],
      registeredBy: input.registeredBy, ownershipEvidenceRef: input.ownershipEvidenceRef,
      revision: 1, lifecycle: 'REGISTERED', createdAt: input.now, updatedAt: input.now,
    };
    if (record.ownership === 'MANAGED' && !['127.0.0.1', '[::1]'].includes(new URL(record.endpoint).hostname)) throw new Error('Managed native servers must use loopback');
    this.atomic(() => {
      this.db.prepare('INSERT INTO native_servers (server_id,endpoint,revision,lifecycle,record_json) VALUES (?,?,?,?,?)')
        .run(record.serverId, record.endpoint, record.revision, record.lifecycle, JSON.stringify(record));
      this.history(record);
    });
    return record;
  }
  revoke(serverId: string, expectedRevision: number, now: number): boolean {
    return this.update(serverId, expectedRevision, now, record => ({ ...record, lifecycle: 'REVOKED', inspection: undefined, blocker: 'OWNERSHIP_REVOKED' }));
  }
  applyDiscovery(serverId: string, expectedRevision: number, observedAt: number, result: NativeDiscovery): boolean {
    return this.update(serverId, expectedRevision, observedAt, record => {
      if (result.status === 'BLOCKED') return { ...record, lifecycle: 'BLOCKED', inspection: undefined, blocker: result.reason };
      if (result.server.serverId !== record.serverId || normalizeNativeEndpoint(result.server.endpoint) !== record.endpoint
        || result.server.ownership !== record.ownership || result.observedAt !== observedAt || result.dispatchAuthorized !== false) throw new Error('Native discovery identity mismatch');
      return { ...record, lifecycle: 'INSPECTED', lastHealthyAt: observedAt, blocker: undefined,
        inspection: { observedAt, apiSpecHash: result.apiSpecHash, apiVersion: result.apiVersion,
          serverVersion: result.serverVersion, declaredOperations: result.declaredOperations, compatibility: result.compatibility } };
    });
  }
  private update(serverId: string, revision: number, now: number, transform: (record: NativeServerRecord) => NativeServerRecord): boolean {
    let applied = false;
    this.atomic(() => {
      const previous = this.get(serverId);
      if (!previous || previous.revision !== revision || previous.lifecycle === 'REVOKED') return;
      if (!Number.isFinite(now) || now < previous.updatedAt) throw new Error('Invalid native lifecycle time');
      const next = { ...transform(previous), revision: revision + 1, updatedAt: now };
      const result = this.db.prepare('UPDATE native_servers SET revision=?,lifecycle=?,record_json=? WHERE server_id=? AND revision=?')
        .run(next.revision, next.lifecycle, JSON.stringify(next), serverId, revision);
      applied = result.changes === 1;
      if (applied) this.history(next);
    });
    return applied;
  }
  private history(record: NativeServerRecord): void {
    this.db.prepare('INSERT INTO native_server_history (server_id,revision,record_json) VALUES (?,?,?)')
      .run(record.serverId, record.revision, JSON.stringify(record));
  }
  private atomic(work: () => void): void {
    this.db.exec('SAVEPOINT native_server_write');
    try { work(); this.db.exec('RELEASE native_server_write'); }
    catch (error) { this.db.exec('ROLLBACK TO native_server_write'); this.db.exec('RELEASE native_server_write'); throw error; }
  }
}
