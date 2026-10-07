/**
 * ============================================================================
 * RELAY API SERVICE — APPLICATION SERVICE & UI INTEGRATION LAYER
 * ============================================================================
 *
 * `RelayApiService` is the primary application boundary connecting frontend UI
 * views, background bridge pollers, and management workflows to the underlying
 * `RelayEngine` and SQLite repositories.
 *
 * RESPONSIBILITIES:
 * 1. Project Onboarding & Discovery Wizard:
 *    - Decoupled discovery of existing ChatGPT projects (`resolveChatGPTProject`).
 *    - Directory-scoped OpenCode session matching (`discoverOpenCodeSessions`).
 *    - Atomic project finalization (`finalizeProjectSetup`).
 *
 * 2. Pairing & Authoritative Session Adoption:
 *    - Strict pre-pair association validation (`assertPrePairAuthoritativeAssociation`).
 *    - Normalization and validation of ChatGPT conversation URLs (`g-p-<32hex>/c/<uuid>`).
 *    - Proving workspace ownership for OpenCode worker sessions before binding.
 *
 * 3. Supervision & Dashboard Projection:
 *    - Aggregates full system status into `DashboardState`.
 *    - Maps domain entities (`Pair`, `Attempt`, `Delivery`, `Handoff`) into presentation
 *      types (`UIPair`, `UIAssignment`, etc.).
 *
 * 4. Provider Contact Governance:
 *    - Gates runtime inspections through operational state checks (S6 governance).
 */

import {
  BrowserChatGPTProvider,
  BrowserOpenCodeProvider,
} from '../providers/browserProviders.ts';
import { parseChatGPTConversationUrl } from '../providers/chatgptConversationUrl.ts';
import {
  isChatGPTProjectLessUrl,
  parseChatGPTProjectUrl,
  toStableChatGPTProjectId,
} from '../providers/chatgptProjectUrl.ts';
import { chatgptProjectDiscoveryError } from '../providers/chatgptProjectDiscovery.ts';
import { RuntimeSession, Project, RuntimeProjectAssociation, Assignment } from '../domain/entities.ts';
import { IRelayRepositories } from '../persistence/interfaces.ts';
import { RelayEngine } from './RelayEngine.ts';
import { relayDiagnostics } from './RelayDiagnostics.ts';
import {
  HealthProjectionService,
  UIHealthSummary,
  UIHealthIncident,
  UIHealthIncidentDetail,
} from './HealthProjectionService.ts';
import { HealthHandoffReportService } from './HealthHandoffReportService.ts';
import {
  IntegrationManager,
  AppIntegrationConfig,
  IntegrationTestResult,
  ProjectIntegrationOverride,
} from '../integrations/index.ts';
import {
  IRelayApi,
  DashboardState,
  SupervisionResult,
  AppStatus,
  ChatGPTConversationChoice,
  ChatGPTConversationChoiceList,
  OpenCodeWorkerSessionCreationResult,
  ChatGPTPlannerSessionCreationResult,
  ProvisionPairWithNewSessionsResult,
  WorkerChoice,
  WorkerChoiceList,
  DiagnosticsReport,
  ProviderIntegration,
  IntegrationStatus,
  ProviderCapabilityMatrix,
  ProviderIdentityInfo,
  ProviderRequirementsInfo,
  EffectiveModelConfig,
  ProviderSetting,
  CreateAndDispatchResult,
  OpenRuntimeSessionResult,
} from '../../types/relayApi.ts';
import {
  UIPair,
  UIProject,
  UIRuntimeSession,
  UIAssignment,
  UIEvent,
  UIFilteredEventsResult,
  UIActivityRecord,
  ArchivePolicy,
  ClearLogsResult,
  StorageAccounting,
  AuditExportBundle,
  AuxiliaryLogInfo,
  UIAttentionItem,
  ObservableEvidence,
  ProviderType,
  DeliveryStatus,
  AttemptStatus,
} from '../../types/ui.ts';
import {
  ProjectId,
  PairId,
  RuntimeSessionId,
  AssignmentId,
  HandoffId,
  DeliveryId,
  AttentionItemId,
  AssociationId,
  createId,
  RUNTIME_PAIR_NOT_ACTIVE,
  RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS,
  EventFilterOptions,
} from '../domain/types.ts';
import path from 'node:path';

/**
 * Normalizes a ChatGPT project reference to its bare `g-p-…` slug (lowercased).
 * Shared by the binding contract and the project-owned conversation registry.
 */
