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
  ContractRevisionId,
  PlanFirstRunId,
  WorkUnitId,
  VerificationResultId,
} from '../../domain/types.ts';
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
} from '../../domain/entities.ts';
import type { VerificationResult } from '../../domain/repoBoundary.ts';
import {
  IRelayRepositories,
  IProjectRepository,
  IPairRepository,
  IRuntimeSessionRepository,
  IAssignmentRepository,
  IAttemptRepository,
  IDeliveryRepository,
  IHandoffRepository,
  IEventRepository,
  IAttentionRepository,
  IAssociationRepository,
  IContractRevisionRepository,
  IPlanFirstRunRepository,
  IWorkUnitRepository,
  IVerificationResultRepository,
  AssociationEvidenceCriteria,
} from '../interfaces.ts';

/**
 * Snapshot used by memory transaction rollback: for each map entry we keep the
 * ORIGINAL entity reference (to restore map membership and preserve prototype /
 * object identity) plus a deep copy of its top-level field values (to revert
 * mutations made to an entity in place while it was mapped).
 */
export type MemoryRepoSnapshot<T> = Array<
  [key: string, original: T, fields: Record<string, unknown>]
>;

/**
 * Internal contract implemented by every memory repository so the memory
 * transaction wrapper can snapshot and restore all repository state uniformly.
 */
interface ISnapshotableMemoryRepo {
  snapshotState(): MemoryRepoSnapshot<unknown>;
  restoreState(snapshot: MemoryRepoSnapshot<unknown>): void;
}

/**
 * Deep-copies an entity's field values for snapshotting. Falls back to the
 * shallow spread when a value is not structured-cloneable (e.g. functions),
 * which still reverts every top-level entity mutation used by this model.
 */
function cloneEntityFields<T extends object>(entity: T): Record<string, unknown> {
  const plain = { ...entity } as Record<string, unknown>;
  const structuredClone = (globalThis as {
    structuredClone?: <V>(value: V) => V;
  }).structuredClone;
  if (typeof structuredClone !== 'function') return plain;
  try {
    return structuredClone(plain);
  } catch {
    return plain;
  }
}

function snapshotMapItems<T extends object>(items: Map<string, T>): MemoryRepoSnapshot<T> {
  const snapshot: MemoryRepoSnapshot<T> = [];
  for (const [key, entity] of items) {
    snapshot.push([key, entity, cloneEntityFields(entity)]);
  }
  return snapshot;
}

/**
 * Restores a repository map to its pre-transaction state:
 * - Entries created during the transaction are removed.
 * - Mutated entity objects are reverted IN PLACE (prototype and object identity
 *   are preserved, so external holders of the same instance also see the
 *   rolled-back state).
 * - Entries deleted or replaced during the transaction are re-inserted with
 *   their original entity reference and pre-transaction field values.
 * - Properties added to an entity during the transaction are removed.
 */
function restoreMapItems<T extends object>(
  items: Map<string, T>,
  snapshot: MemoryRepoSnapshot<T>,
): void {
  const snapshotKeys = new Set<string>();
  for (const [key] of snapshot) snapshotKeys.add(key);

  for (const key of Array.from(items.keys())) {
    if (!snapshotKeys.has(key)) items.delete(key);
  }

  for (const [key, original, fields] of snapshot) {
    for (const prop of Object.keys(original)) {
      if (!(prop in fields)) delete (original as Record<string, unknown>)[prop];
    }
    Object.assign(original, fields);
    items.set(key, original);
  }
}

export class MemoryProjectRepository implements IProjectRepository {
  private readonly items = new Map<string, Project>();

