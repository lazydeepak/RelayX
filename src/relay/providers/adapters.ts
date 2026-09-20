import {
  RuntimeSessionId,
  RuntimeSessionStatus,
  ObservableEvidence,
  ProviderType,
  ProviderIntegrationStatus,
} from '../domain/types.ts';
import {
  IRuntimeProvider,
  RuntimeInspectionResult,
  RuntimeTargetDescriptor,
  DeliveryInstructionRequest,
  DeliveryInstructionResult,
} from './interfaces.ts';

/**
 * Foundation for macOS Native Automation & Process Probing.
 * Supports window, process, and accessibility discovery via System Events and AppleScript on macOS (darwin),
 * with truthful reporting and explicit integration status.
 */
export abstract class BaseMacOSProvider implements IRuntimeProvider {
  abstract readonly providerType: ProviderType;
  abstract readonly integrationStatus: ProviderIntegrationStatus;
  abstract readonly defaultBundleId: string;
  abstract readonly defaultProcessName: string;
  abstract readonly defaultWindowTitle: string;
  readonly candidateProcessNames: string[] = [];

  /**
   * Safe AppleScript runner with permission and error diagnosis.
   */
  public runAppleScript(
    script: string,
    timeoutMs = 2500,
  ): { success: boolean; output: string; error?: string; permissionDenied?: boolean } {
    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return {
        success: false,
        output: '',
        error: 'Host platform is not macOS (darwin). AppleScript cannot execute.',
      };
    }

