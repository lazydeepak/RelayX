import React, { useMemo } from 'react';
import {
  X,
  Cpu,
  GitMerge,
  FileText,
  Eye,
  History,
  RefreshCw,
  Archive,
  RotateCcw,
  Clock,
  Activity,
  Link2,
} from 'lucide-react';
import type {
  UIProject,
  UIPair,
  UIRuntimeSession,
  UIAssignment,
  UIEvent,
  ObservableEvidence,
} from '../types/ui.ts';
import { selectSessionDetail } from './detailViewModels.ts';
import {
  CopyButton,
  DetailSection,
  FieldRow,
  formatDateTime,
} from './detailPrimitives.tsx';

interface SessionDetailModalProps {
  isOpen: boolean;
  sessionId: string | null;
  sessions: UIRuntimeSession[];
  pairs: UIPair[];
  projects: UIProject[];
  assignments: UIAssignment[];
  events: UIEvent[];
  onClose: () => void;
  onProbe?: (sessionId: string) => void;
  onViewEvidence: (evidence: ObservableEvidence) => void;
  onViewHistory: (sessionId: string, sessionName: string) => void;
  onArchive?: (sessionId: string) => void;
  onUnarchive?: (sessionId: string) => void;
}

const statusBadgeClass = (status: string): string => {
  if (status === 'available' || status === 'idle')
    return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
  if (status === 'working')
    return 'bg-blue-500/10 text-blue-400 border border-blue-500/20';
  if (status === 'suspended')
    return 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
  if (status === 'archived')
    return 'bg-slate-800 text-slate-400 border border-slate-700';
  return 'bg-red-500/10 text-red-400 border border-red-500/20';
};

