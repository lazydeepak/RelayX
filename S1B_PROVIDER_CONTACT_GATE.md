# S1B — Provider-contact gate: ESCALATION, then RESOLUTION in S6

> **SUPERSEDED IN PART — see §0. The sections below are preserved unedited as the
> record of why S1B stopped. What changed is the answer, not the evidence.**

## 0. Resolution (recorded by the S6 tranche)

The §4 decision was made: **Option 2 — build a real Load & Activate.** The grantor
now exists, so the escalation is resolved and the gate is **armed**. Concretely, S6:

- added `RelayEngine.loadAndActivate(pairId)` as the **only** `IDLE → ACTIVE` grantor
  (`DESIGN_FREEZE §4.4` minimum preconditions; `§11.2`'s checkpoint/readiness clauses
  are explicitly **deferred to S7/S8** — see `S6_LOAD_AND_ACTIVATE.md` §2);
- armed the I-2 gate at **six** provider-contact sites (§5.1 below, P1–P6), which was
  four before this tranche;
- added `RelayEngine.makePairIdle` for §4.5, idempotent and evidence-preserving;
- clarified that `startPair()` is **execution authority only** and never grants ACTIVE;
- closed the previously-open **P5** gap (§5.3) **without** editing the protected file,
  by resolving the owning Pair through the existing `IPairRepository.findAll()`.

**§5.3 is now fully closed.** `RelayEngine.unarchiveRuntimeSession` →
`reconcileAndRecoverRuntime` is gated, **and** so is
`RelayApiService.inspectRuntime`, which used to call `provider.inspectRuntime`
*directly on the service*, bypassing the engine. The latter was closed by the S6
closure tranche, which was explicitly authorised to add narrowly isolated hunks to
that file; the ownership lookup it needed is now
`IPairRepository.findByRuntimeSessionId()` and the enforcement is the single shared
`RelayEngine.assertRuntimeProviderContactPermitted()`. `recoverRuntime` was corrected at
the same time — its bare `catch {}` had been swallowing the gate refusal, making "not
permitted" indistinguishable from "provider unreachable". See
`S6_LOAD_AND_ACTIVATE.md` §7 and `tests/runtime_pair_governance.test.ts`.

Groups A, B and C of the provider-spy tests, omitted below as unwritable, are now
written as real assertions in `tests/pair_activation_authority.test.ts`. The
S1B-only reasoning in §3 and §6 that claimed they "cannot be written truthfully" is
**obsolete** and is retained only as history.

---

<details>
<summary>Original S1B note (preserved verbatim as the historical escalation)</summary>

**Status at the time of S1B: STOPPED at the activation-authority decision. No
behavioural change was made.**

`DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md` is the authoritative design. This note
records a genuine, unresolvable conflict between the frozen design and the S1B
objective, the evidence for it, and the one decision a human must make.

- **Branch / HEAD:** `main` / `a1cf1b1` (unchanged; nothing staged, nothing committed)
- **Frozen source:** `a1cf1b1`, `ef6185b`, `DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md`,
  `OPENCODE_SESSION_DISCOVERY.md`, `SESSION_PAIR_REPLACEMENT.md`
- **Nothing in `src/` was modified by S1B.** The only S1B edits are four comment
  blocks that previously understated the cost of arming the gate, plus this note and
  one new test file.

---

## 1. The S1B objective

> Close the fenced S1 enforcement gap: a persisted `IDLE` Session Pair must not
> contact either external provider. S1 introduced the model; S1B must make the frozen
> IDLE invariant behaviorally true now, not deferred.

**This is the correct objective and S1's fence was genuinely wrong to leave unarmed
without a decision.** The gap is real and it is measurable. It is not, however,
closable inside S1B's stated authority. Section 4 proves that.

## 2. The gap is real — measured, not asserted

A throwaway diagnostic (provider spies counting every `IRuntimeProvider` capability
call) against the current `a1cf1b1` + S1 working tree:

| Probe | Persisted `operationalState` | Provider calls observed |
|---|---|---|
| `dispatchAssignment(asgnId)` | `IDLE` | `['deliverInstruction']` |
| `runSupervisionTick()` | `IDLE` | `['inspectRuntime']` |
| `startPair` → `pausePair` → `resumePair` → `stopPair` | `IDLE` after all four | — |

So the S1B objective is valid: a persisted IDLE Pair **is** dispatched to a provider
and **is** inspected by supervision today. `startPair`, `pausePair`, `resumePair`
and `stopPair` leave `operationalState` at `IDLE` — by design, per §4.4.

## 3. Why S1B cannot close it

To make IDLE truthful, two things are needed together:

