import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTProvider } from '../src/relay/providers/adapters.ts';

const CONV = '6ac1a7c4-7b40-83ec-ba40-86180675f217';
const EXACT = `https://chatgpt.com/g/g-p-6ac1a6bf6bcc8191a4bc405b1274b54a-relay-fresh-project-a/c/${CONV}`;
const OTHER_PROJECT = 'https://chatgpt.com/g/g-p-6ab13d0d7a708191ba704a0a5a874b79-relayx/c/6ac1362e-bc34-83ee-af03-2f52ee2b88af';

/** Build a provider whose Chrome AppleScript surface is fully stubbed. */
function makeProvider(over: {
  findOutput?: string;
  handle?: { windowId: number; tabId: number } | null;
  readBack?: string | null;
}) {
  const p = new ChatGPTProvider() as any;
  const opened: string[] = [];
  p.runAppleScript = () => ({ success: true, output: over.findOutput ?? 'NONE' });
  p.openDedicatedWindowAndCaptureId = (url: string) => {
    opened.push(url);
    return over.handle ?? null;
  };
  p.readHandleUrl = () => over.readBack ?? null;
  return { p, opened };
}

describe('exact-session Chrome opener', () => {
  it('1. passes the authoritative sessionUrl to Chrome UNCHANGED', async () => {
    const { p, opened } = makeProvider({ handle: { windowId: 9, tabId: 4 }, readBack: EXACT });
    const r = await p.openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, true);
    assert.equal(opened.length, 1);
    assert.equal(opened[0], EXACT, 'must open the exact URL verbatim, project segment included');
  });

  it('8. keeps the project-scoped path project-scoped (no /g/ stripping)', async () => {
    const { p, opened } = makeProvider({ handle: { windowId: 1, tabId: 1 }, readBack: EXACT });
    await p.openExactSessionInChrome(EXACT, CONV);
    assert.ok(opened[0].includes('/g/g-p-6ac1a6bf6bcc8191a4bc405b1274b54a-relay-fresh-project-a/'));
    assert.ok(!/chatgpt\.com\/c\//.test(opened[0]), 'must not degrade to a bare /c/{id} URL');
  });

  it('2. focuses/reuses an existing exact tab instead of creating a duplicate', async () => {
    const { p, opened } = makeProvider({
      findOutput: `FOUND::5::12::${EXACT}::3`,
      readBack: EXACT,
    });
    const r = await p.openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, true);
    assert.equal(r.reused, true);
    assert.equal(r.windowId, 5);
    assert.equal(r.tabId, 12);
    assert.equal(opened.length, 0, 'must NOT create a new tab when an exact one exists');
  });

  it('3. creates exactly one exact Chrome tab when none exists', async () => {
    const { p, opened } = makeProvider({ findOutput: 'NONE', handle: { windowId: 2, tabId: 3 }, readBack: EXACT });
    const r = await p.openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, true);
    assert.equal(r.reused, false);
    assert.equal(opened.length, 1);
  });

  it('4. ignores a different open ChatGPT project', async () => {
    // The find script only matches on conversationId, so another project's tab cannot match.
    const { p, opened } = makeProvider({ findOutput: 'NONE', handle: { windowId: 7, tabId: 7 }, readBack: EXACT });
    const r = await p.openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, true);
    assert.equal(opened[0], EXACT);
    assert.ok(!opened[0].includes('6ab13d0d7a708191ba704a0a5a874b79'), 'no substitution of the open project');
    assert.ok(OTHER_PROJECT.includes('6ab13d0d7a708191ba704a0a5a874b79'));
  });

  it('6. fails when Chrome yields no verifiable handle', async () => {
    const { p } = makeProvider({ findOutput: 'NONE', handle: null });
    const r = await p.openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, false);
    assert.match(String(r.reason), /verifiable window\/tab/i);
  });

  it('7. rejects a resulting tab whose conversation id does not match', async () => {
    const { p } = makeProvider({
      findOutput: 'NONE',
      handle: { windowId: 3, tabId: 3 },
      readBack: 'https://chatgpt.com/g/g-p-other/c/some-other-conversation',
    });
    const r = await p.openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, false, 'wrong conversation must not be reported as success');
    assert.match(String(r.reason), /does not represent the exact conversation/i);
  });

  it('refuses when no authoritative URL / conversation id is supplied', async () => {
    const { p } = makeProvider({});
    const r = await p.openExactSessionInChrome('', '');
    assert.equal(r.success, false);
    assert.match(String(r.reason), /No authoritative/i);
  });
});


