import React, { useState, useEffect, useCallback } from 'react';
import {
  Stethoscope,
  Activity,
  Cpu,
  GitMerge,
  Truck,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Copy,
  RefreshCw,
  Database,
  Layers,
  Clock,
} from 'lucide-react';
import { DiagnosticsReport, HealthLevel } from '../types/relayApi.ts';
import { relayBridge } from '../services/relayBridge.ts';

interface DiagnosticsViewProps {
  onNotify: (msg: string) => void;
}

export const DiagnosticsView: React.FC<DiagnosticsViewProps> = ({ onNotify }) => {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);

  const fetchDiagnostics = useCallback(async () => {
    setLoading(true);
    try {
      const rep = await relayBridge.getDiagnosticsReport();
      setReport(rep);
    } catch (err: any) {
      onNotify(`Failed to fetch diagnostics: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    fetchDiagnostics();
  }, [fetchDiagnostics]);

  const handleCopyReport = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.formattedReportText);
      setCopied(true);
      onNotify('Diagnostic report copied to clipboard');
      setTimeout(() => setCopied(false), 3000);
    } catch (err: any) {
      onNotify(`Copy failed: ${err.message}`);
    }
  };

  const renderHealthBadge = (level: HealthLevel) => {
    switch (level) {
      case 'HEALTHY':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 bg-emerald-950/40 px-2.5 py-1 rounded-md border border-emerald-800/50">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            Healthy
          </span>
        );
      case 'DEGRADED':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 bg-amber-950/40 px-2.5 py-1 rounded-md border border-amber-800/50">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            Degraded
          </span>
        );
      case 'UNHEALTHY':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400 bg-rose-950/40 px-2.5 py-1 rounded-md border border-rose-800/50">
            <XCircle className="w-3.5 h-3.5 text-rose-400" />
            Unhealthy
          </span>
        );
      case 'UNKNOWN':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 bg-slate-800/40 px-2.5 py-1 rounded-md border border-slate-700/50">
            <HelpCircle className="w-3.5 h-3.5 text-slate-400" />
            Unknown
          </span>
        );
    }
  };

  if (loading && !report) {
    return (
      <div className="flex-1 flex items-center justify-center p-12 text-slate-400">
        <RefreshCw className="w-6 h-6 animate-spin mr-2" />
        <span>Loading RelayX Diagnostics subsystem...</span>
      </div>
    );
  }

  const components = report?.components || {};

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 text-slate-100 p-8">
      {/* Header */}
      <div className="max-w-6xl mx-auto mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600/20 border border-blue-500/30 rounded-xl text-blue-400">
              <Stethoscope className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white">RelayX Diagnostics</h1>
              <p className="text-sm text-slate-400">
                Read-only subsystem for ground-truth performance, runtime observation, and transport inspection.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchDiagnostics}
            className="flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh Diagnostics</span>
          </button>
          <button
            onClick={handleCopyReport}
            className="flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors shadow-sm"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>{copied ? 'Copied to Clipboard!' : 'Copy Diagnostic Report'}</span>
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto space-y-8">
        {/* Overall Status & Warnings */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-6 flex flex-col justify-between">
            <div>
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Overall Health</span>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xl font-semibold tracking-tight text-white">System State</span>
                {renderHealthBadge(report?.overall || 'UNKNOWN')}
              </div>
            </div>
            <div className="mt-6 pt-4 border-t border-slate-800 text-xs text-slate-400 flex items-center justify-between">
              <span>Observed timestamp:</span>
              <span className="font-mono text-slate-300">
                {report ? new Date(report.timestamp).toLocaleTimeString() : 'N/A'}
              </span>
            </div>
          </div>

          <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-6 md:col-span-2 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Active Problems & Warnings</span>
                <span className="text-xs font-mono text-slate-400">
                  {report?.problems.length || 0} items
                </span>
              </div>
              <div className="mt-3 space-y-2 max-h-28 overflow-y-auto pr-2">
                {report?.problems && report.problems.length > 0 ? (
                  report.problems.map((prob, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-xs text-amber-300 bg-amber-950/20 border border-amber-900/40 p-2 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{prob}</span>
                    </div>
                  ))
                ) : (
                  <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-950/20 border border-emerald-900/40 p-3 rounded-lg">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>No performance degradation or transport warnings detected.</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Core Subsystem Health Grid */}
        <div>
          <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-400" />
            <span>Subsystem Health Evaluation</span>
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Object.entries(components).map(([name, comp]) => (
              <div key={name} className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-slate-200">{comp.component}</span>
                    {renderHealthBadge(comp.status)}
                  </div>
                  <p className="text-xs text-slate-400 mb-4 line-clamp-2">{comp.summary}</p>
                </div>
                <div className="space-y-1 pt-3 border-t border-slate-800/80">
                  <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Evidence</span>
                  <div className="space-y-1">
                    {comp.evidence.map((ev, i) => (
                      <p key={i} className="text-xs font-mono text-slate-300 truncate">
                        • {ev}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Performance Telemetry Table */}
        <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl overflow-hidden">
          <div className="p-6 border-b border-slate-800 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Activity className="w-4 h-4 text-blue-400" />
                <span>Performance & Latency Telemetry</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Instrumented durations across operations, discovery routines, and IPC bridges.
              </p>
            </div>
            <span className="text-xs font-mono text-slate-400 bg-slate-800 px-2.5 py-1 rounded-md">
              Bounded Buffer: 500 max
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] font-medium text-slate-400 uppercase bg-slate-950/60">
                  <th className="py-3 px-6">Operation</th>
                  <th className="py-3 px-4 text-right">Calls</th>
                  <th className="py-3 px-4 text-right">Latest</th>
                  <th className="py-3 px-4 text-right">Average</th>
                  <th className="py-3 px-4 text-right">P95</th>
                  <th className="py-3 px-4 text-right">Max</th>
                  <th className="py-3 px-6 text-center">Failures</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-xs font-mono">
                {report?.performance && report.performance.length > 0 ? (
                  report.performance.map((m) => (
                    <tr key={m.operation} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-3.5 px-6 font-semibold text-slate-200">{m.operation}</td>
                      <td className="py-3.5 px-4 text-right text-slate-300 tabular-nums">{m.calls}</td>
                      <td className="py-3.5 px-4 text-right text-slate-300 tabular-nums">{m.latestDurationMs}ms</td>
                      <td className="py-3.5 px-4 text-right text-blue-400 font-bold tabular-nums">{m.avgDurationMs}ms</td>
                      <td className="py-3.5 px-4 text-right text-slate-300 tabular-nums">{m.p95DurationMs}ms</td>
                      <td className="py-3.5 px-4 text-right text-slate-300 tabular-nums">{m.maxDurationMs}ms</td>
                      <td className="py-3.5 px-6 text-center">
                        {m.errorCount > 0 ? (
                          <span className="px-2 py-0.5 bg-rose-950/40 text-rose-400 border border-rose-900 rounded tabular-nums">
                            {m.errorCount}
                          </span>
                        ) : (
                          <span className="text-slate-600">0</span>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      No operation telemetry recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Summary Footer */}
        <div className="bg-slate-950 border border-slate-900 rounded-xl p-6 text-xs text-slate-400 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-slate-500" />
            <span>RelayX Diagnostics observes existing state only. No active repairs or dispatches are performed.</span>
          </div>
          <span className="font-mono text-slate-500">Last observed ≠ currently verified invariant active</span>
        </div>
      </div>
    </div>
  );
};
