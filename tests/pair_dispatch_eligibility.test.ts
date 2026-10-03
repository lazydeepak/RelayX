/**
 * Dispatch Assignment UX under an AMBIGUOUS active delivery.
 *
 * The engine's Phase-1 dispatch guard refuses a resend when the assignment has an
 * ambiguous delivery (`AmbiguousDeliveryResendError`) or an in-flight delivery
 * (`DuplicateDeliveryAttemptError`). That guard is the authority and is
 * UNCHANGED. This file pins the renderer projection: PairView must not offer an
 * actionable dispatch in those states, must route the operator to the existing
 * Attention & Recovery path for ambiguity, and must still offer a normal dispatch
 * when the state authorizes one.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolvePairDispatchEligibility } from '../src/components/pairDispatchEligibility.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { MockProvider } from './MockProvider.ts';
import { RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { createId } from '../src/relay/domain/types.ts';
import { AmbiguousDeliveryResendError } from '../src/relay/domain/errors.ts';

const pairViewSource = readFileSync(new URL('../src/components/PairView.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const engineSource = readFileSync(new URL('../src/relay/application/RelayEngine.ts', import.meta.url), 'utf8');

/* ======================================================================== *
 * Pure projection
 * ======================================================================== */
describe('resolvePairDispatchEligibility — UI projection of the dispatch guard', () => {
  it('an AMBIGUOUS active delivery is not eligible and flags the recovery path', () => {
    const result = resolvePairDispatchEligibility({ deliveryStatus: 'ambiguous' });
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.ambiguous, true);
    assert.match(result.reason ?? '', /ambiguous/i);
    assert.match(result.reason ?? '', /Attention & Recovery/);
  });

  it('an in-flight (delivering) delivery is not eligible', () => {
    const result = resolvePairDispatchEligibility({ deliveryStatus: 'delivering' });
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.ambiguous, false);
    assert.match(result.reason ?? '', /in flight/i);
  });

  it('delivered, failed, and absent deliveries remain dispatchable', () => {
    for (const status of ['delivered', 'failed', 'pending', undefined] as const) {
      const result = resolvePairDispatchEligibility({ deliveryStatus: status });
      assert.strictEqual(result.eligible, true, `status '${status}' must remain dispatchable`);
      assert.strictEqual(result.ambiguous, false);
      assert.strictEqual(result.reason, undefined);
    }
  });
});

/* ======================================================================== *
 * Renderer wiring — no actionable dispatch when blocked, recovery path shown
 * ======================================================================== */
