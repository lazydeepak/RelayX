# RX-06 — Model Evaluation, Ranking & Task Routing

**Version:** 0.1 · **Status:** Proposed empirical model-selection system · **Parent:** Architecture v0.1 §8 · **Diagrams:** D04, D08

## 1. Separate availability from ability

Catalog metadata provides candidates. The eligibility validator determines whether this account can use the exact route at $0. The evaluator determines whether the endpoint can reliably complete a specific role and task class. The scheduler chooses among **qualified** routes, balancing predicted verified completion time with scarce free quotas.

**REQ-22:** Model ranking must distinguish Supervisor planning, Planner reasoning, coding, debugging, frontend implementation and tool/question reliability.  
**REQ-23:** A success means verified and accepted artifacts, not a model statement claiming completion.  
**REQ-24:** Show sample size, evidence recency and uncertainty; do not treat 2/2 as proven reliability.

## 2. Reproducible evaluation lanes

| Lane | Benchmark example | Ground truth |
|---|---|---|
| Requirement intake | vague goal → milestone/task DAG | missing requirements, legal DAG, risk escalation |
| Planner | multi-file fix strategy with constraints | plan feasibility, scope, correct dependency ordering |
| Coding | seeded bug in minimal repo | hidden tests, lint, diff boundaries |
| Debugging | failing integration fixture | root-cause detection, verified regression fix |
| Tool use | edit/test/permission/question tools | correct calls and no disallowed operations |
| Frontend | accessible responsive component | UI tests, accessibility and layout checks |
| Recovery | ambiguous delivery or bad report | Planner-first and no blind resend |

Fixtures must be versioned, isolated, deterministic where possible, and not presented with hidden tests. Each run records model config, prompt template, context size, available tools, timeout, repo base digest, acceptance checks, decision and provider/account route.

## 3. Scoring and uncertainty

**Provisional score**, normalized components in `[0,1]`:

```text
0.45 × verified_success_rate
+ 0.20 × valid_tool_call_rate
+ 0.15 × completion_speed_score
+ 0.10 × recent_provider_availability
+ 0.10 × free_quota_efficiency
```

These weights are heuristics, not empirical scientific facts. Compute role/task-specific estimates. Publish sample count, success count, confidence interval (e.g., Wilson lower bound), recency decay, and fixture coverage. A route must pass hard eligibility **before** ranking. Conservative confidence-adjusted routing should usually outperform naive 'highest percentage' selection on small samples.

**DESIGN-16:** Record failure reasons separately (incorrect code, invalid tools, provider outage, quota, security violation, human correction) rather than treat all failures identically.  
**DESIGN-17:** Keep a holdout fixture subset unavailable to prompts. Avoid evaluation contamination and output-only gaming.  
**DESIGN-18:** For routing, optimize expected *time to verified outcome*, not raw token speed or prompt cost.

## 4. Routing algorithm

1. Read Task class, risk, required languages, tool support, context, latency target, acceptance criteria and repo privacy.
2. Query RX-05: filter only live verified-free exact endpoints with quota and policy permission.
3. Query benchmark/evidence inventory: retain routes with adequate qualification for Task risk. If insufficient evidence, request bounded evaluation or human approval—not silent assumption.
4. Compare conservative expected success, estimated completion time, tool reliability and quota opportunity cost.
5. Persist chosen route, runner-ups, selection rationale, qualification version and quota reservation.
6. Send through the Engine; when a failure occurs, route back to Planner. Another model is **not** an automatic retry.

## 5. Quota allocation and evaluation budget

Free requests are finite capacity. Do not benchmark every model on every startup. Trigger a small probe on: promising newly discovered endpoint; material model/runtime revision; stale prior qualification; failure drift; or targeted low-confidence high-value Task class. Provide a per-project quota slice for evaluation distinct from execution. No experimentation may deplete the only available route for critical active work without prior policy agreement.

## 6. Production feedback and anti-selection bias

Store all attempted outcomes, including timeouts and unverified failures. If a route is selected only for easy tasks, its high success rate must not be compared unadjusted to a route assigned difficult tasks. Record task difficulty/risk features and compare similar task groups. A manual repair after model work is evidence of partial failure, not an independent full success.

## 7. Ranking UX

For every model show: exact provider and endpoint, free-entitlement expiry, permitted project types, verified-task success fraction, sample count, confidence, recent latency, quota remaining (or unknown), tool compatibility, last benchmark and a clickable decision explanation. Distinguish `Listed`, `Verified free`, `Qualified`, `Available now`, and `Recommended` badges; these are not equivalent.

## 8. Test plan

**EVAL-01** unqualified route cannot outrank a qualified one; **EVAL-02** two runs report low confidence; **EVAL-03** hidden tests fail despite polished response → failed; **EVAL-04** quota exhaustion blocks choice; **EVAL-05** changed model configuration requires new qualification; **EVAL-06** invalid tool call reduces reliability; **EVAL-07** model-switch-after-failure requires Planner decision; **EVAL-08** model ranking includes provenance and version.
