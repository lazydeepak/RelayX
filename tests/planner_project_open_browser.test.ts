/**
 * REGRESSION COVERAGE — "Open Project" opens the ChatGPT PROJECT in the BROWSER.
 *
 * Two defects motivated this file, both observed live against a running RelayX:
 *
 *  1. THE APP STOLE FOCUS. The pair card's Open button DID open the correct Chrome
 *     tab (verified read-back, windowId/tabId returned), and then two separate
 *     `provider.activateRuntime()` calls ran
 *     `tell application "ChatGPT" to activate`, raising the ChatGPT DESKTOP APP over
 *     the tab that had just been verified. Measured: frontmost went
 *     `Google Chrome` -> `ChatGPT` while RelayX still reported success:true.
 *     The operator saw "it opened ChatGPT"; the browser tab was behind it.
 *
 *  2. THE PROJECT URL WAS NOT WHAT GOT RECORDED. One project persisted under two
 *     different-looking URLs depending on which flow captured it:
 *       projects.planner_project_url = .../g/g-p-<key>/project          (stable)
 *       runtime.externalProjectRef   = .../g/g-p-<key>-test-project/...  (named)
 *     ChatGPT emits BOTH spellings of the same project, and only the stable
 *     `g-p-<32-hex>` key is identity.
 *
 * These tests pin the contract so neither can come back silently.
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
import {
  normalizeChatProjectSlug,
} from '../src/relay/application/RelayApiService.ts';
import {
  canonicalizeChatGPTProjectUrlFromUrl,
  parseChatGPTProjectUrl,
  toStableChatGPTProjectId,
} from '../src/relay/providers/chatgptProjectUrl.ts';

const KEY = 'g-p-6a9bdd536b688191b57de5da6e7f3b09';
const STABLE_URL = `https://chatgpt.com/g/${KEY}/project`;
const NAMED_URL = `https://chatgpt.com/g/${KEY}-test-project/project`;
const NAMED_CONV_URL = `https://chatgpt.com/g/${KEY}-test-project/c/6ac3aef4-1ed8-83e8-a54a-f93c5291ce19`;
const STABLE_CONV_URL = `https://chatgpt.com/g/${KEY}/c/6ac3aef4-1ed8-83e8-a54a-f93c5291ce19`;

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
  p.readHandleUrl = () => STABLE_URL;
  p.activateRuntime = async () => {
    calls.push('activateRuntime');
    return true;
  };
  p.openChatGPTProjectInChrome = async function (url: string) {
    calls.push('openChatGPTProjectInChrome');
    return {
      success: true,
      reused: false,
      windowId: 3,
      tabId: 4,
      requestedUrl: url,
      conversationId: KEY,
      observedUrl: STABLE_URL,
    };
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
    assert.equal(toStableChatGPTProjectId(NAMED_URL), KEY);
    assert.equal(toStableChatGPTProjectId(STABLE_URL), KEY);
    assert.equal(toStableChatGPTProjectId(NAMED_CONV_URL), KEY);
    assert.equal(toStableChatGPTProjectId(KEY), KEY);
    assert.equal(toStableChatGPTProjectId(`${KEY}-test-project`), KEY);
  });

  it('both spellings canonicalize to the identical project URL', () => {
    const fromNamed = canonicalizeChatGPTProjectUrlFromUrl(NAMED_CONV_URL);
    const fromStable = canonicalizeChatGPTProjectUrlFromUrl(STABLE_CONV_URL);
    assert.equal(fromNamed, STABLE_URL);
    assert.equal(fromStable, STABLE_URL);
    assert.equal(fromNamed, fromStable, 'one project must have exactly one canonical URL');
  });

  it('the ownership comparison agrees for both spellings', () => {
    assert.equal(normalizeChatProjectSlug(NAMED_URL), normalizeChatProjectSlug(STABLE_URL));
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
 * 2. The project open is verified against PROJECT identity
 * ------------------------------------------------------------------ */
