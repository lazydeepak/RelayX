import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeJavaScriptForAppleScript,
  appleScriptJsEvalWrapper,
  escapeAppleScriptStringLiteral,
} from '../src/relay/providers/adapters.ts';

/**
 * REGRESSION GUARD — page-JavaScript transport through AppleScript.
 *
 * Proven corruption: escapeAppleScriptStringLiteral rewrote REAL newlines into the two
 * characters `\n`. Those land inside the JavaScript source between statements, where a
 * bare `\n` is a SyntaxError. Quote/backslash string literals were rewritten too. Small
 * single-line probes worked, masking the fault as a composer/selector bug.
 *
 * The transport now carries ONLY Base64, which has no quotes, backslashes or newlines.
 */

/** Simulate the page side: decode the payload and evaluate it. */
function evaluateInPage(wrapper: string): { value?: any; jsError?: string } {
  const b64 = wrapper.match(/atob\("([A-Za-z0-9+/=]+)"\)/)![1];
  const source = Buffer.from(b64, 'base64').toString('utf8');
  try {
    const r = (0, eval)(source);
    return { value: typeof r === 'string' ? r : JSON.parse(JSON.stringify(r === undefined ? null : r)) };
  } catch (e: any) {
    return { jsError: `${e.name}: ${e.message}` };
  }
}

const CANARY = `(function () {
  var o = {
    sq: 'it\\'s a "double" and a backslash \\\\',
    jsonLiteral: '{"a":1,"b":[true,null]}',
    uni: 'caf\\u00e9 \\u2014 \\u65e5\\u672c',
    multi: 'line1\\nline2',
    tabbed: 'a\\tb'
  };
  return JSON.stringify(o);
})()`;

describe('JavaScript transport integrity', () => {
  it('1/2/3/4/5. quote-heavy, backslash, multiline, JSON and unicode source survives unchanged', () => {
    const wrapper = appleScriptJsEvalWrapper(encodeJavaScriptForAppleScript(CANARY));
    // The wrapper must contain no source-derived quoting hazards at all.
    assert.doesNotMatch(wrapper.slice(wrapper.indexOf('atob("') + 6, wrapper.indexOf('")')), /["\\\n]/);
    const r = evaluateInPage(wrapper);
    assert.equal(r.jsError, undefined, 'canary must not be a SyntaxError: ' + r.jsError);
    const o = JSON.parse(r.value);
    assert.equal(o.sq, 'it\'s a "double" and a backslash \\');
    assert.equal(o.jsonLiteral, '{"a":1,"b":[true,null]}');
    assert.equal(o.uni, 'café — 日本');
    assert.equal(o.multi, 'line1\nline2');
    assert.equal(o.tabbed, 'a\tb');
  });

  it('6. structured results, primitives, arrays, null and booleans are preserved', () => {
    const cases: Array<[string, any]> = [
      ['42', 42],
      ['"hello"', 'hello'],
      ['true', true],
      ['false', false],
      ['null', null],
      ['[1,2,3]', [1, 2, 3]],
      ['({a:1})', { a: 1 }],
    ];
    for (const [expr, expected] of cases) {
      const wrapper = appleScriptJsEvalWrapper(encodeJavaScriptForAppleScript(expr));
      const r = evaluateInPage(wrapper);
      assert.equal(r.jsError, undefined, `${expr} -> ${r.jsError}`);
      assert.deepEqual(r.value, expected, `round-trip failed for ${expr}`);
    }
  });

  it('7. a JavaScript runtime error is distinguishable, not coerced into a value', () => {
    const wrapper = appleScriptJsEvalWrapper(encodeJavaScriptForAppleScript('throw new TypeError("boom")'));
    const r = evaluateInPage(wrapper);
    assert.match(String(r.jsError), /TypeError: boom/);
  });

  it('7b. a SyntaxError in the page source surfaces as a syntax error (the old failure mode)', () => {
    const wrapper = appleScriptJsEvalWrapper(encodeJavaScriptForAppleScript('(function(){\nvar a = ;\n})()'));
    const r = evaluateInPage(wrapper);
    assert.match(String(r.jsError), /SyntaxError/);
  });

  it('8. the legacy escaper is provably lossy for newlines (documents why it was replaced)', () => {
    const escaped = escapeAppleScriptStringLiteral('var a = 1;\nvar b = 2;');
    assert.ok(escaped.includes('\\n'), 'newlines become literal backslash-n');
    assert.ok(!escaped.includes('\n'), 'no real newline survives -> statements merge into one line');
  });

  it('9. exact-session handle targeting is unchanged (wrapper only decodes/evaluates)', () => {
    const wrapper = appleScriptJsEvalWrapper(encodeJavaScriptForAppleScript('1+1'));
    assert.match(wrapper, /^\(function\(\)\{try\{var b=atob\(/);
    assert.match(wrapper, /\}\}\)\(\)$/);
  });
});
