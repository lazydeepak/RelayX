/**
 * Phase 1 Health Incident Engine — dedup, lifecycle, and persistence.
 *
 * Read-only with respect to RelayX operational state. It does not modify
 * Pair, Attempt, Delivery, Runtime, or provider dispatch behavior.
 */
import { HealthObservation, HealthIncident, HealthSeverity, HealthIncidentStatus } from '../domain/healthDomain.ts';
import { IHealthIncidentRepository, IHealthObservationRepository } from '../persistence/interfaces.ts';

const SEVERITY_RANK: Record<HealthSeverity, number> = {
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  CRITICAL: 4,
};

function severityGreaterThan(a: HealthSeverity, b: HealthSeverity): boolean {
  return SEVERITY_RANK[a] > SEVERITY_RANK[b];
}

function computeIncidentKey(incidentType: string, componentType: string, componentId: string | null | undefined): string {
  return `${incidentType}::${componentType}::${componentId ?? ''}`;
}

export class HealthIncidentEngine {
  constructor(
    private readonly observationsRepo: IHealthObservationRepository,
    private readonly incidentsRepo: IHealthIncidentRepository,
  ) {}

  /**
   * Receive an unhealthy observation and either open or update the matching
   * durable incident. Never creates duplicates.
   *
   * `occurrenceCount` lets a caller that has already confirmed a multi-sample
   * condition (e.g. the DELIVERY_STALLED confirmation tracker) seed the
   * incident with the true number of qualifying observations. Defaults to 1
   * for single-observation callers.
   */
  async recordUnhealthyObservation(observation: HealthObservation, occurrenceCount?: number): Promise<HealthIncident> {
    const key = computeIncidentKey(observation.checkType, observation.componentType, observation.componentId);
    const openIncidents = await this.incidentsRepo.findOpen();
    const match = openIncidents.find(
      (i) =>
        i.incidentType === observation.checkType &&
        i.componentType === observation.componentType &&
        i.componentId === observation.componentId,
    );

    if (match) {
      // Update existing open/recurrent incident
      const incomingSeverity: HealthSeverity = (observation.evidence?.severity as HealthSeverity) ?? (observation.result === 'UNHEALTHY' ? 'ERROR' : 'WARNING');
      const newSeverity: HealthSeverity = severityGreaterThan(incomingSeverity, match.severity) ? incomingSeverity : match.severity;

      match.updateFromObservation(newSeverity, observation.evidence, observation.timestamp);
      await this.incidentsRepo.save(match);
      return match;
    }

    // No matching open/recurrent incident: create new
    const newIncident = new HealthIncident({
      id: `inc_${observation.checkType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      incidentType: observation.checkType,
      componentType: observation.componentType,
      componentId: observation.componentId ?? null,
      severity: ((observation.evidence?.severity as HealthSeverity) ?? (observation.result === 'UNHEALTHY' ? 'ERROR' : 'WARNING')) as HealthSeverity,
      status: 'OPEN',
      firstSeen: observation.timestamp,
      lastSeen: observation.timestamp,
      occurrenceCount: occurrenceCount && occurrenceCount > 0 ? occurrenceCount : 1,
      evidence: observation.evidence,
    });
    await this.incidentsRepo.save(newIncident);
    return newIncident;
  }

  /** Confirmed resolution: caller explicitly indicates recovery. */
  async resolveIncident(incidentId: string): Promise<HealthIncident | null> {
    const inc = await this.incidentsRepo.findById(incidentId);
    if (!inc) return null;
    inc.resolve();
    await this.incidentsRepo.save(inc);
    return inc;
  }

  /**
   * Handle recurrence: same condition after RESOLVED.
   * Updates the existing incident to RECURRED rather than creating a duplicate.
   */
  async recordRecurrence(incidentId: string, observation: HealthObservation): Promise<HealthIncident | null> {
    const inc = await this.incidentsRepo.findById(incidentId);
    if (!inc) return null;
    inc.markRecurred();
    const incomingSeverity =
      ((observation.evidence?.severity as HealthSeverity) ??
        (observation.result === 'UNHEALTHY' ? 'ERROR' : 'WARNING')) as HealthSeverity;
    if (severityGreaterThan(incomingSeverity, inc.severity)) {
      inc.severity = incomingSeverity;
    }
    // Newest evidence wins for overlapping keys. Historical identity is preserved
    // because it lives in the incident's own typed fields (firstSeen, occurrenceCount),
    // not in the evidence blob.
    inc.evidence = { ...inc.evidence, ...observation.evidence, recurrenceAt: observation.timestamp };
    inc.lastSeen = observation.timestamp;
    await this.incidentsRepo.save(inc);
    return inc;
  }

  /** Find the matching open/recurrent incident by identity key. */
  async findMatchingIncident(incidentType: string, componentType: string, componentId?: string | null): Promise<HealthIncident | null> {
    const open = await this.incidentsRepo.findOpen();
    return open.find(
      (i) => i.incidentType === incidentType && i.componentType === componentType && i.componentId === (componentId ?? null),
    ) ?? null;
  }
}
