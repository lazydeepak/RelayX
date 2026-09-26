# P0 CONSOLIDATED MATRIX — RelayX (derived from architecture baseline + code audit @ 9146719)
# Source: sections 1-26 of Final Architecture Baseline; I7/I11 audits against src/
# Ownership classification per section 20.

## Invariant 1 — Project Identity & Ownership
- Current model: Project entity (id, name, canonicalPath, gitRoot, plannerProjectUrl, workerWorkspacePath, status)
- Current transition: createProject / updateProject / archiveProject; pairing validates against plannerProjectUrl / workerWorkspacePath (RelayApiService createPair 377-428)
- Current persistence: SQLite projects table; saved bindings in project row
- Current tests: domain.test, project workflow tests
- Confirmed gap: No explicit ownership-transition guard preventing project identity mutation during active assignment; plannerProjectUrl treated as binding authority without versioned provenance
- Required property: Project identity immutable for active Session Pair / Assignment context; binding changes must create new pair or be explicitly reconciled
- Ownership: CORE / SHARED (pairing authority depends on it)
- Adversarial P0 test: Change plannerProjectUrl on active project; attempt to pair old session — must reject or create new pair, never silently rebind

## Invariant 2 — Session Pair Exact Relationship
- Current model: Pair entity (id, projectId immutable, plannerSessionId optional, workerSessionId optional, activeAssignmentId optional, status, lastSupervisedAt)
- Current transition: updatePair mutates session refs in place (engine 410-474); no replacement-pair creation
- Current persistence: pairs table; triggers null session refs on runtime deletion
- Current tests: pairing/association persistence tests; audit report covers replacement behavior
- Confirmed gap: Replacement updates same Pair, does not preserve historical Session Pair identity independently (contradicts target: "old pairs and assignment history remain intact" implies new pair on replacement). No pair versioning.
- Required property: Session Pair is exact, history-bearing; session replacement creates/adopts replacement pair; old pair survives with history
- Ownership: CORE
- Adversarial P0 test: Replace planner session on active pair; verify old pair preserved, new pair created, assignment history linked correctly

## Invariant 3 — Assignment Durable Objective
- Current model: Assignment (id, pairId immutable, projectId, title, instruction, status, currentAttemptId, activeDeliveryId, activeHandoffId, completedAt)
- Current transition: createAssignment; clearWork clears activeAssignmentId but preserves assignment; deletePair cascades
- Current persistence: assignments table; ON DELETE CASCADE from pairs
- Current tests: engine / assignment lifecycle tests
- Confirmed gap: Assignment survives attempt failure (correct), but no strategy/failure lineage recorded; no retry budget enforcement
- Required property: Failed Attempt must not automatically declare Assignment failed; planner/agent decides retry/change/escalate
- Ownership: CORE
- Adversarial P0 test: Fail attempt; verify assignment status remains unresolved; verify planner can retry/change/escalate

