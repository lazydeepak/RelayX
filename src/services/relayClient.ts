import { MemoryRelayDatabase } from '../relay/persistence/memory/MemoryDatabase.ts';
import { IRelayRepositories } from '../relay/persistence/interfaces.ts';
import { RelayEngine } from '../relay/application/RelayEngine.ts';

import {
  ChatGPTProvider,
  OpenCodeProvider,
  VSCodeProvider,
} from '../relay/providers/adapters.ts';
import {
  UIPair,
  UIProject,
  UIRuntimeSession,
  UIAssignment,
  UIEvent,
  UIAttentionItem,
} from '../types/ui.ts';
import { ObservableEvidence } from '../relay/domain/types.ts';

class RelayService {
  public readonly db: IRelayRepositories;
  public readonly engine: RelayEngine;
  public readonly chatgptProvider: any;
  public readonly opencodeProvider: any;
  public readonly vscodeProvider: any;
  private initialized = false;

  constructor() {
    this.db = new MemoryRelayDatabase();
    this.engine = new RelayEngine(this.db);

    // Setup providers for macOS runtime simulation
    this.chatgptProvider = { providerType: 'chatgpt', integrationStatus: 'partial', windowTitle: 'ChatGPT - Desktop Planner', applicationPid: 52140 };
    this.opencodeProvider = { providerType: 'opencode', integrationStatus: 'partial', windowTitle: 'OpenCode Session [backend-core]', applicationPid: 52141 };
    this.vscodeProvider = { providerType: 'vscode', integrationStatus: 'partial', windowTitle: 'Visual Studio Code — relay-macos', applicationPid: 52142 };

    this.engine.registerProvider(this.chatgptProvider);
    this.engine.registerProvider(this.opencodeProvider);
    this.engine.registerProvider(this.vscodeProvider);
  }

  public async initializeSeedData(): Promise<void> {
    if (this.initialized) return;

    // 1. Projects
    const proj1 = await this.engine.createProject(
      'Cloud Architecture Migration',
      'Refactoring microservices into modular TypeScript packages with deterministic recovery.',
    );
    const proj2 = await this.engine.createProject(
      'Relay Native Desktop Control',
      'Building macOS Accessibility and AppleScript adapters for OpenCode and ChatGPT.',
    );

    // 2. Runtime Sessions
    const chatgptPlanner = await this.engine.registerRuntimeSession(
      'chatgpt',
      'ChatGPT Desktop (Architect Planner)',
      'com.openai.chat',
    );
    chatgptPlanner.recordObservationSuccess('available', {
      id: `ev_init_${Date.now()}_1`,
      timestamp: Date.now() - 60000,
      source: 'macos_accessibility',
      windowTitle: 'ChatGPT - Desktop Planner',
      applicationPid: 52140,
      bundleIdentifier: 'com.openai.chat',
      visibleButtonState: { sendButtonVisible: true, stopButtonVisible: false },
    });
    await this.db.runtimes.save(chatgptPlanner);

    const opencodeWorker = await this.engine.registerRuntimeSession(
      'opencode',
      'OpenCode CLI Session (Worker)',
      'com.opencode.desktop',
    );
    opencodeWorker.recordObservationSuccess('available', {
      id: `ev_init_${Date.now()}_2`,
      timestamp: Date.now() - 40000,
      source: 'reconciliation_probe',
      windowTitle: 'OpenCode Session [backend-core]',
      applicationPid: 52141,
      bundleIdentifier: 'com.opencode.desktop',
      visibleButtonState: { sendButtonVisible: true, stopButtonVisible: false },
    });
    await this.db.runtimes.save(opencodeWorker);

    const vscodeWorker = await this.engine.registerRuntimeSession(
      'vscode',
      'VS Code Agent (Worker)',
      'com.microsoft.VSCode',
    );
    vscodeWorker.recordObservationSuccess('idle', {
      id: `ev_init_${Date.now()}_3`,
      timestamp: Date.now() - 20000,
      source: 'reconciliation_probe',
      windowTitle: 'Visual Studio Code — relay-macos',
      applicationPid: 52142,
      bundleIdentifier: 'com.microsoft.VSCode',
      visibleButtonState: { sendButtonVisible: true, stopButtonVisible: false },
    });
    await this.db.runtimes.save(vscodeWorker);

    // 3. Pairs
    const pair1 = await this.engine.createPair(
      proj1.id,
      'Pair A: Architecture & Core Engine',
      chatgptPlanner.id,
      opencodeWorker.id,
    );

    const pair2 = await this.engine.createPair(
      proj2.id,
      'Pair B: UI & Integration Supervision',
      chatgptPlanner.id,
      vscodeWorker.id,
    );

    // 4. Initial Seed Assignment on Pair 1
    const asgn1 = await this.engine.createAssignment(
      pair1.id,
      'Implement SQLite Repository Unit of Work',
      'Implement durable schema migrations, transaction commits, and write test coverage for crash restarts.',
    );
    await this.engine.dispatchAssignment(asgn1.id);

    this.initialized = true;
  }

