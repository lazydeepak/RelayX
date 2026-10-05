import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePairRelayControls } from '../src/components/pairRelayControls.ts';

/**
 * REGRESSION GUARD — Pair relay-execution control visibility.
 *
 * Live defect this locks down:
 *   pair_mut4l0sg_kypfzefr
 *     status=active  operationalState=ACTIVE  relayState=STOPPED
 *
 * `PairView` gated Start on `pair.status === 'paused' | 'idle'`, so this valid
 * state rendered NO Start control and the operator could not move the relay from
 * STOPPED to RUNNING, while the engine correctly kept refusing automated
 * provider contact (isAutomatedContactPermitted === false).
 *
 * Dimension separation under test (entities.ts §SEMANTIC_FREEZE):
 *   A. operationalState  — provider-contact authority
 *   B. relayState        — relay-loop enablement  (drives these controls)
 *   C. status            — business/record state  (must NOT drive them)
 */

describe('resolvePairRelayControls', () => {
  it('1. offers Start when status=active, operational=ACTIVE, relay=STOPPED (the live defect)', () => {
    const c = resolvePairRelayControls({
      status: 'active',
      operationalState: 'ACTIVE',
      relayState: 'STOPPED',
    });
    assert.equal(c.canStart, true, 'Start must be offered — this is the required STOPPED→RUNNING transition');
    assert.equal(c.canPause, false);
    assert.equal(c.automatedContactPermitted, false);
    assert.equal(c.needsActivation, false);
  });

  it('2. offers Pause and hides Start when relay is RUNNING', () => {
    const c = resolvePairRelayControls({
      status: 'active',
      operationalState: 'ACTIVE',
      relayState: 'RUNNING',
    });
    assert.equal(c.canStart, false, 'Start must not be offered while already RUNNING');
    assert.equal(c.canPause, true);
    assert.equal(c.automatedContactPermitted, true);
  });

  it('2b. offers Pause while RUNNING regardless of legacy status being paused/idle', () => {
    // Dimension C must not control dimension B.
    for (const status of ['idle', 'paused', 'active', 'recovering'] as const) {
      const c = resolvePairRelayControls({
        status,
        operationalState: 'ACTIVE',
        relayState: 'RUNNING',
      });
      assert.equal(c.canPause, true, `status=${status} must not hide Pause`);
      assert.equal(c.canStart, false, `status=${status} must not offer Start while RUNNING`);
    }
  });

  it('3. does not claim automated contact is permitted when operationally not ACTIVE', () => {
    const c = resolvePairRelayControls({
      status: 'active',
      operationalState: 'IDLE',
      relayState: 'STOPPED',
    });
    assert.equal(c.automatedContactPermitted, false);
    // Start stays available so the operator is never trapped; the engine's
    // startPair path activates first when authority is missing.
    assert.equal(c.canStart, true);
    assert.equal(c.needsActivation, true, 'Load & Activate must be offered for a non-ACTIVE pair');
  });

  it('4. treats absent relayState as STOPPED, never as implicitly RUNNING', () => {
    const c = resolvePairRelayControls({ status: 'active', operationalState: 'ACTIVE' });
    assert.equal(c.relayState, 'STOPPED');
    assert.equal(c.canStart, true);
    assert.equal(c.automatedContactPermitted, false);
  });

  it('4b. treats absent operationalState as IDLE', () => {
    const c = resolvePairRelayControls({ status: 'idle', relayState: 'STOPPED' });
    assert.equal(c.operationalState, 'IDLE');
    assert.equal(c.needsActivation, true);
    assert.equal(c.automatedContactPermitted, false);
  });

  it('5. keeps PAUSED relay resumable via Start', () => {
    const c = resolvePairRelayControls({
      status: 'paused',
      operationalState: 'ACTIVE',
      relayState: 'PAUSED',
    });
    assert.equal(c.canStart, true, 'PAUSED must be resumable');
    assert.equal(c.canPause, false);
  });

  it('6. preserves legacy idle/paused Start behaviour that is still applicable', () => {
    for (const status of ['idle', 'paused'] as const) {
      const c = resolvePairRelayControls({
        status,
        operationalState: 'IDLE',
        relayState: 'STOPPED',
      });
      assert.equal(c.canStart, true, `status=${status} must still offer Start`);
    }
  });

  it('7. offers no execution controls for an archived pair', () => {
    const c = resolvePairRelayControls({
      status: 'archived',
      operationalState: 'ACTIVE',
      relayState: 'STOPPED',
    });
    assert.equal(c.canStart, false);
    assert.equal(c.canPause, false);
    assert.equal(c.needsActivation, false);
  });

  it('8. mirrors the domain gate exactly: ACTIVE + RUNNING', () => {
    // Cross-check against the frozen domain rule rather than restating it.
    const domainPermits = (op: 'IDLE' | 'ACTIVE', relay: string) =>
      op === 'ACTIVE' && relay === 'RUNNING';
    const cases = [
      { status: 'active' as const, operationalState: 'ACTIVE' as const, relayState: 'RUNNING' as const },
      { status: 'active' as const, operationalState: 'ACTIVE' as const, relayState: 'STOPPED' as const },
      { status: 'idle' as const, operationalState: 'IDLE' as const, relayState: 'RUNNING' as const },
      { status: 'paused' as const, operationalState: 'ACTIVE' as const, relayState: 'PAUSED' as const },
    ];
    for (const c of cases) {
      const controls = resolvePairRelayControls(c);
      assert.equal(
        controls.automatedContactPermitted,
        domainPermits(c.operationalState, c.relayState),
        `mismatch for ${JSON.stringify(c)}`,
      );
    }
  });
});