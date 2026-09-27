# S1 — Session Pair semantics: implementation record

Frozen source: `DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md` (commit `a1cf1b1`)
Slice: **S1 — Pair semantics** (§18). S0 (`ef6185b`, `OPENCODE_SESSION_DISCOVERY.md`) verified intact.
Status: working tree only. Nothing committed, nothing staged, nothing pushed.

This document records exactly what S1 changed, what it deliberately fenced, and
what remains unsupported. Everything listed under "Implemented" is backed by an
executable assertion; every claim in this file is meant to be falsifiable by a
test, not by reading prose.

---

## 0. Scope and non-scope

**In scope.** Domain and evidence integrity only:

- `Pair.operationalState`, a persisted dimension of exactly two values.
- The IDLE provider-contact gate, and its single source of truth.
- External-effect evidence: no durable record may assert an external fact that was
  not established by provider evidence.
- The additive v4 schema step and the `IDLE` backfill.
- `Pair.stableId`, the safe prerequisite half of C-1.

**Explicitly not implemented, and not partially implemented** (§18 slices):

| Not done | Slice |
|---|---|
| Provider observation (nine dimensions, tri-state) | S2 |
| Durable per-side cursors / message provenance | S3 |
| Provider-neutral message read | S4 |
| Exact-session activation | S5 |
| **Load & Activate / Make Idle at the service layer** | **S6** |
| Continuity / advance states | S7 |
| Readiness | S8 |
| Exact Worker delivery | S9 |
| Real Worker response extraction | S10 |
| Exact Planner delivery | S11 |
| Pair Detail R2 | S13 |
| Composer | S14 |
| Prompt Templates | S15 |
| New/New creation | S16 |
| Autonomous supervision | S18 |

**Protected and untouched.** `a1cf1b1`, `ef6185b`, `OPENCODE_SESSION_DISCOVERY.md`,
`SESSION_PAIR_REPLACEMENT.md`. The OpenCode discovery and creation gates are
consumed as-is; nothing was redesigned, weakened, bypassed, or gated off (I-16).

**Pre-existing dirty files, preserved byte-for-byte:**

- `src/components/PairModal.tsx`
- `src/relay/application/RelayApiService.ts`
- `tests/planner_conversation_binding.test.ts`

None of them was edited, staged, or reverted. Verified by diffing the current
diff of those three files against the diff captured before S1 began: identical.

---

## 1. Implemented now

### 1.1 `Pair.operationalState` — exactly two values, unrepresentable otherwise

`src/relay/domain/types.ts`

```ts
export const PAIR_OPERATIONAL_STATES = ['IDLE', 'ACTIVE'] as const;
export type PairOperationalState = (typeof PAIR_OPERATIONAL_STATES)[number];
export const DEFAULT_PAIR_OPERATIONAL_STATE: PairOperationalState = 'IDLE';
export const isPairOperationalState = (value: unknown): value is PairOperationalState => ...
```

`src/relay/domain/entities.ts` — `Pair` exposes `operationalState` as a
**validated getter/setter** over a private backing field, not a plain public
field. A third value throws `PAIR_OPERATIONAL_STATE_INVALID`; it is therefore
unrepresentable rather than merely discouraged, and a rejected value is not
applied.

- `Pair.create(...)` defaults to `IDLE` and never to `ACTIVE` (§17.3).
- A Pair constructed without an operational value (a pre-v4 row, a hand-built
  literal) reads `IDLE`.
- The constructor assigns through the validating setter, so a constructor-supplied
  value is validated exactly like any later assignment.

`tests/pair_operational_state.test.ts` proves: exactly two declared values; a
third value rejected at construction *and* on assignment for `ACTIVATING`,
`LOADING`, `checking`, `READY`, `ready`, `idle`, `active`, and `''`; the runtime
guard exact in both directions; both values round-tripping through SQLite.

### 1.2 Orthogonal dimensions, one owner each (§4.1, §4.2, §17.2)

**U-6 resolved as "retain".** `PairStatus` keeps `idle`/`active` as deprecated
aliases rather than being narrowed, following the Plan-First precedent of refusing
destructive change. Two sources of truth for operational state would violate I-1,
so the resolution is enforced structurally rather than by convention:

