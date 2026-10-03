/**
 * ============================================================================
 * RELAY BRIDGE — CLIENT IPC & BROWSER PREVIEW BOUNDARY
 * ============================================================================
 *
 * This module exports `relayBridge`, implementing the `IRelayApi` interface.
 *
 * RUNTIME MODES:
 * 1. Electron Desktop App:
 *    When running within Electron, `window.relayApi` is exposed by the preload
 *    script via contextIsolation IPC. All calls delegate directly to the
 *    main Electron process with native SQLite and macOS system automation.
 *
 * 2. Web / Dev Preview (Fallback):
 *    When Electron is absent, `relayBridge` delegates to a deliberately inert,
 *    browser-safe preview API. Backend state and provider operations remain in the
 *    Electron main process and are never bundled into the renderer.
 */

import { IRelayApi } from '../types/relayApi.ts';
import { browserPreviewApi } from './browserPreviewApi.ts';

function getLocalFallbackService(): IRelayApi {
  return browserPreviewApi;
}

/**
 * The unified Relay Bridge.
 * Prioritizes the secure typed Electron IPC bridge (`window.relayApi`).
 * Falls back to an inert browser-only API in web preview.
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

  updateProject: async (id: string, nameOrProps: any, description?: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.updateProject(id, nameOrProps, description);
    }
    return getLocalFallbackService().updateProject(id, nameOrProps, description);
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
    plannerConversationUrl?: string,
  ) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.createPair(projectId, name, plannerSessionId, workerSessionId, plannerConversationUrl);
    }
    return getLocalFallbackService().createPair(
      projectId,
      name,
      plannerSessionId,
      workerSessionId,
      plannerConversationUrl,
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

  updatePlannerConversationUrl: async (pairId: string, conversationUrl: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return (window.relayApi as any).updatePlannerConversationUrl
        ? (window.relayApi as any).updatePlannerConversationUrl(pairId, conversationUrl)
        : getLocalFallbackService().updatePlannerConversationUrl(pairId, conversationUrl);
    }
    return getLocalFallbackService().updatePlannerConversationUrl(pairId, conversationUrl);
  },

  startPair: async (pairId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.startPair(pairId);
    }
    return getLocalFallbackService().startPair(pairId);
  },

  loadAndActivatePair: async (pairId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return (window.relayApi as any).loadAndActivatePair ? (window.relayApi as any).loadAndActivatePair(pairId) : getLocalFallbackService().loadAndActivatePair(pairId);
    }
    return getLocalFallbackService().loadAndActivatePair(pairId);
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

  registerRuntimeSession: async (providerType, name, identityOrBundleId, projectId) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.registerRuntimeSession(providerType, name, identityOrBundleId, projectId);
    }
    return getLocalFallbackService().registerRuntimeSession(
      providerType,
      name,
      identityOrBundleId,
      projectId,
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

  activateRuntime: async (sessionId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.activateRuntime(sessionId);
    }
    return getLocalFallbackService().activateRuntime(sessionId);
  },

  openRuntimeSession: async (sessionId: string) => {
    if (typeof window !== 'undefined' && (window.relayApi as any)?.openRuntimeSession) {
      return (window.relayApi as any).openRuntimeSession(sessionId);
    }
    return getLocalFallbackService().openRuntimeSession(sessionId);
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

  createAndDispatchAssignment: async (pairId: string, title: string, instruction: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.createAndDispatchAssignment(pairId, title, instruction);
    }
    return getLocalFallbackService().createAndDispatchAssignment(pairId, title, instruction);
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
  getAssignmentDetail: async (id: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return (window.relayApi as any).getAssignmentDetail ? (window.relayApi as any).getAssignmentDetail(id) : getLocalFallbackService().getAssignmentDetail(id);
    }
    return getLocalFallbackService().getAssignmentDetail(id);
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

  queryEvents: async (options) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.queryEvents(options);
    }
    return getLocalFallbackService().queryEvents(options);
  },

  listActivities: async (limit) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.listActivities(limit);
    }
    return getLocalFallbackService().listActivities(limit);
  },

  runArchiveCycle: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.runArchiveCycle();
    }
    return getLocalFallbackService().runArchiveCycle();
  },

  getArchivePolicy: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getArchivePolicy();
    }
    return getLocalFallbackService().getArchivePolicy();
  },

  setArchivePolicy: async (interval, note) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.setArchivePolicy(interval, note);
    }
    return getLocalFallbackService().setArchivePolicy(interval, note);
  },

  clearLogs: async (options) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.clearLogs(options);
    }
    return getLocalFallbackService().clearLogs(options);
  },

  getStorageAccounting: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getStorageAccounting();
    }
    return getLocalFallbackService().getStorageAccounting();
  },

  exportAuditData: async (options) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.exportAuditData(options);
    }
    return getLocalFallbackService().exportAuditData(options);
  },

  getAuxiliaryLogsInfo: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getAuxiliaryLogsInfo();
    }
    return getLocalFallbackService().getAuxiliaryLogsInfo();
  },

  readAuxiliaryLog: async (name, maxLines) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.readAuxiliaryLog(name, maxLines);
    }
    return getLocalFallbackService().readAuxiliaryLog(name, maxLines);
  },

  clearAuxiliaryLog: async (name) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.clearAuxiliaryLog(name);
    }
    return getLocalFallbackService().clearAuxiliaryLog(name);
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

  createOpenCodeWorkerSession: async (projectId: string, name?: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.createOpenCodeWorkerSession(projectId, name);
    }
    return getLocalFallbackService().createOpenCodeWorkerSession(projectId, name);
  },

  createChatGPTPlannerSession: async (projectId: string, name?: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.createChatGPTPlannerSession(projectId, name);
    }
    return getLocalFallbackService().createChatGPTPlannerSession(projectId, name);
  },

  provisionPairWithNewSessions: async (
    projectId: string,
    pairName: string,
    options?: { plannerName?: string; workerName?: string; conversationUrl?: string },
  ) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.provisionPairWithNewSessions(projectId, pairName, options);
    }
    return getLocalFallbackService().provisionPairWithNewSessions(projectId, pairName, options);
  },

  enumerateChatGPTConversations: async (projectId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.enumerateChatGPTConversations(projectId);
    }
    return getLocalFallbackService().enumerateChatGPTConversations(projectId);
  },

  enumerateWorkerChoices: async (projectId: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.enumerateWorkerChoices(projectId);
    }
    return getLocalFallbackService().enumerateWorkerChoices(projectId);
  },

  adoptOpenCodeSession: async (projectId: string, sessionId: string, name?: string) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.adoptOpenCodeSession(projectId, sessionId, name);
    }
    return getLocalFallbackService().adoptOpenCodeSession(projectId, sessionId, name);
  },

  finalizeProjectSetup: async (setup) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.finalizeProjectSetup(setup);
    }
    return getLocalFallbackService().finalizeProjectSetup(setup);
  },

  getDiagnosticsReport: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getDiagnosticsReport();
    }
    return getLocalFallbackService().getDiagnosticsReport();
  },

  // --- Phase 1 Health (read-only) ---
  // The renderer only READS persisted health state. None of these run a
  // detector, contact a provider, or spawn a subprocess.
  getHealthSummary: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getHealthSummary();
    }
    return getLocalFallbackService().getHealthSummary();
  },

  listHealthIncidents: async (options) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.listHealthIncidents(options);
    }
    return getLocalFallbackService().listHealthIncidents(options);
  },

  getHealthIncident: async (id) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getHealthIncident(id);
    }
    return getLocalFallbackService().getHealthIncident(id);
  },

  acknowledgeHealthIncident: async (id) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.acknowledgeHealthIncident(id);
    }
    return getLocalFallbackService().acknowledgeHealthIncident(id);
  },

  generateHealthHandoffReport: async (id, options) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.generateHealthHandoffReport(id, options);
    }
    return getLocalFallbackService().generateHealthHandoffReport(id, options);
  },

  copyDiagnosticReport: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.copyDiagnosticReport();
    }
    return getLocalFallbackService().copyDiagnosticReport();  },

  listIntegrations: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.listIntegrations();
    }
    return getLocalFallbackService().listIntegrations();
  },

  verifyIntegration: async (providerType) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.verifyIntegration(providerType);
    }
    return getLocalFallbackService().verifyIntegration(providerType);
  },

  recheckAllIntegrations: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.recheckAllIntegrations();
    }
    return getLocalFallbackService().recheckAllIntegrations();
  },

  addIntegration: async (config) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.addIntegration(config);
    }
    return getLocalFallbackService().addIntegration(config);
  },

  updateIntegration: async (id, updates) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.updateIntegration(id, updates);
    }
    return getLocalFallbackService().updateIntegration(id, updates);
  },

  deleteIntegration: async (id) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.deleteIntegration(id);
    }
    return getLocalFallbackService().deleteIntegration(id);
  },

  toggleIntegrationEnabled: async (id, enabled) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.toggleIntegrationEnabled(id, enabled);
    }
    return getLocalFallbackService().toggleIntegrationEnabled(id, enabled);
  },

  setDefaultIntegration: async (id, role) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.setDefaultIntegration(id, role);
    }
    return getLocalFallbackService().setDefaultIntegration(id, role);
  },

  getDefaultPlannerIntegration: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getDefaultPlannerIntegration();
    }
    return getLocalFallbackService().getDefaultPlannerIntegration();
  },

  getDefaultWorkerIntegration: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getDefaultWorkerIntegration();
    }
    return getLocalFallbackService().getDefaultWorkerIntegration();
  },

  testIntegration: async (id) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.testIntegration(id);
    }
    return getLocalFallbackService().testIntegration(id);
  },

  setProjectIntegrationOverride: async (projectId, override) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.setProjectIntegrationOverride(projectId, override);
    }
    return getLocalFallbackService().setProjectIntegrationOverride(projectId, override);
  },

  getProjectIntegrationOverride: async (projectId) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getProjectIntegrationOverride(projectId);
    }
    return getLocalFallbackService().getProjectIntegrationOverride(projectId);
  },

  listProjectIntegrationOverrides: async () => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.listProjectIntegrationOverrides();
    }
    return getLocalFallbackService().listProjectIntegrationOverrides();
  },

  getSupportedModels: async (providerType) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getSupportedModels(providerType);
    }
    return getLocalFallbackService().getSupportedModels(providerType);
  },

  getEffectiveModelConfig: async (providerType, projectId, pairId) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.getEffectiveModelConfig(providerType, projectId, pairId);
    }
    return getLocalFallbackService().getEffectiveModelConfig(providerType, projectId, pairId);
  },

  setGlobalModelDefault: async (providerType, model, note) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.setGlobalModelDefault(providerType, model, note);
    }
    return getLocalFallbackService().setGlobalModelDefault(providerType, model, note);
  },

  setProjectModelOverride: async (projectId, providerType, model, justification) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.setProjectModelOverride(projectId, providerType, model, justification);
    }
    return getLocalFallbackService().setProjectModelOverride(projectId, providerType, model, justification);
  },

  clearProjectModelOverride: async (projectId, providerType) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.clearProjectModelOverride(projectId, providerType);
    }
    return getLocalFallbackService().clearProjectModelOverride(projectId, providerType);
  },

  setPairModelOverride: async (pairId, providerType, model, justification) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.setPairModelOverride(pairId, providerType, model, justification);
    }
    return getLocalFallbackService().setPairModelOverride(pairId, providerType, model, justification);
  },

  clearPairModelOverride: async (pairId, providerType) => {
    if (typeof window !== 'undefined' && window.relayApi) {
      return window.relayApi.clearPairModelOverride(pairId, providerType);
    }
    return getLocalFallbackService().clearPairModelOverride(pairId, providerType);
  },
};
