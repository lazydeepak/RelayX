/**
 * Configurable ChatGPT PROJECT discovery script profile.
 *
 * ChatGPT changed how Projects are opened. The obsolete flow was
 * `chatgpt.com -> Cmd+K -> search -> navigate result`. The verified current flow is:
 *
 *   1. open/focus  https://chatgpt.com/projects
 *   2. type/paste the RelayX project name
 *   3. press Return
 *   4. press Tab exactly 7 times
 *   5. press Return
 *   6. wait for the Project page to open
 *   7. copy/read the current browser URL
 *
 * Step 4 (`Tab x 7`) is UI-dependent and ChatGPT may change it again, so it lives
 * HERE — in the editable integration script — and never in RelayX domain logic.
 * `ChatGPTAppHandler` seeds the integration config with
 * `DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT`, and the ChatGPT provider reads the
 * profile back out of it. Repairing the flow is an Integration-page edit.
 *
 * Planner/session discovery is a SEPARATE flow and is intentionally not modelled
 * here.
 */

/** Stage-specific diagnostics for ChatGPT Project discovery. */
export type ChatGPTProjectDiscoveryStage =
  | 'OPEN_PROJECTS_PAGE_FAILED'
  | 'PROJECT_SEARCH_INPUT_FAILED'
  | 'PROJECT_SEARCH_SUBMIT_FAILED'
  | 'PROJECT_RESULT_NAVIGATION_FAILED'
  | 'PROJECT_OPEN_FAILED'
  | 'PROJECT_URL_READ_FAILED'
  | 'INVALID_PROJECT_URL'
  | 'PROJECT_ID_PARSE_FAILED'
  | 'PROJECT_BINDING_FAILED';

export const CHATGPT_PROJECT_DISCOVERY_STAGES: readonly ChatGPTProjectDiscoveryStage[] = Object.freeze([
  'OPEN_PROJECTS_PAGE_FAILED',
  'PROJECT_SEARCH_INPUT_FAILED',
  'PROJECT_SEARCH_SUBMIT_FAILED',
  'PROJECT_RESULT_NAVIGATION_FAILED',
  'PROJECT_OPEN_FAILED',
  'PROJECT_URL_READ_FAILED',
  'INVALID_PROJECT_URL',
  'PROJECT_ID_PARSE_FAILED',
  'PROJECT_BINDING_FAILED',
] as const);

/** Human-readable, raw-script-free messages for each failure stage. */
export const CHATGPT_PROJECT_DISCOVERY_STAGE_MESSAGES: Readonly<Record<ChatGPTProjectDiscoveryStage, string>> =
  Object.freeze({
    OPEN_PROJECTS_PAGE_FAILED: 'Could not open the ChatGPT projects page',
    PROJECT_SEARCH_INPUT_FAILED: 'Could not focus the ChatGPT project search field',
    PROJECT_SEARCH_SUBMIT_FAILED: 'ChatGPT project search did not accept the project name',
    PROJECT_RESULT_NAVIGATION_FAILED: 'Project result navigation could not be dispatched',
    PROJECT_OPEN_FAILED: 'The ChatGPT project page did not open',
    PROJECT_URL_READ_FAILED: 'Could not read the current ChatGPT project URL',
    INVALID_PROJECT_URL: 'Discovery produced a URL that is not a ChatGPT URL',
    PROJECT_ID_PARSE_FAILED: 'Discovery URL carries no ChatGPT Project identity',
    PROJECT_BINDING_FAILED: 'ChatGPT Project identity could not be bound to the project',
  });

/**
 * Composes a stage-tagged error. The stage code is part of the message so the
 * failing stage is visible wherever the diagnostic surfaces, while the raw
 * AppleScript never is.
 */
export function chatgptProjectDiscoveryError(
  stage: ChatGPTProjectDiscoveryStage,
  detail?: string,
): string {
  const base = CHATGPT_PROJECT_DISCOVERY_STAGE_MESSAGES[stage];
  const suffix = detail ? `: ${detail}` : '';
  return `${stage}: ${base}${suffix}`;
}

/** Normalized, UI-independent form of the editable discovery script. */
export interface ChatGPTProjectDiscoveryProfile {
  /** The Projects route to open (UI-independent navigation target). */
  projectsUrl: string;
  /** How the project name reaches the search field. */
  inputMode: 'paste' | 'type';
  /** Whether Return is pressed to commit the search before tabbing to results. */
  submitSearch: boolean;
  /** Number of Tab presses that walk focus onto the intended Project result. */
  resultTabCount: number;
  /** Whether the final URL is captured and returned. */
  captureUrl: boolean;
}

