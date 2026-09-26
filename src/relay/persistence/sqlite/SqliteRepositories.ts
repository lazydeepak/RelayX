import { DatabaseSync } from 'node:sqlite';
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
  ObservableEvidence,
  ProviderType,
  PairStatus,
  ContractRevisionId,
  PlanFirstRunId,
  WorkUnitId,
  VerificationResultId,
  ContractRevisionStatus,
  PlanFirstRunStatus,
  WorkUnitStatus,
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
  ContractRevision,
  WorkUnit,
  PlanFirstRun,
} from '../../domain/entities.ts';
import type { VerificationResult } from '../../domain/repoBoundary.ts';
import {
  IProjectRepository,
  IPairRepository,
  IRuntimeSessionRepository,
  IAssignmentRepository,
  IAttemptRepository,
  IDeliveryRepository,
  IHandoffRepository,
  IEventRepository,
  IAttentionRepository,
  IContractRevisionRepository,
  IPlanFirstRunRepository,
  IWorkUnitRepository,
  IVerificationResultRepository,
} from '../interfaces.ts';

/* Helper functions for JSON safety */
const safeJsonParse = <T>(str: unknown): T | undefined => {
  if (typeof str !== 'string' || !str) return undefined;
  try {
    return JSON.parse(str) as T;
  } catch {
    return undefined;
  }
};

const safeJsonStringify = (val: unknown): string | null => {
  if (val === undefined || val === null) return null;
  try {
    return JSON.stringify(val);
  } catch {
    return null;
  }
};

/* --- Project Repository --- */
export class SqliteProjectRepository implements IProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  async findById(id: ProjectId): Promise<Project | null> {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return new Project({
      id: row.id as ProjectId,
      name: row.name as string,
      description: (row.description as string) || '',
      canonicalPath: row.canonical_path ? (row.canonical_path as string) : undefined,
      gitRoot: row.git_root ? (row.git_root as string) : undefined,
      plannerProjectUrl: row.planner_project_url ? (row.planner_project_url as string) : undefined,
      workerWorkspacePath: row.worker_workspace_path ? (row.worker_workspace_path as string) : undefined,
      status: (row.status as any) || 'active',
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    });
  }

  async findByPath(path: string): Promise<Project | null> {
    const row = this.db.prepare('SELECT * FROM projects WHERE canonical_path = ?').get(path) as Record<string, unknown> | undefined;
    if (!row) return null;
    return new Project({
      id: row.id as ProjectId,
      name: row.name as string,
      description: (row.description as string) || '',
      canonicalPath: row.canonical_path ? (row.canonical_path as string) : undefined,
      gitRoot: row.git_root ? (row.git_root as string) : undefined,
      plannerProjectUrl: row.planner_project_url ? (row.planner_project_url as string) : undefined,
      workerWorkspacePath: row.worker_workspace_path ? (row.worker_workspace_path as string) : undefined,
      status: (row.status as any) || 'active',
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    });
  }

  async findAll(): Promise<Project[]> {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map(
      (row) =>
        new Project({
          id: row.id as ProjectId,
          name: row.name as string,
          description: (row.description as string) || '',
          canonicalPath: row.canonical_path ? (row.canonical_path as string) : undefined,
          gitRoot: row.git_root ? (row.git_root as string) : undefined,
          plannerProjectUrl: row.planner_project_url ? (row.planner_project_url as string) : undefined,
          workerWorkspacePath: row.worker_workspace_path ? (row.worker_workspace_path as string) : undefined,
          status: (row.status as any) || 'active',
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        }),
    );
  }

  async save(project: Project): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO projects (id, name, description, canonical_path, git_root, planner_project_url, worker_workspace_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        canonical_path = excluded.canonical_path,
        git_root = excluded.git_root,
        planner_project_url = excluded.planner_project_url,
        worker_workspace_path = excluded.worker_workspace_path,
        status = excluded.status,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      project.id,
      project.name,
      project.description ?? '',
      project.canonicalPath || null,
      project.gitRoot || null,
      project.plannerProjectUrl || null,
      project.workerWorkspacePath || null,
      project.status || 'active',
      project.createdAt,
      project.updatedAt ?? project.createdAt,
    );
  }

  async delete(id: ProjectId): Promise<void> {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}

