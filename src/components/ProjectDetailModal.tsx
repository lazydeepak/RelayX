import React, { useMemo } from 'react';
import {
  X,
  Layers,
  GitBranch,
  GitMerge,
  Cpu,
  FileText,
  AlertTriangle,
  Clock,
  Activity,
  Edit3,
  Eye,
} from 'lucide-react';
import type {
  UIProject,
  UIPair,
  UIRuntimeSession,
  UIAssignment,
  UIEvent,
  UIAttentionItem,
  ObservableEvidence,
} from '../types/ui.ts';
import {
  selectProjectDetail,
  type ProjectBindingSide,
} from './detailViewModels.ts';
import { CopyButton, FieldRow, formatDateTime } from './detailPrimitives.tsx';

interface ProjectDetailModalProps {
  isOpen: boolean;
  projectId: string | null;
  projects: UIProject[];
  pairs: UIPair[];
  sessions: UIRuntimeSession[];
  assignments: UIAssignment[];
  events: UIEvent[];
  attentionItems: UIAttentionItem[];
  onClose: () => void;
  onEdit?: (project: UIProject) => void;
  onViewEvidence: (evidence: ObservableEvidence) => void;
  onOpenSessionDetail?: (sessionId: string) => void;
}

const BindingSideRow: React.FC<{
  side: ProjectBindingSide;
  onOpenSessionDetail?: (sessionId: string) => void;
}> = ({ side, onOpenSessionDetail }) => {
  const roleLabel = side.role === 'planner' ? 'Planner' : 'Worker';
  const accent = side.role === 'planner' ? 'text-purple-400' : 'text-emerald-400';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <Cpu className={`w-3.5 h-3.5 ${accent} shrink-0`} />
        <span className={`text-[11px] font-semibold uppercase ${accent}`}>{roleLabel}</span>
        <span className="text-xs text-slate-200 truncate">
          {side.bound ? side.sessionName : 'Not bound'}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[11px] min-w-0">
        {side.bound ? (
          <>
            {side.provider && (
              <span className="font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                {side.provider}
              </span>
            )}
            {side.runtimeStatus && (
              <span className="font-mono text-slate-400">{side.runtimeStatus}</span>
            )}
            {side.reference && (
              <span
                className="font-mono text-slate-500 truncate max-w-[180px] select-text"
                title={side.reference}
              >
                {side.reference}
              </span>
            )}
            {side.sessionId && onOpenSessionDetail && (
              <button
                type="button"
                onClick={() => onOpenSessionDetail(side.sessionId!)}
                className="text-blue-400 hover:text-blue-300"
                title="Open session details"
              >
                <Eye className="w-3 h-3" />
              </button>
            )}
          </>
        ) : (
          <span className="text-slate-500 italic">Not bound</span>
        )}
      </div>
    </div>
  );
};

