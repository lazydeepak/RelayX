/**
 * Post-transport exact-session reconciliation — PURE DOMAIN LOGIC.
 *
 * ## Why this exists
 *
 * `Delivery` in the frozen model (entities.ts `Delivery`, `PROVIDER_DISPATCH_GROUND_TRUTH.md`
 * Part 5/6) is a claim about exactly ONE external fact: **was this instruction durably
 * inserted into the exact target provider session?**
 *
 * It is NOT a claim about whether the worker then did the work, and it is NOT a claim about
 * whether the CLI process happened to exit 0. A provider process can accept an instruction,
 * persist it as a user turn, and *then* fail — and that is a **delivered** delivery whose
 * **execution** separately failed. Treating a non-zero exit as "nothing was delivered" is a
 * false negative about the external world, and it is the specific defect this module exists
 * to make impossible.
 *
 * The two claims are kept in two separate types and are never collapsed:
 *
 * | Claim | Type | Question it answers |
 * |---|---|---|
 * | transport / delivery outcome | `TransportReconciliation.classification` | Did the instruction reach the exact session? |
 * | worker execution outcome | `TransportReconciliation.workerExecution` | Did the worker then actually do it? |
 *
 * ## Frozen authority
 *
 * - `PROVIDER_DISPATCH_GROUND_TRUTH.md` Part 6 step 4-5: "observe / record outcome — provider
 *   observation / transcript read", then "confirmDispatch() / markDispatchUncertain() — persist
 *   observed outcome". Outcome is an OBSERVATION, never a process exit code.
 * - `PROVIDER_DISPATCH_GROUND_TRUTH.md` Part 3 Case 3: "Submit succeeds, crash immediately
 *   afterward ... reconcile via external observation; confirm delivered if message identity
 *   matches; do NOT blindly resend."
 * - `PROVIDER_DISPATCH_GROUND_TRUTH.md` Part 5: Core must represent `confirmed_delivered` /
 *   `confirmed_not_delivered` / `uncertain` for ALL providers without assuming capability.
 * - `ATTEMPT_LIFECYCLE.md` Dimension A vs Dimension C: delivery confirmation and worker
 *   execution are orthogonal; a failed worker run is `interrupted` on the ATTEMPT, never a
 *   failed DELIVERY.
 *
 * ## The three-way classification the frozen model requires
 *
 * ```
 * no matching user turn  ->  transport failed            -> Delivery.failed
 * matching user turn     ->  instruction delivered       -> Delivery.delivered
 * neither establishable  ->  uncertain / ambiguous       -> Delivery.ambiguous (NO blind resend)
 * ```
 *
 * "Neither establishable" is a first-class outcome, NOT a silent `failed`. §9.1's constraint
 * ("RelayX can activate a window, RelayX cannot address a conversation") means an unreadable
 * exact session is a normal, expected condition — and reporting it as `failed` would authorise
 * a blind resend into a session we could not read, which is exactly the harm Part 3 Case 3 and
 * §9 forbid.
 *
 * ## I-6 / C-8 — honesty about absence
 *
 * A transcript that could not be read yields `ambiguous` with a reason, never `not_delivered`.
 * A transcript that WAS read and contains no matching post-watermark user turn yields
 * `not_delivered` — that is a real, evidence-backed negative (Part 3 Case 1 explicitly permits
 * concluding "not delivered" in exactly this situation).
 *
 * ## The boundary is a MESSAGE-ID SET DIFFERENCE, never a timestamp guess
 *
 * The reconciliation asks "was the expected user turn created AFTER the pre-dispatch
 * watermark?". `PairSideIdentity`/S3 continuity rules (continuity.ts header, Correction 1)
 * already established that *stable identity is not ordering*: differing references without
 * trustworthy ordinals may not be turned into an ordering. So the boundary here is built the
 * same way — the set of message ids that existed at watermark time. A candidate turn is
 * post-boundary iff its id is absent from that set. This needs no timestamp comparison at all,
 * which is precisely why it is trustworthy for a provider whose timestamps RelayX cannot order.
 * Timestamps are still recorded as evidence, never as the deciding comparison.
 */

