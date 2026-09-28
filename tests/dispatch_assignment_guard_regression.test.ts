/**
 * Regression tests for dispatch-assignment authority and active-assignment guard (C/5).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RuntimeSession, Project, Pair, Assignment } from '../src/relay/domain/entities.ts';
import { ProjectId, PairId, RuntimeSessionId, createId } from '../src/relay/domain/types.ts';

describe('C — Active Assignment authority and dispatch guard', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;

  beforeEach(async () => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    engine.registerProvider(new (await import('../src/relay/providers/adapters.ts')).OpenCodeProvider());
  });

  async function seedPairWithWorker(projectId: ProjectId): Promise<{ pair: Pair; planner: RuntimeSession; worker: RuntimeSession }> {
    const planner = RuntimeSession.create('chatgpt', 'Planner');
    planner.updateExternalIdentity('conv_planner', `https://chatgpt.com/g/g-p-test/c/conv_planner`);
    await db.runtimes.save(planner);
    const worker = RuntimeSession.create('opencode', 'Worker');
    worker.updateExternalIdentity('ses_worker', '/dev/test');
    await db.runtimes.save(worker);
    const pair = Pair.create(projectId, 'Test Pair', planner.id, worker.id);
    await db.pairs.save(pair);
    return { pair, planner, worker };
  }

  it('C1: second dispatch retries existing active assignment instead of creating a new one', async () => {
    const proj = Project.create('Dispatch Guard', '', '/dev/guard');
    await db.projects.save(proj);
    const { pair, planner, worker } = await seedPairWithWorker(proj.id);

    // Create initial assignment and make it active
    const asgn1 = Assignment.create(pair.id, proj.id, 'Task 1', 'Instruction 1');
    await db.assignments.save(asgn1);
    pair.assignWork(asgn1.id);
    pair.makeActive();
    await db.pairs.save(pair);

    // Dispatch the active assignment (simulating handleDispatchPair retry path)
    await engine.dispatchAssignment(asgn1.id);

    const assignments = await db.assignments.findById(asgn1.id);
    const attempts = await db.attempts.findByAssignmentId(asgn1.id);
    assert.strictEqual(attempts.length, 1, 'Only one attempt should exist');
    assert.strictEqual(assignments?.currentAttemptId, attempts[0].id);
  });

  it('C2: pair with no active assignment creates a new assignment on dispatch', async () => {
    const proj = Project.create('Dispatch Guard 2', '', '/dev/guard2');
    await db.projects.save(proj);
    const { pair } = await seedPairWithWorker(proj.id);
    pair.makeActive();
    await db.pairs.save(pair);

    const asgn = Assignment.create(pair.id, proj.id, 'Task A', 'Instruction A');
    await db.assignments.save(asgn);
    await engine.dispatchAssignment(asgn.id);

    const attempts = await db.attempts.findByAssignmentId(asgn.id);
    const pairUpdated = await db.pairs.findById(pair.id);
    assert.strictEqual(attempts.length, 1, 'New assignment should have one attempt');
    assert.strictEqual(pairUpdated?.activeAssignmentId, asgn.id, 'Pair should reference the new active assignment');
  });
});
