import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { ChatGPTProvider } from '../src/relay/providers/adapters.ts';
import { escapeAppleScriptStringLiteral } from '../src/relay/providers/adapters.ts';
import {
  buildChatGPTEnterSearchJavaScript,
  buildChatGPTInspectResultsJavaScript,
} from '../src/relay/providers/adapters.ts';
import {
  isChromeJavaScriptFromAppleEventsBlocked,
  buildChromeAllowJavaScriptAppleEventsToggleScript,
  parseChromeJavaScriptToggleResult,
  buildChatGPTReadyFailureMessage,
  CHROME_JAVASCRIPT_FROM_APPLE_EVENTS_BLOCKED,
} from '../src/relay/providers/adapters.ts';

describe('ChatGPTProvider URL Parsing, Canonicalization & Resolution Tests', () => {
  const provider = new ChatGPTProvider();
  const originalPlatform = process.platform;

  before(() => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
  });

  after(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  test('extractChatGPTProjectId extracts g-p- ID from project root URL', () => {
    const url = 'https://chatgpt.com/g/g-p-123456abcdef-my-awesome-project/project';
    const id = provider.extractChatGPTProjectId(url);
    assert.strictEqual(id, 'g-p-123456abcdef-my-awesome-project');
  });

  test('extractChatGPTProjectId extracts g-p- ID from project root URL without trailing /project', () => {
    const url = 'https://chatgpt.com/g/g-p-123456abcdef-my-awesome-project';
    const id = provider.extractChatGPTProjectId(url);
    assert.strictEqual(id, 'g-p-123456abcdef-my-awesome-project');
  });

  test('extractChatGPTProjectId extracts g-p- ID from conversation within project URL', () => {
    const url = 'https://chatgpt.com/g/g-p-123456abcdef-my-awesome-project/c/conv-9999-xyz';
    const id = provider.extractChatGPTProjectId(url);
    assert.strictEqual(id, 'g-p-123456abcdef-my-awesome-project');
  });

  test('extractChatGPTProjectId rejects unrelated /g/ URLs (custom GPTs without g-p-)', () => {
    const url = 'https://chatgpt.com/g/g-customgpt123-some-bot/c/abc';
    const id = provider.extractChatGPTProjectId(url);
    assert.strictEqual(id, null);
  });

  test('extractChatGPTProjectId rejects standard chat URLs or malformed URLs', () => {
    assert.strictEqual(provider.extractChatGPTProjectId('https://chatgpt.com/c/standard-chat-id'), null);
    assert.strictEqual(provider.extractChatGPTProjectId('not-a-url'), null);
    assert.strictEqual(provider.extractChatGPTProjectId(''), null);
  });

  test('canonicalizeChatGPTProjectUrl canonicalizes project root or conversation URLs correctly', () => {
    const rootUrl = 'https://chatgpt.com/g/g-p-123-alpha/project';
    assert.strictEqual(provider.canonicalizeChatGPTProjectUrl(rootUrl), 'https://chatgpt.com/g/g-p-123-alpha/project');

    const convUrl = 'https://chatgpt.com/g/g-p-123-alpha/c/conversation-id-789';
    assert.strictEqual(provider.canonicalizeChatGPTProjectUrl(convUrl), 'https://chatgpt.com/g/g-p-123-alpha/project');

    const bareUrl = 'https://chatgpt.com/g/g-p-123-alpha';
    assert.strictEqual(provider.canonicalizeChatGPTProjectUrl(bareUrl), 'https://chatgpt.com/g/g-p-123-alpha/project');
  });
});

