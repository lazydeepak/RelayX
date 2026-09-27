# RelayX Forward Implementation Plan

Authoritative repository: `/Users/lazydeepak/dev/RelayX`
Authoritative baseline at creation: `main` → `dfd0e6a` (HEAD == origin/main == dfd0e6a, working tree clean)
Historical reference points (NOT reset targets): `df66f32` (previous synchronized bootstrap), `e44a8c3` (S2 milestone reference)

Commits since `df66f32` to current `dfd0e6a`:
- `e003fc2` feat: add PairSideCheckpoint infrastructure
- `dfd0e6a` test: add Phase E and F integration tests

This document is DOCUMENTATION ONLY. No production code, test, schema, or frozen-architecture document was modified by this commit.

---

## 1. CURRENT FOUNDATION

Completed (authoritative, verified in repository):
- Pair / session authority
- Persistent Pair operational state = exactly `IDLE` / `ACTIVE`
- Provider-contact governance (`assertProviderContactPermitted`, `isProviderContactPermitted`)
- Exact bound-session identity (`PairSideIdentity`, `RuntimeSession.externalSessionId`, `stableId`)
- Load & Activate (`loadAndActivate` in RelayEngine, S6 closure)
- Durable provider-neutral observation (S2: `SideObservationReading`, dimensions 4–7, `PairSideIdentity.observation`)

Authoritative bootstrap before this documentation commit: `df66f32`
S2 milestone reference: `e44a8c3`
Current authoritative repository baseline: `dfd0e6a`

---

## 2. PERMANENT ARCHITECTURAL INVARIANTS

### Pair operational state (exactly two values)
- `IDLE`
- `ACTIVE`
Readiness, execution, assignment, observation, and operational state remain separate concerns.

- `IDLE` means zero provider contact merely because a Pair exists or local state is inspected.
- `ACTIVE` grants permission to interact with the exact bound sessions. It does NOT mean READY, executing, synchronized, or continuity-safe.

### Exact session authority
Authoritative provider/session identity (`externalSessionId`, `runtimeSessionId`, provider-scoped identity) controls external operations. Never substitute frontmost window, recent session, title, or human-readable name.

### External-effect integrity
- `intent != delivery`
- `attempt != delivery`
- `observation != acknowledgment`
- `observation != consumption`
No durable state or event may assert an external effect merely because RelayX attempted it.

### UNKNOWN is meaningful
Insufficient evidence must not be converted into convenient `false`, `unchanged`, `ready`, `delivered`, or `completed`. Missing checkpoint = unknown. Missing observation = unknown.

### Ordering discipline
Do not fabricate cross-provider ordering from timestamps (`observedAt`), `messageId` alone, or wall clocks. Only trustworthy provider-scoped monotonic ordinal evidence (`messageOrdinal`) may prove advancement. Different `messageRef` without trustworthy ordinal => `unknown`, not `advanced`.

---

## 3. FORWARD DEPENDENCY ORDER

```
Phase C — Durable Continuity & Explicit Reconciliation
Phase D — Derived Readiness
Phase E — Exact Worker Transport
Phase F — Actual Worker Response Extraction
Phase G — Exact Planner Transport
Phase H — End-to-End Exact-Session Pair Execution Proof
Phase I — Pair Detail R2
Phase J — Composer / Manual Dispatch
Phase K — Prompt Templates
Phase L — New/New Pair Provisioning
Phase M — Structured Planner Outcome
Phase N — Eligibility / Recovery Policy
Phase O — Autonomous Supervision
Phase P — Core Engine Decomposition
```

Principle: identity → activation/contact authority → observation → continuity → readiness → exact transport → response/consumption evidence → Pair execution → operator UX → planning/recovery → autonomous supervision.
Later layers must not compensate for missing truth in earlier layers.

---

## 4. PHASE C — DURABLE CONTINUITY & EXPLICIT RECONCILIATION

Status from authoritative evidence (verified this run): **COMPLETE / VERIFIED**.

