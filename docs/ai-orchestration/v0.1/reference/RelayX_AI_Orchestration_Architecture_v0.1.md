---
title: RelayX — AI Orchestration, Governance & Free-Model Intelligence
author: RelayX Architecture Draft
version: 0.1
status: Design specification — not implementation proof
date: 2026-10-08
---

# RelayX — AI Orchestration, Governance & Free-Model Intelligence

**Architecture and product requirements • Version 0.1 • 8 October 2026**

> **Document status:** Design proposal synthesizing the current RelayX direction. “Required” identifies a user-established objective or project invariant. “Proposed” identifies a design recommendation still subject to implementation review. Nothing in this document proves that the new architecture already exists in the repository.

## 1. Executive summary

RelayX aims to become an in-house AI software-development orchestration system. A user provides a project objective; RelayX structures that objective into milestones and tasks; a Planner makes technical decisions and prepares executable instructions; an Engine authorizes and dispatches bounded assignments to OpenCode-backed Workers; an AI Supervisor oversees priorities, progress, evidence, and exceptions. The system should support building robust apps, websites, and other software **with zero paid AI API spend** where eligible free models are available.

The central design rule is **AI reasons and proposes; the deterministic RelayX Engine enforces authority, budget, state, and recovery**. The system does not assume that an LLM response, HTTP acknowledgement, or Worker self-report constitutes successful execution. Completion is tied to durable evidence and acceptance criteria.

The free-model strategy is hybrid: discover available models through provider/catalog APIs, verify exact endpoint and account eligibility, benchmark promising candidates in reproducible environments, and rank them using task-specific results gathered by RelayX. This avoids both brittle web scraping and overreliance on public benchmark scores.

### 1.1 Primary objectives

1. **Zero-paid-inference development:** Produce useful, maintainable applications/websites without paid AI model/API calls when Zero-Cost Mode is enabled. No paid fallback or silent spending.
2. **High-quality delivery:** Verify functional requirements, tests, security-relevant checks, and repository hygiene before marking work complete.
3. **Minimal operator workload:** Automate task planning, scheduling, execution observation, and reporting inside explicit human-controlled fences.
4. **Rapid end-to-end progress:** Optimize *verified task completion time*, not message volume or model speed alone.
5. **Model agility:** Discover and qualify free models dynamically without hardcoding a favored model into every Worker.
6. **Recoverability and transparency:** Durable task history, clear pause/resume semantics, traceable model selection, and Planner-first failure recovery.

**Cost definition:** “Zero cost” in this document means **US$0 paid AI API/model inference**. Local electricity, hardware wear, network, hosting, domain names, storage, and human time are not inherently free. Zero-paid-inference operation also cannot guarantee every project is feasible or fast under fluctuating quotas.

## 2. Scope and status

### 2.1 Included in this design

- In-house Planner conversations in RelayX, with provider-agnostic model selection and persisted history.
- Managed OpenCode Worker server(s), persistent Worker sessions, transcript/event browsing, and server-native delivery.
- Supervisor reasoning for intake, prioritization, scheduling proposals, monitoring, and Planner consultation.
- Durable Project → Milestone → Task/Job → Assignment → Attempt → Delivery/Evidence relationships.
- Policy Engine, authorization gates, model eligibility, provider quotas, budget ledger, and approval workflow.
- Free Model Hunter, evaluator, model registry, task-specific ranker, and feedback collection.
- Single-pair pilot, progressive multi-worker rollout, and auditable recovery.

### 2.2 Excluded or deferred

- Building a cloud multi-tenant SaaS or billing platform.
- Unrestricted autonomous code deployment or production writes.
- Automatic reactivation of the existing disabled OpenCode CLI delivery path.
- Replacing Electron purely to remove Chromium; Electron may remain the interface shell.
- Automatic UI/DOM/Chrome delivery hardening, unless separately authorized.
- Claims that existing ChatGPT web conversations are accessible through the OpenAI API.
- Automatic broad parallelism before single-pair execution is proven reliable.

### 2.3 Existing RelayX compatibility

