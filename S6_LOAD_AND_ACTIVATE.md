# S6 — Load & Activate, and the armed I-2 provider-contact gate

**Status: implemented. This is the tranche that makes `IDLE` behaviorally truthful.**

`DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md` is authoritative. Where this note reads
the freeze, it names the clause it is reading and says so out loud. Two readings in
particular are load-bearing and are stated explicitly in §2 and §3 below.

- **Branch / HEAD:** `main` / `a1cf1b1` (nothing staged, nothing committed, nothing pushed)
- **Frozen source:** `a1cf1b1`, `ef6185b`, `OPENCODE_SESSION_DISCOVERY.md`,
  `SESSION_PAIR_REPLACEMENT.md`
- **Builds on:** `S1_PAIR_SEMANTICS_IMPLEMENTATION.md` (the model),
  `S1B_PROVIDER_CONTACT_GATE.md` (the escalation this tranche answers — §4 decision:
  Option 2, build a real grantor)

---

## 1. What changed, in one dependency chain

```
S4  provider read capability        resolveSideIdentity?(SideIdentityRequest)   -> interfaces.ts:134
        ↓
S5  per-side identity resolution    PairSideIdentity, tri-state vocabulary    -> types.ts
S6  Load & Activate                 RelayEngine.loadAndActivate                -> RelayEngine.ts:1848
        ↓
    persist ACTIVE                  Pair.makeActive() is the only writer       -> entities.ts:237
        ↓
    provider gate ARMED             6 sites                                    -> RelayEngine.ts (below)
        ↓
    Start Pair permitted            execution authority ONLY, never grants ACTIVE
```

**The required negative path is now real:**

```
IDLE → Start Pair → BLOCKED
   RelayDomainError 'PAIR_OPERATIONAL_STATE_IDLE'
   "…Start Pair is execution authority only and does not activate.
    Run Load & Activate on Pair <id> first…"
   operationalState is NOT modified.
```

`startPair` did not previously transition `IDLE → ACTIVE`, so this is not a bug fix
— it is the removal of a **silence**. Before, pressing Start on an IDLE Pair recorded
a lifecycle status implying work was underway while the engine refused every provider
contact behind it. The refusal is the truthful response, and it names the operation
that would succeed.

## 2. The §4.4-vs-§11.2 reading — stated explicitly

**The freeze describes Load & Activate twice, and this tranche implements §4.4 only.**

| | §4.4 (implemented) | §11.2 (deferred) |
|---|---|---|
| Preconditions | both sides bound; provider capabilities present; identity resolvable/verified to the level currently supported | §4.4 **plus** checkpoint comparison and readiness derivation |
| Status | **built** | **NOT built** |

**Deferred, deliberately, and not partially:**

- **Checkpoint comparison** — the §11.2 clause. Checkpoint persistence is S3/S7. This
  tranche adds **no** checkpoint column, no checkpoint read, no comparison.
- **Readiness derivation and persisted readiness** — S8. This tranche adds **no**
  readiness field, no derivation, and no readiness column. `I-5` (readiness is always
  derived, never persisted as authority) is honoured by *absence*, which is the
  strongest form: there is nothing to persist.
- **Observation / cursor persistence** — S3. Not present.

If a later tranche finds §4.4 insufficient to make the gate armable, that is a finding
to report, not a licence to widen §4.4. **§4.4 was sufficient**, and the evidence is
in `tests/pair_activation_authority.test.ts` groups A–C.

**A note on why §4.4 could be sufficient even though ChatGPT cannot be verified:**
§4.4 says identity must be resolvable *"to the level currently supported"*. Read
literally with §9.5 and §11.3, a LEVEL 0 provider's side is `unknown` — and `unknown`
is not a terminal failure. See §3.

## 3. "Provider capabilities present" — the second load-bearing reading

§4.4 requires "provider capabilities present for both sides". Two readings are
possible, and they differ in whether a ChatGPT planner side blocks activation:

| Reading | Meaning | Result for a ChatGPT planner side |
|---|---|---|
| **A: a provider exposing the capability** | a registered provider that implements `resolveSideIdentity` | every ChatGPT Pair is permanently unactivatable — the product cannot function |
| **B: a provider registered for the side** *(adopted)* | the engine holds a usable provider for that side | ChatGPT side is `unknown`, activation proceeds, asymmetry is reported |

**Reading B is adopted.** It is the reading that satisfies §4.4, §9.5 and §11.3
together:

- `§9.5` classifies ChatGPT as **LEVEL 0** and assigns it `unknown` — not a failure.
- `§11.3` requires per-side honesty: an unverifiable side is reported `unknown`, never
  `false`, never omitted.
- `§4.4`'s own wording is "present", not "sufficient to verify".

Reading A would make LEVEL 0 a permanent dead end and would force a choice between
"the planner side is always `unknown`" and "ChatGPT Pairs can never go ACTIVE" —
Reading B is the only one that keeps both honest.

**What reading B does *not* permit.** Two things still reject:

