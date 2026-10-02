import {
  ProjectId,
  PairId,
  RuntimeSessionId,
  AssignmentId,
  AttemptId,
  DeliveryId,
  HandoffId,
  EventId,
  AttentionItemId,
  AssociationId,
  ProviderType,
  ContractRevisionId,
  PlanFirstRunId,
  WorkUnitId,
  VerificationResultId,
  PairSideRole,
  PairSideIdentity,
  PairSideCheckpoint,
  PairCheckpointId,
  ObservableEvidence,
} from '../domain/types.ts';
import {
  Project,
  Pair,
  RuntimeSession,
  Assignment,
  Attempt,
  Delivery,
  Handoff,
  RelayEvent,
  AttentionItem,
  RuntimeProjectAssociation,
  ContractRevision,
  WorkUnit,
  PlanFirstRun,
  PairCheckpoint,
} from '../domain/entities.ts';
import type { VerificationResult as VerificationResultRecord } from '../domain/repoBoundary.ts';

export interface IProjectRepository {
  findById(id: ProjectId): Promise<Project | null>;
  findByPath(path: string): Promise<Project | null>;
  findAll(): Promise<Project[]>;
  save(project: Project): Promise<void>;
  delete(id: ProjectId): Promise<void>;
}

export interface IPairRepository {
  findById(id: PairId): Promise<Pair | null>;
  findByProjectId(projectId: ProjectId): Promise<Pair[]>;
  findAll(): Promise<Pair[]>;
  /**
   * S6 CLOSURE — the authoritative reverse lookup: which Pair(s) bind this runtime
   * session, on either side.
   *
   * ## Why this lives here, and not somewhere invented
   *
   * `Pair.plannerSessionId` / `Pair.workerSessionId` ARE RelayX's durable binding
   * ground truth. This repository is the layer that owns them, so the reverse
   * lookup belongs here. Ownership is derived ONLY from those two columns, by
   * identifier: never from an OpenCode session title, a ChatGPT or window title, a
   * project name, a workspace basename, a lifecycle `PairStatus`, or the
   * frontmost window (I-11).
   *
   * ## Why it returns an array
   *
   * The `pairs` table carries **no unique index** on either binding column — the
   * application layer rejects a second binding with `SESSION_ALREADY_PAIRED`, but
   * the schema does not enforce it, and a raw entity save can produce the state.
   * Collapsing that into "the first match" would be a heuristic choice of owner,
   * which is exactly what a fail-closed ownership resolution must never do. So the
   * ambiguity is representable, and the caller fails closed on it.
   *
   * An empty array means the runtime is not bound to any Pair. That is an honest
   * answer, not a permission grant.
   */
  findByRuntimeSessionId(runtimeSessionId: RuntimeSessionId): Promise<Pair[]>;
  save(pair: Pair): Promise<void>;
  delete(id: PairId): Promise<void>;
}

/**
 * S5 durable per-side identity evidence.
 *
 * The S5 subset of the §10.3 `side_observations` proposal: dimensions 1-3 plus
 * the mandatory dimensions 8 and 9. Upsert semantics are deliberate — the latest
 * observation per (pair, side) is the last-known evidence I-3 renders while IDLE.
 * History lives in the event stream, not in this table.
 */
export interface IPairSideIdentityRepository {
  findByPair(pairId: PairId): Promise<PairSideIdentity[]>;
  find(pairId: PairId, sideRole: PairSideRole): Promise<PairSideIdentity | null>;
  save(identity: PairSideIdentity): Promise<void>;
  deleteForPair(pairId: PairId): Promise<void>;
}

/**
 * S3 append-only checkpoint repository.
 *
 * Checkpoints are immutable records representing operator baseline establishment
 * or explicit operator acknowledgment/reconciliation. They are NEVER mutated or
 * deleted in-place (append-only history).
 */
export interface IPairSideCheckpointRepository {
  findLatest(pairId: PairId, sideRole: PairSideRole): Promise<PairSideCheckpoint | null>;
  findAll(pairId: PairId, sideRole?: PairSideRole): Promise<PairSideCheckpoint[]>;
  save(checkpoint: PairSideCheckpoint): Promise<void>;
  deleteForPair(pairId: PairId): Promise<void>;
}

export interface IPairCheckpointRepository {
  create(checkpoint: PairCheckpoint): Promise<void>;
  createPairCheckpoint(checkpoint: PairCheckpoint): Promise<void>;
  findById(id: PairCheckpointId): Promise<PairCheckpoint | null>;
  getPairCheckpoint(id: PairCheckpointId): Promise<PairCheckpoint | null>;
  findLatest(pairId: PairId): Promise<PairCheckpoint | null>;
  getLatestPairCheckpoint(pairId: PairId): Promise<PairCheckpoint | null>;
  findAll(pairId: PairId): Promise<PairCheckpoint[]>;
  listPairCheckpoints(pairId: PairId): Promise<PairCheckpoint[]>;
}

