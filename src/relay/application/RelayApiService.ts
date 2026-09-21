import {
  BrowserChatGPTProvider,
  BrowserOpenCodeProvider,
} from '../providers/browserProviders.ts';
import { IRelayRepositories } from '../persistence/interfaces.ts';
import { RelayEngine } from './RelayEngine.ts';
import {
  IRelayApi,
  DashboardState,
  SupervisionResult,
  AppStatus,
} from '../../types/relayApi.ts';
import {
  UIPair,
  UIProject,
  UIRuntimeSession,
  UIAssignment,
  UIEvent,
  UIAttentionItem,
  ObservableEvidence,
  ProviderType,
} from '../../types/ui.ts';
import {
  ProjectId,
  PairId,
  RuntimeSessionId,
  AssignmentId,
  HandoffId,
  DeliveryId,
  AttentionItemId,
} from '../domain/types.ts';
import path from 'node:path';

export interface RelayApiServiceOptions {
  isElectron?: boolean;
  databasePath?: string;
  databaseType?: 'sqlite_wal' | 'memory';
  userDataPath?: string;
}

export class RelayApiService implements IRelayApi {
  private readonly isElectron: boolean;
  private readonly databasePath: string;
  private readonly databaseType: 'sqlite_wal' | 'memory';
  private readonly userDataPath?: string;

  constructor(
    public readonly db: IRelayRepositories,
    public readonly engine: RelayEngine,
    options: RelayApiServiceOptions = {},
  ) {
    this.isElectron = options.isElectron ?? false;
    this.databasePath = options.databasePath ?? ':memory:';
    this.databaseType = options.databaseType ?? (this.databasePath === ':memory:' ? 'memory' : 'sqlite_wal');
    this.userDataPath = options.userDataPath;
  }

  public async getAppStatus(): Promise<AppStatus> {
    const isNode = typeof process !== 'undefined';
    let permissions: AppStatus['permissions'] = undefined;

    if (isNode) {
      if (process.platform === 'darwin') {
        try {
          const { execSync } = require('child_process');
          execSync('osascript -e \'tell application "System Events" to get name of current user\'', {
            timeout: 1200,
            stdio: 'pipe',
          });
          permissions = {
            accessibilityGranted: true,
            systemEventsAvailable: true,
            notes: 'Accessibility and System Events automation verified active',
          };
        } catch (err: any) {
          const stderr = String(err.stderr || err.message || '');
          const isDenied = stderr.includes('-1743') || stderr.includes('not allowed') || stderr.includes('Assistive');
          permissions = {
            accessibilityGranted: !isDenied,
            systemEventsAvailable: false,
            notes: isDenied
              ? 'macOS Accessibility / System Events permission denied. Enable in System Settings > Privacy & Security > Accessibility.'
              : 'Permission check error: ' + stderr,
          };
        }
      } else {
        permissions = {
          accessibilityGranted: false,
          systemEventsAvailable: false,
          notes: `Host platform is ${process.platform}. macOS Accessibility is only applicable on darwin.`,
        };
      }
    }

    return {
      isElectron: this.isElectron,
      platform: isNode ? process.platform : 'web',
      electronVersion: isNode && process.versions ? (process.versions as any).electron : undefined,
      chromeVersion: isNode && process.versions ? process.versions.chrome : undefined,
      nodeVersion: isNode && process.versions ? process.versions.node : undefined,
      userDataPath: this.userDataPath,
      databasePath: this.databasePath,
      databaseType: this.databaseType,
      permissions,
    };
  }

  public async getDashboardState(): Promise<DashboardState> {
    const [projects, pairs, runtimes, assignments, openAttention, ambiguousDeliveriesList, recentEvents] =
      await Promise.all([
        this.db.projects.findAll(),
        this.db.pairs.findAll(),
        this.db.runtimes.findAll(),
        this.db.assignments.findAll(),
        this.db.attention.findOpen(),
        this.db.deliveries.findAmbiguous(),
        this.listEvents(30),
      ]);

    const activeWorkers = runtimes.filter((r) => r.status === 'working').length;
    const activeAssignments = assignments.filter(
      (a) => a.status === 'active' || a.status === 'pending',
    ).length;
    const waitingReview = assignments.filter((a) => a.status === 'waiting_for_handoff').length;
    const ambiguousDeliveries = ambiguousDeliveriesList.length;

    return {
      metrics: {
        totalProjects: projects.length,
        totalPairs: pairs.length,
        totalRuntimes: runtimes.length,
        activeWorkers,
        activeAssignments,
        waitingReview,
        openAttentionItems: openAttention.length,
        ambiguousDeliveries,
      },
      recentEvents,
    };
  }

