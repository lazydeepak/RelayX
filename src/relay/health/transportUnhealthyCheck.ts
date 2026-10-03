/**
 * Phase 1 — TRANSPORT_UNHEALTHY detector.
 *
 * Scope: "RelayX currently requires a specific transport operation to proceed,
 * and recent authoritative evidence shows that transport is failing."
 *
 * Triggered by existing transport/delivery failure evidence. No continuous
 * provider polling. Read-only with respect to Delivery, Pair, Runtime and
 * provider dispatch behaviour.
 *
 * PRECEDENCE: when authoritative reachability evidence already explains the
 * transport failure (`providerReachable === false`), PROVIDER_UNREACHABLE owns the
 * root cause and this rule DEFERS instead of opening a second, redundant incident.
 */
import { HealthObservation, HealthSeverity } from '../domain/healthDomain.ts';
import type { TransportReconciliationClassification } from '../providers/exactSessionReconciliation.ts';

export const TRANSPORT_UNHEALTHY_WARNING_MS = 30_000; // Policy default

/**
 * RelayX has TWO distinct integration vocabularies and this rule must not conflate
 * them:
 *
 *   `ProviderIntegrationStatus` (domain)  = 'real' | 'partial' | 'unsupported'
 *       ADAPTER CAPABILITY — what this integration is technically able to do.
 *       'unsupported' here is a capability fact, not a configuration fault.
 *
 *   `IntegrationStatus` (API layer)        = 'verified' | 'degraded' | 'not_detected' | 'unconfigured'
 *       RUNTIME VERIFICATION — whether this integration is set up and working here.
 *       Only 'not_detected' / 'unconfigured' from this vocabulary mean the provider
 *       is genuinely missing for required work.
 *
 * Both are accepted; each is interpreted only in its own sense.
 */
export type TransportIntegrationStatus =
  | 'real' | 'partial' | 'unsupported'
  | 'verified' | 'degraded' | 'not_detected' | 'unconfigured';

export type TransportReasonCode =
  | 'REACHABLE'
  | 'NOT_REQUIRED'
  | 'NOT_CONFIGURED'
  | 'DISABLED'
  | 'UNREACHABLE'
  | 'FAILED'
  | 'AMBIGUOUS'
  | 'IDENTITY_MISMATCH'
  | 'DEFERS_TO_PROVIDER_UNREACHABLE'
  | 'UNKNOWN';

export interface TransportUnhealthyEvidence {
  deliveryId?: string | null;
  assignmentId?: string | null;
  pairId?: string | null;
  providerType?: string | null;
  transportOperation: string;
  transportOutcome: TransportReconciliationClassification | 'failed' | 'timeout' | 'unsupported';
  reason?: string | null;
  timestamp: number;
  activeWorkBlocked: boolean;
  providerIntegrationStatus?: TransportIntegrationStatus;
  providerReachable?: boolean | null;
  /** True when the evidence is authoritative rather than provisional. */
  authoritative: boolean;
}

export interface TransportUnhealthyResult {
  kind: TransportReasonCode;
  message?: string;
  observation?: HealthObservation;
  evidence?: TransportUnhealthyEvidence;
  /**
   * False when the caller must NOT open a TRANSPORT_UNHEALTHY incident, either
   * because the condition is absent or because another rule owns it.
   */
  incidentEligible: boolean;
}

