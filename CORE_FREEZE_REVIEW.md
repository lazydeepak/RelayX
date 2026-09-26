# Core Freeze Final Review — Adversarial Revalidation Complete
Status: All previously frozen Core / Shared decisions revalidated; revisions applied; no source/DB/Plan-First changes.
Files updated: EXECUTION_AUTHORITY.md, ATTEMPT_LIFECYCLE.md, DOMAIN_DELTA.md, ADVERSARIAL_REVIEW_PART1.md (new)

---

## Final Freeze Decision Table

| Decision | Result | Final domain rule | Evidence / Rationale |
|---|---|---|---|
| Attempt authority — sessionPairId | CONFIRMED (+revision) | Freeze Pair `id`; sufficient ONLY if Pair mutation eliminated; replacement creates new Pair | Pair `id` readonly; updatePair mutates refs (entity 170, audit §3); SESSION_PAIR_REPLACEMENT.md fixes |
| Attempt authority — workerSessionId | CONFIRMED (+revision) | Freeze internal RuntimeSession `id`; must pair with frozen external session identity | RuntimeSession `id` readonly (260); `updateExternalIdentity()` mutable (368-375); adoption/rebind possible |
| Attempt authority — external provider session ID | REVISED — ADD | Freeze `externalSessionId` at dispatch (snapshot) | Same `id` can adopt new ChatGPT/OpenCode session (adoptOpenCodeSession, finalizeProjectSetup); external identity is authority surface |
| Attempt authority — providerType | REJECTED | Omitted; redundant with immutable record attribute | Readonly on RuntimeSession (261); never changes for record |
| Attempt authority — workspace/project identity | REJECTED for authority; frozen separately under repo boundary | Not part of execution identity; belongs to repository execution boundary | Pairing validates workspace against project (createPair 418-427); repo boundary separate (arch §11) |
| Attempt authority — frozenAt | REVISED — REMOVE from authority | Audit/metadata only; not used in identity validation | No transition rule uses timestamp; identity equality sufficient; redundant with preparation timestamp |
| Attempt authority — execution_epoch | REJECTED (reconfirmed) | Not required; rejected after 9-case adversarial test | All cases covered by exact identity fields + lifecycle state; weak point (Pair mutation) is Pair-level fix (case 3) |
| Assignment ↔ Session Pair ownership | CONFIRMED (Model A + adoption) | `pairId` immutable (origin/current); continuation requires explicit new Assignment or audited adoption | Current entity design (`readonly pairId`); preserves historical assignment identity; prevents silent transfer |
| Pair replacement rule | CONFIRMED (with fix required) | Replacement creates/adopts new Pair; old Pair preserved with old session refs | Architecture §2, §3; current code contradicts (updatePair mutates same Pair); SESSION_PAIR_REPLACEMENT.md |
| Dispatch ownership / intent | CONFIRMED | Durable dispatch intent persisted before external send; uncertain state reconcilable (never blind resend) | Section 10; recoverOnStartup creates Handoff without durable intent comparison (I11 gap); needs `recordDispatchIntent` |
| Physical Attempt lifecycle | CONFIRMED (orthogonal dimensions) | 4 dimensions: physical execution / verification / dispatch uncertainty / assignment resolution (derived) | ATTEMPT_LIFECYCLE.md §1-2; verification and semantic acceptance separate from physical execution (§12) |
| Verification ownership | CONFIRMED | Separate from Attempt physical state; linked record (VerificationResult); Attempt does not become `failed` on verification failure | Mechanical failure case resolved: completed + verification_failed = Assignment_unresolved (§3, §12, §13) |
| Planner-action authority envelope | CONFIRMED (with unfrozen syntax) | Must carry: project/assignment/attempt/session-pair/planner-session/assist-correlation/requested-action/authority-context/timestamp/outcome/evidence/reject-reason | Section 7; I7 audit §5; stale rules defined (old attempt/pair/session/resolved assist/completed assignment/valid-written-obsolete-received/duplicate replay) |
| Repository execution baseline | CONFIRMED | Concept frozen: HEAD/revision + dirtyState + expectedWrites/deps + contract refs + verificationInputs + observationLedger + frozenAt; belongs to Attempt; extends but doesn't rewrite | Section 11; I11 audit; recovery must inspect repo state (not assume rollback) |
| Stale-action persistence | CONFIRMED | Rejected/planned actions durable (not just events) to enable deterministic stale-message rejection | I7 audit §6; needs dedicated persistence (table or durable event) |

---

## Decisions revised from previous freeze

- `execution_epoch`: previously rejected with brief rationale; now confirmed with 9 explicit adversarial cases (Part 1D / ADVERSARIAL_REVIEW_PART1.md).
- `frozenAt`: previously presented as authority primitive; revised to audit-only; removed from validation logic (Part 1C).
- `workerSessionId`: previously sufficient alone; revised to require frozen `externalSessionId` snapshot (RuntimeSession `updateExternalIdentity()` mutable, adoption/rebinding possible — Part 1B).
- `sessionPairId`: previously sufficient; revised to require Pair mutation elimination (current `updatePair()` violates history-bearing invariant — Part 1A / SESSION_PAIR_REPLACEMENT.md).
- `providerType`: implicitly included previously; explicitly rejected (redundant).
- Assignment↔Pair: previously unfrozen; frozen as Model A (immutable `pairId`, explicit continuation) (Part 2 / DOMAIN_DELTA.md).
- Planner-action envelope: previously conceptual; now defined with minimum identity fields + 7 stale rules (Part 4).
- Pair replacement: previous statement "must create new Pair" validated; state machine defined (Part 5); contradiction that current code mutates same Pair documented as blocking.

