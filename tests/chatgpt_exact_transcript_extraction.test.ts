import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatGPTProvider,
  composeChatGPTConversationReadScript,
  canonicalizeChatGPTMessageText,
} from '../src/relay/providers/adapters.ts';
import {
  classifyExactSessionCapabilityRoute,
  identityDimensionsForCapabilityRoute,
} from '../src/relay/domain/types.ts';

/**
 * ChatGPT mounts TWO complete [data-thread-find-target="conversation"] roots for the same
 * conversation (MEASURED live): one DETACHED (rect 0x0, offsetParent null, its scroll
 * container scrollHeight 0) and one AUTHORITATIVE (rect 640x776, offsetParent set). Both carry
 * the identical data-turn-key UUIDs.
 *
 * So duplicate renders are identified STRUCTURALLY (rendered vs detached root), never by
 * comparing message text -- which is unsafe, because the same logical turn was measured
 * rendering as ".✅" in one copy and ". ✅" in another.
 */

interface N {
  cls: string; attrs: Record<string, string>; text: string; kids: N[];
  parent?: N; element?: any; rendered?: boolean; tagName?: string;
}
function node(cls: string, attrs: Record<string, string>, text: string, kids: N[] = []): N {
  const nd: N = { cls, attrs, text, kids };
  for (const k of kids) k.parent = nd;
  return nd;
}
const ROOT_ATTR = { 'data-thread-find-target': 'conversation' };
/** A user message block, carrying the provider-owned turn key. */
function userMsg(text: string, turnKey?: string): N {
  const attrs: Record<string, string> = { 'data-user-message-bubble': 'true' };
  const bubble = node('bg-user-message text-user-message', attrs, text);
  const block = node('block-BQZwFn', turnKey ? { 'data-turn-key': turnKey } : {}, '', [
    node('sr-only', {}, 'You said:\n'), bubble,
  ]);
  return block;
}
/** An assistant message block. */
function asstMsg(text: string, turnKey?: string): N {
  return node('block-BQZwFn', turnKey ? { 'data-turn-key': turnKey } : {}, '', [
    node('sr-only', {}, 'ChatGPT said:\n\n'), node('prose', {}, text),
  ]);
}
/** One provider turn grouping: a user+assistant pair. */
function pair(searchKey: string, kids: N[]): N {
  return node('', { 'data-content-search-turn-key': searchKey }, '', kids);
}
/** A date divider: its whole text is the <time datetime> it renders. */
function dateDivider(label: string): N {
  const t = node('', { datetime: '2026-10-04T01:11:31.683Z' }, label);
  t.tagName = 'TIME';
  return node('block-Ddiv', {}, '', [t]);
}
function conversationRoot(pairs: N[], rendered: boolean): N {
  const r = node('flex min-h-full flex-1 flex-col', ROOT_ATTR, '', pairs);
  r.rendered = rendered;
  return r;
}
function body(...roots: N[]): N {
  return node('body-root', {}, '', roots);
}

