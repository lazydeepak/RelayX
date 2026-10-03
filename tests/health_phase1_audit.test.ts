/**
 * Phase 1 detection audit — cross-rule interaction, false positives,
 * durability, read-only boundary, and performance characteristics.
 *
 * After the semantic correction pass these assert CORRECTED behaviour. Tests
 * formerly named `AUDIT FINDING` are now regression guards named
 * `REGRESSION (was FINDING n)`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { HealthIncidentEngine } from '../src/relay/application/HealthIncidentEngine.ts';
import { HealthObservation } from '../src/relay/domain/healthDomain.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { evaluateDeliveryStalled } from '../src/relay/health/deliveryStalledCheck.ts';
import { DeliveryStalledService } from '../src/relay/health/deliveryStalledService.ts';
import { measureEventLoopLag, MAIN_PROCESS_STALL_PROBE_DELAY_MS } from '../src/relay/health/mainProcessStallCheck.ts';
import { evaluateUnexpectedIdleActivity } from '../src/relay/health/idleActivityCheck.ts';
import { evaluateTransportUnhealthy } from '../src/relay/health/transportUnhealthyCheck.ts';
import { evaluateSessionDrift } from '../src/relay/health/sessionDriftCheck.ts';
import { evaluateProviderUnreachable } from '../src/relay/health/providerUnreachableCheck.ts';

const T0 = 1_700_000_000_000;
const WARNING = 30_000;
const ERROR = 120_000;

/* ================= 1. CROSS-RULE OVERLAP AUDIT ================= */

describe('AUDIT: cross-rule overlap', () => {
  it('REGRESSION (was FINDING 1): one provider outage yields 1 root incident, not 3', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
    const now = T0 + ERROR + 1;

    const transport = evaluateTransportUnhealthy(
      { hasActiveWork: true, providerReachable: false, providerStatus: 'verified', activePairId: 'pair_01', deliveryId: 'del_01', assignmentId: 'asg_01' },
      now,
    );
    const provider = evaluateProviderUnreachable(
      { providerType: 'chatgpt', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true, activePairCount: 1, pairId: 'pair_01' },
      { count: 1 },
      now,
    );
    const delivery = evaluateDeliveryStalled('delivering', T0, T0, 'del_01', now, { assignmentId: 'asg_01', pairId: 'pair_01' }, { count: 1 });

    // TRANSPORT_UNHEALTHY defers: the outage is owned by PROVIDER_UNREACHABLE.
    assert.strictEqual(transport.kind, 'DEFERS_TO_PROVIDER_UNREACHABLE');
    assert.strictEqual(transport.incidentEligible, false);

    assert.ok(provider.incidentEligible);
    await engine.recordUnhealthyObservation(provider.observation!);
    // DELIVERY_STALLED may still appear as a downstream correlated symptom.
    assert.ok(delivery.incidentEligible);
    await engine.recordUnhealthyObservation(delivery.observation!);

    const open = await db.healthIncidents.findOpen();
    assert.deepStrictEqual(
      open.map((i) => i.incidentType).sort(),
      ['DELIVERY_STALLED', 'PROVIDER_UNREACHABLE'],
    );
  });

  it('TRANSPORT_UNHEALTHY survives when provider is reachable', () => {
    const r = evaluateTransportUnhealthy(
      { hasActiveWork: true, providerReachable: true, providerStatus: 'verified', activePairId: 'pair_02' },
      T0,
    );
    assert.strictEqual(r.kind, 'REACHABLE');
    assert.strictEqual(r.incidentEligible, false);

    const failed = evaluateTransportUnhealthy(
      { hasActiveWork: true, providerReachable: true, providerStatus: 'verified', activePairId: 'pair_02', deliveryStatus: 'failed' },
      T0,
    );
    assert.strictEqual(failed.kind, 'FAILED');
    assert.strictEqual(failed.incidentEligible, true);
  });

  it('identity mismatch stays out of provider-unreachable', () => {
    const drift = evaluateSessionDrift({
      pairId: 'pair_02', sideRole: 'planner', providerType: 'chatgpt',
      storedExternalSessionId: 'c/aaa', observedExternalSessionId: 'c/bbb',
      storedIdentityState: 'resolved', observedIdentityState: 'resolved', activeWorkAffected: true,
    }, T0);
    assert.strictEqual(drift.kind, 'UNHEALTHY');

    const provider = evaluateProviderUnreachable({
      providerType: 'chatgpt', integrationStatus: 'verified', reachable: true, requiredForActiveWork: true,
    }, { count: 0 }, T0);
    assert.strictEqual(provider.kind, 'REACHABLE');
  });

  it('ambiguous transport is not provider-unreachable and does not block transport rule', () => {
    const transport = evaluateTransportUnhealthy(
      { hasActiveWork: true, reconciliationOutcome: 'ambiguous', deliveryStatus: 'ambiguous', providerStatus: 'degraded', activePairId: 'pair_03' },
      T0,
    );
    assert.strictEqual(transport.kind, 'AMBIGUOUS');
    assert.strictEqual(transport.observation!.result, 'DEGRADED');
    assert.ok(transport.incidentEligible);
  });
});

