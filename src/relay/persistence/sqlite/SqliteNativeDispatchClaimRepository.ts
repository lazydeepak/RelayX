import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteNativeDispatchAuthorizationRepository } from './SqliteNativeDispatchAuthorizationRepository';

export interface NativeDispatchClaim {
  dispatchKey: string;
  authorizationDigest: string;
  claimedAt: number;
  state: 'SEND_CLAIMED_RECONCILIATION_REQUIRED';
}

export interface NativeDispatchClaimEvidence {
  now: number;
  accountPolicyHash: string;
  taskQuotaEvidenceHash: string;
  privacyEvidenceHash: string;
  runtimeEvidenceHash: string;
}

/**
 * The one-way durability boundary immediately before transport. Once acquired,
 * callers must never acquire or send this dispatch key again; restart recovery
 * must reconcile the exact session instead.
 */
export class SqliteNativeDispatchClaimRepository {
  constructor(private readonly db: DatabaseSync) {}

  static initSchema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS native_dispatch_claims (
      dispatch_key TEXT PRIMARY KEY REFERENCES native_dispatch_authorizations(dispatch_key) ON DELETE CASCADE,
      authorization_digest TEXT NOT NULL,
      claimed_at REAL NOT NULL,
      state TEXT NOT NULL CHECK(state='SEND_CLAIMED_RECONCILIATION_REQUIRED'),
      claim_hash TEXT NOT NULL,
      claim_json TEXT NOT NULL
    );`);
  }

  get(dispatchKey: string): NativeDispatchClaim | undefined {
    const row = this.db.prepare('SELECT * FROM native_dispatch_claims WHERE dispatch_key=?').get(dispatchKey);
    if (!row) return undefined;
    const claim = this.validate(JSON.parse(String(row.claim_json)));
    if (claim.dispatchKey !== row.dispatch_key || claim.authorizationDigest !== row.authorization_digest
      || claim.claimedAt !== row.claimed_at || claim.state !== row.state
      || this.hash(claim) !== row.claim_hash) throw new Error('Native dispatch claim index mismatch');
    return claim;
  }

  claim(dispatchKey: string, evidence: NativeDispatchClaimEvidence): { acquired: boolean; claim: NativeDispatchClaim } {
    const existing = this.get(dispatchKey);
    if (existing) return { acquired: false, claim: existing };
    this.db.exec('SAVEPOINT native_dispatch_claim');
    try {
      const raced = this.get(dispatchKey);
      if (raced) {
        this.db.exec('RELEASE native_dispatch_claim');
        return { acquired: false, claim: raced };
      }
      const authorizations = new SqliteNativeDispatchAuthorizationRepository(this.db);
      const authorization = authorizations.get(dispatchKey);
      if (!authorization) throw new Error('Native dispatch authorization not found');
      const usable = authorizations.checkUsable(dispatchKey, evidence);
      if (!usable.usable) throw new Error(`Native dispatch authorization unusable: ${usable.reasons.join(',')}`);
      const intent = this.db.prepare('SELECT delivery_id,assignment_id,attempt_id FROM native_dispatch_intents WHERE dispatch_key=?').get(dispatchKey);
      if (!intent) throw new Error('Native dispatch intent not found');
      const claim = this.validate({ dispatchKey, authorizationDigest: this.hash(authorization), claimedAt: evidence.now,
        state: 'SEND_CLAIMED_RECONCILIATION_REQUIRED' });
      const changed = this.db.prepare(`UPDATE deliveries SET status='delivering',updated_at=?
        WHERE id=? AND assignment_id=? AND attempt_id=? AND status='pending' AND idempotency_key=?
        AND EXISTS (SELECT 1 FROM assignments WHERE id=? AND current_attempt_id=? AND active_delivery_id=?)
        AND EXISTS (SELECT 1 FROM attempts WHERE id=? AND status='prepared')`).run(
        evidence.now, intent.delivery_id, intent.assignment_id, intent.attempt_id, dispatchKey,
        intent.assignment_id, intent.attempt_id, intent.delivery_id, intent.attempt_id);
      if (changed.changes !== 1) throw new Error('Native dispatch relay authority changed');
      this.db.prepare(`INSERT INTO native_dispatch_claims
        (dispatch_key,authorization_digest,claimed_at,state,claim_hash,claim_json) VALUES (?,?,?,?,?,?)`).run(
        claim.dispatchKey, claim.authorizationDigest, claim.claimedAt, claim.state, this.hash(claim), JSON.stringify(claim));
      this.db.exec('RELEASE native_dispatch_claim'); return { acquired: true, claim };
    } catch (error) {
      this.db.exec('ROLLBACK TO native_dispatch_claim'); this.db.exec('RELEASE native_dispatch_claim'); throw error;
    }
  }

  private validate(value: NativeDispatchClaim): NativeDispatchClaim {
    if (!value?.dispatchKey?.trim() || !/^[a-f0-9]{64}$/.test(value.authorizationDigest)
      || !Number.isFinite(value.claimedAt) || value.state !== 'SEND_CLAIMED_RECONCILIATION_REQUIRED') {
      throw new Error('Invalid native dispatch claim');
    }
    return { dispatchKey: value.dispatchKey, authorizationDigest: value.authorizationDigest,
      claimedAt: value.claimedAt, state: 'SEND_CLAIMED_RECONCILIATION_REQUIRED' };
  }

  private hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
}
