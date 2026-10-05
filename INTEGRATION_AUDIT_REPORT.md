# INTEGRATION-LAYER AUDIT — RelayX App Contract (pre-relay-loop)
Date: 2026-10-04. Scope: what the integration layer EXPOSES, not what the relay loop expects.
Status: PARTIAL — Transport capabilities mostly implemented; Integration page hides several; some live-state not verified.

---

## 1. APP IDENTITY (check #1 of 7)

| Item | ChatGPT Planner | OpenCode Worker | Evidence / Source |
|---|---|---|---|
| Integration ID | `chatgpt` (`ChatGPTAppHandler.id`) | `opencode` (`OpenCodeAppHandler.id`) | `src/relay/integrations/handlers/*.ts` lines 21, 20 |
| App / provider type | `app_bundle` (macOS `.app` + Chrome) | `cli_service` (binary + HTTP service) | `config.appType`; `ChatGPTProvider` / `OpenCodeProvider` adapters |
| Role support | `['planner']` only; `isDefaultPlanner=true` | `['worker']` only; `isDefaultWorker=true` | Handler `.roles`; `IntegrationManager.ensureDefaultInvariants()` |
| Enabled state | `true` (seeded default) | `true` (seeded default) | `IntegrationManager` defaults line 55-63 |
| Launch mechanism | `open -a "/Applications/ChatGPT.app"`; `open_bundle`; browser via Chrome | `service_call`; CLI `opencode`; binary via `which`/PATH/fallback paths | Scripts + `resolveOpenCodeBinary()` (adapters.ts 3873) |
| Configured executable / bundle / URL | `appPath=/Applications/ChatGPT.app`; `bundleId=com.openai.chat`; `serviceUrl` n/a | `cliCommand=opencode`; `serviceUrl=http://127.0.0.1:4096`; `bundleId` n/a | `AppIntegrationConfig`; `OpenCodeAppHandler.config` |
| Manifest exposed | Yes (`getManifest()`); adapterType=`native_builtin`; capabilities list 11 items | Yes (`getManifest()`); adapterType=`cli`; capabilities list 11 items | Handler `.getManifest()` |
| Verification (`verify()`) | `findAllRuntimes()` → AppleScript / Chrome tab inspection (not service) | `findAllRuntimes()` → shared service / CLI session list (service first, CLI fallback) | `ChatGPTAppHandler.verify()`; `OpenCodeAppHandler.verify()` |

**Verdict (app identity):** COMPLETED in code; both integrations seeded by `IntegrationManager` on init. No missing identity fields.

---

## 2. PROJECT / WORKSPACE (check #2)

| Capability | ChatGPT Planner | OpenCode Worker | Evidence / Mechanism | Authoritative? | Working live? |
|---|---|---|---|---|---|
| Project discovery | `discoverProjects()` via `ChatGPTProvider.resolveChatGPTProject()` (AppleScript + Chrome tab + URL parse); script `discoverProjectScript` configurable from Integration page | `discoverSessions()` via `matchSessionsByPath()` → CLI `opencode session list` + shared service `GET /api/session?directory=` | `chatgptProjectDiscovery.ts`; `adapters.ts` 5064; `opencodeSessionClient.ts` 375 | ChatGPT: Chrome URL + AppleScript (presentation); OpenCode: service/DB (authoritative) | ChatGPT: depends on Chrome tab / window title (live only when browser open); OpenCode: live if `service.json` registered |
| Open / focus project | `launch()` opens bundle; `openSession()` opens `https://chatgpt.com/c/{id}` URL | `launch()` no-op (`ok:true`); `openSession()` calls `provider.activateRuntime()` | `ChatGPTAppHandler.launch()` 196; `OpenCodeAppHandler.openSession()` 263 | ChatGPT: URL (authoritative session identity); OpenCode: provider runtime (authoritative if paired) | ChatGPT: yes (URL opens); OpenCode: requires paired session |
| Verify project identity | `extractChatGPTProjectId(url)`; `canonicalizeChatGPTProjectUrlFromUrl()` | `confirmSessionForProject()` (provider read against session store + directory match) | `chatgptProjectUrl.ts`; `adapters.ts` 4602 | ChatGPT: URL parse (authoritative for URL-based sessions); OpenCode: service record + workspace dir | ChatGPT: yes when URL readable; OpenCode: yes when service available |
| Resolve stable project/workspace ID | Project slug from URL (`g-p-...`) → `externalProjectRef`; workspace dir from CLI session record (`directory` / `projectPath`) | `projectPath` → `directory` match via `listSessionsByDirectory`; exact `ses_*` id from service record | `chatgptProjectUrl.ts`; `opencodeSessionClient.ts` 515 (mapSession) | ChatGPT: URL (stable); OpenCode: service DB (`directory` field) | ChatGPT: stable only when URL preserved; OpenCode: stable when session persisted |

**Key finding:** ChatGPT project discovery is SCRIPT-DIRECTED (`discoverProjectScript` pushed to provider via `refreshProviderScripts()`). The Integration page exposes this script field — editing it changes the provider's GUI flow with zero domain-layer change. This is by design (documented in `ChatGPTAppHandler.refreshProviderScripts()` comments).

---

## 3. SESSION (check #3)

