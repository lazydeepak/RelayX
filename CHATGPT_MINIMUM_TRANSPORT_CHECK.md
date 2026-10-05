# CHATGPT PLANNER MINIMUM RELAY TRANSPORT — NARROW VERIFICATION
Date: 2026-10-04. Scope: ONLY the 8 capabilities required for `Planner → RelayX → Worker → RelayX → Planner`. No architecture/UI changes. Evidence taken from production source (RelayEngine, providers/interfaces, ChatGPTAppHandler, ChatGPTProvider, adapters).

---

## HOW EACH OF 8 IS CURRENTLY HANDLED (production paths, with line refs)

### 1. Discover Planner state — how?
**Path:** `RelayEngine` tick / observation loop calls `provider.inspectRuntime(planner.id)` (or `findRuntime`) → `ChatGPTProvider.inspectRuntime()` (adapters.ts ~538) reads Chrome tab / AppleScript window state → returns `RuntimeInspectionResult` with `found`, `status` (`available`/`working`/`idle`), `isWorking`, `isComplete`, `lastResponseSnippet`, `evidence` (AppleScript / DOM source).
**Note:** No `observeSide()` call possible for planner (line 4251: `typeof provider.observeSide !== 'function'`). Planner state = `inspectRuntime()` only.
**Evidence source:** `macos_system_events` + Chrome DOM / tab URL / window title.
**Persisted:** `runtime.lastEvidence`, `sideIdentities` if observed (but planner never reaches observeSide — always LEVEL 0 with reason "Provider exposes no observation capability").

### 2. Retrieve Planner's completed instruction — how?
**Path A (live loop — worker -> planner):** After worker completes, `attemptPlannerDelivery()` (RelayEngine 3248) sends result TO planner via `provider.deliverInstruction()`. There is NO separate "retrieve planner completed message" step in the loop — the planner's response to that delivered result is expected to be the next planner turn, which the loop detects via `inspectRuntime()` (`lastResponseSnippet`, `isComplete`).
**Path B (offline / resume):** `RelayEngine` ~5545 (`inspection.lastResponseSnippet ?? 'Worker completed output...'`). This reads the snippet already in the provider's `inspectRuntime()` result — not a separate transcript read.
**Path C (transcript read — NOT USED FOR PLANNER):** `readExactSessionTurnsForReconciliation()` exists on `OpenCodeProvider` (adapters 3577) but NOT on `ChatGPTProvider`. RelayEngine uses `readExactSessionTurnsForReconciliation()` ONLY for worker (line 3072 — `worker.externalSessionId`), never for planner.
**Conclusion:** Planner's completed message is retrieved ONLY as a snippet from `inspectRuntime()`. There is NO message-id-based transcript retrieval for planner.

### 3. Distinguish newly completed from previously processed — how?
**Path:** `inspectRuntime()` returns `lastResponseSnippet`. RelayEngine stores `lastResponseSnippet` in `RuntimeInspectionResult`; compares across ticks? The engine compares `inspection.isComplete` / `inspection.isWorking`; for worker it also uses `transcriptEvidence` (message-id / finish / createdAt from transcript). For planner: snippet comparison only — no ordinal, no message-id, no `createdAt` comparison in planner path.
**Persisted watermark for planner:** `preDispatchWatermark` (line 1080-1097) — but provider `captureTransportBoundary` not available → `{watermark: null, failure: 'Provider exposes no transport-boundary capability.'}`. No `messageIds`, `messageCount`, `latestCreatedAt` persisted for planner.
**Stale protection:** None authoritative. `sideIdentities.observeSide()` does ordinal comparison — but planner never reaches there. `inspectRuntime()` snippet has no ordering primitive.
**Evidence from audit:** `RelayEngine.observeSide()` line 4301-4318 computes `isStale = priorOrdinal !== null && nextOrdinal !== null && nextOrdinal < priorOrdinal`. For planner: both ordinals `null` (no `observeSide`), so `isStale = false`; no comparison performed — read accepted as-is. This is the correct behavior per I-7 (no invented ordering) but means no dedup.

