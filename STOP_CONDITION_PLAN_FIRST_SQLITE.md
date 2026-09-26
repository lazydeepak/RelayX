# STOP CONDITION — Plan-First SQLite Persistence tranche

Tranche: `SqlitePlanFirstRunRepository` / `SqliteWorkUnitRepository`
Outcome: **STOPPED at Phase 2 (defect classification). No code changes made.**

Baseline verified this session: **267 pass / 27 fail** (matches reported baseline).
Working tree unchanged: 56 porcelain entries before and after.

---

## 1. Headline finding

**No Plan-First implementation has ever existed in this repository's history.**

The assigned task was to "reconstruct the intended contracts from existing evidence"
and implement the missing SQLite persistence. There is no evidence to reconstruct from,
because the entire Plan-First vertical slice has never been committed — it exists only as
uncommitted working-tree scaffolding, and it was written against a domain model that was
never implemented.

Verification performed:

| Check | Command | Result |
|---|---|---|
| Symbol ever in any commit | `git log --all -oneline -S 'PlanFirstRun'` | **0 commits** |
| Same for `WorkUnit` | `git log --all -oneline -S 'WorkUnit'` | **0 commits** |
| Same for `plan_first_runs` | `git log --all -oneline -S 'plan_first_runs'` | **0 commits** |
| Same for `work_units` | `git log --all -oneline -S 'work_units'` | **0 commits** |
| Same for `contract_revisions` | `git log --all -oneline -S 'contract_revisions'` | **0 commits** |
| Same for `runPlanFirstTick` | `git log --all --oneline -S 'runPlanFirstTick'` | **0 commits** |
| Same for `IPlanFirstRunRepository` | `git log --all --oneline -S 'IPlanFirstRunRepository'` | **0 commits** |
| HEAD version of 4 relevant files | `git show HEAD:<file> \| grep -i 'plan.first\|work_unit\|contract_rev'` | **NONE** in all 4 |
| All branches / remote refs | `git for-each-ref` (7 refs, 3 branches) | no Plan-First |
| Agent checkpoint refs | `refs/agents/*/checkpoints/turn/0` (2) | no Plan-First |
| Stash | `git stash list` | empty |
| Reflog (49 entries) | `git reflog \| grep -i plan\|work` | only unrelated commits |
| Dangling commits (9) | `git grep -E 'PlanFirstRun\|plan_first_runs\|WorkUnit' <sha>` | no Plan-First in any |
| Dangling blobs (6) | content scan | no Plan-First in any |

**Conclusion: this is not a lost implementation, not a stale interface implementation, and
not an import/export problem. It is never-implemented speculative scaffolding.**

---

## 2. Exact defects found

### 2.1 Both assigned classes are hard TypeScript syntax errors

`npm run lint` (`tsc --noEmit`) reports **153 errors total**, of which **31 are in
production source** (`src/`) and **122 are in `tests/``. Breakdown by file:

| Errors | File |
|---|---|
| 35 | `tests/core_slice2.test.ts` |
| 26 | `tests/core_slice1.test.ts` |
| 18 | `tests/core_slice9_operational.test.ts` |
| 14 | `tests/core_slice9_pf1_operational.test.ts` |
| **12** | **`src/relay/application/RelayEngine.ts`** |
| 10 | `tests/pf1_operational.test.ts` |
| 8 | `tests/core_slice3.test.ts` |
| **6** | **`src/relay/persistence/sqlite/SqliteRepositories.ts`** |
| 5 | `tests/core_slice8.test.ts` |
| 4 | `tests/core_slice9_pf1.test.ts` |
| **4** | **`src/relay/domain/entities.ts`** |
| 3 | `src/services/relayBridge.ts` |
| 2 | `tests/open_code_worker_session_creation.test.ts` |
| **2** | **`src/relay/persistence/sqlite/SqliteDatabase.ts`** |
| **2** | **`src/relay/persistence/sqlite/SqliteAssociationRepository.ts`** |
| 1 | `src/relay/providers/browserProviders.ts` |
| 1 | `src/relay/application/RelayApiService.ts` |

> Correction: an earlier revision of this section stated "27 errors", derived from a
> truncated `head -60` of the compiler output. The accurate total is **153**.

Two of the production errors are on the assigned classes and are not recoverable by
editing method bodies:

```
src/relay/persistence/sqlite/SqliteRepositories.ts(734,54): error TS2864:
  A class cannot implement a primitive type like 'any'. It can only implement other named object types.
src/relay/persistence/sqlite/SqliteRepositories.ts(747,50): error TS2864:
  A class cannot implement a primitive type like 'any'. It can only implement other named object types.