Legacy UI-based Planner/Worker pairs and the new API-native pair type must be treated as **different transports**. Existing persisted IDs, pairing rules, event evidence, pause/stop behavior, and jobs/assignments should be reused or migrated deliberately; do not create a second competing source of truth. The current repository implementation must be audited before any schema or state-machine changes.

## 3. System topology and responsibilities

```text
Human (goals, priorities, approvals, stop/pause)
             |
        RelayX desktop UI
             |
      RelayX Control Plane
  +----------+--------------+-----------------------+
  |          |              |                       |
Policy   Task/Job       Model Intelligence    Audit & Budget
Engine   Scheduler      Discovery/Evaluation  /Evidence Ledger
  |          |              |                       |
  +----------+--------------+-----------------------+
             |
     Supervisor AI (coordination)
             |
      Planner AI (technical authority)
             |
  Engine-approved durable assignment
             |
    Managed OpenCode Server/SDK
             |
      Worker session(s)
             |
     Evidence and result capture
             |
      Planner evaluation/recovery
```

### 3.1 Authority matrix

| Actor/service | May do | Must not do |
|---|---|---|
| Human/project owner | Set goals, limits, priorities, approvals; stop/pause; override permissible decisions | Be silently overruled by AI |
| Supervisor AI | Interpret intake, suggest milestones/tasks, prioritize within policy, monitor, report, request Planner decisions | Self-authorize spending, alter immutable fences, restart failed Worker tasks directly |
| Planner AI | Design technical plan, decompose assignments, assess work evidence, issue corrections and recovery decisions | Bypass Engine dispatch/permission/budget gates |
| RelayX Engine | Own durable state, validate permissions, enforce transitions/quotas, dispatch and reconcile | Pretend an uncertain delivery succeeded |
| Model Router | Select eligible provider/model/endpoint based on measured fitness | Select unverified paid endpoints in Zero-Cost Mode |
| OpenCode Worker | Execute bounded instructions, ask intermediate questions, report evidence | Reassign itself, mutate governance policy, operate outside workspace restrictions |

**Required invariant — Planner-first recovery:** Any failed/ambiguous delivery, stalled Worker, unusable Worker output, or missing deliverable returns control to the Planner. The Supervisor supplies evidence; the Planner decides the next instruction; the Engine validates it. Never recover by silently dispatching directly to the Worker.

**Question invariant:** A Worker `question` tool request is an intermediate interaction. Preserve question ID, session/run identity, and assignment correlation; forward to Planner; route the answer back to that same pending question. It is not a completed assignment or generic new Worker message.

### 3.2 Planner provider independence

An in-house Planner can use the OpenAI Responses/Conversations APIs in paid-capable modes, but Zero-Cost Mode requires a model/provider that is verified as free for this account and endpoint. The Planner, Supervisor, and Workers all use the same model-eligibility rules. A ChatGPT subscription is **not** a substitute for OpenAI API billing; ChatGPT web conversation history is not automatically part of a separate API conversation.

### 3.3 Managed OpenCode server

On RelayX boot: discover an already-owned server or start a managed one; bind to localhost by default; enable authentication; probe `/global/health`; inspect `/doc` for the installed API; create/reuse sessions by **authoritative session ID**, not mutable title; subscribe to events; reconcile on reconnect. UI labels may refresh from current session metadata. Distinguish server accepted, prompt persisted, Worker running, response complete, and evidence verified.

OpenCode V1 and V2 have materially different permission configuration and surface details. Pin and record the installed major/version and validate the exact server specification before integrating. Use HTTP/SDK for the new path; legacy UI and disabled CLI mechanisms are not implicit fallbacks.

## 4. Project, Task, Assignment, and progress model

### 4.1 Hierarchy

| Object | Meaning | Key fields (proposed) |
|---|---|---|
| Project | Software product and common constraints | id, repository, goals, policy_version, mode |
| Milestone | Measurable business/technical outcome | id, project_id, acceptance_criteria, target |
| Task / Job | Trackable unit of needed work | id, milestone_id, priority, dependencies, state, risk, owner |
| Assignment | Bounded Planner-approved Worker instruction | id, task_id, scope, model_policy, approved_by, dispatch_key |
| Attempt | One execution try for an assignment | id, assignment_id, worker_session_id, model_endpoint_id, status |
| Delivery | Evidence-backed provider send/receipt event | id, attempt_id, direction, external_message_id, state |
| Evidence | Immutable or content-addressed verification artifact | id, attempt_id, type, digest, locator, result |
| Decision | Human/Planner decision and basis | id, subject_id, authority, rationale, timestamp |

