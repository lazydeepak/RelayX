/**
 * Pure Domain Continuity & Checkpoint Evaluation
 *
 * Implements the frozen continuity evaluation rules from
 * DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §6.1-§6.5 and §1.2 (I-6, I-7)
 * with the authorized S3 corrections:
 *
 * 1. Checkpoint is the mandatory comparison baseline.
 *    - Checkpoint absent => side continuity is strictly 'unknown'.
 *    - Existing provider messages do not prove advancement relative to RelayX
 *      because they may predate the Pair/baseline.
 *    - To establish a baseline, an explicit operator initial-baseline operation is required.
 *    - A Pair remains UNKNOWN while either side lacks a usable checkpoint.
 *
 * 2. Stable identity is NOT ordering:
 *    - Trustworthy ordinal on checkpoint + observation:
 *        obs.ordinal > checkpoint.ordinal  => advanced
 *        obs.ordinal = checkpoint.ordinal  => unchanged
 *        obs.ordinal < checkpoint.ordinal  => unknown
 *    - Stable ref without trustworthy ordering:
 *        obs.ref = checkpoint.ref          => unchanged
 *        obs.ref != checkpoint.ref         => unknown
 *      (A message reference proves identity, not ordering. S3 must not
 *       manufacture ordering from unequal identifiers.)
 */

import {
  PairSideIdentity,
  PairSideCheckpoint,
  SideContinuityEvaluation,
  PairContinuityResult,
  PairAdvanceState,
  PairSideRole,
  PairId,
} from './types.ts';

/**
 * Pure evaluation of one bound side's continuity relative to its latest checkpoint baseline.
 */
