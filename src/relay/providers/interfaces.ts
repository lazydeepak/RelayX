import {
  RuntimeSessionId,
  RuntimeSessionStatus,
  ObservableEvidence,
  ProviderType,
  ProviderIntegrationStatus,
} from '../domain/types.ts';

export interface RuntimeTargetDescriptor {
  providerType: ProviderType;
  bundleIdentifier?: string;
  windowTitlePattern?: string;
  processName?: string;
}

export interface RuntimeInspectionResult {
  found: boolean;
  status: RuntimeSessionStatus;
  windowTitle?: string;
  applicationPid?: number;
  bundleIdentifier?: string;
  composerVisible: boolean;
  composerHasFocus: boolean;
  sendButtonVisible: boolean;
  stopButtonVisible: boolean;
  cancelButtonVisible: boolean;
  lastResponseSnippet?: string;
  isWorking: boolean;
  isComplete: boolean;
  evidence: ObservableEvidence;
}

export interface DeliveryInstructionRequest {
  runtimeSessionId: RuntimeSessionId;
  instructionText: string;
  idempotencyKey: string;
}

export interface DeliveryInstructionResult {
  outcome: 'delivered' | 'ambiguous' | 'failed';
  reason?: string;
  evidence: ObservableEvidence;
}

export interface IRuntimeProvider {
  readonly providerType: ProviderType;
  readonly integrationStatus: ProviderIntegrationStatus;
  findRuntime(descriptor: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult>;
  findAllRuntimes(): Promise<RuntimeInspectionResult[]>;
  inspectRuntime(sessionId: RuntimeSessionId): Promise<RuntimeInspectionResult>;
  activateRuntime(sessionId: RuntimeSessionId): Promise<boolean>;
  deliverInstruction(request: DeliveryInstructionRequest): Promise<DeliveryInstructionResult>;
  detectWorkingState(sessionId: RuntimeSessionId): Promise<{ isWorking: boolean; evidence?: ObservableEvidence }>;
  detectCompletionState(sessionId: RuntimeSessionId): Promise<{ isComplete: boolean; responseSummary?: string; evidence?: ObservableEvidence }>;
  captureEvidence(sessionId: RuntimeSessionId, action: string): Promise<ObservableEvidence>;
}
