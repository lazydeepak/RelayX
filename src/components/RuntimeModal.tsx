import React, { useState, useEffect } from 'react';
import { X, Cpu, Search, PlusCircle, Trash2, AlertTriangle, CheckCircle2, RefreshCw, Archive } from 'lucide-react';
import { UIRuntimeSession, ProviderType } from '../types/ui.ts';
import { relayBridge } from '../services/relayBridge.ts';

export type RuntimeModalMode = 'discover' | 'register' | 'archive';

interface RuntimeModalProps {
  isOpen: boolean;
  mode: RuntimeModalMode;
  session?: UIRuntimeSession | null;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export const RuntimeModal: React.FC<RuntimeModalProps> = ({
  isOpen,
  mode,
  session,
  onClose,
  onSuccess,
}) => {
  const [providerType, setProviderType] = useState<ProviderType>('chatgpt');
  const [name, setName] = useState('');
  const [bundleIdentifier, setBundleIdentifier] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [archiveReason, setArchiveReason] = useState('');

  // Discovery state
  const [discoveredSession, setDiscoveredSession] = useState<UIRuntimeSession | null>(null);

  useEffect(() => {
    if (isOpen) {
      setErrorMessage(null);
      setDiscoveredSession(null);

      if (mode === 'register') {
        setName('');
        setProviderType('chatgpt');
        setBundleIdentifier('com.openai.chat');
      } else if (mode === 'archive') {
        setArchiveReason('');
      }
    }
  }, [isOpen, mode, session]);

  if (!isOpen) return null;

  const handleProviderChange = (p: ProviderType) => {
    setProviderType(p);
    if (p === 'chatgpt') {
      setName('ChatGPT Desktop');
      setBundleIdentifier('com.openai.chat');
    } else if (p === 'opencode') {
      setName('OpenCode Desktop');
      setBundleIdentifier('dev.opencode.mac');
    } else {
      setName('VS Code / Cursor Worker');
      setBundleIdentifier('com.microsoft.VSCode');
    }
  };

  const handleDiscover = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await relayBridge.discoverRuntime(providerType);
      if (!res.success || !res.runtime) {
        throw new Error(res.error || 'Failed to discover running provider window');
      }
      setDiscoveredSession(res.runtime);
      onSuccess(`Discovered and attached ${res.runtime.name} (PID: ${res.runtime.applicationPid ?? 'N/A'})`);
    } catch (err: any) {
      setErrorMessage(err.message || 'Discovery failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMessage('Runtime name is required');
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const sess = await relayBridge.registerRuntimeSession(
        providerType,
        name.trim(),
        bundleIdentifier.trim() || undefined,
      );
      onSuccess(`Runtime session "${sess.name}" registered successfully`);
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'Registration failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleArchive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await relayBridge.archiveRuntimeSession(session.id, archiveReason.trim() || undefined);
      onSuccess(`Runtime record "${session.name}" archived safely`);
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to archive runtime session');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            {mode === 'discover' && <Search className="w-5 h-5 text-emerald-400" />}
            {mode === 'register' && <PlusCircle className="w-5 h-5 text-blue-400" />}
            {mode === 'archive' && <Archive className="w-5 h-5 text-amber-400" />}
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                {mode === 'discover' && 'Discover & Attach Runtime'}
                {mode === 'register' && 'Register Runtime Session'}
                {mode === 'archive' && 'Archive Runtime Session'}
              </h3>
              <p className="text-xs text-slate-400">
                {mode === 'discover' && 'Probe running macOS AI instances via accessibility & window APIs'}
                {mode === 'register' && 'Manually define external AI provider session details'}
                {mode === 'archive' && 'Halts active work and hides the record from dispatch'}
              </p>
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
        {mode === 'archive' ? (
          <form onSubmit={handleArchive} className="p-5 space-y-4 text-xs">
            <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
              <div className="flex items-center gap-2 text-amber-400 font-semibold">
                <AlertTriangle className="w-4 h-4" />
                <span>Archiving Runtime: {session?.name}</span>
              </div>
              <p className="text-slate-300 leading-relaxed">
                Archiving will detach this session from any active work loops and hide it from the primary dashboard. 
                All historical logs and evidence will be permanently preserved.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-slate-400 font-medium ml-1">Archive Reason (Optional)</label>
              <textarea
                value={archiveReason}
                onChange={(e) => setArchiveReason(e.target.value)}
                placeholder="e.g. Application terminated, stale record, or replaced by newer instance"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500 transition-colors h-24 resize-none"
              />
            </div>

            {errorMessage && (
              <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-xs">
                {errorMessage}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium shadow-md transition-colors"
              >
                <Archive className="w-3.5 h-3.5" />
                <span>Confirm Archive</span>
              </button>
            </div>
          </form>
        ) : mode === 'discover' ? (
          <div className="p-5 space-y-4 text-xs">
            {errorMessage && (
              <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-xs">
                {errorMessage}
              </div>
            )}

            <div>
              <label className="block text-slate-300 font-medium mb-1.5">Select Provider to Probe</label>
              <div className="grid grid-cols-3 gap-2">
                {(['chatgpt', 'opencode', 'vscode'] as ProviderType[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProviderType(p)}
                    className={`p-3 rounded-lg border text-center transition-colors ${
                      providerType === p
                        ? 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300 font-semibold'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800/60'
                    }`}
                  >
                    <Cpu className="w-4 h-4 mx-auto mb-1 opacity-80" />
                    <span className="uppercase text-[11px] block">{p}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-1 text-slate-400 text-[11px]">
              <p>• Scans macOS system process table for running application instances</p>
              <p>• Queries Accessibility API to verify presence of chat/editor windows</p>
              <p>• Automatically binds session to RelayX local database if found</p>
            </div>

            {discoveredSession && (
              <div className="p-4 rounded-lg bg-emerald-950/40 border border-emerald-500/40 text-emerald-200 space-y-2">
                <div className="flex items-center gap-2 font-semibold">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>Session Discovered & Attached!</span>
                </div>
                <div className="text-[11px] text-slate-300 space-y-1">
                  <div>Name: <span className="font-semibold text-slate-100">{discoveredSession.name}</span></div>
                  <div>PID: <span className="font-mono text-slate-100">{discoveredSession.applicationPid ?? 'Running'}</span></div>
                  <div>Status: <span className="font-mono uppercase text-emerald-400">{discoveredSession.status}</span></div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium"
              >
                Done
              </button>
              <button
                type="button"
                onClick={handleDiscover}
                disabled={isSubmitting}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium shadow-md transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSubmitting ? 'animate-spin' : ''}`} />
                <span>Probe & Discover</span>
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleRegister} className="p-5 space-y-4 text-xs">
            {errorMessage && (
              <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-xs">
                {errorMessage}
              </div>
            )}

            <div>
              <label className="block text-slate-300 font-medium mb-1.5">Provider Type *</label>
              <select
                value={providerType}
                onChange={(e) => handleProviderChange(e.target.value as ProviderType)}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
              >
                <option value="chatgpt">ChatGPT Desktop (com.openai.chat)</option>
                <option value="opencode">OpenCode Desktop (dev.opencode.mac)</option>
                <option value="vscode">VS Code / Cursor (com.microsoft.VSCode)</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1.5">Session Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. ChatGPT Planner Instance 2"
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500"
                required
              />
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1.5">Bundle Identifier (macOS)</label>
              <input
                type="text"
                value={bundleIdentifier}
                onChange={(e) => setBundleIdentifier(e.target.value)}
                placeholder="e.g. com.openai.chat"
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !name.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium shadow-md transition-colors"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>Register Session</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
