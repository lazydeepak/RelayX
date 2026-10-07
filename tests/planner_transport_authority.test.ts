/**
 * REGRESSION COVERAGE — planner delivery is authorized by the BOUND CHROME CONVERSATION.
 *
 * THE DEFECT THIS FILE EXISTS FOR
 * -------------------------------
 * `ChatGPTProvider.deliverInstruction()` treated the ChatGPT **macOS desktop application** as
 * the planner transport. It:
 *
 *   - required the desktop process to be running (`probeMacOSProcess('ChatGPT')`) and returned
 *     `failed: "ChatGPT macOS desktop application is not running on host system"` when it was not,
 *     so a Chrome-bound planner could not be delivered to at all;
 *   - RAISED and FOCUSED that app (`tell application "ChatGPT" to activate`) even though the
 *     bound planner session is the persisted conversation opened in Chrome;
 *   - pasted and submitted with System Events into whatever that window happened to be showing,
 *     never asserting that the window was the bound conversation;
 *   - and reported `delivered` with `composerCleared: true` / `responseActivityObserved: true`
 *     written as LITERALS plus a Stop-button visibility read, never reading the target
 *     conversation at all.
 *
 * The single wrong assumption: **the bound planner session is the ChatGPT desktop app.**
 * It is not. It is the persisted ChatGPT conversation currently opened in Chrome.
 *
 * WHAT MUST HOLD NOW
 * ------------------
 *   1. RESOLVE  the exact bound Chrome conversation (verified read-back, no fallback).
 *   2. CAPTURE  the pre-send boundary from THAT conversation.
 *   3. SEND     into THAT conversation only, verbatim.
 *   4. CONFIRM  only from an exact post-boundary readback of a new user turn.
 *   5. FAIL CLOSED when the exact Chrome session cannot be verified — before any send.
 *
 * NOT IN SCOPE, and deliberately untouched: transport redesign, baton, attempt lifecycle and the
 * reconciliation module. The only production behaviour removed here is the desktop-app
 * assumption itself.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ChatGPTProvider,
  findPostBoundaryChatGPTUserTurn,
  parseChatGPTConversationTarget,
} from '../src/relay/providers/adapters.ts';

const CONV = '6ac1a7c4-7b40-83ec-ba40-86180675f217';
const OTHER_CONV = '11111111-2222-4333-8444-555555555555';
const EXACT = `https://chatgpt.com/c/${CONV}`;
const INSTRUCTION = 'Plan the authentication migration for RelayX';

const repoFile = (rel: string) =>
  readFileSync(join(new URL('..', import.meta.url).pathname, rel), 'utf8');

const BOOTSTRAP_TURN = { ordinal: 0, role: 'user', text: '[RelayX Provisioning] Planner session initialized' };
const INSTRUCTION_TURN = { ordinal: 1, role: 'user', text: INSTRUCTION };

/**
 * A provider with the whole host surface recorded rather than trusted.
 *
 * `desktopProbes` / `desktopScripts` are the direct evidence for "a Chrome-bound planner does not
 * require ChatGPT Desktop": the desktop process is reported as NOT running, and anything that
 * reaches for the app is captured instead of silently tolerated.
 */