One Task can have multiple Assignments. One Assignment can have multiple Attempts, each separately authorized after re-evaluation. A progress percentage by itself is not reliable evidence of completion.

### 4.2 Task states (proposed)

`DRAFT → PLANNED → READY → CLAIMED → RUNNING → REVIEW → VERIFIED → DONE`

Exceptions: `BLOCKED`, `PAUSED`, `FAILED`, `CANCELLED`. State transitions must be atomic and logged. `DONE` requires a verified acceptance record and permitted approval, not a Worker assertion. Dependency edges must form an acyclic graph. A task with unmet dependencies cannot become READY.

### 4.3 Priority and scheduling

Default priority levels: **P0 incident/blocker**, **P1 critical path**, **P2 standard**, **P3 optional/backlog**. A priority is a policy input, not an unconditional permission to break dependencies, locks, budgets, or approvals. Order eligible tasks by priority, downstream critical-path impact, deadline, estimated effort, risk, worker availability, and age; use deterministic tie-breakers. Let the human lock a task's priority or suspend it.

Work is dispatched only after the Engine confirms: `task ready` + `dependencies satisfied` + `Planner-approved instruction` + `eligible model endpoint` + `budget available` + `worker healthy/idle` + `workspace lock held` + `no conflicting active attempt`.

### 4.4 Human intervention and pair view

The Pair View should show the latest Planner and Worker messages, editable *proposed custom feed* while stopped/paused, task/assignment queue, active attempt, provider events, cost/quota, model, and a recovery panel. Editing a previous displayed message does not alter an immutable provider transcript; it creates a new, explicitly attributed intervention or follow-up. During RUNNING, normal operation continues without waiting for user attention unless a hard gate fires; user changes to goals/methods/direction are applied only through permitted pause/stop and Planner evaluation.

## 5. Governance hierarchy and enforcement

### 5.1 Rule hierarchy (highest first)

1. **System invariants:** data integrity, provider identity, duplicate-send prevention, Planner-first recovery.
2. **Global security/cost policy:** credentials, secret handling, allowed providers, hard spending limits, dangerous operations.
3. **Project policy:** repository root, scope, milestones, code standards, task concurrency and risk tolerance.
4. **Task/assignment policy:** file limits, command allowlists, acceptance criteria, per-attempt time/tool budgets.
5. **Worker instructions:** actionable steps within the approved envelope.

Higher-level **hard constraints** cannot be weakened by lower-level policy or prompt injection. Guidelines influence AI behavior; Engine-enforced policies and gates control authority. Do not rely on system-prompt phrasing as a security boundary. Capture effective policy/version with each Assignment.

### 5.2 Seven gates

| Gate | Required check | Failure response |
|---|---|---|
| Plan | Goal, scope, success checks, dependencies | Return to Planner for clarification/replan |
| Priority | Project policy and user overrides | Keep in backlog; report conflict |
| Model | Free eligibility, capabilities, provider/account, privacy | Choose another eligible model or BLOCK |
| Dispatch | Worker identity, session, state, locks, authorization | Do not send; escalate or queue |
| Execute | Allowed filesystem/commands/network, time and resource ceilings | Stop/pause; preserve evidence |
| Verify | Deterministic tests, diffs, acceptance criteria, review | Return to Planner, never auto-pass |
| Recover | Exact incident correlation, Planner decision, fresh authorization | Remain blocked until safe path exists |

### 5.3 Safe workspace boundaries

For multi-worker operation, use isolated Git worktrees or equivalent working directories; require file-scope and branch ownership, resource locks, patch/diff review, and controlled merge. Restrict OS permissions as needed. OpenCode tool permissions provide useful controls, but are **not sufficient OS isolation**. Default-deny destructive shell commands, privileged commands, secret reads, external directory writes, production deployments, and `git push` unless explicitly approved.