import { sha256 } from 'js-sha256';

/* -------------------------------------------------------------------------- */
/* Frozen vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Transport / delivery outcome — the claim about EXTERNAL INSERTION only.
 *
 * `delivered`      the exact session durably holds this instruction as a post-boundary user turn
 * `not_delivered`  the exact session was readable and holds NO such turn (evidence-backed negative)
 * `ambiguous`      neither could be established from authoritative evidence
 */
export type TransportReconciliationClassification =
  | 'delivered'
  | 'not_delivered'
  | 'ambiguous';

/**
 * Worker execution outcome — the claim about what the worker THEN did.
 *
 * `completed`       an assistant turn caused by the instruction finished without a provider error
 * `terminal_error`  the assistant turn terminated with a provider error (quota, auth, crash)
 * `in_progress`     an assistant turn exists but has not finished
 * `not_started`     no assistant turn was observed after the instruction
 *
 * This NEVER changes `TransportReconciliationClassification`. Transport and execution are
 * separate facts with separate owners (Delivery vs Attempt).
 */
export type WorkerExecutionClassification =
  | 'completed'
  | 'terminal_error'
  | 'in_progress'
  | 'not_started';

/** How a candidate turn was proven to be this Attempt's instruction. */
export type InstructionMatchKind =
  /** Normalised text is byte-identical to the Attempt payload. */
  | 'exact'
  /**
   * The provider truncated the stored text but it is a strict prefix of the payload.
   * Recorded as a WEAKER match and surfaced in evidence; never silently upgraded to `exact`.
   * (PROVIDER_DISPATCH_GROUND_TRUTH.md "Remaining Unknowns" #2: transcripts are bounded.)
   */
  | 'truncated_prefix'
  /** No candidate matched. */
  | 'none';

/* -------------------------------------------------------------------------- */
/* Input vocabulary                                                           */
/* -------------------------------------------------------------------------- */

/** One provider message, reduced to only the fields reconciliation is allowed to use. */
export interface ReconciliationMessage {
  messageId: string;
  role: 'user' | 'assistant' | 'system' | 'other';
  createdAt?: number;
  text?: string;
  /** Provider-reported assistant turn terminator (`stop`, `error`, `length`, ...). */
  finish?: string | null;
  /** Provider-reported terminal error on the assistant turn. */
  error?: { type?: string | null; message?: string | null; status?: number | null } | null;
  /** Provider-reported model actually used for the turn. */
  model?: { providerID?: string | null; modelId?: string | null; variant?: string | null } | null;
  /** Provider-reported run outcome marker (e.g. `idle` rows carry `failed`/`success`). */
  outcome?: string | null;
}

/**
 * The pre-dispatch boundary, captured from the SAME exact session immediately before
 * the external send and persisted as part of the durable dispatch intent.
 */
export interface ExactSessionWatermark {
  sessionId: string;
  /**
   * Every provider message id that existed at capture time, newest last.
   * This set — not a timestamp — is the boundary used for post-boundary detection.
   */
  messageIds: string[];
  /** Newest `time.created` seen at capture time. Evidence only; never the deciding comparison. */
  latestCreatedAt: number | null;
  messageCount: number;
  capturedAt: number;
  /**
   * How this boundary was obtained. Never omitted, because the two kinds are not equally
   * strong and a reader must be able to tell them apart.
   *
   * `captured_pre_dispatch` — the id set was read from the exact session immediately before
   *   the send. Authoritative, and the only kind a live dispatch produces.
   *
   * `reconstructed_from_intent_time` — the id set was DERIVED, after the fact, by discarding
   *   every turn the provider recorded as created before the Delivery's own durable
   *   `created_at`. Sound in ONE direction only: a turn cannot be created before the intent
   *   to create it was committed, so this can wrongly EXCLUDE a turn (if the clocks disagree)
   *   but can never wrongly INCLUDE an earlier attempt's turn. It exists for deliveries
   *   dispatched before id-set boundaries were recorded, and it is reported as weaker
   *   everywhere it is used. It must never be used to authorise a resend on its own.
   */
  provenance: 'captured_pre_dispatch' | 'reconstructed_from_intent_time';
}

