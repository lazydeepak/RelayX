# STAGE 2 → STAGE 3 — CORRECT RESUME (ACTUAL STATE, NOT SPECULATIVE)
Status: STAGE 2 BLOCKED AT PAIR/SESSION BINDING; ADAPTER VERIFIED; LOOP READY; NO MORE SCAFFOLD
Updated: 2026-10-04

## Completed (actual — not planned)

- Adapter (`ChatGPTProvider.observeSide`, `captureTransportBoundary`, `readExactSessionTurnsForReconciliation`) implemented in `adapters.ts` using existing `BrowserHandle` + `executeHandleJavaScript` mechanism
- Audit: `INTEGRATION_AUDIT_REPORT.md`
- Transport check: `CHATGPT_MINIMUM_TRANSPORT_CHECK.md` (matrix with production paths)
- Mixed-surface audit: `CHATGPT_SURFACE_MIX_AUDIT.md` — native app launch / web session open / web send-observe-boundary identified; smallest fix: session identity binding only
- Stage attempts: `STAGE2_BROWSER_ATTEMPT.md`, `STAGE2_LIVE_ATTEMPT.md`, `STAGE2_LIVE_RESULT.md`
- Identity trace: `BROWSER_SESSION_IDENTITY_TRACE.md` — namespace gap (`tab_5517` vs AppleScript handle) explained
- Loop track: `REAL_RELAY_LOOP_STAGE_TRACK.md` — stages 1-15 with evidence fields
- Gate status: `LIVE_ACCEPTANCE_GATE_STATUS.md`
- Checkpoint: `STAGE3_READY_STATE.md`

## Blocked (honest — first failure, not hidden)

- Stage 2: `captureTransportBoundary()` requires `externalSessionId` + verified `BrowserHandle` at conversation URL
- Pair/session identity (`/c/<conv-id>`) not bound to RelayX persistence
- No synthetic session created; no snippet-boundary; no false `delivered`

## Correct resume (only step needed — no more code)

**Bind ChatGPT planner session to Pair through existing RelayX activation:**

1. Initialize / load RelayX persistence (`SqliteDatabase` / repo setup — standard `S6_LOAD_AND_ACTIVATE.md` path)
2. Create/load Pair (`IntegrationManager` / `RelayEngine` / `stagedDiscovery`) with ChatGPT planner role
3. Bind planner session: `ChatGPTAppHandler.createSession()` with real `/c/<conv-id>` URL (from ChatGPT web UI / existing conversation) OR load from DB/session state
4. Confirm `runtime.externalSessionId` = `/c/<conv-id>` and `sessionUrl` = full URL — persisted to DB
5. Verify `BrowserHandle` at URL (`ChatGPTProvider.openDedicatedWindowAndCaptureId(url)` → `verifyHandleExists()` → `readHandleUrl()` returns matching URL)
6. **Run `captureTransportBoundary()`** — must return `{watermark: {sessionId, messageIds, messageCount, latestOrdinal, capturedAt}, failure: null}`
7. **If pass → IMMEDIATELY Stage 3:** `observeSide()` → new instruction → `deliverInstruction()` (with `preDispatchWatermark`) → observe Worker → retrieve result → `attemptPlannerDelivery()` → observe P1 → retrieve full P1 → persist watermark → restart verify → M2→P2

## What is NOT needed before this

- No adapter redesign (3 methods done, correct)
- No new integration (existing `chatgpt` / `opencode` sufficient)
- No Integration UI change (not relevant to transport)
- No lifecycle redesign (use existing `RelayEngine` / `S6` paths)
- No synthetic session or turn identity
- No snippet authority
- No `tab_5517` as session proof

## If step 3 fails

Document the failure (adapter DOM / handle / session state / persistence / lifecycle) with same evidence-capture pattern. Do not compensate. Fix the actual defect.
