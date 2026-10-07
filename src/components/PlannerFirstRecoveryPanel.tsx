import React, { useState } from 'react';
import { AlertTriangle, Pause, Send, ShieldAlert, ShieldCheck, MessageSquare, ArrowRight } from 'lucide-react';

import type { RecoveryState } from '../relay/domain/recoveryAuthority';

export interface PlannerFirstRecoveryPanelProps {
  /** The engine-driven recovery phase; read-only display only. */
  phase: RecoveryState['phase'];
  /** Failure reason visible to planner. */
  failureReason?: string;
  /** Last planner message (visible for context). */
  lastPlannerMessage?: string;
  /** Last worker message (visible as evidence). */
  lastWorkerMessage?: string;
  /** Whether automation is paused (for display). */
  automationPaused: boolean;
  /** Called when user presses "Pause & Return to Planner". */
  onPauseAndReturnToPlanner: () => void;
  /** Called when user presses "Send to Planner" with recovery input. */
  onSendToPlanner: (input: { goal?: string; method?: string; direction?: string }) => void;
}

/**
 * PlannerFirstRecoveryPanel — dedicated recovery presentation component.
 *
 * Architecture: recovery authority is ALWAYS PLANNER (fixed, not selectable).
 * Normal baton and recovery authority are shown separately.
 * No destination/owner dropdown exists.
 * Recovery always enters through Planner; never directly to Worker.
 */
