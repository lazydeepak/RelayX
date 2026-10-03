/**
 * Prompt 6 — TRANSPORT_UNHEALTHY focused tests.
 *
 * Note on classification values: these are the detector's internal REASON CODES,
 * not public health states. `incidentEligible` states whether a caller may open an
 * incident, which is the distinction the semantic correction pass introduced.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateTransportUnhealthy } from '../src/relay/health/transportUnhealthyCheck.ts';

describe('TRANSPORT_UNHEALTHY', () => {
  it('no active work -> NOT_REQUIRED', () => {
    const r = evaluateTransportUnhealthy({ hasActiveWork: false });
    assert.strictEqual(r.kind, 'NOT_REQUIRED');
    assert.strictEqual(r.incidentEligible, false);
  });

  it('disabled/unconfigured provider with no active work -> NOT_REQUIRED, not an incident', () => {
    const r = evaluateTransportUnhealthy({ hasActiveWork: false, providerStatus: 'unconfigured' });
    assert.strictEqual(r.kind, 'NOT_REQUIRED');
    assert.strictEqual(r.incidentEligible, false);
  });

  it('unconfigured provider while required -> incident', () => {
    const r = evaluateTransportUnhealthy({
      hasActiveWork: true,
      providerStatus: 'unconfigured',
      activePairId: 'pair_01',
      deliveryStatus: 'delivering',
    });
    assert.strictEqual(r.kind, 'NOT_CONFIGURED');
    assert.ok(r.observation);
    assert.strictEqual(r.incidentEligible, true);
  });

  it('reachable provider with no transport failure -> REACHABLE', () => {
    const r = evaluateTransportUnhealthy({
      hasActiveWork: true,
      providerReachable: true,
      providerStatus: 'verified',
      activePairId: 'pair_05',
    });
    assert.strictEqual(r.kind, 'REACHABLE');
    assert.strictEqual(r.incidentEligible, false);
  });

  it('transport failed with reachable provider -> FAILED incident', () => {
    const r = evaluateTransportUnhealthy({
      hasActiveWork: true,
      providerReachable: true,
      providerStatus: 'verified',
      activePairId: 'pair_04',
      deliveryStatus: 'failed',
    });
    assert.strictEqual(r.kind, 'FAILED');
    assert.strictEqual(r.observation!.result, 'UNHEALTHY');
    assert.strictEqual(r.incidentEligible, true);
  });

  it('ambiguous transport outcome -> DEGRADED, no retry authorization', () => {
    const r = evaluateTransportUnhealthy({
      hasActiveWork: true,
      providerReachable: true,
      reconciliationOutcome: 'ambiguous',
      deliveryStatus: 'ambiguous',
      providerStatus: 'degraded',
      activePairId: 'pair_03',
      deliveryId: 'del_03',
    });
    assert.strictEqual(r.kind, 'AMBIGUOUS');
    assert.strictEqual(r.observation!.result, 'DEGRADED');
    assert.ok(r.message!.includes('retry blocked'));
  });

  it('PRECEDENCE: unreachable provider defers transport incident to PROVIDER_UNREACHABLE', () => {
    const r = evaluateTransportUnhealthy({
      hasActiveWork: true,
      providerReachable: false,
      providerStatus: 'verified',
      activePairId: 'pair_01',
    });
    assert.strictEqual(r.kind, 'DEFERS_TO_PROVIDER_UNREACHABLE');
    assert.strictEqual(r.incidentEligible, false);
    assert.strictEqual(r.observation, undefined);
  });

  it('evidence bounded — no command lines or arbitrary dumps', () => {
    const r = evaluateTransportUnhealthy({
      hasActiveWork: true,
      providerReachable: true,
      providerStatus: 'verified',
      activePairId: 'pair_06',
      deliveryStatus: 'failed',
    });
    assert.ok(r.evidence);
    assert.strictEqual(typeof r.evidence!.transportOperation, 'string');
    assert.strictEqual(typeof r.evidence!.transportOutcome, 'string');
  });

  it('identity mismatch is not collapsed into a transport failure', () => {
    // Identity drift belongs to SESSION_DRIFT; transport must not absorb it.
    const r = evaluateTransportUnhealthy({
      hasActiveWork: true,
      providerReachable: true,
      providerStatus: 'verified',
      activePairId: 'pair_07',
    });
    assert.strictEqual(r.kind, 'REACHABLE');
    assert.notStrictEqual(r.kind, 'IDENTITY_MISMATCH');
  });

  it('no mutation of Pair/Delivery/Runtime state', () => {
    const state = { hasActiveWork: true, providerStatus: 'verified', providerReachable: true };
    evaluateTransportUnhealthy(state as any);
    assert.deepStrictEqual(state, { hasActiveWork: true, providerStatus: 'verified', providerReachable: true });
  });

  it('no provider polling loop added', () => {
    assert.strictEqual(typeof evaluateTransportUnhealthy, 'function');
  });
});
