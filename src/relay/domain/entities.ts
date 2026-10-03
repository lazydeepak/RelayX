/**
 * ============================================================================
 * RELAY CORE DOMAIN ENTITIES — FROZEN SEMANTIC MODEL (§SEMANTIC_FREEZE)
 * ============================================================================
 *
 * Five independent dimensions must never be conflated:
 *   A. Authority        (operationalState: IDLE | ACTIVE) — permission only
 *   B. Relay enable     (relayState: STOPPED | PAUSED | RUNNING) — loop enabled
 *   C. Durable intent   (Attempt: prepared | running | completed_physical | interrupted)
 *   D. Delivery lifecycle (pending | delivering | delivered | ambiguous | failed)
 *   E. Provider evidence (ObservableEvidence + RuntimeSession.lastEvidence)
 *
 * Critical invariants:
 *   - ACTIVE grants provider-contact authority; it does NOT prove verification or reachability.
 *   - RUNNING enables automated relay; it does NOT prove an assignment/attempt is executing.
 *   - prepared = durable intent committed (before external send); no provider evidence required.
 *   - delivering = durable dispatch committed; does NOT mean external send is in progress.
 *   - delivered = provider confirmed delivery with ObservableEvidence; does NOT prove worker
 *     execution began (Attempt.running requires execution evidence separately).
 *   - No local control-state value (operationalState, relayState, pair.status) may be read
 *     as proof of an external fact unless backed by ObservableEvidence.
 */

/**
 * This module defines the domain entities for the RelayX orchestration platform.
 * RelayX coordinates two-sided AI collaboration (a Planner like ChatGPT desktop
 * and a Worker like OpenCode or VS Code) over real macOS developer workspaces.
 *
 * ENTITY GRAPH:
 *
 *    ┌───────────────────────────┐
 *    │          Project          │ (canonicalPath, gitRoot, plannerProjectUrl, workerWorkspacePath)
 *    └─────────────┬─────────────┘
 *                  │ 1
 *                  │
 *                  ▼ *
 *    ┌───────────────────────────┐      1:1 (Authoritative)      ┌───────────────────────────────┐
 *    │           Pair            │ ─────────────────────────────▶ │   RuntimeProjectAssociation   │
 *    │ (operationalState:        │                                └───────────────────────────────┘
 *    │   IDLE | ACTIVE)          │                                                ▲
 *    └─────────────┬─────────────┘                                                │
 *                  │ 1                                                            │ binds
 *                  ▼ *                                                            │
 *    ┌───────────────────────────┐ 1    * ┌───────────────────────────┐           │
 *    │        Assignment         │ ──────▶│      RuntimeSession       │ ──────────┘
 *    │ (pending, active, ...)    │        │ (ChatGPT / OpenCode /     │
 *    └─────────────┬─────────────┘        │  VSCode process & state)  │
 *                  │ 1                    └───────────────────────────┘
 *                  ▼ *
 *    ┌───────────────────────────┐
 *    │          Attempt          │ (Frozen Authority: sessionPairId, workerSessionId, externalSessionId)
 *    │ (prepared, running, ...)  │
 *    └─────────────┬─────────────┘
 *                  │ 1
 *                  ▼ 1
 *    ┌───────────────────────────┐
 *    │         Delivery          │ (pending, delivering, delivered, ambiguous, failed)
 *    │ (idempotencyKey, snippet) │
 *    └───────────────────────────┘
 *                  │ generates upon worker completion
 *                  ▼
 *    ┌───────────────────────────┐
 *    │          Handoff          │ (pending, ready, delivered, complete)
 *    │ (worker evidence +        │
 *    │  planner delivery evidence)
 *    └───────────────────────────┘
 *
 * KEY SYSTEM INVARIANTS:
 * 1. Operational State Gate (I-2): Provider contact (discovery, dispatch, supervision)
 *    is STRICTLY FORBIDDEN when Pair operationalState is IDLE.
 * 2. Exact Session Identity (I-11): Dispatches and associations address the external
 *    provider's own unique session id (e.g. `ses_*`), NEVER human-facing titles.
 * 3. Durable Dispatch Intent: Attempts begin 'prepared' and Deliveries begin 'pending'
 *    committed to SQLite BEFORE the physical transport message is sent.
 * 4. Ambiguity Fails Closed: An unconfirmed or timed-out dispatch is classified
 *    as 'ambiguous' and automated resends are BLOCKED to prevent duplicate execution.
 * 5. Decoupled Handoff: Generating a Handoff is NOT Assignment completion; the Planner
 *    must explicitly accept or review before completion.
 */

import {
  ProjectId,
  PairId,
  PlannerId,
  WorkerId,
  AssignmentId,
  AttemptId,
  DeliveryId,
  HandoffId,
  RuntimeSessionId,
  EventId,
  AttentionItemId,
  AssociationId,
  RecoveryActionId,
  ProjectStatus,
  PairStatus,
  PairOperationalState,
  DEFAULT_PAIR_OPERATIONAL_STATE,
  isPairOperationalState,
  PairRelayState,
  PairSideRole,
  DEFAULT_PAIR_RELAY_STATE,
  isPairRelayState,
  AuthorityContext,
  AssignmentStatus,
  AttemptStatus,
  RuntimeSessionStatus,
  DeliveryStatus,
  HandoffStatus,
  AttentionSeverity,
  AttentionStatus,
  RecoveryTier,
  ProviderType,
  ObservableEvidence,
  PairCheckpointId,
  createId,
} from './types.ts';
import {
  InvalidStateTransitionError,
  MissingEvidenceError,
  DuplicateDeliveryAttemptError,
  AmbiguousDeliveryResendError,
  RelayDomainError,
} from './errors.ts';

/* --- Project Entity --- */
export interface ProjectProps {
  id: ProjectId;
  name: string;
  description: string;
  canonicalPath?: string;
  gitRoot?: string;
  plannerProjectUrl?: string;
  workerWorkspacePath?: string;
  status?: ProjectStatus;
  createdAt: number;
  updatedAt: number;
}

export class Project {
  public readonly id: ProjectId;
  public name: string;
  public description: string;
  public canonicalPath?: string;
  public gitRoot?: string;
  public plannerProjectUrl?: string;
  public workerWorkspacePath?: string;
  public status: ProjectStatus;
  public readonly createdAt: number;
  public updatedAt: number;

