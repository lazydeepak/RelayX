import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { RuntimeSessionId } from '../src/relay/domain/types.ts';

describe('Manual non-null externalSessionId rejected — no provider-verified evidence', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;

  before(async () => {
    // Deliberately isolated in-memory SQLite: no live database or provider is used.
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    // Test-only provider confirmation stub: no live provider or network access.
    engine.registerProvider({
      providerType: 'opencode',
      integrationStatus: 'partial',
      confirmSessionForProject: async (sessionId: string, projectPath: string) => ({
        confirmed: sessionId === 'ses_adopt_b',
        externalSessionId: sessionId,
        projectPath,
      }),
    } as any);
    service = new RelayApiService(db, engine);
  });

  after(async () => {
    db.close();
  });

  test('manual non-null planner externalSessionId is rejected at the pre-pair association gate', async () => {
    const project = await service.engine.createProject(
      'ManualNonNull',
      '',
      '/dev/mnn',
      '/dev/mnn',
    );
    project.update(
      undefined,
      undefined,
      undefined,
      undefined,
      'https://chatgpt.com/g/g-p-mnn',
      '/dev/mnn',
    );
    await db.projects.save(project);

    const worker = await service.engine.registerRuntimeSession(
      'opencode',
      'ManualWorker',
      'dev.opencode.desktop',
    );
    // Plausible-looking but manually populated identity; it is not evidence.
    worker.updateExternalIdentity('ses_real', '/dev/mnn');
    await db.runtimes.save(worker);

    const planner = await service.engine.registerRuntimeSession(
      'chatgpt',
      'ManualPlanner',
      'com.openai.chat',
    );
    // Crucially, this is non-null. The null-ID gate cannot be the rejection.
    // Keep conversation identity (conv-manual) separate from project reference
    // (g-p-mnn).
    planner.updateExternalIdentity('conv-manual', 'g-p-mnn');
    await db.runtimes.save(planner);

    const call = {
      projectId: project.id,
      plannerSessionId: planner.id,
      workerSessionId: worker.id,
    };
    const preRows = {
      planner: await db.associations.findBySessionId(planner.id),
      worker: await db.associations.findBySessionId(worker.id as RuntimeSessionId),
    };
    console.log('MANUAL_NON_NULL_CREATE_PAIR_INPUTS', JSON.stringify(call));
    console.log(
      'MANUAL_NON_NULL_PRE_ASSOCIATIONS',
      JSON.stringify(preRows, null, 2),
    );
    assert.deepStrictEqual(preRows.planner, []);
    assert.deepStrictEqual(preRows.worker, []);

    let thrown: unknown;
    try {
      await service.createPair(
        project.id,
        'ManualPair',
        planner.id,
        worker.id,
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof Error);
    console.log('MANUAL_NON_NULL_THROWN_ERROR', thrown.message);
    console.log('MANUAL_NON_NULL_THROWN_STACK', thrown.stack);
    assert.match(
      thrown.message,
      /planner session lacks matching pre-pair verified authoritative association/,
    );
    assert.doesNotMatch(thrown.message, /lacks authoritative external session identity/);

    // Failure must happen before pair creation and must not fabricate a
    // pair_binding or any other association row.
    assert.deepStrictEqual(await db.pairs.findByProjectId(project.id), []);
    assert.deepStrictEqual(
      await db.associations.findBySessionId(planner.id),
      [],
    );
    assert.deepStrictEqual(
      await db.associations.findBySessionId(worker.id as RuntimeSessionId),
      [],
    );
    const plannerAfter = await db.runtimes.findById(planner.id);
    const workerAfter = await db.runtimes.findById(worker.id);
    assert.strictEqual(plannerAfter?.externalSessionId, 'conv-manual');
    assert.strictEqual(plannerAfter?.externalProjectRef, 'g-p-mnn');
    assert.strictEqual(workerAfter?.externalSessionId, 'ses_real');
  });

  test('authoritative adopted sessions with exact pre-pair evidence pair successfully', async () => {
    const project = await service.engine.createProject(
      'AdoptVerified',
      '',
      '/dev/av',
      '/dev/av',
    );
    project.update(
      undefined,
      undefined,
      undefined,
      undefined,
      'https://chatgpt.com/g/g-p-b',
      '/dev/av',
    );
    await db.projects.save(project);

    // The conversation identity is conv-b; g-p-b is only the ChatGPT project
    // reference. They must never be treated as the same field.
    const planner = await service.engine.registerRuntimeSession(
      'chatgpt',
      'PlannerB',
      'com.openai.chat',
    );
    planner.updateExternalIdentity('conv-b', 'g-p-b');
    await db.runtimes.save(planner);

    // This row models provider/adoption evidence recorded before pairing. It
    // is deliberately not pair_binding and does not rely on the caller's URL.
    const plannerEvidence = RuntimeProjectAssociation.create(
      planner.id,
      project.id,
      'conv-b',
      'verified',
      'adoption',
      'chatgpt',
    );
    await db.associations.save(plannerEvidence);

    const worker = await service.adoptOpenCodeSession(
      project.id,
      'ses_adopt_b',
      'AdoptedWorker',
    );
    assert.strictEqual(worker.externalSessionId, 'ses_adopt_b');

    const preRows = {
      planner: await db.associations.findBySessionId(planner.id),
      worker: await db.associations.findBySessionId(worker.id as RuntimeSessionId),
    };
    console.log(
      'ADOPTED_PRE_ASSOCIATIONS',
      JSON.stringify(preRows, null, 2),
    );
    assert.strictEqual(preRows.planner.length, 1);
    assert.strictEqual(preRows.worker.length, 1);
    assert.deepStrictEqual(
      {
        runtimeSessionId: preRows.planner[0].runtimeSessionId,
        providerType: preRows.planner[0].providerType,
        externalSessionId: preRows.planner[0].externalSessionId,
        projectId: preRows.planner[0].projectId,
        provenance: preRows.planner[0].provenance,
      },
      {
        runtimeSessionId: planner.id,
        providerType: 'chatgpt',
        externalSessionId: 'conv-b',
        projectId: project.id,
        provenance: 'adoption',
      },
    );
    assert.deepStrictEqual(
      {
        providerType: preRows.worker[0].providerType,
        externalSessionId: preRows.worker[0].externalSessionId,
        projectId: preRows.worker[0].projectId,
        provenance: preRows.worker[0].provenance,
      },
      {
        providerType: 'opencode',
        externalSessionId: 'ses_adopt_b',
        projectId: project.id,
        provenance: 'adoption',
      },
    );

    // A caller-supplied URL is only a validated request, not the evidence. The
    // existing pre-pair rows are what authorize this call.
    const pair = await service.createPair(
      project.id,
      'AdoptVerifiedPair',
      planner.id,
      worker.id,
      'https://chatgpt.com/g/g-p-b/c/conv-b',
    );
    assert.ok(pair);
    assert.strictEqual(pair.plannerSessionId, planner.id);
    assert.strictEqual(pair.workerSessionId, worker.id);

    const postRows = {
      planner: await db.associations.findBySessionId(planner.id),
      worker: await db.associations.findBySessionId(worker.id as RuntimeSessionId),
    };
    assert.deepStrictEqual(postRows, preRows);
    const plannerAfter = await db.runtimes.findById(planner.id);
    assert.strictEqual(plannerAfter?.externalSessionId, 'conv-b');
    assert.strictEqual(plannerAfter?.externalProjectRef, 'https://chatgpt.com/g/g-p-b/project');
  });
});