- **no provider registered at all** for a bound side → configuration failure → reject.
- **a registered provider whose read returns checked-and-negative**
  (`mismatched` / `absent`) → terminal → reject, stay IDLE (`§11.2`).

## 4. Preconditions, and the terminal-failure line

Evaluated **in this order**. Side evidence is persisted *before* the decision, so a
rejected activation still leaves durable last-known evidence (`I-3`).

| # | Precondition | On failure |
|---|---|---|
| 0 | pair exists | throws `PAIR_NOT_FOUND` |
| 0b | not already `ACTIVE` (`§11.4`) | `rejected` — re-running is an explicit retry, not an implicit side effect |
| 1 | **both sides bound** — `plannerSessionId` and `workerSessionId` both set | `rejected` |
| 2 | **provider registered** for each bound side (`§4.4`) | `rejected` |
| 3 | **no checked-and-negative identity** on either side | `rejected` |
| — | persist side evidence | always, before the decision |
| 4 | `pair.makeActive()` + save | `activated` |

### The line that matters: `could-not-check` ≠ `checked-and-negative`

| Side result | Meaning | Terminal? |
|---|---|---|
| `verified` | exact external id confirmed present | no |
| `unknown` | **could not check** — no capability, or the read threw / failed to parse | **no** — activation proceeds and the side is reported `unknown` |
| `mismatched` / `absent` | **checked, and the answer is no** | **yes** — reject, stay IDLE |

A transport failure, a missing binary, or an unparseable response is `unknown`. It is
**never** downgraded to `false` (`I-6`), and a `false` here would be a fabricated
observation. Conversely, a successful read that does not contain the id is a real
negative answer and **must** block — treating it as `unknown` would let a Pair activate
on the strength of a provider that just told us the session is gone.

## 5. Per-side honesty (`I-6`, `I-11`, `§11.3`, `§5.2`, `§5.3`)

- Each side is resolved **independently**, sequentially, addressed by
  `runtime.externalSessionId` only. A failure on one side never contaminates the other
  (test `F4`).
- **Never by name.** A shared name is evidence, never identity (`I-11`). A runtime with
  no external id yields `unknown` with an explicit *"a name is not a substitute"* reason.
- **Never a third operational state.** `IDLE | ACTIVE` only (`I-1`).
- No single pair-level "verified" flag. `PairActivationResult.fullyVerified` exists
  **precisely so it can be `false`** on a Pair whose worker verified and whose planner
  did not (`F1`).
- `pair_side_identity` persists the capability (`sourceCapability`, never empty) and
  `observedAt` on every row, verified or not (`§5.2` dimensions 8 and 9).

### The two provider levels, as implemented

| Provider | `resolveSideIdentity` | planner/worker side reports |
|---|---|---|
| `OpenCodeProvider` | **yes** — new private read helper, CLI `GET /api/session?directory=…&limit=50` | `resolved` / `verified` / `present` |
| `ChatGPTProvider` | **no — deliberately** | `not_verifiable`, `unknown`, with a reason |

`ChatGPTProvider` not implementing the capability is the mechanism, not an oversight:
it makes "the planner side is permanently `unknown`" a property of the system rather
than a convention.

**`ef6185b` is untouched.** `OpenCodeProvider.resolveSideIdentity` uses a **separate
new private read helper** rather than refactoring `confirmSessionForProject`, so every
member of the protected discovery/creation set is byte-identical.

**Schema:** `user_version` 4 → **5**, new table `pair_side_identity`, additive and
gated on `PRAGMA user_version`, created in both the unconditional audit and
`migrateSideIdentitySchema()`. PK `side_identity::${pairId}::${sideRole}`, plus
`UNIQUE (session_pair_id, side_role)`. **No readiness, checkpoint or cursor column.**

**No backfill.** After `I-2` no pre-existing IDLE Pair could have produced a row, so
synthesising `unknown` rows would fabricate observations — a persisted record
asserting an external fact that was never established (`I-6`, and the `§7.3` rule
that an outcome is never upgraded past what the provider proved). **An absent row
means "never activated"**, which is the truth.

## 6. Make Idle (`§4.5`, `I-10`)

`RelayEngine.makePairIdle(pairId, reason?)` — idempotent, pure local state change,
**zero provider contact** (`§11.2`). Preserves bindings, `activeAssignmentId`,
lifecycle status, history, provenance, and last-known per-side evidence. Emits
`pair.idled` with a truthful `previousState`.

It does **not** delete the `pair_side_identity` rows, because those are the last-known
evidence `I-3` requires an IDLE Pair to be able to render.

## 7. The armed gate — 8 provider-contact sites

Sites 1–6 are in `src/relay/application/RelayEngine.ts`; site 8 is in
`src/relay/application/RelayApiService.ts`. Line numbers verified by the Step 6
re-audit that closed this section.

