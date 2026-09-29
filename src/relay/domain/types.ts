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
export type PairSideCheckpointId = Brand<string, 'PairSideCheckpointId'>;

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
 * The durable, per-side record of what RelayX most recently and TRUTHFULLY
 * observed of one exact bound external session.
 *
 * History: S5 landed dimensions 1-3 + 8 + 9; S2 adds dimensions 4-7 and the
 * §5.4 validity window. This is the §10.3 `side_observations` record, on one row
 * per (pair, side), held by the `UNIQUE (session_pair_id, side_role)` constraint.
 *
 * There are deliberately no `readiness` (I-5), no `advanceState` (§6.3), and no
 * `checkpoint` field. §6.4 is `[FROZEN]`: "Observing a side does not advance its
 * durable checkpoint", so a checkpoint cannot live on a record that observation
 * overwrites — the two must be separately stored, and the checkpoint is the
 * later continuity tranche, not S2.
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

  /**
   * S2. Dimensions 4-7 plus their own dimension 8/9 and §5.4 validity window.
   *
   * `null` means S2 has never observed this side — an honest absence, distinct
   * from an observation that reported every dimension `unknown`. The two are
   * different facts: "we never looked" versus "we looked and could not tell".
   * A row written by S5 therefore reads back with `null` here, and the
   * repository maps that to a reasoned "not observed by S2" rather than
   * fabricating `unknown` readings that no provider ever returned.
   */
  observation: SideObservationReading | null;

  /** Dimension 8 for dimensions 1-3. Always populated; names the capability. */
  sourceCapability: string;
  /** Dimension 9 for dimensions 1-3. Always populated. */
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
 * S2 — the outcome of `observeSide(pairId, sideRole)`.
 *
 * §11.2 requires the operation to be truthful about what it did, so this
 * distinguishes the three real outcomes rather than collapsing them:
 *
 *   - `observed`  a reading was PERSISTED as this side's latest-observed record.
 *                 Note this does not by itself imply a provider was contacted: a
 *                 provider that exposes no observation capability yields a
 *                 durable all-`unknown` reading, which is true and worth keeping
 *                 (I-6, §5.3), and it is persisted without any contact.
 *   - `stale`     a reading WAS obtained, but it was OLDER than the durable
 *                 record under the provider's own ordering, so the existing
 *                 record was kept. Reported, never hidden: an out-of-order read
 *                 that silently overwrote a newer marker is exactly the failure
 *                 this separation exists to prevent.
 *   - `refused`   nothing was written. Either no provider was contacted at all
 *                 (I-2, or there was no exact session to address), or the
 *                 provider was not registered. The returned `record` is the
 *                 existing last-known evidence, unmodified.
 *
 * `providerContacted` is a SEPARATE, authoritative flag for the contact question,
 * because `outcome` alone cannot answer it: an `observed` outcome with a LEVEL 0
 * provider has `providerContacted === false`. Assert the I-2 property from
 * `providerContacted`, never from the outcome.
 */
export type SideObservationOutcome = 'observed' | 'stale' | 'refused';