- `Pair.operationalState` is the **only** input to the provider-contact gate. It
  reads nothing else — not `status`, not a runtime's last-known status, not a last
  observation. A test forces `status` to disagree with `operationalState` in both
  directions and proves the gate follows `operationalState` both times.
- The lifecycle methods (`assignWork`, `clearWork`, `pause`, `resume`, `archive`,
  `unarchive`) are the **only** writers of `status`, and they never write
  `operationalState`. A lifecycle change never moves operational state, and
  `makeActive`/`makeIdle` never move lifecycle state or the work record.

### 1.3 The IDLE provider-contact gate (I-2, I-3)

```ts
Pair.isProviderContactPermitted(): boolean     // operationalState === 'ACTIVE'
Pair.assertProviderContactPermitted(): void     // throws PAIR_OPERATIONAL_STATE_IDLE
Pair.makeActive(reason?) / Pair.makeIdle(reason?)  // pure state transitions
```

- The gate is blind to stale last-known evidence. A test seeds a runtime whose
  persisted status is `working` with fresh `lastEvidence`, then flips every
  last-known signal to "definitely reachable"; the IDLE pair still refuses
  contact, and the evidence is **retained** rather than cleared (I-3, I-10).
- `makeActive` / `makeIdle` contact no provider, proven with a `CountingProvider`
  that records every capability invocation. The same counter proves that
  persisting, listing, and displaying a Pair contacts nothing.
- `makeIdle` is idempotent and preserves bindings, `activeAssignmentId`, name,
  identity, `stableId`, lifecycle status, last-known evidence, and assignment
  history (§4.5, I-10).

### 1.4 ACTIVE is a permission, not an activity level (I-4, I-5)

A test proves an ACTIVE Pair with no `activeAssignmentId`, no assignments, no
unresolved deliveries, no pending handoffs, no supervision loop, zero provider
calls, and exactly one event (`pair.created`, carrying no evidence). It also
proves no readiness-shaped field exists on a `Pair` at all — persisted or
otherwise (I-5, C-3).

### 1.5 The additive v4 migration (§10.1, §10.2, §17.1, §17.3)

`src/relay/persistence/sqlite/SqliteDatabase.ts` —
`migrateSessionPairOperationsSchema()`, gated on `PRAGMA user_version`, using the
existing `addColumnIfNeeded(...)` pattern, following the `migratePlanFirstSchema()`
precedent and ordering.

| Column | Type | Purpose |
|---|---|---|
| `pairs.operational_state` | `TEXT NOT NULL DEFAULT 'IDLE'` | I-1, exactly two values |
| `pairs.stable_pair_id` | `TEXT` | C-1 safe prerequisite |
| `handoffs.planner_delivery_evidence_json` | `TEXT` | §7.3, I-13 (see §1.7) |

- `user_version` 3 → 4.
- **Additive only.** No column or table was dropped, narrowed, or renamed. A test
  enumerates `pragma_table_info('pairs')` and asserts every pre-existing column
  survives alongside the new ones.
- **Backfill to `IDLE` is the only safe default.** `ACTIVE` would grant a
  provider-contact permission that cannot be justified for a record predating the
  permission. A test builds a genuinely legacy v0 file — including one Pair whose
  lifecycle `status` is already `active` — and proves the deprecated alias is
  **not** promoted into an operational permission: it backfills to `IDLE` while
  `status` and `name` are left untouched.
- Backfill is idempotent and only fills NULL/invalid values, so a decided `ACTIVE`
  is never re-backfilled on reopen. A hand-corrupted third value is coerced to
  `IDLE` by the repository mapper (`isPairOperationalState` re-applied on read),
  so the persisted set cannot be widened from outside.
- `stable_pair_id` is backfilled to the row's own `id` and is **omitted from the
  upsert `DO UPDATE` set**, so it is a true immutable anchor. A test asserts the
  omission from the source text, not just the behaviour.

### 1.6 External-effect evidence semantics

`Handoff.markDeliveredToPlanner(evidence)` now **requires** provider evidence and
throws `MissingEvidenceError` without it, mirroring the existing
`Delivery.confirmDelivered` gate. Before this, it was callable with no evidence at
all, which is how a pure local transition manufactured a Planner-delivery record
(§9.4.1, §7.3).

