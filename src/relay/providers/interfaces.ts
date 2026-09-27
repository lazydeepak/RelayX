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

/* --- S4: the provider-neutral read capability -------------------------------
 *
 * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §11.1, §9.5, §5.2, §5.3.
 *
 * §11.1 `[FROZEN]`: "Provider capability is extended only by adding NEW optional
 * capabilities to `IRuntimeProvider`. Existing required members are not changed,
 * and no existing capability is weakened." This is the concrete form I-16 takes
 * for the provider layer, so this interface adds members and changes none.
 *
 * It is a READ-ONLY capability. It resolves and verifies the identity of ONE side
 * against the provider's own external session identifier. It sends nothing, and
 * it must never gain a message-send path (§9.4: exact Planner transport is S11).
 *
 * I-11: the request is addressed by the provider's external session id, never by
 * the human-readable Pair Name and never by a frontmost window.
 *
 * Every field is tri-state and `unknown` is distinct from a negative result
 * (I-6, §5.3). A provider that cannot answer MUST return `unknown` with a
 * reason, never a bare `false`/`absent`, because "we did not check" and "we
 * checked and it is gone" are different facts.
 */
export interface SideIdentityRequest {
  /** I-11: the provider's own external session identifier. */
  externalSessionId: string;
  /** Scope hint when the provider requires a project/workspace to disambiguate. */
  projectPath?: string;
}

export interface SideIdentityResolution {
  identityState: 'resolved' | 'not_resolved' | 'unknown';
  identityValue: string | null;
  verificationState: 'verified' | 'mismatched' | 'unknown';
  verificationValue: string | null;
  existenceState: 'present' | 'absent' | 'unknown';
  /**
   * Dimension 8 (§5.2): names the CAPABILITY that produced this, not just the
   * provider, so LEVEL 0 vs LEVEL 1 evidence stays distinguishable downstream
   * (C-8). Never empty.
   */
  sourceCapability: string;
  /** Dimension 9 (§5.2): always populated. */
  observedAt: number;
  evidence?: ObservableEvidence;
  /** Explicitly nullable: a resolved side has no reason, an unknown side must. */
  reason?: string | null;
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

  /**
   * S4. Optional READ-ONLY identity resolution for one side, addressed by the
   * provider's own external session identifier (I-11).
   *
   * Additive per §11.1: no existing member is changed, and a provider that
   * does not implement this is NOT treated as negative evidence. A missing
   * capability yields `unknown` on that side, reported per side (§11.3, §9.5),
   * never `false`.
   */
  resolveSideIdentity?(request: SideIdentityRequest): Promise<SideIdentityResolution>;

  createWorkerSession?(
    projectPath: string,
    name?: string,
  ): Promise<{ sessionId: string; workspaceDir: string; error?: string }>;
}