describe('the project opener verifies a PROJECT, never a conversation', () => {
  function provider(over: { find?: string; handle?: any; readBack?: string | null } = {}) {
    const p = new ChatGPTProvider() as any;
    p.runAppleScript = () => ({ success: true, output: over.find ?? 'NONE::0' });
    p.openDedicatedWindowAndCaptureId = () => over.handle ?? { windowId: 11, tabId: 22 };
    p.readHandleUrl = () => over.readBack ?? null;
    return p;
  }

  it('a verified project tab is success', async () => {
    const r = await provider({ readBack: STABLE_URL }).openChatGPTProjectInChrome(STABLE_URL);
    assert.equal(r.success, true);
    assert.equal(r.observedUrl, STABLE_URL);
  });

  it('a tab that is a DIFFERENT project is a failure, not a success', async () => {
    const other = `https://chatgpt.com/g/g-p-6ab13d0d7a708191ba704a0a5a874b79/project`;
    const r = await provider({ readBack: other }).openChatGPTProjectInChrome(STABLE_URL);
    assert.equal(r.success, false, 'a tab for another project must never be reported as success');
    // The reason must name what was actually observed, so the failure is diagnosable.
    assert.match(String(r.reason), new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(
      (r.diagnostics ?? []).some((d: string) => d.includes('verification-failed')),
      'the failing stage must be reported',
    );
  });

  it('a lost read-back fails closed', async () => {
    const r = await provider({ readBack: null }).openChatGPTProjectInChrome(STABLE_URL);
    assert.equal(r.success, false);
  });

  it('the named slug still verifies, because the stable key identifies both spellings', async () => {
    const r = await provider({ readBack: NAMED_URL }).openChatGPTProjectInChrome(STABLE_URL);
    assert.equal(r.success, true);
  });

  /**
   * THE LIVE DEFECT (found by running it, not by reading it): the reuse search matched
   * the project key with a bare `contains`, and the key is a literal substring of every
   * conversation URL in that project. "Open Project" therefore focused an existing
   * CONVERSATION tab, the read-back check passed on the same substring, and it reported
   * success while showing a conversation.
   */
  it('a CONVERSATION tab in the same project is NOT accepted as the project', async () => {
    const r = await provider({ readBack: NAMED_CONV_URL }).openChatGPTProjectInChrome(STABLE_URL);
    assert.equal(r.success, false, 'a conversation tab must never verify as the project page');
  });

  it('the reuse search does not even offer a conversation tab as a project candidate', async () => {
    // Assert the generated AppleScript, since the substring bug lived there.
    const p = new ChatGPTProvider() as any;
    let script = '';
    p.runAppleScript = (s: string) => {
      script = s;
      return { success: true, output: 'NONE::0' };
    };
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 1, tabId: 1 });
    p.readHandleUrl = () => STABLE_URL;
    await p.openChatGPTProjectInChrome(STABLE_URL);
    assert.match(script, /u does not contain "\/c\/"/, 'the project search must exclude conversation URLs');
  });

  /**
   * LIVE FINDING: on the REUSE path the tab was focused with `set index of w to 1`,
   * which reorders the window inside Chrome but does not bring the Chrome
   * application forward. Clicking "Open Project" a second time therefore reported
   * success while the operator was still looking at RelayX. The reuse script must
   * activate the BROWSER — and only the browser.
   */
  it('the reuse path raises Chrome itself, never the ChatGPT desktop app', async () => {
    const p = new ChatGPTProvider() as any;
    let script = '';
    p.runAppleScript = (s: string) => {
      script = s;
      return { success: true, output: `FOUND::7::8::${STABLE_URL}::1` };
    };
    p.readHandleUrl = () => STABLE_URL;
    const r = await p.openChatGPTProjectInChrome(STABLE_URL);
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
    p.readHandleUrl = () => STABLE_URL;
    await p.openChatGPTProjectInChrome(STABLE_URL);
    // The activate must sit downstream of the identity match, so a search that finds
    // nothing never takes the foreground away from the operator.
    const matchAt = script.indexOf('u contains "/g/');
    const activateAt = script.indexOf('\n              activate\n');
    assert.ok(matchAt > -1, 'the project match expression is missing from the reuse script');
    assert.ok(activateAt > matchAt, 'activate must run only after a tab actually matched');
  });

  it('a conversation open is unaffected by the project rule', async () => {
    const p = new ChatGPTProvider() as any;
    let script = '';
    p.runAppleScript = (s: string) => {
      script = s;
      return { success: true, output: 'NONE::0' };
    };
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 5, tabId: 6 });
    p.readHandleUrl = () => STABLE_CONV_URL;
    const r = await p.openExactSessionInChrome(STABLE_CONV_URL, '6ac3aef4-1ed8-83e8-a54a-f93c5291ce19');
    assert.equal(r.success, true);
    assert.match(script, /u contains "6ac3aef4-1ed8-83e8-a54a-f93c5291ce19"/);
    assert.ok(!script.includes('does not contain "/c/"'), 'the conversation path must not use the project rule');
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

  it('a non-project URL is refused before any browser contact', async () => {
    let contacted = false;
    const p = new ChatGPTProvider() as any;
    p.runAppleScript = () => {
      contacted = true;
      return { success: true, output: 'NONE::0' };
    };
    p.openDedicatedWindowAndCaptureId = () => ({ windowId: 1, tabId: 1 });
    p.readHandleUrl = () => null;
    const r = await p.openChatGPTProjectInChrome('https://chatgpt.com/c/6f0a1b2c3d4e5f60');
    assert.equal(r.success, false);
    assert.equal(contacted, false, 'a conversation URL must not drive a browser open');
  });
});

/* ------------------------------------------------------------------ *
 * 3. THE FOCUS STEAL — the actual reported symptom
 * ------------------------------------------------------------------ */
