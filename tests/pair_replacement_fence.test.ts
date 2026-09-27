/**
 * S1 — pair replacement fence, checkpoint fence, readiness fence.
 *
 * Frozen sources:
 *   SESSION_PAIR_REPLACEMENT.md §3, §4        replacement is a NEW Pair, old preserved
 *   DESIGN_FREEZE §C-1                        stable Pair identity that survives update
 *   DESIGN_FREEZE §10.5 / I-10                the cascade hazard; history is never a
 *                                             cleanup artefact
 *   DESIGN_FREEZE §6.4 / I-14                 observing a side does not advance its
 *                                             durable checkpoint
 *   DESIGN_FREEZE §8 / I-5                    readiness is derived, never persisted as
 *                                             authority
 *
 * S1 stops at the safe prerequisite. The full C-1 replacement operation is FENCED,
 * not implemented: two existing regression gates require `updatePair()` to return
 * the SAME row (`tests/pair_mutation_association.test.ts:173` asserts
 * `updated.id === pair.id`, and `tests/management_lifecycle.test.ts:127-133` re-reads
 * by the old pair id). Replacing the row therefore cannot be done without first
 * re-deciding a protected gate. What S1 does instead is make the fence
 * *provable*: a durable identity that cannot be rewritten, so the in-place
 * mutation can no longer silently move the ownership of a recorded fact.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import {
  Pair,
  Assignment,
  Attempt,
  Handoff,
  Delivery,
  Project,
  RuntimeSession,
  RuntimeProjectAssociation,
} from '../src/relay/domain/entities.ts';
import {
  PairId,
  ProjectId,
  AssignmentId,
  AttemptId,
  RuntimeSessionId,
  ObservableEvidence,
} from '../src/relay/domain/types.ts';
import { MockProvider } from './MockProvider.ts';

function repoFile(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), 'utf8');
}

async function seedProject(db: SqliteRelayDatabase, name: string, path: string): Promise<Project> {
  const project = Project.create(name, '', path, path);
  await db.projects.save(project);
  return project;
}

async function seedRuntime(
  db: SqliteRelayDatabase,
  providerType: 'chatgpt' | 'opencode',
  name: string,
  externalSessionId: string,
  projectId: ProjectId,
): Promise<RuntimeSession> {
  const runtime = RuntimeSession.create(providerType, name);
  runtime.updateExternalIdentity(externalSessionId, '/dev/replacement');
  await db.runtimes.save(runtime);
  await db.associations.save(
    RuntimeProjectAssociation.create(runtime.id, projectId, externalSessionId, 'verified', 'adoption', providerType),
  );
  return runtime;
}

describe('S1 — a Pair carries a durable identity that survives rebinding (C-1, §10.2)', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    engine.registerProvider(new MockProvider('opencode'));
    engine.registerProvider(new MockProvider('chatgpt'));
  });

  it('stablePairId is set at creation and is not a compensating alias for id', async () => {
    const project = await seedProject(db, 'Identity', '/dev/identity');
    const pair = Pair.create(project.id, 'Identity Pair');
    assert.strictEqual(pair.stableId, pair.id, 'a new Pair anchors its stable identity to its own id');

    // It is a distinct field, not the same storage: a caller that rewrites `id`
    // in place cannot silently move the anchor.
    const rewritten = new Pair({
      id: 'pair_row_2' as PairId,
      projectId: project.id,
      name: pair.name,
      status: pair.status,
      operationalState: pair.operationalState,
      stableId: pair.stableId,
      createdAt: pair.createdAt,
      updatedAt: pair.updatedAt,
    });
    assert.notStrictEqual(rewritten.id, rewritten.stableId);
    assert.strictEqual(rewritten.stableId, pair.stableId, 'the anchor is carried, not derived from the row id');
  });

  it('the upsert never rewrites stable_pair_id, so a rebound Pair keeps its anchor forever', async () => {
    const project = await seedProject(db, 'Anchor', '/dev/anchor');
    const planner = await seedRuntime(db, 'chatgpt', 'Planner 1', 'conv-1', project.id);
    const worker = await seedRuntime(db, 'opencode', 'Worker 1', 'ses-1', project.id);
    const pair = await engine.createPair(project.id, 'Anchor Pair', planner.id, worker.id);
    const anchor = pair.stableId;

    const replacement = await seedRuntime(db, 'chatgpt', 'Planner 2', 'conv-2', project.id);
    const rebound = await engine.updatePair(pair.id, { plannerSessionId: replacement.id });
    assert.strictEqual(rebound.plannerSessionId, replacement.id, 'the rebinding did happen');
    assert.strictEqual(rebound.stableId, anchor, 'and the stable anchor did not move');

    const reloaded = await db.pairs.findById(pair.id);
    assert.strictEqual(reloaded!.stableId, anchor);
    const raw = db.db.prepare('SELECT id, stable_pair_id FROM pairs WHERE id = ?').get(pair.id) as Record<string, string>;
    assert.strictEqual(raw.stable_pair_id, anchor, 'the persisted column is stable too');
  });

  it('even a hostile direct write of a different id cannot change the anchor on reload', async () => {
    const project = await seedProject(db, 'Hostile', '/dev/hostile');
    const pair = Pair.create(project.id, 'Hostile Pair');
    await db.pairs.save(pair);
    const anchor = pair.stableId;

    // A hand-edit that rewrites the row id (the naive "delete and reinsert
    // replacement" shape) leaves stable_pair_id pointing at the ORIGINAL identity.
    db.db.prepare('UPDATE pairs SET id = ? WHERE id = ?').run('pair_reinserted', pair.id);
    const reloaded = await db.pairs.findById('pair_reinserted' as PairId);
    assert.strictEqual(reloaded!.id, 'pair_reinserted');
    assert.strictEqual(
      reloaded!.stableId,
      anchor,
      'history anchored to the original Pair can still be attributed to the original Pair',
    );
  });

  it('the upsert statement itself omits stable_pair_id from the DO UPDATE set', () => {
    const source = repoFile('src/relay/persistence/sqlite/SqliteRepositories.ts');
    const upsert = source.slice(source.indexOf('class SqlitePairRepository'));
    const doUpdate = upsert.slice(upsert.indexOf('ON CONFLICT(id) DO UPDATE SET'), upsert.indexOf('stmt.run', upsert.indexOf('ON CONFLICT(id) DO UPDATE SET')));
    assert.ok(doUpdate.length > 0, 'the pair upsert must have a DO UPDATE clause');
    assert.ok(
      !/stable_pair_id\s*=/.test(doUpdate),
      'stable_pair_id must be insert-only: an UPDATE that touched it would make the anchor rewritable',
    );
  });
});

describe('S1 — rebinding a Pair never cascades away its history (§10.5, I-10, SESSION_PAIR_REPLACEMENT §3)', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    engine.registerProvider(new MockProvider('opencode'));
    engine.registerProvider(new MockProvider('chatgpt'));
  });

  it('assignment, attempt, delivery and handoff history survives a session rebinding', async () => {
    const project = await seedProject(db, 'History', '/dev/history');
    const planner = await seedRuntime(db, 'chatgpt', 'Planner 1', 'conv-1', project.id);
    const worker = await seedRuntime(db, 'opencode', 'Worker 1', 'ses-1', project.id);
    const pair = await engine.createPair(project.id, 'History Pair', planner.id, worker.id);
    // I-2 (S6): the dispatch below is provider contact and needs ACTIVE. Load &
    // Activate is the only authorized grantor (§4.4, §11.5). The C-1 fence this
    // file guards is untouched by activation.
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');

    const assignment = await engine.createAssignment(pair.id, 'Task', 'Instruction');
    const dispatched = await engine.dispatchAssignment(assignment.id);
    const workerProvider = engine.getProvider('opencode') as MockProvider;
    workerProvider.isComplete = true;
    workerProvider.isWorking = false;
    await engine.runSupervisionTick();

    const beforeAssignment = await db.assignments.findById(assignment.id);
    const beforeAttempt = await db.attempts.findById(dispatched.attempt.id);
    const beforeDeliveries = await db.deliveries.findByAssignmentId(assignment.id);
    const beforeHandoffs = await db.handoffs.findByAssignmentId(assignment.id);
    assert.ok(beforeAttempt);
    assert.strictEqual(beforeDeliveries.length, 1);
    assert.strictEqual(beforeHandoffs.length, 1);

    // Close the work so the ACTIVE_WORK_GUARD allows a rebinding. History is
    // untouched by completion; only the pair's in-flight pointer clears.
    await engine.completeHandoff(beforeHandoffs[0]!.id);
    await engine.completeAssignment(assignment.id);

    const replacement = await seedRuntime(db, 'opencode', 'Worker 2', 'ses-2', project.id);
    await engine.updatePair(pair.id, { workerSessionId: replacement.id });

    // Nothing was destroyed. In particular, `assignments.pair_id` is
    // `ON DELETE CASCADE`, so any delete-and-reinsert replacement would have
    // silently destroyed all of this.
    const afterAssignment = await db.assignments.findById(assignment.id);
    assert.strictEqual(afterAssignment?.pairId, pair.id);
    assert.strictEqual(afterAssignment?.id, beforeAssignment?.id, 'assignment identity is preserved');
    assert.strictEqual(afterAssignment?.title, beforeAssignment?.title);
    assert.strictEqual(afterAssignment?.currentAttemptId, beforeAssignment?.currentAttemptId);
    assert.strictEqual(afterAssignment?.activeHandoffId, beforeAssignment?.activeHandoffId);
    assert.ok(afterAssignment!.completedAt, 'the only field that moved is the one completion set');
    const afterAttempt = await db.attempts.findById(dispatched.attempt.id);
    assert.ok(afterAttempt);
    assert.strictEqual(afterAttempt!.sessionPairId, beforeAttempt!.sessionPairId);
    assert.strictEqual(afterAttempt!.workerSessionId, beforeAttempt!.workerSessionId, 'frozen worker authority is preserved');
    assert.strictEqual(afterAttempt!.externalSessionId, beforeAttempt!.externalSessionId);
    assert.strictEqual(
      afterAttempt!.status,
      'completed_physical',
      'the only field that moved is the one completion set, not the rebinding',
    );
    assert.strictEqual((await db.deliveries.findByAssignmentId(assignment.id)).length, 1);
    assert.strictEqual((await db.handoffs.findByAssignmentId(assignment.id)).length, 1);
    assert.strictEqual((await db.pairs.findAll()).length, 1, 'no orphan or duplicate Pair row');
  });

  it('the frozen authority of an in-flight Attempt is untouched by a later rebinding', async () => {
    const project = await seedProject(db, 'Authority', '/dev/authority');
    const planner = await seedRuntime(db, 'chatgpt', 'Planner', 'conv-auth', project.id);
    const worker1 = await seedRuntime(db, 'opencode', 'Worker 1', 'ses-1', project.id);
    const pair = await engine.createPair(project.id, 'Authority Pair', planner.id, worker1.id);
    // I-2 (S6): the dispatch below is provider contact and needs ACTIVE. Load &
    // Activate is the only authorized grantor (§4.4, §11.5). The C-1 fence this
    // file guards is untouched by activation.
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');

    const assignment = await engine.createAssignment(pair.id, 'Task', 'Instruction');
    const { attempt } = await engine.dispatchAssignment(assignment.id);
    const frozen = await db.attempts.findById(attempt.id);
    assert.ok(frozen);

    const worker2 = await seedRuntime(db, 'opencode', 'Worker 2', 'ses-2', project.id);
    // ACTIVE_WORK_GUARD: an in-flight pair cannot be rebound at all, which is
    // precisely why replacement must become a new-record operation.
    await assert.rejects(
      () => engine.updatePair(pair.id, { workerSessionId: worker2.id }),
      /active assignment/i,
    );
    const stillFrozen = await db.attempts.findById(attempt.id);
    assert.strictEqual(stillFrozen!.sessionPairId, frozen!.sessionPairId);
    assert.strictEqual(stillFrozen!.workerSessionId, frozen!.workerSessionId);
    assert.strictEqual(stillFrozen!.externalSessionId, frozen!.externalSessionId);
    assert.strictEqual(stillFrozen!.status, 'running', 'frozen authority never silently moves');
  });

  it('the cascade that would destroy history is still declared, and is documented as a hazard', () => {
    const source = repoFile('src/relay/persistence/sqlite/SqliteDatabase.ts');
    assert.ok(
      /CREATE TABLE IF NOT EXISTS assignments \([\s\S]*?pair_id TEXT NOT NULL REFERENCES pairs\(id\) ON DELETE CASCADE/.test(source),
      'the cascade must still be present: §10.5 freezes it as undecided (U-9), and S1 must not silently change it',
    );
    assert.ok(
      /migrateSessionPairOperationsSchema|Cascade/.test(source) || /cascade/i.test(source),
      'the hazard must remain visible in the source',
    );
  });
});

describe('S1 — full C-1 replacement is fenced behind two protected regression gates', () => {
  it('the gate that blocks replacement is still present and unchanged', () => {
    const source = repoFile('tests/pair_mutation_association.test.ts');
    assert.ok(
      source.includes('assert.strictEqual(updated.id, pair.id)'),
      'tests/pair_mutation_association.test.ts:173 requires updatePair() to return the same row; ' +
        'replacement cannot be implemented without re-deciding this protected gate',
    );
  });

  it('the second gate re-reads the Pair by its pre-update id', () => {
    const source = repoFile('tests/management_lifecycle.test.ts');
    const updateIdx = source.indexOf('service.updatePair(');
    assert.ok(updateIdx > 0);
    const after = source.slice(updateIdx, updateIdx + 400);
    assert.ok(
      /db\.pairs\.findById\(pair\.id/.test(after),
      'tests/management_lifecycle.test.ts re-reads the Pair by the OLD id after a rebinding; ' +
        'a replacement operation that returned a new id would break it',
    );
  });

  it('no `replacePair`/`adoptPair` operation exists yet, so the contract cannot be half-implemented', () => {
    const source = repoFile('src/relay/application/RelayEngine.ts');
    assert.ok(
      !/public async (replacePair|adoptPair|createReplacementPair)\b/.test(source),
      'a replacement operation must not appear until the two blocking gates are re-decided',
    );
  });

  it('SESSION_PAIR_REPLACEMENT.md is unmodified by S1', () => {
    const doc = repoFile('SESSION_PAIR_REPLACEMENT.md');
    assert.ok(doc.includes('Old Pair identity must be preserved'));
    assert.ok(
      !/S1|operational_state|stable_pair_id/.test(doc),
      'the frozen replacement contract must not be edited to accommodate the current code',
    );
  });
});

describe('S1 — observing a side never advances an acknowledged checkpoint (§6.4, I-14)', () => {
  it('the runtime-session model has no checkpoint field, and the only continuity signal is last-known evidence', () => {
    const db = new SqliteRelayDatabase(':memory:');
    const cols = (
      db.db.prepare("SELECT name FROM pragma_table_info('runtime_sessions')").all() as { name: string }[]
    ).map((c) => c.name);
    for (const forbidden of ['checkpoint', 'checkpoint_json', 'last_known_message_ref', 'continuity', 'advance_state']) {
      assert.ok(
        !cols.includes(forbidden),
        `S1 must not add a checkpoint column: §6.4 is a fence here, and the durable checkpoint is I-14 work that follows the provenance model`,
      );
    }
    assert.ok(
      cols.includes('last_evidence_json'),
      'the pre-existing single-overwrite continuity signal (C-4) is untouched, not silently replaced',
    );
    db.close();
  });

  it('repeated observations overwrite last-known evidence but never fabricate an acknowledged checkpoint', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const project = await seedProject(db, 'Observe', '/dev/observe');
    const worker = await seedRuntime(db, 'opencode', 'Worker', 'ses-obs', project.id);

    const evidence = (id: string): ObservableEvidence => ({
      id,
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      runtimeSessionId: worker.id,
    });

    for (const id of ['ev_1', 'ev_2', 'ev_3']) {
      worker.recordObservationSuccess('working', evidence(id));
      await db.runtimes.save(worker);
      const reloaded = await db.runtimes.findById(worker.id);
      assert.strictEqual(reloaded!.lastEvidence?.id, id, 'last-known evidence advances as an observation');
      // Nothing else on the record moved, so no acknowledged checkpoint exists.
      const keys = Object.keys(reloaded as unknown as Record<string, unknown>);
      assert.ok(!keys.some((k) => /checkpoint|acknowledg|continuity|advance/i.test(k)), keys.join(','));
    }
    db.close();
  });

  it('the RuntimeSession checkpoint fence is documented in the entity itself', () => {
    const source = repoFile('src/relay/domain/entities.ts');
    assert.ok(
      /NOT an acknowledged or\s+\*\/\s+.*checkpoint/i.test(source) ||
        /NOT an acknowledged/.test(source),
      'RuntimeSession.lastEvidence must carry the §6.4 fence comment so the model cannot be misread as a checkpoint',
    );
  });
});

describe('S1 — readiness is never persisted as authority (I-5, C-3, §8)', () => {
  it('no Pair column and no Pair field is readiness-shaped', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const cols = (
      db.db.prepare("SELECT name FROM pragma_table_info('pairs')").all() as { name: string }[]
    ).map((c) => c.name);
    for (const forbidden of ['readiness', 'ready', 'health', 'readiness_level', 'last_readiness_at']) {
      assert.ok(!cols.includes(forbidden), `pairs must not persist ${forbidden} (I-5)`);
    }

    const project = await seedProject(db, 'Readiness', '/dev/readiness');
    const pair = Pair.create(project.id, 'Readiness Pair');
    await db.pairs.save(pair);
    const reloaded = await db.pairs.findById(pair.id);
    const keys = Object.keys(reloaded as unknown as Record<string, unknown>);
    assert.ok(!keys.some((k) => /readi|ready|health|attent/i.test(k)), `unexpected field on Pair: ${keys.join(', ')}`);
    db.close();
  });

  it('no engine or service method computes, persists, or returns a readiness level', () => {
    for (const file of [
      'src/relay/application/RelayEngine.ts',
      'src/relay/application/RelayApiService.ts',
    ]) {
      const source = repoFile(file);
      assert.ok(
        !/readiness\s*[:=]/i.test(source) && !/deriveReadiness|getReadiness/.test(source),
        `${file} must not implement readiness in S1: I-5 requires derivation from current evidence, which does not exist yet (C-3)`,
      );
    }
  });
});

describe('S1 — a hand-built chain still cannot fabricate a delivery or handoff record', () => {
  it('constructing a Delivered-looking Handoff still requires a real transition with evidence', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new MockProvider('opencode'));
    engine.registerProvider(new MockProvider('chatgpt'));

    const project = await seedProject(db, 'Hand Built', '/dev/handbuilt');
    const planner = await seedRuntime(db, 'chatgpt', 'Planner', 'conv-hb', project.id);
    const worker = await seedRuntime(db, 'opencode', 'Worker', 'ses-hb', project.id);
    const pair = await engine.createPair(project.id, 'Hand Built Pair', planner.id, worker.id);
    const assignment = await engine.createAssignment(pair.id, 'T', 'I');
    const attempt = Attempt.create(assignment.id, 1, {
      sessionPairId: pair.id,
      workerSessionId: worker.id,
      externalSessionId: 'ses-hb',
    });
    await db.attempts.save(attempt);
    const handoff = Handoff.create(assignment.id, attempt.id);
    await db.handoffs.save(handoff);

    // Round-tripping through persistence must not upgrade an undelivered record.
    const reloaded = await db.handoffs.findById(handoff.id);
    assert.strictEqual(reloaded!.status, 'pending');
    assert.strictEqual(reloaded!.deliveredToPlannerAt, undefined);
    assert.strictEqual(reloaded!.plannerDeliveryEvidence, undefined);

    // And the Worker-side evidence column and the Planner-side column are distinct.
    const workerEvidence: ObservableEvidence = {
      id: 'ev_worker',
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      runtimeSessionId: worker.id,
    };
    reloaded!.markReady('Result', undefined, workerEvidence);
    await db.handoffs.save(reloaded!);
    const afterReady = await db.handoffs.findById(handoff.id);
    assert.strictEqual(afterReady!.evidence?.id, 'ev_worker');
    assert.strictEqual(afterReady!.plannerDeliveryEvidence, undefined);
    db.close();
  });

  it('a Delivery confirmed without evidence is refused, so the external-effect chain is gated end to end', () => {
    const delivery = Delivery.create(
      'asgn_1' as AssignmentId,
      'att_1' as AttemptId,
      'runtime_1' as RuntimeSessionId,
      'snippet',
      'idem-1',
    );
    assert.strictEqual(delivery.status, 'pending');
    // markAmbiguous keeps the record honest rather than upgrading to delivered.
    delivery.markAmbiguous('window unfocused');
    assert.strictEqual(delivery.status, 'ambiguous');
    assert.strictEqual(delivery.deliveredAt, undefined);
  });
});
