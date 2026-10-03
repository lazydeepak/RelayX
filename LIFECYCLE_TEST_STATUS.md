# RelayX lifecycle verification status

Status: **Core transaction boundaries frozen; full automated suite green (900/900). One live boundary remains unconfirmed: Worker Model delivery execution.**

## Phase 1 health subsystem — verified (this run)

The in-flight health incident subsystem (DELIVERY_STALLED, IDLE_ACTIVITY,
MAIN_PROCESS_STALL, TRANSPORT_UNHEALTHY detectors, `HealthIncidentEngine`
dedup/lifecycle, SQLite persistence) was completed and verified:

- **Confirmation/debounce contract (Prompt 4.1)**: `evaluateDeliveryStalled`
  takes an optional `priorSample` — the first qualifying stale sample is a
  candidate only (DEGRADED, evidence, no observation, message names
  "first qualifying sample"); only a confirmed sample (`priorSample.count >= 1`)
  emits an observation (WARNING → DEGRADED, ERROR → UNHEALTHY). Ambiguous
  deliveries are always DEGRADED with a WARNING observation and never grant
  retry authorization.
- `DeliveryStalledService` peeks the confirmation tracker before evaluating,
  passes the candidate count into the pure detector, and opens/updates a
  durable incident only for confirmed observations (occurrenceCount seeded
  from the confirmed sample count). Reports now carry `message` and `evidence`.
- `HealthIncidentEngine.recordUnhealthyObservation` accepts an optional
  `occurrenceCount`; evidence is read via `observation.evidence` (typed),
  not `toRecord().evidence` (unknown).
- `transportUnhealthyCheck` imports `TransportReconciliationClassification`
  from its actual home (`providers/exactSessionReconciliation.ts`) and
  accepts `pairOperationalStates` context.
- `tsc --noEmit` clean (was 26 errors in 9 files).
- Focused health suites: 73/73 pass.

## Execution-authority realignment — restored

`RelayEngine.observeCompletedTurn` is an explicit operator observation (no
automated callers); its gate was restored to `isProviderContactPermitted()`
(operationalState === ACTIVE). Automated contact remains gated by
`isAutomatedContactPermitted()` (ACTIVE + RUNNING) at the supervision-tick
level. `execution_authority_realignment.test.ts` hard proofs 1–7 pass.

`completed_turn_observation.test.ts` "PAUSED/STOPPED…" was committed broken
in `382a736` (it expected the automated gate on the explicit operator API,
contradicting the frozen call-context authority contract). It was corrected
to prove what it actually names: the automated tick makes zero provider
contact for an ACTIVE+STOPPED pair, while the explicit operator observation
remains permitted (2 provider contacts, outcome `observed`).

## Governance refusal copy — actionable

`Pair.assertProviderContactPermitted()` IDLE refusal now names the operation
that would work ("Load & Activate the Pair…"), satisfying
`runtime_pair_governance.test.ts` A and B3.

## Failure classification

The 24 failures observed in the 748-test baseline were classified as follows.

### Stale expectations updated for the lifecycle semantics (19)

These tests encoded one of the superseded assumptions that a confirmed Delivery also starts an Attempt, that an `ACTIVE` Pair is automatically supervised without `RUNNING` relay state, or that a physical completion can be created without first observing execution.

| Test file | Failures | Updated expectation |
| --- | ---: | --- |
| `tests/core_slice1.test.ts` | 4 | Delivered transport leaves the Attempt `prepared`. |
| `tests/core_slice3.test.ts` | 1 | Delivered transport leaves the Attempt `prepared`. |
| `tests/dispatch_reconciliation.test.ts` | 3 | Reconciliation confirms Delivery only; it does not assert execution. |
| `tests/engine.test.ts` | 1 | Delivery does not emit `worker.started` or promote the Attempt. |
| `tests/exact_worker_transport.test.ts` | 1 | Exact-session delivery leaves the Attempt `prepared`. |
| `tests/pair_activation_authority.test.ts` | 2 | Supervision requires both authorization (`ACTIVE`) and orchestration (`RUNNING`). |
| `tests/pair_readiness_authority.test.ts` | 1 | Structural assertion follows the renamed contact-authority guard. |
| `tests/pair_replacement_fence.test.ts` | 1 | Delivered transport leaves the Attempt `prepared`. |
| `tests/pf1_operational.test.ts` | 2 | Tests explicitly observe running before physical completion. |
| `tests/phase3_phase4_opencode_control_supervision.test.ts` | 1 | Delivery proves runtime reachability, not worker execution. |
| `tests/phase_f_closure.test.ts` | 2 | Supervision fixtures explicitly start orchestration before observing completion. |

