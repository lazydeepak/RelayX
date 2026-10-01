import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { IntegrationManager } from '../src/relay/integrations/IntegrationManager.ts';
import { ConfigurableAppHandler } from '../src/relay/integrations/handlers/ConfigurableAppHandler.ts';
import {
  BrowserChatGPTProvider,
  BrowserOpenCodeProvider,
  BrowserVSCodeProvider,
} from '../src/relay/providers/browserProviders.ts';

test('Integration Architecture & App Handlers Suite', async (t) => {
  await t.test('1. Baseline initialization contains ChatGPT, OpenCode, and VS Code', async () => {
    const memDb = new MemoryRelayDatabase();
    const engine = new RelayEngine(memDb);
    const mgr = new IntegrationManager(memDb, engine);
    await mgr.initialize();

    const configs = mgr.listConfigs();
    assert.equal(configs.length, 3);

    const chatgpt = configs.find((c) => c.id === 'chatgpt');
    assert.ok(chatgpt);
    assert.equal(chatgpt.role, 'planner');
    assert.equal(chatgpt.isEnabled, true);
    assert.equal(chatgpt.isDefaultPlanner, true);

    const opencode = configs.find((c) => c.id === 'opencode');
    assert.ok(opencode);
    assert.equal(opencode.role, 'worker');
    assert.equal(opencode.isEnabled, true);
    assert.equal(opencode.isDefaultWorker, true);

    const vscode = configs.find((c) => c.id === 'vscode');
    assert.ok(vscode);
    assert.equal(vscode.role, 'worker');
    assert.equal(vscode.isDefaultWorker, false);
  });

  await t.test('2. Resolves Default Planner and Default Worker handlers', async () => {
    const memDb = new MemoryRelayDatabase();
    const engine = new RelayEngine(memDb);
    const mgr = new IntegrationManager(memDb, engine);

    const plannerHandler = await mgr.getDefaultPlanner();
    assert.equal(plannerHandler.config.id, 'chatgpt');
    assert.equal(plannerHandler.config.role, 'planner');

    const workerHandler = await mgr.getDefaultWorker();
    assert.equal(workerHandler.config.id, 'opencode');
    assert.equal(workerHandler.config.role, 'worker');
  });

  await t.test('3. Invariant: Cannot disable the only enabled Default Planner or Worker', async () => {
    const memDb = new MemoryRelayDatabase();
    const engine = new RelayEngine(memDb);
    const mgr = new IntegrationManager(memDb, engine);
    await mgr.initialize();

    // Disabling chatgpt rejects because it is the only enabled planner:
    await assert.rejects(
      async () => {
        await mgr.toggleEnabled('chatgpt', false);
      },
      (err: any) => {
        return err.message.includes('Cannot disable') && err.message.includes('Planner');
      },
    );

    // Disabling opencode succeeds because vscode is also an enabled worker; vscode is auto-promoted:
    await mgr.toggleEnabled('opencode', false);
    const defWorker = await mgr.getDefaultWorker();
    assert.equal(defWorker.config.id, 'vscode');
    assert.equal(defWorker.config.isDefaultWorker, true);

    // Now trying to disable vscode (which is now the only enabled worker) must reject!
    await assert.rejects(
      async () => {
        await mgr.toggleEnabled('vscode', false);
      },
      (err: any) => {
        return err.message.includes('Cannot disable') && err.message.includes('Worker');
      },
    );
  });

  await t.test('4. Add custom Planner application (+ Add App) and switch default planner', async () => {
    const memDb = new MemoryRelayDatabase();
    const engine = new RelayEngine(memDb);
    const mgr = new IntegrationManager(memDb, engine);
    await mgr.initialize();

    const claudeApp = await mgr.addApp({
      name: 'Claude Desktop',
      role: 'planner',
      appType: 'app_bundle',
      appPath: '/Applications/Claude.app',
      bundleId: 'com.anthropic.claude-desktop',
      scripts: {
        launchScript: 'tell application "Claude" to activate',
        createSessionScript: 'keystroke "n" using command down',
        sendMessageScript: 'keystroke "{instruction}"',
      },
      isDefaultPlanner: true,
      isEnabled: true,
    });

    assert.ok(claudeApp);
    assert.equal(claudeApp.role, 'planner');
    assert.equal(claudeApp.isDefaultPlanner, true);

    // Old default planner (chatgpt) must no longer be default planner
    const chatgpt = mgr.getHandler('chatgpt');
    assert.equal(chatgpt?.config.isDefaultPlanner, false);

    // Default planner resolution now returns Claude Desktop!
    const defaultPlanner = await mgr.getDefaultPlanner();
    assert.equal(defaultPlanner.config.id, claudeApp.id);
    assert.equal(defaultPlanner.config.name, 'Claude Desktop');
  });

  await t.test('5. Add custom Worker application (+ Add App) and switch default worker', async () => {
    const memDb = new MemoryRelayDatabase();
    const engine = new RelayEngine(memDb);
    const mgr = new IntegrationManager(memDb, engine);
    await mgr.initialize();

    const cursorApp = await mgr.addApp({
      name: 'Cursor AI Editor',
      role: 'worker',
      appType: 'editor',
      cliCommand: 'cursor',
      scripts: {
        launchScript: 'cursor "{projectPath}"',
        createSessionScript: 'cursor "{projectPath}"',
        sendMessageScript: 'keystroke "{instruction}"',
      },
      isDefaultWorker: true,
      isEnabled: true,
    });

    assert.ok(cursorApp);
    assert.equal(cursorApp.role, 'worker');
    assert.equal(cursorApp.isDefaultWorker, true);

    // Old default worker (opencode) must no longer be default worker
    const opencode = mgr.getHandler('opencode');
    assert.equal(opencode?.config.isDefaultWorker, false);

    // Default worker resolution now returns Cursor!
    const defaultWorker = await mgr.getDefaultWorker();
    assert.equal(defaultWorker.config.id, cursorApp.id);
    assert.equal(defaultWorker.config.name, 'Cursor AI Editor');
  });

  await t.test('6. Automatic Pair Provisioning uses current defaults, and existing Pairs stay authoritative', async () => {
    const memDb = new MemoryRelayDatabase();
    const engine = new RelayEngine(memDb);
    engine.registerProvider(new BrowserChatGPTProvider());
    engine.registerProvider(new BrowserOpenCodeProvider());
    engine.registerProvider(new BrowserVSCodeProvider());

    const api = new RelayApiService(memDb, engine, { databasePath: ':memory:', databaseType: 'memory' });

    // Create a project
    const project = await api.createProject('Project Alpha', 'Testing Integrations');
    await api.updateProject(project.id, {
      canonicalPath: '/tmp/alpha',
      plannerProjectUrl: 'https://chatgpt.com/g/g-p-preview-project',
      workerWorkspacePath: '/tmp/alpha',
    });

    // Provision Pair 1 with baseline defaults (ChatGPT + OpenCode)
    const pairResult1 = await api.provisionPairWithNewSessions(
      project.id,
      'Pair Baseline',
    );
    assert.ok(pairResult1.pair);
    assert.equal(pairResult1.plannerRuntime.providerType, 'chatgpt');
    assert.equal(pairResult1.workerRuntime.providerType, 'opencode');

    // Add a custom Worker (Cursor) and set as default worker
    await api.addIntegration({
      name: 'Cursor Editor',
      role: 'worker',
      appType: 'editor',
      cliCommand: 'cursor',
      isDefaultWorker: true,
      isEnabled: true,
    });

    // Check that default worker is now Cursor
    const defWorker = await api.getDefaultWorkerIntegration();
    assert.equal(defWorker.name, 'Cursor Editor');

    // Provision Pair 2 with new defaults (ChatGPT + Cursor)
    const pairResult2 = await api.provisionPairWithNewSessions(
      project.id,
      'Pair With Cursor',
    );
    assert.ok(pairResult2.pair);
    assert.equal(pairResult2.plannerRuntime.providerType, 'chatgpt');
    assert.equal(pairResult2.workerRuntime.providerType, 'cursor_editor');

    // Requirement 8: Check that Pair 1 is STILL bound to OpenCode and has NOT switched!
    const loadedPair1 = await api.getPair(pairResult1.pair.id);
    assert.ok(loadedPair1);
    assert.equal(loadedPair1.workerSessionId, pairResult1.workerRuntime.id);
    const worker1 = (await api.listRuntimeSessions()).find((r) => r.id === loadedPair1.workerSessionId);
    assert.equal(worker1?.providerType, 'opencode');
  });

  await t.test('7. Cannot delete built-in integrations or active default integrations', async () => {
    const memDb = new MemoryRelayDatabase();
    const engine = new RelayEngine(memDb);
    const mgr = new IntegrationManager(memDb, engine);
    await mgr.initialize();

    const deleteBuiltin = await mgr.deleteApp('chatgpt');
    assert.equal(deleteBuiltin.success, false);
    assert.match(deleteBuiltin.error || '', /Cannot delete built-in/);

    // Add a custom app
    const custom = await mgr.addApp({
      name: 'Temp Worker',
      role: 'worker',
      isDefaultWorker: true,
    });

    // Try to delete while it is default worker
    const deleteDefault = await mgr.deleteApp(custom.id);
    assert.equal(deleteDefault.success, false);
    assert.match(deleteDefault.error || '', /Cannot delete .* while it is set as default/);

    // Switch default back to opencode
    await mgr.setDefault('opencode', 'worker');

    // Now delete custom app
    const deleteSuccess = await mgr.deleteApp(custom.id);
    assert.equal(deleteSuccess.success, true);
    assert.equal(mgr.getHandler(custom.id), undefined);
  });
});
