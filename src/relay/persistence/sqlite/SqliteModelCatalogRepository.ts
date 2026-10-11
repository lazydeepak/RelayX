import type { DatabaseSync } from 'node:sqlite';
import { parseCatalog, type CatalogSnapshot, type CatalogSource } from '../../model-intelligence/catalog';

/** Append-only discovery evidence in RelayX's existing database. No task state,
 * account secrets, eligibility leases or retention policy are stored here. */
export class SqliteModelCatalogRepository {
  constructor(private readonly db: DatabaseSync) {}

  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS model_catalog_snapshots (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('OPENROUTER', 'MODELS_DEV')),
      checked_at REAL NOT NULL,
      snapshot_json TEXT NOT NULL,
      UNIQUE (source, checked_at)
    );`);
  }

  private validate(snapshot: CatalogSnapshot): CatalogSnapshot {
    const parsed = parseCatalog(snapshot.source, snapshot.rawBody, snapshot.fetchedAt, snapshot.etag);
    if (!Number.isFinite(snapshot.checkedAt) || snapshot.checkedAt < snapshot.fetchedAt) throw new Error('Invalid catalog check time');
    // Reconstruct normalized fields from raw evidence. Reject caller edits to
    // provenance, prices, identities or parser version rather than blessing them.
    parsed.checkedAt = snapshot.checkedAt;
    if (JSON.stringify(parsed) !== JSON.stringify(snapshot)) throw new Error('Catalog evidence mismatch');
    return parsed;
  }

  latest(source: CatalogSource): CatalogSnapshot | undefined {
    const row = this.db.prepare('SELECT checked_at, snapshot_json FROM model_catalog_snapshots WHERE source = ? ORDER BY checked_at DESC LIMIT 1').get(source);
    if (!row) return undefined;
    const snapshot = this.validate(JSON.parse(String(row.snapshot_json)));
    if (snapshot.source !== source || snapshot.checkedAt !== Number(row.checked_at)) throw new Error('Catalog index mismatch');
    return snapshot;
  }

  save(snapshot: CatalogSnapshot): void {
    const canonical = this.validate(snapshot);
    this.db.exec('SAVEPOINT model_catalog_save');
    try {
      const previous = this.latest(canonical.source);
      if (previous && canonical.checkedAt < previous.checkedAt) throw new Error('Catalog clock moved backwards');
      if (previous && canonical.checkedAt === previous.checkedAt) {
        if (JSON.stringify(previous) !== JSON.stringify(canonical)) throw new Error('Conflicting catalog observation');
      } else {
        this.db.prepare('INSERT INTO model_catalog_snapshots (source, checked_at, snapshot_json) VALUES (?, ?, ?)')
          .run(canonical.source, canonical.checkedAt, JSON.stringify(canonical));
      }
      this.db.exec('RELEASE model_catalog_save');
    } catch (error) {
      this.db.exec('ROLLBACK TO model_catalog_save');
      this.db.exec('RELEASE model_catalog_save');
      throw error;
    }
  }
}