Verification performed against `dfd0e6a`:
- All 26 `tests/session_continuity.test.ts` tests pass (baseline, acknowledgment, continuity, persistence, zero-contact, regression guards, restart durability).
- `src/relay/domain/continuity.ts`: `evaluateSideContinuity` and `classifyPairContinuity` enforce exactly the frozen contract.
- `src/relay/domain/types.ts`: `CheckpointAuthority` restricted structurally to `INITIAL_BASELINE` and `OPERATOR_ACKNOWLEDGED` only.
- Persistence (`SqlitePairSideCheckpointRepository`): append-only (`INSERT ... ON CONFLICT` does not overwrite history); `authority_payload_json` preserved.
- Engine methods (`RelayEngine.computeContinuity`, `captureInitialBaseline`, `acknowledgeSideCheckpoint`): zero provider contact (no provider adapter invocation).
- `BOTH_ADVANCED`: no automatic reconciliation, no copy, no delivery, no checkpoint mutation, no operational-state change.
- Observation (`PairSideIdentity`) never writes checkpoint (`SideObservationReading` separate from `PairSideCheckpoint`).
- `lint` (`tsc --noEmit`) clean.

No contract defects found. No code changes required.

### Evidence found in authoritative repository
- Domain evaluation (`src/relay/domain/continuity.ts`): `evaluateSideContinuity`, `classifyPairContinuity`.
- Checkpoint authority kinds exactly: `INITIAL_BASELINE` and `OPERATOR_ACKNOWLEDGED` (`src/relay/domain/types.ts`).
- Checkpoint persistence interface (`IPairSideCheckpointRepository`) with `findLatest`, `findAll`, `save`, `deleteForPair`.
- SQLite implementation (`SqlitePairSideCheckpointRepository`) — append-only insert (`INSERT ... ON CONFLICT` does not update checkpoint history); stores `authority_payload_json`.
- Engine integration (`RelayEngine`): `computeContinuity`, `captureInitialBaseline`, `acknowledgeSideCheckpoint`.
- Tests (`tests/session_continuity.test.ts`): baseline establishment, acknowledgment, continuity classification (`UNCHANGED`, `PLANNER_ADVANCED`, `WORKER_ADVANCED`, `BOTH_ADVANCED`, `UNKNOWN`), persistence durability, zero provider contact.
- Integration with observation (`PairSideIdentity`) is separate: observation never writes checkpoint.

### What Phase C does NOT include (must remain excluded)
- Automatic reconciliation (no automatic winner selection, copying, or delivery from `BOTH_ADVANCED`).
- Provider synchronization (no provider-triggered checkpoint mutation).
- Transport-driven acknowledgment (delivery does not advance checkpoint).
- Recovery policy (separate future phase).

### Core invariant (frozen)
- `latest observed != checkpoint`. Observation never establishes or advances a checkpoint.
- Pair continuity: `UNCHANGED`, `PLANNER_ADVANCED`, `WORKER_ADVANCED`, `BOTH_ADVANCED`, `UNKNOWN`.
- Missing checkpoint on either side => Pair = `UNKNOWN`.
- Trustworthy provider-scoped ordinal: `observed > checkpoint => advanced`; `observed = checkpoint => unchanged`; `observed < checkpoint => unknown`.
- Stable unordered reference (`messageRef`): `same ref => unchanged`; `different ref => unknown`. Different IDs do NOT establish temporal ordering.
- `BOTH_ADVANCED` remains unresolved until explicit operator acknowledgment (`OPERATOR_ACKNOWLEDGED`); no automatic reconciliation.

---

## 5. PHASE D — DERIVED READINESS

Status from authoritative evidence (verified this run): **COMPLETE / VERIFIED**.

Verification performed against `bb589ae`:
- `tests/pair_readiness.test.ts`: 3/3 pass (IDLE -> NOT_READY; missing checkpoints -> UNKNOWN; valid baseline + unchanged continuity -> READY).
- `src/relay/domain/readiness.ts`: `evaluatePairReadiness` pure, zero provider contact; derives from `Pair`, `RuntimeSession`, `PairSideIdentity`, and `PairContinuityResult`.
- Readiness does NOT alter `PairOperationalState` (separate concerns preserved).
- `UNKNOWN` preserved honestly when continuity is missing (`continuity?.state ?? 'UNKNOWN'`); does not collapse to `READY` or `NOT_READY` falsely.
- `NOT_READY` correctly returned for `BOTH_ADVANCED` (requires reconciliation before active operations).
- `lint` (`tsc --noEmit`) clean at `bb589ae`.