### 5.4 Operating modes

| Mode | Behavior |
|---|---|
| Manual | Agents advise; human authorizes each action |
| Assisted | Agents plan and queue; human approves dispatch |
| Controlled Auto | Engine executes Planner-approved bounded tasks within hard fences |
| Autonomous (future) | Expanded scheduling/replanning within same immutable fences; significant changes escalate |

Initial target: **Controlled Auto with one Planner, one Worker, one repository**. Do not unlock wide parallelism based solely on unit-test success.

## 6. Zero-Cost Mode — hard policy

### 6.1 Meaning of “verified free”

A candidate model is eligible **only** when the **exact provider route and exact account** permit required operations without paid AI API/model charges. A catalog price of `0` alone is insufficient. Input, output, reasoning, cached tokens, tool calls, media, request minimums, provider surcharges, and BYOK billing need evaluation where applicable. Missing or stale price/entitlement information means **unverified → not dispatchable** in Zero-Cost Mode.

Account grants, expiring promotional credits, free quotas, and pricing can change. Track the factual basis, verification time, source, policy expiry, and confidence. Do not convert an expired free offer into implicit paid spending.

### 6.2 Required rules

- Hard paid model/API budget = **US$0** across Planner, Supervisor, Workers, evaluations, and fallbacks.
- No automatic upgrade to a paid or unverified route; paid capability must require explicit mode change and authorization.
- Free quota is an operational capacity constraint; on depletion queue/pause, switch to another verified free route, or use an authorized local model.
- Free-routing aliases without guaranteed model identity are prohibited for audited production attempts unless the exact served model and provider can be established.
- Rate-limit responses trigger bounded backoff with provider-specific cooldown and job requeue; never flood/retry indefinitely.
- Account tokens stay in OS-secure credential storage; no secret material in model prompts, logs, or reports.
- Estimate and record token usage, but **never assume an estimated zero dollar amount overrides a provider's published billing terms**.

### 6.3 Free provider reality

OpenRouter's publicly advertised free tier currently shows a **50 requests/day** headline, but account/credit-related quotas and provider-specific restrictions can differ. Treat that number as descriptive documentation, not a universal scheduler constant; retrieve account-specific information where offered, and reconcile 429s or policy changes. A locally hosted model eliminates paid API inference but can be slower and consumes local compute and electricity.

## 7. Free Model Hunter — discovery and evidence

### 7.1 Three layers of truth

1. **Catalog facts:** Model ID, context size, claimed tool/structured-output support, modalities, published prices. Retrieve through official structured APIs.
2. **Runtime eligibility:** Exact provider endpoint availability, connected credentials, account-tier entitlement, limits, and *effective* zero-cost pricing. Verify with provider APIs and small safe probes where appropriate.
3. **Task fitness:** Can this exact model/endpoint reliably complete RelayX Planner/Worker tasks? This requires internal evaluation and production feedback.

No single external source reliably answers all three. Web search is secondary: use it for change investigation, new provider discovery, and policy/benchmark context; avoid daily HTML scraping as the system of record.

### 7.2 Source adapters (starting set)

| Source | Use | Trust boundary |
|---|---|---|
| OpenRouter `GET /api/v1/models` | Enumerate IDs, published prices, context and capabilities | Catalog metadata, not per-account eligibility |
| OpenRouter model endpoint listing | Inspect serving endpoints and available provider routes | Endpoint data may change; check current account |
| OpenRouter `GET /api/v1/key` | Inspect key properties and usage/quota fields where provided | Only for authorized key; fields/version may evolve |
| Models.dev `/api.json`, `/models.json`, `/catalog.json` | Cross-check provider/model data | Aggregated open-source metadata, not billing authority |
| OpenCode `/provider` and session model selection | Verify model visible to connected Worker server | OpenCode availability ≠ free eligibility |
| Provider-native APIs | Validate pricing, rate limits, service status and grants | Provider is most authoritative for its own charges |
| Public benchmarks | Cold-start candidate shortlisting | Not proof of OpenCode tool reliability |

Store raw snapshot hash, fetch timestamp, source URL, normalized fields and parser version. Implement adapter health and stale-source handling; never silently substitute guessed pricing.

