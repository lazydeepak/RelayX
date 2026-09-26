import { DatabaseSync } from 'node:sqlite';
import {
  AssociationEvidenceCriteria,
  IAssociationRepository,
} from '../interfaces.ts';
import { RuntimeProjectAssociation } from '../../domain/entities.ts';
import {
  AssociationId,
  ProjectId,
  ProviderType,
  RuntimeSessionId,
} from '../../domain/types.ts';

const AUTHORITATIVE_PROVENANCES = ['discovery', 'adoption', 'setup'] as const;

type AssociationRow = Record<string, unknown>;

function schemaGap(detail: string): Error {
  return new Error(
    `Association schema gap: runtime_project_associations cannot verify ${detail}`,
  );
}

export class SqliteAssociationRepository implements IAssociationRepository {
  constructor(private readonly db: DatabaseSync) {}

  private toEntity(row: AssociationRow): RuntimeProjectAssociation {
    return new RuntimeProjectAssociation({
      id: row.id as AssociationId,
      runtimeSessionId: row.runtime_session_id as RuntimeSessionId,
      projectId: row.project_id as ProjectId,
      providerType: (row.provider_type as ProviderType | null | undefined) ?? null,
      externalSessionId: (row.external_session_id as string | null | undefined) ?? null,
      verificationState: row.verification_state as RuntimeProjectAssociation['verificationState'],
      provenance: row.provenance as RuntimeProjectAssociation['provenance'],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    });
  }

  async findById(id: AssociationId): Promise<RuntimeProjectAssociation | null> {
    const row = this.db
      .prepare('SELECT * FROM runtime_project_associations WHERE id = ?')
      .get(id) as AssociationRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  async findBySessionId(
    sessionId: RuntimeSessionId,
  ): Promise<RuntimeProjectAssociation[]> {
    try {
      const rows = this.db
        .prepare(
          'SELECT * FROM runtime_project_associations WHERE runtime_session_id = ? ORDER BY created_at DESC, id DESC',
        )
        .all(sessionId) as AssociationRow[];
      return rows.map((row) => this.toEntity(row));
    } catch (error) {
      throw schemaGap(
        `runtime_session_id, provider_type, external_session_id, and project_id (${String(error)})`,
      );
    }
  }

  async findByProjectId(
    projectId: ProjectId,
  ): Promise<RuntimeProjectAssociation[]> {
    try {
      const rows = this.db
        .prepare(
          'SELECT * FROM runtime_project_associations WHERE project_id = ? ORDER BY created_at DESC, id DESC',
        )
        .all(projectId) as AssociationRow[];
      return rows.map((row) => this.toEntity(row));
    } catch (error) {
      throw schemaGap(
        `runtime_session_id, provider_type, external_session_id, and project_id (${String(error)})`,
      );
    }
  }

  async findVerifiedBySessionId(
    sessionId: RuntimeSessionId,
    criteria: AssociationEvidenceCriteria,
  ): Promise<RuntimeProjectAssociation | null> {
    if (!criteria?.providerType || !criteria.projectId) {
      throw schemaGap(
        'provider_type, external_session_id, and project_id criteria are required for pre-pair evidence',
      );
    }
    const params: Array<string | null> = [
      sessionId,
      'verified',
      ...AUTHORITATIVE_PROVENANCES,
      criteria.providerType,
      criteria.externalSessionId ?? null,
      criteria.projectId,
    ];

    let row: AssociationRow | undefined;
    try {
      row = this.db
        .prepare(
          `SELECT * FROM runtime_project_associations
           WHERE runtime_session_id = ?
             AND verification_state = ?
             AND provenance IN (?, ?, ?)
             AND provider_type = ?
             AND external_session_id IS ?
             AND project_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
        )
        .get(...params) as AssociationRow | undefined;
    } catch (error) {
      throw schemaGap(
        `runtime_session_id, provider_type, external_session_id, and project_id (${String(error)})`,
      );
    }

    if (row) return this.toEntity(row);

    // A legacy verified row without provider evidence is not the same as "no
    // evidence": returning a generic rejection would hide an unverifiable
    // schema. Surface the exact gap so callers cannot claim successful pairing.
    const legacyVerified = (await this.findBySessionId(sessionId)).find(
      (association) =>
        association.verificationState === 'verified' &&
        AUTHORITATIVE_PROVENANCES.includes(
          association.provenance as (typeof AUTHORITATIVE_PROVENANCES)[number],
        ) &&
        (!association.providerType || !association.externalSessionId),
    );
    if (legacyVerified) {
      const missingFields: string[] = [];
      if (!legacyVerified.providerType) missingFields.push('provider_type');
      if (!legacyVerified.externalSessionId) {
        missingFields.push('external_session_id');
      }
      throw schemaGap(
        `${missingFields.join(' and ')} for verified association '${legacyVerified.id}'`,
      );
    }

    return null;
  }

  async findAll(): Promise<RuntimeProjectAssociation[]> {
    try {
      const rows = this.db
        .prepare(
          'SELECT * FROM runtime_project_associations ORDER BY created_at DESC, id DESC',
        )
        .all() as AssociationRow[];
      return rows.map((row) => this.toEntity(row));
    } catch (error) {
      throw schemaGap(
        `runtime_session_id, provider_type, external_session_id, and project_id (${String(error)})`,
      );
    }
  }

  async save(assoc: RuntimeProjectAssociation): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO runtime_project_associations
            (id, runtime_session_id, project_id, provider_type, external_session_id,
             verification_state, provenance, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             runtime_session_id = excluded.runtime_session_id,
             project_id = excluded.project_id,
             provider_type = excluded.provider_type,
             external_session_id = excluded.external_session_id,
             verification_state = excluded.verification_state,
             provenance = excluded.provenance,
             updated_at = excluded.updated_at`,
        )
        .run(
          assoc.id,
          assoc.runtimeSessionId,
          assoc.projectId,
          assoc.providerType ?? null,
          assoc.externalSessionId ?? null,
          assoc.verificationState,
          assoc.provenance,
          assoc.createdAt,
          assoc.updatedAt,
        );
    } catch (error) {
      // A repository that cannot persist the evidence fields must never be
      // treated as a successful authoritative association.
      if (String(error).includes('provider_type')) {
        throw schemaGap(`provider_type (${String(error)})`);
      }
      throw error;
    }
  }

  async delete(id: AssociationId): Promise<void> {
    this.db.prepare('DELETE FROM runtime_project_associations WHERE id = ?').run(id);
  }
}