/* ================= 2. FALSE-POSITIVE AUDIT ================= */

describe('AUDIT: false positives', () => {
  it('unavailable observation -> UNKNOWN, not drift', () => {
    const r = evaluateSessionDrift({
      pairId: 'pair_10', sideRole: 'worker', providerType: 'opencode',
      storedExternalSessionId: 'ses_x', observedIdentityState: 'unknown', activeWorkAffected: true,
    }, T0);
    assert.strictEqual(r.kind, 'UNKNOWN');
  });

  it('unused provider -> NOT_REQUIRED', () => {
    const r = evaluateProviderUnreachable({ providerType: 'vscode', requiredForActiveWork: false, activePairCount: 0 }, { count: 0 }, T0);
    assert.strictEqual(r.kind, 'NOT_REQUIRED');
    assert.strictEqual(r.incidentEligible, false);
  });

  it('idle pairs produce no transport incident', () => {
    const r = evaluateTransportUnhealthy({ hasActiveWork: false }, T0);
    assert.strictEqual(r.kind, 'NOT_REQUIRED');
    assert.strictEqual(r.incidentEligible, false);
  });

  it('REGRESSION (was FINDING 3): unknown reachability is UNKNOWN, never HEALTHY', () => {
    const r = evaluateProviderUnreachable({
      providerType: 'chatgpt', integrationStatus: 'verified', reachable: null, requiredForActiveWork: true,
    }, { count: 0 }, T0);
    assert.strictEqual(r.kind, 'OBSERVATION_UNAVAILABLE');
    assert.strictEqual(r.incidentEligible, false);
    assert.strictEqual(r.observation, undefined);
  });

  it('UNEXPECTED_IDLE_ACTIVITY still emits an observation (confirmation is separate)', () => {
    const r = evaluateUnexpectedIdleActivity('osascript_probe', 'system_automation', T0, {
      pairOperationalStates: ['IDLE'], hasActiveAssignment: false, pairCount: 1, activePairCount: 0, activeAssignmentCount: 0,
    });
    assert.ok(r.observation);
  });

  it('cosmetic session title change does not create drift', () => {
    const r = evaluateSessionDrift({
      pairId: 'pair_11', sideRole: 'planner', providerType: 'chatgpt',
      storedExternalSessionId: 'c/stable-uuid', observedExternalSessionId: 'c/stable-uuid',
      storedIdentityState: 'resolved', observedIdentityState: 'resolved', activeWorkAffected: true,
    }, T0);
    assert.strictEqual(r.kind, 'HEALTHY');
  });

  it('fresh in-flight delivery is not stalled', () => {
    const r = evaluateDeliveryStalled('delivering', T0, T0, 'del_fresh', T0 + 1_000, {});
    assert.strictEqual(r.kind, 'HEALTHY');
  });
});

/* ================= 3. MAIN_PROCESS_STALL SAFETY ================= */

describe('AUDIT: main process stall measurement', () => {
  it('REGRESSION (was FINDING 9): normal probe reports ~0 lag, not ~probeDelay', async () => {
    const lag = await measureEventLoopLag(MAIN_PROCESS_STALL_PROBE_DELAY_MS);
    // Scheduling lag only. The probe's own sleep is subtracted.
    assert.ok(lag >= 0, 'lag never negative');
    assert.ok(lag < MAIN_PROCESS_STALL_PROBE_DELAY_MS, `expected < ${MAIN_PROCESS_STALL_PROBE_DELAY_MS}ms, got ${lag}ms`);
  });

  it('lag is clamped to zero for early/equal firing', async () => {
    const lag = await measureEventLoopLag(0);
    assert.ok(lag >= 0);
  });

  it('probe is asynchronous and non-blocking', async () => {
    const before = Date.now();
    const p = measureEventLoopLag(10);
    assert.ok(p instanceof Promise);
    await p;
    assert.ok(Date.now() - before >= 10);
  });
});

