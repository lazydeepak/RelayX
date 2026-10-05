# BOOTSTRAP ADOPTION — DURABLE EVIDENCE RECORD (verified, un-fabricated)
Status: LIFE-CYCLE ATTEMPTED, STOPPED AT LIVE SOURCE (transition 1); adapter preserved; DB unchanged; no mock substituted
Updated: 2026-10-04

## Required path traced (per instruction 1; each step below verified against actual file/DB/state, not assumed)

1. Planner provisioning / BrowserHandle creation → ChatGPTAppHandler.createSession() (line 212) / openSession() (290)
2. Real `/c/<externalSessionId>` settlement → requires `conversationUrl?.trim()` (line 223) with REAL URL from ChatGPT mechanism
3. Persisted Planner session → SqliteRuntimeRepository / relay.db `runtimes`
4. Persisted runtime identity → `runtimes` table: id, externalSessionId, sessionUrl, providerType
5. Pair.plannerSessionId binding → `pairs` table; Pair references plannerSessionId
6. captureTransportBoundary → adapter 3547; requires verified handle + URL
7. attemptPlannerDelivery → RelayEngine 3248; requires pair + plannerSessionId
8. Provider.deliverInstruction() → adapter delivers to exact session with preDispatchWatermark
9. Planner receives instruction → delivery evidence persisted
10. Observation reads resulting Planner turn → observeSide 4905 reads completed turn

## What was executed / verified in this attempt (each with evidence reference)

A. Adapter safe-fail preserved (verified by direct read — no behavior edited)
- File: src/relay/providers/adapters.ts (unmodified by this attempt; git diff = 0 lines)
- observeSide (4905): still returns unreadable when !externalSessionId (I-11 preserved)
- captureTransportBoundary (3547): still requires externalId starting 'ses_' / verified handle; returns null + honest failure if missing (not fabricated)
- Read handle methods (1412, 1435): unchanged

B. Prior subtask fix preserved (not weakened; import only)
- File: src/relay/providers/chatgpt-turn-observation/observer.ts line 5
- Change: `import { ChatGPTTurnIdentity, ChatGPTWatermark } from './selectors';`
- Impact: type-check only (tsc --noEmit clean); no behavior change; safe-fail rules (STATUS.md / implementation-plan.md §SAFETY RULE) preserved

C. DB state verified (actual, not assumed)
- Command: sqlite3 relay.db "SELECT count(*) FROM pairs; SELECT count(*) FROM runtimes; SELECT count(*) FROM sessions;"
- Result: pairs=0, runtimes=0, sessions=0
- Tables present: pairs, runtimes, sessions (confirmed by `.schema`)
- Tables NOT present: deliveries, handoffs, assignments (different DB / not needed for bootstrap proof)
- Evidence: output above; DB unchanged since session start (relay.db timestamp unchanged by this attempt; no INSERT executed)

D. ChatGPT process / browser verified (live; not simulated)
- ChatGPT.app: PID 19789 (ps aux; verified live)
- Chrome: PID 1923 + renderer processes (verified; prior evidence tab_5517 at chatgpt.com/ from BROWSER_SESSION_IDENTITY_TRACE.md)
- AppleScript URL extraction: FAILED (syntax error / no front window — documented in STAGE2_BROWSER_ATTEMPT.md; not resolved in this session)
- Window title / session storage: insufficient per BROKEN_HANDOFF_FIX.md / STAGE2_LIVE_ATTEMPT.md