---

## Unfrozen (deliberately left open)

- Contract Revision form (entity / value / normalized — section 14)
- Strategy Lineage / budget schema (section 15)
- Retry/replan limits (configuration, not hard-coded)
- Dispatch-correlation mechanism / visible marker format (provider ground truth — section 10)
- DB layout / SQLite migrations (section 22)
- Engine transition API exact names/parameters (section 23 — derived from completed matrix)
- Structured message syntax for planner updates/assists/actions (protocol rules frozen; parsing format unfrozen)

---

## Blockers before implementation (must resolve before source/DB work)

1. Pair mutation eliminated (`updatePair` must create new Pair; old preserved; assignments stay linked to old `pairId`).
2. Attempt frozen authority extended with `externalSessionId` snapshot (entity / property / value object — cardinality decided, not DB mapped yet).
3. `frozenAt` removed from validation logic; if kept, designated audit-only.
4. `execution_epoch` explicitly excluded from design; defend if requested again.
5. Assignment `pairId` immutability enforced (already entity-level `readonly`; DB guard required if any manual edit allowed).
6. Dispatch-correlation mechanism established (provider ground truth — could block `recordDispatchIntent`/`confirmDispatch` design).

---

## Contradictions — corrected / reinforced from previous 8

| # | Contradiction | Evidence | Severity | Fix required | Dependency |
|---|---|---|---|---|---|
| 1 | Mutable Pair rebind (`updatePair` mutates session refs; `rebindPlanner/Worker` disabled but path open via `update`) | entities.ts 170-175; engine 410-474 | HIGH | Replace with new Pair creation; preserve old | Session Pair replacement |
| 2 | `stopPair()` / `clearWork()` clearing assignment without resolution | entities.ts 212-216 | MEDIUM | Explicit resolution required before clearing | Assignment lifecycle |
| 3 | Supervision reads current Pair worker instead of frozen Attempt authority | engine supervision loop uses `pair.workerSessionId` | MEDIUM | Verify evidence against frozen attempt authority when evaluating | Execution authority |
| 4 | Attempt starts immediately `running`; stays `running` until assignment completes | entities.ts 611-618 (`status: 'running'`) | HIGH | Separate dimensions (ATTEMPT_LIFECYCLE.md); must not stay `running` after physical completion | Attempt lifecycle |
| 5 | Delivery / dispatch side-effect vs DB persistence gap | engine saves delivery before external execution; unclear uncertain-state reconciliation | MEDIUM | Durable dispatch intent + reconciliation after restart (I11 / section 10) | Dispatch reconciliation |
| 6 | Assignment Pair coupling mutable via Pair mutation | `pairId` immutable entity but Pair mutation changes execution context | HIGH | Fix Pair mutation + keep `pairId` immutable | Assignment↔Pair |
| 7 | No stale planner-action persistence / authority validation | No planner-action table; no validation in engine/service | HIGH | Add durable planner-action request + validation rules | Planner protocol |
| 8 | `Attempt.evidence` mutable reference; historical evidence can be overwritten | entities.ts 588 (reference); `complete()` replaces evidence | MEDIUM | Evidence frozen/snapshot; replay protected by authority | Execution authority / evidence |

Note on #5 (delivery contradiction): Previous report stated "Delivery side effect inside DB transaction"; refined — DB persistence is separate from external dispatch (correct per section 10); the gap is lack of durable-intent reconciliation and uncertain-state handling, not wrong transaction. Corrected in this review.

---

## Is Core ready for implementation?

NO — with one exception: the authority rules, lifecycle dimensions, and Pair/Assignment relationships are frozen and consistent. However:
- Pair mutation must be fixed before any Attempt authority can be trusted (blocker 1).
- `externalSessionId` must be added to Attempt concept before authority validation works (blocker 2).
- Dispatch correlation mechanism is still unfrozen (blocker 6); this blocks `recordDispatchIntent()` design but does not block authority freeze.

Therefore: **Domain freeze is complete; implementation readiness requires the 6 blockers above.**

---

## Files changed in this adversarial tranche
- UPDATED: EXECUTION_AUTHORITY.md (revised frozen authority; added externalSessionId; removed frozenAt from authority; 9-case execution_epoch test)
- UPDATED: ATTEMPT_LIFECYCLE.md (added adversarial confirmation §4; mechanical failure resolved §5)
- UPDATED: DOMAIN_DELTA.md (added Assignment↔Pair freeze; planner-envelope reference)
- NEW: ADVERSARIAL_REVIEW_PART1.md (full Part 1 adversarial review with evidence citations)
- NEW: CORE_FREEZE_REVIEW.md (this final table and report)

No source/DB/Plan-First modifications.
