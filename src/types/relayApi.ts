import {
  UIPair,
  UIProject,
  UIRuntimeSession,
  UIAssignment,
  UIEvent,
  UIAttentionItem,
  ObservableEvidence,
  ProviderType,
  RuntimeSessionStatus,
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

/**
 * A ChatGPT conversation RelayX has already bound or observed for a project —
 * the project-owned conversation registry. No Chrome sampling: entries come
 * only from persisted authoritative bindings and recorded event evidence.
 */
export interface ChatGPTConversationChoice {
  /** The `c/` segment of the conversation URL. */
  conversationId: string;
  /** The owning `g-p-…` project slug this conversation was scoped to. */
  projectId: string;
  /** Reconstructed conversation URL — the authoritative binding input. */
  url: string;
  /**
   * `bound` = authoritative (a planner runtime carries this conversation id);
   * `observed` = the URL appeared in recorded event evidence.
   */
  source: 'bound' | 'observed';
  boundRuntimeId?: string;
  /** True when the bound planner runtime sits in a non-archived pair. */
  paired?: boolean;
  /** Newest timestamp at which the conversation was bound or observed. */
  lastSeenAt?: number;
}

export interface ChatGPTConversationChoiceList {
  ok: boolean;
  error?: string;
  projectSlug?: string;
  conversations: ChatGPTConversationChoice[];
}

/** An existing worker-session choice for a project: already registered, or discovered and adoptable. */
export type WorkerChoice =
  | {
      kind: 'registered';
      runtimeId: string;
      name: string;
      status: RuntimeSessionStatus;
      externalSessionId?: string | null;
      paired: boolean;
    }
  | {
      kind: 'discovered';
      /** Authoritative `ses_*` id resolved via the shared service — adoptable. */
      sessionId: string;
      /** Human-readable title supplied by OpenCode for this session. */
      sessionTitle?: string;
      windowTitle?: string;
      workspacePath?: string;
      matchedVia?: string;
    };

export interface WorkerChoiceList {
  ok: boolean;
  error?: string;
  projectPath?: string;
  choices: WorkerChoice[];
  /** Truthful discovery sub-result — failure never hides registered choices. */
  discovery?: { ok: boolean; reason?: string; excludedUnverified?: number };
}

export interface OpenCodeWorkerSessionCreationResult {
  sessionId: string;
  adopted: boolean;
  runtime?: UIRuntimeSession;
  partial?: boolean;
  error?: string;
}

export interface ChatGPTPlannerSessionCreationResult {
  conversationId: string;
  conversationUrl: string;
  adopted: boolean;
  runtime?: UIRuntimeSession;
  partial?: boolean;
  error?: string;
}

export interface ProvisionPairWithNewSessionsResult {
  pair: UIPair;
  plannerRuntime: UIRuntimeSession;
  workerRuntime: UIRuntimeSession;
}

export type IntegrationStatus = 'verified' | 'degraded' | 'not_detected' | 'unconfigured';

export interface ProviderCapabilityMatrix {
  discoverProjects: boolean;
  discoverSessions: boolean;
  createSession: boolean;
  dispatchInstruction: boolean;
  captureTransportBoundary: boolean;
  reconcileExactSession: boolean;
  observeCompletion: boolean;
  extractResponse: boolean;
}

export interface ProviderIdentityInfo {
  kind: 'app_bundle' | 'cli_service' | 'editor';
  bundleId?: string;
  executable?: string;
  serviceUrl?: string;
  processName?: string;
  detectedPid?: number;
  version?: string;
  windowTitlePattern?: string;
}

export interface ProviderRequirementsInfo {
  accessibilityRequired: boolean;
  accessibilityGranted: boolean;
  systemEventsRequired: boolean;
  systemEventsAvailable: boolean;
  serviceRunning?: boolean;
  cliInstalled?: boolean;
  notes?: string;
}

export interface ProviderIntegration {
  providerType: ProviderType;
  id?: string;
  name: string;
  description?: string;
  role: 'planner' | 'worker' | 'both';
  isEnabled?: boolean;
  isDefaultPlanner?: boolean;
  isDefaultWorker?: boolean;
  isBuiltin?: boolean;
  appType?: 'app_bundle' | 'cli_service' | 'editor' | 'script';
  appPath?: string;
  bundleId?: string;
  processName?: string;
  windowTitlePattern?: string;
  serviceUrl?: string;
  cliCommand?: string;
  cliArguments?: string[];
  launchBehavior?: 'open_bundle' | 'launch_url' | 'exec_cli' | 'applescript' | 'service_call';
  scripts?: {
    launchScript?: string;
    createSessionScript?: string;
    openSessionScript?: string;
    sendMessageScript?: string;
    inspectSessionScript?: string;
    extractSessionScript?: string;
    verificationScript?: string;
  };
  status: IntegrationStatus;
  identity: ProviderIdentityInfo;
  requirements: ProviderRequirementsInfo;
  capabilities: ProviderCapabilityMatrix;
  lastVerifiedAt?: number;
  lastVerificationResult?: {
    ok: boolean;
    message: string;
    details?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
  capabilitiesList?: string[];
  readinessChecklist?: {
    applicationFound: boolean;
    accessibilityPermission: boolean;
    automationPermission: boolean;
    sessionCreation: boolean;
    sessionIdentity: boolean;
    messageSubmission: boolean;
    observation: boolean;
  };
  supportedModels?: string[];
  automationBreakdown?: Record<string, string>;
}

export interface IntegrationTestResult {
  ok: boolean;
  message: string;
  durationMs: number;
  steps: Array<{
    name: string;
    passed: boolean;
    durationMs: number;
    details?: string;
  }>;
}

export interface ProjectIntegrationOverride {
  projectId: string;
  plannerIntegrationId?: string | null;
  workerIntegrationId?: string | null;
  updatedAt?: number;
}

export interface IRelayApi {
  getAppStatus(): Promise<AppStatus>;
  getDashboardState(): Promise<DashboardState>;
  listProjects(): Promise<UIProject[]>;
  getProject(id: string): Promise<UIProject | null>;
  createProject(name: string, description?: string): Promise<UIProject>;
  updateProject(
    id: string,
    nameOrProps: string | {
      name?: string;
      description?: string;
      canonicalPath?: string;
      gitRoot?: string;
      plannerProjectUrl?: string;
      workerWorkspacePath?: string;
    },
    description?: string,
  ): Promise<UIProject>;
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
  loadAndActivatePair(pairId: string): Promise<UIPair>;
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
    externalSessionIdOrBundleId?: string,
    projectId?: string,
  ): Promise<UIRuntimeSession>;
  discoverRuntime(providerType: ProviderType): Promise<{ success: boolean; runtime?: UIRuntimeSession; isNew?: boolean; error?: string }>;
  inspectRuntime(sessionId: string): Promise<{ success: boolean; evidence?: ObservableEvidence; error?: string }>;
  activateRuntime(sessionId: string): Promise<boolean>;
  /**
   * S6 CLOSURE — `error` is populated ONLY when the attempt was refused by the I-2
   * runtime->Pair governance guard (the owning Pair is IDLE, or its ownership is
   * ambiguous). It is absent for a genuine provider/transport failure, so "not
   * permitted" is never reported as "the provider could not be reached".
   *
   * Additive: the field is optional, so every existing caller and implementation of
   * this interface keeps compiling and behaving identically.
   */
  recoverRuntime(sessionId: string): Promise<{ success: boolean; restored: boolean; error?: string }>;
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
      /** Human-readable title supplied by OpenCode for this session. */
      sessionTitle?: string;
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
  enumerateChatGPTConversations(projectId: string): Promise<ChatGPTConversationChoiceList>;
  enumerateWorkerChoices(projectId: string): Promise<WorkerChoiceList>;
  adoptOpenCodeSession(projectId: string, sessionId: string, name?: string): Promise<UIRuntimeSession>;
  createOpenCodeWorkerSession(projectId: string, name?: string): Promise<OpenCodeWorkerSessionCreationResult>;
  createChatGPTPlannerSession(projectId: string, name?: string): Promise<ChatGPTPlannerSessionCreationResult>;
  provisionPairWithNewSessions(
    projectId: string,
    pairName: string,
    options?: { plannerName?: string; workerName?: string },
  ): Promise<ProvisionPairWithNewSessionsResult>;
  finalizeProjectSetup(setup: {
    name: string;
    description: string;
    canonicalPath: string;
    gitRoot?: string;
    plannerUrl?: string;
    workerSessionId?: string;
  }): Promise<{ success: boolean; projectId?: string; error?: string }>;

  // Diagnostics & Telemetry
  getDiagnosticsReport(): Promise<DiagnosticsReport>;
  copyDiagnosticReport(): Promise<string>;

  // Provider Integration & Capability Model
  listIntegrations(): Promise<ProviderIntegration[]>;
  verifyIntegration(providerType: ProviderType): Promise<ProviderIntegration>;
  recheckAllIntegrations(): Promise<ProviderIntegration[]>;
  addIntegration(config: Partial<ProviderIntegration>): Promise<ProviderIntegration>;
  updateIntegration(id: string, updates: Partial<ProviderIntegration>): Promise<ProviderIntegration>;
  deleteIntegration(id: string): Promise<{ success: boolean; error?: string }>;
  toggleIntegrationEnabled(id: string, enabled: boolean): Promise<ProviderIntegration>;
  setDefaultIntegration(id: string, role: 'planner' | 'worker'): Promise<{ success: boolean; error?: string }>;
  getDefaultPlannerIntegration(): Promise<ProviderIntegration>;
  getDefaultWorkerIntegration(): Promise<ProviderIntegration>;
  testIntegration(id: string): Promise<IntegrationTestResult>;
  setProjectIntegrationOverride(projectId: string, override: { plannerIntegrationId?: string | null; workerIntegrationId?: string | null }): Promise<ProjectIntegrationOverride>;
  getProjectIntegrationOverride(projectId: string): Promise<ProjectIntegrationOverride | null>;
  listProjectIntegrationOverrides(): Promise<ProjectIntegrationOverride[]>;

  // Worker AI Model Configuration & Application
  getSupportedModels(providerType: ProviderType): Promise<string[]>;
  getEffectiveModelConfig(providerType: ProviderType, projectId?: string): Promise<EffectiveModelConfig>;
  setGlobalModelDefault(providerType: ProviderType, model: string, note?: string): Promise<ProviderSetting | null>;
  setProjectModelOverride(projectId: string, providerType: ProviderType, model: string, justification: string): Promise<ProviderSetting | null>;
  clearProjectModelOverride(projectId: string, providerType: ProviderType): Promise<void>;
}

export interface EffectiveModelConfig {
  providerType: ProviderType;
  globalDefault: string | null;
  projectOverride: string | null;
  effectiveModel: string;
  isProjectOverride: boolean;
  justification?: string | null;
  supportedModels: string[];
}

export interface ProviderSetting {
  key: string;
  value: string;
  note: string | null;
  setBy: string;
  createdAt: number;
  updatedAt: number;
}

export type HealthLevel = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN' | 'INACTIVE';

export interface DiagnosticMeasurement {
  id: string;
  operation: string;
  durationMs: number;
  timestamp: number;
  success: boolean;
  error?: string;
  metadata?: {
    projectId?: string;
    pairId?: string;
    provider?: string;
    source?: string;
    details?: Record<string, unknown>;
  };
  children?: DiagnosticMeasurement[];
}

export interface OperationMetricSummary {
  operation: string;
  calls: number;
  latestDurationMs: number;
  avgDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  errorCount: number;
}

export interface ComponentHealthStatus {
  component: string;
  status: HealthLevel;
  summary: string;
  lastObservedAt?: number;
  evidence: string[];
}

export interface DiagnosticsReport {
  overall: HealthLevel;
  problems: string[];
  performance: OperationMetricSummary[];
  components: Record<string, ComponentHealthStatus>;
  timestamp: number;
  formattedReportText: string;
}

declare global {
  interface Window {
    relayApi?: IRelayApi;
  }
}