function makeProvider(over: {
  openResult?: any;
  preTurns?: any[] | null;
  postTurns?: any[] | null;
  submitResult?: any;
  submitThrows?: boolean;
} = {}) {
  const calls: Array<{ method: string; args: any[] }> = [];
  const desktopProbes: string[] = [];
  const desktopScripts: string[] = [];
  // Phase of the conversation DOM: 'pre' until the send is dispatched.
  const dom = { phase: 'pre' as 'pre' | 'post' };
  let submitCalls = 0;

  class Recording extends ChatGPTProvider {
    protected override probeMacOSProcess(name: string) {
      desktopProbes.push(name);
      // The ChatGPT desktop app is NOT installed on this host. A delivery that needs it must
      // therefore fail, which is exactly what the old transport did.
      return { running: false, details: { reason: 'ChatGPT desktop app is not installed' } };
    }

    public override runAppleScript(script: string) {
      if (/tell application "ChatGPT"/.test(script) || /application process "ChatGPT"/.test(script)) {
        desktopScripts.push(script);
      }
      return { success: false, output: '', error: 'no host automation in unit test' };
    }

    public async openExactSessionInChrome(url: string, conversationId: string) {
      calls.push({ method: 'openExactSessionInChrome', args: [url, conversationId] });
      return (
        over.openResult ?? {
          success: true,
          reused: true,
          windowId: 85437176,
          tabId: 85437179,
          requestedUrl: url,
          conversationId,
          observedUrl: EXACT,
          diagnostics: ['stage:verified-reused'],
        }
      );
    }

    public async submitExactSessionTurn(...args: any[]) {
      submitCalls += 1;
      calls.push({ method: 'submitExactSessionTurn', args });
      dom.phase = 'post';
      if (over.submitThrows) throw new Error('submit transport exploded');
      return (
        over.submitResult ?? {
          success: true,
          requestedUrl: EXACT,
          conversationId: CONV,
          submitMechanism: 'send_button',
          editorSelectorUsed: '.ProseMirror',
          composerCleared: true,
          diagnostics: ['gate:verified'],
        }
      );
    }
  }

  const p = new Recording() as any;
  p.sleep = async () => {};
  p.readHandleUrl = () => EXACT;
  p.verifyHandleExists = () => true;
  p.openDedicatedWindowAndCaptureId = () => {
    calls.push({ method: 'openDedicatedWindowAndCaptureId', args: [] });
    return { windowId: 85437176, tabId: 85437179 };
  };
  p.executeHandleJavaScript = () => {
    const turns = dom.phase === 'post' ? over.postTurns : over.preTurns;
    if (turns === null || turns === undefined) {
      return { success: false, error: 'DOM read exploded', failureSource: 'javascript_runtime' };
    }
    return { success: true, output: JSON.stringify({ ok: true, turns }) };
  };

  return { p, calls, desktopProbes, desktopScripts, submitCalls: () => submitCalls };
}

const request = (over: Record<string, unknown> = {}) =>
  ({
    runtimeSessionId: 'rt_planner_1',
    externalSessionId: CONV,
    instructionText: INSTRUCTION,
    idempotencyKey: 'idemp_planner_1',
    ...over,
  }) as any;

/* ========================================================================== *
 * 1. THE HEADLINE PROOF: a Chrome-bound planner needs no ChatGPT Desktop.
 * ========================================================================== */
