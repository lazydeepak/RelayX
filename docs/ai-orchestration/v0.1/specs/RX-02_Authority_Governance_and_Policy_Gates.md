# RX-02 — Authority, Governance & Policy Gates

**Version:** 0.1 · **Status:** Proposed control specification · **Parent:** Architecture v0.1 §§3, 5–6 · **Diagrams:** D01, D05, D07

## 1. Threat model and principle

An LLM may misunderstand instructions; a repository file, fetched webpage, tool output or Worker report may contain malicious text. No prompt can serve as a hard permission barrier. RelayX must evaluate each sensitive state-changing action in a deterministic Policy Engine before the action executes and record the policy version and decision.

**REQ-07:** User-defined boundaries and system invariants outrank any AI-generated instruction.  
**REQ-08:** The Engine alone may claim tasks, commit transitions, authorize dispatch and enforce costs.  
**REQ-09:** Failures cannot directly re-arm a Worker; a Planner decision is required before any corrective Worker assignment.  
**REQ-10:** Hard zero-paid-inference limits include Planner, Supervisor, Workers, evaluators and fallbacks.

## 2. Normative authority table

| Actor | Can propose or perform | Cannot bypass |
|---|---|---|
| Human | Project goals, policies, priorities, approvals, pause/stop | System data-integrity invariants |
| Supervisor | Intake, reprioritization proposal, task coordination, status reporting | Planner technical decision, spending, engine gates |
| Planner | Technical plan, bounded assignment instructions, Worker review, recovery decision | Hard cost/security fences, direct provider dispatch |
| Engine | Exclusive task claim, policy decisions, dispatch, evidence-state transitions | Honest uncertainty and idempotency boundaries |
| Worker | Allowed scoped read/edit/build/test commands | Project root, secret rules, independent retries/reassignments |
| Model Router | Propose qualified model route based on task | Unknown cost or prohibited provider endpoint |

The policy evaluator should accept **actor + action + target + context + effective policy version** and return an auditable `{decision: ALLOW | DENY | NEED_APPROVAL, reasons, conditions}`. `UNKNOWN` external entitlement is treated as DENY in Zero-Cost Mode.

## 3. Policy inheritance

Evaluation order: **system invariants → global policies → project policies → task/assignment policies → Worker instructions**. Lower layers may narrow authority but not broaden it. Policy changes are explicit revisions, never retroactively rewrite an attempt's effective rules. A new approval cannot erase a historic violation.

**DESIGN-04:** Require an approval artifact for dangerous operations: policy id, user identity, operation class, scope/worktree, expiry, one-time/multi-use, risk statement and audit event.  
**DESIGN-05:** Default-deny `git push`, production deployments, privileged shell, deleting broad paths, reading credentials, network exfiltration and writes outside assigned worktree.  
**DESIGN-06:** Validate permissions in both RelayX and the runtime/OS. OpenCode permission prompts alone cannot guarantee container-level sandboxing.

## 4. Seven gates

| Gate | Preconditions | Denial / next owner |
|---|---|---|
| G1 PLAN | goal/scope, dependencies, acceptance, Planner identity | Planner revises |
| G2 PRIORITY | ready, unlocked, not suspended, user priority respected | Scheduler retains backlog |
| G3 MODEL | exact endpoint/account free, context/tools, region/privacy, quota | Router alternatives or BLOCKED |
| G4 DISPATCH | approved payload, exact session, idempotency, locks, slot free | Engine prevents send |
| G5 EXECUTION | allowed path/tools/network/limits | Engine stops or pauses, preserves evidence |
| G6 VERIFY | artifact/test/reviewer evidence linked to attempt | Planner correction or explicit uncertainty |
| G7 RECOVERY | known incident, Planner decision, fresh authorization | Remain BLOCKED |

A high task priority must never bypass any of these. Emergency tasks can preempt *future scheduling* but cannot overwrite an in-flight attempt without an explicit stop/abort protocol.

## 5. Operating modes

- **Manual:** recommendations only; user explicitly initiates dispatch.
- **Assisted:** Planner structures assignments; user approves each send.
- **Controlled Auto:** the Engine dispatches previously Planner-authorized bounded work inside all gates; human receives escalations.
- **Autonomous (future):** broader scheduling/replanning under unchanged immutable fences; significant goal/risk changes still require approval.

**DESIGN-07:** Defaults should be `Controlled Auto` only after proving one-pair durability; otherwise start `Assisted`. Mode transitions produce auditable events and cannot affect already-running attempts without safe reconciliation.

## 6. Policy examples (illustrative only)

```yaml
mode: controlled_auto
ai_cost: {paid_usd_limit: 0, unknown_price: deny, paid_fallback: deny}
source_code: {egress: approved_providers_only}
execution:
  active_attempts_per_pair: 1
  repo_root: exact_bound_repository
  outside_worktree_write: deny
  production_deploy: needs_human_approval
recovery: {authority: planner, ambiguous_resend: deny}
```

This is conceptual configuration, not an existing RelayX parser. The Engine must validate schema, store a hash/version and reject unknown critical fields rather than ignore them.

## 7. Acceptance tests

- **POL-01:** AI asks to raise paid budget → DENY even with attractive explanation.
- **POL-02:** Child task rule weakens project privacy → DENY.
- **POL-03:** Worker tries to read a secret outside its workspace → denied by tool/OS fence.
- **POL-04:** Same action with expired approval → NEED_APPROVAL, not ALLOW.
- **POL-05:** Running mode change blocks new work while preserving in-flight evidence.
- **POL-06:** User-supplied priority remains locked during Supervisor reprioritization.
