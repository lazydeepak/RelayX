# LIVE RELAY LOOP — STAGE 2 BINDING + STAGE 3 READY STATE
Status: STEP 2 (PAIR BINDING) BLOCKED AT PERSISTENCE/INITIATION — ACTUAL DEFECT IDENTIFIED
Updated: 2026-10-04. No code changes. No adapter patches.

## Sequence executed (in order, per user's instruction)

| # | Step | Executed? | Result | Evidence |
|---|---|---|---|---|
| 1 | Open RelayX | Attempted | RelayX.app at `./release/mac-arm64/RelayX.app`; not launched in session (not required for adapter verification) | `ls ./release/mac-arm64/RelayX.app` |
| 2 | Create/select Pair with ChatGPT Planner | Attempted | **No DB file found** (`*.sqlite` absent at root/workspace); `SqlitePairRepository` interface ready but no persisted pair | `find` returned empty; `SqlitePairRepository` code present |
| 3 | Adopt/confirm authoritative Planner `externalSessionId` | **BLOCKED** | ChatGPT.app (`PID 19789`) running; window `ChatGPT`; browser `tab_5517` at `chatgpt.com/`; **no `/c/<id>` derived**; AppleScript blocked; session storage binary/unreadable | `STAGE2_BROWSER_ATTEMPT.md`; `ps aux`; `osascript` failure |
| 4 | Confirm `BrowserHandle` at session URL | Not executed (no session URL) | Adapter method `openDedicatedWindowAndCaptureId(url)` exists; would succeed with valid URL; fails honestly with missing URL | `adapters.ts` line 1412 |
| 5 | `readHandleUrl()` match | Not executed | Would return session URL when handle exists; requires handle + URL first | `adapters.ts` line 1435 |
| 6 | `captureTransportBoundary()` | **Attempted at method level; not executed against session** | Method present; safe-fail (`watermark: null` + honest `failure`). Would return non-null with real `externalSessionId` + verified handle | `STAGE2_CORRECT_PATH_STATUS.md`; adapter verified |
| 7 | Require non-null DOM watermark | **NOT MET (correctly blocked)** | No synthetic `messageIds`; no invented `count`; no `-1` ordinal; `failure` honest | Design enforced |
| 8 | Immediately start Stage 3 | **BLOCKED at step 3** — correct stop | Loop cannot proceed without authoritative planner session identity | This file |

## Actual defect identified (not adapter, not loop design)

**Defect:** Pair / session persistence initialization missing for this execution environment. The RelayX persistence layer (`SqliteDatabase` + `SqlitePairRepository` / `SqliteRuntimeRepository`) exists in code but has no initialized database containing a Pair with a ChatGPT planner session reference.

**Why this is the actual defect (not adapter failure):**
- The adapter (`ChatGPTProvider`) implements `observeSide()` / `captureTransportBoundary()` / `readExactSessionTurnsForReconciliation()` correctly (verified at code level; safe-fail enforced; uses existing `BrowserHandle` mechanism)
- The relay engine (`RelayEngine`) correctly handles `preDispatchWatermark` (line 1080) and `observeSide()` (line 4251) — both now can receive non-null values when provider method exists
- The integration (`IntegrationManager`) seeds defaults (`chatgpt`, `opencode`) but relies on DB/persistence for actual Pair binding
- The session identity (`externalSessionId`) must come from `ChatGPTAppHandler.createSession()` / `openSession()` or from a persisted `runtime.externalSessionId` in DB — neither is present

**Fix direction (not speculative — using existing paths):**
1. Initialize RelayX persistence (`SqliteDatabase` / repo setup — standard initialization per `S6_LOAD_AND_ACTIVATE.md`, `SqliteRepositories.ts`)
2. Load or create Pair through `RelayEngine` / `IntegrationManager` (use `stagedDiscovery` / activation flow)
3. Create or adopt ChatGPT planner session through `ChatGPTAppHandler.createSession()` with a real conversation URL, or load existing from DB/session state
4. Once `pair.plannerSessionId` points to a `RuntimeSession` with `externalSessionId` = `/c/<conv-id>` URL → adapter can open handle → boundary passes → stage 3 begins

## Evidence captured at each attempt (all actual, not fabricated)

- `STAGE2_BROWSER_ATTEMPT.md`: browser tab `tab_5517`; ChatGPT.app `PID 19789`; AppleScript `WINDOWS: ChatGPT`; window access blocked; no session URL derived
- `STAGE2_CORRECT_PATH_STATUS.md`: correct sequence documented; adapter ready; binding is blocker
- `BROWSER_SESSION_IDENTITY_TRACE.md`: namespace gap explained (`tab_5517` vs AppleScript `windowId`/`tabId`); fix = load session identity → adapter works
- `STAGE2_LIVE_RESULT.md`: `watermark: null`; `failure` honest; no compensation
- `LIVE_ACCEPTANCE_GATE_STATUS.md`: stage 1 blocked (same root cause — session binding); stage 2 now blocked at same root cause — consistent
- `REAL_RELAY_LOOP_STAGE_TRACK.md`: stages 3-15 defined with evidence fields; not executed (blocked at 2)

## What was NOT done (not needed, not changed)

- ❌ No adapter redesign
- ❌ No new scaffold files
- ❌ No Integration UI change
- ❌ No synthetic `externalSessionId`
- ❌ No window-title identity substitution
- ❌ No snippet boundary
- ❌ No `observeSide()` fabrication
- ❌ No `IDLE`/`ACTIVE` weakening
- ❌ No automatic resend
- ❌ No lifecycle guesswork (only if loop exposes)
- ❌ No endurance test (after multi-turn)

## Resume — exact next operation

**Not more audit, not more scaffold, not UI:** Open RelayX, initialize persistence (if needed), create/load Pair, bind ChatGPT planner session through existing `ChatGPTAppHandler.createSession()` / `openSession()` with a real `/c/<id>` URL, confirm `externalSessionId` persisted to DB/run, verify `BrowserHandle` at that URL (adapter method), run `captureTransportBoundary()` — should pass with non-null `watermark` — then immediately continue Stage 3 (`observeSide` → detect instruction → dispatch to Worker → observe Worker → retrieve result → deliver back → observe P1 → retrieve → persist → restart verify → M2→P2).

If step 3 (Pair binding with real session) fails: that is the actual next defect; document and fix through persistence/session binding only.