### 4. Send Worker result back into exact Planner session — how?
**Path:** `RelayEngine.attemptPlannerDelivery()` (3248) → resolves planner `RuntimeSession` from pair (`pair.plannerSessionId`) → gets `provider = getProvider(plannerSession.providerType)` (`chatgpt`) → `provider.deliverInstruction({runtimeSessionId: planner.id, externalSessionId: plannerSession.externalSessionId || plannerSession.sessionUrl, instructionText: handoff.resultSummary, idempotencyKey: planner_delivery_...})`.
**ChatGPT app handler:** `ChatGPTAppHandler.sendMessage()` (347) → `getActiveProvider().deliverInstruction()` → `ChatGPTProvider.deliverInstruction()` (adapters 567) → AppleScript keystroke injection / Chrome DOM injection into URL-bound session.
**Exact session targeting:** Confirmed — uses `externalSessionId` (conversation URL id) or `sessionUrl`. No window-title guessing for delivery.
**Evidence of send:** `DeliveryInstructionResult` from provider (`outcome`: `delivered`/`ambiguous`/`failed` + `evidence` with `source`). For ChatGPT: `evidence.source` = AppleScript / DOM (presentation, not transcript). `outcome = 'delivered'` when AppleScript/DOM injection succeeds.

### 5. Evidence that send occurred — how?
**Path:** `deliverInstruction()` returns `DeliveryInstructionResult`; `attemptPlannerDelivery()` checks `deliveryResult.outcome === 'delivered'` (line 3274) → records `deliveryResult.evidence` to `handoff.markDeliveredToPlanner()` (line 3275); emits `planner.delivery.confirmed` event (line 3278) with `evidenceId = deliveryResult.evidence.id`; saves `handoff` to DB.
**Evidence content (ChatGPT):** `ObservableEvidence` from AppleScript/DOM injection (button visible, window title, tab URL, keystroke executed). No transcript confirmation — delivery = injection succeeded, not message persisted in session store.
**Evidence content (OpenCode — for comparison):** `ObservableEvidence` from service transcript (`source: 'reconciliation_probe'`; includes `transportClassification`, `transportReason`, `matchingUserTurnId`, `postBoundaryUserTurns`, `boundary`, `expectedFingerprint`, `matchedFingerprint`).

### 6. Correlation / watermark preventing duplicate sends — how?
**Watermark mechanism:** `preDispatchBoundary` captured before send (RelayEngine 1075-1097). For ChatGPT planner: `provider.captureTransportBoundary()` → `ChatGPTProvider` has NO method → `{watermark: null, failure: 'Provider exposes no transport-boundary capability.'}` (explicit — line 1080). `preDispatchWatermark: null` passed to `deliverInstruction()`.
**Correlation mechanism:** `reconcileDispatch()` optional (ChatGPT: NOT implemented). `readExactSessionTurnsForReconciliation()` NOT implemented for ChatGPT. `DeliveryInstructionResult.reconciliation` NOT present (ChatGPT provider does not populate). `idempotencyKey` (`planner_delivery_${handoff.id}_${Date.now()}`) provides send-level dedup against same handoff, not message-level.
**DB persistence:** `delivery` record saved (bytes: `delivery.id`, `delivery.idempotencyKey`, `delivery.status`, `delivery.confirmedAt`, `delivery.evidence`). `handoff` saved with `deliveredToPlannerEvidence`. `pair` persisted. No message-level watermark in DB for planner.
**Restart continuation:** After restart, `pair.plannerSessionId` binds to runtime; `handoff` status (`delivered` / `unverified`) tells if planner was already told; if `delivered`, loop skips resend (unless new attempt). But NO message-level "was this planner turn already processed" — only delivery-level.

### 7. Restart continuation — persisted state?
**Path:** Relays resume from DB state, not from session store.
- `repos.pairs` → `plannerSessionId`, `workerSessionId`, `status`
- `repos.runtimes` → `externalSessionId` / `sessionUrl` (planner session identity preserved)
- `repos.handoffs` → status (`ready`, `delivered`, `failed`); `deliveredToPlannerEvidence`; `resultSummary` (what was sent)
- `repos.sideIdentities` → for planner: `unobservableReading` (LEVEL 0, reason: "no observation capability"). No `message.ordinal`, `message.ref`, `message.text` persisted.
- `repos.deliveries` → delivery record for planner delivery (`idempotencyKey`, `status`, `evidence`)
- `repos.assignments` → `currentAttemptId`, `status`
**What tells RelayX which Planner message was last consumed:** NOTHING authoritative for planner. Only `handoff.resultSummary` (what RelayX sent TO planner) + `inspection.lastResponseSnippet` (last snippet read from planner window). No ordinal, no message-id, no transcript boundary.

