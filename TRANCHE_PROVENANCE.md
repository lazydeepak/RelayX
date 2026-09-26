# TRANCHE PROVENANCE

Records which files belong to which tranche, so tranche ownership stays distinguishable
while the working tree carries substantial pre-existing modified/untracked work.

---

## Tranche: Plan-First Domain Implementation (gates 1-9)

**Status: COMPLETE. No commit, no push.** HEAD is still `7b98b23`.

**Deliverable:** the implementation of `PLAN_FIRST_DOMAIN_FREEZE.md` as written. No
redesign, no unfrozen domain decisions.

### Source files changed

| File | Change |
|---|---|
| `src/relay/domain/planFirst.ts` | **NEW.** `ContractRevision`, `WorkUnit`, `PlanFirstRun`, `canonicalizeSemanticFields`, `digestCanonicalText`, `deriveCurrentWorkUnit`, `allWorkUnitsCompleted`. |
| `src/relay/domain/planFirstVerification.ts` | **NEW.** Verification seam. Fail-closed `MilestoneVerification` default that cannot return `passed` (freeze §15 step 11 defers the real check). Injected as optional 2nd `RelayEngine` arg. |
| `src/relay/domain/entities.ts` | Gate 1 Attempt recovery (authority, `startRunning`, `completePhysical`, `attemptNumber = max+1`); `RuntimeProjectAssociation` field-type narrowing; Plan-First re-export block at EOF. |
| `src/relay/domain/types.ts` | Plan-First brands + `ContractRevisionStatus`, `PlanFirstRunStatus`, `WorkUnitStatus`, terminal-state consts. |
| `src/relay/domain/repoBoundary.ts` | Imports `.js` -> `.ts` for `moduleResolution: bundler`. |
| `src/relay/application/RelayEngine.ts` | `dispatchAssignment` split into 3 phases; `runPlanFirstTick` fully rewritten with `dispatchPlanFirstUnit`, `verifyPlanFirstUnit`, `reconcileInterruptedPlanFirstUnit`, `reconcileInFlightPlanFirstUnit`, `blockPlanFirstUnit`, `raisePlanFirstAttention`. |
| `src/relay/application/RelayApiService.ts` | **Pre-existing working-tree change**, not this tranche: `AUTHORITATIVE_ASSOCIATION_PROVENANCES`, `recordAssociationEvidence`, type-narrowed `RuntimeProjectAssociation` import. |
| `src/relay/persistence/interfaces.ts` | Typed `IContractRevisionRepository`, `IPlanFirstRunRepository`, `IWorkUnitRepository`, `IVerificationResultRepository` (all `any` removed). |
| `src/relay/persistence/sqlite/SqliteDatabase.ts` | `migratePlanFirstSchema()` (`PRAGMA user_version = 3`), `tableExists`/`columnExists` helpers, constructor wiring, `close()`, file-path constructor. |
| `src/relay/persistence/sqlite/SqliteRepositories.ts` | 4 typed Plan-First repositories. `SqliteVerificationResultRepository.save` is a PLAIN INSERT, not an upsert (see below). |
| `src/relay/persistence/memory/MemoryDatabase.ts` | 4 in-memory Plan-First repos + `planFirstConstraintError`, wired into the `runInTransaction` snapshot list (all 14 repos). |
| `src/relay/providers/browserProviders.ts` | Explicit return type on `reconcileDispatch` (its `source: 'reconcile_probe'` was a `string`, not in the `ObservableEvidence['source']` union). |

### Two implementation decisions worth recording

1. **`SqliteVerificationResultRepository.save` is a plain INSERT, not an upsert.** It was
   originally `ON CONFLICT(attempt_id) DO UPDATE`. That satisfied the row count while
   silently ERASING the first verdict — which is exactly the "two conflicting results"
   §E.4.1 adds `UNIQUE (attempt_id)` to prevent. The controller never needs the upsert:
   `verifyPlanFirstUnit` checks `findByAttemptId` first and, on a crash between "result
   written" and "unit completed", RESUMES from the stored result (§G step 10) rather than
   re-evaluating. A rejection now means a caller genuinely tried to record a second
   verdict for one attempt, which must be loud.

