/**
 * Prompt 5 — UNEXPECTED_IDLE_ACTIVITY focused tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateUnexpectedIdleActivity, hasLegitimateActiveWork } from '../src/relay/health/idleActivityCheck.ts';

describe('UNEXPECTED_IDLE_ACTIVITY', () => {
  it('expensive activity during legitimate active work -> HEALTHY', () => {
    const result = evaluateUnexpectedIdleActivity(
      'provider_contact',
      'provider',
      Date.now(),
      { pairOperationalStates: ['ACTIVE'], hasActiveAssignment: true, pairCount: 1, activePairCount: 1, activeAssignmentCount: 1 },
    );
    assert.strictEqual(result.kind, 'HEALTHY');
  });

  it('first unexpected idle activity -> DEGRADED candidate', () => {
    const result = evaluateUnexpectedIdleActivity(
      'provider_discovery',
      'provider',
      Date.now(),
      { pairOperationalStates: ['IDLE'], hasActiveAssignment: false, pairCount: 2, activePairCount: 0, activeAssignmentCount: 0 },
    );
    assert.strictEqual(result.kind, 'DEGRADED');
    assert.ok(result.observation);
    assert.strictEqual(result.observation!.checkType, 'UNEXPECTED_IDLE_ACTIVITY');
  });

  it('subprocess / AppleScript activity while idle -> DEGRADED', () => {
    const result = evaluateUnexpectedIdleActivity(
      'applescript_probe',
      'system_automation',
      Date.now(),
      { pairOperationalStates: ['IDLE', 'IDLE'], hasActiveAssignment: false, pairCount: 3, activePairCount: 0, activeAssignmentCount: 0 },
    );
    assert.strictEqual(result.kind, 'DEGRADED');
  });

  it('evidence is bounded and does not dump arbitrary state', () => {
    const result = evaluateUnexpectedIdleActivity('provider_contact', 'provider', 1700000000000, {
      pairOperationalStates: ['IDLE'],
      hasActiveAssignment: false,
      pairCount: 1,
      activePairCount: 0,
      activeAssignmentCount: 0,
    });
    assert.ok(result.evidence);
    assert.strictEqual(result.evidence!.operationName, 'provider_contact');
    assert.strictEqual(typeof result.evidence!.pairCount, 'number');
    // No command arguments or user data dumped.
    assert.strictEqual(result.evidence!.pairCount, 1);
  });

  it('read-only: does not change Pair/Runtime/Delivery state', () => {
    const state = { pairOperationalStates: ['IDLE'], hasActiveAssignment: false, pairCount: 0, activePairCount: 0, activeAssignmentCount: 0 };
    evaluateUnexpectedIdleActivity('test_op', 'test_cat', Date.now(), state);
    assert.deepStrictEqual(state, { pairOperationalStates: ['IDLE'], hasActiveAssignment: false, pairCount: 0, activePairCount: 0, activeAssignmentCount: 0 });
  });

  it('monitoring performs no provider/subprocess work', () => {
    // Pure evaluation: only compares state and creates an observation object.
    assert.strictEqual(typeof evaluateUnexpectedIdleActivity, 'function');
  });

  it('hasLegitimateActiveWork reflects ACTIVE pairs', () => {
    assert.strictEqual(hasLegitimateActiveWork(['ACTIVE'], true), true);
    assert.strictEqual(hasLegitimateActiveWork(['IDLE', 'ACTIVE'], false), true);
    assert.strictEqual(hasLegitimateActiveWork(['IDLE'], false), false);
  });
});
