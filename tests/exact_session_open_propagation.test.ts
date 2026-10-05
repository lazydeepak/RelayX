import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTProvider } from '../src/relay/providers/adapters.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';

const CONV = '6ac1a7c4-7b40-83ec-ba40-86180675f217';
const EXACT = `https://chatgpt.com/g/g-p-6ac1a6bf6bcc8191a4bc405b1274b54a-relay-fresh-project-a/c/${CONV}`;

function provider(over: { find?: string; handle?: any; readBack?: string | null; scriptOk?: boolean }) {
  const p = new ChatGPTProvider() as any;
  p.runAppleScript = () => ({ success: over.scriptOk !== false, output: over.find ?? 'NONE::0', error: over.scriptOk === false ? 'applescript boom' : undefined });
  p.openDedicatedWindowAndCaptureId = () => over.handle ?? null;
  p.readHandleUrl = () => over.readBack ?? null;
  return p;
}

describe('exact-session open: verification contract', () => {
  it('1. verified handle + matching read-back URL => success true', async () => {
    const r = await provider({ handle: { windowId: 4, tabId: 8 }, readBack: EXACT })
      .openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, true);
    assert.equal(r.observedUrl, EXACT);
    assert.equal(r.requestedUrl, EXACT);
    assert.equal(r.windowId, 4);
    assert.equal(r.tabId, 8);
  });

  it('2. opener returns no handle => success false with reason', async () => {
    const r = await provider({ handle: null }).openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, false);
    assert.match(String(r.reason), /verifiable window\/tab/i);
    assert.equal(r.requestedUrl, EXACT, 'requested URL is preserved for diagnostics');
  });

  it('3. wrong conversation URL => success false', async () => {
    const r = await provider({ handle: { windowId: 1, tabId: 1 }, readBack: 'https://chatgpt.com/g/g-p-x/c/other-conv' })
      .openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, false);
    assert.match(String(r.reason), /does not represent the exact conversation/i);
  });

  it('4. AppleScript failure => success false with reason (and no tab claim)', async () => {
    const r = await provider({ scriptOk: false }).openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, false);
    assert.match(String(r.reason), /AppleScript/i);
  });

  it('4b. handle captured but read-back lost => success false', async () => {
    const r = await provider({ handle: { windowId: 2, tabId: 2 }, readBack: null })
      .openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, false);
    assert.match(String(r.reason), /could not be read back/i);
  });

  it('8. successful reuse of an existing exact tab stays success true', async () => {
    const r = await provider({ find: `FOUND::5::12::${EXACT}::3`, readBack: EXACT })
      .openExactSessionInChrome(EXACT, CONV);
    assert.equal(r.success, true);
    assert.equal(r.reused, true);
    assert.equal(r.windowId, 5);
    assert.equal(r.tabId, 12);
  });

  it('emits ordered diagnostics naming the failing stage', async () => {
    const r = await provider({ handle: null }).openExactSessionInChrome(EXACT, CONV);
    const d = (r.diagnostics ?? []).join(' | ');
    assert.match(d, /opener:entered/);
    assert.match(d, /stage:reuse-search/);
    assert.match(d, /stage:create-tab/);
    assert.match(d, /stage:tab-creation-failed/);
  });
});

/**
 * THE REGRESSION: a failed structured provider result must never become
 * { success: true } at the API boundary.
 */
describe('openRuntimeSession never manufactures success', () => {
  async function svc(handlerResult: any) {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    engine.registerProvider(new ChatGPTProvider());
    const runtime: any = {
      id: 'rt1', providerType: 'chatgpt', name: 'planner',
      sessionUrl: EXACT, externalSessionId: CONV,
      updateExternalIdentity() {},
      updatedAt: Date.now(), createdAt: Date.now(),
    };
    (db.runtimes as any).save = async () => {};
    (db.runtimes as any).findById = async () => runtime;
    const service = new RelayApiService(db as any, engine);
    (service as any).integrationManager = {
      initialize: async () => {},
      getHandler: async () => ({
        lastExactSessionOpenResult: handlerResult,
        openSession: async () => true, // returns without throwing — must NOT imply success
      }),
    };
    (engine as any).getProvider = () => undefined;
    return service.openRuntimeSession('rt1');
  }

  it('5. handler cannot convert a failed structured result into success', async () => {
    const r = await svc({ success: false, requestedUrl: EXACT, reason: 'Chrome did not yield a verifiable window/tab.' });
    assert.equal(r.success, false);
    assert.match(String(r.error), /verifiable window\/tab/);
    assert.equal(r.url, EXACT, 'authoritative requested URL preserved for diagnostics');
  });

  it('6/9. a missing structured result also fails closed (no exception-based success)', async () => {
    const r = await svc(null);
    assert.equal(r.success, false);
    assert.match(String(r.error), /verified handle|unknown/i);
  });

  it('regression: {success:false, requestedUrl} must NEVER surface as {success:true}', async () => {
    const r = await svc({ success: false, requestedUrl: EXACT, reason: 'boom' });
    assert.notEqual(r.success, true);
    assert.equal(r.success, false);
  });

  it('propagates a verified success with handle evidence', async () => {
    const r = await svc({ success: true, reused: false, windowId: 3, tabId: 6, observedUrl: EXACT, requestedUrl: EXACT });
    assert.equal(r.success, true);
    assert.equal(r.windowId, 3);
    assert.equal(r.tabId, 6);
    assert.equal(r.observedUrl, EXACT);
  });
});
