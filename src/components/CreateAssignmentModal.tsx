import React, { useState, useEffect } from 'react';
import { X, Send, ListTodo, FolderPlus, GitMerge, AlertTriangle, ShieldAlert } from 'lucide-react';
import { UIPair, AssignmentPriority } from '../types/ui.ts';
import { resolveCreateAssignmentEligibility } from './pairDispatchEligibility.ts';
import { shouldCloseCreateAssignmentModal } from './createAssignmentOutcome.ts';

interface CreateAssignmentModalProps {
  pairs: UIPair[];
  isOpen: boolean;
  onClose: () => void;
  /**
   * Returns the durable creation outcome. The modal closes ONLY when
   * `created === true`; a pre-claim refusal keeps it open with the draft intact.
   */
  onCreate: (pairId: string, title: string, instruction: string, priority: AssignmentPriority) => Promise<{ created: boolean }>;
  /** Open the existing project creation flow (AddProjectWizard). */
  onCreateProject: () => void;
  /** Open the existing pair creation flow (PairModal). Receives the project context of the current selection, when available. */
  onCreatePair: (projectId?: string) => void;
  /** Pair id to auto-select once it appears in `pairs` (e.g. after creation elsewhere). */
  pendingSelectedPairId?: string | null;
  /** Clear the pending selection after it has been applied. */
  onPendingSelectedPairIdConsumed?: () => void;
  /** Route the operator to the existing Attention & Recovery surface. */
  onOpenAttentionRecovery?: () => void;
}

export const CreateAssignmentModal: React.FC<CreateAssignmentModalProps> = ({
  pairs,
  isOpen,
  onClose,
  onCreate,
  onCreateProject,
  onCreatePair,
  pendingSelectedPairId,
  onPendingSelectedPairIdConsumed,
  onOpenAttentionRecovery,
}) => {
  const [selectedPairId, setSelectedPairId] = useState<string>(pairs[0]?.id || '');
  const [title, setTitle] = useState<string>('');
  const [instruction, setInstruction] = useState<string>('');
  const [priority, setPriority] = useState<AssignmentPriority>('normal');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Apply a pending pair selection (e.g. a pair just created via the Create Pair
  // shortcut) once the refreshed pair list contains it.
  useEffect(() => {
    if (!pendingSelectedPairId) return;
    if (pairs.some((p) => p.id === pendingSelectedPairId)) {
      setSelectedPairId(pendingSelectedPairId);
      onPendingSelectedPairIdConsumed?.();
    }
  }, [pendingSelectedPairId, pairs, onPendingSelectedPairIdConsumed]);

  if (!isOpen) return null;

  // Authoritative projection: a Pair owns at most one unresolved active Assignment.
  const selectedPair = pairs.find((p) => p.id === selectedPairId) ?? pairs[0];
  const createEligibility = resolveCreateAssignmentEligibility(selectedPair);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Prevent a second submit while the request is in flight.
    if (isSubmitting) return;
    // The application command re-checks this before anything is durable; this is
    // convenience, never authority.
    if (!createEligibility.eligible) return;
    if (!title.trim() || !instruction.trim()) return;

    setIsSubmitting(true);
    try {
      const result = await onCreate(selectedPairId || pairs[0]?.id, title, instruction, priority);
      if (shouldCloseCreateAssignmentModal(result)) {
        // A durable Assignment exists (even if its dispatch later failed or is
        // ambiguous). The draft is no longer a draft — close and let the user
        // work from the Assignment/Pair.
        setTitle('');
        setInstruction('');
        setPriority('normal');
        onClose();
      }
      // created: false → keep the modal open with the draft preserved for retry.
    } catch {
      // Unexpected error before a structured result: creation is unproven, so
      // keep the modal open with the draft intact.
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <ListTodo className="w-5 h-5 text-blue-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Create New Assignment</h3>
              <p className="text-xs text-slate-400">Delegate work through Relay Engine</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          <div>
            <label className="block text-slate-300 font-medium mb-1">Pair Name (Project)</label>
            <select
              value={selectedPairId}
              onChange={(e) => setSelectedPairId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
            >
              {pairs.map((pair) => (
                <option key={pair.id} value={pair.id}>
                  {pair.name} ({pair.projectName})
                </option>
              ))}
            </select>
            <div className="mt-1.5 flex items-center gap-3">
              <button
                type="button"
                onClick={onCreateProject}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-400 hover:text-blue-300 transition-colors"
              >
                <FolderPlus className="w-3 h-3" />
                Create Project
              </button>
              <button
                type="button"
                onClick={() => onCreatePair(pairs.find((p) => p.id === selectedPairId)?.projectId)}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-400 hover:text-blue-300 transition-colors"
              >
                <GitMerge className="w-3 h-3" />
                Create Pair
              </button>
            </div>

            {!createEligibility.eligible && createEligibility.blockedByActiveAssignment && (
              <div className="mt-2 p-3 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-200 space-y-2">
                <p className="flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-300" />
                  <span>{createEligibility.reason}</span>
                </p>
                {createEligibility.activeAssignmentId && (
                  <p className="text-[11px] text-amber-300/80 pl-5">
                    Active assignment:{' '}
                    <span className="font-medium text-amber-100">
                      {createEligibility.activeAssignmentTitle || '(untitled)'}
                    </span>{' '}
                    <span className="font-mono text-amber-300/70">
                      {createEligibility.activeAssignmentId.slice(0, 12)}
                    </span>
                  </p>
                )}
                {onOpenAttentionRecovery && (
                  <button
                    type="button"
                    onClick={onOpenAttentionRecovery}
                    className="ml-5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-semibold transition-colors"
                  >
                    <ShieldAlert className="w-3 h-3" />
                    Open Attention &amp; Recovery
                  </button>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">Assignment Title</label>
            <input
              type="text"
              required
              placeholder="e.g. Implement retry exponential backoff"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">Priority</label>
            <div className="grid grid-cols-4 gap-2">
              {(['low', 'normal', 'high', 'urgent'] as AssignmentPriority[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`px-2 py-1.5 rounded-lg border text-[10px] font-bold uppercase tracking-wider transition-all ${
                    priority === p
                      ? p === 'urgent'
                        ? 'bg-red-600 border-red-500 text-white shadow-lg shadow-red-900/20'
                        : p === 'high'
                        ? 'bg-amber-600 border-amber-500 text-white shadow-lg shadow-amber-900/20'
                        : p === 'normal'
                        ? 'bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-900/20'
                        : 'bg-slate-600 border-slate-500 text-white shadow-lg shadow-slate-900/20'
                      : 'bg-slate-950 border-slate-800 text-slate-500 hover:border-slate-600 hover:text-slate-400'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">Detailed Instruction</label>
            <textarea
              required
              rows={4}
              placeholder="Provide exact instructions to be delivered into the worker runtime composer..."
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!createEligibility.eligible || isSubmitting}
              title={createEligibility.reason}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{isSubmitting ? 'Creating…' : 'Create & Dispatch'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