### 7.3 Discovery pipeline

```text
Scheduled metadata fetch
  → Normalize provider/model/endpoint IDs
  → Compare sources; flag conflicts
  → Exact-route zero-cost eligibility check
  → Capability/context/privacy filter
  → Preliminary candidate score and benchmark queue
  → Isolated standardized probes
  → Task-specific rankings with confidence
  → Scheduler-facing qualified inventory
```

A `model` and a `served endpoint` are not interchangeable records. A single base model can appear through different hosts, policies, latency, quotas, prices, and tool behavior. The canonical qualification identity is **provider + endpoint + model ID + relevant runtime configuration + evaluation version**.

### 7.4 Refresh triggers (proposed defaults)

- Catalog metadata: on startup if cache stale, then daily while online; manual Refresh.
- Account quota/eligibility: on connection, before a new paid-sensitive route is used, and on relevant errors.
- Server health/session/model availability: at boot, reconnect, pre-dispatch, and after provider failure.
- Standard benchmarks: new promising candidates, significant configuration/model revisions, or decayed evidence; do not spend scarce free quotas testing all models daily.

Stale metadata may still be displayed with a warning, but it does not grant fresh zero-cost eligibility. Cached previously verified routes can be allowed only under a narrowly defined, non-expired authorization lease; otherwise fail closed.

## 8. RelayX evaluation and model-ranking system

### 8.1 Evaluation lanes

| Lane | Example fixed tasks | Evidence |
|---|---|---|
| Supervisor | Parse vague requirements, prioritize dependency graph, identify blockers | Valid graph, omissions, appropriate escalation |
| Planner | Produce bounded implementation plan and repair a failed plan | Dependency correctness, completeness, scope adherence |
| Coding Worker | Fix small bug in fixture repository | Hidden tests, diff and lint |
| Debugging Worker | Diagnose seeded regression | Root cause accuracy, verified repair |
| Tool reliability | Run controlled read/edit/test/question scenarios | Correct tool calls, no illegal actions, handled questions |
| Frontend Worker | Implement responsive component in isolated fixture | Browser/layout tests, accessibility checks, code review |
| Efficiency | Same task under bounded tools/time/quota | Time to verified success, attempts, tokens, quota used |

Evaluation fixtures must be reproducible, isolated, and versioned. Hidden acceptance tests reduce overfitting. Some tests may require a local browser/test runner to verify websites, but Chromium is **not required for Planner/Worker communication**. Browser automation for QA is distinct from UI-based transport.

### 8.2 Hard qualification before rank

A candidate must pass: verified $0 route, allowed privacy/region, required context and tool abilities, connected credentials, sufficient quota, server compatibility, reliability threshold, and task-required modalities. A high public benchmark never overrides a failed gate. If no eligible model meets the task requirements, return `NO_ELIGIBLE_MODEL`; do not dispatch a known-insufficient model merely to satisfy zero spending.

### 8.3 Proposed scoring (starting heuristic, to be calibrated)

```text
score(role, task_class, endpoint) =
    0.45 * verified_success_rate
  + 0.20 * tool_call_reliability
  + 0.15 * completion_speed_score
  + 0.10 * recent_provider_availability
  + 0.10 * free_quota_efficiency
```

Normalize components to [0,1]; include a separate **confidence** based on effective sample size, recency, task similarity, and evidence quality. Rank endpoints by a conservative confidence-adjusted estimate (e.g., lower confidence bound), not naive percentage alone. Treat these weights as provisional design choices, not scientific constants.

### 8.4 Feedback loop and anti-gaming

Record observed model ID, exact endpoint, seed/config, task type, prompt version, tools invoked, tests, attempt duration, final verification, Planner decision, token/quota usage, and failure reason. A success means *verified accepted deliverable*, not “the model said done.” Penalize invalid tool calls, rule violations, manual repair, and excessive retries. Do not leak hidden benchmark tests into Worker prompts. Periodically hold out tasks to detect regressions and drift.

### 8.5 Allocation policy

