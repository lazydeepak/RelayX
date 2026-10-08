import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTProvider, VSCodeProvider } from '../src/relay/providers/adapters.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';

describe('Phase 5 & Phase 6 — ChatGPT Planner & VS Code Provider', () => {
  it('delivers planning context into the bound ChatGPT conversation in Chrome, never the desktop app', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);

    const CONV = '6ac1a7c4-7b40-83ec-ba40-86180675f217';
    const EXACT = `https://chatgpt.com/c/${CONV}`;
    // The conversation DOM: the pre-send boundary holds only the bootstrap turn, and the
    // post-send read observes the newly created instruction turn.
    const dom = { submitted: false };

    class ControllableChatGPTProvider extends ChatGPTProvider {
      /**
       * The desktop app is NOT running on this host. Delivery must therefore still succeed,
       * because the bound planner session is the Chrome conversation, not the app. Any probe
       * of the desktop process is a failure of the transport authority rule and is recorded.
       */
      desktopProbes: string[] = [];
      desktopScripts: string[] = [];

      protected override probeMacOSProcess(name: string) {
        this.desktopProbes.push(name);
        return { running: false, details: { reason: 'ChatGPT desktop app is not installed' } };
      }

      public override runAppleScript(script: string) {
        // Any AppleScript aimed at the ChatGPT application (rather than Chrome) is recorded so
        // the assertion below can prove the desktop app is never raised or typed into.
        if (/tell application "ChatGPT"/.test(script) || /application process "ChatGPT"/.test(script)) {
          this.desktopScripts.push(script);
        }
        return { success: false, output: '', error: 'no host automation in unit test' };
      }

      public async openExactSessionInChrome(url: string, conversationId: string) {
        return {
          success: true,
          reused: true,
          windowId: 85437176,
          tabId: 85437179,
          requestedUrl: url,
          conversationId,
          observedUrl: EXACT,
          diagnostics: ['stage:verified-reused'],
        };
      }

      public async submitExactSessionTurn(
        _handle: any,
        _url: string,
        _conversationId: string,
        _text: string,
      ) {
        dom.submitted = true;
        return {
          success: true,
          requestedUrl: EXACT,
          conversationId: CONV,
          submitMechanism: 'send_button' as const,
          editorSelectorUsed: '.ProseMirror',
          composerCleared: true,
          observedTurn: { ref: 'chatgpt_u_new', ordinal: 1, text: 'Plan the authentication migration for Relay', role: 'user' as const },
          diagnostics: ['gate:verified'],
        };
      }
    }

    const chatgpt = new ControllableChatGPTProvider();
    engine.registerProvider(chatgpt);

    const project = await engine.createProject('Planning Proj');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Chrome ChatGPT Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'macOS OpenCode');
    await engine.createPair(project.id, 'Pair with ChatGPT Planner', planner.id, worker.id);

    // The conversation DOM: the pre-send boundary holds only the bootstrap turn, and the
    // post-send read observes the newly created instruction turn.
    (chatgpt as any).openDedicatedWindowAndCaptureId = () => ({ windowId: 85437176, tabId: 85437179 });
    (chatgpt as any).verifyHandleExists = () => true;
    (chatgpt as any).readHandleUrl = () => EXACT;
    (chatgpt as any).sleep = async () => {};
    (chatgpt as any).executeHandleJavaScript = (_h: any, _js: string) => {
      const turns = dom.submitted
        ? [
            { ordinal: 0, role: 'user', text: '[RelayX Provisioning] Planner session initialized' },
            { ordinal: 1, role: 'user', text: 'Plan the authentication migration for Relay' },
          ]
        : [{ ordinal: 0, role: 'user', text: '[RelayX Provisioning] Planner session initialized' }];
      return { success: true, output: JSON.stringify({ ok: true, turns }) };
    };

    const res = await chatgpt.deliverInstruction({
      runtimeSessionId: planner.id,
      externalSessionId: CONV,
      instructionText: 'Plan the authentication migration for Relay',
      idempotencyKey: 'idemp_plan_1',
    });

    assert.equal(res.outcome, 'delivered', res.reason ?? '');
    assert.ok(res.evidence);
    // A Chrome DOM write read back from the same conversation, not a desktop-app UI event.
    assert.equal(res.evidence.source, 'reconciliation_probe');
    assert.equal(res.evidence.details?.conversationId, CONV);
    assert.equal(res.evidence.details?.preDispatchBoundaryMessageCount, 1);
    assert.equal(res.evidence.details?.observedTurnOrdinal, 1);
    assert.match(String(res.evidence.details?.observedTurnRef), /^chatgpt_u_\d+_\d+$/);
    assert.deepEqual(chatgpt.desktopProbes, [], 'the ChatGPT desktop process must never be probed');
    assert.deepEqual(chatgpt.desktopScripts, [], 'the ChatGPT desktop app must never be scripted');
  });

  it('reports truthful unavailable state for ChatGPT when not running or unsupported', async () => {
    // Deterministic: the host may or may not have ChatGPT running, so the probe is
    // stubbed rather than reading the real machine state. This still exercises the
    // real "not found" reporting path (evidence source reconciliation_probe).
    class NotRunningChatGPTProvider extends ChatGPTProvider {
      protected override probeMacOSProcess(_name: string) {
        return { running: false, details: { reason: 'Process not running (deterministic test)' } };
      }
      override async findAllRuntimes() {
        return [];
      }
    }

    const provider = new NotRunningChatGPTProvider();
    const result = await provider.findRuntime({ providerType: 'chatgpt' });

    assert.equal(result.found, false);
    assert.equal(result.status, 'unavailable');
    assert.ok(result.evidence);
    assert.equal(result.evidence.source, 'reconciliation_probe');
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
