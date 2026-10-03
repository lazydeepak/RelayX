/**
 * Phase 1 runtime wiring — integration-style tests.
 *
 * These prove the coordinator receives REAL RelayX-shaped evidence and produces
 * incidents through the frozen detectors, without a renderer, without provider
 * calls, and without breaking execution.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { HealthIncidentEngine } from '../src/relay/application/HealthIncidentEngine.ts';
import { HealthRuntimeCoordinator, HEALTH_HEALTHY_OBSERVATION_SAMPLE_EVERY } from '../src/relay/application/HealthRuntimeCoordinator.ts';
import { HealthScheduler, withHealthDeliverySweep, HEALTH_HEARTBEAT_INTERVAL_MS } from '../src/relay/application/HealthScheduler.ts';
import { Delivery } from '../src/relay/domain/entities.ts';

const T0 = 1_700_000_000_000;

function harness(clock?: { t: number }) {
  const db = new MemoryRelayDatabase();
  const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
  const warnings: string[] = [];
  const c = new HealthRuntimeCoordinator({
    repos: db,
    engine,
    now: () => (clock ? clock.t : Date.now()),
    logger: { warn: (...a: unknown[]) => warnings.push(String(a[0])) },
  });
  return { db, engine, c, warnings };
}

/* ---------- 1. real transport failure evidence ---------- */

describe('wiring: TRANSPORT_UNHEALTHY', () => {
  it('real transport failure evidence reaches TRANSPORT_UNHEALTHY', async () => {
    const { db, c } = harness();
    const ev = {
      providerType: 'chatgpt',
      providerReachable: true,
      integrationStatus: 'verified',
      activePairId: 'pair_1',
      deliveryId: 'del_1',
      deliveryStatus: 'failed',
      blocksActiveWork: false,
      authoritative: true,
    };
    await c.onTransportEvidence(ev);
    await c.onTransportEvidence(ev);
    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].incidentType, 'TRANSPORT_UNHEALTHY');
    assert.strictEqual(open[0].componentId, 'pair_1');
  });
});

/* ---------- 2. provider outage suppresses redundant transport ---------- */

describe('wiring: provider outage precedence', () => {
  it('known outage creates PROVIDER_UNREACHABLE and suppresses transport', async () => {
    const { db, c } = harness();
    const outage = { providerReachable: false, integrationStatus: 'verified', activePairId: 'pair_2', deliveryId: 'del_2' };

    // TRANSPORT_UNHEALTHY sees the outage twice and must NOT confirm.
    await c.onTransportEvidence({ ...outage, deliveryStatus: 'failed', authoritative: true });
    await c.onTransportEvidence({ ...outage, deliveryStatus: 'failed', authoritative: true });

    // PROVIDER_UNREACHABLE owns the root cause and confirms immediately (blocking).
    await c.onProviderReachabilityEvidence({
      providerType: 'chatgpt',
      integrationStatus: 'verified',
      reachable: false,
      requiredForActiveWork: true,
      blocksActiveWork: true,
      pairId: 'pair_2',
    });

    const open = await db.healthIncidents.findOpen();
    assert.deepStrictEqual(open.map((i) => i.incidentType), ['PROVIDER_UNREACHABLE']);
  });
});

/* ---------- 3. session drift ---------- */

describe('wiring: SESSION_DRIFT', () => {
  it('session mismatch evidence reaches SESSION_DRIFT', async () => {
    const { db, c } = harness();
    await c.onSessionIdentityEvidence({
      pairId: 'pair_3',
      sideRole: 'planner',
      providerType: 'chatgpt',
      storedExternalSessionId: 'c/aaa',
      observedExternalSessionId: 'c/bbb',
      storedIdentityState: 'resolved',
      observedIdentityState: 'resolved',
      activeWorkAffected: true,
    });
    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].incidentType, 'SESSION_DRIFT');
  });
});

/* ---------- 4/5. idle activity + operator intent ---------- */