export const ProjectDetailModal: React.FC<ProjectDetailModalProps> = ({
  isOpen,
  projectId,
  projects,
  pairs,
  sessions,
  assignments,
  events,
  attentionItems,
  onClose,
  onEdit,
  onViewEvidence,
  onOpenSessionDetail,
}) => {
  const viewModel = useMemo(() => {
    if (!isOpen || !projectId) return null;
    return selectProjectDetail({
      projectId,
      projects,
      pairs,
      sessions,
      assignments,
      events,
      attentionItems,
    });
  }, [isOpen, projectId, projects, pairs, sessions, assignments, events, attentionItems]);

  if (!isOpen || !viewModel) return null;

  const project = projects.find((p) => p.id === viewModel.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4 bg-slate-950/60 shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <Layers className="w-5 h-5 text-blue-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-bold text-slate-100 truncate">{viewModel.name}</h3>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                    viewModel.status === 'archived'
                      ? 'bg-amber-950 text-amber-300 border border-amber-800'
                      : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                  }`}
                >
                  {viewModel.status}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 truncate">
                {viewModel.description || 'No description'}
              </p>
              <div className="flex items-center gap-1 mt-1">
                <span className="text-[11px] font-mono text-slate-500 select-text">
                  {viewModel.id}
                </span>
                <CopyButton value={viewModel.id} />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onEdit && project && (
              <button
                type="button"
                onClick={() => onEdit(project)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors"
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>Edit</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 overflow-y-auto flex-1 text-xs">
          {/* Repository */}
          <section className="rounded-lg bg-slate-950 border border-slate-800 p-4">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-300 mb-2">
              <GitBranch className="w-3.5 h-3.5 text-blue-400" />
              Repository
            </h4>
            <FieldRow field={viewModel.repository.canonicalPath} />
            <FieldRow field={viewModel.repository.gitRoot} />
          </section>

          {/* Bindings */}
          <section className="rounded-lg bg-slate-950 border border-slate-800 p-4">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-300 mb-3">
              <GitMerge className="w-3.5 h-3.5 text-emerald-400" />
              Bindings / Pairs ({viewModel.bindings.length})
            </h4>
            {viewModel.bindings.length === 0 ? (
              <p className="text-slate-500 italic">No pairs bound to this project.</p>
            ) : (
              <div className="space-y-3">
                {viewModel.bindings.map((binding) => (
                  <div
                    key={binding.pairId}
                    className="rounded-lg bg-slate-900 border border-slate-800 p-3"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-slate-200">
                        {binding.pairName}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                          binding.archived
                            ? 'bg-amber-950 text-amber-300'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {binding.status}
                      </span>
                    </div>
                    <BindingSideRow
                      side={binding.planner}
                      onOpenSessionDetail={onOpenSessionDetail}
                    />
                    <BindingSideRow
                      side={binding.worker}
                      onOpenSessionDetail={onOpenSessionDetail}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Work */}
          <section className="rounded-lg bg-slate-950 border border-slate-800 p-4">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-300 mb-3">
              <FileText className="w-3.5 h-3.5 text-blue-400" />
              Work
            </h4>

            <div className="space-y-3">
              <div>
                <span className="text-slate-400 block mb-1">
                  Active assignments ({viewModel.work.active.length})
                </span>
                {viewModel.work.active.length === 0 ? (
                  <p className="text-slate-500 italic">No active assignments</p>
                ) : (
                  <ul className="space-y-1">
                    {viewModel.work.active.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between gap-2 rounded bg-slate-900 border border-slate-800 px-2.5 py-1.5"
                      >
                        <span className="text-slate-200 truncate">{a.title}</span>
                        <span className="font-mono text-[10px] text-slate-400 shrink-0">
                          {a.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <span className="text-slate-400 block mb-1">
                  Recent completed ({viewModel.work.recentCompleted.length})
                </span>
                {viewModel.work.recentCompleted.length === 0 ? (
                  <p className="text-slate-500 italic">No completed assignments yet</p>
                ) : (
                  <ul className="space-y-1">
                    {viewModel.work.recentCompleted.map((a) => (
                      <li
                        key={a.id}
                        className="flex items-center justify-between gap-2 rounded bg-slate-900 border border-slate-800 px-2.5 py-1.5"
                      >
                        <span className="text-slate-300 truncate">{a.title}</span>
                        <span className="font-mono text-[10px] text-slate-500 shrink-0">
                          {a.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {viewModel.work.attention.length > 0 && (
                <div>
                  <span className="text-slate-400 block mb-1 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 text-amber-400" />
                    Attention ({viewModel.work.attention.length})
                  </span>
                  <ul className="space-y-1">
                    {viewModel.work.attention.map((item) => (
                      <li
                        key={item.id}
                        className="rounded bg-amber-500/5 border border-amber-500/20 px-2.5 py-1.5"
                      >
                        <span className="text-amber-200">{item.title}</span>
                        <span className="block text-[10px] text-amber-200/70">{item.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>

          {/* Activity */}
          <section className="rounded-lg bg-slate-950 border border-slate-800 p-4">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-300 mb-2">
              <Activity className="w-3.5 h-3.5 text-purple-400" />
              Activity
            </h4>
            <FieldRow
              field={{
                label: 'Last activity',
                value: formatDateTime(viewModel.activity.lastActivityAt),
                state: viewModel.activity.lastActivityAt ? 'value' : 'empty',
              }}
            />
            {viewModel.activity.recentEvents.length === 0 ? (
              <p className="text-slate-500 italic mt-1">No recent project events.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {viewModel.activity.recentEvents.map((event) => (
                  <li
                    key={event.id}
                    className="flex items-start justify-between gap-2 rounded bg-slate-900 border border-slate-800 px-2.5 py-1.5"
                  >
                    <div className="min-w-0">
                      <span className="text-slate-200 font-mono text-[11px]">{event.eventType}</span>
                      <span className="block text-[10px] text-slate-500">
                        {event.resourceType} · {event.actor}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {event.evidence && (
                        <button
                          type="button"
                          onClick={() => onViewEvidence(event.evidence!)}
                          className="text-blue-400 hover:text-blue-300 flex items-center gap-0.5 text-[10px]"
                        >
                          <Eye className="w-3 h-3" />
                          <span>Evidence</span>
                        </button>
                      )}
                      <span className="text-[10px] text-slate-500">
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Metadata */}
          <section className="rounded-lg bg-slate-950 border border-slate-800 p-4">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-300 mb-2">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              Metadata
            </h4>
            <FieldRow
              field={{
                label: 'Created',
                value: formatDateTime(viewModel.metadata.createdAt),
                state: viewModel.metadata.createdAt ? 'value' : 'empty',
              }}
            />
            <FieldRow
              field={{
                label: 'Updated',
                value: formatDateTime(viewModel.metadata.updatedAt),
                state: viewModel.metadata.updatedAt ? 'value' : 'empty',
              }}
            />
          </section>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/60 flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
