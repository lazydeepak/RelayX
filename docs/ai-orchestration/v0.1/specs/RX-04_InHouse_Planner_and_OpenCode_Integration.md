# RX-04 — In-House Planner & OpenCode Worker Integration

**Version:** 0.1 · **Status:** Proposed integration specification · **Parent:** Architecture v0.1 §§2–3, 9, 11 · **Diagrams:** D01, D05, D06, D09

## 1. Transport architecture

The new Planner is a **RelayX-owned conversation** using a provider-neutral inference adapter. It may use the OpenAI API in a separately approved paid-capable mode, but Zero-Cost Mode requires a verified-free provider/endpoint for every inference call. The Worker is an OpenCode **server-owned session** reached through a documented HTTP/SDK interface. RelayX persists its own conversation/event history, authoritative remote session IDs, correlations and decisions. A ChatGPT Plus login does not grant generic access to OpenAI API tokens or ChatGPT web history.

**REQ-14:** Planner/Worker messages move through the new server-native/API adapters; no Chrome/DOM/AppleScript clipboard messaging is required.  
**REQ-15:** Keep legacy GUI transport independent and the disabled OpenCode CLI delivery method disabled, with neither acting as an implicit fallback.  
**REQ-16:** Worker identity uses exact external session ID; title is display metadata and can change.  
**REQ-17:** A structured Worker question resumes the same waiting question/run rather than generating a new assignment.

## 2. Boot and server lifecycle

Suggested boot routine: open RelayX database → register transport adapters → read persisted server ownership metadata → probe existing owned server → if absent, start controlled localhost-bound OpenCode server → authenticate → health probe → inspect installed server `/doc` → verify supported capabilities (session, message, question, event) → rebind by stable ID → reconcile unresolved Attempt/Delivery records → then enable dispatch. Never assume any particular OpenCode V1/V2 API response structure without comparing to the running version.

**DESIGN-11:** A server process record has `server_id`, `managed_by_relayx`, endpoint URI, auth key reference (secure store), process lifecycle, API spec/version digest, project roots, capabilities and last healthy time. A system-wide already-running server is not automatically treated as owned; use explicit adoption.

## 3. Planner context contract

Planner conversations are native RelayX records: thread ID, ordered user/assistant/tool messages, provider message or response IDs where given, project policy snapshot, task context window, decisions and summarized prior work. Long-running work uses **retrieval from persisted context**; never rely on unbounded model context. Context compaction should preserve system invariants, user goals, active acceptance criteria, recent decisions, open incidents and verified artifacts; retain full source history for audit.

**DESIGN-12:** In a project, the Planner is the technical decision owner. The Supervisor's planning proposals become *requests* to the Planner, not privileged commands. Planner replies are structured proposals that the Engine validates; no raw SQL or unrestricted provider key is exposed to the model.

## 4. Server-native dispatch and correlation

For each send: persist (assignment_id, attempt_id, exact_session_id, model_route_id, payload digest, policy version, pre-send provider boundary, dispatch_key). Dispatch exactly once. Record HTTP acceptance separately from provider-persisted message and Worker task completion. Correlate completion events/messages with run/session and bounded message positions. Use an explicit timeout state rather than treating network loss as a deterministic send failure.

**DESIGN-13:** Provider callbacks/events are append-only observations; deduplicate by provider event ID or deterministic composite key. For restarted connections, fetch authoritative session messages/events to bridge missed event-stream intervals. Event ordering across network reconnections may vary; use provider ordering guarantees only where documented.

## 5. Question-tool round trip

When OpenCode emits a question request: persist the exact question/correlation ID, Worker run ID, session ID, assignment and attempt; transition the run into `WAITING_FOR_QUESTION` (not REVIEW). Send a succinct structured question and relevant context to Planner. Planner returns an authorized answer; Engine matches it against the **same pending question**, sends through that question-response interface, and resumes observation. If question has expired or identity mismatches, block and route to Planner; do not fake a generic chat message.

## 6. Transcript browsing and operator controls

UI should list Planner threads, OpenCode Worker sessions, last events, tool calls, questions, assignment links and timestamps. A manual custom feed is a **new message/decision artifact** after pause/stop, never destructive editing of previously received transcript text. Human can inspect, copy external IDs, intervene after pause, or stop new work. Browser testing of user websites may be used as an execution tool, but does not reintroduce Chromium as the message transport.

## 7. Failure and compatibility test matrix

| Test | Must prove |
|---|---|
| INT-01 | renamed OpenCode session still opens by stable ID |
| INT-02 | server missing at boot is started or correctly reported blocked |
| INT-03 | reconnect after crash recovers exact outstanding state |
| INT-04 | no GUI/CLI implicit fallback when API-native send fails |
| INT-05 | HTTP 2xx without provider evidence is not Worker completion |
| INT-06 | same question ID receives one matched Planner answer |
| INT-07 | API Planner cannot access arbitrary ChatGPT browser history |
| INT-08 | running conversation stop prevents new sends without erasing transcript |

**OPEN-04:** Decide process supervision/packaging and credential-storage implementation after auditing macOS deployment and installed OpenCode version.