Select the least resource-consuming **qualified** route likely to meet the task's quality target. Consider opportunity cost: using a scarce free quota on a trivial task can prevent a high-value task later. For deterministic checks, prefer no AI call; for local models, factor queue time and device capacity. A faster model with high retry rates can be slower to verified completion than a more capable model.

## 9. Delivery, supervision, and failure recovery

### 9.1 Evidence-aware dispatch protocol

1. Create Assignment and claim the exclusive execution slot atomically with stable idempotency key.
2. Persist intended direction, exact Worker session ID, model route, policy version, payload hash and pre-send boundary.
3. Send through the new OpenCode server-native transport; record transport response without assuming completion.
4. Correlate provider events/messages with the exact attempt and dispatched message.
5. Consume final Worker report plus tool/file/test evidence; mark `REVIEW`, not `DONE`.
6. Send evidence summary to Planner; Planner accepts, requests correction, or escalates.
7. Persist final decision, update Task, and release locks/slot as permitted.

Never automatically resend after an ambiguous acknowledgement. Reconcile from the authoritative session transcript and provider IDs. If uniqueness cannot be proven, block and return to Planner.

### 9.2 Event-driven supervision

Engine watches health, task state, question/permission requests, run status, errors, and deadlines. Supervisor inference is invoked for meaningful decisions, not every polling tick. Record each planned action as a proposal; Engine applies it only after policy evaluation and required approvals. Backpressure prevents the Supervisor from recursively spawning unbounded tasks.

### 9.3 Pause, resume, stop

- **PAUSE:** no new dispatch; preserve active state/evidence, ask runtime to pause/abort only according to approved semantics. Resume requires reinspection of task, model quota, session and policy.
- **STOP:** prohibit new assignments; unresolved work remains durably recorded, not silently discarded.
- **Crash/restart:** reconcile in-flight attempts and provider state before further dispatch. Do not infer success from missing local messages or infer failure from transient disconnection.
- **Manual intervention:** create a new authorized instruction, never edit historical provider messages in place.

### 9.4 Failure taxonomy and owner

| Incident | Detection | Owner/next safe step |
|---|---|---|
| Model not free or exhausted | Pricing/account/quota gate, 402/429 | Router proposes alternatives; Engine blocks paid route |
| Worker question pending | Structured tool event | Planner answers same correlated question |
| Provider unreachable | Health/network failure | Engine records; Supervisor reports; Planner decides next direction |
| Ambiguous delivery | Unknown receipt/message boundary | Engine reconciles; Planner-first if unresolved |
| Worker stalled | Run/heartbeat deadline | Supervisor gathers evidence; Planner replans |
| Invalid/missing report | Acceptance or report contract failure | Planner corrects/reassigns; no direct retry |
| Test regression | CI/local acceptance failure | Planner reviews diff and corrective strategy |
| Budget/security violation | Hard policy guard | Immediate block and human escalation as appropriate |

## 10. Data interfaces and security contract

### 10.1 Core service contracts (conceptual)

```text
ModelDiscovery.refresh(source) → snapshot + normalized candidates
Eligibility.check(endpoint, account, mode, requirements) → ALLOW | DENY | UNKNOWN
Evaluator.run(candidate, fixture, budget_guard) → immutable EvaluationRun
Ranker.recommend(task_class, policy) → ranked qualified endpoints + evidence
PolicyEngine.authorize(action, actor, scope, context) → decision + reason + policy_version
Scheduler.claim(task_id, worker_id) → exclusive claim or conflict
Transport.dispatch(assignment_id, exact_session_id) → correlated delivery evidence
Reconciler.resolve(attempt_id) → known terminal state or BLOCKED
Supervisor.propose(project_event) → suggested Task/Decision/Action
Planner.review(evidence_bundle) → ACCEPT | CORRECT | REPLAN | ESCALATE
```

All state-mutating commands require provenance (actor, project, request ID), idempotency, optimistic concurrency or transaction guards, and audit records. Agents get scoped tools, not raw SQL or arbitrary privileged IPC.

### 10.2 Suggested new persistence entities

`model_catalog_snapshot`, `model_identity`, `provider_endpoint`, `account_entitlement`, `eligibility_check`, `benchmark_fixture`, `evaluation_run`, `model_rank_snapshot`, `quota_ledger`, `policy_definition`, `policy_decision`, `approval_request`, `task_dependency`, `assignment_model_selection`.