1. **Arm the gate** at every provider-contact site (frozen, §11.5), **and**
2. **An operation with legitimate authority to move `IDLE → ACTIVE`**, because
   arming the gate with no way to become ACTIVE freezes the product at IDLE forever.

S1B was told not to implement Load & Activate, provider observation, readiness, or
exact-session verification. Those constraints close every available route to (2).

### 3.1 `makeActive()` has zero callers — measured

`Pair.makeActive()` exists in `entities.ts:237`. Searching all of `src/` and
`electron/`:

```
$ rg -n "makeActive\(" src/ electron/
src/relay/domain/entities.ts:237:  public makeActive(reason?: string): void {
```

One hit: the definition. **No operation in the application can produce an ACTIVE
Pair.** There is no `Load & Activate` — `rg loadAndActivate src/ electron/ tests/`
returns nothing.

The complete `RelayEngine` public surface was enumerated at runtime:

```
registerProvider, getProvider, emitEvent, createProject, updateProject,
archiveProject, unarchiveProject, canDeleteProject, deleteProject,
registerRuntimeSession, discoverRuntime, assertPrePairAuthoritativeAssociation,
createPair, updatePair, rebindPairPlanner, rebindPairWorker, detachPairRuntime,
archivePair, unarchivePair, canDeletePair, deletePair, canDeleteRuntimeSession,
detachRuntime, deleteRuntimeSession, archiveRuntimeSession,
unarchiveRuntimeSession, createAssignment, dispatchAssignment, runSupervisionTick,
attemptPlannerDelivery, deliverHandoffToPlanner, completeHandoff,
completeAssignment, reconcileAndRecoverRuntime, resolveAmbiguousDelivery,
startPair, pausePair, resumePair, stopPair, startSupervisionLoop,
stopSupervisionLoop, isSupervisingLoopActive, reconcileUnresolvedDispatches,
probeDispatchOutcome, commitDispatchDisposition, recoverOnStartup, runPlanFirstTick,
dispatchPlanFirstUnit, verifyPlanFirstUnit, reconcileInterruptedPlanFirstUnit,
reconcileInFlightPlanFirstUnit, blockPlanFirstUnit, raisePlanFirstAttention
```

No activation-shaped operation exists. The only candidates are `startPair` and
`resumePair` (which delegates to `startPair`).

### 3.2 The four routes, and why each is closed

**(a) `startPair()` as a compatibility activation bridge — CLOSED by I-9, N-16, N-18.**

This is the tension named in the S1B brief. It is not resolvable in `startPair()`'s
favour, because the freeze does more than state that `startPair()` stays
`pair.resume()`. It assigns `startPair()` a *meaning*:

- **§4.4 table, `Start Pair` row:** "Changes operational state: **No**". Making
  `startPair()` flip `operationalState` makes that cell a false statement.
- **§4.4 table, `Start Pair` row:** "Requires provider contact: **No**". An operation
  whose only purpose is to grant provider-contact permission is not an operation that
  requires none.
- **§4.4 table, `Start Pair` row:** "Requires resolvable identity: **No**".
- **I-9 `[FROZEN]`:** Load & Activate and Start Pair "must not be merged, aliased, or
  made to imply one another." An activation bridge makes Start Pair *be* the only
  grantor of ACTIVE — the definition of implying one another.
- **N-18 `[FROZEN]`:** "**Merging `Load & Activate` with `Start Pair`.** Explicitly
  forbidden by I-9."
- **§4.4 `[FROZEN]`:** "`startPair()` remains `pair.resume()` in this tranche; Load &
  Activate is new work and **does not modify it**."

N-16's letter is that it stays `pair.resume()`. A bridge could technically leave the
*call* as `pair.resume()` and add a second line beside it — but that is exactly the
"quietly rewriting N-16's meaning" the brief forbade, and it is what N-18 prohibits
outright. **Not taken.**

**(b) Implement Load & Activate — CLOSED by the S1B brief and by §4.4's preconditions.**

`§4.4` preconditions for Load & Activate: "Requires provider contact: **Yes — this
is its purpose**", "Requires resolvable identity: **Yes, on both sides**",
"Preconditions: Pair exists, both sides bound, provider capabilities present."
S1B was told: "Do NOT implement Load & Activate, provider observation, readiness, or
exact-session verification here." Implementing it is forbidden; and note it could not
be implemented *truthfully* without observation, since a grantor that resolves
nothing is not Load & Activate. **Not taken.**

**(c) A new bare `makePairActive()` operation — CLOSED as building S6 work by
another name, and as not an "equivalent".**

