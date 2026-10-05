# BROKEN HANDOFF FIX — CHATGPT SESSION IDENTITY BINDING
Status: FIX IDENTIFIED (not adapter failure; session identity binding is the broken link)
Files changed: NONE (adapter correct; fix is process/activation, not code edit)

## Broken link (exact)

Pair (sqlite DB `relay.db`) → `plannerSessionId` → `RuntimeSession.externalSessionId` (`/c/<conv-id>`) → `ChatGPTAppHandler.openSession()` → `BrowserHandle` (`windowId`, `tabId`) → `readHandleUrl()` verifies URL → `captureTransportBoundary()` → non-null `watermark`.

Current state:
- DB exists (`relay.db`)
- No existing Pair with Planner session bound
- ChatGPT process running (`PID 19789`)
- No `/c/<id>` derivable from ChatGPT state via available mechanisms
- Adapter (`ChatGPTProvider`) ready

## Smallest correction (existing mechanism — no redesign)

Use `ChatGPTAppHandler.createSession()` or `openSession()` with a REAL ChatGPT conversation URL (obtained from ChatGPT web/app — user's existing session or new chat via ChatGPT mechanism — NOT invented).

The existing code paths in `ChatGPTAppHandler` support this:
- `createSession()` with `conversationUrl` → produces `externalSessionId` + `sessionUrl` (line 220-243)
- `openSession()` with `externalSessionId` → opens `https://chatgpt.com/c/{externalSessionId}` (line 290-298)
- `ChatGPTProvider.openDedicatedWindowAndCaptureId(url)` → creates `BrowserHandle` at that URL (line 1412)
- `readHandleUrl(handle)` → verifies URL matches session identity (line 1435)

The only missing step is providing the real URL from ChatGPT.

## What the fix requires (operational, not code)

1. User / ChatGPT mechanism produces a real conversation URL (`/c/<id>`)
2. `ChatGPTAppHandler.createSession()` or `openSession()` receives it
3. `externalSessionId` is persisted to `SqliteRuntimeRepository` (DB)
4. Pair references that runtime (`SqlitePairRepository`)
5. `ChatGPTProvider.openDedicatedWindowAndCaptureId(url)` opens handle
6. `readHandleUrl()` matches persisted identity
7. `captureTransportBoundary()` passes
8. Stage 3 begins

## Verification of adapter readiness (already done)

- `observeSide()`: implemented; safe-fail; returns `present` when readable, `unknown` when not
- `captureTransportBoundary()`: implemented; safe-fail; builds `ChatGPTWatermark`; fails to `null` honestly
- `readExactSessionTurnsForReconciliation()`: implemented; separate from boundary; honest failure
- All use `BrowserHandle` (existing); no adapter redesign needed

## Evidence preserved

- `STAGE2_CORRECT_PATH_STATUS.md`
- `STAGE2_BROWSER_ATTEMPT.md`
- `STAGE2_LIVE_ATTEMPT.md`
- `STAGE2_LIVE_RESULT.md`
- `BROWSER_SESSION_IDENTITY_TRACE.md`
- `CHATGPT_SURFACE_MIX_AUDIT.md`
- `LIVE_BINDING_FINAL.md`
- `STAGE3_READY_STATE.md`
- `REAL_RELAY_LOOP_STAGE_TRACK.md`

## Stop-check

- No adapter edit made ❌ (correct — adapter not broken)
- No synthetic session ❌
- No snippet authority ❌
- No Integration UI change ❌
- No lifecycle redesign ❌
- Only missing: AUTHENTIC SESSION URL FROM CHATGPT
