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

export class RelayEngine {
  private readonly providers: Map<ProviderType, IRuntimeProvider> = new Map();
  private isSupervising = false;

  constructor(public readonly repos: IRelayRepositories) {}

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
   * Invariant: Repeated discovery updates the existing runtime rather than creating duplicates.
   */
  public async discoverRuntime(
    providerType: ProviderType,
    descriptor?: RuntimeTargetDescriptor,
  ): Promise<{ runtime: RuntimeSession; inspection: RuntimeInspectionResult; isNew: boolean }> {
    const provider = this.getProvider(providerType);
    const targetDescriptor = descriptor ?? { providerType };
    const inspection = await provider.findRuntime(targetDescriptor);

    const existingRuntimes = await this.repos.runtimes.findAll();
    const existing = existingRuntimes.find((r) => {
      if (r.providerType !== providerType) return false;
      if (inspection.applicationPid && r.applicationPid === inspection.applicationPid) return true;
      if (targetDescriptor.bundleIdentifier && r.bundleIdentifier === targetDescriptor.bundleIdentifier) return true;
      return true;
    });

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
      // Authoritative persistence of external provider identity at discovery boundary
      const det = (inspection.evidence?.details || {}) as any;
      const extId = det.authoritativeSessionId || det.parsedSessionId || (det.openCodeProjectId ? det.openCodeProjectId : undefined);
      if (extId && existing.externalSessionId !== extId) {
        const projRef = providerType === 'opencode' ? det.workspacePath || existing.externalProjectRef : (det.projectUrl || det.projectName || existing.externalProjectRef);
        existing.updateExternalIdentity(extId, projRef ?? existing.externalProjectRef ?? null);
      }
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
    // Persist authoritative external identity at creation boundary
    const det = (inspection.evidence?.details || {}) as any;
    const extId = det.authoritativeSessionId || det.parsedSessionId || (det.openCodeProjectId ? det.openCodeProjectId : undefined);
    if (extId) {
      const projRef = providerType === 'opencode' ? det.workspacePath || null : (det.projectUrl || det.projectName || null);
      runtime.updateExternalIdentity(extId, projRef);
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
    }
    if (workerSessionId) {
      const worker = await this.repos.runtimes.findById(workerSessionId);
      if (!worker) throw new RelayDomainError('Worker runtime not found', 'RUNTIME_NOT_FOUND');
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
    }
    if (updates.workerSessionId) {
      const worker = await this.repos.runtimes.findById(updates.workerSessionId);
      if (!worker) throw new RelayDomainError('New worker runtime not found', 'RUNTIME_NOT_FOUND');
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
    return this.repos.runInTransaction(async () => {
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

      // Create new attempt
      const attempts = await this.repos.attempts.findByAssignmentId(assignment.id);
      const attemptNumber = attempts.length + 1;
      const attempt = Attempt.create(assignment.id, attemptNumber);
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

      // Execute delivery via Provider
      const provider = this.getProvider(worker.providerType);
      const result = await provider.deliverInstruction({
        runtimeSessionId: worker.id,
        instructionText: assignment.instruction,
        idempotencyKey,
      });

      if (result.outcome === 'delivered') {
        // Confirmed delivered via verified evidence
        delivery.confirmDelivered(result.evidence);
        await this.repos.deliveries.save(delivery);

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
        // Failed
        delivery.markFailed(result.reason ?? 'Delivery failed', result.evidence);
        await this.repos.deliveries.save(delivery);

        attempt.fail(result.reason ?? 'Delivery failed', result.evidence);
        await this.repos.attempts.save(attempt);

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
        attempt.complete();
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
}