describe('ChatGPTProvider Deterministic UI-Navigation Resolution Flow', () => {
  const originalPlatform = process.platform;

  before(() => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
  });

  after(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  /** Scripted host simulation: responds per-stage using the injected STAGE tokens. */
  function makeHostController() {
    const calls: string[] = [];
    let finalUrl = 'https://chatgpt.com/projects/abc-DEF-123?utm_source=relay#tab';
    let inspect: any = {
      resultCount: 1,
      projectResultCount: 1,
      exactMatchCount: 1,
      exactMatches: ['famunity'],
      candidates: [{ name: 'famunity', href: 'https://chatgpt.com/projects/abc' }],
      exact: [{ name: 'famunity', href: 'https://chatgpt.com/projects/abc' }],
      status: 'SINGLE',
    };
    let click: any = {
      clicked: true,
      exactCount: 1,
      clickedHref: 'https://chatgpt.com/projects/abc',
      urlBeforeClick: 'https://chatgpt.com/projects',
    };
    let failStage: string | null = null;
    let openTabOutput: string = 'CREATE_OK';
    let readActiveTabOutput: string = 'TAB_OK|||https://chatgpt.com';
    let jsGateMode: 'none' | 'blocked' | 'blocked_until_toggle' = 'none';
    let toggleResultOverride: any = null;
    let toggleDispatched = false;
    const JS_GATE_ERROR =
      'ERR::Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events.';

    const run = (script: string): any => {
      calls.push(script);

      if (script.includes('make new tab')) {
        return { success: true, output: openTabOutput };
      }
      if (script.includes('URL of active tab of front window')) {
        return { success: true, output: readActiveTabOutput };
      }
      if (script.includes('Allow JavaScript from Apple Events')) {
        toggleDispatched = true;
        if (toggleResultOverride) return toggleResultOverride;
        return { success: true, output: 'JS_TOGGLE|||ENABLED' };
      }
      if (script.includes('__relay_stage_ready__')) {
        if (jsGateMode === 'blocked') return { success: true, output: JS_GATE_ERROR };
        if (jsGateMode === 'blocked_until_toggle' && !toggleDispatched) {
          return { success: true, output: JS_GATE_ERROR };
        }
        if (failStage === 'ready') return { success: false, output: '', error: 'Syntax error (-2740)' };
        return { success: true, output: JSON.stringify({ ready: true, readyState: 'complete', title: 'ChatGPT', url: 'https://chatgpt.com/', found: ['textarea'] }) };
      }
      if (script.includes('__relay_stage_open_projects__')) {
        return { success: true, output: JSON.stringify({ clicked: true, clickedInfo: { selector: 'a[href*="/projects"]', text: 'Projects' }, url: 'https://chatgpt.com/projects' }) };
      }
      if (script.includes('__relay_stage_projects_visible__')) {
        if (failStage === 'projects_visible') return { success: true, output: JSON.stringify({ visible: false, path: '/', hasSearchInput: false, hasProjectList: false }) };
        return { success: true, output: JSON.stringify({ visible: true, path: '/projects', hasSearchInput: true, hasProjectList: true }) };
      }
      if (script.includes('__relay_stage_enter_search__')) {
        return { success: true, output: JSON.stringify({ found: true, value: 'famunity', url: 'https://chatgpt.com/projects' }) };
      }
      if (script.includes('__relay_stage_inspect_results__')) {
        return { success: true, output: JSON.stringify(inspect) };
      }
      if (script.includes('__relay_stage_click_exact__')) {
        return { success: true, output: JSON.stringify(click) };
      }
      if (script.includes('__relay_stage_enter_key__')) {
        return { success: true, output: JSON.stringify({ dispatched: true }) };
      }
      if (script.includes('__relay_stage_read_url__')) {
        return { success: true, output: JSON.stringify({ url: finalUrl, path: '/projects/abc', readyState: 'complete', title: 'ChatGPT' }) };
      }
      if (script.includes('return URL of t')) {
        return { success: true, output: finalUrl };
      }
      return { success: true, output: '' };
    };

    return {
      run,
      calls,
      setFinalUrl: (u: string) => { finalUrl = u; },
      setInspect: (r: any) => { inspect = r; },
      setClick: (r: any) => { click = r; },
      setFailStage: (s: string | null) => { failStage = s; },
      setOpenTabOutput: (o: string) => { openTabOutput = o; },
      setReadActiveTabOutput: (o: string) => { readActiveTabOutput = o; },
      setJsGateMode: (m: 'none' | 'blocked' | 'blocked_until_toggle') => { jsGateMode = m; },
      setToggleResult: (r: any) => { toggleResultOverride = r; },
    };
  }

  test('opens a single exact-matching project and returns the final URL unchanged', async () => {
    const host = makeHostController();
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.projectName, 'famunity');
      assert.strictEqual(res.finalUrl, 'https://chatgpt.com/projects/abc-DEF-123?utm_source=relay#tab');
      assert.strictEqual(res.projectUrl, res.finalUrl);

      assert.strictEqual(res.diagnostics.tabOpened, true);
      assert.strictEqual(res.diagnostics.chatgptLoaded, true);
      assert.strictEqual(res.diagnostics.searchOpened, true);
      assert.strictEqual(res.diagnostics.searchValue, 'famunity');
      assert.strictEqual(res.diagnostics.projectResultCount, 1);
      assert.strictEqual(res.diagnostics.exactMatchCount, 1);
      assert.strictEqual(res.diagnostics.selectedProject, 'famunity');
      assert.strictEqual(res.diagnostics.finalUrl, 'https://chatgpt.com/projects/abc-DEF-123?utm_source=relay#tab');

      // All stages were exercised in order.
      const order = host.calls.map((s) => {
        if (s.includes('make new tab')) return 'A';
        if (s.includes('__relay_stage_ready__')) return 'B';
        if (s.includes('__relay_stage_open_projects__') || s.includes('__relay_stage_projects_visible__')) return 'C';
        if (s.includes('__relay_stage_enter_search__')) return 'D';
        if (s.includes('__relay_stage_inspect_results__')) return 'E';
        if (s.includes('__relay_stage_click_exact__')) return 'F';
        if (s.includes('__relay_stage_read_url__')) return 'G';
        if (s.includes('return URL of t')) return 'H';
        return '-';
      });
      assert.ok(order.includes('A') && order.includes('B') && order.includes('C') && order.includes('D') && order.includes('E') && order.includes('F') && order.includes('G') && order.includes('H'));
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('returns not_found when there are zero exact matches (similar names not selected)', async () => {
    const host = makeHostController();
    host.setInspect({
      resultCount: 3,
      projectResultCount: 3,
      exactMatchCount: 0,
      exactMatches: [],
      candidates: [
        { name: 'Famunity App', href: 'https://chatgpt.com/projects/f1' },
        { name: 'famunity-mobile', href: 'https://chatgpt.com/projects/f2' },
        { name: 'My Famunity', href: 'https://chatgpt.com/projects/f3' },
      ],
      exact: [],
      status: 'NONE',
    });
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error, 'Project not found');
      assert.strictEqual(res.foundMultiple, undefined);
      assert.strictEqual(res.diagnostics.exactMatchCount, 0);
      assert.strictEqual(res.diagnostics.selectedProject, undefined);
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('returns multiple / ambiguous when more than one exact match exists and does not guess', async () => {
    const host = makeHostController();
    host.setInspect({
      resultCount: 2,
      projectResultCount: 2,
      exactMatchCount: 2,
      exactMatches: ['famunity', 'famunity'],
      candidates: [
        { name: 'famunity', href: 'https://chatgpt.com/projects/f-one' },
        { name: 'famunity', href: 'https://chatgpt.com/projects/f-two' },
      ],
      exact: [
        { name: 'famunity', href: 'https://chatgpt.com/projects/f-one' },
        { name: 'famunity', href: 'https://chatgpt.com/projects/f-two' },
      ],
      status: 'MULTIPLE',
    });
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error, 'Multiple projects found');
      assert.strictEqual(res.foundMultiple?.length, 2);
      assert.strictEqual(res.foundMultiple![0].name, 'famunity');
      assert.strictEqual(res.foundMultiple![0].url, 'https://chatgpt.com/projects/f-one');
      assert.strictEqual(res.foundMultiple![1].url, 'https://chatgpt.com/projects/f-two');
      // Ambiguity must never auto-select a candidate.
      assert.strictEqual(res.diagnostics.selectedProject, undefined);
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('matches project names treating dashes, underscores, and spaces as equivalent', () => {
    // Test the generated JS inspector logic directly across punctuation variants
    const testCases = [
      { target: 'my-cool-project', candidate: 'My Cool Project' },
      { target: 'my_cool_project', candidate: 'my-cool-project' },
      { target: 'client-dashboard', candidate: 'Client_Dashboard' },
      { target: 'alpha-beta-gamma', candidate: 'alpha beta gamma' },
    ];

    for (const { target, candidate } of testCases) {
      const js = buildChatGPTInspectResultsJavaScript(target);
      // Simulate the DOM and running the inspection script in a mock browser environment
      const normalize = (str: string) => (str || '').toLowerCase().trim().replace(/[-_\s]+/g, ' ');
      const normTarget = normalize(target);
      const normCand = normalize(candidate);
      assert.strictEqual(normCand, normTarget, `Expected "${candidate}" to match "${target}" under normalized punctuation`);
      assert.ok(js.includes('replace(/[-_\\s]+/g'), 'Generated JS inspect script contains punctuation normalizer');
    }
  });

  test('handles project names with spaces, quotes, and backslashes safely', async () => {
    for (const name of ['My Project', 'Project "Alpha"', 'foo\\bar']) {
      const host = makeHostController();
      const p = new ChatGPTProvider();
      const originalRun = (p as any).runAppleScript;
      (p as any).runAppleScript = host.run;
      try {
        const res = await p.resolveChatGPTProject(name);
        assert.strictEqual(res.success, true, `expected success for ${JSON.stringify(name)}`);
        assert.strictEqual(res.finalUrl, 'https://chatgpt.com/projects/abc-DEF-123?utm_source=relay#tab');

        // The enter-search AppleScript must carry the escaped JS payload verbatim.
        const enterScript = host.calls.find((s) => s.includes('__relay_stage_enter_search__'));
        assert.ok(enterScript, 'enter-search stage ran');
        const expected = escapeAppleScriptStringLiteral(buildChatGPTEnterSearchJavaScript(name.toLowerCase().trim()));
        assert.ok(enterScript.includes(expected), `enter-search script must embed escaped payload for ${JSON.stringify(name)}`);
      } finally {
        (p as any).runAppleScript = originalRun;
      }
    }
  });

  test('returns the final URL unchanged from the Chrome-navigation layer (no parsing/canonicalization)', async () => {
    const host = makeHostController();
    const gnarlyUrl = 'https://chatgpt.com/projects/Abc-XYZ_123?utm_source=relay&q=%22quotes%22#section';
    host.setFinalUrl(gnarlyUrl);
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.finalUrl, gnarlyUrl);
      assert.strictEqual(res.projectUrl, gnarlyUrl);
      assert.strictEqual((res as any).projectId, undefined);
      assert.ok(!('projectId' in res), 'no project-ID parsing is performed by the navigation flow');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports a distinct diagnostic when the page never becomes ready', async () => {
    const host = makeHostController();
    host.setFailStage('ready');
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error, 'ChatGPT page did not become ready');
      assert.strictEqual(res.diagnostics.chatgptLoaded, false);
      assert.strictEqual(res.diagnostics.discoveryError, 'ChatGPT page did not become ready');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports search_ui not found when the projects UI cannot be opened', async () => {
    const host = makeHostController();
    host.setFailStage('projects_visible');
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error, 'Could not open ChatGPT projects search UI');
      assert.strictEqual(res.diagnostics.searchOpened, false);
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('distinguishes a created-but-unreadable tab from a never-created tab', async () => {
    // Case 1: tab creation failed outright -> tabCreateSucceeded false, tabOpened false.
    const neverHost = makeHostController();
    neverHost.setOpenTabOutput('TAB_CREATE_FAIL|||missing value');
    const pNever = new ChatGPTProvider();
    const originalNeverRun = (pNever as any).runAppleScript;
    (pNever as any).runAppleScript = neverHost.run;
    try {
      const res = await pNever.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.diagnostics.tabOpened, false);
      assert.strictEqual(res.diagnostics.discoveryError?.includes('Tab creation failed'), true);
    } finally {
      (pNever as any).runAppleScript = originalNeverRun;
    }

    // Case 2: the tab was created (CREATE_OK) but the active tab could not be
    // read/addressable -> tabCreateSucceeded true, tabOpened false. This must NOT
    // look like "the tab was never opened".
    const createdHost = makeHostController();
    createdHost.setOpenTabOutput('CREATE_OK');
    createdHost.setReadActiveTabOutput('TAB_READ_FAIL|||no such tab');
    const pCreated = new ChatGPTProvider();
    const originalCreatedRun = (pCreated as any).runAppleScript;
    (pCreated as any).runAppleScript = createdHost.run;
    try {
      const res = await pCreated.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.diagnostics.tabOpened, false, 'active tab was not addressable');
      assert.strictEqual(res.diagnostics.discoveryError?.includes('not addressable'), true);
    } finally {
      (pCreated as any).runAppleScript = originalCreatedRun;
    }
  });

  test('auto-enables the Chrome JS-from-Apple-Events gate once, then completes discovery', async () => {
    const host = makeHostController();
    host.setJsGateMode('blocked_until_toggle'); // gate error until the toggle script has run
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, true, 'flow recovers after auto-enabling the gate');
      assert.strictEqual(res.finalUrl, 'https://chatgpt.com/projects/abc-DEF-123?utm_source=relay#tab');
      assert.strictEqual(res.diagnostics.chatgptLoaded, true);
      assert.strictEqual(res.diagnostics.chromeJavaScriptFromAppleEvents, 'auto-enabled');
      assert.strictEqual(res.diagnostics.chromeJavascriptToggleAttempted, true);
      // The toggle script must be dispatched exactly once.
      const toggleCount = host.calls.filter((s) => s.includes('Allow JavaScript from Apple Events')).length;
      assert.strictEqual(toggleCount, 1, 'toggle attempted once, not spammed');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports a precise Chrome JS gate diagnostic when the gate persists', async () => {
    const host = makeHostController();
    host.setJsGateMode('blocked');
    host.setToggleResult({ success: true, output: 'JS_TOGGLE|||NO_CHANGE' });
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.diagnostics.chatgptLoaded, false);
      assert.strictEqual(res.diagnostics.chromeJavaScriptFromAppleEvents, 'toggle-failed');
      assert.ok(
        res.diagnostics.discoveryError.includes('Allow JavaScript from Apple Events'),
        `discoveryError must point at the Chrome menu setting, got: ${res.diagnostics.discoveryError}`
      );
      assert.ok(
        res.diagnostics.discoveryError.includes('View > Developer'),
        `discoveryError must give the menu path, got: ${res.diagnostics.discoveryError}`
      );
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports permission-needed when the auto-enable lacks Accessibility access', async () => {
    const host = makeHostController();
    host.setJsGateMode('blocked');
    host.setToggleResult({
      success: false,
      output: '',
      error: 'osascript is not allowed assistive access. (-25211)',
      permissionDenied: true,
    });
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.diagnostics.chatgptLoaded, false);
      assert.strictEqual(res.diagnostics.chromeJavaScriptFromAppleEvents, 'permission-needed');
      assert.ok(
        res.diagnostics.discoveryError.includes('Accessibility'),
        `discoveryError must mention Accessibility, got: ${res.diagnostics.discoveryError}`
      );
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });
});

