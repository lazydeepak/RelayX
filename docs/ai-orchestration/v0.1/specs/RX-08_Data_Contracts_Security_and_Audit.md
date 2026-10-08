# RX-08 — Data Contracts, Security & Auditability

**Version:** 0.1 · **Status:** Proposed persistence and interfaces · **Parent:** Architecture v0.1 §10 · **Diagrams:** D05, D10

## 1. One authoritative state machine

Current RelayX already contains Project/Pair/Assignment/Attempt/Delivery state. Reuse those records or migrate deliberately after inspecting actual schema, indexes, transactions, and resume logic. **Do not implement a separate AI task ledger that competes with Engine state.** New model intelligence, decisions, quotas and policy entities should reference existing durable IDs.

**REQ-28:** Mutations are idempotent, actor-attributed and auditable.  
**REQ-29:** Every external event is correlated to exact session/provider identity and attempt.  
**REQ-30:** Credentials never appear in model prompts, benchmark fixture snapshots, user-visible reports or stored tool transcripts.  
**REQ-31:** On startup, outstanding Delivery/Attempt intents reconcile before new scheduling.

## 2. Core entities, conceptual fields

| Entity | Essential fields / invariant |
|---|---|
| Project | `id`, repository binding, owner, mode, policy_version |
| Pair | `id`, Planner thread ID, Worker exact session ID, transport, lifecycle state |
| Task | `id`, milestone, priority, dependency version, acceptance, state |
| Assignment | `id`, task, Planner decision ID, scope, payload_hash, dispatch_key UNIQUE |
| Attempt | `id`, assignment, chosen exact model route, Worker run/session, status |
| Delivery | `id`, attempt, direction, provider message ID, evidence state |
| Evidence | immutable digest, type, attempt, locator, parser version, redaction status |
| PolicyDecision | actor, action, resource, effective policy digest, verdict and reason |
| ModelRoute | provider, endpoint, model ID, account reference, config fingerprint |
| Eligibility | route, account, mode, verdict, evidence hash, verified/expiry times |
| EvaluationRun | route, task fixture version, results, success checks, runtime metrics |
| RecoveryDecision | incident, Planner conversation, decision class, authorization and reason |

Suggested additions are conceptual—not drop-in SQL migrations. Define explicit foreign keys, unique provider message constraints scoped to provider/session, indexes for `(project,state,priority)`, and optimistic version fields for mutable aggregates.

## 3. Command and event contracts

```text
CreateTask(project, objective, dependencies, acceptance, actor, request_id)
Authorize(action, target, actor, policy_version) -> verdict + reason
ClaimAssignment(task, exact_worker_session, model_route, request_id) -> claim
Dispatch(assignment, attempt, exact_session) -> send observation
RecordProviderEvent(provider_event, session, run, attempt) -> deduped observation
RecordEvidence(attempt, digest, type, source) -> immutable reference
PlannerReview(task, evidence_bundle) -> ACCEPT | CORRECT | REPLAN | ESCALATE
RecoverIncident(incident, planner_decision) -> policy-gated next action
```

Every mutation has `request_id` and actor provenance, expected version/transaction guard, durable event record, and input validation. Split DB transaction from outbound provider HTTP request; use a persisted outbox/send-intent that can reconcile an uncertain reply. Never silently mark `delivered` because an HTTP promise resolved.

## 4. Event taxonomy

Use stable event types such as `TASK_PLANNED`, `TASK_READY`, `ASSIGNMENT_CLAIMED`, `DELIVERY_INTENT_RECORDED`, `PROVIDER_SEND_ACK`, `DELIVERY_CONFIRMED`, `WORKER_QUESTION_OPEN`, `WORKER_QUESTION_ANSWERED`, `WORKER_RESULT_OBSERVED`, `VERIFICATION_FAILED`, `PLANNER_REVIEW_ACCEPTED`, `INCIDENT_OPENED`, `RECOVERY_DECISION_RECORDED`, `POLICY_DENIED`, `MODEL_ELIGIBILITY_EXPIRED`, `PAIR_PAUSED`, `PAIR_STOPPED`. Store severity, event time, origin source, correlation, project/pair/task/attempt references and sanitized details.

## 5. Security boundaries

Treat generated plans, repository content, benchmark prompts, tool output, fetched provider metadata and webpage content as untrusted inputs. Enforce scoped tool APIs, path canonicalization, symlink and traversal restrictions, process sandbox/OS permissions, secret redaction, approved network egress, and validation of model-produced structured output. Separate **read-only metadata APIs** from **mutating permissions**. Provider credentials reside in OS-secure store and are referenced by opaque IDs.

**DESIGN-22:** Large artifacts use content-addressed hashes and controlled file locations.  
**DESIGN-23:** Sensitive audit fields have explicit retention and masking rules.  
**DESIGN-24:** Use schema migrations with rollback/backups; test upgrades from representative previous RelayX DB versions rather than assuming an empty database.

## 6. Audit and replay questions

A forensic review must answer: Who asked for the goal? Which Planner decision created the Assignment? Which policy and model eligibility allowed dispatch? What exact message was sent? What server/session/run accepted it? Which code/test artifacts were returned? Was a free quota consumed or a charge incurred? Why did the task advance, block or recover? The event log should answer without trusting AI summary prose.

## 7. Tests and open schema mapping

**DATA-01** duplicate provider event no-op; **DATA-02** duplicate dispatch key cannot create second live send intent; **DATA-03** wrong session ID events rejected or quarantined; **DATA-04** stale optimistic version prevents lost updates; **DATA-05** no plaintext credentials in export; **DATA-06** pre-v0.1 DB migration preserves legacy pairs; **DATA-07** replay produces same state; **DATA-08** crash after send intent leaves recoverable uncertainty.

**OPEN-05:** Map these conceptual entities to real current RelayX SQLite tables and IPC contracts during Phase 0 before choosing migrations.
