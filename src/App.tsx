import React, { useState, useEffect, useCallback } from 'react';
import { Sidebar } from './components/Sidebar.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { PairView } from './components/PairView.tsx';
import { SessionsView } from './components/SessionsView.tsx';
import { AssignmentsView } from './components/AssignmentsView.tsx';
import { EventsTimelineView } from './components/EventsTimelineView.tsx';
import { AttentionRecoveryView } from './components/AttentionRecoveryView.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { EvidenceModal } from './components/EvidenceModal.tsx';
import { CreateAssignmentModal } from './components/CreateAssignmentModal.tsx';
import { ProjectModal, ProjectModalMode } from './components/ProjectModal.tsx';
import { PairModal, PairModalMode } from './components/PairModal.tsx';
import { RuntimeModal, RuntimeModalMode } from './components/RuntimeModal.tsx';
import { RuntimeHistoryModal } from './components/RuntimeHistoryModal.tsx';
import { ProjectDetailModal } from './components/ProjectDetailModal.tsx';
import { SessionDetailModal } from './components/SessionDetailModal.tsx';
import { AddProjectWizard } from './components/AddProjectWizard.tsx';
import { relayBridge } from './services/relayBridge.ts';
import {
  NavTab,
  UIProject,
  UIPair,
  UIRuntimeSession,
  UIAssignment,
  UIEvent,
  UIAttentionItem,
  ObservableEvidence,
} from './types/ui.ts';
import { AppStatus } from './types/relayApi.ts';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [metrics, setMetrics] = useState({
    totalProjects: 0,
    totalPairs: 0,
    totalRuntimes: 0,
    activeWorkers: 0,
    activeAssignments: 0,
    waitingReview: 0,
    openAttentionItems: 0,
    ambiguousDeliveries: 0,
  });
  const [projects, setProjects] = useState<UIProject[]>([]);
  const [pairs, setPairs] = useState<UIPair[]>([]);
  const [sessions, setSessions] = useState<UIRuntimeSession[]>([]);
  const [assignments, setAssignments] = useState<UIAssignment[]>([]);
  const [events, setEvents] = useState<UIEvent[]>([]);
  const [attentionItems, setAttentionItems] = useState<UIAttentionItem[]>([]);
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<ObservableEvidence | null>(null);
  const [isNewAssignmentOpen, setIsNewAssignmentOpen] = useState(false);
  const [isSupervising, setIsSupervising] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(() => {
    return (localStorage.getItem('relay_theme') as 'light' | 'dark' | 'system') || 'system';
  });
  const [statusNotification, setStatusNotification] = useState<string | null>(null);
  const [isAddProjectWizardOpen, setIsAddProjectWizardOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem('relay_theme', theme);
    const root = document.documentElement;

    const applyTheme = (isDark: boolean) => {
      if (isDark) {
        root.classList.add('dark');
        root.classList.remove('light');
      } else {
        root.classList.remove('dark');
        root.classList.add('light');
      }
    };

    if (theme === 'dark') {
      applyTheme(true);
    } else if (theme === 'light') {
      applyTheme(false);
    } else {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      applyTheme(mediaQuery.matches);

      const handler = (e: MediaQueryListEvent) => {
        applyTheme(e.matches);
      };
      mediaQuery.addEventListener('change', handler);
      return () => {
        mediaQuery.removeEventListener('change', handler);
      };
    }
  }, [theme]);

  // Management modals state
  const [projectModal, setProjectModal] = useState<{
    isOpen: boolean;
    mode: ProjectModalMode;
    project?: UIProject | null;
  }>({ isOpen: false, mode: 'create', project: null });

  const [pairModal, setPairModal] = useState<{
    isOpen: boolean;
    mode: PairModalMode;
    pair?: UIPair | null;
    initialProjectId?: string;
  }>({ isOpen: false, mode: 'create', pair: null });

  const [runtimeModal, setRuntimeModal] = useState<{
    isOpen: boolean;
    mode: RuntimeModalMode;
    session?: UIRuntimeSession | null;
  }>({ isOpen: false, mode: 'discover', session: null });

  const [historyModal, setHistoryModal] = useState<{
    isOpen: boolean;
    sessionId: string;
    sessionName: string;
  }>({ isOpen: false, sessionId: '', sessionName: '' });

  const [projectDetail, setProjectDetail] = useState<{
    isOpen: boolean;
    projectId: string | null;
  }>({ isOpen: false, projectId: null });

  const [sessionDetail, setSessionDetail] = useState<{
    isOpen: boolean;
    sessionId: string | null;
  }>({ isOpen: false, sessionId: null });

  const notify = (msg: string) => {
    setStatusNotification(msg);
    setTimeout(() => setStatusNotification(null), 3500);
  };

  const loadData = useCallback(async () => {
    try {
      const [dash, prjList, pList, rList, aList, eList, attList, status] = await Promise.all([
        relayBridge.getDashboardState(),
        relayBridge.listProjects(),
        relayBridge.listPairs(),
        relayBridge.listRuntimeSessions(),
        relayBridge.listAssignments(),
        relayBridge.listEvents(100),
        relayBridge.listAttentionItems(),
        relayBridge.getAppStatus(),
      ]);

      setMetrics(dash.metrics);
      setProjects(prjList);
      setPairs(pList);
      setSessions(rList);
      setAssignments(aList);
      setEvents(eList);
      setAttentionItems(attList);
      setAppStatus(status);
    } catch (err) {
      console.error('Failed to load RelayX state from bridge:', err);
    }
  }, []);

  useEffect(() => {
    loadData();
    // Background pulse every 5 seconds to keep observable state fresh
    const timer = setInterval(() => {
      loadData();
    }, 5000);
    return () => clearInterval(timer);
  }, [loadData]);

  // Project Management Actions
  const handleArchiveProject = async (id: string) => {
    try {
      await relayBridge.archiveProject(id);
      notify('Project archived');
      await loadData();
    } catch (err: any) {
      notify(`Archive error: ${err.message}`);
    }
  };

  const handleUnarchiveProject = async (id: string) => {
    try {
      await relayBridge.unarchiveProject(id);
      notify('Project restored to active');
      await loadData();
    } catch (err: any) {
      notify(`Unarchive error: ${err.message}`);
    }
  };

  // Pair Management Actions
  const handleArchivePair = async (id: string) => {
    try {
      await relayBridge.archivePair(id);
      notify('Pair archived');
      await loadData();
    } catch (err: any) {
      notify(`Archive error: ${err.message}`);
    }
  };

  const handleUnarchivePair = async (id: string) => {
    try {
      await relayBridge.unarchivePair(id);
      notify('Pair restored to active');
      await loadData();
    } catch (err: any) {
      notify(`Unarchive error: ${err.message}`);
    }
  };

  const handleArchiveSession = (id: string) => {
    const session = sessions.find((s) => s.id === id);
    setRuntimeModal({ isOpen: true, mode: 'archive', session: session || null });
  };

  const handleUnarchiveSession = async (id: string) => {
    try {
      await relayBridge.unarchiveRuntimeSession(id);
      notify('Runtime session restored & re-check triggered');
      await loadData();
    } catch (err: any) {
      notify(`Restore error: ${err.message}`);
    }
  };

  const handleAttachSessionToPair = (sessionId: string) => {
    // Determine the most appropriate role based on provider
    const session = sessions.find((s) => s.id === sessionId);
    const isPlanner = session?.providerType === 'chatgpt';
    
    setPairModal({
      isOpen: true,
      mode: 'create',
      pair: null,
      initialProjectId: projects[0]?.id,
    });
    // Note: We need to update PairModal to handle the pre-selection if we want perfect "Attach"
  };

  const handleViewSessionHistory = (sessionId: string, sessionName: string) => {
    setHistoryModal({ isOpen: true, sessionId, sessionName });
  };

  const handleOpenProjectDetail = (project: UIProject) => {
    setProjectDetail({ isOpen: true, projectId: project.id });
  };

  const handleOpenSessionDetail = (sessionId: string) => {
    setSessionDetail({ isOpen: true, sessionId });
  };

  const handleOpenSessionDetailFromProject = (sessionId: string) => {
    setProjectDetail({ isOpen: false, projectId: null });
    setSessionDetail({ isOpen: true, sessionId });
  };

  const handleEditProjectFromDetail = (project: UIProject) => {
    setProjectDetail({ isOpen: false, projectId: null });
    setProjectModal({ isOpen: true, mode: 'edit', project });
  };

  const handleArchiveSessionFromDetail = (sessionId: string) => {
    setSessionDetail({ isOpen: false, sessionId: null });
    handleArchiveSession(sessionId);
  };

  // Close detail surfaces if the underlying record disappears (e.g. deleted).
  useEffect(() => {
    if (
      projectDetail.isOpen &&
      projectDetail.projectId &&
      !projects.some((p) => p.id === projectDetail.projectId)
    ) {
      setProjectDetail({ isOpen: false, projectId: null });
    }
  }, [projects, projectDetail.isOpen, projectDetail.projectId]);

  useEffect(() => {
    if (
      sessionDetail.isOpen &&
      sessionDetail.sessionId &&
      !sessions.some((s) => s.id === sessionDetail.sessionId)
    ) {
      setSessionDetail({ isOpen: false, sessionId: null });
    }
  }, [sessions, sessionDetail.isOpen, sessionDetail.sessionId]);

  const handleDetachRuntime = async (pairId: string, role: 'planner' | 'worker') => {
    try {
      await relayBridge.detachPairRuntime(pairId, role);
      notify(`Detached ${role} runtime from pair`);
      await loadData();
    } catch (err: any) {
      notify(`Detach error: ${err.message}`);
    }
  };

  const handleDetachSessionFromPairs = async (sessionId: string) => {
    try {
      await relayBridge.detachRuntime(sessionId);
      notify('Runtime session detached from associated pairs');
      await loadData();
    } catch (err: any) {
      notify(`Detach error: ${err.message}`);
    }
  };

  // Actions
  const handleTriggerSupervision = async () => {
    setIsSupervising(true);
    try {
      const result = await relayBridge.runSupervisionTick();
      notify(
        `Supervision tick executed: ${result.inspectedRuntimes} runtimes inspected, ${result.handoffsCreated} handoffs created.`,
      );
      await loadData();
    } catch (err: any) {
      notify(`Supervision tick failed: ${err.message}`);
    } finally {
      setIsSupervising(false);
    }
  };

  const handleCreateAssignment = async (pairId: string, title: string, instruction: string) => {
    try {
      const asgn = await relayBridge.createAssignment(pairId, title, instruction);
      await relayBridge.dispatchAssignment(asgn.id);
      notify(`Assignment created & dispatched: "${title}"`);
      await loadData();
    } catch (err: any) {
      notify(`Dispatch error: ${err.message}`);
    }
  };

  const handleDispatchPair = async (pairId: string) => {
    const pair = pairs.find((p) => p.id === pairId);
    if (!pair) return;
    try {
      const asgn = await relayBridge.createAssignment(
        pair.id,
        'Next Planner Iteration',
        'Execute planned subtask and verify observable test results',
      );
      await relayBridge.dispatchAssignment(asgn.id);
      notify('New assignment dispatched to worker runtime');
      await loadData();
    } catch (err: any) {
      notify(`Dispatch error: ${err.message}`);
    }
  };

  const handleStartPair = async (pairId: string) => {
    try {
      await relayBridge.startPair(pairId);
      notify('Pair resumed to active state');
      await loadData();
    } catch (err: any) {
      notify(`Pair action error: ${err.message}`);
    }
  };

  const handlePausePair = async (pairId: string) => {
    try {
      await relayBridge.pausePair(pairId);
      notify('Pair execution paused');
      await loadData();
    } catch (err: any) {
      notify(`Pair action error: ${err.message}`);
    }
  };

  const handleDeliverHandoff = async (pairId: string) => {
    const pair = pairs.find((p) => p.id === pairId);
    if (!pair?.activeAssignmentId) return;
    try {
      const asgns = await relayBridge.listAssignments();
      const asgn = asgns.find((a) => a.id === pair.activeAssignmentId);
      if (asgn && pair.activeAssignmentId) {
        // Find deliveries/handoffs or trigger supervision to deliver
        await relayBridge.runSupervisionTick();
        notify('Handoff delivered to planner session for review');
        await loadData();
      }
    } catch (err: any) {
      notify(`Handoff error: ${err.message}`);
    }
  };

  const handleCompleteAssignment = async (pairId: string) => {
    const pair = pairs.find((p) => p.id === pairId);
    if (!pair?.activeAssignmentId) return;
    try {
      await relayBridge.completeAssignment(pair.activeAssignmentId);
      notify('Planner approved results and explicitly completed assignment');
      await loadData();
    } catch (err: any) {
      notify(`Error completing assignment: ${err.message}`);
    }
  };

  const handleInspect = async (sessionId?: string) => {
    try {
      if (sessionId) {
        await relayBridge.inspectRuntime(sessionId);
        notify('Probed active runtime window and recorded observable state');
      } else {
        await relayBridge.runSupervisionTick();
        notify('Supervised all active runtimes');
      }
      await loadData();
    } catch (err: any) {
      notify(`Inspection error: ${err.message}`);
    }
  };

  const handleResolveAmbiguous = async (deliveryId: string, outcome: 'delivered' | 'failed') => {
    if (!deliveryId) {
      notify('Cannot resolve: no delivery reference on this attention item');
      return;
    }
    try {
      await relayBridge.resolveAmbiguousDelivery(
        deliveryId,
        outcome === 'delivered' ? 'confirmed_delivered' : 'retry_permitted',
      );
      notify(`Delivery resolved as: ${outcome.toUpperCase()}`);
      await loadData();
    } catch (err: any) {
      notify(`Resolution error: ${err.message}`);
    }
  };

  const handleRecoverSuspended = async (runtimeId?: string) => {
    try {
      if (runtimeId) {
        await relayBridge.recoverRuntime(runtimeId);
        notify('Runtime reconciled & restored to available');
      } else {
        const suspended = sessions.find((s) => s.status === 'suspended');
        if (suspended) {
          await relayBridge.recoverRuntime(suspended.id);
          notify(`Runtime "${suspended.name}" reconciled & restored to available`);
        }
      }
      await loadData();
    } catch (err: any) {
      notify(`Recovery error: ${err.message}`);
    }
  };

  const handleAcknowledgeAttention = async (id: string) => {
    try {
      await relayBridge.acknowledgeAttentionItem(id);
      notify('Attention item dismissed');
      await loadData();
    } catch (err: any) {
      notify(`Error: ${err.message}`);
    }
  };

  const handleClearDb = async () => {
    try {
      await relayBridge.clearDatabase();
      notify('Local database state cleared');
      await loadData();
    } catch (err: any) {
      notify(`Clear error: ${err.message}`);
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans select-none">
      {/* Sidebar */}
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        openAttentionCount={metrics.openAttentionItems}
      />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-slate-950">
        {/* Status Toast */}
        {statusNotification && (
          <div className="fixed top-4 right-6 z-50 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-xs font-semibold shadow-xl border border-blue-400/40 animate-fade-in flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            <span>{statusNotification}</span>
          </div>
        )}

        {/* Scrollable View Area */}
        <div className="flex-1 overflow-y-auto p-6 lg:p-8">
          <div className="max-w-7xl mx-auto">
            {activeTab === 'dashboard' && (
              <DashboardView
                metrics={metrics}
                recentEvents={events}
                onTriggerSupervision={handleTriggerSupervision}
                onOpenNewAssignment={() => setIsNewAssignmentOpen(true)}
                onViewEvidence={(ev) => setSelectedEvidence(ev)}
                isSupervising={isSupervising}
              />
            )}

            {activeTab === 'pairs' && (
              <PairView
                pairs={pairs}
                projects={projects}
                onOpenCreateProject={() => setIsAddProjectWizardOpen(true)}
                onOpenEditProject={(project) =>
                  setProjectModal({ isOpen: true, mode: 'edit', project })
                }
                onOpenProjectDetail={handleOpenProjectDetail}
                onArchiveProject={handleArchiveProject}
                onUnarchiveProject={handleUnarchiveProject}
                onOpenCreatePair={(projectId) =>
                  setPairModal({ isOpen: true, mode: 'create', pair: null, initialProjectId: projectId })
                }
                onOpenEditPair={(pair) =>
                  setPairModal({ isOpen: true, mode: 'edit', pair })
                }
                onArchivePair={handleArchivePair}
                onUnarchivePair={handleUnarchivePair}
                onDetachRuntime={handleDetachRuntime}
                onDispatchAssignment={handleDispatchPair}
                onDeliverHandoff={handleDeliverHandoff}
                onCompleteAssignment={handleCompleteAssignment}
                onInspectPair={handleInspect}
                onStartPair={handleStartPair}
                onPausePair={handlePausePair}
                onViewEvidence={(ev) => setSelectedEvidence(ev)}
              />
            )}

            {activeTab === 'sessions' && (
              <SessionsView
                sessions={sessions}
                pairs={pairs}
                onInspectSession={handleInspect}
                onViewEvidence={(ev) => setSelectedEvidence(ev)}
                onOpenDiscover={() =>
                  setRuntimeModal({ isOpen: true, mode: 'discover', session: null })
                }
                onOpenRegister={() =>
                  setRuntimeModal({ isOpen: true, mode: 'register', session: null })
                }
                onArchiveSession={handleArchiveSession}
                onUnarchiveSession={handleUnarchiveSession}
                onDetachSession={handleDetachSessionFromPairs}
                onAttachToPair={handleAttachSessionToPair}
                onViewHistory={handleViewSessionHistory}
                onOpenSessionDetail={handleOpenSessionDetail}
              />
            )}

            {activeTab === 'assignments' && <AssignmentsView assignments={assignments} />}

            {activeTab === 'timeline' && (
              <EventsTimelineView
                events={events}
                onViewEvidence={(ev) => setSelectedEvidence(ev)}
              />
            )}

            {activeTab === 'attention' && (
              <AttentionRecoveryView
                attentionItems={attentionItems}
                onResolveAmbiguousDelivery={handleResolveAmbiguous}
                onRecoverSuspendedRuntime={handleRecoverSuspended}
                onAcknowledgeItem={handleAcknowledgeAttention}
              />
            )}

            {activeTab === 'settings' && (
              <SettingsView
                appStatus={appStatus}
                theme={theme}
                onThemeChange={setTheme}
                onClearDb={handleClearDb}
              />
            )}
          </div>
        </div>
      </main>

      {/* Modals */}
      <ProjectDetailModal
        isOpen={projectDetail.isOpen}
        projectId={projectDetail.projectId}
        projects={projects}
        pairs={pairs}
        sessions={sessions}
        assignments={assignments}
        events={events}
        attentionItems={attentionItems}
        onClose={() => setProjectDetail({ isOpen: false, projectId: null })}
        onEdit={handleEditProjectFromDetail}
        onViewEvidence={(ev) => setSelectedEvidence(ev)}
        onOpenSessionDetail={handleOpenSessionDetailFromProject}
      />

      <SessionDetailModal
        isOpen={sessionDetail.isOpen}
        sessionId={sessionDetail.sessionId}
        sessions={sessions}
        pairs={pairs}
        projects={projects}
        assignments={assignments}
        events={events}
        onClose={() => setSessionDetail({ isOpen: false, sessionId: null })}
        onProbe={(id) => handleInspect(id)}
        onViewEvidence={(ev) => setSelectedEvidence(ev)}
        onViewHistory={handleViewSessionHistory}
        onArchive={handleArchiveSessionFromDetail}
        onUnarchive={(id) => handleUnarchiveSession(id)}
      />

      <EvidenceModal
        evidence={selectedEvidence}
        onClose={() => setSelectedEvidence(null)}
      />

      <CreateAssignmentModal
        pairs={pairs}
        isOpen={isNewAssignmentOpen}
        onClose={() => setIsNewAssignmentOpen(false)}
        onCreate={handleCreateAssignment}
      />

      <AddProjectWizard
        isOpen={isAddProjectWizardOpen}
        onClose={() => setIsAddProjectWizardOpen(false)}
        onSuccess={(id, msg) => {
          notify(msg);
          loadData();
        }}
      />

      <ProjectModal
        isOpen={projectModal.isOpen}
        mode={projectModal.mode}
        project={projectModal.project}
        onClose={() => setProjectModal((prev) => ({ ...prev, isOpen: false }))}
        onSuccess={(msg) => {
          notify(msg);
          loadData();
        }}
      />

      <PairModal
        isOpen={pairModal.isOpen}
        mode={pairModal.mode}
        pair={pairModal.pair}
        projects={projects}
        runtimes={sessions}
        initialProjectId={pairModal.initialProjectId}
        onClose={() => setPairModal((prev) => ({ ...prev, isOpen: false }))}
        onSuccess={(msg) => {
          notify(msg);
          loadData();
        }}
        onRefresh={loadData}
      />

      <RuntimeModal
        isOpen={runtimeModal.isOpen}
        mode={runtimeModal.mode}
        session={runtimeModal.session}
        onClose={() => setRuntimeModal((prev) => ({ ...prev, isOpen: false }))}
        onSuccess={(msg) => {
          notify(msg);
          loadData();
        }}
      />

      <RuntimeHistoryModal
        isOpen={historyModal.isOpen}
        sessionId={historyModal.sessionId}
        sessionName={historyModal.sessionName}
        onClose={() => setHistoryModal((prev) => ({ ...prev, isOpen: false }))}
        onViewEvidence={(ev) => setSelectedEvidence(ev)}
      />
    </div>
  );
}