export interface SideObservationResult {
  pairId: PairId;
  sideRole: PairSideRole;
  outcome: SideObservationOutcome;
  /** I-2: false for a refusal, true only when the provider was actually read. */
  providerContacted: boolean;
  /**
   * The durable record as it stands AFTER this operation. On `stale` this is the
   * PREVIOUS record, because the newer one was deliberately preserved.
   */
  record: PairSideIdentity;
  /** What this operation changed, and what it deliberately did not. */
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
 *
 * S6 CLOSURE — the authoritative ownership decision for a RUNTIME-ADDRESSED
 */
export type RuntimePairGovernance =
  | { kind: 'unpaired' }
  | { kind: 'paired'; pairId: PairId; operationalState: PairOperationalState }
  | { kind: 'ambiguous'; pairIds: PairId[] };

/** S6 closure error code: a runtime's owning Pair is not operationally ACTIVE. */
export const RUNTIME_PAIR_NOT_ACTIVE = 'PAIR_OPERATIONAL_STATE_IDLE';

/** S6 closure error code: a runtime is bound to more than one Pair. Fails closed. */
export const RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS = 'PAIR_OWNERSHIP_AMBIGUOUS';

/* ========================================================================== *
 * S2 — the provider-neutral observation model (freeze §5.2 dimensions 4-7)
 *
 * S5 landed dimensions 1-3 (identity, verification, existence) plus the two
 * mandatory dimensions 8-9, and `PairSideIdentity` documents itself as "the S5
 * subset of the §10.3 `side_observations` proposal". S2 completes that same
 * record with the remaining four dimensions rather than introducing a SECOND
 * table for the same natural key. Two tables keyed on (pair, side) would create
 * two competing "latest observed" authorities for one subject, which is the
 * duplicate-authority defect the S1-S6 foundation exists to prevent.
 * ========================================================================== */

/**
 * Dimension 4 — Reachability (§5.2): "can RelayX currently reach the provider
 * surface at all?"
 *
 * This is NOT a restatement of dimension 3. `unreachable` means the provider
 * surface itself could not be contacted, so dimensions 1-3, 5-7 are necessarily
 * unknown too — "we could not look" is a strictly weaker fact than "it is gone".
 */
export type SideReachabilityState = 'reachable' | 'unreachable' | 'unknown';

/**
 * Dimension 5 — UI presence (§5.2): "is the session's surface present and
 * visible?"
 *
 * Distinct from existence. A session can exist in the provider's store while no
 * surface for it is on screen. A provider with no user-addressable surface (an
 * HTTP session service) reports `unknown` here rather than `absent`, because
 * "no such UI concept" is a capability gap, not an observation (I-6, C-8).
 */
export type SideUiPresenceState = 'present' | 'absent' | 'unknown';

/**
 * Dimension 6 — Activity state (§5.2): "is work in progress right now?"
 *
 * `unknown` is the honest value for a provider that exposes no activity signal.
 * It is never coerced to `idle`: "not working" and "we cannot tell" are the
 * different facts I-6 exists to keep apart, and collapsing them would make an
 * unobservable side look like a finished one.
 */
export type SideActivityState = 'working' | 'idle' | 'error' | 'unknown';

/**
 * Dimension 7 — Message evidence state (§5.2): "what is the latest observable
 * message, if any?"
 *
 * `none` means CHECKED and there is no meaningful message. `unknown` means it
 * could not be established.
 */
export type SideMessageEvidenceState = 'observed' | 'none' | 'unknown';

/**
 * Dimension 7's payload — the durable latest-observed message marker.
 *
 * Every field is optional because the providers genuinely differ, and S2 must not
 * fabricate a value a provider does not expose (§5.2, C-8):
 *
 *   - `ref`      a provider-stable message identifier. OpenCode supplies
 *                `messageId`, which is also the LEVEL 1 comparison primitive the
 *                continuity model needs (freeze §6.3, I-7). A LEVEL 0 provider
 *                supplies none, and `ref` stays null. §5.3/I-7 forbid inventing
 *                one.
 *   - `ordinal`  the message's position in the PROVIDER's own ordering of that
 *                one session's messages. This is what makes a monotonic
 *                comparison possible WITHOUT a synthetic global sequence: it is
 *                the provider's order, scoped to one provider and one session, so
 *                it can never compare a planner timestamp against a worker one
 *                (I-7, §4 of the S2 brief).
 *   - `truncated` recorded, never hidden (C-8, §10.3): a bounded extract that
 *                clipped the text must say so rather than imply a complete body.
 */
export interface SideMessageEvidence {
  ref: string | null;
  role: 'user' | 'assistant' | 'system' | 'other' | null;
  text: string | null;
  truncated: boolean;
  /** Position in the provider's own ordering; null when the provider has none. */
  ordinal: number | null;
}

/**
 * The one capability name used when a provider exposes no observation capability.
 *
 * Dimension 8 (§5.2) requires an observation to name the CAPABILITY that produced
 * it, and an observation with no source is invalid rather than defaulted. S4's
 * `sourceCapability` covers dimensions 1-3; S2 adds a second, separate name for
 * dimensions 4-7 because they come from a genuinely different capability. Merging
 * the two would misreport which capability produced which dimension (C-8).
 */
export const NO_OBSERVATION_CAPABILITY = 'none';

/**
 * §5.4 freshness — the provisional validity window for a side observation.
 *
 * §5.4 makes `valid_until` mandatory ("an observation older than its window is
 * stale"), but its own second paragraph leaves the PER-CAPABILITY window
 * `[UNRESOLVED]` (§20, U-7). This single constant is therefore an explicitly
 * PROVISIONAL placeholder, not a decided per-capability policy: S2 records the
 * timestamp so staleness is later computable, and does not use the window to
 * authorise anything (I-5 forbids a stale value authorising anything, and no
 * authorisation is derived here). When U-7 is decided this becomes a per-capability
 * lookup rather than one global number.
 */
export const PROVISIONAL_OBSERVATION_VALIDITY_MS = 5 * 60 * 1000;

/**
 * S2 — dimensions 4-7 of the durable per-side observation record.
 *
 * Kept as a nested object rather than eleven loose columns on `PairSideIdentity`
 * because these four dimensions travel together: they are the output of one
 * provider read, and grouping them keeps the "S2 has not observed this side yet"
 * case representable as a single absent object instead of eleven independent
 * NULLs that could disagree with one another.
 */
export interface SideObservationReading {
  reachabilityState: SideReachabilityState;
  uiPresenceState: SideUiPresenceState;
  activityState: SideActivityState;
  messageEvidenceState: SideMessageEvidenceState;
  message: SideMessageEvidence;
  /**
   * Dimension 8 for dimensions 4-7. Always populated; `NO_OBSERVATION_CAPABILITY`
   * when the provider exposes no observation capability at all.
   */
  observationCapability: string;
  /** Dimension 9 for dimensions 4-7. Always populated. */
  observedAt: number;
  /** §5.4 freshness marker; always populated. */
  validUntil: number;
  /** Why these values are what they are — required for every `unknown`. */
  reason: string | null;
  /** The low-level provider evidence artifact, when the provider returns one. */
  evidence: ObservableEvidence | null;
}

/** S2 error code: observation was attempted on a Pair that is not ACTIVE. */
export const PAIR_NOT_ACTIVE_FOR_OBSERVATION = 'PAIR_OPERATIONAL_STATE_IDLE';

/* ========================================================================= *
 * S3: Pair side checkpoints & continuity evaluation
 *
 * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §6.1-§6.5, §10.3, §11.2.
 * ========================================================================= */

/**
 * Structural authority backing a checkpoint capture or advancement.
 * S3 strictly admits only authorities that S3 can truthfully establish:
 * - INITIAL_BASELINE: explicit operator establishment of the baseline position
 * - OPERATOR_ACKNOWLEDGED: explicit operator review/reconciliation of advanced state
 *
 * Automated baseline creation and transport/delivery-inferred advancements
 * are strictly forbidden in S3.
 */
export type CheckpointAuthority =
  | {
      readonly kind: 'INITIAL_BASELINE';
      readonly operatorId: string;
    }
  | {
      readonly kind: 'OPERATOR_ACKNOWLEDGED';
      readonly operatorId: string;
      readonly acknowledgedAt: number;
      readonly resolutionNote?: string;
    };

export type CheckpointAuthorityKind = CheckpointAuthority['kind'];

/**
 * An append-only durable checkpoint record for one bound side of a Session Pair.
 *
 * In accordance with §10.3 and the S3 semantic freeze:
 * 1. Represents acknowledged/baseline progress, NOT mere observation.
 * 2. Immutable once written (append-only history).
 * 3. Never created or advanced automatically by observation or background polling.
 */
export interface PairSideCheckpoint {
  readonly id: PairSideCheckpointId;
  readonly sessionPairId: PairId;
  readonly sideRole: PairSideRole;
  readonly messageRef: string | null;
  readonly messageOrdinal: number | null;
  readonly messageText: string | null;
  readonly externalSessionId: string | null;
  readonly determinacy: 'identified' | 'unverified';
  readonly capturedAt: number;
  readonly sourceProvider: ProviderType;
  readonly sourceCapability: string;
  readonly authority: CheckpointAuthority;
  readonly auditReason: string;
}

export type SideAdvanceState = 'unchanged' | 'advanced' | 'unknown';

export type PairAdvanceState =
  | 'UNCHANGED'
  | 'PLANNER_ADVANCED'
  | 'WORKER_ADVANCED'
  | 'BOTH_ADVANCED'
  | 'UNKNOWN';

export interface SideContinuityEvaluation {
  readonly sideRole: PairSideRole;
  readonly state: SideAdvanceState;
  readonly determinacy: 'identified' | 'unverified';
  readonly checkpointId: PairSideCheckpointId | null;
  readonly checkpointOrdinal: number | null;
  readonly checkpointRef: string | null;
  readonly observedOrdinal: number | null;
  readonly observedRef: string | null;
  readonly reason: string;
}

export interface PairContinuityResult {
  readonly sessionPairId: PairId;
  readonly state: PairAdvanceState;
  readonly computedAt: number;
  readonly planner: SideContinuityEvaluation;
  readonly worker: SideContinuityEvaluation;
}

export const CHECKPOINT_BASELINE_ALREADY_EXISTS = 'CHECKPOINT_BASELINE_ALREADY_EXISTS';
export const CHECKPOINT_BASELINE_REQUIRED = 'CHECKPOINT_BASELINE_REQUIRED';
export const CHECKPOINT_OBSERVATION_REQUIRED = 'CHECKPOINT_OBSERVATION_REQUIRED';


/**
 * High-level lifecycle states of an Assignment (a unit of work assigned to a Pair).
 *
 * State Transitions:
 *   pending -> active -> waiting_for_handoff -> completed
 *   pending / active -> cancelled | failed
 */
export type AssignmentStatus =
  | 'pending'
  | 'active'
  | 'waiting_for_handoff'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Execution attempt lifecycle representing a single physical execution of an assignment.
 *
 * State Transitions:
 *   prepared (durable intent recorded) -> running (confirmed execution) -> completed_physical | interrupted
 */
export type AttemptStatus =
  | 'prepared'
  | 'running'
  | 'completed_physical'
  | 'interrupted';

/**
 * Observed state of an external agent / runtime process (OpenCode, ChatGPT desktop, etc.).
 */
export type RuntimeSessionStatus =
  | 'unknown'
  | 'available'
  | 'working'
  | 'idle'
  | 'suspended'
  | 'unavailable'
  | 'terminated'
  | 'archived';

/**
 * Physical instruction delivery status from RelayX to the external worker runtime.
 *
 * - pending: queued in RelayX
 * - delivering: transport initiated
 * - delivered: provider confirmed message receipt in external transcript/UI
 * - ambiguous: send attempted but receipt could not be proven; automated resend BLOCKED
 * - failed: delivery attempt conclusively failed prior to dispatch
 */
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

/** Severity levels for items requiring human operator or automated attention. */
export type AttentionSeverity = 'info' | 'warning' | 'critical';

/** Attention item resolution lifecycle. */
export type AttentionStatus = 'open' | 'acknowledged' | 'resolved';

/**
 * Escalation tiers for automated and operator-driven error recovery.
 * - tier_1_deterministic: Automated recovery rules (e.g. refocus, safe retry on known failure)
 * - tier_2_planner_assisted: Consultation with Planner AI to formulate an alternative plan
 * - tier_3_ai_agent: Escalation to human operator or autonomous high-level supervisory agent
 */
export type RecoveryTier = 'tier_1_deterministic' | 'tier_2_planner_assisted' | 'tier_3_ai_agent';

/** Target provider implementations supported by the Relay architecture. */
export type ProviderType = 'chatgpt' | 'opencode' | 'vscode' | 'generic_ui';

/** Integration capability level of a provider adapter in the current runtime environment. */
export type ProviderIntegrationStatus = 'real' | 'partial' | 'unsupported';

/** Verification fidelity of an external session binding or evidence claim. */
export type VerificationState = 'verified' | 'unverified' | 'manual' | 'stale';

/**
 * Origin provenance of a Runtime-to-Project Association.
 *
 * Authoritative provenances admitting pre-pair verification are:
 * - 'discovery': Discovered via direct provider query (e.g., shared service directory scan)
 * - 'adoption': Explicitly confirmed and adopted by user action or verified URL binding
 * - 'setup': Established during initial project initialization
 *
 * Non-authoritative provenances (cannot authorize pairing without independent evidence):
 * - 'manual_registration': Arbitrary unverified user input
 * - 'pair_binding': Legacy implicit association without external verification
 */
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