  public async listProjects(): Promise<UIProject[]> {
    const projects = await this.db.projects.findAll();
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      canonicalPath: p.canonicalPath,
      gitRoot: p.gitRoot,
      status: p.status || 'active',
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  }

  public async getProject(id: string): Promise<UIProject | null> {
    const p = await this.db.projects.findById(id as ProjectId);
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      canonicalPath: p.canonicalPath,
      gitRoot: p.gitRoot,
      status: p.status || 'active',
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  public async createProject(name: string, description = ''): Promise<UIProject> {
    const p = await this.engine.createProject(name, description);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      canonicalPath: p.canonicalPath,
      gitRoot: p.gitRoot,
      status: p.status || 'active',
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  public async updateProject(
    id: string,
    nameOrProps: string | { name?: string; description?: string },
    maybeDescription?: string,
  ): Promise<UIProject> {
    let name: string | undefined;
    let description: string | undefined;
    if (typeof nameOrProps === 'object') {
      name = nameOrProps.name;
      description = nameOrProps.description;
    } else {
      name = nameOrProps;
      description = maybeDescription;
    }

    const p = await this.engine.updateProject(id as ProjectId, name, description);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      canonicalPath: p.canonicalPath,
      gitRoot: p.gitRoot,
      status: p.status || 'active',
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  public async archiveProject(id: string): Promise<UIProject> {
    const p = await this.engine.archiveProject(id as ProjectId);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      canonicalPath: p.canonicalPath,
      gitRoot: p.gitRoot,
      status: p.status || 'active',
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  public async unarchiveProject(id: string): Promise<UIProject> {
    const p = await this.engine.unarchiveProject(id as ProjectId);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      canonicalPath: p.canonicalPath,
      gitRoot: p.gitRoot,
      status: p.status || 'active',
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  public async canDeleteProject(id: string): Promise<{ canDelete: boolean; reasons: string[] }> {
    return this.engine.canDeleteProject(id as ProjectId);
  }

  public async deleteProject(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.engine.deleteProject(id as ProjectId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  public async listPairs(): Promise<UIPair[]> {
    const pairs = await this.db.pairs.findAll();
    const result: UIPair[] = [];

    for (const pair of pairs) {
      const project = await this.db.projects.findById(pair.projectId);
      const planner = pair.plannerSessionId ? await this.db.runtimes.findById(pair.plannerSessionId) : null;
      const worker = pair.workerSessionId ? await this.db.runtimes.findById(pair.workerSessionId) : null;

      let activeAssignmentTitle: string | undefined;
      let activeAssignmentStatus: any;
      let deliveryStatus: any;
      let deliveryEvidence: ObservableEvidence | undefined;
      let handoffStatus: any;
      let handoffSummary: string | undefined;

      if (pair.activeAssignmentId) {
        const assignment = await this.db.assignments.findById(pair.activeAssignmentId);
        if (assignment) {
          activeAssignmentTitle = assignment.title;
          activeAssignmentStatus = assignment.status;

          if (assignment.activeDeliveryId) {
            const deliv = await this.db.deliveries.findById(assignment.activeDeliveryId);
            deliveryStatus = deliv?.status;
            deliveryEvidence = deliv?.evidence;
          }

          if (assignment.activeHandoffId) {
            const handoff = await this.db.handoffs.findById(assignment.activeHandoffId);
            handoffStatus = handoff?.status;
            handoffSummary = handoff?.resultSummary;
          }
        }
      }

      result.push({
        id: pair.id,
        projectId: pair.projectId,
        projectName: project?.name ?? 'Unknown Project',
        name: pair.name,
        plannerSessionId: pair.plannerSessionId,
        workerSessionId: pair.workerSessionId,
        plannerName: planner?.name ?? (pair.plannerSessionId ? 'Planner' : 'Unassigned'),
        plannerProvider: planner?.providerType ?? 'chatgpt',
        plannerStatus: planner?.status ?? (pair.plannerSessionId ? 'unknown' : 'unavailable'),
        workerName: worker?.name ?? (pair.workerSessionId ? 'Worker' : 'Unassigned'),
        workerProvider: worker?.providerType ?? 'opencode',
        workerStatus: worker?.status ?? (pair.workerSessionId ? 'unknown' : 'unavailable'),
        activeAssignmentId: pair.activeAssignmentId,
        activeAssignmentTitle,
        activeAssignmentStatus,
        deliveryStatus,
        deliveryEvidence,
        handoffStatus,
        handoffSummary,
        status: pair.status,
        lastSupervisedAt: pair.lastSupervisedAt,
      });
    }

    return result;
  }

  public async getPair(id: string): Promise<UIPair | null> {
    const pairs = await this.listPairs();
    return pairs.find((p) => p.id === id) ?? null;
  }

  public async createPair(
    projectId: string,
    name: string,
    plannerSessionId?: string,
    workerSessionId?: string,
  ): Promise<UIPair> {
    // Service-layer cross-project guard: selected runtimes must match expected roles
    if (plannerSessionId) {
      const p = await this.db.runtimes.findById(plannerSessionId as RuntimeSessionId);
      if (p && p.providerType !== 'chatgpt') throw new Error('Planner session must be ChatGPT');
    }
    if (workerSessionId) {
      const w = await this.db.runtimes.findById(workerSessionId as RuntimeSessionId);
      if (w && w.providerType !== 'opencode' && w.providerType !== 'vscode') throw new Error('Worker session must be OpenCode or VS Code');
    }
    // Project-ownership invariant: each selected runtime must belong to the selected project.
    if (plannerSessionId || workerSessionId) {
      const planner = plannerSessionId
        ? await this.db.runtimes.findById(plannerSessionId as RuntimeSessionId)
        : null;
      const worker = workerSessionId
        ? await this.db.runtimes.findById(workerSessionId as RuntimeSessionId)
        : null;
      const proj = await this.db.projects.findById(projectId as ProjectId);
      if (!proj) throw new Error('Project not found');
      const normalizeChatRef = (ref: string | null): string => {
        if (!ref) return '';
        const match = ref.match(/(?:^|\/g\/)(g-p-[^/?#]+)/i);
        return (match?.[1] ?? ref).replace(/\/$/, '').toLowerCase();
      };
      if (plannerSessionId && (!planner || !planner.externalProjectRef || !proj.plannerProjectUrl)) {
        throw new Error('Cross-project pairing: planner project ownership cannot be proven');
      }
      const plannerNorm = normalizeChatRef(planner?.externalProjectRef ?? null);
      const projNorm = normalizeChatRef(proj.plannerProjectUrl ?? null);
      if (plannerSessionId && plannerNorm !== projNorm) {
        throw new Error('Cross-project pairing: planner session belongs to different ChatGPT project');
      }
      const normalizeWorkerPath = (ref: string | null): string => {
        if (!ref) return '';
        return path.posix.normalize(ref.replaceAll('\\', '/')).replace(/\/$/, '');
      };
      if (workerSessionId && (!worker || !worker.externalProjectRef || !proj.workerWorkspacePath)) {
        throw new Error('Cross-project pairing: worker project ownership cannot be proven');
      }
      const normProjWorker = normalizeWorkerPath(proj.workerWorkspacePath ?? null);
      const normWorkerRef = normalizeWorkerPath(worker?.externalProjectRef ?? null);
      if (workerSessionId && normWorkerRef !== normProjWorker) {
        throw new Error('Cross-project pairing: worker session belongs to different workspace');
      }
    }
    const pair = await this.engine.createPair(
      projectId as ProjectId,
      name,
      plannerSessionId as RuntimeSessionId | undefined,
      workerSessionId as RuntimeSessionId | undefined,
    );
    const populated = await this.getPair(pair.id);
    if (!populated) throw new Error('Failed to retrieve created pair');
    return populated;
  }

  public async updatePair(
    id: string,
    updates: { name?: string; plannerSessionId?: string | null; workerSessionId?: string | null },
  ): Promise<UIPair> {
    const pair = await this.engine.updatePair(id as PairId, {
      name: updates.name,
      plannerSessionId: updates.plannerSessionId as RuntimeSessionId | null | undefined,
      workerSessionId: updates.workerSessionId as RuntimeSessionId | null | undefined,
    });
    const populated = await this.getPair(pair.id);
    if (!populated) throw new Error(`Pair ${id} not found`);
    return populated;
  }

  public async rebindPairPlanner(pairId: string, plannerSessionId: string): Promise<UIPair> {
    return this.updatePair(pairId, { plannerSessionId });
  }

  public async rebindPairWorker(pairId: string, workerSessionId: string): Promise<UIPair> {
    return this.updatePair(pairId, { workerSessionId });
  }

  public async detachPairRuntime(pairId: string, role: 'planner' | 'worker'): Promise<UIPair> {
    const pair = await this.engine.detachPairRuntime(pairId as PairId, role);
    const populated = await this.getPair(pair.id);
    if (!populated) throw new Error(`Pair ${pairId} not found`);
    return populated;
  }

  public async startPair(pairId: string): Promise<UIPair> {
    await this.engine.startPair(pairId as PairId);
    const p = await this.getPair(pairId);
    if (!p) throw new Error(`Pair ${pairId} not found`);
    return p;
  }

  public async pausePair(pairId: string): Promise<UIPair> {
    await this.engine.pausePair(pairId as PairId);
    const p = await this.getPair(pairId);
    if (!p) throw new Error(`Pair ${pairId} not found`);
    return p;
  }

  public async resumePair(pairId: string): Promise<UIPair> {
    await this.engine.resumePair(pairId as PairId);
    const p = await this.getPair(pairId);
    if (!p) throw new Error(`Pair ${pairId} not found`);
    return p;
  }

  public async stopPair(pairId: string): Promise<UIPair> {
    await this.engine.stopPair(pairId as PairId);
    const p = await this.getPair(pairId);
    if (!p) throw new Error(`Pair ${pairId} not found`);
    return p;
  }

  public async archivePair(id: string): Promise<UIPair> {
    const pair = await this.engine.archivePair(id as PairId);
    const populated = await this.getPair(pair.id);
    if (!populated) throw new Error(`Pair ${id} not found`);
    return populated;
  }

  public async unarchivePair(id: string): Promise<UIPair> {
    const pair = await this.engine.unarchivePair(id as PairId);
    const populated = await this.getPair(pair.id);
    if (!populated) throw new Error(`Pair ${id} not found`);
    return populated;
  }

  public async canDeletePair(id: string): Promise<{ canDelete: boolean; reasons: string[] }> {
    return this.engine.canDeletePair(id as PairId);
  }

  public async deletePair(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.engine.deletePair(id as PairId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  public async detachRuntime(sessionId: string): Promise<{ success: boolean; detachedFromPairs: string[] }> {
    return this.engine.detachRuntime(sessionId as RuntimeSessionId);
  }

  public async canDeleteRuntimeSession(sessionId: string): Promise<{ canDelete: boolean; reasons: string[] }> {
    return this.engine.canDeleteRuntimeSession(sessionId as RuntimeSessionId);
  }

  public async deleteRuntimeSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.engine.deleteRuntimeSession(sessionId as RuntimeSessionId);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  public async archiveRuntimeSession(sessionId: string, reason?: string): Promise<UIRuntimeSession> {
    const r = await this.engine.archiveRuntimeSession(sessionId as RuntimeSessionId, reason);
    let integrationStatus: any = 'unsupported';
    try {
      const provider = this.engine.getProvider(r.providerType);
      integrationStatus = provider.integrationStatus;
    } catch {
      // ignore
    }

    return {
      id: r.id,
      providerType: r.providerType,
      name: r.name,
      bundleIdentifier: r.bundleIdentifier,
      windowTitle: r.windowTitle,
      applicationPid: r.applicationPid,
      status: r.status,
      consecutiveObservationFailures: r.consecutiveObservationFailures,
      integrationStatus,
      lastHeartbeatAt: r.lastHeartbeatAt,
      lastObservedAt: r.lastObservedAt,
      lastEvidence: r.lastEvidence,
      archivedAt: r.archivedAt,
      archiveReason: r.archiveReason,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  public async unarchiveRuntimeSession(sessionId: string): Promise<UIRuntimeSession> {
    const r = await this.engine.unarchiveRuntimeSession(sessionId as RuntimeSessionId);
    let integrationStatus: any = 'unsupported';
    try {
      const provider = this.engine.getProvider(r.providerType);
      integrationStatus = provider.integrationStatus;
    } catch {
      // ignore
    }

    return {
      id: r.id,
      providerType: r.providerType,
      name: r.name,
      bundleIdentifier: r.bundleIdentifier,
      windowTitle: r.windowTitle,
      applicationPid: r.applicationPid,
      status: r.status,
      consecutiveObservationFailures: r.consecutiveObservationFailures,
      integrationStatus,
      lastHeartbeatAt: r.lastHeartbeatAt,
      lastObservedAt: r.lastObservedAt,
      lastEvidence: r.lastEvidence,
      archivedAt: r.archivedAt,
      archiveReason: r.archiveReason,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  public async listRuntimeSessions(): Promise<UIRuntimeSession[]> {
    const runtimes = await this.db.runtimes.findAll();
    return runtimes.map((r) => {
      let integrationStatus: any = 'unsupported';
      try {
        const provider = this.engine.getProvider(r.providerType);
        integrationStatus = provider.integrationStatus;
      } catch {
        integrationStatus = 'unsupported';
      }

      return {
        id: r.id,
        providerType: r.providerType,
        name: r.name,
        bundleIdentifier: r.bundleIdentifier,
        windowTitle: r.windowTitle,
        applicationPid: r.applicationPid,
        status: r.status,
        consecutiveObservationFailures: r.consecutiveObservationFailures,
        integrationStatus,
        lastHeartbeatAt: r.lastHeartbeatAt,
        lastObservedAt: r.lastObservedAt,
        lastEvidence: r.lastEvidence,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  public async registerRuntimeSession(
    providerType: ProviderType,
    name: string,
    bundleIdentifier?: string,
  ): Promise<UIRuntimeSession> {
    const runtime = await this.engine.registerRuntimeSession(providerType, name, bundleIdentifier);
    let integrationStatus: any = 'unsupported';
    try {
      const provider = this.engine.getProvider(providerType);
      integrationStatus = provider.integrationStatus;
    } catch {
      // not registered
    }

    return {
      id: runtime.id,
      providerType: runtime.providerType,
      name: runtime.name,
      bundleIdentifier: runtime.bundleIdentifier,
      windowTitle: runtime.windowTitle,
      applicationPid: runtime.applicationPid,
      status: runtime.status,
      consecutiveObservationFailures: runtime.consecutiveObservationFailures,
      integrationStatus,
      lastHeartbeatAt: runtime.lastHeartbeatAt,
      lastObservedAt: runtime.lastObservedAt,
      lastEvidence: runtime.lastEvidence,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt,
    };
  }

  public async discoverRuntime(
    providerType: ProviderType,
  ): Promise<{ success: boolean; runtime?: UIRuntimeSession; isNew?: boolean; error?: string }> {
    try {
      const { runtime, inspection, isNew } = await this.engine.discoverRuntime(providerType);
      let integrationStatus: any = 'unsupported';
      try {
        const provider = this.engine.getProvider(providerType);
        integrationStatus = provider.integrationStatus;
      } catch {
        // ignore
      }

      return {
        success: inspection.found,
        isNew,
        runtime: {
          id: runtime.id,
          providerType: runtime.providerType,
          name: runtime.name,
          bundleIdentifier: runtime.bundleIdentifier,
          windowTitle: runtime.windowTitle,
          applicationPid: runtime.applicationPid,
          status: runtime.status,
          consecutiveObservationFailures: runtime.consecutiveObservationFailures,
          integrationStatus,
          lastHeartbeatAt: runtime.lastHeartbeatAt,
          lastObservedAt: runtime.lastObservedAt,
          lastEvidence: runtime.lastEvidence,
          createdAt: runtime.createdAt,
          updatedAt: runtime.updatedAt,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Discovery failed' };
    }
  }

  public async inspectRuntime(sessionId: string): Promise<{ success: boolean; evidence?: ObservableEvidence; error?: string }> {
    const runtime = await this.db.runtimes.findById(sessionId as RuntimeSessionId);
    if (!runtime) return { success: false, error: 'Runtime session not found' };

    try {
      const provider = this.engine.getProvider(runtime.providerType);
      const inspection = await provider.inspectRuntime(runtime.id);

      if (inspection.found) {
        runtime.recordObservationSuccess(
          inspection.isWorking ? 'working' : 'available',
          inspection.evidence,
          inspection.windowTitle,
          inspection.applicationPid,
        );
      } else {
        runtime.recordObservationFailure();
      }
      await this.db.runtimes.save(runtime);

      // Persist authoritative external identity when evidence carries it.
      const details = (inspection.evidence?.details || {}) as any;
      if (details.authoritativeSessionId || details.parsedSessionId || details.workspacePath || details.projectUrl) {
        const extId = details.authoritativeSessionId || details.parsedSessionId || (details.openCodeProjectId ? details.openCodeProjectId : undefined);
        if (extId && runtime.externalSessionId !== extId) {
          const projRef = runtime.providerType === 'opencode'
            ? (details.workspacePath || runtime.externalProjectRef || null)
            : (details.projectUrl || details.projectName || runtime.externalProjectRef || null);
          runtime.updateExternalIdentity(extId, projRef);
          await this.db.runtimes.save(runtime);
        }
      }

      return {
        success: inspection.found,
        evidence: inspection.evidence,
      };
    } catch (err) {
      runtime.recordObservationFailure();
      await this.db.runtimes.save(runtime);
      return { success: false, error: (err as Error).message };
    }
  }

  public async recoverRuntime(sessionId: string): Promise<{ success: boolean; restored: boolean }> {
    try {
      const recovered = await this.engine.reconcileAndRecoverRuntime(sessionId as RuntimeSessionId);
      return { success: true, restored: recovered.status !== 'suspended' && recovered.status !== 'unknown' };
    } catch {
      return { success: false, restored: false };
    }
  }

  public async listAssignments(): Promise<UIAssignment[]> {
    const assignments = await this.db.assignments.findAll();
    const result: UIAssignment[] = [];

    for (const a of assignments) {
      const pair = await this.db.pairs.findById(a.pairId);
      let deliveryStatus: any;
      let handoffStatus: any;

      if (a.activeDeliveryId) {
        const d = await this.db.deliveries.findById(a.activeDeliveryId);
        deliveryStatus = d?.status;
      }
      if (a.activeHandoffId) {
        const h = await this.db.handoffs.findById(a.activeHandoffId);
        handoffStatus = h?.status;
      }

      result.push({
        id: a.id,
        pairId: a.pairId,
        pairName: pair?.name ?? 'Unknown Pair',
        projectId: a.projectId,
        title: a.title,
        instruction: a.instruction,
        status: a.status,
        activeDeliveryStatus: deliveryStatus,
        activeHandoffStatus: handoffStatus,
        createdAt: a.createdAt,
        completedAt: a.completedAt,
      });
    }

    return result;
  }

  public async createAssignment(pairId: string, title: string, instruction: string): Promise<UIAssignment> {
    const assignment = await this.engine.createAssignment(pairId as PairId, title, instruction);
    const pair = await this.db.pairs.findById(pairId as PairId);

    return {
      id: assignment.id,
      pairId: assignment.pairId,
      pairName: pair?.name ?? 'Unknown Pair',
      projectId: assignment.projectId,
      title: assignment.title,
      instruction: assignment.instruction,
      status: assignment.status,
      createdAt: assignment.createdAt,
    };
  }

  public async dispatchAssignment(assignmentId: string): Promise<{ success: boolean; deliveryOutcome: string }> {
    const result = await this.engine.dispatchAssignment(assignmentId as AssignmentId);
    return {
      success: result.delivery.status === 'delivered',
      deliveryOutcome: result.delivery.status,
    };
  }

  public async completeAssignment(assignmentId: string): Promise<{ success: boolean }> {
    await this.engine.completeAssignment(assignmentId as AssignmentId);
    return { success: true };
  }

  public async deliverHandoff(handoffId: string): Promise<{ success: boolean }> {
    await this.engine.deliverHandoffToPlanner(handoffId as HandoffId);
    return { success: true };
  }

  public async resolveAmbiguousDelivery(
    deliveryId: string,
    resolution: 'confirmed_delivered' | 'retry_permitted',
  ): Promise<{ success: boolean }> {
    await this.engine.resolveAmbiguousDelivery(deliveryId as DeliveryId, resolution);
    return { success: true };
  }

  public async listEvents(limit = 50, resourceId?: string): Promise<UIEvent[]> {
    const events = resourceId
      ? await this.db.events.findByResourceId(resourceId)
      : await this.db.events.findRecent(limit);

    return events.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      eventType: e.eventType,
      actor: e.actor,
      previousState: e.previousState,
      newState: e.newState,
      correlationId: e.correlationId,
      evidence: e.evidence,
      details: e.details,
    }));
  }

  public async listAttentionItems(): Promise<UIAttentionItem[]> {
    const items = await this.db.attention.findAll();
    return items.map((i) => ({
      id: i.id,
      pairId: i.pairId,
      assignmentId: i.assignmentId,
      severity: i.severity,
      status: i.status,
      type: i.type,
      title: i.title,
      message: i.message,
      suggestedAction: i.suggestedAction,
      suggestedTier: i.suggestedTier,
      createdAt: i.createdAt,
    }));
  }

  public async acknowledgeAttentionItem(id: string): Promise<{ success: boolean }> {
    const item = await this.db.attention.findById(id as AttentionItemId);
    if (!item) return { success: false };
    item.acknowledge();
    await this.db.attention.save(item);
    return { success: true };
  }

  public async runSupervisionTick(): Promise<SupervisionResult> {
    return this.engine.runSupervisionTick();
  }

  public async seedDemoEnvironment(): Promise<{ success: boolean; seeded: boolean }> {
    const existingProjects = await this.db.projects.findAll();
    if (existingProjects.length > 0) {
      return { success: true, seeded: false };
    }

    const proj = await this.engine.createProject(
      'Cloud Architecture Migration',
      'Refactoring microservices into modular TypeScript packages with deterministic recovery.',
    );

    const planner = await this.engine.registerRuntimeSession(
      'chatgpt',
      'ChatGPT Desktop (Architect Planner)',
      'com.openai.chat',
    );
    planner.recordObservationSuccess('available', {
      id: `ev_demo_${Date.now()}_1`,
      timestamp: Date.now() - 30000,
      source: 'reconciliation_probe',
      windowTitle: 'ChatGPT - Desktop Planner',
      applicationPid: 52140,
      bundleIdentifier: 'com.openai.chat',
      visibleButtonState: { sendButtonVisible: true, stopButtonVisible: false },
    });
    await this.db.runtimes.save(planner);

    const worker = await this.engine.registerRuntimeSession(
      'opencode',
      'OpenCode CLI Session (Worker)',
      'com.opencode.desktop',
    );
    worker.recordObservationSuccess('available', {
      id: `ev_demo_${Date.now()}_2`,
      timestamp: Date.now() - 20000,
      source: 'reconciliation_probe',
      windowTitle: 'OpenCode Session [backend-core]',
      applicationPid: 52141,
      bundleIdentifier: 'com.opencode.desktop',
      visibleButtonState: { sendButtonVisible: true, stopButtonVisible: false },
    });
    await this.db.runtimes.save(worker);

    const pair = await this.engine.createPair(
      proj.id,
      'Architecture & Implementation Pair',
      planner.id,
      worker.id,
    );

    const assignment = await this.engine.createAssignment(
      pair.id,
      'Implement Idempotent IPC Bridge',
      'Verify that all Electron IPC channels enforce atomic database transactions and return typed observables.',
    );

    await this.engine.dispatchAssignment(assignment.id);

    return { success: true, seeded: true };
  }

  public async clearDatabase(): Promise<{ success: boolean }> {
    // Re-initialize tables
    if ('db' in this.db && (this.db as any).db) {
      const rawDb = (this.db as any).db;
      rawDb.exec(`
        DELETE FROM events;
        DELETE FROM attention_items;
        DELETE FROM handoffs;
        DELETE FROM deliveries;
        DELETE FROM attempts;
        DELETE FROM assignments;
        DELETE FROM pairs;
        DELETE FROM runtime_sessions;
        DELETE FROM projects;
      `);
    }
    return { success: true };
  }

  /* --- Add Project Workflow --- */

  public async selectProjectFolder(): Promise<{
    success: boolean;
    path?: string;
    basename?: string;
    gitRoot?: string;
    existingProjectId?: ProjectId;
    error?: string;
  }> {
    if (!this.isElectron) {
      return { success: false, error: 'Native folder picker is only available in Electron.' };
    }

    try {
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog({
        title: 'Select Project Folder',
        properties: ['openDirectory', 'createDirectory'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false };
      }

      const folderPath = result.filePaths[0];
      const path = require('path');
      const fs = require('fs');

      const basename = path.basename(folderPath);
      let gitRoot: string | undefined = undefined;

      // Git root discovery
      let current = folderPath;
      while (current && current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, '.git'))) {
          gitRoot = current;
          break;
        }
        current = path.dirname(current);
      }

      const existing = await this.db.projects.findByPath(folderPath);

      return {
        success: true,
        path: folderPath,
        basename,
        gitRoot,
        existingProjectId: existing?.id,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async resolveChatGPTProject(name: string): Promise<{
    success: boolean;
    projectUrl?: string;
    error?: string;
    foundMultiple?: Array<{ name: string; url: string }>;
    diagnostics?: any;
  }> {
    try {
      const provider = this.engine.getProvider('chatgpt') as any;
      if (!provider || typeof provider.resolveChatGPTProject !== 'function') {
        return { success: false, error: 'ChatGPT provider does not support project resolution' };
      }
      return await provider.resolveChatGPTProject(name);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async discoverOpenCodeSessions(projectPath: string, gitRoot?: string): Promise<{
    success: boolean;
    sessions: any[];
    diagnostics?: any;
    error?: string;
  }> {
    try {
      const provider = this.engine.getProvider('opencode') as any;
      if (!provider || typeof provider.matchSessionsByPath !== 'function') {
        return { success: false, sessions: [], error: 'OpenCode provider does not support session matching' };
      }
      const matchRes = await provider.matchSessionsByPath(projectPath, gitRoot);
      const sessions = matchRes.sessions || [];
      const diagnostics = matchRes.diagnostics;

      return {
        success: true,
        sessions: sessions.map((m: any) => {
          const details = (m.evidence?.details || {}) as any;
          // Only an authoritative id (shared service / persisted store) may
          // become the bound worker session. Window-derived ids are display-only.
          const authoritativeSessionId =
            details.authoritativeSessionId || details.parsedSessionId;
          return {
            sessionId: authoritativeSessionId,
            authoritativeSessionId,
            observedWindowSessionId: details.observedWindowSessionId,
            authoritative: !!authoritativeSessionId,
            windowTitle: m.windowTitle,
            workspacePath: details.workspacePath,
            matchScore: details.matchScore,
            matchedVia: details.matchedVia,
            openCodeProjectId: details.openCodeProjectId,
            hasUiCorrelation: details.hasUiCorrelation,
          };
        }),
        diagnostics,
      };
    } catch (err: any) {
      return { success: false, sessions: [], error: err.message };
    }
  }

  public async discoverChatGPTPlanner(name: string): Promise<{
    success: boolean;
    finalUrl?: string;
    projectName?: string;
    error?: string;
    diagnostics?: any;
  }> {
    try {
      const provider = this.engine.getProvider('chatgpt') as any;
      if (!provider || typeof provider.resolveChatGPTProject !== 'function') {
        return { success: false, error: 'ChatGPT provider does not support project resolution' };
      }
      return await provider.resolveChatGPTProject(name);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public async finalizeProjectSetup(setup: {
    name: string;
    description: string;
    canonicalPath: string;
    gitRoot?: string;
    plannerUrl?: string;
    workerSessionId?: string;
  }): Promise<{ success: boolean; projectId?: ProjectId; error?: string }> {
    try {
      if (!setup.workerSessionId || !setup.workerSessionId.trim()) {
        return {
          success: false,
          error: 'An authoritative OpenCode worker session is required before creating a project.',
        };
      }

      // 1. Create Project
      const project = await this.engine.createProject(
        setup.name,
        setup.description,
        setup.canonicalPath,
        setup.gitRoot,
      );

      // 2. Register/Find Runtimes
      let plannerId: RuntimeSessionId | undefined;
      if (setup.plannerUrl) {
        const planner = await this.engine.registerRuntimeSession(
          'chatgpt',
          `ChatGPT: ${setup.name}`,
          'com.openai.chat',
        );
        // Bind the URL to the session details
        planner.recordObservationSuccess('available', {
          id: `ev_bind_${Date.now()}`,
          timestamp: Date.now(),
          source: 'reconciliation_probe',
          windowTitle: `ChatGPT - ${setup.name}`,
          details: { projectUrl: setup.plannerUrl },
        });
        await this.db.runtimes.save(planner);
        plannerId = planner.id;
      }

      const worker = await this.engine.registerRuntimeSession(
        'opencode',
        `OpenCode: ${setup.name}`,
        'dev.opencode.desktop',
      );
      worker.recordObservationSuccess('available', {
        id: `ev_bind_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        details: { sessionId: setup.workerSessionId },
      });
      await this.db.runtimes.save(worker);
      const workerId = worker.id;

      // 3. Create Default Pair
      await this.engine.createPair(
        project.id,
        'Default Pair',
        plannerId,
        workerId,
      );

      return { success: true, projectId: project.id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
