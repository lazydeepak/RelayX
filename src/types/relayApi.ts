import {
  UIPair,
  UIProject,
  UIRuntimeSession,
  UIAssignment,
  UIEvent,
  UIAttentionItem,
  ObservableEvidence,
  ProviderType,
} from './ui.ts';

export interface DashboardState {
  metrics: {
    totalProjects: number;
    totalPairs: number;
    totalRuntimes: number;
    activeWorkers: number;
    activeAssignments: number;
    waitingReview: number;
    openAttentionItems: number;
    ambiguousDeliveries: number;
  };
  recentEvents: UIEvent[];
}

export interface SupervisionResult {
  inspectedRuntimes: number;
  inspectedAssignments: number;
  handoffsCreated: number;
  attentionItemsCreated: number;
}

export interface AppStatus {
  isElectron: boolean;
  platform: string;
  electronVersion?: string;
  chromeVersion?: string;
  nodeVersion?: string;
  userDataPath?: string;
  databasePath: string;
  databaseType: 'sqlite_wal' | 'memory';
  permissions?: {
    accessibilityGranted: boolean;
    systemEventsAvailable: boolean;
    notes?: string;
  };
}

export interface IRelayApi {
  getAppStatus(): Promise<AppStatus>;
  getDashboardState(): Promise<DashboardState>;
  listProjects(): Promise<UIProject[]>;
  getProject(id: string): Promise<UIProject | null>;
  createProject(name: string, description?: string): Promise<UIProject>;
  updateProject(id: string, name: string, description?: string): Promise<UIProject>;
  archiveProject(id: string): Promise<UIProject>;
  unarchiveProject(id: string): Promise<UIProject>;
  canDeleteProject(id: string): Promise<{ canDelete: boolean; reasons: string[] }>;
  deleteProject(id: string): Promise<{ success: boolean; error?: string }>;
  listPairs(): Promise<UIPair[]>;
  getPair(id: string): Promise<UIPair | null>;
  createPair(
    projectId: string,
    name: string,
    plannerSessionId?: string,
    workerSessionId?: string,
    plannerConversationUrl?: string,
  ): Promise<UIPair>;
  updatePair(
    id: string,
    updates: { name?: string; plannerSessionId?: string | null; workerSessionId?: string | null },
  ): Promise<UIPair>;
  rebindPairPlanner(pairId: string, plannerSessionId: string): Promise<UIPair>;
  rebindPairWorker(pairId: string, workerSessionId: string): Promise<UIPair>;
  detachPairRuntime(pairId: string, role: 'planner' | 'worker'): Promise<UIPair>;
  startPair(pairId: string): Promise<UIPair>;
  pausePair(pairId: string): Promise<UIPair>;
  resumePair(pairId: string): Promise<UIPair>;
  stopPair(pairId: string): Promise<UIPair>;
  archivePair(id: string): Promise<UIPair>;
  unarchivePair(id: string): Promise<UIPair>;
  canDeletePair(id: string): Promise<{ canDelete: boolean; reasons: string[] }>;
  deletePair(id: string): Promise<{ success: boolean; error?: string }>;
  listRuntimeSessions(): Promise<UIRuntimeSession[]>;
  registerRuntimeSession(
    providerType: ProviderType,
    name: string,
    bundleIdentifier?: string,
  ): Promise<UIRuntimeSession>;
  discoverRuntime(providerType: ProviderType): Promise<{ success: boolean; runtime?: UIRuntimeSession; isNew?: boolean; error?: string }>;
  inspectRuntime(sessionId: string): Promise<{ success: boolean; evidence?: ObservableEvidence; error?: string }>;
  recoverRuntime(sessionId: string): Promise<{ success: boolean; restored: boolean }>;
  detachRuntime(sessionId: string): Promise<{ success: boolean; detachedFromPairs: string[] }>;
  canDeleteRuntimeSession(sessionId: string): Promise<{ canDelete: boolean; reasons: string[] }>;
  deleteRuntimeSession(sessionId: string): Promise<{ success: boolean; error?: string }>;
  archiveRuntimeSession(sessionId: string, reason?: string): Promise<UIRuntimeSession>;
  unarchiveRuntimeSession(sessionId: string): Promise<UIRuntimeSession>;
  listAssignments(): Promise<UIAssignment[]>;
  createAssignment(pairId: string, title: string, instruction: string): Promise<UIAssignment>;
  dispatchAssignment(assignmentId: string): Promise<{ success: boolean; deliveryOutcome: string }>;
  completeAssignment(assignmentId: string): Promise<{ success: boolean }>;
  deliverHandoff(handoffId: string): Promise<{ success: boolean }>;
  resolveAmbiguousDelivery(deliveryId: string, resolution: 'confirmed_delivered' | 'retry_permitted'): Promise<{ success: boolean }>;
  listEvents(limit?: number, resourceId?: string): Promise<UIEvent[]>;
  listAttentionItems(): Promise<UIAttentionItem[]>;
  acknowledgeAttentionItem(id: string): Promise<{ success: boolean }>;
  runSupervisionTick(): Promise<SupervisionResult>;
  seedDemoEnvironment(): Promise<{ success: boolean; seeded: boolean }>;
  clearDatabase(): Promise<{ success: boolean }>;

  // Add Project Workflow
  selectProjectFolder(): Promise<{
    success: boolean;
    path?: string;
    basename?: string;
    gitRoot?: string;
    existingProjectId?: string;
    error?: string;
  }>;
  resolveChatGPTProject(name: string): Promise<{
    success: boolean;
    projectUrl?: string;
    error?: string;
    foundMultiple?: Array<{ name: string; url: string }>;
    diagnostics?: any;
  }>;
  discoverChatGPTPlanner(name: string): Promise<{
    success: boolean;
    finalUrl?: string;
    projectName?: string;
    foundMultiple?: Array<{ name: string; url: string }>;
    error?: string;
    diagnostics?: any;
  }>;
  discoverOpenCodeSessions(projectPath: string, gitRoot?: string): Promise<{
    success: boolean;
    sessions: Array<{ 
      sessionId?: string; 
      /** Authoritative `ses_*` id resolved via the shared service or persisted store. */
      authoritativeSessionId?: string;
      /** Window-derived id — display/telemetry only, never a binding. */
      observedWindowSessionId?: string;
      /** True only when `sessionId` came from an authoritative source. */
      authoritative?: boolean;
      windowTitle?: string; 
      workspacePath?: string;
      matchScore?: number;
      matchedVia?: string;
      openCodeProjectId?: string;
      hasUiCorrelation?: boolean;
    }>;
    diagnostics?: any;
    error?: string;
  }>;
  finalizeProjectSetup(setup: {
    name: string;
    description: string;
    canonicalPath: string;
    gitRoot?: string;
    plannerUrl?: string;
    workerSessionId?: string;
  }): Promise<{ success: boolean; projectId?: string; error?: string }>;
}

declare global {
  interface Window {
    relayApi?: IRelayApi;
  }
}