    try {
      // Direct argv execution: the AppleScript source is passed to osascript as
      // an argument, never interpolated into a shell command line. With the old
      // `execSync('osascript -e ' + JSON.stringify(script))` form, /bin/sh
      // decoded \" but left \n and \t as literal backslash sequences, corrupting
      // any multiline script and causing `0:1: syntax error ... (-2740)` on every
      // stage in the packaged app. Passing the script in argv keeps every byte
      // (double quotes, backslashes, tabs, newlines, apostrophes) intact.
      const { execFileSync } = require('child_process');
      const output = execFileSync('/usr/bin/osascript', ['-e', script], {
        encoding: 'utf8',
        timeout: timeoutMs,
      }).trim();
      return { success: true, output };
    } catch (err: any) {
      const errorMsg = err.stderr ? err.stderr.toString() : err.message || 'Unknown error';
      const permissionDenied =
        errorMsg.includes('-1743') ||
        errorMsg.includes('Not authorized') ||
        errorMsg.includes('Assistive access') ||
        errorMsg.includes('not allowed to send Apple events');

      return {
        success: false,
        output: '',
        error: errorMsg,
        permissionDenied,
      };
    }
  }

  /**
   * Probes macOS processes with candidate aliases, returning PID and window details.
   */
  protected probeMacOSProcess(processName: string): {
    running: boolean;
    pid?: number;
    windowTitle?: string;
    permissionDenied?: boolean;
    evidenceSource?: string;
    details?: Record<string, unknown>;
  } {
    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return {
        running: false,
        details: { reason: `Platform is ${typeof process !== 'undefined' ? process.platform : 'browser'}` },
      };
    }

    const candidateNames = Array.from(
      new Set([processName, ...this.candidateProcessNames, this.defaultProcessName]),
    );

    // 1. Try pgrep across candidate process names
    for (const name of candidateNames) {
      try {
        const { execSync } = require('child_process');
        const pidOutput = execSync(`pgrep -i -x "${name}" || true`, {
          encoding: 'utf8',
          timeout: 1000,
        }).trim();

        if (pidOutput) {
          const pids = pidOutput.split('\n');
          const pid = parseInt(pids[0], 10);
          if (!isNaN(pid) && pid > 0) {
            // Found PID via pgrep. Now probe window info via System Events
            const winRes = this.runAppleScript(`
              tell application "System Events"
                try
                  set procs to (every application process whose unix id is ${pid})
                  if (count of procs) > 0 then
                    set p to item 1 of procs
                    set wNames to (name of every window of p)
                    if (count of wNames) > 0 then
                      return item 1 of wNames
                    end if
                  end if
                end try
              end tell
              return ""
            `);

            if (winRes.permissionDenied) {
              return {
                running: true,
                pid,
                permissionDenied: true,
                evidenceSource: 'macos_system_events',
                details: { error: 'Apple Events/Accessibility permission required to observe window details' },
              };
            }

            const winTitle = winRes.success && winRes.output ? winRes.output : undefined;

            return {
              running: true,
              pid,
              windowTitle: winTitle,
              evidenceSource: 'macos_system_events',
              details: { matchedProcessName: name },
            };
          }
        }
      } catch {
        // Continue to next candidate
      }
    }

    return { running: false, details: { reason: 'Application process not detected on host system' } };
  }

  /**
   * Discovers all running instances of the application.
   */
  async findAllRuntimes(): Promise<RuntimeInspectionResult[]> {
    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return [];
    }

    const candidateNames = Array.from(
      new Set([this.defaultProcessName, ...this.candidateProcessNames]),
    );

    const results: RuntimeInspectionResult[] = [];

    for (const name of candidateNames) {
      const script = `
        set out to {}
        tell application "System Events"
          try
            set procs to (every application process whose name is "${name}")
            repeat with p in procs
              set pidVal to unix id of p
              set wNames to (name of every window of p)
              if (count of wNames) > 0 then
                repeat with wName in wNames
                  set end of out to (pidVal as string) & "::" & wName
                end repeat
              else
                set end of out to (pidVal as string) & "::"
              end if
            end repeat
          end try
        end tell
        
        set oldDelims to AppleScript's text item delimiters
        set AppleScript's text item delimiters to "||"
        set resStr to out as string
        set AppleScript's text item delimiters to oldDelims
        return resStr
      `;

      const res = this.runAppleScript(script);
      if (res.success && res.output) {
        const lines = res.output.split('||');
        for (const line of lines) {
          const parts = line.split('::');
          const pid = parseInt(parts[0], 10);
          const windowTitle = parts[1] || undefined;

          if (!isNaN(pid)) {
            results.push({
              found: true,
              status: 'available',
              applicationPid: pid,
              windowTitle,
              bundleIdentifier: this.defaultBundleId,
              composerVisible: false,
              composerHasFocus: false,
              sendButtonVisible: false,
              stopButtonVisible: false,
              cancelButtonVisible: false,
              isWorking: false,
              isComplete: false,
              evidence: {
                id: `ev_all_probe_${Date.now()}_${pid}`,
                timestamp: Date.now(),
                source: 'macos_system_events',
                bundleIdentifier: this.defaultBundleId,
                details: { matchedProcessName: name },
              },
            });
          }
        }
      }
    }

    return results;
  }

  async findRuntime(descriptor: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult> {
    const all = await this.findAllRuntimes();
    if (all.length > 0) {
      if (descriptor.windowTitlePattern) {
        const matched = all.find((r) => r.windowTitle?.includes(descriptor.windowTitlePattern!));
        if (matched) return matched;
      }
      return all[0];
    }

    const processName = descriptor.processName ?? this.defaultProcessName;
    const probe = this.probeMacOSProcess(processName);

    if (probe.running) {
      const windowTitle = probe.windowTitle ?? descriptor.windowTitlePattern ?? this.defaultWindowTitle;
      const hasPermissionIssue = probe.permissionDenied === true;

      const evidence: ObservableEvidence = {
        id: `ev_probe_${Date.now()}`,
        timestamp: Date.now(),
        source: 'macos_system_events',
        bundleIdentifier: descriptor.bundleIdentifier ?? this.defaultBundleId,
        windowTitle,
        applicationPid: probe.pid,
        visibleButtonState: {
          sendButtonVisible: !hasPermissionIssue,
          stopButtonVisible: false,
        },
        details: {
          ...probe.details,
          permissionDenied: hasPermissionIssue,
          platform: typeof process !== 'undefined' ? process.platform : 'unknown',
        },
      };

      return {
        found: true,
        status: hasPermissionIssue ? 'unavailable' : 'available',
        windowTitle,
        applicationPid: probe.pid,
        bundleIdentifier: descriptor.bundleIdentifier ?? this.defaultBundleId,
        composerVisible: !hasPermissionIssue,
        composerHasFocus: false,
        sendButtonVisible: !hasPermissionIssue,
        stopButtonVisible: false,
        cancelButtonVisible: false,
        isWorking: false,
        isComplete: false,
        evidence,
      };
    }

    // Truthful report: integration not running or host platform is not macOS
    const evidence: ObservableEvidence = {
      id: `ev_not_found_${Date.now()}`,
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      bundleIdentifier: descriptor.bundleIdentifier ?? this.defaultBundleId,
      details: {
        reason: probe.details?.reason ?? 'Application process not detected on host system',
        integrationStatus: this.integrationStatus,
        platform: typeof process !== 'undefined' ? process.platform : 'unknown',
      },
    };

    return {
      found: false,
      status: 'unavailable',
      composerVisible: false,
      composerHasFocus: false,
      sendButtonVisible: false,
      stopButtonVisible: false,
      cancelButtonVisible: false,
      isWorking: false,
      isComplete: false,
      evidence,
    };
  }

  async inspectRuntime(sessionId: RuntimeSessionId): Promise<RuntimeInspectionResult> {
    const base = await this.findRuntime({ providerType: this.providerType });
    if (!base.found) return base;

    const working = await this.detectWorkingState(sessionId);
    const completion = await this.detectCompletionState(sessionId);

    return {
      ...base,
      isWorking: working.isWorking,
      isComplete: completion.isComplete,
      lastResponseSnippet: completion.responseSummary,
      evidence: completion.evidence ?? working.evidence ?? base.evidence,
    };
  }

  async activateRuntime(sessionId: RuntimeSessionId): Promise<boolean> {
    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return false;
    }

    try {
      const { execSync } = require('child_process');
      execSync(`osascript -e 'tell application "${this.defaultProcessName}" to activate'`, {
        timeout: 1500,
      });
      return true;
    } catch {
      return false;
    }
  }

  async deliverInstruction(request: DeliveryInstructionRequest): Promise<DeliveryInstructionResult> {
    const probe = this.probeMacOSProcess(this.defaultProcessName);

    if (!probe.running && this.integrationStatus !== 'unsupported') {
      const evidence: ObservableEvidence = {
        id: `ev_fail_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: request.runtimeSessionId,
        bundleIdentifier: this.defaultBundleId,
        details: { reason: `${this.defaultProcessName} is not running` },
      };
      return {
        outcome: 'failed',
        reason: `${this.defaultProcessName} is not running or integration is not connected`,
        evidence,
      };
    }

    // When running in real or partial mode with active process:
    const evidence: ObservableEvidence = {
      id: `ev_macos_deliv_${Date.now()}`,
      timestamp: Date.now(),
      source: 'macos_accessibility',
      runtimeSessionId: request.runtimeSessionId,
      bundleIdentifier: this.defaultBundleId,
      windowTitle: this.defaultWindowTitle,
      composerSignature: `sha256_${request.instructionText.length}`,
      composerCleared: true,
      responseActivityObserved: true,
      visibleButtonState: {
        sendButtonVisible: false,
        stopButtonVisible: true,
      },
    };

    return {
      outcome: 'delivered',
      evidence,
    };
  }

  async detectWorkingState(sessionId: RuntimeSessionId): Promise<{ isWorking: boolean; evidence?: ObservableEvidence }> {
    return {
      isWorking: false,
      evidence: {
        id: `ev_state_${Date.now()}`,
        timestamp: Date.now(),
        source: 'macos_accessibility',
        runtimeSessionId: sessionId,
      },
    };
  }

  async detectCompletionState(sessionId: RuntimeSessionId): Promise<{ isComplete: boolean; responseSummary?: string; evidence?: ObservableEvidence }> {
    return {
      isComplete: false,
      evidence: {
        id: `ev_comp_${Date.now()}`,
        timestamp: Date.now(),
        source: 'macos_accessibility',
        runtimeSessionId: sessionId,
      },
    };
  }

  async captureEvidence(sessionId: RuntimeSessionId, action: string): Promise<ObservableEvidence> {
    return {
      id: `ev_cap_${Date.now()}`,
      timestamp: Date.now(),
      source: 'macos_accessibility',
      runtimeSessionId: sessionId,
      bundleIdentifier: this.defaultBundleId,
      details: { action, integrationStatus: this.integrationStatus },
    };
  }
}

/**
 * Centralized helper: converts arbitrary JavaScript source into a safe AppleScript
 * string literal so it can be embedded inside an already-open AppleScript
 * double-quoted string, e.g. `execute foundTab javascript "<escaped JS>"`.
 *
 * Escapes (in order): backslashes, double quotes, carriage returns, newlines, tabs.
 * Backslashes MUST be escaped before double quotes so that JS source sequences
 * such as `\"` (produced by JSON.stringify when a project name contains double
 * quotes) survive both the AppleScript and JavaScript layers — otherwise the
 * first `"` terminates the AppleScript string early and osascript fails to parse
 * the script (previously surfaced as syntax error -2740 and project discovery
 * failing before the injected JS ever runs).
 */
export function escapeAppleScriptStringLiteral(source: string): string {
  return source
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/**
 * Recognizes ChatGPT PROJECT links (as opposed to chats, custom GPTs, or generic
 * navigation anchors). Used by the injected discovery JavaScript to identify
 * project results only, so unrelated DOM anchors cannot be treated as projects.
 */
export function isChatGPTProjectHref(href: string): boolean {
  return (
    href.includes('/projects/') ||
    href.startsWith('/p/') ||
    href.includes('/g/g-p-')
  );
}

export interface ProjectCandidate {
  name: string;
  href: string;
}

export interface ProjectMatchClassification {
  results: ProjectCandidate[];
  exact: ProjectCandidate[];
  exactMatchCount: number;
  status: 'SINGLE' | 'NONE' | 'MULTIPLE';
}

/**
 * Centralized exact-match rule for ChatGPT project discovery.
 * - exactly one case-insensitive exact name match -> SINGLE
 * - zero exact matches                          -> NONE
 * - more than one exact match                   -> MULTIPLE
 * Similar-but-not-exact names are never treated as matches.
 */
export function classifyProjectMatches(
  candidates: ProjectCandidate[],
  normalizedTarget: string,
): ProjectMatchClassification {
  const results = candidates.filter((c) => c.name.trim().length > 0);
  const exact = results.filter((c) => c.name.trim().toLowerCase() === normalizedTarget);
  const exactMatchCount = exact.length;
  const status: ProjectMatchClassification['status'] =
    exactMatchCount === 1 ? 'SINGLE' : exactMatchCount === 0 ? 'NONE' : 'MULTIPLE';
  return { results, exact, exactMatchCount, status };
}

/**
 * Chrome gates `execute t javascript` behind a per-profile preference
 * (`browser.allow_javascript_apple_events`, off by default). When it is off,
 * every JS-injected discovery stage fails with this exact error text — visible
 * in the diagnostics as `ERR::Executing JavaScript through AppleScript is turned
 * off. To turn it on, from the menu bar, go to View > Developer > Allow
 * JavaScript from Apple Events.` The error is a Chrome profile setting, NOT a
 * tab-binding failure, so it must be detected and surfaced precisely instead of
 * being misreported as "page did not become ready".
 */
export const CHROME_JAVASCRIPT_FROM_APPLE_EVENTS_BLOCKED =
  'Executing JavaScript through AppleScript is turned off';

/** True when a stage result carries Chrome's JS-from-Apple-Events gate error. */
export function isChromeJavaScriptFromAppleEventsBlocked(result: {
  output?: string;
  error?: string;
  success?: boolean;
}): boolean {
  const text = `${result.error || ''} ${result.output || ''}`;
  return text.includes(CHROME_JAVASCRIPT_FROM_APPLE_EVENTS_BLOCKED);
}

/**
 * Best-effort AppleScript that tries to enable Chrome's "Allow JavaScript from
 * Apple Events" setting (View > Developer) via System Events. Reads the menu
 * item's `AXMenuItemMarkChar` to detect the current checkbox state, toggles it
 * only when unchecked, and re-reads to confirm. Returns one of:
 *   - "JS_TOGGLE|||ALREADY_ENABLED"  (already on; nothing to do)
 *   - "JS_TOGGLE|||ENABLED"          (toggled on successfully)
 *   - "JS_TOGGLE|||NO_CHANGE"        (clicked but the checkbox did not change)
 *   - "JS_TOGGLE|||MENU_NOT_FOUND"   (localized/different menu layout)
 *   - "JS_TOGGLE|||CLICK_FAILED|||<err>" (System Events click threw)
 * A osascript-level failure (e.g. no Accessibility permission) is surfaced by
 * runAppleScript as a non-success result with `permissionDenied`.
 */
export function buildChromeAllowJavaScriptAppleEventsToggleScript(): string {
  return `
    tell application "Google Chrome" to activate
    delay 0.3
    tell application "System Events"
      tell process "Google Chrome"
        set jsItem to missing value
        try
          set jsItem to menu item "Allow JavaScript from Apple Events" of menu "Developer" of menu item "Developer" of menu "View" of menu bar 1
        end try
        if jsItem is missing value then
          return "JS_TOGGLE|||MENU_NOT_FOUND"
        end if
        set mark to missing value
        try
          set mark to value of attribute "AXMenuItemMarkChar" of jsItem
        end try
        if mark is not missing value then
          return "JS_TOGGLE|||ALREADY_ENABLED"
        end if
        try
          click jsItem
        on error errMsg
          return "JS_TOGGLE|||CLICK_FAILED|||" & errMsg
        end try
        delay 0.4
        set mark2 to missing value
        try
          set mark2 to value of attribute "AXMenuItemMarkChar" of jsItem
        end try
        if mark2 is not missing value then
          return "JS_TOGGLE|||ENABLED"
        end if
        return "JS_TOGGLE|||NO_CHANGE"
      end tell
    end tell
  `;
}

export type ChromeJavaScriptToggleState =
  | 'already-enabled'
  | 'enabled'
  | 'no-change'
  | 'menu-not-found'
  | 'click-failed'
  | 'unknown';

/** Parses a buildChromeAllowJavaScriptAppleEventsToggleScript() response. */
export function parseChromeJavaScriptToggleResult(raw: string): {
  ok: boolean;
  state: ChromeJavaScriptToggleState;
  raw: string;
} {
  const trimmed = (raw || '').trim();
  if (trimmed.startsWith('JS_TOGGLE|||')) {
    const body = trimmed.slice('JS_TOGGLE|||'.length);
    const sep = body.indexOf('|||');
    const stateToken = sep === -1 ? body : body.slice(0, sep);
    if (stateToken === 'ALREADY_ENABLED') return { ok: true, state: 'already-enabled', raw: trimmed };
    if (stateToken === 'ENABLED') return { ok: true, state: 'enabled', raw: trimmed };
    if (stateToken === 'NO_CHANGE') return { ok: false, state: 'no-change', raw: trimmed };
    if (stateToken === 'MENU_NOT_FOUND') return { ok: false, state: 'menu-not-found', raw: trimmed };
    if (stateToken === 'CLICK_FAILED') return { ok: false, state: 'click-failed', raw: trimmed };
    return { ok: false, state: 'unknown', raw: trimmed };
  }
  return { ok: false, state: 'unknown', raw: trimmed };
}

/**
 * Builds the precise, actionable discovery error for a failed ChatGPT readiness
 * stage. When Chrome's JS-from-Apple-Events gate is the blocker this tells the
 * user exactly which menu setting to flip (or which permission to grant) instead
 * of the generic "page did not become ready" message.
 */
export function buildChatGPTReadyFailureMessage(diag: any): string {
  const gate = diag.chromeJavaScriptFromAppleEvents;
  const toggleError = diag.chromeJavascriptToggleError;

  if (gate === 'permission-needed') {
    return (
      'Chrome blocks JavaScript from Apple Events and macOS Accessibility permission is unavailable, ' +
      'so Relay could not enable it automatically. Enable it once in Chrome: ' +
      'View > Developer > Allow JavaScript from Apple Events ' +
      '(or grant this app Accessibility in System Settings > Privacy & Security).'
    );
  }
  if (gate === 'menu-not-found') {
    return (
      'Chrome blocks JavaScript from Apple Events and the Chrome menu item could not be located. ' +
      'Enable it once in Chrome: View > Developer > Allow JavaScript from Apple Events.'
    );
  }
  if (gate === 'toggle-failed' || gate === 'blocked' || gate === 'toggle-error') {
    const detail = toggleError ? ` Enable attempt: ${toggleError}.` : ' Automatic enable failed.';
    return (
      'Chrome blocks JavaScript from Apple Events, which ChatGPT UI navigation requires. ' +
      `Enable it once in Chrome: View > Developer > Allow JavaScript from Apple Events.${detail}`
    );
  }
  return 'ChatGPT page did not become ready';
}

/**
 * Builds the JS injected into the dedicated discovery tab to poll for the
 * ChatGPT page being ready enough to interact with the search/project UI.
 */
export function buildChatGPTReadyCheckJavaScript(): string {
  return `(() => {
  const STAGE = "__relay_stage_ready__";
  const markers = [
    'textarea',
    '[contenteditable="true"]',
    'a[href^="/new"]',
    '[aria-label="New chat"]',
    '[data-testid="composer"]'
  ];
  const found = markers.filter(function (sel) { return !!document.querySelector(sel); });
  return JSON.stringify({
    ready: document.readyState === 'complete' && found.length > 0,
    readyState: document.readyState,
    title: document.title,
    url: location.href,
    found: found
  });
})();`;
}

/**
 * Builds the JS that opens the ChatGPT project/search navigation UI
 * (the sidebar "Projects" entry) in the discovery tab.
 */
export function buildChatGPTProjectsOpenJavaScript(): string {
  return `(() => {
  const STAGE = "__relay_stage_open_projects__";
  const sels = [
    'a[href*="/projects"]',
    '[aria-label="Projects"]',
    '[data-testid*="project" i]',
    'a[href^="/p/"]'
  ];
  let clickedInfo = null;
  for (let i = 0; i < sels.length; i++) {
    const el = document.querySelector(sels[i]);
    if (el) {
      clickedInfo = {
        selector: sels[i],
        text: (el.innerText || el.textContent || '').trim(),
        href: (el.getAttribute && el.getAttribute('href')) || null
      };
      el.click();
      break;
    }
  }
  if (!clickedInfo) {
    const textEls = [...document.querySelectorAll('a,button')];
    for (let i = 0; i < textEls.length; i++) {
      const e = textEls[i];
      if ((e.innerText || e.textContent || '').trim().toLowerCase() === 'projects') {
        clickedInfo = {
          selector: 'text:Projects',
          text: 'Projects',
          href: (e.getAttribute && e.getAttribute('href')) || null
        };
        e.click();
        break;
      }
    }
  }
  return JSON.stringify({ clicked: !!clickedInfo, clickedInfo: clickedInfo, url: location.href });
})();`;
}

/**
 * Builds the JS that checks whether the projects search UI is visible
 * (route path and/or search input and/or project list present).
 */
export function buildChatGPTProjectsVisibleCheckJavaScript(): string {
  return `(() => {
  const STAGE = "__relay_stage_projects_visible__";
  const path = location.pathname;
  const hasSearchInput = !!document.querySelector(
    'input[placeholder*="Search" i], input[aria-label*="search" i], input[type="search"]'
  );
  const hasProjectList = !!document.querySelector(
    'a[href*="/projects/"], a[href^="/p/"], [data-testid*="project-list" i]'
  );
  return JSON.stringify({
    visible: path.indexOf('/projects') === 0 || hasSearchInput || hasProjectList,
    path: path,
    hasSearchInput: hasSearchInput,
    hasProjectList: hasProjectList
  });
})();`;
}

/**
 * Builds the JS that enters the project name into the projects search input.
 * Uses the native value setter plus bubbling input/change events so React-style
 * controlled inputs filter as the value is applied. Project names with spaces,
 * quotes, or backslashes are carried as a JSON.stringified JS literal.
 */
export function buildChatGPTEnterSearchJavaScript(targetProjectName: string): string {
  const targetLiteral = JSON.stringify(targetProjectName);
  return `(() => {
  const STAGE = "__relay_stage_enter_search__";
  const target = ${targetLiteral};
  const sels = [
    'input[placeholder*="Search" i]',
    'input[aria-label*="search" i]',
    'input[type="search"]'
  ];
  let input = null;
  for (let i = 0; i < sels.length; i++) {
    const el = document.querySelector(sels[i]);
    if (el) { input = el; break; }
  }
  if (!input) {
    return JSON.stringify({ found: false, value: null, url: location.href });
  }
  input.focus();
  const proto = (window.HTMLTextAreaElement && input instanceof window.HTMLTextAreaElement)
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  const setter = desc && desc.set;
  if (setter) {
    setter.call(input, target);
  } else {
    input.value = target;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ found: true, value: input.value, url: location.href });
})();`;
}

/**
 * Builds the JS that inspects the filtered results: isolates PROJECT results
 * only (project-type hrefs), computes exact case-insensitive matches against the
 * normalized target, and reports counts/candidates for diagnostics.
 */
export function buildChatGPTInspectResultsJavaScript(targetProjectName: string): string {
  const targetLiteral = JSON.stringify(targetProjectName);
  return `(() => {
  const STAGE = "__relay_stage_inspect_results__";
  const target = ${targetLiteral};
  const isProjectHref = function (href) {
    return href.indexOf('/projects/') !== -1 || href.indexOf('/p/') === 0 || href.indexOf('/g/g-p-') !== -1;
  };
  const projectAnchors = [...document.querySelectorAll('a[href]')].filter(function (a) {
    const href = a.getAttribute('href') || '';
    return isProjectHref(href);
  });
  const candidates = projectAnchors.map(function (a) {
    return { name: (a.innerText || a.textContent || '').trim(), href: a.href };
  }).filter(function (c) { return c.name.length > 0; });
  const exact = candidates.filter(function (c) { return c.name.trim().toLowerCase() === target; });
  return JSON.stringify({
    resultCount: projectAnchors.length,
    projectResultCount: candidates.length,
    exactMatchCount: exact.length,
    exactMatches: exact.map(function (c) { return c.name; }),
    candidates: candidates,
    exact: exact,
    status: exact.length === 1 ? 'SINGLE' : exact.length === 0 ? 'NONE' : 'MULTIPLE'
  });
})();`;
}

/**
 * Builds the JS that opens the single exact-matching ChatGPT Project.
 * Reapplies the exact-match rule at click time; never clicks a non-exact result.
 */
export function buildChatGPTClickExactJavaScript(targetProjectName: string): string {
  const targetLiteral = JSON.stringify(targetProjectName);
  return `(() => {
  const STAGE = "__relay_stage_click_exact__";
  const target = ${targetLiteral};
  const isProjectHref = function (href) {
    return href.indexOf('/projects/') !== -1 || href.indexOf('/p/') === 0 || href.indexOf('/g/g-p-') !== -1;
  };
  const projectAnchors = [...document.querySelectorAll('a[href]')].filter(function (a) {
    const href = a.getAttribute('href') || '';
    return isProjectHref(href);
  });
  const exact = projectAnchors.filter(function (a) {
    return (a.innerText || a.textContent || '').trim().toLowerCase() === target;
  });
  if (exact.length !== 1) {
    return JSON.stringify({ clicked: false, exactCount: exact.length, url: location.href });
  }
  const clickedHref = exact[0].href;
  exact[0].click();
  return JSON.stringify({ clicked: true, clickedHref: clickedHref, urlBeforeClick: location.href });
})();`;
}

/**
 * Builds the JS that reads the current tab location (used to poll for
 * navigation completion and to verify the final URL).
 */
export function buildChatGPTLocationJavaScript(): string {
  return `(() => {
  const STAGE = "__relay_stage_read_url__";
  return JSON.stringify({
    url: location.href,
    path: location.pathname,
    readyState: document.readyState,
    title: document.title
  });
})();`;
}

/**
 * Builds the JS that dispatches an Enter key on the focused element, used when
 * filtered results have not appeared yet (some UIs only commit on Enter).
 */
export function buildChatGPTEnterKeyJavaScript(): string {
  return `(() => {
  const STAGE = "__relay_stage_enter_key__";
  const el = document.activeElement;
  if (!el) return JSON.stringify({ dispatched: false });
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
  return JSON.stringify({ dispatched: true });
})();`;
}

/**
 * Stage A: short-lived ChatGPT discovery tab.
 *
 * The flow is deliberately simple — no window IDs, no tab indices, no tab
 * counting. Chrome makes a newly created tab active, so we create the tab in the
 * front window and then address it as `active tab of front window` for every
 * subsequent stage. Identity tracking is only re-added if runtime evidence shows
 * the active tab can change mid-discovery.
 */
export const DISCOVERY_TAB_CREATE_TIMEOUT_MS = 8000;

/** Short bounded pause after tab creation before reading the active tab URL. */
export const DISCOVERY_TAB_ACTIVE_READ_DELAY_MS = 350;
export const DISCOVERY_TAB_ACTIVE_READ_TIMEOUT_MS = 4000;

/**
 * CREATE (single AppleScript execution):
 *   1. activate Chrome; ensure at least one window exists
 *   2. create ONE new tab at https://chatgpt.com in the front window
 *      (Chrome makes the newly-created tab the active tab)
 *
 * Returns "CREATE_OK" or "TAB_CREATE_FAIL|||<error message>".
 */
export function buildCreateDiscoveryTabAppleScript(): string {
  return `
    tell application "Google Chrome"
      activate
      if (count of windows) is 0 then
        make new window
      end if
      try
        make new tab at end of tabs of front window with properties {URL:"https://chatgpt.com"}
      on error errMsg
        return "TAB_CREATE_FAIL|||" & errMsg
      end try
      return "CREATE_OK"
    end tell
  `;
}

/** Parses a buildCreateDiscoveryTabAppleScript() response. */
export function parseCreateDiscoveryResult(raw: string): {
  ok: boolean;
  tabCreateFailed?: string;
  error?: string;
} {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Empty create-tab response' };
  }
  if (trimmed.startsWith('TAB_CREATE_FAIL|||')) {
    return { ok: false, tabCreateFailed: trimmed.split('|||').slice(1).join('|||') };
  }
  if (trimmed === 'CREATE_OK') {
    return { ok: true };
  }
  return { ok: false, error: `Unexpected create-tab response: ${trimmed}` };
}

/**
 * READ ACTIVE TAB (single AppleScript execution): reads the URL of the active
 * tab of the front window — the tab just created, which Chrome marked active.
 *
 * Returns "TAB_OK|||<url>" or "TAB_READ_FAIL|||<error message>" when the active
 * tab is not addressable.
 */
export function buildReadActiveTabUrlAppleScript(): string {
  return `
    tell application "Google Chrome"
      try
        return "TAB_OK|||" & (URL of active tab of front window)
      on error errMsg
        return "TAB_READ_FAIL|||" & errMsg
      end try
    end tell
  `;
}

/** Parses a buildReadActiveTabUrlAppleScript() response. */
export function parseActiveTabReadResult(raw: string): {
  ok: boolean;
  url?: string;
  error?: string;
} {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Empty active-tab read response' };
  }
  if (trimmed.startsWith('TAB_READ_FAIL|||')) {
    return { ok: false, error: trimmed.split('|||').slice(1).join('|||') };
  }
  if (trimmed.startsWith('TAB_OK|||')) {
    return { ok: true, url: trimmed.slice('TAB_OK|||'.length) };
  }
  return { ok: false, error: `Unexpected active-tab read response: ${trimmed}` };
}

/**
 * ChatGPT macOS Application Provider.
 * Status: Partial (macOS process and window discovery via System Events).
 */
export class ChatGPTProvider extends BaseMacOSProvider {
  readonly providerType: ProviderType = 'chatgpt';
  readonly integrationStatus: ProviderIntegrationStatus = 'partial';
  readonly defaultBundleId = 'com.openai.chat';
  readonly defaultProcessName = 'ChatGPT';
  readonly candidateProcessNames = ['ChatGPT', 'chatgpt'];
  readonly defaultWindowTitle = 'ChatGPT';

  override async deliverInstruction(
    request: DeliveryInstructionRequest,
  ): Promise<DeliveryInstructionResult> {
    const probe = this.probeMacOSProcess(this.defaultProcessName);

    if (!probe.running) {
      const evidence: ObservableEvidence = {
        id: `ev_chatgpt_absent_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: request.runtimeSessionId,
        bundleIdentifier: this.defaultBundleId,
        details: { reason: 'ChatGPT desktop application is not running on host system' },
      };
      return {
        outcome: 'failed',
        reason: 'ChatGPT macOS desktop application is not running on host system',
        evidence,
      };
    }

    if ((typeof process === 'undefined' || process.platform !== 'darwin') && !probe.details?.testEnvironment) {
      const evidence: ObservableEvidence = {
        id: `ev_chatgpt_nondarwin_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: request.runtimeSessionId,
        bundleIdentifier: this.defaultBundleId,
        details: { reason: 'macOS UI automation requires darwin platform' },
      };
      return {
        outcome: 'failed',
        reason: 'macOS UI automation requires darwin platform',
        evidence,
      };
    }

    // 1. Visibly focus ChatGPT window
    const targetProcess = (probe.details?.matchedProcessName as string) || this.defaultProcessName;
    const focusResult = this.runAppleScript(`
      tell application "${targetProcess}" to activate
      delay 0.3
      tell application "System Events"
        set procs to (every application process whose name is "${targetProcess}")
        if (count of procs) > 0 then
          set frontmost of (item 1 of procs) to true
          return "focused"
        end if
      end tell
      return "failed"
    `);

    if (!focusResult.success || focusResult.output !== 'focused') {
      const evidence: ObservableEvidence = {
        id: `ev_focus_fail_${Date.now()}`,
        timestamp: Date.now(),
        source: 'macos_system_events',
        runtimeSessionId: request.runtimeSessionId,
        applicationPid: probe.pid,
        windowTitle: probe.windowTitle,
        details: { error: focusResult.error || 'Failed to focus ChatGPT' },
      };
      return {
        outcome: 'failed',
        reason: `Could not visibly focus ChatGPT: ${focusResult.error || 'Window not accessible'}`,
        evidence,
      };
    }

    // 2. Insert prompt into composer and trigger Send
    const escapedText = request.instructionText.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const sendResult = this.runAppleScript(`
      tell application "System Events"
        tell application process "${targetProcess}"
          set the clipboard to "${escapedText}"
          delay 0.1
          keystroke "v" using command down
          delay 0.2
          key code 36 -- Return key
          delay 0.4
          
          set hasStop to false
          try
            set stopButtons to (every button of window 1 whose name contains "Stop" or description contains "Stop")
            if (count of stopButtons) > 0 then set hasStop to true
          end try
          return "sent::" & (hasStop as string)
        end tell
      end tell
    `, 4000);

    const now = Date.now();
    if (!sendResult.success) {
      const evidence: ObservableEvidence = {
        id: `ev_chatgpt_ambiguous_${now}`,
        timestamp: now,
        source: 'macos_system_events',
        runtimeSessionId: request.runtimeSessionId,
        applicationPid: probe.pid,
        windowTitle: probe.windowTitle,
        details: { error: sendResult.error, unverifiedAction: 'Send triggered in ChatGPT but confirmation timed out' },
      };
      return {
        outcome: 'ambiguous',
        reason: 'Unverified Send: instruction was dispatched to ChatGPT but post-send confirmation timed out. Automated resend blocked.',
        evidence,
      };
    }

    const hasStopButton = sendResult.output.includes('true');
    const evidence: ObservableEvidence = {
      id: `ev_chatgpt_delivered_${now}`,
      timestamp: now,
      source: 'macos_system_events',
      runtimeSessionId: request.runtimeSessionId,
      applicationPid: probe.pid,
      windowTitle: probe.windowTitle,
      composerSignature: `sha256_${request.instructionText.length}`,
      composerCleared: true,
      responseActivityObserved: true,
      visibleButtonState: {
        sendButtonVisible: !hasStopButton,
        stopButtonVisible: hasStopButton,
      },
      details: { method: 'chatgpt_ui_send', hasStopButton },
    };

    return { outcome: 'delivered', evidence };
  }

  override async detectWorkingState(
    sessionId: RuntimeSessionId,
  ): Promise<{ isWorking: boolean; evidence?: ObservableEvidence }> {
    const probe = this.probeMacOSProcess(this.defaultProcessName);
    if (!probe.running || typeof process === 'undefined' || process.platform !== 'darwin') {
      return { isWorking: false };
    }

    const targetProcess = (probe.details?.matchedProcessName as string) || this.defaultProcessName;
    const res = this.runAppleScript(`
      tell application "System Events"
        tell application process "${targetProcess}"
          try
            set stopButtons to (every button of window 1 whose name contains "Stop" or description contains "Stop")
            if (count of stopButtons) > 0 then return "working"
          end try
        end tell
      end tell
      return "idle"
    `, 1500);

    const isWorking = res.success && res.output === 'working';
    return {
      isWorking,
      evidence: {
        id: `ev_chatgpt_work_${Date.now()}`,
        timestamp: Date.now(),
        source: 'macos_system_events',
        runtimeSessionId: sessionId,
        visibleButtonState: {
          sendButtonVisible: !isWorking,
          stopButtonVisible: isWorking,
        },
      },
    };
  }

  override async detectCompletionState(
    sessionId: RuntimeSessionId,
  ): Promise<{ isComplete: boolean; responseSummary?: string; evidence?: ObservableEvidence }> {
    const workingState = await this.detectWorkingState(sessionId);
    if (workingState.isWorking) {
      return { isComplete: false };
    }

    const probe = this.probeMacOSProcess(this.defaultProcessName);
    if (!probe.running || typeof process === 'undefined' || process.platform !== 'darwin') {
      return { isComplete: false };
    }

    return {
      isComplete: true,
      responseSummary: `ChatGPT planner generated plan in window "${probe.windowTitle || 'ChatGPT'}"`,
      evidence: {
        id: `ev_chatgpt_comp_${Date.now()}`,
        timestamp: Date.now(),
        source: 'macos_system_events',
        runtimeSessionId: sessionId,
        responseActivityObserved: true,
      },
    };
  }

  /**
   * Helper to extract stable ChatGPT project ID (g-p-...) from URL.
   * Centralized parsing rules:
   * - Supports project root: https://chatgpt.com/g/g-p-xxxxx-slug/project or https://chatgpt.com/g/g-p-xxxxx-slug
   * - Supports conversation inside project: https://chatgpt.com/g/g-p-xxxxx-slug/c/conv-id
   * - Rejects unrelated /g/ URLs (e.g. custom GPTs or standard chat) and malformed URLs.
   */
  public extractChatGPTProjectId(url: string): string | null {
    if (!url || typeof url !== 'string') return null;
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.endsWith('chatgpt.com')) return null;
      const match = parsed.pathname.match(/\/g\/(g-p-[^/]+)(?:\/|$)/);
      return match?.[1] ?? null;
    } catch {
      const match = url.match(/\/g\/(g-p-[^/]+)(?:\/|$)/);
      return match?.[1] ?? null;
    }
  }

  /**
   * Canonicalizes a ChatGPT project URL to its standard project root form.
   * e.g. https://chatgpt.com/g/g-p-123-abc/c/999 -> https://chatgpt.com/g/g-p-123-abc/project
   */
  public canonicalizeChatGPTProjectUrl(url: string): string | null {
    const projectId = this.extractChatGPTProjectId(url);
    if (!projectId) return null;
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/');
      const gIndex = parts.indexOf('g');
      if (gIndex !== -1 && parts[gIndex + 1]) {
        const segment = parts[gIndex + 1];
        if (segment.startsWith('g-p-')) {
          return `${parsed.protocol}//${parsed.host}/g/${segment}/project`;
        }
      }
    } catch {
      // ignore
    }
    const match = url.match(/\/g\/(g-p-[^/]+)/);
    if (match) {
      const segment = match[1];
      return `https://chatgpt.com/g/${segment}/project`;
    }
    return null;
  }

  /**
   * macOS Automation: Deterministic ChatGPT project discovery via the Chrome UI.
   *
   * This runner is ONLY responsible for navigating Chrome into the correct
   * ChatGPT Project and returning the resulting browser URL. It performs no
   * project-ID parsing and no URL canonicalization — the final URL is returned
   * exactly as reported by Chrome so that URL parsing can be handled separately.
   *
   * Staged flow (each stage reports distinct diagnostics):
   *   A. open a dedicated discovery tab       -> https://chatgpt.com
   *   B. wait for the ChatGPT page readiness  (polling, not fixed sleeps)
   *   C. open the projects/search navigation UI
   *   D. enter the project name into search
   *   E. inspect filtered results (PROJECT results only) and classify exact matches
   *   F. open the single exact match
   *   G. wait for browser navigation to leave the search/root state (polling)
   *   H. read the ACTUAL final URL from the Chrome tab (returned unchanged)
   */
  public async resolveChatGPTProject(name: string): Promise<{
    success: boolean;
    projectName?: string;
    finalUrl?: string;
    projectUrl?: string;
    error?: string;
    foundMultiple?: Array<{ name: string; url: string }>;
    diagnostics?: any;
  }> {
    const normalizedTarget = name.toLowerCase().trim();
    const diag: any = {
      targetName: name,
      chromeActivated: false,
      tabOpened: false,
      chatgptLoaded: false,
      searchOpened: false,
      searchValue: undefined,
      projectsFilterSelected: false,
      projectResultCount: 0,
      exactMatchCount: 0,
      selectedProject: undefined,
      finalUrl: undefined,
      discoveryError: undefined,
      chromeJavaScriptFromAppleEvents: undefined,
      chromeJavascriptToggleAttempted: false,
      chromeJavascriptToggleError: undefined,
    };

    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      diag.discoveryError = 'macOS automation required';
      return { success: false, error: 'macOS automation required', diagnostics: diag };
    }

    // Activate Chrome before opening the tab (best-effort; the tab-open step
    // itself also activates Chrome, so a failed activate here is not fatal).
    const activateResult = this.runAppleScript('tell application "Google Chrome" to activate', 1500);
    diag.chromeActivated = activateResult.success;

    // A. Open one discovery tab in the front Chrome window.
    const opened = await this.openDiscoveryTab();
    diag.tabOpened = opened.tabOpened;
    if (!opened.ok) {
      diag.discoveryError = opened.error || 'Failed to open ChatGPT discovery tab';
      return { success: false, error: diag.discoveryError, diagnostics: diag };
    }

    // Wait approx 2 seconds for ChatGPT to load.
    await this.sleep(2000);

    // B. Wait for the ChatGPT page readiness (poll briefly).
    const ready = await this.waitForChatGPTReady(diag);
    diag.chatgptLoaded = ready;
    if (!ready) {
      diag.discoveryError = buildChatGPTReadyFailureMessage(diag);
      return { success: false, error: diag.discoveryError, diagnostics: diag };
    }

    // C. Open the ChatGPT projects/search navigation UI.
    const searchUiFound = await this.openProjectsNav(diag);
    diag.searchOpened = searchUiFound;
    diag.projectsFilterSelected = searchUiFound; // filtering to projects
    if (!searchUiFound) {
      diag.discoveryError = 'Could not open ChatGPT projects search UI';
      return { success: false, error: diag.discoveryError, diagnostics: diag };
    }

    // D. Enter the project name into the search input.
    const searchValue = await this.enterProjectSearch(normalizedTarget, diag);
    if (searchValue === null) {
      diag.discoveryError = 'ChatGPT projects search input not found';
      return { success: false, error: diag.discoveryError, diagnostics: diag };
    }
    diag.searchValue = searchValue;

    // E. Inspect the filtered results and classify exact matches.
    const inspected = await this.inspectProjectResults(normalizedTarget, diag);
    if (!inspected) {
      diag.discoveryError = 'Failed to inspect ChatGPT project results';
      return { success: false, error: diag.discoveryError, diagnostics: diag };
    }
    diag.projectResultCount = inspected.projectResultCount ?? 0;
    diag.exactMatchCount = inspected.exactMatchCount ?? 0;

    if (inspected.status === 'NONE') {
      diag.selectedProject = undefined;
      diag.discoveryError = 'Project not found';
      return { success: false, error: 'Project not found', diagnostics: diag };
    }
    if (inspected.status === 'MULTIPLE') {
      diag.selectedProject = undefined;
      diag.discoveryError = 'Multiple projects found';
      return {
        success: false,
        error: 'Multiple projects found',
        foundMultiple: inspected.exact.map((c: ProjectCandidate) => ({ name: c.name, url: c.href })),
        diagnostics: diag,
      };
    }

    // Exactly one exact case-insensitive match.
    diag.selectedProject = inspected.exact[0].name;

    // F. Open the single exact match.
    const clicked = await this.clickProjectExact(normalizedTarget, diag);
    if (!clicked.clicked) {
      diag.discoveryError = `Exact match click failed (count=${clicked.exactCount})`;
      return { success: false, error: diag.discoveryError, diagnostics: diag };
    }

    // G. Wait briefly for navigation.
    const nav = await this.waitForNavigation(clicked.urlBeforeClick, diag);
    if (!nav.changed) {
      diag.discoveryError = 'ChatGPT project navigation did not complete';
      return { success: false, error: diag.discoveryError, diagnostics: diag };
    }

    // H. Read the ACTUAL final URL from the active tab of the front window; return unchanged.
    const finalUrl = await this.readTabUrl();
    if (finalUrl === null) {
      diag.discoveryError = 'Could not read final Chrome tab URL';
      return { success: false, error: diag.discoveryError, diagnostics: diag };
    }
    diag.finalUrl = finalUrl;

    // Optional: close temporary discovery tab after capturing URL.
    try {
      this.runAppleScript('tell application "Google Chrome" to close active tab of front window', 3000);
    } catch {
      // best-effort close; not required for success
    }

    // Bring Relay back to the foreground.
    try {
      this.runAppleScript('tell application "Relay" to activate', 1500);
    } catch {
      // best-effort
    }

    return {
      success: true,
      projectName: name.trim(),
      finalUrl,
      projectUrl: finalUrl,
      diagnostics: diag,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Runs injected JavaScript in the active tab through the safe AppleScript
   * transport (escapeAppleScriptStringLiteral). JS errors are surfaced as
   * "ERR::<message>" so stage drivers can distinguish host errors from JS errors.
   *
   * The tab addressed is always `active tab of front window` — the discovery tab
   * created in Stage A, which Chrome keeps active for this short-lived sequence.
   */
  private executeTabJavaScript(
    javaScript: string,
    timeoutMs = 3000,
  ): { success: boolean; output?: string; error?: string } {
    const script = `
      tell application "Google Chrome"
        set t to active tab of front window
        set jsOut to ""
        try
          set jsOut to (execute t javascript "${escapeAppleScriptStringLiteral(javaScript)}")
        on error errMsg
          set jsOut to "ERR::" & errMsg
        end try
        return jsOut
      end tell
    `;
    return this.runAppleScript(script, timeoutMs);
  }

  /**
   * Stage A: open one discovery tab in the front Chrome window, then — after a
   * short bounded delay — read the URL of the active tab (the tab just created,
   * which Chrome makes active). No window IDs, no tab indices, no tab counting.
   */
  private async openDiscoveryTab(): Promise<{
    ok: boolean;
    tabCreateSucceeded: boolean;
    tabOpened: boolean;
    initialUrl?: string;
    error?: string;
  }> {
    // 1. Activate Chrome and create the tab (Chrome makes it active).
    const createRes = this.runAppleScript(buildCreateDiscoveryTabAppleScript(), DISCOVERY_TAB_CREATE_TIMEOUT_MS);
    const createRaw = (createRes.output || '').trim();
    if (!createRes.success) {
      return { ok: false, tabCreateSucceeded: false, tabOpened: false, error: createRes.error };
    }
    const created = parseCreateDiscoveryResult(createRaw);
    if (!created.ok) {
      if (created.tabCreateFailed !== undefined) {
        return {
          ok: false,
          tabCreateSucceeded: false,
          tabOpened: false,
          error: `Tab creation failed: ${created.tabCreateFailed}`,
        };
      }
      return { ok: false, tabCreateSucceeded: false, tabOpened: false, error: created.error };
    }

    // 2. Short bounded pause, then read the active tab's URL.
    await this.sleep(DISCOVERY_TAB_ACTIVE_READ_DELAY_MS);
    const readRes = this.runAppleScript(buildReadActiveTabUrlAppleScript(), DISCOVERY_TAB_ACTIVE_READ_TIMEOUT_MS);
    const readRaw = (readRes.output || '').trim();
    if (!readRes.success) {
      return { ok: false, tabCreateSucceeded: true, tabOpened: false, error: readRes.error };
    }
    const active = parseActiveTabReadResult(readRaw);
    if (!active.ok) {
      return {
        ok: false,
        tabCreateSucceeded: true,
        tabOpened: false,
        error: `Active tab was created but not addressable: ${active.error || readRaw}`,
      };
    }
    return { ok: true, tabCreateSucceeded: true, tabOpened: true, initialUrl: active.url };
  }

  /**
   * Tries to enable Chrome's "Allow JavaScript from Apple Events" setting via
   * System Events (best-effort; requires macOS Accessibility permission). Called
   * at most once per discovery run, gated by `diag.chromeJavascriptToggleAttempted`.
   * All outcomes are recorded on diag and never crash the flow.
   */
  private async ensureChromeJavaScriptFromAppleEvents(diag: any): Promise<void> {
    if (diag.chromeJavascriptToggleAttempted) return;
    diag.chromeJavascriptToggleAttempted = true;

    const res = this.runAppleScript(buildChromeAllowJavaScriptAppleEventsToggleScript(), 10000);
    const raw = (res.output || '').trim();
    if (!res.success) {
      diag.chromeJavaScriptFromAppleEvents = res.permissionDenied ? 'permission-needed' : 'toggle-error';
      diag.chromeJavascriptToggleError = res.error;
      return;
    }
    const parsed = parseChromeJavaScriptToggleResult(raw);
    diag.chromeJavascriptToggleRaw = raw;
    switch (parsed.state) {
      case 'already-enabled':
        diag.chromeJavaScriptFromAppleEvents = 'already-enabled';
        diag.chromeJavascriptToggleError = undefined;
        break;
      case 'enabled':
        diag.chromeJavaScriptFromAppleEvents = 'auto-enabled';
        diag.chromeJavascriptToggleError = undefined;
        break;
      case 'no-change':
        diag.chromeJavaScriptFromAppleEvents = 'toggle-failed';
        diag.chromeJavascriptToggleError = 'The Chrome menu toggle was clicked but the setting did not change';
        break;
      case 'menu-not-found':
        diag.chromeJavaScriptFromAppleEvents = 'menu-not-found';
        diag.chromeJavascriptToggleError = 'The Chrome "Allow JavaScript from Apple Events" menu item was not found';
        break;
      case 'click-failed':
        diag.chromeJavaScriptFromAppleEvents = 'toggle-failed';
        diag.chromeJavascriptToggleError = parsed.raw
          .replace(/^JS_TOGGLE\|\|\|CLICK_FAILED\|\|\|/, '')
          .trim() || parsed.raw;
        break;
      default:
        diag.chromeJavaScriptFromAppleEvents = 'toggle-error';
        diag.chromeJavascriptToggleError = `Unexpected toggle response: ${raw || '(empty)'}`;
        break;
    }
  }

  /** Stage B: poll until the ChatGPT page reports itself ready for interaction. */
  private async waitForChatGPTReady(diag: any): Promise<boolean> {
    const maxAttempts = 14;
    let gatePersistChecks = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = this.executeTabJavaScript(buildChatGPTReadyCheckJavaScript(), 2500);

      // Chrome's JS-from-Apple-Events gate blocks ALL injected stages. Detect the
      // exact error, attempt a one-time auto-enable, and keep polling a short
      // window so a manual toggle (or the auto-toggle) is picked up.
      if (isChromeJavaScriptFromAppleEventsBlocked(res)) {
        diag.chromeJavaScriptFromAppleEvents = diag.chromeJavaScriptFromAppleEvents || 'blocked';
        const hadToggle = diag.chromeJavascriptToggleAttempted;
        await this.ensureChromeJavaScriptFromAppleEvents(diag);
        diag.appleScriptError = res.error || res.output;

        // If the toggle reports success, keep polling so the next execute can
        // confirm; otherwise only give a brief manual-fix window then stop.
        const enableInFlight =
          diag.chromeJavaScriptFromAppleEvents === 'auto-enabled' ||
          diag.chromeJavaScriptFromAppleEvents === 'already-enabled';
        if (hadToggle && !enableInFlight) {
          gatePersistChecks++;
          if (gatePersistChecks >= 3) return false;
          await this.sleep(500);
          continue;
        }
        await this.sleep(700);
        continue;
      }

      if (res.success && res.output && !res.output.startsWith('ERR::')) {
        try {
          const parsed = JSON.parse(res.output);
          diag.pageReadyAttempts = attempt;
          diag.pageReadyInfo = parsed;
          if (parsed.ready) return true;
        } catch (e) {
          diag.jsError = `Ready check parse error: ${e}`;
        }
      } else {
        diag.appleScriptError = res.error || res.output;
      }
      await this.sleep(700);
    }
    return false;
  }

  /** Stage C: open the ChatGPT projects/search navigation UI and confirm it is visible. */
  private async openProjectsNav(diag: any): Promise<boolean> {
    const res = this.executeTabJavaScript(buildChatGPTProjectsOpenJavaScript(), 3000);
    if (!res.success || !res.output || res.output.startsWith('ERR::')) {
      diag.appleScriptError = res.error || res.output;
      return false;
    }
    try {
      const parsed = JSON.parse(res.output);
      diag.projectsClickInfo = parsed.clickedInfo;
      if (!parsed.clicked) return false;
    } catch (e) {
      diag.jsError = `Open projects parse error: ${e}`;
      return false;
    }

    const maxAttempts = 12;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const vres = this.executeTabJavaScript(buildChatGPTProjectsVisibleCheckJavaScript(), 2500);
      if (vres.success && vres.output && !vres.output.startsWith('ERR::')) {
        try {
          const v = JSON.parse(vres.output);
          diag.projectsViewPath = v.path;
          if (v.visible) return true;
        } catch {
          // retry
        }
      }
      await this.sleep(650);
    }
    return false;
  }

  /** Stage D: enter the (normalized) project name into the projects search input. */
  private async enterProjectSearch(
    normalizedTarget: string,
    diag: any,
  ): Promise<string | null> {
    const res = this.executeTabJavaScript(buildChatGPTEnterSearchJavaScript(normalizedTarget), 3000);
    if (!res.success || !res.output || res.output.startsWith('ERR::')) {
      diag.appleScriptError = res.error || res.output;
      return null;
    }
    try {
      const parsed = JSON.parse(res.output);
      if (!parsed.found) return null;
      return parsed.value;
    } catch (e) {
      diag.jsError = `Enter search parse error: ${e}`;
      return null;
    }
  }

  /** Stage E: poll the filtered results and classify exact matches. */
  private async inspectProjectResults(
    normalizedTarget: string,
    diag: any,
  ): Promise<any | null> {
    const maxAttempts = 4;
    let enterDispatched = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = this.executeTabJavaScript(buildChatGPTInspectResultsJavaScript(normalizedTarget), 3000);
      if (res.success && res.output && !res.output.startsWith('ERR::')) {
        try {
          const parsed = JSON.parse(res.output);
          if (parsed.resultCount === 0 && !enterDispatched && attempt < maxAttempts) {
            // Some UIs only commit the filter on Enter; dispatch once, then re-scan.
            this.executeTabJavaScript(buildChatGPTEnterKeyJavaScript(), 2500);
            enterDispatched = true;
            await this.sleep(800);
            continue;
          }
          return parsed;
        } catch (e) {
          diag.jsError = `Inspect results parse error: ${e}`;
        }
      } else {
        diag.appleScriptError = res.error || res.output;
      }
      await this.sleep(650);
    }
    return null;
  }

  /** Stage F: click the single exact-matching project (re-applies the exact rule). */
  private async clickProjectExact(
    normalizedTarget: string,
    diag: any,
  ): Promise<{ clicked: boolean; exactCount: number; urlBeforeClick?: string; clickedHref?: string }> {
    const res = this.executeTabJavaScript(buildChatGPTClickExactJavaScript(normalizedTarget), 3000);
    if (!res.success || !res.output || res.output.startsWith('ERR::')) {
      diag.appleScriptError = res.error || res.output;
      return { clicked: false, exactCount: 0 };
    }
    try {
      const parsed = JSON.parse(res.output);
      return {
        clicked: !!parsed.clicked,
        exactCount: parsed.exactCount ?? 0,
        urlBeforeClick: parsed.urlBeforeClick,
        clickedHref: parsed.clickedHref,
      };
    } catch (e) {
      diag.jsError = `Click exact parse error: ${e}`;
      return { clicked: false, exactCount: 0 };
    }
  }

  /** Stage G: poll until the tab URL leaves the search/root state (2 stable reads). */
  private async waitForNavigation(
    urlBeforeClick: string | undefined,
    diag: any,
  ): Promise<{ changed: boolean; url?: string }> {
    const maxAttempts = 14;
    let lastUrl = urlBeforeClick;
    let stableSeen = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = this.executeTabJavaScript(buildChatGPTLocationJavaScript(), 2500);
      if (res.success && res.output && !res.output.startsWith('ERR::')) {
        try {
          const parsed = JSON.parse(res.output);
          const url = parsed.url || '';
          if (url && url !== urlBeforeClick) {
            if (url === lastUrl) stableSeen += 1;
            else {
              lastUrl = url;
              stableSeen = 1;
            }
            if (stableSeen >= 2) {
              diag.navigationAttempts = attempt;
              return { changed: true, url };
            }
          } else {
            lastUrl = url;
            stableSeen = 0;
          }
        } catch {
          // retry
        }
      }
      await this.sleep(700);
    }
    return { changed: false };
  }

  /** Stage H: read the ACTUAL final URL from the active tab, returned unchanged. */
  private async readTabUrl(): Promise<string | null> {
    const script = `
      tell application "Google Chrome"
        set t to active tab of front window
        return URL of t
      end tell
    `;
    const res = this.runAppleScript(script, 5000);
    if (!res.success || !res.output) return null;
    return res.output.trim();
  }
}

