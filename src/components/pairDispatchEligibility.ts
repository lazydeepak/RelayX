import { UIPair } from '../types/ui.ts';

export interface PairDispatchEligibility {
  /** Whether the UI may offer a dispatch action at all. */
  eligible: boolean;
  /** True specifically when an ambiguous delivery blocks the dispatch. */
  ambiguous: boolean;
  /** Human-readable explanation, shown when not eligible. */
  reason?: string;
}

/**
 * UI projection of the engine's dispatch preconditions.
 *
 * This is NOT a dispatch authority. `RelayEngine.dispatchAssignment` remains the
 * authority and is unchanged. This function only mirrors the two delivery states
 * that the engine's Phase-1 guard already refuses:
 *
 *   - `ambiguous`  → `AmbiguousDeliveryResendError` (automated resend blocked)
 *   - `delivering` → `DuplicateDeliveryAttemptError` (a send is already in flight)
 *
 * It reads the authoritative `pair.deliveryStatus` that `listPairs` already
 * projects from the active assignment's active delivery, so the UI never offers a
 * dispatch the engine would reject. `delivered` and `failed` are NOT blocking:
 * the engine permits a fresh attempt for those, and so must the UI.
 */
export function resolvePairDispatchEligibility(
  pair: Pick<UIPair, 'deliveryStatus'>,
): PairDispatchEligibility {
  if (pair.deliveryStatus === 'ambiguous') {
    return {
      eligible: false,
      ambiguous: true,
      reason:
        'Ambiguous delivery — automated resend is blocked until it is reconciled in Attention & Recovery.',
    };
  }
  if (pair.deliveryStatus === 'delivering') {
    return {
      eligible: false,
      ambiguous: false,
      reason: 'A delivery is already in flight for this assignment.',
    };
  }
  return { eligible: true, ambiguous: false };
}

export interface CreateAssignmentEligibility {
  /** Whether Create & Dispatch may be offered for the selected Pair. */
  eligible: boolean;
  /** True when the block is the Pair's unresolved active Assignment. */
  blockedByActiveAssignment: boolean;
  activeAssignmentId?: string;
  activeAssignmentTitle?: string;
  reason?: string;
}

/**
 * UI projection of the execution-slot precondition for Create & Dispatch.
 *
 * A Pair owns at most ONE unresolved active Assignment. `listPairs` sets
 * `activeAssignmentStatus` ONLY for a non-terminal holder (`pending`, `active`,
 * `waiting_for_handoff`), so `activeAssignmentId && activeAssignmentStatus` is the
 * authoritative "already owns active work" signal. A terminal/dangling holder is
 * NOT a block: the engine repairs it, so the UI must not refuse either.
 *
 * The application command (`createAndDispatchAssignment`) re-checks this before
 * anything is durable, so this projection is convenience, never authority.
 */
export function resolveCreateAssignmentEligibility(
  pair:
    | Pick<UIPair, 'activeAssignmentId' | 'activeAssignmentStatus' | 'activeAssignmentTitle'>
    | undefined,
): CreateAssignmentEligibility {
  if (!pair) {
    return {
      eligible: false,
      blockedByActiveAssignment: false,
      reason: 'Select a Pair before dispatching work.',
    };
  }
  if (pair.activeAssignmentId && pair.activeAssignmentStatus) {
    return {
      eligible: false,
      blockedByActiveAssignment: true,
      activeAssignmentId: pair.activeAssignmentId,
      activeAssignmentTitle: pair.activeAssignmentTitle,
      reason:
        'This Pair already has an active assignment. Complete, fail, cancel, retry, or reconcile it before dispatching new work.',
    };
  }
  return { eligible: true, blockedByActiveAssignment: false };
}