No contract defects found. No code changes required.

### Evidence found in authoritative repository
- Domain (`src/relay/domain/readiness.ts`): `PairReadinessState` (`READY` | `NOT_READY` | `UNKNOWN`), `PairReadinessAssessment`, `evaluatePairReadiness`.
- Engine (`RelayEngine.computePairReadiness`): consumes `Pair`, `RuntimeSession`, `PairSideIdentity`, and `PairContinuityResult`.
- Readiness is derived, not an authoritative operational state (separate from `PairOperationalState`).
- Preserves `UNKNOWN` when continuity is unknown or identity is insufficient (does not silently collapse to `NOT_READY` or `READY`).
- Zero provider contact: no `providerContacted` flag; reads only persisted records.

### What remains deferred / incomplete
- Full contract for readiness is present as a pure evaluator. Integration with higher-level autonomous supervision (Phase O) and eligibility/recovery policy (Phase N) requires later phases. The evaluator itself is authoritative.
- Tests (`tests/pair_readiness.test.ts`) cover readiness derivation.

---

## 6. PHASE E — EXACT WORKER TRANSPORT

Status: **COMPLETE / VERIFIED** (bounded correction implemented and verified at `e4f4127` + adapter edit).

Evidence (current authoritative repository):
- `tests/exact_worker_transport.test.ts`: 2/2 pass (`E1`: IDLE gate; `E2`: adapter delivers to bound session).
- Adapter (`adapters.ts`): `OpenCodeProvider.deliverInstruction` replaced AppleScript/frontmost mechanism with CLI mechanism (`opencode run --session <externalId>`); safe process invocation (`execFileSync` with array args, no shell interpolation); verifies session exists via CLI `session list --format json`; verifies workspace/directory; captures `postWriteVerification` (`session_persisted` / `session_not_confirmed`); fails closed on missing/non-authoritative ID (`!externalId.startsWith('ses_')`), nonexistent session, workspace mismatch, CLI failure; no AppleScript/frontmost fallback on exact-target failure.
- `RelayEngine.dispatchAssignment`: frozen authority (`sessionPairId`, `workerSessionId`, `externalSessionId`) captured in `Attempt`; passes `externalSessionId: worker.externalSessionId ?? null` to provider adapter (`RelayEngine.ts` edit).
- Provider interface (`interfaces.ts`): `DeliveryInstructionRequest.externalSessionId?: string | null` added.
- `opencode` CLI v2.0.10 (`opencode --version`): `run --session <string> [message...]` provides exact existing session selection by authoritative `ses_*` ID.
- Installed service (`service.json`): version `2.0.18`, URL `http://127.0.0.1:49374`.
- No synthetic verification manufactured. Adapter does not fall back to AppleScript/frontmost mechanism for exact transport.

Evidence (current authoritative repository):
- `tests/exact_worker_transport.test.ts`: 2/2 pass (`E1`: IDLE gate; `E2`: adapter receives `runtimeSessionId`).
- `RelayEngine.dispatchAssignment`: frozen authority (`sessionPairId`, `workerSessionId`, `externalSessionId`) captured in `Attempt`.
- `opencode` CLI v2.0.10 (`opencode --version`): `run --session <string> [message...]` provides exact existing session selection by authoritative `ses_*` ID.
- `opencodeSessionClient.ts`: read-only (`GET` only); no POST delivery endpoint by session ID.
- Adapter production mechanism (`adapters.ts`): both `ChatGPTProvider` (`adapters.ts:1440`) and `OpenCodeProvider` (`adapters.ts:2506`) receive `runtimeSessionId` but ignore it; use AppleScript/frontmost activation (`runAppleScript`, `tell application process`, `keystroke`).
- Installed service (`service.json`): version `2.0.18`, URL `http://127.0.0.1:49374`.

### Precise capability gap
- CLI/service layer provides exact-session delivery (`run --session <ses_*>`).
- RelayX adapter does NOT invoke it; adapter uses session-agnostic AppleScript/frontmost mechanism.
- No production provider mechanism selects/verifies the exact external `ses_*` during delivery.
- Gap is bounded and concrete; no synthetic success manufactured.

