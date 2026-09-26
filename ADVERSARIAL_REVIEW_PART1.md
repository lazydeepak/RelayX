# Adversarial Review — Part 1 Execution Authority (Revalidation of Previous Freeze)
Status: Provisional freeze being challenged before implementation.
Standard: Every decision classified CONFIRMED / NEEDS_EVIDENCE / REJECTED / REVISED.
Ground-truth source: src/ (commit 9146719, clean working tree for new files; pre-existing source mods untouched)

---

## A. Is `sessionPairId` sufficient to identify execution relationship?

### Classification: CONFIRMED WITH REVISIONS

### Architectural justification
Session Pair is defined as exact, history-bearing relationship between one planner session and one worker session (arch §2, §3). The Pair `id` is the durable identity; session refs (`plannerSessionId`, `workerSessionId`) describe the current relationship. Historical attempts must reference the exact Pair under which executed.

### Current-code evidence
- Pair `id` is `readonly` (entities.ts 127: `public readonly id: PairId`), created once at `Pair.create()` (line 151-168).
- Pair `update()` (line 170-175) allows changing `plannerSessionId` / `workerSessionId` in-place.
- `RelayEngine.updatePair()` delegates to this mutation (engine 410-474).
- `rebindPlanner()` / `rebindWorker()` on Pair throw errors (line 182-189) — direct entity mutation disabled, but `update()` path remains open.
- Audit report (§3) confirms: "Replacing a session via implemented API updates the same pair." No replacement-pair creation mechanism exists.

### P0 / failure-case evidence
- If Pair is mutated, old assignments linked to same `pairId` silently change execution context (violates §3, §9).
- Historical Session Pair identity is rewritten when session refs change, contradicting "Historical Session Pair identity must not be silently rewritten" (arch §2).
- Old Attempt frozen to old Pair would refer to a Pair that now represents different sessions — authority contamination.

### Why simpler representation is not sufficient
A simpler representation (e.g., only `projectId`) loses Pair-level identity; same project can have multiple pairs; historical assignments must stay with exact pair.
A simpler representation (only `sessionPairId` without fixing Pair mutation) fails under adversarial mutation (current code).

### Revision required (not a change to the frozen field, but to its surrounding invariant)
- `sessionPairId` as frozen authority field: CONFIRMED.
- Pair mutation on session replacement: MUST BE FIXED (replacement must create/adopt new Pair; old Pair preserved with old refs — SESSION_PAIR_REPLACEMENT.md §3, §4).
- Once mutation is eliminated, `sessionPairId` alone is sufficient.
- Defensive option (not required if mutation fixed): also freeze `pairPlannerSessionId` and `pairWorkerSessionId` at dispatch on Attempt as redundant verification; rejected as unnecessary if Pair preservation is enforced.

---

## B. Is `workerSessionId` sufficient?

### Classification: REVISED — add frozen external session identity; keep `workerSessionId`

### Architectural justification
Attempt must bind to "exact authorized worker session" (arch §3, §9). `workerSessionId` refers to internal RuntimeSession record (`id` readonly at construction, entities.ts 260).

### Current-code evidence — can RuntimeSession change identity?
YES, via multiple paths:
- `updateExternalIdentity()` (entities.ts 368-375) changes `externalSessionId` and `externalProjectRef` in place (`this.externalSessionId = ...`; `updatedAt = Date.now()`).
- `archive()` (line 377-382) / `unarchive()` (line 384-389) changes `status` and can reactivate with different identity.
- `recordObservationSuccess()` (341-358) updates `windowTitle`, `applicationPid`, `lastEvidence`; `recordObservationFailure()` (323-339) can terminate after thresholds.
- Provider adoption: `RelayApiService.adoptOpenCodeSession()` (line 1321-1350) and `finalizeProjectSetup()` (line 1561+) register/repurpose runtime records; `createOpenCodeWorkerSession()` (line 1352-1504) may create new session and bind to existing or new runtime.
- `externalSessionId` is optional (`?: string | null`) and can be set to null then to a new value.

### P0 / failure-case evidence — stale-authority scenarios
1. Worker replacement, same RuntimeSession id adopted to new ChatGPT conversation: frozen `workerSessionId` matches (same internal id), but `externalSessionId` changed → attempt would incorrectly accept new session authority if only internal id frozen.
2. Provider restart: runtime process dies, session recreated, same runtime id reused with new external session identity.
3. Workspace/path change: `externalProjectRef` may change if session moves.

### What must be added to authority
- `externalSessionId` AT TIME OF DISPATCH must be frozen on Attempt (or full external identity snapshot).
- `providerType` is `readonly` on RuntimeSession (line 261) — never changes for record — REJECTED as authority addition (redundant with `workerSessionId`).
- `workspace/project identity` (externalProjectRef / workspace path) belongs to repository boundary / pairing verification (architecture §10, §11), NOT to execution identity. REJECTED for authority; kept under repo baseline.
- `providerExternalRef` / full external identity reference: CONFIRMED as needed specifically for the session-identity component (`externalSessionId`).

### Revised frozen authority (execution identity only)
- `sessionPairId`
- `workerSessionId`
- `externalSessionId` (at dispatch time — frozen snapshot)
- `providerType` excluded (redundant with immutable record attribute)
- `externalProjectRef` excluded (repo boundary, separate freeze)

---

## C. What does `frozenAt` actually do?

### Classification: REVISED — removed from authority fields; kept as audit metadata only

