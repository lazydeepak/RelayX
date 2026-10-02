import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  Eye,
  Filter,
  Search,
  Archive,
  RefreshCw,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Clock,
  ShieldAlert,
  AlertTriangle,
  Info,
  CheckCircle,
  Copy,
  Layers,
  FileText,
} from 'lucide-react';
import { UIEvent, ObservableEvidence, UIActivityRecord } from '../types/ui.ts';
import { relayBridge } from '../services/relayBridge.ts';
import { EventFilterOptions } from '../relay/domain/types.ts';

interface EventsTimelineViewProps {
  events?: UIEvent[];
  initialResourceId?: string;
  onClearInitialResourceId?: () => void;
  onViewEvidence: (ev: ObservableEvidence) => void;
  onNotify?: (msg: string) => void;
}

type ViewMode = 'activities' | 'events' | 'archived';

export const EventsTimelineView: React.FC<EventsTimelineViewProps> = ({
  events: initialEvents,
  initialResourceId,
  onClearInitialResourceId,
  onViewEvidence,
  onNotify,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('events');
  const [loading, setLoading] = useState(false);

  // Filter state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [resourceType, setResourceType] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [actorFilter, setActorFilter] = useState<string>('all');
  const [resourceIdFilter, setResourceIdFilter] = useState<string>(initialResourceId || '');

  // Pagination state
  const [pageSize, setPageSize] = useState<number>(25);
  const [page, setPage] = useState<number>(0);
  const [totalItems, setTotalItems] = useState<number>(0);

  // Data state
  const [eventsList, setEventsList] = useState<UIEvent[]>(initialEvents || []);
  const [activitiesList, setActivitiesList] = useState<UIActivityRecord[]>([]);

  // Expanded row details
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Archive & Clear log state
  const [archiveResultMsg, setArchiveResultMsg] = useState<string | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);
  const [clearOption, setClearOption] = useState<'archived_only' | 'older_30d'>('archived_only');
  const [clearAuxLogs, setClearAuxLogs] = useState<boolean>(false);
  const [isClearing, setIsClearing] = useState(false);

  // Sync initial resource ID if provided from parent (e.g., Attention view navigation)
  useEffect(() => {
    if (initialResourceId) {
      setResourceIdFilter(initialResourceId);
      setViewMode('events');
      setPage(0);
    }
  }, [initialResourceId]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (viewMode === 'activities') {
        const list = await relayBridge.listActivities(100);
        let filtered = list;
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          filtered = filtered.filter(
            (a) =>
              a.title.toLowerCase().includes(q) ||
              a.summary.toLowerCase().includes(q) ||
              a.resourceId.toLowerCase().includes(q) ||
              (a.correlationId && a.correlationId.toLowerCase().includes(q))
          );
        }
        if (resourceType !== 'all') {
          filtered = filtered.filter((a) => a.resourceType === resourceType);
        }
        if (resourceIdFilter) {
          filtered = filtered.filter((a) => a.resourceId === resourceIdFilter);
        }
        setTotalItems(filtered.length);
        const offset = page * pageSize;
        setActivitiesList(filtered.slice(offset, offset + pageSize));
      } else {
        const filterOpts: EventFilterOptions = {
          limit: pageSize,
          offset: page * pageSize,
          isArchived: viewMode === 'archived',
        };

        if (searchQuery.trim()) filterOpts.search = searchQuery.trim();
        if (resourceType !== 'all') filterOpts.resourceType = resourceType;
        if (severityFilter !== 'all') filterOpts.severity = severityFilter;
        if (actorFilter !== 'all') filterOpts.actor = actorFilter;
        if (resourceIdFilter.trim()) filterOpts.resourceId = resourceIdFilter.trim();

        const res = await relayBridge.queryEvents(filterOpts);
        setEventsList(res.events);
        setTotalItems(res.total);
      }
    } catch (err: any) {
      console.error('Failed to load observability data:', err);
    } finally {
      setLoading(false);
    }
  }, [viewMode, searchQuery, resourceType, severityFilter, actorFilter, resourceIdFilter, page, pageSize]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRunArchiveCycle = async () => {
    setIsArchiving(true);
    setArchiveResultMsg(null);
    try {
      const res = await relayBridge.runArchiveCycle();
      const msg =
        res.interval === 'none'
          ? 'Archival policy is set to "Retain Indefinitely". No events were archived.'
          : `Archival cycle completed: ${res.archivedCount} events archived (Retention: ${res.interval})`;
      setArchiveResultMsg(msg);
      if (onNotify) onNotify(msg);
      await loadData();
      setTimeout(() => setArchiveResultMsg(null), 5000);
    } catch (err: any) {
      const errStr = `Archive cycle failed: ${err.message}`;
      setArchiveResultMsg(errStr);
      if (onNotify) onNotify(errStr);
    } finally {
      setIsArchiving(false);
    }
  };

  const handleExecuteSafeClear = async () => {
    setIsClearing(true);
    try {
      let beforeTimestamp: number | undefined;
      if (clearOption === 'older_30d') {
        beforeTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
      }
      const res = await relayBridge.clearLogs({
        includeArchived: false, // SAFE: Only clear archived events
        beforeTimestamp,
        clearAuxiliaryLogs: clearAuxLogs,
      });

      const msg = `Safe log clear successful: ${res.clearedCount} archived events purged (${res.remainingCount} active events preserved).`;
      if (onNotify) onNotify(msg);
      setShowClearModal(false);
      await loadData();
    } catch (err: any) {
      if (onNotify) onNotify(`Clear logs failed: ${err.message}`);
    } finally {
      setIsClearing(false);
    }
  };

  const copyToClipboard = (text: string, label = 'Copied') => {
    navigator.clipboard.writeText(text);
    if (onNotify) onNotify(`${label} to clipboard`);
  };

  const totalPages = Math.ceil(totalItems / pageSize) || 1;

  const renderSeverityBadge = (sev?: string) => {
    switch (sev) {
      case 'critical':
      case 'error':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-950/80 border border-red-800 text-red-300">
            <ShieldAlert className="w-2.5 h-2.5" />
            <span>{sev}</span>
          </span>
        );
      case 'warn':
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-950/80 border border-amber-800 text-amber-300">
            <AlertTriangle className="w-2.5 h-2.5" />
            <span>warn</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
            <Info className="w-2.5 h-2.5" />
            <span>info</span>
          </span>
        );
    }
  };

  return (
    <div className="space-y-6 text-xs">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-400" />
            <span>Observability & Lineage</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Immutable audit trail, real-time activity projection, and historical archival lineage
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 transition-colors"
            title="Refresh current lineage query"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            onClick={handleRunArchiveCycle}
            disabled={isArchiving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-950/60 hover:bg-indigo-900/80 border border-indigo-700/60 text-indigo-300 font-medium transition-colors"
            title="Trigger archive rotation based on configured retention policy"
          >
            <Archive className="w-3.5 h-3.5" />
            <span>{isArchiving ? 'Archiving...' : 'Run Archive Cycle'}</span>
          </button>

          <button
            onClick={() => setShowClearModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-red-950/40 border border-slate-700 hover:border-red-800/60 text-slate-300 hover:text-red-300 transition-colors"
            title="Safe log maintenance: clear eligible archived events"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Safe Clear Logs</span>
          </button>
        </div>
      </div>

      {archiveResultMsg && (
        <div className="p-3 rounded-lg bg-indigo-950/40 border border-indigo-800/60 text-indigo-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Archive className="w-4 h-4 text-indigo-400 shrink-0" />
            <span>{archiveResultMsg}</span>
          </div>
          <button onClick={() => setArchiveResultMsg(null)} className="text-slate-400 hover:text-slate-200">
            ×
          </button>
        </div>
      )}

      {/* Mode Navigation Tabs */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => {
              setViewMode('events');
              setPage(0);
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all ${
              viewMode === 'events'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Active Event Stream</span>
          </button>

          <button
            onClick={() => {
              setViewMode('activities');
              setPage(0);
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all ${
              viewMode === 'activities'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Activity Projection</span>
          </button>

          <button
            onClick={() => {
              setViewMode('archived');
              setPage(0);
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-all ${
              viewMode === 'archived'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Archive className="w-3.5 h-3.5" />
            <span>Archived Event Browser</span>
          </button>
        </div>

        <div className="text-xs text-slate-400">
          Total matched: <strong className="text-slate-200">{totalItems}</strong>
        </div>
      </div>

      {/* Filter and Query Controls Bar */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {/* Search Query */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search event type, ID, actor, key..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(0);
              }}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Resource Type Filter */}
          <select
            value={resourceType}
            onChange={(e) => {
              setResourceType(e.target.value);
              setPage(0);
            }}
            className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
          >
            <option value="all">All Resource Types</option>
            <option value="delivery">Deliveries</option>
            <option value="assignment">Assignments</option>
            <option value="pair">Pairs</option>
            <option value="project">Projects</option>
            <option value="runtime">Runtime Sessions</option>
            <option value="handoff">Handoffs</option>
            <option value="checkpoint">Checkpoints</option>
            <option value="attention">Attention</option>
          </select>

          {/* Severity Filter (only for events and archived) */}
          {viewMode !== 'activities' && (
            <select
              value={severityFilter}
              onChange={(e) => {
                setSeverityFilter(e.target.value);
                setPage(0);
              }}
              className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value="all">All Severities</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
              <option value="critical">Critical</option>
            </select>
          )}

          {/* Actor Filter */}
          {viewMode !== 'activities' && (
            <select
              value={actorFilter}
              onChange={(e) => {
                setActorFilter(e.target.value);
                setPage(0);
              }}
              className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value="all">All Actors</option>
              <option value="user">User</option>
              <option value="engine">Engine</option>
              <option value="supervisor">Supervisor</option>
              <option value="reconciler">Reconciler</option>
              <option value="recovery">Recovery</option>
              <option value="provider">Provider</option>
            </select>
          )}
        </div>

        {/* Resource ID filter banner if active */}
        {resourceIdFilter && (
          <div className="flex items-center justify-between p-2 rounded-lg bg-blue-950/40 border border-blue-900/60 text-blue-200">
            <span className="flex items-center gap-2">
              <Filter className="w-3.5 h-3.5 text-blue-400" />
              <span>
                Filtered by Resource ID: <strong className="font-mono text-white">{resourceIdFilter}</strong>
              </span>
            </span>
            <button
              onClick={() => {
                setResourceIdFilter('');
                if (onClearInitialResourceId) onClearInitialResourceId();
              }}
              className="text-xs text-blue-400 hover:text-blue-200 font-semibold underline"
            >
              Clear filter
            </button>
          </div>
        )}
      </div>

      {/* Main Table / Lineage Cards */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        {viewMode === 'activities' ? (
          /* Activity Projection View */
          <div className="divide-y divide-slate-800">
            {activitiesList.length === 0 ? (
              <div className="p-12 text-center text-slate-500">
                No projected activity records matched your criteria.
              </div>
            ) : (
              activitiesList.map((act) => (
                <div key={act.id} className="p-4 hover:bg-slate-800/40 transition-colors space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                          act.status === 'completed'
                            ? 'bg-emerald-400'
                            : act.status === 'failed'
                            ? 'bg-red-400'
                            : act.status === 'warning'
                            ? 'bg-amber-400'
                            : act.status === 'in_progress'
                            ? 'bg-blue-400 animate-pulse'
                            : 'bg-slate-400'
                        }`}
                      />
                      <span className="font-semibold text-slate-100 text-sm">{act.title}</span>
                      <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                        {act.category}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 text-slate-400 font-mono text-[11px]">
                      <span>{new Date(act.timestamp).toLocaleTimeString()}</span>
                      <span>•</span>
                      <span>{new Date(act.timestamp).toLocaleDateString()}</span>
                    </div>
                  </div>

                  <p className="text-slate-300 pl-5">{act.summary}</p>

                  <div className="flex flex-wrap items-center gap-4 pl-5 pt-1 text-[11px] text-slate-400">
                    <span>
                      Target: <span className="font-mono text-slate-200">{act.resourceType}:{act.resourceId}</span>
                    </span>
                    {act.correlationId && (
                      <span>
                        Correlation: <span className="font-mono text-slate-300">{act.correlationId}</span>
                      </span>
                    )}
                    {act.evidence && (
                      <button
                        onClick={() => onViewEvidence(act.evidence!)}
                        className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 font-medium"
                      >
                        <Eye className="w-3 h-3" />
                        <span>Inspect Evidence</span>
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          /* Events Stream & Archive Browser View */
          <div className="divide-y divide-slate-800">
            {eventsList.length === 0 ? (
              <div className="p-12 text-center text-slate-500">
                {viewMode === 'archived'
                  ? 'No archived events found. Active events rotate to archive when retention policy expires or on archive cycle.'
                  : 'No active lineage events match the current query.'}
              </div>
            ) : (
              eventsList.map((evt) => (
                <div key={evt.id} className="p-4 hover:bg-slate-800/40 transition-colors space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div
                        className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${
                          evt.isArchived
                            ? 'bg-slate-500'
                            : evt.severity === 'critical' || evt.severity === 'error'
                            ? 'bg-red-500'
                            : evt.severity === 'warn'
                            ? 'bg-amber-500'
                            : 'bg-blue-500'
                        }`}
                      />
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-slate-100">{evt.eventType}</span>
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                            {evt.resourceType}
                          </span>
                          {renderSeverityBadge(evt.severity)}
                          {evt.isArchived && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-950/80 border border-indigo-800 text-indigo-300">
                              Archived
                            </span>
                          )}
                          {evt.area && evt.area !== evt.resourceType && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-400 font-mono">
                              area:{evt.area}
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-3 mt-1.5 text-slate-400 text-[11px]">
                          <span>
                            Resource ID:{' '}
                            <button
                              onClick={() => {
                                setResourceIdFilter(evt.resourceId);
                                setPage(0);
                              }}
                              className="font-mono text-slate-300 hover:text-blue-300 underline"
                              title="Filter exclusively by this resource"
                            >
                              {evt.resourceId}
                            </button>
                          </span>
                          <span>•</span>
                          <span>
                            Actor: <strong className="text-slate-200">{evt.actor}</strong>
                          </span>
                          {evt.correlationId && (
                            <>
                              <span>•</span>
                              <span>
                                Correlation Key:{' '}
                                <span className="font-mono text-slate-300">{evt.correlationId}</span>
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0 self-end sm:self-center">
                      {evt.evidence && (
                        <button
                          onClick={() => onViewEvidence(evt.evidence!)}
                          className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-blue-400 text-xs transition-colors"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Inspect Evidence</span>
                        </button>
                      )}

                      <button
                        onClick={() => setExpandedId(expandedId === evt.id ? null : evt.id)}
                        className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
                        title="Toggle JSON details"
                      >
                        {expandedId === evt.id ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </button>

                      <span className="text-slate-400 font-mono text-[11px] min-w-[70px] text-right">
                        {new Date(evt.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>

                  {/* Expanded JSON details */}
                  {expandedId === evt.id && (
                    <div className="pl-6 pt-2">
                      <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-300 relative group overflow-x-auto">
                        <button
                          onClick={() => copyToClipboard(JSON.stringify(evt, null, 2), 'Event payload copied')}
                          className="absolute right-2 top-2 p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
                          title="Copy raw JSON"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <pre>{JSON.stringify(evt, null, 2)}</pre>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Pagination Footer */}
        <div className="p-3 bg-slate-950 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-slate-400">
            <span>Rows per page:</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
              className="px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            <span>
              Showing {totalItems === 0 ? 0 : page * pageSize + 1} -{' '}
              {Math.min((page + 1) * pageSize, totalItems)} of {totalItems}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0 || loading}
              className="p-1.5 rounded-lg border border-slate-800 hover:bg-slate-800 text-slate-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              title="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-slate-400 px-2 font-mono">
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1 || loading}
              className="p-1.5 rounded-lg border border-slate-800 hover:bg-slate-800 text-slate-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              title="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Safe Clear Logs Confirmation Modal */}
      {showClearModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl text-xs">
            <div className="flex items-center gap-2.5 text-slate-100 font-bold text-sm">
              <Trash2 className="w-5 h-5 text-red-400" />
              <span>Safe Maintenance: Clear Logs</span>
            </div>

            <p className="text-slate-300">
              Safe Clear guarantees that active audit lineage and un-archived events remain strictly preserved. Only
              events already marked as archived are purged.
            </p>

            <div className="space-y-2 pt-2 border-t border-slate-800">
              <label className="flex items-center gap-2.5 p-2 rounded-lg bg-slate-950 border border-slate-800 cursor-pointer">
                <input
                  type="radio"
                  name="clear_option"
                  checked={clearOption === 'archived_only'}
                  onChange={() => setClearOption('archived_only')}
                  className="text-blue-600 focus:ring-0"
                />
                <div>
                  <span className="font-semibold text-slate-200 block">Purge All Archived Events</span>
                  <span className="text-[11px] text-slate-400">Deletes events marked archived (active audit trail is kept).</span>
                </div>
              </label>

              <label className="flex items-center gap-2.5 p-2 rounded-lg bg-slate-950 border border-slate-800 cursor-pointer">
                <input
                  type="radio"
                  name="clear_option"
                  checked={clearOption === 'older_30d'}
                  onChange={() => setClearOption('older_30d')}
                  className="text-blue-600 focus:ring-0"
                />
                <div>
                  <span className="font-semibold text-slate-200 block">Purge Archived Older Than 30 Days</span>
                  <span className="text-[11px] text-slate-400">Preserves recent archive history for investigation.</span>
                </div>
              </label>

              <label className="flex items-center gap-2.5 p-2 rounded-lg bg-slate-950 border border-slate-800 cursor-pointer mt-2">
                <input
                  type="checkbox"
                  checked={clearAuxLogs}
                  onChange={(e) => setClearAuxLogs(e.target.checked)}
                  className="text-blue-600 rounded focus:ring-0"
                />
                <div>
                  <span className="font-semibold text-slate-200 block">Also Clear Auxiliary Trace Logs</span>
                  <span className="text-[11px] text-slate-400">Truncates bootstrap-trace.log & opencode-c2-trace.log to 0 bytes.</span>
                </div>
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
              <button
                onClick={() => setShowClearModal(false)}
                disabled={isClearing}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleExecuteSafeClear}
                disabled={isClearing}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{isClearing ? 'Clearing...' : 'Confirm Safe Clear'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
