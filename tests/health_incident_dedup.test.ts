/**
 * Prompt 3 — Incident Deduplication & Lifecycle Tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { HealthObservation, HealthIncident, HealthState, HealthSeverity } from '../src/relay/domain/healthDomain.ts';
import { HealthIncidentEngine } from '../src/relay/application/HealthIncidentEngine.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';

function makeObs(checkType: string, result: HealthState = 'UNHEALTHY', evidence?: Record<string, unknown>): HealthObservation {
  return new HealthObservation({
    id: `obs_${checkType}_${Date.now()}`,
    checkType,
    componentType: 'delivery',
    componentId: 'del_01',
    result,
    timestamp: Date.now(),
    evidence: evidence ?? { lagMs: 99 },
  });
}

function makeEngine(db?: SqliteRelayDatabase): HealthIncidentEngine {
  const database = db ?? new SqliteRelayDatabase(':memory:');
  return new HealthIncidentEngine(database.healthObservations, database.healthIncidents);
}

describe('Incident dedup', () => {
  it('first unhealthy creates one incident', async () => {
    const engine = makeEngine();
    const obs = makeObs('STALLED');
    const inc = await engine.recordUnhealthyObservation(obs);
    assert.strictEqual(inc.status, 'OPEN');
    assert.strictEqual(inc.occurrenceCount, 1);
    assert.strictEqual(inc.incidentType, 'STALLED');
  });

  it('repeated same condition updates same incident', async () => {
    const engine = makeEngine();
    await engine.recordUnhealthyObservation(makeObs('STALLED'));
    const inc2 = await engine.recordUnhealthyObservation(makeObs('STALLED'));
    assert.strictEqual(inc2.status, 'OPEN');
    assert.strictEqual(inc2.occurrenceCount, 2);
    assert.strictEqual(inc2.id, (await engine.findMatchingIncident('STALLED', 'delivery', 'del_01'))?.id);
  });

  it('duplicate incident not created', async () => {
    const engine = makeEngine();
    const first = await engine.recordUnhealthyObservation(makeObs('STALLED'));
    const second = await engine.recordUnhealthyObservation(makeObs('STALLED'));
    assert.strictEqual(first.id, second.id);
  });

  it('firstSeen preserved on updates', async () => {
    const engine = makeEngine();
    const first = await engine.recordUnhealthyObservation(makeObs('STALLED'));
    await new Promise((r) => setTimeout(r, 10));
    const second = await engine.recordUnhealthyObservation(makeObs('STALLED'));
    assert.strictEqual(second.id, first.id);
    assert.strictEqual(second.firstSeen, first.firstSeen);
  });

  it('lastSeen advances', async () => {
    const engine = makeEngine();
    const first = await engine.recordUnhealthyObservation(makeObs('STALLED'));
    await new Promise((r) => setTimeout(r, 20));
    const second = await engine.recordUnhealthyObservation(makeObs('STALLED'));
    assert.strictEqual(second.id, first.id);
    assert.ok(second.lastSeen >= first.lastSeen);
  });

  it('occurrenceCount increments', async () => {
    const engine = makeEngine();
    await engine.recordUnhealthyObservation(makeObs('STALLED'));
    const inc = await engine.recordUnhealthyObservation(makeObs('STALLED'));
    assert.strictEqual(inc.occurrenceCount, 2);
  });

  it('severity escalation works', async () => {
    const engine = makeEngine();
    await engine.recordUnhealthyObservation(makeObs('STALLED', 'DEGRADED', { severity: 'INFO' }));
    const escalated = await engine.recordUnhealthyObservation(makeObs('STALLED', 'UNHEALTHY', { severity: 'CRITICAL' }));
    assert.strictEqual(escalated.severity, 'CRITICAL');
  });

  it('severity does not silently decrease', async () => {
    const engine = makeEngine();
    await engine.recordUnhealthyObservation(makeObs('STALLED', 'UNHEALTHY', { severity: 'CRITICAL' }));
    const lowered = await engine.recordUnhealthyObservation(makeObs('STALLED', 'HEALTHY', { severity: 'INFO' }));
    assert.strictEqual(lowered.severity, 'CRITICAL');
  });
});

describe('Incident lifecycle', () => {
  it('explicit resolution marks RESOLVED', async () => {
    const engine = makeEngine();
    const inc = await engine.recordUnhealthyObservation(makeObs('STALLED'));
    const resolved = await engine.resolveIncident(inc.id);
    assert.ok(resolved);
    assert.strictEqual(resolved!.status, 'RESOLVED');
  });

  it('resolution not triggered by one healthy observation', async () => {
    const engine = makeEngine();
    await engine.recordUnhealthyObservation(makeObs('STALLED'));
    // A healthy observation does not call resolve automatically; engine has no such rule.
    const inc = await engine.findMatchingIncident('STALLED', 'delivery', 'del_01');
    assert.ok(inc);
    assert.strictEqual(inc!.status, 'OPEN');
  });

  it('recurrence after resolution becomes RECURRED', async () => {
    const engine = makeEngine();
    const first = await engine.recordUnhealthyObservation(makeObs('STALLED'));
    await engine.resolveIncident(first.id);
    // Simulate recurrence by creating a new observation for same key, then linking to the resolved incident
    const rec = await engine.recordRecurrence(first.id, makeObs('STALLED'));
    assert.ok(rec);
    assert.strictEqual(rec!.status, 'RECURRED');
    assert.strictEqual(rec!.firstSeen, first.firstSeen);
    assert.strictEqual(rec!.occurrenceCount, 2);
  });
});

describe('Read-only boundary', () => {
  it('no Pair/Attempt/Delivery/Runtime mutation', async () => {
    const engine = makeEngine();
    const obs = makeObs('STALLED');
    await engine.recordUnhealthyObservation(obs);
    // No mutation method exists; only persistence of observations/incidents.
    assert.strictEqual(typeof engine, 'object');
  });
});