## Invariant 4 — Attempt Frozen Physical Truth
- Current model: Attempt (id, assignmentId, attemptNumber, status, startedAt, finishedAt, failureReason, evidence?
- Current transition: create / complete / fail / interrupt (entity methods); no execution-authority freeze
- Current persistence: attempts table (implied via schema; check persistence interfaces)
- Current tests: attempt lifecycle in domain/engine tests
- Confirmed gap: Attempt does NOT freeze sessionPairId / workerSessionId / dispatchIdentity / contractRevision. No guard against replacement session advancing old attempt. Evidence mutable reference. No verification-boundary separation from completion claim.
- Required property: Attempt binds to exact execution authority (session pair, worker session, dispatch identity) at dispatch; replacement worker cannot advance old attempt; evidence frozen
- Ownership: CORE / SHARED
- Adversarial P0 test: Replace worker session; attempt to complete old attempt — must reject; verify evidence not mutated

## Invariant 5 — Execution Authority Bound to Attempt
- Current model: None (missing entirely)
- Current transition: N/A
- Current persistence: N/A
- Current tests: N/A
- Confirmed gap: Confirmed by I7 audit and code inspection. No execution_authority record on Attempt or linked table.
- Required property: Attempt carries frozen execution-authority record (sessionPairId, workerSessionId, dispatchIdentity, frozenAt, contractDigest)
- Ownership: CORE
- Adversarial P0 test: Attempt dispatched under pair P1/work W1; pair updated to P2/W2; verify attempt still requires P1/W1 authority

## Invariant 6 — Dispatch Uncertainty & Reconciliation
- Current model: Delivery / Handoff entities; ambiguous delivery guard (engine 1172; recovery unavailable if ambiguous)
- Current transition: record dispatch intent / confirm / uncertain; reconcile after restart (recoverOnStartup creates Handoff if complete)
- Current persistence: deliveries / handoffs / events
- Current tests: delivery/restart/reconciliation coverage (audit report, persistence tests)
- Confirmed gap: No explicit dispatch-intent lifecycle (recordDispatchIntent / confirmDispatch / markDispatchUncertain) in engine API. Restart reconciliation creates Handoff from inspection but does not compare against durable dispatch intent. No external correlation mechanism frozen (message marker / session identity / fingerprint — section 10 says "must be determined from provider ground truth").
- Required property: Durable dispatch intent persisted; external correlation mechanism established; uncertain delivery reconciled after restart; no blind resend
- Ownership: CORE / SHARED
- Adversarial P0 test: Dispatch uncertain; restart; verify no duplicate dispatch; verify reconciliation compares against durable intent, not just inspection

## Invariant 7 — Repository Execution Boundary
- Current model: Project.canonicalPath; workerWorkspacePath; repository observations via provider
- Current transition: Attempt should execute against frozen repo context; evidence records observations; dependency discoveries extend observation ledger but don't rewrite dispatch truth
- Current persistence: No explicit repository-snapshot / baseline / expected-writes table
- Current tests: repository observation / verification in detail view models / provider tests
- Confirmed gap: No frozen repository baseline on Attempt; no expected-writes / actual-writes comparison mechanism; dependency discoveries could inadvertently mutate historical truth if not guarded
- Required property: Frozen repo baseline (HEAD / dirty state / expected writes) recorded per Attempt; mutations observed but don't rewrite dispatch; recovery communicates filesystem reality
- Ownership: SHARED
- Adversarial P0 test: Execute attempt with dirty repo; add unexpected mutation; verify attempt evidence records observation without rewriting boundary

## Invariant 8 — Execution Completion / Verification / Acceptance Separation
- Current model: Attempt.complete() / fail() / interrupt(); Assignment status; Handoff on recovery
- Current transition: Worker completion claim → physical execution completion → deterministic verification → semantic acceptance → assignment completion (section 12)
- Current persistence: Attempt status + evidence; assignment status; verification results not separated as distinct stage
- Current tests: verification / completion tests
- Confirmed gap: No explicit verification stage between physical execution and assignment completion. Attempt.complete() conflates worker claim with verified result. No separate verification evidence persistence.
- Required property: Distinct states: worker_claim_done / physical_execution_complete / verification_passed / verification_failed / semantic_accepted / assignment_resolved
- Ownership: SHARED
- Adversarial P0 test: Worker claims complete; verification fails; verify assignment not completed, attempt not falsely complete

## Invariant 9 — Plan-First Contract Revision Binding
- Current model: None (missing)
- Current transition: Contract revision must bind Attempt to exact approved intent (section 14)
- Current persistence: No contract / revision table
- Current tests: None
- Confirmed gap: Confirmed — no contract digest, no revision binding, no contract-change invalidation guard
- Required property: Attempt bound to contract digest (semantic intent, not raw formatting); meaningful intent change requires new attempt / revision; whitespace edits don't invalidate
- Ownership: PLAN-FIRST
- Adversarial P0 test: Modify contract whitespace; verify old attempt still valid; change acceptance criteria; verify new contract required

## Invariant 10 — Retry / Strategy Lineage & Budget
- Current model: Attempt.attemptNumber; Assignment.currentAttemptId
- Current transition: No strategy table; no budget enforcement (section 15)
- Current persistence: Attempts linked to assignment only
- Current tests: None for budget
- Confirmed gap: No strategy identity per milestone; no attempts-per-strategy / strategies-per-assignment / replans-per-milestone limits enforced
- Required property: Hierarchical lineage: milestone → strategy → attempts; deterministic budgets enforced; planner/agent decides semantic strategy; engine enforces budgets
- Ownership: PLAN-FIRST
- Adversarial P0 test: Exceed attempt budget for strategy; verify engine rejects new attempt; planner must change strategy

## Invariant 11 — Deterministic No-Progress Detection
- Current model: Attempt.failureReason / evidence; event history
- Current transition: No structured no-progress comparison (section 16)
- Current persistence: No progress-evidence / fingerprint table
- Current tests: None
- Confirmed gap: Engine can identify evidence (same failing checks, same error fingerprint, same repo diff, no new evidence) but has no structured comparison mechanism or threshold enforcement
- Required property: Structured comparison using declared strategy + verification fingerprints + repo diff + new evidence; engine may identify; must not conclude semantic equivalence
- Ownership: SHARED / PLAN-FIRST
- Adversarial P0 test: Same strategy + same failures + same repo + no new evidence → engine flags no-progress; planner must decide retry/change/escalate

## Invariant 12 — Planner Update / Assist / Action Protocol
- Current model: Events (RelayEvent) with resourceType/resourceId/eventType/details; AttentionItem; casual prose input
- Current transition: No [RELAYX_MODE], [RELAYX_UPDATE], [RELAYX_ASSIST], [RELAYX_ACTION] processing (sections 4-7)
- Current persistence: Events / attention items; no structured message parsing / correlation
- Current tests: None for structured protocol
- Confirmed gap: All protocol elements missing (confirmed by I7 audit). No stale-action validation. No planner-action authority context.
- Required property: Structured messages with project/session-pair/assignment/attempt IDs; updates informational; assist requests evidence-backed and narrow; actions validated against current execution authority; invalid/stale actions rejected and retained as evidence.
- Ownership: SHARED / PLAN-FIRST (protocol used by both; actions validated by core)
- Adversarial P0 test: Old [RELAYX_ACTION] for replaced attempt; engine must reject; confirm rejection retained in evidence

---
# SUMMARY OF CONFIRMED GAPS FROM I7 + I11 + CODE AUDIT
1. No frozen execution authority on Attempt (I7 / Inv 4 / 5)
2. No structured planner action protocol or validation (I7 / Inv 12)
3. No stale-message rejection persistence (I7 / Inv 12)
4. No pair replacement / versioning mechanism (Inv 2 — audit report)
5. No contract revision / strategy lineage / budget enforcement (Inv 9 / 10)
6. No explicit verification stage separated from completion (Inv 8)
7. No repository baseline / expected-writes comparison on Attempt (Inv 7)
8. No structured filesystem-state communication to planner/recovery (I11 / Inv 7 / 12)
9. No dispatch-intent lifecycle / external correlation frozen (Inv 6)
10. No no-progress structured comparison / threshold (Inv 11)
