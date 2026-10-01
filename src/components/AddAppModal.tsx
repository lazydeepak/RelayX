import React, { useState, useEffect } from 'react';
import {
  X,
  Plus,
  Save,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Layers,
  Terminal,
  FileCode,
  Globe,
  Apple,
  Sparkles,
  Command,
} from 'lucide-react';
import { ProviderIntegration } from '../types/relayApi.ts';
import {
  AppRole,
  AppType,
  AppLaunchBehavior,
  APP_INTEGRATION_TEMPLATES,
  AppIntegrationTemplate,
} from '../relay/integrations/types.ts';

interface AddAppModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: Partial<ProviderIntegration>) => Promise<void>;
  editingApp?: ProviderIntegration | null;
}

export const AddAppModal: React.FC<AddAppModalProps> = ({
  isOpen,
  onClose,
  onSave,
  editingApp,
}) => {
  const isEditing = !!editingApp;

  const [activeTab, setActiveTab] = useState<'basic' | 'launch' | 'scripts' | 'capabilities'>('basic');
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const [role, setRole] = useState<AppRole>('worker');
  const [appType, setAppType] = useState<AppType>('app_bundle');
  const [launchBehavior, setLaunchBehavior] = useState<AppLaunchBehavior>('exec_cli');
  const [appPath, setAppPath] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [processName, setProcessName] = useState('');
  const [cliCommand, setCliCommand] = useState('');
  const [serviceUrl, setServiceUrl] = useState('');
  const [windowTitlePattern, setWindowTitlePattern] = useState('');

  // Scripts
  const [launchScript, setLaunchScript] = useState('');
  const [createSessionScript, setCreateSessionScript] = useState('');
  const [openSessionScript, setOpenSessionScript] = useState('');
  const [sendMessageScript, setSendMessageScript] = useState('');
  const [inspectSessionScript, setInspectSessionScript] = useState('');
  const [extractSessionScript, setExtractSessionScript] = useState('');
  const [verificationScript, setVerificationScript] = useState('');

  // Defaults & options
  const [isDefaultPlanner, setIsDefaultPlanner] = useState(false);
  const [isDefaultWorker, setIsDefaultWorker] = useState(false);
  const [isEnabled, setIsEnabled] = useState(true);

  // Capabilities
  const [caps, setCaps] = useState({
    discoverProjects: true,
    discoverSessions: true,
    createSession: true,
    dispatchInstruction: true,
    captureTransportBoundary: false,
    reconcileExactSession: false,
    observeCompletion: true,
    extractResponse: true,
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editingApp) {
      setName(editingApp.name || '');
      setId(editingApp.id || editingApp.providerType || '');
      setDescription(editingApp.description || '');
      setRole(editingApp.role || 'worker');
      setAppType(editingApp.appType || 'app_bundle');
      setLaunchBehavior(editingApp.launchBehavior || 'exec_cli');
      setAppPath(editingApp.appPath || '');
      setBundleId(editingApp.bundleId || editingApp.identity?.bundleId || '');
      setProcessName(editingApp.identity?.processName || '');
      setCliCommand(editingApp.cliCommand || editingApp.identity?.executable || '');
      setServiceUrl(editingApp.serviceUrl || editingApp.identity?.serviceUrl || '');
      setWindowTitlePattern(editingApp.identity?.windowTitlePattern || '');

      setLaunchScript(editingApp.scripts?.launchScript || '');
      setCreateSessionScript(editingApp.scripts?.createSessionScript || '');
      setOpenSessionScript(editingApp.scripts?.openSessionScript || '');
      setSendMessageScript(editingApp.scripts?.sendMessageScript || '');
      setInspectSessionScript(editingApp.scripts?.inspectSessionScript || '');
      setExtractSessionScript(editingApp.scripts?.extractSessionScript || '');
      setVerificationScript(editingApp.scripts?.verificationScript || '');

      setIsDefaultPlanner(!!editingApp.isDefaultPlanner);
      setIsDefaultWorker(!!editingApp.isDefaultWorker);
      setIsEnabled(editingApp.isEnabled ?? true);
      setCaps({
        discoverProjects: editingApp.capabilities?.discoverProjects ?? true,
        discoverSessions: editingApp.capabilities?.discoverSessions ?? true,
        createSession: editingApp.capabilities?.createSession ?? true,
        dispatchInstruction: editingApp.capabilities?.dispatchInstruction ?? true,
        captureTransportBoundary: editingApp.capabilities?.captureTransportBoundary ?? false,
        reconcileExactSession: editingApp.capabilities?.reconcileExactSession ?? false,
        observeCompletion: editingApp.capabilities?.observeCompletion ?? true,
        extractResponse: editingApp.capabilities?.extractResponse ?? true,
      });
      setError(null);
    } else {
      // Default new app state
      setName('');
      setId('');
      setDescription('');
      setRole('worker');
      setAppType('app_bundle');
      setLaunchBehavior('exec_cli');
      setAppPath('');
      setBundleId('');
      setProcessName('');
      setCliCommand('');
      setServiceUrl('');
      setWindowTitlePattern('');

      setLaunchScript('');
      setCreateSessionScript('');
      setOpenSessionScript('');
      setSendMessageScript('');
      setInspectSessionScript('');
      setExtractSessionScript('');
      setVerificationScript('');

      setIsDefaultPlanner(false);
      setIsDefaultWorker(false);
      setIsEnabled(true);
      setCaps({
        discoverProjects: true,
        discoverSessions: true,
        createSession: true,
        dispatchInstruction: true,
        captureTransportBoundary: false,
        reconcileExactSession: false,
        observeCompletion: true,
        extractResponse: true,
      });
      setError(null);
    }
  }, [editingApp, isOpen]);

  const handleApplyTemplate = (tpl: AppIntegrationTemplate) => {
    setName(tpl.defaultConfig.name || tpl.name);
    setId(tpl.defaultConfig.id || '');
    setDescription(tpl.description);
    setRole(tpl.role);
    setAppType(tpl.appType);
    setLaunchBehavior(tpl.launchBehavior);
    setAppPath(tpl.defaultConfig.appPath || '');
    setBundleId(tpl.defaultConfig.bundleId || '');
    setProcessName(tpl.defaultConfig.processName || '');
    setCliCommand(tpl.defaultConfig.cliCommand || '');
    setServiceUrl(tpl.defaultConfig.serviceUrl || '');
    setWindowTitlePattern(tpl.defaultConfig.windowTitlePattern || '');

    setLaunchScript(tpl.defaultConfig.scripts?.launchScript || '');
    setCreateSessionScript(tpl.defaultConfig.scripts?.createSessionScript || '');
    setOpenSessionScript(tpl.defaultConfig.scripts?.openSessionScript || '');
    setSendMessageScript(tpl.defaultConfig.scripts?.sendMessageScript || '');
    setInspectSessionScript(tpl.defaultConfig.scripts?.inspectSessionScript || '');
    setExtractSessionScript(tpl.defaultConfig.scripts?.extractSessionScript || '');
    setVerificationScript(tpl.defaultConfig.scripts?.verificationScript || '');

    if (tpl.defaultConfig.capabilities) {
      setCaps({
        discoverProjects: tpl.defaultConfig.capabilities.discoverProjects ?? true,
        discoverSessions: tpl.defaultConfig.capabilities.discoverSessions ?? true,
        createSession: tpl.defaultConfig.capabilities.createSession ?? true,
        dispatchInstruction: tpl.defaultConfig.capabilities.dispatchInstruction ?? true,
        captureTransportBoundary: tpl.defaultConfig.capabilities.captureTransportBoundary ?? false,
        reconcileExactSession: tpl.defaultConfig.capabilities.reconcileExactSession ?? false,
        observeCompletion: tpl.defaultConfig.capabilities.observeCompletion ?? true,
        extractResponse: tpl.defaultConfig.capabilities.extractResponse ?? true,
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Application Name is required');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await onSave({
        id: id.trim() || undefined,
        name: name.trim(),
        description: description.trim(),
        role,
        appType,
        launchBehavior,
        appPath: appPath.trim() || undefined,
        bundleId: bundleId.trim() || undefined,
        processName: processName.trim() || undefined,
        cliCommand: cliCommand.trim() || undefined,
        serviceUrl: serviceUrl.trim() || undefined,
        scripts: {
          launchScript: launchScript.trim() || undefined,
          createSessionScript: createSessionScript.trim() || undefined,
          openSessionScript: openSessionScript.trim() || undefined,
          sendMessageScript: sendMessageScript.trim() || undefined,
          inspectSessionScript: inspectSessionScript.trim() || undefined,
          extractSessionScript: extractSessionScript.trim() || undefined,
          verificationScript: verificationScript.trim() || undefined,
        },
        isDefaultPlanner: (role === 'planner' || role === 'both') && isDefaultPlanner,
        isDefaultWorker: (role === 'worker' || role === 'both') && isDefaultWorker,
        isEnabled,
        capabilities: caps,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to save application integration');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fade-in select-none">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <span>{isEditing ? `Configure: ${editingApp.name}` : 'Add External Application Integration'}</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Integrate any native Planner or Worker application with replaceable handlers &amp; automation scripts.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Template Quick Picks (Only on New) */}
        {!isEditing && (
          <div className="px-5 py-3 bg-slate-950/60 border-b border-slate-800 overflow-x-auto flex items-center gap-2 text-xs">
            <span className="text-slate-400 text-[11px] font-medium flex items-center gap-1 shrink-0">
              <Sparkles className="w-3.5 h-3.5 text-blue-400" />
              <span>Presets:</span>
            </span>
            {APP_INTEGRATION_TEMPLATES.map((tpl) => (
              <button
                key={tpl.name}
                type="button"
                onClick={() => handleApplyTemplate(tpl)}
                className="px-2.5 py-1 rounded-lg bg-slate-850 hover:bg-slate-800 border border-slate-750 text-slate-300 text-[11px] font-medium transition-colors shrink-0"
              >
                {tpl.name}
              </button>
            ))}
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 bg-slate-950/30 px-5 pt-2">
          <button
            type="button"
            onClick={() => setActiveTab('basic')}
            className={`pb-2.5 px-3 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'basic'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            1. Identity &amp; Role
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('launch')}
            className={`pb-2.5 px-3 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'launch'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            2. App Path &amp; Launch
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('scripts')}
            className={`pb-2.5 px-3 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'scripts'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            3. Automation Scripts
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('capabilities')}
            className={`pb-2.5 px-3 text-xs font-semibold border-b-2 transition-colors ${
              activeTab === 'capabilities'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            4. Capabilities
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5 text-xs">
          {error && (
            <div className="p-3 rounded-lg bg-red-950/40 border border-red-800/60 text-red-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          {activeTab === 'basic' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Application Display Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Claude Desktop, Cursor AI, Local Agent"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (!isEditing && !id) {
                        setId(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
                      }
                    }}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 focus:outline-none focus:border-blue-500 text-xs"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Integration Identifier (slug)</label>
                  <input
                    type="text"
                    disabled={isEditing}
                    placeholder="e.g. cursor, claude_desktop"
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono focus:outline-none focus:border-blue-500 text-xs disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Description</label>
                <input
                  type="text"
                  placeholder="Summary of how this app functions in RelayX orchestration"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 focus:outline-none focus:border-blue-500 text-xs"
                />
              </div>

              {/* Role Selection */}
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <label className="text-slate-300 font-semibold block">Orchestration Role *</label>
                <div className="grid grid-cols-3 gap-3">
                  <button
                    type="button"
                    onClick={() => setRole('planner')}
                    className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-colors ${
                      role === 'planner'
                        ? 'bg-blue-600/20 border-blue-500 text-blue-300'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-850'
                    }`}
                  >
                    <span className="font-bold text-slate-200">Planner</span>
                    <span className="text-[10px] mt-1 text-slate-400">High-level strategic breakdown, review, and instructions.</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setRole('worker')}
                    className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-colors ${
                      role === 'worker'
                        ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-850'
                    }`}
                  >
                    <span className="font-bold text-slate-200">Worker</span>
                    <span className="text-[10px] mt-1 text-slate-400">Code execution, file edits, testing, physical changes.</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setRole('both')}
                    className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-colors ${
                      role === 'both'
                        ? 'bg-purple-600/20 border-purple-500 text-purple-300'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-850'
                    }`}
                  >
                    <span className="font-bold text-slate-200">Both / Flexible</span>
                    <span className="text-[10px] mt-1 text-slate-400">Can act as either Planner or Worker depending on Pair setup.</span>
                  </button>
                </div>
              </div>

              {/* Defaults & Status Flags */}
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                <span className="text-slate-300 font-semibold block uppercase text-[11px] tracking-wider">
                  Default Selection &amp; Availability
                </span>

                <div className="flex flex-col sm:flex-row gap-4 pt-1">
                  {(role === 'planner' || role === 'both') && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isDefaultPlanner}
                        onChange={(e) => setIsDefaultPlanner(e.target.checked)}
                        className="rounded bg-slate-900 border-slate-700 text-blue-600 focus:ring-0"
                      />
                      <span className="text-slate-200 font-medium">Set as Default Planner</span>
                    </label>
                  )}

                  {(role === 'worker' || role === 'both') && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isDefaultWorker}
                        onChange={(e) => setIsDefaultWorker(e.target.checked)}
                        className="rounded bg-slate-900 border-slate-700 text-emerald-600 focus:ring-0"
                      />
                      <span className="text-slate-200 font-medium">Set as Default Worker</span>
                    </label>
                  )}

                  <label className="flex items-center gap-2 cursor-pointer ml-auto">
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={(e) => setIsEnabled(e.target.checked)}
                      className="rounded bg-slate-900 border-slate-700 text-indigo-600 focus:ring-0"
                    />
                    <span className="text-slate-200 font-medium">Enabled</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'launch' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Application Type</label>
                  <select
                    value={appType}
                    onChange={(e) => setAppType(e.target.value as AppType)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-xs focus:outline-none focus:border-blue-500"
                  >
                    <option value="app_bundle">Native macOS App Bundle (.app)</option>
                    <option value="cli_service">CLI Runner / Local HTTP Service Daemon</option>
                    <option value="editor">Code Editor / IDE (VS Code, Cursor, Windsurf)</option>
                    <option value="script">Custom Scripted Controller</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Launch Behavior</label>
                  <select
                    value={launchBehavior}
                    onChange={(e) => setLaunchBehavior(e.target.value as AppLaunchBehavior)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 text-xs focus:outline-none focus:border-blue-500"
                  >
                    <option value="open_bundle">Open macOS Bundle (`open -a / -b`)</option>
                    <option value="exec_cli">Execute CLI Binary directly</option>
                    <option value="applescript">Execute AppleScript Command</option>
                    <option value="service_call">Background HTTP/Socket Service Call</option>
                    <option value="launch_url">Open Browser URL Protocol</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Application Path (macOS .app or binary)</label>
                <input
                  type="text"
                  placeholder="/Applications/Claude.app or /Applications/Cursor.app"
                  value={appPath}
                  onChange={(e) => setAppPath(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-xs focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Bundle Identifier (Optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. com.anthropic.claude-desktop"
                    value={bundleId}
                    onChange={(e) => setBundleId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-xs focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">CLI Executable Name (Optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. cursor, code, opencode"
                    value={cliCommand}
                    onChange={(e) => setCliCommand(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-xs focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Process Name (pgrep target)</label>
                  <input
                    type="text"
                    placeholder="e.g. Claude, Cursor, Code"
                    value={processName}
                    onChange={(e) => setProcessName(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-xs focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Local Service URL (Optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. http://127.0.0.1:4096"
                    value={serviceUrl}
                    onChange={(e) => setServiceUrl(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-xs focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'scripts' && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-blue-950/20 border border-blue-900/40 text-blue-300 text-[11px] space-y-1">
                <p className="font-semibold">Handler Scripts &amp; Macro Automation</p>
                <p className="text-slate-400">
                  RelayX executes these scripts when controlling this app. Supports AppleScript (e.g.{' '}
                  <code>tell application &quot;...&quot;</code>) or shell commands. Placeholders like{' '}
                  <code>{'{projectPath}'}</code>, <code>{'{sessionTitle}'}</code>, <code>{'{instruction}'}</code>, and{' '}
                  <code>{'{externalSessionId}'}</code> are interpolated automatically.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Launch / Focus Script</label>
                <textarea
                  rows={2}
                  placeholder='e.g. tell application "Claude" to activate'
                  value={launchScript}
                  onChange={(e) => setLaunchScript(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-xs focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Create Session Script</label>
                <textarea
                  rows={2}
                  placeholder='e.g. cursor "{projectPath}"'
                  value={createSessionScript}
                  onChange={(e) => setCreateSessionScript(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-xs focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-slate-300 font-semibold">Send Message / Instruction Script</label>
                <textarea
                  rows={3}
                  placeholder={'tell application "System Events" to tell process "App"\n  keystroke "{instruction}"\n  key code 36\nend tell'}
                  value={sendMessageScript}
                  onChange={(e) => setSendMessageScript(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-xs focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Open / Focus Session Script</label>
                  <input
                    type="text"
                    placeholder='open "{sessionUrl}"'
                    value={openSessionScript}
                    onChange={(e) => setOpenSessionScript(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-xs focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-slate-300 font-semibold">Inspect Session Script</label>
                  <input
                    type="text"
                    placeholder='tell application "System Events" to get name of front window'
                    value={inspectSessionScript}
                    onChange={(e) => setInspectSessionScript(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-slate-100 font-mono text-xs focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'capabilities' && (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-emerald-950/20 border border-emerald-900/40 text-emerald-300 text-[11px] space-y-1">
                <p className="font-semibold">Capability Matrix</p>
                <p className="text-slate-400">
                  Define what this integration is capable of doing. RelayX uses this matrix to decide which app to use for specific orchestration tasks.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 pt-1">
                {Object.entries(caps).map(([key, value]) => (
                  <label key={key} className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition-colors cursor-pointer group">
                    <div className="flex flex-col">
                      <span className="text-slate-200 font-bold text-[11px] group-hover:text-white transition-colors">
                        {key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase())}
                      </span>
                      <span className="text-[10px] text-slate-500 font-medium">
                        {key === 'discoverProjects' && 'Find existing projects in the app'}
                        {key === 'discoverSessions' && 'List active session windows'}
                        {key === 'createSession' && 'Initialize a fresh workspace/chat'}
                        {key === 'dispatchInstruction' && 'Send text instructions to the agent'}
                        {key === 'captureTransportBoundary' && 'Establish message sequence watermarks'}
                        {key === 'reconcileExactSession' && 'Verify delivery via side-channel logs'}
                        {key === 'observeCompletion' && 'Detect when the agent finishes working'}
                        {key === 'extractResponse' && 'Pull assistant text back into RelayX'}
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      checked={value}
                      onChange={(e) => setCaps({ ...caps, [key]: e.target.checked })}
                      className="w-4 h-4 rounded bg-slate-850 border-slate-700 text-blue-600 focus:ring-0 focus:ring-offset-0 transition-all"
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Action Footer */}
          <div className="pt-4 border-t border-slate-800 flex items-center justify-between">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-300 text-xs font-semibold transition-colors"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors shadow-lg shadow-blue-900/30"
            >
              <Save className="w-4 h-4" />
              <span>{saving ? 'Saving…' : isEditing ? 'Save Changes' : 'Add Application'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
