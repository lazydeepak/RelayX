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
  PairSideRole,
  PairSideIdentity,
  PairActivationResult,
  PAIR_SIDE_ROLES,
  NO_IDENTITY_CAPABILITY,
  RuntimePairGovernance,
  RUNTIME_PAIR_NOT_ACTIVE,
  RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS,
  SideObservationReading,
  SideObservationResult,
  SideObservationOutcome,
  NO_OBSERVATION_CAPABILITY,
  PROVISIONAL_OBSERVATION_VALIDITY_MS,
  PairSideCheckpoint,
  PairSideCheckpointId,
  PairContinuityResult,
  CHECKPOINT_BASELINE_ALREADY_EXISTS,
  CHECKPOINT_BASELINE_REQUIRED,
  CHECKPOINT_OBSERVATION_REQUIRED,
} from '../domain/types.ts';
import {
  evaluateSideContinuity,
  classifyPairContinuity,
} from '../domain/continuity.ts';
import {
  evaluatePairReadiness,
  PairReadinessAssessment,
} from '../domain/readiness.ts';
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

/** How a stranded dispatch intent was resolved. */
export type DispatchReconciliationDispositionName =
  | 'delivered_confirmed'
  | 'not_delivered_confirmed'
  | 'ambiguous_raised';

export interface DispatchReconciliationDispositionRecord {
  deliveryId: DeliveryId;
  attemptId: AttemptId;
  assignmentId: AssignmentId;
  disposition: DispatchReconciliationDispositionName;
  attentionItemId?: AttentionItemId;
}

export interface DispatchReconciliationReport {
  examined: number;
  deliveredConfirmed: number;
  notDeliveredConfirmed: number;
  ambiguousRaised: number;
  dispositions: DispatchReconciliationDispositionRecord[];
}

/**
 * The provider's answer about a stranded dispatch, normalized to three cases.
 *
 * `insufficient` deliberately covers EVERY non-authoritative answer, including a
 * missing hook, an unregistered provider, and a thrown probe. A provider that cannot
 * answer has not thereby proven anything, so an unresolved durable dispatch intent
 * stays unresolved and becomes operator-visible rather than silently persisting.
 */
type DispatchProbeOutcome =
  | { kind: 'delivered'; evidence: ObservableEvidence; reason?: string }
  | { kind: 'not_delivered'; evidence?: ObservableEvidence; reason?: string }
  | { kind: 'insufficient'; reason: string; evidence?: ObservableEvidence };

/**
 * The truthful result of an attempt to deliver a handoff to the Planner.
 *
 * The external-effect invariant (S1) requires that no durable record assert an
 * external effect merely because RelayX intended one. The Handoff aggregate
 * carries no "attempted" or "unverified" status, so the unverified outcome is
 * reported here and durably recorded as a `planner.delivery.unverified` event,
 * rather than by inventing a second Handoff lifecycle.
 *
 * `externally_confirmed` is declared but has no construction path in S1: it
 * requires an exact Planner transport (S11) that returns provider evidence. It
 * exists so the future success path is typed, not so it can be assumed.
 */
export type PlannerDeliveryAttempt =
  | {
      /** The handoff, unchanged. */
      handoff: Handoff;
      outcome: 'unverified';
      reason: string;
      /** Always false in S1: no external contact is possible at all. */
      externalContactAttempted: false;
    }
  | {
      handoff: Handoff;
      outcome: 'externally_confirmed';
      evidence: ObservableEvidence;
      externalContactAttempted: true;
    };

/**
 * A compact, event-safe projection of one side. Only tri-state facts and the
 * mandatory dimensions 8/9 travel into the audit stream, so an event can never
 * imply a verification that did not happen (§5.2, §5.3, I-6).
 */
