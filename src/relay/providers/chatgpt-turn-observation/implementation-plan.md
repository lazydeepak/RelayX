/**
 * ChatGPT Authoritative Transport — Implementation Plan (before code)
 *
 * OBJECTIVE: extend ChatGPTProvider through existing transport abstractions
 * (observeSide / captureTransportBoundary / readExactSessionTurns / deliverInstruction)
 * using BrowserHandle + executeHandleJavaScript() — NOT new CLI/service/DB.
 *
 * SAFETY RULE (non-negotiable, per user's instruction):
 * Any DOM read failure → unknown/unavailable. Never fabricate positive/negative evidence.
 * `isStale` requires both ordinals present (I-7). No timestamp-only comparison.
 *
 * APPROACH per mechanism confirmation (Chrome DOM via BrowserHandle):
 *
 * 1. OBSERVE (new observeSide() on ChatGPTProvider)
 *    - Resolve BrowserHandle from retained session URL / window info
 *    - executeHandleJavaScript with safe selectors (fail → unknown)
 *    - Read latest assistant message container; extract text + try id attr / ordinal
 *    - Compare to persisted watermark (if any): ordinal + hash comparison
 *    - Return: generating (no completed turn yet) | completed_new (ordinal > watermark) |
 *              completed_same (ordinal == watermark) | unknown (DOM miss / handle lost)
 *
 * 2. BOUNDARY (captureTransportBoundary())
 *    - Read current turn count + message ids / ordinals from DOM
 *    - Build ChatGPTWatermark (sessionId, count, messageIds, latestOrdinal, capturedAt)
 *    - If DOM unreadable: watermark = null, failure = honest reason
 *    - Persist via RelayEngine delivery evidence + DB
 *
 * 3. SEND (existing deliverInstruction — preserved)
 *    - Pre-dispatch: call captureTransportBoundary() to establish boundary
 *    - Pass preDispatchWatermark to deliverInstruction (currently null — fix)
 *    - After injection: verify new user turn in DOM (corresponds to sent content)
 *    - Only if verified user turn found: outcome = delivered + reconciliation evidence
 *    - If injection succeeded but DOM shows no new user turn: ambiguous (honest)
 *
 * 4. RETRIEVE / RECONCILE (readExactSessionTurnsForReconciliation())
 *    - Read DOM message containers after boundary
 *    - Select assistant turns with ordinal > boundary.latestOrdinal
 *    - Identify completed response by: ordinal + full text hash + (optional) finite-state
 *    - Return transcript + turn list + failure (honest)
 *
 * 5. CORRELATION (reconcileDispatch / fingerprint)
 *    - Expected instruction snippet fingerprinted from instructionText
 *    - Match against post-boundary user turns (DOM text comparison, not timestamp)
 *    - Assistant response matched by ordinal adjacency to matched user turn
 *    - Report matchKind (fingerprint / ordinal / unknown), matchingUserTurn, boundary
 *
 * 6. PERSISTENCE (DB + RelayEngine)
 *    - Watermark persisted to delivery evidence + sideIdentities (if observeSide succeeds)
 *    - Consumed turn identity persisted (last ordinal + hash + sessionId)
 *    - Restart: load from DB, not snippet comparison
 *
 * SELECTORS (safe, must not crash if miss):
 * - Primary: message containers with data-testid / role attribute
 * - Fallback: message text extraction from visible DOM (if selectors miss, fail to unknown)
 * - Never assume message exists = complete; only ordinal + text + boundary = complete
 *
 * TEST SEQUENCE (per acceptance test):
 * P0 = existing completed turn → capture → send M1 → verify new user turn M1 → observe generating → observe P1 after boundary → retrieve full P1 → persist consumed → poll → no new → restart → P1 not re-consumed → send M2 → P2 distinct → done.
 */
