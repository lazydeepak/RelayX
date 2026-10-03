/**
 * Phase E — Exact Worker Transport Tests
 *
 * Verifies that worker instruction dispatch targets the authoritative bound
 * worker session ID with evidence and respects operational state gates (I-2).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import { Project, Pair, RuntimeSession } from '../src/relay/domain/entities.ts';
import { ProjectId, PairId, RuntimeSessionId, createId } from '../src/relay/domain/types.ts';

class InspectTrackingProvider extends MockProvider {
  public dispatchedRequests: Array<{ runtimeSessionId: RuntimeSessionId; text: string; idempotencyKey: string }> = [];

  constructor() {
    super('opencode');
  }

  override async deliverInstruction(req: { runtimeSessionId: RuntimeSessionId; instructionText: string; idempotencyKey: string }) {
    this.dispatchedRequests.push({
      runtimeSessionId: req.runtimeSessionId,
      text: req.instructionText,
      idempotencyKey: req.idempotencyKey,
    });
    return super.deliverInstruction(req);
  }
}

describe('Phase E — Exact Worker Transport', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let provider: InspectTrackingProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    provider = new InspectTrackingProvider();
    engine.registerProvider(provider);
    engine.registerProvider(new MockProvider('chatgpt'));
  });

  async function createPairFixture(operationalState: 'IDLE' | 'ACTIVE' = 'IDLE') {
    const project = new Project({
      id: createId<ProjectId>('proj'),
      name: 'Test Project',
      description: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.projects.save(project);

    const plannerSession = new RuntimeSession({
      id: createId<RuntimeSessionId>('sess'),
      providerType: 'chatgpt',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ext_planner',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const workerSession = new RuntimeSession({
      id: createId<RuntimeSessionId>('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ext_worker',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await db.runtimes.save(plannerSession);
    await db.runtimes.save(workerSession);

    const pair = new Pair({
      id: createId<PairId>('pair'),
      projectId: project.id,
      name: 'Test Pair',
      plannerSessionId: plannerSession.id,
      workerSessionId: workerSession.id,
      status: operationalState === 'ACTIVE' ? 'active' : 'idle',
      operationalState,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.pairs.save(pair);

    return { project, plannerSession, workerSession, pair };
  }

  it('E1: dispatch fails when Pair is IDLE (I-2 gate)', async () => {
    const { pair } = await createPairFixture('IDLE');
    const assignment = await engine.createAssignment(pair.id, 'Task 1', 'Do work');

    await assert.rejects(async () => {
      await engine.dispatchAssignment(assignment.id);
    }, /Pair is IDLE/);

    assert.strictEqual(provider.dispatchedRequests.length, 0);
  });

  it('E2: ACTIVE pair successfully delivers instruction to exact bound worker session with evidence', async () => {
    const { pair, workerSession } = await createPairFixture('ACTIVE');

    const assignment = await engine.createAssignment(pair.id, 'Task 2', 'Implement feature X');
    const { delivery, attempt } = await engine.dispatchAssignment(assignment.id);

    assert.strictEqual(provider.dispatchedRequests.length, 1);
    assert.strictEqual(provider.dispatchedRequests[0].runtimeSessionId, workerSession.id);
    assert.strictEqual(provider.dispatchedRequests[0].text, 'Implement feature X');
    assert.strictEqual(delivery.status, 'delivered');
    assert.ok(delivery.evidence);
    assert.strictEqual(attempt.status, 'prepared');
  });
});