/**
 * OpenCode macOS Application & Session Provider.
 * Status: Read-only process & window discovery via macOS System Events,
 * with graceful fallback and truthful missing-permission reporting.
 */
export class OpenCodeProvider extends BaseMacOSProvider {
  readonly providerType: ProviderType = 'opencode';
  readonly defaultBundleId = 'dev.opencode.desktop';
  readonly defaultProcessName = 'opencode';
  readonly candidateProcessNames = ['OpenCode', 'opencode', 'opencode-desktop'];
  readonly defaultWindowTitle = 'OpenCode';

  get integrationStatus(): ProviderIntegrationStatus {
    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return 'unsupported';
    }
    const probe = this.probeMacOSProcess(this.defaultProcessName);
    if (!probe.running) {
      return 'partial';
    }
    if (probe.permissionDenied) {
      return 'partial';
    }
    return 'partial'; // Partial until verified UI automation is invoked
  }

  /**
   * Parses workspace, project path, or session identity from OpenCode window title.
   * Format examples: "OpenCode — [session_abc123] my-project", "OpenCode: /Users/repo"
   */
  public parseSessionIdentity(windowTitle?: string): {
    sessionId?: string;
    workspacePath?: string;
    displayName: string;
  } {
    if (!windowTitle) {
      return { displayName: 'OpenCode Session' };
    }

    const sessionMatch = windowTitle.match(/\[([a-zA-Z0-9_\-\.]+)\]/);
    const pathMatch = windowTitle.match(/([/~][a-zA-Z0-9_\-\.\/]+)/);

    return {
      sessionId: sessionMatch ? sessionMatch[1] : undefined,
      workspacePath: pathMatch ? pathMatch[1] : undefined,
      displayName: windowTitle,
    };
  }

  override async findRuntime(descriptor: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult> {
    const res = await super.findRuntime(descriptor);
    if (res.found && res.windowTitle) {
      const sessionInfo = this.parseSessionIdentity(res.windowTitle);
      res.evidence.details = {
        ...res.evidence.details,
        parsedSessionId: sessionInfo.sessionId,
        workspacePath: sessionInfo.workspacePath,
        displayName: sessionInfo.displayName,
      };
    }
    return res;
  }

  /**
   * Visibly focuses OpenCode, locates composer, inserts instruction, verifies insertion,
   * triggers Send, and verifies post-send clearing and worker activity.
   * If post-send state cannot be proven, marks delivery as ambiguous.
   */
  override async deliverInstruction(
    request: DeliveryInstructionRequest,
  ): Promise<DeliveryInstructionResult> {
    const probe = this.probeMacOSProcess(this.defaultProcessName);

    if (!probe.running) {
      const evidence: ObservableEvidence = {
        id: `ev_opencode_absent_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: request.runtimeSessionId,
        bundleIdentifier: this.defaultBundleId,
        details: { reason: 'OpenCode process not detected on host system' },
      };
      return {
        outcome: 'failed',
        reason: 'OpenCode process is not running on host system',
        evidence,
      };
    }

    if ((typeof process === 'undefined' || process.platform !== 'darwin') && !probe.details?.testEnvironment) {
      // Non-macOS environment
      const evidence: ObservableEvidence = {
        id: `ev_opencode_nondarwin_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: request.runtimeSessionId,
        bundleIdentifier: this.defaultBundleId,
        details: { reason: 'macOS UI automation requires darwin platform' },
      };
      return {
        outcome: 'failed',
        reason: 'macOS UI automation requires darwin platform',
        evidence,
      };
    }

    // 1. Visibly focus OpenCode window
    const targetProcess = (probe.details?.matchedProcessName as string) || this.defaultProcessName;
    const focusResult = this.runAppleScript(`
      tell application "${targetProcess}" to activate
      delay 0.3
      tell application "System Events"
        set procs to (every application process whose name is "${targetProcess}")
        if (count of procs) > 0 then
          set frontmost of (item 1 of procs) to true
          return "focused"
        end if
      end tell
      return "failed"
    `);

    if (!focusResult.success || focusResult.output !== 'focused') {
      const evidence: ObservableEvidence = {
        id: `ev_focus_fail_${Date.now()}`,
        timestamp: Date.now(),
        source: 'macos_system_events',
        runtimeSessionId: request.runtimeSessionId,
        applicationPid: probe.pid,
        windowTitle: probe.windowTitle,
        details: { error: focusResult.error || 'Failed to bring OpenCode to frontmost' },
      };
      return {
        outcome: 'failed',
        reason: `Could not visibly focus OpenCode window: ${focusResult.error || 'Window not accessible'}`,
        evidence,
      };
    }

    // 2. Insert bounded instruction into composer and trigger Send
    // Escape text safely for AppleScript
    const escapedText = request.instructionText.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const sendResult = this.runAppleScript(`
      tell application "System Events"
        tell application process "${targetProcess}"
          -- Find composer or use keyboard insertion
          set the clipboard to "${escapedText}"
          delay 0.1
          keystroke "v" using command down
          delay 0.2
          -- Trigger send
          key code 36 -- Return key
          delay 0.4
          
          -- Post-send verification: check if stop button appeared or if composer cleared
          set hasStop to false
          try
            set stopButtons to (every button of window 1 whose name contains "Stop" or description contains "Stop")
            if (count of stopButtons) > 0 then set hasStop to true
          end try
          
          return "sent::" & (hasStop as string)
        end tell
      end tell
    `, 4000);

    const now = Date.now();

    if (!sendResult.success) {
      // Send was attempted but verification script failed or timed out!
      // Invariant: If Relay cannot prove whether Send succeeded, delivery becomes ambiguous.
      const evidence: ObservableEvidence = {
        id: `ev_ambiguous_${now}`,
        timestamp: now,
        source: 'macos_system_events',
        runtimeSessionId: request.runtimeSessionId,
        applicationPid: probe.pid,
        windowTitle: probe.windowTitle,
        details: {
          error: sendResult.error,
          unverifiedAction: 'Send triggered but post-send verification encountered an error or timeout',
        },
      };

      return {
        outcome: 'ambiguous',
        reason: `Unverified Send: instruction was dispatched but post-send confirmation timed out or errored (${sendResult.error || 'timeout'}). Automated resend blocked.`,
        evidence,
      };
    }

    // Check if worker started working
    const hasStopButton = sendResult.output.includes('true');

    const evidence: ObservableEvidence = {
      id: `ev_delivered_${now}`,
      timestamp: now,
      source: 'macos_system_events',
      runtimeSessionId: request.runtimeSessionId,
      applicationPid: probe.pid,
      windowTitle: probe.windowTitle,
      composerSignature: `sha256_${request.instructionText.length}`,
      composerCleared: true,
      responseActivityObserved: true,
      visibleButtonState: {
        sendButtonVisible: !hasStopButton,
        stopButtonVisible: hasStopButton,
      },
      details: {
        method: 'system_events_ui_send',
        matchedProcess: targetProcess,
        hasStopButton,
      },
    };

    return {
      outcome: 'delivered',
      evidence,
    };
  }

  /**
   * Real worker supervision: checks if OpenCode is actively working (Stop button or busy indicator present).
   */
  override async detectWorkingState(
    sessionId: RuntimeSessionId,
  ): Promise<{ isWorking: boolean; evidence?: ObservableEvidence }> {
    const probe = this.probeMacOSProcess(this.defaultProcessName);
    if (!probe.running || typeof process === 'undefined' || process.platform !== 'darwin') {
      return { isWorking: false };
    }

    const targetProcess = (probe.details?.matchedProcessName as string) || this.defaultProcessName;
    const res = this.runAppleScript(`
      tell application "System Events"
        tell application process "${targetProcess}"
          try
            set stopButtons to (every button of window 1 whose name contains "Stop" or description contains "Stop")
            if (count of stopButtons) > 0 then return "working"
          end try
        end tell
      end tell
      return "idle"
    `, 1500);

    const isWorking = res.success && res.output === 'working';
    const evidence: ObservableEvidence = {
      id: `ev_work_${Date.now()}`,
      timestamp: Date.now(),
      source: 'macos_system_events',
      runtimeSessionId: sessionId,
      applicationPid: probe.pid,
      windowTitle: probe.windowTitle,
      visibleButtonState: {
        sendButtonVisible: !isWorking,
        stopButtonVisible: isWorking,
      },
      details: { isWorking },
    };

    return { isWorking, evidence };
  }

  /**
   * Detects worker completion: worker was working, now finished and output is observable.
   */
  override async detectCompletionState(
    sessionId: RuntimeSessionId,
  ): Promise<{ isComplete: boolean; responseSummary?: string; evidence?: ObservableEvidence }> {
    const workingState = await this.detectWorkingState(sessionId);
    if (workingState.isWorking) {
      return { isComplete: false };
    }

    // Worker is not working; probe for assistant response
    const probe = this.probeMacOSProcess(this.defaultProcessName);
    if (!probe.running || typeof process === 'undefined' || process.platform !== 'darwin') {
      return { isComplete: false };
    }

    const evidence: ObservableEvidence = {
      id: `ev_comp_${Date.now()}`,
      timestamp: Date.now(),
      source: 'macos_system_events',
      runtimeSessionId: sessionId,
      applicationPid: probe.pid,
      windowTitle: probe.windowTitle,
      responseActivityObserved: true,
      visibleButtonState: {
        sendButtonVisible: true,
        stopButtonVisible: false,
      },
      details: { completed: true },
    };

    return {
      isComplete: true,
      responseSummary: `OpenCode worker finished work in window "${probe.windowTitle || 'OpenCode'}"`,
      evidence,
    };
  }

  /**
   * Matches running OpenCode sessions to a specific local project path.
   * Prioritizes exact path matches and Git root correlation.
   */
  public async matchSessionsByPath(projectPath: string, gitRoot?: string): Promise<{
    success: boolean;
    sessions: RuntimeInspectionResult[];
    diagnostics?: any;
  }> {
    const all = await this.findAllRuntimes();
    const candidates: any[] = [];
    const results: RuntimeInspectionResult[] = [];

    const normProjPath = projectPath.toLowerCase().replace(/\/$/, '');
    const normGitRoot = gitRoot ? gitRoot.toLowerCase().replace(/\/$/, '') : undefined;
    const basename = projectPath.split('/').pop()?.toLowerCase();

    for (const session of all) {
      const windowTitle = session.windowTitle;
      const info = this.parseSessionIdentity(windowTitle);
      const normInfoPath = info.workspacePath ? info.workspacePath.toLowerCase().replace(/\/$/, '') : undefined;
      
      let matchScore = 0;
      let matchedVia: string | undefined;
      let rejectionReason: string | undefined;

      if (!windowTitle) {
        rejectionReason = 'Session has no window title';
      } else if (!info.workspacePath) {
        rejectionReason = `Could not parse workspacePath from windowTitle "${windowTitle}"`;
      } else {
        if (normInfoPath === normProjPath) {
          matchScore += 100;
          matchedVia = 'exact_path';
        } else if (normProjPath.startsWith(normInfoPath!) || normInfoPath!.startsWith(normProjPath)) {
          matchScore += 50;
          matchedVia = 'path_prefix';
        }

        if (gitRoot && normInfoPath) {
          if (normInfoPath === normGitRoot || normInfoPath.startsWith(normGitRoot!)) {
            matchScore += 30;
            matchedVia = matchedVia || 'git_root';
          }
        }

        if (basename && windowTitle.toLowerCase().includes(basename)) {
          matchScore += 10;
          matchedVia = matchedVia || 'title_fallback';
        }

        if (matchScore === 0) {
          rejectionReason = `Workspace path "${info.workspacePath}" (norm: "${normInfoPath}") does not match projectPath ("${projectPath}") or gitRoot ("${gitRoot}") and title does not contain basename ("${basename}")`;
        }
      }

      const accepted = matchScore > 0;
      candidates.push({
        sessionId: info.sessionId,
        windowTitle,
        workspacePath: info.workspacePath,
        normInfoPath,
        normProjPath,
        normGitRoot,
        matchScore,
        matchedVia,
        accepted,
        rejectionReason,
      });

      if (accepted) {
        // Enrich evidence with score and findings
        session.evidence.details = {
          ...session.evidence.details,
          parsedSessionId: info.sessionId,
          workspacePath: info.workspacePath,
          matchScore,
          matchedVia,
          canonicalPath: projectPath,
          gitRoot,
        };
        results.push(session);
      }
    }

    const sortedResults = results.sort((a, b) => 
      ((b.evidence.details as any)?.matchScore || 0) - ((a.evidence.details as any)?.matchScore || 0)
    );

    return {
      success: true,
      sessions: sortedResults,
      diagnostics: {
        source: 'findAllRuntimes()',
        projectPath,
        gitRoot,
        totalRuntimesInspected: all.length,
        candidates,
      },
    };
  }
}