`src/relay/domain/types.ts` adds the external-effect vocabulary as a **mapping
onto the existing statuses**, not a second state machine:

```ts
export type ExternalEffectClass =
  | 'intended' | 'attempted' | 'externally_confirmed'
  | 'failed' | 'ambiguous' | 'unverified';

export const EXTERNAL_EFFECT_CLASS_ASSERTS_OCCURRED = (c) => c === 'externally_confirmed';

classifyDeliveryStatus(status): ExternalEffectClass
classifyAttemptStatus(status): ExternalEffectClass
classifyHandoffStatus(status): ExternalEffectClass | null   // null = makes NO claim
```

`null` is load-bearing: `complete` and `suspended` are local lifecycle
conclusions about the RelayX record, and reading either as evidence that the
Planner was told is precisely the defect this exists to prevent. Tests prove each
classifier is total over its union and that **only** `externally_confirmed` asserts
occurrence, and that `ambiguous` never collapses to `failed` (I-6).

### 1.7 Provenance separation: two evidence fields, not one

`Handoff.evidence` records what the **Worker** produced (`markReady`).
`Handoff.plannerDeliveryEvidence` records what the **Planner** was told
(`markDeliveredToPlanner`, evidence required). They are separate fields with
separate columns.

Before this split, delivering to the Planner **overwrote** the Worker-produced
evidence — destroying a `provider-produced` provenance record in order to record a
different one (§7.3, I-13). This is a real defect, not a hypothetical one: the
supervision tick sets `Handoff.evidence` from the Worker's completion observation
on every normal run, so the overwrite was on the main path.

### 1.8 `planner.delivery.unverified`, and a truthful `previousState`

- `attemptPlannerDelivery(handoffId): Promise<PlannerDeliveryAttempt>` is the new
  honest surface. `PlannerDeliveryAttempt` is a discriminated union:

  ```ts
  | { handoff; outcome: 'unverified'; reason: string; externalContactAttempted: false }
  | { handoff; outcome: 'externally_confirmed'; evidence: ObservableEvidence; externalContactAttempted: true }
  ```

  The `externally_confirmed` variant has **no construction path in S1**: it
  requires an exact Planner transport (S11) that returns provider evidence. It is
  declared so the future success path is typed, not so it can be assumed. A test
  calls it repeatedly and proves the confirmed variant is unreachable.

- `deliverHandoffToPlanner()` is retained as a `@deprecated` fence. It delegates
  to `attemptPlannerDelivery` and then throws
  `RelayDomainError(..., 'PLANNER_DELIVERY_UNSUPPORTED')`.

  **Why throwing rather than returning an unverified result:** the only caller,
  `RelayApiService.deliverHandoff` (`:961`), discards the return value and
  returns `{ success: true }`. A returned outcome would be read as success by that
  caller. Throwing is the only way to make the existing surface truthful
  **without editing a protected dirty file**. A test asserts through
  `RelayApiService` that `{ success: true }` is never returned.

- The durable handoff is left **exactly as found**: status stays `ready`,
  `deliveredToPlannerAt` stays `undefined`, result summary and payload are
  byte-identical. No durable data is silently rewritten.

- `planner.notified` is gone. A test walks every `.ts`/`.tsx` file under `src/`
  and fails if the string appears in anything other than a comment, and separately
  asserts it never appears in a 500-event stream.

- `planner.delivery.unverified` is emitted with `previousState === newState ===
  'ready'` (the event does not pretend the handoff advanced), no evidence, and
  `details.externalContactAttempted === false`.

- `completeHandoff()` previously emitted `previousState: 'delivered'` as a
  **hardcoded literal**, writing "the Planner had been notified" into the audit
  stream for handoffs that were never delivered. It now records the real prior
  state. A test completes a `ready` handoff and asserts the event says `ready`.

---

## 2. Fenced for a later slice

These are **deliberately not implemented**, with the reason recorded in code at
the call site. Fencing is not the same as forgetting.

### 2.1 Full C-1 replacement (blocked)

