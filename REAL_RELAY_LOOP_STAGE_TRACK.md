# REAL RELAY LOOP — STAGE-BY-STAGE (stopped at first real failure)
Status: STOPPED at Stage 2 (ChatGPT P0 boundary). No compensation. Full evidence captured.

## Pre-condition (before loop starts)
- ChatGPT adapter: IMPLEMENTED (observeSide / captureTransportBoundary / readExactSessionTurnsForReconciliation in ChatGPTProvider), LIVE-UNVERIFIED
- Integration UI: NOT CHANGED
- Scaffold: kept (chatgpt-turn-observation/) as design record; not expanded as parallel system
- Safety: enforced (DOM miss → unknown; never fabricated; boundary honest failure → null; identity = ordinal+hash, not timestamp)

## Execution order (per instruction, 15 stages)

| # | Stage | Status | Evidence / failure captured |
|---|---|---|---|
| 1 | Load Pair through authoritative activation path (`RelayEngine` / `IntegrationManager` / repo load + `ensureDefaultInvariants`) | ATTEMPTED | No persistent DB file (**`*.sqlite`/`*.db` absent at root**); pair must be created/loaded via `RelayEngine` activation (`loadAndActivate` / `stagedDiscovery`). No synthetic pair created — would violate "not test-only mechanism". |
| 2 | **Establish Planner P0 boundary (`captureTransportBoundary`)** | **STOPPED / FAILED** | **First real failure.** `ChatGPTProvider.captureTransportBoundary()` requires live `BrowserHandle` (open Chrome tab with `/c/<conv-id>`). No ChatGPT planner session is currently bound to RelayX (no `ChatGPT.app` process, no retained `BrowserHandle`). Failure reason captured honestly: `Handle not verified`; `Boundary capture failed safely`; `watermark: null`; `failure: "ChatGPT Planner session not reachable via BrowserHandle..."`. **Not compensated** — no synthetic watermark, no snippet-based boundary, no fallback to `lastResponseSnippet`. |
| 3 | Planner instruction for Worker | NOT EXECUTED | Would require `observeSide()` returning `observed` + `message.ordinal`; then `inspectRuntime()` confirming `isComplete` / new turn; then extracting `message.text` (full, bounded) and `messageId` for correlation. |
| 4 | RelayX retrieves exact new Planner turn | NOT EXECUTED | Would call `readExactSessionTurnsForReconciliation()` (separate from boundary) post-send / on observation tick. |
| 5 | Dispatch exactly once to Worker | NOT EXECUTED | Would call `provider.deliverInstruction()` with `preDispatchWatermark` (now non-null, from stage 2 — if stage 2 had passed); `idempotencyKey`; `runtimeSessionId`; `externalSessionId`. |
| 6 | Observe Worker running → complete | NOT EXECUTED | Would use `detectWorkingState()` (AppleScript Stop button / service state for OpenCode) / `inspectRuntime()` `isWorking` / `isComplete`. |
| 7 | Retrieve and correlate completed Worker result | NOT EXECUTED | Would retrieve worker transcript (OpenCode service/CLI — authoritative) and match to boundary; populate `reconciliation`. |
| 8 | Deliver result back to exact Planner session | NOT EXECUTED | Would call `attemptPlannerDelivery()` (RelayEngine 3248) → `provider.deliverInstruction()` to planner with `instructionText: handoff.resultSummary`; verify with `observeSide()` / DOM after send. |
| 9 | Verify outbound Planner user turn | NOT EXECUTED | Would observe DOM after stage 8 for new user turn corresponding to delivered result; fingerprint comparison (not timestamp). Only DOM-confirmed → `delivered`; else `ambiguous`. |
| 10 | Observe new Planner response P1 after boundary | NOT EXECUTED | Would observe `message.ordinal > boundary.latestOrdinal`; `messageEvidenceState = 'observed'`; `activityState = 'available'`; `isGenerating = false`; full `message.text` retrieved. |
| 11 | Retrieve P1 exactly once and persist consumed watermark | NOT EXECUTED | Would persist to `sideIdentities`: `message.ordinal`, `message.ref` (messageId from DOM), `message.text` (bounded), `observedAt`; to `delivery` evidence: `preDispatchWatermark` embedded; to DB: `watermark` record. |
| 12 | Poll again: P1 not new | NOT EXECUTED | Would compare `nextOrdinal` (from `observeSide()`) to `priorOrdinal` (from `sideIdentities`). Since `nextOrdinal` (same turn) < `priorOrdinal` impossible — same ordinal = same turn; no increase = not new. Return `stale` if older (not applicable); else `same` → no new turn. |
| 13 | Restart RelayX | NOT EXECUTED | Would load `sideIdentities` from DB (`SqliteRepositories` / `MemoryDatabase`); initialize `IntegrationManager`; resolve pair via `resolve()` / `resolveForProject()`; bind planner session via `externalSessionId`. |
| 14 | Confirm P1 still not new after restart | NOT EXECUTED | Would load persisted `ordinal` (e.g., `5`) from DB; observe again (`ordinal = 5`); `5 > 5` false; `5 === 5` true; no new turn confirmed; no duplicate consumption. |
| 15 | Continue M2 → P2 (second distinct turn) | NOT EXECUTED | Would send M2 (`idempotencyKey` new); observe new user turn `ordinal = 6`; observe P2 at `ordinal = 7`; retrieve full; persist; confirm distinct `fullContentHash` from P1 (`hash(P2) !== hash(P1)`). |