export interface TransportReconciliationInput {
  /** The Attempt/Assignment payload that was supposed to reach the session. */
  expectedText: string;
  /**
   * The pre-dispatch boundary. `null` means no boundary was captured, which makes a
   * post-boundary claim impossible and therefore forces `ambiguous`.
   */
  watermark: ExactSessionWatermark | null;
  /** Messages of the EXACT target session, provider order preserved. */
  messages: ReconciliationMessage[];
  /**
   * False when the authoritative transcript could not be read at all.
   * False forces `ambiguous` regardless of the message array's contents.
   */
  transcriptReadable: boolean;
  /** Why the transcript could not be read, when it could not. */
  transcriptReadFailure?: string | null;
  /** Recorded for evidence only. NEVER consulted to classify. */
  transportExitCode?: number | null;
  transportError?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Output vocabulary                                                          */
/* -------------------------------------------------------------------------- */

export interface MatchedUserTurn {
  messageId: string;
  createdAt: number | null;
  /** 0-based index within the reconciled message list. */
  ordinal: number;
  matchKind: InstructionMatchKind;
  fingerprint: string;
  /** The text as the provider stored it (after unquoting), for human audit. */
  observedText: string;
}

export interface WorkerExecutionEvidence {
  /**
   * The turn that TERMINATED the run — the last assistant turn caused by the instruction.
   * This is the turn the execution verdict is read from, because an earlier turn in a
   * tool-using run says nothing about how the run ended.
   */
  assistantMessageId: string | null;
  createdAt: number | null;
  finish: string | null;
  errorType: string | null;
  errorMessage: string | null;
  errorStatus: number | null;
  providerId: string | null;
  modelId: string | null;
  /**
   * The final non-empty assistant TEXT the run produced, when there is one.
   *
   * Kept separate from `assistantMessageId` on purpose. A run that uses tools ends in an
   * assistant turn that carries text, but the turn that TERMINATED it may be a later
   * tool-calls turn, and the reverse also happens. Conflating them would either lose the
   * answer or misreport which turn ended the run.
   */
  text: string | null;
  /** Which assistant turn `text` came from. `null` when no turn produced text. */
  responseMessageId: string | null;
  /**
   * How many assistant turns the instruction caused. `1` is the simple case; more means the
   * worker used tools, so the run is a CHAIN and the verdict must come from its last turn.
   */
  assistantTurnCount: number;
  /** Provider run-outcome markers observed after the matching turn, e.g. `idle:failed`. */
  runOutcomeMarkers: string[];
}

export interface TransportReconciliation {
  classification: TransportReconciliationClassification;
  reason: string;
  /** sha256 of the normalised expected payload. */
  expectedFingerprint: string;
  /** sha256 of the normalised matched text. `null` when nothing matched. */
  matchedFingerprint: string | null;
  matchKind: InstructionMatchKind;
  matchingUserTurn: MatchedUserTurn | null;
  /** Number of post-boundary user turns seen, matched or not. Diagnostic for Case 6. */
  postBoundaryUserTurns: number;
  boundaryEstablished: boolean;
  /**
   * Which kind of boundary the verdict rests on. `null` when none was established. Recorded
   * so a reader can see whether a classification came from a captured pre-dispatch read or
   * from a weaker post-hoc reconstruction, and weight it accordingly.
   */
  boundaryProvenance: ExactSessionWatermark['provenance'] | null;
  watermark: ExactSessionWatermark | null;
  workerExecution: WorkerExecutionClassification;
  workerExecutionEvidence: WorkerExecutionEvidence;
  transportExitCode: number | null;
  transportError: string | null;
  transcriptReadable: boolean;
  /**
   * Whether a total order could be derived from provider timestamps. `false` means the
   * provider supplied no usable `time.created` for every message, so message sequence came
   * from the provider's own response order instead. Recorded so a reader can tell an
   * ordering claim from a sequence claim.
   */
  chronologicalOrder: boolean;
}

/* -------------------------------------------------------------------------- */
/* Normalisation and fingerprinting                                           */
/* -------------------------------------------------------------------------- */

/**
 * Normalise instruction text for comparison.
 *
 * The OpenCode service stores a user turn's instruction as a JSON-ENCODED STRING
 * (`"text": "\"Inspect RelayX ...\""` — a quoted, escaped JSON string of the real text).
 * Comparing raw strings would therefore never match the real instruction, which is why
 * exact-session fingerprint matching appeared to be structurally impossible.
 *
 * Rules, all conservative and order-independent:
 * 1. If the value parses as a JSON string, use the decoded string (unwraps the provider's
 *    JSON encoding exactly once, so a literal `"foo"` in an instruction still round-trips
 *    to `foo` rather than to `foo"`).
 * 2. Unify CRLF/CR to LF.
 * 3. Collapse runs of whitespace to a single space, and trim.
 *
 * No case folding and no punctuation stripping: those would let a DIFFERENT instruction
 * match, and Case 5 of the ground-truth document exists precisely because the same text can
 * legitimately appear more than once in a session.
 */
export function normalizeInstructionText(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  let value = raw;
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(trimmed);
      if (typeof decoded === 'string') value = decoded;
    } catch {
      // Not JSON. Keep the raw value rather than guessing at a partial decode.
    }
  }
  return value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