export interface IRuntimeSessionRepository {
  findById(id: RuntimeSessionId): Promise<RuntimeSession | null>;
  findByBundleId(bundleId: string): Promise<RuntimeSession[]>;
  findByExternalSessionId(providerType: string, externalSessionId: string): Promise<RuntimeSession | null>;
  findAll(): Promise<RuntimeSession[]>;
  findActive(): Promise<RuntimeSession[]>;
  save(session: RuntimeSession): Promise<void>;
  delete(id: RuntimeSessionId): Promise<void>;
}

export interface IAssignmentRepository {
  findById(id: AssignmentId): Promise<Assignment | null>;
  findByPairId(pairId: PairId): Promise<Assignment[]>;
  findAll(): Promise<Assignment[]>;
  findActive(): Promise<Assignment[]>;
  save(assignment: Assignment): Promise<void>;
  delete(id: AssignmentId): Promise<void>;
}

export interface IAttemptRepository {
  findById(id: AttemptId): Promise<Attempt | null>;
  findByAssignmentId(assignmentId: AssignmentId): Promise<Attempt[]>;
  save(attempt: Attempt): Promise<void>;
}

export interface IDeliveryRepository {
  findById(id: DeliveryId): Promise<Delivery | null>;
  findByAssignmentId(assignmentId: AssignmentId): Promise<Delivery[]>;
  findAmbiguous(): Promise<Delivery[]>;
  /**
   * Deliveries whose dispatch intent is durable but whose outcome was never recorded.
   *
   * These are the records stranded by a crash between the committed dispatch intent and
   * the committed outcome. They are NOT yet known to be delivered, failed, or ambiguous —
   * that is precisely what reconciliation must determine from provider evidence.
   *
   * A delivery leaves this set exactly once, when reconciliation commits a terminal
   * disposition, which is what makes repeated reconciliation passes no-ops.
   */
  findUnresolved(): Promise<Delivery[]>;
  save(delivery: Delivery): Promise<void>;
}

export interface IHandoffRepository {
  findById(id: HandoffId): Promise<Handoff | null>;
  findByAssignmentId(assignmentId: AssignmentId): Promise<Handoff[]>;
  findPending(): Promise<Handoff[]>;
  save(handoff: Handoff): Promise<void>;
}

export interface IEventRepository {
  findById(id: EventId): Promise<RelayEvent | null>;
  findByResourceId(resourceId: string): Promise<RelayEvent[]>;
  findRecent(limit?: number): Promise<RelayEvent[]>;
  findFiltered(options: EventFilterOptions): Promise<{ events: RelayEvent[]; total: number }>;
  archiveOlderThan(timestamp: number): Promise<number>;
  clearEligible(options: { beforeTimestamp?: number; severity?: string; area?: string; includeArchived?: boolean }): Promise<number>;
  save(event: RelayEvent): Promise<void>;
}

export interface IActivityRepository {
  findAll(limit?: number): Promise<ActivityRecord[]>;
  save(record: ActivityRecord): Promise<void>;
  clear(): Promise<void>;
}

