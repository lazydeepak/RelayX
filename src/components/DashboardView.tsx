import React from 'react';
import {
  Activity,
  Layers,
  Cpu,
  ListTodo,
  AlertTriangle,
  RotateCcw,
  CheckCircle2,
  RefreshCw,
  Plus,
  Eye,
  ShieldCheck,
} from 'lucide-react';
import { UIEvent, ObservableEvidence } from '../types/ui.ts';

interface DashboardViewProps {
  metrics: {
    totalProjects: number;
    totalPairs: number;
    totalRuntimes: number;
    activeWorkers: number;
    activeAssignments: number;
    waitingReview: number;
    openAttentionItems: number;
    ambiguousDeliveries: number;
  };
  recentEvents: UIEvent[];
  onTriggerSupervision: () => void;
  onOpenNewAssignment: () => void;
  onViewEvidence: (ev: ObservableEvidence) => void;
  isSupervising: boolean;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  metrics,
  recentEvents,
  onTriggerSupervision,
  onOpenNewAssignment,
  onViewEvidence,
  isSupervising,
}) => {
  const isEmptyDatabase = metrics.totalProjects === 0 && metrics.totalPairs === 0;

  return (
    <div className="space-y-6">
      {/* Top Header & Fast Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>Relay Control Plane</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
              Live Local Desktop
            </span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            macOS AI Work Orchestration • Observable UI Automation • Durable SQLite Engine
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={onTriggerSupervision}
            disabled={isSupervising}
            className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSupervising ? 'animate-spin text-blue-400' : ''}`} />
            <span>{isSupervising ? 'Supervising...' : 'Run Supervision Tick'}</span>
          </button>

          <button
            onClick={onOpenNewAssignment}
            className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>New Assignment</span>
          </button>
        </div>
      </div>

      {/* Honest Empty State Banner if Database is Fresh */}
      {isEmptyDatabase && (
        <div className="p-6 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-blue-400" />
              <span>Durable Database Initialized — Empty State</span>
            </h3>
            <p className="text-xs text-slate-400 mt-1 max-w-xl">
              No projects, planner-worker pairs, or assignments have been created yet. Create a new assignment to begin real local work.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onOpenNewAssignment}
              className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              Create Assignment
            </button>
          </div>
        </div>
      )}

      {/* Critical Alert Banner if Ambiguous Deliveries exist */}
      {metrics.ambiguousDeliveries > 0 && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-amber-300">
              {metrics.ambiguousDeliveries} Ambiguous Delivery Detected
            </h3>
            <p className="text-xs text-amber-200/80 mt-1">
              Automated resending is strictly blocked to prevent duplicate execution. Open the Attention & Recovery tab to reconcile observable UI state.
            </p>
          </div>
        </div>
      )}

      {/* Primary KPI Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-sm">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-medium uppercase tracking-wider">Active Workers</span>
            <Cpu className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-slate-100">{metrics.activeWorkers}</div>
          <p className="text-[11px] text-slate-400 mt-1">
            {metrics.activeWorkers > 0 ? 'Working sessions under active execution' : 'No active workers'}
          </p>
        </div>

        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-sm">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-medium uppercase tracking-wider">Assignments Running</span>
            <ListTodo className="w-4 h-4 text-blue-400" />
          </div>
          <div className="text-2xl font-bold text-slate-100">{metrics.activeAssignments}</div>
          <p className="text-[11px] text-slate-400 mt-1">Under active attempt execution</p>
        </div>

        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-sm">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-medium uppercase tracking-wider">Awaiting Review</span>
            <CheckCircle2 className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-2xl font-bold text-slate-100">{metrics.waitingReview}</div>
          <p className="text-[11px] text-slate-400 mt-1">Handoff ready for planner check</p>
        </div>

        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-sm">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-medium uppercase tracking-wider">Open Attention</span>
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-slate-100">{metrics.openAttentionItems}</div>
          <p className="text-[11px] text-slate-400 mt-1">Requires reconciliation action</p>
        </div>
      </div>

      {/* Two Column Layout: System Lineage & Recent Traceable Events */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Recent Traceable Event Timeline */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-blue-400" />
              <h2 className="text-sm font-semibold text-slate-200">Recent Observable Lineage Events</h2>
            </div>
            <span className="text-xs text-slate-400">{recentEvents.length} recorded</span>
          </div>

          <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
            {recentEvents.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">No events recorded yet.</p>
            ) : (
              recentEvents.map((evt) => (
                <div
                  key={evt.id}
                  className="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 flex items-start justify-between gap-3 text-xs"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="w-2 h-2 rounded-full bg-blue-400 mt-1.5 shrink-0"></span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-200">{evt.eventType}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                          {evt.resourceType}:{evt.resourceId.slice(0, 8)}
                        </span>
                      </div>
                      <p className="text-slate-400 mt-0.5">
                        Actor: <span className="text-slate-300 font-medium">{evt.actor}</span>
                        {evt.previousState && evt.newState && (
                          <span className="ml-2 font-mono text-[11px] text-slate-400">
                            ({evt.previousState} → {evt.newState})
                          </span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {evt.evidence && (
                      <button
                        onClick={() => onViewEvidence(evt.evidence!)}
                        className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-blue-400 text-[11px] transition-colors"
                      >
                        <Eye className="w-3 h-3" />
                        <span>Evidence</span>
                      </button>
                    )}
                    <span className="text-[11px] text-slate-500 font-mono">
                      {new Date(evt.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right 1 Col: Control Plane Invariants & Status */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-slate-200">Engine Invariant Guard</h2>
          </div>

          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
              <span className="font-semibold text-slate-200 block mb-1">Observable Evidence Rule</span>
              <p className="text-slate-400 text-[11px]">
                Relay never infers success from an attempted click. Visible button states and response start are verified.
              </p>
            </div>

            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
              <span className="font-semibold text-slate-200 block mb-1">Delivery Ambiguity Guard</span>
              <p className="text-slate-400 text-[11px]">
                Unconfirmed deliveries are marked ambiguous. Automated resend is strictly prohibited without reconciliation.
              </p>
            </div>

            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
              <span className="font-semibold text-slate-200 block mb-1">Handoff Decoupling</span>
              <p className="text-slate-400 text-[11px]">
                Handoff completion does not equal assignment completion. The planner must review and explicitly close work.
              </p>
            </div>

            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
              <span className="font-semibold text-slate-200 block mb-1">Soft Suspension Before Death</span>
              <p className="text-slate-400 text-[11px]">
                A single observation failure places runtime into suspended state for retry. Permanent death requires multiple failures.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
