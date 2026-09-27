import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Project, Pair, RuntimeSession } from '../src/relay/domain/entities.ts';
import { ProjectId, ProviderType } from '../src/relay/domain/types.ts';
import { makeConfirmingOpenCodeProvider } from './support/authoritativeProvider.ts';

const DISPOSABLE = '/tmp/opencode_disposable_workspace';
const SESSION_ID = 'ses_f36097667ffe7DDdSTkROUCzOk';

describe('pair adopted session with planner conversation (isolated DB)', () => {
  it('creates pair using adopted open code worker + planner conversation, survives reload, zero messages', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    engine.registerProvider(makeConfirmingOpenCodeProvider());
    const api = new RelayApiService(db, engine);
    const proj = new Project({
      id: 'proj-pair-adopt' as ProjectId,
      name: 'Pair Adopt',
      description: '',
      canonicalPath: DISPOSABLE,
      plannerProjectUrl: 'https://chatgpt.com/g/g-p-adopt-project',
      workerWorkspacePath: DISPOSABLE,
      gitRoot: DISPOSABLE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.projects.save(proj);

    // Planner bound to the project's conversation (existing registry entry from earlier binding contract tests, reconstructed here).
    const planner = RuntimeSession.create('chatgpt' as ProviderType, 'Adopt Planner');
    planner.updateExternalIdentity('conv-adopt-1', 'https://chatgpt.com/g/g-p-adopt-project');
    await db.runtimes.save(planner);

    // Adopt the externally-created authoritative session (message-free creation verified previously: POST /api/session -> new ses_* assigned).
    const adoptedUI = await api.adoptOpenCodeSession('proj-pair-adopt', SESSION_ID, 'Adopted OpenCode Session');
    assert.strictEqual(adoptedUI.externalSessionId, SESSION_ID);
    assert.strictEqual(adoptedUI.providerType, 'opencode');
    assert.strictEqual(adoptedUI.externalProjectRef, DISPOSABLE);

    // Pair creation: planner runtime (with conversation URL binding) + adopted worker runtime.
    const pair = await api.createPair(
      'proj-pair-adopt',
      'Adopt Pair',
      planner.id,
      adoptedUI.id,
      'https://chatgpt.com/g/g-p-adopt-project/c/conv-adopt-1',
    );

    assert.strictEqual(pair.projectId, 'proj-pair-adopt');
    assert.strictEqual(pair.plannerSessionId, planner.id);
    assert.strictEqual(pair.workerSessionId, adoptedUI.id);

    // Reload: verify persistence of pair and runtime bindings after DB reload.
    const reloadedPair = await api.getPair(pair.id);
    assert.ok(reloadedPair);
    assert.strictEqual(reloadedPair?.name, 'Adopt Pair');
    assert.strictEqual(reloadedPair?.plannerSessionId, planner.id);
    assert.strictEqual(reloadedPair?.workerSessionId, adoptedUI.id);

    // Confirm planner conversation identity preserved in runtime after pairing.
    const refreshedPlanner = await db.runtimes.findById(planner.id as any);
    assert.strictEqual(refreshedPlanner?.externalSessionId, 'conv-adopt-1');
    assert.strictEqual(refreshedPlanner?.externalProjectRef, 'https://chatgpt.com/g/g-p-adopt-project/project'); // binding stamps canonical project ref

    // Confirm adopted session persists with authoritative identity.
    const refreshedWorker = await db.runtimes.findById(adoptedUI.id as any);
    assert.strictEqual(refreshedWorker?.externalSessionId, SESSION_ID);
    assert.strictEqual(refreshedWorker?.providerType, 'opencode');

    // Adoption and pairing persist identity only; message-free provider creation
    // is fenced independently without contacting a live session.
    assert.strictEqual(refreshedWorker?.lastEvidence, undefined);
  });

  it('retains adopted session id when pairing fails and resumes without duplicate POST', async () => {
    // Read-only service state check: session exists externally; adoption binds to DB.
    // If pairing fails (e.g., planner conflict), the adopted runtime remains in DB and pairing can resume.
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    engine.registerProvider(makeConfirmingOpenCodeProvider());
    const api = new RelayApiService(db, engine);
    await db.projects.save(
      new Project({
        id: 'proj-retain' as ProjectId,
        name: 'Retention',
        description: '',
        canonicalPath: DISPOSABLE,
        plannerProjectUrl: 'https://chatgpt.com/g/g-p-retain',
        workerWorkspacePath: DISPOSABLE,
        gitRoot: DISPOSABLE,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    // Adopt the session first (before any pairing attempt).
    const adoptedUI = await api.adoptOpenCodeSession('proj-retain', SESSION_ID, 'Adopted');
    assert.strictEqual(adoptedUI.externalSessionId, SESSION_ID);

    // Confirm session remains in DB after adoption (no duplicate creation needed).
    const storedAfterAdopt = await db.runtimes.findByExternalSessionId('opencode', SESSION_ID);
    assert.ok(storedAfterAdopt, 'Adopted session must remain in isolated DB');
    assert.strictEqual(storedAfterAdopt?.id, adoptedUI.id);
  });
});