/** sha256 of the normalised text, hex. `sha256_<hex>` to match RelayX's evidence convention. */
export function instructionFingerprint(raw: string | null | undefined): string {
  return `sha256_${sha256(normalizeInstructionText(raw))}`;
}

/* -------------------------------------------------------------------------- */
/* The classifier                                                             */
/* -------------------------------------------------------------------------- */

function emptyExecutionEvidence(): WorkerExecutionEvidence {
  return {
    assistantMessageId: null,
    createdAt: null,
    finish: null,
    errorType: null,
    errorMessage: null,
    errorStatus: null,
    providerId: null,
    modelId: null,
    text: null,
    responseMessageId: null,
    assistantTurnCount: 0,
    runOutcomeMarkers: [],
  };
}

/**
 * Derive a total chronological order for one session's messages.
 *
 * The provider's `/message` response is newest-first, so the raw array order must never be
 * read as a sequence — doing so inverts every "what came after this turn" question. Whenever
 * EVERY message carries a numeric `time.created`, the order is re-derived ascending by
 * `(createdAt, rawIndex)`. The index tie-break makes the order total and deterministic, so
 * the same provider response always yields the same sequence — the same technique
 * `readLatestMeaningfulMessage` already uses for S2 ordinals.
 *
 * If any message lacks a timestamp, the provider's own order is kept and the caller is told
 * via `chronologicalOrder: false`. That is honest degradation, not a guess.
 */
function toChronological(messages: ReconciliationMessage[]): {
  ordered: ReconciliationMessage[];
  derived: boolean;
} {
  const allDated = messages.every((m) => typeof m.createdAt === 'number');
  if (!allDated) return { ordered: messages, derived: false };
  const ordered = messages
    .map((message, index) => ({ message, index }))
    .sort(
      (a, b) =>
        (a.message.createdAt as number) - (b.message.createdAt as number) || a.index - b.index,
    )
    .map((entry) => entry.message);
  return { ordered, derived: true };
}

/**
 * Classify a post-transport dispatch by reading the EXACT authoritative session.
 *
 * Pure: no provider, no I/O, no clock. The caller supplies the transcript it already read.
 */
