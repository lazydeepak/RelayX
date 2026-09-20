import {
  RuntimeSessionId,
  RuntimeSessionStatus,
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

export class MockProvider implements IRuntimeProvider {
  public providerType: ProviderType;
  public readonly integrationStatus: ProviderIntegrationStatus = 'mock';

  // Controllable test hooks
  public shouldFailInspection = false;
  public inspectionStatus: RuntimeSessionStatus = 'available';
  public windowTitle = 'Mock AI Application';
  public applicationPid = 12345;
  public sendButtonVisible = true;
  public stopButtonVisible = false;
  public composerVisible = true;
  public isWorking = false;
  public isComplete = false;
  public responseSummary = 'Task completed successfully.';
  public deliveryOutcome: 'delivered' | 'ambiguous' | 'failed' = 'delivered';
  public deliveryFailureReason?: string;

  constructor(type: ProviderType = 'mock') {
    this.providerType = type;
  }

  async findRuntime(descriptor: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult> {
    const evidence: ObservableEvidence = {
      id: `ev_find_${Date.now()}`,
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      windowTitle: this.windowTitle,
      applicationPid: this.applicationPid,
      visibleButtonState: {
        sendButtonVisible: this.sendButtonVisible,
        stopButtonVisible: this.stopButtonVisible,
      },
    };

    if (this.shouldFailInspection) {
      return {
        found: false,
        status: 'unknown',
        composerVisible: false,
        composerHasFocus: false,
        sendButtonVisible: false,
        stopButtonVisible: false,
        cancelButtonVisible: false,
        isWorking: false,
        isComplete: false,
        evidence,
      };
    }

    return {
      found: true,
      status: this.inspectionStatus,
      windowTitle: this.windowTitle,
      applicationPid: this.applicationPid,
      bundleIdentifier: descriptor.bundleIdentifier ?? 'com.relay.mock',
      composerVisible: this.composerVisible,
      composerHasFocus: true,
      sendButtonVisible: this.sendButtonVisible,
      stopButtonVisible: this.stopButtonVisible,
      cancelButtonVisible: false,
      isWorking: this.isWorking,
      isComplete: this.isComplete,
      lastResponseSnippet: this.isComplete ? this.responseSummary : undefined,
      evidence,
    };
  }

  async findAllRuntimes(): Promise<RuntimeInspectionResult[]> {
    const res = await this.findRuntime({ providerType: this.providerType });
    return [res];
  }

  async resolveChatGPTProject(name: string): Promise<{
    success: boolean;
    projectUrl?: string;
    foundMultiple?: Array<{ name: string; url: string }>;
  }> {
    return {
      success: true,
      projectUrl: `https://chatgpt.com/mock-project-${name}`,
    };
  }

  async matchSessionsByPath(projectPath: string, gitRoot?: string): Promise<RuntimeInspectionResult[]> {
    const res = await this.findRuntime({ providerType: this.providerType });
    res.evidence.details = {
      ...res.evidence.details,
      parsedSessionId: 'mock_session_123',
      workspacePath: projectPath,
    };
    return [res];
  }

  async inspectRuntime(sessionId: RuntimeSessionId): Promise<RuntimeInspectionResult> {
    return this.findRuntime({ providerType: this.providerType });
  }

  async activateRuntime(sessionId: RuntimeSessionId): Promise<boolean> {
    return !this.shouldFailInspection;
  }

  async deliverInstruction(request: DeliveryInstructionRequest): Promise<DeliveryInstructionResult> {
    const evidence: ObservableEvidence = {
      id: `ev_deliv_${Date.now()}`,
      timestamp: Date.now(),
      source: 'macos_accessibility',
      runtimeSessionId: request.runtimeSessionId,
      windowTitle: this.windowTitle,
      applicationPid: this.applicationPid,
      composerSignature: `hash_${request.instructionText.length}`,
      composerCleared: this.deliveryOutcome === 'delivered',
      responseActivityObserved: this.deliveryOutcome === 'delivered',
      visibleButtonState: {
        sendButtonVisible: false,
        stopButtonVisible: true,
      },
    };

    if (this.deliveryOutcome === 'ambiguous') {
      return {
        outcome: 'ambiguous',
        reason: this.deliveryFailureReason ?? 'Window focus lost during send action; response start unconfirmed',
        evidence: {
          ...evidence,
          composerCleared: false,
          responseActivityObserved: false,
          visibleButtonState: { sendButtonVisible: true, stopButtonVisible: false },
        },
      };
    }

    if (this.deliveryOutcome === 'failed') {
      return {
        outcome: 'failed',
        reason: this.deliveryFailureReason ?? 'Composer not found or application unresponsive',
        evidence,
      };
    }

    // Normal successful delivery
    this.isWorking = true;
    this.stopButtonVisible = true;
    this.sendButtonVisible = false;
    this.inspectionStatus = 'working';

    return {
      outcome: 'delivered',
      evidence,
    };
  }

  async detectWorkingState(sessionId: RuntimeSessionId): Promise<{ isWorking: boolean; evidence?: ObservableEvidence }> {
    return {
      isWorking: this.isWorking,
      evidence: {
        id: `ev_work_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: sessionId,
        visibleButtonState: {
          stopButtonVisible: this.stopButtonVisible,
        },
        responseActivityObserved: this.isWorking,
      },
    };
  }

  async detectCompletionState(sessionId: RuntimeSessionId): Promise<{ isComplete: boolean; responseSummary?: string; evidence?: ObservableEvidence }> {
    return {
      isComplete: this.isComplete,
      responseSummary: this.isComplete ? this.responseSummary : undefined,
      evidence: {
        id: `ev_comp_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: sessionId,
        visibleButtonState: {
          sendButtonVisible: true,
          stopButtonVisible: false,
        },
      },
    };
  }

  async captureEvidence(sessionId: RuntimeSessionId, action: string): Promise<ObservableEvidence> {
    return {
      id: `ev_cap_${Date.now()}`,
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      runtimeSessionId: sessionId,
      windowTitle: this.windowTitle,
      applicationPid: this.applicationPid,
      details: { action },
    };
  }
}
