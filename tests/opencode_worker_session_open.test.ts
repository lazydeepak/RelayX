/**
 * Open Worker session — session-ID-authoritative resolution and foreground-gated execution.
 *
 * The tests below encode the two defects that made the Open button intermittent:
 *   1. selection driven by a mutable stored label instead of the bound `ses_…` id, and
 *   2. blind keystrokes sent without ever confirming OpenCode owned the foreground.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOpenCodeWorkerOpenTarget,
  runForegroundGatedSteps,
  buildOpenCodeWorkerOpenSteps,
  type ForegroundStep,
} from '../src/relay/providers/opencodeWorkerSessionOpen.ts';

const TARGET = 'ses_target01';

/** Minimal stand-in for the read-only OpenCodeSessionClient surface the preflight uses. */
function fakeClient(opts: {
  session?: { id: string; title?: string; directory?: string };
  byDirectory?: Record<string, Array<{ id: string; title?: string }>>;
  failGet?: any;
  failList?: any;
}) {
  // Mirrors OpenCodeSessionClient's real shape: rows expose `sessionId`, not `id`.
  const rows = (dir: string) =>
    (opts.byDirectory?.[dir] ?? []).map((r) => ({ sessionId: r.id, title: r.title }));
  return {
    async getSession(id: string) {
      if (opts.failGet) throw opts.failGet;
      if (!opts.session || opts.session.id !== id) {
        const err: any = new Error(`session ${id} not found`);
        err.code = 'session_not_found';
        throw err;
      }
      return {
        session: { sessionId: opts.session.id, title: opts.session.title, directory: opts.session.directory },
        versionMismatch: false,
      };
    },
    async listSessionsByDirectory(dir: string) {
      if (opts.failList) throw opts.failList;
      return { directory: dir, sessions: rows(dir), versionMismatch: false };
    },
  } as any;
}

/* ------------------------------------------------------------------ */
/* Preflight: the session id is the identity                            */
/* ------------------------------------------------------------------ */

