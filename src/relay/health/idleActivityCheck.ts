/**
 * Phase 1 — UNEXPECTED_IDLE_ACTIVITY detector.
 *
 * Light-weight event-driven observation of expensive RelayX operations.
 * Only observes existing operations; does not trigger new ones.
 */

import { HealthObservation, HealthSeverity } from '../domain/healthDomain.ts';
import { PairOperationalState } from '../domain/types.ts';

export const UNEXPECTED_IDLE_ACTIVITY_WARNING_MS = 10_000; // Activity duration threshold for warning

export interface IdleActivityEvidence {
  operationName: string;
  activityCategory: string;
  timestamp: number;
  hasActivePair: boolean;
  hasActiveAssignment: boolean;
  pairCount: number;
  activePairCount: number;
}

export interface UnexpectedIdleResult {
  kind: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  message?: string;
  observation?: HealthObservation;
  evidence?: IdleActivityEvidence;
}

/** Determine whether RelayX has legitimate work justifying external activity. */
export function hasLegitimateActiveWork(
  pairOperationalStates: string[],
  hasActiveAssignment: boolean,
): boolean {
  // Active work exists if any pair is ACTIVE or there is an active assignment in progress.
  const hasActivePair = pairOperationalStates.some((state) => state === 'ACTIVE');
  return hasActivePair || hasActiveAssignment;
}

/**
 * Evaluate unexpected idle activity.
 *
 * This detector is called with evidence of an expensive operation that just occurred.
 * It compares that against the current authoritative RelayX work state.
 */
export function evaluateUnexpectedIdleActivity(
  operationName: string,
  activityCategory: string,
  evidenceTimestamp: number,
  currentOperationalState: {
    pairOperationalStates: string[];
    hasActiveAssignment: boolean;
    pairCount: number;
    activePairCount: number;
    activeAssignmentCount: number;
  },
): UnexpectedIdleResult {
  const legitimate = hasLegitimateActiveWork(
    currentOperationalState.pairOperationalStates,
    currentOperationalState.hasActiveAssignment,
  );

  if (legitimate) {
    return { kind: 'HEALTHY', message: `Expensive operation ${operationName} justified by active work` };
  }

  const evidence: IdleActivityEvidence = {
    operationName,
    activityCategory,
    timestamp: evidenceTimestamp,
    hasActivePair: currentOperationalState.activePairCount > 0,
    hasActiveAssignment: currentOperationalState.hasActiveAssignment,
    pairCount: currentOperationalState.pairCount,
    activePairCount: currentOperationalState.activePairCount,
  };

  const observation = new HealthObservation({
    id: `obs_idle_${operationName}_${evidenceTimestamp}`,
    checkType: 'UNEXPECTED_IDLE_ACTIVITY',
    componentType: 'supervision',
    componentId: 'idle_monitor',
    result: 'DEGRADED',
    timestamp: evidenceTimestamp,
    evidence: { ...evidence, severity: 'WARNING' as HealthSeverity, note: 'Expensive operation while no active work requires external contact' },
  });

  return {
    kind: 'DEGRADED',
    observation,
    evidence,
    message: `Unexpected idle activity: ${operationName} (${activityCategory}) with no active pairs/assignments`,
  };
}