| # | Site | Gate line | Contact line | Capability | How the Pair is reached |
|---|---|---|---|---|---|
| 1 | `dispatchAssignment` | `1024` | `1095` | `deliverInstruction` | `assignment.pairId` — thrown at the **top of the Phase-1 transaction, before any durable intent** |
| 2 | `runSupervisionTick` | `1216` | `1225` | `inspectRuntime` | directly — `continue`s before `getProvider` |
| 3 | `recoverOnStartup` | `2604` | `2611` | `inspectRuntime` | directly — `continue`s before `getProvider` |
| 4 | `probeDispatchOutcome` | `2373` | `2402` | `reconcileDispatch` | via the Attempt's **frozen** `sessionPairId` |
| 5 | `reconcileInFlightPlanFirstUnit` | `3203` | `3207` | `detectWorkingState` | via `run.sessionPairId` |
| 6 | `reconcileAndRecoverRuntime` | `1583` | `1586` | `inspectRuntime` | the **shared** `assertRuntimeProviderContactPermitted()` guard |
| 7 | *(not a gate)* `startPair` | `2149` | — | — | execution-authority refusal, §1. Deliberately not counted: not provider contact |
| 8 | `RelayApiService.inspectRuntime` | `826` | `839` | `inspectRuntime` | the **same** shared guard, via `this.engine` |

`startSupervisionLoop` is gated transitively through site 2 and needs no second check.

### The one shared guard (sites 6 and 8)

Both runtime-addressed sites call one method,
`RelayEngine.assertRuntimeProviderContactPermitted(runtimeSessionId)`, which delegates
to `resolveRuntimePairGovernance()`. One resolution, three outcomes:

| Governance | Meaning | Provider contact |
|---|---|---|
| `unpaired` | no Pair binds this runtime — the **absence** of a governance subject, not a grant | permitted (Case C) |
| `paired` + `ACTIVE` | exactly one owner, operationally ACTIVE | permitted |
| `paired` + `IDLE` | exactly one owner, IDLE | **denied**, `PAIR_OPERATIONAL_STATE_IDLE` |
| `ambiguous` | more than one owner — representable because `pairs` has no unique index on the binding columns | **denied**, `PAIR_OWNERSHIP_AMBIGUOUS` |

`IPairRepository.findByRuntimeSessionId()` is the reverse lookup, added at the layer
that owns the binding. It is the **only** such call in the engine — asserted by test
**I2**, so a second resolution path cannot appear unnoticed.

### Why the unpaired case is permitted, and why that is not a loophole

`unpaired` means there is no Pair whose IDLE state could be violated, and standalone
runtime management (discover, inspect, archive, unarchive, adopt before pairing) is an
established product capability. Gating it would make unrelated runtimes unusable purely
to enforce Pair state. It is recorded as an explicit, tested boundary (group **D**),
not as an oversight — and it is *not* permission: it is the absence of a subject.

**Sites 4 and 5 were missed by S1** — reconciliation paths, no `Pair` in scope.

**Sites 6 and 8 were missed by S1B/S6** for the same reason: addressed by
`RuntimeSessionId`, not `PairId`. Site 8 was missed *twice over* because it called the
provider **directly on the service**, bypassing the engine entirely, so an audit that
reasoned about engine methods could not see it.

### The path that is now closed

`RelayApiService.inspectRuntime` (previously `:814`, now `:839`) no longer bypasses the
engine. It calls the shared guard first and returns the refusal as
`{ success: false, error }` rather than throwing, matching the method's existing
return-shape convention. `recoverRuntime` was also corrected: its bare
`catch { return { success: false, restored: false } }` **swallowed** the gate refusal,
making "not permitted" indistinguishable from "provider unreachable". It now reports
the governance reason, and the `error?: string` field was added to the typed IPC
contract in `src/types/relayApi.ts` so a renderer can actually read it.

## 8. Preserved invariants — checked, not assumed

| Invariant | Where it is enforced |
|---|---|
| `I-1` exactly two values, one-way | `operationalState` type; `makeActive` is the only writer |
| `I-2` `IDLE` ⇒ zero provider contact | 8 gate sites (6 in the engine, 1 on the service, 1 non-contact refusal); groups **A**–**H** assert **call counts** |
| `I-3` persisted info while IDLE is last-known only | `pair_side_identity` preserved by Make Idle |
| `I-4` `ACTIVE` permits, does not imply | group **E** |
| `I-5` no persisted readiness | group **E** asserts no readiness column exists |
| `I-6` `unknown` ≠ `false` | groups **F1/F2/F4** |
| `I-7` no cross-provider timestamp ordering | per-side `observedAt`, never compared across providers |
| `I-10` Make Idle preserves everything | group **E** |
| `I-11` name is never identity | group **F3** |
| no fabricated observations | no backfill (§5) — `I-6`, `§7.3` |
| `N-16`/`N-18`/`I-9` Start Pair never activates | group **C6** |
| `C-1` replacement not implemented | `tests/pair_replacement_fence.test.ts`, 18/18 |

S1 evidence integrity is intact: `markDeliveredToPlanner(evidence)` still throws
without evidence, `planner.delivery.unverified` is intact, no `planner.notified` exists
in `src/` outside comments, the Worker `evidence` / `plannerDeliveryEvidence` split is
unchanged, and the corrected handoff audit transitions are unchanged.