```

`export class SqlitePlanFirstRunRepository implements any` and
`export class SqliteWorkUnitRepository implements any` are **illegal TypeScript**.
The files do not type-check at all. (esbuild strips types without checking, which is why
`npm run build:electron` still passes and `node --import tsx` still runs the tests.)

### 2.2 There is no `IWorkUnitRepository`

The mission brief lists `IWorkUnitRepository` as an artifact to locate. It does not exist.
`src/relay/persistence/interfaces.ts` contains only:

```ts
export interface IPlanFirstRunRepository {
  findById(id: string): Promise<any | null>;   // returns any
  save(run: any): Promise<void>;              // takes any
}

export interface IRelayRepositories {
  // ...
  planFirstRuns?: IPlanFirstRunRepository;
  workUnits?: any;              // <- no interface at all
  strategies?: any;
  contractRevisions?: any;
  verificationResults?: any;
  repoObservations?: any;
  plannerAssistance?: any;
  plannerActions?: any;
}
```

There is no typed contract to implement against. The `any` is in the interface itself.

### 2.3 There is no domain model to map DB rows to

Required by any correct implementation ("correctly map DB representation ↔ domain
representation"). None of these exist in `src/relay/domain/`:

| Type | Occurrences in `src/` | Role |
|---|---|---|
| `class PlanFirstRun` | 0 | entity needed by both repos |
| `class WorkUnit` | 0 | entity needed by `SqliteWorkUnitRepository` |
| `class ContractRevision` | 0 | FK parent of both tables |
| `class Strategy` | 0 | used by `runPlanFirstTick` |
| `class PlannerAssistance` | 0 | used by `runPlanFirstTick` |

All 5 test files that exercise Plan-First import or destructure these from
`entities.ts` and fail at module load:

```
SyntaxError: The requested module '../src/relay/domain/entities.ts'
  does not provide an export named 'ContractRevision'
```

### 2.4 Schema defect: dangling foreign key to a table that is never created

`initSchema()` creates `work_units` and `plan_first_runs`, both with
`contract_revision_id TEXT NOT NULL REFERENCES contract_revisions(id) ON DELETE CASCADE`.
**`CREATE TABLE contract_revisions` appears nowhere in the repository.**

Empirically verified against the real `SqliteRelayDatabase`:

```
plan_first_runs => id, project_id, contract_revision_id, contract_digest, session_pair_id,
                   status, current_work_unit_id, current_strategy_id, current_attempt_id,
                   created_at, updated_at
work_units      => id, project_id, contract_revision_id, objective, instruction,
                   dependencies, status, created_at, updated_at
contract_revisions => TABLE DOES NOT EXIST

