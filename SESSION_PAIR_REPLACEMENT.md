# SESSION PAIR REPLACEMENT — Interaction with Active Attempts (Core)
# Frozen: rule that replacement creates/adopts new Pair; old Pair preserved; old Attempts remain bound
# Unfrozen: exact UI flow, adoption API parameters, whether new Pair inherits assignments

## 1. Architectural Rule (Section 2, 3, 9, 11)

A Session Pair is an exact, history-bearing relationship between one planner session and one worker session.

When either session changes:
- Old Pair identity must be preserved
- Replacement should normally create or adopt another Session Pair
- Historical assignment/attempt history stays with the old Pair
- Old Attempt must remain bound to the exact old Session Pair (frozen authority)

## 2. Contradiction with Current Code (verified 9146719)

- `RelayEngine.updatePair()` (line 410-474) calls `pair.update(...)`, mutating `plannerSessionId` and `workerSessionId` in place on the SAME pair record.
- No method in engine / service / bridge creates a new Pair on session replacement.
- `Pair` entity has `projectId` (immutable in entity, though DB allows update) but no version / replacement reference.
- `Assignment` links to `pairId`; if old Pair is mutated, assignment's execution context silently changes.
- Audit report (AUDIT_REPORT.md section 3) confirms: "Replacing a session via the implemented API updates the same pair." This contradicts target model.

## 3. Frozen Replacement Rule

### For historical preservation:

- Old Pair `id` remains unchanged.
- Old Pair retains its `plannerSessionId`, `workerSessionId`, `status`, `lastSupervisedAt`, `createdAt`.
- Old Pair retains its assignments and attempts via foreign keys (existing `ON DELETE CASCADE` means deletion destroys them — so old Pair must NOT be deleted on replacement).
- Replacement creates a NEW Pair (`newPairId`) with new session refs.

### For active execution:

- In-flight Attempt frozen to old Pair must NOT be silently transferred.
- If user wants to continue Assignment work under new session: **explicit adoption / reassignment** required.
- The Assignment may either:
  a) Stay with old Pair (work continues with old session if available); or
  b) Be explicitly adopted/reassigned to new Pair (new Attempt under new authority).

**No automatic transfer.** Replacement alone must not silently change Assignment execution authority.

## 4. Explicit Adoption / Handoff Requirement

If an Assignment with an active or interrupted Attempt should continue under a replacement Session Pair:

1. Old Attempt must be concluded / interrupted / failed / preserved (not silently continued under new authority).
2. New Pair must be created / adopted (with new session identity).
3. Assignment may be explicitly updated to reference new Pair (or a new Assignment created under new Pair — architecture does not freeze which, only that it must be explicit).
4. New Attempt created under new Pair with frozen authority = new session identity.
5. Old Pair and old Attempt preserved independently.

**Without this explicit handoff:** The replacement Pair must not have active assignment work until the adoption is performed.

## 5. Interaction with Each Case (from ATTEMPT_LIFECYCLE)

| Case | Old Pair + Attempt | Replacement Action | Outcome |
|---|---|---|---|
| 1-3: Normal execution | Old Pair active; Attempt frozen to old Pair | Create new Pair; old Pair preserved; Assignment stays or adopted | Old Attempt completes independently; new work requires new Attempt under new Pair |
| 4: Verification fails | Old Pair; Attempt `completed_physical`; verification `failed` | Replacement does not change verification; if retry desired, new Attempt under new Pair or same Pair if same session | Old verification truth preserved |
| 5: Interrupted / runtime lost | Old Pair; Attempt `interrupted` | Recovery may resume old Attempt only if old session authority verified; else new Attempt under new Pair | Old interruption preserved; no rollback |
| 6: Old session reports after replace | Old Pair frozen to old session; evidence arrives | Evidence validated against frozen `workerSessionId`; if matches old authority, evaluated; if new Pair active, old evidence does not advance new Attempt | Old evidence retained / rejected correctly |
| 7: Planner actions on old attempt | Old Pair; Attempt complete/failed/interrupted | Action validated against frozen attempt and old Pair; if obsolete, rejected; no mutation of new work | Stale action preserved as evidence |

## 6. Unfrozen Design Decisions

- Whether replacement creates new Pair via `engine.createPair()` or via a dedicated `adoptPair()` / `replacePair()` transition.
- Whether Assignment references can be updated (currently `pairId` immutable in entity, though DB allows updates) — if immutable, new Assignment under new Pair is required; if mutable, explicit update with audit is needed.
- Whether old active assignment must be completed/cancelled before new Pair can take over (current `ACTIVE_WORK_GUARD` in `updatePair()` throws if `pair.activeAssignmentId` exists — this guard should apply to new Pair creation if adopting active assignment, not to old Pair preservation).
- Exact UI flow for user to initiate replacement (pair modal, project detail, etc.).

## 7. Blocker / Pre-implementation Requirement

Before implementing substitution logic or database migrations for Pair versioning / replacement:

- Must freeze whether Pair identity is immutable once created (yes — architecture says historical identity preserved, not rewritten).
- Must freeze whether replacement is always new Pair (yes — design decision frozen here).
- Must freeze whether Assignment transfer is explicit or requires new Assignment (not fully frozen; depends on whether `pairId` on Assignment remains immutable; current entity says yes, but architecture requires explicit adoption — if immutable, new Assignment required; if mutable with guard, explicit update allowed). 

**Recommendation:** Keep `pairId` immutable on Assignment (matches current entity design) and require explicit new Assignment under new Pair for continuation. This avoids silent transfer and preserves historical assignment identity.
