import { DatabaseSync } from 'node:sqlite';
import { RelayIngress } from '../../../domain/relayIngress.ts';
import { IRelayIngressRepository } from '../interfaces.ts';

export class SqliteRelayIngressRepository implements IRelayIngressRepository {
  constructor(private db: DatabaseSync) {}

  findById(id: string): Promise<RelayIngress | null> {
    const row = this.db.prepare('SELECT * FROM relay_ingress WHERE ingress_id = ?').get(id) as any;
    return Promise.resolve(row ? this.toEntity(row) : null);
  }

  findByUniqueKey(stablePairId: string, sourceSide: string, externalSessionId: string, providerTurnIdentity: string): Promise<RelayIngress | null> {
    const row = this.db.prepare('SELECT * FROM relay_ingress WHERE stable_pair_id = ? AND source_side = ? AND external_session_id = ? AND provider_turn_identity = ?').get(stablePairId, sourceSide, externalSessionId, providerTurnIdentity) as any;
    return Promise.resolve(row ? this.toEntity(row) : null);
  }

  findActiveForPair(pairId: string): Promise<RelayIngress | null> {
    const row = this.db.prepare("SELECT * FROM relay_ingress WHERE stable_pair_id = ? AND state IN ('armed','observed') ORDER BY created_at DESC LIMIT 1").get(pairId) as any;
    return Promise.resolve(row ? this.toEntity(row) : null);
  }

  save(ingress: RelayIngress): Promise<void> {
    this.db.prepare(`
      INSERT INTO relay_ingress (ingress_id, stable_pair_id, source_side, provider_type, external_session_id, provider_turn_identity, observed_text, content_hash, arm_evidence_json, state, materialized_assignment_id, created_at, updated_at, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ingress_id) DO UPDATE SET
        stable_pair_id = excluded.stable_pair_id,
        source_side = excluded.source_side,
        provider_type = excluded.provider_type,
        external_session_id = excluded.external_session_id,
        provider_turn_identity = excluded.provider_turn_identity,
        observed_text = excluded.observed_text,
        content_hash = excluded.content_hash,
        arm_evidence_json = excluded.arm_evidence_json,
        state = excluded.state,
        materialized_assignment_id = excluded.materialized_assignment_id,
        updated_at = excluded.updated_at,
        observed_at = excluded.observed_at
    `).run(
      ingress.ingressId,
      ingress.stablePairId,
      ingress.sourceSide,
      ingress.providerType,
      ingress.externalSessionId,
      ingress.providerTurnIdentity,
      ingress.observedText,
      ingress.contentHash ?? null,
      JSON.stringify(ingress.armEvidence),
      ingress.state,
      ingress.materializedAssignmentId ?? null,
      ingress.createdAt,
      ingress.updatedAt,
      ingress.observedAt ?? null,
    );
    return Promise.resolve();
  }

  updateState(id: string, state: RelayIngress['state'], materializedAssignmentId?: string | null): Promise<void> {
    this.db.prepare('UPDATE relay_ingress SET state = ?, materialized_assignment_id = ?, updated_at = ? WHERE ingress_id = ?').run(state, materializedAssignmentId ?? null, Date.now(), id);
    return Promise.resolve();
  }

  private toEntity(row: any): RelayIngress {
    return {
      ingressId: row.ingress_id,
      stablePairId: row.stable_pair_id,
      sourceSide: row.source_side,
      providerType: row.provider_type,
      externalSessionId: row.external_session_id,
      providerTurnIdentity: row.provider_turn_identity,
      observedText: row.observed_text,
      contentHash: row.content_hash ?? undefined,
      armEvidence: row.arm_evidence_json ? JSON.parse(row.arm_evidence_json) : { armId: '' },
      state: row.state,
      materializedAssignmentId: row.materialized_assignment_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      observedAt: row.observed_at ?? undefined,
    };
  }
}
