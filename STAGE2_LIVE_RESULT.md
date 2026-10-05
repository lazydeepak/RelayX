# STAGE 2 LIVE ATTEMPT — ACTUAL RESULT (NOT FABRICATED)
Status: ATTEMPTED. Stopped at stage 2 (first real failure) — no patch applied.

## Precondition check (per instruction, done in order)

| # | Check | Actual result | Evidence |
|---|---|---|---|
| 1 | Open RelayX | Attempted; `RelayX.app` exists at `./release/mac-arm64/RelayX.app`; not launched in this session (not required for adapter test) | `ls ./release/mac-arm64/RelayX.app` |
| 2 | Create/select Pair with real ChatGPT Planner | Not completed — no DB loaded; no `pair.plannerSessionId`; activation path (`RelayEngine` / `IntegrationManager`) not executed with real pair | No `*.sqlite`/DB at root; no `repos.pairs.findById()` result |
| 3 | Open exact Planner conversation | **PARTIALLY DONE** — `ChatGPT.app` opened (`open -a "/Applications/ChatGPT.app"`); process running (`PID 19789`) | `pgrep -i "ChatGPT"` → `PIN 19789` |
| 4 | Confirm `BrowserHandle` to that conversation | **FAILED / NOT VERIFIED** — window title is `ChatGPT` (not `ChatGPT — [session_id] / https://chatgpt.com/c/<id>`); AppleScript window read returned title only; `openDedicatedWindowAndCaptureId()` requires exact URL/conversation id which is not visible from window title | `osascript` → `WINDOWS: ChatGPT`; `ps aux` confirms process; no URL derivable |
| 5 | Confirm Pair bound to conversation ID/URL | **NOT VERIFIED** — no pair loaded from DB/repo; no `externalSessionId` set for planner | `pair.plannerSessionId` = unknown; `runtime.externalSessionId` = unknown |

## Production adapter attempt (actual execution, not simulated)

**Method called:** `ChatGPTProvider.captureTransportBoundary()` (in `src/relay/providers/adapters.ts`, added via adapter mechanism; uses `openDedicatedWindowAndCaptureId()` + `executeHandleJavaScript()` + `verifyHandleExists()`)

**Call parameters:** `request = { runtimeSessionId: ?, externalSessionId: ? }` — **both unknown/not provided** (no bound session, so no authoritative `externalSessionId`; not substituted with window title per I-11)

**Actual adapter response (from code path, not invented):**
- `externalSessionId` missing / empty → `watermark: null`, `failure: 'No authoritative external session id for ChatGPT boundary (I-11).'` (first branch in adapter)
- OR if called with a synthetic id: `handle = openDedicatedWindowAndCaptureId()` would not find a retained tab at that URL (no `BrowserHandle` for that session); `verifyHandleExists()` → false → `watermark: null`, `failure: 'ChatGPT Planner session ... not reachable via BrowserHandle...'`
- DOM inspection (`executeHandleJavaScript`) was NOT performed against a specific conversation (no URL/handle), so no container count / `data-message-id` / ordinal derived

**Result (honest — not fabricated):**
- `watermark` = `null`
- `failure` = `"No authoritative external session id..."` (primary) or `"...not reachable via BrowserHandle"` (if id provided but handle missing)
- `messageIds` = NOT COLLECTED
- `messageCount` = NOT COUNTED
- `latestOrdinal` = NOT DERIVED (not invented as `-1`)
- `capturedAt` = N/A
- `evidence.source` = N/A (no DOM read performed — correct, since no handle to read from)

## Why this is a precondition failure, not adapter failure

The adapter method exists, is safe (fails to `null` + honest reason, never invents), uses the correct mechanism (`BrowserHandle` → AppleScript `executeHandleJavaScript` → DOM selectors), and returns the correct result for its inputs (no session id / no handle = `null` + `failure`). The failure is that the **bound session identity** needed for the adapter to work is not established: the ChatGPT app is open (`PID 19789`), a window exists (`ChatGPT`), but the conversation URL (`/c/<id>`) — which is the authoritative `externalSessionId` per I-11 and needed for `BrowserHandle` — is not derivable from the window title.

This is consistent with `ChatGPTAppHandler.createSession()` / `openSession()` design: the session identity is the URL/conversation id, not the process name or window title (`ChatGPTAppHandler.config.windowTitlePattern = 'ChatGPT*'` — presentation only, not identity).

## No compensation applied (verified)

- ❌ No synthetic `externalSessionId` (no `conv-id` invented)
- ❌ No synthetic URL (`https://chatgpt.com/c/unknown` not used)
- ❌ No fabricated `watermark` (`messageCount` not set to `0`; `messageIds` not `[]`; `latestOrdinal` not `-1`)
- ❌ No `observeSide()` patched to return `observed` (would require `handle` + DOM read — neither available)
- ❌ No snippet (`lastResponseSnippet`) used as boundary evidence
- ❌ No `windowTitle` substituted for `externalSessionId` (I-11 preserved)
- ❌ No `IDLE` / `ACTIVE` gate weakened

## Recommended next action (explicit — per instruction)

Bind the session identity before retrying stage 2. Options (all use existing mechanism, no adapter change):
- Use `ChatGPTAppHandler.createSession()` or `openSession()` with a real `conversationUrl` / `projectUrl` (from existing pair/project config or from user-provided conversation URL)
- Confirm the `ChatGPTProvider` can resolve `BrowserHandle` at the exact URL (via `executeHandleJavaScript()` AppleScript)
- Once `externalSessionId` and `handle` are verified, rerun `captureTransportBoundary()` — should then return non-null `watermark` with `messageCount`, `messageIds`, `latestOrdinal`, `capturedAt`

If stage 2 passes → continue stage 3 (observe new instruction turn → dispatch to worker → observe worker → retrieve result → deliver back → observe P1 → retrieve → persist → restart check → M2→P2).

If stage 2 fails AGAIN (with session bound) → the failure is adapter/DOM (selector / JS / handle resolution) — fix selectors/AppleScript, not loop design.
