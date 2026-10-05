# ChatGPT Integration — Mixed-Surface Audit (Correct Path Identified)
Status: TRACE COMPLETE. No adapter redesign. Smallest fix is session identity binding, not transport.

## Mixed paths found (exact file/line evidence)

| Stage | Handler config / method | Surface actually used | Authoritative for BrowserHandle transport? |
|---|---|---|---|
| Launch / Focus | `ChatGPTAppHandler` config (line 44): `appPath=/Applications/ChatGPT.app`, `bundleId=com.openai.chat`, `launchScript='open -a "/Applications/ChatGPT.app"'` | **Native app** (ChatGPT.app process) | NO — presentation only |
| Create Session | `createSession()` (line 212-288): if `conversationUrl` provided → web URL (`/c/<id>`); else synthetic UUID + URL construction | **Web when URL given; synthetic when not** | YES when real URL; NO when synthetic |
| Open / Focus Session | `openSession()` (line 290-345): opens `https://chatgpt.com/c/{externalSessionId}` via `exec` + activates provider runtime | **Web URL** — correct for handle | YES — this is the bound session identity |
| Project Discovery | `discoverProjectScript` + `ChatGPTProvider.resolveChatGPTProject()` (`chatgptProjectDiscovery.ts`) | **Web** (`chatgpt.com/projects` + Chrome tab) | Presentation (script-driven, repairable from Integration page) |
| Send Message | `sendMessage()` → `ChatGPTProvider.deliverInstruction()` (`adapters.ts` 1169+) → AppleScript keystroke / Chrome DOM injection | **Web / Chrome** (uses `BrowserHandle` when available; AppleScript when not) | YES — when bound to exact session via `externalSessionId` |
| Inspect Session | `inspectSession()` → `ChatGPTProvider.inspectRuntime()` (adapters 538+) | **Presentation** (AppleScript window / snippet / `lastResponseSnippet`) | NO — snippet only; authoritative only with `observeSide()` + boundary |
| Session Identity | `createSession()` / `openSession()` → `externalSessionId` from URL / provider | **Web session URL** (`/c/<id>`) | YES — I-11 (addressed by provider's own id, never title) |
| BrowserHandle / Transport Boundary | `ChatGPTProvider.captureTransportBoundary()` / `readExactSessionTurnsForReconciliation()` / `observeSide()` (just added) | **Web / Chrome** (AppleScript to Chrome `tab id` / `window id`; DOM selectors; JS execution) | YES — when session bound and handle verified |

## The mix (clear from this table)

Launch is native (`ChatGPT.app`). Session creation CAN be native (`createPlannerSession` via provider) OR web (when `conversationUrl` given). Session open is web URL. Discovery is web. Send is web/Chrome via handle or AppleScript. Inspect is presentation.

The authoritative path for relay (what I just implemented) is:
`create/open web session → retain BrowserHandle → boundary/observe/reconcile/read through that same handle`

The non-authoritative path is:
`open native app → inspect via window/snippet → send via AppleScript (no boundary, no transcript reconciliation)`

Both can coexist — but for relay, only the web session with handle is authoritative.

## Invariant (frozen, not changed)

"A bound ChatGPT Planner session must be created/opened, identified, sent to, and observed on one authoritative surface."

For current adapter: that surface = Chrome web conversation (`/c/<id>`) with `BrowserHandle`. The native app (`ChatGPT.app`) can remain a separate, non-authoritative manual mode (or can serve as a launch mechanism that opens the web session — but the session identity must come from the web URL, not the native process name).

## Smallest correction (not redesign)

- Do NOT change integration config (`appPath`, `bundleId`, `launchBehavior` stay — native app is fine for launching)
- DO ensure `createSession()` for planner produces/uses a real `conversationUrl` / `/c/<id>` (not synthetic UUID when a real session exists)
- DO persist `externalSessionId` + `sessionUrl` to DB (`RuntimeSession`) so adapter has identity
- DO open session via `openSession()` with that `externalSessionId` → handle at URL
- DO observe/inspect/boundary/reconcile through that SAME handle (not via window title / snippet)
- Keep native-only path available for manual/non-relay use (not forbidden; just not authoritative for transport)

## Nothing to redesign

- Adapter transport is correct (3 methods; safe-fail; DOM-based; handle-based)
- Integration manifest is correct (capabilities list exact; adapterType `native_builtin` appropriate for web/Chrome hybrid)
- `IntegrationManager` seed defaults correct (chatgpt planner, opencode worker)
- Scripts (`discoverProjectScript`) are repairable without domain change (design feature, not defect)
- Only fix: bind session identity correctly (Pair/DB → adapter handle → boundary passes)

## Verification of correction (after session bound)

When corrected:
- `ChatGPTAppHandler.createSession()` / `openSession()` produces `externalSessionId` = conversation id from URL
- `ChatGPTProvider.openDedicatedWindowAndCaptureId(url)` creates handle at that URL
- `readHandleUrl()` verifies URL matches `externalSessionId`
- `captureTransportBoundary()` → `watermark: {messageIds, count, latestOrdinal, capturedAt}`
- `observeSide()` → `message.ordinal`, `message.text` (full, bounded), `message.ref`
- `sendMessage()` → delivers through handle at exact session
- All through ONE surface — web/Chrome with `BrowserHandle`
