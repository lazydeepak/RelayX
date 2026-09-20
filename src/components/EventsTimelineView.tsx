import React, { useState } from 'react';
import { Activity, Eye, Filter, Search } from 'lucide-react';
import { UIEvent, ObservableEvidence } from '../types/ui.ts';

interface EventsTimelineViewProps {
  events: UIEvent[];
  onViewEvidence: (ev: ObservableEvidence) => void;
}

export const EventsTimelineView: React.FC<EventsTimelineViewProps> = ({ events, onViewEvidence }) => {
  const [filterType, setFilterType] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const filteredEvents = events.filter((e) => {
    if (filterType !== 'all' && e.resourceType !== filterType) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        e.eventType.toLowerCase().includes(q) ||
        e.resourceId.toLowerCase().includes(q) ||
        e.actor.toLowerCase().includes(q) ||
        (e.correlationId && e.correlationId.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-400" />
            <span>Activity & Event Lineage</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Complete, immutable audit trail of state transitions, delivery attempts, and evidence
          </p>
        </div>

        {/* Filter controls */}
        <div className="flex items-center gap-2 text-xs">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search events..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
          >
            <option value="all">All Resources</option>
            <option value="delivery">Deliveries</option>
            <option value="assignment">Assignments</option>
            <option value="runtime">Runtimes</option>
            <option value="handoff">Handoffs</option>
            <option value="pair">Pairs</option>
          </select>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <div className="divide-y divide-slate-800">
          {filteredEvents.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No lineage events matched your current filters.
            </div>
          ) : (
            filteredEvents.map((evt) => (
              <div
                key={evt.id}
                className="p-4 hover:bg-slate-800/40 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              >
                <div className="flex items-start gap-3">
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-500 mt-1.5 shrink-0" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-100">{evt.eventType}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                        {evt.resourceType}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 mt-1 text-slate-400">
                      <span>
                        Resource ID: <span className="font-mono text-slate-300">{evt.resourceId}</span>
                      </span>
                      <span>•</span>
                      <span>
                        Actor: <strong className="text-slate-200">{evt.actor}</strong>
                      </span>
                    </div>

                    {evt.correlationId && (
                      <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                        Correlation Key: {evt.correlationId}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0 self-end sm:self-center">
                  {evt.evidence && (
                    <button
                      onClick={() => onViewEvidence(evt.evidence!)}
                      className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-blue-400 text-xs transition-colors"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>Inspect Evidence</span>
                    </button>
                  )}
                  <span className="text-slate-400 font-mono text-[11px]">
                    {new Date(evt.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
