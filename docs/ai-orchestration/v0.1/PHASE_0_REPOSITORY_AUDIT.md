# Phase 0 — repository implementation map

Date: 2026-10-09. Inspected baseline: `main` / `241a4d5`.
Environment: Linux cloud workspace, Node 24.19.0, npm 11.9.0.
Status: repository audit and local baseline; native-provider acceptance remains unverified.

## Direction and document precedence

The October 8 parent architecture and RX-01–RX-09 describe the proposed API-native architecture. Root-level resume/checkpoint documents describe the earlier ChatGPT browser workflow. They must not be used as the current implementation pointer for the new architecture.

`RELAYX_FORWARD_IMPLEMENTATION_PLAN.md` has historical hashes, contradictory Phase F evidence, and a Phase I pointer predating subsequent UI commits. Its claimed completion statuses do not prove native transport. Existing authority freezes remain relevant to preserving legacy records; any proposed change to their semantics needs an explicit migration/design decision.

Documentation manifest verification: 55 entries match; README differs; no listed files are missing. The manifest needs regeneration when the pack is intentionally revised.

## Current implementation versus target

| Concern | Repository evidence | Remaining work |
|---|---|---|
| Desktop composition | `electron/main.ts:initializeEngine` constructs SQLite, Engine, browser Planner observer, ChatGPT/OpenCode/VSCode providers and IPC | Register a distinct native transport without silently switching legacy pairs |
| Planner | `providers/plannerObserverClient.ts` reads a Chrome-extension bridge; `adapters.ts` implements ChatGPT UI delivery | RelayX-owned persisted inference conversations, provider-neutral inference and structured decisions |
| Worker server | `providers/opencodeFixedServer.ts` manages a fixed localhost server for monitoring/extraction; `opencodeSessionClient.ts` reads desktop-owned service metadata | Verify installed version, ownership/authentication, live `/doc`, native send and event contracts |
| Worker dispatch | `OpenCodeProvider.deliverInstruction` in `adapters.ts` calls CLI `run --session --continue` and reconciles exact messages | Separate API-native send path; no GUI/CLI fallback in that path |
| Identity and evidence | Attempts freeze pair/runtime/external-session IDs; deliveries have unique idempotency keys; side identity/checkpoint records are separate | Preserve these guarantees across native sessions and reconnects |
| Scheduling | `planFirst.ts`, `plan_first_runs`, `work_units`, assignments and verification results already exist | Map milestone/task DAG, acceptance and priority ownership onto these records before adding tables |
| Lifecycle | `types.ts` separates `IDLE/ACTIVE` provider permission from `STOPPED/RUNNING/PAUSED` relay control | Preserve both dimensions; do not replace operational state with relay lifecycle labels |
| Recovery | `recoveryAuthority.ts` and Engine recovery guards implement Planner-first authority | Verify every native incident and question route against the same authority |
| Worker questions | Fixed-server `readPendingTool` reports running question tools without answering | Durable question/run/attempt correlation and exact question-response round trip |
| Model selection | Engine provider settings support global/project/pair overrides; free-looking model names are filtered by regex; adapter has hardcoded model fallback candidates | Exact account/endpoint eligibility, expiry, quota and qualification evidence; names are not proof of free billing |
| Governance | Engine has provider-contact, session, recovery and repository guards | Versioned general policy/approval decisions and runtime enforcement for native execution |
| UI | PairView, PlannerFirstRecoveryPanel, WorkerModelControl, HealthPanel and IPC controls exist | Native conversation history, task DAG, eligibility provenance and model ranking |

The architecture calls an older CLI transport disabled, but the inspected production adapter contains an active CLI execution path. Treat this as a documentation/implementation discrepancy; do not enable, disable or repurpose it implicitly during native integration.

## Actual SQLite map

Fresh `SqliteRelayDatabase(':memory:')` initializes successfully with `PRAGMA user_version = 6` and `foreign_keys = 1`. This is fresh-schema evidence, not an existing-user upgrade proof.

The 25 observed tables are:

