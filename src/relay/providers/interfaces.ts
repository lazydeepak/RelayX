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

export interface ProviderSessionConfirmation {
  confirmed: boolean;
  externalSessionId?: string | null;
  projectPath?: string | null;
  evidence?: ObservableEvidence;
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
  /**
   * Optional reconciliation of an uncertain delivery.
   * Must not invent delivery state; must report evidence if available.
   */
  reconcileDispatch?(request: { sessionId: RuntimeSessionId; deliveryId?: string; instructionSnippet?: string; externalSessionId?: string | null; idempotencyKey?: string }): Promise<{ outcome: 'delivered' | 'not_delivered' | 'supporting_evidence_only' | 'unknown' | 'unsupported'; evidence?: ObservableEvidence; reason?: string }>;
  /**
   * Optional read-only capability for confirming that a caller-supplied
   * session id exists in a specific provider workspace. A missing capability
   * must not be treated as confirmation.
   */
  confirmSessionForProject?(
    sessionId: string,
    projectPath: string,
  ): Promise<ProviderSessionConfirmation>;

  createWorkerSession?(
    projectPath: string,
    name?: string,
  ): Promise<{ sessionId: string; workspaceDir: string; error?: string }>;
}