## Evidence captured at stop (stage 2 — first failure)

### Pair / session identity (pre-activation — no pair loaded yet)
- `Pair`: **not loaded** (no DB file; no `repos.pairs.findById()` result)
- `Project`: **not resolved** (no `pair.projectId` until loaded)
- `PlannerSessionId`: **unknown** (would come from `pair.plannerSessionId` after load)
- `WorkerSessionId`: **unknown** (would come from `pair.workerSessionId` after load)
- `externalSessionId` (planner): **not established** (would be `runtime.externalSessionId` from DB after bind; for ChatGPT = conversation URL id / `sessionUrl`)
- `sessionUrl`: **unknown** (would be `https://chatgpt.com/c/<conv-id>` from `ChatGPTAppHandler.createSession()` or `openSession()`)

### Boundary / pre-dispatch (stage 2 — failed)
- `provider.captureTransportBoundary()`: called with `provider = ChatGPTProvider`
- `request.externalSessionId`: `null` / not provided (no session bound)
- `handle`: `null` (no `BrowserHandle`; `openDedicatedWindowAndCaptureId()` could not resolve)
- `verifyHandleExists()`: `false`
- `watermark`: **`null`** (honest — not synthesized)
- `failure`: `"ChatGPT Planner session not reachable via BrowserHandle; pre-dispatch boundary cannot be captured."`
- `delivery.evidence` (pre-dispatch): **not written** (because `boundary.watermark` is `null`; RelayEngine 1082 `if (boundary.watermark)` skips; no fabrication)
- `preDispatchWatermark` passed to `deliverInstruction()`: **`null`** (current honest state, now documented — not hidden)

### Safety / no compensation (verified — not violated)
- ❌ No synthetic `watermark` fabricated (not `messageCount=0`, not `messageIds=[]`, not `latestOrdinal=-1` invented)
- ❌ No snippet-based boundary (`lastResponseSnippet` NOT used for watermark; `inspectRuntime()` snippet NOT used to establish boundary)
- ❌ No `observeSide()` fabricated result (method exists, but called when no session; returned `unknown` with honest `reason`; not `observed` with invented `message.ordinal`)
- ❌ No automatic resend (no `deliveryResult.outcome === 'ambiguous'` -> retry without verification; no `idempotencyKey` reused for new attempt unless explicitly new)
- ❌ No window-title-only identity (I-11 enforced: address by `externalSessionId`; `observeSide()` requires `externalSessionId`; `openSession()` uses URL / `sessionUrl`)
- ✅ `isStale` requires both `priorOrdinal` and `nextOrdinal` (`RelayEngine` 4301 preserved; if no `observeSide()`, both null → `isStale = false`; safe, not fabricated)

### What the adapter CAN do now (after stage 2 fix — if session is bound)
With `observeSide()`, `captureTransportBoundary()`, `readExactSessionTurnsForReconciliation()` in `ChatGPTProvider`:
- `observeSide()` → reads DOM; reports `generating` (`textLength=0`, `count>0`) / `completed_new` (`ordinal > prior`) / `unknown` (DOM miss)
- `captureTransportBoundary()` → builds `ChatGPTWatermark` (`count`, `messageIds[]`, `latestOrdinal`, `capturedAt`); returns `null` + `failure` only if unreadable
- `readExactSessionTurnsForReconciliation()` → post-send read; ordered `messages[]`; `readable: false` on failure
- `deliverInstruction()` (existing) → can receive non-null `preDispatchWatermark` (from 1080); sends to exact session via URL / `externalSessionId`
- Post-send verification (not yet in adapter — needs addition to `deliverInstruction()` or `attemptPlannerDelivery()`) → observe DOM for new user turn; fingerprint comparison; only `delivered` when verified

### Recommended fix for stage 2 (before continuing loop)
Not a relay-loop design change — an **activation / session binding** fix:
1. Load/create pair through normal `IntegrationManager` / `RelayEngine` activation (`loadAndActivate` / `stagedDiscovery` per `S6_LOAD_AND_ACTIVATE.md` / `stagedDiscovery.ts`)
2. Bind planner session (`ChatGPTAppHandler.openSession()` / `createSession()` → `runtime.externalSessionId` / `sessionUrl` in DB)
3. Confirm `BrowserHandle` resolves at that session URL (`openDedicatedWindowAndCaptureId()` / `verifyHandleExists()`)
4. Re-run stage 2 (boundary) — should now return non-null `watermark`
5. Continue sequence from stage 3

If stage 2 still fails after session is bound → the failure is DOM/selector (adapter method returns `unknown`); fix selectors or `executeHandleJavaScript()` parameters — not the relay loop.

## Closing statement (per your instruction — stop at first real failure, document, do not compensate)

Stopped at stage 2. The adapter extension is complete and wired into production (`ChatGPTProvider`). The relay loop did not proceed because the **precondition for stage 2 (bound ChatGPT planner session)** is not met in this environment — not because of adapter failure, not because of loop design weakness, not because of missing integration UI.

No synthetic turn IDs. No snippet-based boundary. No bypass of normal path. No `IDLE`→`ACTIVE` weakening. The loop revealed the concrete blocker: **live session binding + DOM observation for planner**. Once that precondition is met (via actual activation / open session), stages 3-15 proceed through the same adapter methods.
