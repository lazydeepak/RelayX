/**
 * Phase 1 Health UI — projection and presentation-logic tests.
 *
 * These prove the UI path is a bounded, read-only projection of persisted health
 * state. No provider, subprocess, AppleScript, session discovery, or timer is
 * involved anywhere in this path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { HealthIncidentEngine } from '../src/relay/application/HealthIncidentEngine.ts';
import { HealthIncident, HealthObservation } from '../src/relay/domain/healthDomain.ts';
import {
  HealthProjectionService,
  HEALTH_HISTORY_DEFAULT_LIMIT,
  HEALTH_QUERY_MAX_LIMIT,
} from '../src/relay/application/HealthProjectionService.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';

const T0 = 1_700_000_000_000;

function harness() {
  const db = new MemoryRelayDatabase();
  const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
  const projection = new HealthProjectionService({
    incidentsRepo: db.healthIncidents,
    observationsRepo: db.healthObservations,
  });
  return { db, engine, projection };
}

function obs(id: string, result: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' = 'HEALTHY', ts = T0): HealthObservation {
  return new HealthObservation({
    id, checkType: 'MAIN_PROCESS_STALL', componentType: 'main_process',
    componentId: 'electron_main', result, timestamp: ts, evidence: { measuredLagMs: 12 },
  });
}

function incident(
  id: string,
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL',
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'RECURRED' = 'OPEN',
  evidence: Record<string, unknown> = {},
): HealthIncident {
  return new HealthIncident({
    id, incidentType: 'DELIVERY_STALLED', componentType: 'delivery', componentId: `del_${id}`,
    severity, status, firstSeen: T0, lastSeen: T0, occurrenceCount: 1, evidence,
  });
}

/* ---------- 1-4: overall aggregation ---------- */

describe('health UI: overall aggregation', () => {
  it('ERROR incident -> UNHEALTHY', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('a', 'ERROR'));
    await db.healthObservations.save(obs('o1'));
    const s = await projection.getHealthSummary();
    assert.strictEqual(s.overall, 'UNHEALTHY');
    assert.ok(s.overallReason.includes('ERROR'));
  });

  it('CRITICAL incident -> UNHEALTHY', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('c', 'CRITICAL'));
    await db.healthObservations.save(obs('o1'));
    assert.strictEqual((await projection.getHealthSummary()).overall, 'UNHEALTHY');
  });

  it('only WARNING -> DEGRADED', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('w', 'WARNING'));
    await db.healthObservations.save(obs('o1'));
    assert.strictEqual((await projection.getHealthSummary()).overall, 'DEGRADED');
  });

  it('valid evidence + no active incident -> HEALTHY', async () => {
    const { db, projection } = harness();
    await db.healthObservations.save(obs('o1'));
    const s = await projection.getHealthSummary();
    assert.strictEqual(s.overall, 'HEALTHY');
    assert.strictEqual(s.hasSufficientEvidence, true);
  });

  it('NO evidence + no incident -> UNKNOWN, never HEALTHY', async () => {
    const { projection } = harness();
    const s = await projection.getHealthSummary();
    assert.strictEqual(s.overall, 'UNKNOWN', 'empty incident table must not read as healthy');
    assert.strictEqual(s.hasSufficientEvidence, false);
    assert.strictEqual(s.activeIncidentCount, 0);
  });

  it('INFO alone does NOT degrade overall health', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('i', 'INFO'));
    await db.healthObservations.save(obs('o1'));
    const s = await projection.getHealthSummary();
    assert.strictEqual(s.overall, 'HEALTHY', 'INFO is noteworthy-but-healthy, not a degradation');
    // It is still counted and surfaced, just not degrading.
    assert.strictEqual(s.activeIncidentCount, 1);
    assert.ok(s.overallReason.includes('informational'));
  });

  it('INFO plus WARNING -> DEGRADED (WARNING still governs)', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('i', 'INFO'));
    await db.healthIncidents.save(incident('w', 'WARNING'));
    await db.healthObservations.save(obs('o1'));
    assert.strictEqual((await projection.getHealthSummary()).overall, 'DEGRADED');
  });

  it('INFO does not mask a real ERROR', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('i', 'INFO'));
    await db.healthIncidents.save(incident('e', 'ERROR'));
    await db.healthObservations.save(obs('o1'));
    assert.strictEqual((await projection.getHealthSummary()).overall, 'UNHEALTHY');
  });

  it('acknowledged incident still counts as active', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('a', 'WARNING', 'ACKNOWLEDGED'));
    await db.healthObservations.save(obs('o1'));
    const s = await projection.getHealthSummary();
    assert.strictEqual(s.overall, 'DEGRADED');
    assert.strictEqual(s.activeIncidentCount, 1);
  });
});

