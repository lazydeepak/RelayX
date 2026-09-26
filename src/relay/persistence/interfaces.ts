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
  save(pair: Pair): Promise<void>;
  delete(id: PairId): Promise<void>;
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
  save(event: RelayEvent): Promise<void>;
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

export interface IRelayRepositories {
  projects: IProjectRepository;
  pairs: IPairRepository;
  runtimes: IRuntimeSessionRepository;
  assignments: IAssignmentRepository;
  attempts: IAttemptRepository;
  deliveries: IDeliveryRepository;
  handoffs: IHandoffRepository;
  events: IEventRepository;
  attention: IAttentionRepository;
  associations: IAssociationRepository;
  planFirstRuns: IPlanFirstRunRepository;
  workUnits: IWorkUnitRepository;
  contractRevisions: IContractRevisionRepository;
  verificationResults: IVerificationResultRepository;
  runInTransaction<T>(work: () => Promise<T>): Promise<T>;
}