/* --- RuntimeSession Repository --- */
export class SqliteRuntimeSessionRepository implements IRuntimeSessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): RuntimeSession {
    return new RuntimeSession({
      id: row.id as RuntimeSessionId,
      providerType: row.provider_type as ProviderType,
      name: row.name as string,
      bundleIdentifier: row.bundle_identifier as string | undefined,
      windowTitle: row.window_title as string | undefined,
      applicationPid: row.application_pid ? Number(row.application_pid) : undefined,
      status: row.status as any,
      consecutiveObservationFailures: Number(row.consecutive_observation_failures || 0),
      lastHeartbeatAt: row.last_heartbeat_at ? Number(row.last_heartbeat_at) : undefined,
      lastObservedAt: row.last_observed_at ? Number(row.last_observed_at) : undefined,
      lastEvidence: safeJsonParse<ObservableEvidence>(row.last_evidence_json),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      archivedAt: row.archived_at ? Number(row.archived_at) : undefined,
      archiveReason: row.archive_reason as string | undefined,
      externalSessionId: (row.external_session_id as string | null | undefined) ?? null,
      externalProjectRef: (row.external_project_ref as string | null | undefined) ?? null,
    });
  }

  async findById(id: RuntimeSessionId): Promise<RuntimeSession | null> {
    const row = this.db.prepare('SELECT * FROM runtime_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByExternalSessionId(providerType: string, externalSessionId: string): Promise<RuntimeSession | null> {
    const row = this.db.prepare('SELECT * FROM runtime_sessions WHERE provider_type = ? AND external_session_id = ?').get(providerType, externalSessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByBundleId(bundleId: string): Promise<RuntimeSession[]> {
    const rows = this.db.prepare('SELECT * FROM runtime_sessions WHERE bundle_identifier = ?').all(bundleId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findAll(): Promise<RuntimeSession[]> {
    const rows = this.db.prepare('SELECT * FROM runtime_sessions ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findActive(): Promise<RuntimeSession[]> {
    const rows = this.db.prepare("SELECT * FROM runtime_sessions WHERE status IN ('available', 'working', 'idle')").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async save(session: RuntimeSession): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO runtime_sessions (
        id, provider_type, name, bundle_identifier, window_title, application_pid,
        status, consecutive_observation_failures, last_heartbeat_at, last_observed_at,
        last_evidence_json, archived_at, archive_reason, external_session_id, external_project_ref, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider_type = excluded.provider_type,
        name = excluded.name,
        bundle_identifier = excluded.bundle_identifier,
        window_title = excluded.window_title,
        application_pid = excluded.application_pid,
        status = excluded.status,
        consecutive_observation_failures = excluded.consecutive_observation_failures,
        last_heartbeat_at = excluded.last_heartbeat_at,
        last_observed_at = excluded.last_observed_at,
        last_evidence_json = excluded.last_evidence_json,
        archived_at = excluded.archived_at,
        archive_reason = excluded.archive_reason,
        external_session_id = excluded.external_session_id,
        external_project_ref = excluded.external_project_ref,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      session.id,
      session.providerType,
      session.name,
      session.bundleIdentifier ?? null,
      session.windowTitle ?? null,
      session.applicationPid ?? null,
      session.status,
      session.consecutiveObservationFailures,
      session.lastHeartbeatAt ?? null,
      session.lastObservedAt ?? null,
      safeJsonStringify(session.lastEvidence),
      session.archivedAt ?? null,
      session.archiveReason ?? null,
      session.externalSessionId ?? null,
      session.externalProjectRef ?? null,
      session.createdAt,
      session.updatedAt,
    );
  }

  async delete(id: RuntimeSessionId): Promise<void> {
    this.db.prepare('DELETE FROM runtime_sessions WHERE id = ?').run(id);
  }
}

/* --- Pair Repository --- */
export class SqlitePairRepository implements IPairRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): Pair {
    return new Pair({
      id: row.id as PairId,
      projectId: row.project_id as ProjectId,
      name: row.name as string,
      plannerSessionId: (row.planner_session_id as RuntimeSessionId) || undefined,
      workerSessionId: (row.worker_session_id as RuntimeSessionId) || undefined,
      activeAssignmentId: (row.active_assignment_id as AssignmentId) || undefined,
      status: row.status as PairStatus,
      lastSupervisedAt: row.last_supervised_at ? Number(row.last_supervised_at) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    });
  }

  async findById(id: PairId): Promise<Pair | null> {
    const row = this.db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByProjectId(projectId: ProjectId): Promise<Pair[]> {
    const rows = this.db.prepare('SELECT * FROM pairs WHERE project_id = ?').all(projectId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findAll(): Promise<Pair[]> {
    const rows = this.db.prepare('SELECT * FROM pairs ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async save(pair: Pair): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO pairs (
        id, project_id, name, planner_session_id, worker_session_id,
        active_assignment_id, status, last_supervised_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        planner_session_id = excluded.planner_session_id,
        worker_session_id = excluded.worker_session_id,
        active_assignment_id = excluded.active_assignment_id,
        status = excluded.status,
        last_supervised_at = excluded.last_supervised_at,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      pair.id,
      pair.projectId,
      pair.name,
      pair.plannerSessionId ?? null,
      pair.workerSessionId ?? null,
      pair.activeAssignmentId ?? null,
      pair.status,
      pair.lastSupervisedAt ?? null,
      pair.createdAt,
      pair.updatedAt,
    );
  }

  async delete(id: PairId): Promise<void> {
    this.db.prepare('DELETE FROM pairs WHERE id = ?').run(id);
  }
}

/* --- Assignment Repository --- */
export class SqliteAssignmentRepository implements IAssignmentRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): Assignment {
    return new Assignment({
      id: row.id as AssignmentId,
      pairId: row.pair_id as PairId,
      projectId: row.project_id as ProjectId,
      title: row.title as string,
      instruction: row.instruction as string,
      status: row.status as any,
      currentAttemptId: (row.current_attempt_id as AttemptId) || undefined,
      activeDeliveryId: (row.active_delivery_id as DeliveryId) || undefined,
      activeHandoffId: (row.active_handoff_id as HandoffId) || undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
    });
  }

  async findById(id: AssignmentId): Promise<Assignment | null> {
    const row = this.db.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByPairId(pairId: PairId): Promise<Assignment[]> {
    const rows = this.db.prepare('SELECT * FROM assignments WHERE pair_id = ? ORDER BY created_at DESC').all(pairId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findAll(): Promise<Assignment[]> {
    const rows = this.db.prepare('SELECT * FROM assignments ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findActive(): Promise<Assignment[]> {
    const rows = this.db.prepare("SELECT * FROM assignments WHERE status IN ('pending', 'active', 'waiting_for_handoff')").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async save(assignment: Assignment): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO assignments (
        id, pair_id, project_id, title, instruction, status,
        current_attempt_id, active_delivery_id, active_handoff_id,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        instruction = excluded.instruction,
        status = excluded.status,
        current_attempt_id = excluded.current_attempt_id,
        active_delivery_id = excluded.active_delivery_id,
        active_handoff_id = excluded.active_handoff_id,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `);
    stmt.run(
      assignment.id,
      assignment.pairId,
      assignment.projectId,
      assignment.title,
      assignment.instruction,
      assignment.status,
      assignment.currentAttemptId ?? null,
      assignment.activeDeliveryId ?? null,
      assignment.activeHandoffId ?? null,
      assignment.createdAt,
      assignment.updatedAt,
      assignment.completedAt ?? null,
    );
  }

  async delete(id: AssignmentId): Promise<void> {
    this.db.prepare('DELETE FROM assignments WHERE id = ?').run(id);
  }
}

/* --- Attempt Repository --- */
export class SqliteAttemptRepository implements IAttemptRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): Attempt {
    return new Attempt({
      id: row.id as AttemptId,
      assignmentId: row.assignment_id as AssignmentId,
      attemptNumber: Number(row.attempt_number),
      status: row.status as any,
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
      failureReason: row.failure_reason as string | undefined,
      evidence: safeJsonParse<ObservableEvidence>(row.evidence_json),
      sessionPairId: row.session_pair_id as PairId | undefined,
      workerSessionId: row.worker_session_id as RuntimeSessionId | undefined,
      externalSessionId: (row.external_session_id as string | null) ?? null,
    });
  }

  async findById(id: AttemptId): Promise<Attempt | null> {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByAssignmentId(assignmentId: AssignmentId): Promise<Attempt[]> {
    const rows = this.db.prepare('SELECT * FROM attempts WHERE assignment_id = ? ORDER BY attempt_number ASC').all(assignmentId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async save(attempt: Attempt): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO attempts (
        id, assignment_id, attempt_number, status,
        session_pair_id, worker_session_id, external_session_id,
        started_at, finished_at, failure_reason, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        session_pair_id = excluded.session_pair_id,
        worker_session_id = excluded.worker_session_id,
        external_session_id = excluded.external_session_id,
        finished_at = excluded.finished_at,
        failure_reason = excluded.failure_reason,
        evidence_json = excluded.evidence_json
    `);
    stmt.run(
      attempt.id,
      attempt.assignmentId,
      attempt.attemptNumber,
      attempt.status,
      attempt.sessionPairId ?? null,
      attempt.workerSessionId ?? null,
      attempt.externalSessionId ?? null,
      attempt.startedAt,
      attempt.finishedAt ?? null,
      attempt.failureReason ?? null,
      safeJsonStringify(attempt.evidence),
    );
  }
}

/* --- Delivery Repository --- */
export class SqliteDeliveryRepository implements IDeliveryRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): Delivery {
    return new Delivery({
      id: row.id as DeliveryId,
      assignmentId: row.assignment_id as AssignmentId,
      attemptId: row.attempt_id as AttemptId,
      targetRuntimeId: row.target_runtime_id as RuntimeSessionId,
      status: row.status as any,
      idempotencyKey: row.idempotency_key as string,
      instructionSnippet: row.instruction_snippet as string,
      evidence: safeJsonParse<ObservableEvidence>(row.evidence_json),
      deliveredAt: row.delivered_at ? Number(row.delivered_at) : undefined,
      failureReason: row.failure_reason as string | undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    });
  }

  async findById(id: DeliveryId): Promise<Delivery | null> {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByAssignmentId(assignmentId: AssignmentId): Promise<Delivery[]> {
    const rows = this.db.prepare('SELECT * FROM deliveries WHERE assignment_id = ? ORDER BY created_at DESC').all(assignmentId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findAmbiguous(): Promise<Delivery[]> {
    const rows = this.db.prepare("SELECT * FROM deliveries WHERE status = 'ambiguous'").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async save(delivery: Delivery): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO deliveries (
        id, assignment_id, attempt_id, target_runtime_id, status,
        idempotency_key, instruction_snippet, evidence_json,
        delivered_at, failure_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        evidence_json = excluded.evidence_json,
        delivered_at = excluded.delivered_at,
        failure_reason = excluded.failure_reason,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      delivery.id,
      delivery.assignmentId,
      delivery.attemptId,
      delivery.targetRuntimeId,
      delivery.status,
      delivery.idempotencyKey,
      delivery.instructionSnippet,
      safeJsonStringify(delivery.evidence),
      delivery.deliveredAt ?? null,
      delivery.failureReason ?? null,
      delivery.createdAt,
      delivery.updatedAt,
    );
  }
}

/* --- Handoff Repository --- */
export class SqliteHandoffRepository implements IHandoffRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): Handoff {
    return new Handoff({
      id: row.id as HandoffId,
      assignmentId: row.assignment_id as AssignmentId,
      attemptId: row.attempt_id as AttemptId,
      status: row.status as any,
      resultSummary: row.result_summary as string | undefined,
      payload: safeJsonParse<Record<string, unknown>>(row.payload_json),
      evidence: safeJsonParse<ObservableEvidence>(row.evidence_json),
      deliveredToPlannerAt: row.delivered_to_planner_at ? Number(row.delivered_to_planner_at) : undefined,
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    });
  }

  async findById(id: HandoffId): Promise<Handoff | null> {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByAssignmentId(assignmentId: AssignmentId): Promise<Handoff[]> {
    const rows = this.db.prepare('SELECT * FROM handoffs WHERE assignment_id = ? ORDER BY created_at DESC').all(assignmentId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findPending(): Promise<Handoff[]> {
    const rows = this.db.prepare("SELECT * FROM handoffs WHERE status IN ('pending', 'ready')").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async save(handoff: Handoff): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO handoffs (
        id, assignment_id, attempt_id, status, result_summary,
        payload_json, evidence_json, delivered_to_planner_at, completed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        result_summary = excluded.result_summary,
        payload_json = excluded.payload_json,
        evidence_json = excluded.evidence_json,
        delivered_to_planner_at = excluded.delivered_to_planner_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      handoff.id,
      handoff.assignmentId,
      handoff.attemptId,
      handoff.status,
      handoff.resultSummary ?? null,
      safeJsonStringify(handoff.payload),
      safeJsonStringify(handoff.evidence),
      handoff.deliveredToPlannerAt ?? null,
      handoff.completedAt ?? null,
      handoff.createdAt,
      handoff.updatedAt,
    );
  }
}

/* --- Event Repository --- */
export class SqliteEventRepository implements IEventRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): RelayEvent {
    return new RelayEvent({
      id: row.id as EventId,
      timestamp: Number(row.timestamp),
      resourceType: row.resource_type as any,
      resourceId: row.resource_id as string,
      eventType: row.event_type as string,
      actor: row.actor as any,
      previousState: (row.previous_state as string) || undefined,
      newState: (row.new_state as string) || undefined,
      evidence: safeJsonParse<ObservableEvidence>(row.evidence_json),
      correlationId: (row.correlation_id as string) || undefined,
      details: safeJsonParse<Record<string, unknown>>(row.details_json),
    });
  }

  async findById(id: EventId): Promise<RelayEvent | null> {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByResourceId(resourceId: string): Promise<RelayEvent[]> {
    const rows = this.db.prepare('SELECT * FROM events WHERE resource_id = ? ORDER BY timestamp DESC').all(resourceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findRecent(limit = 100): Promise<RelayEvent[]> {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async save(event: RelayEvent): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO events (
        id, timestamp, resource_type, resource_id, event_type,
        actor, previous_state, new_state, evidence_json,
        correlation_id, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.id,
      event.timestamp,
      event.resourceType,
      event.resourceId,
      event.eventType,
      event.actor,
      event.previousState ?? null,
      event.newState ?? null,
      safeJsonStringify(event.evidence),
      event.correlationId ?? null,
      safeJsonStringify(event.details),
    );
  }
}

/* --- Attention Repository --- */
export class SqliteAttentionRepository implements IAttentionRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): AttentionItem {
    return new AttentionItem({
      id: row.id as AttentionItemId,
      pairId: (row.pair_id as PairId) || undefined,
      assignmentId: (row.assignment_id as AssignmentId) || undefined,
      severity: row.severity as any,
      status: row.status as any,
      type: row.type as string,
      title: row.title as string,
      message: row.message as string,
      suggestedAction: (row.suggested_action as string) || undefined,
      suggestedTier: (row.suggested_tier as any) || undefined,
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
    });
  }

  async findById(id: AttentionItemId): Promise<AttentionItem | null> {
    const row = this.db.prepare('SELECT * FROM attention_items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  async findOpen(): Promise<AttentionItem[]> {
    const rows = this.db.prepare("SELECT * FROM attention_items WHERE status IN ('open', 'acknowledged') ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findAll(): Promise<AttentionItem[]> {
    const rows = this.db.prepare('SELECT * FROM attention_items ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async save(item: AttentionItem): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO attention_items (
        id, pair_id, assignment_id, severity, status, type,
        title, message, suggested_action, suggested_tier, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        severity = excluded.severity,
        status = excluded.status,
        suggested_action = excluded.suggested_action,
        suggested_tier = excluded.suggested_tier,
        resolved_at = excluded.resolved_at
    `);
    stmt.run(
      item.id,
      item.pairId ?? null,
      item.assignmentId ?? null,
      item.severity,
      item.status,
      item.type,
      item.title,
      item.message,
      item.suggestedAction ?? null,
      item.suggestedTier ?? null,
      item.createdAt,
      item.resolvedAt ?? null,
    );
  }

  async acknowledge(id: AttentionItemId): Promise<void> {
    const item = await this.findById(id);
    if (item) {
      item.acknowledge();
      await this.save(item);
    }
  }
}
/* --- Plan-First execution domain repositories (PLAN_FIRST_DOMAIN_FREEZE.md §F) --- */

/**
 * Replaces the former `SqlitePlanFirstRunRepository implements any`, which could not
 * compile (TS2864) and returned raw snake_case rows instead of a domain entity.
 */
export class SqliteContractRevisionRepository implements IContractRevisionRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): ContractRevision {
    return new ContractRevision({
      id: row.id as ContractRevisionId,
      projectId: row.project_id as ProjectId,
      canonicalText: row.canonical_text as string,
      canonicalDigest: row.canonical_digest as string,
      status: row.status as ContractRevisionStatus,
      sourceRef: (row.source_ref as string | null) ?? null,
      approvedBy: (row.approved_by as string | null) ?? null,
      approvedAt: row.approved_at != null ? Number(row.approved_at) : null,
      createdAt: Number(row.created_at),
    });
  }

  async findById(id: ContractRevisionId): Promise<ContractRevision | null> {
    const row = this.db
      .prepare('SELECT * FROM contract_revisions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findByProjectId(projectId: ProjectId): Promise<ContractRevision[]> {
    const rows = this.db
      .prepare('SELECT * FROM contract_revisions WHERE project_id = ? ORDER BY created_at ASC, id ASC')
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findByDigest(
    projectId: ProjectId,
    canonicalDigest: string,
  ): Promise<ContractRevision | null> {
    const row = this.db
      .prepare('SELECT * FROM contract_revisions WHERE project_id = ? AND canonical_digest = ?')
      .get(projectId, canonicalDigest) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async save(revision: ContractRevision): Promise<void> {
    // The UNIQUE (project_id, canonical_digest) constraint is the authority for
    // "the same semantic intent must not exist as two revisions".
    this.db
      .prepare(
        `INSERT INTO contract_revisions (
           id, project_id, canonical_text, canonical_digest, status,
           source_ref, approved_by, approved_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           approved_by = excluded.approved_by,
           approved_at = excluded.approved_at`,
      )
      .run(
        revision.id,
        revision.projectId,
        revision.canonicalText,
        revision.canonicalDigest,
        revision.status,
        revision.sourceRef ?? null,
        revision.approvedBy ?? null,
        revision.approvedAt ?? null,
        revision.createdAt,
      );
  }
}

export class SqlitePlanFirstRunRepository implements IPlanFirstRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): PlanFirstRun {
    return new PlanFirstRun({
      id: row.id as PlanFirstRunId,
      projectId: row.project_id as ProjectId,
      contractRevisionId: row.contract_revision_id as ContractRevisionId,
      contractDigest: row.contract_digest as string,
      sessionPairId: row.session_pair_id as PairId,
      status: row.status as PlanFirstRunStatus,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    });
  }

  async findById(id: PlanFirstRunId): Promise<PlanFirstRun | null> {
    const row = this.db
      .prepare('SELECT * FROM plan_first_runs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findByContractRevisionId(contractRevisionId: ContractRevisionId): Promise<PlanFirstRun[]> {
    const rows = this.db
      .prepare('SELECT * FROM plan_first_runs WHERE contract_revision_id = ? ORDER BY created_at ASC, id ASC')
      .all(contractRevisionId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findActiveByContractRevisionId(
    projectId: ProjectId,
    contractRevisionId: ContractRevisionId,
  ): Promise<PlanFirstRun | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM plan_first_runs
         WHERE project_id = ? AND contract_revision_id = ?
           AND status NOT IN ('completed','cancelled')
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get(projectId, contractRevisionId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findByProjectId(projectId: ProjectId): Promise<PlanFirstRun[]> {
    const rows = this.db
      .prepare('SELECT * FROM plan_first_runs WHERE project_id = ? ORDER BY created_at ASC, id ASC')
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async save(run: PlanFirstRun): Promise<void> {
    // Only `status` and `updated_at` are mutable. project_id, contract_revision_id,
    // contract_digest and session_pair_id are immutable in the domain AND deliberately
    // absent from the update set, so a bug cannot silently re-point a run.
    this.db
      .prepare(
        `INSERT INTO plan_first_runs (
           id, project_id, contract_revision_id, contract_digest, session_pair_id,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        run.id,
        run.projectId,
        run.contractRevisionId,
        run.contractDigest,
        run.sessionPairId,
        run.status,
        run.createdAt,
        run.updatedAt,
      );
  }
}

export class SqliteWorkUnitRepository implements IWorkUnitRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): WorkUnit {
    return new WorkUnit({
      id: row.id as WorkUnitId,
      contractRevisionId: row.contract_revision_id as ContractRevisionId,
      ordinal: Number(row.ordinal),
      objective: row.objective as string,
      instruction: row.instruction as string,
      status: row.status as WorkUnitStatus,
      assignmentId: (row.assignment_id as AssignmentId | null) ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    });
  }

  async findById(id: WorkUnitId): Promise<WorkUnit | null> {
    const row = this.db
      .prepare('SELECT * FROM work_units WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findByContractRevisionId(contractRevisionId: ContractRevisionId): Promise<WorkUnit[]> {
    // `ordinal` is the only ordering primitive in V1 — never created_at (freeze §D.2).
    const rows = this.db
      .prepare('SELECT * FROM work_units WHERE contract_revision_id = ? ORDER BY ordinal ASC')
      .all(contractRevisionId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async findInProgressByContractRevisionId(
    contractRevisionId: ContractRevisionId,
  ): Promise<WorkUnit | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM work_units WHERE contract_revision_id = ? AND status = 'in_progress'
         ORDER BY ordinal ASC LIMIT 1`,
      )
      .get(contractRevisionId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async save(unit: WorkUnit): Promise<void> {
    // Immutable: id, contract_revision_id, ordinal, objective, instruction, created_at.
    // Mutable: status, assignment_id (written once), updated_at.
    this.db
      .prepare(
        `INSERT INTO work_units (
           id, contract_revision_id, ordinal, objective, instruction,
           status, assignment_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           assignment_id = excluded.assignment_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        unit.id,
        unit.contractRevisionId,
        unit.ordinal,
        unit.objective,
        unit.instruction,
        unit.status,
        unit.assignmentId ?? null,
        unit.createdAt,
        unit.updatedAt,
      );
  }
}

/**
 * Verification results are a separate linked record (ATTEMPT_LIFECYCLE.md Dimension B);
 * they never mutate Attempt physical state. One row per attempt, enforced by a unique
 * index, so the controller's verification-resume guard can rely on findByAttemptId.
 */
export class SqliteVerificationResultRepository implements IVerificationResultRepository {
  constructor(private readonly db: DatabaseSync) {}

  private mapRow(row: Record<string, unknown>): VerificationResult {
    return {
      id: row.id as string,
      attemptId: row.attempt_id as string,
      checkId: (row.check_id as string | null) ?? undefined,
      result: row.result as VerificationResult['result'],
      evidence: safeJsonParse<Record<string, unknown>>(row.evidence_json) ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async findById(id: VerificationResultId): Promise<VerificationResult | null> {
    const row = this.db
      .prepare('SELECT * FROM verification_results WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async findByAttemptId(attemptId: AttemptId): Promise<VerificationResult | null> {
    const row = this.db
      .prepare('SELECT * FROM verification_results WHERE attempt_id = ? ORDER BY created_at ASC LIMIT 1')
      .get(attemptId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Records the verification verdict for an attempt.
   *
   * Deliberately a PLAIN INSERT, not an upsert. Freeze §E.4.1 requires
   * `UNIQUE (attempt_id)` so that "two conflicting results" for one attempt are
   * impossible and the resume path is deterministic. An `ON CONFLICT(attempt_id)
   * DO UPDATE` would satisfy the row count while silently ERASING the first verdict,
   * which is the very conflict the constraint exists to prevent: a re-evaluation would
   * destroy the audit record of what was actually verified, with no trace.
   *
   * The controller never needs an update: `verifyPlanFirstUnit` checks
   * `findByAttemptId` first and, on a crash between "result written" and "unit
   * completed", RESUMES from the stored result instead of re-evaluating (freeze §G
   * step 10). A rejection here therefore means a caller genuinely tried to record a
   * second verdict for one attempt, which must be a loud failure.
   */
  async save(result: VerificationResult): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO verification_results (
           id, attempt_id, check_id, result, evidence_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.id,
        result.attemptId,
        result.checkId ?? null,
        result.result,
        result.evidence ? safeJsonStringify(result.evidence) : null,
        result.createdAt,
        result.updatedAt,
      );
  }
}