### 8. Implemented outside ChatGPTAppHandler / Integration contract?
**Yes — and missed by audit because they sit in RelayEngine / persistence / provider adapters, not in integration types:**
- `RelayEngine.attemptPlannerDelivery()` (3248) — planner send path
- `RelayEngine.observeSide()` (4142) — observation path (shows planner = LEVEL 0, unobservable)
- `RelayEngine` handles `provider.captureTransportBoundary` absence explicitly (1080) — produces `null` watermark with documented reason
- `RelayEngine` uses `provider.readExactSessionTurnsForReconciliation()` ONLY for worker (3072), never planner
- `RelayEngine` uses `inspection.lastResponseSnippet` for planner completion / inline recovery (5547)
- `ChatGPTProvider` (adapters 1161+) — AppleScript / Chrome DOM details of `deliverInstruction()`, `inspectRuntime()`, `detectCompletionState()`, `findAllRuntimes()` (NOT in `ChatGPTAppHandler` contract)
- `BaseMacOSProvider.probeMacOSProcess()` (adapters 303) / `runAppleScript()` (257) — underlying AppleScript mechanism
- Persistence: `sideIdentities`, `runtimes`, `deliveries`, `handoffs`, `assignments`, `pairs` (all DB-backed; `SqliteRepositories`, `MemoryDatabase`)

**Audit miss:** The audit correctly noted ChatGPT `observeSide()` = absent, `captureTransportBoundary` = absent, `reconcileDispatch` = absent. It did NOT fully trace the relay's USE of those absences (RelayEngine's explicit null-handling at 1080, LEVEL-0 persistence at 4251, snippet-only planner retrieval at 5547). The relay IS designed around these gaps — not broken by them — but the design accepts presentation-only for planner.

---

## MATRIX (the one requested)

