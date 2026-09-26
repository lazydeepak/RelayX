# EXECUTION AUTHORITY — Frozen Domain Decision (Core / Shared)
# Frozen at: session following I7/I11 audits + P0_MATRIX
# Unfrozen: physical DB layout, dispatch-correlation mechanism, contract/revision form

## 1. Domain Rule (from architecture sections 3, 9, 11)

Execution authority is bound to the Attempt at dispatch, not inferred from whatever Session Pair or worker happens to be current later.

A replacement worker must not be able to advance an older Attempt.
Evidence originating from obsolete execution authority must not mutate current state.

## 2. Decision — What must be frozen on Attempt at dispatch (REVISED after adversarial review Part 1)

| Field | Status | Meaning | Source / Rationale |
|---|---|---|---|
| `sessionPairId` | CONFIRMED | Exact Session Pair under which attempt executes | Pair `id` immutable (entities.ts 127); sufficient if Pair mutation eliminated (see §6) |
| `workerSessionId` | CONFIRMED | Internal RuntimeSession identity at dispatch | RuntimeSession `id` immutable at creation (260); must pair with frozen external identity |
| `externalSessionId` | REVISED — ADD | Provider-specific external session identity AT DISPATCH | `RuntimeSession.updateExternalIdentity()` mutable (368-375); same internal id can adopt new ChatGPT/OpenCode session → authority contamination if not frozen |
| `providerType` | REJECTED | Redundant with immutable RuntimeSession record | `providerType` readonly on RuntimeSession (261); never changes for record |
| `frozenAt` | REVISED — REMOVE from authority | Timestamp only; does not participate in identity comparison | No transition uses timestamp for validity; identity equality is sufficient; audit metadata only |
| `execution_epoch` | REJECTED (reconfirmed) | Unnecessary; all stale cases covered by identity fields + lifecycle state | Tested 9 cases (see §4); weak point was Pair mutation, not missing epoch |

**Revised minimum frozen authority:** `sessionPairId` + `workerSessionId` + `externalSessionId` (snapshot at dispatch).

## 3. Decision — Re-test rejection of `execution_epoch` (9 cases from adversarial review Part 1D)

### Classification: REJECTED (reconfirmed after full adversarial re-test)

### Explicit cases

1. **Worker session replaced, same internal id, new external session** — Frozen `externalSessionId` detects; reject.
2. **Planner session replaced, new Pair** — `sessionPairId` mismatch; reject.
3. **Pair mutation of old Pair (current broken `updatePair`)** — Weak point is Pair preservation, not missing epoch; fix at Pair level.
4. **Runtime lost/recreated, same id, new external identity** — `externalSessionId` detects; reject.
5. **Provider restart / re-adoption** — Same as 4.
6. **Old completion arriving late (after replacement / new attempt)** — `attempt.id` + `sessionPairId` + worker identity sum; reject for new attempt.
7. **Old planner action arriving late** — Identity comparison + lifecycle guard; reject.
8. **Same workspace/app with new external session** — `externalSessionId` required; workspace-only insufficient.
9. **Assignment continuation under replacement Pair** — Old Attempt frozen to old Pair; new Attempt under new Pair; identity comparison sufficient.

### Conclusion
- All 9 stale-authority cases resolve by frozen identity fields + lifecycle state.
- Weak case (3) requires Pair preservation (new Pair creation), not epoch.
- `execution_epoch` is unnecessary and must not be added.

## 4. Decision — Authority validation rules (I7 / Section 7 / Section 9)

Before any state-changing transition on an Attempt (complete, fail, verify, apply planner action):

1. Load Attempt.
2. Load frozen `sessionPairId` and `workerSessionId`.
3. Verify current Session Pair exists and its identity matches frozen pair (exact `id`, not just project).
4. Verify current worker session identity matches frozen worker (exact `id`).
5. If either mismatches: **reject transition**; retain evidence of attempt (stale authority rejection); do not replay.
6. If planner action `[RELAYX_ACTION]` is applied: verify `attemptId` (where applicable) matches frozen attempt; verify current `sessionPairId`/`assignmentId`; verify action is legal for current state; verify message is not stale (correlation / timestamp / sequence guard — mechanism unfrozen, rule frozen).

## 5. Decision — Evidence immutability

`Attempt.evidence` must not be a mutable object reference that can be overwritten by later observations.

- Evidence is either frozen at write time (immutable snapshot/value) or appended as new observations with timestamp/source, never in-place mutation.
- Old session evidence for a completed/failed attempt is retained but never applied to a different attempt or to current assignment state.
- Replacement session observations apply only to attempts with matching frozen `workerSessionId`; otherwise rejected as stale.

## 6. Unfrozen representations (not frozen here)

- Physical storage: frozen fields on `attempts` table vs separate `execution_authorities` table (cardinality = 1:1 → fields preferred, but not decided)
- Provider-specific external session identity format (`externalSessionId`, `externalProjectRef`)
- Correlation / fingerprint mechanism for dispatch verification (section 10 unfrozen)

## 7. Contradictions found against current code (verified 9146719)

- `AttemptProps` / `Attempt` (entities.ts 578-639) has no `sessionPairId`, no `workerSessionId`, no `frozenAt`.
- `Attempt.create()` uses only `assignmentId`; does not receive or freeze session context.
- `Attempt.complete()` and `Attempt.fail()` mutate `status`, `finishedAt`, `failureReason`, `evidence` in place with no authority check.
- `Pair.updatePair()` mutates `plannerSessionId` / `workerSessionId` in place rather than preserving old Pair and creating replacement.
- No transition guard prevents old Attempt evidence from being replayed onto current Assignment state.
- Evidence is mutable reference (`ObservableEvidence`), allowing in-place mutation without audit trail.

## 8. Blockers / dependencies (before source implementation)

- Must freeze domain concept before DB mapping (this document does that).
- Must decide dispatch-correlation mechanism before `recordDispatchIntent()` / `confirmDispatch()` can be fully specified (section 10 unfrozen).
- Must design Session Pair replacement / adoption rule (Part 3) before active Assignment continuation can be defined.
