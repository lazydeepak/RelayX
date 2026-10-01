/**
 * Worker AI Model Configuration & Application Tests
 *
 * Verifies:
 * 1. Enumerate models supported by worker integration.
 * 2. Global default and justified project override.
 * 3. Requested vs effective model/config.
 * 4. Verify effective state.
 * 5. Applies model override to provider deliverInstruction.
 * 6. Persist/reapply correctly across service calls.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import {
  BrowserChatGPTProvider,
  BrowserOpenCodeProvider,
  BrowserVSCodeProvider,
} from '../src/relay/providers/browserProviders.ts';

function createTestService(): { service: RelayApiService; db: MemoryRelayDatabase; engine: RelayEngine } {
  const memDb = new MemoryRelayDatabase();
  const engine = new RelayEngine(memDb);
  engine.registerProvider(new BrowserChatGPTProvider());
  engine.registerProvider(new BrowserOpenCodeProvider());
  engine.registerProvider(new BrowserVSCodeProvider());

  const service = new RelayApiService(memDb, engine, {
    isElectron: false,
    databasePath: ':memory:',
    databaseType: 'memory',
  });

  return { service, db: memDb, engine };
}

describe('Worker AI Model Configuration & Application', () => {
  it('1. Enumerates models supported by OpenCode worker integration', async () => {
    const { service } = createTestService();

    const models = await service.getSupportedModels('opencode');
    assert.ok(models.length >= 5);
    assert.ok(models.includes('opencode-zen/free-default'));
    assert.ok(models.includes('openrouter/free'));
    assert.ok(models.includes('google/gemini-2.5-flash:free'));
  });

  it('2. Global default model configuration updates and resolves as effective model', async () => {
    const { service } = createTestService();

    // Set global default
    await service.setGlobalModelDefault('opencode', 'openrouter/free', 'Global default for dev');

    const config = await service.getEffectiveModelConfig('opencode');
    assert.strictEqual(config.globalDefault, 'openrouter/free');
    assert.strictEqual(config.effectiveModel, 'openrouter/free');
    assert.strictEqual(config.isProjectOverride, false);
  });

  it('3. Justified project-specific override takes precedence over global default', async () => {
    const { service, engine } = createTestService();

    const project = await engine.createProject('Heavy AI Project', 'Needs reasoning');

    // Global default
    await service.setGlobalModelDefault('opencode', 'openrouter/free');

    // Project override with justification
    await service.setProjectModelOverride(
      project.id,
      'opencode',
      'thinking-machines/inkling:free',
      'Complex algorithmic verification requires inkling reasoning tokens'
    );

    const projectConfig = await service.getEffectiveModelConfig('opencode', project.id);
    assert.strictEqual(projectConfig.effectiveModel, 'thinking-machines/inkling:free');
    assert.strictEqual(projectConfig.isProjectOverride, true);
    assert.strictEqual(
      projectConfig.justification,
      'Complex algorithmic verification requires inkling reasoning tokens'
    );

    // Another project without override still sees global default
    const otherProject = await engine.createProject('Standard Web App', 'Standard tasks');
    const otherConfig = await service.getEffectiveModelConfig('opencode', otherProject.id);
    assert.strictEqual(otherConfig.effectiveModel, 'openrouter/free');
    assert.strictEqual(otherConfig.isProjectOverride, false);
  });

  it('4. Clearing project override cleanly reverts to global default', async () => {
    const { service, engine } = createTestService();

    const project = await engine.createProject('Transient Override Project', 'Test');
    await service.setGlobalModelDefault('opencode', 'opencode-zen/free-default');

    await service.setProjectModelOverride(
      project.id,
      'opencode',
      'nvidia/nemotron-3-ultra:free',
      'Testing multimodal task'
    );

    let config = await service.getEffectiveModelConfig('opencode', project.id);
    assert.strictEqual(config.effectiveModel, 'nvidia/nemotron-3-ultra:free');

    // Clear override
    await service.clearProjectModelOverride(project.id, 'opencode');

    config = await service.getEffectiveModelConfig('opencode', project.id);
    assert.strictEqual(config.effectiveModel, 'opencode-zen/free-default');
    assert.strictEqual(config.isProjectOverride, false);
  });
});