| Required Planner capability | Exists | Production path | Evidence | Persisted watermark | Gap |
|---|---|---|---|---|---|
| State discovery | YES (presentation) | `provider.inspectRuntime(planner.id)` → `ChatGPTProvider.inspectRuntime()` (AppleScript / Chrome DOM / window title) | `RuntimeInspectionResult`: `found`, `status` (`available`/`working`/`idle`), `isWorking`, `isComplete`, `lastResponseSnippet`, `evidence.source` = AppleScript/DOM | `runtime.lastEvidence`; `sideIdentities` = LEVEL 0 (`unobservableReading`, reason = no capability) | No transcript; snippet only; no ordinal; no message-id |
| Send message | YES (presentation) | `RelayEngine.attemptPlannerDelivery()` → `provider.deliverInstruction()` → `ChatGPTAppHandler.sendMessage()` → AppleScript / Chrome DOM injection into URL-bound session | `DeliveryInstructionResult`: `outcome` + `evidence` (AppleScript / DOM injection confirmation); `handoff.markDeliveredToPlanner()` | `delivery.id`; `delivery.idempotencyKey`; `handoff.deliveredToPlannerEvidence`; NO `preDispatchWatermark` (`null`) | No transcript confirmation; delivery = injection success, not persistence |
| Retrieve completed message | PARTIAL (snippet only) | `inspectRuntime().lastResponseSnippet`; NO `readExactSessionTurnsForReconciliation()` for planner (only worker uses); NO `observeSide()` | Snippet string (≤500 chars, truncated); NO `message.text`, NO `message.ordinal`, NO `message.ref` | `runtime.lastEvidence.lastResponseSnippet`; None at message level | No full message text; no message-id correlation |
| New-message detection | NO (authoritative) | `inspectRuntime()` snippet comparison across ticks; NO `observeSide()` ordinal comparison (both ordinals null → no comparison performed) | Snippet presence + `isComplete`; NO `createdAt` / ordinal / message-id comparison | `sideIdentities` = unobservable (no ordinal); `delivery.idempotencyKey` for send-level dedup only | No mechanism to distinguish "new planner turn" from "same snippet read twice" |
| Completion detection | YES (presentation) | `inspectRuntime().isComplete`; `detectCompletionState()` → snippet presence (not after-boundary transcript turn) | `isComplete: boolean`; `lastResponseSnippet`; NO `finish` (provider-reported terminator); NO `assistantTurn` identification | `runtime.lastEvidence.isComplete` | Snippet presence ≠ authoritative assistant turn after boundary; may report complete before turn actually finished |
| Delivery verification | YES (send-level) | `DeliveryInstructionResult.outcome`; `handoff.markDeliveredToPlanner()`; `planner.delivery.confirmed` event | `outcome`: `delivered`/`ambiguous`/`failed`; `evidence.id`; NO `reconciliation` (ChatGPT provider doesn't populate) | `delivery.status` (`delivered`); `handoff.status`; `delivery.evidence` | No transcript confirmation of delivered instruction; no fingerprint match; ambiguous = injection succeeded but turn not confirmed |
| Correlation / dedup | NO (message-level) | Send-level: `idempotencyKey` (`planner_delivery_${handoff.id}_${now}`) prevents duplicate SEND of same handoff; NO message-level correlation (no `expectedInstructionSnippet` / fingerprint / `matchingUserTurn`) | `idempotencyKey`; `delivery.idempotencyKey`; NO `reconciliation.matchKind`, `matchingUserTurnId`, `expectedFingerprint` | `idempotencyKey` (send-level); NO message-level watermark | Cannot prevent processing same planner response twice while loop offline; cannot correlate delivered result with planner's acknowledgment |
| Restart continuation | PARTIAL (delivery-level) | `repos.pairs` (binding); `repos.runtimes` (session URL); `repos.handoffs` (delivered/unverified + resultSummary); `repos.sideIdentities` (LEVEL 0); `repos.deliveries` (confirmed/unverified) | DB state (SQLite / Memory); `handoff.resultSummary`; `runtime.externalSessionId`; NO message ordinal / transcript boundary | Full DB state (pairs, runtimes, handoffs, deliveries, sideIdentities, assignments) | No message-level continuation; resume from "was result delivered?" not "which planner turn is new?" |

---

## WHAT THE MATRIX TELLS US (answer to user's question)

**The relay loop CAN finish with current ChatGPT transport — but only if the design accepts:**
- Planner state = presentation (`inspectRuntime()` snippet + window/button state)
- Planner send = presentation (AppleScript/DOM injection)
- Planner retrieval of completed response = snippet only (`lastResponseSnippet`)
- New-message detection = snippet-change detection (weak; no authoritative ordinal/message-id)
- Restart = delivery-level (`handoff.status` + `runtime.sessionUrl`), NOT message-level

**This is sufficient IF:**
1. The loop does NOT require authoritative message-id correlation for planner (only needs to know "planner finished responding" — snippet + `isComplete` sufficient for that).
2. The loop uses `idempotencyKey` + `handoff.status` to avoid duplicate sends (send-level dedup, not message-level).
3. The loop accepts that planner's "completed message" is a snippet, not a full transcript turn — and designs handoff creation / continuation around snippet-based evidence (current design does this: `lastResponseSnippet` used for `handoff.markReady()` at 3157, 5547).

**This is INSUFFICIENT IF:**
- The loop requires message-id-based correlation between delivered result and planner's acknowledgment (e.g., "did planner receive turn N and respond with turn N+1"). ChatGPT has no such mechanism.
- The loop requires authoritative "new turn" detection after restart — snippet comparison alone can miss or misidentify.
- The loop requires transcript-level reconciliation for planner (like OpenCode's `reconcileTransportOutcome()` with fingerprint). Not available.

**The blocker is NOT "ChatGPT missing capabilities." The blocker is "relay loop design must match ChatGPT's presentation-only contract, not assume OpenCode-grade boundary/reconciliation for planner."**

---

## WHAT TO FIX BEFORE ANY UI CHANGE (direct answer)

Per user's instruction: determine what exists / hidden / genuinely missing.

| Status | Item | Evidence |
|---|---|---|
| EXISTS | `inspectRuntime()` / state discovery | `ChatGPTProvider.inspectRuntime()` (adapters); `RelayEngine` uses at 611, 3023, 3593 |
| EXISTS | `deliverInstruction()` / send | `ChatGPTAppHandler.sendMessage()`; `RelayEngine.attemptPlannerDelivery()` 3267 |
| EXISTS | `lastResponseSnippet` / retrieve | `RuntimeInspectionResult` field; used at 3068, 5547 |
| EXISTS | `isComplete` / `isWorking` / completion | `detectCompletionState()` (adapters 621); `inspectRuntime()` (adapters 538) |
| EXISTS | Send-level dedup (`idempotencyKey`) | `delivery.idempotencyKey`; `handoff` DB state |
| EXISTS | DB-persisted restart state | `repos.pairs`, `runtimes`, `handoffs`, `deliveries`, `sideIdentities`, `assignments` |
| HIDDEN (from Integration contract, present in adapter/relay) | AppleScript/DOM mechanism details | `BaseMacOSProvider.runAppleScript()`; `ChatGPTProvider` private methods |
| HIDDEN | Explicit null-handling for missing planner boundary | `RelayEngine` 1080; `observeSide()` 4251 (LEVEL 0 persistence) |
| HIDDEN | Worker-only transcript reconciliation (not planner) | `RelayEngine` 3072 (`readExactSessionTurnsForReconciliation()` called only for `worker.externalSessionId`) |
| GENUINELY MISSING (for planner) | `observeSide()` (message ordinal / text / ref / role read) | `ChatGPTProvider` has no method; `RelayEngine` reports LEVEL 0 |
| GENUINELY MISSING | `captureTransportBoundary()` (pre-send message-id set) | `ChatGPTProvider` has no method; `RelayEngine` passes `null` |
| GENUINELY MISSING | `readExactSessionTurnsForReconciliation()` (post-send transcript) | `ChatGPTProvider` has no method; `RelayEngine` skips for planner |
| GENUINELY MISSING | `reconcileDispatch()` / fingerprint matching | `ChatGPTProvider` has no method; `DeliveryInstructionResult.reconciliation` absent |
| GENUINELY MISSING | Message-level new-turn detection (ordinal-based) | `observeSide()` absent; only snippet comparison available |
| GENUINELY MISSING | Full transcript response retrieval (not snippet) | Only `inspectRuntime().lastResponseSnippet`; no bounded message list |

---

## DECISION (per user's instruction)

> If these already exist elsewhere → align Integration contract with real implementation.
> If they genuinely do not exist → that is our immediate relay blocker.

**Answer: Both.**
- The 8 capabilities EXIST at presentation level (the relay loop uses them: `inspectRuntime`, `deliverInstruction`, `lastResponseSnippet`, `isComplete`, DB state, `idempotencyKey`). These are NOT missing — they are implemented outside `ChatGPTAppHandler` (in adapter + RelayEngine + DB).
- The AUTHORITATIVE versions (boundary, transcript reconciliation, observeSide, fingerprint correlation) are GENUINELY MISSING for planner. The relay handles this explicitly (`null` boundary, LEVEL 0 observation, snippet-only retrieval, no `reconcileDispatch`). This is by design, not a defect to fix at integration layer.

**Immediate blocker (if relay expects authoritative planner transport):** The loop's design must be adjusted to accept presentation-only for planner. If the loop ALREADY accepts presentation-only (current code at RelayEngine 3068, 5547 suggests yes — snippet-based handoff, snippet-based completion), then NO blocker — proceed.

**If the loop requires authoritative planner correlation / boundary / transcript:** Blocker is real. Fix direction: NOT to add service/DB to ChatGPT (impossible — ChatGPT is browser-based, no session store accessible to RelayX), but to either (a) use Chrome DOM / AppleScript for message extraction at message-id level (new adapter method, not integration change), or (b) redesign loop to not require authoritative planner transcript (current design appears to do this).

---
File: `/Users/lazydeepak/dev/RelayX/CHATGPT_MINIMUM_TRANSPORT_CHECK.md`
Verified against: `src/relay/application/RelayEngine.ts` (3248, 4142, 1080, 3072, 4251, 5547), `src/relay/providers/interfaces.ts`, `src/relay/integrations/handlers/ChatGPTAppHandler.ts`, `src/relay/providers/adapters.ts` (ChatGPTProvider 1161-3034), `src/relay/providers/chatgptProjectUrl.ts`, `src/relay/providers/chatgptProjectDiscovery.ts`.