function installDom(roots: N[]) {
  const all: N[] = [];
  (function walk(ns: N[]) { for (const x of ns) { all.push(x); walk(x.kids); } })(roots);
  const innerTextOf = (nd: N): string =>
    [nd.text, ...nd.kids.map(innerTextOf)].filter(Boolean).join(' ');
  for (const nd of all) {
    const el: any = { className: nd.cls, tagName: nd.tagName ?? 'DIV', getAttribute: (a: string) => (a in nd.attrs ? nd.attrs[a] : null) };
    Object.defineProperty(el, 'innerText', { get: () => innerTextOf(nd), configurable: true });
    nd.element = el;
  }
  const under = (node: N, a: N): boolean => { let p = node.parent; while (p) { if (p === a) return true; p = p.parent; } return false; };
  for (const nd of all) {
    const rendered = nd.rendered === true;
    nd.element.children = nd.kids.map((k) => k.element);
    nd.element.parentElement = nd.parent ? nd.parent.element : null;
    nd.element.contains = (o: any) => all.some((c) => c.element === o && under(c, nd));
    nd.element.offsetParent = rendered ? { className: 'offsetParent' } : null;
    nd.element.getBoundingClientRect = () =>
      rendered ? { top: 52, left: 0, width: 640, height: 776 } : { top: 0, left: 0, width: 0, height: 0 };
    nd.element.querySelectorAll = (sel: string) => all.filter((c) => under(c, nd) && matchStub(c, sel)).map((c) => c.element);
    nd.element.querySelector = (sel: string) => nd.element.querySelectorAll(sel)[0] ?? null;
  }
  const document: any = {
    querySelector: (sel: string) => all.find((nd) => matchStub(nd, sel))?.element ?? null,
    querySelectorAll: (sel: string) => all.filter((nd) => matchStub(nd, sel)).map((nd) => nd.element),
  };
  (globalThis as any).document = document;
  return all;
}
function matchStub(nd: N, sel: string): boolean {
  if (sel === '[data-user-message-bubble]') return 'data-user-message-bubble' in nd.attrs;
  if (sel === '[class*="bg-user-message"]') return nd.cls.includes('bg-user-message');
  if (sel === '[class*="block-"]') return nd.cls.includes('block-');
  const tagAttr = sel.match(/^([a-zA-Z][a-zA-Z0-9]*)?\[([a-zA-Z-]+)\]$/);
  if (tagAttr) {
    if (tagAttr[1] && String(nd.tagName ?? 'DIV').toLowerCase() !== tagAttr[1].toLowerCase()) return false;
    return tagAttr[2] in nd.attrs;
  }
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const body = sel.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq === -1) return body in nd.attrs;
    const name = body.slice(0, eq);
    const want = body.slice(eq + 1).replace(/^["']|["']$/g, '');
    return nd.attrs[name] === want;
  }
  return false;
}
function runRead(roots: N[]): any {
  installDom(roots);
  const out = (0, eval)(composeChatGPTConversationReadScript());
  delete (globalThis as any).document;
  return JSON.parse(out as unknown as string);
}

const BOOT = '[RelayX Provisioning] Planner session initialized';
const DOM3 = 'RELAY_BOUNDARY_LIVE_PROOF_1791090345';
const TURN = 'bf91d62b-e638-4bae-be6e-214f8a10e71d';
const DOM3_TURN = '10fe6f0b-8278-4be0-9ead-06cf698f43c9';

/** The authoritative conversation: 3 turn groups, 6 messages. */
function authoritative(): N {
  return conversationRoot([
    pair('fallback-turn-0', [userMsg(BOOT + ' ✅', TURN), asstMsg('ready')]),
    pair('fallback-turn-1', [userMsg('RELAY_BOUNDARY_LIVE_PROOF_1791090240'), asstMsg('Received: 240')]),
    pair('fallback-turn-2', [userMsg(DOM3, DOM3_TURN), asstMsg('Received: ' + DOM3)]),
  ], true);
}
/** The detached mirror of the same conversation: identical turn keys, differing text. */
function mirror(): N {
  return conversationRoot([
    pair('fallback-turn-0', [userMsg(BOOT + '✅', TURN), asstMsg('ready')]),
    pair('fallback-turn-1', [userMsg('RELAY_BOUNDARY_LIVE_PROOF_1791090240'), asstMsg('Received: 240')]),
    pair('fallback-turn-2', [userMsg(DOM3, DOM3_TURN), asstMsg('Received: ' + DOM3)]),
  ], false);
}
function dom(...roots: N[]): N[] { return [body(...roots)]; }

