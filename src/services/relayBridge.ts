import { IRelayApi } from '../types/relayApi.ts';
import { MemoryRelayDatabase } from '../relay/persistence/memory/MemoryDatabase.ts';
import { RelayEngine } from '../relay/application/RelayEngine.ts';
import { RelayApiService } from '../relay/application/RelayApiService.ts';
import {
  BrowserChatGPTProvider,
  BrowserOpenCodeProvider,
  BrowserVSCodeProvider,
} from '../relay/providers/browserProviders.ts';

let localFallbackService: RelayApiService | null = null;

function getLocalFallbackService(): RelayApiService {
  if (!localFallbackService) {
    const memDb = new MemoryRelayDatabase();
    const engine = new RelayEngine(memDb);

    engine.registerProvider(new BrowserChatGPTProvider());
    engine.registerProvider(new BrowserOpenCodeProvider());
    engine.registerProvider(new BrowserVSCodeProvider());

    localFallbackService = new RelayApiService(memDb, engine, {
      isElectron: false,
      databasePath: ':memory:',
      databaseType: 'memory',
    });
  }
  return localFallbackService;
}

/**
 * The unified Relay Bridge.
 * Prioritizes the secure typed Electron IPC bridge (`window.relayApi`).
 * Falls back to an in-memory RelayApiService in browser dev preview.
 */
