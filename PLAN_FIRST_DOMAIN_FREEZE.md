# PLAN-FIRST EXECUTION DOMAIN — Frozen Specification

Status: **FROZEN.** Implementation-ready. Resolves the unfrozen items
`DOMAIN_DELTA.md` (Contract Revision form, DB layout) and `CORE_FREEZE_REVIEW.md`
(Contract Revision form §14, Strategy/budget §15, DB layout §22) left open.

Authority of this document: it does **not** modify any closed pairing / discovery /
association decision. Where it touches Pair, Assignment, or Attempt, it consumes the
frozen rules of `EXECUTION_AUTHORITY.md`, `ATTEMPT_LIFECYCLE.md`,
`SESSION_PAIR_REPLACEMENT.md`, and `CORE_FREEZE_CLOSURE.md` unchanged.

Evidence base: see `TRANCHE_PROVENANCE.md` for tranche ownership and inspection scope.

---

## 0. Evidence classification used

| Class | Meaning | Weight |
|---|---|---|
| **FROZEN** | Explicitly confirmed domain decision in a closure/review doc | Authoritative |
| **PARTIAL** | Type or column landed, entity/repository missing | Authoritative for shape; incomplete |
| **SCAFFOLD** | Speculative code written against a model that never existed | Directional only, never authoritative |
| **TEST** | Test assumption | Weakest; never outranks design |
| **STALE** | Superseded by later frozen decision | Ignored |

Key classification results:

- `ATTEMPT_LIFECYCLE.md` — **FROZEN** (4 orthogonal dimensions, transition API).
- `EXECUTION_AUTHORITY.md` + `CORE_FREEZE_CLOSURE.md` — **FROZEN** (authority tuple).
- `CORE_FREEZE_REVIEW.md` — **FROZEN** synthesis; the authoritative decision table.
- `src/relay/domain/types.ts` — **PARTIAL**: `AttemptStatus` already narrowed to
  `prepared | running | completed_physical | interrupted`, and `VerificationStatus`,
  `PlannerAssistanceStatus`, `PlannerActionResult` exist.
- `src/relay/domain/entities.ts` — **STALE/PARTIAL**: `Attempt` was never migrated to
  match its own `AttemptStatus`. See §11.1.
- `repoBoundary.ts` + `verification_results` / `repo_observations` tables — **PARTIAL**:
  three-way consistent shapes exist with no repository and no domain class.
- `plan_first_runs` / `work_units` tables and both repository stubs — **SCAFFOLD**.
- `core_slice9_*.test.ts`, `pf1_operational.test.ts`, `core_slice8.test.ts` —
  **SCAFFOLD/TEST**; not authority.
- `DESIGN_GATE.md` — **STALE**. It specifies provenance `pair_creation` and
  `verification_state` including `manual`; current `types.ts` has `pair_binding` and
  `verified | unverified | stale`, with a unique index on
  `(runtime_session_id, project_id)`. Superseded; must not be used as a model.
- `git history` — **zero** commits for any Plan-First symbol. Nothing is restorable.

### 0.1 Blocker discovered during this tranche (must be fixed before Plan-First implementation)

`SLICE1_REPORT.md` reports Slice 1 as "Implemented". **It is not present in the working
tree.** Only fragments survived:

| Slice 1 claim | Actual state |
|---|---|
| `AttemptStatus` updated | **Present** in `types.ts:48-52` |
| `attempts` table `+session_pair_id, +worker_session_id, +external_session_id` | **Present** in `SqliteDatabase.ts:139-141` |
| `SqliteAttemptRepository` maps + persists the 3 authority fields | **Present** — `mapRow` `SqliteRepositories.ts:414-416`; `save` insert column list `:435`, `ON CONFLICT` update set `:440-442` |
| `AttemptProps`/`Attempt` gain the 3 authority fields | **ABSENT** — `entities.ts:575-583` has none |
| `Attempt.create()` takes authority | **ABSENT** — `entities.ts:607` takes 2 args, sets `status:'running'` |
| `startRunning()` / `completePhysical()`; `fail()` removed | **ABSENT** — `entities.ts:617-628` still has `complete()`→`'completed'`, `fail()`→`'failed'` |
| `dispatchAssignment` split into Phase 1 / Phase 2 (external call **outside** tx) | **ABSENT** — `RelayEngine.ts:844-988` still wraps the provider call at line 911 inside `runInTransaction` |
| `completeAssignment()` uses `.completePhysical()` | **ABSENT** — `RelayEngine.ts:1173-1175` calls `attempt.complete()` |

Consequence: `entities.ts:618` and `:624` assign `'completed'`/`'failed'`, which are no
longer in `AttemptStatus` → **the domain layer does not currently type-check**. This is
the open contradiction #4 from `CORE_FREEZE_REVIEW.md` (rated HIGH) and is a
**precondition** for any Plan-First work, because Plan-First executes through `Attempt`.

Full `tsc --noEmit` state at the time of this tranche: **153 errors — 31 in `src/`, 122
in `tests/`.** Production-source distribution: `RelayEngine.ts` 12,
`SqliteRepositories.ts` 6, `entities.ts` 4, `relayBridge.ts` 3, `SqliteDatabase.ts` 2,
`SqliteAssociationRepository.ts` 2, `browserProviders.ts` 1, `RelayApiService.ts` 1.
The Plan-First-attributable subset is the 12 + 6 + 2 = 20 errors listed in §11.1 and
§2.1 of `STOP_CONDITION_PLAN_FIRST_SQLITE.md`; the remainder are pre-existing Slice-1
and test-typing debt.

This tranche does not fix any of it (scope firewall). It is step 1 of the implementation
sequence in §15.

**Scope of the loss is narrower than `SLICE1_REPORT.md` implies.** The persistence layer
for Slice 1 **survived intact** — `SqliteAttemptRepository` already reads and writes
`session_pair_id`, `worker_session_id`, and `external_session_id`, both on insert and in
its `ON CONFLICT` update set. What was lost is confined to two files:

1. `src/relay/domain/entities.ts` — the `Attempt` entity body.
2. `src/relay/application/RelayEngine.ts` — the call sites and the transaction split.

The two `SqliteRepositories.ts` errors are therefore **downstream** of the entity, not
independent defects: they are `AttemptProps` being too narrow, because the repository was
written against the migrated entity that never landed. Fixing `entities.ts` clears
`SqliteRepositories.ts:414` and `:452` automatically. The implementer should not rewrite
the attempt repository.

---

## 0.2 Reproducible baseline for the next tranche

The prior tranche reported the suite as "267 pass / 27 fail" without stating the command
or reporter. That figure is not reproducible and should not be used as a gate. The
authoritative measurement, and the one to use going forward:

```bash
node --import tsx --test --test-reporter=tap "tests/**/*.test.ts"
# tests 294 | pass 266 | fail 28 | cancelled 0 | skipped 0
```

**Why the number is reporter-dependent.** `node --test`'s default `spec` reporter emits
no summary footer, and its `✔`/`✖` lines mix leaf tests with suite rollups at different
indentation levels. The `tap` reporter's `# fail 28` counts **14 distinct `not ok` nodes**,
of which 3 are file-level rollups (files that fail at module load) and 11 are suite-level
rollups. Any "pass count" quoted without naming the reporter and flags is meaningless.
Always quote the `tap` totals.

**The 14 failing nodes, spanning 13 files:**

| # | Failing node | Cluster |
|---|---|---|
| 1 | `CLI-backed OpenCode provider correction` | provider |
| 2 | `Core Slice 1 — Frozen Authority + Dispatch Boundary` | Slice 1 debt |
| 3 | `Core Slice 2 — Restart Reconciliation` | Slice 1/2 debt |
| 4 | `Core Slice 3 — Repository Boundary B1-B7` | repo-boundary debt |
| 5 | `Core Slice 8 — Plan-First Contract Binding` | **Plan-First** |
| 6 | `tests/core_slice9_operational.test.ts` (module load) | **Plan-First** |
| 7 | `PF1 — Happy Path Plan-First Autonomous Execution` | **Plan-First** |
| 8 | `tests/core_slice9_pf1_operational.test.ts` (module load) | **Plan-First** |
| 9 | `Electron IPC & RelayApiService Integration Tests` | integration |
| 10 | `Project, Pair, and Runtime Session Management Lifecycle and Deletion Guards` | management |
| 11 | `Manual non-null externalSessionId rejected — no provider-verified evidence` | association gate |
| 12 | `Manual planner without verified identity rejected` | association gate |
| 13 | `OpenCode provider shared-service discovery integration` | provider |
| 14 | `tests/pf1_operational.test.ts` (module load) | **Plan-First** |

**5 of 14 are Plan-First**; the other 9 are pre-existing debt in the closed
pairing/discovery/provider/association areas and are **out of scope** for the Plan-First
implementation tranche. They are not caused by, and must not be "fixed" as part of,
Plan-First work.

**Baseline for the implementation tranche:** the suite must reach `294 pass / 0 fail`
*eventually*, but the Plan-First tranche's own gate is narrower and must be stated as:

> Nodes 5, 6, 7, 8, 14 turn green; nodes 1–4 and 9–13 are **unchanged** (still failing,
> same count, same assertions). A change in any of those 9 is a regression introduced by
> the tranche, not incidental cleanup.

This is deliberately stricter than "pass count rose", which a tranche could satisfy by
deleting tests.