  constructor(props: ProjectProps) {
    this.id = props.id;
    this.name = props.name;
    this.description = props.description;
    this.canonicalPath = props.canonicalPath;
    this.gitRoot = props.gitRoot;
    this.plannerProjectUrl = props.plannerProjectUrl;
    this.workerWorkspacePath = props.workerWorkspacePath;
    this.status = props.status ?? 'active';
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  public static create(name: string, description = '', canonicalPath?: string, gitRoot?: string, plannerProjectUrl?: string, workerWorkspacePath?: string): Project {
    const now = Date.now();
    return new Project({
      id: createId<ProjectId>('proj'),
      name,
      description,
      canonicalPath,
      gitRoot,
      plannerProjectUrl,
      workerWorkspacePath,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }

  public update(name?: string, description?: string, canonicalPath?: string, gitRoot?: string, plannerProjectUrl?: string, workerWorkspacePath?: string): void {
    if (name !== undefined) this.name = name;
    if (description !== undefined) this.description = description;
    if (canonicalPath !== undefined) this.canonicalPath = canonicalPath;
    if (gitRoot !== undefined) this.gitRoot = gitRoot;
    if (plannerProjectUrl !== undefined) this.plannerProjectUrl = plannerProjectUrl;
    if (workerWorkspacePath !== undefined) this.workerWorkspacePath = workerWorkspacePath;
    this.updatedAt = Date.now();
  }

  public archive(): void {
    this.status = 'archived';
    this.updatedAt = Date.now();
  }

  public unarchive(): void {
    this.status = 'active';
    this.updatedAt = Date.now();
  }
}

/* --- Pair Entity --- */
export interface PairProps {
  id: PairId;
  projectId: ProjectId;
  name: string;
  plannerSessionId?: RuntimeSessionId | null;
  workerSessionId?: RuntimeSessionId | null;
  activeAssignmentId?: AssignmentId;
  status: PairStatus;
  /**
   * Two-valued operational dimension (I-1). Omitted means IDLE, which is the only
   * safe default for a pre-existing record (§17.3).
   */
  operationalState?: PairOperationalState;
  relayState?: PairRelayState;
  /**
   * Stable Pair identity that survives session rebinding (C-1 prerequisite).
   * Immutable once set; defaults to `id`.
   */
  stableId?: PairId;
  predecessorPairId?: PairId | null;
  sourceCheckpointId?: PairCheckpointId | null;
  lastSupervisedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export class Pair {
  public readonly id: PairId;
  public readonly projectId: ProjectId;
  public name: string;
  public plannerSessionId?: RuntimeSessionId;
  public workerSessionId?: RuntimeSessionId;
  public activeAssignmentId?: AssignmentId;
  public status: PairStatus;
  public lastSupervisedAt?: number;
  public readonly createdAt: number;
  public updatedAt: number;
  public readonly stableId: PairId;
  public readonly predecessorPairId: PairId | null;
  public readonly sourceCheckpointId: PairCheckpointId | null;

  private operational: PairOperationalState;
  private relay: PairRelayState;

  constructor(props: PairProps) {
    this.id = props.id;
    this.projectId = props.projectId;
    this.name = props.name;
    this.plannerSessionId = props.plannerSessionId ?? undefined;
    this.workerSessionId = props.workerSessionId ?? undefined;
    this.activeAssignmentId = props.activeAssignmentId;
    this.status = props.status;
    this.stableId = props.stableId ?? props.id;
    this.predecessorPairId = props.predecessorPairId ?? null;
    this.sourceCheckpointId = props.sourceCheckpointId ?? null;
    this.operational = DEFAULT_PAIR_OPERATIONAL_STATE;
    this.relay = DEFAULT_PAIR_RELAY_STATE;
    this.lastSupervisedAt = props.lastSupervisedAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
    this.operationalState = props.operationalState ?? DEFAULT_PAIR_OPERATIONAL_STATE;
    this.relayState = props.relayState ?? DEFAULT_PAIR_RELAY_STATE;
  }

  /**
   * The single source of truth for operational state (I-1, §4.1, §17.2).
   *
   * Deliberately a validated accessor rather than a plain public field: a third
   * value (e.g. `ACTIVATING`) is unrepresentable, not merely discouraged. I-1
   * forbids a persisted third value for a transient condition, and a plain field
   * would let one in from any call site including the persistence mappers.
   */
  public get operationalState(): PairOperationalState {
    return this.operational;
  }

  public set operationalState(value: PairOperationalState) {
    if (!isPairOperationalState(value)) {
      throw new RelayDomainError(
        `Pair operational state must be exactly IDLE or ACTIVE; received '${String(value)}'. ` +
          'A transient third value is prohibited (DESIGN_FREEZE I-1).',
        'PAIR_OPERATIONAL_STATE_INVALID',
      );
    }
    this.operational = value;
  }

  public get relayState(): PairRelayState {
    return this.relay;
  }

  public set relayState(value: PairRelayState) {
    if (!isPairRelayState(value)) {
      throw new RelayDomainError(
        `Pair relay state must be STOPPED, RUNNING, or PAUSED; received '${String(value)}'.`,
        'PAIR_RELAY_STATE_INVALID',
      );
    }
    this.relay = value;
  }

  public startRelay(): void {
    this.relayState = 'RUNNING';
    this.resume();
    this.updatedAt = Date.now();
  }

  public pauseRelay(): void {
    this.relayState = 'PAUSED';
    this.pause();
    this.updatedAt = Date.now();
  }

  public resumeRelay(): void {
    this.relayState = 'RUNNING';
    this.resume();
    this.updatedAt = Date.now();
  }

  public stopRelay(): void {
    this.relayState = 'STOPPED';
    this.pause();
    this.updatedAt = Date.now();
  }

  public isAutomatedContactPermitted(): boolean {
    return this.operationalState === 'ACTIVE' && this.relayState === 'RUNNING';
  }

  public static create(
    projectId: ProjectId,
    name: string,
    plannerSessionId?: RuntimeSessionId,
    workerSessionId?: RuntimeSessionId,
  ): Pair {
    const now = Date.now();
    return new Pair({
      id: createId<PairId>('pair'),
      projectId,
      name,
      plannerSessionId,
      workerSessionId,
      status: 'idle',
      operationalState: DEFAULT_PAIR_OPERATIONAL_STATE,
      relayState: DEFAULT_PAIR_RELAY_STATE,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * IDLE -> ACTIVE. Permission to contact providers, nothing more.
   *
   * Pure state transition: it contacts no provider, reads no external surface,
   * and does not imply execution, readiness, or polling (I-4). Callers that need
   * to verify both sides before granting this permission are Load & Activate
   * (S6); nothing in S1 may call this on an operator-visible path.
   */
  public makeActive(reason?: string): void {
    this.operationalState = 'ACTIVE';
    this.updatedAt = Date.now();
    void reason;
  }

  /**
   * ACTIVE -> IDLE. Idempotent (freeze §4.5).
   *
   * Preserves everything: bindings, `activeAssignmentId`, history, checkpoints,
   * provenance and last-known evidence are all untouched (I-10). Only the
   * permission to contact providers is withdrawn.
   */
  public makeIdle(reason?: string): void {
    this.operationalState = 'IDLE';
    this.updatedAt = Date.now();
    void reason;
  }

  /**
   * The I-2 gate, and the ONLY place operational state is consulted for provider
   * contact. Reads `operationalState` and nothing else — never `status`, never a
   * runtime's last-known status or last observation. A stale historical value on
   * any of those must not be able to authorize contact.
   */
  public isProviderContactPermitted(): boolean {
    return this.operationalState === 'ACTIVE';
  }

  public assertProviderContactPermitted(): void {
    if (!this.isProviderContactPermitted()) {
      throw new RelayDomainError(
        `Pair is IDLE: provider contact is not permitted. Load & Activate the Pair to verify its sessions and grant contact permission. Persisted provider information is ` +
          'last-known evidence only (DESIGN_FREEZE I-2, I-3).',
        'PAIR_OPERATIONAL_STATE_IDLE',
      );
    }
  }

  /**
   * The single authority check for provider contact, determined by CALL CONTEXT (REALIGNMENT).
   *
   * 1. ACTIVATION: permitted for IDLE Pairs during loadAndActivate verification.
   * 2. OPERATOR_EXPLICIT: requires ACTIVE.
   * 3. AUTOMATED: requires ACTIVE AND RUNNING.
   */
  public assertContactPermitted(context: AuthorityContext): void {
    if (context === 'ACTIVATION') {
      // Activation verification is a deliberate special authority.
      // It may perform bounded contact necessary to verify an IDLE Pair.
      return;
    }

    if (context === 'OPERATOR_EXPLICIT') {
      this.assertProviderContactPermitted();
      return;
    }

    if (context === 'AUTOMATED') {
      if (!this.isAutomatedContactPermitted()) {
        throw new RelayDomainError(
          `Pair is not permitted for AUTOMATED contact: requires ACTIVE and RUNNING. ` +
            `(state: ${this.operationalState}, relay: ${this.relayState})`,
          'PAIR_AUTOMATED_CONTACT_FORBIDDEN',
        );
      }
      return;
    }
  }

  public update(name?: string, plannerSessionId?: RuntimeSessionId | null, workerSessionId?: RuntimeSessionId | null): void {
    if (name !== undefined) this.name = name;
    if (plannerSessionId !== undefined) this.plannerSessionId = plannerSessionId ?? undefined;
    if (workerSessionId !== undefined) this.workerSessionId = workerSessionId ?? undefined;
    this.updatedAt = Date.now();
  }

  public rebindPlanner(plannerSessionId: RuntimeSessionId): void {
    this.plannerSessionId = plannerSessionId;
    this.updatedAt = Date.now();
  }

  public rebindWorker(workerSessionId: RuntimeSessionId): void {
    this.workerSessionId = workerSessionId;
    this.updatedAt = Date.now();
  }

  public detachPlanner(): void {
    this.plannerSessionId = undefined;
    this.updatedAt = Date.now();
  }

  public detachWorker(): void {
    this.workerSessionId = undefined;
    this.updatedAt = Date.now();
  }

  /* --- Lifecycle / execution dimension (the single owner of `PairStatus`) ---
   *
   * These methods are the ONLY writers of `this.status`. They never write
   * `this.operationalState`, and a lifecycle change never changes operational
   * state: a Pair may be ACTIVE and blocked, or IDLE and archived (freeze §4.2).
   * This is what keeps the two dimensions from becoming competing state
   * machines over the deprecated `idle`/`active` aliases.
   */

  public archive(): void {
    this.status = 'archived';
    this.updatedAt = Date.now();
  }

  public unarchive(): void {
    this.status = this.activeAssignmentId ? 'active' : 'idle';
    this.updatedAt = Date.now();
  }

  public assignWork(assignmentId: AssignmentId): void {
    this.activeAssignmentId = assignmentId;
    // Manual Pause and Archived states must be authoritative.
    // Background assignment or reconciliation must not reactivate a manually paused or archived pair (I-10).
    if (this.status !== 'paused' && this.status !== 'archived') {
      this.status = 'active';
    }
    this.updatedAt = Date.now();
  }

  public clearWork(): void {
    this.activeAssignmentId = undefined;
    // Manual Pause and Archived states must be authoritative.
    if (this.status !== 'paused' && this.status !== 'archived') {
      this.status = 'idle';
    }
    this.updatedAt = Date.now();
  }

  public pause(): void {
    this.status = 'paused';
    this.updatedAt = Date.now();
  }

  public resume(): void {
    this.status = this.activeAssignmentId ? 'active' : 'idle';
    this.updatedAt = Date.now();
  }

  public markSupervised(): void {
    this.lastSupervisedAt = Date.now();
  }
}

/* --- RuntimeSession Entity --- */
export interface RuntimeSessionProps {
  id: RuntimeSessionId;
  providerType: ProviderType;
  name: string;
  bundleIdentifier?: string;
  windowTitle?: string;
  applicationPid?: number;
  status: RuntimeSessionStatus;
  consecutiveObservationFailures: number;
  lastHeartbeatAt?: number;
  lastObservedAt?: number;
  lastEvidence?: ObservableEvidence;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  archiveReason?: string;
  externalSessionId?: string | null;
  externalProjectRef?: string | null;
  sessionUrl?: string | null;
}

export class RuntimeSession {
  /* --- CHECKPOINT SEMANTIC FENCE (DESIGN_FREEZE §6.4, I-14; owned by S3) ---
   *
   * `lastEvidence` is the LATEST OBSERVATION. It is NOT an acknowledged or
   * consumed checkpoint, and it is NOT a synchronization cursor.
   *
   * The frozen rule this field must never violate: observation alone must never
   * advance the durable per-side synchronization checkpoint. If the checkpoint
   * moved on every observation there would be nothing left to compare against,
   * and `planner advanced` / `worker advanced` / `BOTH advanced` (I-8) could
   * never be detected. Checkpoint advancement is a separate, explicit, durable,
   * append-only act (S3).
   *
   * Until S3 introduces that durable model, this overwrite-on-write field is the
   * only per-side continuity carrier that exists, which is exactly why its role
   * must be named rather than left implicit. It is last-known evidence, and it is
   * rendered as last-known while the Pair is IDLE (I-3).
   */

  public readonly id: RuntimeSessionId;
  public readonly providerType: ProviderType;
  public name: string;
  public bundleIdentifier?: string;
  public windowTitle?: string;
  public applicationPid?: number;
  public status: RuntimeSessionStatus;
  public consecutiveObservationFailures: number;
  public lastHeartbeatAt?: number;
  public lastObservedAt?: number;
  public lastEvidence?: ObservableEvidence;
  public readonly createdAt: number;
  public updatedAt: number;
  public archivedAt?: number;
  public archiveReason?: string;
  public externalSessionId?: string | null;
  public externalProjectRef?: string | null;
  public sessionUrl?: string | null;

  constructor(props: RuntimeSessionProps) {
    this.id = props.id;
    this.providerType = props.providerType;
    this.name = props.name;
    this.bundleIdentifier = props.bundleIdentifier;
    this.windowTitle = props.windowTitle;
    this.applicationPid = props.applicationPid;
    this.status = props.status;
    this.consecutiveObservationFailures = props.consecutiveObservationFailures;
    this.lastHeartbeatAt = props.lastHeartbeatAt;
    this.lastObservedAt = props.lastObservedAt;
    this.lastEvidence = props.lastEvidence;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
    this.archivedAt = props.archivedAt;
    this.archiveReason = props.archiveReason;
    this.externalSessionId = props.externalSessionId ?? null;
    this.externalProjectRef = props.externalProjectRef ?? null;
    this.sessionUrl = props.sessionUrl ?? (props.externalSessionId?.startsWith('http') ? props.externalSessionId : null);
  }

  public static create(
    providerType: ProviderType,
    name: string,
    bundleIdentifier?: string,
  ): RuntimeSession {
    const now = Date.now();
    return new RuntimeSession({
      id: createId<RuntimeSessionId>('runtime'),
      providerType,
      name,
      bundleIdentifier,
      status: 'unknown',
      consecutiveObservationFailures: 0,
      createdAt: now,
      updatedAt: now,
      externalSessionId: null,
      externalProjectRef: null,
    });
  }

  /**
   * Hard Architectural Invariant #8 & #20:
   * A single observation failure NEVER immediately marks a runtime permanently dead.
   * Transition: working/available -> suspended -> inspect/retry -> available OR terminated (after thresholds).
   */
  public recordObservationFailure(maxFailuresBeforeTermination = 3): {
    previousStatus: RuntimeSessionStatus;
    newStatus: RuntimeSessionStatus;
  } {
    const prev = this.status;
    this.consecutiveObservationFailures += 1;
    this.updatedAt = Date.now();

    if (this.consecutiveObservationFailures === 1 && (this.status === 'working' || this.status === 'available' || this.status === 'idle' || this.status === 'unknown')) {
      // First failure moves to suspended, NOT terminated
      this.status = 'suspended';
    } else if (this.consecutiveObservationFailures >= maxFailuresBeforeTermination) {
      this.status = 'terminated';
    }

    return { previousStatus: prev, newStatus: this.status };
  }

  public recordObservationSuccess(
    status: RuntimeSessionStatus,
    evidence?: ObservableEvidence,
    windowTitle?: string,
    pid?: number,
  ): { previousStatus: RuntimeSessionStatus; newStatus: RuntimeSessionStatus } {
    const prev = this.status;
    this.consecutiveObservationFailures = 0;
    this.status = status;
    this.lastObservedAt = Date.now();
    if (evidence) this.lastEvidence = evidence;
    const resolvedTitle = windowTitle ?? evidence?.windowTitle;
    if (resolvedTitle) this.windowTitle = resolvedTitle;
    const resolvedPid = pid ?? evidence?.applicationPid;
    if (resolvedPid) this.applicationPid = resolvedPid;
    this.updatedAt = Date.now();
    return { previousStatus: prev, newStatus: this.status };
  }

  public recordHeartbeat(timestamp = Date.now()): void {
    this.lastHeartbeatAt = timestamp;
    this.updatedAt = timestamp;
    if (this.status === 'suspended') {
      this.status = 'available';
    }
  }

  public updateExternalIdentity(
    externalSessionId?: string | null,
    externalProjectRef?: string | null,
    sessionUrl?: string | null,
  ): void {
    if (externalSessionId !== undefined) this.externalSessionId = externalSessionId;
    if (externalProjectRef !== undefined) this.externalProjectRef = externalProjectRef;
    if (sessionUrl !== undefined) {
      this.sessionUrl = sessionUrl;
    } else if (externalSessionId && (externalSessionId.startsWith('http://') || externalSessionId.startsWith('https://'))) {
      this.sessionUrl = externalSessionId;
    }
    this.updatedAt = Date.now();
  }

  public archive(reason?: string): void {
    this.status = 'archived';
    this.archivedAt = Date.now();
    this.archiveReason = reason;
    this.updatedAt = Date.now();
  }

  public unarchive(): void {
    this.status = 'unknown'; // Will be updated by next observation
    this.archivedAt = undefined;
    this.archiveReason = undefined;
    this.updatedAt = Date.now();
  }
}

/* --- Delivery Entity --- */
export interface DeliveryProps {
  id: DeliveryId;
  assignmentId: AssignmentId;
  attemptId: AttemptId;
  targetRuntimeId: RuntimeSessionId;
  status: DeliveryStatus;
  idempotencyKey: string;
  instructionSnippet: string;
  evidence?: ObservableEvidence;
  deliveredAt?: number;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

export class Delivery {
  public readonly id: DeliveryId;
  public readonly assignmentId: AssignmentId;
  public readonly attemptId: AttemptId;
  public readonly targetRuntimeId: RuntimeSessionId;
  public status: DeliveryStatus;
  public readonly idempotencyKey: string;
  public readonly instructionSnippet: string;
  public evidence?: ObservableEvidence;
  public deliveredAt?: number;
  public failureReason?: string;
  public readonly createdAt: number;
  public updatedAt: number;

  constructor(props: DeliveryProps) {
    this.id = props.id;
    this.assignmentId = props.assignmentId;
    this.attemptId = props.attemptId;
    this.targetRuntimeId = props.targetRuntimeId;
    this.status = props.status;
    this.idempotencyKey = props.idempotencyKey;
    this.instructionSnippet = props.instructionSnippet;
    this.evidence = props.evidence;
    this.deliveredAt = props.deliveredAt;
    this.failureReason = props.failureReason;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  public static create(
    assignmentId: AssignmentId,
    attemptId: AttemptId,
    targetRuntimeId: RuntimeSessionId,
    instructionSnippet: string,
    idempotencyKey: string,
  ): Delivery {
    const now = Date.now();
    return new Delivery({
      id: createId<DeliveryId>('deliv'),
      assignmentId,
      attemptId,
      targetRuntimeId,
      status: 'pending',
      idempotencyKey,
      instructionSnippet,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Durable dispatch intent committed — does NOT mean external send is in
   *  progress. See SEMANTIC_FREEZE (§Durable Intent). */
  public startDelivering(): void {
    if (this.status !== 'pending') {
      throw new InvalidStateTransitionError(this.status, 'delivering', 'Delivery');
    }
    this.status = 'delivering';
    this.updatedAt = Date.now();
  }

  /**
   * Section 5: Delivery requires verified observable evidence
   */
  /** Confirmed delivery only — NOT execution proof. The provider returned delivered
   *  with ObservableEvidence. Worker execution began only if Attempt.status moves
   *  to `running` (requires separate execution evidence). See SEMANTIC_FREEZE. */
  public confirmDelivered(evidence: ObservableEvidence): void {
    if (!evidence) {
      throw new MissingEvidenceError('confirmDelivered');
    }
    this.status = 'delivered';
    this.evidence = evidence;
    this.deliveredAt = Date.now();
    this.updatedAt = Date.now();
  }

  /**
   * Section 9: Delivery safety.
   * If Relay cannot determine whether a message was sent, mark it ambiguous.
   * Do NOT automatically resend!
   */
  public markAmbiguous(reason: string, evidence?: ObservableEvidence): void {
    this.status = 'ambiguous';
    this.failureReason = reason;
    if (evidence) this.evidence = evidence;
    this.updatedAt = Date.now();
  }

  public markFailed(reason: string, evidence?: ObservableEvidence): void {
    this.status = 'failed';
    this.failureReason = reason;
    if (evidence) this.evidence = evidence;
    this.updatedAt = Date.now();
  }
}

/* --- Handoff Entity --- */
export interface HandoffProps {
  id: HandoffId;
  assignmentId: AssignmentId;
  attemptId: AttemptId;
  status: HandoffStatus;
  resultSummary?: string;
  payload?: Record<string, unknown>;
  /**
   * Evidence that the WORKER physically produced the result. Set by
   * {@link Handoff.markReady}. This is a `provider-produced` fact about the
   * Worker side and nothing else.
   */
  evidence?: ObservableEvidence;
  /**
   * Evidence that the PLANNER was externally notified. Set only by
   * {@link Handoff.markDeliveredToPlanner}, and only with provider evidence.
   *
   * Deliberately a SEPARATE field from `evidence`: the two are different claims
   * about different external systems, and one must never overwrite the other
   * (§7.3, I-13). Before this split, delivering to the Planner destroyed the
   * record of what the Worker actually produced.
   */
  plannerDeliveryEvidence?: ObservableEvidence;
  deliveredToPlannerAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export class Handoff {
  public readonly id: HandoffId;
  public readonly assignmentId: AssignmentId;
  public readonly attemptId: AttemptId;
  public status: HandoffStatus;
  public resultSummary?: string;
  public payload?: Record<string, unknown>;
  public evidence?: ObservableEvidence;
  public plannerDeliveryEvidence?: ObservableEvidence;
  public deliveredToPlannerAt?: number;
  public completedAt?: number;
  public readonly createdAt: number;
  public updatedAt: number;

  constructor(props: HandoffProps) {
    this.id = props.id;
    this.assignmentId = props.assignmentId;
    this.attemptId = props.attemptId;
    this.status = props.status;
    this.resultSummary = props.resultSummary;
    this.payload = props.payload;
    this.evidence = props.evidence;
    this.plannerDeliveryEvidence = props.plannerDeliveryEvidence;
    this.deliveredToPlannerAt = props.deliveredToPlannerAt;
    this.completedAt = props.completedAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  public static create(assignmentId: AssignmentId, attemptId: AttemptId): Handoff {
    const now = Date.now();
    return new Handoff({
      id: createId<HandoffId>('handoff'),
      assignmentId,
      attemptId,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  }

  public markReady(summary: string, payload?: Record<string, unknown>, evidence?: ObservableEvidence): void {
    this.status = 'ready';
    this.resultSummary = summary;
    this.payload = payload;
    if (evidence) this.evidence = evidence;
    this.updatedAt = Date.now();
  }

  /**
   * Record that the Planner was externally notified.
   *
   * REQUIRES provider evidence. `HandoffStatus`/`deliveredToPlannerAt` is a
   * durable assertion about the external world, so it is gated exactly like
   * `Delivery.confirmDelivered`: without evidence this throws rather than
   * writing a claim RelayX cannot support. Before this gate existed,
   * `RelayEngine.deliverHandoffToPlanner()` called it with no provider call at
   * all, which manufactured Planner-delivery evidence from a pure local
   * transition (DESIGN_FREEZE §9.4.1, §7.3).
   */
  public markDeliveredToPlanner(evidence: ObservableEvidence): void {
    if (!evidence) {
      throw new MissingEvidenceError('markDeliveredToPlanner');
    }
    this.status = 'delivered';
    // Written to its OWN field. `this.evidence` records what the Worker
    // produced; overwriting it here would destroy a `provider-produced`
    // provenance record (§7.3, I-13) in order to record a different one.
    this.plannerDeliveryEvidence = evidence;
    this.deliveredToPlannerAt = Date.now();
    this.updatedAt = Date.now();
  }

  /**
   * Hard Invariant #6:
   * Handoff completion (e.g. planner accepted or worker started) does NOT equal assignment completion!
   */
  public completeHandoff(): void {
    this.status = 'complete';
    this.completedAt = Date.now();
    this.updatedAt = Date.now();
  }
}

/* --- Attempt Entity --- */
/**
 * Execution authority frozen at dispatch (EXECUTION_AUTHORITY.md §2).
 *
 * CONFIRMED: sessionPairId, workerSessionId.
 * REVISED-ADD: externalSessionId (RuntimeSession.updateExternalIdentity() is mutable,
 * so the internal id alone is not sufficient to identify the external session).
 * REJECTED: providerType (redundant with the immutable RuntimeSession record),
 *           frozenAt (audit metadata only, never part of identity comparison),
 *           execution_epoch (all stale cases are covered by identity + lifecycle).
 *
 * All three are nullable because the `attempts` table columns are nullable and
 * SqliteAttemptRepository maps them as `| undefined`. Production dispatch ALWAYS
 * supplies the full tuple; see hasFrozenAuthority().
 */
export interface AttemptAuthority {
  sessionPairId?: PairId;
  workerSessionId?: RuntimeSessionId;
  externalSessionId: string | null;
}

export const NO_ATTEMPT_AUTHORITY: AttemptAuthority = {
  sessionPairId: undefined,
  workerSessionId: undefined,
  externalSessionId: null,
};

export interface AttemptProps extends AttemptAuthority {
  id: AttemptId;
  assignmentId: AssignmentId;
  attemptNumber: number;
  status: AttemptStatus;
  startedAt: number;
  finishedAt?: number;
  failureReason?: string;
  evidence?: ObservableEvidence;
}

/**
 * An Attempt is ONE PHYSICAL EXECUTION INSTANCE (ATTEMPT_LIFECYCLE.md §0, §5).
 *
 * `status` is Dimension A (physical execution state) ONLY. Verification is a separate
 * linked record (Dimension B) and must never move this field. Dispatch uncertainty is
 * carried by Delivery (Dimension C). Assignment resolution is derived (Dimension D).
 *
 * Legal transitions:
 *   prepared  -> running             (startRunning)      delivery confirmed
 *   running   -> completed_physical  (completePhysical)  worker physically finished
 *   prepared|running -> interrupted  (interrupt)         runtime lost / physical failure
 *
 * There is deliberately NO `failed` state. A completed-but-wrong result is
 * `completed_physical` + verification_failed, NOT a failed attempt (ATTEMPT_LIFECYCLE.md
 * §5 Case 4, explicitly REJECTED). A crashed/timeout attempt is `interrupted` (Case 5).
 */
export class Attempt {
  public readonly id: AttemptId;
  public readonly assignmentId: AssignmentId;
  public readonly attemptNumber: number;
  public status: AttemptStatus;
  public readonly startedAt: number;
  public finishedAt?: number;
  public failureReason?: string;
  public evidence?: ObservableEvidence;
  /** Immutable once created. */
  public readonly sessionPairId?: PairId;
  /** Immutable once created. */
  public readonly workerSessionId?: RuntimeSessionId;
  /** Immutable once created. */
  public readonly externalSessionId: string | null;

  constructor(props: AttemptProps) {
    this.id = props.id;
    this.assignmentId = props.assignmentId;
    this.attemptNumber = props.attemptNumber;
    this.status = props.status;
    this.startedAt = props.startedAt;
    this.finishedAt = props.finishedAt;
    this.failureReason = props.failureReason;
    this.evidence = props.evidence;
    this.sessionPairId = props.sessionPairId;
    this.workerSessionId = props.workerSessionId;
    this.externalSessionId = props.externalSessionId ?? null;
  }

  /**
   * prepareAttempt() — freeze authority, enter `prepared`.
   * Durable dispatch intent is recorded by the caller (Delivery) and must be COMMITTED
   * before the external send (ATTEMPT_LIFECYCLE.md Case 1).
   */
  public static create(
    assignmentId: AssignmentId,
    attemptNumber: number,
    authority: AttemptAuthority = NO_ATTEMPT_AUTHORITY,
  ): Attempt {
    return new Attempt({
      id: createId<AttemptId>('att'),
      assignmentId,
      attemptNumber,
      status: 'prepared',
      startedAt: Date.now(),
      sessionPairId: authority.sessionPairId,
      workerSessionId: authority.workerSessionId,
      externalSessionId: authority.externalSessionId ?? null,
    });
  }

  /** True when the full dispatch-time authority tuple is present. */
  public hasFrozenAuthority(): boolean {
    return (
      this.sessionPairId !== undefined &&
      this.workerSessionId !== undefined &&
      this.externalSessionId !== null
    );
  }

  /**
   * Case 6 — evidence originating from obsolete execution authority must not mutate
   * current state. Returns true when the supplied identities match this attempt's
   * frozen authority. An attempt with no frozen authority rejects all evidence.
   */
  public matchesAuthority(authority: {
    sessionPairId?: PairId;
    workerSessionId?: RuntimeSessionId;
    externalSessionId?: string | null;
  }): boolean {
    if (!this.hasFrozenAuthority()) return false;
    return (
      this.sessionPairId === authority.sessionPairId &&
      this.workerSessionId === authority.workerSessionId &&
      this.externalSessionId === (authority.externalSessionId ?? null)
    );
  }

  /** `startRunning()` — requires execution evidence distinct from Delivery confirmation.
   *  `running` means the target side has begun execution based on provider observation
   *  or exact-session reconciliation; `Delivery.confirmDelivered()` alone is insufficient.
   *  See SEMANTIC_FREEZE (§Durable Intent, §Execution State). */
  public startRunning(): void {
    if (this.status !== 'prepared') {
      throw new InvalidStateTransitionError(this.status, 'running', 'Attempt');
    }
    this.status = 'running';
  }

  /**
   * recordExecutionCompleted() — Dimension A only.
   * Must be reachable regardless of verification or planner review timelines
   * (ATTEMPT_LIFECYCLE.md Case 3). Verification never calls this and never moves
   * physical state.
   */
  public completePhysical(evidence?: ObservableEvidence): void {
    if (this.status !== 'running') {
      throw new InvalidStateTransitionError(this.status, 'completed_physical', 'Attempt');
    }
    this.status = 'completed_physical';
    this.finishedAt = Date.now();
    if (evidence) this.evidence = evidence;
  }

  /**
   * interruptionAttempt() — runtime/process lost mid-work. Execution is suspended;
   * repository mutations survive and are NOT rolled back (I11, Case 5).
   */
  public interrupt(reason: string, evidence?: ObservableEvidence): void {
    if (this.status === 'completed_physical') {
      throw new InvalidStateTransitionError(this.status, 'interrupted', 'Attempt');
    }
    this.status = 'interrupted';
    this.finishedAt = Date.now();
    this.failureReason = reason;
    if (evidence) this.evidence = evidence;
  }
}

/* --- Assignment Entity --- */
export interface AssignmentProps {
  id: AssignmentId;
  pairId: PairId;
  projectId: ProjectId;
  title: string;
  instruction: string;
  /** The Pair side that must execute this Assignment. Legacy rows default to worker. */
  targetSideRole?: PairSideRole;
  /** Present when this Assignment was deterministically derived from a Handoff. */
  sourceHandoffId?: HandoffId;
  status: AssignmentStatus;
  currentAttemptId?: AttemptId;
  activeDeliveryId?: DeliveryId;
  activeHandoffId?: HandoffId;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export class Assignment {
  public readonly id: AssignmentId;
  public readonly pairId: PairId;
  public readonly projectId: ProjectId;
  public title: string;
  public instruction: string;
  public readonly targetSideRole: PairSideRole;
  public readonly sourceHandoffId?: HandoffId;
  public status: AssignmentStatus;
  public currentAttemptId?: AttemptId;
  public activeDeliveryId?: DeliveryId;
  public activeHandoffId?: HandoffId;
  public readonly createdAt: number;
  public updatedAt: number;
  public completedAt?: number;

  constructor(props: AssignmentProps) {
    this.id = props.id;
    this.pairId = props.pairId;
    this.projectId = props.projectId;
    this.title = props.title;
    this.instruction = props.instruction;
    this.targetSideRole = props.targetSideRole ?? 'worker';
    this.sourceHandoffId = props.sourceHandoffId;
    this.status = props.status;
    this.currentAttemptId = props.currentAttemptId;
    this.activeDeliveryId = props.activeDeliveryId;
    this.activeHandoffId = props.activeHandoffId;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
    this.completedAt = props.completedAt;
  }

  public static create(
    pairId: PairId,
    projectId: ProjectId,
    title: string,
    instruction: string,
    targetSideRole: PairSideRole = 'worker',
    sourceHandoffId?: HandoffId,
  ): Assignment {
    const now = Date.now();
    return new Assignment({
      id: createId<AssignmentId>('asgn'),
      pairId,
      projectId,
      title,
      instruction,
      targetSideRole,
      sourceHandoffId,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  }

  public startAttempt(attempt: Attempt): void {
    if (this.status === 'completed' || this.status === 'cancelled') {
      throw new InvalidStateTransitionError(this.status, 'active', 'Assignment');
    }
    this.status = 'active';
    this.currentAttemptId = attempt.id;
    this.activeDeliveryId = undefined; // Reset active delivery for the new attempt
    this.updatedAt = Date.now();
  }

  public attachDelivery(delivery: Delivery): void {
    if (this.activeDeliveryId && delivery.id !== this.activeDeliveryId) {
      // Invariant: duplicate delivery check
      throw new DuplicateDeliveryAttemptError(
        `Assignment ${this.id} already has active delivery ${this.activeDeliveryId}`,
      );
    }
    this.activeDeliveryId = delivery.id;
    this.updatedAt = Date.now();
  }

  public markWaitingForHandoff(handoffId: HandoffId): void {
    this.status = 'waiting_for_handoff';
    this.activeHandoffId = handoffId;
    this.updatedAt = Date.now();
  }

  public complete(): void {
    this.status = 'completed';
    this.completedAt = Date.now();
    this.updatedAt = Date.now();
  }

  public fail(): void {
    this.status = 'failed';
    this.updatedAt = Date.now();
  }

  public cancel(): void {
    this.status = 'cancelled';
    this.updatedAt = Date.now();
  }
}

/* --- Event Entity --- */
export interface EventProps {
  id: EventId;
  timestamp: number;
  resourceType: 'project' | 'pair' | 'runtime' | 'assignment' | 'attempt' | 'delivery' | 'handoff' | 'attention';
  resourceId: string;
  eventType: string;
  actor: 'user' | 'engine' | 'supervisor' | 'reconciler' | 'recovery' | 'provider';
  previousState?: string;
  newState?: string;
  evidence?: ObservableEvidence;
  correlationId?: string;
  details?: Record<string, unknown>;
  severity?: 'info' | 'warn' | 'error' | 'critical';
  area?: string;
  outcome?: string;
  isArchived?: boolean;
}

export class RelayEvent {
  public readonly id: EventId;
  public readonly timestamp: number;
  public readonly resourceType: EventProps['resourceType'];
  public readonly resourceId: string;
  public readonly eventType: string;
  public readonly actor: EventProps['actor'];
  public readonly previousState?: string;
  public readonly newState?: string;
  public readonly evidence?: ObservableEvidence;
  public readonly correlationId?: string;
  public readonly details?: Record<string, unknown>;
  public readonly severity: 'info' | 'warn' | 'error' | 'critical';
  public readonly area: string;
  public readonly outcome?: string;
  public readonly isArchived: boolean;

  constructor(props: EventProps) {
    this.id = props.id;
    this.timestamp = props.timestamp;
    this.resourceType = props.resourceType;
    this.resourceId = props.resourceId;
    this.eventType = props.eventType;
    this.actor = props.actor;
    this.previousState = props.previousState;
    this.newState = props.newState;
    this.evidence = props.evidence;
    this.correlationId = props.correlationId;
    this.details = props.details;
    this.severity = props.severity ?? (props.eventType.includes('failed') || props.eventType.includes('ambiguous') || props.eventType.includes('interrupted') ? 'error' : props.eventType.includes('warning') ? 'warn' : 'info');
    this.area = props.area ?? props.resourceType;
    this.outcome = props.outcome;
    this.isArchived = props.isArchived ?? false;
  }

  public static create(
    resourceType: EventProps['resourceType'],
    resourceId: string,
    eventType: string,
    options: Partial<Omit<EventProps, 'id' | 'timestamp' | 'resourceType' | 'resourceId' | 'eventType'>> = {},
  ): RelayEvent {
    const defaultSeverity = eventType.includes('failed') || eventType.includes('ambiguous') || eventType.includes('interrupted') ? 'error' : 'info';
    return new RelayEvent({
      id: createId<EventId>('evt'),
      timestamp: Date.now(),
      resourceType,
      resourceId,
      eventType,
      actor: options.actor ?? 'engine',
      previousState: options.previousState,
      newState: options.newState,
      evidence: options.evidence,
      correlationId: options.correlationId,
      details: options.details,
      severity: options.severity ?? defaultSeverity,
      area: options.area ?? resourceType,
      outcome: options.outcome,
      isArchived: options.isArchived ?? false,
    });
  }
}

/* --- AttentionItem Entity --- */
export interface AttentionItemProps {
  id: AttentionItemId;
  pairId?: PairId;
  assignmentId?: AssignmentId;
  severity: AttentionSeverity;
  status: AttentionStatus;
  type: string;
  title: string;
  message: string;
  suggestedAction?: string;
  suggestedTier?: RecoveryTier;
  createdAt: number;
  resolvedAt?: number;
}

export class AttentionItem {
  public readonly id: AttentionItemId;
  public readonly pairId?: PairId;
  public readonly assignmentId?: AssignmentId;
  public severity: AttentionSeverity;
  public status: AttentionStatus;
  public readonly type: string;
  public readonly title: string;
  public readonly message: string;
  public suggestedAction?: string;
  public suggestedTier?: RecoveryTier;
  public readonly createdAt: number;
  public resolvedAt?: number;

  constructor(props: AttentionItemProps) {
    this.id = props.id;
    this.pairId = props.pairId;
    this.assignmentId = props.assignmentId;
    this.severity = props.severity;
    this.status = props.status;
    this.type = props.type;
    this.title = props.title;
    this.message = props.message;
    this.suggestedAction = props.suggestedAction;
    this.suggestedTier = props.suggestedTier;
    this.createdAt = props.createdAt;
    this.resolvedAt = props.resolvedAt;
  }

  public static create(
    severity: AttentionSeverity,
    type: string,
    title: string,
    message: string,
    options: {
      pairId?: PairId;
      assignmentId?: AssignmentId;
      suggestedAction?: string;
      suggestedTier?: RecoveryTier;
    } = {},
  ): AttentionItem {
    return new AttentionItem({
      id: createId<AttentionItemId>('att_item'),
      pairId: options.pairId,
      assignmentId: options.assignmentId,
      severity,
      status: 'open',
      type,
      title,
      message,
      suggestedAction: options.suggestedAction,
      suggestedTier: options.suggestedTier ?? 'tier_1_deterministic',
      createdAt: Date.now(),
    });
  }

  public acknowledge(): void {
    this.status = 'acknowledged';
  }

  public resolve(): void {
    this.status = 'resolved';
    this.resolvedAt = Date.now();
  }
}

/* --- RuntimeProjectAssociation Entity --- */
export interface RuntimeProjectAssociationProps {
  id: AssociationId;
  runtimeSessionId: RuntimeSessionId;
  projectId: ProjectId;
  providerType?: ProviderType | null;
  externalSessionId?: string | null;
  verificationState: 'verified' | 'unverified' | 'stale';
  provenance: 'discovery' | 'adoption' | 'setup' | 'manual_registration' | 'pair_binding';
  createdAt: number;
  updatedAt: number;
}

export class RuntimeProjectAssociation {
  public readonly id: AssociationId;
  public readonly runtimeSessionId: RuntimeSessionId;
  public readonly projectId: ProjectId;
  public providerType?: ProviderType | null;
  public externalSessionId?: string | null;
  public readonly verificationState: RuntimeProjectAssociationProps['verificationState'];
  public readonly provenance: RuntimeProjectAssociationProps['provenance'];
  public readonly createdAt: number;
  public updatedAt: number;

  constructor(props: RuntimeProjectAssociationProps) {
    this.id = props.id;
    this.runtimeSessionId = props.runtimeSessionId;
    this.projectId = props.projectId;
    this.providerType = props.providerType ?? null;
    this.externalSessionId = props.externalSessionId ?? null;
    this.verificationState = props.verificationState;
    this.provenance = props.provenance;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  public static create(
    runtimeSessionId: RuntimeSessionId,
    projectId: ProjectId,
    externalSessionId: string | null,
    verificationState: RuntimeProjectAssociationProps['verificationState'] = 'verified',
    provenance: RuntimeProjectAssociationProps['provenance'] = 'adoption',
    providerType?: ProviderType | null,
  ): RuntimeProjectAssociation {
    return new RuntimeProjectAssociation({
      id: createId<AssociationId>('assoc'),
      runtimeSessionId,
      projectId,
      providerType,
      externalSessionId,
      verificationState,
      provenance,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  public withVerificationState(state: RuntimeProjectAssociationProps['verificationState']): RuntimeProjectAssociation {
    return new RuntimeProjectAssociation({
      id: this.id,
      runtimeSessionId: this.runtimeSessionId,
      projectId: this.projectId,
      providerType: this.providerType,
      externalSessionId: this.externalSessionId,
      verificationState: state,
      provenance: this.provenance,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
    });
  }
}

/* --- PairCheckpoint Entity --- */
export interface PairCheckpointProps {
  id: PairCheckpointId;
  pairId: PairId;
  createdAt: number;
  reason: string;
  objective?: string | null;
  currentMilestone?: string | null;
  summary?: string | null;
  pendingWork?: string | null;
  nextAction?: string | null;
  latestAssignmentId?: AssignmentId | null;
  latestAttemptId?: AttemptId | null;
  latestDeliveryId?: DeliveryId | null;
  plannerContext?: Record<string, unknown> | string | null;
  workerContext?: Record<string, unknown> | string | null;
  repoHead?: string | null;
  metadata?: Record<string, unknown> | string | null;
}

export class PairCheckpoint {
  public readonly id: PairCheckpointId;
  public readonly pairId: PairId;
  public readonly createdAt: number;
  public readonly reason: string;
  public readonly objective: string | null;
  public readonly currentMilestone: string | null;
  public readonly summary: string | null;
  public readonly pendingWork: string | null;
  public readonly nextAction: string | null;
  public readonly latestAssignmentId: AssignmentId | null;
  public readonly latestAttemptId: AttemptId | null;
  public readonly latestDeliveryId: DeliveryId | null;
  public readonly plannerContext: Record<string, unknown> | string | null;
  public readonly workerContext: Record<string, unknown> | string | null;
  public readonly repoHead: string | null;
  public readonly metadata: Record<string, unknown> | string | null;

  constructor(props: PairCheckpointProps) {
    this.id = props.id;
    this.pairId = props.pairId;
    this.createdAt = props.createdAt;
    this.reason = props.reason;
    this.objective = props.objective ?? null;
    this.currentMilestone = props.currentMilestone ?? null;
    this.summary = props.summary ?? null;
    this.pendingWork = props.pendingWork ?? null;
    this.nextAction = props.nextAction ?? null;
    this.latestAssignmentId = props.latestAssignmentId ?? null;
    this.latestAttemptId = props.latestAttemptId ?? null;
    this.latestDeliveryId = props.latestDeliveryId ?? null;
    this.plannerContext = props.plannerContext ?? null;
    this.workerContext = props.workerContext ?? null;
    this.repoHead = props.repoHead ?? null;
    this.metadata = props.metadata ?? null;
  }

  public static create(props: Omit<PairCheckpointProps, 'id' | 'createdAt'>): PairCheckpoint {
    return new PairCheckpoint({
      id: createId<PairCheckpointId>('chk'),
      createdAt: Date.now(),
      ...props,
    });
  }
}

/* --- Plan-First execution domain ---
 * Implemented in its own module (PLAN_FIRST_DOMAIN_FREEZE.md §B) and re-exported here so
 * that a single `entities.ts` import surface remains available to callers and tests.
 */
export {
  ContractRevision,
  WorkUnit,
  PlanFirstRun,
  canonicalizeSemanticFields,
  digestCanonicalText,
  deriveCurrentWorkUnit,
  allWorkUnitsCompleted,
} from './planFirst.ts';
export type {
  ContractRevisionProps,
  WorkUnitProps,
  PlanFirstRunProps,
  DerivedCursor,
} from './planFirst.ts';