/* ---------- 5: active incident fields ---------- */

describe('health UI: active incidents', () => {
  it('renders correct type, severity, component, lifecycle, and counters', async () => {
    const { db, projection } = harness();
    const inc = incident('x', 'ERROR', 'OPEN', { ageMs: 200_000, deliveryId: 'del_x' });
    inc.updateFromObservation('ERROR', { ageMs: 300_000 }, T0 + 1000);
    await db.healthIncidents.save(inc);

    const list = await projection.listActiveIncidents();
    assert.strictEqual(list.length, 1);
    const item = list[0];
    assert.strictEqual(item.incidentType, 'DELIVERY_STALLED');
    assert.strictEqual(item.severity, 'ERROR');
    assert.strictEqual(item.status, 'OPEN');
    assert.strictEqual(item.componentType, 'delivery');
    assert.strictEqual(item.componentId, 'del_x');
    assert.strictEqual(item.occurrenceCount, 2);
    assert.strictEqual(item.firstSeen, T0);
    assert.ok(item.lastSeen > T0);
  });

  it('sorts by severity then recency', async () => {
    const { db, projection } = harness();
    const err = incident('z', 'ERROR');
    err.lastSeen = T0 + 10;
    const warn = incident('y', 'WARNING');
    warn.lastSeen = T0 + 9999;
    const crit = incident('x', 'CRITICAL');
    crit.lastSeen = T0;
    await db.healthIncidents.save(err);
    await db.healthIncidents.save(warn);
    await db.healthIncidents.save(crit);

    const list = await projection.listActiveIncidents();
    assert.deepStrictEqual(list.map((i) => i.severity), ['CRITICAL', 'ERROR', 'WARNING']);
  });
});

/* ---------- 6: bounded detail evidence ---------- */

describe('health UI: incident detail', () => {
  it('surfaces bounded scalar evidence', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('d', 'ERROR', 'OPEN', {
      deliveryId: 'del_d', pairId: 'pair_d', ageMs: 200_000,
      thresholdWarningMs: 30_000, thresholdErrorMs: 120_000,
    }));
    const detail = await projection.getHealthIncident('d');
    assert.ok(detail);
    assert.strictEqual(detail!.evidence.deliveryId, 'del_d');
    assert.strictEqual(detail!.evidence.ageMs, 200_000);
  });

  it('DROPS nested objects and arrays so large payloads cannot reach the UI', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('n', 'ERROR', 'OPEN', {
      transcript: 'a'.repeat(50_000),
      messages: [{ role: 'user', content: 'secret prompt' }],
      nested: { deep: { deeper: 'blob' } },
      keep: 'yes',
    }));
    const detail = await projection.getHealthIncident('n');
    assert.strictEqual(detail!.evidence.transcript, undefined, 'long string is dropped, not truncated-and-sent');
    assert.strictEqual(detail!.evidence.messages, undefined);
    assert.strictEqual(detail!.evidence.nested, undefined);
    assert.strictEqual(detail!.evidence.keep, 'yes');
  });

  it('lists identity fields that are unavailable rather than faking them', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('u', 'WARNING', 'OPEN', { deliveryId: 'del_u' }));
    const detail = await projection.getHealthIncident('u');
    assert.ok(detail!.unavailableFields.includes('pairId'));
    assert.ok(detail!.unavailableFields.includes('providerType'));
    assert.ok(!detail!.unavailableFields.includes('deliveryId'));
  });

  it('returns null for an unknown incident', async () => {
    const { projection } = harness();
    assert.strictEqual(await projection.getHealthIncident('nope'), null);
  });
});