export function evaluateSideContinuity(
  sideRole: PairSideRole,
  observation: PairSideIdentity | null,
  checkpoint: PairSideCheckpoint | null,
): SideContinuityEvaluation {
  // Missing baseline rule: checkpoint absent => side continuity is strictly unknown.
  if (!checkpoint) {
    return {
      sideRole,
      state: 'unknown',
      determinacy: 'unverified',
      checkpointId: null,
      checkpointOrdinal: null,
      checkpointRef: null,
      observedOrdinal: observation?.observation?.message?.ordinal ?? null,
      observedRef: observation?.observation?.message?.ref ?? null,
      reason: 'No checkpoint baseline exists for this side; continuity cannot be determined.',
    };
  }

  // Checkpoint exists, but observation is absent.
  if (!observation || !observation.observation) {
    return {
      sideRole,
      state: 'unknown',
      determinacy: 'unverified',
      checkpointId: checkpoint.id,
      checkpointOrdinal: checkpoint.messageOrdinal,
      checkpointRef: checkpoint.messageRef,
      observedOrdinal: null,
      observedRef: null,
      reason: 'Checkpoint baseline exists, but side has no durable observation.',
    };
  }

  const obsReading = observation.observation;
  const observedOrdinal = obsReading.message.ordinal;
  const observedRef = obsReading.message.ref;

  // Unreachable check: honest degradation.
  if (obsReading.reachabilityState === 'unreachable') {
    return {
      sideRole,
      state: 'unknown',
      determinacy: 'unverified',
      checkpointId: checkpoint.id,
      checkpointOrdinal: checkpoint.messageOrdinal,
      checkpointRef: checkpoint.messageRef,
      observedOrdinal,
      observedRef,
      reason: 'Side is currently unreachable; external position cannot be verified.',
    };
  }

  // Evidence state check: unknown evidence.
  if (obsReading.messageEvidenceState === 'unknown') {
    return {
      sideRole,
      state: 'unknown',
      determinacy: 'unverified',
      checkpointId: checkpoint.id,
      checkpointOrdinal: checkpoint.messageOrdinal,
      checkpointRef: checkpoint.messageRef,
      observedOrdinal,
      observedRef,
      reason: obsReading.reason ?? 'Message evidence state is unknown.',
    };
  }

  // Empty state check: both sides report zero messages.
  if (
    obsReading.messageEvidenceState === 'none' &&
    checkpoint.messageRef === null &&
    checkpoint.messageOrdinal === null
  ) {
    return {
      sideRole,
      state: 'unchanged',
      determinacy: 'identified',
      checkpointId: checkpoint.id,
      checkpointOrdinal: null,
      checkpointRef: null,
      observedOrdinal: null,
      observedRef: null,
      reason: 'Both checkpoint baseline and observation record no messages.',
    };
  }

  // Observation reports none, but checkpoint had recorded messages (anomalous regression/deletion).
  if (
    obsReading.messageEvidenceState === 'none' &&
    (checkpoint.messageRef !== null || checkpoint.messageOrdinal !== null)
  ) {
    return {
      sideRole,
      state: 'unknown',
      determinacy: 'unverified',
      checkpointId: checkpoint.id,
      checkpointOrdinal: checkpoint.messageOrdinal,
      checkpointRef: checkpoint.messageRef,
      observedOrdinal: null,
      observedRef: null,
      reason: 'Observation reports no messages but checkpoint recorded message evidence; cannot determine continuity.',
    };
  }

  // LEVEL 0 check: provider has no ordering and no stable refs.
  if (observedOrdinal === null && observedRef === null) {
    return {
      sideRole,
      state: 'unknown',
      determinacy: 'unverified',
      checkpointId: checkpoint.id,
      checkpointOrdinal: checkpoint.messageOrdinal,
      checkpointRef: checkpoint.messageRef,
      observedOrdinal: null,
      observedRef: null,
      reason: 'Provider supplies no message ref and no ordinal; position is indeterminate (Level 0).',
    };
  }

  // Branch 1: Trustworthy ordinal on checkpoint + observation
  if (observedOrdinal !== null && checkpoint.messageOrdinal !== null) {
    if (observedOrdinal > checkpoint.messageOrdinal) {
      return {
        sideRole,
        state: 'advanced',
        determinacy: 'identified',
        checkpointId: checkpoint.id,
        checkpointOrdinal: checkpoint.messageOrdinal,
        checkpointRef: checkpoint.messageRef,
        observedOrdinal,
        observedRef,
        reason: `Observed ordinal ${observedOrdinal} is strictly greater than checkpoint ordinal ${checkpoint.messageOrdinal}.`,
      };
    }
    if (observedOrdinal === checkpoint.messageOrdinal) {
      return {
        sideRole,
        state: 'unchanged',
        determinacy: 'identified',
        checkpointId: checkpoint.id,
        checkpointOrdinal: checkpoint.messageOrdinal,
        checkpointRef: checkpoint.messageRef,
        observedOrdinal,
        observedRef,
        reason: `Observed ordinal ${observedOrdinal} matches checkpoint ordinal ${checkpoint.messageOrdinal}.`,
      };
    }
    // observedOrdinal < checkpoint.messageOrdinal
    return {
      sideRole,
      state: 'unknown',
      determinacy: 'unverified',
      checkpointId: checkpoint.id,
      checkpointOrdinal: checkpoint.messageOrdinal,
      checkpointRef: checkpoint.messageRef,
      observedOrdinal,
      observedRef,
      reason: `Observed ordinal ${observedOrdinal} is less than checkpoint ordinal ${checkpoint.messageOrdinal} (anomalous regressive ordinal).`,
    };
  }

  // Branch 2: Stable ref without trustworthy ordering
  if (observedRef !== null && checkpoint.messageRef !== null) {
    if (observedRef === checkpoint.messageRef) {
      return {
        sideRole,
        state: 'unchanged',
        determinacy: 'identified',
        checkpointId: checkpoint.id,
        checkpointOrdinal: checkpoint.messageOrdinal,
        checkpointRef: checkpoint.messageRef,
        observedOrdinal,
        observedRef,
        reason: `Observed message ref '${observedRef}' matches checkpoint message ref.`,
      };
    }
    // observedRef !== checkpoint.messageRef
    // Correction 1: stable identity is NOT ordering. Differing refs without trustworthy ordinal => unknown.
    return {
      sideRole,
      state: 'unknown',
      determinacy: 'unverified',
      checkpointId: checkpoint.id,
      checkpointOrdinal: checkpoint.messageOrdinal,
      checkpointRef: checkpoint.messageRef,
      observedOrdinal,
      observedRef,
      reason: `Observed message ref '${observedRef}' differs from checkpoint '${checkpoint.messageRef}', but no trustworthy ordinal is available; cannot infer advancement from identity alone.`,
    };
  }

  // Mismatched markers (one has ordinal/ref, the other does not).
  return {
    sideRole,
    state: 'unknown',
    determinacy: 'unverified',
    checkpointId: checkpoint.id,
    checkpointOrdinal: checkpoint.messageOrdinal,
    checkpointRef: checkpoint.messageRef,
    observedOrdinal,
    observedRef,
    reason: 'Incomparable position markers between checkpoint and observation.',
  };
}

/**
 * Pure composite classification of Session Pair continuity from the two side evaluations.
 */
export function classifyPairContinuity(
  pairId: PairId,
  planner: SideContinuityEvaluation,
  worker: SideContinuityEvaluation,
  computedAt: number = Date.now(),
): PairContinuityResult {
  // If either side is unknown, the whole Pair is UNKNOWN.
  if (planner.state === 'unknown' || worker.state === 'unknown') {
    return {
      sessionPairId: pairId,
      state: 'UNKNOWN',
      computedAt,
      planner,
      worker,
    };
  }

  if (planner.state === 'advanced' && worker.state === 'advanced') {
    return {
      sessionPairId: pairId,
      state: 'BOTH_ADVANCED',
      computedAt,
      planner,
      worker,
    };
  }

  if (planner.state === 'advanced' && worker.state === 'unchanged') {
    return {
      sessionPairId: pairId,
      state: 'PLANNER_ADVANCED',
      computedAt,
      planner,
      worker,
    };
  }

  if (planner.state === 'unchanged' && worker.state === 'advanced') {
    return {
      sessionPairId: pairId,
      state: 'WORKER_ADVANCED',
      computedAt,
      planner,
      worker,
    };
  }

  // Both unchanged
  return {
    sessionPairId: pairId,
    state: 'UNCHANGED',
    computedAt,
    planner,
    worker,
  };
}
