import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTProvider } from '../src/relay/providers/adapters.ts';

const CONV = '6ac1a7c4-7b40-83ec-ba40-86180675f217';
const EXACT = `https://chatgpt.com/g/g-p-6ac1a6bf6bcc8191a4bc405b1274b54a-relay-fresh-project-a/c/${CONV}`;
const HANDLE = { windowId: 85437176, tabId: 85437179 };
const MARKER = 'RELAY_BOUNDARY_LIVE_PROOF_123';

/** Provider with the Chrome/handle surface fully stubbed; JS executor is script-matched. */
function make(over: {
  handleUrl?: string | null;
  editorResolve?: any;
  editorType?: any;
  submitOut?: string;
  postTurns?: Array<{ ref: string; role: string; ordinal: number; text: string }>;
  readFails?: boolean;
} = {}) {
  const p = new ChatGPTProvider() as any;
  const seen: string[] = [];
  p.readHandleUrl = () => (over.handleUrl === undefined ? EXACT : over.handleUrl);
  p.sleep = async () => {};
  p.executeHandleJavaScript = (_h: any, js: string) => {
    seen.push(js);
    if (js.includes('SELS')) {
      return { success: true, output: JSON.stringify(over.editorResolve ?? { ok: true, selector: '.ProseMirror', tag: 'DIV', cls: 'ProseMirror', rejects: [] }) };
    }
    if (js.includes('editorText') || js.includes('insertText')) {
      return { success: true, output: JSON.stringify(over.editorType ?? { ok: true, selector: '.ProseMirror', editorText: MARKER }) };
    }
    if (js.includes('send_button') || js.includes('send-button')) {
      return { success: true, output: over.submitOut ?? 'send_button' };
    }
    if (js.includes('userTurns') || js.includes("=== 'user'")) {
      const n = over.handleUrl === null ? -1 : 1;
      return { success: true, output: String(n) };
    }
    return { success: true, output: '' };
  };
  // The live layout has no [data-message-author-role]; the proven user bubble is
  // div.bg-user-message.text-user-message, which readExactUserTurns selects.
  p.readExactUserTurns = async () =>
    over.readFails
      ? { ok: false, turns: [] }
      : { ok: true, selector: '[class*="bg-user-message"]', turns: over.postTurns ?? [] };
  return { p, seen };
}

describe('strict exact-session turn submit', () => {
  it('1. rejects a composer wrapper that merely contains the model picker', async () => {
    const { p } = make({ editorResolve: { ok: false, reason: 'no real editable composer node found', rejects: ['div.ComposerLayoutRoot-XCKS7O', 'wrapper-with-editable-descendant'] } });
    const r = await p.submitExactSessionTurn(HANDLE, EXACT, CONV, MARKER);
    assert.equal(r.success, false);
    assert.match(String(r.reason), /No real editable composer/i);
    assert.match(String(r.reason), /ComposerLayoutRoot/, 'the High-wrapper must be named in the rejection');
  });

  it('2/4. a missing editor is a failure, never a submit attempt', async () => {
    const { p } = make({ editorResolve: { ok: false, reason: 'none', rejects: [] } });
    const r = await p.submitExactSessionTurn(HANDLE, EXACT, CONV, MARKER);
    assert.equal(r.success, false);
    assert.doesNotMatch(String(r.reason), /submit/i);
  });

  it('3. refuses to submit when the editor read-back lacks the marker', async () => {
    const { p, seen } = make({ editorType: { ok: true, selector: '.ProseMirror', editorText: 'High' } });
    const r = await p.submitExactSessionTurn(HANDLE, EXACT, CONV, MARKER);
    assert.equal(r.success, false);
    assert.match(String(r.reason), /did not contain the marker/i);
    assert.ok(!seen.some((js) => js.includes('send_button')), 'submit must NOT be attempted');
  });

  it('7. a handle pointing at a different conversation is rejected up front', async () => {
    const { p } = make({ handleUrl: 'https://chatgpt.com/g/g-p-other/c/some-other-conversation' });
    const r = await p.submitExactSessionTurn(HANDLE, EXACT, CONV, MARKER);
    assert.equal(r.success, false);
    assert.match(String(r.reason), /not the exact conversation/i);
  });

  it('5. submit executed but no new user turn => FAILURE (composer clearing is not success)', async () => {
    const { p } = make({ postTurns: [] });
    const r = await p.submitExactSessionTurn(HANDLE, EXACT, CONV, MARKER);
    assert.equal(r.success, false);
    assert.match(String(r.reason), /NO new user turn/i);
  });

  it('5b. an old turn WITHOUT the marker does not count as the new turn', async () => {
    const { p } = make({ postTurns: [{ ref: 'm1', role: 'user', ordinal: 0, text: '[RelayX Provisioning] Planner session initialized' }] });
    const r = await p.submitExactSessionTurn(HANDLE, EXACT, CONV, MARKER);
    assert.equal(r.success, false);
  });

  it('6/8. a new user turn containing the marker yields success WITH turn evidence', async () => {
    const { p } = make({ postTurns: [
      { ref: 'm1', role: 'user', ordinal: 0, text: '[RelayX Provisioning] Planner session initialized' },
      { ref: 'm2', role: 'assistant', ordinal: 1, text: 'ready' },
      { ref: 'm3', role: 'user', ordinal: 2, text: MARKER },
    ] });
    const r = await p.submitExactSessionTurn(HANDLE, EXACT, CONV, MARKER);
    assert.equal(r.success, true);
    assert.equal(r.observedTurn?.ref, 'm3');
    assert.equal(r.observedTurn?.role, 'user');
    assert.ok(r.observedTurn?.text.includes(MARKER));
    assert.ok(r.editorSelectorUsed);
    assert.ok(['send_button', 'enter_key'].includes(String(r.submitMechanism)));
  });

  it('8b. an assistant turn echoing the marker is not accepted as the submitted user turn', async () => {
    const { p } = make({ postTurns: [{ ref: 'm9', role: 'assistant', ordinal: 1, text: MARKER }] });
    const r = await p.submitExactSessionTurn(HANDLE, EXACT, CONV, MARKER);
    assert.equal(r.success, false);
  });

  it('a failed transcript read during polling stays a failure', async () => {
    const { p } = make({ readFails: true });
    const r = await p.submitExactSessionTurn(HANDLE, EXACT, CONV, MARKER);
    assert.equal(r.success, false);
  });

  it('success carries the diagnostics proving every gate ran', async () => {
    const { p } = make({ postTurns: [{ ref: 'm3', role: 'user', ordinal: 2, text: MARKER }] });
    const r = await p.submitExactSessionTurn(HANDLE, EXACT, CONV, MARKER);
    const d = (r.diagnostics ?? []).join(' | ');
    assert.match(d, /gate:handle-url/);
    assert.match(d, /gate:editor-ok/);
    assert.match(d, /gate:readback-ok/);
    assert.match(d, /gate:submit/);
    assert.match(d, /gate:verified/);
  });
});