`SESSION_PAIR_REPLACEMENT.md` §3 requires replacement to create a **new** Pair.
`RelayEngine.updatePair()` still mutates the same row. Two existing regression
gates assert that behaviour:

- `tests/pair_mutation_association.test.ts:173` — `assert.strictEqual(updated.id, pair.id)`.
  This file is in the executable preservation map of `OPENCODE_SESSION_DISCOVERY.md`
  (I-16). Re-deciding it is outside S1's authority.
- `tests/management_lifecycle.test.ts:127-133` — re-reads the Pair by its
  **pre-update** `pair.id` after the same call.

Any implementation returning a different row breaks both. What S1 delivers instead
is the safe prerequisite: `Pair.stableId` / `pairs.stable_pair_id`, set once and
never rewritten, so the in-place mutation can no longer silently move the
ownership of a recorded fact. A test proves the anchor survives a rebinding,
survives a hostile direct `UPDATE` of the row id, and is absent from the
`DO UPDATE` set. A test also asserts no `replacePair`/`adoptPair` operation exists,
so the contract cannot be half-implemented.

This is recorded as a narrow `[VERIFIED]` correction in
`DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md` §18.1.

### 2.2 The §11.5 provider-contact gate is defined but not armed at the call sites

`Pair.assertProviderContactPermitted()` is the single enforcement point, and it
exists. It is **not yet wired** into `dispatchAssignment`, `runSupervisionTick`,
`startSupervisionLoop`, or `recoverOnStartup`, which today contact providers for
IDLE Pairs.

**Why not armed now:** `ACTIVE` is granted by Load & Activate (S6), and no
operation exists yet that can grant it. Arming the gate at S1 would leave every
Pair IDLE forever and silently disable all supervision, and would break the
three-phase dispatch contract pinned by T6 in `core_slice1`. §11.5 places the
enforcement in the application service; S6 is where it belongs.

`[MEASURED BY S1B]` The cost of arming without a grantor is **45 additional test
failures across 14 files** — all of `core_slice1` T1–T7, all of
`dispatch_reconciliation` R1–R7b, all of `pf1_operational` Boundaries 0–7, and all
of the Phase 3/4 and 8/11 supervision and recovery suites. See
`S1B_PROVIDER_CONTACT_GATE.md` §3.3.

`[CORRECTED BY S1B]` "Exactly four call sites" was also wrong: two more exist
(`probeDispatchOutcome` → `provider.reconcileDispatch`, and
`reconcileInFlightPlanFirstUnit` → `provider.detectWorkingState`). See §4.

**This is an S6 dependency, not an accepted defect.** Each of the four call sites
carries a comment naming the gate to use and stating that S6 wires it and nothing
else may.

### 2.3 The cascade hazard (§10.5, U-9)

`assignments.pair_id` is `ON DELETE CASCADE` to `pairs`. **Unchanged** — N-15 and
§10.5 freeze it as undecided. No delete-and-reinsert replacement is used anywhere.
A test asserts the cascade is still declared and that assignment, attempt,
delivery, and handoff history survives a rebinding intact.

### 2.4 Checkpoints (§6.4, I-14, S3)

`RuntimeSession.lastEvidence` is a single overwrite-on-write field. It is
**unchanged**, and is explicitly documented in the entity as the *latest
observation*, **not** an acknowledged checkpoint. No checkpoint column was added:
§6.4's "observing does not advance the checkpoint" is a property of the S3 model,
and adding a field now would create the illusion of one. Tests assert no
checkpoint-shaped column or field exists and that repeated observations overwrite
`lastEvidence` without fabricating an acknowledged state.

### 2.5 Dormant schema, still dormant

`planner_assistances` (`SqliteDatabase.ts`) and `planner_action_requests` still
have **no writer in `src/`**. Per §9.4.1 these are dormant schema, not a
capability. S1 did not wire them and did not remove them (N-22).

---

## 3. Unsupported until exact Planner transport exists (S11)

### 3.1 Delivery to a specific Planner conversation

`IRuntimeProvider` has no method that delivers into a specific conversation, and
`OpenCodeSessionClient` is read-only. RelayX therefore **cannot** deliver into a
specific planner conversation by any exact-session means.

