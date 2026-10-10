/**
 * Start must not narrow the set of Planner integrations the pairing authority accepts.
 *
 * ## The defect this pins
 *
 * `createPair()` admits any runtime whose provider is registered with a `planner` or `both`
 * role (`isPlannerProvider`). The observer bootstrap, however, is a CHATGPT-SPECIFIC mechanism:
 * it arms the in-page ChatGPT observer. When Start required that observer for *every* Planner,
 * it threw `BOOTSTRAP_SIDE_INVALID` for any non-ChatGPT planner, so a Pair that the pairing
 * authority had explicitly accepted could never transition to RUNNING until an Assignment
 * happened to exist. That silently narrowed a supported capability.
 *
 * ## What is deliberately NOT changed
 *
 *   - Role validation is untouched. An integration without a planner/both role is still
 *     refused by `createPair()`; these tests assert that boundary still holds.
 *   - Fail-closed bootstrap is preserved for the case that actually needs it: an EMPTY
 *     ChatGPT Planner Pair, where the observer boundary IS the bootstrap.
 *   - Nothing is fabricated for a custom planner: no arm, no ingress, no Assignment, no
 *     Delivery, no completion. Bootstrap is INAPPLICABLE there, not failed.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { IntegrationRegistry } from '../src/relay/integrations/runtime/IntegrationRegistry.ts';
import { MockProvider } from './MockProvider.ts';
import { RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { createId, type AssociationId } from '../src/relay/domain/types.ts';

type Db = SqliteRelayDatabase;
const all = (db: Db, sql: string, ...p: any[]) => db.db.prepare(sql).all(...p) as any[];
const count = (db: Db, sql: string, ...p: any[]) =>
  Number((db.db.prepare(sql).get(...p) as any).c);

/**
 * A registry entry with the roles the pairing authority reads. Only `roles` is consulted by
 * `isPlannerProvider`, so the rest is stubbed — the subject under test is the ROLE decision,
 * not a real third-party integration.
 */
function integrationWithRoles(id: string, roles: string[]) {
  return { id, name: id, roles, config: {}, asRuntimeProvider: () => new MockProvider(id) } as any;
}

