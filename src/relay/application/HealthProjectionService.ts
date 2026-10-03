/**
 * Phase 1 health — READ-ONLY projections for the operator UI.
 *
 * ## The boundary this module exists to enforce
 *
 * The renderer may READ health state. It may not RUN health state. Everything
 * here is a pure projection over already-persisted rows: no provider call, no
 * AppleScript, no subprocess, no session discovery, no timer, and no write to any
 * operational repository.
 *
 * The single exception is acknowledgement, which is an explicit operator action
 * against the health record itself — never a repair, retry, resolve, or rebind.
 *
 * ## Truthfulness rule
 *
 * "No incidents" is NOT "healthy". Until the monitoring runtime has actually
 * produced sufficient evidence, the honest aggregate is `UNKNOWN`. This module
 * will not manufacture a healthy verdict from an empty table.
 */
import {
  HealthIncident,
  HealthObservation,
  HealthSeverity,
  HealthIncidentStatus,
} from '../domain/healthDomain.ts';
import { IHealthIncidentRepository, IHealthObservationRepository } from '../persistence/interfaces.ts';
import { sanitizeHealthEvidence } from '../health/healthEvidenceSanitizer.ts';

export { HEALTH_EVIDENCE_MAX_STRING_LENGTH } from '../health/healthEvidenceSanitizer.ts';

export type HealthAggregateState = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

/**
 * Evidence sufficiency: how many persisted observations are required before an
 * empty incident table may be reported as HEALTHY rather than UNKNOWN.
 *
 * Health policy, not a RelayX operational constant. It is deliberately small:
 * the main-process heartbeat alone satisfies it within one interval.
 */
export const HEALTH_EVIDENCE_SUFFICIENCY_THRESHOLD = 1;

/** Bounded default history limit. The renderer must never load unbounded history. */
export const HEALTH_HISTORY_DEFAULT_LIMIT = 25;

/** Hard ceiling on any single health query issued by the UI path. */
export const HEALTH_QUERY_MAX_LIMIT = 100;

export interface UIHealthSummary {
  /** Overall aggregate. Never fabricated from an empty table. */
  overall: HealthAggregateState;
  /** Why the aggregate reads the way it does, in operator terms. */
  overallReason: string;
  activeIncidentCount: number;
  resolvedIncidentCount: number;
  totalObservationCount: number;
  /** True once enough evidence exists to distinguish HEALTHY from UNKNOWN. */
  hasSufficientEvidence: boolean;
  /** Distinct detector types that have produced at least one observation. */
  observedCheckTypes: string[];
  /** Timestamp of the newest observation, or null when none exists. */
  lastObservationAt: number | null;
}

export interface UIHealthIncident {
  id: string;
  incidentType: string;
  severity: HealthSeverity;
  status: HealthIncidentStatus;
  componentType: string;
  componentId: string | null;
  firstSeen: number;
  lastSeen: number;
  occurrenceCount: number;
  /** Short, human-readable one-liner. Never a raw log dump. */
  summary: string;
  /** Bounded evidence key names only — used for the detail view's field list. */
  evidenceKeys: string[];
}

export interface UIHealthIncidentDetail extends UIHealthIncident {
  /**
   * Bounded evidence as flat scalar fields. Only primitives are surfaced, so a
   * transcript, prompt body, command line, or nested blob cannot reach the UI
   * even if one were ever written into the evidence record.
   */
  evidence: Record<string, string | number | boolean | null>;
  /** Identity fields that were NOT present in the evidence, kept explicit. */
  unavailableFields: string[];
}

export interface HealthProjectionOptions {
  incidentsRepo: IHealthIncidentRepository;
  observationsRepo: IHealthObservationRepository;
  now?: () => number;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), HEALTH_QUERY_MAX_LIMIT);
}

/** Severity ordering used for sorting. Explicit, not an arbitrary numeric rank. */
const SEVERITY_ORDER: Record<HealthSeverity, number> = {
  CRITICAL: 0,
  ERROR: 1,
  WARNING: 2,
  INFO: 3,
};

/**
 * Build a short operator-facing summary from an incident.
 *
 * Prefers a detector-supplied message, then the reason, then a factual
 * type/component fallback. It never invents a diagnosis.
 */
function summarize(incident: HealthIncident): string {
  const ev = incident.evidence ?? {};
  const candidate =
    (typeof ev.message === 'string' && ev.message) ||
    (typeof ev.reason === 'string' && ev.reason) ||
    (typeof ev.note === 'string' && ev.note) ||
    null;
  if (candidate) return candidate.slice(0, 240);
  return `${incident.incidentType} on ${incident.componentType}${incident.componentId ? ` ${incident.componentId}` : ''}`;
}

/**
 * Flatten evidence to bounded scalars using the SHARED sanitizer.
 *
 * Delegating rather than re-implementing is deliberate: the handoff report
 * surfaces the same evidence to an external agent, and two independent filters
 * would eventually let the weaker one govern.
 */
function boundedEvidence(evidence: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return sanitizeHealthEvidence(evidence).values;
}

/** Identity fields the detail view should list even when absent. */
const IDENTITY_FIELDS = [
  'pairId', 'projectId', 'assignmentId', 'attemptId', 'deliveryId',
  'providerType', 'runtimeSessionId', 'sideRole',
] as const;

export class HealthProjectionService {
  private readonly incidents: IHealthIncidentRepository;
  private readonly observations: IHealthObservationRepository;
  private readonly now: () => number;