§4.2 allows `IDLE → ACTIVE` "only via explicit `Load & Activate` (**or a future
deliberate equivalent**)". An equivalent must be equivalent in the §4.4 sense: it
resolves identity on both sides and requires provider contact. A bare flag flip has
neither precondition, so it is not an equivalent — it is *Load & Activate minus Load*,
i.e. the forbidden S6 work with the verifying half removed. Worse, it would grant
`operational_state = 'ACTIVE'` on an unverified basis, which is precisely the
permission-without-ground that §11.5 and §8 are written to prevent. **Not taken.**

**(d) Migrate existing Pairs to `ACTIVE` — CLOSED by the freeze and the brief.**

`§17.3 [FROZEN]`: "Existing Pairs must backfill to `operational_state = 'IDLE'`. This
is the **only safe default**." Also forbidden explicitly: "migration must not activate
anything" and "persisted `status='active'` must never override
`operational_state='IDLE'`". **Not taken.**

### 3.3 Arming without a grantor is worse than the fence — measured

The only remaining option was to arm the gate anyway and accept a frozen product.
This was tested rather than argued. `RelayEngine.ts` was backed up by SHA-256
(`faf7c337…db619`), the gate was armed at three sites
(`dispatchAssignment` via `assertProviderContactPermitted()`, `runSupervisionTick`
and `recoverOnStartup` via `isProviderContactPermitted()`), the full suite was run,
and the file was then restored and its SHA-256 re-verified identical.

| | S1 baseline | Gate armed, no ACTIVE path |
|---|---|---|
| Tests | 414 | 414 |
| Pass | 399 | 354 |
| **Fail** | **15** | **60** |
| Files with failures | 6 | 14 |

**45 additional green tests fail.** The collateral includes the contracts the freeze
itself relies on:

- **`core_slice1.test.ts` T1–T7** — the whole frozen dispatch boundary, including
  T3 "Provider call occurs after durable intent commit (transaction split)" and
  T6 "Crash-equivalent unresolved dispatch blocks blind resend". S1's own fence
  comment cited T6 by name as the reason not to arm early; that citation is now
  quantified.
- **`dispatch_reconciliation.test.ts` R1–R7b** — the durable dispatch-intent
  invariant, entirely.
- **`pf1_operational.test.ts` Boundaries 0–7** — the Plan-First operational
  qualification, entirely.
- **`phase3_phase4` and `phase8_phase11`** — supervision and crash-recovery, entirely.
- **`management_lifecycle.test.ts`** — history survival across rebinding.

A silent, inert RelayX is a worse defect than a documented, unarmed gate, and it
would be shipped without anyone having chosen it. **Not taken.**

## 4. Consequence: the decision a human must make

S1B cannot arm the gate without a grantor, and cannot have a grantor without S6.
Exactly one of these is needed:

**Option 1 — Authorise the compatibility bridge in `startPair()`.** Amend N-16 /
N-18 / §4.4 to state that `startPair()` additionally grants `operationalState =
'ACTIVE'` as a documented, unverified compatibility bridge, explicitly *not* a
Load & Activate, and explicitly *not* carrying identity resolution. S1B then arms the
gate immediately and the product works; the documented cost is that ACTIVE asserts
permission without verification, which §11.5 and §8 would need to tolerate as a
transitional state. The ~45 tests above keep passing because every test-created Pair
would become ACTIVE on `startPair()`. **This is the smallest change that makes IDLE
truthful today, and it is a design change, not an implementation detail.**

**Option 2 — Land S6's Load & Activate first, then S1B.** Build the real activation
operation with its §4.4 preconditions (both sides bound, capabilities present,
identity resolved on both sides, readiness derived and non-authorizing), then arm
the gate in the same tranche. Correct per the freeze, and larger than S1B.

**Option 3 — Keep the fence, and record S1's gap as a defect that blocks every
intermediate tranche.** Honest, but leaves IDLE unenforced through S2–S5, which is
what the S1B brief rejects as "silently leaving it unarmed".

**S1B's own read:** Option 1 is the only one that satisfies "make IDLE truthful now"
without expanding into S6, and it is a one-line-per-cell amendment to a frozen table
plus a documented, time-boxed bridge. But it is a change to a `[FROZEN]` design, so
it is not S1B's to make. **S1B stops here rather than choosing silently.**

## 5. Provider-contact call graph

Authority is classified by **how the path is reached**, not by `PairStatus`. Nothing
below infers authority from a runtime's last-known status or a legacy `status` value.

### 5.1 Pair-scoped contacts — the I-2 surface

