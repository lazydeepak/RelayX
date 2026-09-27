/**
 * Relay Domain Core Types & Strong Identifiers
 * macOS-first AI work orchestration control plane
 */

export type Brand<T, B> = T & { readonly __brand: B };

export type ProjectId = Brand<string, 'ProjectId'>;
export type PairId = Brand<string, 'PairId'>;
export type PlannerId = Brand<string, 'PlannerId'>;
export type WorkerId = Brand<string, 'WorkerId'>;
export type RuntimeSessionId = Brand<string, 'RuntimeSessionId'>;
export type AssignmentId = Brand<string, 'AssignmentId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type DeliveryId = Brand<string, 'DeliveryId'>;
export type HandoffId = Brand<string, 'HandoffId'>;
export type EventId = Brand<string, 'EventId'>;
export type AttentionItemId = Brand<string, 'AttentionItemId'>;
export type AssociationId = Brand<string, 'AssociationId'>;
export type RecoveryActionId = Brand<string, 'RecoveryActionId'>;

/* --- Plan-First identifiers (PLAN_FIRST_DOMAIN_FREEZE.md §A) --- */
export type ContractRevisionId = Brand<string, 'ContractRevisionId'>;
export type PlanFirstRunId = Brand<string, 'PlanFirstRunId'>;
export type WorkUnitId = Brand<string, 'WorkUnitId'>;
export type VerificationResultId = Brand<string, 'VerificationResultId'>;

