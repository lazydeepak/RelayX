/**
 * Focused service regression for the recovery-button fix at the service boundary.
 *
 * RelayApiService.listAttentionItems must expose the ID of the delivery actually
 * marked `ambiguous` for an assignment — never the assignment ID and never an
 * unrelated (non-ambiguous) delivery of the same assignment. When no delivery of
 * the assignment is ambiguous, recovery must be left unavailable (no deliveryId).
 *
 * This test only seeds fixtures and reads via listAttentionItems; it never calls
 * resolveAmbiguousDelivery / dispatchAssignment, so no delivery state is altered.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import {
  Attempt,
  AttentionItem,
  Delivery,
} from '../src/relay/domain/entities.ts';
import { OpenCodeProvider } from '../src/relay/providers/adapters.ts';
import { recoveryDeliveryArgument } from '../src/components/attentionRecoveryModels.ts';

describe('service boundary: ambiguous delivery selection for recovery', () => {
  const makeContext = () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new OpenCodeProvider());
    const api = new RelayApiService(db, engine);
    return { db, engine, api };
  };

  it('exposes exactly the ambiguous delivery ID, and leaves recovery unavailable when none exists', async () => {
    // --- Scenario A: assignment with two deliveries, only one ambiguous ---
    const { db: dbA, engine: engineA, api: apiA } = makeContext();

    const workerA = await engineA.registerRuntimeSession('opencode', 'Worker');
    const assignmentA = await engineA.createAssignment(
      (await seedPair(engineA, 'Proj A')).id,
      'Ambiguous assignment',
      'Deliver this twice',
    );

    const attemptA = Attempt.create(assignmentA.id, 1);
    await dbA.attempts.save(attemptA);

    const deliveredA = Delivery.create(
      assignmentA.id,
      attemptA.id,
      workerA.id,
      'first attempt',
      `idemp_${assignmentA.id}_1`,
    );
    deliveredA.confirmDelivered({
      id: 'ev_fixture_1',
      timestamp: Date.now(),
      source: 'reconciliation_probe',
    });
    await dbA.deliveries.save(deliveredA);

    const ambiguousA = Delivery.create(
      assignmentA.id,
      attemptA.id,
      workerA.id,
      'second attempt',
      `idemp_${assignmentA.id}_2`,
    );
    ambiguousA.markAmbiguous('Could not verify whether instruction was received');
    await dbA.deliveries.save(ambiguousA);

    const attentionA = AttentionItem.create(
      'critical',
      'ambiguous_delivery',
      'Ambiguous Delivery Pending Resolution',
      `Delivery ${ambiguousA.id} is ambiguous. Operator intervention or recovery is required.`,
      { assignmentId: assignmentA.id },
    );
    await dbA.attention.save(attentionA);

    const itemsA = await apiA.listAttentionItems();
    const itemA = itemsA.find((i) => i.id === attentionA.id);
    assert.ok(itemA, 'attention item must be listed');
    assert.strictEqual(itemA.deliveryId, ambiguousA.id, 'must expose the ambiguous delivery ID');
    assert.notStrictEqual(itemA.deliveryId, assignmentA.id, 'must never substitute the assignment ID');
    assert.notStrictEqual(itemA.deliveryId, deliveredA.id, 'must never substitute a non-ambiguous delivery');

    // --- Scenario B: same assignment shape but no ambiguous delivery ---
    const { db: dbB, engine: engineB, api: apiB } = makeContext();

    const workerB = await engineB.registerRuntimeSession('opencode', 'Worker');
    const assignmentB = await engineB.createAssignment(
      (await seedPair(engineB, 'Proj B')).id,
      'Clean assignment',
      'Deliver once',
    );

    const attemptB = Attempt.create(assignmentB.id, 1);
    await dbB.attempts.save(attemptB);

    const deliveredB = Delivery.create(
      assignmentB.id,
      attemptB.id,
      workerB.id,
      'only attempt',
      `idemp_${assignmentB.id}_1`,
    );
    deliveredB.confirmDelivered({
      id: 'ev_fixture_2',
      timestamp: Date.now(),
      source: 'reconciliation_probe',
    });
    await dbB.deliveries.save(deliveredB);

    const attentionB = AttentionItem.create(
      'critical',
      'ambiguous_delivery',
      'Ambiguous Delivery Pending Resolution',
      'Delivery is ambiguous.',
      { assignmentId: assignmentB.id },
    );
    await dbB.attention.save(attentionB);

    const itemsB = await apiB.listAttentionItems();
    const itemB = itemsB.find((i) => i.id === attentionB.id);
    assert.ok(itemB, 'attention item must be listed');
    assert.strictEqual(itemB.deliveryId, undefined, 'no ambiguous delivery -> no delivery ID');
    assert.strictEqual(
      recoveryDeliveryArgument(itemB),
      '',
      'recovery button argument must be empty -> recovery unavailable',
    );
  });
});

/** Creates a project + planner + worker + pair through the engine, returning the pair. */
async function seedPair(engine: RelayEngine, projectName: string) {
  const project = await engine.createProject(projectName);
  const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
  const worker = await engine.registerRuntimeSession('opencode', 'Worker');
  return engine.createPair(project.id, 'Pair 1', planner.id, worker.id);
}