Use existing RelayX Project/Pair/Job/Assignment/Attempt/Delivery tables where possible. Add foreign keys and uniqueness on external session IDs and exact provider message IDs. Maintain a migration plan and make all events replay-safe.

### 10.3 Minimal audit record

Every AI-directed action should answer: **who initiated it, which rule allowed it, which task/attempt it belongs to, what model/provider ran, what was sent, what evidence returned, whether it cost money, and why the next state was chosen**. Store hashes for large artifacts and redact credentials/PII.

### 10.4 Security and trust boundaries

Treat model outputs, web pages, repository content, build logs, and external catalog responses as untrusted. Do not let tool output override system policies. Validate structured outputs server-side; enforce path traversal protections; never expose provider API keys to Workers; sandbox commands when practical; separate readonly inspection from mutating operations. Workspace filesystem and production/cloud credentials require explicit authority and stronger isolation.

## 11. User experience specification

### 11.1 Navigation

- **Projects:** goals, milestones, repo, operating mode, policy and objectives.
- **Tasks:** backlog, dependencies, priority, acceptance tests, budget and assigned Worker.
- **Pair View:** Planner chat left, Worker transcript/right, active task/attempt center or tab, intervention controls, evidence and recovery.
- **Sessions:** API-created Planner threads and exact OpenCode sessions, with full message/tool history.
- **Model Intelligence:** discovered free models, eligibility timestamp, provider routes, rankings by role, evidence sample size, quota, refresh/test actions.
- **Governance:** global/project/task fences, approval queues, hard budgets, policy change history.
- **Attention/Diagnostics:** uncertain deliveries, failures, health, blocked work, provider limits, recovery decisions.

### 11.2 Important UX labels

Do not conflate `free`, `verified free for this account`, `qualified for coding`, `available right now`, and `preferred`. Display separate indicators. Model rankings must show small-sample uncertainty, and every recommendation should be inspectable: “selected because…” with tests, quota, latency, and last eligibility check. Make Start/Pause/Resume/Stop prominent and unambiguous.

## 12. Implementation roadmap and go/no-go gates

### Phase 0 — Baseline audit and contracts

Inventory current RelayX Engine states, SQL migrations, existing UI and disabled CLI transports, known failure modes, OpenCode server version/OpenAPI, and existing tests. Define idempotency and Planner-first recovery contracts before modifying code.

**Exit:** published state/authority map; reproducible baseline test run; API compatibility matrix; no unresolved duplicate-dispatch risk in the intended new path.

### Phase 1 — Free Model Intelligence MVP

Implement OpenRouter and Models.dev adapters, snapshot storage, canonical route IDs, safe price normalization, zero-cost eligibility gate, account-level quota telemetry and cached catalog UI. No automated coding dispatch yet.

**Exit:** correct filtering; missing/conflicting price blocks; fake paid endpoint never passes; stale catalog displayed without silent authorization.

### Phase 2 — In-house single pair

Implement one provider-agnostic Planner session (free route in Zero-Cost Mode), one managed OpenCode Worker, persisted messages, server-native send/reconcile, and transcript browsing. Use one repository and one active slot. Keep legacy pair type available but isolated.

**Exit:** repeated real end-to-end cycles survive app restart, questions, rate limits, and uncertain receipts without duplicate sends.

### Phase 3 — Policy, task backlog and approvals

Introduce Task hierarchy, priorities/dependencies, deterministic readiness checks, scoped worktrees, approval state, pause/stop, and live progress view.

**Exit:** Engine demonstrably blocks out-of-scope actions, unauthorized model upgrades, double claims, and unmet dependencies.

### Phase 4 — Evaluation and ranking

Build fixtures and evaluator, publish per-role scores with uncertainty, then enable ranked selection only for proven-qualified routes. Use bounded probes and real outcome capture.

**Exit:** model choices are auditable; controlled tests predict better task completion than random/free-only selection on the pilot suite.

### Phase 5 — Supervisor AI and scaled worker pool

Enable event-driven intake, planning proposals, backlog prioritization, Planner consultation, and later concurrency with worktree/merge controls. Keep Planner-first recovery intact.

