import {
  UIPair,
  UIProject,
  UIRuntimeSession,
  UIAssignment,
  AssignmentPriority,
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
  RuntimeSessionStatus,
} from './ui.ts';
import { EventFilterOptions } from '../relay/domain/types.ts';

import {
  IntegrationTestResult,
  ProjectIntegrationOverride,
} from '../relay/integrations/types.ts';

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
    discoverProjectScript?: string;
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

/* --- Phase 1 Health (read-only projections) -------------------------------
 *
 * The renderer may READ persisted health state and nothing else. These calls
 * perform no provider contact, no subprocess, no session discovery, and no
 * health evaluation: detection already happened in the Electron/application
 * runtime and these are pure projections over what it persisted.
 */

/** Overall aggregate. `UNKNOWN` is truthful, not a placeholder for HEALTHY. */
export type HealthAggregateState = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

export interface UIHealthSummary {
  overall: HealthAggregateState;
  overallReason: string;
  activeIncidentCount: number;
  resolvedIncidentCount: number;
  totalObservationCount: number;
  hasSufficientEvidence: boolean;
  observedCheckTypes: string[];
  lastObservationAt: number | null;
}

export interface UIHealthIncident {
  id: string;
  incidentType: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'RECURRED';
  componentType: string;
  componentId: string | null;
  firstSeen: number;
  lastSeen: number;
  occurrenceCount: number;
  summary: string;
  evidenceKeys: string[];
}

/**
 * Incident detail. `evidence` contains ONLY flat scalars: nested objects and
 * arrays are dropped by the projection, so a transcript, prompt body, or command
 * line cannot reach the UI even if one were written into the record.
 */
export interface UIHealthIncidentDetail extends UIHealthIncident {
  evidence: Record<string, string | number | boolean | null>;
  unavailableFields: string[];
}

/**
 * Structured, VERIFIED result of opening/focusing an exact runtime session.
 *
 * `success` is true ONLY when a real window/tab handle was resolved AND its read-back
 * URL still represents the requested conversation. A provider that merely ran without
 * throwing must NOT produce `success: true`.
 */
export interface OpenRuntimeSessionResult {
  success: boolean;
  /** Authoritative URL RelayX attempted; echoed for diagnostics even on failure. */
  url?: string;
  /** URL read back from the verified handle. Present only on success. */
  observedUrl?: string;
  /** True when an already-open exact tab was focused instead of creating one. */
  reused?: boolean;
  windowId?: number;
  tabId?: number;
  /** Concrete failure reason. Present only on failure. */
  error?: string;
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
  updatePlannerConversationUrl(pairId: string, conversationUrl: string): Promise<UIPair>;
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

  openRuntimeSession(sessionId: string): Promise<OpenRuntimeSessionResult>;

  /** Get the authoritative recovery state for a pair, from the engine's durable evidence. */
  getPairRecoveryState(pairId: string): Promise<{ pairId: string; recoveryState: import('../relay/domain/recoveryAuthority').RecoveryState | null }>;
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
  createAssignment(pairId: string, title: string, instruction: string, priority?: AssignmentPriority): Promise<UIAssignment>;
  /**
   * Create AND dispatch. Never throws for an expected outcome: the result
   * distinguishes a PRE-claim refusal (nothing was created) from a POST-claim
   * dispatch failure (the Assignment exists and owns the slot, and must be
   * recovered — never reported as a creation failure).
   */
  createAndDispatchAssignment(
    pairId: string,
    title: string,
    instruction: string,
    priority?: AssignmentPriority,
  ): Promise<CreateAndDispatchResult>;
  dispatchAssignment(assignmentId: string): Promise<{ success: boolean; deliveryOutcome: string }>;
  completeAssignment(assignmentId: string): Promise<{ success: boolean }>;
  getAssignmentDetail(id: string): Promise<any>;
  deliverHandoff(handoffId: string): Promise<{ success: boolean }>;
  resolveAmbiguousDelivery(deliveryId: string, resolution: 'confirmed_delivered' | 'retry_permitted'): Promise<{ success: boolean }>;
  listEvents(limit?: number, resourceId?: string): Promise<UIEvent[]>;
  queryEvents(options: EventFilterOptions): Promise<UIFilteredEventsResult>;
  listActivities(limit?: number): Promise<UIActivityRecord[]>;
  runArchiveCycle(): Promise<{ archivedCount: number; cutoffTimestamp: number; interval: string }>;
  getArchivePolicy(): Promise<ArchivePolicy>;
  setArchivePolicy(interval: string, note?: string): Promise<ArchivePolicy>;
  clearLogs(options?: {
    beforeTimestamp?: number;
    severity?: string;
    area?: string;
    includeArchived?: boolean;
    clearAuxiliaryLogs?: boolean;
  }): Promise<ClearLogsResult>;
  getStorageAccounting(): Promise<StorageAccounting>;
  exportAuditData(options?: { includeArchived?: boolean; includeTraces?: boolean }): Promise<AuditExportBundle>;
  getAuxiliaryLogsInfo(): Promise<AuxiliaryLogInfo[]>;
  readAuxiliaryLog(name: string, maxLines?: number): Promise<{ name: string; lines: string[]; totalLines: number }>;
  clearAuxiliaryLog(name: string): Promise<{ success: boolean; name: string }>;
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
    options?: { plannerName?: string; workerName?: string; conversationUrl?: string },
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