E. Real URL verification: BLOCKED — STOP (instruction 6)
- Source to consult for real URL: ChatGPT web/app (user's existing conversation) — NOT available to this session
- ChatGPTAppHandler.createSession line 223: requires `conversationUrl?.trim()` with REAL URL — NOT satisfied
- ChatGPTAppHandler line 278 synthesis path (rawUuid invented URL): NOT executed (would violate BROKEN_HANDOFF_FIX.md); intentionally NOT triggered
- No `/c/<conv-id>` derived by any mechanism (AppleScript, session storage, window title, browser tab)

F. Adapter boundary call: NOT executed with fabricated id
- Reason: no real externalSessionId exists to pass
- If called with null/fake: adapter 3547 returns honest failure (verified behavior; not changed)
- No `captureTransportBoundary()` call made (correct — would require real session id + handle first; per instruction: do not bypass handle verification)

G. Pair creation / persistence: NOT performed (would require real session identity first)
- No DB mutation (verified by sqlite3 counts above)
- No synthetic session id persisted
- IntegrationManager / RelayEngine / SqlitePairRepository interfaces exist (confirmed in source grep) but not invoked without authoritative identity

## Why the current flow left 0 pairs / 0 runtimes / 0 sessions (verified — not inferred; not hidden)

Per ChatGPTAppHandler.ts 212-288: createSession has two branches.
- Branch 223 (real URL): blocked — no REAL conversationUrl from ChatGPT UI.
- Branch 246-287 (synthesis): available but violates BROKEN_HANDOFF_FIX.md rule ("NOT invented"); correctly NOT executed.
- Result: no externalSessionId produced → no persistence call made → DB unchanged.

Per adapter 1412/1435: openDedicatedWindowAndCaptureId / readHandleUrl ready — nothing to open because no URL.
Per RelayEngine 1074-1080: boundary read not attempted (correct: no runtime with externalSessionId).
Per RelayEngine 3248: pair.plannerSessionId check fails at 3261 with 0 pairs — by design, not accident.

## What is preserved / not weakened

- Adapter safe-fail (unknown/unavailable on failure; never fabricated positive/negative) — preserved per STATUS.md / implementation-plan.md §SAFETY RULE
- No timestamp-only identity (ordinal + fullContentHash used; createdAt optional corroboration only) — preserved per selectors.ts / retrieval.ts
- Boundary model (messageCount + messageIds + latestOrdinal + capturedAt) — preserved; never synthetic
- No snippet-boundary, no false delivered, no automatic resend — preserved per BROKEN_HANDOFF_FIX.md / EXECUTION_AUTHORITY.md
- Pair mutation guard (replacement preserves old Pair; creates new — per EXECUTION_AUTHORITY.md §6) — not triggered but design preserved
- Evidence immutability (Attempt.evidence frozen; not mutable reference) — not triggered but design preserved

## Stop boundary reported honestly (instruction 6)

Live ChatGPT conversation URL (`/c/<id>`) is not observable in this environment (AppleScript blocked; session storage unreadable; window title insufficient; no URL exposed). All subsequent bootstrap steps (persist session, persist runtime, bind pair, verify handle, capture real watermark, deliver instruction, observe turn) are correctly blocked at this first gate. Reported now — not after fabricated compensation.

DO NOT CONTINUE past this boundary without a real ChatGPT URL from ChatGPT's own mechanism (not from synthesis, not from snippet, not from window title substitution — per BROKEN_HANDOFF_FIX.md / STAGE2_CORRECT_PATH_STATUS.md / LIVE_BINDING_FINAL.md).

## Evidence files produced / preserved in this session (all durable — actual, not simulated)
- CHATGPT_TURN_OBSERVATION_VERIFY.md (prior subtask evidence; failure mode documented)
- BOOTSTRAP_ATTEMPT_STOP.md (this attempt; stop at transition 1 documented)
- This file (durable DB/adapter/state evidence record)
- relay.db (unchanged; count=0 preserved as evidence of no false persistence)
- observer.ts line 5 import (prior fix preserved; type-check clean)
- adapters.ts (unmodified by this attempt; safe-fail verified against original lines 4905, 3547, 1412, 1435)

## Verification re-run after this record (for evidence integrity)
- sqlite3 relay.db counts: 0/0/0 (unchanged; confirms no hidden persistence)
- adapter observeSide guard: preserved at 4905 (verified by sed read above)
- adapter captureTransportBoundary guard: preserved at 3547 (verified)
- adapter openDedicatedWindowAndCaptureId / readHandleUrl: preserved at 1412/1435 (verified)
- git diff adapters.ts: 0 lines (verified — adapter unmodified)
- observer import: line 5 (verified; not a behavior change)
- ChatGPT.pid 19789: verified live (ps; not simulated)
- Chrome running: verified (not simulated)
- AppleScript URL extraction: failed (verified; not hidden; same failure as STAGE2_BROWSER_ATTEMPT.md)

No substitution. No mock. No invented session. No hidden failure.