describe('structural authoritative-root selection', () => {
  it('1. the RENDERED conversation root is selected, not the detached mirror', () => {
    const r = runRead(dom(authoritative(), mirror()));
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'authoritative_root');
    assert.equal(r.candidateRootCount, 2);
    assert.equal(r.ignoredMirrorRootCount, 1);
    assert.equal(r.turnCount, 6);
  });

  it('2. mirror text never influences the result (".✅" vs ". ✅" is irrelevant)', () => {
    // The authoritative copy has the space, the mirror does not. Selection is structural, so
    // the extracted text comes from the authoritative copy either way.
    const r = runRead(dom(authoritative(), mirror()));
    assert.ok(r.turns[0].text.endsWith(' ✅'), 'authoritative copy carries the space: ' + JSON.stringify(r.turns[0].text.slice(-12)));
    assert.equal(r.turnCount, 6, 'a text-differing mirror must not change the count');
  });

  it('6/8. repeated extraction is byte-stable regardless of mirror presence or order', () => {
    const shapes = [
      dom(authoritative()),
      dom(mirror(), authoritative()),
      dom(authoritative(), mirror()),
      dom(mirror(), mirror(), authoritative()),
    ];
    const sigs = shapes.map((s) => JSON.stringify(runRead(s).turns));
    assert.equal(new Set(sigs).size, 1, 'mirror count/order must not affect the transcript');
  });

  it('3. an entirely detached tree is NOT readable (never "zero turns")', () => {
    const r = runRead(dom(mirror()));
    assert.equal(r.ok, false);
    assert.equal(r.readable, false);
    assert.match(r.reason, /detached/);
    assert.equal(r.turns, undefined);
  });

  it('4. no conversation root at all is NOT readable', () => {
    const r = runRead([body(node('x', {}, 'nothing here'))]);
    assert.equal(r.ok, false);
    assert.equal(r.readable, false);
  });

  it('5. several RENDERED roots resolve deterministically (most turn keys wins)', () => {
    const small = conversationRoot([pair('s', [userMsg('a')])], true);
    const r = runRead(dom(small, authoritative()));
    assert.equal(r.turnCount, 6, 'the root with more provider-identified turns wins');
  });

  it('7. DOM3 is exactly one logical user turn with a stable structural ref', () => {
    const r = runRead(dom(authoritative(), mirror()));
    const d3 = r.turns.filter((t: any) => t.role === 'user' && t.text === DOM3);
    assert.equal(d3.length, 1);
    assert.equal(d3[0].ordinal, 4);
    assert.equal(d3[0].turnKey, DOM3_TURN);
  });

  it('date dividers are NOT read as assistant messages (structural, not length-based)', () => {
    const r = runRead(dom(conversationRoot([
      pair('fallback-turn-0', [dateDivider('Today 10:11 AM'), userMsg(BOOT, TURN), asstMsg('ready')]),
      pair('fallback-turn-1', [dateDivider('Today 2:04 PM'), userMsg(DOM3, DOM3_TURN), asstMsg('Received: ' + DOM3)]),
    ], true)));
    assert.equal(r.turnCount, 4, '2 dividers + 2 messages per group must not count as messages');
    assert.deepEqual(r.turns.map((t: any) => t.role), ['user', 'assistant', 'user', 'assistant']);
    assert.ok(!r.turns.some((t: any) => /Today/.test(t.text)), 'no divider text may appear as a turn');
    // A short but REAL assistant message must still be kept: the rule keys on the <time>
    // element matching the whole block text, not on brevity.
    assert.ok(r.turns.some((t: any) => t.text === 'ready'));
  });

  it('assistant and user with identical text stay distinct (role + turn key)', () => {
    const r = runRead(dom(conversationRoot([pair('p', [userMsg(DOM3, DOM3_TURN), asstMsg(DOM3, DOM3_TURN)])], true)));
    assert.equal(r.turnCount, 2);
    assert.equal(r.turns[0].role, 'user');
    assert.equal(r.turns[1].role, 'assistant');
  });

  it('two genuine same-text user turns in one conversation stay separate', () => {
    const r = runRead(dom(conversationRoot([
      pair('p1', [userMsg('repeat me', 'key-a'), asstMsg('ok')]),
      pair('p2', [userMsg('repeat me', 'key-b'), asstMsg('ok')]),
    ], true)));
    assert.equal(r.turnCount, 4);
    assert.deepEqual(r.turns.filter((t: any) => t.role === 'user').map((t: any) => t.turnKey), ['key-a', 'key-b']);
  });
});