  /* --- Phase 1 Health (read-only) -----------------------------------------
   *
   * These read persisted health state produced by the runtime health system.
   * They never run a detector, never contact a provider, and never mutate any
   * operational entity. `acknowledgeHealthIncident` is the single narrow write:
   * it marks an operator acknowledgement and explicitly does NOT resolve.
   */
  getHealthSummary(): Promise<UIHealthSummary>;
  listHealthIncidents(options?: {
    status?: 'active' | 'history';
    limit?: number;
  }): Promise<UIHealthIncident[]>;
  getHealthIncident(id: string): Promise<UIHealthIncidentDetail | null>;
  acknowledgeHealthIncident(id: string): Promise<{ success: boolean; status?: string }>;
  /**
   * Generate a read-only external-worker handoff report for one incident.
   *
   * A factual summary of what RelayX observed and classified. Runs no detector,
   * contacts no provider, and mutates nothing. Phase 1 does not deliver the
   * report anywhere: the human copies it out.
   */
  generateHealthHandoffReport(id: string, options?: { eventLimit?: number }): Promise<string | null>;

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
  //
  // These are PERSISTENT RelayX configuration writes. None of them contact a
  // provider: the resolved model is applied by the engine at the authorized
  // dispatch boundary. A selection is therefore legal while a Pair is IDLE.
  getSupportedModels(providerType: ProviderType): Promise<string[]>;
  getEffectiveModelConfig(providerType: ProviderType, projectId?: string, pairId?: string): Promise<EffectiveModelConfig>;
  setGlobalModelDefault(providerType: ProviderType, model: string, note?: string): Promise<ProviderSetting | null>;
  setProjectModelOverride(projectId: string, providerType: ProviderType, model: string, justification: string): Promise<ProviderSetting | null>;
  clearProjectModelOverride(projectId: string, providerType: ProviderType): Promise<void>;
  setPairModelOverride(pairId: string, providerType: ProviderType, model: string, justification: string): Promise<ProviderSetting | null>;
  clearPairModelOverride(pairId: string, providerType: ProviderType): Promise<void>;
}

/**
 * Outcome of the Create & Dispatch orchestration command.
 *
 * The claim (`createAssignmentAndClaimExecutionSlot`) commits before external
 * delivery is attempted, so a later dispatch failure must NOT be reported as a
 * creation failure. This shape carries that distinction across IPC:
 *   - `created: false`                 → pre-claim refusal; nothing durable.
 *   - `created: true` + `dispatchError`→ the Assignment EXISTS and owns the slot;
 *                                        it is recoverable, not lost.
 *   - `created: true` + `deliveryOutcome` → delivery ran (delivered | ambiguous | failed).
 */
export interface CreateAndDispatchResult {
  /** True iff an Assignment was durably created and now owns the execution slot. */
  created: boolean;
  /** Present whenever `created` is true. */
  assignment?: UIAssignment;
  /** Delivery outcome when the dispatch ran to an outcome (`delivered`/`ambiguous`/`failed`). */
  deliveryOutcome?: string;
  /** Present when the claim committed but the subsequent dispatch failed. */
  dispatchError?: string;
  /** Present when nothing was created (pre-claim refusal). */
  error?: string;
  /** Optional domain/engine error code for either failure shape. */
  errorCode?: string;
}

export interface EffectiveModelConfig {
  providerType: ProviderType;
  globalDefault: string | null;
  projectOverride: string | null;
  pairOverride?: string | null;
  effectiveModel: string;
  isProjectOverride: boolean;
  isPairOverride?: boolean;
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
