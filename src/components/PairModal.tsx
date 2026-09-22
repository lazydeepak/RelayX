import React, { useState, useEffect } from 'react';
import { X, GitMerge, Edit3, Trash2, Archive, AlertTriangle, CheckCircle2, Cpu, Unlink, FolderPlus, Plus, MessageSquare } from 'lucide-react';
import { UIPair, UIProject, UIRuntimeSession } from '../types/ui.ts';
import { relayBridge } from '../services/relayBridge.ts';
import { AddProjectWizard } from './AddProjectWizard.tsx';
import {
  validateChatGPTConversationUrl,
  shortenExternalId,
  findPlannerIdConflict,
  findConversationConflict,
  canConfirmConversation,
  describeConversationReview,
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAddProjectWizardOpen, setIsAddProjectWizardOpen] = useState(false);

  const activeProjects = projects.filter((p) => p.status !== 'archived');
  const projectRuntimes = runtimes.filter((r) => {
    // Filter by project workspace/path or by pair relations if available
    const proj = activeProjects.find((p) => p.id === projectId);
    if (!proj) return false;
    return true;
  });
  const plannerOptions = projectRuntimes.filter((r) => r.providerType === 'chatgpt');
  const workerOptions = projectRuntimes.filter((r) => r.providerType === 'opencode' || r.providerType === 'vscode');

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
      } else if (mode === 'create') {
        setName('');
        setConversationUrl('');
        setConversationConfirmed(false);
        const defaultProj = initialProjectId || activeProjects[0]?.id || '';
        setProjectId(defaultProj);
        // default planner to first chatgpt/available runtime
        const defaultPlanner = runtimes.find((r) => r.providerType === 'chatgpt') || runtimes[0];
        const defaultWorker = runtimes.find((r) => r.providerType === 'opencode' || r.providerType === 'vscode') || runtimes[1];
        setPlannerSessionId(defaultPlanner?.id || '');
        setWorkerSessionId(defaultWorker?.id || '');
      }
    }
  }, [isOpen]);

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
      if (!plannerSessionId || !workerSessionId) {
        setErrorMessage('Both planner and worker sessions must be selected');
        return;
      }
      if (plannerSessionId === workerSessionId) {
        setErrorMessage('Planner and worker must be different sessions');
        return;
      }
      if (!conversationConfirmed) {
        setErrorMessage('Confirm the specific ChatGPT conversation URL before creating the pair');
        return;
      }
      if (activeProjects.length === 0) {
        setErrorMessage('Cannot create a pair without an active project. Please add a project first.');
        return;
      }
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      if (mode === 'create') {
        const args = buildCreatePairArgs(
          projectId,
          name,
          plannerSessionId || undefined,
          workerSessionId || undefined,
          conversationUrl,
        );
        await relayBridge.createPair(
          args.projectId,
          args.name,
          args.plannerSessionId,
          args.workerSessionId,
          args.plannerConversationUrl,
        );
        onSuccess(`Pair "${name}" created successfully`);
      } else if (mode === 'edit' && pair) {
        await relayBridge.updatePair(pair.id, {
          name: name.trim(),
          plannerSessionId: plannerSessionId ? plannerSessionId : null,
          workerSessionId: workerSessionId ? workerSessionId : null,
        });
        onSuccess(`Pair "${name}" updated successfully`);
      }
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
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
                    onClick={() => setPlannerSessionId('')}
                    className="text-[11px] text-slate-400 hover:text-amber-400 flex items-center gap-1"
                  >
                    <Unlink className="w-3 h-3" />
                    Detach
                  </button>
                )}
              </div>
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
            </div>

            {mode === 'create' && (
              <div className="space-y-3 pt-2 border-t border-slate-800">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300 font-medium flex items-center gap-1.5">
                    <MessageSquare className="w-3.5 h-3.5 text-sky-400" />
                    ChatGPT Conversation *
                  </span>
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
                  planner. Nothing is read from Chrome and no conversation is inferred from titles or
                  projects — the URL you enter is authoritative.
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

            <div className="space-y-3 pt-2 border-t border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-slate-300 font-medium flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                  Worker Runtime Binding
                </span>
                {workerSessionId && (
                  <button
                    type="button"
                    onClick={() => setWorkerSessionId('')}
                    className="text-[11px] text-slate-400 hover:text-amber-400 flex items-center gap-1"
                  >
                    <Unlink className="w-3 h-3" />
                    Detach
                  </button>
                )}
              </div>
              <select
                value={workerSessionId}
                onChange={(e) => setWorkerSessionId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-emerald-500"
              >
                <option value="">(None / Unassigned)</option>
                {workerOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.providerType.toUpperCase()}) • {r.status}{r.externalSessionId ? ' • bound id: ' + shortenExternalId(r.externalSessionId, 8) : ''}
                  </option>
                ))}
              </select>
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
                disabled={isSubmitting || !name.trim() || (mode === 'create' && (!projectId || activeProjects.length === 0 || !conversationConfirmed))}
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
