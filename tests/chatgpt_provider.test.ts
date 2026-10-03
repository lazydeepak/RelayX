/**
 * ChatGPT PROJECT discovery — new `/projects` GUI flow.
 *
 * Replaces the obsolete `chatgpt.com -> Cmd+K -> search -> navigate result`
 * project path. Regression coverage for the new sequence lives in
 * `chatgpt_project_discovery.test.ts`; this file keeps the provider-level
 * contract tests and the Chrome JS-gate tests that were already here.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { ChatGPTProvider, escapeAppleScriptStringLiteral } from '../src/relay/providers/adapters.ts';
import {
  buildChatGPTProjectSearchInputAppleScript,
  buildChatGPTProjectResultNavigationAppleScript,
  DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE,
} from '../src/relay/providers/chatgptProjectDiscovery.ts';
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

  test('project discovery helpers escape the project name into AppleScript safely', () => {
    const script = buildChatGPTProjectSearchInputAppleScript(
      DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE,
      'My Project "Alpha"\\beta',
    );
    assert.ok(
      script.includes(escapeAppleScriptStringLiteral('My Project "Alpha"\\beta')),
      'the pasted project name is escaped for AppleScript embedding',
    );
  });
});

describe('ChatGPTProvider Project discovery — /projects sequence', () => {
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

  /** Scripted host simulation for the new Projects-route flow. */
  function makeProjectsHostController() {
    const calls: string[] = [];
    // `locationUrl` tracks the browser's actual location: it starts on the
    // Projects route and switches to `settledUrl` only once the Tab+Enter stage
    // has been dispatched, mirroring the real sequence.
    let settledUrl = 'https://chatgpt.com/g/g-p-abc123/project';
    let navigated = false;
    let stuckOnProjectsRoute = false;
    let searchFocus: any = { found: true, focused: true, path: '/projects', url: 'https://chatgpt.com/projects' };
    let searchValue: any = { found: true, value: 'famunity', url: 'https://chatgpt.com/projects' };
    let readyOutput: any = { ready: true, readyState: 'complete', title: 'Projects', url: 'https://chatgpt.com/projects', found: ['input[type="search"]'] };
    let openTabOutput = 'CREATE_OK';
    let readActiveTabOutput = 'TAB_OK|||https://chatgpt.com/projects';
    let jsGateMode: 'none' | 'blocked' | 'blocked_until_toggle' = 'none';
    let toggleResultOverride: any = null;
    let toggleDispatched = false;
    let inputScriptResult: any = { success: true, output: '' };
    let navScriptResult: any = { success: true, output: '' };
    // Overrides the results signature so a test can simulate a list that keeps
    // re-rendering (never settling) or one that settles late.
    let resultsSignatureOverride: any = null;
    let tabUrlReads = 0;
    const JS_GATE_ERROR =
      'ERR::Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events.';

    const run = (script: string): any => {
      calls.push(script);

      if (script.includes('Allow JavaScript from Apple Events')) {
        toggleDispatched = true;
        if (toggleResultOverride) return toggleResultOverride;
        return { success: true, output: 'JS_TOGGLE|||ENABLED' };
      }
      if (script.includes('make new tab')) {
        return { success: true, output: openTabOutput };
      }
      if (script.includes('URL of active tab of front window')) {
        return { success: true, output: readActiveTabOutput };
      }
      if (script.includes('__relay_stage_ready__')) {
        if (jsGateMode === 'blocked') return { success: true, output: JS_GATE_ERROR };
        if (jsGateMode === 'blocked_until_toggle' && !toggleDispatched) {
          return { success: true, output: JS_GATE_ERROR };
        }
        return { success: true, output: JSON.stringify(readyOutput) };
      }
      if (script.includes('__relay_stage_projects_search_focus__')) {
        if (jsGateMode === 'blocked') return { success: true, output: JS_GATE_ERROR };
        return { success: true, output: JSON.stringify(searchFocus) };
      }
      if (script.includes('__relay_stage_projects_search_value__')) {
        if (jsGateMode === 'blocked') return { success: true, output: JS_GATE_ERROR };
        return { success: true, output: JSON.stringify(searchValue) };
      }
      if (script.includes('__relay_stage_projects_results_signature__')) {
        if (jsGateMode === 'blocked') return { success: true, output: JS_GATE_ERROR };
        if (resultsSignatureOverride !== null) return { success: true, output: JSON.stringify(resultsSignatureOverride) };
        return {
          success: true,
          output: JSON.stringify({
            count: 39,
            names: ['RelayX', 'RelayLoop'],
            focusables: 207,
            url: 'https://chatgpt.com/projects',
          }),
        };
      }
      if (script.includes('__relay_stage_read_url__')) {
        const url = navigated && !stuckOnProjectsRoute ? settledUrl : 'https://chatgpt.com/projects';
        return { success: true, output: JSON.stringify({ url, readyState: 'complete', title: 'ChatGPT' }) };
      }
      // Stage 3-4: paste the project name + Return.
      if (script.includes('set the clipboard to')) return inputScriptResult;
      // Stages 6-7: Tab x N + Return.
      if (script.includes('repeat ') && script.includes('key code 48')) {
        const res = navScriptResult;
        if (res.success) navigated = true;
        return res;
      }
      if (script.includes('return URL of t')) {
        tabUrlReads += 1;
        return { success: true, output: stuckOnProjectsRoute ? 'https://chatgpt.com/projects' : settledUrl };
      }
      return { success: true, output: '' };
    };

    return {
      run,
      calls,
      /** The URL the browser settles on after the Tab+Enter stage. */
      setSettledUrl: (u: string) => { settledUrl = u; },
      /** Simulate Tab+Enter landing nowhere (browser stays on /projects). */
      setStuckOnProjectsRoute: (v: boolean) => { stuckOnProjectsRoute = v; },
      setSearchFocus: (v: any) => { searchFocus = v; },
      setSearchValue: (v: any) => { searchValue = v; },
      setReadyOutput: (v: any) => { readyOutput = v; },
      setOpenTabOutput: (v: string) => { openTabOutput = v; },
      setReadActiveTabOutput: (v: string) => { readActiveTabOutput = v; },
      setJsGateMode: (m: 'none' | 'blocked' | 'blocked_until_toggle') => { jsGateMode = m; },
      setToggleResult: (v: any) => { toggleResultOverride = v; },
      setInputScriptResult: (v: any) => { inputScriptResult = v; },
      setNavScriptResult: (v: any) => { navScriptResult = v; },
      setResultsSignature: (v: any) => { resultsSignatureOverride = v; },
      tabUrlReads: () => tabUrlReads,
    };
  }

  test('opens /projects, enters the project name, Tab x 7 + Return, then reads the URL', async () => {
    const host = makeProjectsHostController();
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      host.setSettledUrl('https://chatgpt.com/g/g-p-abc123/project');
      const res = await p.resolveChatGPTProject('famunity');

      assert.strictEqual(res.success, true, res.error ?? '');
      assert.strictEqual(res.projectName, 'famunity');
      assert.strictEqual(res.finalUrl, 'https://chatgpt.com/g/g-p-abc123/project');
      assert.strictEqual(res.projectUrl, res.finalUrl);

      const d = res.diagnostics;
      assert.strictEqual(d.tabOpened, true);
      assert.strictEqual(d.chatgptLoaded, true);
      assert.strictEqual(d.projectsPageReady, true);
      assert.strictEqual(d.searchFieldFocused, true);
      assert.strictEqual(d.searchSubmitted, true);
      assert.strictEqual(d.searchValue, 'famunity');
      // The results list is awaited as evidence before focus is walked.
      assert.strictEqual(d.projectsResultsCount, 39);
      assert.ok(d.projectsResultsSettledAttempts >= 3, 'results settle is polled, not slept');
      assert.strictEqual(d.resultTabCount, 7);
      assert.strictEqual(d.resultNavigationDispatched, true);
      assert.strictEqual(d.projectOpened, true);
      assert.strictEqual(d.parsedProjectId, 'g-p-abc123');
      assert.strictEqual(d.discoveryStage, undefined);
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('the discovery tab is opened directly on /projects, never on the chatgpt.com root', async () => {
    const host = makeProjectsHostController();
    host.setSettledUrl('https://chatgpt.com/g/g-p-abc123/project');
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      await p.resolveChatGPTProject('famunity');
      const tabScript = host.calls.find((s) => s.includes('make new tab'));
      assert.ok(tabScript, 'a discovery tab was created');
      assert.ok(
        tabScript.includes('https://chatgpt.com/projects'),
        `the discovery tab must open /projects, got: ${tabScript}`,
      );
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('the obsolete Cmd+K project-search path is never dispatched', async () => {
    const host = makeProjectsHostController();
    host.setSettledUrl('https://chatgpt.com/g/g-p-abc123/project');
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      await p.resolveChatGPTProject('famunity');
      const cmdK = host.calls.filter((s) => /keystroke\s+"?k"?\s+using command down/i.test(s));
      assert.deepStrictEqual(cmdK, [], `Cmd+K must not be used for project discovery: ${JSON.stringify(cmdK)}`);
      const obsoleteStages = host.calls.filter((s) =>
        /__relay_stage_(open_projects|projects_visible|enter_search|inspect_results|click_exact|enter_key)__/.test(s),
      );
      assert.deepStrictEqual(obsoleteStages, [], 'obsolete Cmd+K DOM-search stages must not run');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('the RelayX project name is pasted into the Projects search, verbatim', async () => {
    const host = makeProjectsHostController();
    host.setSearchValue({ found: true, value: 'My RelayX Project', url: 'https://chatgpt.com/projects' });
    host.setSettledUrl('https://chatgpt.com/g/g-p-abc123/project');
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('My RelayX Project');
      assert.strictEqual(res.success, true, res.error ?? '');
      const pasteScript = host.calls.find((s) => s.includes('set the clipboard to'));
      assert.ok(pasteScript, 'the project-name input stage ran');
      assert.ok(
        pasteScript.includes('My RelayX Project'),
        'the RelayX project name reaches the paste stage',
      );
      assert.ok(pasteScript.includes('keystroke "v" using command down'), 'the name is pasted');
      assert.ok(pasteScript.includes('key code 36'), 'Return is pressed to submit the search');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('the result-navigation stage performs Tab x 7 then Return', async () => {
    const host = makeProjectsHostController();
    host.setSettledUrl('https://chatgpt.com/g/g-p-abc123/project');
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, true, res.error ?? '');
      const navScript = host.calls.find((s) => s.includes('repeat 7 times') && s.includes('key code 48'));
      assert.ok(navScript, 'a Tab x 7 loop was dispatched');
      assert.ok(navScript.includes('key code 48'), 'tabs use the Tab key code');
      assert.ok(navScript.includes('key code 36'), 'Enter follows the tab sequence');
      // Tab and Return counts are ordered: 7 tabs before the confirming Return.
      assert.ok(
        navScript.indexOf('repeat 7 times') < navScript.indexOf('key code 36'),
        'all tabs precede the Return',
      );
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('the Tab count is driven by the configured integration script, not hardcoded', async () => {
    const host = makeProjectsHostController();
    host.setSettledUrl('https://chatgpt.com/g/g-p-abc123/project');
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      p.applyProjectDiscoveryScript(
        [
          'open https://chatgpt.com/projects',
          'input {{projectName}}',
          'Enter',
          'Tab x 3',
          'Enter',
          'capture current URL',
        ].join('\n'),
      );
      assert.ok(p.getProjectDiscoveryScript().includes('Tab x 3'));
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, true, res.error ?? '');
      assert.strictEqual(res.diagnostics.resultTabCount, 3);
      assert.ok(host.calls.some((s) => s.includes('repeat 3 times')), 'the edited Tab count is dispatched');
      assert.ok(!host.calls.some((s) => s.includes('repeat 7 times')), 'the old Tab count is not used');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('the final Project URL is captured through the existing URL-reading mechanism', async () => {
    const host = makeProjectsHostController();
    const gnarly = 'https://chatgpt.com/g/g-p-abc123/project?utm_source=relay#tab';
    host.setSettledUrl(gnarly);
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, true, res.error ?? '');
      // Returned exactly as observed — no canonicalization in the navigation layer.
      assert.strictEqual(res.finalUrl, gnarly);
      assert.strictEqual(res.projectUrl, gnarly);
      assert.strictEqual(res.diagnostics.parsedProjectId, 'g-p-abc123');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports OPEN_PROJECTS_PAGE_FAILED when the Projects tab cannot be created', async () => {
    const host = makeProjectsHostController();
    host.setOpenTabOutput('TAB_CREATE_FAIL|||missing value');
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.ok((res.error ?? '').startsWith('OPEN_PROJECTS_PAGE_FAILED:'), res.error ?? '');
      assert.strictEqual(res.diagnostics.discoveryStage, 'OPEN_PROJECTS_PAGE_FAILED');
      assert.strictEqual(res.diagnostics.tabOpened, false);
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports PROJECT_SEARCH_INPUT_FAILED when the Projects search field cannot be focused', async () => {
    const host = makeProjectsHostController();
    host.setSearchFocus({ found: false, focused: false, path: '/projects', url: 'https://chatgpt.com/projects' });
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.ok((res.error ?? '').startsWith('PROJECT_SEARCH_INPUT_FAILED:'), res.error ?? '');
      assert.strictEqual(res.diagnostics.discoveryStage, 'PROJECT_SEARCH_INPUT_FAILED');
      assert.strictEqual(res.diagnostics.searchFieldFocused, false);
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('waits on the filtered results settling before walking focus (live-verified)', async () => {
    const host = makeProjectsHostController();
    host.setSettledUrl('https://chatgpt.com/g/g-p-abc123/project');
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, true, res.error ?? '');
      const order = host.calls.map((s) => {
        if (s.includes('__relay_stage_projects_search_value__')) return 'SEARCH';
        if (s.includes('__relay_stage_projects_results_signature__')) return 'RESULTS';
        if (s.includes('repeat ') && s.includes('key code 48')) return 'TABS';
        return '-';
      });
      // Results must be observed stable across a minimum observation window
      // BEFORE the tab walk is dispatched (live-measured requirement).
      assert.ok(order.includes('RESULTS'), 'results settle is polled');
      const resultsReads = order.filter((o) => o === 'RESULTS').length;
      assert.ok(resultsReads >= 3, `results are observed at least 3 times, got ${resultsReads}`);
      assert.ok(order.indexOf('TABS') > order.lastIndexOf('RESULTS'), 'tabbing happens after the results settle');
      assert.ok(res.diagnostics.projectsResultsSettleMs >= 2500, 'settle window is bounded by evidence, not one read');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports PROJECT_SEARCH_SUBMIT_FAILED when the filtered results never settle', async () => {
    const host = makeProjectsHostController();
    // The tabbable-control count keeps changing, mirroring the real UI where the
    // filtered rows only become tabbable late. The walk must never proceed.
    let n = 0;
    host.setResultsSignature(null);
    const base = host.run;
    (host as any).run = (script: string) => {
      if (script.includes('__relay_stage_projects_results_signature__')) {
        n += 1;
        return {
          success: true,
          output: JSON.stringify({ count: 39, names: ['RelayX'], focusables: 200 + n, url: 'https://chatgpt.com/projects' }),
        };
      }
      return base(script);
    };
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = (host as any).run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.ok((res.error ?? '').startsWith('PROJECT_SEARCH_SUBMIT_FAILED:'), res.error ?? '');
      assert.strictEqual(res.diagnostics.discoveryStage, 'PROJECT_SEARCH_SUBMIT_FAILED');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports PROJECT_SEARCH_SUBMIT_FAILED when the search never accepts the project name', async () => {
    const host = makeProjectsHostController();
    host.setSearchValue({ found: true, value: '', url: 'https://chatgpt.com/projects' });
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.ok((res.error ?? '').startsWith('PROJECT_SEARCH_SUBMIT_FAILED:'), res.error ?? '');
      assert.strictEqual(res.diagnostics.discoveryStage, 'PROJECT_SEARCH_SUBMIT_FAILED');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports PROJECT_RESULT_NAVIGATION_FAILED when the tab+enter keystrokes cannot execute', async () => {
    const host = makeProjectsHostController();
    host.setNavScriptResult({ success: false, output: '', error: 'osascript is not allowed assistive access. (-25211)' });
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.ok((res.error ?? '').startsWith('PROJECT_RESULT_NAVIGATION_FAILED:'), res.error ?? '');
      assert.strictEqual(res.diagnostics.discoveryStage, 'PROJECT_RESULT_NAVIGATION_FAILED');
      assert.strictEqual(res.diagnostics.resultNavigationDispatched, false);
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports PROJECT_OPEN_FAILED when Tab x 7 + Return never leaves the Projects route', async () => {
    const host = makeProjectsHostController();
    // URL never becomes a Project URL.
    host.setStuckOnProjectsRoute(true);
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.ok((res.error ?? '').startsWith('PROJECT_OPEN_FAILED:'), res.error ?? '');
      assert.strictEqual(res.diagnostics.discoveryStage, 'PROJECT_OPEN_FAILED');
      assert.strictEqual(res.diagnostics.projectOpened, false);
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports PROJECT_ID_PARSE_FAILED and binds nothing for a conversation-only URL', async () => {
    const host = makeProjectsHostController();
    // Tab x 7 + Return landed on a conversation, not on the Project page. A
    // `/c/<conversationId>` URL is SESSION identity and must never be bound.
    host.setSettledUrl('https://chatgpt.com/c/conv-1234');
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      // Navigation completed (the browser left /projects) but the destination
      // carries no Project identity, so discovery fails closed at the parse
      // stage instead of binding a conversation ID as a Project.
      assert.strictEqual(res.success, false);
      assert.ok((res.error ?? '').startsWith('PROJECT_ID_PARSE_FAILED:'), res.error ?? '');
      assert.strictEqual(res.finalUrl, undefined);
      assert.strictEqual(res.projectUrl, undefined);
      assert.strictEqual(res.diagnostics.discoveryStage, 'PROJECT_ID_PARSE_FAILED');
      assert.strictEqual(res.diagnostics.parsedProjectId, null);
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('rejects a configured discovery script that still targets the obsolete Cmd+K flow', async () => {
    const host = makeProjectsHostController();
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      p.applyProjectDiscoveryScript('open https://chatgpt.com\ninput {{projectName}}\nEnter\ncapture current URL');
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.diagnostics.discoveryStage, 'OPEN_PROJECTS_PAGE_FAILED');
      assert.ok(res.diagnostics.projectDiscoveryScriptError, 'the unusable script is reported');
      assert.ok(
        res.diagnostics.projectDiscoveryScriptError.includes('https://chatgpt.com/projects'),
        'the operator is told what the script must open',
      );
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('diagnostics report the failed stage without leaking raw script internals', async () => {
    const host = makeProjectsHostController();
    host.setNavScriptResult({ success: false, output: '', error: 'boom' });
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      const serialized = JSON.stringify(res.diagnostics);
      assert.strictEqual(res.diagnostics.discoveryStage, 'PROJECT_RESULT_NAVIGATION_FAILED');
      assert.ok(!serialized.includes('tell application'), 'no AppleScript body is exposed');
      assert.ok(!serialized.includes('keystroke'), 'no keystroke internals are exposed');
      assert.ok(!serialized.includes('repeat '), 'no tab-loop internals are exposed');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('auto-enables the Chrome JS-from-Apple-Events gate once, then completes discovery', async () => {
    const host = makeProjectsHostController();
    host.setJsGateMode('blocked_until_toggle');
    host.setSettledUrl('https://chatgpt.com/g/g-p-abc123/project');
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, true, res.error ?? '');
      assert.strictEqual(res.diagnostics.chatgptLoaded, true);
      assert.strictEqual(res.diagnostics.chromeJavaScriptFromAppleEvents, 'auto-enabled');
      assert.strictEqual(res.diagnostics.chromeJavascriptToggleAttempted, true);
      const toggleCount = host.calls.filter((s) => s.includes('Allow JavaScript from Apple Events')).length;
      assert.strictEqual(toggleCount, 1, 'toggle attempted once, not spammed');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports a precise Chrome JS gate diagnostic under the OPEN_PROJECTS_PAGE_FAILED stage', async () => {
    const host = makeProjectsHostController();
    host.setJsGateMode('blocked');
    host.setToggleResult({ success: true, output: 'JS_TOGGLE|||NO_CHANGE' });
    const p = new ChatGPTProvider();
    const originalRun = (p as any).runAppleScript;
    (p as any).runAppleScript = host.run;
    try {
      const res = await p.resolveChatGPTProject('famunity');
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.diagnostics.discoveryStage, 'OPEN_PROJECTS_PAGE_FAILED');
      assert.strictEqual(res.diagnostics.chromeJavaScriptFromAppleEvents, 'toggle-failed');
      assert.ok((res.error ?? '').includes('Allow JavaScript from Apple Events'), res.error ?? '');
    } finally {
      (p as any).runAppleScript = originalRun;
    }
  });

  test('reports permission-needed when the auto-enable lacks Accessibility access', async () => {
    const host = makeProjectsHostController();
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
      assert.strictEqual(res.diagnostics.chromeJavaScriptFromAppleEvents, 'permission-needed');
      assert.ok((res.error ?? '').includes('Accessibility'), res.error ?? '');
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

  test('the default profile builds the exact 7-tab result navigation sequence', () => {
    const nav = buildChatGPTProjectResultNavigationAppleScript(DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE);
    assert.ok(nav.includes('repeat 7 times'));
    assert.ok(nav.includes('key code 48'));
    assert.ok(nav.includes('key code 36'));
  });
});