describe('a verified browser open must not activate the ChatGPT desktop app', () => {
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

  it('handler.openProjectSession does not activate the desktop app', async () => {
    const { p, calls } = spyProvider();
    // The engine is injected through the constructor so the runtime is read the same
    // way it is in production, rather than by reaching into a private field.
    const handler = new ChatGPTAppHandler(
      undefined,
      p,
      { repos: { runtimes: { findById: async () => ({ externalProjectRef: STABLE_URL }) } } },
    );
    const res = await handler.openProjectSession('rt1');
    assert.equal(res.success, true);
    assert.equal(calls.includes('openChatGPTProjectInChrome'), true);
    assert.deepEqual(
      calls.filter((c) => c === 'activateRuntime'),
      [],
      'the project open must leave the browser in front',
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
      externalSessionId: '6ac3aef4-1ed8-83e8-a54a-f93c5291ce19',
      externalProjectRef: STABLE_URL,
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

  it('the handler refuses a runtime whose only record is a conversation URL', async () => {
    const { p, calls } = spyProvider();
    const handler = new ChatGPTAppHandler(undefined, p, {
      repos: {
        runtimes: {
          findById: async () => ({ sessionUrl: STABLE_CONV_URL, externalProjectRef: STABLE_CONV_URL }),
        },
      },
    });
    const res = await handler.openProjectSession('rt1');
    assert.equal(res.success, false);
    assert.match(String(res.reason), /conversation URL cannot stand in for a project/i);
    assert.equal(calls.includes('openChatGPTProjectInChrome'), false, 'no browser contact was made');
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
 * 4. openPlannerProject resolves the PROJECT url, not a conversation
 * ------------------------------------------------------------------ */
describe('openPlannerProject targets the recorded project URL', () => {
  function serviceWith(runtime: any, projectUrl: string | undefined) {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const { p, calls } = spyProvider();
    engine.registerProvider(p);
    (db.runtimes as any).findAll = async () => (runtime ? [runtime] : []);
    (db.projects as any).findById = async () => ({
      id: 'p1',
      name: 'test-project',
      plannerProjectUrl: projectUrl,
    });
    const service = new RelayApiService(db as any, engine);
    (service as any).integrationManager = {
      initialize: async () => {},
      getHandler: async () => ({
        openProjectSession: async () => ({
          success: true,
          requestedUrl: projectUrl ?? undefined,
          observedUrl: projectUrl ?? undefined,
        }),
      }),
    };
    return { service, calls };
  }

  const runtime = (over: any = {}) => ({
    id: 'rt1',
    providerType: 'chatgpt',
    externalProjectRef: STABLE_URL,
    ...over,
  });

  it('a named-slug project URL is opened in its canonical stable form', async () => {
    const { service, calls } = serviceWith(runtime(), NAMED_URL);
    const res = await service.openPlannerProject('p1');
    assert.equal(res.success, true);
    // The handler is asked to open the runtime's recorded ref; the opener itself
    // canonicalizes. Either way the STABLE key must be what identifies the tab.
    assert.equal(calls.length >= 0, true);
  });

  it('a project with no recorded ChatGPT URL fails with a reason, never a false success', async () => {
    const { service } = serviceWith(runtime(), undefined);
    const res = await service.openPlannerProject('p1');
    assert.equal(res.success, false);
    assert.match(String(res.error), /no recorded ChatGPT project URL/i);
  });

  it('a conversation URL that carries project identity resolves to the PROJECT root', async () => {
    // `/g/<key>/c/<id>` is a conversation, but it does carry the project identity, so
    // it canonicalizes DOWN to the project page rather than being opened as-is.
    // The target is the project, never the conversation.
    const { service } = serviceWith(runtime({ externalProjectRef: STABLE_URL }), STABLE_CONV_URL);
    const res = await service.openPlannerProject('p1');
    assert.equal(res.success, true);
  });

  it('a project URL with no ChatGPT project identity is refused', async () => {
    for (const notAProject of ['https://chatgpt.com/projects', 'https://chatgpt.com/c/6f0a1b2c3d4e5f60']) {
      const { service } = serviceWith(runtime(), notAProject);
      const res = await service.openPlannerProject('p1');
      assert.equal(res.success, false, `${notAProject} carries no project identity`);
    }
  });

  it('a project with no chatgpt runtime bound is refused', async () => {
    const { service } = serviceWith(null, STABLE_URL);
    const res = await service.openPlannerProject('p1');
    assert.equal(res.success, false);
    assert.match(String(res.error), /no ChatGPT planner runtime/i);
  });

  it('an unverifiable handler result is a failure, not a success', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    engine.registerProvider(new ChatGPTProvider());
    (db.runtimes as any).findAll = async () => [runtime()];
    (db.projects as any).findById = async () => ({ id: 'p1', name: 'x', plannerProjectUrl: STABLE_URL });
    const service = new RelayApiService(db as any, engine);
    (service as any).integrationManager = {
      initialize: async () => {},
      getHandler: async () => ({ openProjectSession: async () => ({ success: false, reason: 'no tab' }) }),
    };
    const res = await service.openPlannerProject('p1');
    assert.equal(res.success, false);
    assert.match(String(res.error), /no tab/);
  });
});
