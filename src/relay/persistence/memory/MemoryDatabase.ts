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
} from '../../domain/entities.ts';
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
