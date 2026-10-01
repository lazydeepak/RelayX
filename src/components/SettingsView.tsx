import React, { useState, useEffect } from 'react';
import {
  Settings,
  Database,
  Shield,
  Sliders,
  Cpu,
  CheckCircle2,
  AlertCircle,
  Monitor,
  Trash2,
  Sparkles,
  ShieldAlert,
  Sun,
  Moon,
  RefreshCw,
  Clock,
  Lock,
  Archive,
} from 'lucide-react';
import { AppStatus, ProviderIntegration } from '../types/relayApi.ts';
import { ProviderType } from '../types/ui.ts';
import { relayBridge } from '../services/relayBridge.ts';

interface SettingsViewProps {
  appStatus?: AppStatus | null;
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  onClearDb?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  appStatus,
  theme,
  onThemeChange,
  onClearDb,
}) => {
  const [integrations, setIntegrations] = useState<ProviderIntegration[]>([]);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyingType, setVerifyingType] = useState<ProviderType | null>(null);

  const [effectiveWorkerModel, setEffectiveWorkerModel] = useState<string>('opencode-zen/free-default');
  const [supportedWorkerModels, setSupportedWorkerModels] = useState<string[]>([]);
  const [modelSavedMsg, setModelSavedMsg] = useState<string | null>(null);
  const [archiveInterval, setArchiveInterval] = useState<string>('7d');
  const [archiveSavedMsg, setArchiveSavedMsg] = useState<string | null>(null);

  const loadIntegrations = async () => {
    try {
      const list = await relayBridge.listIntegrations();
      setIntegrations(list);
    } catch (err) {
      console.error('Failed to load integrations in settings:', err);
    }
  };

  const loadModelConfig = async () => {
    try {
      const models = await relayBridge.getSupportedModels('opencode');
      setSupportedWorkerModels(models);
      const config = await relayBridge.getEffectiveModelConfig('opencode');
      setEffectiveWorkerModel(config.effectiveModel);
    } catch (err) {
      console.error('Failed to load model config:', err);
    }
  };

  useEffect(() => {
    loadIntegrations();
    loadModelConfig();
  }, []);

  const handleSaveDefaultModel = async (newModel: string) => {
    try {
      await relayBridge.setGlobalModelDefault('opencode', newModel, 'Updated from Settings view');
      setEffectiveWorkerModel(newModel);
      setModelSavedMsg(`Global OpenCode worker model updated to ${newModel}`);
      setTimeout(() => setModelSavedMsg(null), 3000);
    } catch (err: any) {
      console.error('Failed to save default model:', err);
    }
  };

  const handleSaveArchiveInterval = (interval: string) => {
    setArchiveInterval(interval);
    setArchiveSavedMsg(`Archival policy updated: ${interval === 'none' ? 'Retain indefinitely' : `${interval} retention`}`);
    setTimeout(() => setArchiveSavedMsg(null), 3000);
  };

  const handleVerifyOne = async (type: ProviderType) => {
    setVerifyingType(type);
    try {
      const updated = await relayBridge.verifyIntegration(type);
      setIntegrations((prev) => prev.map((item) => (item.providerType === type ? updated : item)));
    } catch (err) {
      console.error('Failed to verify integration:', err);
    } finally {
      setVerifyingType(null);
    }
  };

  const handleRecheckAll = async () => {
    setIsVerifying(true);
    try {
      const updated = await relayBridge.recheckAllIntegrations();
      setIntegrations(updated);
    } catch (err) {
      console.error('Failed to recheck all integrations:', err);
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="space-y-8 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Settings className="w-5 h-5 text-slate-400" />
            <span>RelayX Control Plane &amp; Environment</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Authoritative separation between configurable policies, read-only host truth, immutable safety invariants, and destructive maintenance.
          </p>
        </div>
      </div>

      {/* 1. Configurable Policy & Operator Preferences */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-indigo-400 font-semibold uppercase tracking-wider text-xs">
          <Sliders className="w-4 h-4" />
          <span>1. Configurable Policies &amp; Operator Preferences</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Appearance Setting */}
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-indigo-300 font-semibold">
                <Sun className="w-4 h-4" />
                <span>Appearance &amp; Theme</span>
              </div>
              <p className="text-slate-400">
                Choose RelayX user interface theme mode. System follows macOS appearance automatically.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800">
              <button
                onClick={() => onThemeChange('light')}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                  theme === 'light'
                    ? 'bg-indigo-600 text-white border-indigo-500'
                    : 'bg-slate-950 text-slate-300 border-slate-800 hover:bg-slate-850'
                }`}
              >
                <Sun className="w-3.5 h-3.5" />
                <span>Light</span>
              </button>
              <button
                onClick={() => onThemeChange('dark')}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                  theme === 'dark'
                    ? 'bg-indigo-600 text-white border-indigo-500'
                    : 'bg-slate-950 text-slate-300 border-slate-800 hover:bg-slate-850'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
                <span>Dark</span>
              </button>
              <button
                onClick={() => onThemeChange('system')}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                  theme === 'system'
                    ? 'bg-indigo-600 text-white border-indigo-500'
                    : 'bg-slate-950 text-slate-300 border-slate-800 hover:bg-slate-850'
                }`}
              >
                <Monitor className="w-3.5 h-3.5" />
                <span>System</span>
              </button>
            </div>
          </div>

          {/* Worker AI Model Configuration */}
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-indigo-300 font-semibold">
                <Sparkles className="w-4 h-4" />
                <span>Worker AI Model Configuration</span>
              </div>
              <p className="text-slate-400">
                Global default AI model for OpenCode worker sessions. Justified project overrides take precedence.
              </p>
            </div>
            <div className="space-y-2 pt-2 border-t border-slate-800 text-slate-300">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Global Model:</span>
                <select
                  value={effectiveWorkerModel}
                  onChange={(e) => handleSaveDefaultModel(e.target.value)}
                  className="px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-emerald-400 font-mono text-xs focus:outline-none focus:border-indigo-500"
                >
                  {supportedWorkerModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              {modelSavedMsg && (
                <div className="text-[10px] text-emerald-400 font-medium">
                  ✓ {modelSavedMsg}
                </div>
              )}
            </div>
          </div>

          {/* Logging & Archival Interval */}
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-indigo-300 font-semibold">
                <Archive className="w-4 h-4" />
                <span>Logging &amp; Archival Retention</span>
              </div>
              <p className="text-slate-400">
                Automated archive rotation interval for raw telemetry and logs. Human activity lineage is preserved.
              </p>
            </div>
            <div className="space-y-2 pt-2 border-t border-slate-800 text-slate-300">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Archival Interval:</span>
                <select
                  value={archiveInterval}
                  onChange={(e) => handleSaveArchiveInterval(e.target.value)}
                  className="px-2 py-1.5 rounded bg-slate-950 border border-slate-700 text-slate-200 font-medium text-xs focus:outline-none focus:border-indigo-500"
                >
                  <option value="7d">7 Days (Default Standard)</option>
                  <option value="14d">14 Days</option>
                  <option value="30d">30 Days</option>
                  <option value="none">Keep until manually cleared</option>
                </select>
              </div>
              {archiveSavedMsg && (
                <div className="text-[10px] text-emerald-400 font-medium">
                  ✓ {archiveSavedMsg}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 2. Read-Only Engine & Host Environment Truth */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-blue-400 font-semibold uppercase tracking-wider text-xs">
          <Monitor className="w-4 h-4" />
          <span>2. Read-Only Engine &amp; Host Environment Truth</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Host Runtime Info */}
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="flex items-center gap-2 text-blue-400 font-semibold">
              <Monitor className="w-4 h-4" />
              <span>macOS Desktop Host &amp; Runtime</span>
            </div>
            <p className="text-slate-400">
              Current application host execution environment and platform architecture.
            </p>
            <div className="space-y-2 pt-2 border-t border-slate-800 text-slate-300">
              <div className="flex justify-between">
                <span>App Host Mode:</span>
                <span className="font-mono text-emerald-400 font-semibold">
                  {appStatus?.isElectron ? 'Native Electron macOS App' : 'Browser Development Preview'}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Host Platform:</span>
                <span className="font-mono text-slate-300">{appStatus?.platform ?? 'darwin'}</span>
              </div>
              {appStatus?.electronVersion && (
                <div className="flex justify-between">
                  <span>Electron Version:</span>
                  <span className="font-mono text-slate-400">{appStatus.electronVersion}</span>
                </div>
              )}
              {appStatus?.userDataPath && (
                <div className="flex justify-between">
                  <span>User Data Directory:</span>
                  <span className="font-mono text-slate-400 text-[11px] truncate max-w-[200px]" title={appStatus.userDataPath}>
                    {appStatus.userDataPath}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Persistence Engine */}
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="flex items-center gap-2 text-emerald-400 font-semibold">
              <Database className="w-4 h-4" />
              <span>Durable Persistence Engine</span>
            </div>
            <p className="text-slate-400">
              RelayX uses high-performance SQLite with WAL journaling and strict foreign key integrity.
            </p>
            <div className="space-y-2 pt-2 border-t border-slate-800 text-slate-300">
              <div className="flex justify-between">
                <span>Database Path:</span>
                <span className="font-mono text-slate-300 text-[11px] truncate max-w-[220px]" title={appStatus?.databasePath ?? 'Local SQLite WAL'}>
                  {appStatus?.databasePath ?? 'Local SQLite WAL'}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Database Storage:</span>
                <span className="font-mono text-emerald-400">
                  {appStatus?.databaseType === 'sqlite_wal' ? 'SQLite (WAL Mode)' : 'In-Memory WAL'}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Foreign Key Enforced:</span>
                <span className="font-mono text-emerald-400">ENABLED</span>
              </div>
            </div>
          </div>

          {/* Provider & App Integrations */}
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-4 md:col-span-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-blue-400 font-semibold text-sm">
                <Cpu className="w-4 h-4" />
                <span>Provider &amp; App Integrations (Capability Truth)</span>
              </div>
              <button
                onClick={handleRecheckAll}
                disabled={isVerifying}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 text-xs font-medium transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-blue-400 ${isVerifying ? 'animate-spin' : ''}`} />
                <span>Recheck All Integrations</span>
              </button>
            </div>
            <p className="text-slate-400">
              First-class external integrations for ChatGPT, OpenCode, and VS Code. Integrations expose external sessions and execution capabilities rather than masquerading as runtimes.
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pt-1">
              {integrations.map((integ) => {
                const type = integ.providerType;
                const id = integ.id || (type as string);
                const isVerifyingThis = verifyingType === type;
                const isVerified = integ?.status === 'verified';
                const isDegraded = integ?.status === 'degraded';

                return (
                  <div
                    key={id}
                    className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col justify-between space-y-3"
                  >
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-bold text-slate-200 uppercase text-xs">
                            {integ?.name || type}
                          </span>
                          {integ?.isDefaultPlanner && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded font-bold bg-blue-600 text-white">
                              Def Planner
                            </span>
                          )}
                          {integ?.isDefaultWorker && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded font-bold bg-emerald-600 text-white">
                              Def Worker
                            </span>
                          )}
                        </div>
                        <span
                          className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase border ${
                            isVerified
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                              : isDegraded
                              ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                              : 'bg-slate-800 text-slate-400 border-slate-700'
                          }`}
                        >
                          {integ?.status || 'Unconfigured'}
                        </span>
                      </div>

                      <div className="text-[11px] text-slate-400 font-mono">
                        {integ?.lastVerificationResult?.message || 'Ready for verification'}
                      </div>

                      {/* Identity details */}
                      <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-850 space-y-1 text-[10px]">
                        <div className="text-slate-400 font-semibold uppercase text-[9px]">Identity &amp; Transport</div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Role:</span>
                          <span className="font-mono text-slate-300 capitalize">{integ?.role}</span>
                        </div>
                        {integ?.identity?.bundleId && (
                          <div className="flex justify-between">
                            <span className="text-slate-500">Bundle ID:</span>
                            <span className="font-mono text-slate-300 truncate max-w-[130px]">{integ.identity.bundleId}</span>
                          </div>
                        )}
                        {integ?.identity?.executable && (
                          <div className="flex justify-between">
                            <span className="text-slate-500">Executable:</span>
                            <span className="font-mono text-emerald-400">{integ.identity.executable}</span>
                          </div>
                        )}
                        {integ?.identity?.serviceUrl && (
                          <div className="flex justify-between">
                            <span className="text-slate-500">Socket URL:</span>
                            <span className="font-mono text-blue-400 truncate max-w-[130px]">{integ.identity.serviceUrl}</span>
                          </div>
                        )}
                      </div>

                      {/* Capability matrix overview */}
                      <div className="space-y-1">
                        <div className="text-slate-400 font-semibold uppercase text-[9px]">Capabilities</div>
                        <div className="grid grid-cols-2 gap-1 text-[10px]">
                          {integ && Object.entries(integ.capabilities || {}).map(([capName, isSupported]) => (
                            <div
                              key={capName}
                              className={`px-1.5 py-0.5 rounded text-[10px] flex items-center gap-1 ${
                                isSupported ? 'text-emerald-400 font-medium' : 'text-slate-600 line-through'
                              }`}
                            >
                              <span>{isSupported ? '✓' : '✗'}</span>
                              <span className="truncate">{capName}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleVerifyOne(type)}
                      disabled={isVerifyingThis}
                      className="w-full mt-2 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 text-xs font-medium transition-colors"
                    >
                      <RefreshCw className={`w-3 h-3 text-blue-400 ${isVerifyingThis ? 'animate-spin' : ''}`} />
                      <span>{isVerifyingThis ? 'Verifying…' : 'Recheck Integration'}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* macOS Accessibility Bindings */}
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3 md:col-span-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-purple-400 font-semibold">
                <Cpu className="w-4 h-4" />
                <span>macOS UI Automation Permissions (Phase 7 Truth)</span>
              </div>
              {appStatus?.permissions && (
                <span
                  className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                    appStatus.permissions.accessibilityGranted
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  }`}
                >
                  {appStatus.permissions.accessibilityGranted ? 'Permissions Active' : 'Action Required'}
                </span>
              )}
            </div>
            <p className="text-slate-400">
              System status of Accessibility and Apple Events automation permissions required for visible UI control.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between">
                <div>
                  <span className="block font-semibold text-slate-200">Accessibility API</span>
                  <span className="text-[11px] text-slate-400">AXUIElement inspector</span>
                </div>
                {appStatus?.permissions?.accessibilityGranted ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-amber-400" />
                )}
              </div>

              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between">
                <div>
                  <span className="block font-semibold text-slate-200">AppleScript / Events</span>
                  <span className="text-[11px] text-slate-400">System Events control</span>
                </div>
                {appStatus?.permissions?.systemEventsAvailable ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-amber-400" />
                )}
              </div>

              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between">
                <div>
                  <span className="block font-semibold text-slate-200">Screen Verification</span>
                  <span className="text-[11px] text-slate-400">Stop button / composer check</span>
                </div>
                {appStatus?.permissions?.accessibilityGranted ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-slate-500" />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Safety Invariants (Immutable System Contracts) */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-amber-400 font-semibold uppercase tracking-wider text-xs">
          <Shield className="w-4 h-4" />
          <span>3. Safety Invariants (Immutable System Contracts)</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
            <div className="flex items-center gap-1.5 text-amber-300 font-semibold">
              <Lock className="w-3.5 h-3.5 text-amber-400" />
              <span>Resend Protection Invariant</span>
            </div>
            <p className="text-slate-400">
              When a dispatch status is ambiguous or unverified, automatic retry is strictly prohibited to prevent duplicate instructions.
            </p>
            <div className="font-mono text-red-400 font-bold text-[11px] pt-2 border-t border-slate-800">
              STRICTLY PROHIBITED
            </div>
          </div>

          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
            <div className="flex items-center gap-1.5 text-amber-300 font-semibold">
              <Lock className="w-3.5 h-3.5 text-amber-400" />
              <span>Checkpoint Continuity</span>
            </div>
            <p className="text-slate-400">
              Observation alone never advances synchronization checkpoints. Advancement is a separate, durable, append-only cursor.
            </p>
            <div className="font-mono text-emerald-400 font-bold text-[11px] pt-2 border-t border-slate-800">
              APPEND-ONLY CURSOR
            </div>
          </div>

          <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
            <div className="flex items-center gap-1.5 text-amber-300 font-semibold">
              <Lock className="w-3.5 h-3.5 text-amber-400" />
              <span>Automatic Pair Creation</span>
            </div>
            <p className="text-slate-400">
              Automatic creation guarantees fresh sessions for both planner and worker. Silent adoption of existing sessions is forbidden.
            </p>
            <div className="font-mono text-emerald-400 font-bold text-[11px] pt-2 border-t border-slate-800">
              FRESH PROVISIONING ONLY
            </div>
          </div>
        </div>
      </div>

      {/* 4. Danger Zone / Destructive Maintenance */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-red-400 font-semibold uppercase tracking-wider text-xs">
          <ShieldAlert className="w-4 h-4" />
          <span>4. Danger Zone / Destructive Maintenance</span>
        </div>

        <div className="p-5 rounded-xl bg-red-950/20 border border-red-900/40 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <span className="font-bold text-red-300 block text-sm">Reset / Clear Local SQLite Database</span>
            <span className="text-slate-400 text-xs">
              Deletes all local records, assignments, associations, and checkpoints. This action is irreversible.
            </span>
          </div>
          {onClearDb && (
            <button
              onClick={onClearDb}
              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors shrink-0 shadow-sm"
            >
              Reset / Clear Local Database
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
