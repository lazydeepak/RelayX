import {
  ProjectId,
  PairId,
  RuntimeSessionId,
  AssignmentId,
  AttemptId,
  DeliveryId,
  HandoffId,
  AttentionItemId,
  EventId,
  PlanFirstRunId,
  WorkUnitId,
  ProviderType,
  ObservableEvidence,
  createId,
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
import { WorkUnit, PlanFirstRun } from '../domain/planFirst.ts';
import {
  MilestoneVerification,
  PlanFirstVerificationEvaluator,
} from '../domain/planFirstVerification.ts';
import {
  DuplicateDeliveryAttemptError,
  AmbiguousDeliveryResendError,
  RuntimeNotAvailableError,
  RelayDomainError,
} from '../domain/errors.ts';
import { IRelayRepositories } from '../persistence/interfaces.ts';
import {
  IRuntimeProvider,
  RuntimeTargetDescriptor,
  RuntimeInspectionResult,
} from '../providers/interfaces.ts';

/**
 * Provenances that may authorize pairing. Anything else (e.g. a historical
 * 'pair_binding' placeholder) is not evidence of project membership.
 */
const AUTHORITATIVE_ASSOCIATION_PROVENANCES: ReadonlySet<string> = new Set([
  'discovery',
  'adoption',
  'setup',
]);

export class RelayEngine {
  private readonly providers: Map<ProviderType, IRuntimeProvider> = new Map();
  private isSupervising = false;
  /**
   * Deterministic verification seam (PLAN_FIRST_DOMAIN_FREEZE.md §G step 10). Defaults to
   * the fail-closed milestone-1 evaluator, because the real correctness check is
   * explicitly deferred to §15 step 11. Injectable so the §H operational proof can supply
   * a deterministic check without the controller ever reading provider UI.
   */
  private readonly planFirstVerification: PlanFirstVerificationEvaluator;

  constructor(
    public readonly repos: IRelayRepositories,
    planFirstVerification?: PlanFirstVerificationEvaluator,
  ) {
    this.planFirstVerification = planFirstVerification ?? new MilestoneVerification();
  }

  public registerProvider(provider: IRuntimeProvider): void {
    this.providers.set(provider.providerType, provider);
  }

  public getProvider(type: ProviderType): IRuntimeProvider {
    const p = this.providers.get(type);
    if (!p) {
      throw new RelayDomainError(`Provider for type '${type}' not registered`, 'PROVIDER_NOT_REGISTERED');
    }
    return p;
  }

  /* --- Event Helper --- */
  private async emitEvent(
    resourceType: RelayEvent['resourceType'],
    resourceId: string,
    eventType: string,
    options: {
      actor?: RelayEvent['actor'];
      previousState?: string;
      newState?: string;
      evidence?: ObservableEvidence;
      correlationId?: string;
      details?: Record<string, unknown>;
    } = {},
  ): Promise<RelayEvent> {
    const event = RelayEvent.create(resourceType, resourceId, eventType, options);
    await this.repos.events.save(event);
    return event;
  }

  /* --- Project & Pair Management --- */
  public async createProject(name: string, description = '', canonicalPath?: string, gitRoot?: string): Promise<Project> {
    const project = Project.create(name, description, canonicalPath, gitRoot);
    await this.repos.projects.save(project);
    await this.emitEvent('project', project.id, 'project.created', {
      actor: 'user',
      newState: 'active',
      details: { name, description, canonicalPath, gitRoot },
    });
    return project;
  }

  public async updateProject(id: ProjectId, name?: string, description?: string): Promise<Project> {
    const project = await this.repos.projects.findById(id);
    if (!project) throw new RelayDomainError(`Project ${id} not found`, 'NOT_FOUND');

    project.update(name, description);
    await this.repos.projects.save(project);

    await this.emitEvent('project', id, 'project.updated', {
      actor: 'user',
      newState: project.status,
      details: { name: project.name, description: project.description },
    });
    return project;
  }

  public async archiveProject(id: ProjectId): Promise<Project> {
    const project = await this.repos.projects.findById(id);
    if (!project) throw new RelayDomainError(`Project ${id} not found`, 'NOT_FOUND');

    // Guard: cannot archive if active assignments are in flight
    const assignments = await this.repos.assignments.findAll();
    const activeAssignments = assignments.filter(
      (a) => a.projectId === id && ['pending', 'active', 'waiting_for_handoff'].includes(a.status),
    );
    if (activeAssignments.length > 0) {
      throw new RelayDomainError(
        `Cannot archive project with ${activeAssignments.length} active assignment(s). Cancel or complete work first.`,
        'ACTIVE_WORK_GUARD',
      );
    }

    const previousState = project.status;
    project.archive();
    await this.repos.projects.save(project);

    await this.emitEvent('project', id, 'project.archived', {
      actor: 'user',
      previousState,
      newState: 'archived',
    });
    return project;
  }

  public async unarchiveProject(id: ProjectId): Promise<Project> {
    const project = await this.repos.projects.findById(id);
    if (!project) throw new RelayDomainError(`Project ${id} not found`, 'NOT_FOUND');

    project.unarchive();
    await this.repos.projects.save(project);

    await this.emitEvent('project', id, 'project.updated', {
      actor: 'user',
      previousState: 'archived',
      newState: 'active',
    });
    return project;
  }

  public async canDeleteProject(id: ProjectId): Promise<{ canDelete: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const project = await this.repos.projects.findById(id);
    if (!project) {
      return { canDelete: false, reasons: ['Project not found'] };
    }

    const pairs = await this.repos.pairs.findByProjectId(id);
    const assignments = await this.repos.assignments.findAll();
    const projectAssignments = assignments.filter((a) => a.projectId === id);

    // 1. Check for active assignments
    const activeAssignments = projectAssignments.filter((a) =>
      ['pending', 'active', 'waiting_for_handoff'].includes(a.status),
    );
    if (activeAssignments.length > 0) {
      reasons.push(`Project has ${activeAssignments.length} active or in-flight assignment(s)`);
    }

    // 2. Check for active pair state
    const activePairs = pairs.filter((p) => p.status === 'active' || p.activeAssignmentId);
    if (activePairs.length > 0) {
      reasons.push(`Project has ${activePairs.length} pair(s) with active work in progress`);
    }

    // 3. Check for in-flight attempts, deliveries, handoffs for each project assignment
    for (const asgn of projectAssignments) {
      const attempts = await this.repos.attempts.findByAssignmentId(asgn.id);
      const runningAttempts = attempts.filter((at) => at.status === 'running');
      if (runningAttempts.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${runningAttempts.length} running execution attempt(s)`);
      }

      const deliveries = await this.repos.deliveries.findByAssignmentId(asgn.id);
      const pendingDeliveries = deliveries.filter((d) => ['pending', 'delivering'].includes(d.status));
      if (pendingDeliveries.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${pendingDeliveries.length} in-flight delivery attempt(s)`);
      }

      const handoffs = await this.repos.handoffs.findByAssignmentId(asgn.id);
      const pendingHandoffs = handoffs.filter((h) => ['pending', 'ready'].includes(h.status));
      if (pendingHandoffs.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${pendingHandoffs.length} pending handoff(s) awaiting delivery`);
      }
    }

    // 4. Check for working runtimes in this project's pairs
    for (const pair of pairs) {
      if (pair.plannerSessionId) {
        const planner = await this.repos.runtimes.findById(pair.plannerSessionId);
        if (planner && planner.status === 'working') {
          reasons.push(`Planner runtime '${planner.name}' is currently in 'working' status`);
        }
      }
      if (pair.workerSessionId) {
        const worker = await this.repos.runtimes.findById(pair.workerSessionId);
        if (worker && worker.status === 'working') {
          reasons.push(`Worker runtime '${worker.name}' is currently in 'working' status`);
        }
      }
    }

    return {
      canDelete: reasons.length === 0,
      reasons,
    };
  }

  public async deleteProject(id: ProjectId): Promise<void> {
    const check = await this.canDeleteProject(id);
    if (!check.canDelete) {
      throw new RelayDomainError(
        `Cannot delete project: active dependencies exist (${check.reasons.join('; ')}). Archive the project instead.`,
        'ACTIVE_WORK_GUARD',
      );
    }
    const project = await this.repos.projects.findById(id);
    if (!project) throw new RelayDomainError(`Project ${id} not found`, 'NOT_FOUND');

    const pairs = await this.repos.pairs.findByProjectId(id);
    for (const p of pairs) {
      await this.repos.pairs.delete(p.id);
    }

    await this.repos.projects.delete(id);

    // Event emitted: historical events remain in events repository for audit compliance
    await this.emitEvent('project', id, 'project.deleted', {
      actor: 'user',
      previousState: project.status,
      newState: 'deleted',
      details: { name: project.name, deletedPairsCount: pairs.length },
    });
  }

  public async registerRuntimeSession(
    providerType: ProviderType,
    name: string,
    bundleIdentifier?: string,
  ): Promise<RuntimeSession> {
    const runtime = RuntimeSession.create(providerType, name, bundleIdentifier);
    await this.repos.runtimes.save(runtime);
    await this.emitEvent('runtime', runtime.id, 'runtime.registered', {
      actor: 'engine',
      newState: runtime.status,
      details: { name, providerType, bundleIdentifier },
    });
    return runtime;
  }

  /**
   * Discovers or updates a runtime session for a given provider.
   * Invariant: Repeated discovery updates the existing runtime rather than creating
   * duplicates — except when only project-scoped identity (openCodeProjectId) is present
   * without a proven session ID: distinct sessions in one project must not collapse.
   */
  public async discoverRuntime(
    providerType: ProviderType,
    descriptor?: RuntimeTargetDescriptor,
  ): Promise<{ runtime: RuntimeSession; inspection: RuntimeInspectionResult; isNew: boolean }> {
    const provider = this.getProvider(providerType);
    const targetDescriptor = descriptor ?? { providerType };
    const inspection = await provider.findRuntime(targetDescriptor);

    // Session identity must be PROVEN to identify one provider session. Only an
    // authoritativeSessionId verified against the shared OpenCode service or a
    // persisted session record qualifies. parsedSessionId can also arrive from a
    // plain window-title parse (unverified), and openCodeProjectId is project
    // identity, never session identity — neither may drive reuse or be persisted
    // as the external session ID.
    const details = (inspection.evidence?.details || {}) as any;
    const extId: string | undefined = details.authoritativeSessionId;
    // Project identity is tracked separately from session identity.
    const projectRef: string | null = providerType === 'opencode'
      ? (details.workspacePath || details.openCodeProjectId || null)
      : (details.projectUrl || details.projectName || null);

    let existing: RuntimeSession | null = null;
    if (extId) {
      // Proven session identity present: reuse ONLY the runtime bound to this exact
      // (providerType, externalSessionId). PID/bundle/title/provider-only fallbacks
      // would silently claim the wrong runtime (e.g. a legacy null-ID paired runtime).
      existing = await this.repos.runtimes.findByExternalSessionId(providerType, extId);
    } else if (details.openCodeProjectId) {
      // Project-scoped identity without a proven session ID cannot distinguish one
      // session from another inside the same project. Reusing by PID/bundle/provider
      // could claim the wrong session, so a distinct runtime is created instead.
      existing = null;
    } else {
      // No identity available at all: retain the documented legacy fallback —
      // application PID, then bundle identifier, then any runtime of the provider type.
      const existingRuntimes = await this.repos.runtimes.findAll();
      existing = existingRuntimes.find((r) => {
        if (r.providerType !== providerType) return false;
        if (inspection.applicationPid && r.applicationPid === inspection.applicationPid) return true;
        if (targetDescriptor.bundleIdentifier && r.bundleIdentifier === targetDescriptor.bundleIdentifier) return true;
        return true;
      }) ?? null;
    }

    if (existing) {
      if (inspection.found) {
        existing.recordObservationSuccess(
          inspection.isWorking ? 'working' : 'available',
          inspection.evidence,
          inspection.windowTitle,
          inspection.applicationPid,
        );
      } else {
        existing.recordObservationFailure();
      }
      // Reuse found by exact external identity (or legacy fallback): the runtime's
      // authoritative identity is preserved and observations are persisted.
      await this.repos.runtimes.save(existing);
      await this.emitEvent('runtime', existing.id, 'runtime.discovered', {
        actor: 'engine',
        newState: existing.status,
        evidence: inspection.evidence,
        details: { providerType, isNew: false },
      });
      return { runtime: existing, inspection, isNew: false };
    }

    const runtimeName = inspection.windowTitle || `${providerType.toUpperCase()} Runtime`;
    const runtime = RuntimeSession.create(providerType, runtimeName, targetDescriptor.bundleIdentifier);
    if (inspection.found) {
      runtime.recordObservationSuccess(
        inspection.isWorking ? 'working' : 'available',
        inspection.evidence,
        inspection.windowTitle,
        inspection.applicationPid,
      );
    } else {
      runtime.status = 'unavailable';
      runtime.lastEvidence = inspection.evidence;
    }
    // Persist verified session identity and project identity separately at the
    // creation boundary. Project identity is kept in externalProjectRef even when
    // no proven session ID exists (e.g. evidence carrying only openCodeProjectId).
    if (extId || projectRef) {
      runtime.updateExternalIdentity(extId ?? null, projectRef ?? null);
    }
    await this.repos.runtimes.save(runtime);
    await this.emitEvent('runtime', runtime.id, 'runtime.discovered', {
      actor: 'engine',
      newState: runtime.status,
      evidence: inspection.evidence,
      details: { providerType, isNew: true },
    });
    return { runtime, inspection, isNew: true };
  }

  /**
   * Pairing requires pre-existing, verified, provider-evidenced project
   * association. This deliberately reads only persisted evidence: it never
   * derives membership from a runtime's own mutable fields, and never infers a
   * session from directory, recency, or ordering heuristics. A repository that
   * cannot verify the evidence columns throws its own schema-gap error, which
   * propagates so a pair can never be created against unverifiable evidence.
   *
   * A runtime with no provider session id has no session identity to verify
   * (e.g. a planner bound only to a project URL during setup), so there is
   * nothing to corroborate and the gate does not apply to it.
   */
  public async assertPrePairAuthoritativeAssociation(
    role: 'planner' | 'worker',
    runtime: RuntimeSession,
    projectId: ProjectId,
  ): Promise<void> {
    // Fail closed: with no association repository there is nothing that could
    // verify evidence, so pairing must stop instead of assuming that a
    // runtime's own fields are proof of project membership.
    if (!this.repos.associations) {
      throw new Error(
        'Association schema gap: repository cannot verify runtime_session_id, provider_type, external_session_id, and project_id for pre-pair evidence',
      );
    }
    // A runtime with no provider session id has no session identity to
    // corroborate. That alone is not a defect: if nothing is claimed about it,
    // there is nothing to verify and the legacy path may proceed. But a stored
    // verified/authoritative row that cannot name a session is claiming
    // verification it cannot support, and that is a schema gap.
    if (!runtime.externalSessionId) {
      const rows = await this.repos.associations.findBySessionId(runtime.id);
      const unverifiableClaim = rows.some(
        (row) =>
          row.verificationState === 'verified' &&
          AUTHORITATIVE_ASSOCIATION_PROVENANCES.has(row.provenance),
      );
      if (unverifiableClaim) {
        throw new Error(
          'Association schema gap: external_session_id is required for pre-pair evidence',
        );
      }
      return;
    }
    // The repository is consulted for the exact (session, provider, external id,
    // project) identity; it raises its own schema gap if the stored evidence
    // columns cannot support the comparison.
    const evidence = await this.repos.associations.findVerifiedBySessionId(runtime.id, {
      providerType: runtime.providerType,
      externalSessionId: runtime.externalSessionId,
      projectId,
    });
    if (!evidence) {
      throw new RelayDomainError(
        `${role} session lacks matching pre-pair verified authoritative association`,
        'ASSOCIATION_NOT_VERIFIED',
      );
    }
  }

  public async createPair(
    projectId: ProjectId,
    name: string,
    plannerSessionId?: RuntimeSessionId,
    workerSessionId?: RuntimeSessionId,
  ): Promise<Pair> {
    const project = await this.repos.projects.findById(projectId);
    if (!project) throw new RelayDomainError(`Project ${projectId} not found`, 'NOT_FOUND');

    if (plannerSessionId) {
      const planner = await this.repos.runtimes.findById(plannerSessionId);
      if (!planner) throw new RelayDomainError('Planner runtime not found', 'RUNTIME_NOT_FOUND');
      const existingPairs = await this.repos.pairs.findAll();
      const alreadyPaired = existingPairs.find(
        (p) => p.status !== 'archived' && (p.plannerSessionId === plannerSessionId || p.workerSessionId === plannerSessionId),
      );
      if (alreadyPaired) throw new RelayDomainError('Runtime session is already bound to an active pair', 'SESSION_ALREADY_PAIRED');
      // Pre-pair ground truth: a runtime's own fields are not proof of project
      // membership. Require a pre-existing, verified, provider-evidenced row for
      // this exact (session, provider, external id, project) identity.
      await this.assertPrePairAuthoritativeAssociation('planner', planner, projectId);
    }
    if (workerSessionId) {
      const worker = await this.repos.runtimes.findById(workerSessionId);
      if (!worker) throw new RelayDomainError('Worker runtime not found', 'RUNTIME_NOT_FOUND');
      const existingPairs = await this.repos.pairs.findAll();
      const alreadyPaired = existingPairs.find(
        (p) => p.status !== 'archived' && (p.plannerSessionId === workerSessionId || p.workerSessionId === workerSessionId),
      );
      if (alreadyPaired) throw new RelayDomainError('Runtime session is already bound to an active pair', 'SESSION_ALREADY_PAIRED');
      await this.assertPrePairAuthoritativeAssociation('worker', worker, projectId);
    }

    const pair = Pair.create(projectId, name, plannerSessionId, workerSessionId);
    await this.repos.pairs.save(pair);
    await this.emitEvent('pair', pair.id, 'pair.created', {
      actor: 'user',
      newState: pair.status,
      details: { name, projectId, plannerSessionId, workerSessionId },
    });
    return pair;
  }

  public async updatePair(
    id: PairId,
    updates: { name?: string; plannerSessionId?: RuntimeSessionId | null; workerSessionId?: RuntimeSessionId | null },
  ): Promise<Pair> {
    const pair = await this.repos.pairs.findById(id);
    if (!pair) throw new RelayDomainError(`Pair ${id} not found`, 'NOT_FOUND');

    if (pair.activeAssignmentId && (updates.plannerSessionId !== undefined || updates.workerSessionId !== undefined)) {
      throw new RelayDomainError(
        'Cannot rebind runtimes while pair has an active assignment in flight. Pause or complete work first.',
        'ACTIVE_WORK_GUARD',
      );
    }

    const previousPlanner = pair.plannerSessionId;
    const previousWorker = pair.workerSessionId;

    if (updates.plannerSessionId) {
      const planner = await this.repos.runtimes.findById(updates.plannerSessionId);
      if (!planner) throw new RelayDomainError('New planner runtime not found', 'RUNTIME_NOT_FOUND');
      // Rebinding selects a new session, so it is subject to the same
      // authoritative-evidence gate as initial pairing.
      await this.assertPrePairAuthoritativeAssociation('planner', planner, pair.projectId);
    }
    if (updates.workerSessionId) {
      const worker = await this.repos.runtimes.findById(updates.workerSessionId);
      if (!worker) throw new RelayDomainError('New worker runtime not found', 'RUNTIME_NOT_FOUND');
      await this.assertPrePairAuthoritativeAssociation('worker', worker, pair.projectId);
    }

    pair.update(updates.name, updates.plannerSessionId, updates.workerSessionId);
    await this.repos.pairs.save(pair);

    if (updates.plannerSessionId !== undefined && updates.plannerSessionId !== previousPlanner) {
      if (updates.plannerSessionId) {
        await this.emitEvent('runtime', updates.plannerSessionId, previousPlanner ? 'runtime.replaced' : 'runtime.attached', {
          actor: 'user',
          details: { pairId: id, role: 'planner', oldSessionId: previousPlanner, newSessionId: updates.plannerSessionId },
        });
      } else if (previousPlanner) {
        await this.emitEvent('runtime', previousPlanner, 'runtime.detached', {
          actor: 'user',
          details: { pairId: id, role: 'planner', runtimeSessionId: previousPlanner },
        });
      }
    }

    if (updates.workerSessionId !== undefined && updates.workerSessionId !== previousWorker) {
      if (updates.workerSessionId) {
        await this.emitEvent('runtime', updates.workerSessionId, previousWorker ? 'runtime.replaced' : 'runtime.attached', {
          actor: 'user',
          details: { pairId: id, role: 'worker', oldSessionId: previousWorker, newSessionId: updates.workerSessionId },
        });
      } else if (previousWorker) {
        await this.emitEvent('runtime', previousWorker, 'runtime.detached', {
          actor: 'user',
          details: { pairId: id, role: 'worker', runtimeSessionId: previousWorker },
        });
      }
    }

    await this.emitEvent('pair', id, 'pair.updated', {
      actor: 'user',
      newState: pair.status,
      details: updates,
    });

    return pair;
  }

  public async rebindPairPlanner(pairId: PairId, plannerSessionId: RuntimeSessionId): Promise<Pair> {
    return this.updatePair(pairId, { plannerSessionId });
  }

  public async rebindPairWorker(pairId: PairId, workerSessionId: RuntimeSessionId): Promise<Pair> {
    return this.updatePair(pairId, { workerSessionId });
  }

  public async detachPairRuntime(pairId: PairId, role: 'planner' | 'worker'): Promise<Pair> {
    return this.updatePair(pairId, {
      [role === 'planner' ? 'plannerSessionId' : 'workerSessionId']: null,
    });
  }

  public async archivePair(id: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(id);
    if (!pair) throw new RelayDomainError(`Pair ${id} not found`, 'NOT_FOUND');
    if (pair.activeAssignmentId) {
      throw new RelayDomainError('Cannot archive pair with active assignment in flight. Pause or complete work first.', 'ACTIVE_WORK_GUARD');
    }
    const previousState = pair.status;
    pair.archive();
    await this.repos.pairs.save(pair);

    await this.emitEvent('pair', id, 'pair.archived', {
      actor: 'user',
      previousState,
      newState: 'archived',
    });
    return pair;
  }

  public async unarchivePair(id: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(id);
    if (!pair) throw new RelayDomainError(`Pair ${id} not found`, 'NOT_FOUND');
    pair.unarchive();
    await this.repos.pairs.save(pair);

    await this.emitEvent('pair', id, 'pair.updated', {
      actor: 'user',
      previousState: 'archived',
      newState: pair.status,
    });
    return pair;
  }

  public async canDeletePair(id: PairId): Promise<{ canDelete: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const pair = await this.repos.pairs.findById(id);
    if (!pair) {
      return { canDelete: false, reasons: ['Pair not found'] };
    }

    if (pair.status === 'active' || pair.activeAssignmentId) {
      reasons.push('Pair currently has an active running assignment');
    }

    const assignments = await this.repos.assignments.findAll();
    const pairAssignments = assignments.filter((a) => a.pairId === id);
    const activeAssignments = pairAssignments.filter((a) =>
      ['pending', 'active', 'waiting_for_handoff'].includes(a.status),
    );
    if (activeAssignments.length > 0) {
      reasons.push(`Pair has ${activeAssignments.length} active or in-flight assignment(s)`);
    }

    if (pair.workerSessionId) {
      const worker = await this.repos.runtimes.findById(pair.workerSessionId);
      if (worker && worker.status === 'working') {
        reasons.push(`Worker runtime '${worker.name}' is currently in 'working' status`);
      }
    }
    if (pair.plannerSessionId) {
      const planner = await this.repos.runtimes.findById(pair.plannerSessionId);
      if (planner && planner.status === 'working') {
        reasons.push(`Planner runtime '${planner.name}' is currently in 'working' status`);
      }
    }

    for (const asgn of pairAssignments) {
      const attempts = await this.repos.attempts.findByAssignmentId(asgn.id);
      const runningAttempts = attempts.filter((at) => at.status === 'running');
      if (runningAttempts.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${runningAttempts.length} running execution attempt(s)`);
      }

      const deliveries = await this.repos.deliveries.findByAssignmentId(asgn.id);
      const pendingDeliveries = deliveries.filter((d) => ['pending', 'delivering'].includes(d.status));
      if (pendingDeliveries.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${pendingDeliveries.length} in-flight delivery attempt(s)`);
      }

      const handoffs = await this.repos.handoffs.findByAssignmentId(asgn.id);
      const pendingHandoffs = handoffs.filter((h) => ['pending', 'ready'].includes(h.status));
      if (pendingHandoffs.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${pendingHandoffs.length} pending handoff(s) awaiting delivery`);
      }
    }

    return {
      canDelete: reasons.length === 0,
      reasons,
    };
  }

  public async deletePair(id: PairId): Promise<void> {
    const check = await this.canDeletePair(id);
    if (!check.canDelete) {
      throw new RelayDomainError(
        `Cannot delete pair: active dependencies exist (${check.reasons.join('; ')}). Archive the pair instead.`,
        'ACTIVE_WORK_GUARD',
      );
    }
    const pair = await this.repos.pairs.findById(id);
    if (!pair) throw new RelayDomainError(`Pair ${id} not found`, 'NOT_FOUND');

    await this.repos.pairs.delete(id);

    await this.emitEvent('pair', id, 'pair.deleted', {
      actor: 'user',
      previousState: pair.status,
      newState: 'deleted',
      details: { name: pair.name, projectId: pair.projectId },
    });
  }

  public async canDeleteRuntimeSession(sessionId: RuntimeSessionId): Promise<{ canDelete: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const runtime = await this.repos.runtimes.findById(sessionId);
    if (!runtime) return { canDelete: false, reasons: ['Runtime session not found'] };

    if (runtime.status === 'working') {
      reasons.push(`Runtime '${runtime.name}' is currently working on an assignment`);
    }

    const pairs = await this.repos.pairs.findAll();
    const pairsUsingRuntime = pairs.filter(
      (p) => p.plannerSessionId === sessionId || p.workerSessionId === sessionId,
    );
    if (pairsUsingRuntime.length > 0) {
      const activePairs = pairsUsingRuntime.filter((p) => p.status === 'active' || p.activeAssignmentId);
      if (activePairs.length > 0) {
        reasons.push(`Runtime is currently attached to active pair '${activePairs[0].name}'`);
      } else {
        reasons.push(`Runtime is currently attached to pair '${pairsUsingRuntime[0].name}'. Detach it before deleting.`);
      }
    }

    const activeAssignments = await this.repos.assignments.findActive();
    for (const asgn of activeAssignments) {
      const deliveries = await this.repos.deliveries.findByAssignmentId(asgn.id);
      const activeDeliveries = deliveries.filter(
        (d) => d.targetRuntimeId === sessionId && ['pending', 'delivering'].includes(d.status),
      );
      if (activeDeliveries.length > 0) {
        reasons.push(`Runtime is target of ${activeDeliveries.length} in-flight deliveries`);
      }
    }

    return {
      canDelete: reasons.length === 0,
      reasons,
    };
  }

  public async detachRuntime(sessionId: RuntimeSessionId): Promise<{ success: boolean; detachedFromPairs: string[] }> {
    const pairs = await this.repos.pairs.findAll();
    const affected = pairs.filter((p) => p.plannerSessionId === sessionId || p.workerSessionId === sessionId);

    const activePairs = affected.filter((p) => p.status === 'active' || p.activeAssignmentId);
    if (activePairs.length > 0) {
      throw new RelayDomainError(
        `Cannot detach runtime: Pair '${activePairs[0].name}' has active work in progress. Pause or complete work first.`,
        'ACTIVE_WORK_GUARD',
      );
    }

    const detachedFromPairs: string[] = [];
    for (const pair of affected) {
      let role: 'planner' | 'worker' = 'planner';
      if (pair.plannerSessionId === sessionId) {
        pair.plannerSessionId = undefined;
        role = 'planner';
      }
      if (pair.workerSessionId === sessionId) {
        pair.workerSessionId = undefined;
        role = 'worker';
      }
      pair.updatedAt = Date.now();
      await this.repos.pairs.save(pair);
      detachedFromPairs.push(pair.id);

      await this.emitEvent('runtime', sessionId, 'runtime.detached', {
        actor: 'user',
        details: { pairId: pair.id, role, runtimeSessionId: sessionId },
      });
      await this.emitEvent('pair', pair.id, 'pair.updated', {
        actor: 'user',
        details: { detachedRuntimeSessionId: sessionId, role },
      });
    }

    return { success: true, detachedFromPairs };
  }

  public async deleteRuntimeSession(sessionId: RuntimeSessionId): Promise<void> {
    const check = await this.canDeleteRuntimeSession(sessionId);
    if (!check.canDelete) {
      throw new RelayDomainError(
        `Cannot delete runtime session: active dependencies exist (${check.reasons.join('; ')}). Detach or archive pairs first.`,
        'ACTIVE_WORK_GUARD',
      );
    }

    // Detach from any non-active pairs first
    await this.detachRuntime(sessionId);

    const runtime = await this.repos.runtimes.findById(sessionId);
    if (!runtime) throw new RelayDomainError(`Runtime session ${sessionId} not found`, 'NOT_FOUND');

    await this.repos.runtimes.delete(sessionId);

    await this.emitEvent('runtime', sessionId, 'runtime.deleted', {
      actor: 'user',
      previousState: runtime.status,
      newState: 'deleted',
      details: { name: runtime.name, providerType: runtime.providerType },
    });
  }

  public async archiveRuntimeSession(id: RuntimeSessionId, reason?: string): Promise<RuntimeSession> {
    const runtime = await this.repos.runtimes.findById(id);
    if (!runtime) throw new RelayDomainError(`Runtime session ${id} not found`, 'NOT_FOUND');

    const previousStatus = runtime.status;
    runtime.archive(reason);
    await this.repos.runtimes.save(runtime);

    await this.emitEvent('runtime', id, 'runtime.archived', {
      actor: 'user',
      previousState: previousStatus,
      newState: 'archived',
      details: { reason },
    });
    return runtime;
  }

  public async unarchiveRuntimeSession(id: RuntimeSessionId): Promise<RuntimeSession> {
    const runtime = await this.repos.runtimes.findById(id);
    if (!runtime) throw new RelayDomainError(`Runtime session ${id} not found`, 'NOT_FOUND');

    runtime.unarchive();
    await this.repos.runtimes.save(runtime);

    await this.emitEvent('runtime', id, 'runtime.updated', {
      actor: 'user',
      previousState: 'archived',
      newState: 'unknown',
    });

    // Immediate re-check of the real external session
    try {
      await this.reconcileAndRecoverRuntime(id);
    } catch (err) {
      // ignore
    }

    return runtime;
  }

  /* --- Assignment Lifecycle & Safe Delivery --- */
  public async createAssignment(
    pairId: PairId,
    title: string,
    instruction: string,
  ): Promise<Assignment> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const assignment = Assignment.create(pairId, pair.projectId, title, instruction);
    await this.repos.assignments.save(assignment);

    await this.emitEvent('assignment', assignment.id, 'assignment.created', {
      actor: 'user',
      newState: assignment.status,
      details: { title, pairId },
    });

    return assignment;
  }

  /**
   * Dispatches and delivers an assignment to the assigned worker runtime.
   * Enforces:
   * - Invariant 1: No duplicate active or ambiguous delivery
   * - Invariant 2: Observable evidence verified before confirmed state
   * - Invariant 3: Ambiguous state on uncertain UI/response state, blocking automatic resend
   */
  public async dispatchAssignment(assignmentId: AssignmentId): Promise<{
    assignment: Assignment;
    attempt: Attempt;
    delivery: Delivery;
  }> {
    // ---- Phase 1: durable dispatch intent, COMMITTED before the external send ----
    // ATTEMPT_LIFECYCLE.md Case 1: if RelayX crashes during the provider call, the
    // prepared Attempt + delivering Delivery must already be durable, so recovery can
    // reconcile intent against external state instead of blindly resending.
    const { assignment, pair, worker, attempt, delivery, idempotencyKey } =
      await this.repos.runInTransaction(async () => {
      const assignment = await this.repos.assignments.findById(assignmentId);
      if (!assignment) throw new RelayDomainError(`Assignment ${assignmentId} not found`, 'NOT_FOUND');

      const pair = await this.repos.pairs.findById(assignment.pairId);
      if (!pair) throw new RelayDomainError(`Pair ${assignment.pairId} not found`, 'PAIR_NOT_FOUND');

      if (!pair.workerSessionId) {
        throw new RelayDomainError('Pair has no worker runtime bound', 'NO_WORKER_BOUND');
      }

      const worker = await this.repos.runtimes.findById(pair.workerSessionId);
      if (!worker) throw new RelayDomainError(`Worker runtime ${pair.workerSessionId} not found`, 'NOT_FOUND');

      if (worker.status === 'terminated') {
        throw new RuntimeNotAvailableError(worker.id, worker.status);
      }

      // Check existing deliveries for this assignment
      const existingDeliveries = await this.repos.deliveries.findByAssignmentId(assignment.id);
      const ambiguousDelivery = existingDeliveries.find((d) => d.status === 'ambiguous');
      if (ambiguousDelivery) {
        throw new AmbiguousDeliveryResendError(
          `Assignment ${assignment.id} has an ambiguous delivery (${ambiguousDelivery.id}). Automated resend blocked.`,
        );
      }

      const activeDelivery = existingDeliveries.find((d) => d.status === 'delivering');
      if (activeDelivery) {
        throw new DuplicateDeliveryAttemptError(
          `Assignment ${assignment.id} currently has an in-flight delivery (${activeDelivery.id}).`,
        );
      }

      // Create new attempt. attemptNumber must be max(existing)+1, not count+1, so a
      // retried/duplicated dispatch can never mint a colliding attempt number.
      const attempts = await this.repos.attempts.findByAssignmentId(assignment.id);
      const attemptNumber = attempts.reduce((max, a) => Math.max(max, a.attemptNumber), 0) + 1;
      // Execution authority is frozen here, at dispatch (EXECUTION_AUTHORITY.md §1-2).
      const attempt = Attempt.create(assignment.id, attemptNumber, {
        sessionPairId: pair.id,
        workerSessionId: worker.id,
        externalSessionId: worker.externalSessionId ?? null,
      });
      await this.repos.attempts.save(attempt);

      assignment.startAttempt(attempt);
      pair.assignWork(assignment.id);
      await this.repos.pairs.save(pair);

      // Create Delivery record with idempotency key
      const idempotencyKey = `idemp_${assignment.id}_att${attemptNumber}_${Date.now()}`;
      const delivery = Delivery.create(
        assignment.id,
        attempt.id,
        worker.id,
        assignment.instruction.substring(0, 100),
        idempotencyKey,
      );
      delivery.startDelivering();
      assignment.attachDelivery(delivery);
      await this.repos.deliveries.save(delivery);
      await this.repos.assignments.save(assignment);

      await this.emitEvent('delivery', delivery.id, 'delivery.started', {
        actor: 'engine',
        previousState: 'pending',
        newState: 'delivering',
        correlationId: idempotencyKey,
      });

      return { assignment, pair, worker, attempt, delivery, idempotencyKey };
    });

    // ---- Phase 2: external provider call, deliberately OUTSIDE the DB transaction ----
    const provider = this.getProvider(worker.providerType);
    const result = await provider.deliverInstruction({
      runtimeSessionId: worker.id,
      instructionText: assignment.instruction,
      idempotencyKey,
    });

    // ---- Phase 3: record the outcome ----
    return this.repos.runInTransaction(async () => {
      if (result.outcome === 'delivered') {
        // Confirmed delivered via verified evidence
        delivery.confirmDelivered(result.evidence);
        await this.repos.deliveries.save(delivery);

        // confirmDispatch(): the worker is now physically executing.
        if (attempt.status === 'prepared') {
          attempt.startRunning();
          await this.repos.attempts.save(attempt);
        }

        worker.recordObservationSuccess('working', result.evidence);
        await this.repos.runtimes.save(worker);

        await this.emitEvent('delivery', delivery.id, 'delivery.confirmed', {
          actor: 'provider',
          previousState: 'delivering',
          newState: 'delivered',
          evidence: result.evidence,
          correlationId: idempotencyKey,
        });

        await this.emitEvent('runtime', worker.id, 'worker.started', {
          actor: 'engine',
          previousState: 'available',
          newState: 'working',
          evidence: result.evidence,
        });
      } else if (result.outcome === 'ambiguous') {
        // Mark ambiguous, raise critical attention item
        delivery.markAmbiguous(result.reason ?? 'Delivery outcome ambiguous', result.evidence);
        await this.repos.deliveries.save(delivery);

        const attention = AttentionItem.create(
          'critical',
          'ambiguous_delivery',
          'Ambiguous Instruction Delivery',
          `Could not verify whether instruction was received by worker runtime ${worker.name}. Manual or planner confirmation required.`,
          {
            pairId: pair.id,
            assignmentId: assignment.id,
            suggestedAction: 'Inspect worker composer or window, reconcile state, and either confirm delivery or reset attempt.',
            suggestedTier: 'tier_1_deterministic',
          },
        );
        await this.repos.attention.save(attention);

        await this.emitEvent('delivery', delivery.id, 'delivery.ambiguous', {
          actor: 'provider',
          previousState: 'delivering',
          newState: 'ambiguous',
          evidence: result.evidence,
          details: { reason: result.reason },
        });

        await this.emitEvent('attention', attention.id, 'attention.created', {
          actor: 'engine',
          newState: 'open',
          details: { title: attention.title },
        });
      } else {
        // Failed: the instruction never reached the worker, so NO physical execution
        // occurred. The Attempt therefore stays `prepared` (ATTEMPT_LIFECYCLE.md Case 1:
        // durable intent stored, external send not performed) and the outcome is recorded
        // on the Delivery, which is where observable delivery evidence belongs. The attempt
        // is never marked interrupted here, because the worker never started running; a
        // later dispatch mints a fresh attempt with a fresh attemptNumber.
        delivery.markFailed(result.reason ?? 'Delivery failed', result.evidence);
        await this.repos.deliveries.save(delivery);

        await this.emitEvent('delivery', delivery.id, 'delivery.failed', {
          actor: 'provider',
          previousState: 'delivering',
          newState: 'failed',
          details: { reason: result.reason },
        });
      }

      return { assignment, attempt, delivery };
    });
  }

  /* --- Supervisor Tick (Observe -> Reconcile -> Decide -> Act -> Verify) --- */
  public async runSupervisionTick(): Promise<{
    inspectedRuntimes: number;
    inspectedAssignments: number;
    handoffsCreated: number;
    attentionItemsCreated: number;
  }> {
    if (this.isSupervising) return { inspectedRuntimes: 0, inspectedAssignments: 0, handoffsCreated: 0, attentionItemsCreated: 0 };
    this.isSupervising = true;

    try {
      let handoffsCreated = 0;
      let attentionItemsCreated = 0;

      // 1. Inspect active assignments
      const activeAssignments = await this.repos.assignments.findActive();
      for (const assignment of activeAssignments) {
        if (!assignment.currentAttemptId) continue;
        const pair = await this.repos.pairs.findById(assignment.pairId);
        if (!pair) continue;

        if (!pair.workerSessionId) continue;
        const worker = await this.repos.runtimes.findById(pair.workerSessionId);
        if (!worker) continue;

        const provider = this.getProvider(worker.providerType);

        // Probe worker runtime state
        try {
          const inspection = await provider.inspectRuntime(worker.id);
          if (!inspection.found) {
            // Failure to find runtime: record observation failure (never immediately mark dead)
            const { previousStatus, newStatus } = worker.recordObservationFailure();
            await this.repos.runtimes.save(worker);

            if (previousStatus !== newStatus) {
              await this.emitEvent('runtime', worker.id, `runtime.${newStatus}`, {
                actor: 'supervisor',
                previousState: previousStatus,
                newState: newStatus,
                evidence: inspection.evidence,
              });

              if (newStatus === 'suspended') {
                const att = AttentionItem.create(
                  'warning',
                  'runtime_suspended',
                  `Worker runtime '${worker.name}' temporarily unavailable`,
                  'Runtime window was not found during routine supervision. Placed into suspended state for retry.',
                  {
                    pairId: pair.id,
                    assignmentId: assignment.id,
                    suggestedAction: 'Verify application is open and active.',
                  },
                );
                await this.repos.attention.save(att);
                attentionItemsCreated++;
              }
            }
          } else {
            // Worker is found
            worker.recordObservationSuccess(
              inspection.isWorking ? 'working' : 'available',
              inspection.evidence,
              inspection.windowTitle,
              inspection.applicationPid,
            );
            await this.repos.runtimes.save(worker);

            // Check if worker completed work
            if (inspection.isComplete && assignment.status === 'active') {
              // Worker completed! Create Handoff for planner review
              const handoff = Handoff.create(assignment.id, assignment.currentAttemptId);
              handoff.markReady(
                inspection.lastResponseSnippet ?? 'Worker completed task response.',
                { fullResponse: inspection.lastResponseSnippet },
                inspection.evidence,
              );
              await this.repos.handoffs.save(handoff);

              assignment.markWaitingForHandoff(handoff.id);
              await this.repos.assignments.save(assignment);
              handoffsCreated++;

              await this.emitEvent('handoff', handoff.id, 'handoff.received', {
                actor: 'supervisor',
                previousState: 'pending',
                newState: 'ready',
                evidence: inspection.evidence,
              });

              await this.emitEvent('assignment', assignment.id, 'assignment.waiting_for_handoff', {
                actor: 'supervisor',
                previousState: 'active',
                newState: 'waiting_for_handoff',
              });
            }
          }
        } catch (err: any) {
          // Swallow individual probe error to protect supervisory loop
        }

        pair.markSupervised();
        await this.repos.pairs.save(pair);
      }

      // 2. Check for ambiguous deliveries needing attention
      const ambiguousDeliveries = await this.repos.deliveries.findAmbiguous();
      for (const deliv of ambiguousDeliveries) {
        const openItems = await this.repos.attention.findOpen();
        const exists = openItems.some((i) => i.assignmentId === deliv.assignmentId && i.type === 'ambiguous_delivery');
        if (!exists) {
          const item = AttentionItem.create(
            'critical',
            'ambiguous_delivery',
            'Ambiguous Delivery Pending Resolution',
            `Delivery ${deliv.id} is ambiguous. Operator intervention or recovery is required.`,
            { assignmentId: deliv.assignmentId },
          );
          await this.repos.attention.save(item);
          attentionItemsCreated++;
        }
      }

      return {
        inspectedRuntimes: (await this.repos.runtimes.findAll()).length,
        inspectedAssignments: activeAssignments.length,
        handoffsCreated,
        attentionItemsCreated,
      };
    } finally {
      this.isSupervising = false;
    }
  }

  /* --- Planner Review & Handoff Completion --- */
  /**
   * Invariant 1 & 6:
   * Completing a handoff delivers result to planner.
   * Does NOT complete assignment unless planner explicitly marks assignment complete.
   */
  public async deliverHandoffToPlanner(handoffId: HandoffId): Promise<Handoff> {
    const handoff = await this.repos.handoffs.findById(handoffId);
    if (!handoff) throw new RelayDomainError(`Handoff ${handoffId} not found`, 'NOT_FOUND');

    handoff.markDeliveredToPlanner();
    await this.repos.handoffs.save(handoff);

    await this.emitEvent('handoff', handoff.id, 'planner.notified', {
      actor: 'engine',
      previousState: 'ready',
      newState: 'delivered',
    });

    return handoff;
  }

  public async completeHandoff(handoffId: HandoffId): Promise<Handoff> {
    const handoff = await this.repos.handoffs.findById(handoffId);
    if (!handoff) throw new RelayDomainError(`Handoff ${handoffId} not found`, 'NOT_FOUND');

    handoff.completeHandoff();
    await this.repos.handoffs.save(handoff);

    await this.emitEvent('handoff', handoff.id, 'handoff.complete', {
      actor: 'engine',
      previousState: 'delivered',
      newState: 'complete',
    });

    return handoff;
  }

  public async completeAssignment(assignmentId: AssignmentId): Promise<Assignment> {
    const assignment = await this.repos.assignments.findById(assignmentId);
    if (!assignment) throw new RelayDomainError(`Assignment ${assignmentId} not found`, 'NOT_FOUND');

    assignment.complete();
    await this.repos.assignments.save(assignment);

    if (assignment.currentAttemptId) {
      const attempt = await this.repos.attempts.findById(assignment.currentAttemptId);
      if (attempt && attempt.status === 'running') {
        attempt.completePhysical();
        await this.repos.attempts.save(attempt);
      }
    }

    const pair = await this.repos.pairs.findById(assignment.pairId);
    if (pair && pair.activeAssignmentId === assignment.id) {
      pair.clearWork();
      await this.repos.pairs.save(pair);
    }

    await this.emitEvent('assignment', assignment.id, 'assignment.completed', {
      actor: 'user',
      previousState: assignment.status,
      newState: 'completed',
    });

    return assignment;
  }

  /* --- Tier 1 Deterministic Recovery --- */
  public async reconcileAndRecoverRuntime(sessionId: RuntimeSessionId): Promise<RuntimeSession> {
    const runtime = await this.repos.runtimes.findById(sessionId);
    if (!runtime) throw new RelayDomainError(`Runtime ${sessionId} not found`, 'NOT_FOUND');

    const provider = this.getProvider(runtime.providerType);
    const inspection = await provider.inspectRuntime(runtime.id);

    if (inspection.found) {
      const { previousStatus, newStatus } = runtime.recordObservationSuccess(
        inspection.isWorking ? 'working' : 'available',
        inspection.evidence,
        inspection.windowTitle,
        inspection.applicationPid,
      );
      await this.repos.runtimes.save(runtime);

      // Auto-resolve any open suspension attention items for this runtime
      const openItems = await this.repos.attention.findOpen();
      for (const item of openItems) {
        if (item.type === 'runtime_suspended') {
          item.resolve();
          await this.repos.attention.save(item);
        }
      }

      await this.emitEvent('runtime', runtime.id, 'runtime.recovered', {
        actor: 'recovery',
        previousState: previousStatus,
        newState: newStatus,
        evidence: inspection.evidence,
      });
    } else {
      const { previousStatus, newStatus } = runtime.recordObservationFailure();
      await this.repos.runtimes.save(runtime);

      await this.emitEvent('runtime', runtime.id, 'runtime.observation_failed', {
        actor: 'recovery',
        previousState: previousStatus,
        newState: newStatus,
        details: { reason: 'Runtime not found during reconciliation' },
      });
    }

    return runtime;
  }

  public async resolveAmbiguousDelivery(
    deliveryId: DeliveryId,
    resolution: 'confirmed_delivered' | 'retry_permitted',
  ): Promise<Delivery> {
    const delivery = await this.repos.deliveries.findById(deliveryId);
    if (!delivery) throw new RelayDomainError(`Delivery ${deliveryId} not found`, 'NOT_FOUND');

    if (resolution === 'confirmed_delivered') {
      const evidence: ObservableEvidence = {
        id: `ev_recon_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: delivery.targetRuntimeId,
        details: { manualResolution: 'Operator confirmed message was visible in runtime composer/chat' },
      };
      delivery.confirmDelivered(evidence);
      await this.repos.deliveries.save(delivery);

      const runtime = await this.repos.runtimes.findById(delivery.targetRuntimeId);
      if (runtime) {
        runtime.recordObservationSuccess('working', evidence);
        await this.repos.runtimes.save(runtime);
      }

      await this.emitEvent('delivery', delivery.id, 'delivery.confirmed', {
        actor: 'recovery',
        previousState: 'ambiguous',
        newState: 'delivered',
        evidence,
      });
    } else {
      // mark failed so a new delivery/attempt can be created safely
      delivery.markFailed('Operator cancelled ambiguous attempt for clean retry');
      await this.repos.deliveries.save(delivery);

      await this.emitEvent('delivery', delivery.id, 'delivery.failed', {
        actor: 'recovery',
        previousState: 'ambiguous',
        newState: 'failed',
      });
    }

    // Resolve attention item for this assignment
    const openItems = await this.repos.attention.findOpen();
    for (const item of openItems) {
      if (item.assignmentId === delivery.assignmentId && item.type === 'ambiguous_delivery') {
        item.resolve();
        await this.repos.attention.save(item);
      }
    }

    return delivery;
  }

  public async startPair(pairId: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');
    pair.resume();
    await this.repos.pairs.save(pair);
    await this.emitEvent('pair', pair.id, 'pair.started', {
      actor: 'user',
      newState: pair.status,
    });
    return pair;
  }

  public async pausePair(pairId: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');
    pair.pause();
    await this.repos.pairs.save(pair);
    await this.emitEvent('pair', pair.id, 'pair.paused', {
      actor: 'user',
      newState: pair.status,
    });
    return pair;
  }

  public async resumePair(pairId: PairId): Promise<Pair> {
    return this.startPair(pairId);
  }

  public async stopPair(pairId: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');
    pair.clearWork();
    await this.repos.pairs.save(pair);
    await this.emitEvent('pair', pair.id, 'pair.stopped', {
      actor: 'user',
      newState: pair.status,
    });
    return pair;
  }

  private supervisionTimer: any = null;

  /**
   * Starts non-blocking background supervision loop (Phase 8).
   */
  public startSupervisionLoop(intervalMs = 5000): void {
    if (this.supervisionTimer) return;
    this.supervisionTimer = setInterval(() => {
      this.runSupervisionTick().catch((err) => {
        console.error('[RelayEngine] Error in background supervision tick:', err);
      });
    }, intervalMs);
    if (typeof this.supervisionTimer?.unref === 'function') {
      this.supervisionTimer.unref();
    }
  }

  /**
   * Stops background supervision loop.
   */
  public stopSupervisionLoop(): void {
    if (this.supervisionTimer) {
      clearInterval(this.supervisionTimer);
      this.supervisionTimer = null;
    }
  }

  public isSupervisingLoopActive(): boolean {
    return this.supervisionTimer !== null;
  }

  /**
   * Recovers state upon application startup or following an unexpected restart (Phase 9).
   * Reconciles in-flight assignments and runtimes against active desktop processes.
   */
  public async recoverOnStartup(): Promise<{
    reconciledAssignments: number;
    suspendedRuntimes: number;
    recoveredHandoffs: number;
  }> {
    let reconciledAssignments = 0;
    let suspendedRuntimes = 0;
    let recoveredHandoffs = 0;

    const activeAssignments = await this.repos.assignments.findActive();
    for (const assignment of activeAssignments) {
      const pair = await this.repos.pairs.findById(assignment.pairId);
      if (!pair) continue;
      if (!pair.workerSessionId) continue;
      const worker = await this.repos.runtimes.findById(pair.workerSessionId);
      if (!worker) continue;

      const provider = this.getProvider(worker.providerType);
      try {
        const inspection = await provider.inspectRuntime(worker.id);
        if (inspection.found) {
          if (inspection.isComplete) {
            // Worker finished while Relay was restarting!
            const handoff = Handoff.create(assignment.id, assignment.currentAttemptId!);
            handoff.markReady(
              inspection.lastResponseSnippet ?? 'Worker completed output while Relay was offline.',
              { fullResponse: inspection.lastResponseSnippet },
              inspection.evidence,
            );
            await this.repos.handoffs.save(handoff);
            assignment.markWaitingForHandoff(handoff.id);
            await this.repos.assignments.save(assignment);
            recoveredHandoffs++;

            await this.emitEvent('assignment', assignment.id, 'assignment.recovered_handoff', {
              actor: 'recovery',
              evidence: inspection.evidence,
            });
          } else {
            worker.recordObservationSuccess(
              inspection.isWorking ? 'working' : 'available',
              inspection.evidence,
              inspection.windowTitle,
              inspection.applicationPid,
            );
            await this.repos.runtimes.save(worker);
            reconciledAssignments++;
          }
        } else {
          // Runtime not immediately found: mark suspended, do not kill
          worker.recordObservationFailure();
          await this.repos.runtimes.save(worker);
          suspendedRuntimes++;
        }
      } catch (err) {
        // Tolerant of individual probe exceptions during startup
      }
    }

    return { reconciledAssignments, suspendedRuntimes, recoveredHandoffs };
  }

  /* ================================================================== *
   * Plan-First controller (PLAN_FIRST_DOMAIN_FREEZE.md §G)
   * ================================================================== */

  /**
   * One production Plan-First tick. Rewritten from scratch against the frozen algorithm;
   * the previous implementation was defective scaffolding.
   *
   * Defects this rewrite eliminates (see PLAN_FIRST_DOMAIN_FREEZE.md §11.1):
   *  - It created and saved an Attempt, THEN called dispatchAssignment(), which created a
   *    SECOND Attempt for the same dispatch. Exactly one Assignment and exactly one Attempt
   *    per WorkUnit execution is now structural: this method never constructs an Attempt.
   *  - It persisted a mutable `currentWorkUnitId` cursor that could not survive recovery
   *    and whose `run_completed` branch assigned an object to a scalar (TS2322). The cursor
   *    is now DERIVED from persisted (ordinal, status) state.
   *  - It created a `Strategy` and a `PlannerAssistance`, both frozen as rejected/deferred.
   *  - It completed a unit by writing a status string, bypassing domain transitions.
   *  - It marked a run `completed` while a further eligible unit remained.
   *
   * Idempotency: repeated ticks never create a duplicate Assignment for a WorkUnit, never
   * create a duplicate Attempt for the same dispatch, never re-dispatch an accepted unit,
   * never advance past failed verification, never switch revision, never infer completion
   * from provider UI, and never select a different Pair because discovery changed.
   */
  public async runPlanFirstTick(runId: PlanFirstRunId): Promise<PlanFirstTickResult> {
    const repos = this.repos;

    // --- 1. Load the authoritative run.
    const run = await repos.planFirstRuns.findById(runId);
    if (!run) throw new RelayDomainError(`PlanFirstRun ${runId} not found`, 'NOT_FOUND');

    // --- 2. Invariant 2: a terminal run never executes again. No side effects.
    if (run.isTerminal()) {
      return { transition: 'run_terminal', runId: run.id, plannerUpdateRequired: false };
    }

    // --- 3. Resolve the frozen revision and refuse, never repair, on drift.
    const revision = await repos.contractRevisions.findById(run.contractRevisionId);
    if (!revision) {
      throw new RelayDomainError(`ContractRevision ${run.contractRevisionId} not found`, 'NOT_FOUND');
    }
    if (!revision.isApproved()) {
      throw new RelayDomainError(
        `ContractRevision ${revision.id} is not approved; execution requires approved intent`,
        'CONTRACT_NOT_APPROVED',
      );
    }
    // Invariant 7: the run stays bound to exactly the intent it was created for.
    run.assertBindingIntact(revision);

    // --- 4. Ordinal-ordered units. Creation invariant: at least one.
    const units = await repos.workUnits.findByContractRevisionId(run.contractRevisionId);
    if (units.length === 0) {
      throw new RelayDomainError(
        `ContractRevision ${run.contractRevisionId} has no work units`,
        'INVALID_STATE',
      );
    }

    // --- 5/6. Derive the current unit. No stored cursor exists.
    const inFlight = units.find((u) => u.status === 'in_progress');
    if (inFlight) {
      if (!inFlight.assignmentId) {
        // Torn state: in_progress with no assignment. Fail closed rather than fabricate.
        throw new RelayDomainError(
          `WorkUnit ${inFlight.id} is in_progress with no bound assignment`,
          'INVALID_STATE',
        );
      }
      const current = await repos.assignments.findById(inFlight.assignmentId);
      if (!current) {
        throw new RelayDomainError(
          `Assignment ${inFlight.assignmentId} for WorkUnit ${inFlight.id} not found`,
          'INVALID_STATE',
        );
      }
      const attempt = current.currentAttemptId
        ? await repos.attempts.findById(current.currentAttemptId)
        : null;

      // Selected but not yet dispatched: the durable-intent commit did not happen.
      if (!attempt) return this.dispatchPlanFirstUnit(run, inFlight);

      if (attempt.status === 'completed_physical') {
        return this.verifyPlanFirstUnit(run, inFlight, current, attempt, units);
      }
      if (attempt.status === 'interrupted') {
        return this.reconcileInterruptedPlanFirstUnit(run, inFlight, current, attempt);
      }
      // prepared | running: dispatch in flight or executing. Re-inspect, never re-dispatch.
      return this.reconcileInFlightPlanFirstUnit(run, inFlight, current, attempt);
    }

    // --- 7. A blocked unit stops the engine. It must NOT self-declare failure.
    const blockedUnits = units.filter((u) => u.status === 'blocked');
    if (blockedUnits.length > 0) {
      if (run.status !== 'blocked') {
        await repos.runInTransaction(async () => {
          run.block();
          await repos.planFirstRuns.save(run);
          await this.emitEvent('project', run.projectId, 'plan_first_run.blocked', {
            actor: 'engine',
            previousState: 'running',
            newState: 'blocked',
            correlationId: run.id,
            details: { reason: 'work_unit_blocked', workUnitId: blockedUnits[0].id },
          });
        });
      }
      return {
        transition: 'blocked_awaiting_planner',
        runId: run.id,
        workUnitId: blockedUnits[0].id,
        plannerUpdateRequired: true,
        blocker: 'verification_blocked',
      };
    }

    // --- 8. All prior units completed: select the next by ordinal.
    const target = units.find((u) => u.status === 'pending');
    if (!target) {
      await repos.runInTransaction(async () => {
        run.complete();
        await repos.planFirstRuns.save(run);
        await this.emitEvent('project', run.projectId, 'plan_first_run.completed', {
          actor: 'engine',
          previousState: 'running',
          newState: 'completed',
          correlationId: run.id,
        });
      });
      // Invariant 1: nothing re-dispatches.
      return { transition: 'run_completed', runId: run.id, plannerUpdateRequired: false };
    }

    // Transaction 1: unit selection + assignment creation, atomically. A crash between
    // them would either lose the dispatch record (re-dispatch hazard) or strand a unit
    // with no assignment.
    const selected = await repos.runInTransaction(async () => {
      // Re-read: a concurrent tick may have won the race.
      const fresh = await repos.workUnits.findById(target.id);
      if (!fresh || fresh.status !== 'pending') return null;

      const assignment = Assignment.create(
        run.sessionPairId,
        run.projectId,
        target.objective,
        target.instruction,
      );
      await repos.assignments.save(assignment);

      fresh.startExecution(assignment.id);
      await repos.workUnits.save(fresh);

      // Selecting a unit puts the run in `running` from EITHER `ready` or `blocked`
      // (§C.1). An already-`running` run is left alone: selecting a later unit is the
      // frozen `running -> running` self-transition of §C.1, not a fresh start, and
      // `start()` is correctly guarded to reject `running -> running`.
      if (run.status !== 'running') run.start();
      await repos.planFirstRuns.save(run);

      return { unit: fresh, assignment };
    });

    if (!selected) {
      // Lost the race; the winning tick owns the unit.
      return {
        transition: 'selection_raced',
        runId: run.id,
        workUnitId: target.id,
        plannerUpdateRequired: false,
      };
    }

    await this.emitEvent('assignment', selected.assignment.id, 'plan_first.unit_selected', {
      actor: 'engine',
      previousState: 'pending',
      newState: 'in_progress',
      correlationId: run.id,
      details: {
        workUnitId: selected.unit.id,
        ordinal: selected.unit.ordinal,
        contractRevisionId: run.contractRevisionId,
      },
    });

    return this.dispatchPlanFirstUnit(run, selected.unit);
  }

  /**
   * §G step 9 — dispatch the unit's ONE assignment through the established production path.
   *
   * This method NEVER constructs an Attempt. `dispatchAssignment()` is the single authority
   * for Attempt creation, which is what makes "exactly one Attempt per WorkUnit execution"
   * structural rather than a convention.
   */
  private async dispatchPlanFirstUnit(run: PlanFirstRun, unit: WorkUnit): Promise<PlanFirstTickResult> {
    const repos = this.repos;

    // Invariant 9: a missing worker runtime suspends execution, it never fabricates.
    const pair = await repos.pairs.findById(run.sessionPairId);
    if (!pair || !pair.workerSessionId) {
      await this.raisePlanFirstAttention(
        run,
        unit,
        'critical',
        'plan_first_no_worker_bound',
        'Plan-First worker runtime unavailable',
        `Run ${run.id} cannot dispatch WorkUnit ${unit.id}: pair ${run.sessionPairId} has no ` +
          'bound worker runtime. Execution is suspended; no dispatch was attempted.',
        'pair_worker_binding',
      );
      // Unit status is deliberately unchanged: the selection record and its attempt
      // history are retained (PLAN_FIRST_DOMAIN_FREEZE.md §C.1, no `suspended` run state).
      return {
        transition: 'dispatch_suspended',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: unit.assignmentId ?? undefined,
        plannerUpdateRequired: true,
        blocker: 'no_worker_runtime',
      };
    }

    const current = await repos.assignments.findById(unit.assignmentId!);
    if (!current) {
      throw new RelayDomainError(
        `Assignment ${unit.assignmentId} for WorkUnit ${unit.id} not found`,
        'INVALID_STATE',
      );
    }

    // Existing deliveries decide whether dispatch is legal at all. No blind resend.
    const existing = await repos.deliveries.findByAssignmentId(current.id);
    if (existing.some((d) => d.status === 'ambiguous')) {
      await this.blockPlanFirstUnit(run, unit, current, 'ambiguous_delivery', 'dispatch_ambiguous');
      return {
        transition: 'dispatch_ambiguous',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: current.id,
        plannerUpdateRequired: true,
        blocker: 'ambiguous_delivery',
      };
    }
    if (existing.some((d) => d.status === 'delivering')) {
      // Crash-equivalent: intent is durable, acknowledgement unknown. Reconcile, do not
      // resend.
      return {
        transition: 'dispatch_in_flight',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: current.id,
        plannerUpdateRequired: false,
      };
    }

    let dispatched: { assignment: Assignment; attempt: Attempt; delivery: Delivery };
    try {
      dispatched = await this.dispatchAssignment(current.id);
    } catch (err) {
      if (err instanceof RuntimeNotAvailableError) {
        // Invariant 9: suspend rather than corrupt run state. The durable intent and the
        // prepared Attempt already committed inside dispatchAssignment Phase 1.
        await this.raisePlanFirstAttention(
          run,
          unit,
          'warning',
          'plan_first_runtime_unavailable',
          'Plan-First worker runtime unavailable',
          `Dispatch of WorkUnit ${unit.id} could not proceed: ${err.message}. The prepared ` +
            'attempt and its dispatch intent remain durable; execution is suspended.',
          'recover_runtime',
        );
        return {
          transition: 'dispatch_suspended',
          runId: run.id,
          workUnitId: unit.id,
          assignmentId: current.id,
          plannerUpdateRequired: true,
          blocker: 'runtime_unavailable',
        };
      }
      throw err;
    }

    const { assignment, attempt, delivery } = dispatched;

    if (delivery.status === 'delivered') {
      return this.verifyPlanFirstUnit(run, unit, assignment, attempt, null);
    }

    if (delivery.status === 'ambiguous') {
      await this.blockPlanFirstUnit(run, unit, assignment, 'ambiguous_delivery', 'dispatch_ambiguous');
      return {
        transition: 'dispatch_ambiguous',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: assignment.id,
        attemptId: attempt.id,
        plannerUpdateRequired: true,
        blocker: 'ambiguous_delivery',
      };
    }

    // delivery.status === 'failed' — confirmed NOT delivered, so no physical execution
    // occurred and re-dispatch is safe. The assignment binding is RETAINED as the
    // historical record of the failed attempt.
    await repos.runInTransaction(async () => {
      const fresh = await repos.workUnits.findById(unit.id);
      if (fresh) {
        fresh.returnToPending();
        await repos.workUnits.save(fresh);
      }
    });
    return {
      transition: 'dispatch_not_delivered',
      runId: run.id,
      workUnitId: unit.id,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      plannerUpdateRequired: false,
      blocker: 'delivery_failed',
    };
  }

  /**
   * §G step 10 — the ONLY path to `WorkUnit.completed`.
   *
   * The idempotency guard is load-bearing: a crash between "VerificationResult written" and
   * "unit completed" leaves the attempt `completed_physical` with a result already present,
   * and §G step 6 routes back here on restart. Verification therefore RESUMES from the
   * persisted result; it never re-evaluates and never double-inserts.
   */
  private async verifyPlanFirstUnit(
    run: PlanFirstRun,
    unit: WorkUnit,
    assignment: Assignment,
    attempt: Attempt,
    units: WorkUnit[] | null,
  ): Promise<PlanFirstTickResult> {
    const repos = this.repos;
    const revision = await repos.contractRevisions.findById(run.contractRevisionId);
    if (!revision) {
      throw new RelayDomainError(`ContractRevision ${run.contractRevisionId} not found`, 'NOT_FOUND');
    }

    // §G step 6 makes `completed_physical` the gate for verification, and §H Boundary 1
    // requires a freshly delivered attempt to remain `running` on the dispatch tick. A
    // confirmed delivery only means the instruction ARRIVED; physical execution is still
    // in progress, so there is nothing to verify yet. This is the one path that observes
    // the attempt after dispatchAssignment, so the guard lives here.
    if (attempt.status !== 'completed_physical') {
      return {
        transition: 'dispatch_in_flight',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: assignment.id,
        attemptId: attempt.id,
        plannerUpdateRequired: false,
      };
    }

    const existing = await repos.verificationResults.findByAttemptId(attempt.id);
    let outcome: { outcome: 'passed' | 'failed' | 'blocked' | 'not_run'; checkId?: string; evidence?: Record<string, unknown> };
    let insertResult: boolean;
    if (existing) {
      // Resume, never re-run.
      outcome = {
        outcome: existing.result,
        checkId: existing.checkId,
        evidence: existing.evidence,
      };
      insertResult = false;
    } else {
      outcome = await this.planFirstVerification.evaluate({ attempt, revision, unit });
      insertResult = true;
    }

    const passed = outcome.outcome === 'passed';

    // Transaction 2: verification result + unit completion + assignment resolution are one
    // atomic unit. The run's terminal state is decided INSIDE the same transaction.
    const result = await repos.runInTransaction(async () => {
      if (insertResult) {
        const now = Date.now();
        await repos.verificationResults.save({
          id: createId('verif'),
          attemptId: attempt.id,
          checkId: outcome.checkId,
          result: outcome.outcome,
          evidence: outcome.evidence,
          createdAt: now,
          updatedAt: now,
        });
      }

      const fresh = await repos.workUnits.findById(unit.id);
      if (!fresh) {
        throw new RelayDomainError(`WorkUnit ${unit.id} not found`, 'NOT_FOUND');
      }

      if (passed) {
        // attempt stays `completed_physical`. Verification does NOT mutate physical state.
        fresh.accept();
        await repos.workUnits.save(fresh);

        assignment.complete();
        await repos.assignments.save(assignment);

        // Completion is decided from freshly persisted state, never from the stale list.
        const all = await repos.workUnits.findByContractRevisionId(run.contractRevisionId);
        const remaining = all.filter((u) => u.status === 'pending');
        if (remaining.length === 0) run.complete();
        await repos.planFirstRuns.save(run);
        return { remaining: remaining.length };
      }

      fresh.block();
      await repos.workUnits.save(fresh);
      run.block();
      await repos.planFirstRuns.save(run);
      return { remaining: -1 };
    });

    if (passed) {
      await this.emitEvent('assignment', assignment.id, 'plan_first.unit_completed', {
        actor: 'engine',
        previousState: 'in_progress',
        newState: 'completed',
        correlationId: run.id,
        details: {
          workUnitId: unit.id,
          attemptId: attempt.id,
          verificationResult: outcome.outcome,
          checkId: outcome.checkId ?? null,
          resumed: !insertResult,
        },
      });
      const runCompleted = result.remaining === 0;
      return {
        transition: runCompleted ? 'run_completed' : 'work_unit_completed',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: assignment.id,
        attemptId: attempt.id,
        plannerUpdateRequired: false,
      };
    }

    // The Assignment stays `unresolved`. The engine never auto-fails it.
    await this.raisePlanFirstAttention(
      run,
      unit,
      'warning',
      'plan_first_verification_blocked',
      'Plan-First verification did not pass',
      `WorkUnit ${unit.id} (ordinal ${unit.ordinal}) produced verification outcome ` +
        `'${outcome.outcome}' for attempt ${attempt.id}. The attempt remains ` +
        "`completed_physical` and the assignment remains unresolved. A planner or human " +
        'must resolve before further execution.',
      'plan_first_review',
      assignment.id,
    );
    return {
      transition: 'verification_failed',
      runId: run.id,
      workUnitId: unit.id,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      plannerUpdateRequired: true,
      blocker: 'verification_failed',
    };
  }

  /**
   * §G step 6, `interrupted` branch — the runtime was lost mid-work.
   *
   * Per §C.2 the unit status is deliberately UNCHANGED so the attempt is retained, and per
   * §C.1 there is no run-level `suspended` state: suspension lives at the Attempt plus an
   * AttentionItem. Repository mutations performed before the interruption are NOT rolled
   * back (ATTEMPT_LIFECYCLE.md Case 5).
   */
  private async reconcileInterruptedPlanFirstUnit(
    run: PlanFirstRun,
    unit: WorkUnit,
    assignment: Assignment,
    attempt: Attempt,
  ): Promise<PlanFirstTickResult> {
    const pair = await this.repos.pairs.findById(run.sessionPairId);
    let workerPresent = false;
    if (pair?.workerSessionId) {
      const worker = await this.repos.runtimes.findById(pair.workerSessionId);
      workerPresent = worker !== null && worker.status !== 'terminated';
    }
    if (!workerPresent) {
      await this.raisePlanFirstAttention(
        run,
        unit,
        'warning',
        'plan_first_attempt_interrupted',
        'Plan-First attempt interrupted',
        `Attempt ${attempt.id} for WorkUnit ${unit.id} was interrupted and the bound worker ` +
          'runtime is still unavailable. Repository mutations made before the interruption ' +
          'are retained. No work is re-dispatched automatically.',
        'recover_runtime',
        assignment.id,
      );
    }
    return {
      transition: 'attempt_interrupted',
      runId: run.id,
      workUnitId: unit.id,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      plannerUpdateRequired: true,
      blocker: 'attempt_interrupted',
    };
  }

  /**
   * §G step 6, `prepared | running` branch — dispatch in flight or executing.
   *
   * Re-inspect the worker and record the observation. Crucially this NEVER advances the
   * unit: completion may only come from a `VerificationResult` with `result === 'passed'`,
   * and provider UI is explicitly not admissible evidence of correctness (§D.3).
   */
  private async reconcileInFlightPlanFirstUnit(
    run: PlanFirstRun,
    unit: WorkUnit,
    assignment: Assignment,
    attempt: Attempt,
  ): Promise<PlanFirstTickResult> {
    const pair = await this.repos.pairs.findById(run.sessionPairId);
    if (pair?.workerSessionId) {
      const worker = await this.repos.runtimes.findById(pair.workerSessionId);
      if (worker) {
        try {
          const working = await this.getProvider(worker.providerType).detectWorkingState(worker.id);
          // Observation only. It is recorded on the runtime and never promotes a WorkUnit.
          worker.recordObservationSuccess(working.isWorking ? 'working' : 'available', working.evidence);
          await this.repos.runtimes.save(worker);
          await this.emitEvent('attempt', attempt.id, 'plan_first.dispatch_in_flight', {
            actor: 'reconciler',
            newState: attempt.status,
            correlationId: run.id,
            details: { workUnitId: unit.id, isWorking: working.isWorking },
          });
        } catch {
          // Inspection is best-effort; an unavailable provider must not advance state.
        }
      }
    }
    return {
      transition: 'dispatch_in_flight',
      runId: run.id,
      workUnitId: unit.id,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      plannerUpdateRequired: false,
    };
  }

  /**
   * Transaction 3: unit `blocked` + run `blocked` + AttentionItem, atomically.
   */
  private async blockPlanFirstUnit(
    run: PlanFirstRun,
    unit: WorkUnit,
    assignment: Assignment,
    attentionType: string,
    blocker: string,
  ): Promise<void> {
    const repos = this.repos;
    await repos.runInTransaction(async () => {
      const fresh = await repos.workUnits.findById(unit.id);
      if (fresh && fresh.status === 'in_progress') {
        fresh.block();
        await repos.workUnits.save(fresh);
      }
      const freshRun = await repos.planFirstRuns.findById(run.id);
      if (freshRun && freshRun.status === 'running') {
        freshRun.block();
        await repos.planFirstRuns.save(freshRun);
        run.status = freshRun.status;
        run.updatedAt = freshRun.updatedAt;
      }
      const item = AttentionItem.create(
        'critical',
        attentionType,
        'Plan-First delivery requires reconciliation',
        `WorkUnit ${unit.id} (ordinal ${unit.ordinal}) cannot be dispatched automatically: ` +
          `${blocker}. RelayX never resends an ambiguous delivery automatically.`,
        { pairId: run.sessionPairId, assignmentId: assignment.id, suggestedAction: 'reconcile_delivery' },
      );
      await repos.attention.save(item);
    });
  }

  private async raisePlanFirstAttention(
    run: PlanFirstRun,
    unit: WorkUnit,
    severity: 'info' | 'warning' | 'critical',
    type: string,
    title: string,
    message: string,
    suggestedAction: string,
    assignmentId?: AssignmentId,
  ): Promise<void> {
    await this.repos.attention.save(
      AttentionItem.create(severity, type, title, message, {
        pairId: run.sessionPairId,
        assignmentId: assignmentId ?? unit.assignmentId ?? undefined,
        suggestedAction,
      }),
    );
  }
}

export type PlanFirstTickTransition =
  | 'run_terminal'
  | 'run_completed'
  | 'work_unit_completed'
  | 'verification_failed'
  | 'blocked_awaiting_planner'
  | 'dispatch_in_flight'
  | 'dispatch_suspended'
  | 'dispatch_not_delivered'
  | 'dispatch_ambiguous'
  | 'attempt_interrupted'
  | 'selection_raced';

export interface PlanFirstTickResult {
  transition: PlanFirstTickTransition;
  runId: string;
  workUnitId?: string;
  assignmentId?: string;
  attemptId?: string;
  plannerUpdateRequired: boolean;
  blocker?: string;
}
