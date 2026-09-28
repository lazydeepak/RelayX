/**
 * Phase D — Derived Readiness Evaluation
 *
 * Answers whether a Pair is currently safe and sufficiently verified
 * for operations, derived entirely from persisted local state and continuity
 * with zero provider contact.
 */

import {
  PairSideIdentity,
  PairContinuityResult,
  PairOperationalState,
} from './types.ts';
import {
  Pair,
  RuntimeSession,
} from './entities.ts';

export type PairReadinessState = 'READY' | 'NOT_READY' | 'UNKNOWN';

export interface PairReadinessAssessment {
  state: PairReadinessState;
  reasons: string[];
  operationalState: PairOperationalState;
  continuityState: PairContinuityResult['state'] | null;
  hasBothSidesBound: boolean;
  identityVerified: boolean;
}

/**
 * Pure domain evaluation of Pair readiness.
 */
export function evaluatePairReadiness(
  pair: Pair,
  plannerSession: RuntimeSession | null,
  workerSession: RuntimeSession | null,
  plannerIdentity: PairSideIdentity | null,
  workerIdentity: PairSideIdentity | null,
  continuity: PairContinuityResult | null,
): PairReadinessAssessment {
  const reasons: string[] = [];
  const operationalState = pair.operationalState;
  const hasBothSidesBound = Boolean(pair.plannerSessionId && pair.workerSessionId);
  
  if (!hasBothSidesBound) {
    return {
      state: 'NOT_READY',
      reasons: ['Pair does not have both a Planner and a Worker session bound.'],
      operationalState,
      continuityState: continuity?.state ?? null,
      hasBothSidesBound: false,
      identityVerified: false,
    };
  }

  if (operationalState !== 'ACTIVE') {
    return {
      state: 'NOT_READY',
      reasons: ['Pair is IDLE; provider contact and active operations are not permitted (DESIGN_FREEZE I-2).'],
      operationalState,
      continuityState: continuity?.state ?? null,
      hasBothSidesBound: true,
      identityVerified: false,
    };
  }

  if (!plannerSession || !workerSession) {
    return {
      state: 'NOT_READY',
      reasons: ['Bound runtime sessions could not be found in local persistence.'],
      operationalState,
      continuityState: continuity?.state ?? null,
      hasBothSidesBound: true,
      identityVerified: false,
    };
  }

  const plannerVerification = plannerIdentity?.verificationState ?? 'unknown';
  const workerVerification = workerIdentity?.verificationState ?? 'unknown';

  const identityVerified =
    plannerVerification === 'verified' && workerVerification === 'verified';

  if (plannerVerification === 'mismatched' || workerVerification === 'mismatched') {
    return {
      state: 'NOT_READY',
      reasons: ['One or both bound session identities mismatched the authoritative provider record.'],
      operationalState,
      continuityState: continuity?.state ?? null,
      hasBothSidesBound: true,
      identityVerified: false,
    };
  }

  const plannerExistence = plannerIdentity?.existenceState ?? 'unknown';
  const workerExistence = workerIdentity?.existenceState ?? 'unknown';

  if (plannerExistence === 'absent' || workerExistence === 'absent') {
    return {
      state: 'NOT_READY',
      reasons: ['One or both bound session identities are absent in the authoritative provider store (e.g., session deleted, archived, or missing from provider scope).'],
      operationalState,
      continuityState: continuity?.state ?? null,
      hasBothSidesBound: true,
      identityVerified: false,
    };
  }

  const continuityState = continuity?.state ?? 'UNKNOWN';

  if (continuityState === 'UNKNOWN') {
    return {
      state: 'UNKNOWN',
      reasons: ['Pair continuity is UNKNOWN (missing checkpoints or unverified observations).'],
      operationalState,
      continuityState: 'UNKNOWN',
      hasBothSidesBound: true,
      identityVerified,
    };
  }

  if (continuityState === 'BOTH_ADVANCED') {
    return {
      state: 'NOT_READY',
      reasons: ['Pair is BOTH_ADVANCED; explicit operator acknowledgment/reconciliation is required before active operations can proceed.'],
      operationalState,
      continuityState: 'BOTH_ADVANCED',
      hasBothSidesBound: true,
      identityVerified,
    };
  }

  return {
    state: 'READY',
    reasons: ['Pair is ACTIVE, fully bound, identities are sound, and continuity is reconciled.'],
    operationalState,
    continuityState,
    hasBothSidesBound: true,
    identityVerified,
  };
}