/* ---------- 7-8: bounded history + recurrence ---------- */

describe('health UI: history', () => {
  it('resolved incidents appear in bounded history and not in active', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('r', 'WARNING', 'RESOLVED'));
    const history = await projection.listResolvedIncidents();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].status, 'RESOLVED');
    assert.strictEqual((await projection.listActiveIncidents()).length, 0);
  });

  it('recurrence is visibly distinguishable from plain resolution', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('rc', 'WARNING', 'RECURRED', { occurrenceCountNote: 'seen again' }));
    const history = await projection.listResolvedIncidents();
    assert.strictEqual(history[0].status, 'RECURRED');
    assert.notStrictEqual(history[0].status, 'RESOLVED');
  });

  it('history is bounded even with many resolved incidents', async () => {
    const { db, projection } = harness();
    for (let i = 0; i < 150; i++) {
      await db.healthIncidents.save(incident(`r${i}`, 'WARNING', 'RESOLVED'));
    }
    const history = await projection.listResolvedIncidents();
    assert.ok(history.length <= HEALTH_HISTORY_DEFAULT_LIMIT);
  });
});

/* ---------- 9: acknowledgement semantics ---------- */

describe('health UI: acknowledgement', () => {
  it('OPEN -> ACKNOWLEDGED and does NOT resolve', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('ack', 'ERROR', 'OPEN'));
    const res = await projection.acknowledgeIncident('ack');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'ACKNOWLEDGED');

    const stored = await db.healthIncidents.findById('ack');
    assert.strictEqual(stored!.status, 'ACKNOWLEDGED');
    // Still counts as an active incident: acknowledgement is not recovery.
    assert.strictEqual((await projection.listActiveIncidents()).length, 1);
  });

  it('acknowledgement preserves ACKNOWLEDGED across later observations', async () => {
    const { db, engine, projection } = harness();
    await db.healthIncidents.save(incident('ack2', 'ERROR', 'OPEN'));
    await projection.acknowledgeIncident('ack2');
    await engine.recordUnhealthyObservation(new HealthObservation({
      id: 'later', checkType: 'DELIVERY_STALLED', componentType: 'delivery',
      componentId: 'del_ack2', result: 'UNHEALTHY', timestamp: T0 + 1, evidence: { severity: 'ERROR' },
    }));
    const stored = await db.healthIncidents.findById('ack2');
    assert.strictEqual(stored!.status, 'ACKNOWLEDGED');
  });

  it('refuses to acknowledge a RESOLVED incident', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('done', 'WARNING', 'RESOLVED'));
    assert.strictEqual((await projection.acknowledgeIncident('done')).success, false);
  });

  it('acknowledgement touches no operational repository', async () => {
    const { db, projection } = harness();
    await db.healthIncidents.save(incident('ro', 'ERROR', 'OPEN'));
    await projection.acknowledgeIncident('ro');
    assert.deepStrictEqual(await db.pairs.findAll(), []);
    assert.deepStrictEqual(await db.runtimes.findAll(), []);
    assert.deepStrictEqual(await db.assignments.findAll(), []);
  });
});

/* ---------- 10-12: read-only + bounded queries ---------- */