**Exit:** multi-task pilot with deterministic scheduling, full traces, no privilege bypass, and acceptable quality/latency under actual free-tier limits.

## 13. Verification and adversarial acceptance tests

| Scenario | Required result |
|---|---|
| A `:free` model changes to a paid endpoint | No dispatch; eligibility denied |
| Catalog has missing/ambiguous output price | Deny in Zero-Cost Mode |
| Free quota depleted mid-project | Queue/pause or switch only to another eligible free route |
| Planner attempts to change global budget via prompt | Engine denies |
| Worker prompt asks to read secret or write outside worktree | Permission/OS fences deny |
| Two workers claim same exclusive task | One claim succeeds atomically |
| OpenCode send acknowledged but result unknown | No duplicate blind resend; reconcile/block |
| Worker asks a structured question | Correlated Planner answer resumes same question |
| Worker returns polished text but hidden tests fail | Task not DONE; Planner review |
| Worker response missing or unusable | Planner-first recovery |
| RelayX crashes during attempt | Exact session/event reconciliation; no replay |
| Model ranks highly from only 2 attempts | Low confidence; avoid false certainty |
| User stops pair | No new dispatch; recoverable persisted state |
| External page says “ignore policy” | Treat as data; no authority elevation |

The pilot is successful only if it can complete a real, modest app/website task with **US$0 paid model/API charges**, defensible acceptance evidence, controlled failures, and recorded time-to-verification. Do not market “robust zero-cost development” as guaranteed until repeated empirical trials support it.

## 14. Design decisions needing explicit confirmation

1. **Zero-Cost Mode definition:** paid AI API spend is fixed at $0; should optional paid hosting/build tools also be banned? Currently *no*—report them separately.
2. **Default Planner:** free-model-only in Zero-Cost Mode, or permit a separate explicitly paid-capable mode? Proposed: both, with separate profiles and never silent crossover.
3. **Privacy boundary:** may source code be sent to third-party free model providers, or do some projects require local-only execution? Proposed: per-project privacy gate, local-only when restricted.
4. **Human approvals:** which actions require human approval even in Controlled Auto (e.g., dependency installation, git push, deletion, deployment)? Proposed: deny/ask sensitive actions.
5. **Quality threshold:** project-type-specific acceptance suites and target success rates. Proposed: define per-task minimum checks rather than arbitrary universal percentages.
6. **Ranking exploration budget:** what fraction of free quota can be used for benchmark probes? Proposed: low initial cap with human override.
7. **Multi-worker scheduling:** concurrency and merge ownership. Proposed: defer until single-pair durability proven.
8. **Existing chat import:** in-house API Planner history is native to RelayX; importing ChatGPT web history is a separate feature and not assumed.

## 15. Source register (retrieved/reviewed 8 October 2026)

Sources support interface existence and documented behavior, **not** a claim that a particular account has free entitlement or that an endpoint currently meets a task's quality bar.

1. OpenCode — Server / HTTP API / health / sessions / messages / events / OpenAPI: https://opencode.ai/docs/server/
2. OpenCode — V1 permission concepts: https://opencode.ai/docs/agents/
3. OpenCode — V2 permissions (version-specific warning): https://opencode.ai/v2/docs/permissions
4. OpenCode — V2 model/provider availability: https://opencode.ai/v2/docs/models
5. OpenRouter — Model catalog API: https://openrouter.ai/docs/api/api-reference/models/get-models
6. OpenRouter — Endpoint listing: https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints
7. OpenRouter — Current key/account data: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
8. OpenRouter — Public pricing/free-tier description: https://openrouter.ai/pricing
9. Models.dev — Machine-readable API and repository: https://github.com/anomalyco/models.dev and https://models.dev/api.json
10. OpenAI — ChatGPT and API billing are separate: https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform

---

**Implementation posture:** This is a design specification. Before coding, validate current RelayX source/database constraints, inspect the running OpenCode `/doc` specification, and resolve the open decisions that materially affect enforcement. Start with the free-model eligibility gate and one durable in-house Planner–Worker pair; expand autonomy only with measured evidence.
