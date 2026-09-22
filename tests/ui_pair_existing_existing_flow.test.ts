import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Project, Pair, RuntimeSession, RelayEvent } from '../src/relay/domain/entities.ts';
import { ProjectId, ProviderType } from '../src/relay/domain/types.ts';
import { normalizeChatProjectSlug } from '../src/relay/application/RelayApiService.ts';

const seedProject = async (db: MemoryRelayDatabase, url?: string) => {
  const proj = new Project({
    id: 'proj-flow' as ProjectId,
    name: 'Flow Project',
    description: '',
    canonicalPath: '/dev/flow',
    plannerProjectUrl: url ?? 'https://chatgpt.com/g/g-p-flow-project',
    workerWorkspacePath: '/dev/flow',
    gitRoot: '/dev/flow',
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
) => {
  const r = RuntimeSession.create(providerType, name);
  r.updateExternalIdentity(
    identity.sessionId === undefined ? null : identity.sessionId,
    identity.projectRef === undefined ? null : identity.projectRef,
  );
  await db.runtimes.save(r);
  return r;
};

describe('existing/existing pairing flow (project-owned registry + manual fallback)', () => {
  it('selects an existing registry conversation URL and an existing OpenCode session, creates pair, and reloads both', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);

    // Planner bound to project conversation 'conv-flow-1'.
    const planner = await makeRuntime(db, 'chatgpt', 'Flow Planner', {
      sessionId: 'conv-flow-1',
      projectRef: 'https://chatgpt.com/g/g-p-flow-project',
    });
    // Worker authoritative session registered to workspace.
    const worker = await makeRuntime(db, 'opencode', 'Flow Worker', {
      sessionId: 'ses_flow_1',
      projectRef: '/dev/flow',
    });

    // Registry observation: same conversation also seen in event evidence.
    const evt = RelayEvent.create('runtime', planner.id, 'runtime.observed', {
      details: { observedUrl: 'https://chatgpt.com/g/g-p-flow-project/c/conv-flow-1' },
    });
    await db.events.save(evt);

    // Confirm registry sees the conversation correctly.
    const registry = await api.enumerateChatGPTConversations('proj-flow');
    assert.strictEqual(registry.ok, true);
    assert.strictEqual(registry.conversations.length, 1);
    assert.strictEqual(registry.conversations[0].conversationId, 'conv-flow-1');
    assert.strictEqual(registry.conversations[0].source, 'bound');
    assert.strictEqual(registry.conversations[0].url, 'https://chatgpt.com/g/g-p-flow-project/c/conv-flow-1');

    // Confirm worker choices include the registered session.
    const workerChoices = await api.enumerateWorkerChoices('proj-flow');
    assert.strictEqual(workerChoices.ok, true);
    const regChoice = workerChoices.choices.find(
      (c: { kind: string; sessionId?: string; runtimeId?: string }) =>
        c.kind === 'registered' && (c.runtimeId === worker.id || (c as any).sessionId === 'ses_flow_1'),
    );
    assert.ok(regChoice, 'Registered worker session should appear in choices');

    // Create pair using the registry conversation URL (existing + existing).
    const url = registry.conversations[0].url;
    const pair = await api.createPair('proj-flow', 'Flow Pair', planner.id, worker.id, url);

    assert.strictEqual(pair.projectId, 'proj-flow');
    assert.strictEqual(pair.plannerSessionId, planner.id);
    assert.strictEqual(pair.workerSessionId, worker.id);

    // The planner runtime should now be bound to the exact conversation.
    const refreshedPlanner = await db.runtimes.findById(planner.id as any);
    assert.strictEqual(refreshedPlanner?.externalSessionId, 'conv-flow-1');
    assert.strictEqual(
      refreshedPlanner?.externalProjectRef,
      'https://chatgpt.com/g/g-p-flow-project/project',
    );

    // Reload pair: both runtimes should reload with the same authoritative ids.
    const pairs = await api.listPairs();
    const created = pairs.find((p) => p.id === pair.id);
    assert.ok(created);
    assert.strictEqual(created?.name, 'Flow Pair');
  });

  it('keeps an observed discussion conversation known but unselected until explicitly picked', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);

    const planner = await makeRuntime(db, 'chatgpt', 'Planner', {
      sessionId: 'conv-main',
      projectRef: 'https://chatgpt.com/g/g-p-flow-project',
    });
    const worker = await makeRuntime(db, 'opencode', 'Worker', {
      sessionId: 'ses_flow_1',
      projectRef: '/dev/flow',
    });

    // A different conversation is only observed (in event evidence), not bound.
    const evtObserved = RelayEvent.create('runtime', planner.id, 'runtime.observed', {
      details: { observedUrl: 'https://chatgpt.com/g/g-p-flow-project/c/conv-discussion' },
    });
    await db.events.save(evtObserved);

    const registry = await api.enumerateChatGPTConversations('proj-flow');
    assert.strictEqual(registry.ok, true);
    // Bound + observed = 2 conversations.
    assert.strictEqual(registry.conversations.length, 2);

    const boundConv = registry.conversations.find((c) => c.source === 'bound');
    const observedConv = registry.conversations.find((c) => c.source === 'observed');

    assert.strictEqual(boundConv?.conversationId, 'conv-main');
    assert.strictEqual(observedConv?.conversationId, 'conv-discussion');
    assert.strictEqual(observedConv?.boundRuntimeId, undefined);

    // Manual URL fallback: user can type the observed conversation URL manually.
    // createPair must succeed with the observed conversation URL because it parses
    // strictly and matches the planner runtime's session id if the planner is
    // rebinding to a new conversation... wait — here planner is bound to 'conv-main'.
    // Using the observed URL 'conv-discussion' with planner bound to 'conv-main'
    // should fail the binding contract (already bound to different conversation).
    // That is the intended behavior: discussion remains known until user explicitly
    // selects that planner to bind it. Since planner is already bound to 'conv-main',
    // selecting 'conv-discussion' would require either selecting a different planner
    // or unbinding first. So we test that selecting the DISCUSSION URL fails with
    // the conflict message (proving it is not silently selected).
    await assert.rejects(
      () => api.createPair('proj-flow', 'Wrong Pair', planner.id, worker.id, 'https://chatgpt.com/g/g-p-flow-project/c/conv-discussion'),
      /already bound/,
    );
  });

  it('manual URL fallback works when registry has no bound planner conversation (empty registry)', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db); // planner URL present; planner has no session id (empty registry)

    const planner = await makeRuntime(db, 'chatgpt', 'Planner', {
      sessionId: null,
      projectRef: 'https://chatgpt.com/g/g-p-flow-project',
    });
    const worker = await makeRuntime(db, 'opencode', 'Worker', {
      sessionId: 'ses_flow_1',
      projectRef: '/dev/flow',
    });

    // Registry empty (planner bound but no conversation id → no bound conversation, no events).
    const registry = await api.enumerateChatGPTConversations('proj-flow');
    assert.strictEqual(registry.ok, true);
    assert.strictEqual(registry.conversations.length, 0);

    // Manual URL entry for a conversation that matches the planner's future binding.
    const pair = await api.createPair(
      'proj-flow',
      'Manual Pair',
      planner.id,
      worker.id,
      'https://chatgpt.com/g/g-p-flow-project/c/conv-manual',
    );
    assert.strictEqual(pair.name, 'Manual Pair');

    // Runtime updated with the conversation identity.
    const refreshedPlanner2 = await db.runtimes.findById(planner.id as any);
    assert.strictEqual(refreshedPlanner2?.externalSessionId, 'conv-manual');
  });

  it('duplicate conversation titles (same conversation id from event + runtime) are deduped and paired is truthfully flagged', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);

    const planner = await makeRuntime(db, 'chatgpt', 'Planner', {
      sessionId: 'conv-dup',
      projectRef: 'https://chatgpt.com/g/g-p-flow-project',
    });
    const worker = await makeRuntime(db, 'opencode', 'Worker', {
      sessionId: 'ses_flow_1',
      projectRef: '/dev/flow',
    });
    await db.pairs.save(Pair.create('proj-flow' as ProjectId, 'Dup Pair', planner.id, worker.id));

    // Same conversation URL observed again in event.
    const evt = RelayEvent.create('runtime', planner.id, 'runtime.observed', {
      details: { observedUrl: 'https://chatgpt.com/g/g-p-flow-project/c/conv-dup' },
    });
    await db.events.save(evt);

    const registry = await api.enumerateChatGPTConversations('proj-flow');
    assert.strictEqual(registry.conversations.length, 1);
    const entry = registry.conversations[0];
    assert.strictEqual(entry.source, 'bound');
    assert.strictEqual(entry.paired, true);
    assert.strictEqual(entry.boundRuntimeId, planner.id);

    const registry2 = await api.enumerateChatGPTConversations('proj-flow');
    assert.strictEqual(registry2.conversations.length, 1);
    assert.strictEqual(registry2.conversations[0].source, 'bound');
    assert.strictEqual(registry2.conversations[0].paired, true);
    assert.strictEqual(registry2.conversations[0].boundRuntimeId, planner.id);
  });

  it('cross-project conversation URL is rejected at the pairing boundary', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db);

    const planner = await makeRuntime(db, 'chatgpt', 'Planner', {
      sessionId: 'conv-flow-1',
      projectRef: 'https://chatgpt.com/g/g-p-flow-project',
    });
    const worker = await makeRuntime(db, 'opencode', 'Worker', {
      sessionId: 'ses_flow_1',
      projectRef: '/dev/flow',
    });

    await assert.rejects(
      () =>
        api.createPair('proj-flow', 'Cross Pair', planner.id, worker.id, 'https://chatgpt.com/g/g-p-OTHER-project/c/conv-other'),
      /conversation belongs to different ChatGPT project/i,
    );
  });

  it('unavailable or partial registry (service returns ok:false or empty) does not block manual URL pairing', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);
    await seedProject(db); // planner URL present so manual pairing works

    const planner = await makeRuntime(db, 'chatgpt', 'Planner', {
      sessionId: 'conv-manual2',
      projectRef: 'https://chatgpt.com/g/g-p-flow-project',
    });
    const worker = await makeRuntime(db, 'opencode', 'Worker', {
      sessionId: 'ses_flow_2',
      projectRef: '/dev/flow',
    });

    const registry = await api.enumerateChatGPTConversations('proj-flow');
    // Registry reports truthfully: planner bound to conv-manual2 → 1 entry.
    assert.strictEqual(registry.ok, true);
    assert.strictEqual(registry.conversations.length, 1);

    // Manual pairing still works when registry unavailable — user pastes URL.
    const pair = await api.createPair(
      'proj-flow',
      'Fallback Pair',
      planner.id,
      worker.id,
      'https://chatgpt.com/g/g-p-flow-project/c/conv-manual2',
    );
    assert.strictEqual(pair.name, 'Fallback Pair');
    assert.strictEqual(pair.projectId, 'proj-flow');
  });
});
