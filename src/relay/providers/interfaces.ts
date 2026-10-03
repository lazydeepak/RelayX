import {
  RuntimeSessionId,
  RuntimeSessionStatus,
  ObservableEvidence,
  ProviderType,
  ProviderIntegrationStatus,
  SideObservationReading,
} from '../domain/types.ts';
import type {
  ExactSessionWatermark,
  ReconciliationMessage,
  TransportReconciliation,
} from './exactSessionReconciliation.ts';

export interface RuntimeTargetDescriptor {
  providerType: ProviderType;
  bundleIdentifier?: string;
  windowTitlePattern?: string;
  processName?: string;
  externalSessionId?: string | null;
  runtimeSessionId?: RuntimeSessionId;
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
  /** Authoritative provider external session identity (`ses_*` for OpenCode). */
  externalSessionId?: string | null;
  instructionText: string;
  deliveryId?: string;
  idempotencyKey: string;
  /**
   * The durable dispatch-intent boundary captured from the EXACT target session immediately
   * before the external send (ground-truth Part 6 step 2).
   *
   * A provider that can read its own exact session MUST reconcile against it after the send
   * rather than deriving delivery truth from a process exit code. Without a watermark there
   * is no way to tell a turn this Attempt created from one that already existed, and the only
   * honest outcome is `ambiguous`.
   */
  preDispatchWatermark?: ExactSessionWatermark | null;
  /**
   * Explicit operator-configured model for the transport, in `provider/model` form.
   *
   * This is a RelayX provider SETTING, never a machine-wide default: it applies to this
   * dispatch only. A provider that supports per-run model selection MUST use it and MUST
   * record it in the returned evidence, so the model that actually served a delivery is
   * always auditable. A provider that has no way to select a model must ignore it.
   */
  modelOverride?: string | null;
}

/**
 * Read the transport boundary of ONE exact session, immediately BEFORE an external send.
 *
 * ## Why this is a separate, optional capability
 *
 * §11.1 `[FROZEN]`: "Provider capability is extended only by adding NEW optional
 * capabilities to `IRuntimeProvider`." The boundary read is a distinct concern from
 * delivering an instruction, and a provider that cannot read its own exact session simply
 * does not implement it — which is exactly the case where the post-transport verdict must be
 * `ambiguous` rather than guessed.
 *
 * The boundary is captured AFTER the dispatch intent is committed and BEFORE the send, so a
 * crash on either side of the send leaves a reconcilable record: with a boundary, the
 * outcome is classifiable; without one, it is honestly `ambiguous`.
 */
export interface TransportBoundaryRequest {
  runtimeSessionId: RuntimeSessionId;
  externalSessionId?: string | null;
}

export interface TransportBoundaryResult {
  /** `null` when the exact session could not be read. Never fabricated. */
  watermark: ExactSessionWatermark | null;
  /** Why the boundary could not be captured, when it could not. */
  failure: string | null;
}

