import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Project, Pair, RuntimeSession, RelayEvent } from '../src/relay/domain/entities.ts';
import { ProjectId, ProviderType, RuntimeSessionId } from '../src/relay/domain/types.ts';
import type { WorkerChoice } from '../src/types/relayApi.ts';
import { makeConfirmingOpenCodeProvider } from './support/authoritativeProvider.ts';

const makeDb = () => new MemoryRelayDatabase();

const seedProject = async (
  db: MemoryRelayDatabase,
  overrides: Partial<{ plannerProjectUrl: string; workerWorkspacePath: string; canonicalPath: string; gitRoot: string }> = {},
) => {
  const proj = new Project({
    id: 'proj-1' as ProjectId,
    name: 'RelayX',
    description: '',
    canonicalPath: overrides.canonicalPath ?? '/dev/RelayX',
    gitRoot: overrides.gitRoot ?? '/dev/RelayX',
    plannerProjectUrl: overrides.plannerProjectUrl ?? 'https://chatgpt.com/g/g-p-relayx-project',
    workerWorkspacePath: overrides.workerWorkspacePath ?? '/dev/RelayX',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await db.projects.save(proj);
  return proj;
};

const makeRuntime = async (
  db: MemoryRelayDatabase,
  providerType: ProviderType,
  name: string,
  identity: { sessionId?: string | null; projectRef?: string | null } = {},
): Promise<RuntimeSession> => {
  const runtime = RuntimeSession.create(providerType, name);
  runtime.updateExternalIdentity(
    identity.sessionId === undefined ? null : identity.sessionId,
    identity.projectRef === undefined ? null : identity.projectRef,
  );
  await db.runtimes.save(runtime);
  return runtime;
};

/** Registers a fake opencode provider whose matchSessionsByPath returns the given matches. */
const registerFakeOpenCodeProvider = (
  engine: RelayEngine,
  matches: Array<{ windowTitle: string; details: Record<string, unknown> }>,
  calls: Array<[string, string | undefined]>,
) => {
  engine.registerProvider({
    providerType: 'opencode',
    integrationStatus: 'full',
    matchSessionsByPath: async (projectPath: string, gitRoot?: string) => {
      calls.push([projectPath, gitRoot]);
      return {
        sessions: matches.map((m) => ({ windowTitle: m.windowTitle, evidence: { details: m.details } })),
        diagnostics: { source: 'fake_provider' },
      };
    },
  } as any);
};

/** Registers a fake opencode provider that does NOT support session matching. */
const registerFakeOpenCodeProviderWithoutMatching = (engine: RelayEngine) => {
  engine.registerProvider({
    providerType: 'opencode',
    integrationStatus: 'full',
  } as any);
};

describe('enumerateChatGPTConversations — project-owned observed conversation registry', () => {
  it('returns bound conversations scoped to the project slug', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);
    const bound = await makeRuntime(db, 'chatgpt', 'Planner', {
      sessionId: 'conv-bound',
      projectRef: 'https://chatgpt.com/g/g-p-relayx-project',
    });
    // Runtime bound to a DIFFERENT project must not leak in.
    await makeRuntime(db, 'chatgpt', 'OtherPlanner', {
      sessionId: 'conv-other',
      projectRef: 'https://chatgpt.com/g/g-p-other-project',
    });

    const res = await api.enumerateChatGPTConversations('proj-1');

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.projectSlug, 'g-p-relayx-project');
    assert.strictEqual(res.conversations.length, 1);
    const conv = res.conversations[0];
    assert.deepStrictEqual(conv, {
      conversationId: 'conv-bound',
      projectId: 'g-p-relayx-project',
      url: 'https://chatgpt.com/g/g-p-relayx-project/c/conv-bound',
      source: 'bound',
      boundRuntimeId: bound.id,
      lastSeenAt: bound.updatedAt,
    });
  });

  it('merges observed event-URL conversations and dedupes a bound conversation, keeping the newest lastSeenAt', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);
    const bound = await makeRuntime(db, 'chatgpt', 'Planner', {
      sessionId: 'conv-bound',
      projectRef: 'g-p-relayx-project',
    });

    const e1 = RelayEvent.create('runtime', bound.id, 'runtime.observed', {
      details: { observedUrl: 'https://chatgpt.com/g/g-p-relayx-project/c/conv-bound' },
    });
    await db.events.save(e1);
    const e2 = RelayEvent.create('runtime', bound.id, 'runtime.observed', {
      details: {
        deeper: {
          nested: ['https://chatgpt.com/g/g-p-relayx-project/c/conv-observed', 'not-a-url'],
        },
      },
    });
    await db.events.save(e2);
    // Different-project conversation must be excluded.
    const e3 = RelayEvent.create('runtime', bound.id, 'runtime.observed', {
      details: { observedUrl: 'https://chatgpt.com/g/g-p-other-project/c/conv-other' },
    });
    await db.events.save(e3);

    const res = await api.enumerateChatGPTConversations('proj-1');

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.conversations.length, 2);

    const convBound = res.conversations.find((c) => c.conversationId === 'conv-bound');
    assert.ok(convBound);
    assert.strictEqual(convBound.source, 'bound');
    assert.strictEqual(
      convBound.lastSeenAt,
      Math.max(bound.updatedAt, e1.timestamp, e2.timestamp),
    );
    assert.strictEqual(convBound.url, 'https://chatgpt.com/g/g-p-relayx-project/c/conv-bound');

    const convObserved = res.conversations.find((c) => c.conversationId === 'conv-observed');
    assert.ok(convObserved);
    assert.strictEqual(convObserved.source, 'observed');
    assert.strictEqual(convObserved.lastSeenAt, e2.timestamp);
    assert.strictEqual(convObserved.url, 'https://chatgpt.com/g/g-p-relayx-project/c/conv-observed');
    assert.strictEqual(convObserved.boundRuntimeId, undefined);

    assert.strictEqual(res.conversations.some((c) => c.conversationId === 'conv-other'), false);
  });

  it('matches the project slug case-insensitively', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db, { plannerProjectUrl: 'https://chatgpt.com/g/g-p-RelayX-PROJECT' });
    const bound = await makeRuntime(db, 'chatgpt', 'Planner', {
      sessionId: 'conv-bound',
      projectRef: 'g-p-relayx-project',
    });

    const res = await api.enumerateChatGPTConversations('proj-1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.projectSlug, 'g-p-relayx-project');
    assert.strictEqual(res.conversations.length, 1);
    assert.strictEqual(res.conversations[0].conversationId, 'conv-bound');
    assert.strictEqual(res.conversations[0].boundRuntimeId, bound.id);
  });

  it('flags conversations whose bound runtime sits in a non-archived pair', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);
    const planner = await makeRuntime(db, 'chatgpt', 'Planner', {
      sessionId: 'conv-paired',
      projectRef: 'g-p-relayx-project',
    });
    const worker = await makeRuntime(db, 'opencode', 'Worker', {
      sessionId: 'ses_worker',
      projectRef: '/dev/RelayX',
    });
    const lone = await makeRuntime(db, 'chatgpt', 'LonePlanner', {
      sessionId: 'conv-lone',
      projectRef: 'g-p-relayx-project',
    });
    await db.pairs.save(Pair.create('proj-1' as ProjectId, 'Active Pair', planner.id, worker.id));

    const res = await api.enumerateChatGPTConversations('proj-1');
    const paired = res.conversations.find((c) => c.conversationId === 'conv-paired');
    const unpaired = res.conversations.find((c) => c.conversationId === 'conv-lone');
    assert.strictEqual(paired?.paired, true);
    assert.strictEqual(unpaired?.paired, undefined);
  });

  it('truthfully fails when the project has no registered ChatGPT planner project', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db, { plannerProjectUrl: '' });

    const res = await api.enumerateChatGPTConversations('proj-1');
    assert.strictEqual(res.ok, false);
    assert.match(res.error ?? '', /planner/i);
    assert.deepStrictEqual(res.conversations, []);
  });

  it('truthfully fails for an unknown project', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);

    const res = await api.enumerateChatGPTConversations('proj-missing');
    assert.strictEqual(res.ok, false);
    assert.match(res.error ?? '', /not found/i);
  });
});

