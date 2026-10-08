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
  TrendingUp,
} from 'lucide-react';
import { UIEvent, ObservableEvidence, UIProject, UIAssignment } from '../types/ui.ts';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';

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
  projects: UIProject[];
  assignments: UIAssignment[];
  onTriggerSupervision: () => void;
  onOpenNewAssignment: () => void;
  onViewEvidence: (ev: ObservableEvidence) => void;
  onNavigateAssignments?: () => void;
  isSupervising: boolean;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  metrics,
  recentEvents,
  projects,
  assignments,
  onTriggerSupervision,
  onOpenNewAssignment,
  onViewEvidence,
  onNavigateAssignments,
  isSupervising,
}) => {
  const isEmptyDatabase = metrics.totalProjects === 0 && metrics.totalPairs === 0;

  // Process data for the last 7 days trend
  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return d.toISOString().split('T')[0];
  });

  const chartData = last7Days.map((date) => {
    const dayData: any = { 
      date: new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      rawDate: date 
    };
    projects.forEach((p) => {
      const count = assignments.filter(
        (a) =>
          a.projectId === p.id &&
          a.status === 'completed' &&
          a.completedAt &&
          new Date(a.completedAt).toISOString().split('T')[0] === date
      ).length;
      dayData[p.name] = count;
    });
    return dayData;
  });

  // Colors for projects
  const COLORS = [
    '#3b82f6', // blue-500
    '#10b981', // emerald-500
    '#8b5cf6', // violet-500
    '#f59e0b', // amber-500
    '#ec4899', // pink-500
    '#06b6d4', // cyan-500
    '#f97316', // orange-500
  ];

  return (
    <div className="space-y-6">
      {/* Top Header & Fast Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>RelayX Control Plane</span>
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
        <div className="rx-card p-4 rounded-xl bg-slate-900/60 backdrop-blur-md border border-slate-800/80 shadow-lg">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-medium uppercase tracking-wider">Active Workers</span>
            <Cpu className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-slate-100">{metrics.activeWorkers}</div>
          <p className="text-[11px] text-slate-400 mt-1">
            {metrics.activeWorkers > 0 ? 'Working sessions under active execution' : 'No active workers'}
          </p>
        </div>

        <button
          onClick={onNavigateAssignments}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onNavigateAssignments?.();
            }
          }}
          className="rx-card p-4 rounded-xl bg-slate-900/60 backdrop-blur-md border border-slate-800/80 shadow-lg text-left cursor-pointer hover:border-blue-500/30 hover:bg-slate-900/80 focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-colors group"
          aria-label={`Assignments Running: ${metrics.activeAssignments}. Press Enter to open assignments view.`}
          role="button"
          tabIndex={0}
        >
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-medium uppercase tracking-wider">Assignments Running</span>
            <ListTodo className="w-4 h-4 text-blue-400 group-hover:scale-110 transition-transform" />
          </div>
          <div className="text-2xl font-bold text-slate-100">{metrics.activeAssignments}</div>
          <p className="text-[11px] text-slate-400 mt-1">Under active attempt execution</p>
        </button>

        <div className="rx-card p-4 rounded-xl bg-slate-900/60 backdrop-blur-md border border-slate-800/80 shadow-lg">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-medium uppercase tracking-wider">Awaiting Review</span>
            <CheckCircle2 className="w-4 h-4 text-purple-400" />
          </div>
          <div className="text-2xl font-bold text-slate-100">{metrics.waitingReview}</div>
          <p className="text-[11px] text-slate-400 mt-1">Handoff ready for planner check</p>
        </div>

        <div className="rx-card p-4 rounded-xl bg-slate-900/60 backdrop-blur-md border border-slate-800/80 shadow-lg">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-xs font-medium uppercase tracking-wider">Open Attention</span>
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-slate-100">{metrics.openAttentionItems}</div>
          <p className="text-[11px] text-slate-400 mt-1">Requires reconciliation action</p>
        </div>
      </div>

      {/* Project Activity Trend Graph */}
      {!isEmptyDatabase && (
        <div className="rx-card bg-slate-900/60 backdrop-blur-md border border-slate-800/80 rounded-xl p-5 shadow-lg">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-blue-400" />
              <h2 className="text-sm font-semibold text-slate-200">Project Activity Trend</h2>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-medium">Completed Assignments (7D)</span>
            </div>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  {projects.map((p, idx) => (
                    <linearGradient key={`gradient-${p.id}`} id={`color-${idx}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS[idx % COLORS.length]} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={COLORS[idx % COLORS.length]} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis 
                  dataKey="date" 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  dy={10}
                />
                <YAxis 
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  allowDecimals={false}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#0f172a', 
                    border: '1px solid #1e293b', 
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: '#f1f5f9'
                  }}
                  itemStyle={{ padding: '2px 0' }}
                  cursor={{ stroke: '#334155', strokeWidth: 1 }}
                />
                <Legend 
                  verticalAlign="top" 
                  align="right" 
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ 
                    fontSize: '10px', 
                    paddingBottom: '20px',
                    color: '#94a3b8' 
                  }}
                />
                {projects.map((p, idx) => (
                  <Area
                    key={p.id}
                    type="monotone"
                    dataKey={p.name}
                    stroke={COLORS[idx % COLORS.length]}
                    fillOpacity={1}
                    fill={`url(#color-${idx})`}
                    strokeWidth={2}
                    stackId="1"
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Two Column Layout: System Lineage & Recent Traceable Events */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Recent Traceable Event Timeline */}
        <div className="rx-card lg:col-span-2 bg-slate-900/60 backdrop-blur-md border border-slate-800/80 rounded-xl p-5 shadow-lg">
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
        <div className="rx-card bg-slate-900/60 backdrop-blur-md border border-slate-800/80 rounded-xl p-5 space-y-4 shadow-lg">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-slate-200">Engine Invariant Guard</h2>
          </div>

          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-slate-950/40 backdrop-blur-sm border border-slate-800/80">
              <span className="font-semibold text-slate-200 block mb-1">Observable Evidence Rule</span>
              <p className="text-slate-400 text-[11px]">
                RelayX never infers success from an attempted click. Visible button states and response start are verified.
              </p>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/40 backdrop-blur-sm border border-slate-800/80">
              <span className="font-semibold text-slate-200 block mb-1">Delivery Ambiguity Guard</span>
              <p className="text-slate-400 text-[11px]">
                Unconfirmed deliveries are marked ambiguous. Automated resend is strictly prohibited without reconciliation.
              </p>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/40 backdrop-blur-sm border border-slate-800/80">
              <span className="font-semibold text-slate-200 block mb-1">Handoff Decoupling</span>
              <p className="text-slate-400 text-[11px]">
                Handoff completion does not equal assignment completion. The planner must review and explicitly close work.
              </p>
            </div>

            <div className="p-3 rounded-lg bg-slate-950/40 backdrop-blur-sm border border-slate-800/80">
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