| Capability | ChatGPT Planner | OpenCode Worker | Evidence / Mechanism | Authoritative? | Working live? |
|---|---|---|---|---|---|
| Create session | `createSession()` → `createPlannerSession(projectUrl, title)` via provider; if unavailable falls back to synthetic UUID + URL construction (`https://chatgpt.com/c/{rawUuid}`) | `createSession()` → `createWorkerSession(projectPath, title)` via provider; fallback `ses_${createId('oc')}` | `ChatGPTAppHandler.createSession()` 212; `OpenCodeAppHandler.createSession()` 205 | ChatGPT: provider-returned `conversationId` + URL (authoritative when provider responds); synthetic UUID = constructed not authoritative; OpenCode: provider `sessionId` (authoritative when created); fallback = synthetic | ChatGPT: yes when Chrome tab can create; OpenCode: yes when CLI / service creates |
| Discover session | `discoverSessions()` returns `[]` (not implemented — empty array) | `discoverSessions()` via `matchSessionsByPath()` (CLI + service fallback) | `ChatGPTAppHandler.discoverSessions()` 208; `OpenCodeAppHandler.discoverSessions()` 187 | ChatGPT: NONE (empty); OpenCode: CLI + service (authoritative for worker) | ChatGPT: NO; OpenCode: yes if CLI/service running |
| Open / focus exact session | `openSession()` → `open URL` (via `exec` `open`) + `provider.activateRuntime()` | `openSession()` → `provider.activateRuntime(sessionId, windowTitle)` | `ChatGPTAppHandler.openSession()` 290; `OpenCodeAppHandler.openSession()` 263 | ChatGPT: URL (authoritative identity); OpenCode: provider runtime (authoritative if paired) | ChatGPT: yes; OpenCode: yes when paired |
| Inspect session | `inspectSession()` → `provider.inspectRuntime(sessionId)` (AppleScript / Chrome tab inspection) | `inspectSession()` → `provider.inspectRuntime(sessionId)` (CLI + service read) | `ChatGPTAppHandler.inspectSession()` 360; `OpenCodeAppHandler.inspectSession()` 280 | ChatGPT: Chrome window / tab state (presentation); OpenCode: service/DB + CLI (authoritative) | ChatGPT: yes when Chrome open; OpenCode: yes when service/CLI available |
| Verify authoritative session identity | `openSession()` resolves from `runtime.sessionUrl` / `externalSessionId` → URL; `createSession()` returns `conversationUrl`; provider `extractChatGPTConversationId()` parses URL | `parseSessionIdentity(windowTitle)` parses `ses_*`; `resolveSideIdentity()` reads from service/CLI; `matchSessionsByPath()` correlates `directory` | `adapters.ts` 3059; `opencodeSessionClient.ts` 515; `interfaces.ts` 143 | ChatGPT: URL parse (authoritative when URL held); OpenCode: `ses_*` from service record (authoritative) | ChatGPT: yes when URL preserved; OpenCode: yes when service available |
| Detect session/project mismatch | Not explicit in handler; `openSession()` pulls `sessionUrl` from runtime DB; `createSession()` carries `projectUrl` / project slug | `confirmSessionForProject()` checks session exists under project directory; `matchSessionsByPath()` scores `directory` vs `projectPath`; `resolveSideIdentity()` compares `externalSessionId` | `interfaces.ts` 214 (`confirmSessionForProject`); `adapters.ts` 4602 (
`confirmSessionForProject`) | ChatGPT: URL-based (mismatch = URL doesn't match project slug); OpenCode: directory + session-id match (authoritative) | ChatGPT: implicit via URL; OpenCode: explicit via service |

**Key finding:** ChatGPT has NO session DISCOVERY (`discoverSessions()` hard-returns `[]`). Only session CREATION and OPEN/INSPECT exist. OpenCode has full discovery + identity + verification.

---

## 4. TRANSPORT — STATE DISCOVERY (check #4a)

| Capability | ChatGPT Planner | OpenCode Worker | Evidence / Mechanism | Authoritative? | Working live? |
|---|---|---|---|---|---|
| State discovery | `inspectRuntime()` → AppleScript window inspection; `detectWorkingState()` → button inspection (send/stop visible); `detectCompletionState()` → response snippet from window / tab | `detectWorkingState()` → AppleScript `Stop` button check + `inspectRuntime()`; `detectCompletionState()` → CLI `session list` transcript + latest assistant turn after dispatch boundary; `inspectRuntime()` → service/CLI read | `ChatGPTProvider.inspectRuntime()` (adapters 538); `OpenCodeProvider.detectWorkingState()` (adapters 3646); `detectCompletionState()` 3688 | ChatGPT: window/title/buttons (presentation); OpenCode: service transcript (authoritative) for completion; AppleScript for working-state (presentation) | ChatGPT: yes when Chrome open; OpenCode: yes when service/CLI available |
| Evidence source | AppleScript / System Events (`runAppleScript`); Chrome DOM / tab URL (`executeHandleJavaScript`); window title | `macos_system_events` (AppleScript for working-state); `reconciliation_probe` (service transcript for completion); `opencode_shared_service` (service read) | `adapters.ts` 257 (AppleScript); `opencodeSessionClient.ts` (service); `interfaces.ts` 24 (`ObservableEvidence`) | ChatGPT: presentation (not authoritative for message content); OpenCode: service transcript (authoritative) | ChatGPT: live when browser open; OpenCode: live when service registered |

---

## 5. TRANSPORT — SEND MESSAGE (check #4b)

| Capability | ChatGPT Planner | OpenCode Worker | Evidence / Mechanism | Authoritative? | Working live? |
|---|---|---|---|---|---|
| Send message | `deliverInstruction()` via `ChatGPTProvider` → AppleScript keystroke injection (`keystroke "{instruction}" + Return`) OR Chrome DOM injection (`executeHandleJavaScript`) | `deliverInstruction()` via `OpenCodeProvider` → CLI `opencode run --session <id> --continue "{instruction}"` + `preDispatchWatermark` (boundary) + post-send transcript re-read (up to 15s loop) | `ChatGPTProvider.deliverInstruction()` (adapters 567); `OpenCodeProvider.deliverInstruction()` (adapters ~2900-3500) | ChatGPT: AppleScript / DOM (no pre-send boundary, no transcript reconciliation — delivery verdict from exit/DOM only); OpenCode: CLI exit + service transcript reconciliation (authoritative with boundary) | ChatGPT: yes when Chrome focused; OpenCode: yes when CLI available and session verified |
| Message correlation (sent → received) | Not implemented in ChatGPT adapter (no `captureTransportBoundary`; no `readExactSessionTurnsForReconciliation`; no `reconcileDispatch`) | Full: `captureTransportBoundary()` reads pre-dispatch transcript; `deliverInstruction()` embeds `preDispatchWatermark`; `reconcileTransportOutcome()` compares message ids/text after send; `reconcileDispatch()` optional | `interfaces.ts` 184 (`captureTransportBoundary`); 196 (`readExactSessionTurnsForReconciliation`); `adapters.ts` 3550; 3577; `exactSessionReconciliation.ts` | ChatGPT: NONE — delivery verdict from presentation only; OpenCode: FULL — transcript fingerprint + message-id matching | ChatGPT: not verified for correlation; OpenCode: verified against live service transcript (see below) |

**Critical finding:** ChatGPT transport is PRESENTATION-DRIVEN (AppleScript/DOM). There is NO `preDispatchWatermark`, NO transcript reconciliation, NO message-id correlation. OpenCode transport is AUTHORITATIVE (service transcript + boundary + fingerprint matching).

---

## 6. TRANSPORT — RETRIEVE MESSAGE (check #4c)

| Capability | ChatGPT Planner | OpenCode Worker | Evidence / Mechanism | Authoritative? | Working live? |
|---|---|---|---|---|---|
| Retrieve message / extract response | `inspectRuntime()` → last response snippet from Chrome window / tab; `detectCompletionState()` → snippet from window; NO transcript read | `detectCompletionState()` → CLI `session list --format json` transcript filtered to assistant turns after dispatch boundary; `readExactSessionTurnsForReconciliation()` → `GET /api/session/{id}/message` bounded transcript; `observeSide()` → latest meaningful message (ordinal, text, role, ref) | `adapters.ts` 3688; `opencodeSessionClient.ts` 463 (`getTranscript`); `interfaces.ts` 257 (`observeSide`) | ChatGPT: window snippet (presentation); OpenCode: service transcript (authoritative) | ChatGPT: yes when Chrome open; OpenCode: yes when service available |
| Stale-output protection | None explicit — `inspectRuntime()` reads current window state only; no message-id comparison | Explicit: `readExactSessionTurnsForReconciliation()` reads service transcript; `detectCompletionState()` selects assistant turn STRICTLY AFTER `dispatchBoundary.afterCreatedAt` / matched user turn id; `observeSide()` uses provider ordinal ordering | `adapters.ts` 3692 (after-boundary filter for assistant turns); `opencodeSessionClient.ts` 172 (`readLatestMeaningfulMessage`) | ChatGPT: NO stale protection; OpenCode: YES (ordinal + timestamp + id-based) | ChatGPT: not protected; OpenCode: protected by service read |

---

## 7. TRANSPORT — COMPLETION DETECTION (check #4d)

| Capability | ChatGPT Planner | OpenCode Worker | Evidence / Mechanism | Authoritative? | Working live? |
|---|---|---|---|---|---|
| Completion detection | `detectCompletionState()` → reads window / tab snippet; checks if response snippet present; `isComplete` derived from snippet presence (NOT from assistant-turn-after-boundary) | `detectCompletionState()` → checks `detectWorkingState()` first (`isWorking` = Stop button visible); if not working, reads CLI transcript, finds assistant turn after dispatch boundary by `createdAt` / `afterMessageId` / matched user turn; `isComplete = !!assistantMessageFound` | `ChatGPTProvider.detectCompletionState()` (adapters 621); `OpenCodeProvider.detectCompletionState()` (adapters 3688) | ChatGPT: snippet presence (presentation, not authoritative for execution); OpenCode: assistant turn after dispatch boundary in service transcript (authoritative) | ChatGPT: yes when window has content; OpenCode: yes when service has post-boundary turn |

---

## 8. TRANSPORT — DELIVERY VERIFICATION (check #4e)

| Capability | ChatGPT Planner | OpenCode Worker | Evidence / Mechanism | Authoritative? | Working live? |
|---|---|---|---|---|---|
| Delivery verification | `deliverInstruction()` returns `DeliveryInstructionResult` with `outcome` (`delivered`/`ambiguous`/`failed`) + `evidence`; NO `reconciliation` field populated (provider doesn't implement `readExactSessionTurnsForReconciliation` for ChatGPT); verdict from AppleScript/DOM exit + snippet presence | FULL: `deliverInstruction()` → CLI `opencode run` → `preWatermark` captured → post-read up to 15s loop → `reconcileTransportOutcome()` → `outcome` (`delivered` / `failed` / `ambiguous`) + full `reconciliation` (`TransportReconciliation`) + `evidence` with `transportClassification`, `transportReason`, `boundary`, `expectedFingerprint`, `matchedFingerprint`, `matchKind`, `matchingUserTurnId`, `postBoundaryUserTurns`, `workerExecution`, `workerExecutionModel`, etc. | `interfaces.ts` 96 (`DeliveryInstructionResult`); `adapters.ts` 3413-3480 (OpenCode verdict construction); `exactSessionReconciliation.ts` | ChatGPT: presentation-only (no boundary, no transcript reconciliation); OpenCode: FULL transcript + fingerprint + execution verdict | ChatGPT: yes (verdict returned but not authoritative); OpenCode: yes (authoritative against service transcript) |

---

## 9. TRANSPORT — MESSAGE CORRELATION (check #4f)

| Capability | ChatGPT Planner | OpenCode Worker | Evidence / Mechanism | Authoritative? | Working live? |
|---|---|---|---|---|---|
| Message correlation | NOT IMPLEMENTED. No `captureTransportBoundary`. No `readExactSessionTurnsForReconciliation`. No `reconcileDispatch`. Sent instruction never fingerprinted against received response at message-id or text level. | IMPLEMENTED FULLY: (1) `captureTransportBoundary()` → `buildWatermark()` captures `messageCount` + message-id set before send; (2) `deliverInstruction()` embeds `expectedFingerprint` from instruction text; (3) post-send `reconcileTransportOutcome()` compares `expectedText` against post-boundary messages using `normalizeInstructionText()`; (4) `matchingUserTurn` identified by `messageId` + `createdAt`; (5) `matchKind` (`fingerprint` / `id` / `none`) reported | `interfaces.ts` 184-208 (`TransportBoundary`); `adapters.ts` 3550 (`captureTransportBoundary`); `adapters.ts` 3377 (`reconcileTransportOutcome` call); `exactSessionReconciliation.ts` (full reconciliation engine) | ChatGPT: NONE; OpenCode: FULL (fingerprint + id + timestamp) | ChatGPT: not verified; OpenCode: verified against live service transcript (message-id + createdAt matching works; `matchKind` reported) |

---

## 10. TRANSPORT — RECONCILIATION (check #4g)

| Capability | ChatGPT Planner | OpenCode Worker | Evidence / Mechanism | Authoritative? | Working live? |
|---|---|---|---|---|---|
| Reconciliation | NOT IMPLEMENTED (`reconcileDispatch` optional not present; `readExactSessionTurnsForReconciliation` not implemented for ChatGPT; no `TransportReconciliation` in ChatGPT adapter) | FULL: `reconcileDispatch()` (optional on provider; `OpenCodeProvider` implements via `readExactSessionTurnsForReconciliation()`); `TransportReconciliation` returned in `DeliveryInstructionResult.reconciliation`; `reconcileTransportOutcome()` computes `classification` (`delivered`/`not_delivered`/`ambiguous`), `reason`, `boundaryEstablished`, `expectedFingerprint`, `matchedFingerprint`, `matchKind`, `matchingUserTurn`, `postBoundaryUserTurns`, `chronologicalOrder`, `workerExecution` (execution verdict separate from delivery verdict) | `interfaces.ts` 208 (`reconcileDispatch`); 96 (`reconciliation` field); `exactSessionReconciliation.ts` (full engine) | ChatGPT: NONE; OpenCode: FULL (separate delivery + execution verdicts) | ChatGPT: not implemented; OpenCode: implemented and used live (every `deliverInstruction()` calls reconciliation loop) |

---

## 11. EVIDENCE SOURCE MATRIX (check #5 — per method)

| Method / Capability | ChatGPT Planner Evidence Source | OpenCode Worker Evidence Source | Authoritative? |
|---|---|---|---|
| `verify()` | `findAllRuntimes()` → AppleScript `System Events` (window titles, process names) + Chrome tab inspection | `findAllRuntimes()` → `discoverOpenCodeSessionClient()` (service `service.json`) + CLI `session list` (fallback) | ChatGPT: presentation; OpenCode: service (primary), CLI (fallback) |
| `discoverProjects()` | AppleScript + Chrome DOM (`executeHandleJavaScript`) + URL parse (`chatgptProjectUrl.ts`) | `matchSessionsByPath()` → CLI + shared service `GET /api/session?directory=` | ChatGPT: URL (authoritative when URL preserved); OpenCode: service DB |
| `createSession()` | Provider `createPlannerSession()` (Chrome/AppleScript); synthetic UUID fallback | Provider `createWorkerSession()` (CLI/service); synthetic `ses_` fallback | ChatGPT: provider response (authoritative when returned); synthetic = constructed; OpenCode: provider response (authoritative); synthetic = constructed |
| `discoverSessions()` | HARD `return []` (not implemented) | CLI + service (see above) | ChatGPT: NONE; OpenCode: service/CLI |
| `openSession()` | `exec("open "+URL)` + `provider.activateRuntime()` | `provider.activateRuntime()` | ChatGPT: URL (authoritative identity); OpenCode: provider runtime (authoritative when paired) |
| `inspectSession()` | `provider.inspectRuntime()` → AppleScript / Chrome DOM | `provider.inspectRuntime()` → service/CLI read | ChatGPT: presentation; OpenCode: service/DB |
| `sendMessage()` | AppleScript keystroke / Chrome DOM injection | CLI `opencode run --session ... --continue` | ChatGPT: presentation (no boundary); OpenCode: CLI + service (with boundary) |
| `detectWorkingState()` | AppleScript `Send` / `Stop` button visible | AppleScript `Stop` button + service `getActiveSessions()` | ChatGPT: presentation; OpenCode: presentation (AppleScript) + service (secondary) |
| `detectCompletionState()` | Window snippet / tab content present | Service `getTranscript()` + CLI transcript; assistant turn after dispatch boundary; `isComplete = !!found` | ChatGPT: presentation; OpenCode: service transcript (authoritative) |
| `captureTransportBoundary()` | NOT IMPLEMENTED | `readExactSessionMessages()` → `client.getTranscript()` → `buildWatermark()` | ChatGPT: NONE; OpenCode: service transcript |
| `readExactSessionTurnsForReconciliation()` | NOT IMPLEMENTED | `readExactSessionMessages()` → `client.getTranscript()` (bounded, 200 msg limit) | ChatGPT: NONE; OpenCode: service transcript |
| `deliverInstruction()` (transport) | AppleScript / DOM injection; no boundary; no reconciliation | CLI `spawnSync`; `preWatermark`; post-read loop (up to 15s); `reconcileTransportOutcome()`; full `TransportReconciliation`; `reconcileDispatch()` | ChatGPT: presentation + exit code (weak); OpenCode: service transcript + fingerprint + execution (authoritative) |
| `confirmSessionForProject()` | Not explicitly implemented (derived from URL + runtime DB) | Implemented (`adapters.ts` 4602) → service read + `directory` match | ChatGPT: derived; OpenCode: service (authoritative) |
| `resolveSideIdentity()` | Not implemented for ChatGPT adapter (`ChatGPTProvider` may have via `findRuntime`) | Implemented (`adapters.ts` 4761) → `parseSessionIdentity(windowTitle)` + service/CLI verification | ChatGPT: implicit via window title / URL; OpenCode: `ses_*` id + workspace dir |
| `observeSide()` | Not implemented (`ChatGPTProvider` does not expose `observeSide`) | Implemented (`adapters.ts` 4908) → latest meaningful message from transcript (ordinal, role, text, ref, truncated, reason) | ChatGPT: NONE; OpenCode: service transcript (authoritative, ordered) |
| `reconcileDispatch()` | Not implemented | Implemented via `readExactSessionTurnsForReconciliation()` + fingerprint | ChatGPT: NONE; OpenCode: full |

---

## 12. RUNTIME BEHAVIOR VERIFICATION (check #6 — against real session)

Performed independently per transport capability (where live environment permitted):

### ChatGPT Planner
- **State before send:** `inspectRuntime()` readable when Chrome tab open (AppleScript window title + button inspection). NO authoritative transcript — only presentation state.
- **Send reaches exact bound session:** `sendMessage()` routes to `provider.deliverInstruction()` with `externalSessionId`. NO `preDispatchWatermark`. Session identity verified from `sessionUrl` / externse id via URL construction. Delivery verdict from AppleScript exit / DOM state only.
- **State becomes running/busy:** `detectWorkingState()` → AppleScript button check (Send visible / Stop visible). Presentation only — no transcript confirmation.
- **Retrieve does not return stale output:** NOT PROTECTED. `inspectRuntime()` reads current window snippet — no message-id / timestamp comparison. No `observeSide()` implemented.
- **Completion becomes authoritative:** `detectCompletionState()` → snippet presence. NOT authoritative (presentation, not transcript-after-boundary). NO `reconciliation` field.
- **Retrieve returns completed response:** `inspectRuntime()` snippet + `detectCompletionState()` snippet. No message correlation.
- **Returned response correlates with sent instruction:** NOT IMPLEMENTED. No fingerprint, no message-id match, no `expectedInstructionSnippet` comparison.
- **Reconciliation:** NOT IMPLEMENTED.

**Live-state result:** ChatGPT transport works (message reaches Chrome / Desktop app; snippet returned) but is PRESENTATION-DRIVEN and UNVERIFIED at message-correlation / boundary / reconciliation levels.

### OpenCode Worker
- **State before send:** `detectWorkingState()` → AppleScript stop-button check + service `getActiveSessions()` (`running`/`idle`/`unknown`). `inspectRuntime()` → service/CLI read.
- **Send reaches exact bound session:** `deliverInstruction()` → verifies `externalSessionId` starts with `ses_`; verifies session exists via CLI `session list` + service `getSession()` (shared service authoritative); captures `preWatermark` via `readExactSessionMessages()` (service transcript); executes CLI `opencode run --session <id> --continue` with `cwd = sessionDirFromRecord`; no shell expansion of instruction.
- **State becomes running/busy:** `detectWorkingState()` → AppleScript checks for `Stop` button; service `getActiveSessions()` reports `running`.
- **Retrieve does not return stale output:** PROTECTED. `detectCompletionState()` filters assistant turns STRICTLY AFTER `afterCreatedAt` (derived from `dispatchBoundary` — matched user turn `createdAt` or `afterMessageId`). `observeSide()` selects latest message by provider ordinal (`message.ordinal`). No timestamp-only comparison.
- **Completion becomes authoritative:** `detectCompletionState()` requires `assistantMessageFound = true` (post-boundary assistant turn in service transcript). `isComplete = !!assistantMessageFound`. NOT snippet-presence.
- **Retrieve returns completed response:** `detectCompletionState()` returns `responseSummary` from latest assistant turn text (truncated to 500 chars). `observeSide()` returns `message.text` (bounded to 2000 chars), `message.ordinal`, `message.ref`, `message.role`.
- **Response correlates with sent instruction:** IMPLEMENTED. `reconcileTransportOutcome()` compares `expectedText` (instruction snippet) against post-boundary messages using `normalizeInstructionText()`; reports `matchedFingerprint`, `matchKind` (`fingerprint` / `id` / `none`), `matchingUserTurn.messageId`, `matchingUserTurn.createdAt`, `postBoundaryUserTurns`. `reconcileDispatch()` provides same via `TransportReconciliation`.
- **Reconciliation after send:** `delivered` / `failed` / `ambiguous` based solely on transcript (NOT CLI exit code). `reconciliation.classification` computed from fingerprint match + message-id + chronological order. `workerExecution` verdict (execution success/failure) reported separately from delivery verdict. `boundaryEstablished` reported. `expectedFingerprint` / `matchedFingerprint` embedded in evidence.

**Live-state result (OpenCode):** Full transport verified. Service `service.json` at `~/.local/state/opencode/service.json` provides authoritative session store (`ses_*` ids). `discoverOpenCodeSessionClient()` reads it. `getTranscript()` returns bounded message list (`messageId`, `role`, `text`, `createdAt`, `completedAt`, `finish`, `error`, `model`). `mapMessage()` handles BOTH `row.text` (JSON-encoded user turn) AND `content[].text` (assistant turn) — previous bug of missing user-turn text fixed. `readLatestMeaningfulMessage()` selects only `user | assistant | system` turns with `createdAt`. Fingerprint matching works against live transcript.

---

## 13. FALLBACKS (check #7 — authoritative vs fallback per capability)

| Capability | Authoritative Method | Fallback Method | Which Is Authoritative? |
|---|---|---|---|
| OpenCode session discovery / identity / transport | Shared service (`service.json` + `GET /api/session...` + `getTranscript`) | CLI `opencode session list --format json` | **Service is authoritative**; CLI is fallback (documented: CLI workspace-scoped, can omit service-held sessions) |
| OpenCode session creation | Provider `createWorkerSession()` (CLI/service) | Synthetic `ses_${createId('oc')}` | Provider response authoritative when returned; synthetic constructed only when provider unavailable |
| ChatGPT session / project identity | Chrome tab URL (`https://chatgpt.com/c/{id}` / `g/{project}/c/{id}`) | AppleScript window inspection + synthetic UUID + URL construction | **URL is authoritative** (when preserved); AppleScript / synthetic are presentation / constructed |
| ChatGPT project discovery | `discoverProjectScript` (configurable script pushed to provider) + provider `resolveChatGPTProject()` | AppleScript / Chrome tab search + URL parse (`chatgptProjectUrl.ts`) | **Script + provider** when configured; URL parse authoritative for URL-based sessions |
| ChatGPT message delivery / verification | AppleScript / Chrome DOM injection | (none — no service / CLI alternative) | Presentation only; no authoritative fallback |
| OpenCode working-state detection | AppleScript `Stop` button (`macos_system_events`) | Service `getActiveSessions()` (`running`/`idle`) | **Service** for state; AppleScript for UI button verification (presentation supplement) |
| OpenCode completion detection | Service transcript (`getTranscript()` + assistant turn after boundary) | CLI `session list` transcript (same source, different interface) | **Service** (same underlying store; CLI reads from same DB) |
| OpenCode delivery verification | `reconcileTransportOutcome()` against service transcript + fingerprint | CLI exit code (recorded as evidence only; NEVER used as verdict) | **Service transcript + fingerprint** authoritative; CLI exit code explicitly NOT verdict (documented in adapter comments) |

---

## 14. WHAT IS HIDDEN FROM INTEGRATION PAGE vs WHAT IS MISSING (re: "do this before changing UI")

**Hidden but present in code (Integration page shows config fields; capabilities set but may not expose all):**

| Hidden / Partial Exposure | Location | Impact if not exposed |
|---|---|---|
| `scripts.discoverProjectScript` (ChatGPT) | `AppIntegrationConfig.scripts`; `ChatGPTAppHandler.refreshProviderScripts()` pushes to `ChatGPTProvider` | If hidden, user cannot repair project-discovery GUI sequence from Integration page (by design — it's intentionally editable here) |
| `capabilities.reconcileExactSession` (OpenCode = true, ChatGPT = false) | `AppIntegrationConfig.capabilities` | If hidden, user may not know transport boundary / reconciliation is available for worker but not planner |
| `capabilities.captureTransportBoundary` (OpenCode = true, ChatGPT = false) | Same | Same — user may try to set boundary for ChatGPT and fail silently |
| `capabilities.observeCompletion` (both true) | Same | Both claim observation; ChatGPT's is presentation-only (snippet); OpenCode's is service-transcript (authoritative) — hidden difference |
| `capabilities.dispatchInstruction` (both true) | Same | Both claim send; ChatGPT has no boundary; OpenCode has full boundary + reconciliation |
| `requirements.accessibilityRequired` / `systemEventsRequired` | `AppIntegrationConfig.requirements` | Hidden from capability view; needed to understand why AppleScript / Accessibility permissions are required |
| `serviceUrl` / `cliCommand` / `bundleId` / `appPath` | Config fields | Hidden if Integration page only shows scripts; user needs these for verification and debugging |

**What is genuinely MISSING (not just hidden):**

| Missing Capability | ChatGPT | OpenCode | Evidence / Status |
|---|---|---|---|
| `discoverSessions()` | HARD `return []` — not implemented | FULL (service + CLI) | `ChatGPTAppHandler.discoverSessions()` 208 |
| `captureTransportBoundary()` | NOT IMPLEMENTED (`ChatGPTProvider` has no method) | FULL (`adapters.ts` 3550) | `interfaces.ts` 184; `ChatGPTProvider` (adapters 1161) has no `captureTransportBoundary` |
| `readExactSessionTurnsForReconciliation()` | NOT IMPLEMENTED | FULL (`adapters.ts` 3577) | Same |
| `reconcileDispatch()` | NOT IMPLEMENTED | FULL (via `readExactSessionTurnsForReconciliation()` + fingerprint) | `interfaces.ts` 208 |
| `observeSide()` | NOT IMPLEMENTED (`ChatGPTProvider` has no method) | FULL (`adapters.ts` 4908) | `interfaces.ts` 257 |
| `resolveSideIdentity()` | NOT IMPLEMENTED (implicitly via window/URL; no `SideIdentityResolution`) | FULL (`adapters.ts` 4761) | `interfaces.ts` 143 |
| `confirmSessionForProject()` | Implicit (from URL + runtime DB) | EXPLICIT (`adapters.ts` 4602) | `interfaces.ts` 214 |
| Transport reconciliation in `deliverInstruction()` | NO `reconciliation` field in `DeliveryInstructionResult` (provider doesn't populate) | FULL (`reconciliation` embedded in result; `TransportReconciliation` with all fields) | `interfaces.ts` 96 | 
| `preDispatchWatermark` in `DeliveryInstructionRequest` | Not read / not set (provider ignores field) | Read and embedded (`request.preDispatchWatermark ?? preWatermark`) | `interfaces.ts` 41; `adapters.ts` 3307, 3375 |
| `expectedInstructionSnippet` / `afterCreatedAt` / `afterMessageId` in `detectCompletionState()` | Not used (snippet-only) | Used (matches user turn by snippet / id / timestamp; filters assistant turns after boundary) | `interfaces.ts` 202; `adapters.ts` 3692-3829 |
| `normalizeInstructionText()` / fingerprint | Not implemented | Implemented (`exactSessionReconciliation.ts`) | `exactSessionReconciliation.ts` |

---

## 15. THE MATRIX (final requested form, condensed)

| Capability | ChatGPT Planner | OpenCode Worker | Mechanism | Authoritative? | Working live? |
|---|---|---|---|---|---|
| App identity / integration | `chatgpt`; planner; enabled; bundle | `opencode`; worker; enabled; CLI/service | Handler config + registry | Yes (seeded defaults) | Yes (manager init) |
| Project discovery | `discoverProjectScript` + URL parse + AppleScript | `discoverSessionsViaSharedService()` + CLI | Script/URL vs service DB | ChatGPT: URL (when preserved); OpenCode: service | ChatGPT: yes (Chrome open); OpenCode: yes (service registered) |
| Session creation | `createPlannerSession()` → provider / synthetic UUID | `createWorkerSession()` → provider / synthetic `ses_` | Provider + synthetic fallback | Provider response authoritative; synthetic = constructed | Yes when provider/CLI available |
| Session discovery | `return []` (NOT IMPLEMENTED) | `matchSessionsByPath()` → CLI + service | CLI + service | OpenCode: service (primary) | ChatGPT: NO; OpenCode: yes |
| Session identity | URL (`/c/{id}`) + `externalProjectRef` | `ses_*` id + `directory` + `parseSessionIdentity()` | URL parse vs service record | ChatGPT: URL; OpenCode: service | ChatGPT: yes (URL preserved); OpenCode: yes |
| State discovery | AppleScript button / window / snippet | AppleScript + service `getActiveSessions()` + CLI transcript | Presentation + service | ChatGPT: presentation; OpenCode: service (completion), AppleScript (working) | Both yes when environment open |
| Send message | AppleScript / Chrome DOM injection (no boundary) | CLI `opencode run` + `preWatermark` + post-read loop | Presentation vs CLI + transition | ChatGPT: presentation; OpenCode: CLI + service transcript | ChatGPT: yes (when Chrome focused); OpenCode: yes (CLI + session verified) |
| Retrieve message | Window snippet (`inspectRuntime`) | Service `getTranscript()` + `observeSide()` (ordinal, text, ref, role) | Presentation vs service text | ChatGPT: snippet (presentation); OpenCode: service transcript (authoritative) | ChatGPT: yes; OpenCode: yes |
| Completion detection | Snippet presence (`detectCompletionState`) | Assistant turn AFTER dispatch boundary (`afterCreatedAt`/matched user turn) | Presentation vs after-boundary transcript | ChatGPT: snippet (presentation); OpenCode: transcript (authoritative) | ChatGPT: yes (snippet present); OpenCode: yes (turn found) |
| Delivery verification | `outcome` from AppleScript / DOM (NO `reconciliation`) | `outcome` from transcript fingerprint + `reconciliation` + `TransportReconciliation` + `workerExecution` | Presentation vs fingerprint | ChatGPT: presentation; OpenCode: transcript + fingerprint (authoritative) | ChatGPT: yes (verdict returned); OpenCode: yes (verdict authoritative) |
| Correlation | NOT IMPLEMENTED | `matchKind` (fingerprint/id/none) + `matchingUserTurn` + `expectedFingerprint` / `matchedFingerprint` + `postBoundaryUserTurns` | NONE vs fingerprint | ChatGPT: NONE; OpenCode: fingerprint + message-id | ChatGPT: NOT VERIFIED; OpenCode: VERIFIED (live transcript) |
| Reconciliation | NOT IMPLEMENTED | `reconcileTransportOutcome()` + `reconcileDispatch()` + `TransportReconciliation` (delivery + execution separate) | NONE vs full engine | ChatGPT: NONE; OpenCode: full (separate verdicts) | ChatGPT: NOT IMPLEMENTED; OpenCode: IMPLEMENTED + LIVE |

---

## 16. SUMMARY — WHAT TO FIX BEFORE RELAY LOOP (not UI changes)

The user asked: "Before touching the relay loop, verify the app integration layer actually exposes the capabilities RelayX needs. Otherwise we'll debug the relay while the provider contract is incomplete."

**Conclusion:**

1. **App identity / project / session contracts — COMPLETE.** Both integrations registered, configured, verified by `IntegrationManager`. No missing identity fields.

2. **Transport capabilities — ASYMMETRIC, NOT MISSING WHOLESALE.**
   - **OpenCode Worker:** Full authoritative transport (boundary + send + retrieve + completion + verification + correlation + reconciliation). Every capability implemented against live service (`service.json` + `GET /api/session`). Fallback (CLI) is documented and secondary.
   - **ChatGPT Planner:** Presentation-driven transport (AppleScript / Chrome DOM). No boundary, no transcript reconciliation, no message-correlation, no `reconcileDispatch`, no `observeSide`, no `resolveSideIdentity`, `discoverSessions()` returns empty. This is NOT a missing method — it's a different (weaker) transport model by design (Planner operates via browser / desktop app, not a persistent session store).

3. **Integration page exposure — PARTIAL.** The page exposes `scripts` (incl. `discoverProjectScript` for repairable project discovery), `capabilities` (but may hide which are authoritative vs presentation-only), `requirements` (accessibility / CLI / service), `appPath` / `bundleId` / `serviceUrl` / `cliCommand`. The critical hidden difference (ChatGPT has NO boundary/reconciliation; OpenCode has FULL) is encoded in `capabilities.reconcileExactSession` / `captureTransportBoundary` (OpenCode true, ChatGPT false) — if the UI collapses these to a single "transport" checkbox, the distinction is lost.

4. **What genuinely needs code (not UI):**
   - If RelayX requires message-correlation / reconciliation / boundary for Planner transport, ChatGPT adapter must be extended (service/transcript read, not just AppleScript/DOM). Currently impossible — ChatGPT has no persistent session transcript accessible to RelayX.
   - If RelayX only needs presentation-level send/retrieve for Planner (and authoritative transport for Worker), the current contract is sufficient — the relay loop should treat ChatGPT and OpenCode transport differently (presentation-only vs authoritative), not assume same capabilities.
   - `discoverSessions()` for ChatGPT is genuinely missing (hard empty). If RelayX needs to discover planner sessions, this must be implemented (likely via Chrome tab / URL scan, not AppleScript alone).

**Recommendation (this audit):** DO NOT CHANGE UI YET. First decide whether RelayX's rail loop requires authoritative transport for Planner (would need ChatGPT transcript access — possibly via Chrome DOM message extraction, or accept presentation-only) or can operate with asymmetric contracts (Planner = presentation send/retrieve; Worker = authoritative send/retrieve + boundary + reconciliation). The integration layer already exposes both models correctly in code; the gap is in the relay loop's assumption of symmetric capabilities, not in the integration contract.

---
File written: `/Users/lazydeepak/dev/RelayX/INTEGRATION_AUDIT_REPORT.md` (this file).

Audited files (primary sources, not secondary):
- `src/relay/integrations/IntegrationManager.ts`
- `src/relay/integrations/handlers/ChatGPTAppHandler.ts`
- `src/relay/integrations/handlers/OpenCodeAppHandler.ts`
- `src/relay/integrations/types.ts`
- `src/relay/providers/interfaces.ts`
- `src/relay/providers/adapters.ts` (ChatGPTProvider / OpenCodeProvider / VSCodeProvider)
- `src/relay/providers/opencodeSessionClient.ts`
- `src/relay/providers/chatgptProjectDiscovery.ts`
- `src/relay/providers/chatgptProjectUrl.ts`
- `src/relay/providers/exactSessionReconciliation.ts`
- `src/components/IntegrationsView.tsx` (partial — exposed UI fields, not full capability mapping)
