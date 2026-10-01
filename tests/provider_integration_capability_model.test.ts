/**
 * Provider / App Integration & Capability Model Tests
 *
 * Verifies:
 * 1. First-class ChatGPT, OpenCode, and VS Code integrations.
 * 2. Provider-specific detection and identity (bundle ID, socket URL, executable).
 * 3. Host permissions and provider-specific requirements.
 * 4. Configure -> Verify -> Recheck lifecycle.
 * 5. Capability matrix: discover projects/sessions, create session, dispatch, capture transport, etc.
 * 6. Integrations expose external sessions rather than masquerading as runtimes.
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

describe('Provider / App Integration & Capability Model', () => {
  it('1. Lists all first-class integrations with correct roles and identities', async () => {
    const { service } = createTestService();

    const integrations = await service.listIntegrations();
    assert.strictEqual(integrations.length, 4);

    const chatgpt = integrations.find((i) => i.providerType === 'chatgpt');
    assert.ok(chatgpt);
    assert.strictEqual(chatgpt.role, 'planner');
    assert.strictEqual(chatgpt.identity.bundleId, 'com.openai.chat');

    const opencode = integrations.find((i) => i.providerType === 'opencode');
    assert.ok(opencode);
    assert.strictEqual(opencode.role, 'worker');
    assert.strictEqual(opencode.identity.executable, 'opencode');

    const vscode = integrations.find((i) => i.providerType === 'vscode');
    assert.ok(vscode);
    assert.strictEqual(vscode.role, 'worker');
    assert.strictEqual(vscode.identity.bundleId, 'com.microsoft.VSCode');
  });

  it('2. Capability matrix accurately reflects provider-specific execution capabilities', async () => {
    const { service } = createTestService();

    const integrations = await service.listIntegrations();
    const chatgpt = integrations.find((i) => i.providerType === 'chatgpt')!;
    const opencode = integrations.find((i) => i.providerType === 'opencode')!;
    const vscode = integrations.find((i) => i.providerType === 'vscode')!;

    // ChatGPT planner capabilities
    assert.strictEqual(chatgpt.capabilities.createSession, true);
    assert.strictEqual(chatgpt.capabilities.dispatchInstruction, true);
    assert.strictEqual(chatgpt.capabilities.reconcileExactSession, false);

    // OpenCode worker capabilities
    assert.strictEqual(opencode.capabilities.createSession, true);
    assert.strictEqual(opencode.capabilities.dispatchInstruction, true);
    assert.strictEqual(opencode.capabilities.captureTransportBoundary, true);
    assert.strictEqual(opencode.capabilities.reconcileExactSession, true);

    // VS Code context-only inspection capabilities
    assert.strictEqual(vscode.capabilities.discoverProjects, true);
    assert.strictEqual(vscode.capabilities.createSession, false);
    assert.strictEqual(vscode.capabilities.dispatchInstruction, false);
  });

  it('3. Verification lifecycle updates integration status and timestamp', async () => {
    const { service } = createTestService();

    const initial = await service.verifyIntegration('chatgpt');
    assert.ok(initial.lastVerifiedAt);
    assert.ok(initial.status);

    const recheckedAll = await service.recheckAllIntegrations();
    assert.strictEqual(recheckedAll.length, 4);
    for (const integ of recheckedAll) {
      assert.ok(integ.lastVerifiedAt);
      assert.ok(integ.lastVerificationResult);
    }
  });

  it('4. Integrations do not pollute or masquerade as Runtime Sessions in inventory', async () => {
    const { service } = createTestService();

    // Querying integrations
    await service.listIntegrations();

    // Runtime session inventory must remain empty until concrete sessions are created or adopted
    const runtimeSessions = await service.listRuntimeSessions();
    assert.strictEqual(runtimeSessions.length, 0, 'No synthetic runtime sessions created by integration probing');
  });
});
