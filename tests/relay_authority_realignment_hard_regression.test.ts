
/**
 * Relay Authority Realignment Hard Regression Proofs
 * 
 * Implements the 7 regression proofs requested in "EXECUTION AUTHORITY REALIGNMENT — IMPLEMENTATION".
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

  async observeSide(args: any): Promise<any> {
    this.calls.push('observeSide');
    return super.observeSide(args);
  }

  async deliverInstruction(args: any): Promise<any> {
    this.calls.push('deliverInstruction');
    return super.deliverInstruction(args);
  }
}

describe('Relay Authority Realignment Hard Regression Proofs', () => {
  async function setup() {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    
    const project = Project.create('Proof Project' as any, '', '/path', '/path', 'g-p-123', '/path');
    await db.projects.save(project);

    const planner = RuntimeSession.create('chatgpt', 'Planner');
    planner.updateExternalIdentity('conv_1', 'g-p-123', 'https://chatgpt.com/g/g-p-123/c/conv_1');
    const worker = RuntimeSession.create('opencode', 'Worker');
    worker.updateExternalIdentity('ses_1', '/path', '/path');
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);

    const pair = Pair.create(project.id, 'Proof Pair', planner.id, worker.id);
    await db.pairs.save(pair);

    const countingPlanner = new CountingProvider('chatgpt');
    const countingWorker = new CountingProvider('opencode');
    engine.registerProvider(countingPlanner);
    engine.registerProvider(countingWorker);

    return { db, engine, project, pair, planner, worker, countingPlanner, countingWorker };
  }

  it('Proof 1: loadAndActivate() => ACTIVE + STOPPED => zero background provider contact', async () => {
    const { engine, pair, countingPlanner, countingWorker } = await setup();
    
    // loadAndActivate verification is a special authority (permitted while IDLE)
    const result = await engine.loadAndActivate(pair.id);
    assert.strictEqual(result.outcome, 'activated');
    
    const updatedPair = await engine.repos.pairs.findById(pair.id);
    assert.strictEqual(updatedPair?.operationalState, 'ACTIVE');
    assert.strictEqual(updatedPair?.relayState, 'STOPPED');
    
    countingPlanner.reset();
    countingWorker.reset();
    
    // Background tick while STOPPED must make zero provider contact
    await engine.runSupervisionTick();
    assert.strictEqual(countingPlanner.totalCalls, 0);
    assert.strictEqual(countingWorker.totalCalls, 0);
  });

  it('Proof 2: loadAndActivate() explicit observe/inspect => provider contact allowed', async () => {
    const { engine, pair, countingWorker } = await setup();
    await engine.loadAndActivate(pair.id);
    
    countingWorker.reset();
    // Explicit operator observe (ACTIVE only)
    await engine.observeSide(pair.id, 'worker');
    assert.strictEqual(countingWorker.calls.includes('observeSide'), true, 'Operator observeSide should be allowed for ACTIVE pair');
    
    countingWorker.reset();
    // Explicit operator inspect (ACTIVE only)
    await engine.reconcileAndRecoverRuntime(pair.workerSessionId!);
    assert.strictEqual(countingWorker.calls.includes('inspectRuntime'), true, 'Operator inspectRuntime should be allowed for ACTIVE pair');
  });

  it('Proof 3: loadAndActivate() startPair() background tick => automated provider contact allowed', async () => {
    const { db, engine, pair, countingWorker, worker, project } = await setup();
    await engine.loadAndActivate(pair.id);
    await engine.startPair(pair.id);
    
    const updatedPair = await db.pairs.findById(pair.id);
    assert.strictEqual(updatedPair?.relayState, 'RUNNING');
    
    // Setup an active assignment so supervision tick has work to do
    const assignment = Assignment.create(pair.id, project.id, 'Task', 'Work');
    const attempt = Attempt.create(assignment.id, 1, {
      sessionPairId: pair.id,
      workerSessionId: worker.id,
      externalSessionId: worker.externalSessionId,
    });
    assignment.startAttempt(attempt);
    updatedPair?.assignWork(assignment.id);
    await db.assignments.save(assignment);
    await db.attempts.save(attempt);
    await db.pairs.save(updatedPair!);

    countingWorker.reset();
    await engine.runSupervisionTick();
    assert.strictEqual(countingWorker.totalCalls > 0, true, 'Automated contact should be allowed for ACTIVE+RUNNING pair');
  });

  it('Proof 4: pausePair() explicit operator inspect allowed, background tick forbidden', async () => {
    const { db, engine, pair, countingWorker, worker, project } = await setup();
    await engine.loadAndActivate(pair.id);
    await engine.startPair(pair.id);
    await engine.pausePair(pair.id);
    
    const updatedPair = await db.pairs.findById(pair.id);
    assert.strictEqual(updatedPair?.relayState, 'PAUSED');

    // Operator inspect allowed
    countingWorker.reset();
    await engine.reconcileAndRecoverRuntime(pair.workerSessionId!);
    assert.strictEqual(countingWorker.totalCalls > 0, true);

    // Setup assignment
    const assignment = Assignment.create(pair.id, project.id, 'Task', 'Work');
    const attempt = Attempt.create(assignment.id, 1, {
      sessionPairId: pair.id,
      workerSessionId: worker.id,
      externalSessionId: worker.externalSessionId,
    });
    assignment.startAttempt(attempt);
    updatedPair?.assignWork(assignment.id);
    await db.assignments.save(assignment);
    await db.attempts.save(attempt);
    await db.pairs.save(updatedPair!);

    // Automated contact forbidden
    countingWorker.reset();
    await engine.runSupervisionTick();
    assert.strictEqual(countingWorker.totalCalls, 0, 'Automated contact should be forbidden for PAUSED pair');
  });

  it('Proof 5: stopPair() explicit operator inspect allowed, background tick forbidden', async () => {
    const { db, engine, pair, countingWorker, worker, project } = await setup();
    await engine.loadAndActivate(pair.id);
    await engine.startPair(pair.id);
    await engine.stopPair(pair.id);
    
    const updatedPair = await db.pairs.findById(pair.id);
    assert.strictEqual(updatedPair?.relayState, 'STOPPED');

    // Operator inspect allowed
    countingWorker.reset();
    await engine.reconcileAndRecoverRuntime(pair.workerSessionId!);
    assert.strictEqual(countingWorker.totalCalls > 0, true);

    // Setup assignment
    const assignment = Assignment.create(pair.id, project.id, 'Task', 'Work');
    const attempt = Attempt.create(assignment.id, 1, {
      sessionPairId: pair.id,
      workerSessionId: worker.id,
      externalSessionId: worker.externalSessionId,
    });
    assignment.startAttempt(attempt);
    updatedPair?.assignWork(assignment.id);
    await db.assignments.save(assignment);
    await db.attempts.save(attempt);
    await db.pairs.save(updatedPair!);

    // Automated contact forbidden
    countingWorker.reset();
    await engine.runSupervisionTick();
    assert.strictEqual(countingWorker.totalCalls, 0, 'Automated contact should be forbidden for STOPPED pair');
  });

  it('Proof 6: IDLE explicit ordinary inspect/dispatch forbidden', async () => {
    const { engine, pair, assignmentId } = await (async () => {
        const { db, engine, project, pair } = await setup();
        const assignment = Assignment.create(pair.id, project.id, 'Task', 'Work');
        await db.assignments.save(assignment);
        return { engine, pair, assignmentId: assignment.id };
    })();

    // Pair is IDLE
    assert.strictEqual(pair.operationalState, 'IDLE');

    // Explicit inspect forbidden
    await assert.rejects(
      engine.reconcileAndRecoverRuntime(pair.workerSessionId!),
      { code: 'PAIR_OPERATIONAL_STATE_IDLE' }
    );

    // Explicit dispatch forbidden
    await assert.rejects(
      engine.dispatchAssignment(assignmentId),
      { code: 'PAIR_OPERATIONAL_STATE_IDLE' }
    );
    
    // Explicit observe forbidden
    const obsResult = await engine.observeSide(pair.id, 'worker');
    assert.strictEqual(obsResult.outcome, 'refused');
    assert.strictEqual(obsResult.providerContacted, false);
  });

  it('Proof 7: IDLE explicit loadAndActivate verification permitted', async () => {
    const { engine, pair } = await setup();
    
    assert.strictEqual(pair.operationalState, 'IDLE');
    
    // This MUST be permitted as it is the path to ACTIVE
    const result = await engine.loadAndActivate(pair.id);
    assert.strictEqual(result.outcome, 'activated');
  });
});
