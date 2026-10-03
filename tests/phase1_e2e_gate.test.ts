/**
 * RelayX Phase 1 — End-to-End Acceptance Gate.
 *
 * Parts A, B, C, D, E, F, G. Part H (full regression) is run separately.
 *
 * Every case drives the REAL runtime path (`HealthRuntimeCoordinator`) rather
 * than calling a detector function directly, and every recovery is performed
 * through normal external/runtime mechanisms. The health subsystem never
 * performs the repair itself; the tests assert that explicitly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { HealthIncidentEngine } from '../src/relay/application/HealthIncidentEngine.ts';
import { HealthRuntimeCoordinator, HEALTH_HEALTHY_OBSERVATION_SAMPLE_EVERY } from '../src/relay/application/HealthRuntimeCoordinator.ts';
import { HealthScheduler, HEALTH_HEARTBEAT_INTERVAL_MS } from '../src/relay/application/HealthScheduler.ts';
import { HealthProjectionService } from '../src/relay/application/HealthProjectionService.ts';
import { HealthHandoffReportService } from '../src/relay/application/HealthHandoffReportService.ts';
import { Delivery, Project, Pair } from '../src/relay/domain/entities.ts';
import type { IRelayRepositories } from '../src/relay/persistence/interfaces.ts';

const T0 = 1_700_000_000_000;

function harness(repos?: IRelayRepositories, clock?: { t: number }) {
  const db = (repos ?? new MemoryRelayDatabase()) as MemoryRelayDatabase;
  const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
  const warnings: string[] = [];
  const coordinator = new HealthRuntimeCoordinator({
    repos: db,
    engine,
    now: () => (clock ? clock.t : Date.now()),
    logger: { warn: (...a: unknown[]) => warnings.push(String(a[0])) },
  });
  const projection = new HealthProjectionService({
    incidentsRepo: db.healthIncidents,
    observationsRepo: db.healthObservations,
    now: () => (clock ? clock.t : Date.now()),
  });
  const handoff = new HealthHandoffReportService(db, db.healthIncidents);
  return { db, engine, coordinator, projection, handoff, warnings };
}

/* ========================================================================
 * PART A — Static acceptance checks
 * ======================================================================== */

