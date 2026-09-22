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
  updateProject: (id: string, name: string, description?: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.UPDATE_PROJECT, id, name, description),
  archiveProject: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.ARCHIVE_PROJECT, id),
  unarchiveProject: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.UNARCHIVE_PROJECT, id),
  canDeleteProject: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.CAN_DELETE_PROJECT, id),
  deleteProject: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.DELETE_PROJECT, id),
  listPairs: () => ipcRenderer.invoke(RELAY_IPC_CHANNELS.LIST_PAIRS),
  getPair: (id: string) => ipcRenderer.invoke(RELAY_IPC_CHANNELS.GET_PAIR, id),
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
    bundleIdentifier?: string,
  ) =>
    ipcRenderer.invoke(
      RELAY_IPC_CHANNELS.REGISTER_RUNTIME_SESSION,
      providerType,
      name,
      bundleIdentifier,
    ),
  discoverRuntime: (providerType: ProviderType) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.DISCOVER_RUNTIME, providerType),
  inspectRuntime: (sessionId: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.INSPECT_RUNTIME, sessionId),
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
  createAssignment: (pairId: string, title: string, instruction: string) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.CREATE_ASSIGNMENT, pairId, title, instruction),
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
  finalizeProjectSetup: (setup: any) =>
    ipcRenderer.invoke(RELAY_IPC_CHANNELS.FINALIZE_PROJECT_SETUP, setup),
};

contextBridge.exposeInMainWorld('relayApi', relayApi);
