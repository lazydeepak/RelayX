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
} from '../domain/entities.ts';

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
  runInTransaction<T>(work: () => Promise<T>): Promise<T>;
}
