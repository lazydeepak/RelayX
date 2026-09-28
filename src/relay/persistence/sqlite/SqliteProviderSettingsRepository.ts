/**
 * Explicit operator/provider settings — additive, append-in-place, never guessed.
 *
 * ## The rule this repository exists to enforce
 *
 * A setting is either SET BY AN OPERATOR, or it is not set. There is no default. Reading an
 * unset key returns `null`, and every caller must decide what an absent setting means and
 * say so — because the whole point of the store is to make "RelayX chose this model" and
 * "an operator chose this model" distinguishable in the evidence trail.
 *
 * That is why there is deliberately no `getWithDefault`. A default would silently turn an
 * operator decision into a product decision, which is how a machine-wide provider change
 * ends up happening without anyone approving it.
 *
 * Writes record WHO set the value (`setBy`) and WHEN, so a later reader can tell an operator
 * correction apart from a value that was present from the start.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { IProviderSettingsRepository, ProviderSetting } from '../interfaces.ts';

export class SqliteProviderSettingsRepository implements IProviderSettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  async get(key: string): Promise<ProviderSetting | null> {
    const row = this.db
      .prepare('SELECT * FROM provider_settings WHERE key = ?')
      .get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      key: String(row.key),
      value: String(row.value),
      note: row.note === null || row.note === undefined ? null : String(row.note),
      setBy: String(row.set_by),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async list(): Promise<ProviderSetting[]> {
    const rows = this.db
      .prepare('SELECT * FROM provider_settings ORDER BY key ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      key: String(row.key),
      value: String(row.value),
      note: row.note === null || row.note === undefined ? null : String(row.note),
      setBy: String(row.set_by),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM provider_settings WHERE key = ?').run(key);
  }

  async save(setting: ProviderSetting): Promise<void> {
    // `created_at` is preserved across updates so the record shows when the setting was
    // FIRST established, while `updated_at` shows the latest correction. Both matter: a
    // setting changed twice has a different provenance story from one set once.
    this.db
      .prepare(
        `INSERT INTO provider_settings (key, value, note, set_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value      = excluded.value,
           note       = excluded.note,
           set_by     = excluded.set_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        setting.key,
        setting.value,
        setting.note,
        setting.setBy,
        setting.createdAt,
        setting.updatedAt,
      );
  }
}
