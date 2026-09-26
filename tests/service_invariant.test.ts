import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import {
  Project,
  RuntimeSession,
  RuntimeProjectAssociation,
} from '../src/relay/domain/entities.ts';
import { ProviderType, ProjectId, PairId } from '../src/relay/domain/types.ts';
import { IRelayRepositories } from '../src/relay/persistence/interfaces.ts';
import { OpenCodeProvider } from '../src/relay/providers/adapters.ts';

describe('service invariant: external project reference ownership', () => {
  const makeDb = () => new SqliteRelayDatabase(':memory:');
  const makeEngine = (db: SqliteRelayDatabase) => {
    const engine = new RelayEngine({
      projects: db.projects,
      runtimes: db.runtimes,
      pairs: db.pairs,
      assignments: db.attempts,
      deliveries: db.deliveries,
      handoffs: db.handoffs,
      events: db.events,
      attention: db.attention,
      associations: db.associations,
    } as unknown as IRelayRepositories);
    // Register opencode provider so normalizeChatRef can find it
    engine.registerProvider(new OpenCodeProvider());
    return engine;
  };
  const makeApi = (db: SqliteRelayDatabase) => new RelayApiService(db, makeEngine(db));
  const authorize = async (
    db: SqliteRelayDatabase,
    projectId: ProjectId,
    runtime: RuntimeSession,
    externalSessionId: string,
    providerType: ProviderType,
  ) => {
    await db.associations.save(RuntimeProjectAssociation.create(
      runtime.id,
      projectId,
      externalSessionId,
      'verified',
      'discovery',
      providerType,
    ));
  };

  it('ChatGPT full project URL versus equivalent stored slug succeeds', async () => {
    const db = makeDb();
    const api = makeApi(db);
    const proj = new Project({ id: 'proj-1' as ProjectId, name: 'RelayX', description: '', canonicalPath: '/dev/RelayX', plannerProjectUrl: 'g-p-relayx', workerWorkspacePath: '/dev/RelayX', createdAt: Date.now(), updatedAt: Date.now() });
    await db.projects.save(proj);
    const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
    planner.updateExternalIdentity('sess-p1', 'g-p-relayx');
    await db.runtimes.save(planner);
    await authorize(db, proj.id, planner, 'sess-p1', 'chatgpt');
    const pair = await api.createPair('proj-1' as string, 'Test Pair', planner.id, undefined);
    assert.ok(pair);
    const loaded = await db.pairs.findById(pair.id as PairId);
    assert.strictEqual(loaded?.plannerSessionId, planner.id);
  });

  it('different ChatGPT project slug fails', async () => {
    const db = makeDb();
    const api = makeApi(db);
    const proj = new Project({ id: 'proj-1' as ProjectId, name: 'RelayX', description: '', canonicalPath: '/dev/RelayX', plannerProjectUrl: 'g-p-relayx', workerWorkspacePath: '/dev/RelayX', createdAt: Date.now(), updatedAt: Date.now() });
    await db.projects.save(proj);
    const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
    planner.updateExternalIdentity('sess-p1', 'g-p-other');
    await db.runtimes.save(planner);
    await authorize(db, proj.id, planner, 'sess-p1', 'chatgpt');
    await assert.rejects(async () => api.createPair('proj-1' as string, 'Test Pair', planner.id, undefined), /Cross-project/);
  });

  it('equivalent normalized worker paths succeed', async () => {
    const db = makeDb();
    const api = makeApi(db);
    const proj = new Project({ id: 'proj-1' as ProjectId, name: 'RelayX', description: '', canonicalPath: '/dev/RelayX', plannerProjectUrl: 'g-p-relayx', workerWorkspacePath: '/dev/RelayX', createdAt: Date.now(), updatedAt: Date.now() });
    await db.projects.save(proj);
    const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
    planner.updateExternalIdentity('sess-p1', 'g-p-relayx');
    await db.runtimes.save(planner);
    const worker = RuntimeSession.create('opencode' as ProviderType, 'Worker');
    worker.updateExternalIdentity('sess-w1', '/dev/RelayX');
    await db.runtimes.save(worker);
    await authorize(db, proj.id, planner, 'sess-p1', 'chatgpt');
    await authorize(db, proj.id, worker, 'sess-w1', 'opencode');
    const pair = await api.createPair('proj-1' as string, 'Test Pair', planner.id, worker.id);
    assert.ok(pair);
  });

  it('different worker path fails', async () => {
    const db = makeDb();
    const api = makeApi(db);
    const proj = new Project({ id: 'proj-1' as ProjectId, name: 'RelayX', description: '', canonicalPath: '/dev/RelayX', plannerProjectUrl: 'g-p-relayx', workerWorkspacePath: '/dev/RelayX', createdAt: Date.now(), updatedAt: Date.now() });
    await db.projects.save(proj);
    const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
    planner.updateExternalIdentity('sess-p1', 'g-p-relayx');
    await db.runtimes.save(planner);
    const worker = RuntimeSession.create('opencode' as ProviderType, 'Worker');
    worker.updateExternalIdentity('sess-w1', '/Users/lazydeepak/dev/Other');
    await db.runtimes.save(worker);
    await authorize(db, proj.id, planner, 'sess-p1', 'chatgpt');
    await authorize(db, proj.id, worker, 'sess-w1', 'opencode');
    await assert.rejects(async () => api.createPair('proj-1' as string, 'Test Pair', planner.id, worker.id), /Cross-project/);
  });

  it('empty planner project reference succeeds when no cross-project pair conflict exists', async () => {
    const db = makeDb();
    const api = makeApi(db);
    const proj = new Project({ id: 'proj-1' as ProjectId, name: 'RelayX', description: '', canonicalPath: '/dev/RelayX', plannerProjectUrl: '', workerWorkspacePath: '/dev/RelayX', createdAt: Date.now(), updatedAt: Date.now() });
    await db.projects.save(proj);
    const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
    planner.updateExternalIdentity('sess-p1', null);
    await db.runtimes.save(planner);
    const worker = RuntimeSession.create('opencode' as ProviderType, 'Worker');
    worker.updateExternalIdentity('sess-w1', '/dev/RelayX');
    await db.runtimes.save(worker);
    await authorize(db, proj.id, planner, 'sess-p1', 'chatgpt');
    await authorize(db, proj.id, worker, 'sess-w1', 'opencode');
    // No existing pair binds planner/session to another project, so pairing succeeds
    const pair = await api.createPair('proj-1' as string, 'Test Pair', planner.id, worker.id);
    assert.ok(pair);
  });

  it('empty worker workspace reference succeeds when no cross-project pair conflict exists', async () => {
    const db = makeDb();
    const api = makeApi(db);
    const proj = new Project({ id: 'proj-1' as ProjectId, name: 'RelayX', description: '', canonicalPath: '/dev/RelayX', plannerProjectUrl: 'g-p-relayx', workerWorkspacePath: '', createdAt: Date.now(), updatedAt: Date.now() });
    await db.projects.save(proj);
    const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
    planner.updateExternalIdentity('sess-p1', 'g-p-relayx');
    await db.runtimes.save(planner);
    const worker = RuntimeSession.create('opencode' as ProviderType, 'Worker');
    worker.updateExternalIdentity('sess-w1', null);
    await db.runtimes.save(worker);
    await authorize(db, proj.id, planner, 'sess-p1', 'chatgpt');
    await authorize(db, proj.id, worker, 'sess-w1', 'opencode');
    // No existing pair binds worker/session to another project, so pairing succeeds
    const pair = await api.createPair('proj-1' as string, 'Test Pair', planner.id, worker.id);
    assert.ok(pair);
  });
});
