import React, { useState, useEffect } from 'react';
import { X, GitMerge, Edit3, Trash2, Archive, AlertTriangle, CheckCircle2, Cpu, Unlink, FolderPlus, Plus, MessageSquare } from 'lucide-react';
import { UIPair, UIProject, UIRuntimeSession } from '../types/ui.ts';
import type { ChatGPTConversationChoice, WorkerChoice } from '../types/relayApi.ts';
import { relayBridge } from '../services/relayBridge.ts';
import { AddProjectWizard } from './AddProjectWizard.tsx';
import {
  validateChatGPTConversationUrl,
  shortenExternalId,
  findPlannerIdConflict,
  findConversationConflict,
  canConfirmConversation,
  describeConversationReview,
  describeConversationChoice,
  describeDiscoveredWorkerChoice,
  buildCreatePairArgs,
} from './pairModalConversation.ts';

export type PairModalMode = 'create' | 'edit';

interface PairModalProps {
  isOpen: boolean;
  mode: PairModalMode;
  pair?: UIPair | null;
  projects: UIProject[];
  runtimes: UIRuntimeSession[];
  initialProjectId?: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onRefresh?: () => void;
}

export const PairModal: React.FC<PairModalProps> = ({
  isOpen,
  mode,
  pair,
  projects,
  runtimes,
  initialProjectId,
  onClose,
  onSuccess,
  onRefresh,
}) => {
  const [projectId, setProjectId] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [plannerSessionId, setPlannerSessionId] = useState<string>('');
  const [workerSessionId, setWorkerSessionId] = useState<string>('');
  const [conversationUrl, setConversationUrl] = useState<string>('');
  const [conversationConfirmed, setConversationConfirmed] = useState(false);
  const [conversationChoices, setConversationChoices] = useState<ChatGPTConversationChoice[]>([]);
  const [conversationRegistryError, setConversationRegistryError] = useState<string | null>(null);
  const [workerChoices, setWorkerChoices] = useState<WorkerChoice[]>([]);
  const [workerDiscovery, setWorkerDiscovery] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [adoptedRuntimes, setAdoptedRuntimes] = useState<UIRuntimeSession[]>([]);

  // Planner creation and mode state
  const [plannerSourceMode, setPlannerSourceMode] = useState<'new' | 'existing'>('new');
  const [newPlannerSessionName, setNewPlannerSessionName] = useState('');
  const [isCreatingPlanner, setIsCreatingPlanner] = useState(false);
  const [plannerCreationMessage, setPlannerCreationMessage] = useState<string | null>(null);
  const [createdPlannerInfo, setCreatedPlannerInfo] = useState<{ id: string; conversationId: string; url: string } | null>(null);

  // Worker creation and mode state
  const [workerSourceMode, setWorkerSourceMode] = useState<'new' | 'existing'>('new');
  const [newWorkerSessionName, setNewWorkerSessionName] = useState('');
  const [isCreatingWorker, setIsCreatingWorker] = useState(false);
  const [workerCreationMessage, setWorkerCreationMessage] = useState<string | null>(null);
  const [createdWorkerInfo, setCreatedWorkerInfo] = useState<{ id: string; sessionId: string } | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAddProjectWizardOpen, setIsAddProjectWizardOpen] = useState(false);

  const activeProjects = projects.filter((p) => p.status !== 'archived');
  const runtimePool = [
    ...runtimes,
    ...adoptedRuntimes.filter((a) => !runtimes.some((r) => r.id === a.id)),
  ];
  const projectRuntimes = runtimePool.filter((r) => {
    // Filter by project workspace/path or by pair relations if available
    const proj = activeProjects.find((p) => p.id === projectId);
    if (!proj) return false;
    return true;
  });
  const plannerOptions = projectRuntimes.filter((r) => r.providerType === 'chatgpt');
  const workerOptions = projectRuntimes.filter(
    (r) => r.providerType === 'opencode' || r.providerType === 'vscode',
  );
  const workerDiscoveredChoices = workerChoices.filter(
    (c): c is Extract<WorkerChoice, { kind: 'discovered' }> =>
      c.kind === 'discovered' && !runtimePool.some((r) => r.externalSessionId === c.sessionId),
  );
  // Derived selection for the "existing conversation" picker: a choice URL === the
  // pasted URL, otherwise the "new conversation" option.
  const conversationChoiceValue =
    conversationChoices.find((c) => c.url === conversationUrl.trim())?.url ?? '__new__';

  // Explicit ChatGPT conversation selection (create-mode only): the user pastes
  // the exact URL of the specific conversation to pair. Nothing is sampled from
  // Chrome or inferred from titles/projects — the entered URL is the source.
  const selectedPlanner = plannerOptions.find((r) => r.id === plannerSessionId);
  const conversationValidation = validateChatGPTConversationUrl(conversationUrl);
  const parsedConversationId = conversationValidation.ok ? conversationValidation.parsed.conversationId : null;
  const plannerConflictBoundId = findPlannerIdConflict(selectedPlanner, parsedConversationId);
  const conversationConflictRuntime = findConversationConflict(runtimes, plannerSessionId, parsedConversationId);
  const canConfirm = canConfirmConversation({
    plannerSelected: Boolean(selectedPlanner),
    conversationValid: conversationValidation.ok,
    plannerConflictBoundId,
    conversationConflictRuntimeId: conversationConflictRuntime?.id ?? null,
  });
  const conversationReview =
    selectedPlanner && conversationValidation.ok
      ? describeConversationReview(
          selectedPlanner.name,
          selectedPlanner.providerType,
          selectedPlanner.externalSessionId ?? null,
          conversationUrl,
        )
      : null;

  useEffect(() => {
    if (isOpen) {
      setErrorMessage(null);
      if (mode === 'edit' && pair) {
        setName(pair.name);
        setProjectId(pair.projectId);
        setPlannerSessionId(pair.plannerSessionId || '');
        setWorkerSessionId(pair.workerSessionId || '');
        setNewWorkerSessionName(`${pair.name} worker`);
        setWorkerCreationMessage(null);
      } else if (mode === 'create') {
        setName('');
        setConversationUrl('');
        setConversationConfirmed(false);
        setConversationChoices([]);
        setConversationRegistryError(null);
        setWorkerChoices([]);
        setWorkerDiscovery(null);
        setAdoptedRuntimes([]);
        const defaultProj = initialProjectId || activeProjects[0]?.id || '';
        setProjectId(defaultProj);
        const projectName = activeProjects.find((p) => p.id === defaultProj)?.name;
        setNewPlannerSessionName(`${projectName || 'ChatGPT'} Planner`);
        setNewWorkerSessionName(`${projectName || 'OpenCode'} worker`);
        setPlannerSourceMode('new');
        setWorkerSourceMode('new');
        setCreatedPlannerInfo(null);
        setCreatedWorkerInfo(null);
        setPlannerCreationMessage(null);
        setWorkerCreationMessage(null);
        // default planner to first chatgpt/available runtime if switching to existing
        const defaultPlanner = runtimes.find((r) => r.providerType === 'chatgpt') || runtimes[0];
        const defaultWorker = runtimes.find((r) => r.providerType === 'opencode' || r.providerType === 'vscode') || runtimes[1];
        setPlannerSessionId(defaultPlanner?.id || '');
        setWorkerSessionId(defaultWorker?.id || '');
      }
    }
  }, [isOpen]);

  // A new create-mode project resets the conversation selection and updates session names:
  useEffect(() => {
    setConversationUrl('');
    setConversationConfirmed(false);
    setCreatedPlannerInfo(null);
    setCreatedWorkerInfo(null);
    setPlannerCreationMessage(null);
    setWorkerCreationMessage(null);
    const projectName = activeProjects.find((p) => p.id === projectId)?.name;
    if (projectName) {
      setNewPlannerSessionName(`${projectName} Planner`);
      setNewWorkerSessionName(`${projectName} worker`);
    }
  }, [projectId]);

  // Load project-owned choices: the observed ChatGPT conversation registry and the
  // OpenCode worker-session enumeration (registered + adoptable discovered ids).
  useEffect(() => {
    if (!(isOpen && projectId)) return;
    let cancelled = false;
    (async () => {
      if (mode === 'create') {
        try {
          const convRes = await relayBridge.enumerateChatGPTConversations(projectId);
          if (cancelled) return;
          setConversationChoices(convRes.ok ? convRes.conversations : []);
          setConversationRegistryError(convRes.ok ? null : (convRes.error ?? 'Conversation registry unavailable'));
        } catch (err: any) {
          if (!cancelled) setConversationRegistryError(err?.message ?? 'Conversation registry unavailable');
        }
      }
      try {
        const workRes = await relayBridge.enumerateWorkerChoices(projectId);
        if (cancelled) return;
        setWorkerChoices(workRes.ok ? workRes.choices : []);
        setWorkerDiscovery(workRes.ok ? (workRes.discovery ?? { ok: true }) : { ok: false, reason: workRes.error });
      } catch {
        if (!cancelled) {
          setWorkerChoices([]);
          setWorkerDiscovery({ ok: false, reason: 'Worker session enumeration failed' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, mode, projectId]);

  if (!isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMessage('Pair name is required');
      return;
    }
    if (mode === 'create') {
      if (!projectId) {
        setErrorMessage('A project must be selected for every real pair');
        return;
      }
      if (activeProjects.length === 0) {
        setErrorMessage('Cannot create a pair without an active project. Please add a project first.');
        return;
      }
      if (plannerSourceMode === 'existing') {
        if (!plannerSessionId) {
          setErrorMessage('Select an existing planner session');
          return;
        }
        if (!conversationConfirmed) {
          setErrorMessage('Confirm the specific ChatGPT conversation URL before creating the pair');
          return;
        }
      }
      if (workerSourceMode === 'existing' && !workerSessionId) {
        setErrorMessage('Select an existing worker session');
        return;
      }
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      if (mode === 'create') {
        let finalPlannerId = plannerSessionId;
        let finalWorkerId = workerSessionId;
        let finalConvUrl = conversationUrl;

        // 1. If Planner mode is 'new' and not yet created:
        if (plannerSourceMode === 'new' && !createdPlannerInfo) {
          const sessionName = newPlannerSessionName.trim() || `${name} Planner`;
          const plannerRes = await relayBridge.createChatGPTPlannerSession(projectId, sessionName);
          if (!plannerRes.adopted || !plannerRes.runtime || !plannerRes.conversationId) {
            throw new Error(plannerRes.error || 'Failed to create authoritative ChatGPT planner session');
          }
          finalPlannerId = plannerRes.runtime.id;
          finalConvUrl = plannerRes.conversationUrl;
          setAdoptedRuntimes((prev) =>
            prev.some((r) => r.id === plannerRes.runtime!.id) ? prev : [...prev, plannerRes.runtime!],
          );
          setPlannerSessionId(plannerRes.runtime.id);
          setCreatedPlannerInfo({
            id: plannerRes.runtime.id,
            conversationId: plannerRes.conversationId,
            url: plannerRes.conversationUrl,
          });
        } else if (plannerSourceMode === 'new' && createdPlannerInfo) {
          finalPlannerId = createdPlannerInfo.id;
          finalConvUrl = createdPlannerInfo.url;
        }

        // 2. If Worker mode is 'new' and not yet created:
        if (workerSourceMode === 'new' && !createdWorkerInfo) {
          const sessionName = newWorkerSessionName.trim() || `${name} worker`;
          const workerRes = await relayBridge.createOpenCodeWorkerSession(projectId, sessionName);
          if (!workerRes.adopted || !workerRes.runtime || !workerRes.sessionId) {
            const retainedNote = finalPlannerId
              ? ` The created planner session (${finalPlannerId}) was preserved as an adoptable session.`
              : '';
            throw new Error(
              `Failed to create OpenCode worker session: ${workerRes.error || 'unknown error'}.${retainedNote}`,
            );
          }
          finalWorkerId = workerRes.runtime.id;
          setAdoptedRuntimes((prev) =>
            prev.some((r) => r.id === workerRes.runtime!.id) ? prev : [...prev, workerRes.runtime!],
          );
          setWorkerSessionId(workerRes.runtime.id);
          setCreatedWorkerInfo({
            id: workerRes.runtime.id,
            sessionId: workerRes.sessionId,
          });
        } else if (workerSourceMode === 'new' && createdWorkerInfo) {
          finalWorkerId = createdWorkerInfo.id;
        }

        if (!finalPlannerId || !finalWorkerId) {
          throw new Error('Both planner and worker sessions must be selected or created');
        }
        if (finalPlannerId === finalWorkerId) {
          throw new Error('Planner and worker must be different sessions');
        }

        // 3. Create the Pair and bind exact sessions
        await relayBridge.createPair(
          projectId,
          name.trim(),
          finalPlannerId,
          finalWorkerId,
          finalConvUrl || undefined,
        );

        const isBothNew = plannerSourceMode === 'new' && workerSourceMode === 'new';
        if (isBothNew) {
          onSuccess(`New/New provisioning complete: Pair "${name.trim()}" created with fresh Planner and Worker sessions`);
        } else {
          onSuccess(`Pair "${name.trim()}" created successfully`);
        }
      } else if (mode === 'edit' && pair) {
        await relayBridge.updatePair(pair.id, {
          name: name.trim(),
          plannerSessionId: plannerSessionId ? plannerSessionId : null,
          workerSessionId: workerSessionId ? workerSessionId : null,
        });
        onSuccess(`Pair "${name.trim()}" updated successfully`);
      }
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
    }
  };

  const createPlannerSession = async () => {
    const sessionName = newPlannerSessionName.trim();
    if (!projectId) {
      setErrorMessage('Select a project before creating a planner session');
      return;
    }
    if (!sessionName) {
      setErrorMessage('Enter a name for the new planner session');
      return;
    }

    setIsCreatingPlanner(true);
    setErrorMessage(null);
    setPlannerCreationMessage(null);
    try {
      const result = await relayBridge.createChatGPTPlannerSession(projectId, sessionName);
      if (!result.adopted || !result.runtime) {
        throw new Error(result.error || 'The new ChatGPT planner session could not be created or verified.');
      }
      setAdoptedRuntimes((prev) =>
        prev.some((runtime) => runtime.id === result.runtime!.id)
          ? prev
          : [...prev, result.runtime!],
      );
      setPlannerSessionId(result.runtime.id);
      setConversationUrl(result.conversationUrl);
      setConversationConfirmed(true);
      setCreatedPlannerInfo({
        id: result.runtime.id,
        conversationId: result.conversationId,
        url: result.conversationUrl,
      });
      setPlannerCreationMessage(
        `Created and verified conversation “${shortenExternalId(result.conversationId, 12)}”. Save the pair to bind.`,
      );
      if (onRefresh) onRefresh();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to create the ChatGPT planner session');
    } finally {
      setIsCreatingPlanner(false);
    }
  };

  const adoptWorkerSession = async (sessionId: string) => {
    try {
      setErrorMessage(null);
      const runtime = await relayBridge.adoptOpenCodeSession(projectId, sessionId, undefined);
      setAdoptedRuntimes((prev) =>
        prev.some((r) => r.id === runtime.id) ? prev : [...prev, runtime],
      );
      setWorkerSessionId(runtime.id);
      if (onRefresh) onRefresh();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to adopt the discovered session');
    }
  };

  const handleWorkerChange = (value: string) => {
    if (value.startsWith('adopt:')) {
      adoptWorkerSession(value.slice('adopt:'.length));
      return;
    }
    setWorkerSessionId(value);
  };

  const createWorkerSession = async () => {
    const sessionName = newWorkerSessionName.trim();
    if (!projectId) {
      setErrorMessage('Select a project before creating a worker session');
      return;
    }
    if (!sessionName) {
      setErrorMessage('Enter a name for the new worker session');
      return;
    }

    setIsCreatingWorker(true);
    setErrorMessage(null);
    setWorkerCreationMessage(null);
    try {
      const result = await relayBridge.createOpenCodeWorkerSession(projectId, sessionName);
      if (!result.adopted || !result.runtime) {
        const retainedId = result.sessionId ? ` Session ${result.sessionId} was retained for recovery.` : '';
        throw new Error(`${result.error || 'The new OpenCode session could not be adopted.'}${retainedId}`);
      }
      setAdoptedRuntimes((prev) =>
        prev.some((runtime) => runtime.id === result.runtime!.id)
          ? prev
          : [...prev, result.runtime!],
      );
      setWorkerSessionId(result.runtime.id);
      setCreatedWorkerInfo({
        id: result.runtime.id,
        sessionId: result.sessionId,
      });
      setWorkerCreationMessage(`Created and selected “${sessionName}” (${shortenExternalId(result.sessionId, 12)}). Save the pair to apply this binding.`);
      if (onRefresh) onRefresh();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to create the OpenCode worker session');
    } finally {
      setIsCreatingWorker(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            {mode === 'create' && <GitMerge className="w-5 h-5 text-blue-400" />}
            {mode === 'edit' && <Edit3 className="w-5 h-5 text-blue-400" />}
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                {mode === 'create' && 'Create Planner-Worker Pair'}
                {mode === 'edit' && 'Edit Pair & Bindings'}
              </h3>
              <p className="text-xs text-slate-400">
                {mode === 'create' && 'Bind planner and worker runtimes under a project'}
                {mode === 'edit' && `Manage runtimes and metadata for "${pair?.name}"`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSave} className="p-5 space-y-4 text-xs">
            {errorMessage && (
              <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-xs">
                {errorMessage}
              </div>
            )}

            {mode === 'create' && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-slate-300 font-medium">Project *</label>
                  <button
                    type="button"
                    onClick={() => setIsAddProjectWizardOpen(true)}
                    className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium"
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                    <span>+ Add New Project</span>
                  </button>
                </div>

                  <select
                    value={projectId}
                    onChange={(e) => {
                      if (e.target.value === '__add_new__') {
                        setIsAddProjectWizardOpen(true);
                      } else {
                        setProjectId(e.target.value);
                      }
                    }}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
                    required
                  >
                    {activeProjects.length === 0 ? (
                      <option value="" disabled>Select a project…</option>
                    ) : (
                      activeProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))
                    )}
                    <option value="__add_new__" className="text-blue-400 font-semibold">
                      + Add New Project…
                    </option>
                  </select>
              </div>
            )}

            <div>
              <label className="block text-slate-300 font-medium mb-1.5">Pair Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Frontend Refactor Pair"
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
                required
              />
            </div>

            <div className="space-y-3 pt-2 border-t border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-slate-300 font-medium flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-purple-400" />
                  Planner Runtime Binding
                </span>
                {plannerSessionId && (
                  <button
                    type="button"
                    onClick={() => {
                      setPlannerSessionId('');
                      setCreatedPlannerInfo(null);
                      setPlannerCreationMessage(null);
                    }}
                    className="text-[11px] text-slate-400 hover:text-amber-400 flex items-center gap-1"
                  >
                    <Unlink className="w-3 h-3" />
                    Detach
                  </button>
                )}
              </div>

              {mode === 'create' && (
                <div className="flex items-center gap-1.5 p-1 rounded-lg bg-slate-950 border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setPlannerSourceMode('new')}
                    className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                      plannerSourceMode === 'new'
                        ? 'bg-purple-600/90 text-white shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    + New Planner Session
                  </button>
                  <button
                    type="button"
                    onClick={() => setPlannerSourceMode('existing')}
                    className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                      plannerSourceMode === 'existing'
                        ? 'bg-purple-600/90 text-white shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Use Existing Planner Session
                  </button>
                </div>
              )}

              {mode === 'create' && plannerSourceMode === 'new' ? (
                <div className="space-y-2.5 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
                  <div className="text-[11px] text-slate-400">
                    Creates an authoritative new ChatGPT planner conversation scoped to{' '}
                    <span className="text-purple-300 font-medium">{activeProjects.find((p) => p.id === projectId)?.name || 'the project'}</span>.
                  </div>

                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <input
                      type="text"
                      value={newPlannerSessionName}
                      onChange={(e) => setNewPlannerSessionName(e.target.value)}
                      placeholder="New planner session name"
                      className="min-w-0 px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-purple-500"
                    />
                    <button
                      type="button"
                      onClick={createPlannerSession}
                      disabled={isCreatingPlanner || !projectId || !newPlannerSessionName.trim()}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white font-medium transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>{isCreatingPlanner ? 'Creating…' : 'Create Session'}</span>
                    </button>
                  </div>

                  {createdPlannerInfo ? (
                    <div className="p-2.5 rounded-lg bg-purple-950/40 border border-purple-500/40 space-y-1">
                      <div className="flex items-center gap-1.5 text-purple-300 font-medium text-[11px]">
                        <CheckCircle2 className="w-3.5 h-3.5 text-purple-400" />
                        <span>Authoritative planner conversation verified</span>
                      </div>
                      <div className="text-[11px] text-slate-300 truncate">
                        ID: <span className="font-mono text-purple-200">{createdPlannerInfo.conversationId}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 truncate">
                        URL: {createdPlannerInfo.url}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500">
                      Creates and discovers a fresh conversation under this project. No manual URL pasting required.
                    </p>
                  )}

                  {plannerCreationMessage && (
                    <p className="text-[11px] text-purple-300">{plannerCreationMessage}</p>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <select
                    value={plannerSessionId}
                    onChange={(e) => setPlannerSessionId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-purple-500"
                  >
                    <option value="">(None / Unassigned)</option>
                    {plannerOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.providerType.toUpperCase()}) • {r.status}{r.externalSessionId ? ' • bound id: ' + shortenExternalId(r.externalSessionId, 8) : ''}
                      </option>
                    ))}
                  </select>

                  {mode === 'create' && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-300 font-medium flex items-center gap-1.5">
                          <MessageSquare className="w-3.5 h-3.5 text-sky-400" />
                          ChatGPT Conversation *
                        </span>
                      </div>
                      <div>
                        <select
                          value={conversationChoiceValue}
                          onChange={(e) => {
                            const v = e.target.value;
                            setConversationConfirmed(false);
                            if (v === '__new__') {
                              setConversationUrl('');
                            } else {
                              setConversationUrl(v);
                            }
                          }}
                          className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-sky-500"
                        >
                          <option value="__new__">Paste existing conversation URL below…</option>
                          {conversationChoices.map((c) => (
                            <option key={c.conversationId} value={c.url}>
                              {describeConversationChoice(c)}
                            </option>
                          ))}
                        </select>
                        {conversationRegistryError ? (
                          <p className="mt-1 text-[11px] text-amber-300/90">
                            Conversation registry unavailable: {conversationRegistryError}. Paste a URL
                            below instead.
                          </p>
                        ) : conversationChoices.length === 0 ? (
                          <p className="mt-1 text-[11px] text-slate-400">
                            No existing conversations observed for this project yet — paste a conversation URL below.
                          </p>
                        ) : (
                          <p className="mt-1 text-[11px] text-slate-400">
                            Or paste a different conversation URL below.
                          </p>
                        )}
                      </div>
                      <input
                        type="text"
                        value={conversationUrl}
                        onChange={(e) => {
                          setConversationUrl(e.target.value);
                          setConversationConfirmed(false);
                        }}
                        placeholder="https://chatgpt.com/g/g-p-…/c/…"
                        className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-sky-500"
                      />
                      <p className="text-[11px] text-slate-400">
                        Paste the exact URL of the specific existing ChatGPT conversation to pair with the
                        planner. The URL you enter is authoritative.
                      </p>

                      {selectedPlanner && conversationUrl.trim() && !conversationValidation.ok && (
                        <div className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-300 text-[11px]">
                          {conversationValidation.reason}
                        </div>
                      )}

                      {selectedPlanner && parsedConversationId && plannerConflictBoundId && (
                        <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-[11px]">
                          This planner runtime is already bound to conversation “
                          {shortenExternalId(plannerConflictBoundId)}”. Select a different planner or
                          conversation before submitting.
                        </div>
                      )}

                      {parsedConversationId && conversationConflictRuntime && (
                        <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-[11px]">
                          Conversation “{conversationConflictRuntime.externalSessionId}” is already bound to
                          runtime “{conversationConflictRuntime.name}”. Choose a different conversation or
                          free that runtime before submitting.
                        </div>
                      )}

                      {conversationReview && (
                        <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-600 space-y-1.5">
                          <p className="text-[11px] text-slate-300">
                            Selected planner:{' '}
                            <span className="text-slate-100 font-semibold">{conversationReview.plannerLabel}</span>
                          </p>
                          <p className="text-[11px] text-slate-300 break-all">
                            Conversation URL:{' '}
                            <span className="text-slate-100">{conversationReview.url}</span>
                          </p>
                          <label className={`flex items-start gap-2 mt-1 ${canConfirm ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                            <input
                              type="checkbox"
                              checked={conversationConfirmed}
                              disabled={!canConfirm}
                              onChange={(e) => setConversationConfirmed(e.target.checked)}
                              className="mt-0.5"
                            />
                            <span className="text-slate-200 text-[11px]">
                              I confirm this is the specific ChatGPT conversation to pair with “
                              {selectedPlanner?.name}”.
                            </span>
                          </label>
                          {!canConfirm && (
                            <p className="text-[11px] text-amber-300/80">
                              Resolve the highlighted issues above to enable confirmation.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-3 pt-2 border-t border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-slate-300 font-medium flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                  Worker Runtime Binding
                </span>
                {workerSessionId && (
                  <button
                    type="button"
                    onClick={() => {
                      setWorkerSessionId('');
                      setCreatedWorkerInfo(null);
                      setWorkerCreationMessage(null);
                    }}
                    className="text-[11px] text-slate-400 hover:text-amber-400 flex items-center gap-1"
                  >
                    <Unlink className="w-3 h-3" />
                    Detach
                  </button>
                )}
              </div>

              {mode === 'create' && (
                <div className="flex items-center gap-1.5 p-1 rounded-lg bg-slate-950 border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setWorkerSourceMode('new')}
                    className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                      workerSourceMode === 'new'
                        ? 'bg-emerald-600/90 text-white shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    + New Worker Session
                  </button>
                  <button
                    type="button"
                    onClick={() => setWorkerSourceMode('existing')}
                    className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                      workerSourceMode === 'existing'
                        ? 'bg-emerald-600/90 text-white shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Use Existing Worker Session
                  </button>
                </div>
              )}

              {mode === 'create' && workerSourceMode === 'new' ? (
                <div className="space-y-2.5 p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <input
                      type="text"
                      value={newWorkerSessionName}
                      onChange={(e) => setNewWorkerSessionName(e.target.value)}
                      placeholder="New worker session name"
                      className="min-w-0 px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-emerald-500"
                    />
                    <button
                      type="button"
                      onClick={createWorkerSession}
                      disabled={isCreatingWorker || !projectId || !newWorkerSessionName.trim()}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-medium transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>{isCreatingWorker ? 'Creating…' : 'Create Session'}</span>
                    </button>
                  </div>

                  {createdWorkerInfo ? (
                    <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/40 space-y-1">
                      <div className="flex items-center gap-1.5 text-emerald-300 font-medium text-[11px]">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Authoritative OpenCode session created</span>
                      </div>
                      <div className="text-[11px] text-slate-300 truncate">
                        Session: <span className="font-mono text-emerald-200">{createdWorkerInfo.sessionId}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500">
                      Creates an empty OpenCode session in this project workspace and selects it as the worker.
                    </p>
                  )}

                  {workerCreationMessage && (
                    <p className="text-[11px] text-emerald-300">{workerCreationMessage}</p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <select
                    value={workerSessionId}
                    onChange={(e) => handleWorkerChange(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">(None / Unassigned)</option>
                    {workerOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.providerType.toUpperCase()}) • {r.status}{r.externalSessionId ? ' • bound id: ' + shortenExternalId(r.externalSessionId, 8) : ''}
                      </option>
                    ))}
                    {workerDiscoveredChoices.length > 0 && (
                      <optgroup label="Discovered OpenCode sessions (authoritative, adoptable)">
                        {workerDiscoveredChoices.map((c) => (
                          <option key={c.sessionId} value={`adopt:${c.sessionId}`}>
                            {describeDiscoveredWorkerChoice(c)}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  {workerDiscovery && !workerDiscovery.ok && (
                    <p className="text-[11px] text-amber-300/90">
                      Session discovery unavailable ({workerDiscovery.reason ?? 'unknown reason'}) —
                      showing registered sessions only.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  isSubmitting ||
                  isCreatingPlanner ||
                  isCreatingWorker ||
                  !name.trim() ||
                  (mode === 'create' && (!projectId || activeProjects.length === 0)) ||
                  (mode === 'create' && plannerSourceMode === 'existing' && (!plannerSessionId || !conversationConfirmed)) ||
                  (mode === 'create' && workerSourceMode === 'existing' && !workerSessionId)
                }
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium shadow-md transition-colors"
              >
                {mode === 'create' ? (
                  <>
                    <GitMerge className="w-3.5 h-3.5" />
                    <span>Create Pair</span>
                  </>
                ) : (
                  <>
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>Save Changes</span>
                  </>
                )}
              </button>
            </div>
          </form>
      </div>

      <AddProjectWizard
        isOpen={isAddProjectWizardOpen}
        onClose={() => setIsAddProjectWizardOpen(false)}
        onSuccess={(newProjectId, message) => {
          if (onRefresh) onRefresh();
          onSuccess(message);
          setProjectId(newProjectId);
          setIsAddProjectWizardOpen(false);
        }}
      />
    </div>
  );
};