export const PlannerFirstRecoveryPanel: React.FC<PlannerFirstRecoveryPanelProps> = ({
  phase,
  failureReason,
  lastPlannerMessage,
  lastWorkerMessage,
  automationPaused,
  onPauseAndReturnToPlanner,
  onSendToPlanner,
}) => {
  // No local phase mutation here: this is a read-only projection of the engine's
  // RecoveryState (R2/R3 — normal baton and recovery authority are separate).
  const [goal, setGoal] = useState('');
  const [method, setMethod] = useState('');
  const [direction, setDirection] = useState('');

  // Fixed recovery authority — never selectable (R1 / R5)
  const recoveryOwner = 'PLANNER';

  return (
    <div className="space-y-4">
      {/* ─── CONTINUATION_AUTHORIZED — relay authorized continuation in flight ─── */}
      {phase === 'continuation_authorized' && (
        <section
          role="status"
          aria-label="continuation authorized"
          className="rounded-xl border border-amber-700/50 bg-amber-950/30 text-amber-100 p-6 shadow-lg"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0">
              <ArrowRight className="w-6 h-6 text-amber-400" />
            </div>
            <div className="space-y-3 w-full">
              <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                <span className="text-amber-300">CONTINUATION AUTHORIZED</span>
                <span className="text-sm font-normal text-amber-200"> Planner → Worker</span>
              </h2>
              <p className="text-amber-200/90 leading-relaxed">
                A concrete Planner decision was observed and the relay engine has authorized the
                Planner → Worker continuation. The continuation delivery is confirmed dispatched;
                no further manual intervention is required.
              </p>
              <div className="rounded-lg bg-slate-900/60 border border-slate-700/50 p-3 text-xs font-mono text-slate-300 space-y-1">
                <div>
                  <span className="text-slate-500">Recovery owner (fixed):</span>{' '}
                  <span className="font-bold text-amber-300">{recoveryOwner}</span>
                </div>
                <div>
                  <span className="text-slate-500">Selection permitted:</span>{' '}
                  <span className="font-bold text-red-400">NONE — fixed to PLANNER</span>
                </div>
                <div>
                  <span className="text-slate-500">Next permitted automated transition:</span>{' '}
                  <span className="font-bold text-emerald-300">Planner → Worker</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ─── PLANNER_DECIDED — planner decision observed, awaiting continuation ─── */}
      {phase === 'planner_decided' && (
        <section
          role="status"
          aria-label="planner decision observed"
          className="rounded-xl border border-amber-700/50 bg-slate-900/80 text-slate-100 p-6 shadow-lg"
        >
          <div className="space-y-4">
            <h2 className="text-xl font-bold tracking-tight flex items-center gap-2 text-amber-200">
              <ShieldCheck className="w-6 h-6 text-amber-400" />
              PLANNER DECISION OBSERVED
            </h2>
            <p className="text-amber-200/90 leading-relaxed">
              A concrete Planner decision for this recovery episode has been observed. The relay
              engine validates the Planner → Worker continuation against durable evidence before
              permitting the continuation delivery.
            </p>
            {lastPlannerMessage && (
              <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-blue-300">
                  <MessageSquare className="w-3.5 h-3.5" />
                  LAST PLANNER MESSAGE
                </div>
                <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                  {lastPlannerMessage}
                </div>
              </div>
            )}
            <div className="rounded-lg bg-slate-900/60 border border-slate-700/50 p-3 text-xs font-mono text-slate-300 space-y-1">
              <div>
                <span className="text-slate-500">Recovery owner (fixed):</span>{' '}
                <span className="font-bold text-amber-300">{recoveryOwner}</span>
              </div>
              <div>
                <span className="text-slate-500">Selection permitted:</span>{' '}
                <span className="font-bold text-red-400">NONE — fixed to PLANNER</span>
              </div>
              <div>
                <span className="text-slate-500">Next permitted automated transition:</span>{' '}
                <span className="font-bold text-emerald-300">Planner → Worker</span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ─── RECOVERY REQUIRED (initial state) ─── */}
      {phase === 'required' && (
        <section
          aria-label="Recovery required"
          className="rounded-xl border border-amber-700/50 bg-amber-950/30 text-amber-100 p-6 shadow-lg"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0">
              <ShieldAlert className="w-6 h-6 text-amber-400" />
            </div>
            <div className="space-y-4 w-full">
              <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                <span className="text-amber-300">RECOVERY REQUIRED</span>
              </h2>

              <div className="rounded-lg border border-amber-800/40 bg-amber-950/40 p-4 space-y-2 text-sm leading-relaxed">
                <div className="flex items-center gap-2 font-semibold text-amber-200">
                  <AlertTriangle className="w-4 h-4" />
                  <span>✕ Worker → Planner delivery failed</span>
                </div>
                <p className="text-amber-200/90">{failureReason}</p>
              </div>

              <div className="rounded-lg bg-slate-900/60 border border-slate-700/50 p-3 text-xs font-mono text-slate-300 space-y-1">
                <div>
                  <span className="text-slate-500">Recovery owner (fixed):</span>{' '}
                  <span className="font-bold text-amber-300">{recoveryOwner}</span>
                </div>
                <div>
                  <span className="text-slate-500">Selection permitted:</span>{' '}
                  <span className="font-bold text-red-400">NONE — fixed to PLANNER</span>
                </div>
                <div>
                  <span className="text-slate-500">Next permitted transition:</span>{' '}
                  <span className="font-bold text-emerald-300">Planner → Worker</span>
                </div>
              </div>

              <div className="rounded-lg border border-amber-800/30 bg-amber-900/20 p-3 text-sm text-amber-200/90 leading-relaxed">
                <strong>RelayX will not continue from the Worker automatically.</strong>{' '}
                The Planner must reassess the failure and issue the next instruction.
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={onPauseAndReturnToPlanner}
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold px-4 py-2.5 transition-colors shadow"
                >
                  <Pause className="w-4 h-4" />
                  Pause &amp; Return to Planner
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ─── PLANNER INTERVENTION (after pause) ─── */}
      {phase === 'planner_intervention' && (
        <section
          role="status"
          aria-label="Planner intervention"
          className="rounded-xl border border-amber-700/50 bg-slate-900/80 text-slate-100 p-6 shadow-lg"
        >
          <div className="space-y-5">
            <h2 className="text-xl font-bold tracking-tight flex items-center gap-2 text-amber-200">
              <ShieldCheck className="w-6 h-6 text-amber-400" />
              PLANNER INTERVENTION
            </h2>

            <div className="flex items-center gap-3 text-xs font-mono text-amber-300">
              <span className="rounded px-2 py-0.5 bg-amber-950/60 border border-amber-800">AUTOMATION PAUSED</span>
              <span>Recovery owner: <strong className="text-amber-200">{recoveryOwner}</strong></span>
            </div>

            {/* Last messages — both visible */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-blue-300">
                  <MessageSquare className="w-3.5 h-3.5" />
                  LAST PLANNER MESSAGE
                </div>
                <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
                  {lastPlannerMessage || '— (no message recorded) —'}
                </div>
              </div>

              <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-300">
                  <MessageSquare className="w-3.5 h-3.5" />
                  LAST WORKER MESSAGE
                </div>
                <div className="text-sm text-amber-100/90 leading-relaxed whitespace-pre-wrap">
                  {lastWorkerMessage || '— (no message recorded) —'}
                </div>
              </div>
            </div>

            {/* Failure label */}
            <div className="rounded-lg border-y border-amber-800/30 bg-amber-950/20 px-4 py-3">
              <div className="font-bold text-amber-200 text-sm">FAILURE</div>
              <div className="text-sm text-amber-100/90 font-mono">
                {failureReason || 'Worker → Planner delivery failed / reconciliation_probe'}
              </div>
            </div>

            {/* Recovery input — planner first */}
            <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-4 space-y-3">
              <h3 className="text-sm font-bold text-amber-200 uppercase tracking-wide">PLANNER RECOVERY INPUT</h3>
              <p className="text-xs text-slate-400">
                Modify context, goal, method, or direction. Repair context can only enter through Planner.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label htmlFor="rx-goal" className="text-xs font-semibold text-slate-300">Goal</label>
                  <input
                    id="rx-goal"
                    type="text"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder="What should the Worker do?"
                    className="w-full rounded-md bg-slate-900 border border-slate-600 text-sm px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="rx-method" className="text-xs font-semibold text-slate-300">Method</label>
                  <input
                    id="rx-method"
                    type="text"
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    placeholder="How should it be done?"
                    className="w-full rounded-md bg-slate-900 border border-slate-600 text-sm px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="rx-direction" className="text-xs font-semibold text-slate-300">Direction</label>
                  <input
                    id="rx-direction"
                    type="text"
                    value={direction}
                    onChange={(e) => setDirection(e.target.value)}
                    placeholder="What direction / constraints?"
                    className="w-full rounded-md bg-slate-900 border border-slate-600 text-sm px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </div>
              </div>

              <div className="pt-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    onSendToPlanner({ goal: goal || undefined, method: method || undefined, direction: direction || undefined })
                  }
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold px-4 py-2.5 transition-colors shadow"
                >
                  <Send className="w-4 h-4" />
                  Send to Planner
                </button>
                <span className="text-xs text-slate-500">
                  Edited Worker content may only be supplied as Planner context — never direct Worker dispatch.
                </span>
              </div>
            </div>

            {/* Baton / recovery authority separation */}
            <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3 text-xs font-mono leading-relaxed space-y-1">
              <div className="font-bold text-slate-300">BATON / AUTHORITY</div>
              <div>
                <span className="text-emerald-400">Normal baton:</span> <strong>WORKER</strong>
              </div>
              <div>
                <span className="text-amber-400">⚠ FAILURE</span>
              </div>
              <div>
                <span className="text-amber-300">Recovery authority:</span> <strong>PLANNER</strong>
              </div>
              <div>
                <span className="text-emerald-300">Next permitted automated transition:</span>{' '}
                <strong>Planner → Worker</strong>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