export function reconcileTransportOutcome(
  input: TransportReconciliationInput,
): TransportReconciliation {
  const expectedFingerprint = instructionFingerprint(input.expectedText);
  const normalizedExpected = normalizeInstructionText(input.expectedText);
  const watermark = input.watermark;
  const priorIds = new Set(watermark?.messageIds ?? []);
  // A successful pre-dispatch read establishes a boundary even when the session is empty.
  // The empty set is still an exact set of every message id that existed before dispatch;
  // requiring at least one prior message made the first instruction in a fresh session
  // permanently ambiguous, even when its new user turn was plainly present afterward.
  const boundaryEstablished =
    input.transcriptReadable &&
    watermark !== null &&
    (watermark.provenance === 'captured_pre_dispatch' || watermark.messageIds.length > 0);

  // Everything downstream reasons about "what came after", so it MUST reason about a
  // chronological array, never about the provider's newest-first response order.
  const { ordered, derived: chronologicalOrder } = toChronological(input.messages);

  const postBoundaryUserTurns = ordered.filter(
    (m) => m.role === 'user' && (watermark === null || !priorIds.has(m.messageId)),
  );

  // ---- Find the post-boundary user turn that IS this Attempt's payload.
  // Scanned newest-first so that, when an identical instruction legitimately appears more
  // than once, the most recent post-boundary occurrence is the one the transport produced
  // (ground-truth Case 5). The boundary already excludes every pre-existing occurrence.
  let matched: { message: ReconciliationMessage; ordinal: number; kind: InstructionMatchKind } | null =
    null;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const message = ordered[i];
    if (message.role !== 'user') continue;
    if (watermark !== null && priorIds.has(message.messageId)) continue;
    const observed = normalizeInstructionText(message.text);
    if (observed.length === 0) continue;
    if (observed === normalizedExpected) {
      matched = { message, ordinal: i, kind: 'exact' };
      break;
    }
    // Truncation-only fallback: the provider cut the stored text, so what survived is a
    // strict prefix of the payload. A turn whose text merely happens to start with part of
    // the instruction is NOT accepted — that would let a different message match.
    if (
      message.text !== undefined &&
      observed.length > 0 &&
      normalizedExpected.length > observed.length &&
      normalizedExpected.startsWith(observed)
    ) {
      matched = { message, ordinal: i, kind: 'truncated_prefix' };
      break;
    }
  }

  const matchingUserTurn: MatchedUserTurn | null = matched
    ? {
        messageId: matched.message.messageId,
        createdAt: matched.message.createdAt ?? null,
        ordinal: matched.ordinal,
        matchKind: matched.kind,
        fingerprint: instructionFingerprint(matched.message.text),
        observedText: normalizeInstructionText(matched.message.text),
      }
    : null;

  // ---- Worker execution, attributed to the assistant turn caused by the matched turn only.
  const execution = classifyWorkerExecution(ordered, matchingUserTurn);

  // ---- The three-way transport classification.
  let classification: TransportReconciliationClassification;
  let reason: string;

  if (!input.transcriptReadable) {
    classification = 'ambiguous';
    reason =
      `The exact session transcript could not be read, so neither delivery nor non-delivery ` +
      `is establishable: ${input.transcriptReadFailure ?? 'no failure reason reported'}. ` +
      `Classifying this as a transport failure would authorise a blind resend into a session ` +
      `whose current contents RelayX cannot see.`;
  } else if (!boundaryEstablished) {
    classification = 'ambiguous';
    reason = watermark === null
      ? 'No pre-dispatch watermark was captured for the exact session, so no user turn can ' +
        'be shown to be post-boundary. Delivery is neither confirmed nor refuted.'
      : 'The reconstructed boundary contains no provider message ids, so it cannot establish ' +
        'a post-boundary turn or authorize a resend. Delivery is neither confirmed nor refuted.';
  } else if (matchingUserTurn) {
    classification = 'delivered';
    const how =
      matchingUserTurn.matchKind === 'exact'
        ? 'normalised text is byte-identical to the Attempt payload'
        : 'the provider-truncated text is a strict prefix of the Attempt payload';
    reason =
      `The exact session durably holds the instruction as a post-boundary user turn ` +
      `(message ${matchingUserTurn.messageId}): ${how}. ` +
      (input.transportExitCode !== null && input.transportExitCode !== 0
        ? `The transport process exited ${input.transportExitCode}, which is an EXECUTION ` +
          `outcome and is not evidence about insertion. Transport and worker execution are ` +
          `recorded separately and neither overwrites the other. `
        : '');
  } else {
    classification = 'not_delivered';
    reason =
      `The exact session was read successfully and contains no post-boundary user turn whose ` +
      `text matches this Attempt's payload (${postBoundaryUserTurns} post-boundary user turn(s) ` +
      `seen, 0 matching). The instruction was not inserted.`;
  }

  return {
    classification,
    reason,
    expectedFingerprint,
    matchedFingerprint: matchingUserTurn?.fingerprint ?? null,
    matchKind: matchingUserTurn?.matchKind ?? 'none',
    matchingUserTurn,
    postBoundaryUserTurns: postBoundaryUserTurns.length,
    boundaryEstablished,
    boundaryProvenance: boundaryEstablished ? (watermark?.provenance ?? null) : null,
    watermark,
    workerExecution: execution.classification,
    workerExecutionEvidence: execution.evidence,
    transportExitCode: input.transportExitCode ?? null,
    transportError: input.transportError ?? null,
    transcriptReadable: input.transcriptReadable,
    chronologicalOrder,
  };
}