describe('reuse enumeration correctness', () => {
  /** Capture the AppleScript the opener sends to Chrome. */
  function captureScripts(over: any = {}) {
    const p = new ChatGPTProvider() as any;
    const scripts: string[] = [];
    p.runAppleScript = (script: string) => {
      scripts.push(script);
      return { success: true, output: over.find ?? 'NONE::0' };
    };
    p.openDedicatedWindowAndCaptureId = () => over.handle ?? null;
    p.readHandleUrl = () => (over.readBack !== undefined ? over.readBack : EXACT);
    return { p, scripts, opened: [] as string[] };
  }

  it('1. iterates concrete integer indices, never `(index of t)`', async () => {
    const { p, scripts } = captureScripts({ find: `FOUND::5::12::${EXACT}::3` });
    await p.openExactSessionInChrome(EXACT, CONV);
    const reuse = scripts[0] ?? '';
    assert.match(reuse, /repeat with wi from 1 to wCount/, 'windows must be iterated by integer index');
    assert.match(reuse, /repeat with tabIndex from 1 to tCount/, 'tabs must be iterated by integer index');
    assert.match(reuse, /set active tab index of w to tabIndex/, 'active tab must be set from an integer');
    assert.doesNotMatch(reuse, /\(index of t\)/, 'the unresolvable `index of t` form must be gone');
    // `set frontmost of w` is unsupported on a Chrome window reference and aborted the
    // enumeration; focus must be raised via window index instead.
    // executable statement only (comments legitimately mention the removed form)
    assert.doesNotMatch(reuse, /^\s*set frontmost of/m, 'unsupported set-frontmost must not be executed');
    assert.match(reuse, /set index of w to 1/, 'window focus must be raised via index');
  });

  it('2/3/4. exact existing tab returns reused=true with the right handle and NO new tab', async () => {
    const { p, scripts } = captureScripts({ find: `FOUND::5::12::${EXACT}::3` });
    const r = await p.openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, true);
    assert.equal(r.reused, true);
    assert.equal(r.windowId, 5);
    assert.equal(r.tabId, 12);
    assert.equal(scripts.length, 1, 'create-tab path must not run when reuse succeeds');
  });

  it('5. verifies the focused tab by read-back through the same handle', async () => {
    const { p } = captureScripts({ find: `FOUND::5::12::${EXACT}::3`, readBack: EXACT });
    const r = await p.openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, true);
    assert.equal(r.observedUrl, EXACT);
    assert.match((r.diagnostics ?? []).join('|'), /reuse-read-back/);
  });

  it('5b. reuse read-back mismatch => success false (never claimed as reused)', async () => {
    const { p } = captureScripts({
      find: `FOUND::5::12::${EXACT}::3`,
      readBack: 'https://chatgpt.com/g/g-p-other/c/someone-else',
    });
    const r = await p.openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, false);
    assert.match(String(r.reason), /could not be verified/i);
  });

  it('6/7. matches only the authoritative conversation id, never the active tab or another project', async () => {
    // The enumeration compares against the requested conversationId only; a tab for a
    // different conversation/project never produces a FOUND match.
    const { p, scripts } = captureScripts({ find: 'NONE::7', handle: { windowId: 2, tabId: 2 }, readBack: EXACT });
    const r = await p.openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, true);
    assert.equal(r.reused, false);
    assert.match(scripts[0] ?? '', new RegExp(CONV), 'search must key on the exact conversation id');
  });

  it('8. reuse-script failure stays success=false and does NOT silently create a duplicate tab', async () => {
    const p = new ChatGPTProvider() as any;
    let created = 0;
    p.runAppleScript = () => ({
      success: true,
      output: "ERR::Can't set index of item 2 of every tab of item 1 of every window",
    });
    p.openDedicatedWindowAndCaptureId = () => {
      created += 1;
      return { windowId: 1, tabId: 1 };
    };
    p.readHandleUrl = () => EXACT;
    const r = await p.openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, false);
    assert.match(String(r.reason), /Chrome enumeration failed/i);
    assert.equal(created, 0, 'must not fall through to creating a duplicate tab on enumeration failure');
  });
});
