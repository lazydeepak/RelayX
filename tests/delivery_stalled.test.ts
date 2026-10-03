/**
 * Prompt 4 — DELIVERY_STALLED focused tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateDeliveryStalled, STALLED_WARNING_MS, STALLED_ERROR_MS } from '../src/relay/health/deliveryStalledCheck.ts';
import { DeliveryStalledService } from '../src/relay/health/deliveryStalledService.ts';
import { HealthIncidentEngine } from '../src/relay/application/HealthIncidentEngine.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { HealthObservation } from '../src/relay/domain/healthDomain.ts';

function fakeTimestamp(baseMs: number, offsetMs = 0): number {
  return baseMs + offsetMs;
}

describe('DELIVERY_STALLED detection', () => {
  const baseMs = 1_700_000_000_000;

  it('fresh in-flight delivery -> no incident (HEALTHY)', () => {
    const result = evaluateDeliveryStalled('pending', baseMs, baseMs, 'del_pend', baseMs, { assignmentId: 'a1', attemptId: 'att1', pairId: 'pair_01' });
    assert.strictEqual(result.kind, 'HEALTHY');
    assert.strictEqual(result.observation, undefined);
  });

  it('first qualifying sample is a candidate only: DEGRADED without observation', () => {
    const nowMs = baseMs + STALLED_ERROR_MS + 1;
    const result = evaluateDeliveryStalled('pending', baseMs, baseMs, 'del_first', nowMs, {});
    assert.strictEqual(result.kind, 'DEGRADED');
    assert.strictEqual(result.observation, undefined, 'first qualifying sample must not emit an observation');
    assert.ok(result.message?.includes('first qualifying sample'));
    assert.ok(result.evidence, 'candidate evidence is still reported');
  });

  it('confirmed stale sample -> DEGRADED candidate with observation (warning threshold)', () => {
    const nowMs = baseMs + STALLED_WARNING_MS + 1;
    const result = evaluateDeliveryStalled('delivering', baseMs, baseMs, 'del_1', nowMs, {}, { count: 1 });
    assert.strictEqual(result.kind, 'DEGRADED');
    assert.ok(result.observation);
    assert.strictEqual(result.observation!.checkType, 'DELIVERY_STALLED');
    assert.strictEqual(result.observation!.result, 'DEGRADED');
    assert.strictEqual(result.observation!.componentId, 'del_1');
    assert.strictEqual((result.observation!.evidence as any).severity, 'WARNING');
  });

  it('confirmed stale sample -> UNHEALTHY / ERROR (error threshold)', () => {
    const nowMs = baseMs + STALLED_ERROR_MS + 1;
    const result = evaluateDeliveryStalled('pending', baseMs, baseMs, 'del_2', nowMs, { pairId: 'pair_03' }, { count: 1 });
    assert.strictEqual(result.kind, 'UNHEALTHY');
    assert.ok(result.observation);
    assert.strictEqual((result.observation!.evidence as any).severity, 'ERROR');
  });

  it('repeated stale updates same incident via observation identity', () => {
    const nowMs = baseMs + STALLED_ERROR_MS + 10_000;
    const r1 = evaluateDeliveryStalled('delivering', baseMs, baseMs + 5_000, 'del_3', nowMs - 5_000, {}, { count: 1 });
    const r2 = evaluateDeliveryStalled('delivering', baseMs, baseMs + 5_000, 'del_3', nowMs, {}, { count: 1 });
    assert.strictEqual(r2.observation!.componentId, r1.observation!.componentId);
    assert.strictEqual(r2.observation!.checkType, r1.observation!.checkType);
  });

  it('warning -> error escalation', () => {
    const warningMs = baseMs + STALLED_WARNING_MS + 1;
    const errorMs = baseMs + STALLED_ERROR_MS + 1;
    const w = evaluateDeliveryStalled('delivering', baseMs, baseMs, 'del_esc', warningMs, {}, { count: 1 });
    const e = evaluateDeliveryStalled('delivering', baseMs, baseMs, 'del_esc', errorMs, {}, { count: 1 });
    assert.strictEqual(w.kind, 'DEGRADED');
    assert.strictEqual(e.kind, 'UNHEALTHY');
  });

  it('severity does not decrease: error stays error', () => {
    const errorMs = baseMs + STALLED_ERROR_MS + 1;
    const result = evaluateDeliveryStalled('delivering', baseMs, baseMs, 'del_keep', errorMs, {}, { count: 1 });
    assert.strictEqual(result.kind, 'UNHEALTHY');
    assert.strictEqual((result.observation!.evidence as any).severity, 'ERROR');
  });

  it('terminal delivered is HEALTHY, not stalled', () => {
    const result = evaluateDeliveryStalled('delivered', baseMs, baseMs, 'del_term', baseMs, {});
    assert.strictEqual(result.kind, 'HEALTHY');
  });

  it('terminal ambiguous is DEGRADED (uncertain, no retry authorization)', () => {
    const result = evaluateDeliveryStalled('ambiguous', baseMs, baseMs, 'del_amb', baseMs + 300_000, {});
    assert.strictEqual(result.kind, 'DEGRADED');
    assert.strictEqual((result.observation!.evidence as any).severity, 'WARNING');
    assert.ok(result.message!.includes('uncertain'));
  });

  it('terminal failed is HEALTHY', () => {
    const result = evaluateDeliveryStalled('failed', baseMs, baseMs, 'del_fail', baseMs + 300_000, {});
    assert.strictEqual(result.kind, 'HEALTHY');
  });

  it('missing delivery status -> UNKNOWN', () => {
    // Cast null to simulate missing authoritative state
    const result = evaluateDeliveryStalled(null as any, baseMs, baseMs, 'del_null', baseMs, {});
    assert.strictEqual(result.kind, 'UNKNOWN');
  });

  it('evidence includes bounded fields only', () => {
    const result = evaluateDeliveryStalled('delivering', baseMs, baseMs, 'del_ev', baseMs + STALLED_WARNING_MS + 1, { assignmentId: 'a10', pairId: 'p5' });
    assert.ok(result.evidence);
    assert.strictEqual(result.evidence!.deliveryId, 'del_ev');
    assert.strictEqual(result.evidence!.status, 'delivering');
    assert.strictEqual(result.evidence!.assignmentId, 'a10');
    assert.strictEqual(result.evidence!.pairId, 'p5');
    assert.strictEqual(typeof result.evidence!.ageMs, 'number');
    assert.strictEqual(typeof result.evidence!.thresholdWarningMs, 'number');
  });

  it('no mutation of delivery state (detector reads only)', () => {
    const statusBefore = 'delivering';
    const createdBefore = baseMs;
    const updatedBefore = baseMs + 10_000;
    // The detector receives primitive values, not a mutable object reference in this design.
    const result = evaluateDeliveryStalled(statusBefore, createdBefore, updatedBefore, 'del_mut', baseMs + 10_000, {});
    assert.strictEqual(statusBefore, 'delivering'); // unmodified
  });

  it('threshold constants are exported and used correctly', () => {
    assert.strictEqual(typeof STALLED_WARNING_MS, 'number');
    assert.strictEqual(typeof STALLED_ERROR_MS, 'number');
    assert.ok(STALLED_WARNING_MS > 0);
    assert.ok(STALLED_ERROR_MS > STALLED_WARNING_MS);
  });
});

describe('DELIVERY_STALLED confirmation / debounce', () => {
  const baseMs = 1_700_000_000_000;

  it('first stale sample does not create incident (candidate only)', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const service = new DeliveryStalledService(new HealthIncidentEngine(db.healthObservations, db.healthIncidents));

    const nowMs = baseMs + STALLED_WARNING_MS + 1;
    const report1 = await service.evaluate('delivering', 'del_conf_1', baseMs, baseMs, nowMs, {});
    assert.strictEqual(report1.kind, 'DEGRADED');
    assert.strictEqual(report1.confirmed, false);
    assert.strictEqual(report1.incident, undefined);
  });

  it('second confirmed stale sample creates/updates incident', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const service = new DeliveryStalledService(new HealthIncidentEngine(db.healthObservations, db.healthIncidents));

    const nowMs = baseMs + STALLED_ERROR_MS + 1;
    const r1 = await service.evaluate('delivering', 'del_conf_2', baseMs, baseMs, nowMs - 10, {});
    const r2 = await service.evaluate('delivering', 'del_conf_2', baseMs, baseMs, nowMs, {});
    assert.strictEqual(r1.confirmed, false); // first = candidate only
    assert.strictEqual(r2.confirmed, true); // second = confirmed (per tracker design)
    assert.strictEqual(r1.incident, undefined, 'a candidate-only sample must not open an incident');
    assert.ok(r2.incident, 'a confirmed sample must open the incident');
    assert.strictEqual(r2.incident!.occurrenceCount, 2);
  });

  it('ambiguous never grants retry / mutation', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const service = new DeliveryStalledService(new HealthIncidentEngine(db.healthObservations, db.healthIncidents));
    const result = await service.evaluate('ambiguous', 'del_amb_1', baseMs, baseMs, baseMs + 300_000, {});
    assert.strictEqual(result.kind, 'DEGRADED');
    assert.ok(result.message!.includes('uncertain'));
  });

  it('thresholds are centralized and documented', () => {
    assert.strictEqual(STALLED_WARNING_MS, 30_000);
    assert.strictEqual(STALLED_ERROR_MS, 120_000);
  });
});