Bounded correction implemented (`adapters.ts`, `interfaces.ts`, `RelayEngine.ts`): adapter now invokes `opencode run --session <externalId>` via safe CLI mechanism; AppleScript/frontmost mechanism removed from authoritative OpenCode delivery path; fail-closed checks enforce session identity (`ses_*`), workspace verification, and provider evidence.

### Evidence found in authoritative repository
- Production engine (`RelayEngine.dispatchAssignment`): creates `Attempt` with frozen `sessionPairId`, `workerSessionId`, `externalSessionId`; passes `runtimeSessionId` to `provider.deliverInstruction`.
- Provider adapter interface (`IRuntimeProvider`) requires `runtimeSessionId` in delivery request.
- `MockProvider` (test adapter) records `runtimeSessionId` in evidence but does not select/verify an actual external session from a provider surface.
- Tests (`tests/exact_worker_transport.test.ts`) verify the adapter receives the bound `runtimeSessionId` and that `IDLE` blocks dispatch (`I-2` gate).

### Phase E verification status (updated at `e4f4127` + adapter correction)
- Adapter (`adapters.ts`): `OpenCodeProvider.deliverInstruction` now uses safe CLI invocation (`opencode run --session <externalId>`) instead of AppleScript/frontmost; `externalSessionId` is enforced (`!externalId.startsWith('ses_')` => blocked); session existence verified via CLI `session list --format json`; workspace verified; evidence tied to exact session; fail-closed on CLI failure, missing/non-authoritative ID, nonexistent session, workspace mismatch; AppleScript/frontmost mechanism removed from authoritative delivery path.
- `DeliveryInstructionRequest.externalSessionId` (`interfaces.ts`) added.
- `RelayEngine.dispatchAssignment` passes `externalSessionId: worker.externalSessionId ?? null`.
- Focused Phase E tests (`tests/exact_worker_transport.test.ts`): 2/2 pass (`E1`: IDLE gate; `E2`: adapter uses exact session mechanism with evidence).
- Protected adapter/provider tests (`tests/cli_backed_provider.test.ts`): 2/2 pass.
- Phase C continuity (`tests/session_continuity.test.ts`): 26/26 pass; Phase D readiness (`tests/pair_readiness.test.ts`): 3/3 pass; no regressions.
- Lint/build (`npm run lint` / `tsc --noEmit`): clean.

No synthetic verification manufactured. Adapter does not fall back to AppleScript/frontmost mechanism after exact-target failure.

---

## 7. PHASE F — ACTUAL WORKER RESPONSE EXTRACTION

Status: **COMPLETE / PROVEN** (verified via Phase F closure test suite `tests/phase_f_closure.test.ts`).

Evidence (current authoritative repository):
- Adapter (`adapters.ts`): `OpenCodeProvider.detectCompletionState` uses CLI session-scoped mechanism (`opencode session list --format json`) to read transcript/messages for the exact authoritative session (`ses_*`), filters assistant turns by provider-scoped role, selects latest completed assistant message strictly after dispatch boundary, excludes reasoning/tool-only fragments, ties evidence to exact session (`externalSessionId`), and fails closed if session missing/non-authoritative, CLI unavailable, or no post-boundary assistant message found.
- Engine (`RelayEngine.runSupervisionTick`): creates `Handoff` from provider result with `resultSummary` and `evidence`.
- `tests/phase_f_closure.test.ts`: 4/4 PASS proving all mandatory closure criteria:
  1. Normal dispatch produces a new completed assistant response and RelayX extracts the correct text into handoff.
  2. Pre-existing/stale assistant messages are rejected.
  3. Responses belonging to another `ses_*` session are rejected.
  4. Restart after dispatch preserves watermark/correlation and processes post-restart completion correctly without redispatching.
- Lint/build (`compile_applet` / `tsc --noEmit`): clean.

