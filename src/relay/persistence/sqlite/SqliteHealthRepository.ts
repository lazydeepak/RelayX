/**
 * SQLite repositories for Phase 1 health domain.
 * Minimal, bounded, no provider contact, no repair.
 */
import { DatabaseSync } from 'node:sqlite';
import { HealthObservation, HealthIncident } from '../../domain/healthDomain.ts';
import {
  IHealthObservationRepository,
  IHealthIncidentRepository,
} from '../interfaces.ts';

const safeJsonParse = <T>(str: unknown): T | undefined => {
  if (typeof str !== 'string' || !str) return undefined;
  try {
    return JSON.parse(str) as T;
  } catch {
    return undefined;
  }
};

const safeJsonStringify = (val: unknown): string | null => {
  if (val === undefined || val === null) return null;
  try {
    return JSON.stringify(val);
  } catch {
    return null;
  }
};

export class SqliteHealthObservationRepository implements IHealthObservationRepository {
  constructor(private readonly db: DatabaseSync) {}

  async save(observation: HealthObservation): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO health_observations (id, check_type, component_type, component_id, result, timestamp, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        check_type = excluded.check_type,
        component_type = excluded.component_type,
        component_id = excluded.component_id,
        result = excluded.result,
        timestamp = excluded.timestamp,
        evidence_json = excluded.evidence_json
    `);
    stmt.run(
      observation.id,
      observation.checkType,
      observation.componentType,
      observation.componentId ?? null,
      observation.result,
      observation.timestamp,
      safeJsonStringify(observation.evidence),
    );
  }

  async findByCheckType(checkType: string): Promise<HealthObservation[]> {
    const rows = this.db.prepare('SELECT * FROM health_observations WHERE check_type = ? ORDER BY timestamp DESC').all(checkType) as Array<Record<string, unknown>>;
    return rows.map((r) => new HealthObservation({
      id: r.id as string,
      checkType: r.check_type as string,
      componentType: r.component_type as string,
      componentId: (r.component_id as string | null) ?? null,
      result: r.result as any,
      timestamp: Number(r.timestamp),
      evidence: safeJsonParse<Record<string, unknown>>(r.evidence_json) ?? {},
    }));
  }

  async findRecent(limit = 50): Promise<HealthObservation[]> {
    const rows = this.db.prepare('SELECT * FROM health_observations ORDER BY timestamp DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => new HealthObservation({
      id: r.id as string,
      checkType: r.check_type as string,
      componentType: r.component_type as string,
      componentId: (r.component_id as string | null) ?? null,
      result: r.result as any,
      timestamp: Number(r.timestamp),
      evidence: safeJsonParse<Record<string, unknown>>(r.evidence_json) ?? {},
    }));
  }
}

export class SqliteHealthIncidentRepository implements IHealthIncidentRepository {
  constructor(private readonly db: DatabaseSync) {}

  async findById(id: string): Promise<HealthIncident | null> {
    const row = this.db.prepare('SELECT * FROM health_incidents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return new HealthIncident({
      id: row.id as string,
      incidentType: row.incident_type as string,
      componentType: row.component_type as string,
      componentId: (row.component_id as string | null) ?? null,
      severity: row.severity as any,
      status: row.status as any,
      firstSeen: Number(row.first_seen),
      lastSeen: Number(row.last_seen),
      occurrenceCount: Number(row.occurrence_count || 1),
      evidence: safeJsonParse<Record<string, unknown>>(row.evidence_json) ?? {},
    });
  }

  async findOpen(): Promise<HealthIncident[]> {
    const rows = this.db.prepare("SELECT * FROM health_incidents WHERE status IN ('OPEN', 'ACKNOWLEDGED', 'RECURRED') ORDER BY first_seen DESC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => new HealthIncident({
      id: r.id as string,
      incidentType: r.incident_type as string,
      componentType: r.component_type as string,
      componentId: (r.component_id as string | null) ?? null,
      severity: r.severity as any,
      status: r.status as any,
      firstSeen: Number(r.first_seen),
      lastSeen: Number(r.last_seen),
      occurrenceCount: Number(r.occurrence_count || 1),
      evidence: safeJsonParse<Record<string, unknown>>(r.evidence_json) ?? {},
    }));
  }

  async findByIncidentType(incidentType: string): Promise<HealthIncident[]> {
    const rows = this.db.prepare('SELECT * FROM health_incidents WHERE incident_type = ? ORDER BY last_seen DESC').all(incidentType) as Array<Record<string, unknown>>;
    return rows.map((r) => new HealthIncident({
      id: r.id as string,
      incidentType: r.incident_type as string,
      componentType: r.component_type as string,
      componentId: (r.component_id as string | null) ?? null,
      severity: r.severity as any,
      status: r.status as any,
      firstSeen: Number(r.first_seen),
      lastSeen: Number(r.last_seen),
      occurrenceCount: Number(r.occurrence_count || 1),
      evidence: safeJsonParse<Record<string, unknown>>(r.evidence_json) ?? {},
    }));
  }

  async findByComponent(componentType: string, componentId?: string): Promise<HealthIncident[]> {
    let query = 'SELECT * FROM health_incidents WHERE component_type = ?';
    const params: (string | null)[] = [componentType];
    if (componentId !== undefined) {
      query += ' AND component_id = ?';
      params.push(componentId);
    }
    query += ' ORDER BY last_seen DESC';
    const rows = this.db.prepare(query).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => new HealthIncident({
      id: r.id as string,
      incidentType: r.incident_type as string,
      componentType: r.component_type as string,
      componentId: (r.component_id as string | null) ?? null,
      severity: r.severity as any,
      status: r.status as any,
      firstSeen: Number(r.first_seen),
      lastSeen: Number(r.last_seen),
      occurrenceCount: Number(r.occurrence_count || 1),
      evidence: safeJsonParse<Record<string, unknown>>(r.evidence_json) ?? {},
    }));
  }

  /**
   * Bounded history read for the UI. The LIMIT is applied in SQL so a UI refresh
   * can never degrade into a full-table scan as the incident table grows.
   */
  async findRecentHistory(limit: number): Promise<HealthIncident[]> {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 1, 500));
    const rows = this.db
      .prepare("SELECT * FROM health_incidents WHERE status IN ('RESOLVED', 'RECURRED') ORDER BY last_seen DESC LIMIT ?")
      .all(safeLimit) as Array<Record<string, unknown>>;
    return rows.map((r) => new HealthIncident({
      id: r.id as string,
      incidentType: r.incident_type as string,
      componentType: r.component_type as string,
      componentId: (r.component_id as string | null) ?? null,
      severity: r.severity as any,
      status: r.status as any,
      firstSeen: Number(r.first_seen),
      lastSeen: Number(r.last_seen),
      occurrenceCount: Number(r.occurrence_count || 1),
      evidence: safeJsonParse<Record<string, unknown>>(r.evidence_json) ?? {},
    }));
  }

  async save(incident: HealthIncident): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO health_incidents (id, incident_type, component_type, component_id, severity, status, first_seen, last_seen, occurrence_count, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        incident_type = excluded.incident_type,
        component_type = excluded.component_type,
        component_id = excluded.component_id,
        severity = excluded.severity,
        status = excluded.status,
        last_seen = excluded.last_seen,
        occurrence_count = excluded.occurrence_count,
        evidence_json = excluded.evidence_json
    `);
    stmt.run(
      incident.id,
      incident.incidentType,
      incident.componentType,
      incident.componentId ?? null,
      incident.severity,
      incident.status,
      incident.firstSeen,
      incident.lastSeen,
      incident.occurrenceCount,
      safeJsonStringify(incident.evidence),
    );
  }
}