function summariseSide(side: PairSideIdentity): Record<string, unknown> {
  return {
    sideRole: side.sideRole,
    providerType: side.providerType,
    identityState: side.identityState,
    verificationState: side.verificationState,
    existenceState: side.existenceState,
    capability: side.capability,
    sourceCapability: side.sourceCapability,
    observedAt: side.observedAt,
    reason: side.reason,
  };
}

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

  /**
   * S6 CLOSURE — unarchive is a LOCAL record change plus a best-effort re-check.
   *
   * The local part (unarchive the row, emit `runtime.updated`) is performed FIRST
   * and unconditionally, because archiving and unarchiving are established
   * standalone runtime operations that exist independently of any Pair. Gating the
   * whole method on Pair state would make an IDLE Pair's runtime permanently
   * un-unarchivable, which is Case C's failure mode.
   *
   * The provider re-check that follows is the part that must obey I-2, and it is
   * gated by `reconcileAndRecoverRuntime` through the single shared guard.
   *
   * ## A refusal here is a PARTIAL result, and is reported as one
   *
   * The local unarchive has already been committed when the gate refuses. Throwing
   * the gate's own message verbatim would imply the unarchive failed, which would be
   * false — a caller that retried, or that rendered the row as still archived, would
   * be acting on a misreport. So the refusal is re-thrown with the SAME machine
   * code (callers still classify on it) and a message that states what did and did
   * not happen. The Pair is not activated, and no provider was contacted.
   */
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

    // Immediate re-check of the real external session.
    //
    // I-2 GATE: the re-check is provider contact, and `reconcileAndRecoverRuntime`
    // refuses it for a Pair that is IDLE. That refusal MUST NOT be swallowed.
    // A bare catch here would turn the gate into a silent no-op: the unarchive
    // would report success while quietly contacting nothing, which is the exact
    // dishonesty I-2 exists to prevent. The refusal is re-thrown so the caller
    // learns the Pair must be activated first; any other failure stays
    // best-effort, because unarchiving is a local record change and its own
    // success does not depend on the external re-check succeeding.
    //
    // BOTH denial codes are re-thrown, including the fail-closed ambiguous-ownership
    // refusal. Swallowing that one would be worse than swallowing the IDLE case: it
    // would mean silently proceeding with no defensible owner.
    try {
      await this.reconcileAndRecoverRuntime(id);
    } catch (err: any) {
      const code = err?.code;
      if (code === RUNTIME_PAIR_NOT_ACTIVE || code === RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS) {
        throw new RelayDomainError(
          `Runtime ${id} was unarchived locally, but its external re-check was refused: ` +
            `${err.message} The unarchive is saved; the external state remains last-known evidence only, ` +
            'and the Pair was NOT activated.',
          code,
        );
      }
      // ignore: best-effort external re-check
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
    // NOTE: pre-dispatch reconciliation is deliberately NOT done here.
    //
    // `dispatchAssignment` is the generic send primitive, and T6 in core_slice1 pins its
    // contract: given a stranded `delivering` record, it MUST refuse with
    // DuplicateDeliveryAttemptError and MUST NOT call the provider. Reconciling inline
    // would rewrite that record to a terminal state first and change a pinned contract.
    //
    // Reconciliation instead runs at the two points where new work is actually selected:
    // `recoverOnStartup` (before any runtime observation) and `dispatchPlanFirstUnit`
    // (before a Plan-First unit is sent). Both are engine-level, not controller-level.

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

      // I-2 GATE — ARMED (S6). §11.5: every provider contact is gated on
      // `operational_state === 'ACTIVE'`, and this is the single enforcement point.
      // The check sits at the top of the Phase-1 transaction, BEFORE any durable
      // dispatch intent is written, so a refused dispatch leaves no partial record.
      pair.assertProviderContactPermitted();

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
      externalSessionId: worker.externalSessionId ?? null,
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
  /**
   * I-2 GATE — ARMED (S6). §11.5 / §4.3: an IDLE Pair receives zero provider
   * contact, so the tick skips it entirely rather than inspecting it. The skip is
   * placed before `getProvider(...)` and before `inspectRuntime`.
   *
   * Gating this tick also gates `startSupervisionLoop`, which only schedules this
   * method. Note the tick's non-provider work below (ambiguous-delivery attention
   * items) reads only RelayX's own database and still runs for every Pair — I-2
   * forbids provider contact, not local bookkeeping.
   */
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

        if (!pair.isProviderContactPermitted()) continue;
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
   * The outcome of an attempt to deliver a handoff to the Planner.
   *
   * `externally_confirmed` is unreachable in S1 and is deliberately declared, so
   * that the only way to obtain it is a future exact Planner transport (S11)
   * returning provider evidence. There is no other construction path.
   */
  public async attemptPlannerDelivery(handoffId: HandoffId): Promise<PlannerDeliveryAttempt> {
    const handoff = await this.repos.handoffs.findById(handoffId);
    if (!handoff) throw new RelayDomainError(`Handoff ${handoffId} not found`, 'NOT_FOUND');

    const assignment = await this.repos.assignments.findById(handoff.assignmentId);
    if (!assignment) throw new RelayDomainError(`Assignment ${handoff.assignmentId} not found`, 'NOT_FOUND');

    const pair = await this.repos.pairs.findById(assignment.pairId);
    if (pair && pair.plannerSessionId) {
      const plannerSession = await this.repos.runtimes.findById(pair.plannerSessionId);
      if (plannerSession && plannerSession.externalSessionId) {
        try {
          const provider = this.getProvider(plannerSession.providerType);
          const deliveryResult = await provider.deliverInstruction({
            runtimeSessionId: plannerSession.id,
            externalSessionId: plannerSession.externalSessionId,
            instructionText: `Handoff result for assignment: ${handoff.resultSummary}`,
            idempotencyKey: `planner_delivery_${handoff.id}_${Date.now()}`,
          });

          if (deliveryResult.outcome === 'delivered' && deliveryResult.evidence) {
            handoff.markDeliveredToPlanner(deliveryResult.evidence);
            await this.repos.handoffs.save(handoff);

            await this.emitEvent('handoff', handoff.id, 'planner.delivery.confirmed', {
              actor: 'engine',
              previousState: 'ready',
              newState: 'delivered',
              details: {
                outcome: 'externally_confirmed',
                externalContactAttempted: true,
                externalSessionId: plannerSession.externalSessionId,
                evidenceId: deliveryResult.evidence.id,
              },
            });

            return {
              handoff,
              outcome: 'externally_confirmed',
              evidence: deliveryResult.evidence,
              externalContactAttempted: true,
            };
          } else {
            const reason = `Planner delivery transport attempted but failed or was ambiguous: ${deliveryResult.reason || deliveryResult.outcome}`;
            await this.emitEvent('handoff', handoff.id, 'planner.delivery.unverified', {
              actor: 'engine',
              previousState: handoff.status,
              newState: handoff.status,
              details: { outcome: 'unverified', externalContactAttempted: true, reason },
            });
            return {
              handoff,
              outcome: 'unverified',
              reason,
              externalContactAttempted: true,
            };
          }
        } catch (err: any) {
          const reason = `Planner delivery transport encountered error: ${err?.message || String(err)}`;
          await this.emitEvent('handoff', handoff.id, 'planner.delivery.unverified', {
            actor: 'engine',
            previousState: handoff.status,
            newState: handoff.status,
            details: { outcome: 'unverified', externalContactAttempted: true, reason },
          });
          return {
            handoff,
            outcome: 'unverified',
            reason,
            externalContactAttempted: false,
          };
        }
      }
    }

    const attempt: PlannerDeliveryAttempt = {
      handoff,
      outcome: 'unverified',
      reason:
        'Exact Planner conversation transport requires a bound Planner RuntimeSession with an authoritative external session ID (`externalSessionId`). None found for this handoff pair.',
      externalContactAttempted: false,
    };

    await this.emitEvent('handoff', handoff.id, 'planner.delivery.unverified', {
      actor: 'engine',
      previousState: handoff.status,
      newState: handoff.status,
      details: {
        outcome: attempt.outcome,
        externalContactAttempted: attempt.externalContactAttempted,
        providerCapability: 'none',
        reason: attempt.reason,
      },
    });

    return attempt;
  }

  /**
   * @deprecated Retained only for API compatibility. Use
   * {@link attemptPlannerDelivery}, which reports a truthful outcome instead of
   * throwing.
   *
   * This method previously recorded the handoff as delivered to the Planner and
   * emitted `planner.notified` while contacting nothing at all
   * (DESIGN_FREEZE §9.4.1). That was an evidence-integrity defect: durable state
   * asserted an external effect that never happened. It is now fenced — it
   * contacts no provider, marks no external delivery, and emits no
   * externally-confirming event — and it rejects so that a caller which
   * discards the return value cannot read success as "the Planner was told".
   *
   * Invariant 6 is unchanged and still holds: handoff completion does not
   * complete an assignment.
   */
  public async deliverHandoffToPlanner(handoffId: HandoffId): Promise<Handoff> {
    const attempt = await this.attemptPlannerDelivery(handoffId);
    if (attempt.outcome === 'externally_confirmed') return attempt.handoff;
    throw new RelayDomainError(
      `Handoff ${handoffId} was NOT delivered to the Planner: ${attempt.reason}`,
      'PLANNER_DELIVERY_UNSUPPORTED',
    );
  }

  public async completeHandoff(handoffId: HandoffId): Promise<Handoff> {
    const handoff = await this.repos.handoffs.findById(handoffId);
    if (!handoff) throw new RelayDomainError(`Handoff ${handoffId} not found`, 'NOT_FOUND');

    // Recorded BEFORE the transition. This used to be the hardcoded literal
    // 'delivered', which wrote an assertion that the Planner had been notified
    // into the audit stream for handoffs that were never delivered at all — the
    // same evidence-integrity defect as `planner.notified` (DESIGN_FREEZE §9.4.1).
    const previousStatus = handoff.status;
    handoff.completeHandoff();
    await this.repos.handoffs.save(handoff);

    await this.emitEvent('handoff', handoff.id, 'handoff.complete', {
      actor: 'engine',
      previousState: previousStatus,
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

  /**
   * S6 CLOSURE — the ONE authoritative runtime -> Pair ownership resolution.
   *
   * ## Why this is a single public method rather than two private checks
   *
   * Two runtime-addressed provider operations existed with two *different* ad-hoc
   * resolutions, and the one on the service side had no resolution at all. That
   * asymmetry is precisely how the hole opened. Routing every runtime-addressed
   * provider operation through this one method is the enforcement architecture:
   *
   * ```
   * provider operation requested (by RuntimeSessionId)
   *          ↓
   *   resolveRuntimePairGovernance()
   *          ↓
   *   unpaired ─────→ standalone runtime semantics (no Pair to govern)
   *        │ paired (exactly one)
   *   ambiguous ─────→ DENY, fail closed, never pick a candidate
   *        │ paired
   *      operationalState
   *     ↙              ↘
   *  IDLE                ACTIVE
   *   ↓                     ↓
   *  DENY                continue
   * ```
   *
   * ## The ownership source
   *
   * `IPairRepository.findByRuntimeSessionId` — the durable binding columns
   * `planner_session_id` / `worker_session_id`, compared by runtime session id.
   * Never a title, a project name, a workspace basename, a lifecycle `status`, or
   * the frontmost window (I-11).
   *
   * ## What it does NOT do
   *
   * It never activates anything, never repairs a binding, and never infers an owner
   * from a heuristic. It is a read and a decision, nothing else.
   */
  public async resolveRuntimePairGovernance(
    runtimeSessionId: RuntimeSessionId,
  ): Promise<RuntimePairGovernance> {
    const owners = await this.repos.pairs.findByRuntimeSessionId(runtimeSessionId);

    if (owners.length === 0) return { kind: 'unpaired' };
    if (owners.length === 1) {
      const pair = owners[0];
      // Read the state THROUGH the entity's own accessors, never off a raw row,
      // so `isProviderContactPermitted()` remains the single I-2 decision point.
      return {
        kind: 'paired',
        pairId: pair.id,
        operationalState: pair.isProviderContactPermitted() ? 'ACTIVE' : pair.operationalState,
      };
    }
    return { kind: 'ambiguous', pairIds: owners.map((p) => p.id) };
  }

  /**
   * S6 CLOSURE — the enforcement half of `resolveRuntimePairGovernance`.
   *
   * Every runtime-addressed provider operation calls this immediately before
   * touching a provider. It throws for the two deny cases and returns the
   * governance for the two allow cases, so the caller can distinguish "allowed
   * because unpaired" from "allowed because ACTIVE" — a distinction that matters
   * for truthful reporting, and that a bare `if` would erase.
   *
   * ## Why a public engine method rather than a check inside RelayApiService
   *
   * The service is the presentation/IPC layer. Putting the rule there would make
   * the invariant true only for callers that happen to route through the service,
   * and false for every other caller. The engine is where the invariant lives.
   */
  public async assertRuntimeProviderContactPermitted(
    runtimeSessionId: RuntimeSessionId,
  ): Promise<RuntimePairGovernance> {
    const governance = await this.resolveRuntimePairGovernance(runtimeSessionId);

    if (governance.kind === 'ambiguous') {
      // Fail closed. Choosing one of several candidate Pairs would be a heuristic
      // authorisation decision, and an unjustifiable one.
      throw new RelayDomainError(
        `Runtime ${runtimeSessionId} is bound to more than one Pair (${governance.pairIds.join(', ')}), ` +
          'so its owning Pair cannot be determined authoritatively. Refusing provider contact rather ' +
          'than guessing which Pair governs it. Repair the duplicate binding first.',
        RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS,
      );
    }

    if (governance.kind === 'paired' && governance.operationalState !== 'ACTIVE') {
      throw new RelayDomainError(
        `Pair ${governance.pairId} is ${governance.operationalState}, so runtime ` +
          `${runtimeSessionId} cannot be inspected: provider contact is not permitted and persisted ` +
          'provider information is last-known evidence only (DESIGN_FREEZE I-2, I-3, §11.5). Run Load & ' +
          'Activate on the Pair first.',
        RUNTIME_PAIR_NOT_ACTIVE,
      );
    }

    return governance;
  }

  /**
   * I-2 GATE — ARMED (S6). This is the seventh provider-contact site, and it was
   * NOT in the original S1B call graph. It is addressed by `RuntimeSessionId`
   * rather than `PairId`, which is exactly why it was easy to miss: there was no
   * `Pair` in scope to gate against.
   *
   * `provider.inspectRuntime(...)` below is real external contact, so §11.5 gates
   * it, through the single shared path above.
   *
   * ## An unpaired runtime is NOT given permission by default
   *
   * If no Pair binds this runtime, the operation proceeds, because there is no
   * Pair whose IDLE state could be violated: standalone runtime management is an
   * established product capability (a runtime can be discovered, inspected,
   * archived, unarchived and adopted before it is ever paired). This is a
   * documented boundary, not an oversight — and it is the ABSENCE of a governance
   * subject, not a grant of permission. Case C in the S6 closure report pins this
   * behaviour with call counts.
   */
  public async reconcileAndRecoverRuntime(sessionId: RuntimeSessionId): Promise<RuntimeSession> {
    const runtime = await this.repos.runtimes.findById(sessionId);
    if (!runtime) throw new RelayDomainError(`Runtime ${sessionId} not found`, 'NOT_FOUND');

    await this.assertRuntimeProviderContactPermitted(sessionId);

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

  /* ================================================================== *
   * S6 — Load & Activate / Make Idle
   *
   * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §4.2, §4.4, §4.5,
   * §5.2, §5.3, §9.5, §11.1, §11.2, §11.3, §11.4, §11.5; I-1, I-2, I-4, I-6, I-10, I-11.
   * ================================================================== */

  /**
   * S5 — resolve and verify ONE side, independently (freeze §11.3).
   *
   * This is the only place in the engine that contacts a provider while a Pair is
   * still IDLE, and it does so for exactly one purpose: to establish whether that
   * side's identity can be resolved. It is not a generic observation pass and it
   * is not a dispatch path.
   *
   * Per-side isolation is structural: a throw on one side cannot reach the other,
   * because each side is resolved inside its own try/catch and a caught failure
   * becomes `unknown` rather than propagating (§11.3).
   *
   * ## The `checked-and-negative` vs `could-not-check` line
   *
   * This is the single most important distinction in the operation, and it is I-6
   * made load-bearing:
   *
   *   `verified`    the provider confirmed the id           -> may activate
   *   `unknown`     no capability, or the read failed/       -> may activate, and
   *                 was inconclusive                         the side is REPORTED
   *   `mismatched`  / `absent`
   *                 the provider was asked and answered no  -> TERMINAL, stay IDLE
   *
   * §4.4 requires "resolvable identity on both sides". A side that positively
   * contradicts the binding fails that precondition and aborts. A side we could
   * not ask does not: LEVEL 0 ChatGPT can never be fully verified (§9.5), and
   * refusing to activate every ChatGPT Pair would make §11.3's per-side reporting
   * and §9.5's asymmetry requirement unreachable. The freeze resolves this
   * itself — §11.2 says a terminal failure ends at IDLE, and a side we cannot
   * query has not failed, it is unknown.
   */
  private async resolveSideIdentity(
    pair: Pair,
    sideRole: PairSideRole,
  ): Promise<PairSideIdentity> {
    const observedAt = Date.now();
    const runtimeSessionId = sideRole === 'planner' ? pair.plannerSessionId : pair.workerSessionId;

    // An unbound side cannot be addressed at all. This is a §4.4 precondition
    // ("both sides bound") and it is reported per side, never silently omitted.
    if (!runtimeSessionId) {
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType: sideRole === 'planner' ? 'chatgpt' : 'opencode',
        runtimeSessionId: null,
        externalSessionId: null,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'not_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason: `No ${sideRole} runtime is bound to this Pair, so there is no session to address`,
        evidence: null,
      };
    }

    const runtime = await this.repos.runtimes.findById(runtimeSessionId);
    if (!runtime) {
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType: sideRole === 'planner' ? 'chatgpt' : 'opencode',
        runtimeSessionId,
        externalSessionId: null,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'not_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason: `Bound ${sideRole} runtime ${runtimeSessionId} no longer exists`,
        evidence: null,
      };
    }

    const providerType = runtime.providerType;

    // §4.4 precondition "provider capabilities present". A provider that is not
    // registered at all is a genuine unmet precondition and aborts the operation
    // below, rather than being softened into a per-side `unknown`.
    let provider: IRuntimeProvider;
    try {
      provider = this.getProvider(providerType);
    } catch {
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType,
        runtimeSessionId,
        externalSessionId: runtime.externalSessionId ?? null,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'not_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason: `No provider is registered for '${providerType}', so the ${sideRole} side cannot be resolved`,
        evidence: null,
      };
    }

    // I-11: the address is the provider's own external session id. The shared
    // human-readable Pair Name is never used to identify anything.
    const externalSessionId = runtime.externalSessionId ?? null;
    if (!externalSessionId) {
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType,
        runtimeSessionId,
        externalSessionId: null,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'not_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason:
          `The ${sideRole} runtime has no external session id, so there is no provider-owned ` +
          'identity to address. Per I-11 a name is not a substitute.',
        evidence: null,
      };
    }

    // No identity capability on this provider: LEVEL 0. Reported as `unknown`,
    // never as a negative (§5.3, §9.5). This is the ChatGPT case.
    if (typeof provider.resolveSideIdentity !== 'function') {
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType,
        runtimeSessionId,
        externalSessionId,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'not_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason:
          `Provider '${providerType}' exposes no exact-session identity capability, so the ` +
          `${sideRole} side cannot be verified. This is a permanent capability gap ` +
          '(LEVEL 0), not a failed check (freeze §9.5, I-6).',
        evidence: null,
      };
    }

    let projectPath: string | undefined;
    try {
      const project = await this.repos.projects.findById(pair.projectId);
      projectPath = project?.workerWorkspacePath ?? project?.canonicalPath ?? undefined;
    } catch {
      projectPath = undefined;
    }

    try {
      const resolution = await provider.resolveSideIdentity({ externalSessionId, projectPath });
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType,
        runtimeSessionId,
        externalSessionId,
        identityState: resolution.identityState,
        identityValue: resolution.identityValue,
        verificationState: resolution.verificationState,
        verificationValue: resolution.verificationValue,
        existenceState: resolution.existenceState,
        capability: 'exact_session_verifiable',
        // Dimension 8: the capability name, never just the provider (§5.2, C-8).
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: resolution.sourceCapability || NO_IDENTITY_CAPABILITY,
        observedAt: resolution.observedAt || observedAt,
        reason: resolution.reason ?? null,
        evidence: resolution.evidence ?? null,
      };
    } catch (err: any) {
      // A thrown read is "could not check", never "not verified" (I-6).
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType,
        runtimeSessionId,
        externalSessionId,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'exact_session_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason: `Identity resolution threw: ${err?.message ?? String(err)}`,
        evidence: null,
      };
    }
  }

  /**
   * S6 — `loadAndActivate(pairId)`.
   *
   * §4.4 preconditions, and how each is proven here:
   *
   *   Pair exists              -> `repos.pairs.findById` throws PAIR_NOT_FOUND.
   *   IDLE only (§11.4)        -> an ACTIVE pair returns outcome 'rejected'.
   *   Both sides bound         -> per-side `reason` names the unbound side; the
   *                              operation rejects and the pair stays IDLE.
   *   Provider capabilities    -> a registered provider is required per bound side.
   *     present                   An unregistered provider is a real precondition
   *                              failure and rejects. A REGISTERED provider with no
   *                              identity capability yields per-side `unknown`
   *                              (§9.5 LEVEL 0) and does not reject.
   *   Resolvable identity on   -> `verified` passes. `mismatched`/`absent` is a
   *   both sides                 checked-and-negative TERMINAL failure: the pair
   *                              stays IDLE (§11.2 "any terminal failure -> IDLE").
   *                              `unknown` does not reject, and is reported.
   *
   * ## What this deliberately does NOT do
   *
   * It does not derive readiness, does not persist any readiness value (I-5), does
   * not compare messages, and does not capture or read a checkpoint. Those are
   * S7/S8. See S6_LOAD_AND_ACTIVATE.md §2 for the §4.4-vs-§11.2 reading that puts
   * those clauses out of scope, and §3 for the "provider capabilities present" one.
   *
   * It is the ONLY operation permitted to move a Pair to ACTIVE. `startPair()`
   * remains execution authority only and never touches operational state
   * (N-16, N-18, I-9); on an IDLE Pair it refuses truthfully rather than becoming a
   * bridge into ACTIVE.
   */
  public async loadAndActivate(pairId: PairId): Promise<PairActivationResult> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const reject = async (
      reason: string,
      sides?: Record<PairSideRole, PairSideIdentity>,
    ): Promise<PairActivationResult> => {
      // A rejected activation leaves the pair exactly as it found it: IDLE (I-1).
      const current = await this.repos.pairs.findById(pairId);
      const resolvedSides = sides ?? (await this.readBothSides(pair));
      await this.emitEvent('pair', pairId, 'pair.activation_rejected', {
        actor: 'user',
        previousState: current?.operationalState ?? 'IDLE',
        newState: current?.operationalState ?? 'IDLE',
        details: {
          reason,
          planner: summariseSide(resolvedSides.planner),
          worker: summariseSide(resolvedSides.worker),
        },
      });
      return {
        pairId,
        outcome: 'rejected',
        operationalStateBefore: pair.operationalState,
        operationalStateAfter: current?.operationalState ?? 'IDLE',
        sides: resolvedSides,
        fullyVerified: false,
        reason,
      };
    };

    // §11.4: idempotent with respect to operational state. Re-running an activation
    // is an explicit retry, not an implicit side effect of calling again.
    if (pair.operationalState === 'ACTIVE') {
      return reject(
        'Pair is already ACTIVE. Re-running Load & Activate is rejected; a partial retry is a ' +
          'distinct explicit operation (freeze §11.4).',
      );
    }

    // §11.3: each side resolved independently. Sequential rather than parallel so
    // the provider spy ordering in tests is deterministic; the isolation is
    // structural, not an artefact of concurrency.
    const plannerSide = await this.resolveSideIdentity(pair, 'planner');
    const workerSide = await this.resolveSideIdentity(pair, 'worker');

    // Persist the evidence BEFORE deciding, so a rejected activation still leaves
    // durable last-known evidence for both sides (I-3). Make Idle preserves it (I-10).
    await this.repos.sideIdentities.save(plannerSide);
    await this.repos.sideIdentities.save(workerSide);

    const sides: Record<PairSideRole, PairSideIdentity> = {
      planner: plannerSide,
      worker: workerSide,
    };

    // §4.4 "both sides bound". An unbound side has nothing to address, so the
    // precondition cannot be met for that side.
    const unbound = PAIR_SIDE_ROLES.find((role) => sides[role].runtimeSessionId === null);
    if (unbound) {
      return reject(
        `Precondition failed: the ${unbound} side has no bound runtime, so its identity cannot ` +
          'be resolved (freeze §4.4 "both sides bound").',
        sides,
      );
    }

    // §4.4 "provider capabilities present". A provider that is not registered at
    // all is a configuration failure, distinct from a registered provider that
    // simply cannot verify (which stays `unknown`, §9.5).
    const unregistered = PAIR_SIDE_ROLES.find(
      (role) => sides[role].reason?.startsWith('No provider is registered'),
    );
    if (unregistered) {
      return reject(
        `Precondition failed: no provider is registered for the ${unregistered} side ` +
          '(freeze §4.4 "provider capabilities present").',
        sides,
      );
    }

    // "Resolvable identity on both sides". A checked-and-negative answer is a
    // terminal failure; `unknown` is not (see resolveSideIdentity's contract).
    const contradicted = PAIR_SIDE_ROLES.find(
      (role) =>
        sides[role].verificationState === 'mismatched' || sides[role].existenceState === 'absent',
    );
    if (contradicted) {
      return reject(
        `Precondition failed: the ${contradicted} side was checked by its provider and did not ` +
          'resolve to the bound identity, so Load & Activate ends at IDLE (freeze §4.4, §11.2).',
        sides,
      );
    }

    // Every surviving path is IDLE here (I-1: the transition is one-way and the
    // only writer is Pair.makeActive()).
    pair.makeActive('load_and_activate');
    await this.repos.pairs.save(pair);

    const fullyVerified = PAIR_SIDE_ROLES.every((role) => sides[role].verificationState === 'verified');

    await this.emitEvent('pair', pairId, 'pair.activated', {
      actor: 'user',
      previousState: 'IDLE',
      newState: 'ACTIVE',
      details: {
        // §9.5: the asymmetry is part of the record, not a UI afterthought.
        fullyVerified,
        planner: summariseSide(plannerSide),
        worker: summariseSide(workerSide),
        unverifiedSides: PAIR_SIDE_ROLES.filter((r) => sides[r].verificationState !== 'verified'),
      },
    });

    return {
      pairId,
      outcome: 'activated',
      operationalStateBefore: 'IDLE',
      operationalStateAfter: 'ACTIVE',
      sides,
      fullyVerified,
      // A null reason is honest here: a side recorded as `unknown` carries its own
      // reason on the side record itself.
      reason: null,
    };
  }

  /**
   * S6 — `makeIdle(pairId, reason)`.
   *
   * §11.2: provider contact **No**. §4.5 + I-10: it stops observation and
   * interaction and PRESERVES bindings, history, checkpoints, cursors, provenance
   * and last-known evidence. Idempotent.
   *
   * It does not delete or rewrite the per-side identity rows, because those are
   * the last-known evidence I-3 requires an IDLE Pair to be able to render.
   */
  public async makePairIdle(pairId: PairId, reason?: string): Promise<Pair> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const wasActive = pair.operationalState === 'ACTIVE';

    // Idempotent, and a no-op on an already-IDLE pair that still records the intent.
    pair.makeIdle(reason);
    await this.repos.pairs.save(pair);

    await this.emitEvent('pair', pairId, 'pair.idled', {
      actor: 'user',
      previousState: wasActive ? 'ACTIVE' : 'IDLE',
      newState: 'IDLE',
      details: { reason: reason ?? null, idempotent: !wasActive },
    });

    return pair;
  }

  /* ===================================================================== *
   * S2 — provider-neutral observation of one exact bound side
   * ===================================================================== */

  /**
   * S2 — `observeSide(pairId, sideRole)`.
   *
   * §11.2: state precondition `ACTIVE`, provider contact **yes**, changes
   * operational state **no**, and it "does not advance the checkpoint (§6.4)".
   *
   * ## I-2 comes first, before anything else
   *
   * The ACTIVE check is the second statement in the method, ahead of every
   * provider lookup. An IDLE Pair returns `outcome: 'refused'` with
   * `providerContacted: false` and never reaches `getProvider`. §7 of the S2 brief
   * is therefore a structural property of this method, not a convention.
   *
   * ## What observation deliberately does NOT touch
   *
   * It observes dimensions 4-7 and carries dimensions 1-3 forward from the
   * existing record UNCHANGED. It does not re-resolve identity, does not
   * recompute verification, does not rewrite operational state, does not derive
   * readiness (I-5), does not compare the two sides (I-7), and does not write any
   * checkpoint, cursor, attempt, delivery or handoff field. Those are the
   * boundaries §6.4 and the S2 non-goals draw, and the type system helps: this
   * method's only write is `sideIdentities.save`.
   */
  public async observeSide(pairId: PairId, sideRole: PairSideRole): Promise<SideObservationResult> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const stored = await this.repos.sideIdentities.find(pairId, sideRole);

    /* --- Resolve the binding LOCALLY, before the gate ------------------------
     *
     * Reading the local database is not external contact, so doing it ahead of
     * the I-2 check costs nothing in provider calls. It has to happen here
     * because the refusal path must also be able to tell whether the stored
     * record is even about the currently bound session: returning the previous
     * session's evidence as this side's "last-known" would be a lie, and I-3
     * requires the IDLE view to be truthful about what it is showing.
     */
    const runtimeSessionId = sideRole === 'planner' ? pair.plannerSessionId : pair.workerSessionId;
    const runtime = runtimeSessionId ? await this.repos.runtimes.findById(runtimeSessionId) : null;
    const externalSessionId = runtime?.externalSessionId ?? null;

    /* --- A stored record may describe a DIFFERENT session --------------------
     *
     * `updatePair()` rebinds a side to a different runtime and does not touch the
     * side-identity rows, so a row written before the rebind still names the
     * PREVIOUS session. That row is not this side's evidence any more. Two
     * things follow, and both are about truth rather than policy:
     *
     *   - its identity dimensions must not be carried forward or returned as if
     *     they described the newly bound session, and
     *   - its ordinal must NOT be used as the monotonic baseline, because an
     *     ordinal from a different session is not comparable with this one and
     *     would make a legitimate first observation of the new session look stale.
     *
     * The record is not deleted: the previous session's evidence stays on disk as
     * its own last-known truth, it is simply no longer offered as evidence about
     * THIS side. Rebinding itself is untouched — deciding when a rebind should
     * discard evidence belongs to the replacement contract
     * (SESSION_PAIR_REPLACEMENT.md, C-1), which is out of scope here.
     */
    const storedDescribesThisSession =
      stored !== null && externalSessionId !== null && stored.externalSessionId === externalSessionId;
    const prior = storedDescribesThisSession ? stored : null;
    const supersededNote =
      !storedDescribesThisSession && stored !== null
        ? ` The previously stored record described external session ` +
          `'${stored.externalSessionId ?? 'none'}', which this side is no longer bound to, so it is ` +
          'not reported as evidence for this side and was not used as an ordering baseline.'
        : '';

    /**
     * The single refusal path. It is reached ONLY before any provider is resolved,
     * which is what makes "zero provider contact" provable rather than asserted.
     */
    const refuse = (reason: string): SideObservationResult => {
      return {
        pairId,
        sideRole,
        outcome: 'refused',
        providerContacted: false,
        record: prior ?? this.neverObservedSide(pair, sideRole),
        reason: reason + supersededNote,
      };
    };

    // I-2. An IDLE Pair permits no external contact of any kind.
    if (!pair.isProviderContactPermitted()) {
      return refuse(
        `Pair is IDLE, so the ${sideRole} side was not observed and no provider was contacted ` +
          '(freeze I-2, I-3). Its stored last-known observation is still readable locally, but it ' +
          'is last-known evidence, not live state. Run Load & Activate to permit observation.',
      );
    }

    if (!runtimeSessionId) {
      return refuse(
        `The ${sideRole} side has no bound runtime, so there is no exact session to observe ` +
          '(freeze §4.4 "both sides bound").',
      );
    }

    if (!runtime) {
      return refuse(
        `The ${sideRole} runtime '${runtimeSessionId}' no longer exists, so there is nothing to observe.`,
      );
    }

    // I-11. The address is the provider's own external id. A name is never a
    // substitute, and an absent id is an honest refusal rather than a guess.
    if (!externalSessionId) {
      return refuse(
        `The ${sideRole} runtime has no external session id, so there is no provider-owned identity ` +
          'to observe. Per I-11 a name or window title is not a substitute.',
      );
    }

    let provider;
    try {
      provider = this.getProvider(runtime.providerType);
    } catch {
      // A provider that is not registered is a configuration failure. It is NOT a
      // negative observation, so nothing is persisted over the existing record.
      return refuse(
        `No provider is registered for '${runtime.providerType}', so the ${sideRole} side could not ` +
          'be observed. The existing last-known observation is unchanged.',
      );
    }

    // LEVEL 0 for this capability. Reported as unknown on every dimension, and
    // persisted, because "this provider cannot be observed" is durable truth worth
    // keeping (I-6, §5.3, C-8). It is never a fabricated negative.
    if (typeof provider.observeSide !== 'function') {
      const reading = this.unobservableReading(
        Date.now(),
        `Provider '${runtime.providerType}' exposes no observation capability, so the ${sideRole} ` +
          'side is unknown on every dimension. This is a permanent capability gap (LEVEL 0), not a ' +
          'failed read (freeze I-6, §5.3, C-8).',
      );
      const record = this.withObservation(prior, pair, sideRole, runtime, reading);
      await this.repos.sideIdentities.save(record);
      return {
        pairId,
        sideRole,
        outcome: 'observed',
        providerContacted: false,
        record,
        reason: reading.reason,
      };
    }

    let projectPath: string | undefined;
    try {
      const project = await this.repos.projects.findById(pair.projectId);
      projectPath = project?.workerWorkspacePath ?? project?.canonicalPath ?? undefined;
    } catch {
      projectPath = undefined;
    }

    let reading: SideObservationReading;
    let contacted = true;
    try {
      reading = await provider.observeSide({ externalSessionId, projectPath });
    } catch (err: any) {
      // A thrown read is "could not observe", never "observed as negative" (I-6).
      contacted = true;
      reading = this.unobservableReading(
        Date.now(),
        `The observation read threw: ${err?.message ?? String(err)}. Nothing is known about this ` +
          'side from this attempt (I-6).',
      );
    }

    /* --- §11 monotonicity: never let an older reading overwrite a newer one ---
     *
     * The ONLY accepted ordering primitive is the provider's own ordinal for this
     * one session. If either side lacks one, NO comparison is performed and the
     * reading is stored as-is: inventing an ordering — worst of all from a
     * timestamp, and certainly across two providers — is what I-7 forbids.
     */
    const priorOrdinal = prior?.observation?.message.ordinal ?? null;
    const nextOrdinal = reading.message.ordinal;
    const isStale =
      priorOrdinal !== null &&
      nextOrdinal !== null &&
      nextOrdinal < priorOrdinal;

    if (isStale) {
      // Reported, never hidden. The durable marker stays authoritative.
      return {
        pairId,
        sideRole,
        outcome: 'stale',
        providerContacted: contacted,
        record: prior!,
        reason:
          `The provider reported message ordinal ${nextOrdinal}, which is OLDER than the stored ` +
          `ordinal ${priorOrdinal} for this session, so the stored latest-observed marker was kept. ` +
          'Ordering uses only the provider\'s own within-session order (I-7).',
      };
    }

    const record = this.withObservation(prior, pair, sideRole, runtime, reading);
    await this.repos.sideIdentities.save(record);

    await this.emitEvent('pair', pairId, 'pair.side_observed', {
      actor: 'user',
      previousState: prior?.observation ? 'observed' : 'never-observed',
      newState: 'observed',
      details: {
        sideRole,
        providerType: runtime.providerType,
        externalSessionId,
        observationCapability: reading.observationCapability,
        reachabilityState: reading.reachabilityState,
        uiPresenceState: reading.uiPresenceState,
        activityState: reading.activityState,
        messageEvidenceState: reading.messageEvidenceState,
        messageRef: reading.message.ref,
        messageOrdinal: reading.message.ordinal,
        // §6.4: observation records what was seen. It does not acknowledge it.
        checkpointAdvanced: false,
        // Audit trail for the rebind case: a stored record that described a
        // different session was deliberately not carried forward.
        supersededPriorSession: !storedDescribesThisSession && stored !== null
          ? stored.externalSessionId ?? null
          : null,
      },
    });

    return {
      pairId,
      sideRole,
      outcome: 'observed',
      providerContacted: contacted,
      record,
      reason: (reading.reason ? reading.reason + ' ' : '') + supersededNote.trim(),
    };
  }

  /**
   * Carries dimensions 1-3 forward from the PRIOR record and attaches the new
   * dimensions 4-7 reading.
   *
   * Preserving 1-3 verbatim is the point: observation is a read of the CURRENT
   * state of a side, and re-deriving identity inside it would (a) double the
   * provider traffic, (b) risk regressing the S5 verdict with a weaker read, and
   * (c) blur the boundary between "who is this side" (S4/S5) and "what is it
   * doing now" (S2).
   *
   * `prior` is passed in already filtered to a record that describes the SAME
   * externally bound session; when it is null because the side was rebound, or
   * because nothing was ever stored, the identity dimensions are recorded as
   * unknown with a reason rather than invented or inherited from another session.
   */
  private withObservation(
    existing: PairSideIdentity | null,
    pair: Pair,
    sideRole: PairSideRole,
    runtime: { id: RuntimeSessionId; providerType: ProviderType; externalSessionId?: string | null },
    reading: SideObservationReading,
  ): PairSideIdentity {
    const base = existing ?? this.neverObservedSide(pair, sideRole);
    return {
      ...base,
      // Keep the S5 identity provenance current with the binding it describes, but
      // do not re-derive the states.
      providerType: runtime.providerType,
      runtimeSessionId: runtime.id,
      externalSessionId: runtime.externalSessionId ?? null,
      observation: reading,
    };
  }

  /** A record that says plainly that nothing is known about this side yet. */
  private neverObservedSide(pair: Pair, sideRole: PairSideRole): PairSideIdentity {
    return {
      sessionPairId: pair.id,
      sideRole,
      providerType: sideRole === 'planner' ? 'chatgpt' : 'opencode',
      runtimeSessionId: sideRole === 'planner' ? (pair.plannerSessionId ?? null) : (pair.workerSessionId ?? null),
      externalSessionId: null,
      identityState: 'unknown',
      identityValue: null,
      verificationState: 'unknown',
      verificationValue: null,
      existenceState: 'unknown',
      capability: 'not_verifiable',
      observation: null,
      sourceCapability: NO_IDENTITY_CAPABILITY,
      observedAt: Date.now(),
      reason: 'This side has never been observed by Load & Activate',
      evidence: null,
    };
  }

  /**
   * A reading in which every dimension is `unknown` because the provider could
   * not be asked (no capability, or a throw). Dimensions 8 and 9 are still
   * populated, because §5.2 makes an observation with no source or no time
   * invalid rather than defaulted.
   */
  private unobservableReading(at: number, reason: string): SideObservationReading {
    return {
      reachabilityState: 'unknown',
      uiPresenceState: 'unknown',
      activityState: 'unknown',
      messageEvidenceState: 'unknown',
      message: { ref: null, role: null, text: null, truncated: false, ordinal: null },
      observationCapability: NO_OBSERVATION_CAPABILITY,
      observedAt: at,
      validUntil: at + PROVISIONAL_OBSERVATION_VALIDITY_MS,
      reason,
      evidence: null,
    };
  }

  /**
   * Reads both sides for reporting, preferring persisted last-known evidence and
   * falling back to an explicit "never observed" record. A side is never omitted
   * from the result (§11.3).
   */
  private async readBothSides(pair: Pair): Promise<Record<PairSideRole, PairSideIdentity>> {
    const neverObserved = (sideRole: PairSideRole): PairSideIdentity => ({
      sessionPairId: pair.id,
      sideRole,
      providerType: sideRole === 'planner' ? 'chatgpt' : 'opencode',
      runtimeSessionId: sideRole === 'planner' ? (pair.plannerSessionId ?? null) : (pair.workerSessionId ?? null),
      externalSessionId: null,
      identityState: 'unknown',
      identityValue: null,
      verificationState: 'unknown',
      verificationValue: null,
      existenceState: 'unknown',
      capability: 'not_verifiable',
      // S2: an absent group, distinct from a group whose dimensions are unknown.
      observation: null,
      sourceCapability: NO_IDENTITY_CAPABILITY,
      observedAt: Date.now(),
      reason: 'This side has never been observed by Load & Activate',
      evidence: null,
    });

    const [planner, worker] = await Promise.all([
      this.repos.sideIdentities.find(pair.id, 'planner'),
      this.repos.sideIdentities.find(pair.id, 'worker'),
    ]);
    return {
      planner: planner ?? neverObserved('planner'),
      worker: worker ?? neverObserved('worker'),
    };
  }

  /* ===================================================================== *
   * S3 — Session Pair continuity and side checkpoints
   * ===================================================================== */

  /**
   * S3 — `computeContinuity(pairId)`.
   *
   * §11.2: state precondition: Any (callable whether IDLE or ACTIVE).
   * Changes operational state: No.
   * Provider contact: **No** (pure local read of durable observation and checkpoints; zero provider contact).
   *
   * Evaluates both bound sides against their latest respective checkpoints:
   * - If either side lacks a checkpoint baseline, that side is `unknown` and the Pair is `UNKNOWN`.
   * - Stable identity is NOT ordering: differing message refs without trustworthy ordinals evaluate to `unknown`.
   */
  public async computeContinuity(pairId: PairId): Promise<PairContinuityResult> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const [plannerObs, workerObs, plannerChk, workerChk] = await Promise.all([
      this.repos.sideIdentities.find(pairId, 'planner'),
      this.repos.sideIdentities.find(pairId, 'worker'),
      this.repos.sideCheckpoints.findLatest(pairId, 'planner'),
      this.repos.sideCheckpoints.findLatest(pairId, 'worker'),
    ]);

    const plannerEval = evaluateSideContinuity('planner', plannerObs, plannerChk);
    const workerEval = evaluateSideContinuity('worker', workerObs, workerChk);

    return classifyPairContinuity(pairId, plannerEval, workerEval);
  }

  /**
   * Phase D — `computePairReadiness(pairId)`.
   *
   * Derived readiness evaluation for a Pair.
   * Zero provider contact (pure evaluation of local persistence and continuity).
   */
  public async computePairReadiness(pairId: PairId): Promise<PairReadinessAssessment> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const [plannerSession, workerSession, plannerObs, workerObs, continuity] = await Promise.all([
      pair.plannerSessionId ? this.repos.runtimes.findById(pair.plannerSessionId) : Promise.resolve(null),
      pair.workerSessionId ? this.repos.runtimes.findById(pair.workerSessionId) : Promise.resolve(null),
      this.repos.sideIdentities.find(pairId, 'planner'),
      this.repos.sideIdentities.find(pairId, 'worker'),
      this.computeContinuity(pairId),
    ]);

    return evaluatePairReadiness(pair, plannerSession, workerSession, plannerObs, workerObs, continuity);
  }

  /**
   * S3 — `captureInitialBaseline(pairId, sideRole, operatorId, auditReason?)`.
   *
   * Explicit operator establishment of the initial baseline checkpoint for one side.
   *
   * Preconditions:
   * - Pair must exist.
   * - Side must have an existing durable observation (`pair_side_identity`).
   * - Side must NOT already have an existing checkpoint baseline (throws CHECKPOINT_BASELINE_ALREADY_EXISTS).
   *
   * Fencing:
   * - ZERO provider contact.
   * - Changes operational state: No.
   * - Append-only record with authority kind 'INITIAL_BASELINE'.
   */
  public async captureInitialBaseline(
    pairId: PairId,
    sideRole: PairSideRole,
    operatorId: string,
    auditReason?: string,
  ): Promise<PairSideCheckpoint> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const existingCheckpoint = await this.repos.sideCheckpoints.findLatest(pairId, sideRole);
    if (existingCheckpoint) {
      throw new RelayDomainError(
        `Pair ${pairId} ${sideRole} side already has a checkpoint baseline (${existingCheckpoint.id}). ` +
          'Initial baseline can only be captured once per side. Use acknowledgeSideCheckpoint to advance.',
        CHECKPOINT_BASELINE_ALREADY_EXISTS,
      );
    }

    const obs = await this.repos.sideIdentities.find(pairId, sideRole);
    if (!obs || !obs.observation) {
      throw new RelayDomainError(
        `Pair ${pairId} ${sideRole} side has no durable observation. A baseline cannot be captured without prior observation.`,
        CHECKPOINT_OBSERVATION_REQUIRED,
      );
    }

    const checkpointId = createId<PairSideCheckpointId>('chk');
    const checkpoint: PairSideCheckpoint = {
      id: checkpointId,
      sessionPairId: pairId,
      sideRole,
      messageRef: obs.observation.message.ref,
      messageOrdinal: obs.observation.message.ordinal,
      messageText: obs.observation.message.text,
      externalSessionId: obs.externalSessionId,
      determinacy: obs.observation.message.ordinal !== null || obs.observation.message.ref !== null
        ? 'identified'
        : 'unverified',
      capturedAt: Date.now(),
      sourceProvider: obs.providerType,
      sourceCapability: obs.observation.observationCapability,
      authority: {
        kind: 'INITIAL_BASELINE',
        operatorId,
      },
      auditReason: auditReason || 'Explicit operator initial baseline capture',
    };

    await this.repos.sideCheckpoints.save(checkpoint);

    await this.emitEvent('pair', pairId, 'pair.side_checkpoint_captured', {
      actor: 'user',
      previousState: 'none',
      newState: 'checkpointed',
      details: {
        checkpointId,
        sideRole,
        authorityKind: 'INITIAL_BASELINE',
        operatorId,
        messageRef: checkpoint.messageRef,
        messageOrdinal: checkpoint.messageOrdinal,
      },
    });

    return checkpoint;
  }

  /**
   * S3 — `acknowledgeSideCheckpoint(pairId, sideRole, options)`.
   *
   * Explicit operator acknowledgment/reconciliation of advanced state for one side.
   *
   * Preconditions:
   * - Pair must exist.
   * - Side must already have a prior baseline checkpoint (throws CHECKPOINT_BASELINE_REQUIRED).
   * - Side must have an existing durable observation (throws CHECKPOINT_OBSERVATION_REQUIRED).
   *
   * Fencing:
   * - ZERO provider contact.
   * - Changes operational state: No.
   * - Append-only record with authority kind 'OPERATOR_ACKNOWLEDGED'.
   */
  public async acknowledgeSideCheckpoint(
    pairId: PairId,
    sideRole: PairSideRole,
    options: {
      operatorId: string;
      resolutionNote?: string;
      auditReason?: string;
    },
  ): Promise<PairSideCheckpoint> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const existingCheckpoint = await this.repos.sideCheckpoints.findLatest(pairId, sideRole);
    if (!existingCheckpoint) {
      throw new RelayDomainError(
        `Pair ${pairId} ${sideRole} side has no prior checkpoint baseline. Initial baseline must be established before acknowledging progress.`,
        CHECKPOINT_BASELINE_REQUIRED,
      );
    }

    const obs = await this.repos.sideIdentities.find(pairId, sideRole);
    if (!obs || !obs.observation) {
      throw new RelayDomainError(
        `Pair ${pairId} ${sideRole} side has no durable observation to acknowledge.`,
        CHECKPOINT_OBSERVATION_REQUIRED,
      );
    }

    const checkpointId = createId<PairSideCheckpointId>('chk');
    const checkpoint: PairSideCheckpoint = {
      id: checkpointId,
      sessionPairId: pairId,
      sideRole,
      messageRef: obs.observation.message.ref,
      messageOrdinal: obs.observation.message.ordinal,
      messageText: obs.observation.message.text,
      externalSessionId: obs.externalSessionId,
      determinacy: obs.observation.message.ordinal !== null || obs.observation.message.ref !== null
        ? 'identified'
        : 'unverified',
      capturedAt: Date.now(),
      sourceProvider: obs.providerType,
      sourceCapability: obs.observation.observationCapability,
      authority: {
        kind: 'OPERATOR_ACKNOWLEDGED',
        operatorId: options.operatorId,
        acknowledgedAt: Date.now(),
        resolutionNote: options.resolutionNote,
      },
      auditReason: options.auditReason || 'Explicit operator checkpoint acknowledgment',
    };

    await this.repos.sideCheckpoints.save(checkpoint);

    await this.emitEvent('pair', pairId, 'pair.side_checkpoint_captured', {
      actor: 'user',
      previousState: existingCheckpoint.id,
      newState: checkpointId,
      details: {
        checkpointId,
        sideRole,
        authorityKind: 'OPERATOR_ACKNOWLEDGED',
        operatorId: options.operatorId,
        resolutionNote: options.resolutionNote,
        messageRef: checkpoint.messageRef,
        messageOrdinal: checkpoint.messageOrdinal,
      },
    });

    return checkpoint;
  }


  /**
   * `startPair` — EXECUTION authority. It is NOT the activation authority.
   *
   * ## It never grants ACTIVE, and never transitions IDLE -> ACTIVE
   *
   * Freeze §4.4: Start Pair "Changes operational state: No" (N-16, N-18, I-9).
   * `Pair.resume()` writes the deprecated lifecycle `status` and nothing else;
   * `operationalState` is untouched here. The ONLY `IDLE -> ACTIVE` transition in
   * this tranche is `loadAndActivate` (S6). A deliberate, documented rejection of
   * the "bridge" reading: Start Pair is never a compatibility path into ACTIVE.
   *
   * ## Why it refuses on an IDLE Pair
   *
   * Starting execution on an IDLE Pair would record a lifecycle status implying
   * work is underway while the engine refuses every provider contact behind it
   * (I-2). That is the silent, misleading outcome this refusal exists to prevent:
   * the operator would see a started pair and see nothing happen, with no
   * explanation. Refusing, and naming the operation that would succeed, is the
   * truthful response.
   *
   * The thrown code is deliberately the same `PAIR_OPERATIONAL_STATE_IDLE` the I-2
   * gate raises, so a caller has one code to handle for "this Pair may not contact
   * providers" whether the block came from the gate or from here.
   */
  public async startPair(pairId: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    if (!pair.isProviderContactPermitted()) {
      // The advice must be true for THIS pair. Telling a pair with an unbound side
      // to "run Load & Activate" would send the operator into a second, different
      // failure, because §4.4 requires BOTH sides bound before activation succeeds.
      const missing = [
        !pair.plannerSessionId ? 'planner' : null,
        !pair.workerSessionId ? 'worker' : null,
      ].filter(Boolean);
      const remedy = missing.length
        ? `Pair ${pairId} has no bound ${missing.join(' or ')} runtime, so Load & Activate cannot ` +
          `satisfy its §4.4 "both sides bound" precondition. Bind the ${missing.join(' and ')} ` +
          'runtime first.'
        : `Run Load & Activate on Pair ${pairId} first to grant ACTIVE, then Start Pair to begin ` +
          'execution.';
      throw new RelayDomainError(
        `Pair ${pairId} is IDLE, so its execution cannot be started: execution needs provider ` +
          `contact, which IDLE forbids (DESIGN_FREEZE I-2). Start Pair is execution authority ` +
          `only and does not activate. ${remedy} (freeze §4.4, §11.5).`,
        'PAIR_OPERATIONAL_STATE_IDLE',
      );
    }

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
   *
   * I-2 GATE — ARMED (S6), in `runSupervisionTick`. A ticking loop is continuous
   * provider contact by construction, so §11.5 requires the tick to be gated on
   * `operational_state === 'ACTIVE'`. This method only schedules the tick, so the
   * gate there gates the loop completely; no second check is needed here and none
   * is added, because one enforcement point is the point.
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

  /* --- Dispatch-Intent Reconciliation -------------------------------------
   *
   * The invariant implemented here:
   *
   *   Every durable dispatch intent must eventually reach a terminal,
   *   operator-visible disposition. A Delivery must not remain `delivering`
   *   indefinitely after process interruption without either being resolved
   *   from authoritative evidence or surfaced as ambiguity requiring attention.
   *
   * ## The window this closes
   *
   * `dispatchAssignment` is deliberately three-phase (ATTEMPT_LIFECYCLE.md Case 1/2):
   *
   *   Phase 1  txn   prepared Attempt + Delivery(pending -> delivering)   COMMIT
   *   Phase 2  ---   provider.deliverInstruction()   <-- EXTERNAL SIDE EFFECT
   *   Phase 3  txn   confirmDelivered | markAmbiguous | markFailed      COMMIT
   *
   * A crash inside Phase 2 leaves `Attempt = prepared` and `Delivery = delivering`
   * while the external worker may or may not have received the instruction. The
   * duplicate-dispatch guards then correctly refuse to resend — which is safe, but on
   * its own leaves the assignment wedged forever with no operator signal. Nothing
   * previously resolved that state. `recoverOnStartup` inspected runtimes, never
   * deliveries, and the provider's `reconcileDispatch` hook existed but was never called.
   *
   * ## Why this is an engine concern, not a controller concern
   *
   * The Plan-First controller deliberately observes a `prepared | running` attempt and
   * never advances it (PLAN_FIRST_DOMAIN_FREEZE.md section G step 6). That is correct:
   * the controller must not guess. Resolving dispatch ground truth is a different
   * question from deciding whether work is complete, so it lives here, in the engine,
   * and the controller is untouched.
   *
   * ## Why it is idempotent
   *
   * Idempotency is a consequence of the state machine, not a separate mechanism. A
   * delivery is examined only while it is unresolved. Its terminal disposition and the
   * Attention item (if any) are committed in ONE transaction, so the item can never be
   * written twice, and once terminal the delivery is no longer returned by
   * `findUnresolved()`. Repeated passes are therefore no-ops. Provider probes are
   * read-only, so re-probing after a rolled-back transaction is safe.
   *
   * ## What it never does
   *
   * It never resends. It never creates an Assignment or an Attempt. It never advances a
   * WorkUnit and never produces a VerificationResult. Completion remains reachable only
   * through the normal worker-evidence plus verification path.
   */

  /**
   * Drives every unresolved durable dispatch intent to a terminal disposition.
   *
   * @param options.assignmentId scope to one assignment (used before dispatching more work)
   */
  public async reconcileUnresolvedDispatches(
    options: { assignmentId?: AssignmentId } = {},
  ): Promise<DispatchReconciliationReport> {
    const dispositions: DispatchReconciliationDispositionRecord[] = [];

    const candidates = options.assignmentId
      ? (await this.repos.deliveries.findByAssignmentId(options.assignmentId)).filter(
          (d) => d.status === 'pending' || d.status === 'delivering',
        )
      : await this.repos.deliveries.findUnresolved();

    for (const delivery of candidates) {
      // Re-read under the current transaction boundary: another pass may have
      // already driven this delivery terminal.
      const current = await this.repos.deliveries.findById(delivery.id);
      if (!current || (current.status !== 'pending' && current.status !== 'delivering')) {
        continue;
      }

      const outcome = await this.probeDispatchOutcome(current);
      const record = await this.commitDispatchDisposition(current, outcome);
      dispositions.push(record);
    }

    return {
      examined: candidates.length,
      deliveredConfirmed: dispositions.filter((d) => d.disposition === 'delivered_confirmed').length,
      notDeliveredConfirmed: dispositions.filter((d) => d.disposition === 'not_delivered_confirmed').length,
      ambiguousRaised: dispositions.filter((d) => d.disposition === 'ambiguous_raised').length,
      dispositions,
    };
  }

  /**
   * Asks the authoritative provider whether a stranded dispatch actually landed.
   *
   * Every failure mode here — absent runtime, unregistered provider, missing hook, or a
   * thrown probe — resolves to `insufficient`. A provider that cannot answer has NOT
   * thereby proven anything, and an unanswered question about a durable dispatch intent
   * is itself unresolved work that an operator must see.
   */
  private async probeDispatchOutcome(delivery: Delivery): Promise<DispatchProbeOutcome> {
    const attempt = await this.repos.attempts.findById(delivery.attemptId);
    if (!attempt) {
      return {
        kind: 'insufficient',
        reason: `Dispatch intent ${delivery.id} references missing attempt ${delivery.attemptId}`,
      };
    }

    const runtime = await this.repos.runtimes.findById(delivery.targetRuntimeId);
    if (!runtime) {
      return {
        kind: 'insufficient',
        reason: `Dispatch intent ${delivery.id} targets unknown runtime ${delivery.targetRuntimeId}`,
      };
    }
    if (runtime.status === 'terminated') {
      return {
        kind: 'insufficient',
        reason: `Dispatch intent ${delivery.id} targets terminated runtime ${delivery.targetRuntimeId}`,
      };
    }

    // I-2 GATE — ARMED (S6). `provider.reconcileDispatch(...)` below is a real
    // external contact, not a local read, so §11.5 gates it like every other
    // contact. The owning Pair is reached through the Attempt's FROZEN authority
    // (`sessionPairId`), never a mutable lookup, so the gate consults the same Pair
    // the dispatch was authorized against.
    //
    // `insufficient` is the correct disposition: the probe was not performed, so
    // RelayX genuinely does not know. It is NOT recorded as `not_delivered`, because
    // that would assert an external fact that was never established (I-6, I-13).
    if (attempt.sessionPairId) {
      const owningPair = await this.repos.pairs.findById(attempt.sessionPairId);
      if (owningPair && !owningPair.isProviderContactPermitted()) {
        return {
          kind: 'insufficient',
          reason:
            `Pair ${attempt.sessionPairId} is IDLE, so dispatch intent ${delivery.id} cannot be ` +
            'probed against the provider. No provider contact was made and no external state ' +
            'was inferred (DESIGN_FREEZE I-2, I-6, §11.5).',
        };
      }
    }

    let provider: IRuntimeProvider;
    try {
      provider = this.getProvider(runtime.providerType);
    } catch {
      return {
        kind: 'insufficient',
        reason: `No provider registered for '${runtime.providerType}' to reconcile dispatch ${delivery.id}`,
      };
    }

    if (typeof provider.reconcileDispatch !== 'function') {
      return {
        kind: 'insufficient',
        reason: `Provider '${runtime.providerType}' exposes no dispatch reconciliation probe`,
      };
    }

    try {
      const result = await provider.reconcileDispatch({
        sessionId: runtime.id,
        deliveryId: delivery.id,
        instructionSnippet: delivery.instructionSnippet,
        // Frozen authority is preferred over the live runtime field: the attempt records
        // what dispatch was actually authorized against (EXECUTION_AUTHORITY.md).
        externalSessionId: attempt.externalSessionId ?? runtime.externalSessionId ?? null,
        idempotencyKey: delivery.idempotencyKey,
      });

      // `delivered` is only admissible WITH verified observable evidence. Delivery
      // requires verified observable evidence (entities.ts confirmDelivered), so a bare
      // `delivered` with no evidence is not authoritative and must not be trusted.
      if (result.outcome === 'delivered') {
        if (!result.evidence) {
          return {
            kind: 'insufficient',
            reason: result.reason ?? 'Provider reported delivered without observable evidence',
          };
        }
        return { kind: 'delivered', evidence: result.evidence, reason: result.reason };
      }

      if (result.outcome === 'not_delivered') {
        return { kind: 'not_delivered', evidence: result.evidence, reason: result.reason };
      }

      // supporting_evidence_only | unknown | unsupported — all insufficient.
      return {
        kind: 'insufficient',
        evidence: result.evidence,
        reason:
          result.reason ??
          `Provider reconciliation for ${delivery.id} was '${result.outcome}', which is not authoritative`,
      };
    } catch (err) {
      return {
        kind: 'insufficient',
        reason: `Dispatch reconciliation probe failed for ${delivery.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  /**
   * Commits one terminal disposition atomically.
   *
   * The Delivery, the Attempt, the Attention item and the events land in ONE
   * transaction, so a crash mid-way can never leave an Attention item without its
   * Delivery, or a terminal Delivery that no pass will ever revisit.
   */
  private async commitDispatchDisposition(
    delivery: Delivery,
    outcome: DispatchProbeOutcome,
  ): Promise<DispatchReconciliationDispositionRecord> {
    return this.repos.runInTransaction(async () => {
      const attempt = await this.repos.attempts.findById(delivery.attemptId);

      if (outcome.kind === 'delivered') {
        // Outcome A — authoritative evidence says it landed.
        // Same Assignment, same Attempt, same Delivery. No resend, no advancement.
        delivery.confirmDelivered(outcome.evidence!);
        await this.repos.deliveries.save(delivery);

        if (attempt && attempt.status === 'prepared') {
          // startRunning() is legal only from `prepared`; a `running` attempt is
          // already in the executing state and must not be disturbed.
          attempt.startRunning();
          await this.repos.attempts.save(attempt);
        }

        await this.emitEvent('delivery', delivery.id, 'delivery.confirmed', {
          actor: 'reconciler',
          previousState: 'delivering',
          newState: 'delivered',
          evidence: outcome.evidence,
          details: { attemptId: delivery.attemptId, reason: outcome.reason },
        });

        return {
          deliveryId: delivery.id,
          attemptId: delivery.attemptId,
          assignmentId: delivery.assignmentId,
          disposition: 'delivered_confirmed',
        };
      }

      if (outcome.kind === 'not_delivered') {
        // Outcome B — proven absent. The Attempt deliberately stays `prepared`
        // (ATTEMPT_LIFECYCLE.md Case 1: intent stored, external send not performed).
        // Reconciliation establishes truth; it does NOT resend. Normal dispatch
        // machinery mints a fresh attempt with a fresh attemptNumber later.
        delivery.markFailed(outcome.reason ?? 'Provider confirmed the dispatch did not occur', outcome.evidence);
        await this.repos.deliveries.save(delivery);

        await this.emitEvent('delivery', delivery.id, 'delivery.failed', {
          actor: 'reconciler',
          previousState: 'delivering',
          newState: 'failed',
          evidence: outcome.evidence,
          details: { attemptId: delivery.attemptId, reason: outcome.reason, reconciled: true },
        });

        return {
          deliveryId: delivery.id,
          attemptId: delivery.attemptId,
          assignmentId: delivery.assignmentId,
          disposition: 'not_delivered_confirmed',
        };
      }

      // Outcome C — insufficient evidence. Conservative, operator-visible, no resend.
      const reason = outcome.reason ?? 'Dispatch outcome could not be established';
      delivery.markAmbiguous(reason, outcome.evidence);
      await this.repos.deliveries.save(delivery);

      const assignment = await this.repos.assignments.findById(delivery.assignmentId);
      const pair = assignment ? await this.repos.pairs.findById(assignment.pairId) : null;
      const runtime = await this.repos.runtimes.findById(delivery.targetRuntimeId);

      // AttentionItem carries only pairId/assignmentId, so the remaining durable
      // context is recorded in the message, matching the existing ambiguous path.
      const attention = AttentionItem.create(
        'critical',
        'ambiguous_delivery',
        'Unresolved dispatch intent after restart',
        [
          `RelayX could not determine whether a dispatched instruction reached the worker.`,
          `Project: ${pair?.projectId ?? 'unknown'}.`,
          `Assignment: ${delivery.assignmentId}.`,
          `Attempt: ${delivery.attemptId} (status ${attempt?.status ?? 'unknown'}).`,
          `Delivery: ${delivery.id}.`,
          `Target runtime: ${delivery.targetRuntimeId}${runtime ? ` (${runtime.name}, ${runtime.providerType})` : ''}.`,
          `Idempotency key: ${delivery.idempotencyKey}.`,
          `Reason: ${reason}.`,
          `No instruction was resent. Confirm the worker state before any further dispatch.`,
        ].join(' '),
        {
          pairId: pair?.id,
          assignmentId: delivery.assignmentId,
          suggestedAction:
            'Inspect the worker session and determine whether the instruction was received, then confirm delivery or reset the attempt. Automated resend stays blocked.',
          suggestedTier: 'tier_1_deterministic',
        },
      );
      await this.repos.attention.save(attention);

      await this.emitEvent('delivery', delivery.id, 'delivery.ambiguous', {
        actor: 'reconciler',
        previousState: 'delivering',
        newState: 'ambiguous',
        evidence: outcome.evidence,
        details: { attemptId: delivery.attemptId, reason, attentionItemId: attention.id },
      });

      return {
        deliveryId: delivery.id,
        attemptId: delivery.attemptId,
        assignmentId: delivery.assignmentId,
        disposition: 'ambiguous_raised',
        attentionItemId: attention.id,
      };
    });
  }

  /**
   * Recovers state upon application startup or following an unexpected restart (Phase 9).
   * Reconciles in-flight assignments and runtimes against active desktop processes.
   *
   * I-2 GATE — ARMED (S6). This path inspects provider runtimes at startup, so
   * §11.5 requires it to be gated on `operational_state === 'ACTIVE'` like every
   * other provider contact. An IDLE Pair is skipped, which is what makes restart
   * deterministic: a persisted IDLE Pair costs zero provider calls.
   *
   * This path NEVER activates a Pair (§4.2: IDLE -> ACTIVE is never automatic), and
   * a legacy `status='active'` cannot override `operationalState='IDLE'`.
   *
   * `reconcileUnresolvedDispatches` below reaches `provider.reconcileDispatch` —
   * a real external contact — and is gated in its own right, in
   * `probeDispatchOutcome`.
   */
  public async recoverOnStartup(): Promise<{
    reconciledAssignments: number;
    suspendedRuntimes: number;
    recoveredHandoffs: number;
    dispatchIntents: DispatchReconciliationReport;
  }> {
    // Dispatch ground truth is established FIRST. Reconciliation of a stranded
    // delivery decides whether work is already in flight, so it must not be
    // influenced by — or race with — runtime observation below, which can create
    // handoffs and change assignment state.
    const dispatchIntents = await this.reconcileUnresolvedDispatches();

    let reconciledAssignments = 0;
    let suspendedRuntimes = 0;
    let recoveredHandoffs = 0;

    const activeAssignments = await this.repos.assignments.findActive();
    for (const assignment of activeAssignments) {
      const pair = await this.repos.pairs.findById(assignment.pairId);
      if (!pair) continue;
      if (!pair.isProviderContactPermitted()) continue;
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

    return { reconciledAssignments, suspendedRuntimes, recoveredHandoffs, dispatchIntents };
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
    //
    // Pre-dispatch reconciliation runs here, at the engine boundary, BEFORE any new work
    // is selected for execution. This is the "before new dispatch selection" hook: a
    // dispatch intent stranded by a previous crash is resolved to a terminal disposition
    // first, so the engine never accumulates fresh work on top of an unresolved one.
    //
    // It is intentionally NOT inside the Plan-First domain and NOT inside
    // `dispatchAssignment`. This is engine/dispatch reliability, and the Plan-First
    // controller's own handling of `prepared | running` below is untouched.
    await this.reconcileUnresolvedDispatches();

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
    // I-2 GATE — ARMED (S6). `provider.detectWorkingState(...)` below is a real
    // external contact, so §11.5 gates it. The observation it produces is recorded
    // on the runtime and never promotes a WorkUnit, so skipping it for an IDLE Pair
    // loses no derived state — the only thing lost is a contact I-2 forbids.
    if (pair?.workerSessionId && pair.isProviderContactPermitted()) {
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
