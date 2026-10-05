import { UIPair } from '../types/ui.ts';

/**
 * UI projection of the Pair RELAY-EXECUTION controls (Start / Pause-Stop).
 *
 * WHY THIS EXISTS
 * ---------------
 * `PairView` previously gated the Start control on the legacy business field
 * `pair.status` being `'paused' | 'idle'`, and Pause on `pair.status === 'active'`.
 * That conflates three independent dimensions the domain explicitly forbids
 * conflating (`src/relay/domain/entities.ts`, §SEMANTIC_FREEZE):
 *
 *   A. Authority      `operationalState` (IDLE | ACTIVE) — provider-contact permission
 *   B. Relay enable   `relayState` (STOPPED | PAUSED | RUNNING) — loop enabled
 *   C. Business state `status` (idle | active | paused | blocked | archived) — record state
 *
 * The live defect: a Pair can legitimately sit at
 *   `status = 'active'`, `operationalState = 'ACTIVE'`, `relayState = 'STOPPED'`
 * which is exactly the state Start exists to fix — yet `status === 'active'`
 * satisfied neither `'paused'` nor `'idle'`, so no Start control rendered and the
 * operator was trapped. Automated contact correctly stayed blocked (the domain
 * gate is `operationalState === 'ACTIVE' && relayState === 'RUNNING`), but the
 * UI offered no way to satisfy it.
 *
 * The relay controls are therefore derived from dimension B (and A for the
 * "not yet operational" hint), never from dimension C.
 *
 * THIS IS NOT AUTHORITY. `RelayApiService.startPair` / `pausePair` remain the
 * only transitions, and the engine's `ACTIVE + RUNNING` provider-contact gate is
 * untouched. This module only decides which control to render.
 */

export type PairRelayExecutionState = 'STOPPED' | 'RUNNING' | 'PAUSED';

export interface PairRelayControls {
  /** Render/enable "Start / Resume orchestration" (calls `startPair`). */
  canStart: boolean;
  /** Render/enable "Pause Pair" (calls `pausePair`). */
  canPause: boolean;
  /** Render the Load & Activate control (calls `loadAndActivatePair`). */
  needsActivation: boolean;
  /** Resolved relay-execution dimension, for display/tests. */
  relayState: PairRelayExecutionState;
  /** Resolved authority dimension, for display/tests. */
  operationalState: 'IDLE' | 'ACTIVE';
  /**
   * Mirrors the domain gate `Pair.isAutomatedContactPermitted()`. False means the
   * engine will refuse automated provider contact, which is why Start is offered.
   */
  automatedContactPermitted: boolean;
}

/**
 * A Pair with no relayState reported at all cannot be assumed RUNNING. Treat the
 * absent dimension as STOPPED: absent evidence must never imply enabled
 * automation (§SEMANTIC_FREEZE: no local control value may be read as proof).
 */
function resolveRelayState(
  pair: Pick<UIPair, 'relayState'>,
): PairRelayExecutionState {
  return pair.relayState ?? 'STOPPED';
}

export function resolvePairRelayControls(
  pair: Pick<UIPair, 'status' | 'operationalState' | 'relayState'>,
): PairRelayControls {
  const relayState = resolveRelayState(pair);
  const operationalState = pair.operationalState ?? 'IDLE';
  const archived = pair.status === 'archived';

  const running = relayState === 'RUNNING';
  const automatedContactPermitted = operationalState === 'ACTIVE' && running;

  return {
    // Start is offered exactly when automation is not currently permitted and the
    // pair is still a live record. Starting is safe in either operational state:
    // `handlePairAction` activates first when needed, so refusing Start here would
    // only re-trap the operator.
    canStart: !archived && !running,
    // Pause only makes sense while the relay loop is actually running.
    canPause: !archived && running,
    // Load & Activate is an AUTHORITY change, so it is driven by dimension A only.
    needsActivation: !archived && operationalState !== 'ACTIVE',
    relayState,
    operationalState,
    automatedContactPermitted,
  };
}