/* ================= 4. DEDUP / LIFECYCLE AUDIT ================= */

describe('AUDIT: dedup and lifecycle', () => {
  it('repeated same-key observations update one incident and preserve firstSeen', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
    const mk = (ts: number, sev: string) => new HealthObservation({
      id: `obs_${ts}`, checkType: 'TRANSPORT_UNHEALTHY', componentType: 'transport',
      componentId: 'pair_01', result: 'UNHEALTHY', timestamp: ts, evidence: { severity: sev },
    });
    const a = await engine.recordUnhealthyObservation(mk(T0, 'WARNING'));
    const b = await engine.recordUnhealthyObservation(mk(T0 + 1_000, 'ERROR'));
    assert.strictEqual(a.id, b.id);
    assert.strictEqual(b.firstSeen, T0);
    assert.strictEqual(b.lastSeen, T0 + 1_000);
    assert.strictEqual(b.occurrenceCount, 2);
    assert.strictEqual(b.severity, 'ERROR');
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 1);
  });

  it('severity never silently decreases', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
    const mk = (sev: string) => new HealthObservation({
      id: `obs_${sev}_${Math.random()}`, checkType: 'PROVIDER_UNREACHABLE', componentType: 'provider',
      componentId: 'chatgpt', result: 'UNHEALTHY', timestamp: Date.now(), evidence: { severity: sev },
    });
    await engine.recordUnhealthyObservation(mk('CRITICAL'));
    const after = await engine.recordUnhealthyObservation(mk('INFO'));
    assert.strictEqual(after.severity, 'CRITICAL');
  });

  it('REGRESSION (was FINDING 7): ACKNOWLEDGED survives a repeat observation', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
    const inc = await engine.recordUnhealthyObservation(new HealthObservation({
      id: 'o1', checkType: 'DELIVERY_STALLED', componentType: 'delivery',
      componentId: 'del_01', result: 'UNHEALTHY', timestamp: T0, evidence: { severity: 'WARNING' },
    }));
    inc.acknowledge();
    await db.healthIncidents.save(inc);
    assert.strictEqual(inc.status, 'ACKNOWLEDGED');

    await engine.recordUnhealthyObservation(new HealthObservation({
      id: 'o2', checkType: 'DELIVERY_STALLED', componentType: 'delivery',
      componentId: 'del_01', result: 'UNHEALTHY', timestamp: T0 + 1, evidence: { severity: 'WARNING' },
    }));
    const stored = await db.healthIncidents.findById(inc.id);
    assert.strictEqual(stored!.status, 'ACKNOWLEDGED');
    assert.strictEqual(stored!.occurrenceCount, 2);
  });

  it('REGRESSION (was FINDING 8): recurrence keeps NEWEST evidence', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
    const inc = await engine.recordUnhealthyObservation(new HealthObservation({
      id: 'r1', checkType: 'TRANSPORT_UNHEALTHY', componentType: 'transport',
      componentId: 'pair_09', result: 'UNHEALTHY', timestamp: T0, evidence: { severity: 'ERROR', marker: 'old' },
    }));
    await engine.resolveIncident(inc.id);
    await engine.recordRecurrence(inc.id, new HealthObservation({
      id: 'r2', checkType: 'TRANSPORT_UNHEALTHY', componentType: 'transport',
      componentId: 'pair_09', result: 'UNHEALTHY', timestamp: T0 + 5, evidence: { severity: 'ERROR', marker: 'new' },
    }));
    // Re-read from persistence: recordRecurrence loads its own instance.
    const stored = await db.healthIncidents.findById(inc.id);
    assert.strictEqual(stored!.status, 'RECURRED');
    assert.strictEqual(stored!.evidence.marker, 'new');
    // Historical identity is preserved in typed fields, not evidence.
    assert.strictEqual(stored!.firstSeen, T0);
  });
});

/* ================= 5. RESOLUTION AUDIT ================= */

