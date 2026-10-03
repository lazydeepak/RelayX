import React, { useState } from 'react';
import { ListTodo, CheckCircle2, Clock, AlertTriangle, ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import { UIAssignment } from '../types/ui.ts';
import { relayBridge } from '../services/relayBridge.ts';

interface AssignmentsViewProps {
  assignments: UIAssignment[];
  filterStatuses?: string[];
}

export const AssignmentsView: React.FC<AssignmentsViewProps> = ({ assignments, filterStatuses }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const filtered = filterStatuses
    ? assignments.filter((a) => filterStatuses.includes(a.status))
    : assignments;

  const handleSelect = async (id: string) => {
    if (selectedId === id) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    setSelectedId(id);
    setLoadingDetail(true);
    try {
      const data = await relayBridge.getAssignmentDetail(id);
      setDetail(data);
    } catch (err) {
      setDetail({ error: String(err) });
    } finally {
      setLoadingDetail(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <ListTodo className="w-5 h-5 text-blue-400" />
            <span>Assignments & Attempts</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Task execution units delegated from Planner to Worker runtimes
          </p>
        </div>
        {filterStatuses && (
          <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/20 font-medium">
            Filter: current / running
          </span>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="p-8 rounded-xl bg-slate-900 border border-slate-800 text-center space-y-3">
          <ListTodo className="w-8 h-8 text-slate-600 mx-auto" />
          <h3 className="text-sm font-semibold text-slate-300">No Matching Assignments</h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            {filterStatuses ? 'No assignments match the running/current filter.' : 'Dispatched assignments and worker attempt tracking will appear here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((asgn) => (
            <div key={asgn.id} className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden">
              <button
                onClick={() => handleSelect(asgn.id)}
                className="w-full text-left p-5 hover:bg-slate-800/50 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                aria-expanded={selectedId === asgn.id}
                aria-controls={`assignment-detail-${asgn.id}`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                        {asgn.pairName}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-500 font-mono">{asgn.id.slice(0, 8)}</span>
                    </div>
                    <h3 className="text-sm font-bold text-slate-100 truncate">{asgn.title}</h3>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-500">
                      <span>Source: <span className="text-slate-300 capitalize">{asgn.source ?? 'unknown'}</span></span>
                      <span>•</span>
                      <span>Role: <span className="text-slate-300">{asgn.targetSideRole ?? 'worker'}</span></span>
                      <span>•</span>
                      <span>Updated: {asgn.updatedAt ? new Date(asgn.updatedAt).toLocaleString() : '—'}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`text-xs px-2.5 py-0.5 rounded-full font-semibold capitalize ${
                        asgn.status === 'completed'
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : asgn.status === 'active'
                          ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse'
                          : asgn.status === 'waiting_for_handoff'
                          ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                          : asgn.status === 'failed'
                          ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {asgn.status.replace(/_/g, ' ')}
                    </span>
                    <span className="text-slate-600">
                      {selectedId === asgn.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </span>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
                    Pair State: <strong className="text-slate-200">{asgn.pairStatus ?? '—'}</strong>
                    {asgn.pairOperationalState && (
                      <span className="text-[10px] text-slate-500">({asgn.pairOperationalState})</span>
                    )}
                  </span>
                  {asgn.currentAttemptStatus && (
                    <span className="inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                      Attempt: <strong className="text-slate-200">{asgn.currentAttemptStatus}</strong>
                      {asgn.currentAttemptNumber !== undefined && (
                        <span className="text-[10px] text-slate-500">#{asgn.currentAttemptNumber}</span>
                      )}
                    </span>
                  )}
                  {asgn.deliveryStatus && (
                    <span className="inline-flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${asgn.deliveryStatus === 'delivered' ? 'bg-emerald-400' : asgn.deliveryStatus === 'ambiguous' ? 'bg-amber-400' : asgn.deliveryStatus === 'failed' ? 'bg-red-400' : 'bg-slate-500'}`} />
                      Delivery: <strong className="text-slate-200">{asgn.deliveryStatus}</strong>
                    </span>
                  )}
                  {asgn.blockerReason && (
                    <span className="text-amber-300 font-medium truncate max-w-[200px] sm:max-w-xs" title={asgn.blockerReason}>
                      Blocked: {asgn.blockerReason}
                    </span>
                  )}
                  {asgn.attentionStatus && (
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${asgn.attentionStatus === 'open' ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20' : 'bg-slate-800 text-slate-400'}`}>
                      Attention: {asgn.attentionStatus}
                      {asgn.attentionCount && asgn.attentionCount > 0 && ` (${asgn.attentionCount})`}
                    </span>
                  )}
                </div>
              </button>

              {/* Detail / History Panel */}
              {selectedId === asgn.id && (
                <div id={`assignment-detail-${asgn.id}`} className="border-t border-slate-800 bg-slate-950/30 p-5 space-y-4 animate-fade-in">
                  {loadingDetail ? (
                    <p className="text-xs text-slate-500">Loading history...</p>
                  ) : detail && detail.error ? (
                    <p className="text-xs text-red-400">Error loading detail: {detail.error}</p>
                  ) : detail ? (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                        <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-1">
                          <h4 className="font-semibold text-slate-200">Assignment</h4>
                          <p className="text-slate-400">Status: <span className="text-slate-200 font-medium capitalize">{detail.assignment.status}</span></p>
                          <p className="text-slate-400">Source: <span className="text-slate-200 capitalize">{detail.assignment.source}</span></p>
                          <p className="text-slate-400">Role: <span className="text-slate-200">{detail.assignment.targetSideRole}</span></p>
                        </div>
                        <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-1">
                          <h4 className="font-semibold text-slate-200">Pair</h4>
                          <p className="text-slate-400">Name: <span className="text-slate-200">{detail.pair?.name ?? '—'}</span></p>
                          <p className="text-slate-400">Status: <span className="text-slate-200 capitalize">{detail.pair?.status ?? '—'}</span></p>
                          <p className="text-slate-400">Operational: <span className="text-slate-200">{detail.pair?.operationalState ?? '—'}</span></p>
                          <p className="text-slate-400">Relay: <span className="text-slate-200">{detail.pair?.relayState ?? '—'}</span></p>
                        </div>
                        <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-1">
                          <h4 className="font-semibold text-slate-200">Timing</h4>
                          <p className="text-slate-400">Created: <span className="text-slate-200">{new Date(detail.assignment.createdAt).toLocaleString()}</span></p>
                          <p className="text-slate-400">Updated: <span className="text-slate-200">{detail.assignment.updatedAt ? new Date(detail.assignment.updatedAt).toLocaleString() : '—'}</span></p>
                        </div>
                      </div>

                      {detail.assignment.currentAttemptStatus && (
                        <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs space-y-2">
                          <h4 className="font-semibold text-slate-200">Current Attempt</h4>
                          <div className="flex flex-wrap gap-4 text-slate-400">
                            <span>Number: <strong className="text-slate-200">{detail.assignment.currentAttemptNumber ?? '—'}</strong></span>
                            <span>Status: <strong className="text-slate-200 capitalize">{detail.assignment.currentAttemptStatus ?? '—'}</strong></span>
                            <span>Started: <strong className="text-slate-200">{detail.assignment.currentAttemptStartedAt ? new Date(detail.assignment.currentAttemptStartedAt).toLocaleString() : '—'}</strong></span>
                          </div>
                          {detail.attempts && detail.attempts.length > 0 && (
                            <div className="mt-2 space-y-1">
                              <h5 className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Historical Attempts</h5>
                              {detail.attempts.map((att: any) => (
                                <div key={att.id} className="flex items-center justify-between px-2 py-1 rounded bg-slate-950 border border-slate-800/60 text-[11px]">
                                  <span className="text-slate-300">Attempt #{att.attemptNumber}</span>
                                  <span className={`capitalize ${att.status === 'interrupted' ? 'text-red-400' : att.status === 'running' ? 'text-blue-400' : 'text-slate-400'}`}>{att.status}</span>
                                  <span className="text-slate-500">{new Date(att.startedAt).toLocaleString()}</span>
                                  {att.failureReason && <span className="text-red-300 truncate max-w-[120px]" title={att.failureReason}>Reason: {att.failureReason}</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {detail.deliveries && detail.deliveries.length > 0 && (
                        <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs space-y-2">
                          <h4 className="font-semibold text-slate-200">Deliveries</h4>
                          <div className="space-y-1">
                            {detail.deliveries.map((d: any) => (
                              <div key={d.id} className="flex items-center justify-between px-2 py-1 rounded bg-slate-950 border border-slate-800/60 text-[11px]">
                                <span className="text-slate-300 truncate max-w-[140px]">{d.instructionSnippet}</span>
                                <span className={`capitalize font-medium ${d.status === 'delivered' ? 'text-emerald-400' : d.status === 'ambiguous' ? 'text-amber-400' : d.status === 'failed' ? 'text-red-400' : 'text-slate-400'}`}>{d.status}</span>
                                <span className="text-slate-500">{new Date(d.createdAt).toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {detail.handoffs && detail.handoffs.length > 0 && (
                        <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs space-y-2">
                          <h4 className="font-semibold text-slate-200">Handoffs</h4>
                          <div className="space-y-1">
                            {detail.handoffs.map((h: any) => (
                              <div key={h.id} className="px-2 py-1 rounded bg-slate-950 border border-slate-800/60 text-[11px] text-slate-300">
                                <div className="flex items-center justify-between">
                                  <span className="capitalize font-medium">{h.status}</span>
                                  <span className="text-slate-500">{new Date(h.createdAt).toLocaleString()}</span>
                                </div>
                                {h.resultSummary && <p className="text-slate-400 truncate mt-0.5">{h.resultSummary}</p>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {detail.events && detail.events.length > 0 && (
                        <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-xs space-y-2">
                          <h4 className="font-semibold text-slate-200">Events</h4>
                          <div className="space-y-1 max-h-48 overflow-y-auto">
                            {detail.events.slice(0, 10).map((e: any) => (
                              <div key={e.id} className="flex items-center justify-between px-2 py-0.5 rounded bg-slate-950 border border-slate-800/40 text-[10px]">
                                <span className="text-slate-300 truncate max-w-[200px]">{e.eventType}</span>
                                <span className="text-slate-500">{new Date(e.timestamp).toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {detail.attentionItems && detail.attentionItems.length > 0 && (
                        <div className="p-3 rounded-lg bg-slate-900 border border-amber-500/20 text-xs space-y-2">
                          <h4 className="font-semibold text-amber-300">Unresolved Attention</h4>
                          {detail.attentionItems.map((item: any) => (
                            <div key={item.id} className="px-2 py-1 rounded bg-amber-900/10 border border-amber-500/10 text-[11px]">
                              <div className="font-medium text-amber-200">{item.title}</div>
                              <div className="text-amber-300/80">{item.message}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-slate-500">No detail available.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
