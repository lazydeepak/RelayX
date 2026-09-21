import React from 'react';
import {
  Cpu,
  Eye,
  RefreshCw,
  Search,
  PlusCircle,
  Archive,
  RotateCcw,
  Unlink,
  Layers,
  CheckCircle2,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { UIRuntimeSession, UIPair, ObservableEvidence, ProviderType } from '../types/ui.ts';

interface SessionsViewProps {
  sessions: UIRuntimeSession[];
  pairs: UIPair[];
  onInspectSession: (id: string) => void;
  onViewEvidence: (ev: ObservableEvidence) => void;
  onOpenDiscover: () => void;
  onOpenRegister: () => void;
  onArchiveSession: (id: string) => void;
  onUnarchiveSession: (id: string) => void;
  onDetachSession: (sessionId: string) => void;
  onAttachToPair: (sessionId: string) => void;
  onViewHistory: (sessionId: string, name: string) => void;
  onOpenSessionDetail: (sessionId: string) => void;
}

export const SessionsView: React.FC<SessionsViewProps> = ({
  sessions,
  pairs,
  onInspectSession,
  onViewEvidence,
  onOpenDiscover,
  onOpenRegister,
  onArchiveSession,
  onUnarchiveSession,
  onDetachSession,
  onAttachToPair,
  onViewHistory,
  onOpenSessionDetail,
}) => {
  const [showArchived, setShowArchived] = React.useState(false);

  const visibleSessions = sessions.filter((s) => (showArchived ? true : s.status !== 'archived'));

  const getIntegrationBadge = (status?: string) => {
    switch (status) {
      case 'real':
        return (
          <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
            Real Provider
          </span>
        );
      case 'partial':
        return (
          <span className="text-[10px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-medium">
            macOS Window Probe
          </span>
        );
      case 'unsupported':
      default:
        return (
          <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700 font-medium">
            Integration Not Connected
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Cpu className="w-5 h-5 text-emerald-400" />
            <span>Runtime Sessions</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            macOS external AI application instances, accessibility bindings, and observable process states
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
            onClick={onOpenDiscover}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md transition-colors"
          >
            <Search className="w-3.5 h-3.5" />
            <span>Discover & Attach</span>
          </button>

          <button
            onClick={onOpenRegister}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors shadow-sm"
          >
            <PlusCircle className="w-3.5 h-3.5 text-blue-400" />
            <span>Register Session</span>
          </button>
        </div>
      </div>

      {/* Sessions Grid */}
      {visibleSessions.length === 0 ? (
        <div className="p-8 rounded-xl bg-slate-900 border border-slate-800 text-center space-y-3">
          <Cpu className="w-8 h-8 text-slate-600 mx-auto" />
          <h3 className="text-sm font-semibold text-slate-300">
            {showArchived ? 'No Archived Sessions Found' : 'No Active Runtime Sessions Registered'}
          </h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            Discover running macOS AI apps or manually register a session to begin orchestrating work.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={onOpenDiscover}
              className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
            >
              Probe & Discover
            </button>
            <button
              onClick={onOpenRegister}
              className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium"
            >
              Register Manually
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleSessions.map((session) => {
            // Find attached pairs
            const attachedPairs = pairs.filter(
              (p) => p.plannerSessionId === session.id || p.workerSessionId === session.id,
            );

            return (
              <div
                key={session.id}
                className={`p-5 rounded-xl bg-slate-900 border flex flex-col justify-between space-y-4 shadow-sm transition-all ${
                  session.status === 'archived' ? 'border-slate-800/60 opacity-80' : 'border-slate-800'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-mono uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                        {session.providerType}
                      </span>
                      {getIntegrationBadge(session.integrationStatus)}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {session.status === 'archived' && (
                        <span className="px-2 py-0.5 text-[10px] font-semibold rounded bg-amber-950 text-amber-300 border border-amber-800 uppercase">
                          Archived
                        </span>
                      )}
                      <span
                        className={`text-xs px-2.5 py-0.5 rounded-full font-semibold capitalize ${
                          session.status === 'available' || session.status === 'idle'
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : session.status === 'working'
                            ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse'
                            : session.status === 'suspended'
                            ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                            : session.status === 'archived'
                            ? 'bg-slate-800 text-slate-400 border border-slate-700'
                            : 'bg-red-500/10 text-red-400 border border-red-500/20'
                        }`}
                      >
                        {session.status}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenSessionDetail(session.id)}
                    className="text-sm font-bold text-slate-100 hover:text-blue-300 text-left transition-colors"
                    title="Open session details"
                  >
                    {session.name}
                  </button>
                  {session.status === 'archived' && session.archiveReason && (
                    <div className="mt-1 p-2 rounded bg-amber-500/5 border border-amber-500/10 text-[10px] text-amber-200/80 italic">
                      Reason: {session.archiveReason}
                    </div>
                  )}
                  <p className="text-xs text-slate-400 font-mono mt-1 truncate">
                    {session.windowTitle ||
                      (session.integrationStatus === 'unsupported'
                        ? 'Integration not connected'
                        : 'No active window identified')}
                  </p>
                </div>

                {/* Attached Pairs Info */}
                <div className="space-y-1.5 border-t border-slate-800 pt-3">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="flex items-center gap-1 text-[11px] font-medium text-slate-300">
                      <Layers className="w-3 h-3 text-blue-400" />
                      Attached Pairs ({attachedPairs.length}):
                    </span>
                    <div className="flex items-center gap-2">
                      {session.status !== 'archived' && (
                        <button
                          onClick={() => onAttachToPair(session.id)}
                          className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-0.5"
                          title="Bind this runtime to a new or existing pair"
                        >
                          <PlusCircle className="w-2.5 h-2.5" />
                          <span>Attach</span>
                        </button>
                      )}
                      {attachedPairs.length > 0 && (
                        <button
                          onClick={() => onDetachSession(session.id)}
                          className="text-[10px] text-slate-400 hover:text-amber-400 flex items-center gap-0.5"
                          title="Safely detach this runtime from its bound pairs"
                        >
                          <Unlink className="w-2.5 h-2.5" />
                          <span>Detach Pairs</span>
                        </button>
                      )}
                    </div>
                  </div>
                  {attachedPairs.length === 0 ? (
                    <div className="text-[11px] text-slate-500 italic">Unbound / Standalone</div>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {attachedPairs.map((p) => {
                        const isPlanner = p.plannerSessionId === session.id;
                        const isWorker = p.workerSessionId === session.id;
                        return (
                          <span
                            key={p.id}
                            className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-[10px] text-slate-300 flex items-center gap-1"
                          >
                            <span>{p.name}</span>
                            <span className="text-[9px] text-slate-500 font-mono">
                              ({isPlanner ? 'Plan' : ''}
                              {isPlanner && isWorker ? '/' : ''}
                              {isWorker ? 'Work' : ''})
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Telemetry and Process Info */}
                <div className="space-y-2 text-xs border-t border-slate-800 pt-3 text-slate-400">
                  <div className="flex justify-between">
                    <span>Application PID:</span>
                    <span className="font-mono text-slate-200">{session.applicationPid ?? 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Observation Failures:</span>
                    <span
                      className={`font-mono ${
                        session.consecutiveObservationFailures > 0
                          ? 'text-amber-400 font-bold'
                          : 'text-slate-200'
                      }`}
                    >
                      {session.consecutiveObservationFailures} / 3 max
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Last Observed:</span>
                    <span className="text-slate-300">
                      {session.lastObservedAt
                        ? new Date(session.lastObservedAt).toLocaleTimeString()
                        : 'Never'}
                    </span>
                  </div>
                  {session.archivedAt && (
                    <div className="flex justify-between text-amber-300/80">
                      <span>Archived At:</span>
                      <span>{new Date(session.archivedAt).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>

                {/* Bottom Controls */}
                <div className="flex items-center justify-between pt-2 border-t border-slate-800/80">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onOpenSessionDetail(session.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition-colors"
                      title="Open full session details"
                    >
                      <Info className="w-3.5 h-3.5" />
                      <span>Details</span>
                    </button>

                    <button
                      onClick={() => onInspectSession(session.id)}
                      disabled={session.status === 'archived'}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 text-xs transition-colors"
                      title="Probe Accessibility & Window State"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Probe State</span>
                    </button>

                    {session.lastEvidence && (
                      <button
                        onClick={() => onViewEvidence(session.lastEvidence!)}
                        className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Evidence</span>
                      </button>
                    )}

                    <button
                      onClick={() => onViewHistory(session.id, session.name)}
                      className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>History</span>
                    </button>
                  </div>

                  {/* Archive / Restore */}
                  {session.status === 'archived' ? (
                    <button
                      onClick={() => onUnarchiveSession(session.id)}
                      className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-emerald-400 transition-colors"
                      title="Restore Session"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => onArchiveSession(session.id)}
                      className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-amber-400 transition-colors"
                      title="Archive Session"
                    >
                      <Archive className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