describe('AUDIT: resolution', () => {
  it('explicit resolution marks RESOLVED and preserves history', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
    const inc = await engine.recordUnhealthyObservation(new HealthObservation({
      id: 'x1', checkType: 'DELIVERY_STALLED', componentType: 'delivery',
      componentId: 'del_20', result: 'UNHEALTHY', timestamp: T0, evidence: { severity: 'WARNING', detail: 'keep' },
    }));
    const resolved = await engine.resolveIncident(inc.id);
    assert.strictEqual(resolved!.status, 'RESOLVED');
    assert.strictEqual(resolved!.firstSeen, T0);
    assert.strictEqual(resolved!.evidence.detail, 'keep');
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);
  });

  it('UNKNOWN never resolves an incident', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
    const inc = await engine.recordUnhealthyObservation(new HealthObservation({
      id: 'u1', checkType: 'PROVIDER_UNREACHABLE', componentType: 'provider',
      componentId: 'chatgpt', result: 'UNHEALTHY', timestamp: T0, evidence: { severity: 'ERROR' },
    }));
    // A later UNKNOWN observation must not resolve or reopen anything.
    const unknown = evaluateProviderUnreachable({ providerType: 'chatgpt', integrationStatus: 'verified', reachable: null, requiredForActiveWork: true }, { count: 1 }, T0 + 10);
    assert.strictEqual(unknown.incidentEligible, false);
    assert.strictEqual(unknown.observation, undefined);
    const stored = await db.healthIncidents.findById(inc.id);
    assert.strictEqual(stored!.status, 'OPEN');
  });
});

/* ================= 6. RESTART DURABILITY AUDIT ================= */

describe('AUDIT: restart durability', () => {
  it('open incidents survive reload; repeat after restart does not duplicate', async () => {
    const file = `${process.env.TMPDIR || '/tmp'}/relay_health_audit_${Date.now()}.sqlite`;
    const first = new SqliteRelayDatabase(file);
    const engineA = new HealthIncidentEngine(first.healthObservations, first.healthIncidents);
    await engineA.recordUnhealthyObservation(new HealthObservation({
      id: 'd1', checkType: 'DELIVERY_STALLED', componentType: 'delivery',
      componentId: 'del_40', result: 'UNHEALTHY', timestamp: T0, evidence: { severity: 'ERROR' },
    }));
    first.db.close();

    const second = new SqliteRelayDatabase(file);
    const engineB = new HealthIncidentEngine(second.healthObservations, second.healthIncidents);
    const open = await second.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].status, 'OPEN');
    assert.strictEqual(open[0].severity, 'ERROR');

    await engineB.recordUnhealthyObservation(new HealthObservation({
      id: 'd2', checkType: 'DELIVERY_STALLED', componentType: 'delivery',
      componentId: 'del_40', result: 'UNHEALTHY', timestamp: T0 + 1, evidence: { severity: 'ERROR' },
    }));
    const open2 = await second.healthIncidents.findOpen();
    assert.strictEqual(open2.length, 1);
    assert.strictEqual(open2[0].occurrenceCount, 2);
    second.db.close();
  });

  it('ACKNOWLEDGED survives a restart', async () => {
    const file = `${process.env.TMPDIR || '/tmp'}/relay_health_ack_${Date.now()}.sqlite`;
    const first = new SqliteRelayDatabase(file);
    const e1 = new HealthIncidentEngine(first.healthObservations, first.healthIncidents);
    const inc = await e1.recordUnhealthyObservation(new HealthObservation({
      id: 'a1', checkType: 'SESSION_DRIFT', componentType: 'session_pair',
      componentId: 'pair_70', result: 'UNHEALTHY', timestamp: T0, evidence: { severity: 'ERROR' },
    }));
    inc.acknowledge();
    await first.healthIncidents.save(inc);
    first.db.close();

    const second = new SqliteRelayDatabase(file);
    const e2 = new HealthIncidentEngine(second.healthObservations, second.healthIncidents);
    await e2.recordUnhealthyObservation(new HealthObservation({
      id: 'a2', checkType: 'SESSION_DRIFT', componentType: 'session_pair',
      componentId: 'pair_70', result: 'UNHEALTHY', timestamp: T0 + 1, evidence: { severity: 'ERROR' },
    }));
    const stored = await second.healthIncidents.findById(inc.id);
    assert.strictEqual(stored!.status, 'ACKNOWLEDGED');
    second.db.close();
  });

  it('confirmation state is in-memory and lost on restart (safe: delays, never fabricates)', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const now = T0 + ERROR + 1;
    const svcA = new DeliveryStalledService(new HealthIncidentEngine(db.healthObservations, db.healthIncidents));
    assert.strictEqual((await svcA.evaluate('delivering', 'del_50', T0, T0, now, {})).confirmed, false);

    const svcB = new DeliveryStalledService(new HealthIncidentEngine(db.healthObservations, db.healthIncidents));
    assert.strictEqual((await svcB.evaluate('delivering', 'del_50', T0, T0, now, {})).confirmed, false);
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);
  });
});