  constructor(opts: HealthProjectionOptions) {
    this.incidents = opts.incidentsRepo;
    this.observations = opts.observationsRepo;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Overall health.
   *
   *   any active ERROR/CRITICAL     -> UNHEALTHY
   *   else any active WARNING       -> DEGRADED
   *   else sufficient evidence      -> HEALTHY
   *   else                          -> UNKNOWN
   *
   * `INFO` is explicitly NOT degrading. It is a noteworthy-but-healthy severity:
   * an INFO incident is listed and counted, but it does not change the aggregate
   * verdict. Folding INFO into DEGRADED would make an ordinary notice
   * indistinguishable from a real degradation signal.
   *
   * The UNKNOWN branch is equally deliberate: an empty incident table is not
   * evidence of health.
   */
  async getHealthSummary(): Promise<UIHealthSummary> {
    const open = await this.incidents.findOpen();
    const recent = await this.observations.findRecent(HEALTH_QUERY_MAX_LIMIT);
    const hasSufficientEvidence = recent.length >= HEALTH_EVIDENCE_SUFFICIENCY_THRESHOLD;
    const observedCheckTypes = Array.from(new Set(recent.map((o) => o.checkType)));
    const lastObservationAt = recent.length ? recent[0].timestamp : null;

    const errored = open.filter((i) => i.severity === 'ERROR' || i.severity === 'CRITICAL');
    const warned = open.filter((i) => i.severity === 'WARNING');
    const info = open.filter((i) => i.severity === 'INFO');

    let overall: HealthAggregateState;
    let overallReason: string;
    if (errored.length > 0) {
      overall = 'UNHEALTHY';
      overallReason = `${errored.length} active incident${errored.length === 1 ? '' : 's'} at ERROR or CRITICAL`;
    } else if (warned.length > 0) {
      overall = 'DEGRADED';
      overallReason = `${warned.length} active incident${warned.length === 1 ? '' : 's'} at WARNING`;
    } else if (hasSufficientEvidence) {
      overall = 'HEALTHY';
      overallReason =
        info.length > 0
          ? `No warnings or errors. ${info.length} informational incident${info.length === 1 ? '' : 's'} noted`
          : 'No active health incidents, and the health runtime has produced evidence';
    } else {
      overall = 'UNKNOWN';
      overallReason = 'No active incidents, but the health runtime has not produced sufficient evidence yet';
    }

    // Resolved history count is bounded; it is a trend signal, not a full scan.
    const history = await this.listResolvedIncidents(HEALTH_HISTORY_DEFAULT_LIMIT);

    return {
      overall,
      overallReason,
      activeIncidentCount: open.length,
      resolvedIncidentCount: history.length,
      totalObservationCount: recent.length,
      hasSufficientEvidence,
      observedCheckTypes,
      lastObservationAt,
    };
  }

  /** Active incidents, sorted by severity then recency. Bounded. */
  async listActiveIncidents(limit?: number): Promise<UIHealthIncident[]> {
    const open = await this.incidents.findOpen();
    return open
      .sort((a, b) => {
        const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (bySeverity !== 0) return bySeverity;
        return b.lastSeen - a.lastSeen;
      })
      .slice(0, clampLimit(limit, HEALTH_HISTORY_DEFAULT_LIMIT))
      .map((i) => this.toListItem(i));
  }

  /**
   * Recent RESOLVED / RECURRED history, bounded by default.
   * Purpose is to reveal repeated problems, not to reconstruct everything.
   */
  async listResolvedIncidents(limit?: number): Promise<UIHealthIncident[]> {
    const bounded = clampLimit(limit, HEALTH_HISTORY_DEFAULT_LIMIT);
    // findOpen() excludes RESOLVED rows by contract, so history uses the
    // repository's dedicated SQL-bounded read rather than an unbounded scan.
    const history = await this.incidents.findRecentHistory(bounded);
    return history.map((i) => this.toListItem(i));
  }

  /** One incident with bounded detail. Returns null when absent. */
  async getHealthIncident(id: string): Promise<UIHealthIncidentDetail | null> {
    const incident = await this.incidents.findById(id);
    if (!incident) return null;
    const evidence = boundedEvidence(incident.evidence);
    const unavailableFields = IDENTITY_FIELDS.filter(
      (f) => evidence[f] === undefined || evidence[f] === null,
    );
    return { ...this.toListItem(incident), evidence, unavailableFields };
  }

  /**
   * Operator acknowledgement.
   *
   * This is the ONLY mutation Phase 1 UI may perform, and it is deliberately
   * narrow: `OPEN -> ACKNOWLEDGED` on the health record itself. It never
   * resolves, never retries, never repairs, and never touches an operational
   * entity. ACKNOWLEDGED is preserved across subsequent observations by the
   * engine, so acknowledging cannot be undone by a heartbeat.
   */
  async acknowledgeIncident(id: string): Promise<{ success: boolean; status?: HealthIncidentStatus }> {
    const incident = await this.incidents.findById(id);
    if (!incident) return { success: false };
    if (incident.status === 'RESOLVED') return { success: false, status: incident.status };
    incident.acknowledge();
    await this.incidents.save(incident);
    return { success: true, status: incident.status };
  }

  /** Bounded recent observations for the health panel's activity strip. */
  async listRecentObservations(limit?: number): Promise<HealthObservation[]> {
    return this.observations.findRecent(clampLimit(limit, 20));
  }

  private toListItem(incident: HealthIncident): UIHealthIncident {
    return {
      id: incident.id,
      incidentType: incident.incidentType,
      severity: incident.severity,
      status: incident.status,
      componentType: incident.componentType,
      componentId: incident.componentId,
      firstSeen: incident.firstSeen,
      lastSeen: incident.lastSeen,
      occurrenceCount: incident.occurrenceCount,
      summary: summarize(incident),
      evidenceKeys: Object.keys(incident.evidence ?? {}).sort(),
    };
  }
}
