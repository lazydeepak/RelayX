# Provider Dispatch Ground Truth — Read-Only Investigation
Status: Design/investigation only (read-only). No code, DB, provider, or Plan-First modifications.
Inspected from actual repo source at commit 9146719.

---

## Files inspected (read-only)

- `src/relay/providers/interfaces.ts` — provider capability contract (`deliverInstruction`, `inspectRuntime`, `detectWorkingState`, `detectCompletionState`, `captureEvidence`, optional `confirmSessionForProject`)
- `src/relay/providers/browserProviders.ts` — simulated `BrowserChatGPTProvider`, `BrowserOpenCodeProvider`, `BrowserVSCodeProvider` (base classes; `deliverInstruction` returns simulated `ObservableEvidence` with `composerSignature`, `composerCleared`, `responseActivityObserved`; no transcript/histories endpoints)
- `src/relay/providers/opencodeSessionClient.ts` — real read-only `OpenCodeSessionClient` (HTTP GET only; `getTranscript`, `getSession`, `getActiveSessions`, `listSessionsByDirectory`; no write/mutate/prompt capability; `OpenCodeMessageSummary` has `messageId`, `text`, `role`, `createdAt`; bounded by `MAX_TEXT_CHARS = 2_000` and `DEFAULT_TRANSCRIPT_LIMIT = 50`)
- `src/relay/application/RelayEngine.ts` (line 953–997) — `dispatchAssignment()` creates Delivery record, saves, executes `provider.deliverInstruction()`, confirms with `delivery.confirmDelivered()`
- `src/relay/application/RelayApiService.ts` (line 865+) — `dispatchAssignment()` wrapper; `resolveAmbiguousDelivery()` for ambiguous deliveries
- `src/relay/domain/entities.ts` (lines 392–571) — `Delivery`, `Handoff`, `Attempt` entities
- `src/relay/domain/types.ts` — `ProviderType = 'chatgpt' | 'opencode' | 'vscode' | 'generic_ui'`; `ProviderIntegrationStatus`

---

## Part 1 — Provider dispatch capability mapping

### ChatGPT (`providerType = 'chatgpt'`)

Actual implementation in repo: `BrowserChatGPTProvider` (simulated / preview only; `integrationStatus: 'partial'`).