describe('canonicalisation stays conservative', () => {
  it('CRLF, NFC and presentation whitespace only', () => {
    assert.equal(canonicalizeChatGPTMessageText('a\r\n\r\n b  '), 'a b');
    assert.equal(canonicalizeChatGPTMessageText('caf\u0065\u0301'), 'caf\u00e9');
  });
  it('does NOT fold emoji-adjacent space, punctuation or case', () => {
    assert.notEqual(canonicalizeChatGPTMessageText('done.\u2705'), canonicalizeChatGPTMessageText('done. \u2705'));
    assert.equal(canonicalizeChatGPTMessageText('Deploy API v2 -- URGENT'), 'Deploy API v2 -- URGENT');
    assert.notEqual(canonicalizeChatGPTMessageText('do it'), canonicalizeChatGPTMessageText('do it!'));
  });
  it('removes no all-whitespace text', () => {
    assert.equal(canonicalizeChatGPTMessageText('a b'), 'a b');
    assert.notEqual(canonicalizeChatGPTMessageText('ab'), canonicalizeChatGPTMessageText('a b'));
  });
});

describe('boundary uses the same structural extraction', () => {
  function providerOverDom(roots: N[]) {
    const p = new ChatGPTProvider() as any;
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 85437176, tabId: 85437179 });
    p.verifyHandleExists = () => true;
    p.sleep = async () => {};
    p.readHandleUrl = () => 'https://chatgpt.com/c/6ac1a7c4-7b40-83ec-ba40-86180675f217';
    p.executeHandleJavaScript = (_h: unknown, js: string) => {
      installDom(roots);
      const out = (0, eval)(js);
      delete (globalThis as any).document;
      return { success: true, output: String(out) };
    };
    return p;
  }
  const EXT = '6ac1a7c4-7b40-83ec-ba40-86180675f217';

  it('9/10. repeated boundary capture is deterministic and mirror-independent', async () => {
    const shapes = [dom(authoritative()), dom(authoritative(), mirror()), dom(mirror(), authoritative())];
    const runs = [];
    for (const s of shapes) runs.push(await providerOverDom(s).captureTransportBoundary({ externalSessionId: EXT }));
    const sigs = runs.map((r) => JSON.stringify([r.watermark.messageCount, r.watermark.messageIds, r.watermark.provenance, r.watermark.latestCreatedAt]));
    assert.equal(new Set(sigs).size, 1, 'watermark must not depend on the mirror');
    assert.equal(runs[0].watermark.messageCount, 6);
    assert.equal(runs[0].watermark.provenance, 'captured_pre_dispatch');
    assert.equal(runs[0].watermark.latestCreatedAt, null);
    // Structural ids, not text hashes.
    assert.ok(runs[0].watermark.messageIds.includes(`user:chatgpt_u_${DOM3_TURN}`));
  });

  it('an unreadable extraction yields a NULL watermark, never an empty one', async () => {
    const r = await providerOverDom(dom(mirror())).captureTransportBoundary({ externalSessionId: EXT });
    assert.equal(r.watermark, null);
    assert.match(r.failure, /EXACT-SESSION-UNREADABLE/);
  });
});

describe('ChatGPT exact-session capability classification', () => {
  it('no longer LEVEL-0 when observation methods exist', () => {
    assert.equal(
      classifyExactSessionCapabilityRoute({ captureTransportBoundary: () => {}, readExactSessionTurnsForReconciliation: () => {} }),
      'dom_observation',
    );
    const d = identityDimensionsForCapabilityRoute('dom_observation');
    assert.equal(d.capability, 'exact_session_verifiable');
    assert.equal(d.sourceCapability, 'exact_session_dom_observation');
  });
  it('a genuinely incapable provider is still permanent LEVEL 0', () => {
    assert.equal(classifyExactSessionCapabilityRoute({}), 'none');
    assert.equal(identityDimensionsForCapabilityRoute('none').capability, 'not_verifiable');
  });
  it('capability presence alone never promotes identity', () => {
    assert.deepEqual(Object.keys(identityDimensionsForCapabilityRoute('dom_observation')).sort(), ['capability', 'sourceCapability']);
  });
});