/**
 * Attribute the worker-execution outcome to the assistant turn caused by the matched
 * instruction turn.
 *
 * `ordered` MUST already be chronological. The first assistant turn strictly after the
 * matched user turn is the turn the provider created in response to it; everything after
 * that is downstream of it. `idle` rows in between carry the provider's own run outcome and
 * are recorded as corroboration, because OpenCode emits `idle { outcome: 'failed' }`
 * immediately after a terminal provider error.
 */
function classifyWorkerExecution(
  ordered: ReconciliationMessage[],
  matchingUserTurn: MatchedUserTurn | null,
): { classification: WorkerExecutionClassification; evidence: WorkerExecutionEvidence } {
  const evidence = emptyExecutionEvidence();

  if (!matchingUserTurn) {
    return { classification: 'not_started', evidence };
  }

  const startIndex = ordered.findIndex((m) => m.messageId === matchingUserTurn.messageId);
  if (startIndex < 0) {
    // Unreachable via reconcileTransportOutcome (the match came from this very array), but
    // reported rather than guessed at if this function is ever called directly.
    return { classification: 'in_progress', evidence };
  }

  const after = ordered.slice(startIndex + 1);

  evidence.runOutcomeMarkers = after
    .filter((m) => m.role === 'other' && typeof m.outcome === 'string' && m.outcome.length > 0)
    .map((m) => `${m.messageId}:${m.outcome}`);

  // A single instruction can cause a CHAIN of assistant turns when the worker uses tools:
  // a tool-calls turn, a tool result, more tool calls, and finally a text answer. The run's
  // OUTCOME is read from the LAST such turn, never the first. Reading the first is wrong in
  // the direction that matters — a chain that starts with a clean tool call and then fails
  // on the last turn would be reported `completed`, and the recorded response would be the
  // tool invocation rather than the answer.
  const assistantTurns = after.filter((message) => message.role === 'assistant');
  const assistant = assistantTurns[assistantTurns.length - 1];
  if (!assistant) {
    // A delivered user turn is transport evidence only. Until the provider creates an
    // assistant turn, RelayX has no independent evidence that execution began.
    return { classification: 'not_started', evidence };
  }
  evidence.assistantTurnCount = assistantTurns.length;

  // The response text comes from the LAST turn that actually produced text, which for a
  // tool-using run is the answer rather than the terminating tool-call turn.
  for (let i = assistantTurns.length - 1; i >= 0; i--) {
    const candidate = normalizeInstructionText(assistantTurns[i].text);
    if (candidate.length > 0) {
      evidence.text = candidate;
      evidence.responseMessageId = assistantTurns[i].messageId;
      break;
    }
  }

  evidence.assistantMessageId = assistant.messageId;
  evidence.createdAt = assistant.createdAt ?? null;
  evidence.finish = assistant.finish ?? null;
  evidence.errorType = assistant.error?.type ?? null;
  evidence.errorMessage = assistant.error?.message ?? null;
  evidence.errorStatus = typeof assistant.error?.status === 'number' ? assistant.error.status : null;
  evidence.providerId = assistant.model?.providerID ?? null;
  evidence.modelId = assistant.model?.modelId ?? null;

  // A provider error on the turn is the definitive terminal signal, regardless of finish.
  if (assistant.error || assistant.finish === 'error') {
    return { classification: 'terminal_error', evidence };
  }
  // A provider-reported terminator with no error means the run ended. Text presence is
  // recorded in the evidence but does NOT decide execution state: a legitimately empty
  // reply is still a completed run, and a missing terminator means the run has not ended
  // yet even if partial text is present. Deciding on text alone would report `in_progress`
  // for a finished-but-terse answer, which is the mirror image of the exit-code defect.
  const finish = assistant.finish ?? null;
  if (finish !== null && finish.length > 0) {
    return { classification: 'completed', evidence };
  }
  return { classification: 'in_progress', evidence };
}

