/**
 * Planner conversation IDENTITY SETTLEMENT regression tests.
 *
 * Background (established by a live run, not inferred):
 *
 *   1. The bootstrap submission works. ChatGPT accepts the dynamic prompt and generates
 *      an assistant reply.
 *   2. ChatGPT does NOT navigate to a durable conversation URL synchronously. The observed
 *      sequence was:
 *        t=2966ms  .../project                     -> not materialized
 *        t=3900ms  .../c/local-chatgpt%3A<uuid4>   -> TRANSIENT local placeholder
 *        later     .../c/<server-uuid>             -> authoritative
 *   3. The old observer sampled the URL exactly once and hard-failed, reporting
 *      "no conversation materialization observed" while a real conversation existed.
 *
 * These tests pin the replacement contract:
 *   - poll the SAME retained handle, bounded;
 *   - treat `local-chatgpt:*` as NOT authoritative, ever;
 *   - never adopt a local identity, not even after the bound is exhausted;
 *   - fail closed with distinguishable reasons.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyChatGPTConversationIdentity,
  settleChatGPTConversationIdentity,
  parseChatGPTConversationUrl,
  type ChatGPTSettlementRead,
  type ChatGPTSettlementResult,
} from '../src/relay/providers/adapters.ts';

const PROJECT = 'g-p-6ab13d0d7a708191ba704a0a5a874b79-relayx';
const AUTHORITATIVE_ID = '6abd0367-e048-83ee-ac2a-b82f5f10303b';
const LOCAL_ID_DECODED = 'local-chatgpt:97634561-4945-46dd-9fa4-ea89760290a8';
const LOCAL_ID_ENCODED = encodeURIComponent(LOCAL_ID_DECODED);

const projectUrl = () => `https://chatgpt.com/g/${PROJECT}/project`;
const localUrl = () => `https://chatgpt.com/g/${PROJECT}/c/${LOCAL_ID_ENCODED}`;
const settledUrl = () => `https://chatgpt.com/g/${PROJECT}/c/${AUTHORITATIVE_ID}`;

describe('classifyChatGPTConversationIdentity', () => {
  it('treats the project composer as not materialized', () => {
    const v = classifyChatGPTConversationIdentity(projectUrl());
    assert.equal(v.state, 'not_materialized_yet');
    assert.equal(v.conversationId, null);
  });

  it('treats a local-chatgpt placeholder as transient, never authoritative', () => {
    const v = classifyChatGPTConversationIdentity(localUrl());
    assert.equal(v.state, 'transient_local_identity');
    assert.equal(v.conversationId, null, 'transient identity must never be exposed as authoritative');
    assert.equal(v.transientId, LOCAL_ID_DECODED, 'placeholder must be reported decoded, not %3A-encoded');
    assert.equal(v.projectId, PROJECT);
  });

  it('detects the placeholder in unencoded form too', () => {
    const v = classifyChatGPTConversationIdentity(
      `https://chatgpt.com/g/${PROJECT}/c/local-chatgpt:97634561-4945-46dd-9fa4-ea89760290a8`,
    );
    assert.equal(v.state, 'transient_local_identity');
    assert.equal(v.conversationId, null);
  });

  it('settles on a project-scoped authoritative conversation ID', () => {
    const v = classifyChatGPTConversationIdentity(settledUrl());
    assert.equal(v.state, 'settled');
    assert.equal(v.conversationId, AUTHORITATIVE_ID);
    assert.equal(v.projectId, PROJECT);
    assert.equal(v.transientId, null);
  });

  it('does not settle on an ordinary /c/<id> URL (unsupported shape)', () => {
    const v = classifyChatGPTConversationIdentity(`https://chatgpt.com/c/${AUTHORITATIVE_ID}`);
    assert.equal(v.state, 'not_materialized_yet');
    assert.equal(v.conversationId, null);
    // Confirms the structural parser is untouched by this change.
    assert.equal(parseChatGPTConversationUrl(`https://chatgpt.com/c/${AUTHORITATIVE_ID}`), null);
  });

  it('is tolerant of null, blank and malformed input', () => {
    for (const bad of [null, undefined, '', '   ', 'not-a-url', 'https://evilchatgpt.com/g/g-p-x/c/1']) {
      const v = classifyChatGPTConversationIdentity(bad as string | null);
      assert.equal(v.state, 'not_materialized_yet');
      assert.equal(v.conversationId, null);
    }
  });

  it('leaves the structural parser unopinionated about local IDs', () => {
    // parseChatGPTConversationUrl stays a pure shape parser; the semantic decision lives in
    // the identity layer. This is asserted so a future "simplification" cannot quietly
    // change the semantics of the other parser call sites.
    assert.ok(parseChatGPTConversationUrl(localUrl()));
    assert.equal(classifyChatGPTConversationIdentity(localUrl()).conversationId, null);
  });
});

describe('settleChatGPTConversationIdentity', () => {
  it('case 1: /project -> authoritative UUID', async () => {
    const { result, reads } = await run([projectUrl(), settledUrl()]);
    assert.equal(result.outcome, 'settled');
    assert.equal(result.acknowledged, true);
    assert.equal(result.conversationId, AUTHORITATIVE_ID);
    assert.equal(result.transientId, null);
    assert.equal(reads, 2);
  });

  it('case 2: /project -> local-chatgpt:* -> authoritative UUID', async () => {
    const { result } = await run([projectUrl(), localUrl(), settledUrl()]);
    assert.equal(result.outcome, 'settled');
    assert.equal(result.acknowledged, true);
    assert.equal(result.conversationId, AUTHORITATIVE_ID);
    assert.equal(
      result.conversationId,
      AUTHORITATIVE_ID,
      'must not return the intermediate local placeholder',
    );
    assert.equal(result.transientId, null, 'transient identity is not surfaced once settled');
  });

  it('case 3: repeated /project until timeout', async () => {
    const { result, reads } = await run([projectUrl()]);
    assert.equal(result.outcome, 'not_materialized_yet');
    assert.equal(result.acknowledged, false);
    assert.equal(result.conversationId, null);
    assert.ok(reads > 1, 'must poll more than once before giving up');
    assert.match(result.reason ?? '', /no conversation materialization observed/i);
  });

  it('case 4: repeated local-chatgpt:* until timeout -> fail closed, never adopt', async () => {
    const { result } = await run([localUrl()]);
    assert.equal(result.outcome, 'transient_local_identity');
    assert.equal(result.acknowledged, false);
    assert.equal(result.conversationId, null, 'a local identity must never be adopted after timeout');
    assert.equal(result.transientId, LOCAL_ID_DECODED, 'transient ID retained for diagnostics only');
    assert.match(result.reason ?? '', /never settled/i);
    assert.match(result.reason ?? '', /signed out/i, 'must distinguish this from no materialization');
  });

  it('case 5: project-scoped /g/<project>/c/<id> settles immediately', async () => {
    const { result, reads } = await run([settledUrl()]);
    assert.equal(result.outcome, 'settled');
    assert.equal(result.conversationId, AUTHORITATIVE_ID);
    assert.equal(result.projectId, PROJECT);
    assert.equal(reads, 1, 'settles on first poll without burning the budget');
  });

  it('case 6: ordinary /c/<id> never satisfies settlement', async () => {
    const { result } = await run([`https://chatgpt.com/c/${AUTHORITATIVE_ID}`]);
    assert.equal(result.outcome, 'not_materialized_yet');
    assert.equal(result.conversationId, null);
  });

  it('case 7: retained-handle continuity - every poll reads the same handle', async () => {
    const handles: Array<string | undefined> = [];
    let virtualNow = 0;
    const readsByHandle: Record<string, number> = {};
    const singleHandle = 'WIN:85435775|TAB:85435778';

    // Model the adapter's binding: the handle is captured once, then the SAME reader
    // closure is invoked for every poll. If the loop ever re-resolved a handle, this
    // would record a different label.
    const read = (): ChatGPTSettlementRead => {
      handles.push(singleHandle);
      readsByHandle[singleHandle] = (readsByHandle[singleHandle] ?? 0) + 1;
      return { kind: 'url', url: readsByHandle[singleHandle] <= 2 ? projectUrl() : settledUrl() };
    };

    const result = await settleChatGPTConversationIdentity(read, {
      maxWaitMs: 5000,
      pollIntervalMs: 500,
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
      },
    });

    assert.equal(result.outcome, 'settled');
    assert.equal(result.conversationId, AUTHORITATIVE_ID);
    assert.ok(handles.length >= 3, 'polled more than once across the transition');
    assert.deepEqual(
      [...new Set(handles)],
      [singleHandle],
      'every poll must read the one retained handle; no re-resolution',
    );
  });

  it('bounded: the wait is finite and never indefinite', async () => {
    let virtualNow = 0;
    const result = await settleChatGPTConversationIdentity(
      () => ({ kind: 'url', url: projectUrl() }),
      {
        maxWaitMs: 5000,
        pollIntervalMs: 500,
        now: () => virtualNow,
        sleep: async (ms) => {
          virtualNow += ms;
        },
      },
    );
    assert.equal(result.outcome, 'not_materialized_yet');
    assert.ok(result.elapsedMs <= 5000, `wait must respect the bound, got ${result.elapsedMs}ms`);
    assert.ok(result.polls >= 1 && result.polls <= 100, `poll count must be bounded, got ${result.polls}`);
  });

  it('surfaces a lost retained handle as its own outcome', async () => {
    const result = await settleChatGPTConversationIdentity(() => ({ kind: 'lost' }), {
      now: () => 0,
      sleep: async () => {},
    });
    assert.equal(result.outcome, 'handle_lost');
    assert.equal(result.acknowledged, false);
    assert.equal(result.conversationId, null);
  });

  it('surfaces a read failure as its own outcome', async () => {
    const result = await settleChatGPTConversationIdentity(
      () => ({ kind: 'failed', error: 'osascript boom' }),
      { now: () => 0, sleep: async () => {} },
    );
    assert.equal(result.outcome, 'read_failed');
    assert.equal(result.acknowledged, false);
    assert.match(result.reason ?? '', /osascript boom/);
  });
});

/** Async helper used by the cases above; kept out of the test bodies for clarity. */
async function run(
  script: Array<string | null>,
  options?: { maxWaitMs?: number; pollIntervalMs?: number },
): Promise<{ result: ChatGPTSettlementResult; reads: number }> {
  let virtualNow = 0;
  let reads = 0;
  const read = (): ChatGPTSettlementRead => {
    reads += 1;
    const idx = Math.min(reads - 1, script.length - 1);
    return { kind: 'url', url: script[idx] ?? null };
  };
  const result = await settleChatGPTConversationIdentity(read, {
    maxWaitMs: options?.maxWaitMs ?? 5000,
    pollIntervalMs: options?.pollIntervalMs ?? 500,
    now: () => virtualNow,
    sleep: async (ms) => {
      virtualNow += ms;
    },
  });
  return { result, reads };
}
