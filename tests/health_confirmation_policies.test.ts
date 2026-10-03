/**
 * Phase 1 semantic correction pass — per-detector confirmation policies,
 * cross-rule precedence, ambiguous semantics, and lifecycle fixes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { HealthIncidentEngine } from '../src/relay/application/HealthIncidentEngine.ts';
import { HealthConfirmationTracker } from '../src/relay/health/healthConfirmation.ts';
import {
  TransportUnhealthyMonitor,
  ProviderUnreachableMonitor,
  SessionDriftMonitor,
  IdleActivityMonitor,
} from '../src/relay/health/healthMonitors.ts';
import { evaluateDeliveryStalled } from '../src/relay/health/deliveryStalledCheck.ts';
import { measureEventLoopLag } from '../src/relay/health/mainProcessStallCheck.ts';

const T0 = 1_700_000_000_000;

function harness() {
  const db = new SqliteRelayDatabase(':memory:');
  const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
  return { db, engine };
}

/* ---------- Fix 1: lag measurement ---------- */

describe('Fix 1: main-process lag is scheduling lag', () => {
  it('a normal 50ms probe reports near-zero lag', async () => {
    const lag = await measureEventLoopLag(50);
    assert.ok(lag >= 0);
    assert.ok(lag < 50, `expected sub-50ms lag, got ${lag}`);
  });

  it('lag never goes negative', async () => {
    const lag = await measureEventLoopLag(0);
    assert.ok(lag >= 0);
  });
});

/* ---------- Fix 4: per-detector confirmation policies ---------- */

describe('Fix 4: confirmation policies are per-detector', () => {
  it('repetition_only requires two samples', () => {
    const t = new HealthConfirmationTracker();
    const base = { key: 'k', policy: 'repetition_only' as const, qualifying: true, authoritative: true, blocksActiveWork: false, nowMs: 1 };
    assert.strictEqual(t.evaluate(base).confirmed, false);
    assert.strictEqual(t.evaluate({ ...base, nowMs: 2 }).confirmed, true);
  });

  it('repetition_or_blocking_authoritative confirms immediately when work is blocked', () => {
    const t = new HealthConfirmationTracker();
    const r = t.evaluate({
      key: 'k', policy: 'repetition_or_blocking_authoritative', qualifying: true,
      authoritative: true, blocksActiveWork: true, nowMs: 1,
    });
    assert.strictEqual(r.confirmed, true);
    assert.ok(r.reason.includes('blocks active work'));
  });

  it('repetition_or_blocking_authoritative still needs repetition when nothing is blocked', () => {
    const t = new HealthConfirmationTracker();
    const base = {
      key: 'k', policy: 'repetition_or_blocking_authoritative' as const,
      qualifying: true, authoritative: true, blocksActiveWork: false, nowMs: 1,
    };
    assert.strictEqual(t.evaluate(base).confirmed, false);
    assert.strictEqual(t.evaluate({ ...base, nowMs: 2 }).confirmed, true);
  });

  it('immediate_if_authoritative confirms on first strong mismatch', () => {
    const t = new HealthConfirmationTracker();
    const r = t.evaluate({
      key: 'k', policy: 'immediate_if_authoritative', qualifying: true,
      authoritative: true, blocksActiveWork: false, nowMs: 1,
    });
    assert.strictEqual(r.confirmed, true);
  });

  it('immediate_if_authoritative needs a second sample when provisional', () => {
    const t = new HealthConfirmationTracker();
    const base = {
      key: 'k', policy: 'immediate_if_authoritative' as const,
      qualifying: true, authoritative: false, blocksActiveWork: false, nowMs: 1,
    };
    assert.strictEqual(t.evaluate(base).confirmed, false);
    assert.strictEqual(t.evaluate({ ...base, nowMs: 2 }).confirmed, true);
  });

  it('healthy evidence clears a stale candidate', () => {
    const t = new HealthConfirmationTracker();
    const base = { key: 'k', policy: 'repetition_only' as const, qualifying: true, authoritative: true, blocksActiveWork: false, nowMs: 1 };
    t.evaluate(base);
    assert.strictEqual(t.get('k')?.count, 1);
    t.evaluate({ ...base, qualifying: false, nowMs: 2 });
    assert.strictEqual(t.get('k'), undefined);
    // A later isolated sample must start over, not confirm.
    assert.strictEqual(t.evaluate({ ...base, nowMs: 3 }).confirmed, false);
  });

  it('two unrelated occurrences separated by a healthy sample never confirm', () => {
    const t = new HealthConfirmationTracker();
    const base = { key: 'k', policy: 'repetition_only' as const, qualifying: true, authoritative: true, blocksActiveWork: false, nowMs: 1 };
    t.evaluate(base);                                   // count 1
    t.evaluate({ ...base, qualifying: false, nowMs: 2 }); // cleared
    t.evaluate({ ...base, nowMs: 3 });                    // count 1 again
    assert.strictEqual(t.get('k')?.count, 1);
  });

  it('operator-initiated work never confirms', () => {
    const t = new HealthConfirmationTracker();
    const r = t.evaluate({
      key: 'k', policy: 'repetition_only', qualifying: true,
      authoritative: true, blocksActiveWork: false, operatorInitiated: true, nowMs: 1,
    });
    assert.strictEqual(r.confirmed, false);
    assert.ok(r.reason.includes('operator-initiated'));
  });
});

