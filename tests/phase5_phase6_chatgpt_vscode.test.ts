import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTProvider, VSCodeProvider } from '../src/relay/providers/adapters.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';

describe('Phase 5 & Phase 6 — ChatGPT Planner & VS Code Provider', () => {
  it('detects, visibly focuses, and delivers planning context to ChatGPT desktop', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);

    class ControllableChatGPTProvider extends ChatGPTProvider {
      protected override probeMacOSProcess(_name: string) {
        return {
          running: true,
          pid: 3310,
          windowTitle: 'ChatGPT — Project Architecture',
          details: { testEnvironment: true },
        };
      }

      public override runAppleScript(script: string) {
        if (script.includes('activate')) {
          return { success: true, output: 'focused' };
        }
        if (script.includes('key code 36')) {
          return { success: true, output: 'sent::true' };
        }
        return { success: true, output: '' };
      }
    }

    const chatgpt = new ControllableChatGPTProvider();
    engine.registerProvider(chatgpt);

    const project = await engine.createProject('Planning Proj');
    const planner = await engine.registerRuntimeSession('chatgpt', 'macOS ChatGPT');
    const worker = await engine.registerRuntimeSession('opencode', 'macOS OpenCode');
    const pair = await engine.createPair(project.id, 'Pair with ChatGPT Planner', planner.id, worker.id);

    const res = await chatgpt.deliverInstruction({
      runtimeSessionId: planner.id,
      instructionText: 'Plan the authentication migration for Relay',
      idempotencyKey: 'idemp_plan_1',
    });

    assert.equal(res.outcome, 'delivered');
    assert.ok(res.evidence);
    assert.equal(res.evidence.source, 'macos_system_events');
    assert.equal(res.evidence.visibleButtonState?.stopButtonVisible, true);
  });

  it('reports truthful unavailable state for ChatGPT when not running or unsupported', async () => {
    const provider = new ChatGPTProvider();
    const result = await provider.findRuntime({ providerType: 'chatgpt' });

    assert.equal(result.found, false);
    assert.equal(result.status, 'unavailable');
    assert.ok(result.evidence);
  });

  it('VS Code provider accurately parses active editor file and workspace folder from window title', () => {
    const vscode = new VSCodeProvider();

    const title1 = 'RelayEngine.ts — relay-app';
    const parsed1 = vscode.parseWorkspace(title1);
    assert.equal(parsed1.activeFile, 'RelayEngine.ts');
    assert.equal(parsed1.workspaceName, 'relay-app');

    const title2 = 'relay-core — Visual Studio Code';
    const parsed2 = vscode.parseWorkspace(title2);
    assert.equal(parsed2.activeFile, 'relay-core');
    assert.equal(parsed2.workspaceName, undefined);
  });
});
