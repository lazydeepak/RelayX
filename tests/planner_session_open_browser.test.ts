/**
 * REGRESSION COVERAGE — the planner "Open" targets the recorded SESSION URL.
 *
 * Three defects motivated this file, all observed live against a running RelayX:
 *
 *  1. THE APP STOLE FOCUS. The Open button DID open the correct Chrome tab
 *     (verified read-back, windowId/tabId returned), and then two separate
 *     `provider.activateRuntime()` calls ran `tell application "ChatGPT" to activate`,
 *     raising the ChatGPT DESKTOP APP over the tab that had just been verified.
 *     Measured: frontmost went `Google Chrome` -> `ChatGPT` while RelayX still
 *     reported success:true. The operator saw "it opened ChatGPT"; the browser tab was
 *     behind it.
 *
 *  2. THE REUSE PATH NEVER RAISED THE BROWSER. `set index of w to 1` reorders a window
 *     inside Chrome but does not bring the Chrome application forward, so a second Open
 *     reported success while the operator was still looking at RelayX.
 *
 *  3. THE PROJECT URL WAS NOT WHAT GOT RECORDED. One project persisted under two
 *     different-looking URLs depending on which flow captured it:
 *       projects.planner_project_url = .../g/g-p-<key>/project          (stable)
 *       runtime.externalProjectRef   = .../g/g-p-<key>-test-project/...  (named)
 *     ChatGPT emits BOTH spellings of the same project, and only the stable
 *     `g-p-<32-hex>` key is identity, so the two drifted apart.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT COVER: opening the project main page.
 * An earlier iteration added a separate "Open Project" button that opened
 * `/g/<g-p-…>/project` instead of the conversation. That was wrong for this control —
 * the planner Open must go to the session that is actually attached — so the whole
 * project-open path was removed rather than kept as a second button. The trap that
 * killed it is recorded below so it is not re-introduced.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ChatGPTProvider } from '../src/relay/providers/adapters.ts';
import { ChatGPTAppHandler } from '../src/relay/integrations/handlers/ChatGPTAppHandler.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { normalizeChatProjectSlug } from '../src/relay/application/RelayApiService.ts';
import {
  canonicalizeChatGPTProjectUrlFromUrl,
  parseChatGPTProjectUrl,
  toStableChatGPTProjectId,
} from '../src/relay/providers/chatgptProjectUrl.ts';

const KEY = 'g-p-6a9bdd536b688191b57de5da6e7f3b09';
const CONV_ID = '6ac3aef4-1ed8-83e8-a54a-f93c5291ce19';
const STABLE_PROJECT_URL = `https://chatgpt.com/g/${KEY}/project`;
const NAMED_PROJECT_URL = `https://chatgpt.com/g/${KEY}-test-project/project`;
const STABLE_CONV_URL = `https://chatgpt.com/g/${KEY}/c/${CONV_ID}`;
const NAMED_CONV_URL = `https://chatgpt.com/g/${KEY}-test-project/c/${CONV_ID}`;

const repoFile = (rel: string) =>
  readFileSync(join(new URL('..', import.meta.url).pathname, rel), 'utf8');

/**
 * A ChatGPT provider whose Chrome open verifies, and which RECORDS any
 * activateRuntime call. If an open path calls it, the ChatGPT desktop app is raised
 * over the tab that was just verified — the live defect this file guards.
 */
function spyProvider() {
  const p = new ChatGPTProvider() as any;
  const calls: string[] = [];
  p.runAppleScript = () => ({ success: true, output: 'NONE::0' });
  p.openDedicatedWindowAndCaptureId = () => ({ windowId: 3, tabId: 4 });
  p.readHandleUrl = () => STABLE_CONV_URL;
  p.activateRuntime = async () => {
    calls.push('activateRuntime');
    return true;
  };
  p.openExactSessionInChrome = async function (url: string, conv: string) {
    calls.push('openExactSessionInChrome');
    return {
      success: true,
      reused: false,
      windowId: 3,
      tabId: 4,
      requestedUrl: url,
      conversationId: conv,
      observedUrl: url,
    };
  };
  return { p, calls };
}

/* ------------------------------------------------------------------ *
 * 1. ONE project identity, whatever slug spelling ChatGPT handed us
 * ------------------------------------------------------------------ */
