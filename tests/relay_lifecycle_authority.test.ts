/**
 * Relay Lifecycle Authority Tests
 *
 * Proves:
 * 1. Durable relay state: STOPPED | RUNNING | PAUSED.
 * 2. Automated provider contact requires relayState === RUNNING and operationalState === ACTIVE.
 * 3. Start, Pause, Resume, and Stop enforce semantics consistently.
 * 4. PAUSED and STOPPED cause zero automated provider contact (zero provider calls during supervision tick).
 * 5. All Pair/session/Assignment/checkpoint state is fully preserved across Pause and Stop.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import {
  Pair,
  Assignment,
  Attempt,
  Project,
  RuntimeSession,
} from '../src/relay/domain/entities.ts';
import {
  PAIR_RELAY_STATES,
  DEFAULT_PAIR_RELAY_STATE,
  isPairRelayState,
  PairId,
  ProjectId,
  RuntimeSessionId,
  ProviderType,
} from '../src/relay/domain/types.ts';
import { MockProvider } from './MockProvider.ts';

class CountingProvider extends MockProvider {
  public readonly calls: string[] = [];

  constructor(providerType: ProviderType = 'opencode') {
    super(providerType);
  }

  get totalCalls(): number {
    return this.calls.length;
  }

  reset(): void {
    this.calls.length = 0;
  }

  async inspectRuntime(id: RuntimeSessionId): Promise<any> {
    this.calls.push('inspectRuntime');
    return super.inspectRuntime(id);
  }
}

describe('Relay Lifecycle Authority (STOPPED | RUNNING | PAUSED)', () => {
  it('defines exactly three relay states and correct default', () => {
    assert.deepStrictEqual([...PAIR_RELAY_STATES], ['STOPPED', 'RUNNING', 'PAUSED']);
    assert.strictEqual(DEFAULT_PAIR_RELAY_STATE, 'STOPPED');
    assert.strictEqual(isPairRelayState('STOPPED'), true);
    assert.strictEqual(isPairRelayState('RUNNING'), true);
    assert.strictEqual(isPairRelayState('PAUSED'), true);
    assert.strictEqual(isPairRelayState('INVALID'), false);
  });

  it('newly created pair defaults to relayState STOPPED and operationalState IDLE', () => {
    const pair = Pair.create('proj_1' as ProjectId, 'Test Pair');
    assert.strictEqual(pair.relayState, 'STOPPED');
    assert.strictEqual(pair.operationalState, 'IDLE');
    assert.strictEqual(pair.isAutomatedContactPermitted(), false);
  });

  it('Start, Pause, Resume, and Stop transition relayState correctly while preserving state', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const project = Project.create('Proj 1', '', '/path/1', '/path/1');
    await db.projects.save(project);

    const planner = RuntimeSession.create('chatgpt', 'Planner');
    const worker = RuntimeSession.create('opencode', 'Worker');
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);

    const pair = Pair.create(project.id, 'Pair 1', planner.id, worker.id);
    await db.pairs.save(pair);

    // Grant ACTIVE (Load & Activate simulation)
    pair.makeActive('load_and_activate');
    await db.pairs.save(pair);
    assert.strictEqual(pair.operationalState, 'ACTIVE');

    // 1. Start Pair
    const started = await engine.startPair(pair.id);
    assert.strictEqual(started.relayState, 'RUNNING');
    assert.strictEqual(started.operationalState, 'ACTIVE');
    assert.strictEqual(started.isAutomatedContactPermitted(), true);

    // 2. Pause Pair (state preserved)
    const paused = await engine.pausePair(pair.id);
    assert.strictEqual(paused.relayState, 'PAUSED');
    assert.strictEqual(paused.isAutomatedContactPermitted(), false);
    assert.strictEqual(paused.plannerSessionId, planner.id);
    assert.strictEqual(paused.workerSessionId, worker.id);

    // 3. Resume Pair
    const resumed = await engine.resumePair(pair.id);
    assert.strictEqual(resumed.relayState, 'RUNNING');
    assert.strictEqual(resumed.isAutomatedContactPermitted(), true);

    // 4. Stop Pair (state preserved, NOT clearing active assignments/sessions)
    const assignment = Assignment.create(pair.id, project.id, 'Task 1', 'Do work');
    pair.assignWork(assignment.id);
    await db.assignments.save(assignment);
    await db.pairs.save(pair);

    const stopped = await engine.stopPair(pair.id);
    assert.strictEqual(stopped.relayState, 'STOPPED');
    assert.strictEqual(stopped.isAutomatedContactPermitted(), false);
    // Verify state preservation across stop
    assert.strictEqual(stopped.activeAssignmentId, assignment.id);
    assert.strictEqual(stopped.plannerSessionId, planner.id);
    assert.strictEqual(stopped.workerSessionId, worker.id);
  });

  it('PAUSED and STOPPED cause zero automated provider contact during supervision tick', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const countingProvider = new CountingProvider('opencode');
    engine.registerProvider(countingProvider);

    const project = Project.create('Proj 2', '', '/path/2', '/path/2');
    await db.projects.save(project);

    const worker = RuntimeSession.create('opencode', 'Worker 2');
    await db.runtimes.save(worker);

    const pair = Pair.create(project.id, 'Pair 2', undefined, worker.id);
    pair.makeActive('active');
    await db.pairs.save(pair);

    const assignment = Assignment.create(pair.id, project.id, 'Task 2', 'Instructions');
    const attempt = Attempt.create(assignment.id, 1, {
      sessionPairId: pair.id,
      workerSessionId: worker.id,
      externalSessionId: worker.externalSessionId ?? null,
    });
    assignment.startAttempt(attempt);
    pair.assignWork(assignment.id);
    await db.assignments.save(assignment);
    await db.attempts.save(attempt);
    await db.pairs.save(pair);

    // Case A: STOPPED (default)
    assert.strictEqual(pair.relayState, 'STOPPED');
    countingProvider.reset();
    await engine.runSupervisionTick();
    assert.strictEqual(countingProvider.totalCalls, 0, 'STOPPED pair must make zero provider contact');

    // Case B: PAUSED
    pair.pauseRelay();
    await db.pairs.save(pair);
    countingProvider.reset();
    await engine.runSupervisionTick();
    assert.strictEqual(countingProvider.totalCalls, 0, 'PAUSED pair must make zero provider contact');

    // Case C: RUNNING + ACTIVE -> makes contact
    pair.startRelay();
    await db.pairs.save(pair);
    countingProvider.reset();
    await engine.runSupervisionTick();
    assert.strictEqual(countingProvider.totalCalls > 0, true, 'RUNNING & ACTIVE pair permits automated contact');
  });
});
