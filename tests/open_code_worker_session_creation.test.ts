import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Project } from '../src/relay/domain/entities.ts';
import { ProjectId } from '../src/relay/domain/types.ts';

const PROJECT_ID = 'proj-creation' as ProjectId;
const WORKSPACE = '/workspaces/protected-project';

async function makeHarness(options: {
  create: () => Promise<{ sessionId: string; workspaceDir: string; error?: string }>;
  confirm?: (sessionId: string, projectPath: string) => Promise<{
    confirmed: boolean;
    externalSessionId?: string | null;
    projectPath?: string;
  }>;
}) {
  const db = new MemoryRelayDatabase();
  const engine = new RelayEngine(db);
  let createCalls = 0;
  let confirmCalls = 0;
  engine.registerProvider({
    providerType: 'opencode',
    integrationStatus: 'partial',
    async createWorkerSession() {
      createCalls += 1;
      return options.create();
    },
    ...(options.confirm
      ? {
          async confirmSessionForProject(sessionId: string, projectPath: string) {
            confirmCalls += 1;
            return options.confirm!(sessionId, projectPath);
          },
        }
      : {}),
  } as any);
  await db.projects.save(new Project({
    id: PROJECT_ID,
    name: 'Protected Project',
    description: '',
    canonicalPath: WORKSPACE,
    workerWorkspacePath: WORKSPACE,
    gitRoot: WORKSPACE,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
  return {
    db,
    api: new RelayApiService(db, engine),
    createCalls: () => createCalls,
    confirmCalls: () => confirmCalls,
  };
}

describe('OpenCode session creation preservation contract (hermetic)', () => {
  it('creates exactly once through the provider, confirms, adopts, and persists the same ses_* identity', async () => {
    const harness = await makeHarness({
      create: async () => ({ sessionId: 'ses_created_once', workspaceDir: WORKSPACE }),
      confirm: async (sessionId, projectPath) => ({
        confirmed: true,
        externalSessionId: sessionId,
        projectPath,
      }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('service-layer fetch is prohibited during creation');
    }) as typeof fetch;
    try {
      const result = await harness.api.createOpenCodeWorkerSession(PROJECT_ID, 'Empty worker');
      assert.strictEqual(harness.createCalls(), 1);
      assert.strictEqual(harness.confirmCalls(), 1);
      assert.strictEqual(result.adopted, true);
      assert.strictEqual(result.sessionId, 'ses_created_once');
      assert.strictEqual(result.runtime?.externalSessionId, 'ses_created_once');
      assert.strictEqual(result.runtime?.externalProjectRef, WORKSPACE);

      const stored = await harness.db.runtimes.findByExternalSessionId('opencode', 'ses_created_once');
      assert.ok(stored);
      const evidence = await harness.db.associations.findBySessionId(stored!.id);
      assert.strictEqual(evidence.length, 1);
      assert.strictEqual(evidence[0].externalSessionId, 'ses_created_once');
      assert.strictEqual(evidence[0].verificationState, 'verified');
      assert.strictEqual(evidence[0].provenance, 'adoption');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not retry or fall back when the provider creation attempt fails', async () => {
    const harness = await makeHarness({
      create: async () => ({ sessionId: '', workspaceDir: '', error: 'provider creation failed' }),
      confirm: async () => {
        throw new Error('confirmation must not run without a session');
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('manual Basic-auth fallback must never run');
    }) as typeof fetch;
    try {
      const result = await harness.api.createOpenCodeWorkerSession(PROJECT_ID, 'No retry');
      assert.strictEqual(harness.createCalls(), 1);
      assert.strictEqual(harness.confirmCalls(), 0);
      assert.strictEqual(result.adopted, false);
      assert.strictEqual(result.partial, true);
      assert.match(result.error ?? '', /provider creation failed|authoritative ses_/i);
      assert.deepStrictEqual(await harness.db.runtimes.findAll(), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retains a created ses_* but refuses adoption when the provider reports another workspace', async () => {
    const harness = await makeHarness({
      create: async () => ({ sessionId: 'ses_wrong_workspace', workspaceDir: '/workspaces/other' }),
      confirm: async () => {
        throw new Error('workspace mismatch must stop before confirmation');
      },
    });
    const result = await harness.api.createOpenCodeWorkerSession(PROJECT_ID, 'Wrong workspace');
    assert.strictEqual(harness.createCalls(), 1);
    assert.strictEqual(harness.confirmCalls(), 0);
    assert.strictEqual(result.sessionId, 'ses_wrong_workspace');
    assert.strictEqual(result.adopted, false);
    assert.strictEqual(result.partial, true);
    assert.match(result.error ?? '', /does not match project workspace/i);
    assert.deepStrictEqual(await harness.db.runtimes.findAll(), []);
  });

  it('rejects adoption when confirmation changes or cannot prove the authoritative identity', async () => {
    const harness = await makeHarness({
      create: async () => ({ sessionId: 'ses_expected', workspaceDir: WORKSPACE }),
      confirm: async (_sessionId, projectPath) => ({
        confirmed: true,
        externalSessionId: 'ses_different',
        projectPath,
      }),
    });
    const result = await harness.api.createOpenCodeWorkerSession(PROJECT_ID, 'Identity mismatch');
    assert.strictEqual(harness.createCalls(), 1);
    assert.strictEqual(harness.confirmCalls(), 1);
    assert.strictEqual(result.sessionId, 'ses_expected');
    assert.strictEqual(result.adopted, false);
    assert.strictEqual(result.partial, true);
    assert.match(result.error ?? '', /requires provider confirmation/i);
    assert.deepStrictEqual(await harness.db.runtimes.findAll(), []);
  });

  it('does not let a registered but non-confirming provider authorize adoption', async () => {
    const harness = await makeHarness({
      create: async () => ({ sessionId: 'ses_unconfirmed', workspaceDir: WORKSPACE }),
    });
    await assert.rejects(
      () => harness.api.adoptOpenCodeSession(PROJECT_ID, 'ses_unconfirmed', 'Unconfirmed'),
      /capable of authoritative project confirmation/i,
    );
    assert.deepStrictEqual(await harness.db.runtimes.findAll(), []);
  });
});