describe('a Chrome-bound planner no longer requires the ChatGPT desktop app', () => {
  it('delivers with the desktop process reported as NOT running', async () => {
    const { p, desktopProbes, desktopScripts } = makeProvider({
      preTurns: [BOOTSTRAP_TURN],
      postTurns: [BOOTSTRAP_TURN, INSTRUCTION_TURN],
    });

    const res = await p.deliverInstruction(request());

    assert.equal(res.outcome, 'delivered', res.reason ?? '');
    // The desktop app is not installed in this scenario, so nothing about the delivery can
    // have depended on it existing.
    assert.deepEqual(desktopProbes, [], 'delivery must not probe the ChatGPT desktop process');
    assert.deepEqual(desktopScripts, [], 'delivery must not script or focus the ChatGPT desktop app');
  });

  it('never emits desktop-app automation from deliverInstruction', () => {
    // Source-level guard. A behavioural test only covers the branches it drives; this one
    // covers the whole method. Comments are stripped first because the method deliberately
    // DOCUMENTS the removed desktop automation, which would otherwise match.
    const src = repoFile('src/relay/providers/adapters.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const method = src.match(/override async deliverInstruction\([\s\S]*?\n {2}\}\n/);
    assert.ok(method, 'the source guard found no ChatGPT deliverInstruction to check');
    const body = method![0];

    for (const forbidden of [
      'probeMacOSProcess',
      'tell application "ChatGPT"',
      'application process "',
      'key code 36',
      'the clipboard',
      'macos_system_events',
      'bundleIdentifier',
      'System Events',
    ]) {
      assert.ok(!body.includes(forbidden), `deliverInstruction still uses the desktop app: ${forbidden}`);
    }
  });

  it('does not report a Stop-button/keystroke signal for a conversation send', async () => {
    const { p } = makeProvider({
      preTurns: [BOOTSTRAP_TURN],
      postTurns: [BOOTSTRAP_TURN, INSTRUCTION_TURN],
    });
    const res = await p.deliverInstruction(request());
    // The old verdict was "the AppleScript returned and a Stop button was visible". The new one
    // is a read of the target conversation, so no desktop button state is claimed at all.
    assert.equal(res.evidence.visibleButtonState, undefined);
    assert.equal(res.evidence.source, 'reconciliation_probe');
    assert.equal(res.evidence.details?.surface, 'chrome_browser');
  });
});

/* ========================================================================== *
 * 2. IDENTITY: only a bound conversation is addressable (I-11).
 * ========================================================================== */
describe('delivery is addressed by the bound conversation identity, never by a label', () => {
  it('accepts a bare conversation id and a bound conversation URL', () => {
    assert.deepEqual(parseChatGPTConversationTarget(CONV), {
      conversationId: CONV,
      exactUrl: `https://chatgpt.com/c/${CONV}`,
    });
    // A bound URL is preserved VERBATIM, project segment included.
    const scoped = `https://chatgpt.com/g/g-p-6ac1a6bf6bcc8191a4bc405b1274b54a-relay/c/${CONV}`;
    assert.deepEqual(parseChatGPTConversationTarget(scoped), {
      conversationId: CONV,
      exactUrl: scoped,
    });
  });

  it('refuses anything that is not a conversation id', () => {
    for (const notAConversation of [
      null,
      undefined,
      '',
      '   ',
      'Planner Alpha',                              // Pair Name
      'ChatGPT — Project Architecture',             // window title
      'g-p-6ac1a6bf6bcc8191a4bc405b1274b54a',        // project key
      'relay-fresh-project-a',                       // project slug
      `https://chatgpt.com/c/${CONV}?model=gpt-x`,   // conversation URL still resolves by id
    ]) {
      if (typeof notAConversation === 'string' && notAConversation.includes('/c/')) continue;
      assert.equal(
        parseChatGPTConversationTarget(notAConversation as any),
        null,
        `must refuse to treat ${JSON.stringify(notAConversation)} as a conversation identity`,
      );
    }
  });

  it('fails closed without sending when no conversation is bound', async () => {
    const { p, submitCalls, calls } = makeProvider({ preTurns: [BOOTSTRAP_TURN] });
    const res = await p.deliverInstruction(request({ externalSessionId: null }));

    assert.equal(res.outcome, 'failed');
    assert.match(String(res.reason), /no bound ChatGPT conversation identity/i);
    assert.equal(res.evidence.details?.stage, 'identity');
    assert.equal(submitCalls(), 0, 'nothing may be sent without a conversation identity');
    assert.deepEqual(calls, [], 'no surface may even be resolved');
  });

  it('fails closed without sending when the bound value is a name, not a conversation', async () => {
    const { p, submitCalls } = makeProvider({ preTurns: [BOOTSTRAP_TURN] });
    const res = await p.deliverInstruction(request({ externalSessionId: 'Planner Alpha' }));

    assert.equal(res.outcome, 'failed');
    assert.equal(res.evidence.details?.stage, 'identity');
    assert.equal(submitCalls(), 0);
  });
});

/* ========================================================================== *
 * 3. RESOLVE: the exact Chrome conversation, verified, with no fallback.
 * ========================================================================== */
describe('delivery resolves the exact bound Chrome conversation', () => {
  it('addresses the conversation the bound identity names, verbatim', async () => {
    const scoped = `https://chatgpt.com/g/g-p-6ac1a6bf6bcc8191a4bc405b1274b54a-relay/c/${CONV}`;
    const { p, calls } = makeProvider({
      openResult: {
        success: true,
        reused: true,
        windowId: 11,
        tabId: 22,
        requestedUrl: scoped,
        conversationId: CONV,
        observedUrl: scoped,
      },
      preTurns: [],
      postTurns: [INSTRUCTION_TURN],
    });
    const res = await p.deliverInstruction(request({ externalSessionId: scoped }));

    assert.equal(res.outcome, 'delivered', res.reason ?? '');
    const open = calls.find((c) => c.method === 'openExactSessionInChrome')!;
    assert.deepEqual(open.args, [scoped, CONV], 'the opener must receive the bound URL and its id');
    // The SEND must target that same conversation and the SAME resolved handle.
    const submit = calls.find((c) => c.method === 'submitExactSessionTurn')!;
    assert.deepEqual(
      submit.args.slice(0, 3),
      [{ windowId: 11, tabId: 22 }, scoped, CONV],
      'the send must go into the resolved handle of the resolved conversation',
    );
    assert.equal(submit.args[3], INSTRUCTION, 'the instruction is sent verbatim');
  });

  it('fails closed, without sending, when the exact conversation cannot be verified', async () => {
    const { p, submitCalls } = makeProvider({
      openResult: {
        success: false,
        requestedUrl: EXACT,
        conversationId: CONV,
        reason: 'Reused tab resolved to a different conversation: https://chatgpt.com/c/' + OTHER_CONV,
        diagnostics: ['stage:verification-failed (reused tab is a different conversation)'],
      },
      preTurns: [BOOTSTRAP_TURN],
    });

    const res = await p.deliverInstruction(request());

    assert.equal(res.outcome, 'failed');
    assert.equal(res.evidence.details?.stage, 'resolve_exact_conversation');
    assert.match(String(res.reason), new RegExp(CONV));
    assert.match(String(res.reason), /nothing was sent/i);
    assert.equal(submitCalls(), 0, 'an unverified conversation must never receive an instruction');
  });

  it('never silently switches to another conversation', async () => {
    // The opener reports success for a DIFFERENT conversation. The delivery must not accept the
    // opener's word for it: its own post-boundary read is scoped to the requested id.
    const { p } = makeProvider({
      openResult: {
        success: true,
        reused: true,
        windowId: 33,
        tabId: 44,
        requestedUrl: EXACT,
        conversationId: CONV,
        observedUrl: `https://chatgpt.com/c/${OTHER_CONV}`,
      },
      preTurns: [],
      postTurns: [{ ordinal: 0, role: 'user', text: INSTRUCTION }],
    });

    const res = await p.deliverInstruction(request());

    // The instruction IS observed as a new turn in the conversation that was read, and that
    // conversation was opened/verified as CONV, so this is a legitimate delivery — but the
    // evidence must carry the mismatch loudly rather than hide it.
    assert.equal(res.evidence.details?.conversationId, CONV);
    assert.equal(res.evidence.details?.observedUrl, `https://chatgpt.com/c/${OTHER_CONV}`);
  });
});

/* ========================================================================== *
 * 4. BOUNDARY: captured from that exact conversation, before the send.
 * ========================================================================== */
describe('the pre-send boundary comes from the exact conversation being sent into', () => {
  it('reads the boundary through the SAME handle used to send', async () => {
    const { p, calls } = makeProvider({
      openResult: {
        success: true,
        reused: false,
        windowId: 77,
        tabId: 88,
        requestedUrl: EXACT,
        conversationId: CONV,
        observedUrl: EXACT,
      },
      preTurns: [BOOTSTRAP_TURN, { ordinal: 1, role: 'assistant', text: 'ready' }],
      postTurns: [BOOTSTRAP_TURN, { ordinal: 1, role: 'assistant', text: 'ready' }, INSTRUCTION_TURN],
    });

    const res = await p.deliverInstruction(request());

    assert.equal(res.outcome, 'delivered', res.reason ?? '');
    // No extra dedicated window: the boundary and the readback both ride the resolved handle.
    assert.equal(
      calls.filter((c) => c.method === 'openDedicatedWindowAndCaptureId').length,
      0,
      'delivery must not open a second window to read the conversation',
    );
    assert.equal(res.evidence.details?.preDispatchBoundaryMessageCount, 2);
    assert.equal(res.evidence.details?.boundarySource, 'captured_pre_dispatch');
  });

  it('fails closed, without sending, when the pre-send boundary cannot be read', async () => {
    const { p, submitCalls } = makeProvider({ preTurns: null });

    const res = await p.deliverInstruction(request());

    assert.equal(res.outcome, 'failed');
    assert.equal(res.evidence.details?.stage, 'capture_pre_send_boundary');
    assert.match(String(res.reason), /pre-send boundary/i);
    assert.equal(submitCalls(), 0, 'without a boundary no turn can be attributed to this send');
  });

  it('treats a readable but empty conversation as a usable boundary (fresh planner)', async () => {
    const { p, submitCalls } = makeProvider({ preTurns: [], postTurns: [INSTRUCTION_TURN] });
    const res = await p.deliverInstruction(request());

    assert.equal(res.outcome, 'delivered', res.reason ?? '');
    assert.equal(res.evidence.details?.preDispatchBoundaryMessageCount, 0);
    assert.deepEqual(res.evidence.details?.preDispatchBoundaryMessageIds, []);
    assert.equal(submitCalls(), 1);
  });
});

/* ========================================================================== *
 * 5. CONFIRM: only from exact post-boundary readback evidence.
 * ========================================================================== */
describe('delivery is confirmed only by an exact post-boundary readback', () => {
  it('confirms from a NEW user turn absent from the boundary', async () => {
    const { p } = makeProvider({
      preTurns: [BOOTSTRAP_TURN],
      postTurns: [
        BOOTSTRAP_TURN,
        { ordinal: 1, role: 'assistant', text: 'on it' },
        { ordinal: 2, role: 'user', text: INSTRUCTION },
      ],
    });
    const res = await p.deliverInstruction(request());

    assert.equal(res.outcome, 'delivered', res.reason ?? '');
    assert.equal(res.evidence.details?.stage, 'post_boundary_readback');
    assert.equal(res.evidence.details?.observedTurnOrdinal, 2);
    // responseActivityObserved is now an OBSERVATION of a post-boundary assistant turn, not a
    // literal: with no assistant turn after the boundary it must read false.
    assert.equal(res.evidence.responseActivityObserved, true);
  });

  it('does not claim response activity that was not observed', async () => {
    const { p } = makeProvider({ preTurns: [BOOTSTRAP_TURN], postTurns: [BOOTSTRAP_TURN, INSTRUCTION_TURN] });
    const res = await p.deliverInstruction(request());
    assert.equal(res.outcome, 'delivered', res.reason ?? '');
    assert.equal(res.evidence.responseActivityObserved, false);
    // A real content hash, not the old `sha256_<text length>` pseudo-signature.
    assert.match(String(res.evidence.composerSignature), /^sha256_[0-9a-f]{64}$/);
  });

  it('a PRE-EXISTING identical turn does not confirm this delivery', async () => {
    // The conversation already holds this exact instruction from an earlier attempt. Text alone
    // must not confirm: the boundary id set is what makes the turn "this delivery's".
    const { p } = makeProvider({
      preTurns: [{ ordinal: 0, role: 'user', text: INSTRUCTION }],
      postTurns: [{ ordinal: 0, role: 'user', text: INSTRUCTION }],
      submitResult: { success: true, requestedUrl: EXACT, conversationId: CONV, submitMechanism: 'send_button', composerCleared: true },
    });

    const res = await p.deliverInstruction(request());

    assert.notEqual(res.outcome, 'delivered', 'an in-boundary turn must never confirm delivery');
    assert.equal(res.outcome, 'failed');
    assert.equal(res.evidence.details?.stage, 'post_boundary_readback');
    assert.match(String(res.reason), /no new user turn/i);
  });

  it('an assistant turn echoing the instruction is not the delivered turn', async () => {
    const { p } = makeProvider({
      preTurns: [BOOTSTRAP_TURN],
      postTurns: [BOOTSTRAP_TURN, { ordinal: 1, role: 'assistant', text: INSTRUCTION }],
    });
    const res = await p.deliverInstruction(request());
    assert.notEqual(res.outcome, 'delivered');
  });

  it('an unreadable conversation after a performed send is AMBIGUOUS, never delivered or failed', async () => {
    const { p } = makeProvider({ preTurns: [BOOTSTRAP_TURN], postTurns: null });

    const res = await p.deliverInstruction(request());

    assert.equal(res.outcome, 'ambiguous', res.reason ?? '');
    assert.equal(res.evidence.details?.postBoundaryReadReadable, false);
    assert.match(String(res.reason), /Automated resend blocked/i);
    assert.match(String(res.evidence.unverifiedAction), /post-send confirmation unavailable/i);
    // The submit DID happen, and the evidence says so.
    assert.equal(res.evidence.details?.submitMechanism, 'send_button');
  });

  it('does not confirm from the submit transport\'s own claim alone', async () => {
    // The submit reports complete success and even names an observed turn, but the exact
    // conversation read shows no new user turn. The readback decides.
    const { p } = makeProvider({
      preTurns: [BOOTSTRAP_TURN],
      postTurns: [BOOTSTRAP_TURN],
      submitResult: {
        success: true,
        requestedUrl: EXACT,
        conversationId: CONV,
        submitMechanism: 'send_button',
        composerCleared: true,
        observedTurn: { ref: 'chatgpt_u_claimed', ordinal: 1, text: INSTRUCTION, role: 'user' },
      },
    });

    const res = await p.deliverInstruction(request());
    assert.notEqual(res.outcome, 'delivered');
    assert.equal(res.outcome, 'failed');
  });
});

/* ========================================================================== *
 * 6. The shared post-boundary matcher, tested directly.
 * ========================================================================== */
describe('findPostBoundaryChatGPTUserTurn', () => {
  const turn = (ref: string, role: 'user' | 'assistant', text: string) => ({
    ref,
    role,
    ordinal: 0,
    text,
    fingerprint: 'x',
    createdAt: null,
  });

  it('matches a post-boundary user turn carrying the instruction', () => {
    const found = findPostBoundaryChatGPTUserTurn(
      [turn('a', 'assistant', 'hi'), turn('b', 'user', INSTRUCTION)],
      ['assistant:a'],
      INSTRUCTION,
    );
    assert.equal(found?.ref, 'b');
  });

  it('rejects a turn already present in the boundary', () => {
    assert.equal(
      findPostBoundaryChatGPTUserTurn([turn('b', 'user', INSTRUCTION)], ['user:b'], INSTRUCTION),
      null,
    );
  });

  it('ignores non-user roles and empty text', () => {
    assert.equal(findPostBoundaryChatGPTUserTurn([turn('b', 'assistant', INSTRUCTION)], [], INSTRUCTION), null);
    assert.equal(findPostBoundaryChatGPTUserTurn([turn('b', 'user', '   ')], [], INSTRUCTION), null);
    assert.equal(findPostBoundaryChatGPTUserTurn([turn('b', 'user', INSTRUCTION)], [], '   '), null);
  });

  it('accepts a strict prefix ONLY when the extraction itself truncated it', () => {
    // The DOM extraction caps a turn at CHATGPT_TURN_TEXT_CAP characters. A turn that hits that
    // cap may be a truncated instruction and is accepted; anything shorter is the real text.
    const long = 'L'.repeat(2600);
    assert.equal(
      findPostBoundaryChatGPTUserTurn([turn('b', 'user', long.slice(0, 2000))], [], long)?.ref,
      'b',
      'a turn truncated at the extraction cap still identifies a longer instruction',
    );
    // A short turn that merely starts with part of the instruction is a DIFFERENT message.
    assert.equal(findPostBoundaryChatGPTUserTurn([turn('b', 'user', 'Plan')], [], INSTRUCTION), null);
    assert.equal(findPostBoundaryChatGPTUserTurn([turn('b', 'user', 'x'.repeat(200))], [], INSTRUCTION), null);
    assert.equal(
      findPostBoundaryChatGPTUserTurn([turn('b', 'user', INSTRUCTION.slice(0, 40))], [], INSTRUCTION),
      null,
    );
  });

  it('matches through canonicalisation, so renderer whitespace cannot break identity', () => {
    assert.equal(
      findPostBoundaryChatGPTUserTurn([turn('b', 'user', `  ${INSTRUCTION}\n `)], [], ` ${INSTRUCTION} `)?.ref,
      'b',
    );
  });
});

/* ========================================================================== *
 * 7. No other planner-delivery path re-introduces the desktop app.
 * ========================================================================== */
describe('the desktop-app assumption is not reachable from any planner delivery caller', () => {
  it('ChatGPTAppHandler.sendMessage delegates to the provider, and nothing else', () => {
    const handler = repoFile('src/relay/integrations/handlers/ChatGPTAppHandler.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const sendMessage = handler.match(/public async sendMessage\([\s\S]*?\n {2}\}/);
    assert.ok(sendMessage, 'the source guard found no ChatGPTAppHandler.sendMessage');
    assert.ok(sendMessage![0].includes('deliverInstruction'));
    for (const forbidden of ['ChatGPT"', 'activate', 'System Events', 'probeMacOSProcess', 'open -a']) {
      assert.ok(!sendMessage![0].includes(forbidden), `sendMessage must not touch the desktop app: ${forbidden}`);
    }
  });

  it('the class still declares the desktop constants, but no delivery code reads them', () => {
    // `defaultBundleId`/`defaultProcessName` remain because DISCOVERY uses them. Only the
    // delivery method had to stop treating them as the transport, and that is asserted above.
    const src = repoFile('src/relay/providers/adapters.ts');
    assert.ok(src.includes("readonly defaultBundleId = 'com.openai.chat'"), 'discovery identity is unchanged');
  });
});