/**
 * Phase 1 — DELIVERY_STALLED detector.
 *
 * Strict non-goals: no repair, no retry, no provider contact, no timer loop.
 * This is a callable detector that evaluates a single Delivery's durable state.
 */
import { HealthObservation, HealthState, HealthSeverity } from '../domain/healthDomain.ts';
import { DeliveryStatus } from '../domain/types.ts';

export const STALLED_WARNING_MS = 30_000; // Health-policy default: first stall warning (30s)
export const STALLED_ERROR_MS = 120_000;  // Health-policy default: critical stall (120s)
// These are explicit health-policy thresholds, not derived from delivery semantics.
// Existing RelayX defines provider timeout (DEFAULT_TIMEOUT_MS = 5000ms) but has
// no delivery-specific stall threshold; these values are chosen conservatively.

export interface DeliveryStalledEvidence {
  deliveryId: string;
  status: DeliveryStatus;
  assignmentId?: string | null;
  attemptId?: string | null;
  pairId?: string | null;
  createdAt: number;
  updatedAt: number;
  ageMs: number;
  thresholdWarningMs: number;
  thresholdErrorMs: number;
  observationAt: number;
}

export interface StalledCheckResult {
  kind: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  observation?: HealthObservation;
  evidence?: DeliveryStalledEvidence;
  message?: string;
  /**
   * False when the caller must NOT open a DELIVERY_STALLED incident. The
   * ambiguous-outcome observation deliberately sets this to false: it is reported
   * under DELIVERY_AMBIGUOUS and must not be laundered into a stall incident.
   */
  incidentEligible?: boolean;
}

/**
 * Evaluate whether a single Delivery represents a stalled condition.
 * Read-only: does not modify the Delivery or any RelayX operational state.
 *
 * Confirmation/debounce contract (Prompt 4.1): the first qualifying stale
 * sample is a CANDIDATE only — it produces evidence but NO observation, so
 * no incident can be opened from a single sample. Only a sample confirmed by
 * the caller's tracker (`priorSample.count >= 1`) emits an observation.
 */
