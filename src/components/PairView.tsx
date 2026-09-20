import React, { useState } from 'react';
import {
  GitMerge,
  Cpu,
  Play,
  Pause,
  RefreshCw,
  Eye,
  CheckCircle2,
  ArrowRight,
  Send,
  FileText,
  ShieldAlert,
  Plus,
  FolderPlus,
  Edit3,
  Archive,
  Trash2,
  Unlink,
  Layers,
  Check,
  RotateCcw,
} from 'lucide-react';
import { UIPair, UIProject, UIRuntimeSession, ObservableEvidence } from '../types/ui.ts';

interface PairViewProps {
  pairs: UIPair[];
  projects: UIProject[];
  onOpenCreateProject: () => void;
  onOpenEditProject: (project: UIProject) => void;
  onArchiveProject: (id: string) => void;
  onUnarchiveProject: (id: string) => void;
  onOpenCreatePair: (projectId?: string) => void;
  onOpenEditPair: (pair: UIPair) => void;
  onArchivePair: (id: string) => void;
  onUnarchivePair: (id: string) => void;
  onDetachRuntime: (pairId: string, role: 'planner' | 'worker') => void;
  onDispatchAssignment: (pairId: string) => void;
  onDeliverHandoff: (pairId: string) => void;
  onCompleteAssignment: (pairId: string) => void;
  onInspectPair: (pairId: string) => void;
  onViewEvidence: (ev: ObservableEvidence) => void;
  onStartPair?: (pairId: string) => void;
  onPausePair?: (pairId: string) => void;
}