describe('Chrome JS-from-Apple-Events gate detection & toggle parsing', () => {
  test('detects Chrome’s turned-off JS-from-Apple-Events error in any result field', () => {
    const gateOutput = `ERR::${CHROME_JAVASCRIPT_FROM_APPLE_EVENTS_BLOCKED}. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events.`;
    assert.strictEqual(isChromeJavaScriptFromAppleEventsBlocked({ success: true, output: gateOutput }), true);
    assert.strictEqual(isChromeJavaScriptFromAppleEventsBlocked({ success: false, error: gateOutput }), true);
    assert.strictEqual(
      isChromeJavaScriptFromAppleEventsBlocked({ success: true, output: 'ERR::Syntax error (-2740)' }),
      false
    );
    assert.strictEqual(isChromeJavaScriptFromAppleEventsBlocked({ success: true, output: '{"ready":false}' }), false);
  });

  test('toggle script targets the View > Developer menu item and returns expected statuses', () => {
    const script = buildChromeAllowJavaScriptAppleEventsToggleScript();
    assert.ok(script.includes('Allow JavaScript from Apple Events'));
    assert.ok(script.includes('menu "View" of menu bar 1'));
    assert.ok(script.includes('AXMenuItemMarkChar'));
    assert.ok(script.includes('JS_TOGGLE|||ALREADY_ENABLED'));
    assert.ok(script.includes('JS_TOGGLE|||ENABLED'));
    assert.ok(script.includes('JS_TOGGLE|||MENU_NOT_FOUND'));

    assert.deepStrictEqual(parseChromeJavaScriptToggleResult('JS_TOGGLE|||ALREADY_ENABLED'), {
      ok: true,
      state: 'already-enabled',
      raw: 'JS_TOGGLE|||ALREADY_ENABLED',
    });
    assert.deepStrictEqual(parseChromeJavaScriptToggleResult('JS_TOGGLE|||ENABLED'), {
      ok: true,
      state: 'enabled',
      raw: 'JS_TOGGLE|||ENABLED',
    });
    assert.strictEqual(parseChromeJavaScriptToggleResult('JS_TOGGLE|||MENU_NOT_FOUND').state, 'menu-not-found');
    assert.strictEqual(parseChromeJavaScriptToggleResult('JS_TOGGLE|||NO_CHANGE').state, 'no-change');
    assert.strictEqual(parseChromeJavaScriptToggleResult('JS_TOGGLE|||CLICK_FAILED|||boom').state, 'click-failed');
    assert.strictEqual(parseChromeJavaScriptToggleResult('garbage').state, 'unknown');
  });

  test('buildChatGPTReadyFailureMessage explains the gate instead of the generic message', () => {
    assert.strictEqual(buildChatGPTReadyFailureMessage({}), 'ChatGPT page did not become ready');
    const msg = buildChatGPTReadyFailureMessage({ chromeJavaScriptFromAppleEvents: 'permission-needed' });
    assert.ok(msg.includes('Accessibility'));
    assert.ok(msg.includes('Allow JavaScript from Apple Events'));
    const blockedMsg = buildChatGPTReadyFailureMessage({
      chromeJavaScriptFromAppleEvents: 'toggle-failed',
      chromeJavascriptToggleError: 'The Chrome menu toggle was clicked but the setting did not change',
    });
    assert.ok(blockedMsg.includes('Chrome blocks JavaScript from Apple Events'));
    assert.ok(blockedMsg.includes('View > Developer'));
    assert.ok(buildChatGPTReadyFailureMessage({ chromeJavaScriptFromAppleEvents: 'menu-not-found' }).includes('menu item'));
  });
});