`attemptPlannerDelivery()` consequently performs **no external contact at all**,
returns `outcome: 'unverified'` with `externalContactAttempted: false`, and
records that fact. A test intercepts every provider capability on both sides and
proves zero calls.

A future exact-session capability must satisfy §9.6: address the target by the
provider's own external session identifier (I-11); return proof of target identity
at the moment of send or report `ambiguous` / `failed`; preserve the three-phase
`dispatchAssignment` discipline with the external call **outside** the
transaction; preserve `delivered | ambiguous | failed`; and not weaken I-7.

### 3.2 Invariant 6 is unchanged

Handoff completion still does not complete an assignment. The corrected
planner-delivery path does not alter that.

---

## 4. Where the I-2 gate must be wired (S6 checklist)

`[CORRECTED BY S1B]` The original version of this table listed four call sites and
claimed the stranded-intent reconciliation "reads RelayX's own database only and is
already correct under I-2". **That claim was wrong.** `reconcileUnresolvedDispatches`
→ `probeDispatchOutcome` calls `provider.reconcileDispatch(...)`
(`RelayEngine.ts:1725`), which is a real external provider contact, reached from both
`recoverOnStartup` and `dispatchPlanFirstUnit`. It is in scope for the gate, and it
is scoped by *delivery* rather than by Pair, so gating it needs a
delivery → assignment → pair lookup per unresolved intent. See
`S1B_PROVIDER_CONTACT_GATE.md` §5.3.

`[CORRECTED BY S1B]` A fifth site was also missing:
`reconcileInFlightPlanFirstUnit` (`RelayEngine.ts:2510`) calls
`provider.detectWorkingState(...)` and is reachable from `runPlanFirstTick`.

| Site | Current behaviour | Required by S6 |
|---|---|---|
| `RelayEngine.dispatchAssignment` | contacts the worker for an IDLE pair | refuse unless `isProviderContactPermitted()` |
| `RelayEngine.runSupervisionTick` | calls `provider.inspectRuntime` for IDLE pairs | skip IDLE pairs |
| `RelayEngine.startSupervisionLoop` | ticks continuously | only tick while at least one pair is ACTIVE |
| `RelayEngine.recoverOnStartup` | inspects runtimes at startup | gate the inspection |
| `RelayEngine.probeDispatchOutcome` (via `reconcileUnresolvedDispatches`) | calls `provider.reconcileDispatch` — **a real contact, not a local read** | refuse/skip when the owning Pair is IDLE |
| `RelayEngine.reconcileInFlightPlanFirstUnit` | calls `provider.detectWorkingState` | skip when the Pair is IDLE |

S6 also introduces the only operation permitted to call `makeActive()`:
`loadAndActivate(pairId)`, per-side honest per §11.3, rejecting a repeat call on
an already-ACTIVE pair per §11.4.

`[STOPPED]` S1B could not wire any of these. None of them can be armed without an
operation that can grant ACTIVE, and no such operation exists — `makeActive()` has
zero callers and `startPair`/`resumePair` leave `operationalState` at `IDLE` by
design (§4.4, I-9, N-16, N-18). Arming was measured at 45 additional test failures
across 14 files. The escalation and its three options are in
`S1B_PROVIDER_CONTACT_GATE.md` §3–§4.

---

## 5. Tests

### 5.1 New suites

| Suite | Tests | Proves |
|---|---|---|
| `tests/pair_operational_state.test.ts` | 19 | I-1, I-2, I-3, I-4, I-5, I-10, §4.1, §4.2, §4.5, §10.2, §17.2, §17.3 |
| `tests/external_effect_evidence.test.ts` | 22 | I-6, I-13, §7.3, §9.4, §9.4.1, §9.6 |
| `tests/pair_replacement_fence.test.ts` | 18 | C-1 fence, I-10, §6.4, §8, §10.5, `SESSION_PAIR_REPLACEMENT.md` §3/§4 |

### 5.2 Existing tests updated for corrected semantics

