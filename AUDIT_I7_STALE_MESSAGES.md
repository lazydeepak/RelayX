# I7 STALE-MESSAGE AUDIT — Verified against src/ (commit 9146719)

## 1. How worker completion evidence reaches RelayX
- Delivery / Handoff entities exist (entities.ts 387-571).
- Engine has delivery recording (search for recordDelivery / confirmDelivery).
- No dedicated "execution completed" transition; Attempt.complete() is called directly on entity.
- Evidence stored in Attempt.evidence (ObservableEvidence) — mutable reference, not frozen snapshot.

## 2. How Planner responses are associated with current execution
- No [RELAYX_ACTION] parser or handler exists in engine or service.
- No planner-action persistence table (no planner_actions / action_requests in sqlite schema).
- Events (RelayEvent) persist resourceId + eventType + details, but no structured action-correlation mechanism.
- Planner responses enter via casual UI/prose; engine never validates authority context before applying.

## 3. Old Session Pair messages affecting newer work
- Pair.updatePair() mutates plannerSessionId / workerSessionId in place (entity.ts 410-474, engine line 410-474).
- No pair versioning or replacement-pair creation; old pair identity preserved but session refs overwritten.
- Events emit 'pair.updated' / 'runtime.replaced' / 'runtime.attached' / 'runtime.detached', but no stale-message guard prevents old event details from being misread.
- Assignment links to pairId (immutable in entity, though DB allows updates). If pair sessions changed, assignment's execution context doesn't automatically freeze.

## 4. Old Attempt evidence affecting current Assignment state
- Attempt has status, finishedAt, failureReason, evidence.
- Assignment.currentAttemptId points to latest attempt.
- No guard preventing old Attempt evidence from being applied to current assignment state.
- Attempt.evidence is a mutable object reference; replacing it would mutate historical evidence.
- No "execution authority" frozen on Attempt (no sessionPairId / workerSessionId / dispatchIdentity fields on Attempt today).

## 5. Structured Planner actions — authority context
- No [RELAYX_ACTION] vocabulary implemented.
- No validation of: Project identity, Session Pair identity, Assignment identity, Attempt identity, current authority, stale-message status, legal state transition.
- No persistence of rejected actions.

## 6. Persistence required for stale-action rejection
- Required: planner_action_requests table (requestId, projectId, sessionPairId, assignmentId, attemptId, requestedAction, authorityContext, receivedAt, rejectedAt, reason, correlationId).
- Required: execution_authority record frozen on Attempt (sessionPairId, workerSessionId, dispatchIdentity, frozenAt).
- Required: stale-message guard using (resourceId + eventType + correlationId + timestamp window) rather than message content only.

CONFIRMED GAP: All six checks show missing mechanism. No stale-action rejection, no frozen execution authority on Attempt, no structured planner action protocol.
