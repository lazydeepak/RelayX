import React, { useEffect, useState } from 'react';
import { UIPair } from '../types/ui.ts';
import { relayBridge } from '../services/relayBridge.ts';

/**
 * Pair-scoped worker model selection.
 *
 * This is PERSISTENT RelayX configuration, not a live provider mutation. Writing
 * it makes NO provider contact, so it is legal while the Pair is IDLE. The
 * engine reads the resolved value (pair > project > global) at the authorized
 * dispatch boundary and passes it to `deliverInstruction` as `modelOverride`.
 *
 * There is deliberately no "apply now" action: the persisted setting IS the
 * application, and it takes effect at the next dispatch.
 */
interface WorkerModelControlProps {
  pair: UIPair;
}

export const WorkerModelControl: React.FC<WorkerModelControlProps> = ({ pair }) => {
  const [supportedModels, setSupportedModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [inheritedModel, setInheritedModel] = useState<string>('');
  const [hasPairOverride, setHasPairOverride] = useState<boolean>(false);
  const [status, setStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const load = async () => {
    try {
      const config = await relayBridge.getEffectiveModelConfig('opencode', pair.projectId, pair.id);
      setSupportedModels(config.supportedModels);
      setSelectedModel(config.effectiveModel);
      setHasPairOverride(Boolean(config.isPairOverride));
      setInheritedModel(config.projectOverride || config.globalDefault || '');
    } catch (err) {
      console.error('Failed to load worker model configuration:', err);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair.id, pair.projectId]);

  const handleChange = async (model: string) => {
    setIsSaving(true);
    setStatus(null);
    try {
      await relayBridge.setPairModelOverride(pair.id, 'opencode', model, 'Selected from Pair view');
      setSelectedModel(model);
      setHasPairOverride(true);
      setStatus('Saved — applies at the next dispatch.');
    } catch (err: any) {
      setStatus(`Error: ${err?.message || String(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    setIsSaving(true);
    setStatus(null);
    try {
      await relayBridge.clearPairModelOverride(pair.id, 'opencode');
      await load();
      setStatus('Reverted to the inherited model.');
    } catch (err: any) {
      setStatus(`Error: ${err?.message || String(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const options = selectedModel && !supportedModels.includes(selectedModel)
    ? [...supportedModels, selectedModel]
    : supportedModels;

  return (
    <div className="mt-2 pt-2 border-t border-slate-800/60 space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-slate-400 font-medium uppercase">Worker Model:</span>
        <select
          value={selectedModel}
          onChange={(e) => handleChange(e.target.value)}
          disabled={isSaving || options.length === 0}
          className="min-w-0 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-slate-200 text-xs disabled:opacity-50"
        >
          {options.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {hasPairOverride && (
          <button
            type="button"
            onClick={handleReset}
            disabled={isSaving}
            className="text-[10px] text-slate-400 hover:text-amber-400 disabled:opacity-50"
            title="Remove the pair override and inherit the project/global model"
          >
            Reset
          </button>
        )}
      </div>
      <div className="text-[10px] text-slate-500">
        {hasPairOverride
          ? 'Pair override — applied at the next dispatch.'
          : `Inherited${inheritedModel ? `: ${inheritedModel}` : ' from project/global'} — select to override.`}
      </div>
      {status && <div className="text-[11px] text-amber-300">{status}</div>}
    </div>
  );
};
