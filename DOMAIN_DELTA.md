# DOMAIN DELTA — Updated with Core/Shared freeze (Part 1 — Execution Authority, Repository Baseline, Planner Action Authority)
# Classifications per section 20.
# Frozen: A (Execution Authority), B (Repo Baseline), C (Planner Action Authority)
# Unfrozen: Contract Revision form, Strategy Lineage, retry-budget, dispatch-correlation, DB layout

## CORE — Attempt Execution Authority
- Add to Attempt (or linked immutable value): executionAuthority = { sessionPairId, workerSessionId, dispatchIdentity, frozenAt }
- Add transition guard: any attempt mutation/replacement must verify frozen authority; replacement session cannot advance old attempt
- Add persistence: execution_authority table or frozen fields on attempts; replay protection on evidence mutation

## CORE — Session Pair Reference on Execution
- Ensure Attempt records exact sessionPairId at dispatch (currently missing)
- Ensure Pair replacement creates new pair rather than mutating old (preserve historical identity for assigned attempts)
- Add pair_version / replacement tracking if needed

## CORE / SHARED — Physical Attempt Lifecycle
- Explicit Engine transitions: prepareAttempt() → recordDispatchIntent() → confirmDispatch() / markDispatchUncertain() → recordExecutionCompleted() → recordVerificationResult() → failAttempt() / interruptAttempt()
- Separate worker claim from verification; separate verification from assignment completion

## CORE — Dispatch-Intent Lifecycle
- New persistence: dispatch_intents (id, attemptId/assignmentId, projectId, sessionPairId, dispatchedAt, confirmedAt, uncertainAt, correlationMechanism, deliveryEvidence)
- External correlation mechanism must be established (provider ground truth: message marker / session identity / fingerprint / observable UI evidence — section 10; not frozen yet)
- Reconciliation after restart compares durable intent against inspection evidence, not just creates Handoff

## SHARED — Repository Snapshot & Boundary
- Add to Attempt or linked: repoBaseline = { HEAD, dirtyState, expectedWrites, observationLedger, frozenAt }
- Add repository observation evidence link; dependency discoveries extend ledger without rewriting dispatch truth
- Recovery must inspect repo state (git status / dirty / changed files) and communicate structured result to planner / recovery logic (currently missing — I11 gap)

## SHARED — Verification Result
- Separate from Attempt.complete(); new entity/table: verification_result (attemptId, result, evidence, timestamp, stage: deterministic / semantic)
- Assignment completion requires both physical execution complete + verification passed + semantic acceptance (where required) — section 12

## PLAN-FIRST — Contract Revision Reference
- Add contractRevision reference to Attempt (contractDigest / revisionId / intentDigest)
- Contract digest represents semantic intent, not raw formatting; whitespace/unrelated edits don't invalidate; meaningful change requires new attempt/revision
- Decision needed: linked entity, value object, or normalized representation (section 14)

## PLAN-FIRST — Strategy / Failure Lineage
- Add strategy identity per milestone (strategyId, strategyDigest, declaredAt)
- Add to Attempt: strategyLineage (parentStrategyId, attemptNumberWithinStrategy, replans, strategyHistory)
- Add budget enforcement: attempts per strategy, strategies per assignment, autonomous replans per milestone — configuration/policy, not hard-coded

## SHARED / PLAN-FIRST — Progress Evidence
- Structured progressEvidence on Attempt / Assignment: comparisonFingerprint (same strategy + same failing checks + same error fingerprint + same repo diff + no new evidence = no_progress_evidence)
- Engine may identify; must not conclude semantic equivalence

## SHARED — Structured Planner Messages (Protocol)
- Parser / handler for [RELAYX_MODE], [RELAYX_UPDATE], [RELAYX_ASSIST], [RELAYX_ACTION]
- Each must carry: projectId, sessionPairId, assignmentId, attemptId, correlationId, timestamp
- Updates informational; assist requests evidence-backed narrow questions; actions validated against current execution authority
- Invalid/stale actions rejected and persisted as evidence (stale_action_rejection table or event)

## SHARED — Stale-Action Authority Validation
- Persistence: planner_action_requests (requestId, resourceIds, requestedAction, authorityContext, receivedAt, applied/rejectedAt, reason, correlationId)
- Validation rules (section 7 / I7): verify Project / Session Pair / Assignment / Attempt identity; current execution authority; stale-message status; legal state transition; core invariants; invalid/stale actions rejected and retained