export interface EventFilterOptions {
  search?: string;
  severity?: string;
  area?: string;
  eventType?: string;
  actor?: string;
  resourceType?: string;
  resourceId?: string;
  correlationId?: string;
  startTime?: number;
  endTime?: number;
  isArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface ActivityRecord {
  id: string;
  timestamp: number;
  title: string;
  summary: string;
  category: string;
  status: string;
  resourceType: string;
  resourceId: string;
  correlationId?: string;
  evidence?: ObservableEvidence;
  details?: Record<string, unknown>;
}


export interface IAttentionRepository {
  findById(id: AttentionItemId): Promise<AttentionItem | null>;
  findOpen(): Promise<AttentionItem[]>;
  findAll(): Promise<AttentionItem[]>;
  save(item: AttentionItem): Promise<void>;
  acknowledge(id: AttentionItemId, actor?: string): Promise<void>;
}

export interface AssociationEvidenceCriteria {
  providerType: ProviderType;
  externalSessionId: string | null | undefined;
  projectId: ProjectId;
}

export interface IAssociationRepository {
  findById(id: AssociationId): Promise<RuntimeProjectAssociation | null>;
  findBySessionId(sessionId: RuntimeSessionId): Promise<RuntimeProjectAssociation[]>;
  findByProjectId(projectId: ProjectId): Promise<RuntimeProjectAssociation[]>;
  /**
   * Returns only a pre-existing, verified, provider-evidenced row. The criteria
   * are deliberately part of the repository contract so callers cannot treat a
   * runtime's manually populated fields as association proof.
   */
  findVerifiedBySessionId(
    sessionId: RuntimeSessionId,
    criteria: AssociationEvidenceCriteria,
  ): Promise<RuntimeProjectAssociation | null>;
  findAll(): Promise<RuntimeProjectAssociation[]>;
  save(assoc: RuntimeProjectAssociation): Promise<void>;
  delete(id: AssociationId): Promise<void>;
}

/**
 * Plan-First execution domain repositories.
 *
 * Canonical contract: PLAN_FIRST_DOMAIN_FREEZE.md §F. `any` is eliminated. Methods the
 * freeze rejected (`findNextEligible`, `updateStatus`, `findByContractAndStatus`) are
 * deliberately absent: eligibility and the current-unit cursor are pure domain functions
 * over an ordinal-ordered list (freeze §D.2), and all state changes go through domain
 * transitions inside a transaction.
 */
export interface IContractRevisionRepository {
  findById(id: ContractRevisionId): Promise<ContractRevision | null>;
  findByProjectId(projectId: ProjectId): Promise<ContractRevision[]>;
  /**
   * Project-scoped uniqueness lookup. Backed by UNIQUE (project_id, canonical_digest),
   * which is what makes revision creation idempotent: re-submitting an unchanged
   * contract returns the existing revision instead of creating a duplicate.
   */
  findByDigest(
    projectId: ProjectId,
    canonicalDigest: string,
  ): Promise<ContractRevision | null>;
  save(revision: ContractRevision): Promise<void>;
}

export interface IPlanFirstRunRepository {
  findById(id: PlanFirstRunId): Promise<PlanFirstRun | null>;
  findByContractRevisionId(contractRevisionId: ContractRevisionId): Promise<PlanFirstRun[]>;
  /**
   * Guards Invariant 6: at most one non-terminal run per (project, revision).
   * Backed by a partial unique index, so a concurrent tick loses at the database level
   * rather than creating a duplicate run.
   */
  findActiveByContractRevisionId(
    projectId: ProjectId,
    contractRevisionId: ContractRevisionId,
  ): Promise<PlanFirstRun | null>;
  findByProjectId(projectId: ProjectId): Promise<PlanFirstRun[]>;
  save(run: PlanFirstRun): Promise<void>;
}

export interface IWorkUnitRepository {
  findById(id: WorkUnitId): Promise<WorkUnit | null>;
  /**
   * Ordered by `ordinal` ASC. This is the ONLY ordering primitive in V1; the domain
   * derives eligibility and the cursor from it.
   */
  findByContractRevisionId(contractRevisionId: ContractRevisionId): Promise<WorkUnit[]>;
  /** Guards duplicate selection under concurrent ticks (Invariant 5). */
  findInProgressByContractRevisionId(
    contractRevisionId: ContractRevisionId,
  ): Promise<WorkUnit | null>;
  save(unit: WorkUnit): Promise<void>;
}

/**
 * Verification results are a SEPARATE linked record; they never mutate Attempt physical
 * state (ATTEMPT_LIFECYCLE.md §1 Dimension B). One result per attempt, enforced by a
 * unique index.
 */
export interface IVerificationResultRepository {
  findById(id: VerificationResultId): Promise<VerificationResultRecord | null>;
  /**
   * Required by the controller's verification-resume idempotency guard (freeze §G
   * step 10 / §F.1): a crash between "result written" and "unit completed" must resume,
   * never re-evaluate and never double-insert.
   */
  findByAttemptId(attemptId: AttemptId): Promise<VerificationResultRecord | null>;
  save(result: VerificationResultRecord): Promise<void>;
}

/**
 * One explicit operator/provider setting.
 *
 * `setBy` and `note` are part of the record, not decoration: a setting that changes how an
 * external system is contacted must always be attributable to a decision.
 */
export interface ProviderSetting {
  key: string;
  value: string;
  note: string | null;
  /** Who established the value: an operator identity, or `recovery` / `engine`. */
  setBy: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Operator/provider settings.
 *
 * There is intentionally no defaulting read. An absent key is a fact ("nobody chose this"),
 * not an invitation to substitute a value, and every caller states what absence means.
 */
export interface IProviderSettingsRepository {
  get(key: string): Promise<ProviderSetting | null>;
  list(): Promise<ProviderSetting[]>;
  save(setting: ProviderSetting): Promise<void>;
  /** Clear a setting. "Unset" is a real state and must be representable. */
  delete(key: string): Promise<void>;
}

export interface IRelayRepositories {
  projects: IProjectRepository;
  pairs: IPairRepository;
  sideIdentities: IPairSideIdentityRepository;
  sideCheckpoints: IPairSideCheckpointRepository;
  checkpoints: IPairCheckpointRepository;
  runtimes: IRuntimeSessionRepository;
  assignments: IAssignmentRepository;
  attempts: IAttemptRepository;
  deliveries: IDeliveryRepository;
  handoffs: IHandoffRepository;
  events: IEventRepository;
  activities: IActivityRepository;
  attention: IAttentionRepository;
  associations: IAssociationRepository;
  planFirstRuns: IPlanFirstRunRepository;
  workUnits: IWorkUnitRepository;
  contractRevisions: IContractRevisionRepository;
  verificationResults: IVerificationResultRepository;
  providerSettings: IProviderSettingsRepository;
  runInTransaction<T>(work: () => Promise<T>): Promise<T>;
}
