import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Project, RuntimeSession } from '../src/relay/domain/entities.ts';
import { ProviderType, ProjectId, RuntimeSessionId } from '../src/relay/domain/types.ts';
import { ChatGPTProvider, parseChatGPTConversationUrl } from '../src/relay/providers/adapters.ts';

describe('parseChatGPTConversationUrl (strict project conversation URL parser)', () => {
  it('parses a valid chatgpt.com project conversation URL', () => {
    assert.deepStrictEqual(
      parseChatGPTConversationUrl('https://chatgpt.com/g/g-p-123abc-my-project/c/conv-xyz-999'),
      { projectId: 'g-p-123abc-my-project', conversationId: 'conv-xyz-999' },
    );
  });

  it('parses www.chatgpt.com hosts and returns the conversation id via the provider method', () => {
    assert.deepStrictEqual(
      parseChatGPTConversationUrl('https://www.chatgpt.com/g/g-p-x/c/conv1'),
      { projectId: 'g-p-x', conversationId: 'conv1' },
    );
    assert.strictEqual(
      new ChatGPTProvider().extractChatGPTConversationId('https://chatgpt.com/g/g-p-x/c/conv1'),
      'conv1',
    );
  });

  it('rejects project roots (no conversation segment)', () => {
    assert.strictEqual(parseChatGPTConversationUrl('https://chatgpt.com/g/g-p-123abc-my-project'), null);
    assert.strictEqual(parseChatGPTConversationUrl('https://chatgpt.com/g/g-p-123abc-my-project/project'), null);
  });

  it('rejects bare /c/ URLs without a g-p- project', () => {
    assert.strictEqual(parseChatGPTConversationUrl('https://chatgpt.com/c/standard-chat-id'), null);
    assert.strictEqual(parseChatGPTConversationUrl('https://chatgpt.com/g/g-customgpt123-some-bot/c/abc'), null);
  });

  it('rejects off-host and malformed URLs', () => {
    assert.strictEqual(parseChatGPTConversationUrl('https://example.com/g/g-p-x/c/conv1'), null);
    // hostname must END with chatgpt.com — a phishing subdomain must not pass
    assert.strictEqual(parseChatGPTConversationUrl('https://evilchatgpt.com/g/g-p-x/c/conv1'), null);
    assert.strictEqual(parseChatGPTConversationUrl('not-a-url'), null);
    assert.strictEqual(parseChatGPTConversationUrl(''), null);
    assert.strictEqual(parseChatGPTConversationUrl(undefined as unknown as string), null);
  });

  it('rejects trailing path segments and empty conversation IDs', () => {
    assert.strictEqual(parseChatGPTConversationUrl('https://chatgpt.com/g/g-p-x/c/conv1/extra'), null);
    assert.strictEqual(parseChatGPTConversationUrl('https://chatgpt.com/g/g-p-x/c/'), null);
    assert.strictEqual(parseChatGPTConversationUrl('https://chatgpt.com/g/g-p-x/c'), null);
  });
});

