import React, { useState, useEffect } from 'react';
import { X, FolderPlus, Search, Cpu, CheckCircle2, AlertCircle, Loader2, Chrome, Folder, RotateCcw, Play } from 'lucide-react';
import { relayBridge } from '../services/relayBridge.ts';
import {
  PlannerDiscoveryState,
  OpenCodeDiscoveryState,
  PLANNER_IDLE_STATE,
  OPENCODE_IDLE_STATE,
  areBothBindingsValid,
  beginPlannerDiscovery,
  beginOpenCodeDiscovery,
  reducePlannerDiscovery,
  reduceOpenCodeDiscovery,
  failPlannerDiscovery,
  failOpenCodeDiscovery,
  selectPlannerCandidate,
  selectOpenCodeWorker,
  applyPlannerUrl,
  applyOpenCodeSession,
} from '../relay/application/stagedDiscovery.ts';

interface AddProjectWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (projectId: string, message: string) => void;
}

type WizardStep = 'folder_pick' | 'discovery';

export const AddProjectWizard: React.FC<AddProjectWizardProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [step, setStep] = useState<WizardStep>('folder_pick');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Discovery Data
  const [projectPath, setProjectPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [gitRoot, setGitRoot] = useState<string | undefined>();

  // Independent per-provider discovery state
  const [planner, setPlanner] = useState<PlannerDiscoveryState>(PLANNER_IDLE_STATE);
  const [opencode, setOpencode] = useState<OpenCodeDiscoveryState>(OPENCODE_IDLE_STATE);

  const [showDiagnostics, setShowDiagnostics] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setStep('folder_pick');
      setIsProcessing(false);
      setError(null);
      setProjectPath('');
      setProjectName('');
      setGitRoot(undefined);
      setPlanner(PLANNER_IDLE_STATE);
      setOpencode(OPENCODE_IDLE_STATE);
      setShowDiagnostics(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const parseChatGPTUrl = (url: string): { projectUrl?: string; sessionId?: string; name?: string } => {
    try {
      const u = new URL(url);
      const path = u.pathname;
      // Extract project/session identifiers from common ChatGPT URL patterns
      const projectIdMatch = url.match(/project[s\/\-]([a-zA-Z0-9\-]+)/i);
      const sessionIdMatch = url.match(/session[s\/\-]([a-zA-Z0-9\-]+)/i);
      const idMatch = url.match(/\/([a-f0-9]{24,})/);
      return {
        projectUrl: url,
        sessionId: sessionIdMatch?.[1] || idMatch?.[1] || undefined,
        name: path.split('/').pop() || undefined,
      };
    } catch {
      return { projectUrl: url, sessionId: undefined };
    }
  };

  const handleParsePlannerUrl = () => {
    const current = planner.url;
    if (!current) {
      setError('Enter a URL or project/session ID before parsing');
      return;
    }
    try {
      const parsed = parseChatGPTUrl(current);
      setPlanner((prev) => applyPlannerUrl(prev, parsed.projectUrl || current));
      setError(null);
    } catch {
      setError('Failed to parse URL');
    }
  };

  const handlePickFolder = async () => {
    setIsProcessing(true);
    setError(null);
    try {
      const res = await relayBridge.selectProjectFolder();
      if (!res.success) {
        if (res.error) setError(res.error);
        setIsProcessing(false);
        return;
      }

      if (res.existingProjectId) {
        onSuccess(res.existingProjectId, `Found existing project for folder: ${res.basename}`);
        onClose();
        return;
      }

      setProjectPath(res.path!);
      setProjectName(res.basename!);
      setGitRoot(res.gitRoot);

      // Go to discovery step; each provider binding is discovered independently.
      setStep('discovery');
      setIsProcessing(false);
    } catch (err: any) {
      setError(err.message);
      setIsProcessing(false);
    }
  };

  /**
   * Independent Planner (ChatGPT) discovery. Discovers and validates ONLY the
   * ChatGPT planner binding. Never touches OpenCode state, so a planner success
   * or failure never erases a confirmed OpenCode binding.
   */
  const discoverPlanner = async () => {
    if (planner.status === 'discovering') return;
    setPlanner((prev) => beginPlannerDiscovery(prev));
    try {
      const res = await relayBridge.discoverChatGPTPlanner(projectName);
      // The reducer rejects activation-only success and requires a validated URL.
      setPlanner((prev) => reducePlannerDiscovery(prev, res));
    } catch (err: any) {
      setPlanner((prev) =>
        failPlannerDiscovery(
          prev,
          err?.message || 'ChatGPT planner discovery errored unexpectedly.',
        ),
      );
    }
  };

  /**
   * Independent OpenCode discovery. Discovers and validates ONLY the OpenCode
   * worker session for the selected repository. Never touches planner state.
   */
  const discoverOpenCode = async () => {
    if (opencode.status === 'discovering') return;
    setOpencode((prev) => beginOpenCodeDiscovery(prev));
    try {
      const res = await relayBridge.discoverOpenCodeSessions(projectPath, gitRoot);
      // The reducer rejects activation-only success and requires a session id.
      setOpencode((prev) => reduceOpenCodeDiscovery(prev, res));
    } catch (err: any) {
      setOpencode((prev) =>
        failOpenCodeDiscovery(
          prev,
          err?.message || 'OpenCode discovery errored unexpectedly.',
        ),
      );
    }
  };

  /**
   * Convenience "Discover Both" action. It ONLY orchestrates the two independent
   * operations in parallel and keeps their individual states separate — it is not
   * an opaque combined discovery. Each provider's state is updated independently,
   * and a failure on one side never erases a success on the other.
   */
  const discoverBoth = async () => {
    await Promise.all([discoverPlanner(), discoverOpenCode()]);
  };

  const areBothDiscovered = areBothBindingsValid(planner, opencode);

  const handleFinalize = async () => {
    if (!projectName.trim()) {
      setError('Project name is required');
      return;
    }
    if (!projectPath) {
      setError('Project folder path is required');
      return;
    }
    if (planner.status !== 'discovered' || !planner.url) {
      setError('A validated ChatGPT planner binding is required before creating the project.');
      return;
    }
    if (opencode.status !== 'discovered' || !opencode.selectedSessionId) {
      setError('An authoritative OpenCode worker session must be bound before creating the project.');
      return;
    }
    setIsProcessing(true);
    setError(null);
    try {
      const res = await relayBridge.finalizeProjectSetup({
        name: projectName,
        description: `Local project: ${projectName}`,
        canonicalPath: projectPath,
        gitRoot,
        plannerUrl: planner.url,
        workerSessionId: opencode.selectedSessionId,
      });

      if (res.success && res.projectId) {
        onSuccess(res.projectId, `Project "${projectName}" setup complete with discovered runtimes.`);
        onClose();
      } else {
        setError(res.error || 'Failed to finalize project setup');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsProcessing(false);
    }
  };

  const plannerStatusDot = () => {
    if (planner.status === 'discovered') return <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />;
    if (planner.status === 'discovering') return <Loader2 className="w-4 h-4 text-blue-400 shrink-0 animate-spin" />;
    if (planner.status === 'failed') return <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />;
    return <AlertCircle className="w-4 h-4 text-slate-600 shrink-0" />;
  };

  const opencodeStatusDot = () => {
    if (opencode.status === 'discovered') return <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />;
    if (opencode.status === 'discovering') return <Loader2 className="w-4 h-4 text-blue-400 shrink-0 animate-spin" />;
    if (opencode.status === 'failed') return <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />;
    return <AlertCircle className="w-4 h-4 text-slate-600 shrink-0" />;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <FolderPlus className="w-5 h-5 text-blue-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Add Project Workflow</h3>
              <p className="text-xs text-slate-400">Independent planner & worker discovery</p>
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
        <div className="p-6 overflow-y-auto">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-100 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step === 'folder_pick' && (
            <div className="space-y-6 text-center">
              <div className="mx-auto w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center">
                <Folder className="w-8 h-8 text-blue-400" />
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-slate-100">Select Local Folder</h4>
                <p className="text-xs text-slate-400 max-w-xs mx-auto">
                  RelayX will resolve the path, git root, and then guide you through independent
                  planner (ChatGPT) and worker (OpenCode) discovery.
                </p>
              </div>
              <button
                onClick={handlePickFolder}
                disabled={isProcessing}
                className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold shadow-md transition-colors disabled:opacity-50"
              >
                {isProcessing ? 'Opening native picker...' : 'Choose Folder...'}
              </button>
            </div>
          )}

          {step === 'discovery' && (
            <div className="space-y-5">
              {/* Planner card */}
              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center shrink-0">
                      <Chrome className={`w-4 h-4 ${planner.status === 'discovered' ? 'text-blue-400' : 'text-slate-400'}`} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-100">Discover Planner</p>
                      <p className="text-[10px] text-slate-500">ChatGPT project binding</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {planner.status === 'discovering' && (
                      <span className="text-[10px] animate-pulse text-blue-400 font-medium">Searching ChatGPT…</span>
                    )}
                    {plannerStatusDot()}
                  </div>
                </div>

                {planner.status === 'discovered' && planner.evidence && (
                  <div className="p-2 rounded bg-emerald-950/30 border border-emerald-800/40 text-[10px] font-mono text-emerald-300 space-y-0.5">
                    <p className="truncate">✔ Validated URL: <span className="text-emerald-200">{planner.url}</span></p>
                    {planner.evidence.projectName && (
                      <p className="text-emerald-300/70">project: {planner.evidence.projectName}</p>
                    )}
                  </div>
                )}

                {planner.status === 'failed' && (
                  <div className="p-2 rounded bg-red-950/60 border border-red-700/50 text-xs font-medium text-red-100 space-y-1">
                    <p className="flex items-start gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-300" />
                      <span>{planner.error || 'ChatGPT planner discovery failed.'}</span>
                    </p>
                  </div>
                )}

                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={planner.url || ''}
                    onChange={(e) =>
                      setPlanner((prev) => ({ ...prev, url: e.target.value || undefined, error: undefined }))
                    }
                    placeholder="Paste ChatGPT project URL or enter project/session ID..."
                    className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500 font-mono truncate"
                    disabled={planner.status === 'discovering'}
                  />
                  <button
                    type="button"
                    onClick={handleParsePlannerUrl}
                    disabled={planner.status === 'discovering' || !planner.url}
                    className="text-[10px] px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200 font-medium transition-colors shrink-0"
                  >
                    Apply URL
                  </button>
                </div>

                {planner.multiple && planner.multiple.length > 0 && !planner.url && (
                  <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 space-y-1.5">
                    <p className="text-[10px] text-slate-400 mb-1 px-1">Select correct project:</p>
                    {planner.multiple.map((p) => (
                      <button
                        key={p.url}
                        type="button"
                        onClick={() => setPlanner((prev) => selectPlannerCandidate(prev, p))}
                        className="w-full text-left p-2 rounded bg-slate-950 hover:bg-slate-800 border border-slate-800 transition-colors group"
                      >
                        <p className="text-[11px] font-medium text-slate-300 group-hover:text-blue-400 truncate">{p.name}</p>
                        <p className="text-[9px] text-slate-600 truncate">{p.url}</p>
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    type="button"
                    onClick={discoverPlanner}
                    disabled={planner.status === 'discovering' || !projectName}
                    className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[10px] font-medium transition-colors flex items-center gap-1"
                  >
                    {planner.status === 'discovering' ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : planner.status === 'discovered' ? (
                      <RotateCcw className="w-3 h-3" />
                    ) : (
                      <Play className="w-3 h-3" />
                    )}
                    <span>{planner.status === 'discovered' ? 'Re-Discover' : planner.status === 'failed' ? 'Retry' : 'Discover Planner'}</span>
                  </button>
                  {planner.status === 'discovered' && (
                    <button
                      type="button"
                      onClick={() => setPlanner(PLANNER_IDLE_STATE)}
                      className="text-[10px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* OpenCode card */}
              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center shrink-0">
                      <Cpu className={`w-4 h-4 ${opencode.status === 'discovered' ? 'text-emerald-400' : 'text-slate-400'}`} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-100">Discover OpenCode</p>
                      <p className="text-[10px] text-slate-500">Worker session binding for this repository</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {opencode.status === 'discovering' && (
                      <span className="text-[10px] animate-pulse text-blue-400 font-medium">Scanning sessions…</span>
                    )}
                    {opencodeStatusDot()}
                  </div>
                </div>

                {opencode.status === 'discovered' && opencode.evidence && (
                  <div className="p-2 rounded bg-emerald-950/30 border border-emerald-800/40 text-[10px] font-mono text-emerald-300 space-y-0.5">
                    <p className="truncate">✔ Session: <span className="text-emerald-200">{opencode.selectedSessionId}</span></p>
                    {opencode.evidence.windowTitle && (
                      <p className="text-emerald-300/70 truncate">window: {opencode.evidence.windowTitle}</p>
                    )}
                    {opencode.evidence.matchedVia && (
                      <p className="text-emerald-300/70">matched via: {opencode.evidence.matchedVia}</p>
                    )}
                  </div>
                )}

                {opencode.status === 'failed' && (
                  <div className="p-2 rounded bg-red-950/60 border border-red-700/50 text-xs font-medium text-red-100 space-y-1">
                    <p className="flex items-start gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-red-300" />
                      <span>{opencode.error || 'OpenCode discovery failed.'}</span>
                    </p>
                  </div>
                )}

                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={opencode.selectedSessionId || ''}
                    onChange={(e) =>
                      setOpencode((prev) => ({
                        ...prev,
                        selectedSessionId: e.target.value || undefined,
                        error: undefined,
                      }))
                    }
                    placeholder="Authoritative OpenCode session ID (e.g. ses_...)..."
                    className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-emerald-500 font-mono truncate"
                    disabled={opencode.status === 'discovering'}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (opencode.selectedSessionId) {
                        setOpencode((prev) => applyOpenCodeSession(prev, prev.selectedSessionId!));
                      }
                    }}
                    disabled={opencode.status === 'discovering' || !opencode.selectedSessionId}
                    className="text-[10px] px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200 font-medium transition-colors shrink-0"
                  >
                    Apply Session
                  </button>
                </div>

                {opencode.workers.length > 1 && (
                  <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1.5">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                      Matching Sessions ({opencode.workers.length}):
                    </p>
                    <div className="space-y-1 max-h-28 overflow-y-auto">
                      {opencode.workers.map((w) => (
                        <button
                          key={w.sessionId}
                          type="button"
                          onClick={() => setOpencode((prev) => selectOpenCodeWorker(prev, w))}
                          className={`w-full text-left p-1.5 rounded text-[11px] border transition-colors flex items-center justify-between gap-2 ${
                            opencode.selectedSessionId === w.sessionId
                              ? 'bg-emerald-950/40 border-emerald-600/50 text-emerald-200'
                              : 'bg-slate-950 hover:bg-slate-800/80 border-slate-800 text-slate-300'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-[10px] font-semibold text-slate-200 truncate">{w.sessionId}</span>
                              {w.matchedVia && (
                                <span className="text-[8px] px-1 py-0.2 rounded bg-slate-800 text-slate-400 border border-slate-700">
                                  {w.matchedVia}
                                </span>
                              )}
                              {w.hasUiCorrelation && (
                                <span className="text-[8px] px-1 py-0.2 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                                  UI window
                                </span>
                              )}
                            </div>
                            {w.workspacePath && (
                              <p className="text-[9px] text-slate-500 font-mono truncate">{w.workspacePath}</p>
                            )}
                          </div>
                          {opencode.selectedSessionId === w.sessionId && (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    type="button"
                    onClick={discoverOpenCode}
                    disabled={opencode.status === 'discovering' || !projectName}
                    className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[10px] font-medium transition-colors flex items-center gap-1"
                  >
                    {opencode.status === 'discovering' ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : opencode.status === 'discovered' ? (
                      <RotateCcw className="w-3 h-3" />
                    ) : (
                      <Play className="w-3 h-3" />
                    )}
                    <span>{opencode.status === 'discovered' ? 'Re-Discover' : opencode.status === 'failed' ? 'Retry' : 'Discover OpenCode'}</span>
                  </button>
                  {opencode.status === 'discovered' && (
                    <button
                      type="button"
                      onClick={() => setOpencode(OPENCODE_IDLE_STATE)}
                      className="text-[10px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setStep('folder_pick')}
                  className="flex-1 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-xs transition-colors"
                >
                  Back
                </button>

                {/* The convenience action only orchestrates the two independent discoveries. */}
                <button
                  type="button"
                  onClick={discoverBoth}
                  disabled={
                    (planner.status === 'discovering' || opencode.status === 'discovering') || !projectName
                  }
                  className="flex-1 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-xs shadow-md transition-colors flex items-center justify-center gap-1.5"
                >
                  <Search className="w-3.5 h-3.5" />
                  <span>Discover Both</span>
                </button>
                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={isProcessing || !areBothDiscovered}
                  className="flex-1 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-xs shadow-md transition-colors"
                >
                  {isProcessing ? 'Setting up...' : 'Confirm & Create Project'}
                </button>
              </div>

              <div className="flex items-center justify-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowDiagnostics(!showDiagnostics)}
                  className="text-[11px] text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition-colors"
                >
                  <span>{showDiagnostics ? '▼ Hide Discovery Diagnostics' : '▶ Show Discovery Diagnostics'}</span>
                </button>
              </div>
              {showDiagnostics && (
                <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-blue-400 text-[10px] uppercase tracking-wider">Discovery Diagnostics</span>
                    <button
                      type="button"
                      onClick={async () => {
                        const text = JSON.stringify({
                          planner: planner.diagnostics || { status: 'Not run or non-darwin' },
                          opencode: opencode.diagnostics || { status: 'Not run' },
                        }, null, 2);
                        try {
                          await navigator.clipboard.writeText(text);
                        } catch {
                          // clipboard unavailable (e.g. non-secure context)
                        }
                      }}
                      className="text-[10px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
                    >
                      Copy all
                    </button>
                  </div>
                  <textarea
                    readOnly
                    value={JSON.stringify({
                      planner: planner.diagnostics || { status: 'Not run or non-darwin' },
                      opencode: opencode.diagnostics || { status: 'Not run' },
                    }, null, 2)}
                    className="w-full h-36 p-2 bg-slate-950 border border-slate-800 rounded-lg text-[10px] font-mono text-slate-300 resize-none overflow-y-auto whitespace-pre"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};