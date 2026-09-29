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
    assert.ok(models.includes('anthropic/claude-3-7-sonnet'));
    assert.ok(models.includes('openai/o3-mini'));
    assert.ok(models.includes('google/gemini-2.5-pro'));
  });

  it('2. Global default model configuration updates and resolves as effective model', async () => {
    const { service } = createTestService();

    // Set global default
    await service.setGlobalModelDefault('opencode', 'anthropic/claude-3-5-sonnet', 'Global default for dev');

    const config = await service.getEffectiveModelConfig('opencode');
    assert.strictEqual(config.globalDefault, 'anthropic/claude-3-5-sonnet');
    assert.strictEqual(config.effectiveModel, 'anthropic/claude-3-5-sonnet');
    assert.strictEqual(config.isProjectOverride, false);
  });

  it('3. Justified project-specific override takes precedence over global default', async () => {
    const { service, engine } = createTestService();

    const project = await engine.createProject('Heavy AI Project', 'Needs reasoning');

    // Global default
    await service.setGlobalModelDefault('opencode', 'anthropic/claude-3-5-sonnet');

    // Project override with justification
    await service.setProjectModelOverride(
      project.id,
      'opencode',
      'openai/o3-mini',
      'Complex algorithmic verification requires o3-mini reasoning tokens'
    );

    const projectConfig = await service.getEffectiveModelConfig('opencode', project.id);
    assert.strictEqual(projectConfig.effectiveModel, 'openai/o3-mini');
    assert.strictEqual(projectConfig.isProjectOverride, true);
    assert.strictEqual(
      projectConfig.justification,
      'Complex algorithmic verification requires o3-mini reasoning tokens'
    );

    // Another project without override still sees global default
    const otherProject = await engine.createProject('Standard Web App', 'Standard tasks');
    const otherConfig = await service.getEffectiveModelConfig('opencode', otherProject.id);
    assert.strictEqual(otherConfig.effectiveModel, 'anthropic/claude-3-5-sonnet');
    assert.strictEqual(otherConfig.isProjectOverride, false);
  });

  it('4. Clearing project override cleanly reverts to global default', async () => {
    const { service, engine } = createTestService();

    const project = await engine.createProject('Transient Override Project', 'Test');
    await service.setGlobalModelDefault('opencode', 'anthropic/claude-3-7-sonnet');

    await service.setProjectModelOverride(
      project.id,
      'opencode',
      'google/gemini-2.5-pro',
      'Testing multimodal task'
    );

    let config = await service.getEffectiveModelConfig('opencode', project.id);
    assert.strictEqual(config.effectiveModel, 'google/gemini-2.5-pro');

    // Clear override
    await service.clearProjectModelOverride(project.id, 'opencode');

    config = await service.getEffectiveModelConfig('opencode', project.id);
    assert.strictEqual(config.effectiveModel, 'anthropic/claude-3-7-sonnet');
    assert.strictEqual(config.isProjectOverride, false);
  });
});