2. **Selection of a later unit does not re-`start()` the run.** §C.1 makes
   `running -> running` a legal self-transition ("a unit completes and a later eligible
   unit exists"). `start()` is correctly guarded to reject `running -> running`, so the
   selection transaction only calls `start()` when the run is not already `running`.

### Test reconciliation (gate 6) — `test -> old assumption -> frozen behavior -> action`

| Test | Old assumption | Frozen behavior | Action |
|---|---|---|---|
| `sqlite_migration.test.ts` | v2 was the target version | §E.5 v3 adds `contract_revisions`, `ordinal`, digest snapshot; migration runs AFTER the v2 block | Updated to v3, added Plan-First table assertions. **Green (3).** |
| `core_slice1.test.ts` T1/T6 | `bindPair` closed over the outer `:memory:` db, so T6 built its Pair in the wrong database and the assignment's `pair_id` failed the pairs FK | Helper must target the database under test | Parameterized `bindPair(target = db)`; T6 now creates its Pair in `dbFile`; T1 compares against the persisted worker; T6 asserts on error `code`/`instanceof` instead of a name regex. **Green.** |
| `core_slice8.test.ts` | Associations created with `pair_binding` provenance | `AUTHORITATIVE_ASSOCIATION_PROVENANCES = {discovery, adoption, setup}`; `pair_binding` is not proof of project membership | **Fixture** corrected to `setup`. The guard was NOT weakened. Rewritten; **green.** |
| `core_slice9_operational.test.ts` | imports rejected `Strategy` (§B.6); `ContractRevision.create(projectId, sourceRef, digest)` passes a *digest* as the semantic fields; `PlanFirstRun.create` 4-arg; `WorkUnit.create` 4-arg with no `ordinal`; `wu2.status = 'pending'` writes status directly, bypassing the domain; `db.contractRevisions.save ? ... : (db as any)`; claims "real DB close/reopen" but uses `:memory:` and never closes | All three constructor signatures are frozen; `Strategy` is rejected; the cursor is derived, not written | **DELETED.** Superseded by `pf1_operational.test.ts`, which proves every meaningful assertion it made (digest retained across restart, run survives reload, no hidden session mutation) and more. |
| `core_slice9_pf1.test.ts` | calls an undefined `bindPair` (never written); obsolete `ContractRevision.create` order; creates no WorkUnits and no PlanFirstRun; the comment itself concedes it "proves the structural path" | §G requires a real run, units, and a derived cursor | **DELETED.** It exercised `createAssignment`+`dispatchAssignment`, already covered by `core_slice1`. |
| `core_slice9_pf1_operational.test.ts` | **does not parse** — `tmpDir` used at line 11 before its `const` declarations at 13/22 (three redeclarations in one scope); encodes the dropped `depends: 'wu1'` DAG; creates no work units | N9 (no DAG); §B.3 requires explicit ordinals | **DELETED.** Unparseable and superseded. |

All three were **untracked** (`git status` `??`, absent from `git ls-files`), so removal
touched no committed work. Deleting them is not a way to raise the pass count: the
replacement is strictly larger (3 tests covering 8 boundaries, on a real file-backed DB
with a real close/reopen, vs 3 near-empty tests covering 0 boundaries on `:memory:`).

### New test files

| File | Proves |
|---|---|
| `tests/plan_first_domain.test.ts` | §B/§C/§D pure-domain: deterministic digest, C1/C2/C3, approval invariant, project-scoped uniqueness, the 4-state `PlanFirstRun` and 3-state `WorkUnit` transition tables, every illegal transition, explicit `ordinal`, the derived cursor and its precedence. **28 tests.** |
| `tests/plan_first_schema.test.ts` | §E/§F on a real file-backed DB: `UNIQUE(project_id, canonical_digest)`, `UNIQUE(contract_revision_id, ordinal)`, both partial unique indexes, `ON DELETE RESTRICT` on the revision and the assignment binding, `session_pair_id` soft reference surviving pair deletion, `NOT NULL` instruction, §E.4.1 one-result-per-attempt, §E.5 migration order, the data-loss guard, full close/reopen field-for-field round-trip, and SQLite/memory constraint parity. **18 tests.** |
| `tests/pf1_operational.test.ts` | §H Boundaries 0-7 on a real file-backed DB: WU1 -> restart -> WU2 -> completion -> restart, plus the in-flight boundary, the verification-failure boundary, and idempotency. Injects a deterministic evaluator at the §G seam. **3 tests.** |

**Total Plan-First coverage: 61 tests, 61 green.**

### Deliberate non-fix: `reconcileUncertainDeliveries`

`tests/core_slice2.test.ts` (7 tests) fails on `engine.reconcileUncertainDeliveries`, which
**never existed in any branch, ref, dangling commit, or dangling blob**. Building it would
be new architecture outside the freeze. Classified pre-existing-unrelated and left failing.

### Final measurement

```bash
node --import tsx --test --test-reporter=tap "tests/**/*.test.ts"
# tests 339 | pass 322 | fail 17
```

Baseline was `# tests 294 | pass 266 | fail 28`, with 14 distinct failing nodes. 7 of those
nodes are now green; 8 remain failing (the counts differ because 3 nodes were removed and
45 tests were added).

**`npx tsc --noEmit`: 0 errors in `src/`.** The 39 remaining test errors are confined to
`tests/core_slice2.test.ts` (33) and `tests/core_slice3.test.ts` (6) — the two suites whose
subsystems do not exist.

### Acceptance gate: the 8 remaining failures are pre-existing, proven empirically

A pristine copy of HEAD was extracted with `git archive HEAD` into a temp directory, the
untouched test files were copied in, and the suites were re-run against the unmodified
`src/`. Seven of the eight fail identically there, which is stronger than an argument from
the baseline log:

| Node | Proof |
|---|---|
| `CLI-backed OpenCode provider correction` | fails identically at pristine HEAD |
| `Core Slice 2 — Restart Reconciliation` | fails identically at pristine HEAD |
| `Core Slice 3 — Repository Boundary B1-B7` | fails identically at pristine HEAD |
| `Electron IPC & RelayApiService Integration` | fails identically at pristine HEAD |
| `Project, Pair, Runtime lifecycle + Deletion Guards` | fails identically at pristine HEAD |
| `Manual planner without verified identity rejected` | fails identically at pristine HEAD |
| `OpenCode provider shared-service discovery` | fails identically at pristine HEAD |
| `Manual non-null externalSessionId rejected` | **flaky**, pre-existing: `expected.updatedAt` is built from a second `Date.now()` and differs from the persisted value by 1 ms. Passes on ~1 run in 5. Not loadable at HEAD (`RuntimeProjectAssociation` did not exist there), so it is covered by the Gate 0 baseline instead. Not Plan-First: it compares association timestamps. |

None of the eight test files was modified by this tranche — confirmed against
`tranche3_before.txt`, in which `tests/electron_bridge.test.ts` was already ` M` and the
manual/planner/slice files were already untracked.

### Post-freeze implementation rulings

Two decisions were settled by the owner after the domain freeze was written. They are
recorded here so the implementation is not later re-litigated as an accidental omission.

#### Contract / dependency model

V1 intentionally uses immutable `ContractRevision` directly.

No standalone `Contract` aggregate provides required V1 behavior.

WorkUnits execute strictly sequentially using immutable `ordinal`.

DAG dependencies and parallel WorkUnits are outside V1 and require an explicit future
domain revision.

This is intentional scope reduction, not accidental omission.

#### Attempt lifecycle mapping

`AttemptStatus` intentionally uses:

`prepared | running | completed_physical | interrupted`

`running` represents the operational dispatched/executing interval.

`ATTEMPT_LIFECYCLE.md` §6 left exact enum naming unfrozen; no additional enum state is
introduced merely to mirror conceptual lifecycle prose.

---

## Tranche: Plan-First Execution Domain Freeze

**Status: COMPLETE — documentation only.**

**Deliverable:** `PLAN_FIRST_DOMAIN_FREEZE.md` (new, canonical frozen specification).

**Files modified by this tranche:**

- `PLAN_FIRST_DOMAIN_FREEZE.md` — NEW
- `TRANCHE_PROVENANCE.md` — this file (updated to record the tranche)
- `STOP_CONDITION_PLAN_FIRST_SQLITE.md` — corrected error count (see below)

### Corrections applied by this tranche

The prior tranche's stop report stated `tsc --noEmit` reports "27 errors". That figure
came from a truncated `head -60` of compiler output and was wrong. Accurate total:
**153 errors (31 in `src/`, 122 in `tests/`)**. `STOP_CONDITION_PLAN_FIRST_SQLITE.md`
§2.1 has been corrected, and the per-file breakdown is recorded in
`PLAN_FIRST_DOMAIN_FREEZE.md` §0.1.

The prior tranche also stated the suite as "267 pass / 27 fail" without naming a command or
reporter. That is not reproducible. The authoritative measurement is:

```bash
node --import tsx --test --test-reporter=tap "tests/**/*.test.ts"
# tests 294 | pass 266 | fail 28 | cancelled 0 | skipped 0
```

The `spec` reporter emits no summary footer, so pass counts quoted from it are
unreliable. `PLAN_FIRST_DOMAIN_FREEZE.md` §0.2 records the reproducible baseline, the 14
distinct failing nodes, and the narrow per-tranche gate. This changes no conclusion of the
prior tranche — the Plan-First repositories remain unimplemented scaffolding.

**Source files changed: NONE. Tests changed: NONE. Migrations written: NONE.**

This tranche was an architecture/domain reconciliation tranche. It resolved the items
`DOMAIN_DELTA.md` and `CORE_FREEZE_REVIEW.md` left explicitly unfrozen (Contract Revision
representation, DB layout), and it deliberately did **not** implement anything.

### Blocked-on finding recorded by this tranche

`PLAN_FIRST_DOMAIN_FREEZE.md` §0.1 documents that `SLICE1_REPORT.md` reports Core Slice 1
as implemented, but the Slice 1 domain work is **absent from the working tree** — only
`types.ts` (`AttemptStatus`) and the three `attempts` table authority columns survived.
`entities.ts` still assigns `'completed'`/`'failed'`, which are no longer in
`AttemptStatus`, so the domain layer does not type-check. `dispatchAssignment()` also
still calls the provider **inside** the DB transaction. This is a precondition for
Plan-First implementation and is step 1 of the recommended sequence
(`PLAN_FIRST_DOMAIN_FREEZE.md` §15). It was **not** fixed here (scope firewall).

### Verified untouched by this tranche

All 56 pre-existing working-tree entries, including every production file:

- `src/relay/domain/entities.ts`, `src/relay/domain/types.ts`, `src/relay/domain/repoBoundary.ts`
- `src/relay/persistence/interfaces.ts`, `src/relay/persistence/memory/MemoryDatabase.ts`
- `src/relay/persistence/sqlite/SqliteDatabase.ts`, `src/relay/persistence/sqlite/SqliteRepositories.ts`,
  `src/relay/persistence/sqlite/SqliteAssociationRepository.ts`
- `src/relay/application/RelayEngine.ts`, `src/relay/application/RelayApiService.ts`
- All `tests/**`
- All pairing / discovery / association authority

`git status --porcelain` diff before vs after this tranche: only the two entries above.

---

## Tranche: Plan-First SQLite Persistence (SqlitePlanFirstRunRepository / SqliteWorkUnitRepository)

**Status: STOPPED — no code changes made.**

**Files modified by this tranche: NONE.**

Reason: Phase 1 archaeology and Phase 2 defect classification determined the assigned
work is not implementable from available evidence. Multiple documented stop conditions
were met. See `STOP_CONDITION_PLAN_FIRST_SQLITE.md` for the full diagnosis.

### What this tranche did NOT touch (verified byte-identical before and after)

- `src/relay/persistence/interfaces.ts`
- `src/relay/persistence/sqlite/SqliteRepositories.ts`
- `src/relay/persistence/sqlite/SqliteDatabase.ts`
- `src/relay/persistence/memory/MemoryDatabase.ts`
- `src/relay/application/RelayEngine.ts`
- `src/relay/application/RelayApiService.ts`
- `src/relay/domain/entities.ts`
- `src/relay/domain/types.ts`
- All `tests/**`
- All pairing / discovery / association guards

`git status --porcelain` entry count before and after this tranche: **56 / 56** (unchanged).

Only non-tracked side effect: `dist-electron/` regenerated by `npm run build:electron`
during verification. That path is listed in `.gitignore` and is not part of the working
tree diff.

---

## Pre-existing working-tree state (NOT owned by this tranche)

All 56 entries below pre-date this tranche and remain uncommitted and unmodified by it.

### Modified (tracked)

- `src/relay/application/RelayApiService.ts`
- `src/relay/application/RelayEngine.ts`
- `src/relay/domain/entities.ts`
- `src/relay/domain/types.ts`
- `src/relay/persistence/interfaces.ts`
- `src/relay/persistence/memory/MemoryDatabase.ts`
- `src/relay/persistence/sqlite/SqliteDatabase.ts`
- `src/relay/persistence/sqlite/SqliteRepositories.ts`
- `src/relay/providers/adapters.ts`
- `src/relay/providers/browserProviders.ts`
- `src/relay/providers/interfaces.ts`
- `src/services/relayClient.ts`
- `tests/add_project_workflow.test.ts`
- `tests/adopt_existing_session_isolated.test.ts`
- `tests/electron_bridge.test.ts`
- `tests/inspection_external_identity.test.ts`
- `tests/project_binding_persistence.test.ts`
- `tests/project_session_enumeration.test.ts`
- `tests/service_invariant.test.ts`
- `tests/staged_discovery.test.ts`
- `tests/ui_pair_existing_existing_flow.test.ts`

### Untracked

Design/audit documents: `ADVERSARIAL_REVIEW_PART1.md`, `ATTEMPT_LIFECYCLE.md`,
`AUDIT_I11_RUNTIME_FILESYSTEM.md`, `AUDIT_I7_STALE_MESSAGES.md`, `AUDIT_REPORT.md`,
`CORE_FREEZE_CLOSURE.md`, `CORE_FREEZE_REVIEW.md`, `DESIGN_GATE.md`, `DOMAIN_DELTA.md`,
`EXECUTION_AUTHORITY.md`, `P0_MATRIX.md`, `PROVIDER_DISPATCH_GROUND_TRUTH.md`,
`SESSION_PAIR_REPLACEMENT.md`, `SLICE1_REPORT.md`

Source: `src/relay/domain/repoBoundary.ts`, `src/relay/persistence/sqlite/SqliteAssociationRepository.ts`

Tests: `tests/association_persistence.test.ts`, `tests/cli_backed_provider.test.ts`,
`tests/core_slice1.test.ts`, `tests/core_slice2.test.ts`, `tests/core_slice3.test.ts`,
`tests/core_slice7.test.ts`, `tests/core_slice8.test.ts`, `tests/core_slice9_operational.test.ts`,
`tests/core_slice9_pf1.test.ts`, `tests/core_slice9_pf1_operational.test.ts`,
`tests/discovery_semantic_correction.test.ts`, `tests/focused_pairing_association.test.ts`,
`tests/manual_non_null_external_test.test.ts`, `tests/manual_planner_gate.test.ts`,
`tests/pair_mutation_association.test.ts`, `tests/pair_session_change_isolation.test.ts`,
`tests/persistence_restart_identity.test.ts`, `tests/pf1_operational.test.ts`, `tests/support/`

No commit or push was performed in any tranche.

---

## Superseded / stale design material (do not use as a model)

Identified during the domain-freeze tranche. Recorded so it is not mistaken for authority:

- `DESIGN_GATE.md` — **STALE.** Specifies association provenance `pair_creation` and
  `verification_state` including `manual`, and "one association per session globally".
  Current `src/relay/domain/types.ts` has `pair_binding` and
  `verified | unverified | stale`, with a unique index on
  `(runtime_session_id, project_id)`. Superseded by the closed association tranche.
- `SLICE1_REPORT.md` — **aspirational.** Describes Core Slice 1 as implemented; the
  Slice 1 domain work was absent from the working tree and has now been recovered by the
  Plan-First Domain Implementation tranche (gates 1-9).
- ~~`tests/core_slice9_*.test.ts`, `tests/pf1_operational.test.ts`,
  `tests/core_slice8.test.ts`~~ — **RESOLVED by the Plan-First Domain Implementation
  tranche.** The three `core_slice9_*` files were deleted as superseded (see the gate-6
  reconciliation table above). `pf1_operational.test.ts` and `core_slice8.test.ts` were
  rewritten against the frozen model and are now green. No longer stale.
- ~~`src/relay/persistence/sqlite/SqliteRepositories.ts` `SqlitePlanFirstRunRepository` /
  `SqliteWorkUnitRepository` — **speculative.** `implements any` is an illegal TypeScript
  construct (TS2864). Directional intent only.~~ — **RESOLVED.** Both are now real typed
  classes implementing `IPlanFirstRunRepository` / `IWorkUnitRepository`, plus
  `SqliteContractRevisionRepository` and `SqliteVerificationResultRepository`.
- ~~`plan_first_runs` / `work_units` tables — **speculative.** Unwritable (FK to a
  `contract_revisions` table that is never created).~~ — **RESOLVED.** `contract_revisions`
  is now created, and `migratePlanFirstSchema()` (`user_version = 3`) drops the legacy
  pair only when both are empty, hard-throwing if they hold rows.
- `git history` — zero commits for any Plan-First symbol across all branches, refs,
  agent checkpoints, dangling commits, and dangling blobs. Nothing is restorable. The
  Attempt contract was reconstructed from `ATTEMPT_LIFECYCLE.md`,
  `EXECUTION_AUTHORITY.md`, the surviving `SqliteAttemptRepository`, and the `attempts`
  table, not from history.