describe('the named and stable project slugs are ONE identity', () => {
  it('the stable key is recovered from either spelling', () => {
    assert.equal(toStableChatGPTProjectId(NAMED_PROJECT_URL), KEY);
    assert.equal(toStableChatGPTProjectId(STABLE_PROJECT_URL), KEY);
    assert.equal(toStableChatGPTProjectId(NAMED_CONV_URL), KEY);
    assert.equal(toStableChatGPTProjectId(KEY), KEY);
    assert.equal(toStableChatGPTProjectId(`${KEY}-test-project`), KEY);
  });

  it('both spellings canonicalize to the identical project URL', () => {
    const fromNamed = canonicalizeChatGPTProjectUrlFromUrl(NAMED_CONV_URL);
    const fromStable = canonicalizeChatGPTProjectUrlFromUrl(STABLE_CONV_URL);
    assert.equal(fromNamed, STABLE_PROJECT_URL);
    assert.equal(fromStable, STABLE_PROJECT_URL);
    assert.equal(fromNamed, fromStable, 'one project must have exactly one canonical URL');
  });

  it('the ownership comparison agrees for both spellings', () => {
    assert.equal(normalizeChatProjectSlug(NAMED_PROJECT_URL), normalizeChatProjectSlug(STABLE_PROJECT_URL));
    assert.equal(normalizeChatProjectSlug(NAMED_CONV_URL), KEY);
  });

  it('a slug with no stable key is NOT rewritten (identity is never invented)', () => {
    assert.equal(toStableChatGPTProjectId('g-p-abc123def456'), 'g-p-abc123def456');
    assert.equal(
      canonicalizeChatGPTProjectUrlFromUrl('https://chatgpt.com/g/g-p-abc123def456/project'),
      'https://chatgpt.com/g/g-p-abc123def456/project',
    );
  });

  it('a conversation URL still never yields a project binding', () => {
    assert.equal(toStableChatGPTProjectId('https://chatgpt.com/c/6f0a1b2c3d4e5f60718293a4b'), null);
    assert.equal(parseChatGPTProjectUrl('https://chatgpt.com/c/6f0a1b2c3d4e5f60718293a4b'), null);
    // A look-alike host must not be laundered into an identity either.
    assert.equal(toStableChatGPTProjectId(`https://evil.test/g/${KEY}/project`), null);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The Open targets the CONVERSATION, exactly
 * ------------------------------------------------------------------ */
describe('the Open targets the exact recorded conversation', () => {
  function provider(over: { find?: string; handle?: any; readBack?: string | null } = {}) {
    const p = new ChatGPTProvider() as any;
    p.runAppleScript = () => ({ success: true, output: over.find ?? 'NONE::0' });
    p.openDedicatedWindowAndCaptureId = () => over.handle ?? { windowId: 11, tabId: 22 };
    p.readHandleUrl = () => over.readBack ?? null;
    return p;
  }

  it('a verified conversation tab is success', async () => {
    const r = await provider({ readBack: STABLE_CONV_URL }).openExactSessionInChrome(STABLE_CONV_URL, CONV_ID);
    assert.equal(r.success, true);
    assert.equal(r.observedUrl, STABLE_CONV_URL);
  });

  /**
   * THE TRAP THAT WAS FALLEN INTO AND REMOVED. The opener was briefly generalized to
   * take a project key as its match token. Because the stable project key
   * `g-p-<32-hex>` is a literal SUBSTRING of every conversation URL in that project
   * (`/g/g-p-<key>-name/c/<id>`), that search focused an existing CONVERSATION tab and
   * the read-back passed on the same substring — so "Open Project" reported success
   * while showing a conversation.
   *
   * Note what the opener can and cannot do about this: given a project key as its
   * token it would still "succeed", because the key really is present in both URLs. The
   * opener verifies the identity it is HANDED. So the real protection is structural —
   * the project-open path is deleted, so nothing hands it a project key. These two
   * assertions pin that, because a behavioural test on the opener alone would pass
   * even with the whole project-open path reinstated.
   */
  it('nothing in the codebase opens a project page', () => {
    for (const file of [
      'src/relay/providers/adapters.ts',
      'src/relay/integrations/handlers/ChatGPTAppHandler.ts',
      'src/relay/application/RelayApiService.ts',
    ]) {
      const src = repoFile(file);
      assert.ok(
        !src.includes('openChatGPTProjectInChrome'),
        `${file} still exposes a ChatGPT project opener`,
      );
    }
  });

  it('the opener matches on the conversation id, never on a project key', async () => {
    const p = new ChatGPTProvider() as any;
    let script = '';
    p.runAppleScript = (s: string) => {
      script = s;
      return { success: true, output: 'NONE::0' };
    };
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 1, tabId: 1 });
    p.readHandleUrl = () => STABLE_CONV_URL;
    await p.openExactSessionInChrome(STABLE_CONV_URL, CONV_ID);
    assert.ok(
      !script.includes(`u contains "/g/${KEY}"`),
      'the search must never be keyed on the project key, which is a substring of every conversation URL',
    );
    assert.match(script, new RegExp(`u contains "${CONV_ID}"`));
  });

  it('a tab for a DIFFERENT conversation is a failure, not a success', async () => {
    const other = `https://chatgpt.com/g/${KEY}/c/11111111-2222-3333-4444-555555555555`;
    const r = await provider({ readBack: other }).openExactSessionInChrome(STABLE_CONV_URL, CONV_ID);
    assert.equal(r.success, false, 'another conversation must never be reported as success');
    // The reason must name what was actually observed, so the failure is diagnosable.
    assert.match(String(r.reason), new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(
      (r.diagnostics ?? []).some((d: string) => d.includes('verification-failed')),
      'the failing stage must be reported',
    );
  });

  it('a lost read-back fails closed', async () => {
    const r = await provider({ readBack: null }).openExactSessionInChrome(STABLE_CONV_URL, CONV_ID);
    assert.equal(r.success, false);
  });

  /**
   * ChatGPT serves the same conversation under either slug spelling, so both must
   * verify — the conversation id is the identity, not the project slug around it.
   */
  it('the named slug still verifies, because the conversation id identifies both spellings', async () => {
    const r = await provider({ readBack: NAMED_CONV_URL }).openExactSessionInChrome(STABLE_CONV_URL, CONV_ID);
    assert.equal(r.success, true);
  });

  it('the reuse search matches on the conversation id only', async () => {
    // Assert the generated AppleScript, since the substring bug lived there.
    const p = new ChatGPTProvider() as any;
    let script = '';
    p.runAppleScript = (s: string) => {
      script = s;
      return { success: true, output: 'NONE::0' };
    };
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 1, tabId: 1 });
    p.readHandleUrl = () => STABLE_CONV_URL;
    await p.openExactSessionInChrome(STABLE_CONV_URL, CONV_ID);
    assert.match(script, new RegExp(`u contains "${CONV_ID}"`));
    assert.ok(
      !script.includes('u does not contain "/c/"'),
      'the conversation path must not use the reverted project-key search',
    );
  });

  it('the identity token is escaped before it reaches AppleScript', async () => {
    const p = new ChatGPTProvider() as any;
    let script = '';
    p.runAppleScript = (s: string) => {
      script = s;
      return { success: true, output: 'NONE::0' };
    };
    p.openDedicatedWindowAndCaptureId = () => null;
    p.readHandleUrl = () => null;
    // A quote in the token would otherwise terminate the AppleScript string literal.
    await p.openExactSessionInChrome('https://chatgpt.com/c/x', 'id-with-"quote"');
    assert.match(script, /id-with-\\"quote\\"/);
  });

  it('no URL and no identity is refused before any browser contact', async () => {
    let contacted = false;
    const p = new ChatGPTProvider() as any;
    p.runAppleScript = () => {
      contacted = true;
      return { success: true, output: 'NONE::0' };
    };
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 1, tabId: 1 });
    p.readHandleUrl = () => null;
    const r = await p.openExactSessionInChrome('', '');
    assert.equal(r.success, false);
    assert.equal(contacted, false, 'an open with no authority must not touch the browser');
  });
});

