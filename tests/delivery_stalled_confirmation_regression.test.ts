// Prompt 4.1 focused regression — DELIVERY_STALLED confirmation & ambiguous.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { evaluateDeliveryStalled, STALLED_WARNING_MS, STALLED_ERROR_MS } from '../src/relay/health/deliveryStalledCheck';

describe('DELIVERY_STALLED confirmation', () => {
  test('first stale sample does not create incident (candidate only)', () => {
    const now = 100_000;
    const res = evaluateDeliveryStalled('pending', now - 150_000, now - 150_000, 'del_1', now);
    assert.strictEqual(res.kind, 'DEGRADED');
    assert.strictEqual(res.observation, undefined); // NO HealthObservation on first
    assert.strictEqual(res.message?.includes('first qualifying sample'), true);
  });

  test('second confirmed stale sample creates incident', () => {
    const now = 100_000;
    // First call sets up state conceptually; second call with count >= 1 confirms.
    const resConfirmed = evaluateDeliveryStalled('pending', now - 150_000, now - 150_000, 'del_1', now, undefined, { count: 1 });
    assert.strictEqual(resConfirmed.kind, 'UNHEALTHY');
    assert.ok(resConfirmed.observation, 'observations MUST exist on confirmed');
    assert.strictEqual(resConfirmed.observation!.result, 'UNHEALTHY');
  });

  test('ambiguous is DEGRADED not HEALTHY and never triggers retry', () => {
    const now = 100_000;
    const res = evaluateDeliveryStalled('ambiguous', 0, 0, 'del_amb', now);
    assert.strictEqual(res.kind, 'DEGRADED');
    assert.strictEqual(res.observation?.result, 'DEGRADED');
    assert.strictEqual(res.message?.includes('retry not authorized'), true);
  });

  test('thresholds are centralized and documented', () => {
    assert.strictEqual(STALLED_WARNING_MS, 30_000, 'warning threshold centralized');
    assert.strictEqual(STALLED_ERROR_MS, 120_000, 'error threshold centralized');
  });

  test('candidate does not grant retry authorization', () => {
    const res = evaluateDeliveryStalled('pending', 0, 0, 'del_c', 50_000, undefined, { count: 0 });
    assert.strictEqual(res.kind, 'DEGRADED');
    assert.strictEqual(res.observation, undefined);
    // Evidence exists; observation does not -> no incident -> no retry auth.
  });
});