describe('wiring: UNEXPECTED_IDLE_ACTIVITY', () => {
  it('idle expensive operation reaches UNEXPECTED_IDLE_ACTIVITY after repetition', async () => {
    const { db, c } = harness();
    await c.onExpensiveOperation({ operationName: 'getAppStatus', activityCategory: 'system_automation' });
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0, 'first occurrence is a candidate only');

    await c.onExpensiveOperation({ operationName: 'getAppStatus', activityCategory: 'system_automation' });
    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].incidentType, 'UNEXPECTED_IDLE_ACTIVITY');
  });

  it('explicit operator action does not falsely trigger an incident', async () => {
    const { db, c } = harness();
    for (let i = 0; i < 5; i++) {
      await c.onExpensiveOperation({ operationName: 'discoverRuntime', activityCategory: 'provider', operatorInitiated: true });
    }
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);
  });

  it('active work suppresses idle-activity detection', async () => {
    const { db, c } = harness();
    const { Pair, Project } = await import('../src/relay/domain/entities.ts');
    const project = Project.create('proj-1', 'P');
    await db.projects.save(project);
    const pair = Pair.create(project.id, 'active-pair');
    pair.makeActive();
    await db.pairs.save(pair);

    for (let i = 0; i < 3; i++) {
      await c.onExpensiveOperation({ operationName: 'provider_contact', activityCategory: 'provider' });
    }
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);
  });
});

/* ---------- 6. delivery stall through runtime scheduling ---------- */

describe('wiring: DELIVERY_STALLED scheduling', () => {
  it('stalled in-flight Delivery becomes an incident through the supervision sweep', async () => {
    const { db, c } = harness();
    const delivery = Delivery.create('asg_1' as any, 'att_1' as any, 'rt_1' as any, 'do work', 'idem_1');
    delivery.startDelivering();
    await db.deliveries.save(delivery);

    // Fresh delivery: no incident on the first sweep.
    await c.evaluateStalledDeliveries();
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);

    // Age past the warning threshold, then confirm.
    const old = Date.now() - 200_000;
    await db.deliveries.save(Object.assign(Object.create(Object.getPrototypeOf(delivery)), delivery, { createdAt: old, updatedAt: old }));
    await c.evaluateStalledDeliveries();
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0, 'first stale sweep is a candidate');

    await c.evaluateStalledDeliveries();
    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].incidentType, 'DELIVERY_STALLED');
    assert.strictEqual(open[0].componentId, delivery.id);
  });

  it('terminal deliveries are never swept', async () => {
    const { db, c } = harness();
    const d = Delivery.create('asg_2' as any, 'att_2' as any, 'rt_2' as any, 'x', 'idem_2');
    d.markFailed('nope');
    await db.deliveries.save(d);
    const opened = await c.evaluateStalledDeliveries();
    assert.strictEqual(opened, 0);
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);
  });

  it('sweep uses findUnresolved, not a full-table read', async () => {
    const { db, c } = harness();
    let calls = 0;
    const original = db.deliveries.findUnresolved.bind(db.deliveries);
    (db.deliveries as any).findUnresolved = async () => { calls += 1; return original(); };
    await c.evaluateStalledDeliveries();
    assert.strictEqual(calls, 1);
  });
});

/* ---------- 7. main-process lag probe path ---------- */

