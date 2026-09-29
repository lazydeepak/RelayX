import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Project, Pair, RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { MockProvider } from './MockProvider.ts';

describe('RelayX Pair Continuity & PairCheckpoint Suite', () => {
  it('1. checkpoint persists across restart', async () => {
    const dbPath = join(tmpdir(), `relay_chk_restart_${Date.now()}.sqlite`);
    if (existsSync(dbPath)) unlinkSync(dbPath);

    const db1 = new SqliteRelayDatabase(dbPath);
    const engine1 = new RelayEngine(db1);

    const proj = await engine1.createProject('Project A');
    const planner = await engine1.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine1.registerRuntimeSession('opencode', 'Worker');
    planner.updateExternalIdentity('ext_planner_1', proj.id);
    worker.updateExternalIdentity('ext_worker_1', proj.id);
    await db1.runtimes.save(planner);
    await db1.runtimes.save(worker);

    const assocP = RuntimeProjectAssociation.create(planner.id, proj.id, 'ext_planner_1', 'verified', 'setup', 'chatgpt');
    const assocW = RuntimeProjectAssociation.create(worker.id, proj.id, 'ext_worker_1', 'verified', 'setup', 'opencode');
    await db1.associations.save(assocP);
    await db1.associations.save(assocW);

    const pair = await engine1.createPair(proj.id, 'Pair A', planner.id, worker.id);
    const chk = await engine1.createPairCheckpoint(pair.id, 'manual', { summary: 'Milestone reached' });

    db1.close();

    const db2 = new SqliteRelayDatabase(dbPath);
    const engine2 = new RelayEngine(db2);
    const loadedChk = await engine2.getPairCheckpoint(chk.id);

    assert.ok(loadedChk, 'Checkpoint must persist across restart');
    assert.strictEqual(loadedChk.pairId, pair.id);
    assert.strictEqual(loadedChk.reason, 'manual');
    assert.strictEqual(loadedChk.summary, 'Milestone reached');
    db2.close();
    unlinkSync(dbPath);
  });

  it('2. multiple checkpoints are cumulative and C2 does not mutate C1', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const proj = await engine.createProject('Project B');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    planner.updateExternalIdentity('ext_p2', proj.id);
    worker.updateExternalIdentity('ext_w2', proj.id);
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    await db.associations.save(RuntimeProjectAssociation.create(planner.id, proj.id, 'ext_p2', 'verified', 'setup', 'chatgpt'));
    await db.associations.save(RuntimeProjectAssociation.create(worker.id, proj.id, 'ext_w2', 'verified', 'setup', 'opencode'));

    const pair = await engine.createPair(proj.id, 'Pair B', planner.id, worker.id);
    const c1 = await engine.createPairCheckpoint(pair.id, 'milestone', { summary: 'First step' });
    const c2 = await engine.createPairCheckpoint(pair.id, 'milestone', { summary: 'Second step' });

    const list = await engine.listPairCheckpoints(pair.id);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].id, c1.id);
    assert.strictEqual(list[0].summary, 'First step');
    assert.strictEqual(list[1].id, c2.id);
    assert.strictEqual(list[1].summary, 'Second step');

    // Invariant: creating c2 does not mutate c1
    const reloadedC1 = await engine.getPairCheckpoint(c1.id);
    assert.strictEqual(reloadedC1?.summary, 'First step');
  });

  it('3. archive creates final checkpoint and preserves records', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const proj = await engine.createProject('Project C');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    planner.updateExternalIdentity('ext_p3', proj.id);
    worker.updateExternalIdentity('ext_w3', proj.id);
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    await db.associations.save(RuntimeProjectAssociation.create(planner.id, proj.id, 'ext_p3', 'verified', 'setup', 'chatgpt'));
    await db.associations.save(RuntimeProjectAssociation.create(worker.id, proj.id, 'ext_w3', 'verified', 'setup', 'opencode'));

    const pair = await engine.createPair(proj.id, 'Pair C', planner.id, worker.id);
    await engine.archivePair(pair.id);

    const checkpoints = await engine.listPairCheckpoints(pair.id);
    const archiveChk = checkpoints.find((c) => c.reason === 'pair_archive');
    assert.ok(archiveChk, 'Archive must establish a final checkpoint');
    const archived = await db.pairs.findById(pair.id);
    assert.strictEqual(archived?.status, 'archived');
  });

  it('4. runtime replacement preserves Pair ID and changes runtime identity with provenance', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const proj = await engine.createProject('Project D');
    const planner1 = await engine.registerRuntimeSession('chatgpt', 'Planner 1');
    const planner2 = await engine.registerRuntimeSession('chatgpt', 'Planner 2');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    planner1.updateExternalIdentity('ext_p1', proj.id);
    planner2.updateExternalIdentity('ext_p2', proj.id);
    worker.updateExternalIdentity('ext_w4', proj.id);
    await db.runtimes.save(planner1);
    await db.runtimes.save(planner2);
    await db.runtimes.save(worker);
    await db.associations.save(RuntimeProjectAssociation.create(planner1.id, proj.id, 'ext_p1', 'verified', 'setup', 'chatgpt'));
    await db.associations.save(RuntimeProjectAssociation.create(planner2.id, proj.id, 'ext_p2', 'verified', 'setup', 'chatgpt'));
    await db.associations.save(RuntimeProjectAssociation.create(worker.id, proj.id, 'ext_w4', 'verified', 'setup', 'opencode'));

    const pair = await engine.createPair(proj.id, 'Pair D', planner1.id, worker.id);
    const pairIdBefore = pair.id;

    const updatedPair = await engine.replaceRuntime(pair.id, 'planner', planner2.id, 'runtime_replacement');
    assert.strictEqual(updatedPair.id, pairIdBefore, 'Pair ID must remain unchanged during runtime replacement');
    assert.strictEqual(updatedPair.plannerSessionId, planner2.id);

    const checkpoints = await engine.listPairCheckpoints(pair.id);
    assert.ok(checkpoints.some((c) => c.reason === 'runtime_replacement'), 'Replacement must create a checkpoint');
  });

  it('5. Pair rotation creates successor Pair with predecessor and exact source checkpoint provenance', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);

    const proj = await engine.createProject('Project E');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    planner.updateExternalIdentity('ext_p5', proj.id);
    worker.updateExternalIdentity('ext_w5', proj.id);
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    await db.associations.save(RuntimeProjectAssociation.create(planner.id, proj.id, 'ext_p5', 'verified', 'setup', 'chatgpt'));
    await db.associations.save(RuntimeProjectAssociation.create(worker.id, proj.id, 'ext_w5', 'verified', 'setup', 'opencode'));

    const pairA = await engine.createPair(proj.id, 'Pair A', planner.id, worker.id);
    const c1 = await engine.createPairCheckpoint(pairA.id, 'milestone', { summary: 'Checkpoint 1' });
    const c2 = await engine.createPairCheckpoint(pairA.id, 'milestone', { summary: 'Checkpoint 2' });

    const pairB = await engine.rotatePair(pairA.id, c1.id, 'Pair B');

    assert.notStrictEqual(pairB.id, pairA.id, 'Pair rotation must create a new Pair ID');
    assert.strictEqual(pairB.projectId, proj.id, 'Successor belongs to same Project');
    assert.strictEqual(pairB.predecessorPairId, pairA.id, 'Successor records predecessor');
    assert.strictEqual(pairB.sourceCheckpointId, c1.id, 'Successor records exact source checkpoint C1, unaffected by later C2');
  });

  it('6. checkpoint continuation delivery routes context through delivery path and emits lineage event', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new MockProvider('chatgpt'));
    engine.registerProvider(new MockProvider('opencode'));

    const proj = await engine.createProject('Project F');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker1 = await engine.registerRuntimeSession('opencode', 'Worker 1');
    const worker2 = await engine.registerRuntimeSession('opencode', 'Worker 2');
    planner.updateExternalIdentity('ext_pf', proj.id);
    worker1.updateExternalIdentity('ext_wf1', proj.id);
    worker2.updateExternalIdentity('ext_wf2', proj.id);
    await db.runtimes.save(planner);
    await db.runtimes.save(worker1);
    await db.runtimes.save(worker2);
    await db.associations.save(RuntimeProjectAssociation.create(planner.id, proj.id, 'ext_pf', 'verified', 'setup', 'chatgpt'));
    await db.associations.save(RuntimeProjectAssociation.create(worker1.id, proj.id, 'ext_wf1', 'verified', 'setup', 'opencode'));
    await db.associations.save(RuntimeProjectAssociation.create(worker2.id, proj.id, 'ext_wf2', 'verified', 'setup', 'opencode'));

    const pair = await engine.createPair(proj.id, 'Pair F', planner.id, worker1.id);
    const chk = await engine.createPairCheckpoint(pair.id, 'milestone', { summary: 'Important progress checkpoint' });
    await engine.loadAndActivate(pair.id);

    // Replace worker and verify automatic continuation delivery
    const updatedPair = await engine.replaceRuntime(pair.id, 'worker', worker2.id, 'runtime_replacement');
    assert.strictEqual(updatedPair.workerSessionId, worker2.id);

    const assignments = await db.assignments.findByPairId(pair.id);
    let continuationDelivery: any = null;
    for (const a of assignments) {
      const dels = await db.deliveries.findByAssignmentId(a.id);
      const found = dels.find((d) => d.targetRuntimeId === worker2.id);
      if (found) {
        continuationDelivery = found;
        break;
      }
    }
    assert.ok(continuationDelivery, 'Continuation delivery must be dispatched to the replacement worker');
    assert.strictEqual(continuationDelivery.status, 'delivered', 'Continuation delivery must successfully deliver');

    const events = await db.events.findByResourceId(pair.id);
    const continuationEvent = events.find((e) => e.eventType === 'pair.continuation_delivered');
    assert.ok(continuationEvent, 'Continuation delivery must emit pair.continuation_delivered lineage event');
  });

  it('7. planner replacement route targets the exact newly bound planner runtime', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new MockProvider('chatgpt'));
    engine.registerProvider(new MockProvider('opencode'));

    const proj = await engine.createProject('Project G');
    const planner1 = await engine.registerRuntimeSession('chatgpt', 'Planner 1');
    const planner2 = await engine.registerRuntimeSession('chatgpt', 'Planner 2');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    planner1.updateExternalIdentity('ext_pg1', proj.id);
    planner2.updateExternalIdentity('ext_pg2', proj.id);
    worker.updateExternalIdentity('ext_wg', proj.id);
    await db.runtimes.save(planner1);
    await db.runtimes.save(planner2);
    await db.runtimes.save(worker);
    await db.associations.save(RuntimeProjectAssociation.create(planner1.id, proj.id, 'ext_pg1', 'verified', 'setup', 'chatgpt'));
    await db.associations.save(RuntimeProjectAssociation.create(planner2.id, proj.id, 'ext_pg2', 'verified', 'setup', 'chatgpt'));
    await db.associations.save(RuntimeProjectAssociation.create(worker.id, proj.id, 'ext_wg', 'verified', 'setup', 'opencode'));

    const pair = await engine.createPair(proj.id, 'Pair G', planner1.id, worker.id);
    const chk = await engine.createPairCheckpoint(pair.id, 'milestone', { summary: 'Planner checkpoint' });
    await engine.loadAndActivate(pair.id);

    const updatedPair = await engine.replaceRuntime(pair.id, 'planner', planner2.id, 'planner_replacement');
    assert.strictEqual(updatedPair.plannerSessionId, planner2.id);

    const assignments = await db.assignments.findByPairId(pair.id);
    let continuationDelivery: any = null;
    for (const a of assignments) {
      const dels = await db.deliveries.findByAssignmentId(a.id);
      const found = dels.find((d) => d.targetRuntimeId === planner2.id);
      if (found) {
        continuationDelivery = found;
        break;
      }
    }
    assert.ok(continuationDelivery, 'Continuation delivery must target replacement planner');
    assert.strictEqual(continuationDelivery.targetRuntimeId, planner2.id);
  });

  it('8. ambiguous or failed continuation delivery records attention and emits appropriate lineage event without fake success', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    const chatgptProvider = new MockProvider('chatgpt');
    chatgptProvider.deliveryOutcome = 'ambiguous';
    engine.registerProvider(chatgptProvider);
    engine.registerProvider(new MockProvider('opencode'));

    const proj = await engine.createProject('Project H');
    const planner1 = await engine.registerRuntimeSession('chatgpt', 'Planner 1');
    const planner2 = await engine.registerRuntimeSession('chatgpt', 'Planner 2');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    planner1.updateExternalIdentity('ext_ph1', proj.id);
    planner2.updateExternalIdentity('ext_ph2', proj.id);
    worker.updateExternalIdentity('ext_wh', proj.id);
    await db.runtimes.save(planner1);
    await db.runtimes.save(planner2);
    await db.runtimes.save(worker);
    await db.associations.save(RuntimeProjectAssociation.create(planner1.id, proj.id, 'ext_ph1', 'verified', 'setup', 'chatgpt'));
    await db.associations.save(RuntimeProjectAssociation.create(planner2.id, proj.id, 'ext_ph2', 'verified', 'setup', 'chatgpt'));
    await db.associations.save(RuntimeProjectAssociation.create(worker.id, proj.id, 'ext_wh', 'verified', 'setup', 'opencode'));

    const pair = await engine.createPair(proj.id, 'Pair H', planner1.id, worker.id);
    await engine.createPairCheckpoint(pair.id, 'milestone', { summary: 'Ambiguous test checkpoint' });
    await engine.loadAndActivate(pair.id);

    await engine.replaceRuntime(pair.id, 'planner', planner2.id, 'ambiguous_replacement');

    const events = await db.events.findByResourceId(pair.id);
    const successEvent = events.find((e) => e.eventType === 'pair.continuation_delivered');
    const ambiguousEvent = events.find((e) => e.eventType === 'pair.continuation_ambiguous');

    assert.strictEqual(successEvent, undefined, 'pair.continuation_delivered must NOT be emitted on ambiguous delivery');
    assert.ok(ambiguousEvent, 'pair.continuation_ambiguous must be emitted when delivery outcome is ambiguous');

    const attentionItems = await db.attention.findOpen();
    assert.ok(attentionItems.some((ai) => ai.type === 'continuation_delivery_ambiguous'), 'Attention item must be raised for ambiguous continuation delivery');
  });
});