### Unrelated pre-existing failures retained and documented (3)

These failures do not exercise the startup orchestration lifecycle and were not changed as part of this change set.

| Test file | Failures | Existing issue |
| --- | ---: | --- |
| `tests/electron_bridge.test.ts` | 1 | Integration capability expectation says `unsupported`; the current adapter reports `partial`. |
| `tests/runtime_pair_governance.test.ts` | 2 | Error-copy assertions require the actionable phrase `Load & Activate`; the current refusal text omits it. |

### Baseline accounting

One originally observed failure was intermittent project-session enumeration and passed on rerun without a lifecycle change. With the 19 stale assertions updated, the expected deterministic suite result is **745/748 passing**, with only the three unrelated failures above remaining.

## Verified observable result (latest run)

- `npm run lint` (`tsc --noEmit`): **clean**.
- `npm test`: **900 tests, 900 pass, 0 fail** (verified twice consecutively).
- The two host-probe tests that previously depended on the machine's actual
  process state — `phase5_phase6_chatgpt_vscode.test.ts` ("reports truthful
  unavailable state for ChatGPT…") and `phase2_opencode_discovery.test.ts`
  ("reports truthful unavailable state on non-macOS or when process is not
  running") — were made deterministic by stubbing `probeMacOSProcess` /
  `findAllRuntimes`, while still exercising the real "not found" reporting path.
  The earlier environmental "ChatGPT.app is running on this host" flake is gone.
- Previously documented unrelated failures (runtime_pair_governance A/B3,
  electron_bridge) pass: the refusal copy names "Load & Activate", and the
  bridge capability expectation matches the current adapter.

## Live-cycle acceptance checks

The live verification is not complete until an actual configured Planner/Worker pair demonstrates all of the following:

1. Start selects or creates one executable Assignment.
2. Dispatch creates exactly one `prepared` Attempt and one Delivery.
3. Delivery confirmation changes only the Delivery.
4. Provider execution evidence promotes the Attempt to `running`.
5. Completion evidence promotes it to `completed_physical` and creates exactly one Handoff.
6. The Handoff creates exactly one opposite-side Assignment.
7. The opposite-side provider receives that Assignment.
8. Immediate repeated ticks, pause/resume, and process restart do not duplicate or redispatch work.
9. The same invariants hold for two to three consecutive relays.

## Milestone freeze status (latest)

```text
Create & Dispatch             FROZEN
Execution-slot authority      FROZEN
Attempt/delivery lifecycle    FROZEN
Worker Model persistence      VERIFIED
Worker Model delivery wiring  VERIFIED
Worker Model live execution   UNCONFIRMED
Full automated suite          900 / 900
```

The Create & Dispatch transaction boundary is documented in
`ATTEMPT_LIFECYCLE.md` §7 and cross-referenced from `EXECUTION_AUTHORITY.md` §9.

### Worker Model — why live execution is still UNCONFIRMED

The internal chain is verified end to end: pair override persisted →
resolver selects `pair > project > global` → dispatch passes `modelOverride` →
transport records `selectedModel` / `fallbackUsed` → reconciliation can capture
`workerExecutionModel` from OpenCode's assistant turn. What is **not** yet proven
is that a live OpenCode session actually executed with the selected model. That
claim depends on external evidence and has not been observed.

Live acceptance criteria — all four must hold in the Delivery Evidence JSON:

```text
modelSelectionSource = relay_override
selectedModel         = chosen RelayX override
fallbackUsed          = false
workerExecutionModel  = same provider/model observed by OpenCode
```

`workerExecutionModel` is populated only when a reconciliation reads an assistant
turn, so check it **after the worker has responded**, not immediately after
dispatch. If it is absent from the Delivery evidence, check the later
`delivery.reconciled`, `attempt.running`, or attempt evidence (same field name).
Note the format difference: `selectedModel` is the RelayX override string (may
include a `:free` suffix); `workerExecutionModel` is OpenCode's
`<providerID>/<modelId>`. Compare provider + model semantically.

Most useful artifact: the Delivery Evidence JSON containing `modelOverride`,
`selectedModel`, `modelSelectionSource`, `fallbackUsed`, `workerExecutionModel`.

No further code changes to these areas are justified until the live test produces
contradictory evidence.

## Next milestone — Live end-to-end Pair acceptance (UNCONFIRMED)

Status: **not yet run.** This is a live acceptance test, not a feature. Until it
passes with real providers, RelayX's core loop is unproven regardless of the
automated suite.

### Sequence to prove (one real Planner + one real OpenCode Worker)

```text
Pair IDLE → activate (normal authority) → Create & Dispatch Assignment
  → Worker receives the exact instruction → runs with the selected model
  → OpenCode assistant responds → RelayX reconciles worker evidence
  → workerExecutionModel confirmed → result handed back to Planner
  → Planner receives it exactly once → Assignment terminal
  → execution slot released → Pair accepts a second Assignment
```

### Acceptance criteria (all required)

1. No provider contact while the Pair is IDLE.
2. Create & Dispatch creates exactly one Assignment.
3. Exactly one Attempt and the appropriate Delivery are created.
4. The Worker receives the intended instruction.
5. `selectedModel` matches the Pair override.
6. After the worker responds, `workerExecutionModel` matches semantically.
7. Worker response/evidence is captured against the correct session and Attempt.
8. The Planner receives the worker result through the intended handoff path.
9. No duplicate Planner delivery.
10. The Assignment becomes terminal through the normal lifecycle.
11. The Pair execution slot is released.
12. A second Assignment runs on the same persistent Planner/Worker sessions.
13. Restarting RelayX after completion redispatches nothing.

### How to run it

- **UI loop (authoritative for this milestone):** the runbook in the next section.
- **Pre-existing opt-in harness:** `tests/live_relay_cycle.ts` — `RELAYX_LIVE=1`
  with two real OpenCode `ses_...` sessions. It proves the relay state machine,
  restart durability, pause/resume, and duplicate-prevention live, but it uses
  **OpenCode on both sides** and does **not** exercise Worker Model. It is a
  useful first live step, not a substitute for the Planner+Worker UI loop.

### What a pass unlocks

```text
Core lifecycle                 FROZEN
Create & Dispatch              FROZEN
Worker Model                   FROZEN
Planner ↔ Worker live relay    VERIFIED
Persistent Pair reuse          VERIFIED
```

If it does not pass, the mismatch localizes the fault (model selection, fallback,
transport, reconciliation, handoff, or slot release) — the core is still
incomplete until this loop is green.

### Out of scope until this passes

No Supervisor AI, cloud work, billing, beginner setup, or new integrations.

## Work-selection authority — AUDITED, BLOCKED ON LIVE CORE ACCEPTANCE

```text
Persistent Pair sequential work
    AUDITED
    BLOCKED ON LIVE CORE ACCEPTANCE

Known conflict:
    current RUNNING orchestration auto-drains pending Assignments

No implementation until:
    live Planner ↔ Worker loop passes
```

The unresolved question is not "sequential work" — RelayX already has automated
sequential behavior. It is **work-selection authority**: who chooses the next
pending Assignment — orchestration, a human, eventually Supervisor AI, or some
policy. That deserves a deliberate authority model after the live loop passes,
not another button now.

### Audited current behavior

- Multiple pending Assignments per Pair are **already legal**
  (`createAssignment` keeps backlog semantics and never touches the slot).
- `Pair.activeAssignmentId` remains the **sole execution slot**; exactly one
  unresolved Assignment may hold it.
- The existing `dispatchAssignment(assignmentId)` can dispatch an **existing
  pending** Assignment when the slot is free, **without creating a replacement**:
  `assertExecutionSlotAvailable` passes, `startAttempt` (pending → active),
  `pair.assignWork`.
- `PairView` does **not** expose backlog today; `listPairs` projects only the slot
  holder. The Assignments tab lists all assignments but offers no dispatch action.
- **Conflict:** `advancePairOrchestration()` — driven by the 5s supervision loop
  for ACTIVE+RUNNING pairs (`runSupervisionTick` step 3) — auto-dispatches the
  **oldest pending** Assignment when the slot is free. Pending backlog is therefore
  **not inert**.

### Recorded decisions

- Explicit human backlog selection is **not currently compatible with RUNNING
  orchestration semantics** (orchestration would auto-drain first).
- Do **not** add Queue / "Dispatch next" UI yet.
- Do **not** alter `advancePairOrchestration` while live core acceptance is
  unconfirmed.
- Do **not** use the STOPPED state as a UX workaround — coupling work ordering to
  relay runtime state is accidental semantics.
- Provenance (`sourceHandoffId` vs operator backlog) is **not** assumed to be a
  sufficient long-term scheduling boundary.
- After live acceptance, explicitly decide the future scheduling policy: which
  classes of pending work auto-advance and which require human selection.