export function normalizeChatProjectSlug(ref: string | null | undefined): string {
  if (!ref || typeof ref !== 'string') return '';
  // Current ChatGPT links may append a human-readable project name to the
  // stable 32-hex project key (for example `g-p-<key>-odarehub`). Discovery
  // can return the bare key while a copied conversation URL includes the
  // suffix, so ownership must compare the stable key when it is present.
  //
  // The stable-key rule itself lives in `chatgptProjectUrl.ts` so that WHAT gets
  // persisted and WHAT gets compared can never drift apart — that drift is what
  // let one project persist under two different-looking URLs.
  const stable = toStableChatGPTProjectId(ref);
  if (stable) return stable;
  // Non-`g-p-` references (legacy `/p/<slug>`, or a bare path) carry no stable
  // key; fall back to a trimmed, lowercased comparison form.
  const match = ref.match(/(?:^|\/p\/)([^/?#]+)/i);
  return (match?.[1] ?? ref).replace(/\/$/, '').toLowerCase();
}

/** Normalizes a workspace path reference for project-ownership comparison. */
export function normalizeWorkerProjectPath(ref: string | null): string {
  if (!ref) return '';
  return path.posix.normalize(ref.replaceAll('\\', '/')).replace(/\/$/, '').toLowerCase();
}

/**
 * Provenances that may authorize pairing. Anything else (e.g. a historical
 * 'pair_binding' placeholder) is not evidence of project membership.
 */
const AUTHORITATIVE_ASSOCIATION_PROVENANCES: ReadonlySet<string> = new Set([
  'discovery',
  'adoption',
  'setup',
]);

/**
 * Recursively walks persisted evidence/details (plain JSON) collecting string
 * values that could be project conversation URLs. Depth-capped and
 * cycle-guarded — persisted payloads are plain data, but stay defensive.
 */
function collectConversationUrlCandidates(node: unknown, out: string[], depth = 0): void {
  if (depth > 6 || node == null) return;
  if (typeof node === 'string') {
    if (node.includes('chatgpt.com') && node.includes('/g/')) out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectConversationUrlCandidates(item, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      collectConversationUrlCandidates((node as Record<string, unknown>)[key], out, depth + 1);
    }
  }
}

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
  private inFlightPlanner = new Map<string, Promise<any>>();
  private inFlightWorker = new Map<string, Promise<any>>();
  public readonly integrationManager: IntegrationManager;

  constructor(
    public readonly db: IRelayRepositories,
    public readonly engine: RelayEngine,
    options: RelayApiServiceOptions = {},
  ) {
    this.isElectron = options.isElectron ?? false;
    this.databasePath = options.databasePath ?? ':memory:';
    this.databaseType = options.databaseType ?? (this.databasePath === ':memory:' ? 'memory' : 'sqlite_wal');
    this.userDataPath = options.userDataPath;
    this.integrationManager = new IntegrationManager(this.db, this.engine);
    this.engine.setRegistry(this.integrationManager.getRegistry());
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
    return projects.map((p) => this.mapProject(p));
  }

  public async getProject(id: string): Promise<UIProject | null> {
    const p = await this.db.projects.findById(id as ProjectId);
    if (!p) return null;
    return this.mapProject(p);
  }

  private mapProject(p: Project): UIProject {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      canonicalPath: p.canonicalPath,
      gitRoot: p.gitRoot,
      plannerProjectUrl: p.plannerProjectUrl,
      workerWorkspacePath: p.workerWorkspacePath,
      status: p.status || 'active',
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  public async createProject(name: string, description = ''): Promise<UIProject> {
    const p = await this.engine.createProject(name, description);
    return this.mapProject(p);
  }

  public async updateProject(
    id: string,
    nameOrProps: string | {
      name?: string;
      description?: string;
      canonicalPath?: string;
      gitRoot?: string;
      plannerProjectUrl?: string;
      workerWorkspacePath?: string;
    },
    maybeDescription?: string,
  ): Promise<UIProject> {
    let name: string | undefined;
    let description: string | undefined;
    let canonicalPath: string | undefined;
    let gitRoot: string | undefined;
    let plannerProjectUrl: string | undefined;
    let workerWorkspacePath: string | undefined;

    if (typeof nameOrProps === 'object') {
      name = nameOrProps.name;
      description = nameOrProps.description;
      canonicalPath = nameOrProps.canonicalPath;
      gitRoot = nameOrProps.gitRoot;
      plannerProjectUrl = nameOrProps.plannerProjectUrl;
      workerWorkspacePath = nameOrProps.workerWorkspacePath;
    } else {
      name = nameOrProps;
      description = maybeDescription;
    }

    const p = await this.engine.updateProject(
      id as ProjectId,
      name,
      description,
      canonicalPath,
      gitRoot,
      plannerProjectUrl,
      workerWorkspacePath,
    );
    return this.mapProject(p);
  }

  public async archiveProject(id: string): Promise<UIProject> {
    const p = await this.engine.archiveProject(id as ProjectId);
    return this.mapProject(p);
  }

  public async unarchiveProject(id: string): Promise<UIProject> {
    const p = await this.engine.unarchiveProject(id as ProjectId);
    return this.mapProject(p);
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
        if (assignment && ['pending', 'active', 'waiting_for_handoff'].includes(assignment.status)) {
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
        } else {
          activeAssignmentTitle = undefined;
          activeAssignmentStatus = undefined;
        }
      }

      let plannerUrl: string | undefined;
      if (planner) {
        if (planner.sessionUrl) {
          plannerUrl = planner.sessionUrl;
        } else if (planner.externalSessionId?.startsWith('http')) {
          plannerUrl = planner.externalSessionId;
        } else if (planner.externalSessionId && planner.providerType === 'chatgpt') {
          const projectRef = planner.externalProjectRef || project?.plannerProjectUrl || '';
          const match = projectRef.match(/(?:^|\/g\/)(g-p-[^/?#]+)/i);
          const slug = match ? match[1] : null;
          plannerUrl = slug
            ? `https://chatgpt.com/g/${slug}/c/${planner.externalSessionId}`
            : `https://chatgpt.com/c/${planner.externalSessionId}`;
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
        plannerUrl,
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
        operationalState: pair.operationalState,
        relayState: pair.relayState,
        lastSupervisedAt: pair.lastSupervisedAt,
      });
    }

    return result;
  }

  public async getPair(id: string): Promise<UIPair | null> {
    const pairs = await this.listPairs();
    return pairs.find((p) => p.id === id) ?? null;
  }

  /**
   * Authoritative recovery state for a pair, computed directly from the engine's
   * durable evidence. No local phase-mutating function is involved.
   */
  public async getPairRecoveryState(pairId: string): Promise<{
    pairId: string;
    recoveryState: import('../domain/recoveryAuthority').RecoveryState | null;
  }> {
    const recovery = await this.engine.getCurrentRecoveryState(pairId as PairId);
    return { pairId, recoveryState: recovery };
  }

  /**
   * Record verified adoption/setup evidence for (runtime, project), replacing
   * any existing row for that pair. At most one association may exist per
   * runtime+project, so confirming a conversation on a runtime that already has
   * evidence must update that row rather than violate the unique index.
   */
  private async recordAssociationEvidence(
    runtimeId: RuntimeSessionId,
    projectId: ProjectId,
    externalSessionId: string,
    providerType: ProviderType,
    provenance: RuntimeProjectAssociation['provenance'],
  ): Promise<void> {
    const existing = (await this.db.associations.findBySessionId(runtimeId)).find(
      (row) => row.projectId === projectId,
    );
    await this.db.associations.save(
      new RuntimeProjectAssociation({
        id: existing?.id ?? createId<AssociationId>('assoc'),
        runtimeSessionId: runtimeId,
        projectId,
        providerType,
        externalSessionId,
        verificationState: 'verified',
        provenance,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  /**
   * True when the runtime already holds verified, provider-evidenced association
   * evidence for this exact project. Used to decide whether a stored reference
   * is worth comparing: a runtime whose evidence points at a different project
   * is reported by the association gate with a more precise error, so the
   * generic ref comparison would only obscure it.
   */
  private async hasVerifiedEvidenceForProject(
    runtime: RuntimeSession,
    projectId: ProjectId,
  ): Promise<boolean> {
    if (!this.db.associations) return false;
    const externalSessionId = runtime.externalSessionId;
    if (!externalSessionId) return false;
    const row = await this.db.associations.findVerifiedBySessionId(runtime.id, {
      providerType: runtime.providerType,
      externalSessionId,
      projectId,
    });
    return row !== null;
  }

  public async createPair(
    projectId: string,
    name: string,
    plannerSessionId?: string,
    workerSessionId?: string,
    plannerConversationUrl?: string,
  ): Promise<UIPair> {
    // Service-layer cross-project guard: selected runtimes must match expected roles
    const planner = plannerSessionId
      ? await this.db.runtimes.findById(plannerSessionId as RuntimeSessionId)
      : null;
    const worker = workerSessionId
      ? await this.db.runtimes.findById(workerSessionId as RuntimeSessionId)
      : null;
    const proj = await this.db.projects.findById(projectId as ProjectId);

    if (plannerSessionId) {
      if (!planner) throw new Error('Planner runtime not found');
      if (!this.engine.isPlannerProvider(planner.providerType)) throw new Error('Planner session must be ChatGPT');
    }
    if (workerSessionId) {
      if (!worker) throw new Error('Worker runtime not found');
      if (!this.engine.isWorkerProvider(worker.providerType)) throw new Error('Worker session must be OpenCode or VS Code');
    }

    // ChatGPT conversation binding contract (explicit, caller-supplied URL).
    // When a plannerConversationUrl is provided it is the authoritative source of
    // session identity for the SELECTED planner runtime: the URL must be a strict
    // chatgpt.com/g/<g-p-project>/c/<conversationId> URL, its project slug must
    // match the paired project, the conversation ID must be nonempty, and the
    // runtime must not already be bound to a different conversation. Nothing is
    // read from Chrome — the caller hands over an already-observed URL.
    const normalizeChatRef = normalizeChatProjectSlug;
    let conversationBinding: { projectId: string; conversationId: string } | null = null;
    if (plannerConversationUrl && planner?.providerType === 'chatgpt') {
      if (!plannerSessionId || !planner) {
        throw new Error('plannerConversationUrl requires a selected ChatGPT planner runtime');
      }
      if (!proj) throw new Error('Project not found');
      let parsed = parseChatGPTConversationUrl(plannerConversationUrl);
      if (!parsed) {
        try {
          const u = new URL(plannerConversationUrl.trim());
          if (u.hostname === 'chatgpt.com' || u.hostname.endsWith('.chatgpt.com')) {
            const cMatch = u.pathname.match(/^\/c\/([^/?#]+)\/?$/);
            const projSlug = normalizeChatRef(proj.plannerProjectUrl ?? null);
            if (cMatch && cMatch[1] && projSlug) {
              parsed = { projectId: projSlug, conversationId: cMatch[1] };
            }
          }
        } catch {}
      }
      if (!parsed) {
        throw new Error(
          `Invalid ChatGPT conversation URL '${plannerConversationUrl}': expected chatgpt.com/g/<g-p-project>/c/<conversationId>`,
        );
      }
      if (!parsed.conversationId.trim()) {
        throw new Error('ChatGPT conversation URL must contain a nonempty conversation ID');
      }
      const projectSlug = normalizeChatRef(proj.plannerProjectUrl ?? null);
      if (!projectSlug) {
        throw new Error('Cross-project pairing: planner project ownership cannot be proven');
      }
      if (normalizeChatRef(parsed.projectId) !== projectSlug) {
        throw new Error('Cross-project pairing: conversation belongs to different ChatGPT project');
      }
      if (planner.externalSessionId && planner.externalSessionId !== parsed.conversationId) {
        throw new Error(
          `Planner runtime is already bound to ChatGPT conversation '${planner.externalSessionId}'`,
        );
      }
      // Pin the project id to its stable `g-p-<key>` form BEFORE it becomes the
      // persisted project reference below. Without this, a conversation URL that
      // carried the named slug (`…-test-project`) would persist a different-looking
      // project reference than the project row's.
      conversationBinding = {
        projectId: normalizeChatRef(parsed.projectId) || parsed.projectId,
        conversationId: parsed.conversationId,
      };
      // Duplicate external identity: the exact conversation must not already be
      // bound to a DIFFERENT runtime (re-binding the same runtime is idempotent).
      const duplicate = await this.db.runtimes.findByExternalSessionId('chatgpt', parsed.conversationId);
      if (duplicate && duplicate.id !== planner.id) {
        throw new Error(
          `ChatGPT conversation '${parsed.conversationId}' is already bound to runtime '${duplicate.id}'`,
        );
      }
    }

    // Project-ownership invariant runs before any write. Verified association
    // evidence is checked inside the transaction below, immediately after a
    // confirmed conversation URL is recorded, so that the evidence authorizing
    // the pair is the same evidence that was persisted.
    if (plannerSessionId || workerSessionId) {
      if (!proj) throw new Error('Project not found');
      if (plannerSessionId && planner && !conversationBinding) {
        const plannerNorm = normalizeChatRef(planner.externalProjectRef ?? null);
        const projNorm = normalizeChatRef(proj.plannerProjectUrl ?? null);
        if (plannerNorm && projNorm && plannerNorm !== projNorm) {
          throw new Error('Cross-project pairing: planner session belongs to different ChatGPT project');
        }
      }
      if (workerSessionId && worker && (await this.hasVerifiedEvidenceForProject(worker, projectId as ProjectId))) {
        const normProjWorker = normalizeWorkerProjectPath(proj.workerWorkspacePath ?? null);
        const normWorkerRef = normalizeWorkerProjectPath(worker.externalProjectRef ?? null);
        if (normWorkerRef && normProjWorker && normWorkerRef !== normProjWorker) {
          throw new Error('Cross-project pairing: worker session belongs to different workspace');
        }
      }
    }

    // Pair creation and the runtime identity write are atomic: the planner's
    // externalSessionId/externalProjectRef are persisted only if the pair is
    // created successfully. Invalid URL / ownership / duplicate / role failures
    // above throw before any write, and a pair-creation failure inside the
    // transaction rolls the runtime identity write back with it.
    const pair = await this.db.runInTransaction(async () => {
      if (conversationBinding && planner) {
        planner.updateExternalIdentity(
          conversationBinding.conversationId,
          // Built from the CONVERSATION URL, not from the project's saved ref: the
          // conversation URL is the authority for which project this conversation
          // is in, so the pair's planner runtime and the project row cannot end up
          // describing two different ChatGPT projects. `conversationBinding.projectId`
          // is already the stable `g-p-<key>`, so this is the same canonical form the
          // project row stores.
          `https://chatgpt.com/g/${conversationBinding.projectId}/project`,
          plannerConversationUrl,
        );
        await this.db.runtimes.save(planner);

        // Confirming a conversation URL that was listed for THIS project is an
        // explicit adoption, so record it as verified evidence. Pairing then
        // rests on that evidence rather than on the caller's assertion.
        await this.recordAssociationEvidence(
          planner.id,
          projectId as ProjectId,
          conversationBinding.conversationId,
          'chatgpt',
          'adoption',
        );
      }
      // Authoritative ground truth: verified provider evidence for the exact
      // (session, provider, external id, project) identity. Checked here, in
      // the same transaction that records it, so a failure rolls the whole
      // attempt back and no unverified pairing can be committed.
      if (plannerSessionId && planner) {
        await this.engine.assertPrePairAuthoritativeAssociation('planner', planner, projectId as ProjectId);
      }
      if (workerSessionId && worker) {
        await this.engine.assertPrePairAuthoritativeAssociation('worker', worker, projectId as ProjectId);
      }
      return this.engine.createPair(
        projectId as ProjectId,
        name,
        plannerSessionId as RuntimeSessionId | undefined,
        workerSessionId as RuntimeSessionId | undefined,
      );
    });
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

  public async updatePlannerConversationUrl(
    pairId: string,
    conversationUrl: string,
  ): Promise<UIPair> {
    const pair = await this.db.pairs.findById(pairId as PairId);
    if (!pair) throw new Error(`Pair ${pairId} not found`);
    if (!pair.plannerSessionId) throw new Error(`Pair ${pairId} has no planner session bound`);

    const planner = await this.db.runtimes.findById(pair.plannerSessionId);
    if (!planner) throw new Error(`Planner runtime ${pair.plannerSessionId} not found`);

    const trimmedUrl = conversationUrl.trim();
    if (!trimmedUrl) throw new Error('Conversation URL cannot be empty');

    const proj = await this.db.projects.findById(pair.projectId);
    const projectRef = proj?.plannerProjectUrl || undefined;

    // Extract conversationId if it is a URL or accept direct ID
    let conversationId = trimmedUrl;
    const cMatch = trimmedUrl.match(/\/c\/([^/?#]+)/i);
    if (cMatch) {
      conversationId = cMatch[1];
    }

    // When the operator supplied a bare conversation ID, the exact URL is composed
    // from the project's ChatGPT identity. The stable `g-p-<key>` form is used so the
    // composed URL matches the project's canonical form rather than re-deriving a
    // named-slug spelling from the saved ref.
    const stableProjectId = toStableChatGPTProjectId(projectRef ?? null);
    const exactSessionUrl = trimmedUrl.startsWith('http')
      ? trimmedUrl
      : stableProjectId
        ? `https://chatgpt.com/g/${stableProjectId}/c/${conversationId}`
        : `https://chatgpt.com/c/${conversationId}`;
    // The persisted project ref is canonicalized too: this write is what a later
    // reader compares against the project row, so it must not carry a stale spelling.
    const canonicalProjectRef = stableProjectId
      ? `https://chatgpt.com/g/${stableProjectId}/project`
      : (projectRef ?? null);
    planner.updateExternalIdentity(conversationId, canonicalProjectRef, exactSessionUrl);
    await this.db.runtimes.save(planner);

    // Record verified association evidence
    await this.recordAssociationEvidence(
      planner.id,
      pair.projectId,
      conversationId,
      planner.providerType,
      'adoption',
    );

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

  public async loadAndActivatePair(pairId: string): Promise<UIPair> {
    const result = await this.engine.loadAndActivate(pairId as PairId);
    if (result.outcome === 'rejected') {
      throw new Error(`Pair activation rejected: ${result.reason || 'Verification preconditions not met'}`);
    }
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
      externalSessionId: r.externalSessionId,
      externalProjectRef: r.externalProjectRef,
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
      externalSessionId: r.externalSessionId,
      externalProjectRef: r.externalProjectRef,
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
        externalSessionId: r.externalSessionId,
        externalProjectRef: r.externalProjectRef,
        sessionUrl: r.sessionUrl ?? (r.externalSessionId?.startsWith('http') ? r.externalSessionId : undefined),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  public async registerRuntimeSession(
    providerType: ProviderType,
    name: string,
    identityOrBundleId?: string,
    projectId?: string,
    sessionUrl?: string,
  ): Promise<UIRuntimeSession> {
    let bundleId: string | undefined;
    let externalSessionId: string | undefined;

    if (identityOrBundleId) {
      if (
        identityOrBundleId.includes('.') &&
        !identityOrBundleId.startsWith('ses_') &&
        !identityOrBundleId.startsWith('http') &&
        !identityOrBundleId.startsWith('conv_')
      ) {
        bundleId = identityOrBundleId;
      } else {
        externalSessionId = identityOrBundleId;
      }
    }

    let projectRef: string | undefined;
    if (projectId) {
      const proj = await this.db.projects.findById(projectId as ProjectId);
      if (proj) {
        projectRef = providerType === 'chatgpt' ? proj.plannerProjectUrl : (proj.canonicalPath || proj.workerWorkspacePath);
      }
    }

    const resolvedSessionUrl = sessionUrl ?? (externalSessionId?.startsWith('http') ? externalSessionId : undefined);

    const runtime = await this.engine.registerRuntimeSession(
      providerType,
      name,
      bundleId,
      externalSessionId,
      projectRef,
      resolvedSessionUrl,
    );

    if (projectId) {
      await this.db.associations.save(
        RuntimeProjectAssociation.create(
          runtime.id,
          projectId as ProjectId,
          externalSessionId || null,
          'unverified',
          'manual_registration',
          providerType,
        ),
      );
    }

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
      externalSessionId: runtime.externalSessionId,
      externalProjectRef: runtime.externalProjectRef,
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
          externalSessionId: runtime.externalSessionId,
          externalProjectRef: runtime.externalProjectRef,
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

    // S6 CLOSURE — I-2 GATE, ARMED. This is the eighth provider-contact site and the
    // last one found ungated. It contacts the provider DIRECTLY on the service rather
    // than through the engine, which is exactly why it was missed: the earlier audits
    // reasoned about engine methods and this call bypasses the engine entirely.
    //
    // The guard is the engine's single shared runtime->Pair resolution, so this path
    // and `reconcileAndRecoverRuntime` cannot disagree about who governs a runtime or
    // what its state is. An IDLE owning Pair, or an ambiguous owning Pair, is refused
    // BEFORE any provider method is reached, and the refusal is returned rather than
    // swallowed, so the caller can distinguish "not permitted" from "contact failed".
    try {
      await this.engine.assertRuntimeProviderContactPermitted(runtime.id);
    } catch (err: any) {
      if (
        err?.code === RUNTIME_PAIR_NOT_ACTIVE ||
        err?.code === RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS
      ) {
        return { success: false, error: err.message };
      }
      throw err;
    }

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

      // Persist identity from inspection evidence under the same rule as
      // discovery: ONLY an authoritativeSessionId (verified against the shared
      // OpenCode service or a persisted session record) may become the session
      // identity. parsedSessionId can arrive from a window-title parse
      // (unverified) and openCodeProjectId is project identity — neither ever
      // becomes externalSessionId. Project/workspace evidence is kept in
      // externalProjectRef via the provider-specific mapping, and an inspection
      // without a verified session ID never overwrites a persisted ID with a
      // guessed value or null.
      const details = (inspection.evidence?.details || {}) as any;
      const extId: string | undefined = details.authoritativeSessionId;
      const projRef: string | null = runtime.providerType === 'opencode'
        ? (details.workspacePath || details.openCodeProjectId || runtime.externalProjectRef || null)
        : (details.projectUrl || details.projectName || runtime.externalProjectRef || null);

      // Identity conflict guard: the runtime is already bound to a different
      // verified session. Never replace the persisted external ID — the observed
      // session must be discovered independently via discoverRuntime. Pair
      // binding and project reference are left untouched.
      if (extId && runtime.externalSessionId && runtime.externalSessionId !== extId) {
        const conflictEvidence: ObservableEvidence = {
          ...inspection.evidence!,
          details: {
            ...details,
            identityConflict: true,
            persistedExternalSessionId: runtime.externalSessionId,
            observedAuthoritativeSessionId: extId,
          },
        };
        runtime.lastEvidence = conflictEvidence;
        await this.db.runtimes.save(runtime);
        return {
          success: false,
          evidence: conflictEvidence,
          error: `External session identity conflict: runtime is bound to '${runtime.externalSessionId}' but inspection observed verified session '${extId}'. Discover the new session as a distinct runtime instead.`,
        };
      }

      const sessionIdChanged = !!(extId && runtime.externalSessionId !== extId);
      const projectRefChanged = !!projRef && projRef !== runtime.externalProjectRef;
      if (sessionIdChanged || projectRefChanged) {
        // Without a verified ID we pass undefined for the session identity so a
        // persisted authoritative ID is preserved (never nulled or guessed).
        runtime.updateExternalIdentity(sessionIdChanged ? extId : undefined, projectRefChanged ? projRef : undefined);
        await this.db.runtimes.save(runtime);
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

  /**
   * Open/activate a runtime session.
   *
   * ## Why the OpenCode opener is invoked EXACTLY ONCE
   *
   * This used to run the provider opener twice per call: once through
   * `integrationManager.getHandler(...)` -> `handler.openSession(...)` and then again
   * directly through `provider.activateRuntime(...)`. For OpenCode both paths reach the SAME
   * `OpenCodeProvider` instance and therefore fired the identical four-keystroke AppleScript
   * sequence twice from one click. That doubled the window in which a focus steal could
   * redirect a keystroke into an unrelated application, and let the second run overwrite the
   * first run's navigation target. The handler is kept as the single entry point so
   * integration-level configuration still owns the open, and it is now called once.
   */
  public async activateRuntime(sessionId: string): Promise<boolean> {
    const runtime = await this.db.runtimes.findById(sessionId as RuntimeSessionId);
    if (!runtime) return false;

    // S6 CLOSURE — I-2 GATE. activateRuntime mutation requires permitted contact.
    try {
      await this.engine.assertRuntimeProviderContactPermitted(runtime.id);
    } catch {
      return false;
    }

    // OpenCode Desktop is the Worker surface, and it can only be navigated by TITLE. The
    // title has to be the LIVE one: `runtime.name` is a RelayX-owned label that drifts the
    // moment the session is renamed in OpenCode, and a stale title silently matches nothing
    // or, worse, somebody else's session. So for OpenCode the authoritative `ses_…` id is
    // resolved through the shared OpenCode service first and the refreshed title is used for
    // navigation. The bound id is never changed by opening.
    if (runtime.providerType === 'opencode') {
      const provider = this.engine.getProvider('opencode') as any;
      if (!provider || typeof provider.openExactWorkerSession !== 'function') {
        return false;
      }
      const result = await provider.openExactWorkerSession({
        externalSessionId: runtime.externalSessionId ?? '',
        storedTitle: runtime.name,
      });

      if (!result?.ok) {
        console.warn(
          `[activateRuntime][opencode-exact-open-failed] runtimeId=${sessionId} ` +
            `externalSessionId=${runtime.externalSessionId ?? 'none'} failure=${result?.failure ?? 'unknown'} ` +
            `resolvedTitle=${JSON.stringify(result?.resolvedTitle ?? null)} ` +
            `stepsSent=${JSON.stringify(result?.stepsSent ?? [])} ` +
            `error=${result?.error ?? 'none'}`,
        );
        return false;
      }

      // Keep the stored display title aligned with what OpenCode actually calls this session.
      // This is navigation metadata only. `externalSessionId` is the identity and is
      // deliberately NOT touched here: a rename must never rebind the Worker.
      if (result.storedTitleWasStale && result.resolvedTitle && runtime.name !== result.resolvedTitle) {
        const before = runtime.name;
        runtime.name = result.resolvedTitle;
        runtime.updatedAt = Date.now();
        await this.db.runtimes.save(runtime);
        console.log(
          `[activateRuntime][worker-title-refreshed] runtimeId=${sessionId} ` +
            `externalSessionId=${runtime.externalSessionId} ` +
            `"${before}" -> "${result.resolvedTitle}" (identity unchanged)`,
        );
      }

      return true;
    }

    try {
      const handler = await this.integrationManager.getHandler(runtime.providerType);
      if (handler && typeof handler.openSession === 'function') {
        const targetUrl = runtime.sessionUrl || runtime.externalSessionId;
        await handler.openSession(runtime.id, targetUrl, runtime.name);
        return true;
      }
    } catch (err: any) {
      console.warn(`[activateRuntime] handler openSession failed for ${sessionId}:`, err?.message ?? err);
    }
    return false;
  }

  public async openRuntimeSession(sessionId: string): Promise<OpenRuntimeSessionResult> {
    const runtime = await this.db.runtimes.findById(sessionId as RuntimeSessionId);
    if (!runtime) return { success: false, error: 'Session not found' };

    let exactUrl = runtime.sessionUrl;
    if (!exactUrl && runtime.externalSessionId?.startsWith('http')) {
      exactUrl = runtime.externalSessionId;
    }
    if (!exactUrl && runtime.providerType === 'chatgpt') {
      const ext = runtime.externalSessionId?.trim();
      // The stable `g-p-<key>` form, so a composed URL never re-derives a named-slug
      // spelling from a stored project reference.
      const slug = toStableChatGPTProjectId(runtime.externalProjectRef);
      if (ext && slug) {
        exactUrl = `https://chatgpt.com/g/${slug}/c/${ext}`;
      } else if (ext) {
        exactUrl = `https://chatgpt.com/c/${ext}`;
      }
    }

    if (!exactUrl && runtime.providerType === 'chatgpt') {
      return {
        success: false,
        error: 'Opening planner session is not supported: exact session URL is not supplied',
      };
    }

    try {
      // Handlers are registered by IntegrationManager.initialize(). It is idempotent
      // (`if (this.initialized) return`), so awaiting it here is safe. Without this,
      // a caller that has not touched the Integrations tab resolves NO handler and every
      // provider-bound operation silently degraded (observed: registryKeys=[] and
      // getHandler('chatgpt') === undefined for a healthy, already-provisioned planner).
      await this.integrationManager.initialize();

      const handler: any = await this.integrationManager.getHandler(runtime.providerType);
      // DIAGNOSTIC (handler resolution). No secrets, no full config: shape only.
      {
        const registryKeys: string[] = (() => {
          try {
            const reg: any = (this.integrationManager as any).registry;
            const raw = reg?.integrations ?? reg?.entries ?? reg?.handlers ?? reg;
            if (raw instanceof Map) return Array.from(raw.keys()).map(String);
            if (Array.isArray(raw)) return raw.map((e: any) => String(e?.config?.id ?? e?.id ?? '?'));
            if (raw && typeof raw === 'object') return Object.keys(raw);
            return [];
          } catch {
            return [];
          }
        })();
        console.warn(
          `[openRuntimeSession][resolve] runtimeId=${sessionId} ` +
            `providerType=${runtime.providerType} providerKey=${JSON.stringify(runtime.providerType)} ` +
            `handlerFound=${handler !== undefined && handler !== null} ` +
            `handlerCtor=${handler ? (handler.constructor?.name ?? 'unknown') : 'none'} ` +
            `handlerConfigId=${handler ? JSON.stringify(handler?.config?.id ?? null) : 'none'} ` +
            `hasOpenSession=${handler ? typeof handler.openSession === 'function' : false} ` +
            `hasActivateRuntime=${handler ? typeof handler.activateRuntime === 'function' : false} ` +
            `registryKeys=${JSON.stringify(registryKeys)}`,
        );
      }
      if (!handler || typeof handler.openSession !== 'function') {
        return {
          success: false,
          url: exactUrl || undefined,
          error: 'No integration handler exposes an exact-session opener for this provider.',
        };
      }

      // Run the opener, then judge success ONLY by the VERIFIED provider result.
      // Absence of an exception is NOT success.
      const opened: unknown = await handler.openSession(runtime.id, exactUrl || runtime.externalSessionId);
      const verification: any =
        handler.lastExactSessionOpenResult ?? (opened && typeof opened === 'object' ? opened : null);

      if (!verification || verification.success !== true) {
        return {
          success: false,
          url: exactUrl || undefined,
          error:
            verification?.reason ??
            'Exact-session open did not return a verified handle; success cannot be claimed.',
        };
      }

      // Deliberately NOT calling provider.activateRuntime() here.
      //
      // This method's contract is "open this URL in the browser", and the verified
      // Chrome tab is already frontmost. activateRuntime() runs
      // `tell application "ChatGPT" to activate`, which raised the ChatGPT DESKTOP APP
      // over the tab — measured: frontmost went Google Chrome -> ChatGPT while RelayX
      // still reported success. Second, redundant occurrence of that focus steal; the
      // app-handler no longer does it either.
      return {
        success: true,
        url: exactUrl || undefined,
        observedUrl: verification.observedUrl,
        reused: verification.reused === true,
        windowId: verification.windowId,
        tabId: verification.tabId,
      };
    } catch (err: any) {
      return { success: false, url: exactUrl || undefined, error: err.message || String(err) };
    }
  }

  /**
   * S6 CLOSURE — runtime recovery.
   *
   * The provider contact happens inside `engine.reconcileAndRecoverRuntime`, which
   * is gated by the shared runtime->Pair guard, so the I-2 invariant holds here too.
   *
   * The previous `catch { return { success: false, restored: false } }` discarded the
   * reason. That made a governance refusal indistinguishable from a genuine
   * provider failure, which is the dishonesty I-2 exists to prevent: a caller would
   * see "recovery failed" with no indication that the real answer was "not
   * permitted, activate the Pair first". The reason is now reported.
   */
  public async recoverRuntime(sessionId: string): Promise<{ success: boolean; restored: boolean; error?: string }> {
    try {
      const recovered = await this.engine.reconcileAndRecoverRuntime(sessionId as RuntimeSessionId);
      return { success: true, restored: recovered.status !== 'suspended' && recovered.status !== 'unknown' };
    } catch (err: any) {
      // Governance denials keep their reason, so "not permitted" is never reported
      // as "provider unreachable". Everything else stays a flat failure, preserving
      // the previous contract for genuine contact errors.
      const isGovernanceDenial =
        err?.code === RUNTIME_PAIR_NOT_ACTIVE || err?.code === RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS;
      return { success: false, restored: false, error: isGovernanceDenial ? err.message : undefined };
    }
  }

  public async listAssignments(): Promise<UIAssignment[]> {
    const assignments = await this.db.assignments.findAll();
    const result: UIAssignment[] = [];

    for (const a of assignments) {
      const pair = await this.db.pairs.findById(a.pairId);
      let deliveryStatus: any;
      let handoffStatus: any;
      let currentAttemptStatus: AttemptStatus | undefined;
      let currentAttemptStartedAt: number | undefined;
      let currentAttemptFinishedAt: number | undefined;
      let currentAttemptFailureReason: string | undefined;
      let currentAttemptEvidence: ObservableEvidence | undefined;
      let deliveryStatusDetailed: DeliveryStatus | undefined;
      let deliveryEvidenceDetail: ObservableEvidence | undefined;
      let deliveryFailureReasonDetail: string | undefined;
      let sourceDerived: 'manual' | 'handoff' | 'other';
      let blockerReason: string | undefined;

      sourceDerived = a.sourceHandoffId ? 'handoff' : 'manual';

      if (a.currentAttemptId) {
        const att = await this.db.attempts.findById(a.currentAttemptId);
        if (att) {
          currentAttemptStatus = att.status;
          currentAttemptStartedAt = att.startedAt;
          currentAttemptFinishedAt = att.finishedAt ?? undefined;
          currentAttemptFailureReason = att.failureReason ?? undefined;
          currentAttemptEvidence = att.evidence ?? undefined;
        }
      }

      if (a.activeDeliveryId) {
        const d = await this.db.deliveries.findById(a.activeDeliveryId);
        deliveryStatus = d?.status;
        deliveryStatusDetailed = d?.status as DeliveryStatus | undefined;
        deliveryEvidenceDetail = d?.evidence ?? undefined;
        deliveryFailureReasonDetail = d?.failureReason ?? undefined;
      }

      if (a.activeHandoffId) {
        const h = await this.db.handoffs.findById(a.activeHandoffId);
        handoffStatus = h?.status;
      }

      const pairStatusStr = pair?.status ?? 'idle';
      const pairOpState = pair?.operationalState ?? 'IDLE';
      const pairRelayStr = pair?.relayState ?? 'STOPPED';
      const reasons: string[] = [];
      if (pairStatusStr === 'blocked') reasons.push('Pair blocked');
      if (pairStatusStr === 'paused') reasons.push('Pair paused');
      if (pairStatusStr === 'archived') reasons.push('Pair archived');
      if (pairOpState === 'IDLE') reasons.push('Pair operationally IDLE');
      if (a.status === 'pending') {
        if (pairStatusStr === 'active' && pairOpState === 'ACTIVE') {
          if (!currentAttemptStatus) {
            reasons.push('Awaiting orchestration pickup');
          } else if (currentAttemptStatus === 'prepared') {
            reasons.push('Attempt prepared, delivery pending');
          }
        } else {
          reasons.push('Pair not active for dispatch');
        }
      }
      if (a.status === 'active') {
        if (currentAttemptStatus === 'interrupted') {
          reasons.push('Attempt interrupted');
        } else if (currentAttemptStatus === 'prepared' && !deliveryStatusDetailed) {
          reasons.push('Attempt prepared, no delivery started');
        }
        if (deliveryStatusDetailed === 'ambiguous') reasons.push('Ambiguous delivery');
        if (deliveryStatusDetailed === 'failed') reasons.push('Delivery failed');
      }
      if (currentAttemptStatus === 'interrupted') reasons.push('Attempt interrupted');
      if (deliveryStatusDetailed === 'ambiguous') reasons.push('Ambiguous delivery');
      if (deliveryStatusDetailed === 'delivered' && currentAttemptStatus === 'interrupted') {
        reasons.push('Delivery delivered but attempt interrupted (provider execution failed)');
      }

      const attentionItems = await this.db.attention.findAll();
      const assignmentAttention = attentionItems.filter(
        (item) => item.assignmentId === a.id && item.status !== 'resolved'
      );
      const unresolvedAttention = assignmentAttention.filter((item) => item.status === 'open');
      let attentionStatusStr: 'open' | 'acknowledged' | 'resolved' | undefined;
      if (unresolvedAttention.length > 0) {
        attentionStatusStr = unresolvedAttention[0].status as 'open' | 'acknowledged';
      } else if (assignmentAttention.length > 0) {
        attentionStatusStr = 'acknowledged';
      }

      blockerReason = reasons.length > 0 ? reasons.join('; ') : undefined;

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
        updatedAt: a.updatedAt ?? undefined,
        targetSideRole: a.targetSideRole ?? 'worker',
        source: sourceDerived,
        currentAttemptId: a.currentAttemptId ?? undefined,
        currentAttemptNumber: a.currentAttemptId ? (await this.db.attempts.findById(a.currentAttemptId))?.attemptNumber : undefined,
        currentAttemptStatus,
        currentAttemptStartedAt,
        currentAttemptFinishedAt,
        currentAttemptFailureReason,
        currentAttemptEvidence,
        deliveryStatus: deliveryStatusDetailed,
        deliveryEvidence: deliveryEvidenceDetail,
        deliveryFailureReason: deliveryFailureReasonDetail,
        attentionStatus: attentionStatusStr,
        attentionCount: assignmentAttention.length,
        attentionTitle: unresolvedAttention[0]?.title ?? assignmentAttention[0]?.title ?? undefined,
        attentionMessage: unresolvedAttention[0]?.message ?? assignmentAttention[0]?.message ?? undefined,
        pairStatus: pairStatusStr,
        pairOperationalState: pairOpState as 'IDLE' | 'ACTIVE',
        pairRelayState: pairRelayStr as 'STOPPED' | 'RUNNING' | 'PAUSED',
        blockerReason,
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

  /**
   * Application orchestration for the Create & Dispatch intent.
   *
   * Two steps, deliberately not one transaction:
   *   1. `createAssignmentAndClaimExecutionSlot` — atomic create + slot claim
   *      (pure DB). A Pair that already owns an unresolved active Assignment, or
   *      is IDLE, produces NO record.
   *   2. `dispatchAssignment` — the ordinary, unchanged delivery path (durable
   *      intent, external send, outcome).
   *
   * This does not change `createAssignment`'s backlog semantics or
   * `dispatchAssignment`'s authority guard.
   */
  public async createAndDispatchAssignment(
    pairId: string,
    title: string,
    instruction: string,
  ): Promise<CreateAndDispatchResult> {
    let assignment: Assignment;
    try {
      assignment = await this.engine.createAssignmentAndClaimExecutionSlot(
        pairId as PairId,
        title,
        instruction,
      );
    } catch (err: any) {
      // PRE-claim refusal: the claim transaction rolled back, so nothing durable
      // exists. This is the only shape that may be reported as "not created".
      return { created: false, error: err?.message || String(err), errorCode: err?.code };
    }

    const pair = await this.db.pairs.findById(pairId as PairId);
    const uiAssignment: UIAssignment = {
      id: assignment.id,
      pairId: assignment.pairId,
      pairName: pair?.name ?? 'Unknown Pair',
      projectId: assignment.projectId,
      title: assignment.title,
      instruction: assignment.instruction,
      status: assignment.status,
      createdAt: assignment.createdAt,
    };

    try {
      const { delivery } = await this.engine.dispatchAssignment(assignment.id);
      return { created: true, assignment: uiAssignment, deliveryOutcome: delivery.status };
    } catch (err: any) {
      // POST-claim dispatch failure. The claim already committed, so the
      // Assignment EXISTS and owns the execution slot. It is NEVER rolled back
      // merely because external delivery failed — report it as recoverable, and
      // never imply that nothing was created.
      return {
        created: true,
        assignment: uiAssignment,
        dispatchError: err?.message || String(err),
        errorCode: err?.code,
      };
    }
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

  public async getAssignmentDetail(id: string): Promise<any> {
    const assignment = await this.db.assignments.findById(id as AssignmentId);
    if (!assignment) return null;
    const pair = await this.db.pairs.findById(assignment.pairId);
    const attempts = await this.db.attempts.findByAssignmentId(assignment.id);
    const deliveries = await this.db.deliveries.findByAssignmentId(assignment.id);
    const handoffs = await this.db.handoffs.findByAssignmentId(assignment.id);
    const events = await this.db.events.findByResourceId(assignment.id);
    const attentionItems = await this.db.attention.findAll();
    const assignmentAttention = attentionItems.filter(
      (item) => item.assignmentId === assignment.id && item.status !== 'resolved'
    );
    return {
      assignment: {
        id: assignment.id,
        pairId: assignment.pairId,
        pairName: pair?.name ?? 'Unknown Pair',
        projectId: assignment.projectId,
        title: assignment.title,
        instruction: assignment.instruction,
        status: assignment.status,
        targetSideRole: assignment.targetSideRole ?? 'worker',
        source: assignment.sourceHandoffId ? 'handoff' : 'manual',
        currentAttemptId: assignment.currentAttemptId ?? undefined,
        currentAttemptStatus: assignment.currentAttemptId ? (await this.db.attempts.findById(assignment.currentAttemptId))?.status : undefined,
        activeDeliveryStatus: assignment.activeDeliveryId ? (await this.db.deliveries.findById(assignment.activeDeliveryId))?.status : undefined,
        activeHandoffStatus: assignment.activeHandoffId ? (await this.db.handoffs.findById(assignment.activeHandoffId))?.status : undefined,
        createdAt: assignment.createdAt,
        updatedAt: assignment.updatedAt,
        completedAt: assignment.completedAt,
      },
      pair: pair ? {
        id: pair.id,
        name: pair.name,
        status: pair.status,
        operationalState: pair.operationalState,
        relayState: pair.relayState,
      } : null,
      attempts: attempts.map((at) => ({
        id: at.id,
        assignmentId: at.assignmentId,
        attemptNumber: at.attemptNumber,
        status: at.status,
        sessionPairId: at.sessionPairId,
        workerSessionId: at.workerSessionId,
        externalSessionId: at.externalSessionId,
        startedAt: at.startedAt,
        finishedAt: at.finishedAt,
        failureReason: at.failureReason,
        evidence: at.evidence,
      })),
      deliveries: deliveries.map((d) => ({
        id: d.id,
        assignmentId: d.assignmentId,
        attemptId: d.attemptId,
        targetRuntimeId: d.targetRuntimeId,
        status: d.status,
        instructionSnippet: d.instructionSnippet,
        evidence: d.evidence,
        deliveredAt: d.deliveredAt,
        failureReason: d.failureReason,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      handoffs: handoffs.map((h) => ({
        id: h.id,
        assignmentId: h.assignmentId,
        attemptId: h.attemptId,
        status: h.status,
        resultSummary: h.resultSummary,
        payload: h.payload,
        evidence: h.evidence,
        plannerDeliveryEvidence: h.plannerDeliveryEvidence,
        deliveredToPlannerAt: h.deliveredToPlannerAt,
        completedAt: h.completedAt,
        createdAt: h.createdAt,
        updatedAt: h.updatedAt,
      })),
      events: events.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        eventType: e.eventType,
        actor: e.actor,
        previousState: e.previousState,
        newState: e.newState,
        evidence: e.evidence,
        correlationId: e.correlationId,
        details: e.details,
        severity: e.severity,
      })),
      attentionItems: assignmentAttention.map((item) => ({
        id: item.id,
        pairId: item.pairId,
        assignmentId: item.assignmentId,
        severity: item.severity,
        status: item.status,
        type: item.type,
        title: item.title,
        message: item.message,
        suggestedAction: item.suggestedAction,
        suggestedTier: item.suggestedTier,
        createdAt: item.createdAt,
      })),
    };
  }

  /* --- Recovery & reconciliation operations (no SQL required) --- */

  /**
   * Reconcile ONE Delivery against its exact provider session, through the domain.
   *
   * This exists so that "what really happened to that delivery" is an application operation
   * rather than a hand-written `UPDATE`. Before, correcting a mis-recorded delivery meant
   * editing the database directly, which skipped the transition rules, emitted no event,
   * and left no record of who decided or why. The decision is now made by the engine, with
   * the transcript evidence attached, and it is reported rather than silently applied.
   *
   * `resendPermitted` is returned so a caller cannot act on the classification without seeing
   * it. It is `true` only when the exact session was READ SUCCESSFULLY and shown not to hold
   * the instruction — the single case in which a retry is defensible.
   */
  public async reconcileDeliveryAgainstExactSession(
    deliveryId: string,
  ): Promise<{
    deliveryId: string;
    status: string;
    attemptStatus: string | null;
    classification: string;
    workerExecution: string;
    matchingUserTurnId: string | null;
    changes: string[];
    resendPermitted: boolean;
    reason: string;
  }> {
    const result = await this.engine.reconcileDeliveryAgainstExactSession(deliveryId as DeliveryId);
    const attempt = await this.db.attempts.findById(result.delivery.attemptId);
    return {
      deliveryId: result.delivery.id,
      status: result.delivery.status,
      attemptStatus: attempt?.status ?? null,
      classification: result.reconciliation.classification,
      workerExecution: result.reconciliation.workerExecution,
      matchingUserTurnId: result.reconciliation.matchingUserTurn?.messageId ?? null,
      changes: result.changes,
      resendPermitted: result.resendPermitted,
      reason: result.reconciliation.reason,
    };
  }

  /**
   * Repair a Pair's execution-slot authority from its own Assignment records.
   *
   * Every transition this performs goes through the Assignment lifecycle and emits an event,
   * so the repair is auditable. It deliberately refuses to guess when several unresolved
   * Assignments remain: promoting the newest would re-create the exact orphan state this
   * operation exists to remove.
   */
  public async reconcilePairAssignmentAuthority(pairId: string): Promise<{
    pairId: string;
    activeAssignmentId: string | null;
    adoptedAssignmentId: string | null;
    transitions: Array<{ assignmentId: string; from: string; to: string; reason: string }>;
    unresolvedCandidates: string[];
  }> {
    const result = await this.engine.reconcilePairAssignmentAuthority(pairId as PairId);
    return {
      pairId: result.pair.id,
      activeAssignmentId: result.pair.activeAssignmentId ?? null,
      adoptedAssignmentId: result.adoptedAssignmentId,
      transitions: result.transitions,
      unresolvedCandidates: result.unresolvedCandidates,
    };
  }

  /* --- Explicit operator/provider settings --- */

  /**
   * Read one provider setting, or `null` when unset.
   *
   * Unset is reported as `null` rather than as a built-in default. A caller must decide what
   * absence means and say so, because the difference between "an operator chose this" and
   * "the product chose this" is exactly what the delivery evidence has to be able to show.
   */
  public async getProviderSetting(key: string): Promise<{
    key: string;
    value: string;
    note: string | null;
    setBy: string;
    updatedAt: number;
  } | null> {
    const setting = await this.engine.getProviderSetting(key);
    if (!setting) return null;
    return {
      key: setting.key,
      value: setting.value,
      note: setting.note,
      setBy: setting.setBy,
      updatedAt: setting.updatedAt,
    };
  }

  public async listProviderSettings(): Promise<Array<{ key: string; value: string; setBy: string }>> {
    const settings = await this.engine.listProviderSettings();
    return settings.map((s) => ({ key: s.key, value: s.value, setBy: s.setBy }));
  }

  /**
   * Set an explicit provider setting. An empty value CLEARS it, which is also recorded.
   */
  public async setProviderSetting(
    key: string,
    value: string,
    opts: { setBy?: string; note?: string } = {},
  ): Promise<{ key: string; value: string | null }> {
    const setting = await this.engine.setProviderSetting(key, value, opts);
    return { key, value: setting?.value ?? null };
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

  private mapEventToUI(e: any): UIEvent {
    return {
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
      severity: e.severity,
      area: e.area,
      outcome: e.outcome,
      isArchived: e.isArchived,
    };
  }

  public async listEvents(limit = 50, resourceId?: string): Promise<UIEvent[]> {
    const events = resourceId
      ? await this.db.events.findByResourceId(resourceId)
      : await this.db.events.findRecent(limit);

    return events.map((e) => this.mapEventToUI(e));
  }

  public async queryEvents(options: EventFilterOptions): Promise<UIFilteredEventsResult> {
    const result = await this.db.events.findFiltered(options);
    return {
      events: result.events.map((e) => this.mapEventToUI(e)),
      total: result.total,
      offset: options.offset ?? 0,
      limit: options.limit ?? result.events.length,
    };
  }

  public async listActivities(limit = 100): Promise<UIActivityRecord[]> {
    if (!this.db.activities) return [];
    const records = await this.db.activities.findAll(limit);
    return records.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      title: r.title,
      summary: r.summary,
      category: r.category,
      status: r.status,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      correlationId: r.correlationId,
      evidence: r.evidence,
      details: r.details,
    }));
  }

  public async runArchiveCycle(): Promise<{ archivedCount: number; cutoffTimestamp: number; interval: string }> {
    return this.engine.runArchiveCycle();
  }

  public async getArchivePolicy(): Promise<ArchivePolicy> {
    const setting = await this.engine.getProviderSetting('policy:archiveInterval');
    const interval = setting?.value ?? '7d';
    let days: number | null = 7;
    if (interval === 'none') {
      days = null;
    } else if (interval.endsWith('d')) {
      const parsed = parseInt(interval, 10);
      days = !isNaN(parsed) && parsed > 0 ? parsed : 7;
    } else if (interval.endsWith('h')) {
      const parsed = parseInt(interval, 10);
      days = !isNaN(parsed) && parsed > 0 ? parsed / 24 : 7;
    }
    return {
      interval,
      effectiveRetentionDays: days,
      note: setting?.note ?? null,
      updatedAt: setting?.updatedAt,
    };
  }

  public async setArchivePolicy(interval: string, note?: string): Promise<ArchivePolicy> {
    await this.engine.setProviderSetting('policy:archiveInterval', interval, {
      note: note ?? 'Retention setting updated by operator',
      setBy: 'operator',
    });
    return this.getArchivePolicy();
  }

  public async clearLogs(options: {
    beforeTimestamp?: number;
    severity?: string;
    area?: string;
    includeArchived?: boolean;
    clearAuxiliaryLogs?: boolean;
  } = {}): Promise<ClearLogsResult> {
    const clearedCount = await this.db.events.clearEligible({
      beforeTimestamp: options.beforeTimestamp,
      severity: options.severity,
      area: options.area,
      includeArchived: options.includeArchived ?? false,
    });

    if (options.clearAuxiliaryLogs) {
      await this.clearAuxiliaryLog('all');
    }

    const remaining = await this.db.events.findFiltered({ isArchived: undefined });
    return {
      clearedCount,
      remainingCount: remaining.total,
      cutoffTimestamp: options.beforeTimestamp,
    };
  }

  private getTraceLogPaths(): Array<{ name: string; path: string }> {
    try {
      const os = require('os');
      const p = require('path');
      const dir = p.join(os.homedir(), 'Library', 'Logs', 'RelayX');
      return [
        { name: 'bootstrap-trace.log', path: p.join(dir, 'bootstrap-trace.log') },
        { name: 'opencode-c2-trace.log', path: p.join(dir, 'opencode-c2-trace.log') },
      ];
    } catch {
      return [
        { name: 'bootstrap-trace.log', path: 'bootstrap-trace.log' },
        { name: 'opencode-c2-trace.log', path: 'opencode-c2-trace.log' },
      ];
    }
  }

  public async getAuxiliaryLogsInfo(): Promise<AuxiliaryLogInfo[]> {
    const logs = this.getTraceLogPaths();
    const result: AuxiliaryLogInfo[] = [];

    for (const log of logs) {
      try {
        const fs = await import('fs');
        if (fs.existsSync(log.path)) {
          const stat = fs.statSync(log.path);
          let lineCount = 0;
          try {
            const content = fs.readFileSync(log.path, 'utf8');
            lineCount = content.split('\n').filter(Boolean).length;
          } catch {
            lineCount = 0;
          }
          result.push({
            name: log.name,
            path: log.path,
            sizeBytes: stat.size,
            lineCount,
            exists: true,
            lastModified: stat.mtimeMs,
          });
        } else {
          result.push({
            name: log.name,
            path: log.path,
            sizeBytes: 0,
            lineCount: 0,
            exists: false,
          });
        }
      } catch {
        result.push({
          name: log.name,
          path: log.path,
          sizeBytes: 0,
          lineCount: 0,
          exists: false,
        });
      }
    }
    return result;
  }

  public async readAuxiliaryLog(name: string, maxLines = 100): Promise<{ name: string; lines: string[]; totalLines: number }> {
    const logs = this.getTraceLogPaths();
    const match = logs.find((l) => l.name === name);
    if (!match) {
      return { name, lines: [], totalLines: 0 };
    }

    try {
      const fs = await import('fs');
      if (!fs.existsSync(match.path)) {
        return { name, lines: [], totalLines: 0 };
      }
      const raw = fs.readFileSync(match.path, 'utf8');
      const allLines = raw.split('\n').filter(Boolean);
      const slice = allLines.slice(-maxLines);
      return { name, lines: slice, totalLines: allLines.length };
    } catch (err: any) {
      return { name, lines: [`Error reading log: ${err.message}`], totalLines: 0 };
    }
  }

  public async clearAuxiliaryLog(name: string): Promise<{ success: boolean; name: string }> {
    const logs = this.getTraceLogPaths();
    const targets = name === 'all' ? logs : logs.filter((l) => l.name === name);

    try {
      const fs = await import('fs');
      for (const target of targets) {
        if (fs.existsSync(target.path)) {
          fs.writeFileSync(target.path, '');
        }
      }
      return { success: true, name };
    } catch {
      return { success: false, name };
    }
  }

  public async getStorageAccounting(): Promise<StorageAccounting> {
    let databaseSizeBytes = 0;
    if (this.databaseType !== 'memory' && this.databasePath && this.databasePath !== ':memory:') {
      try {
        const fs = await import('fs');
        if (fs.existsSync(this.databasePath)) {
          const stat = fs.statSync(this.databasePath);
          databaseSizeBytes = stat.size;
        }
      } catch {
        // non-fatal
      }
    }

    const [
      activeEventsRes,
      archivedEventsRes,
      activities,
      attentionItems,
      pairs,
      traceLogs,
    ] = await Promise.all([
      this.db.events.findFiltered({ isArchived: false }),
      this.db.events.findFiltered({ isArchived: true }),
      this.db.activities?.findAll(1000) ?? Promise.resolve([]),
      this.db.attention.findAll(),
      this.db.pairs.findAll(),
      this.getAuxiliaryLogsInfo(),
    ]);

    let totalCheckpoints = 0;
    for (const p of pairs) {
      try {
        const cps = await this.db.checkpoints.findAll(p.id);
        totalCheckpoints += cps.length;
      } catch {
        // non-fatal
      }
    }

    const traceLogsTotalBytes = traceLogs.reduce((acc, l) => acc + l.sizeBytes, 0);
    const totalStorageBytes = databaseSizeBytes + traceLogsTotalBytes;

    return {
      databaseSizeBytes,
      databaseType: this.databaseType,
      databasePath: this.databasePath,
      totalEvents: activeEventsRes.total + archivedEventsRes.total,
      activeEvents: activeEventsRes.total,
      archivedEvents: archivedEventsRes.total,
      totalActivities: activities.length,
      totalCheckpoints,
      totalAttentionItems: attentionItems.length,
      traceLogs,
      totalStorageBytes,
    };
  }

  public async exportAuditData(options: { includeArchived?: boolean; includeTraces?: boolean } = {}): Promise<AuditExportBundle> {
    const [
      projects,
      pairs,
      runtimes,
      assignments,
      eventsRes,
      activities,
      attentionItems,
      storageAccounting,
    ] = await Promise.all([
      this.db.projects.findAll(),
      this.db.pairs.findAll(),
      this.db.runtimes.findAll(),
      this.db.assignments.findAll(),
      this.db.events.findFiltered(options.includeArchived ? {} : { isArchived: false }),
      this.db.activities?.findAll(500) ?? Promise.resolve([]),
      this.db.attention.findAll(),
      this.getStorageAccounting(),
    ]);

    const allCheckpoints: any[] = [];
    for (const p of pairs) {
      try {
        const cps = await this.db.checkpoints.findAll(p.id);
        allCheckpoints.push(...cps);
      } catch {
        // non-fatal
      }
    }

    return {
      exportedAt: Date.now(),
      version: '1.0.0',
      environment: {
        isElectron: this.isElectron,
        databaseType: this.databaseType,
      },
      counts: {
        projects: projects.length,
        pairs: pairs.length,
        runtimeSessions: runtimes.length,
        assignments: assignments.length,
        deliveries: 0,
        events: eventsRes.total,
        activities: activities.length,
        checkpoints: allCheckpoints.length,
        attentionItems: attentionItems.length,
      },
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        canonicalPath: p.canonicalPath,
        status: p.status,
        createdAt: p.createdAt,
      })),
      pairs: pairs.map((p) => ({
        id: p.id,
        name: p.name,
        projectId: p.projectId,
        status: p.status,
        plannerSessionId: p.plannerSessionId,
        workerSessionId: p.workerSessionId,
      })),
      runtimeSessions: runtimes.map((r) => ({
        id: r.id,
        name: r.name,
        providerType: r.providerType,
        status: r.status,
        externalSessionId: r.externalSessionId,
      })),
      assignments: assignments.map((a) => ({
        id: a.id,
        pairId: a.pairId,
        title: a.title,
        status: a.status,
      })),
      events: eventsRes.events.map((e) => this.mapEventToUI(e)),
      activities,
      checkpoints: allCheckpoints,
      attentionItems: attentionItems.map((i) => ({
        id: i.id,
        type: i.type,
        severity: i.severity,
        status: i.status,
        title: i.title,
        message: i.message,
      })),
      storageAccounting,
    };
  }

  public async listAttentionItems(): Promise<UIAttentionItem[]> {
    const items = await this.db.attention.findOpen();
    const result: UIAttentionItem[] = [];
    for (const i of items) {
      let deliveryId: string | undefined;
      let ambiguousDeliveryCount: number | undefined;
      let evidence: ObservableEvidence | undefined;
      if (i.type === 'ambiguous_delivery' && i.assignmentId) {
        const deliveries = await this.db.deliveries.findByAssignmentId(i.assignmentId);
        const ambiguous = deliveries.filter((d) => d.status === 'ambiguous');
        ambiguousDeliveryCount = ambiguous.length;
        // Expose an ID only when the assignment has exactly ONE ambiguous
        // delivery. With two or more, picking the first would resolve an
        // arbitrarily chosen delivery, so recovery stays unavailable until
        // the operator selects or reconciles a delivery explicitly.
        if (ambiguous.length === 1) {
          deliveryId = ambiguous[0].id;
          evidence = ambiguous[0].evidence;
        } else if (ambiguous.length > 1) {
          evidence = ambiguous[0].evidence;
        } else if (deliveries.length > 0) {
          evidence = deliveries[deliveries.length - 1].evidence;
        }
      } else if (i.assignmentId) {
        const deliveries = await this.db.deliveries.findByAssignmentId(i.assignmentId);
        if (deliveries.length > 0) {
          evidence = deliveries[deliveries.length - 1].evidence;
        }
      }
      result.push({
        id: i.id,
        pairId: i.pairId,
        assignmentId: i.assignmentId,
        deliveryId,
        ambiguousDeliveryCount,
        severity: i.severity,
        status: i.status,
        type: i.type,
        title: i.title,
        message: i.message,
        suggestedAction: i.suggestedAction,
        suggestedTier: i.suggestedTier,
        createdAt: i.createdAt,
        evidence,
      });
    }
    return result;
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

    // The demo pair deliberately selects no runtime: the planner/worker above
    // are simulated observations, not provider-verified sessions, so they must
    // not become a session selection.
    const pair = await this.engine.createPair(
      proj.id,
      'Architecture & Implementation Pair',
    );

    // Seed a draft assignment for the UI, but do NOT dispatch it: the demo pair
    // has no verified worker session, and dispatching to a simulated runtime
    // would fabricate delivery against a session that was never adopted.
    await this.engine.createAssignment(
      pair.id,
      'Implement Idempotent IPC Bridge',
      'Verify that all Electron IPC channels enforce atomic database transactions and return typed observables.',
    );

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
    } else if (typeof (this.db as any).clear === 'function') {
      (this.db as any).clear();
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

  /**
   * Validates a ChatGPT Project binding and returns its canonical form.
   *
   * THE single gate used by BOTH paths:
   *   - automatic GUI Project discovery (`resolveChatGPTProject` / `discoverChatGPTPlanner`)
   *   - manual pasted URL (`finalizeProjectSetup` / `updateProject` via the wizard)
   *
   * Both go through `parseChatGPTProjectUrl`, so the same input always produces
   * the same canonical Project binding. A URL with no `/g/<g-p-…>` Project
   * identity — most importantly a standalone `/c/<conversationId>` conversation
   * URL, which is SESSION identity — is rejected rather than bound.
   */
  private validateChatGPTProjectBinding(url: string | null | undefined): {
    ok: boolean;
    error?: string;
    projectId?: string;
    canonicalProjectUrl?: string;
  } {
    const trimmed = (url || '').trim();
    if (!trimmed) {
      return { ok: false, error: chatgptProjectDiscoveryError('INVALID_PROJECT_URL', 'no URL was provided') };
    }
    const identity = parseChatGPTProjectUrl(trimmed);
    if (!identity) {
      const stage = isChatGPTProjectLessUrl(trimmed) ? 'PROJECT_ID_PARSE_FAILED' : 'INVALID_PROJECT_URL';
      return { ok: false, error: chatgptProjectDiscoveryError(stage, trimmed) };
    }
    return {
      ok: true,
      projectId: identity.projectId,
      canonicalProjectUrl: identity.canonicalProjectUrl,
    };
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
      const res: any = await provider.resolveChatGPTProject(name);
      if (res?.success) {
        // Fail closed at the boundary: a "success" carrying no bindable Project
        // identity must never reach the persistence layer.
        const binding = this.validateChatGPTProjectBinding(res.finalUrl ?? res.projectUrl);
        if (!binding.ok) {
          return {
            success: false,
            error: binding.error,
            diagnostics: { ...(res.diagnostics || {}), discoveryError: binding.error },
          };
        }
      }
      return res;
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
    const key = `${projectPath}:${gitRoot ?? ''}`;
    if (this.inFlightWorker.has(key)) {
      return this.inFlightWorker.get(key)!;
    }
    const promise = (async () => {
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
            const authoritativeSessionId =
              details.authoritativeSessionId || details.parsedSessionId;
            return {
              sessionId: authoritativeSessionId,
              authoritativeSessionId,
              sessionTitle: details.sessionTitle,
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
      } finally {
        this.inFlightWorker.delete(key);
      }
    })();
    this.inFlightWorker.set(key, promise);
    return promise;
  }

  public async enumerateChatGPTConversations(projectId: string): Promise<ChatGPTConversationChoiceList> {
    const proj = await this.db.projects.findById(projectId as ProjectId);
    if (!proj) {
      return { ok: false, error: 'Project not found', conversations: [] };
    }
    const projectSlug = normalizeChatProjectSlug(proj.plannerProjectUrl ?? null);
    if (!projectSlug) {
      return {
        ok: false,
        error: 'Project has no registered ChatGPT planner project, so there is no conversation registry scope',
        conversations: [],
      };
    }

    const byId = new Map<string, ChatGPTConversationChoice>();

    // Authoritative source: chatgpt runtimes bound to a conversation inside this project.
    const runtimes = await this.db.runtimes.findAll();
    for (const r of runtimes) {
      if (r.providerType !== 'chatgpt' || !r.externalSessionId) continue;
      if (normalizeChatProjectSlug(r.externalProjectRef ?? null) !== projectSlug) continue;
      byId.set(r.externalSessionId, {
        conversationId: r.externalSessionId,
        projectId: projectSlug,
        url: `https://chatgpt.com/g/${projectSlug}/c/${r.externalSessionId}`,
        source: 'bound',
        boundRuntimeId: r.id,
        lastSeenAt: r.updatedAt,
      });
    }

    // Observed source: conversation URLs recorded in event evidence/details for this project.
    const pairs = await this.db.pairs.findAll();
    const activePlannerPairRuntimeIds = new Set(
      pairs
        .filter((p) => p.status !== 'archived' && p.plannerSessionId)
        .map((p) => p.plannerSessionId as string),
    );
    const events = await this.db.events.findRecent(500);
    for (const evt of events) {
      const candidates: string[] = [];
      collectConversationUrlCandidates(evt.evidence, candidates);
      collectConversationUrlCandidates(evt.details, candidates);
      for (const candidate of candidates) {
        const parsed = parseChatGPTConversationUrl(candidate);
        if (!parsed || parsed.projectId.toLowerCase() !== projectSlug) continue;
        const existing = byId.get(parsed.conversationId);
        if (existing) {
          existing.lastSeenAt = Math.max(existing.lastSeenAt ?? 0, evt.timestamp);
        } else {
          byId.set(parsed.conversationId, {
            conversationId: parsed.conversationId,
            projectId: projectSlug,
            url: `https://chatgpt.com/g/${projectSlug}/c/${parsed.conversationId}`,
            source: 'observed',
            lastSeenAt: evt.timestamp,
          });
        }
      }
    }

    for (const conversation of byId.values()) {
      if (conversation.boundRuntimeId && activePlannerPairRuntimeIds.has(conversation.boundRuntimeId)) {
        conversation.paired = true;
      }
    }

    const conversations = Array.from(byId.values());
    conversations.sort((a, b) => {
      const aBound = a.source === 'bound' ? 0 : 1;
      const bBound = b.source === 'bound' ? 0 : 1;
      if (aBound !== bBound) return aBound - bBound;
      const dt = (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
      if (dt !== 0) return dt;
      return a.conversationId.localeCompare(b.conversationId);
    });

    return { ok: true, projectSlug, conversations };
  }

  public async enumerateWorkerChoices(projectId: string): Promise<WorkerChoiceList> {
    const proj = await this.db.projects.findById(projectId as ProjectId);
    if (!proj) {
      return { ok: false, error: 'Project not found', choices: [] };
    }

    const choices: WorkerChoice[] = [];
    const registeredSessionIds = new Set<string>();
    const projectPath = normalizeWorkerProjectPath(proj.workerWorkspacePath ?? null);

    const pairs = await this.db.pairs.findAll();
    const activeWorkerPairRuntimeIds = new Set(
      pairs
        .filter((p) => p.status !== 'archived' && p.workerSessionId)
        .map((p) => p.workerSessionId as string),
    );

    // Already-registered runtimes proven to belong to this project's workspace.
    const runtimes = await this.db.runtimes.findAll();
    for (const r of runtimes) {
      if (r.providerType !== 'opencode' && r.providerType !== 'vscode') continue;
      if (projectPath) {
        const ref = normalizeWorkerProjectPath(r.externalProjectRef ?? null);
        if (!ref || ref !== projectPath) continue;
      }
      if (r.externalSessionId) registeredSessionIds.add(r.externalSessionId);
      choices.push({
        kind: 'registered',
        runtimeId: r.id,
        name: r.name,
        status: r.status,
        externalSessionId: r.externalSessionId ?? null,
        paired: activeWorkerPairRuntimeIds.has(r.id),
      });
    }

    // Discovered-but-unregistered sessions, scoped to this project's directory.
    // Identity rule: only details.authoritativeSessionId (proven via the shared
    // service / persisted store) may be adopted — parsed/window-derived ids are
    // excluded and never become bindable worker sessions.
    let discovery: { ok: boolean; reason?: string; excludedUnverified?: number } = { ok: false };
    if (!proj.canonicalPath) {
      discovery = { ok: false, reason: 'Project has no canonical path to scope session discovery' };
    } else {
      let provider: any;
      try {
        provider = this.engine.getProvider('opencode') as any;
      } catch {
        provider = null;
      }
      if (!provider || typeof provider.matchSessionsByPath !== 'function') {
        discovery = { ok: false, reason: 'OpenCode provider does not support session matching' };
      } else {
        try {
          const matchRes = await provider.matchSessionsByPath(proj.canonicalPath, proj.gitRoot);
          const matches = matchRes?.sessions ?? [];
          let excludedUnverified = 0;
          for (const m of matches) {
            const details = (m?.evidence?.details ?? {}) as any;
            const sessionId: string | undefined = details.authoritativeSessionId;
            if (!sessionId) {
              excludedUnverified += 1;
              continue;
            }
            if (registeredSessionIds.has(sessionId)) continue;
            registeredSessionIds.add(sessionId);
            choices.push({
              kind: 'discovered',
              sessionId,
              sessionTitle: details.sessionTitle,
              windowTitle: m?.windowTitle,
              workspacePath: details.workspacePath,
              matchedVia: details.matchedVia,
            });
          }
          discovery = { ok: true, excludedUnverified };
        } catch (err: any) {
          discovery = { ok: false, reason: err?.message ?? 'Session discovery failed' };
        }
      }
    }

    return { ok: true, projectPath: proj.canonicalPath ?? proj.workerWorkspacePath, choices, discovery };
  }

  /**
   * OPENCODE SESSION PRESERVATION FENCE
   * This adoption/creation boundary is verified infrastructure. Keep external
   * `ses_*` identity, provider confirmation, workspace checks, single-attempt
   * creation, and the creation/adoption distinction intact. Behavioral changes
   * require preservation tests and evidence recorded in
   * OPENCODE_SESSION_DISCOVERY.md; never add service-layer auth or retry POSTs.
   */
  public async adoptOpenCodeSession(projectId: string, sessionId: string, name?: string): Promise<UIRuntimeSession> {
    const trimmed = sessionId.trim();
    if (!trimmed.startsWith('ses_')) {
      throw new Error('Only authoritative OpenCode session ids (ses_*) from discovery may be adopted');
    }
    const proj = await this.db.projects.findById(projectId as ProjectId);
    if (!proj) throw new Error('Project not found');

    const priorRuntime = await this.db.runtimes.findByExternalSessionId('opencode', trimmed);

    // An already-adopted session bound to another workspace is a hard conflict
    // and is reported before any confirmation work.
    if (priorRuntime) {
      const existingRef = normalizeWorkerProjectPath(priorRuntime.externalProjectRef ?? null);
      const projectRef = normalizeWorkerProjectPath(proj.workerWorkspacePath ?? null);
      if (existingRef && projectRef && existingRef !== projectRef) {
        throw new Error(`OpenCode session '${trimmed}' is already bound to a different workspace`);
      }
      // Historical placeholder rows (e.g. legacy 'pair_binding') are not
      // evidence. Adoption must never launder one into verified provenance.
      const historicalRows = await this.db.associations.findBySessionId(priorRuntime.id);
      if (historicalRows.some((row) => !AUTHORITATIVE_ASSOCIATION_PROVENANCES.has(row.provenance))) {
        throw new Error(
          `Cannot adopt OpenCode session '${trimmed}': refusing to promote a historical non-authoritative association to verified evidence`,
        );
      }
      const priorList = await this.listRuntimeSessions();
      const priorUi = priorList.find((s) => s.id === priorRuntime.id);
      if (!priorUi) throw new Error('Failed to retrieve adopted runtime');
      return priorUi;
    }

    // Adoption requires a confirmation authority. A caller-supplied session id
    // is not evidence on its own, so when no OpenCode provider is registered at
    // all there is nothing that could corroborate it and adoption must stop.
    const projectPath = proj.workerWorkspacePath ?? proj.canonicalPath ?? '';
    let opencodeProvider:
      | { confirmSessionForProject?: (sessionId: string, projectPath: string) => Promise<{ confirmed: boolean; externalSessionId?: string | null; projectPath?: string }> }
      | undefined;
    try {
      opencodeProvider = this.engine.getProvider('opencode') as typeof opencodeProvider;
    } catch {
      opencodeProvider = undefined;
    }
    if (!opencodeProvider) {
      throw new Error(
        `Adopting OpenCode session '${trimmed}' requires provider confirmation, but no OpenCode provider is registered to confirm it`,
      );
    }
    if (typeof opencodeProvider.confirmSessionForProject !== 'function') {
      throw new Error(
        `Adopting OpenCode session '${trimmed}' requires a provider capable of authoritative project confirmation`,
      );
    }
    const confirmation = await opencodeProvider.confirmSessionForProject(trimmed, projectPath);
    if (!confirmation?.confirmed || confirmation.externalSessionId !== trimmed) {
      throw new Error(
        `Adopting OpenCode session '${trimmed}' requires provider confirmation for project '${projectPath}'`,
      );
    }

    const runtime = RuntimeSession.create('opencode', name?.trim() || `OpenCode session ${trimmed}`);
    runtime.status = 'available';
    runtime.updateExternalIdentity(trimmed, proj.workerWorkspacePath ?? null);
    await this.db.runtimes.save(runtime);

    // Adoption is authoritative evidence: the session id came from provider
    // discovery, so record it as verified 'adoption' provenance. This is what
    // later authorizes pairing; it is not inferred from the session itself.
    await this.recordAssociationEvidence(
      runtime.id,
      proj.id as ProjectId,
      trimmed,
      'opencode',
      'adoption',
    );

    const list = await this.listRuntimeSessions();
    const ui = list.find((s) => s.id === runtime.id);
    if (!ui) throw new Error('Failed to retrieve adopted runtime');
    return ui;
  }

  public async createOpenCodeWorkerSession(projectId: string, name?: string): Promise<OpenCodeWorkerSessionCreationResult> {
    const proj = await this.db.projects.findById(projectId as ProjectId);
    if (!proj) {
      throw new Error('Project not found');
    }
    const workspacePath = proj.workerWorkspacePath ?? proj.canonicalPath ?? null;
    if (!workspacePath) {
      throw new Error('Project has no workspace path to scope the new OpenCode session');
    }

    let provider: any = null;
    try {
      provider = this.engine.getProvider('opencode') as any;
    } catch {
      provider = null;
    }
    if (!provider || typeof provider.createWorkerSession !== 'function') {
      return {
        sessionId: '',
        adopted: false,
        partial: true,
        error: 'OpenCode provider does not support authoritative session creation',
      };
    }

    // Exactly one provider-owned creation attempt. Authentication and service
    // negotiation stay inside the proven provider implementation; this service
    // never reconstructs credentials, retries POST, or injects a chat message.
    let creationRes: { sessionId: string; workspaceDir: string; error?: string };
    try {
      creationRes = await provider.createWorkerSession(workspacePath, name, { projectName: proj.name });
    } catch (err: any) {
      return {
        sessionId: '',
        adopted: false,
        partial: true,
        error: err?.message ?? String(err),
      };
    }

    if (!creationRes.sessionId?.startsWith('ses_')) {
      return {
        sessionId: creationRes.sessionId ?? '',
        adopted: false,
        partial: true,
        error: creationRes.error ?? 'OpenCode provider did not return an authoritative ses_* identity',
      };
    }

    // Verify workspace ownership of the created session before adoption.
    const sessionWorkspaceDir = creationRes.workspaceDir || workspacePath;
    const normWorkspaceDir = normalizeWorkerProjectPath(sessionWorkspaceDir);
    const normProjWorker = normalizeWorkerProjectPath(proj.workerWorkspacePath ?? null);
    if (normWorkspaceDir && normProjWorker && normWorkspaceDir !== normProjWorker) {
      return {
        sessionId: creationRes.sessionId,
        adopted: false,
        partial: true,
        error: `Created session workspace '${normWorkspaceDir}' does not match project workspace '${normProjWorker}'`,
      };
    }

    // Adopt the newly created authoritative session.
    try {
      const adoptedUI = await this.adoptOpenCodeSession(projectId, creationRes.sessionId, name);
      return {
        sessionId: creationRes.sessionId,
        adopted: true,
        runtime: adoptedUI,
      };
    } catch (adoptErr: any) {
      // Creation succeeded; adoption failed. Return partial result with the session id
      // so pairing can resume without blindly creating another session.
      return {
        sessionId: creationRes.sessionId,
        adopted: false,
        partial: true,
        error: adoptErr?.message ?? String(adoptErr),
      };
    }
  }

  public async createChatGPTPlannerSession(
    projectId: string,
    name?: string,
  ): Promise<ChatGPTPlannerSessionCreationResult> {
    const proj = await this.db.projects.findById(projectId as ProjectId);
    if (!proj) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const plannerProjectUrl = proj.plannerProjectUrl;
    if (!plannerProjectUrl) {
      return {
        conversationId: '',
        conversationUrl: '',
        adopted: false,
        partial: true,
        error: 'Project has no ChatGPT planner URL configured to scope the new conversation',
      };
    }

    let provider: any = null;
    try {
      provider = this.engine.getProvider('chatgpt') as any;
    } catch {
      provider = null;
    }
    if (!provider || typeof provider.createPlannerSession !== 'function') {
      return {
        conversationId: '',
        conversationUrl: '',
        adopted: false,
        partial: true,
        error: 'ChatGPT provider does not support authoritative planner session creation',
      };
    }

    // Capture pre-existing known conversations for the project to ensure the created conversation is genuinely fresh
    let knownConversationIds: Set<string> = new Set();
    try {
      const known = await this.enumerateChatGPTConversations(projectId);
      knownConversationIds = new Set((known.conversations ?? []).map((c) => c.conversationId));
    } catch {
      // Best-effort enumeration before creation
    }

    let creationRes: { conversationId: string; conversationUrl: string; projectSlug: string; error?: string };
    try {
      creationRes = await provider.createPlannerSession(plannerProjectUrl, name, {
        knownConversationIds,
        projectName: proj.name,
      });
    } catch (err: any) {
      return {
        conversationId: '',
        conversationUrl: '',
        adopted: false,
        partial: true,
        error: err?.message ?? String(err),
      };
    }

    if (!creationRes.conversationId || !creationRes.conversationUrl) {
      return {
        conversationId: creationRes.conversationId ?? '',
        conversationUrl: creationRes.conversationUrl ?? '',
        adopted: false,
        partial: true,
        error: creationRes.error ?? 'ChatGPT provider did not return an authoritative conversation identity',
      };
    }

    // Verify the returned URL strictly matches project conversation shape
    const parsed = parseChatGPTConversationUrl(creationRes.conversationUrl);
    if (!parsed || !parsed.conversationId || parsed.conversationId !== creationRes.conversationId) {
      return {
        conversationId: creationRes.conversationId,
        conversationUrl: creationRes.conversationUrl,
        adopted: false,
        partial: true,
        error: 'Provider returned an unverified or malformed ChatGPT conversation URL',
      };
    }

    // Uniqueness proof: the conversation ID must not have existed prior to this creation operation
    if (knownConversationIds.has(creationRes.conversationId)) {
      return {
        conversationId: creationRes.conversationId,
        conversationUrl: creationRes.conversationUrl,
        adopted: false,
        partial: true,
        error: `Created conversation '${creationRes.conversationId}' was already observed before creation; fresh creation failed`,
      };
    }

    // Verify project slug matches project's plannerProjectUrl
    const normProjSlug = normalizeChatProjectSlug(plannerProjectUrl);
    const normUrlSlug = normalizeChatProjectSlug(parsed.projectId);
    if (normProjSlug && normUrlSlug && normProjSlug !== normUrlSlug) {
      return {
        conversationId: creationRes.conversationId,
        conversationUrl: creationRes.conversationUrl,
        adopted: false,
        partial: true,
        error: `Created conversation project '${normUrlSlug}' does not match project ChatGPT project '${normProjSlug}'`,
      };
    }

    // Ensure this conversation ID is not already bound to another runtime
    const existing = await this.db.runtimes.findByExternalSessionId('chatgpt', creationRes.conversationId);
    if (existing) {
      return {
        conversationId: creationRes.conversationId,
        conversationUrl: creationRes.conversationUrl,
        adopted: false,
        partial: true,
        error: `ChatGPT conversation '${creationRes.conversationId}' is already bound to runtime '${existing.name}' (${existing.id})`,
      };
    }

    // Adopt the newly created authoritative session
    try {
      const sessionName = name?.trim() || `ChatGPT Planner (${creationRes.conversationId.slice(0, 8)})`;
      const runtime = RuntimeSession.create('chatgpt', sessionName);
      runtime.status = 'available';
      const canonicalProjectUrl =
        (typeof provider.canonicalizeChatGPTProjectUrl === 'function'
          ? provider.canonicalizeChatGPTProjectUrl(creationRes.conversationUrl)
          : null) ?? `https://chatgpt.com/g/${parsed.projectId}/project`;

      runtime.updateExternalIdentity(creationRes.conversationId, canonicalProjectUrl, creationRes.conversationUrl);
      await this.db.runtimes.save(runtime);

      // Record authoritative adoption evidence
      await this.recordAssociationEvidence(
        runtime.id,
        proj.id as ProjectId,
        creationRes.conversationId,
        'chatgpt',
        'adoption',
      );

      const list = await this.listRuntimeSessions();
      const ui = list.find((s) => s.id === runtime.id);
      if (!ui) throw new Error('Failed to retrieve adopted planner runtime');

      return {
        conversationId: creationRes.conversationId,
        conversationUrl: creationRes.conversationUrl,
        adopted: true,
        runtime: ui,
      };
    } catch (adoptErr: any) {
      return {
        conversationId: creationRes.conversationId,
        conversationUrl: creationRes.conversationUrl,
        adopted: false,
        partial: true,
        error: adoptErr?.message ?? String(adoptErr),
      };
    }
  }

  public async provisionPairWithNewSessions(
    projectId: string,
    pairName: string,
    options?: { plannerName?: string; workerName?: string; conversationUrl?: string },
  ): Promise<ProvisionPairWithNewSessionsResult> {
    const title = pairName.trim();
    if (!title) {
      throw new Error('Pair & session title is required');
    }
    const proj = await this.db.projects.findById(projectId as ProjectId);
    if (!proj) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Requirement 7: RelayX effectively asks: give me the Planner, give me the Worker.
    // The integration layer resolves those to the currently configured defaults.
    const plannerHandler = await this.integrationManager.getDefaultPlanner();
    const workerHandler = await this.integrationManager.getDefaultWorker();

    const plannerSessionName = options?.plannerName?.trim() || title;
    const workerSessionName = options?.workerName?.trim() || title;

    // Create planner session using resolved default planner's handler
    let plannerRuntime: UIRuntimeSession;
    let conversationUrl: string | undefined;

    const pRes = await plannerHandler.createSession({
      projectId,
      projectName: proj.name,
      projectPath: proj.canonicalPath,
      projectUrl: proj.plannerProjectUrl,
      sessionTitle: plannerSessionName,
      conversationUrl: options?.conversationUrl,
    } as any);
    if (pRes.error || !pRes.externalSessionId) {
      throw new Error(pRes.error || `Failed to create session with default planner "${plannerHandler.config.name}"`);
    }

    const plannerExternalIdentity = pRes.externalSessionId;
    const pRuntime = await this.registerRuntimeSession(
      plannerHandler.config.id as ProviderType,
      plannerSessionName,
      plannerExternalIdentity,
      projectId,
      pRes.sessionUrl,
    );
    const pEntity = await this.db.runtimes.findById(pRuntime.id as RuntimeSessionId);
    if (pEntity) {
      pEntity.updateExternalIdentity(pRes.externalSessionId, pEntity.externalProjectRef, pRes.sessionUrl);
      await this.db.runtimes.save(pEntity);
    }
    await this.recordAssociationEvidence(
      pRuntime.id as RuntimeSessionId,
      projectId as ProjectId,
      pRes.externalSessionId,
      plannerHandler.config.id as ProviderType,
      'adoption',
    );
    plannerRuntime = {
      ...pRuntime,
      sessionUrl: pRes.sessionUrl,
    };
    conversationUrl = pRes.sessionUrl;

    // Create worker session using resolved default worker's handler
    try {
      let workerRuntime: UIRuntimeSession;

      const wRes = await workerHandler.createSession({
        projectId,
        projectName: proj.name,
        projectPath: proj.canonicalPath || proj.workerWorkspacePath || `/tmp/${proj.name.toLowerCase().replace(/\s+/g, '_')}`,
        sessionTitle: workerSessionName,
      });
      if (wRes.error || !wRes.externalSessionId) {
        throw new Error(wRes.error || `Failed to create session with default worker "${workerHandler.config.name}"`);
      }
      const wRuntime = await this.registerRuntimeSession(
        workerHandler.config.id as ProviderType,
        workerSessionName,
        wRes.externalSessionId,
        projectId,
      );
      await this.recordAssociationEvidence(
        wRuntime.id as RuntimeSessionId,
        projectId as ProjectId,
        wRes.externalSessionId,
        workerHandler.config.id as ProviderType,
        'adoption',
      );
      workerRuntime = wRuntime;

      // Requirement 8: Once sessions are created, the Pair is bound to those actual integrations/sessions.
      // Existing Pairs should not suddenly switch because somebody later changes the defaults.
      const pair = await this.createPair(
        projectId,
        title,
        plannerRuntime.id,
        workerRuntime.id,
        conversationUrl,
      );

      // Automatically load and activate the newly created pair so it starts ACTIVE and ready
      try {
        await this.engine.loadAndActivate(pair.id as PairId);
      } catch (actErr) {
        console.warn(`[RelayX Engine] Auto-activation after provisioning failed:`, actErr);
      }

      return {
        pair,
        plannerRuntime,
        workerRuntime,
      };
    } catch (workerErr: any) {
      // Critical cleanup: if worker creation failed after planner succeeded, clean up the orphaned planner runtime
      try {
        await this.db.runtimes.delete(plannerRuntime.id as any);
        console.log(`[RelayX Engine] Cleaned up orphaned planner runtime ${plannerRuntime.id} after worker creation failure.`);
      } catch (cleanupErr) {
        console.error(`[RelayX Engine] Failed to clean up orphaned planner runtime ${plannerRuntime.id}:`, cleanupErr);
      }
      throw new Error(`Failed to create worker session: ${workerErr?.message || 'unknown error'}. Pair creation aborted and orphaned planner session cleaned up.`);
    }
  }

  public async discoverChatGPTPlanner(name: string): Promise<{
    success: boolean;
    finalUrl?: string;
    projectName?: string;
    error?: string;
    diagnostics?: any;
  }> {
    const key = name.trim().toLowerCase();
    if (this.inFlightPlanner.has(key)) {
      return this.inFlightPlanner.get(key)!;
    }
    const promise = (async () => {
      try {
        const provider = this.engine.getProvider('chatgpt') as any;
        if (!provider || typeof provider.resolveChatGPTProject !== 'function') {
          return { success: false, error: 'ChatGPT provider does not support project resolution' };
        }
        const res: any = await provider.resolveChatGPTProject(name);
        if (res?.success) {
          // Same parser, same binding gate as the manual path.
          const binding = this.validateChatGPTProjectBinding(res.finalUrl ?? res.projectUrl);
          if (!binding.ok) {
            return {
              success: false,
              error: binding.error,
              diagnostics: { ...(res.diagnostics || {}), discoveryError: binding.error },
            };
          }
        }
        return res;
      } catch (err: any) {
        return { success: false, error: err.message };
      } finally {
        this.inFlightPlanner.delete(key);
      }
    })();
    this.inFlightPlanner.set(key, promise);
    return promise;
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

      // 0. Validate the ChatGPT Project binding BEFORE anything is created.
      //
      // This is the manual path, but it is the SAME gate the automatic GUI
      // discovery path goes through, so both yield the identical canonical
      // Project binding. It also runs before any write so a rejected binding
      // never leaves a half-created project behind.
      const plannerBinding = setup.plannerUrl?.trim()
        ? this.validateChatGPTProjectBinding(setup.plannerUrl)
        : null;
      if (plannerBinding && !plannerBinding.ok) {
        return { success: false, error: plannerBinding.error };
      }
      // The canonical Project URL is what gets persisted: it carries the stable
      // external ChatGPT Project identity (`/g/<g-p-…>`) AND remains usable for
      // navigation/discovery. No duplicate schema field is introduced.
      const plannerUrl = plannerBinding?.canonicalProjectUrl;

      // 1. Create Project
      const project = await this.engine.createProject(
        setup.name,
        setup.description,
        setup.canonicalPath,
        setup.gitRoot,
      );

      // Persist the confirmed discovery results as the project's SAVED planner
      // and worker bindings so later views can compare them against fresh
      // discovery. A discovery failure after this point never erases these
      // values — only an explicit user update may change them.
      {
        const workerWorkspace = setup.canonicalPath?.trim() || undefined;
        if (workerWorkspace || plannerUrl) {
          project.update(undefined, undefined, undefined, undefined, plannerUrl, workerWorkspace);
          await this.db.projects.save(project);
        }
      }

      // 2. Register/Find Runtimes
      let plannerId: RuntimeSessionId | undefined;
      if (plannerUrl) {
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
          details: {
            projectUrl: plannerUrl,
            chatgptProjectId: plannerBinding?.projectId,
            bindingRecorded: true,
          },
        });
        // Persist the project binding as the planner runtime's provider reference
        // (session identity is unknown until a conversation URL is bound later).
        planner.updateExternalIdentity(undefined, plannerUrl);
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
      // Persist the authoritative worker session id and its workspace so they
      // survive a restart as the saved binding.
      worker.updateExternalIdentity(
        setup.workerSessionId,
        setup.canonicalPath?.trim() || null,
      );
      await this.db.runtimes.save(worker);
      const workerId = worker.id;

      // 3. Do NOT auto-pair here. The ids in `setup` are caller-supplied
      // wizard input, not provider-verified evidence, so pairing is deferred
      // to the discovery/adoption flow which records verified associations.
      // Recording them now would let unverified ids authorize a pair later.
      void workerId;

      return { success: true, projectId: project.id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /* --- Phase 1 Health (read-only projections) -----------------------------
   *
   * These are pure projections over what the runtime health system already
   * persisted. They run no detector, contact no provider, spawn no subprocess,
   * and touch no operational repository. Detection continues to function with
   * no UI open.
   */

  private healthProjection(): HealthProjectionService {
    return new HealthProjectionService({
      incidentsRepo: this.db.healthIncidents,
      observationsRepo: this.db.healthObservations,
    });
  }

  public async getHealthSummary(): Promise<UIHealthSummary> {
    return this.healthProjection().getHealthSummary();
  }

  public async listHealthIncidents(
    options: { status?: 'active' | 'history'; limit?: number } = {},
  ): Promise<UIHealthIncident[]> {
    const projection = this.healthProjection();
    return options.status === 'history'
      ? projection.listResolvedIncidents(options.limit)
      : projection.listActiveIncidents(options.limit);
  }

  public async getHealthIncident(id: string): Promise<UIHealthIncidentDetail | null> {
    return this.healthProjection().getHealthIncident(id);
  }

  /**
   * Operator acknowledgement only. This never resolves an incident, never
   * retries, and never repairs: it records that a human has seen the problem.
   */
  public async acknowledgeHealthIncident(id: string): Promise<{ success: boolean; status?: string }> {
    return this.healthProjection().acknowledgeIncident(id);
  }

  /**
   * Read-only external-worker handoff report for one incident.
   *
   * Returns the plain-text report, or null when the incident does not exist. This
   * runs no health check, contacts no provider, and mutates nothing. Phase 1 does
   * not deliver the report to a worker: the operator copies it out.
   */
  public async generateHealthHandoffReport(
    id: string,
    options: { eventLimit?: number } = {},
  ): Promise<string | null> {
    const service = new HealthHandoffReportService(this.db, this.db.healthIncidents);
    const report = await service.generate(id, options);
    return report?.text ?? null;
  }

  public async getDiagnosticsReport(): Promise<DiagnosticsReport> {
    const pairs = await this.db.pairs.findAll();
    const runtimes = await this.db.runtimes.findAll();
    const attention = this.db.attention ? await this.db.attention.findAll() : [];
    const openAttention = attention.filter((a: any) => a.status === 'open');

    let checkpointsCount = 0;
    if (this.db.checkpoints) {
      for (const p of pairs) {
        try {
          const list = await this.db.checkpoints.findAll(p.id as PairId);
          checkpointsCount += list.length;
        } catch {
          // ignore
        }
      }
    }

    const assignments = await this.db.assignments.findAll();
    let deliveriesCount = 0;
    if (this.db.deliveries) {
      for (const a of assignments) {
        try {
          const list = await this.db.deliveries.findByAssignmentId(a.id as AssignmentId);
          deliveriesCount += list.length;
        } catch {
          // ignore
        }
      }
    }

    const integrations = await this.listIntegrations();

    return relayDiagnostics.evaluateHealth({
      dbStatus: { ok: true, type: this.databaseType },
      pairs,
      runtimes,
      pairsCount: pairs.length,
      runtimesCount: runtimes.length,
      openAttentionCount: openAttention.length,
      checkpointsCount,
      deliveriesCount,
      integrations,
    });
  }

  public async copyDiagnosticReport(): Promise<string> {
    const report = await this.getDiagnosticsReport();
    return report.formattedReportText;
  }

  /* --- Provider / App Integration & Capability Model --- */

  private mapConfigToProviderIntegration(config: AppIntegrationConfig): ProviderIntegration {
    return {
      providerType: config.id as ProviderType,
      id: config.id,
      name: config.name,
      description: config.description,
      role: config.role,
      isEnabled: config.isEnabled,
      isDefaultPlanner: config.isDefaultPlanner,
      isDefaultWorker: config.isDefaultWorker,
      isBuiltin: config.isBuiltin,
      appType: config.appType,
      appPath: config.appPath,
      bundleId: config.bundleId,
      serviceUrl: config.serviceUrl,
      cliCommand: config.cliCommand,
      cliArguments: config.cliArguments,
      launchBehavior: config.launchBehavior,
      scripts: config.scripts,
      status: config.status,
      identity: {
        kind: config.appType === 'editor' ? 'editor' : config.appType === 'cli_service' ? 'cli_service' : 'app_bundle',
        bundleId: config.bundleId,
        executable: config.cliCommand,
        serviceUrl: config.serviceUrl,
        processName: config.processName,
        windowTitlePattern: config.windowTitlePattern,
      },
      requirements: {
        accessibilityRequired: config.requirements.accessibilityRequired,
        accessibilityGranted: config.requirements.accessibilityGranted ?? false,
        systemEventsRequired: config.requirements.systemEventsRequired,
        systemEventsAvailable: config.requirements.systemEventsAvailable ?? false,
        serviceRunning: config.requirements.serviceRunning,
        cliInstalled: config.requirements.cliInstalled,
        notes: config.requirements.notes,
      },
      capabilities: config.capabilities,
      lastVerifiedAt: config.lastVerifiedAt,
      lastVerificationResult: config.lastVerificationResult,
      metadata: config.metadata,
      capabilitiesList: Object.entries(config.capabilities || {})
        .filter(([_, v]) => Boolean(v))
        .map(([k]) => k.replace(/([A-Z])/g, ' $1').toLowerCase()),
      readinessChecklist: (config.lastVerificationResult?.details as any)?.checklist || {
        applicationFound: Boolean(config.status === 'verified'),
        accessibilityPermission: Boolean(config.requirements?.accessibilityGranted ?? true),
        automationPermission: Boolean(config.requirements?.systemEventsAvailable ?? true),
        sessionCreation: Boolean(config.capabilities?.createSession),
        sessionIdentity: Boolean(config.bundleId || config.processName || config.isBuiltin),
        messageSubmission: Boolean(config.capabilities?.dispatchInstruction),
        observation: Boolean(config.capabilities?.observeCompletion),
      },
      supportedModels: config.id === 'claude_desktop' 
        ? ['anthropic/claude-3-7-sonnet', 'anthropic/claude-3-5-sonnet', 'anthropic/claude-3-opus'] 
        : config.id === 'chatgpt' 
        ? ['openai/gpt-4o', 'openai/o3-mini', 'openai/o1'] 
        : config.id === 'opencode' 
        ? [
            'opencode-zen/free-default',
            'openrouter/free',
            'thinking-machines/inkling:free',
            'thinking-machines/inkling-small:free',
            'nvidia/nemotron-3-ultra:free',
            'nvidia/nemotron-3.5-lightning:free',
            'poolside/laguna-s-2.1:free',
            'poolside/laguna-xs-2.1:free',
            'cohere/north-mini-code:free',
            'google/gemini-2.5-flash:free'
          ] 
        : [],
      automationBreakdown: {
        'Launch application': config.scripts?.launchScript ? 'Script' : config.launchBehavior === 'open_bundle' ? 'Native App Bundle' : config.launchBehavior === 'service_call' ? 'Shared Daemon Service' : 'CLI Executable',
        'Create session': config.scripts?.createSessionScript ? 'Configured Script' : config.id === 'chatgpt' ? 'Desktop App / Chrome Tab' : config.id === 'opencode' ? 'opencode CLI runner' : config.id === 'claude_desktop' ? 'AppleScript (Cmd+N)' : 'Editor Workspace',
        'Send message': config.scripts?.sendMessageScript ? 'Configured Script' : config.id === 'chatgpt' ? 'Composer Automation' : config.id === 'opencode' ? 'Local REST API / HTTP' : config.id === 'claude_desktop' ? 'System Events Keystrokes' : 'Editor Terminal',
        'Observe session': config.scripts?.inspectSessionScript ? 'Configured Script' : config.id === 'chatgpt' ? 'Window Observer' : config.id === 'opencode' ? 'Service State (~/.local/state)' : 'Window Title Pattern',
      },
    };
  }

  public async listIntegrations(): Promise<ProviderIntegration[]> {
    await this.integrationManager.initialize();
    const configs = this.integrationManager.listConfigs();
    return configs.map((c) => this.mapConfigToProviderIntegration(c));
  }

  public async verifyIntegration(providerType: ProviderType): Promise<ProviderIntegration> {
    await this.integrationManager.initialize();
    const id = providerType as string;
    const config = await this.integrationManager.verifyApp(id);
    return this.mapConfigToProviderIntegration(config);
  }

  public async recheckAllIntegrations(): Promise<ProviderIntegration[]> {
    await this.integrationManager.initialize();
    const configs = this.integrationManager.listConfigs();
    const results: ProviderIntegration[] = [];
    for (const c of configs) {
      const updated = await this.integrationManager.verifyApp(c.id);
      results.push(this.mapConfigToProviderIntegration(updated));
    }
    return results;
  }

  public async addIntegration(config: Partial<ProviderIntegration>): Promise<ProviderIntegration> {
    await this.integrationManager.initialize();
    const created = await this.integrationManager.addApp(config as Partial<AppIntegrationConfig>);
    return this.mapConfigToProviderIntegration(created);
  }

  public async updateIntegration(id: string, updates: Partial<ProviderIntegration>): Promise<ProviderIntegration> {
    await this.integrationManager.initialize();
    const updated = await this.integrationManager.updateApp(id, updates as Partial<AppIntegrationConfig>);
    return this.mapConfigToProviderIntegration(updated);
  }

  public async deleteIntegration(id: string): Promise<{ success: boolean; error?: string }> {
    await this.integrationManager.initialize();
    return this.integrationManager.deleteApp(id);
  }

  public async toggleIntegrationEnabled(id: string, enabled: boolean): Promise<ProviderIntegration> {
    await this.integrationManager.initialize();
    const updated = await this.integrationManager.toggleEnabled(id, enabled);
    return this.mapConfigToProviderIntegration(updated);
  }

  public async setDefaultIntegration(id: string, role: 'planner' | 'worker'): Promise<{ success: boolean; error?: string }> {
    await this.integrationManager.initialize();
    return this.integrationManager.setDefault(id, role);
  }

  public async getDefaultPlannerIntegration(): Promise<ProviderIntegration> {
    const handler = await this.integrationManager.getDefaultPlanner();
    return this.mapConfigToProviderIntegration(handler.config);
  }

  public async getDefaultWorkerIntegration(): Promise<ProviderIntegration> {
    const handler = await this.integrationManager.getDefaultWorker();
    return this.mapConfigToProviderIntegration(handler.config);
  }

  public async testIntegration(id: string): Promise<IntegrationTestResult> {
    await this.integrationManager.initialize();
    return this.integrationManager.testIntegration(id);
  }

  public async setProjectIntegrationOverride(
    projectId: string,
    override: { plannerIntegrationId?: string | null; workerIntegrationId?: string | null },
  ): Promise<ProjectIntegrationOverride> {
    await this.integrationManager.initialize();
    return this.integrationManager.setProjectOverride(projectId, override);
  }

  public async getProjectIntegrationOverride(projectId: string): Promise<ProjectIntegrationOverride | null> {
    await this.integrationManager.initialize();
    return this.integrationManager.getProjectOverride(projectId) || null;
  }

  public async listProjectIntegrationOverrides(): Promise<ProjectIntegrationOverride[]> {
    await this.integrationManager.initialize();
    return this.integrationManager.listProjectOverrides();
  }

  /* --- Worker AI Model Configuration & Application --- */

  public async getSupportedModels(providerType: ProviderType): Promise<string[]> {
    return RelayEngine.getSupportedModels(providerType);
  }

  public async getEffectiveModelConfig(
    providerType: ProviderType,
    projectId?: string,
    pairId?: string,
  ): Promise<EffectiveModelConfig> {
    return this.engine.resolveEffectiveModelConfig(
      providerType,
      projectId as ProjectId | undefined,
      pairId as PairId | undefined,
    );
  }

  public async setGlobalModelDefault(
    providerType: ProviderType,
    model: string,
    note?: string,
  ): Promise<ProviderSetting | null> {
    const key = RelayEngine.providerSettingKey(providerType, 'transportModel');
    return this.engine.setProviderSetting(key, model, { note, setBy: 'operator' });
  }

  public async setProjectModelOverride(
    projectId: string,
    providerType: ProviderType,
    model: string,
    justification: string,
  ): Promise<ProviderSetting | null> {
    return this.engine.setProjectModelOverride(
      projectId as ProjectId,
      providerType,
      model,
      justification,
    );
  }

  public async clearProjectModelOverride(
    projectId: string,
    providerType: ProviderType,
  ): Promise<void> {
    await this.engine.clearProjectModelOverride(projectId as ProjectId, providerType);
  }

  /**
   * Persist a pair-scoped worker model on the SAME provider_settings authority as
   * the global and project scopes. No provider contact: the delivery boundary
   * reads the resolved value later, so this is legal while the Pair is IDLE.
   */
  public async setPairModelOverride(
    pairId: string,
    providerType: ProviderType,
    model: string,
    justification: string,
  ): Promise<ProviderSetting | null> {
    return this.engine.setPairModelOverride(
      pairId as PairId,
      providerType,
      model,
      justification,
    );
  }

  public async clearPairModelOverride(
    pairId: string,
    providerType: ProviderType,
  ): Promise<void> {
    await this.engine.clearPairModelOverride(pairId as PairId, providerType);
  }
}
