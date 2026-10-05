import React from 'react';
import { AlertTriangle, CheckCircle2, RotateCcw, ShieldAlert, ShieldCheck, Activity, Eye, FileText } from 'lucide-react';
import { UIAttentionItem, ObservableEvidence } from '../types/ui.ts';
import { recoveryDeliveryArgument, recoveryUnavailabilityReason } from './attentionRecoveryModels.ts';

interface AttentionRecoveryViewProps {
  attentionItems: UIAttentionItem[];
  onResolveAmbiguousDelivery: (deliveryId: string, outcome: 'delivered' | 'failed') => void;
  onRecoverSuspendedRuntime: (runtimeId?: string) => void;
  onAcknowledgeItem: (id: string) => void;
  onViewEvidence?: (evidence: ObservableEvidence) => void;
  onViewCorrelatedEvents?: (resourceId: string, correlationId?: string) => void;
}

export const AttentionRecoveryView: React.FC<AttentionRecoveryViewProps> = ({
  attentionItems,
  onResolveAmbiguousDelivery,
  onRecoverSuspendedRuntime,
  onAcknowledgeItem,
  onViewEvidence,
  onViewCorrelatedEvents,
}) => {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <span>Attention Items & Tier 1 Recovery</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Supervised anomalies requiring deterministic operator or runtime reconciliation
          </p>
        </div>
      </div>

      {attentionItems.length === 0 ? (
        <div className="p-12 text-center rounded-xl bg-slate-900 border border-slate-800 space-y-3">
          <ShieldCheck className="w-10 h-10 text-emerald-400 mx-auto" />
          <h3 className="text-sm font-semibold text-slate-100">All Systems Nominal</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            No active ambiguous deliveries, suspended runtimes, or unconfirmed states detected.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {attentionItems.map((item) => {
            const correlatedTarget = item.assignmentId || item.deliveryId || item.pairId || item.id;
            return (
              <div
                key={item.id}
                className={`rx-card p-5 rounded-xl border flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                  item.severity === 'critical'
                    ? 'bg-red-950/20 border-red-800/40 text-red-200'
                    : item.severity === 'warning'
                    ? 'bg-amber-950/20 border-amber-800/40 text-amber-200'
                    : 'bg-slate-900 border-slate-800 text-slate-200'
                }`}
              >
                <div className="rx-card-content space-y-1.5 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                        item.severity === 'critical'
                          ? 'bg-red-500 text-slate-950'
                          : item.severity === 'warning'
                          ? 'bg-amber-500 text-slate-950'
                          : 'bg-blue-500 text-white'
                      }`}
                    >
                      {item.severity}
                    </span>
                    <span className="text-xs font-semibold text-slate-100">{item.title}</span>
                    <span className="text-[11px] text-slate-400 font-mono">({item.type})</span>
                  </div>

                  <p className="text-xs text-slate-300">{item.message}</p>

                  {/* Correlated references */}
                  <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-slate-400 font-mono">
                    {item.assignmentId && (
                      <span className="flex items-center gap-1">
                        <span className="text-slate-500">Assignment:</span>
                        <span className="text-slate-300 truncate max-w-[120px]" title={item.assignmentId}>{item.assignmentId}</span>
                      </span>
                    )}
                    {item.deliveryId && (
                      <span className="flex items-center gap-1">
                        <span className="text-slate-500">Delivery:</span>
                        <span className="text-slate-300 truncate max-w-[120px]" title={item.deliveryId}>{item.deliveryId}</span>
                      </span>
                    )}
                    {item.pairId && (
                      <span className="flex items-center gap-1">
                        <span className="text-slate-500">Pair:</span>
                        <span className="text-slate-300 truncate max-w-[120px]" title={item.pairId}>{item.pairId}</span>
                      </span>
                    )}
                  </div>

                  {item.suggestedAction && (
                    <p className="text-[11px] text-blue-300 flex items-center gap-1 mt-1">
                      <span>Suggested Action:</span>
                      <strong>{item.suggestedAction}</strong>
                    </p>
                  )}
                </div>

                {/* Tier 1 Deterministic Recovery & Observability Controls
                    One action region. It may wrap onto further lines when the
                    card is narrow; controls keep their order and gaps. */}
                <div className="rx-action-group rx-action-group-wrap flex items-center gap-2">
                  {item.type === 'ambiguous_delivery' && recoveryDeliveryArgument(item) && (
                    <>
                      <button
                        onClick={() => onResolveAmbiguousDelivery(recoveryDeliveryArgument(item), 'delivered')}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
                      >
                        Confirm Delivered
                      </button>
                      <button
                        onClick={() => onResolveAmbiguousDelivery(recoveryDeliveryArgument(item), 'failed')}
                        className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium transition-colors"
                      >
                        Mark As Failed
                      </button>
                    </>
                  )}

                  {item.type === 'ambiguous_delivery' &&
                    !recoveryDeliveryArgument(item) &&
                    recoveryUnavailabilityReason(item) && (
                      <p className="text-[11px] text-amber-300 max-w-[26ch] text-right">
                        {recoveryUnavailabilityReason(item)}
                      </p>
                    )}

                  {item.type === 'runtime_suspended' && (
                    <button
                      onClick={() => onRecoverSuspendedRuntime()}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors flex items-center gap-1.5"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Probe & Recover</span>
                    </button>
                  )}

                  {item.evidence && onViewEvidence && (
                    <button
                      onClick={() => onViewEvidence(item.evidence!)}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-indigo-300 text-xs font-medium transition-colors flex items-center gap-1.5"
                      title="View verifiable trace evidence"
                    >
                      <Eye className="w-3.5 h-3.5 text-indigo-400" />
                      <span>View Evidence</span>
                    </button>
                  )}

                  {correlatedTarget && onViewCorrelatedEvents && (
                    <button
                      onClick={() => onViewCorrelatedEvents(correlatedTarget)}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-blue-300 text-xs font-medium transition-colors flex items-center gap-1.5"
                      title="View correlated events in lineage timeline"
                    >
                      <Activity className="w-3.5 h-3.5 text-blue-400" />
                      <span>Correlated Logs</span>
                    </button>
                  )}

                  <button
                    onClick={() => onAcknowledgeItem(item.id)}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
