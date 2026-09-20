import React from 'react';
import { ListTodo, CheckCircle2, Clock, AlertTriangle, ArrowRight } from 'lucide-react';
import { UIAssignment } from '../types/ui.ts';

interface AssignmentsViewProps {
  assignments: UIAssignment[];
}

export const AssignmentsView: React.FC<AssignmentsViewProps> = ({ assignments }) => {
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
      </div>

      {assignments.length === 0 ? (
        <div className="p-8 rounded-xl bg-slate-900 border border-slate-800 text-center space-y-3">
          <ListTodo className="w-8 h-8 text-slate-600 mx-auto" />
          <h3 className="text-sm font-semibold text-slate-300">No Assignments Dispatched</h3>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            Dispatched assignments and worker attempt tracking will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {assignments.map((asgn) => (
          <div
            key={asgn.id}
            className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">
                  {asgn.pairName}
                </span>
                <h3 className="text-sm font-bold text-slate-100">{asgn.title}</h3>
              </div>

              <div className="flex items-center gap-2">
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
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-300 font-mono">
              {asgn.instruction}
            </div>

            <div className="flex flex-wrap items-center justify-between text-xs text-slate-400 pt-1">
              <div className="flex items-center gap-3">
                {asgn.activeDeliveryStatus && (
                  <span>
                    Delivery: <strong className="text-slate-200 uppercase">{asgn.activeDeliveryStatus}</strong>
                  </span>
                )}
                {asgn.activeHandoffStatus && (
                  <span>
                    Handoff: <strong className="text-purple-400 uppercase">{asgn.activeHandoffStatus}</strong>
                  </span>
                )}
              </div>
              <span>Created: {new Date(asgn.createdAt).toLocaleString()}</span>
            </div>
          </div>
        ))}
      </div>
      )}
    </div>
  );
};