/* -------------------------------------------------------------------------- */
/* Watermark construction                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build a watermark from the messages of the exact session as they stood BEFORE the send.
 *
 * Ids are stored newest-last and de-duplicated. The set is the boundary; the timestamp is
 * carried only so that a human reading the evidence can see the temporal context.
 */
export function buildWatermark(
  sessionId: string,
  messages: ReconciliationMessage[],
  capturedAt: number,
): ExactSessionWatermark {
  const ids: string[] = [];
  for (const message of messages) {
    if (!ids.includes(message.messageId)) ids.push(message.messageId);
  }
  let latestCreatedAt: number | null = null;
  for (const message of messages) {
    if (typeof message.createdAt === 'number' && (latestCreatedAt === null || message.createdAt > latestCreatedAt)) {
      latestCreatedAt = message.createdAt;
    }
  }
  return {
    sessionId,
    messageIds: ids,
    latestCreatedAt,
    messageCount: messages.length,
    capturedAt,
    provenance: 'captured_pre_dispatch',
  };
}

/**
 * Reconstruct a boundary for a delivery dispatched BEFORE id-set boundaries were recorded.
 *
 * ## What it does
 *
 * Takes the session's current turns and discards every one the provider recorded as created
 * before `intentCommittedAt` (the Delivery's durable `created_at`). The survivors-by-time are
 * then the post-boundary set, and the discarded ids form the boundary.
 *
 * ## Why it is sound, and in which direction only
 *
 * A provider turn cannot exist before the intent to create it was committed — the intent is
 * what causes the write. So "created before the intent" implies "not this attempt's turn",
 * and the reconstruction can only ever EXCLUDE wrongly (if the two clocks disagree). It can
 * never wrongly INCLUDE an earlier attempt's turn, which is the error that would authorise a
 * resend into a session that already holds the instruction.
 *
 * ## Why it is marked, everywhere
 *
 * This is weaker than a captured id set: it depends on cross-system clock agreement, which a
 * captured set does not. It is therefore reported with
 * `provenance: 'reconstructed_from_intent_time'` in the boundary and in the evidence, and
 * `resendPermitted` stays `false` on the strength of it alone.
 */
export function reconstructWatermarkFromIntentTime(
  sessionId: string,
  messages: ReconciliationMessage[],
  intentCommittedAt: number,
): ExactSessionWatermark {
  const before: string[] = [];
  const after: string[] = [];
  for (const message of messages) {
    const target = typeof message.createdAt === 'number' && message.createdAt < intentCommittedAt
      ? before
      : after;
    if (!target.includes(message.messageId)) target.push(message.messageId);
  }
  return {
    sessionId,
    messageIds: before,
    latestCreatedAt: before.length === 0 ? null : intentCommittedAt - 1,
    messageCount: before.length,
    capturedAt: intentCommittedAt,
    provenance: 'reconstructed_from_intent_time',
  };
}
