import { RuntimeSessionId, ProviderType, ProviderIntegrationStatus, ObservableEvidence } from '../src/relay/domain/types.ts';
import { IRuntimeProvider, RuntimeInspectionResult, RuntimeTargetDescriptor, DeliveryInstructionRequest, DeliveryInstructionResult, TransportBoundaryResult } from '../src/relay/providers/interfaces.ts';
import { ReconciliationMessage, buildWatermark } from '../src/relay/providers/exactSessionReconciliation.ts';

/** Run-terminating finish values, matching the real provider's vocabulary. */
const TERMINAL_RUN_FINISHES: ReadonlySet<string> = new Set(['stop', 'error']);

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
  public responseSummary: string | undefined = 'Task completed successfully.';
  public deliveryOutcome: 'delivered' | 'ambiguous' | 'failed' = 'delivered';
  public deliveryFailureReason?: string;

  /* --- Exact-session transcript, so tests exercise the REAL production path --------
   *
   * The relay baton is defined entirely by the recorded pre-dispatch message-id boundary
   * and the authoritative turns after it, both of which come from these two capabilities.
   * A mock that lacked them would leave the baton untested — it would exercise a fallback
   * path production never takes — so the mock models the transcript explicitly and the
   * `isWorking` / `isComplete` knobs are rendered into it faithfully:
   *
   *   isWorking  -> the newest assistant turn has NO `finish` (the provider's own signal
   *                 that the turn has not ended)
   *   isComplete -> that turn carries a run-terminating `finish` and real text
   */
  /** Every message in the mock session, oldest first. Mutated as the test drives it. */
  public messages: ReconciliationMessage[] = [];
  /** Set to make `readExactSessionTurnsForReconciliation` report "could not check". */
  public transcriptReadable = true;
  public transcriptFailure: string | null = null;
  private counter = 0;

  constructor(type: ProviderType = 'chatgpt') {
    this.providerType = type;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  /** Record a user turn. Returns its message id so a test can build a boundary from it. */
  public appendUserTurn(text: string, createdAt = Date.now()): string {
    const id = this.nextId('msg_user');
    this.messages.push({ messageId: id, role: 'user', createdAt, text });
    return id;
  }

  /**
   * Record an assistant turn.
   *
   * `finish: null` models a turn that is still streaming — which is exactly how the real
   * provider represents "still working", and what keeps a partial turn from ever being
   * mistaken for a completed response.
   */
  public appendAssistantTurn(
    text: string,
    opts: { finish?: string | null; createdAt?: number } = {},
  ): string {
    const id = this.nextId('msg_asst');
    this.messages.push({
      messageId: id,
      role: 'assistant',
      createdAt: opts.createdAt ?? Date.now(),
      text,
      finish: opts.finish === undefined ? (this.isWorking ? null : 'stop') : opts.finish,
    });
    return id;
  }

  /**
   * Render the `isWorking` / `isComplete` knobs into the transcript, so a test that only
   * flips those booleans still drives the REAL production path.
   *
   * The relay baton is decided entirely by what the exact session contains: an assistant
   * turn with no `finish` means still working, and one with a run-terminating `finish` plus
   * text means a completed turn. A mock that answered `isComplete: true` from a summary
   * string while its transcript stayed empty would leave the baton untested, because
   * production never reads that summary.
   *
   * Mirroring happens at read time rather than on flag assignment because the flags are
   * plain booleans and cannot notify. It is idempotent: the transcript is only appended to
   * when it does not already reflect the current state, so repeated reads are stable.
   *
   * `isWorking` wins over `isComplete`, mirroring the real provider's completion detector,
   * which early-outs while the session is working.
   */
  private mirrorKnobsToTranscript(): void {
    let lastUser = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        lastUser = i;
        break;
      }
    }
    if (lastUser < 0) return; // nothing was ever sent to this session

    const assistantsAfter = this.messages.slice(lastUser + 1).filter((m) => m.role === 'assistant');
    const newest = assistantsAfter.length > 0 ? assistantsAfter[assistantsAfter.length - 1] : null;
    const newestFinish = newest?.finish ?? null;

    if (this.isWorking) {
      if (newest !== null && (newestFinish === null || newestFinish === undefined || newestFinish === '')) {
        return; // already mirrors "still streaming"
      }
      this.appendAssistantTurn(this.partialResponseSummary ?? '', { finish: null });
      return;
    }

    if (this.isComplete) {
      if (newest !== null && newestFinish != null && TERMINAL_RUN_FINISHES.has(newestFinish)) return; // already completed
      this.appendAssistantTurn(this.responseSummary ?? 'Task completed successfully.', { finish: 'stop' });
    }
  }

  /** The (still-streaming) text a working turn exposes. Never treated as a response. */
  public partialResponseSummary = 'Working on it';

  /**
   * Seed this provider with a conversation that already existed before it started.
   *
   * A restarted RelayX process talks to a provider whose conversation is UNCHANGED — the
   * transcript lives in the provider's application, not in RelayX's memory. Without this a
   * test that simulates a restart by constructing a fresh provider would silently start from
   * an empty conversation, and the relay baton would correctly find nothing after the
   * delivery boundary. That is a property of the mock, not of the system, so the transcript
   * has to be handed across explicitly.
   */
  public adoptTranscript(messages: ReconciliationMessage[]): void {
    this.messages = messages.map((message) => ({ ...message }));
    this.counter = messages.length;
  }


  async findRuntime(descriptor: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult> {
    if (this.shouldFailInspection) {
      return {
        found: false,
        status: 'unavailable',
        composerVisible: false,
        composerHasFocus: false,
        sendButtonVisible: false,
        stopButtonVisible: false,
        cancelButtonVisible: false,
        isWorking: false,
        isComplete: false,
        evidence: { id: `ev_fail_${Date.now()}`, timestamp: Date.now(), source: 'reconciliation_probe' },
      };
    }
    return {
      found: true,
      status: this.inspectionStatus || 'available',
      windowTitle: this.windowTitle,
      applicationPid: this.applicationPid,
      composerVisible: true,
      composerHasFocus: true,
      sendButtonVisible: true,
      stopButtonVisible: false,
      cancelButtonVisible: false,
      isWorking: this.isWorking,
      isComplete: this.isComplete,
      lastResponseSnippet: this.responseSummary,
      evidence: { id: `ev_${Date.now()}`, timestamp: Date.now(), source: 'reconciliation_probe', windowTitle: this.windowTitle, applicationPid: this.applicationPid },
    };
  }
  async findAllRuntimes(): Promise<RuntimeInspectionResult[]> { return [await this.findRuntime({ providerType: this.providerType })]; }
  async resolveChatGPTProject(name: string): Promise<{ success: boolean; projectUrl?: string; foundMultiple?: Array<{ name: string; url: string }>; }> { return { success: true, projectUrl: `https://test/mock-${name}` }; }
  async matchSessionsByPath(projectPath: string, gitRoot?: string): Promise<RuntimeInspectionResult[]> { return [await this.findRuntime({ providerType: this.providerType })]; }
  /**
   * Make `inspectRuntime` report the runtime as ABSENT — the genuine "RelayX cannot observe this
   * process at all" signal, which is what `recordObservationFailure` is supposed to count.
   *
   * Distinct from `shouldFailInspection`, which now only affects the transcript read. The two were
   * previously conflated, which is how an unreadable-but-alive conversation ended up being counted
   * toward runtime termination.
   */
  public shouldFailRuntimeObservation = false;

  async inspectRuntime(sessionId: RuntimeSessionId): Promise<RuntimeInspectionResult> {
    if (this.shouldFailRuntimeObservation) {
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
        evidence: {
          id: `ev_mock_absent_${Date.now()}`,
          timestamp: Date.now(),
          source: 'window_inspection',
          details: { reason: 'Mock runtime observation is configured to report the runtime as absent.' },
        },
      };
    }
    return this.findRuntime({ providerType: this.providerType });
  }
  async activateRuntime(sessionId: RuntimeSessionId): Promise<boolean> { return true; }
  async resolveSideIdentity(params: { externalSessionId: string; projectPath?: string }): Promise<any> {
    return {
      identityState: 'identified',
      identityValue: params.externalSessionId,
      verificationState: 'verified',
      verificationValue: params.externalSessionId,
      existenceState: 'present',
      sourceCapability: 'mock_identity'
    };
  }
  async observeSide(params: { externalSessionId: string; projectPath?: string }): Promise<any> {
    return {
      reachabilityState: 'reachable',
      uiPresenceState: 'present',
      activityState: 'idle',
      messageEvidenceState: 'observed',
      message: {
        ref: 'msg_1',
        role: 'assistant',
        text: 'Hello',
        truncated: false,
        ordinal: 1,
      },
      observationCapability: 'mock_observation',
      observedAt: Date.now(),
      validUntil: Date.now() + 300000,
      reason: 'Mock observed side',
      evidence: null,
    };
  }
  async deliverInstruction(request: DeliveryInstructionRequest): Promise<DeliveryInstructionResult> {
    // A confirmed send must actually appear in the exact session, because the relay baton
    // derives everything from post-boundary turns. Without this the transcript would stay
    // empty and the production path would never be exercised.
    if (this.deliveryOutcome === 'delivered') {
      this.appendUserTurn(request.instructionText);
    }
    return {
      outcome: this.deliveryOutcome,
      reason: this.deliveryFailureReason,
      evidence: { id: `ev_d_${Date.now()}`, timestamp: Date.now(), source: 'macos_accessibility', runtimeSessionId: request.runtimeSessionId, windowTitle: this.windowTitle, applicationPid: this.applicationPid },
    };
  }
  async detectWorkingState(sessionId: RuntimeSessionId): Promise<{ isWorking: boolean; evidence?: ObservableEvidence }> { return { isWorking: this.isWorking, evidence: { id: `ev_w_${Date.now()}`, timestamp: Date.now(), source: 'reconciliation_probe', runtimeSessionId: sessionId, visibleButtonState: { stopButtonVisible: false }, responseActivityObserved: false } }; }
  async detectCompletionState(sessionId: RuntimeSessionId): Promise<{ isComplete: boolean; responseSummary?: string; evidence?: ObservableEvidence }> { return { isComplete: this.isComplete, responseSummary: this.isComplete ? this.responseSummary : undefined, evidence: { id: `ev_c_${Date.now()}`, timestamp: Date.now(), source: 'reconciliation_probe', runtimeSessionId: sessionId, visibleButtonState: { sendButtonVisible: true, stopButtonVisible: false }, responseActivityObserved: false } }; }
  async captureEvidence(sessionId: RuntimeSessionId, action: string): Promise<ObservableEvidence> { return { id: `ev_cap_${Date.now()}`, timestamp: Date.now(), source: 'reconciliation_probe', runtimeSessionId: sessionId, windowTitle: this.windowTitle, applicationPid: this.applicationPid, details: { action } }; }

  /**
   * The pre-dispatch boundary, captured from the mock session's real message list. This is
   * the capability the whole baton model rests on, so the mock captures a genuine
   * message-id set rather than a stand-in.
   */
  async captureTransportBoundary(request: { runtimeSessionId: RuntimeSessionId; externalSessionId?: string | null }): Promise<TransportBoundaryResult> {
    if (this.shouldFailInspection || !this.transcriptReadable) {
      return { watermark: null, failure: this.transcriptFailure ?? 'Mock transcript is configured as unreadable.' };
    }
    return {
      watermark: buildWatermark(request.externalSessionId ?? 'mock_session', this.messages, Date.now()),
      failure: null,
    };
  }

  /** The authoritative exact-session read. Returns the real message list, ids and all. */
  async readExactSessionTurnsForReconciliation(externalSessionId: string): Promise<{
    readable: boolean;
    messages: ReconciliationMessage[];
    failure: string | null;
  }> {
    // `shouldFailInspection` used to make `inspectRuntime` report "not found". The tick no
    // longer calls `inspectRuntime`, so the same condition is expressed on the capability
    // the baton actually reads: the exact session is unreadable. Mapping it here keeps every
    // "runtime missing / suspended" test meaningful against the real path.
    if (this.shouldFailInspection || !this.transcriptReadable) {
      return { readable: false, messages: [], failure: this.transcriptFailure ?? 'Mock exact session is not available.' };
    }
    this.mirrorKnobsToTranscript();
    return { readable: true, messages: [...this.messages], failure: null };
  }

  /* --- Authoritative conversation reachability -------------------------------------
   *
   * Modelled explicitly rather than derived, because the three outcomes are NOT the same and
   * conflating them is the defect this capability exists to prevent:
   *
   *   deadConversations hit     -> the provider positively answered "this conversation is gone"
   *   reachabilityFailure set   -> "could not check"
   *   neither                   -> confirmed reachable
   *
   * By default the mock answers affirmatively about whatever id is asked for, which is the
   * realistic default: a mock session that exists is reachable.
   */
  /** When set, the provider answers definitively that this conversation does not exist. */
  public deadConversations: string[] = [];
  /** When set, the provider cannot check at all — "could not check", which is NOT "gone". */
  public reachabilityFailure: string | null = null;
  /** Force the positive answer to report this id rather than the requested one. */
  public observedConversationId: string | null = null;

  async confirmExactSessionReachable(externalSessionId: string): Promise<{
    reachable: boolean;
    conversationId: string | null;
    evidence?: ObservableEvidence;
    failure: string | null;
  }> {
    if (this.reachabilityFailure) {
      return { reachable: false, conversationId: null, failure: this.reachabilityFailure };
    }
    if (this.deadConversations.includes(externalSessionId)) {
      return {
        reachable: false,
        conversationId: null,
        evidence: {
          id: this.nextId('ev_unreachable'),
          timestamp: Date.now(),
          source: 'reconciliation_probe',
          details: { reason: 'provider reported the conversation as absent' },
        },
        failure: null,
      };
    }
    const conversationId = this.observedConversationId ?? externalSessionId;
    return {
      reachable: conversationId === externalSessionId,
      conversationId,
      evidence: {
        id: this.nextId('ev_reachable'),
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        details: {
          method: 'mock_exact_conversation_readdress',
          observedConversationId: conversationId,
        },
      },
      failure: null,
    };
  }
}