- Core: `projects`, `runtime_sessions`, `pairs`, `assignments`, `attempts`, `deliveries`, `handoffs`.
- Identity/continuity: `pair_side_identity`, `pair_side_checkpoints`, `pair_checkpoints`, `runtime_project_associations`, `relay_ingress`.
- Planning/review: `contract_revisions`, `plan_first_runs`, `work_units`, `verification_results`, `repo_observations`, `planner_assistances`, `planner_action_requests`.
- Observability/configuration: `events`, `activity_records`, `attention_items`, `health_observations`, `health_incidents`, `provider_settings`.

`SqliteDatabase.ts` performs additive column migrations and version-gated migrations. `addColumnIfNeeded` catches errors without surfacing them; verification-result index creation falls back to a non-unique index on conflicting legacy data. Migration acceptance must inspect constraints after representative upgrades, not merely observe successful startup.

Current assignment statuses are `pending`, `active`, `waiting_for_handoff`, `completed`, `failed`, `cancelled`; priorities are `low`, `normal`, `high`, `urgent`. Proposed Task states and P0–P3 priorities are separate concepts and cannot be substituted without mapping.

## Local verification

- `npm ci`: FAIL; package manifest and npm lockfile are out of sync, including missing recharts, expect and js-sha256 dependencies.
- `npm install --package-lock=false`: PASS; installed 570 packages without changing tracked dependency files. This resolves current semver ranges and is not a reproducible locked install.
- `npm run lint`: PASS.
- `npm run build`: PASS, including renderer and Electron bundles.
- `npm test`: FAIL; 1,518 tests / 330 suites, 1,473 passed, 44 failed, one skipped, 54.96 seconds. See [baseline failure inventory](PHASE_0_BASELINE_FAILURES.md). Failures include bootstrap, recovery/retry, UI source assertions, and legacy Pair identity backfill. They have not all been diagnosed; do not classify them all as Linux-only failures.
- Fresh database initialization/introspection: PASS, 25 tables, version 6, foreign keys enabled.

Raw command logs are in `/workspace/scratch/relayx-baseline-{test,lint,build}.log` and `relayx-npm-{ci,install}.log`. They are local diagnostic artifacts, not durable acceptance records.

The package test script selects `tests/**/*.test.ts`; `.test.tsx` tests are not selected by that command. UI coverage must account for that explicitly. No tests were edited or removed.

## Native acceptance limitations

No `opencode` executable is installed in this environment. No live OpenCode `/doc`, authenticated server, account entitlement, native question response or actual inference call was exercised. macOS AppleScript/UI automation cannot be validated here. Neither local unit tests nor a successful build establishes a production native relay loop or zero paid inference.

## Bounded next work

1. Restore reproducible installation by synchronizing the npm lockfile; retain the baseline failures and diagnose them without weakening tests.
2. Inspect the target OpenCode installation/version and authenticated `/doc`; capture supported health, session, message, event and question contracts before implementing the native adapter.
3. Implement the Phase 1 Hunter slice: provenance-backed catalog records and a deterministic eligibility gate that rejects unknown/stale/paid routes. Keep it separate from legacy model-name selection until the native dispatch integration is explicit.

Human-owned choices in `deliverables/Decision_Register.csv` remain open. Catalog metadata work can proceed without submitting source code or paid inference. Provider onboarding depends on egress policy; Controlled Auto depends on the approval boundary; native Planner operation depends on the no-qualified-free-Planner decision. Engineering-owned schema/API questions are resolved by inspection rather than invented defaults.

No production code, legacy transport behavior, database migrations or historical audit files were changed by this audit.

## Follow-up: reproducibility and identity repair

The next bounded slice synchronizes `package-lock.json` with the existing manifest; no package declarations changed. A clean `npm ci` now succeeds (613 installed packages). The original unlocked baseline above remains historical evidence.

The legacy identity failure was traced to `migratePlanFirstSchema` stamping version 5 instead of 3, skipping the v4 backfill. It now stamps 3 so initialization executes the remaining migrations in order. Initialization also fills only null/empty Pair identity anchors for files already stamped v6; existing anchors and operational permissions are preserved. A file-backed regression exercises two reopen cycles with null, empty and existing anchors, including an ACTIVE Pair.

Focused migration/operational-state tests: 25/25 pass. TypeScript and renderer/Electron builds pass. Full suite after clean locked install: 1,519 tests, 1,475 passed, 43 failed, one skipped (46.98 seconds). The repaired backfill and new regression account for the two additional passes; remaining failures are retained. Existing locked package versions did not change. `git diff --check` passes.

