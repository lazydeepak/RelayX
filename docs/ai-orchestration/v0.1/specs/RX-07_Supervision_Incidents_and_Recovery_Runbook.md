# RX-07 — Supervision, Incidents & Planner-First Recovery

**Version:** 0.1 · **Status:** Proposed operations runbook · **Parent:** Architecture v0.1 §§3, 9, 13 · **Diagrams:** D06, D07, D09

## 1. Non-negotiable recovery authority

When *anything goes wrong*—delivery failure/ambiguity, Worker stall, missing result, broken report, tests failing or an invalid Worker's question protocol—RelayX must return recovery control to the **Planner**. The Supervisor may collect evidence, classify and recommend; it cannot silently resend a Worker instruction, replace an unreliable model and continue, or mark work complete. Only a new Planner decision, validated by the Engine, can trigger further Worker actions.

**REQ-25:** Every actionable incident has exact affected attempt/assignment/session IDs, evidence packet, classification and Planner decision correlation.  
**REQ-26:** The reconciler may observe and resolve exact evidence but cannot manufacture a receipt or blindly replay an ambiguous send.  
**REQ-27:** Pause/Stop suppresses new dispatch; restart reconciliation precedes new work.

## 2. Event-driven supervision

The Engine monitors state changes, OpenCode events, health checks, quota updates, Worker questions, deadlines, completion reports and test outcomes. The Supervisor AI is invoked when a **decision** is needed—not on every fixed polling tick. Events are deduplicated; repeated identical incidents must not generate unbounded Planner messages or task creation. Every proposal has an origin event ID, rationale and constrained next-action list.

## 3. Incident classes and response

| Code | Symptom | Deterministic step | Required decision |
|---|---|---|---|
| INC-01 | Send status unknown | exact session transcript/provider ID reconciliation | Planner if still ambiguous |
| INC-02 | Provider/server unreachable | health probe, durable disconnect state | Planner chooses wait/rebind/replan |
| INC-03 | Worker stalled | observe run status/deadline, preserve logs | Planner decides correction/stop/retry |
| INC-04 | Missing/invalid report | mark REVIEW/BLOCKED with evidence gap | Planner produces revised instruction |
| INC-05 | Failed tests | persist test results and diff | Planner analyses root cause |
| INC-06 | Model no longer free | immediately deny new paid route | Planner chooses eligible alternative/work split |
| INC-07 | Pending Worker question | exact question ID/run correlation | Planner answers same pending question |
| INC-08 | Security/policy violation | deny command, quarantine if needed | Human approval for risky exception |
| INC-09 | Unmatched external session | block, inspect authoritative identity | Planner/human binding decision |

## 4. Evidence packet schema

Each recovery case includes: correlation ID; project/task/assignment/attempt/delivery IDs; exact Planner conversation ID and Worker session ID; incident source and time; last confirmed provider boundary; what is known vs uncertain; model route and quota state; recent tool calls, file/test evidence with redactions; effective policy version; safe next options. Avoid hallucinated 'Worker completed' statements when only HTTP acceptance exists.

**DESIGN-19:** Implement idempotent incident keys `(incident_type, attempt_id, unresolved_generation)` to avoid duplicate escalations.  
**DESIGN-20:** A Planner recovery decision enumerates `WAIT`, `RECONCILE`, `ASK_HUMAN`, `REPLAN`, `CORRECT_WITH_NEW_ASSIGNMENT`, or `CANCEL`; none implies automatic direct Worker resend.  
**DESIGN-21:** Retain the original attempted payload and provider evidence immutable; corrections create a new authorized Assignment or Attempt with causal reference.

## 5. Runbook: uncertain dispatch

1. Freeze new dispatch for affected pair and persist `AMBIGUOUS` with original dispatch key.
2. Inspect exact Worker session and provider messages/events around pre-send boundary.
3. If unique authoritative sent message is proven, attach provider ID and continue **observation**, not resend.
4. If zero or multiple matches or incomplete history, stay blocked and create an incident packet.
5. Send packet to Planner; Planner chooses safe next direction and any human approval required.
6. Engine executes only the newly authorized, policy-compliant action.

## 6. Runbook: unusable Worker delivery

1. Confirm expected completion contract, extract report, tests, files, tool activity.
2. Describe missing parts explicitly; mark report as unusable, not 'no activity'.
3. Transfer control to Planner with findings and previously approved goal.
4. Planner decides whether a narrowed correction, a different free model, a split task, or cancellation is appropriate.
5. Engine checks budget/model/locks and creates a fresh traceable assignment if authorized.

## 7. Pause, stop, restart

**PAUSE:** prevent new sends; active execution may continue unless a separately supported pause/abort is requested. UI must display the distinction between 'no new dispatch' and 'actively suspended process'. **STOP:** persist durable state, stop scheduling, do not delete attempts. **RESTART:** initialize DB, inspect provider server/session, reconcile all open attempts and delivery boundaries, validate model eligibility and policy, then resume only permitted work. Never infer a stale session title means a new session.

## 8. Recovery tests

**REC-01** ambiguous ACK never blind-resends; **REC-02** missing report sends Planner evidence packet; **REC-03** quota exhaustion doesn't call a paid fallback; **REC-04** duplicate event doesn't spawn duplicate incident; **REC-05** persisted incident survives app crash; **REC-06** question isn't marked completed; **REC-07** stop prevents next task; **REC-08** changed Worker name doesn't rebind wrong session; **REC-09** failure recovery instruction originates with Planner and is policy-gated.
