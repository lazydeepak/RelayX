import React, { useState, useEffect } from 'react';
import { X, FolderPlus, Search, Cpu, CheckCircle2, AlertCircle, Chrome, Folder } from 'lucide-react';
import { relayBridge } from '../services/relayBridge.ts';

interface AddProjectWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (projectId: string, message: string) => void;
}

type WizardStep = 'folder_pick' | 'discovery' | 'confirmation';

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
  
  const [plannerUrl, setPlannerUrl] = useState<string | undefined>();
  const [multiplePlanners, setMultiplePlanners] = useState<Array<{ name: string; url: string }> | undefined>();
  const [workerSessionId, setWorkerSessionId] = useState<string | undefined>();
  const [workerWindowTitle, setWorkerWindowTitle] = useState<string | undefined>();
  const [workerMatchVia, setWorkerMatchVia] = useState<string | undefined>();

  const [chatgptDiagnostics, setChatgptDiagnostics] = useState<any>(undefined);
  const [opencodeDiagnostics, setOpencodeDiagnostics] = useState<any>(undefined);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setStep('folder_pick');
      setIsProcessing(false);
      setError(null);
      setProjectPath('');
      setProjectName('');
      setPlannerUrl(undefined);
      setMultiplePlanners(undefined);
      setWorkerSessionId(undefined);
      setWorkerMatchVia(undefined);
      setChatgptDiagnostics(undefined);
      setOpencodeDiagnostics(undefined);
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
    if (!plannerUrl) return;
    const parsed = parseChatGPTUrl(plannerUrl);
    setPlannerUrl(parsed.projectUrl);
    if (parsed.sessionId && !workerSessionId) {
      setWorkerSessionId(parsed.sessionId);
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
      
      // Go to confirmation step; autodetect is manual/action-based, not automatic
      setStep('confirmation');
      setIsProcessing(false);
    } catch (err: any) {
      setError(err.message);
      setIsProcessing(false);
    }
  };

  const performDiscovery = async (name: string, path: string, root?: string) => {
    setStep('discovery');
    setIsProcessing(true);
    try {
      // 1. Resolve ChatGPT via active search procedure
      const plannerRes = await relayBridge.resolveChatGPTProject(name);
      setChatgptDiagnostics(plannerRes.diagnostics);
      if (plannerRes.success) {
        setPlannerUrl(plannerRes.projectUrl);
      } else if (plannerRes.foundMultiple) {
        setMultiplePlanners(plannerRes.foundMultiple);
      }

      // 2. Discover OpenCode Sessions with path correlation
      const workerRes = await relayBridge.discoverOpenCodeSessions(path, root);
      setOpencodeDiagnostics(workerRes.diagnostics);
      if (workerRes.success && workerRes.sessions.length > 0) {
        // Pick the best match (already sorted by score)
        const best = workerRes.sessions[0];
        setWorkerSessionId(best.sessionId);
        setWorkerWindowTitle(best.windowTitle);
        setWorkerMatchVia(best.matchedVia);
      }

      setStep('confirmation');
    } catch (err: any) {
      console.error('Discovery error:', err);
      setStep('confirmation');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFinalize = async () => {
    setIsProcessing(true);
    setError(null);
    try {
      const res = await relayBridge.finalizeProjectSetup({
        name: projectName,
        description: `Local project: ${projectName}`,
        canonicalPath: projectPath,
        gitRoot,
        plannerUrl,
        workerSessionId,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <FolderPlus className="w-5 h-5 text-blue-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Add Project Workflow</h3>
              <p className="text-xs text-slate-400">Automatic macOS discovery & binding</p>
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
        <div className="p-6">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-xs flex items-center gap-2">
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
                  Relay will resolve the path, git root, and search for associated planner/worker sessions.
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
            <div className="space-y-6 text-center py-4">
              <div className="flex justify-center">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full border-4 border-blue-500/20 border-t-blue-500 animate-spin" />
                  <Search className="absolute inset-0 m-auto w-6 h-6 text-blue-400" />
                </div>
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-slate-100">Analyzing Project Context</h4>
                <p className="text-xs text-slate-400">
                  Folder: <span className="text-slate-200 font-mono">{projectName}</span>
                </p>
                <div className="pt-4 space-y-2 max-w-xs mx-auto">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">Probing Chrome (ChatGPT)...</span>
                    <span className="animate-pulse text-blue-400">Active</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-500">Scanning OpenCode sessions...</span>
                    <span className="animate-pulse text-blue-400">Active</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 'confirmation' && (
            <div className="space-y-5">
              <div className="space-y-4">
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Local Identity</span>
                    {gitRoot && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-mono">GIT ROOT</span>}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-100">{projectName}</p>
                    <p className="text-[11px] text-slate-400 font-mono truncate">{projectPath}</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider ml-1">Discovered Bindings</span>
                  
                  <div className="space-y-2">
                    <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center gap-3">
                      <div className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center shrink-0">
                        <Chrome className={`w-4 h-4 ${plannerUrl ? 'text-blue-400' : multiplePlanners ? 'text-amber-400' : 'text-slate-600'}`} />
                      </div>
                      <div className="flex-1 min-w-0 space-y-1">
                        <p className="text-xs font-medium text-slate-200">ChatGPT Planner</p>
                        <div className="flex gap-1.5">
                          <input
                            type="text"
                            value={plannerUrl || ''}
                            onChange={(e) => setPlannerUrl(e.target.value || undefined)}
                            placeholder="Paste ChatGPT project URL or enter project/session ID..."
                            className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500 font-mono truncate"
                          />
                          <button
                            type="button"
                            onClick={handleParsePlannerUrl}
                            className="text-[10px] px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors shrink-0"
                          >
                            Parse URL
                          </button>
                        </div>
                        {multiplePlanners ? (
                          <p className="text-[10px] text-amber-500 font-medium">Ambiguous: {multiplePlanners.length} matches found</p>
                        ) : null}
                      </div>
                      {plannerUrl ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      ) : multiplePlanners ? (
                        <AlertCircle className="w-4 h-4 text-amber-500" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-slate-600" />
                      )}
                    </div>

                    {multiplePlanners && !plannerUrl && (
                      <div className="ml-11 p-2 rounded-lg bg-slate-900 border border-slate-800 space-y-1.5">
                        <p className="text-[10px] text-slate-400 mb-1 px-1">Select correct project:</p>
                        {multiplePlanners.map((p) => (
                          <button
                            key={p.url}
                            onClick={() => setPlannerUrl(p.url)}
                            className="w-full text-left p-2 rounded bg-slate-950 hover:bg-slate-800 border border-slate-800 transition-colors group"
                          >
                            <p className="text-[11px] font-medium text-slate-300 group-hover:text-blue-400 truncate">{p.name}</p>
                            <p className="text-[9px] text-slate-600 truncate">{p.url}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center gap-3">
                    <div className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center shrink-0">
                      <Cpu className={`w-4 h-4 ${workerSessionId ? 'text-blue-400' : 'text-slate-600'}`} />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-medium text-slate-200">OpenCode Worker</p>
                        {workerMatchVia && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 uppercase tracking-tighter font-bold">
                            {workerMatchVia.replace('_', ' ')}
                          </span>
                        )}
                      </div>
                      <input
                        type="text"
                        value={workerWindowTitle || ''}
                        onChange={(e) => setWorkerWindowTitle(e.target.value || undefined)}
                        placeholder="Session / window title (editable)..."
                        className="w-full text-[11px] px-2 py-1 rounded bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500 font-mono truncate"
                      />
                      <input
                        type="text"
                        value={workerSessionId || ''}
                        onChange={(e) => setWorkerSessionId(e.target.value || undefined)}
                        placeholder="Session / project ID (editable)..."
                        className="w-full text-[11px] px-2 py-1 rounded bg-slate-950 border border-slate-700 text-slate-200 focus:outline-none focus:border-blue-500 font-mono truncate"
                      />
                    </div>
                    {workerSessionId ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-slate-600" />
                    )}
                  </div>
                </div>

                <div className="pt-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => performDiscovery(projectName, projectPath, gitRoot)}
                    disabled={isProcessing}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium shadow-md transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <Search className="w-3.5 h-3.5" />
                    <span>Autodetect</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDiagnostics(!showDiagnostics)}
                    className="text-[11px] text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1 transition-colors"
                  >
                    <span>{showDiagnostics ? '▼ Hide Discovery Diagnostics' : '▶ Show Discovery Diagnostics'}</span>
                  </button>
                  {showDiagnostics && (
                    <div className="mt-2 p-3 bg-slate-950 border border-slate-800 rounded-lg text-[10px] font-mono text-slate-300 space-y-3 max-h-52 overflow-y-auto">
                      <div>
                        <p className="font-semibold text-blue-400 mb-1">ChatGPT Diagnostics:</p>
                        <pre className="whitespace-pre-wrap">{JSON.stringify(chatgptDiagnostics || { status: 'Not run or non-darwin' }, null, 2)}</pre>
                      </div>
                      <div>
                        <p className="font-semibold text-blue-400 mb-1">OpenCode Diagnostics:</p>
                        <pre className="whitespace-pre-wrap">{JSON.stringify(opencodeDiagnostics || { status: 'Not run' }, null, 2)}</pre>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setStep('folder_pick')}
                  className="flex-1 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-xs transition-colors"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={isProcessing}
                  className="flex-1 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs shadow-md transition-colors disabled:opacity-50"
                >
                  {isProcessing ? 'Setting up...' : 'Confirm & Create Project'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