describe('Start honours the pairing authority for non-ChatGPT planner integrations', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let registry: IntegrationRegistry;
  /** Counts every ChatGPT observer entry point, so "no observer calls" is measured, not assumed. */
  let observerCalls: { ensureBootstrapArmed: number; bootstrapStatus: number };

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    registry = new IntegrationRegistry(db);
    observerCalls = { ensureBootstrapArmed: 0, bootstrapStatus: 0 };
    // The Worker side is exercised by every case, so its provider must always be present.
    engine.registerProvider(new MockProvider('opencode'));
  });

  /**
   * A counting observer. Tests that expect it never to be reached still install it, so
   * "zero observer calls" is a real assertion rather than the absence of a stub.
   */
  function countingObserver() {
    return {
      async ensureBootstrapArmed(conversationId: string) {
        observerCalls.ensureBootstrapArmed++;
        return { armId: 'arm_never_issued', conversationId, reused: false };
      },
      async bootstrapStatus() {
        observerCalls.bootstrapStatus++;
        return {
          available: true, unavailableReason: null, conversationId: '', armId: 'arm_never_issued',
          armActive: true, working: false, completion: null,
          lastState: null, lastObservedAt: null,
          recoveryRequired: false, recoveryReason: null,
        } as any;
      },
      async acknowledgeBootstrapArm() {},
    };
  }

  /** Build an ACTIVE Pair whose Planner is `plannerProviderType`. */
  async function activePairWithPlanner(label: string, plannerProviderType: string) {
    const project = await engine.createProject(`${label} Project`);
    const planner = new RuntimeSession({
      id: createId('sess'), providerType: plannerProviderType as any, name: `${label} Planner`,
      status: 'available', consecutiveObservationFailures: 0,
      externalSessionId: `conv_${label}_planner`, createdAt: Date.now(), updatedAt: Date.now(),
    });
    const worker = new RuntimeSession({
      id: createId('sess'), providerType: 'opencode', name: `${label} Worker`,
      status: 'available', consecutiveObservationFailures: 0,
      externalSessionId: `ses_${label}_worker`, createdAt: Date.now(), updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    for (const [i, s] of [planner, worker].entries()) {
      await db.associations.save(new RuntimeProjectAssociation({
        id: `assoc_${label}_${i}` as AssociationId,
        runtimeSessionId: s.id, projectId: project.id, providerType: s.providerType,
        externalSessionId: s.externalSessionId ?? '', verificationState: 'verified',
        provenance: 'setup', createdAt: Date.now(), updatedAt: Date.now(),
      }));
    }
    const pair = await engine.createPair(project.id, `${label} Pair`, planner.id, worker.id);
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    return pair;
  }

  /** Assert that NOTHING was fabricated for this Pair. */
  function assertNothingFabricated(db: Db, pairId: string, what: string) {
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS c FROM assignments WHERE pair_id = ?', pairId), 0,
      `${what}: no Assignment may be fabricated`);
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS c FROM deliveries WHERE assignment_id IN ' +
      '(SELECT id FROM assignments WHERE pair_id = ?)', pairId), 0, `${what}: no Delivery may be fabricated`);
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS c FROM attempts WHERE assignment_id IN ' +
      '(SELECT id FROM assignments WHERE pair_id = ?)', pairId), 0, `${what}: no Attempt may be fabricated`);
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS c FROM relay_ingress WHERE stable_pair_id = ?', pairId), 0,
      `${what}: no ingress root may be fabricated`);
    // A materialized ingress is the only durable trace a completion leaves; none may exist.
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS c FROM relay_ingress WHERE stable_pair_id = ? AND state = ?',
      pairId, 'materialized'), 0, `${what}: no completion may be materialized`);
  }

  it('a. an accepted planner-role integration can Start without a PlannerObserverClient', async () => {
    registry.register(integrationWithRoles('acme-planner', ['planner']));
    engine.setRegistry(registry);
    engine.registerProvider(new MockProvider('acme-planner'));
    // Deliberately NO observer: the capability that matters here is that Start does not need it.
    assert.strictEqual(engine['plannerObserver'], null, 'precondition: no observer is wired');

    const pair = await activePairWithPlanner('acme', 'acme-planner');
    const started = await engine.startPair(pair.id);

    assert.strictEqual(started.relayState, 'RUNNING', 'a supported planner-role Pair must reach RUNNING');
    assert.strictEqual(started.operationalState, 'ACTIVE');
    assert.ok(started.activeAssignmentId == null, 'RUNNING with no work is a legal awaiting-work state');
    assertNothingFabricated(db, pair.id, 'planner-role');
  });

  it('b. an accepted both-role integration can Start without a PlannerObserverClient', async () => {
    registry.register(integrationWithRoles('acme-both', ['both']));
    engine.setRegistry(registry);
    engine.registerProvider(new MockProvider('acme-both'));
    assert.strictEqual(engine['plannerObserver'], null, 'precondition: no observer is wired');

    const pair = await activePairWithPlanner('both', 'acme-both');
    const started = await engine.startPair(pair.id);

    assert.strictEqual(started.relayState, 'RUNNING', 'a both-role Pair must reach RUNNING');
    assertNothingFabricated(db, pair.id, 'both-role');
  });

  it('c. zero ChatGPT observer calls occur for a non-ChatGPT planner', async () => {
    registry.register(integrationWithRoles('acme-planner', ['planner']));
    engine.setRegistry(registry);
    engine.registerProvider(new MockProvider('acme-planner'));
    // Install the counter. If Start reached the observer at all, these would be non-zero.
    engine['plannerObserver'] = countingObserver() as any;

    const pair = await activePairWithPlanner('zero', 'acme-planner');
    await engine.startPair(pair.id);
    await engine.runSupervisionTick();

    assert.strictEqual(observerCalls.ensureBootstrapArmed, 0,
      'the ChatGPT observer must never be armed for a non-ChatGPT planner');
    assert.strictEqual(observerCalls.bootstrapStatus, 0,
      'the ChatGPT observer must never be polled for a non-ChatGPT planner');
    assertNothingFabricated(db, pair.id, 'observer-counted');
  });

  it('d. no completion is fabricated even when an observer is present and claims one', async () => {
    registry.register(integrationWithRoles('acme-planner', ['planner']));
    engine.setRegistry(registry);
    engine.registerProvider(new MockProvider('acme-planner'));
    // A hostile observer that would happily mint a completion. It must never be consulted.
    engine['plannerObserver'] = countingObserver() as any;

    const pair = await activePairWithPlanner('hostile', 'acme-planner');
    await engine.startPair(pair.id);
    await engine.runSupervisionTick();

    assert.strictEqual(count(db, 'SELECT COUNT(*) AS c FROM assignments'), 0,
      'no Assignment may be created from an observer the planner never asked for');
    assertNothingFabricated(db, pair.id, 'hostile-observer');
  });

  it('e. an EMPTY ChatGPT Pair still fails closed when its observer is unavailable', async () => {
    engine.registerProvider(new MockProvider('chatgpt'));
    assert.strictEqual(engine['plannerObserver'], null, 'precondition: no observer is wired');

    const pair = await activePairWithPlanner('chatgpt', 'chatgpt');
    await assert.rejects(
      engine.startPair(pair.id),
      (err: Error) => {
        assert.match(err.message, /observer/i, 'the failure must name the missing capability');
        return true;
      },
      'an empty ChatGPT Pair whose bootstrap boundary cannot be established must not Start',
    );

    const after = await db.pairs.findById(pair.id);
    assert.notStrictEqual(after!.relayState, 'RUNNING',
      'fail-closed: the Pair must not claim RUNNING without its bootstrap boundary');
    assertNothingFabricated(db, pair.id, 'chatgpt-fail-closed');
  });

  it('f. a provider without a planner role is still refused by the pairing boundary', async () => {
    // Role validation is NOT relaxed by this change: a worker-only integration cannot be bound.
    registry.register(integrationWithRoles('worker-only', ['worker']));
    engine.setRegistry(registry);
    engine.registerProvider(new MockProvider('worker-only'));

    const project = await engine.createProject('Worker Only Project');
    const planner = new RuntimeSession({
      id: createId('sess'), providerType: 'worker-only' as any, name: 'Not A Planner',
      status: 'available', consecutiveObservationFailures: 0,
      externalSessionId: 'conv_worker_only', createdAt: Date.now(), updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_worker_only' as AssociationId,
      runtimeSessionId: planner.id, projectId: project.id, providerType: 'worker-only' as any,
      externalSessionId: 'conv_worker_only', verificationState: 'verified',
      provenance: 'setup', createdAt: Date.now(), updatedAt: Date.now(),
    }));

    await assert.rejects(
      engine.createPair(project.id, 'Should Fail', planner.id, undefined),
      (err: Error) => {
        assert.strictEqual((err as { code?: string }).code, 'INVALID_PLANNER_PROVIDER');
        return true;
      },
      'the existing pairing boundary must continue to reject a non-planner provider',
    );
  });
});