| # | Site | Capability | Reached from | Class | In scope for the gate |
|---|---|---|---|---|---|
| P1 | `RelayEngine.dispatchAssignment` `:1033` | `deliverInstruction` | IPC `DISPATCH_ASSIGNMENT`; `App.tsx:326,343`; `dispatchPlanFirstUnit:2231` | **explicit human/execution initiation** | **yes** |
| P2 | `RelayEngine.runSupervisionTick` `:1168` | `inspectRuntime` | `startSupervisionLoop:1556` (every 5 s, `main.ts:236`); IPC `RUN_SUPERVISION_TICK`; `main.ts:79`; `App.tsx:311,379,406` | **background** (timer) + explicit operator tick — same code path | **yes** |
| P3 | `RelayEngine.recoverOnStartup` `:1918` | `inspectRuntime` | `main.ts:229` on `app.whenReady()` | **automatic recovery** | **yes** |
| P4 | `RelayEngine.probeDispatchOutcome` `:1714` | `reconcileDispatch` | `reconcileUnresolvedDispatches` ← `recoverOnStartup:1902`, `dispatchPlanFirstUnit:2030` | **automatic recovery** | **yes** — see 5.3 |
| P5 | `RelayEngine.reconcileAndRecoverRuntime` `:1406` | `inspectRuntime` | `unarchiveRuntimeSession:886`; IPC `RECONCILE_RUNTIME` (`RelayApiService:889`) | **explicit human** | **yes**, via a Pair-bound runtime — **GATED in S6** (see §0) |
| P6 | `RelayEngine.reconcileInFlightPlanFirstUnit` `:2510` | `detectWorkingState` | `runPlanFirstTick` | **background** | **yes** — not previously listed as a fence site |
| P7 | `RelayEngine.discoverRuntime` `:361` | `findRuntime` | IPC `DISCOVER_RUNTIME`; `RuntimeModal.tsx:68` | **explicit human** | **no** — see 5.2 |

> **Line numbers above are the pre-S6 ones and are now stale** (`RelayEngine.ts` grew
> substantially). They are kept as-is because this section is the historical record.
> The current, verified line numbers for every gate site are in `§4` of the S6
> deliverable and in the `I-2 GATE — ARMED (S6)` comments at each site in the source.

`startSupervisionLoop` is not itself a contact; it only schedules P2. Gating P2 gates
the loop completely.

### 5.2 Pair-independent contacts — structurally outside the Pair gate

`IPairRepository` (`persistence/interfaces.ts:43`) exposes only `findById`,
`findByProjectId`, `findAll`, `save`, `delete`. There is **no** lookup of a Pair by
runtime session. Consequently the following are Pair-independent and cannot be gated
by a `Pair`-scoped assertion:

| Site | Capability | Class |
|---|---|---|
| `RelayApiService.discoverRuntime:773` → `P7` | `findRuntime` | explicit human, **pre-Pair** (runs before a Pair exists) |
| `RelayApiService.discoverOpenCodeSessions:1206` | `matchSessionsByPath` | explicit human, pre-Pair |
| `RelayApiService:1369` (worker adoption) | `matchSessionsByPath` | explicit human, pre-Pair |
| `RelayApiService.createOpenCodeWorkerSession:1528` | `createWorkerSession` | explicit human, pre-Pair |
| `RelayApiService.resolveChatGPTProject:1189`, `:1588` | `resolveChatGPTProject` | explicit human, pre-Pair |
| `RelayApiService:643,675,708,743,776` | **none** — reads `provider.integrationStatus`, a local property | not a contact |

These operate on `Project` / `RuntimeSession` and are reached only by an operator
click. They are consistent with I-2, which governs what happens *while a Pair is
IDLE*; a discovery or creation flow that happens before any Pair exists has no Pair
whose state could forbid it. This is a genuine scope boundary, stated here rather
than papered over. I-3 still applies to anything they persist: last-known only.

### 5.3 One real gap that S1B cannot close here

`RelayApiService.inspectRuntime(sessionId)` (`:814-815`) and
`unarchiveRuntimeSession` (`:889` → `P5`) inspect a runtime **that may belong to an
IDLE Pair**, and neither is gated.

Gating them requires a Pair lookup by runtime session, and that does not exist.
Closing it needs either a new `IPairRepository` method, or a `findAll()` scan — and
**both require editing `src/relay/application/RelayApiService.ts`, which is one of
the three externally-owned dirty files at 107 insertions / 12 deletions.** Per the
brief, S1B stops and reports the dependency instead of mixing changes. **This is an
unclosed IDLE contact path and it should be scheduled with whichever of Option 1/2/3
is chosen.**

