# ATTEMPT LIFECYCLE — Minimal State Design (Core / Shared / Plan-First boundary)
# Frozen: domain state dimensions and transition rules
# Unfrozen: exact DB enum names, SQLite column types, planner protocol parsing

## 0. Design Principle

Avoid one giant `AttemptStatus` enum that mixes physical, verification, dispatch, and semantic states.

Use **orthogonal dimensions** that can vary independently. The Attempt is the physical execution instance; verification is separate; dispatch uncertainty is separate; assignment resolution is derived.

## 1. State Dimensions

### Dimension A — Physical Execution State (Attempt itself)

| State | Meaning | When entered / exited |
|---|---|---|
| `prepared` | Durable dispatch intent stored; external send not yet performed or confirmed | After `prepareAttempt()` + `recordDispatchIntent()`; before `confirmDispatch()` |
| `dispatched` | External dispatch completed; delivery acknowledged or uncertain | After `confirmDispatch()`; if uncertain, remains `dispatched` with `dispatchUncertainty = uncertain` |
| `executing` | Physical worker is running / performing bounded work | After dispatcher confirms execution started; exits on `recordExecutionCompleted()` or `interruptAttempt()` |
| `completed_physical` | Worker physically finished (output produced, session shows complete, or inspection confirms) | `recordExecutionCompleted()`; must NOT require verification to enter |
| `interrupted` | Runtime/process lost mid-work; execution suspended; repository mutations survive | `interruptAttempt()`; recovery inspects; does NOT assume rollback |
| `rejected_evidence` | Evidence from obsolete/invalid authority arrived; retained, not applied | After authority validation failure on incoming evidence; current state unchanged |

### Dimension B — Verification State (separate, linked to Attempt)

| State | Meaning |
|---|---|
| `unverified` | Physical execution completed or interrupted; verification not yet performed |
| `verification_passed` | Deterministic verification succeeded (tests, checks, fingerprints match criteria) |
| `verification_failed` | Deterministic verification failed; physical execution may still be complete |
| `verification_inconclusive` | Verification could not be fully performed (partial evidence, missing inputs) |

**Rule:** Verification state does NOT change physical execution state. A completed physical attempt with failed verification remains `completed_physical`; verification = `verification_failed`. Assignment remains unresolved.

### Dimension C — Dispatch Uncertainty (separate from physical)

| State | Meaning | Reconciliation rule |
|---|---|---|
| `intent_stored` | Durable intent exists; external delivery status unknown (crash before send or before ack) | After restart: compare durable intent against external correlation; never blindly resend |
| `dispatch_confirmed` | External delivery acknowledged (provider evidence, session marker, UI observable) | Normal path |
| `dispatch_uncertain` | External send likely occurred but acknowledgment lost; reconciliation required | Must compare against provider ground truth; may need operator selection if ambiguous (section 10; existing ambiguous-delivery guard) |

**Rule:** Uncertainty is reconcilable, never armed with blind resend. `recordDispatchIntent()` stores durable intent; `confirmDispatch()` records acknowledgment; `markDispatchUncertain()` records lost acknowledgment.

### Dimension D — Assignment Resolution (derived, not Attempt property)

Derived from Attempt dimensions + verification + (optionally) planner semantic acceptance.

| State | Condition |
|---|---|
| `unresolved` | Any of: physical execution ongoing/interrupted; verification failed/inconclusive; semantic acceptance not granted |
| `resolved` | Physical = `completed_physical` AND verification = `passed` AND (semantic acceptance granted if required by contract / milestone) |

**Rule:** A failed Attempt (`interrupted`, `completed_physical` with `verification_failed`) does NOT automatically make Assignment `failed`. Assignment stays `unresolved`; planner/agent decides retry/change/escalate/cancel (architecture sections 3, 13, 15).

## 2. Explicit Case Resolution

### Case 1 — Prepared but not externally sent

