/**
 * Execution-slot invariant — one Pair, at most one unresolved Assignment.
 *
 * ## The defect this exists to prevent
 *
 * `Pair.activeAssignmentId` is the Pair's single execution slot, and `Pair.assignWork()` is an
 * UNCONDITIONAL setter. Nothing stopped dispatch B from overwriting the slot while dispatch
 * A's Assignment was still `active`. The resulting state was invisible and unrecoverable from
 * the data alone:
 *
 *   - Assignment A: `status = active`, `currentAttemptId = <its own attempt>`
 *   - Pair:         `activeAssignment_id = B`
 *
 * A still believed it owned the work and still reported itself active; the Pair pointed at
 * B. Six such stale `pending` Assignments had already accumulated on one production Pair.
 *
 * ## Why the test goes through RelayApiService, not RelayEngine
 *
 * An invariant enforced only inside the engine is enforced only for callers that route
 * through the engine. The UI, the IPC bridge, and any future automation all reach the engine
 * through the service, so the service is the real attack surface — and a check that passes
 * there is a check that cannot be bypassed by a direct service/API caller. The other
 * regression below goes straight at the engine to prove the rule is not a service-layer
 * decoration.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { MockProvider } from './MockProvider.ts';
import { RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { AssociationId, AssignmentId, createId } from '../src/relay/domain/types.ts';

describe('Execution-slot invariant — a Pair has at most one unresolved active Assignment', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;
  let workerProvider: MockProvider;

  beforeEach(async () => {
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
      externalSessionId: 'ses_planner_slot',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const worker = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ses_worker_slot',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    for (const [i, s] of [planner, worker].entries()) {
      await db.associations.save(
        new RuntimeProjectAssociation({
          id: `assoc_${name}_${i}` as AssociationId,
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

  /* ---------------------------------------------------------------------- */

  it('a DIRECT SERVICE CALLER cannot orphan an active Assignment', async () => {
    const pair = await activePair('Direct Service Caller');

    // 1. First Assignment is dispatched through the service and takes the slot.
    const a = await service.createAssignment(pair.id, 'A', 'do A');
    const first = await service.dispatchAssignment(a.id);
    assert.strictEqual(first.deliveryOutcome, 'delivered');

    const heldByA = await db.pairs.findById(pair.id);
    assert.strictEqual(heldByA?.activeAssignmentId, a.id, 'A holds the execution slot');

    // 2. A second Assignment is dispatched by the same direct service caller.
    const b = await service.createAssignment(pair.id, 'B', 'do B');
    await assert.rejects(
      async () => service.dispatchAssignment(b.id),
      (err: any) => {
        assert.strictEqual(err.code, 'PAIR_ACTIVE_ASSIGNMENT_EXISTS');
        assert.ok(err.message.includes(a.id), 'the message names the Assignment that holds the slot');
        return true;
      },
      'the service path must refuse to steal an unresolved Assignment execution slot',
    );

    // 3. Nothing moved. The refusal is a refusal, not a partial application.
    const after = await db.pairs.findById(pair.id);
    assert.strictEqual(after?.activeAssignmentId, a.id, 'the slot is unchanged');

    const bPersisted = await db.assignments.findById(b.id as AssignmentId);
    assert.strictEqual(bPersisted?.status, 'pending', 'the refused Assignment was not silently advanced');
    assert.strictEqual(bPersisted?.currentAttemptId, undefined, 'and no Attempt was minted for it');

    assert.deepStrictEqual(
      await db.attempts.findByAssignmentId(b.id as AssignmentId),
      [],
      'a refused dispatch leaves no Attempt record at all',
    );
  });

  it('the engine enforces the same rule directly, so it is not a service-layer decoration', async () => {
    const pair = await activePair('Direct Engine Caller');

    const a = await engine.createAssignment(pair.id, 'A', 'do A');
    await engine.dispatchAssignment(a.id);

    const b = await engine.createAssignment(pair.id, 'B', 'do B');
    await assert.rejects(
      async () => engine.dispatchAssignment(b.id),
      (err: any) => err.code === 'PAIR_ACTIVE_ASSIGNMENT_EXISTS',
    );
  });

  it('re-dispatching the SAME Assignment is always allowed — the slot is already its own', async () => {
    // A Pair has one slot, not one dispatch. Retrying through the existing lifecycle is the
    // legitimate path, and an invariant that blocked it would strand failed work forever.
    const pair = await activePair('Same Assignment Retry');
    const a = await service.createAssignment(pair.id, 'A', 'do A');
    await service.dispatchAssignment(a.id);

    // The first Delivery is left `delivering`, which is what a real in-flight send looks
    // like; the duplicate-delivery guard refuses first, proving the slot did not shadow it.
    const d = (await db.deliveries.findByAssignmentId(a.id as AssignmentId))[0]!;
    d.status = 'delivering';
    await db.deliveries.save(d);

    await assert.rejects(async () => service.dispatchAssignment(a.id), (err: any) =>
      err.code === 'DUPLICATE_DELIVERY_ATTEMPT',
    );

    // Releasing the in-flight Delivery lets the retry through, and the slot is still A's.
    d.status = 'failed';
    await db.deliveries.save(d);
    workerProvider.deliveryOutcome = 'delivered';
    const retry = await service.dispatchAssignment(a.id);
    assert.strictEqual(retry.deliveryOutcome, 'delivered');
    assert.strictEqual((await db.pairs.findById(pair.id))?.activeAssignmentId, a.id);
  });

  it('a TERMINAL Assignment still holding the slot is released explicitly, with an event', async () => {
    // `completeAssignment` clears the slot as part of the normal lifecycle, so this state is
    // only reachable from legacy data or a manual edit. It is exactly the state a naive
    // "refuse if anything holds the slot" rule would deadlock on forever, so the repair
    // matters: release the slot, say so in the event stream, and let new work proceed.
    const pair = await activePair('Terminal Holder');
    const a = await engine.createAssignment(pair.id, 'A', 'do A');
    await engine.dispatchAssignment(a.id);
    await engine.completeAssignment(a.id);

    // Re-point the slot at the now-completed Assignment: a stale ownership claim.
    const stale = await db.pairs.findById(pair.id);
    stale!.activeAssignmentId = a.id;
    await db.pairs.save(stale!);

    const b = await service.createAssignment(pair.id, 'B', 'do B');
    const events = await db.events.findRecent(200);
    assert.ok(
      events.some((e) => e.eventType === 'pair.assignment_slot_released'),
      'releasing a terminal slot is recorded, not silent',
    );
    const released = events.find((e) => e.eventType === 'pair.assignment_slot_released')!;
    assert.ok(
      String(released.details?.releasedAssignmentId) === a.id,
      'the event names which Assignment lost the slot',
    );

    assert.strictEqual((await service.dispatchAssignment(b.id)).deliveryOutcome, 'delivered');
    assert.strictEqual((await db.pairs.findById(pair.id))?.activeAssignmentId, b.id);
  });

  it('reconcilePairAssignmentAuthority cancels every unresolved Assignment except the real holder', async () => {
    // Reproduces the production state directly: several `pending` Assignments plus one real
    // holder, all unresolved. The repair must keep the holder and transition the rest, with a
    // reason — and must be idempotent.
    const pair = await activePair('Reconcile Authority');
    const a = await engine.createAssignment(pair.id, 'A', 'do A');
    await engine.dispatchAssignment(a.id);
    const orphans = [
      await engine.createAssignment(pair.id, 'orphan 1', 'never dispatched'),
      await engine.createAssignment(pair.id, 'orphan 2', 'never dispatched'),
    ];

    // Force the corrupt state the old unguarded setter produced: both orphans `pending`, the
    // Pair pointing at A, and A already `active` — i.e. two claimants, one slot.
    assert.strictEqual((await db.pairs.findById(pair.id))?.activeAssignmentId, a.id);

    const first = await service.reconcilePairAssignmentAuthority(pair.id);
    assert.strictEqual(first.activeAssignmentId, a.id, 'the real holder keeps the slot');
    assert.strictEqual(first.transitions.length, orphans.length, 'both orphans are transitioned');
    for (const o of orphans) {
      const persisted = await db.assignments.findById(o.id);
      assert.strictEqual(persisted?.status, 'cancelled');
      const t = first.transitions.find((x) => x.assignmentId === o.id);
      assert.ok(t?.reason && t.reason.length > 0, 'each transition carries a stated reason');
    }

    // Idempotent: a second run changes nothing, so an operator can re-run it safely.
    const second = await service.reconcilePairAssignmentAuthority(pair.id);
    assert.strictEqual(second.activeAssignmentId, a.id);
    assert.deepStrictEqual(second.transitions, [], 'nothing left to repair');

    // And the recovered Pair can accept new work — but only once the real holder is
    // resolved. `a` is still `active` and still owns the slot, so dispatching `c` now is
    // refused, which is the invariant working rather than the repair having picked a
    // favourite.
    const c = await service.createAssignment(pair.id, 'C', 'do C');
    await assert.rejects(
      async () => service.dispatchAssignment(c.id),
      (err: any) => err.code === 'PAIR_ACTIVE_ASSIGNMENT_EXISTS',
      'the surviving holder is still the owner after the repair',
    );

    await engine.completeAssignment(a.id);
    assert.strictEqual((await service.dispatchAssignment(c.id)).deliveryOutcome, 'delivered');
    assert.strictEqual((await db.pairs.findById(pair.id))?.activeAssignmentId, c.id);
  });

  it('reconcilePairAssignmentAuthority adopts the single survivor when the slot is dangling', async () => {
    const pair = await activePair('Dangling Slot');
    const a = await engine.createAssignment(pair.id, 'A', 'do A');
    await engine.dispatchAssignment(a.id);

    // Point the slot at a record that does not exist: the state a deleted Assignment leaves.
    const broken = await db.pairs.findById(pair.id);
    broken!.activeAssignmentId = 'asgn_does_not_exist' as never;
    await db.pairs.save(broken!);

    const result = await service.reconcilePairAssignmentAuthority(pair.id);
    assert.strictEqual(result.activeAssignmentId, a.id, 'the one real survivor is adopted');

    const events = await db.events.findRecent();
    assert.ok(events.some((e) => e.eventType === 'pair.assignment_slot_released'));
  });

  it('with SEVERAL survivors and no holder, reconciliation refuses to guess', async () => {
    // Promoting the newest would be exactly the silent overwrite the invariant forbids. The
    // operator chooses; RelayX reports the candidates instead.
    const pair = await activePair('Ambiguous Survivors');
    const a = await engine.createAssignment(pair.id, 'A', 'never dispatched A');
    const b = await engine.createAssignment(pair.id, 'B', 'never dispatched B');

    const result = await service.reconcilePairAssignmentAuthority(pair.id);
    assert.strictEqual(result.activeAssignmentId, null, 'no Assignment was adopted');
    assert.deepStrictEqual([...result.unresolvedCandidates].sort(), [a.id, b.id].sort());

    const events = await db.events.findRecent();
    assert.ok(
      events.some((e) => e.eventType === 'pair.assignment_slot_unresolved'),
      'the refusal to guess is itself recorded',
    );
  });
});