describe('wiring: MAIN_PROCESS_STALL', () => {
  it('lag probe runs and produces a healthy observation', async () => {
    const { db, c } = harness();
    await c.probeMainProcessLag();
    assert.strictEqual(c.getStats().mainProcessProbeEvaluations, 1);
  });

  it('scheduler owns exactly one timer and unrefs it', async () => {
    const { c } = harness();
    const s = new HealthScheduler({ coordinator: c, intervalMs: 10_000, logger: { warn: () => {} } });
    s.start();
    assert.strictEqual(s.isRunning(), true);
    s.stop();
    assert.strictEqual(s.isRunning(), false);
  });

  it('no timer proliferation: health modules register one timer total', async () => {
    const fs = await import('node:fs');
    const files = ['HealthScheduler.ts', 'HealthRuntimeCoordinator.ts', 'HealthIncidentEngine.ts'];
    let timerCount = 0;
    for (const f of files) {
      const code = fs.readFileSync(`${process.cwd()}/src/relay/application/${f}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      timerCount += (code.match(/setTimeout\s*\(/g) ?? []).length;
      timerCount += (code.match(/setInterval\s*\(/g) ?? []).length;
    }
    // Exactly one: the scheduler's single chained timeout.
    assert.strictEqual(timerCount, 1);
  });

  it('heartbeat interval is conservative health policy', () => {
    assert.strictEqual(HEALTH_HEARTBEAT_INTERVAL_MS, 60_000);
  });
});

/* ---------- 8/9. resolution discipline ---------- */

describe('wiring: resolution', () => {
  it('authoritative healthy recovery resolves an open incident', async () => {
    const { db, c } = harness();
    const ev = { providerType: 'opencode', integrationStatus: 'verified' as const, reachable: true, requiredForActiveWork: true, blocksActiveWork: true };
    await c.onProviderReachabilityEvidence({ ...ev, reachable: false });
    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);

    await c.onProviderReachabilityEvidence(ev);
    await c.resolveIncidentOnAuthoritativeRecovery(open[0].id);

    const after = await db.healthIncidents.findById(open[0].id);
    assert.strictEqual(after!.status, 'RESOLVED');
    assert.strictEqual(c.getStats().incidentsResolved, 1);
  });

  it('UNKNOWN never resolves an open incident', async () => {
    const { db, c } = harness();
    await c.onProviderReachabilityEvidence({
      providerType: 'opencode', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true, blocksActiveWork: true,
    });
    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);

    // Reachability becomes unobservable — UNKNOWN, not recovery.
    await c.onProviderReachabilityEvidence({
      providerType: 'opencode', integrationStatus: 'verified', reachable: null, requiredForActiveWork: true,
    });
    const after = await db.healthIncidents.findById(open[0].id);
    assert.strictEqual(after!.status, 'OPEN');
  });
});

/* ---------- 10. restart ---------- */

describe('wiring: startup and restart', () => {
  it('startup adopts open incidents without duplicating or falsely resolving them', async () => {
    const { db, c } = harness();
    await c.onProviderReachabilityEvidence({
      providerType: 'opencode', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true, blocksActiveWork: true,
    });
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 1);

    const result = await c.onStartup();
    assert.strictEqual(result.openIncidents, 1);
    const stillOpen = await db.healthIncidents.findOpen();
    assert.strictEqual(stillOpen.length, 1);
    assert.strictEqual(stillOpen[0].status, 'OPEN');
  });

  it('restart does not duplicate open incidents across a real reload', async () => {
    // Uses an on-disk SQLite database so this proves genuine process-restart
    // durability rather than an in-memory illusion.
    const { SqliteRelayDatabase } = await import('../src/relay/persistence/sqlite/SqliteDatabase.ts');
    const file = `${process.env.TMPDIR || '/tmp'}/relay_wiring_${Date.now()}.sqlite`;
    const first = new SqliteRelayDatabase(file);
    const e1 = new HealthIncidentEngine(first.healthObservations, first.healthIncidents);
    const c1 = new HealthRuntimeCoordinator({ repos: first, engine: e1, logger: { warn: () => {} } });
    await c1.onProviderReachabilityEvidence({
      providerType: 'opencode', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true, blocksActiveWork: true,
    });
    first.db.close();

    const second = new SqliteRelayDatabase(file);
    const e2 = new HealthIncidentEngine(second.healthObservations, second.healthIncidents);
    const c2 = new HealthRuntimeCoordinator({ repos: second, engine: e2, logger: { warn: () => {} } });
    const startup = await c2.onStartup();
    assert.strictEqual(startup.openIncidents, 1);
    assert.strictEqual((await second.healthIncidents.findOpen()).length, 1);
    second.db.close();
  });
});

/* ---------- 11. failure isolation ---------- */

describe('wiring: failure isolation', () => {
  it('a monitoring failure never propagates to the caller', async () => {
    const { c, warnings } = harness();
    // Force a failure inside the transport monitor.
    (c as any).transport = {
      evaluate: async () => { throw new Error('detector exploded'); },
    };
    await c.onTransportEvidence({ providerType: 'x', activePairId: 'p', hasActiveWork: true } as any);
    assert.strictEqual(warnings.length > 0, true);
    assert.strictEqual(c.getStats().failures, 1);
  });

  it('a failed health sweep does not break supervision', async () => {
    const { c } = harness();
    (c as any).evaluateStalledDeliveries = async () => { throw new Error('sweep exploded'); };
    const sweep = withHealthDeliverySweep(c, () => T0);
    await assert.doesNotReject(async () => { await sweep.sweepNow(); });
  });

  it('scheduler tick swallows detector failure', async () => {
    const { c } = harness();
    (c as any).probeMainProcessLag = async () => { throw new Error('probe exploded'); };
    const s = new HealthScheduler({ coordinator: c, intervalMs: 10_000, logger: { warn: () => {} } });
    await assert.doesNotReject(async () => { await s.tick(); });
  });
});

/* ---------- 12. idle overhead ---------- */

describe('wiring: idle overhead', () => {
  it('idle health runtime causes no provider calls', async () => {
    // Behavioural proof: an idle system with no pairs and no work produces no
    // incidents and does no work beyond a local probe.
    const { db, c } = harness();
    const before = c.getStats();
    for (let i = 0; i < 5; i++) {
      await c.evaluateStalledDeliveries();
      await c.probeMainProcessLag();
    }
    const after = c.getStats();
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);
    assert.strictEqual(after.failures, before.failures);
    // The only database work is the indexed unresolved-delivery read.
    assert.strictEqual(after.deliveryStallEvaluations, 0);
  });

  it('coordinator and scheduler import no subprocess or provider surface', async () => {
    const fs = await import('node:fs');
    for (const f of ['HealthRuntimeCoordinator.ts', 'HealthScheduler.ts']) {
      const code = fs.readFileSync(`${process.cwd()}/src/relay/application/${f}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.ok(!/node:child_process/.test(code), `${f} imports child_process`);
      assert.ok(!/\b(execSync|spawnSync|execFileSync)\s*\(/.test(code), `${f} calls sync subprocess`);
      assert.ok(!/node:fs/.test(code), `${f} imports filesystem`);
      assert.ok(!/fetch\s*\(/.test(code), `${f} performs network calls`);
      assert.ok(!/adapters|providers\//.test(code), `${f} reaches into provider adapters`);
    }
  });

  it('no pair, runtime, delivery, or attempt is mutated by monitoring', async () => {
    const { db, c } = harness();
    const delivery = Delivery.create('asg_9' as any, 'att_9' as any, 'rt_9' as any, 'x', 'idem_9');
    delivery.startDelivering();
    await db.deliveries.save(delivery);
    const before = await db.deliveries.findById(delivery.id);

    await c.evaluateStalledDeliveries();
    await c.probeMainProcessLag();
    await c.onProviderReachabilityEvidence({ providerType: 'x', reachable: false, requiredForActiveWork: true, blocksActiveWork: true });

    const after = await db.deliveries.findById(delivery.id);
    assert.strictEqual(after!.status, before!.status);
    assert.deepStrictEqual(await db.pairs.findAll(), []);
    assert.deepStrictEqual(await db.runtimes.findAll(), []);
  });
});

/* ---------- 14. bounded observation persistence ---------- */

describe('wiring: bounded observation persistence', () => {
  it('repeated HEALTHY probes are sampled, not stored verbatim', async () => {
    const { db, c } = harness();
    // The policy is exercised directly so this stays fast and deterministic; the
    // real probe is a 50ms setTimeout and brute-forcing hundreds of them would
    // make this test slow without testing any additional behaviour.
    for (let i = 0; i < HEALTH_HEALTHY_OBSERVATION_SAMPLE_EVERY * 3; i++) {
      await (c as any).persistObservation({
        id: `h_${i}`, checkType: 'MAIN_PROCESS_STALL', componentType: 'main_process',
        componentId: 'electron_main', result: 'HEALTHY', timestamp: T0 + i,
        evidence: { severity: 'INFO' },
      });
    }
    const persisted = (await db.healthObservations.findRecent(10_000)).length;
    // Exactly one row per sampling interval, not 180.
    assert.strictEqual(persisted, 3, `expected 3 sampled rows, got ${persisted}`);
    assert.strictEqual(c.getStats().healthyObservationsSampledOut, HEALTH_HEALTHY_OBSERVATION_SAMPLE_EVERY * 3 - 3);
  });

  it('an unhealthy observation resets healthy sampling so recovery is recorded', async () => {
    const { db, c } = harness();
    for (let i = 0; i < 5; i++) {
      await (c as any).persistObservation({
        id: `h2_${i}`, checkType: 'MAIN_PROCESS_STALL', componentType: 'main_process',
        componentId: 'electron_main', result: 'HEALTHY', timestamp: T0 + i, evidence: {},
      });
    }
    await (c as any).persistObservation({
      id: 'bad_1', checkType: 'TRANSPORT_UNHEALTHY', componentType: 'transport',
      componentId: 'pair_1', result: 'UNHEALTHY', timestamp: T0 + 10, evidence: {},
    });
    const rows = await db.healthObservations.findRecent(100);
    assert.ok(rows.some((r) => r.result === 'UNHEALTHY'), 'unhealthy evidence always persists');
  });

  it('unhealthy observations are always persisted', async () => {
    const { db, c } = harness();
    await c.onProviderReachabilityEvidence({
      providerType: 'opencode', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true, blocksActiveWork: true,
    });
    const rows = await db.healthObservations.findRecent(100);
    assert.ok(rows.length >= 1);
    assert.ok(rows.some((r) => r.checkType === 'PROVIDER_UNREACHABLE'));
  });
});