| Test | Change |
|---|---|
| `tests/domain.test.ts` | `markDeliveredToPlanner` now takes evidence |
| `tests/engine.test.ts` | asserts rejection, handoff stays `ready`, `deliveredToPlannerAt` undefined |
| `tests/sqlite_migration.test.ts` | 3 × version `3` → `4` |
| `tests/plan_first_schema.test.ts` | 3 × version `3` → `4`, plus one test title |

### 5.3 Results

| Check | Baseline | After S1 |
|---|---|---|
| `npm test` — tests | 355 | 414 |
| `npm test` — suites | 68 | 85 |
| `npm test` — pass | 340 | 399 |
| `npm test` — fail | **15** | **15** |
| Distinct failing cases | 14 | 14 — **identical set** |
| `npm run lint` (tsc) | 39 errors, all in `core_slice2/3` | 39 errors, same files |
| `npm run build` | exit 0 | exit 0 |
| `git diff --check` | clean | clean |

**No new failure was introduced and no pre-existing failure was fixed.** The 15
failures are the same 15, compared case-by-case with timings stripped. All are
pre-existing and unrelated to S1: restart reconciliation / dispatch-intent (R1–R8),
repository-boundary B1/B4/B7, truthful provider integration status, the Add Project
workflow finalization, and the manual-planner pre-pair association gate.

### 5.4 Protected OpenCode gates, run explicitly

All green, 83 tests across 12 suites:

`opencode_shared_session_client`, `authoritative_opencode_discovery`,
`adapters_match_regression`, `staged_discovery`, `discovery_semantic_correction`,
`open_code_worker_session_creation`, `cli_backed_provider`,
`project_session_enumeration`, `pair_mutation_association`,
`focused_pairing_association`, `manual_non_null_external_test`,
`pair_session_change_isolation`.

---

## 6. Files changed

| File | Change |
|---|---|
| `src/relay/domain/types.ts` | `PAIR_OPERATIONAL_STATES`, `PairOperationalState`, `DEFAULT_PAIR_OPERATIONAL_STATE`, `isPairOperationalState`; `ExternalEffectClass` + `EXTERNAL_EFFECT_CLASS_ASSERTS_OCCURRED` + three classifiers; `PairStatus` alias documentation; `HandoffStatus.delivered` evidence note |
| `src/relay/domain/entities.ts` | `Pair.stableId`, private `operational` + validated accessor, `makeActive`/`makeIdle`/`isProviderContactPermitted`/`assertProviderContactPermitted`, lifecycle ownership block; `Handoff.plannerDeliveryEvidence` + evidence-gated `markDeliveredToPlanner`; `RuntimeSession` checkpoint fence comment |
| `src/relay/persistence/sqlite/SqliteDatabase.ts` | `planner_delivery_evidence_json` column; `addColumnIfNeeded` for all three new columns; `migrateSessionPairOperationsSchema()` gated on `user_version >= 4` with idempotent backfill; `PRAGMA user_version = 4` |
| `src/relay/persistence/sqlite/SqliteRepositories.ts` | `SqlitePairRepository.mapRow` re-guards `operational_state` and falls back `stable_pair_id` → `id`; `save()` writes both new columns, `stable_pair_id` deliberately absent from `DO UPDATE`; `SqliteHandoffRepository` maps and writes `planner_delivery_evidence_json` |
| `src/relay/application/RelayEngine.ts` | `PlannerDeliveryAttempt`; `attemptPlannerDelivery()`; deprecated fenced `deliverHandoffToPlanner()`; truthful `previousState` in `completeHandoff()`; four S6 gate-fence comments |
| `tests/domain.test.ts`, `tests/engine.test.ts`, `tests/sqlite_migration.test.ts`, `tests/plan_first_schema.test.ts` | updated for corrected semantics |
| `tests/pair_operational_state.test.ts`, `tests/external_effect_evidence.test.ts`, `tests/pair_replacement_fence.test.ts` | new |
| `DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md` §18.1 | one narrow `[VERIFIED]` factual correction recording the C-1 fence |
| `S1_PAIR_SEMANTICS_IMPLEMENTATION.md` | this file |

**Unchanged:** `a1cf1b1`, `ef6185b`, `OPENCODE_SESSION_DISCOVERY.md`,
`SESSION_PAIR_REPLACEMENT.md`, and the three pre-existing dirty files.