  public async getDashboardData() {
    const projects = await this.db.projects.findAll();
    const pairs = await this.db.pairs.findAll();
    const runtimes = await this.db.runtimes.findAll();
    const assignments = await this.db.assignments.findAll();
    const activeAssignments = await this.db.assignments.findActive();
    const attentionItems = await this.db.attention.findOpen();
    const recentEvents = await this.db.events.findRecent(25);
    const ambiguousDeliveries = await this.db.deliveries.findAmbiguous();

    return {
      totalProjects: projects.length,
      totalPairs: pairs.length,
      totalRuntimes: runtimes.length,
      activeWorkers: runtimes.filter((r) => r.status === 'working').length,
      activeAssignments: activeAssignments.length,
      waitingReview: assignments.filter((a) => a.status === 'waiting_for_handoff').length,
      openAttentionItems: attentionItems.length,
      ambiguousDeliveries: ambiguousDeliveries.length,
      recentEvents,
      runtimes,
    };
  }

  public async getPairs(): Promise<UIPair[]> {
    const pairs = await this.db.pairs.findAll();
    const result: UIPair[] = [];

    for (const pair of pairs) {
      const project = await this.db.projects.findById(pair.projectId);
      const planner = pair.plannerSessionId ? await this.db.runtimes.findById(pair.plannerSessionId) : null;
      const worker = pair.workerSessionId ? await this.db.runtimes.findById(pair.workerSessionId) : null;

      let activeAssignmentTitle: string | undefined;
      let activeAssignmentStatus: any | undefined;
      let deliveryStatus: any | undefined;
      let deliveryEvidence: ObservableEvidence | undefined;
      let handoffStatus: any | undefined;
      let handoffSummary: string | undefined;

      if (pair.activeAssignmentId) {
        const asgn = await this.db.assignments.findById(pair.activeAssignmentId);
        if (asgn) {
          activeAssignmentTitle = asgn.title;
          activeAssignmentStatus = asgn.status;

          if (asgn.activeDeliveryId) {
            const deliv = await this.db.deliveries.findById(asgn.activeDeliveryId);
            if (deliv) {
              deliveryStatus = deliv.status;
              deliveryEvidence = deliv.evidence;
            }
          }

          if (asgn.activeHandoffId) {
            const handoff = await this.db.handoffs.findById(asgn.activeHandoffId);
            if (handoff) {
              handoffStatus = handoff.status;
              handoffSummary = handoff.resultSummary;
            }
          }
        }
      }

      result.push({
        id: pair.id,
        projectId: pair.projectId,
        projectName: project?.name ?? 'Unknown',
        name: pair.name,
        plannerSessionId: pair.plannerSessionId,
        workerSessionId: pair.workerSessionId,
        plannerName: planner?.name ?? 'Planner',
        plannerProvider: planner?.providerType ?? 'chatgpt',
        plannerStatus: planner?.status ?? 'unknown',
        workerName: worker?.name ?? 'Worker',
        workerProvider: worker?.providerType ?? 'opencode',
        workerStatus: worker?.status ?? 'unknown',
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

  public async getRuntimes(): Promise<UIRuntimeSession[]> {
    const runtimes = await this.db.runtimes.findAll();
    return runtimes.map((r) => ({
      id: r.id,
      providerType: r.providerType,
      name: r.name,
      bundleIdentifier: r.bundleIdentifier,
      windowTitle: r.windowTitle,
      applicationPid: r.applicationPid,
      status: r.status,
      consecutiveObservationFailures: r.consecutiveObservationFailures,
      lastHeartbeatAt: r.lastHeartbeatAt,
      lastObservedAt: r.lastObservedAt,
      lastEvidence: r.lastEvidence,
    }));
  }

  public async getAssignments(): Promise<UIAssignment[]> {
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

  public async getAttentionItems(): Promise<UIAttentionItem[]> {
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

  public async getEvents(limit = 100): Promise<UIEvent[]> {
    const events = await this.db.events.findRecent(limit);
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
}

export const relayService = new RelayService();