/* ---------- Fix 4 applied per detector ---------- */

describe('Fix 4: detectors honour their own policy', () => {
  it('TRANSPORT_UNHEALTHY: transient failure is a candidate, repeat confirms', async () => {
    const { db, engine } = harness();
    const m = new TransportUnhealthyMonitor(engine);
    const ev = { hasActiveWork: true, providerReachable: true, providerStatus: 'verified' as const, activePairId: 'p1', deliveryStatus: 'failed' as const };

    const r1 = await m.evaluate(ev, T0);
    assert.strictEqual(r1.kind, 'FAILED');
    assert.strictEqual(r1.confirmed, false);
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);

    const r2 = await m.evaluate(ev, T0 + 1);
    assert.strictEqual(r2.confirmed, true);
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 1);
  });

  it('TRANSPORT_UNHEALTHY: provider outage defers instead of double-reporting', async () => {
    const { db, engine } = harness();
    const m = new TransportUnhealthyMonitor(engine);
    const r1 = await m.evaluate({ hasActiveWork: true, providerReachable: false, providerStatus: 'verified', activePairId: 'p1' }, T0);
    const r2 = await m.evaluate({ hasActiveWork: true, providerReachable: false, providerStatus: 'verified', activePairId: 'p1' }, T0 + 1);
    assert.strictEqual(r1.kind, 'DEFERS_TO_PROVIDER_UNREACHABLE');
    assert.strictEqual(r1.confirmed, false);
    assert.strictEqual(r2.confirmed, false);
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);
  });

  it('PROVIDER_UNREACHABLE: repeated unreachable confirms; dedup to one incident', async () => {
    const { db, engine } = harness();
    const m = new ProviderUnreachableMonitor(engine);
    // Required but NOT blocking: the conservative repetition policy applies.
    const ev = { providerType: 'chatgpt', integrationStatus: 'verified' as const, reachable: false, requiredForActiveWork: true };

    assert.strictEqual((await m.evaluate(ev, T0)).confirmed, false);
    const r2 = await m.evaluate(ev, T0 + 1);
    assert.strictEqual(r2.confirmed, true);
    const r3 = await m.evaluate(ev, T0 + 2);
    assert.strictEqual(r3.confirmed, true);

    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].occurrenceCount, 3);
  });

  it('PROVIDER_UNREACHABLE: unused provider never becomes an incident', async () => {
    const { db, engine } = harness();
    const m = new ProviderUnreachableMonitor(engine);
    const ev = { providerType: 'vscode', integrationStatus: 'verified' as const, reachable: false, requiredForActiveWork: false };
    for (let i = 0; i < 3; i++) {
      assert.strictEqual((await m.evaluate(ev, T0 + i)).confirmed, false);
    }
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);
  });

  it('PROVIDER_UNREACHABLE: unknown reachability never confirms', async () => {
    const { db, engine } = harness();
    const m = new ProviderUnreachableMonitor(engine);
    const ev = { providerType: 'chatgpt', integrationStatus: 'verified' as const, reachable: null, requiredForActiveWork: true };
    assert.strictEqual((await m.evaluate(ev, T0)).confirmed, false);
    assert.strictEqual((await m.evaluate(ev, T0 + 1)).confirmed, false);
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);
  });

  it('SESSION_DRIFT: strong authoritative mismatch confirms immediately', async () => {
    const { db, engine } = harness();
    const m = new SessionDriftMonitor(engine);
    const r = await m.evaluate({
      pairId: 'pair_1', sideRole: 'planner', providerType: 'chatgpt',
      storedExternalSessionId: 'c/a', observedExternalSessionId: 'c/b',
      storedIdentityState: 'resolved', observedIdentityState: 'resolved', activeWorkAffected: true,
    }, T0);
    assert.strictEqual(r.kind, 'UNHEALTHY');
    assert.strictEqual(r.confirmed, true);
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 1);
  });

  it('SESSION_DRIFT: unavailable observation stays UNKNOWN and never confirms', async () => {
    const { db, engine } = harness();
    const m = new SessionDriftMonitor(engine);
    const ev = {
      pairId: 'pair_2', sideRole: 'worker' as const, providerType: 'opencode',
      storedExternalSessionId: 'ses_a', observedIdentityState: 'unknown' as const, activeWorkAffected: true,
    };
    assert.strictEqual((await m.evaluate(ev, T0)).confirmed, false);
    assert.strictEqual((await m.evaluate(ev, T0 + 1)).confirmed, false);
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);
  });

  it('UNEXPECTED_IDLE_ACTIVITY: repetition required; operator action never confirms', async () => {
    const { db, engine } = harness();
    const m = new IdleActivityMonitor(engine);
    const idle = { pairOperationalStates: ['IDLE'], hasActiveAssignment: false, pairCount: 1, activePairCount: 0, activeAssignmentCount: 0 };

    assert.strictEqual((await m.evaluate('applescript', 'system_automation', T0, idle, {})).confirmed, false);
    const r2 = await m.evaluate('applescript', 'system_automation', T0 + 1, idle, {});
    assert.strictEqual(r2.confirmed, true);
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 1);

    // An operator-initiated operation, even repeated, never confirms.
    const m2 = new IdleActivityMonitor(engine);
    for (let i = 0; i < 3; i++) {
      const r = await m2.evaluate('manual_probe', 'system_automation', T0 + 10 + i, idle, { operatorInitiated: true });
      assert.strictEqual(r.confirmed, false);
    }
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 1);
  });
});