/** The verified current ChatGPT Projects UI flow. */
export const DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE: ChatGPTProjectDiscoveryProfile = Object.freeze({
  projectsUrl: 'https://chatgpt.com/projects',
  inputMode: 'paste',
  submitSearch: true,
  resultTabCount: 7,
  captureUrl: true,
});

/**
 * Canonical, editable text form of the discovery profile. This is the default
 * value stored on the ChatGPT integration's `discoverProjectScript`.
 */
export const DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT = [
  '# ChatGPT Project discovery (macOS + Google Chrome)',
  `# Sequence: ${DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE.projectsUrl} -> search name -> Return -> Tab x ${DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE.resultTabCount} -> Return -> capture current URL`,
  '# The Tab count is UI-dependent; change it here when ChatGPT changes its Projects UI.',
  `open ${DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE.projectsUrl}`,
  `input {{projectName}}`,
  'Enter',
  `Tab x ${DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE.resultTabCount}`,
  'Enter',
  'capture current URL',
].join('\n');

/** Placeholder token for the RelayX project name in the discovery script. */
export const CHATGPT_PROJECT_DISCOVERY_NAME_TOKEN = '{{projectName}}';

function normalizeLine(raw: string): string {
  return (raw || '').replace(/#.*$/, '').trim();
}

/**
 * Parses the editable discovery script into a normalized profile.
 *
 * Tolerant by design: the operator edits this on the Integration page, so
 * casing/punctuation/brace style variants are accepted, but an unusable script
 * is rejected loudly rather than silently producing a wrong profile.
 */
export function parseChatGPTProjectDiscoveryScript(
  text: string | null | undefined,
): { ok: true; profile: ChatGPTProjectDiscoveryProfile } | { ok: false; error: string } {
  const fallback = DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { ok: true, profile: { ...fallback } };
  }

  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  if (lines.length === 0) {
    return { ok: true, profile: { ...fallback } };
  }

  const profile: ChatGPTProjectDiscoveryProfile = {
    projectsUrl: fallback.projectsUrl,
    inputMode: fallback.inputMode,
    submitSearch: false,
    resultTabCount: 0,
    captureUrl: false,
  };

  let sawOpen = false;
  let sawInput = false;
  let sawTabGroup = false;
  // An Enter BEFORE any Tab group submits the search; an Enter AFTER the Tab
  // group opens the focused result. Tracking the order (rather than just counting
  // Enters) is what makes a missing Enter report the right error.
  let submitEnterSeen = false;
  let resultEnterSeen = false;

  for (const line of lines) {
    const lower = line.toLowerCase();

    const openMatch = line.match(/^open\s+(?:url\s*:?\s*)?(\S+)$/i);
    if (openMatch) {
      const url = openMatch[1].trim();
      if (!/^https:\/\/chatgpt\.com\/projects\/?$/.test(url)) {
        return {
          ok: false,
          error:
            'ChatGPT Project discovery must open https://chatgpt.com/projects ' +
            `(found "${url}"). The Cmd+K project search flow is obsolete.`,
        };
      }
      profile.projectsUrl = url.replace(/\/$/, '');
      sawOpen = true;
      continue;
    }

    if (/^(input|type|paste|enter name|search)\b/.test(lower) && /projectname/i.test(line)) {
      profile.inputMode = /^(type)\b/.test(lower) ? 'type' : 'paste';
      sawInput = true;
      // The project name is typed/pasted into the search field that the page
      // itself focuses — this line is what supplies the RelayX project name.
      continue;
    }

    if (/^(capture|read)\b/.test(lower)) {
      profile.captureUrl = true;
      continue;
    }

    // `Tab x 7`, `Tab × 7`, `Tab 7`, `7 tabs`, `Tab 7 times`
    const tabMatch =
      line.match(/^tab\s*(?:x|×|\*)?\s*(\d+)\s*(?:times)?$/i) ||
      line.match(/^(\d+)\s*tabs?$/i) ||
      line.match(/^tab\s+(\d+)\s*times$/i);
    if (tabMatch) {
      const count = Number(tabMatch[1]);
      if (!Number.isInteger(count) || count < 0 || count > 200) {
        return { ok: false, error: `Tab count must be an integer between 0 and 200 (found "${line}").` };
      }
      profile.resultTabCount = count;
      sawTabGroup = true;
      continue;
    }

    if (/^(enter|return)\b/.test(lower)) {
      // Position relative to the Tab group determines the Enter's role.
      if (sawInput && !sawTabGroup) {
        profile.submitSearch = true;
        submitEnterSeen = true;
      } else if (sawTabGroup) {
        resultEnterSeen = true;
      }
      continue;
    }

    if (/^(key|keycode|keystroke)\b/.test(lower)) continue;

    return {
      ok: false,
      error: `Unrecognized ChatGPT Project discovery instruction: "${line}".`,
    };
  }

  if (!sawOpen) {
    return {
      ok: false,
      error: 'ChatGPT Project discovery script must start with `open https://chatgpt.com/projects`.',
    };
  }
  if (!sawInput) {
    return {
      ok: false,
      error: 'ChatGPT Project discovery script must contain `input {{projectName}}`.',
    };
  }
  if (!sawTabGroup) {
    return {
      ok: false,
      error: 'ChatGPT Project discovery script must contain a Tab sequence (e.g. `Tab x 7`).',
    };
  }
  if (!submitEnterSeen) {
    return {
      ok: false,
      error: 'ChatGPT Project discovery script must press Enter after `input {{projectName}}`.',
    };
  }
  if (!resultEnterSeen) {
    return {
      ok: false,
      error: 'ChatGPT Project discovery script must press Enter after the Tab sequence.',
    };
  }
  if (!profile.captureUrl) {
    return {
      ok: false,
      error: 'ChatGPT Project discovery script must end with `capture current URL`.',
    };
  }

  return { ok: true, profile };
}

