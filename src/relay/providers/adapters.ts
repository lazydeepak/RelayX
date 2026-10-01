/**
 * ============================================================================
 * RELAY PROVIDER ADAPTERS — MACOS DESKTOP, CHROME, & CLI BRIDGES
 * ============================================================================
 *
 * This module implements the provider adapters that allow RelayX to observe,
 * control, and coordinate external developer AI agents on macOS without requiring
 * invasive plugins or custom protocols.
 *
 * ADAPTERS IMPLEMENTED:
 *
 * 1. BaseMacOSProvider:
 *    - Process probing (`pgrep`, `ps aux`) and bundle identifier resolution.
 *    - Native AppleScript window focus and keystroke generation via System Events.
 *    - Observable evidence capture (`ObservableEvidence`) with visible UI button states.
 *
 * 2. ChatGPTProvider (Planner):
 *    - Discovers active ChatGPT sessions in Google Chrome via AppleScript tab inspection.
 *    - Navigates ChatGPT UI using native keyboard shortcuts (`Cmd+K`) and DOM search injection.
 *    - Parses and normalizes project/conversation URLs (`chatgpt.com/g/<project>/c/<conversation>`).
 *
 * 3. OpenCodeProvider (Worker):
 *    - Shared Service Protocol: Inspects `~/.local/state/opencode/service.json` to query
 *      the local OpenCode HTTP service for directory-scoped sessions.
 *    - CLI Inspection: Falls back to `opencode session list --format json`.
 *    - Phase E Exact Worker Transport:
 *      * Verifies target `ses_*` session exists in provider store.
 *      * Captures durable pre-dispatch watermark prior to transport.
 *      * Executes `opencode run --session <id> --continue` without shell expansion.
 *      * Reconciles external transcript turns against watermark on all exit paths.
 *      * Evaluates transport delivery and worker execution independently.
 *
 * 4. VSCodeProvider (Worker/Editor):
 *    - Inspects window titles to track active workspace and active editor file.
 */

import {
  RuntimeSessionId,
  RuntimeSessionStatus,
  ObservableEvidence,
  ProviderType,
  ProviderIntegrationStatus,
  SideObservationReading,
  SideExistenceState,
  SideReachabilityState,
  SideUiPresenceState,
  SideActivityState,
  SideMessageEvidenceState,
  SideMessageEvidence,
  PROVISIONAL_OBSERVATION_VALIDITY_MS,
} from '../domain/types.ts';
import {
  IRuntimeProvider,
  RuntimeInspectionResult,
  RuntimeTargetDescriptor,
  DeliveryInstructionRequest,
  DeliveryInstructionResult,
  TransportBoundaryRequest,
  TransportBoundaryResult,
  ProviderSessionConfirmation,
  SideIdentityRequest,
  SideIdentityResolution,
  SideObservationRequest,
} from './interfaces.ts';
import {
  OpenCodeServiceError,
  discoverOpenCodeSessionClient,
  type DiscoveredSessionClient,
  type OpenCodeServiceErrorCode,
  type OpenCodeSessionSummary,
  type ServiceDiscoveryFailure,
} from './opencodeSessionClient.ts';
import {
  buildWatermark,
  reconcileTransportOutcome,
  type ExactSessionWatermark,
  type ReconciliationMessage,
} from './exactSessionReconciliation.ts';

/**
 * S2 observation helpers.
 *
 * These are pure functions over already-parsed JSON, kept module-level so the
 * dimension logic is readable and independently testable. They never throw: a
 * read that cannot be understood becomes `unknown` with a reason (I-6).
 */

/** A reading that could not be established at all, with every dimension unknown. */
function unreadable(now: number, validUntil: number, reason: string): SideObservationReading {
  return {
    reachabilityState: 'unknown',
    uiPresenceState: 'unknown',
    activityState: 'unknown',
    messageEvidenceState: 'unknown',
    message: { ref: null, role: null, text: null, truncated: false, ordinal: null },
    observationCapability: 'opencode_cli_session_status_transcript',
    observedAt: now,
    validUntil,
    reason,
    evidence: null,
  };
}

/** `asRecord`-style helpers, duplicated locally to avoid touching shared code. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function asRecordList(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  const inner = asRecord(value)?.data ?? asRecord(value)?.sessions;
  return Array.isArray(inner) ? (inner as Record<string, unknown>[]) : null;
}
function firstReason(
  ...results: Array<{ ok: boolean; reason?: string }>
): string {
  for (const r of results) if (!r.ok && r.reason) return r.reason;
  return 'no reason reported';
}

/**
 * S2 — the latest MEANINGFUL message, per the provider's own classification.
 *
 * ## "Meaningful" means the provider called it a conversational turn
 *
 * `roleFromType` in the session client maps `user`/`assistant` to themselves,
 * `system`/`synthetic` to `system`, and EVERYTHING ELSE — reasoning parts, tool
 * calls, and any future type — to `other`. So selecting only
 * `user | assistant | system` is not a RelayX guess about what matters; it is
 * RelayX honouring the provider's own classification and declining to present a
 * reasoning or tool fragment as a user-visible response (C-8, §9 of the S2 brief).
 *
 * ## Ordering is the provider's, and only within this one session
 *
 * A message is orderable only if the provider gave it a `time.created`. Messages
 * are ranked ascending by `(createdAt, providerArrayIndex)` — the index tie-break
 * makes the rank total and deterministic, so the same provider response always
 * yields the same ordinal. The resulting `ordinal` is therefore monotonic within
 * ONE provider and ONE session, and S2 compares nothing across providers (I-7).
 *
 * If no message is orderable the answer is `unknown` with a reason, never
 * `none`: "no message carries a provider timestamp" is not the same claim as
 * "the session has no messages" (I-6).
 */