- **State:** A=`prepared`; C=`intent_stored`
- **Crash behavior:** Durable intent preserved. External send not performed.
- **Reconciliation:** After restart, check durable intent against external state. If no external correlation found, attempt to complete send or ask operator. **Never resend blindly.**
- **Transition:** `prepareAttempt()` → `recordDispatchIntent()` → (after restart) reconcile → `confirmDispatch()` or `markDispatchUncertain()`

### Case 2 — External send may have happened

- **State:** A=`dispatched`; C=`dispatch_uncertain` (or `intent_stored` if acknowledgment lost very early)
- **Crash behavior:** External UI side effect may have occurred; SQLite persistence may not have acknowledged.
- **Reconciliation:** Use external correlation mechanism (provider ground truth: session identity, message marker, fingerprint, observable UI evidence — section 10; mechanism unfrozen, rule frozen). Compare durable intent record against observable evidence.
- **Outcome:** Confirmed delivery → `dispatch_confirmed`; unconfirmed / ambiguous → remain uncertain; if ambiguous and no operator selection, hold (existing behavior from recovery: recovery unavailable if ambiguous deliveries > 1).
- **Rule:** Must become reconcilable uncertainty, never blind resend.

### Case 3 — Worker physically finishes

- **State:** A=`completed_physical`
- **Rule:** Must enter this state regardless of verification or planner review timelines. If planner review takes days, physical state does NOT stay `running`. The Attempt records physical truth; verification and semantic review are downstream.
- **Evidence:** Worker session inspection / provider evidence / handoff / response snippet recorded.
- **Assignment:** Remains `unresolved` until verification + semantic completion.

### Case 4 — Mechanical verification fails

**Decision:** Physical Attempt remains `completed_physical`; verification dimension = `verification_failed`; Assignment = `unresolved`.

**Rationale:** Attempt = one physical execution instance (architecture section 3, 12, 13). The physical execution completed; what failed was the deterministic evaluation against criteria. The Planner / Plan-First Agent / human decides whether to retry with new strategy, change approach, escalate, or declare failure — but the Engine does not automatically declare Assignment failed based solely on verification failure.

This separates worker claim (done) from correctness (verified). It avoids the contradiction where a technically-completed-but-wrong execution is left in ambiguous state.

### Case 5 — Runtime dies mid-work

- **State:** A=`interrupted`
- **Repository:** Remains real; mutations survive (I11 confirmed). Engine must NOT assume rollback or revert mutations automatically.
- **Recovery:** `recoverOnStartup()` inspects worker runtime; if not found, marks suspended. Must inspect repository state (git / dirty / changed files) and communicate structured result, not assume clean state.
- **Transition:** `interruptAttempt()` records interruption + reason; recovery may later resume or start new attempt under new authority.

### Case 6 — Old worker/session reports completion after replacement

- **State of old Attempt:** If frozen authority = old session, and old session reports completion — evidence is evaluated against frozen authority. If attempt hasn't reached `completed_physical`, this may complete it. But since session was replaced, typically the Assignment should transition to new Session Pair via explicit adoption (Part 3), and a new Attempt under new authority should be created.
- **For evidence arriving for a CURRENT/NEW attempt:** Old session evidence is validated against frozen `workerSessionId` of the new attempt. If mismatch → evidence rejected; retained as `rejected_evidence`; current state unchanged.
- **Rule:** Evidence from obsolete execution authority (mismatched frozen `workerSessionId` / `sessionPairId`) must not mutate current state.

### Case 7 — Planner response arrives for obsolete Attempt

- **State of target Attempt:** Could be `completed_physical`, `interrupted`, `failed`, or replaced by new attempt under new pair.
- **Action validation:** `[RELAYX_ACTION]` validated against frozen attempt identity and current execution authority. If attempt is obsolete (completed/interrupted/replaced/authority changed): **action rejected**.
- **Persistence:** Rejection recorded in planner-action evidence (stale-action rejection retained). No state mutation.
- **Rule:** Ordinary planner prose is non-authoritative; structured action must match current authoritative context. Invalid/stale actions rejected and retained as evidence (I7 / Section 7 / Section 9).

