import React, { useState, useMemo } from 'react';
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
  Filter,
  ExternalLink,
  Copy,
  Check,
  Terminal,
  ShieldCheck,
  FolderGit2,
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
  const [showArchived, setShowArchived] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<'all' | ProviderType>('all');
  const [bindingFilter, setBindingFilter] = useState<'all' | 'attached' | 'unbound'>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Derive attached pairs map
  const attachedPairsMap = useMemo(() => {
    const map = new Map<string, UIPair[]>();
    for (const p of pairs) {
      if (p.plannerSessionId) {
        const list = map.get(p.plannerSessionId) || [];
        list.push(p);
        map.set(p.plannerSessionId, list);
      }
      if (p.workerSessionId && p.workerSessionId !== p.plannerSessionId) {
        const list = map.get(p.workerSessionId) || [];
        list.push(p);
        map.set(p.workerSessionId, list);
      }
    }
    return map;
  }, [pairs]);

  // Filtered session inventory
  const filteredSessions = useMemo(() => {
    return sessions.filter((s) => {
      // Archive filter
      if (!showArchived && s.status === 'archived') return false;
      if (showArchived && s.status !== 'archived') return false;

      // Provider filter
      if (providerFilter !== 'all' && s.providerType !== providerFilter) return false;

      // Binding filter
      const attached = (attachedPairsMap.get(s.id) || []).length > 0;
      if (bindingFilter === 'attached' && !attached) return false;
      if (bindingFilter === 'unbound' && attached) return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = s.name.toLowerCase().includes(q);
        const matchesExtId = s.externalSessionId?.toLowerCase().includes(q);
        const matchesProject = s.externalProjectRef?.toLowerCase().includes(q);
        const matchesWindow = s.windowTitle?.toLowerCase().includes(q);
        const matchesProvider = s.providerType.toLowerCase().includes(q);
        if (!matchesName && !matchesExtId && !matchesProject && !matchesWindow && !matchesProvider) {
          return false;
        }
      }

      return true;
    });
  }, [sessions, showArchived, providerFilter, bindingFilter, searchQuery, attachedPairsMap]);

  // Inventory metric summary
  const metrics = useMemo(() => {
    const nonArchived = sessions.filter((s) => s.status !== 'archived');
    const attachedCount = nonArchived.filter((s) => (attachedPairsMap.get(s.id) || []).length > 0).length;
    const workingCount = nonArchived.filter((s) => s.status === 'working').length;
    const availableCount = nonArchived.filter((s) => s.status === 'available' || s.status === 'idle').length;
    const archivedCount = sessions.filter((s) => s.status === 'archived').length;

    return {
      total: nonArchived.length,
      attached: attachedCount,
      unbound: nonArchived.length - attachedCount,
      working: workingCount,
      available: availableCount,
      archived: archivedCount,
    };
  }, [sessions, attachedPairsMap]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'available':
      case 'idle':
        return (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            ● Available
          </span>
        );
      case 'working':
        return (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse">
            ● Working
          </span>
        );
      case 'suspended':
        return (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            ● Suspended
          </span>
        );
      case 'archived':
        return (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-slate-800 text-slate-400 border border-slate-700">
            Archived
          </span>
        );
      default:
        return (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
            ● Unavailable
          </span>
        );
    }
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Cpu className="w-5 h-5 text-emerald-400" />
            <span>Runtime Sessions Inventory</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Authoritative external AI sessions, observable evidence, and pair attachment governance
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
            <span>{showArchived ? 'Showing Archived' : `Archived (${metrics.archived})`}</span>
          </button>

          <button
            onClick={onOpenDiscover}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md transition-colors"
          >
            <Search className="w-3.5 h-3.5" />
            <span>Integrations &amp; Discovery</span>
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

      {/* Inventory Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-slate-400 block text-[11px]">Total Active Sessions</span>
            <span className="text-lg font-bold text-slate-100">{metrics.total}</span>
          </div>
          <Cpu className="w-4 h-4 text-emerald-400 opacity-60" />
        </div>
        <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-slate-400 block text-[11px]">Attached to Pairs</span>
            <span className="text-lg font-bold text-blue-400">{metrics.attached}</span>
          </div>
          <Layers className="w-4 h-4 text-blue-400 opacity-60" />
        </div>
        <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-slate-400 block text-[11px]">Unbound / Available</span>
            <span className="text-lg font-bold text-slate-300">{metrics.unbound}</span>
          </div>
          <Unlink className="w-4 h-4 text-slate-400 opacity-60" />
        </div>
        <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-slate-400 block text-[11px]">Active Working</span>
            <span className="text-lg font-bold text-amber-400">{metrics.working}</span>
          </div>
          <RefreshCw className="w-4 h-4 text-amber-400 opacity-60" />
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
        <div className="relative flex-1 w-full sm:w-auto">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by title, session ID (ses_*), path, or provider…"
            className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 text-xs"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500 text-[11px]">Provider:</span>
            <select
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value as any)}
              className="px-2 py-1 rounded bg-slate-950 border border-slate-800 text-slate-300 text-xs"
            >
              <option value="all">All Providers</option>
              <option value="chatgpt">ChatGPT</option>
              <option value="opencode">OpenCode</option>
              <option value="vscode">VS Code</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-slate-500 text-[11px]">Binding:</span>
            <select
              value={bindingFilter}
              onChange={(e) => setBindingFilter(e.target.value as any)}
              className="px-2 py-1 rounded bg-slate-950 border border-slate-800 text-slate-300 text-xs"
            >
              <option value="all">All States</option>
              <option value="attached">Attached Only</option>
              <option value="unbound">Unbound Only</option>
            </select>
          </div>
        </div>
      </div>

      {/* Sessions Grid */}
      {filteredSessions.length === 0 ? (
        <div className="p-10 rounded-xl bg-slate-900 border border-slate-800 text-center space-y-3">
          <Cpu className="w-8 h-8 text-slate-600 mx-auto" />
          <h3 className="text-sm font-semibold text-slate-300">
            {showArchived
              ? 'No Archived Runtime Sessions'
              : sessions.length === 0
              ? 'No Runtime Sessions Registered'
              : 'No Sessions Matching Current Filters'}
          </h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            {sessions.length === 0
              ? 'Probe provider integrations to adopt discovered external sessions or register concrete session identities.'
              : 'Try clearing your search query or reset the provider and binding filters.'}
          </p>
          {sessions.length === 0 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={onOpenDiscover}
                className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
              >
                Integrations &amp; Discovery
              </button>
              <button
                onClick={onOpenRegister}
                className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium"
              >
                Register Session
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredSessions.map((session) => {
            const attachedPairs = attachedPairsMap.get(session.id) || [];
            const isAttached = attachedPairs.length > 0;
            const hasAuthoritativeIdentity = Boolean(session.externalSessionId);

            return (
              <div
                key={session.id}
                className={`rx-card p-5 rounded-xl bg-slate-900 border flex flex-col justify-between space-y-4 shadow-sm transition-all ${
                  session.status === 'archived' ? 'border-slate-800/60 opacity-80' : 'border-slate-800'
                }`}
              >
                <div className="space-y-3">
                  {/* Top Badges — identity region + status region */}
                  <div className="rx-card-header">
                    <div className="rx-card-region rx-card-region-wrap">
                      <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-semibold">
                        {session.providerType}
                      </span>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded border font-medium ${
                          hasAuthoritativeIdentity
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                            : 'bg-slate-800 text-slate-400 border-slate-700'
                        }`}
                      >
                        {hasAuthoritativeIdentity ? 'Registered Identity' : 'Observed Probe'}
                      </span>
                    </div>

                    <div className="rx-card-region">
                      {getStatusBadge(session.status)}
                    </div>
                  </div>

                  {/* Title & Detail Trigger */}
                  <div>
                    <button
                      type="button"
                      onClick={() => onOpenSessionDetail(session.id)}
                      className="text-sm font-bold text-slate-100 hover:text-blue-300 text-left transition-colors truncate block max-w-full"
                      title="Open session details"
                    >
                      {session.name}
                    </button>
                    {session.status === 'archived' && session.archiveReason && (
                      <div className="mt-1 p-2 rounded bg-amber-500/5 border border-amber-500/10 text-[10px] text-amber-200/80 italic">
                        Reason: {session.archiveReason}
                      </div>
                    )}
                  </div>

                  {/* Concrete Identity Display */}
                  <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-850 space-y-1 text-xs">
                    <div className="rx-card-header text-slate-400 text-[10px]">
                      <span className="font-semibold uppercase tracking-wider">Concrete Session ID</span>
                      {session.externalSessionId && (
                        <button
                          type="button"
                          onClick={() => copyToClipboard(session.externalSessionId!)}
                          className="hover:text-slate-200 flex items-center gap-0.5"
                          title="Copy session ID"
                        >
                          {copiedId === session.externalSessionId ? (
                            <Check className="w-2.5 h-2.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-2.5 h-2.5" />
                          )}
                          <span>{copiedId === session.externalSessionId ? 'Copied' : 'Copy'}</span>
                        </button>
                      )}
                    </div>
                    {session.externalSessionId ? (
                      <div className="font-mono text-emerald-400 text-[11px] truncate select-all" title={session.externalSessionId}>
                        {session.externalSessionId}
                      </div>
                    ) : (
                      <div className="text-slate-500 text-[11px] italic">
                        Unbound external ID (Pending concrete adoption)
                      </div>
                    )}

                    {session.externalProjectRef && (
                      <div className="pt-1 border-t border-slate-900 text-[10px] text-slate-400 truncate flex items-center gap-1">
                        <FolderGit2 className="w-3 h-3 text-slate-500 shrink-0" />
                        <span className="font-mono truncate" title={session.externalProjectRef}>
                          {session.externalProjectRef}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Attached Pairs Info */}
                <div className="space-y-1.5 border-t border-slate-800 pt-3">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="flex items-center gap-1 text-[11px] font-medium text-slate-300">
                      <Layers className="w-3 h-3 text-blue-400" />
                      Pair Bindings ({attachedPairs.length}):
                    </span>
                    <div className="flex items-center gap-2">
                      {session.status !== 'archived' && (
                        <button
                          onClick={() => onAttachToPair(session.id)}
                          className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-0.5 font-medium"
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
                          <span>Detach</span>
                        </button>
                      )}
                    </div>
                  </div>
                  {attachedPairs.length === 0 ? (
                    <div className="text-[11px] text-slate-500 italic flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-600"></span>
                      <span>Unbound / Available for Assignment</span>
                    </div>
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
                            <span className="text-[9px] text-blue-400 font-mono">
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

                {/* Process and Observation Telemetry */}
                <div className="space-y-1.5 text-[11px] border-t border-slate-800 pt-2.5 text-slate-400">
                  <div className="flex justify-between">
                    <span>Host PID:</span>
                    <span className="font-mono text-slate-200">{session.applicationPid ?? 'Running'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Last Observed:</span>
                    <span className="text-slate-300">
                      {session.lastObservedAt
                        ? new Date(session.lastObservedAt).toLocaleTimeString()
                        : 'Never'}
                    </span>
                  </div>
                </div>

                {/* Bottom Action Controls
                    One action region (header/content region not involved here).
                    The primary group may wrap as a unit when the card is too
                    narrow; the archive/restore control stays a single nowrap
                    region so it is never stranded on its own row. */}
                <div className="rx-card-header pt-2.5 border-t border-slate-800">
                  <div className="rx-action-group rx-action-group-wrap gap-1.5">
                    <button
                      onClick={() => onOpenSessionDetail(session.id)}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-slate-850 hover:bg-slate-750 text-slate-200 text-[11px] transition-colors"
                      title="Open full session details"
                    >
                      <Info className="w-3 h-3 text-slate-400" />
                      <span>Details</span>
                    </button>

                    <button
                      onClick={() => onInspectSession(session.id)}
                      disabled={session.status === 'archived'}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-slate-850 hover:bg-slate-750 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 text-[11px] transition-colors"
                      title="Probe Accessibility & Window State"
                    >
                      <RefreshCw className="w-3 h-3 text-emerald-400" />
                      <span>Probe</span>
                    </button>

                    {session.lastEvidence && (
                      <button
                        onClick={() => onViewEvidence(session.lastEvidence!)}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-slate-850 hover:bg-slate-750 text-blue-300 text-[11px] transition-colors"
                        title="View raw observation evidence"
                      >
                        <Eye className="w-3 h-3 text-blue-400" />
                        <span>Evidence</span>
                      </button>
                    )}

                    <button
                      onClick={() => onViewHistory(session.id, session.name)}
                      className="flex items-center gap-1 px-2 py-1 rounded bg-slate-850 hover:bg-slate-750 text-slate-300 text-[11px] transition-colors"
                      title="View session observation history"
                    >
                      <RotateCcw className="w-3 h-3 text-slate-400" />
                      <span>History</span>
                    </button>
                  </div>

                  {/* Archive / Restore */}
                  <div className="rx-action-region shrink-0">
                    {session.status === 'archived' ? (
                      <button
                        onClick={() => onUnarchiveSession(session.id)}
                        className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-emerald-400 transition-colors"
                        title="Restore Session"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => onArchiveSession(session.id)}
                        className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-amber-400 transition-colors"
                        title="Archive Session"
                      >
                        <Archive className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