export function evaluateTransportUnhealthy(
  transportEvidence: {
    deliveryStatus?: 'pending' | 'delivering' | 'delivered' | 'ambiguous' | 'failed';
    reconciliationOutcome?: TransportReconciliationClassification;
    providerStatus?: TransportIntegrationStatus;
    /**
     * `false` = authoritatively unreachable. `true` = reachable.
     * `null`/absent = NOT observed (I-6), which is UNKNOWN, never "reachable".
     */
    providerReachable?: boolean | null;
    hasActiveWork: boolean;
    activePairId?: string | null;
    assignmentId?: string | null;
    deliveryId?: string | null;
    /** True when the transport result is provider-evidenced rather than inferred. */
    authoritative?: boolean;
  },
  nowMs: number = Date.now(),
): TransportUnhealthyResult {
  const authoritative = transportEvidence.authoritative !== false;
  const ev = (
    operation: string,
    outcome: TransportUnhealthyEvidence['transportOutcome'],
    reason: string | null,
  ): TransportUnhealthyEvidence => ({
    deliveryId: transportEvidence.deliveryId ?? null,
    assignmentId: transportEvidence.assignmentId ?? null,
    pairId: transportEvidence.activePairId ?? null,
    providerType: null,
    transportOperation: operation,
    transportOutcome: outcome,
    reason,
    timestamp: nowMs,
    activeWorkBlocked: transportEvidence.hasActiveWork,
    providerIntegrationStatus: transportEvidence.providerStatus,
    providerReachable: transportEvidence.providerReachable ?? null,
    authoritative,
  });

  // Transport is irrelevant: no work requires it. Never an incident.
  if (!transportEvidence.hasActiveWork) {
    return { kind: 'NOT_REQUIRED', message: 'No active work requires transport', incidentEligible: false };
  }

  // PRECEDENCE — a known provider outage already explains this transport failure.
  // PROVIDER_UNREACHABLE owns the root cause; opening TRANSPORT_UNHEALTHY too
  // would report the same outage twice.
  if (transportEvidence.providerReachable === false) {
    return {
      kind: 'DEFERS_TO_PROVIDER_UNREACHABLE',
      message:
        'Transport failure is explained by an unreachable provider; PROVIDER_UNREACHABLE owns this root cause',
      evidence: ev('provider_contact', 'unsupported', 'Provider unreachable explains the transport result'),
      incidentEligible: false,
    };
  }

  // The provider integration is genuinely missing for a role this transport needs.
  // Only the RUNTIME VERIFICATION vocabulary counts here: an adapter reporting
  // 'unsupported' is a capability statement, not a missing installation, and must
  // not be escalated into an incident.
  if (
    transportEvidence.providerStatus === 'unconfigured' ||
    transportEvidence.providerStatus === 'not_detected'
  ) {
    const evidence = ev('provider_contact', 'unsupported', `Provider integration status: ${transportEvidence.providerStatus}`);
    const observation = new HealthObservation({
      id: `obs_transport_not_configured_${transportEvidence.activePairId ?? 'unknown'}_${nowMs}`,
      checkType: 'TRANSPORT_UNHEALTHY',
      componentType: 'transport',
      componentId: transportEvidence.activePairId ?? 'unknown_pair',
      result: 'UNHEALTHY',
      timestamp: nowMs,
      evidence: { ...evidence, severity: 'ERROR' as HealthSeverity },
    });
    return {
      kind: 'NOT_CONFIGURED',
      message: `Provider integration not configured for required transport (${transportEvidence.providerStatus})`,
      observation,
      evidence,
      incidentEligible: true,
    };
  }

  // Ambiguous outcome: uncertain, retry stays blocked. Never a failure verdict.
  if (
    transportEvidence.reconciliationOutcome === 'ambiguous' ||
    transportEvidence.deliveryStatus === 'ambiguous'
  ) {
    const evidence = ev('dispatch_reconciliation', 'ambiguous', 'Transport outcome uncertain; retry blocked by design');
    const observation = new HealthObservation({
      id: `obs_transport_ambiguous_${transportEvidence.activePairId ?? 'unknown'}_${nowMs}`,
      checkType: 'TRANSPORT_UNHEALTHY',
      componentType: 'transport',
      componentId: transportEvidence.activePairId ?? 'unknown_pair',
      result: 'DEGRADED',
      timestamp: nowMs,
      evidence: {
        ...evidence,
        severity: 'WARNING' as HealthSeverity,
        note: 'Ambiguous transport outcome; no retry authorization',
      },
    });
    return {
      kind: 'AMBIGUOUS',
      message: 'Transport ambiguous — outcome uncertain; retry blocked',
      observation,
      evidence,
      incidentEligible: true,
    };
  }

  // Transport itself failed while the provider is reachable.
  if (
    transportEvidence.reconciliationOutcome === 'not_delivered' ||
    transportEvidence.deliveryStatus === 'failed'
  ) {
    const evidence = ev('dispatch', 'not_delivered', 'Transport delivery failed for active work');
    const observation = new HealthObservation({
      id: `obs_transport_failed_${transportEvidence.activePairId ?? 'unknown'}_${nowMs}`,
      checkType: 'TRANSPORT_UNHEALTHY',
      componentType: 'transport',
      componentId: transportEvidence.activePairId ?? 'unknown_pair',
      result: 'UNHEALTHY',
      timestamp: nowMs,
      evidence: { ...evidence, severity: 'ERROR' as HealthSeverity },
    });
    return {
      kind: 'FAILED',
      message: `Transport failed for active work (pair: ${transportEvidence.activePairId ?? 'unknown'})`,
      observation,
      evidence,
      incidentEligible: true,
    };
  }

  // Reachability was never established. "Could not check" is not "healthy" (I-6).
  if (transportEvidence.providerReachable === null || transportEvidence.providerReachable === undefined) {
    if (
      transportEvidence.reconciliationOutcome === undefined &&
      transportEvidence.deliveryStatus === undefined
    ) {
      return {
        kind: 'UNKNOWN',
        message: 'No transport outcome and no reachability evidence available',
        incidentEligible: false,
      };
    }
  }

  return {
    kind: 'REACHABLE',
    message: 'Transport healthy for current work requirements',
    incidentEligible: false,
  };
}