| Question | Answer | Evidence |
|---|---|---|
| How Relay targets exact session | `externalSessionId` from parsed ChatGPT conversation URL (`chatgpt.com/g/<project>/c/<conversationId>`) — stored in `RuntimeSession.externalSessionId`; pairing validates against `project.plannerProjectUrl` (RelayApiService 377–428) | `RelayApiService.createPair()` 377–383, 407–415; `detailViewModels.buildSavedBinding()` 428–436 |
| How instruction is entered | `provider.deliverInstruction()` (simulated at browserProviders 73–94); real delivery appears to be via accessibility/UI automation (not shown in this repo's provider layer; only simulated response) | `BrowserChatGPTProvider.deliverInstruction()` returns simulated `ObservableEvidence`; no real transcript endpoint |
| How send is triggered | Engine calls `provider.deliverInstruction({ runtimeSessionId, instructionText, idempotencyKey })` at RelayEngine 976 | RelayEngine 976 |
| Pre-send evidence | `RuntimeInspectionResult`: `composerVisible`, `composerHasFocus`, `sendButtonVisible`, `windowTitle`; `deliverInstruction` creates `composerSignature: sha256_{length}` | interfaces.ts 16–31; browserProviders 73–89 |
| Post-send evidence | `DeliveryInstructionResult`: `outcome` (`delivered`/`ambiguous`/`failed`); `evidence` with `composerCleared: true`, `responseActivityObserved: true` | interfaces.ts 39–43; browserProviders 73–94 |
| Observable message IDs after send | **Not available** — simulated provider has no `getTranscript` or conversation-history endpoint | `BrowserChatGPTProvider` has no transcript method; `interfaces.ts` has no transcript method in `IRuntimeProvider` |
| Sent message content observable later | **Not available through this integration** — simulated only; real ChatGPT conversation history would require external browser/history access not implemented here | No transcript endpoint; `deliveryEvidence` only records composer state change, not message content |
| Conversation/session history inspectable | **Partially via external URL** (conversation URL known from `externalSessionId`); but RelayX cannot read message list / confirm instruction presence via this provider layer | `enumerateChatGPTConversations()` lists URLs (RelayApiService 1157–1235) but does not read message content |
| Stable message identifier exposed by provider | **Not available** — ChatGPT conversation messages have internal IDs but no provider interface exposes them to RelayX | No `messageId` field in ChatGPT-related interfaces |
| What survives Relay crash | `delivery` DB record (if saved); `attempt` record; `runtime_session` with `externalSessionId`; `project.plannerProjectUrl`; **no durable message-id link** | DB schema (SqliteDatabase); entities |

**ChatGPT capability classification: LEVEL 0 — No reliable reconciliation.**

Reason: No transcript access, no message-ID exposure, no deterministic fingerprint comparison against observable conversation content through this provider layer. Only observable evidence is composer-state change (`composerCleared`, `responseActivityObserved`) and session identity (`externalSessionId`). These prove "something was sent" but not "this specific Attempt instruction reached this session."

### OpenCode (`providerType = 'opencode'` / `vscode`)

Actual implementation: `OpenCodeSessionClient` (real HTTP GET service to shared `service.json` registered service; read-only; no mutation).

| Question | Answer | Evidence |
|---|---|---|
| How Relay targets exact session | `externalSessionId` (session ID string, e.g., `ses_*`); `directory` / `workspacePath`; `session` registered via `service.json` (opencodeSessionClient 44–48) | `opencodeSessionClient` `getSession()`, `listSessionsByDirectory()`; RelayApiService `adoptOpenCodeSession()` 1321–1350; `createOpenCodeWorkerSession()` 1352–1504 |
| How instruction is entered | Not directly shown in `opencodeSessionClient`; `provider.deliverInstruction()` on `opencode` provider is either simulated (BrowserOpenCodeProvider in browserProviders) or implemented elsewhere / via external service; `OpenCodeSessionClient` is explicitly **read-only** (line 319–320: "Only issues HTTP GET requests. No prompt/abort/...") | `opencodeSessionClient.ts` 319–320; interfaces.ts `deliverInstruction` required by all providers |
| How send is triggered | `RelayEngine.dispatchAssignment()` → `provider.deliverInstruction()` (RelayEngine 974–980) | RelayEngine 976 |
| Pre-send evidence | `RuntimeInspectionResult`: `composerVisible`, `composerHasFocus`, `sendButtonVisible`, `isComplete`; `OpenCodeActiveState`: `running`/`idle`/`unknown` | interfaces.ts 16–31; `opencodeSessionClient` `getActiveSessions()`; `getSessionStatus()` |
| Post-send evidence | `DeliveryInstructionResult`: simulated or real `evidence`; if real OpenCode service supports it, could include session-state transition; `OpenCodeSessionClient.getSession()` shows `updatedAt`, `state`, `agent`, `model`; `getTranscript()` shows messages | interfaces 39–43; `opencodeSessionClient` 438–447 (`getTranscript`) |
| Observable message IDs after send | **YES — `messageId` available in transcript** (`OpenCodeMessageSummary.messageId`, line 207) | `opencodeSessionClient.ts` 206–213 |
| Sent message content observable later | **YES — bounded `text` extract** (`OpenCodeMessageSummary.text`, up to `MAX_TEXT_CHARS = 2_000`, truncated; `truncated: boolean`) | `opencodeSessionClient` 251–252, 438–447 |
| Conversation/session history inspectable | **YES — `getTranscript()` returns message list with `messageId`, `text`, `role`, `createdAt`; bounded by `limit` (default 50) and `MAX_TEXT_CHARS`** | `getTranscript()` line 438–447; transcript bounded |
| Stable message identifier exposed | **YES — `messageId` is provider-generated per message; session-scoped** | `OpenCodeMessageSummary.messageId` (line 207) |
| What survives Relay crash | `delivery` DB record + `externalSessionId` + `sessionId` (OpenCode session id); `getTranscript()` can observe session messages after restart if session persists; `service.json` service is persistent per user | `opencodeSessionClient` reads from registered service (persistent); session records have `sessionId`, `updatedAt` |

**OpenCode capability classification: LEVEL 1 — Evidence-assisted reconciliation (not fully deterministic).**

Reason: `messageId` exists but is provider-generated, not RelayX-generated. RelayX can compare instruction fingerprint against observable `messageId` + `text` + `createdAt`, but identical instructions could produce different message IDs (each send = new message) or same message could be edited/deleted. The correlation is evidence-based, not guaranteed deterministic by RelayX alone. However, it is significantly stronger than ChatGPT (Level 0) because exact content and message identity can be observed from the same authoritative shared session.

**Could it reach LEVEL 2?** Only if RelayX can generate a deterministic correlation marker that OpenCode preserves and that can be observed deterministically (e.g., a specific instruction fingerprint combined with session identity and time that uniquely identifies one message). Given bounded transcript, truncation, and possibility of identical instructions, true deterministic correlation requires either a RelayX-generated marker preserved in message text or a provider-native correlation mechanism. Not currently available. So LEVEL 1 is correct.

---

## Part 2 — Candidate evaluation

### Candidate A — External message ID

| Provider | Available? | Notes |
|---|---|---|
| ChatGPT | **Unavailable** (through this integration) | No transcript endpoint; `externalSessionId` is conversation ID, not message ID |
| OpenCode | **Available** (`messageId` per message) | Provider-generated; session-scoped; observable via `getTranscript()`; not RelayX-controlled |

### Candidate B — Exact visible instruction text

| Provider | Reliable? | Notes |
|---|---|---|
| ChatGPT | **Low / unavailable through integration** | No transcript read; only external URL and observation evidence (`composerSignature` = length hash, not content) |
| OpenCode | **Moderate (evidence-assisted)** | `text` bounded (2,000 chars, truncated); identical prompts possible; must compare against `messageId` + `createdAt`; reliability improves with `idempotencyKey` context |

### Candidate C — Instruction fingerprint

| Provider | Internal fingerprint | Externally observable fingerprint |
|---|---|---|
| ChatGPT | Possible (hash of instruction + attempt + assignment + session) | **Not observable** — no transcript; only `composerSignature` (length-only hash in simulated evidence) |
| OpenCode | Possible | **Partially observable** — can hash observed `text` from transcript and compare; truncated text may miss distinguishing content |

**Conclusion:** Internal fingerprint useful for evidence storage; externally observable fingerprint requires transcript access (OpenCode only). ChatGPT has no external fingerprint observation path.

### Candidate D — Explicit RelayX correlation marker

| Provider | Technically reliable to insert? | Pollutes conversation? | Recoverable after restart? | Model may alter/reproduce? | Recommendation |
|---|---|---|---|---|---|
| ChatGPT | Probably (visible prompt can include text) | **Yes** — human/planner sees marker; model may reproduce in response | Only if message preserved in conversation history; no transcript access means only URL/external knowledge | **Yes** — LLM may reproduce or vary marker | Unjustified for ChatGPT (pollution + no observation) |
| OpenCode | Yes (prompt entered via same mechanism) | **Yes** — shared session is visible to human planner/worker | Recoverable via `getTranscript()` if message preserved | **Yes** — LLM may reproduce; marker value may not be unique | Optional for OpenCode if fingerprint + session + time insufficient; pollution cost must be weighed |

**Architecture preference:** Shared, natural visible sessions. Marker insertion should be avoided unless correlation is impossible without it. For ChatGPT (Level 0), marker is unjustified because even with marker, no transcript access means marker cannot be verified after restart. For OpenCode (Level 1), marker is optional — fingerprint + `messageId` + `createdAt` + session identity may be sufficient for evidence-assisted reconciliation; marker should only be used if fingerprint comparison proves ambiguous.

### Candidate E — External session state transition

| Provider | Evidence available | Correlation to specific Attempt? |
|---|---|---|
| ChatGPT | Simulated: `composerVisible`, `composerHasFocus`, `sendButtonVisible`, `isWorking`, `isComplete`, `lastResponseSnippet` | **No** — proves something happened in session; does not identify which instruction |
| OpenCode | `getActiveSessions()` shows `running`/`idle`; `getSession()` shows `state`; `getTranscript()` shows message sequence | **Partial** — message sequence + text + time can correlate to attempt; session-state change alone is insufficient |

**Conclusion:** Activity evidence alone cannot prove specific Attempt delivery; must be combined with message content / identity evidence.

### Candidate F — Provider-native history/service evidence

| Provider | Native history/service? | Read-only via RelayX? | Can establish target session + instruction + ordering? |
|---|---|---|---|
| ChatGPT | Conversation history exists on platform | **Not accessible through current RelayX provider layer** (simulated only) | No — RelayX cannot observe it |
| OpenCode | `getTranscript()` via shared service (`service.json`); session metadata (`getSession()`) | **Yes — read-only HTTP GET** to same shared service | **Yes** — `messageId` + `text` + `createdAt` + `sessionId`; bounded but authoritative for same session |

**Critical:** OpenCode read-only client explicitly observes the same `ses_*` records that the human OpenCode UI sees (line 8–16: "same persisted `ses_*` records"; "never starts a private server"). This is the correct shared-session observation path.

---

## Part 3 — Crash scenario tests (reasoning + code evidence)

### Case 1 — Crash before external send
- **State:** Durable dispatch intent (`startDelivering`) saved at 964; external send not performed.
- **Post-restart:** `delivery.status = 'delivering'`; external session has no message.
- **Can RelayX conclude "not delivered"?** **YES** — if external session evidence (OpenCode transcript / ChatGPT observation) shows no matching message and session state shows no send activity.
- **Response:** `dispatch_confirmed = false`; `dispatch_uncertain = false`; can safely resend after reconciliation.

### Case 2 — Crash during paste/composer interaction before submit
- **State:** Composer may contain instruction text; `sendButton` visible; no `confirmDelivered`.
- **External:** Instruction text may be present in composer but not submitted; or submitted but not confirmed.
- **Post-restart:** If transcript/read shows text present but no response, ambiguous.
- **Response:** `dispatch_uncertain`; require reconciliation (observe session state / message presence).

### Case 3 — Submit succeeds, crash immediately afterward
- **State:** External send complete; DB saves at 985-997 not performed (or partially performed).
- **External:** Message delivered (OpenCode `messageId` + text; ChatGPT conversation history entry; response may have started).
- **Post-restart:** Durable intent shows `delivering`; external observation shows delivery evidence.
- **Response:** Reconcile via external observation; confirm delivered if message identity matches; do NOT blindly resend.
- **Evidence needed:** OpenCode `getTranscript()` can confirm message; ChatGPT only via session identity + observation (indirect).

### Case 4 — Submit succeeds and worker/model begins responding before restart
- **OpenCode:** `getTranscript()` shows message + assistant response sequence (`messageId`, `text`, `createdAt`, `role`). Can correlate response to attempt if message identity matches.
- **ChatGPT:** Only observation evidence (`lastResponseSnippet`, `isWorking`, `isComplete`). Cannot deterministically link response to specific instruction.
- **Response:** For OpenCode — can confirm delivery; for ChatGPT — uncertain (evidence-assisted only).

### Case 5 — Exact same instruction sent previously
- **OpenCode:** If identical text sent earlier as different message, `messageId` differs; `createdAt` differs. Need correlation via session-state + fingerprint + time, not just text match.
- **ChatGPT:** No message identity; identical text could be old or new delivery; must rely on idempotency key + session observation + timing.
- **Response:** `idempotencyKey` (`idemp_{assignment.id}_att{attemptNumber}_{Date.now()}`) helps distinguish attempts but is Relay-internal; external correlation needs session + content + sequence.

### Case 6 — User manually sends something in same session during downtime
- **OpenCode:** Human message appears in transcript with `role = 'user'` and its own `messageId`; Relay observation can distinguish by comparing to expected instruction text/fingerprint.
- **ChatGPT:** Human message visible in external session; Relay only sees session identity + observation; cannot distinguish human from attempt instruction by session alone.
- **Response:** For OpenCode — fingerprint + `messageId` + sequence helps; for ChatGPT — must remain conservative (`uncertain`); never attribute unknown message to attempt.

### Case 7 — Provider app/session restarts but shared session persists
- **OpenCode:** Service (`service.json`) persists; session records (`ses_*`) persist; `getTranscript()` available after restart. Correlation survives if session `sessionId` unchanged.
- **ChatGPT:** Conversation URL (`externalSessionId`) persists; session identity survives if URL unchanged; but no message-read access means correlation limited to session-level observation.
- **Response:** OpenCode correlation survives; ChatGPT correlation remains weak.

---

## Part 4 — Provider-Specific Capability Level

| Provider | Level | Justification | Required response for uncertain dispatch |
|---|---|---|---|
| **ChatGPT** | **LEVEL 0** — No reliable reconciliation | Simulated integration; no transcript/history access via provider layer; only session identity (`externalSessionId`) + observation evidence (`composerCleared`, `responseActivityObserved`) available; cannot distinguish specific message delivery | `dispatch_uncertain`; suspend automatic resend; require human/planner reconciliation OR accept evidence-assisted but not deterministic confirmation |
| **OpenCode** | **LEVEL 1** — Evidence-assisted reconciliation | Real shared service (`opencodeSessionClient`) provides `getTranscript()` with `messageId`, `text`, `createdAt`, `role`; same authoritative session visible to user; bounded but readable; fingerprint comparison possible; identical instructions possible; message-ID provider-generated not Relay-controlled | Conservative: `dispatch_uncertain` until evidence compared; can confirm delivered if fingerprint + message identity + session match; must not blindly resend; can provide structured evidence to planner |

**No provider achieves LEVEL 2 (deterministic correlation by RelayX alone)** because:
- ChatGPT has no transcript access through this integration.
- OpenCode has transcript access but message-ID is provider-generated and instruction fingerprint is not uniquely guaranteed (truncation, identical prompts).

---

## Part 5 — Minimum Provider-Level Reconciliation Contract (Conceptual)

Keep provider-agnostic at Core; provider-specific at adapter/integration.

```text
prepareDispatchCorrelation(attempt, sessionPair, externalSessionId, instructionFingerprint?)
→ stores correlation reference (idempotencyKey + fingerprint + session + time)

observeDispatchCorrelation(attempt, sessionPair, externalSessionId)
→ provider-specific observation (ChatGPT: session state + observation snippet; OpenCode: transcript + message list + session state)

reconcileDispatch(attempt, observationResult, durableIntent)
→ provider returns one of:
    confirmed_delivered  (OpenCode: message identity + text match; ChatGPT: not deterministically achievable — treat as uncertain)
    confirmed_not_delivered (session evidence shows no matching message; session state clear)
    evidence_assisted      (OpenCode: fingerprint + sequence suggests delivery; ChatGPT: observation only)
    uncertain              (insufficient evidence; requires human/planner reconciliation)
→ Core updates delivery status accordingly; never blindly resends when uncertain
```

**Core must represent all outcomes without assuming provider capability:**
- `confirmed_delivered`
- `evidence_assisted`
- `uncertain`
- `confirmed_not_delivered`

**No provider is required to implement `confirmed_delivered` deterministically.** OpenCode can provide `evidence_assisted` / possibly `confirmed_delivered` for unique messages. ChatGPT can only provide `uncertain` / `evidence_assisted` (limited).

---

## Part 6 — Corrected Dispatch Transaction Sequence (No Implementation)

Current observed (RelayEngine 953–997):
```text
1. create Attempt (946) → save (947)
2. start attempt + assign to pair (949–951) → save pair
3. create Delivery (955) → startDelivering (962)
4. save Delivery + Assignment (964–965)
5. emit event (967)
6. external deliverInstruction (976)  ← external side effect
7. confirm + save delivery (985)
8. emit confirmation (990)
```

**Corrected conceptual sequence (from architecture §10, §23):**

```text
1. prepareAttempt() → freeze execution authority (sessionPairId, workerSessionId, externalSessionId)
2. recordDispatchIntent() → persist durable dispatch intent (idempotencyKey, correlationRef, attemptRef, sessionRef) + COMMIT
3. perform external side effect → provider.deliverInstruction()
4. observe / record outcome → provider observation / transcript read
5. confirmDispatch() / markDispatchUncertain() → persist observed outcome (delivered / ambiguous / failed / uncertain) + COMMIT
6. reconcile after restart → compare durable intent (step 2) against observable evidence (step 4/5); never assume DB = external truth
```

**Crash points explicitly addressed:**
- **Crash between 2 and 3:** Durable intent exists; external not sent; safe to restart / reconcile → `not_delivered`; resend allowed.
- **Crash between 3 and 5:** External sent; DB outcome not persisted; external evidence must be observed; if evidence confirms delivery → `delivered`; if ambiguous → `uncertain`; never blind resend.
- **Crash after 5:** Durable outcome saved; external evidence available; reconciliation confirms state.

This replaces the current sequence where DB save (4) and external send (6) are sequential but not explicitly separated as durable-intent vs observation phases.

---

## Part 7 — Small Terminology Correction (Assignment Lineage)

Current `CORE_FREEZE_CLOSURE.md` uses:
```text
A-001 / P1 → replacement → A-002 / P2 with originAssignmentId lineage
```

This is correct and does not need redesign. Clarify documentation if needed:
- Individual `Assignment` (`A-001`) = Pair-bound objective/execution assignment (durable relative to that Pair; historical identity preserved).
- `Assignment lineage` (`A-001` → `A-002` via `originAssignmentId`) = durable objective continuity across Pair replacement.
- Both concepts coexist; one is identity, the other is continuity.
- No wording change required in architecture unless current docs conflate them. `CORE_FREEZE_CLOSURE.md` already distinguishes clearly.

---

## Remaining Unknowns / Ground Truth Gaps

1. **ChatGPT transcript access** — Is there a real ChatGPT conversation-history endpoint that RelayX could use (separate from simulated browser provider)? Not available in this repo; would require provider ground truth from OpenAI / ChatGPT Desktop / browser automation layer.
2. **OpenCode transcript completeness** — `getTranscript()` is bounded (`limit` default 50, `MAX_TEXT_CHARS` 2,000). Can a very long session exceed this? Yes — truncated. Correlation of very long instructions may need full transcript access or selective fingerprint comparison.
3. **ChatGPT external correlation mechanism** — No mechanism frozen. Could use conversation URL + session identity + observation state + time; not deterministic.
4. **OpenCode `messageId` stability** — Is `messageId` stable across session restarts? Assumed yes (service record persists), but provider ground truth needed to confirm.
5. **Idempotency key external visibility** — `idempotencyKey` (`idemp_...`) is Relay-internal. Not visible in ChatGPT or OpenCode message. Not useful for external correlation unless included in instruction text (marker — see Candidate D, unjustified for ChatGPT).

---

## Final Provider Capability Summary

| Provider | Integration in Repo | Read-only observation | Transcript / history | Message ID | Correlation level | Uncertain dispatch handle |
|---|---|---|---|---|---|---|
| ChatGPT | Partial / simulated (`BrowserChatGPTProvider`) | Session identity + composer/state observation | None via provider layer | None | **LEVEL 0** (session + observation only; no message identity) | Must use `dispatch_uncertain`; human/planner reconciliation required |
| OpenCode | Real shared service (`opencodeSessionClient`, HTTP GET) | Session + transcript + message list + session state | `getTranscript()` bounded; message text + role + time | `messageId` per message | **LEVEL 1** (evidence-assisted: fingerprint + message identity + session + time; not deterministic alone) | Conservative: compare evidence; can confirm if unique; else `uncertain` |

---

## Conclusion — Is Provider Ground Truth Now Sufficient?

**Partially — but not fully closed.**

What is sufficient to begin Core implementation (with conservative design):
- Execution authority freeze (sessionPairId + workerSessionId + externalSessionId) — **sufficient**.
- Assignment↔Pair continuity — **sufficient**.
- Attempt lifecycle dimensions — **sufficient**.
- Provider capability classification — **sufficient** (Level 0 / Level 1 defined; no false Level 2 claim).
- Dispatcher sequence concept — **sufficient** (durable intent first; external after; observe; reconcile).

What remains genuinely open (must be resolved before full dispatch reconciliation works for ChatGPT):
- **ChatGPT correlation mechanism** — no transcript; only session identity + observation. Must decide: is session-identity + observation + time sufficient for evidence-assisted reconciliation, or must ChatGPT wait until transcript access is available?
- **OpenCode correlation mechanism** — fingerprint comparison against transcript is possible but needs exact comparison rules (truncation, identical text, message-ID matching).
- **Explicit correlation mechanism specification** — whether to use fingerprint + session + time (no marker) or marker insertion (pollution cost evaluated; unjustified for ChatGPT; optional for OpenCode).

**Status: CORE FREEZE CLOSED for domain authority, assignment continuity, attempt lifecycle, pair replacement.**
**Status: CORE FREEZE OPEN for dispatch correlation mechanism (provider ground truth required) — specifically ChatGPT correlation path and exact OpenCode fingerprint protocol.**

No implementation of `recordDispatchIntent()` / `confirmDispatch()` / `reconcileDispatch()` should be finalized until correlation mechanism is specified, because the mechanism determines the correlation reference stored in durable intent and the observation method used in reconciliation.
