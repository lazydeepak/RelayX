# RelayX Ground Truth — Pair Continuity & Runtime Lifecycle Audit

## 1. Executive Summary & Audit Scope

This document establishes the ground-truth baseline for RelayX's existing pair architecture, runtime binding observation, session lifecycle management, and execution state (`Assignments`, `Attempts`, `Deliveries`). It serves as Phase A of the Pair Continuity & `PairCheckpoint` implementation plan.

No behavioral or architectural modifications are introduced in this phase.

---

## 2. Existing Path Analysis

### 2.1 Pair Creation
- **Mechanism**: Initiated via UI wizard (`AddProjectWizard`, `PairModal`, or engine `createPair`).
- **Data flow**: Associates a `ProjectId` with a Planner `RuntimeSession` and Worker `RuntimeSession` (or single session depending on role).
- **Validation**: Enforces project-scoped validation, rejecting cross-project session bindings and unauthorized source provenances (`AUTHORITATIVE_ASSOCIATION_PROVENANCES` such as `discovery`, `adoption`, `setup`).

### 2.2 Pair Update / Rebind
- **Mechanism**: Modifies active runtime bindings for an existing Pair.
- **Constraints**: Currently replaces external session references on the Pair entity or runtime session repository. Rebind preserves the Pair ID while pointing to updated external session IDs.

### 2.3 Pair Detach
- **Mechanism**: Unbinds or detaches an external session or side from a Pair without destroying the underlying project or history.

### 2.4 Pair Archive
- **Mechanism**: Marks a Pair as archived in the lifecycle state machine.
- **Current Behavior**: Retains associated runtime session provenance, assignments, attempts, and deliveries. Does not currently create an automated continuation checkpoint.

### 2.5 Pair Activation / Pause
- **Mechanism**: Controls whether a Pair is actively executing or paused (`PairActivationResult`, `RuntimePairGovernance`).
- **Governance**: Evaluates active assignment invariants and runtime readiness before allowing dispatch or activation.

### 2.6 RuntimeSession Persistence
- **Storage**: Persisted via SQLite / Memory repositories (`RuntimeSession` entities).
- **Attributes**: `id`, `provider_type`, `external_session_id`, `external_project_ref`, `status`, `last_observed_at`, etc.

### 2.7 Runtime Discovery & Observation
- **Mechanism**: Providers (`ChatGPT`, `OpenCode`, CLI/Browser providers) inspect external session registries, event streams, and transcripts.
- **Evidence**: Generates `ObservableEvidence` records detailing session health, timestamps, and message state.

### 2.8 External Session Existence Checks
- **Granular distinction**: Relies on provider adapter inspection (`RuntimeInspectionResult`, exact session transcript reconciliation).
- **Distinctions**: Differentiates between *session exists*, *session not observed*, *provider unreachable*, and *session confirmed missing*.

### 2.9 Assignment Lifecycle
- States: Created, Assigned, Active, Completed, Cancelled.
- Authoritative execution tracking.

### 2.10 Attempt Lifecycle
- Tracks execution attempts against assignments, binding attempts to target runtime sessions and delivery tokens.

### 2.11 Delivery Lifecycle
- Handles dispatch of instructions/work units to worker sessions.
- Uses `reconcileTransportOutcome` and pre-dispatch watermark capture to prevent duplicate dispatches and handle ambiguous transport outcomes.

### 2.12 Restart & Recovery
- All core state (Projects, Pairs, RuntimeSessions, Assignments, Attempts, Deliveries) persists across SQLite database restarts.

---

## 3. UI Status Labels (`available` vs `unknown`)

### 3.1 Contract Audit
- **`available`**: Indicates that the external provider session was successfully inspected/observed and confirmed to be active and responsive.
- **`unknown`**: Represents observation uncertainty (e.g., provider not polled recently, network timeout, or uninitialized observation state) rather than a confirmed deletion or healthy state.
- **Engine Contract Status**: `unknown` lacks a rigorous formal lifecycle transition contract in the core engine; it functions primarily as a transient UI/observation fallback state.

---

## 4. Behavior Under External Session Conditions

1. **Paired external session exists**: Normal operation; observation confirms active transport match.
2. **Paired external session cannot be observed**: Treated as transient observation degradation; does not destroy the Pair.
3. **Provider is unavailable**: Provider calls throw or return unavailable status (`RuntimeNotAvailableError`); guarded by readiness checks.
4. **Paired external session has actually been deleted**: Detected via authoritative inspection (e.g., HTTP 404 or missing session confirmation from provider API). Currently leaves the Pair stranded or un-dispatchable until manual rebind/replacement.

---

## 5. Conclusion & Next Steps
With the ground truth established, we proceed to Phase B (Checkpoint Foundation) to introduce immutable `PairCheckpoint` entities and repositories without breaking existing execution authority.
