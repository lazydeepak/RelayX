/**
 * Planner URL legibility in PairView.
 *
 * ## The defect this pins
 *
 * The planner card renders two different identities on adjacent rows — the ChatGPT
 * PROJECT page and the exact SESSION (conversation) page — and they share everything
 * up to the project id:
 *
 *     https://chatgpt.com/g/g-p-6ab13…a874b79/project          <- project
 *     https://chatgpt.com/g/g-p-6ab13…a874b79-relayx/c/6ac3…   <- session
 *
 * Both rows used CSS `truncate`, which cuts the END. In a fixed-width row both
 * therefore rendered as `https://chatgpt.com/g/g-p-6ab13d0d…` and the operator could
 * not tell the conversation row from the project row — the entire distinguishing
 * signal lives in the suffix, which truncation discarded. The session URL *was*
 * rendered; it was unreadable.
 *
 * `elideUrlForDisplay` now keeps the identity segment instead of the tail-of-nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { elideUrlForDisplay } from '../src/components/PairView.tsx';

const pairViewSource = readFileSync(
  new URL('../src/components/PairView.tsx', import.meta.url),
  'utf8',
);

const PROJECT_URL = 'https://chatgpt.com/g/g-p-6ab13d0d7a708191ba704a0a5a874b79/project';
const SESSION_URL =
  'https://chatgpt.com/g/g-p-6ab13d0d7a708191ba704a0a5a874b79-relayx/c/6ac3cbd7-9e4c-83ec-b050-3ec55ebea9b5';

describe('elideUrlForDisplay — keeps what distinguishes the URL', () => {
  it('the two real RelayX planner URLs no longer render identically', () => {
    assert.notStrictEqual(
      elideUrlForDisplay(PROJECT_URL),
      elideUrlForDisplay(SESSION_URL),
      'the project and session rows must be distinguishable at a glance',
    );
  });

  it('the session row keeps its /c/ marker and the full conversation id', () => {
    const out = elideUrlForDisplay(SESSION_URL);
    assert.ok(out.includes('/c/'), 'the conversation marker must survive');
    assert.ok(
      out.includes('6ac3cbd7-9e4c-83ec-b050-3ec55ebea9b5'),
      'the exact conversation id is the identity and must not be elided',
    );
  });

  it('the project row keeps its /project segment', () => {
    assert.ok(
      elideUrlForDisplay(PROJECT_URL).includes('/project'),
      'the project page must stay recognisable as the project page',
    );
  });

  it('a short URL is shown verbatim rather than elided', () => {
    assert.strictEqual(
      elideUrlForDisplay('https://chatgpt.com/c/abc-123'),
      'https://chatgpt.com/c/abc-123',
    );
  });

  it('an over-long conversation id is elided in the middle, never at the end', () => {
    const out = elideUrlForDisplay(`https://chatgpt.com/g/g-p-x/c/${'a'.repeat(80)}`);
    assert.ok(out.includes('/c/'));
    assert.ok(out.includes('…'), 'an over-long id must be shortened');
    assert.ok(out.length <= 56, 'the result must fit the row budget');
  });

  it('a scheme-less or query-bearing URL degrades without throwing', () => {
    assert.strictEqual(elideUrlForDisplay('chatgpt.com/g/p'), 'chatgpt.com/g/p');
    assert.ok(elideUrlForDisplay('https://chatgpt.com/g/p?x=1#y').length > 0);
  });

  it('empty input yields empty output rather than an ellipsis', () => {
    assert.strictEqual(elideUrlForDisplay(''), '');
    assert.strictEqual(elideUrlForDisplay('   '), '');
  });

  it('both planner rows use the elided form while keeping the full URL in title', () => {
    // Elision must be display-only: the authoritative full URL stays available.
    const around = (needle: string, span = 260) =>
      pairViewSource.slice(
        Math.max(0, pairViewSource.indexOf(needle) - 120),
        pairViewSource.indexOf(needle) + span,
      );

    const projectRow = around('ChatGPT project URL:');
    assert.match(projectRow, /title=\{`ChatGPT project URL: \$\{plannerProjectUrl\}`\}/);
    assert.match(projectRow, /elideUrlForDisplay\(plannerProjectUrl\)/);

    const convRow = around('Exact conversation URL:');
    assert.match(convRow, /title=\{`Exact conversation URL: \$\{plannerUrl\}`\}/);
    assert.match(convRow, /elideUrlForDisplay\(plannerUrl\)/);
  });

  it('the full URL is still what Open targets — elision never feeds the opener', () => {
    // The button must keep calling the session-scoped opener, not a rendered string.
    assert.match(pairViewSource, /onOpenPlannerSession\(pair\.plannerSessionId!\)/);
    assert.doesNotMatch(
      pairViewSource,
      /openRuntimeSession\(elideUrlForDisplay/,
      'the opener must receive the stored session id, never a display abbreviation',
    );
  });
});
