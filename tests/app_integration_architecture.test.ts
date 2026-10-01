/**
 * App Integration Architecture Tests
 *
 * Verifies the 8 core principles:
 * 1. RelayX has one common engine (orchestration, Pair handling, assignments, transport, etc. are common).
 * 2. Each external app has its own integration handler/scripts.
 * 3. Integrations list configured apps (ChatGPT Planner, OpenCode Worker, etc.), support enable/disable, configure, verify, and set as default.
 * 4. Add App: allows integrating another Planner or Worker with app path, launch behavior, automation scripts, and handlers.
 * 5. Invariant: At least one enabled default on each side (Default Planner, Default Worker).
 * 6. The engine itself works in terms of roles (Planner, Worker) resolved by the integration layer.
 * 7. Automatic Pair provisioning asks for Planner & Worker from integration layer defaults.
 * 8. Existing Pairs remain bound to their created sessions/integrations even when defaults are later changed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import {
  BrowserChatGPTProvider,
  BrowserOpenCodeProvider,
} from '../src/relay/providers/browserProviders.ts';

function createTestHarness(): {
  service: RelayApiService;
  db: MemoryRelayDatabase;
  engine: RelayEngine;
} {
  const memDb = new MemoryRelayDatabase();
  const engine = new RelayEngine(memDb);
  engine.registerProvider(new BrowserChatGPTProvider());
  engine.registerProvider(new BrowserOpenCodeProvider());

  const service = new RelayApiService(memDb, engine, {
    isElectron: false,
    databasePath: ':memory:',
    databaseType: 'memory',
  });

  return { service, db: memDb, engine };
}

describe('RelayX App Integration Architecture', () => {
  it('1 & 2. Handlers exist for external apps and list initially configured apps', async () => {
    const { service } = createTestHarness();
    const list = await service.listIntegrations();

    assert.ok(list.length >= 3, 'Should list at least ChatGPT, OpenCode, and VS Code');
    const chatgpt = list.find((i) => i.id === 'chatgpt');
    const opencode = list.find((i) => i.id === 'opencode');

    assert.ok(chatgpt, 'ChatGPT integration must exist');
    assert.strictEqual(chatgpt.role, 'planner');
    assert.strictEqual(chatgpt.isDefaultPlanner, true);
    assert.strictEqual(chatgpt.isEnabled, true);

    assert.ok(opencode, 'OpenCode integration must exist');
    assert.strictEqual(opencode.role, 'worker');
    assert.strictEqual(opencode.isDefaultWorker, true);
    assert.strictEqual(opencode.isEnabled, true);
  });

  it('3. Can configure, verify, and recheck integrations', async () => {
    const { service } = createTestHarness();

    // Verify ChatGPT
    const verifiedChatGPT = await service.verifyIntegration('chatgpt');
    assert.ok(verifiedChatGPT.lastVerifiedAt, 'Verification timestamp set');
    assert.ok(verifiedChatGPT.lastVerificationResult?.ok, 'Verification should be ok');

    // Update integration configuration
    const updated = await service.updateIntegration('chatgpt', {
      description: 'Updated planner description',
    });
    assert.strictEqual(updated.description, 'Updated planner description');

    // Recheck all
    const rechecked = await service.recheckAllIntegrations();
    assert.ok(rechecked.length >= 3);
  });

  it('4. + Add App: Can integrate a new custom Planner application with automation scripts', async () => {
    const { service } = createTestHarness();

    const customPlanner = await service.addIntegration({
      id: 'custom_planner',
      name: 'Custom Team Planner',
      role: 'planner',
      appType: 'app_bundle',
      launchBehavior: 'launch_url',
      appPath: '/Applications/CustomPlanner.app',
      scripts: {
        launchScript: 'open -a CustomPlanner',
        createSessionScript: 'echo \'{"sessionId": "custom-plan-001"}\'',
      },
      isEnabled: true,
      isDefaultPlanner: false,
    });

    assert.strictEqual(customPlanner.id, 'custom_planner');
    assert.strictEqual(customPlanner.name, 'Custom Team Planner');
    assert.strictEqual(customPlanner.role, 'planner');
    assert.strictEqual(customPlanner.scripts?.launchScript, 'open -a CustomPlanner');

    const list = await service.listIntegrations();
    assert.ok(list.some((i) => i.id === 'custom_planner'));
  });

  it('5. Enforces invariant: at least one enabled default on each side, prevents disabling the only default', async () => {
    const { service } = createTestHarness();

    // Trying to disable ChatGPT while it is the only enabled planner must throw or switch
    await assert.rejects(
      async () => {
        await service.toggleIntegrationEnabled('chatgpt', false);
      },
      /Cannot disable "ChatGPT.*" because it is the only active Default Planner/,
    );

    // Add a second planner
    await service.addIntegration({
      id: 'secondary_planner',
      name: 'Secondary Planner',
      role: 'planner',
      isEnabled: true,
    });

    // Make secondary planner the default
    const setDefRes = await service.setDefaultIntegration('secondary_planner', 'planner');
    assert.strictEqual(setDefRes.success, true);

    const defaultPlanner = await service.getDefaultPlannerIntegration();
    assert.strictEqual(defaultPlanner.id, 'secondary_planner');

    // Now chatgpt is no longer default planner, so it CAN be disabled safely
    const disabledChatGPT = await service.toggleIntegrationEnabled('chatgpt', false);
    assert.strictEqual(disabledChatGPT.isEnabled, false);
  });

  it('6 & 7. RelayX automatic pair provisioning resolves to currently configured defaults', async () => {
    const { service } = createTestHarness();

    // Create a project
    const project = await service.createProject(
      'Integration Arch Project',
      'Testing common engine pair resolution',
    );
    await service.updateProject(project.id, {
      canonicalPath: '/tmp/test_integration_proj',
      plannerProjectUrl: 'https://chatgpt.com/g/g-p-preview-project',
      workerWorkspacePath: '/tmp/test_integration_proj',
    });

    // Initial defaults are ChatGPT (planner) and OpenCode (worker)
    const pair1 = await service.provisionPairWithNewSessions(project.id, 'Pair with Initial Defaults');
    assert.ok(pair1.pair);
    assert.strictEqual(pair1.plannerRuntime.providerType, 'chatgpt');
    assert.strictEqual(pair1.workerRuntime.providerType, 'opencode');

    // Add a custom worker app and set it as Default Worker
    await service.addIntegration({
      id: 'custom_worker',
      name: 'Custom Autonomous Agent',
      role: 'worker',
      appType: 'cli_service',
      launchBehavior: 'exec_cli',
      cliCommand: 'agent-cli',
      isEnabled: true,
    });
    await service.setDefaultIntegration('custom_worker', 'worker');

    const currentWorkerDefault = await service.getDefaultWorkerIntegration();
    assert.strictEqual(currentWorkerDefault.id, 'custom_worker');

    // Provision another pair - engine asks integration layer for Planner and Worker
    // Integration layer returns ChatGPT for planner and custom_worker for worker!
    const pair2 = await service.provisionPairWithNewSessions(project.id, 'Pair with Custom Worker Default');
    assert.ok(pair2.pair);
    assert.strictEqual(pair2.plannerRuntime.providerType, 'chatgpt');
    assert.strictEqual(pair2.workerRuntime.providerType, 'custom_worker');
  });

  it('8. Existing Pairs remain bound to their actual integrations and do not switch when defaults change', async () => {
    const { service } = createTestHarness();

    const project = await service.createProject(
      'Pair Immutability Project',
      'Verifying session binding stability',
    );
    await service.updateProject(project.id, {
      canonicalPath: '/tmp/test_immutability_proj',
      plannerProjectUrl: 'https://chatgpt.com/g/g-p-preview-project',
      workerWorkspacePath: '/tmp/test_immutability_proj',
    });

    // Provision pair under initial defaults
    const provisioned = await service.provisionPairWithNewSessions(project.id, 'Authoritative Pair');
    const originalPairId = provisioned.pair.id;
    const originalPlannerSessionId = provisioned.plannerRuntime.id;
    const originalWorkerSessionId = provisioned.workerRuntime.id;

    // Verify initial binding
    let pair = (await service.listPairs()).find((p) => p.id === originalPairId)!;
    assert.strictEqual(pair.plannerSessionId, originalPlannerSessionId);
    assert.strictEqual(pair.workerSessionId, originalWorkerSessionId);

    // Now change BOTH default planner and default worker
    await service.addIntegration({
      id: 'new_planner',
      name: 'New Planner App',
      role: 'planner',
      isEnabled: true,
    });
    await service.setDefaultIntegration('new_planner', 'planner');

    await service.addIntegration({
      id: 'new_worker',
      name: 'New Worker App',
      role: 'worker',
      isEnabled: true,
    });
    await service.setDefaultIntegration('new_worker', 'worker');

    // Verify existing Pair is still bound to the original sessions and runtimes
    pair = (await service.listPairs()).find((p) => p.id === originalPairId)!;
    assert.strictEqual(pair.plannerSessionId, originalPlannerSessionId);
    assert.strictEqual(pair.workerSessionId, originalWorkerSessionId);

    // Inspecting sessions of this pair returns original session records
    const runtimes = await service.listRuntimeSessions();
    const boundPlanner = runtimes.find((r) => r.id === pair.plannerSessionId);
    const boundWorker = runtimes.find((r) => r.id === pair.workerSessionId);

    assert.strictEqual(boundPlanner?.providerType, 'chatgpt');
    assert.strictEqual(boundWorker?.providerType, 'opencode');
  });
});