describe('enumerateWorkerChoices — existing/new worker sessions per project', () => {
  it('lists registered runtimes of this workspace plus adoptable authoritative discovered sessions', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);
    const registered = await makeRuntime(db, 'opencode', 'Worker A', {
      sessionId: 'ses_registered',
      projectRef: '/dev/RelayX',
    });
    // Different-workspace runtime must not appear as a registered choice here.
    await makeRuntime(db, 'opencode', 'Other Worker', {
      sessionId: 'ses_other',
      projectRef: '/dev/Other',
    });
    const calls: Array<[string, string | undefined]> = [];
    registerFakeOpenCodeProvider(
      engine,
      [
        { windowTitle: 'RelayX — sessions', details: { authoritativeSessionId: 'ses_new1', sessionTitle: 'Implement worker selection', workspacePath: '/dev/RelayX', matchedVia: 'shared_service' } },
        { windowTitle: 'RelayX — sessions', details: { parsedSessionId: 'ses_unverified', workspacePath: '/dev/RelayX' } },
        { windowTitle: 'RelayX — sessions', details: { authoritativeSessionId: 'ses_registered', workspacePath: '/dev/RelayX' } },
      ],
      calls,
    );

    const res = await api.enumerateWorkerChoices('proj-1');

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.projectPath, '/dev/RelayX');
    assert.deepStrictEqual(calls, [['/dev/RelayX', '/dev/RelayX']]);

    const registeredChoice = res.choices.find((c) => c.kind === 'registered');
    assert.deepStrictEqual(registeredChoice, {
      kind: 'registered',
      runtimeId: registered.id,
      name: 'Worker A',
      status: 'unknown',
      externalSessionId: 'ses_registered',
      paired: false,
    });
    const discoveries = res.choices.filter((c) => c.kind === 'discovered');
    assert.strictEqual(discoveries.length, 1);
    assert.deepStrictEqual(discoveries[0], {
      kind: 'discovered',
      sessionId: 'ses_new1',
      sessionTitle: 'Implement worker selection',
      windowTitle: 'RelayX — sessions',
      workspacePath: '/dev/RelayX',
      matchedVia: 'shared_service',
    });
    // parsed-only ids never become discoverable worker sessions.
    assert.strictEqual(res.choices.some((c) => c.kind === 'discovered' && c.sessionId === 'ses_unverified'), false);
    assert.deepStrictEqual(res.discovery, { ok: true, excludedUnverified: 1 });
  });

  it('flags registered runtimes already bound into a non-archived pair', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);
    const planner = await makeRuntime(db, 'chatgpt', 'Planner', {
      sessionId: 'conv-1',
      projectRef: 'g-p-relayx-project',
    });
    const worker = await makeRuntime(db, 'opencode', 'Worker', {
      sessionId: 'ses_worker',
      projectRef: '/dev/RelayX',
    });
    await db.pairs.save(Pair.create('proj-1' as ProjectId, 'Active Pair', planner.id, worker.id));

    const res = await api.enumerateWorkerChoices('proj-1');
    const workerChoice = res.choices.find(
      (c): c is Extract<WorkerChoice, { kind: 'registered' }> =>
        c.kind === 'registered' && c.runtimeId === worker.id,
    );
    assert.strictEqual(workerChoice?.paired, true);
  });

  it('keeps registered choices and reports discovery failure truthfully when matching is unsupported', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);
    await makeRuntime(db, 'opencode', 'Worker A', {
      sessionId: 'ses_registered',
      projectRef: '/dev/RelayX',
    });
    registerFakeOpenCodeProviderWithoutMatching(engine);

    const res = await api.enumerateWorkerChoices('proj-1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.choices.length, 1);
    assert.strictEqual(res.choices[0].kind, 'registered');
    assert.strictEqual(res.discovery?.ok, false);
    assert.match(res.discovery?.reason ?? '', /support/i);
  });

  it('truthfully fails for an unknown project', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);

    const res = await api.enumerateWorkerChoices('proj-missing');
    assert.strictEqual(res.ok, false);
    assert.match(res.error ?? '', /not found/i);
  });
});