### Architectural / evidence analysis
- `frozenAt` is a timestamp. Authority validation compares identity fields, not time.
- No transition rule uses `frozenAt` to decide validity (e.g., "if frozenAt > 5 minutes ago, reject" — not in architecture; stale-message protection uses correlation/sequence, not age alone).
- `Attempt.startedAt` and `Attempt.preparedAt` (if added) provide sufficient temporal evidence.
- `frozenAt` does not prevent replay: identical frozen identity + identical timestamp could still replay if not protected by correlation/attempt identity.
- The only potential use is audit / evidence ordering ("when was authority frozen?") — valuable for evidence, not for validation logic.

### Why not authority-critical
If an attcker has frozen `sessionPairId` + `workerSessionId` + `externalSessionId`, adding or removing `frozenAt` doesn't change whether they match current state. The comparison is identity-equality, not temporal.

### Decision
- `frozenAt` removed from authority validation primitive.
- If needed for audit/evidence: can be derived from attempt preparation timestamp or added as non-authoritative audit field. Not required for correct operation.
- Previous freeze presentation of `frozenAt` as part of authority was overstated.

---

## D. Re-test rejection of `execution_epoch`

### Classification: CONFIRMED (rejection maintained)

### Test cases — explicit stale-authority scenarios

**Case 1 — Worker session replaced (same internal `id`, new external session):**
- Frozen: `attempt.id`, `sessionPairId`, `workerSessionId`, `externalSessionId_old`
- Current: `workerSessionId` matches (same record), `externalSessionId` = new
- With `execution_epoch`: would need to compare epoch; without it: compare `externalSessionId` → mismatch → reject.
- **Result:** `execution_epoch` unnecessary; external identity comparison handles it.

**Case 2 — Planner session replaced (old Pair preserved, new Pair created):**
- Frozen: `sessionPairId` = old Pair id
- Current: new Pair has new `id`; assignment may be on new Pair
- Validation compares `sessionPairId` → old Pair id vs current Pair → new id → mismatch → reject.
- **Result:** Pair id identity sufficient; no epoch needed.

**Case 3 — Same Pair, worker session detached/rebound (incorrect mutation of old Pair):**
- Frozen: `sessionPairId` = old Pair id, `workerSessionId` = old session id, `externalSessionId` = old
- Current: old Pair mutated to new session (current broken behavior); `sessionPairId` still points to same Pair id, but pair's session refs changed.
- Without fixing mutation: `sessionPairId` alone passes, but pair's session refs don't match frozen expectation (if we freeze session refs too) or don't matter (if we rely only on Pair id).
- **Critical finding:** If Pair mutation is NOT fixed, `sessionPairId` alone is insufficient because the Pair's semantic identity changed even though `id` stayed same. The fix is Pair preservation (new Pair creation), not adding an epoch. Once fixed, `sessionPairId` is sufficient.

**Case 4 — Old worker session reports completion for new attempt (new attempt under new session):**
- Frozen new attempt: new `attempt.id`, new `sessionPairId` (new Pair), new `workerSessionId`, new `externalSessionId`
- Old session reports → `workerSessionId` old ≠ new → reject.
- **Result:** Attempt id + Pair id + worker id + external id fully specify; no epoch needed.

**Case 5 — Attempt replay (same identity, different time, same current session):**
- Frozen attempt completed; replay attempt tries to complete again.
- Validation: compare attempt `id` against current execution context; if attempt already `completed_physical`, transition guard rejects regardless of authority match.
- **Result:** Attempt lifecycle state prevents replay; epoch doesn't help.

### Conclusion of re-test
- `execution_epoch` is unnecessary and rejected.
- All stale-authority cases are covered by exact immutable identity fields + lifecycle state guards.
- The weak point is Pair mutation (Case 3), which must be fixed at Pair level, not by adding epoch to authority.

---

## Final Revised Frozen Authority (after adversarial review)

| Field | Status | Rationale |
|---|---|---|
| `sessionPairId` | CONFIRMED | Pair `id` is immutable; sufficient IF Pair mutation eliminated |
| `workerSessionId` | CONFIRMED (with revision) | Internal RuntimeSession id immutable; must pair with frozen external session identity |
| `externalSessionId` (at dispatch) | REVISED — ADD | RuntimeSession can update external identity; must freeze snapshot |
| `frozenAt` | REVISED — REMOVE from authority | Audit only; identity equality is sufficient |
| `execution_epoch` | REJECTED (reconfirmed) | Unnecessary; all cases covered by identity fields |
| `providerType` | REJECTED | Readonly with RuntimeSession record; redundant |
| `externalProjectRef` | REJECTED | Repository boundary, separate freeze |

---

## Blockers / Pre-implementation Requirements (from this review)

1. Pair mutation must be eliminated (replacement creates new Pair; old preserved) — SESSION_PAIR_REPLACEMENT.md.
2. Attempt must freeze `externalSessionId` at dispatch — requires `AttemptProps` / entity extension.
3. `frozenAt` should not be presented as authority primitive; remove or demote to audit.
4. `execution_epoch` must not be introduced; defend against future requests by referencing this review.

---

## No source code / DB / provider / Plan-First modifications performed
All analysis read-only against existing entities (Pair, RuntimeSession, Attempt) and engine/service paths (updatePair, updateExternalIdentity, recoverOnStartup). Zero edits to src/ at review time (pre-existing modifications preserved, unchanged).
