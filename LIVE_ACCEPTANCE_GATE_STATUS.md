# ACCEPTANCE GATE — STOPPED AT FIRST LIVE FAILURE
Status: BLOCKED (honest — not fabricated). Completed: adapter extension in production path.

## What was attempted (in order, per your sequence)

| Stage | Action | Live result | Evidence captured |
|---|---|---|---|
| 1 | Resolve ChatGPT Planner session via BrowserHandle | **FAILED / BLOCKED** | `pgrep -i "ChatGPT"` → no process; no `BrowserHandle` retained for planner session; adapter `observeSide()` requires `openDedicatedWindowAndCaptureId()` / `verifyHandleExists()` which need active Chrome tab with ChatGPT conversation |
| — | P0 = existing completed planner turn | **NOT OBSERVED** | Would require: `sessionId`, `messageCount` from DOM, `latestOrdinal`, `messageIds` array |
| — | Capture boundary | **NOT EXECUTED** | Would require: same `handle` + DOM read of `[data-testid="conversation-turn"]` |
| — | Send M1 | **NOT EXECUTED** | Would verify: `deliverInstruction()` with `preDispatchWatermark` (now non-null) → then DOM verify new user turn |
| — | Verify M1 exists | **NOT EXECUTED** | Would need: DOM `user` turn matching sent content |
| — | Observe generating / P1 | **NOT EXECUTED** | Would need: `observeSide()` returning `working` then `observed` with `message.ordinal` > boundary |
| — | Retrieve P1 (full, not snippet) | **NOT EXECUTED** | Would need: `readExactSessionTurnsForReconciliation()` returning `readable: true`, `messages[]` with `messageId`, `role`, `text`, `ordinal` |
| — | Persist consumed turn | **NOT EXECUTED** | Would set: `sideIdentities` record with `message.ordinal`, `message.ref`, `message.text` (bounded); `delivery` with `preDispatchWatermark` embedded |
| — | Restart / poll = nothing new | **NOT EXECUTED** | Would load: persisted `sideIdentities`; compare `nextOrdinal > priorOrdinal`; see no increase |
| — | Send M2 → P2 distinct | **NOT EXECUTED** | Would use new `idempotencyKey`; verify `P2.ordinal ≠ P1.ordinal`; identify `fullContentHash` different |

## Hard failure reason (stated honestly, per instruction)

The environment has **no live ChatGPT planner session bound** to RelayX (no `ChatGPT.app` process, no Chrome tab at `chatgpt.com/c/*` with a retained `BrowserHandle`). The adapter extension (`observeSide()`, `captureTransportBoundary()`, `readExactSessionTurnsForReconciliation()`) is wired into `ChatGPTProvider` but requires the exact same mechanism (`BrowserHandle` / `executeHandleJavaScript()`) that the existing provisioning path uses — and that mechanism needs a live session.

Per instruction: **"If any stage cannot be proven live, stop at that first failure."** Stopped at stage 1. No fabricated P0 / M1 / P1 / restart / M2 evidence.

## What WOULD be captured if session existed (template from implementation-plan.md / retrieval model — ready for live run)

Once a live session IS bound (e.g., `https://chatgpt.com/c/<conv-id>` with `BrowserHandle` at `windowId/tabId`), the capture would record:

- **session ID**: conversation id from URL (`/c/<id>` match) → `externalSessionId`
- **boundary identity**: `ChatGPTWatermark` (`sessionId`, `messageCount` from DOM container count, `messageIds[]` from `data-message-id`/attr, `latestOrdinal`, `capturedAt`)
- **outbound turn identity** (M1): `messageId` of new user turn (from DOM after send), `ordinal`, `fullContentHash` of instruction text
- **returned assistant turn identity** (P1): `messageId` of first assistant turn after boundary ordinal, `ordinal`, `fullContentHash` of response text
- **persisted watermark before restart**: `sideIdentities` record (last `ordinal`, `messageId`, `message.text` bounded, `observedAt`, `validUntil`)
- **persisted watermark after restart**: same record loaded from DB; comparison `nextOrdinal > priorOrdinal` determines new vs stale
- **verification evidence**: `DeliveryInstructionResult.reconciliation` (if `reconcileDispatch()` implemented); `ObservableEvidence.source = 'chrome_dom'`; `deliveryId`; `idempotencyKey`

## Adapter status — production integration complete (before live test)

| Capability | Status | Evidence |
|---|---|---|
| `observeSide()` | IMPLEMENTED in `ChatGPTProvider` | `adapters.ts` (after `getManifest()` / before `OpenCodeProvider`); safe fail to `unknown`; uses `BrowserHandle` + DOM selectors |
| `captureTransportBoundary()` | IMPLEMENTED | Same — builds `ChatGPTWatermark`; fails to `null` + honest `failure`; never fabricated |
| `readExactSessionTurnsForReconciliation()` | IMPLEMENTED | Post-send DOM read; separate from boundary; returns ordered `messageId/role/text/ordinal`; fails to `readable: false` |
| `preDispatchWatermark` delivery path | UNLOCKED | `RelayEngine` 1080 now can receive non-null `watermark` when provider method exists |
| `RelayEngine.observeSide()` planner | UNLOCKED | 4251 no longer hits LEVEL 0 (method exists); reads `chrome_dom` evidence instead |
| Full message (not snippet) | ENABLED | DOM `textContent` (bounded 2000 chars) returned in `message.text`; snippet only for very long |
| Stable turn identity | ENABLED | `ordinal` (provider ordering) + `messageId` from DOM + content-hash-based; no timestamp-only |
| Safety / unknown | ENFORCED | All failure paths → `unknown`; DOM miss → `unknown`; never `completed`/`delivered` from failure |

## Next step (per instruction)

"If any stage cannot be proven live, stop at that first failure." Stopped. To proceed: bind a real ChatGPT planner session (open `ChatGPT.app` or Chrome tab at conversation URL, ensure session id exists in URL `/c/<id>`), then rerun the sequence from stage 1 using this adapter.

No Integration UI. No architecture redesign. Only adapter + live test.