describe('adoptOpenCodeSession — register a discovered authoritative session as a runtime', () => {
  it('creates a runtime carrying the authoritative ses_ id and is idempotent', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    // Adoption requires a confirmation authority; this test targets identity
    // and idempotency, so register a provider that confirms the session.
    engine.registerProvider(makeConfirmingOpenCodeProvider());
    const api = new RelayApiService(db, engine);
    await seedProject(db);

    const adopted = await api.adoptOpenCodeSession('proj-1', 'ses_adopt-abc');
    assert.strictEqual(adopted.providerType, 'opencode');
    assert.strictEqual(adopted.externalSessionId, 'ses_adopt-abc');
    assert.strictEqual(adopted.externalProjectRef, '/dev/RelayX');

    const again = await api.adoptOpenCodeSession('proj-1', 'ses_adopt-abc');
    assert.strictEqual(again.id, adopted.id);
    const all = await db.runtimes.findAll();
    assert.strictEqual(all.length, 1);
  });

  it('rejects non-authoritative session ids', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);

    await assert.rejects(
      () => api.adoptOpenCodeSession('proj-1', 'window-derived-id'),
      /authoritative/i,
    );
  });

  it('throws for an unknown project', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);

    await assert.rejects(() => api.adoptOpenCodeSession('proj-missing', 'ses_abc'), /not found/i);
  });

  it('rejects adopting a session already bound to a different workspace', async () => {
    const db = makeDb();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);
    await makeRuntime(db, 'opencode', 'Bound Elsewhere', {
      sessionId: 'ses_conflict',
      projectRef: '/dev/Other',
    });

    await assert.rejects(() => api.adoptOpenCodeSession('proj-1', 'ses_conflict'), /different workspace/i);
  });
});
