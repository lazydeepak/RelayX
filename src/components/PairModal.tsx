import React, { useState, useEffect } from 'react';
import { X, GitMerge, Edit3, Trash2, Archive, AlertTriangle, CheckCircle2, Cpu, Unlink, FolderPlus, Plus } from 'lucide-react';
import { UIPair, UIProject, UIRuntimeSession } from '../types/ui.ts';
import { relayBridge } from '../services/relayBridge.ts';
import { AddProjectWizard } from './AddProjectWizard.tsx';

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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAddProjectWizardOpen, setIsAddProjectWizardOpen] = useState(false);

  const activeProjects = projects.filter((p) => p.status !== 'archived');

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
      if (activeProjects.length === 0) {
        setErrorMessage('Cannot create a pair without an active project. Please add a project first.');
        return;
      }
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      if (mode === 'create') {
        await relayBridge.createPair(
          projectId,
          name.trim(),
          plannerSessionId || undefined,
          workerSessionId || undefined,
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
                {runtimes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.providerType.toUpperCase()}) • {r.status}
                  </option>
                ))}
              </select>
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
                {runtimes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.providerType.toUpperCase()}) • {r.status}
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
                disabled={isSubmitting || !name.trim() || (mode === 'create' && (!projectId || activeProjects.length === 0))}
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
