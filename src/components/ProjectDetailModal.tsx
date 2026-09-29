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
  type ProjectChildSession,
  type BindingVerificationStatus,
  type SavedBinding,
  type DiscoveredIdentity,
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
  onOpenCreatePair?: (projectId: string) => void;
}

const VERIFICATION_META: Record<
  BindingVerificationStatus,
  { label: string; className: string }
> = {
  verified: {
    label: 'Verified',
    className: 'bg-emerald-950 text-emerald-300 border border-emerald-800',
  },
  mismatch: {
    label: 'Mismatch',
    className: 'bg-red-950 text-red-300 border border-red-800',
  },
  unverified: {
    label: 'Unverified',
    className: 'bg-slate-800 text-slate-300 border border-slate-700',
  },
  stale: {
    label: 'Stale',
    className: 'bg-amber-950 text-amber-300 border border-amber-800',
  },
  ambiguous: {
    label: 'Ambiguous',
    className: 'bg-violet-950 text-violet-300 border border-violet-800',
  },
  unavailable: {
    label: 'No identity',
    className: 'bg-slate-900 text-slate-500 border border-slate-800',
  },
};

const VerificationBadge: React.FC<{ status: BindingVerificationStatus }> = ({ status }) => {
  const meta = VERIFICATION_META[status];
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase shrink-0 ${meta.className}`}
      title={status}
    >
      {meta.label}
    </span>
  );
};

/** Renders the SAVED (persisted) binding value — never hidden by discovery failures. */
const SavedBindingValue: React.FC<{ saved: SavedBinding }> = ({ saved }) => (
  <div className="flex items-center gap-1.5 min-w-0">
    <span className="text-slate-500 shrink-0">Saved</span>
    <span className="font-mono text-[11px] text-slate-200 truncate select-text" title={saved.value}>
      {saved.value}
    </span>
    <span className="text-[9px] uppercase text-slate-500 shrink-0">
      {saved.source === 'project' ? 'project' : 'runtime'}
    </span>
  </div>
);

/** Renders the LATEST discovered identity with its authority marked. */
const DiscoveredValue: React.FC<{ discovered: DiscoveredIdentity }> = ({ discovered }) => {
  if (!discovered.reference) return null;
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-slate-500 shrink-0">Latest</span>
      <span
        className="font-mono text-[11px] text-slate-300 truncate select-text"
        title={discovered.reference}
      >
        {discovered.reference}
      </span>
      {discovered.displayOnly && (
        <span className="text-[9px] uppercase text-amber-500/80 shrink-0" title="Derived from a window/title parse; not verified authoritatively">
          unverified
        </span>
      )}
      {discovered.sessionIdSource === 'authoritative' && (
        <span className="text-[9px] uppercase text-emerald-500/80 shrink-0">authoritative</span>
      )}
    </div>
  );
};

const BindingSideRow: React.FC<{
  side: ProjectBindingSide;
  onOpenSessionDetail?: (sessionId: string) => void;
}> = ({ side, onOpenSessionDetail }) => {
  const roleLabel = side.role === 'planner' ? 'Planner' : 'Worker';
  const accent = side.role === 'planner' ? 'text-purple-400' : 'text-emerald-400';
  return (
    <div className="py-1.5 border-b border-slate-800/60 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Cpu className={`w-3.5 h-3.5 ${accent} shrink-0`} />
          <span className={`text-[11px] font-semibold uppercase ${accent}`}>{roleLabel}</span>
          <span className="text-xs text-slate-200 truncate">
            {side.bound ? side.sessionName : 'Not bound'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] min-w-0">
          <VerificationBadge status={side.verification.status} />
          {side.bound && (
            <>
              {side.provider && (
                <span className="font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                  {side.provider}
                </span>
              )}
              {side.runtimeStatus && (
                <span className="font-mono text-slate-400">{side.runtimeStatus}</span>
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
          )}
        </div>
      </div>

      {side.bound ? (
        <div className="mt-1 ml-6 space-y-0.5">
          {side.savedBinding && <SavedBindingValue saved={side.savedBinding} />}
          {side.discovered && <DiscoveredValue discovered={side.discovered} />}
          {side.verification.status !== 'verified' && side.verification.note && (
            <p className="text-[10px] text-slate-500">
              {side.verification.status === 'mismatch' ? '⚠ ' : ''}
              {side.verification.note}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-1 ml-6 space-y-0.5">
          {side.savedBinding && <SavedBindingValue saved={side.savedBinding} />}
          {side.verification.note && (
            <p className="text-[10px] text-slate-500">{side.verification.note}</p>
          )}
        </div>
      )}
    </div>
  );
};

const SessionChildRow: React.FC<{
  session: ProjectChildSession;
  onOpenSessionDetail?: (sessionId: string) => void;
}> = ({ session, onOpenSessionDetail }) => {
  const accent = session.role === 'planner' ? 'text-purple-400' : 'text-emerald-400';
  return (
    <li className="flex items-center justify-between gap-2 rounded bg-slate-900 border border-slate-800 px-2.5 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <Cpu className={`w-3 h-3 ${accent} shrink-0`} />
        <span className={`text-[10px] font-semibold uppercase ${accent} shrink-0`}>
          {session.role}
        </span>
        <span className="text-xs text-slate-200 truncate">{session.sessionName}</span>
      </div>
      <div className="flex items-center gap-2 text-[11px] min-w-0">
        <span className="font-mono text-slate-500 truncate max-w-[140px]">{session.provider}</span>
        <span className="font-mono text-slate-400">{session.runtimeStatus}</span>
        <VerificationBadge status={session.verification.status} />
        {session.sessionId && onOpenSessionDetail && (
          <button
            type="button"
            onClick={() => onOpenSessionDetail(session.sessionId)}
            className="text-blue-400 hover:text-blue-300 shrink-0"
            title="Open session details"
          >
            <Eye className="w-3 h-3" />
          </button>
        )}
      </div>
    </li>
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
  onOpenCreatePair,
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
                <span>Edit Project</span>
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
          {/* Top Half: Durable Project Configuration */}
          <section className="rounded-lg bg-slate-950 border border-slate-800 p-4 space-y-3">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-300">
              <GitBranch className="w-3.5 h-3.5 text-blue-400" />
              Durable Project Configuration & Destinations
            </h4>
            <div className="space-y-2">
              <FieldRow field={viewModel.repository.canonicalPath} />
              <FieldRow field={viewModel.repository.gitRoot} />
              <FieldRow field={viewModel.destinations.planner} />
              <FieldRow field={viewModel.destinations.worker} />
            </div>
          </section>

          {/* Session Pairs Section */}
          <section className="rounded-lg bg-slate-950 border border-slate-800 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-300">
                <GitMerge className="w-3.5 h-3.5 text-emerald-400" />
                Session Pairs ({viewModel.bindings.length + viewModel.archivedBindings.length})
              </h4>
              <button
                type="button"
                onClick={() => onOpenCreatePair?.(viewModel.id)}
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow transition-colors"
              >
                <span>+ New Pair</span>
              </button>
            </div>

            {viewModel.bindings.length === 0 && viewModel.archivedBindings.length === 0 ? (
              <p className="text-slate-500 italic">No session pairs created for this project yet.</p>
            ) : (
              <div className="space-y-3">
                {viewModel.bindings.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-[10px] font-semibold uppercase text-emerald-400">Active Session Pairs</span>
                    {viewModel.bindings.map((binding) => (
                      <div
                        key={binding.pairId}
                        className="rounded-lg bg-slate-900 border border-slate-800 p-3"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-semibold text-slate-200">
                            {binding.pairName}
                          </span>
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-800 uppercase">
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

                {viewModel.archivedBindings.length > 0 && (
                  <div className="space-y-2 pt-2">
                    <span className="text-[10px] font-semibold uppercase text-amber-400">Historical / Archived Session Pairs</span>
                    {viewModel.archivedBindings.map((binding) => (
                      <div
                        key={binding.pairId}
                        className="rounded-lg bg-slate-900/60 border border-slate-800/80 p-3 opacity-80"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-slate-300">
                            {binding.pairName}
                          </span>
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-950 text-amber-300 border border-amber-800 uppercase">
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
              </div>
            )}
          </section>

          {/* Discovered Sessions Section */}
          <section className="rounded-lg bg-slate-950 border border-slate-800 p-4 space-y-3">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-300">
              <Cpu className="w-3.5 h-3.5 text-purple-400" />
              Discovered Sessions
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <span className="text-[10px] font-semibold uppercase text-slate-400">Planner Sessions</span>
                {viewModel.discoveredSessions.planners.length === 0 ? (
                  <p className="text-slate-500 italic text-[11px]">No discovered planner sessions</p>
                ) : (
                  <ul className="space-y-1">
                    {viewModel.discoveredSessions.planners.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 p-2 rounded bg-slate-900 border border-slate-800">
                        <div className="min-w-0">
                          <span className="text-xs text-slate-200 truncate block">{s.name}</span>
                          <span className="font-mono text-[10px] text-slate-400">{s.provider}</span>
                        </div>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase font-semibold shrink-0 ${
                          s.paired ? 'bg-blue-950 text-blue-300 border border-blue-800' : 'bg-slate-800 text-slate-300'
                        }`}>
                          {s.paired ? 'Paired' : 'Available'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="space-y-1.5">
                <span className="text-[10px] font-semibold uppercase text-slate-400">Worker Sessions</span>
                {viewModel.discoveredSessions.workers.length === 0 ? (
                  <p className="text-slate-500 italic text-[11px]">No discovered worker sessions</p>
                ) : (
                  <ul className="space-y-1">
                    {viewModel.discoveredSessions.workers.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 p-2 rounded bg-slate-900 border border-slate-800">
                        <div className="min-w-0">
                          <span className="text-xs text-slate-200 truncate block">{s.name}</span>
                          <span className="font-mono text-[10px] text-slate-400">{s.provider}</span>
                        </div>
                        <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase font-semibold shrink-0 ${
                          s.paired ? 'bg-blue-950 text-blue-300 border border-blue-800' : 'bg-slate-800 text-slate-300'
                        }`}>
                          {s.paired ? 'Paired' : 'Available'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          {/* Project Activity / Execution */}
          <section className="rounded-lg bg-slate-950 border border-slate-800 p-4 space-y-3">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-300">
              <FileText className="w-3.5 h-3.5 text-blue-400" />
              Project Activity & Execution
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

            {/* Activity Events */}
            <div className="pt-2 border-t border-slate-800/80">
              <span className="text-slate-400 block mb-1 flex items-center gap-1">
                <Activity className="w-3 h-3 text-purple-400" />
                Recent Events (Last activity: {formatDateTime(viewModel.activity.lastActivityAt)})
              </span>
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
            </div>
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
