import React from 'react';
import { Settings, Database, Shield, Sliders, Cpu, CheckCircle2, AlertCircle, Monitor, Trash2, Sparkles, ShieldAlert, Sun, Moon } from 'lucide-react';
import { AppStatus } from '../types/relayApi.ts';

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
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Settings className="w-5 h-5 text-slate-400" />
            <span>Relay Control Plane Configuration</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Engine policies, runtime environment, supervisor intervals, and macOS accessibility bindings
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
        {/* Appearance Setting */}
        <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="flex items-center gap-2 text-indigo-400 font-semibold">
            <Sun className="w-4 h-4" />
            <span>Appearance &amp; Theme</span>
          </div>
          <p className="text-slate-400">
            Choose Relay user interface theme mode. System follows macOS appearance automatically.
          </p>
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

        {/* Runtime Environment Info */}
        <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="flex items-center gap-2 text-blue-400 font-semibold">
            <Monitor className="w-4 h-4" />
            <span>macOS Desktop Host & Runtime</span>
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
            {appStatus?.nodeVersion && (
              <div className="flex justify-between">
                <span>Node.js Version:</span>
                <span className="font-mono text-slate-400">{appStatus.nodeVersion}</span>
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
            Relay uses high-performance SQLite with WAL journaling and strict foreign key integrity.
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

        {/* Supervision & Invariant Settings */}
        <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="flex items-center gap-2 text-amber-400 font-semibold">
            <Shield className="w-4 h-4" />
            <span>Supervision & Safety Policies</span>
          </div>
          <p className="text-slate-400">
            Configures observation failure thresholds and delivery ambiguity rules.
          </p>
          <div className="space-y-2 pt-2 border-t border-slate-800 text-slate-300">
            <div className="flex justify-between">
              <span>Max Observation Failures:</span>
              <span className="font-mono text-slate-100">3 attempts</span>
            </div>
            <div className="flex justify-between">
              <span>Supervision Heartbeat Interval:</span>
              <span className="font-mono text-slate-100">5000 ms</span>
            </div>
            <div className="flex justify-between">
              <span>Automated Resend On Ambiguity:</span>
              <span className="font-mono text-red-400 font-bold">STRICTLY PROHIBITED</span>
            </div>
          </div>
        </div>

        {/* Environment Actions */}
        <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="flex items-center gap-2 text-purple-400 font-semibold">
            <Sliders className="w-4 h-4" />
            <span>Database Maintenance & Fixtures</span>
          </div>
          <p className="text-slate-400">
            Actions for clearing local SQLite state.
          </p>
          <div className="flex flex-col gap-2 pt-2 border-t border-slate-800">
            {onClearDb && (
              <button
                onClick={onClearDb}
                className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-600/10 hover:bg-red-600/20 text-red-400 border border-red-500/20 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Reset / Clear Local Database</span>
              </button>
            )}
          </div>
        </div>



        {/* macOS Accessibility Bindings */}
        <div className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-3 md:col-span-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-purple-400 font-semibold">
              <Cpu className="w-4 h-4" />
              <span>macOS UI Automation Permissions (Phase 7)</span>
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
            {appStatus?.permissions?.notes && (
              <span className="block mt-1 text-slate-300 font-mono text-[11px]">
                {appStatus.permissions.notes}
              </span>
            )}
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

          {appStatus?.permissions && !appStatus.permissions.accessibilityGranted && appStatus.platform === 'darwin' && (
            <div className="p-3 rounded-lg bg-amber-500/15 border border-amber-400/40 flex items-start gap-2.5 text-amber-100">
              <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
              <div className="text-xs">
                <strong className="font-semibold block text-amber-50">System Settings authorization required:</strong>
                To enable visible UI control and Stop button verification, grant Relay or your Terminal Accessibility permissions under:
                <div className="font-mono bg-amber-950/60 px-2 py-1 rounded mt-1 text-amber-100 border border-amber-700/50">
                  System Settings &gt; Privacy &amp; Security &gt; Accessibility
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

