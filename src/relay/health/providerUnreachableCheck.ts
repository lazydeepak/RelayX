/**
 * Phase 1 — PROVIDER_UNREACHABLE detector.
 *
 * Scope: "RelayX currently needs a specific provider/runtime, and authoritative
 * observation shows the target cannot currently be contacted."
 *
 * Distinct from TRANSPORT_UNHEALTHY (a required transport operation failing) and
 * SESSION_DRIFT (identity mismatch). Reachability is its own fact.
 *
 * HONESTY: `reachable: null` means "could not check" (I-6), which is UNKNOWN and
 * must never be reported as HEALTHY.
 */
import { HealthSeverity, HealthObservation } from '../domain/healthDomain.ts';

/**
 * See `transportUnhealthyCheck.ts` for why both vocabularies are accepted.
 *
 *   `ProviderIntegrationStatus` (domain)  = 'real' | 'partial' | 'unsupported'
 *       ADAPTER CAPABILITY. 'unsupported' is a capability fact.
 *   `IntegrationStatus` (API layer)        = 'verified' | 'degraded' | 'not_detected' | 'unconfigured'
 *       RUNTIME VERIFICATION. Only 'not_detected' / 'unconfigured' mean missing.
 */
export type ProviderIntegrationStatusLike =
  | 'real' | 'partial' | 'unsupported'
  | 'verified' | 'degraded' | 'not_detected' | 'unconfigured';

export type ProviderUnreachableReasonCode =
  | 'REACHABLE'
  | 'NOT_REQUIRED'
  | 'NOT_CONFIGURED'
  | 'DISABLED'
  | 'UNREACHABLE'
  | 'OBSERVATION_UNAVAILABLE'
  | 'OBSERVATION_STALE'
  | 'IDENTITY_MISMATCH'
  | 'UNKNOWN';

export interface ProviderUnreachableEvidence {
  providerType: string;
  providerName?: string | null;
  runtimeSessionId?: string | null;
  pairId?: string | null;
  projectId?: string | null;
  integrationStatus?: string | null;
  reachabilityResult?: { reachable: boolean; reason?: string | null } | null;
  requiredForActiveWork: boolean;
  activePairCount: number;
  timestamp: number;
  confirmationCount: number;
  /** True when this sample is provider-evidenced rather than inferred. */
  authoritative: boolean;
}

export interface ProviderUnreachableResult {
  kind: ProviderUnreachableReasonCode;
  message?: string;
  observation?: HealthObservation;
  evidence?: ProviderUnreachableEvidence;
  /** False when the caller must NOT open an incident from this result. */
  incidentEligible: boolean;
}

export function evaluateProviderUnreachable(
  providerEvidence: {
    providerType: string;
    providerName?: string | null;
    integrationStatus?: ProviderIntegrationStatusLike | null;
    runtimeSessionId?: string | null;
    pairId?: string | null;
    projectId?: string | null;
    /**
     * `false` = authoritatively unreachable. `true` = reachable.
     * `null`/absent = NOT observed, which is UNKNOWN — never "reachable".
     */
    reachable?: boolean | null;
    reachabilityReason?: string | null;
    requiredForActiveWork?: boolean;
    activePairCount?: number;
    /** True when the reachability reading came from real provider observation. */
    authoritative?: boolean;
  },
  confirmationState: { count: number; firstQualifyingAt?: number },
  nowMs: number = Date.now(),
): ProviderUnreachableResult {
  const authoritative = providerEvidence.authoritative !== false;
  const required = !!providerEvidence.requiredForActiveWork;

  const buildEvidence = (
    reachability: ProviderUnreachableEvidence['reachabilityResult'],
  ): ProviderUnreachableEvidence => ({
    providerType: providerEvidence.providerType,
    providerName: providerEvidence.providerName ?? null,
    runtimeSessionId: providerEvidence.runtimeSessionId ?? null,
    pairId: providerEvidence.pairId ?? null,
    projectId: providerEvidence.projectId ?? null,
    integrationStatus: providerEvidence.integrationStatus ?? null,
    reachabilityResult: reachability,
    requiredForActiveWork: required,
    activePairCount: providerEvidence.activePairCount ?? 0,
    timestamp: nowMs,
    confirmationCount: confirmationState.count,
    authoritative,
  });

  // An unused or intentionally-disabled provider is not unhealthy.
  if (!required) {
    return {
      kind: 'NOT_REQUIRED',
      message: 'Provider not required for current active work',
      incidentEligible: false,
    };
  }

  // Integration deliberately turned off while work needs it: a real gap, not a crash.
  if (providerEvidence.integrationStatus === 'unconfigured') {
    const evidence = buildEvidence(null);
    const observation = new HealthObservation({
      id: `obs_provider_unconfigured_${providerEvidence.providerType}_${nowMs}`,
      checkType: 'PROVIDER_UNREACHABLE',
      componentType: 'provider',
      componentId: providerEvidence.providerType,
      result: 'UNHEALTHY',
      timestamp: nowMs,
      evidence: { ...evidence, severity: 'ERROR' as HealthSeverity },
    });
    return {
      kind: 'NOT_CONFIGURED',
      message: `Provider ${providerEvidence.providerType} is unconfigured but required for active work`,
      observation,
      evidence,
      incidentEligible: true,
    };
  }

  if (providerEvidence.integrationStatus === 'not_detected') {
    const evidence = buildEvidence(null);
    const observation = new HealthObservation({
      id: `obs_provider_not_detected_${providerEvidence.providerType}_${nowMs}`,
      checkType: 'PROVIDER_UNREACHABLE',
      componentType: 'provider',
      componentId: providerEvidence.providerType,
      result: 'UNHEALTHY',
      timestamp: nowMs,
      evidence: { ...evidence, severity: 'ERROR' as HealthSeverity },
    });
    return {
      kind: 'NOT_CONFIGURED',
      message: `Provider ${providerEvidence.providerType} not detected but required for active work`,
      observation,
      evidence,
      incidentEligible: true,
    };
  }

  // Authoritative unreachable while required.
  if (providerEvidence.reachable === false) {
    const evidence = buildEvidence({
      reachable: false,
      reason: providerEvidence.reachabilityReason ?? 'Provider unreachable for required work',
    });
    const observation = new HealthObservation({
      id: `obs_provider_unreachable_${providerEvidence.providerType}_${nowMs}`,
      checkType: 'PROVIDER_UNREACHABLE',
      componentType: 'provider',
      componentId: providerEvidence.providerType,
      result: 'UNHEALTHY',
      timestamp: nowMs,
      evidence: { ...evidence, severity: 'ERROR' as HealthSeverity },
    });
    return {
      kind: 'UNREACHABLE',
      message: `Provider ${providerEvidence.providerType} unreachable for required active work`,
      observation,
      evidence,
      incidentEligible: true,
    };
  }

  // Reachability never established. I-6: "could not check" is not "reachable".
  if (providerEvidence.reachable === null || providerEvidence.reachable === undefined) {
    return {
      kind: 'OBSERVATION_UNAVAILABLE',
      message:
        'Provider reachability was not observed; UNKNOWN is not HEALTHY and cannot confirm or resolve an incident',
      evidence: buildEvidence(null),
      incidentEligible: false,
    };
  }

  return {
    kind: 'REACHABLE',
    message: `Provider ${providerEvidence.providerType} reachable for required work`,
    incidentEligible: false,
  };
}
