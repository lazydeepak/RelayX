import React, { useState } from 'react';
import { X, ShieldCheck, Camera, Terminal, Clock, Eye, Copy, Check } from 'lucide-react';
import { ObservableEvidence } from '../relay/domain/types.ts';

interface EvidenceModalProps {
  evidence: ObservableEvidence | null;
  onClose: () => void;
}

export const EvidenceModal: React.FC<EvidenceModalProps> = ({ evidence, onClose }) => {
  const [copiedJson, setCopiedJson] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  if (!evidence) return null;

  const jsonString = JSON.stringify(evidence, null, 2);

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    } catch {
      // fallback
    }
  };

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(evidence.id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 select-text">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <Eye className="w-5 h-5 text-blue-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Execution / Runtime Evidence</h3>
              <p className="text-xs text-slate-400">Verifiable trace recorded by Relay Engine</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1 text-xs select-text">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 relative group">
              <div className="flex items-center justify-between mb-1">
                <span className="text-slate-400">Evidence ID</span>
                <button
                  onClick={handleCopyId}
                  className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity"
                  title="Copy ID"
                >
                  {copiedId ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  {copiedId ? 'Copied' : 'Copy'}
                </button>
              </div>
              <span className="font-mono text-slate-200 select-all block break-all">{evidence.id}</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-slate-400 block mb-1">Source Interface</span>
              <span className="font-semibold text-emerald-400 select-all">{evidence.source}</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-slate-400 block mb-1">Window Title</span>
              <span className="text-slate-200 select-all block truncate">{evidence.windowTitle || 'N/A'}</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-slate-400 block mb-1">Process PID</span>
              <span className="font-mono text-slate-200 select-all">{evidence.applicationPid ?? 'N/A'}</span>
            </div>
          </div>

          {/* Observable State Indicators */}
          <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
            <span className="text-slate-400 font-medium block">Observed UI State</span>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center justify-between px-3 py-1.5 rounded bg-slate-900">
                <span className="text-slate-300">Send Button Visible</span>
                <span className={`font-mono ${evidence.visibleButtonState?.sendButtonVisible ? 'text-emerald-400' : 'text-slate-500'}`}>
                  {evidence.visibleButtonState?.sendButtonVisible ? 'TRUE' : 'FALSE'}
                </span>
              </div>
              <div className="flex items-center justify-between px-3 py-1.5 rounded bg-slate-900">
                <span className="text-slate-300">Stop Button Visible</span>
                <span className={`font-mono ${evidence.visibleButtonState?.stopButtonVisible ? 'text-emerald-400' : 'text-slate-500'}`}>
                  {evidence.visibleButtonState?.stopButtonVisible ? 'TRUE' : 'FALSE'}
                </span>
              </div>
              <div className="flex items-center justify-between px-3 py-1.5 rounded bg-slate-900">
                <span className="text-slate-300">Composer Cleared</span>
                <span className={`font-mono ${evidence.composerCleared ? 'text-emerald-400' : 'text-slate-500'}`}>
                  {evidence.composerCleared ? 'CONFIRMED' : 'NO'}
                </span>
              </div>
              <div className="flex items-center justify-between px-3 py-1.5 rounded bg-slate-900">
                <span className="text-slate-300">Response Activity</span>
                <span className={`font-mono ${evidence.responseActivityObserved ? 'text-emerald-400' : 'text-slate-500'}`}>
                  {evidence.responseActivityObserved ? 'ACTIVE' : 'IDLE'}
                </span>
              </div>
            </div>
          </div>

          {/* Raw JSON Details */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-slate-400 font-medium">Full Evidence Structure</span>
              <button
                onClick={handleCopyJson}
                className="px-2.5 py-1 text-xs font-medium rounded bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 hover:text-blue-300 flex items-center gap-1.5 transition-colors border border-blue-500/30"
              >
                {copiedJson ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedJson ? 'Copied Full JSON!' : 'Copy JSON'}
              </button>
            </div>
            <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-300 overflow-x-auto select-all max-h-80">
              {jsonString}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/60 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
          >
            Close Inspector
          </button>
        </div>
      </div>
    </div>
  );
};