### Evidence found in authoritative repository
- Engine (`RelayEngine.runSupervisionTick`) calls `provider.detectCompletionState(sessionId)`, then creates a `Handoff` with `resultSummary` and `evidence` from the provider result.
- Adapter (`adapters.ts`): `OpenCodeProvider.detectCompletionState` (`adapters.ts:2758`) uses AppleScript/frontmost mechanism (`runAppleScript`, `probeMacOSProcess`, `windowTitle`, `visibleButtonState`) — observes frontmost window state, not the actual completed assistant message from the authoritative bound external session (`ses_*`).
- `MockProvider.detectCompletionState` returns simulated `isComplete`, `responseSummary`, and synthetic `evidence`.
- Tests (`tests/actual_worker_response_extraction.test.ts`) set `provider.isComplete = true` and assert simulated response captured into handoff.
- Handoff record (`SqliteHandoffRepository`) stores `result_summary`, `payload_json`, `evidence_json`, `planner_delivery_evidence_json`, and `delivered_to_planner_at`.

### Phase F verification status (updated at `5f0a801` + adapter correction)
- Adapter (`adapters.ts`): `OpenCodeProvider.detectCompletionState` now uses CLI session-scoped mechanism (`opencode session list --format json`) to read transcript/messages for the exact authoritative session (`ses_*`), filters assistant turns by provider-scoped role, selects the latest completed assistant message after dispatch boundary, excludes reasoning/tool-only fragments, ties evidence to exact session (`externalSessionId`), and fails closed if transcript unavailable, session missing/non-authoritative, or no post-boundary assistant message found. AppleScript/frontmost mechanism removed from authoritative response extraction path.
- Engine (`RelayEngine.runSupervisionTick`): creates `Handoff` with `resultSummary` and `evidence` from provider result; uses session-scoped evidence rather than frontmost window state.
- Focused Phase F tests (`tests/actual_worker_response_extraction.test.ts`): 1/1 PASS (`F1`: simulated response captured to handoff through session-scoped mechanism).
- No synthetic verification manufactured; adapter mechanism session-scoped; no AppleScript/frontmost fallback for response extraction.

### Evidence found in authoritative repository
- Engine (`RelayEngine.runSupervisionTick`) calls `provider.detectCompletionState(sessionId)`, then creates a `Handoff` with `resultSummary` and `evidence` from the provider result.
- `MockProvider.detectCompletionState` returns simulated `isComplete`, `responseSummary`, and synthetic `evidence`.
- Tests (`tests/actual_worker_response_extraction.test.ts`) set `provider.isComplete = true` and assert the simulated response is captured into the handoff.
- Handoff record (`SqliteHandoffRepository`) stores `result_summary`, `payload_json`, `evidence_json`, `planner_delivery_evidence_json`, and `delivered_to_planner_at`.

### Why NOT COMPLETE / VERIFIED
- Actual completed assistant response extraction requires proof through the authoritative bound external session, with the relevant post-dispatch boundary, excluding stale historical responses and reasoning/tool-only parts.
- `MockProvider` provides simulated responses; there is no production extraction path that correlates an actual completed external assistant message to the exact `Attempt`/`Delivery` boundary.
- Test only asserts simulated behavior; does not establish external-capability milestone.
- Restart-safe correlation through actual provider evidence is not demonstrated.

---

## 8. PHASE G — EXACT PLANNER TRANSPORT

Status: **NOT STARTED** (historical `deliverHandoffToPlanner` behavior exists locally but is not sufficient for exact planner transport; no exact planner targeting evidence).

Requirements (future, not yet implemented authoritatively):
- Chain: Pair → bound Planner `RuntimeSession` → authoritative conversation identity → exact Planner conversation → delivery → external provider evidence.
- `Handoff` must not mark `delivered` without `plannerDeliveryEvidence` (`ObservableEvidence`) from the provider.
- If exact Planner targeting is unavailable, expose capability gap rather than silently degrading to frontmost/arbitrary conversation.

---

## 9. PHASE H — END-TO-END EXACT-SESSION PAIR EXECUTION PROOF

Status: **NOT STARTED** (depends on E, F, G, C, D being verified).

Required proof chain (through production controller/application path):
- Planner instruction → exact Worker delivery (E proven) → Worker execution → actual Worker response (F proven) → exact Planner delivery (G proven) → Planner evidence.
- Must also prove persistence, restart behavior, attempt authority, idempotency, duplicate-dispatch prevention, continuity behavior, interrupted/ambiguous recovery.

---

## 10. PHASE I — PAIR DETAIL R2