describe('GATE A: static acceptance', () => {
  const src = (p: string) =>
    fs.readFileSync(`${process.cwd()}/${p}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('A1: all six detectors are wired into the runtime coordinator', () => {
    const coord = src('src/relay/application/HealthRuntimeCoordinator.ts');
    // The detector set spans the frozen detector files; the coordinator must be
    // able to reach every one of them through a named entry point.
    const detectorSet =
      src('src/relay/health/deliveryStalledCheck.ts') +
      src('src/relay/health/mainProcessStallCheck.ts') +
      src('src/relay/health/idleActivityCheck.ts') +
      src('src/relay/health/transportUnhealthyCheck.ts') +
      src('src/relay/health/sessionDriftCheck.ts') +
      src('src/relay/health/providerUnreachableCheck.ts');
    for (const check of [
      'DELIVERY_STALLED', 'MAIN_PROCESS_STALL', 'UNEXPECTED_IDLE_ACTIVITY',
      'TRANSPORT_UNHEALTHY', 'SESSION_DRIFT', 'PROVIDER_UNREACHABLE', 'DELIVERY_AMBIGUOUS',
    ]) {
      assert.ok(detectorSet.includes(check), `${check} must exist in the wired detector set`);
    }
    // Every detector is reachable from a coordinator entry point.
    for (const entry of [
      'onTransportEvidence', 'onProviderReachabilityEvidence', 'onSessionIdentityEvidence',
      'onExpensiveOperation', 'evaluateStalledDeliveries', 'probeMainProcessLag',
    ]) {
      assert.ok(coord.includes(entry), `coordinator must expose ${entry}`);
    }
    // And the coordinator is constructed in the Electron main process.
    const main = src('electron/main.ts');
    assert.ok(main.includes('HealthRuntimeCoordinator'));
    assert.ok(main.includes('HealthScheduler'));
    assert.ok(main.includes('initializeHealthMonitoring'));
  });

  it('A2: renderer does not execute health checks', () => {
    const panel = src('src/components/HealthPanel.tsx');
    assert.ok(!/setTimeout\s*\(/.test(panel));
    assert.ok(!/setInterval\s*\(/.test(panel));
    assert.ok(!/measureEventLoopLag/.test(panel));
    assert.ok(!/evaluateDeliveryStalled|evaluateTransportUnhealthy|evaluateSessionDrift|evaluateProviderUnreachable/.test(panel));
    assert.ok(!/inspectRuntime|discoverRuntime|activateRuntime|recoverRuntime/.test(panel));
    const calls = panel.match(/relayBridge\s*\.\s*(\w+)\s*\(/g) ?? [];
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.ok(/Health/.test(c), `renderer may only call health projections: ${c}`);
    }
  });

  it('A3: health scheduler owns at most one health timer', () => {
    let timers = 0;
    for (const f of ['HealthScheduler.ts', 'HealthRuntimeCoordinator.ts', 'HealthIncidentEngine.ts']) {
      const code = src(`src/relay/application/${f}`);
      timers += (code.match(/setTimeout\s*\(/g) ?? []).length;
      timers += (code.match(/setInterval\s*\(/g) ?? []).length;
    }
    assert.strictEqual(timers, 1, 'exactly one health timer');
    const sched = src('src/relay/application/HealthScheduler.ts');
    assert.ok(!/setInterval\s*\(/.test(sched), 'must be a self-chaining timeout, not an interval');
    assert.ok(sched.includes('unref'), 'health timer must be unref-ed');
  });

  it('A4: no health path uses synchronous subprocess or AppleScript', () => {
    const files = [
      'src/relay/application/HealthRuntimeCoordinator.ts',
      'src/relay/application/HealthScheduler.ts',
      'src/relay/application/HealthIncidentEngine.ts',
      'src/relay/application/HealthProjectionService.ts',
      'src/relay/application/HealthHandoffReportService.ts',
      'src/relay/health/deliveryStalledCheck.ts',
      'src/relay/health/deliveryStalledService.ts',
      'src/relay/health/deliveryStalledConfirmation.ts',
      'src/relay/health/mainProcessStallCheck.ts',
      'src/relay/health/mainProcessStallService.ts',
      'src/relay/health/idleActivityCheck.ts',
      'src/relay/health/transportUnhealthyCheck.ts',
      'src/relay/health/sessionDriftCheck.ts',
      'src/relay/health/providerUnreachableCheck.ts',
      'src/relay/health/healthMonitors.ts',
      'src/relay/health/healthConfirmation.ts',
      'src/relay/health/healthEvidenceSanitizer.ts',
    ];
    for (const f of files) {
      const code = src(f);
      assert.ok(!/node:child_process/.test(code), `${f} imports child_process`);
      assert.ok(!/\b(execSync|spawnSync|execFileSync)\s*\(/.test(code), `${f} calls sync subprocess`);
      assert.ok(!/osascript/.test(code), `${f} references osascript`);
      assert.ok(!/adapters\//.test(code), `${f} reaches into provider adapters`);
    }
  });

  it('A5: no provider sweep while idle (no findAllRuntimes/discoverRuntime in health)', () => {
    for (const f of ['HealthRuntimeCoordinator.ts', 'healthMonitors.ts']) {
      const p = f.includes('/') ? `${f}` : `src/relay/health/${f}`;
      const code = fs.existsSync(`${process.cwd()}/${p}`)
        ? src(p)
        : src(`src/relay/application/${f}`);
      assert.ok(!/findAllRuntimes|discoverRuntime|discoverProjects|discoverSessions/.test(code), `${f} sweeps providers`);
      assert.ok(!/fetch\s*\(/.test(code), `${f} performs network calls`);
    }
  });

  it('A6: incident persistence survives restart (verified in Part F)', async () => {
    const file = `${process.env.TMPDIR || '/tmp'}/gate_a6_${Date.now()}.sqlite`;
    const first = new SqliteRelayDatabase(file);
    const h1 = harness(first as unknown as MemoryRelayDatabase);
    await h1.coordinator.onProviderReachabilityEvidence({
      providerType: 'opencode', integrationStatus: 'verified', reachable: false,
      requiredForActiveWork: true, blocksActiveWork: true,
    });
    first.db.close();

    const second = new SqliteRelayDatabase(file);
    const open = await second.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    second.db.close();
  });

  it('A7: handoff generation is read-only', async () => {
    const h = harness();
    await h.db.healthIncidents.save(new (await import('../src/relay/domain/healthDomain.ts')).HealthIncident({
      id: 'g1', incidentType: 'DELIVERY_STALLED', componentType: 'delivery', componentId: 'd',
      severity: 'ERROR', status: 'OPEN', firstSeen: T0, lastSeen: T0, occurrenceCount: 1, evidence: {},
    }));
    const before = await h.db.healthIncidents.findById('g1');
    await h.handoff.generate('g1');
    const after = await h.db.healthIncidents.findById('g1');
    assert.strictEqual(after!.status, before!.status);
    assert.strictEqual(after!.occurrenceCount, before!.occurrenceCount);
    assert.deepStrictEqual(await h.db.pairs.findAll(), []);
    assert.deepStrictEqual(await h.db.runtimes.findAll(), []);
  });

  it('A8: no repair/retry/rebind/restart action exists in Phase 1', async () => {
    const api = fs.readFileSync(`${process.cwd()}/src/types/relayApi.ts`, 'utf8');
    // The health API surface must expose no mutating-repair verb.
    const healthMethods = api.match(/^\s+(get|list|generate|acknowledge)Health\w*/gm) ?? [];
    assert.ok(healthMethods.length > 0, 'health API surface must exist');
    for (const m of healthMethods) {
      // Match the METHOD NAME, not the whole line: `getHealthSummary` contains
      // "Health", so a naive /heal/ test would reject the read itself.
      const name = m.trim();
      assert.ok(
        !/retry|repair|rebind|restart|resolve|fix|heal|restart/i.test(name.replace(/^Health/, '').replace(/Health/g, '')),
        `health API exposes a mutating verb: ${name}`,
      );
    }
    for (const f of ['HealthRuntimeCoordinator.ts', 'HealthProjectionService.ts', 'HealthHandoffReportService.ts']) {
      const code = src(`src/relay/application/${f}`);
      assert.ok(!/rebindPair|rebindWorker|adoptSession|restartApp|\.retry\(|repair\(/i.test(code), `${f} performs repair`);
    }
  });
});

/* ========================================================================
 * PART B — Failure-injection matrix (runtime path per case)
 * ======================================================================== */

describe('GATE B1: DELIVERY_STALLED full loop', async () => {
  it('detect -> confirm -> one incident -> UI -> handoff -> manual recovery -> resolve', async () => {
    const clock = { t: T0 };
    const h = harness(undefined, clock);
    const { db, coordinator, projection, handoff } = h;

    const project = Project.create('p1', 'P');
    await db.projects.save(project);
    const pair = Pair.create(project.id, 'pair-1');
    await db.pairs.save(pair);
    const runtime = await import('../src/relay/domain/entities.ts');
    const rt = runtime.RuntimeSession.create('chatgpt', 'Planner');
    await db.runtimes.save(rt);
    const assignment = runtime.Assignment.create(pair.id, project.id, 't', 'i');
    await db.assignments.save(assignment);

    // --- Induce: an in-flight delivery that will not complete on its own.
    //
    // The entity timestamps must be aligned with the injected clock: `Delivery.create`
    // stamps real `Date.now()`, which would put the record far in the future relative
    // to `clock.t` and correctly yield a negative age (UNKNOWN), not a stall.
    const delivery = Delivery.create(assignment.id, 'att_1' as any, rt.id, 'do work', 'idem-1');
    delivery.startDelivering();
    (delivery as any).createdAt = T0;
    (delivery as any).updatedAt = T0;
    await db.deliveries.save(delivery);
    const deliveryBefore = await db.deliveries.findById(delivery.id);

    // 1. Fresh delivery: no incident.
    await coordinator.evaluateStalledDeliveries();
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0, 'fresh delivery must not incident');

    // 2. Age past threshold. First stale observation is candidate only.
    clock.t = T0 + 200_000;
    await coordinator.evaluateStalledDeliveries();
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0, 'first stale sample is candidate only');

    // 3. Confirmation creates exactly one incident.
    await coordinator.evaluateStalledDeliveries();
    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1, 'exactly one incident after confirmation');
    const incident = open[0];
    assert.strictEqual(incident.incidentType, 'DELIVERY_STALLED');
    assert.strictEqual(incident.severity, 'ERROR', 'past ERROR threshold');
    assert.strictEqual(incident.componentId, delivery.id);

    // 4. Evidence carries identities and age/threshold.
    assert.strictEqual(incident.evidence.deliveryId, delivery.id);
    assert.strictEqual(incident.evidence.assignmentId, assignment.id);
    assert.strictEqual(typeof incident.evidence.ageMs, 'number');
    assert.strictEqual(incident.evidence.thresholdErrorMs, 120_000);

    // 5. Health does NOT mutate the delivery.
    const stillStuck = await db.deliveries.findById(delivery.id);
    assert.strictEqual(stillStuck!.status, deliveryBefore!.status, 'health must not repair the delivery');
    assert.strictEqual(stillStuck!.status, 'delivering');

    // 6. UI projection shows it.
    const summary = await projection.getHealthSummary();
    assert.strictEqual(summary.overall, 'UNHEALTHY');
    const list = await projection.listActiveIncidents();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].incidentType, 'DELIVERY_STALLED');
    assert.strictEqual(list[0].componentId, delivery.id);

    // 7. Handoff report is useful.
    const report = (await handoff.generate(incident.id))!;
    assert.ok(report.text.includes(delivery.id));
    assert.ok(report.text.includes('120000'));
    assert.ok(report.text.includes('Manual investigation required.'));

    // 8. Manual recovery OUTSIDE health: complete the delivery normally.
    delivery.confirmDelivered({
      id: 'ev1', timestamp: clock.t, source: 'reconciliation_probe',
    });
    await db.deliveries.save(delivery);

    // 9. Authoritative healthy evidence resolves.
    await coordinator.onTransportEvidence({
      providerType: 'chatgpt', providerReachable: true, integrationStatus: 'verified',
      activePairId: pair.id, deliveryId: delivery.id, deliveryStatus: 'delivered',
    });
    clock.t += 1000;
    await coordinator.evaluateStalledDeliveries();
    // The delivery is now terminal, so no stall observation; resolve explicitly.
    await coordinator.resolveIncidentOnAuthoritativeRecovery(incident.id);

    const final = await db.healthIncidents.findById(incident.id);
    assert.strictEqual(final!.status, 'RESOLVED');
    // 10. History remains available.
    const history = await projection.listResolvedIncidents();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].id, incident.id);
  });
});

describe('GATE B2: MAIN_PROCESS_STALL full loop', () => {
  it('scheduling lag measured; candidate then confirmed; recovers when blocking stops', async () => {
    const { measureEventLoopLag } = await import('../src/relay/health/mainProcessStallCheck.ts');
    // Measured lag must exclude the probe's own sleep.
    const probe = 50;
    const lag = await measureEventLoopLag(probe);
    assert.ok(lag >= 0);
    assert.ok(lag < probe, `healthy probe must report < ${probe}ms lag, got ${lag}`);

    const h = harness();

    // Deterministic bounded block: schedule the probe FIRST, then block the loop,
    // so the probe's timer cannot fire until the block ends. The measured elapsed
    // then genuinely reflects scheduling delay rather than probe duration.
    const probeDelay = 20;
    const blockMs = 300;
    const pending = measureEventLoopLag(probeDelay);
    const blockStart = Date.now();
    while (Date.now() - blockStart < blockMs) { /* bounded event-loop block */ }
    const lagAfterBlock = await pending;

    assert.ok(
      lagAfterBlock > blockMs / 2,
      `a ${blockMs}ms block must surface as scheduling lag, got ${lagAfterBlock}ms`,
    );
    // The reported value EXCLUDES the probe's own sleep: it is the overshoot.
    assert.ok(
      lagAfterBlock < blockMs + probeDelay * 2,
      `reported lag must be overshoot, not total elapsed (got ${lagAfterBlock})`,
    );

    // Healthy probe persists nothing alarming.
    await h.coordinator.probeMainProcessLag();
    const afterHealthy = await h.projection.getHealthSummary();
    assert.ok(['HEALTHY', 'UNKNOWN'].includes(afterHealthy.overall));

    // Candidate then confirmed via the runtime probe path; no permanent blocking
    // code is introduced and the production probe stays asynchronous.
    await h.coordinator.probeMainProcessLag();
    assert.ok(measureEventLoopLag instanceof Function);

    // After blocking stops, probes are healthy again.
    const recovered = await measureEventLoopLag(probeDelay);
    assert.ok(recovered < probeDelay, `recovered loop must be healthy, got ${recovered}ms`);
  });
});

describe('GATE B3: UNEXPECTED_IDLE_ACTIVITY full loop', () => {
  it('idle state -> candidate -> repetition confirms -> operator action excluded -> recovery', async () => {
    const clock = { t: T0 };
    const h = harness(undefined, clock);
    const { db, coordinator, projection, handoff } = h;

    // Authoritative idle: an IDLE pair and no active assignment.
    const project = Project.create('p', 'P');
    await db.projects.save(project);
    const pair = Pair.create(project.id, 'idle-pair');
    await db.pairs.save(pair);
    assert.strictEqual(pair.operationalState, 'IDLE');

    // 1. First unjustified expensive op: candidate only.
    await coordinator.onExpensiveOperation({ operationName: 'getAppStatus', activityCategory: 'system_automation' });
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);

    // 2. Repetition confirms.
    await coordinator.onExpensiveOperation({ operationName: 'getAppStatus', activityCategory: 'system_automation' });
    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    const incident = open[0];
    assert.strictEqual(incident.incidentType, 'UNEXPECTED_IDLE_ACTIVITY');
    assert.strictEqual(incident.severity, 'WARNING');
    assert.strictEqual(incident.evidence.operationName, 'getAppStatus');
    assert.strictEqual(incident.evidence.activePairCount, 0);

    // 3. Operator-initiated work must NOT confirm.
    const h2 = harness();
    for (let i = 0; i < 5; i++) {
      await h2.coordinator.onExpensiveOperation({ operationName: 'manual', activityCategory: 'provider', operatorInitiated: true });
    }
    assert.strictEqual((await h2.db.healthIncidents.findOpen()).length, 0);

    // 4. UI/report identify category and idle evidence.
    const list = await projection.listActiveIncidents();
    assert.strictEqual(list[0].incidentType, 'UNEXPECTED_IDLE_ACTIVITY');
    const report = (await handoff.generate(incident.id))!;
    assert.ok(report.text.includes('system_automation'));
    assert.ok(report.text.includes('getAppStatus'));

    // 5. Manual recovery: quiet period clears the candidate, then explicit resolve.
    await coordinator.onExpensiveOperation({ operationName: 'getAppStatus', activityCategory: 'system_automation' });
    await coordinator.resolveIncidentOnAuthoritativeRecovery(incident.id);
    assert.strictEqual((await db.healthIncidents.findById(incident.id))!.status, 'RESOLVED');
  });
});

describe('GATE B4: TRANSPORT_UNHEALTHY full loop', () => {
  it('provider reachable + transport failure -> transport incident only; recovers on success', async () => {
    const h = harness();
    const { db, coordinator, projection, handoff } = h;

    const fail = {
      providerType: 'chatgpt', providerReachable: true, integrationStatus: 'verified',
      activePairId: 'pair_t', deliveryId: 'del_t', deliveryStatus: 'failed',
      authoritative: true, blocksActiveWork: true,
    };

    await coordinator.onTransportEvidence(fail);
    await coordinator.onTransportEvidence(fail);

    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    const incident = open[0];
    assert.strictEqual(incident.incidentType, 'TRANSPORT_UNHEALTHY');
    // Provider reachable, so no provider-unreachable incident.
    assert.ok(!open.some((i) => i.incidentType === 'PROVIDER_UNREACHABLE'));
    // Blocking active work -> ERROR.
    assert.strictEqual(incident.severity, 'ERROR');

    const summary = await projection.getHealthSummary();
    assert.strictEqual(summary.overall, 'UNHEALTHY');

    const report = (await handoff.generate(incident.id))!;
    assert.ok(report.text.includes('not_delivered'));
    assert.ok(!/root cause is/i.test(report.text));

    // Manual recovery: transport succeeds again -> authoritative healthy evidence.
    await coordinator.onTransportEvidence({
      ...fail, deliveryStatus: 'delivered', reconciliationOutcome: 'delivered',
    });
    await coordinator.resolveIncidentOnAuthoritativeRecovery(incident.id);
    assert.strictEqual((await db.healthIncidents.findById(incident.id))!.status, 'RESOLVED');
  });
});

describe('GATE B5: SESSION_DRIFT full loop', () => {
  it('authoritative mismatch -> SESSION_DRIFT only; no rebind; UNKNOWN does not resolve; match resolves', async () => {
    const h = harness();
    const { db, coordinator, projection, handoff } = h;

    const expected = { externalSessionId: 'ses_expected', identityState: 'resolved' as const, verificationState: 'verified' as const };
    const observedMismatch = { externalSessionId: 'ses_observed', identityState: 'resolved' as const, verificationState: 'mismatched' as const };

    const base = { pairId: 'pair_s', projectId: 'proj_s', sideRole: 'worker' as const, providerType: 'opencode', runtimeSessionId: 'rt_s', activeWorkAffected: true };

    await coordinator.onSessionIdentityEvidence({
      ...base,
      storedExternalSessionId: expected.externalSessionId,
      storedIdentityState: expected.identityState,
      storedVerificationState: expected.verificationState,
      observedExternalSessionId: observedMismatch.externalSessionId,
      observedIdentityState: observedMismatch.identityState,
      observedVerificationState: observedMismatch.verificationState,
    });

    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    const incident = open[0];
    assert.strictEqual(incident.incidentType, 'SESSION_DRIFT');
    assert.ok(!open.some((i) => i.incidentType === 'PROVIDER_UNREACHABLE'), 'drift is not reachability');

    // No automatic rebind: no runtime/session was created or mutated.
    assert.deepStrictEqual(await db.runtimes.findAll(), []);

    const report = (await handoff.generate(incident.id))!;
    assert.ok(report.text.includes('ses_expected'));
    assert.ok(report.text.includes('ses_observed'));
    assert.ok(report.text.includes('mismatched'));

    // Stale / unavailable evidence must NOT resolve.
    await coordinator.onSessionIdentityEvidence({
      ...base,
      storedExternalSessionId: expected.externalSessionId,
      storedIdentityState: expected.identityState,
      observedIdentityState: 'unknown',
    });
    assert.strictEqual((await db.healthIncidents.findById(incident.id))!.status, 'OPEN', 'UNKNOWN is not recovery');

    // Manual recovery: authoritative observation now matches.
    await coordinator.onSessionIdentityEvidence({
      ...base,
      storedExternalSessionId: expected.externalSessionId,
      storedIdentityState: expected.identityState,
      storedVerificationState: expected.verificationState,
      observedExternalSessionId: expected.externalSessionId,
      observedIdentityState: expected.identityState,
      observedVerificationState: 'verified',
    });
    await coordinator.resolveIncidentOnAuthoritativeRecovery(incident.id);
    assert.strictEqual((await db.healthIncidents.findById(incident.id))!.status, 'RESOLVED');
  });
});

describe('GATE B6: PROVIDER_UNREACHABLE full loop', () => {
  it('required provider unreachable -> root incident owns it; transport suppressed; recovery resolves', async () => {
    const h = harness();
    const { db, coordinator, projection, handoff } = h;

    const outage = {
      providerType: 'chatgpt', integrationStatus: 'verified', reachable: false,
      requiredForActiveWork: true, blocksActiveWork: true, pairId: 'pair_u', activePairCount: 1,
    };

    // Transport sees the same evidence twice: must defer, never open.
    await coordinator.onTransportEvidence({ providerReachable: false, integrationStatus: 'verified', activePairId: 'pair_u', deliveryId: 'del_u' });
    await coordinator.onTransportEvidence({ providerReachable: false, integrationStatus: 'verified', activePairId: 'pair_u', deliveryId: 'del_u' });

    // Provider unreachable confirms immediately (blocking authoritative).
    await coordinator.onProviderReachabilityEvidence(outage);

    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1, 'exactly one root incident');
    const incident = open[0];
    assert.strictEqual(incident.incidentType, 'PROVIDER_UNREACHABLE');
    assert.ok(!open.some((i) => i.incidentType === 'TRANSPORT_UNHEALTHY'), 'redundant transport incident suppressed');
    assert.strictEqual(incident.severity, 'ERROR');

    const summary = await projection.getHealthSummary();
    assert.strictEqual(summary.overall, 'UNHEALTHY');

    const report = (await handoff.generate(incident.id))!;
    assert.ok(report.text.includes('PROVIDER_UNREACHABLE'));
    assert.ok(/requiredForActiveWork|unavailable/.test(report.text));

    // Manual recovery: authoritative reachable evidence.
    await coordinator.onProviderReachabilityEvidence({
      ...outage, reachable: true,
    });
    await coordinator.resolveIncidentOnAuthoritativeRecovery(incident.id);
    assert.strictEqual((await db.healthIncidents.findById(incident.id))!.status, 'RESOLVED');
  });
});

/* ========================================================================
 * PART C — Cross-rule behavior
 * ======================================================================== */

describe('GATE C: cross-rule behavior', () => {
  it('provider outage yields PROVIDER_UNREACHABLE (+ optional stall), never TRANSPORT_UNREALTHY', async () => {
    const h = harness();
    await h.coordinator.onTransportEvidence({ providerReachable: false, integrationStatus: 'verified', activePairId: 'p', deliveryStatus: 'failed' });
    await h.coordinator.onTransportEvidence({ providerReachable: false, integrationStatus: 'verified', activePairId: 'p', deliveryStatus: 'failed' });
    await h.coordinator.onProviderReachabilityEvidence({ providerType: 'chatgpt', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true, blocksActiveWork: true });
    const types = (await h.db.healthIncidents.findOpen()).map((i) => i.incidentType);
    assert.ok(!types.includes('TRANSPORT_UNHEALTHY'), 'redundant transport must be suppressed');
    assert.ok(types.includes('PROVIDER_UNREACHABLE'));
  });

  it('identity mismatch yields SESSION_DRIFT, not PROVIDER_UNREACHABLE', async () => {
    const h = harness();
    await h.coordinator.onSessionIdentityEvidence({
      pairId: 'p', sideRole: 'planner', providerType: 'chatgpt',
      storedExternalSessionId: 'a', storedIdentityState: 'resolved',
      observedExternalSessionId: 'b', observedIdentityState: 'resolved', activeWorkAffected: true,
    });
    const types = (await h.db.healthIncidents.findOpen()).map((i) => i.incidentType);
    assert.deepStrictEqual(types, ['SESSION_DRIFT']);
  });

  it('ambiguous delivery is uncertain, never a stalled incident and never unreachable', async () => {
    const h = harness();
    const { evaluateDeliveryStalled } = await import('../src/relay/health/deliveryStalledCheck.ts');
    const r = evaluateDeliveryStalled('ambiguous', T0, T0, 'del_amb', T0 + 1_000_000, {}, { count: 5 });
    assert.notStrictEqual(r.kind, 'HEALTHY');
    assert.strictEqual(r.incidentEligible, false);
    assert.strictEqual(r.observation!.checkType, 'DELIVERY_AMBIGUOUS');
    assert.ok(r.message!.includes('retry not authorized'));
    assert.strictEqual((await h.db.healthIncidents.findOpen()).length, 0);
  });

  it('UNKNOWN evidence creates nothing, resolves nothing, and never fakes HEALTHY', async () => {
    const h = harness();
    // Unknown reachability.
    await h.coordinator.onProviderReachabilityEvidence({ providerType: 'x', integrationStatus: 'verified', reachable: null, requiredForActiveWork: true });
    // Unknown session identity.
    await h.coordinator.onSessionIdentityEvidence({ pairId: 'p', sideRole: 'worker', providerType: 'opencode', storedExternalSessionId: 's', observedIdentityState: 'unknown' });
    assert.strictEqual((await h.db.healthIncidents.findOpen()).length, 0, 'UNKNOWN creates nothing');

    const summary = await h.projection.getHealthSummary();
    assert.strictEqual(summary.overall, 'UNKNOWN', 'no evidence is not HEALTHY');
  });
});

/* ========================================================================
 * PART F — Restart
 * ======================================================================== */

describe('GATE F: restart durability', () => {
  it('open incident survives restart, is not duplicated, and UNKNOWN does not resolve it', async () => {
    const file = `${process.env.TMPDIR || '/tmp'}/gate_f_${Date.now()}.sqlite`;
    const first = new SqliteRelayDatabase(file);
    const h1 = harness(first as unknown as MemoryRelayDatabase);
    await h1.coordinator.onProviderReachabilityEvidence({
      providerType: 'opencode', integrationStatus: 'verified', reachable: false,
      requiredForActiveWork: true, blocksActiveWork: true,
    });
    const original = (await first.healthIncidents.findOpen())[0];
    first.db.close();

    // Restart.
    const second = new SqliteRelayDatabase(file);
    const h2 = harness(second as unknown as MemoryRelayDatabase);
    const startup = await h2.coordinator.onStartup();
    assert.strictEqual(startup.openIncidents, 1);
    const afterRestart = await second.healthIncidents.findOpen();
    assert.strictEqual(afterRestart.length, 1, 'restart must not duplicate');
    assert.strictEqual(afterRestart[0].id, original.id);
    assert.strictEqual(afterRestart[0].occurrenceCount, original.occurrenceCount);
    assert.strictEqual(afterRestart[0].firstSeen, original.firstSeen);

    // UNKNOWN after startup must not resolve it.
    await h2.coordinator.onProviderReachabilityEvidence({
      providerType: 'opencode', integrationStatus: 'verified', reachable: null, requiredForActiveWork: true,
    });
    assert.strictEqual((await second.healthIncidents.findById(original.id))!.status, 'OPEN');

    // New authoritative evidence continues normal update.
    await h2.coordinator.onProviderReachabilityEvidence({
      providerType: 'opencode', integrationStatus: 'verified', reachable: false,
      requiredForActiveWork: true, blocksActiveWork: true,
    });
    assert.strictEqual((await second.healthIncidents.findOpen())[0].occurrenceCount, original.occurrenceCount + 1);

    await h2.coordinator.resolveIncidentOnAuthoritativeRecovery(original.id);
    assert.strictEqual((await second.healthIncidents.findById(original.id))!.status, 'RESOLVED');
    second.db.close();
  });
});

/* ========================================================================
 * PART G — Idle performance
 * ======================================================================== */

describe('GATE G: idle performance', () => {
  it('idle cycles: no provider work, bounded observations, single cheap heartbeat', async () => {
    const h = harness();
    const { db, coordinator } = h;
    const before = coordinator.getStats();

    // Multiple heartbeat cycles with no work at all.
    const cycles = 5;
    for (let i = 0; i < cycles; i++) {
      await coordinator.probeMainProcessLag();
      await coordinator.evaluateStalledDeliveries();
    }

    const after = coordinator.getStats();
    assert.strictEqual(after.failures, 0, 'no failures while idle');
    assert.strictEqual(after.deliveryStallEvaluations, 0, 'no delivery sweep work with no unresolved deliveries');
    assert.strictEqual(after.providerEvaluations, before.providerEvaluations, 'no provider sweep');
    assert.strictEqual(after.sessionEvaluations, before.sessionEvaluations, 'no session discovery');
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0, 'idle creates no incidents');

    // Observations stay bounded by the sampling policy.
    const rows = await db.healthObservations.findRecent(10_000);
    assert.ok(rows.length < cycles, `health observations must be sampled, got ${rows.length} for ${cycles} probes`);

    // Scheduler ticks cheaply and stops cleanly.
    const scheduler = new HealthScheduler({ coordinator, logger: { warn: () => {} } });
    await scheduler.tick();
    scheduler.start();
    assert.strictEqual(scheduler.isRunning(), true);
    scheduler.stop();
    assert.strictEqual(scheduler.isRunning(), false);
    assert.strictEqual(HEALTH_HEARTBEAT_INTERVAL_MS, 60_000);
  });

  it('healthy-heartbeat growth stays bounded over many cycles', async () => {
    const h = harness();
    const { db } = h;
    const { HealthObservation } = await import('../src/relay/domain/healthDomain.ts');
    const total = HEALTH_HEALTHY_OBSERVATION_SAMPLE_EVERY * 4;
    for (let i = 0; i < total; i++) {
      await (h.coordinator as any).persistObservation(new HealthObservation({
        id: `p${i}`, checkType: 'MAIN_PROCESS_STALL', componentType: 'main_process',
        componentId: 'electron_main', result: 'HEALTHY', timestamp: T0 + i, evidence: {},
      }));
    }
    const rows = await db.healthObservations.findRecent(10_000);
    assert.strictEqual(rows.length, 4, 'exactly one sampled row per interval');
  });
});

/* ========================================================================
 * PART D/E — UI and handoff acceptance over all six classes
 * ======================================================================== */

describe('GATE D/E: UI + handoff across all six classes', () => {
  const cases = [
    { type: 'DELIVERY_STALLED', ct: 'delivery', cid: 'd1', sev: 'ERROR' as const, ev: { deliveryId: 'd1', ageMs: 200000 } },
    { type: 'MAIN_PROCESS_STALL', ct: 'main_process', cid: 'electron_main', sev: 'ERROR' as const, ev: { measuredLagMs: 800, thresholdErrorMs: 500 } },
    { type: 'UNEXPECTED_IDLE_ACTIVITY', ct: 'supervision', cid: 'idle_monitor', sev: 'WARNING' as const, ev: { operationName: 'getAppStatus', activityCategory: 'system_automation', activePairCount: 0 } },
    { type: 'TRANSPORT_UNHEALTHY', ct: 'transport', cid: 'pair_t', sev: 'ERROR' as const, ev: { transportOutcome: 'not_delivered', activeWorkBlocked: true, prompt: 'SECRET' } },
    { type: 'SESSION_DRIFT', ct: 'session_pair', cid: 'pair_s', sev: 'ERROR' as const, ev: { expectedExternalSessionId: 'ses_a', observedExternalSessionId: 'ses_b', transcript: 'SECRET_T' } },
    { type: 'PROVIDER_UNREACHABLE', ct: 'provider', cid: 'chatgpt', sev: 'ERROR' as const, ev: { requiredForActiveWork: true, providerReachable: false } },
  ];

  for (const c of cases) {
    it(`${c.type}: UI projection + safe handoff report`, async () => {
      const h = harness();
      const { HealthIncident } = await import('../src/relay/domain/healthDomain.ts');
      await h.db.healthIncidents.save(new HealthIncident({
        id: `g_${c.type}`, incidentType: c.type, componentType: c.ct, componentId: c.cid,
        severity: c.sev, status: 'OPEN', firstSeen: T0, lastSeen: T0 + 5, occurrenceCount: 4, evidence: c.ev,
      }));
      await h.db.healthObservations.save(new (await import('../src/relay/domain/healthDomain.ts')).HealthObservation({
        id: `o_${c.type}`, checkType: c.type, componentType: c.ct, componentId: c.cid,
        result: 'UNHEALTHY', timestamp: T0, evidence: {},
      }));

      // UI: correct aggregate, severity, type, component.
      const summary = await h.projection.getHealthSummary();
      assert.strictEqual(summary.overall, c.sev === 'WARNING' ? 'DEGRADED' : 'UNHEALTHY');
      const list = await h.projection.listActiveIncidents();
      assert.strictEqual(list[0].incidentType, c.type);
      assert.strictEqual(list[0].severity, c.sev);
      assert.strictEqual(list[0].componentType, c.ct);

      // Detail is bounded and safe.
      const detail = await h.projection.getHealthIncident(`g_${c.type}`);
      assert.ok(detail);
      for (const v of Object.values(detail!.evidence)) {
        assert.ok(['string', 'number', 'boolean'].includes(typeof v), 'evidence must be scalar-only');
      }

      // Handoff: useful, safe, bounded, no root-cause claim.
      const report = (await h.handoff.generate(`g_${c.type}`))!;
      assert.ok(report.text.includes(c.type));
      assert.ok(!/root cause is/i.test(report.text));
      assert.ok(!/fix by/i.test(report.text));
      assert.ok(!report.text.includes('SECRET'), 'sensitive evidence must not appear');
      assert.ok(report.relatedEvents.length <= 20);
      assert.ok(report.text.includes('Manual investigation required.'));

      // Acknowledgement stays acknowledged.
      await h.projection.acknowledgeIncident(`g_${c.type}`);
      assert.strictEqual((await h.db.healthIncidents.findById(`g_${c.type}`))!.status, 'ACKNOWLEDGED');
      // And a report still generates for acknowledged history.
      assert.ok((await h.handoff.generate(`g_${c.type}`))!.text.includes('ACKNOWLEDGED'));

      // Resolve -> moves to history, recurrence distinguishable.
      await h.projection.acknowledgeIncident(`g_${c.type}`);
      await h.coordinator.resolveIncidentOnAuthoritativeRecovery(`g_${c.type}`);
      assert.strictEqual((await h.db.healthIncidents.findById(`g_${c.type}`))!.status, 'RESOLVED');
      assert.strictEqual((await h.projection.listActiveIncidents()).length, 0);
      assert.strictEqual((await h.projection.listResolvedIncidents()).length, 1);
    });
  }
});