test('refuses when no authoritative ses_ id is bound (never falls back to a title)', async () => {
  const res = await resolveOpenCodeWorkerOpenTarget({
    externalSessionId: null,
    client: fakeClient({}),
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.failure, 'no_authoritative_session_id');
});

test('refreshes a stale stored title from the live id, and keeps the id authoritative', async () => {
  const res = await resolveOpenCodeWorkerOpenTarget({
    externalSessionId: TARGET,
    storedTitle: 'old label',
    client: fakeClient({
      session: { id: TARGET, title: 'renamed in opencode', directory: '/d' },
      byDirectory: { '/d': [{ id: TARGET, title: 'renamed in opencode' }] },
    }),
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.target.externalSessionId, TARGET, 'id must never be replaced');
  assert.equal(res.target.title, 'renamed in opencode');
  assert.equal(res.target.titleChanged, true);
  assert.equal(res.target.storedTitle, 'old label');
});

test('reports no title change when the stored title already matches', async () => {
  const res = await resolveOpenCodeWorkerOpenTarget({
    externalSessionId: TARGET,
    storedTitle: 'same',
    client: fakeClient({
      session: { id: TARGET, title: 'same', directory: '/d' },
      byDirectory: { '/d': [{ id: TARGET, title: 'same' }] },
    }),
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.target.titleChanged, false);
});

test('a metadata lookup failure is a refusal, not a rebind', async () => {
  const res = await resolveOpenCodeWorkerOpenTarget({
    externalSessionId: TARGET,
    client: fakeClient({ failGet: Object.assign(new Error('service down'), { code: 'service_unavailable' }) }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.failure, 'metadata_service_unavailable');
  assert.match(res.ok === false ? res.error : '', /NOT rebound/i);
  assert.match(res.ok === false ? res.error : '', /no other session was chosen/i);
});

test('a vanished session is reported as not found, never substituted', async () => {
  const res = await resolveOpenCodeWorkerOpenTarget({
    externalSessionId: TARGET,
    client: fakeClient({ session: { id: 'ses_other', title: 'other', directory: '/d' } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.failure, 'session_not_found');
});

test('duplicate titles inside the same directory are refused instead of guessed', async () => {
  const res = await resolveOpenCodeWorkerOpenTarget({
    externalSessionId: TARGET,
    storedTitle: 'test-project chat test',
    client: fakeClient({
      session: { id: TARGET, title: 'test-project chat test', directory: '/d' },
      byDirectory: {
        '/d': [
          { id: TARGET, title: 'test-project chat test' },
          { id: 'ses_twin', title: 'test-project chat test' },
        ],
      },
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.failure, 'ambiguous_title');
  assert.match(res.ok === false ? res.error : '', /ses_twin/);
});

test('title matching is case-insensitive but still refuses genuine duplicates', async () => {
  const res = await resolveOpenCodeWorkerOpenTarget({
    externalSessionId: TARGET,
    client: fakeClient({
      session: { id: TARGET, title: 'Test Relay Oct 5', directory: '/d' },
      byDirectory: {
        '/d': [
          { id: TARGET, title: 'Test Relay Oct 5' },
          { id: 'ses_twin', title: 'test relay oct 5' },
        ],
      },
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.failure, 'ambiguous_title');
});

test('same title in a DIFFERENT directory does not create false ambiguity', async () => {
  const res = await resolveOpenCodeWorkerOpenTarget({
    externalSessionId: TARGET,
    client: fakeClient({
      session: { id: TARGET, title: 'shared name', directory: '/d' },
      byDirectory: {
        '/d': [{ id: TARGET, title: 'shared name' }],
        '/other': [{ id: 'ses_elsewhere', title: 'shared name' }],
      },
    }),
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.target.duplicateTitleSessionIds, []);
});

test('a session with no title is refused', async () => {
  const res = await resolveOpenCodeWorkerOpenTarget({
    externalSessionId: TARGET,
    client: fakeClient({ session: { id: TARGET, title: '   ', directory: '/d' }, byDirectory: { '/d': [] } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.failure, 'title_unusable');
});

/* ------------------------------------------------------------------ */
/* Foreground gating                                                    */
/* ------------------------------------------------------------------ */

function harness(foregroundScript: (step: number) => string) {
  const sent: string[] = [];
  let clock = 0;
  let step = 0;
  return {
    sent,
    hooks: {
      readForegroundApp: () => foregroundScript(step),
      activateApp: () => true,
      sendKey: (keys: string) => sent.push(`key:${keys}`),
      sendKeyCode: (code: number) => sent.push(`code:${code}`),
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
    advance: () => { step += 1; },
    now: () => clock,
  };
}

const STEPS: ForegroundStep[] = [
  { kind: 'key', keys: 'b using {command down}', label: 'Cmd+B' },
  { kind: 'key', keys: 'k using {command down}', label: 'Cmd+K' },
  { kind: 'key', keys: 'my title', label: 'type title' },
  { kind: 'code', code: 36, label: 'Return' },
];

test('every keystroke is emitted while the target app is the observed foreground', async () => {
  const h = harness(() => 'OpenCode');
  const res = await runForegroundGatedSteps(STEPS, 'OpenCode', h.hooks);
  assert.equal(res.ok, true);
  assert.deepEqual(res.sent, ['Cmd+B', 'Cmd+K', 'type title', 'Return']);
  assert.equal(res.foregroundBeforeEachStep.length, 4);
  for (const entry of res.foregroundBeforeEachStep) {
    assert.equal(entry.foreground, 'OpenCode', `${entry.label} was not foreground-verified`);
  }
});

test('ABORTS before typing when the target app never becomes foreground', async () => {
  // Focus is stolen by something else (e.g. RelayX's own ChatGPT discovery) and stays stolen.
  const h = harness(() => 'Google Chrome');
  const res = await runForegroundGatedSteps(STEPS, 'OpenCode', h.hooks, { settleMs: 100, maxForegroundWaitMs: 300 });
  assert.equal(res.ok, false);
  assert.equal(res.failure, 'foreground_never_verified');
  assert.deepEqual(h.sent, [], 'no keystroke may be sent when foreground is unverified');
  assert.match(res.error ?? '', /Google Chrome/);
  assert.match(res.error ?? '', /No further keystrokes were sent/i);
});

test('a mid-sequence focus steal stops the remaining keystrokes instead of leaking them', async () => {
  // Steps 1-2 land in OpenCode; the app loses focus afterwards. The typed TITLE and Return
  // must NOT be delivered to the thief — this is the cross-app-typing bug.
  let n = 0;
  const sent: string[] = [];
  const hooks = {
    readForegroundApp: () => (n < 2 ? 'OpenCode' : 'Google Chrome'),
    activateApp: () => true,
    sendKey: (keys: string) => sent.push(`key:${keys}`),
    sendKeyCode: (code: number) => sent.push(`code:${code}`),
    sleep: async () => { n += 1; },
  };
  const res = await runForegroundGatedSteps(STEPS, 'OpenCode', hooks, { settleMs: 100, maxForegroundWaitMs: 300 });
  assert.equal(res.ok, false);
  assert.equal(res.failure, 'foreground_never_verified');
  assert.ok(!sent.some((s) => s.includes('my title')), 'the title must never reach the focus thief');
  assert.ok(!sent.includes('code:36'), 'Return must never reach the focus thief');
});

test('a recoverable steal re-activates and completes the sequence', async () => {
  // Foreground drops to Finder once, then OpenCode is re-asserted successfully.
  let n = 0;
  const sent: string[] = [];
  let activations = 0;
  const hooks = {
    readForegroundApp: () => (n === 0 ? 'Finder' : 'OpenCode'),
    activateApp: () => { activations += 1; return true; },
    sendKey: (keys: string) => sent.push(`key:${keys}`),
    sendKeyCode: (code: number) => sent.push(`code:${code}`),
    sleep: async () => { n += 1; },
  };
  const res = await runForegroundGatedSteps(STEPS, 'OpenCode', hooks, { settleMs: 100, maxForegroundWaitMs: 500 });
  assert.equal(res.ok, true);
  assert.ok(activations > 0, 'recovery must attempt re-activation');
  assert.deepEqual(res.sent, ['Cmd+B', 'Cmd+K', 'type title', 'Return']);
});

test('a keystroke transport error is reported, not swallowed', async () => {
  const hooks = {
    readForegroundApp: () => 'OpenCode',
    activateApp: () => true,
    sendKey: () => { throw new Error('assistive access denied'); },
    sendKeyCode: () => {},
    sleep: async () => {},
  };
  const res = await runForegroundGatedSteps(STEPS, 'OpenCode', hooks);
  assert.equal(res.ok, false);
  assert.equal(res.failure, 'step_send_failed');
  assert.match(res.error ?? '', /assistive access denied/);
});

test('waits are passed through and keystrokes are still gated around them', async () => {
  let n = 0;
  const sent: string[] = [];
  const hooks = {
    readForegroundApp: () => (n === 0 ? 'OpenCode' : 'Chrome'),
    activateApp: () => true,
    sendKey: (keys: string) => sent.push(`key:${keys}`),
    sendKeyCode: (c: number) => sent.push(`code:${c}`),
    sleep: async () => { n += 1; },
  };
  const res = await runForegroundGatedSteps(
    [
      { kind: 'code', code: 53, label: 'Escape' },
      { kind: 'wait', ms: 150, label: 'settle' },
      { kind: 'key', keys: 'k using {command down}', label: 'Cmd+K' },
    ],
    'OpenCode',
    hooks,
    { settleMs: 50, maxForegroundWaitMs: 200 },
  );
  assert.equal(res.ok, false);
  assert.deepEqual(sent, ['code:53'], 'nothing after the wait may be sent blind');
});

/* ------------------------------------------------------------------ */
/* Step construction                                                   */
/* ------------------------------------------------------------------ */

test('the sequence clears a leftover switcher before searching', () => {
  const steps = buildOpenCodeWorkerOpenSteps('my title');
  assert.equal(steps[0].kind, 'code');
  assert.equal(steps[0].kind === 'code' && steps[0].code, 53, 'Escape first clears stale palette state');
  const labels = steps.map((s) => s.label);
  assert.ok(labels.some((l) => /Cmd\+K/.test(l)));
  assert.ok(labels.some((l) => /Return/.test(l)));
});

function typingLiteral(title: string): string {
  const steps = buildOpenCodeWorkerOpenSteps(title);
  const typing = steps.find((s) => s.kind === 'key' && /type the refreshed/i.test(s.label));
  assert.ok(typing && typing.kind === 'key');
  return typing!.kind === 'key' ? typing!.keys : '';
}

test('quotes in a session title cannot terminate the AppleScript string literal', () => {
  const literal = typingLiteral('say "hi" \\ now');
  assert.ok(literal.startsWith('"'), 'the payload must be one quoted literal');
  assert.ok(literal.endsWith('"'));
  assert.ok(literal.includes('\\"'), 'inner double quotes must be escaped');
  assert.ok(literal.includes('\\\\'), 'backslashes must be escaped');
});

test('a title containing a double quote still yields exactly one unterminated-literal-free string', () => {
  const literal = typingLiteral('a"b"c');
  // Only the two delimiters may be unescaped quotes.
  const unescaped = literal.match(/(^|[^\\])"/g);
  assert.equal(unescaped?.length, 2, `expected exactly the 2 delimiters, got: ${literal}`);
  assert.ok(literal.startsWith('"a\\"b\\"c"'), `unexpected literal: ${literal}`);
});

test('a title with no special characters produces a plain quoted literal', () => {
  assert.equal(typingLiteral('test relay oct 5'), '"test relay oct 5"');
});

/**
 * Regression guard for the exact osascript failure that made every open fail after the
 * foreground gate was introduced: `keystroke b` (an unquoted identifier) aborts with
 * `The variable b is not defined (-2753)`, so the sequence died before searching.
 */
test('modifier keystrokes stay QUOTED AppleScript string literals', () => {
  const steps = buildOpenCodeWorkerOpenSteps('t');
  const cmdB = steps.find((s) => s.kind === 'key' && /Cmd\+B/.test(s.label))!;
  const cmdK = steps.find((s) => s.kind === 'key' && /Cmd\+K/.test(s.label))!;
  assert.equal(cmdB.kind === 'key' && cmdB.keys, '"b" using {command down}');
  assert.equal(cmdK.kind === 'key' && cmdK.keys, '"k" using {command down}');
  for (const step of [cmdB, cmdK]) {
    const keys = step.kind === 'key' ? step.keys : '';
    assert.ok(/^"[^"]+"/.test(keys), `keystroke target must be a quoted literal: ${keys}`);
    assert.ok(!/^\s*[a-z]\s+using/.test(keys), `bare identifier would fail with -2753: ${keys}`);
  }
});