  snapshotState(): MemoryRepoSnapshot<Project> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<Project>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: ProjectId): Promise<Project | null> {
    return this.items.get(id) ?? null;
  }

  async findByPath(path: string): Promise<Project | null> {
    return Array.from(this.items.values()).find((p) => p.canonicalPath === path) ?? null;
  }

  async findAll(): Promise<Project[]> {
    return Array.from(this.items.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  async save(project: Project): Promise<void> {
    this.items.set(project.id, project);
  }

  async delete(id: ProjectId): Promise<void> {
    this.items.delete(id);
  }
}

export class MemoryRuntimeSessionRepository implements IRuntimeSessionRepository {
  private readonly items = new Map<string, RuntimeSession>();

  snapshotState(): MemoryRepoSnapshot<RuntimeSession> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<RuntimeSession>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: RuntimeSessionId): Promise<RuntimeSession | null> {
    return this.items.get(id) ?? null;
  }

  async findByBundleId(bundleId: string): Promise<RuntimeSession[]> {
    return Array.from(this.items.values()).filter((r) => r.bundleIdentifier === bundleId);
  }

  async findAll(): Promise<RuntimeSession[]> {
    return Array.from(this.items.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  async findActive(): Promise<RuntimeSession[]> {
    return Array.from(this.items.values()).filter((r) =>
      ['available', 'working', 'idle'].includes(r.status),
    );
  }

  async save(session: RuntimeSession): Promise<void> {
    this.items.set(session.id, session);
  }

  async findByExternalSessionId(providerType: string, externalSessionId: string): Promise<RuntimeSession | null> {
    return Array.from(this.items.values()).find(
      (r) => r.providerType === providerType && r.externalSessionId === externalSessionId,
    ) ?? null;
  }

  async delete(id: RuntimeSessionId): Promise<void> {
    this.items.delete(id);
  }
}

export class MemoryPairRepository implements IPairRepository {
  private readonly items = new Map<string, Pair>();

  snapshotState(): MemoryRepoSnapshot<Pair> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<Pair>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: PairId): Promise<Pair | null> {
    return this.items.get(id) ?? null;
  }

  async findByProjectId(projectId: ProjectId): Promise<Pair[]> {
    return Array.from(this.items.values()).filter((p) => p.projectId === projectId);
  }

  async findAll(): Promise<Pair[]> {
    return Array.from(this.items.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  async save(pair: Pair): Promise<void> {
    this.items.set(pair.id, pair);
  }

  async delete(id: PairId): Promise<void> {
    this.items.delete(id);
  }
}

export class MemoryAssignmentRepository implements IAssignmentRepository {
  private readonly items = new Map<string, Assignment>();

  snapshotState(): MemoryRepoSnapshot<Assignment> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<Assignment>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: AssignmentId): Promise<Assignment | null> {
    return this.items.get(id) ?? null;
  }

  async findByPairId(pairId: PairId): Promise<Assignment[]> {
    return Array.from(this.items.values())
      .filter((a) => a.pairId === pairId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async findAll(): Promise<Assignment[]> {
    return Array.from(this.items.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  async findActive(): Promise<Assignment[]> {
    return Array.from(this.items.values()).filter((a) =>
      ['pending', 'active', 'waiting_for_handoff'].includes(a.status),
    );
  }

  async save(assignment: Assignment): Promise<void> {
    this.items.set(assignment.id, assignment);
  }

  async delete(id: AssignmentId): Promise<void> {
    this.items.delete(id);
  }
}

export class MemoryAttemptRepository implements IAttemptRepository {
  private readonly items = new Map<string, Attempt>();

  snapshotState(): MemoryRepoSnapshot<Attempt> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<Attempt>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: AttemptId): Promise<Attempt | null> {
    return this.items.get(id) ?? null;
  }

  async findByAssignmentId(assignmentId: AssignmentId): Promise<Attempt[]> {
    return Array.from(this.items.values())
      .filter((a) => a.assignmentId === assignmentId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async save(attempt: Attempt): Promise<void> {
    this.items.set(attempt.id, attempt);
  }
}

export class MemoryDeliveryRepository implements IDeliveryRepository {
  private readonly items = new Map<string, Delivery>();

  snapshotState(): MemoryRepoSnapshot<Delivery> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<Delivery>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: DeliveryId): Promise<Delivery | null> {
    return this.items.get(id) ?? null;
  }

  async findByAssignmentId(assignmentId: AssignmentId): Promise<Delivery[]> {
    return Array.from(this.items.values())
      .filter((d) => d.assignmentId === assignmentId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async findAmbiguous(): Promise<Delivery[]> {
    return Array.from(this.items.values()).filter((d) => d.status === 'ambiguous');
  }

  async findUnresolved(): Promise<Delivery[]> {
    return Array.from(this.items.values())
      .filter((d) => d.status === 'pending' || d.status === 'delivering')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async save(delivery: Delivery): Promise<void> {
    this.items.set(delivery.id, delivery);
  }
}

export class MemoryHandoffRepository implements IHandoffRepository {
  private readonly items = new Map<string, Handoff>();

  snapshotState(): MemoryRepoSnapshot<Handoff> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<Handoff>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: HandoffId): Promise<Handoff | null> {
    return this.items.get(id) ?? null;
  }

  async findByAssignmentId(assignmentId: AssignmentId): Promise<Handoff[]> {
    return Array.from(this.items.values())
      .filter((h) => h.assignmentId === assignmentId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async findPending(): Promise<Handoff[]> {
    return Array.from(this.items.values()).filter((h) => h.status === 'pending');
  }

  async save(handoff: Handoff): Promise<void> {
    this.items.set(handoff.id, handoff);
  }
}

export class MemoryEventRepository implements IEventRepository {
  private readonly items = new Map<string, RelayEvent>();

  snapshotState(): MemoryRepoSnapshot<RelayEvent> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<RelayEvent>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: EventId): Promise<RelayEvent | null> {
    return this.items.get(id) ?? null;
  }

  async findByResourceId(resourceId: string): Promise<RelayEvent[]> {
    return Array.from(this.items.values())
      .filter((e) => e.resourceId === resourceId)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async findRecent(limit = 50): Promise<RelayEvent[]> {
    return Array.from(this.items.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async save(event: RelayEvent): Promise<void> {
    this.items.set(event.id, event);
  }
}

export class MemoryAttentionRepository implements IAttentionRepository {
  private readonly items = new Map<string, AttentionItem>();

  snapshotState(): MemoryRepoSnapshot<AttentionItem> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<AttentionItem>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: AttentionItemId): Promise<AttentionItem | null> {
    return this.items.get(id) ?? null;
  }

  async findOpen(): Promise<AttentionItem[]> {
    return Array.from(this.items.values())
      .filter((a) => a.status === 'open')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async findAll(): Promise<AttentionItem[]> {
    return Array.from(this.items.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  async save(item: AttentionItem): Promise<void> {
    this.items.set(item.id, item);
  }

  async acknowledge(id: AttentionItemId): Promise<void> {
    const item = await this.findById(id);
    if (item) {
      item.acknowledge();
      await this.save(item);
    }
  }
}

const AUTHORITATIVE_ASSOCIATION_PROVENANCES = new Set<RuntimeProjectAssociation['provenance']>([
  'discovery',
  'adoption',
  'setup',
]);

function associationSchemaGap(detail: string): Error {
  return new Error(
    `Association schema gap: runtime_project_associations cannot verify ${detail}`,
  );
}

export class MemoryAssociationRepository implements IAssociationRepository {
  private readonly items = new Map<string, RuntimeProjectAssociation>();

  snapshotState(): MemoryRepoSnapshot<RuntimeProjectAssociation> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<RuntimeProjectAssociation>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: AssociationId): Promise<RuntimeProjectAssociation | null> {
    return this.items.get(id) ?? null;
  }

  async findBySessionId(
    sessionId: RuntimeSessionId,
  ): Promise<RuntimeProjectAssociation[]> {
    return Array.from(this.items.values())
      .filter((association) => association.runtimeSessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  async findByProjectId(
    projectId: ProjectId,
  ): Promise<RuntimeProjectAssociation[]> {
    return Array.from(this.items.values())
      .filter((association) => association.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  async findVerifiedBySessionId(
    sessionId: RuntimeSessionId,
    criteria: AssociationEvidenceCriteria,
  ): Promise<RuntimeProjectAssociation | null> {
    if (!criteria?.providerType || !criteria.projectId) {
      throw associationSchemaGap(
        'provider_type, external_session_id, and project_id criteria are required for pre-pair evidence',
      );
    }
    const normalizedExternalSessionId = criteria.externalSessionId ?? null;
    const match = (await this.findBySessionId(sessionId)).find(
      (association) =>
        association.verificationState === 'verified' &&
        AUTHORITATIVE_ASSOCIATION_PROVENANCES.has(association.provenance) &&
        association.providerType === criteria.providerType &&
        association.externalSessionId === normalizedExternalSessionId &&
        association.projectId === criteria.projectId,
    );
    if (match) return match;

    const legacyVerified = (await this.findBySessionId(sessionId)).find(
      (association) =>
        association.verificationState === 'verified' &&
        AUTHORITATIVE_ASSOCIATION_PROVENANCES.has(association.provenance) &&
        (!association.providerType || !association.externalSessionId),
    );
    if (legacyVerified) {
      const missingFields: string[] = [];
      if (!legacyVerified.providerType) missingFields.push('provider_type');
      if (!legacyVerified.externalSessionId) {
        missingFields.push('external_session_id');
      }
      throw associationSchemaGap(
        `${missingFields.join(' and ')} for verified association '${legacyVerified.id}'`,
      );
    }

    return null;
  }

  async findAll(): Promise<RuntimeProjectAssociation[]> {
    return Array.from(this.items.values()).sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    );
  }

  async save(association: RuntimeProjectAssociation): Promise<void> {
    const duplicate = Array.from(this.items.values()).find(
      (existing) =>
        existing.id !== association.id &&
        existing.runtimeSessionId === association.runtimeSessionId &&
        existing.projectId === association.projectId,
    );
    if (duplicate) {
      throw new Error(
        `Association uniqueness violation for runtime='${association.runtimeSessionId}', projectId='${association.projectId}'`,
      );
    }
    this.items.set(association.id, association);
  }

  async delete(id: AssociationId): Promise<void> {
    this.items.delete(id);
  }
}

/* --- Plan-First execution domain (PLAN_FIRST_DOMAIN_FREEZE.md §F) --- */

function planFirstConstraintError(message: string): Error {
  return new Error(message);
}


export class MemoryContractRevisionRepository implements IContractRevisionRepository {
  private readonly items = new Map<string, ContractRevision>();

  snapshotState(): MemoryRepoSnapshot<ContractRevision> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<ContractRevision>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: ContractRevisionId): Promise<ContractRevision | null> {
    return this.items.get(id) ?? null;
  }

  async findByProjectId(projectId: ProjectId): Promise<ContractRevision[]> {
    return Array.from(this.items.values())
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async findByDigest(
    projectId: ProjectId,
    canonicalDigest: string,
  ): Promise<ContractRevision | null> {
    return (
      (await this.findByProjectId(projectId)).find(
        (r) => r.canonicalDigest === canonicalDigest,
      ) ?? null
    );
  }

  async save(revision: ContractRevision): Promise<void> {
    // Parity with UNIQUE (project_id, canonical_digest).
    const clash = (await this.findByProjectId(revision.projectId)).find(
      (r) => r.canonicalDigest === revision.canonicalDigest && r.id !== revision.id,
    );
    if (clash) {
      throw planFirstConstraintError(
        `Revision ${revision.id} duplicates the semantic digest of ${clash.id} in project ${revision.projectId}`,
      );
    }
    this.items.set(revision.id, revision);
  }
}

export class MemoryPlanFirstRunRepository implements IPlanFirstRunRepository {
  private readonly items = new Map<string, PlanFirstRun>();

  snapshotState(): MemoryRepoSnapshot<PlanFirstRun> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<PlanFirstRun>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: PlanFirstRunId): Promise<PlanFirstRun | null> {
    return this.items.get(id) ?? null;
  }

  async findByContractRevisionId(contractRevisionId: ContractRevisionId): Promise<PlanFirstRun[]> {
    return Array.from(this.items.values())
      .filter((r) => r.contractRevisionId === contractRevisionId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async findActiveByContractRevisionId(
    projectId: ProjectId,
    contractRevisionId: ContractRevisionId,
  ): Promise<PlanFirstRun | null> {
    return (
      (await this.findByContractRevisionId(contractRevisionId)).find(
        (r) => r.projectId === projectId && !r.isTerminal(),
      ) ?? null
    );
  }

  async findByProjectId(projectId: ProjectId): Promise<PlanFirstRun[]> {
    return Array.from(this.items.values())
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async save(run: PlanFirstRun): Promise<void> {
    // Parity with the partial unique index: at most one non-terminal run per
    // (project, contract revision).
    const clash = (await this.findByContractRevisionId(run.contractRevisionId)).find(
      (r) => r.projectId === run.projectId && r.id !== run.id && !r.isTerminal(),
    );
    if (clash && !run.isTerminal()) {
      throw planFirstConstraintError(
        `Run ${run.id} would create a second active run for revision ${run.contractRevisionId} (existing: ${clash.id})`,
      );
    }
    this.items.set(run.id, run);
  }
}

export class MemoryWorkUnitRepository implements IWorkUnitRepository {
  private readonly items = new Map<string, WorkUnit>();

  snapshotState(): MemoryRepoSnapshot<WorkUnit> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<WorkUnit>): void {
    restoreMapItems(this.items, snapshot);
  }

  async findById(id: WorkUnitId): Promise<WorkUnit | null> {
    return this.items.get(id) ?? null;
  }

  async findByContractRevisionId(contractRevisionId: ContractRevisionId): Promise<WorkUnit[]> {
    return Array.from(this.items.values())
      .filter((u) => u.contractRevisionId === contractRevisionId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  async findInProgressByContractRevisionId(
    contractRevisionId: ContractRevisionId,
  ): Promise<WorkUnit | null> {
    return (await this.findByContractRevisionId(contractRevisionId)).find(
      (u) => u.status === 'in_progress',
    ) ?? null;
  }

  async save(unit: WorkUnit): Promise<void> {
    const siblings = await this.findByContractRevisionId(unit.contractRevisionId);
    // Parity with UNIQUE (contract_revision_id, ordinal).
    const ordinalClash = siblings.find(
      (u) => u.ordinal === unit.ordinal && u.id !== unit.id,
    );
    if (ordinalClash) {
      throw planFirstConstraintError(
        `WorkUnit ${unit.id} reuses ordinal ${unit.ordinal} already held by ${ordinalClash.id}`,
      );
    }
    // Parity with the partial unique index on in_progress units.
    const inFlight = siblings.find((u) => u.status === 'in_progress' && u.id !== unit.id);
    if (inFlight && unit.status === 'in_progress') {
      throw planFirstConstraintError(
        `WorkUnit ${unit.id} would run concurrently with ${inFlight.id}; V1 is strictly sequential`,
      );
    }
    this.items.set(unit.id, unit);
  }
}

export class MemoryVerificationResultRepository implements IVerificationResultRepository {
  private readonly items = new Map<string, VerificationResult>();
  private readonly byAttempt = new Map<string, string>();

  snapshotState(): MemoryRepoSnapshot<VerificationResult> {
    return snapshotMapItems(this.items);
  }

  restoreState(snapshot: MemoryRepoSnapshot<VerificationResult>): void {
    restoreMapItems(this.items, snapshot);
    this.byAttempt.clear();
    for (const [id, result] of this.items) this.byAttempt.set(result.attemptId, id);
  }

  async findById(id: VerificationResultId): Promise<VerificationResult | null> {
    return this.items.get(id) ?? null;
  }

  async findByAttemptId(attemptId: AttemptId): Promise<VerificationResult | null> {
    const id = this.byAttempt.get(attemptId);
    return id ? this.items.get(id) ?? null : null;
  }

  async save(result: VerificationResult): Promise<void> {
    // Parity with the unique index on attempt_id: one result per attempt.
    const existingId = this.byAttempt.get(result.attemptId);
    if (existingId && existingId !== result.id) {
      throw planFirstConstraintError(
        `Attempt ${result.attemptId} already has verification result ${existingId}`,
      );
    }
    this.items.set(result.id, result);
    this.byAttempt.set(result.attemptId, result.id);
  }
}

export class MemoryRelayDatabase implements IRelayRepositories {
  public readonly projects: MemoryProjectRepository;
  public readonly pairs: MemoryPairRepository;
  public readonly runtimes: MemoryRuntimeSessionRepository;
  public readonly assignments: MemoryAssignmentRepository;
  public readonly attempts: MemoryAttemptRepository;
  public readonly deliveries: MemoryDeliveryRepository;
  public readonly handoffs: MemoryHandoffRepository;
  public readonly events: MemoryEventRepository;
  public readonly attention: MemoryAttentionRepository;
  public readonly associations: MemoryAssociationRepository;
  public readonly planFirstRuns: MemoryPlanFirstRunRepository;
  public readonly workUnits: MemoryWorkUnitRepository;
  public readonly contractRevisions: MemoryContractRevisionRepository;
  public readonly verificationResults: MemoryVerificationResultRepository;

  constructor() {
    this.projects = new MemoryProjectRepository();
    this.pairs = new MemoryPairRepository();
    this.runtimes = new MemoryRuntimeSessionRepository();
    this.assignments = new MemoryAssignmentRepository();
    this.attempts = new MemoryAttemptRepository();
    this.deliveries = new MemoryDeliveryRepository();
    this.handoffs = new MemoryHandoffRepository();
    this.events = new MemoryEventRepository();
    this.attention = new MemoryAttentionRepository();
    this.associations = new MemoryAssociationRepository();
    this.planFirstRuns = new MemoryPlanFirstRunRepository();
    this.workUnits = new MemoryWorkUnitRepository();
    this.contractRevisions = new MemoryContractRevisionRepository();
    this.verificationResults = new MemoryVerificationResultRepository();
  }

  /**
   * Memory transactions emulate rollback: before running the work, every
   * repository's map contents are snapshotted; if the work throws, all
   * repository state is restored to the snapshot (mutated entity objects are
   * reverted in place, added entries are removed, deleted/replaced entries are
   * re-inserted) and the ORIGINAL error is rethrown. On success no restore is
   * performed — the work is the committed state.
   */
  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    const repos: Array<ISnapshotableMemoryRepo> = [
      this.projects,
      this.pairs,
      this.runtimes,
      this.assignments,
      this.attempts,
      this.deliveries,
      this.handoffs,
      this.events,
      this.attention,
      this.associations,
      this.planFirstRuns,
      this.workUnits,
      this.contractRevisions,
      this.verificationResults,
    ];
    const snapshots = repos.map((repo) => repo.snapshotState());
    try {
      return await work();
    } catch (err) {
      repos.forEach((repo, index) => repo.restoreState(snapshots[index]));
      throw err;
    }
  }
}