**Also verified for this tranche:** `tsc --noEmit` = **153 errors** (31 `src/`, 122
`tests/`), §0.1. All 31 production errors are pre-existing; the Plan-First-attributable
subset is 20 (`RelayEngine.ts` 12, `SqliteRepositories.ts` 6, `SqliteDatabase.ts` 2).

---

# A. Domain graph

```text
Project
  └── runtime_project_associations        (AUTHORITATIVE — closed tranche, untouched)
  └── Pair                                (planner runtime + worker runtime; history-bearing)
        └── Assignment                    (durable objective; pairId immutable)
              └── Attempt                 (one physical execution; frozen authority)
                    └── Delivery          (durable dispatch intent + outcome)
                    └── VerificationResult(deterministic verification record)

  └── ContractRevision                   (immutable approved intent; versioned per project)
        └── WorkUnit                     (one schedulable objective; ordinal order)
              └── Assignment              (1:1, created on first dispatch)
                    └── Attempt           (retries; attemptNumber increments)

  └── PlanFirstRun                       (execution instance of ONE ContractRevision)
        └── references ContractRevision   (immutable)
        └── references Pair              (immutable origin)
        └── drives WorkUnits             (by derivation, not by stored cursor)
```

Two independent branches meet only at dispatch:

- `Project → Pair → Assignment → Attempt` — the **execution** chain (FROZEN, closed).
- `Project → ContractRevision → WorkUnit` — the **intent** chain (frozen here).

`PlanFirstRun` is the single point that binds an approved intent to an execution
authority. It introduces **no new execution model**: every unit's work is performed by
the existing `Assignment → Attempt → Delivery` machinery through
`engine.dispatchAssignment()`.

**Explicitly not added:** `Contract` (folded into `ContractRevision` lineage),
`Strategy` (rejected), `PlannerAssistance` usage (deferred), any DAG/dependency engine,
any Plan-First-specific worker or session.

---

# B. Entity / value-object definitions

## B.1 `ContractRevision` — durable entity, immutable on approval

The **primary architectural dependency**. Resolves `DOMAIN_DELTA.md:60,96` and
`CORE_FREEZE_REVIEW.md` "Contract Revision form (§14)".

**Purpose.** An immutable, content-addressed statement of approved intent that an
execution Attempt is bound to. Implements P0 Invariant 9.

**Identity.** Generated, stable (`crev_*`). Never reused, never derived from content.

**Ownership.** Exactly one `Project`. Immutable.

**Cardinality — decisions 4, 5, 6, 7, 8 (Phase 3 answers):**

| Question | Frozen answer |
|---|---|
| 1. Entity or value? | **Durable entity.** It must be independently referenceable, independently queryable ("what did we approve?"), and referenceable by long-lived runs. A value object cannot be the FK target of `plan_first_runs`. |
| 2. Stable ID? | **Yes** — generated. Required: Attempt/run must reference the exact revision. |
| 3. Immutable after creation? | **Content is immutable from creation.** Not "after approval" — an unapproved revision is a proposal, and silently editing a proposal that a run already references would violate frozen authority. Editing intent means **creating a new revision**. Status is the only mutable field, and only `draft → approved`. |
| 4. Multiple revisions per Contract? | **Yes — and this is the whole point.** There is **no separate `Contract` entity**. "The contract of a project" *is* the ordered lineage of its `ContractRevision` rows. One revision per distinct semantic intent. |
| 5. What causes a new revision? | A change in **semantic intent**, detected by `canonicalDigest`. Whitespace, key ordering, or unrelated document sections that leave the digest unchanged **do not** create a revision and do not invalidate in-flight work (P0 Invariant 9). |
| 6. Run references Contract or Revision? | **`ContractRevision` only.** A run executes exactly one approved intent. Referencing "the Contract" would be a mutable indirection and would permit silent intent switch. |
| 7. Can a run change revision? | **No.** `contractRevisionId` is immutable for the life of the run. Reject any attempt to change it (Invariant 7). |
| 8. Effect of a new revision on historical runs? | **None.** Historical runs keep executing/referencing their own revision forever. A new revision creates a **new** run; it never migrates, re-points, or invalidates an existing run. Superseded revisions remain readable and are never deleted (see §E `ON DELETE RESTRICT`). |
| 11. Must survive restart | Everything. It is the authority for "what was approved". |
| 12. Can anything stay derived? | The **field list** used for canonicalization is not persisted. Canonicalization happens once, at creation; `canonicalText` (already canonical) is stored, so the digest is never recomputed. |

**Canonicalization rule (frozen, from `core_slice7.test.ts` C1–C3):**

```text
canonicalDigest = sha256( JSON.stringify(semanticFields, sortedKeyReplacer) )
```

where `semanticFields` is the **explicit, author-declared** set of semantic keys.
This single rule satisfies all three acceptance cases:

- C1 — key order / whitespace irrelevant → sorted-key replacer.
- C2 — semantic change alters digest → changed value changes the hash.
- C3 — unrelated document section does **not** alter digest → unlisted keys are
  excluded by the replacer, so they never enter the hash.

**Fields.**

| Field | Type | Mutability | Notes |
|---|---|---|---|
| `id` | id | immutable | PK |
| `projectId` | id | immutable | owner |
| `canonicalText` | string | immutable | canonical JSON of the semantic fields |
| `canonicalDigest` | string | immutable | sha256 hex; semantic identity |
| `status` | `draft` \| `approved` | `draft → approved` only | execution gate |
| `sourceRef` | string? | immutable | plan document path; provenance/audit only |
| `approvedBy` | string? | set on approval | actor (`human`, planner identity) |
| `approvedAt` | number? | set on approval | |
| `createdAt` | number | immutable | |

**Invariants.**
1. `status === 'approved'` ⟹ `approvedBy != null && approvedAt != null`.
2. Content fields are write-once. Any content change requires a new `id`.
3. Uniqueness: `(projectId, canonicalDigest)`. The same semantic intent must not exist
   as two revisions. This also makes revision creation **idempotent** — re-submitting an
   unchanged contract returns the existing revision rather than creating a duplicate.
4. Execution requires `status === 'approved'` (P0 Invariant 9 gate).
5. A revision referenced by any run cannot be deleted.

**Lifecycle.** `draft → approved` (terminal). No other transition. No delete while runs
exist.

**Deliberately rejected representations.** A standalone `Contract` table (redundant —
the lineage is the contract); a `fieldList` column (never needed after creation); a
`parentRevisionId` lineage pointer (P0 requires new revision on change, not a chain —
a chain would invite "latest revision" resolution, i.e. a recency heuristic, which is a
closed-tranche-prohibited pattern).

## B.2 `PlanFirstRun` — durable entity

**Purpose.** One execution instance of one approved `ContractRevision` under one
`Pair`. Owns run-level lifecycle and enforces one-active-run-per-revision.

**Identity.** Generated, stable (`pfr_*`).

**Ownership.** One `Project`.

**Fields.**

| Field | Type | Mutability | Notes |
|---|---|---|---|
| `id` | id | immutable | PK |
| `projectId` | id | immutable | |
| `contractRevisionId` | id | **immutable** | the bound intent; no silent switch |
| `contractDigest` | string | **immutable** | snapshot of the revision digest at creation |
| `sessionPairId` | id | **immutable** | origin Pair; soft reference (see §E) |
| `status` | `ready`\|`running`\|`blocked`\|`completed`\|`cancelled` | mutable | lifecycle |
| `createdAt` | number | immutable | |
| `updatedAt` | number | mutable | |

`contractDigest` is retained as an **immutable denormalized snapshot**. Both sides are
immutable, so it cannot drift; it lets recovery verify "the run is bound to exactly this
intent" without a join, and keeps the run auditable if the revision is ever superseded.
A validation rule asserts `run.contractDigest === revision.canonicalDigest` on load.

**What is NOT stored (Phase 4 decision — "current work unit"):**

| Dropped | Reason |
|---|---|
| `currentWorkUnitId` | **Derived.** A mutable cross-aggregate cursor is precisely the failure class that produced the Slice-1 authority problems. Derivation from immutable `(ordinal, status)` inputs is deterministic across restart, so persistence adds no information and adds drift risk. Derivation rule in §D.2. |
| `currentStrategyId` | `Strategy` rejected (§B.5). |
| `currentAttemptId` | Derived via `WorkUnit.assignmentId → Assignment.currentAttemptId`. The existing FK was `ON DELETE CASCADE` from `attempts` — **inverted**: deleting an attempt would silently delete the run. Removing it eliminates a live data-loss hazard. |

**Creation.** Requires an **approved** revision and a Pair that currently has a bound
worker runtime. Requires ≥1 `WorkUnit` (a run with nothing to do is not a run; this
removes the degenerate `ready → completed` transition).

**Invariants.**
1. `status === 'completed'` ⟺ every work unit of `contractRevisionId` is `completed`.
2. At most **one** non-terminal run per `(projectId, contractRevisionId)`.
3. `status ∈ {completed, cancelled}` ⟹ no further transitions.
4. `contractDigest` must equal the bound revision's digest.
5. `sessionPairId` never changes, including across Pair replacement.

## B.3 `WorkUnit` — durable entity

**Purpose.** One schedulable, independently verifiable objective within an approved
revision.

**Identity.** Generated, stable (`wu_*`).

**Ownership (Phase 5 decision 2).** One `ContractRevision` — **not** a run. A unit is a
property of the approved intent, so the revision is self-contained and auditable
("this revision consists of these units"). It is not owned by an execution instance.