/* ---------- Fix 5: ambiguous semantics ---------- */

describe('Fix 5: ambiguous is uncertain, not stalled', () => {
  it('ambiguous delivery is not HEALTHY and not a DELIVERY_STALLED incident', () => {
    const r = evaluateDeliveryStalled('ambiguous', T0, T0, 'del_a', T0 + 500_000, {}, { count: 5 });
    assert.notStrictEqual(r.kind, 'HEALTHY');
    assert.strictEqual(r.kind, 'DEGRADED');
    assert.strictEqual(r.incidentEligible, false);
    // Reported under its own check type so it can never be a stall incident.
    assert.strictEqual(r.observation!.checkType, 'DELIVERY_AMBIGUOUS');
    assert.notStrictEqual(r.observation!.checkType, 'DELIVERY_STALLED');
  });

  it('ambiguous delivery never authorizes retry', () => {
    const r = evaluateDeliveryStalled('ambiguous', T0, T0, 'del_b', T0, {});
    assert.ok(String(r.evidence!.status) === 'ambiguous');
    assert.ok(r.message!.includes('retry not authorized'));
  });

  it('ambiguous transport stays DEGRADED and never becomes provider-unreachable', () => {
    const { db, engine } = harness();
    const m = new TransportUnhealthyMonitor(engine);
    const ev = { hasActiveWork: true, providerReachable: true, providerStatus: 'degraded' as const, activePairId: 'p9', deliveryStatus: 'ambiguous' as const };
    return m.evaluate(ev, T0).then(async (r1) => {
      assert.strictEqual(r1.kind, 'AMBIGUOUS');
      assert.strictEqual(r1.confirmed, false);
      await m.evaluate(ev, T0 + 1);
      const open = await db.healthIncidents.findOpen();
      assert.strictEqual(open.length, 1);
      assert.strictEqual(open[0].incidentType, 'TRANSPORT_UNHEALTHY');
      assert.strictEqual(open[0].severity, 'WARNING');
      assert.strictEqual(open[0].status, 'OPEN');
    });
  });
});

