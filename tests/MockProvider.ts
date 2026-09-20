import { RuntimeSessionId, ProviderType, ProviderIntegrationStatus, ObservableEvidence } from '../src/relay/domain/types.ts';
import { IRuntimeProvider, RuntimeInspectionResult, RuntimeTargetDescriptor, DeliveryInstructionRequest, DeliveryInstructionResult } from '../src/relay/providers/interfaces.ts';

export class MockProvider implements IRuntimeProvider {
  public providerType: ProviderType;
  public readonly integrationStatus: ProviderIntegrationStatus = 'unsupported';
  public shouldFailInspection = false;
  public inspectionStatus: any = 'available';
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

  constructor(type: ProviderType = 'chatgpt') {
    this.providerType = type;
  }

  async findRuntime(descriptor: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult> {
    return { found: true, status: 'available', windowTitle: this.windowTitle, applicationPid: this.applicationPid, composerVisible: true, composerHasFocus: true, sendButtonVisible: true, stopButtonVisible: false, cancelButtonVisible: false, isWorking: this.isWorking, isComplete: this.isComplete, evidence: { id: `ev_${Date.now()}`, timestamp: Date.now(), source: 'reconciliation_probe', windowTitle: this.windowTitle, applicationPid: this.applicationPid } };
  }
  async findAllRuntimes(): Promise<RuntimeInspectionResult[]> { return [await this.findRuntime({ providerType: this.providerType })]; }
  async resolveChatGPTProject(name: string): Promise<{ success: boolean; projectUrl?: string; foundMultiple?: Array<{ name: string; url: string }>; }> { return { success: true, projectUrl: `https://test/mock-${name}` }; }
  async matchSessionsByPath(projectPath: string, gitRoot?: string): Promise<RuntimeInspectionResult[]> { return [await this.findRuntime({ providerType: this.providerType })]; }
  async inspectRuntime(sessionId: RuntimeSessionId): Promise<RuntimeInspectionResult> { return this.findRuntime({ providerType: this.providerType }); }
  async activateRuntime(sessionId: RuntimeSessionId): Promise<boolean> { return true; }
  async deliverInstruction(request: DeliveryInstructionRequest): Promise<DeliveryInstructionResult> { return { outcome: 'delivered', evidence: { id: `ev_d_${Date.now()}`, timestamp: Date.now(), source: 'reconciliation_probe', runtimeSessionId: request.runtimeSessionId, windowTitle: this.windowTitle, applicationPid: this.applicationPid } }; }
  async detectWorkingState(sessionId: RuntimeSessionId): Promise<{ isWorking: boolean; evidence?: ObservableEvidence }> { return { isWorking: this.isWorking, evidence: { id: `ev_w_${Date.now()}`, timestamp: Date.now(), source: 'reconciliation_probe', runtimeSessionId: sessionId, visibleButtonState: { stopButtonVisible: false }, responseActivityObserved: false } }; }
  async detectCompletionState(sessionId: RuntimeSessionId): Promise<{ isComplete: boolean; responseSummary?: string; evidence?: ObservableEvidence }> { return { isComplete: this.isComplete, responseSummary: this.isComplete ? this.responseSummary : undefined, evidence: { id: `ev_c_${Date.now()}`, timestamp: Date.now(), source: 'reconciliation_probe', runtimeSessionId: sessionId, visibleButtonState: { sendButtonVisible: true, stopButtonVisible: false }, responseActivityObserved: false } }; }
  async captureEvidence(sessionId: RuntimeSessionId, action: string): Promise<ObservableEvidence> { return { id: `ev_cap_${Date.now()}`, timestamp: Date.now(), source: 'reconciliation_probe', runtimeSessionId: sessionId, windowTitle: this.windowTitle, applicationPid: this.applicationPid, details: { action } }; }
}