export const createId = <T extends Brand<string, string>>(prefix: string): T => {
  const rand = Math.random().toString(36).substring(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${rand}` as T;
};

/* --- Lifecycle States --- */

export type ProjectStatus = 'active' | 'archived';

/**
 * Lifecycle / execution state of a Pair.
 *
 * DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §4.1 freezes TWO orthogonal persisted
 * dimensions. This union is the *lifecycle* dimension only.
 *
 * `idle` and `active` are retained here as DEPRECATED ALIASES. They are not a
 * second source of truth for operational state and must never be read as one.
 * The single source of truth for operational state is
 * {@link PairOperationalState} (`Pair.operationalState`). The freeze leaves the
 * retain-vs-remove choice open (U-6); S1 resolves it as *retain* — the
 * Plan-First precedent of refusing destructive change — and removes the
 * ambiguity by giving this column exactly one owner, the `Pair` entity's
 * lifecycle methods, which never write operational state.
 *
 * Ownership:
 *   - written by: `Pair.assignWork/clearWork/pause/resume/archive/unarchive`
 *     (lifecycle only) and by `SqlitePairRepository` round-trip.
 *   - never read to decide whether RelayX may contact a provider. That decision
 *     reads `Pair.operationalState` and nothing else.
 */
export type PairStatus =
  | 'idle'
  | 'active'
  | 'paused'
  | 'recovering'
  | 'blocked'
  | 'archived';

/**
 * Operational state of a Pair — the authority for the I-2 provider-contact gate.
 *
 * Exactly two values. There is deliberately no third value: no `ACTIVATING`, no
 * `LOADING`, no `CHECKING`, no `DEGRADED` (I-1, §4.2, §8.1). A transient
 * condition is ephemeral runtime state and is never persisted here.
 *
 *   IDLE   — RelayX retains bindings, history, checkpoints and work records, and
 *            makes NO contact with the Planner or the Worker. Persisted provider
 *            information is last-known evidence only.
 *   ACTIVE — RelayX is PERMITTED live provider operations. It does not mean work
 *            is executing, does not mean READY, and does not imply polling.
 */
export const PAIR_OPERATIONAL_STATES = ['IDLE', 'ACTIVE'] as const;

export type PairOperationalState = (typeof PAIR_OPERATIONAL_STATES)[number];

/**
 * §17.3: existing Pairs backfill to IDLE. It is the only safe default, because
 * ACTIVE would grant a provider-contact permission (I-2) that cannot be
 * justified for a pre-existing record.
 */
export const DEFAULT_PAIR_OPERATIONAL_STATE: PairOperationalState = 'IDLE';

/** Runtime guard for the two-valued operational state (I-1). */
export const isPairOperationalState = (value: unknown): value is PairOperationalState =>
  typeof value === 'string' && (PAIR_OPERATIONAL_STATES as readonly string[]).includes(value);

/* --- S5: per-side identity resolution and verification --------------------
 *
 * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md
 *   §5.2  the nine observation dimensions, each independently tri-state
 *   §5.3  tri-state discipline: `unknown` is never collapsed into `false`
 *   §9.5  the ChatGPT/OpenCode verification asymmetry must be reported, not hidden
 *   §11.3 per-side independence: one side's failure never aborts the other
 *   I-6   unknown is a distinct value from false
 *   I-11  a shared name is evidence, never identity
 *
 * These are dimensions 1-3 only. Dimensions 4-7 (reachability, UI presence,
 * activity, message evidence) belong to S2 provider observation and are
 * deliberately absent: S5 resolves identity and nothing else.
 */

/** Exactly two sides (§10.3). A Pair always has both, even when unbound. */
export const PAIR_SIDE_ROLES = ['planner', 'worker'] as const;
export type PairSideRole = (typeof PAIR_SIDE_ROLES)[number];

export const isPairSideRole = (value: unknown): value is PairSideRole =>
  typeof value === 'string' && (PAIR_SIDE_ROLES as readonly string[]).includes(value);

/**
 * Dimension 1 — Identity (§5.2): "what external identifier does RelayX believe
 * this side is?"
 *
 * `not_resolved` means CHECKED, no identifier resolved. `unknown` means not
 * checked, cannot be checked, or the check failed. Collapsing the two is
 * exactly what I-6 forbids.
 */
export type SideIdentityState = 'resolved' | 'not_resolved' | 'unknown';

/**
 * Dimension 2 — Identity verification (§5.2): "has the provider confirmed that
 * identifier corresponds to the intended session?"
 *
 * A LEVEL 0 side (ChatGPT) is permanently `unknown` here. It is never
 * `mismatched`: we did not check, so we cannot have found a mismatch.
 */
export type SideVerificationState = 'verified' | 'mismatched' | 'unknown';

/** Dimension 3 — Existence (§5.2). `absent` means checked-and-gone. */
export type SideExistenceState = 'present' | 'absent' | 'unknown';

/**
 * §9.5 / C-8 verification capability asymmetry, per side.
 *
 * `not_verifiable` is a permanent property of the provider, not a transient
 * failure. A LEVEL 0 side reports this so the operator is told "this provider
 * cannot be verified" instead of being shown a fabricated `false`.
 */
export type SideVerificationCapability = 'exact_session_verifiable' | 'not_verifiable';

/** The one capability name used when a provider exposes no identity capability. */
export const NO_IDENTITY_CAPABILITY = 'none';

/**
 * The durable, per-side record of what S5 established (the S5 subset of the
 * §10.3 `side_observations` proposal: dimensions 1-3, plus the mandatory
 * dimensions 8 and 9).
 *
 * Dimension 8 (`sourceCapability`) and dimension 9 (`observedAt`) are ALWAYS
 * populated — §5.2 `[FROZEN]`: "An observation with no source or no time is
 * invalid and must be rejected, not defaulted."
 *
 * There is deliberately no `readiness` field. I-5 forbids a persisted readiness
 * value, and S8 has not landed.
 */
export interface PairSideIdentity {
  /** Owning Pair. The natural key together with `sideRole`. */
  sessionPairId: PairId;
  sideRole: PairSideRole;
  providerType: ProviderType;
  /** The RelayX runtime binding for this side, or null when unbound. */
  runtimeSessionId: RuntimeSessionId | null;
  /** I-11: the provider's own external identifier, never the shared Pair Name. */
  externalSessionId: string | null;

  identityState: SideIdentityState;
  identityValue: string | null;

  verificationState: SideVerificationState;
  verificationValue: string | null;

  existenceState: SideExistenceState;

  /** §9.5: whether this provider can be verified at all, per side. */
  capability: SideVerificationCapability;

  /** Dimension 8. Always populated; names the capability, not just the provider. */
  sourceCapability: string;
  /** Dimension 9. Always populated. */
  observedAt: number;

  /** Human-readable explanation, especially for every `unknown`. */
  reason: string | null;
  evidence: ObservableEvidence | null;
}

/** The full outcome of `loadAndActivate`, with BOTH sides always present. */
export interface PairActivationResult {
  pairId: PairId;
  outcome: 'activated' | 'rejected';
  /** I-1: exactly two values, before and after. Never a third. */
  operationalStateBefore: PairOperationalState;
  operationalStateAfter: PairOperationalState;
  /**
   * §11.3: both keys are always present. A side that could not be verified is
   * present with `verificationState: 'unknown'` — it is never omitted, and
   * never recorded as `false`.
   */
  sides: Record<PairSideRole, PairSideIdentity>;
  /**
   * True only when EVERY side is `verified`. A Pair with a LEVEL 0 planner side
   * is never "fully verified", and the UI must show the asymmetry rather than a
   * single pair-level badge (§9.5).
   */
  fullyVerified: boolean;
  reason: string | null;
}

/**
 * S6 CLOSURE — the authoritative ownership decision for a RUNTIME-ADDRESSED
 * provider operation.
 *
 * A provider operation can be addressed either by `PairId` (dispatch, supervision,
 * reconciliation) or by `RuntimeSessionId` (inspect, unarchive, runtime recovery).
 * Only the first kind has a `Pair` in scope at the call, which is exactly how the
 * two runtime-level paths came to be ungated: there was nothing to gate against.
 *
 * This type is the single decision shape those paths must resolve before contact.
 * It is deliberately a discriminated union of the three real cases rather than a
 * nullable Pair, because "no owner" and "several owners" are different situations
 * that must not collapse into the same value:
 *
 *   - `unpaired`  — no Pair binds this runtime. There is no Pair whose IDLE state
 *                   could be violated, so standalone runtime semantics apply. This
 *                   is NOT permission and NOT "active": it is the absence of a
 *                   governance subject.
 *   - `paired`    — exactly one Pair binds it. `operationalState` decides.
 *   - `ambiguous` — more than one Pair binds it. The `pairs` table deliberately
 *                   carries no unique index on `planner_session_id` /
 *                   `worker_session_id` (the application prevents it, the schema
 *                   does not), so this is representable. It FAILS CLOSED: an
 *                   operation is never authorised by picking one of the candidates.
 *
 * ## Why it reports identifiers and the state, not a live `Pair`
 *
 * `types.ts` is a pure type module that references no entity class, and it should
 * stay that way. More importantly, this is a DECISION about a runtime, not a
 * handle for further mutation: handing back a live `Pair` would invite a caller to
 * write through it from a path whose only job was to ask "may I contact the
 * provider?". The decision carries exactly what a caller legitimately needs to
 * report — who governs it, and in what state — and the state is captured at
 * resolution time rather than re-read later, so it cannot go stale mid-check.
 */
export type RuntimePairGovernance =
  | { kind: 'unpaired' }
  | { kind: 'paired'; pairId: PairId; operationalState: PairOperationalState }
  | { kind: 'ambiguous'; pairIds: PairId[] };

/** S6 closure error code: a runtime's owning Pair is not operationally ACTIVE. */
export const RUNTIME_PAIR_NOT_ACTIVE = 'PAIR_OPERATIONAL_STATE_IDLE';

/** S6 closure error code: a runtime is bound to more than one Pair. Fails closed. */
export const RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS = 'PAIR_OWNERSHIP_AMBIGUOUS';

export type AssignmentStatus =
  | 'pending'
  | 'active'
  | 'waiting_for_handoff'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AttemptStatus =
  | 'prepared'
  | 'running'
  | 'completed_physical'
  | 'interrupted';

export type RuntimeSessionStatus =
  | 'unknown'
  | 'available'
  | 'working'
  | 'idle'
  | 'suspended'
  | 'unavailable'
  | 'terminated'
  | 'archived';

export type DeliveryStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'ambiguous'
  | 'failed';

/**
 * Handoff lifecycle.
 *
 * `delivered` is an assertion about the EXTERNAL world: it may only be reached
 * through `Handoff.markDeliveredToPlanner(evidence)`, which requires provider
 * evidence and throws otherwise. `ready` means the result exists and delivery is
 * *intended* — it never means the Planner has been told anything.
 */
export type HandoffStatus =
  | 'pending'
  | 'ready'
  | 'delivered'
  | 'complete'
  | 'suspended';

/* --- External-effect evidence invariant (S1) --- */

/**
 * The evidence classes that every durable claim about an external effect must
 * fall into. `externally_confirmed` is the only one that asserts the external
 * effect happened, and it is reachable only with provider evidence appropriate
 * to that provider's proven capability.
 *
 * This is vocabulary, not a second state machine. The existing
 * `DeliveryStatus` / `AttemptStatus` / `HandoffStatus` unions already encode
 * these distinctions; {@link classifyDeliveryStatus},
 * {@link classifyAttemptStatus} and {@link classifyHandoffStatus} are the single
 * mapping from this vocabulary onto that existing machinery, so no duplicate
 * lifecycle is introduced.
 */
export type ExternalEffectClass =
  /** RelayX decided to act. Nothing has been sent. */
  | 'intended'
  /** RelayX began the external act. No confirmation yet. */
  | 'attempted'
  /** The provider proved the external effect occurred. Evidence is required. */
  | 'externally_confirmed'
  /** The external act did not occur. */
  | 'failed'
  /** The external act may or may not have occurred; unresolvable from here. */
  | 'ambiguous'
  /** No external act was made and none can be made on the current capability. */
  | 'unverified';

/** The single assertion: does this class claim the external effect happened? */
export const EXTERNAL_EFFECT_CLASS_ASSERTS_OCCURRED = (value: ExternalEffectClass): boolean =>
  value === 'externally_confirmed';

export const classifyDeliveryStatus = (status: DeliveryStatus): ExternalEffectClass => {
  switch (status) {
    case 'pending':
      return 'intended';
    case 'delivering':
      return 'attempted';
    case 'delivered':
      return 'externally_confirmed';
    case 'ambiguous':
      return 'ambiguous';
    case 'failed':
      return 'failed';
  }
};

export const classifyAttemptStatus = (status: AttemptStatus): ExternalEffectClass => {
  switch (status) {
    // Durable intent stored; the external send has not been proven to have run.
    case 'prepared':
      return 'intended';
    // confirmDispatch(): the provider proved the worker began executing.
    case 'running':
      return 'externally_confirmed';
    // Physical completion was observed at the provider.
    case 'completed_physical':
      return 'externally_confirmed';
    // Local lifecycle conclusion; never an assertion that the effect completed.
    case 'interrupted':
      return 'ambiguous';
  }
};

/**
 * `null` means "this state makes NO claim about the external effect at all".
 * That distinction is load-bearing: `complete` and `suspended` are local
 * lifecycle conclusions about the RelayX record, and reading either of them as
 * evidence that the Planner was told something is exactly the defect this
 * invariant exists to prevent.
 */
export const classifyHandoffStatus = (status: HandoffStatus): ExternalEffectClass | null => {
  switch (status) {
    // Result not assembled yet.
    case 'pending':
      return 'intended';
    // Result ready; delivery intended but NOT performed and NOT confirmed.
    case 'ready':
      return 'intended';
    // Only reachable via markDeliveredToPlanner(providerEvidence).
    case 'delivered':
      return 'externally_confirmed';
    // Local conclusion of the RelayX record. Says nothing about the Planner.
    case 'complete':
    case 'suspended':
      return null;
  }
};

export type AttentionSeverity = 'info' | 'warning' | 'critical';

export type AttentionStatus = 'open' | 'acknowledged' | 'resolved';

export type RecoveryTier = 'tier_1_deterministic' | 'tier_2_planner_assisted' | 'tier_3_ai_agent';

export type ProviderType = 'chatgpt' | 'opencode' | 'vscode' | 'generic_ui';

export type ProviderIntegrationStatus = 'real' | 'partial' | 'unsupported';

export type VerificationState = 'verified' | 'unverified' | 'manual' | 'stale';

export type AssociationProvenance = 'discovery' | 'adoption' | 'manual_registration' | 'pair_binding' | 'setup';

/* --- Observable UI Evidence Model --- */

export interface ObservableEvidence {
  id: string;
  timestamp: number;
  source:
    | 'macos_accessibility'
    | 'macos_system_events'
    | 'applescript'
    | 'system_events'
    | 'window_inspection'
    | 'filesystem_heartbeat'
    | 'reconciliation_probe';
  windowTitle?: string;
  applicationPid?: number;
  bundleIdentifier?: string;
  runtimeSessionId?: RuntimeSessionId;
  visibleButtonState?: {
    sendButtonVisible?: boolean;
    stopButtonVisible?: boolean;
    cancelButtonVisible?: boolean;
  };
  composerSignature?: string;
  composerCleared?: boolean;
  responseActivityObserved?: boolean;
  screenshotRef?: string;
  accessibilityElementId?: string;
  details?: Record<string, unknown>;
}

/* --- Heartbeat & Filesystem Signaling --- */

export interface FilesystemSignalingHeartbeat {
  schemaVersion: '1.0';
  runtimeId: string;
  assignmentId?: string;
  state: RuntimeSessionStatus;
  timestamp: number;
  sequence: number;
  source: string;
  processPid?: number;
}

export type VerificationStatus = 'not_run' | 'passed' | 'failed' | 'blocked';

export type PlannerActionResult = 'pending' | 'applied' | 'rejected_stale' | 'rejected_unauthorized' | 'rejected_invalid_transition' | 'duplicate';
export type PlannerAssistanceStatus = 'open' | 'resolved' | 'stale';

/* --- Plan-First lifecycle states (PLAN_FIRST_DOMAIN_FREEZE.md §C) --- */

/** draft -> approved (terminal). Content is immutable from creation. */
export type ContractRevisionStatus = 'draft' | 'approved';

export const PLAN_FIRST_RUN_TERMINAL_STATES: readonly PlanFirstRunStatus[] = [
  'completed',
  'cancelled',
] as const;

export type PlanFirstRunStatus = 'ready' | 'running' | 'blocked' | 'completed' | 'cancelled';

export const WORK_UNIT_TERMINAL_STATES: readonly WorkUnitStatus[] = ['completed'] as const;

export type WorkUnitStatus = 'pending' | 'in_progress' | 'blocked' | 'completed';
