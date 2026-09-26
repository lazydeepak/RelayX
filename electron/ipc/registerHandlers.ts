import { app, BrowserWindow, ipcMain } from 'electron';
import { RELAY_IPC_CHANNELS } from './contracts.ts';
import { RelayApiService } from '../../src/relay/application/RelayApiService.ts';

export function registerRelayIpcHandlers(service: RelayApiService): void {
  ipcMain.handle(RELAY_IPC_CHANNELS.GET_APP_STATUS, () => service.getAppStatus());
  ipcMain.handle(RELAY_IPC_CHANNELS.GET_DASHBOARD_STATE, () => service.getDashboardState());
  ipcMain.handle(RELAY_IPC_CHANNELS.LIST_PROJECTS, () => service.listProjects());
  ipcMain.handle(RELAY_IPC_CHANNELS.GET_PROJECT, (_event, id) => service.getProject(id));
  ipcMain.handle(RELAY_IPC_CHANNELS.CREATE_PROJECT, (_event, name, desc) =>
    service.createProject(name, desc),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.UPDATE_PROJECT, (_event, id, name, desc) =>
    service.updateProject(id, name, desc),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.ARCHIVE_PROJECT, (_event, id) => service.archiveProject(id));
  ipcMain.handle(RELAY_IPC_CHANNELS.UNARCHIVE_PROJECT, (_event, id) => service.unarchiveProject(id));
  ipcMain.handle(RELAY_IPC_CHANNELS.CAN_DELETE_PROJECT, (_event, id) => service.canDeleteProject(id));
  ipcMain.handle(RELAY_IPC_CHANNELS.DELETE_PROJECT, (_event, id) => service.deleteProject(id));

  ipcMain.handle(RELAY_IPC_CHANNELS.LIST_PAIRS, () => service.listPairs());
  ipcMain.handle(RELAY_IPC_CHANNELS.GET_PAIR, (_event, id) => service.getPair(id));
  ipcMain.handle(
    RELAY_IPC_CHANNELS.CREATE_PAIR,
    (_event, projId, name, plannerId, workerId, plannerConversationUrl) =>
      service.createPair(projId, name, plannerId, workerId, plannerConversationUrl),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.UPDATE_PAIR, (_event, id, updates) =>
    service.updatePair(id, updates),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.REBIND_PAIR_PLANNER, (_event, pairId, plannerId) =>
    service.rebindPairPlanner(pairId, plannerId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.REBIND_PAIR_WORKER, (_event, pairId, workerId) =>
    service.rebindPairWorker(pairId, workerId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.DETACH_PAIR_RUNTIME, (_event, pairId, role) =>
    service.detachPairRuntime(pairId, role),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.START_PAIR, (_event, pairId) => service.startPair(pairId));
  ipcMain.handle(RELAY_IPC_CHANNELS.PAUSE_PAIR, (_event, pairId) => service.pausePair(pairId));
  ipcMain.handle(RELAY_IPC_CHANNELS.RESUME_PAIR, (_event, pairId) => service.resumePair(pairId));
  ipcMain.handle(RELAY_IPC_CHANNELS.STOP_PAIR, (_event, pairId) => service.stopPair(pairId));
  ipcMain.handle(RELAY_IPC_CHANNELS.ARCHIVE_PAIR, (_event, pairId) => service.archivePair(pairId));
  ipcMain.handle(RELAY_IPC_CHANNELS.UNARCHIVE_PAIR, (_event, pairId) => service.unarchivePair(pairId));
  ipcMain.handle(RELAY_IPC_CHANNELS.CAN_DELETE_PAIR, (_event, pairId) => service.canDeletePair(pairId));
  ipcMain.handle(RELAY_IPC_CHANNELS.DELETE_PAIR, (_event, pairId) => service.deletePair(pairId));

  ipcMain.handle(RELAY_IPC_CHANNELS.LIST_RUNTIME_SESSIONS, () =>
    service.listRuntimeSessions(),
  );
  ipcMain.handle(
    RELAY_IPC_CHANNELS.REGISTER_RUNTIME_SESSION,
    (_event, type, name, bundleId) => service.registerRuntimeSession(type, name, bundleId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.DISCOVER_RUNTIME, (_event, type) =>
    service.discoverRuntime(type),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.INSPECT_RUNTIME, (_event, sessionId) =>
    service.inspectRuntime(sessionId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.RECOVER_RUNTIME, (_event, sessionId) =>
    service.recoverRuntime(sessionId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.DETACH_RUNTIME, (_event, sessionId) =>
    service.detachRuntime(sessionId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.CAN_DELETE_RUNTIME_SESSION, (_event, sessionId) =>
    service.canDeleteRuntimeSession(sessionId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.DELETE_RUNTIME_SESSION, (_event, sessionId) =>
    service.deleteRuntimeSession(sessionId),
  );

  ipcMain.handle(RELAY_IPC_CHANNELS.LIST_ASSIGNMENTS, () => service.listAssignments());
  ipcMain.handle(
    RELAY_IPC_CHANNELS.CREATE_ASSIGNMENT,
    (_event, pairId, title, instruction) => service.createAssignment(pairId, title, instruction),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.DISPATCH_ASSIGNMENT, (_event, assignmentId) =>
    service.dispatchAssignment(assignmentId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.COMPLETE_ASSIGNMENT, (_event, assignmentId) =>
    service.completeAssignment(assignmentId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.DELIVER_HANDOFF, (_event, handoffId) =>
    service.deliverHandoff(handoffId),
  );
  ipcMain.handle(
    RELAY_IPC_CHANNELS.RESOLVE_AMBIGUOUS_DELIVERY,
    (_event, deliveryId, resolution) => service.resolveAmbiguousDelivery(deliveryId, resolution),
  );

  ipcMain.handle(RELAY_IPC_CHANNELS.LIST_EVENTS, (_event, limit, resourceId) =>
    service.listEvents(limit, resourceId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.LIST_ATTENTION_ITEMS, () => service.listAttentionItems());
  ipcMain.handle(RELAY_IPC_CHANNELS.ACKNOWLEDGE_ATTENTION_ITEM, (_event, id) =>
    service.acknowledgeAttentionItem(id),
  );

  ipcMain.handle(RELAY_IPC_CHANNELS.RUN_SUPERVISION_TICK, () =>
    service.runSupervisionTick(),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.SEED_DEMO_ENVIRONMENT, () =>
    service.seedDemoEnvironment(),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.CLEAR_DATABASE, () => service.clearDatabase());

  // Add Project Workflow
  ipcMain.handle(RELAY_IPC_CHANNELS.SELECT_PROJECT_FOLDER, () => service.selectProjectFolder());
  ipcMain.handle(RELAY_IPC_CHANNELS.RESOLVE_CHATGPT_PROJECT, async (event, name) => {
    try {
      return await service.resolveChatGPTProject(name);
    } finally {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (process.platform === 'darwin') app.focus({ steal: true });
      }
    }
  });
  ipcMain.handle(RELAY_IPC_CHANNELS.DISCOVER_CHATGPT_PLANNER, (_event, name) =>
    service.discoverChatGPTPlanner(name),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.DISCOVER_OPENCODE_SESSIONS, (_event, projectPath, gitRoot) =>
    service.discoverOpenCodeSessions(projectPath, gitRoot),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.ENUMERATE_CHATGPT_CONVERSATIONS, (_event, projectId) =>
    service.enumerateChatGPTConversations(projectId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.ENUMERATE_WORKER_CHOICES, (_event, projectId) =>
    service.enumerateWorkerChoices(projectId),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.ADOPT_OPENCODE_SESSION, (_event, projectId, sessionId, name) =>
    service.adoptOpenCodeSession(projectId, sessionId, name),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.CREATE_OPENCODE_WORKER_SESSION, (_event, projectId, name) =>
    service.createOpenCodeWorkerSession(projectId, name),
  );
  ipcMain.handle(RELAY_IPC_CHANNELS.FINALIZE_PROJECT_SETUP, (_event, setup) =>
    service.finalizeProjectSetup(setup),
  );
}