---
# CARTINALITY / REPRESENTATION DECISIONS STILL NEEDED (before DB freeze)
- Contract Revision: entity vs value object? (history + cardinality)
- Execution Authority: frozen fields on Attempt vs separate authority table?
- Strategy Lineage: separate strategy table + attempt linkage?
- Plan-First Protocol: message storage vs event-only? (stale-action rejection requires durable record)
- Repository Baseline: snapshot table vs reference to external repo state?
- Dispatch Correlation: which mechanism (provider-specific)? Section 10 explicitly unfrozen.

---

# PART 1 FREEZE — Core / Shared Representation Decisions (added at end)

## A. EXECUTION AUTHORITY — FREEZE (from EXECUTION_AUTHORITY.md)
- Frozen on Attempt at dispatch: sessionPairId, workerSessionId, providerExternalRef (optional cross-check only), frozenAt.
- execution_epoch REJECTED; exact identity fields are sufficient.
- Authority validation: verify frozen pair + worker match current before mutation; reject if mismatch.
- Evidence must not be mutable reference; replay/replacement must not mutate current attempt.
- Contradictions documented (Attempt missing sessionPairId, workerSessionId, frozenAt; mutable evidence).

## B. REPOSITORY EXECUTION BASELINE — FREEZE (from ATTEMPT_LIFECYCLE.md / arch 11, 12)
- Concept: repo execution state belongs to / referenced by Attempt.
- Minimum conceptual baseline (DB form unfrozen): HEAD/revision; dirtyState; expectedWrites/dependencies; contractSource refs; verificationInputs; observationLedger (extendable); frozenAt.
- Must not be rewritten by dependency discoveries; observations extend ledger.
- Recovery must inspect repo state, not assume rollback (I11 gap).
- Unfrozen: snapshot table vs JSON vs external reference.

## C. PLANNER ACTION AUTHORITY — FREEZE (from EXECUTION_AUTHORITY.md / I7 audit)
- Durable planner-action request concept sufficient for stale-message protection.
- Must carry: projectId, sessionPairId, assignmentId, attemptId (where applicable), requestedAction, assistingRequestIdentity, authorityContextAtTime (snapshot of frozen execution authority), outcome (requested/rejected/applied/stale), evidence/reason, correlationId, receivedAt/rejectedAt/appliedAt, rejectingReason.
- Ordinary prose non-authoritative.
- [RELAYX_ACTION] is request to Engine, not unconditional command.
- Validation frozen: verify resource identity; verify current execution authority; verify not stale (correlation/sequence); verify legal transition; invalid/stale = rejected + retained as evidence.
- Unfrozen: message parsing format, DB table/columns, exact timestamp window for stale detection.

---

# DECISIONS DELIBERATELY LEFT UNFROZEN
- Contract Revision physical storage (entity/value/table — section 14)
- Strategy Lineage physical storage / budget schema (section 15)
- Retry/replan budget schema (configuration/policy)
- Dispatch-correlation mechanism / visible marker format (provider ground truth — section 10)
- DB layout / SQLite columns / migrations (section 22 — after freeze)
- Engine transition API exact names / params (section 23 — derived from matrix)

---

# PART 2 FREEZE — Assignment ↔ Session Pair Ownership (Part 2 adversarial review)

## Model frozen: Model A with explicit adoption (recommended)

Canonical: Project → Session Pair → Assignment → Attempt.
Assignment `pairId` is origin/current execution Pair reference (immutable for historical identity).

## Decision — `pairId` immutable
- `Assignment.pairId` remains immutable (matches current entity design; DB `ON DELETE CASCADE` already links history).
- Historical assignment identity preserved even when session changes.

## Decision — Continuation under replacement Pair requires explicit action
- Old Pair preserved; old Attempt frozen to old Pair.
- If objective continues: either (a) new Assignment under replacement Pair, or (b) explicit adoption with audit trail (not silent mutation).
- Recommendation: new Assignment under new Pair for continuation; avoids mutating `pairId`.

## Scenario resolutions (7 cases)
1. OpenCode replaced by VS Code → new Pair; old Assignment preserved; new work = new Assignment if adopted
2. ChatGPT replaced by Claude → same; old Pair preserved
3. Both replaced → same
4. Attempt running when replacement Pair created → old Attempt completes under old authority; new Pair gets new Attempt for continuation
5. Attempt interrupted; continues through replacement → interrupted preserved; new Attempt under new Pair if adopted
6. Old Pair available again → historical reference intact; assignment stays with its Pair
7. Brand-new objective after replacement → new Assignment naturally under current/new Pair

## Unfrozen
- Whether continuation requires new Assignment vs explicit adoption update (depends on whether `pairId` stays immutable — frozen as immutable; new Assignment recommended)
- Exact UI/engine adoption transition API (section 23 — derived from freeze)
