/**
 * Exact-session reconciliation — Delivery truth comes from the transcript, not the exit code.
 *
 * ## The defect this exists to prevent
 *
 * `deliverInstruction()` used to derive Delivery truth from the transport process's exit
 * code. That is unsound, and the failure is silent: `opencode run` exits non-zero whenever the
 * run does not end cleanly, INCLUDING when the instruction was delivered perfectly and the
 * model then hit a quota wall. Reading exit ≠ 0 as "nothing was sent" produced a `failed`
 * Delivery for work that was genuinely done, and the obvious recovery — resend — would have
 * duplicated real work inside a live conversation.
 *
 * The rule these tests pin down:
 *
 *   Exit code is EVIDENCE, never a verdict. The verdict comes from the exact session.
 *
 * The classifier is a pure function over (boundary, transcript), so it can be tested against
 * transcripts that would be impractical to produce for real, including the exact shape of the
 * failure that occurred in production.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  reconcileTransportOutcome,
  buildWatermark,
  instructionFingerprint,
  observeWorkerCompletion,
  reconstructWatermarkFromIntentTime,
  normalizeInstructionText,
  recoverBoundaryFromExactSession,
  type ExactSessionWatermark,
  type ReconciliationMessage,
} from '../src/relay/providers/exactSessionReconciliation.ts';

describe('legacy boundary recovery', () => {
  it('derives the exact pre-instruction id set from one unique worker user turn', () => {
    const boundary = recoverBoundaryFromExactSession({
      sessionId: 'ses_worker',
      expectedText: 'Fix the relay boundary and verify tests',
      messages: [
        { messageId: 'u0', role: 'user', createdAt: 1, text: 'Earlier task' },
        { messageId: 'a0', role: 'assistant', createdAt: 2, text: 'Earlier answer', finish: 'stop' },
        { messageId: 'u1', role: 'user', createdAt: 3, text: 'Fix the relay boundary and verify tests' },
        { messageId: 'a1', role: 'assistant', createdAt: 4, text: 'Working', finish: null },
      ],
    });
    assert.deepStrictEqual(boundary?.messageIds, ['u0', 'a0']);
    assert.equal(boundary?.provenance, 'recovered_from_exact_session');
    assert.equal(boundary?.latestUserTurnId, 'u0');
  });

  it('fails closed when the instruction is absent or duplicated', () => {
    const base = [{ messageId: 'u1', role: 'user' as const, text: 'same' }];
    assert.equal(recoverBoundaryFromExactSession({ sessionId: 'ses_worker', expectedText: 'missing', messages: base }), null);
    assert.equal(
      recoverBoundaryFromExactSession({
        sessionId: 'ses_worker',
        expectedText: 'same',
        messages: [...base, { messageId: 'u2', role: 'user' as const, text: 'same' }],
      }),
      null,
    );
  });
});

const SESSION = 'ses_f182a4ebeffeY5UgDTsU8XzoJG';

/** The instruction from the production Attempt that regressed. */
const INSTRUCTION =
  'Inspect RelayX provider architecture briefly and return a short deterministic summary ' +
  'confirming session identity and architecture state.';

/** A boundary of `pre` existing turns, so anything named after it is post-boundary. */
function boundaryOf(...messageIds: string[]): ExactSessionWatermark {
  return {
    sessionId: SESSION,
    messageIds,
    latestCreatedAt: 1_790_598_889_871,
    messageCount: messageIds.length,
    capturedAt: 1_790_598_939_012,
    provenance: 'captured_pre_dispatch',
  };
}

/** The exact message shapes the OpenCode service returns, as the adapter maps them. */
function userTurn(id: string, text: string, createdAt: number): ReconciliationMessage {
  return { messageId: id, role: 'user', createdAt, text };
}

function assistantOk(id: string, text: string, createdAt: number): ReconciliationMessage {
  return {
    messageId: id,
    role: 'assistant',
    createdAt,
    text,
    finish: 'stop',
    error: null,
    model: { providerID: 'opencode', modelId: 'space-bunny-free', variant: null },
  };
}

function assistantError(
  id: string,
  createdAt: number,
  err: { type: string; status: number; message: string },
): ReconciliationMessage {
  return {
    messageId: id,
    role: 'assistant',
    createdAt,
    content: undefined,
    finish: 'error',
    error: { type: err.type, message: err.message, status: err.status },
    model: { providerID: 'haimaker', modelId: 'auto', variant: null },
  } as ReconciliationMessage;
}

