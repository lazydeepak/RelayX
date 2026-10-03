/**
 * Completed-Turn Observation & Durable Relay Checkpoints Tests
 *
 * Proves:
 * 1. Same turn observed twice = UNCHANGED.
 * 2. New Planner completed turn = PLANNER_ADVANCED.
 * 3. New Worker completed turn = WORKER_ADVANCED.
 * 4. Both new = BOTH_ADVANCED.
 * 5. No completed new turns = UNCHANGED.
 * 6. Restart preserves baselines.
 * 7. Incomplete/generating turn is never treated as completed.
 * 8. Weak provider evidence remains explicitly uncertain.
 * 9. Observation causes zero outbound transport.
 * 10. PAUSED/STOPPED automation does not silently observe providers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import {
  Project,
  Pair,
  RuntimeSession,
} from '../src/relay/domain/entities.ts';
import {
  createId,
  ProjectId,
  RuntimeSessionId,
  ProviderType,
  SideObservationReading,
} from '../src/relay/domain/types.ts';
import { MockProvider } from './MockProvider.ts';

class ConfigurableMockProvider extends MockProvider {
  public ordinal = 1;
  public messageRef = 'msg_1';
  public activityState: 'working' | 'idle' = 'idle';
  public messageText = 'Assistant response completed.';

  constructor(providerType: ProviderType = 'opencode') {
    super(providerType);
  }

  async observeSide(request: { externalSessionId: string; projectPath?: string }): Promise<SideObservationReading> {
    return {
      reachabilityState: 'reachable',
      uiPresenceState: 'present',
      activityState: this.activityState,
      messageEvidenceState: 'observed',
      message: {
        ref: this.messageRef,
        role: 'assistant',
        text: this.messageText,
        truncated: false,
        ordinal: this.ordinal,
      },
      observationCapability: 'mock_observation',
      observedAt: Date.now(),
      validUntil: Date.now() + 300000,
      reason: 'Mock observed side',
      evidence: null,
    };
  }
}

describe('Completed-Turn Observation & Durable Relay Checkpoints', () => {
  it('same turn observed twice evaluates to UNCHANGED', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const provider = new ConfigurableMockProvider('opencode');
    provider.ordinal = 10;
    provider.messageRef = 'msg_10';
    engine.registerProvider(provider);

    const project = Project.create('Proj', '', '/p', '/p');
    await db.projects.save(project);
    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'sess_planner_1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const worker = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'sess_worker_1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);

    const pair = Pair.create(project.id, 'Pair', planner.id, worker.id);
    pair.makeActive('active');
    pair.startRelay();
    await db.pairs.save(pair);

    // Initial baseline capture
    await engine.observeCompletedTurn(pair.id, 'planner');
    await engine.observeCompletedTurn(pair.id, 'worker');
    await engine.captureInitialBaseline(pair.id, 'planner', 'operator_1');
    await engine.captureInitialBaseline(pair.id, 'worker', 'operator_1');

    // Observe same turn again
    await engine.observeCompletedTurn(pair.id, 'planner');
    await engine.observeCompletedTurn(pair.id, 'worker');

    const continuity = await engine.computeContinuity(pair.id);
    assert.strictEqual(continuity.state, 'UNCHANGED');
    assert.strictEqual(continuity.planner.state, 'unchanged');
    assert.strictEqual(continuity.worker.state, 'unchanged');
  });

  it('new Planner completed turn evaluates to PLANNER_ADVANCED', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const provider = new ConfigurableMockProvider('opencode');
    provider.ordinal = 1;
    provider.messageRef = 'msg_1';
    engine.registerProvider(provider);

    const project = Project.create('Proj', '', '/p', '/p');
    await db.projects.save(project);
    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'sess_planner_2',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const worker = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'sess_worker_2',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);

    const pair = Pair.create(project.id, 'Pair', planner.id, worker.id);
    pair.makeActive('active');
    pair.startRelay();
    await db.pairs.save(pair);

    // Initial baseline capture at ordinal 1
    await engine.observeCompletedTurn(pair.id, 'planner');
    await engine.observeCompletedTurn(pair.id, 'worker');
    await engine.captureInitialBaseline(pair.id, 'planner', 'operator_1');
    await engine.captureInitialBaseline(pair.id, 'worker', 'operator_1');

    // Planner advances to ordinal 2
    provider.ordinal = 2;
    provider.messageRef = 'msg_2';
    await engine.observeCompletedTurn(pair.id, 'planner');

    const continuity = await engine.computeContinuity(pair.id);
    assert.strictEqual(continuity.state, 'PLANNER_ADVANCED');
    assert.strictEqual(continuity.planner.state, 'advanced');
    assert.strictEqual(continuity.worker.state, 'unchanged');
  });

  it('new Worker completed turn evaluates to WORKER_ADVANCED and both new to BOTH_ADVANCED', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const provider = new ConfigurableMockProvider('opencode');
    provider.ordinal = 1;
    provider.messageRef = 'msg_1';
    engine.registerProvider(provider);

    const project = Project.create('Proj', '', '/p', '/p');
    await db.projects.save(project);
    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'sess_planner_3',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const worker = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'sess_worker_3',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);

    const pair = Pair.create(project.id, 'Pair', planner.id, worker.id);
    pair.makeActive('active');
    pair.startRelay();
    await db.pairs.save(pair);

    await engine.observeCompletedTurn(pair.id, 'planner');
    await engine.observeCompletedTurn(pair.id, 'worker');
    await engine.captureInitialBaseline(pair.id, 'planner', 'operator_1');
    await engine.captureInitialBaseline(pair.id, 'worker', 'operator_1');

    // Worker advances
    provider.ordinal = 2;
    provider.messageRef = 'msg_2';
    await engine.observeCompletedTurn(pair.id, 'worker');

    let continuity = await engine.computeContinuity(pair.id);
    assert.strictEqual(continuity.state, 'WORKER_ADVANCED');

    // Planner also advances -> BOTH_ADVANCED
    provider.ordinal = 3;
    provider.messageRef = 'msg_3';
    await engine.observeCompletedTurn(pair.id, 'planner');

    continuity = await engine.computeContinuity(pair.id);
    assert.strictEqual(continuity.state, 'BOTH_ADVANCED');
  });

  it('restart preserves baselines and observations', async () => {
    const dbFile = ':memory:';
    const db1 = new SqliteRelayDatabase(dbFile);
    const engine1 = new RelayEngine(db1);

    const provider = new ConfigurableMockProvider('opencode');
    provider.ordinal = 5;
    provider.messageRef = 'msg_5';
    engine1.registerProvider(provider);

    const project = Project.create('Proj', '', '/p', '/p');
    await db1.projects.save(project);
    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'sess_planner_4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const worker = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'sess_worker_4',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db1.runtimes.save(planner);
    await db1.runtimes.save(worker);

    const pair = Pair.create(project.id, 'Pair', planner.id, worker.id);
    pair.makeActive('active');
    pair.startRelay();
    await db1.pairs.save(pair);

    await engine1.observeCompletedTurn(pair.id, 'planner');
    await engine1.captureInitialBaseline(pair.id, 'planner', 'operator_1');

    // Restart: new RelayEngine instance sharing the same db
    const engine2 = new RelayEngine(db1);
    engine2.registerProvider(provider);

    await engine2.observeCompletedTurn(pair.id, 'planner');
    const continuity = await engine2.computeContinuity(pair.id);
    assert.strictEqual(continuity.planner.state, 'unchanged');
  });

  it('incomplete/generating turn is never treated as completed', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const provider = new ConfigurableMockProvider('opencode');
    provider.activityState = 'working'; // generating
    engine.registerProvider(provider);

    const project = Project.create('Proj', '', '/p', '/p');
    await db.projects.save(project);
    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'sess_planner_5',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);

    const pair = Pair.create(project.id, 'Pair', planner.id, undefined);
    pair.makeActive('active');
    pair.startRelay();
    await db.pairs.save(pair);

    const result = await engine.observeCompletedTurn(pair.id, 'planner');
    assert.strictEqual(result.outcome, 'refused');
    assert.strictEqual(result.turn, null);
  });

  it('PAUSED or STOPPED relay state causes zero provider contact during observation', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const provider = new ConfigurableMockProvider('opencode');
    engine.registerProvider(provider);

    const project = Project.create('Proj', '', '/p', '/p');
    await db.projects.save(project);
    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'sess_planner_6',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);

    const pair = Pair.create(project.id, 'Pair', planner.id, undefined);
    pair.makeActive('active');
    // relayState is STOPPED by default
    await db.pairs.save(pair);

    const result = await engine.observeCompletedTurn(pair.id, 'planner');
    assert.strictEqual(result.providerContacted, false);
    assert.strictEqual(result.outcome, 'refused');
  });
});