## 3. Transition API (conceptual, not DB schema)

For engine design (sections 23, 24):

- `prepareAttempt(assignmentId, sessionPairId, workerSessionId)` → freeze authority
- `recordDispatchIntent(attemptId, correlationReference, dispatchEvidence)` → durable intent
- `confirmDispatch(attemptId, deliveryEvidence)` → external delivery confirmed
- `markDispatchUncertain(attemptId, reason, inspectionEvidence)` → reconciliation required
- `recordExecutionCompleted(attemptId, executionEvidence)` → A = `completed_physical`
- `recordVerificationResult(attemptId, result, verificationEvidence)` → B updated; A unchanged
- `interruptionAttempt(attemptId, reason, inspectionEvidence)` → A = `interrupted`
- `failPhysicalAttempt(attemptId, failureReason, evidence)` → A = `interrupted` or `completed_physical` + failureReason (depending on whether worker completed but result wrong — see Case 4)
- `requestPlannerAssistance(attemptId, reason, evidence, question)` → assist channel
- `applyPlannerAction(actionRequest)` → validated against frozen authority + current state; rejected if stale/invalid

**Note:** `failPhysicalAttempt()` and `recordExecutionCompleted()` are separate from `recordVerificationResult()`. A physical failure (crash, timeout, runtime death) is `interrupted`; a completed-but-wrong result is `completed_physical` + `verification_failed`.

## 4. Adversarial Confirmation — Dimensions (Part 3 review)

All 4 dimensions confirmed with revisions:
- Dispatch: linked to Attempt (intent/delivery) but must not duplicate Delivery evidence; Attempt captures authority-bound dispatch state, Delivery captures observable evidence.
- Physical execution: only worker execution states (`prepared` / `dispatched` / `executing` / `completed_physical` / `interrupted`). No verification/semantic states encroached.
- Verification: separate entity/record linked to Attempt; not embedded as single enum value.
- Assignment resolution: derived from Attempt dimensions + verification + optional semantic acceptance. Confirmed NOT an Attempt state.

## 5. Mechanical Failure Case — Confirmed (Part 3)

Worker physically finishes (`completed_physical`); deterministic verification fails (`verification_failed`).

Canonical result:
```text
Attempt.execution = completed_physical
Attempt.verification = failed
Assignment = unresolved
```

Reason: Attempt = physical execution instance (§3, §12, §13). Physical completion does not prove correctness; verification failure does not mean physical execution was wrong (it completed); Assignment must remain unresolved until planner/agent decides retry/change/escalate/cancel.

If any earlier design had Attempt status switch to `failed` on verification failure, that design is REJECTED — it conflates verification with physical execution.

---

## 6. Unfrozen representations

- Exact enum names for states (proposed above; could be strings, code values, or table rows)
- Whether `dispatched` / `executing` / `completed_physical` are in one status field or multiple status fields
- Whether verification is a linked record (`verification_results` table) or embedded fields
- Whether dispatch uncertainty is embedded or a `dispatch_intents` table
- Whether physical state + verification + dispatch are three fields on Attempt or three linked entities
- The structured message format for planner updates / assists / actions (Section 4–7; unfrozen format)

## 5. Consistency with existing entities

Current `AttemptStatus` is likely `'running' | 'completed' | 'failed' | 'interrupted'`. This conflicts with the orthogonal design because:

- `'completed'` conflates physical completion with verification acceptance
- `'failed'` conflates physical failure (interruption) with verification failure
- `'running'` does not distinguish `executing` from `dispatched` or `prepared`
- No `verification_failed` or `verification_passed` dimension exists
- No `dispatch_uncertain` exists

The architecture (section 12, 13, 23) requires separation; current entity is simplified. Freeze the domain separation here; physical schema can migrate.
