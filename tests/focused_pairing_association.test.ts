import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { ProjectId, ProviderType, RuntimeSessionId } from '../src/relay/domain/types.ts';

async function makeProject(
  service: RelayApiService,
  name: string,
  slug: string,
  path: string,
) {
  const project = await service.engine.createProject(name, '', path, path);
  project.update(
    undefined,
    undefined,
    undefined,
    undefined,
    `https://chatgpt.com/g/${slug}`,
    path,
  );
  await service.db.projects.save(project);
  return project;
}

async function makeRuntime(
  service: RelayApiService,
  providerType: ProviderType,
  name: string,
  externalSessionId: string | null,
  externalProjectRef: string | null,
) {
  const runtime = await service.engine.registerRuntimeSession(
    providerType,
    name,
    providerType === 'chatgpt' ? 'com.openai.chat' : 'dev.opencode.desktop',
  );
  runtime.updateExternalIdentity(externalSessionId, externalProjectRef);
  await service.db.runtimes.save(runtime);
  return runtime;
}

function evidence(
  runtimeId: RuntimeSessionId,
  projectId: ProjectId,
  externalSessionId: string,
  providerType: ProviderType,
  provenance: RuntimeProjectAssociation['provenance'] = 'adoption',
) {
  return RuntimeProjectAssociation.create(
    runtimeId,
    projectId,
    externalSessionId,
    'verified',
    provenance,
    providerType,
  );
}

