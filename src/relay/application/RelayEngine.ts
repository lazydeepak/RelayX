import {
  ProjectId,
  PairId,
  RuntimeSessionId,
  AssignmentId,
  AttemptId,
  DeliveryId,
  HandoffId,
  AttentionItemId,
  EventId,
  PlanFirstRunId,
  WorkUnitId,
  ProviderType,
  ObservableEvidence,
  createId,
  AssignmentStatus,
  PairSideRole,
  PairSideIdentity,
  PairActivationResult,
  PAIR_SIDE_ROLES,
  NO_IDENTITY_CAPABILITY,
  DOM_EXACT_SESSION_IDENTITY_CAPABILITY,
  classifyExactSessionCapabilityRoute,
  identityDimensionsForCapabilityRoute,
  RuntimePairGovernance,
  RUNTIME_PAIR_NOT_ACTIVE,
  RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS,
  SideObservationReading,
  SideObservationResult,
  SideObservationOutcome,
  NO_OBSERVATION_CAPABILITY,
  PROVISIONAL_OBSERVATION_VALIDITY_MS,
  PairSideCheckpoint,
  PairSideCheckpointId,
  PairCheckpointId,
  PairContinuityResult,
  CompletedTurnObservation,
  CompletedTurnObservationResult,
  CHECKPOINT_BASELINE_ALREADY_EXISTS,
  CHECKPOINT_BASELINE_REQUIRED,
  CHECKPOINT_OBSERVATION_REQUIRED,
  AuthorityContext,
} from '../domain/types.ts';
import {
  evaluateSideContinuity,
  classifyPairContinuity,
} from '../domain/continuity.ts';
import {
  evaluatePairReadiness,
  PairReadinessAssessment,
} from '../domain/readiness.ts';
import {
  Project,
  Pair,
  RuntimeSession,
  RuntimeProjectAssociation,
  Assignment,
  Attempt,
  Delivery,
  Handoff,
  RelayEvent,
  AttentionItem,
  PairCheckpoint,
  PairCheckpointProps,
} from '../domain/entities.ts';
import { WorkUnit, PlanFirstRun } from '../domain/planFirst.ts';
import {
  MilestoneVerification,
  PlanFirstVerificationEvaluator,
} from '../domain/planFirstVerification.ts';
import { projectEventToActivity } from '../domain/activityProjection.ts';
import {
  RECOVERY_AUTHORITY,
  getRecoveryOwner,
  assertRecoveryAuthorityIndependentOfBaton,
  assertNoSelectableRecoveryDestination,
  createRecoveryState,
  recordRecoveryIngressDeliveryCreated,
  recordRecoveryIngressConfirmed,
  recordPlannerDecision,
  authorizeContinuation,
  recordContinuationDeliveryCreated,
  recordContinuationDispatched,
  validateRecoveryOperation,
  type RecoveryState,
  type RecoveryPhase,
  type RecoveryOperation,
  type RecoveryAuthorization,
  type RecoveryEvidence,
} from '../domain/recoveryAuthority.ts';
import {
  DuplicateDeliveryAttemptError,
  AmbiguousDeliveryResendError,
  RuntimeNotAvailableError,
  RelayDomainError,
} from '../domain/errors.ts';
import { IRelayRepositories, ProviderSetting } from '../persistence/interfaces.ts';
import {
  IRuntimeProvider,
  RuntimeTargetDescriptor,
  RuntimeInspectionResult,
} from '../providers/interfaces.ts';
import {
  IntegrationRegistry,
  CapabilityResolver,
} from '../integrations/index.ts';
import {
  reconcileTransportOutcome,
  reconstructWatermarkFromIntentTime,
  observeWorkerCompletion,
  type ExactSessionWatermark,
  type TransportReconciliation,
  type WorkerCompletionObservation,
} from '../providers/exactSessionReconciliation.ts';
import {
  PlannerObserverClient,
  type PlannerObserverArm,
  type PlannerObserverStatus,
} from '../providers/plannerObserverClient.ts';
import {
  deriveRelayBaton,
  batonSessionIdentity,
  oppositeSide,
  type RelayBaton,
  type RelayBatonLink,
  type BatonBoundary,
} from '../domain/baton.ts';
// The one shared sanitiser in the codebase, reused rather than duplicated so a second,
// weaker filter cannot eventually govern what reaches an operator.
import {
  sanitizeHealthText,
  HEALTH_EVIDENCE_MAX_STRING_LENGTH,
} from '../health/healthEvidenceSanitizer.ts';

/**
 * Recover the pre-dispatch boundary that was committed on a Delivery's evidence.
 *
 * The boundary is stored as ordinary evidence, so this reads it back rather than reaching
 * into a side channel. Returns `null` — never a partial boundary — when the evidence does
 * not carry a complete one, because a boundary with a missing id set cannot establish
 * post-boundary-ness and would silently force `ambiguous` for the wrong reason.
 */
function extractRecordedWatermark(evidence: ObservableEvidence | undefined): ExactSessionWatermark | null {
  const details = evidence?.details as Record<string, unknown> | undefined;
  if (!details) return null;

  // Two accepted shapes, because the boundary is recorded at two moments and the second
  // overwrites the first. Rejecting either shape would force later reconciliation onto the
  // weaker reconstructed boundary for no reason.
  //   (a) its own evidence row, written before the send  (`phase: pre_dispatch_boundary`)
  //   (b) embedded in the delivery's own outcome record   (`details.boundary`)
  const source =
    details.phase === 'pre_dispatch_boundary'
      ? (details as Record<string, unknown>)
      : ((details.boundary as Record<string, unknown> | undefined) ?? null);
  if (!source) return null;

  const sessionId = typeof source.sessionId === 'string' ? source.sessionId : null;
  const messageIds = Array.isArray(source.messageIds)
    ? source.messageIds.filter((v): v is string => typeof v === 'string')
    : null;
  if (!sessionId || messageIds === null) return null;

  return {
    sessionId,
    messageIds,
    latestCreatedAt:
      typeof source.latestCreatedAt === 'number' ? source.latestCreatedAt : null,
    messageCount:
      typeof source.messageCount === 'number' ? source.messageCount : messageIds.length,
    // `capturedAt` is the pre-send read time. For the embedded shape that is the timestamp of
    // the delivery outcome, so the boundary's own capture time is read from it when present.
    capturedAt:
      typeof source.capturedAt === 'number'
        ? source.capturedAt
        : typeof evidence?.timestamp === 'number'
          ? evidence.timestamp
          : 0,
    provenance: 'captured_pre_dispatch',
  };
}

/**
 * Carry the Delivery's captured pre-dispatch boundary forward onto its outcome evidence.
 *
 * ## Why this exists
 *
 * `dispatchAssignment` Phase 1b commits the pre-dispatch boundary as the Delivery's own
 * evidence row (`phase: 'pre_dispatch_boundary'`) precisely so that a crash on either side
 * of the send leaves a reconcilable record. Phase 3 then calls `confirmDelivered`, which
 * assigns the outcome evidence over that row unconditionally.
 *
 * The result was that the persisted message-id boundary existed only while a Delivery was
 * `pending`/`delivering`/`ambiguous` and was DESTROYED by the moment it became
 * `delivered` — that is, destroyed for exactly the confirmed deliveries that the relay
 * baton is defined in terms of. `extractRecordedWatermark` has always accepted an embedded
 * `details.boundary` shape for precisely this purpose, but nothing ever wrote it, so the
 * documented shape was unreachable and every confirmed Delivery read back as
 * boundary-less.
 *
 * That left post-hoc reconciliation silently falling back to a boundary reconstructed
 * from the Delivery's `created_at` — a timestamp — and it made the baton model
 * unimplementable, since "inspect the owner after the Delivery's message boundary" has no
 * message boundary to inspect after.
 *
 * ## Why it copies rather than re-captures
 *
 * The boundary means "what existed in this exact session immediately BEFORE this send".
 * Re-reading the session now would produce a set that already CONTAINS the dispatched
 * turn and the response, so nothing could ever be post-boundary and every delivery would
 * reconcile to never having happened. The only correct source for the boundary is the read
 * that already happened before the send.
 *
 * ## What is preserved verbatim
 *
 * The captured `sessionId` / `messageIds` / `messageCount` / `latestCreatedAt`. Provenance
 * is always reported as `captured_pre_dispatch` when the copy came from a real pre-send
 * read, and as `reconstructed_from_intent_time` when it came from a reconstructed one — the
 * weaker form is never upgraded by being copied, because `reconcileTransportOutcome` uses
 * provenance to decide whether absence of a turn may authorise a resend.
 */
function withRecordedBoundary(
  outcomeEvidence: ObservableEvidence,
  previousEvidence: ObservableEvidence | undefined,
): ObservableEvidence {
  const recorded = extractRecordedWatermark(previousEvidence);
  if (!recorded) return outcomeEvidence;

  const details = (outcomeEvidence.details ?? {}) as Record<string, unknown>;
  // Never overwrite a boundary the outcome evidence already carries: an embedded boundary
  // that came with the outcome is at least as authoritative as the pre-send row.
  if (details.boundary !== undefined) return outcomeEvidence;

  return {
    ...outcomeEvidence,
    details: {
      ...details,
      boundary: {
        sessionId: recorded.sessionId,
        messageIds: recorded.messageIds,
        messageCount: recorded.messageCount,
        latestCreatedAt: recorded.latestCreatedAt,
        capturedAt: recorded.capturedAt,
        provenance: recorded.provenance,
      },
    },
  };
}

/**
 * Build the evidence record for a post-hoc reconciliation decision.
 *
 * The transport verdict, the worker-execution verdict, the boundary, and the fingerprints are
 * all included under distinct keys, because the decision this evidence supports is exactly
 * the one that must never be read as a single undifferentiated "success".
 */
function reconciliationEvidence(
  reconciliation: TransportReconciliation,
  delivery: Delivery,
  assignment: Assignment,
): ObservableEvidence {
  return {
    id: `ev_reconciled_${Date.now()}`,
    timestamp: Date.now(),
    source: 'reconciliation_probe',
    runtimeSessionId: delivery.targetRuntimeId,
    details: {
      phase: 'post_hoc_reconciliation',
      deliveryId: delivery.id,
      assignmentId: assignment.id,
      expectedInstructionFingerprint: reconciliation.expectedFingerprint,
      matchedFingerprint: reconciliation.matchedFingerprint,
      matchKind: reconciliation.matchKind,
      transportClassification: reconciliation.classification,
      transportReason: reconciliation.reason,
      boundaryEstablished: reconciliation.boundaryEstablished,
      boundaryProvenance: reconciliation.boundaryProvenance,
      preDispatchWatermarkMessageCount: reconciliation.watermark?.messageCount ?? null,
      matchingUserTurnId: reconciliation.matchingUserTurn?.messageId ?? null,
      matchingUserTurnCreatedAt: reconciliation.matchingUserTurn?.createdAt ?? null,
      postBoundaryUserTurns: reconciliation.postBoundaryUserTurns,
      // Separate fact, separate key, separate owner.
      workerExecution: reconciliation.workerExecution,
      workerExecutionAssistantMessageId:
        reconciliation.workerExecutionEvidence.assistantMessageId ?? null,
      workerExecutionFinish: reconciliation.workerExecutionEvidence.finish,
      // A tool-using run is a CHAIN of assistant turns, so the turn that produced the answer
      // and the turn that terminated the run are recorded separately.
      workerExecutionResponseMessageId:
        reconciliation.workerExecutionEvidence.responseMessageId ?? null,
      workerExecutionAssistantTurnCount: reconciliation.workerExecutionEvidence.assistantTurnCount,
      workerExecutionResponseText: reconciliation.workerExecutionEvidence.text,
      workerExecutionErrorType: reconciliation.workerExecutionEvidence.errorType,
      workerExecutionErrorStatus: reconciliation.workerExecutionEvidence.errorStatus,
      workerExecutionErrorMessage: reconciliation.workerExecutionEvidence.errorMessage,
      workerExecutionModel: reconciliation.workerExecutionEvidence.providerId
        ? `${reconciliation.workerExecutionEvidence.providerId}/${reconciliation.workerExecutionEvidence.modelId ?? 'unknown'}`
        : null,
      workerExecutionRunOutcomeMarkers: reconciliation.workerExecutionEvidence.runOutcomeMarkers,
      chronologicalOrder: reconciliation.chronologicalOrder,
      transcriptReadable: reconciliation.transcriptReadable,
      checkedVia: 'provider_exact_session_transcript',
    },
  };
}

/**
 * Provenances that may authorize pairing. Anything else (e.g. a historical
 * 'pair_binding' placeholder) is not evidence of project membership.
 */
const AUTHORITATIVE_ASSOCIATION_PROVENANCES: ReadonlySet<string> = new Set([
  'discovery',
  'adoption',
  'setup',
]);

/** How a stranded dispatch intent was resolved. */
export type DispatchReconciliationDispositionName =
  | 'delivered_confirmed'
  | 'not_delivered_confirmed'
  | 'ambiguous_raised';

export interface DispatchReconciliationDispositionRecord {
  deliveryId: DeliveryId;
  attemptId: AttemptId;
  assignmentId: AssignmentId;
  disposition: DispatchReconciliationDispositionName;
  attentionItemId?: AttentionItemId;
}

export interface DispatchReconciliationReport {
  examined: number;
  deliveredConfirmed: number;
  notDeliveredConfirmed: number;
  ambiguousRaised: number;
  dispositions: DispatchReconciliationDispositionRecord[];
}

/**
 * The provider's answer about a stranded dispatch, normalized to three cases.
 *
 * `insufficient` deliberately covers EVERY non-authoritative answer, including a
 * missing hook, an unregistered provider, and a thrown probe. A provider that cannot
 * answer has not thereby proven anything, so an unresolved durable dispatch intent
 * stays unresolved and becomes operator-visible rather than silently persisting.
 */
type DispatchProbeOutcome =
  | { kind: 'delivered'; evidence: ObservableEvidence; reason?: string }
  | { kind: 'not_delivered'; evidence?: ObservableEvidence; reason?: string }
  | { kind: 'insufficient'; reason: string; evidence?: ObservableEvidence };

/**
 * The truthful result of an attempt to deliver a handoff to the Planner.
 *
 * The external-effect invariant (S1) requires that no durable record assert an
 * external effect merely because RelayX intended one. The Handoff aggregate
 * carries no "attempted" or "unverified" status, so the unverified outcome is
 * reported here and durably recorded as a `planner.delivery.unverified` event,
 * rather than by inventing a second Handoff lifecycle.
 *
 * `externally_confirmed` is declared but has no construction path in S1: it
 * requires an exact Planner transport (S11) that returns provider evidence. It
 * exists so the future success path is typed, not so it can be assumed.
 */
export type PlannerDeliveryAttempt =
  | {
      /** The handoff, unchanged. */
      handoff: Handoff;
      outcome: 'unverified';
      reason: string;
      externalContactAttempted: boolean;
    }
  | {
      handoff: Handoff;
      outcome: 'externally_confirmed';
      evidence: ObservableEvidence;
      externalContactAttempted: true;
    };

export type RelayOrchestrationTransition =
  | 'disabled'
  | 'awaiting_work'
  | 'awaiting_evidence'
  | 'assignment_dispatched'
  | 'handoff_advanced'
  | 'plan_first_advanced'
  | 'busy';

export interface RelayOrchestrationResult {
  pairId: PairId;
  transition: RelayOrchestrationTransition;
  assignmentId?: AssignmentId;
  attemptId?: AttemptId;
  deliveryId?: DeliveryId;
  handoffId?: HandoffId;
  planFirstRunId?: PlanFirstRunId;
}

/**
 * A compact, event-safe projection of one side. Only tri-state facts and the
 * mandatory dimensions 8/9 travel into the audit stream, so an event can never
 * imply a verification that did not happen (§5.2, §5.3, I-6).
 */
function summariseSide(side: PairSideIdentity): Record<string, unknown> {
  return {
    sideRole: side.sideRole,
    providerType: side.providerType,
    identityState: side.identityState,
    verificationState: side.verificationState,
    existenceState: side.existenceState,
    capability: side.capability,
    sourceCapability: side.sourceCapability,
    observedAt: side.observedAt,
    reason: side.reason,
  };
}

/* ========================================================================= *
 * Relay baton: the decision vocabulary
 * ========================================================================= */

/**
 * What the baton model concluded about who owes the next completed turn.
 *
 * Every value is a TRANSPORT/continuity conclusion. None of them encodes a judgment
 * about whether the work was correct, sufficient, valid, drifted, or complete — that
 * is the Planner's call and it is deliberately absent from this vocabulary.
 */
export type RelayBatonDecision =
  /** Authority gate refused; no provider was contacted. */
  | 'refused'
  /** No confirmed Delivery exists. Bootstrap: no baton, nothing attributable. */
  | 'no_confirmed_delivery'
  /** An unresolved (pending/delivering/ambiguous) intent blocks all continuation. */
  | 'awaiting_unresolved_delivery'
  /** The persisted message-id boundary could not be located in the exact session. */
  | 'boundary_unavailable'
  /** The baton is about a session the owner side is no longer bound to. */
  | 'session_identity_unproven'
  /** The owner's exact session could not be read, so nothing can be established. */
  | 'transcript_unreadable'
  /** Case A1/B1 — the baton owner is still working. Observation only. */
  | 'observe_baton_owner_working'
  /** Case A2/B2 — a completed new turn exists and is not yet delivered. */
  | 'transfer_completed_turn'
  /** The completed turn has already been handed to the opposite side. */
  | 'completed_turn_already_transferred'
  /** Case A3/B3 — no confirmed completed turn, owner not running. */
  | 'send_recovery_notice'
  /** A recovery notice already exists for this exact baton episode. */
  | 'recovery_notice_already_issued'
  /** The recovery notice exists but its own Delivery outcome is not established. */
  | 'recovery_notice_unresolved'
  /** Nothing outstanding. Normal watching resumes with no injected message. */
  | 'nothing_outstanding'
  /** A live non-terminal Assignment holds the slot; RelayX will not steal it. */
  | 'awaiting_execution_slot';

/** The action the baton model actually took, if any. */
export type RelayBatonActionKind =
  | 'none'
  | 'handoff_reused'
  | 'handoff_created'
  | 'handoff_advanced'
  | 'recovery_notice_issued'
  | 'recovery_notice_redispatched';

/** Mechanical facts about the baton owner's exact session, for the audit trail. */
export interface BatonOwnerObservationReport {
  sideRole: PairSideRole;
  runtimeSessionId: RuntimeSessionId | null;
  providerType: ProviderType | null;
  externalSessionId: string | null;
  transcriptReadable: boolean;
  transcriptReadFailure: string | null;
  /** Which kind of anchor the boundary was drawn at. */
  boundarySource: WorkerCompletionObservation['boundary']['source'] | null;
  /** The provider message id the boundary was drawn at. */
  boundaryAnchorMessageId: string | null;
  /** Assistant turns observed strictly after the boundary. */
  assistantTurnCountAfterBoundary: number | null;
  /** A newer assistant turn exists with NO provider terminator: authoritative "still working". */
  inFlight: boolean | null;
  /** The provider's own working/generating signal. A heuristic, never the decider. */
  providerReportedWorking: boolean | null;
  hasCompletedResponse: boolean | null;
  /** Whether the captured response IS the newest assistant turn. */
  capturedResponseIsNewest: boolean | null;
  completedTurnMessageId: string | null;
  completedTurnFinish: string | null;
  completedTurnTextLength: number | null;
  /** Provider-reported terminal error on the newest post-boundary turn, verbatim. */
  terminalErrorType: string | null;
}

/**
 * The full, auditable result of one baton evaluation.
 *
 * Carries every field the live acceptance check needs to prove a scenario: the latest
 * confirmed Delivery, its direction, the baton owner, the persisted boundary, the latest
 * authoritative turn on that side, the running state, the action taken, and the resulting
 * owner. `relayDecisionTrail` records which rules were evaluated, in order, including the
 * ones that did not fire.
 */
export interface RelayBatonDecisionReport {
  pairId: PairId;
  decision: RelayBatonDecision;
  /** Rules evaluated in order, so a no-op is as auditable as an action. */
  relayDecisionTrail: string[];
  baton: {
    basis: RelayBaton['basis'];
    direction: RelayBaton['direction'];
    /** Recipient of the last confirmed Delivery: the side holding the baton. */
    owner: PairSideRole | null;
    /** The side whose confirmed Delivery put the baton where it is. */
    sender: PairSideRole | null;
    deliveryId: DeliveryId | null;
    assignmentId: AssignmentId | null;
    attemptId: AttemptId | null;
    deliveredAt: number | null;
    boundarySessionId: string | null;
    boundaryMessageCount: number | null;
    boundaryProvenance: BatonBoundary['provenance'] | null;
    /** The frozen external session dispatch was authorized against (EXECUTION_AUTHORITY). */
    dispatchedExternalSessionId: string | null;
    confirmedDeliveryCount: number;
    supersededDeliveryCount: number;
  };
  observation: BatonOwnerObservationReport | null;
  action: {
    kind: RelayBatonActionKind;
    assignmentId?: AssignmentId;
    attemptId?: AttemptId;
    deliveryId?: DeliveryId;
    handoffId?: HandoffId;
    deliveryConfirmed?: boolean;
  };
  reason: string;
}

/** Facts a recovery notice is allowed to state about the episode that triggered it. */
export interface RecoveryNoticeFacts {
  triggerDeliveryId: DeliveryId;
  triggerAssignmentId: AssignmentId;
  triggerAttemptId: AttemptId | null;
  triggerDeliveredAt: number | null;
  direction: RelayBaton['direction'];
  owner: PairSideRole;
  ownerExternalSessionId: string | null;
  boundaryMessageCount: number | null;
  boundaryProvenance: BatonBoundary['provenance'] | null;
  boundaryAnchorMessageId: string | null;
  observation: BatonOwnerObservationReport | null;
}

/**
 * The recovery notice sent to the Planner when a baton episode produced no confirmed
 * completed return turn.
 *
 * ## The semantic boundary this text is written to hold
 *
 * The notice reports ONE mechanical fact — a confirmed Delivery left the baton with its
 * recipient, and no confirmed completed turn came back — and nothing else. In particular it
 * never states or implies that the other side failed, completed, produced an invalid or
 * insufficient result, drifted from the task, or that the objective is or is not done.
 * Those are exactly the conclusions RelayX is not permitted to draw, and a notice that
 * implied any of them would smuggle the judgment back in through the only channel the
 * Planner actually reads.
 *
 * Every line is either a restatement of the mechanical fact or an identifier the operator
 * needs to audit the episode. The Planner is explicitly left to decide what happens next,
 * because that decision is the Planner's and not RelayX's.
 *
 * ## Nothing here is hardcoded to a specific Pair
 *
 * The prose is written entirely in terms of the structural side roles (`Planner`,
 * `Worker`) and the live values supplied by the caller. No project name, Pair name, side
 * name, session id, or provider-specific identity is embedded in the template, so the same
 * notice is correct for every Pair.
 */
export function buildRecoveryNotice(facts: RecoveryNoticeFacts): string {
  const obs = facts.observation;
  const ownerLabel = facts.owner === 'worker' ? 'Worker' : 'Planner';
  const directionLabel =
    facts.direction === 'planner_to_worker' ? 'planner -> worker' : 'worker -> planner';

  // Case A3 — the baton went to the Worker and no confirmed Worker response came back.
  // Case B3 — the baton went to the Planner and no confirmed completed Planner turn came
  // back. Both notices go to the Planner: it is the side that decides what happens next,
  // and it is the side whose session RelayX must therefore be able to address.
  const opening =
    facts.owner === 'worker'
      ? [
          'Resume the previous work from the current session state.',
          '',
          'The previous Planner instruction was confirmed delivered to the Worker, but RelayX ' +
            'does not have a confirmed returned Worker response for that delivery. The Worker ' +
            'is not currently observed running.',
          '',
          'Review the current conversation and decide the next action: continue, repeat, ' +
            'correct, or replace the previous instruction as appropriate.',
        ]
      : [
          'Resume the previous work from the current session state.',
          '',
          'RelayX does not have a confirmed completed Planner turn after the last delivered ' +
            'Worker response. Your previous response may have been interrupted or incomplete.',
          '',
          'Review the conversation and continue or recreate the intended next instruction.',
        ];

  const disclaimer =
    facts.owner === 'worker'
      ? 'RelayX is not asserting that the Worker failed, completed, or produced a valid, ' +
        'invalid, drifted, or sufficient result. It reports only that no confirmed returned ' +
        'response exists for the delivery named below, and it has not resent the previous ' +
        'Planner instruction.'
      : 'RelayX is not asserting that the Planner response was wrong, insufficient, or ' +
        'semantically incomplete, and it has not synthesised the missing part of that ' +
        'response or resent the previous Worker report. It reports only that no confirmed ' +
        'completed Planner turn exists after the delivery named below.';

  const evidenceLines = [
    `  - baton direction: ${directionLabel}`,
    `  - baton owner: ${ownerLabel}`,
    `  - triggering delivery: ${facts.triggerDeliveryId} (confirmed delivered${
      facts.triggerDeliveredAt !== null
        ? ` at ${new Date(facts.triggerDeliveredAt).toISOString()}`
        : ''
    })`,
    `  - triggering assignment: ${facts.triggerAssignmentId}`,
    `  - triggering attempt: ${facts.triggerAttemptId ?? 'not resolvable'}`,
    `  - owner external session: ${facts.ownerExternalSessionId ?? 'not bound'}`,
    `  - message ids recorded in the boundary before that delivery: ${
      facts.boundaryMessageCount ?? 0
    } (provenance: ${facts.boundaryProvenance ?? 'unavailable'}, anchor: ${
      facts.boundaryAnchorMessageId ?? 'none'
    })`,
    `  - authoritative session read: ${
      obs ? (obs.transcriptReadable ? 'readable' : `unreadable (${obs.transcriptReadFailure ?? 'no reason given'})`) : 'not attempted'
    }`,
    `  - assistant turns observed after the boundary: ${
      obs?.assistantTurnCountAfterBoundary ?? 'unknown'
    }`,
    `  - unterminated (still-generating) assistant turn present: ${
      obs?.inFlight === null || obs?.inFlight === undefined ? 'unknown' : obs.inFlight ? 'yes' : 'no'
    }`,
    `  - ${ownerLabel.toLowerCase()} reported working by the provider: ${
      obs?.providerReportedWorking === null || obs?.providerReportedWorking === undefined
        ? 'unknown'
        : obs.providerReportedWorking
          ? 'yes'
          : 'no'
    }`,
  ];

  return [
    'RelayX resume notice — communication continuity only.',
    '',
    ...opening,
    '',
    disclaimer,
    '',
    'RelayX delivery facts (mechanical evidence only):',
    ...evidenceLines,
  ].join('\n');
}

export class RelayEngine {
  private readonly providers: Map<string, IRuntimeProvider> = new Map();
  private registry?: IntegrationRegistry;
  private isSupervising = false;
  private readonly orchestratingPairs = new Set<PairId>();
  /**
   * Deterministic verification seam (PLAN_FIRST_DOMAIN_FREEZE.md §G step 10). Defaults to
   * the fail-closed milestone-1 evaluator, because the real correctness check is
   * explicitly deferred to §15 step 11. Injectable so the §H operational proof can supply
   * a deterministic check without the controller ever reading provider UI.
   */
  private readonly planFirstVerification: PlanFirstVerificationEvaluator;

  /**
   * Read-only client for the in-page Planner Observer, or `null` when the observer is not wired.
   *
   * It is a loopback HTTP client with no browser capability: it cannot open, activate, focus or
   * navigate the Planner tab, and it never runs AppleScript. Monitoring the Planner therefore
   * cannot churn the browser even by accident.
   *
   * Deliberately opt-in. When absent, the Planner side is observed exactly as it always was, by
   * the AppleScript transcript read, so wiring the observer cannot silently change behaviour for
   * any caller that has not asked for it.
   */
  private readonly plannerObserver: PlannerObserverClient | null;

  constructor(
    public readonly repos: IRelayRepositories,
    planFirstVerification?: PlanFirstVerificationEvaluator,
    registry?: IntegrationRegistry,
    plannerObserver?: PlannerObserverClient | null,
  ) {
    this.registry = registry;
    this.planFirstVerification = planFirstVerification ?? new MilestoneVerification();
    this.plannerObserver = plannerObserver ?? null;
  }

  public setRegistry(registry: IntegrationRegistry): void {
    this.registry = registry;
  }

  public registerProvider(provider: IRuntimeProvider): void {
    this.providers.set(provider.providerType, provider);
  }

  public getProvider(type: string): IRuntimeProvider {
    // 1. Check explicit engine providers map first (e.g. test harness or custom registered providers)
    const p = this.providers.get(type);
    if (p) {
      return p;
    }

    // 2. Fallback to integration registry
    if (this.registry) {
      const integration = this.registry.get(type);
      if (integration) {
        return integration.asRuntimeProvider();
      }
    }

    throw new RelayDomainError(`Provider for type '${type}' not registered`, 'PROVIDER_NOT_REGISTERED');
  }

  /* --- Event Helper --- */
  private async emitEvent(
    resourceType: RelayEvent['resourceType'],
    resourceId: string,
    eventType: string,
    options: {
      actor?: RelayEvent['actor'];
      previousState?: string;
      newState?: string;
      evidence?: ObservableEvidence;
      correlationId?: string;
      details?: Record<string, unknown>;
    } = {},
  ): Promise<RelayEvent> {
    const event = RelayEvent.create(resourceType, resourceId, eventType, options);
    await this.repos.events.save(event);
    if (this.repos.activities) {
      try {
        const activity = projectEventToActivity(event);
        await this.repos.activities.save(activity);
      } catch (err) {
        // Activity projection is best-effort and non-fatal
        console.error('Failed to project activity from event:', err);
      }
    }
    return event;
  }

  /* --- Project & Pair Management --- */
  public async createProject(name: string, description = '', canonicalPath?: string, gitRoot?: string): Promise<Project> {
    const project = Project.create(name, description, canonicalPath, gitRoot);
    await this.repos.projects.save(project);
    await this.emitEvent('project', project.id, 'project.created', {
      actor: 'user',
      newState: 'active',
      details: { name, description, canonicalPath, gitRoot },
    });
    return project;
  }

  public async updateProject(
    id: ProjectId,
    name?: string,
    description?: string,
    canonicalPath?: string,
    gitRoot?: string,
    plannerProjectUrl?: string,
    workerWorkspacePath?: string,
  ): Promise<Project> {
    const project = await this.repos.projects.findById(id);
    if (!project) throw new RelayDomainError(`Project ${id} not found`, 'NOT_FOUND');

    const pathChanged =
      (canonicalPath !== undefined && canonicalPath !== project.canonicalPath) ||
      (gitRoot !== undefined && gitRoot !== project.gitRoot) ||
      (plannerProjectUrl !== undefined && plannerProjectUrl !== project.plannerProjectUrl) ||
      (workerWorkspacePath !== undefined && workerWorkspacePath !== project.workerWorkspacePath);

    project.update(name, description, canonicalPath, gitRoot, plannerProjectUrl, workerWorkspacePath);
    await this.repos.projects.save(project);

    // Configuration changes invalidate dependent association evidence and trigger revalidation
    if (pathChanged && this.repos.associations) {
      const associations = await this.repos.associations.findByProjectId(id);
      for (const assoc of associations) {
        if (assoc.verificationState === 'verified') {
          await this.repos.associations.save(assoc.withVerificationState('stale'));
        }
      }
    }

    await this.emitEvent('project', id, 'project.updated', {
      actor: 'user',
      newState: project.status,
      details: { name: project.name, description: project.description, pathChanged },
    });
    return project;
  }

  public async archiveProject(id: ProjectId): Promise<Project> {
    const project = await this.repos.projects.findById(id);
    if (!project) throw new RelayDomainError(`Project ${id} not found`, 'NOT_FOUND');

    // Guard: cannot archive if active assignments are in flight
    const assignments = await this.repos.assignments.findAll();
    const activeAssignments = assignments.filter(
      (a) => a.projectId === id && ['pending', 'active', 'waiting_for_handoff'].includes(a.status),
    );
    if (activeAssignments.length > 0) {
      throw new RelayDomainError(
        `Cannot archive project with ${activeAssignments.length} active assignment(s). Cancel or complete work first.`,
        'ACTIVE_WORK_GUARD',
      );
    }

    const previousState = project.status;
    project.archive();
    await this.repos.projects.save(project);

    await this.emitEvent('project', id, 'project.archived', {
      actor: 'user',
      previousState,
      newState: 'archived',
    });
    return project;
  }

  public async unarchiveProject(id: ProjectId): Promise<Project> {
    const project = await this.repos.projects.findById(id);
    if (!project) throw new RelayDomainError(`Project ${id} not found`, 'NOT_FOUND');

    project.unarchive();
    await this.repos.projects.save(project);

    await this.emitEvent('project', id, 'project.updated', {
      actor: 'user',
      previousState: 'archived',
      newState: 'active',
    });
    return project;
  }

  public async canDeleteProject(id: ProjectId): Promise<{ canDelete: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const project = await this.repos.projects.findById(id);
    if (!project) {
      return { canDelete: false, reasons: ['Project not found'] };
    }

    const pairs = await this.repos.pairs.findByProjectId(id);
    const assignments = await this.repos.assignments.findAll();
    const projectAssignments = assignments.filter((a) => a.projectId === id);

    // 1. Check for active assignments
    const activeAssignments = projectAssignments.filter((a) =>
      ['pending', 'active', 'waiting_for_handoff'].includes(a.status),
    );
    if (activeAssignments.length > 0) {
      reasons.push(`Project has ${activeAssignments.length} active or in-flight assignment(s)`);
    }

    // 2. Check for active pair state
    let genuineActivePairsCount = 0;
    for (const p of pairs) {
      if (p.status === 'active' || (await this.hasActiveWork(p))) {
        genuineActivePairsCount++;
      }
    }
    if (genuineActivePairsCount > 0) {
      reasons.push(`Project has ${genuineActivePairsCount} pair(s) with active work in progress`);
    }

    // 3. Check for in-flight attempts, deliveries, handoffs for each project assignment
    for (const asgn of projectAssignments) {
      const attempts = await this.repos.attempts.findByAssignmentId(asgn.id);
      const runningAttempts = attempts.filter((at) => at.status === 'running');
      if (runningAttempts.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${runningAttempts.length} running execution attempt(s)`);
      }

      const deliveries = await this.repos.deliveries.findByAssignmentId(asgn.id);
      const pendingDeliveries = deliveries.filter((d) => ['pending', 'delivering'].includes(d.status));
      if (pendingDeliveries.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${pendingDeliveries.length} in-flight delivery attempt(s)`);
      }

      const handoffs = await this.repos.handoffs.findByAssignmentId(asgn.id);
      const pendingHandoffs = handoffs.filter((h) => ['pending', 'ready'].includes(h.status));
      if (pendingHandoffs.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${pendingHandoffs.length} pending handoff(s) awaiting delivery`);
      }
    }

    // 4. Check for working runtimes in this project's pairs
    for (const pair of pairs) {
      if (pair.plannerSessionId) {
        const planner = await this.repos.runtimes.findById(pair.plannerSessionId);
        if (planner && planner.status === 'working') {
          reasons.push(`Planner runtime '${planner.name}' is currently in 'working' status`);
        }
      }
      if (pair.workerSessionId) {
        const worker = await this.repos.runtimes.findById(pair.workerSessionId);
        if (worker && worker.status === 'working') {
          reasons.push(`Worker runtime '${worker.name}' is currently in 'working' status`);
        }
      }
    }

    return {
      canDelete: reasons.length === 0,
      reasons,
    };
  }

  public async deleteProject(id: ProjectId): Promise<void> {
    const check = await this.canDeleteProject(id);
    if (!check.canDelete) {
      throw new RelayDomainError(
        `Cannot delete project: active dependencies exist (${check.reasons.join('; ')}). Archive the project instead.`,
        'ACTIVE_WORK_GUARD',
      );
    }
    const project = await this.repos.projects.findById(id);
    if (!project) throw new RelayDomainError(`Project ${id} not found`, 'NOT_FOUND');

    const pairs = await this.repos.pairs.findByProjectId(id);
    for (const p of pairs) {
      await this.repos.pairs.delete(p.id);
    }

    await this.repos.projects.delete(id);

    // Event emitted: historical events remain in events repository for audit compliance
    await this.emitEvent('project', id, 'project.deleted', {
      actor: 'user',
      previousState: project.status,
      newState: 'deleted',
      details: { name: project.name, deletedPairsCount: pairs.length },
    });
  }

  public async registerRuntimeSession(
    providerType: ProviderType,
    name: string,
    bundleIdentifier?: string,
    externalSessionId?: string,
    externalProjectRef?: string,
    sessionUrl?: string,
  ): Promise<RuntimeSession> {
    const runtime = RuntimeSession.create(providerType, name, bundleIdentifier);
    if (externalSessionId || externalProjectRef || sessionUrl) {
      runtime.updateExternalIdentity(externalSessionId, externalProjectRef, sessionUrl);
    }
    await this.repos.runtimes.save(runtime);
    await this.emitEvent('runtime', runtime.id, 'runtime.registered', {
      actor: 'engine',
      newState: runtime.status,
      details: { name, providerType, bundleIdentifier, externalSessionId, externalProjectRef, sessionUrl },
    });
    return runtime;
  }

  /**
   * Discovers or updates a runtime session for a given provider.
   * Invariant: Repeated discovery updates the existing runtime rather than creating
   * duplicates — except when only project-scoped identity (openCodeProjectId) is present
   * without a proven session ID: distinct sessions in one project must not collapse.
   */
  public async discoverRuntime(
    providerType: ProviderType,
    descriptor?: RuntimeTargetDescriptor,
  ): Promise<{ runtime: RuntimeSession; inspection: RuntimeInspectionResult; isNew: boolean }> {
    const provider = this.getProvider(providerType);
    const targetDescriptor = descriptor ?? { providerType };
    const inspection = await provider.findRuntime(targetDescriptor);

    // Session identity must be PROVEN to identify one provider session. Only an
    // authoritativeSessionId verified against the shared OpenCode service or a
    // persisted session record qualifies. parsedSessionId can also arrive from a
    // plain window-title parse (unverified), and openCodeProjectId is project
    // identity, never session identity — neither may drive reuse or be persisted
    // as the external session ID.
    const details = (inspection.evidence?.details || {}) as any;
    const extId: string | undefined = details.authoritativeSessionId;
    // Project identity is tracked separately from session identity.
    const projectRef: string | null = providerType === 'opencode'
      ? (details.workspacePath || details.openCodeProjectId || null)
      : (details.projectUrl || details.projectName || null);

    let existing: RuntimeSession | null = null;
    if (extId) {
      // Proven session identity present: reuse ONLY the runtime bound to this exact
      // (providerType, externalSessionId). PID/bundle/title/provider-only fallbacks
      // would silently claim the wrong runtime (e.g. a legacy null-ID paired runtime).
      existing = await this.repos.runtimes.findByExternalSessionId(providerType, extId);
    } else if (details.openCodeProjectId) {
      // Project-scoped identity without a proven session ID cannot distinguish one
      // session from another inside the same project. Reusing by PID/bundle/provider
      // could claim the wrong session, so a distinct runtime is created instead.
      existing = null;
    } else {
      // No identity available at all: retain the documented legacy fallback —
      // application PID, then bundle identifier, then any runtime of the provider type.
      const existingRuntimes = await this.repos.runtimes.findAll();
      existing = existingRuntimes.find((r) => {
        if (r.providerType !== providerType) return false;
        if (inspection.applicationPid && r.applicationPid === inspection.applicationPid) return true;
        if (targetDescriptor.bundleIdentifier && r.bundleIdentifier === targetDescriptor.bundleIdentifier) return true;
        return true;
      }) ?? null;
    }

    if (existing) {
      if (inspection.found) {
        existing.recordObservationSuccess(
          inspection.isWorking ? 'working' : 'available',
          inspection.evidence,
          inspection.windowTitle,
          inspection.applicationPid,
        );
      } else {
        existing.recordObservationFailure();
      }
      // Reuse found by exact external identity (or legacy fallback): the runtime's
      // authoritative identity is preserved and observations are persisted.
      await this.repos.runtimes.save(existing);
      await this.emitEvent('runtime', existing.id, 'runtime.discovered', {
        actor: 'engine',
        newState: existing.status,
        evidence: inspection.evidence,
        details: { providerType, isNew: false },
      });
      return { runtime: existing, inspection, isNew: false };
    }

    const runtimeName = inspection.windowTitle || `${providerType.toUpperCase()} Runtime`;
    const runtime = RuntimeSession.create(providerType, runtimeName, targetDescriptor.bundleIdentifier);
    if (inspection.found) {
      runtime.recordObservationSuccess(
        inspection.isWorking ? 'working' : 'available',
        inspection.evidence,
        inspection.windowTitle,
        inspection.applicationPid,
      );
    } else {
      runtime.status = 'unavailable';
      runtime.lastEvidence = inspection.evidence;
    }
    // Persist verified session identity and project identity separately at the
    // creation boundary. Project identity is kept in externalProjectRef even when
    // no proven session ID exists (e.g. evidence carrying only openCodeProjectId).
    if (extId || projectRef) {
      runtime.updateExternalIdentity(extId ?? null, projectRef ?? null);
    }
    await this.repos.runtimes.save(runtime);
    await this.emitEvent('runtime', runtime.id, 'runtime.discovered', {
      actor: 'engine',
      newState: runtime.status,
      evidence: inspection.evidence,
      details: { providerType, isNew: true },
    });
    return { runtime, inspection, isNew: true };
  }

  /**
   * Pairing requires pre-existing, verified, provider-evidenced project
   * association. This deliberately reads only persisted evidence: it never
   * derives membership from a runtime's own mutable fields, and never infers a
   * session from directory, recency, or ordering heuristics. A repository that
   * cannot verify the evidence columns throws its own schema-gap error, which
   * propagates so a pair can never be created against unverifiable evidence.
   *
   * A runtime with no provider session id has no session identity to verify
   * (e.g. a planner bound only to a project URL during setup), so there is
   * nothing to corroborate and the gate does not apply to it.
   */
  public async assertPrePairAuthoritativeAssociation(
    role: 'planner' | 'worker',
    runtime: RuntimeSession,
    projectId: ProjectId,
  ): Promise<void> {
    // Fail closed: with no association repository there is nothing that could
    // verify evidence, so pairing must stop instead of assuming that a
    // runtime's own fields are proof of project membership.
    if (!this.repos.associations) {
      throw new Error(
        'Association schema gap: repository cannot verify runtime_session_id, provider_type, external_session_id, and project_id for pre-pair evidence',
      );
    }
    // A runtime with no provider session id has no session identity to
    // corroborate. That alone is not a defect: if nothing is claimed about it,
    // there is nothing to verify and the legacy path may proceed. But a stored
    // verified/authoritative row that cannot name a session is claiming
    // verification it cannot support, and that is a schema gap.
    if (!runtime.externalSessionId) {
      const rows = await this.repos.associations.findBySessionId(runtime.id);
      const unverifiableClaim = rows.some(
        (row) =>
          row.verificationState === 'verified' &&
          AUTHORITATIVE_ASSOCIATION_PROVENANCES.has(row.provenance),
      );
      if (unverifiableClaim) {
        throw new Error(
          'Association schema gap: external_session_id is required for pre-pair evidence',
        );
      }
      return;
    }
    // The repository is consulted for the exact (session, provider, external id,
    // project) identity; it raises its own schema gap if the stored evidence
    // columns cannot support the comparison.
    const evidence = await this.repos.associations.findVerifiedBySessionId(runtime.id, {
      providerType: runtime.providerType,
      externalSessionId: runtime.externalSessionId,
      projectId,
    });
    if (!evidence) {
      throw new RelayDomainError(
        `${role} session lacks matching pre-pair verified authoritative association`,
        'ASSOCIATION_NOT_VERIFIED',
      );
    }
  }

  public isPlannerProvider(providerType: string): boolean {
    if (this.registry) {
      const integration = this.registry.get(providerType);
      if (integration) {
        return integration.roles.includes('planner') || integration.roles.includes('both');
      }
    }
    // Fallback for untracked providers
    if (providerType === 'opencode' || providerType === 'vscode') return false;
    return true;
  }

  public isWorkerProvider(providerType: string): boolean {
    if (this.registry) {
      const integration = this.registry.get(providerType);
      if (integration) {
        return integration.roles.includes('worker') || integration.roles.includes('both');
      }
    }
    // Fallback for untracked providers
    if (providerType === 'chatgpt') return false;
    return true;
  }

  public async createPair(
    projectId: ProjectId,
    name: string,
    plannerSessionId?: RuntimeSessionId,
    workerSessionId?: RuntimeSessionId,
  ): Promise<Pair> {
    const project = await this.repos.projects.findById(projectId);
    if (!project) throw new RelayDomainError(`Project ${projectId} not found`, 'NOT_FOUND');

    if (plannerSessionId) {
      const planner = await this.repos.runtimes.findById(plannerSessionId);
      if (!planner) throw new RelayDomainError('Planner runtime not found', 'RUNTIME_NOT_FOUND');
      if (!this.isPlannerProvider(planner.providerType)) throw new RelayDomainError('Planner session must be ChatGPT', 'INVALID_PLANNER_PROVIDER');
      const existingPairs = await this.repos.pairs.findAll();
      const alreadyPaired = existingPairs.find(
        (p) => p.status !== 'archived' && (p.plannerSessionId === plannerSessionId || p.workerSessionId === plannerSessionId),
      );
      if (alreadyPaired) throw new RelayDomainError('Runtime session is already bound to an active pair', 'SESSION_ALREADY_PAIRED');
      // Pre-pair ground truth: a runtime's own fields are not proof of project
      // membership. Require a pre-existing, verified, provider-evidenced row for
      // this exact (session, provider, external id, project) identity.
      await this.assertPrePairAuthoritativeAssociation('planner', planner, projectId);
    }
    if (workerSessionId) {
      const worker = await this.repos.runtimes.findById(workerSessionId);
      if (!worker) throw new RelayDomainError('Worker runtime not found', 'RUNTIME_NOT_FOUND');
      if (!this.isWorkerProvider(worker.providerType)) throw new RelayDomainError('Worker session must be OpenCode or VS Code', 'INVALID_WORKER_PROVIDER');
      const existingPairs = await this.repos.pairs.findAll();
      const alreadyPaired = existingPairs.find(
        (p) => p.status !== 'archived' && (p.plannerSessionId === workerSessionId || p.workerSessionId === workerSessionId),
      );
      if (alreadyPaired) throw new RelayDomainError('Runtime session is already bound to an active pair', 'SESSION_ALREADY_PAIRED');
      await this.assertPrePairAuthoritativeAssociation('worker', worker, projectId);
    }

    const pair = Pair.create(projectId, name, plannerSessionId, workerSessionId);
    await this.repos.pairs.save(pair);
    await this.emitEvent('pair', pair.id, 'pair.created', {
      actor: 'user',
      newState: pair.status,
      details: { name, projectId, plannerSessionId, workerSessionId },
    });
    return pair;
  }

  public async updatePair(
    id: PairId,
    updates: { name?: string; plannerSessionId?: RuntimeSessionId | null; workerSessionId?: RuntimeSessionId | null },
  ): Promise<Pair> {
    const pair = await this.repos.pairs.findById(id);
    if (!pair) throw new RelayDomainError(`Pair ${id} not found`, 'NOT_FOUND');

    if (pair.activeAssignmentId) {
      const assignment = await this.repos.assignments.findById(pair.activeAssignmentId);
      if (assignment && ['pending', 'active', 'waiting_for_handoff'].includes(assignment.status)) {
        if (updates.plannerSessionId !== undefined || updates.workerSessionId !== undefined) {
          throw new RelayDomainError(
            'Cannot rebind runtimes while pair has an active assignment in flight. Pause or complete work first.',
            'ACTIVE_WORK_GUARD',
          );
        }
      } else {
        pair.clearWork();
        await this.repos.pairs.save(pair);
      }
    }

    const previousPlanner = pair.plannerSessionId;
    const previousWorker = pair.workerSessionId;

    if (updates.plannerSessionId) {
      const planner = await this.repos.runtimes.findById(updates.plannerSessionId);
      if (!planner) throw new RelayDomainError('New planner runtime not found', 'RUNTIME_NOT_FOUND');
      if (!this.isPlannerProvider(planner.providerType)) throw new RelayDomainError('Planner session must be ChatGPT', 'INVALID_PLANNER_PROVIDER');
      // Rebinding selects a new session, so it is subject to the same
      // authoritative-evidence gate as initial pairing.
      await this.assertPrePairAuthoritativeAssociation('planner', planner, pair.projectId);
    }
    if (updates.workerSessionId) {
      const worker = await this.repos.runtimes.findById(updates.workerSessionId);
      if (!worker) throw new RelayDomainError('New worker runtime not found', 'RUNTIME_NOT_FOUND');
      if (!this.isWorkerProvider(worker.providerType)) throw new RelayDomainError('Worker session must be OpenCode or VS Code', 'INVALID_WORKER_PROVIDER');
      await this.assertPrePairAuthoritativeAssociation('worker', worker, pair.projectId);
    }

    pair.update(updates.name, updates.plannerSessionId, updates.workerSessionId);
    await this.repos.pairs.save(pair);

    if (updates.plannerSessionId !== undefined && updates.plannerSessionId !== previousPlanner) {
      if (updates.plannerSessionId) {
        await this.emitEvent('runtime', updates.plannerSessionId, previousPlanner ? 'runtime.replaced' : 'runtime.attached', {
          actor: 'user',
          details: { pairId: id, role: 'planner', oldSessionId: previousPlanner, newSessionId: updates.plannerSessionId },
        });
      } else if (previousPlanner) {
        await this.emitEvent('runtime', previousPlanner, 'runtime.detached', {
          actor: 'user',
          details: { pairId: id, role: 'planner', runtimeSessionId: previousPlanner },
        });
      }
    }

    if (updates.workerSessionId !== undefined && updates.workerSessionId !== previousWorker) {
      if (updates.workerSessionId) {
        await this.emitEvent('runtime', updates.workerSessionId, previousWorker ? 'runtime.replaced' : 'runtime.attached', {
          actor: 'user',
          details: { pairId: id, role: 'worker', oldSessionId: previousWorker, newSessionId: updates.workerSessionId },
        });
      } else if (previousWorker) {
        await this.emitEvent('runtime', previousWorker, 'runtime.detached', {
          actor: 'user',
          details: { pairId: id, role: 'worker', runtimeSessionId: previousWorker },
        });
      }
    }

    await this.emitEvent('pair', id, 'pair.updated', {
      actor: 'user',
      newState: pair.status,
      details: updates,
    });

    return pair;
  }

  public async rebindPairPlanner(pairId: PairId, plannerSessionId: RuntimeSessionId): Promise<Pair> {
    return this.updatePair(pairId, { plannerSessionId });
  }

  public async rebindPairWorker(pairId: PairId, workerSessionId: RuntimeSessionId): Promise<Pair> {
    return this.updatePair(pairId, { workerSessionId });
  }

  public async detachPairRuntime(pairId: PairId, role: 'planner' | 'worker'): Promise<Pair> {
    return this.updatePair(pairId, {
      [role === 'planner' ? 'plannerSessionId' : 'workerSessionId']: null,
    });
  }

  public async archivePair(id: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(id);
    if (!pair) throw new RelayDomainError(`Pair ${id} not found`, 'NOT_FOUND');
    if (pair.activeAssignmentId) {
      const assignment = await this.repos.assignments.findById(pair.activeAssignmentId);
      if (assignment && ['pending', 'active', 'waiting_for_handoff'].includes(assignment.status)) {
        throw new RelayDomainError('Cannot archive pair with active assignment in flight. Pause or complete work first.', 'ACTIVE_WORK_GUARD');
      } else {
        pair.clearWork();
        await this.repos.pairs.save(pair);
      }
    }
    // Transactional enough: establish final checkpoint before archive
    await this.createPairCheckpoint(id, 'pair_archive', { summary: 'Final checkpoint prior to pair archive' });

    const previousState = pair.status;
    pair.archive();
    await this.repos.pairs.save(pair);

    await this.emitEvent('pair', id, 'pair.archived', {
      actor: 'user',
      previousState,
      newState: 'archived',
    });
    return pair;
  }

  public async createPairCheckpoint(
    pairId: PairId,
    reason: string,
    props?: Partial<PairCheckpointProps>,
  ): Promise<PairCheckpoint> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'NOT_FOUND');

    const assignments = await this.repos.assignments.findByPairId(pairId);
    const latestAssignment = assignments.length > 0 ? assignments[assignments.length - 1] : undefined;
    let latestAttempt: Attempt | undefined;
    let latestDelivery: Delivery | undefined;
    if (latestAssignment) {
      const attempts = await this.repos.attempts.findByAssignmentId(latestAssignment.id);
      latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
      const deliveries = await this.repos.deliveries.findByAssignmentId(latestAssignment.id);
      latestDelivery = deliveries.length > 0 ? deliveries[deliveries.length - 1] : undefined;
    }

    const checkpoint = PairCheckpoint.create({
      pairId,
      reason,
      objective: props?.objective ?? latestAssignment?.title ?? null,
      currentMilestone: props?.currentMilestone ?? latestAssignment?.instruction ?? null,
      summary: props?.summary ?? null,
      pendingWork: props?.pendingWork ?? null,
      nextAction: props?.nextAction ?? null,
      latestAssignmentId: props?.latestAssignmentId ?? latestAssignment?.id ?? null,
      latestAttemptId: props?.latestAttemptId ?? latestAttempt?.id ?? null,
      latestDeliveryId: props?.latestDeliveryId ?? latestDelivery?.id ?? null,
      plannerContext: props?.plannerContext ?? null,
      workerContext: props?.workerContext ?? null,
      repoHead: props?.repoHead ?? null,
      metadata: props?.metadata ?? null,
    });

    await this.repos.checkpoints.create(checkpoint);
    await this.emitEvent('pair', pairId, 'pair.checkpoint_created', {
      actor: 'engine',
      details: { checkpointId: checkpoint.id, reason },
    });
    return checkpoint;
  }

  public async getPairCheckpoint(id: PairCheckpointId): Promise<PairCheckpoint | null> {
    return this.repos.checkpoints.findById(id);
  }

  public async getLatestPairCheckpoint(pairId: PairId): Promise<PairCheckpoint | null> {
    return this.repos.checkpoints.findLatest(pairId);
  }

  public async listPairCheckpoints(pairId: PairId): Promise<PairCheckpoint[]> {
    return this.repos.checkpoints.findAll(pairId);
  }

  public async deliverCheckpointContinuation(
    pairId: PairId,
    checkpointId: PairCheckpointId,
    targetRuntimeSessionId?: RuntimeSessionId,
  ): Promise<{ assignment: Assignment; attempt: Attempt; delivery: Delivery }> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'NOT_FOUND');

    const checkpoint = await this.repos.checkpoints.findById(checkpointId);
    if (!checkpoint) throw new RelayDomainError(`Checkpoint ${checkpointId} not found`, 'NOT_FOUND');
    if (checkpoint.pairId !== pairId) throw new RelayDomainError('Checkpoint does not belong to pair', 'INVALID_CHECKPOINT_OWNER');

    const runtimeId = targetRuntimeSessionId ?? pair.workerSessionId ?? pair.plannerSessionId;
    if (!runtimeId) throw new RelayDomainError('No runtime session available for continuation delivery', 'NO_RUNTIME_BOUND');

    const runtime = await this.repos.runtimes.findById(runtimeId);
    if (!runtime) throw new RelayDomainError(`Runtime session ${runtimeId} not found`, 'RUNTIME_NOT_FOUND');
    if (runtime.status === 'terminated') throw new RuntimeNotAvailableError(runtime.id, runtime.status);

    const instructionText = [
      `[RelayX Pair Continuation from Checkpoint ${checkpoint.id}]`,
      `Reason: ${checkpoint.reason}`,
      checkpoint.objective ? `Objective: ${checkpoint.objective}` : null,
      checkpoint.currentMilestone ? `Current Milestone: ${checkpoint.currentMilestone}` : null,
      checkpoint.summary ? `Summary: ${checkpoint.summary}` : null,
      checkpoint.pendingWork ? `Pending Work: ${checkpoint.pendingWork}` : null,
      checkpoint.nextAction ? `Next Action: ${checkpoint.nextAction}` : null,
      checkpoint.repoHead ? `Repo Head: ${checkpoint.repoHead}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const assignment = Assignment.create(pairId, pair.projectId, `Continuation from Checkpoint ${checkpoint.id}`, instructionText);
    await this.repos.assignments.save(assignment);

    // ---- EXECUTION-SLOT AUTHORITY ------------------------------------------------
    //
    // This method hand-rolls its Attempt and Delivery instead of routing through
    // `dispatchAssignment`, so it has to consult the execution-slot authority itself.
    //
    // It used not to, and it is the same defect the relay resume notice had: `assignWork`
    // is an unconditional setter, so a Pair that already owned an unresolved active
    // Assignment silently lost it here — the old Assignment stayed `active` with its own
    // Attempt while `pairs.active_assignment_id` named this new one, and
    // `reconcilePairAssignmentAuthority` classified that Pair as corrupt and cancelled the
    // displaced Assignment.
    //
    // Claiming the slot through `assertExecutionSlotAvailable` reuses the authority the rest
    // of the engine already obeys: a terminal or dangling holder is released explicitly with
    // an event, and a genuinely unresolved holder REFUSES the claim by name
    // (`PAIR_ACTIVE_ASSIGNMENT_EXISTS`) instead of being overwritten. That is the model's own
    // stated remedy — retry the active Assignment, or transition it deliberately.
    //
    // The check runs BEFORE any dispatched record is durable, so a refusal leaves only a
    // `pending` no-Attempt Assignment, which is legal backlog, and mints no Attempt at all —
    // the same guarantee `createAssignmentAndClaimExecutionSlot` makes.
    await this.assertExecutionSlotAvailable(pair, assignment);
    pair.assignWork(assignment.id);
    await this.repos.pairs.save(pair);

    const attemptNumber = 1;
    const attempt = Attempt.create(assignment.id, attemptNumber, {
      sessionPairId: pair.id,
      workerSessionId: runtime.id,
      externalSessionId: runtime.externalSessionId ?? null,
    });
    await this.repos.attempts.save(attempt);

    assignment.startAttempt(attempt);
    await this.repos.assignments.save(assignment);

    const idempotencyKey = `idemp_cont_${assignment.id}_${Date.now()}`;
    const delivery = Delivery.create(
      assignment.id,
      attempt.id,
      runtime.id,
      instructionText.substring(0, 100),
      idempotencyKey,
    );
    delivery.startDelivering();
    assignment.attachDelivery(delivery);
    await this.repos.deliveries.save(delivery);
    await this.repos.assignments.save(assignment);

    await this.emitEvent('delivery', delivery.id, 'delivery.started', {
      actor: 'engine',
      previousState: 'pending',
      newState: 'delivering',
      correlationId: idempotencyKey,
    });

    const provider = this.getProvider(runtime.providerType);
    const boundary = provider.captureTransportBoundary
      ? await provider.captureTransportBoundary({
          runtimeSessionId: runtime.id,
          externalSessionId: runtime.externalSessionId ?? null,
        })
      : { watermark: null, failure: 'Provider exposes no transport-boundary capability.' };

    if (boundary.watermark) {
      delivery.evidence = {
        id: `ev_pre_dispatch_boundary_${boundary.watermark.capturedAt}`,
        timestamp: boundary.watermark.capturedAt,
        source: 'reconciliation_probe',
        runtimeSessionId: runtime.id,
        details: {
          phase: 'pre_dispatch_boundary',
          sessionId: boundary.watermark.sessionId,
          messageCount: boundary.watermark.messageCount,
          latestCreatedAt: boundary.watermark.latestCreatedAt,
          messageIds: boundary.watermark.messageIds,
        },
      };
      await this.repos.deliveries.save(delivery);
    }

    const result = await provider.deliverInstruction({
      runtimeSessionId: runtime.id,
      externalSessionId: runtime.externalSessionId ?? null,
      instructionText,
      idempotencyKey,
      preDispatchWatermark: boundary.watermark,
      modelOverride: await this.resolveProviderModelOverride(runtime.providerType, pair.projectId, pair.id),
    });

    if (result.outcome === 'delivered') {
      delivery.confirmDelivered(withRecordedBoundary(result.evidence, delivery.evidence));
      await this.repos.deliveries.save(delivery);
      // Execution promotion removed per freeze: delivery confirmation alone
      // does not prove execution began. Attempt remains `prepared` until
      // execution evidence is observed (e.g. supervision tick / transcript).
      await this.emitEvent('pair', pairId, 'pair.continuation_delivered', {
        actor: 'engine',
        details: {
          checkpointId: checkpoint.id,
          targetRuntimeSessionId: runtime.id,
          deliveryId: delivery.id,
          outcome: result.outcome,
        },
      });
    } else if (result.outcome === 'ambiguous') {
      delivery.markAmbiguous(result.reason || 'Ambiguous delivery outcome during continuation', result.evidence);
      await this.repos.deliveries.save(delivery);

      const attention = AttentionItem.create(
        'warning',
        'continuation_delivery_ambiguous',
        'Continuation delivery outcome is ambiguous',
        `Checkpoint continuation delivery to runtime ${runtime.id} returned an ambiguous outcome.`,
        {
          pairId,
          assignmentId: assignment.id,
          suggestedAction: 'Verify runtime session state and inspect message logs before resending continuation.',
          suggestedTier: 'tier_1_deterministic',
        },
      );
      await this.repos.attention.save(attention);

      await this.emitEvent('pair', pairId, 'pair.continuation_ambiguous', {
        actor: 'engine',
        details: {
          checkpointId: checkpoint.id,
          targetRuntimeSessionId: runtime.id,
          deliveryId: delivery.id,
          outcome: result.outcome,
          failureReason: result.reason,
        },
      });
    } else {
      delivery.markFailed(result.reason || 'Failed continuation delivery', result.evidence);
      await this.repos.deliveries.save(delivery);

      const attention = AttentionItem.create(
        'critical',
        'continuation_delivery_failed',
        'Continuation delivery failed',
        `Checkpoint continuation delivery to runtime ${runtime.id} failed: ${result.reason || 'unknown reason'}.`,
        {
          pairId,
          assignmentId: assignment.id,
          suggestedAction: 'Inspect runtime health and retry continuation delivery or rebind.',
          suggestedTier: 'tier_1_deterministic',
        },
      );
      await this.repos.attention.save(attention);

      await this.emitEvent('pair', pairId, 'pair.continuation_failed', {
        actor: 'engine',
        details: {
          checkpointId: checkpoint.id,
          targetRuntimeSessionId: runtime.id,
          deliveryId: delivery.id,
          outcome: result.outcome,
          failureReason: result.reason,
        },
      });
    }

    return { assignment, attempt, delivery };
  }

  public async replaceRuntime(
    pairId: PairId,
    sideRole: PairSideRole,
    newRuntimeSessionId: RuntimeSessionId,
    reason = 'runtime_replacement',
  ): Promise<Pair> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'NOT_FOUND');

    const newRuntime = await this.repos.runtimes.findById(newRuntimeSessionId);
    if (!newRuntime) throw new RelayDomainError('Replacement runtime session not found', 'RUNTIME_NOT_FOUND');

    await this.assertPrePairAuthoritativeAssociation(sideRole, newRuntime, pair.projectId);

    const checkpoint = await this.createPairCheckpoint(pairId, reason, {
      summary: `Checkpoint captured prior to replacing ${sideRole} runtime session`,
    });

    const oldSessionId = sideRole === 'planner' ? pair.plannerSessionId : pair.workerSessionId;

    if (sideRole === 'planner') {
      pair.plannerSessionId = newRuntimeSessionId;
    } else {
      pair.workerSessionId = newRuntimeSessionId;
    }
    pair.updatedAt = Date.now();
    await this.repos.pairs.save(pair);

    await this.emitEvent('pair', pairId, 'pair.runtime_replaced', {
      actor: 'user',
      details: { sideRole, oldSessionId, newRuntimeSessionId, reason },
    });

    // Automatically deliver checkpoint continuation to the replacement runtime session
    try {
      await this.deliverCheckpointContinuation(pairId, checkpoint.id, newRuntimeSessionId);
    } catch (e) {
      // Continuation delivery attempt recorded but non-blocking for rebind if runtime is offline
    }

    return pair;
  }

  public async rotatePair(
    pairId: PairId,
    sourceCheckpointId: PairCheckpointId,
    newName: string,
    plannerSessionId?: RuntimeSessionId,
    workerSessionId?: RuntimeSessionId,
  ): Promise<Pair> {
    const predecessorPair = await this.repos.pairs.findById(pairId);
    if (!predecessorPair) throw new RelayDomainError(`Predecessor Pair ${pairId} not found`, 'NOT_FOUND');

    const checkpoint = await this.repos.checkpoints.findById(sourceCheckpointId);
    if (!checkpoint) throw new RelayDomainError(`Source Checkpoint ${sourceCheckpointId} not found`, 'NOT_FOUND');
    if (checkpoint.pairId !== pairId) throw new RelayDomainError('Checkpoint does not belong to predecessor pair', 'INVALID_CHECKPOINT_OWNER');

    const now = Date.now();
    const successorPair = new Pair({
      id: createId<PairId>('pair'),
      projectId: predecessorPair.projectId,
      name: newName,
      plannerSessionId: plannerSessionId ?? predecessorPair.plannerSessionId,
      workerSessionId: workerSessionId ?? predecessorPair.workerSessionId,
      status: 'active',
      predecessorPairId: predecessorPair.id,
      sourceCheckpointId: checkpoint.id,
      createdAt: now,
      updatedAt: now,
    });

    await this.repos.pairs.save(successorPair);
    await this.emitEvent('pair', successorPair.id, 'pair.rotated', {
      actor: 'user',
      details: { predecessorPairId: pairId, sourceCheckpointId },
    });
    return successorPair;
  }

  public async unarchivePair(id: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(id);
    if (!pair) throw new RelayDomainError(`Pair ${id} not found`, 'NOT_FOUND');
    pair.unarchive();
    await this.repos.pairs.save(pair);

    await this.emitEvent('pair', id, 'pair.updated', {
      actor: 'user',
      previousState: 'archived',
      newState: pair.status,
    });
    return pair;
  }

  public async canDeletePair(id: PairId): Promise<{ canDelete: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const pair = await this.repos.pairs.findById(id);
    if (!pair) {
      return { canDelete: false, reasons: ['Pair not found'] };
    }

    if (pair.status === 'active' || pair.activeAssignmentId) {
      reasons.push('Pair currently has an active running assignment');
    }

    const assignments = await this.repos.assignments.findAll();
    const pairAssignments = assignments.filter((a) => a.pairId === id);
    const activeAssignments = pairAssignments.filter((a) =>
      ['pending', 'active', 'waiting_for_handoff'].includes(a.status),
    );
    if (activeAssignments.length > 0) {
      reasons.push(`Pair has ${activeAssignments.length} active or in-flight assignment(s)`);
    }

    if (pair.workerSessionId) {
      const worker = await this.repos.runtimes.findById(pair.workerSessionId);
      if (worker && worker.status === 'working') {
        reasons.push(`Worker runtime '${worker.name}' is currently in 'working' status`);
      }
    }
    if (pair.plannerSessionId) {
      const planner = await this.repos.runtimes.findById(pair.plannerSessionId);
      if (planner && planner.status === 'working') {
        reasons.push(`Planner runtime '${planner.name}' is currently in 'working' status`);
      }
    }

    for (const asgn of pairAssignments) {
      const attempts = await this.repos.attempts.findByAssignmentId(asgn.id);
      const runningAttempts = attempts.filter((at) => at.status === 'running');
      if (runningAttempts.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${runningAttempts.length} running execution attempt(s)`);
      }

      const deliveries = await this.repos.deliveries.findByAssignmentId(asgn.id);
      const pendingDeliveries = deliveries.filter((d) => ['pending', 'delivering'].includes(d.status));
      if (pendingDeliveries.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${pendingDeliveries.length} in-flight delivery attempt(s)`);
      }

      const handoffs = await this.repos.handoffs.findByAssignmentId(asgn.id);
      const pendingHandoffs = handoffs.filter((h) => ['pending', 'ready'].includes(h.status));
      if (pendingHandoffs.length > 0) {
        reasons.push(`Assignment '${asgn.title}' has ${pendingHandoffs.length} pending handoff(s) awaiting delivery`);
      }
    }

    return {
      canDelete: reasons.length === 0,
      reasons,
    };
  }

  public async deletePair(id: PairId): Promise<void> {
    const check = await this.canDeletePair(id);
    if (!check.canDelete) {
      throw new RelayDomainError(
        `Cannot delete pair: active dependencies exist (${check.reasons.join('; ')}). Archive the pair instead.`,
        'ACTIVE_WORK_GUARD',
      );
    }
    const pair = await this.repos.pairs.findById(id);
    if (!pair) throw new RelayDomainError(`Pair ${id} not found`, 'NOT_FOUND');

    await this.repos.pairs.delete(id);

    await this.emitEvent('pair', id, 'pair.deleted', {
      actor: 'user',
      previousState: pair.status,
      newState: 'deleted',
      details: { name: pair.name, projectId: pair.projectId },
    });
  }

  public async canDeleteRuntimeSession(sessionId: RuntimeSessionId): Promise<{ canDelete: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const runtime = await this.repos.runtimes.findById(sessionId);
    if (!runtime) return { canDelete: false, reasons: ['Runtime session not found'] };

    if (runtime.status === 'working') {
      reasons.push(`Runtime '${runtime.name}' is currently working on an assignment`);
    }

    const pairs = await this.repos.pairs.findAll();
    const pairsUsingRuntime = pairs.filter(
      (p) => p.plannerSessionId === sessionId || p.workerSessionId === sessionId,
    );
    if (pairsUsingRuntime.length > 0) {
      const activePairs: Pair[] = [];
      for (const p of pairsUsingRuntime) {
        if (p.status === 'active' || (await this.hasActiveWork(p))) {
          activePairs.push(p);
        }
      }
      if (activePairs.length > 0) {
        reasons.push(`Runtime is currently attached to active pair '${activePairs[0].name}'`);
      } else {
        reasons.push(`Runtime is currently attached to pair '${pairsUsingRuntime[0].name}'. Detach it before deleting.`);
      }
    }

    const activeAssignments = await this.repos.assignments.findActive();
    for (const asgn of activeAssignments) {
      const deliveries = await this.repos.deliveries.findByAssignmentId(asgn.id);
      const activeDeliveries = deliveries.filter(
        (d) => d.targetRuntimeId === sessionId && ['pending', 'delivering'].includes(d.status),
      );
      if (activeDeliveries.length > 0) {
        reasons.push(`Runtime is target of ${activeDeliveries.length} in-flight deliveries`);
      }
    }

    return {
      canDelete: reasons.length === 0,
      reasons,
    };
  }

  public async detachRuntime(sessionId: RuntimeSessionId): Promise<{ success: boolean; detachedFromPairs: string[] }> {
    const pairs = await this.repos.pairs.findAll();
    const affected = pairs.filter((p) => p.plannerSessionId === sessionId || p.workerSessionId === sessionId);

    const activePairs: Pair[] = [];
    for (const p of affected) {
      if (p.status === 'active' || (await this.hasActiveWork(p))) {
        activePairs.push(p);
      }
    }
    if (activePairs.length > 0) {
      throw new RelayDomainError(
        `Cannot detach runtime: Pair '${activePairs[0].name}' has active work in progress. Pause or complete work first.`,
        'ACTIVE_WORK_GUARD',
      );
    }

    const detachedFromPairs: string[] = [];
    for (const pair of affected) {
      let role: 'planner' | 'worker' = 'planner';
      if (pair.plannerSessionId === sessionId) {
        pair.plannerSessionId = undefined;
        role = 'planner';
      }
      if (pair.workerSessionId === sessionId) {
        pair.workerSessionId = undefined;
        role = 'worker';
      }
      pair.updatedAt = Date.now();
      await this.repos.pairs.save(pair);
      detachedFromPairs.push(pair.id);

      await this.emitEvent('runtime', sessionId, 'runtime.detached', {
        actor: 'user',
        details: { pairId: pair.id, role, runtimeSessionId: sessionId },
      });
      await this.emitEvent('pair', pair.id, 'pair.updated', {
        actor: 'user',
        details: { detachedRuntimeSessionId: sessionId, role },
      });
    }

    return { success: true, detachedFromPairs };
  }

  public async deleteRuntimeSession(sessionId: RuntimeSessionId): Promise<void> {
    const check = await this.canDeleteRuntimeSession(sessionId);
    if (!check.canDelete) {
      throw new RelayDomainError(
        `Cannot delete runtime session: active dependencies exist (${check.reasons.join('; ')}). Detach or archive pairs first.`,
        'ACTIVE_WORK_GUARD',
      );
    }

    // Detach from any non-active pairs first
    await this.detachRuntime(sessionId);

    const runtime = await this.repos.runtimes.findById(sessionId);
    if (!runtime) throw new RelayDomainError(`Runtime session ${sessionId} not found`, 'NOT_FOUND');

    await this.repos.runtimes.delete(sessionId);

    await this.emitEvent('runtime', sessionId, 'runtime.deleted', {
      actor: 'user',
      previousState: runtime.status,
      newState: 'deleted',
      details: { name: runtime.name, providerType: runtime.providerType },
    });
  }

  public async archiveRuntimeSession(id: RuntimeSessionId, reason?: string): Promise<RuntimeSession> {
    const runtime = await this.repos.runtimes.findById(id);
    if (!runtime) throw new RelayDomainError(`Runtime session ${id} not found`, 'NOT_FOUND');

    const previousStatus = runtime.status;
    runtime.archive(reason);
    await this.repos.runtimes.save(runtime);

    await this.emitEvent('runtime', id, 'runtime.archived', {
      actor: 'user',
      previousState: previousStatus,
      newState: 'archived',
      details: { reason },
    });
    return runtime;
  }

  /**
   * S6 CLOSURE — unarchive is a LOCAL record change plus a best-effort re-check.
   *
   * The local part (unarchive the row, emit `runtime.updated`) is performed FIRST
   * and unconditionally, because archiving and unarchiving are established
   * standalone runtime operations that exist independently of any Pair. Gating the
   * whole method on Pair state would make an IDLE Pair's runtime permanently
   * un-unarchivable, which is Case C's failure mode.
   *
   * The provider re-check that follows is the part that must obey I-2, and it is
   * gated by `reconcileAndRecoverRuntime` through the single shared guard.
   *
   * ## A refusal here is a PARTIAL result, and is reported as one
   *
   * The local unarchive has already been committed when the gate refuses. Throwing
   * the gate's own message verbatim would imply the unarchive failed, which would be
   * false — a caller that retried, or that rendered the row as still archived, would
   * be acting on a misreport. So the refusal is re-thrown with the SAME machine
   * code (callers still classify on it) and a message that states what did and did
   * not happen. The Pair is not activated, and no provider was contacted.
   */
  public async unarchiveRuntimeSession(id: RuntimeSessionId): Promise<RuntimeSession> {
    const runtime = await this.repos.runtimes.findById(id);
    if (!runtime) throw new RelayDomainError(`Runtime session ${id} not found`, 'NOT_FOUND');

    runtime.unarchive();
    await this.repos.runtimes.save(runtime);

    await this.emitEvent('runtime', id, 'runtime.updated', {
      actor: 'user',
      previousState: 'archived',
      newState: 'unknown',
    });

    // Immediate re-check of the real external session.
    //
    // I-2 GATE: the re-check is provider contact, and `reconcileAndRecoverRuntime`
    // refuses it for a Pair that is IDLE. That refusal MUST NOT be swallowed.
    // A bare catch here would turn the gate into a silent no-op: the unarchive
    // would report success while quietly contacting nothing, which is the exact
    // dishonesty I-2 exists to prevent. The refusal is re-thrown so the caller
    // learns the Pair must be activated first; any other failure stays
    // best-effort, because unarchiving is a local record change and its own
    // success does not depend on the external re-check succeeding.
    //
    // BOTH denial codes are re-thrown, including the fail-closed ambiguous-ownership
    // refusal. Swallowing that one would be worse than swallowing the IDLE case: it
    // would mean silently proceeding with no defensible owner.
    try {
      await this.reconcileAndRecoverRuntime(id);
    } catch (err: any) {
      const code = err?.code;
      if (code === RUNTIME_PAIR_NOT_ACTIVE || code === RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS) {
        throw new RelayDomainError(
          `Runtime ${id} was unarchived locally, but its external re-check was refused: ` +
            `${err.message} The unarchive is saved; the external state remains last-known evidence only, ` +
            'and the Pair was NOT activated.',
          code,
        );
      }
      // ignore: best-effort external re-check
    }

    return runtime;
  }

  /* --- Assignment Lifecycle & Safe Delivery --- */

  /**
   * TERMINAL Assignment states — a terminal Assignment no longer owns an execution slot.
   *
   * `pending` is deliberately NOT terminal: a `pending` Assignment is a live, dispatchable
   * unit of work, and two of them competing for one Pair's single execution slot is exactly
   * the orphan condition this invariant exists to prevent. `waiting_for_handoff` is equally
   * non-terminal: the work is finished but the Pair has not been released, so the slot is
   * still held.
   */
  private static readonly TERMINAL_ASSIGNMENT_STATES: ReadonlySet<AssignmentStatus> = new Set<AssignmentStatus>([
    'completed',
    'failed',
    'cancelled',
  ]);

  /**
   * The Attention type for "continuity recovery threw for this Pair".
   *
   * A named constant rather than a repeated literal, because the raise path and the resolve
   * path must agree on the exact string or an incident could never be closed.
   */
  private static readonly CONTINUITY_RECOVERY_FAILURE = 'continuity_recovery_failed';

  private async hasActiveWork(pair: Pair): Promise<boolean> {
    if (!pair.activeAssignmentId) return false;
    const assignment = await this.repos.assignments.findById(pair.activeAssignmentId);
    if (assignment && !RelayEngine.TERMINAL_ASSIGNMENT_STATES.has(assignment.status)) {
      return true;
    }
    pair.clearWork();
    await this.repos.pairs.save(pair);
    return false;
  }

  /**
   * Create a new Assignment for a Pair.
   *
   * Creating a `pending` Assignment does not take the Pair's execution slot, so this is
   * legal even while another Assignment is active — a Pair may legitimately have a backlog.
   * What it must NOT do is *silently* become the active owner; that is `pair.assignWork`,
   * reached only from `dispatchAssignment`, which enforces `assertExecutionSlotAvailable`.
   *
   * The rejection that belongs here is a `cancelled`/`failed`/completed Pair: a terminal
   * Assignment is not a legitimate target for new work, and silently accepting one would
   * produce an Assignment that can never be dispatched and can never resolve.
   */
  public async createAssignment(
    pairId: PairId,
    title: string,
    instruction: string,
  ): Promise<Assignment> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const current = pair.activeAssignmentId
      ? await this.repos.assignments.findById(pair.activeAssignmentId)
      : null;
    if (current && RelayEngine.TERMINAL_ASSIGNMENT_STATES.has(current.status)) {
      // A terminal Assignment should not be holding the slot. Repair it here rather than
      // refusing, because the refusal would be a dead end: the operator's intent (new work)
      // is legitimate and the stale slot is the actual defect.
      pair.clearWork();
      await this.repos.pairs.save(pair);
      await this.emitEvent('pair', pair.id, 'pair.assignment_slot_released', {
        actor: 'engine',
        previousState: current.status,
        newState: 'idle',
        details: {
          reason: 'The active Assignment was already terminal; the execution slot was released.',
          releasedAssignmentId: current.id,
        },
      });
    }

    const assignment = Assignment.create(pairId, pair.projectId, title, instruction);
    await this.repos.assignments.save(assignment);

    await this.emitEvent('assignment', assignment.id, 'assignment.created', {
      actor: 'user',
      newState: assignment.status,
      details: { title, pairId },
    });

    return assignment;
  }

  /**
   * Atomically create an Assignment AND claim the Pair's execution slot.
   *
   * ## Scope (read this before assuming it sends anything)
   *
   * This is a pure database operation. It does NOT contact a provider and does
   * NOT deliver anything. It is the first half of the application-level
   * `createAndDispatchAssignment` orchestration, which subsequently calls the
   * ordinary `dispatchAssignment` path for the external send. The name is
   * deliberately precise: "create-and-dispatch" would wrongly imply that external
   * delivery is transactionally atomic too, which it cannot be.
   *
   * ## The defect this closes
   *
   * `createAssignment` (backlog creation) and `dispatchAssignment` are two
   * independent durable operations. The Create & Dispatch flow used to run them
   * in that order, so a Pair that already owned an unresolved active Assignment
   * produced a durable `pending` Assignment and only THEN hit the execution-slot
   * guard at dispatch — an orphan that could never obtain the slot.
   *
   * ## Why this is atomic
   *
   * The same authority gates that dispatch enforces are evaluated HERE, inside a
   * single transaction, BEFORE the Assignment is durable:
   *   - `assertContactPermitted` (I-2) — an IDLE Pair creates nothing;
   *   - `assertExecutionSlotAvailable` — an occupied slot creates nothing.
   *
   * The transaction then claims the slot (`pair.assignWork`) atomically with the
   * create, so two concurrent callers cannot both create: the second sees the
   * first as the slot holder and is refused before it writes. The returned state
   * (`pending` Assignment owning the slot, no Attempt, no Delivery) is a coherent,
   * recoverable intermediate — the caller starts delivery next, via the normal
   * `dispatchAssignment` path.
   *
   * A plain `createAssignment` keeps its documented backlog semantics; the
   * execution-slot authority itself is unchanged.
   */
  public async createAssignmentAndClaimExecutionSlot(
    pairId: PairId,
    title: string,
    instruction: string,
    context: AuthorityContext = 'OPERATOR_EXPLICIT',
  ): Promise<Assignment> {
    return this.repos.runInTransaction(async () => {
      const pair = await this.repos.pairs.findById(pairId);
      if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

      // Same I-2 gate dispatch enforces — evaluated before anything is durable.
      pair.assertContactPermitted(context);

      const created = Assignment.create(pairId, pair.projectId, title, instruction);

      // Same execution-slot authority dispatch enforces — a non-terminal holder
      // is refused here, so no Assignment is created.
      await this.assertExecutionSlotAvailable(pair, created);

      await this.repos.assignments.save(created);
      pair.assignWork(created.id);
      await this.repos.pairs.save(pair);

      await this.emitEvent('assignment', created.id, 'assignment.created', {
        actor: 'user',
        newState: created.status,
        details: { title, pairId },
      });

      return created;
    });
  }

  /**
   * EXECUTION-SLOT INVARIANT — at most ONE unresolved Assignment owns a Pair's work.
   *
   * ## What the invariant is
   *
   * `Pair.activeAssignmentId` is the Pair's single execution slot. At most one Assignment
   * with a non-terminal status may hold it. Two holders mean two Assignments each believe
   * they own the Pair's work, and the newer one silently overwrote the older one at the
   * moment of dispatch — which is how an Assignment ends up orphaned while still `active`.
   *
   * ## Why dispatch enforces it rather than trusting the caller
   *
   * `pair.assignWork()` is an unconditional setter, so nothing stopped dispatch B from
   * overwriting `activeAssignmentId` while dispatch A's Assignment was still `active`. The
   * orphan was then invisible: A still reported `active` with its own `currentAttemptId`, and
   * the Pair pointed at B. This check is placed inside the Phase-1 transaction, before any
   * durable intent is written, so a refusal leaves no partial record.
   *
   * Re-dispatching the SAME Assignment is always allowed: the slot is already its own, and
   * retrying through the existing lifecycle is exactly the point.
   */
  private async assertExecutionSlotAvailable(pair: Pair, assignment: Assignment): Promise<void> {
    if (!pair.activeAssignmentId || pair.activeAssignmentId === assignment.id) return;

    const holder = await this.repos.assignments.findById(pair.activeAssignmentId);
    if (!holder) {
      // Dangling pointer to a Assignment that no longer exists. The Pair cannot keep
      // claiming an owner that is gone, and refusing here would deadlock the Pair forever.
      // Released with an event so the repair is visible, not silent.
      pair.clearWork();
      await this.repos.pairs.save(pair);
      await this.emitEvent('pair', pair.id, 'pair.assignment_slot_released', {
        actor: 'engine',
        previousState: 'missing',
        newState: 'idle',
        details: {
          reason: 'The active Assignment id pointed at a record that no longer exists.',
          danglingAssignmentId: this.currentSlotId(pair),
        },
      });
      return;
    }

    if (RelayEngine.TERMINAL_ASSIGNMENT_STATES.has(holder.status)) {
      // Terminal holder: releasing the slot is a legal, explicit transition.
      pair.clearWork();
      await this.repos.pairs.save(pair);
      await this.emitEvent('pair', pair.id, 'pair.assignment_slot_released', {
        actor: 'engine',
        previousState: holder.status,
        newState: 'idle',
        details: { releasedAssignmentId: holder.id, reason: 'The previous slot holder is terminal.' },
      });
      return;
    }

    throw new RelayDomainError(
      `Pair ${pair.id} already has an unresolved active Assignment (${holder.id}, status=${holder.status}) ` +
      `holding the execution slot. Dispatching ${assignment.id} would silently orphan ${holder.id}. ` +
      `Retry the active Assignment, or explicitly transition it (complete / fail / cancel) or run ` +
      `reconcilePairAssignmentAuthority(${pair.id}) before dispatching new work.`,
      'PAIR_ACTIVE_ASSIGNMENT_EXISTS',
    );
  }

  /** The Pair's current execution-slot holder, before any repair in this call clears it. */
  private currentSlotId(pair: Pair): string | null {
    return pair.activeAssignmentId ?? null;
  }

  /**
   * Provider setting keys, namespaced per provider type.
   *
   * Namespacing is what keeps a setting for one provider from being silently applied to
   * another: a model reference is only meaningful for the provider it names.
   */
  public static providerSettingKey(
    providerType: ProviderType,
    name: 'transportModel',
  ): string {
    return `${providerType}.${name}`;
  }

  /**
   * The explicit, operator-set model override for a provider's transport, or `null`.
   *
   * ## Why there is no default here
   *
   * Returning a built-in model name would make RelayX a silent participant in model
   * selection: deliveries would be served by something no operator chose, and the evidence
   * would say only "space-bunny-free" with no record of who picked it. Instead an unset
   * setting means the provider's own configuration decides, and the delivery evidence says
   * exactly that (`modelSelectionSource: 'opencode_default_model'`).
   *
   * A malformed or empty value is treated as UNSET rather than passed through, because a
   * half-specified `provider/` reference would fail at the provider and the resulting error
   * would read as a provider fault rather than a configuration fault.
   */
  public static getSupportedModels(providerType: ProviderType): string[] {
    if (providerType === 'opencode') {
      return [
        'opencode-zen/free-default',
        'openrouter/free',
        'thinking-machines/inkling:free',
        'thinking-machines/inkling-small:free',
        'nvidia/nemotron-3-ultra:free',
        'nvidia/nemotron-3.5-lightning:free',
        'poolside/laguna-s-2.1:free',
        'poolside/laguna-xs-2.1:free',
        'cohere/north-mini-code:free',
        'google/gemini-2.5-flash:free',
      ];
    }
    if (providerType === 'chatgpt') {
      return ['openai/gpt-4o', 'openai/o3-mini', 'openai/o1'];
    }
    return [];
  }

  public async resolveEffectiveModelConfig(
    providerType: ProviderType,
    projectId?: ProjectId,
    pairId?: PairId,
  ): Promise<{
    providerType: ProviderType;
    globalDefault: string | null;
    projectOverride: string | null;
    pairOverride: string | null;
    effectiveModel: string;
    isProjectOverride: boolean;
    isPairOverride: boolean;
    justification?: string | null;
    supportedModels: string[];
  }> {
    const allSupported = RelayEngine.getSupportedModels(providerType);
    const freeOnly = allSupported.filter((m: string) => /(?:free|free-default)/i.test(m) || m === 'opencode-zen/free-default');
    const supportedModels = freeOnly.length ? freeOnly : allSupported;
    const globalSetting = await this.repos.providerSettings.get(
      RelayEngine.providerSettingKey(providerType, 'transportModel'),
    );
    const globalDefault = globalSetting?.value || null;

    let projectOverride: string | null = null;
    let justification: string | null = null;
    if (projectId) {
      const projSetting = await this.repos.providerSettings.get(
        `${providerType}:project:${projectId}:transportModel`,
      );
      if (projSetting && projSetting.value.trim()) {
        projectOverride = projSetting.value.trim();
        justification = projSetting.note || null;
      }
    }

    let pairOverride: string | null = null;
    let pairJustification: string | null = null;
    if (pairId) {
      const pairSetting = await this.repos.providerSettings.get(
        `${providerType}:pair:${pairId}:transportModel`,
      );
      if (pairSetting && pairSetting.value.trim()) {
        pairOverride = pairSetting.value.trim();
        pairJustification = pairSetting.note || null;
      }
    }

    // Narrowest scope wins: pair > project > global > first supported free model.
    const effectiveModel = pairOverride || projectOverride || globalDefault || supportedModels[0] || 'default';
    const isPairOverride = Boolean(pairOverride);
    const isProjectOverride = Boolean(projectOverride);

    return {
      providerType,
      globalDefault,
      projectOverride,
      pairOverride,
      effectiveModel,
      isProjectOverride,
      isPairOverride,
      justification: pairJustification ?? justification,
      supportedModels,
    };
  }

  public async setProjectModelOverride(
    projectId: ProjectId,
    providerType: ProviderType,
    model: string,
    justification: string,
  ): Promise<ProviderSetting | null> {
    const key = `${providerType}:project:${projectId}:transportModel`;
    return this.setProviderSetting(key, model, { note: justification, setBy: 'operator' });
  }

  public async clearProjectModelOverride(
    projectId: ProjectId,
    providerType: ProviderType,
  ): Promise<void> {
    const key = `${providerType}:project:${projectId}:transportModel`;
    await this.setProviderSetting(key, '', { note: 'Cleared project override', setBy: 'operator' });
  }

  /**
   * Persist a pair-scoped worker model.
   *
   * This is the SAME provider_settings authority as the global and project
   * overrides — a third scope, not a third authority. Writing it makes NO
   * provider contact: it is a RelayX-owned row that the delivery boundary reads
   * later, so it is legal while the Pair is IDLE.
   */
  public async setPairModelOverride(
    pairId: PairId,
    providerType: ProviderType,
    model: string,
    justification: string,
  ): Promise<ProviderSetting | null> {
    const key = `${providerType}:pair:${pairId}:transportModel`;
    return this.setProviderSetting(key, model, { note: justification, setBy: 'operator' });
  }

  public async clearPairModelOverride(
    pairId: PairId,
    providerType: ProviderType,
  ): Promise<void> {
    const key = `${providerType}:pair:${pairId}:transportModel`;
    await this.setProviderSetting(key, '', { note: 'Cleared pair override', setBy: 'operator' });
  }

  public async resolveProviderModelOverride(
    providerType: ProviderType,
    projectId?: ProjectId,
    pairId?: PairId,
  ): Promise<string | null> {
    const allSupported = RelayEngine.getSupportedModels(providerType);
    // Narrow: only verified free-tier candidates allowed for automatic fallback.
    const freeOnly = allSupported.filter((m: string) =>
      /(?:free|free-default)/i.test(m) || m === 'opencode-zen/free-default',
    );
    const supported = freeOnly.length ? freeOnly : allSupported;

    const readSupported = async (key: string): Promise<string | null> => {
      const setting = await this.repos.providerSettings.get(key);
      if (setting && setting.value.trim()) {
        const val = setting.value.trim();
        if (supported.includes(val)) return val;
      }
      return null;
    };

    // 1. Explicit pair-specific override (narrowest scope), IF supported.
    const pairValue = pairId
      ? await readSupported(`${providerType}:pair:${pairId}:transportModel`)
      : null;
    // 2. Explicit project-specific override, IF supported.
    const projectValue = projectId
      ? await readSupported(`${providerType}:project:${projectId}:transportModel`)
      : null;
    // 3. Engine Settings global Worker AI Model (authoritative when no narrower override).
    const globalValue = await readSupported(
      RelayEngine.providerSettingKey(providerType, 'transportModel'),
    );
    // 4. No hidden/legacy setting may silently supersede visible Engine Settings.
    // If every configured scope is unsupported, fall back to the first supported free model.
    const effective = pairValue || projectValue || globalValue || (supported.length ? supported[0] : null);
    return effective;
  }

  /** Read one provider setting, or `null` when unset. */
  public async getProviderSetting(key: string): Promise<ProviderSetting | null> {
    return this.repos.providerSettings.get(key);
  }

  /** Read every provider setting, for operator visibility. */
  public async listProviderSettings(): Promise<ProviderSetting[]> {
    return this.repos.providerSettings.list();
  }

  /**
   * Set an explicit provider setting, with an event.
   *
   * An empty value CLEARS the setting rather than storing a blank: there is no such thing as
   * a set-but-empty model, and storing one would make `listProviderSettings` lie. Clearing
   * returns `null` and records the change, so "we stopped overriding" is as auditable as
   * "we started overriding".
   */
  public async setProviderSetting(
    key: string,
    value: string,
    opts: { setBy?: string; note?: string } = {},
  ): Promise<ProviderSetting | null> {
    const trimmed = value.trim();
    const previous = await this.repos.providerSettings.get(key);
    // The event actor vocabulary is a closed set; an operator action IS a user action, and
    // the operator's own identity is preserved in `setBy`/`details` rather than being forced
    // into an actor enum that has no member for it.
    const actor = (opts.setBy === 'recovery' || opts.setBy === 'engine' ? opts.setBy : 'user') as
      | 'user'
      | 'recovery'
      | 'engine';
    const setBy = opts.setBy ?? 'operator';

    if (trimmed.length === 0) {
      if (!previous) return null;
      await this.repos.providerSettings.delete(key);
      await this.emitEvent('pair', key as unknown as PairId, 'provider.setting_cleared', {
        actor,
        previousState: previous.value,
        details: { key, note: opts.note ?? null, clearedBy: setBy },
      });
      return null;
    }

    const now = Date.now();
    const setting: ProviderSetting = {
      key,
      value: trimmed,
      note: opts.note ?? null,
      setBy,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await this.repos.providerSettings.save(setting);
    await this.emitEvent('pair', key as unknown as PairId, 'provider.setting_changed', {
      actor,
      previousState: previous?.value,
      newState: setting.value,
      details: { key, note: setting.note, setBy, previouslySetAt: previous?.createdAt ?? null },
    });
    return setting;
  }

  /**
   * Evaluates the archival retention policy and marks eligible historical events as archived.
   * If 'none', no events are archived. Defaults to 7 days if unset.
   */
  public async runArchiveCycle(): Promise<{ archivedCount: number; cutoffTimestamp: number; interval: string }> {
    const setting = await this.getProviderSetting('policy:archiveInterval');
    const interval = setting?.value ?? '7d';

    if (interval === 'none') {
      return { archivedCount: 0, cutoffTimestamp: 0, interval: 'none' };
    }

    let days = 7;
    if (interval.endsWith('d')) {
      const parsed = parseInt(interval, 10);
      if (!isNaN(parsed) && parsed > 0) days = parsed;
    } else if (interval.endsWith('h')) {
      const parsed = parseInt(interval, 10);
      if (!isNaN(parsed) && parsed > 0) days = parsed / 24;
    }

    const cutoffTimestamp = Date.now() - (days * 24 * 60 * 60 * 1000);
    const archivedCount = await this.repos.events.archiveOlderThan(cutoffTimestamp);
    return { archivedCount, cutoffTimestamp, interval };
  }

  /**
   * Dispatch precondition: the worker's exact session must be PROVEN PRESENT.
   *
   * ## Why this is NOT a readiness gate
   *
   * A previous revision of this method refused the dispatch unless
   * `computePairReadiness(...).state === 'READY'`. That was wrong, and it is removed on
   * frozen-design grounds, not on convenience grounds:
   *
   * - `DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md` §8.3 `[FROZEN]`: "Readiness describes
   *   observational sufficiency. It is **not** execution permission. ... A `ready` Pair is
   *   not thereby authorized to dispatch." Gating dispatch on readiness makes readiness the
   *   execution authority, which is the exact inversion the freeze forbids.
   * - §4.3 `[FROZEN]`: "Execution still requires its own separate authorization, per
   *   `EXECUTION_AUTHORITY.md`. ACTIVE is not permission to dispatch." The real gate is the
   *   I-2 `assertProviderContactPermitted()` above plus the frozen execution authority
   *   (Attempt-bound identity), both of which are checked here.
   * - §8.2 `[FROZEN]`: a persisted readiness value "may **never** gate, permit, or enable
   *   an action." Readiness is a cache with a validity window, so it is structurally
   *   incapable of being a correct gate input.
   *
   * It was also unachievable for this Pair: the planner side is a ChatGPT browser session
   * with no message-reference capability, so `evaluateSideContinuity` returns `unknown` for
   * it forever, Pair continuity can never leave `UNKNOWN`, and readiness can never reach
   * `READY`. The gate therefore made dispatch permanently impossible for every Pair with a
   * Level-0 planner — it did not enforce the freeze, it disabled the product.
   *
   * ## What is enforced instead
   *
   * The one evidence-backed negative that genuinely blocks a dispatch: a side whose exact
   * session was observed `absent` in the provider's own store. That is a completed read
   * with a negative result, so a send is a write into a session that provably does not
   * exist. `unknown` does NOT block, because an unreadable or unmeasured dimension is honest
   * degradation rather than a defect (I-6).
   */
  private async assertDispatchTargetPresent(pair: Pair, assignment: Assignment): Promise<void> {
    const targetSessionId = assignment.targetSideRole === 'planner'
      ? pair.plannerSessionId
      : pair.workerSessionId;
    if (!targetSessionId) return;
    const identity = await this.repos.sideIdentities.find(pair.id, assignment.targetSideRole);
    if (identity && identity.existenceState === 'absent') {
      const observedAt = identity.observation?.observedAt ?? null;
      throw new RelayDomainError(
        `Assignment ${assignment.id} cannot be dispatched: the ${assignment.targetSideRole}'s exact session ` +
        `(${identity.externalSessionId ?? 'unbound'}) was observed ABSENT in the provider's own store` +
        `${observedAt ? ` on ${new Date(observedAt).toISOString()}` : ' (observation time not recorded)'}. ` +
        `A delivery into an absent session is a blind write. Re-verify the side before dispatching.`,
        'DISPATCH_TARGET_ABSENT',
      );
    }
  }

  /**
   * Compute the current RecoveryState for a Pair by inspecting durable Assignment/Delivery evidence.
   *
   * Recovery lifecycle:
   *   required → planner_intervention → planner_decided → continuation_authorized → resolved
   *
   * Each phase is driven by durable observed evidence:
   *   - ingress delivery CREATED but not confirmed → still 'required'
   *   - ingress delivery CONFIRMED → 'planner_intervention'
   *   - planner decision Assignment observed → 'planner_decided'
   *   - relay engine authorized continuation → 'continuation_authorized'
   *   - continuation delivery CONFIRMED dispatched → 'resolved'
   *
   * Trigger delivery, Planner-ingress delivery, Planner decision assignment,
   * and Planner→Worker continuation delivery are separate durable identities.
   */
  private async getCurrentRecoveryState(pairId: PairId): Promise<RecoveryState | null> {
    const assignments = await this.repos.assignments.findByPairId(pairId);
    // A recovery episode is keyed to the recovery NOTICE delivery via
    // sourceRecoveryDeliveryId. Only a non-undefined value marks a genuine
    // recovery Assignment — handoff-derived assignments use sourceHandoffId and
    // ordinary work is unflagged.
    const recoveryAssignments = assignments.filter(a =>
      a.sourceRecoveryDeliveryId !== undefined && a.sourceRecoveryDeliveryId !== null,
    );

    if (recoveryAssignments.length === 0) {
      return null;
    }

    // Find the active (non-resolved) recovery episode, preferring the most recent
    const activeRecovery = recoveryAssignments
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .find(a => a.status === 'pending' || a.status === 'delivering');

    if (!activeRecovery) {
      // All recovery assignments are terminal → recovery is resolved
      const latestResolved = recoveryAssignments
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return {
        episodeId: latestResolved.id,
        phase: 'resolved',
        initiatedAt: latestResolved.createdAt,
        triggerDeliveryId: latestResolved.sourceRecoveryDeliveryId,
        recoveryAssignmentId: latestResolved.id,
        continuationDispatchedAt: latestResolved.completedAt,
      };
    }

    // Build recovery state from durable evidence
    const triggerDeliveryId = activeRecovery.sourceRecoveryDeliveryId!;
    const recoveryAssignmentId = activeRecovery.id;
    const initiatedAt = activeRecovery.createdAt;

    // Check if the recovery notice delivery is confirmed delivered
    const recoveryDelivery = activeRecovery.activeDeliveryId
      ? await this.repos.deliveries.findById(activeRecovery.activeDeliveryId)
      : null;

    const state: RecoveryState = {
      episodeId: recoveryAssignmentId,
      phase: 'required',
      initiatedAt,
      triggerDeliveryId,
      recoveryAssignmentId,
    };

    if (!recoveryDelivery) {
      return state; // required — delivery not yet created
    }

    // Ingress delivery exists
    const ingressState = recordRecoveryIngressDeliveryCreated(state, recoveryDelivery.id);

    // Check if ingress delivery is confirmed
    if (recoveryDelivery.status === 'delivered') {
      // Ingress confirmed → planner_intervention
      const interventionState = recordRecoveryIngressConfirmed(
        ingressState,
        recoveryDelivery.deliveredAt ?? initiatedAt
      );

      // R8: Check if a concrete Planner decision Assignment exists for this episode
      // A Planner decision is represented by a child Assignment whose sourceRecoveryDeliveryId
      // points to the recovery notice delivery, AND that Assignment has been dispatched.
      const plannerDecisions = assignments.filter(
        a => a.sourceRecoveryDeliveryId === recoveryDelivery.id
      );

      if (plannerDecisions.length > 0) {
        // Planner decision observed → planner_decided
        const decision = plannerDecisions[0];
        const decidedState = recordPlannerDecision(
          interventionState,
          decision.id,
          decision.createdAt
        );

        // Check if continuation was explicitly authorized by relay engine
        // (via authorizeContinuation call, recorded as a special event)
        // For now, we check if a continuation delivery exists that is confirmed dispatched
        if (decision.activeDeliveryId) {
          const continuationDelivery = await this.repos.deliveries.findById(decision.activeDeliveryId);
          if (continuationDelivery && continuationDelivery.status === 'delivered') {
            // Continuation authorized and dispatched → resolved
            const withContinuation = recordContinuationDeliveryCreated(decidedState, continuationDelivery.id);
            return recordContinuationDispatched(
              withContinuation,
              continuationDelivery.deliveredAt ?? decidedState.initiatedAt
            );
          } else if (continuationDelivery && continuationDelivery.status === 'delivering') {
            // Continuation in progress — check if we have explicit authorization
            return authorizeContinuation(decidedState, decidedState.initiatedAt);
          }
        }

        // Planner decided, but no continuation yet
        return decidedState;
      }

      // Ingress confirmed, but no planner decision yet
      return interventionState;
    }

    // Ingress delivery not yet confirmed
    return ingressState;
  }

  /**
   * Continuation guard: validate that a relay continuation dispatch during recovery
   * is only permitted when recovery phase is CONTINUATION_AUTHORIZED and
   * the continuation is Planner → Worker.
   *
   * This is the lowest shared relay-advance/dispatch boundary.
   * Enforcement here protects supervision, restart, resume, queued dispatch, etc.
   */
  private async assertRecoveryContinuationAuthorized(
    assignment: Assignment,
    context: AuthorityContext,
    trail: string[],
  ): Promise<void> {
    const recovery = await this.getCurrentRecoveryState(assignment.pairId);
    if (!recovery || recovery.phase === 'resolved') {
      // No active recovery or resolved — defer to normal baton authority
      return;
    }

    // Determine if this assignment is part of a recovery episode
    const isRecoveryAssignment = assignment.sourceRecoveryDeliveryId !== null;

    if (isRecoveryAssignment) {
      // This IS a recovery assignment — validate the recovery operation
      // Recovery assignments go Planner side (the recovery notice), then
      // the continuation assignment goes Worker side
      const operation: RecoveryOperation = assignment.targetSideRole === 'planner'
        ? { kind: 'recovery_ingress', destination: 'planner' }
        : { kind: 'relay_continuation', from: 'planner', to: 'worker' };

      const auth = validateRecoveryOperation(recovery, operation);

      if (auth.decision === 'deny') {
        trail.push(`RECOVERY GUARD DENY: ${auth.reason}`);
        throw new RelayDomainError(
          `Recovery continuation blocked: ${auth.reason}`,
          'RECOVERY_CONTINUATION_DENIED',
        );
      }
      // 'allow' or 'defer_to_normal_authority' — both pass through
      trail.push(`RECOVERY GUARD allow: ${auth.reason}`);
      return;
    }

    // Non-recovery assignment dispatched during active recovery — this would be
    // a Worker-originated dispatch during recovery, which is denied (R7)
    if (assignment.targetSideRole === 'worker') {
      const operation: RecoveryOperation = {
        kind: 'relay_continuation',
        from: 'worker',
        to: 'worker',
      };

      const auth = validateRecoveryOperation(recovery, operation);
      if (auth.decision === 'deny') {
        trail.push(`RECOVERY GUARD DENY (worker dispatch during recovery): ${auth.reason}`);
        throw new RelayDomainError(
          `Recovery continuation blocked: ${auth.reason}`,
          'RECOVERY_CONTINUATION_DENIED',
        );
      }
    }
  }

  /**
   * Dispatch precondition: the worker session must be bound to an identity that exists.
   */
  public async dispatchAssignment(
    assignmentId: AssignmentId,
    context: AuthorityContext = 'OPERATOR_EXPLICIT',
  ): Promise<{
    assignment: Assignment;
    attempt: Attempt;
    delivery: Delivery;
  }> {
    // NOTE: pre-dispatch reconciliation is deliberately NOT done here.
    //
    // `dispatchAssignment` is the generic send primitive, and T6 in core_slice1 pins its
    // contract: given a stranded `delivering` record, it MUST refuse with
    // DuplicateDeliveryAttemptError and MUST NOT call the provider. Reconciling inline
    // would rewrite that record to a terminal state first and change a pinned contract.
    //
    // Reconciliation instead runs at the two points where new work is actually selected:
    // `recoverOnStartup` (before any runtime observation) and `dispatchPlanFirstUnit`
    // (before a Plan-First unit is sent). Both are engine-level, not controller-level.

    // ---- Recovery continuation guard (§RECOVERY_FREEZE) ----
    // Enforcement at the lowest shared relay-advance/dispatch boundary.
    // This protects supervision, restart, resume, queued dispatch, retry/reconciliation,
    // and any future producer that dispatches Assignments.
    const guardTrail: string[] = [];
    const assignmentForGuard = await this.repos.assignments.findById(assignmentId);
    if (assignmentForGuard) {
      await this.assertRecoveryContinuationAuthorized(assignmentForGuard, context, guardTrail);
    }
    // ---- Phase 1: durable dispatch intent, COMMITTED before the external send ----
    // ATTEMPT_LIFECYCLE.md Case 1: if RelayX crashes during the provider call, the
    // prepared Attempt + delivering Delivery must already be durable, so recovery can
    // reconcile intent against external state instead of blindly resending.
    const { assignment, pair, worker, attempt, delivery, idempotencyKey } =
      await this.repos.runInTransaction(async () => {
      const assignment = await this.repos.assignments.findById(assignmentId);
      if (!assignment) throw new RelayDomainError(`Assignment ${assignmentId} not found`, 'NOT_FOUND');

      const pair = await this.repos.pairs.findById(assignment.pairId);
      if (!pair) throw new RelayDomainError(`Pair ${assignment.pairId} not found`, 'PAIR_NOT_FOUND');

      // I-2 GATE — ARMED (S6). §11.5: every provider contact is gated on
      // authority determined by CALL CONTEXT (REALIGNMENT).
      // The check sits at the top of the Phase-1 transaction, BEFORE any durable
      // dispatch intent is written, so a refused dispatch leaves no partial record.
      pair.assertContactPermitted(context);

      const targetRuntimeId = assignment.targetSideRole === 'planner'
        ? pair.plannerSessionId
        : pair.workerSessionId;
      if (!targetRuntimeId) {
        throw new RelayDomainError(
          `Pair has no ${assignment.targetSideRole} runtime bound`,
          assignment.targetSideRole === 'worker' ? 'NO_WORKER_BOUND' : 'NO_PLANNER_BOUND',
        );
      }

      // `worker` is retained as a local compatibility name throughout this method;
      // semantically it is the runtime executing this Assignment, on either Pair side.
      const worker = await this.repos.runtimes.findById(targetRuntimeId);
      if (!worker) throw new RelayDomainError(
        `${assignment.targetSideRole} runtime ${targetRuntimeId} not found`,
        'NOT_FOUND',
      );

      // ---- TARGET-VALIDITY PRECONDITIONS ----
      //
      // These answer "can this dispatch be attempted at all", and they run BEFORE the
      // ownership checks below. The order is deliberate and is not cosmetic: a caller whose
      // worker runtime is terminated, or whose own previous delivery is stranded, must be
      // told THAT, because no amount of slot ownership would make their dispatch succeed.
      // Reporting a slot conflict instead would send an operator to fix the wrong thing.
      if (worker.status === 'terminated') {
        throw new RuntimeNotAvailableError(worker.id, worker.status);
      }

      // The target must be PROVEN PRESENT.
      //
      // Deliberately NOT a readiness gate. See the long note on `assertDispatchTargetPresent`
      // below for why demanding a `READY` level here would be a freeze violation.
      // What is required is one evidence-backed negative: if the worker's exact session has
      // been observed ABSENT in the provider's own store, the delivery cannot land and a
      // send would be a blind write into a session that does not exist. A merely `unknown`
      // observation is NOT sufficient and does not block: honest degradation is not a defect.
      await this.assertDispatchTargetPresent(pair, assignment);

      // Check existing deliveries for this assignment
      const existingDeliveries = await this.repos.deliveries.findByAssignmentId(assignment.id);
      const ambiguousDelivery = existingDeliveries.find((d) => d.status === 'ambiguous');
      if (ambiguousDelivery) {
        throw new AmbiguousDeliveryResendError(
          `Assignment ${assignment.id} has an ambiguous delivery (${ambiguousDelivery.id}). Automated resend blocked.`,
        );
      }

      const activeDelivery = existingDeliveries.find((d) => d.status === 'delivering');
      if (activeDelivery) {
        throw new DuplicateDeliveryAttemptError(
          `Assignment ${assignment.id} currently has an in-flight delivery (${activeDelivery.id}).`,
        );
      }

      // Create new attempt. attemptNumber must be max(existing)+1, not count+1, so a
      // retried/duplicated dispatch can never mint a colliding attempt number.
      const attempts = await this.repos.attempts.findByAssignmentId(assignment.id);
      const attemptNumber = attempts.reduce((max, a) => Math.max(max, a.attemptNumber), 0) + 1;

      // ---- EXECUTION-SLOT INVARIANT: one unresolved active Assignment owns this Pair ----
      //
      // `pair.activeAssignmentId` is the Pair's single execution slot. Two different
      // unresolved Assignments must never hold it, and a dispatch must never STEAL it: the
      // previous holder has to be transitioned explicitly, with an event, or the Pair ends
      // up with an orphan that still believes it owns the work while a newer Assignment
      // is the one actually being sent. `assertExecutionSlotAvailable` is the check;
      // `reconcilePairAssignmentAuthority` is the operation that repairs such a state.
      //
      // It sits IMMEDIATELY before `pair.assignWork(...)` — the single statement it exists to
      // guard — so it cannot drift away from the mutation it protects. The surrounding
      // `runInTransaction` rolls back on throw, so a refusal here still leaves no record:
      // no Attempt, no Delivery, no slot change.
      await this.assertExecutionSlotAvailable(pair, assignment);

      // Execution authority is frozen here, at dispatch (EXECUTION_AUTHORITY.md §1-2).
      const attempt = Attempt.create(assignment.id, attemptNumber, {
        sessionPairId: pair.id,
        workerSessionId: worker.id,
        externalSessionId: worker.externalSessionId ?? null,
      });
      await this.repos.attempts.save(attempt);

      assignment.startAttempt(attempt);
      pair.assignWork(assignment.id);
      await this.repos.pairs.save(pair);

      // Create Delivery record with idempotency key
      const idempotencyKey = `idemp_${assignment.id}_att${attemptNumber}_${Date.now()}`;
      const delivery = Delivery.create(
        assignment.id,
        attempt.id,
        worker.id,
        assignment.instruction.substring(0, 100),
        idempotencyKey,
      );
      delivery.startDelivering();
      assignment.attachDelivery(delivery);
      await this.repos.deliveries.save(delivery);
      await this.repos.assignments.save(assignment);

      await this.emitEvent('delivery', delivery.id, 'delivery.started', {
        actor: 'engine',
        previousState: 'pending',
        newState: 'delivering',
        correlationId: idempotencyKey,
      });

      return { assignment, pair, worker, attempt, delivery, idempotencyKey };
    });

    // ---- Phase 1b: the durable pre-dispatch boundary, captured from the EXACT session ----
    //
    // This MUST happen after the intent is committed (so a crash leaves a reconcilable
    // record) and MUST happen before the send (so the post-transport reconciliation can
    // tell a turn this Attempt created from one that already existed). It is committed
    // immediately as evidence, because a crash between "intent durable" and "send" has to
    // be able to classify honestly: with no boundary, the only correct verdict is
    // `ambiguous`, and that is exactly what the classifier returns for a null boundary.
    const provider = this.getProvider(worker.providerType);
    const boundary = provider.captureTransportBoundary
      ? await provider.captureTransportBoundary({
          runtimeSessionId: worker.id,
          externalSessionId: worker.externalSessionId ?? null,
        })
      : { watermark: null, failure: 'Provider exposes no transport-boundary capability.' };
    if (boundary.watermark) {
      await this.repos.runInTransaction(async () => {
        delivery.evidence = {
          id: `ev_pre_dispatch_boundary_${boundary.watermark!.capturedAt}`,
          timestamp: boundary.watermark!.capturedAt,
          source: 'reconciliation_probe',
          runtimeSessionId: worker.id,
          details: {
            phase: 'pre_dispatch_boundary',
            sessionId: boundary.watermark!.sessionId,
            messageCount: boundary.watermark!.messageCount,
            latestCreatedAt: boundary.watermark!.latestCreatedAt,
            messageIds: boundary.watermark!.messageIds,
          },
        };
        await this.repos.deliveries.save(delivery);
      });
    }

    // ---- Phase 2: external provider call, deliberately OUTSIDE the DB transaction ----
    const result = await provider.deliverInstruction({
      runtimeSessionId: worker.id,
      externalSessionId: worker.externalSessionId ?? null,
      instructionText: assignment.instruction,
      idempotencyKey,
      preDispatchWatermark: boundary.watermark,
      modelOverride: await this.resolveProviderModelOverride(worker.providerType, pair.projectId, pair.id),
    });

    // ---- Phase 3: record the outcome ----
    return this.repos.runInTransaction(async () => {
      if (result.outcome === 'delivered') {
        // Confirmed delivered via verified evidence.
        //
        // `withRecordedBoundary` keeps the Phase 1b pre-dispatch boundary alive across
        // confirmation. Without it this call would overwrite the boundary row, and the
        // Delivery would read back as boundary-less precisely because it succeeded — which
        // is the opposite of what the evidence is for.
        delivery.confirmDelivered(withRecordedBoundary(result.evidence, delivery.evidence));
        await this.repos.deliveries.save(delivery);

        // confirmDispatch(): the worker is now physically executing.
        //
        // DELIVERY AND EXECUTION ARE SEPARATE CLAIMS WITH SEPARATE OWNERS.
        //
        // Reaching this branch means only that the instruction is durably in the exact
        // session. The reconciliation may ALSO have observed what the worker did with it, and
        // that verdict belongs on the Attempt (ATTEMPT_LIFECYCLE.md Dimension A), never on the
        // Delivery. Collapsing them is the defect this code path is written to prevent: a
        // delivery that succeeded followed by a worker that died on a provider quota error is
        // a DELIVERED delivery and an INTERRUPTED attempt, and reporting it as a failed
        // delivery would send recovery looking for a resend that must never happen.
        // Execution promotion removed per freeze: delivery confirmation (`delivered`)
        // does not prove execution began (`Attempt.running` requires execution evidence).
        // The promotion mechanism (`promoteAttemptToRunning()`) must be called
        // separately when execution/completion evidence is observed.

        const execution = result.reconciliation?.workerExecution ?? null;
        const executionObserved = execution === 'in_progress' || execution === 'completed' || execution === 'terminal_error';
        if (executionObserved && attempt.status === 'prepared') {
          attempt.startRunning();
          await this.repos.attempts.save(attempt);
          await this.emitEvent('attempt', attempt.id, 'attempt.running', {
            actor: 'provider',
            previousState: 'prepared',
            newState: 'running',
            evidence: result.evidence,
            details: {
              deliveryId: delivery.id,
              workerExecution: execution,
              evidenceKind: 'exact_session_execution_reconciliation',
            },
            correlationId: idempotencyKey,
          });
        }
        if (execution === 'terminal_error') {
          // A provider-reported terminal error on the assistant turn. The closest existing
          // frozen Dimension-A state is `interrupted`: Case 5, "runtime/process lost mid-work;
          // execution suspended; repository mutations survive and are NOT rolled back". No
          // new lifecycle state is invented, and the Delivery stays `delivered`.
          const evidence = result.reconciliation!.workerExecutionEvidence;
          attempt.interrupt(
            `Worker execution terminated with provider error ` +
            `${evidence.errorType ?? 'unknown'}` +
            `${evidence.errorStatus ? ` (HTTP ${evidence.errorStatus})` : ''}` +
            `${evidence.providerId ? ` on ${evidence.providerId}/${evidence.modelId ?? 'unknown'}` : ''}: ` +
            `${evidence.errorMessage ?? 'no error message reported'}. ` +
            `The instruction WAS delivered (message ${result.reconciliation!.matchingUserTurn?.messageId ?? 'unknown'}); ` +
            `this is an execution failure, not a delivery failure.`,
            result.evidence,
          );
          await this.repos.attempts.save(attempt);

          const attention = AttentionItem.create(
            'critical',
            'worker_execution_failed',
            'Worker execution terminated after a confirmed delivery',
            `Assignment ${assignment.id} was delivered to the worker session, but the worker's ` +
            `response terminated with ${evidence.errorType ?? 'a provider error'}. ` +
            `The instruction reached the session; the work did not complete.`,
            {
              pairId: pair.id,
              assignmentId: assignment.id,
              suggestedAction:
                `Attempt ${attempt.id} was interrupted and Delivery ${delivery.id} is confirmed ` +
                `delivered: the instruction IS in the worker session, as user turn ` +
                `${result.reconciliation!.matchingUserTurn?.messageId ?? 'unknown'}. ` +
                `Re-verify the worker session, then explicitly transition this Assignment ` +
                `(retry / fail / complete). Do NOT resend blindly — the instruction is already there.`,
              suggestedTier: 'tier_1_deterministic',
            },
          );
          await this.repos.attention.save(attention);

          await this.emitEvent('attempt', attempt.id, 'attempt.interrupted', {
            actor: 'provider',
            previousState: 'running',
            newState: 'interrupted',
            evidence: result.evidence,
            details: {
              deliveryId: delivery.id,
              deliveryStatus: 'delivered',
              workerExecution: execution,
              errorType: evidence.errorType,
              errorStatus: evidence.errorStatus,
              errorMessage: evidence.errorMessage,
              providerId: evidence.providerId,
              modelId: evidence.modelId,
              matchingUserTurnId: result.reconciliation!.matchingUserTurn?.messageId ?? null,
            },
            correlationId: idempotencyKey,
          });

          // The worker is NOT working: it stopped. Recording `working` here would tell the
          // supervision tick to wait for a response that will never arrive.
          worker.recordObservationSuccess('idle', result.evidence);
          await this.repos.runtimes.save(worker);

          await this.emitEvent('delivery', delivery.id, 'delivery.confirmed', {
            actor: 'provider',
            previousState: 'delivering',
            newState: 'delivered',
            evidence: result.evidence,
            details: {
              workerExecution: execution,
              note: 'Delivery confirmed from the exact session; worker execution failed separately.',
            },
            correlationId: idempotencyKey,
          });
          return { assignment, attempt, delivery };
        }

        worker.recordObservationSuccess(executionObserved ? 'working' : 'available', result.evidence);
        await this.repos.runtimes.save(worker);

        await this.emitEvent('delivery', delivery.id, 'delivery.confirmed', {
          actor: 'provider',
          previousState: 'delivering',
          newState: 'delivered',
          evidence: result.evidence,
          details: { workerExecution: execution ?? 'not_observable' },
          correlationId: idempotencyKey,
        });

        if (execution === 'completed') {
          // Completion was observed during transport reconciliation, but the supervision
          // path owns the atomic completed_physical -> Handoff transition. Leaving the
          // independently-proven Attempt running here lets the next tick re-observe the
          // exact transcript and create both records together; completing it here stranded
          // an Assignment because supervision then rejected running promotion and never
          // reached Handoff creation.
          worker.recordObservationSuccess('idle', result.evidence);
          await this.repos.runtimes.save(worker);
        } else if (execution === 'in_progress') {
          await this.emitEvent('runtime', worker.id, 'worker.started', {
            actor: 'engine',
            previousState: 'available',
            newState: 'working',
            evidence: result.evidence,
          });
        }
      } else if (result.outcome === 'ambiguous') {
        // Mark ambiguous, raise critical attention item
        delivery.markAmbiguous(result.reason ?? 'Delivery outcome ambiguous', result.evidence);
        await this.repos.deliveries.save(delivery);

        const attention = AttentionItem.create(
          'critical',
          'ambiguous_delivery',
          'Ambiguous Instruction Delivery',
          `Could not verify whether instruction was received by worker runtime ${worker.name}. Manual or planner confirmation required.`,
          {
            pairId: pair.id,
            assignmentId: assignment.id,
            suggestedAction: 'Inspect worker composer or window, reconcile state, and either confirm delivery or reset attempt.',
            suggestedTier: 'tier_1_deterministic',
          },
        );
        await this.repos.attention.save(attention);

        await this.emitEvent('delivery', delivery.id, 'delivery.ambiguous', {
          actor: 'provider',
          previousState: 'delivering',
          newState: 'ambiguous',
          evidence: result.evidence,
          details: { reason: result.reason },
        });

        await this.emitEvent('attention', attention.id, 'attention.created', {
          actor: 'engine',
          newState: 'open',
          details: { title: attention.title },
        });
      } else {
        // Failed: the instruction never reached the worker, so NO physical execution
        // occurred. The Attempt therefore stays `prepared` (ATTEMPT_LIFECYCLE.md Case 1:
        // durable intent stored, external send not performed) and the outcome is recorded
        // on the Delivery, which is where observable delivery evidence belongs. The attempt
        // is never marked interrupted here, because the worker never started running; a
        // later dispatch mints a fresh attempt with a fresh attemptNumber.
        delivery.markFailed(result.reason ?? 'Delivery failed', result.evidence);
        await this.repos.deliveries.save(delivery);

        await this.emitEvent('delivery', delivery.id, 'delivery.failed', {
          actor: 'provider',
          previousState: 'delivering',
          newState: 'failed',
          details: { reason: result.reason },
        });
      }

      return { assignment, attempt, delivery };
    });
  }

  /**
   * Reconcile ONE terminal-or-stranded Delivery against its EXACT provider session.
   *
   * ## Why this is an application operation and not an operator SQL script
   *
   * The previous Phase F procedure repaired state by hand:
   *
   * ```
   * sqlite3 relay.sqlite "UPDATE deliveries SET status='failed' WHERE id='...'"
   * sqlite3 relay.sqlite "INSERT INTO events ..."
   * ```
   *
   * That is not a repair, it is an unreproducible assertion. It skips the domain transition
   * rules, emits no event through the event repository, leaves no trace of who decided or
   * why, and produces a state the application could never have produced itself — so the next
   * reader cannot tell a decided outcome from a typo. This method makes the same decision
   * through the domain, with the evidence attached and the decision recorded.
   *
   * ## What it decides
   *
   * It re-reads the exact session named by the Delivery's frozen `targetRuntimeId` +
   * `Attempt.externalSessionId`, and asks the ONE question that matters: does the exact
   * session hold a user turn whose normalised text is this Delivery's payload, beyond any
   * boundary already recorded on the Delivery's evidence?
   *
   * - A matching post-boundary turn exists  -> the instruction WAS delivered. A `failed`
   *   Delivery is corrected to `delivered`, and the Attempt advances to `running` (the
   *   worker provably began) and then to `interrupted` if the assistant turn shows a
   *   terminal provider error.
   * - The session is readable and holds no such turn -> `not_delivered` is confirmed and
   *   the `failed` Delivery is left alone.
   * - The session cannot be read -> NOTHING is changed. The Delivery is left exactly as it
   *   was and the method reports why, because an unreadable session is "could not check",
   *   never "not there" (I-6, C-8).
   *
   * ## It never resends
   *
   * There is no send in this method. A matching post-boundary user turn is a hard STOP for
   * any retry: the instruction is already in the session, and re-sending it would duplicate
   * real work inside a conversation. The returned `resendPermitted` flag exists so the
   * caller cannot bypass that conclusion.
   */
  public async reconcileDeliveryAgainstExactSession(
    deliveryId: DeliveryId,
    context: AuthorityContext = 'OPERATOR_EXPLICIT',
  ): Promise<{
    delivery: Delivery;
    reconciliation: TransportReconciliation;
    changes: string[];
    resendPermitted: boolean;
  }> {
    const delivery = await this.repos.deliveries.findById(deliveryId);
    if (!delivery) throw new RelayDomainError(`Delivery ${deliveryId} not found`, 'NOT_FOUND');

    const attempt = await this.repos.attempts.findById(delivery.attemptId);
    const assignment = await this.repos.assignments.findById(delivery.assignmentId);
    if (!assignment) {
      throw new RelayDomainError(
        `Delivery ${deliveryId} references Assignment ${delivery.assignmentId}, which no longer exists.`,
        'NOT_FOUND',
      );
    }

    const worker = await this.repos.runtimes.findById(delivery.targetRuntimeId);
    const externalSessionId =
      attempt?.externalSessionId ?? worker?.externalSessionId ?? null;

    const changes: string[] = [];
    const targetRuntime = worker;
    const provider = targetRuntime ? this.getProvider(targetRuntime.providerType) : null;

    // ---- I-2 GATE — ARMED (S6) ----
    //
    // Reading the exact session is a REAL external contact, not a local inspection, so §11.5
    // gates it like every other contact. It is tempting to exempt a recovery read — "recovery
    // must work when things are broken" — but the frozen precedent says the opposite:
    // `probeDispatchOutcome`, which reconciles an already-sent dispatch, is gated on the owning
    // Pair and returns `insufficient` rather than contacting an IDLE Pair's provider.
    //
    // `insufficient` is the honest disposition: the read did not happen, so RelayX does not
    // know, and it must NOT record `not_delivered` — that would assert an external fact it
    // never established (I-6, I-13).
    //
    // Ownership comes from the Attempt's FROZEN authority (`sessionPairId`), never a mutable
    // lookup, so the gate consults the same Pair the dispatch was authorised against.
    if (attempt?.sessionPairId) {
      const owningPair = await this.repos.pairs.findById(attempt.sessionPairId);
      if (owningPair) {
        try {
          owningPair.assertContactPermitted(context);
        } catch (err: any) {
          const reason =
            `Pair ${attempt.sessionPairId} does not permit ${context} contact, so the exact ` +
            `session behind Delivery ${delivery.id} cannot be read. No provider contact was ` +
            `made and no external state was inferred (DESIGN_FREEZE I-2, I-6, §11.5). ` +
            `Error: ${err.message}`;
          await this.emitEvent('delivery', delivery.id, 'delivery.reconciled', {
            actor: 'recovery',
            previousState: delivery.status,
            details: {
              disposition: 'insufficient',
              changes: [],
              transportClassification: 'ambiguous',
              reason,
              resendPermitted: false,
            },
          });
          return {
            delivery,
            reconciliation: reconcileTransportOutcome({
              expectedText: assignment.instruction,
              watermark: extractRecordedWatermark(delivery.evidence),
              messages: [],
              transcriptReadable: false,
              transcriptReadFailure: reason,
            }),
            changes,
            resendPermitted: false,
          };
        }
      }
    }

    let reconciliation: TransportReconciliation;
    if (!provider || !targetRuntime || !externalSessionId) {
      // Nothing to read. Report the honest `ambiguous` rather than inventing a verdict.
      reconciliation = reconcileTransportOutcome({
        expectedText: assignment.instruction,
        watermark: null,
        messages: [],
        transcriptReadable: false,
        transcriptReadFailure: !targetRuntime
          ? 'The target runtime session no longer exists.'
          : 'The Attempt and RuntimeSession carry no authoritative external session id.',
      });
    } else if (!provider.captureTransportBoundary || !provider.readExactSessionTurnsForReconciliation) {
      reconciliation = reconcileTransportOutcome({
        expectedText: assignment.instruction,
        watermark: null,
        messages: [],
        transcriptReadable: false,
        transcriptReadFailure:
          `Provider ${targetRuntime.providerType} exposes no exact-session read capability, so ` +
          `delivery state cannot be established from authoritative evidence.`,
      });
    } else {
      // The boundary must be the PRE-dispatch state, not the current state. A boundary taken
      // now would contain the very turn we are looking for, so nothing could ever be
      // post-boundary and every delivery would look like it never happened.
      //
      // Preference order, and the reason for it:
      //   1. the boundary already committed on this Delivery's evidence (exact, from the send);
      //   2. otherwise, NO boundary — which yields `ambiguous` rather than a guess.
      //
      // Taking a fresh read as a substitute boundary was rejected: it would produce confident,
      // structurally-wrong verdicts in the one direction that authorises a resend.
      const transcript = await provider.readExactSessionTurnsForReconciliation(externalSessionId);
      if (!transcript.readable) {
        reconciliation = reconcileTransportOutcome({
          expectedText: assignment.instruction,
          watermark: null,
          messages: [],
          transcriptReadable: false,
          transcriptReadFailure: transcript.failure,
        });
      } else {
        // Boundary preference, and the reason for the order:
        //
        //   1. the id set captured from the exact session immediately before this Delivery's
        //      send — authoritative, and the only kind a live dispatch produces;
        //   2. otherwise, a boundary RECONSTRUCTED from the Delivery's own durable
        //      `created_at`. Sound in one direction only (a turn cannot predate the intent
        //      that created it), and recorded as `reconstructed_from_intent_time` so it is
        //      never mistaken for a captured read.
        //
        // A boundary is REQUIRED rather than assumed: without one, a fresh read would
        // contain the very turn being looked for, so nothing could ever be post-boundary and
        // every delivery would reconcile to "never happened" — a confident, structurally-wrong
        // verdict in exactly the direction that authorises a resend.
        const captured = extractRecordedWatermark(delivery.evidence);
        const boundary =
          captured ??
          reconstructWatermarkFromIntentTime(externalSessionId, transcript.messages, delivery.createdAt);

        reconciliation = reconcileTransportOutcome({
          expectedText: assignment.instruction,
          watermark: boundary,
          messages: transcript.messages,
          transcriptReadable: true,
          transportExitCode: null,
          transportError: 'Reconciled after the fact; this operation ran no transport process.',
        });
      }
    }

    const before = { delivery: delivery.status, attempt: attempt?.status ?? null };

    if (reconciliation.classification === 'delivered') {
      await this.repos.runInTransaction(async () => {
        if (delivery.status !== 'delivered') {
          delivery.confirmDelivered(
            withRecordedBoundary(
              reconciliationEvidence(reconciliation, delivery, assignment),
              delivery.evidence,
            ),
          );
          await this.repos.deliveries.save(delivery);
          changes.push(`Delivery ${delivery.id}: ${before.delivery} -> delivered`);
        }

        if (attempt) {
          const executionEvidence = reconciliationEvidence(reconciliation, delivery, assignment);
          const executionObserved = ['in_progress', 'completed', 'terminal_error']
            .includes(reconciliation.workerExecution);
          if (executionObserved && attempt.status === 'prepared') {
            attempt.startRunning();
            changes.push(`Attempt ${attempt.id}: prepared -> running`);
          }
          if (reconciliation.workerExecution === 'terminal_error' && attempt.status === 'running') {
            const e = reconciliation.workerExecutionEvidence;
            attempt.interrupt(
              `Worker execution terminated with provider error ${e.errorType ?? 'unknown'}` +
              `${e.errorStatus ? ` (HTTP ${e.errorStatus})` : ''}` +
              `${e.providerId ? ` on ${e.providerId}/${e.modelId ?? 'unknown'}` : ''}: ` +
              `${e.errorMessage ?? 'no error message reported'}. The instruction WAS delivered ` +
              `(message ${reconciliation.matchingUserTurn?.messageId ?? 'unknown'}).`,
              executionEvidence,
            );
            changes.push(`Attempt ${attempt.id}: running -> interrupted`);
          } else if (reconciliation.workerExecution === 'completed' && attempt.status === 'running') {
            attempt.completePhysical(executionEvidence);
            changes.push(`Attempt ${attempt.id}: running -> completed_physical`);
          }
          await this.repos.attempts.save(attempt);
        }
      });

      await this.emitEvent('delivery', delivery.id, 'delivery.reconciled', {
        actor: 'recovery',
        previousState: before.delivery,
        newState: delivery.status,
        evidence: reconciliationEvidence(reconciliation, delivery, assignment),
        details: {
          changes,
          transportClassification: reconciliation.classification,
          workerExecution: reconciliation.workerExecution,
          matchingUserTurnId: reconciliation.matchingUserTurn?.messageId ?? null,
          expectedFingerprint: reconciliation.expectedFingerprint,
          matchedFingerprint: reconciliation.matchedFingerprint,
          matchKind: reconciliation.matchKind,
          resendPermitted: false,
          reason: 'A matching post-boundary user turn exists in the exact session; the instruction was delivered.',
        },
      });
    } else {
      await this.emitEvent('delivery', delivery.id, 'delivery.reconciled', {
        actor: 'recovery',
        previousState: before.delivery,
        newState: before.delivery,
        details: {
          changes,
          transportClassification: reconciliation.classification,
          reason: reconciliation.reason,
          boundaryProvenance: reconciliation.boundaryProvenance,
          // This is the only case in which a retry is defensible: the session was READ
          // successfully AND shown not to hold the instruction. A boundary reconstructed
          // from the intent time cannot license a resend on its own, because it is only
          // sound in the excluding direction — it can wrongly exclude a turn, never wrongly
          // include an earlier attempt's, so absence under it is not proof of absence.
          resendPermitted:
            reconciliation.classification === 'not_delivered' &&
            reconciliation.boundaryProvenance === 'captured_pre_dispatch',
        },
      });
    }

    const fresh = await this.repos.deliveries.findById(deliveryId);
    return {
      delivery: fresh ?? delivery,
      reconciliation,
      changes,
      resendPermitted:
        reconciliation.classification === 'not_delivered' &&
        reconciliation.boundaryProvenance === 'captured_pre_dispatch',
    };
  }

  /** Read an exact session's turns through whichever provider capability exposes them. */
  /**
   * Repair a Pair's execution-slot authority from its own Assignment records.
   *
   * ## The orphan state this replaces
   *
   * A Pair reached a state where `activeAssignmentId` named one Assignment while several
   * other Assignments were simultaneously `active` — the result of unguarded
   * `pair.assignWork()` overwrites across repeated dispatches. Phase F previously "fixed" this
   * with a hand-written `UPDATE pairs SET active_assignment_id=...`, which made the symptom
   * disappear while leaving every orphaned Assignment still `active` and still believing it
   * owned the work. This method resolves the whole set deterministically.
   *
   * ## The rule
   *
   * 1. Classify every Assignment of the Pair as terminal or unresolved.
   * 2. If the current holder is unresolved and real, it KEEPS the slot. The most recent
   *    unresolved Assignment is not promoted over it just for being newer — a `pending`
   *    backlog item has never been dispatched and has no claim to the slot.
   * 3. Every OTHER unresolved Assignment is transitioned explicitly, with an event each.
   *    `pending` with no Attempt is `cancelled` (superseded, never dispatched);
   *    `active`/`waiting_for_handoff` with dispatch evidence is `failed` only when its
   *    Delivery is terminal and its Attempt is not running, and otherwise `cancelled` with
   *    the ambiguity named in the event. Nothing is silently mutated.
   * 4. If the holder is dangling or terminal, the slot is released and, if exactly one
   *    unresolved Assignment remains, that one is adopted. If SEVERAL remain, none is adopted:
   *    the choice is an operator's, and the method reports the candidates instead of guessing.
   *
   * This is idempotent: running it twice changes nothing the second time.
   */
  public async reconcilePairAssignmentAuthority(pairId: PairId): Promise<{
    pair: Pair;
    adoptedAssignmentId: string | null;
    releasedAssignmentId: string | null;
    transitions: Array<{ assignmentId: string; from: string; to: string; reason: string }>;
    unresolvedCandidates: string[];
  }> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const assignments = await this.repos.assignments.findByPairId(pairId);
    const unresolved = assignments.filter(
      (a) => !RelayEngine.TERMINAL_ASSIGNMENT_STATES.has(a.status),
    );
    const transitions: Array<{
      assignmentId: string;
      from: string;
      to: string;
      reason: string;
    }> = [];

    const isTerminal = (a: Assignment) => RelayEngine.TERMINAL_ASSIGNMENT_STATES.has(a.status);
    let holder = pair.activeAssignmentId
      ? assignments.find((a) => a.id === pair.activeAssignmentId) ?? null
      : null;
    const holderIsUsable = Boolean(holder && !isTerminal(holder));

    if (holderIsUsable) {
      // Rule 2 + 3: the current holder keeps the slot; every other unresolved Assignment is
      // transitioned out of the way, explicitly.
      for (const candidate of unresolved) {
        if (candidate.id === holder!.id) continue;
        const reason = await this.describeOrphanReason(candidate);
        const transition = await this.repos.runInTransaction(async () => {
          const fresh = await this.repos.assignments.findById(candidate.id);
          if (!fresh) {
            return { assignmentId: candidate.id, from: 'missing', to: 'missing', reason: 'The Assignment record no longer exists.' };
          }
          if (isTerminal(fresh)) {
            return { assignmentId: fresh.id, from: candidate.status, to: fresh.status, reason: 'Already terminal.' };
          }
          const from = fresh.status;
          // `Assignment.cancel()` takes no reason: the entity has no reason field, and
          // adding one would be a schema change for a value the event stream already owns.
          // The reason is therefore carried by the event emitted below and returned in the
          // transition record, so it is never lost — just stored where it belongs.
          fresh.cancel();
          await this.repos.assignments.save(fresh);
          return { assignmentId: fresh.id, from, to: fresh.status, reason };
        });
        transitions.push(transition);
        await this.emitEvent('assignment', transition.assignmentId, 'assignment.cancelled', {
          actor: 'recovery',
          previousState: transition.from,
          newState: transition.to,
          details: { pairId, reason: transition.reason, supersededBy: holder!.id },
        });
      }
    } else {
      // Rule 4: release the unusable slot first.
      if (pair.activeAssignmentId) {
        const releasedId = pair.activeAssignmentId;
        pair.clearWork();
        await this.repos.pairs.save(pair);
        await this.emitEvent('pair', pair.id, 'pair.assignment_slot_released', {
          actor: 'recovery',
          previousState: holder?.status ?? 'missing',
          newState: 'idle',
          details: {
            releasedAssignmentId: releasedId,
            reason: holder
              ? 'The execution slot was held by an Assignment that is already terminal.'
              : 'The execution slot pointed at an Assignment that no longer exists.',
          },
        });
      }

      const remaining = assignments.filter(
        (a) => !isTerminal(a) && !transitions.some((t) => t.assignmentId === a.id),
      );
      if (remaining.length === 1) {
        holder = remaining[0];
        await this.repos.runInTransaction(async () => {
          const fresh = await this.repos.assignments.findById(remaining[0].id);
          if (!fresh) return;
          pair.assignWork(fresh.id);
          await this.repos.pairs.save(pair);
        });
        await this.emitEvent('pair', pair.id, 'pair.assignment_slot_adopted', {
          actor: 'recovery',
          previousState: 'idle',
          newState: pair.status,
          details: {
            adoptedAssignmentId: remaining[0].id,
            reason: 'Exactly one unresolved Assignment remained, so it was adopted unambiguously.',
          },
        });
      } else if (remaining.length > 1) {
        // Deliberately not guessing. Adopting the newest would re-create the very orphan
        // state this method exists to remove.
        await this.emitEvent('pair', pair.id, 'pair.assignment_slot_unresolved', {
          actor: 'recovery',
          previousState: pair.activeAssignmentId ?? 'idle',
          newState: pair.status,
          details: {
            candidateAssignmentIds: remaining.map((a) => a.id),
            reason:
              'Several unresolved Assignments remain and none provably owned the execution slot. ' +
              'No Assignment was adopted, because promoting the newest would be exactly the ' +
              'silent overwrite this reconciliation forbids. An operator must choose.',
          },
        });
      }
    }

    return {
      pair: (await this.repos.pairs.findById(pairId)) ?? pair,
      adoptedAssignmentId: holderIsUsable ? holder!.id : (holder?.id ?? null),
      releasedAssignmentId: null,
      transitions,
      unresolvedCandidates: unresolved.map((a) => a.id),
    };
  }

  /**
   * Explain, from records alone, why an unresolved Assignment is not the execution-slot owner.
   *
   * This is a DISCRIMINATOR, not a verdict: it reports which lifecycle state the Assignment is
   * actually in, and the event carries that text verbatim, so a reader can disagree with the
   * classification and act on the evidence rather than on a summary.
   */
  private async describeOrphanReason(assignment: Assignment): Promise<string> {
    if (assignment.status === 'pending' && !assignment.currentAttemptId) {
      return (
        'Superseded: this Assignment was never dispatched (no Attempt was ever created for it) ' +
        'and it was holding the Pair execution slot alongside a different Assignment. ' +
        'No instruction was ever sent for it, so nothing external is affected.'
      );
    }
    const attempts = await this.repos.attempts.findByAssignmentId(assignment.id);
    const deliveries = await this.repos.deliveries.findByAssignmentId(assignment.id);
    const parts = [
      `Superseded: this Assignment was unresolved (status=${assignment.status}) while a different ` +
      'Assignment held the Pair execution slot.',
      `Attempts: ${attempts.length === 0 ? 'none' : attempts.map((a) => `${a.id}=${a.status}`).join(', ')}.`,
      `Deliveries: ${deliveries.length === 0 ? 'none' : deliveries.map((d) => `${d.id}=${d.status}`).join(', ')}.`,
    ];
    return parts.join(' ');
  }

  /* --- Supervisor Tick (Observe -> Reconcile -> Decide -> Act -> Verify) --- */
  /**
   * The steady-state supervision tick, and the SAME relay state machine used by resume.
   *
   * ## One state machine, not two
   *
   * This method no longer decides anything about completion itself. It delegates the whole
   * decision to `resumeRelayContinuity`, which is also what `resumePair` and
   * `recoverOnStartup` call. That matters because a resume path and a steady-state path
   * with different rules is how a Pair ends up behaving correctly for five seconds and then
   * wrongly after a crash — or the reverse.
   *
   * ## What was removed, and why
   *
   * This tick previously created the Handoff from `inspectRuntime(...).isComplete`. That was
   * a SECOND, independent completion detector living beside the authoritative exact-session
   * path, and two detectors with two definitions of completion is what produced the original
   * handoff defect in this codebase (see the note previously at the old completion block).
   * It is gone. Provider runtime state is now used only for the narrow mechanical question
   * "is this exact session currently generating/running?", and it can no longer create a
   * Handoff on its own.
   *
   * ## I-2 GATE — ARMED (S6)
   *
   * §11.5 / §4.3: an IDLE Pair receives zero provider contact, so the tick skips it entirely
   * rather than inspecting it, and the skip sits before `getProvider(...)`. Gating this tick
   * also gates `startSupervisionLoop`, which only schedules this method. The tick's
   * non-provider work (ambiguous-delivery attention items) reads only RelayX's own database
   * and still runs for every Pair — I-2 forbids provider contact, not local bookkeeping.
   */
  public async runSupervisionTick(): Promise<{
    inspectedRuntimes: number;
    inspectedAssignments: number;
    handoffsCreated: number;
    attentionItemsCreated: number;
    batonDecisions: RelayBatonDecisionReport[];
  }> {
    if (this.isSupervising) {
      return { inspectedRuntimes: 0, inspectedAssignments: 0, handoffsCreated: 0, attentionItemsCreated: 0, batonDecisions: [] };
    }
    this.isSupervising = true;

    try {
      let handoffsCreated = 0;
      let attentionItemsCreated = 0;
      const pairsWithNewHandoff = new Set<PairId>();
      const batonDecisions: RelayBatonDecisionReport[] = [];

      // 1. The relay baton, for every permitted Pair. This is the single authority for
      //    "which side owes the next completed turn" and for whether a completed turn may be
      //    handed to the other side. It reconciles unresolved intents, reads the baton
      //    owner's exact session after the recorded boundary, and acts — or deliberately
      //    does not.
      const permittedPairs = (await this.repos.pairs.findAll())
        .filter((candidate) => candidate.isAutomatedContactPermitted())
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

      for (const pair of permittedPairs) {
        try {
          const report = await this.resumeRelayContinuity(pair.id, {
            context: 'AUTOMATED',
            actor: 'supervisor',
          });
          batonDecisions.push(report);

          // A recovery that did not throw closed any earlier failure episode for this Pair —
          // including one opened at startup. This is what makes the startup incident resolvable
          // by the tick that retries it, with no extra scheduler.
          await this.resolveContinuityRecoveryIncident(pair.id, 'supervision');

          if (report.action.kind === 'handoff_created' || report.action.kind === 'handoff_advanced') {
            handoffsCreated++;
            // Preserve an observable boundary between "a Handoff was recorded for a completed
            // turn" and "that Handoff was converted into an opposite-side Assignment". When
            // the conversion could not happen in this evaluation, the next tick performs it,
            // so an operator watching the event stream sees both transitions separately.
            if (report.action.kind === 'handoff_created' && report.action.deliveryId === undefined) {
              pairsWithNewHandoff.add(pair.id);
            }
          }

          await this.emitEvent('pair', pair.id, 'pair.baton_evaluated', {
            actor: 'supervisor',
            newState: pair.relayState,
            details: {
              decision: report.decision,
              batonDirection: report.baton.direction,
              batonOwner: report.baton.owner,
              batonSender: report.baton.sender,
              basisDeliveryId: report.baton.deliveryId,
              basisAssignmentId: report.baton.assignmentId,
              basisAttemptId: report.baton.attemptId,
              boundaryProvenance: report.baton.boundaryProvenance,
              boundaryMessageCount: report.baton.boundaryMessageCount,
              dispatchedExternalSessionId: report.baton.dispatchedExternalSessionId,
              observation: report.observation,
              action: report.action,
              relayDecisionTrail: report.relayDecisionTrail,
              reason: report.reason,
              // Recorded so an auditor can see at a glance that no semantic verdict was made.
              semanticJudgmentMade: false,
            },
          });
        } catch (err: any) {
          // One Pair's provider failure must not stop supervision of the others. Outcomes
          // that were already durable stay durable, and the failure resurfaces through the
          // existing attention paths rather than being swallowed as a decision.
          //
          // That comment used to overstate the case: the synthetic report below is in-memory
          // only, so the failure was observable in the return value but never became durable.
          // It is now recorded through the same path as a startup failure, so a Pair that cannot
          // be reconstructed leaves the same durable evidence wherever the failure happened.
          const recorded = await this.recordContinuityRecoveryFailure(pair, err, 'supervision');
          if (recorded.attentionItemId) attentionItemsCreated++;
          batonDecisions.push({
            pairId: pair.id,
            decision: 'transcript_unreadable',
            relayDecisionTrail: [`baton evaluation threw: ${err?.message ?? String(err)}`],
            baton: {
              basis: 'no_confirmed_delivery',
              direction: null,
              owner: null,
              sender: null,
              deliveryId: null,
              assignmentId: null,
              attemptId: null,
              deliveredAt: null,
              boundarySessionId: null,
              boundaryMessageCount: null,
              boundaryProvenance: null,
              dispatchedExternalSessionId: null,
              confirmedDeliveryCount: 0,
              supersededDeliveryCount: 0,
            },
            observation: null,
            action: { kind: 'none' },
            reason: `The baton evaluation threw and was contained so other Pairs keep being supervised: ${
              err?.message ?? String(err)
            }`,
          });
        }
      }

      // 2. Check for ambiguous deliveries needing attention
      const ambiguousDeliveries = await this.repos.deliveries.findAmbiguous();
      for (const deliv of ambiguousDeliveries) {
        const openItems = await this.repos.attention.findOpen();
        const exists = openItems.some((i) => i.assignmentId === deliv.assignmentId && i.type === 'ambiguous_delivery');
        if (!exists) {
          const item = AttentionItem.create(
            'critical',
            'ambiguous_delivery',
            'Ambiguous Delivery Pending Resolution',
            `Delivery ${deliv.id} is ambiguous. Operator intervention or recovery is required.`,
            { assignmentId: deliv.assignmentId },
          );
          await this.repos.attention.save(item);
          attentionItemsCreated++;
        }
      }

      // 3. Advance each enabled Pair by one deterministic relay step. This is what turns
      //    Start into an orchestration command: pending work is dispatched, and a completed
      //    side's ready Handoff becomes the opposite side's next Assignment on a subsequent
      //    tick. PAUSED/STOPPED pairs are rejected by the shared authority gate.
      for (const pair of permittedPairs) {
        // Preserve an observable boundary between "completion/Handoff recorded" and
        // "Handoff converted to opposite-side Assignment". The next tick advances it.
        if (pairsWithNewHandoff.has(pair.id)) continue;
        try {
          await this.advancePairOrchestration(pair.id);
        } catch {
          // One Pair must not stop supervision of the others. Dispatch outcomes remain
          // durable and provider failures are surfaced by their existing attention paths.
        }
      }

      const inspectedAssignments = (
        await this.repos.assignments.findActive()
      ).filter((assignment) => permittedPairs.some((pair) => pair.id === assignment.pairId)).length;

      return {
        inspectedRuntimes: (await this.repos.runtimes.findAll()).length,
        inspectedAssignments,
        handoffsCreated,
        attentionItemsCreated,
        batonDecisions,
      };
    } finally {
      this.isSupervising = false;
    }
  }

  /* --- Planner Review & Handoff Completion --- */
  /**
   * The outcome of an attempt to deliver a handoff to the Planner.
   *
   * `externally_confirmed` is unreachable in S1 and is deliberately declared, so
   * that the only way to obtain it is a future exact Planner transport (S11)
   * returning provider evidence. There is no other construction path.
   */
  public async attemptPlannerDelivery(handoffId: HandoffId): Promise<PlannerDeliveryAttempt> {
    const handoff = await this.repos.handoffs.findById(handoffId);
    if (!handoff) throw new RelayDomainError(`Handoff ${handoffId} not found`, 'NOT_FOUND');

    const assignment = await this.repos.assignments.findById(handoff.assignmentId);
    if (!assignment) throw new RelayDomainError(`Assignment ${handoff.assignmentId} not found`, 'NOT_FOUND');

    const pair = await this.repos.pairs.findById(assignment.pairId);
    if (!pair) throw new RelayDomainError(`Pair ${assignment.pairId} not found`, 'PAIR_NOT_FOUND');

    // I-2 GATE — ARMED (S6). Explicit operator contact requires operationalState === ACTIVE.
    pair.assertProviderContactPermitted();

    if (pair.plannerSessionId) {
      const plannerSession = await this.repos.runtimes.findById(pair.plannerSessionId);
      const effectiveSessionId = plannerSession?.externalSessionId || plannerSession?.sessionUrl;
      if (plannerSession && effectiveSessionId) {
        try {
          const provider = this.getProvider(plannerSession.providerType);
          const deliveryResult = await provider.deliverInstruction({
            runtimeSessionId: plannerSession.id,
            externalSessionId: effectiveSessionId,
            instructionText: `Handoff result for assignment: ${handoff.resultSummary}`,
            idempotencyKey: `planner_delivery_${handoff.id}_${Date.now()}`,
          });

          if (deliveryResult.outcome === 'delivered' && deliveryResult.evidence) {
            handoff.markDeliveredToPlanner(deliveryResult.evidence);
            await this.repos.handoffs.save(handoff);

            await this.emitEvent('handoff', handoff.id, 'planner.delivery.confirmed', {
              actor: 'engine',
              previousState: 'ready',
              newState: 'delivered',
              details: {
                outcome: 'externally_confirmed',
                externalContactAttempted: true,
                externalSessionId: plannerSession.externalSessionId,
                evidenceId: deliveryResult.evidence.id,
              },
            });

            return {
              handoff,
              outcome: 'externally_confirmed',
              evidence: deliveryResult.evidence,
              externalContactAttempted: true,
            };
          } else {
            const reason = `Planner delivery transport attempted but failed or was ambiguous: ${deliveryResult.reason || deliveryResult.outcome}`;
            await this.emitEvent('handoff', handoff.id, 'planner.delivery.unverified', {
              actor: 'engine',
              previousState: handoff.status,
              newState: handoff.status,
              details: { outcome: 'unverified', externalContactAttempted: true, reason },
            });
            return {
              handoff,
              outcome: 'unverified',
              reason,
              externalContactAttempted: true,
            };
          }
        } catch (err: any) {
          const reason = `Planner delivery transport encountered error: ${err?.message || String(err)}`;
          await this.emitEvent('handoff', handoff.id, 'planner.delivery.unverified', {
            actor: 'engine',
            previousState: handoff.status,
            newState: handoff.status,
            details: { outcome: 'unverified', externalContactAttempted: true, reason },
          });
          return {
            handoff,
            outcome: 'unverified',
            reason,
            externalContactAttempted: false,
          };
        }
      }
    }

    const attempt: PlannerDeliveryAttempt = {
      handoff,
      outcome: 'unverified',
      reason:
        'Exact Planner conversation transport requires a bound Planner RuntimeSession with an authoritative external session ID (`externalSessionId`) or exact session URL. None found for this handoff pair.',
      externalContactAttempted: false,
    };

    await this.emitEvent('handoff', handoff.id, 'planner.delivery.unverified', {
      actor: 'engine',
      previousState: handoff.status,
      newState: handoff.status,
      details: {
        outcome: attempt.outcome,
        externalContactAttempted: attempt.externalContactAttempted,
        providerCapability: 'none',
        reason: attempt.reason,
      },
    });

    return attempt;
  }

  /**
   * @deprecated Retained only for API compatibility. Use
   * {@link attemptPlannerDelivery}, which reports a truthful outcome instead of
   * throwing.
   *
   * This method previously recorded the handoff as delivered to the Planner and
   * emitted `planner.notified` while contacting nothing at all
   * (DESIGN_FREEZE §9.4.1). That was an evidence-integrity defect: durable state
   * asserted an external effect that never happened. It is now fenced — it
   * contacts no provider, marks no external delivery, and emits no
   * externally-confirming event — and it rejects so that a caller which
   * discards the return value cannot read success as "the Planner was told".
   *
   * Invariant 6 is unchanged and still holds: handoff completion does not
   * complete an assignment.
   */
  public async deliverHandoffToPlanner(handoffId: HandoffId): Promise<Handoff> {
    const attempt = await this.attemptPlannerDelivery(handoffId);
    if (attempt.outcome === 'externally_confirmed') return attempt.handoff;
    throw new RelayDomainError(
      `Handoff ${handoffId} was NOT delivered to the Planner: ${attempt.reason}`,
      'PLANNER_DELIVERY_UNSUPPORTED',
    );
  }

  public async completeHandoff(handoffId: HandoffId): Promise<Handoff> {
    const handoff = await this.repos.handoffs.findById(handoffId);
    if (!handoff) throw new RelayDomainError(`Handoff ${handoffId} not found`, 'NOT_FOUND');

    // Recorded BEFORE the transition. This used to be the hardcoded literal
    // 'delivered', which wrote an assertion that the Planner had been notified
    // into the audit stream for handoffs that were never delivered at all — the
    // same evidence-integrity defect as `planner.notified` (DESIGN_FREEZE §9.4.1).
    const previousStatus = handoff.status;
    handoff.completeHandoff();
    await this.repos.handoffs.save(handoff);

    await this.emitEvent('handoff', handoff.id, 'handoff.complete', {
      actor: 'engine',
      previousState: previousStatus,
      newState: 'complete',
    });

    return handoff;
  }

  public async completeAssignment(assignmentId: AssignmentId): Promise<Assignment> {
    const assignment = await this.repos.assignments.findById(assignmentId);
    if (!assignment) throw new RelayDomainError(`Assignment ${assignmentId} not found`, 'NOT_FOUND');

    const previousStatus = assignment.status;
    assignment.complete();
    await this.repos.assignments.save(assignment);

    // Assignment resolution is a local/operator decision. It must never manufacture
    // `completed_physical`; only provider completion evidence may move the Attempt.

    const pair = await this.repos.pairs.findById(assignment.pairId);
    if (pair && pair.activeAssignmentId === assignment.id) {
      pair.clearWork();
      await this.repos.pairs.save(pair);
    }

    await this.emitEvent('assignment', assignment.id, 'assignment.completed', {
      actor: 'user',
      previousState: previousStatus,
      newState: 'completed',
    });

    return assignment;
  }

  /* --- Tier 1 Deterministic Recovery --- */

  /**
   * S6 CLOSURE — the ONE authoritative runtime -> Pair ownership resolution.
   *
   * ## Why this is a single public method rather than two private checks
   *
   * Two runtime-addressed provider operations existed with two *different* ad-hoc
   * resolutions, and the one on the service side had no resolution at all. That
   * asymmetry is precisely how the hole opened. Routing every runtime-addressed
   * provider operation through this one method is the enforcement architecture:
   *
   * ```
   * provider operation requested (by RuntimeSessionId)
   *          ↓
   *   resolveRuntimePairGovernance()
   *          ↓
   *   unpaired ─────→ standalone runtime semantics (no Pair to govern)
   *        │ paired (exactly one)
   *   ambiguous ─────→ DENY, fail closed, never pick a candidate
   *        │ paired
   *      operationalState
   *     ↙              ↘
   *  IDLE                ACTIVE
   *   ↓                     ↓
   *  DENY                continue
   * ```
   *
   * ## The ownership source
   *
   * `IPairRepository.findByRuntimeSessionId` — the durable binding columns
   * `planner_session_id` / `worker_session_id`, compared by runtime session id.
   * Never a title, a project name, a workspace basename, a lifecycle `status`, or
   * the frontmost window (I-11).
   *
   * ## What it does NOT do
   *
   * It never activates anything, never repairs a binding, and never infers an owner
   * from a heuristic. It is a read and a decision, nothing else.
   */
  public async resolveRuntimePairGovernance(
    runtimeSessionId: RuntimeSessionId,
  ): Promise<RuntimePairGovernance> {
    const owners = await this.repos.pairs.findByRuntimeSessionId(runtimeSessionId);

    if (owners.length === 0) return { kind: 'unpaired' };
    if (owners.length === 1) {
      const pair = owners[0];
      // Read the state THROUGH the entity's own accessors, never off a raw row,
      // so `isProviderContactPermitted()` remains the single I-2 decision point.
      return {
        kind: 'paired',
        pairId: pair.id,
        operationalState: pair.isProviderContactPermitted() ? 'ACTIVE' : pair.operationalState,
      };
    }
    return { kind: 'ambiguous', pairIds: owners.map((p) => p.id) };
  }

  /**
   * S6 CLOSURE — the enforcement half of `resolveRuntimePairGovernance`.
   *
   * Every runtime-addressed provider operation calls this immediately before
   * touching a provider. It throws for the two deny cases and returns the
   * governance for the two allow cases, so the caller can distinguish "allowed
   * because unpaired" from "allowed because ACTIVE" — a distinction that matters
   * for truthful reporting, and that a bare `if` would erase.
   *
   * ## Why a public engine method rather than a check inside RelayApiService
   *
   * The service is the presentation/IPC layer. Putting the rule there would make
   * the invariant true only for callers that happen to route through the service,
   * and false for every other caller. The engine is where the invariant lives.
   */
  public async assertRuntimeProviderContactPermitted(
    runtimeSessionId: RuntimeSessionId,
    context: AuthorityContext = 'OPERATOR_EXPLICIT',
  ): Promise<RuntimePairGovernance> {
    const governance = await this.resolveRuntimePairGovernance(runtimeSessionId);

    if (governance.kind === 'ambiguous') {
      // Fail closed. Choosing one of several candidate Pairs would be a heuristic
      // authorisation decision, and an unjustifiable one.
      throw new RelayDomainError(
        `Runtime ${runtimeSessionId} is bound to more than one Pair (${governance.pairIds.join(', ')}), ` +
          'so its owning Pair cannot be determined authoritatively. Refusing provider contact rather ' +
          'than guessing which Pair governs it. Repair the duplicate binding first.',
        RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS,
      );
    }

    if (governance.kind === 'paired') {
      const pair = await this.repos.pairs.findById(governance.pairId);
      if (pair) {
        pair.assertContactPermitted(context);
      }
    }

    return governance;
  }

  /**
   * I-2 GATE — ARMED (S6). This is the seventh provider-contact site, and it was
   * NOT in the original S1B call graph. It is addressed by `RuntimeSessionId`
   * rather than `PairId`, which is exactly why it was easy to miss: there was no
   * `Pair` in scope to gate against.
   *
   * `provider.inspectRuntime(...)` below is real external contact, so §11.5 gates
   * it, through the single shared path above.
   *
   * ## An unpaired runtime is NOT given permission by default
   *
   * If no Pair binds this runtime, the operation proceeds, because there is no
   * Pair whose IDLE state could be violated: standalone runtime management is an
   * established product capability (a runtime can be discovered, inspected,
   * archived, unarchived and adopted before it is ever paired). This is a
   * documented boundary, not an oversight — and it is the ABSENCE of a governance
   * subject, not a grant of permission. Case C in the S6 closure report pins this
   * behaviour with call counts.
   */
  /**
   * Central execution-evidence promotion: `prepared` → `running`.
   * Only called when provider evidence proves execution started or completed.
   * Delivery confirmation (`delivered`) is NOT sufficient — see SEMANTIC_FREEZE.
   */
  public async promoteAttemptToRunning(
    assignmentId: AssignmentId,
    evidence: ObservableEvidence,
  ): Promise<{ promoted: boolean; attempt?: Attempt; previousStatus?: string; newStatus?: string }> {
    const details = evidence.details as Record<string, unknown> | undefined;
    const executionState = details?.executionState ?? details?.workerExecution;
    const supportsExecution =
      executionState === 'running' ||
      executionState === 'in_progress' ||
      executionState === 'completed' ||
      executionState === 'terminal_error' ||
      details?.responseActivityObserved === true ||
      typeof details?.assistantMessageId === 'string' ||
      typeof details?.assistantFinish === 'string';
    if (!supportsExecution) return { promoted: false };

    const assignment = await this.repos.assignments.findById(assignmentId);
    if (!assignment) return { promoted: false };
    if (!assignment.currentAttemptId) return { promoted: false };
    const attempt = await this.repos.attempts.findById(assignment.currentAttemptId);
    if (!attempt || attempt.status !== 'prepared') return { promoted: false };

    // Evidence must explicitly support execution (not just delivery confirmation).
    // For providers with separate execution verdicts (e.g., OpenCode workerExecution),
    // the caller passes evidence that includes execution proof. For providers without
    // such capability, this promotion will not succeed (execution unobservable).
    attempt.startRunning();
    await this.repos.attempts.save(attempt);
    await this.emitEvent('attempt', attempt.id, 'attempt.running', {
      actor: 'engine',
      previousState: 'prepared',
      newState: 'running',
      evidence,
    });
    return { promoted: true, attempt, previousStatus: 'prepared', newStatus: 'running' };
  }

  public async reconcileAndRecoverRuntime(sessionId: RuntimeSessionId): Promise<RuntimeSession> {
    const runtime = await this.repos.runtimes.findById(sessionId);
    if (!runtime) throw new RelayDomainError(`Runtime ${sessionId} not found`, 'NOT_FOUND');

    await this.assertRuntimeProviderContactPermitted(sessionId);

    const provider = this.getProvider(runtime.providerType);
    const inspection = await provider.inspectRuntime(runtime.id);

    if (inspection.found) {
      const { previousStatus, newStatus } = runtime.recordObservationSuccess(
        inspection.isWorking ? 'working' : 'available',
        inspection.evidence,
        inspection.windowTitle,
        inspection.applicationPid,
      );
      await this.repos.runtimes.save(runtime);

      // Auto-resolve any open suspension attention items for this runtime
      const openItems = await this.repos.attention.findOpen();
      for (const item of openItems) {
        if (item.type === 'runtime_suspended') {
          item.resolve();
          await this.repos.attention.save(item);
        }
      }

      await this.emitEvent('runtime', runtime.id, 'runtime.recovered', {
        actor: 'recovery',
        previousState: previousStatus,
        newState: newStatus,
        evidence: inspection.evidence,
      });
    } else {
      const { previousStatus, newStatus } = runtime.recordObservationFailure();
      await this.repos.runtimes.save(runtime);

      await this.emitEvent('runtime', runtime.id, 'runtime.observation_failed', {
        actor: 'recovery',
        previousState: previousStatus,
        newState: newStatus,
        details: { reason: 'Runtime not found during reconciliation' },
      });
    }

    return runtime;
  }

  public async resolveAmbiguousDelivery(
    deliveryId: DeliveryId,
    resolution: 'confirmed_delivered' | 'retry_permitted',
  ): Promise<Delivery> {
    const delivery = await this.repos.deliveries.findById(deliveryId);
    if (!delivery) throw new RelayDomainError(`Delivery ${deliveryId} not found`, 'NOT_FOUND');

    if (resolution === 'confirmed_delivered') {
      const evidence: ObservableEvidence = {
        id: `ev_recon_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: delivery.targetRuntimeId,
        details: { manualResolution: 'Operator confirmed message was visible in runtime composer/chat' },
      };
      // Operator resolution is still a confirmation, so the recorded pre-dispatch boundary
      // is carried across it for the same reason as on every other path: the baton reads
      // the boundary off the confirmed Delivery.
      delivery.confirmDelivered(withRecordedBoundary(evidence, delivery.evidence));
      await this.repos.deliveries.save(delivery);

      const runtime = await this.repos.runtimes.findById(delivery.targetRuntimeId);
      if (runtime) {
        runtime.recordObservationSuccess('working', evidence);
        await this.repos.runtimes.save(runtime);
      }

      await this.emitEvent('delivery', delivery.id, 'delivery.confirmed', {
        actor: 'recovery',
        previousState: 'ambiguous',
        newState: 'delivered',
        evidence,
      });
    } else {
      // mark failed so a new delivery/attempt can be created safely
      delivery.markFailed('Operator cancelled ambiguous attempt for clean retry');
      await this.repos.deliveries.save(delivery);

      await this.emitEvent('delivery', delivery.id, 'delivery.failed', {
        actor: 'recovery',
        previousState: 'ambiguous',
        newState: 'failed',
      });
    }

    // Resolve attention item for this assignment
    const openItems = await this.repos.attention.findOpen();
    for (const item of openItems) {
      if (item.assignmentId === delivery.assignmentId && item.type === 'ambiguous_delivery') {
        item.resolve();
        await this.repos.attention.save(item);
      }
    }

    return delivery;
  }

  /* ================================================================== *
   * S6 — Load & Activate / Make Idle
   *
   * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §4.2, §4.4, §4.5,
   * §5.2, §5.3, §9.5, §11.1, §11.2, §11.3, §11.4, §11.5; I-1, I-2, I-4, I-6, I-10, I-11.
   * ================================================================== */

  /**
   * S5 — resolve and verify ONE side, independently (freeze §11.3).
   *
   * This is the only place in the engine that contacts a provider while a Pair is
   * still IDLE, and it does so for exactly one purpose: to establish whether that
   * side's identity can be resolved. It is not a generic observation pass and it
   * is not a dispatch path.
   *
   * Per-side isolation is structural: a throw on one side cannot reach the other,
   * because each side is resolved inside its own try/catch and a caught failure
   * becomes `unknown` rather than propagating (§11.3).
   *
   * ## The `checked-and-negative` vs `could-not-check` line
   *
   * This is the single most important distinction in the operation, and it is I-6
   * made load-bearing:
   *
   *   `verified`    the provider confirmed the id           -> may activate
   *   `unknown`     no capability, or the read failed/       -> may activate, and
   *                 was inconclusive                         the side is REPORTED
   *   `mismatched`  / `absent`
   *                 the provider was asked and answered no  -> TERMINAL, stay IDLE
   *
   * §4.4 requires "resolvable identity on both sides". A side that positively
   * contradicts the binding fails that precondition and aborts. A side we could
   * not ask does not: LEVEL 0 ChatGPT can never be fully verified (§9.5), and
   * refusing to activate every ChatGPT Pair would make §11.3's per-side reporting
   * and §9.5's asymmetry requirement unreachable. The freeze resolves this
   * itself — §11.2 says a terminal failure ends at IDLE, and a side we cannot
   * query has not failed, it is unknown.
   */
  private async resolveSideIdentity(
    pair: Pair,
    sideRole: PairSideRole,
  ): Promise<PairSideIdentity> {
    const observedAt = Date.now();
    const runtimeSessionId = sideRole === 'planner' ? pair.plannerSessionId : pair.workerSessionId;

    // An unbound side cannot be addressed at all. This is a §4.4 precondition
    // ("both sides bound") and it is reported per side, never silently omitted.
    if (!runtimeSessionId) {
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType: sideRole === 'planner' ? 'chatgpt' : 'opencode',
        runtimeSessionId: null,
        externalSessionId: null,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'not_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason: `No ${sideRole} runtime is bound to this Pair, so there is no session to address`,
        evidence: null,
      };
    }

    const runtime = await this.repos.runtimes.findById(runtimeSessionId);
    if (!runtime) {
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType: sideRole === 'planner' ? 'chatgpt' : 'opencode',
        runtimeSessionId,
        externalSessionId: null,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'not_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason: `Bound ${sideRole} runtime ${runtimeSessionId} no longer exists`,
        evidence: null,
      };
    }

    const providerType = runtime.providerType;

    // §4.4 precondition "provider capabilities present". A provider that is not
    // registered at all is a genuine unmet precondition and aborts the operation
    // below, rather than being softened into a per-side `unknown`.
    let provider: IRuntimeProvider;
    try {
      provider = this.getProvider(providerType);
    } catch {
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType,
        runtimeSessionId,
        externalSessionId: runtime.externalSessionId ?? null,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'not_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason: `No provider is registered for '${providerType}', so the ${sideRole} side cannot be resolved`,
        evidence: null,
      };
    }

    // I-11: the address is the provider's own external session id. The shared
    // human-readable Pair Name is never used to identify anything.
    const externalSessionId = runtime.externalSessionId ?? null;
    if (!externalSessionId) {
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType,
        runtimeSessionId,
        externalSessionId: null,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'not_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason:
          `The ${sideRole} runtime has no external session id, so there is no provider-owned ` +
          'identity to address. Per I-11 a name is not a substitute.',
        evidence: null,
      };
    }

    // Does this provider expose ANY way to address and read ONE exact external session?
    // `resolveSideIdentity` is the provider-side resolver; the DOM-observation pair is the
    // other legitimate route (exact-session Open -> verified BrowserHandle -> real turns).
    const capabilityRoute = classifyExactSessionCapabilityRoute(provider);
    // Only the `resolver` route reaches this point (the other two returned above), so the
    // method is present; the assertion just carries that narrowing for the type checker.
    // Bound to `provider` on purpose. Detaching the method and calling it as a bare
    // function loses the receiver, so any implementation that touches `this` — which most
    // do, to record the call or read configuration — throws "cannot read properties of
    // undefined", and every side then silently degrades to `unknown` instead of `verified`.
    //
    // Resolved lazily because the capability branches below are evaluated AFTER this point.
    // A provider on the `dom_observation` or `none` route has no resolver at all, so
    // dereferencing `.bind` here would throw before those branches could report their own,
    // and correct, answer.
    const rawResolveIdentity = (provider as unknown as { resolveSideIdentity?: (rq: { externalSessionId: string | null; projectPath?: string }) => Promise<any> }).resolveSideIdentity;
    const resolveIdentity =
      typeof rawResolveIdentity === 'function' ? rawResolveIdentity.bind(provider) : undefined;

    // No identity capability of ANY kind on this provider: LEVEL 0. Reported as `unknown`,
    // never as a negative (§5.3, §9.5).
    if (capabilityRoute === 'none') {
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType,
        runtimeSessionId,
        externalSessionId,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'not_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason:
          `Provider '${providerType}' exposes no exact-session identity capability, so the ` +
          `${sideRole} side cannot be verified. This is a permanent capability gap ` +
          '(LEVEL 0), not a failed check (freeze §9.5, I-6).',
        evidence: null,
      };
    }

    // No provider-side identity resolver, BUT the provider CAN read the exact session's own
    // rendered turns. This is therefore NOT the permanent LEVEL 0 gap the old provider
    // surface implied: the side is verifiable in principle.
    //
    // Capability presence is recorded, verification is NOT. identity/verification/existence
    // all stay `unknown` and `observation` stays null until a real exact-session
    // observation succeeds, so nothing here can be mistaken for a decided verdict.
    if (capabilityRoute === 'dom_observation') {
      const dims = identityDimensionsForCapabilityRoute(capabilityRoute);
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType,
        runtimeSessionId,
        externalSessionId,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        // The union is frozen at {exact_session_verifiable, not_verifiable}, and
        // `not_verifiable` is defined as a PERMANENT provider property. Claiming permanence
        // for a provider that can demonstrably read the exact conversation would be false,
        // so the capability is reported affirmatively while every decided dimension stays
        // unknown. See DOM_EXACT_SESSION_IDENTITY_CAPABILITY.
        capability: dims.capability,
        observation: null,
        sourceCapability: dims.sourceCapability,
        observedAt,
        reason:
          `Provider '${providerType}' has no provider-side identity resolver, but it does expose ` +
          'exact-session DOM observation (captureTransportBoundary + ' +
          'readExactSessionTurnsForReconciliation), so this side IS addressable and verifiable ' +
          'in principle. Dimensions 1-3 remain `unknown` and no observation is recorded until a ' +
          'real exact-session observation succeeds: capability presence is not verification ' +
          '(freeze §9.5, I-6).',
        evidence: null,
      };
    }

    let projectPath: string | undefined;
    try {
      const project = await this.repos.projects.findById(pair.projectId);
      projectPath = project?.workerWorkspacePath ?? project?.canonicalPath ?? undefined;
    } catch {
      projectPath = undefined;
    }

    try {
      // Only the `resolver` route reaches here, which is the only one that leaves
      // `resolveIdentity` defined. Guarded anyway: without the guard a missing resolver
      // would surface as a TypeError reported as an unverifiable side, which hides the
      // real cause behind a plausible-looking answer.
      if (!resolveIdentity) {
        throw new Error(
          `Provider '${providerType}' reached the resolver call without a resolveSideIdentity capability.`,
        );
      }
      const resolution = await resolveIdentity({ externalSessionId, projectPath });
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType,
        runtimeSessionId,
        externalSessionId,
        identityState: resolution.identityState,
        identityValue: resolution.identityValue,
        verificationState: resolution.verificationState,
        verificationValue: resolution.verificationValue,
        existenceState: resolution.existenceState,
        capability: 'exact_session_verifiable',
        // Dimension 8: the capability name, never just the provider (§5.2, C-8).
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: resolution.sourceCapability || NO_IDENTITY_CAPABILITY,
        observedAt: resolution.observedAt || observedAt,
        reason: resolution.reason ?? null,
        evidence: resolution.evidence ?? null,
      };
    } catch (err: any) {
      // A thrown read is "could not check", never "not verified" (I-6).
      return {
        sessionPairId: pair.id,
        sideRole,
        providerType,
        runtimeSessionId,
        externalSessionId,
        identityState: 'unknown',
        identityValue: null,
        verificationState: 'unknown',
        verificationValue: null,
        existenceState: 'unknown',
        capability: 'exact_session_verifiable',
        // S2: S5 writes identity dimensions only, so dimensions 4-7 are honestly
        // absent rather than fabricated as `unknown` (I-6).
        observation: null,
        sourceCapability: NO_IDENTITY_CAPABILITY,
        observedAt,
        reason: `Identity resolution threw: ${err?.message ?? String(err)}`,
        evidence: null,
      };
    }
  }

  /**
   * S6 — `loadAndActivate(pairId)`.
   *
   * §4.4 preconditions, and how each is proven here:
   *
   *   Pair exists              -> `repos.pairs.findById` throws PAIR_NOT_FOUND.
   *   IDLE only (§11.4)        -> an ACTIVE pair returns outcome 'rejected'.
   *   Both sides bound         -> per-side `reason` names the unbound side; the
   *                              operation rejects and the pair stays IDLE.
   *   Provider capabilities    -> a registered provider is required per bound side.
   *     present                   An unregistered provider is a real precondition
   *                              failure and rejects. A REGISTERED provider with no
   *                              identity capability yields per-side `unknown`
   *                              (§9.5 LEVEL 0) and does not reject.
   *   Resolvable identity on   -> `verified` passes. `mismatched`/`absent` is a
   *   both sides                 checked-and-negative TERMINAL failure: the pair
   *                              stays IDLE (§11.2 "any terminal failure -> IDLE").
   *                              `unknown` does not reject, and is reported.
   *
   * ## What this deliberately does NOT do
   *
   * It does not derive readiness, does not persist any readiness value (I-5), does
   * not compare messages, and does not capture or read a checkpoint. Those are
   * S7/S8. See S6_LOAD_AND_ACTIVATE.md §2 for the §4.4-vs-§11.2 reading that puts
   * those clauses out of scope, and §3 for the "provider capabilities present" one.
   *
   * It is the ONLY operation permitted to move a Pair to ACTIVE. `startPair()`
   * remains execution authority only and never touches operational state
   * (N-16, N-18, I-9); on an IDLE Pair it refuses truthfully rather than becoming a
   * bridge into ACTIVE.
   */
  public async loadAndActivate(pairId: PairId): Promise<PairActivationResult> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const reject = async (
      reason: string,
      sides?: Record<PairSideRole, PairSideIdentity>,
    ): Promise<PairActivationResult> => {
      // A rejected activation leaves the pair exactly as it found it: IDLE (I-1).
      const current = await this.repos.pairs.findById(pairId);
      const resolvedSides = sides ?? (await this.readBothSides(pair));
      await this.emitEvent('pair', pairId, 'pair.activation_rejected', {
        actor: 'user',
        previousState: current?.operationalState ?? 'IDLE',
        newState: current?.operationalState ?? 'IDLE',
        details: {
          reason,
          planner: summariseSide(resolvedSides.planner),
          worker: summariseSide(resolvedSides.worker),
        },
      });
      return {
        pairId,
        outcome: 'rejected',
        operationalStateBefore: pair.operationalState,
        operationalStateAfter: current?.operationalState ?? 'IDLE',
        sides: resolvedSides,
        fullyVerified: false,
        reason,
      };
    };

    // §11.4: idempotent with respect to operational state. Re-running an activation
    // is an explicit retry, not an implicit side effect of calling again.
    if (pair.operationalState === 'ACTIVE') {
      return reject(
        'Pair is already ACTIVE. Re-running Load & Activate is rejected; a partial retry is a ' +
          'distinct explicit operation (freeze §11.4).',
      );
    }

    // §11.3: each side resolved independently. Sequential rather than parallel so
    // the provider spy ordering in tests is deterministic; the isolation is
    // structural, not an artefact of concurrency.
    const plannerSide = await this.resolveSideIdentity(pair, 'planner');
    const workerSide = await this.resolveSideIdentity(pair, 'worker');

    // Persist the evidence BEFORE deciding, so a rejected activation still leaves
    // durable last-known evidence for both sides (I-3). Make Idle preserves it (I-10).
    await this.repos.sideIdentities.save(plannerSide);
    await this.repos.sideIdentities.save(workerSide);

    const sides: Record<PairSideRole, PairSideIdentity> = {
      planner: plannerSide,
      worker: workerSide,
    };

    // §4.4 "both sides bound". An unbound side has nothing to address, so the
    // precondition cannot be met for that side.
    const unbound = PAIR_SIDE_ROLES.find((role) => sides[role].runtimeSessionId === null);
    if (unbound) {
      return reject(
        `Precondition failed: the ${unbound} side has no bound runtime, so its identity cannot ` +
          'be resolved (freeze §4.4 "both sides bound").',
        sides,
      );
    }

    // §4.4 "provider capabilities present". A provider that is not registered at
    // all is a configuration failure, distinct from a registered provider that
    // simply cannot verify (which stays `unknown`, §9.5).
    const unregistered = PAIR_SIDE_ROLES.find(
      (role) => sides[role].reason?.startsWith('No provider is registered'),
    );
    if (unregistered) {
      return reject(
        `Precondition failed: no provider is registered for the ${unregistered} side ` +
          '(freeze §4.4 "provider capabilities present").',
        sides,
      );
    }

    // "Resolvable identity on both sides". A checked-and-negative answer is a
    // terminal failure; `unknown` is not (see resolveSideIdentity's contract).
    const contradicted = PAIR_SIDE_ROLES.find(
      (role) =>
        sides[role].verificationState === 'mismatched' || sides[role].existenceState === 'absent',
    );
    if (contradicted) {
      return reject(
        `Precondition failed: the ${contradicted} side was checked by its provider and did not ` +
          'resolve to the bound identity, so Load & Activate ends at IDLE (freeze §4.4, §11.2).',
        sides,
      );
    }

    // Every surviving path is IDLE here (I-1: the transition is one-way and the
    // only writer is Pair.makeActive()).
    pair.makeActive('load_and_activate');
    await this.repos.pairs.save(pair);

    const fullyVerified = PAIR_SIDE_ROLES.every((role) => sides[role].verificationState === 'verified');

    await this.emitEvent('pair', pairId, 'pair.activated', {
      actor: 'user',
      previousState: 'IDLE',
      newState: 'ACTIVE',
      details: {
        // §9.5: the asymmetry is part of the record, not a UI afterthought.
        fullyVerified,
        planner: summariseSide(plannerSide),
        worker: summariseSide(workerSide),
        unverifiedSides: PAIR_SIDE_ROLES.filter((r) => sides[r].verificationState !== 'verified'),
      },
    });

    return {
      pairId,
      outcome: 'activated',
      operationalStateBefore: 'IDLE',
      operationalStateAfter: 'ACTIVE',
      sides,
      fullyVerified,
      // A null reason is honest here: a side recorded as `unknown` carries its own
      // reason on the side record itself.
      reason: null,
    };
  }

  /**
   * S6 — `makeIdle(pairId, reason)`.
   *
   * §11.2: provider contact **No**. §4.5 + I-10: it stops observation and
   * interaction and PRESERVES bindings, history, checkpoints, cursors, provenance
   * and last-known evidence. Idempotent.
   *
   * It does not delete or rewrite the per-side identity rows, because those are
   * the last-known evidence I-3 requires an IDLE Pair to be able to render.
   */
  public async makePairIdle(pairId: PairId, reason?: string): Promise<Pair> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const wasActive = pair.operationalState === 'ACTIVE';

    // Idempotent, and a no-op on an already-IDLE pair that still records the intent.
    pair.makeIdle(reason);
    await this.repos.pairs.save(pair);

    await this.emitEvent('pair', pairId, 'pair.idled', {
      actor: 'user',
      previousState: wasActive ? 'ACTIVE' : 'IDLE',
      newState: 'IDLE',
      details: { reason: reason ?? null, idempotent: !wasActive },
    });

    return pair;
  }

  /* ===================================================================== *
   * S2 — provider-neutral observation of one exact bound side
   * ===================================================================== */

  /**
   * S2 — `observeSide(pairId, sideRole)`.
   *
   * §11.2: state precondition `ACTIVE`, provider contact **yes**, changes
   * operational state **no**, and it "does not advance the checkpoint (§6.4)".
   *
   * ## I-2 comes first, before anything else
   *
   * The ACTIVE check is the second statement in the method, ahead of every
   * provider lookup. An IDLE Pair returns `outcome: 'refused'` with
   * `providerContacted: false` and never reaches `getProvider`. §7 of the S2 brief
   * is therefore a structural property of this method, not a convention.
   *
   * ## What observation deliberately does NOT touch
   *
   * It observes dimensions 4-7 and carries dimensions 1-3 forward from the
   * existing record UNCHANGED. It does not re-resolve identity, does not
   * recompute verification, does not rewrite operational state, does not derive
   * readiness (I-5), does not compare the two sides (I-7), and does not write any
   * checkpoint, cursor, attempt, delivery or handoff field. Those are the
   * boundaries §6.4 and the S2 non-goals draw, and the type system helps: this
   * method's only write is `sideIdentities.save`.
   */
  public async observeSide(pairId: PairId, sideRole: PairSideRole): Promise<SideObservationResult> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const stored = await this.repos.sideIdentities.find(pairId, sideRole);

    /* --- Resolve the binding LOCALLY, before the gate ------------------------
     *
     * Reading the local database is not external contact, so doing it ahead of
     * the I-2 check costs nothing in provider calls. It has to happen here
     * because the refusal path must also be able to tell whether the stored
     * record is even about the currently bound session: returning the previous
     * session's evidence as this side's "last-known" would be a lie, and I-3
     * requires the IDLE view to be truthful about what it is showing.
     */
    const runtimeSessionId = sideRole === 'planner' ? pair.plannerSessionId : pair.workerSessionId;
    const runtime = runtimeSessionId ? await this.repos.runtimes.findById(runtimeSessionId) : null;
    const externalSessionId = runtime?.externalSessionId ?? null;

    /* --- A stored record may describe a DIFFERENT session --------------------
     *
     * `updatePair()` rebinds a side to a different runtime and does not touch the
     * side-identity rows, so a row written before the rebind still names the
     * PREVIOUS session. That row is not this side's evidence any more. Two
     * things follow, and both are about truth rather than policy:
     *
     *   - its identity dimensions must not be carried forward or returned as if
     *     they described the newly bound session, and
     *   - its ordinal must NOT be used as the monotonic baseline, because an
     *     ordinal from a different session is not comparable with this one and
     *     would make a legitimate first observation of the new session look stale.
     *
     * The record is not deleted: the previous session's evidence stays on disk as
     * its own last-known truth, it is simply no longer offered as evidence about
     * THIS side. Rebinding itself is untouched — deciding when a rebind should
     * discard evidence belongs to the replacement contract
     * (SESSION_PAIR_REPLACEMENT.md, C-1), which is out of scope here.
     */
    const storedDescribesThisSession =
      stored !== null && externalSessionId !== null && stored.externalSessionId === externalSessionId;
    const prior = storedDescribesThisSession ? stored : null;
    const supersededNote =
      !storedDescribesThisSession && stored !== null
        ? ` The previously stored record described external session ` +
          `'${stored.externalSessionId ?? 'none'}', which this side is no longer bound to, so it is ` +
          'not reported as evidence for this side and was not used as an ordering baseline.'
        : '';

    /**
     * The single refusal path. It is reached ONLY before any provider is resolved,
     * which is what makes "zero provider contact" provable rather than asserted.
     */
    const refuse = (reason: string): SideObservationResult => {
      return {
        pairId,
        sideRole,
        outcome: 'refused',
        providerContacted: false,
        record: prior ?? this.neverObservedSide(pair, sideRole),
        reason: reason + supersededNote,
      };
    };

    // I-2. An IDLE Pair permits no external contact of any kind.
    if (!pair.isProviderContactPermitted()) {
      return refuse(
        `Pair is IDLE, so the ${sideRole} side was not observed and no provider was contacted ` +
          '(freeze I-2, I-3). Its stored last-known observation is still readable locally, but it ' +
          'is last-known evidence, not live state. Run Load & Activate to permit observation.',
      );
    }

    if (!runtimeSessionId) {
      return refuse(
        `The ${sideRole} side has no bound runtime, so there is no exact session to observe ` +
          '(freeze §4.4 "both sides bound").',
      );
    }

    if (!runtime) {
      return refuse(
        `The ${sideRole} runtime '${runtimeSessionId}' no longer exists, so there is nothing to observe.`,
      );
    }

    // I-11. The address is the provider's own external id. A name is never a
    // substitute, and an absent id is an honest refusal rather than a guess.
    if (!externalSessionId) {
      return refuse(
        `The ${sideRole} runtime has no external session id, so there is no provider-owned identity ` +
          'to observe. Per I-11 a name or window title is not a substitute.',
      );
    }

    let provider;
    try {
      provider = this.getProvider(runtime.providerType);
    } catch {
      // A provider that is not registered is a configuration failure. It is NOT a
      // negative observation, so nothing is persisted over the existing record.
      return refuse(
        `No provider is registered for '${runtime.providerType}', so the ${sideRole} side could not ` +
          'be observed. The existing last-known observation is unchanged.',
      );
    }

    // LEVEL 0 for this capability. Reported as unknown on every dimension, and
    // persisted, because "this provider cannot be observed" is durable truth worth
    // keeping (I-6, §5.3, C-8). It is never a fabricated negative.
    if (typeof provider.observeSide !== 'function') {
      const reading = this.unobservableReading(
        Date.now(),
        `Provider '${runtime.providerType}' exposes no observation capability, so the ${sideRole} ` +
          'side is unknown on every dimension. This is a permanent capability gap (LEVEL 0), not a ' +
          'failed read (freeze I-6, §5.3, C-8).',
      );
      const record = this.withObservation(prior, pair, sideRole, runtime, reading);
      await this.repos.sideIdentities.save(record);
      return {
        pairId,
        sideRole,
        outcome: 'observed',
        providerContacted: false,
        record,
        reason: reading.reason,
      };
    }

    let projectPath: string | undefined;
    try {
      const project = await this.repos.projects.findById(pair.projectId);
      projectPath = project?.workerWorkspacePath ?? project?.canonicalPath ?? undefined;
    } catch {
      projectPath = undefined;
    }

    let reading: SideObservationReading;
    let contacted = true;
    try {
      reading = await provider.observeSide({ externalSessionId, projectPath });
    } catch (err: any) {
      // A thrown read is "could not observe", never "observed as negative" (I-6).
      contacted = true;
      reading = this.unobservableReading(
        Date.now(),
        `The observation read threw: ${err?.message ?? String(err)}. Nothing is known about this ` +
          'side from this attempt (I-6).',
      );
    }

    /* --- §11 monotonicity: never let an older reading overwrite a newer one ---
     *
     * The ONLY accepted ordering primitive is the provider's own ordinal for this
     * one session. If either side lacks one, NO comparison is performed and the
     * reading is stored as-is: inventing an ordering — worst of all from a
     * timestamp, and certainly across two providers — is what I-7 forbids.
     */
    const priorOrdinal = prior?.observation?.message.ordinal ?? null;
    const nextOrdinal = reading.message.ordinal;
    const isStale =
      priorOrdinal !== null &&
      nextOrdinal !== null &&
      nextOrdinal < priorOrdinal;

    if (isStale) {
      // Reported, never hidden. The durable marker stays authoritative.
      return {
        pairId,
        sideRole,
        outcome: 'stale',
        providerContacted: contacted,
        record: prior!,
        reason:
          `The provider reported message ordinal ${nextOrdinal}, which is OLDER than the stored ` +
          `ordinal ${priorOrdinal} for this session, so the stored latest-observed marker was kept. ` +
          'Ordering uses only the provider\'s own within-session order (I-7).',
      };
    }

    const record = this.withObservation(prior, pair, sideRole, runtime, reading);
    await this.repos.sideIdentities.save(record);

    await this.emitEvent('pair', pairId, 'pair.side_observed', {
      actor: 'user',
      previousState: prior?.observation ? 'observed' : 'never-observed',
      newState: 'observed',
      details: {
        sideRole,
        providerType: runtime.providerType,
        externalSessionId,
        observationCapability: reading.observationCapability,
        reachabilityState: reading.reachabilityState,
        uiPresenceState: reading.uiPresenceState,
        activityState: reading.activityState,
        messageEvidenceState: reading.messageEvidenceState,
        messageRef: reading.message.ref,
        messageOrdinal: reading.message.ordinal,
        // §6.4: observation records what was seen. It does not acknowledge it.
        checkpointAdvanced: false,
        // Audit trail for the rebind case: a stored record that described a
        // different session was deliberately not carried forward.
        supersededPriorSession: !storedDescribesThisSession && stored !== null
          ? stored.externalSessionId ?? null
          : null,
      },
    });

    return {
      pairId,
      sideRole,
      outcome: 'observed',
      providerContacted: contacted,
      record,
      reason: (reading.reason ? reading.reason + ' ' : '') + supersededNote.trim(),
    };
  }

  /**
   * Carries dimensions 1-3 forward from the PRIOR record and attaches the new
   * dimensions 4-7 reading.
   *
   * Preserving 1-3 verbatim is the point: observation is a read of the CURRENT
   * state of a side, and re-deriving identity inside it would (a) double the
   * provider traffic, (b) risk regressing the S5 verdict with a weaker read, and
   * (c) blur the boundary between "who is this side" (S4/S5) and "what is it
   * doing now" (S2).
   *
   * `prior` is passed in already filtered to a record that describes the SAME
   * externally bound session; when it is null because the side was rebound, or
   * because nothing was ever stored, the identity dimensions are recorded as
   * unknown with a reason rather than invented or inherited from another session.
   */
  private withObservation(
    existing: PairSideIdentity | null,
    pair: Pair,
    sideRole: PairSideRole,
    runtime: { id: RuntimeSessionId; providerType: ProviderType; externalSessionId?: string | null },
    reading: SideObservationReading,
  ): PairSideIdentity {
    const base = existing ?? this.neverObservedSide(pair, sideRole);
    return {
      ...base,
      // Keep the S5 identity provenance current with the binding it describes, but
      // do not re-derive the states.
      providerType: runtime.providerType,
      runtimeSessionId: runtime.id,
      externalSessionId: runtime.externalSessionId ?? null,
      observation: reading,
    };
  }

  /** A record that says plainly that nothing is known about this side yet. */
  private neverObservedSide(pair: Pair, sideRole: PairSideRole): PairSideIdentity {
    return {
      sessionPairId: pair.id,
      sideRole,
      providerType: sideRole === 'planner' ? 'chatgpt' : 'opencode',
      runtimeSessionId: sideRole === 'planner' ? (pair.plannerSessionId ?? null) : (pair.workerSessionId ?? null),
      externalSessionId: null,
      identityState: 'unknown',
      identityValue: null,
      verificationState: 'unknown',
      verificationValue: null,
      existenceState: 'unknown',
      capability: 'not_verifiable',
      observation: null,
      sourceCapability: NO_IDENTITY_CAPABILITY,
      observedAt: Date.now(),
      reason: 'This side has never been observed by Load & Activate',
      evidence: null,
    };
  }

  /**
   * A reading in which every dimension is `unknown` because the provider could
   * not be asked (no capability, or a throw). Dimensions 8 and 9 are still
   * populated, because §5.2 makes an observation with no source or no time
   * invalid rather than defaulted.
   */
  private unobservableReading(at: number, reason: string): SideObservationReading {
    return {
      reachabilityState: 'unknown',
      uiPresenceState: 'unknown',
      activityState: 'unknown',
      messageEvidenceState: 'unknown',
      message: { ref: null, role: null, text: null, truncated: false, ordinal: null },
      observationCapability: NO_OBSERVATION_CAPABILITY,
      observedAt: at,
      validUntil: at + PROVISIONAL_OBSERVATION_VALIDITY_MS,
      reason,
      evidence: null,
    };
  }

  /**
   * Reads both sides for reporting, preferring persisted last-known evidence and
   * falling back to an explicit "never observed" record. A side is never omitted
   * from the result (§11.3).
   */
  private async readBothSides(pair: Pair): Promise<Record<PairSideRole, PairSideIdentity>> {
    const neverObserved = (sideRole: PairSideRole): PairSideIdentity => ({
      sessionPairId: pair.id,
      sideRole,
      providerType: sideRole === 'planner' ? 'chatgpt' : 'opencode',
      runtimeSessionId: sideRole === 'planner' ? (pair.plannerSessionId ?? null) : (pair.workerSessionId ?? null),
      externalSessionId: null,
      identityState: 'unknown',
      identityValue: null,
      verificationState: 'unknown',
      verificationValue: null,
      existenceState: 'unknown',
      capability: 'not_verifiable',
      // S2: an absent group, distinct from a group whose dimensions are unknown.
      observation: null,
      sourceCapability: NO_IDENTITY_CAPABILITY,
      observedAt: Date.now(),
      reason: 'This side has never been observed by Load & Activate',
      evidence: null,
    });

    const [planner, worker] = await Promise.all([
      this.repos.sideIdentities.find(pair.id, 'planner'),
      this.repos.sideIdentities.find(pair.id, 'worker'),
    ]);
    return {
      planner: planner ?? neverObserved('planner'),
      worker: worker ?? neverObserved('worker'),
    };
  }

  /* ===================================================================== *
   * S3 — Session Pair continuity and side checkpoints
   * ===================================================================== */

  /**
   * S3 — `computeContinuity(pairId)`.
   *
   * §11.2: state precondition: Any (callable whether IDLE or ACTIVE).
   * Changes operational state: No.
   * Provider contact: **No** (pure local read of durable observation and checkpoints; zero provider contact).
   *
   * Evaluates both bound sides against their latest respective checkpoints:
   * - If either side lacks a checkpoint baseline, that side is `unknown` and the Pair is `UNKNOWN`.
   * - Stable identity is NOT ordering: differing message refs without trustworthy ordinals evaluate to `unknown`.
   */
  public async computeContinuity(pairId: PairId): Promise<PairContinuityResult> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const [plannerObs, workerObs, plannerChk, workerChk] = await Promise.all([
      this.repos.sideIdentities.find(pairId, 'planner'),
      this.repos.sideIdentities.find(pairId, 'worker'),
      this.repos.sideCheckpoints.findLatest(pairId, 'planner'),
      this.repos.sideCheckpoints.findLatest(pairId, 'worker'),
    ]);

    const plannerEval = evaluateSideContinuity('planner', plannerObs, plannerChk);
    const workerEval = evaluateSideContinuity('worker', workerObs, workerChk);

    return classifyPairContinuity(pairId, plannerEval, workerEval);
  }

  /**
   * Phase D — `computePairReadiness(pairId)`.
   *
   * Derived readiness evaluation for a Pair.
   * Zero provider contact (pure evaluation of local persistence and continuity).
   *
   * ## This is a READ-ONLY DERIVED FACT, and it is not execution authority
   *
   * This method exists to answer "what does the current persisted evidence say", and it is
   * legitimate for that. It is NOT a gate, and no dispatch path may consult it. §8.3 `[FROZEN]`:
   * "Readiness describes observational sufficiency. It is **not** execution permission ... A
   * `ready` Pair is not thereby authorized to dispatch." §8.2 `[FROZEN]`: a persisted value
   * "may **never** gate, permit, or enable an action." The architectural fence in
   * `tests/pair_replacement_fence.test.ts` enforces the same rule against the app layer, and
   * an earlier revision of `dispatchAssignment` violated all three: it refused every dispatch
   * whose derived level was not `READY`, which both inverted the freeze and made dispatch
   * permanently impossible for any Pair with a Level-0 planner side.
   */
  public async computePairReadiness(pairId: PairId): Promise<PairReadinessAssessment> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const [plannerSession, workerSession, plannerObs, workerObs, continuity] = await Promise.all([
      pair.plannerSessionId ? this.repos.runtimes.findById(pair.plannerSessionId) : Promise.resolve(null),
      pair.workerSessionId ? this.repos.runtimes.findById(pair.workerSessionId) : Promise.resolve(null),
      this.repos.sideIdentities.find(pairId, 'planner'),
      this.repos.sideIdentities.find(pairId, 'worker'),
      this.computeContinuity(pairId),
    ]);

    return evaluatePairReadiness(pair, plannerSession, workerSession, plannerObs, workerObs, continuity);
  }

  /**
   * S3 — `captureInitialBaseline(pairId, sideRole, operatorId, auditReason?)`.
   *
   * Explicit operator establishment of the initial baseline checkpoint for one side.
   *
   * Preconditions:
   * - Pair must exist.
   * - Side must have an existing durable observation (`pair_side_identity`).
   * - Side must NOT already have an existing checkpoint baseline (throws CHECKPOINT_BASELINE_ALREADY_EXISTS).
   *
   * Fencing:
   * - ZERO provider contact.
   * - Changes operational state: No.
   * - Append-only record with authority kind 'INITIAL_BASELINE'.
   */
  public async captureInitialBaseline(
    pairId: PairId,
    sideRole: PairSideRole,
    operatorId: string,
    auditReason?: string,
  ): Promise<PairSideCheckpoint> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const existingCheckpoint = await this.repos.sideCheckpoints.findLatest(pairId, sideRole);
    if (existingCheckpoint) {
      throw new RelayDomainError(
        `Pair ${pairId} ${sideRole} side already has a checkpoint baseline (${existingCheckpoint.id}). ` +
          'Initial baseline can only be captured once per side. Use acknowledgeSideCheckpoint to advance.',
        CHECKPOINT_BASELINE_ALREADY_EXISTS,
      );
    }

    const obs = await this.repos.sideIdentities.find(pairId, sideRole);
    if (!obs || !obs.observation) {
      throw new RelayDomainError(
        `Pair ${pairId} ${sideRole} side has no durable observation. A baseline cannot be captured without prior observation.`,
        CHECKPOINT_OBSERVATION_REQUIRED,
      );
    }

    const checkpointId = createId<PairSideCheckpointId>('chk');
    const checkpoint: PairSideCheckpoint = {
      id: checkpointId,
      sessionPairId: pairId,
      sideRole,
      messageRef: obs.observation.message.ref,
      messageOrdinal: obs.observation.message.ordinal,
      messageText: obs.observation.message.text,
      externalSessionId: obs.externalSessionId,
      determinacy: obs.observation.message.ordinal !== null || obs.observation.message.ref !== null
        ? 'identified'
        : 'unverified',
      capturedAt: Date.now(),
      sourceProvider: obs.providerType,
      sourceCapability: obs.observation.observationCapability,
      authority: {
        kind: 'INITIAL_BASELINE',
        operatorId,
      },
      auditReason: auditReason || 'Explicit operator initial baseline capture',
    };

    await this.repos.sideCheckpoints.save(checkpoint);

    await this.emitEvent('pair', pairId, 'pair.side_checkpoint_captured', {
      actor: 'user',
      previousState: 'none',
      newState: 'checkpointed',
      details: {
        checkpointId,
        sideRole,
        authorityKind: 'INITIAL_BASELINE',
        operatorId,
        messageRef: checkpoint.messageRef,
        messageOrdinal: checkpoint.messageOrdinal,
      },
    });

    return checkpoint;
  }

  /**
   * S3 — `acknowledgeSideCheckpoint(pairId, sideRole, options)`.
   *
   * Explicit operator acknowledgment/reconciliation of advanced state for one side.
   *
   * Preconditions:
   * - Pair must exist.
   * - Side must already have a prior baseline checkpoint (throws CHECKPOINT_BASELINE_REQUIRED).
   * - Side must have an existing durable observation (throws CHECKPOINT_OBSERVATION_REQUIRED).
   *
   * Fencing:
   * - ZERO provider contact.
   * - Changes operational state: No.
   * - Append-only record with authority kind 'OPERATOR_ACKNOWLEDGED'.
   */
  public async acknowledgeSideCheckpoint(
    pairId: PairId,
    sideRole: PairSideRole,
    options: {
      operatorId: string;
      resolutionNote?: string;
      auditReason?: string;
    },
  ): Promise<PairSideCheckpoint> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const existingCheckpoint = await this.repos.sideCheckpoints.findLatest(pairId, sideRole);
    if (!existingCheckpoint) {
      throw new RelayDomainError(
        `Pair ${pairId} ${sideRole} side has no prior checkpoint baseline. Initial baseline must be established before acknowledging progress.`,
        CHECKPOINT_BASELINE_REQUIRED,
      );
    }

    const obs = await this.repos.sideIdentities.find(pairId, sideRole);
    if (!obs || !obs.observation) {
      throw new RelayDomainError(
        `Pair ${pairId} ${sideRole} side has no durable observation to acknowledge.`,
        CHECKPOINT_OBSERVATION_REQUIRED,
      );
    }

    const checkpointId = createId<PairSideCheckpointId>('chk');
    const checkpoint: PairSideCheckpoint = {
      id: checkpointId,
      sessionPairId: pairId,
      sideRole,
      messageRef: obs.observation.message.ref,
      messageOrdinal: obs.observation.message.ordinal,
      messageText: obs.observation.message.text,
      externalSessionId: obs.externalSessionId,
      determinacy: obs.observation.message.ordinal !== null || obs.observation.message.ref !== null
        ? 'identified'
        : 'unverified',
      capturedAt: Date.now(),
      sourceProvider: obs.providerType,
      sourceCapability: obs.observation.observationCapability,
      authority: {
        kind: 'OPERATOR_ACKNOWLEDGED',
        operatorId: options.operatorId,
        acknowledgedAt: Date.now(),
        resolutionNote: options.resolutionNote,
      },
      auditReason: options.auditReason || 'Explicit operator checkpoint acknowledgment',
    };

    await this.repos.sideCheckpoints.save(checkpoint);

    await this.emitEvent('pair', pairId, 'pair.side_checkpoint_captured', {
      actor: 'user',
      previousState: existingCheckpoint.id,
      newState: checkpointId,
      details: {
        checkpointId,
        sideRole,
        authorityKind: 'OPERATOR_ACKNOWLEDGED',
        operatorId: options.operatorId,
        resolutionNote: options.resolutionNote,
        messageRef: checkpoint.messageRef,
        messageOrdinal: checkpoint.messageOrdinal,
      },
    });

    return checkpoint;
  }

  /**
   * Read-only completed-turn observation operation.
   *
   * Preconditions:
   * - Obeys relay/provider authority: automated contact requires `relayState === RUNNING` and `operationalState === ACTIVE` (`pair.isAutomatedContactPermitted()`).
   * - Inspects the exact bound external session.
   * - Identifies latest COMPLETED assistant turn (ensuring generating/incomplete turns are never treated as completed).
   * - Preserves provider capability differences (OpenCode vs ChatGPT/Level 0; unavailable fields are explicitly null).
   * - Performs zero outbound transport.
   * - Persists observation durably.
   */
  public async observeCompletedTurn(
    pairId: PairId,
    sideRole: PairSideRole,
  ): Promise<CompletedTurnObservationResult> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const runtimeSessionId = sideRole === 'planner' ? pair.plannerSessionId : pair.workerSessionId;
    const runtime = runtimeSessionId ? await this.repos.runtimes.findById(runtimeSessionId) : null;
    const externalSessionId = runtime?.externalSessionId ?? null;

    const refuse = (reason: string): CompletedTurnObservationResult => ({
      pairId,
      sideRole,
      outcome: 'refused',
      providerContacted: false,
      turn: null,
      reason,
    });

    // Authority check (execution-authority realignment): this is an explicit
    // operator observation, so operationalState === ACTIVE is the gate.
    // Automated background contact is gated separately by relayState at the
    // supervision-tick level (runSupervisionTick / advancePairOrchestration
    // filter by pair.isAutomatedContactPermitted() before any contact), so an
    // ACTIVE Pair keeps its explicit observation path regardless of relayState.
    if (!pair.isProviderContactPermitted()) {
      return refuse(
        `Provider contact not permitted (operationalState: ${pair.operationalState}). ` +
          'Observation refused with zero provider contact.'
      );
    }

    if (!runtimeSessionId || !runtime || !externalSessionId) {
      return refuse(`Side ${sideRole} has no bound runtime or external session id.`);
    }

    let provider;
    try {
      provider = this.getProvider(runtime.providerType);
    } catch {
      return refuse(`No provider registered for ${runtime.providerType}.`);
    }

    if (typeof provider.observeSide !== 'function') {
      return refuse(`Provider ${runtime.providerType} exposes no observation capability.`);
    }

    let reading: SideObservationReading;
    try {
      const project = await this.repos.projects.findById(pair.projectId).catch(() => null);
      const projectPath = project?.workerWorkspacePath ?? project?.canonicalPath ?? undefined;
      reading = await provider.observeSide({ externalSessionId, projectPath });
    } catch (err: any) {
      return refuse(`Observation read failed: ${err?.message ?? String(err)}`);
    }

    // Persist via observeSide to keep pair_side_identity updated durably.
    await this.observeSide(pairId, sideRole);

    const isGenerating = reading.activityState === 'working';
    if (isGenerating) {
      return {
        pairId,
        sideRole,
        outcome: 'refused',
        providerContacted: true,
        turn: null,
        reason: 'Observed turn is currently generating/in-progress; not treated as completed.',
      };
    }

    if (reading.messageEvidenceState === 'none' || reading.messageEvidenceState === 'unknown') {
      return {
        pairId,
        sideRole,
        outcome: 'refused',
        providerContacted: true,
        turn: null,
        reason: `No completed message evidence found (state: ${reading.messageEvidenceState}).`,
      };
    }

    const msg = reading.message;
    const contentText = msg.text ?? '';
    const contentFingerprint = contentText ? `${contentText.substring(0, 64)}_${contentText.length}` : null;

    const turn: CompletedTurnObservation = {
      sessionPairId: pairId,
      sideRole,
      runtimeSessionId,
      externalSessionId,
      externalMessageId: msg.ref,
      ordinal: msg.ordinal,
      completedAt: reading.observedAt,
      contentFingerprint,
      observedAt: Date.now(),
      isGenerating: false,
      determinacy: msg.ref !== null || msg.ordinal !== null ? 'identified' : 'unverified',
      sourceProvider: runtime.providerType,
      reason: reading.reason,
    };

    return {
      pairId,
      sideRole,
      outcome: 'observed',
      providerContacted: true,
      turn,
      reason: 'Completed turn successfully observed.',
    };
  }


  /* ================================================================== *
   * RELAY BATON — who owes the next completed turn
   * ================================================================== */

  /**
   * Assemble the Pair's confirmed-Delivery links and derive the baton.
   *
   * The baton is never stored; it is recomputed from `deliveries` on every evaluation, so
   * there is no mutable holder that a crash could leave stale. See `domain/baton.ts`.
   *
   * Chain order uses the engine's existing deterministic `(createdAt, id)` Assignment
   * ordering purely to SEQUENCE the links. No state decision depends on it: confirmed-ness
   * comes from `status`, the recipient comes from `assignment.targetSideRole`, and the
   * boundary comes from the Delivery's own recorded message-id set.
   */
  public async derivePairBaton(pair: Pair): Promise<RelayBaton> {
    const assignments = (await this.repos.assignments.findByPairId(pair.id))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    const chainIndex = new Map<AssignmentId, number>();
    assignments.forEach((assignment, index) => chainIndex.set(assignment.id, index));

    const links: RelayBatonLink[] = [];
    for (const assignment of assignments) {
      for (const delivery of await this.repos.deliveries.findByAssignmentId(assignment.id)) {
        const recorded = extractRecordedWatermark(delivery.evidence);
        links.push({
          delivery,
          assignment,
          attempt: await this.repos.attempts.findById(delivery.attemptId),
          chainIndex: chainIndex.get(assignment.id) ?? 0,
          boundary: recorded
            ? {
                sessionId: recorded.sessionId,
                messageIds: recorded.messageIds,
                messageCount: recorded.messageCount,
                capturedAt: recorded.capturedAt,
                provenance: recorded.provenance,
              }
            : null,
        });
      }
    }

    return deriveRelayBaton({
      links,
      // Step 3 of the precedence list: a Delivery aimed at a session this Pair is no longer
      // bound to is not part of the CURRENT chain and cannot hold the baton.
      boundRuntimeIds: {
        ...(pair.plannerSessionId ? { planner: pair.plannerSessionId } : {}),
        ...(pair.workerSessionId ? { worker: pair.workerSessionId } : {}),
      },
    });
  }

  /** The runtime/provider/external-id triple for one Pair side, or why it is unusable. */
  private async resolveBatonSide(
    pair: Pair,
    sideRole: PairSideRole,
    trail: string[] = [],
  ): Promise<
    | {
        ok: true;
        sideRole: PairSideRole;
        runtime: RuntimeSession;
        runtimeSessionId: RuntimeSessionId;
        externalSessionId: string;
        provider: IRuntimeProvider | null;
        providerFailure: string | null;
        canReadTranscript: boolean;
        canConfirmReachability: boolean;
      }
    | { ok: false; sideRole: PairSideRole; failure: string }
  > {
    const runtimeSessionId = sideRole === 'planner' ? pair.plannerSessionId : pair.workerSessionId;
    if (!runtimeSessionId) {
      return {
        ok: false,
        sideRole,
        failure: `The ${sideRole} side has no bound runtime session, so there is no exact session to address.`,
      };
    }
    const runtime = await this.repos.runtimes.findById(runtimeSessionId);
    if (!runtime) {
      return {
        ok: false,
        sideRole,
        failure: `The ${sideRole} runtime '${runtimeSessionId}' no longer exists.`,
      };
    }

    // I-11. A name or window title is never a substitute for the provider's own id.
    // Checked BEFORE the terminal-state gate, because the authoritative re-address below is
    // only meaningful when there is a provider-owned id to address.
    if (!runtime.externalSessionId) {
      return {
        ok: false,
        sideRole,
        failure: `The ${sideRole} runtime carries no external session id, so there is no provider-owned identity to address.`,
      };
    }

    /* ------------------------------------------------------------------------ *
     * The terminal-state gate, rewritten.
     *
     * THE DEFECT THIS REMOVES
     * ------------------------
     * This used to refuse outright:
     *
     *     if (runtime.status === 'terminated') return { ok: false, ... }
     *
     * That conflated two unrelated things. `terminated` is reached ONLY through
     * `RuntimeSession.recordObservationFailure`, i.e. by counting consecutive failures of
     * RelayX's OWN probes (`inspectRuntime` -> AppleScript window/process enumeration).
     * That answers "can I currently see this application?", which is a fact about RelayX's
     * observation channel — not about whether the provider-owned conversation still exists.
     *
     * The two diverge constantly: a probe times out, Accessibility permission lapses, the
     * app relaunches under a new pid, or the conversation lives in a browser while the probe
     * enumerates a native process. In every such case the conversation is intact while the
     * status says `terminated`.
     *
     * Worse, the refusal was ABSORBING. It returned before any observation was attempted, and
     * the only call that can move a runtime out of `terminated` (`inspectRuntime`, via
     * `reconcileAndRecoverRuntime` / `RelayApiService.observeRuntime`) is operator- or
     * UI-triggered and is never invoked by `runSupervisionTick` or `recoverOnStartup`. So one
     * bad run of three probes permanently wedged the relay: the live "RelayX Development"
     * Pair sat at `session_identity_unproven` with a fully recorded external conversation id
     * that RelayX refused to address, while the conversation was live and readable.
     *
     * THE REPLACEMENT
     * ---------------
     * A locally-derived terminal belief may no longer answer the question "may this side be
     * addressed?". That question is now answered by the AUTHORITATIVE conversation
     * read: RelayX asks the provider whether THIS exact conversation is reachable, and only
     * refuses when the provider cannot confirm it.
     *
     *   - provider confirms  -> `recordExternalRevival` leaves the terminal state on positive
     *     evidence, the Pair keeps its existing Assignment/Handoff lifecycle, and the caller
     *     proceeds to the normal identity check. Nothing is resent and nothing is created.
     *   - provider says no   -> the conversation is genuinely gone; refusing is correct and the
     *     reason now names the conversation rather than a local status.
     *   - provider can't say -> refusing is correct, reported as "could not check" so it is
     *     never mistaken for a dead conversation (I-6, C-8).
     *
     * IDEMPOTENCE: revival is driven by the evidence, not by a counter, so repeated restarts
     * and repeated ticks converge. A runtime that is revived takes the ordinary path from then
     * on; one that cannot be revived is refused with no state change, so it cannot churn.
     * ------------------------------------------------------------------------ */
    if (runtime.isObservationallyTerminal()) {
      const revival = await this.tryReviveTerminalRuntime(pair, sideRole, runtime);

      if (revival.revived) {
        trail.push(
          `the ${sideRole} runtime was in the locally-derived terminal state, but the provider ` +
            `confirmed conversation '${runtime.externalSessionId}' is still reachable ` +
            `(${revival.observedConversationId ?? 'n/a'}), so the runtime was revived on that ` +
            'evidence and the terminal state is no longer treated as external truth',
        );
        // `runtime` is mutated in place by the revival, and re-persisted inside the helper.
      } else if (revival.contradicted) {
        return {
          ok: false,
          sideRole,
          failure:
            `The ${sideRole} runtime's conversation '${runtime.externalSessionId}' no longer exists ` +
            `(the provider reports it resolves to '${revival.observedConversationId ?? 'no conversation'}'). ` +
            'RelayX will not address a conversation that is gone; use runtime replacement with a ' +
            'PairCheckpoint to continue this chain.',
        };
      } else {
        return {
          ok: false,
          sideRole,
          failure:
            `The ${sideRole} runtime is in the locally-derived terminal state and RelayX could not ` +
            `establish whether its conversation '${runtime.externalSessionId}' still exists ` +
            `(${revival.detail}). "Could not check" is not "checked and found gone", so RelayX ` +
            'refuses to address it and does not conclude the conversation was terminated.',
        };
      }
    }

    let provider: IRuntimeProvider | null = null;
    let providerFailure: string | null = null;
    try {
      provider = this.getProvider(runtime.providerType);
    } catch (err: any) {
      providerFailure = `No provider is registered for '${runtime.providerType}': ${err?.message ?? String(err)}`;
    }

    return {
      ok: true,
      sideRole,
      runtime,
      runtimeSessionId,
      externalSessionId: runtime.externalSessionId,
      provider,
      providerFailure,
      canReadTranscript: typeof provider?.readExactSessionTurnsForReconciliation === 'function',
      canConfirmReachability: typeof provider?.confirmExactSessionReachable === 'function',
    };
  }

  /**
 * The title of the single open "this runtime is not readable" operator task for a runtime.
 *
 * The runtime ID is in the title deliberately, and it is load-bearing rather than decorative. On
 * the live "RelayX Development" Pair BOTH runtimes are named `RelayX Development`, so a key built
 * from the name alone cannot tell the Planner's unreadable transcript from the Worker's. Matching
 * on the name would let a successful Worker read resolve the Planner's open task — silencing the
 * wrong side and leaving the real one reported. `AttentionItem` carries no free-form key field, so
 * the title is the only place an exact discriminator can live.
 */
private runtimeSuspensionTitle(sideRole: PairSideRole, runtime: RuntimeSession): string {
  const side = sideRole === 'worker' ? 'Worker' : 'Planner';
  return `${side} runtime '${runtime.name}' is not currently readable [${runtime.id}]`;
}

/**
 * Does this open operator task report THIS runtime as unreadable, within THIS pair?
 *
 * Exact match on the runtime id embedded by `runtimeSuspensionTitle`, with a deliberate fallback
 * for tasks written before the id was included. Those legacy titles said "...temporarily
 * unavailable" and always said "Worker" regardless of the side, so the fallback additionally
 * requires the side label to agree with the runtime actually being observed — otherwise a stale
 * Planner task would be silently resolved by a healthy Worker's read.
 *
 * The fallback exists because a resolver that cannot match what is already in a real operator's
 * queue leaves exactly the stale tasks this whole change is about.
 */
private isRuntimeSuspensionItemFor(
    item: { type: string; pairId?: string; title: string },
    pairId: PairId,
    sideRole: PairSideRole,
    runtime: RuntimeSession,
  ): boolean {
    if (item.type !== 'runtime_suspended' || item.pairId !== pairId) return false;
    if (item.title.includes(`[${runtime.id}]`)) return true;
    const side = sideRole === 'worker' ? 'Worker' : 'Planner';
    return item.title.startsWith(`${side} runtime`) && item.title.includes(`'${runtime.name}'`);
  }

  /**
   * Resolve every open "this runtime is not readable" task for a runtime that has just been read.
   *
   * A readable transcript is the answer to the doubt the task recorded. Leaving it open after the
   * answer arrives reports a settled question as a live problem, and an operator queue that
   * over-reports is a queue nobody reads.
   */
  private async resolveRuntimeSuspensionItems(
    pairId: PairId,
    sideRole: PairSideRole,
    runtime: RuntimeSession,
  ): Promise<number> {
    let resolved = 0;
    for (const item of await this.repos.attention.findOpen()) {
      if (this.isRuntimeSuspensionItemFor(item, pairId, sideRole, runtime)) {
        item.resolve();
        await this.repos.attention.save(item);
        resolved += 1;
      }
    }
    return resolved;
  }

  /**
   * Ask the provider whether ONE exact conversation is still reachable, and revive an
   * observationally-terminal runtime when the answer is yes.
   *
   * Returns the three outcomes that must stay distinguishable:
   *   - `revived: true`      — authoritative evidence said the conversation is there.
   *   - `contradicted: true` — the provider answered and the conversation is NOT there.
   *   - neither              — nobody could answer ("could not check", I-6).
   *
   * This never resends anything, never mints an Attempt, never writes an Assignment status
   * and never touches the baton. It moves exactly one field: the runtime's own liveness status,
   * and only on positive external evidence.
   */
  private async tryReviveTerminalRuntime(
    pair: Pair,
    sideRole: PairSideRole,
    runtime: RuntimeSession,
  ): Promise<
    | { revived: true; contradicted: false; observedConversationId: string | null; detail: string }
    | { revived: false; contradicted: true; observedConversationId: string | null; detail: string }
    | {
        revived: false;
        contradicted: false;
        observedConversationId: string | null;
        detail: string;
      }
  > {
    const externalSessionId = runtime.externalSessionId!;

    let provider: IRuntimeProvider;
    try {
      provider = this.getProvider(runtime.providerType);
    } catch (err: any) {
      return {
        revived: false,
        contradicted: false,
        observedConversationId: null,
        detail: `no provider is registered for '${runtime.providerType}' (${
          err?.message ?? String(err)
        })`,
      };
    }

    if (typeof provider.confirmExactSessionReachable !== 'function') {
      // A capability gap is not a dead conversation. Reported as "could not check" so the
      // refusal that follows is never read as proof the conversation ended (LEVEL 0, §9.5).
      return {
        revived: false,
        contradicted: false,
        observedConversationId: null,
        detail: `provider '${runtime.providerType}' exposes no exact-conversation reachability check`,
      };
    }

    let verdict: Awaited<ReturnType<NonNullable<IRuntimeProvider['confirmExactSessionReachable']>>>;
    try {
      verdict = await provider.confirmExactSessionReachable(externalSessionId, runtime.sessionUrl);
    } catch (err: any) {
      return {
        revived: false,
        contradicted: false,
        observedConversationId: null,
        detail: `the reachability check threw: ${err?.message ?? String(err)}`,
      };
    }

    if (verdict.failure) {
      return {
        revived: false,
        contradicted: false,
        observedConversationId: verdict.conversationId ?? null,
        detail: verdict.failure,
      };
    }

    if (!verdict.reachable) {
      return {
        revived: false,
        contradicted: true,
        observedConversationId: verdict.conversationId ?? null,
        detail: 'the provider positively reported the conversation as absent',
      };
    }

    const evidence: ObservableEvidence =
      verdict.evidence ??
      ({
        id: `ev_readdress_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: runtime.id,
        details: {
          method: 'exact_conversation_readdress',
          externalSessionId,
          observedConversationId: verdict.conversationId,
        },
      } as ObservableEvidence);

    const previousStatus = runtime.status;
    runtime.recordExternalRevival('available', evidence, runtime.windowTitle, runtime.applicationPid);
    await this.repos.runtimes.save(runtime);

    await this.emitEvent('runtime', runtime.id, 'runtime.revived', {
      actor: 'recovery',
      previousState: previousStatus,
      newState: runtime.status,
      evidence,
      details: {
        reason: 'authoritative conversation reachability confirmed',
        pairId: pair.id,
        sideRole,
        externalSessionId,
        observedConversationId: verdict.conversationId,
      },
    });

    // An open "this runtime is not readable" item for THIS runtime is answered by this evidence.
    // Scoped by the same matcher the supervision path uses: reviving the Planner must not resolve
    // the Worker's operator task (or an unrelated Pair's), which is what resolving every
    // assignment-less `runtime_suspended` item in the database used to do.
    await this.resolveRuntimeSuspensionItems(pair.id, sideRole, runtime);

    return {
      revived: true,
      contradicted: false,
      observedConversationId: verdict.conversationId ?? null,
      detail: 'confirmed reachable by the provider',
    };
  }

  /**
   * Read the baton owner's exact session and classify ONLY its mechanical state.
   *
   * Three questions are answered, and nothing else:
   *   - is a newer assistant turn still unfinished (no provider terminator)?
   *   - does a completed assistant turn exist strictly after the recorded boundary?
   *   - did the provider itself report the session as working?
   *
   * It never asks whether the content is right. The boundary is the Delivery's own recorded
   * message-id set, so "after the boundary" is decided by provider message id and never by
   * comparing timestamps.
   */
  /**
   * Observe the Planner side with the in-page Planner Observer.
   *
   * Replaces the transcript read for this side only. Everything downstream — the "still working"
   * vs "completed turn" decision, the Handoff, the opposite-side Assignment and the Delivery —
   * is the existing code path, untouched.
   *
   * ## Why armed-but-silent is `inFlight: true`
   *
   * A transcript read that finds nothing after the boundary means "the run finished without
   * producing a turn", and the relay answers that with a recovery notice. An observer that is
   * ARMED but has not yet seen `working` means something entirely different: the instruction was
   * delivered and the Planner has simply not answered yet. Reporting `inFlight: false` there
   * would fire a recovery notice on every tick of a perfectly normal wait. So while the arm is
   * live and no completion has been observed, the run is reported in flight — which is exactly
   * what it is.
   *
   * ## Exactly-once
   *
   * The observer's boundary is the set of assistant turn keys present at arm time, so a response
   * can only ever be reported if it appeared after that snapshot. The completion is then written
   * to durable event history immediately, keyed by arm id, so a restart resumes from the record
   * instead of re-arming over a response that already exists.
   */
  private async observePlannerWithObserver(
    side: {
      sideRole: PairSideRole;
      runtime: RuntimeSession;
      runtimeSessionId: RuntimeSessionId;
      externalSessionId: string;
    },
    batonDeliveryId?: DeliveryId,
  ): Promise<{
    report: BatonOwnerObservationReport;
    completion: WorkerCompletionObservation | null;
  }> {
    const conversationId = side.externalSessionId;
    const base: BatonOwnerObservationReport = {
      sideRole: side.sideRole,
      runtimeSessionId: side.runtimeSessionId,
      providerType: side.runtime.providerType,
      externalSessionId: conversationId,
      transcriptReadable: false,
      transcriptReadFailure: null,
      boundarySource: 'observer_arm_baseline',
      boundaryAnchorMessageId: null,
      assistantTurnCountAfterBoundary: null,
      inFlight: null,
      providerReportedWorking: null,
      hasCompletedResponse: null,
      capturedResponseIsNewest: null,
      completedTurnMessageId: null,
      completedTurnFinish: null,
      completedTurnTextLength: null,
      terminalErrorType: null,
    };

    // Already recorded and not yet handed on: this is the restart path. Re-arming here would
    // re-baseline the observer OVER a response that already exists and lose it.
    const recorded =
      this.plannerObserver && batonDeliveryId
        ? await this.findRecordedPlannerCompletion(batonDeliveryId)
        : null;
    if (recorded) {
      return this.plannerCompletionObservation(base, conversationId, recorded.text, {
        source: 'recorded_planner_observer_completion',
        armId: recorded.armId,
        turnKey: recorded.turnKey,
        hash: recorded.hash,
      });
    }

    // Non-null by construction: this method is only reached when a client exists, but the field is
    // optional, so bind it once rather than asserting at each use.
    const observer = this.plannerObserver;
    if (!observer || !batonDeliveryId) {
      return {
        report: { ...base, boundarySource: 'unavailable', transcriptReadFailure: 'no observer client' },
        completion: null,
      };
    }

    let arm: PlannerObserverArm;
    let status: PlannerObserverStatus;
    try {
      arm = await observer.ensureArmed(
        conversationId,
        `baton delivery ${batonDeliveryId}`,
        batonDeliveryId,
      );
      status = await observer.status(conversationId, batonDeliveryId);
    } catch (err) {
      return {
        report: {
          ...base,
          boundarySource: 'unavailable',
          transcriptReadFailure:
            `The Planner Observer could not be armed or read: ${(err as Error).message}. ` +
            'RelayX did not fall back to opening, focusing or navigating the Planner tab.',
        },
        completion: null,
      };
    }

    if (!status.available) {
      return {
        report: {
          ...base,
          boundarySource: 'unavailable',
          transcriptReadFailure:
            `The Planner Observer bridge is unreachable: ${status.unavailableReason ?? 'no reason given'}. ` +
            '"Could not check" is not "checked and found nothing", so no turn is claimed and no ' +
            'recovery notice is emitted.',
        },
        completion: null,
      };
    }

    if (status.completion) {
      const completion = status.completion;
      // Persist BEFORE handing on. The record is what makes restart-resume exact rather than
      // best-effort: a restart reads this back instead of re-arming over the finished response.
      if (batonDeliveryId) {
        await this.recordPlannerCompletion(batonDeliveryId, arm.armId, completion);
      }
      return this.plannerCompletionObservation(
        base,
        conversationId,
        completion.responseText,
        {
          source: 'observer_arm_baseline',
          armId: completion.armId,
          turnKey: completion.completedTurnKey,
          hash: completion.responseHash,
        },
        status.working,
      );
    }

    // Armed, no completion yet: the instruction was delivered and the Planner has not answered.
    //
    // This is returned as a real in-flight completion rather than `null`, because the existing
    // decision path treats a null completion as "the session could not be read" and would report
    // `transcript_unreadable` on every tick of a perfectly normal wait. `inFlight: true` is not a
    // convenience here, it is the accurate description: the turn is still running.
    return {
      report: {
        ...base,
        transcriptReadable: true,
        boundaryAnchorMessageId: arm.armId,
        inFlight: true,
        providerReportedWorking: status.working,
        hasCompletedResponse: false,
        capturedResponseIsNewest: false,
      },
      completion: {
        boundary: {
          source: 'observer_arm_baseline',
          recordedAnchorMessageId: arm.armId,
          instructionTurnId: null,
          instructionTurnCreatedAt: null,
          instructionMatchKind: 'none',
          callerAfterCreatedAt: null,
        },
        assistantTurnCount: 0,
        hasCompletedResponse: false,
        inFlight: true,
        newestAssistantMessageId: null,
        response: null,
        capturedResponseIsNewest: false,
        terminalError: null,
        unreadableMiddle: false,
        chronologicalOrderDerived: false,
      },
    };
  }

  /** Project an observer-produced response into the shape the existing decision path expects. */
  private plannerCompletionObservation(
    base: BatonOwnerObservationReport,
    conversationId: string,
    text: string,
    meta: {
      source: 'observer_arm_baseline' | 'recorded_planner_observer_completion';
      armId: string;
      turnKey: string | null;
      hash: string;
    },
    providerReportedWorking: boolean | null = false,
  ): {
    report: BatonOwnerObservationReport;
    completion: WorkerCompletionObservation;
  } {
    // The observer has already established this is the response produced after the arm point,
    // and it is by construction the newest turn it reported, so newest-ness is known here rather
    // than inferred from a transcript window.
    const messageId = meta.turnKey ?? `observer:${meta.hash}`;
    return {
      report: {
        ...base,
        transcriptReadable: true,
        boundarySource: 'observer_arm_baseline',
        boundaryAnchorMessageId: meta.armId,
        assistantTurnCountAfterBoundary: 1,
        inFlight: false,
        providerReportedWorking,
        hasCompletedResponse: true,
        capturedResponseIsNewest: true,
        completedTurnMessageId: messageId,
        completedTurnFinish: 'stop',
        completedTurnTextLength: text.length,
      },
      completion: {
        boundary: {
          source: 'observer_arm_baseline',
          recordedAnchorMessageId: meta.armId,
          instructionTurnId: null,
          instructionTurnCreatedAt: null,
          instructionMatchKind: 'none',
          callerAfterCreatedAt: null,
        },
        assistantTurnCount: 1,
        hasCompletedResponse: true,
        inFlight: false,
        newestAssistantMessageId: messageId,
        response: {
          messageId,
          createdAt: null,
          completedAt: null,
          text,
          finish: 'stop',
        },
        capturedResponseIsNewest: true,
        terminalError: null,
        unreadableMiddle: false,
        chronologicalOrderDerived: false,
      },
    };
  }

  /** The durable record of one observed Planner completion, keyed by Delivery. */
  private async recordPlannerCompletion(
    deliveryId: DeliveryId,
    armId: string,
    completion: { responseText: string; responseHash: string; completedTurnKey: string | null },
  ): Promise<void> {
    const { events } = await this.repos.events.findFiltered({
      resourceType: 'delivery',
      resourceId: deliveryId,
      eventType: 'planner_observer.completed',
      limit: 10,
    });
    if (events.some((e) => e.details?.armId === armId)) return;
    await this.emitEvent('delivery', deliveryId, 'planner_observer.completed', {
      actor: 'supervisor',
      details: {
        armId,
        // The text is kept here on purpose: it is the only reason a restart can resume this
        // baton without re-arming the observer over a response that already exists.
        responseText: completion.responseText,
        responseHash: completion.responseHash,
        responseLength: completion.responseText.length,
        turnKey: completion.completedTurnKey,
      },
      evidence: {
        id: `ev_planner_obs_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        details: { phase: 'planner_observer_completion', armId },
      },
    });
  }

  /**
   * Read back a Planner completion that was already observed for this Delivery.
   *
   * This is what lets a restart resume the relay without replaying an already-confirmed message:
   * the response text lives in event history, so it does not need the observer to still be armed.
   */
  private async findRecordedPlannerCompletion(
    deliveryId: DeliveryId,
  ): Promise<{ armId: string; text: string; hash: string; turnKey: string | null } | null> {
    const { events } = await this.repos.events.findFiltered({
      resourceType: 'delivery',
      resourceId: deliveryId,
      eventType: 'planner_observer.completed',
      limit: 50,
    });
    if (!events.length) return null;
    const latest = events[events.length - 1];
    const armId = String(latest.details?.armId ?? '');
    const hash = String(latest.details?.responseHash ?? '');
    const turnKey = (latest.details?.turnKey as string | null) ?? null;
    // The response text itself is carried on the Handoff once transferred, so the event records
    // identity and the hash rather than a second copy of a large body.
    const text = (latest.details?.responseText as string | undefined) ?? '';
    if (!armId || !text) return null;
    return { armId, text, hash, turnKey };
  }

  private async observeBatonOwner(
    side: {
      sideRole: PairSideRole;
      runtime: RuntimeSession;
      runtimeSessionId: RuntimeSessionId;
      externalSessionId: string;
      provider: IRuntimeProvider | null;
      canReadTranscript: boolean;
    },
    boundary: BatonBoundary | null,
    batonDeliveryId?: DeliveryId,
  ): Promise<{
    report: BatonOwnerObservationReport;
    completion: WorkerCompletionObservation | null;
  }> {
    const base: BatonOwnerObservationReport = {
      sideRole: side.sideRole,
      runtimeSessionId: side.runtimeSessionId,
      providerType: side.runtime.providerType,
      externalSessionId: side.externalSessionId,
      transcriptReadable: false,
      transcriptReadFailure: null,
      boundarySource: null,
      boundaryAnchorMessageId: null,
      assistantTurnCountAfterBoundary: null,
      inFlight: null,
      providerReportedWorking: null,
      hasCompletedResponse: null,
      capturedResponseIsNewest: null,
      completedTurnMessageId: null,
      completedTurnFinish: null,
      completedTurnTextLength: null,
      terminalErrorType: null,
    };

    // The Planner side is watched by the in-page Planner Observer, never by an AppleScript
    // transcript read. Two reasons, both measured on the live pair:
    //
    //  1. ChatGPT's per-turn text fragments live in a DISJOINT part of the DOM from its
    //     `[data-turn-key]` turn containers, so an AppleScript read recovers no turn ids and
    //     therefore no boundary at all.
    //  2. The observer's ARM-time snapshot of assistant turn keys IS a real recorded boundary,
    //     which is exactly what `observeWorkerCompletion` needs — without reconstructing history.
    //
    // This runs BEFORE the boundary and suspension checks because it is a different read path
    // with its own availability semantics: it must not be skipped just because an older
    // transcript-based read left the runtime `suspended`.
    if (this.plannerObserver && side.sideRole === 'planner' && side.runtime.providerType === 'chatgpt') {
      return await this.observePlannerWithObserver(side, batonDeliveryId);
    }

    if (!boundary) {
      return {
        report: {
          ...base,
          transcriptReadFailure:
            'No pre-dispatch message-id boundary was recorded on the establishing Delivery, so ' +
            '"after the boundary" cannot be decided by message id. RelayX does not substitute a ' +
            'timestamp here.',
        },
        completion: null,
      };
    }

    if (!side.provider || !side.canReadTranscript) {
      return {
        report: {
          ...base,
          transcriptReadFailure:
            `Provider '${side.runtime.providerType}' exposes no exact-session transcript read, ` +
            'so no authoritative turn list is available.',
        },
        completion: null,
      };
    }

    // A bounded backoff so a runtime that has only just gone missing is not re-probed on
    // every tick. It changes nothing about the decision, only about how often the same
    // unanswerable question is asked.
    if (
      side.runtime.status === 'suspended' &&
      side.runtime.lastObservedAt &&
      Date.now() - side.runtime.lastObservedAt < 30000
    ) {
      return {
        report: {
          ...base,
          transcriptReadFailure:
            'The runtime is suspended and was last observed less than 30s ago; probing is backing off.',
        },
        completion: null,
      };
    }

    let messages;
    try {
      messages = await side.provider.readExactSessionTurnsForReconciliation!(side.externalSessionId);
    } catch (err: any) {
      return {
        report: {
          ...base,
          transcriptReadFailure: `The exact-session read threw: ${err?.message ?? String(err)}`,
        },
        completion: null,
      };
    }

    if (!messages.readable) {
      // `readable: false` means "could not check". It is never treated as "checked, found
      // nothing" — that distinction is the whole reason a recovery notice is not sent on the
      // back of an unreadable session.
      return {
        report: { ...base, transcriptReadFailure: messages.failure ?? 'no reason given' },
        completion: null,
      };
    }

    // No `expectedText` on purpose. Matching the instruction text is the weakest anchor
    // available (it breaks on a provider that truncates stored text) and the Delivery only
    // retains a snippet. The recorded message-id set is the authoritative anchor; when it
    // cannot be located, `boundary.source` becomes `unavailable` and no turn is claimed.
    const completion = observeWorkerCompletion({
      messages: messages.messages,
      afterMessageIds: boundary.messageIds,
      afterCreatedAt: null,
      expectedText: null,
    });

    // The provider's own working/generating signal. Recorded as corroboration only: it can
    // extend waiting, never shorten it into handing on a turn (see `stillWorking`).
    let providerReportedWorking: boolean | null = null;
    try {
      // Prefer the EXACT-session signal when the provider has one. The app-level
      // `detectWorkingState` heuristic can only see whether OpenCode is open, not whether THIS
      // session is mid-run, and it was reporting `false` for a Worker that was demonstrably still
      // generating — which is how a live turn looked idle.
      const exact = side.provider as {
        detectExactSessionWorking?: (id: string) => Promise<{ isWorking: boolean }>;
      };
      if (typeof exact.detectExactSessionWorking === 'function') {
        const state = await exact.detectExactSessionWorking(side.externalSessionId);
        providerReportedWorking = state.isWorking;
      } else if (typeof side.provider.detectWorkingState === 'function') {
        const state = await side.provider.detectWorkingState(side.runtimeSessionId);
        providerReportedWorking = state.isWorking;
      }
    } catch {
      providerReportedWorking = null;
    }

    return {
      report: {
        ...base,
        transcriptReadable: true,
        boundarySource: completion.boundary.source,
        boundaryAnchorMessageId: completion.boundary.recordedAnchorMessageId,
        assistantTurnCountAfterBoundary: completion.assistantTurnCount,
        inFlight: completion.inFlight,
        providerReportedWorking,
        hasCompletedResponse: completion.hasCompletedResponse,
        capturedResponseIsNewest: completion.capturedResponseIsNewest,
        completedTurnMessageId: completion.response?.messageId ?? null,
        completedTurnFinish: completion.response?.finish ?? null,
        completedTurnTextLength: completion.response?.text.length ?? null,
        terminalErrorType: completion.terminalError?.type ?? null,
      },
      completion,
    };
  }

  /**
   * THE RELAY BATON ALGORITHM.
   *
   * Restores communication continuity after pause, stop, restart, crash, sleep, provider
   * interruption, or app shutdown — for the steady-state supervision tick and for explicit
   * resume alike. It decides only WHICH SIDE OWES THE NEXT COMPLETED TURN and what to do
   * about the mechanical state of that side.
   *
   * ## The rule
   *
   * The recipient of the last confirmed Delivery holds the baton. `Planner -> Worker`
   * confirmed means the Worker owes the next completed turn; `Worker -> Planner` confirmed
   * means the Planner does.
   *
   * ## What it deliberately does not do
   *
   * It never judges whether work was correct, valid, sufficient, drifted, or semantically
   * complete, and it never repeats an instruction on its own initiative. Deciding what a
   * result MEANS is the Planner's job, and this method hands the mechanical gap back to the
   * Planner rather than resolving it.
   *
   * ## The cases, and why they are ordered as they are
   *
   * Cases A1/B1 ("still working") are evaluated BEFORE A2/B2 ("completed turn exists"), and
   * that ordering loses nothing: `observeWorkerCompletion.hasCompletedResponse` is monotone,
   * so a response that exists now still exists once the in-flight turn terminates. Waiting
   * therefore delays a transfer but can never discard one. The reverse ordering would risk
   * handing on a turn while the side is still writing it.
   *
   * ## Exactly-once
   *
   * No branch resends. Transfer reuses the existing Handoff -> Assignment conversion, whose
   * UNIQUE `source_handoff_id` index makes it once-per-handoff. Recovery is keyed by
   * `assignments.source_recovery_delivery_id`, whose UNIQUE partial index makes it
   * once-per-baton-episode. Unresolved intents are reconciled, never raced.
   */
  public async resumeRelayContinuity(
    pairId: PairId,
    options: { context?: AuthorityContext; actor?: 'supervisor' | 'recovery' } = {},
  ): Promise<RelayBatonDecisionReport> {
    const context = options.context ?? 'AUTOMATED';
    const actor = options.actor ?? 'supervisor';
    const trail: string[] = [];

    const emptyBaton = (baton: RelayBaton) => ({
      basis: baton.basis,
      direction: baton.direction,
      owner: baton.owner,
      sender: baton.sender,
      deliveryId: baton.delivery?.id ?? null,
      assignmentId: baton.assignment?.id ?? null,
      attemptId: baton.attempt?.id ?? null,
      deliveredAt: baton.delivery?.deliveredAt ?? null,
      boundarySessionId: baton.boundary?.sessionId ?? null,
      boundaryMessageCount: baton.boundary?.messageCount ?? null,
      boundaryProvenance: baton.boundary?.provenance ?? null,
      dispatchedExternalSessionId: baton.attempt?.externalSessionId ?? null,
      confirmedDeliveryCount: baton.confirmedDeliveryCount,
      supersededDeliveryCount: baton.supersededCount,
    });

    const noAction = { kind: 'none' as RelayBatonActionKind };

    // ---- 1. Reload durable state -------------------------------------------------
    let pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    const empty = (decision: RelayBatonDecision, reason: string): RelayBatonDecisionReport => ({
      pairId,
      decision,
      relayDecisionTrail: trail,
      baton: emptyBaton({
        basis: 'no_confirmed_delivery',
        owner: null,
        sender: null,
        direction: null,
        delivery: null,
        assignment: null,
        attempt: null,
        boundary: null,
        confirmedDeliveryCount: 0,
        supersededCount: 0,
        chain: [],
      }),
      observation: null,
      action: noAction,
      reason,
    });

    // ---- Authority gate, before any provider contact ------------------------------
    const permitted =
      context === 'AUTOMATED'
        ? pair.isAutomatedContactPermitted()
        : pair.isProviderContactPermitted();
    if (!permitted) {
      trail.push('authority gate refused');
      return empty(
        'refused',
        `Pair ${pairId} does not permit ${context} provider contact, so the baton was not ` +
          'evaluated and no provider was contacted.',
      );
    }
    trail.push('authority gate passed');

    // ---- 3. Reconcile every unresolved Delivery BEFORE deciding anything ----------
    // Step 3 of the specified order, and it must precede the baton: an intent whose outcome
    // is unknown could itself be the delivery that holds the baton, so deciding first would
    // reason from a state RelayX has not established.
    const reconciliation = await this.reconcileUnresolvedDispatches({ context });
    trail.push(
      `reconciled unresolved dispatches: examined=${reconciliation.examined} ` +
        `delivered=${reconciliation.deliveredConfirmed} ` +
        `notDelivered=${reconciliation.notDeliveredConfirmed} ` +
        `ambiguous=${reconciliation.ambiguousRaised}`,
    );

    // ---- 4/5. Latest confirmed Delivery, and its recipient ------------------------
    // Re-read the Pair: reconciliation may have committed changes.
    pair = (await this.repos.pairs.findById(pairId))!;
    const baton = await this.derivePairBaton(pair);

    if (baton.basis === 'no_confirmed_delivery' || !baton.delivery || !baton.assignment || !baton.owner) {
      trail.push('no confirmed Delivery established a baton');
      return await this.handleBootstrapContinuity(pair, baton, emptyBaton(baton), trail, context, actor);
    }

    trail.push(
      `latest confirmed Delivery ${baton.delivery.id} (${baton.direction}) -> baton owner is the ${baton.owner}`,
    );

    // ---- Step 3 (identity). The baton must still be about the bound session -------
    const owner = await this.resolveBatonSide(pair, baton.owner, trail);
    if (!owner.ok) {
      trail.push(`baton owner side unusable: ${owner.failure}`);
      return {
        pairId,
        decision: 'session_identity_unproven',
        relayDecisionTrail: trail,
        baton: emptyBaton(baton),
        observation: null,
        action: noAction,
        reason:
          `${owner.failure} The confirmed Delivery ${baton.delivery.id} cannot be inspected ` +
          'against a current exact session, so RelayX will not infer a completed turn or emit a ' +
          'recovery notice from it.',
      };
    }

    const identity = batonSessionIdentity(
      { delivery: baton.delivery, attempt: baton.attempt },
      owner.externalSessionId,
    );
    if (!identity.matches) {
      trail.push(
        `session identity mismatch: dispatched=${identity.dispatchedExternalSessionId ?? 'none'} ` +
          `current=${identity.currentExternalSessionId ?? 'none'}`,
      );
      return {
        pairId,
        decision: 'session_identity_unproven',
        relayDecisionTrail: trail,
        baton: emptyBaton(baton),
        observation: null,
        action: noAction,
        reason:
          `The confirmed Delivery ${baton.delivery.id} was dispatched against external session ` +
          `'${identity.dispatchedExternalSessionId ?? 'none'}', but the ${baton.owner} side is now ` +
          `bound to '${identity.currentExternalSessionId ?? 'none'}'. RelayX treats that as a ` +
          'different conversation and will not read one as evidence about the other.',
      };
    }
    trail.push('baton session identity verified against the current binding');

    // ---- Step 4/5/6. Read the owner's exact session after the boundary ------------
    const { report: observation, completion } = await this.observeBatonOwner(
      owner,
      baton.boundary,
      baton.delivery!.id,
    );

    // Record the runtime's observed liveness from the same read. This is bookkeeping only:
    // it never decides whether a turn completed.
    if (observation.transcriptReadable) {
      const stillWorking = completion?.inFlight === true || observation.providerReportedWorking === true;
      owner.runtime.recordObservationSuccess(
        stillWorking ? 'working' : 'available',
        observation.transcriptReadable
          ? {
              id: `ev_baton_${Date.now()}`,
              timestamp: Date.now(),
              source: 'reconciliation_probe',
              runtimeSessionId: owner.runtimeSessionId,
              details: {
                phase: 'baton_owner_observation',
                batonDeliveryId: baton.delivery!.id,
                batonDirection: baton.direction,
                boundarySource: observation.boundarySource,
                boundaryAnchorMessageId: observation.boundaryAnchorMessageId,
                inFlight: observation.inFlight,
                providerReportedWorking: observation.providerReportedWorking,
                hasCompletedResponse: observation.hasCompletedResponse,
                completedTurnMessageId: observation.completedTurnMessageId,
              },
            }
          : undefined,
      );

      // The readable transcript answers the open "not currently readable" task for this runtime.
      // Leaving it open after a successful read would report a resolved doubt as a live problem,
      // which is how an operator queue stops being trustworthy.
      await this.resolveRuntimeSuspensionItems(pair.id, owner.sideRole, owner.runtime);
    } else {
      // Failure to observe is never immediately fatal. The runtime is placed into the
      // bounded `suspended` state for retry rather than killed, and the transition is
      // surfaced so a session that has genuinely gone away is visible. Preserved from the
      // supervision path this replaced — losing it would make an unreachable side silent.
      //
      // `recordUnreadableObservation`, NOT `recordObservationFailure`. That distinction is the
      // whole point: this branch fires because the TRANSCRIPT could not be PARSED, which says
      // nothing about whether the conversation exists. Counting an unparseable transcript toward
      // `terminated` is what drove the live planner runtime to `terminated` in the first place
      // (three unreadable ticks), after which `resolveBatonSide` refused the side and the relay
      // reported `session_identity_unproven` over a conversation that was open the whole time.
      // ChatGPT's transcript is unreadable here for a structural reason: virtualized history and
      // no stable per-turn ids. It is unreadable AND alive, indefinitely.
      //
      // Visibility is unchanged: `suspended`, a `runtime.<state>` event, and a warning attention
      // item. Only the false escalation into a terminal belief is gone.
      const { previousStatus, newStatus } = owner.runtime.recordUnreadableObservation();
      if (previousStatus !== newStatus) {
        await this.emitEvent('runtime', owner.runtime.id, `runtime.${newStatus}`, {
          actor: 'supervisor',
          previousState: previousStatus,
          newState: newStatus,
          details: {
            reason: observation.transcriptReadFailure,
            batonOwner: baton.owner,
            batonDeliveryId: baton.delivery!.id,
          },
        });
        if (newStatus === 'suspended') {
          // One open operator task per runtime, not one per suspension TRANSITION.
          //
          // Supervision re-reads the owner on every tick, and an unreadable transcript suspends
          // again the moment anything revives the runtime, so this branch is reached repeatedly
          // for a single underlying fact. Minting an item each time buried the operator: the live
          // Pair accumulated 13 open `runtime_suspended` tasks, all identical, all titled
          // "temporarily unavailable" — which reads as 13 problems rather than one.
          //
          // "This runtime is currently not readable" is a property of the RUNTIME, not a count
          // of how many times we noticed. So the existing open item is reused and left as the
          // single durable marker; only the state TRANSITION is recorded as an event. This is the
          // same idempotence rule already applied to `ambiguous_delivery`.
          //
          // Matched on the exact key `runtimeSuspensionTitle` builds, because `AttentionItem` carries no
          // free-form key field and the runtime id is the only discriminator that survives two
          // runtimes in one pair sharing a name.
          // `owner.sideRole` is authoritative here: it is the side that was actually resolved and read,
          // whereas `baton.owner` is a nullable derivation.
          const sideRole = owner.sideRole;
          const title = this.runtimeSuspensionTitle(sideRole, owner.runtime);
          const existing = (await this.repos.attention.findOpen()).find((i) =>
            this.isRuntimeSuspensionItemFor(i, pair.id, sideRole, owner.runtime),
          );

          if (!existing) {
            await this.repos.attention.save(
              AttentionItem.create(
                'warning',
                'runtime_suspended',
                title,
                `The ${baton.owner} session could not be read during relay supervision (${
                  observation.transcriptReadFailure ?? 'no reason given'
                }). The runtime was placed into the suspended state for retry; RelayX did not terminate it and did not conclude anything about the conversation.`,
                {
                  pairId: pair.id,
                  // Deliberately NOT assignment-scoped: an unreadable conversation is a fact
                  // about the runtime, and every `runtime_suspended` resolver in this codebase
                  // identifies these items by the ABSENCE of an assignment id.
                  suggestedAction: 'Verify the application is open and the bound session is still reachable.',
                },
              ),
            );
          }
        }
      }
    }
    await this.repos.runtimes.save(owner.runtime);

    const report = async (
      decision: RelayBatonDecision,
      reason: string,
      action: RelayBatonDecisionReport['action'] = noAction,
    ): Promise<RelayBatonDecisionReport> => ({
      pairId,
      decision,
      relayDecisionTrail: trail,
      baton: emptyBaton(baton),
      observation,
      action,
      reason,
    });

    // An unresolved intent means RelayX does not know whether the last send landed. Creating
    // a second send to make progress would be exactly the blind replay the design forbids.
    const stillUnresolved = (await this.repos.deliveries.findUnresolved()).filter(
      (d) => d.assignmentId === baton.assignment!.id,
    );
    if (stillUnresolved.length > 0) {
      trail.push(`unresolved intent on the baton Assignment: ${stillUnresolved.map((d) => d.id).join(', ')}`);
      return report(
        'awaiting_unresolved_delivery',
        `Delivery intent(s) ${stillUnresolved
          .map((d) => d.id)
          .join(', ')} on the baton Assignment have no established outcome. RelayX keeps them ` +
          'unresolved and takes no further action rather than sending a second message to make progress.',
      );
    }

    if (!completion || !observation.transcriptReadable) {
      trail.push('exact session unreadable');
      return report(
        'transcript_unreadable',
        `The ${baton.owner} exact session could not be read (${
          observation.transcriptReadFailure ?? 'no reason given'
        }). "Could not check" is not "checked and found nothing", so RelayX neither treats this ` +
          'as a completed turn nor as an unconfirmed one.',
      );
    }

    if (completion.boundary.source === 'unavailable') {
      trail.push('recorded boundary message-id set not locatable in the exact session');
      return report(
        'boundary_unavailable',
        `The pre-dispatch boundary recorded on Delivery ${baton.delivery.id} (${baton.boundary?.messageCount ?? 0} ` +
          'message ids) could not be located in the current transcript, so no turn can be shown to ' +
          'be post-boundary. RelayX will not fall back to a timestamp comparison here, and will ' +
          'neither hand on a turn nor emit a recovery notice.',
      );
    }

    trail.push(
      `boundary anchored on message id ${completion.boundary.recordedAnchorMessageId ?? 'n/a'} via ${completion.boundary.source}`,
    );

    // ---- Case A1/B1 — the baton owner is still working ---------------------------
    // `inFlight` (a newer assistant turn with no provider terminator) is authoritative.
    // `providerReportedWorking` is a UI heuristic and may only EXTEND waiting; it can never
    // shorten it into handing a turn on.
    const stillWorking = completion.inFlight || observation.providerReportedWorking === true;
    if (stillWorking) {
      trail.push('baton owner is still working');
      await this.promoteAttemptIfRunning(pair, baton, completion, observation);
      return report(
        'observe_baton_owner_working',
        `The ${baton.owner} holds the baton and is still working: ` +
          `${completion.inFlight ? 'a post-boundary assistant turn has no provider terminator' : 'the provider reports the session as working'}` +
          '. RelayX resumes observation only. It does not resend the instruction, does not send a ' +
          'recovery notice, and does not create another task. The completed-turn check is monotone, ' +
          'so any completed turn is still there once the in-flight turn terminates.',
      );
    }

    // ---- Case A2/B2 — a completed new turn exists ---------------------------------
    if (completion.hasCompletedResponse && completion.response) {
      trail.push(`completed turn ${completion.response.messageId} (finish=${completion.response.finish})`);
      return await this.transferCompletedTurn(pair, baton, completion, observation, report, context, trail);
    }

    // ---- Case A3/B3 — no confirmed completed turn, owner not running --------------
    trail.push('no confirmed completed turn after the boundary, and the owner is not running');
    return await this.issueRecoveryNotice(pair, baton, observation, report, context, trail);
  }

  /**
   * Physical-execution bookkeeping for the baton Assignment (Attempt Dimension A).
   *
   * Kept strictly separate from the baton decision: `prepared -> running` records that the
   * target side began executing, and `running -> completed_physical` records that it
   * finished. Neither says anything about whether the resulting work was correct.
   */
  private async promoteAttemptIfRunning(
    pair: Pair,
    baton: RelayBaton,
    completion: WorkerCompletionObservation,
    observation: BatonOwnerObservationReport,
  ): Promise<void> {
    if (!baton.assignment || !baton.assignment.currentAttemptId) return;
    if (baton.assignment.status !== 'active') return;

    const evidence: ObservableEvidence = {
      id: `ev_baton_exec_${Date.now()}`,
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      runtimeSessionId: baton.delivery?.targetRuntimeId,
      details: {
        phase: 'baton_execution_observation',
        targetSideRole: baton.owner,
        executionState: completion.hasCompletedResponse ? 'completed' : 'running',
        boundarySource: observation.boundarySource,
        boundaryAnchorMessageId: observation.boundaryAnchorMessageId,
        inFlight: completion.inFlight,
        providerReportedWorking: observation.providerReportedWorking,
        completedTurnMessageId: completion.response?.messageId ?? null,
        completedTurnFinish: completion.response?.finish ?? null,
        terminalErrorType: completion.terminalError?.type ?? null,
      },
    };

    if (completion.inFlight || observation.providerReportedWorking === true) {
      await this.promoteAttemptToRunning(baton.assignment.id, evidence);
      return;
    }
    if (completion.hasCompletedResponse) {
      if (await this.promoteAttemptToRunning(baton.assignment.id, evidence)) {
        const attempt = await this.repos.attempts.findById(baton.assignment.currentAttemptId);
        if (attempt && attempt.status === 'running') {
          attempt.completePhysical(evidence);
          await this.repos.attempts.save(attempt);
          await this.emitEvent('attempt', attempt.id, 'attempt.completed_physical', {
            actor: 'supervisor',
            previousState: 'running',
            newState: 'completed_physical',
            evidence,
          });
        }
      }
    }
  }

  /**
   * Case A2/B2 — hand the completed turn to the opposite side, exactly once.
   *
   * The completed turn's FULL text is carried on a Handoff, which `advancePairOrchestration`
   * then converts into exactly one Assignment for the opposite side. Reusing that conversion
   * rather than sending directly is deliberate: it inherits the UNIQUE `source_handoff_id`
   * index, so "exactly once" is a schema guarantee and survives restarts for free.
   *
   * The baton then moves to the opposite side only once THAT Delivery is confirmed — which
   * `dispatchAssignment` records and the next evaluation reads back through
   * `derivePairBaton`. A locally observed turn never moves the baton on its own.
   */
  private async transferCompletedTurn(
    pair: Pair,
    baton: RelayBaton,
    completion: WorkerCompletionObservation,
    observation: BatonOwnerObservationReport,
    report: (d: RelayBatonDecision, r: string, a?: RelayBatonDecisionReport['action']) => Promise<RelayBatonDecisionReport>,
    context: AuthorityContext,
    trail: string[],
  ): Promise<RelayBatonDecisionReport> {
    const response = completion.response!;
    const batonAssignment = baton.assignment!;

    const alreadyTransferred = await this.hasCompletedTurnBeenTransferred(pair, baton);

    if (alreadyTransferred.transferred) {
      trail.push('completed turn already converted into an opposite-side Assignment');
      return report(
        'completed_turn_already_transferred',
        `A completed ${baton.owner} turn after Delivery ${baton.delivery!.id} was already handed to ` +
          `the ${oppositeSide(baton.owner!)} side${alreadyTransferred.viaAssignmentId ? ` as Assignment ${alreadyTransferred.viaAssignmentId}` : ''}. ` +
          'RelayX does not hand it on a second time.',
      );
    }

    // NOTE: the opposite side is resolved AFTER the Handoff is recorded, not before.
    //
    // The Handoff is the durable record of what the baton owner PRODUCED, and that fact is
    // independent of whether the other side is currently addressable. Resolving first and
    // bailing out discarded an observed, completed turn on every tick the receiving side
    // happened to be unaddressable — losing real work to a transient condition and needing a
    // fresh observation to recover it. Recording first keeps the work; only the hand-over is
    // deferred, and it is retried on a later evaluation.

    // Reuse the Assignment that already holds this episode, or mint one for it.
    let handoff = batonAssignment.activeHandoffId
      ? await this.repos.handoffs.findById(batonAssignment.activeHandoffId)
      : null;

    if (handoff && handoff.status !== 'ready' && handoff.status !== 'delivered' && handoff.status !== 'complete') {
      handoff = null;
    }
    const reusedExistingHandoff = handoff !== null;

    if (handoff) {
      trail.push(`reusing existing ready Handoff ${handoff.id}`);
    } else {
      handoff = await this.repos.runInTransaction(async () => {
        const fresh = await this.repos.assignments.findById(batonAssignment.id);
        if (!fresh) {
          throw new RelayDomainError(`Assignment ${batonAssignment.id} vanished mid-transfer`, 'NOT_FOUND');
        }
        // Re-read inside the transaction so a concurrent tick cannot mint a second Handoff.
        if (fresh.activeHandoffId) {
          const existing = await this.repos.handoffs.findById(fresh.activeHandoffId);
          if (existing && ['ready', 'delivered', 'complete'].includes(existing.status)) return existing;
        }
        const created = Handoff.create(fresh.id, fresh.currentAttemptId!);
        created.markReady(
          response.text,
          {
            fullResponse: response.text,
            // Recorded so the transfer can be audited and, on a later evaluation, recognised
            // as the same completed turn rather than a fresh one.
            completedTurnMessageId: response.messageId,
            completedTurnFinish: response.finish,
            completedTurnCreatedAt: response.createdAt,
            completedTurnCompletedAt: response.completedAt,
            sourceSideRole: baton.owner,
            sourceDeliveryId: baton.delivery!.id,
            boundarySource: observation.boundarySource,
            boundaryAnchorMessageId: observation.boundaryAnchorMessageId,
          },
          {
            id: `ev_baton_handoff_${Date.now()}`,
            timestamp: Date.now(),
            source: 'reconciliation_probe',
            runtimeSessionId: baton.delivery!.targetRuntimeId,
            details: {
              phase: 'baton_transfer',
              observedVia: 'provider_exact_session_transcript',
              completedTurnMessageId: response.messageId,
              completedTurnFinish: response.finish,
              boundarySource: observation.boundarySource,
              boundaryAnchorMessageId: observation.boundaryAnchorMessageId,
              capturedResponseIsNewest: completion.capturedResponseIsNewest,
            },
          },
        );
        await this.repos.handoffs.save(created);
        fresh.markWaitingForHandoff(created.id);
        await this.repos.assignments.save(fresh);

        const freshPair = await this.repos.pairs.findById(pair.id);
        if (freshPair && freshPair.activeAssignmentId !== fresh.id) {
          freshPair.assignWork(fresh.id);
          await this.repos.pairs.save(freshPair);
        }
        return created;
      });

      trail.push(`created Handoff ${handoff.id} carrying completed turn ${response.messageId}`);
      await this.emitEvent('handoff', handoff.id, 'handoff.received', {
        actor: 'supervisor',
        previousState: 'pending',
        newState: 'ready',
        details: {
          reason: 'A mechanically completed turn was observed after the confirmed Delivery boundary.',
          sourceDeliveryId: baton.delivery!.id,
          sourceSideRole: baton.owner,
          completedTurnMessageId: response.messageId,
          completedTurnFinish: response.finish,
        },
      });
    }

    await this.promoteAttemptIfRunning(pair, baton, completion, observation);

    // A Handoff that was just recorded is NOT converted in the same evaluation. That
    // observable boundary — "a completed turn was recorded" and then "it was handed to the
    // opposite side" as two separately visible transitions — is a deliberate property of
    // this loop, and collapsing it would hide the moment the baton actually moved. The next
    // evaluation converts it, and the UNIQUE `source_handoff_id` index makes that conversion
    // once-only no matter how many times it runs.
    //
    // A handoff that was ALREADY ready is different: a conversion is already in flight, so
    // finishing it here is continuing existing work rather than starting a new step.
    if (!reusedExistingHandoff) {
      return report(
        'transfer_completed_turn',
        `A completed ${baton.owner} turn (${response.messageId}, terminator '${response.finish}') exists ` +
          `strictly after the recorded boundary of confirmed Delivery ${baton.delivery!.id}, and had not ` +
          `been delivered. RelayX recorded it as Handoff ${handoff.id} carrying the turn verbatim. The ` +
          `conversion into an opposite-side Assignment and its Delivery happen on the next step, so the ` +
          `baton stays with the ${baton.owner} until that Delivery is confirmed — an observed turn alone ` +
          'does not transfer it. RelayX makes no judgment about whether the content is correct.',
        { kind: 'handoff_created', handoffId: handoff.id },
      );
    }

    // Conversion + dispatch of the opposite-side Assignment. The Handoff carries the turn
    // verbatim; RelayX does not summarise, interpret, or judge it.
    //
    // The receiving side is resolved HERE, at the moment of the send, rather than before the
    // Handoff was written. A side that is not currently addressable defers the hand-over; it
    // does not discard the recorded turn and it does not invent a destination.
    const opposite = await this.resolveBatonSide(pair, oppositeSide(baton.owner!));
    if (!opposite.ok) {
      trail.push(`opposite side not addressable, hand-over deferred: ${opposite.failure}`);
      return report(
        'transfer_completed_turn',
        `A completed ${baton.owner} turn (${response.messageId}, terminator '${response.finish}') exists ` +
          `strictly after the recorded boundary of confirmed Delivery ${baton.delivery!.id} and is ` +
          `durably recorded as Handoff ${handoff.id}. It has NOT been handed to the ` +
          `${oppositeSide(baton.owner!)} side, because ${opposite.failure} The baton therefore stays ` +
          `with the ${baton.owner} and the hand-over is retried on a later evaluation. No completed ` +
          'turn is discarded and no destination is invented.',
        { kind: 'handoff_created', handoffId: handoff.id },
      );
    }

    const advanced = await this.advancePairOrchestration(pair.id);
    trail.push(`handoff conversion: ${advanced.transition}`);

    if (advanced.deliveryId) {
      const confirmed = await this.repos.deliveries.findById(advanced.deliveryId);
      const isConfirmed = confirmed?.status === 'delivered';
      trail.push(
        isConfirmed
          ? `opposite-side Delivery ${advanced.deliveryId} confirmed; baton moves to the ${oppositeSide(baton.owner!)}`
          : `opposite-side Delivery ${advanced.deliveryId} is ${confirmed?.status ?? 'unresolved'}; baton does NOT move yet`,
      );
      return report(
        'transfer_completed_turn',
        `A completed ${baton.owner} turn (${response.messageId}, terminator '${response.finish}') exists ` +
          `strictly after the recorded boundary of confirmed Delivery ${baton.delivery!.id}, and was not ` +
          `yet delivered. RelayX handed it to the ${oppositeSide(baton.owner!)} side exactly once via ` +
          `Delivery ${advanced.deliveryId} (${confirmed?.status ?? 'unknown'}). ` +
          (isConfirmed
            ? `The baton is now with the ${oppositeSide(baton.owner!)}. RelayX makes no judgment about ` +
              'whether the content is correct — that is the receiving side\'s decision.'
            : 'The baton remains with the ' +
              `${baton.owner} until that Delivery is confirmed; an observed turn alone does not transfer it.`),
        {
          kind: advanced.deliveryId ? 'handoff_advanced' : 'handoff_created',
          assignmentId: advanced.assignmentId,
          attemptId: advanced.attemptId,
          deliveryId: advanced.deliveryId,
          handoffId: handoff.id,
          deliveryConfirmed: isConfirmed,
        },
      );
    }

    return report(
      'transfer_completed_turn',
      `A completed ${baton.owner} turn (${response.messageId}) exists after the recorded boundary of ` +
        `Delivery ${baton.delivery!.id}. The Handoff ${handoff.id} is ready but the opposite-side ` +
        `Assignment was not dispatched in this evaluation (${advanced.transition}); the conversion is ` +
        'idempotent and will complete on a subsequent tick.',
      { kind: 'handoff_created', assignmentId: advanced.assignmentId, handoffId: handoff.id },
    );
  }

  /**
   * Has this completed turn already been handed to the opposite side?
   *
   * Derived entirely from persisted records — the derived Assignment's `sourceHandoffId`
   * and the Assignment's own terminal status — so it is stable across restarts and cannot be
   * fooled by a tick that ran twice.
   */
  private async hasCompletedTurnBeenTransferred(
    pair: Pair,
    baton: RelayBaton,
  ): Promise<{ transferred: boolean; viaAssignmentId: AssignmentId | null }> {
    const batonAssignment = baton.assignment!;
    const handoffs = await this.repos.handoffs.findByAssignmentId(batonAssignment.id);
    if (handoffs.length > 0) {
      const handoffIds = new Set(handoffs.map((h) => h.id));
      // The transferred check is scoped to the handoff-derived assignment, not to
      // whatever the current baton points at. The derived Assignment is the durable
      // marker of the in-flight hand-over.
      const derived = (await this.repos.assignments.findByPairId(pair.id)).find(
        (a) => a.sourceHandoffId !== undefined && handoffIds.has(a.sourceHandoffId),
      );
      if (derived) {
        // "Converted" is not "handed over": the transfer is complete only when the
        // derived Assignment has a confirmed Delivery. The derived Assignment may
        // exist with no Delivery yet (crash between conversion and dispatch) — in
        // that window the hand-over is in-flight and must be continued, not skipped.
        if (derived.activeDeliveryId) {
          const delivery = await this.repos.deliveries.findById(derived.activeDeliveryId);
          if (delivery && delivery.status === 'delivered') {
            return { transferred: true, viaAssignmentId: derived.id };
          }
        }
        // Derived exists but undelivered (or no Delivery recorded) -> in-flight
        // hand-over: not yet transferred.
        return { transferred: false, viaAssignmentId: null };
      }
    }
    if (RelayEngine.TERMINAL_ASSIGNMENT_STATES.has(batonAssignment.status)) {
      return { transferred: true, viaAssignmentId: null };
    }
    return { transferred: false, viaAssignmentId: null };
  }

  /**
   * Case A3/B3 — tell the Planner that a baton episode produced no confirmed return turn.
   *
   * ## What is sent
   *
   * A factual continuity notice: which confirmed Delivery established the baton, which side
   * held it, the recorded boundary, and the mechanical state of that side's session. It
   * states nothing about whether the other side succeeded, failed, drifted, or produced a
   * good result, and it never asks the Planner to do anything specific — deciding what
   * happens next is exactly the Planner's job.
   *
   * ## What is deliberately NOT sent
   *
   * The previous instruction is NOT repeated, under any circumstance. Re-issuing it would
   * replace a Planner decision RelayX is not entitled to make with a guess, and it would
   * risk a duplicate instruction landing in the Worker session.
   *
   * ## Exactly-once, scoped to this episode
   *
   * The notice is keyed to the triggering confirmed Delivery through
   * `assignments.source_recovery_delivery_id`, whose UNIQUE partial index permits at most
   * one notice per episode. Repeated ticks, restarts, and pause/resume cycles therefore
   * cannot each mint another. If the notice's own Delivery outcome is unknown, the SAME
   * Delivery is reconciled — a second send is never created to force progress. Once it is
   * confirmed, the Planner holds the baton and RelayX simply watches: inactivity alone never
   * produces a follow-up prompt.
   */
  private async issueRecoveryNotice(
    pair: Pair,
    baton: RelayBaton,
    observation: BatonOwnerObservationReport,
    report: (d: RelayBatonDecision, r: string, a?: RelayBatonDecisionReport['action']) => Promise<RelayBatonDecisionReport>,
    context: AuthorityContext,
    trail: string[],
  ): Promise<RelayBatonDecisionReport> {
    // ---- THE EPISODE IS ALREADY CLOSED BY THE BATON ITSELF --------------------------
    //
    // A notice RelayX has already delivered is itself a CONFIRMED Delivery to the Planner, so
    // once it is confirmed it becomes the baton: the Planner holds it, and the baton
    // Assignment is the notice's own Assignment (`sourceRecoveryDeliveryId` is set).
    //
    // Without this check the episode key moves with the baton, so every tick re-opens a NEW
    // episode against the notice's own Delivery and mints another Assignment + Attempt +
    // Delivery. That is a fresh relay cycle per tick rather than continuation of the existing
    // one, and it pushes an unbounded stream of identical notices into the Planner session —
    // the consumed watermark (the notice already landed) being ignored entirely. The
    // `recovery_notice_already_issued` branch below cannot catch it, because it keys on the
    // TRIGGERING Delivery while the baton has already advanced to the notice's Delivery.
    //
    // The rule this restores is the one this method already documents: once the notice is
    // confirmed, the Planner holds the baton and inactivity is the Planner's to resolve, not
    // a mechanical gap RelayX keeps reporting. This is observation only: it creates nothing,
    // sends nothing, and touches no provider.
    //
    // It is deliberately evaluated BEFORE the Planner is resolved, so a temporarily
    // unaddressable Planner cannot change the outcome of a closed episode.
    if (baton.assignment!.sourceRecoveryDeliveryId) {
      trail.push(
        `baton is already held by Relay resume notice ${baton.assignment!.id} (trigger ${baton.assignment!.sourceRecoveryDeliveryId}); watching only`,
      );
      return report(
        'recovery_notice_already_issued',
        `The last confirmed Delivery ${baton.delivery!.id} IS RelayX's own resume notice for baton ` +
          `episode ${baton.assignment!.sourceRecoveryDeliveryId} (Assignment ${baton.assignment!.id}), and ` +
          `it is confirmed delivered. The Planner therefore already holds the baton and has already ` +
          'been told that the mechanical gap exists. RelayX does not prompt again for that episode: ' +
          'the notice has already been consumed, so re-sending it would start a new relay cycle ' +
          'instead of continuing the existing one. RelayX resumes observation and injects no message.',
        { kind: 'none', assignmentId: baton.assignment!.id, deliveryId: baton.delivery!.id, deliveryConfirmed: true },
      );
    }

    const planner = await this.resolveBatonSide(pair, 'planner', trail);
    if (!planner.ok) {
      trail.push(`planner side unusable: ${planner.failure}`);
      return report(
        'session_identity_unproven',
        `${planner.failure} No confirmed completed ${baton.owner} turn exists after Delivery ` +
          `${baton.delivery!.id} and the ${baton.owner} is not running, but RelayX has no addressable ` +
          'Planner session to report that to. Nothing was sent.',
      );
    }
    if (!planner.provider) {
      trail.push(`planner provider unavailable: ${planner.providerFailure ?? 'unknown'}`);
      return report(
        'session_identity_unproven',
        `${planner.providerFailure ?? 'The Planner provider is unavailable.'} Nothing was sent.`,
      );
    }

    const existing = await this.repos.assignments.findBySourceRecoveryDelivery(baton.delivery!.id);
    if (existing) {
      trail.push(`recovery notice already exists for this episode: Assignment ${existing.id}`);
      const delivery = existing.activeDeliveryId
        ? await this.repos.deliveries.findById(existing.activeDeliveryId)
        : null;

      if (!delivery) {
        // The notice was created durably but never dispatched. Finishing that dispatch is
        // continuing the same episode, not starting a second one.
        const dispatched = await this.dispatchAssignment(existing.id, context);
        trail.push(`dispatched the existing recovery notice as Delivery ${dispatched.delivery.id}`);
        return report(
          'send_recovery_notice',
          `A recovery notice for baton episode ${baton.delivery!.id} already existed as Assignment ` +
            `${existing.id} but had never been dispatched. RelayX dispatched it as Delivery ` +
            `${dispatched.delivery.id} (${dispatched.delivery.status}); the baton moves to the Planner ` +
            'once that Delivery is confirmed.',
          {
            kind: 'recovery_notice_redispatched',
            assignmentId: existing.id,
            attemptId: dispatched.attempt.id,
            deliveryId: dispatched.delivery.id,
            deliveryConfirmed: dispatched.delivery.status === 'delivered',
          },
        );
      }

      if (delivery.status === 'delivered') {
        trail.push('recovery notice for this episode is already confirmed delivered; watching');
        return report(
          'recovery_notice_already_issued',
          `A recovery notice for baton episode ${baton.delivery!.id} was already issued and confirmed ` +
            `delivered (Delivery ${delivery.id}). RelayX does not prompt again for this episode: the ` +
            'Planner holds the baton and inactivity is the Planner\'s to resolve, not a mechanical gap ' +
            'RelayX should keep reporting.',
          {
            kind: 'none',
            assignmentId: existing.id,
            deliveryId: delivery.id,
            deliveryConfirmed: true,
          },
        );
      }

      trail.push(`recovery notice Delivery ${delivery.id} is ${delivery.status}; reconciling it instead of resending`);
      return report(
        'recovery_notice_unresolved',
        `The recovery notice for baton episode ${baton.delivery!.id} exists as Delivery ${delivery.id}, ` +
          `whose outcome is '${delivery.status}'. RelayX reconciles that same Delivery and does not ` +
          'create a second send to make progress.',
        { kind: 'none', assignmentId: existing.id, deliveryId: delivery.id, deliveryConfirmed: false },
      );
    }

    const notice = buildRecoveryNotice({
      triggerDeliveryId: baton.delivery!.id,
      triggerAssignmentId: baton.assignment!.id,
      triggerAttemptId: baton.attempt?.id ?? null,
      triggerDeliveredAt: baton.delivery!.deliveredAt ?? null,
      direction: baton.direction,
      owner: baton.owner!,
      ownerExternalSessionId: baton.boundary?.sessionId ?? null,
      boundaryMessageCount: baton.boundary?.messageCount ?? null,
      boundaryProvenance: baton.boundary?.provenance ?? null,
      boundaryAnchorMessageId: observation.boundaryAnchorMessageId,
      observation,
    });

    // Created inside a transaction that re-reads the episode marker, so two concurrent
    // evaluations cannot both get past the check above. The UNIQUE partial index on
    // `source_recovery_delivery_id` is the backstop that makes this hold even across a crash
    // between the check and the write.
    const created = await this.repos.runInTransaction(async () => {
      const fresh = await this.repos.assignments.findBySourceRecoveryDelivery(baton.delivery!.id);
      if (fresh) return fresh;

      const freshPair = await this.repos.pairs.findById(pair.id);
      if (!freshPair) {
        throw new RelayDomainError(`Pair ${pair.id} not found`, 'PAIR_NOT_FOUND');
      }

      const assignment = Assignment.create(
        freshPair.id,
        freshPair.projectId,
        'Relay resume notice',
        notice,
        'planner',
        undefined,
        baton.delivery!.id,
      );
      await this.repos.assignments.save(assignment);

      // ---- EXECUTION-SLOT EPISODE CLOSURE (in the same transaction) --------------
      //
      // `Pair.assignWork()` is an unconditional setter, so claiming the slot for the notice
      // used to overwrite `activeAssignmentId` while the previous holder was still `active`
      // with its own Attempt and a CONFIRMED Delivery. That is precisely the orphan state
      // `assertExecutionSlotAvailable` exists to prevent: two dispatched Assignments, one of
      // them still believing it owns the work while the Pair points at the other. It was
      // durable, survived a real restart, and outlived every later relay step — the engine's
      // own repair, `reconcilePairAssignmentAuthority`, classified it as corrupt and
      // cancelled it, destroying the episode's records in the process.
      //
      // A recovery notice is a NORMAL Assignment, so the model already says what happens to
      // the Assignment it replaces: the Handoff conversion completes the source Assignment
      // and clears the slot in the SAME transaction that creates the next one. This is that
      // transition again, for a resume notice instead of a Handoff. The previous slot holder
      // is made terminal BEFORE the notice claims the slot, so "a dispatched Assignment is
      // terminal before another can hold that slot" holds at every committed instant rather
      // than only after a later repair.
      //
      // `cancelled` is used deliberately: it is the model's own vocabulary for "this
      // Assignment is no longer the step RelayX is executing" (`describeOrphanReason`).
      // `completed` would assert the work finished, and it did not; `failed` is reserved
      // throughout `dispatchAssignment` for an instruction that never reached the session,
      // and this Delivery is confirmed. Neither would be true. A `pending` holder with no
      // Attempt is legal backlog and is deliberately left alone.
      //
      // Nothing here judges the work: the Delivery stays `delivered`, the boundary watermark
      // is untouched, and `deriveRelayBaton` reads the same chain, because it filters on
      // Delivery status and never on Assignment status.
      //
      // There are up to TWO Assignments to close, and both are handled explicitly because
      // they are genuinely different claims:
      //
      //   1. the BATON Assignment — its episode is what this notice reports, so it is closed
      //      whether or not it happened to hold the slot.
      //   2. whatever DISPATCHED, non-terminal Assignment currently holds the slot — it is
      //      about to be displaced. Usually the same record as (1); when it is not, the slot
      //      was already pointing somewhere the baton did not follow (a pre-existing orphan),
      //      and that one is named as such instead of being silently displaced again.
      const toClose: Assignment[] = [];
      const slotHolderId = freshPair.activeAssignmentId;
      const candidates = [baton.assignment!.id, slotHolderId ? slotHolderId : null];
      for (const candidateId of candidates) {
        if (!candidateId || candidateId === assignment.id) continue;
        if (toClose.some((a) => a.id === candidateId)) continue;
        const candidate = await this.repos.assignments.findById(candidateId);
        if (!candidate || RelayEngine.TERMINAL_ASSIGNMENT_STATES.has(candidate.status)) continue;
        const hasDispatchEvidence =
          candidate.currentAttemptId !== undefined ||
          (await this.repos.attempts.findByAssignmentId(candidate.id)).length > 0;
        if (hasDispatchEvidence) toClose.push(candidate);
      }

      for (const closing of toClose) {
        const previousStatus = closing.status;
        const wasBatonAssignment = closing.id === baton.assignment!.id;
        closing.cancel();
        await this.repos.assignments.save(closing);
        await this.emitEvent('assignment', closing.id, 'assignment.cancelled', {
          actor: 'supervisor',
          previousState: previousStatus,
          newState: closing.status,
          details: {
            pairId: freshPair.id,
            supersededBy: assignment.id,
            triggerDeliveryId: baton.delivery!.id,
            wasBatonAssignment,
            wasExecutionSlotHolder: closing.id === slotHolderId,
            reason:
              (wasBatonAssignment
                ? 'A Relay resume notice reported this Assignment\'s mechanical gap to the Planner, so ' +
                  'the baton moved on and this Assignment is no longer the step RelayX executes. It was ' +
                  'made terminal in the same transaction that granted the execution slot to the notice, ' +
                  'because a dispatched Assignment must be terminal before another Assignment can hold ' +
                  'that slot. This closes an episode and asserts nothing about whether the work succeeded, ' +
                  'failed, or was ever correct.'
                : 'It held the Pair execution slot while unresolved and was displaced by Relay resume ' +
                  `notice ${assignment.id}, so it is made terminal rather than left holding neither the ` +
                  'slot nor a resolution. Its confirmed Delivery and its Handoff records are untouched. ' +
                  'It was already in the orphan state this operation exists to prevent — run ' +
                  'reconcilePairAssignmentAuthority for a full audit of the Pair.'),
          },
        });
      }

      freshPair.assignWork(assignment.id);
      await this.repos.pairs.save(freshPair);

      await this.emitEvent('assignment', assignment.id, 'assignment.recovery_notice_created', {
        actor: 'supervisor',
        newState: assignment.status,
        details: {
          triggerDeliveryId: baton.delivery!.id,
          triggerAssignmentId: baton.assignment!.id,
          batonDirection: baton.direction,
          batonOwner: baton.owner,
          boundaryProvenance: baton.boundary?.provenance ?? null,
          boundaryMessageCount: baton.boundary?.messageCount ?? null,
          boundaryAnchorMessageId: observation.boundaryAnchorMessageId,
          assistantTurnsAfterBoundary: observation.assistantTurnCountAfterBoundary,
          inFlight: observation.inFlight,
          providerReportedWorking: observation.providerReportedWorking,
          // Recorded explicitly so nobody later reads this event as a failure verdict.
          assertion: 'mechanically_unconfirmed_return_turn',
          explicitlyNotAsserted: [
            'worker_failed',
            'worker_completed',
            'result_invalid',
            'task_incomplete',
            'work_drifted',
          ],
        },
      });

      return assignment;
    });

    trail.push(`created recovery notice Assignment ${created.id} for episode ${baton.delivery!.id}`);
    const dispatched = await this.dispatchAssignment(created.id, context);
    const confirmed = dispatched.delivery.status === 'delivered';
    trail.push(
      confirmed
        ? `recovery notice confirmed delivered as ${dispatched.delivery.id}; baton moves to the planner`
        : `recovery notice is ${dispatched.delivery.status}; baton does not move`,
    );

    return report(
      'send_recovery_notice',
      `Confirmed Delivery ${baton.delivery!.id} left the baton with the ${baton.owner}, and no confirmed ` +
        `completed ${baton.owner} turn exists after its recorded boundary while the ${baton.owner} is not ` +
        `running. RelayX sent the Planner one factual continuity notice (Delivery ` +
        `${dispatched.delivery.id}, ${dispatched.delivery.status}). It did not repeat the previous ` +
        `Planner instruction, and it makes no claim about whether the ${baton.owner} failed, completed, ` +
        'or produced a valid result. The baton moves to the Planner once the notice is confirmed.',
      {
        kind: 'recovery_notice_issued',
        assignmentId: created.id,
        attemptId: dispatched.attempt.id,
        deliveryId: dispatched.delivery.id,
        deliveryConfirmed: confirmed,
      },
    );
  }

  /**
   * Case C — no confirmed Delivery exists, so no baton can be derived.
   *
   * ## Why this observes and never delivers
   *
   * With no confirmed Delivery there is no recorded message-id boundary for either side, so
   * "this completed turn has never been delivered" cannot be established — and neither can
   * "this completed turn belongs to this Pair's relay". An assistant turn that a human typed
   * into the same conversation is mechanically identical to one RelayX should have carried,
   * and nothing in the durable state distinguishes them. Injecting an unrelated human message
   * into the relay chain would be worse than doing nothing, so this path fails closed.
   *
   * It therefore reports the mechanical state of both sides and injects nothing. The
   * situations where a completed turn demonstrably has never been delivered all require at
   * least one confirmed Delivery first, and those are handled above as A2/B2.
   */
  private async handleBootstrapContinuity(
    pair: Pair,
    baton: RelayBaton,
    batonSummary: RelayBatonDecisionReport['baton'],
    trail: string[],
    context: AuthorityContext,
    actor: 'supervisor' | 'recovery',
  ): Promise<RelayBatonDecisionReport> {
    trail.push(
      `no confirmed Delivery for this chain (${baton.confirmedDeliveryCount} confirmed, ${baton.supersededCount} superseded)`,
    );

    const sides: BatonOwnerObservationReport[] = [];
    let anyWorking = false;

    for (const sideRole of PAIR_SIDE_ROLES) {
      const side = await this.resolveBatonSide(pair, sideRole);
      if (!side.ok) {
        trail.push(`${sideRole}: ${side.failure}`);
        sides.push({
          sideRole,
          runtimeSessionId: null,
          providerType: null,
          externalSessionId: null,
          transcriptReadable: false,
          transcriptReadFailure: side.failure,
          boundarySource: null,
          boundaryAnchorMessageId: null,
          assistantTurnCountAfterBoundary: null,
          inFlight: null,
          providerReportedWorking: null,
          hasCompletedResponse: null,
          capturedResponseIsNewest: null,
          completedTurnMessageId: null,
          completedTurnFinish: null,
          completedTurnTextLength: null,
          terminalErrorType: null,
        });
        continue;
      }

      // No boundary, so there is nothing to be "after" and no completed turn can be
      // attributed. The one bootstrap question that IS answerable safely is whether the side
      // is currently active, because that asks the provider about right now rather than
      // about a turn RelayX cannot place.
      let working: boolean | null = null;
      let readFailure: string | null = null;
      try {
        if (typeof side.provider?.detectWorkingState === 'function') {
          working = (await side.provider.detectWorkingState(side.runtimeSessionId)).isWorking;
        } else {
          readFailure = 'Provider exposes no working-state signal.';
        }
      } catch (err: any) {
        readFailure = `Working-state read threw: ${err?.message ?? String(err)}`;
      }
      if (working === true) anyWorking = true;

      sides.push({
        sideRole,
        runtimeSessionId: side.runtimeSessionId,
        providerType: side.runtime.providerType,
        externalSessionId: side.externalSessionId,
        transcriptReadable: false,
        transcriptReadFailure:
          readFailure ??
          'No confirmed Delivery establishes a boundary, so no turn on this side can be attributed to the relay.',
        boundarySource: null,
        boundaryAnchorMessageId: null,
        assistantTurnCountAfterBoundary: null,
        inFlight: null,
        providerReportedWorking: working,
        hasCompletedResponse: null,
        capturedResponseIsNewest: null,
        completedTurnMessageId: null,
        completedTurnFinish: null,
        completedTurnTextLength: null,
        terminalErrorType: null,
      });
    }

    trail.push(
      anyWorking
        ? 'at least one side is active; observing and waiting'
        : 'no authoritative outstanding turn is attributable to this Pair',
    );

    const report: RelayBatonDecisionReport = {
      pairId: pair.id,
      decision: anyWorking ? 'observe_baton_owner_working' : 'no_confirmed_delivery',
      relayDecisionTrail: trail,
      baton: batonSummary,
      observation: sides[0] ?? null,
      action: { kind: 'none' },
      reason: anyWorking
        ? 'No confirmed Delivery establishes a baton, and at least one side is currently active. ' +
          'RelayX resumes observation and injects no message.'
        : 'No confirmed Delivery establishes a baton for this chain, and with no recorded ' +
          'message-id boundary on either side there is no way to establish that an observed ' +
          'completed turn was never delivered or that it belongs to this Pair rather than to a ' +
          'human in the same conversation. RelayX resumes normal watching and injects no message.',
    };

    await this.emitEvent('pair', pair.id, 'pair.baton_evaluated', {
      actor,
      newState: pair.relayState,
      details: {
        decision: report.decision,
        basis: batonSummary.basis,
        confirmedDeliveryCount: batonSummary.confirmedDeliveryCount,
        supersededDeliveryCount: batonSummary.supersededDeliveryCount,
        sides: sides.map((s) => ({
          sideRole: s.sideRole,
          transcriptReadable: s.transcriptReadable,
          externalSessionId: s.externalSessionId,
          failure: s.transcriptReadFailure,
        })),
        relayDecisionTrail: trail,
        context,
      },
    });

    return report;
  }

  /**
   * Advance one Pair by exactly one durable orchestration step.
   *
   * Selection order is deterministic: the current execution-slot holder, then the
   * oldest pending Assignment, then the oldest non-terminal Plan-First run. A ready
   * Handoff is converted once into an Assignment for the opposite side; the unique
   * `sourceHandoffId` makes retries and restarts idempotent.
   */
  public async advancePairOrchestration(pairId: PairId): Promise<RelayOrchestrationResult> {
    if (this.orchestratingPairs.has(pairId)) return { pairId, transition: 'busy' };
    this.orchestratingPairs.add(pairId);

    try {
      let pair = await this.repos.pairs.findById(pairId);
      if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');
      if (!pair.isAutomatedContactPermitted()) return { pairId, transition: 'disabled' };

      let assignments = (await this.repos.assignments.findByPairId(pairId))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      let current = pair.activeAssignmentId
        ? await this.repos.assignments.findById(pair.activeAssignmentId)
        : null;

      if (current && RelayEngine.TERMINAL_ASSIGNMENT_STATES.has(current.status)) {
        pair.clearWork();
        await this.repos.pairs.save(pair);
        current = null;
      }

      // Plan-First owns the lifecycle of its bound Assignment, including verification
      // after physical completion. Do not reinterpret its Handoff as a generic ping-pong
      // relay step or bypass the run's acceptance gate.
      if (current) {
        const candidateRuns = (await this.repos.planFirstRuns.findByProjectId(pair.projectId))
          .filter((candidate) => candidate.sessionPairId === pairId && !candidate.isTerminal())
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        for (const candidate of candidateRuns) {
          const units = await this.repos.workUnits.findByContractRevisionId(candidate.contractRevisionId);
          if (units.some((unit) => unit.assignmentId === current!.id)) {
            const tick = await this.runPlanFirstTick(candidate.id);
            return {
              pairId,
              transition: 'plan_first_advanced',
              assignmentId: (tick.assignmentId as AssignmentId | undefined) ?? current.id,
              attemptId: tick.attemptId as AttemptId | undefined,
              planFirstRunId: candidate.id,
            };
          }
        }
      }

      if (current?.status === 'waiting_for_handoff' && current.activeHandoffId) {
        const handoff = await this.repos.handoffs.findById(current.activeHandoffId);
        if (!handoff || !['ready', 'delivered', 'complete'].includes(handoff.status)) {
          return { pairId, transition: 'awaiting_evidence', assignmentId: current.id };
        }

        let next = assignments.find((candidate) => candidate.sourceHandoffId === handoff.id) ?? null;
        if (!next) {
          next = await this.repos.runInTransaction(async () => {
            // Re-read inside the transaction so concurrent/restarted ticks cannot create
            // two opposite-side Assignments from the same Handoff.
            const freshAssignments = await this.repos.assignments.findByPairId(pairId);
            const existing = freshAssignments.find((candidate) => candidate.sourceHandoffId === handoff.id);
            if (existing) return existing;

            const freshPair = await this.repos.pairs.findById(pairId);
            const freshCurrent = await this.repos.assignments.findById(current!.id);
            const freshHandoff = await this.repos.handoffs.findById(handoff.id);
            if (!freshPair || !freshCurrent || !freshHandoff) {
              throw new RelayDomainError('Relay handoff conversion lost its durable source records', 'NOT_FOUND');
            }

            const nextSide: PairSideRole = freshCurrent.targetSideRole === 'worker' ? 'planner' : 'worker';
            const derived = Assignment.create(
              pairId,
              freshCurrent.projectId,
              `Handoff from ${freshCurrent.targetSideRole}: ${freshCurrent.title}`,
              freshHandoff.resultSummary ?? 'Continue the relay from the completed opposite-side handoff.',
              nextSide,
              freshHandoff.id,
            );
            freshCurrent.complete();
            if (freshHandoff.status !== 'complete') freshHandoff.completeHandoff();
            freshPair.clearWork();
            await this.repos.assignments.save(freshCurrent);
            await this.repos.handoffs.save(freshHandoff);
            await this.repos.pairs.save(freshPair);
            await this.repos.assignments.save(derived);
            return derived;
          });

          await this.emitEvent('assignment', next.id, 'assignment.created_from_handoff', {
            actor: 'engine',
            newState: 'pending',
            details: {
              sourceHandoffId: handoff.id,
              sourceAssignmentId: current.id,
              targetSideRole: next.targetSideRole,
            },
          });
        }

        const dispatched = await this.dispatchAssignment(next.id, 'AUTOMATED');
        return {
          pairId,
          transition: 'handoff_advanced',
          assignmentId: dispatched.assignment.id,
          attemptId: dispatched.attempt.id,
          deliveryId: dispatched.delivery.id,
          handoffId: handoff.id,
        };
      }

      if (current) {
        if (current.status === 'pending' || !current.currentAttemptId) {
          const dispatched = await this.dispatchAssignment(current.id, 'AUTOMATED');
          return {
            pairId,
            transition: 'assignment_dispatched',
            assignmentId: dispatched.assignment.id,
            attemptId: dispatched.attempt.id,
            deliveryId: dispatched.delivery.id,
          };
        }
        return { pairId, transition: 'awaiting_evidence', assignmentId: current.id };
      }

      const pending = assignments.find((assignment) => assignment.status === 'pending');
      if (pending) {
        const dispatched = await this.dispatchAssignment(pending.id, 'AUTOMATED');
        return {
          pairId,
          transition: 'assignment_dispatched',
          assignmentId: dispatched.assignment.id,
          attemptId: dispatched.attempt.id,
          deliveryId: dispatched.delivery.id,
        };
      }

      const run = (await this.repos.planFirstRuns.findByProjectId(pair.projectId))
        .filter((candidate) => candidate.sessionPairId === pairId && !candidate.isTerminal())
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
      if (run) {
        const tick = await this.runPlanFirstTick(run.id);
        return {
          pairId,
          transition: 'plan_first_advanced',
          assignmentId: tick.assignmentId as AssignmentId | undefined,
          attemptId: tick.attemptId as AttemptId | undefined,
          planFirstRunId: run.id,
        };
      }

      await this.emitEvent('pair', pairId, 'pair.awaiting_executable_assignment', {
        actor: 'engine',
        newState: pair.relayState,
        details: { reason: 'Relay is running but no pending Assignment or executable Plan-First run exists yet.' },
      });
      return { pairId, transition: 'awaiting_work' };
    } finally {
      this.orchestratingPairs.delete(pairId);
    }
  }

  /**
   * `startPair` — EXECUTION authority. It is NOT the activation authority.
   *
   * ## It never grants ACTIVE, and never transitions IDLE -> ACTIVE
   *
   * Freeze §4.4: Start Pair "Changes operational state: No" (N-16, N-18, I-9).
   * `Pair.resume()` writes the deprecated lifecycle `status` and nothing else;
   * `operationalState` is untouched here. The ONLY `IDLE -> ACTIVE` transition in
   * this tranche is `loadAndActivate` (S6). A deliberate, documented rejection of
   * the "bridge" reading: Start Pair is never a compatibility path into ACTIVE.
   *
   * ## Why it refuses on an IDLE Pair
   *
   * Starting execution on an IDLE Pair would record a lifecycle status implying
   * work is underway while the engine refuses every provider contact behind it
   * (I-2). That is the silent, misleading outcome this refusal exists to prevent:
   * the operator would see a started pair and see nothing happen, with no
   * explanation. Refusing, and naming the operation that would succeed, is the
   * truthful response.
   *
   * The thrown code is deliberately the same `PAIR_OPERATIONAL_STATE_IDLE` the I-2
   * gate raises, so a caller has one code to handle for "this Pair may not contact
   * providers" whether the block came from the gate or from here.
   */
  public async startPair(pairId: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');

    if (!pair.isProviderContactPermitted()) {
      // The advice must be true for THIS pair. Telling a pair with an unbound side
      // to "run Load & Activate" would send the operator into a second, different
      // failure, because §4.4 requires BOTH sides bound before activation succeeds.
      const missing = [
        !pair.plannerSessionId ? 'planner' : null,
        !pair.workerSessionId ? 'worker' : null,
      ].filter(Boolean);
      const remedy = missing.length
        ? `Pair ${pairId} has no bound ${missing.join(' or ')} runtime, so Load & Activate cannot ` +
          `satisfy its §4.4 "both sides bound" precondition. Bind the ${missing.join(' and ')} ` +
          'runtime first.'
        : `Run Load & Activate on Pair ${pairId} first to grant ACTIVE, then Start Pair to begin ` +
          'execution.';
      throw new RelayDomainError(
        `Pair ${pairId} is IDLE, so its execution cannot be started: execution needs provider ` +
          `contact, which IDLE forbids (DESIGN_FREEZE I-2). Start Pair is execution authority ` +
          `only and does not activate. ${remedy} (freeze §4.4, §11.5).`,
        'PAIR_OPERATIONAL_STATE_IDLE',
      );
    }

    pair.startRelay();
    await this.repos.pairs.save(pair);
    await this.emitEvent('pair', pair.id, 'pair.started', {
      actor: 'user',
      newState: pair.status,
    });
    // Start means begin orchestration. This call performs the first deterministic
    // step immediately; the background supervision loop continues subsequent steps.
    await this.advancePairOrchestration(pair.id);
    return pair;
  }

  public async pausePair(pairId: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');
    pair.pauseRelay();
    await this.repos.pairs.save(pair);
    await this.emitEvent('pair', pair.id, 'pair.paused', {
      actor: 'user',
      newState: pair.status,
    });
    return pair;
  }

  /**
   * Resume execution AND communication continuity for a Pair.
   *
   * Relaying the relay state is not enough on its own: after a pause, stop, crash, sleep,
   * provider interruption, or shutdown, the Pair may be mid-conversation with one side
   * already holding the baton and a turn written but never carried across. So this calls
   * the same `resumeRelayContinuity` the supervision tick uses, which re-derives the baton
   * from the last confirmed Delivery and then either keeps watching, hands on a completed
   * turn exactly once, or reports the mechanical gap to the Planner exactly once.
   *
   * It never resends the last message and never repeats an instruction: the baton decides
   * who owes the next turn, not what that turn should say.
   */
  public async resumePair(pairId: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');
    
    if (!pair.isProviderContactPermitted()) {
      const missing = [
        !pair.plannerSessionId ? 'planner' : null,
        !pair.workerSessionId ? 'worker' : null,
      ].filter(Boolean);
      const remedy = missing.length
        ? `Pair ${pairId} has no bound ${missing.join(' or ')} runtime.`
        : `Run Load & Activate on Pair ${pairId} first.`;
      throw new RelayDomainError(
        `Pair ${pairId} is IDLE, so execution cannot resume. ${remedy}`,
        'PAIR_OPERATIONAL_STATE_IDLE',
      );
    }

    pair.resumeRelay();
    await this.repos.pairs.save(pair);
    await this.emitEvent('pair', pair.id, 'pair.resumed', {
      actor: 'user',
      newState: pair.status,
    });

    // Continuity FIRST. The baton evaluation reconciles stranded intents, reads the baton
    // owner's session, and may convert an already-written completed turn into the next
    // opposite-side Assignment. Dispatching first could pick a different Assignment and
    // leave that completed turn stranded behind a newly-claimed execution slot.
    const baton = await this.resumeRelayContinuity(pairId, {
      context: 'AUTOMATED',
      actor: 'supervisor',
    });
    await this.emitEvent('pair', pairId, 'pair.resumed_continuity', {
      actor: 'user',
      newState: pair.status,
      details: {
        decision: baton.decision,
        batonDirection: baton.baton.direction,
        batonOwner: baton.baton.owner,
        basisDeliveryId: baton.baton.deliveryId,
        boundaryProvenance: baton.baton.boundaryProvenance,
        boundaryMessageCount: baton.baton.boundaryMessageCount,
        action: baton.action,
        relayDecisionTrail: baton.relayDecisionTrail,
        reason: baton.reason,
      },
    });

    await this.advancePairOrchestration(pairId);
    return pair;
  }

  public async stopPair(pairId: PairId): Promise<Pair> {
    const pair = await this.repos.pairs.findById(pairId);
    if (!pair) throw new RelayDomainError(`Pair ${pairId} not found`, 'PAIR_NOT_FOUND');
    pair.stopRelay();
    await this.repos.pairs.save(pair);
    await this.emitEvent('pair', pair.id, 'pair.stopped', {
      actor: 'user',
      newState: pair.status,
    });
    return pair;
  }

  private supervisionTimer: any = null;

  /**
   * Starts non-blocking background supervision loop (Phase 8).
   *
   * I-2 GATE — ARMED (S6), in `runSupervisionTick`. A ticking loop is continuous
   * provider contact by construction, so §11.5 requires the tick to be gated on
   * `operational_state === 'ACTIVE'`. This method only schedules the tick, so the
   * gate there gates the loop completely; no second check is needed here and none
   * is added, because one enforcement point is the point.
   *
   * `tickOverride` lets a caller run work AFTER a supervision tick without this
   * class owning another timer. The override is additive and cannot replace,
   * reorder, or fail the supervision tick itself; Phase 1 health monitoring uses
   * it to ride this existing cadence rather than starting its own loop.
   */
  public startSupervisionLoop(
    intervalMs = 5000,
    tickOverride?: () => Promise<unknown>,
  ): void {
    if (this.supervisionTimer) return;
    this.supervisionTimer = setInterval(() => {
      this.runSupervisionTick().catch((err) => {
        console.error('[RelayEngine] Error in background supervision tick:', err);
      });
      if (tickOverride) {
        // Failures are swallowed: monitoring must never disturb supervision.
        Promise.resolve()
          .then(() => tickOverride())
          .catch((err) => {
            console.warn('[RelayEngine] Post-supervision observer failed (ignored):', err?.message ?? err);
          });
      }
    }, intervalMs);
    if (typeof this.supervisionTimer?.unref === 'function') {
      this.supervisionTimer.unref();
    }
  }

  /**
   * Stops background supervision loop.
   */
  public stopSupervisionLoop(): void {
    if (this.supervisionTimer) {
      clearInterval(this.supervisionTimer);
      this.supervisionTimer = null;
    }
  }

  public isSupervisingLoopActive(): boolean {
    return this.supervisionTimer !== null;
  }

  /* --- Dispatch-Intent Reconciliation -------------------------------------
   *
   * The invariant implemented here:
   *
   *   Every durable dispatch intent must eventually reach a terminal,
   *   operator-visible disposition. A Delivery must not remain `delivering`
   *   indefinitely after process interruption without either being resolved
   *   from authoritative evidence or surfaced as ambiguity requiring attention.
   *
   * ## The window this closes
   *
   * `dispatchAssignment` is deliberately three-phase (ATTEMPT_LIFECYCLE.md Case 1/2):
   *
   *   Phase 1  txn   prepared Attempt + Delivery(pending -> delivering)   COMMIT
   *   Phase 2  ---   provider.deliverInstruction()   <-- EXTERNAL SIDE EFFECT
   *   Phase 3  txn   confirmDelivered | markAmbiguous | markFailed      COMMIT
   *
   * A crash inside Phase 2 leaves `Attempt = prepared` and `Delivery = delivering`
   * while the external worker may or may not have received the instruction. The
   * duplicate-dispatch guards then correctly refuse to resend — which is safe, but on
   * its own leaves the assignment wedged forever with no operator signal. Nothing
   * previously resolved that state. `recoverOnStartup` inspected runtimes, never
   * deliveries, and the provider's `reconcileDispatch` hook existed but was never called.
   *
   * ## Why this is an engine concern, not a controller concern
   *
   * The Plan-First controller deliberately observes a `prepared | running` attempt and
   * never advances it (PLAN_FIRST_DOMAIN_FREEZE.md section G step 6). That is correct:
   * the controller must not guess. Resolving dispatch ground truth is a different
   * question from deciding whether work is complete, so it lives here, in the engine,
   * and the controller is untouched.
   *
   * ## Why it is idempotent
   *
   * Idempotency is a consequence of the state machine, not a separate mechanism. A
   * delivery is examined only while it is unresolved. Its terminal disposition and the
   * Attention item (if any) are committed in ONE transaction, so the item can never be
   * written twice, and once terminal the delivery is no longer returned by
   * `findUnresolved()`. Repeated passes are therefore no-ops. Provider probes are
   * read-only, so re-probing after a rolled-back transaction is safe.
   *
   * ## What it never does
   *
   * It never resends. It never creates an Assignment or an Attempt. It never advances a
   * WorkUnit and never produces a VerificationResult. Completion remains reachable only
   * through the normal worker-evidence plus verification path.
   */

  /**
   * Drives every unresolved durable dispatch intent to a terminal disposition.
   *
   * @param options.assignmentId scope to one assignment (used before dispatching more work)
   */
  public async reconcileUnresolvedDispatches(
    options: { assignmentId?: AssignmentId; context?: AuthorityContext } = {},
  ): Promise<DispatchReconciliationReport> {
    const dispositions: DispatchReconciliationDispositionRecord[] = [];
    const context = options.context ?? 'AUTOMATED';

    // `ambiguous` is re-examined on purpose. `ambiguous` does NOT mean "failed" — it means
    // "RelayX could not establish whether the instruction landed, and therefore must not
    // resend" (SEMANTIC_FREEZE §9). That is precisely the open question a reconciliation probe
    // answers, so an ambiguous intent is unresolved work, not finished work. Leaving it out
    // made every intent that was ambiguous purely because the provider exposed no probe
    // permanently unresolvable: wedged, operator-visible, and never re-checked even after the
    // probe exists.
    //
    // `pending`/`delivering` are the crash-stranded intents. `delivered` and `failed` are
    // terminal and are never returned.
    const reexaminable = (d: Delivery): boolean =>
      d.status === 'pending' || d.status === 'delivering' || d.status === 'ambiguous';

    const candidates = options.assignmentId
      ? (await this.repos.deliveries.findByAssignmentId(options.assignmentId)).filter(reexaminable)
      : [...(await this.repos.deliveries.findUnresolved()), ...(await this.repos.deliveries.findAmbiguous())];

    for (const delivery of candidates) {
      // Re-read under the current transaction boundary: another pass may have
      // already driven this delivery terminal.
      const current = await this.repos.deliveries.findById(delivery.id);
      if (!current || !reexaminable(current)) {
        continue;
      }

      const outcome = await this.probeDispatchOutcome(current, context);
      const record = await this.commitDispatchDisposition(current, outcome);
      dispositions.push(record);
    }

    return {
      examined: candidates.length,
      deliveredConfirmed: dispositions.filter((d) => d.disposition === 'delivered_confirmed').length,
      notDeliveredConfirmed: dispositions.filter((d) => d.disposition === 'not_delivered_confirmed').length,
      ambiguousRaised: dispositions.filter((d) => d.disposition === 'ambiguous_raised').length,
      dispositions,
    };
  }

  /**
   * Asks the authoritative provider whether a stranded dispatch actually landed.
   *
   * Every failure mode here — absent runtime, unregistered provider, missing hook, or a
   * thrown probe — resolves to `insufficient`. A provider that cannot answer has NOT
   * thereby proven anything, and an unanswered question about a durable dispatch intent
   * is itself unresolved work that an operator must see.
   */
  private async probeDispatchOutcome(
    delivery: Delivery,
    context: AuthorityContext = 'AUTOMATED',
  ): Promise<DispatchProbeOutcome> {
    const attempt = await this.repos.attempts.findById(delivery.attemptId);
    if (!attempt) {
      return {
        kind: 'insufficient',
        reason: `Dispatch intent ${delivery.id} references missing attempt ${delivery.attemptId}`,
      };
    }

    const runtime = await this.repos.runtimes.findById(delivery.targetRuntimeId);
    if (!runtime) {
      return {
        kind: 'insufficient',
        reason: `Dispatch intent ${delivery.id} targets unknown runtime ${delivery.targetRuntimeId}`,
      };
    }
    // NOTE: there is deliberately NO `runtime.status === 'terminated'` refusal here any more.
    //
    // It used to return `insufficient` WITHOUT probing. Combined with the same gate in
    // `resolveBatonSide`, that made this local status doubly absorbing: an `ambiguous` intent
    // whose target runtime observationally terminated could never be resolved by evidence
    // again, so it stayed ambiguous forever and the baton could never move. That satisfies
    // "never resend" only by never learning anything at all.
    //
    // `terminated` is a LOCAL observation-failure counter and is not evidence about the
    // conversation, so it is not a valid reason to withhold the probe. The authoritative
    // provider probe below now decides. When the provider genuinely cannot answer, this still
    // returns `insufficient` and the Delivery is still never resent — which is the invariant
    // that actually matters (I-6, I-13). The local status is carried into the reason so the
    // refusal stays traceable to what RelayX could and could not establish.
    const locallyTerminal = runtime.isObservationallyTerminal();

    // I-2 GATE — ARMED (S6). `provider.reconcileDispatch(...)` below is a real
    // external contact, not a local read, so §11.5 gates it according to the
    // CALL CONTEXT (REALIGNMENT). The owning Pair is reached through the Attempt's
    // FROZEN authority (`sessionPairId`), never a mutable lookup, so the gate
    // consults the same Pair the dispatch was authorized against.
    //
    // `insufficient` is the correct disposition: the probe was not performed, so
    // RelayX genuinely does not know. It is NOT recorded as `not_delivered`, because
    // that would assert an external fact that was never established (I-6, I-13).
    if (attempt.sessionPairId) {
      const owningPair = await this.repos.pairs.findById(attempt.sessionPairId);
      if (owningPair) {
        try {
          owningPair.assertContactPermitted(context);
        } catch (err: any) {
          return {
            kind: 'insufficient',
            reason:
              `Pair ${attempt.sessionPairId} does not permit ${context} contact, so dispatch ` +
              `intent ${delivery.id} cannot be probed. No provider contact was made and no ` +
              `external state was inferred (DESIGN_FREEZE I-2, I-6, §11.5). Error: ${err.message}`,
          };
        }
      }
    }

    let provider: IRuntimeProvider;
    try {
      provider = this.getProvider(runtime.providerType);
    } catch {
      return {
        kind: 'insufficient',
        reason: `No provider registered for '${runtime.providerType}' to reconcile dispatch ${delivery.id}`,
      };
    }

    if (typeof provider.reconcileDispatch !== 'function') {
      return {
        kind: 'insufficient',
        reason:
          `Provider '${runtime.providerType}' exposes no dispatch reconciliation probe, so whether ` +
          `intent ${delivery.id} landed was not established` +
          (locallyTerminal
            ? `. Its target runtime '${runtime.id}' is additionally in RelayX's locally-derived ` +
              'terminal state from failed observation probes, which is not itself evidence that the ' +
              'conversation is gone, and the intent is still deliberately NOT resent.'
            : '.'),
      };
    }

    try {
      const result = await provider.reconcileDispatch({
        sessionId: runtime.id,
        deliveryId: delivery.id,
        instructionSnippet: delivery.instructionSnippet,
        // Frozen authority is preferred over the live runtime field: the attempt records
        // what dispatch was actually authorized against (EXECUTION_AUTHORITY.md).
        externalSessionId: attempt.externalSessionId ?? runtime.externalSessionId ?? null,
        idempotencyKey: delivery.idempotencyKey,
      });

      // `delivered` is only admissible WITH verified observable evidence. Delivery
      // requires verified observable evidence (entities.ts confirmDelivered), so a bare
      // `delivered` with no evidence is not authoritative and must not be trusted.
      if (result.outcome === 'delivered') {
        if (!result.evidence) {
          return {
            kind: 'insufficient',
            reason: result.reason ?? 'Provider reported delivered without observable evidence',
          };
        }
        return { kind: 'delivered', evidence: result.evidence, reason: result.reason };
      }

      if (result.outcome === 'not_delivered') {
        return { kind: 'not_delivered', evidence: result.evidence, reason: result.reason };
      }

      // supporting_evidence_only | unknown | unsupported — all insufficient.
      return {
        kind: 'insufficient',
        evidence: result.evidence,
        reason:
          result.reason ??
          `Provider reconciliation for ${delivery.id} was '${result.outcome}', which is not authoritative`,
      };
    } catch (err) {
      return {
        kind: 'insufficient',
        reason: `Dispatch reconciliation probe failed for ${delivery.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  /**
   * Resolves the open `ambiguous_delivery` Attention items for one Assignment.
   *
   * Called only when reconciliation has produced an AUTHORITATIVE disposition. An
   * `ambiguous_delivery` item asserts one thing — "RelayX cannot tell whether the instruction
   * landed" — so once the probe answers that question with evidence, the item is no longer
   * true and leaving it open would contradict the Delivery it points at.
   *
   * Resolution is by Assignment + type, never by guessing at a delivery id: `AttentionItem`
   * has no delivery column, and the message text is the only place the delivery id appears.
   * It is also deliberately narrow — only `ambiguous_delivery` items are touched, so an
   * unrelated operator task on the same Assignment is never silently closed.
   */
  private async resolveAmbiguityAttention(
    assignmentId: AssignmentId,
    answeredBy: string,
  ): Promise<AttentionItemId[]> {
    const resolved: AttentionItemId[] = [];
    for (const item of await this.repos.attention.findOpen()) {
      if (item.type !== 'ambiguous_delivery') continue;
      if (item.assignmentId !== assignmentId) continue;
      item.resolve();
      await this.repos.attention.save(item);
      resolved.push(item.id);
    }
    if (resolved.length > 0) {
      await this.emitEvent('attention', resolved[0], 'attention.resolved', {
        actor: 'reconciler',
        previousState: 'open',
        newState: 'resolved',
        details: { assignmentId, answeredBy, resolvedItemIds: resolved },
      });
    }
    return resolved;
  }

  /**
   * Commits one terminal disposition atomically.
   *
   * The Delivery, the Attempt, the Attention item and the events land in ONE
   * transaction, so a crash mid-way can never leave an Attention item without its
   * Delivery, or a terminal Delivery that no pass will ever revisit.
   */
  private async commitDispatchDisposition(
    delivery: Delivery,
    outcome: DispatchProbeOutcome,
  ): Promise<DispatchReconciliationDispositionRecord> {
    // Captured BEFORE any mutation: an `ambiguous` intent that stays ambiguous must not be
    // re-marked, because re-marking is what would otherwise mint a second Attention item for
    // the same unresolved dispatch on every pass.
    const wasAlreadyAmbiguous = delivery.status === 'ambiguous';
    return this.repos.runInTransaction(async () => {
      const attempt = await this.repos.attempts.findById(delivery.attemptId);

      if (outcome.kind === 'delivered') {
        // Outcome A — authoritative evidence says it landed.
        // Same Assignment, same Attempt, same Delivery. No resend, no advancement.
        delivery.confirmDelivered(withRecordedBoundary(outcome.evidence!, delivery.evidence));
        await this.repos.deliveries.save(delivery);

        if (attempt && attempt.status === 'prepared') {
          // Execution promotion removed per freeze: delivery confirmation (`delivered`)
          // does not prove execution began (`Attempt.running` requires execution evidence).
          // The promotion mechanism (`promoteAttemptToRunning()`) must be called
          // separately when execution/completion evidence is observed.
        }

        // The doubt the Attention item expressed ("could not determine whether the
        // instruction reached the worker") is now answered by evidence, so leaving a CRITICAL
        // item open would misreport the operator's queue.
        const resolvedAttentionIds = await this.resolveAmbiguityAttention(
          delivery.assignmentId,
          'the exact instruction was found in the target session',
        );

        await this.emitEvent('delivery', delivery.id, 'delivery.confirmed', {
          actor: 'reconciler',
          previousState: wasAlreadyAmbiguous ? 'ambiguous' : 'delivering',
          newState: 'delivered',
          evidence: outcome.evidence,
          details: {
            attemptId: delivery.attemptId,
            reason: outcome.reason,
            reconciledFromAmbiguous: wasAlreadyAmbiguous,
            resolvedAttentionItemIds: resolvedAttentionIds,
          },
        });

        return {
          deliveryId: delivery.id,
          attemptId: delivery.attemptId,
          assignmentId: delivery.assignmentId,
          disposition: 'delivered_confirmed',
        };
      }

      if (outcome.kind === 'not_delivered') {
        // Outcome B — proven absent. The Attempt deliberately stays `prepared`
        // (ATTEMPT_LIFECYCLE.md Case 1: intent stored, external send not performed).
        // Reconciliation establishes truth; it does NOT resend. Normal dispatch
        // machinery mints a fresh attempt with a fresh attemptNumber later.
        delivery.markFailed(outcome.reason ?? 'Provider confirmed the dispatch did not occur', outcome.evidence);
        await this.repos.deliveries.save(delivery);

        // Same reasoning as Outcome A: the ambiguity is answered ("it did not land"), so the
        // CRITICAL item is resolved rather than left contradicting the terminal state.
        const resolvedAttentionIds = await this.resolveAmbiguityAttention(
          delivery.assignmentId,
          'the exact session was read and does not contain the dispatched instruction',
        );

        await this.emitEvent('delivery', delivery.id, 'delivery.failed', {
          actor: 'reconciler',
          previousState: wasAlreadyAmbiguous ? 'ambiguous' : 'delivering',
          newState: 'failed',
          evidence: outcome.evidence,
          details: { attemptId: delivery.attemptId, reason: outcome.reason, reconciled: true },
        });

        return {
          deliveryId: delivery.id,
          attemptId: delivery.attemptId,
          assignmentId: delivery.assignmentId,
          disposition: 'not_delivered_confirmed',
        };
      }

      // Outcome C — insufficient evidence. Conservative, operator-visible, no resend.
      const reason = outcome.reason ?? 'Dispatch outcome could not be established';

      // Re-probing an ALREADY-ambiguous intent is the new case. Operator visibility is the
      // invariant, and visibility is a property of the Delivery being unresolved — not of how
      // many times a pass asked about it. So a re-probe that is still insufficient commits
      // NOTHING: the Delivery keeps its status, evidence, and failure reason, and the existing
      // Attention item is reused. Without this, every reconciliation pass would append another
      // CRITICAL item for the same unresolved dispatch and bury the operator in duplicates.
      if (wasAlreadyAmbiguous) {
        const existing = (
          await this.repos.attention.findOpen()
        ).find((a) => a.type === 'ambiguous_delivery' && a.assignmentId === delivery.assignmentId);

        // Re-examination that changes nothing must be a genuine NO-OP in the durable event
        // stream, not just in the Delivery and Attention rows.
        //
        // The Attention half of this was already idempotent: the open item is reused, so no
        // duplicate operator task is ever minted. The EVENT half was not. Supervision runs on
        // a fixed interval and re-examines `ambiguous` intents on every pass by design, so
        // each pass appended another `delivery.ambiguous` row for an unchanged disposition.
        // On the live "RelayX Development" Pair this produced 7,282 identical
        // `ambiguous -> ambiguous` events and still growing — one row every few seconds,
        // forever, for a state that has not changed since it was first raised. That is not an
        // audit trail; it is unbounded growth that buries the transitions an operator needs.
        //
        // So the durable episode marker is the Delivery's own transition INTO `ambiguous`,
        // emitted once by the branch below. A re-probe that yields the same explanation and
        // the same evidence writes NOTHING here at all. A re-probe that yields a genuinely
        // NEW explanation does emit, because that is new information about an open question
        // and hiding it would make the operator's queue misleading.
        const sameExplanationAsBefore =
          delivery.failureReason === reason && delivery.evidence?.id === outcome.evidence?.id;

        if (!sameExplanationAsBefore) {
          await this.emitEvent('delivery', delivery.id, 'delivery.reexamined', {
            actor: 'reconciler',
            previousState: 'ambiguous',
            newState: 'ambiguous',
            evidence: outcome.evidence,
            details: {
              attemptId: delivery.attemptId,
              reason,
              attentionItemId: existing?.id ?? null,
              reexamined: true,
              stateChanged: false,
              // The disposition is unchanged by design; what changed is WHY RelayX still
              // cannot answer, which is the only part an operator can act on.
              explanationChanged: true,
              previousReason: delivery.failureReason ?? null,
            },
          });
        }

        return {
          deliveryId: delivery.id,
          attemptId: delivery.attemptId,
          assignmentId: delivery.assignmentId,
          disposition: 'ambiguous_raised',
          attentionItemId: existing?.id,
        };
      }

      delivery.markAmbiguous(reason, outcome.evidence);
      await this.repos.deliveries.save(delivery);

      const assignment = await this.repos.assignments.findById(delivery.assignmentId);
      const pair = assignment ? await this.repos.pairs.findById(assignment.pairId) : null;
      const runtime = await this.repos.runtimes.findById(delivery.targetRuntimeId);

      // AttentionItem carries only pairId/assignmentId, so the remaining durable
      // context is recorded in the message, matching the existing ambiguous path.
      const attention = AttentionItem.create(
        'critical',
        'ambiguous_delivery',
        'Unresolved dispatch intent after restart',
        [
          `RelayX could not determine whether a dispatched instruction reached the worker.`,
          `Project: ${pair?.projectId ?? 'unknown'}.`,
          `Assignment: ${delivery.assignmentId}.`,
          `Attempt: ${delivery.attemptId} (status ${attempt?.status ?? 'unknown'}).`,
          `Delivery: ${delivery.id}.`,
          `Target runtime: ${delivery.targetRuntimeId}${runtime ? ` (${runtime.name}, ${runtime.providerType})` : ''}.`,
          `Idempotency key: ${delivery.idempotencyKey}.`,
          `Reason: ${reason}.`,
          `No instruction was resent. Confirm the worker state before any further dispatch.`,
        ].join(' '),
        {
          pairId: pair?.id,
          assignmentId: delivery.assignmentId,
          suggestedAction:
            'Inspect the worker session and determine whether the instruction was received, then confirm delivery or reset the attempt. Automated resend stays blocked.',
          suggestedTier: 'tier_1_deterministic',
        },
      );
      await this.repos.attention.save(attention);

      await this.emitEvent('delivery', delivery.id, 'delivery.ambiguous', {
        actor: 'reconciler',
        previousState: 'delivering',
        newState: 'ambiguous',
        evidence: outcome.evidence,
        details: { attemptId: delivery.attemptId, reason, attentionItemId: attention.id },
      });

      return {
        deliveryId: delivery.id,
        attemptId: delivery.attemptId,
        assignmentId: delivery.assignmentId,
        disposition: 'ambiguous_raised',
        attentionItemId: attention.id,
      };
    });
  }

  /**
   * Continuity recovery THREW for one Pair. This used to be swallowed with an empty catch.
   *
   * ## Why a contained throw is not the same as a handled outcome
   *
   * `resumeRelayContinuity` decides between outcomes deliberately: an unreadable transcript,
   * an unlocatable boundary, an unresolved intent — each one becomes a *decision* with a
   * reason, is written to the event stream, and is visible in the returned report. An
   * exception is none of those. It is RelayX failing to decide, and before this existed the
   * startup path discarded it completely: no log, no Event, no Attention, and no entry in the
   * returned `batonDecisions`, so an operator reading the startup report saw a clean pass over
   * a Pair that was in fact stranded with no indication of why.
   *
   * ## What this records, and what it deliberately does not do
   *
   * It records durable evidence and nothing else. It never resends a Delivery, never mints an
   * Attempt, never touches the baton, and never writes to `active_assignment_id` or to any
   * Assignment's status. A failure to observe is not a statement about the work, and the
   * records that the relay reasons from must therefore come out of a failed recovery exactly
   * as they went in. Continuity is re-derived from the same durable rows on the next attempt.
   *
   * ## Why AttentionItem + RelayEvent rather than a HealthIncident
   *
   * Every other relay-internal failure already uses this pair: `ambiguous_delivery`,
   * `worker_execution_failed`, `runtime_suspended`, `continuation_delivery_failed`. A
   * `HealthIncident` is the wrong home: `domain/healthDomain.ts` states that health records are
   * read-only with respect to Pair/Attempt/Delivery/Runtime, are produced by named health
   * *checks* on their own cadence, and never perform repair — none of which describes an
   * exception thrown by the relay state machine itself.
   *
   * ## Why it cannot spam
   *
   * One open Attention item per Pair is the whole episode. Repeat failures add nothing durable,
   * because the open item already says it is unresolved and its `createdAt` is when the episode
   * began. The Event is written once, at the moment the episode opens. Resolution is explicit
   * and uses the existing `AttentionItem.resolve()` lifecycle.
   *
   * ## Why it can never abort the remaining Pairs
   *
   * Every step is independently guarded, and the whole method is wrapped once more. If the
   * durable store is itself what failed, both the Event and the Attention write can fail; the
   * last resort is a `console.error`, which is the only channel that cannot itself depend on
   * the database. A Pair that cannot even be recorded must not prevent the next Pair from
   * recovering.
   */
  private async recordContinuityRecoveryFailure(
    pair: Pair,
    err: unknown,
    context: 'startup' | 'supervision',
  ): Promise<{ attentionItemId: string | null }> {
    const CONTEXT: Record<string, string> = { startup: 'startup', supervision: 'supervision' };
    const operation = 'resumeRelayContinuity';

    // Structural classification only. Nothing here pattern-matches the message text, so the
    // category cannot be changed by the wording of an underlying provider or driver error.
    const rawCode =
      typeof (err as any)?.code === 'string' ? ((err as any).code as string) : null;
    const category: 'authority' | 'durable_store' | 'unexpected' =
      rawCode && /SQLITE/i.test(rawCode)
        ? 'durable_store'
        : (err as any)?.name === 'RelayDomainError'
          ? 'authority'
          : 'unexpected';
    const message =
      sanitizeHealthText((err as any)?.message ?? String(err), HEALTH_EVIDENCE_MAX_STRING_LENGTH) ??
      'no error message was reported';

    try {
      const open = await this.repos.attention.findOpen();
      const existing = open.find(
        (i) => i.type === RelayEngine.CONTINUITY_RECOVERY_FAILURE && i.pairId === pair.id,
      );
      if (existing) {
        // The episode is already open and unresolved. Adding another item would report one
        // unresolved problem per tick for a single problem, so nothing durable is written.
        return { attentionItemId: existing.id };
      }

      const recordedAt = Date.now();
      const attention = AttentionItem.create(
        'critical',
        RelayEngine.CONTINUITY_RECOVERY_FAILURE,
        'Relay continuity recovery failed for this Session Pair',
        [
          `Session Pair: ${pair.name} (${pair.id}).`,
          `Recovery context: ${CONTEXT[context]}.`,
          `Operation: ${operation}.`,
          `Failure category: ${category}.`,
          rawCode ? `Failure code: ${rawCode}.` : null,
          `Failure: ${message}`,
          `RelayX state at the time: operational=${pair.operationalState}, relay=${pair.relayState}, ` +
            `executionSlot=${pair.activeAssignmentId ?? 'none'}.`,
          'No Delivery was resent, no Attempt was created, and no Assignment, Delivery or baton ' +
            'state was changed by this failure. The relay chain is re-derived from the same durable ' +
            'records on the next recovery attempt, so continuity continues rather than restarts.',
        ]
          .filter(Boolean)
          .join(' '),
        {
          pairId: pair.id,
          suggestedAction:
            'RelayX could not reconstruct this Pair\'s continuity. No work was lost and nothing was ' +
            'resent; the next supervision tick retries automatically. If this persists, inspect the ' +
            'underlying failure above and confirm both bound sessions are reachable.',
          suggestedTier: 'tier_1_deterministic',
        },
      );
      await this.repos.attention.save(attention);

      try {
        await this.emitEvent('pair', pair.id, 'pair.continuity_recovery_failed', {
          actor: context === 'startup' ? 'recovery' : 'supervisor',
          newState: pair.relayState,
          details: {
            recoveryContext: CONTEXT[context],
            operation,
            failureCategory: category,
            failureCode: rawCode,
            failureMessage: message,
            recordedAt,
            attentionItemId: attention.id,
            operationalState: pair.operationalState,
            relayState: pair.relayState,
            executionSlotAssignmentId: pair.activeAssignmentId ?? null,
            // Stated explicitly so a later reader never mistakes this for a verdict about work.
            transportTouched: false,
            attemptCreated: false,
            continuityMutated: false,
            semanticJudgmentMade: false,
          },
        });
      } catch {
        // The Attention item above is already durable, so the operator is still reached.
      }

      return { attentionItemId: attention.id };
    } catch (recordErr: any) {
      console.error(
        `[RelayEngine] Continuity recovery failed for Pair ${pair.id} and the failure could not be ` +
          `recorded durably: ${recordErr?.message ?? recordErr}`,
      );
      return { attentionItemId: null };
    }
  }

  /**
   * A later recovery of this Pair succeeded, so the startup/supervision failure episode is closed.
   *
   * Uses the existing AttentionItem lifecycle: `resolve()` records `resolvedAt`. Only items still
   * `open` are auto-resolved — an `acknowledged` item has been claimed by an operator, and closing
   * it automatically would overrule them. That is the same rule `HealthIncident.updateFromObservation`
   * applies to `ACKNOWLEDGED`, and for the same reason.
   */
  private async resolveContinuityRecoveryIncident(
    pairId: PairId,
    context: 'startup' | 'supervision',
  ): Promise<void> {
    try {
      const open = await this.repos.attention.findOpen();
      const resolved = open.filter(
        (i) =>
          i.type === RelayEngine.CONTINUITY_RECOVERY_FAILURE && i.pairId === pairId && i.status === 'open',
      );
      if (resolved.length === 0) return;

      for (const item of resolved) {
        item.resolve();
        await this.repos.attention.save(item);
      }
      try {
        await this.emitEvent('pair', pairId, 'pair.continuity_recovery_resolved', {
          actor: context === 'startup' ? 'recovery' : 'supervisor',
          details: {
            recoveryContext: context,
            resolvedAttentionItemIds: resolved.map((i) => i.id),
            reason:
              'A later continuity recovery for this Pair completed without throwing, so the failure ' +
              'episode is closed. The relay chain continued from its existing durable records.',
          },
        });
      } catch {
        // The resolution itself is already durable.
      }
    } catch (err: any) {
      // Never let housekeeping break the recovery pass it is running inside.
      console.error(
        `[RelayEngine] Could not close the continuity-recovery incident for Pair ${pairId}: ${
          err?.message ?? err
        }`,
      );
    }
  }

  /**
   * Recovers state upon application startup or following an unexpected restart (Phase 9).
   *
   * ## What it does now
   *
   * Startup runs the SAME relay state machine as the steady-state tick: for every Pair that
   * permits automated contact, `resumeRelayContinuity` re-derives the baton from the last
   * confirmed Delivery, reconciles stranded intents, reads the baton owner's exact session
   * after the recorded boundary, and then keeps watching, hands on a completed turn exactly
   * once, or reports the mechanical gap to the Planner exactly once.
   *
   * ## What it used to do, and why that was wrong
   *
   * It inspected `pair.workerSessionId` unconditionally and created the Handoff from
   * `inspectRuntime(...).isComplete`. Two defects followed. It read the WORKER even when the
   * baton was held by the Planner — so a Planner-owned conversation was never recovered — and
   * it created a Handoff from a UI/summary heuristic rather than from the exact session,
   * which is the detector this method now shares with the tick instead of duplicating.
   *
   * ## I-2 GATE — ARMED (S6)
   *
   * This path contacts providers at startup, so §11.5 gates it on
   * `operational_state === 'ACTIVE'` like every other provider contact. An IDLE Pair is
   * skipped, which is what makes restart deterministic: a persisted IDLE Pair costs zero
   * provider calls. This path NEVER activates a Pair (§4.2), and a legacy
   * `status='active'` cannot override `operationalState='IDLE'`.
   */
  public async recoverOnStartup(): Promise<{
    reconciledAssignments: number;
    suspendedRuntimes: number;
    recoveredHandoffs: number;
    dispatchIntents: DispatchReconciliationReport;
    batonDecisions: RelayBatonDecisionReport[];
  }> {
    // Dispatch ground truth is established FIRST. Reconciliation of a stranded
    // delivery decides whether work is already in flight, so it must not be
    // influenced by — or race with — the observation below, which can create handoffs and
    // change assignment state.
    const dispatchIntents = await this.reconcileUnresolvedDispatches({ context: 'AUTOMATED' });

    let reconciledAssignments = 0;
    let suspendedRuntimes = 0;
    let recoveredHandoffs = 0;
    const batonDecisions: RelayBatonDecisionReport[] = [];

    const restartPairs = (await this.repos.pairs.findAll())
      .filter((candidate) => candidate.isAutomatedContactPermitted())
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    for (const pair of restartPairs) {
      try {
        const report = await this.resumeRelayContinuity(pair.id, {
          context: 'AUTOMATED',
          actor: 'recovery',
        });
        batonDecisions.push(report);

        // A recovery that did not throw closed any earlier failure episode for this Pair.
        // Resolution is explicit and uses the existing AttentionItem lifecycle.
        await this.resolveContinuityRecoveryIncident(pair.id, 'startup');

        if (
          report.action.kind === 'handoff_created' ||
          report.action.kind === 'handoff_advanced'
        ) {
          recoveredHandoffs++;
        } else if (report.observation?.transcriptReadable) {
          reconciledAssignments++;
        } else if (report.observation && !report.observation.transcriptReadable) {
          suspendedRuntimes++;
        }

        await this.emitEvent('pair', pair.id, 'pair.recovered_continuity', {
          actor: 'recovery',
          newState: pair.relayState,
          details: {
            decision: report.decision,
            batonDirection: report.baton.direction,
            batonOwner: report.baton.owner,
            basisDeliveryId: report.baton.deliveryId,
            boundaryProvenance: report.baton.boundaryProvenance,
            boundaryMessageCount: report.baton.boundaryMessageCount,
            action: report.action,
            relayDecisionTrail: report.relayDecisionTrail,
            reason: report.reason,
            semanticJudgmentMade: false,
          },
        });

        // A Handoff recorded here is deliberately NOT converted in this pass. Startup
        // reconciles and observes; it does not originate sends. The conversion into an
        // opposite-side Assignment, and the Delivery that moves the baton, happen on the
        // first supervision tick — which also preserves the observable boundary between
        // "a completed turn was recovered" and "it was handed over" as two visible
        // transitions rather than one. `resumePair` differs deliberately: that is an
        // operator asking to continue now, so it advances immediately.
      } catch (err) {
        // Tolerant of individual failures during startup: one Pair's provider problem must
        // not prevent the rest of the relay fleet from recovering.
        //
        // "Tolerant" must never mean "invisible". The throw is recorded durably and surfaced in
        // the returned report, so the Pair is observably stranded rather than silently skipped.
        // Recording is itself fully guarded, and it mutates nothing: no Delivery is resent, no
        // Attempt is minted, no Assignment status and no execution slot is written, and the baton
        // is untouched. Continuity is re-derived from the same durable rows on the next attempt.
        //
        // The synthetic decision below is the same shape `runSupervisionTick` already produces for
        // a contained failure, so one list describes every Pair's outcome regardless of how it
        // was reached.
        await this.recordContinuityRecoveryFailure(pair, err, 'startup');
        batonDecisions.push({
          pairId: pair.id,
          decision: 'transcript_unreadable',
          relayDecisionTrail: [
            `startup continuity recovery threw and was contained so the remaining Pairs could recover: ${
              (err as any)?.message ?? String(err)
            }`,
          ],
          baton: {
            basis: 'no_confirmed_delivery',
            direction: null,
            owner: null,
            sender: null,
            deliveryId: null,
            assignmentId: null,
            attemptId: null,
            deliveredAt: null,
            boundarySessionId: null,
            boundaryMessageCount: null,
            boundaryProvenance: null,
            dispatchedExternalSessionId: null,
            confirmedDeliveryCount: 0,
            supersededDeliveryCount: 0,
          },
          observation: null,
          action: { kind: 'none' },
          reason:
            `Startup continuity recovery for this Pair threw and was contained so the other Pairs ` +
            `could still recover. RelayX did not resend anything, did not create an Attempt, and did ` +
            `not change the baton or the execution slot. A durable incident records the failure, and ` +
            `the next supervision tick retries this Pair automatically.`,
        });
      }
    }

    return {
      reconciledAssignments,
      suspendedRuntimes,
      recoveredHandoffs,
      dispatchIntents,
      batonDecisions,
    };
  }

  /* ================================================================== *
   * Plan-First controller (PLAN_FIRST_DOMAIN_FREEZE.md §G)
   * ================================================================== */

  /**
   * One production Plan-First tick. Rewritten from scratch against the frozen algorithm;
   * the previous implementation was defective scaffolding.
   *
   * Defects this rewrite eliminates (see PLAN_FIRST_DOMAIN_FREEZE.md §11.1):
   *  - It created and saved an Attempt, THEN called dispatchAssignment(), which created a
   *    SECOND Attempt for the same dispatch. Exactly one Assignment and exactly one Attempt
   *    per WorkUnit execution is now structural: this method never constructs an Attempt.
   *  - It persisted a mutable `currentWorkUnitId` cursor that could not survive recovery
   *    and whose `run_completed` branch assigned an object to a scalar (TS2322). The cursor
   *    is now DERIVED from persisted (ordinal, status) state.
   *  - It created a `Strategy` and a `PlannerAssistance`, both frozen as rejected/deferred.
   *  - It completed a unit by writing a status string, bypassing domain transitions.
   *  - It marked a run `completed` while a further eligible unit remained.
   *
   * Idempotency: repeated ticks never create a duplicate Assignment for a WorkUnit, never
   * create a duplicate Attempt for the same dispatch, never re-dispatch an accepted unit,
   * never advance past failed verification, never switch revision, never infer completion
   * from provider UI, and never select a different Pair because discovery changed.
   */
  public async runPlanFirstTick(runId: PlanFirstRunId): Promise<PlanFirstTickResult> {
    const repos = this.repos;

    // --- 1. Load the authoritative run.
    const run = await repos.planFirstRuns.findById(runId);
    if (!run) throw new RelayDomainError(`PlanFirstRun ${runId} not found`, 'NOT_FOUND');

    const pair = await repos.pairs.findById(run.sessionPairId);
    if (!pair) throw new RelayDomainError(`Pair ${run.sessionPairId} not found`, 'NOT_FOUND');

    // Authority check: Plan-First execution is AUTOMATED relay behavior.
    if (!pair.isAutomatedContactPermitted()) {
      return {
        transition: 'run_terminal', // actually run_suspended but we don't have that state yet for tick result
        runId: run.id,
        plannerUpdateRequired: false,
        blocker: 'pair_not_running',
      };
    }

    // --- 2. Invariant 2: a terminal run never executes again. No side effects.
    if (run.isTerminal()) {
      return { transition: 'run_terminal', runId: run.id, plannerUpdateRequired: false };
    }

    // --- 3. Resolve the frozen revision and refuse, never repair, on drift.
    const revision = await repos.contractRevisions.findById(run.contractRevisionId);
    if (!revision) {
      throw new RelayDomainError(`ContractRevision ${run.contractRevisionId} not found`, 'NOT_FOUND');
    }
    if (!revision.isApproved()) {
      throw new RelayDomainError(
        `ContractRevision ${revision.id} is not approved; execution requires approved intent`,
        'CONTRACT_NOT_APPROVED',
      );
    }
    // Invariant 7: the run stays bound to exactly the intent it was created for.
    run.assertBindingIntact(revision);

    // --- 4. Ordinal-ordered units. Creation invariant: at least one.
    const units = await repos.workUnits.findByContractRevisionId(run.contractRevisionId);
    if (units.length === 0) {
      throw new RelayDomainError(
        `ContractRevision ${run.contractRevisionId} has no work units`,
        'INVALID_STATE',
      );
    }

    // --- 5/6. Derive the current unit. No stored cursor exists.
    //
    // Pre-dispatch reconciliation runs here, at the engine boundary, BEFORE any new work
    // is selected for execution. This is the "before new dispatch selection" hook: a
    // dispatch intent stranded by a previous crash is resolved to a terminal disposition
    // first, so the engine never accumulates fresh work on top of an unresolved one.
    //
    // It is intentionally NOT inside the Plan-First domain and NOT inside
    // `dispatchAssignment`. This is engine/dispatch reliability, and the Plan-First
    // controller's own handling of `prepared | running` below is untouched.
    await this.reconcileUnresolvedDispatches({ context: 'AUTOMATED' });

    const inFlight = units.find((u) => u.status === 'in_progress');
    if (inFlight) {
      if (!inFlight.assignmentId) {
        // Torn state: in_progress with no assignment. Fail closed rather than fabricate.
        throw new RelayDomainError(
          `WorkUnit ${inFlight.id} is in_progress with no bound assignment`,
          'INVALID_STATE',
        );
      }
      const current = await repos.assignments.findById(inFlight.assignmentId);
      if (!current) {
        throw new RelayDomainError(
          `Assignment ${inFlight.assignmentId} for WorkUnit ${inFlight.id} not found`,
          'INVALID_STATE',
        );
      }
      const attempt = current.currentAttemptId
        ? await repos.attempts.findById(current.currentAttemptId)
        : null;

      // Selected but not yet dispatched: the durable-intent commit did not happen.
      if (!attempt) return this.dispatchPlanFirstUnit(run, inFlight);

      if (attempt.status === 'completed_physical') {
        return this.verifyPlanFirstUnit(run, inFlight, current, attempt, units);
      }
      if (attempt.status === 'interrupted') {
        return this.reconcileInterruptedPlanFirstUnit(run, inFlight, current, attempt);
      }
      // prepared | running: dispatch in flight or executing. Re-inspect, never re-dispatch.
      return this.reconcileInFlightPlanFirstUnit(run, inFlight, current, attempt);
    }

    // --- 7. A blocked unit stops the engine. It must NOT self-declare failure.
    const blockedUnits = units.filter((u) => u.status === 'blocked');
    if (blockedUnits.length > 0) {
      if (run.status !== 'blocked') {
        await repos.runInTransaction(async () => {
          run.block();
          await repos.planFirstRuns.save(run);
          await this.emitEvent('project', run.projectId, 'plan_first_run.blocked', {
            actor: 'engine',
            previousState: 'running',
            newState: 'blocked',
            correlationId: run.id,
            details: { reason: 'work_unit_blocked', workUnitId: blockedUnits[0].id },
          });
        });
      }
      return {
        transition: 'blocked_awaiting_planner',
        runId: run.id,
        workUnitId: blockedUnits[0].id,
        plannerUpdateRequired: true,
        blocker: 'verification_blocked',
      };
    }

    // --- 8. All prior units completed: select the next by ordinal.
    const target = units.find((u) => u.status === 'pending');
    if (!target) {
      await repos.runInTransaction(async () => {
        run.complete();
        await repos.planFirstRuns.save(run);
        await this.emitEvent('project', run.projectId, 'plan_first_run.completed', {
          actor: 'engine',
          previousState: 'running',
          newState: 'completed',
          correlationId: run.id,
        });
      });
      // Invariant 1: nothing re-dispatches.
      return { transition: 'run_completed', runId: run.id, plannerUpdateRequired: false };
    }

    // Transaction 1: unit selection + assignment creation, atomically. A crash between
    // them would either lose the dispatch record (re-dispatch hazard) or strand a unit
    // with no assignment.
    const selected = await repos.runInTransaction(async () => {
      // Re-read: a concurrent tick may have won the race.
      const fresh = await repos.workUnits.findById(target.id);
      if (!fresh || fresh.status !== 'pending') return null;

      const assignment = Assignment.create(
        run.sessionPairId,
        run.projectId,
        target.objective,
        target.instruction,
      );
      await repos.assignments.save(assignment);

      fresh.startExecution(assignment.id);
      await repos.workUnits.save(fresh);

      // Selecting a unit puts the run in `running` from EITHER `ready` or `blocked`
      // (§C.1). An already-`running` run is left alone: selecting a later unit is the
      // frozen `running -> running` self-transition of §C.1, not a fresh start, and
      // `start()` is correctly guarded to reject `running -> running`.
      if (run.status !== 'running') run.start();
      await repos.planFirstRuns.save(run);

      return { unit: fresh, assignment };
    });

    if (!selected) {
      // Lost the race; the winning tick owns the unit.
      return {
        transition: 'selection_raced',
        runId: run.id,
        workUnitId: target.id,
        plannerUpdateRequired: false,
      };
    }

    await this.emitEvent('assignment', selected.assignment.id, 'plan_first.unit_selected', {
      actor: 'engine',
      previousState: 'pending',
      newState: 'in_progress',
      correlationId: run.id,
      details: {
        workUnitId: selected.unit.id,
        ordinal: selected.unit.ordinal,
        contractRevisionId: run.contractRevisionId,
      },
    });

    return this.dispatchPlanFirstUnit(run, selected.unit);
  }

  /**
   * §G step 9 — dispatch the unit's ONE assignment through the established production path.
   *
   * This method NEVER constructs an Attempt. `dispatchAssignment()` is the single authority
   * for Attempt creation, which is what makes "exactly one Attempt per WorkUnit execution"
   * structural rather than a convention.
   */
  private async dispatchPlanFirstUnit(run: PlanFirstRun, unit: WorkUnit): Promise<PlanFirstTickResult> {
    const repos = this.repos;

    // Invariant 9: a missing worker runtime suspends execution, it never fabricates.
    const pair = await repos.pairs.findById(run.sessionPairId);
    if (!pair || !pair.workerSessionId) {
      await this.raisePlanFirstAttention(
        run,
        unit,
        'critical',
        'plan_first_no_worker_bound',
        'Plan-First worker runtime unavailable',
        `Run ${run.id} cannot dispatch WorkUnit ${unit.id}: pair ${run.sessionPairId} has no ` +
          'bound worker runtime. Execution is suspended; no dispatch was attempted.',
        'pair_worker_binding',
      );
      // Unit status is deliberately unchanged: the selection record and its attempt
      // history are retained (PLAN_FIRST_DOMAIN_FREEZE.md §C.1, no `suspended` run state).
      return {
        transition: 'dispatch_suspended',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: unit.assignmentId ?? undefined,
        plannerUpdateRequired: true,
        blocker: 'no_worker_runtime',
      };
    }

    const current = await repos.assignments.findById(unit.assignmentId!);
    if (!current) {
      throw new RelayDomainError(
        `Assignment ${unit.assignmentId} for WorkUnit ${unit.id} not found`,
        'INVALID_STATE',
      );
    }

    // Existing deliveries decide whether dispatch is legal at all. No blind resend.
    const existing = await repos.deliveries.findByAssignmentId(current.id);
    if (existing.some((d) => d.status === 'ambiguous')) {
      await this.blockPlanFirstUnit(run, unit, current, 'ambiguous_delivery', 'dispatch_ambiguous');
      return {
        transition: 'dispatch_ambiguous',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: current.id,
        plannerUpdateRequired: true,
        blocker: 'ambiguous_delivery',
      };
    }
    if (existing.some((d) => d.status === 'delivering')) {
      // Crash-equivalent: intent is durable, acknowledgement unknown. Reconcile, do not
      // resend.
      return {
        transition: 'dispatch_in_flight',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: current.id,
        plannerUpdateRequired: false,
      };
    }

    let dispatched: { assignment: Assignment; attempt: Attempt; delivery: Delivery };
    try {
      dispatched = await this.dispatchAssignment(current.id, 'AUTOMATED');
    } catch (err) {
      if (err instanceof RuntimeNotAvailableError) {
        // Invariant 9: suspend rather than corrupt run state. The durable intent and the
        // prepared Attempt already committed inside dispatchAssignment Phase 1.
        await this.raisePlanFirstAttention(
          run,
          unit,
          'warning',
          'plan_first_runtime_unavailable',
          'Plan-First worker runtime unavailable',
          `Dispatch of WorkUnit ${unit.id} could not proceed: ${err.message}. The prepared ` +
            'attempt and its dispatch intent remain durable; execution is suspended.',
          'recover_runtime',
        );
        return {
          transition: 'dispatch_suspended',
          runId: run.id,
          workUnitId: unit.id,
          assignmentId: current.id,
          plannerUpdateRequired: true,
          blocker: 'runtime_unavailable',
        };
      }
      throw err;
    }

    const { assignment, attempt, delivery } = dispatched;

    if (delivery.status === 'delivered') {
      return this.verifyPlanFirstUnit(run, unit, assignment, attempt, null);
    }

    if (delivery.status === 'ambiguous') {
      await this.blockPlanFirstUnit(run, unit, assignment, 'ambiguous_delivery', 'dispatch_ambiguous');
      return {
        transition: 'dispatch_ambiguous',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: assignment.id,
        attemptId: attempt.id,
        plannerUpdateRequired: true,
        blocker: 'ambiguous_delivery',
      };
    }

    // delivery.status === 'failed' — confirmed NOT delivered, so no physical execution
    // occurred and re-dispatch is safe. The assignment binding is RETAINED as the
    // historical record of the failed attempt.
    await repos.runInTransaction(async () => {
      const fresh = await repos.workUnits.findById(unit.id);
      if (fresh) {
        fresh.returnToPending();
        await repos.workUnits.save(fresh);
      }
    });
    return {
      transition: 'dispatch_not_delivered',
      runId: run.id,
      workUnitId: unit.id,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      plannerUpdateRequired: false,
      blocker: 'delivery_failed',
    };
  }

  /**
   * §G step 10 — the ONLY path to `WorkUnit.completed`.
   *
   * The idempotency guard is load-bearing: a crash between "VerificationResult written" and
   * "unit completed" leaves the attempt `completed_physical` with a result already present,
   * and §G step 6 routes back here on restart. Verification therefore RESUMES from the
   * persisted result; it never re-evaluates and never double-inserts.
   */
  private async verifyPlanFirstUnit(
    run: PlanFirstRun,
    unit: WorkUnit,
    assignment: Assignment,
    attempt: Attempt,
    units: WorkUnit[] | null,
  ): Promise<PlanFirstTickResult> {
    const repos = this.repos;
    const revision = await repos.contractRevisions.findById(run.contractRevisionId);
    if (!revision) {
      throw new RelayDomainError(`ContractRevision ${run.contractRevisionId} not found`, 'NOT_FOUND');
    }

    // §G step 6 makes `completed_physical` the gate for verification, and §H Boundary 1
    // requires a freshly delivered attempt to remain `running` on the dispatch tick. A
    // confirmed delivery only means the instruction ARRIVED; physical execution is still
    // in progress, so there is nothing to verify yet. This is the one path that observes
    // the attempt after dispatchAssignment, so the guard lives here.
    if (attempt.status !== 'completed_physical') {
      return {
        transition: 'dispatch_in_flight',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: assignment.id,
        attemptId: attempt.id,
        plannerUpdateRequired: false,
      };
    }

    const existing = await repos.verificationResults.findByAttemptId(attempt.id);
    let outcome: { outcome: 'passed' | 'failed' | 'blocked' | 'not_run'; checkId?: string; evidence?: Record<string, unknown> };
    let insertResult: boolean;
    if (existing) {
      // Resume, never re-run.
      outcome = {
        outcome: existing.result,
        checkId: existing.checkId,
        evidence: existing.evidence,
      };
      insertResult = false;
    } else {
      outcome = await this.planFirstVerification.evaluate({ attempt, revision, unit });
      insertResult = true;
    }

    const passed = outcome.outcome === 'passed';

    // Transaction 2: verification result + unit completion + assignment resolution are one
    // atomic unit. The run's terminal state is decided INSIDE the same transaction.
    const result = await repos.runInTransaction(async () => {
      if (insertResult) {
        const now = Date.now();
        await repos.verificationResults.save({
          id: createId('verif'),
          attemptId: attempt.id,
          checkId: outcome.checkId,
          result: outcome.outcome,
          evidence: outcome.evidence,
          createdAt: now,
          updatedAt: now,
        });
      }

      const fresh = await repos.workUnits.findById(unit.id);
      if (!fresh) {
        throw new RelayDomainError(`WorkUnit ${unit.id} not found`, 'NOT_FOUND');
      }

      if (passed) {
        // attempt stays `completed_physical`. Verification does NOT mutate physical state.
        fresh.accept();
        await repos.workUnits.save(fresh);

        assignment.complete();
        await repos.assignments.save(assignment);

        // Completion is decided from freshly persisted state, never from the stale list.
        const all = await repos.workUnits.findByContractRevisionId(run.contractRevisionId);
        const remaining = all.filter((u) => u.status === 'pending');
        if (remaining.length === 0) run.complete();
        await repos.planFirstRuns.save(run);
        return { remaining: remaining.length };
      }

      fresh.block();
      await repos.workUnits.save(fresh);
      run.block();
      await repos.planFirstRuns.save(run);
      return { remaining: -1 };
    });

    if (passed) {
      await this.emitEvent('assignment', assignment.id, 'plan_first.unit_completed', {
        actor: 'engine',
        previousState: 'in_progress',
        newState: 'completed',
        correlationId: run.id,
        details: {
          workUnitId: unit.id,
          attemptId: attempt.id,
          verificationResult: outcome.outcome,
          checkId: outcome.checkId ?? null,
          resumed: !insertResult,
        },
      });
      const runCompleted = result.remaining === 0;
      return {
        transition: runCompleted ? 'run_completed' : 'work_unit_completed',
        runId: run.id,
        workUnitId: unit.id,
        assignmentId: assignment.id,
        attemptId: attempt.id,
        plannerUpdateRequired: false,
      };
    }

    // The Assignment stays `unresolved`. The engine never auto-fails it.
    await this.raisePlanFirstAttention(
      run,
      unit,
      'warning',
      'plan_first_verification_blocked',
      'Plan-First verification did not pass',
      `WorkUnit ${unit.id} (ordinal ${unit.ordinal}) produced verification outcome ` +
        `'${outcome.outcome}' for attempt ${attempt.id}. The attempt remains ` +
        "`completed_physical` and the assignment remains unresolved. A planner or human " +
        'must resolve before further execution.',
      'plan_first_review',
      assignment.id,
    );
    return {
      transition: 'verification_failed',
      runId: run.id,
      workUnitId: unit.id,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      plannerUpdateRequired: true,
      blocker: 'verification_failed',
    };
  }

  /**
   * §G step 6, `interrupted` branch — the runtime was lost mid-work.
   *
   * Per §C.2 the unit status is deliberately UNCHANGED so the attempt is retained, and per
   * §C.1 there is no run-level `suspended` state: suspension lives at the Attempt plus an
   * AttentionItem. Repository mutations performed before the interruption are NOT rolled
   * back (ATTEMPT_LIFECYCLE.md Case 5).
   */
  private async reconcileInterruptedPlanFirstUnit(
    run: PlanFirstRun,
    unit: WorkUnit,
    assignment: Assignment,
    attempt: Attempt,
  ): Promise<PlanFirstTickResult> {
    const pair = await this.repos.pairs.findById(run.sessionPairId);
    let workerPresent = false;
    if (pair?.workerSessionId) {
      const worker = await this.repos.runtimes.findById(pair.workerSessionId);
      workerPresent = worker !== null && worker.status !== 'terminated';
    }
    if (!workerPresent) {
      await this.raisePlanFirstAttention(
        run,
        unit,
        'warning',
        'plan_first_attempt_interrupted',
        'Plan-First attempt interrupted',
        `Attempt ${attempt.id} for WorkUnit ${unit.id} was interrupted and the bound worker ` +
          'runtime is still unavailable. Repository mutations made before the interruption ' +
          'are retained. No work is re-dispatched automatically.',
        'recover_runtime',
        assignment.id,
      );
    }
    return {
      transition: 'attempt_interrupted',
      runId: run.id,
      workUnitId: unit.id,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      plannerUpdateRequired: true,
      blocker: 'attempt_interrupted',
    };
  }

  /**
   * §G step 6, `prepared | running` branch — dispatch in flight or executing.
   *
   * Re-inspect the worker and record the observation. Crucially this NEVER advances the
   * unit: completion may only come from a `VerificationResult` with `result === 'passed'`,
   * and provider UI is explicitly not admissible evidence of correctness (§D.3).
   */
  private async reconcileInFlightPlanFirstUnit(
    run: PlanFirstRun,
    unit: WorkUnit,
    assignment: Assignment,
    attempt: Attempt,
  ): Promise<PlanFirstTickResult> {
    const pair = await this.repos.pairs.findById(run.sessionPairId);
    // I-2 GATE — ARMED (S6). `provider.detectWorkingState(...)` below is a real
    // external contact, so §11.5 gates it. The observation it produces is recorded
    // on the runtime and never promotes a WorkUnit, so skipping it for an IDLE Pair
    // loses no derived state — the only thing lost is a contact I-2 forbids.
    if (pair?.workerSessionId && pair.isAutomatedContactPermitted()) {
      const worker = await this.repos.runtimes.findById(pair.workerSessionId);
      if (worker) {
        try {
          const working = await this.getProvider(worker.providerType).detectWorkingState(worker.id);
          // Observation only. It is recorded on the runtime and never promotes a WorkUnit.
          worker.recordObservationSuccess(working.isWorking ? 'working' : 'available', working.evidence);
          await this.repos.runtimes.save(worker);
          await this.emitEvent('attempt', attempt.id, 'plan_first.dispatch_in_flight', {
            actor: 'reconciler',
            newState: attempt.status,
            correlationId: run.id,
            details: { workUnitId: unit.id, isWorking: working.isWorking },
          });
        } catch {
          // Inspection is best-effort; an unavailable provider must not advance state.
        }
      }
    }
    return {
      transition: 'dispatch_in_flight',
      runId: run.id,
      workUnitId: unit.id,
      assignmentId: assignment.id,
      attemptId: attempt.id,
      plannerUpdateRequired: false,
    };
  }

  /**
   * Transaction 3: unit `blocked` + run `blocked` + AttentionItem, atomically.
   */
  private async blockPlanFirstUnit(
    run: PlanFirstRun,
    unit: WorkUnit,
    assignment: Assignment,
    attentionType: string,
    blocker: string,
  ): Promise<void> {
    const repos = this.repos;
    await repos.runInTransaction(async () => {
      const fresh = await repos.workUnits.findById(unit.id);
      if (fresh && fresh.status === 'in_progress') {
        fresh.block();
        await repos.workUnits.save(fresh);
      }
      const freshRun = await repos.planFirstRuns.findById(run.id);
      if (freshRun && freshRun.status === 'running') {
        freshRun.block();
        await repos.planFirstRuns.save(freshRun);
        run.status = freshRun.status;
        run.updatedAt = freshRun.updatedAt;
      }
      const item = AttentionItem.create(
        'critical',
        attentionType,
        'Plan-First delivery requires reconciliation',
        `WorkUnit ${unit.id} (ordinal ${unit.ordinal}) cannot be dispatched automatically: ` +
          `${blocker}. RelayX never resends an ambiguous delivery automatically.`,
        { pairId: run.sessionPairId, assignmentId: assignment.id, suggestedAction: 'reconcile_delivery' },
      );
      await repos.attention.save(item);
    });
  }

  private async raisePlanFirstAttention(
    run: PlanFirstRun,
    unit: WorkUnit,
    severity: 'info' | 'warning' | 'critical',
    type: string,
    title: string,
    message: string,
    suggestedAction: string,
    assignmentId?: AssignmentId,
  ): Promise<void> {
    await this.repos.attention.save(
      AttentionItem.create(severity, type, title, message, {
        pairId: run.sessionPairId,
        assignmentId: assignmentId ?? unit.assignmentId ?? undefined,
        suggestedAction,
      }),
    );
  }
}

export type PlanFirstTickTransition =
  | 'run_terminal'
  | 'run_completed'
  | 'work_unit_completed'
  | 'verification_failed'
  | 'blocked_awaiting_planner'
  | 'dispatch_in_flight'
  | 'dispatch_suspended'
  | 'dispatch_not_delivered'
  | 'dispatch_ambiguous'
  | 'attempt_interrupted'
  | 'selection_raced';

export interface PlanFirstTickResult {
  transition: PlanFirstTickTransition;
  runId: string;
  workUnitId?: string;
  assignmentId?: string;
  attemptId?: string;
  plannerUpdateRequired: boolean;
  blocker?: string;
}