work_units INSERT FAILED: no such table: main.contract_revisions
plan_first_runs INSERT FAILED: no such table: main.contract_revisions
```

Both tables are **provably unusable for writes**. `SqliteWorkUnitRepository.save()` and
`SqlitePlanFirstRunRepository.save()` cannot succeed against the existing schema.
With `PRAGMA foreign_keys = ON` (set in `initSchema`), SQLite resolves the FK parent
lazily and rejects every INSERT.

This is the precise "schema cannot satisfy the interface contract" condition the brief
says to stop and report on before creating a migration.

### 2.5 There is no memory-side semantics to reconcile against

The contract-matrix template requires a `memory semantics` column. `MemoryRelayDatabase`
declares no `planFirstRuns` and no `workUnits`, and `runInTransaction` snapshots only the
10 classic repositories. There is no in-memory reference implementation to mirror.

### 2.6 The only "caller" contradicts the stub, and does not compile

`RelayEngine.runPlanFirstTick` (line 1432) is the sole consumer. It has **zero production
callers** — `RelayApiService` never invokes it. It is called only from 3 test files.
It produces 12 `tsc` errors, referencing nine further subsystems that do not exist:

```
RelayEngine.ts(1480,24): TS2552: Cannot find name 'Strategy'.
RelayEngine.ts(1488,66): TS2554: Expected 2 arguments, but got 3.        // Attempt.create
RelayEngine.ts(1489,44): TS2552: Cannot find name 'pair'.               // used outside its block scope
RelayEngine.ts(1490,56): TS2552: Cannot find name 'pair'.
RelayEngine.ts(1491,58): TS2552: Cannot find name 'pair'.
RelayEngine.ts(1499,21): TS2339: Property 'startRunning' does not exist on type 'Attempt'.
RelayEngine.ts(1501,43): TS2339: Property 'executeMechanicalVerification' does not exist on type 'RelayEngine'.
RelayEngine.ts(1512,32): TS2339: Property 'completeAssignment' does not exist on type 'IAssignmentRepository'.
RelayEngine.ts(1526,28): TS2304: Cannot find name 'PlannerAssistance'.
RelayEngine.ts(1535,21): TS2339: Property 'assistance' does not exist on type 'IRelayRepositories'.
RelayEngine.ts(1536,21): TS2339: Property 'assistance' does not exist on type 'IRelayRepositories'.
SqliteDatabase.ts(62,10): TS2339: Property 'planFirstRuns' does not exist on type 'SqliteRelayDatabase'.
SqliteDatabase.ts(63,10): TS2339: Property 'workUnits' does not exist on type 'SqliteRelayDatabase'.
```

Missing capabilities it depends on: `repos.contractRevisions`, `repos.strategies`,
`repos.repoObservations` (`saveForAttempt`), `repos.verificationResults`,
`repos.assistance`, plus `Strategy`, `PlannerAssistance`,
`Engine.executeMechanicalVerification`, `Attempt.startRunning`,
`IAssignmentRepository.completeAssignment`.

### 2.7 Internal contradictions proving the contract is undetermined

Even taking the stub as the specification, it contradicts itself and its caller:

1. **Row shape mismatch.** `SqlitePlanFirstRunRepository.findById` returns the *raw DB
   row* (snake_case: `project_id`, `contract_revision_id`, `current_work_unit_id`).
   The only caller reads *camelCase domain properties*
   (`run.contractRevisionId`, `run.currentWorkUnitId`, `run.contractDigest`) and calls
   `run.updateStatus('blocked')` — a method no row can have. No domain type exists to map to.

2. **`findNextEligible` return-type contradiction.** The stub returns
   `{ id, objective, status } | null`. The caller assigns the result directly to
   `run.currentWorkUnitId`, which is a scalar ID (lines 1514). The stub's own declared
   contract is incompatible with its only call site.

3. **`findNextEligible` ignores its own `afterUnit` parameter**, and the `work_units`
   table has **no ordering column** — only `created_at`. Yet the tests declare
   `wu2: { depends: 'wu1' }`. `dependencies` is an unparsed TEXT blob with no reader
   anywhere. Therefore Phase 5 requirement 7 ("WU2 retains its correct state/**order**")
   and requirement 8 ("current/next determination survives reconstruction") are **not
   expressible in the current schema**.

4. **`plan_first_runs` has no `current_assignment_id` column**, but the caller reads
   `run.currentAssignmentId` (line 1470) and relies on it for restart recovery.

5. **`work_units` has no attempts/counters/evidence columns**, but Phase 5 requirement 9
   demands that "attempts/counters/evidence fields required by the existing contract
   survive". There is no such contract and no such columns.

### 2.8 The project's own design record forbids proceeding

The unfrozen status is documented, not inferred:

- `DOMAIN_DELTA.md:4` — "Unfrozen: Contract Revision form, Strategy Lineage,
  retry-budget, dispatch-correlation, **DB layout**"
- `DOMAIN_DELTA.md:60` — "Contract Revision: **entity vs value object? (history + cardinality)**"
- `DOMAIN_DELTA.md:96` — "Contract Revision physical storage (**entity/value/table** — section 14)"
- `DOMAIN_DELTA.md:100` — "DB layout / SQLite columns / migrations (section 22 — **after freeze**)"
- `P0_MATRIX.md:86-90` (Invariant 9) — "Current model: **None (missing)**"; "Current
  persistence: **No contract / revision table**"; "Current tests: **None**"; "Confirmed gap"
- `P0_MATRIX.md:131` — Summary gap 5: "No contract revision / strategy lineage / budget
  enforcement (Inv 9 / 10)"

Creating the missing `contract_revisions` table means choosing Contract Revision physical
representation (entity / value object / normalized) and its cardinality — a decision the
design record explicitly reserves as unfrozen and pending section 14 / section 22.
That is new architecture, which the tranche is explicitly forbidden from inventing.

---

## 3. Causality: these two repositories are NOT the cause of any of the 27 failures

The brief asked for causality to be established rather than assumed. It is negative.

Exactly **5** test files reference Plan-First at all. **Every one of them fails strictly
before reaching repository code** — at parse time, module-load time, or at the pairing gate.

| Test file | Failure | Stage reached | Cause class |
|---|---|---|---|
| `core_slice9_pf1_operational.test.ts` | esbuild `TransformError`: `The symbol "tmpDir" has already been declared` | **never parses** | test defect (file is syntactically invalid) |
| `core_slice9_operational.test.ts` | `SyntaxError: does not provide an export named 'ContractRevision'` | module load | missing domain model |
| `pf1_operational.test.ts` | `SyntaxError: does not provide an export named 'ContractRevision'` | module load | missing domain model |
| `core_slice9_pf1.test.ts` | `ReferenceError: bindPair is not defined` | runtime, first use | test defect (undefined symbol) |
| `core_slice8.test.ts` | `RelayDomainError: planner session lacks matching pre-pair verified authoritative association` at `createPair` (`RelayEngine.ts:421`) | pairing gate | fixture incompatible with authority rules |

The other 22 failures are in `core_slice1/2/3`, `management_lifecycle`,
`manual_planner_gate`, and provider/bridge tests. **None of those files reference
`planFirstRuns`, `workUnits`, `PlanFirstRun`, `WorkUnit`, `ContractRevision`,
`contractRevisions`, or `runPlanFirstTick`.** They are causally independent.

### Full 27-failure classification

| # | Test | Cause class | Detail |
|---|---|---|---|
| 1 | `core_slice1` T1 — Frozen authority survives Pair mutation | unrelated pre-existing defect (missing domain model) | `Attempt` has no `sessionPairId`; `SqliteRepositories.ts(414,452,453,454)` map fields `Attempt` does not declare. `EXECUTION_AUTHORITY.md` Freeze A requires them. |
| 2 | `core_slice1` T2 — Attempt begins prepared, not running | unrelated pre-existing defect (same as #1) | `actual: undefined, expected: true` — frozen authority absent. |
| 3 | `core_slice1` T6 — Crash-equivalent unresolved dispatch blocks blind resend | unrelated pre-existing defect | `FOREIGN KEY constraint failed` in dispatch-intent/recovery path (Invariant 4 / 5 gap). |
| 4 | `core_slice1` T7 — Delivery failure does not pretend execution | unrelated pre-existing defect | `delivery.status` `'failed'` vs expected `'prepared'`. |
| 5-8 | `core_slice2` R1-R4 — restart reconciliation | fixture incompatible with authority rules | `planner session lacks matching pre-pair verified authoritative association` — fixtures do not establish authoritative pre-pair associations. |
| 9-11 | `core_slice2` R5-R7 | test defect | `UNIQUE constraint failed: runtime_project_associations.runtime_session_id, project_id` — tests re-save association rows on a shared DB, violating the uniqueness guard established in the closed tranche. |
| 12 | `core_slice3` B1 | test defect | `ENOENT ... /tmp/relay_b1_*/src/auth.ts` — fixture reads a file it never creates. |
| 13 | `core_slice3` B4 | test defect | same `ENOENT` class. |
| 14 | `core_slice3` B7 | fixture incompatible with authority rules | association gate. |
| 15 | `management_lifecycle` 1 — Project safe deletion | unrelated pre-existing defect | deletion-guard semantics; project not deleted when "clean". |
| 16 | `management_lifecycle` 3 — Pair safe deletion | unrelated pre-existing defect | deletion-guard semantics. |
| 17 | `management_lifecycle` 5 — Add Project Workflow finalize | unrelated pre-existing defect | `actual: 0, expected: 1`. |
| 18 | `core_slice8` PF1 | fixture incompatible with authority rules | fails at `createPair` gate, before any Plan-First call. |
| 19 | `core_slice9_pf1` PF1 | test defect | `bindPair` undefined. |
| 20 | `core_slice9_operational` (file) | missing domain model | `ContractRevision` not exported. |
| 21 | `core_slice9_pf1_operational` (file) | test defect | duplicate `tmpDir` declaration; file does not parse. |
| 22 | `pf1_operational` (file) | missing domain model | `ContractRevision` not exported. |
| 23 | `manual_planner_gate` | test defect | gate correctly rejects, but reports `worker session lacks...` while the assertion expects `planner session lacks...` — wrong expected message for its own fixture. Production behavior is correct and was **not** modified. |
| 24 | `cli_backed_provider` — confirmSessionForProject verifies authoritativeSessionId | unrelated pre-existing defect | provider/CLI correlation. |
| 25 | `cli_backed_provider` — Truthful provider integration status | unrelated pre-existing defect | provider status reporting. |
| 26 | `adopt_existing_session_isolated` — authoritative adopted sessions pair | fixture incompatible with authority rules | exact pre-pair evidence not established by fixture. |
| 27 | `opencode_shared_session_client` — preserves multiple project sessions | unrelated pre-existing defect | `actual: 0, expected: 2`. |

**Zero of the 27 are caused by `SqlitePlanFirstRunRepository` or `SqliteWorkUnitRepository`.**

---

## 4. Why implementation was not attempted

Every one of these is a brief-listed stop condition, and they are met independently:

| Stop condition | Met? | Evidence |
|---|---|---|
| Interface and schema fundamentally disagree | **Yes** | `implements any`; no `IWorkUnitRepository`; raw-row vs camelCase contract; `findNextEligible` object assigned to a scalar; `current_assignment_id` absent; no ordering column |
| Required migration semantics cannot be established from evidence | **Yes** | `contract_revisions` never created; `DOMAIN_DELTA.md:96,100` list Contract Revision storage + DB layout as unfrozen |
| Implementation would require redesigning Plan-First | **Yes** | 5 domain types + 5 repositories + 3 engine methods must be invented |
| Unrelated corrupted / restored source discovered | **Yes** | Plan-First source written against a domain model that never existed; `git log --all -S` = 0 commits for every Plan-First symbol |
| Historical evidence contradicts the assumed repository contract | **Yes** | There is no historical contract at all |

Implementing anyway would have required: inventing `PlanFirstRun`, `WorkUnit`,
`ContractRevision`, `Strategy`, `PlannerAssistance`; inventing the `contract_revisions`
table and its representation; adding a `current_assignment_id` column; adding a
work-unit ordering column; adding attempts/counters/evidence columns; defining
`IWorkUnitRepository`; and rewriting `runPlanFirstTick` against 9 missing subsystems.
That is a Plan-First redesign plus a DB freeze — both explicitly out of scope.

---

## 5. Invariant confirmation

Discovery / pairing / association work was **not touched**. No production file was
modified this tranche. `git status --porcelain` count is 56 before and after, with an
identical entry list. The association uniqueness guard, the pre-pair authoritative
association gate, `findVerifiedBySessionId` criteria enforcement, and every other
closed-tranche guard remain byte-identical.

Note: failures #5-11, #14, #18, #23, #26 are association-related, but they are
**fixture/test** defects. The correct repair is to establish authoritative pre-pair
association evidence in those fixtures, never to relax the gate. The gate's current
behavior — rejecting — is right and was left intact.

---

## 6. What must be decided before this tranche can proceed

These are design decisions, not implementation tasks. They are recorded here for
resolution, not answered by this tranche.

1. **Contract Revision representation** (unfrozen, `DOMAIN_DELTA.md:60,96`): entity,
   value object, or normalized table? What is its cardinality and history model?
2. **DB layout freeze** (`DOMAIN_DELTA.md:100`, section 22): must be frozen before
   `contract_revisions` and its dependents can be migrated.
3. **Work-unit ordering semantics**: the tests express `depends: 'wu1'`. Is order derived
   from a `sequence` column, from `created_at`, or from the dependency graph? The current
   schema can express none of these.
4. **Run ↔ assignment linkage**: add `plan_first_runs.current_assignment_id`, or drop
   the field from the controller contract.
5. **`findNextEligible` return shape**: a unit ID, or a unit projection? The controller
   and the repository currently disagree.
6. **Row ↔ domain mapping target**: define `PlanFirstRun` / `WorkUnit` entities, or
   explicitly standardise repositories on returning DB-shaped records and adapt the engine.
7. **Missing subsystems** before any operational Plan-First trial is meaningful:
   `Strategy`, `PlannerAssistance`, `executeMechanicalVerification`,
   `Attempt.startRunning`, `IAssignmentRepository.completeAssignment`, and the
   `strategies` / `contractRevisions` / `verificationResults` / `repoObservations` /
   `assistance` repositories.

Until items 1-2 are decided by the project owner, no correct implementation of
`SqlitePlanFirstRunRepository` or `SqliteWorkUnitRepository` can be written, because both
tables are structurally unwritable until `contract_revisions` exists.

---

## 7. Readiness for the next tranche

**Not ready.** The planned next step is the "production-controller persistent multi-unit
execution trial" (`WU1 → verify → accept → persist → restart → recover → WU2 → complete`).
That trial requires:

- a runnable Plan-First controller — `runPlanFirstTick` does not compile and has 9
  missing dependencies;
- writable Plan-First tables — both are unwritable (`no such table: main.contract_revisions`);
- domain types — 5 do not exist.

`Phase 5 — restart/persistence proof` was likewise not attempted: it requires persisting
work units, which the schema currently cannot do at all.

Recommended prerequisite tranche: resolve decisions 1-2 above, then land the domain
entities and a `contract_revisions` migration, then re-open this tranche.