describe('service boundary: explicit ChatGPT conversation binding contract', () => {
  const makeDb = () => new SqliteRelayDatabase(':memory:');
  const makeApi = (db: SqliteRelayDatabase): { api: RelayApiService; engine: RelayEngine } => {
    const engine = new RelayEngine(db);
    engine.registerProvider(new ChatGPTProvider());
    return { api: new RelayApiService(db, engine), engine };
  };

  const seedProject = async (db: SqliteRelayDatabase, plannerProjectUrl = 'g-p-relayx') => {
    const proj = new Project({
      id: 'proj-1' as ProjectId,
      name: 'RelayX',
      description: '',
      canonicalPath: '/dev/RelayX',
      plannerProjectUrl,
      workerWorkspacePath: '/dev/RelayX',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.projects.save(proj);
    return proj;
  };

  const makeChatgptRuntime = async (
    db: SqliteRelayDatabase,
    name: string,
    identity: { sessionId?: string | null; projectRef?: string | null } = {},
  ): Promise<RuntimeSession> => {
    const runtime = RuntimeSession.create('chatgpt' as ProviderType, name);
    runtime.updateExternalIdentity(
      identity.sessionId === undefined ? null : identity.sessionId,
      identity.projectRef === undefined ? null : identity.projectRef,
    );
    await db.runtimes.save(runtime);
    return runtime;
  };

  const makeWorker = async (db: SqliteRelayDatabase): Promise<RuntimeSession> => {
    const worker = RuntimeSession.create('opencode' as ProviderType, 'Worker');
    worker.updateExternalIdentity(null, '/dev/RelayX');
    await db.runtimes.save(worker);
    return worker;
  };

  it('binds the conversation ID onto the selected planner runtime only, atomically', async () => {
    const db = makeDb();
    const { api } = makeApi(db);
    await seedProject(db);
    const planner = await makeChatgptRuntime(db, 'Planner', { projectRef: 'g-p-relayx' });
    const worker = await makeWorker(db);
    const otherPlanner = await makeChatgptRuntime(db, 'Other Planner', { projectRef: 'g-p-relayx' });

    const pair = await api.createPair(
      'proj-1' as string,
      'Bound Pair',
      planner.id as string,
      worker.id as string,
      'https://chatgpt.com/g/g-p-relayx/c/conv-abc-123',
    );
    assert.ok(pair);
    assert.strictEqual(pair.plannerSessionId, planner.id);

    const reloaded = await db.runtimes.findById(planner.id as RuntimeSessionId);
    assert.strictEqual(reloaded?.externalSessionId, 'conv-abc-123');
    assert.strictEqual(reloaded?.externalProjectRef, 'https://chatgpt.com/g/g-p-relayx/project');

    // The exact conversation now resolves to the bound runtime.
    const byId = await db.runtimes.findByExternalSessionId('chatgpt', 'conv-abc-123');
    assert.strictEqual(byId?.id, planner.id);

    // Only the SELECTED runtime is bound: worker and other chatgpt runtimes untouched.
    const workerReloaded = await db.runtimes.findById(worker.id as RuntimeSessionId);
    assert.strictEqual(workerReloaded?.externalSessionId, null);
    const otherReloaded = await db.runtimes.findById(otherPlanner.id as RuntimeSessionId);
    assert.strictEqual(otherReloaded?.externalSessionId, null);
    assert.strictEqual(otherReloaded?.externalProjectRef, 'g-p-relayx');
  });

  it('rejects a project root URL (no conversation) and leaves runtime and pairs unchanged', async () => {
    const db = makeDb();
    const { api } = makeApi(db);
    await seedProject(db);
    const planner = await makeChatgptRuntime(db, 'Planner', { projectRef: 'g-p-relayx' });
    const worker = await makeWorker(db);

    await assert.rejects(
      () => api.createPair('proj-1' as string, 'Bad', planner.id as string, worker.id as string, 'https://chatgpt.com/g/g-p-relayx/project'),
      /Invalid ChatGPT conversation URL/,
    );
    const reloaded = await db.runtimes.findById(planner.id as RuntimeSessionId);
    assert.strictEqual(reloaded?.externalSessionId, null);
    assert.strictEqual(reloaded?.externalProjectRef, 'g-p-relayx');
    assert.strictEqual((await db.pairs.findAll()).length, 0);
  });

  it('rejects an off-host URL and leaves runtime and pairs unchanged', async () => {
    const db = makeDb();
    const { api } = makeApi(db);
    await seedProject(db);
    const planner = await makeChatgptRuntime(db, 'Planner', { projectRef: 'g-p-relayx' });
    const worker = await makeWorker(db);

    await assert.rejects(
      () => api.createPair('proj-1' as string, 'Bad', planner.id as string, worker.id as string, 'https://example.com/g/g-p-relayx/c/conv1'),
      /Invalid ChatGPT conversation URL/,
    );
    assert.strictEqual((await db.runtimes.findById(planner.id as RuntimeSessionId))?.externalSessionId, null);
    assert.strictEqual((await db.pairs.findAll()).length, 0);
  });

  it('rejects a conversation URL whose project does not match the paired project', async () => {
    const db = makeDb();
    const { api } = makeApi(db);
    await seedProject(db); // plannerProjectUrl = g-p-relayx
    const planner = await makeChatgptRuntime(db, 'Planner', { projectRef: 'g-p-relayx' });
    const worker = await makeWorker(db);

    await assert.rejects(
      () => api.createPair('proj-1' as string, 'Bad', planner.id as string, worker.id as string, 'https://chatgpt.com/g/g-p-other/c/conv1'),
      /Cross-project pairing: conversation belongs to different ChatGPT project/,
    );
    const reloaded = await db.runtimes.findById(planner.id as RuntimeSessionId);
    assert.strictEqual(reloaded?.externalSessionId, null);
    assert.strictEqual(reloaded?.externalProjectRef, 'g-p-relayx');
    assert.strictEqual((await db.pairs.findAll()).length, 0);
  });

  it('rejects when the selected planner runtime already carries a different external session ID', async () => {
    const db = makeDb();
    const { api } = makeApi(db);
    await seedProject(db);
    const planner = await makeChatgptRuntime(db, 'Planner', { sessionId: 'conv-keep', projectRef: 'g-p-relayx' });
    const worker = await makeWorker(db);

    await assert.rejects(
      () => api.createPair('proj-1' as string, 'Bad', planner.id as string, worker.id as string, 'https://chatgpt.com/g/g-p-relayx/c/conv-new'),
      /Planner runtime is already bound to ChatGPT conversation 'conv-keep'/,
    );
    // Persisted identity is preserved — never replaced by an observed alternative.
    const reloaded = await db.runtimes.findById(planner.id as RuntimeSessionId);
    assert.strictEqual(reloaded?.externalSessionId, 'conv-keep');
    assert.strictEqual((await db.pairs.findAll()).length, 0);
  });

  it('rejects a conversation ID already bound to a different runtime', async () => {
    const db = makeDb();
    const { api } = makeApi(db);
    await seedProject(db);
    const boundRuntime = await makeChatgptRuntime(db, 'Bound Runtime', { sessionId: 'conv-dup', projectRef: 'g-p-relayx' });
    const selected = await makeChatgptRuntime(db, 'Selected Runtime', { projectRef: 'g-p-relayx' });
    const worker = await makeWorker(db);
    assert.notStrictEqual(boundRuntime.id, selected.id);

    await assert.rejects(
      () => api.createPair('proj-1' as string, 'Bad', selected.id as string, worker.id as string, 'https://chatgpt.com/g/g-p-relayx/c/conv-dup'),
      /ChatGPT conversation 'conv-dup' is already bound to runtime/,
    );
    const selectedReloaded = await db.runtimes.findById(selected.id as RuntimeSessionId);
    assert.strictEqual(selectedReloaded?.externalSessionId, null);
    assert.strictEqual((await db.runtimes.findById(boundRuntime.id as RuntimeSessionId))?.externalSessionId, 'conv-dup');
    assert.strictEqual((await db.pairs.findAll()).length, 0);
  });

  it('rolls back the runtime identity write when pair creation fails', async () => {
    const db = makeDb();
    const { api, engine } = makeApi(db);
    const proj = await seedProject(db);
    const planner = await makeChatgptRuntime(db, 'Planner', { projectRef: 'g-p-relayx' });
    const worker = await makeWorker(db);

    // Baseline pair already binds the planner at the engine level (legacy path).
    await engine.createPair(proj.id as ProjectId, 'Existing Pair', planner.id, worker.id);

    // A second pair creation for the same runtime fails inside the transaction AFTER
    // the identity write; the write must be rolled back with the failed pair.
    await assert.rejects(
      () => api.createPair('proj-1' as string, 'Second Pair', planner.id as string, worker.id as string, 'https://chatgpt.com/g/g-p-relayx/c/conv-rollback'),
      /already bound to an active pair/,
    );
    const reloaded = await db.runtimes.findById(planner.id as RuntimeSessionId);
    assert.strictEqual(reloaded?.externalSessionId, null);
    assert.strictEqual(reloaded?.externalProjectRef, 'g-p-relayx');
    assert.strictEqual((await db.pairs.findAll()).length, 1);
  });

  it('preserves the no-URL legacy pairing path (unverified) without touching identity', async () => {
    const db = makeDb();
    const { api } = makeApi(db);
    await seedProject(db);
    const planner = await makeChatgptRuntime(db, 'Planner', { sessionId: null, projectRef: 'g-p-relayx' });
    const worker = await makeWorker(db);

    const pair = await api.createPair('proj-1' as string, 'Legacy Pair', planner.id as string, worker.id as string);
    assert.ok(pair);
    // Legacy path: project-ref ownership proven, but NO session identity is claimed.
    const reloaded = await db.runtimes.findById(planner.id as RuntimeSessionId);
    assert.strictEqual(reloaded?.externalSessionId, null);
    assert.strictEqual(reloaded?.externalProjectRef, 'g-p-relayx');
  });
});

describe('MemoryRelayDatabase: atomic rollback for planner-conversation binding', () => {
  const makeMemoryApi = (): { db: MemoryRelayDatabase; api: RelayApiService; engine: RelayEngine } => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    engine.registerProvider(new ChatGPTProvider());
    return { db, api: new RelayApiService(db, engine), engine };
  };

  const seedMemoryProject = async (db: MemoryRelayDatabase, plannerProjectUrl = 'g-p-relayx') => {
    const proj = new Project({
      id: 'proj-1' as ProjectId,
      name: 'RelayX',
      description: '',
      canonicalPath: '/dev/RelayX',
      plannerProjectUrl,
      workerWorkspacePath: '/dev/RelayX',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.projects.save(proj);
    return proj;
  };

  const seedMemoryRuntimes = async (
    db: MemoryRelayDatabase,
  ): Promise<{ planner: RuntimeSession; worker: RuntimeSession }> => {
    const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Planner');
    planner.updateExternalIdentity(null, 'g-p-relayx');
    await db.runtimes.save(planner);
    const worker = RuntimeSession.create('opencode' as ProviderType, 'Worker');
    worker.updateExternalIdentity(null, '/dev/RelayX');
    await db.runtimes.save(worker);
    return { planner, worker };
  };

  it('proves MemoryRelayDatabase transactions restore mutated entities and added map entries, preserving the original error', async () => {
    const db = new MemoryRelayDatabase();
    const worker = RuntimeSession.create('opencode' as ProviderType, 'Worker');
    await db.runtimes.save(worker);
    const preUpdatedAt = (await db.runtimes.findById(worker.id as RuntimeSessionId))?.updatedAt;

    await assert.rejects(
      () =>
        db.runInTransaction(async () => {
          const added = RuntimeSession.create('opencode' as ProviderType, 'Added During Tx');
          await db.runtimes.save(added);
          worker.updateExternalIdentity('sess-injected', '/tmp/injected');
          await db.runtimes.save(worker);
          throw new Error('boom-original-error');
        }),
      /boom-original-error/,
    );

    // Mutated entity object is reverted in place...
    const reloaded = await db.runtimes.findById(worker.id as RuntimeSessionId);
    assert.strictEqual(reloaded?.externalSessionId, null);
    assert.strictEqual(reloaded?.externalProjectRef, null);
    assert.strictEqual(reloaded?.updatedAt, preUpdatedAt);
    // ...and the entry added during the transaction was removed.
    const all = await db.runtimes.findAll();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].name, 'Worker');
  });

  it('rolls back the identity write when pair creation fails on the memory database (same case as SQLite)', async () => {
    const { db, api, engine } = makeMemoryApi();
    const proj = await seedMemoryProject(db);
    const { planner, worker } = await seedMemoryRuntimes(db);

    // Baseline pair + event from the engine-level (legacy) binding.
    await engine.createPair(proj.id as ProjectId, 'Existing Pair', planner.id, worker.id);
    const pairsBefore = JSON.stringify(await db.pairs.findAll());
    const eventsBefore = JSON.stringify(await db.events.findRecent(100));
    const projectBefore = JSON.stringify(await db.projects.findById('proj-1' as ProjectId));
    const updatedAtBefore = (await db.runtimes.findById(planner.id as RuntimeSessionId))?.updatedAt;
    const workerBefore = JSON.stringify(await db.runtimes.findById(worker.id as RuntimeSessionId));

    // The failing attempt writes the identity INSIDE the transaction and then
    // fails at pair creation; the write must be rolled back.
    await assert.rejects(
      () =>
        api.createPair(
          'proj-1' as string,
          'Second Pair',
          planner.id as string,
          worker.id as string,
          'https://chatgpt.com/g/g-p-relayx/c/conv-rollback',
        ),
      /already bound to an active pair/,
    );

    // Planner identity unchanged: no conversation ID, ref intact, timestamp reverted.
    const plannerAfter = await db.runtimes.findById(planner.id as RuntimeSessionId);
    assert.strictEqual(plannerAfter?.externalSessionId, null);
    assert.strictEqual(plannerAfter?.externalProjectRef, 'g-p-relayx');
    assert.strictEqual(plannerAfter?.updatedAt, updatedAtBefore);

    // Pair collection, events, project, and worker runtime are all unchanged.
    assert.strictEqual(JSON.stringify(await db.pairs.findAll()), pairsBefore);
    assert.strictEqual(JSON.stringify(await db.events.findRecent(100)), eventsBefore);
    assert.strictEqual(JSON.stringify(await db.projects.findById('proj-1' as ProjectId)), projectBefore);
    assert.strictEqual(JSON.stringify(await db.runtimes.findById(worker.id as RuntimeSessionId)), workerBefore);
  });

  it('persists both identity and pair on a successful bind on the memory database', async () => {
    const { db, api } = makeMemoryApi();
    await seedMemoryProject(db);
    const { planner, worker } = await seedMemoryRuntimes(db);

    const pair = await api.createPair(
      'proj-1' as string,
      'Bound Pair',
      planner.id as string,
      worker.id as string,
      'https://chatgpt.com/g/g-p-relayx/c/conv-ok-1',
    );
    assert.ok(pair);
    assert.strictEqual(pair.plannerSessionId, planner.id);

    const reloaded = await db.runtimes.findById(planner.id as RuntimeSessionId);
    assert.strictEqual(reloaded?.externalSessionId, 'conv-ok-1');
    assert.strictEqual(reloaded?.externalProjectRef, 'https://chatgpt.com/g/g-p-relayx/project');
    const byId = await db.runtimes.findByExternalSessionId('chatgpt', 'conv-ok-1');
    assert.strictEqual(byId?.id, planner.id);

    // Commit path persists beyond the transaction: the pair row and its
    // pair.created event exist, and the worker stayed untouched.
    const pairs = await db.pairs.findAll();
    assert.strictEqual(pairs.length, 1);
    assert.strictEqual(pairs[0].name, 'Bound Pair');
    const events = await db.events.findRecent(100);
    assert.ok(events.some((e) => e.eventType === 'pair.created' && e.resourceId === pair.id));
    const workerReloaded = await db.runtimes.findById(worker.id as RuntimeSessionId);
    assert.strictEqual(workerReloaded?.externalSessionId, null);
  });
});