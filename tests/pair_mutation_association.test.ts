import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { PairId, ProjectId, ProviderType, RuntimeSessionId } from '../src/relay/domain/types.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { IRelayRepositories } from '../src/relay/persistence/interfaces.ts';

async function makeProject(
  service: RelayApiService,
  name: string,
  path: string,
) {
  const project = await service.engine.createProject(name, '', path, path);
  project.update(
    undefined,
    undefined,
    undefined,
    undefined,
    `https://chatgpt.com/g/g-p-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    path,
  );
  await service.db.projects.save(project);
  return project;
}

async function makeRuntime(
  service: RelayApiService,
  providerType: ProviderType,
  name: string,
  externalSessionId: string,
  externalProjectRef: string,
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

function addEvidence(
  db: SqliteRelayDatabase,
  runtimeId: RuntimeSessionId,
  projectId: ProjectId,
  externalSessionId: string,
  providerType: ProviderType,
  provenance: RuntimeProjectAssociation['provenance'] = 'adoption',
) {
  return db.associations.save(
    RuntimeProjectAssociation.create(
      runtimeId,
      projectId,
      externalSessionId,
      'verified',
      provenance,
      providerType,
    ),
  );
}

describe('All pair session-selection mutations use the exact association gate (isolated SQLite)', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;

  before(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    // Test-only provider confirmation stub; it performs no live provider work.
    engine.registerProvider({
      providerType: 'opencode',
      integrationStatus: 'partial',
      confirmSessionForProject: async (sessionId: string, projectPath: string) => ({
        confirmed: true,
        externalSessionId: sessionId,
        projectPath,
      }),
    } as any);
    service = new RelayApiService(db, engine);
  });

  after(() => {
    db.close();
  });

  test('service update/rebind and direct engine update reject unverified replacement sessions without changing the pair', async () => {
    const project = await makeProject(service, 'MutationGate', '/dev/mutation-gate');
    const planner = await makeRuntime(
      service,
      'chatgpt',
      'PlannerOriginal',
      'conv-original',
      'https://chatgpt.com/g/g-p-mutationgate',
    );
    const worker = await makeRuntime(
      service,
      'opencode',
      'WorkerOriginal',
      'ses_original',
      '/dev/mutation-gate',
    );
    await addEvidence(db, planner.id, project.id, 'conv-original', 'chatgpt');
    await addEvidence(db, worker.id, project.id, 'ses_original', 'opencode');

    const pair = await service.createPair(
      project.id,
      'HistoricalPair',
      planner.id,
      worker.id,
    );
    const replacementPlanner = await makeRuntime(
      service,
      'chatgpt',
      'PlannerUnverified',
      'conv-unverified',
      'https://chatgpt.com/g/g-p-mutationgate',
    );
    const replacementWorker = await makeRuntime(
      service,
      'opencode',
      'WorkerUnverified',
      'ses-unverified',
      '/dev/mutation-gate',
    );

    const before = await db.pairs.findById(pair.id as PairId);
    assert.ok(before);

    await assert.rejects(
      () => service.updatePair(pair.id, { plannerSessionId: replacementPlanner.id }),
      /planner session lacks matching pre-pair verified authoritative association/,
    );
    await assert.rejects(
      () => service.rebindPairPlanner(pair.id, replacementPlanner.id),
      /planner session lacks matching pre-pair verified authoritative association/,
    );
    await assert.rejects(
      () => service.rebindPairWorker(pair.id, replacementWorker.id),
      /worker session lacks matching pre-pair verified authoritative association/,
    );
    await assert.rejects(
      () => engine.updatePair(pair.id as PairId, { workerSessionId: replacementWorker.id }),
      /worker session lacks matching pre-pair verified authoritative association/,
    );

    const afterRejected = await db.pairs.findById(pair.id as PairId);
    assert.deepStrictEqual(
      {
        plannerSessionId: afterRejected?.plannerSessionId,
        workerSessionId: afterRejected?.workerSessionId,
        name: afterRejected?.name,
      },
      {
        plannerSessionId: before?.plannerSessionId,
        workerSessionId: before?.workerSessionId,
        name: before?.name,
      },
    );
    assert.deepStrictEqual(await db.associations.findBySessionId(replacementPlanner.id), []);
    assert.deepStrictEqual(await db.associations.findBySessionId(replacementWorker.id), []);

    // A verified replacement is allowed and is the only mutation that changes
    // the selected runtime; the historical pair and its project remain intact.
    await addEvidence(db, replacementPlanner.id, project.id, 'conv-unverified', 'chatgpt');
    const updated = await service.updatePair(pair.id, {
      plannerSessionId: replacementPlanner.id,
    });
    assert.strictEqual(updated.plannerSessionId, replacementPlanner.id);
    assert.strictEqual(updated.id, pair.id);

    // Detaching selects no new runtime and remains allowed without association
    // evidence for the removed historical session.
    const detached = await service.detachPairRuntime(pair.id, 'planner');
    assert.strictEqual(detached.plannerSessionId, undefined);

    // A direct engine create is guarded too, even without going through the API.
    const directProject = await makeProject(service, 'DirectEngineGate', '/dev/direct-engine');
    const directRuntime = await makeRuntime(
      service,
      'opencode',
      'DirectUnverified',
      'ses-direct-unverified',
      '/dev/direct-engine',
    );
    await assert.rejects(
      () => engine.createPair(directProject.id, 'DirectPair', undefined, directRuntime.id),
      /worker session lacks matching pre-pair verified authoritative association/,
    );
    assert.deepStrictEqual(await db.pairs.findByProjectId(directProject.id), []);
  });

  test('a missing association repository fails closed with the exact schema-gap error', async () => {
    const project = await makeProject(service, 'SchemaGapGate', '/dev/schema-gap');
    const planner = await makeRuntime(
      service,
      'chatgpt',
      'SchemaGapPlanner',
      'conv-schema-gap',
      'https://chatgpt.com/g/g-p-schemagapgate',
    );
    const gapEngine = new RelayEngine({
      projects: db.projects,
      runtimes: db.runtimes,
      pairs: db.pairs,
      assignments: db.assignments,
      attempts: db.attempts,
      deliveries: db.deliveries,
      handoffs: db.handoffs,
      events: db.events,
      attention: db.attention,
      associations: undefined,
      runInTransaction: db.runInTransaction.bind(db),
    } as unknown as IRelayRepositories);
    const gapService = new RelayApiService(db, gapEngine);

    await assert.rejects(
      () => gapService.createPair(project.id, 'SchemaGapPair', planner.id, undefined),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(
          error.message,
          'Association schema gap: repository cannot verify runtime_session_id, provider_type, external_session_id, and project_id for pre-pair evidence',
        );
        return true;
      },
    );
    assert.deepStrictEqual(await db.pairs.findByProjectId(project.id), []);
  });

  test('a null external identity is queried and fails closed with the schema-gap contract', async () => {
    const project = await makeProject(service, 'NullIdentityGate', '/dev/null-identity');
    const planner = await makeRuntime(
      service,
      'chatgpt',
      'NullIdentityPlanner',
      'conv-null',
      'https://chatgpt.com/g/g-p-nullidentitygate',
    );
    planner.updateExternalIdentity(null, null);
    await db.runtimes.save(planner);
    await db.associations.save(
      RuntimeProjectAssociation.create(
        planner.id,
        project.id,
        null,
        'verified',
        'discovery',
        'chatgpt',
      ),
    );

    await assert.rejects(
      () => service.createPair(project.id, 'NullIdentityPair', planner.id, undefined),
      /Association schema gap/,
    );
    assert.deepStrictEqual(await db.pairs.findByProjectId(project.id), []);
  });

  test('caller-supplied OpenCode adoption requires provider confirmation and never promotes historical placeholders', async () => {
    const noProviderEngine = new RelayEngine(db);
    const noProviderService = new RelayApiService(db, noProviderEngine);
    const unconfirmedProject = await makeProject(
      noProviderService,
      'UnconfirmedAdoption',
      '/dev/unconfirmed-adoption',
    );

    await assert.rejects(
      () => noProviderService.adoptOpenCodeSession(
        unconfirmedProject.id,
        'ses_caller_supplied',
        'CallerSupplied',
      ),
      /requires provider confirmation/,
    );
    assert.strictEqual(
      await db.runtimes.findByExternalSessionId(
        'opencode',
        'ses_caller_supplied' as RuntimeSessionId,
      ),
      null,
    );
    assert.deepStrictEqual(
      await db.associations.findByProjectId(unconfirmedProject.id),
      [],
    );

    const confirmedProject = await makeProject(
      service,
      'ConfirmedAdoption',
      '/dev/confirmed-adoption',
    );
    const adopted = await service.adoptOpenCodeSession(
      confirmedProject.id,
      'ses_provider_confirmed',
      'ProviderConfirmed',
    );
    const adoptedRows = await db.associations.findBySessionId(adopted.id as RuntimeSessionId);
    assert.strictEqual(adoptedRows.length, 1);
    assert.strictEqual(adoptedRows[0].providerType, 'opencode');
    assert.strictEqual(adoptedRows[0].externalSessionId, 'ses_provider_confirmed');
    assert.strictEqual(adoptedRows[0].verificationState, 'verified');
    assert.strictEqual(adoptedRows[0].provenance, 'adoption');

    const placeholderProject = await makeProject(
      service,
      'HistoricalPlaceholder',
      '/dev/historical-placeholder',
    );
    const placeholderRuntime = await makeRuntime(
      service,
      'opencode',
      'HistoricalPlaceholderRuntime',
      'ses_historical_placeholder',
      '/dev/historical-placeholder',
    );
    await db.associations.save(
      RuntimeProjectAssociation.create(
        placeholderRuntime.id,
        placeholderProject.id,
        'ses_historical_placeholder',
        'verified',
        'pair_binding',
        'opencode',
      ),
    );
    const beforePlaceholder = await db.associations.findBySessionId(placeholderRuntime.id);

    await assert.rejects(
      () => service.adoptOpenCodeSession(
        placeholderProject.id,
        'ses_historical_placeholder',
        'MustNotPromote',
      ),
      /refusing to promote/,
    );
    assert.deepStrictEqual(
      await db.associations.findBySessionId(placeholderRuntime.id),
      beforePlaceholder,
    );
  });

  test('setup and demo paths do not select caller-supplied or simulated runtimes', async () => {
    const setupDb = new SqliteRelayDatabase(':memory:');
    try {
      const setupEngine = new RelayEngine(setupDb);
      const setupService = new RelayApiService(setupDb, setupEngine);
      const setup = await setupService.finalizeProjectSetup({
        name: 'UnverifiedSetup',
        description: '',
        canonicalPath: '/dev/unverified-setup',
        plannerUrl: 'https://chatgpt.com/g/g-p-unverified-setup',
        workerSessionId: 'ses_caller_setup',
      });
      assert.strictEqual(setup.success, true);
      assert.ok(setup.projectId);
      assert.deepStrictEqual(await setupDb.pairs.findByProjectId(setup.projectId), []);

      const setupRuntime = await setupDb.runtimes.findByExternalSessionId(
        'opencode',
        'ses_caller_setup',
      );
      assert.ok(setupRuntime);
      assert.deepStrictEqual(
        await setupDb.associations.findBySessionId(setupRuntime!.id),
        [],
      );
    } finally {
      setupDb.close();
    }

    const demoDb = new SqliteRelayDatabase(':memory:');
    try {
      const demoEngine = new RelayEngine(demoDb);
      const demoService = new RelayApiService(demoDb, demoEngine);
      const demo = await demoService.seedDemoEnvironment();
      assert.deepStrictEqual(demo, { success: true, seeded: true });
      const demoPairs = await demoDb.pairs.findAll();
      assert.strictEqual(demoPairs.length, 1);
      assert.strictEqual(demoPairs[0].plannerSessionId, undefined);
      assert.strictEqual(demoPairs[0].workerSessionId, undefined);
    } finally {
      demoDb.close();
    }
  });
});