describe('PairView dispatch action respects the delivery state', () => {
  it('gates the dispatch button on the eligibility projection (no independent rule)', () => {
    assert.match(pairViewSource, /import \{ resolvePairDispatchEligibility \} from '\.\/pairDispatchEligibility\.ts'/);
    assert.match(pairViewSource, /const dispatchEligibility = resolvePairDispatchEligibility\(pair\)/);
    assert.match(pairViewSource, /!dispatchEligibility\.eligible/);
  });

  it('does not offer another dispatch for an ambiguous delivery — it surfaces Attention & Recovery', () => {
    // The recovery affordance is gated on the ambiguous flag.
    assert.match(pairViewSource, /dispatchEligibility\.ambiguous && \(/);
    assert.match(pairViewSource, /onOpenAttentionRecovery\?\.\(\)/);
    assert.match(pairViewSource, /Reconcile in Attention &amp; Recovery/);
  });

  it('dispatch still flows only through the injected handler, not a direct IPC call', () => {
    assert.match(pairViewSource, /onClick=\{\(\) => onDispatchAssignment\(pair\.id\)\}/);
    assert.doesNotMatch(pairViewSource, /relayBridge\.dispatchAssignment/);
    // App injects the handler; the disabled attribute is what prevents the call.
    assert.match(appSource, /onDispatchAssignment=\{handleDispatchPair\}/);
    assert.match(appSource, /onOpenAttentionRecovery=\{\(\) => setActiveTab\('attention'\)\}/);
  });

  it('the reason is surfaced to the operator when a dispatch is blocked', () => {
    assert.match(pairViewSource, /!dispatchEligibility\.eligible && dispatchEligibility\.reason/);
  });
});

/* ======================================================================== *
 * Backend guard is UNCHANGED (and still the authority)
 * ======================================================================== */
describe('backend ambiguous-resend guard remains unchanged', () => {
  it('the engine still refuses ambiguous and in-flight deliveries before any send', () => {
    assert.match(engineSource, /throw new AmbiguousDeliveryResendError\(/);
    assert.match(engineSource, /const ambiguousDelivery = existingDeliveries\.find\(\(d\) => d\.status === 'ambiguous'\)/);
    assert.match(engineSource, /throw new DuplicateDeliveryAttemptError\(/);
    assert.match(engineSource, /const activeDelivery = existingDeliveries\.find\(\(d\) => d\.status === 'delivering'\)/);
  });
});

/* ======================================================================== *
 * Behavioural: the guard still rejects resend; authorized dispatch still works
 * ======================================================================== */
describe('dispatch behaviour with the unchanged engine guard', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;
  let workerProvider: MockProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    service = new RelayApiService(db, engine);
    engine.registerProvider(new MockProvider('chatgpt'));
    workerProvider = new MockProvider('opencode');
    engine.registerProvider(workerProvider);
  });

  async function activePair(name: string) {
    const project = await engine.createProject(`${name} Project`);

    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'chatgpt',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ses_planner_dispatch_ui',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const worker = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ses_worker_dispatch_ui',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    for (const [i, s] of [planner, worker].entries()) {
      await db.associations.save(
        new RuntimeProjectAssociation({
          id: `assoc_dispatch_ui_${name}_${i}` as any,
          runtimeSessionId: s.id,
          projectId: project.id,
          providerType: s.providerType,
          externalSessionId: s.externalSessionId ?? '',
          verificationState: 'verified',
          provenance: 'setup',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    }

    const pair = await engine.createPair(project.id, name, planner.id, worker.id);
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    return pair;
  }

  it('an authorized (delivered) dispatch remains available', async () => {
    const pair = await activePair('Authorized');
    workerProvider.deliveryOutcome = 'delivered';
    const assignment = await service.createAssignment(pair.id, 'Normal', 'do normal work');

    const result = await service.dispatchAssignment(assignment.id);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deliveryOutcome, 'delivered');
    db.close();
  });

  it('an AMBIGUOUS delivery blocks the resend and reports the guard error', async () => {
    const pair = await activePair('Ambiguous');
    workerProvider.deliveryOutcome = 'ambiguous';
    const assignment = await service.createAssignment(pair.id, 'Ambiguous', 'do ambiguous work');

    await service.dispatchAssignment(assignment.id);
    const deliveries = await db.deliveries.findByAssignmentId(assignment.id as any);
    assert.strictEqual(deliveries.length, 1);
    assert.strictEqual(deliveries[0].status, 'ambiguous');

    // The UI projection agrees with the backend: this state is not dispatchable.
    assert.strictEqual(resolvePairDispatchEligibility({ deliveryStatus: 'ambiguous' }).eligible, false);

    await assert.rejects(
      async () => service.dispatchAssignment(assignment.id),
      (err: any) => {
        assert.ok(err instanceof AmbiguousDeliveryResendError, `expected the ambiguous-resend guard, got ${String(err)}`);
        assert.strictEqual(err.code, 'AMBIGUOUS_DELIVERY_RESEND_BLOCKED');
        return true;
      },
      'the backend guard must remain the authority and refuse the resend',
    );

    // No second delivery was created.
    assert.strictEqual((await db.deliveries.findByAssignmentId(assignment.id as any)).length, 1);
    db.close();
  });
});
