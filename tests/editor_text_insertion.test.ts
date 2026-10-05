import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHATGPT_EDITOR_TYPE_JS,
  composeChatGPTEditorTypeScript,
} from '../src/relay/providers/adapters.ts';

/**
 * REGRESSION GUARD for the proven live defect.
 *
 * CHATGPT_EDITOR_TYPE_JS self-invoked and took no parameter, so the caller's
 * `const f = <template>; f(marker)` bound `f` to the template's string result and threw
 *   __JSERR__TypeError: f is not a function
 * The marker never reached insertText. The submit path then correctly refused, but for the
 * wrong reason and with a misleading diagnostic ("ok=false reason=n/a").
 *
 * These tests execute the REAL composed expression against a minimal DOM stub, so the
 * argument can never be silently dropped again.
 */

const MARKER = 'RELAY_BOUNDARY_LIVE_PROOF_1791099999';

/** Minimal DOM stub sufficient to run the typing expression. */
function runInStub(marker: string): { result?: any; thrown?: string; inserted: string[] } {
  const inserted: string[] = [];
  const el: any = {
    tagName: 'DIV',
    innerText: '\n',
    className: 'ProseMirror',
    getAttribute: (k: string) => (k === 'contenteditable' ? 'true' : null),
    querySelector: () => null,
    focus: () => {},
    dispatchEvent: () => true,
  };
  const g: any = {
    document: {
      querySelectorAll: (sel: string) => (sel.includes('contenteditable') ? [el] : []),
      execCommand: (cmd: string, _a: any, b: any) => {
        if (cmd === 'insertText') { inserted.push(b); el.innerText = String(b); return true; }
        if (cmd === 'delete') { el.innerText = ''; return true; }
        return false;
      },
      createRange: () => ({ selectNodeContents: () => {} }),
    },
    window: { getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }) },
    InputEvent: class { constructor(_t: string, o: any) { (this as any).data = o?.data; } },
  };
  const expr = composeChatGPTEditorTypeScript(marker);
  const keys = Object.keys(g);
  const saved = (globalThis as any);
  try {
    keys.forEach((k) => ((globalThis as any)[k] = g[k]));
    const out = (0, eval)(expr);
    return { result: JSON.parse(out), inserted };
  } catch (e: any) {
    return { thrown: `${e.name}: ${e.message}`, inserted };
  } finally {
    keys.forEach((k) => delete (saved as any)[k]);
  }
}

describe('editor text insertion — marker must reach the real editor', () => {
  it('the template is a bare function expression, not a self-invoked IIFE', () => {
    const t = CHATGPT_EDITOR_TYPE_JS.trim();
    assert.ok(t.startsWith('(function (text)'), 'template must be a function expression taking text');
    assert.ok(t.endsWith('})'), 'template must NOT self-invoke');
  });

  it('composing with a marker yields a real invocation, not a call on a string', () => {
    const expr = composeChatGPTEditorTypeScript(MARKER);
    assert.ok(expr.includes(JSON.stringify(MARKER)), 'marker must be passed as an argument');
    assert.doesNotMatch(expr, /const f =/);
  });

  it('1/2. the marker actually reaches insertText and appears in the read-back', () => {
    const r = runInStub(MARKER);
    assert.equal(r.thrown, undefined, 'must not throw: ' + r.thrown);
    assert.deepEqual(r.inserted, [MARKER], 'insertText must receive the exact marker');
    assert.equal(r.result.ok, true);
    assert.equal(r.result.editorText, MARKER);
  });

  it('3. an empty marker is not silently accepted as a successful insertion', () => {
    const r = runInStub('');
    assert.equal(r.thrown, undefined);
    // The caller's read-back gate (marker must be present) is what rejects this; assert the
    // shape so a future caller cannot treat an empty insertion as success.
    assert.ok(!r.result.editorText);
  });

  it('a different marker yields that exact marker (no cross-contamination)', () => {
    const r = runInStub('OTHER_MARKER_XYZ');
    assert.deepEqual(r.inserted, ['OTHER_MARKER_XYZ']);
    assert.equal(r.result.editorText, 'OTHER_MARKER_XYZ');
  });
});