export function evaluateDeliveryStalled(
  deliveryStatus: DeliveryStatus,
  createdAt: number,
  updatedAt: number,
  deliveryId: string,
  nowMs: number,
  optionalIds?: {
    assignmentId?: string | null;
    attemptId?: string | null;
    pairId?: string | null;
  },
  priorSample?: { count: number },
): StalledCheckResult {
  // Unknown: missing required state
  if (deliveryStatus === null || deliveryStatus === undefined) {
    return { kind: 'UNKNOWN', message: 'Delivery status is missing' };
  }

  // Ambiguous: terminal for the Delivery lifecycle (resend blocked) with an
  // uncertain OUTCOME. It is emphatically NOT a stalled Delivery — nothing is
  // stuck, the send may already have succeeded.
  //
  // It is reported as a bounded DEGRADED/uncertain observation under its own
  // `DELIVERY_AMBIGUOUS` check type so it can never open a DELIVERY_STALLED
  // incident, and it never authorizes a retry.
  if (deliveryStatus === 'ambiguous') {
    const evidence: DeliveryStalledEvidence = {
      deliveryId,
      status: 'ambiguous',
      assignmentId: optionalIds?.assignmentId ?? null,
      attemptId: optionalIds?.attemptId ?? null,
      pairId: optionalIds?.pairId ?? null,
      createdAt,
      updatedAt,
      ageMs: nowMs - (updatedAt > 0 ? updatedAt : createdAt),
      thresholdWarningMs: STALLED_WARNING_MS,
      thresholdErrorMs: STALLED_ERROR_MS,
      observationAt: nowMs,
    };
    const observation: HealthObservation = new HealthObservation({
      id: `obs_delivery_ambiguous_${deliveryId}_${nowMs}`,
      checkType: 'DELIVERY_AMBIGUOUS',
      componentType: 'delivery',
      componentId: deliveryId,
      result: 'DEGRADED',
      timestamp: nowMs,
      evidence: {
        ...evidence,
        severity: 'WARNING' as HealthSeverity,
        note: 'Ambiguous delivery: outcome unknown; retry blocked by design; not a stall',
      },
    });
    return {
      kind: 'DEGRADED',
      observation,
      evidence,
      incidentEligible: false,
      message: `Delivery ${deliveryId} ambiguous — uncertain outcome, not stalled; retry not authorized`,
    };
  }

  // Terminal states that are conclusively resolved (not ambiguous)
  const terminalHealthy: ReadonlyArray<DeliveryStatus> = ['delivered', 'failed'];
  if (terminalHealthy.includes(deliveryStatus)) {
    return { kind: 'HEALTHY', message: `Delivery terminal (${deliveryStatus})` };
  }

  // Only non-terminal in-flight states can stall
  if (deliveryStatus !== 'pending' && deliveryStatus !== 'delivering') {
    return { kind: 'HEALTHY', message: `Delivery status ${deliveryStatus} is not an in-flight stall candidate` };
  }

  // Age calculation: prefer the most recent authoritative timestamp.
  // `updatedAt` reflects the last durable transition (e.g., pending -> delivering).
  const referenceTime = updatedAt > 0 ? updatedAt : createdAt;
  const ageMs = nowMs - referenceTime;

  if (ageMs < 0) {
    return { kind: 'UNKNOWN', message: 'Negative delivery age computed; clock inconsistency' };
  }

  const evidence: DeliveryStalledEvidence = {
    deliveryId,
    status: deliveryStatus,
    assignmentId: optionalIds?.assignmentId ?? null,
    attemptId: optionalIds?.attemptId ?? null,
    pairId: optionalIds?.pairId ?? null,
    createdAt,
    updatedAt,
    ageMs,
    thresholdWarningMs: STALLED_WARNING_MS,
    thresholdErrorMs: STALLED_ERROR_MS,
    observationAt: nowMs,
  };

  // First qualifying sample: candidate only. No observation is emitted, so
  // no incident can be opened from a single (possibly flapping) sample.
  const qualifyingSampleCount = priorSample?.count ?? 0;
  if (ageMs >= STALLED_WARNING_MS && qualifyingSampleCount < 1) {
    // Still a legitimate stall candidate, so `incidentEligible` stays true: the
    // CALLER's confirmation tracker decides whether this sample is confirmed. Only
    // the ambiguous branch below is permanently ineligible, because an uncertain
    // outcome is not a stall at all.
    return {
      kind: 'DEGRADED',
      evidence,
      message: `Delivery ${deliveryId} stalled (${deliveryStatus}) for ${ageMs}ms — first qualifying sample; confirmation required before an incident is opened`,
    };
  }

  if (ageMs >= STALLED_ERROR_MS) {
    const observation: HealthObservation = new HealthObservation({
      id: `obs_stalled_${deliveryId}_${nowMs}`,
      checkType: 'DELIVERY_STALLED',
      componentType: 'delivery',
      componentId: deliveryId,
      result: 'UNHEALTHY',
      timestamp: nowMs,
      evidence: { ...evidence, severity: 'ERROR' as HealthSeverity },
    });
    return {
      kind: 'UNHEALTHY',
      observation,
      evidence,
      incidentEligible: true,
      message: `Delivery ${deliveryId} stalled (${deliveryStatus}) for ${ageMs}ms`,
    };
  }

  if (ageMs >= STALLED_WARNING_MS) {
    const observation: HealthObservation = new HealthObservation({
      id: `obs_stalled_${deliveryId}_${nowMs}`,
      checkType: 'DELIVERY_STALLED',
      componentType: 'delivery',
      componentId: deliveryId,
      result: 'DEGRADED',
      timestamp: nowMs,
      evidence: { ...evidence, severity: 'WARNING' as HealthSeverity },
    });
    return {
      kind: 'DEGRADED',
      observation,
      evidence,
      incidentEligible: true,
      message: `Delivery ${deliveryId} stalled (${deliveryStatus}) for ${ageMs}ms`,
    };
  }

  return {
    kind: 'HEALTHY',
    incidentEligible: false,
    message: `Delivery ${deliveryId} in-flight (${deliveryStatus}), age ${ageMs}ms below threshold`,
  };
}