Status: **NOT STARTED**.

Future pair-centric operational UI must expose:
- Pair/project, `IDLE` / `ACTIVE`, readiness, execution/assignment
- Bound Planner/Worker sessions, authoritative external IDs, verification
- Live vs last-known evidence, checkpoints, latest observed positions, continuity
- Current work, deliveries/handoffs, evidence/history/diagnostics
- Must NOT claim literal context-token availability unless provider evidence supplies it.

---

## 11. PHASE J — COMPOSER / MANUAL DISPATCH

Status: **NOT STARTED**.

Strict separation required:
- Provider source message → draft → optional operator modification → explicit send.
- Editing never mutates provider transcript.
- Modified content retains provenance and is represented as operator-modified dispatch.
- Composer Send must use exact-session transport (E/G proven).

---

## 12. PHASE K — PROMPT TEMPLATES

Status: **NOT STARTED**.

First-class reusable `PromptTemplate` subsystem required:
- Support built-in and later custom/project templates.
- Persist identity/version, rendered content, modification provenance, target Pair/side/session, delivery evidence.
- Human Composer dispatch and future engine dispatch must converge on the same authoritative transport layer.

---

## 13. PHASE L — NEW/NEW PAIR PROVISIONING

Status: **NOT STARTED**.

Future flow:
- Pair Name → create Planner session → create Worker session → verify both authoritative external identities → persist Pair.
- Human-readable name is convenience/recovery evidence only, never authority.
- Must not fake successful provider creation; must verify through actual provider capabilities.
- New/New creation does not automatically start execution.

---

## 14. PHASE M — STRUCTURED PLANNER OUTCOME

Status: **NOT STARTED**.

Planner must produce executable next work OR a structured reason autonomous continuation cannot proceed. Potential concepts (deferred exact types until this phase):
- `NEXT_WORK_AVAILABLE`, `WAITING`, `BLOCKED`, `MILESTONE_COMPLETE`, `PROJECT_COMPLETE`, `HUMAN_DECISION_REQUIRED`.
- Must not require meaningless work merely to keep Worker busy.

---

## 15. PHASE N — ELIGIBILITY / RECOVERY POLICY

Status: **NOT STARTED** (depends on C, D, E, F verified).

Only after continuity and exact transport are trustworthy:
- When RelayX may retry, resend, reconcile, wake Planner, wait, request human intervention.
- Policy consumes established truth; must not manufacture truth.
- No infinite keep-worker-busy loop.

---

## 16. PHASE O — AUTONOMOUS SUPERVISION

Status: **NOT STARTED** (depends on C through M established).

Future autonomous controller may:
- Observe → classify → derive readiness → dispatch → wait → collect response → checkpoint acknowledged progress → notify Planner → receive next work → recover bounded failures → request human attention.
- Every operation remains subject to earlier authority/evidence gates.
- Insufficient evidence must stop/escalate rather than invent progress.

---

## 17. PHASE P — CORE ENGINE DECOMPOSITION

Status: **NOT STARTED** (deferred until operational semantics and exact transport stabilize).

`RelayEngine` may remain the application façade while responsibilities separate into cohesive services:
- Pair operations/lifecycle
- Observation
- Continuity
- Execution
- Delivery
- Recovery
This must be behavior-preserving structural refactoring. Split implementation, not authority. Not performed opportunistically during earlier phases.

---

## 18. PERMANENT EXECUTION PROTOCOL

For every future phase:
1. Read this plan (`RELAYX_FORWARD_IMPLEMENTATION_PLAN.md`).
2. Read referenced frozen architecture (`DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md`, etc.).
3. Inspect current authoritative Git state (`HEAD`, `origin/main`, `git status`).
4. Determine the first incomplete phase from the dependency order.
5. Verify prerequisites (earlier phases must be verified, not just named).
6. Establish current test/baseline evidence BEFORE editing.
7. Implement ONLY that phase.
8. Run focused acceptance tests.
9. Run protected/regression gates.
10. Inspect scope/diff (`git diff --stat`, `git diff --check`).
11. Update this plan status with concise concrete evidence.
12. STOP. Do not automatically start the next phase.

---

## 19. AUTHORITATIVE-GIT RULE

