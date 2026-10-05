import React, { useState, useEffect } from 'react';
import {
  Layers,
  Plus,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Star,
  Settings,
  Trash2,
  Power,
  Terminal,
  FileCode,
  Globe,
  Sliders,
  ShieldCheck,
  Zap,
  Info,
  ExternalLink,
} from 'lucide-react';
import { ProviderIntegration } from '../types/relayApi.ts';
import { relayBridge } from '../services/relayBridge.ts';
import { AddAppModal } from './AddAppModal.tsx';

interface IntegrationsViewProps {
  onNotify?: (msg: string) => void;
}

export const IntegrationsView: React.FC<IntegrationsViewProps> = ({ onNotify }) => {
  const [integrations, setIntegrations] = useState<ProviderIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [isRecheckingAll, setIsRecheckingAll] = useState(false);
  const [filterRole, setFilterRole] = useState<'all' | 'planner' | 'worker'>('all');

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingApp, setEditingApp] = useState<ProviderIntegration | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const loadIntegrations = async () => {
    try {
      setLoading(true);
      const list = await relayBridge.listIntegrations();
      setIntegrations(list);
    } catch (err: any) {
      console.error('Failed to load integrations:', err);
      setErrorBanner(err?.message || 'Failed to load app integrations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadIntegrations();
  }, []);

  const notify = (msg: string) => {
    if (onNotify) onNotify(msg);
  };

  const handleVerifyOne = async (app: ProviderIntegration) => {
    const id = app.id || (app.providerType as string);
    setVerifyingId(id);
    try {
      const updated = await relayBridge.verifyIntegration(app.providerType);
      setIntegrations((prev) => prev.map((item) => ((item.id || item.providerType) === id ? updated : item)));
      notify(`Verified: ${updated.name} — ${updated.lastVerificationResult?.message || updated.status}`);
    } catch (err: any) {
      notify(`Verification failed: ${err.message}`);
    } finally {
      setVerifyingId(null);
    }
  };

  const handleRecheckAll = async () => {
    setIsRecheckingAll(true);
    try {
      const updated = await relayBridge.recheckAllIntegrations();
      setIntegrations(updated);
      notify('Rechecked all configured app integrations');
    } catch (err: any) {
      notify(`Error: ${err.message}`);
    } finally {
      setIsRecheckingAll(false);
    }
  };

  const handleToggleEnabled = async (app: ProviderIntegration) => {
    const id = app.id || (app.providerType as string);
    const newEnabled = !app.isEnabled;
    try {
      const updated = await relayBridge.toggleIntegrationEnabled(id, newEnabled);
      setIntegrations((prev) => prev.map((item) => ((item.id || item.providerType) === id ? updated : item)));
      notify(`${app.name} is now ${newEnabled ? 'Enabled' : 'Disabled'}`);
    } catch (err: any) {
      notify(`Cannot toggle: ${err.message}`);
    }
  };

  const handleSetDefault = async (app: ProviderIntegration, role: 'planner' | 'worker') => {
    const id = app.id || (app.providerType as string);
    try {
      const res = await relayBridge.setDefaultIntegration(id, role);
      if (res.success) {
        notify(`${app.name} selected as Default ${role === 'planner' ? 'Planner' : 'Worker'} for new Pairs`);
        await loadIntegrations();
      } else {
        notify(`Failed: ${res.error}`);
      }
    } catch (err: any) {
      notify(`Error: ${err.message}`);
    }
  };

  const handleDelete = async (app: ProviderIntegration) => {
    const id = app.id || (app.providerType as string);
    if (!confirm(`Are you sure you want to remove the integration "${app.name}"?`)) return;
    try {
      const res = await relayBridge.deleteIntegration(id);
      if (res.success) {
        notify(`Removed "${app.name}" integration`);
        await loadIntegrations();
      } else {
        notify(`Cannot delete: ${res.error}`);
      }
    } catch (err: any) {
      notify(`Error: ${err.message}`);
    }
  };

  const handleSaveApp = async (config: Partial<ProviderIntegration>) => {
    if (editingApp) {
      const id = editingApp.id || (editingApp.providerType as string);
      await relayBridge.updateIntegration(id, config);
      notify(`Updated "${config.name || editingApp.name}" configuration`);
    } else {
      await relayBridge.addIntegration(config);
      notify(`Added new integration "${config.name}"`);
    }
    await loadIntegrations();
  };

  // Find active defaults
  const defaultPlanner = integrations.find((i) => i.isDefaultPlanner && i.isEnabled);
  const defaultWorker = integrations.find((i) => i.isDefaultWorker && i.isEnabled);

  const filteredIntegrations = integrations.filter((item) => {
    if (filterRole === 'planner') return item.role === 'planner' || item.role === 'both';
    if (filterRole === 'worker') return item.role === 'worker' || item.role === 'both';
    return true;
  });

  return (
    <div className="space-y-6 select-none animate-fade-in text-xs">
      {/* View Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2.5">
            <Layers className="w-5 h-5 text-blue-400" />
            <span>App Integrations &amp; Automation Handlers</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Common RelayX orchestration engine with replaceable, app-specific integration handlers.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={handleRecheckAll}
            disabled={isRecheckingAll}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-850 hover:bg-slate-800 border border-slate-750 text-slate-200 text-xs font-semibold transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-blue-400 ${isRecheckingAll ? 'animate-spin' : ''}`} />
            <span>Recheck All</span>
          </button>

          <button
            onClick={() => {
              setEditingApp(null);
              setIsAddModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-900/30 transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>+ Add App</span>
          </button>
        </div>
      </div>

      {/* Active Defaults Authority Card */}
      <div className="rx-card p-4 rounded-xl bg-gradient-to-r from-blue-950/30 via-slate-900 to-indigo-950/30 border border-blue-900/40 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-blue-400 font-semibold text-xs uppercase tracking-wider">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Active Default Integrations for New Work</span>
          </div>
          <p className="text-slate-400 text-xs">
            When creating a new Pair automatically, RelayX asks the integration layer for the Default Planner and Default Worker.
            Once bound, existing Pairs stay anchored to their specific sessions and never switch.
          </p>
        </div>

        <div className="rx-action-group rx-action-group-wrap gap-4">
          <div className="px-3.5 py-2 rounded-lg bg-slate-950/80 border border-blue-500/30 flex items-center gap-2.5">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <div>
              <div className="text-[10px] text-slate-400 uppercase font-semibold">Default Planner</div>
              <div className="text-xs font-bold text-blue-300">
                {defaultPlanner ? defaultPlanner.name : 'None selected'}
              </div>
            </div>
          </div>

          <div className="px-3.5 py-2 rounded-lg bg-slate-950/80 border border-emerald-500/30 flex items-center gap-2.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <div>
              <div className="text-[10px] text-slate-400 uppercase font-semibold">Default Worker</div>
              <div className="text-xs font-bold text-emerald-300">
                {defaultWorker ? defaultWorker.name : 'None selected'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
        <span className="text-slate-400 text-xs font-medium mr-2">Filter:</span>
        <button
          onClick={() => setFilterRole('all')}
          className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
            filterRole === 'all'
              ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          All Applications ({integrations.length})
        </button>
        <button
          onClick={() => setFilterRole('planner')}
          className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
            filterRole === 'planner'
              ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          Planners ({integrations.filter((i) => i.role === 'planner' || i.role === 'both').length})
        </button>
        <button
          onClick={() => setFilterRole('worker')}
          className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
            filterRole === 'worker'
              ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          Workers ({integrations.filter((i) => i.role === 'worker' || i.role === 'both').length})
        </button>
      </div>

      {/* Integrations Grid */}
      <div className="grid grid-cols-1 gap-6">
        {filteredIntegrations.map((app) => {
          const id = app.id || (app.providerType as string);
          const isVerifying = verifyingId === id;
          const isVerified = app.status === 'verified';
          const isDegraded = app.status === 'degraded';
          const isEnabled = app.isEnabled ?? true;

          // Capabilities summary for easy glance
          const capabilitySummary = Object.entries(app.capabilities || {})
            .filter(([_, enabled]) => enabled)
            .map(([key]) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase()))
            .slice(0, 3);

          return (
            <div
              key={id}
              className={`rx-card rounded-2xl bg-slate-900 border transition-all overflow-hidden ${
                !isEnabled
                  ? 'border-slate-800 opacity-60 bg-slate-950/40'
                  : app.isDefaultPlanner
                  ? 'border-blue-500/40 shadow-lg shadow-blue-950/20'
                  : app.isDefaultWorker
                  ? 'border-emerald-500/40 shadow-lg shadow-emerald-950/20'
                  : 'border-slate-800 hover:border-slate-750 shadow-sm'
              }`}
            >
              <div className="p-6 flex flex-col md:flex-row gap-6">
                {/* Left Side: Identity & Status */}
                <div className="flex-1 space-y-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-4">
                      <div
                        className={`w-12 h-12 rounded-2xl flex items-center justify-center font-bold text-lg ${
                          app.role === 'planner'
                            ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 shadow-inner'
                            : app.role === 'worker'
                            ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 shadow-inner'
                            : 'bg-purple-600/20 text-purple-400 border border-purple-500/30 shadow-inner'
                        }`}
                      >
                        {app.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-3">
                          <h3 className="font-bold text-slate-100 text-lg leading-none">{app.name}</h3>
                          {app.isBuiltin && (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700 uppercase tracking-tight">
                              Built-in
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <span
                            className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider ${
                              app.role === 'planner'
                                ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                                : app.role === 'worker'
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                            }`}
                          >
                            {app.role}
                          </span>

                          {app.isDefaultPlanner && (
                            <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-blue-600 text-white flex items-center gap-1.5 shadow-md shadow-blue-950/40">
                              <Star className="w-3 h-3 fill-current text-white" />
                              <span>Default Planner</span>
                            </span>
                          )}

                          {app.isDefaultWorker && (
                            <span className="text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-600 text-white flex items-center gap-1.5 shadow-md shadow-emerald-950/40">
                              <Star className="w-3 h-3 fill-current text-white" />
                              <span>Default Worker</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handleToggleEnabled(app)}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${
                          isEnabled
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                            : 'bg-slate-800 text-slate-500 border-slate-700 hover:bg-slate-750'
                        }`}
                      >
                        <Power className={`w-3.5 h-3.5 ${isEnabled ? 'text-emerald-400' : 'text-slate-500'}`} />
                        <span>{isEnabled ? 'Enabled' : 'Disabled'}</span>
                      </button>
                    </div>
                  </div>

                  <p className="text-slate-400 text-xs leading-relaxed max-w-2xl">{app.description}</p>

                  <div className="grid grid-cols-2 gap-x-8 gap-y-4 pt-2">
                    <div className="space-y-1">
                      <span className="text-slate-500 text-[10px] uppercase font-bold tracking-widest block">Readiness Check</span>
                      <div className="flex items-center gap-3">
                        <div className={`w-2.5 h-2.5 rounded-full ${isVerified ? 'bg-emerald-400' : isDegraded ? 'bg-amber-400' : 'bg-slate-500'}`} />
                        <span className="text-slate-300 font-bold text-xs uppercase tracking-tight">
                          {app.status || 'UNCONFIGURED'}
                        </span>
                        <span className="text-slate-500 text-[10px] font-medium italic">
                          Last checked: {app.lastVerifiedAt ? new Date(app.lastVerifiedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Never'}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <span className="text-slate-500 text-[10px] uppercase font-bold tracking-widest block">Capabilities</span>
                      <div className="flex flex-wrap gap-1.5">
                        {capabilitySummary.map((cap) => (
                          <span key={cap} className="px-2 py-0.5 rounded-md bg-slate-850 text-slate-400 text-[9px] font-bold border border-slate-800">
                            ✓ {cap}
                          </span>
                        ))}
                        {(Object.keys(app.capabilities || {}).length > 3) && (
                          <span className="text-[10px] text-slate-500 font-bold ml-1">+{Object.keys(app.capabilities || {}).length - 3} more</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Side: Details Pane */}
                <div className="w-full md:w-80 bg-slate-950/50 rounded-2xl border border-slate-800/50 p-4 space-y-4">
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest pb-1 border-b border-slate-800/50">
                      <Info className="w-3.5 h-3.5" />
                      <span>Host Application Info</span>
                    </div>

                    <div className="space-y-2 text-[11px]">
                      {app.appPath && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-slate-500 font-medium">Path</span>
                          <span className="font-mono text-slate-400 truncate text-[10px]" title={app.appPath}>{app.appPath}</span>
                        </div>
                      )}
                      {app.bundleId && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-slate-500 font-medium">Bundle ID</span>
                          <span className="font-mono text-slate-400 text-[10px]">{app.bundleId}</span>
                        </div>
                      )}
                      {app.cliCommand && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-slate-500 font-medium">CLI Binary</span>
                          <span className="font-mono text-emerald-400 text-[10px]">{app.cliCommand}</span>
                        </div>
                      )}
                      {app.serviceUrl && (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-slate-500 font-medium">Local API</span>
                          <span className="font-mono text-blue-400 text-[10px]">{app.serviceUrl}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest pb-1 border-b border-slate-800/50">
                      <Zap className="w-3.5 h-3.5 text-amber-500" />
                      <span>Automation Driver</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 font-medium">{app.launchBehavior}</span>
                      <div className="flex items-center gap-1.5">
                        <Terminal className="w-3.5 h-3.5 text-slate-500" />
                        <FileCode className="w-3.5 h-3.5 text-slate-500" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Action Toolbar */}
              <div className="px-6 py-4 bg-slate-950/30 border-t border-slate-800 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleVerifyOne(app)}
                    disabled={isVerifying}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs font-bold transition-all border border-slate-700 shadow-sm"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 text-blue-400 ${isVerifying ? 'animate-spin' : ''}`} />
                    <span>{isVerifying ? 'Verifying…' : 'Test & Verify'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setEditingApp(app);
                      setIsAddModalOpen(true);
                    }}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs font-bold transition-all border border-slate-700 shadow-sm"
                  >
                    <Settings className="w-3.5 h-3.5 text-slate-400" />
                    <span>Configure</span>
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {/* Default Action Buttons */}
                  {(app.role === 'planner' || app.role === 'both') && !app.isDefaultPlanner && isEnabled && (
                    <button
                      type="button"
                      onClick={() => handleSetDefault(app, 'planner')}
                      className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all shadow-md shadow-blue-900/20"
                    >
                      Set as Default Planner
                    </button>
                  )}

                  {(app.role === 'worker' || app.role === 'both') && !app.isDefaultWorker && isEnabled && (
                    <button
                      type="button"
                      onClick={() => handleSetDefault(app, 'worker')}
                      className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-md shadow-emerald-900/20"
                    >
                      Set as Default Worker
                    </button>
                  )}

                  {!app.isBuiltin && (
                    <button
                      type="button"
                      onClick={() => handleDelete(app)}
                      className="p-2 rounded-xl bg-slate-800 hover:bg-red-600/20 text-slate-400 hover:text-red-400 border border-slate-700 hover:border-red-600/30 transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal */}
      <AddAppModal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setEditingApp(null);
        }}
        onSave={handleSaveApp}
        editingApp={editingApp}
      />
    </div>
  );
};
