/**
 * THE RELAY BATON — which side is expected to produce the next completed turn.
 * =========================================================================
 *
 * ## The rule this module exists to express
 *
 * **The recipient of the last CONFIRMED Delivery currently holds the baton.**
 *
 *   last confirmed Delivery was Planner -> Worker  =>  Worker holds the baton
 *   last confirmed Delivery was Worker -> Planner  =>  Planner holds the baton
 *
 * RelayX is a session watcher and a postman. It answers exactly one question about
 * work — *which side owes the next completed turn* — and it answers that question
 * from durable transport records. It never answers whether the work was correct,
 * valid, sufficient, drifted, or semantically complete. That judgment belongs to
 * the Planner, and deliberately not to this module.
 *
 * ## Why the baton is DERIVED and never stored
 *
 * There is deliberately no `baton` table, column, or mutable field. A stored baton
 * would be a second source of truth that can disagree with the `deliveries` table,
 * and a disagreement here is the most dangerous kind of disagreement in the system:
 * it would make RelayX send a message to a side that does not own the turn. The
 * confirmed Delivery IS the baton. Every question this module answers is answered by
 * re-reading it, so a crash can never leave a stale holder behind.
 *
 * The same reasoning is why the recovery episode marker lives on the Assignment
 * (`sourceRecoveryDeliveryId`) rather than as "recovery already happened" state: it is
 * keyed to the specific Delivery that triggered it, so it names an episode instead of
 * asserting a semantic outcome.
 *
 * ## What counts as "confirmed"
 *
 * Only `Delivery.status === 'delivered'`. A `pending`/`delivering` intent is a
 * durable intent whose outcome is unknown, and an `ambiguous` intent is one RelayX
 * has explicitly declined to resolve. Neither has moved the baton, because neither
 * established that a message landed. Reconciliation decides those; this module
 * refuses to guess in their direction.
 *
 * A locally OBSERVED turn does not move the baton. The baton transfers only when the
 * Delivery carrying that turn to the opposite side is itself confirmed.
 *
 * ## Source-of-truth precedence
 *
 * Followed exactly as specified, and each step is implemented as a real filter rather
 * than a comment:
 *
 *   1. confirmed Delivery state      -> `status === 'delivered'`
 *   2. Delivery direction            -> the recipient is `assignment.targetSideRole`;
 *                                       the sender is the opposite side
 *   3. target session identity       -> a confirmed Delivery targeting a runtime this
 *                                       Pair is no longer bound to is NOT part of the
 *                                       CURRENT chain and is dropped
 *   4. persisted message id/watermark-> `boundary`, read off the Delivery's evidence
 *   5. authoritative turns after it  -> consumed by the caller, not here
 *   6. provider running/generating    -> consumed by the caller, not here
 *   7. timestamps                     -> NEVER used to decide ownership or completion
 *
 * ## Where timestamps DO appear, and why that is not a violation
 *
 * `chainIndex` is the caller's position of each Assignment in the Pair's relay chain,
 * computed with the engine's existing deterministic `(createdAt, id)` ordering. That
 * ordering answers a SEQUENCING question — "which link of the chain came later" — and
 * never a state question. Every *state* decision in this module (is it confirmed,
 * which side, which session) is made from status fields and identifiers. No branch
 * here reads a timestamp.
 */

import type { Assignment, Attempt, Delivery } from './entities.ts';
import type { PairSideRole, RuntimeSessionId } from './types.ts';

/** A delivery direction, named by sender then recipient. */
export type RelayBatonDirection = 'planner_to_worker' | 'worker_to_planner';

/** What the baton was derived from. */
export type RelayBatonBasis =
  /** A confirmed Delivery exists; its recipient holds the baton. */
  | 'confirmed_delivery'
  /** No confirmed Delivery exists for the current chain. Bootstrap: no baton. */
  | 'no_confirmed_delivery';

/**
 * The pre-dispatch boundary committed on a Delivery's evidence.
 *
 * Structurally compatible with `providers.ExactSessionWatermark`, declared here so the
 * domain does not have to import from the provider layer (the dependency only ever runs
 * `providers -> domain`).
 */
export interface BatonBoundary {
  sessionId: string;
  /** Every provider message id that existed at capture time. The SET is the boundary. */
  messageIds: readonly string[];
  messageCount: number;
  capturedAt: number;
  provenance: 'captured_pre_dispatch' | 'reconstructed_from_intent_time';
}

/** One confirmed Delivery together with everything needed to interpret it. */
export interface RelayBatonLink {
  delivery: Delivery;
  assignment: Assignment;
  /** The frozen dispatch authority, when the Attempt is still resolvable. */
  attempt: Attempt | null;
  /** The Assignment's position in the Pair's deterministic relay chain. */
  chainIndex: number;
  /** Pre-dispatch boundary committed on the Delivery's evidence, or `null` if none. */
  boundary: BatonBoundary | null;
}