/* ---------- Cross-rule regression matrix ---------- */

describe('Cross-rule regression matrix', () => {
  it('1. provider unreachable + active delivery -> one root incident plus optional stall', async () => {
    const { db, engine } = harness();
    const provider = new ProviderUnreachableMonitor(engine);
    const transport = new TransportUnhealthyMonitor(engine);

    const pr1 = await provider.evaluate({ providerType: 'chatgpt', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true, blocksActiveWork: true }, T0);
    const tr1 = await transport.evaluate({ hasActiveWork: true, providerReachable: false, providerStatus: 'verified', activePairId: 'pair_x' }, T0);
    await provider.evaluate({ providerType: 'chatgpt', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true, blocksActiveWork: true }, T0 + 1);

    assert.strictEqual(pr1.confirmed, true, 'blocking unreachable confirms immediately');
    assert.strictEqual(tr1.kind, 'DEFERS_TO_PROVIDER_UNREACHABLE');
    assert.strictEqual(tr1.confirmed, false);

    const open = await db.healthIncidents.findOpen();
    assert.deepStrictEqual(open.map((i) => i.incidentType), ['PROVIDER_UNREACHABLE']);
  });

  it('2. provider reachable + transport fails -> TRANSPORT_UNHEALTHY valid', async () => {
    const { db, engine } = harness();
    const m = new TransportUnhealthyMonitor(engine);
    const ev = { hasActiveWork: true, providerReachable: true, providerStatus: 'verified' as const, activePairId: 'p2', deliveryStatus: 'failed' as const };
    await m.evaluate(ev, T0);
    await m.evaluate(ev, T0 + 1);
    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].incidentType, 'TRANSPORT_UNHEALTHY');
  });

  it('3. authoritative identity mismatch -> SESSION_DRIFT, not provider unreachable', async () => {
    const { db, engine } = harness();
    const m = new SessionDriftMonitor(engine);
    await m.evaluate({
      pairId: 'pair_3', sideRole: 'planner', providerType: 'chatgpt',
      storedExternalSessionId: 'c/x', observedExternalSessionId: 'c/y',
      storedIdentityState: 'resolved', observedIdentityState: 'resolved', activeWorkAffected: true,
    }, T0);
    const open = await db.healthIncidents.findOpen();
    assert.strictEqual(open.length, 1);
    assert.strictEqual(open[0].incidentType, 'SESSION_DRIFT');
  });

  it('4. observation unavailable -> no drift and no unreachable false positive', async () => {
    const { db, engine } = harness();
    const drift = new SessionDriftMonitor(engine);
    const provider = new ProviderUnreachableMonitor(engine);
    await drift.evaluate({ pairId: 'p4', sideRole: 'worker' as const, providerType: 'opencode', storedExternalSessionId: 'ses_1', observedIdentityState: 'unknown', activeWorkAffected: true }, T0);
    await provider.evaluate({ providerType: 'opencode', integrationStatus: 'verified', reachable: null, requiredForActiveWork: true }, T0);
    assert.strictEqual((await db.healthIncidents.findOpen()).length, 0);
  });

  it('5. UNKNOWN cannot resolve an open incident', async () => {
    const { db, engine } = harness();
    const m = new ProviderUnreachableMonitor(engine);
    await m.evaluate({ providerType: 'chatgpt', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true }, T0);
    await m.evaluate({ providerType: 'chatgpt', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true }, T0 + 1);
    const before = await db.healthIncidents.findOpen();
    assert.strictEqual(before.length, 1);

    await m.evaluate({ providerType: 'chatgpt', integrationStatus: 'verified', reachable: null, requiredForActiveWork: true }, T0 + 2);
    const after = await db.healthIncidents.findOpen();
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].status, 'OPEN');
  });
});
