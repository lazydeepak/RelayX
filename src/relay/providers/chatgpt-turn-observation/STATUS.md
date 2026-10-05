# ChatGPT Authoritative Transport — Implementation Status

## Completed (before any integration/relay loop change)

| # | Milestone item | Status | Evidence / file |
|---|---|---|---|
| - | Confirm mechanism (BrowserHandle + DOM, not new CLI/service/DB) | DONE | User selection confirmed; plan records it |
| - | Safety rule (fail to unknown, never fabricate; no timestamp-only identity) | DONE | Implementation-plan.md §SAFETY RULE; retrieval.ts uses hash not timestamp |
| - | Selectors defined (safe-fail; primary + fallback) | DONE | selectors.ts (DOM_SELECTOR_PRIMARY, DOM_SELECTOR_MESSAGE) |
| - | Turn identity model (session + role + ordinal + content hash; no timestamp identity) | DONE | retrieval.ts `ChatGPTTurnIdentity`; `fullContentHash` deterministic |
| - | Watermark model (count + messageIds + latestOrdinal + capturedAt) | DONE | retrieval.ts `buildWatermark()`; observer.ts `ChatGPTWatermark` |
| - | Observation result model (idle / generating / completed_new / completed_same / unknown + stale + boundary) | DONE | observer.ts `ChatGPTObserverResult`; stale requires both ordinals |
| - | Boundary result model (watermark or null + honest failure) | DONE | observer.ts `ChatGPTBoundaryResult`; never fabricated null |
| - | Transcript/retrieval model (ordered turns + honest failure) | DONE | observer.ts `ChatGPTTranscriptResult` |

## Not yet implemented (requires live ChatGPT session — next step after this file)

| # | Implementation | Blocker / needs |
|---|---|---|
| 1 | `ChatGPTProvider.observeSide()` method | DOM selectors against live Chrome tab; handle verification |
| 2 | `ChatGPTProvider.captureTransportBoundary()` method | Same DOM read; build `ChatGPTWatermark` |
| 3 | `ChatGPTProvider.readExactSessionTurnsForReconciliation()` | Post-send DOM read; filter by ordinal > boundary |
| 4 | `ChatGPTProvider.reconcileDispatch()` / fingerprint | Match expected text to user turns; match assistant to adjacent ordinal |
| 5 | `RelayEngine` pass `preDispatchWatermark` (currently null at 1080 for planner) | Only when provider method exists |
| 6 | `RelayEngine` observeSide for planner (currently LEVEL 0 at 4251) | Only when provider method exists |
| 7 | DB persistence of planner watermarks / consumed turns | Schema / repo updates (if needed beyond existing `sideIdentities` / `deliveries`) |
| 8 | Acceptance test sequence (P0 → M1 → P1 → no new → restart → M2 → P2) | Requires live ChatGPT session; cannot complete without it |

## Safety / failure-mode commitments (enforced, not aspirational)

- DOM miss / Chrome handle lost / selector miss → `state: 'unknown'`, `unknown: true`, `failureReason` set, `evidence` reports failure — NEVER `completed` or `delivered`.
- `isStale` computed ONLY when `priorOrdinal !== null && nextOrdinal !== null` (I-7, preserved from RelayEngine design at 4301). With new `ordinal` field present: comparison works; without it (before implementation): `isStale = false`, read accepted — safe, not fabricated.
- Identity: `sessionId + ordinal + fullContentHash`. No timestamp-only. Hash is deterministic from content (not from time), so same turn = same identity, different turn = different identity.
- `preDispatchWatermark`: if boundary read fails → `null`, `failure` honest, `deliverInstruction()` receives `null` (current behavior) — but now failure is documented, not silent.
- Deliver verification: after injection, observe DOM for new user turn matching sent content (fingerprint). If not found → `ambiguous`, NOT `delivered`. Only DOM-confirmed new user turn = authoritative delivery.
- Restart: load `watermark` from `sideIdentities` / `delivery` evidence (not snippet comparison). If no persisted watermark → `unknown`, not assume unconsumed.

## Next concrete step (before returning to relay loop)

Implement `observeSide()` on `ChatGPTProvider` using `executeHandleJavaScript()` / `BrowserHandle`. Use safe selectors; return `unknown` on any failure. Once that works against a live session, implement `captureTransportBoundary()`, then `readExactSessionTurnsForReconciliation()`, then verification / correlation.

No Integration UI changes. No architecture changes. Only adapter extension through existing mechanism.
