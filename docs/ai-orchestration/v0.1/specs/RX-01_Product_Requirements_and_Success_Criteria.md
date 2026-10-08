# RX-01 — Product Requirements & Success Criteria

**Version:** 0.1 · **Status:** Proposed detailed requirements · **Parent:** Architecture v0.1 §§1–4, 12–13 · **Diagrams:** D01, D02

## 1. Mission and scope

RelayX coordinates development of maintainable projects, applications and websites using an internal Planner, a durable execution Engine and managed OpenCode Worker sessions. Zero-Cost Mode aims for **$0 paid AI API/model inference**, not literally zero hardware, electricity, hosting, network or labor expense. A short path to a **verified deliverable** is the optimization target; agent message volume is not.

**REQ-01:** User objectives become explicit milestones and traceable, testable Tasks before autonomous execution. The user can correct priorities, goals and operating mode.  
**REQ-02:** A Planner chooses technical direction and reviews completion; a Supervisor coordinates and reports; the Engine authorizes state changes; Workers execute bounded assignments.  
**REQ-03:** A project in Zero-Cost Mode must never send any request through an unverified or potentially paid AI route.  
**REQ-04:** In-house Planner conversations and exact OpenCode Worker sessions must be inspectable in RelayX with histories, attempts and evidence.  
**REQ-05:** Work remains recoverable across pause, stop, process restart and provider disruption.  
**REQ-06:** On any transport failure, Worker stall, or unusable Worker report, the next recovery decision belongs to the Planner.

## 2. Definition of a verified deliverable

A Worker may produce text, edits and test results, but these are **claims and evidence**, not permission to close a task. The task becomes DONE only when: (a) acceptance criteria are mapped to checks; (b) applicable deterministic tests and scope checks pass or exceptions are approved; (c) artifacts and provider identities are correlated to the correct attempt; (d) the Planner's review decision and any required human authorization are persisted. Evidence absence yields REVIEW/BLOCKED, not success.

**DESIGN-01:** Capture per-task acceptance checklist, test command and output digest, changed-file manifest, reviewer decision, and a succinct user-visible completion report.  
**DESIGN-02:** Count actual accepted tasks, time-to-verified-success, repeated correction cycles, human interventions, quota consumed, and observed charges. Avoid a synthetic progress percentage as sole signal.  
**DESIGN-03:** When verification is impossible (for example missing environment or inaccessible test), label the requirement *UNVERIFIED*, never silently PASS.

## 3. Release slice and exclusions

V1 targets one repository, one in-house Planner session, one managed OpenCode Worker session, one active execution slot, a free-model allowlist informed by eligibility checks, and a durable task queue. A Supervisor can initially operate in recommendation mode; full autonomous re-planning and parallel Workers come later.

Not in this release: cloud multi-tenancy, payments, automatic production deployment, unrestricted shell authority, imported ChatGPT browser history, switching on the disabled CLI fallback, or browser DOM message transport. Electron can remain the UI shell even though Chromium is unnecessary for model communication.

## 4. User journeys

**Journey A — Normal:** user enters goal → intake validates constraints → Planner creates milestones, tasks, dependencies and acceptance criteria → user approves if required → Engine selects ready task and qualified free model → Worker executes → evidence captured → Planner reviews → task DONE or correction planned → Supervisor updates project report.

**Journey B — Quota exhaustion:** before dispatch, an eligibility lease expires or free quota is exhausted → Engine blocks route → Router checks another verified-free candidate → if none is qualified, Task BLOCKED/QUEUED → user sees reason and next safe option. No paid route.

**Journey C — Failure:** provider accepts but receipt cannot be proven → reconciliation checks exact session/provider evidence → if still ambiguous, block without resend → Planner assesses evidence and chooses new direction → Engine evaluates authorization before any further Worker action.

## 5. Measurable pilot acceptance

| ID | Pilot assertion | Evidence required |
|---|---|---|
| ACC-01 | One modest real software task reaches DONE | repository diff, tests, Planner acceptance |
| ACC-02 | Zero paid AI inference | verified account/endpoint route records plus charge audit |
| ACC-03 | Restart doesn't produce duplicate delivery | persisted dispatch key and exact transcript reconciliation |
| ACC-04 | Prompt injection cannot alter policy | adversarial tool-message test and deny decision |
| ACC-05 | Stalled Worker returns to Planner | incident event, review decision, fresh authorization |
| ACC-06 | Session history is browsable | stable Planner thread ID and Worker external session ID |
| ACC-07 | Model selection is explainable | chosen route, runner-up, qualification evidence, reason |

## 6. Risks and open decisions

**OPEN-01:** Is source code permitted to leave the user's device via free third-party AI providers? Recommend per-project `LOCAL_ONLY` / `APPROVED_REMOTE` fence; do not assume blanket permission.  
**OPEN-02:** Which actions (dependency install, git push, network access, deletion, deployment) always require a human? Recommend ask/deny by risk and environment.  
**OPEN-03:** How to measure 'robust'? Recommend project-type acceptance templates rather than a single unearned percentage.

**Interfaces:** RX-02 enforces constraints; RX-03 schedules tasks; RX-04 transports execution; RX-05 qualifies free routes; RX-06 measures capability; RX-07 recovers; RX-08 audits; RX-09 presents.
