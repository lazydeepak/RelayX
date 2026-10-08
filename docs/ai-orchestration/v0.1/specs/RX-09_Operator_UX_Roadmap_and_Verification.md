# RX-09 — Operator UX, Delivery Roadmap & Verification

**Version:** 0.1 · **Status:** Proposed interface and rollout plan · **Parent:** Architecture v0.1 §§11–14 · **Diagrams:** D02, D09

## 1. UX goals

Users should be able to state a goal, see its decomposition, understand why particular Worker/model choices were made, observe real evidence and intervene without breaking continuity. A visually busy 'AI activity' screen that hides uncertain deliveries and unresolved dependencies is worse than a simple auditably correct Task board.

**REQ-32:** At all times display pair lifecycle state (`STOPPED`, `RUNNING`, `PAUSED` etc.), task state, attempted delivery state, current model route and blocking reason independently.  
**REQ-33:** Show both Planner and Worker latest messages; allow composing a **new** custom intervention after pause/stop. Never mutate historical transcripts.  
**REQ-34:** User can trace each Task → Assignment → Attempt → Delivery → Evidence → Planner decision.  
**REQ-35:** Distinguish `catalog listed`, `verified free`, `qualified`, `available`, and `recommended` model states.

## 2. Proposed navigation map

| Screen | Primary items | Essential actions |
|---|---|---|
| Projects | goals, milestones, repository, operating mode | edit objectives, open tasks, view policy |
| Tasks | backlog, P0–P3, dependencies, blockers, worker | set priority, suspend, inspect attempt |
| Pair View | split Planner/Worker messages, queue, baton, status | pause/stop/start, inspect recovery, compose new feed |
| Sessions | Planner thread, Worker exact session, tool/question history | browse, copy IDs, open evidence |
| Model Intelligence | routes, free lease, quotas, benchmarks, confidence | refresh catalog, inspect, request safe eval |
| Governance | rules, approvals, policy revisions, budgets | approve/deny, change mode with audit |
| Attention | incident packet, severity, owner and next step | send to Planner, inspect reconciliation |
| Diagnostics | server health, transport, event lag, DB integrity | run read-only checks |

## 3. Pair View behavior

RUNNING continues scheduled work without waiting for casual operator inspection. PAUSE blocks new dispatch and offers safe modification of goals/instructions; if execution remains active, show that clearly. STOP forbids new work but retains durable state. If a Worker is failed, the recovery panel starts on the **Planner side** with evidence and next-decision options. The Operator can edit only a **proposed new message**, not a previous provider message. Every manual action must display effective policy and whether a new assignment would be created.

## 4. Observability and explanations

A Worker card should show: exact session ID, current model route, latest provider event, active assignment, last verified artifact, tool question status and quota. A task row should show priority owner, dependencies, scope, status and last Planner decision. An important state uses a reason code and human-readable explanation. Example: `NO_ELIGIBLE_MODEL — endpoint price verification expired; no verified-free alternative qualified for this task`.

## 5. Implementation phases (gated)

| Phase | Deliverable | Required exit evidence |
|---|---|---|
| 0: Audit | real schema/state map, OpenCode `/doc`, baseline suite | all old/new transport boundaries documented |
| 1: Hunter | catalogs, snapshots, cost gates, visible model registry | unknown/paid routes never allowed |
| 2: Native pair | one Planner API session + one OpenCode server Worker | repeated cycles, restart and question proof |
| 3: Work + policy | dependency-aware Tasks, approvals, locks, controls | double-claim/privilege/budget tests |
| 4: Ranking | reproducible fixtures, task-specific scores, route explanations | qualification predicts improved outcomes |
| 5: Supervisor | event-driven coordination, exceptions, later worker pool | no bypasses, multi-task audit trail |

Do not introduce Phase 5 multi-worker concurrency until Phase 2 reliability and Phase 3 workspace controls have evidence. Each phase must have a reproducible regression suite, not just an AI completion message.

## 6. Pilot scenario and acceptance rubric

A user asks RelayX to build a modest responsive website in an isolated repository. The Planner creates 3–5 bounded tasks with explicit acceptance; Hunter identifies a verified-free endpoint; Worker produces code and tests; Planner reviews outputs; the system survives a simulated restart, a Worker question and an injected ambiguous acknowledgement without duplicates. Log actual elapsed time, completion quality, human interventions, free requests consumed and confirmed paid inference spend **$0**.

| Test | Observable result |
|---|---|
| UI-01 | latest Planner and Worker messages visible with provenance |
| UI-02 | editing custom feed creates new event, old history unchanged |
| UI-03 | STOP leaves persisted open attempts but stops dispatch |
| UI-04 | priority changes affect eligible order without bypassing gates |
| UI-05 | model rank uncertainty and last eligibility time visible |
| UI-06 | failure shows Planner recovery owner and incident packet |
| PILOT-01 | real accepted project artifact and acceptance proof |
| PILOT-02 | route provenance and zero paid inference charge audit |

## 7. Unresolved decisions to review before implementation

- **DEC-01** Per-project source-code egress: local-only vs approved free third-party providers.
- **DEC-02** Actions always requiring human approval: installs, deletions, networking, push/deploy.
- **DEC-03** Quota budget reserved for model evaluation vs production work.
- **DEC-04** Planner provider selection when there is no sufficiently qualified free Planner.
- **DEC-05** State ownership details from real existing RelayX database and migrations.
- **DEC-06** OpenCode server management, auth, `question` API and version-specific capabilities.
- **DEC-07** How long to retain large Worker logs/evidence and how to redact PII/secrets.
- **DEC-08** Acceptance templates for website, app, library and mobile project types.

**Decision posture:** do not invent defaults that violate the agreed hard gates. If a decision changes authority/security/cost, keep it pending until the human explicitly confirms it.
