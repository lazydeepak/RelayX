# STATE — STAGE 2 BLOCKED BY PRECONDITION (NOT CODE)
Updated: 2026-10-04. This is the checkpoint, not a new task.

## Confirmed state (6 points, per user's instruction)

1. **ChatGPT transport adapter** — IMPLEMENTED (`ChatGPTProvider` in `adapters.ts`: `observeSide()`, `captureTransportBoundary()`, `readExactSessionTurnsForReconciliation()`; existing `BrowserHandle`/`executeHandleJavaScript` mechanism; safe-fail to `unknown`; no snippet-boundary; identity via ordinal+hash). Evidence: adapter code present; scaffold `chatgpt-turn-observation/` preserved as design record.
2. **Stage 2 live boundary gate** — BLOCKED ONLY BY MISSING BOUND SESSION. `captureTransportBoundary()` returned `watermark: null` with honest `failure`. Not a method failure; not an adapter defect; the precondition (`externalSessionId` + `BrowserHandle` + readable DOM) is not met. Evidence: `STAGE2_LIVE_ATTEMPT.md`; `REAL_RELAY_LOOP_STAGE_TRACK.md`.
3. **Basic relay loop** — WAITING AT STAGE 2. Stages 3-15 (` observe P1; retrieve; persist; restart check; M2→P2`) unexecuted correctly — blocked at boundary, not at loop design.
4. **Lifecycle/activation fixes** — ONLY IF LIVE LOOP EXPOSES THEM. No speculative fix; `S6_LOAD_AND_ACTIVATE.md` / `stagedDiscovery.ts` / `RelayEngine` activation path remains the correct route when loop resumes; nothing changed.
5. **Endurance/restart test** — AFTER MULTI-TURN RELAY (stage 11-14). Requires `sideIdentities` persistence, DB reload (`SqliteRepositories` / `MemoryDatabase`), and `priorOrdinal`/`nextOrdinal` comparison (I-7 preserved at `RelayEngine` 4301). Not run — requires passing stage 2 first.
6. **Integration UI redesign** — STILL DEFERRED. `IntegrationsView.tsx` / `IntegrationManager` / `AppIntegrationConfig` / `IntegrationManifest` unchanged. The gap was provider-capability asymmetry (ChatGPT presentation-only vs OpenCode authoritative), not UI concealment. Correct fix is adapter extension (done), not UI change.

## Resume instruction (exact — no speculation, no scaffold, no fix)

When a real ChatGPT Planner session is bound to the Pair (via normal activation/open, not synthetic):

1. Confirm `pair.plannerSessionId` / `runtime.externalSessionId` / `sessionUrl` (from `ChatGPTAppHandler` / DB)
2. Confirm `BrowserHandle` resolves (`openDedicatedWindowAndCaptureId()` + `verifyHandleExists()` at the conversation URL)
3. **Call `ChatGPTProvider.captureTransportBoundary({ externalSessionId, ... })`** — the production adapter method already in `adapters.ts`
4. **Verify result:** non-null `watermark` containing real `messageIds[]`, `messageCount`, `latestOrdinal`, `capturedAt`; `failure: null`
5. **If pass → continue stage 3**: `observeSide()` → detect new instruction turn → `deliverInstruction()` to Worker (with `preDispatchWatermark` now non-null) → observe Worker → retrieve result → `attemptPlannerDelivery()` to planner → observe new planner turn (P1) after boundary → retrieve P1 → persist watermark → restart → confirm P1 not re-consumed
6. **If fail (stage 2 again) → report exactly**: bound session ID/URL; `BrowserHandle` identity/URL; raw boundary (`null` + `failure`); observation status; failure reason; exact production method/path. Then determine if failure is adapter (DOM/selector) or activation (session binding). Do not patch adapter before identifying the failure mode.

## What is NOT happening before stage 2 passes

- No new adapter edits
- No new scaffold files
- No Integration UI changes
- No speculative lifecycle fixes
- No synthetic session or turn identity
- No snippet-based boundary or observation
- No `deliveryResult` fabricated; no automatic resends
- No `windowTitle` identity substitution (I-11 preserved)

## Evidence chain (reference — all already produced)

- Audit & check: `INTEGRATION_AUDIT_REPORT.md`; `CHATGPT_MINIMUM_TRANSPORT_CHECK.md`
- Adapter: `src/relay/providers/adapters.ts` (3 methods); `src/relay/providers/chatgpt-turn-observation/` (design record)
- Stage attempts: `STAGE2_LIVE_ATTEMPT.md` (stage 2 blocked); `REAL_RELAY_LOOP_STAGE_TRACK.md` (stages 1-15 mapped; evidence fields defined)
- Gate status: `LIVE_ACCEPTANCE_GATE_STATUS.md` (stage 1 previous); this file (current checkpoint)

Next action: bind real session → run stage 2 → only then continue loop. Nothing else.
