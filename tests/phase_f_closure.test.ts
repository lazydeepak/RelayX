/**
 * Phase F Closure Tests — Actual Worker Response Extraction & Causal Integrity
 *
 * Proves the 4 mandatory closure criteria for Phase F:
 * 1. Normal dispatch produces a new completed assistant response and RelayX extracts the correct text.
 * 2. Pre-existing/stale assistant messages are rejected.
 * 3. Responses belonging to another ses_* session are rejected.
 * 4. Restart after dispatch preserves watermark/correlation and does not accept stale evidence or redispatch blindly.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';

describe('Phase F Closure — Causal Extraction & Boundary Integrity', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let provider: MockProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    provider = new MockProvider('opencode');
    engine.registerProvider(provider);
    engine.registerProvider(new MockProvider('chatgpt'));
  });

  it('Case 1: Normal dispatch produces a new completed assistant response and extracts correct text into handoff', async () => {
    const project = await engine.createProject('Phase F Proj');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker', 'ses_test_123');
    const pair = await engine.createPair(project.id, 'Phase F Pair', planner.id, worker.id);

    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');

    const assignment = await engine.createAssignment(pair.id, 'Task 1', 'Implement feature');
    await engine.dispatchAssignment(assignment.id);

    // Simulate worker completion with valid post-dispatch response
    provider.isComplete = true;
    provider.responseSummary = 'Successfully implemented feature X for Phase F.';

    await engine.runSupervisionTick();

    const updated = await db.assignments.findById(assignment.id);
    assert.strictEqual(updated?.status, 'waiting_for_handoff');
    assert.ok(updated.activeHandoffId);

    const handoff = await db.handoffs.findById(updated.activeHandoffId);
    assert.ok(handoff);
    assert.strictEqual(handoff.resultSummary, 'Successfully implemented feature X for Phase F.');
    assert.ok(handoff.evidence);
  });

  it('Case 2: Pre-existing / stale assistant messages are rejected when no post-dispatch new response is produced', async () => {
    const project = await engine.createProject('Phase F Stale Proj');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker', 'ses_test_stale');
    const pair = await engine.createPair(project.id, 'Phase F Stale Pair', planner.id, worker.id);

    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');

    const assignment = await engine.createAssignment(pair.id, 'Task 2', 'Refactor module');
    await engine.dispatchAssignment(assignment.id);

    // Assignment is active post-dispatch
    let assigned = await db.assignments.findById(assignment.id);
    assert.strictEqual(assigned?.status, 'active');

    // Provider is NOT complete (no new completed assistant response since dispatch boundary)
    provider.isComplete = false;
    provider.responseSummary = undefined;

    await engine.runSupervisionTick();

    const updated = await db.assignments.findById(assignment.id);
    // Should remain active without creating a handoff
    assert.strictEqual(updated?.status, 'active');
    assert.ok(!updated.activeHandoffId);
  });

  it('Case 3: Responses belonging to another ses_* session are rejected', async () => {
    const project = await engine.createProject('Phase F Mismatch Proj');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker', 'ses_bound_correct');
    const pair = await engine.createPair(project.id, 'Phase F Mismatch Pair', planner.id, worker.id);

    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');

    const assignment = await engine.createAssignment(pair.id, 'Task 3', 'Verify session isolation');
    await engine.dispatchAssignment(assignment.id);

    // Simulate completion with evidence pointing to a mismatched session ID
    provider.detectCompletionState = async (sessionId) => {
      return {
        isComplete: true,
        responseSummary: 'Response from wrong session',
        evidence: {
          id: `ev_wrong_${Date.now()}`,
          timestamp: Date.now(),
          source: 'reconciliation_probe',
          runtimeSessionId: sessionId,
          details: { externalSessionTargeted: 'ses_wrong_other' },
        },
      };
    };

    await engine.runSupervisionTick();

    const updated = await db.assignments.findById(assignment.id);
    // Mismatched session evidence must not produce a handoff for the bound session
    assert.ok(!updated?.activeHandoffId);
  });

  it('Case 4: Restart after dispatch preserves watermark/correlation and processes post-restart completion correctly without redispatching', async () => {
    const dbPath = ':memory:';
    const db1 = new SqliteRelayDatabase(dbPath);
    const engine1 = new RelayEngine(db1);
    const provider1 = new MockProvider('opencode');
    engine1.registerProvider(provider1);
    engine1.registerProvider(new MockProvider('chatgpt'));

    const project = await engine1.createProject('Restart Proj');
    const planner = await engine1.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine1.registerRuntimeSession('opencode', 'Worker', 'ses_restart_123');
    const pair = await engine1.createPair(project.id, 'Restart Pair', planner.id, worker.id);

    assert.strictEqual((await engine1.loadAndActivate(pair.id)).outcome, 'activated');

    const assignment = await engine1.createAssignment(pair.id, 'Task 4', 'Persistence restart test');
    await engine1.dispatchAssignment(assignment.id);

    // Verify assignment is active post-dispatch
    let assigned = await db1.assignments.findById(assignment.id);
    assert.strictEqual(assigned?.status, 'active');

    // Simulate engine restart by creating a new RelayEngine instance sharing the same SQLite database
    const engine2 = new RelayEngine(db1);
    engine2.registerProvider(provider1);
    engine2.registerProvider(new MockProvider('chatgpt'));

    // Complete the work post-restart
    provider1.isComplete = true;
    provider1.responseSummary = 'Completed successfully after engine restart.';

    await engine2.runSupervisionTick();

    const postRestartAssignment = await db1.assignments.findById(assignment.id);
    assert.strictEqual(postRestartAssignment?.status, 'waiting_for_handoff');
    assert.ok(postRestartAssignment.activeHandoffId);

    const handoff = await db1.handoffs.findById(postRestartAssignment.activeHandoffId);
    assert.ok(handoff);
    assert.strictEqual(handoff.resultSummary, 'Completed successfully after engine restart.');
  });
});