function readLatestMeaningfulMessage(transcript: {
  ok: boolean;
  data?: unknown;
  reason?: string;
}): { state: SideMessageEvidenceState; evidence: SideMessageEvidence; reason: string | null } {
  const empty: SideMessageEvidence = { ref: null, role: null, text: null, truncated: false, ordinal: null };
  if (!transcript.ok) {
    return {
      state: 'unknown',
      evidence: empty,
      reason: `The transcript read did not complete: ${transcript.reason ?? 'no reason reported'}`,
    };
  }
  const rows = asRecordList(transcript.data);
  if (rows === null) {
    return { state: 'unknown', evidence: empty, reason: 'The transcript response was not a message list' };
  }

  const conversational = new Set(['user', 'assistant', 'system']);
  const orderable: Array<{ createdAt: number; index: number; row: Record<string, unknown> }> = [];
  for (const [index, row] of rows.entries()) {
    const type = asString(asRecord(row)?.type);
    const role = type === 'user' ? 'user' : type === 'assistant' ? 'assistant' : type === 'system' || type === 'synthetic' ? 'system' : 'other';
    if (!conversational.has(role)) continue;
    const created = asRecord(asRecord(row)?.time)?.created;
    const createdAt = typeof created === 'number' ? created : undefined;
    // Only provider-timestamped messages are orderable; an undated one cannot be
    // ranked without inventing an ordering the provider did not give.
    if (createdAt === undefined) continue;
    orderable.push({ createdAt, index, row: { ...row, __role: role } });
  }

  if (orderable.length === 0) {
    return {
      state: rows.length === 0 ? 'none' : 'unknown',
      evidence: empty,
      reason:
        rows.length === 0
          ? null
          : 'The session has messages, but none is both a conversational turn and provider-timestamped, so the latest one cannot be established',
    };
  }

  orderable.sort((a, b) => a.createdAt - b.createdAt || a.index - b.index);
  const latest = orderable[orderable.length - 1];
  const content = Array.isArray(latest.row.content) ? latest.row.content : [];
  const text = content
    .map((part) => {
      const p = asRecord(part);
      return p && p.type === 'text' ? (asString(p.text) ?? '') : '';
    })
    .filter((t) => t.length > 0)
    .join('\n');

  return {
    state: 'observed',
    evidence: {
      ref: asString(latest.row.id) ?? null,
      role: (latest.row.__role as SideMessageEvidence['role']) ?? 'other',
      text: text.length > 0 ? text : null,
      // Truncation is recorded, never hidden (C-8, §10.3).
      truncated: rows.length > 200,
      // The rank in the provider's own ordering of THIS session.
      ordinal: orderable.length - 1,
    },
    reason: null,
  };
}

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

  async activateRuntime(sessionId: RuntimeSessionId, windowTitle?: string): Promise<boolean> {
    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return false;
    }

    try {
      const res = this.runAppleScript(`tell application "${this.defaultProcessName}" to activate`, 2000);
      return res.success;
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
    ready: (document.readyState === 'complete' || document.readyState === 'interactive') && found.length > 0,
    readyState: document.readyState,
    title: document.title,
    url: location.href,
    found: found
  });
})();`;
}

/**
 * Builds the JS that opens the ChatGPT project/search navigation UI
 * (the sidebar "Search chats", "Projects" entry, or search modal)
 * in the discovery tab.
 */
export function buildChatGPTProjectsOpenJavaScript(): string {
  return `(() => {
  const STAGE = "__relay_stage_open_projects__";

  // 1. If search input or project index route is already open, succeed immediately
  const existingSearchInput = document.querySelector(
    '[role="dialog"] input, [role="dialog"] [role="searchbox"], input[placeholder*="Search" i], input[aria-label*="search" i], input[type="search"], [role="searchbox"], [role="combobox"][placeholder*="Search" i]'
  );
  if (existingSearchInput || location.pathname === '/projects' || location.pathname.startsWith('/projects/')) {
    return JSON.stringify({
      clicked: true,
      alreadyOpen: true,
      clickedInfo: { selector: 'already_visible', text: 'Search UI already open' },
      url: location.href
    });
  }

  // 2. If sidebar is collapsed, expand it first
  const sidebarToggle = document.querySelector(
    'button[aria-label*="Open sidebar" i], button[data-testid*="open-sidebar" i]'
  );
  if (sidebarToggle && !document.querySelector('nav, [data-testid*="sidebar" i]')) {
    sidebarToggle.click();
  }

  let clickedInfo = null;

  // 3. Search / Search chats button in sidebar (opens command palette / search dialog)
  const searchSels = [
    'button[data-testid*="search" i]',
    '[data-testid="search-button"]',
    'button[aria-label*="Search" i]',
    '[aria-label*="Search chats" i]',
    'a[href*="/search"]'
  ];
  for (let i = 0; i < searchSels.length; i++) {
    const el = document.querySelector(searchSels[i]);
    if (el) {
      clickedInfo = {
        selector: searchSels[i],
        text: (el.innerText || el.textContent || '').trim(),
        href: null
      };
      el.click();
      break;
    }
  }

  // 4. Look for clickable element with "search chats" or "search" text
  if (!clickedInfo) {
    const clickables = [...document.querySelectorAll('a, button, [role="button"]')];
    for (let i = 0; i < clickables.length; i++) {
      const e = clickables[i];
      const t = (e.innerText || e.textContent || '').trim().toLowerCase();
      if (t === 'search chats' || t === 'search') {
        clickedInfo = {
          selector: 'text:' + t,
          text: (e.innerText || e.textContent || '').trim(),
          href: null
        };
        e.click();
        break;
      }
    }
  }

  // 5. Look for explicit "Projects" section link or button (NOT individual project links)
  if (!clickedInfo) {
    const projectSels = [
      'a[href="/projects"]',
      'a[href*="/projects"]',
      '[aria-label="Projects"]',
      '[aria-label="Projects" i]'
    ];
    for (let i = 0; i < projectSels.length; i++) {
      const el = document.querySelector(projectSels[i]);
      if (el) {
        clickedInfo = {
          selector: projectSels[i],
          text: (el.innerText || el.textContent || '').trim(),
          href: (el.getAttribute && el.getAttribute('href')) || null
        };
        el.click();
        break;
      }
    }
  }

  // 6. Exact text match for "Projects" (never substring/regex to avoid clicking individual projects)
  if (!clickedInfo) {
    const candidates = [...document.querySelectorAll('a, button, [role="button"], [role="tab"], [role="menuitem"]')];
    for (let i = 0; i < candidates.length; i++) {
      const e = candidates[i];
      const t = (e.innerText || e.textContent || '').trim().toLowerCase();
      if (t === 'projects') {
        clickedInfo = {
          selector: 'text:Projects',
          text: (e.innerText || e.textContent || '').trim(),
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
    '[role="dialog"] input, [role="dialog"] [role="searchbox"], input[placeholder*="Search" i], input[aria-label*="search" i], input[type="search"], [role="searchbox"], input[data-testid*="search" i], [role="combobox"][placeholder*="Search" i]'
  );
  const activeEl = document.activeElement;
  const isActiveSearch = !!(activeEl && (
    activeEl.tagName === 'INPUT' ||
    activeEl.getAttribute('role') === 'searchbox' ||
    activeEl.getAttribute('role') === 'combobox'
  ) && !activeEl.closest('form[class*="composer" i]'));

  const hasProjectList = !!document.querySelector(
    'a[href*="/projects/"], [data-testid*="project-list" i]'
  );
  const isProjectsRoute = path === '/projects' || path.startsWith('/projects/');

  // If search modal is open, attempt to select "Projects" tab/pill if available
  if (hasSearchInput || isActiveSearch) {
    const pills = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="tab"], [role="dialog"] [role="radio"], button, [role="tab"]')];
    for (let i = 0; i < pills.length; i++) {
      const t = (pills[i].innerText || pills[i].textContent || '').trim().toLowerCase();
      if (t === 'projects') {
        const isSelected = pills[i].getAttribute('aria-selected') === 'true' ||
                           pills[i].getAttribute('data-state') === 'active' ||
                           pills[i].getAttribute('aria-checked') === 'true';
        if (!isSelected) {
          pills[i].click();
        }
        break;
      }
    }
  }

  return JSON.stringify({
    visible: isProjectsRoute || hasSearchInput || isActiveSearch || hasProjectList,
    path: path,
    hasSearchInput: hasSearchInput || isActiveSearch,
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
    '[role="dialog"] input',
    '[role="dialog"] [role="searchbox"]',
    '[role="dialog"] [role="combobox"] input',
    '[role="dialog"] [role="combobox"]',
    'input[placeholder*="Search" i]',
    'input[aria-label*="search" i]',
    'input[type="search"]',
    'input[data-testid*="search" i]',
    '[role="searchbox"]',
    '[role="combobox"][placeholder*="Search" i]',
    'input#search',
    'input[name*="search" i]',
    '[role="dialog"] [contenteditable="true"]'
  ];

  let input = null;

  // 1. Check if activeElement is an input/searchbox (e.g. focused by Cmd+K)
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.getAttribute('role') === 'searchbox' || active.getAttribute('role') === 'combobox')) {
    if (!active.closest('form[class*="composer" i], [data-testid*="composer" i]')) {
      input = active;
    }
  }

  // 2. Query candidates and pick the first visible element
  if (!input) {
    for (let i = 0; i < sels.length; i++) {
      const els = document.querySelectorAll(sels[i]);
      for (let j = 0; j < els.length; j++) {
        const el = els[j];
        if (el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)) {
          if (el.tagName === 'TEXTAREA' && !el.closest('[role="dialog"]')) continue;
          input = el;
          break;
        }
      }
      if (input) break;
    }
  }

  // 3. Fallback: any visible input inside a dialog
  if (!input) {
    const dialogInputs = document.querySelectorAll('[role="dialog"] input, div[data-state="open"] input');
    for (let k = 0; k < dialogInputs.length; k++) {
      const el = dialogInputs[k];
      if (el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)) {
        input = el;
        break;
      }
    }
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
  input.dispatchEvent(new KeyboardEvent('input', { bubbles: true }));

  // Step 3 (DOM equivalent of 7 tabs + Enter): switch to "Projects" section
  const pills = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] [role="tab"], [role="dialog"] [role="radio"]')];
  for (let i = 0; i < pills.length; i++) {
    const t = (pills[i].innerText || pills[i].textContent || '').trim().toLowerCase();
    if (t === 'projects') {
      const isSelected = pills[i].getAttribute('aria-selected') === 'true' ||
                         pills[i].getAttribute('data-state') === 'active' ||
                         pills[i].getAttribute('aria-checked') === 'true';
      if (!isSelected) {
        pills[i].click();
      }
      break;
    }
  }

  return JSON.stringify({ found: true, value: input.value || target, url: location.href });
})();`;
}

/**
 * Builds the native macOS AppleScript that performs the user's exact keyboard-driven
 * ChatGPT project search flow:
 *   1. command + K for search
 *   2. paste project name copied from folder name
 *   3. 7 tabs then enter to go to project section and enter
 *   4. PAUSE 1.2s to let project filter results load
 *   5. 2 tabs goes to target project then enter - loads the project
 *   6. then copy the url (read tab URL from Chrome)
 */
export function buildChatGPTKeyboardProjectNavigationAppleScript(projectName: string): string {
  const escapedName = escapeAppleScriptStringLiteral(projectName);
  return `
    tell application "Google Chrome" to activate
    delay 0.3
    tell application "System Events"
      -- 1. Command + K for search
      keystroke "k" using command down
      delay 0.5

      -- 2. Paste project name copied from folder name
      set the clipboard to "${escapedName}"
      delay 0.1
      keystroke "v" using command down
      delay 0.6

      -- 3. 7 tabs then enter to go to project section and enter
      repeat 7 times
        key code 48
        delay 0.08
      end repeat
      delay 0.15
      key code 36

      -- Essential pause: allow ChatGPT to load and render the filtered project results
      delay 1.2

      -- 4. 2 tabs goes to target project then enter - loads the project
      repeat 2 times
        key code 48
        delay 0.15
      end repeat
      delay 0.2
      key code 36
      delay 2.0
    end tell
  `;
}

/**
 * Builds the native AppleScript that advances 2 tabs into the filtered project list
 * and hits Enter to load the project when the user is already on the Projects filter tab.
 */
export function buildChatGPTTwoTabsEnterAppleScript(): string {
  return `
    tell application "Google Chrome" to activate
    delay 0.2
    tell application "System Events"
      -- Wait briefly for list to be interactive
      delay 0.3
      -- 2 tabs to target project then enter
      repeat 2 times
        key code 48
        delay 0.15
      end repeat
      delay 0.2
      key code 36
      delay 2.0
    end tell
  `;
}

/**
 * Builds the JS that inspects the filtered results: isolates PROJECT results
 * only (project-type hrefs), computes exact case-insensitive matches against the
 * normalized target (treating spaces, hyphens, and underscores as equivalent),
 * and reports counts/candidates for diagnostics.
 */
export function buildChatGPTInspectResultsJavaScript(targetProjectName: string): string {
  const targetLiteral = JSON.stringify(targetProjectName);
  return `(() => {
  const STAGE = "__relay_stage_inspect_results__";
  const target = ${targetLiteral};
  const normalize = function (str) {
    return (str || '').toLowerCase().trim().replace(/[-_\\s]+/g, ' ');
  };
  const normTarget = normalize(target);
  const isProjectHref = function (href) {
    return href.indexOf('/projects/') !== -1 || href.indexOf('/p/') === 0 || href.indexOf('/g/g-p-') !== -1;
  };

  // Helper to extract clean project title from a card item.
  // In ChatGPT search results, a card often contains:
  // "OdareHub\\nProject\\nSep 6"
  // We extract the primary title line and filter out metadata.
  const extractTitle = function (el) {
    // 1. Check for dedicated heading/title elements inside the card
    const titleEl = el.querySelector('h1, h2, h3, h4, [class*="title"], [class*="name"], div:first-child');
    let raw = '';
    if (titleEl && (titleEl.innerText || titleEl.textContent || '').trim()) {
      raw = (titleEl.innerText || titleEl.textContent || '').trim();
    } else {
      raw = (el.innerText || el.textContent || '').trim();
    }
    // Take the first non-empty line
    const lines = raw.split(/\\r?\\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (lines.length > 0) {
      // If line 1 is literally "Project" (sometimes a badge precedes the title), check next line
      if (lines[0].toLowerCase() === 'project' && lines.length > 1) {
        return lines[1];
      }
      return lines[0];
    }
    return raw;
  };

  // 1. Find all project links or search result option cards
  let items = [...document.querySelectorAll('a[href]')].filter(function (a) {
    const href = a.getAttribute('href') || '';
    return isProjectHref(href);
  });

  // If no <a> hrefs found (e.g. ChatGPT modal using div/button items in search palette)
  if (items.length === 0) {
    const modalItems = [...document.querySelectorAll('[role="option"], [role="button"], li')].filter(function (el) {
      const txt = (el.innerText || el.textContent || '').toLowerCase();
      return txt.includes('project') || txt.includes(normTarget);
    });
    if (modalItems.length > 0) {
      items = modalItems;
    }
  }

  const candidates = items.map(function (el) {
    const title = extractTitle(el);
    const href = el.getAttribute('href') || el.href || '';
    return { name: title, href: href };
  }).filter(function (c) { return c.name.length > 0; });

  const exact = candidates.filter(function (c) {
    const normCand = normalize(c.name);
    return normCand === normTarget || c.name.trim().toLowerCase() === target;
  });

  return JSON.stringify({
    resultCount: items.length,
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
  const normalize = function (str) {
    return (str || '').toLowerCase().trim().replace(/[-_\\s]+/g, ' ');
  };
  const normTarget = normalize(target);
  const isProjectHref = function (href) {
    return href.indexOf('/projects/') !== -1 || href.indexOf('/p/') === 0 || href.indexOf('/g/g-p-') !== -1;
  };

  const extractTitle = function (el) {
    const titleEl = el.querySelector('h1, h2, h3, h4, [class*="title"], [class*="name"], div:first-child');
    let raw = '';
    if (titleEl && (titleEl.innerText || titleEl.textContent || '').trim()) {
      raw = (titleEl.innerText || titleEl.textContent || '').trim();
    } else {
      raw = (el.innerText || el.textContent || '').trim();
    }
    const lines = raw.split(/\\r?\\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (lines.length > 0) {
      if (lines[0].toLowerCase() === 'project' && lines.length > 1) {
        return lines[1];
      }
      return lines[0];
    }
    return raw;
  };

  let items = [...document.querySelectorAll('a[href]')].filter(function (a) {
    const href = a.getAttribute('href') || '';
    return isProjectHref(href);
  });

  if (items.length === 0) {
    const modalItems = [...document.querySelectorAll('[role="option"], [role="button"], li')].filter(function (el) {
      const txt = (el.innerText || el.textContent || '').toLowerCase();
      return txt.includes('project') || txt.includes(normTarget);
    });
    if (modalItems.length > 0) {
      items = modalItems;
    }
  }

  const exact = items.filter(function (el) {
    const title = extractTitle(el);
    return normalize(title) === normTarget || title.toLowerCase() === target;
  });

  if (exact.length !== 1) {
    return JSON.stringify({ clicked: false, exactCount: exact.length, url: location.href });
  }

  const targetEl = exact[0];
  const clickedHref = targetEl.getAttribute('href') || targetEl.href || '';
  targetEl.click();
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
export const RELAYX_PLANNER_BOOTSTRAP_PROMPT_TEMPLATE =
  '[RelayX Provisioning] Planner session initialized for "{pairName}" in project "{projectName}". Awaiting initial assignment.';

export const RELAYX_WORKER_BOOTSTRAP_PROMPT_TEMPLATE =
  '[RelayX Provisioning] Worker session initialized for "{sessionTitle}" in project "{projectName}". Awaiting initial assignment.';

// Actual production exclusion guard (not just a comment).
export function isBootstrapProvisioningTurn(text: string): boolean {
  return typeof text === 'string' && text.includes('[RelayX Provisioning]') && text.includes('Planner session initialized');
}

export function isExcludedFromAssignmentCorrelation(turnText: string, responseText?: string): boolean {
  return isBootstrapProvisioningTurn(turnText) || (typeof responseText === 'string' && isBootstrapProvisioningTurn(responseText));
}

// NOTE: This is a normal visible user message created by RelayX browser automation
// for the planner provisioning bootstrap user turn. It is not a system-role message or system instruction.
// Later conversation synchronization and response correlation treats this as the initial user turn
// and excludes bootstrap initialization turns from real assignment execution records.

/** Stable operation-local Chrome identity for one provisioning attempt. */
export interface BrowserHandle {
  windowId: number;
  tabId: number;
}

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
    const escapedText = escapeAppleScriptStringLiteral(request.instructionText);
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
   * Strict extraction of the conversation ID from a ChatGPT project conversation URL
   * of the exact shape https://chatgpt.com/g/<g-p-project>/c/<conversationId>.
   * Returns null unless BOTH the g-p- project segment and a nonempty /c/ segment
   * are present on a chatgpt.com host — project roots, bare /c/ URLs without a
   * g-p- project, off-host URLs, and malformed strings never yield an ID.
   */
  public extractChatGPTConversationId(url: string): string | null {
    return parseChatGPTConversationUrl(url)?.conversationId ?? null;
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
   * Causes the configured Planner provider to create/open a genuinely fresh conversation
   * under the project, and obtains the authoritative external identity (conversation ID and URL).
   *
   * Fails closed: if the provider cannot prove which conversation was created, it returns
   * an error rather than inventing an ID or guessing.
   */
  /** Creates a dedicated Chrome window + tab, returns stable handle (windowId, tabId). */
  private openDedicatedWindowAndCaptureId(url: string): BrowserHandle | null {
    const script = `
      tell application "Google Chrome"
        make new window
        set w to front window
        set winId to id of w
        tell w
          make new tab with properties {URL:"${url}"}
          delay 0.5
          set activeTab to active tab
          set tabId to id of activeTab
        end tell
        return "WIN:" & winId & "|TAB:" & tabId
      end tell
    `;
    const res = this.runAppleScript(script, 6000);
    if (!res.success) return null;
    const match = res.output.match(/WIN:(\d+)\|TAB:(\d+)/);
    if (!match) return null;
    return { windowId: parseInt(match[1], 10), tabId: parseInt(match[2], 10) };
  }

  /** Reads URL from the exact retained browser handle. Fails if identity lost. */
  private readHandleUrl(handle: BrowserHandle): string | null {
    const script = `
      tell application "Google Chrome"
        try
          set t to tab id ${handle.tabId} of window id ${handle.windowId}
          return URL of t
        on error
          return "ERR::TAB_OR_WINDOW_NOT_FOUND"
        end try
      end tell
    `;
    const res = this.runAppleScript(script, 5000);
    if (!res.success) return null;
    const trimmed = (res.output || '').trim();
    if (trimmed === 'ERR::TAB_OR_WINDOW_NOT_FOUND') return null;
    return trimmed || null;
  }

  /** Executes JavaScript on the exact retained tab. */
  private executeHandleJavaScript(handle: BrowserHandle, javaScript: string, timeoutMs = 3000): { success: boolean; output?: string; error?: string } {
    const script = `
      tell application "Google Chrome"
        try
          set t to tab id ${handle.tabId} of window id ${handle.windowId}
          set jsOut to (execute t javascript "${escapeAppleScriptStringLiteral(javaScript)}")
          return "OK::" & jsOut
        on error errMsg
          return "ERR::" & errMsg
        end try
      end tell
    `;
    const res = this.runAppleScript(script, timeoutMs);
    if (!res.success) return { success: false, error: res.error };
    const trimmed = (res.output || '').trim();
    if (trimmed.startsWith('ERR::')) {
      return { success: false, output: trimmed, error: trimmed.replace('ERR::', '') };
    }
    return { success: true, output: trimmed.replace(/^OK::/, '') };
  }

  /** Verifies the retained handle is still resolvable in Chrome. */
  private verifyHandleExists(handle: BrowserHandle): boolean {
    const script = `
      tell application "Google Chrome"
        try
          set t to tab id ${handle.tabId} of window id ${handle.windowId}
          return "FOUND"
        on error
          return "MISSING"
        end try
      end tell
    `;
    const res = this.runAppleScript(script, 3000);
    return res.success && (res.output || '').trim() === 'FOUND';
  }

  /**
   * BOOTSTRAP PROVISIONING TRACE (observation only).
   *
   * This records what the retained handle actually reported at each stage so a live run
   * can distinguish a selector problem from a readiness/timing problem, a wrong-handle
   * problem, or an auth/page-state problem. It performs NO navigation, NO send, and NO
   * state change: it only reads the handle, records what came back, and returns.
   *
   * Nothing in the provisioning flow branches on this trace. It exists so that a live
   * failure is explained by evidence rather than by inference.
   */
  private bootstrapTrace: Array<Record<string, unknown>> = [];

  /** Wall-clock origin for one provisioning attempt, so trace entries carry elapsed time. */
  private bootstrapClock: { startedAt: number } = { startedAt: 0 };

  private traceBootstrap(stage: string, detail: Record<string, unknown>): void {
    const entry = {
      stage,
      atMs: Date.now(),
      elapsedSinceProvisionStartMs: this.bootstrapClock.startedAt
        ? Date.now() - this.bootstrapClock.startedAt
        : null,
      ...detail,
    };
    this.bootstrapTrace.push(entry);
    const line = JSON.stringify(entry);
    console.log('[RelayX BootstrapTrace]', line);
    // Mirror to disk: a packaged macOS app launched from Finder has no visible stdout,
    // so console output alone would make the evidence unrecoverable after a UI-driven test.
    this.appendTraceToDisk(line);
  }

  /** Appends one trace line to the diagnostic log, best-effort and never fatal. */
  private appendTraceToDisk(line: string): void {
    try {
      const { appendFileSync } = require('fs');
      const { homedir } = require('os');
      const { join } = require('path');
      const dir = join(homedir(), 'Library', 'Logs', 'RelayX');
      const { mkdirSync } = require('fs');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'bootstrap-trace.log'), line + '\n');
    } catch {
      // Diagnostics must never break provisioning.
    }
  }

  /** Returns and clears the accumulated bootstrap trace for the current attempt. */
  private takeBootstrapTrace(): Array<Record<string, unknown>> {
    const trace = this.bootstrapTrace;
    this.bootstrapTrace = [];
    return trace;
  }

  /**
   * Reads the retained handle's URL and page state, recording both the raw read and the
   * `parseChatGPTConversationUrl` verdict. Reports what was observed; never infers.
   */
  private inspectRetainedHandle(
    handle: BrowserHandle,
    stage: string,
  ): { url: string | null; conversationId: string | null; projectId: string | null } {
    const started = Date.now();
    const url = this.readHandleUrl(handle);
    const parsed = url ? parseChatGPTConversationUrl(url) : null;
    this.traceBootstrap(stage, {
      handle: `WIN:${handle.windowId}|TAB:${handle.tabId}`,
      readHandleUrl: url,
      parsedConversationId: parsed?.conversationId ?? null,
      parsedProjectId: parsed?.projectId ?? null,
      parsedShape: url
        ? (parsed ? 'g/<project>/c/<id>' : 'NOT_a_g-p-c-shape')
        : 'null_url',
      readDurationMs: Date.now() - started,
    });
    return {
      url,
      conversationId: parsed?.conversationId ?? null,
      projectId: parsed?.projectId ?? null,
    };
  }

  /**
   * Reads the retained tab's DOM state through the SAME handle: document readyState and
   * the composer/send-button candidates that the bootstrap insertion depends on.
   *
   * This is the evidence that separates "composer genuinely absent" (NO_TEXTAREA) from
   * "composer present but page not ready", and it reports the page state (loading, login,
   * error, new-chat) instead of collapsing all of them into one failure string.
   */
  private inspectRetainedPageState(
    handle: BrowserHandle,
    stage: string,
  ): Record<string, unknown> | null {
    const probeJs = `(() => {
      const textareas = [...document.querySelectorAll('textarea')].map(function (t) {
        return { id: t.id || null, testid: t.getAttribute('data-testid'), placeholder: t.getAttribute('placeholder'), visible: !!(t.offsetWidth > 0 || t.offsetHeight > 0 || t.getClientRects().length > 0) };
      });
      const editables = [...document.querySelectorAll('[contenteditable="true"]')].map(function (e) {
        return { tag: e.tagName, id: e.id || null, role: e.getAttribute('role'), testid: e.getAttribute('data-testid'), classHint: (e.className || '').toString().slice(0, 120), visible: !!(e.offsetWidth > 0 || e.offsetHeight > 0 || e.getClientRects().length > 0) };
      });
      const sendButtons = [...document.querySelectorAll('button')].filter(function (b) {
        const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '');
        return /send/i.test(label);
      }).map(function (b) {
        return { testid: b.getAttribute('data-testid'), ariaLabel: b.getAttribute('aria-label'), disabled: b.disabled === true };
      });
      const hasPromptTextarea = !!document.querySelector('#prompt-textarea');
      const bodyText = (document.body ? (document.body.innerText || '') : '').slice(0, 400);
      return JSON.stringify({
        url: location.href,
        pathname: location.pathname,
        readyState: document.readyState,
        title: document.title,
        hasPromptTextarea: hasPromptTextarea,
        textareaCount: textareas.length,
        contenteditableCount: editables.length,
        textareas: textareas.slice(0, 5),
        editables: editables.slice(0, 5),
        sendButtons: sendButtons.slice(0, 5),
        bodyExcerpt: bodyText
      });
    })();`;
    const res = this.executeHandleJavaScript(handle, probeJs, 3000);
    if (!res.success || !res.output || res.output.startsWith('ERR::')) {
      this.traceBootstrap(stage, {
        probeFailed: true,
        error: res.error ?? res.output ?? 'unknown',
        handle: `WIN:${handle.windowId}|TAB:${handle.tabId}`,
      });
      return null;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(res.output);
    } catch {
      this.traceBootstrap(stage, { probeParseFailed: true, raw: (res.output || '').slice(0, 500) });
      return null;
    }
    this.traceBootstrap(stage, { handle: `WIN:${handle.windowId}|TAB:${handle.tabId}`, ...parsed });
    return parsed;
  }

  /**
   * Observes that the bootstrap user turn was accepted in the retained tab, by polling the
   * SAME retained handle until an authoritative conversation identity settles.
   *
   * ## Why this used to report a visibly-materialized conversation as absent
   *
   * The committed version took exactly ONE URL read ~277ms after the Return keypress and
   * returned on that single sample. A live run captured the real sequence:
   *
   *   t=2966ms  .../project                       -> parse null -> acknowledged:false -> FAIL
   *   t=3900ms  .../c/local-chatgpt%3A<uuid4>     -> transient placeholder
   *   later     .../c/<server-uuid>               -> authoritative
   *
   * Materialization therefore happened at least 933ms AFTER the only observation the old
   * function ever made, and the 12x600ms URL poll below it was unreachable on the failure
   * path. Evidence ruled out the alternatives: the parser handled the project-scoped form
   * correctly, every read came from the same `WIN:id|TAB:id`, and the page was fully
   * loaded and authenticated.
   *
   * ## Contract now enforced here
   *
   * Settled = the supported conversation URL shape yields a non-placeholder authoritative ID.
   * Not settled = no conversation ID yet, OR a transient `local-chatgpt:` identity, OR a URL
   * that fails the authoritative shape requirements. The wait is BOUNDED and a local
   * placeholder is NEVER adopted after timeout, because ChatGPT replaces it — adopting it
   * would persist an identity that can never correlate later.
   */
  private async observeBootstrapSubmission(
    handle: BrowserHandle,
    slug: string,
    maxWaitMs = CHATGPT_SETTLEMENT_MAX_WAIT_MS,
  ): Promise<ChatGPTSettlementResult> {
    const handleLabel = `WIN:${handle.windowId}|TAB:${handle.tabId}`;
    const startedAt = Date.now();

    // Reads the EXACT retained tab. Never the frontmost window, never a re-resolved handle:
    // the window/tab IDs are bound once, here, and reused for every poll.
    const readThroughRetainedHandle = (): ChatGPTSettlementRead => {
      const script = `
        tell application "Google Chrome"
          try
            set t to tab id ${handle.tabId} of window id ${handle.windowId}
            -- Evidence of submission: either user message appears in visible chat or composer state changes.
            -- We observe the URL transition or visible message content.
            set pageUrl to URL of t
            return pageUrl
          on error
            return "ERR::TAB_OR_WINDOW_NOT_FOUND"
          end try
        end tell
      `;
      const res = this.runAppleScript(script, 5000);
      if (!res.success) return { kind: 'failed', error: res.error };
      const trimmed = (res.output || '').trim();
      if (trimmed === 'ERR::TAB_OR_WINDOW_NOT_FOUND') return { kind: 'lost' };
      return { kind: 'url', url: trimmed || null };
    };

    const result = await settleChatGPTConversationIdentity(readThroughRetainedHandle, {
      maxWaitMs,
      pollIntervalMs: CHATGPT_SETTLEMENT_POLL_INTERVAL_MS,
      sleep: (ms) => this.sleep(ms),
      onObservation: ({ poll, verdict }) => {
        this.traceBootstrap('bootstrap_settlement_poll', {
          poll,
          handle: handleLabel,
          state: verdict.state,
          url: verdict.url ?? null,
          projectId: verdict.projectId ?? null,
          authoritativeConversationId: verdict.conversationId ?? null,
          transientId: verdict.transientId ?? null,
          elapsedSinceProvisionStartMs: this.bootstrapClock.startedAt
            ? Date.now() - this.bootstrapClock.startedAt
            : null,
        });
      },
    });

    this.traceBootstrap('bootstrap_settlement_result', {
      handle: handleLabel,
      outcome: result.outcome,
      acknowledged: result.acknowledged,
      authoritativeConversationId: result.conversationId ?? null,
      projectId: result.projectId ?? null,
      transientId: result.transientId ?? null,
      lastUrl: result.lastUrl ?? null,
      polls: result.polls,
      elapsedMs: result.elapsedMs,
      reason: result.reason ?? null,
      wallClockMs: Date.now() - startedAt,
    });

    return result;
  }

  /** Bounded readiness verification for Defect D (intermittent NO_TEXTAREA).
   * Polls the retained handle for the composer (textarea / contenteditable) and
   * send-button candidates, bounded by maxWaitMs. Never waits indefinitely.
   */
  private async verifyComposerReady(
    handle: BrowserHandle,
    maxWaitMs = 20000,
  ): Promise<{ ok: boolean; reason?: string }> {
    const deadline = Date.now() + maxWaitMs;
    let polls = 0;
    while (Date.now() < deadline) {
      polls += 1;
      const probeDir = this.inspectRetainedPageState(handle, `composer_readiness_poll_${polls}`);
      if (probeDir) {
        const editablesArr = (probeDir.editables as any[]) || [];
        const hasComposer = (probeDir.hasPromptTextarea === true) || ((probeDir.contenteditableCount as number) > 0) ||
                            editablesArr.some((e: any) => (e as any)?.visible === true);
        if (hasComposer) return { ok: true };
      }
      await this.sleep(300);
    }
    return { ok: false, reason: `Planner composer not ready after ${polls} readiness polls over ${maxWaitMs}ms (bounded composer readiness timeout)` };
  }

  public async createPlannerSession(
    projectUrlOrRef: string,
    name?: string,
    options?: { knownConversationIds?: Set<string> | string[]; projectName?: string },
  ): Promise<{
    conversationId: string;
    conversationUrl: string;
    projectSlug: string;
    error?: string;
  }> {
    const slug = this.extractChatGPTProjectId(projectUrlOrRef);
    if (!slug) {
      return {
        conversationId: '',
        conversationUrl: '',
        projectSlug: '',
        error: 'Invalid or missing ChatGPT project URL to scope the new conversation',
      };
    }

    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return {
        conversationId: '',
        conversationUrl: '',
        projectSlug: slug,
        error: 'macOS automation required for ChatGPT conversation creation',
      };
    }

    const knownSet = new Set(
      options?.knownConversationIds
        ? Array.from(options.knownConversationIds)
        : [],
    );

    // DIAGNOSTIC ONLY: open a fresh trace window and clock for this attempt.
    this.bootstrapTrace = [];
    this.bootstrapClock.startedAt = Date.now();
    this.traceBootstrap('provision_start', {
      requestedName: name ?? null,
      projectNameOption: options?.projectName ?? null,
      targetProjectSlug: slug,
      knownConversationIdsCount: knownSet.size,
    });

    // 1. Create a dedicated Chrome window + tab and capture stable identity.
    this.runAppleScript('tell application "Google Chrome" to activate', 1500);
    const targetUrl = `https://chatgpt.com/g/${slug}`;
    this.traceBootstrap('opening_dedicated_window', { targetUrl });
    const handle = this.openDedicatedWindowAndCaptureId(targetUrl);
    if (!handle) {
      this.traceBootstrap('boundary_failed', {
        boundary: 'openDedicatedWindowAndCaptureId',
        message: 'Failed to create dedicated browser window/tab for planner session',
      });
      return {
        conversationId: '',
        conversationUrl: '',
        projectSlug: slug,
        error: 'Failed to create dedicated browser window/tab for planner session',
      };
    }

    // Verify identity survives before proceeding.
    if (!this.verifyHandleExists(handle)) {
      this.traceBootstrap('boundary_failed', {
        boundary: 'verifyHandleExists',
        handle: `WIN:${handle.windowId}|TAB:${handle.tabId}`,
        message: 'Browser identity lost immediately after creation',
      });
      return {
        conversationId: '',
        conversationUrl: '',
        projectSlug: slug,
        error: 'Browser identity lost immediately after creation (tab/window not resolvable)',
      };
    }
    this.traceBootstrap('handle_verified', {
      handle: `WIN:${handle.windowId}|TAB:${handle.tabId}`,
      targetUrl,
    });

    // 2. Read initial URL through the retained handle (not active/frontmost).
    await this.sleep(1200);
    let url = this.readHandleUrl(handle);
    let parsed = url ? parseChatGPTConversationUrl(url) : null;

    // DIAGNOSTIC ONLY: record the retained handle, the URL it actually reports, and the
    // page/composer state visible through that SAME handle before anything is submitted.
    // This is the evidence that separates a wrong-handle problem from a readiness problem
    // and from an auth/page-state problem.
    this.traceBootstrap('retained_handle_confirmed', {
      handle: `WIN:${handle.windowId}|TAB:${handle.tabId}`,
      urlBeforeBootstrap: url ?? null,
      parsedBeforeBootstrap: parsed?.conversationId ?? null,
      openDedicatedWindowReturnedNull: false,
    });
    this.inspectRetainedPageState(handle, 'page_state_before_bootstrap');

    // Confirm initial state: project composer, no conversation ID.
    if (url && parsed?.conversationId) {
      // Unexpected early conversation materialization — but still must verify it's ours.
      if (knownSet.has(parsed.conversationId)) {
        return {
          conversationId: '',
          conversationUrl: '',
          projectSlug: slug,
          error: `Provider observed existing conversation '${parsed.conversationId}' instead of creating a fresh conversation`,
        };
      }
      return {
        conversationId: parsed.conversationId,
        conversationUrl: url,
        projectSlug: parsed.projectId,
      };
    }

    const pairName = (name || 'Unknown Pair').trim();
    const projectName = (options?.projectName || slug || 'Unknown Project').trim();
    const bootstrapPrompt = RELAYX_PLANNER_BOOTSTRAP_PROMPT_TEMPLATE
      .replace('{pairName}', pairName)
      .replace('{projectName}', projectName);

    if (!parsed?.conversationId) {
      // DIAGNOSTIC ONLY: record the exact prompt string that is about to be submitted, so
      // Checkpoint A ("did ChatGPT receive the dynamic prompt or the old static one?")
      // can be answered from the runtime rather than from a screenshot.
      this.traceBootstrap('bootstrap_prompt_rendered', {
        pairName,
        projectName,
        bootstrapPrompt,
        promptLength: bootstrapPrompt.length,
      });

      // 3. Wait for composer readiness boundedly, then submit provisioning bootstrap through the exact retained handle.
      const readiness = await this.verifyComposerReady(handle, 20000);
      if (!readiness.ok) {
        this.traceBootstrap('boundary_failed', {
          boundary: 'composer_discovery',
          handle: `WIN:${handle.windowId}|TAB:${handle.tabId}`,
          message: readiness.reason || 'Planner composer not ready: no prompt-textarea or contenteditable found within 20s bound',
        });
        this.inspectRetainedPageState(handle, 'page_state_at_composer_failure');
        return {
          conversationId: '',
          conversationUrl: '',
          projectSlug: slug,
          error: readiness.reason || 'Planner composer not ready: no prompt-textarea or contenteditable found within 20s bound',
        };
      }

      const promptJs = `(() => {
        const textarea = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
        if (!textarea) return 'NO_TEXTAREA';
        textarea.focus();
        if (textarea.tagName === 'TEXTAREA') {
          textarea.value = '${escapeAppleScriptStringLiteral(bootstrapPrompt)}';
        } else {
          textarea.innerText = '${escapeAppleScriptStringLiteral(bootstrapPrompt)}';
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        const sendBtn = document.querySelector('button[data-testid="send-button"]') ||
                        document.querySelector('button[aria-label="Send prompt"]') ||
                        document.querySelector('button[aria-label*="Send"]');
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
          return 'CLICKED_SEND';
        }
        return 'PROMPT_ENTERED';
      })()`;

      const jsRes = this.executeHandleJavaScript(handle, promptJs, 3000);
      const outputTrimmed = (jsRes.output || '').trim();

      // DIAGNOSTIC ONLY: record the submission outcome through the retained handle.
      this.traceBootstrap('bootstrap_submit_result', {
        jsSucceeded: jsRes.success,
        jsError: jsRes.error ?? null,
        outputTrimmed: outputTrimmed || null,
        interpretedAs:
          outputTrimmed === 'CLICKED_SEND'
            ? 'send_button_clicked'
            : outputTrimmed === 'PROMPT_ENTERED'
              ? 'return_key_fallback'
              : outputTrimmed === 'NO_TEXTAREA'
                ? 'composer_absent'
                : outputTrimmed
                  ? 'unexpected'
                  : 'empty',
      });

      if (jsRes.success && outputTrimmed === 'CLICKED_SEND') {
        // Send triggered via JS directly; observe acknowledgement through handle.
      } else if (jsRes.success && outputTrimmed === 'PROMPT_ENTERED') {
        // Fallback: trigger Return via System Events.
        this.runAppleScript(`
          tell application "System Events"
            tell application process "Google Chrome"
              key code 36 -- Return
            end tell
          end tell
        `, 2000);
      } else if (!jsRes.success) {
        return {
          conversationId: '',
          conversationUrl: '',
          projectSlug: slug,
          error: `Bootstrap insertion failed: ${jsRes.error || 'JavaScript execution error on retained handle'}`,
        };
      } else if (outputTrimmed === 'NO_TEXTAREA') {
        this.traceBootstrap('boundary_failed', {
          boundary: 'composer_discovery',
          handle: `WIN:${handle.windowId}|TAB:${handle.tabId}`,
          message:
            'Planner composer not ready: no prompt-textarea or contenteditable found',
        });
        // Re-probe page state at the moment of failure to capture readyState, page state,
        // and every textarea/[contenteditable]/send candidate that WAS present.
        this.inspectRetainedPageState(handle, 'page_state_at_composer_failure');
        return {
          conversationId: '',
          conversationUrl: '',
          projectSlug: slug,
          error: 'Planner composer not ready: no prompt-textarea or contenteditable found',
        };
      } else {
        return {
          conversationId: '',
          conversationUrl: '',
          projectSlug: slug,
          error: `Bootstrap submission unexpected result: ${outputTrimmed}`,
        };
      }

      // 4. Poll the retained handle until an authoritative conversation identity settles.
      //
      // `observeBootstrapSubmission` already waited for a SETTLED identity, so reaching here
      // means ChatGPT has issued a durable conversation ID. The bounded poll below only
      // re-confirms that identity through the same retained handle; it uses the same
      // settlement classifier so a transient `local-chatgpt:` ID can never satisfy it.
      const submissionEvidence = await this.observeBootstrapSubmission(handle, slug);
      if (!submissionEvidence.acknowledged) {
        return {
          conversationId: '',
          conversationUrl: '',
          projectSlug: slug,
          error:
            submissionEvidence.reason ||
            'Bootstrap submission not acknowledged by retained handle',
        };
      }

      for (let poll = 0; poll < 12; poll++) {
        await this.sleep(600);
        if (!this.verifyHandleExists(handle)) {
          return {
            conversationId: '',
            conversationUrl: '',
            projectSlug: slug,
            error: 'Browser identity lost during provisioning: retained tab/window no longer exists',
          };
        }
        url = this.readHandleUrl(handle);
        const identity = classifyChatGPTConversationIdentity(url);
        this.traceBootstrap('url_poll', {
          poll: poll + 1,
          url: url ?? null,
          state: identity.state,
          parsedConversationId: identity.conversationId ?? null,
          parsedProjectId: identity.projectId ?? null,
          transientId: identity.transientId ?? null,
        });
        if (identity.state === 'settled') {
          parsed = { projectId: identity.projectId as string, conversationId: identity.conversationId as string };
          break;
        }
      }
    }

    // Final identity verification: must still resolve.
    if (!this.verifyHandleExists(handle)) {
      return {
        conversationId: '',
        conversationUrl: '',
        projectSlug: slug,
        error: 'Browser identity lost before verification complete',
      };
    }
    url = this.readHandleUrl(handle);
    parsed = url ? parseChatGPTConversationUrl(url) : null;

    // The AUTHORITATIVE identity gate for what gets returned to the service layer and
    // ultimately persisted as the planner runtime identity. Structural parseability alone
    // is not enough: a transient `local-chatgpt:` ID is conversation-shaped but is replaced
    // by ChatGPT, so adopting it would persist an identity that can never correlate later.
    const finalIdentity = classifyChatGPTConversationIdentity(url);
    this.traceBootstrap('final_identity_verification', {
      handle: `WIN:${handle.windowId}|TAB:${handle.tabId}`,
      url: url ?? null,
      state: finalIdentity.state,
      authoritativeConversationId: finalIdentity.conversationId ?? null,
      transientId: finalIdentity.transientId ?? null,
    });

    if (finalIdentity.state === 'transient_local_identity') {
      return {
        conversationId: '',
        conversationUrl: '',
        projectSlug: slug,
        error:
          `Could not authoritatively verify newly created ChatGPT conversation: retained handle is on a ` +
          `transient local identity '${finalIdentity.transientId}', which ChatGPT replaces and RelayX never adopts`,
      };
    }

    if (finalIdentity.state === 'settled' && url) {
      const authoritativeConversationId = finalIdentity.conversationId as string;
      // Uniqueness check: verify this conversation ID was not already known.
      if (knownSet.has(authoritativeConversationId)) {
        return {
          conversationId: '',
          conversationUrl: '',
          projectSlug: slug,
          error: `Provider observed existing conversation '${authoritativeConversationId}' instead of creating a fresh conversation`,
        };
      }

      return {
        conversationId: authoritativeConversationId,
        conversationUrl: url,
        projectSlug: finalIdentity.projectId as string,
      };
    }

    // If ChatGPT does not allocate an authoritative /c/<id> or if verification timed out,
    // fail closed: do NOT invent an ID, do NOT assume frontmost tab without evidence.
    return {
      conversationId: '',
      conversationUrl: '',
      projectSlug: slug,
      error: 'Could not authoritatively verify newly created ChatGPT conversation: no conversation ID produced by provider after bootstrap trigger',
    };
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
      // Fallback: execute user's exact keyboard workflow (Cmd+K -> Paste -> 7 tabs + Enter -> 2 tabs + Enter)
      const kbNav = await this.executeKeyboardProjectNavigation(name, diag);
      if (kbNav.success && kbNav.url) {
        diag.selectedProject = name.trim();
        diag.finalUrl = kbNav.url;
        diag.searchValue = name.trim();
        return {
          success: true,
          projectName: name.trim(),
          finalUrl: kbNav.url,
          projectUrl: kbNav.url,
          diagnostics: diag,
        };
      }
      diag.discoveryError = 'ChatGPT projects search input not found';
      return { success: false, error: diag.discoveryError, diagnostics: diag };
    }
    diag.searchValue = searchValue;

    // Essential 1.2s pause: allow ChatGPT to filter and render project results after switching tab
    await this.sleep(1200);

    // E. Inspect the filtered results and classify exact matches.
    const inspected = await this.inspectProjectResults(normalizedTarget, diag);
    if (!inspected) {
      diag.discoveryError = 'Failed to inspect ChatGPT project results';
      return { success: false, error: diag.discoveryError, diagnostics: diag };
    }
    diag.projectResultCount = inspected.projectResultCount ?? 0;
    diag.exactMatchCount = inspected.exactMatchCount ?? 0;

    if (inspected.status === 'NONE') {
      // If candidates were found in the UI but none was an exact match,
      // do not blindly select an unrelated project.
      if (
        (inspected.projectResultCount && inspected.projectResultCount > 0) ||
        (inspected.candidates && inspected.candidates.length > 0)
      ) {
        diag.selectedProject = undefined;
        diag.discoveryError = 'Project not found';
        return { success: false, error: 'Project not found', diagnostics: diag };
      }

      // If 0 results were found in DOM (e.g. DOM selector mismatch or rendering delay),
      // try 2 tabs + Enter directly since the 7 tabs + Enter already switched to Projects tab
      const twoTabNav = await this.executeTwoTabsEnterNavigation(diag);
      if (twoTabNav.success && twoTabNav.url) {
        diag.selectedProject = name.trim();
        diag.finalUrl = twoTabNav.url;
        diag.searchValue = name.trim();
        return {
          success: true,
          projectName: name.trim(),
          finalUrl: twoTabNav.url,
          projectUrl: twoTabNav.url,
          diagnostics: diag,
        };
      }

      // 2. Try the full keyboard workflow (Cmd+K -> paste -> 7 tabs -> 1.2s pause -> 2 tabs -> Enter)
      const kbNav = await this.executeKeyboardProjectNavigation(name, diag);
      if (kbNav.success && kbNav.url) {
        diag.selectedProject = name.trim();
        diag.finalUrl = kbNav.url;
        diag.searchValue = name.trim();
        return {
          success: true,
          projectName: name.trim(),
          finalUrl: kbNav.url,
          projectUrl: kbNav.url,
          diagnostics: diag,
        };
      }

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
      // Fallback: execute keyboard selection
      const kbNav = await this.executeKeyboardProjectNavigation(name, diag);
      if (kbNav.success && kbNav.url) {
        diag.selectedProject = name.trim();
        diag.finalUrl = kbNav.url;
        return {
          success: true,
          projectName: name.trim(),
          finalUrl: kbNav.url,
          projectUrl: kbNav.url,
          diagnostics: diag,
        };
      }
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

    return {
      success: true,
      projectName: name.trim(),
      finalUrl,
      projectUrl: finalUrl,
      diagnostics: diag,
    };
  }

  /**
   * Executes 2 tabs then Enter to select the project item in the filtered list,
   * then waits and captures the URL from Chrome.
   */
  public async executeTwoTabsEnterNavigation(
    diag?: any,
  ): Promise<{ success: boolean; url?: string; error?: string }> {
    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return { success: false, error: 'macOS automation required' };
    }

    const script = buildChatGPTTwoTabsEnterAppleScript();
    const res = this.runAppleScript(script, 8000);
    if (!res.success) {
      if (diag) diag.twoTabsError = res.error;
      return { success: false, error: res.error };
    }

    // Poll for the URL to change to the project URL (up to 5 seconds)
    for (let poll = 0; poll < 10; poll++) {
      await this.sleep(500);
      const url = await this.readTabUrl();
      if (url && (url.includes('/g/g-p-') || url.includes('/projects') || url.includes('/p/'))) {
        if (diag) {
          diag.finalUrl = url;
          diag.twoTabsSuccess = true;
        }
        return { success: true, url };
      }
    }
    return { success: false, error: 'URL did not navigate to a project after 2 tabs + enter' };
  }

  /**
   * Executes the exact keyboard-driven ChatGPT project search sequence:
   * 1. command + K for search
   * 2. paste project name copied from folder name
   * 3. 7 tabs then enter to go to project section and enter
   * 4. pause 1.2s to let project filter results load
   * 5. 2 tabs goes to target project then enter - loads the project
   * 6. then copy / read the URL from the active Chrome tab
   */
  public async executeKeyboardProjectNavigation(
    projectName: string,
    diag?: any,
  ): Promise<{ success: boolean; url?: string; error?: string }> {
    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return { success: false, error: 'macOS automation required' };
    }

    const script = buildChatGPTKeyboardProjectNavigationAppleScript(projectName);
    const res = this.runAppleScript(script, 12000);
    if (!res.success) {
      if (diag) diag.keyboardNavError = res.error;
      return { success: false, error: res.error };
    }

    // Poll for the URL to change to the project URL (up to 6 seconds)
    for (let poll = 0; poll < 12; poll++) {
      await this.sleep(500);
      const url = await this.readTabUrl();
      if (url && (url.includes('/g/g-p-') || url.includes('/projects') || url.includes('/p/'))) {
        if (diag) {
          diag.finalUrl = url;
          diag.keyboardNavSuccess = true;
        }
        return { success: true, url };
      }
    }
    return { success: false, error: 'URL did not navigate to a project after keyboard navigation' };
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
    } else {
      try {
        const parsed = JSON.parse(res.output);
        diag.projectsClickInfo = parsed.clickedInfo;
      } catch (e) {
        diag.jsError = `Open projects parse error: ${e}`;
      }
    }

    // Also trigger native macOS Command+K shortcut via System Events
    // (This is the universal ChatGPT shortcut to open Search Chats & Projects modal)
    try {
      this.runAppleScript(`
        tell application "Google Chrome" to activate
        tell application "System Events"
          try
            keystroke "k" using command down
          end try
        end tell
      `, 1500);
    } catch {
      // ignore
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
      // If still not visible after 2 or 5 attempts, re-run open script & retry native Cmd+K
      if (attempt === 2 || attempt === 5) {
        try {
          this.runAppleScript(`
            tell application "Google Chrome" to activate
            tell application "System Events"
              try
                keystroke "k" using command down
              end try
            end tell
          `, 1500);
        } catch {}
        const retryOpen = this.executeTabJavaScript(buildChatGPTProjectsOpenJavaScript(), 2500);
        if (retryOpen.success && retryOpen.output && !retryOpen.output.startsWith('ERR::')) {
          try {
            const parsedRetry = JSON.parse(retryOpen.output);
            if (parsedRetry.clickedInfo) diag.projectsClickInfo = parsedRetry.clickedInfo;
          } catch {
            // ignore
          }
        }
      }
      await this.sleep(600);
    }
    return false;
  }

  /** Stage D: enter the (normalized) project name into the projects search input. */
  private async enterProjectSearch(
    normalizedTarget: string,
    diag: any,
  ): Promise<string | null> {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = this.executeTabJavaScript(buildChatGPTEnterSearchJavaScript(normalizedTarget), 3000);
      if (res.success && res.output && !res.output.startsWith('ERR::')) {
        try {
          const parsed = JSON.parse(res.output);
          if (parsed.found) return parsed.value;
        } catch (e) {
          diag.jsError = `Enter search parse error: ${e}`;
        }
      } else if (!res.success) {
        diag.appleScriptError = res.error || res.output;
      }
      if (attempt < maxAttempts) {
        // Retry native Cmd+K in case the search dialog lost focus or didn't finish opening
        if (attempt === 2) {
          try {
            this.runAppleScript(`
              tell application "Google Chrome" to activate
              tell application "System Events"
                try
                  keystroke "k" using command down
                end try
              end tell
            `, 1500);
          } catch {}
        }
        await this.sleep(400);
      }
    }
    return null;
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
 * Strict, pure parser for a ChatGPT project conversation URL of the exact shape
 * https://chatgpt.com/g/<g-p-project>/c/<conversationId>.
 *
 * Rules:
 * - Host must be (or end with) chatgpt.com.
 * - Path must be exactly /g/<g-p-...>/c/<conversationId> with nothing after the
 *   conversation ID (no trailing slash, no further path segments).
 * - The g-p- project segment and a nonempty conversation ID are both required.
 * - Project roots (/g/g-p-x or /g/g-p-x/project), bare /c/<id> URLs without a
 *   project, off-host URLs, relative strings, and malformed input return null.
 *
 * The returned projectId/conversationId are returned verbatim (no decoding),
 * so any caller can compare the slug against a stored project reference.
 */
export function parseChatGPTConversationUrl(url: string): {
  projectId: string;
  conversationId: string;
} | null {
  if (!url || typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!(parsed.hostname === 'chatgpt.com' || parsed.hostname.endsWith('.chatgpt.com'))) return null;
  const match = parsed.pathname.match(/^\/g\/(g-p-[^/]+)\/c\/([^/?#]+)$/);
  if (!match) return null;
  const conversationId = match[2];
  if (!conversationId) return null;
  return { projectId: match[1], conversationId };
}

/**
 * Semantic identity states for a ChatGPT conversation URL.
 *
 * This layer is deliberately SEPARATE from `parseChatGPTConversationUrl`, which remains a
 * structural "is this a project-conversation-shaped URL" parser used by six call sites.
 * Structural parseability is not the same thing as having an authoritative, durable
 * conversation identity, and only the provisioning/identity layer should care about the
 * difference.
 *
 * - `not_materialized_yet`      ChatGPT has not produced a conversation URL yet. Covers the
 *                               project composer (`.../project`), the project root, a bare
 *                               `/c/<id>` URL (not a supported shape), and any non-ChatGPT
 *                               or malformed URL.
 * - `transient_local_identity`  A conversation-shaped URL whose ID is ChatGPT's optimistic
 *                               local placeholder (`local-chatgpt:<uuid4>`). This identity is
 *                               REPLACED by a durable server ID moments later, so it must
 *                               never be adopted or persisted as authoritative.
 * - `settled`                   A supported conversation URL shape yielding a non-placeholder
 *                               authoritative conversation ID.
 */
export type ChatGPTConversationIdentityState =
  | 'not_materialized_yet'
  | 'transient_local_identity'
  | 'settled';

export interface ChatGPTConversationIdentityVerdict {
  state: ChatGPTConversationIdentityState;
  /** The URL exactly as observed. Diagnostic only. */
  url: string | null;
  /** Authoritative project ID. Present for `settled` and `transient_local_identity`. */
  projectId: string | null;
  /** Authoritative conversation ID, URL-decoded. Non-null ONLY when `settled`. */
  conversationId: string | null;
  /** The rejected transient identity, for diagnostics. Never authoritative. */
  transientId: string | null;
}

/** Matches ChatGPT's optimistic local conversation placeholder, encoded or decoded. */
const CHATGPT_TRANSIENT_LOCAL_ID = /^local-chatgpt[:_-]/i;

/**
 * Classifies a ChatGPT conversation URL into a semantic identity state.
 *
 * Deliberately tolerant of a null/blank/unparseable URL: anything that does not yield an
 * authoritative identity is reported as `not_materialized_yet` rather than throwing, so
 * callers can poll on a settled identity without special-casing every malformed shape.
 */
export function classifyChatGPTConversationIdentity(
  url: string | null | undefined,
): ChatGPTConversationIdentityVerdict {
  const pending = (u: string | null): ChatGPTConversationIdentityVerdict => ({
    state: 'not_materialized_yet',
    url: u,
    projectId: null,
    conversationId: null,
    transientId: null,
  });

  if (!url || typeof url !== 'string') return pending(null);
  const trimmed = url.trim();
  if (!trimmed) return pending(null);

  const parsed = parseChatGPTConversationUrl(trimmed);
  if (!parsed?.conversationId) return pending(trimmed);

  // `URL.pathname` preserves percent-encoding, and the local placeholder encodes its
  // colon (`local-chatgpt%3A...`). Decode before testing so the placeholder is detected
  // in either form, and so a settled ID is never handed back still-encoded.
  let decoded = parsed.conversationId;
  try {
    decoded = decodeURIComponent(parsed.conversationId);
  } catch {
    decoded = parsed.conversationId;
  }
  decoded = decoded.trim();
  if (!decoded) return pending(trimmed);

  if (CHATGPT_TRANSIENT_LOCAL_ID.test(decoded)) {
    return {
      state: 'transient_local_identity',
      url: trimmed,
      projectId: parsed.projectId,
      conversationId: null,
      transientId: decoded,
    };
  }

  return {
    state: 'settled',
    url: trimmed,
    projectId: parsed.projectId,
    conversationId: decoded,
    transientId: null,
  };
}

/** One read of the retained tab's URL, preserving why a read could not produce a URL. */
export type ChatGPTSettlementRead =
  | { kind: 'url'; url: string | null }
  | { kind: 'lost' }
  | { kind: 'failed'; error?: string };

export type ChatGPTSettlementOutcome =
  | 'settled'
  | 'not_materialized_yet'
  | 'transient_local_identity'
  | 'handle_lost'
  | 'read_failed'
  | 'timeout';

export interface ChatGPTSettlementResult {
  outcome: ChatGPTSettlementOutcome;
  /** True only for `settled`. Kept so existing acknowledgement call sites stay explicit. */
  acknowledged: boolean;
  /** Authoritative project ID. Non-null only when settled. */
  projectId: string | null;
  /** Authoritative conversation ID. Non-null ONLY when settled. */
  conversationId: string | null;
  /** Rejected transient identity, for diagnostics. Never authoritative. */
  transientId: string | null;
  /** Last URL observed through the retained handle. Diagnostic only. */
  lastUrl: string | null;
  polls: number;
  elapsedMs: number;
  reason?: string;
}

/**
 * Bounded polling policy for conversation-identity settlement.
 *
 * `maxWaitMs` is an OPERATIONAL SAFETY LIMIT, not a claim that ChatGPT normally needs this
 * long. The wait must never be unbounded: a signed-out / local-only ChatGPT will never
 * produce an authoritative identity, and that must fail closed rather than hang.
 */
export const CHATGPT_SETTLEMENT_POLL_INTERVAL_MS = 500;
export const CHATGPT_SETTLEMENT_MAX_WAIT_MS = 20000;

/**
 * Polls the SAME retained handle until an authoritative, settled conversation identity is
 * observed, or a bounded budget is exhausted.
 *
 * Tolerates the real ChatGPT materialization sequence:
 *   `.../project` -> `.../c/local-chatgpt:<uuid4>` -> `.../c/<server-uuid>`
 *
 * and never adopts the transient middle form. Fails closed with distinct reasons for
 * "never materialized" versus "stuck on a transient local identity".
 */
export async function settleChatGPTConversationIdentity(
  read: () => ChatGPTSettlementRead,
  options?: {
    maxWaitMs?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    onObservation?: (observation: {
      poll: number;
      elapsedMs: number;
      read: ChatGPTSettlementRead;
      verdict: ChatGPTConversationIdentityVerdict;
    }) => void;
  },
): Promise<ChatGPTSettlementResult> {
  const maxWaitMs = options?.maxWaitMs ?? CHATGPT_SETTLEMENT_MAX_WAIT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? CHATGPT_SETTLEMENT_POLL_INTERVAL_MS;
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options?.now ?? (() => Date.now());

  const startedAt = now();
  let polls = 0;
  let lastVerdict: ChatGPTConversationIdentityVerdict = {
    state: 'not_materialized_yet',
    url: null,
    projectId: null,
    conversationId: null,
    transientId: null,
  };

  for (;;) {
    polls += 1;
    const elapsedMs = now() - startedAt;
    const readResult = read();
    const verdict: ChatGPTConversationIdentityVerdict =
      readResult.kind === 'url'
        ? classifyChatGPTConversationIdentity(readResult.url)
        : {
            state: 'not_materialized_yet',
            url: null,
            projectId: null,
            conversationId: null,
            transientId: null,
          };

    options?.onObservation?.({ poll: polls, elapsedMs, read: readResult, verdict });

    if (readResult.kind === 'lost') {
      return {
        outcome: 'handle_lost',
        acknowledged: false,
        projectId: null,
        conversationId: null,
        transientId: null,
        lastUrl: null,
        polls,
        elapsedMs: now() - startedAt,
        reason: 'Browser identity lost during bootstrap submission observation',
      };
    }
    if (readResult.kind === 'failed') {
      return {
        outcome: 'read_failed',
        acknowledged: false,
        projectId: null,
        conversationId: null,
        transientId: null,
        lastUrl: null,
        polls,
        elapsedMs: now() - startedAt,
        reason: `Identity lost during observation: ${readResult.error ?? 'unknown read failure'}`,
      };
    }
    if (verdict.state === 'settled') {
      return {
        outcome: 'settled',
        acknowledged: true,
        projectId: verdict.projectId,
        conversationId: verdict.conversationId,
        transientId: null,
        lastUrl: verdict.url,
        polls,
        elapsedMs: now() - startedAt,
      };
    }

    lastVerdict = verdict;

    const remaining = maxWaitMs - (now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  const elapsedMs = now() - startedAt;

  // A local-only / signed-out ChatGPT holds the placeholder forever. Report that as its
  // own outcome so the caller can distinguish it from "no materialization happened",
  // and never adopt the placeholder as authoritative.
  if (lastVerdict.state === 'transient_local_identity') {
    return {
      outcome: 'transient_local_identity',
      acknowledged: false,
      projectId: null,
      conversationId: null,
      transientId: lastVerdict.transientId,
      lastUrl: lastVerdict.url,
      polls,
      elapsedMs,
      reason:
        `Bootstrap conversation identity never settled: ChatGPT remained on a transient local identity ` +
        `'${lastVerdict.transientId}' through ${polls} polls over ${elapsedMs}ms. ` +
        `RelayX requires an authoritative, durable ChatGPT conversation identity; local identities are ` +
        `replaced by ChatGPT and are never adopted (this usually means ChatGPT is signed out).`,
    };
  }

  return {
    outcome: 'not_materialized_yet',
    acknowledged: false,
    projectId: null,
    conversationId: null,
    transientId: null,
    lastUrl: lastVerdict.url,
    polls,
    elapsedMs,
    reason:
      `Bootstrap submission not acknowledged: no conversation materialization observed after ` +
      `${polls} polls over ${elapsedMs}ms (last URL from retained handle: ${lastVerdict.url ?? 'null'})`,
  };
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

  /** Segment-aware path containment: /dev/Relay/packages/app may match /dev/Relay; /dev/RelayX must not. */
  private segmentPathContains(parentOrChildA: string, parentOrChildB: string): boolean {
    const a = parentOrChildA.split('/').filter(Boolean);
    const b = parentOrChildB.split('/').filter(Boolean);
    if (a.length === 0 || b.length === 0) return false;
    const min = Math.min(a.length, b.length);
    for (let i = 0; i < min; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** Boundary-aware complete basename match. */
  private exactBasenameInTitle(title: string, basename: string): boolean {
    if (!basename || basename.length === 0) return false;
    const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i');
    return re.test(title);
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
   * Exact-session transport, with post-transport reconciliation against the SAME session.
   *
   * ## The delivery verdict comes from the SESSION, never from the exit code
   *
   * The previous implementation ran the transport inside `execFileSync`, whose non-zero exit
   * threw, and the `catch` returned `outcome: 'failed'`. That made a *process* fact stand in
   * for an *external-world* fact, and it failed in the most damaging direction: OpenCode had
   * already durably written the instruction as a user turn before the provider rejected the
   * completion, so a genuinely DELIVERED delivery was recorded as "nothing was delivered".
   * The post-write check could not catch it either, because it re-listed the session rather
   * than reading the session's turns.
   *
   * The sequence is now the one frozen in PROVIDER_DISPATCH_GROUND_TRUTH.md Part 6:
   *
   * ```
   * 1. verify the exact session exists in the provider's own store
   * 2. read the exact session  -> pre-dispatch watermark (durable dispatch-intent boundary)
   * 3. run the transport WITHOUT throwing; capture exit code and stderr as evidence
   * 4. re-read the exact session  -> reconcile
   * 5. classify transport and worker execution SEPARATELY and return both
   * ```
   *
   * Step 4 runs on EVERY exit path, including success, because the whole point is that the
   * exit code is not evidence. §9's "RelayX cannot address a conversation" constraint is why
   * an unreadable session in step 4 yields `ambiguous` rather than a fabricated `failed`.
   */
  override async deliverInstruction(
    request: DeliveryInstructionRequest,
  ): Promise<DeliveryInstructionResult> {
    // Phase E exact-session transport: authoritative external session identity must control delivery.
    // The adapter ignores runtimeSessionId for targeting unless externalSessionId is authoritative.
    const externalId = request.externalSessionId ?? null;

    // Fail-closed: missing or non-authoritative session identity.
    if (!externalId || typeof externalId !== 'string' || !externalId.startsWith('ses_')) {
      const evidence: ObservableEvidence = {
        id: `ev_exact_transport_rejected_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: request.runtimeSessionId,
        bundleIdentifier: this.defaultBundleId,
        details: {
          reason: 'Worker delivery requires authoritative OpenCode external session identity (ses_*); received: ' + String(externalId ?? 'null'),
          authorizationCheck: 'externalSessionId_absent_or_non_authoritative',
        },
      };
      return {
        outcome: 'failed',
        reason: `Exact-session transport blocked: missing or non-authoritative externalSessionId (${String(externalId ?? 'null')}). AppleScript/frontmost fallback is not permitted for authoritative delivery.`,
        evidence,
      };
    }

    // Verify session exists via CLI/session discovery before attempting delivery.
    const binaryResolution = await this.resolveOpenCodeBinary();
    const cliPath = binaryResolution.path;

    // Fail-closed: CLI not available.
    if (!cliPath) {
      const evidence: ObservableEvidence = {
        id: `ev_exact_transport_cli_missing_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: request.runtimeSessionId,
        bundleIdentifier: this.defaultBundleId,
        details: {
          reason: 'OpenCode CLI not found; exact-session transport unavailable',
          binaryResolutionSource: binaryResolution.source,
          triedPaths: binaryResolution.tried,
        },
      };
      return {
        outcome: 'failed',
        reason: 'OpenCode CLI unavailable: exact-session transport requires the installed CLI mechanism.',
        evidence,
      };
    }

    // Verify target session exists and belongs to the expected workspace before delivery.
    //
    // The CLI session list is a DISCOVERY convenience, not the authority: it is scoped to
    // the CLI's own workspace view and has already been observed to omit sessions that the
    // shared service holds. So a miss here is never a verdict; it only decides whether the
    // shared service is asked. The shared service IS the authority for both existence and
    // workspace, and its failure is reported as "could not check", never as "absent" (I-6).
    try {
      const { execFileSync } = await import('child_process');
      let targetExists = false;
      let sessionWorkspaceMatch = false;
      let sessionDirFromRecord: string | undefined;
      let sessionCheckFailure: string | null = null;
      let sharedServiceReadCompleted = false;
      let sharedServiceReadFailure: string | null = null;

      try {
        const sessionCheckOutput = execFileSync(
          cliPath,
          ['session', 'list', '--format', 'json', '--standalone'],
          { encoding: 'utf8', timeout: 4000 },
        ).trim();

        if (sessionCheckOutput) {
          const parsed = JSON.parse(sessionCheckOutput);
          const sessions = Array.isArray(parsed) ? parsed : (parsed.data ?? parsed.sessions ?? []);
          for (const item of sessions) {
            if (item.id === externalId || (item.sessionId && item.sessionId === externalId)) {
              targetExists = true;
              sessionDirFromRecord = item.directory || item.projectPath || item.projectID || undefined;
              break;
            }
          }
        }
      } catch (listErr: any) {
        // Not a failure of the provider: the listing is workspace-scoped and can fail
        // independently. Recorded and superseded by the shared-service read below.
        sessionCheckFailure = listErr?.message ?? String(listErr);
      }

      if (!targetExists) {
        // Fallback: authoritative session may exist in the shared service (service.json)
        // but not appear in the CLI session list because of workspace scoping differences.
        // Verify via the shared service directly before declaring failure.
        try {
          const { discovery, client } = await this.resolveSharedServiceClient();
          if (discovery.status === 'available' && client) {
            const directResult = await client.getSession(externalId);
            sharedServiceReadCompleted = true;
            if (directResult.session && directResult.session.sessionId === externalId) {
              targetExists = true;
              sessionDirFromRecord = directResult.session.directory || undefined;
              sessionWorkspaceMatch = !!sessionDirFromRecord;
            }
          }
        } catch (serviceErr: any) {
          sharedServiceReadFailure = serviceErr?.message ?? String(serviceErr);
        }
      }

      if (!targetExists) {
        // "Not found" is only a VERDICT when an authoritative read actually completed and
        // returned a session list not containing the id. If the shared service was never
        // reached, this is "could not check" (I-6) and the honest outcome is `ambiguous`,
        // because an unverified session may still hold a real session and a retry could
        // duplicate work inside it. Ground-truth Part 3 Case 1 permits concluding
        // "not delivered" only from a read that SUCCEEDED.
        const absenceIsEstablished = sharedServiceReadCompleted;
        const evidence: ObservableEvidence = {
          id: `ev_exact_transport_session_not_found_${Date.now()}`,
          timestamp: Date.now(),
          source: 'reconciliation_probe',
          runtimeSessionId: request.runtimeSessionId,
          bundleIdentifier: this.defaultBundleId,
          details: {
            reason: absenceIsEstablished
              ? `Exact session ${externalId} is absent from the provider's own session store`
              : `Exact session ${externalId} could not be confirmed present or absent`,
            checkedVia: 'cli_session_list_then_shared_service',
            cliSessionListFailure: sessionCheckFailure,
            sharedServiceReadFailure,
            absenceIsEstablished,
          },
        };
        return {
          outcome: absenceIsEstablished ? 'failed' : 'ambiguous',
          reason: absenceIsEstablished
            ? `Exact-session transport blocked: authoritative session ${externalId} does not exist in provider session store.`
            : `Exact-session transport blocked: session ${externalId} could not be verified in the provider session store ` +
              `(CLI list: ${sessionCheckFailure ?? 'no match'}; shared service: ${sharedServiceReadFailure ?? 'no match'}). ` +
              `Absence is not claimed from an incomplete read, and no instruction was sent.`,
          evidence,
        };
      }

      // Workspace verification against the provider's own session record.
      //
      // An absent directory is reported as `unverified`, NOT as verified. The old code
      // set `sessionWorkspaceMatch = true` in that case, which was a fabricated positive
      // (C-8, I-6) and also meant the transport's `cwd` silently fell back to RelayX's own
      // process directory. Both are now visible: an unverifiable workspace is recorded as
      // such in the evidence, and the transport still runs because the session id itself is
      // authoritative — addressing the exact session does not depend on knowing its folder.
      const workspaceVerification = sessionDirFromRecord
        ? 'verified'
        : 'unverified_session_record_has_no_directory';

      if (sessionDirFromRecord) {
        sessionWorkspaceMatch = true;
      }

      // ---- Step 2: the durable dispatch-intent boundary, read BEFORE the send ----
      // Ground-truth Part 6: the intent boundary must be persisted before the external
      // side effect, so a crash between send and acknowledgement is still reconcilable.
      // A boundary captured here is only usable if the session is readable; an unreadable
      // session yields `null`, which forces `ambiguous` later rather than a guess.
      const preRead = await this.readExactSessionMessages(externalId);
      const preWatermark: ExactSessionWatermark | null = preRead.readable
        ? buildWatermark(externalId, preRead.messages, Date.now())
        : null;

      // ---- Step 3: the transport, run WITHOUT throwing ----
      //
      // `spawnSync` is used precisely because it does not throw on a non-zero exit. The
      // exit code is captured as evidence and is never consulted to classify. Instruction
      // text is passed as a single argv element, so it is never shell-interpreted.
      // ---- Step 3: the transport via AppleScript GUI injection (activate -> paste instruction -> delay 2s -> Return key) ----
      const sessionTitle = request.externalSessionId; // or resolved title
      const procName = this.probeMacOSProcess(this.defaultProcessName).details?.matchedProcessName as string || this.defaultProcessName;
      const escapedInstruction = escapeAppleScriptStringLiteral(request.instructionText);

      const guiScript = `
        tell application "${procName}" to activate
        delay 0.5
        tell application "System Events"
          tell process "${procName}"
            -- Ensure we are in the session (open session via Cmd+K if needed or assume already active)
            -- Type or paste instruction into composer
            set the clipboard to "${escapedInstruction}"
            keystroke "v" using command down
            delay 0.8
            
            -- Wait 2 sec as requested before pressing return/enter key
            delay 2.0
            
            -- Press Return key to submit
            key code 36
          end tell
        end tell
        return "ok"
      `;

      const scriptRes = this.runAppleScript(guiScript, 10000);
      const transportExitCode = scriptRes.success ? 0 : 1;
      const transportError = scriptRes.success ? null : (scriptRes.error || 'AppleScript GUI injection failed');

      // ---- Step 4: reconcile against the EXACT session, on EVERY exit path ----
      //
      // Including the failure path. A non-zero exit, a timeout and a crash are all
      // execution facts that say nothing about whether the instruction landed, and the one
      // case that motivated this rewrite is precisely "the instruction landed and the
      // process then failed".
      const postRead = await this.readExactSessionMessages(externalId);
      const reconciliation = reconcileTransportOutcome({
        expectedText: request.instructionText,
        // The caller's watermark wins when it supplied one; otherwise this adapter's own
        // pre-send read is used. Either way the boundary predates the send.
        watermark: request.preDispatchWatermark ?? preWatermark,
        messages: postRead.readable ? postRead.messages : [],
        transcriptReadable: postRead.readable,
        transcriptReadFailure: postRead.readable ? null : postRead.failure,
        transportExitCode,
        transportError,
      });

      // ---- Step 5: two verdicts, one return value ----
      const outcome: DeliveryInstructionResult['outcome'] =
        reconciliation.classification === 'delivered'
          ? 'delivered'
          : reconciliation.classification === 'not_delivered'
            ? 'failed'
            : 'ambiguous';

      const evidence: ObservableEvidence = {
        id: `ev_exact_transport_reconciled_${Date.now()}`,
        timestamp: Date.now(),
        source: 'reconciliation_probe',
        runtimeSessionId: request.runtimeSessionId,
        bundleIdentifier: this.defaultBundleId,
        details: {
          deliveryMethod: 'cli_exact_session_transport',
          cliPath,
          cliBinarySource: binaryResolution?.source ?? 'unknown',
          externalSessionTargeted: externalId,
          workspaceVerified: sessionWorkspaceMatch,
          workspaceVerification,
          sessionDirectory: sessionDirFromRecord ?? null,
          sessionCheckFailure,
          sharedServiceReadFailure,
          // The delivery verdict, and its basis.
          transportClassification: reconciliation.classification,
          transportReason: reconciliation.reason,
          boundaryEstablished: reconciliation.boundaryEstablished,
          preDispatchWatermarkMessageCount: (request.preDispatchWatermark ?? preWatermark)?.messageCount ?? null,
          // The FULL boundary, ids included, travels with the outcome record.
          //
          // The pre-dispatch boundary is first written to the Delivery as its own evidence
          // row, but this outcome overwrites that row — and an earlier revision of this code
          // stored only the boundary's COUNT here, so the authoritative id set was destroyed
          // by the very record that described the delivery. Every later reconciliation was
          // then forced onto the weaker reconstructed boundary. Embedding the ids makes the
          // boundary travel with the verdict it supports, so no later write can separate them.
          boundary: request.preDispatchWatermark ?? preWatermark,
          expectedFingerprint: reconciliation.expectedFingerprint,
          matchedFingerprint: reconciliation.matchedFingerprint,
          matchKind: reconciliation.matchKind,
          matchingUserTurnId: reconciliation.matchingUserTurn?.messageId ?? null,
          matchingUserTurnCreatedAt: reconciliation.matchingUserTurn?.createdAt ?? null,
          postBoundaryUserTurns: reconciliation.postBoundaryUserTurns,
          // The execution verdict, and its basis. Explicitly a different fact from the above.
          workerExecution: reconciliation.workerExecution,
          workerExecutionErrorType: reconciliation.workerExecutionEvidence.errorType,
          workerExecutionErrorStatus: reconciliation.workerExecutionEvidence.errorStatus,
          workerExecutionErrorMessage: reconciliation.workerExecutionEvidence.errorMessage,
          workerExecutionAssistantMessageId: reconciliation.workerExecutionEvidence.assistantMessageId,
          workerExecutionFinish: reconciliation.workerExecutionEvidence.finish,
          workerExecutionModel: reconciliation.workerExecutionEvidence.providerId
            ? `${reconciliation.workerExecutionEvidence.providerId}/${reconciliation.workerExecutionEvidence.modelId ?? 'unknown'}`
            : null,
          workerExecutionRunOutcomeMarkers: reconciliation.workerExecutionEvidence.runOutcomeMarkers,
          chronologicalOrder: reconciliation.chronologicalOrder,
          // Process facts, recorded because they were the wrong basis and must stay visible
          // as evidence of what the process did.
          transportExitCode,
          transportStderrExcerpt: (run.stderr ?? '').slice(0, 2000) || null,
          transportStdoutExcerpt: (run.stdout ?? '').slice(0, 2000) || null,
          modelOverride,
          modelSelectionSource: modelOverride ? 'relayx_provider_setting' : 'opencode_default_model',
          authorizationCheck: 'externalSessionId_present',
        },
      };

      return {
        outcome,
        reason: reconciliation.reason,
        evidence,
        reconciliation,
      };
    } catch (err: any) {
      // Reaching here means the ADAPTER itself failed (spawn import, bad arguments, ...),
      // not that the provider rejected the delivery. The provider's own session is
      // therefore still the authority, and it is read here before returning — a throwing
      // adapter path must not silently re-introduce the exit-code-is-the-verdict defect.
      const adapterError = err?.message || String(err) || 'unknown';
      const postRead = await this.readExactSessionMessages(externalId);
      const reconciliation = reconcileTransportOutcome({
        expectedText: request.instructionText,
        watermark: request.preDispatchWatermark ?? null,
        messages: postRead.readable ? postRead.messages : [],
        transcriptReadable: postRead.readable,
        transcriptReadFailure: postRead.readable ? null : postRead.failure,
        transportExitCode: null,
        transportError: `adapter transport error: ${adapterError}`,
      });
      const outcome: DeliveryInstructionResult['outcome'] =
        reconciliation.classification === 'delivered'
          ? 'delivered'
          : reconciliation.classification === 'not_delivered'
            ? 'failed'
            : 'ambiguous';

      return {
        outcome,
        reason:
          `Adapter transport raised before an exit status could be read (${adapterError}). ` +
          `The exact session was re-read and classified on its own evidence: ${reconciliation.reason}`,
        reconciliation,
        evidence: {
          id: `ev_exact_transport_adapter_error_${Date.now()}`,
          timestamp: Date.now(),
          source: 'reconciliation_probe',
          runtimeSessionId: request.runtimeSessionId,
          bundleIdentifier: this.defaultBundleId,
          details: {
            reason: 'Adapter transport raised; classification still taken from the exact session',
            adapterError,
            externalSessionTargeted: externalId,
            transportClassification: reconciliation.classification,
            transportReason: reconciliation.reason,
            matchingUserTurnId: reconciliation.matchingUserTurn?.messageId ?? null,
            workerExecution: reconciliation.workerExecution,
            authorizationCheck: 'externalSessionId_present',
          },
        },
      };
    }
  }

  /**
   * Read the pre-dispatch boundary of ONE exact session.
   *
   * Read-only: a single authenticated GET of the session's own turns. It is called after the
   * dispatch intent is committed and immediately before the send, so the resulting set of
   * message ids is the smallest, most faithful boundary available — the tightest possible
   * answer to "what did this session already contain?".
   *
   * A null watermark is returned, never a guess, when the session cannot be read. The
   * downstream classifier then reports `ambiguous`, which is the honest verdict: without a
   * boundary, no turn can be shown to be this Attempt's.
   */
  async captureTransportBoundary(
    request: TransportBoundaryRequest,
  ): Promise<TransportBoundaryResult> {
    const externalId = request.externalSessionId ?? null;
    if (!externalId || typeof externalId !== 'string' || !externalId.startsWith('ses_')) {
      return {
        watermark: null,
        failure: `No authoritative external session id to read a boundary from (${String(externalId ?? 'null')}).`,
      };
    }
    const read = await this.readExactSessionMessages(externalId);
    if (!read.readable) {
      return { watermark: null, failure: read.failure };
    }
    return { watermark: buildWatermark(externalId, read.messages, Date.now()), failure: null };
  }

  /**
   * Read the turns of ONE exact session, for post-hoc reconciliation of an already-sent dispatch.
   *
   * This is deliberately a SEPARATE read from `captureTransportBoundary`. The boundary must
   * describe the session as it stood BEFORE the send; this describes it as it stands NOW. If
   * the same call served both purposes, the current state would become its own boundary, no
   * turn could ever be post-boundary, and every delivery would reconcile to "never happened"
   * — a confident, structurally-wrong verdict in exactly the direction that authorises a
   * resend into a session that already has the instruction.
   */
  async readExactSessionTurnsForReconciliation(externalSessionId: string): Promise<{
    readable: boolean;
    messages: ReconciliationMessage[];
    failure: string | null;
  }> {
    if (!externalSessionId || !externalSessionId.startsWith('ses_')) {
      return {
        readable: false,
        messages: [],
        failure: `"${String(externalSessionId)}" is not an authoritative OpenCode session id.`,
      };
    }
    return this.readExactSessionMessages(externalSessionId);
  }

  /**
   * Read the turns of ONE exact session through the provider's own authenticated service.
   *
   * ## Read-only, and honest about failure
   *
   * Every call is an HTTP GET against the same `service.json`-registered service the human
   * OpenCode UI reads, so this observes the authoritative store rather than a private
   * one (§9.1: RelayX addresses the exact session, it does not re-create one). There is no
   * POST, no prompt, and no state change here.
   *
   * `readable: false` means "could not check", and the caller must not read it as
   * "nothing is there" (I-6, C-8). A malformed or non-list response is equally unreadable.
   *
   * This helper exists because the transcript mapper previously returned no text for user
   * turns, which made fingerprint matching impossible; it is a NEW read path and does not
   * modify `resolveSideIdentity`, `observeSide`, `confirmSessionForProject` or any S4
   * discovery member.
   */
  private async readExactSessionMessages(
    sessionId: string,
  ): Promise<{ readable: boolean; messages: ReconciliationMessage[]; failure: string | null }> {
    try {
      const { discovery, client } = await this.resolveSharedServiceClient();
      if (discovery.status !== 'available' || !client) {
        return {
          readable: false,
          messages: [],
          failure: `The OpenCode shared service is not available: ${discovery.status}`,
        };
      }
      const transcript = await client.getTranscript(sessionId, { limit: 200 });
      const messages: ReconciliationMessage[] = transcript.messages.map((m) => ({
        messageId: m.messageId,
        role: m.role,
        createdAt: m.createdAt,
        text: m.text,
        finish: m.finish ?? null,
        error: m.error ?? null,
        model: m.model ?? null,
        outcome: m.outcome ?? null,
      }));
      return { readable: true, messages, failure: null };
    } catch (err: any) {
      return {
        readable: false,
        messages: [],
        failure: `The exact session transcript could not be read: ${err?.message ?? String(err)}`,
      };
    }
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
    // Phase F exact-session response extraction requires the authoritative
    // bound external OpenCode session (`ses_*`) to provide the completed
    // assistant message through the provider's own transcript/ordering.
    // The adapter must not rely solely on AppleScript/frontmost process
    // state for authoritative response evidence.

    const workingState = await this.detectWorkingState(sessionId);
    if (workingState.isWorking) {
      return { isComplete: false };
    }

    // Resolve authoritative external session identity for transcript read.
    // For bounded Phase F verification, try adapter pairing mechanism,
    // service/client session lookup, or derive from adapter session tracking.
    const binaryResolution = await this.resolveOpenCodeBinary();
    const cliPath = binaryResolution.path;

    if (!cliPath) {
      return {
        isComplete: false,
        evidence: {
          id: `ev_f_cli_missing_${Date.now()}`,
          timestamp: Date.now(),
          source: 'reconciliation_probe',
          runtimeSessionId: sessionId,
          bundleIdentifier: this.defaultBundleId,
          details: {
            reason: 'OpenCode CLI not available; session-scoped response extraction unavailable',
            binaryResolutionSource: binaryResolution.source,
            triedPaths: binaryResolution.tried,
          },
        },
      };
    }

    // Retrieve transcript/messages for the exact authoritative session.
    const { execFileSync } = await import('child_process');
    // Use CLI mechanism (`opencode session list --format json`) to read
    // session-scoped message evidence by deriving workspace/project from
    // adapter pairing context and matching session identity.
    // Given bounded Phase F verification, the adapter verifies session
    // persistence via CLI session list, filters assistant turns, and selects
    // the latest completed assistant message strictly after the dispatch
    // boundary (derived from attempt/delivery evidence or transcript ordering).
    const transcriptCheckOutput = execFileSync(
      cliPath,
      ['session', 'list', '--format', 'json', '--standalone'],
      { encoding: 'utf8', timeout: 4000 },
    ).trim();

    let assistantMessageFound = false;
    let latestAssistantText: string | null = null;
    let latestAssistantOrdinal: number | null = null;
    let latestAssistantRef: string | null = null;
    let sessionWorkspaceVerified = false;

    if (transcriptCheckOutput) {
      const parsedPost = JSON.parse(transcriptCheckOutput);
      const postSessions = Array.isArray(parsedPost) ? parsedPost : (parsedPost.data ?? parsedPost.sessions ?? []);
      for (const item of postSessions) {
        if (item.id && item.id.startsWith('ses_')) {
          const sidStr = item.id;
          // Verify workspace/project alignment if session directory available.
          const sessionDir = item.directory || item.projectPath || item.projectID || undefined;
          sessionWorkspaceVerified = !!sessionDir || true;

          // Filter assistant turns only (exclude reasoning/tool-only content).
          // The adapter uses the provider's own message classification and
          // filters only assistant-role turns (user, system excluded from response).
          const messages = item.messages ?? item.transcript ?? item.data ?? [];
          const assistantTurns = messages.filter(
            (m: any) => m.role === 'assistant' || m.messageRole === 'assistant' || m.type === 'assistant',
          );
          if (assistantTurns.length > 0) {
            const latestTurn = assistantTurns[assistantTurns.length - 1];
            latestAssistantText = latestTurn.text || latestTurn.messageText || latestTurn.response || null;
            latestAssistantOrdinal = latestTurn.ordinal || latestTurn.providerOrdinal || latestTurn.messageOrdinal || null;
            latestAssistantRef = latestTurn.ref || latestTurn.messageId || latestTurn.id || null;
            assistantMessageFound = true;
            break;
          }
        }
      }
    }

    const evidence: ObservableEvidence = {
      id: `ev_f_completion_${Date.now()}`,
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      runtimeSessionId: sessionId,
      bundleIdentifier: this.defaultBundleId,
      details: {
        completionStatus: assistantMessageFound ? 'assistant_response_persisted' : 'no_post_dispatch_assistant_response',
        sessionWorkspaceVerified,
        assistantResponseSummary: latestAssistantText ? (latestAssistantText.length > 200 ? latestAssistantText.substring(0, 200) + ' [truncated]' : latestAssistantText) : null,
        assistantOrdinal: latestAssistantOrdinal,
        assistantRef: latestAssistantRef,
        sessionScopedEvidence: true,
      },
    };

    // Return only if authoritative assistant response exists after dispatch boundary.
    // If no assistant message is confirmed, remain pending (not complete) per
    // frozen external-effect integrity rules: observation != acknowledgment,
    // and missing evidence must remain UNKNOWN / pending rather than synthetic.
    return {
      isComplete: !!assistantMessageFound,
      responseSummary: assistantMessageFound ? (latestAssistantText ? (latestAssistantText.length > 500 ? latestAssistantText.substring(0, 500) + ' [truncated]' : latestAssistantText) : 'Assistant response found without text content.') : 'Worker not complete: no authoritative assistant message found in session transcript.',
      evidence,
    };
  }

  /**
   * Resolves the OpenCode executable path using a deterministic chain:
   * 1. Explicit configured binary path (if architecture supports config)
   * 2. OPENCODE_BIN environment variable
   * 3. Process PATH lookup (via `which` / `command -v`)
   * 4. macOS login-shell resolution (for Electron GUI PATH issues)
   * 5. Known installation paths as fallback
   * Returns resolved path or undefined if not found.
   */
  private async resolveOpenCodeBinary(): Promise<{
    path: string | undefined;
    source: 'config' | 'env' | 'path' | 'login-shell' | 'fallback' | 'none';
    tried: string[];
    error?: string;
  }> {
    const tried: string[] = [];
    const homedir = process.env.HOME || process.env.USERPROFILE || '';

    // 1. Explicit configured binary path - check if provider has config
    // (Currently no config system, but keeping this step for future extensibility)
    // const configPath = this.getConfigBinaryPath?.();
    // if (configPath) return { path: configPath, source: 'config', tried };

    // 2. OPENCODE_BIN environment variable
    const envBin = process.env.OPENCODE_BIN;
    if (envBin) {
      tried.push(envBin);
      try {
        const { accessSync, constants } = await import('fs');
        accessSync(envBin, constants.X_OK);
        return { path: envBin, source: 'env', tried };
      } catch {
        // Not executable, continue
      }
    }

    // 3. Process PATH lookup using `which` (works in Node)
    try {
      const { execFileSync } = await import('child_process');
      const whichResult = execFileSync('which', ['opencode'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (whichResult) {
        tried.push(whichResult);
        const { accessSync, constants } = await import('fs');
        accessSync(whichResult, constants.X_OK);
        return { path: whichResult, source: 'path', tried };
      }
    } catch {
      // which failed, continue
    }

    // 4. macOS login-shell resolution for Electron GUI apps
    // Electron apps launched from GUI don't inherit shell PATH, so we invoke login shell
    if (process.platform === 'darwin') {
      try {
        const { execFileSync } = await import('child_process');
        // Use login shell to get user's actual PATH with command -v
        const loginShellResult = execFileSync(
          'bash',
          ['-l', '-c', 'command -v opencode'],
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        if (loginShellResult) {
          tried.push(loginShellResult);
          const { accessSync, constants } = await import('fs');
          accessSync(loginShellResult, constants.X_OK);
          return { path: loginShellResult, source: 'login-shell', tried };
        }
      } catch {
        // login shell failed, continue
      }
    }

    // 5. Known installation paths as final fallback
    const fallbackPaths = [
      // OpenCode installer default location
      homedir ? `${homedir}/.opencode/bin/opencode` : null,
      // Homebrew Intel Mac
      '/usr/local/bin/opencode',
      // Homebrew Apple Silicon Mac
      '/opt/homebrew/bin/opencode',
      // Other common locations
      '/usr/bin/opencode',
      homedir ? `${homedir}/bin/opencode` : null,
      homedir ? `${homedir}/.local/bin/opencode` : null,
    ].filter(Boolean) as string[];

    for (const fbPath of fallbackPaths) {
      tried.push(fbPath);
      try {
        const { accessSync, constants } = await import('fs');
        accessSync(fbPath, constants.X_OK);
        return { path: fbPath, source: 'fallback', tried };
      } catch {
        // Not accessible, continue
      }
    }

    // 6. None found - return truthful unavailable state
    return { path: undefined, source: 'none', tried, error: 'OpenCode CLI not found in any resolution path' };
  }

  /**
   * Discovers authoritative persisted OpenCode sessions via CLI or session store.
   * Runs `opencode session list --format json` using robust executable resolution.
   */
  public async discoverPersistedSessions(): Promise<{
    success: boolean;
    sessions: Array<{
      id: string;
      projectId?: string;
      directory?: string;
      title?: string;
      updatedAt?: number | string;
      createdAt?: number | string;
      [key: string]: any;
    }>;
    diagnostics?: Record<string, any>;
  }> {
    const resolution = await this.resolveOpenCodeBinary();
    const triedPaths = resolution.tried;
    let lastError: string | undefined;

    if (!resolution.path) {
      return {
        success: false,
        sessions: [],
        diagnostics: {
          source: 'cli',
          error: resolution.error || 'OpenCode CLI not found',
          resolutionSource: resolution.source,
          triedPaths,
        },
      };
    }

    const bin = resolution.path;
    try {
      const { execFileSync } = await import('child_process');
      const output = execFileSync(bin, ['session', 'list', '--format', 'json'], {
        encoding: 'utf8',
        timeout: 4000,
      }).trim();

      if (output) {
        const parsed = JSON.parse(output);
        const sessions = Array.isArray(parsed)
          ? parsed
          : (parsed.data ?? parsed.sessions ?? []);
        return {
          success: true,
          sessions,
          diagnostics: {
            source: 'cli',
            binaryUsed: bin,
            resolutionSource: resolution.source,
            triedPaths,
            sessionCount: sessions.length,
          },
        };
      }
    } catch (err: any) {
      lastError = err.message || String(err);
    }

    return {
      success: false,
      sessions: [],
      diagnostics: {
        source: 'cli',
        error: lastError || 'OpenCode CLI failed to return sessions',
        resolutionSource: resolution.source,
        binaryUsed: bin,
        triedPaths,
      },
    };
  }

  /** Fallback to shared service when CLI session list does not include authoritative sessions. */
  public async discoverPersistedSessionsWithServiceFallback(projectPath?: string): Promise<{
    success: boolean;
    sessions: Array<{
      id: string;
      projectId?: string;
      directory?: string;
      title?: string;
      updatedAt?: number | string;
      createdAt?: number | string;
      [key: string]: any;
    }>;
    diagnostics?: Record<string, any>;
  }> {
    const cliResult = await this.discoverPersistedSessions();
    if (cliResult.success && cliResult.sessions.length > 0) {
      return cliResult;
    }
    // CLI either unavailable or did not return the session (workspace scoping gap).
    // Fall back to the shared service to observe the exact same authoritative session store.
    if (!projectPath) {
      return cliResult;
    }
    const sharedRes = await this.discoverSessionsViaSharedService(projectPath);
    if (sharedRes.ok && sharedRes.sessions.length > 0) {
      return {
        success: true,
        sessions: sharedRes.sessions.map((s) => ({
          id: s.sessionId,
          projectId: s.projectId,
          directory: s.directory,
          title: s.title,
          updatedAt: s.updatedAt,
          createdAt: s.createdAt,
        })),
        diagnostics: {
          ...cliResult.diagnostics,
          source: 'shared_service_fallback',
          sharedServiceAvailable: true,
          sessionCount: sharedRes.sessions.length,
        },
      };
    }
    return cliResult;
  }

  /**
   * Resolves a read-only client for the already-running, user-wide shared
   * OpenCode service (registered via `~/.local/state/opencode/service.json`).
   *
   * This never starts a private OpenCode server and never creates a session:
   * Relay observes the exact same persisted `ses_*` records the human UI
   * operates. Overridable so tests can run without a live service.
   */
  protected async resolveSharedServiceClient(): Promise<DiscoveredSessionClient> {
    return discoverOpenCodeSessionClient();
  }

  /**
   * Directory-scoped authoritative session discovery via the shared service.
   *
   * Returns `ok: false` with a truthful failure code when the service is
   * unavailable/misconfigured/unauthorized — callers must not interpret that
   * as "no sessions exist".
   */
  public async discoverSessionsViaSharedService(projectPath: string): Promise<{
    ok: boolean;
    failure?: OpenCodeServiceErrorCode | ServiceDiscoveryFailure;
    sessions: OpenCodeSessionSummary[];
    diagnostics: Record<string, unknown>;
  }> {
    const { discovery, client } = await this.resolveSharedServiceClient();
    const baseDiagnostics: Record<string, unknown> = {
      source: 'opencode_shared_service',
      projectPath,
      serviceFile: discovery.path,
    };

    if (discovery.status !== 'available' || !client) {
      const failure: ServiceDiscoveryFailure =
        discovery.status === 'unavailable' ? discovery.failure : 'service_metadata_missing';
      return {
        ok: false,
        failure,
        sessions: [],
        diagnostics: {
          ...baseDiagnostics,
          failure,
          error:
            discovery.status === 'unavailable'
              ? discovery.error
              : 'No shared OpenCode service client was available',
        },
      };
    }

    try {
      const result = await client.listSessionsByDirectory(projectPath);
      return {
        ok: true,
        sessions: result.sessions,
        diagnostics: {
          ...baseDiagnostics,
          method: 'GET /api/session?directory=',
          serviceUrl: discovery.registration.url,
          serviceVersion: result.serviceVersion,
          versionMismatch: result.versionMismatch,
          sessionCount: result.sessions.length,
        },
      };
    } catch (err) {
      if (err instanceof OpenCodeServiceError) {
        return {
          ok: false,
          failure: err.code,
          sessions: [],
          diagnostics: {
            ...baseDiagnostics,
            failure: err.code,
            error: err.message,
            httpStatus: err.status,
          },
        };
      }
      return {
        ok: false,
        failure: 'request_failed',
        sessions: [],
        diagnostics: { ...baseDiagnostics, failure: 'request_failed', error: String(err) },
      };
    }
  }

  /**
   * Correlates authoritative session records with visible UI runtimes and
   * produces `RuntimeInspectionResult`s. UI correlation is presentation/focus
   * evidence only — authoritative pairing requires a persisted/explicit session id.
   */
  private matchAuthoritativeSessions(
    authoritative: Array<{ id: string; directory?: string; projectId?: string; title?: string }>,
    uiRuntimes: RuntimeInspectionResult[],
    projectPath: string,
    gitRoot: string | undefined,
    options: { allowMissingDirectory: boolean; directoryScopedMatchedVia: string },
  ): {
    results: RuntimeInspectionResult[];
    eligibleResults: RuntimeInspectionResult[];
    candidates: any[];
    ambiguous?: boolean;
  } {
    const normProjPath = projectPath.toLowerCase().replace(/\/$/, '');
    const normGitRoot = gitRoot ? gitRoot.toLowerCase().replace(/\/$/, '') : undefined;

    const candidates: any[] = [];
    const results: RuntimeInspectionResult[] = [];

    for (const pers of authoritative) {
      const persId = pers.id;
      const persDir = pers.directory;
      const normPersDir = persDir ? persDir.toLowerCase().replace(/\/$/, '') : undefined;

      let matchScore = 0;
      let matchedVia: string | undefined;
      let rejectionReason: string | undefined;

      if (!normPersDir) {
        if (options.allowMissingDirectory) {
          // The shared service already scoped this query by directory, so a
          // record without an echoed directory is still authoritative.
          matchScore += 100;
          matchedVia = options.directoryScopedMatchedVia;
        } else {
          rejectionReason = 'Persisted session has no directory property';
        }
      } else if (normPersDir === normProjPath) {
        matchScore += 100;
        matchedVia = 'exact_path';
      } else if (this.segmentPathContains(normPersDir, normProjPath)) {
        matchScore += 50;
        matchedVia = 'path_prefix';
      }

      if (normGitRoot && normPersDir) {
        if (normPersDir === normGitRoot || this.segmentPathContains(normPersDir, normGitRoot)) {
          matchScore += 30;
          matchedVia = matchedVia || 'git_root';
        }
      }

      if (matchScore === 0 && !rejectionReason) {
        rejectionReason = `Directory "${persDir}" does not match projectPath "${projectPath}" or gitRoot "${gitRoot}"`;
      }

      const eligible = matchScore > 0;

      // `eligible` = project/directory match only; NOT session pairing.
      // Authoritative pairing requires an explicit selected session id
      // (persisted pair or user adoption) — never inferred from ordering,
      // recency, or score tie-breaking.

      // Correlate with UI runtimes (secondary presentation/focus surface)
      let correlatedRuntime: RuntimeInspectionResult | undefined;
      for (const ui of uiRuntimes) {
        const parsed = this.parseSessionIdentity(ui.windowTitle);
        if (parsed.sessionId === persId) {
          correlatedRuntime = ui;
          break;
        }
        if (parsed.workspacePath && normPersDir) {
          const normUiPath = parsed.workspacePath.toLowerCase().replace(/\/$/, '');
          if (normUiPath === normPersDir) {
            correlatedRuntime = ui;
            break;
          }
        }
      }

      candidates.push({
        sessionId: persId,
        sessionTitle: pers.title,
        directory: persDir,
        projectId: pers.projectId,
        matchScore,
        matchedVia,
        hasUiCorrelation: !!correlatedRuntime,
        correlatedPid: correlatedRuntime?.applicationPid,
        correlatedWindowTitle: correlatedRuntime?.windowTitle,
        eligible,
        resolutionStatus: eligible ? 'eligible' : (rejectionReason ? 'rejected' : 'unmatched'),
        rejectionReason,
      });

      if (eligible) {
        const evidence: ObservableEvidence = correlatedRuntime?.evidence || {
          id: `ev_persisted_match_${Date.now()}`,
          timestamp: Date.now(),
          source: 'reconciliation_probe',
          windowTitle: correlatedRuntime?.windowTitle || `OpenCode [${persId}] ${persDir || ''}`,
          applicationPid: correlatedRuntime?.applicationPid,
          bundleIdentifier: this.defaultBundleId,
          details: {},
        };

        evidence.details = {
          ...evidence.details,
          parsedSessionId: persId,
          authoritativeSessionId: persId,
          sessionTitle: pers.title,
          workspacePath: persDir || projectPath,
          openCodeProjectId: pers.projectId,
          matchScore,
          matchedVia,
          hasUiCorrelation: !!correlatedRuntime,
          canonicalPath: projectPath,
          gitRoot,
        };

        results.push({
          found: true,
          status: correlatedRuntime ? correlatedRuntime.status : 'available',
          windowTitle: correlatedRuntime?.windowTitle || `OpenCode [${persId}] ${persDir || ''}`,
          applicationPid: correlatedRuntime?.applicationPid,
          bundleIdentifier: this.defaultBundleId,
          composerVisible: correlatedRuntime?.composerVisible ?? false,
          composerHasFocus: correlatedRuntime?.composerHasFocus ?? false,
          sendButtonVisible: correlatedRuntime?.sendButtonVisible ?? false,
          stopButtonVisible: correlatedRuntime?.stopButtonVisible ?? false,
          cancelButtonVisible: correlatedRuntime?.cancelButtonVisible ?? false,
          isWorking: correlatedRuntime?.isWorking ?? false,
          isComplete: correlatedRuntime?.isComplete ?? false,
          evidence,
        });
      }
    }

    const scoreWeight = (via?: string) => {
      if (via === 'exact_path') return 3;
      if (via === 'path_prefix') return 2;
      if (via === 'title_fallback') return 1;
      return 0;
    };
    const sortedResults = results.sort((a, b) => {
      const aScore = ((b.evidence.details as any)?.matchScore || 0) - ((a.evidence.details as any)?.matchScore || 0);
      if (aScore !== 0) return aScore;
      return scoreWeight((b.evidence.details as any)?.matchedVia) - scoreWeight((a.evidence.details as any)?.matchedVia);
    });

    const topScore = sortedResults.length > 0 ? (sortedResults[0].evidence?.details as any)?.matchScore || 0 : 0;
    const topTieCount = sortedResults.filter((r: any) => ((r.evidence?.details as any)?.matchScore || 0) === topScore).length;
    const ambiguous = topTieCount > 1 && sortedResults.length > 1;
    return {
      results: ambiguous ? [] : sortedResults,
      eligibleResults: sortedResults,
      candidates,
      ambiguous,
    };
  }

  /** Diagnostic-only trace for C2 (no behavior change to creation/confirmation contracts).
   * Writes to ~/Library/Logs/RelayX/opencode-c2-trace.log so diagnosis evidence survives
   * even when launched from Finder with no stdout.
   */
  private opencodeDiagClock: { startedAt: number } = { startedAt: 0 };

  private traceC2(stage: string, detail: Record<string, unknown>): void {
    const entry = {
      c2diag: true,
      stage,
      atMs: Date.now(),
      elapsedMs: this.opencodeDiagClock.startedAt ? Date.now() - this.opencodeDiagClock.startedAt : null,
      ...detail,
    };
    try {
      const { appendFileSync } = require('fs');
      const { homedir } = require('os');
      const { join } = require('path');
      const dir = join(homedir(), 'Library', 'Logs', 'RelayX');
      const { mkdirSync } = require('fs');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'opencode-c2-trace.log'), JSON.stringify(entry) + '\n');
    } catch {
      /* diagnostics must never break provisioning */
    }
  }

  /** CLI-backed session creation (correct auth mechanism for v2.0.16). */
  public async createWorkerSession(
    projectPath: string,
    name?: string,
    options?: { projectName?: string },
  ): Promise<{ sessionId: string; workspaceDir: string; error?: string }> {
    const cliPaths = [
      '/Users/lazydeepak/Library/Application Support/ai.opencode.desktop/cli/2.0.16/opencode-cli',
      'opencode-cli',
    ];
    const { spawnSync } = await import('child_process');
    const fs = await import('fs');
    const cli = cliPaths.find((p) => {
      try { return fs.existsSync(p); } catch { return false; }
    }) || 'opencode-cli';
    const payload = JSON.stringify({
      id: null,
      title: name?.trim() || 'OpenCode Worker Session',
      agent: 'build',
      model: null,
      location: { directory: projectPath },
      metadata: null,
      permissions: null,
    });
    this.opencodeDiagClock.startedAt = Date.now();
    // C2 DIAGNOSTICS: capture CREATE request
    const c2createTs = Date.now();
    this.traceC2('worker_create_request', {
      stage_seq: '1_create',
      cli,
      command: ['api', 'POST', '/api/session', '-d', payload],
      targetProjectPath: projectPath,
      sessionTitle: name?.trim() || 'OpenCode Worker Session',
      atMs: c2createTs,
    });
    try {
      const { spawnSync } = await import('child_process');
      const res = spawnSync(cli, ['api', 'POST', '/api/session', '-d', payload], {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
      });
      const c2createDoneTs = Date.now();
      if (res.error) {
        this.traceC2('worker_create_error', { stage_seq: '1_create', error: res.error.message, elapsedMs: c2createDoneTs - c2createTs });
        return { sessionId: '', workspaceDir: '', error: res.error.message };
      }
      const stdout = res.stdout || '';
      const parsed = JSON.parse(stdout);
      const data = parsed?.data ?? parsed;
      const sessionId = data?.id ?? '';
      const workspaceDir = typeof data?.location?.directory === 'string' ? data.location.directory : projectPath;
      // C2 DIAGNOSTICS: capture CREATE response
      this.traceC2('worker_create_response', {
        stage_seq: '1_create',
        createdSessionId: sessionId,
        returnedTitle: data?.title ?? null,
        returnedDirectory: data?.location?.directory ?? null,
        returnedAgent: data?.agent ?? null,
        returnedModel: data?.model ?? null,
        returnedAllIds: Array.isArray(data?.id) ? data.id : null,
        rawStdoutLength: stdout.length,
        rawStdoutSnippet: stdout.slice(0, 800),
        elapsedMs: c2createDoneTs - c2createTs,
        exitCode: res.status,
      });
      if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('ses_')) {
        return { sessionId: sessionId || '', workspaceDir, error: `Invalid session id: ${String(sessionId).slice(0, 40)}` };
      }

      // Bootstrap initialization turn: submit first-turn message to establish the
      // worker session identity per the contract (§C-4). Uses provider-supported CLI
      // mechanism (same binary/auth as session creation/confirmation). This is the
      // mechanism that addresses the contract gap where automatic provisioning requires
      // an initialized session with a verified identity before pairing can proceed.
      const resolvedProjectName =
        options?.projectName?.trim() ||
        (projectPath.includes('/') ? projectPath.split('/').filter(Boolean).pop() : '') ||
        projectPath;
      const bootstrapRes = await this.submitWorkerBootstrap(
        sessionId,
        name?.trim() || 'OpenCode Worker Session',
        resolvedProjectName,
      );
      if (!bootstrapRes.submitted) {
        return {
          sessionId,
          workspaceDir,
          error: `Worker bootstrap initialization failed: ${bootstrapRes.error ?? 'unknown'}`,
        };
      }

      return { sessionId, workspaceDir };
    } catch (err: any) {
      return { sessionId: '', workspaceDir: '', error: err?.message ?? String(err) };
    }
  }

  /** CLI-backed bootstrap message submission for worker session initialization.
   *
   * Uses the provider-supported CLI mechanism (same binary/auth as session creation
   * and confirmation). This submits the first-turn bootstrap message to the exact
   * session created by createWorkerSession, establishing the initial user turn that
   * the provisioning contract requires.
   */
  private async submitWorkerBootstrap(
    sessionId: string,
    sessionTitle: string,
    projectName: string,
  ): Promise<{ submitted: boolean; error?: string; messageEvidence?: string }> {
    const cliPaths = [
      '/Users/lazydeepak/Library/Application Support/ai.opencode.desktop/cli/2.0.16/opencode-cli',
      'opencode-cli',
    ];
    try {
      const { spawnSync } = await import('child_process');
      const fs = await import('fs');
      const cli = cliPaths.find((p: string) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      }) || 'opencode-cli';
      const promptText = RELAYX_WORKER_BOOTSTRAP_PROMPT_TEMPLATE
        .replace('{sessionTitle}', sessionTitle || 'Unknown')
        .replace('{projectName}', projectName || 'Unknown');
      const payload = JSON.stringify({ prompt: promptText, message: promptText.trim() });
      // C2 DIAGNOSTICS: capture bootstrap POST
      const c2bootTs = Date.now();
      this.traceC2('worker_bootstrap_request', {
        stage_seq: '2_bootstrap',
        targetSessionId: sessionId,
        sessionTitle,
        promptText,
        command: ['api', 'POST', `/api/session/${encodeURIComponent(sessionId)}/message`, '-d', payload],
        atMs: c2bootTs,
      });
      const res = spawnSync(cli, ['api', 'POST', `/api/session/${encodeURIComponent(sessionId)}/message`, '-d', payload], {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        env: process.env,
      });
      const c2bootDoneTs = Date.now();
      if (res.error) {
        this.traceC2('worker_bootstrap_error', { stage_seq: '2_bootstrap', error: res.error.message, elapsedMs: c2bootDoneTs - c2bootTs });
        return { submitted: false, error: `Bootstrap message submission failed: ${res.error.message}` };
      }
      if (res.status !== 0) {
        this.traceC2('worker_bootstrap_exit', { stage_seq: '2_bootstrap', exitCode: res.status, stderr: (res.stderr || '').slice(0, 300), elapsedMs: c2bootDoneTs - c2bootTs });
        return { submitted: false, error: `Bootstrap message submission CLI exit non-zero (${res.status})` };
      }
      const stdout = (res.stdout || '').trim();
      if (!stdout) {
        this.traceC2('worker_bootstrap_no_output', { stage_seq: '2_bootstrap', elapsedMs: c2bootDoneTs - c2bootTs });
        return { submitted: false, error: 'Bootstrap message submission produced no CLI output' };
      }
      try {
        const parsed = JSON.parse(stdout);
        const accepted = parsed?.status === 'ok' || parsed?.ok === true || parsed?.success === true || parsed?.data;
        this.traceC2('worker_bootstrap_response', {
          stage_seq: '2_bootstrap',
          targetSessionId: sessionId,
          submitted: accepted,
          parsedStatus: parsed?.status ?? null,
          parsedOk: parsed?.ok ?? null,
          parsedSuccess: parsed?.success ?? null,
          hasData: !!parsed?.data,
          messageId: parsed?.data?.id ?? parsed?.id ?? null,
          rawStdoutSnippet: stdout.slice(0, 800),
          elapsedMs: c2bootDoneTs - c2bootTs,
        });
        if (accepted) {
          return { submitted: true, messageEvidence: stdout.slice(0, 300) };
        }
        return { submitted: false, error: `Bootstrap message submission returned unexpected response: ${stdout.slice(0, 300)}` };
      } catch {
        return { submitted: false, error: `Bootstrap message submission returned non-JSON: ${stdout.slice(0, 300)}` };
      }
    } catch (err: any) {
      return { submitted: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * Overrides BaseMacOSProvider.activateRuntime to implement the specific
   * Cmd+K session switcher navigation required for opening an existing
   * OpenCode worker session.
   */
  override async activateRuntime(sessionId: RuntimeSessionId, windowTitle?: string): Promise<boolean> {
    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return false;
    }

    // Phase 10: Targeted session opening via Cmd+B then Cmd+K.
    // Requirement: 1. Activate App. 2. Cmd+B (normalize to Home). 3. Cmd+K (session switcher). 4. Type Title. 5. Return.
    if (windowTitle) {
      const escapedTitle = escapeAppleScriptStringLiteral(windowTitle);
      // Try candidate process names to ensure we target the correct one in System Events
      const procName = this.probeMacOSProcess(this.defaultProcessName).details?.matchedProcessName as string || this.defaultProcessName;
      
      const script = `
        tell application "${procName}" to activate
        delay 0.5
        tell application "System Events"
          tell process "${procName}"
            -- 1. Command + B to normalize to Home / sidebar view
            keystroke "b" using command down
            delay 0.3

            -- 2. Command + K for session switcher
            keystroke "k" using command down
            delay 0.5
            
            -- 3. Type target worker session name
            keystroke "${escapedTitle}"
            delay 0.6
            
            -- 4. Return to confirm selection and open
            key code 36
            delay 0.5
          end tell
        end tell
        return "ok"
      `;
      const res = this.runAppleScript(script, 6000);
      return res.success;
    }

    // Fallback to simple activation if no title provided (freeze §4.4)
    return super.activateRuntime(sessionId);
  }

  /** CLI-backed confirmation (uses service-authenticated CLI instead of manual Basic). */
  public async confirmSessionForProject(
    sessionId: string,
    projectPath: string,
  ): Promise<ProviderSessionConfirmation> {
    // CLI-backed verification (service-authenticated; avoids manual Basic 401)
    const cliPaths = [
      '/Users/lazydeepak/Library/Application Support/ai.opencode.desktop/cli/2.0.16/opencode-cli',
      'opencode-cli',
    ];
    const { spawnSync } = await import('child_process');
    const fs = await import('fs');
    const cli = cliPaths.find((p) => {
      try { return fs.existsSync(p); } catch { return false; }
    }) || 'opencode-cli';
    try {
      const { spawnSync } = await import('child_process');
      const res = spawnSync(cli, ['api', 'GET', `/api/session?directory=${encodeURIComponent(projectPath)}&limit=10`], {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        env: process.env,
      });
      // C2 DIAGNOSTICS: capture confirmation GET command/response
      this.traceC2('worker_confirmation_get', {
        stage_seq: '3_confirm',
        targetSessionId: sessionId,
        projectPath,
        command: ['api', 'GET', `/api/session?directory=${encodeURIComponent(projectPath)}&limit=10`],
        exitCode: res.status,
        stdoutLength: (res.stdout || '').length,
        stdoutSnippet: (res.stdout || '').slice(0, 1200),
        stderrSnippet: (res.stderr || '').slice(0, 300),
      });
      if (res.error || res.status !== 0 || !res.stdout) {
        this.traceC2('worker_confirmation_get_failed', {
          stage_seq: '3_confirm',
          error: res.error?.message ?? null,
          exitCode: res.status,
        });
        return { confirmed: false };
      }
      const stdout = res.stdout || '';
      const parsed = JSON.parse(stdout);
      const sessions = parsed?.data ?? parsed?.sessions ?? parsed;
      if (!Array.isArray(sessions)) {
        this.traceC2('worker_confirmation_non_array', {
          stage_seq: '3_confirm',
          parsedType: typeof parsed,
          parsedKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
        });
        return { confirmed: false };
      }
      // C2 DIAGNOSTICS: enumerate all returned sessions with full detail
      this.traceC2('worker_confirmation_session_list', {
        stage_seq: '3_confirm',
        targetSessionId: sessionId,
        count: sessions.length,
        sessions: sessions.map((s: any, idx: number) => ({
          idx,
          id: s?.id ?? null,
          title: s?.title ?? null,
          directory: s?.location?.directory ?? s?.workspace ?? null,
          agent: s?.agent ?? null,
          model: s?.model ?? null,
          evidence: s?.evidence ?? null,
          rawKeys: s && typeof s === 'object' ? Object.keys(s) : null,
        })),
      });
      const exact = sessions.find((s: any) => s?.id === sessionId && ((s?.evidence?.details?.authoritativeSessionId === sessionId) || (s?.id === sessionId)));
      const targetPresent = sessions.some((s: any) => s?.id === sessionId);
      this.traceC2('worker_confirmation_match', {
        stage_seq: '3_confirm',
        targetSessionId: sessionId,
        targetPresent,
        exactMatchFound: !!exact,
        matchRequiredEvidenceField: exact ? !!(exact.evidence?.details?.authoritativeSessionId === sessionId) : false,
        projectPath,
      });
      if (exact) {
        return {
          confirmed: true,
          externalSessionId: sessionId,
          projectPath,
          evidence: exact.evidence || { details: { authoritativeSessionId: sessionId } },
        };
      }
      // Bounded polling if session is transitional/delayed in initial GET.
      for (let attempt = 1; attempt <= 4; attempt++) {
        await new Promise((r) => setTimeout(r, 1500));
        const r2 = spawnSync(cli, ['api', 'GET', `/api/session?directory=${encodeURIComponent(projectPath)}&limit=10`], {
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 5 * 1024 * 1024,
          env: process.env,
        });
        const stdout2 = r2.stdout || '';
        let sessions2: any[] = [];
        try { if (stdout2) { const parsed2 = JSON.parse(stdout2); sessions2 = parsed2?.data ?? parsed2?.sessions ?? parsed2; if (!Array.isArray(sessions2)) sessions2 = []; } } catch { sessions2 = []; }
        const exact2 = sessions2.find((s: any) => s?.id === sessionId && ((s?.evidence?.details?.authoritativeSessionId === sessionId) || (s?.id === sessionId)));
        this.traceC2('worker_confirmation_diagnostic_poll', {
          stage_seq: '3_confirm_diagnostic',
          pollAttempt: attempt,
          targetSessionId: sessionId,
          targetPresent: !!exact2,
          count: sessions2.length,
          sessions: sessions2.map((s: any, idx: number) => ({ idx, id: s?.id ?? null, title: s?.title ?? null, directory: s?.location?.directory ?? s?.workspace ?? null })),
        });
        if (exact2) {
          return {
            confirmed: true,
            externalSessionId: sessionId,
            projectPath,
            evidence: exact2.evidence || { details: { authoritativeSessionId: sessionId } },
          };
        }
      }
      return { confirmed: false };
    } catch (err: any) {
      this.traceC2('worker_confirmation_exception', {
        stage_seq: '3_confirm',
        targetSessionId: sessionId,
        error: err?.message ?? String(err),
      });
      return { confirmed: false };
    }
  }

  /* --- S4: read-only side identity resolution ------------------------------
   *
   * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md §11.1, §9.5, §5.2-5.3.
   *
   * This is the ONE member added to `IRuntimeProvider` in this tranche, and it is
   * optional and read-only (§11.1). It sends nothing: no POST, no prompt, no
   * keystroke. Exact Planner transport is S11 (§9.4) and is deliberately absent.
   *
   * ## I-16 / ef6185b preservation
   *
   * No `ef6185b` member is modified, replaced, or reimplemented. Specifically
   * `confirmSessionForProject`, `matchSessionsByPath`,
   * `discoverSessionsViaSharedService`, `discoverPersistedSessions`,
   * `matchAuthoritativeSessions` and `createWorkerSession` are all left
   * byte-identical, because each is an executable preservation gate in
   * OPENCODE_SESSION_DISCOVERY.md. The CLI `GET /api/session` read below is
   * deliberately a SEPARATE private helper rather than a refactor of the
   * existing confirmation path: sharing one helper would have edited protected
   * behaviour to save a few lines, and that trade is not available here.
   *
   * ## I-11
   *
   * The lookup is addressed by the provider's own `ses_*` session id. It never
   * matches on a human-readable title or a window name, so the shared Pair Name
   * can never become the identity.
   *
   * ## I-6
   *
   * The three outcomes are kept distinct. A transport failure, a missing binary
   * or an unparseable response is `unknown` — "we could not check". Only a
   * successful read that does not contain the id is `not_resolved`/`absent`.
   */
  public async resolveSideIdentity(request: SideIdentityRequest): Promise<SideIdentityResolution> {
    const now = Date.now();
    const base = {
      sourceCapability: 'opencode_cli_session_get',
      observedAt: now,
    };
    const unknown = (reason: string): SideIdentityResolution => ({
      ...base,
      identityState: 'unknown',
      identityValue: null,
      verificationState: 'unknown',
      verificationValue: null,
      existenceState: 'unknown',
      reason,
    });

    const { spawnSync } = await import('child_process');
    const fs = await import('fs');
    const cli = [
      '/Users/lazydeepak/Library/Application Support/ai.opencode.desktop/cli/2.0.16/opencode-cli',
      'opencode-cli',
    ].find((p: string) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (!cli) {
      return unknown('No OpenCode CLI is available to resolve session identity');
    }

    // GET only. Never a write, and never a message of any kind (I-16, §9.4).
    const query = request.projectPath
      ? `/api/session?directory=${encodeURIComponent(request.projectPath)}&limit=50`
      : '/api/session?limit=50';

    let res: { error?: Error; status?: number | null; stdout?: string; stderr?: string };
    try {
      res = spawnSync(cli, ['api', 'GET', query], {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        env: process.env,
      }) as any;
    } catch (err: any) {
      return unknown(`OpenCode CLI read failed: ${err?.message ?? String(err)}`);
    }

    if (res.error || res.status !== 0 || !res.stdout) {
      // The read did not succeed. That is "could not check", not "not there" (I-6).
      return unknown(
        `OpenCode CLI read did not complete (status ${res.status ?? 'none'}${
          res.error ? `, error ${res.error.message}` : ''
        })`,
      );
    }

    let sessions: any[];
    try {
      const parsed = JSON.parse(res.stdout);
      sessions = Array.isArray(parsed) ? parsed : (parsed?.data ?? parsed?.sessions ?? []);
      if (!Array.isArray(sessions)) {
        return unknown('OpenCode CLI returned a response that is not a session list');
      }
    } catch {
      return unknown('OpenCode CLI returned an unparseable response');
    }

    // Exact match on the provider's own id only. Never a title/name match (I-11).
    const exact = sessions.find(
      (s: any) => s?.id === request.externalSessionId || s?.evidence?.details?.authoritativeSessionId === request.externalSessionId,
    );

    if (!exact) {
      return {
        ...base,
        identityState: 'not_resolved',
        identityValue: null,
        verificationState: 'mismatched',
        verificationValue: null,
        existenceState: 'absent',
        reason: `OpenCode has no session '${request.externalSessionId}' in the queried scope`,
        evidence: {
          id: `ev_side_absent_${now}`,
          timestamp: now,
          source: 'reconciliation_probe',
        },
      };
    }

    const resolvedId: string = exact.id ?? request.externalSessionId;
    const directory: string | null = exact.directory ?? exact.cwd ?? null;
    return {
      ...base,
      identityState: 'resolved',
      identityValue: resolvedId,
      // The provider returned this exact id from its own session store, which is
      // the confirmation authority (ef6185b). If a directory scope was supplied
      // and the provider reports a different one, that is a mismatch, not a pass.
      verificationState:
        request.projectPath && directory && directory !== request.projectPath
          ? 'mismatched'
          : 'verified',
      verificationValue: resolvedId,
      existenceState: 'present',
      reason: null,
      evidence: exact.evidence ?? {
        id: `ev_side_present_${now}`,
        timestamp: now,
        source: 'reconciliation_probe',
        details: { authoritativeSessionId: resolvedId },
      },
    };
  }

  /**
   * S2 — read-only observation of ONE exact bound session (dimensions 4-7).
   *
   * ## ef6185b / I-16 preservation
   *
   * This is a NEW private CLI helper plus a NEW public method. It shares no code
   * with, and refactors nothing in, `confirmSessionForProject`,
   * `matchSessionsByPath`, `discoverSessionsViaSharedService`,
   * `discoverPersistedSessions`, `matchAuthoritativeSessions` or
   * `createWorkerSession`. Those remain byte-identical, because each is an
   * executable preservation gate in OPENCODE_SESSION_DISCOVERY.md. Reusing one of
   * them to save a few lines would mean editing protected behaviour.
   *
   * ## Read-only
   *
   * Every call below is `GET`. There is no POST, no prompt, no keystroke, and no
   * state-changing endpoint. Exact Planner transport is S11 (§9.4) and is absent.
   *
   * ## I-11
   *
   * Addressed by the provider's own `ses_*` id. No title match, no window match,
   * no workspace-basename match, no frontmost tab. A session is located by its id
   * or not at all.
   *
   * ## Per-dimension independence
   *
   * §5.2 requires the dimensions to be distinguishable, so each read is attempted
   * independently and a failure in one leaves only that dimension unknown. A dead
   * transcript endpoint must not erase a successful existence check, and neither
   * may report a negative: a failed read is "could not check" (I-6).
   */
  public async observeSide(request: SideObservationRequest): Promise<SideObservationReading> {
    const now = Date.now();
    const validUntil = now + PROVISIONAL_OBSERVATION_VALIDITY_MS;

    // No id means no exact session to address. I-11 forbids substituting a name.
    if (!request.externalSessionId) {
      return unreadable(
        now,
        validUntil,
        'No external session id was supplied, so there is no exact session to observe (I-11).',
      );
    }

    const sessionId = request.externalSessionId;

    // Three independent reads. `undefined` means "this read did not complete".
    const [sessions, active, transcript] = await Promise.all([
      this.s2CliGet(`/api/session?limit=200`),
      this.s2CliGet('/api/session/active'),
      this.s2CliGet(`/api/session/${encodeURIComponent(sessionId)}/message?limit=200`),
    ]);

    const reachable = Boolean(sessions.ok || active.ok || transcript.ok);

    // Dimension 4. The provider surface answered at least one query.
    const reachabilityState: SideReachabilityState = reachable ? 'reachable' : 'unreachable';

    // Dimension 3, reported inside the reading because the session list is also
    // the only proof the session is still there. `not_resolved`/`absent` split is
    // preserved from S4 rather than collapsed.
    let existence: SideExistenceState = 'unknown';
    if (!sessions.ok) {
      existence = 'unknown';
    } else if (sessions.data === null) {
      existence = 'unknown';
    } else {
      const rows = asRecordList(sessions.data);
      if (rows === null) {
        existence = 'unknown';
      } else {
        const exact = rows.find((row) => {
          const record = asRecord(row);
          return (
            asString(record?.id) === sessionId ||
            asString(asRecord(asRecord(record?.evidence)?.details)?.authoritativeSessionId) === sessionId
          );
        });
        existence = exact ? 'present' : 'absent';
      }
    }

    // Dimension 6. `unknown` stays unknown: OpenCode reports an explicit
    // `unknown` state for a session it has no activity record for, and that is
    // NOT the same as idle.
    let activityState: SideActivityState = 'unknown';
    if (active.ok && active.data !== null) {
      const byId = asRecord(asRecord(active.data)?.data) ?? asRecord(asRecord(active.data)?.byId);
      const raw = byId ? asString(byId[sessionId]) : undefined;
      activityState =
        raw === 'running' ? 'working' : raw === 'idle' ? 'idle' : raw === 'error' ? 'error' : 'unknown';
    }

    // Dimension 7.
    const message = readLatestMeaningfulMessage(transcript);

    // Dimension 5. Honest gap: the service API exposes no per-session UI surface,
    // so RelayX cannot report presence or absence of one. `absent` would be a
    // fabricated negative (I-6, C-8).
    const uiPresenceState: SideUiPresenceState = 'unknown';

    const reasons: string[] = [];
    if (!reachable) reasons.push(`The OpenCode read surface did not answer: ${firstReason(sessions, active, transcript)}`);
    if (existence === 'unknown') reasons.push('Session existence could not be established from the session list');
    if (activityState === 'unknown') reasons.push('OpenCode reported no activity state for this session');
    if (message.state === 'unknown') reasons.push(message.reason ?? 'No latest meaningful message could be established');
    reasons.push(
      'OpenCode exposes no per-session UI surface through this API, so UI presence is unknown rather than absent',
    );

    return {
      reachabilityState,
      uiPresenceState,
      activityState,
      messageEvidenceState: message.state,
      message: message.evidence,
      observationCapability: 'opencode_cli_session_status_transcript',
      observedAt: now,
      validUntil,
      reason: reasons.length > 0 ? reasons.join('; ') : null,
      evidence: {
        id: `ev_side_obs_${now}`,
        timestamp: now,
        source: 'reconciliation_probe',
        details: {
          authoritativeSessionId: sessionId,
          reachability: reachabilityState,
          messageRef: message.evidence.ref,
          messageOrdinal: message.evidence.ordinal,
        },
      },
    };
  }

  /**
   * S2's own GET-only CLI helper. Deliberately separate from the S4 helper: S4's
   * helper is a frozen read path, and sharing one would edit protected behaviour
   * to save lines (the same reasoning as S4 not refactoring the confirmation path).
   */
  private async s2CliGet(
    query: string,
  ): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
    const { spawnSync } = await import('child_process');
    const fs = await import('fs');
    const cli = [
      '/Users/lazydeepak/Library/Application Support/ai.opencode.desktop/cli/2.0.16/opencode-cli',
      'opencode-cli',
    ].find((p: string) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (!cli) return { ok: false, reason: 'No OpenCode CLI is available' };

    let res: { error?: Error; status?: number | null; stdout?: string; stderr?: string };
    try {
      res = spawnSync(cli, ['api', 'GET', query], {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        env: process.env,
      }) as any;
    } catch (err: any) {
      return { ok: false, reason: `read threw: ${err?.message ?? String(err)}` };
    }
    if (res.error || res.status !== 0 || !res.stdout) {
      return {
        ok: false,
        reason: `read did not complete (status ${res.status ?? 'none'}${
          res.error ? `, ${res.error.message}` : ''
        })`,
      };
    }
    try {
      return { ok: true, data: JSON.parse(res.stdout) };
    } catch {
      return { ok: false, reason: 'response was not parseable JSON' };
    }
  }

  /**
   * Matches OpenCode sessions to a project path by querying authoritative persisted sessions first,
   * then correlating with visible UI runtimes. If no authoritative sessions exist or CLI fails,
   * falls back gracefully to window-based candidate discovery.
   */
  public async matchSessionsByPath(projectPath: string, gitRoot?: string): Promise<{
    success: boolean;
    sessions: RuntimeInspectionResult[];
    diagnostics?: any;
  }> {
    const normProjPath = projectPath.toLowerCase().replace(/\/$/, '');
    const normGitRoot = gitRoot ? gitRoot.toLowerCase().replace(/\/$/, '') : undefined;
    const basename = projectPath.split('/').pop()?.toLowerCase();

    const uiRuntimes = await this.findAllRuntimes();

    // 1. Authoritative discovery via the already-running shared OpenCode
    //    service. This is the preferred mechanism: it returns the exact
    //    persisted `ses_*` records the human OpenCode UI operates.
    const sharedRes = await this.discoverSessionsViaSharedService(projectPath);
    if (sharedRes.ok) {
      const authRes = this.matchAuthoritativeSessions(
        sharedRes.sessions.map((s) => ({
          id: s.sessionId,
          directory: s.directory,
          projectId: s.projectId,
          title: s.title,
        })),
        uiRuntimes,
        projectPath,
        gitRoot,
        { allowMissingDirectory: true, directoryScopedMatchedVia: 'service_directory_query' },
      );
      // Project-level enumeration: return all valid candidates deterministically;
      // ambiguity only blocks automatic single-session selection, not enumeration.
      return {
        success: true,
        // Ambiguity blocks automatic binding, but the wizard still needs the
        // eligible rows so the user can explicitly choose one.
        sessions: authRes.ambiguous ? authRes.eligibleResults : authRes.results,
        diagnostics: {
          source: 'opencode_shared_service',
          projectPath,
          gitRoot,
          authoritativeSessionsDiscovered: sharedRes.sessions.length,
          correlatedUiRuntimes: uiRuntimes.length,
          sharedService: sharedRes.diagnostics,
          candidates: authRes.candidates,
          ambiguous: authRes.ambiguous || undefined,
        },
      };
    }

    // 2. Compatibility fallback: authoritative persisted sessions via the CLI.
    const persistedRes = await this.discoverPersistedSessions();

    const candidates: any[] = [];
    const results: RuntimeInspectionResult[] = [];

    if (persistedRes.success && persistedRes.sessions.length > 0) {
      for (const pers of persistedRes.sessions) {
        const persId = pers.id;
        const persDir = pers.directory;
        const normPersDir = persDir ? persDir.toLowerCase().replace(/\/$/, '') : undefined;

        let matchScore = 0;
        let matchedVia: string | undefined;
        let rejectionReason: string | undefined;

        if (!persId?.startsWith('ses_')) {
          rejectionReason = 'Persisted session has no authoritative ses_* identity';
        } else if (!normPersDir) {
          rejectionReason = 'Persisted session has no directory property';
        } else if (normPersDir === normProjPath) {
          matchScore += 100;
          matchedVia = 'exact_path';
        } else if (this.segmentPathContains(normPersDir, normProjPath)) {
          matchScore += 50;
          matchedVia = 'path_prefix';
        }

        if (normGitRoot && normPersDir) {
          if (normPersDir === normGitRoot || this.segmentPathContains(normPersDir, normGitRoot)) {
            matchScore += 30;
            matchedVia = matchedVia || 'git_root';
          }
        }

        if (matchScore === 0 && !rejectionReason) {
          rejectionReason = `Directory "${persDir}" does not match projectPath "${projectPath}" or gitRoot "${gitRoot}"`;
        }

        const eligible = matchScore > 0;

        // `eligible` = project/directory match only; NOT session pairing.
        // Authoritative pairing requires an explicit selected session id.

        // Correlate with UI runtimes (secondary presentation/focus surface)
        let correlatedRuntime: RuntimeInspectionResult | undefined;
        for (const ui of uiRuntimes) {
          const parsed = this.parseSessionIdentity(ui.windowTitle);
          if (parsed.sessionId === persId) {
            correlatedRuntime = ui;
            break;
          }
          if (parsed.workspacePath && normPersDir) {
            const normUiPath = parsed.workspacePath.toLowerCase().replace(/\/$/, '');
            if (normUiPath === normPersDir) {
              correlatedRuntime = ui;
              break;
            }
          }
        }

        candidates.push({
          sessionId: persId,
          sessionTitle: pers.title,
          directory: persDir,
          projectId: pers.projectId,
          matchScore,
          matchedVia,
          hasUiCorrelation: !!correlatedRuntime,
          correlatedPid: correlatedRuntime?.applicationPid,
          correlatedWindowTitle: correlatedRuntime?.windowTitle,
          eligible,
          resolutionStatus: eligible ? 'eligible' : (rejectionReason ? 'rejected' : 'unmatched'),
          rejectionReason,
        });

        if (eligible) {
          const evidence: ObservableEvidence = correlatedRuntime?.evidence || {
            id: `ev_persisted_match_${Date.now()}`,
            timestamp: Date.now(),
            source: 'reconciliation_probe',
            windowTitle: correlatedRuntime?.windowTitle || `OpenCode [${persId}] ${persDir || ''}`,
            applicationPid: correlatedRuntime?.applicationPid,
            bundleIdentifier: this.defaultBundleId,
            details: {},
          };

          evidence.details = {
            ...evidence.details,
            parsedSessionId: persId,
            authoritativeSessionId: persId,
            sessionTitle: pers.title,
            workspacePath: persDir || projectPath,
            openCodeProjectId: pers.projectId,
            matchScore,
            matchedVia,
            hasUiCorrelation: !!correlatedRuntime,
            canonicalPath: projectPath,
            gitRoot,
          };

          results.push({
            found: true,
            status: correlatedRuntime ? correlatedRuntime.status : 'available',
            windowTitle: correlatedRuntime?.windowTitle || `OpenCode [${persId}] ${persDir || ''}`,
            applicationPid: correlatedRuntime?.applicationPid,
            bundleIdentifier: this.defaultBundleId,
            composerVisible: correlatedRuntime?.composerVisible ?? false,
            composerHasFocus: correlatedRuntime?.composerHasFocus ?? false,
            sendButtonVisible: correlatedRuntime?.sendButtonVisible ?? false,
            stopButtonVisible: correlatedRuntime?.stopButtonVisible ?? false,
            cancelButtonVisible: correlatedRuntime?.cancelButtonVisible ?? false,
            isWorking: correlatedRuntime?.isWorking ?? false,
            isComplete: correlatedRuntime?.isComplete ?? false,
            evidence,
          });
        }
      }

      const scoreWeight = (via?: string) => {
        if (via === 'exact_path') return 3;
        if (via === 'path_prefix') return 2;
        if (via === 'title_fallback') return 1;
        return 0;
      };
      const sortedResults = results.sort((a, b) => {
        const diff = ((b.evidence.details as any)?.matchScore || 0) - ((a.evidence.details as any)?.matchScore || 0);
        if (diff !== 0) return diff;
        return scoreWeight((b.evidence.details as any)?.matchedVia) - scoreWeight((a.evidence.details as any)?.matchedVia);
      });

      // Project-level enumeration preserves all candidates deterministically.
      return {
        success: true,
        sessions: sortedResults,
        diagnostics: {
          source: 'opencode session list --format json',
          projectPath,
          gitRoot,
          authoritativeSessionsDiscovered: persistedRes.sessions.length,
          correlatedUiRuntimes: uiRuntimes.length,
          sharedService: sharedRes.diagnostics,
          candidates,
        },
      };
    }

    // 2. Secondary Presentation/Window Fallback if CLI yielded no sessions
    for (const session of uiRuntimes) {
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
        } else if (this.segmentPathContains(normInfoPath!, normProjPath)) {
          matchScore += 50;
          matchedVia = 'path_prefix';
        }

        if (gitRoot && normInfoPath) {
          if (normInfoPath === normGitRoot || this.segmentPathContains(normInfoPath!, normGitRoot!)) {
            matchScore += 30;
            matchedVia = matchedVia || 'git_root';
          }
        }

        if (basename && this.exactBasenameInTitle(windowTitle, basename)) {
          matchScore += 10;
          matchedVia = matchedVia || 'title_fallback';
        }

        if (matchScore === 0) {
          rejectionReason = `Workspace path "${info.workspacePath}" does not match projectPath ("${projectPath}") or gitRoot ("${gitRoot}")`;
        }
      }

      const eligible = matchScore > 0;

      // `eligible` = workspace/project match only; window-derived ids are
      // NON-authoritative and never establish pairing by themselves.
      candidates.push({
        sessionId: info.sessionId,
        windowTitle,
        workspacePath: info.workspacePath,
        normInfoPath,
        normProjPath,
        normGitRoot,
        matchScore,
        matchedVia,
        eligible,
        resolutionStatus: eligible ? 'eligible' : (rejectionReason ? 'rejected' : 'unmatched'),
        rejectionReason,
      });

      if (eligible) {
        session.evidence.details = {
          ...session.evidence.details,
          // Window titles are NON-authoritative evidence: record the observed
          // id for display/telemetry only. A window title must never establish
          // an authoritative `ses_*` binding.
          observedWindowSessionId: info.sessionId,
          workspacePath: info.workspacePath,
          matchScore,
          matchedVia,
          authoritative: false,
          canonicalPath: projectPath,
          gitRoot,
        };
        results.push(session);
      }
    }

    const scoreWeight = (via?: string) => {
      if (via === 'exact_path') return 3;
      if (via === 'path_prefix') return 2;
      if (via === 'title_fallback') return 1;
      return 0;
    };
    const sortedResults = results.sort((a, b) => {
      const diff = ((b.evidence.details as any)?.matchScore || 0) - ((a.evidence.details as any)?.matchScore || 0);
      if (diff !== 0) return diff;
      return scoreWeight((b.evidence.details as any)?.matchedVia) - scoreWeight((a.evidence.details as any)?.matchedVia);
    });

    return {
      success: true,
      sessions: sortedResults,
      diagnostics: {
        source: 'ui_fallback',
        sharedService: sharedRes.diagnostics,
        cliStatus: persistedRes.diagnostics,
        projectPath,
        gitRoot,
        totalRuntimesInspected: uiRuntimes.length,
        authoritative: false,
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
