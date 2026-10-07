import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTProvider } from '../src/relay/providers/adapters.ts';

const CONV = '6ac42a8a-8f34-83ee-8a15-7d95de316b90';
const PROJECT = 'g-p-6ab13d0d7a708191ba704a0a5a874b79-relayx';
const EXACT_URL = `https://chatgpt.com/g/${PROJECT}/c/${CONV}`;

function makeProvider(over: {
  findOutput?: string;
  handle?: { windowId: number; tabId: number } | null;
  readBack?: string | null;
}) {
  const p = new ChatGPTProvider() as any;
  p.runAppleScript = () => ({ success: true, output: over.findOutput ?? 'NONE::0' });
  p.openDedicatedWindowAndCaptureId = (url: string) => {
    if (url !== EXACT_URL) throw new Error(`Unexpected URL passed to openDedicatedWindowAndCaptureId: ${url}`);
    return over.handle ?? null;
  };
  p.readHandleUrl = () => over.readBack ?? null;
  return p;
}

describe('ChatGPTPlanner exact-session open — focused regression', () => {
  it('existing exact project conversation tab -> reused correctly', async () => {
    const p = makeProvider({
      findOutput: `FOUND::10::22::${EXACT_URL}::1`,
      readBack: EXACT_URL,
    });
    const r = await p.openExactSessionInChrome(EXACT_URL, CONV);
    assert.strictEqual(r.success, true, 'must succeed');
    assert.strictEqual(r.reused, true, 'must report reused=true');
    assert.strictEqual(r.windowId, 10);
    assert.strictEqual(r.tabId, 22);
    assert.strictEqual(r.requestedUrl, EXACT_URL);
    assert.strictEqual(r.observedUrl, EXACT_URL);
    assert.strictEqual(r.conversationId, CONV);
  });

  it('no existing tab -> new exact project conversation tab opened', async () => {
    const p = makeProvider({
      findOutput: 'NONE::0',
      handle: { windowId: 7, tabId: 15 },
      readBack: EXACT_URL,
    });
    const r = await p.openExactSessionInChrome(EXACT_URL, CONV);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.reused, false, 'newly created tab must NOT be reported as reused');
    assert.strictEqual(r.windowId, 7);
    assert.strictEqual(r.tabId, 15);
    assert.strictEqual(r.requestedUrl, EXACT_URL);
    assert.strictEqual(r.observedUrl, EXACT_URL);
  });

  it('wrong conversation after navigation -> failure', async () => {
    const p = makeProvider({
      findOutput: 'NONE::0',
      handle: { windowId: 3, tabId: 3 },
      readBack: 'https://chatgpt.com/g/g-p-other/c/other-id',
    });
    const r = await p.openExactSessionInChrome(EXACT_URL, CONV);
    assert.strictEqual(r.success, false);
    assert.ok(String(r.reason).includes('does not represent'), `reason must say mismatch: ${r.reason}`);
  });

  it('provider canonicalization to bare /c/<id> -> same conversation, reported as such', async () => {
    // PROVEN LIVE: ChatGPT serves the bound conversation on the canonical route, and does so on
    // its own. Identity is the provider-owned id, so this is the SAME conversation and must be a
    // success — but "routePreserved" must be false so nothing claims the project-scoped URL is up.
    const p = makeProvider({
      findOutput: 'NONE::0',
      handle: { windowId: 4, tabId: 5 },
      readBack: `https://chatgpt.com/c/${CONV}`,
    });
    const r = await p.openExactSessionInChrome(EXACT_URL, CONV);
    assert.strictEqual(r.success, true, 'the canonical route is the same conversation');
    assert.strictEqual(r.canonicalizedByProvider, true, 'canonicalization must be reported');
    assert.strictEqual(r.routePreserved, false, 'must not claim the project-scoped route is open');
    assert.strictEqual(r.conversationId, CONV, 'the verified identity is still the bound conversation');
    assert.strictEqual(r.reused, false);
  });

  it('an existing canonical /c/<id> tab is genuinely reused, not misreported as a different conversation', async () => {
    // The live failure this pins: five real Chrome tabs held the bound conversation only as bare
    // /c/<id>, and strict shape-matching reported them as "a different conversation".
    const p = makeProvider({
      findOutput: `FOUND::1971994619::1971994630::https://chatgpt.com/c/${CONV}::4`,
      readBack: `https://chatgpt.com/c/${CONV}`,
    });
    const r = await p.openExactSessionInChrome(EXACT_URL, CONV);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.reused, true, 'a real existing tab must be reported as reused');
    assert.strictEqual(r.windowId, 1971994619);
    assert.strictEqual(r.tabId, 1971994630);
    assert.strictEqual(r.canonicalizedByProvider, true);
  });

  it('a different conversation on the canonical route still fails closed', async () => {
    const p = makeProvider({
      findOutput: 'NONE::0',
      handle: { windowId: 6, tabId: 6 },
      readBack: 'https://chatgpt.com/c/some-other-conversation',
    });
    const r = await p.openExactSessionInChrome(EXACT_URL, CONV);
    assert.strictEqual(r.success, false, 'a different conversation must never verify');
  });

  it('an off-host URL carrying the conversation id is refused', async () => {
    const p = makeProvider({
      findOutput: 'NONE::0',
      handle: { windowId: 8, tabId: 8 },
      readBack: `https://evil.example.com/c/${CONV}`,
    });
    const r = await p.openExactSessionInChrome(EXACT_URL, CONV);
    assert.strictEqual(r.success, false, 'a non-chatgpt.com host must never verify');
  });

  it('a conversation id appearing only as a query parameter is refused', async () => {
    const p = makeProvider({
      findOutput: 'NONE::0',
      handle: { windowId: 9, tabId: 9 },
      readBack: `https://chatgpt.com/?ref=${CONV}`,
    });
    const r = await p.openExactSessionInChrome(EXACT_URL, CONV);
    assert.strictEqual(r.success, false, 'substring presence is not a conversation route');
  });

  it('final verified handle equals handle used for delivery', async () => {
    const handle = { windowId: 9, tabId: 21 };
    const p = makeProvider({
      findOutput: `FOUND::9::21::${EXACT_URL}::1`,
      readBack: EXACT_URL,
    });
    const r = await p.openExactSessionInChrome(EXACT_URL, CONV);
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.windowId, handle.windowId);
    assert.strictEqual(r.tabId, handle.tabId);
    assert.strictEqual(r.reused, true);
  });
});
