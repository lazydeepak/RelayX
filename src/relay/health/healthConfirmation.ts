/**
 * Phase 1 health — shared confirmation/debounce tracking.
 *
 * Each detector has a DIFFERENT confirmation policy by design. This module makes
 * those policies explicit and testable instead of collapsing them into one
 * universal "two samples" rule.
 *
 *   UNEXPECTED_IDLE_ACTIVITY  repetition required; explicit user action never confirms
 *   TRANSPORT_UNHEALTHY       repetition required, UNLESS one authoritative failure
 *                            blocks active work (immediate confirm allowed)
 *   PROVIDER_UNREACHABLE      repetition required, UNLESS one authoritative
 *                            unreachable result blocks active work (immediate allowed)
 *   SESSION_DRIFT             strong authoritative mismatch confirms immediately;
 *                            provisional evidence requires a second consistent sample
 *
 * Confirmation state is intentionally in-memory and non-durable. The consequence
 * is benign: after a restart a condition must re-confirm before an incident opens,
 * which can only DELAY detection, never fabricate one.
 */

export type ConfirmationPolicy =
  | 'repetition_only'
  | 'repetition_or_blocking_authoritative'
  | 'immediate_if_authoritative';

export interface ConfirmationState {
  /** Number of consecutive qualifying samples observed so far. */
  count: number;
  /** Timestamp of the first qualifying sample in the current run. */
  firstQualifyingAt?: number;
  /** Timestamp of the most recent qualifying sample. */
  lastQualifyingAt?: number;
}

export interface ConfirmationInput {
  /** Stable identity for the condition being confirmed. */
  key: string;
  /** The policy this detector is allowed to apply. */
  policy: ConfirmationPolicy;
  /** True when this sample itself qualifies as unhealthy. */
  qualifying: boolean;
  /** True when the evidence is authoritative (not provisional/weak). */
  authoritative: boolean;
  /** True when active work is blocked by this condition. */
  blocksActiveWork: boolean;
  /** True when an explicit operator action explains this sample. */
  operatorInitiated?: boolean;
  nowMs: number;
}

export interface ConfirmationOutcome {
  /** True when an incident may now be created/updated. */
  confirmed: boolean;
  /** The state after applying this sample. */
  state: ConfirmationState;
  /** Why this outcome, for evidence and debugging. */
  reason: string;
}

export class HealthConfirmationTracker {
  private readonly states = new Map<string, ConfirmationState>();

  /** Read-only view of current candidates. */
  get(key: string): ConfirmationState | undefined {
    const s = this.states.get(key);
    return s ? { ...s } : undefined;
  }

  size(): number {
    return this.states.size;
  }

  clear(): void {
    this.states.clear();
  }

  /**
   * Explicitly drop a candidate without recording a healthy sample. Used when a
   * condition becomes irrelevant (component deleted, Pair detached) rather than
   * when it recovered.
   */
  forget(key: string): void {
    this.states.delete(key);
  }

  evaluate(input: ConfirmationInput): ConfirmationOutcome {
    const { key, nowMs } = input;

    // A healthy (or no-longer-qualifying) sample resets the candidate so two
    // unrelated occurrences minutes apart can never compound into a confirmation.
    if (!input.qualifying) {
      this.states.delete(key);
      return { confirmed: false, state: { count: 0 }, reason: 'condition not qualifying; candidate cleared' };
    }

    // An explicit operator action is expected work, however expensive. Recording it
    // as a candidate is already wrong; confirming it would be worse.
    if (input.operatorInitiated) {
      this.states.delete(key);
      return { confirmed: false, state: { count: 0 }, reason: 'operator-initiated operation is expected activity' };
    }

    const prev = this.states.get(key);
    const state: ConfirmationState = prev
      ? { count: prev.count + 1, firstQualifyingAt: prev.firstQualifyingAt, lastQualifyingAt: nowMs }
      : { count: 1, firstQualifyingAt: nowMs, lastQualifyingAt: nowMs };
    this.states.set(key, state);

    switch (input.policy) {
      case 'immediate_if_authoritative':
        // A single strong authoritative mismatch is sufficient evidence.
        if (input.authoritative) {
          return { confirmed: true, state, reason: 'authoritative mismatch confirmed immediately' };
        }
        // Provisional evidence must be seen twice, consistently.
        if (state.count >= 2) {
          return { confirmed: true, state, reason: 'provisional mismatch confirmed by second consistent sample' };
        }
        return { confirmed: false, state, reason: 'provisional mismatch; awaiting second consistent sample' };

      case 'repetition_or_blocking_authoritative':
        // One authoritative failure that blocks active work is enough.
        if (input.blocksActiveWork && input.authoritative) {
          return { confirmed: true, state, reason: 'authoritative failure blocks active work; confirmed immediately' };
        }
        if (state.count >= 2) {
          return { confirmed: true, state, reason: 'repeated failure confirmed' };
        }
        return { confirmed: false, state, reason: 'first qualifying failure; awaiting confirmation' };

      case 'repetition_only':
      default:
        if (state.count >= 2) {
          return { confirmed: true, state, reason: 'repeated unexpected activity confirmed' };
        }
        return { confirmed: false, state, reason: 'first unexpected activity; awaiting repetition' };
    }
  }
}
