import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { ChatGPTProvider, OpenCodeProvider, VSCodeProvider } from '../src/relay/providers/adapters.ts';

/**
 * Project binding persistence: finalizeProjectSetup must persist the confirmed
 * planner URL and worker workspace on the PROJECT record, and the runtime
 * identities (worker session id + workspace path, planner project URL) so the
 * detail views can compare saved vs discovered bindings across restarts.
 * A discovery failure after setup must never erase these saved values
 * (that guarantee is exercised at the view-model layer; here we pin the
 * persistence contract itself).
 */
describe('Project Binding Persistence', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;

  before(async () => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    engine.registerProvider(new ChatGPTProvider());
    engine.registerProvider(new OpenCodeProvider());
    engine.registerProvider(new VSCodeProvider());
    service = new RelayApiService(db, engine);
  });

  after(async () => {
    db.close();
  });

  test('finalizeProjectSetup persists project-level binding fields', async () => {
    const canonicalPath = '/Users/relay/persist-project';
    const plannerUrl = 'https://chatgpt.com/p/persist-id';
    const workerSessionId = 'session_persist_42';

    const res = await service.finalizeProjectSetup({
      name: 'Persist Project',
      description: 'Pins saved bindings',
      canonicalPath,
      gitRoot: canonicalPath,
      plannerUrl,
      workerSessionId,
    });
    assert.strictEqual(res.success, true);
    assert.ok(res.projectId);

    // Project record carries the SAVED planner/worker bindings.
    const project = await db.projects.findById(res.projectId as any);
    assert.ok(project);
    assert.strictEqual(project.plannerProjectUrl, plannerUrl);
    assert.strictEqual(project.workerWorkspacePath, canonicalPath);

    // Runtime identities are persisted on the registered sessions. Setup pairs
    // nothing: the wizard's session id is caller input, not verified provider
    // evidence, so pairing waits for the discovery/adoption path.
    const pairs = await db.pairs.findByProjectId(res.projectId as any);
    assert.deepStrictEqual(pairs, []);

    const runtimes = await db.runtimes.findAll();
    const planner = runtimes.find((r) => r.providerType === 'chatgpt');
    assert.ok(planner);
    assert.strictEqual(planner.externalProjectRef, plannerUrl);

    const worker = runtimes.find((r) => r.providerType === 'opencode');
    assert.ok(worker);
    assert.strictEqual(worker.providerType, 'opencode');
    assert.strictEqual(worker.externalSessionId, workerSessionId);
    assert.strictEqual(worker.externalProjectRef, canonicalPath);
  });

  test('API mappers round-trip saved bindings and runtime identities', async () => {
    const canonicalPath = '/Users/relay/persist-project';
    const plannerUrl = 'https://chatgpt.com/p/persist-id';
    const workerSessionId = 'session_persist_42';

    const projects = await service.listProjects();
    const mapped = projects.find((p) => p.canonicalPath === canonicalPath);
    assert.ok(mapped);
    assert.strictEqual(mapped.plannerProjectUrl, plannerUrl);
    assert.strictEqual(mapped.workerWorkspacePath, canonicalPath);

    const fetched = await service.getProject(mapped.id);
    assert.ok(fetched);
    assert.strictEqual(fetched.plannerProjectUrl, plannerUrl);
    assert.strictEqual(fetched.workerWorkspacePath, canonicalPath);

    const sessions = await service.listRuntimeSessions();
    const worker = sessions.find((s) => s.providerType === 'opencode');
    assert.ok(worker, 'OpenCode worker session must be listed');
    assert.strictEqual(worker.externalSessionId, workerSessionId);
    assert.strictEqual(worker.externalProjectRef, canonicalPath);

    const planner = sessions.find((s) => s.providerType === 'chatgpt');
    assert.ok(planner, 'ChatGPT planner session must be listed');
    assert.strictEqual((planner.lastEvidence?.details as any)?.projectUrl, plannerUrl);
    assert.strictEqual(planner.externalProjectRef, plannerUrl);
  });

  test('saved bindings survive a clean restart (new engine, same database)', async () => {
    const freshEngine = new RelayEngine(db);
    const freshService = new RelayApiService(db, freshEngine);

    const projects = await freshService.listProjects();
    const project = projects.find((p) => p.workerWorkspacePath === '/Users/relay/persist-project');
    assert.ok(project, 'project must still carry its saved worker workspace after restart');
    assert.strictEqual(project.plannerProjectUrl, 'https://chatgpt.com/p/persist-id');
    assert.strictEqual(project.workerWorkspacePath, '/Users/relay/persist-project');

    const sessions = await freshService.listRuntimeSessions();
    const worker = sessions.find((s) => s.providerType === 'opencode');
    assert.ok(worker);
    assert.strictEqual(worker.externalSessionId, 'session_persist_42');
    assert.strictEqual(worker.externalProjectRef, '/Users/relay/persist-project');
  });
});