describe('health UI: read-only and bounded', () => {
  it('query limits are clamped, never unbounded', async () => {
    const { db, projection } = harness();
    for (let i = 0; i < 30; i++) {
      await db.healthIncidents.save(incident(`a${i}`, 'WARNING', 'OPEN'));
    }
    const huge = await projection.listActiveIncidents(1_000_000);
    assert.ok(huge.length <= HEALTH_QUERY_MAX_LIMIT);
    assert.strictEqual((await projection.listActiveIncidents(0)).length, HEALTH_HISTORY_DEFAULT_LIMIT);
    assert.strictEqual((await projection.listActiveIncidents(-5)).length, HEALTH_HISTORY_DEFAULT_LIMIT);
  });

  it('observation reads are bounded', async () => {
    const { db, projection } = harness();
    for (let i = 0; i < 200; i++) {
      await db.healthObservations.save(obs(`o${i}`, 'HEALTHY', T0 + i));
    }
    const recent = await projection.listRecentObservations(10_000);
    assert.ok(recent.length <= HEALTH_QUERY_MAX_LIMIT);
  });

  it('renderer health UI owns NO timer', async () => {
    const fs = await import('node:fs');
    const code = fs
      .readFileSync(`${process.cwd()}/src/components/HealthPanel.tsx`, 'utf8')
      // Strip comments so the header's own "no setTimeout here" assertion cannot
      // be mistaken for an actual timer.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(!/setTimeout\s*\(/.test(code), 'renderer UI must not create a timer');
    assert.ok(!/setInterval\s*\(/.test(code), 'renderer UI must not poll');
  });

  it('renderer health UI performs no provider or subprocess work', async () => {
    const fs = await import('node:fs');
    const code = fs
      .readFileSync(`${process.cwd()}/src/components/HealthPanel.tsx`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(!/child_process/.test(code));
    assert.ok(!/execSync|spawnSync|osascript/.test(code));
    assert.ok(!/inspectRuntime|discoverRuntime|activateRuntime|recoverRuntime/.test(code));
    // Only read-only health projections may be CALLED through the bridge.
    // Anchored to `relayBridge.<method>(` so the import path does not match.
    const calls = code.match(/relayBridge\s*\.\s*(\w+)\s*\(/g) ?? [];
    assert.ok(calls.length > 0, 'expected the panel to read health state');
    for (const call of calls) {
      assert.ok(
        /getHealthSummary|listHealthIncidents|getHealthIncident|acknowledgeHealthIncident|generateHealthHandoffReport/.test(call),
        `unexpected bridge call: ${call}`,
      );
    }
  });

  it('projection layer imports no provider, subprocess, or filesystem surface', async () => {
    const fs = await import('node:fs');
    const code = fs
      .readFileSync(`${process.cwd()}/src/relay/application/HealthProjectionService.ts`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(!/node:child_process/.test(code));
    assert.ok(!/\b(execSync|spawnSync)\s*\(/.test(code));
    assert.ok(!/node:fs/.test(code));
    assert.ok(!/adapters\//.test(code));
    assert.ok(!/setTimeout|setInterval/.test(code), 'projection owns no timer');
  });
});

/* ---------- service-level API surface ---------- */

describe('health UI: RelayApiService surface', () => {
  it('exposes read-only health calls through the API service', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const service = new RelayApiService(db, engine, { isElectron: false, databasePath: ':memory:', databaseType: 'memory' });

    // Empty state is UNKNOWN, not HEALTHY.
    assert.strictEqual((await service.getHealthSummary()).overall, 'UNKNOWN');

    await db.healthIncidents.save(incident('svc', 'ERROR', 'OPEN'));
    await db.healthObservations.save(obs('so'));
    assert.strictEqual((await service.getHealthSummary()).overall, 'UNHEALTHY');
    assert.strictEqual((await service.listHealthIncidents({ status: 'active' })).length, 1);
    assert.ok(await service.getHealthIncident('svc'));
    assert.strictEqual((await service.acknowledgeHealthIncident('svc')).success, true);
    // Acknowledgement does not resolve.
    assert.strictEqual((await service.listHealthIncidents({ status: 'active' })).length, 1);
  });

  it('health API reads never mutate operational state', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const service = new RelayApiService(db, engine, { isElectron: false, databasePath: ':memory:', databaseType: 'memory' });
    await db.healthIncidents.save(incident('ro2', 'ERROR', 'OPEN'));
    await service.getHealthSummary();
    await service.listHealthIncidents({ status: 'active' });
    await service.listHealthIncidents({ status: 'history' });
    await service.getHealthIncident('ro2');
    assert.deepStrictEqual(await db.pairs.findAll(), []);
    assert.deepStrictEqual(await db.runtimes.findAll(), []);
    assert.deepStrictEqual(await db.assignments.findAll(), []);
  });
});
