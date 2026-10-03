/**
 * Whether the Create Assignment modal should close after a submit attempt.
 *
 * The decision is driven ONLY by the durable fact: an Assignment was created.
 * A post-claim dispatch failure (or an ambiguous/failed delivery) still closes
 * the modal, because the draft is no longer a draft — the durable Assignment now
 * exists and owns the execution slot, and the user must work from that
 * Assignment/Pair rather than from the composer.
 *
 * A pre-claim refusal (`created: false`) keeps the modal open so the user can fix
 * or retry creation. A thrown error before any structured result is also treated
 * as "not created" by the caller (creation is unproven), which keeps it open.
 */
export function shouldCloseCreateAssignmentModal(
  result: { created?: boolean } | null | undefined,
): boolean {
  return result?.created === true;
}
