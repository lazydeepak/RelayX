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
  reconstructWatermarkFromIntentTime,
  normalizeInstructionText,
  type ExactSessionWatermark,
  type ReconciliationMessage,
} from '../src/relay/providers/exactSessionReconciliation.ts';

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

  it('a delivered instruction with no assistant turn at all is in_progress, not completed', () => {
    // Text presence must never decide execution state. An empty assistant turn is not a
    // completed response; it is an unfinished one.
    const result = reconcileTransportOutcome({
      expectedText: INSTRUCTION,
      watermark: boundaryOf('msg_pre'),
      messages: [userTurn('msg_u1', INSTRUCTION, 10), { messageId: 'msg_a1', role: 'assistant', createdAt: 11, text: '' }],
      transcriptReadable: true,
    });

    assert.strictEqual(result.classification, 'delivered');
    assert.strictEqual(result.workerExecution, 'in_progress');
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
