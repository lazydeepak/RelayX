import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { PairId } from '../src/relay/domain/types.ts';
import { RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';

describe('Pair session change isolation', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;

  before(async () => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    service = new RelayApiService(db, engine);
  });

  after(async () => {
    db.close();
  });

  test('cross-project pairing rejected when empty-correspondence project tries to bind runtime already paired elsewhere', async () => {
    // Create Project A with saved fields, bind planner and worker to it
    const projA = await service.engine.createProject('Project A', '', '/dev/proj-a', '/dev/proj-a');
    projA.update(undefined, undefined, undefined, undefined, 'https://chatgpt.com/g/g-p-a', '/dev/proj-a');
    await db.projects.save(projA);

    const plannerA = await service.engine.registerRuntimeSession('chatgpt', 'Planner A', 'com.openai.chat');
    plannerA.updateExternalIdentity('conv-a', 'https://chatgpt.com/g/g-p-a');
    await db.runtimes.save(plannerA);

    const workerA = await service.engine.registerRuntimeSession('opencode', 'Worker A', 'dev.opencode.desktop');
    workerA.updateExternalIdentity('ses-a', '/dev/proj-a');
    await db.runtimes.save(workerA);
    await db.associations.save(
      RuntimeProjectAssociation.create(
        plannerA.id,
        projA.id,
        'conv-a',
        'verified',
        'adoption',
        'chatgpt',
      ),
    );
    await db.associations.save(
      RuntimeProjectAssociation.create(
        workerA.id,
        projA.id,
        'ses-a',
        'verified',
        'adoption',
        'opencode',
      ),
    );

    const pairA = await service.createPair(projA.id, 'Pair A', plannerA.id, workerA.id);
    assert.ok(pairA);

    // Create Project B with EMPTY correspondence fields
    const projB = await service.engine.createProject('Project B', '', '/dev/proj-b', '/dev/proj-b');
    // Intentionally leave plannerProjectUrl and workerWorkspacePath empty
    await db.projects.save(projB);

    // Try to bind plannerA (already paired to A) into B — must fail via association authority
    await assert.rejects(
      async () => service.createPair(projB.id, 'Pair B Bad', plannerA.id, undefined),
      /lacks matching pre-pair verified authoritative association/
    );

    // Try to bind workerA (already paired to A) into B — must fail via association authority
    await assert.rejects(
      async () => service.createPair(projB.id, 'Pair B Bad', undefined, workerA.id),
      /lacks matching pre-pair verified authoritative association/
    );
  });

  test('changing selected planner or worker session does not rewrite project correspondence fields or an earlier pair assignment', async () => {
    // 1. Create project with saved correspondence fields
    const proj = await service.engine.createProject('Isolation', '', '/dev/isolate', '/dev/isolate');
    const projectId = proj.id;
    proj.update(undefined, undefined, undefined, undefined, 'https://chatgpt.com/g/g-p-isolate', '/dev/isolate');
    await db.projects.save(proj);

    // 2. Register planner and worker runtimes
    const planner = await service.engine.registerRuntimeSession('chatgpt', 'Planner A', 'com.openai.chat');
    planner.recordObservationSuccess('available', {
      id: `ev_1`, timestamp: Date.now(), source: 'reconciliation_probe',
      details: { projectUrl: 'https://chatgpt.com/g/g-p-isolate' },
    });
    planner.updateExternalIdentity('conv-1', 'https://chatgpt.com/g/g-p-isolate');
    await db.runtimes.save(planner);

    const worker = await service.engine.registerRuntimeSession('opencode', 'Worker A', 'dev.opencode.desktop');
    worker.recordObservationSuccess('available', {
      id: `ev_2`, timestamp: Date.now(), source: 'reconciliation_probe',
      details: { sessionId: 'ses_isolate_1' },
    });
    worker.updateExternalIdentity('ses_isolate_1', '/dev/isolate');
    await db.runtimes.save(worker);
    await db.associations.save(
      RuntimeProjectAssociation.create(
        planner.id,
        projectId,
        'conv-1',
        'verified',
        'adoption',
        'chatgpt',
      ),
    );
    await db.associations.save(
      RuntimeProjectAssociation.create(
        worker.id,
        projectId,
        'ses_isolate_1',
        'verified',
        'adoption',
        'opencode',
      ),
    );

    // 3. Create pair and assignment (earlier pair)
    const pair = await service.createPair(projectId, 'Isolation Pair', planner.id, worker.id);
    assert.ok(pair);
    const assignment = await service.engine.createAssignment(pair.id as PairId, 'Task', 'Instruction');
    assert.strictEqual(assignment.projectId, projectId);

    // 4. Change planner session (bind new planner, keep pair assignment intact)
    const newPlanner = await service.engine.registerRuntimeSession('chatgpt', 'Planner B', 'com.openai.chat');
    newPlanner.recordObservationSuccess('available', {
      id: `ev_3`, timestamp: Date.now(), source: 'reconciliation_probe',
      details: { projectUrl: 'https://chatgpt.com/g/g-p-other' },
    });
    newPlanner.updateExternalIdentity('conv-2', 'https://chatgpt.com/g/g-p-other');
    await db.runtimes.save(newPlanner);
    await db.associations.save(
      RuntimeProjectAssociation.create(
        newPlanner.id,
        projectId,
        'conv-2',
        'verified',
        'adoption',
        'chatgpt',
      ),
    );

    const updatedPair = await service.updatePair(pair.id, { plannerSessionId: newPlanner.id });
    assert.strictEqual(updatedPair.plannerSessionId, newPlanner.id);

    // 5. Assert: project fields unchanged (not rewritten as binding authority)
    const fetchedProject = await db.projects.findById(projectId);
    assert.ok(fetchedProject);
    assert.strictEqual(fetchedProject!.plannerProjectUrl, 'https://chatgpt.com/g/g-p-isolate');
    assert.strictEqual(fetchedProject!.workerWorkspacePath, '/dev/isolate');

    // 6. Assert: earlier pair's assignment preserved
    const assignments = await db.assignments.findAll();
    const pairAssignments = assignments.filter((a) => a.pairId === pair.id);
    assert.strictEqual(pairAssignments.length, 1);
    assert.strictEqual(pairAssignments[0].title, 'Task');
  });
});