export const PairView: React.FC<PairViewProps> = ({
  pairs,
  projects,
  onOpenCreateProject,
  onOpenEditProject,
  onArchiveProject,
  onUnarchiveProject,
  onOpenCreatePair,
  onOpenEditPair,
  onArchivePair,
  onUnarchivePair,
  onDetachRuntime,
  onDispatchAssignment,
  onDeliverHandoff,
  onCompleteAssignment,
  onInspectPair,
  onViewEvidence,
  onStartPair,
  onPausePair,
}) => {
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
  const [showArchived, setShowArchived] = useState<boolean>(false);

  // Filter projects based on archived flag
  const visibleProjects = projects.filter((p) => (showArchived ? true : p.status !== 'archived'));

  // Filter pairs based on selected project and archived status
  const filteredPairs = pairs.filter((p) => {
    if (!showArchived && p.status === 'archived') return false;
    if (selectedProjectId !== 'all' && p.projectId !== selectedProjectId) return false;
    return true;
  });

  const selectedProject = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <GitMerge className="w-5 h-5 text-blue-400" />
            <span>Projects & Planner-Worker Pairs</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Manage projects, bind runtime sessions, coordinate assignments, and enforce lifecycle invariants
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowArchived(!showArchived)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 ${
              showArchived
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Archive className="w-3.5 h-3.5" />
            <span>{showArchived ? 'Showing Archived' : 'Show Archived'}</span>
          </button>

          <button
            onClick={onOpenCreateProject}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors shadow-sm"
          >
            <FolderPlus className="w-3.5 h-3.5 text-blue-400" />
            <span>New Project</span>
          </button>

          <button
            onClick={() => onOpenCreatePair(selectedProjectId !== 'all' ? selectedProjectId : undefined)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Create Pair</span>
          </button>
        </div>
      </div>

      {/* Project Selector Bar */}
      <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Layers className="w-3.5 h-3.5 text-blue-400" />
            <span>PROJECT WORKSPACE:</span>
          </div>

          {selectedProject && (
            <div className="flex items-center gap-2">
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                  selectedProject.status === 'archived'
                    ? 'bg-amber-950 text-amber-300 border border-amber-800'
                    : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                }`}
              >
                {selectedProject.status}
              </span>

              <button
                onClick={() => onOpenEditProject(selectedProject)}
                className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-xs flex items-center gap-1"
                title="Rename / Edit Project"
              >
                <Edit3 className="w-3.5 h-3.5" />
              </button>

              {selectedProject.status === 'archived' ? (
                <button
                  onClick={() => onUnarchiveProject(selectedProject.id)}
                  className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-emerald-400 text-xs flex items-center gap-1"
                  title="Unarchive Project"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  onClick={() => onArchiveProject(selectedProject.id)}
                  className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-amber-400 text-xs flex items-center gap-1"
                  title="Archive Project"
                >
                  <Archive className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Project Pills */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setSelectedProjectId('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              selectedProjectId === 'all'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-950 border border-slate-800 text-slate-400 hover:bg-slate-800/80 hover:text-slate-200'
            }`}
          >
            All Projects ({pairs.length})
          </button>

          {visibleProjects.map((p) => {
            const count = pairs.filter((pair) => pair.projectId === p.id).length;
            const isSelected = selectedProjectId === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setSelectedProjectId(p.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800/80 hover:text-slate-100'
                }`}
              >
                <span>{p.name}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${isSelected ? 'bg-blue-800 text-white' : 'bg-slate-800 text-slate-400'}`}>
                  {count}
                </span>
                {p.status === 'archived' && (
                  <span className="text-[10px] text-amber-300 font-mono">(archived)</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Pairs List */}
      {filteredPairs.length === 0 ? (
        <div className="p-8 rounded-xl bg-slate-900 border border-slate-800 text-center space-y-3">
          <GitMerge className="w-8 h-8 text-slate-600 mx-auto" />
          <h3 className="text-sm font-semibold text-slate-300">
            {selectedProjectId === 'all' ? 'No Pairs Configured' : 'No Pairs Found in this Project'}
          </h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            Create a planner-worker pair under this project or load demo data to begin coordinating runtime sessions.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => onOpenCreatePair(selectedProjectId !== 'all' ? selectedProjectId : undefined)}
              className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium"
            >
              Create Pair
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {filteredPairs.map((pair) => (
            <div
              key={pair.id}
              className={`bg-slate-900 border rounded-xl p-6 shadow-sm space-y-5 transition-all ${
                pair.status === 'archived' ? 'border-slate-800/60 opacity-80' : 'border-slate-800'
              }`}
            >
              {/* Pair Header */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-800 gap-3">
                <div>
                  <span className="text-[11px] font-semibold text-blue-400 uppercase tracking-wider block">
                    {pair.projectName}
                  </span>
                  <div className="flex items-center gap-2 mt-0.5">
                    <h2 className="text-base font-bold text-slate-100">{pair.name}</h2>
                    {pair.status === 'archived' && (
                      <span className="px-2 py-0.5 text-[10px] font-semibold rounded bg-amber-950 text-amber-300 border border-amber-800 uppercase">
                        Archived
                      </span>
                    )}
                  </div>
                </div>

                {/* Status & Management Controls */}
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold capitalize ${
                      pair.status === 'active'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                        : pair.status === 'blocked'
                        ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                        : pair.status === 'paused'
                        ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30'
                        : 'bg-slate-800 text-slate-400 border border-slate-700'
                    }`}
                  >
                    Pair: {pair.status}
                  </span>

                  {/* Pause / Resume buttons */}
                  {pair.status === 'active' && onPausePair && (
                    <button
                      onClick={() => onPausePair(pair.id)}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                      title="Pause Pair"
                    >
                      <Pause className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {(pair.status === 'paused' || pair.status === 'idle') && onStartPair && (
                    <button
                      onClick={() => onStartPair(pair.id)}
                      className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                      title="Start / Resume Pair"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Reconcile / Inspect */}
                  <button
                    onClick={() => onInspectPair(pair.id)}
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                    title="Reconcile / Inspect Runtimes"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>

                  {/* Edit Pair / Rebind Runtimes */}
                  <button
                    onClick={() => onOpenEditPair(pair)}
                    className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                    title="Edit Pair & Bindings"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>

                  {/* Archive / Unarchive */}
                  {pair.status === 'archived' ? (
                    <button
                      onClick={() => onUnarchivePair(pair.id)}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-emerald-400 transition-colors"
                      title="Unarchive Pair"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => onArchivePair(pair.id)}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-amber-400 transition-colors"
                      title="Archive Pair"
                    >
                      <Archive className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Architecture Node Grid: Planner <---> Worker */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Planner Card */}
                <div className="p-4 rounded-lg bg-slate-950/70 border border-slate-800/90 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase text-purple-400 flex items-center gap-1.5">
                      <Cpu className="w-3.5 h-3.5" /> Planner Session
                    </span>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded font-mono ${
                          pair.plannerStatus === 'available' || pair.plannerStatus === 'idle'
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {pair.plannerStatus || 'unassigned'}
                      </span>
                      {pair.plannerSessionId && (
                        <button
                          onClick={() => onDetachRuntime(pair.id, 'planner')}
                          className="text-[10px] text-slate-400 hover:text-amber-400 flex items-center gap-0.5"
                          title="Detach Planner from this Pair"
                        >
                          <Unlink className="w-3 h-3" />
                          <span>Detach</span>
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-slate-200">
                    {pair.plannerName || '(No Planner Runtime Bound)'}
                  </div>
                  <p className="text-xs text-slate-400">
                    Provider: <span className="font-mono text-slate-300">{pair.plannerProvider || 'None'}</span>
                  </p>
                </div>

                {/* Worker Card */}
                <div className="p-4 rounded-lg bg-slate-950/70 border border-slate-800/90 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase text-emerald-400 flex items-center gap-1.5">
                      <Cpu className="w-3.5 h-3.5" /> Worker Session
                    </span>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded font-mono ${
                          pair.workerStatus === 'working'
                            ? 'bg-blue-950 text-blue-300 border border-blue-800 animate-pulse'
                            : pair.workerStatus === 'available'
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                            : pair.workerStatus === 'suspended'
                            ? 'bg-amber-950 text-amber-300 border border-amber-800'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {pair.workerStatus || 'unassigned'}
                      </span>
                      {pair.workerSessionId && (
                        <button
                          onClick={() => onDetachRuntime(pair.id, 'worker')}
                          className="text-[10px] text-slate-400 hover:text-amber-400 flex items-center gap-0.5"
                          title="Detach Worker from this Pair"
                        >
                          <Unlink className="w-3 h-3" />
                          <span>Detach</span>
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-slate-200">
                    {pair.workerName || '(No Worker Runtime Bound)'}
                  </div>
                  <p className="text-xs text-slate-400">
                    Provider: <span className="font-mono text-slate-300">{pair.workerProvider || 'None'}</span>
                  </p>
                </div>
              </div>

              {/* Current Assignment, Delivery & Handoff State */}
              <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between text-xs gap-2">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-blue-400" />
                    <span className="font-semibold text-slate-200">
                      {pair.activeAssignmentTitle || 'No active assignment currently running'}
                    </span>
                  </div>
                  {pair.activeAssignmentStatus && (
                    <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px]">
                      Assignment: {pair.activeAssignmentStatus}
                    </span>
                  )}
                </div>

                {/* Delivery and Handoff Sub-status Badges */}
                <div className="flex flex-wrap items-center gap-3 pt-2 text-xs">
                  {pair.deliveryStatus && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
                      <span className="text-slate-400">Delivery:</span>
                      <span
                        className={`font-semibold ${
                          pair.deliveryStatus === 'delivered'
                            ? 'text-emerald-400'
                            : pair.deliveryStatus === 'ambiguous'
                            ? 'text-amber-400 font-bold'
                            : 'text-slate-300'
                        }`}
                      >
                        {pair.deliveryStatus.toUpperCase()}
                      </span>
                      {pair.deliveryEvidence && (
                        <button
                          onClick={() => onViewEvidence(pair.deliveryEvidence!)}
                          className="ml-1 text-blue-400 hover:text-blue-300 flex items-center gap-0.5"
                        >
                          <Eye className="w-3 h-3" />
                          <span className="text-[10px]">Evidence</span>
                        </button>
                      )}
                    </div>
                  )}

                  {pair.handoffStatus && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 border border-slate-800">
                      <span className="text-slate-400">Handoff:</span>
                      <span className="font-semibold text-purple-400 uppercase">{pair.handoffStatus}</span>
                    </div>
                  )}

                  {pair.handoffSummary && (
                    <p className="w-full text-xs text-slate-300 bg-slate-900/90 p-2.5 rounded border border-slate-800/80 italic">
                      "{pair.handoffSummary}"
                    </p>
                  )}
                </div>
              </div>

              {/* Action Bar */}
              <div className="flex flex-wrap items-center justify-between pt-2 gap-3">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onDispatchAssignment(pair.id)}
                    disabled={pair.status === 'archived' || pair.status === 'paused'}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Dispatch Assignment</span>
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {pair.handoffStatus === 'ready' && (
                    <button
                      onClick={() => onDeliverHandoff(pair.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-colors"
                    >
                      <ArrowRight className="w-3.5 h-3.5" />
                      <span>Deliver Handoff to Planner</span>
                    </button>
                  )}

                  {pair.activeAssignmentStatus === 'waiting_for_handoff' && (
                    <button
                      onClick={() => onCompleteAssignment(pair.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Planner Approves & Completes</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