export const SessionDetailModal: React.FC<SessionDetailModalProps> = ({
  isOpen,
  sessionId,
  sessions,
  pairs,
  projects,
  assignments,
  events,
  onClose,
  onProbe,
  onViewEvidence,
  onViewHistory,
  onArchive,
  onUnarchive,
}) => {
  const viewModel = useMemo(() => {
    if (!isOpen || !sessionId) return null;
    return selectSessionDetail({ sessionId, sessions, pairs, projects, assignments, events });
  }, [isOpen, sessionId, sessions, pairs, projects, assignments, events]);

  if (!isOpen || !viewModel) return null;

  const evidence = viewModel.latestEvidence;
  const isArchived = viewModel.status === 'archived';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-start justify-between gap-4 bg-slate-950/60 shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <Cpu className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-bold text-slate-100 truncate">{viewModel.name}</h3>
                <span className="text-[11px] font-mono uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                  {viewModel.provider}
                </span>
                {viewModel.role && (
                  <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20">
                    {viewModel.role}
                  </span>
                )}
                <span
                  className={`text-[11px] px-2 py-0.5 rounded-full font-semibold capitalize ${statusBadgeClass(
                    viewModel.status,
                  )}`}
                >
                  {viewModel.status}
                </span>
              </div>
              <div className="flex items-center gap-1 mt-1">
                <span className="text-[11px] font-mono text-slate-500 select-text">
                  {viewModel.id}
                </span>
                <CopyButton value={viewModel.id} />
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 overflow-y-auto flex-1 text-xs">
          {/* Association */}
          <DetailSection
            icon={<GitMerge className="w-3.5 h-3.5 text-emerald-400" />}
            title="Association"
          >
            <FieldRow
              field={{
                label: 'Project',
                value:
                  viewModel.association.projects.map((p) => p.name).join(', ') || 'Not bound',
                state: viewModel.association.projects.length > 0 ? 'value' : 'empty',
              }}
            />
            <FieldRow
              field={{
                label: 'Pairs',
                value:
                  viewModel.association.pairs
                    .map((p) => `${p.name} (${p.role})`)
                    .join(', ') || 'Not bound',
                state: viewModel.association.pairs.length > 0 ? 'value' : 'empty',
              }}
            />
            <FieldRow
              field={{
                label: 'Active assignment',
                value: viewModel.association.activeAssignment
                  ? `${viewModel.association.activeAssignment.title} · ${viewModel.association.activeAssignment.status}`
                  : 'No active assignments',
                state: viewModel.association.activeAssignment ? 'value' : 'empty',
              }}
            />
          </DetailSection>

          {/* Runtime identity */}
          <DetailSection
            icon={<Link2 className="w-3.5 h-3.5 text-blue-400" />}
            title="Runtime Identity"
          >
            <FieldRow field={viewModel.identity.externalSessionId} />
            <FieldRow field={viewModel.identity.workspacePath} />
            <FieldRow field={viewModel.identity.providerReference} />
            <FieldRow
              field={{
                label: 'Window title',
                value: viewModel.windowTitle || 'Not available',
                state: viewModel.windowTitle ? 'value' : 'empty',
              }}
            />
            <FieldRow
              field={{
                label: 'Application PID',
                value:
                  viewModel.applicationPid !== undefined ? String(viewModel.applicationPid) : '',
                state: viewModel.applicationPid !== undefined ? 'value' : 'empty',
                mono: true,
              }}
            />
            <FieldRow
              field={{
                label: 'Bundle identifier',
                value: viewModel.bundleIdentifier || '',
                state: viewModel.bundleIdentifier ? 'value' : 'empty',
                mono: true,
              }}
            />
          </DetailSection>

          {/* Health / telemetry */}
          <DetailSection
            icon={<Activity className="w-3.5 h-3.5 text-purple-400" />}
            title="Health / Telemetry"
          >
            <FieldRow
              field={{
                label: 'State',
                value: viewModel.health.status,
                state: 'value',
              }}
            />
            <FieldRow
              field={{
                label: 'Observation failures',
                value: `${viewModel.health.consecutiveObservationFailures} / 3 max`,
                state: 'value',
              }}
            />
            {viewModel.integrationStatus && (
              <FieldRow
                field={{
                  label: 'Integration',
                  value: viewModel.integrationStatus,
                  state: 'value',
                }}
              />
            )}
            <FieldRow
              field={{
                label: 'Last observed',
                value: formatDateTime(viewModel.health.lastObservedAt),
                state: viewModel.health.lastObservedAt ? 'value' : 'empty',
              }}
            />
            <FieldRow
              field={{
                label: 'Last heartbeat',
                value: formatDateTime(viewModel.health.lastHeartbeatAt),
                state: viewModel.health.lastHeartbeatAt ? 'value' : 'empty',
              }}
            />
            {viewModel.health.archivedAt && (
              <FieldRow
                field={{
                  label: 'Archived at',
                  value: formatDateTime(viewModel.health.archivedAt),
                  state: 'value',
                }}
              />
            )}
            {viewModel.health.archiveReason && (
              <FieldRow
                field={{
                  label: 'Archive reason',
                  value: viewModel.health.archiveReason,
                  state: 'value',
                }}
              />
            )}
          </DetailSection>

          {/* Evidence */}
          <DetailSection
            icon={<Eye className="w-3.5 h-3.5 text-blue-400" />}
            title="Latest Evidence"
          >
            {!evidence ? (
              <p className="text-slate-500 italic">No recent evidence</p>
            ) : (
              <div className="space-y-1">
                <FieldRow
                  field={{
                    label: 'Evidence ID',
                    value: evidence.id,
                    state: 'value',
                    mono: true,
                  }}
                />
                <FieldRow
                  field={{
                    label: 'Source',
                    value: evidence.source,
                    state: 'value',
                    mono: true,
                  }}
                />
                <FieldRow
                  field={{
                    label: 'Observed at',
                    value: formatDateTime(evidence.timestamp),
                    state: 'value',
                  }}
                />
                {evidence.windowTitle && (
                  <FieldRow
                    field={{
                      label: 'Window title',
                      value: evidence.windowTitle,
                      state: 'value',
                    }}
                  />
                )}
                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={() => onViewEvidence(evidence)}
                    className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300"
                  >
                    <Eye className="w-3 h-3" />
                    <span>View Full Evidence</span>
                  </button>
                </div>
              </div>
            )}
          </DetailSection>

          {/* Recent activity */}
          <DetailSection
            icon={<History className="w-3.5 h-3.5 text-slate-400" />}
            title="Recent Activity"
          >
            {viewModel.recentEvents.length === 0 ? (
              <p className="text-slate-500 italic">No recent events</p>
            ) : (
              <ul className="space-y-1">
                {viewModel.recentEvents.map((event) => (
                  <li
                    key={event.id}
                    className="flex items-start justify-between gap-2 rounded bg-slate-900 border border-slate-800 px-2.5 py-1.5"
                  >
                    <div className="min-w-0">
                      <span className="text-slate-200 font-mono text-[11px]">
                        {event.eventType}
                      </span>
                      <span className="block text-[10px] text-slate-500">
                        {event.resourceType} · {event.actor}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-500 shrink-0">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => onViewHistory(viewModel.id, viewModel.name)}
                className="flex items-center gap-1 text-[11px] text-slate-300 hover:text-white"
              >
                <History className="w-3 h-3" />
                <span>View Full History</span>
              </button>
            </div>
          </DetailSection>

          {/* Metadata */}
          <DetailSection
            icon={<Clock className="w-3.5 h-3.5 text-slate-400" />}
            title="Metadata"
          >
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
          </DetailSection>

          <div className="flex items-center gap-1.5 text-[10px] text-slate-600">
            <FileText className="w-3 h-3" />
            <span>Read-only inspection surface. Use the actions below to change state.</span>
          </div>
        </div>

        {/* Actions footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onProbe?.(viewModel.id)}
              disabled={isArchived || !onProbe}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 text-xs transition-colors"
              title="Probe accessibility & window state"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Probe</span>
            </button>
            <button
              type="button"
              onClick={() => evidence && onViewEvidence(evidence)}
              disabled={!evidence}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 text-xs transition-colors"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Evidence</span>
            </button>
            <button
              type="button"
              onClick={() => onViewHistory(viewModel.id, viewModel.name)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition-colors"
            >
              <History className="w-3.5 h-3.5" />
              <span>History</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            {isArchived ? (
              <button
                type="button"
                onClick={() => onUnarchive?.(viewModel.id)}
                disabled={!onUnarchive}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5 text-emerald-400" />
                <span>Restore</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onArchive?.(viewModel.id)}
                disabled={!onArchive}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs transition-colors"
              >
                <Archive className="w-3.5 h-3.5 text-amber-400" />
                <span>Archive</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