> Deviation from SCAFFOLD: the speculative signature is
> `WorkUnit.create(projectId, contractRevisionId, objective, instruction)` and the table
> carries `project_id`. `projectId` is **dropped** — it is derivable through the
> revision, and duplicating it creates a second ownership pointer that can disagree
> (`unit.project ≠ revision.project`). Build units from the revision.

**Fields.**

| Field | Type | Mutability | Notes |
|---|---|---|---|
| `id` | id | immutable | PK |
| `contractRevisionId` | id | immutable | owner |
| `ordinal` | integer | **immutable** | 1-based execution order; the ordering model |
| `objective` | string | immutable | short statement of the goal |
| `instruction` | string | immutable | exact text dispatched to the worker |
| `status` | `pending`\|`in_progress`\|`blocked`\|`completed` | mutable | lifecycle |
| `assignmentId` | id? | set once | 1:1 link to its `Assignment`; see below |
| `createdAt` | number | immutable | |
| `updatedAt` | number | mutable | |

`assignmentId` is written **once**, on first dispatch, and never changed. It is the
recovery anchor: `unit → assignment → attempt → verification` in one hop each. It exists
precisely so that "already dispatched" is durably known — a unit with a non-null
`assignmentId` and a non-completed status is never naively re-dispatched. FK is
`ON DELETE RESTRICT` so the pointer can never be silently orphaned into a re-dispatch
(Invariant 1, §D).

**Phase 5 dependency decision — `dependsOn`: NOT INCLUDED.**

Evidence: `depends` appears only in SCAFFOLD test data. No FROZEN document mentions
work-unit dependencies. Ordinal order already determines execution deterministically,
and the milestone is strictly sequential. A DAG is generalized workflow infrastructure,
explicitly forbidden by the scope firewall. The existing `dependencies TEXT` column is
an unparsed blob with no reader — it encodes an intent nobody designed.

- Eligibility = *all lower-ordinal units are `completed`*. Fully derived from `ordinal`.
- If multi-dependency is ever required it is a separate tranche; `ordinal` remains the
  deterministic tie-break and migration is additive.

**Phase 5 concurrency decision: NONE.** One `in_progress` unit per revision, enforced by
a partial unique index. Rationale: no FROZEN requirement for concurrency; sequential is
deterministic and provable.

**Completion / acceptance.** A unit becomes `completed` **only** when a
`VerificationResult` with `result === 'passed'` exists for its current attempt. Never
from worker self-claim, never from provider UI, never from window inspection.

## B.4 Execution attempt — **reuses the existing FROZEN `Attempt`**

Phase 6 answer: **Plan-First introduces no new attempt entity.**

`P0 Invariant 3` already defines `Attempt` (`attemptNumber`) + `Assignment`
(`currentAttemptId`). `ATTEMPT_LIFECYCLE.md` already defines attempt as *one physical
execution instance* with 4 orthogonal dimensions. Duplicating it for Plan-First would
create exactly the "hidden worker/session architecture" that is a closed-tranche
prohibited pattern.

- **WorkUnit owns an attempt counter?** **No.** Derived as
  `count(attempts where assignmentId = unit.assignmentId)`. A second counter would be a
  third place for attempt numbering to disagree.
- **Is an execution attempt a durable entity?** **Yes — the existing one.** It must be
  durable because restart must reconstruct "was this dispatched, and did it complete?"
  without consulting provider UI.
- **One Assignment per WorkUnit.** Not one per run. `Assignment` is the durable objective
  (P0 Invariant 3) and each unit is a distinct objective with a distinct `instruction`.
  Reusing one assignment and rewriting `instruction` would rewrite dispatch truth —
  forbidden by `EXECUTION_AUTHORITY.md` §5.
- **Reuse, unchanged:** `assignments`, `attempts`, `deliveries`, `handoffs`, `events`,
  `attention_items`, `verification_results`.

## B.5 `VerificationResult` — durable record, **reused as-is**

Already three-way consistent: `types.VerificationStatus`
(`not_run|passed|failed|blocked`), `repoBoundary.VerificationResult` (DTO), and the
`verification_results` table. `ATTEMPT_LIFECYCLE.md` Dimension B confirms verification is
a **separate linked record**, and that verification state never mutates physical
execution state.

Retained unchanged. Plan-First consumes it; it does not extend it.

| Question | Frozen answer |
|---|---|
| Mechanical verification produces | A `VerificationResult` row: `attemptId`, `result`, optional `checkId`, `evidence`, timestamps. |
| Planner/semantic verification | **Deferred** (§7). Milestone 1 is deterministic verification only. |
| Acceptance | `result === 'passed'` for the unit's current attempt. |
| Retry | New `Attempt` (`attemptNumber + 1`) through the existing dispatch path. |
| Retry budget | **Deferred** — `P0 Invariant 10` / `DOMAIN_DELTA.md` leave limits and schema explicitly unfrozen and non-hard-coded. Inventing a budget now is new architecture. For milestone 1, retry is explicit and guarded by the existing `AmbiguousDeliveryResendError` / `DuplicateDeliveryAttemptError` / `activeDelivery` guards. |
| After exhaustion | **Deferred** with the budget. Unit → `blocked`; run → `blocked`; `AttentionItem` raised; **await planner/human**. The engine never self-declares terminal failure (`ATTEMPT_LIFECYCLE.md` Case 4, §5). |

## B.6 `Strategy` — **REJECTED for this milestone**