Bootstrap failures remain separate: `bootstrap_idempotency.test.ts` expects post-arm materialization, but the Engine returns `no_confirmed_delivery` because it finds no attributable message boundary. Recovery tests expect a retry ladder that must be checked against Planner-first authorization before changing behavior. These require causal/authority review, not weakening an evidence gate to match an old expectation.

## Follow-up: Planner bootstrap boundary

The missing Engine bootstrap path now uses the existing ingress ledger. For an authorized, empty ChatGPT Pair, it persists an ingress root, requests an observer arm scoped by `ingressId` (not a fake Delivery), persists the arm ID, and accepts only nonempty completed text with a stable turn key matching that exact arm and conversation. Retired arms are retained rather than rebaselined. Lost bridge history yields no completion; there is no timestamp-based adoption in this path.

Ingress materialization, Assignment creation and execution-slot claim commit in one database transaction. Provider dispatch occurs afterwards through existing guarded transport. Existing assignments prevent new bootstrap work; session changes, pause/stop, wrong arms, empty/unidentified turns and unresolved delivery cannot cause a duplicate bootstrap dispatch. The baton remains ownerless until actual delivery evidence confirms a send.

The original five bootstrap idempotency/restart assertions now pass. The observer stub was extended to expose the new bootstrap interface without weakening its existing assertions. Added coverage rejects wrong arms/conversations and empty/unidentified turns, checks one persisted boundary through restart, and exercises the actual observer client over loopback HTTP with retired arms, stale history and bridge-ledger loss.

Focused/protected suite: 75/75 pass, covering bootstrap, restart, execution-slot invariants, recovery phase semantics and external-effect evidence. Build, TypeScript and bridge JavaScript syntax checks pass. No live ChatGPT/macOS or OpenCode acceptance is claimed. `bootstrap_regression.test.ts` still depends on a specific Mac's historical database and remains a separate environment-bound check; it was not weakened or disabled.

Full suite: 1,521 tests, 1,481 passed, 39 failed, one skipped (44.79 seconds). Four previous bootstrap failures are fixed, and the two new tests pass. Remaining failures are preserved; historical baseline inventories remain unchanged. The final defensive ingress-state/identity guard was checked again with the 75-test protected suite and TypeScript.

## Follow-up: undelivered Planner handoffs

An active handoff-derived Assignment with a definite failed send previously returned `awaiting_evidence` forever. The Engine now retries only reports addressed to the Planner, using the persisted Attempt order and Delivery timestamps. The existing legacy backoff contract is 10s, 20s, 1m, 5m, then 30m between attempts. Every send creates its own auditable Attempt/Delivery; original failures and evidence remain intact. This is transport of a report to the Planner, not authorization to retry Worker work or change models.

Unresolved pending/delivering/ambiguous sends never permit retry. Exhausted short backoff or uncertainty produces one deduplicated critical handoff attention item; confirmed delivery resolves it. Any confirmed Delivery prevents further report retries. The prior Attempt's frozen Pair/runtime/external-session identity must still match the bound Planner. A new test proves that a replacement external Planner session cannot inherit an old failed handoff.

Supervision no longer advances a Pair a second time after its baton path already dispatched a handoff in that tick, preserving one-step boundaries and preventing premature retry/attention processing. Pause/Stop, execution-slot and recovery dispatch guards remain in the shared path.

Final verification: focused/protected suite 73/73 passes; build, TypeScript, bridge syntax and diff checks pass. Full suite on clean locked dependencies: 1,522 tests, 1,497 passed, 24 failed, one skipped (47.58 seconds). The 15 previously failing handoff/retry cases now pass, plus the replacement-session regression. See [remaining failures](PHASE_0_REMAINING_FAILURES.md). Live macOS/provider acceptance remains unverified. Synchronization uses review branch `codex/relayx-phase0-repairs`; the original main baseline is retained for comparison.

## Follow-up: discovery fixtures and Planner Open

