import React, { useState, useEffect } from 'react';
import { X, History, Clock, User, Cpu, Info } from 'lucide-react';
import { UIEvent, ObservableEvidence } from '../types/ui.ts';
import { relayBridge } from '../services/relayBridge.ts';

interface RuntimeHistoryModalProps {
  isOpen: boolean;
  sessionId: string;
  sessionName: string;
  onClose: () => void;
  onViewEvidence: (ev: ObservableEvidence) => void;
}

export const RuntimeHistoryModal: React.FC<RuntimeHistoryModalProps> = ({
  isOpen,
  sessionId,
  sessionName,
  onClose,
  onViewEvidence,
}) => {
  const [events, setEvents] = useState<UIEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && sessionId) {
      loadHistory();
    }
  }, [isOpen, sessionId]);

  const loadHistory = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const history = await relayBridge.listEvents(100, sessionId);
      setEvents(history);
    } catch (err: any) {
      setError(err.message || 'Failed to load session history');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <History className="w-5 h-5 text-blue-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Audit History: {sessionName}</h3>
              <p className="text-[11px] text-slate-400 font-mono">{sessionId}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 custom-scrollbar">
          {isLoading ? (
            <div className="py-20 text-center text-slate-500 text-xs">
              <span className="inline-block w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mr-3 align-middle" />
              Retrieving immutable audit trail...
            </div>
          ) : error ? (
            <div className="p-4 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-xs text-center">
              {error}
            </div>
          ) : events.length === 0 ? (
            <div className="py-20 text-center text-slate-600 text-xs">
              No audit events recorded for this session yet.
            </div>
          ) : (
            <div className="space-y-4">
              {events.map((event) => (
                <div
                  key={event.id}
                  className="relative pl-6 border-l border-slate-800 pb-2 last:pb-0"
                >
                  <div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-slate-700 border border-slate-900" />
                  
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-slate-200">
                        {event.eventType.replace('runtime.', '').toUpperCase()}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-slate-800 text-[9px] text-slate-400 uppercase font-mono">
                        {event.actor}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-500 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {new Date(event.timestamp).toLocaleString()}
                    </span>
                  </div>

                  <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-2">
                    <div className="flex items-center gap-4 text-[10px]">
                      {event.previousState && (
                        <div className="flex flex-col">
                          <span className="text-slate-500 uppercase text-[9px]">From</span>
                          <span className="text-slate-400 font-medium">{event.previousState}</span>
                        </div>
                      )}
                      {event.newState && (
                        <div className="flex flex-col">
                          <span className="text-slate-500 uppercase text-[9px]">To</span>
                          <span className="text-emerald-400 font-medium">{event.newState}</span>
                        </div>
                      )}
                    </div>

                    {event.details && Object.keys(event.details).length > 0 && (
                      <div className="text-[10px] text-slate-400 bg-slate-900/50 p-2 rounded border border-slate-800/50 font-mono">
                        {Object.entries(event.details).map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <span className="text-slate-500">{k}:</span>
                            <span className="text-slate-300 truncate">{String(v)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {event.evidence && (
                      <button
                        onClick={() => onViewEvidence(event.evidence!)}
                        className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 pt-1"
                      >
                        <Info className="w-3 h-3" />
                        <span>View Observation Evidence</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-slate-950 shrink-0 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