export const relayBridge: IRelayApi = {
  getAppStatus: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getAppStatus();
    }
    return getLocalFallbackService().getAppStatus();
  },

  getDashboardState: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getDashboardState();
    }
    return getLocalFallbackService().getDashboardState();
  },

  listProjects: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.listProjects();
    }
    return getLocalFallbackService().listProjects();
  },

  getProject: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getProject(id);
    }
    return getLocalFallbackService().getProject(id);
  },

  createProject: async (name: string, description?: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.createProject(name, description);
    }
    return getLocalFallbackService().createProject(name, description);
  },

  updateProject: async (id: string, name: string, description?: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.updateProject(id, name, description);
    }
    return getLocalFallbackService().updateProject(id, name, description);
  },

  archiveProject: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.archiveProject(id);
    }
    return getLocalFallbackService().archiveProject(id);
  },

  unarchiveProject: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.unarchiveProject(id);
    }
    return getLocalFallbackService().unarchiveProject(id);
  },

  canDeleteProject: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.canDeleteProject(id);
    }
    return getLocalFallbackService().canDeleteProject(id);
  },

  deleteProject: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.deleteProject(id);
    }
    return getLocalFallbackService().deleteProject(id);
  },

  listPairs: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.listPairs();
    }
    return getLocalFallbackService().listPairs();
  },

  getPair: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getPair(id);
    }
    return getLocalFallbackService().getPair(id);
  },

  createPair: async (
    projectId: string,
    name: string,
    plannerSessionId?: string,
    workerSessionId?: string,
  ) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.createPair(projectId, name, plannerSessionId, workerSessionId);
    }
    return getLocalFallbackService().createPair(
      projectId,
      name,
      plannerSessionId,
      workerSessionId,
    );
  },

  updatePair: async (id, updates) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.updatePair(id, updates);
    }
    return getLocalFallbackService().updatePair(id, updates);
  },

  rebindPairPlanner: async (pairId: string, plannerSessionId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.rebindPairPlanner(pairId, plannerSessionId);
    }
    return getLocalFallbackService().rebindPairPlanner(pairId, plannerSessionId);
  },

  rebindPairWorker: async (pairId: string, workerSessionId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.rebindPairWorker(pairId, workerSessionId);
    }
    return getLocalFallbackService().rebindPairWorker(pairId, workerSessionId);
  },

  detachPairRuntime: async (pairId: string, role: 'planner' | 'worker') => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.detachPairRuntime(pairId, role);
    }
    return getLocalFallbackService().detachPairRuntime(pairId, role);
  },

  startPair: async (pairId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.startPair(pairId);
    }
    return getLocalFallbackService().startPair(pairId);
  },

  pausePair: async (pairId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.pausePair(pairId);
    }
    return getLocalFallbackService().pausePair(pairId);
  },

  resumePair: async (pairId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.resumePair(pairId);
    }
    return getLocalFallbackService().resumePair(pairId);
  },

  stopPair: async (pairId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.stopPair(pairId);
    }
    return getLocalFallbackService().stopPair(pairId);
  },

  archivePair: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.archivePair(id);
    }
    return getLocalFallbackService().archivePair(id);
  },

  unarchivePair: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.unarchivePair(id);
    }
    return getLocalFallbackService().unarchivePair(id);
  },

  canDeletePair: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.canDeletePair(id);
    }
    return getLocalFallbackService().canDeletePair(id);
  },

  deletePair: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.deletePair(id);
    }
    return getLocalFallbackService().deletePair(id);
  },

  listRuntimeSessions: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.listRuntimeSessions();
    }
    return getLocalFallbackService().listRuntimeSessions();
  },

  registerRuntimeSession: async (providerType, name, bundleIdentifier) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.registerRuntimeSession(providerType, name, bundleIdentifier);
    }
    return getLocalFallbackService().registerRuntimeSession(
      providerType,
      name,
      bundleIdentifier,
    );
  },

  discoverRuntime: async (providerType) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.discoverRuntime(providerType);
    }
    return getLocalFallbackService().discoverRuntime(providerType);
  },

  inspectRuntime: async (sessionId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.inspectRuntime(sessionId);
    }
    return getLocalFallbackService().inspectRuntime(sessionId);
  },

  recoverRuntime: async (sessionId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.recoverRuntime(sessionId);
    }
    return getLocalFallbackService().recoverRuntime(sessionId);
  },

  detachRuntime: async (sessionId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.detachRuntime(sessionId);
    }
    return getLocalFallbackService().detachRuntime(sessionId);
  },

  canDeleteRuntimeSession: async (sessionId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.canDeleteRuntimeSession(sessionId);
    }
    return getLocalFallbackService().canDeleteRuntimeSession(sessionId);
  },

  deleteRuntimeSession: async (sessionId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.deleteRuntimeSession(sessionId);
    }
    return getLocalFallbackService().deleteRuntimeSession(sessionId);
  },
  
  archiveRuntimeSession: async (sessionId: string, reason?: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.archiveRuntimeSession(sessionId, reason);
    }
    return getLocalFallbackService().archiveRuntimeSession(sessionId, reason);
  },

  unarchiveRuntimeSession: async (sessionId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.unarchiveRuntimeSession(sessionId);
    }
    return getLocalFallbackService().unarchiveRuntimeSession(sessionId);
  },

  listAssignments: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.listAssignments();
    }
    return getLocalFallbackService().listAssignments();
  },

  createAssignment: async (pairId: string, title: string, instruction: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.createAssignment(pairId, title, instruction);
    }
    return getLocalFallbackService().createAssignment(pairId, title, instruction);
  },

  dispatchAssignment: async (assignmentId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.dispatchAssignment(assignmentId);
    }
    return getLocalFallbackService().dispatchAssignment(assignmentId);
  },

  completeAssignment: async (assignmentId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.completeAssignment(assignmentId);
    }
    return getLocalFallbackService().completeAssignment(assignmentId);
  },

  deliverHandoff: async (handoffId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.deliverHandoff(handoffId);
    }
    return getLocalFallbackService().deliverHandoff(handoffId);
  },

  resolveAmbiguousDelivery: async (deliveryId, resolution) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.resolveAmbiguousDelivery(deliveryId, resolution);
    }
    return getLocalFallbackService().resolveAmbiguousDelivery(deliveryId, resolution);
  },

  listEvents: async (limit, resourceId) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.listEvents(limit, resourceId);
    }
    return getLocalFallbackService().listEvents(limit, resourceId);
  },

  listAttentionItems: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.listAttentionItems();
    }
    return getLocalFallbackService().listAttentionItems();
  },

  acknowledgeAttentionItem: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.acknowledgeAttentionItem(id);
    }
    return getLocalFallbackService().acknowledgeAttentionItem(id);
  },

  runSupervisionTick: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.runSupervisionTick();
    }
    return getLocalFallbackService().runSupervisionTick();
  },

  seedDemoEnvironment: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.seedDemoEnvironment();
    }
    return getLocalFallbackService().seedDemoEnvironment();
  },

  clearDatabase: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.clearDatabase();
    }
    return getLocalFallbackService().clearDatabase();
  },

  selectProjectFolder: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.selectProjectFolder();
    }
    return getLocalFallbackService().selectProjectFolder();
  },

  resolveChatGPTProject: async (name: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.resolveChatGPTProject(name);
    }
    return getLocalFallbackService().resolveChatGPTProject(name);
  },

  discoverChatGPTPlanner: async (name: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.discoverChatGPTPlanner(name);
    }
    return getLocalFallbackService().discoverChatGPTPlanner(name);
  },

  discoverOpenCodeSessions: async (projectPath: string, gitRoot?: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.discoverOpenCodeSessions(projectPath, gitRoot);
    }
    return getLocalFallbackService().discoverOpenCodeSessions(projectPath, gitRoot);
  },

  finalizeProjectSetup: async (setup) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.finalizeProjectSetup(setup);
    }
    return getLocalFallbackService().finalizeProjectSetup(setup);
  },
};