/** The derived baton state for one Pair. */
export interface RelayBaton {
  basis: RelayBatonBasis;
  /** The side expected to produce the next completed turn. `null` only in bootstrap. */
  owner: PairSideRole | null;
  /** The side that produced the Delivery currently holding the baton. */
  sender: PairSideRole | null;
  direction: RelayBatonDirection | null;
  /** The confirmed Delivery that establishes the baton. */
  delivery: Delivery | null;
  /** The Assignment that Delivery was dispatched for. */
  assignment: Assignment | null;
  /** The frozen dispatch authority of that Delivery. */
  attempt: Attempt | null;
  /** The persisted message-id boundary the owner must be inspected after. */
  boundary: BatonBoundary | null;
  /** Confirmed deliveries that were current-chain candidates before filtering. */
  confirmedDeliveryCount: number;
  /**
   * Confirmed deliveries dropped because they target a runtime session this Pair is no
   * longer bound to. Non-zero means the chain was rebounded underneath the baton, which
   * is reported rather than silently absorbed.
   */
  supersededCount: number;
  /** Every current-chain confirmed Delivery, oldest first. */
  chain: RelayBatonLink[];
}

/** The opposite side of a Pair. Total, so no caller can forget a branch. */
export function oppositeSide(side: PairSideRole): PairSideRole {
  return side === 'worker' ? 'planner' : 'worker';
}

/** The direction name for a sender/recipient pair. */
export function relayDirectionBetween(
  from: PairSideRole,
  to: PairSideRole,
): RelayBatonDirection {
  return from === 'planner' ? 'planner_to_worker' : 'worker_to_planner';
}

/**
 * Derive the baton from the Pair's confirmed Deliveries.
 *
 * Pure: no repository, no provider, no clock. The caller assembles the links, which is
 * what lets every ordering and filtering rule here be tested directly.
 *
 * `boundRuntimeIds` is step 3 of the precedence list. Omit it to skip the binding
 * check — which is only correct when the caller has already established that every
 * link targets a currently bound session.
 */
export function deriveRelayBaton(input: {
  links: readonly RelayBatonLink[];
  boundRuntimeIds?: Partial<Record<PairSideRole, RuntimeSessionId>>;
}): RelayBaton {
  const { links, boundRuntimeIds } = input;

  // Step 1: only a CONFIRMED Delivery can hold the baton. `pending`/`delivering` mean
  // the outcome is unknown and `ambiguous` means RelayX declined to resolve it; both are
  // handed to reconciliation, and neither is allowed to move ownership in either
  // direction.
  const confirmed = links.filter((link) => link.delivery.status === 'delivered');

  // Step 3: a Delivery aimed at a session this Pair is no longer bound to is not part of
  // the CURRENT chain. Keeping it would hand the baton to a side whose session has been
  // replaced, and the next action would be sent to the wrong conversation.
  let supersededCount = 0;
  const currentChain = boundRuntimeIds
    ? confirmed.filter((link) => {
        const bound = boundRuntimeIds[link.assignment.targetSideRole];
        if (bound !== undefined && bound === link.delivery.targetRuntimeId) return true;
        supersededCount++;
        return false;
      })
    : confirmed;

  // Chain order is structural: Assignment position first, then the frozen Attempt number
  // (monotonically increasing within one Assignment), then the Delivery id purely as a
  // deterministic tie-break. No timestamp is read here — `chainIndex` already carries
  // the sequencing decision, made once by the caller.
  const ordered = [...currentChain].sort((a, b) => {
    if (a.chainIndex !== b.chainIndex) return a.chainIndex - b.chainIndex;
    const attemptDelta =
      (a.attempt?.attemptNumber ?? 0) - (b.attempt?.attemptNumber ?? 0);
    if (attemptDelta !== 0) return attemptDelta;
    return a.delivery.id.localeCompare(b.delivery.id);
  });

  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : null;

  if (!latest) {
    return {
      basis: 'no_confirmed_delivery',
      owner: null,
      sender: null,
      direction: null,
      delivery: null,
      assignment: null,
      attempt: null,
      boundary: null,
      confirmedDeliveryCount: confirmed.length,
      supersededCount,
      chain: ordered,
    };
  }

  // Step 2: the recipient of the Delivery is the side that owes the next completed turn.
  // This is read from the Assignment's target role — a durable structural fact — and
  // never inferred from text, a window title, or a time difference.
  const owner: PairSideRole = latest.assignment.targetSideRole;
  const sender = oppositeSide(owner);

  return {
    basis: 'confirmed_delivery',
    owner,
    sender,
    direction: relayDirectionBetween(sender, owner),
    delivery: latest.delivery,
    assignment: latest.assignment,
    attempt: latest.attempt,
    boundary: latest.boundary,
    confirmedDeliveryCount: confirmed.length,
    supersededCount,
    chain: ordered,
  };
}

/**
 * Identity reconciliation for the baton link.
 *
 * The Delivery and its Attempt froze WHICH external session dispatch was authorized
 * against (EXECUTION_AUTHORITY.md). A Pair can be rebound to a different session at
 * any time, so before acting on a baton the engine must prove the baton is still about
 * the session this side is currently bound to. Without this, a resumed Pair would send
 * a recovery message into an unrelated conversation.
 */
export function batonSessionIdentity(
  link: { delivery: Delivery; attempt: Attempt | null },
  currentExternalSessionId: string | null | undefined,
): {
  matches: boolean;
  dispatchedExternalSessionId: string | null;
  currentExternalSessionId: string | null;
} {
  const dispatched = link.attempt?.externalSessionId ?? null;
  const current = currentExternalSessionId ?? null;
  if (dispatched === null || current === null) {
    // Neither side can be proven equal, so they are not asserted equal. This is the
    // fail-closed direction: it produces "cannot act", never "assume same session".
    return { matches: false, dispatchedExternalSessionId: dispatched, currentExternalSessionId: current };
  }
  return { matches: dispatched === current, dispatchedExternalSessionId: dispatched, currentExternalSessionId: current };
}