export interface DeliveryInstructionResult {
  outcome: 'delivered' | 'ambiguous' | 'failed';
  reason?: string;
  deliveryId?: string;
  evidence: ObservableEvidence;
  /**
   * The post-transport exact-session reconciliation, when the provider was able to read the
   * authoritative session after the send.
   *
   * `outcome` above is the DELIVERY verdict (was the instruction inserted?). This field
   * additionally carries the WORKER EXECUTION verdict (did the worker then do it?), which is
   * a separate fact with a separate owner and must never be folded into `outcome`.
   *
   * Absent when the provider cannot read its own exact session. Absence is not permission to
   * guess: the caller must then treat execution as unknown.
   */
  reconciliation?: TransportReconciliation;
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
  inspectRuntime(sessionId: RuntimeSessionId, dispatchBoundary?: { afterCreatedAt?: number; afterMessageId?: string | null; sessionId?: string | null; expectedInstructionSnippet?: string | null }): Promise<RuntimeInspectionResult>;
  activateRuntime(sessionId: RuntimeSessionId, windowTitle?: string): Promise<boolean>;
  deliverInstruction(request: DeliveryInstructionRequest): Promise<DeliveryInstructionResult>;
  /**
   * Optional: read the pre-dispatch boundary of the exact target session.
   *
   * Implementations MUST return `watermark: null` (with a reason) rather than an invented
   * boundary when the session cannot be read. A fabricated boundary would make an unrelated
   * pre-existing user turn look like this Attempt's delivery.
   */
  captureTransportBoundary?(request: TransportBoundaryRequest): Promise<TransportBoundaryResult>;
  /**
   * Optional: read the turns of ONE exact session for post-hoc reconciliation.
   *
   * Separate from `captureTransportBoundary` on purpose. The boundary must be captured BEFORE
   * a send; this reads the session as it stands AFTER one. Reusing the boundary call for both
   * would conflate "what existed before" with "what exists now", and a reconciliation that
   * used the current state as its own boundary could never find a turn — it would report
   * every delivery as never having happened.
   *
   * `readable: false` means "could not check". It must never be returned to mean "empty".
   */
  readExactSessionTurnsForReconciliation?(externalSessionId: string): Promise<{
    readable: boolean;
    messages: ReconciliationMessage[];
    failure: string | null;
  }>;
  detectWorkingState(sessionId: RuntimeSessionId): Promise<{ isWorking: boolean; evidence?: ObservableEvidence }>;
  detectCompletionState(sessionId: RuntimeSessionId, dispatchBoundary?: { afterCreatedAt?: number; afterMessageId?: string | null; sessionId?: string | null; expectedInstructionSnippet?: string | null }): Promise<{ isComplete: boolean; responseSummary?: string; evidence?: ObservableEvidence }>;
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

  /**
   * S2. Optional READ-ONLY observation of ONE exact bound external session,
   * covering §5.2 dimensions 4-7 (reachability, UI presence, activity state,
   * message evidence) plus their own dimension 8/9 and §5.4 validity window.
   *
   * Additive per §11.1: no existing member is changed, weakened, or reordered.
   * Like `resolveSideIdentity`, a provider that does not implement this exposes
   * NO observation capability, and that is reported as `unknown` on every
   * dimension with a reason — never as a negative reading (I-6, §5.3, C-8).
   *
   * It is read-only. It sends nothing: no POST, no prompt, no keystroke, and it
   * must never acquire a write path. Exact Planner transport is S11 (§9.4) and
   * stays absent.
   *
   * I-11: addressed by the provider's OWN external session identifier. It must
   * never resolve a session by window title, frontmost tab, human-readable name,
   * or workspace basename.
   *
   * ## Ordering is the provider's, never RelayX's
   *
   * `SideObservationReading.message.ordinal` is the position of the latest
   * meaningful message in the PROVIDER's own ordering of that one session. It is
   * the only ordering primitive S2 accepts, and it is comparable only within a
   * single provider and a single session. A provider with no such ordering
   * returns `null`, and S2 then performs NO staleness comparison at all rather
   * than substituting a timestamp (I-7, §4 of the S2 brief).
   */
  observeSide?(request: SideObservationRequest): Promise<SideObservationReading>;

  createWorkerSession?(
    projectPath: string,
    name?: string,
  ): Promise<{ sessionId: string; workspaceDir: string; error?: string }>;
}

/**
 * S2 — the request for a one-side observation read.
 *
 * Carries the provider's own external session id and nothing else. There is no
 * `name`, no `windowTitle`, and no frontmost hint, because the whole point is
 * that the exact bound session is addressed rather than whatever happens to be
 * on screen (I-11).
 */
export interface SideObservationRequest {
  /** I-11: the provider's own external session identifier. */
  externalSessionId: string;
  /** Scope hint when the provider requires a project/workspace to disambiguate. */
  projectPath?: string;
}
