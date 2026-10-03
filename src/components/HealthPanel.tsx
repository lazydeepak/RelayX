/**
 * Phase 1 Health panel — READ-ONLY view over persisted health state.
 *
 * ## Boundaries this component enforces on itself
 *
 * This panel NEVER runs a health check. It reads what the Electron/application
 * runtime already persisted. There is deliberately:
 *
 *   - no setInterval / setTimeout anywhere in this file;
 *   - no provider call, AppleScript, subprocess, or session discovery;
 *   - no direct lag probe;
 *   - no "mark fixed", retry, repair, rebind, or restart affordance.
 *
 * Refresh is manual plus an explicit reload. Health detection continues to run
 * with this panel closed, because detection never lived here in the first place.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { relayBridge } from '../services/relayBridge.ts';
import type { UIHealthIncident, UIHealthIncidentDetail, UIHealthSummary } from '../types/relayApi.ts';

interface HealthPanelProps {
  onNotify: (msg: string) => void;
}

function OverallBadge({ state }: { state: UIHealthSummary['overall'] }) {
  switch (state) {
    case 'HEALTHY':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 bg-emerald-950/40 px-2.5 py-1 rounded-md border border-emerald-800/50">
          <CheckCircle2 className="w-3.5 h-3.5" /> Healthy
        </span>
      );
    case 'DEGRADED':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 bg-amber-950/40 px-2.5 py-1 rounded-md border border-amber-800/50">
          <AlertTriangle className="w-3.5 h-3.5" /> Degraded
        </span>
      );
    case 'UNHEALTHY':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400 bg-rose-950/40 px-2.5 py-1 rounded-md border border-rose-800/50">
          <XCircle className="w-3.5 h-3.5" /> Unhealthy
        </span>
      );
    case 'UNKNOWN':
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 bg-slate-800/40 px-2.5 py-1 rounded-md border border-slate-700/50">
          <HelpCircle className="w-3.5 h-3.5" /> Unknown
        </span>
      );
  }
}

function SeverityPill({ severity }: { severity: UIHealthIncident['severity'] }) {
  const tone =
    severity === 'CRITICAL' || severity === 'ERROR'
      ? 'text-rose-300 bg-rose-950/40 border-rose-900/60'
      : severity === 'WARNING'
        ? 'text-amber-300 bg-amber-950/40 border-amber-900/60'
        : 'text-slate-300 bg-slate-800/50 border-slate-700/60';
  return (
    <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded border ${tone}`}>
      {severity}
    </span>
  );
}

function StatusPill({ status }: { status: UIHealthIncident['status'] }) {
  const tone =
    status === 'OPEN'
      ? 'text-rose-300 border-rose-900/60'
      : status === 'ACKNOWLEDGED'
        ? 'text-sky-300 border-sky-900/60'
        : status === 'RECURRED'
          ? 'text-amber-300 border-amber-900/60'
          : 'text-emerald-300 border-emerald-900/60';
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded border bg-slate-900/60 ${tone}`}>
      {status}
    </span>
  );
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export const HealthPanel: React.FC<HealthPanelProps> = ({ onNotify }) => {
  const [summary, setSummary] = useState<UIHealthSummary | null>(null);
  const [active, setActive] = useState<UIHealthIncident[]>([]);
  const [history, setHistory] = useState<UIHealthIncident[]>([]);
  const [expanded, setExpanded] = useState<Record<string, UIHealthIncidentDetail | null | undefined>>({});
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [handoff, setHandoff] = useState<Record<string, string | undefined>>({});
  const [handoffBusy, setHandoffBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Read persisted health state only. Every call is a bounded projection; none
   * of them triggers detection.
   */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, a, h] = await Promise.all([
        relayBridge.getHealthSummary(),
        relayBridge.listHealthIncidents({ status: 'active' }),
        relayBridge.listHealthIncidents({ status: 'history' }),
      ]);
      setSummary(s);
      setActive(a);
      setHistory(h);
    } catch (err: any) {
      onNotify(`Failed to load health state: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  // One load on mount. NO polling: this component owns no timer.
  useEffect(() => {
    void load();
  }, [load]);

  const toggleRow = useCallback(
    async (incident: UIHealthIncident) => {
      const next = !openRows[incident.id];
      setOpenRows((prev) => ({ ...prev, [incident.id]: next }));
      if (next && expanded[incident.id] === undefined) {
        try {
          const detail = await relayBridge.getHealthIncident(incident.id);
          setExpanded((prev) => ({ ...prev, [incident.id]: detail }));
        } catch (err: any) {
          onNotify(`Failed to load incident detail: ${err.message}`);
          setExpanded((prev) => ({ ...prev, [incident.id]: null }));
        }
      }
    },
    [expanded, openRows, onNotify],
  );

  const acknowledge = useCallback(
    async (incident: UIHealthIncident) => {
      try {
        const res = await relayBridge.acknowledgeHealthIncident(incident.id);
        if (res.success) {
          onNotify(`Acknowledged ${incident.incidentType}`);
          setExpanded((prev) => ({ ...prev, [incident.id]: undefined }));
          await load();
        } else {
          onNotify('Acknowledgement was refused for this incident');
        }
      } catch (err: any) {
        onNotify(`Acknowledgement failed: ${err.message}`);
      }
    },
    [load, onNotify],
  );

  /**
   * Generate the read-only handoff report. Phase 1 does not deliver it anywhere:
   * the operator copies it out. This makes no provider, subprocess, or discovery
   * call; the main process only reads persisted state.
   */
  const generateHandoff = useCallback(
    async (detail: UIHealthIncidentDetail) => {
      setHandoffBusy(detail.id);
      try {
        const report = await relayBridge.generateHealthHandoffReport(detail.id);
        if (report) {
          setHandoff((prev) => ({ ...prev, [detail.id]: report }));
        } else {
          onNotify('Could not generate a handoff report for this incident');
        }
      } catch (err: any) {
        onNotify(`Handoff report failed: ${err.message}`);
      } finally {
        setHandoffBusy(null);
      }
    },
    [onNotify],
  );

  const copyHandoff = useCallback(
    async (detail: UIHealthIncidentDetail) => {
      const report = handoff[detail.id];
      if (!report) return;
      try {
        await navigator.clipboard.writeText(report);
        onNotify('Handoff report copied to clipboard');
      } catch (err: any) {
        onNotify(`Copy failed: ${err.message}`);
      }
    },
    [handoff, onNotify],
  );

  const renderIncidentRow = (incident: UIHealthIncident) => {
    const isOpen = !!openRows[incident.id];
    const detail = expanded[incident.id];
    return (
      <div key={incident.id} className="bg-slate-900/50 border border-slate-800/80 rounded-lg overflow-hidden">
        <button
          onClick={() => toggleRow(incident)}
          className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-slate-800/40 transition-colors"
        >
          <span className="mt-0.5 text-slate-500">
            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </span>
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-slate-100">{incident.incidentType}</span>
              <SeverityPill severity={incident.severity} />
              <StatusPill status={incident.status} />
            </span>
            <span className="block mt-1 text-xs text-slate-400 truncate">{incident.summary}</span>
            <span className="block mt-1 text-[11px] text-slate-500 font-mono">
              {incident.componentType}
              {incident.componentId ? `:${incident.componentId}` : ''} · seen {incident.occurrenceCount}× ·
              last {fmtAge(Date.now() - incident.lastSeen)} ago
            </span>
          </span>
        </button>

        {isOpen && (
          <div className="px-4 pb-4 pt-2 border-t border-slate-800/80 space-y-3">
            {!detail ? (
              <p className="text-xs text-slate-500">Loading incident detail…</p>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
                  {[
                    ['Incident id', detail.id],
                    ['First seen', fmtTime(detail.firstSeen)],
                    ['Last seen', fmtTime(detail.lastSeen)],
                    ['Occurrences', String(detail.occurrenceCount)],
                  ].map(([label, value]) => (
                    <div key={label as string}>
                      <div className="text-slate-500 uppercase tracking-wider">{label}</div>
                      <div className="text-slate-300 font-mono mt-0.5 break-all">{value}</div>
                    </div>
                  ))}
                </div>

                <div>
                  <div className="text-[11px] text-slate-500 uppercase tracking-wider mb-1.5">
                    Observed evidence
                  </div>
                  {Object.keys(detail.evidence).length === 0 ? (
                    <p className="text-xs text-slate-500">
                      No structured evidence was recorded for this incident.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
                      {Object.entries(detail.evidence).map(([key, value]) => (
                        <div key={key} className="flex gap-2 text-[11px] font-mono">
                          <span className="text-slate-500 shrink-0">{key}:</span>
                          <span className="text-slate-300 break-all">{String(value)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {detail.unavailableFields.length > 0 && (
                  <p className="text-[11px] text-slate-500">
                    Not available for this incident: {detail.unavailableFields.join(', ')}
                  </p>
                )}

                {detail.status === 'OPEN' && (
                  <button
                    onClick={() => acknowledge(detail)}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 transition-colors"
                  >
                    Acknowledge
                  </button>
                )}
                {detail.status === 'ACKNOWLEDGED' && (
                  <p className="text-[11px] text-slate-500">
                    Acknowledged. This incident stays active until health evidence proves recovery.
                  </p>
                )}

                <button
                  onClick={() => generateHandoff(detail)}
                  disabled={handoffBusy === detail.id}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-950 border border-blue-800 text-blue-200 hover:bg-blue-900 transition-colors disabled:opacity-50"
                >
                  {handoffBusy === detail.id ? 'Generating…' : 'Generate Handoff Report'}
                </button>

                {handoff[detail.id] && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 uppercase tracking-wider">
                        Handoff report
                      </span>
                      <button
                        onClick={() => copyHandoff(detail)}
                        className="px-2 py-1 text-[11px] font-medium rounded border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors"
                      >
                        Copy report
                      </button>
                    </div>
                    <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-[11px] font-mono text-slate-300 max-h-96 overflow-auto whitespace-pre-wrap break-all">
                      {handoff[detail.id]}
                    </pre>
                    <p className="text-[11px] text-slate-500">
                      Phase 1 does not deliver this automatically. Copy it to the channel where the
                      investigation is happening.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-600/20 border border-emerald-500/30 rounded-xl text-emerald-400">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">Health</h2>
            <p className="text-xs text-slate-400">
              Read-only view of health incidents detected by the RelayX runtime.
            </p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh Health'}
        </button>
      </div>

      {/* Overall state */}
      <div className="bg-slate-900/80 border border-slate-800/80 rounded-2xl p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Overall health</span>
            <div className="mt-2">
              <OverallBadge state={summary?.overall ?? 'UNKNOWN'} />
            </div>
            <p className="mt-2 text-xs text-slate-400">{summary?.overallReason ?? 'Health state not yet available.'}</p>
          </div>
          <div className="text-right text-[11px] text-slate-500 space-y-1">
            <div>
              <div className="uppercase tracking-wider">Active</div>
              <div className="text-slate-300 font-mono">{summary?.activeIncidentCount ?? 0}</div>
            </div>
            <div>
              <div className="uppercase tracking-wider">History</div>
              <div className="text-slate-300 font-mono">{summary?.resolvedIncidentCount ?? 0}</div>
            </div>
            <div>
              <div className="uppercase tracking-wider">Observations</div>
              <div className="text-slate-300 font-mono">{summary?.totalObservationCount ?? 0}</div>
            </div>
          </div>
        </div>
        {summary && summary.observedCheckTypes.length > 0 && (
          <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap gap-1.5">
            {summary.observedCheckTypes.map((t: string) => (
              <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-400">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Active incidents */}
      <div>
        <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-400" />
          Active incidents
        </h3>
        {active.length === 0 ? (
          <div className="bg-slate-900/50 border border-slate-800/80 rounded-lg p-4 text-xs text-slate-400">
            {summary?.hasSufficientEvidence
              ? 'No active health incidents.'
              : 'No active health incidents. The health runtime has not produced enough evidence yet, so overall health reads Unknown rather than Healthy.'}
          </div>
        ) : (
          <div className="space-y-2">{active.map(renderIncidentRow)}</div>
        )}
      </div>

      {/* History */}
      <div>
        <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          <Activity className="w-4 h-4 text-slate-400" />
          Recent resolved and recurred
        </h3>
        {history.length === 0 ? (
          <p className="text-xs text-slate-500">No resolved health incidents recorded yet.</p>
        ) : (
          <div className="space-y-2">
            {history.map((incident) => (
              <div
                key={incident.id}
                className="bg-slate-900/40 border border-slate-800/70 rounded-lg px-4 py-2.5 flex items-center gap-3 flex-wrap"
              >
                <StatusPill status={incident.status} />
                <span className="text-xs font-semibold text-slate-200">{incident.incidentType}</span>
                <span className="text-[11px] font-mono text-slate-500">
                  {incident.componentType}
                  {incident.componentId ? `:${incident.componentId}` : ''}
                </span>
                <span className="text-[11px] text-slate-500">
                  {incident.occurrenceCount}× · last {fmtTime(incident.lastSeen)}
                </span>
                {incident.status === 'RECURRED' && (
                  <span className="text-[11px] text-amber-400">recurred after resolution</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[11px] text-slate-600 flex items-center gap-2">
        <ShieldCheck className="w-3.5 h-3.5" />
        Health is detected in the RelayX application runtime. This panel only reads persisted state; opening or refreshing it performs no provider, subprocess, or session work.
      </p>
    </div>
  );
};
