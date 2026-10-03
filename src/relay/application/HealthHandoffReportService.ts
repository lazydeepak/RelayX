/**
 * Phase 1 — external-worker handoff report.
 *
 * ## What this IS
 *
 * A factual, read-only summary of ONE health incident: what RelayX observed, what
 * it classified, and what it could not establish. It is intended to save an
 * external developer or agent from reconstructing the failure from scratch.
 *
 * ## What this is NOT
 *
 * It is NOT a diagnosis. It never claims root cause, never recommends a fix, and
 * never authorises a retry. Where the evidence does not establish something, the
 * report says so explicitly instead of inferring it.
 *
 * ## Hard boundaries
 *
 * - no health check is run;
 * - no provider is contacted, no discovery, no subprocess, no AppleScript;
 * - no operational state is mutated.
 */
import { IRelayRepositories } from '../persistence/interfaces.ts';
import { IHealthIncidentRepository } from '../persistence/interfaces.ts';
import {
  sanitizeHealthEvidence,
  sanitizeHealthText,
  SanitizedScalar,
} from '../health/healthEvidenceSanitizer.ts';

/** Hard ceiling on related events included in a report. */
export const HANDOFF_EVENT_LIMIT = 20;

/** Default ceiling; a caller cannot exceed the hard limit. */
export const HANDOFF_DEFAULT_EVENT_LIMIT = 10;

/** How far back a related event may be and still be considered relevant. */
export const HANDOFF_EVENT_WINDOW_MS = 30 * 60 * 1000;

export interface HandoffReport {
  incidentId: string;
  incidentType: string;
  severity: string;
  lifecycle: string;
  componentType: string;
  componentId: string | null;
  /** Plain-text report, ready to paste into an external channel. */
  text: string;
  /** Related events actually included, for programmatic use and tests. */
  relatedEvents: Array<{ id: string; type: string; at: number; summary: string }>;
}

