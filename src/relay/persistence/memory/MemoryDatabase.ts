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

export class MemoryProjectRepository implements IProjectRepository {
  private readonly items = new Map<string, Project>();

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

  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}