The project-discovery fixture intercepted a retained-handle read script while production discovery calls `buildReadActiveTabUrlAppleScript`. It therefore returned an empty host response before all the search/navigation failure scenarios. The fixture now intercepts the actual exported helper's script; search acceptance, result settling, configurable Tab counts, JS-gate errors and invalid Project identity assertions remain intact. Production discovery was not replaced with a synthetic success or altered to satisfy the fixture. All 31 discovery tests pass (74.55 seconds of real polling).

PairView's Planner Open button had bypassed `onOpenPlannerSession` with `window.open`. It now uses the existing session-ID callback, which invokes `openRuntimeSession` and surfaces verified results/failures. Full stored identity remains authoritative; displayed URL elision is not passed to the opener.

Outdated source-contract assertions now explicitly require forwarding the operator's priority through modal/App/bridge. The OpenCode capability expectation reflects its production macOS-only integration (`partial` on Darwin, `unsupported` elsewhere), and the recovery rejection assertion checks the same message case-insensitively. These are corrections to fixtures/contracts after inspecting production behavior; tests were not removed, skipped or relaxed to allow unauthorized recovery.

Focused UI/contract suite: 104/104 passes. Separately invoked rendered RecoveryPanel invariants: 10/10 passes (the existing npm test glob does not include `.test.tsx`). TypeScript and build pass. Full-suite outcome follows below.

Full run after these corrections: 1,522 tests, 1,521 passed, zero test-case failures, one skipped (113.38 seconds). **`npm test` still exits 1** because `bootstrap_regression.test.ts` fails during suite construction: `ERR_SQLITE_ERROR: unable to open database file` for `/Users/lazydeepak/Library/Application Support/RelayX/relay.sqlite`. The test runner's case totals do not include this construction error as a failed case. This is an unexecuted historical live-data gate, not a successful live acceptance check. No suite was removed/skipped to make the command green.

## PR review follow-up: observer restart and failure-time backoff

The Planner observer bridge now journals arm creation, delivery and completion state
into its existing append-only external log and hydrates that ledger before listening.
The restored ledger retains retired bootstrap boundaries and their exact observations,
so a bridge-process restart cannot strand a database ingress on an arm the bridge has
forgotten. Writes occur before mutation acknowledgement; malformed or truncated log
lines do not erase earlier valid evidence, and startup inserts a physical record
separator after any crash-truncated tail before accepting new writes. Observation
sequence numbers remain monotonic across bounded-log reloads.

Planner handoff retry delay is now measured from `Delivery.updatedAt`, which
`markFailed()` sets when a definite failure becomes known, rather than from send-intent
creation. A slow or timing-out transport therefore receives the complete quiet period
after failure and cannot trigger an immediate retry on the next supervision tick.

Review verification: expanded focused/protected suite 79/79 passes, including an
actual bridge stop/restart, truncated-tail recovery and a slow-transport timing regression. TypeScript, build,
bridge syntax and diff checks pass. Full suite after the schema repairs: 1,526 tests,
1,525 passed, zero failed test cases and one skipped (115.90 seconds). `npm test` exits 1 only for the unchanged
`bootstrap_regression.test.ts` suite-construction error against the unavailable
hard-coded macOS live database. No live macOS/provider acceptance is claimed.

The final review also exposed two bootstrap schema compatibility gaps. Creation of
`relay_ingress` is now an unconditional idempotent repair after all version-gated
migrations, so databases already stamped v3–v6 cannot skip the table. Its legacy
`stable_pair_id` column has a foreign key to the current `pairs.id` row; bootstrap now
stores and queries that row ID rather than the Pair's separately preserved immutable
`stableId`. The bootstrap regression suite runs with deliberately different row and
stable IDs, and a v6 migration regression removes the table before reopen. Expanded
focused/protected verification is 80/80.

If the verified Planner session changes while a bootstrap root is still armed or
observed, supervision now atomically marks that stale root `superseded` and creates a
fresh root/arm for the current session. The old boundary remains auditable but cannot
permanently block bootstrap after an authorized Pair rebind. This transition is
covered before materialization in the file-backed restart suite.

The earlier inventories included this construction error alongside failed test cases (25 entries at the 24-failure checkpoint). All previously listed test-case failures are now resolved or their stale fixtures/contracts corrected with evidence above. Next architecture work can proceed with this explicit environment limitation; actual macOS/OpenCode acceptance remains outstanding.