function fmtTs(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return 'unavailable';
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

/** Identity fields the template offers; absent ones render as "unavailable". */
const IDENTITY_LABELS: Array<[string, string[]]> = [
  ['Project', ['projectId']],
  ['Pair', ['pairId']],
  ['Side', ['sideRole']],
  ['Provider', ['providerType']],
  ['Runtime session', ['runtimeSessionId']],
  ['External session identity', ['expectedExternalSessionId', 'observedExternalSessionId', 'externalSessionId']],
  ['Assignment', ['assignmentId']],
  ['Attempt', ['attemptId']],
  ['Delivery', ['deliveryId']],
];

function firstPresent(ev: Record<string, SanitizedScalar>, keys: string[]): SanitizedScalar | undefined {
  for (const k of keys) {
    if (ev[k] !== undefined && ev[k] !== null) return ev[k];
  }
  return undefined;
}

export class HealthHandoffReportService {
  constructor(
    private readonly repos: IRelayRepositories,
    private readonly incidents: IHealthIncidentRepository,
  ) {}

  /**
   * Generate a handoff report for one incident.
   *
   * Returns null when the incident does not exist. A RESOLVED or RECURRED
   * incident still produces a report: historical handoffs are exactly what is
   * needed to investigate a recurring problem.
   */
  async generate(incidentId: string, options: { eventLimit?: number } = {}): Promise<HandoffReport | null> {
    const incident = await this.incidents.findById(incidentId);
    if (!incident) return null;

    const sanitized = sanitizeHealthEvidence(incident.evidence);
    const ev = sanitized.values;

    const relatedEvents = await this.collectRelatedEvents(
      incident.id,
      incident.componentId,
      incident.firstSeen,
      options.eventLimit ?? HANDOFF_DEFAULT_EVENT_LIMIT,
    );

    const unavailable: string[] = [];
    const lines: string[] = [];

    lines.push('RelayX Health Incident');
    lines.push('');
    lines.push(`Incident: ${incident.incidentType}`);
    lines.push(`Severity: ${incident.severity}`);
    lines.push(`Lifecycle: ${incident.status}`);
    lines.push(`Incident ID: ${incident.id}`);
    lines.push('');

    // --- Affected component -------------------------------------------------
    lines.push('--- Affected component ---');
    lines.push(`Component type: ${incident.componentType}`);
    lines.push(`Component id: ${incident.componentId ?? 'unavailable'}`);
    if (incident.componentId === null) unavailable.push('componentId');

    for (const [label, keys] of IDENTITY_LABELS) {
      const value = firstPresent(ev, keys);
      if (value === undefined) {
        lines.push(`${label}: unavailable`);
        unavailable.push(label.toLowerCase().replace(/\s+/g, ''));
      } else {
        lines.push(`${label}: ${String(value)}`);
      }
    }
    lines.push('');

    // --- Timing -------------------------------------------------------------
    lines.push('--- Timing ---');
    lines.push(`First seen: ${fmtTs(incident.firstSeen)}`);
    lines.push(`Last seen: ${fmtTs(incident.lastSeen)}`);
    lines.push(`Occurrences: ${incident.occurrenceCount}`);
    lines.push('');

    // --- What RelayX detected ----------------------------------------------
    lines.push('--- What RelayX detected (RelayX classification, not a diagnosis) ---');
    const detected = sanitizeHealthText(ev.message) ?? sanitizeHealthText(ev.reason) ?? sanitizeHealthText(ev.note);
    lines.push(`Classification: ${incident.incidentType}`);
    lines.push(`Detector statement: ${detected ?? 'unavailable — no detector statement was recorded'}`);
    if (!detected) unavailable.push('detectorStatement');
    lines.push('');

    // --- Observed evidence --------------------------------------------------
    lines.push('--- Observed facts (sanitized evidence) ---');
    const evidenceEntries = Object.entries(ev).filter(
      ([k, v]) => !['message', 'reason', 'note'].includes(k) && v !== null,
    );
    if (evidenceEntries.length === 0) {
      lines.push('(no sanitized evidence recorded)');
    } else {
      for (const [k, v] of evidenceEntries) {
        lines.push(`  ${k}: ${String(v)}`);
      }
    }
    if (sanitized.omittedKeys.length > 0) {
      lines.push(`  [omitted as oversized or non-scalar: ${sanitized.omittedKeys.join(', ')}]`);
    }
    if (sanitized.redactedKeys.length > 0) {
      // Names only. The values are never surfaced, not even truncated.
      lines.push(`  [redacted for safety: ${sanitized.redactedKeys.join(', ')}]`);
    }
    lines.push('');

    // --- Related events -----------------------------------------------------
    lines.push(`--- Related recent events (max ${relatedEvents.length}) ---`);
    if (relatedEvents.length === 0) {
      lines.push('(no related RelayX events found in the queried window)');
    } else {
      for (const e of relatedEvents) {
        lines.push(`  ${fmtTs(e.at)}  ${e.type}  ${e.summary}`);
      }
    }
    lines.push('');

    // --- Current known state ------------------------------------------------
    lines.push('--- Current known state (as persisted by RelayX) ---');
    lines.push(`Lifecycle: ${incident.status}`);
    lines.push(`Severity: ${incident.severity}`);
    lines.push(`Occurrences: ${incident.occurrenceCount}`);
    lines.push('');

    // --- Unknowns -----------------------------------------------------------
    lines.push('--- Unknown / not established by RelayX ---');
    if (unavailable.length === 0) {
      lines.push('(no unavailable fields)');
    } else {
      for (const u of unavailable) lines.push(`  - ${u}`);
    }
    lines.push('  - root cause (RelayX reports observations only; it does not diagnose)');
    lines.push('');

    // --- Non-actions --------------------------------------------------------
    lines.push('--- What RelayX did NOT do ---');
    lines.push('- no repair');
    lines.push('- no retry or resend');
    lines.push('- no session rebind or replacement');
    lines.push('- no provider, application, or machine restart');
    lines.push('- no source modification');
    lines.push('- no automated recovery');
    lines.push('');
    lines.push('Manual investigation required.');

    return {
      incidentId: incident.id,
      incidentType: incident.incidentType,
      severity: incident.severity,
      lifecycle: incident.status,
      componentType: incident.componentType,
      componentId: incident.componentId ?? null,
      text: lines.join('\n'),
      relatedEvents,
    };
  }

  /**
   * Collect a bounded set of relevant recent RelayX events.
   *
   * Relevance: same resource as the incident's component, or same assignment /
   * attempt / delivery named in the evidence, within a bounded time window.
   * The limit is applied in the repository query, so this can never degrade into
   * an unbounded timeline read.
   */
  private async collectRelatedEvents(
    incidentId: string,
    componentId: string | null,
    incidentFirstSeen: number,
    limit: number,
  ): Promise<Array<{ id: string; type: string; at: number; summary: string }>> {
    const bounded = Math.max(1, Math.min(Math.floor(limit) || 1, HANDOFF_EVENT_LIMIT));
    const incident = await this.incidents.findById(incidentId);
    const evidence = sanitizeHealthEvidence(incident?.evidence ?? {}).values;

    const resourceIds = new Set<string>();
    if (componentId) resourceIds.add(componentId);
    for (const key of ['deliveryId', 'assignmentId', 'attemptId', 'pairId', 'runtimeSessionId']) {
      const v = evidence[key];
      if (typeof v === 'string' && v) resourceIds.add(v);
    }
    if (resourceIds.size === 0) return [];

    // Window: from a little before the incident to a bounded window after, so
    // both the trigger and the immediate aftermath are visible.
    const from = incidentFirstSeen - HANDOFF_EVENT_WINDOW_MS;
    const to = Date.now();

    let events: Array<{ id: string; type: string; at: number; summary: string }> = [];
    for (const resourceId of resourceIds) {
      const found = await this.repos.events.findFiltered({
        resourceId,
        startTime: from,
        endTime: to,
        limit: bounded,
      });
      events.push(
        ...found.events.map((e) => ({
          id: e.id,
          type: e.eventType,
          at: e.timestamp,
          // eventType + state transition only. Event details can carry payload
          // fragments, so they are deliberately not surfaced here.
          summary: [e.actor, e.previousState, e.newState].filter(Boolean).join(' → ') || '—',
        })),
      );
      if (events.length >= bounded) break;
    }

    events.sort((a, b) => b.at - a.at);
    return events.slice(0, bounded);
  }
}