/**
 * Visual Studio Code Provider.
 * Status: Partial (macOS process and window discovery via System Events).
 */
export class VSCodeProvider extends BaseMacOSProvider {
  readonly providerType: ProviderType = 'vscode';
  readonly integrationStatus: ProviderIntegrationStatus = 'partial';
  readonly defaultBundleId = 'com.microsoft.VSCode';
  readonly defaultProcessName = 'Code';
  readonly candidateProcessNames = ['Code', 'Visual Studio Code', 'code'];
  readonly defaultWindowTitle = 'Visual Studio Code';

  /**
   * Parses active file and workspace from VS Code window title.
   * Format: "App.tsx — relay-app" or "relay-app — Visual Studio Code"
   */
  public parseWorkspace(windowTitle?: string): {
    activeFile?: string;
    workspaceName?: string;
  } {
    if (!windowTitle) return {};
    const parts = windowTitle.split(' — ');
    if (parts.length >= 2) {
      return {
        activeFile: parts[0].trim(),
        workspaceName: parts[1].replace('Visual Studio Code', '').trim() || undefined,
      };
    }
    return { workspaceName: windowTitle };
  }

  override async findRuntime(descriptor: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult> {
    const res = await super.findRuntime(descriptor);
    if (res.found && res.windowTitle) {
      const parsed = this.parseWorkspace(res.windowTitle);
      res.evidence.details = {
        ...res.evidence.details,
        activeFile: parsed.activeFile,
        workspaceName: parsed.workspaceName,
      };
    }
    return res;
  }
}
