# BOOTSTRAP / ADOPTION ATTEMPT — STOP AT LIVE BOUNDARY (per instruction 6)
Status: STOPPED HONESTLY — no live ChatGPT UI URL derivable
Updated: 2026-10-04

## Goal (per instruction)
Make a freshly provisioned real ChatGPT Planner become authoritative RelayX runtime/session.

## Transition 1 — Real `/c/<externalSessionId>` observed
Status: BLOCKED — STOP HERE (instruction 6 applies)
Evidence (this session):
- ChatGPT.app PID 19789 live (verified via ps)
- Chrome running (PID 1923 + renderers; prior evidence tab_5517 at chatgpt.com/)
- AppleScript: syntax error / no front window → CANNOT extract URL
- Window title: unavailable / "ChatGPT" only (not a URL) — per BROWSER_SESSION_IDENTITY_TRACE.md
- Session storage (~/Library/Application Support/Codex/Session Storage/): binary/unreadable (per STAGE2_BROWSER_ATTEMPT.md)
- No `/c/<conv-id>` derived from any mechanism
- DB relay.db: pairs=0, runtimes=0, sessions=0

Therefore: real conversation URL NOT OBSERVED. Per instruction 6: do NOT substitute mock / synthetic / invented / synthesized URL.

## Why the current flow left 0 pairs / 0 runtimes / 0 sessions (verified — not inferred)
Per ChatGPTAppHandler.ts 278-287: when conversationUrl not provided and provider.createPlannerSession unavailable, createSession synthesizes `https://chatgpt.com/c/${rawUuid}` (invented id — violates BROKEN_HANDOFF_FIX.md rule: "NOT invented"). The code path exists but should NOT be executed without a real URL — and it was NOT executed in this session (DB empty; no new pair created; observer.ts import only; no session persisted). The deficiency is not a code path missing; it's the live-source URL that the code expects (line 223: requires `conversationUrl?.trim()`).

Per adapters.ts 1412/1435 (openDedicatedWindowAndCaptureId / readHandleUrl): adapter ready to open/verify a real URL; nothing opens because no URL provided. Per RelayEngine.ts 1075-1080: effect = boundary = null. Per RelayEngine.ts 3261: pair.plannerSessionId missing → attemptPlannerDelivery never reached.

## What was NOT done (per instructions — do not bypass)
- ❌ No synthetic / invented `/c/<id>` used (not executed; if executed, would violate BROKEN_HANDOFF_FIX.md)
- ❌ No ChatGPT turn observation changed (observer.ts import only — not a behavior change; safe-fail preserved)
- ❌ No BrowserHandle verification bypassed (not attempted — requires URL first)
- ❌ No captureTransportBoundary called with fabricated id (adapter at 3547 requires real `externalId`; not called with fake)
- ❌ No pair/runtime/session persisted with invented values (DB unchanged)
- ❌ No mock/test substituted for missing live evidence
- ❌ No adapter weakening (safe-fail preserved at observeSide 4905; boundary null honest at 3547)

## What IS preserved (verified by re-check)
- adapter observeSide (4905): still returns unreadable when !externalSessionId — preserved
- adapter captureTransportBoundary (3547): still requires verified externalId / handle — preserved
- adapter safe-fail: no fabricated watermark, no snippet-boundary, no timestamp-only identity — preserved
- DB: unchanged; no false pair/runtime/session persisted
- test suite: 1139 pass / 0 fail (verified after observer import fix)

## Exact boundary where stopped (per instruction 6)
Transition 1 — "real `/c/<id>` observed via ChatGPT mechanism" — IMPOSSIBLE in this environment (AppleScript blocked; session storage unreadable; window title insufficient; no URL exposed by ChatGPT UI to this session). All subsequent transitions (persist session, persist runtime, bind pair, verify handle, capture boundary, deliver, observe turn) are blocked at this first gate — correctly, not by omission.

## If live ChatGPT UI becomes operable (same path as RESUME_INSTRUCTION.md / BROKEN_HANDOFF_FIX.md / STAGE3_READY_STATE.md)
Then continue from transition 1 with REAL URL from ChatGPT mechanism:
1. ChatGPTAppHandler.createSession({conversationUrl: REAL_URL_FROM_CHATGPT}) -> externalSessionId + sessionUrl
2. Persist to relay.db (SqlitePairRepository + SqliteRuntimeRepository — existing interfaces)
3. ChatGPTProvider.openDedicatedWindowAndCaptureId(url) -> BrowserHandle
4. readHandleUrl(handle) == url -> verified
5. captureTransportBoundary({externalSessionId}) -> non-null watermark (messageIds, count, latestOrdinal, capturedAt)
6. RelayEngine.dispatchAssignment -> preDispatchWatermark = real; deliverInstruction -> provider.deliverInstruction with boundary
7. observeSide -> read planner turn; attemptPlannerDelivery -> deliver to planner
8. Persist boundary + delivery evidence + observed turn to DB

Until step 1: bootstrap correctly stops here. Not a failure of design; not a failure of adapter; not hidden.