/** Renders a profile back into the canonical editable script text. */
export function renderChatGPTProjectDiscoveryScript(profile: ChatGPTProjectDiscoveryProfile): string {
  return [
    '# ChatGPT Project discovery (macOS + Google Chrome)',
    `# Sequence: ${profile.projectsUrl} -> search name -> Return -> Tab x ${profile.resultTabCount} -> Return -> capture current URL`,
    '# The Tab count is UI-dependent; change it here when ChatGPT changes its Projects UI.',
    `open ${profile.projectsUrl}`,
    `${profile.inputMode === 'type' ? 'type' : 'input'} {{projectName}}`,
    'Enter',
    `Tab x ${profile.resultTabCount}`,
    'Enter',
    'capture current URL',
  ].join('\n');
}

/**
 * A diagnostics-safe summary of the profile. Contains no script text, so it can
 * be surfaced in diagnostics without leaking raw automation internals.
 */
export function describeChatGPTProjectDiscoveryProfile(
  profile: ChatGPTProjectDiscoveryProfile,
): Record<string, unknown> {
  return {
    projectsUrl: profile.projectsUrl,
    inputMode: profile.inputMode,
    submitSearch: profile.submitSearch,
    resultTabCount: profile.resultTabCount,
    captureUrl: profile.captureUrl,
  };
}

/** Escapes a value for safe embedding inside an AppleScript double-quoted string. */
function escapeAppleScriptStringLiteral(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Stage 2-3 of the profile: put the project name into the focused Projects
 * search field and press Return to commit the search.
 *
 * Bounded intra-script delays only; the caller owns the outer wait/polling.
 */
export function buildChatGPTProjectSearchInputAppleScript(
  profile: ChatGPTProjectDiscoveryProfile,
  projectName: string,
): string {
  const escapedName = escapeAppleScriptStringLiteral(projectName);
  const submit = profile.submitSearch
    ? `
      -- Return commits the project-name search
      key code 36
`
    : '';

  return `
    tell application "Google Chrome" to activate
    delay 0.2
    tell application "System Events"
      -- Clear whatever is already in the field first. Live verification showed a
      -- dirty field makes the paste append (observed "thaRelayX"), which would
      -- search for the wrong project entirely.
      keystroke "a" using command down
      delay 0.05
      key code 51 -- delete
      delay 0.15

      -- input {{projectName}}
      set the clipboard to "${escapedName}"
      delay 0.1
${
  profile.inputMode === 'type'
    ? `      keystroke "${escapedName}"
      delay 0.6
`
    : `      keystroke "v" using command down
      delay 0.6
`
}${submit}    end tell
  `;
}

/**
 * Stage 4-5 of the profile: walk focus onto the intended Project result with
 * `Tab x <resultTabCount>` and press Return to open it.
 *
 * The Tab count is read from the profile, never hardcoded here.
 */
export function buildChatGPTProjectResultNavigationAppleScript(
  profile: ChatGPTProjectDiscoveryProfile,
): string {
  const tabCount = profile.resultTabCount;
  return `
    tell application "Google Chrome" to activate
    delay 0.2
    tell application "System Events"
      -- Tab x ${tabCount}: walk focus onto the intended Project result
      repeat ${tabCount} times
        key code 48
        delay 0.12
      end repeat
      delay 0.2
      -- Return opens the focused Project result
      key code 36
    end tell
  `;
}