describe('Focused pairing + authoritative association rules (isolated SQLite)', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;

  before(async () => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    // Test-only confirmation stub; it performs no provider or network action.
    engine.registerProvider({
      providerType: 'opencode',
      integrationStatus: 'partial',
      confirmSessionForProject: async (sessionId: string, projectPath: string) => ({
        confirmed: sessionId === 'ses_exact',
        externalSessionId: sessionId,
        projectPath,
      }),
    } as any);
    service = new RelayApiService(db, engine);
  });

  after(async () => {
    db.close();
  });

  test('adopted sessions with exact pre-pair rows succeed without pair_binding promotion', async () => {
    const project = await makeProject(service, 'AdoptExact', 'g-p-exact', '/dev/exact');
    const planner = await makeRuntime(service, 'chatgpt', 'PlannerExact', 'conv-b', 'g-p-exact');
    await db.associations.save(evidence(planner.id, project.id, 'conv-b', 'chatgpt'));
    const worker = await service.adoptOpenCodeSession(project.id, 'ses_exact', 'WorkerExact');

    const beforeRows = {
      planner: await db.associations.findBySessionId(planner.id),
      worker: await db.associations.findBySessionId(worker.id as RuntimeSessionId),
    };
    assert.strictEqual(beforeRows.planner.length, 1);
    assert.strictEqual(beforeRows.worker.length, 1);
    assert.strictEqual(beforeRows.planner[0].providerType, 'chatgpt');
    assert.strictEqual(beforeRows.planner[0].externalSessionId, 'conv-b');
    assert.strictEqual(beforeRows.planner[0].projectId, project.id);
    assert.strictEqual(beforeRows.worker[0].providerType, 'opencode');
    assert.strictEqual(beforeRows.worker[0].externalSessionId, 'ses_exact');
    assert.strictEqual(beforeRows.worker[0].projectId, project.id);

    const pair = await service.createPair(project.id, 'ExactPair', planner.id, worker.id);
    assert.ok(pair);

    const afterRows = {
      planner: await db.associations.findBySessionId(planner.id),
      worker: await db.associations.findBySessionId(worker.id as RuntimeSessionId),
    };
    assert.deepStrictEqual(afterRows, beforeRows);
    assert.ok(afterRows.planner.every((row) => row.provenance !== 'pair_binding'));
    assert.ok(afterRows.worker.every((row) => row.provenance !== 'pair_binding'));
  });

  test('pair_binding and manual_registration do not authorize a non-null runtime', async () => {
    const project = await makeProject(service, 'RejectNonAuthoritative', 'g-p-reject', '/dev/reject');
    const planner = await makeRuntime(service, 'chatgpt', 'ManualPlanner', 'conv-manual', 'g-p-reject');
    const worker = await makeRuntime(service, 'opencode', 'ManualWorker', 'ses-manual', '/dev/reject');
    await db.associations.save(
      evidence(planner.id, project.id, 'conv-manual', 'chatgpt', 'pair_binding'),
    );
    await db.associations.save(
      evidence(worker.id, project.id, 'ses-manual', 'opencode', 'manual_registration'),
    );

    const beforeRows = {
      planner: await db.associations.findBySessionId(planner.id),
      worker: await db.associations.findBySessionId(worker.id as RuntimeSessionId),
    };
    await assert.rejects(
      () => service.createPair(project.id, 'MustReject', planner.id, worker.id),
      /planner session lacks matching pre-pair verified authoritative association/,
    );
    assert.deepStrictEqual(await db.pairs.findByProjectId(project.id), []);
    assert.deepStrictEqual(
      {
        planner: await db.associations.findBySessionId(planner.id),
        worker: await db.associations.findBySessionId(worker.id as RuntimeSessionId),
      },
      beforeRows,
    );
  });

  test('verified evidence must match exact external session identity and target project', async () => {
    const project = await makeProject(service, 'Mismatch', 'g-p-mismatch', '/dev/mismatch');
    const other = await makeProject(service, 'Other', 'g-p-other', '/dev/other');
    const planner = await makeRuntime(service, 'chatgpt', 'MismatchPlanner', 'conv-mismatch', 'g-p-mismatch');
    const worker = await makeRuntime(service, 'opencode', 'MismatchWorker', 'ses-mismatch', '/dev/mismatch');

    // Same provider/project but wrong conversation identity: a manually set
    // runtime value cannot substitute for the exact evidence row.
    await db.associations.save(evidence(planner.id, project.id, 'conv-other', 'chatgpt'));
    await db.associations.save(evidence(worker.id, project.id, 'ses-mismatch', 'opencode'));
    await assert.rejects(
      () => service.createPair(project.id, 'WrongConversation', planner.id, worker.id),
      /planner session lacks matching pre-pair verified authoritative association/,
    );
    assert.deepStrictEqual(await db.pairs.findByProjectId(project.id), []);

    // Provider is part of the evidence identity too; a ChatGPT runtime cannot
    // borrow an otherwise matching OpenCode evidence row.
    const providerMismatchPlanner = await makeRuntime(
      service,
      'chatgpt',
      'ProviderMismatchPlanner',
      'conv-provider',
      'g-p-mismatch',
    );
    await db.associations.save(
      evidence(providerMismatchPlanner.id, project.id, 'conv-provider', 'opencode'),
    );
    await assert.rejects(
      () => service.createPair(project.id, 'WrongProvider', providerMismatchPlanner.id, worker.id),
      /planner session lacks matching pre-pair verified authoritative association/,
    );
    assert.deepStrictEqual(await db.pairs.findByProjectId(project.id), []);

    // A verified row for another local project is not a match for this target.
    // Use a second planner whose evidence is valid so the worker is the
    // session that reaches the mismatch gate.
    const validPlanner = await makeRuntime(service, 'chatgpt', 'ValidPlanner', 'conv-project', 'g-p-mismatch');
    await db.associations.save(evidence(validPlanner.id, project.id, 'conv-project', 'chatgpt'));
    const workerForOther = await makeRuntime(service, 'opencode', 'OtherWorker', 'ses-other', '/dev/other');
    await db.associations.save(evidence(workerForOther.id, other.id, 'ses-other', 'opencode'));
    await assert.rejects(
      () => service.createPair(project.id, 'WrongProject', validPlanner.id, workerForOther.id),
      /worker session lacks matching pre-pair verified authoritative association/,
    );
    assert.deepStrictEqual(await db.pairs.findByProjectId(project.id), []);
  });

  test('a verified legacy row without provider evidence stops with the exact schema gap', async () => {
    const project = await makeProject(service, 'SchemaGap', 'g-p-gap', '/dev/gap');
    const planner = await makeRuntime(service, 'chatgpt', 'SchemaPlanner', 'conv-gap', 'g-p-gap');
    const worker = await makeRuntime(service, 'opencode', 'SchemaWorker', 'ses-gap', '/dev/gap');
    const legacy = RuntimeProjectAssociation.create(
      planner.id,
      project.id,
      'conv-gap',
      'verified',
      'adoption',
      null,
    );
    await db.associations.save(legacy);
    await db.associations.save(evidence(worker.id, project.id, 'ses-gap', 'opencode'));

    await assert.rejects(
      () => service.createPair(project.id, 'SchemaGapPair', planner.id, worker.id),
      (error: Error) => {
        assert.match(error.message, /Association schema gap/);
        assert.match(error.message, /provider_type/);
        assert.doesNotMatch(error.message, /external_session_id/);
        return true;
      },
    );
    assert.deepStrictEqual(await db.pairs.findByProjectId(project.id), []);
    assert.strictEqual((await db.associations.findBySessionId(planner.id)).length, 1);
  });
});
