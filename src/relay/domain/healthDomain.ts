/**
 * Phase 1 Health Domain — minimal vocabulary and durable records.
 *
 * Strict boundaries:
 * - Health observations and incidents are READ-ONLY with respect to RelayX
 *   operational state (Pair/Attempt/Delivery/Runtime). They never modify it.
 * - No health rules, no polling, no repair, no AI, no provider contact.
 */

export const HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const HEALTH_SEVERITIES = ['INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const;
export type HealthSeverity = (typeof HEALTH_SEVERITIES)[number];

export const HEALTH_INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'RECURRED'] as const;
export type HealthIncidentStatus = (typeof HEALTH_INCIDENT_STATUSES)[number];

export interface HealthObservationProps {
  id: string;
  checkType: string;
  componentType: string;
  componentId?: string | null;
  result: HealthState;
  timestamp: number;
  evidence: Record<string, unknown>;
}

/** A single timestamped evaluation/result from a named health check. */
export class HealthObservation {
  public readonly id: string;
  public readonly checkType: string;
  public readonly componentType: string;
  public readonly componentId: string | null;
  public readonly result: HealthState;
  public readonly timestamp: number;
  public readonly evidence: Record<string, unknown>;

  constructor(props: HealthObservationProps) {
    this.id = props.id;
    this.checkType = props.checkType;
    this.componentType = props.componentType;
    this.componentId = props.componentId ?? null;
    this.result = props.result;
    this.timestamp = props.timestamp;
    this.evidence = props.evidence ?? {};
  }

  public toRecord(): Record<string, unknown> {
    return {
      id: this.id,
      checkType: this.checkType,
      componentType: this.componentType,
      componentId: this.componentId,
      result: this.result,
      timestamp: this.timestamp,
      evidence: this.evidence,
    };
  }
}

export interface HealthIncidentProps {
  id: string;
  incidentType: string;
  componentType: string;
  componentId?: string | null;
  severity: HealthSeverity;
  status: HealthIncidentStatus;
  firstSeen: number;
  lastSeen: number;
  occurrenceCount: number;
  evidence: Record<string, unknown>;
}

/** Durable problem record. Never performs repair; only reports. */
export class HealthIncident {
  public readonly id: string;
  public readonly incidentType: string;
  public readonly componentType: string;
  public readonly componentId: string | null;
  public severity: HealthSeverity;
  public status: HealthIncidentStatus;
  public readonly firstSeen: number;
  public lastSeen: number;
  public occurrenceCount: number;
  public evidence: Record<string, unknown>;

  constructor(props: HealthIncidentProps) {
    this.id = props.id;
    this.incidentType = props.incidentType;
    this.componentType = props.componentType;
    this.componentId = props.componentId ?? null;
    this.severity = props.severity;
    this.status = props.status;
    this.firstSeen = props.firstSeen;
    this.lastSeen = props.lastSeen;
    this.occurrenceCount = props.occurrenceCount;
    this.evidence = props.evidence ?? {};
  }

  /**
   * Apply a newly observed qualifying sample to this still-active incident.
   *
   * `ACKNOWLEDGED` is PRESERVED: an operator's acknowledgment is a statement about
   * this incident, not about the latest sample, so a repeat observation must not
   * silently reopen it. `RESOLVED` is also left alone here because resolution is
   * explicit — a resolved incident is only revived through {@link markRecurred}.
   * Everything else (OPEN / RECURRED) is refreshed.
   */
  public updateFromObservation(
    severity?: HealthSeverity,
    evidence?: Record<string, unknown>,
    observedAt?: number,
  ): void {
    if (this.status !== 'ACKNOWLEDGED' && this.status !== 'RESOLVED') {
      this.status = 'OPEN';
    }
    this.lastSeen = observedAt ?? Date.now();
    this.occurrenceCount += 1;
    if (severity) {
      // Escalate only when explicitly allowed; default preserves existing severity.
      this.severity = severity;
    }
    if (evidence) {
      // New evidence wins for overlapping keys so a fresh measurement is never
      // overwritten by an older one.
      this.evidence = { ...this.evidence, ...evidence, latestUpdateAt: this.lastSeen };
    }
  }

  public resolve(): void {
    this.status = 'RESOLVED';
    this.lastSeen = Date.now();
  }

  public acknowledge(): void {
    this.status = 'ACKNOWLEDGED';
    this.lastSeen = Date.now();
  }

  public markRecurred(): void {
    this.status = 'RECURRED';
    this.lastSeen = Date.now();
    this.occurrenceCount += 1;
  }

  public toRecord(): Record<string, unknown> {
    return {
      id: this.id,
      incidentType: this.incidentType,
      componentType: this.componentType,
      componentId: this.componentId,
      severity: this.severity,
      status: this.status,
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      occurrenceCount: this.occurrenceCount,
      evidence: this.evidence,
    };
  }
}
