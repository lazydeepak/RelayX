/**
 * Phase 1 — SESSION_DRIFT detector.
 *
 * Compares stored authoritative session identity (S5: PairSideIdentity,
 * runtime external session id, project association) against observed
 * identity from provider/runtime observation.
 *
 * Read-only: never rebinds, never replaces runtime, never adopts session.
 */
import { HealthObservation, HealthSeverity } from '../domain/healthDomain.ts';
import { PairSideRole, SideIdentityState, SideVerificationState, SideExistenceState } from '../domain/types.ts';

export interface SessionDriftEvidence {
  pairId?: string | null;
  projectId?: string | null;
  sideRole: PairSideRole;
  providerType?: string | null;
  runtimeSessionId?: string | null;
  expectedExternalSessionId?: string | null;
  observedExternalSessionId?: string | null;
  expectedIdentityState?: string | null;
  observedIdentityState?: string | null;
  expectedVerificationState?: string | null;
  observedVerificationState?: string | null;
  expectedExistenceState?: string | null;
  observedExistenceState?: string | null;
  existingVerdict?: string | null;
  timestamp: number;
  activeWorkAffected: boolean;
  identityMismatchDetected: boolean;
  verificationMismatchDetected: boolean;
  existenceMismatchDetected: boolean;
}

export interface SessionDriftResult {
  kind: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  message?: string;
  observation?: HealthObservation;
  evidence?: SessionDriftEvidence;
}

export function evaluateSessionDrift(
  identityData: {
    pairId?: string | null;
    projectId?: string | null;
    sideRole: PairSideRole;
    providerType?: string | null;
    runtimeSessionId?: string | null;
    // Stored authoritative identity from S5 / associations / runtime
    storedExternalSessionId?: string | null;
    storedIdentityState?: SideIdentityState | null;
    storedVerificationState?: SideVerificationState | null;
    storedExistenceState?: SideExistenceState | null;
    // Observed identity from runtime/provider observation
    observedExternalSessionId?: string | null;
    observedIdentityState?: SideIdentityState | null;
    observedVerificationState?: SideVerificationState | null;
    observedExistenceState?: SideExistenceState | null;
    // Existing RelayX verdict/state if available
    existingVerdict?: string | null;
    activeWorkAffected?: boolean;
  },
  nowMs: number = Date.now(),
): SessionDriftResult {
  // If both expected and observed external session ids are present and differ,
  // that is an authoritative identity mismatch — not an observation absence.
  const identityMismatchById =
    identityData.storedExternalSessionId != null &&
    identityData.storedExternalSessionId !== undefined &&
    identityData.observedExternalSessionId != null &&
    identityData.observedExternalSessionId !== undefined &&
    identityData.observedExternalSessionId !== identityData.storedExternalSessionId;

  // Unknown: missing authoritative pair or session context required for comparison
  if (!identityData.pairId && !identityData.runtimeSessionId) {
    return { kind: 'UNKNOWN', message: 'Insufficient authoritative session identity to evaluate drift: missing pair or runtime binding' };
  }

  // If no observed identity can be established, this is not drift — it is absence of observation.
  // Per freeze rules (§10.3): absent row honestly means "never activated, nothing known".
  // Unknown is not mismatch.
  if (
    identityData.observedIdentityState === 'unknown' ||
    identityData.observedIdentityState === undefined ||
    identityData.observedIdentityState === null
  ) {
    // Exception: when the external session id comparison itself is authoritative and shows mismatch,
    // do not suppress it as UNKNOWN.
    if (!identityMismatchById) {
      return { kind: 'UNKNOWN', message: 'Session identity observation unavailable; no authoritative observed identity for comparison' };
    }
  }

  const identityMismatch =
    identityData.storedExternalSessionId !== null &&
    identityData.storedExternalSessionId !== undefined &&
    identityData.observedExternalSessionId !== identityData.storedExternalSessionId;

  const verificationMismatch =
    identityData.storedVerificationState === 'verified' &&
    identityData.observedVerificationState === 'mismatched';

  const existenceMismatch =
    identityData.storedExistenceState === 'present' &&
    identityData.observedExistenceState === 'absent';

  const mismatchDetected = identityMismatch || verificationMismatch || existenceMismatch;

  if (!mismatchDetected) {
    return { kind: 'HEALTHY', message: 'Authoritative session identity matches observed identity' };
  }

  const evidence: SessionDriftEvidence = {
    pairId: identityData.pairId ?? null,
    projectId: identityData.projectId ?? null,
    sideRole: identityData.sideRole,
    providerType: identityData.providerType ?? null,
    runtimeSessionId: identityData.runtimeSessionId ?? null,
    expectedExternalSessionId: identityData.storedExternalSessionId ?? null,
    observedExternalSessionId: identityData.observedExternalSessionId ?? null,
    expectedIdentityState: identityData.storedIdentityState ?? null,
    observedIdentityState: identityData.observedIdentityState ?? null,
    expectedVerificationState: identityData.storedVerificationState ?? null,
    observedVerificationState: identityData.observedVerificationState ?? null,
    expectedExistenceState: identityData.storedExistenceState ?? null,
    observedExistenceState: identityData.observedExistenceState ?? null,
    existingVerdict: identityData.existingVerdict ?? null,
    timestamp: nowMs,
    activeWorkAffected: !!identityData.activeWorkAffected,
    identityMismatchDetected: !!identityMismatch,
    verificationMismatchDetected: !!verificationMismatch,
    existenceMismatchDetected: !!existenceMismatch,
  };

  const severity: HealthSeverity = identityData.activeWorkAffected ? 'ERROR' : 'WARNING';

  const observation = new HealthObservation({
    id: `obs_session_drift_${identityData.pairId ?? identityData.runtimeSessionId ?? 'unknown'}_${nowMs}`,
    checkType: 'SESSION_DRIFT',
    componentType: 'session_pair',
    componentId: identityData.pairId ?? identityData.runtimeSessionId ?? 'unknown',
    result: identityData.activeWorkAffected ? 'UNHEALTHY' : 'DEGRADED',
    timestamp: nowMs,
    evidence: { ...evidence, severity },
  });

  let message: string;
  if (identityMismatch) {
    message = `Session identity drift: expected external session '${identityData.storedExternalSessionId ?? 'none'}' vs observed '${identityData.observedExternalSessionId ?? 'none'}'`;
  } else if (verificationMismatch) {
    message = `Session verification drift: expected verification '${identityData.storedVerificationState ?? 'none'}' vs observed '${identityData.observedVerificationState ?? 'none'}'`;
  } else if (existenceMismatch) {
    message = `Session existence drift: expected existence '${identityData.storedExistenceState ?? 'none'}' vs observed '${identityData.observedExistenceState ?? 'none'}'`;
  } else {
    message = 'Session identity mismatch detected';
  }

  return {
    kind: identityData.activeWorkAffected ? 'UNHEALTHY' : 'DEGRADED',
    observation,
    evidence,
    message,
  };
}