`P4` (`reconcileDispatch`) is a probe of RelayX's *own* unresolved dispatch intent
against the external session. It is a real provider contact and is included in the
gate.

> **S6 UPDATE — this claim was partly wrong, and the correction is the useful part.**
>
> Both operations do **not** require editing the protected file. Only
> `RelayApiService.inspectRuntime` does, because it calls `provider.inspectRuntime`
> *directly on the service* rather than through the engine. The other one,
> `unarchiveRuntimeSession`, is an **engine** method
> (`RelayEngine.unarchiveRuntimeSession`), and the engine already receives
> `IPairRepository`, whose `findAll()` is sufficient to locate the owning Pair by
> comparing `plannerSessionId` / `workerSessionId` against the runtime id (I-11: by
> identifier, never by name). S6 closed P5 with a private
> `RelayEngine.findPairOwningRuntime()` helper and **did not widen any repository
> interface and did not touch the protected file.**
>
> **What remains open is exactly one path: `RelayApiService.inspectRuntime:814`.**
> It is left fenced, and the dependency is reported honestly rather than worked
> around.

> **S6 CLOSURE UPDATE — the last path is now closed too.** The S6 closure tranche was
> explicitly authorised to add narrowly isolated hunks to `RelayApiService.ts`, which is
> what this gap actually required. It closed the path with:
>
> - `IPairRepository.findByRuntimeSessionId(runtimeSessionId): Promise<Pair[]>` — the
>   reverse lookup at the layer that owns the binding, implemented in both the SQLite
>   and the memory repository. It returns an **array** because the `pairs` table carries
>   no unique index on `planner_session_id` / `worker_session_id`, so a runtime bound to
>   two Pairs is representable rather than silently collapsed to the first match.
> - `RelayEngine.resolveRuntimePairGovernance()` and
>   `RelayEngine.assertRuntimeProviderContactPermitted()` — one resolution and one
>   enforcement point, now shared by both runtime-addressed sites, returning
>   `unpaired` / `paired` / `ambiguous` and denying on `IDLE` **and** on ambiguity.
> - `RelayApiService.inspectRuntime` calls that guard before touching a provider and
>   returns the refusal as `{ success: false, error }`.
> - `RelayApiService.recoverRuntime` no longer swallows the refusal in a bare `catch {}`.
>
> Proof: `tests/runtime_pair_governance.test.ts` — 18 tests, all asserting provider
> **call counts**, including the migrated-pair and close/reopen cases.

## 6. What S1B changed

- `src/relay/application/RelayEngine.ts` — **comments only**, in the four existing
  I-2 fence blocks. Each previously said arming the gate "would leave every Pair IDLE
  forever" and cited T6; that is now quantified (45 tests, 14 files) and points here.
  **No behavioural change. The four call sites remain unarmed and the file's SHA-256
  is unchanged from its S1 state.**
- `S1B_PROVIDER_CONTACT_GATE.md` — this note.
- `tests/pair_activation_authority.test.ts` — the two §6 behavioural groups that are
  implementable without the blocked decision (D and E). Groups A, B and C are
  **omitted, not weakened**, and the file says so at the top.

## 7. Required next step

Answer **Option 1, Option 2, or Option 3** in §4. S1B then resumes immediately; the
arming sites and the provider-spy tests are already identified, and the enforcement
itself is three guard lines plus one grantor.

> **S6 UPDATE — answered: Option 2.** The grantor is `RelayEngine.loadAndActivate`.
> The gate is armed at six sites. See §0 and `S6_LOAD_AND_ACTIVATE.md`.
> The still-open item is the single fenced path `RelayApiService.inspectRuntime:814`
> (§5.3), which needs a Pair lookup inside the protected file and is deferred to
> whichever tranche owns that file.

> **S6 CLOSURE UPDATE — nothing is deferred any more.** The gate is armed at **eight**
> sites (six in the engine, one on the service, plus the non-contact `startPair`
> refusal), the last fenced path is closed, and there is no open IDLE contact path.
> See `S6_LOAD_AND_ACTIVATE.md` §7 for the enumerated inventory and
> `tests/runtime_pair_governance.test.ts` for the call-count proofs.

Nothing in `tests/pair_operational_state.test.ts`,
`tests/external_effect_evidence.test.ts` or `tests/pair_replacement_fence.test.ts` was
touched. S1 evidence integrity is intact: `markDeliveredToPlanner` still requires
evidence, `planner.delivery.unverified` still replaces `planner.notified`, the
Worker-produced `evidence` field is still separate from
`Handoff.plannerDeliveryEvidence`, and the C-1 fence is unchanged.

</details>
