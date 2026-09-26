import {
  RuntimeSessionId,
  ObservableEvidence,
  ProviderType,
  ProviderIntegrationStatus,
} from '../domain/types.ts';
import {
  IRuntimeProvider,
  RuntimeInspectionResult,
  RuntimeTargetDescriptor,
  DeliveryInstructionRequest,
  DeliveryInstructionResult,
} from './interfaces.ts';

/**
 * Browser-Safe Simulated Provider for Web Preview Fallbacks.
 * Contains NO Node.js built-ins (`child_process`, `fs`) so it will never leak
 * into or pollute the client-side renderer bundle.
 */
export abstract class BaseBrowserProvider implements IRuntimeProvider {
  abstract readonly providerType: ProviderType;
  abstract readonly integrationStatus: ProviderIntegrationStatus;
  abstract readonly defaultBundleId: string;
  abstract readonly defaultProcessName: string;
  abstract readonly defaultWindowTitle: string;

  async findRuntime(descriptor: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult> {
    const evidence: ObservableEvidence = {
      id: `ev_browser_${Date.now()}`,
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      bundleIdentifier: descriptor.bundleIdentifier ?? this.defaultBundleId,
      windowTitle: this.defaultWindowTitle,
      visibleButtonState: {
        sendButtonVisible: true,
        stopButtonVisible: false,
      },
      details: {
        environment: 'browser_preview',
        integrationStatus: this.integrationStatus,
      },
    };

    return {
      found: true,
      status: 'available',
      windowTitle: this.defaultWindowTitle,
      bundleIdentifier: descriptor.bundleIdentifier ?? this.defaultBundleId,
      composerVisible: true,
      composerHasFocus: true,
      sendButtonVisible: true,
      stopButtonVisible: false,
      cancelButtonVisible: false,
      isWorking: false,
      isComplete: false,
      evidence,
    };
  }

  async findAllRuntimes(): Promise<RuntimeInspectionResult[]> {
    const res = await this.findRuntime({ providerType: this.providerType });
    return [res];
  }

  async inspectRuntime(sessionId: RuntimeSessionId): Promise<RuntimeInspectionResult> {
    return this.findRuntime({ providerType: this.providerType });
  }

  async activateRuntime(_sessionId: RuntimeSessionId): Promise<boolean> {
    return true;
  }

  async deliverInstruction(request: DeliveryInstructionRequest): Promise<DeliveryInstructionResult> {
    const evidence: ObservableEvidence = {
      id: `ev_browser_deliv_${Date.now()}`,
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      runtimeSessionId: request.runtimeSessionId,
      bundleIdentifier: this.defaultBundleId,
      windowTitle: this.defaultWindowTitle,
      composerSignature: `sha256_${request.instructionText.length}`,
      composerCleared: true,
      responseActivityObserved: true,
      visibleButtonState: {
        sendButtonVisible: false,
        stopButtonVisible: true,
      },
    };

    return {
      outcome: 'delivered',
      evidence,
    };
  }

  async detectWorkingState(sessionId: RuntimeSessionId): Promise<{ isWorking: boolean; evidence?: ObservableEvidence }> {
    return {
      isWorking: false,
      evidence: {
        id: `ev_state_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: sessionId,
      },
    };
  }

  async detectCompletionState(sessionId: RuntimeSessionId): Promise<{ isComplete: boolean; responseSummary?: string; evidence?: ObservableEvidence }> {
    return {
      isComplete: false,
      evidence: {
        id: `ev_comp_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: sessionId,
      },
    };
  }

  async reconcileDispatch(request: { sessionId: RuntimeSessionId; deliveryId?: string; instructionSnippet?: string; externalSessionId?: string | null; idempotencyKey?: string }): Promise<{ outcome: 'delivered' | 'not_delivered' | 'supporting_evidence_only' | 'unknown' | 'unsupported'; evidence?: ObservableEvidence; reason?: string }> {
    return { outcome: 'unsupported' as const, reason: 'Provider does not provide deterministic reconciliation', evidence: { id: `ev_recon_${this.providerType}_${Date.now()}`, timestamp: Date.now(), source: 'reconciliation_probe' as const, details: { providerType: this.providerType, level: 'LEVEL_0' } } };
  }

  async captureEvidence(sessionId: RuntimeSessionId, action: string): Promise<ObservableEvidence> {
    return {
      id: `ev_cap_${Date.now()}`,
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      runtimeSessionId: sessionId,
      bundleIdentifier: this.defaultBundleId,
      details: { action, integrationStatus: this.integrationStatus, environment: 'browser_preview' },
    };
  }
}

export class BrowserChatGPTProvider extends BaseBrowserProvider {
  readonly providerType: ProviderType = 'chatgpt';
  readonly integrationStatus: ProviderIntegrationStatus = 'partial';
  readonly defaultBundleId = 'com.openai.chat';
  readonly defaultProcessName = 'ChatGPT';
  readonly defaultWindowTitle = 'ChatGPT';

  async resolveChatGPTProject(name: string): Promise<{
    success: boolean;
    projectUrl?: string;
    foundMultiple?: Array<{ name: string; url: string }>;
  }> {
    // Simulated resolution for demo/preview
    return {
      success: true,
      projectUrl: `https://chatgpt.com/p/${name.toLowerCase().replace(/\s+/g, '-')}`,
    };
  }
}

export class BrowserOpenCodeProvider extends BaseBrowserProvider {
  readonly providerType: ProviderType = 'opencode';
  readonly integrationStatus: ProviderIntegrationStatus = 'unsupported';
  readonly defaultBundleId = 'com.opencode.desktop';
  readonly defaultProcessName = 'opencode';
  readonly defaultWindowTitle = 'OpenCode Session';

  async matchSessionsByPath(projectPath: string, gitRoot?: string): Promise<{
    success: boolean;
    sessions: RuntimeInspectionResult[];
    diagnostics?: any;
  }> {
    // Simulated discovery for demo/preview
    const res = await this.findRuntime({ providerType: 'opencode' });
    res.windowTitle = `OpenCode: ${projectPath.split('/').pop()}`;
    res.evidence.details = {
      ...res.evidence.details,
      parsedSessionId: 'sess_demo_123',
      authoritativeSessionId: 'sess_demo_123',
      workspacePath: projectPath,
      matchScore: 100,
      matchedVia: 'exact_path',
      hasUiCorrelation: true,
    };
    return {
      success: true,
      sessions: [res],
      diagnostics: {
        source: 'browser_preview_mock',
        projectPath,
        gitRoot,
      },
    };
  }
}

export class BrowserVSCodeProvider extends BaseBrowserProvider {
  readonly providerType: ProviderType = 'vscode';
  readonly integrationStatus: ProviderIntegrationStatus = 'partial';
  readonly defaultBundleId = 'com.microsoft.VSCode';
  readonly defaultProcessName = 'Code';
  readonly defaultWindowTitle = 'Visual Studio Code';
}