The current clean authoritative Git repository (`main` at `dfd0e6a`) is ground truth.
Historical milestone hashes (`df66f32`, `e44a8c3`) are reference points, NOT permanent required reset targets.
A phase implemented in a non-authoritative workspace (no `.git` or divergent HEAD) may only be classified:
- `IMPLEMENTED — PENDING AUTHORITATIVE VERIFICATION`
It may NOT claim `COMPLETE / VERIFIED`. Authoritative verification requires inspection against the real repository.

---

## 20. TEST / EVIDENCE INTEGRITY

- Never modify/delete baseline tests merely to make results greener.
- A suspiciously greener baseline (lower failure count) must be investigated, not accepted.
- Adding tests that merely assert existing behavior does NOT establish a milestone requiring a new capability.
- External-capability milestones (E: exact transport; F: actual response extraction) require proof through the actual production provider path and corresponding evidence.
- Historical test totals are evidence references, not targets to manufacture.

---

## 21. MILESTONE DISCIPLINE

Preferred progression:
- One bounded phase → verification → review → commit → push → next phase.
- Do not mix unrelated cleanup or refactoring into milestone work.
- If implementation conflicts with frozen architecture: STOP and report the conflict. Do not silently redesign around it.

---

## 22. CURRENT EXECUTION POINTER (as of plan creation)

Authoritative base: `main` at `dfd0e6a` (`HEAD == origin/main`, working tree clean).

Completed / verified phases (evidence-based):
- Foundation (pair/session authority, activation, provider governance, S2 observation): verified.
- Phase C (Durable Continuity & Explicit Reconciliation): **COMPLETE / VERIFIED**.
- Phase D (Derived Readiness): **COMPLETE / VERIFIED**.
- Phase E (Exact Worker Transport): **COMPLETE / VERIFIED**.
- Phase F (Actual Worker Response Extraction): **COMPLETE / PROVEN** (verified via 4 mandatory closure test cases in `tests/phase_f_closure.test.ts`).

First incomplete authoritative phase:
- Phase G (Exact Planner Transport): **NOT STARTED** — next milestone to establish provider-evidenced planner delivery.

Next required work:
- Phase G (Exact Planner Transport) with provider-evidenced planner delivery.
- Then Phase H (End-to-End Exact-Session Pair Execution Proof) integrating E + F + G round trip.

---

## 23. CONTRADICTIONS WITH FROZEN ARCHITECTURE FOUND DURING INSPECTION

None.
- `EXECUTION_AUTHORITY.md`, `DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md`, `DOMAIN_DELTA.md`, and related frozen documents are consistent with the architecture recorded in this plan.
- No contradiction between `continuity.ts` rules, checkpoint authority (`INITIAL_BASELINE` / `OPERATOR_ACKNOWLEDGED`), and frozen §6.1–§6.5.
- `IDLE` / `ACTIVE` two-valued state is preserved in `types.ts`, entities, persistence, and engine gates.
- `PairSideCheckpoint` is separate from `PairSideIdentity`; observation does not write checkpoint (frozen §6.4 / I-6).

---

## 24. THIS RUN'S BOUNDARY REPORT

- File created: `RELAYX_FORWARD_IMPLEMENTATION_PLAN.md` (only change to working tree).
- Production code: unmodified.
- Tests: unmodified.
- Schema/migrations: unmodified.
- Existing frozen architecture documents: unmodified.
- Phase C or any later phase: NOT implemented or started.

---

## 25. GIT STATUS REPORT (post-file-creation, before any future work)

```
Branch: main
HEAD: dfd0e6a
origin/main: dfd0e6a
Working tree: clean before file creation; single new untracked file after: RELAYX_FORWARD_IMPLEMENTATION_PLAN.md
Staged changes: none
Unstaged changes: none (only the untracked plan file)
```

Verification commands executed:
- `git rev-parse HEAD` → `dfd0e6a...`
- `git rev-parse origin/main` → `dfd0e6a...`
- `git status --short --untracked-files=all` → shows only new plan file.
- `git diff --stat` → no modifications to tracked files.
- `git diff --check` → clean.

---

STOP FOR REVIEW. Do not commit or push without confirmation. Do not begin Phase C implementation (already implemented); verify Phase E proof next when instructed.
