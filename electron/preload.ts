import { contextBridge, ipcRenderer } from 'electron';
import { RELAY_IPC_CHANNELS } from './ipc/contracts.ts';
import { IRelayApi } from '../src/types/relayApi.ts';
import { ProviderType } from '../src/types/ui.ts';

const relayApi: IRelayApi = {
  getAppStatus: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_APP_STATUS),
  getDashboardState: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_DASHBOARD_STATE),
  listProjects: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.LIST_PROJECTS),
  getProject: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_PROJECT, id),
  createProject: (name: string, description?: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.CREATE_PROJECT, name, description),
  updateProject: (id: string, nameOrProps: any, description?: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.UPDATE_PROJECT, id, nameOrProps, description),
  archiveProject: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.ARCHIVE_PROJECT, id),
  unarchiveProject: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.UNARCHIVE_PROJECT, id),
  canDeleteProject: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.CAN_DELETE_PROJECT, id),
  deleteProject: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.DELETE_PROJECT, id),
  listPairs: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.LIST_PAIRS),
  getPair: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_PAIR, id),
  getPairRecoveryState: (pairId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_PAIR_RECOVERY_STATE, pairId),
  createPair: (
    projectId: string,
    name: string,
    plannerSessionId?: string,
    workerSessionId?: string,
    plannerConversationUrl?: string,
  ) =>
    ipcRenderer.invoke(
      RELAY_IPC_CHANNELS.CREATE_PAIR,
      projectId,
      name,
      plannerSessionId,
      workerSessionId,
      plannerConversationUrl,
    ),
  updatePair: (
    id: string,
    updates: { name?: string; plannerSessionId?: string | null; workerSessionId?: string | null },
  ) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.UPDATE_PAIR, id, updates),
  rebindPairPlanner: (pairId: string, plannerSessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.REBIND_PAIR_PLANNER, pairId, plannerSessionId),
  rebindPairWorker: (pairId: string, workerSessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.REBIND_PAIR_WORKER, pairId, workerSessionId),
  detachPairRuntime: (pairId: string, role: 'planner' | 'worker') =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.DETACH_PAIR_RUNTIME, pairId, role),
  startPair: (pairId: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.START_PAIR, pairId),
  loadAndActivatePair: (pairId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.LOAD_AND_ACTIVATE_PAIR, pairId),
  pausePair: (pairId: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.PAUSE_PAIR, pairId),
  resumePair: (pairId: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.RESUME_PAIR, pairId),
  stopPair: (pairId: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.STOP_PAIR, pairId),
  archivePair: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.ARCHIVE_PAIR, id),
  unarchivePair: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.UNARCHIVE_PAIR, id),
  canDeletePair: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.CAN_DELETE_PAIR, id),
  deletePair: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.DELETE_PAIR, id),
  listRuntimeSessions: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.LIST_RUNTIME_SESSIONS),
  registerRuntimeSession: (
    providerType: ProviderType,
    name: string,
    identityOrBundleId?: string,
    projectId?: string,
  ) =>
    ipcRenderer.invoke(
      RELAY_IPC_CHANNELS.REGISTER_RUNTIME_SESSION,
      providerType,
      name,
      identityOrBundleId,
      projectId,
    ),
  discoverRuntime: (providerType: ProviderType) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.DISCOVER_RUNTIME, providerType),
  inspectRuntime: (sessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.INSPECT_RUNTIME, sessionId),
  activateRuntime: (sessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.ACTIVATE_RUNTIME, sessionId),
  openRuntimeSession: (sessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.OPEN_RUNTIME_SESSION, sessionId),
  recoverRuntime: (sessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.RECOVER_RUNTIME, sessionId),
  detachRuntime: (sessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.DETACH_RUNTIME, sessionId),
  archiveRuntimeSession: (sessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.ARCHIVE_RUNTIME_SESSION, sessionId),
  unarchiveRuntimeSession: (sessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.UNARCHIVE_RUNTIME_SESSION, sessionId),
  canDeleteRuntimeSession: (sessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.CAN_DELETE_RUNTIME_SESSION, sessionId),
  deleteRuntimeSession: (sessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.DELETE_RUNTIME_SESSION, sessionId),
  listAssignments: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.LIST_ASSIGNMENTS),
  getAssignmentDetail: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_ASSIGNMENT_DETAIL, id),
  createAssignment: (pairId: string, title: string, instruction: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.CREATE_ASSIGNMENT, pairId, title, instruction),
  createAndDispatchAssignment: (pairId: string, title: string, instruction: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.CREATE_AND_DISPATCH_ASSIGNMENT, pairId, title, instruction),
  dispatchAssignment: (assignmentId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.DISPATCH_ASSIGNMENT, assignmentId),
  completeAssignment: (assignmentId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.COMPLETE_ASSIGNMENT, assignmentId),
  deliverHandoff: (handoffId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.DELIVER_HANDOFF, handoffId),
  resolveAmbiguousDelivery: (
    deliveryId: string,
    resolution: 'confirmed_delivered' | 'retry_permitted',
  ) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.RESOLVE_AMBIGUOUS_DELIVERY, deliveryId, resolution),
  listEvents: (limit?: number, resourceId?: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.LIST_EVENTS, limit, resourceId),
  queryEvents: (options: any) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.QUERY_EVENTS, options),
  listActivities: (limit?: number) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.LIST_ACTIVITIES, limit),
  runArchiveCycle: () =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.RUN_ARCHIVE_CYCLE),
  getArchivePolicy: () =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_ARCHIVE_POLICY),
  setArchivePolicy: (interval: string, note?: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.SET_ARCHIVE_POLICY, interval, note),
  clearLogs: (options?: any) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.CLEAR_LOGS, options),
  getStorageAccounting: () =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_STORAGE_ACCOUNTING),
  exportAuditData: (options?: any) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.EXPORT_AUDIT_DATA, options),
  getAuxiliaryLogsInfo: () =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_AUXILIARY_LOGS_INFO),
  readAuxiliaryLog: (name: string, maxLines?: number) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.READ_AUXILIARY_LOG, name, maxLines),
  clearAuxiliaryLog: (name: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.CLEAR_AUXILIARY_LOG, name),
  listAttentionItems: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.LIST_ATTENTION_ITEMS),
  acknowledgeAttentionItem: (id: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.ACKNOWLEDGE_ATTENTION_ITEM, id),
  runSupervisionTick: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.RUN_SUPERVISION_TICK),
  seedDemoEnvironment: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.SEED_DEMO_ENVIRONMENT),
  clearDatabase: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.CLEAR_DATABASE),
  selectProjectFolder: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.SELECT_PROJECT_FOLDER),
  resolveChatGPTProject: (name: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.RESOLVE_CHATGPT_PROJECT, name),
  discoverChatGPTPlanner: (name: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.DISCOVER_CHATGPT_PLANNER, name),
  discoverOpenCodeSessions: (projectPath: string, gitRoot?: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.DISCOVER_OPENCODE_SESSIONS, projectPath, gitRoot),
  enumerateChatGPTConversations: (projectId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.ENUMERATE_CHATGPT_CONVERSATIONS, projectId),
  enumerateWorkerChoices: (projectId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.ENUMERATE_WORKER_CHOICES, projectId),
  adoptOpenCodeSession: (projectId: string, sessionId: string, name?: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.ADOPT_OPENCODE_SESSION, projectId, sessionId, name),
  createOpenCodeWorkerSession: (projectId: string, name?: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.CREATE_OPENCODE_WORKER_SESSION, projectId, name),
  createChatGPTPlannerSession: (projectId: string, name?: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.CREATE_CHATGPT_PLANNER_SESSION, projectId, name),
  provisionPairWithNewSessions: (projectId: string, pairName: string, options?: any) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.PROVISION_PAIR_WITH_NEW_SESSIONS, projectId, pairName, options),
  finalizeProjectSetup: (setup: any) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.FINALIZE_PROJECT_SETUP, setup),
  getDiagnosticsReport: () =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_DIAGNOSTICS_REPORT),
  copyDiagnosticReport: () =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.COPY_DIAGNOSTIC_REPORT),
  // Phase 1 Health — read-only projections over persisted health state.
  getHealthSummary: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_HEALTH_SUMMARY),
  listHealthIncidents: (options?: { status?: 'active' | 'history'; limit?: number }) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.LIST_HEALTH_INCIDENTS, options ?? {}),
  getHealthIncident: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_HEALTH_INCIDENT, id),
  acknowledgeHealthIncident: (id: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.ACKNOWLEDGE_HEALTH_INCIDENT, id),
  generateHealthHandoffReport: (id: string, options?: { eventLimit?: number }) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.GENERATE_HEALTH_HANDOFF_REPORT, id, options ?? {}),
  listIntegrations: () =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.LIST_INTEGRATIONS),
  verifyIntegration: (providerType: ProviderType) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.VERIFY_INTEGRATION, providerType),
  recheckAllIntegrations: () =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.RECHECK_ALL_INTEGRATIONS),
  addIntegration: (config: any) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.ADD_INTEGRATION, config),
  updateIntegration: (id: string, updates: any) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.UPDATE_INTEGRATION, id, updates),
  deleteIntegration: (id: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.DELETE_INTEGRATION, id),
  toggleIntegrationEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.TOGGLE_INTEGRATION_ENABLED, id, enabled),
  setDefaultIntegration: (id: string, role: 'planner' | 'worker') =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.SET_DEFAULT_INTEGRATION, id, role),
  getDefaultPlannerIntegration: () =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_DEFAULT_PLANNER_INTEGRATION),
  getDefaultWorkerIntegration: () =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_DEFAULT_WORKER_INTEGRATION),
  updatePlannerConversationUrl: (pairId: string, url: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.UPDATE_PLANNER_CONVERSATION_URL, pairId, url),
  testIntegration: (id: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.TEST_INTEGRATION, id),
  setProjectIntegrationOverride: (projectId: string, override: any) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.SET_PROJECT_INTEGRATION_OVERRIDE, projectId, override),
  getProjectIntegrationOverride: (projectId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_PROJECT_INTEGRATION_OVERRIDE, projectId),
  listProjectIntegrationOverrides: () =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.LIST_PROJECT_INTEGRATION_OVERRIDES),
  getSupportedModels: (providerType: ProviderType) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_SUPPORTED_MODELS, providerType),
  getEffectiveModelConfig: (providerType: ProviderType, projectId?: string, pairId?: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_EFFECTIVE_MODEL_CONFIG, providerType, projectId, pairId),
  setGlobalModelDefault: (providerType: ProviderType, model: string, note?: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.SET_GLOBAL_MODEL_DEFAULT, providerType, model, note),
  setProjectModelOverride: (projectId: string, providerType: ProviderType, model: string, justification: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.SET_PROJECT_MODEL_OVERRIDE, projectId, providerType, model, justification),
  clearProjectModelOverride: (projectId: string, providerType: ProviderType) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.CLEAR_PROJECT_MODEL_OVERRIDE, projectId, providerType),
  setPairModelOverride: (pairId: string, providerType: ProviderType, model: string, justification: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.SET_PAIR_MODEL_OVERRIDE, pairId, providerType, model, justification),
  clearPairModelOverride: (pairId: string, providerType: ProviderType) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.CLEAR_PAIR_MODEL_OVERRIDE, pairId, providerType),
};

contextBridge.exposeInMainWorld('relayApi', relayApi);