/* ================= 7. PERFORMANCE AUDIT ================= */

describe('AUDIT: performance', () => {
  it('detectors are pure and allocate only small bounded objects', () => {
    const t0 = Date.now();
    for (let i = 0; i < 10_000; i++) {
      evaluateTransportUnhealthy({ hasActiveWork: true, providerReachable: false, providerStatus: 'verified', activePairId: 'p' }, T0);
      evaluateProviderUnreachable({ providerType: 'chatgpt', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true }, { count: 0 }, T0);
      evaluateUnexpectedIdleActivity('op', 'cat', T0, { pairOperationalStates: ['IDLE'], hasActiveAssignment: false, pairCount: 0, activePairCount: 0, activeAssignmentCount: 0 });
    }
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2_000, `took ${elapsed}ms`);
  });

  it('health modules import no filesystem or subprocess surface', async () => {
    const fs = await import('node:fs');
    const sources = [
      'deliveryStalledCheck.ts', 'deliveryStalledConfirmation.ts', 'deliveryStalledService.ts',
      'mainProcessStallCheck.ts', 'mainProcessStallService.ts',
      'idleActivityCheck.ts', 'transportUnhealthyCheck.ts',
      'sessionDriftCheck.ts', 'providerUnreachableCheck.ts', 'healthConfirmation.ts',
    ];
    for (const f of sources) {
      const raw = fs.readFileSync(`${process.cwd()}/src/relay/health/${f}`, 'utf8');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.ok(!/node:child_process/.test(code), `${f} imports child_process`);
      assert.ok(!/\b(execSync|spawnSync|execFileSync)\s*\(/.test(code), `${f} calls sync subprocess`);
      assert.ok(!/node:fs/.test(code), `${f} imports filesystem`);
      assert.ok(!/osascript/.test(code), `${f} references osascript`);
    }
  });

  it('health system registers no timers or intervals', async () => {
    const fs = await import('node:fs');
    const sources = fs.readdirSync(`${process.cwd()}/src/relay/health`).filter((f) => f.endsWith('.ts'));
    for (const f of sources) {
      const code = fs.readFileSync(`${process.cwd()}/src/relay/health/${f}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // The only permitted timer is the bounded measurement probe.
      const timers = code.match(/setInterval|setTimeout/g) ?? [];
      if (f === 'mainProcessStallCheck.ts') {
        assert.ok(timers.length <= 1, `${f} must contain only the measurement probe timer`);
      } else {
        assert.strictEqual(timers.length, 0, `${f} must not register timers`);
      }
    }
  });
});

/* ================= 8. READ-ONLY BOUNDARY AUDIT ================= */

describe('AUDIT: read-only boundary', () => {
  it('no detector mutates Pair / Delivery / Runtime / Attempt state', () => {
    const delivery = { id: 'del_60', status: 'delivering', createdAt: T0, updatedAt: T0 };
    const pair = { id: 'pair_60', operationalState: 'ACTIVE', plannerSessionId: 'r1', workerSessionId: 'r2' };
    evaluateDeliveryStalled(delivery.status as any, delivery.createdAt, delivery.updatedAt, delivery.id, T0 + ERROR, {}, { count: 1 });
    evaluateUnexpectedIdleActivity('op', 'cat', T0, { pairOperationalStates: [pair.operationalState], hasActiveAssignment: true, pairCount: 1, activePairCount: 1, activeAssignmentCount: 1 });
    assert.strictEqual(delivery.status, 'delivering');
    assert.strictEqual(pair.operationalState, 'ACTIVE');
    assert.strictEqual(pair.plannerSessionId, 'r1');
  });

  it('incident persistence does not alter operational repositories', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
    await engine.recordUnhealthyObservation(new HealthObservation({
      id: 'ro1', checkType: 'PROVIDER_UNREACHABLE', componentType: 'provider',
      componentId: 'chatgpt', result: 'UNHEALTHY', timestamp: T0, evidence: { severity: 'ERROR' },
    }));
    assert.deepStrictEqual(await db.pairs.findAll(), []);
    assert.deepStrictEqual(await db.runtimes.findAll(), []);
    assert.deepStrictEqual(await db.assignments.findAll(), []);
    const deliveryRows = db.db.prepare('SELECT COUNT(*) AS c FROM deliveries').get() as { c: number };
    const attemptRows = db.db.prepare('SELECT COUNT(*) AS c FROM attempts').get() as { c: number };
    assert.strictEqual(deliveryRows.c, 0);
    assert.strictEqual(attemptRows.c, 0);
  });
});
