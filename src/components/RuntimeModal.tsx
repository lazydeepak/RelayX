import React, { useState, useEffect } from 'react';
import {
  X,
  Cpu,
  Search,
  PlusCircle,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Archive,
  Check,
  Shield,
  ExternalLink,
  Terminal,
  FolderGit2,
  Radio,
} from 'lucide-react';
import { UIRuntimeSession, ProviderType, UIProject } from '../types/ui.ts';
import {
  ProviderIntegration,
  WorkerChoice,
  ChatGPTConversationChoice,
} from '../types/relayApi.ts';
import { relayBridge } from '../services/relayBridge.ts';

export type RuntimeModalMode = 'discover' | 'register' | 'archive';

interface RuntimeModalProps {
  isOpen: boolean;
  mode: RuntimeModalMode;
  session?: UIRuntimeSession | null;
  projects?: UIProject[];
  onClose: () => void;
  onSuccess: (message: string) => void;
  onRefresh?: () => void;
}

export const RuntimeModal: React.FC<RuntimeModalProps> = ({
  isOpen,
  mode,
  session,
  projects = [],
  onClose,
  onSuccess,
  onRefresh,
}) => {
  const [activeTab, setActiveTab] = useState<'integrations' | 'sessions'>('integrations');
  const [providerType, setProviderType] = useState<ProviderType>('chatgpt');
  const [integrations, setIntegrations] = useState<ProviderIntegration[]>([]);
  const [isVerifying, setIsVerifying] = useState(false);

  // Manual registration state
  const [name, setName] = useState('');
  const [externalSessionId, setExternalSessionId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [archiveReason, setArchiveReason] = useState('');

  // Discovered sessions state
  const [discoveryProjectId, setDiscoveryProjectId] = useState('');
  const [discoveredWorkers, setDiscoveredWorkers] = useState<WorkerChoice[]>([]);
  const [discoveredConversations, setDiscoveredConversations] = useState<ChatGPTConversationChoice[]>([]);
  const [isDiscoveringSessions, setIsDiscoveringSessions] = useState(false);
  const [discoveryNote, setDiscoveryNote] = useState<string | null>(null);

  const activeProjects = projects.filter((p) => p.status !== 'archived');

  const loadIntegrations = async () => {
    try {
      const list = await relayBridge.listIntegrations();
      setIntegrations(list);
    } catch (err: any) {
      console.error('Failed to load integrations:', err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setErrorMessage(null);
      setDiscoveryNote(null);
      loadIntegrations();

      const defaultProj = activeProjects[0]?.id || '';
      setSelectedProjectId(defaultProj);
      setDiscoveryProjectId(defaultProj);

      if (mode === 'register') {
        setName('');
        setExternalSessionId('');
        setProviderType('chatgpt');
      } else if (mode === 'archive') {
        setArchiveReason('');
      } else if (mode === 'discover') {
        setActiveTab('integrations');
      }
    }
  }, [isOpen, mode, session]);

  // Load discovered sessions when project or provider changes in discovery tab
  useEffect(() => {
    if (!(isOpen && mode === 'discover' && activeTab === 'sessions' && discoveryProjectId)) return;

    let cancelled = false;
    setIsDiscoveringSessions(true);
    setDiscoveryNote(null);

    (async () => {
      try {
        if (providerType === 'opencode') {
          const res = await relayBridge.enumerateWorkerChoices(discoveryProjectId);
          if (cancelled) return;
          if (res.ok) {
            setDiscoveredWorkers(res.choices);
            if (res.discovery && !res.discovery.ok) {
              setDiscoveryNote(res.discovery.reason || 'OpenCode discovery reported degraded status');
            }
          } else {
            setDiscoveredWorkers([]);
            setDiscoveryNote(res.error || 'Worker enumeration failed');
          }
        } else if (providerType === 'chatgpt') {
          const res = await relayBridge.enumerateChatGPTConversations(discoveryProjectId);
          if (cancelled) return;
          if (res.ok) {
            setDiscoveredConversations(res.conversations);
          } else {
            setDiscoveredConversations([]);
            setDiscoveryNote(res.error || 'ChatGPT conversation registry not available');
          }
        } else {
          setDiscoveredWorkers([]);
          setDiscoveredConversations([]);
          setDiscoveryNote('VS Code does not expose multi-session enumeration. It tracks active workspace window context.');
        }
      } catch (err: any) {
        if (!cancelled) setDiscoveryNote(err?.message || 'Failed to enumerate external sessions');
      } finally {
        if (!cancelled) setIsDiscoveringSessions(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, mode, activeTab, discoveryProjectId, providerType]);

  if (!isOpen) return null;

  const handleVerifyIntegration = async (type: ProviderType) => {
    setIsVerifying(true);
    setErrorMessage(null);
    try {
      const updated = await relayBridge.verifyIntegration(type);
      setIntegrations((prev) => prev.map((item) => (item.providerType === type ? updated : item)));
      onSuccess(`Verified ${updated.name}: ${updated.status.toUpperCase()}`);
    } catch (err: any) {
      setErrorMessage(err.message || 'Verification failed');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleRecheckAll = async () => {
    setIsVerifying(true);
    setErrorMessage(null);
    try {
      const updated = await relayBridge.recheckAllIntegrations();
      setIntegrations(updated);
      onSuccess('All provider integrations rechecked');
    } catch (err: any) {
      setErrorMessage(err.message || 'Recheck failed');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleAdoptExternalWorker = async (sessionId: string) => {
    if (!discoveryProjectId) {
      setErrorMessage('Select a project before adopting an external session');
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await relayBridge.adoptOpenCodeSession(discoveryProjectId, sessionId, undefined);
      onSuccess(`External OpenCode session "${sessionId}" adopted and bound to project`);
      if (onRefresh) onRefresh();
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'Adoption failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAdoptChatGPTConversation = async (conv: ChatGPTConversationChoice) => {
    if (!discoveryProjectId) {
      setErrorMessage('Select a project before adopting an external conversation');
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const sessionName = `ChatGPT Conversation ${conv.conversationId.slice(0, 8)}`;
      await relayBridge.registerRuntimeSession(
        'chatgpt',
        sessionName,
        conv.conversationId,
        discoveryProjectId,
      );
      onSuccess(`ChatGPT conversation "${conv.conversationId.slice(0, 8)}…" adopted and bound to project`);
      if (onRefresh) onRefresh();
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to adopt conversation');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMessage('Session name is required');
      return;
    }
    if (!externalSessionId.trim()) {
      setErrorMessage('Concrete external session identity (e.g. ses_* or conversation URL) is required');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      if (providerType === 'opencode' && selectedProjectId) {
        // Authoritative adoption
        await relayBridge.adoptOpenCodeSession(selectedProjectId, externalSessionId.trim(), name.trim());
      } else {
        // Registration with concrete external session identity and optional project association
        await relayBridge.registerRuntimeSession(
          providerType,
          name.trim(),
          externalSessionId.trim(),
          selectedProjectId || undefined,
        );
      }
      onSuccess(`Runtime session "${name.trim()}" registered`);
      if (onRefresh) onRefresh();
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
      if (onRefresh) onRefresh();
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to archive runtime session');
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedIntegration = integrations.find((i) => i.providerType === providerType);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60 shrink-0">
          <div className="flex items-center gap-2.5">
            {mode === 'discover' && <Cpu className="w-5 h-5 text-emerald-400" />}
            {mode === 'register' && <PlusCircle className="w-5 h-5 text-blue-400" />}
            {mode === 'archive' && <Archive className="w-5 h-5 text-amber-400" />}
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                {mode === 'discover' && 'Provider Integrations & Session Discovery'}
                {mode === 'register' && 'Register Concrete Runtime Session'}
                {mode === 'archive' && 'Archive Runtime Session'}
              </h3>
              <p className="text-xs text-slate-400">
                {mode === 'discover' && 'Inspect provider status, capabilities, and adopt verified external sessions'}
                {mode === 'register' && 'Register actual external session identity with integration & project binding'}
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

        {/* Mode Discover: Sub-tabs */}
        {mode === 'discover' && (
          <div className="px-5 pt-3 border-b border-slate-800 bg-slate-950/40 flex items-center gap-4 text-xs font-semibold shrink-0">
            <button
              onClick={() => setActiveTab('integrations')}
              className={`pb-2.5 border-b-2 transition-colors flex items-center gap-1.5 ${
                activeTab === 'integrations'
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              <span>Integrations &amp; Capabilities</span>
            </button>
            <button
              onClick={() => setActiveTab('sessions')}
              className={`pb-2.5 border-b-2 transition-colors flex items-center gap-1.5 ${
                activeTab === 'sessions'
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Search className="w-3.5 h-3.5" />
              <span>Discover External Sessions</span>
            </button>
          </div>
        )}

        {/* Content body */}
        <div className="p-5 overflow-y-auto space-y-4 text-xs flex-1">
          {errorMessage && (
            <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-xs">
              {errorMessage}
            </div>
          )}

          {mode === 'archive' && (
            <form onSubmit={handleArchive} className="space-y-4">
              <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                <div className="flex items-center gap-2 text-amber-400 font-semibold">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Archiving Runtime: {session?.name}</span>
                </div>
                <p className="text-slate-300 leading-relaxed">
                  Archiving safely isolates this session record while preserving all historical checkpoints and activity.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-400 font-medium">Archive Reason (Optional)</label>
                <textarea
                  value={archiveReason}
                  onChange={(e) => setArchiveReason(e.target.value)}
                  placeholder="e.g. Session completed, worker rotated, or environment upgraded"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500 transition-colors h-24 resize-none"
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
                  disabled={isSubmitting}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium shadow-md transition-colors"
                >
                  <Archive className="w-3.5 h-3.5" />
                  <span>Confirm Archive</span>
                </button>
              </div>
            </form>
          )}

          {mode === 'discover' && activeTab === 'integrations' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-slate-200 font-semibold text-sm">Provider Integrations Lifecycle</h4>
                  <p className="text-slate-400 text-[11px]">
                    Configure → Verify → Recheck: Host permissions, application identities, and capability truth.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleRecheckAll}
                  disabled={isVerifying}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 text-xs font-medium transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-blue-400 ${isVerifying ? 'animate-spin' : ''}`} />
                  <span>Recheck All</span>
                </button>
              </div>

              {/* Integration Selection Cards */}
              <div className="grid grid-cols-3 gap-3">
                {(['chatgpt', 'opencode', 'vscode'] as ProviderType[]).map((type) => {
                  const integ = integrations.find((i) => i.providerType === type);
                  const isSelected = providerType === type;
                  const isVerified = integ?.status === 'verified';
                  const isDegraded = integ?.status === 'degraded';

                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setProviderType(type)}
                      className={`p-3 rounded-xl border text-left transition-all relative ${
                        isSelected
                          ? 'bg-slate-850 border-blue-500/80 shadow-md ring-1 ring-blue-500/30'
                          : 'bg-slate-950/80 border-slate-800 hover:bg-slate-900'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-semibold text-slate-200 uppercase text-[11px]">
                          {type}
                        </span>
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase border ${
                            isVerified
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                              : isDegraded
                              ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                              : 'bg-slate-800 text-slate-400 border-slate-700'
                          }`}
                        >
                          {integ?.status || 'Unknown'}
                        </span>
                      </div>
                      <div className="text-slate-300 font-medium text-xs truncate">
                        {integ?.name || type}
                      </div>
                      <div className="text-slate-500 text-[10px] mt-1 capitalize">
                        Role: {integ?.role || 'worker'}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Detailed Selected Integration Inspector */}
              {selectedIntegration && (
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                    <div>
                      <h5 className="font-bold text-slate-100 text-sm flex items-center gap-2">
                        <span>{selectedIntegration.name}</span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded font-semibold uppercase ${
                            selectedIntegration.status === 'verified'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                              : selectedIntegration.status === 'degraded'
                              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                              : 'bg-slate-800 text-slate-400 border border-slate-700'
                          }`}
                        >
                          {selectedIntegration.status}
                        </span>
                      </h5>
                      <p className="text-slate-400 text-[11px] mt-0.5 font-mono">
                        {selectedIntegration.lastVerificationResult?.message || 'Ready for verification check'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleVerifyIntegration(providerType)}
                      disabled={isVerifying}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs transition-colors shadow-sm"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isVerifying ? 'animate-spin' : ''}`} />
                      <span>Verify Now</span>
                    </button>
                  </div>

                  {/* Identity & Host Requirements */}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="p-3 rounded-lg bg-slate-900 border border-slate-800/80 space-y-2">
                      <div className="text-slate-400 font-semibold uppercase text-[10px] tracking-wider">
                        App &amp; Service Identity
                      </div>
                      <div className="space-y-1 text-[11px]">
                        <div className="flex justify-between">
                          <span className="text-slate-400">Kind:</span>
                          <span className="font-mono text-slate-200">{selectedIntegration.identity.kind}</span>
                        </div>
                        {selectedIntegration.identity.bundleId && (
                          <div className="flex justify-between">
                            <span className="text-slate-400">Bundle ID:</span>
                            <span className="font-mono text-slate-300 text-[10px] truncate max-w-[150px]">
                              {selectedIntegration.identity.bundleId}
                            </span>
                          </div>
                        )}
                        {selectedIntegration.identity.executable && (
                          <div className="flex justify-between">
                            <span className="text-slate-400">CLI:</span>
                            <span className="font-mono text-emerald-400">{selectedIntegration.identity.executable}</span>
                          </div>
                        )}
                        {selectedIntegration.identity.serviceUrl && (
                          <div className="flex justify-between">
                            <span className="text-slate-400">Service:</span>
                            <span className="font-mono text-blue-400 text-[10px]">{selectedIntegration.identity.serviceUrl}</span>
                          </div>
                        )}
                        {selectedIntegration.identity.detectedPid && (
                          <div className="flex justify-between">
                            <span className="text-slate-400">Host PID:</span>
                            <span className="font-mono text-slate-200">{selectedIntegration.identity.detectedPid}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="p-3 rounded-lg bg-slate-900 border border-slate-800/80 space-y-2">
                      <div className="text-slate-400 font-semibold uppercase text-[10px] tracking-wider">
                        Host Requirements
                      </div>
                      <div className="space-y-1 text-[11px]">
                        <div className="flex justify-between items-center">
                          <span className="text-slate-400">Accessibility:</span>
                          <span className={`font-semibold ${selectedIntegration.requirements.accessibilityGranted ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {selectedIntegration.requirements.accessibilityGranted ? '✓ Granted' : 'Required'}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-slate-400">Apple Events:</span>
                          <span className={`font-semibold ${selectedIntegration.requirements.systemEventsAvailable ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {selectedIntegration.requirements.systemEventsAvailable ? '✓ Active' : 'Required'}
                          </span>
                        </div>
                        {selectedIntegration.requirements.serviceRunning !== undefined && (
                          <div className="flex justify-between items-center">
                            <span className="text-slate-400">Service Socket:</span>
                            <span className={`font-semibold ${selectedIntegration.requirements.serviceRunning ? 'text-emerald-400' : 'text-slate-500'}`}>
                              {selectedIntegration.requirements.serviceRunning ? '✓ Reachable' : 'Inactive'}
                            </span>
                          </div>
                        )}
                        {selectedIntegration.requirements.cliInstalled !== undefined && (
                          <div className="flex justify-between items-center">
                            <span className="text-slate-400">CLI In PATH:</span>
                            <span className={`font-semibold ${selectedIntegration.requirements.cliInstalled ? 'text-emerald-400' : 'text-slate-500'}`}>
                              {selectedIntegration.requirements.cliInstalled ? '✓ Found' : 'Missing'}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Capability Matrix */}
                  <div className="space-y-2">
                    <div className="text-slate-400 font-semibold uppercase text-[10px] tracking-wider">
                      Authoritative Capability Matrix
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {Object.entries(selectedIntegration.capabilities).map(([capName, isSupported]) => (
                        <div
                          key={capName}
                          className={`p-2 rounded-lg border text-center transition-all ${
                            isSupported
                              ? 'bg-emerald-950/20 border-emerald-500/20 text-emerald-300'
                              : 'bg-slate-900/50 border-slate-800 text-slate-500 opacity-60'
                          }`}
                        >
                          <div className="text-[10px] font-semibold mb-0.5">
                            {isSupported ? '✓ Supported' : '— Not Implemented'}
                          </div>
                          <div className="text-[10px] font-mono text-slate-300 truncate" title={capName}>
                            {capName}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === 'discover' && activeTab === 'sessions' && (
            <div className="space-y-4">
              <div>
                <h4 className="text-slate-200 font-semibold text-sm">Discover External Sessions</h4>
                <p className="text-slate-400 text-[11px]">
                  Integrations expose external sessions; they do not themselves become runtime sessions. Adopt concrete sessions below.
                </p>
              </div>

              {/* Project & Provider Filter Bar */}
              <div className="grid grid-cols-2 gap-3 p-3 rounded-lg bg-slate-950 border border-slate-800">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Target Project *</label>
                  <select
                    value={discoveryProjectId}
                    onChange={(e) => setDiscoveryProjectId(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs"
                  >
                    {activeProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Provider Integration</label>
                  <select
                    value={providerType}
                    onChange={(e) => setProviderType(e.target.value as ProviderType)}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs uppercase"
                  >
                    <option value="opencode">OpenCode Worker</option>
                    <option value="chatgpt">ChatGPT Planner</option>
                    <option value="vscode">VS Code Worker</option>
                  </select>
                </div>
              </div>

              {discoveryNote && (
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-amber-300 text-[11px]">
                  {discoveryNote}
                </div>
              )}

              {/* Discovered OpenCode Sessions List */}
              {providerType === 'opencode' && (
                <div className="space-y-2">
                  <div className="text-slate-400 font-medium text-[11px]">
                    Directory-Scoped OpenCode Sessions:
                  </div>
                  {isDiscoveringSessions ? (
                    <div className="p-6 text-center text-slate-500 font-mono text-xs">
                      <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-slate-400" />
                      Scanning project directory via OpenCode service/CLI…
                    </div>
                  ) : discoveredWorkers.length === 0 ? (
                    <div className="p-6 rounded-lg bg-slate-950 border border-slate-800 text-center text-slate-500 text-xs">
                      No active OpenCode sessions discovered for this project workspace.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                      {discoveredWorkers.map((choice, idx) => {
                        const isDiscovered = choice.kind === 'discovered';
                        const id = isDiscovered ? choice.sessionId : choice.runtimeId;
                        const title = isDiscovered ? (choice.sessionTitle || choice.sessionId) : choice.name;

                        return (
                          <div
                            key={id + idx}
                            className="p-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between"
                          >
                            <div className="min-w-0 flex-1 mr-3">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-slate-200 truncate">{title}</span>
                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-emerald-400 border border-emerald-500/20">
                                  {isDiscovered ? choice.sessionId : choice.externalSessionId || 'Registered'}
                                </span>
                              </div>
                              {isDiscovered && choice.workspacePath && (
                                <p className="text-[10px] text-slate-500 font-mono truncate mt-0.5">
                                  {choice.workspacePath}
                                </p>
                              )}
                            </div>
                            {isDiscovered ? (
                              <button
                                type="button"
                                onClick={() => handleAdoptExternalWorker(choice.sessionId)}
                                disabled={isSubmitting}
                                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-xs transition-colors shrink-0"
                              >
                                Adopt Session
                              </button>
                            ) : (
                              <span className="text-[10px] font-semibold text-slate-400 px-2 py-1 bg-slate-900 rounded">
                                Already Registered
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Discovered ChatGPT Conversations List */}
              {providerType === 'chatgpt' && (
                <div className="space-y-2">
                  <div className="text-slate-400 font-medium text-[11px]">
                    Project-Scoped ChatGPT Conversations:
                  </div>
                  {isDiscoveringSessions ? (
                    <div className="p-6 text-center text-slate-500 font-mono text-xs">
                      <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2 text-slate-400" />
                      Querying project conversation registry…
                    </div>
                  ) : discoveredConversations.length === 0 ? (
                    <div className="p-6 rounded-lg bg-slate-950 border border-slate-800 text-center text-slate-500 text-xs">
                      No registered or observed ChatGPT conversations found for this project.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                      {discoveredConversations.map((conv) => (
                        <div
                          key={conv.conversationId}
                          className="p-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between"
                        >
                          <div className="min-w-0 flex-1 mr-3">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-slate-200 truncate">
                                Conversation {conv.conversationId.slice(0, 8)}…
                              </span>
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-purple-400 border border-purple-500/20">
                                {conv.source}
                              </span>
                            </div>
                            <p className="text-[10px] text-slate-500 font-mono truncate mt-0.5">
                              {conv.url}
                            </p>
                          </div>
                          {!conv.boundRuntimeId ? (
                            <button
                              type="button"
                              onClick={() => handleAdoptChatGPTConversation(conv)}
                              disabled={isSubmitting}
                              className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium text-xs transition-colors shrink-0"
                            >
                              Adopt Conversation
                            </button>
                          ) : (
                            <span className="text-[10px] font-semibold text-slate-400 px-2 py-1 bg-slate-900 rounded">
                              Bound
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {mode === 'register' && (
            <form onSubmit={handleRegister} className="space-y-4">
              <div>
                <label className="block text-slate-300 font-medium mb-1.5">Select Integration *</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['chatgpt', 'opencode', 'vscode'] as ProviderType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setProviderType(type)}
                      className={`p-3 rounded-lg border text-center transition-colors ${
                        providerType === type
                          ? 'bg-blue-600/20 border-blue-500 text-blue-300 font-semibold'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-900'
                      }`}
                    >
                      <span className="uppercase text-[11px] block">{type}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1.5">Associated Project</label>
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500 text-xs"
                >
                  <option value="">(None / Unassigned)</option>
                  {activeProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1.5">Concrete Session Identity *</label>
                <input
                  type="text"
                  value={externalSessionId}
                  onChange={(e) => setExternalSessionId(e.target.value)}
                  placeholder={
                    providerType === 'chatgpt'
                      ? 'https://chatgpt.com/g/g-p-.../c/...'
                      : providerType === 'opencode'
                      ? 'ses_...'
                      : 'Workspace path or window identifier'
                  }
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500 font-mono text-xs"
                  required
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Concrete external conversation ID or URL. Provider bundle IDs are never used as session identities.
                </p>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1.5">Session Display Title *</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Core OpenCode Worker"
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500 text-xs"
                  required
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
                  disabled={isSubmitting || !name.trim() || !externalSessionId.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium shadow-md transition-colors"
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  <span>Register Concrete Session</span>
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Footer */}
        {mode === 'discover' && (
          <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/60 flex items-center justify-end shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-200 font-medium text-xs transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
