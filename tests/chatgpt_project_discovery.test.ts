/**
 * ChatGPT PROJECT discovery regression coverage.
 *
 * Guards the new `/projects` GUI flow and the shared Project-URL parser that
 * both the automatic GUI path and the manual pasted-URL path depend on.
 *
 * The obsolete path this replaces:
 *   chatgpt.com -> Cmd+K -> search project -> navigate result
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

import { ChatGPTProvider } from '../src/relay/providers/adapters.ts';
import {
  CHATGPT_PROJECT_RESULTS_MIN_SETTLE_MS,
  CHATGPT_PROJECT_RESULT_NAVIGATION_TIMEOUT_MS,
  CHATGPT_PROJECT_SEARCH_INPUT_TIMEOUT_MS,
  DISCOVERY_TAB_ACTIVE_READ_DELAY_MS,
  DISCOVERY_TAB_ACTIVE_READ_TIMEOUT_MS,
  DISCOVERY_TAB_CREATE_TIMEOUT_MS,
} from '../src/relay/providers/adapters.ts';
import {
  canonicalizeChatGPTProjectUrlFromUrl,
  extractChatGPTProjectIdFromUrl,
  isChatGPTProjectLessUrl,
  isChatGPTHost,
  parseChatGPTProjectUrl,
} from '../src/relay/providers/chatgptProjectUrl.ts';
import {
  buildChatGPTProjectResultNavigationAppleScript,
  buildChatGPTProjectSearchInputAppleScript,
  chatgptProjectDiscoveryError,
  CHATGPT_PROJECT_DISCOVERY_STAGES,
  DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE,
  DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT,
  describeChatGPTProjectDiscoveryProfile,
  parseChatGPTProjectDiscoveryScript,
  renderChatGPTProjectDiscoveryScript,
} from '../src/relay/providers/chatgptProjectDiscovery.ts';
import {
  applyPlannerUrl,
  reducePlannerDiscovery,
  resolvePlannerProjectBinding,
  PLANNER_IDLE_STATE,
  isPlannerBindingValid,
} from '../src/relay/application/stagedDiscovery.ts';
import { ChatGPTAppHandler } from '../src/relay/integrations/handlers/ChatGPTAppHandler.ts';
import { AppAutomationScripts } from '../src/relay/integrations/types.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';

const PROJECT_URL = 'https://chatgpt.com/g/g-p-abc123def456/project';

describe('ChatGPT Project URL parsing — the single shared parser', () => {
  test('/g/<project-id> extracts the Project ID', () => {
    const parsed = parseChatGPTProjectUrl('https://chatgpt.com/g/g-p-abc123def456');
    assert.deepStrictEqual(parsed, {
      projectId: 'g-p-abc123def456',
      canonicalProjectUrl: 'https://chatgpt.com/g/g-p-abc123def456/project',
    });
  });

  test('/g/<project-id>/project extracts the Project ID', () => {
    const parsed = parseChatGPTProjectUrl(PROJECT_URL);
    assert.strictEqual(parsed?.projectId, 'g-p-abc123def456');
    assert.strictEqual(parsed?.canonicalProjectUrl, PROJECT_URL);
  });

  test('/g/<project-id>/... extracts the same Project ID as the bare form', () => {
    const bare = parseChatGPTProjectUrl('https://chatgpt.com/g/g-p-abc123def456');
    for (const suffix of [
      '/project',
      '/c/conv-1234',
      '/project/abc',
      '/?tab=projects',
      '/#anchor',
      '/c/conv-1234?x=1#y',
    ]) {
      const parsed = parseChatGPTProjectUrl(`https://chatgpt.com/g/g-p-abc123def456${suffix}`);
      assert.strictEqual(
        parsed?.projectId,
        bare?.projectId,
        `suffix ${suffix} must yield the same Project ID`,
      );
      assert.strictEqual(parsed?.canonicalProjectUrl, bare?.canonicalProjectUrl);
    }
  });

  test('a standalone /c/<conversation-id> is NOT a Project binding', () => {
    const conversationUrl = 'https://chatgpt.com/c/6f0a1b2c3d4e5f60718293a4b';
    assert.strictEqual(parseChatGPTProjectUrl(conversationUrl), null);
    assert.strictEqual(extractChatGPTProjectIdFromUrl(conversationUrl), null);
    assert.strictEqual(canonicalizeChatGPTProjectUrlFromUrl(conversationUrl), null);
    // It IS a ChatGPT URL that lacks a Project identity, which is exactly the
    // case the parser reports separately from an invalid URL.
    assert.strictEqual(isChatGPTProjectLessUrl(conversationUrl), true);
  });

  test('the Projects listing route carries no Project identity', () => {
    assert.strictEqual(parseChatGPTProjectUrl('https://chatgpt.com/projects'), null);
    assert.strictEqual(isChatGPTProjectLessUrl('https://chatgpt.com/projects'), true);
  });

  test('non-ChatGPT and malformed URLs are rejected', () => {
    for (const bad of [
      'https://example.com/g/g-p-abc123',
      'https://notchatgpt.com/g/g-p-abc123',
      'https://evil-chatgpt.com.attacker.test/g/g-p-abc123',
      'not-a-url',
      '',
      null,
      undefined,
    ]) {
      assert.strictEqual(parseChatGPTProjectUrl(bad as any), null, `expected rejection: ${String(bad)}`);
      assert.strictEqual(isChatGPTProjectLessUrl(bad as any), false);
    }
  });

  test('a custom GPT link (/g/g-...) is not a Project', () => {
    assert.strictEqual(parseChatGPTProjectUrl('https://chatgpt.com/g/g-custom-abc/c/x'), null);
  });

  test('a legacy /p/<slug> project URL is recognized and canonicalized to itself', () => {
    // Legacy ChatGPT projects have no `g-p-` prefix. They must still bind, and
    // must not be rewritten into a /g/ shape ChatGPT never produced.
    assert.deepStrictEqual(parseChatGPTProjectUrl('https://chatgpt.com/p/alpha-1'), {
      projectId: 'alpha-1',
      canonicalProjectUrl: 'https://chatgpt.com/p/alpha-1',
    });
    assert.deepStrictEqual(parseChatGPTProjectUrl('https://chatgpt.com/p/alpha-1/c/conv-9'), {
      projectId: 'alpha-1',
      canonicalProjectUrl: 'https://chatgpt.com/p/alpha-1',
    });
    assert.strictEqual(parseChatGPTProjectUrl('https://chatgpt.com/p/'), null);
    assert.strictEqual(parseChatGPTProjectUrl('https://example.com/p/alpha-1'), null);
  });

  test('isChatGPTHost accepts chatgpt.com and its subdomains only', () => {
    assert.strictEqual(isChatGPTHost('chatgpt.com'), true);
    assert.strictEqual(isChatGPTHost('CHATGPT.COM'), true);
    assert.strictEqual(isChatGPTHost('www.chatgpt.com'), true);
    assert.strictEqual(isChatGPTHost('notchatgpt.com'), false);
    assert.strictEqual(isChatGPTHost('chatgpt.com.evil.test'), false);
    assert.strictEqual(isChatGPTHost(''), false);
    assert.strictEqual(isChatGPTHost(null), false);
  });
});

describe('ChatGPT Project discovery script profile — configurable Tab x N', () => {
  test('the shipped default profile is the verified /projects sequence', () => {
    const parsed = parseChatGPTProjectDiscoveryScript(DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT);
    assert.strictEqual(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepStrictEqual(parsed.profile, {
      projectsUrl: 'https://chatgpt.com/projects',
      inputMode: 'paste',
      submitSearch: true,
      resultTabCount: 7,
      captureUrl: true,
    });
  });

  test('the default script text represents open /projects, input, Enter, Tab x 7, Enter, capture URL', () => {
    const meaningful = DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    assert.strictEqual(meaningful[0], 'open https://chatgpt.com/projects');
    assert.strictEqual(meaningful[1], 'input {{projectName}}');
    assert.strictEqual(meaningful[2], 'Enter');
    assert.strictEqual(meaningful[3], 'Tab x 7');
    assert.strictEqual(meaningful[4], 'Enter');
    assert.strictEqual(meaningful[5], 'capture current URL');
    assert.strictEqual(meaningful.length, 6);
  });

  test('the sequence contains Enter, Tab x 7, Enter in that order', () => {
    const meaningful = DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    const enterIdx = meaningful.indexOf('Enter');
    const tabIdx = meaningful.indexOf('Tab x 7');
    assert.ok(enterIdx >= 0 && tabIdx > enterIdx, 'Enter must precede the Tab sequence');
    assert.strictEqual(meaningful[tabIdx + 1], 'Enter', 'Enter must follow the Tab sequence');
  });

  test('an edited Tab count is honoured — this is the UI-dependent knob', () => {
    for (const [text, expected] of [
      ['Tab x 3', 3],
      ['Tab × 3', 3],
      ['Tab 3', 3],
      ['Tab x 12', 12],
      ['Tab 0', 0],
    ] as Array<[string, number]>) {
      const parsed = parseChatGPTProjectDiscoveryScript(
        [
          'open https://chatgpt.com/projects',
          'input {{projectName}}',
          'Enter',
          text,
          'Enter',
          'capture current URL',
        ].join('\n'),
      );
      assert.strictEqual(parsed.ok, true, `expected ${text} to parse`);
      if (parsed.ok) assert.strictEqual(parsed.profile.resultTabCount, expected);
    }
  });

  test('comments and blank lines are tolerated', () => {
    const parsed = parseChatGPTProjectDiscoveryScript(
      [
        '# ChatGPT Project discovery',
        '',
        'open https://chatgpt.com/projects',
        '',
        'input {{projectName}}',
        'Enter',
        'Tab x 7',
        'Enter',
        'capture current URL',
        '',
      ].join('\n'),
    );
    assert.strictEqual(parsed.ok, true);
    if (parsed.ok) assert.strictEqual(parsed.profile.resultTabCount, 7);
  });

  test('a script that does not open /projects is rejected (the Cmd+K path is refused)', () => {
    for (const script of [
      'open https://chatgpt.com\ninput {{projectName}}\nEnter\nTab x 7\nEnter\ncapture current URL',
      'open https://chatgpt.com/?q=x\ninput {{projectName}}\nEnter\nTab x 7\nEnter\ncapture current URL',
    ]) {
      const parsed = parseChatGPTProjectDiscoveryScript(script);
      assert.strictEqual(parsed.ok, false, `expected rejection: ${script}`);
      if (!parsed.ok) assert.ok(parsed.error.includes('https://chatgpt.com/projects'));
    }
  });

  test('an incomplete sequence is rejected rather than silently mis-running', () => {
    const cases: Array<[string, RegExp]> = [
      ['input {{projectName}}\nEnter\nTab x 7\nEnter\ncapture current URL', /must start with `open/],
      [
        'open https://chatgpt.com/projects\nEnter\nTab x 7\nEnter\ncapture current URL',
        /must contain `input \{\{projectName\}\}`/,
      ],
      [
        'open https://chatgpt.com/projects\ninput {{projectName}}\nTab x 7\nEnter\ncapture current URL',
        /must press Enter after `input/,
      ],
      [
        'open https://chatgpt.com/projects\ninput {{projectName}}\nEnter\nTab x 7\ncapture current URL',
        /must press Enter after the Tab sequence/,
      ],
      [
        'open https://chatgpt.com/projects\ninput {{projectName}}\nEnter\nTab x 7\nEnter',
        /must end with `capture current URL`/,
      ],
      [
        'open https://chatgpt.com/projects\ninput {{projectName}}\nEnter\nTab x 9999\nEnter\ncapture current URL',
        /Tab count must be an integer/,
      ],
      [
        'open https://chatgpt.com/projects\ninput {{projectName}}\nEnter\nTab x 7\nEnter\nnavigate somewhere',
        /Unrecognized/,
      ],
    ];
    for (const [script, matcher] of cases) {
      const parsed = parseChatGPTProjectDiscoveryScript(script);
      assert.strictEqual(parsed.ok, false, `expected rejection: ${script}`);
      if (!parsed.ok) assert.match(parsed.error, matcher);
    }
  });

  test('an empty script falls back to the verified default profile', () => {
    for (const empty of ['', '   ', null, undefined]) {
      const parsed = parseChatGPTProjectDiscoveryScript(empty as any);
      assert.strictEqual(parsed.ok, true);
      if (parsed.ok) assert.deepStrictEqual(parsed.profile, DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE);
    }
  });

  test('a profile round-trips through render -> parse unchanged', () => {
    const rendered = renderChatGPTProjectDiscoveryScript(DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE);
    const parsed = parseChatGPTProjectDiscoveryScript(rendered);
    assert.strictEqual(parsed.ok, true);
    if (parsed.ok) assert.deepStrictEqual(parsed.profile, DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE);
  });

  test('the rendered navigation script uses the profile Tab count, not a constant', () => {
    const script = buildChatGPTProjectResultNavigationAppleScript({
      ...DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE,
      resultTabCount: 4,
    });
    assert.ok(script.includes('repeat 4 times'));
    assert.ok(!script.includes('repeat 7 times'));
  });

  test('the search-input script pastes the project name and presses Return', () => {
    const script = buildChatGPTProjectSearchInputAppleScript(
      DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE,
      'RelayX',
    );
    assert.ok(script.includes('set the clipboard to "RelayX"'));
    assert.ok(script.includes('keystroke "v" using command down'));
    assert.ok(script.includes('key code 36'), 'Return submits the search');
  });

  test('every discovery stage budget is bounded, so a run cannot hang', () => {
    // Nothing in the flow polls forever: each wait has a ceiling.
    for (const [name, value] of [
      ['DISCOVERY_TAB_CREATE_TIMEOUT_MS', DISCOVERY_TAB_CREATE_TIMEOUT_MS],
      ['DISCOVERY_TAB_ACTIVE_READ_DELAY_MS', DISCOVERY_TAB_ACTIVE_READ_DELAY_MS],
      ['DISCOVERY_TAB_ACTIVE_READ_TIMEOUT_MS', DISCOVERY_TAB_ACTIVE_READ_TIMEOUT_MS],
      ['CHATGPT_PROJECT_SEARCH_INPUT_TIMEOUT_MS', CHATGPT_PROJECT_SEARCH_INPUT_TIMEOUT_MS],
      ['CHATGPT_PROJECT_RESULT_NAVIGATION_TIMEOUT_MS', CHATGPT_PROJECT_RESULT_NAVIGATION_TIMEOUT_MS],
      ['CHATGPT_PROJECT_RESULTS_MIN_SETTLE_MS', CHATGPT_PROJECT_RESULTS_MIN_SETTLE_MS],
    ] as Array<[string, number]>) {
      assert.ok(value > 0 && value <= 30000, `${name} must be a positive bounded budget, got ${value}`);
    }
  });

  test('the results-settle window is a floor, not a fixed sleep', () => {
    // Live measurement: the filtered rows only become tabbable ~2s after the
    // search Return. This constant is that floor; the wait still ends as soon
    // as the list's own signature holds steady across the window.
    assert.ok(CHATGPT_PROJECT_RESULTS_MIN_SETTLE_MS >= 2000);
    assert.ok(CHATGPT_PROJECT_RESULTS_MIN_SETTLE_MS <= 5000);
  });

  test('the profile summary exposed in diagnostics carries no script text', () => {
    const summary = describeChatGPTProjectDiscoveryProfile(DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE);
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes('tell application'));
    assert.ok(!serialized.includes('keystroke'));
    assert.ok(!serialized.includes('key code'));
    assert.deepStrictEqual(summary, {
      projectsUrl: 'https://chatgpt.com/projects',
      inputMode: 'paste',
      submitSearch: true,
      resultTabCount: 7,
      captureUrl: true,
    });
  });
});

describe('ChatGPT Project discovery diagnostics — stage taxonomy', () => {
  test('every required stage is represented exactly once', () => {
    const required = [
      'OPEN_PROJECTS_PAGE_FAILED',
      'PROJECT_SEARCH_INPUT_FAILED',
      'PROJECT_SEARCH_SUBMIT_FAILED',
      'PROJECT_RESULT_NAVIGATION_FAILED',
      'PROJECT_OPEN_FAILED',
      'PROJECT_URL_READ_FAILED',
      'INVALID_PROJECT_URL',
      'PROJECT_ID_PARSE_FAILED',
      'PROJECT_BINDING_FAILED',
    ];
    for (const stage of required) {
      assert.ok(CHATGPT_PROJECT_DISCOVERY_STAGES.includes(stage as any), `missing stage: ${stage}`);
    }
    assert.strictEqual(new Set(CHATGPT_PROJECT_DISCOVERY_STAGES).size, required.length);
  });

  test('the obsolete generic error is no longer used as a failure message', () => {
    for (const stage of CHATGPT_PROJECT_DISCOVERY_STAGES) {
      const message = chatgptProjectDiscoveryError(stage);
      assert.ok(message.startsWith(`${stage}:`), message);
      assert.ok(!message.includes('Could not open ChatGPT projects search UI'));
    }
  });

  test('stage errors carry the stage code and never raw script internals', () => {
    const msg = chatgptProjectDiscoveryError('PROJECT_OPEN_FAILED', 'https://chatgpt.com/projects');
    assert.ok(msg.includes('PROJECT_OPEN_FAILED'));
    assert.ok(msg.includes('https://chatgpt.com/projects'));
    assert.ok(!msg.includes('tell application'));
    assert.ok(!msg.includes('key code'));
  });
});

describe('Project discovery uses /projects, not Cmd+K', () => {
  const originalPlatform = process.platform;

  const withDarwin = async (fn: () => Promise<void>) => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      await fn();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  };

  test('the default discovery script opens /projects and never references Cmd+K', () => {
    const script = DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT.toLowerCase();
    assert.ok(script.includes('open https://chatgpt.com/projects'));
    assert.ok(!script.includes('command down'), 'the obsolete Cmd+K modifier must not appear');
    assert.ok(!script.includes('cmd+k'));
  });

  test('the provider default script is the /projects profile', () => {
    const provider = new ChatGPTProvider();
    const script = provider.getProjectDiscoveryScript();
    assert.ok(script.includes('open https://chatgpt.com/projects'));
    assert.ok(script.includes('Tab x 7'));
  });

  test('applying an edited script replaces the sequence used by the provider', () => {
    const provider = new ChatGPTProvider();
    provider.applyProjectDiscoveryScript(
      [
        'open https://chatgpt.com/projects',
        'input {{projectName}}',
        'Enter',
        'Tab x 9',
        'Enter',
        'capture current URL',
      ].join('\n'),
    );
    assert.ok(provider.getProjectDiscoveryScript().includes('Tab x 9'));
    const parsed = parseChatGPTProjectDiscoveryScript(provider.getProjectDiscoveryScript());
    assert.strictEqual(parsed.ok, true);
    if (parsed.ok) assert.strictEqual(parsed.profile.resultTabCount, 9);
  });

  test('applying an empty or absent script restores the verified default', () => {
    const provider = new ChatGPTProvider();
    for (const value of ['', '   ', null, undefined]) {
      provider.applyProjectDiscoveryScript(value as any);
      assert.strictEqual(provider.getProjectDiscoveryScript(), DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT);
    }
  });

  test('an unusable configured script fails discovery at OPEN_PROJECTS_PAGE_FAILED rather than mis-running', async () => {
    await withDarwin(async () => {
      const provider = new ChatGPTProvider();
      // Simulate the Integration page being edited back to the obsolete root URL.
      provider.applyProjectDiscoveryScript('open https://chatgpt.com\ninput {{projectName}}\nEnter\nTab x 7\nEnter\ncapture current URL');
      const originalRun = (provider as any).runAppleScript;
      // Fail fast: the script is rejected before any host call is needed.
      (provider as any).runAppleScript = () => {
        throw new Error('no host interaction should be attempted for an unusable script');
      };
      try {
        const res = await provider.resolveChatGPTProject('RelayX');
        assert.strictEqual(res.success, false);
        assert.ok((res.error ?? '').startsWith('OPEN_PROJECTS_PAGE_FAILED:'), res.error ?? '');
        assert.strictEqual(res.diagnostics.discoveryStage, 'OPEN_PROJECTS_PAGE_FAILED');
        assert.ok(res.diagnostics.projectDiscoveryScriptError);
      } finally {
        (provider as any).runAppleScript = originalRun;
      }
    });
  });

  test('discovery on a non-darwin host reports OPEN_PROJECTS_PAGE_FAILED', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const provider = new ChatGPTProvider();
      const res = await provider.resolveChatGPTProject('RelayX');
      assert.strictEqual(res.success, false);
      assert.ok((res.error ?? '').startsWith('OPEN_PROJECTS_PAGE_FAILED:'), res.error ?? '');
      assert.strictEqual(res.diagnostics.discoveryStage, 'OPEN_PROJECTS_PAGE_FAILED');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});

describe('Manual and automatic paths produce the same Project identity', () => {
  const PROJECT_ID = 'g-p-abc123def456';

  test('an automatically discovered URL and a manually pasted URL bind identically', () => {
    // Automatic: the provider returns the observed URL unchanged.
    const automatic = reducePlannerDiscovery(PLANNER_IDLE_STATE, {
      success: true,
      finalUrl: PROJECT_URL,
      projectName: 'RelayX',
    } as any);

    // Manual: the operator pastes the same URL.
    const manual = applyPlannerUrl(PLANNER_IDLE_STATE, PROJECT_URL);

    assert.strictEqual(automatic.status, 'discovered');
    assert.strictEqual(manual.status, 'discovered');
    assert.strictEqual(automatic.url, manual.url);
    assert.strictEqual(automatic.url, `https://chatgpt.com/g/${PROJECT_ID}/project`);
    assert.strictEqual(automatic.evidence?.projectId, PROJECT_ID);
    assert.strictEqual(manual.evidence?.projectId, PROJECT_ID);
    assert.strictEqual(manual.evidence?.canonicalProjectUrl, automatic.evidence?.canonicalProjectUrl);
    assert.strictEqual(isPlannerBindingValid(automatic), true);
    assert.strictEqual(isPlannerBindingValid(manual), true);
  });

  test('a manually pasted conversation URL is rejected instead of bound', () => {
    const manual = applyPlannerUrl(PLANNER_IDLE_STATE, 'https://chatgpt.com/c/6f0a1b2c3d4e5f60');
    assert.strictEqual(manual.status, 'failed');
    assert.strictEqual(manual.url, undefined);
    assert.ok((manual.error ?? '').startsWith('PROJECT_ID_PARSE_FAILED:'), manual.error ?? '');
  });

  test('an automatic "success" without a Project identity is rejected', () => {
    const automatic = reducePlannerDiscovery(PLANNER_IDLE_STATE, {
      success: true,
      finalUrl: 'https://chatgpt.com/c/6f0a1b2c3d4e5f60',
    } as any);
    assert.strictEqual(automatic.status, 'failed');
    assert.strictEqual(automatic.url, undefined);
    assert.ok((automatic.error ?? '').startsWith('PROJECT_ID_PARSE_FAILED:'), automatic.error ?? '');
  });

  test('both paths canonicalize a bare /g/<id> and a /c/<id> URL to the same binding', () => {
    const viaBare = applyPlannerUrl(PLANNER_IDLE_STATE, `https://chatgpt.com/g/${PROJECT_ID}`);
    const viaConversation = applyPlannerUrl(
      PLANNER_IDLE_STATE,
      `https://chatgpt.com/g/${PROJECT_ID}/c/conv-98765`,
    );
    assert.strictEqual(viaBare.url, viaConversation.url);
    assert.strictEqual(viaBare.evidence?.projectId, viaConversation.evidence?.projectId);
  });

  test('resolvePlannerProjectBinding is the one gate behind both paths', () => {
    const ok = resolvePlannerProjectBinding(PROJECT_URL);
    assert.strictEqual(ok.ok, true);
    if (ok.ok) assert.strictEqual(ok.identity.projectId, PROJECT_ID);

    const bad = resolvePlannerProjectBinding('https://chatgpt.com/c/abc');
    assert.strictEqual(bad.ok, false);
    if (!bad.ok) assert.ok(bad.error.startsWith('PROJECT_ID_PARSE_FAILED:'));

    const invalid = resolvePlannerProjectBinding('https://example.com/g/g-p-abc');
    assert.strictEqual(invalid.ok, false);
    if (!invalid.ok) assert.ok(invalid.error.startsWith('INVALID_PROJECT_URL:'));

    const empty = resolvePlannerProjectBinding('');
    assert.strictEqual(empty.ok, false);
    if (!empty.ok) assert.ok(empty.error.startsWith('INVALID_PROJECT_URL:'));
  });

  test('a conversation ID is never adopted as a Project ID', () => {
    // The distinction the whole flow depends on.
    const conversationId = '6f0a1b2c3d4e5f60718293a4b';
    const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
    assert.strictEqual(parseChatGPTProjectUrl(conversationUrl), null);
    const manual = applyPlannerUrl(PLANNER_IDLE_STATE, conversationUrl);
    assert.strictEqual(manual.evidence?.projectId, undefined);
    assert.strictEqual(manual.url, undefined);
  });
});

describe('Integration configuration exposes the Project discovery sequence', () => {
  test('the ChatGPT integration seeds the editable /projects discovery script', () => {
    const handler = new ChatGPTAppHandler();
    const script = handler.config.scripts.discoverProjectScript;
    assert.ok(script, 'discoverProjectScript is configured');
    assert.ok(script!.includes('open https://chatgpt.com/projects'));
    assert.ok(script!.includes('Tab x 7'));
  });

  test('the seeded script parses into the verified profile', () => {
    const handler = new ChatGPTAppHandler();
    const parsed = parseChatGPTProjectDiscoveryScript(handler.config.scripts.discoverProjectScript);
    assert.strictEqual(parsed.ok, true);
    if (parsed.ok) {
      assert.strictEqual(parsed.profile.projectsUrl, 'https://chatgpt.com/projects');
      assert.strictEqual(parsed.profile.resultTabCount, 7);
    }
  });

  test('an operator-supplied script overrides the seed', () => {
    const custom = [
      'open https://chatgpt.com/projects',
      'input {{projectName}}',
      'Enter',
      'Tab x 5',
      'Enter',
      'capture current URL',
    ].join('\n');
    const handler = new ChatGPTAppHandler({
      scripts: { discoverProjectScript: custom } as Partial<AppAutomationScripts>,
    });
    assert.strictEqual(handler.config.scripts.discoverProjectScript, custom);
  });

  test('refreshProviderScripts pushes the configured script onto the live provider', () => {
    const provider = new ChatGPTProvider();
    const handler = new ChatGPTAppHandler(undefined, provider as any);
    assert.strictEqual(provider.getProjectDiscoveryScript(), DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT);

    const custom = [
      'open https://chatgpt.com/projects',
      'input {{projectName}}',
      'Enter',
      'Tab x 2',
      'Enter',
      'capture current URL',
    ].join('\n');
    handler.config.scripts.discoverProjectScript = custom;
    handler.refreshProviderScripts();
    assert.strictEqual(provider.getProjectDiscoveryScript(), custom);
    const parsed = parseChatGPTProjectDiscoveryScript(provider.getProjectDiscoveryScript());
    assert.strictEqual(parsed.ok, true);
    if (parsed.ok) assert.strictEqual(parsed.profile.resultTabCount, 2);
  });

  test('editing the integration through the API changes the Tab count the provider uses', async () => {
    // This is the repair path: Integration page -> updateIntegration -> provider.
    // No domain-layer change is needed when ChatGPT moves its UI.
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const provider = new ChatGPTProvider();
    engine.registerProvider(provider);
    const service = new RelayApiService(db, engine);
    await service.listIntegrations(); // initializes the integration manager

    const before = parseChatGPTProjectDiscoveryScript(provider.getProjectDiscoveryScript());
    assert.strictEqual(before.ok, true);
    if (before.ok) assert.strictEqual(before.profile.resultTabCount, 7);

    const edited = [
      'open https://chatgpt.com/projects',
      'input {{projectName}}',
      'Enter',
      'Tab x 4',
      'Enter',
      'capture current URL',
    ].join('\n');
    await service.updateIntegration('chatgpt', { scripts: { discoverProjectScript: edited } });

    const after = parseChatGPTProjectDiscoveryScript(provider.getProjectDiscoveryScript());
    assert.strictEqual(after.ok, true);
    if (after.ok) assert.strictEqual(after.profile.resultTabCount, 4);

    // The edit is readable back from the API, so the Integration page shows it.
    const list = await service.listIntegrations();
    const chatgpt = list.find((i) => i.providerType === 'chatgpt');
    assert.strictEqual(chatgpt?.scripts?.discoverProjectScript, edited);

    // And the provider now dispatches the edited count.
    const nav = buildChatGPTProjectResultNavigationAppleScript(after.profile!);
    assert.ok(nav.includes('repeat 4 times'));
    assert.ok(!nav.includes('repeat 7 times'));
  });

  test('the Integration page surface exposes the discovery script for editing', () => {
    // Guards that the script is actually wired through the DTO the page reads.
    const handler = new ChatGPTAppHandler();
    assert.ok('discoverProjectScript' in handler.config.scripts);
    const dtoShape: Partial<AppAutomationScripts> = handler.config.scripts;
    assert.strictEqual(typeof dtoShape.discoverProjectScript, 'string');
  });
});