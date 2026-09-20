import React from 'react';
import { X, ShieldCheck, Camera, Terminal, Clock, Eye } from 'lucide-react';
import { ObservableEvidence } from '../relay/domain/types.ts';

interface EvidenceModalProps {
  evidence: ObservableEvidence | null;
  onClose: () => void;
}

export const EvidenceModal: React.FC<EvidenceModalProps> = ({ evidence, onClose }) => {
  if (!evidence) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <Eye className="w-5 h-5 text-blue-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Observable UI Automation Evidence</h3>
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
        <div className="p-5 space-y-4 overflow-y-auto flex-1 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-slate-400 block mb-1">Evidence ID</span>
              <span className="font-mono text-slate-200">{evidence.id}</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-slate-400 block mb-1">Source Interface</span>
              <span className="font-semibold text-emerald-400">{evidence.source}</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-slate-400 block mb-1">Window Title</span>
              <span className="text-slate-200 truncate block">{evidence.windowTitle || 'N/A'}</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
              <span className="text-slate-400 block mb-1">Process PID</span>
              <span className="font-mono text-slate-200">{evidence.applicationPid ?? 'N/A'}</span>
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
            <span className="text-slate-400 font-medium block mb-1">Full Evidence Structure</span>
            <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-300 overflow-x-auto">
              {JSON.stringify(evidence, null, 2)}
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
