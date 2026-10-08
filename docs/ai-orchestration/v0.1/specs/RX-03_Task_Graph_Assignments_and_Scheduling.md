# RX-03 — Task Graph, Assignments & Scheduling

**Version:** 0.1 · **Status:** Proposed workflow specification · **Parent:** Architecture v0.1 §4, §9 · **Diagrams:** D02, D03, D05

## 1. Work hierarchy and ownership

`Project → Milestone → Task/Job → Assignment → Attempt → Delivery/Evidence` is a logical hierarchy. Task states reflect business progress. Assignment states reflect Planner-issued bounded instructions. Attempt states reflect concrete execution. Delivery states reflect one direction-specific transport observation. **Never equate a delivered message with a completed Task.** Existing RelayX records should be migrated or extended after repository inspection; don't create a second Jobs source of truth.

**REQ-11:** Every executable Task has acceptance criteria, dependency edges and a tracked priority.  
**REQ-12:** One active execution slot per pair in V1; atomic claims prevent double-dispatch.  
**REQ-13:** Tasks become DONE only after correlated verification plus Planner and any required human approval.

## 2. Proposed Task state machine

Normal path: `DRAFT → PLANNED → READY → CLAIMED → RUNNING → REVIEW → VERIFIED → DONE`. Exception states: `BLOCKED`, `PAUSED`, `FAILED`, `CANCELLED`. Define strict origin/destination transition tables in code; transitions should include actor, reason, expected version, event ID and timestamp.

| State | Meaning | Entry requirement | Allowed next |
|---|---|---|---|
| DRAFT | Proposed work | User/Supervisor intake | PLANNED, CANCELLED |
| PLANNED | Planner scope accepted | acceptance/dependencies defined | READY, BLOCKED, CANCELLED |
| READY | Dependencies + policy satisfied | deterministic readiness calculation | CLAIMED, BLOCKED, PAUSED |
| CLAIMED | Exclusive scheduler lease | atomic claim + worker/session bound | RUNNING, BLOCKED, PAUSED |
| RUNNING | Attempt active/observed | correlated provider evidence | REVIEW, BLOCKED, PAUSED |
| REVIEW | Awaiting evaluation | report/evidence or explicit failure packet | VERIFIED, BLOCKED, PLANNED |
| VERIFIED | Acceptance evidence accepted | reviewer decision recorded | DONE, BLOCKED |
| DONE | Completed and closed | acceptance + approvals | terminal unless reopened as new work |

`BLOCKED` is not free license to restart. Unblock requires condition repair and, after a Worker/transport incident, a Planner recovery decision. `FAILED` is a recorded terminal work outcome, not a queue retry signal.

## 3. Dependencies, priority and readiness

Tasks form a directed acyclic graph. Use a cycle detector at insert/update. A dependency is satisfied only when the predecessor meets the required completion state; default to DONE, not merely REVIEW. P0 is incident/critical blocker, P1 critical path, P2 standard, P3 optional. Human-locked priority overrides Supervisor recommendations.

**DESIGN-08:** Scheduler produces an ordered *eligible* set, filtering suspended, blocked, unmet dependencies, missing acceptance criteria, policy denial, unavailable worker/model or workspace locks. Candidate sorting can use priority, critical-path impact, deadlines, age and worker fit; deterministic ID tie-break.  
**DESIGN-09:** Reserve a per-attempt quota budget and a lock for conflicting files/workspaces before external send. Release/transfer locks only when terminal and reconciled.  
**DESIGN-10:** Each Assignment has payload hash and a stable idempotency/dispatch key. Creating a new Attempt for a correction requires the Planner's new instruction and decision correlation.

## 4. Dispatch transaction boundary

1. Read task/assignment, exact policy, dependencies, session identity, worker state and account route.
2. Validate G1–G4; atomically claim execution slot and persist intended send (no provider call inside SQLite transaction).
3. Attempt provider dispatch once; store returned provider IDs as observations, not invented proof.
4. Correlate post-send events to attempt and exact session; mark delivery confirmed only if unique evidence exists.
5. Worker report opens REVIEW; Planner evaluation advances VERIFIED or returns with a bounded correction.
6. If dispatch acknowledgement is ambiguous, **do not resend**. Reconcile exact transcript and ask Planner if unresolved.

## 5. Progress data model

Display milestone/task counts by verified state, work in progress, blocked reasons, active attempt and task ages. When optional percentage is shown, compute from **accepted work units** with explicit estimate weights and caveat; never infer 90% from response length. Persist a change log for reprioritizations and dependency edits, and include the user who authorized them.

## 6. Parallelism (later phase)

Introduce one Git worktree per concurrent Worker and a path ownership registry. Scheduler must avoid overlapping file-lock scopes, track parent branch and base commit, and require controlled patch integration and tests before merge. Parallel dispatch should be disabled if the repo isn't isolated or the worker's change footprint is unknown and cannot be safely partitioned.

## 7. Scheduling pseudocode

```text
on_work_available(project):
  if pair.mode not allowed or pair.paused_or_stopped: return
  ready = graph.filter_dependencies_done_and_not_blocked()
  ranked = deterministic_priority_order(ready)
  for task in ranked:
    if !policy.authorize(task, DISPATCH): continue
    route = ranker.best_qualified_free_route(task)
    if route == NONE: block(task, NO_ELIGIBLE_MODEL); continue
    if atomically_claim(task, exact_worker, route):
      persist_intent_and_dispatch_once(task)
      return
```

## 8. Verification cases

**SCH-01** cyclic dependency rejected; **SCH-02** unmet dependencies cannot reach READY; **SCH-03** two claims produce only one successful attempt; **SCH-04** P0 cannot bypass unknown price; **SCH-05** restart does not create duplicate dispatch; **SCH-06** Worker report cannot directly close task; **SCH-07** paused pair never starts a new assignment.