describe('Exact-session reconciliation — the exit code is not the verdict', () => {
  /* ---------------------------------------------------------------------- */
  /* THE REQUIRED CASE                                                      */
  /* ---------------------------------------------------------------------- */

  it('REQUIRED: exit != 0 + matching post-boundary user turn + terminal assistant error is DELIVERED', () => {
    // This is the production transcript, verbatim in shape:
    //   msg_...W8L7  user      the RelayX instruction        (post-boundary)
    //   msg_...L5rWZ3 assistant finish:error provider.quota 402
    //   msg_...5u33u idle      outcome: failed
    // and `opencode run` exited non-zero.
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_0e803892b001eqeUTh3HS5u33u'.slice(0, 0) + 'msg_pre_1', 'msg_pre_2'),
      messages: [
        userTurn('msg_0e803834a001IXzXg9c7L5K8L7', INSTRUCTION, 1_790_598_939_476),
        assistantError('msg_0e8038357001Xigho84gL5rWZ3', 1_790_598_939_873, {
          type: 'provider.quota',
          status: 402,
          message: 'quota exceeded',
        }),
        { messageId: 'msg_0e803892b001eqeUTh3HS5u33u', role: 'other', createdAt: 1_790_598_940_971, outcome: 'failed' },
      ],
      transcriptReadable: true,
      transportExitCode: 1,          // <-- the number the old code treated as the verdict
      transportError: 'provider.quota: 402',
    });

    // THE ASSERTION THAT MATTERS: the instruction reached the session.
    assert.strictEqual(
      result.classification,
      'delivered',
      'a matching post-boundary user turn proves delivery, whatever the exit code was',
    );
    assert.strictEqual(result.matchingUserTurn?.messageId, 'msg_0e803834a001IXzXg9c7L5K8L7');
    assert.strictEqual(result.matchKind, 'exact');
    assert.strictEqual(result.boundaryEstablished, true);

    // And the exit code is still RECORDED, so a reader can see the disagreement rather than
    // having it silently normalised away.
    assert.strictEqual(result.transportExitCode, 1);
    assert.ok(result.transportError && result.transportError.includes('402'));

    // Execution is a SEPARATE claim and it did not succeed. Collapsing these two would be
    // the mirror-image error: reporting a failed delivery for a delivered instruction.
    assert.strictEqual(result.workerExecution, 'terminal_error');
    assert.strictEqual(result.workerExecutionEvidence.errorType, 'provider.quota');
    assert.strictEqual(result.workerExecutionEvidence.errorStatus, 402);
    assert.strictEqual(result.workerExecutionEvidence.providerId, 'haimaker');

    // Therefore resending is forbidden. A retry here would duplicate the instruction in a
    // session that already contains it.
    assert.notStrictEqual(result.classification, 'not_delivered');
  });

  it('the SAME transcript with exit 0 classifies identically — the exit code changes nothing', () => {
    const messages = [
      userTurn('msg_u1', INSTRUCTION, 2),
      assistantOk('msg_a1', 'Session confirmed.', 3),
    ];
    const base = {
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_pre'),
      messages,
      transcriptReadable: true,
    };
    const failed = reconcileTransportOutcome({ ...base, transportExitCode: 1, transportError: 'boom' });
    const clean = reconcileTransportOutcome({ ...base, transportExitCode: 0, transportError: null });

    assert.strictEqual(failed.classification, clean.classification);
    assert.strictEqual(failed.workerExecution, clean.workerExecution);
    assert.strictEqual(failed.classification, 'delivered');
  });

  /* ---------------------------------------------------------------------- */
  /* The three verdicts                                                      */
  /* ---------------------------------------------------------------------- */

  it('a readable session with no matching post-boundary turn is not_delivered', () => {
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_pre_1', 'msg_pre_2'),
      messages: [
        userTurn('msg_pre_1', 'something else entirely', 1),
        assistantOk('msg_pre_2', 'unrelated answer', 2),
      ],
      transcriptReadable: true,
      transportExitCode: 0,
    });

    assert.strictEqual(result.classification, 'not_delivered');
    assert.strictEqual(result.matchingUserTurn, null);
    assert.strictEqual(result.matchKind, 'none');
  });

  it('an UNREADABLE session is ambiguous even when the message list is empty', () => {
    // The single most dangerous case: a read that failed looks exactly like an empty
    // session. Reporting `not_delivered` here would authorise a blind resend on the strength
    // of a connection error. "Could not check" is never "checked, absent" (I-6, C-8).
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_pre'),
      messages: [],
      transcriptReadable: false,
      transcriptReadFailure: 'HTTP 503 from the session service',
      transportExitCode: 1,
    });

    assert.strictEqual(result.classification, 'ambiguous');
    assert.ok(result.reason.includes('503'));
  });

  it('a MISSING boundary is ambiguous, because no turn can be shown to belong to this Attempt', () => {
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: null,
      messages: [userTurn('msg_u1', INSTRUCTION, 2)],
      transcriptReadable: true,
      transportExitCode: 0,
    });

    assert.strictEqual(result.classification, 'ambiguous');
    assert.strictEqual(result.boundaryEstablished, false);
  });

  it('an EMPTY captured boundary is authoritative for the first turn in a fresh session', () => {
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf(),
      messages: [
        userTurn('msg_first_user', INSTRUCTION, 2),
        assistantOk('msg_first_answer', 'Fresh-session delivery confirmed.', 3),
      ],
      transcriptReadable: true,
      transportExitCode: 0,
    });

    assert.strictEqual(result.boundaryEstablished, true);
    assert.strictEqual(result.classification, 'delivered');
    assert.strictEqual(result.workerExecution, 'completed');
    assert.strictEqual(result.matchingUserTurn?.messageId, 'msg_first_user');
  });

  it('a matching turn that PRE-DATES the boundary is not delivery of THIS Attempt', () => {
    // The same instruction was sent earlier by an earlier Attempt. Fingerprint matching
    // alone would call this delivered; the boundary is what distinguishes the two.
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_u1'),
      messages: [
        userTurn('msg_u1', INSTRUCTION, 1), // pre-boundary: an earlier send
        assistantOk('msg_a1', 'already answered', 2),
      ],
      transcriptReadable: true,
      transportExitCode: 0,
    });

    assert.strictEqual(result.classification, 'not_delivered');
    assert.strictEqual(result.matchingUserTurn, null);
  });

  /* ---------------------------------------------------------------------- */
  /* Worker execution — a separate axis                                     */
  /* ---------------------------------------------------------------------- */

  it('a completed assistant turn is completed execution, and the response text is captured', () => {
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_pre'),
      messages: [
        userTurn('msg_u1', INSTRUCTION, 10),
        assistantOk('msg_a1', 'Session ses_f18 confirmed. Architecture: OpenCodeProvider.', 11),
      ],
      transcriptReadable: true,
      transportExitCode: 0,
    });

    assert.strictEqual(result.classification, 'delivered');
    assert.strictEqual(result.workerExecution, 'completed');
    assert.strictEqual(result.workerExecutionEvidence.finish, 'stop');
    assert.strictEqual(result.workerExecutionEvidence.errorType, null);
    assert.ok(result.workerExecutionEvidence.text?.includes('OpenCodeProvider'));
    assert.strictEqual(result.workerExecutionEvidence.modelId, 'space-bunny-free');
  });

  it('an unfinished assistant turn is execution evidence but is not completion', () => {
    // Text presence must never decide execution state. An empty assistant turn proves the
    // provider began execution, but without a terminator it remains in progress.
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_pre'),
      messages: [userTurn('msg_u1', INSTRUCTION, 10), { messageId: 'msg_a1', role: 'assistant', createdAt: 11, text: '' }],
      transcriptReadable: true,
    });

    assert.strictEqual(result.classification, 'delivered');
    assert.strictEqual(result.workerExecution, 'in_progress');
  });

  it('a delivered user turn with no assistant turn remains not_started', () => {
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_pre'),
      messages: [userTurn('msg_u1', INSTRUCTION, 10)],
      transcriptReadable: true,
    });

    assert.strictEqual(result.classification, 'delivered');
    assert.strictEqual(result.workerExecution, 'not_started');
  });

  it('an idle run-outcome marker of failed corroborates the terminal error', () => {
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_pre'),
      messages: [
        userTurn('msg_u1', INSTRUCTION, 10),
        assistantError('msg_a1', 11, { type: 'provider.quota', status: 402, message: 'quota' }),
        { messageId: 'msg_idle', role: 'other', createdAt: 12, outcome: 'failed' },
      ],
      transcriptReadable: true,
    });

    assert.strictEqual(result.workerExecution, 'terminal_error');
    // Markers are recorded as `messageId:outcome`, so the reader can tie the marker back to
    // the exact provider row it came from rather than to an anonymous "it failed".
    assert.ok(
      result.workerExecutionEvidence.runOutcomeMarkers.includes('msg_idle:failed'),
      `expected the idle row's outcome as a traceable marker, got: ${JSON.stringify(result.workerExecutionEvidence.runOutcomeMarkers)}`,
    );
  });

  /* ---------------------------------------------------------------------- */
  /* Matching mechanics                                                      */
  /* ---------------------------------------------------------------------- */

  it('normalisation absorbs the provider JSON-quoting of a stored user turn', () => {
    // The OpenCode service stores a user turn's text as a JSON-encoded string, so the raw
    // field arrives as `"\"Do the thing\""`. Without unwrapping this, fingerprint matching is
    // structurally impossible — which is precisely the bug that made every user turn read as
    // "(none)" and forced Delivery truth onto the exit code.
    const stored = JSON.stringify(INSTRUCTION);
    assert.notStrictEqual(stored, INSTRUCTION, 'the stored form really is quoted');

    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_pre'),
      messages: [userTurn('msg_u1', stored, 10), assistantOk('msg_a1', 'done', 11)],
      transcriptReadable: true,
    });

    assert.strictEqual(result.classification, 'delivered');
    assert.strictEqual(result.matchKind, 'exact');
  });

  it('normalisation is idempotent and fingerprint-stable under incidental whitespace', () => {
    assert.strictEqual(instructionFingerprint(`  ${INSTRUCTION}\n`), instructionFingerprint(INSTRUCTION));
    assert.strictEqual(normalizeInstructionText(`  ${INSTRUCTION}  `), normalizeInstructionText(INSTRUCTION));
  });

  it('a truncated stored turn matches as a WEAKER prefix and says so, never silently as exact', () => {
    const truncated = INSTRUCTION.slice(0, 30);
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_pre'),
      messages: [userTurn('msg_u1', truncated, 10), assistantOk('msg_a1', 'done', 11)],
      transcriptReadable: true,
    });

    assert.strictEqual(result.classification, 'delivered');
    assert.strictEqual(result.matchKind, 'truncated_prefix', 'a weaker match must stay labelled weaker');
  });

  it('buildWatermark records the id set, and post-boundary detection is by id, not by time', () => {
    // Two messages sharing ONE timestamp. A clock cannot rank them; the id set can. The
    // index tie-break still yields a deterministic total order, so the reconciliation is
    // reproducible — but the ORDER is a sequence claim, not a chronology claim, and the
    // record has to say so rather than implying the provider told us which came first.
    const messages: ReconciliationMessage[] = [
      { messageId: 'msg_b', role: 'user', createdAt: 5, text: 'second' },
      { messageId: 'msg_a', role: 'user', createdAt: 5, text: 'first' },
    ];
    const wm = buildWatermark(SESSION, messages, 999);

    assert.deepStrictEqual(wm.messageIds, ['msg_b', 'msg_a']);
    assert.strictEqual(wm.messageCount, 2);
    assert.strictEqual(wm.capturedAt, 999);

    const result = reconcileTransportOutcome({
      expectedText: 'new instruction',
      watermark: wm,
      messages: [
        ...messages,
        userTurn('msg_c', 'new instruction', 5), // identical timestamp, different id
        assistantOk('msg_d', 'ok', 5),
      ],
      transcriptReadable: true,
    });

    assert.strictEqual(
      result.classification,
      'delivered',
      'the pre-dispatch ID SET decided this; a clock reading of 5 could not have',
    );
  });

  it('reports chronologicalOrder=false when any message lacks a timestamp, rather than guessing', () => {
    const result = reconcileTransportOutcome({
      expectedText: 'x',
      watermark: boundaryOf('msg_pre'),
      messages: [userTurn('msg_u1', 'x', 1), { messageId: 'msg_undated', role: 'other' }],
      transcriptReadable: true,
    });

    assert.strictEqual(result.chronologicalOrder, false, 'honest degradation, not a fabricated order');
  });

  /* ---------------------------------------------------------------------- */
  /* Reconstructed boundary — the weaker, historical path                    */
  /* ---------------------------------------------------------------------- */

  it('a reconstructed boundary separates two real dispatches of the SAME instruction', () => {
    // The production shape: the identical instruction was sent twice. Fingerprint matching
    // alone cannot tell the two sends apart, which is exactly why a boundary is required.
    const INTENT = 1_790_598_939_012; // the Delivery's durable created_at
    const messages = [
      userTurn('msg_earlier', INSTRUCTION, 1_790_598_880_521), // attempt #1, BEFORE the intent
      assistantError('msg_err_1', 1_790_598_880_937, { type: 'provider.quota', status: 402, message: 'quota' }),
      userTurn('msg_later', INSTRUCTION, 1_790_598_939_476),   // attempt #2, AFTER the intent
      assistantError('msg_err_2', 1_790_598_939_873, { type: 'provider.quota', status: 402, message: 'quota' }),
    ];

    const wm = reconstructWatermarkFromIntentTime(SESSION, messages, INTENT);
    assert.strictEqual(wm.provenance, 'reconstructed_from_intent_time');
    assert.deepStrictEqual(
      wm.messageIds,
      ['msg_earlier', 'msg_err_1'],
      'only turns the provider recorded as pre-intent are placed on the boundary',
    );

    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: wm,
      messages,
      transcriptReadable: true,
    });

    // The LATER turn is attributed, not the earlier one — so the verdict is about the right
    // attempt and the recorded assistant error is the right attempt's error.
    assert.strictEqual(result.classification, 'delivered');
    assert.strictEqual(result.matchingUserTurn?.messageId, 'msg_later');
    assert.strictEqual(result.workerExecution, 'terminal_error');
    assert.strictEqual(result.workerExecutionEvidence.assistantMessageId, 'msg_err_2');
    assert.strictEqual(result.boundaryProvenance, 'reconstructed_from_intent_time');
  });

  it('a reconstructed boundary reports its weaker provenance rather than looking authoritative', () => {
    const wm = reconstructWatermarkFromIntentTime(SESSION, [userTurn('msg_x', 'y', 1)], 10);
    const result = reconcileTransportOutcome({
      expectedText: 'z',
      watermark: wm,
      messages: [userTurn('msg_x', 'y', 1)],
      transcriptReadable: true,
    });

    // A read with no matching post-boundary turn is `not_delivered` structurally, but the
    // provenance must travel with it: the engine refuses to let a reconstructed boundary
    // license a resend, precisely because absence under it is not proof of absence.
    assert.strictEqual(result.classification, 'not_delivered');
    assert.strictEqual(
      result.boundaryProvenance,
      'reconstructed_from_intent_time',
      'a reader must be able to see the verdict rests on a derived boundary',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Phase F: supervision-time completion observation                            */
/* -------------------------------------------------------------------------- */

/**
 * Worker completion observation — the supervisor's read of "did this instruction finish".
 *
 * ## The defect this exists to prevent
 *
 * `OpenCodeProvider.detectCompletionState` used to read message arrays off
 * `opencode session list --format json`, whose rows carry session METADATA only — no
 * `messages` key exists, so the array was permanently `[]` and the method reported
 * `no_post_dispatch_assistant_response` for every session, forever. Because
 * `promoteAttemptToRunning` is gated on execution evidence, the Attempt stayed `prepared`
 * indefinitely even with a completed worker response sitting in the transcript.
 *
 * The seam that hid it: the supervisor had a second, private completion detector in the
 * transcript fallback, and it had its own, different definition. It read the newest 50 turns,
 * took `assistantTurns[0]` — which is the in-flight turn whenever the worker is running — and
 * then demanded a `finish`, so a busy worker was permanently unreadable; and it accepted
 * `finish: 'tool-calls'` as completion, which is a turn yielding to a tool, not an answer.
 *
 * ## The rule these tests pin down
 *
 *   Completion is a property of a SPECIFIC, IDENTIFIED turn that the provider terminated
 *   with a run-ending reason AND that produced text. It is never inferred from idleness,
 *   never from turn count, and never from a turn that merely stopped to call a tool.
 *
 * The verdict is monotone (a completed response does not un-complete), while `inFlight` is
 * volatile (it tracks the newest turn). They are reported separately because both are true
 * at once whenever a worker answers and then goes back to work — and a single flag would
 * force a choice between losing a real answer and waiting forever for silence.
 */
describe('Worker completion observation — a named terminated turn, never idleness', () => {
  /** A tool-calls turn: real, finished as a TURN, and not an answer. */
  function assistantToolCalls(id: string, text: string, createdAt: number): ReconciliationMessage {
    return { messageId: id, role: 'assistant', createdAt, text, finish: 'tool-calls', error: null };
  }

  /** A turn the provider has emitted but not terminated. */
  function assistantInFlight(id: string, text: string | undefined, createdAt: number): ReconciliationMessage {
    return { messageId: id, role: 'assistant', createdAt, text, finish: null, error: null };
  }

  it('THE WEDGE: a tool-calls turn is not a completed response', () => {
    // The live shape: a worker that used tools answers by ending on `tool-calls` while it
    // keeps working. Treating that as completion hands off a narration, not the answer.
    const observation = observeWorkerCompletion({
      expectedText: INSTRUCTION,
      messages: [
        userTurn('msg_instr', INSTRUCTION, 1_000),
        assistantToolCalls('msg_t1', 'Let me look at the adapter.', 1_100),
        assistantToolCalls('msg_t2', 'Found the CLI read; checking now.', 1_200),
      ],
    });

    assert.strictEqual(observation.hasCompletedResponse, false);
    assert.strictEqual(observation.response, null);
    // The boundary is the instruction turn itself, not a timestamp.
    assert.strictEqual(observation.boundary.source, 'matched_dispatched_user_turn');
    assert.strictEqual(observation.boundary.instructionTurnId, 'msg_instr');
    assert.strictEqual(observation.assistantTurnCount, 2);
  });

  it('THE WEDGE: a busy worker is in flight, not complete, and not silent', () => {
    // Exactly the state the old fallback could never read: newest turn still running.
    const observation = observeWorkerCompletion({
      expectedText: INSTRUCTION,
      messages: [
        userTurn('msg_instr', INSTRUCTION, 1_000),
        assistantToolCalls('msg_t1', 'Working.', 1_100),
        assistantOk('msg_done', 'The answer.', 1_200),
        assistantInFlight('msg_live', undefined, 1_300),
      ],
    });

    assert.strictEqual(observation.inFlight, true);
    assert.strictEqual(observation.newestAssistantMessageId, 'msg_live');
    assert.strictEqual(observation.assistantTurnCount, 3);
  });

  it('captures the response that already completed while a newer turn is still running', () => {
    // A completed response does not un-complete because the worker went back to work. This
    // is the case a single flag cannot express, and it is why the supervisor reads both.
    const observation = observeWorkerCompletion({
      expectedText: INSTRUCTION,
      messages: [
        userTurn('msg_instr', INSTRUCTION, 1_000),
        assistantToolCalls('msg_t1', 'Checking.', 1_100),
        assistantOk('msg_done', 'Done: the adapter reads the transcript.', 1_200),
        assistantInFlight('msg_live', undefined, 1_300),
      ],
    });

    assert.strictEqual(observation.hasCompletedResponse, true);
    assert.strictEqual(observation.inFlight, true);
    assert.strictEqual(observation.response?.messageId, 'msg_done');
    assert.strictEqual(observation.response?.finish, 'stop');
    assert.strictEqual(observation.response?.text, 'Done: the adapter reads the transcript.');
    // The captured turn is named, so "completed" is checkable against the provider later.
    assert.strictEqual(observation.newestAssistantMessageId, 'msg_live');
  });

  it('an answer is not complete while a bare tool-calls turn is still the newest one', () => {
    // Order matters: the terminal answer came first, then the worker kept calling tools. The
    // completed response is still reportable, but the newest turn is NOT what got captured —
    // conflating them would attribute the answer to the wrong turn.
    const observation = observeWorkerCompletion({
      expectedText: INSTRUCTION,
      messages: [
        userTurn('msg_instr', INSTRUCTION, 1_000),
        assistantOk('msg_done', 'First answer.', 1_100),
        assistantToolCalls('msg_t1', 'Now running more tools.', 1_200),
      ],
    });

    assert.strictEqual(observation.hasCompletedResponse, true);
    assert.strictEqual(observation.response?.messageId, 'msg_done');
    // `tool-calls` means the turn ended so a tool could run and the RUN continues, so the
    // newest turn is still in progress. It used to read `false` here, which left a working
    // worker indistinguishable from an idle one and made the supervisor escalate.
    assert.strictEqual(observation.inFlight, true);
    assert.strictEqual(observation.newestAssistantMessageId, 'msg_t1');
  });

  it('a terminated turn with no text is not a response', () => {
    const observation = observeWorkerCompletion({
      expectedText: INSTRUCTION,
      messages: [
        userTurn('msg_instr', INSTRUCTION, 1_000),
        { messageId: 'msg_bare', role: 'assistant', createdAt: 1_100, finish: 'stop', text: '' },
      ],
    });

    assert.strictEqual(observation.hasCompletedResponse, false);
  });

  /**
   * THE THIRD STATE: the run is continuing, so the newest post-boundary turn ends in
   * `tool-calls` and NO turn in the window is terminal.
   *
   * This is the normal shape of a working agent — it is the state the live worker session
   * was actually in for 28 post-boundary turns before it finally errored. It used to report
   * `inFlight: false` and `hasCompletedResponse: false`, which is the one combination the
   * supervisor cannot distinguish from "idle and produced nothing", so it escalated: it minted
   * a recovery Assignment and sent a message into the Planner claiming the Worker had done
   * nothing, while the Worker was demonstrably still working.
   */
  describe('a run that is continuing between turns is in flight, not idle', () => {
    /** The live mid-run shape: a tool-calls chain and nothing terminal in the window. */
    function midRunChain(count: number, firstCreatedAt = 1_000) {
      const messages: ReconciliationMessage[] = [userTurn('msg_instr', INSTRUCTION, 500)];
      for (let i = 0; i < count; i++) {
        messages.push(
          assistantToolCalls(`msg_t${i}`, i % 7 === 0 ? `Step ${i}.` : '', firstCreatedAt + (i + 1) * 100),
        );
      }
      return messages;
    }

    it('a tool-calls chain with no terminal turn reads as WORKING, not as silence', () => {
      const observation = observeWorkerCompletion({
        expectedText: INSTRUCTION,
        messages: midRunChain(6),
        afterMessageIds: ['msg_instr'],
      });

      assert.strictEqual(observation.inFlight, true, 'the run is continuing, so this is in flight');
      assert.strictEqual(observation.hasCompletedResponse, false, 'nothing terminal has been written');
      assert.strictEqual(observation.terminalError, null);
      assert.strictEqual(observation.assistantTurnCount, 6);
      // The exact combination the supervisor escalates on. It must be unreachable while a
      // run is genuinely continuing.
      const stillWorking = observation.inFlight || false;
      assert.strictEqual(
        stillWorking || observation.hasCompletedResponse,
        true,
        'a working run must never be reported as idle-with-no-output',
      );
    });

    it('holds for a long chain and for a single turn', () => {
      for (const count of [1, 2, 28, 48]) {
        const observation = observeWorkerCompletion({
          expectedText: INSTRUCTION,
          messages: midRunChain(count),
          afterMessageIds: ['msg_instr'],
        });
        assert.strictEqual(observation.inFlight, true, `chain of ${count} must read as in flight`);
        assert.strictEqual(observation.hasCompletedResponse, false, `chain of ${count} has no answer yet`);
      }
    });

    it('still escalates once the run really has ended in a provider error', () => {
      // The guard on the other side: marking `tool-calls` as continuing must not swallow the
      // honest escalation. An error terminator is still terminal, so a dead run still reads
      // as "not running, no answer" and the supervisor still raises a notice.
      const observation = observeWorkerCompletion({
        expectedText: INSTRUCTION,
        messages: [
          ...midRunChain(4),
          assistantError('msg_err', 5_000, { type: 'provider.error', status: 500, message: 'boom' }),
        ],
        afterMessageIds: ['msg_instr'],
      });

      assert.strictEqual(observation.inFlight, false, 'an error ends the run');
      assert.strictEqual(observation.hasCompletedResponse, false, 'an error produced no answer');
      assert.strictEqual(observation.terminalError?.type, 'provider.error');
    });

    it('still hands on the answer once the run terminates normally', () => {
      const observation = observeWorkerCompletion({
        expectedText: INSTRUCTION,
        messages: [...midRunChain(3), assistantOk('msg_done', 'The answer.', 9_000)],
        afterMessageIds: ['msg_instr'],
      });

      assert.strictEqual(observation.inFlight, false);
      assert.strictEqual(observation.hasCompletedResponse, true);
      assert.strictEqual(observation.response?.messageId, 'msg_done');
      assert.strictEqual(observation.response?.finish, 'stop');
    });
  });

  it('reports the provider terminator for a terminal error AND the error itself', () => {
    // `error` is terminal for a run. Hiding it would make a quota wall look like silence.
    const observation = observeWorkerCompletion({
      expectedText: INSTRUCTION,
      messages: [
        userTurn('msg_instr', INSTRUCTION, 1_000),
        assistantError('msg_err', 1_100, { type: 'provider.quota', status: 402, message: 'quota' }),
      ],
    });

    assert.strictEqual(observation.hasCompletedResponse, false, 'an error turn produced no answer');
    assert.strictEqual(observation.inFlight, false);
    assert.strictEqual(observation.terminalError?.type, 'provider.quota');
    assert.strictEqual(observation.terminalError?.status, 402);
  });

  it('anchors on the instruction turn, so turns BEFORE it are never attributed', () => {
    // A pre-existing conversation: turns before the instruction must not count.
    const observation = observeWorkerCompletion({
      expectedText: INSTRUCTION,
      messages: [
        assistantOk('msg_before', 'Unrelated earlier answer.', 500),
        userTurn('msg_instr', INSTRUCTION, 1_000),
        assistantOk('msg_after', 'This one answers it.', 1_100),
      ],
    });

    assert.strictEqual(observation.response?.messageId, 'msg_after');
    assert.strictEqual(observation.assistantTurnCount, 1);
  });

  it('with no instruction match it falls back to the caller timestamp and SAYS SO', () => {
    // The boundary must not be silently upgraded. A reader has to be able to tell a
    // message-id watermark from a timestamp one.
    const observation = observeWorkerCompletion({
      expectedText: 'an instruction that is not in the readable windows',
      afterCreatedAt: 2_000,
      messages: [
        assistantOk('msg_old', 'Earlier.', 1_000),
        assistantOk('msg_new', 'After the boundary.', 2_500),
      ],
    });

    assert.strictEqual(observation.boundary.source, 'caller_after_created_at');
    assert.strictEqual(observation.boundary.instructionTurnId, null);
    assert.strictEqual(observation.boundary.instructionMatchKind, 'none');
    assert.strictEqual(observation.response?.messageId, 'msg_new');
    assert.strictEqual(observation.assistantTurnCount, 1);
  });

  it('with neither an instruction nor a timestamp, claims nothing at all', () => {
    // No watermark means nothing can be attributed to this instruction. Reporting the whole
    // session here is how a stale or foreign session gets mistaken for a finished attempt.
    const observation = observeWorkerCompletion({
      expectedText: 'not present',
      messages: [assistantOk('msg_a', 'Answer.', 1_000)],
    });

    assert.strictEqual(observation.boundary.source, 'unavailable');
    assert.strictEqual(observation.assistantTurnCount, 0);
    assert.strictEqual(observation.hasCompletedResponse, false);
    assert.strictEqual(observation.inFlight, false);
  });

  it('orders provider output that arrives newest-first', () => {
    // The shared service returns newest-first by default. Picking the wrong end of that
    // array is the original defect, so ordering is asserted explicitly.
    const observation = observeWorkerCompletion({
      expectedText: INSTRUCTION,
      messages: [
        assistantOk('msg_newest', 'Newest answer.', 1_300),
        assistantToolCalls('msg_mid', 'Mid.', 1_200),
        userTurn('msg_instr', INSTRUCTION, 1_000),
      ],
    });

    assert.strictEqual(observation.response?.messageId, 'msg_newest');
    assert.strictEqual(observation.chronologicalOrderDerived, true);
  });

  it('a provider-window gap is recorded on the observation, not hidden', () => {
    const observation = observeWorkerCompletion({
      expectedText: INSTRUCTION,
      unreadableMiddle: true,
      messages: [userTurn('msg_instr', INSTRUCTION, 1_000), assistantOk('msg_new', 'Answer.', 9_000)],
    });

    assert.strictEqual(observation.unreadableMiddle, true);
    assert.strictEqual(observation.hasCompletedResponse, true, 'the newest window always holds the newest turn');
    assert.strictEqual(
      observation.capturedResponseIsNewest,
      true,
      'here the captured turn IS the newest, so the text is the latest answer',
    );
  });

  it('flags an older completion when the window gap may hide a newer one', () => {
    // The live RelayX Development case: 1230 turns, 50 readable at each end. The captured
    // response came from the OLDEST window, so a later completion can exist in the gap. The
    // completion claim is still true — a named, provider-terminated turn was observed — but
    // the text must not be presented as the LATEST answer when it may not be.
    const observation = observeWorkerCompletion({
      expectedText: INSTRUCTION,
      unreadableMiddle: true,
      messages: [
        userTurn('msg_instr', INSTRUCTION, 1_000),
        assistantOk('msg_old_done', 'An earlier completed answer.', 1_100),
        // The gap: turns 2..N of the session are unreadable, including a later completion.
        assistantToolCalls('msg_newest', 'Still working on the newest turn.', 9_000),
      ],
    });

    assert.strictEqual(observation.hasCompletedResponse, true);
    assert.strictEqual(observation.response?.messageId, 'msg_old_done');
    assert.strictEqual(
      observation.capturedResponseIsNewest,
      false,
      'a consumer forwarding this text must be able to see it may not be the latest answer',
    );
  });

  it('is newest when the gap is closed, so the flag means something', () => {
    const observation = observeWorkerCompletion({
      expectedText: INSTRUCTION,
      unreadableMiddle: false,
      messages: [
        userTurn('msg_instr', INSTRUCTION, 1_000),
        assistantOk('msg_old_done', 'An earlier answer.', 1_100),
        assistantOk('msg_new_done', 'The latest answer.', 9_000),
      ],
    });

    assert.strictEqual(observation.capturedResponseIsNewest, true);
    assert.strictEqual(observation.response?.messageId, 'msg_new_done');
  });
});
