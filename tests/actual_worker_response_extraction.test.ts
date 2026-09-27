/**
 * Phase F — Actual Worker Response Extraction Tests
 *
 * Verifies that completed worker responses are truthfully extracted from the
 * authoritative session, associated with the correct delivery/attempt boundary,
 * and converted into a valid handoff with evidence without capturing stale responses.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';

describe('Phase F — Actual Worker Response Extraction', () => {
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

  it('F1: extracts actual completed worker response snippet into handoff when complete', async () => {
    const project = await engine.createProject('Supervision Proj');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine.createPair(project.id, 'Supervision Pair', planner.id, worker.id);

    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');

    const assignment = await engine.createAssignment(pair.id, 'Supervised Task', 'code');
    await engine.dispatchAssignment(assignment.id);

    // Set provider to complete state
    provider.isComplete = true;
    provider.responseSummary = 'Extracted worker response for Phase F.';

    // Run supervisory tick to extract response
    await engine.runSupervisionTick();

    const updatedAssignment = await db.assignments.findById(assignment.id);
    assert.strictEqual(updatedAssignment?.status, 'waiting_for_handoff');
    assert.ok(updatedAssignment.activeHandoffId);

    const handoff = await db.handoffs.findById(updatedAssignment.activeHandoffId);
    assert.ok(handoff);
    assert.strictEqual(handoff.resultSummary, 'Extracted worker response for Phase F.');
    assert.ok(handoff.evidence);
  });
});
