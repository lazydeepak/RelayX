/**
 * Diagnostics — Evidence Semantics Tests
 *
 * Verifies:
 * 1. 0 configured != Unknown (reported as INACTIVE).
 * 2. No telemetry/activity != Healthy (Performance with 0 measurements is INACTIVE).
 * 3. Healthy requires positive current evidence (positive measurements within budget).
 * 4. Separate observation from readiness.
 * 5. Correct planner/worker/transport/checkpoint/performance semantics.
 * 6. Consistent Overall Health derivation without fabricated/synthetic evidence.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { relayDiagnostics } from '../src/relay/application/RelayDiagnostics.ts';

describe('Diagnostics — Evidence Semantics', () => {
  it('1. 0 configured components report INACTIVE rather than UNKNOWN', () => {
    const report = relayDiagnostics.evaluateHealth({
      dbStatus: { ok: true, type: 'sqlite_wal' },
      pairs: [],
      runtimes: [],
      pairsCount: 0,
      runtimesCount: 0,
      openAttentionCount: 0,
      checkpointsCount: 0,
      deliveriesCount: 0,
    });

    assert.strictEqual(report.components['Pair'].status, 'INACTIVE', '0 pairs must be INACTIVE');
    assert.strictEqual(report.components['Planner'].status, 'INACTIVE', '0 planners must be INACTIVE');
    assert.strictEqual(report.components['Worker'].status, 'INACTIVE', '0 workers must be INACTIVE');
    assert.strictEqual(report.components['Transport'].status, 'INACTIVE', '0 transport deliveries must be INACTIVE');
    assert.strictEqual(report.components['Checkpoint'].status, 'INACTIVE', '0 checkpoints must be INACTIVE');
  });

  it('2. Performance with 0 telemetry measurements reports INACTIVE, never healthy', () => {
    const report = relayDiagnostics.evaluateHealth({
      dbStatus: { ok: true, type: 'sqlite_wal' },
      pairs: [],
      runtimes: [],
    });

    assert.strictEqual(
      report.components['Performance'].status,
      'INACTIVE',
      'No telemetry/activity != Healthy'
    );
    assert.strictEqual(report.components['Performance'].evidence.length, 0);
  });

  it('3. Performance becomes HEALTHY only with positive current measurements within budget', () => {
    // Record real measurements
    relayDiagnostics.record({
      operation: 'dispatch_benchmark',
      durationMs: 45,
      timestamp: Date.now(),
      success: true,
    });

    const report = relayDiagnostics.evaluateHealth({
      dbStatus: { ok: true, type: 'sqlite_wal' },
      pairs: [],
      runtimes: [],
    });

    assert.strictEqual(report.components['Performance'].status, 'HEALTHY');
    assert.ok(report.components['Performance'].evidence.length > 0);
    assert.ok(report.components['Performance'].evidence[0].includes('dispatch_benchmark'));
  });

  it('4. Performance degrades when operations exceed the latency budget', () => {
    // Record slow operation
    relayDiagnostics.record({
      operation: 'slow_synthetic_heavy_query',
      durationMs: 1450,
      timestamp: Date.now(),
      success: true,
    });

    const report = relayDiagnostics.evaluateHealth({
      dbStatus: { ok: true, type: 'sqlite_wal' },
      pairs: [],
      runtimes: [],
    });

    assert.strictEqual(report.components['Performance'].status, 'DEGRADED');
    assert.strictEqual(report.overall, 'DEGRADED');
    assert.ok(report.problems.some((p) => p.includes('slow_synthetic_heavy_query')));
  });

  it('5. Observed runtimes report HEALTHY with positive observation evidence', () => {
    const report = relayDiagnostics.evaluateHealth({
      dbStatus: { ok: true, type: 'sqlite_wal' },
      pairs: [
        { id: 'pair_1', plannerSessionId: 'planner_1', workerSessionId: 'worker_1' },
      ],
      runtimes: [
        {
          id: 'planner_1',
          providerType: 'chatgpt',
          status: 'available',
          lastObservedAt: Date.now(),
          consecutiveObservationFailures: 0,
        },
        {
          id: 'worker_1',
          providerType: 'opencode',
          status: 'working',
          lastObservedAt: Date.now(),
          consecutiveObservationFailures: 0,
        },
      ],
      checkpointsCount: 3,
      deliveriesCount: 5,
      openAttentionCount: 0,
    });

    assert.strictEqual(report.components['Planner'].status, 'HEALTHY');
    assert.strictEqual(report.components['Worker'].status, 'HEALTHY');
    assert.strictEqual(report.components['Pair'].status, 'HEALTHY');
    assert.strictEqual(report.components['Checkpoint'].status, 'HEALTHY');
    assert.strictEqual(report.components['Transport'].status, 'HEALTHY');
  });

  it('6. Attention items degrade Attempt/Delivery and Overall status', () => {
    const report = relayDiagnostics.evaluateHealth({
      dbStatus: { ok: true, type: 'sqlite_wal' },
      pairs: [],
      runtimes: [],
      openAttentionCount: 2,
    });

    assert.strictEqual(report.components['Attempt/Delivery'].status, 'DEGRADED');
    assert.strictEqual(report.overall, 'DEGRADED');
    assert.ok(report.problems.some((p) => p.includes('Open attention items')));
  });
});