/* ------------------------------------------------------------------ *
 * 3. THE FOCUS STEALS — the actual reported symptoms
 * ------------------------------------------------------------------ */
describe('a verified browser open must leave the BROWSER in front', () => {
  it('handler.openSession does not activate the desktop app after a verified open', async () => {
    const { p, calls } = spyProvider();
    const handler = new ChatGPTAppHandler(undefined, p);
    const ok = await handler.openSession('rt1', STABLE_CONV_URL);
    assert.equal(ok, true, 'the open itself must still succeed');
    assert.deepEqual(
      calls.filter((c) => c === 'activateRuntime'),
      [],
      'activateRuntime raises the ChatGPT desktop app over the verified Chrome tab',
    );
  });

  it('RelayApiService.openRuntimeSession does not activate the desktop app', async () => {
    const { p, calls } = spyProvider();
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    engine.registerProvider(p);
    const runtime: any = {
      id: 'rt1',
      providerType: 'chatgpt',
      name: 'planner',
      sessionUrl: STABLE_CONV_URL,
      externalSessionId: CONV_ID,
      externalProjectRef: STABLE_PROJECT_URL,
      updateExternalIdentity() {},
      updatedAt: Date.now(),
      createdAt: Date.now(),
    };
    (db.runtimes as any).findById = async () => runtime;
    const service = new RelayApiService(db as any, engine);
    (service as any).integrationManager = {
      initialize: async () => {},
      getHandler: async () => ({
        openSession: async () => true,
        lastExactSessionOpenResult: { success: true, observedUrl: STABLE_CONV_URL, windowId: 3, tabId: 4 },
      }),
    };

    const res = await service.openRuntimeSession('rt1');
    assert.equal(res.success, true);
    assert.deepEqual(
      calls.filter((c) => c === 'activateRuntime'),
      [],
      'openRuntimeSession must not hand focus to another application',
    );
  });

  it('the reuse path raises Chrome itself, never the ChatGPT desktop app', async () => {
    const p = new ChatGPTProvider() as any;
    let script = '';
    p.runAppleScript = (s: string) => {
      script = s;
      return { success: true, output: `FOUND::7::8::${STABLE_CONV_URL}::1` };
    };
    p.readHandleUrl = () => STABLE_CONV_URL;
    const r = await p.openExactSessionInChrome(STABLE_CONV_URL, CONV_ID);
    assert.equal(r.success, true);
    assert.equal(r.reused, true);
    assert.match(script, /tell application "Google Chrome"/);
    assert.match(script, /^\s*activate\s*$/m, 'the reuse path must activate the browser');
    assert.ok(
      !/tell application "ChatGPT"/i.test(script),
      'the reuse path must never raise the ChatGPT desktop app',
    );
  });

  it('Chrome is activated only INSIDE the match branch, never while merely searching', async () => {
    const p = new ChatGPTProvider() as any;
    let script = '';
    p.runAppleScript = (s: string) => {
      script = s;
      return { success: true, output: 'NONE::3' };
    };
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 1, tabId: 1 });
    p.readHandleUrl = () => STABLE_CONV_URL;
    await p.openExactSessionInChrome(STABLE_CONV_URL, CONV_ID);
    // The activate must sit downstream of the identity match, so a search that finds
    // nothing never takes the foreground away from the operator.
    const matchAt = script.indexOf(`u contains "${CONV_ID}"`);
    const activateAt = script.indexOf('\n              activate\n');
    assert.ok(matchAt > -1, 'the conversation match expression is missing from the reuse script');
    assert.ok(activateAt > matchAt, 'activate must run only after a tab actually matched');
  });

  /**
   * Source-level guard. The two call sites were both "harmless looking" and neither
   * had an obvious test, so a behavioural test alone could be defeated by someone
   * re-adding the call in a branch the test does not exercise.
   *
   * Matches the actual CALL (`\.activateRuntime(`), not the bare word, because these
   * functions deliberately discuss why they must not call it.
   */
  it('no open path calls activateRuntime anywhere in the codebase', () => {
    for (const file of [
      'src/relay/integrations/handlers/ChatGPTAppHandler.ts',
      'src/relay/providers/adapters.ts',
      'src/relay/application/RelayApiService.ts',
    ]) {
      const src = repoFile(file);
      // Strip comments first: these functions deliberately EXPLAIN why they must not
      // call activateRuntime, so scanning raw text would match the explanation.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const openRegions = code.match(/(?:^|\s)(?:async\s+)?open\w*\s*\([\s\S]*?\n {2}\}/g) ?? [];
      assert.ok(openRegions.length > 0, `${file}: the source guard found no open function to check`);
      for (const region of openRegions) {
        assert.ok(
          !/\.activateRuntime\s*\(/.test(region),
          `${file}: an open path calls activateRuntime, which raises the ChatGPT desktop app`,
        );
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. THE PROJECT-OPEN PATH IS GONE
 * ------------------------------------------------------------------ */
describe('there is no project-open path left to use by mistake', () => {
  const files = [
    'src/relay/providers/adapters.ts',
    'src/relay/integrations/handlers/ChatGPTAppHandler.ts',
    'src/relay/application/RelayApiService.ts',
    'src/components/PairView.tsx',
    'src/App.tsx',
    'electron/ipc/contracts.ts',
    'electron/ipc/registerHandlers.ts',
    'electron/preload.ts',
    'src/services/relayBridge.ts',
    'src/types/relayApi.ts',
    'src/services/browserPreviewApi.ts',
  ];

  it('no openPlannerProject / OPEN_PLANNER_PROJECT surface remains', () => {
    for (const file of files) {
      const src = repoFile(file);
      for (const gone of ['openPlannerProject', 'OPEN_PLANNER_PROJECT', 'openProjectSession', 'openChatGPTProjectInChrome']) {
        assert.ok(!src.includes(gone), `${file} still references ${gone}`);
      }
    }
  });

  it('the planner Open control is labelled "Open" and carries no project handler prop', () => {
    const src = repoFile('src/components/PairView.tsx');
    assert.ok(!/onOpenPlannerProject/.test(src), 'the pair card must not offer a project open');
    // The single planner Open resolves the conversation through openPlannerSession.
    assert.match(src, /onOpenPlannerSession\(pair\.plannerSessionId!\)/);
  });

  it('the project URL is still recorded, so removing the open did not remove the data', () => {
    // The record is the point: the URL is shown read-only, and the DB backfill keeps
    // it in the one canonical stable form.
    assert.match(repoFile('src/components/PairView.tsx'), /plannerProjectUrl/);
    assert.ok(toStableChatGPTProjectId(NAMED_PROJECT_URL) === KEY);
  });
});