Evidence: appears only as "Strategy Lineage", explicitly **unfrozen**
(`DOMAIN_DELTA.md:39-42,97`; `CORE_FREEZE_REVIEW.md` "Strategy Lineage / budget schema
(§15)"). No table, no domain class, no test need, no milestone need. `plan_first_runs`
merely carried an unused `current_strategy_id`.

Introducing it now = inventing architecture to compensate for absent scaffolding.
**Rejected.** Retry in milestone 1 is a new Attempt under the same intent.

## B.7 `PlannerAssistance` / planner protocol — **DEFERRED**

Evidence is strong but the protocol is explicitly unfrozen: `DOMAIN_DELTA.md` Part 1 C
freezes the *envelope* and 7 stale rules; `types.PlannerAssistanceStatus` /
`PlannerActionResult` exist; `planner_assistances` / `planner_action_requests` tables
exist. But message *syntax* is unfrozen, and nothing in the operational milestone
requires it. Deferred. Tables stay unused exactly as today; no removal needed.

## B.8 Concepts explicitly **not** created

- `Contract` (folded into `ContractRevision` lineage).
- Work-unit `dependsOn` / DAG edges.
- Work-unit attempt counter.
- Run-level `suspended` state (see §C.1).
- Work-unit `cancelled` state (see §C.2).
- Any Plan-First-specific worker, session, or dispatch path.
- Retry/budget/strategy tables.

---

# C. State machines

## C.1 `PlanFirstRun`

```text
              ┌──────────────────────────────┐
              │                              ▼
   [create] → ready ────────────────────► running ──────────► completed  (TERMINAL)
              │                              │  ▲
              │                              │  └──┐
              │                              ▼     │ (planner/human resolves)
              └──────────────────────────► blocked ─┘
                             │                  │
                             ▼                  ▼
                          cancelled          cancelled
                          (TERMINAL)         (TERMINAL)
```

| From | Event | To | Guard |
|---|---|---|---|
| — | create | `ready` | revision `approved`; ≥1 work unit; pair has bound worker; no non-terminal run for `(project, revision)` |
| `ready` | first unit enters `in_progress` | `running` | |
| `ready` | cancel | `cancelled` | explicit |
| `running` | a unit completes and a later eligible unit exists | `running` | derived cursor advances |
| `running` | **last** unit completes | `completed` | **TERMINAL** |
| `running` | unit → `blocked` (verification failed/inconclusive, or ambiguous delivery) | `blocked` | |
| `running` | cancel | `cancelled` | explicit |
| `blocked` | planner/human resolves; unit retried | `running` | |
| `blocked` | cancel | `cancelled` | explicit |
| `completed` | — | — | **no transitions** |
| `cancelled` | — | — | **no transitions** |

**No `suspended` state (newly frozen).** Phase 7 requirement 9 — "missing provider
runtime suspends execution rather than corrupting run state" — is satisfied *without* a
run-level state: the unit's `Attempt` becomes `interrupted` (`ATTEMPT_LIFECYCLE` Case 5)
and an `AttentionItem` is raised. Dispatch then fails naturally with
`RuntimeNotAvailableError`. A run-level `suspended` would duplicate state that already
exists one level down and would need its own recovery rules.

## C.2 `WorkUnit`

```text
   [create] → pending ──────────────► in_progress ──────────► completed (TERMINAL)
                 ▲                       │      ▲
                 │                       │      │
                 │  (dispatch confirmed   │      │ planner/human resolves
                 │   NOT delivered —      │      │
                 └───────────────────────┤      │
                                         ▼      │
                                      blocked ───┘
```

| From | Event | To | Guard |
|---|---|---|---|
| — | create | `pending` | `ordinal` unique within revision |
| `pending` | dispatch confirmed delivered; attempt `running` | `in_progress` | `assignmentId` set once; at most one `in_progress` per revision |
| `in_progress` | `VerificationResult.result === 'passed'` for current attempt | `completed` | **TERMINAL**; the only path to completion |
| `in_progress` | verification `failed` / `blocked` / `not_run` | `blocked` | attempt stays `completed_physical`; assignment stays `unresolved` |
| `in_progress` | delivery `ambiguous` | `blocked` | `AttentionItem`; **never auto-retry** (no blind resend) |
| `in_progress` | delivery confirmed `failed` (no physical execution) | `pending` | safe to re-dispatch; no work occurred |
| `in_progress` | runtime lost mid-work | `in_progress` | attempt → `interrupted`; unit status unchanged so the attempt is retained |
| `blocked` | explicit retry after resolution | `in_progress` | new `Attempt`, `attemptNumber + 1` |
| `completed` | — | — | **no transitions** |

**No `cancelled` state (newly frozen).** Cancelling a run abandons its remaining
`pending` units, which simply never run. A `cancelled` unit state would be dead state
with no recovery rule.

**Critical:** a unit is never `completed` by dispatch success, worker claim, handoff
delivery, or provider inspection. Only `VerificationResult === 'passed'`.

## C.3 `ContractRevision`

```text
   [create] → draft ──approve(actor)──► approved  (TERMINAL, content immutable)
```

No other transition. Content immutable from creation. Delete forbidden while referenced
by any run.

---

# D. Recovery rules

Stated independently of SQLite, per Phase 7.

## D.1 The ten invariants

| # | Invariant | How the design enforces it |
|---|---|---|
| 1 | An accepted `WorkUnit` is never dispatched again. | `completed` is terminal (§C.2) and the only path to it requires `VerificationResult === 'passed'`. Derived selection only considers `pending` units. |
| 2 | A completed `PlanFirstRun` never restarts execution. | `completed` is terminal; the tick returns `already_completed` before any selection. |
| 3 | Restart reconstructs the same authoritative run. | Run identity, revision binding, digest, and pair are all persisted and immutable. The cursor is derived from persisted `(ordinal, status)`, so it is a pure function of durable state. |
| 4 | Work-unit ordering stays deterministic. | Ordering is the immutable integer `ordinal` with a uniqueness constraint. Never `created_at`, never a recency or first-result heuristic. |
| 5 | Duplicate controller ticks are safe. | Ticks are read-derive-then-act. The only mutation that can race is unit selection, guarded by the partial unique index allowing one `in_progress` unit per revision; a losing tick observes the winner's state and advances instead of re-dispatching. Existing `ambiguous` / `activeDelivery` guards block re-dispatch of a single unit. |
| 6 | Repeated persistence cannot create duplicates. | `UNIQUE (contract_revision_id, ordinal)` on units; `UNIQUE (project_id, canonical_digest)` on revisions; partial `UNIQUE (project_id, contract_revision_id) WHERE status NOT IN ('completed','cancelled')` on runs. Re-running setup is idempotent at the database level. |
| 7 | A run cannot silently switch `ContractRevision`. | `contractRevisionId` and `contractDigest` are immutable; validated on every load; no transition writes them. A new revision requires a new run. |
| 8 | Pair/runtime provider rediscovery cannot change Plan-First ownership. | `sessionPairId` is immutable. Per-`Attempt` authority `(sessionPairId, workerSessionId, externalSessionId)` is frozen at dispatch (`EXECUTION_AUTHORITY.md`). `RuntimeSession.updateExternalIdentity()` cannot advance an existing attempt. Pair replacement creates a **new** Pair and never mutates the run's origin reference. |
| 9 | A missing provider runtime suspends execution rather than corrupting run state. | Dispatch fails with `RuntimeNotAvailableError` before any state transition. The attempt is left `prepared`, the unit stays `in_progress` (or returns to `pending` on confirmed non-delivery), an `AttentionItem` is raised, and the run keeps its state. No fabricated completion, ever. |
| 10 | Recovery distinguishes resumable work from terminal failure. | Terminal = unit `completed`, or run `completed`/`cancelled`. Everything else is resumable: `pending` → select; `in_progress` with attempt `interrupted`/`prepared` → reconcile dispatch intent, never blind resend; `blocked` → await planner/human. |

## D.2 Derived cursor (the replacement for `currentWorkUnitId`)

```text
units      = workUnits of run.contractRevisionId, ordered by ordinal ASC
if any unit.status == 'in_progress'      → that unit is current   (at most one)
else if any unit.status == 'blocked'     → most recent blocked unit; run is blocked
else                                      → first unit with status 'pending'
                                             (all lower-ordinal units are 'completed'
                                              by construction of the scan)
else                                      → none; run is completed
```

Pure function of persisted state. No stored pointer, so it cannot drift and needs no
repair on recovery.

## D.3 What must never be inferred from provider UI

Current work unit; unit completion; run completion; whether work was dispatched;
whether an instruction was received. Provider observation may only corroborate a
`Delivery` outcome or raise an `AttentionItem`. Ambiguity resolves to
`blocked` + attention, never to a guess.

---

# E. Persistence specification

Conceptual only. **No migrations are written in this tranche.**

## E.1 `contract_revisions` — NEW

Referenced by existing FKs but **never created**; this is the reason both Plan-First
tables are currently unwritable.

| Column | Type | Constraints |
|---|---|---|
| `id` | TEXT | PK |
| `project_id` | TEXT | NOT NULL, FK → `projects(id)` ON DELETE CASCADE |
| `canonical_text` | TEXT | NOT NULL |
| `canonical_digest` | TEXT | NOT NULL |
| `status` | TEXT | NOT NULL DEFAULT `'draft'` |
| `source_ref` | TEXT | NULL |
| `approved_by` | TEXT | NULL |
| `approved_at` | INTEGER | NULL |
| `created_at` | INTEGER | NOT NULL |
| — | — | **UNIQUE (`project_id`, `canonical_digest`)** |
| — | — | index on `project_id` (covered by the unique index) |

## E.2 `plan_first_runs` — REUSABLE **with migration**

Structurally right for its purpose; three columns must be dropped and one FK changed.

| Column | Action | Notes |
|---|---|---|
| `id` | keep | PK |
| `project_id` | keep | NOT NULL, FK → `projects` CASCADE |
| `contract_revision_id` | keep, **change FK to `ON DELETE RESTRICT`** | RESTRICT: executed intent must not be deletable. Superseding means a new revision, never deletion. |
| `contract_digest` | keep | immutable snapshot |
| `session_pair_id` | keep, **drop FK** | Soft reference. Rationale: this is immutable *historical provenance* (like the frozen `externalSessionId` snapshot), not a live relationship. Deleting a Pair must not delete or nullify the record of what a run executed under. Preserves the id under Pair replacement, consistent with `SESSION_PAIR_REPLACEMENT.md`. |
| `status` | keep | DEFAULT `'ready'` |
| `created_at`, `updated_at` | keep | |
| `current_work_unit_id` | **DROP** | derived (§D.2) |
| `current_strategy_id` | **DROP** | `Strategy` rejected |
| `current_attempt_id` | **DROP** | derived; FK was `ON DELETE CASCADE` from `attempts` — inverted and a live data-loss hazard |
| — | **ADD** | **partial UNIQUE (`project_id`, `contract_revision_id`) WHERE `status NOT IN ('completed','cancelled')`** |
| — | **ADD** | index on `project_id` |

## E.3 `work_units` — REUSABLE **with migration**

| Column | Action | Notes |
|---|---|---|
| `id` | keep | PK |
| `contract_revision_id` | keep | NOT NULL, FK → `contract_revisions` CASCADE |
| `ordinal` | **ADD** | NOT NULL INTEGER; the ordering model |
| `objective` | keep | NOT NULL |
| `instruction` | keep | make NOT NULL (was nullable) — every unit must be dispatchable |
| `status` | keep | DEFAULT `'pending'` |
| `assignment_id` | **ADD** | NULL TEXT, FK → `assignments(id)` **ON DELETE RESTRICT**; written once |
| `created_at`, `updated_at` | keep | |
| `project_id` | **DROP** | derivable via revision; removing a second ownership pointer that can disagree |
| `dependencies` | **DROP** | not required for the milestone; was an unparsed blob with no reader |
| — | **ADD** | **UNIQUE (`contract_revision_id`, `ordinal`)** |
| — | **ADD** | **partial UNIQUE (`contract_revision_id`) WHERE `status = 'in_progress'`** — enforces sequential execution |
| — | **ADD** | index on (`contract_revision_id`, `status`) |

## E.4 Unchanged — reused as-is

`projects`, `runtime_sessions`, `runtime_project_associations`, `pairs`, `assignments`,
`attempts` (authority columns already present), `deliveries`, `handoffs`, `events`,
`attention_items`, `repo_observations`.

`planner_assistances`, `planner_action_requests` — remain unused (deferred, §B.7). Not
created by Plan-First, not removed by it.

## E.4.1 `verification_results` — one **additive** change

Reused, but one constraint is required for the §G step-10 idempotency guard:

| Change | Reason |
|---|---|
| **ADD** `UNIQUE (attempt_id)` | One verification result per attempt. Without it, a crash-and-retry can leave two conflicting results for the same attempt and the resume path becomes non-deterministic. |

| Pre-existing defect | Disposition |
|---|---|
| `result TEXT NOT NULL DEFAULT 'unknown'` — `'unknown'` is not a member of `VerificationStatus` (`not_run\|passed\|failed\|blocked`) | Change the default to `'not_run'`. This is a one-word schema correction that makes the column consistent with the already-frozen type; it does not extend the domain. Flagged in §12 #10. |

## E.5 Migration-order note (for the implementation tranche)

`contract_revisions` **must** be created before any write to `work_units` or
`plan_first_runs`. Because both tables already exist with an FK to a missing parent, the
ordering is forced. Existing rows: none can exist (the tables have never been writable),
so no data backfill is required — the migration is structural only.

**SQLite mechanics the implementer must respect.** SQLite cannot add a `UNIQUE (…)`
*constraint* to an existing table; only `CREATE UNIQUE INDEX` can be added incrementally.
The composite and partial unique constraints required by §E.2/§E.3 therefore need either
(a) a **table rebuild** — `CREATE TABLE …_new` with the constraints inline, copy zero
rows, drop, rename — or (b) expression-equivalent unique **indexes**. Option (a) is
preferred here precisely because the tables are empty.

The two **partial** unique indexes (§E.2 one-active-run, §E.3 one-in-progress-unit) can
be created directly:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_plan_first_runs_active
  ON plan_first_runs(project_id, contract_revision_id)
  WHERE status NOT IN ('completed', 'cancelled');

CREATE UNIQUE INDEX IF NOT EXISTS ux_work_units_in_progress
  ON work_units(contract_revision_id)
  WHERE status = 'in_progress';
```

These are **not** cosmetic. They are the database-level enforcement of Invariants 5 and 6
(§D.1) — they are what makes duplicate selection and duplicate logical work units
impossible even if application logic regresses. A tick that loses the application-level
race fails its `save()` with a constraint violation instead of silently double-dispatching.

---

# F. Repository interfaces

Derived from actual controller/domain use cases in §G. No method is retained merely
because the SCAFFOLD stub had it. `any` is eliminated.

```ts
// ---- ContractRevision ----
export interface IContractRevisionRepository {
  findById(id: ContractRevisionId): Promise<ContractRevision | null>;
  findByProjectId(projectId: ProjectId): Promise<ContractRevision[]>;
  /** Idempotent creation: returns the existing revision when
   *  (projectId, canonicalDigest) already exists. */
  findByDigest(
    projectId: ProjectId,
    canonicalDigest: string,
  ): Promise<ContractRevision | null>;
  save(revision: ContractRevision): Promise<void>;
}

// ---- PlanFirstRun ----
export interface IPlanFirstRunRepository {
  findById(id: PlanFirstRunId): Promise<PlanFirstRun | null>;
  findByContractRevisionId(
    contractRevisionId: ContractRevisionId,
  ): Promise<PlanFirstRun[]>;
  /** Guards Invariant 6: at most one non-terminal run per (project, revision). */
  findActiveByContractRevisionId(
    projectId: ProjectId,
    contractRevisionId: ContractRevisionId,
  ): Promise<PlanFirstRun | null>;
  findByProjectId(projectId: ProjectId): Promise<PlanFirstRun[]>;
  save(run: PlanFirstRun): Promise<void>;
}

// ---- WorkUnit ----
export interface IWorkUnitRepository {
  findById(id: WorkUnitId): Promise<WorkUnit | null>;
  /** Ordered by `ordinal` ASC. This is the only ordering primitive; the domain
   *  derives eligibility and the cursor from it. */
  findByContractRevisionId(
    contractRevisionId: ContractRevisionId,
  ): Promise<WorkUnit[]>;
  /** Guards duplicate selection under concurrent ticks (Invariant 5). */
  findInProgressByContractRevisionId(
    contractRevisionId: ContractRevisionId,
  ): Promise<WorkUnit | null>;
  save(unit: WorkUnit): Promise<void>;
}
```

### F.1 Reused repositories that §G additionally requires

These are **not** new domains — they are existing classic concepts that Plan-First
consumes. `IVerificationResultRepository` does **not** exist today
(`IRelayRepositories.verificationResults?: any`), so it must be introduced as a typed
interface; the other two already exist and need no signature change.

```ts
export interface IVerificationResultRepository {
  findById(id: VerificationResultId): Promise<VerificationResult | null>;
  /** REQUIRED by the §G step-10 idempotency guard. Must return at most one
   *  row; a `VerificationResult` is a singleton per Attempt. Enforce with
   *  UNIQUE (attempt_id) or by treating a first-writer-wins insert as terminal. */
  findByAttemptId(attemptId: AttemptId): Promise<VerificationResult | null>;
  save(result: VerificationResult): Promise<void>;
}
```

| Method used by §G | Existing? | Note |
|---|---|---|
| `verificationResults.findByAttemptId` | **NO** — must be added | the idempotency guard; enforces one result per attempt |
| `attention.append(...)` | yes (`IAttentionRepository`) | `AttentionItem` raised on block/ambiguity/absent worker |
| `assignments.save` / `attempts.save` / `deliveries.save` | yes | unchanged, used via `dispatchAssignment()` |

`repo_observations` is **not** required by §G (deferred, §B.7 / §11.1).

**Deleted from the SCAFFOLD contract, with reasons:**

| Removed | Reason |
|---|---|
| `findNextEligible(revisionId, afterUnit?)` | Returned `{id, objective, status}` while its only caller assigned it to a scalar `currentWorkUnitId` — the stub contradicted its own caller. Eligibility is now a pure domain function over an ordinal-ordered list (§D.2). The `afterUnit` hint is unnecessary because ordering is total. |
| `updateStatus(id, status)` | Free-text status mutation bypassing domain invariants. All transitions go through `WorkUnit` domain methods. |
| `findByContractAndStatus(revisionId, status?)` | Subsumed by `findByContractRevisionId` + domain filtering. Status-filtered persistence queries push domain logic into SQL. |
| `IPlanFirstRunRepository.findById → any` | Now typed; row→entity mapping is explicit. |

**Required transaction boundaries** (all must be atomic):

1. **Unit selection + assignment creation** — set `unit.status = 'in_progress'` and
   `unit.assignmentId` together. A crash between them would either lose the dispatch
   record (re-dispatch hazard) or strand a unit with no assignment.
2. **Unit completion** — `unit.status = 'completed'`, `Assignment` resolution, and
   `VerificationResult` insert together.
3. **Unit block** — `unit.status = 'blocked'`, `run.status = 'blocked'`,
   `AttentionItem` insert together.
4. **Contract approval** — `revision.status`, `approvedBy`, `approvedAt` together.

`dispatchAssignment()` must **not** be wrapped together with unit selection: per
`SLICE1_REPORT.md` and `CORE_FREEZE_CLOSURE.md` §4, the provider call must sit outside
the DB transaction. Note this split is currently **absent** from the code (§0.1) and must
be restored as part of the Slice-1 re-implementation, not invented here.

**Memory implementations** are required for parity with every other repository (they are
what `MemoryRelayDatabase.runInTransaction` snapshots) and must implement the same
ordering and filter semantics.

---

# G. Controller algorithm

One production tick. Deterministic; no architectural choices remain for the implementer.

```text
runPlanFirstTick(runId, requestedUnitId? = undefined) -> TickResult

  1  run      = planFirstRuns.findById(runId)
     if run is null                      -> throw NOT_FOUND
                                              ("PlanFirstRun not found")

  2  if run.status in {completed, cancelled}
                                            -> return { transition: 'run_terminal',
                                                        runId, no side effects }
     # Invariant 2: terminal runs never execute again.

  3  revision = contractRevisions.findById(run.contractRevisionId)
     if revision is null                  -> throw NOT_FOUND
     if revision.status != 'approved'     -> throw CONTRACT_NOT_APPROVED
     if run.contractDigest != revision.canonicalDigest
                                            -> throw CONTRACT_BINDING_MISMATCH
                                              # Invariant 7 — refuse, never repair.

  4  units = workUnits.findByContractRevisionId(run.contractRevisionId)   # ordinal ASC
     if units is empty                    -> throw INVALID_STATE
                                              # creation invariant: >= 1 unit

  5  # ---- Derive current unit (D.2). No stored cursor. ----
     inFlight = units.find(u => u.status == 'in_progress')
     blocked   = units.filter(u => u.status == 'blocked')

  6  if inFlight is not null:
        # A unit is already executing. Never start a second one.
        target = inFlight
        if target.assignmentId is null    -> throw INVALID_STATE   # torn state, see F
        current = assignments.findById(target.assignmentId)
        attempt = current is null or current.currentAttemptId is null
                  ? null : attempts.findById(current.currentAttemptId)

        if attempt is null:
            # No attempt yet: this unit is selected but not dispatched.
            -> dispatchUnit(run, target)   # go to step 8 dispatch path

        if attempt.status in {completed_physical}:
            -> verifyUnit(run, target, current, attempt)   # step 9

        if attempt.status == 'interrupted':
            # Runtime lost. Inspect before deciding; never assume rollback.
            -> inspectAndReconcile(run, target, current, attempt)

        if attempt.status in {prepared, running}:
            # Dispatch in flight or executing. Re-inspect, do not re-dispatch.
            -> reconcileInFlight(run, target, current, attempt)

  7  else if blocked.length > 0:
        # Engine must NOT self-declare failure. Wait for planner/human.
        if run.status != 'blocked':
            run.status = 'blocked'; planFirstRuns.save(run)   # txn 3
        -> return { transition: 'blocked_awaiting_planner', runId,
                    workUnitId: blocked[0].id, plannerUpdateRequired: true,
                    blocker: 'verification_blocked' }

  8  else:
        # All prior units completed; pick the next.
        target = units.find(u => u.status == 'pending')
        if target is null:
            run.status = 'completed'; planFirstRuns.save(run)
            -> return { transition: 'run_completed', runId }
              # Invariant 1: nothing re-dispatches.

        # ---- Selection + assignment creation, atomically (txn 1) ----
        runInTransaction:
            re-read target; if target.status != 'pending' -> ABORT (lost race;
                a concurrent tick won; return 'selection_raced' and let it proceed)
            assignment = Assignment.create(
                pairId  = run.sessionPairId,
                projectId = run.projectId,
                title   = target.objective,
                instruction = target.instruction)
            assignments.save(assignment)
            target.status = 'in_progress'
            target.assignmentId = assignment.id
            workUnits.save(target)
            # Selecting a unit puts the run in 'running' from EITHER 'ready'
            # (first unit) OR 'blocked' (the planner/human resolved the blocker
            # and the blocked unit was retried or cleared). Never leave
            # run.status == 'blocked' while a unit is executing.
            run.status = 'running'
            planFirstRuns.save(run)
        # Invariant 5: partial unique index allows only one in_progress per revision.

        -> dispatchUnit(run, target)

  9  # ---- dispatchUnit(run, unit) ----
     pair = pairs.findById(run.sessionPairId)
     if pair is null or pair.workerSessionId is null
                                            -> raise ATTENTION; unit stays in_progress
                                              # Invariant 9: suspend, never fabricate
     current = assignments.findById(unit.assignmentId)
     if current has an 'ambiguous' delivery    -> mark unit 'blocked'; ATTENTION
                                              # no blind resend
     if current has a 'delivering' delivery   -> return { transition: 'dispatch_in_flight' }
                                              # crash-equivalent; reconcile, do not resend

     { assignment, attempt, delivery } = dispatchAssignment(current.id)
     # Inside dispatchAssignment: authority frozen at Attempt.create
     #   (sessionPairId, workerSessionId, externalSessionId); durable intent committed
     #   BEFORE the provider call; provider call OUTSIDE the transaction.

     if delivery.status == 'delivered':
          -> verifyUnit(run, unit, assignment, attempt)

     if delivery.status == 'failed':
          # Confirmed NOT delivered: no physical execution occurred.
          txn: unit.status = 'pending'; unit.assignmentId RETAINED;
               workUnits.save(unit)
          -> return { transition: 'dispatch_not_delivered', runId,
                      workUnitId: unit.id, retryable: true }

     if delivery.status == 'ambiguous':
          txn 3: unit.status = 'blocked'; run.status = 'blocked';
                ATTENTION (critical)
          -> return { transition: 'dispatch_ambiguous', runId, workUnitId: unit.id,
                      plannerUpdateRequired: true, blocker: 'ambiguous_delivery' }

 10  # ---- verifyUnit(run, unit, assignment, attempt) ----
     # IDEMPOTENCY GUARD (Invariants 5, 6). A crash between "VerificationResult
     # written" and "unit completed" leaves attempt.status == 'completed_physical'
     # with a VerificationResult already present. Step 6 will route back here on
     # restart, so verification must RESUME, never re-run and never double-insert.
     existing = verificationResults.findByAttemptId(attempt.id)
     if existing is not null:
         result = { outcome: existing.result, checkId: existing.checkId,
                    evidence: existing.evidence }
         insertResult = false
     else:
         result = mechanicalVerification.evaluate(attempt, revision, unit)
         # Deterministic only for milestone 1. Records a VerificationResult row.
         # It MUST NOT read provider UI to decide correctness.
         insertResult = true

     txn 2:
         if insertResult:
             verificationResults.save(VerificationResult.create(
                 attemptId = attempt.id, result = result.outcome,
                 checkId = result.checkId, evidence = result.evidence))

         if result.outcome == 'passed':
             unit.status = 'completed'            # the ONLY path to completed
             workUnits.save(unit)
             assignment.complete()                # assignment becomes 'completed'
             assignments.save(assignment)
             # NOTE: attempt stays 'completed_physical'. Verification does NOT
             #       mutate physical execution state. (ATTEMPT_LIFECYCLE §1, Case 4)
             remaining = units.filter(u => u.status == 'pending')
             if remaining is empty:
                 run.status = 'completed'
             planFirstRuns.save(run)
         else:
             unit.status = 'blocked'
             workUnits.save(unit)
             run.status = 'blocked'
             planFirstRuns.save(run)
             ATTENTION (warning)

     if passed:
         -> return { transition: remaining is empty ? 'run_completed'
                                                 : 'work_unit_completed',
                     runId, workUnitId: unit.id,
                     assignmentId: assignment.id, attemptId: attempt.id,
                     plannerUpdateRequired: false }
     else:
         -> return { transition: 'verification_failed', runId, workUnitId: unit.id,
                     assignmentId: assignment.id, attemptId: attempt.id,
                     plannerUpdateRequired: true, blocker: 'verification_failed' }
     # Assignment stays 'unresolved' on failure. The engine never auto-fails it.
```

**Explicitly absent from the tick:** no `Strategy` creation; no
`PlannerAssistance` creation (deferred); no provider correlation mechanism; no
newest-session / first-result / recency selection; no hidden session creation; no
assignment reuse across units.

---

# H. Operational milestone

The exact future proof, with expected persisted state at each boundary.

### Boundary 0 — setup

```text
project P, pair PR (planner + worker runtimes, authoritative associations verified)
contract_revisions: CR1 { project: P, digest: D1, status: 'approved',
                          approvedBy: 'human', approvedAt: T0 }
work_units:        WU1 { revision: CR1, ordinal: 1, status: 'pending',
                         objective: 'create a.txt', instruction: '...' }
                   WU2 { revision: CR1, ordinal: 2, status: 'pending', ... }
plan_first_runs:   R1 { project: P, revision: CR1, digest: D1, pair: PR,
                        status: 'ready' }
assert: workUnits(CR1).length == 2, ordered [WU1, WU2]
assert: workUnits.findInProgress(CR1) == null
assert: planFirstRuns.findActiveByContractRevisionId(P, CR1).id == R1
```

### Boundary 1 — WU1 dispatch

```text
tick(R1) -> { transition: 'work_unit_completed' | 'verification_failed', ... }   # see B2
work_units: WU1 { status: 'in_progress', assignmentId: A1 }   # written in txn 1
assignments: A1 { pairId: PR, projectId: P, status: 'active' }
attempts:     AT1 { assignment: A1, attemptNumber: 1,
                    sessionPairId: PR, workerSessionId: W,
                    externalSessionId: <frozen snapshot>, status: 'running' }
deliveries:   D1 { assignment: A1, attempt: AT1, status: 'delivered' }
assert: workUnits.findInProgress(CR1).id == WU1      # exactly one
assert: planFirstRuns.findById(R1).status == 'running'
```

### Boundary 2 — WU1 verify + accept

```text
verification_results: V1 { attemptId: AT1, result: 'passed', checkId: 'file:a.txt' }
work_units:  WU1 { status: 'completed', assignmentId: A1 }
assignments: A1 { status: 'completed' }
attempts:    AT1 { status: 'completed_physical' }   # NOT changed by verification
plan_first_runs: R1 { status: 'running' }           # WU2 still pending
assert: WU1.status == 'completed'
assert: derived cursor == WU2      # first pending, all lower ordinals completed
```

### Boundary 3 — persist + **close DB** + reopen + recover

```text
db.close()
db2 = new SqliteRelayDatabase(sameFile)

run2 = planFirstRuns.findById(R1)
  -> status 'running', contractRevisionId CR1, contractDigest D1, pair PR   # identical
units2 = workUnits.findByContractRevisionId(CR1)
  -> [WU1(completed, ordinal 1), WU2(pending, ordinal 2)]                   # order preserved
assert: run2.contractDigest == D1
assert: units2.length == 2                # no duplicates
assert: units2[0].id == WU1 and units2[0].status == 'completed'
assert: units2[1].id == WU2 and units2[1].status == 'pending'
assert: workUnits.findInProgress(CR1) == null
assert: derived cursor == WU2            # survives reconstruction (D.2)
assert: attempts.findByAssignmentId(A1)[0].sessionPairId == PR
assert: attempts.findByAssignmentId(A1)[0].externalSessionId == <frozen>
assert: verificationResults for AT1 -> result 'passed'   # survived
```

### Boundary 4 — WU2 executes to completion

```text
tick(R1) x2
  tick 1 -> WU2 in_progress, A2/AT2/D2 created, dispatch delivered
  tick 2 -> V2 passed, WU2 completed, A2 completed
work_units: WU1 completed, WU2 completed
plan_first_runs: R1 { status: 'completed' }        # last unit completed
assert: run.status == 'completed'
```

### Boundary 5 — restart + **no duplicate dispatch**

```text
db2.close(); db3 = new SqliteRelayDatabase(sameFile)

tick(R1)
  -> step 2: run.status == 'completed'  -> return { transition: 'run_terminal' }
  -> ZERO new assignments, attempts, or deliveries
assert: workUnits(CR1).length == 2
assert: assignments for PR from this run == 2   (A1, A2)   # unchanged
assert: attempts for A1 == 1; attempts for A2 == 1          # not retried
assert: planFirstRuns.findActiveByContractRevisionId(P, CR1) == null
```

### Boundary 6 — negative: verification failure stops WU2

```text
WU1 verification -> 'failed'
work_units:  WU1 { status: 'blocked' }
assignments: A1 { status: 'active' }        # stays 'unresolved', NOT 'failed'
attempts:    AT1 { status: 'completed_physical' }
plan_first_runs: R1 { status: 'blocked' }
assert: tick(R1) -> { transition: 'blocked_awaiting_planner',
                      plannerUpdateRequired: true }
assert: NO assignment/attempt/delivery created for WU2     # WU2 never dispatched
```

### Boundary 7 — idempotency under repeated setup

```text
re-run full setup 3x with identical inputs
assert: contract_revisions for (P, D1).length == 1     # UNIQUE (project, digest)
assert: workUnits(CR1).length == 2                      # UNIQUE (rev, ordinal)
assert: non-terminal runs for (P, CR1).length == 1      # partial UNIQUE
assert: no duplicate logical work units or runs
```

---

# 11. Reconciliation of existing material

## 11.1 `runPlanFirstTick` (`RelayEngine.ts:1432-1542`) — reference classification

| Reference | Class | Disposition |
|---|---|---|
| `repos.planFirstRuns.findById` | needs adaptation | keep; becomes typed |
| `repos.contractRevisions.findById` + `status !== 'approved'` | **compatible** | keep — matches §B.1 gate exactly |
| `repos.workUnits.findByContractAndStatus(rev, 'pending')` | **obsolete** | replace with `findByContractRevisionId` + domain filter |
| `available.filter((w: any) => true)` | **obsolete** | vestigial no-op filter; delete |
| `eligible[0].id` | **needs adaptation** | must be ordinal-ordered first, not arbitrary first |
| `repos.workUnits.findNextEligible(...)` | **obsolete** | remove; derived cursor §D.2 |
| `run.currentWorkUnitId` read/write | **obsolete** | field dropped; derived |
| `run.currentAssignmentId` | **obsolete** | field never existed in schema; per-unit `WorkUnit.assignmentId` replaces it |
| `repos.pairs.findById(run.sessionPairId ?? null)` (`:1472`) | **needs adaptation** | `sessionPairId` is now non-null; the `?? null` implies the opposite relationship |
| `Assignment.create(pair.id, run.projectId, 'Plan-First work execution', currentUnit?.instruction \|\| 'Execute approved work')` (`:1474`) | **obsolete + defect** | One Assignment **per WorkUnit** (§B.4), title = `unit.objective`. Two real defects: the **hardcoded title**, and the `\|\| 'Execute approved work'` fallback, which would dispatch a generic instruction instead of the unit's intent whenever `instruction` is null. §E.3 makes `instruction` NOT NULL precisely to remove this path. |
| `Strategy.create(...)` / `repos.strategies.save` (`:1480-1481`) | **rejected concept** | `Strategy` rejected (§B.6) |
| `attempts.findByAssignmentId` → `attemptNumber = (attempts?.length ?? 0) + 1` (`:1486-1487`) | **defect** | Counting rows rather than taking `max(attempt_number) + 1` is race-prone: two concurrent ticks can mint the same `attemptNumber`. There is no unique constraint on `(assignment_id, attempt_number)`. Use `max + 1`, or add that constraint. |
| `Attempt.create(...)` + `attempts.save(attempt)` (`:1488-1493`) **then** `dispatchAssignment(assignmentId)` (`:1495`) | **defect — double attempt creation** | The tick hand-creates and persists an `Attempt`, then calls `dispatchAssignment`, which creates *its own*. Every tick would strand an orphan `prepared` attempt, corrupting attempt history and `attemptNumber` for the next tick. §G never creates an attempt directly — it is created only inside `dispatchAssignment()`. |
| `sessionPairId: run.sessionPairId ?? (pair?.id ?? null)` (`:1489`) | **needs adaptation** | The fallback is circular — `pair` was itself loaded from `run.sessionPairId` (`:1472`). Pass `pair.id` once, resolved. |
| `workerSessionId: (await repos.runtimes?.findById(pair?.workerSessionId ?? ''))?.id ?? null` (`:1490-1491`) | **compatible but redundant** | Correctly resolves the worker via `pair.workerSessionId`. The `findById` round-trip is unnecessary — `pair.workerSessionId` *is* the id. §G takes these from the Pair/runtime directly. |
| `repos.runtimes?.findById(run.sessionPairId ?? '')` (`:1523`) | **defect** | Treats a **Pair id** as a **RuntimeSession id**. It is the *first* clause of a `??` whose second clause resolves correctly via `pair.plannerSessionId`, so the first lookup is a guaranteed wasted round-trip. §G resolves the planner from `pair.plannerSessionId` only. |
| `run.currentAssignmentId` (`:1470`) | **obsolete** | field never existed in schema; per-unit `WorkUnit.assignmentId` replaces it |
| `repos.repoObservations.saveForAttempt` (`:1500`) | **deferred** | table exists, no repository; not required by the milestone |
| `this.executeMechanicalVerification` (`:1501`) | **deferred** | new; milestone-1 deterministic verification (§G step 10) |
| `repos.verificationResults.save({...})` (`:1502-1509`) | **needs adaptation** | keep; use the `VerificationResult` shape already in `repoBoundary.ts`, and add the `findByAttemptId` lookup required by the §G step-10 idempotency guard (§F.1). Also `evidence: … ?? {}` — `{}` is not a valid `ObservableEvidence`; use `undefined`. |
| `repos.assignments.completeAssignment` (`:1512`) | **defect** | engine method, not a repository method. Call `assignment.complete()` + `assignments.save()`. |
| `dispatchAttempt.startRunning()` (`:1499`) | **precondition** | must exist — part of the lost Slice-1 work (§0.1) |
| `verificationResult.result === 'passed'` → complete unit (`:1510-1515`) | **compatible in intent, wrong in shape** | completion must be transactional with assignment resolution and gated on the unit, not the run |
| `PlannerAssistance.create` + `repos.assistance` (`:1526-1536`) | **deferred + defect** | Protocol unfrozen; not required by the milestone. Separately, `repos.assistance` **does not exist** on `IRelayRepositories` — the declared member is `plannerAssistance?: any` (`interfaces.ts:143`). Hard `TS2339` at `RelayEngine.ts:1535` and `:1536`. Delete the whole cluster under the scope firewall. |
| `run.updateStatus('blocked')` (`:1538`) | **needs adaptation** | row has no methods; use a real entity |
| `run.currentWorkUnitId = await …findNextEligible(…)` then `if (!run.currentWorkUnitId)` (`:1514-1516`) | **defect — object assigned to scalar; run completion unreachable** | `findNextEligible` returns an **object**, which is always truthy, so the `run_completed` branch at `:1517` is **unreachable**. This is the `TS2322` at `:1514`. Derived cursor (§D.2) removes the field and the bug together. |
| `workUnits.updateStatus(targetUnitId, 'completed')` (`:1513`) | **obsolete** | free-text mutation bypasses invariants; use the domain transition inside a transaction (§C.2) |
| `workUnits.updateStatus(targetUnitId, 'selected')` (`:1466`) | **obsolete** | invents a `selected` state that is not in the frozen WorkUnit machine (§C.2). The selection path at `:1450-1455` never sets it, so the two paths are already inconsistent. |
| Optional chaining `repos.planFirstRuns?.` / `workUnits?.` / `assignments?.` | **obsolete** | become required, non-optional members once implemented |

**Net:** 1 reference is compatible as-is, 6 need adaptation, 10 are obsolete, 2 are
deferred, 2 reference rejected concepts, **7 are defects**, 1 is a precondition on lost
Slice-1 work. The method is a **rewrite against §G**, not a repair. Not performed in this
tranche.

**The two defects that matter most** are the **double attempt creation** (`:1488-1495`)
and the **unreachable run-completion branch** (`:1514-1517`). Both would silently corrupt
Plan-First state in ways that look like correct progress: the first inflates attempt
history, the second means a run can never report `completed`. Neither is a typing problem
— both are logic errors that `tsc` flags only incidentally. This is the concrete evidence
that `runPlanFirstTick` must be rewritten against §G rather than repaired.

## 11.2 Test reconciliation

| Test | Class | Disposition |
|---|---|---|
| `core_slice7.test.ts` C1/C2/C3 | **consistent — preserve** | These define the canonicalization rule frozen in §B.1. Currently self-contained in-test; the rule should move into a domain function. **Trust these.** |
| `core_slice8.test.ts` | **fixture defect + obsolete** | Fails at the pre-pair association gate, before Plan-First. Also asserts on a `ContractRevision` that never existed. Rewrite against §B.1/§B.2 once implemented. |
| `core_slice9_pf1.test.ts` | **test defect** | `ReferenceError: bindPair is not defined`; references `db.contractReisions` (typo). Nothing to preserve. |
| `core_slice9_operational.test.ts` | **speculative** | Imports non-existent `ContractRevision`/`Strategy`/`WorkUnit`/`PlanFirstRun`; `provenance: 'pair_binding'` is valid but the rest is invented. **Do not trust.** Rewrite. |
| `core_slice9_pf1_operational.test.ts` | **test defect** | Does not parse (`tmpDir` declared twice). Nothing to preserve. |
| `pf1_operational.test.ts` | **speculative** | Imports non-existent `ContractRevision`/`PlanFirstRun`; PF2 case is actually a valid negative-delivery test that should be **preserved and re-homed** (it asserts a failed delivery does not falsely complete an attempt — consistent with `ATTEMPT_LIFECYCLE`). |
| `management_lifecycle` / `core_slice1/2/3` / `manual_planner_gate` / provider tests | **out of scope** | Not Plan-First. Not touched. Their repair is a separate tranche. |

**What the implementation tranche should trust:** `ATTEMPT_LIFECYCLE.md`,
`EXECUTION_AUTHORITY.md`, `CORE_FREEZE_REVIEW.md`, and this document. Nothing in
`tests/core_slice9_*` or `tests/pf1_operational.test.ts`.

---

# 12. Conflict register

| # | Conflict | Resolution |
|---|---|---|
| 1 | `DESIGN_GATE.md` says provenance `pair_creation`, `verification_state` includes `manual`, one association per session globally. `types.ts` has `pair_binding`, `verified\|unverified\|stale`, unique on `(runtime_session_id, project_id)`. | **STALE.** `DESIGN_GATE.md` is superseded. Not a model for anything. Closed tranche untouched. |
| 2 | `SLICE1_REPORT.md` says Slice 1 implemented; the code shows it is not (§0.1). | Report is **aspirational**. `types.ts` + `attempts` columns survived; the entity and the transaction split did not. Re-implementation is step 1 of §15. |
| 3 | `runPlanFirstTick` reads `runtimes.findById(run.sessionPairId)` — a Pair id used as a RuntimeSession id. | **Defect.** Resolve through `pair.plannerSessionId` / `pair.workerSessionId`. |
| 4 | `plan_first_runs.current_attempt_id ... ON DELETE CASCADE` from `attempts`. | **Inverted FK.** Deleting an attempt would delete the run. Field dropped; run↔attempt is derived. |
| 5 | `runPlanFirstTick` assigns `findNextEligible()`'s object result to scalar `currentWorkUnitId`. | Stub contradicted its only caller. `findNextEligible` removed; cursor derived. |
| 6 | Speculative tests place work units in **two different runtimes** (`/tmp/relay_pf_op_final.db`) while executing against `:memory:`. | Test defect. The milestone must use **one file-backed DB** for the close/reopen proof (§H Boundary 3). |
| 7 | Speculative `ContractRevision.create(projectId, path, digest)` vs `(projectId, path, canonicalText)` — 3rd arg used as both. | **Ambiguous evidence.** §B.1 resolves: the revision stores the canonical text and derives the digest. |
| 8 | `DOMAIN_DELTA.md:51` / `P0 Invariant 5` list `contractDigest` inside the Attempt's frozen execution authority. | Adopted. Plan-First's binding is enforced by the immutable `PlanFirstRun.contractRevisionId` + `contractDigest`; per-Attempt authority stays exactly the 3 frozen fields (`EXECUTION_AUTHORITY.md` §2 rejects extra fields). No conflict. |
| 9 | `repo_observations.observation_json`/`change_summary` vs `RepoObservationResult.changedFiles/newFiles/removedFiles`. | Deferred (§B.7). Noted; no Plan-First dependency. |
| 10 | `verification_results.result` DEFAULT `'unknown'` is outside `VerificationStatus`. | Pre-existing inconsistency in a **PARTIAL** area. Not introduced or fixed here. Flag for the verification tranche. |
| 11 | `runPlanFirstTick` calls `repos.assistance` (`RelayEngine.ts:1535-1536`); `IRelayRepositories` declares `plannerAssistance?: any` (`interfaces.ts:143`). No `assistance` member exists. | **Defect** — `TS2339` ×2. Confirmed by `tsc`. The whole `PlannerAssistance` cluster is deleted as out-of-scope (§B.7). Do not "fix" it by renaming the interface member. |
| 12 | `IRelayRepositories` declares 7 untyped `any` members (`workUnits`, `strategies`, `contractRevisions`, `verificationResults`, `repoObservations`, `plannerAssistance`, `plannerActions`) plus one optional typed `planFirstRuns?: IPlanFirstRunRepository` returning `Promise<any \| null>`. | §F replaces the Plan-First ones with typed contracts and §F.1 types `verificationResults`. `strategies`, `plannerActions`, `plannerAssistance` are **rejected/deferred** (§B.6, §B.7): leave them untyped and unused, or remove them in a dedicated cleanup — but do **not** type them, because typing them would imply concepts this freeze rejected. |

---

# 13. Newly frozen decisions (no evidence decided these)

Marked explicitly, per the decision discipline.

| # | Decision | Rationale |
|---|---|---|
| N1 | No standalone `Contract` entity; a project's contract **is** its `ContractRevision` lineage. | Fewest durable concepts. Nothing requires a separate container. |
| N2 | `ContractRevision` content immutable **from creation** (not only after approval). | Prevents an unapproved-but-referenced revision from having its intent rewritten under an in-flight run. |
| N3 | Canonicalization = sha256 over author-declared semantic fields with sorted keys. | Satisfies C1–C3 simultaneously; reconciles the two contradictory `create()` signatures. |
| N4 | `UNIQUE (project_id, canonical_digest)` on revisions. | Makes approval idempotent and prevents duplicate intent. |
| N5 | Run lifecycle is 5 states; **no run-level `suspended`**. | Suspension is already expressible at Attempt (`interrupted`) + `AttentionItem`. |
| N6 | `currentWorkUnitId` is **derived, not persisted**. | Cannot drift; restart determinism for free; removes a mutable cross-aggregate cursor. |
| N7 | `PlanFirstRun.contractDigest` kept as an immutable snapshot. | Both sides immutable → cannot drift; enables a cheap load-time binding check. |
| N8 | One `Assignment` **per WorkUnit**. | `Assignment` is the durable objective; units are distinct objectives with distinct instructions. Reuse would rewrite dispatch truth. |
| N9 | Work-unit ordering is an explicit `ordinal`; **`dependsOn` omitted entirely**. | Total order is sufficient and deterministic for sequential milestone execution; DAG is out of scope. |
| N10 | No WorkUnit `cancelled` state. | Run cancellation abandons `pending` units; the state would be dead. |
| N11 | `WorkUnit.assignmentId` set once, FK `ON DELETE RESTRICT`. | Makes "already dispatched" durably known and makes silent re-dispatch impossible after deletion attempts. |
| N12 | `session_pair_id` is a soft reference (no FK). | Immutable historical provenance, preserved across Pair replacement and Pair deletion. |
| N13 | Retry budget / `Strategy` deferred, not invented. | Explicitly unfrozen upstream; inventing them is new architecture. |
| N14 | One Assignment per unit means units need no attempt counter. | `attemptNumber` on `Attempt` is already the single source of truth. |

---

# 14. Invariant compliance

No closed pairing / discovery / association decision is modified, relaxed, or
reinterpreted.

- `runtime_project_associations` remains authoritative for project-scoped runtime
  ownership. Plan-First reads it only indirectly: it requires a `Pair`, and `createPair`
  already enforces the pre-pair authoritative-association gate. **Plan-First adds no
  pairing path and no alternative way to obtain a session.**
- Pair creation/rebinding still requires authoritative association. Untouched.
- Ambiguous discovery still fails closed. Untouched.
- No newest-session / first-result / recency heuristic. Plan-First selection is by
  immutable integer `ordinal` only.
- No hidden worker/session architecture. Plan-First reuses `Pair` →
  `dispatchAssignment()`; it creates no session and no provider path.
- Provider metadata is evidence, not ownership truth. A work unit is `completed` only
  from a `VerificationResult`, never from provider inspection, window title, or worker
  self-claim.
- Attempt authority `(sessionPairId, workerSessionId, externalSessionId)` frozen at
  dispatch — reused unchanged, per `EXECUTION_AUTHORITY.md` §2. No `frozenAt`, no
  `execution_epoch`, no `providerType`.
- Ambiguous delivery still blocks automated resend
  (`AmbiguousDeliveryResendError`); a duplicate in-flight delivery still blocks
  (`DuplicateDeliveryAttemptError`). Plan-First routes around neither.

---

# 15. Recommended implementation sequence

Ordered. Each step is independently verifiable. Steps 1–2 are preconditions.

1. **Restore lost Slice-1 domain work** (§0.1). `Attempt`: add `sessionPairId`,
   `workerSessionId`, `externalSessionId`; `create()` takes authority and starts
   `prepared`; add `startRunning()` / `completePhysical()`; remove `complete()`/`fail()`;
   reconcile `completeAssignment()` and `dispatchAssignment()`. **Clears the current
   `entities.ts` type errors and makes the domain layer compile.** Also restore the
   Phase 1/2 transaction split so the provider call is outside the DB transaction.
2. **Fix `IMemory`/memory-database parity** so `runInTransaction` snapshots the new
   repositories like the existing ten.
3. **Create `contract_revisions`** (§E.1). Unblocks writes to both Plan-First tables.
4. **Add the `ContractRevision` domain entity** with the canonicalization rule (§B.1) and
   its repository (§F). Land `core_slice7` C1–C3 as its acceptance tests.
5. **Add the `WorkUnit` domain entity** with `ordinal` ordering and no dependencies
   (§B.3), plus its repository (§F).
6. **Migrate `work_units`** (§E.3): add `ordinal`, `assignment_id`; drop `project_id`,
   `dependencies`; add the two unique constraints and the status index. Also apply the
   one additive change to `verification_results` (§E.4.1): `UNIQUE (attempt_id)` and
   `result` default → `'not_run'`. Use the table-rebuild approach from §E.5.
7. **Add the `PlanFirstRun` domain entity** (§B.2) and repository (§F).
8. **Migrate `plan_first_runs`** (§E.2): drop the three derived/obsolete columns, change
   the revision FK to `RESTRICT`, drop the pair FK, add the partial unique index.
9. **Rewrite `runPlanFirstTick`** against §G. Delete the obsolete references (§11.1).
   Do not add `Strategy`, `PlannerAssistance`, budgets, or correlation.
10. **Prove §H** end to end on a **file-backed** SQLite database: boundaries 0–7,
    including a real close/reopen at Boundary 3 and a re-tick at Boundary 5.
11. **Only then** consider `mechanicalVerification.evaluate` as a real deterministic
    check, and `repo_observations` as the repository baseline for Invariant 7.

**Do not** begin step 9 before steps 3–8, and do not begin step 1's dependents before
step 1: `Attempt` must compile before Plan-First can execute through it.
