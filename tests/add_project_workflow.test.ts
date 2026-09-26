import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { ChatGPTProvider, OpenCodeProvider, VSCodeProvider } from '../src/relay/providers/adapters.ts';
import { ProjectId } from '../src/relay/domain/types.ts';

describe('RelayX Add Project Workflow Verification', () => {
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

  test('End-to-End Add Project Workflow: Real-World Simulation', async (t) => {
    // 1. Simulation of Folder Selection
    const projectPath = '/Users/relay/alpha-project';
    const gitRoot = '/Users/relay/alpha-project';
    const projectName = 'Alpha Project';

    await t.test('Step 1: Discover Ambiguous ChatGPT Projects', async () => {
      // Mock the provider to return multiple matches
      const chatgpt = engine.getProvider('chatgpt') as any;
      const originalResolve = chatgpt.resolveChatGPTProject.bind(chatgpt);
      
      chatgpt.resolveChatGPTProject = async () => ({
        success: false,
        error: 'Multiple projects found',
        foundMultiple: [
          { name: 'Alpha Project', url: 'https://chatgpt.com/p/alpha-id-1' },
          { name: 'Alpha Project (Archived)', url: 'https://chatgpt.com/p/alpha-id-old' }
        ]
      });

      const res = await service.resolveChatGPTProject(projectName);
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.foundMultiple?.length, 2);
      assert.strictEqual(res.foundMultiple![0].url, 'https://chatgpt.com/p/alpha-id-1');

      // Restore
      chatgpt.resolveChatGPTProject = originalResolve;
    });

    await t.test('Step 2: Discover OpenCode Session with Deep Correlation', async () => {
      // Mock OpenCode to return a session with exact path match
      const opencode = engine.getProvider('opencode') as any;
      const originalMatch = opencode.matchSessionsByPath.bind(opencode);

      opencode.matchSessionsByPath = async (path: string, root?: string) => {
        return {
          success: true,
          sessions: [{
            found: true,
            status: 'available',
            applicationPid: 1234,
            windowTitle: 'OpenCode - Alpha Project',
            bundleIdentifier: 'com.opencode.desktop',
            evidence: {
              id: 'ev_real_match',
              timestamp: Date.now(),
              source: 'macos_system_events',
              details: { 
                parsedSessionId: 'session_real_99',
                workspacePath: path,
                matchScore: 100,
                matchedVia: 'exact_path'
              }
            }
          }],
          diagnostics: { mocked: true }
        };
      };

      const res = await service.discoverOpenCodeSessions(projectPath, gitRoot);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.sessions.length, 1);
      assert.strictEqual(res.sessions[0].sessionId, 'session_real_99');
      assert.strictEqual(res.sessions[0].matchedVia, 'exact_path');

      // Restore
      (opencode as any).matchSessionsByPath = originalMatch;
    });

    await t.test('Step 3: Finalize Setup with User Selected Planner', async () => {
      const setup = {
        name: projectName,
        description: 'Bound project via verified workflow',
        canonicalPath: projectPath,
        gitRoot,
        plannerUrl: 'https://chatgpt.com/p/alpha-id-1', // User selected from list
        workerSessionId: 'session_real_99',
      };

      const res = await service.finalizeProjectSetup(setup);
      assert.strictEqual(res.success, true);
      assert.ok(res.projectId);

      // Verify Project Domain Record
      const project = await db.projects.findById(res.projectId as ProjectId);
      assert.strictEqual(project?.name, projectName);
      assert.strictEqual(project?.canonicalPath, projectPath);
      assert.strictEqual(project?.gitRoot, gitRoot);

      // Setup registers the runtimes but must NOT pair them: the session ids in
      // the wizard payload are caller input, not provider-verified evidence, so
      // pairing is deferred to the discovery/adoption path.
      const pairs = await db.pairs.findByProjectId(res.projectId as ProjectId);
      assert.deepStrictEqual(pairs, []);

      const runtimes = await db.runtimes.findAll();
      const planner = runtimes.find((r) => r.providerType === 'chatgpt');
      assert.strictEqual(planner?.providerType, 'chatgpt');
      assert.strictEqual((planner?.lastEvidence?.details as any)?.projectUrl, 'https://chatgpt.com/p/alpha-id-1');

      const worker = runtimes.find((r) => r.providerType === 'opencode');
      assert.strictEqual(worker?.providerType, 'opencode');
      assert.strictEqual((worker?.lastEvidence?.details as any)?.sessionId, 'session_real_99');
    });

    await t.test('Step 4: Persistence Verification across clean restart', async () => {
      // Simulate Restart
      const newEngine = new RelayEngine(db);
      const repos = db;

      const projects = await repos.projects.findAll();
      const project = projects.find(p => p.name === projectName);
      assert.ok(project);
      assert.strictEqual(project.canonicalPath, projectPath);

      // The registered runtimes survive the restart even though setup pairs
      // nothing, so the saved bindings are readable without a pair.
      const runtimes = await repos.runtimes.findAll();
      const planner = runtimes.find((r) => r.providerType === 'chatgpt');
      assert.strictEqual((planner?.lastEvidence?.details as any)?.projectUrl, 'https://chatgpt.com/p/alpha-id-1');
    });
  });
});
