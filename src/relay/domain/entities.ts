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
  createId,
} from './types.ts';
import {
  InvalidStateTransitionError,
  MissingEvidenceError,
  DuplicateDeliveryAttemptError,
  AmbiguousDeliveryResendError,
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

  constructor(props: PairProps) {
    this.id = props.id;
    this.projectId = props.projectId;
    this.name = props.name;
    this.plannerSessionId = props.plannerSessionId ?? undefined;
    this.workerSessionId = props.workerSessionId ?? undefined;
    this.activeAssignmentId = props.activeAssignmentId;
    this.status = props.status;
    this.lastSupervisedAt = props.lastSupervisedAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
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
      createdAt: now,
      updatedAt: now,
    });
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
    this.status = 'active';
    this.updatedAt = Date.now();
  }

  public clearWork(): void {
    this.activeAssignmentId = undefined;
    this.status = 'idle';
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
}

export class RuntimeSession {
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
  ): void {
    if (externalSessionId !== undefined) this.externalSessionId = externalSessionId;
    if (externalProjectRef !== undefined) this.externalProjectRef = externalProjectRef;
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
  evidence?: ObservableEvidence;
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

  public markDeliveredToPlanner(): void {
    this.status = 'delivered';
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

  /** confirmDispatch() — external delivery acknowledged; physical execution begins. */
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
  ): Assignment {
    const now = Date.now();
    return new Assignment({
      id: createId<AssignmentId>('asgn'),
      pairId,
      projectId,
      title,
      instruction,
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
  }

  public static create(
    resourceType: EventProps['resourceType'],
    resourceId: string,
    eventType: string,
    options: Partial<Omit<EventProps, 'id' | 'timestamp' | 'resourceType' | 'resourceId' | 'eventType'>> = {},
  ): RelayEvent {
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
