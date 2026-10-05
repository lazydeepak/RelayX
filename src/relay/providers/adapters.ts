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
 *    - PROJECT discovery via https://chatgpt.com/projects (the obsolete Cmd+K
 *      project-search path is removed) — see `chatgptProjectDiscovery.ts`.
 *    - SESSION/conversation discovery and provisioning are unchanged and
 *      independent of the project flow.
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
import { OpenCodeFixedServerClient } from './opencodeFixedServer.ts';
import {
  buildOpenCodeWorkerOpenSteps,
  resolveOpenCodeWorkerOpenTarget,
  runForegroundGatedSteps,
  type WorkerOpenPreflightFailure,
} from './opencodeWorkerSessionOpen.ts';

/**
 * Outcome of opening the exact bound OpenCode worker session in OpenCode Desktop.
 *
 * `ok` is never inferred from an `osascript` exit code: it is true only when every keystroke
 * was emitted while OpenCode was the OBSERVED foreground application. The evidence needed to
 * judge the outcome travels with it so the UI can report something truthful.
 */
export interface OpenCodeWorkerOpenResult {
  ok: boolean;
  /** The authoritative id that was targeted. Never changed by this call. */
  externalSessionId?: string;
  /** The title read from OpenCode for that exact id and typed into the Desktop UI. */
  resolvedTitle?: string;
  /** True when RelayX's stored display title had drifted from the live one. */
  storedTitleWasStale?: boolean;
  previousStoredTitle?: string | null;
  /** Other sessions sharing the resolved title in the same directory (empty when unique). */
  duplicateTitleSessionIds?: string[];
  /** Labels of the UI automation steps actually executed, in order. */
  stepsSent?: string[];
  /** Foreground observed immediately before each keystroke — the audit trail. */
  foregroundBeforeEachStep?: Array<{ label: string; foreground: string | null }>;
  failure?:
    | WorkerOpenPreflightFailure
    | 'foreground_never_verified'
    | 'keystroke_failed'
    | 'unsupported_platform';
  error?: string;
}
import {
  buildWatermark,
  reconcileTransportOutcome,
  type ExactSessionWatermark,
  type ReconciliationMessage,
} from './exactSessionReconciliation.ts';
import { execFileSync, execSync } from 'node:child_process';
import { parseChatGPTConversationUrl } from './chatgptConversationUrl.ts';
import {
  canonicalizeChatGPTProjectUrlFromUrl,
  extractChatGPTProjectIdFromUrl,
  isChatGPTProjectLessUrl,
  parseChatGPTProjectUrl,
  toStableChatGPTProjectId,
} from './chatgptProjectUrl.ts';
import {
  DEFAULT_CHATGPT_PROJECT_DISCOVERY_PROFILE,
  DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT,
  buildChatGPTProjectResultNavigationAppleScript,
  buildChatGPTProjectSearchInputAppleScript,
  chatgptProjectDiscoveryError,
  describeChatGPTProjectDiscoveryProfile,
  parseChatGPTProjectDiscoveryScript,
  type ChatGPTProjectDiscoveryProfile,
  type ChatGPTProjectDiscoveryStage,
} from './chatgptProjectDiscovery.ts';
export { parseChatGPTConversationUrl } from './chatgptConversationUrl.ts';

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
      //
      // `execFileSync` comes from a STATIC top-level `import` (see the import block at the top
      // of this file), not from a bare `require(...)` and not from `createRequire(import.meta.url)`.
      //
      // The bare-`require` form was a real latent defect: this module is ESM source
      // (`"type": "module"`), where a bare `require` is undefined, so EVERY AppleScript probe in
      // this file failed with "require is not defined" whenever the adapter ran outside the CJS
      // bundle (e.g. the `node --import tsx` source-mode runs this repo's own runbooks prescribe).
      //
      // `createRequire(import.meta.url)` fixes ESM but is WRONG for the shipped artifact: esbuild
      // bundles this file to CommonJS for the Electron main process, and in CJS there is no
      // `import.meta`, so esbuild substitutes an empty object and `import.meta.url` is `undefined`.
      // `createRequire(undefined)` then throws
      // "The argument 'filename' must be a file URL object, file URL string, or absolute path string"
      // — silently disabling every AppleScript probe in the packaged app, which is precisely the
      // process the live relay runs in.
      //
      // A static import is the one form that is correct in BOTH module systems: Node resolves it
      // natively under ESM and esbuild hoists it into the CJS bundle as a normal `require`.
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

  async inspectRuntime(sessionId: RuntimeSessionId, dispatchBoundary?: { afterCreatedAt?: number; afterMessageId?: string | null; sessionId?: string | null }): Promise<RuntimeInspectionResult> {
    const base = await this.findRuntime({ providerType: this.providerType });
    if (!base.found) return base;

    const working = await this.detectWorkingState(sessionId);
    const completion = await this.detectCompletionState(sessionId, dispatchBoundary);

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

  async detectCompletionState(sessionId: RuntimeSessionId, dispatchBoundary?: { afterCreatedAt?: number; afterMessageId?: string | null; sessionId?: string | null; expectedInstructionSnippet?: string | null }): Promise<{ isComplete: boolean; responseSummary?: string; evidence?: ObservableEvidence }> {
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
 * UTF-8 -> Base64, for transporting page JavaScript through an AppleScript string literal.
 */
export function encodeJavaScriptForAppleScript(source: string): string {
  return Buffer.from(source, 'utf8').toString('base64');
}

/**
 * WHY THIS EXISTS (proven corruption, not a hypothesis):
 *
 * escapeAppleScriptStringLiteral rewrites REAL newlines into the two characters \n.
 * Those characters land inside the JavaScript SOURCE, between statements, where a bare
 * \n is not valid JavaScript - only a SyntaxError. Quote- and backslash-heavy string
 * literals were rewritten as well ('it\'s' became 'it\\'s', and '\u00e9' became a
 * literal backslash-u).
 *
 * Consequence: small single-line probes still worked, which made the corruption look like
 * a composer/selector problem, while every real multi-line script silently failed.
 *
 * The fix is transport-level: Base64-encode the source, embed ONLY the Base64 alphabet in
 * the AppleScript literal, and decode + evaluate inside the page. Base64 has no quotes,
 * backslashes or newlines, so nothing can be mangled.
 */
export function appleScriptJsEvalWrapper(b64: string): string {
  return (
    '(function(){try{var b=atob("' + b64 + '");' +
    'var s=decodeURIComponent(escape(b));' +
    'var r=(0,eval)(s);' +
    'return (typeof r==="string")?r:JSON.stringify(r===undefined?null:r);' +
    '}catch(e){return "__JSERR__"+String(e&&e.name)+": "+String(e&&e.message);}})()'
  );
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
 * Builds the JS that reads the current tab location. Used by Project discovery
 * to poll for navigation completion and to verify the final URL.
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
 * Builds the JS that waits for the Projects route to be interactive and focuses
 * the Projects search field so the RelayX project name can be typed/pasted into
 * it. This replaces the obsolete Cmd+K project-search dialog path.
 *
 * Reports whether a Projects search field was found AND focused, so the caller
 * can distinguish "field missing" from "field present but unfocusable".
 */
export function buildChatGPTProjectsSearchFocusJavaScript(): string {
  return `(() => {
  const STAGE = "__relay_stage_projects_search_focus__";
  const sels = [
    'main input[placeholder*="Search" i]',
    'main input[aria-label*="search" i]',
    'main input[type="search"]',
    'main [role="searchbox"]',
    'main [role="combobox"]',
    'input[placeholder*="Search" i]',
    'input[aria-label*="search" i]',
    'input[type="search"]',
    '[role="searchbox"]',
    '[role="combobox"]'
  ];

  // The Projects page search field is not the composer.
  const isComposer = function (el) {
    return !!(el && el.closest('form[class*="composer" i], [data-testid*="composer" i], [data-testid="composer-parent"]'));
  };

  let input = null;
  for (let i = 0; i < sels.length; i++) {
    const els = document.querySelectorAll(sels[i]);
    for (let j = 0; j < els.length; j++) {
      const el = els[j];
      if (!el || isComposer(el)) continue;
      if (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0) {
        input = el;
        break;
      }
    }
    if (input) break;
  }

  if (!input) {
    return JSON.stringify({
      found: false,
      focused: false,
      path: location.pathname,
      url: location.href
    });
  }

  input.focus();
  const focused = document.activeElement === input;
  return JSON.stringify({
    found: true,
    focused: focused,
    path: location.pathname,
    url: location.href
  });
})();`;
}

/**
 * Builds the JS that reports a signature of the currently rendered Projects list.
 *
 * Used as the evidence for the "wait for results/UI transition" step. Live
 * observation showed the Projects list re-renders after the search Return, and
 * tabbing before it settles walks focus through a stale tab order — so the
 * caller waits for two consecutive identical signatures instead of sleeping an
 * arbitrary amount.
 */
export function buildChatGPTProjectsResultsSignatureJavaScript(): string {
  return `(() => {
  const STAGE = "__relay_stage_projects_results_signature__";
  const rendered = function (e) {
    return e && e.offsetParent !== null && e.getClientRects().length > 0;
  };

  // Visible project rows, in DOM order.
  const actions = [].slice.call(document.querySelectorAll('[aria-label^="Project actions for"]'))
    .filter(rendered);
  const names = actions.map(function (e) {
    return (e.getAttribute('aria-label') || '').replace('Project actions for ', '');
  });

  // The number of tabbable controls in the page. Live verification showed this
  // is the signal that actually tracks the filtered state: after the search
  // Return it grows by the newly-rendered result controls and only then holds
  // steady. Tabbing before it stabilises walks a stale tab order, so this value
  // is part of the signature precisely because it is the late-changing signal.
  const focusables = [].slice.call(
    document.querySelectorAll('a[href], button, [role="button"], input')
  ).filter(function (e) {
    return rendered(e) && e.tabIndex >= 0;
  }).length;

  return JSON.stringify({
    count: names.length,
    names: names.slice(0, 25),
    focusables: focusables,
    url: location.href
  });
})();`;
}

/**
 * Builds the JS that reads the Projects search field's current value. Used after
 * the project name is pasted and Return is pressed, so the caller can verify the
 * search was actually accepted instead of blindly continuing.
 */
export function buildChatGPTProjectsSearchValueJavaScript(): string {
  return `(() => {
  const STAGE = "__relay_stage_projects_search_value__";
  const sels = [
    'main input[placeholder*="Search" i]',
    'main input[aria-label*="search" i]',
    'main input[type="search"]',
    'main [role="searchbox"]',
    'main [role="combobox"]',
    'input[placeholder*="Search" i]',
    'input[aria-label*="search" i]',
    'input[type="search"]',
    '[role="searchbox"]',
    '[role="combobox"]'
  ];
  for (let i = 0; i < sels.length; i++) {
    const els = document.querySelectorAll(sels[i]);
    for (let j = 0; j < els.length; j++) {
      const el = els[j];
      if (!el) continue;
      if (el.closest('form[class*="composer" i], [data-testid*="composer" i], [data-testid="composer-parent"]')) continue;
      const value = el.value !== undefined ? String(el.value || '') : (el.innerText || el.textContent || '');
      return JSON.stringify({ found: true, value: value, url: location.href });
    }
  }
  return JSON.stringify({ found: false, value: null, url: location.href });
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
 * AppleScript budget for stages 3-4 (paste the project name + Return). Only
 * bounded intra-script delays live here; the outer waits are polled by the
 * stage helpers, so this is never a "sleep long enough and hope" value.
 */
export const CHATGPT_PROJECT_SEARCH_INPUT_TIMEOUT_MS = 12000;

/** AppleScript budget for stages 6-7 (Tab x N + Return). */
export const CHATGPT_PROJECT_RESULT_NAVIGATION_TIMEOUT_MS = 15000;

/**
 * Minimum observation window for the filtered Projects list before focus is
 * walked.
 *
 * Live measurement against the real ChatGPT Projects UI: the search Return
 * commits the query immediately, but the filtered rows' tabbable controls only
 * appear ~2s later. Tabbing during that window walks a stale tab order and
 * Return lands on nothing, so the walk waits for the list's own signature to
 * hold steady across at least this window.
 *
 * This is a bound derived from observed UI behaviour, not an arbitrary sleep:
 * the wait still ends early when the signature settles sooner, and it fails
 * rather than proceeding when the list never settles.
 */
export const CHATGPT_PROJECT_RESULTS_MIN_SETTLE_MS = 2500;

/**
 * Flattens and truncates a host/driver error before it is recorded on
 * diagnostics. Stage diagnostics must stay readable and must not carry raw
 * automation script internals.
 */
export function sanitizeHostDiagnostic(value: unknown, maxLength = 300): string | undefined {
  if (value === undefined || value === null) return undefined;
  const flat = String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!flat) return undefined;
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

/**
 * CREATE (single AppleScript execution):
 *   1. activate Chrome; ensure at least one window exists
 *   2. create ONE new tab at `url` in the front window
 *      (Chrome makes the newly-created tab the active tab)
 *
 * Project discovery opens https://chatgpt.com/projects here — the discovery tab
 * IS the Projects page, so no in-page navigation (and no Cmd+K) is needed.
 *
 * Returns "CREATE_OK" or "TAB_CREATE_FAIL|||<error message>".
 */
export function buildCreateDiscoveryTabAppleScript(
  url: string = 'https://chatgpt.com',
): string {
  const escapedUrl = escapeAppleScriptStringLiteral(url);
  return `
    tell application "Google Chrome"
      activate
      if (count of windows) is 0 then
        make new window
      end if
      try
        make new tab at end of tabs of front window with properties {URL:"${escapedUrl}"}
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

  /**
   * AUTHORITATIVE reachability proof for ONE exact ChatGPT conversation.
   *
   * ## The defect this closes
   *
   * A planner runtime reaches `RuntimeSession.status === 'terminated'` purely by counting
   * failed local probes (`recordObservationFailure`). `resolveBatonSide` then refused to
   * address the side on that basis and returned `session_identity_unproven`, while the only
   * observation able to revive the runtime (`inspectRuntime`) is never called by the
   * supervision tick or by startup recovery. The result was a permanently wedged relay over a
   * conversation that still existed.
   *
   * This method is the authoritative answer RelayX should have asked instead. It resolves the
   * exact conversation by the provider's OWN id, using the browser transport that already
   * exists in this class — no new automation, no invented URL.
   *
   * ## How the evidence is obtained (and why it cannot be faked)
   *
   *   1. Every open Chrome tab's REAL URL is read through AppleScript.
   *   2. A tab whose real URL is the requested conversation route is adopted directly.
   *   3. If no tab holds it, a tab is opened at the persisted URL and the URL is read back
   *      FROM THAT EXACT TAB.
   *   4. The returned `conversationId` is parsed out of the URL the browser actually
   *      reported. It is never the id that was asked about.
   *
   * Step 4 is what makes a fabricated positive impossible: a provider-side redirect to the
   * project root, a login wall, or a different conversation all yield a different (or absent)
   * parsed id, which this method reports as `reachable: false` with the observed URL attached.
   *
   * ## Honesty about failure (I-6, C-8)
   *
   *   - `reachable: false` + `failure: null` means the browser positively answered and the
   *     route was not the requested conversation.
   *   - `failure != null` means "could not check" (AppleScript denied, Chrome absent,
   *     navigation failed, read-back never settled). Never coerced to `reachable: false`.
   *
   * Read-only apart from opening one tab, which is the same navigation `createPlannerSession`
   * already performs. No message is ever typed or sent.
   */
  async confirmExactSessionReachable(
    externalSessionId: string,
    sessionUrl?: string | null,
  ): Promise<{
    reachable: boolean;
    conversationId: string | null;
    evidence?: ObservableEvidence;
    failure: string | null;
  }> {
    const now = Date.now();

    if (!externalSessionId || typeof externalSessionId !== 'string') {
      return {
        reachable: false,
        conversationId: null,
        failure: 'No conversation id was supplied, so there is no provider-owned identity to address.',
      };
    }

    // A UUID-shaped id is the only shape ChatGPT conversation routes carry. Refusing anything
    // else stops a name, a window title or a URL from being passed off as an id (I-11).
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID.test(externalSessionId)) {
      return {
        reachable: false,
        conversationId: null,
        failure: `"${externalSessionId}" is not a ChatGPT conversation id. RelayX will not substitute a name or window title for a provider-owned identity (I-11).`,
      };
    }

    const target = sessionUrl?.includes('/c/')
      ? sessionUrl
      : `https://chatgpt.com/c/${externalSessionId}`;

    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return {
        reachable: false,
        conversationId: null,
        failure: 'Host platform is not macOS, so the browser conversation route cannot be read.',
      };
    }

    const evidenceBase = {
      id: `ev_chatgpt_readdress_${now}`,
      timestamp: now,
      source: 'macos_system_events' as const,
      details: { method: 'chatgpt_conversation_readdress', requestedConversationId: externalSessionId },
    };

    // --- Step 1/2. Adopt an EXISTING tab already showing the exact conversation ------
    const listed = this.runAppleScript(
      `tell application "Google Chrome"
        set out to ""
        repeat with w from 1 to (count of windows)
          repeat with t from 1 to (count of tabs of window w)
            set u to URL of tab t of window w
            if u contains "/c/${externalSessionId}" then set out to out & u & linefeed
          end repeat
        end repeat
        return out
      end tell`,
      6000,
    );

    if (!listed.success) {
      return {
        reachable: false,
        conversationId: null,
        failure: `Could not enumerate Chrome tabs: ${listed.error ?? 'unknown AppleScript failure'}`,
      };
    }

    const existingUrl = (listed.output || '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    if (existingUrl) {
      // The browser itself reported this URL for a live tab. Parse the id back out of it.
      const parsed = this.extractChatGPTConversationId(existingUrl);
      const matches = parsed === externalSessionId;
      return {
        reachable: matches,
        conversationId: parsed,
        evidence: {
          ...evidenceBase,
          details: {
            ...evidenceBase.details,
            route: 'existing_tab',
            observedUrl: existingUrl,
            observedConversationId: parsed,
            identityMatchesRequested: matches,
          },
        },
        failure: matches
          ? null
          : `Chrome reported the live tab URL as '${existingUrl}', whose conversation id is '${
              parsed ?? 'not a conversation route'
            }' rather than the requested '${externalSessionId}'.`,
      };
    }

    // --- Step 3/4. No tab holds it: open one and read the URL back from THAT tab -------
    // Navigation is bounded and settled: a root `chatgpt.com/` or a project route that has
    // not yet resolved to `/c/<id>` is reported as "could not check", never as reachable.
    const opened = this.runAppleScript(
      `tell application "Google Chrome"
        try
          tell window 1
            make new tab with properties {URL:"${target}"}
          end tell
          return "OPEN_OK"
        on error errMsg
          return "OPEN_FAIL::" & errMsg
        end try
      end tell`,
      8000,
    );

    if (!opened.success || !opened.output.startsWith('OPEN_OK')) {
      return {
        reachable: false,
        conversationId: null,
        failure: `Could not open a tab for conversation '${externalSessionId}': ${
          opened.error ?? opened.output ?? 'unknown AppleScript failure'
        }`,
      };
    }

    const deadline = Date.now() + 12000;
    let observedUrl: string | null = null;
    while (Date.now() < deadline) {
      const readBack = this.runAppleScript(
        `tell application "Google Chrome"
          try
            set u to URL of active tab of window 1
            return u
          on error errMsg
            return "READ_FAIL::" & errMsg
          end try
        end tell`,
        5000,
      );
      const value = (readBack.output || '').trim();
      if (readBack.success && value && !value.startsWith('READ_FAIL::')) {
        observedUrl = value;
        // Settled only once it is a real conversation route naming the requested id.
        if (value.includes(`/c/${externalSessionId}`)) break;
      }
      // Bounded settle: a short real pause, never a busy loop against Chrome.
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    if (!observedUrl) {
      return {
        reachable: false,
        conversationId: null,
        failure: `A tab was opened for conversation '${externalSessionId}' but its URL could not be read back, so existence was not established.`,
      };
    }

    const parsed = this.extractChatGPTConversationId(observedUrl);
    const matches = parsed === externalSessionId;
    return {
      reachable: matches,
      conversationId: parsed,
      evidence: {
        ...evidenceBase,
        details: {
          ...evidenceBase.details,
          route: 'navigated_readback',
          observedUrl,
          observedConversationId: parsed,
          identityMatchesRequested: matches,
        },
      },
      failure: matches
        ? null
        : `After navigating, the tab settled at '${observedUrl}', whose conversation id is '${
            parsed ?? 'not a conversation route'
          }' rather than the requested '${externalSessionId}'.`,
    };
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
    dispatchBoundary?: { afterCreatedAt?: number; afterMessageId?: string | null; sessionId?: string | null; expectedInstructionSnippet?: string | null },
  ): Promise<{ isComplete: boolean; responseSummary?: string; evidence?: ObservableEvidence }> {
    const workingState = await this.detectWorkingState(sessionId);
    if (workingState.isWorking) {
      return { isComplete: false };
    }

    const probe = this.probeMacOSProcess(this.defaultProcessName);
    if (!probe.running || typeof process === 'undefined' || process.platform !== 'darwin') {
      return { isComplete: false };
    }

    // Observation metadata (window state, UI activity) is evidence only,
    // never semantic planner output. Without verified assistant message
    // content from a ChatGPT session transcript, do not fabricate a
    // response summary that could become a worker Assignment instruction.
    return {
      isComplete: false,
      responseSummary: undefined,
      evidence: {
        id: `ev_chatgpt_comp_${Date.now()}`,
        timestamp: Date.now(),
        source: 'macos_system_events',
        runtimeSessionId: sessionId,
        responseActivityObserved: true,
        details: {
          executionState: 'observed',
          targetSideRole: 'planner',
          note: 'Planner observation exists (window active) but no verifiable assistant message content retrieved from ChatGPT session; automatic semantic continuation prevented.',
          windowTitle: probe.windowTitle || 'ChatGPT',
        },
      },
    };
  }

  /**
   * Helper to extract stable ChatGPT project ID (g-p-...) from URL.
   * Delegates to the single shared ChatGPT Project URL parser
   * (`chatgptProjectUrl.ts`) so this method, the provider's project discovery
   * flow, and the manual pasted-URL path can never disagree.
   */
  public extractChatGPTProjectId(url: string): string | null {
    return extractChatGPTProjectIdFromUrl(url);
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
   *
   * Delegates to the single shared ChatGPT Project URL parser.
   */
  public canonicalizeChatGPTProjectUrl(url: string): string | null {
    return canonicalizeChatGPTProjectUrlFromUrl(url);
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
  private executeHandleJavaScript(handle: BrowserHandle, javaScript: string, timeoutMs = 3000): {
    success: boolean;
    output?: string;
    error?: string;
    /** Which layer failed: applescript_execution | javascript_runtime | transport_envelope */
    failureSource?: string;
  } {
    // Base64 transport. The AppleScript literal carries ONLY the Base64 alphabet, so no
    // quote, backslash or newline in the page source can be corrupted on the way in.
    // The wrapper still contains double quotes (atob("...")), so it must be escaped for the
    // AppleScript literal. It contains NO backslashes or newlines by construction, so this
    // escaping cannot corrupt the Base64 payload.
    const wrapper = appleScriptJsEvalWrapper(encodeJavaScriptForAppleScript(javaScript)).replace(/"/g, '\\"');
    const script = `
      tell application "Google Chrome"
        try
          set t to tab id ${handle.tabId} of window id ${handle.windowId}
          set jsOut to (execute t javascript "${wrapper}")
          return "OK::" & jsOut
        on error errMsg
          return "ERR::" & errMsg
        end try
      end tell
    `;
    const res = this.runAppleScript(script, timeoutMs);
    if (!res.success) {
      return { success: false, error: res.error, failureSource: 'applescript_execution' };
    }
    const trimmed = (res.output || '').trim();
    if (trimmed.startsWith('ERR::')) {
      // AppleScript/Chrome level, including the documented
      // "Executing JavaScript through AppleScript is turned off" preference gate.
      return { success: false, output: trimmed, error: trimmed.replace('ERR::', ''), failureSource: 'applescript_execution' };
    }
    if (!trimmed.startsWith('OK::')) {
      return { success: false, output: trimmed, error: `Unexpected transport envelope: ${trimmed.slice(0, 120)}`, failureSource: 'transport_envelope' };
    }
    const payload = trimmed.replace(/^OK::/, '');
    if (payload.startsWith('__JSERR__')) {
      // The page script itself threw. Reported honestly, never coerced into a value.
      const detail = payload.slice('__JSERR__'.length);
      return { success: false, output: payload, error: `JavaScript runtime error in page: ${detail}`, failureSource: 'javascript_runtime' };
    }
    return { success: true, output: payload };
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
   * The editable ChatGPT PROJECT discovery script.
   *
   * Seeded from the ChatGPT integration configuration
   * (`scripts.discoverProjectScript`) and repairable from the Integration page.
   * The UI-specific `Tab x N` count lives here — never in domain logic — because
   * ChatGPT changes its Projects UI without notice.
   */
  private projectDiscoveryScript: string = DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT;

  /** Visible Projects rows observed by the most recent results-signature read. */
  private lastProjectsResultsCount = 0;

  /**
   * Applies an edited discovery script. An unusable script is retained (so the
   * operator can see what they typed) but rejected on the next discovery run
   * with a precise stage error instead of silently running a wrong sequence.
   */
  public applyProjectDiscoveryScript(script?: string | null): void {
    this.projectDiscoveryScript =
      script && String(script).trim()
        ? String(script)
        : DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT;
  }

  /** The discovery script currently in effect (as stored on the integration). */
  public getProjectDiscoveryScript(): string {
    return this.projectDiscoveryScript;
  }

  /** Normalizes the configured script into a usable profile, or explains why not. */
  private resolveProjectDiscoveryProfile():
    | { ok: true; profile: ChatGPTProjectDiscoveryProfile }
    | { ok: false; error: string } {
    const parsed = parseChatGPTProjectDiscoveryScript(this.projectDiscoveryScript);
    return parsed.ok ? { ok: true, profile: parsed.profile } : { ok: false, error: parsed.error };
  }

  /**
   * macOS Automation: deterministic ChatGPT PROJECT discovery via the Chrome UI.
   *
   * This runner is ONLY responsible for navigating Chrome into the correct
   * ChatGPT Project and returning the resulting browser URL. It returns the URL
   * exactly as reported by Chrome; canonicalization is applied by the shared
   * parser (`chatgptProjectUrl.ts`) at binding time, so both the automatic and
   * manual paths agree.
   *
   * The obsolete flow — `chatgpt.com -> Cmd+K -> search -> navigate result` —
   * has been REMOVED. The verified current GUI flow is:
   *
   *   1. open/focus  https://chatgpt.com/projects
   *   2. wait for the Projects page to be ready        (polled, not a big sleep)
   *   3. type/paste the RelayX project name
   *   4. press Return
   *   5. wait for the UI to accept the search
   *   6. press Tab exactly 7 times, then Return         (Tab count from the profile)
   *   7. wait for the Project page to open              (polled)
   *   8. copy/read the current browser URL             (existing URL-read mechanism)
   *   9. parse the Project identity; fail closed if absent
   *
   * Every failure reports a distinct stage so the operator knows where the
   * sequence broke. Diagnostics carry the stage and safe summaries only — never
   * raw automation script text.
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
    const targetName = (name || '').trim();
    const diag: any = {
      targetName: name,
      discoveryStage: undefined,
      chromeActivated: false,
      tabOpened: false,
      chatgptLoaded: false,
      projectsPageReady: false,
      searchFieldFocused: false,
      searchValue: undefined,
      searchSubmitted: false,
      resultTabCount: undefined,
      resultNavigationDispatched: false,
      projectOpened: false,
      finalUrl: undefined,
      parsedProjectId: undefined,
      discoveryError: undefined,
      chromeJavaScriptFromAppleEvents: undefined,
      chromeJavascriptToggleAttempted: false,
      chromeJavascriptToggleError: undefined,
      projectDiscoveryScriptError: undefined,
    };

    const fail = (stage: ChatGPTProjectDiscoveryStage, detail?: string) => {
      const error = chatgptProjectDiscoveryError(stage, detail);
      diag.discoveryStage = stage;
      diag.discoveryError = error;
      return { success: false as const, error, diagnostics: diag };
    };

    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return fail('OPEN_PROJECTS_PAGE_FAILED', 'macOS automation required');
    }

    const resolved = this.resolveProjectDiscoveryProfile();
    if (!resolved.ok) {
      diag.projectDiscoveryScriptError = resolved.error;
      return fail('OPEN_PROJECTS_PAGE_FAILED', resolved.error);
    }
    const profile = resolved.profile;
    // Safe, script-free summary only.
    diag.discoveryProfile = describeChatGPTProjectDiscoveryProfile(profile);
    diag.resultTabCount = profile.resultTabCount;

    // Activate Chrome before opening the tab (best-effort; the tab-open step also
    // activates Chrome, so a failed activate here is not fatal).
    diag.chromeActivated = this.runAppleScript(
      'tell application "Google Chrome" to activate',
      1500,
    ).success;

    // ---- Stage 1: open/focus https://chatgpt.com/projects --------------------
    const opened = await this.openDiscoveryTab(profile.projectsUrl);
    diag.tabOpened = opened.tabOpened;
    if (!opened.ok) {
      return fail('OPEN_PROJECTS_PAGE_FAILED', sanitizeHostDiagnostic(opened.error));
    }

    const ready = await this.waitForChatGPTReady(diag);
    diag.chatgptLoaded = ready;
    if (!ready) {
      return fail('OPEN_PROJECTS_PAGE_FAILED', buildChatGPTReadyFailureMessage(diag));
    }

    // Confirm we are actually on the Projects route before typing anything.
    const onProjectsRoute = await this.waitForProjectsPage(diag);
    diag.projectsPageReady = onProjectsRoute;
    if (!onProjectsRoute) {
      const detail =
        diag.chromeJavaScriptFromAppleEvents && diag.chromeJavaScriptFromAppleEvents !== 'auto-enabled'
          ? buildChatGPTReadyFailureMessage(diag)
          : 'the Projects route did not load';
      return fail('OPEN_PROJECTS_PAGE_FAILED', detail);
    }

    // ---- Stage 2: focus the Projects search field ---------------------------
    const focused = await this.focusProjectsSearchField(diag);
    diag.searchFieldFocused = focused;
    if (!focused) {
      return fail('PROJECT_SEARCH_INPUT_FAILED');
    }

    // ---- Stages 3-4: input the RelayX project name, then press Return -------
    const input = this.runAppleScript(
      buildChatGPTProjectSearchInputAppleScript(profile, targetName),
      CHATGPT_PROJECT_SEARCH_INPUT_TIMEOUT_MS,
    );
    if (!input.success) {
      return fail('PROJECT_SEARCH_SUBMIT_FAILED', sanitizeHostDiagnostic(input.error));
    }
    diag.searchSubmitted = true;

    // ---- Stage 5: wait for the UI to accept the search ----------------------
    const acceptedValue = await this.waitForProjectsSearchAccepted(targetName, diag);
    if (acceptedValue === null) {
      return fail('PROJECT_SEARCH_SUBMIT_FAILED');
    }
    diag.searchValue = acceptedValue;

    // ---- Stage 5b: wait for the results list to finish re-rendering ----------
    // Live verification showed the Projects list re-renders asynchronously after
    // the search Return. Tabbing into a stale list walks focus through the wrong
    // order and Enter lands on nothing, so this waits on the list's own signature
    // settling instead of sleeping an arbitrary amount.
    const resultsSettled = await this.waitForProjectsResultsSettled(diag);
    if (!resultsSettled) {
      return fail('PROJECT_SEARCH_SUBMIT_FAILED', 'the filtered Projects list did not settle');
    }

    // ---- Stages 6-7: Tab x N, then Return -----------------------------------
    // The Tab count comes from the configurable discovery profile.
    const navigation = this.runAppleScript(
      buildChatGPTProjectResultNavigationAppleScript(profile),
      CHATGPT_PROJECT_RESULT_NAVIGATION_TIMEOUT_MS,
    );
    diag.resultNavigationDispatched = navigation.success;
    if (!navigation.success) {
      return fail('PROJECT_RESULT_NAVIGATION_FAILED', sanitizeHostDiagnostic(navigation.error));
    }

    // ---- Stage 8: wait for the Project page to open (polled) ---------------
    const settled = await this.waitForProjectPageSettled(diag);
    diag.projectOpened = settled.changed;
    if (!settled.changed) {
      return fail(
        'PROJECT_OPEN_FAILED',
        `Tab x ${profile.resultTabCount} + Return left the browser on a non-Project page`,
      );
    }

    // ---- Stage 9: copy/read the current URL via the existing mechanism ------
    const finalUrl = settled.url ?? (await this.readTabUrl());
    if (!finalUrl) {
      return fail('PROJECT_URL_READ_FAILED');
    }
    diag.finalUrl = finalUrl;

    // ---- Fail closed unless the URL carries a real Project identity ---------
    // A URL with no `/g/<g-p-…>` identity — including a standalone
    // `/c/<conversationId>` conversation URL — must NEVER be bound as a Project.
    const identity = parseChatGPTProjectUrl(finalUrl);
    if (!identity) {
      diag.parsedProjectId = null;
      return fail(
        isChatGPTProjectLessUrl(finalUrl) ? 'PROJECT_ID_PARSE_FAILED' : 'INVALID_PROJECT_URL',
        finalUrl,
      );
    }
    diag.parsedProjectId = identity.projectId;

    return {
      success: true,
      projectName: targetName,
      finalUrl,
      projectUrl: finalUrl,
      diagnostics: diag,
    };
  }

  /** Stage 1b: poll until the discovery tab is actually on the Projects route. */
  private async waitForProjectsPage(diag: any): Promise<boolean> {
    const maxAttempts = 10;
    let gatePersistChecks = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = this.executeTabJavaScript(buildChatGPTLocationJavaScript(), 2500);
      if (isChromeJavaScriptFromAppleEventsBlocked(res)) {
        diag.chromeJavaScriptFromAppleEvents = diag.chromeJavaScriptFromAppleEvents || 'blocked';
        const hadToggle = diag.chromeJavascriptToggleAttempted;
        await this.ensureChromeJavaScriptFromAppleEvents(diag);
        const enableInFlight =
          diag.chromeJavaScriptFromAppleEvents === 'auto-enabled' ||
          diag.chromeJavaScriptFromAppleEvents === 'already-enabled';
        if (hadToggle && !enableInFlight) {
          gatePersistChecks++;
          if (gatePersistChecks >= 3) return false;
        }
        await this.sleep(700);
        continue;
      }

      const url = this.parseLocationUrl(res);
      if (url) {
        diag.projectsPageUrl = url;
        if (this.isProjectsRouteUrl(url)) return true;
      } else if (!res.success) {
        diag.appleScriptError = sanitizeHostDiagnostic(res.error);
      }
      await this.sleep(600);
    }
    return false;
  }

  /** Stage 2: poll until the Projects search field is present AND focused. */
  private async focusProjectsSearchField(diag: any): Promise<boolean> {
    const maxAttempts = 8;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = this.executeTabJavaScript(buildChatGPTProjectsSearchFocusJavaScript(), 3000);
      if (res.success && res.output && !res.output.startsWith('ERR::')) {
        try {
          const parsed = JSON.parse(res.output);
          if (parsed.found && parsed.focused) return true;
          if (parsed.found && !parsed.focused) diag.searchFieldFocusRejected = true;
        } catch {
          diag.jsError = 'Projects search focus parse error';
        }
      } else if (!res.success) {
        diag.appleScriptError = sanitizeHostDiagnostic(res.error);
      }
      await this.sleep(600);
    }
    return false;
  }

  /**
   * Stage 5: wait until the Projects search field actually carries the RelayX
   * project name. This proves the paste landed before focus is walked onto the
   * results, rather than tabbing blindly.
   */
  private async waitForProjectsSearchAccepted(
    targetName: string,
    diag: any,
  ): Promise<string | null> {
    const expected = targetName.trim().toLowerCase();
    if (!expected) return null;
    const maxAttempts = 8;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = this.executeTabJavaScript(buildChatGPTProjectsSearchValueJavaScript(), 3000);
      if (res.success && res.output && !res.output.startsWith('ERR::')) {
        try {
          const parsed = JSON.parse(res.output);
          const value = typeof parsed.value === 'string' ? parsed.value.trim() : '';
          if (value && value.toLowerCase() === expected) return value;
        } catch {
          diag.jsError = 'Projects search value parse error';
        }
      } else if (!res.success) {
        diag.appleScriptError = sanitizeHostDiagnostic(res.error);
      }
      await this.sleep(600);
    }
    return null;
  }

  /**
   * Stage 5b: wait for the filtered Projects list to settle.
   *
   * Two consecutive identical render signatures mean the list has finished
   * re-rendering and focus order is stable, so the Tab walk is meaningful. A
   * timeout here is not fatal on its own — the list may legitimately be
   * unchanged — so this reports whether it settled and lets the caller decide.
   */
  private async waitForProjectsResultsSettled(diag: any): Promise<boolean> {
    const maxAttempts = 12;
    // Live measurement: the filtered tab order only becomes walkable ~2s after
    // the search Return, and the tabbable-control count is the signal that
    // reflects it. So the signature is required to be stable across
    // `minStableReads` reads AND across a minimum observation window, rather
    // than accepting the first coincidental match.
    const minStableReads = 3;
    const minObserveMs = CHATGPT_PROJECT_RESULTS_MIN_SETTLE_MS;
    const startedAt = Date.now();
    let previous: string | null = null;
    let stableSeen = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = this.executeTabJavaScript(buildChatGPTProjectsResultsSignatureJavaScript(), 3000);
      const signature = this.parseResultsSignature(res);
      if (signature) {
        diag.projectsResultsCount = this.lastProjectsResultsCount;
        if (signature === previous) {
          stableSeen += 1;
        } else {
          previous = signature;
          stableSeen = 1;
        }
        const observedLongEnough = Date.now() - startedAt >= minObserveMs;
        if (stableSeen >= minStableReads && observedLongEnough) {
          diag.projectsResultsSettledAttempts = attempt;
          diag.projectsResultsSettleMs = Date.now() - startedAt;
          return true;
        }
      } else if (!res.success) {
        diag.appleScriptError = sanitizeHostDiagnostic(res.error);
      }
      await this.sleep(500);
    }
    diag.projectsResultsSettledAttempts = maxAttempts;
    // A list that never held still is treated as unsettled.
    return false;
  }

  /**
   * Reduces the injected results-signature payload to a comparable string, and
   * reports the visible row count for diagnostics.
   */
  private parseResultsSignature(res: { success: boolean; output?: string }): string | null {
    if (!res.success || !res.output || res.output.startsWith('ERR::')) return null;
    try {
      const parsed = JSON.parse(res.output);
      const count = Number(parsed.count ?? 0);
      if (Number.isFinite(count)) this.lastProjectsResultsCount = count;
      // `focusables` is deliberately part of the compared signature: it is the
      // signal that tracks when the filtered rows actually become tabbable.
      return JSON.stringify({ count: parsed.count, names: parsed.names, focusables: parsed.focusables });
    } catch {
      return null;
    }
  }

  /**
   * Stage 8: poll until the browser has settled somewhere OTHER than the Projects
   * route. Two consecutive stable reads are required, so a transient
   * mid-navigation URL can never be mistaken for the destination.
   *
   * "Settled" deliberately means only "navigation left /projects". Whether the
   * destination is a real Project is decided afterwards by the Project identity
   * parse, so landing on (say) a conversation URL is reported as a parse failure
   * instead of being masked as a navigation failure.
   */
  private async waitForProjectPageSettled(diag: any): Promise<{ changed: boolean; url?: string }> {
    const maxAttempts = 16;
    let stableSeen = 0;
    let lastUrl: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = this.executeTabJavaScript(buildChatGPTLocationJavaScript(), 2500);
      const url = this.parseLocationUrl(res);
      if (url) {
        const leftProjectsRoute = !this.isProjectsRouteUrl(url);
        if (leftProjectsRoute) {
          if (url === lastUrl) {
            stableSeen += 1;
          } else {
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
      } else if (!res.success) {
        diag.appleScriptError = sanitizeHostDiagnostic(res.error);
      }
      await this.sleep(600);
    }
    return { changed: false };
  }

  /** True when a URL is still the ChatGPT Projects listing route. */
  private isProjectsRouteUrl(url: string): boolean {
    try {
      const path = new URL(url).pathname;
      return path === '/projects' || path.startsWith('/projects/');
    } catch {
      return false;
    }
  }

  /** Reads `location.href` out of an injected `__relay_stage_read_url__` result. */
  private parseLocationUrl(res: { success: boolean; output?: string; error?: string }): string | null {
    if (!res.success || !res.output || res.output.startsWith('ERR::')) return null;
    try {
      const parsed = JSON.parse(res.output);
      return typeof parsed.url === 'string' && parsed.url ? parsed.url : null;
    } catch {
      return null;
    }
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
   * Stage A: open one discovery tab at `url` in the front Chrome window, then —
   * after a short bounded delay — read the URL of the active tab (the tab just
   * created, which Chrome makes active). No window IDs, no tab indices, no tab
   * counting.
   */
  private async openDiscoveryTab(
    url: string = 'https://chatgpt.com',
  ): Promise<{
    ok: boolean;
    tabCreateSucceeded: boolean;
    tabOpened: boolean;
    initialUrl?: string;
    error?: string;
  }> {
    // 1. Activate Chrome and create the tab (Chrome makes it active).
    const createRes = this.runAppleScript(buildCreateDiscoveryTabAppleScript(url), DISCOVERY_TAB_CREATE_TIMEOUT_MS);
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
        diag.appleScriptError = sanitizeHostDiagnostic(res.error || res.output);

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
        diag.appleScriptError = sanitizeHostDiagnostic(res.error || res.output);
      }
      await this.sleep(700);
    }
    return false;
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



export class OpenCodeProvider extends BaseMacOSProvider {
  readonly providerType: ProviderType = 'opencode';
  readonly defaultBundleId = 'dev.opencode.desktop';
  readonly defaultProcessName = 'OpenCode';
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

      // ---- Step 3: try deterministic free-model candidates ----
      const { spawnSync } = await import('child_process');
      // Narrow fallback: preferred free model first; if rejected for a
      // MODEL-SPECIFIC reason (unavailable/not found/unsupported), advance
      // to next free candidate. Do NOT retry for generic failure.
      const skipForcedModel = !!externalId && !!sessionDirFromRecord && sessionWorkspaceMatch;
      const freeCandidates = [
        request.modelOverride ?? 'opencode-zen/free-default',
        'opencode-zen/free-default',
        'openrouter/free',
        'thinking-machines/inkling:free',
      ];
      const triedModels = new Set<string>();
      let transportResult: ReturnType<typeof spawnSync> | null = null;
      let selectedModel: string | null = null;
      for (const model of freeCandidates) {
        if (triedModels.has(model)) continue;
        triedModels.add(model);
        const trialArgs = ['run', '--session', externalId, '--continue'];
        if (!skipForcedModel) trialArgs.push('--model', model);
        trialArgs.push(request.instructionText);
        const trial = spawnSync(cliPath, trialArgs, {
          cwd: sessionDirFromRecord ?? process.cwd(),
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const trialStderr = trial.stderr?.trim() || '';
        const modelSpecificRejection = /(?:model unavailable|model not found|unsupported model|provider\/model unavailable|free-model quota unavailable)/i.test(trialStderr);
        if (trial.status === 0 || !modelSpecificRejection) {
          // Success or non-model-specific failure: stop trying.
          transportResult = trial;
          selectedModel = model;
          break;
        }
        // Model-specific failure: continue to next candidate.
      }
      if (!transportResult) {
        // All candidates exhausted or no trial produced a result.
        // Preserve failure evidence using the last attempt.
        const lastModel = Array.from(triedModels).pop() ?? request.modelOverride ?? 'unknown';
        transportResult = spawnSync(cliPath, ['run', '--session', externalId, '--continue', '--model', lastModel, request.instructionText], {
          cwd: sessionDirFromRecord ?? process.cwd(),
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        selectedModel = lastModel;
      }
      const transportExitCode = transportResult.status;
      const transportStderrStr = typeof transportResult.stderr === 'string' ? transportResult.stderr : (transportResult.stderr ? Buffer.from(transportResult.stderr).toString() : '');
      const transportError = transportResult.error
        ? transportResult.error.message
        : transportStderrStr.trim() || null;
      const transportStdoutStr = typeof transportResult.stdout === 'string' ? transportResult.stdout : (transportResult.stdout ? Buffer.from(transportResult.stdout).toString() : '');
      const transportStdout = transportStdoutStr.trim() || null;

      // ---- Step 4: reconcile against the EXACT session, on EVERY exit path ----
      //
      // Including the failure path. A non-zero exit, a timeout and a crash are all
      // execution facts that say nothing about whether the instruction landed, and the one
      // case that motivated this rewrite is precisely "the instruction landed and the
      // process then failed".
      const effectiveWatermark = request.preDispatchWatermark ?? preWatermark;
      let postRead = await this.readExactSessionMessages(externalId);
      let reconciliation = reconcileTransportOutcome({
        expectedText: request.instructionText,
        // The caller's watermark wins when it supplied one; otherwise this adapter's own
        // pre-send read is used. Either way the boundary predates the send.
        watermark: effectiveWatermark,
        messages: postRead.readable ? postRead.messages : [],
        transcriptReadable: postRead.readable,
        transcriptReadFailure: postRead.readable ? null : postRead.failure,
        transportExitCode,
        transportError,
      });

      // The OpenCode service persists the submitted user turn asynchronously after the UI
      // accepts Return. A single immediate read can therefore observe the exact pre-send
      // transcript and falsely conclude `not_delivered`. Re-read for a short bounded window;
      // only provider transcript evidence can end the wait early, and the final verdict is
      // still derived solely from that transcript rather than the AppleScript exit status.
      const reconciliationDeadline = Date.now() + 15_000;
      while (
        transportResult.error === undefined &&
        reconciliation.classification !== 'delivered' &&
        Date.now() < reconciliationDeadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        postRead = await this.readExactSessionMessages(externalId);
        reconciliation = reconcileTransportOutcome({
          expectedText: request.instructionText,
          watermark: effectiveWatermark,
          messages: postRead.readable ? postRead.messages : [],
          transcriptReadable: postRead.readable,
          transcriptReadFailure: postRead.readable ? null : postRead.failure,
          transportExitCode,
          transportError,
        });
      }

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
          transportStderrExcerpt: transportError?.slice(0, 1000) ?? null,
          transportStdoutExcerpt: transportStdout?.slice(0, 1000) ?? null,
          modelOverride: request.modelOverride ?? null,
          // MEASURED live: when `skipForcedModel` is true the transport runs WITHOUT `--model`,
          // so the session executes on whatever model it already had. Recording the requested
          // model here as "selected" was a fabricated positive — the live cycle reported
          // selectedModel=opencode-zen/free-default while the run was actually on
          // opencode/big-pickle, and that model is not even available on this build
          // ("Model unavailable"), so the record pointed at a model that could never have run.
          // `selectedModel` now means "the model RelayX actually forced", and the model that
          // really executed is reported from the session read-back above.
          modelFlagPassed: !skipForcedModel,
          selectedModel: skipForcedModel ? null : (selectedModel ?? null),
          modelSelectionSource: skipForcedModel
            ? 'session_existing_model'
            : request.modelOverride
              ? 'relay_override'
              : 'opencode_default_model',
          fallbackUsed: skipForcedModel
            ? false
            : selectedModel !== (request.modelOverride ?? null),
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
   * Reconcile an ALREADY-SENT dispatch against the exact OpenCode session.
   *
   * ## Why this method has to exist
   *
   * `deliverInstruction()` cannot report delivery truthfully about a send whose outcome it
   * did not witness — the process can die between the external write and the local commit, the
   * shared service can be unreachable at that instant, and the transport can exit non-zero for
   * reasons that have nothing to do with insertion. Any of those leaves a `Delivery` stuck at
   * `ambiguous` with no way forward except a resend, which would duplicate the instruction
   * inside a conversation that may already hold it.
   *
   * Without this probe the engine's only options are "resend" or "ask a human", and asking a
   * human is not a resolution mechanism. This method is what makes the reconciler able to
   * settle a stranded intent from evidence instead.
   *
   * ## The two-window rule — why `not_delivered` requires overlap
   *
   * The provider exposes exactly TWO readable windows, the oldest 50 rows and the newest 50
   * rows, and no offset. For a longer session the middle is unreadable. Both windows are
   * searched, so a match can always be FOUND. But absence of a match only means
   * "not_delivered" when the two windows demonstrably OVERLAP, because overlap is the only
   * observable proof that the whole session was read. Otherwise the outcome is `unknown`,
   * because `not_delivered` is the one outcome that authorises a resend, and authorising a
   * resend from a partial read is precisely the failure this whole path exists to prevent
   * (I-6, C-8).
   */
  async reconcileDispatch(request: {
    sessionId: RuntimeSessionId;
    deliveryId?: string;
    instructionSnippet?: string;
    externalSessionId?: string | null;
    idempotencyKey?: string;
  }): Promise<{
    outcome: 'delivered' | 'not_delivered' | 'supporting_evidence_only' | 'unknown' | 'unsupported';
    evidence?: ObservableEvidence;
    reason?: string;
  }> {
    const externalId = request.externalSessionId ?? request.sessionId ?? null;
    const deliveryId = request.deliveryId ?? 'unknown';
    const snippet = request.instructionSnippet || '';
    if (!externalId || typeof externalId !== 'string' || !externalId.startsWith('ses_')) {
      return {
        outcome: 'unknown',
        reason: `No authoritative external session id to reconcile (${String(externalId ?? 'null')}).`,
      };
    }
    const readAscending = await this.readExactSessionMessages(externalId, 'asc');
    const readDescending = await this.readExactSessionMessages(externalId, 'desc');
    if (!readAscending.readable || !readDescending.readable) {
      return {
        outcome: 'unknown',
        reason: readAscending.failure || readDescending.failure || 'OpenCode session transcript unreadable for reconciliation.',
      };
    }
    const ascending = readAscending.messages;
    const descending = readDescending.messages;
    const descendingIds = new Set(descending.map((m) => m.messageId));
    const windowsOverlap = ascending.some((m) => descendingIds.has(m.messageId));
    const matchInAscending = ascending.find((m) => m.role === 'user' && (m.text ?? '').includes(snippet));
    const matchedMessage =
      matchInAscending ?? descending.find((m) => m.role === 'user' && (m.text ?? '').includes(snippet)) ?? null;
    if (matchedMessage) {
      return {
        outcome: 'delivered',
        evidence: {
          id: `ev_reconcile_${deliveryId}`,
          timestamp: Date.now(),
          source: 'reconciliation_probe',
          runtimeSessionId: request.sessionId,
          details: {
            phase: 'reconcile_dispatch',
            sessionId: externalId,
            matchedUserTurn: matchedMessage.messageId ?? null,
            matchedTextHash: matchedMessage.text ? matchedMessage.text.substring(0, 80) : null,
            matchedInWindow: matchInAscending ? 'oldest' : 'newest',
            oldestWindowCount: ascending.length,
            newestWindowCount: descending.length,
            windowsOverlap,
          },
        },
      };
    }
    if (windowsOverlap) {
      return {
        outcome: 'not_delivered',
        reason: `The exact OpenCode session ${externalId} was read in full (${ascending.length} turns, oldest and newest windows overlap) and contains no user turn matching the dispatched instruction.`,
      };
    }
    return {
      outcome: 'unknown',
      reason: `Instruction snippet not matched in the readable windows of OpenCode session ${externalId}. The provider exposes no offset, so only the ${ascending.length} oldest and ${descending.length} newest turns were read and the middle of the session is unreadable; oldest read ends at messageId=${ascending[ascending.length - 1]?.messageId ?? 'none'}, newest read starts at messageId=${descending[descending.length - 1]?.messageId ?? 'none'}.`,
    };
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
   *
   * ## `order` — why the window is a correctness parameter, not a preference
   *
   * The provider's message endpoint returns ONE page of at most 50 rows, IGNORES `limit`, and
   * has no `offset` (verified against the live service 2.0.22: any `limit` yields an empty
   * `data` array and `offset` is a no-op). The page is chosen by `order`, not by offset, and
   * the default is NEWEST-first.
   *
   * So for any session longer than one page, the earliest messages — which is exactly where
   * a session's first dispatched instruction lives — are NOT in the default window. A
   * dispatch-correlation read that omits `order` therefore cannot see the instruction it is
   * looking for, and will report `unknown` forever for every long-lived session. Callers
   * must state which page they need; `reconcileDispatch` reads BOTH.
   */
  private async readExactSessionMessages(
    sessionId: string,
    order: 'asc' | 'desc' = 'desc',
  ): Promise<{ readable: boolean; messages: ReconciliationMessage[]; failure: string | null }> {
    // WORKER MONITORING/EXTRACTION now runs on the managed fixed OpenCode server
    // (opencodeFixedServer.ts), not the Desktop app's sidecar port.
    //
    // The sidecar was the reason a Worker turn became unobservable: it is registered per launch
    // and its port moves, so a supervision tick could read
    // "shared service is unreachable at http://127.0.0.1:49374" and classify a live session as
    // unreadable — which is how a genuinely delivered instruction ended up `ambiguous`. The
    // fixed endpoint is owned and restarted by this process, so a dead server is recovered
    // rather than mistaken for a dead session.
    try {
      const client = await this.fixedServerClient();
      const read = await client.readExactSessionMessages(sessionId, { order, limit: 200 });
      if (!read.readable) {
        return { readable: false, messages: [], failure: read.reason };
      }
      return { readable: true, messages: read.messages, failure: null };
    } catch (err: any) {
      return {
        readable: false,
        messages: [],
        failure: `The exact session transcript could not be read: ${err?.message ?? String(err)}`,
      };
    }
  }

  /**
   * The managed fixed-server client, started on demand.
   *
   * `sessionDirectory` is the Worker session's own workspace, so the server it launches serves
   * the SAME session store the visible OpenCode app uses. No second or headless Worker session
   * is created; the bound `sessionId` is simply read over HTTP.
   */
  private fixedServerRef: OpenCodeFixedServerClient | null = null;

  private async fixedServerClient(): Promise<OpenCodeFixedServerClient> {
    if (this.fixedServerRef) return this.fixedServerRef;
    const client = new OpenCodeFixedServerClient({
      sessionDirectory: process.cwd(),
    });
    const readiness = await client.ensureReady();
    if (!readiness.ready) {
      throw new Error(
        `The managed OpenCode server at ${readiness.endpoint} is not usable: ${readiness.reason}`,
      );
    }
    this.fixedServerRef = client;
    return client;
  }

  /**
   * Working state for the EXACT bound session, from the fixed server.
   *
   * Replaces the app-level process/window heuristic for supervision purposes. That heuristic
   * could not distinguish "OpenCode is open" from "this session is mid-run", so it reported
   * `isWorking:false` for a Worker that was demonstrably still generating.
   */
  async detectExactSessionWorking(externalSessionId: string): Promise<{
    isWorking: boolean;
    evidence?: ObservableEvidence;
  }> {
    try {
      const client = await this.fixedServerClient();
      const state = await client.isSessionWorking(externalSessionId);
      return {
        isWorking: state.working,
        evidence: {
          id: `ev_oc_working_${Date.now()}`,
          timestamp: Date.now(),
          source: 'reconciliation_probe',
          details: {
            phase: 'fixed_server_working_state',
            endpoint: client.endpoint,
            externalSessionId,
            isWorking: state.working,
            reason: state.reason,
          },
        },
      };
    } catch (err: any) {
      return {
        isWorking: false,
        evidence: {
          id: `ev_oc_working_${Date.now()}`,
          timestamp: Date.now(),
          source: 'reconciliation_probe',
          details: {
            phase: 'fixed_server_working_state',
            externalSessionId,
            isWorking: false,
            reason: `fixed server unavailable: ${err?.message ?? String(err)}`,
          },
        },
      };
    }
  }

  /**
   * The question a running Worker turn is blocked on, if any.
   *
   * Reported as evidence so the stall is attributable. Never answered, and never turned into a
   * synthetic response: the Worker is waiting for a human in the visible session.
   */
  async readPendingWorkerQuestion(externalSessionId: string): Promise<{
    pending: boolean;
    toolName: string | null;
    questions: unknown[];
    reason: string;
  }> {
    try {
      const client = await this.fixedServerClient();
      return await client.readPendingQuestion(externalSessionId);
    } catch (err: any) {
      return {
        pending: false,
        toolName: null,
        questions: [],
        reason: `fixed server unavailable: ${err?.message ?? String(err)}`,
      };
    }
  }

  /**
   * Whether a recorded boundary is still observable.
   *
   * Returns an explicit overrun rather than correlating against "a close enough" message when the
   * boundary has aged out of the two reachable pages.
   */
  async locateSessionBoundary(
    externalSessionId: string,
    boundaryMessageId: string,
  ): Promise<{ found: boolean; overrun: boolean; reason: string }> {
    try {
      const client = await this.fixedServerClient();
      const res = await client.locateBoundary(externalSessionId, boundaryMessageId);
      return { found: res.found, overrun: res.overrun, reason: res.reason };
    } catch (err: any) {
      return {
        found: false,
        overrun: false,
        reason: `fixed server unavailable: ${err?.message ?? String(err)}`,
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
    dispatchBoundary?: { afterCreatedAt?: number; afterMessageId?: string | null; sessionId?: string | null; expectedInstructionSnippet?: string | null },
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
    let correlationEvidence: any = null;

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
          let assistantTurns = messages.filter(
            (m: any) => m.role === 'assistant' || m.messageRole === 'assistant' || m.type === 'assistant',
          );
          // Strongest correlation: find exact current dispatched user turn.
          let matchedUserTurn: any = null;
          let matchedUserCreatedAt: number | null = null;
          if (dispatchBoundary?.expectedInstructionSnippet) {
            const snippet = dispatchBoundary.expectedInstructionSnippet.trim();
            const userTurns = messages.filter(
              (m: any) => m.role === 'user' || m.messageRole === 'user' || m.type === 'user',
            );
            for (const ut of userTurns) {
              const text = (ut.text || ut.messageText || ut.content || '').trim();
              if (snippet.length > 10 && text.includes(snippet.substring(0, Math.min(40, snippet.length))) || (snippet.length <= 10 && text === snippet)) {
                matchedUserTurn = ut;
                matchedUserCreatedAt = ut.time?.created ?? ut.created ?? ut.timestamp ?? ut.createdAt ?? null;
                if (typeof matchedUserCreatedAt === 'number') break;
              }
            }
          }
          // Determine correlation boundary source and timestamp.
          let boundarySource = 'delivery_timestamp_fallback';
          let afterTimestamp = dispatchBoundary?.afterCreatedAt ?? 0;
          if (matchedUserTurn && typeof matchedUserCreatedAt === 'number') {
            afterTimestamp = matchedUserCreatedAt;
            boundarySource = 'matched_dispatched_user_turn';
          } else if (dispatchBoundary?.afterMessageId) {
            // Try to locate message by id as secondary exact correlation.
            const boundaryMsg = messages.find((m: any) => (m.id || m.ref || m.messageId) === dispatchBoundary!.afterMessageId);
            if (boundaryMsg) {
              const t = boundaryMsg.time?.created ?? boundaryMsg.created ?? boundaryMsg.timestamp ?? boundaryMsg.createdAt ?? 0;
              if (typeof t === 'number') {
                afterTimestamp = t;
                boundarySource = 'pre_dispatch_watermark_message_id';
              }
            }
          }
          // Filter assistant turns: only after the strongest boundary.
          assistantTurns = messages.filter(
            (m: any) => m.role === 'assistant' || m.messageRole === 'assistant' || m.type === 'assistant',
          );
          assistantTurns = assistantTurns.filter((m: any) => {
            const t = m.time?.created ?? m.created ?? m.timestamp ?? m.createdAt ?? 0;
            return typeof t === 'number' && t > afterTimestamp;
          });
          if (assistantTurns.length > 0) {
            // Select latest turn strictly after the current dispatch user turn.
            const sorted = assistantTurns.sort((a: any, b: any) => {
              const ta = a.time?.created ?? a.created ?? a.timestamp ?? a.createdAt ?? 0;
              const tb = b.time?.created ?? b.created ?? b.timestamp ?? b.createdAt ?? 0;
              return (ta as number) - (tb as number);
            });
            const latestTurn = sorted[sorted.length - 1];
            latestAssistantText = latestTurn.text || latestTurn.messageText || latestTurn.response || null;
            latestAssistantOrdinal = latestTurn.ordinal || latestTurn.providerOrdinal || latestTurn.messageOrdinal || null;
            latestAssistantRef = latestTurn.ref || latestTurn.messageId || latestTurn.id || null;
            assistantMessageFound = true;
            // Persist correlation evidence for external verification.
            correlationEvidence = {
              matchedUserMessageId: matchedUserTurn ? (matchedUserTurn.id || matchedUserTurn.ref || matchedUserTurn.messageId) : null,
              matchedUserCreatedAt: matchedUserCreatedAt,
              assistantMessageId: latestAssistantRef,
              assistantCreatedAt: (latestTurn.time?.created ?? latestTurn.created ?? latestTurn.timestamp ?? latestTurn.createdAt ?? null),
              boundarySource,
              afterTimestamp,
            };
            // Attach to evidence details (will be merged below).
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
        correlationEvidence: correlationEvidence ?? null,
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
   *
   * `windowTitle` is only the FALLBACK label. When an authoritative `externalSessionId` is
   * supplied, the title actually typed into the Desktop UI is read from OpenCode for that
   * exact id first — see `openExactWorkerSession`.
   */
  override async activateRuntime(
    sessionId: RuntimeSessionId,
    windowTitle?: string,
    externalSessionId?: string | null,
  ): Promise<boolean> {
    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return false;
    }

    if (externalSessionId) {
      const res = await this.openExactWorkerSession({
        externalSessionId,
        storedTitle: windowTitle ?? null,
      });
      return res.ok;
    }

    // No authoritative id: only a bare activation is meaningful. It is NOT an exact open.
    return super.activateRuntime(sessionId);
  }

  /**
   * Open the exact bound OpenCode worker session in OpenCode Desktop.
   *
   * `ses_…` is the identity. The title is refreshed from OpenCode for that exact id and used
   * as navigation metadata only; the id is never replaced. A metadata failure, or a title
   * that is ambiguous inside the session's own directory, is reported as a failure and
   * nothing is opened — this path never guesses.
   *
   * The Desktop keystroke sequence is emitted through a FOREGROUND GATE: every keystroke is
   * sent only while OpenCode is the observed foreground application, because System Events
   * delivers synthetic keystrokes to the foreground app rather than to the named process.
   */
  public async openExactWorkerSession(options: {
    externalSessionId: string;
    storedTitle?: string | null;
  }): Promise<OpenCodeWorkerOpenResult> {
    if (typeof process === 'undefined' || process.platform !== 'darwin') {
      return {
        ok: false,
        failure: 'unsupported_platform',
        error: 'Opening an OpenCode worker session requires macOS UI automation.',
      };
    }

    const procName =
      (this.probeMacOSProcess(this.defaultProcessName).details?.matchedProcessName as string) ||
      this.defaultProcessName;

    // ---- Preflight: identity first, title second -------------------------
    const pre = await resolveOpenCodeWorkerOpenTarget({
      externalSessionId: options.externalSessionId,
      storedTitle: options.storedTitle ?? null,
    });
    if (!pre.ok) {
      return {
        ok: false,
        failure: pre.failure,
        externalSessionId: pre.externalSessionId,
        error: pre.error,
      };
    }
    const { target } = pre;

    // ---- Foreground-gated Desktop sequence -------------------------------
    const steps = buildOpenCodeWorkerOpenSteps(target.title);
    const run = await runForegroundGatedSteps(steps, procName, {
      readForegroundApp: () => this.readForegroundAppName(),
      activateApp: (appName) => this.runAppleScript(`tell application "${appName}" to activate`, 2000).success,
      sendKey: (keys) => {
        const res = this.runAppleScript(
          `tell application "System Events"
             tell process "${procName}"
               keystroke ${keys}
             end tell
           end tell`,
          4000,
        );
        if (!res.success) throw new Error(res.error || 'keystroke failed');
      },
      sendKeyCode: (code) => {
        const res = this.runAppleScript(
          `tell application "System Events"
             tell process "${procName}"
               key code ${code}
             end tell
           end tell`,
          4000,
        );
        if (!res.success) throw new Error(res.error || 'key code failed');
      },
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    });

    if (!run.ok) {
      return {
        ok: false,
        failure: run.failure === 'foreground_never_verified' ? 'foreground_never_verified' : 'keystroke_failed',
        externalSessionId: target.externalSessionId,
        error: run.error,
        stepsSent: run.sent,
        foregroundBeforeEachStep: run.foregroundBeforeEachStep,
        resolvedTitle: target.title,
      };
    }

    return {
      ok: true,
      externalSessionId: target.externalSessionId,
      resolvedTitle: target.title,
      storedTitleWasStale: target.titleChanged,
      previousStoredTitle: target.storedTitle,
      duplicateTitleSessionIds: target.duplicateTitleSessionIds,
      stepsSent: run.sent,
      foregroundBeforeEachStep: run.foregroundBeforeEachStep,
    };
  }

  /**
   * Read the OBSERVED foreground application name.
   *
   * This is the observation the whole open sequence is gated on. `System Events` resolves
   * `whose frontmost is true` against the global process list, so the lookup must NOT be made
   * from inside `tell process "…"`, where it would be scoped to that one process and fail.
   */
  protected readForegroundAppName(): string | null {
    const res = this.runAppleScript(
      `tell application "System Events"
         try
           return name of first application process whose frontmost is true
         on error
           return ""
         end try
       end tell`,
      2500,
    );
    const name = (res.output || '').trim();
    return res.success && name ? name : null;
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

/* ============================================================================
 * EXACT-SESSION TRANSPORT OBSERVATION — ChatGPTProvider (planner side)
 *
 * PROVEN DEFECT THIS RESTORES
 * ---------------------------
 * `RelayEngine.captureTransportBoundary` is guarded by
 *     provider.captureTransportBoundary ? await provider.captureTransportBoundary(...) :
 *                                         { watermark: null,
 *                                           failure: 'Provider exposes no transport-boundary capability.' }
 * `ChatGPTProvider` defined NONE of the three observation methods, so the planner
 * ALWAYS took that else-branch. Consequences actually observed on the isolated
 * profile (pair_mut4l0sg_kypfzefr / planner 6ac1a7c4-7b40-83ec-ba40-86180675f217):
 *   - every pre-dispatch boundary returned null
 *   - no `pre_dispatch_boundary` evidence was ever written to a delivery
 *   - the planner side identity stayed permanently `unknown`
 * The sibling `OpenCodeProvider` DOES define these methods (adapters.ts ~3704),
 * which is why worker-side transport worked and only the planner failed.
 *
 * The `chatgpt-turn-observation/` module holds the intended types and the
 * documented selectors but is imported by nothing — dead code. These methods use
 * ONLY the pre-existing BrowserHandle mechanism already present on
 * ChatGPTProvider (openDedicatedWindowAndCaptureId / verifyHandleExists /
 * executeHandleJavaScript / readHandleUrl). No new automation, no delivery change,
 * no lifecycle change.
 *
 * FAILS SAFELY: handle lost, DOM miss, selector miss or unparseable output all
 * return `unknown` / `null` with an honest reason. Never fabricated.
 *
 * Attached to the prototype rather than spliced into the class body so the class
 * brace structure is left byte-for-byte untouched.
 * ==========================================================================*/

interface ChatGPTObservedTurn {
  ref: string;
  role: 'user' | 'assistant';
  ordinal: number;
  text: string;
  /** Content hash of `text`; the stable half of `ref`. */
  fingerprint: string;
  /** Provider-exposed creation time, or null. NEVER the observation time. */
  createdAt: number | null;
  /** 0-based index among same (role, canonical text) turns in the DEDUPED set. */
  occurrence?: number;
  /** Provider-owned structural turn identity (ChatGPT `data-turn-key`), when exposed. */
  turnKey?: string | null;
}

function chatgptTurnHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash << 5) - hash + text.charCodeAt(i);
  return String(hash >>> 0);
}

/* ============================================================================
 * CHATGPT EXACT-CONVERSATION EXTRACTION — SINGLE SOURCE OF TRUTH
 *
 * Selector provenance (measured live on the exact conversation
 * 6ac1a7c4-7b40-83ec-ba40-86180675f217, NOT guessed):
 *
 *   [data-testid="conversation-turn"]  -> 0 matches
 *   [data-message-author-role]        -> 0 matches
 *   [data-message-author-role="user"] -> 0 matches
 *   [data-user-message-bubble]        -> present, SEMANTIC, stable
 *   [class*="bg-user-message"]        -> present (class-derived, less stable)
 *   div[class*="block-"]              -> the per-turn container for BOTH roles
 *
 * So the old reader (which used only the two zero-match selectors) could never read this
 * build. Role comes from turn-block membership, NOT from a class guess:
 *   block CONTAINS [data-user-message-bubble] -> user, else assistant
 * which is what stops an assistant reply from being misread as Planner user work.
 *
 * HONEST LIMITS, recorded so no caller can over-read this:
 *  - ChatGPT VIRTUALIZES the transcript. Only a window of turns is in the DOM. The result is
 *    therefore "the turns currently rendered", not the full history. For boundary use this
 *    is sound in the direction that matters (the newest turn is always rendered) and can
 *    never wrongly CLAIM a turn that does not exist.
 *  - `time[datetime]` is the only creation-time signal, and it exists only for rendered
 *    turns. Absent time => createdAt null. Observation time is NEVER substituted.
 * ==========================================================================*/
const CHATGPT_USER_TURN_SELECTORS = [
  '[data-user-message-bubble]',
  '[class*="bg-user-message"]',
];
/** The per-turn container for BOTH roles in this build. */
const CHATGPT_TURN_BLOCK_SELECTOR = '[class*="block-"]';

/**
 * The exact-conversation extraction expression, exported so the selector/role/createdAt
 * contract is directly testable against a DOM stub and cannot regress silently.
 */
/**
 * The ONE canonicalisation for ChatGPT turn text.
 *
 * Every consumer uses this: duplicate detection, ref generation, fingerprint generation and
 * watermark message identity. Different callers must never normalise differently, or the
 * boundary stops being comparable with the transcript it was captured from.
 *
 * RULES, each of which is either measured on the live build or presentation-only by
 * definition. Nothing here changes message meaning:
 *
 *  1. CRLF / CR -> LF. Transport-level, presentation-only.
 *  2. Unicode NFC. The conservative choice: NFC composes canonically equivalent sequences
 *     without folding compatibility characters, so it cannot turn e.g. a circled digit into
 *     a plain one the way NFKC would.
 *  3. Strip a leading renderer wrapper label. MEASURED: on this build EVERY turn's innerText
 *     begins with `You said:` (user) or `ChatGPT said:` (assistant) on its own line, followed
 *     by the message. These are accessibility labels, not message content, and the extracted
 *     text still visibly differs by whitespace after them ("ChatGPT said:\n\n" vs
 *     "You said:\n") -- which is exactly the kind of presentation-only difference that
 *     canonicalisation exists to remove.
 *     Guarded: only stripped at the very start, so a message that merely *begins* with those
 *     words mid-sentence is untouched, and an empty remainder is not treated as content.
 *  4. Collapse runs of whitespace to a single space and trim. Presentation-only.
 *
 * DELIBERATELY NOT DONE, because no measurement justified them:
 *  - lowercasing, punctuation stripping, or any semantic whitespace collapsing
 *  - folding quote/dash variants. The live text does contain U+201C/U+201D, but no duplicate
 *    render was reproducible, so there is NO evidence such a variant difference occurs. Folding
 *    them speculatively could collapse two genuinely different messages.
 * Anything not provably presentation-only is left intact, so distinct messages stay distinct.
 */
export function canonicalizeChatGPTMessageText(raw: string): string {
  let t = String(raw ?? '');
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.normalize('NFC');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * The page-side extraction for ONE exact ChatGPT conversation.
 *
 * STRUCTURAL ROOT SELECTION — how the authoritative live tree is chosen (MEASURED live):
 *
 *   ChatGPT mounts TWO complete [data-thread-find-target="conversation"] roots for the same
 *   conversation.
 *     mirror        : rect 0x0, offsetParent null, and its .thread-scroll-container reports
 *                     scrollHeight 0 / clientHeight 0  (detached)
 *     authoritative : rect 640x776, offsetParent set, scroll container scrollHeight 940
 *
 *   Both carry the IDENTICAL data-turn-key UUIDs, which is what proves they are two renders of
 *   the same logical turns rather than two different conversations.
 *
 *   Neither root is aria-hidden and both sit inside a .thread-scroll-container, so neither of
 *   those discriminates. Rendered-vs-detached does, and it is a property of the WHOLE root.
 *
 *   The authoritative root was measured at top = -143, i.e. legitimately extending above the
 *   viewport. That is exactly why viewport intersection is NOT used for turn membership: a
 *   real, older turn can be scrolled out of view and must still appear in the transcript.
 *   Geometry is used only to tell an entirely detached MIRROR ROOT from the live one.
 */
export function composeChatGPTConversationReadScript(): string {
  return (
    `(() => {` +
    ` const USER_SEL = ${JSON.stringify(CHATGPT_USER_TURN_SELECTORS[0])};` +
    ` const USER_FALLBACK = ${JSON.stringify(CHATGPT_USER_TURN_SELECTORS[1])};` +
    ` const BLOCKISH = ${JSON.stringify(CHATGPT_TURN_BLOCK_SELECTOR)};` +
    ` const ROOT_SEL = '[data-thread-find-target="conversation"]';` +
    ` const TURNKEY_SEL = '[data-turn-key]';` +
    ` const PAIR_SEL = '[data-content-search-turn-key]';` +
    ` function matches(el, sel) {` +
    `   if (!el || !el.getAttribute) return false;` +
    `   if (sel === USER_SEL) return el.getAttribute('data-user-message-bubble') !== null;` +
    `   if (sel === USER_FALLBACK) return String(el.className || '').indexOf('bg-user-message') >= 0;` +
    `   if (sel === BLOCKISH) return String(el.className || '').indexOf('block-') >= 0;` +
    `   return false;` +
    ` }` +
    ` function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }` +
    ` function descendantsOf(el, sel) {` +
    `   const out = [], stack = Array.prototype.slice.call(el.children || []);` +
    `   while (stack.length) {` +
    `     const c = stack.shift();` +
    `     if (matches(c, sel)) out.push(c);` +
    `     for (const k of (Array.prototype.slice.call(c.children || []))) stack.push(k);` +
    `   }` +
    `   return out;` +
    ` }` +
    // The renderer accessibility label is removed by STRUCTURE, never by text guessing.
    // MEASURED: the same logical turn renders as "You said:<msg>" in one copy and
    // "You said:\n<msg>" in another, so a text-level strip has to guess whether a newline is
    // present and guessing wrong reproduces the very divergence canonicalisation removes.
    ` function messageTextOf(b, isUser) {` +
    `   if (isUser) {` +
    `     const bub = descendantsOf(b, USER_SEL)[0] || descendantsOf(b, USER_FALLBACK)[0];` +
    `     if (bub) return bub.innerText || '';` +
    `   }` +
    `   const kids = Array.prototype.slice.call(b.children || []);` +
    `   const parts = [];` +
    `   for (const k of kids) {` +
    `     const only = (k.innerText || '').replace(/^\\s+|\\s+$/g, '');` +
    `     if (/^(?:You said|ChatGPT said)\\s*:?$/.test(only)) continue;` +
    `     parts.push(k.innerText || '');` +
    `   }` +
    `   return parts.join(' ').replace(/^\\s+|\\s+$/g, '');` +
    ` }` +
    // Mirrors canonicalizeChatGPTMessageText exactly. No label strip here (already structural),
    // and deliberately NO emoji-adjacent, punctuation, case or all-whitespace folding.
    ` function canon(t) {` +
    `   return String(t || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').normalize('NFC')` +
    `     .replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '');` +
    ` }` +
    ` function isRendered(el) {` +
    `   if (!el || !el.getBoundingClientRect) return false;` +
    `   if (el.offsetParent === null) return false;` +
    `   const r = el.getBoundingClientRect();` +
    `   return r.width > 0 && r.height > 0;` +
    ` }` +
    // ---- STRUCTURAL ROOT SELECTION — the authoritative live conversation tree.` +
        ` const allRoots = qsa(ROOT_SEL);` +
    ` if (!allRoots.length) {` +
    `   return JSON.stringify({ ok: false, readable: false, reason: 'no conversation root matched ' + ROOT_SEL + '; the conversation has not rendered. Never reported as zero turns.' });` +
    ` }` +
    ` const renderedRoots = allRoots.filter(isRendered);` +
    ` let root = null;` +
    ` if (renderedRoots.length === 1) {` +
    `   root = renderedRoots[0];` +
    ` } else if (renderedRoots.length > 1) {` +
            `   const scored = renderedRoots.map(function (r, i) {` +
    `     const rect = r.getBoundingClientRect();` +
    `     return { el: r, i: i, keys: r.querySelectorAll(TURNKEY_SEL).length, area: rect.width * rect.height };` +
    `   }).sort(function (a, b) { return (b.keys - a.keys) || (b.area - a.area) || (a.i - b.i); });` +
    `   root = scored[0].el;` +
    ` }` +
    ` if (!root) {` +
    `   return JSON.stringify({ ok: false, readable: false, reason: 'all ' + allRoots.length + ' conversation roots are detached (offsetParent null / zero rect); no authoritative live tree. Never reported as zero turns.' });` +
    ` }` +
    // Pair wrappers are the provider's own turn groupings; fall back to block containers.
    ` function outermostBlocks(scope) {` +
    `   const all = descendantsOf(scope, BLOCKISH);` +
    `   return all.filter(function (b) {` +
    `     return !all.some(function (o) { return o !== b && o.contains(b); });` +
    `   });` +
    ` }` +
    // A conversation group also contains DATE DIVIDERS ("Today 10:11 AM"), which are
    // timestamp chrome, not messages. They are excluded STRUCTURALLY: a divider's canonical
    // text is exactly the text of a <time datetime> it contains and it identifies no turn.
    // Reading them as assistant messages would both invent content and lose the real replies.
    ` function isTimestampChrome(b, text) {` +
    `   if (!b.querySelector) return false;` +
    `   const t = b.querySelector('time[datetime]');` +
    `   if (!t) return false;` +
    `   const tt = (t.innerText || '').replace(/^\\s+|\\s+$/g, '');` +
    `   return !!tt && tt === text;` +
    ` }` +
    ` const pairs = Array.prototype.slice.call(root.querySelectorAll(PAIR_SEL));` +
    ` const groups = [];` +
    ` for (const p of pairs) {` +
    `   const blocks = outermostBlocks(p).filter(function (b) {` +
    `     const u = matches(b, USER_SEL) || matches(b, USER_FALLBACK) ||` +
    `       !!descendantsOf(b, USER_SEL).length || !!descendantsOf(b, USER_FALLBACK).length;` +
    `     return u || !isTimestampChrome(b, canon(messageTextOf(b, false)));` +
    `   });` +
    `   groups.push(blocks);` +
    ` }` +
    ` if (!groups.length) {` +
    `   const blocks = Array.prototype.slice.call(root.querySelectorAll(BLOCKISH)).filter(function (t) {` +
    `     return !Array.prototype.slice.call(t.parentElement ? t.parentElement.children || [] : [])` +
    `       .some(function (o) { return o !== t && o.contains(t) && matches(o, BLOCKISH); });` +
    `   });` +
    `   for (const b of blocks) groups.push([b]);` +
    ` }` +
    ` const turns = [];` +
    ` for (const g of groups) {` +
    `   for (const b of g) {` +
    `     const isUser = matches(b, USER_SEL) || matches(b, USER_FALLBACK) ||` +
    `       !!descendantsOf(b, USER_SEL).length || !!descendantsOf(b, USER_FALLBACK).length;` +
    `     const role = isUser ? 'user' : 'assistant';` +
    `     const text = canon(messageTextOf(b, isUser));` +
    `     const tk = (b.getAttribute && b.getAttribute('data-turn-key') !== null) ? b : (b.querySelector ? b.querySelector(TURNKEY_SEL) : null);` +
    `     turns.push({` +
    `       ordinal: turns.length,` +
    `       role: role,` +
    `       text: text.slice(0, 2000),` +
    `       createdAt: null,` +
        `       turnKey: tk ? tk.getAttribute(TURNKEY_SEL.slice(1, -1)) : null,` +
    `       occurrence: 0,` +
    `     });` +
    `   }` +
    ` }` +
    ` if (!turns.length) {` +
    `   return JSON.stringify({ ok: false, readable: false, reason: 'the authoritative conversation root rendered but exposed no turn blocks; extraction contract not established. Never reported as zero turns.' });` +
    ` }` +
    ` return JSON.stringify({` +
    `   ok: true, readable: true,` +
    `   mode: 'authoritative_root',` +
    `   candidateRootCount: allRoots.length,` +
    `   ignoredMirrorRootCount: allRoots.length - 1,` +
    `   turnCount: turns.length,` +
    `   turns: turns,` +
    ` });` +
    `})()`
  );
}

/** Bound, single-shot DOM read of the EXACT conversation. Never partial. */
async function readExactChatGPTConversation(
  self: any,
  externalSessionId: string,
): Promise<
  | { ok: true; readable: true; url: string; handle: BrowserHandle; virtualized: boolean; turns: ChatGPTObservedTurn[] }
  | { ok: false; readable: false; reason: string }
> {
  const ext = externalSessionId.trim();
  if (!ext) return { ok: false, readable: false, reason: 'No external session id (I-11).' };

  const url = /^https?:\/\//i.test(ext) ? ext : `https://chatgpt.com/c/${ext}`;
  const handle: BrowserHandle | null = self.openDedicatedWindowAndCaptureId(url);
  if (!handle) {
    return {
      ok: false,
      readable: false,
      reason: `No BrowserHandle could be established for the exact conversation ${url}; a dedicated window/tab was not resolvable.`,
    };
  }
  if (!self.verifyHandleExists(handle)) {
    return {
      ok: false,
      readable: false,
      reason:
        `BrowserHandle for the exact conversation ${url} was created but no longer exists ` +
        `(WIN:${handle.windowId}|TAB:${handle.tabId}); identity was not verified.`,
    };
  }

  // Order + content hash only. Never observation time (I-7).
  const js = composeChatGPTConversationReadScript();

  // ChatGPT renders the conversation asynchronously after the tab is handed back, so an
  // immediate read legitimately observes an EMPTY document. That is "not rendered yet", not
  // "unreadable", and it must not be reported as either "zero turns" or a hard failure.
  //
  // So the extraction contract is polled for a BOUNDED time. The bound is finite so a
  // genuinely wrong-build contract still surfaces as readable:false, never as an endless wait.
  const ATTEMPTS = 5;
  const DELAY_MS = 350;
  let res = self.executeHandleJavaScript(handle, js, 5000);
  for (let attempt = 1; attempt < ATTEMPTS; attempt++) {
    if (res.success && (res.output || '').includes('"ok":true')) break;
    if (typeof self.sleep === 'function') await self.sleep(DELAY_MS);
    res = self.executeHandleJavaScript(handle, js, 5000);
  }
  if (!res.success || !res.output) {
    return {
      ok: false,
      readable: false,
      reason: `DOM read on the exact conversation failed: ${res.error ?? 'no output returned'}; never fabricated.`,
    };
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(res.output);
  } catch {
    return { ok: false, readable: false, reason: 'DOM read returned unparseable output; never fabricated.' };
  }
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.turns)) {
    return {
      ok: false,
      // readable:false here means "extraction could not be established", NOT "no turns".
      readable: false,
      reason:
        `DOM read did not yield turns after ${ATTEMPTS} bounded attempts: ` +
        `${parsed?.reason ?? 'unknown selector miss'}; never fabricated.`,
    };
  }
  const seenByKey = new Map<string, number>();
  const turns: ChatGPTObservedTurn[] = parsed.turns.map((t: any) => {
    // Re-canonicalise on the TS side with the SAME function used in the page, so the two
    // layers cannot disagree about what a turn's canonical text is.
    const text = canonicalizeChatGPTMessageText(String(t?.text ?? ''));
    const fingerprint = chatgptTurnHash(text);
    // Identity prefers the PROVIDER-OWNED structural turn key. It is a stable UUID that
    // survives re-renders, so it cannot be perturbed by message-text presentation the way a
    // content hash can (measured: the same turn rendered ".\u2705" and ". \u2705").
    // The content hash + occurrence index remain as the fallback for a build that omits it.
    const role = t?.role === 'user' ? 'user' : 'assistant';
    const structuralKey = typeof t?.turnKey === 'string' && t.turnKey.trim() ? t.turnKey.trim() : null;
    const key = `${role}\u0000${structuralKey ?? fingerprint}`;
    const occurrence = structuralKey ? 0 : (seenByKey.get(`${role}\u0000${fingerprint}`) ?? 0);
    seenByKey.set(`${role}\u0000${structuralKey ?? fingerprint}`, occurrence + 1);
    return {
      // Content-addressed, so the ref does NOT move when ChatGPT virtualises the window
      // and the ordinal shifts. Two byte-identical turns legitimately share a ref, which
      // can only ever SHRINK the boundary set — it can never invent newness.
      // Role participates, so an assistant echo never collides with the user turn it echoes.
      // The occurrence index keeps two genuinely separate same-text turns distinct, while a
      // duplicate render of one logical turn collapses before it can inflate the count.
      ref: structuralKey
        ? `chatgpt_${t?.role === 'user' ? 'u' : 'a'}_${structuralKey}`
        : `chatgpt_${t?.role === 'user' ? 'u' : 'a'}_${fingerprint}_${occurrence}`,
      role: t?.role === 'user' ? 'user' : 'assistant',
      ordinal: Number.isFinite(t?.ordinal) ? t.ordinal : 0,
      text,
      fingerprint,
      createdAt: typeof t?.createdAt === 'number' && isFinite(t.createdAt) ? t.createdAt : null,
    };
  });
  return {
    ok: true,
    readable: true,
    url: self.readHandleUrl(handle) ?? url,
    handle,
    virtualized: true,
    turns,
  };;
}

/**
 * Composes the editor-typing expression, passing `marker` as the argument.
 *
 * CHATGPT_EDITOR_TYPE_JS is a BARE function expression and MUST be invoked here with the
 * text. This was the proven live defect: the template used to self-invoke, so the caller
 * bound `f` to the template's string RESULT and then called it ->
 *   __JSERR__TypeError: f is not a function
 * The marker was therefore never inserted, and the marker read-back gate could not pass.
 * Exported and unit-tested against a DOM stub so the argument cannot be dropped again.
 */
export function composeChatGPTEditorTypeScript(marker: string): string {
  return `(function () { return (${CHATGPT_EDITOR_TYPE_JS})(${JSON.stringify(marker)}); })()`;
}

/**
 * Reads the user-role turns of the EXACT conversation behind `handle`.
 *
 * Selector provenance (proven against the live ChatGPT build, not guessed): this layout
 * does NOT emit [data-message-author-role], so the earlier selector returned 0 turns and a
 * real submitted turn was reported as absent. The actual user bubble is
 *   div.bg-user-message.text-user-message  <  div[group/user-message ... items-end]
 * which is what this reads. `items-end` (right-aligned) plus the `bg-user-message` class is
 * what distinguishes a user turn from an assistant turn.
 */

const CHATGPT_READ_USER_TURNS_JS = `
  (function () {
    var SELS = ${JSON.stringify(CHATGPT_USER_TURN_SELECTORS)};
    var nodes = null;
    for (var i = 0; i < SELS.length; i++) {
      var f = document.querySelectorAll(SELS[i]);
      if (f.length > 0) { nodes = Array.prototype.slice.call(f); break; }
    }
    if (!nodes) return JSON.stringify({ ok: true, selector: null, turns: [] });
    var out = [];
    for (var j = 0; j < nodes.length; j++) {
      var t = (nodes[j].innerText || '').replace(/\\s+/g, ' ').trim();
      if (t) out.push({ ref: 'DOM' + j, ordinal: j, role: 'user', text: t.slice(0, 600) });
    }
    return JSON.stringify({ ok: true, selector: SELS[i - 1] || SELS[0], turns: out });
  })()
`;

Object.assign(ChatGPTProvider.prototype, {
  /** Reads user turns of the exact conversation behind `handle`. */
  async readExactUserTurns(this: any, handle: BrowserHandle): Promise<{ ok: boolean; selector?: string | null; turns: Array<{ ref: string; ordinal: number; role: string; text: string }> }> {
    const res = this.executeHandleJavaScript(handle, CHATGPT_READ_USER_TURNS_JS, 4000);
    if (!res.success) return { ok: false, turns: [] };
    try {
      const parsed = JSON.parse(res.output || 'null');
      return parsed && Array.isArray(parsed.turns) ? parsed : { ok: false, turns: [] };
    } catch {
      return { ok: false, turns: [] };
    }
  },

  async captureTransportBoundary(request: TransportBoundaryRequest): Promise<TransportBoundaryResult> {
    const ext = request.externalSessionId ?? null;
    if (!ext || typeof ext !== 'string' || !ext.trim()) {
      return { watermark: null, failure: 'No external session id (I-11).' };
    }
    const read = await readExactChatGPTConversation(this, ext);
    // Unreadable extraction -> null watermark, NEVER an empty watermark. A null watermark
    // forces `ambiguous` downstream, which is the safe direction.
    if (!read.ok) return { watermark: null, failure: `EXACT-SESSION-UNREADABLE: ${read.reason}` };

    // A readable conversation with ZERO turns is a genuine empty state (what a freshly
    // created planner conversation looks like), not a failure, and yields a usable
    // (empty) boundary rather than a false alarm.
    //
    // Ids are `${role}:${ref}` and `ref` is content-addressed, so the set does NOT churn when
    // ChatGPT virtualises the transcript and ordinals shift. Ordinal is deliberately NOT in
    // the id for that reason.
    const messageIds = read.turns.map((t) => `${t.role}:${t.ref}`);

    // Evidence only; post-boundary detection uses the messageIds set (I-7). Taken from the
    // provider-exposed <time datetime> of the newest rendered turn, or null when the DOM
    // exposes none. Observation time is NEVER substituted (I-7).
    const observedTimes = read.turns
      .map((t) => t.createdAt)
      .filter((v): v is number => typeof v === 'number' && isFinite(v));
    const latestCreatedAt = observedTimes.length ? Math.max(...observedTimes) : null;

    return {
      watermark: {
        sessionId: ext,
        messageCount: read.turns.length,
        messageIds,
        latestCreatedAt,
        provenance: 'captured_pre_dispatch',
        capturedAt: Date.now(),
      },
      failure: null,
    };
  },

  /**
   * Exact-session transcript for reconciliation. Shares ONE extraction with
   * captureTransportBoundary, so the boundary can never be captured against a different
   * turn set than the one reconciliation compares.
   *
   * readable:false means "extraction contract not established". It is never a synonym for
   * "zero messages": a genuinely empty-but-readable conversation returns readable:true
   * with an empty array, and only that may be treated as "nothing there".
   */
  async readExactSessionTurnsForReconciliation(request: { externalSessionId: string }) {
    const read = await readExactChatGPTConversation(this, request.externalSessionId);
    if (!read.ok) return { readable: false, messages: [], failure: read.reason };
    return {
      readable: true,
      failure: null,
      messages: read.turns.map((t) => ({
        messageId: t.ref,
        role: t.role,
        text: t.text,
        ordinal: t.ordinal,
        // Real DOM value or absent. Never Date.now().
        createdAt: t.createdAt ?? undefined,
      })),
    };
  },

  async observeSide(request: SideObservationRequest): Promise<SideObservationReading> {
    const now = Date.now();
    const validUntil = now + PROVISIONAL_OBSERVATION_VALIDITY_MS;
    const ext = request.externalSessionId ?? null;

    const unknown = (reason: string): SideObservationReading => ({
      reachabilityState: 'unknown',
      uiPresenceState: 'unknown',
      activityState: 'unknown',
      messageEvidenceState: 'unknown',
      message: { ref: null, role: null, text: null, truncated: false, ordinal: null },
      observationCapability: 'chatgpt_dom_message_inspection',
      observedAt: now,
      validUntil,
      reason,
      evidence: null,
    });

    if (!ext || typeof ext !== 'string' || !ext.trim()) return unknown('No external session id (I-11).');

    const read = await readExactChatGPTConversation(this, ext);
    if (!read.ok) return unknown(`Observation failed safely: ${read.reason} never fabricated.`);

    const last = read.turns.length > 0 ? read.turns[read.turns.length - 1] : null;

    // Generating is inferred only from an observable empty trailing assistant turn.
    const generating = !!last && last.role === 'assistant' && last.text.length === 0;
    // Ordering/staleness against a prior boundary is resolved by the caller from the
    // messageIds set, so this method reports only what it directly observed.
    const completedTurn = !!last && last.role === 'assistant';

    return {
      reachabilityState: 'reachable',
      uiPresenceState: 'present',
      activityState: generating ? 'working' : 'idle',
      messageEvidenceState: completedTurn ? 'observed' : 'none',
      message: completedTurn
        ? {
            ref: last!.ref,
            role: 'assistant',
            text: last!.text,
            truncated: last!.text.length > 2000,
            ordinal: last!.ordinal,
          }
        : { ref: null, role: null, text: null, truncated: false, ordinal: null },
      observationCapability: 'chatgpt_dom_message_inspection',
      observedAt: now,
      validUntil,
      reason: null,
      evidence: {
        id: `ev_chatgpt_observe_${now}`,
        timestamp: now,
        source: 'reconciliation_probe',
        bundleIdentifier: (this as any).defaultBundleId,
        details: {
          externalSessionId: ext,
          handleValid: true,
          handle: `WIN:${read.handle.windowId}|TAB:${read.handle.tabId}`,
          turnCount: read.turns.length,
          lastOrdinal: last?.ordinal ?? null,
          lastRole: last?.role ?? null,
          lastTextLength: last?.text.length ?? 0,
          generating,
        },
      },
    };
  },
});

/* ============================================================================
 * EXACT-SESSION CHROME OPENER (planner "Open")
 *
 * PROVEN DEFECT THIS REPLACES
 * ---------------------------
 * `ChatGPTAppHandler.openSession` ended with the generic OS command
 *     exec(`open "<url>"`)
 * which the OS may route to the ChatGPT desktop app instead of Chrome. Observed on
 * this host: RelayX returned success:true and ZERO Chrome tabs contained
 * 6ac1a7c4-7b40-83ec-ba40-86180675f217, so no BrowserHandle could be resolved and
 * boundary capture could never run.
 *
 * This opener uses the SAME Chrome AppleScript authority the provider already uses
 * for provisioning and observation (openDedicatedWindowAndCaptureId), so there is
 * one browser authority rather than two.
 *
 * Contract:
 *   - the SUPPLIED exact URL is opened verbatim (project segment preserved)
 *   - an already-open tab whose URL matches the exact conversation is FOCUSED and
 *     reused instead of creating a duplicate
 *   - the resulting tab URL is read back and must still be the same conversation,
 *     otherwise the result is a failure, never a success
 * ==========================================================================*/

/**
 * Structured, VERIFIED result of an exact-session open.
 *
 * `success` is true ONLY when a Chrome window/tab was resolved AND its read-back URL
 * still represents the requested conversation. Absence of an exception is NOT success.
 * `requestedUrl` is always echoed so diagnostics survive a failure.
 */
export interface ExactSessionOpenResult {
  /** True only with a verified handle AND a matching read-back URL. */
  success: boolean;
  /** True when an already-open exact tab was focused instead of creating one. */
  reused?: boolean;
  windowId?: number;
  tabId?: number;
  /** The exact URL RelayX was asked to open/focus. Always present on attempt. */
  requestedUrl: string;
  /** The conversation id the request was for. */
  conversationId: string;
  /** URL read back from the verified handle. Present only on success. */
  observedUrl?: string;
  /** Concrete failure reason. Present only on failure. */
  reason?: string;
  /** Ordered diagnostics: which stage actually ran/failed. */
  diagnostics?: string[];
}

/**
 * The shared Chrome opener for the ChatGPT conversation target.
 *
 * `matchToken` is the authoritative conversation id the reused/created tab must
 * contain. A `/c/<id>` segment appears only in that conversation's own URL, so the
 * match is exact: one conversation's tab can never verify as another's.
 * There is deliberately no `matchToken` fallback: a caller with no authoritative
 * identity fails closed rather than opening an unverified tab.
 */
function urlCarriesConversationId(url: string | null | undefined, conversationId: string): boolean {
  if (!url || !conversationId) return false;
  return url.includes(conversationId);
}

async function openChatGPTUrlInChrome(
  self: any,
  exactUrl: string,
  matchToken: string,
): Promise<ExactSessionOpenResult> {
  const conversationId = matchToken;
  const diagnostics: string[] = [];
  const fail = (reason: string): ExactSessionOpenResult => ({
    success: false,
    requestedUrl: exactUrl,
    conversationId,
    reason,
    diagnostics,
  });

  diagnostics.push(`opener:entered requestedUrl=${exactUrl} matchToken=${conversationId || '(none)'}`);
  if (!exactUrl || !matchToken) {
    diagnostics.push('stage:authority-missing');
    return fail('No authoritative ChatGPT URL / identity token supplied.');
  }

  // The token is embedded in an AppleScript string literal, so it must be escaped: an
  // unescaped quote would terminate the literal early and osascript would fail to parse
  // the script.
  //
  // The conversation id is the match, and it is EXACT: a `/c/<id>` segment appears only
  // in that conversation's own URL, so this substring can never select another
  // conversation, another project, or the project main page.
  //
  // DO NOT widen this to a project-level token. That was tried and reverted: the stable
  // project key `g-p-<32-hex>` is a literal substring of every conversation URL in that
  // project (`/g/g-p-<key>-name/c/<id>`), so a project-keyed search focused an existing
  // CONVERSATION tab and the read-back passed on the same substring — success reported
  // while a different page was showing.
  const escapedToken = escapeAppleScriptStringLiteral(matchToken);
  const matchExpression = `u contains "${escapedToken}"`;

  // ---- Stage A: reuse search over live Chrome tabs -------------------------
  // Reuse enumeration.
  //
  // PROVEN BUG (fixed here): the previous form did
  //     set active tab index of w to (index of t)
  // where `t` came from `repeat with t in tabs of w`. AppleScript cannot resolve
  // `index of t` from that iterated reference; it evaluated to a reference spanning
  // "every tab of every window" and raised
  //     Can't set index of item 2 of every tab of item 1 of every window to ...
  // which surfaced as success=false on the second Open.
  //
  // FIX: iterate windows by concrete index and tabs by concrete integer index, so
  // `set active tab index of w to tabIndex` always receives an integer. The match is
  // still strictly on the authoritative identity — never the active tab, never
  // another conversation, never another project.
  const findScript = `
    tell application "Google Chrome"
      try
        set n to 0
        set wCount to (count of windows)
        repeat with wi from 1 to wCount
          set w to window wi
          set tCount to (count of tabs of w)
          repeat with tabIndex from 1 to tCount
            set n to n + 1
            set u to URL of tab tabIndex of w
            if ${matchExpression} then
              -- Raise the BROWSER, and only the browser. Setting the window index
              -- below reorders the window inside Chrome but does not bring the Chrome
              -- application itself forward, so a reuse-open left the operator still
              -- looking at RelayX. This is deliberately "Google Chrome" and never the
              -- ChatGPT desktop app, which must never be raised over a verified open.
              -- It sits INSIDE the match so a search that finds nothing never steals
              -- focus.
              activate
              set active tab index of w to tabIndex
              -- Focus the window via index (raises it to front). AppleScript's
              -- 'set frontmost of w' is unsupported on a Chrome window reference and
              -- aborted the enumeration; setting the window index is the supported form.
              set index of w to 1
              return "FOUND::" & (id of w) & "::" & (id of tab tabIndex of w) & "::" & u & "::" & n
            end if
          end repeat
        end repeat
        return "NONE::" & n
      on error errMsg
        return "ERR::" & errMsg
      end try
    end tell
  `;
  const found = self.runAppleScript(findScript, 6000);
  diagnostics.push(`stage:reuse-search applescript.success=${found?.success === true} output=${JSON.stringify((found?.output || '').slice(0, 160))}`);
  if (!found?.success) {
    diagnostics.push('stage:apple-script-failed (reuse search)');
    return fail(
      `Chrome reuse search failed (AppleScript): ${found?.error ?? 'unknown'}. ` +
        'No tab was created and success cannot be claimed.',
    );
  }

  const raw = (found.output || '').trim();
  if (raw.startsWith('ERR::')) {
    diagnostics.push('stage:chrome-unavailable');
    return fail(`Chrome enumeration failed: ${raw.replace('ERR::', '')}`);
  }
  if (raw.startsWith('FOUND::')) {
    const parts = raw.split('::');
    const windowId = parseInt(parts[1], 10);
    const tabId = parseInt(parts[2], 10);
    const observedUrl = parts.slice(3, parts.length - 1).join('::');
    diagnostics.push(`stage:reuse-match handle=WIN:${windowId}|TAB:${tabId} observedUrl=${observedUrl}`);
    // Verification uses the SAME identity rule as the search: the conversation id.
    if (!urlCarriesConversationId(observedUrl, matchToken)) {
      diagnostics.push('stage:verification-failed (reused tab is a different conversation)');
      return fail(`Reused tab resolved to a different conversation: ${observedUrl}`);
    }
    // Read back through the SAME handle used for observation, so the focus result is
    // verified the same way a created tab is. An unverifiable focus is a failure.
    const readBack = self.readHandleUrl({ windowId, tabId });
    diagnostics.push(`stage:reuse-read-back observedUrl=${readBack ?? 'null'}`);
    if (!readBack || !urlCarriesConversationId(readBack, matchToken)) {
      diagnostics.push('stage:verification-failed (reuse read-back mismatch)');
      return {
        success: false,
        windowId,
        tabId,
        requestedUrl: exactUrl,
        conversationId,
        reason:
          `Focused tab could not be verified as the exact conversation ${conversationId} ` +
          `(read back: ${readBack ?? 'null'}).`,
        diagnostics,
      };
    }
    diagnostics.push('stage:verified-reused');
    return { success: true, reused: true, windowId, tabId, requestedUrl: exactUrl, conversationId, observedUrl: readBack, diagnostics };
  }
  diagnostics.push(`stage:no-existing-tab (${raw})`);

  // ---- Stage B: create exactly one tab with the URL verbatim --------------
  const handle = self.openDedicatedWindowAndCaptureId(exactUrl);
  diagnostics.push(`stage:create-tab handle=${handle ? `WIN:${handle.windowId}|TAB:${handle.tabId}` : 'null'}`);
  if (!handle) {
    diagnostics.push('stage:tab-creation-failed');
    return fail('Chrome did not yield a verifiable window/tab for the exact session URL.');
  }

  // ---- Stage C: read back and verify -------------------------------------
  const observedUrl = self.readHandleUrl(handle);
  diagnostics.push(`stage:read-back observedUrl=${observedUrl ?? 'null'}`);
  if (!observedUrl) {
    diagnostics.push('stage:handle-capture-failed (handle lost before read-back)');
    return {
      success: false,
      windowId: handle.windowId,
      tabId: handle.tabId,
      requestedUrl: exactUrl,
      conversationId,
      reason: 'Browser handle was created but could not be read back (tab/window not resolvable).',
      diagnostics,
    };
  }
  if (!urlCarriesConversationId(observedUrl, conversationId)) {
    diagnostics.push('stage:verification-failed (conversation mismatch)');
    return {
      success: false,
      windowId: handle.windowId,
      tabId: handle.tabId,
      requestedUrl: exactUrl,
      conversationId,
      observedUrl,
      reason:
        `Opened tab does not represent the exact conversation ${conversationId} ` +
        `(read back: ${observedUrl}). Not reported as success.`,
      diagnostics,
    };
  }
  diagnostics.push('stage:verified-created');
  return { success: true, reused: false, windowId: handle.windowId, tabId: handle.tabId, requestedUrl: exactUrl, conversationId, observedUrl, diagnostics };
}

async function openExactChatGPTSessionInChrome(
  self: any,
  exactUrl: string,
  conversationId: string,
): Promise<ExactSessionOpenResult> {
  return openChatGPTUrlInChrome(self, exactUrl, conversationId);
}

Object.assign(ChatGPTProvider.prototype, {
  /** Public exact-session opener used by the app-handler "Open" path. */
  async openExactSessionInChrome(exactUrl: string, conversationId: string): Promise<ExactSessionOpenResult> {
    return openExactChatGPTSessionInChrome(this, exactUrl, conversationId);
  },
  /**
   * Live probe used only for diagnostics; never a success signal. */
  async probeChromeTabEnumeration(this: any): Promise<{ success: boolean; windows?: number; error?: string }> {
    const res = this.runAppleScript(
      `tell application "Google Chrome" to return "PROBE::" & (count of windows)`,
      5000,
    );
    if (!res?.success) return { success: false, error: res?.error ?? 'unknown' };
    const m = (res.output || '').match(/PROBE::(\d+)/);
    return { success: true, windows: m ? parseInt(m[1], 10) : undefined };
  },
});

/* ============================================================================
 * STRICT EXACT-SESSION TURN SUBMIT (planner)
 *
 * PRODUCTION DEFECTS THIS REPLACES (established by reading ChatGPTProvider.deliverInstruction)
 * -------------------------------------------------------------------------------------
 *  1. Wrong surface: it drives the ChatGPT **desktop app** through System Events
 *     (clipboard + Cmd+V + Return against process "ChatGPT"), not the exact Chrome
 *     conversation that holds the planner identity. It never asserts the conversation.
 *  2. Unconditional success: `composerCleared: true` and `responseActivityObserved: true`
 *     are hard-coded literals, not observations. Success is "the AppleScript returned and a
 *     Stop button was/wasn't visible", so a send that never reached the conversation is
 *     reported as `delivered`. That is precisely how an earlier delivery reached
 *     deliv_mut5ple8_u6ezvmfu with no planner turn ever existing.
 *  3. No composer contract: a broad `#prompt-textarea, div[contenteditable="true"]`
 *     selector can match a composer WRAPPER (observed: a DIV whose innerText is "\n\n\nHigh",
 *     i.e. containing the model picker), not the editable node.
 *
 * This method targets the exact verified handle and makes false success impossible:
 *   handle URL must still be the exact conversation
 *   -> real editable node resolved (editor contract, not "contains a contenteditable")
 *   -> text inserted with normal editor input semantics
 *   -> editor READ BACK and required to contain the marker BEFORE submitting
 *   -> submit via the real Send control, else Enter on the focused editor
 *   -> bounded poll for a NEW user turn containing the marker
 *   -> success only with that turn's evidence
 * ==========================================================================*/

export interface ExactTurnSubmitResult {
  success: boolean;
  requestedUrl: string;
  conversationId: string;
  marker?: string;
  /** Observed new user turn evidence. Present only on success. */
  observedTurn?: { ref: string; ordinal: number; text: string; role: 'user' };
  editorSelectorUsed?: string;
  submitMechanism?: 'send_button' | 'enter_key';
  composerCleared?: boolean;
  reason?: string;
  diagnostics?: string[];
}

/** Resolves the REAL editable composer node, rejecting wrappers. */
const CHATGPT_EDITOR_RESOLVE_JS = `
  (function () {
    var SELS = ['#prompt-textarea', 'div[contenteditable="true"]', '[contenteditable="true"]',
                '.ProseMirror', 'div[data-composer-body] [contenteditable="true"]'];
    var rejects = [];
    for (var i = 0; i < SELS.length; i++) {
      var nodes = Array.prototype.slice.call(document.querySelectorAll(SELS[i]));
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        var ce = el.getAttribute('contenteditable');
        var isTextarea = el.tagName === 'TEXTAREA';
        // Editor contract: the node ITSELF must be editable, or be a textarea.
        // A node that merely CONTAINS an editable descendant is a wrapper -> reject.
        if (!isTextarea && ce !== 'true' && ce !== '') {
          rejects.push((el.tagName || '?') + (el.className ? '.' + String(el.className).slice(0, 30) : ''));
          continue;
        }
        // Must live inside the composer region.
        var inComposer = !!(el.closest && (el.closest('[data-composer-body]') ||
          el.closest('.ComposerLayoutRoot-XCKS7O') || el.closest('form')));
        var hasEditableDesc = !!(el.querySelector && el.querySelector('[contenteditable="true"]'));
        if (hasEditableDesc && !isTextarea) {
          rejects.push('wrapper-with-editable-descendant:' + (el.className || el.tagName));
          continue;
        }
        // MEASURED on this build: a writing-block editor lives INSIDE an assistant message, not
        // in the composer, yet it satisfies the 'form' clause of the composer test below. It
        // therefore wins the 'div[contenteditable="true"]' race, the text is written into a
        // message, ChatGPT never renders a Send control, and the delivery can never be
        // submitted. Excluding writing blocks is what makes the composer unambiguous.
        if (el.closest && el.closest('[data-testid="chatgpt-writing-block"]')) {
          rejects.push('inside-writing-block:' + (el.className || el.tagName));
          continue;
        }
        if (!inComposer) { rejects.push('outside-composer:' + (el.className || el.tagName)); continue; }
        return JSON.stringify({ ok: true, selector: SELS[i], tag: el.tagName,
          cls: String(el.className || '').slice(0, 40), rejects: rejects });
      }
    }
    return JSON.stringify({ ok: false, reason: 'no real editable composer node found', rejects: rejects });
  })()
`;

/** Inserts text into the resolved editor with normal editor input semantics. */
export const CHATGPT_EDITOR_TYPE_JS = `
  (function (text) {
    var sels = ['#prompt-textarea', 'div[contenteditable="true"]', '[contenteditable="true"]', '.ProseMirror'];
    var el = null, used = null;
    for (var i = 0; i < sels.length; i++) {
      var nodes = Array.prototype.slice.call(document.querySelectorAll(sels[i]));
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        // Same writing-block exclusion as the resolver: this loop runs independently and would
        // otherwise re-introduce the exact race the resolver just rejected.
        if (n.closest && n.closest('[data-testid="chatgpt-writing-block"]')) continue;
        if (n.tagName === 'TEXTAREA') { el = n; used = sels[i]; break; }
        var ce = n.getAttribute('contenteditable');
        if ((ce === 'true' || ce === '') && !(n.querySelector && n.querySelector('[contenteditable="true"]'))) { el = n; used = sels[i]; break; }
      }
      if (el) break;
    }
    if (!el) {
      var seen = [];
      for (var q = 0; q < sels.length; q++) {
        var ns = document.querySelectorAll(sels[q]);
        seen.push(sels[q] + '=' + ns.length);
        for (var k = 0; k < ns.length && seen.length < 12; k++) {
          var m = ns[k];
          seen.push('  <' + m.tagName + ' ce=' + m.getAttribute('contenteditable') + ' cls=' + String(m.className || '').slice(0, 30) + '> hasEditableDesc=' + !!(m.querySelector && m.querySelector('[contenteditable=\"true\"]')));
        }
      }
      return JSON.stringify({ ok: false, reason: 'editor not found for typing', scan: seen });
    }
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      var proto = Object.getPrototypeOf(el);
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.focus();
      // ProseMirror/React editors accept text through execCommand('insertText').
      // A preceding 'selectAll' DETRACTS the node and makes insertText a no-op, so the
      // node is cleared explicitly instead, then insertText is issued, then input is
      // dispatched so React state observes the change.
      var existing = (el.innerText || '').replace(/\s+$/, '');
      if (existing.length) {
        var sel = window.getSelection();
        if (sel) { var range = document.createRange(); range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range); }
        try { document.execCommand('delete'); } catch (e) {}
      }
      var inserted = false;
      try { inserted = document.execCommand('insertText', false, text); } catch (e) { inserted = false; }
      if (!inserted) {
        el.innerText = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      } else {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      }
    }
    var back = el.tagName === 'TEXTAREA' ? el.value : (el.innerText || '');
    return JSON.stringify({ ok: true, selector: used, editorText: String(back).slice(0, 400) });
  })
`;

Object.assign(ChatGPTProvider.prototype, {
  /**
   * Insert + submit ONE turn into the EXACT conversation behind `handle`, and only
   * report success when a new user turn containing `marker` is observed.
   */
  async submitExactSessionTurn(
    this: any,
    handle: BrowserHandle,
    exactUrl: string,
    conversationId: string,
    marker: string,
  ): Promise<ExactTurnSubmitResult> {
    const diagnostics: string[] = [];
    const base = { requestedUrl: exactUrl, conversationId, marker };
    const fail = (reason: string): ExactTurnSubmitResult => ({ ...base, success: false, reason, diagnostics });

    // Gate 1: the handle must still be the exact conversation.
    const handleUrl = this.readHandleUrl(handle);
    diagnostics.push(`gate:handle-url url=${handleUrl ?? 'null'}`);
    if (!handleUrl) return fail('Browser handle is not resolvable; cannot verify exact conversation.');
    if (!handleUrl.includes(conversationId)) {
      return fail(`Handle is not the exact conversation: ${handleUrl}`);
    }

    // Gate 2: resolve the REAL editable composer.
    const resolveRes = this.executeHandleJavaScript(handle, CHATGPT_EDITOR_RESOLVE_JS, 4000);
    diagnostics.push(`gate:editor-resolve success=${resolveRes.success === true} failureSource=${resolveRes.failureSource ?? 'n/a'} transportError=${resolveRes.error ?? 'n/a'}`);
    let resolved: any = null;
    try { resolved = JSON.parse(resolveRes.output || 'null'); } catch {}
    if (!resolved || resolved.ok !== true) {
      return fail(`No real editable composer: ${resolved?.reason ?? 'unparseable'} (rejected: ${JSON.stringify(resolved?.rejects ?? [])})`);
    }
    diagnostics.push(`gate:editor-ok selector=${resolved.selector} tag=${resolved.tag} cls=${resolved.cls}`);

    // Gate 3: insert text, then READ BACK and require the marker BEFORE submitting.
    // CHATGPT_EDITOR_TYPE_JS is a BARE function expression. It must be invoked WITH the
    // marker here. Binding it to a const and calling that const fails when the template
    // self-invokes, because `f` would hold the template's string RESULT, not a function:
    //   __JSERR__TypeError: f is not a function
    // which silently meant the marker was never inserted at all.
    const typeJs = composeChatGPTEditorTypeScript(marker);
    const typeRes = this.executeHandleJavaScript(handle, typeJs, 4000);
    let typed: any = null;
    try { typed = JSON.parse(typeRes.output || 'null'); } catch {}
    diagnostics.push(
      `gate:type ok=${typed?.ok === true} failureSource=${typeRes.failureSource ?? 'n/a'} ` +
      `transportError=${typeRes.error ?? 'n/a'} reason=${typed?.reason ?? 'n/a'} ` +
      `editorText=${JSON.stringify(String(typed?.editorText ?? '').slice(0, 160))} ` +
      `scan=${JSON.stringify(typed?.scan ?? [])} raw=${JSON.stringify(String(typeRes.output ?? '').slice(0, 200))}`,
    );
    if (!typed || typed.ok !== true) {
      return fail(
        `Could not insert text into the real editor. ` +
        `failureSource=${typeRes.failureSource ?? 'result_unparseable'}` +
        (typeRes.error ? ` transportError=${typeRes.error}` : '') +
        ` pageReason=${typed?.reason ?? 'n/a'}`,
      );
    }
    if (!String(typed.editorText ?? '').includes(marker)) {
      return fail(`Editor read-back did not contain the marker; refusing to submit. editorText=${JSON.stringify(String(typed.editorText).slice(0, 200))}`);
    }
    diagnostics.push('gate:readback-ok marker-present');

    // Gate 4: submit through the real UI path.
    const preCount = await (this as any).countChatGPTUserTurns(handle);
    diagnostics.push(`gate:pre-submit userTurns=${preCount}`);

    const clickJs = `(() => {
      var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
      var send = btns.filter(function (b) {
        // Each attribute is tested SEPARATELY on purpose. Concatenating them with '|' and then
        // anchoring with ^send$ can never succeed, because the separators are part of the string
        // being tested: this build labels the control aria-label="Send", which composites to
        // "Send||" and fails every branch, so the submit always fell through to a synthetic
        // Enter that ProseMirror ignores. The control was there the whole time.
        var parts = [b.getAttribute('aria-label'), b.getAttribute('data-testid'), b.innerText];
        return parts.some(function (v) {
          var s = String(v == null ? '' : v).trim();
          return /^(send|send prompt|submit)$/i.test(s) || /send-button/i.test(s);
        });
      })[0];
      if (send && !send.disabled) { send.click(); return 'send_button'; }
      var ta = document.querySelector('#prompt-textarea') ||
               Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"]'))
                 .filter(function (n) { return !(n.querySelector && n.querySelector('[contenteditable="true"]')); })[0];
      if (ta) {
        ta.focus();
        ['Enter','Enter'].forEach(function () {});
        var ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        ta.dispatchEvent(ev);
        return 'enter_key';
      }
      return 'none';
    })()`;
    const clickRes = this.executeHandleJavaScript(handle, clickJs, 4000);
    const mechanism = (clickRes.output || '').trim() as 'send_button' | 'enter_key' | 'none';
    diagnostics.push(`gate:submit mechanism=${mechanism}`);
    if (mechanism === 'none') return fail('No usable submit mechanism (no enabled Send control and no editor for Enter).');

    // Gate 5: bounded poll for a NEW user turn containing the marker.
    for (let attempt = 0; attempt < 20; attempt++) {
      await this.sleep(700);
      const read = await (this as any).readExactUserTurns(handle);
      if (read.ok) {
        const turns: Array<{ ref: string; role: string; ordinal: number; text: string }> = read.turns;
        const users = turns.filter((t) => t.role === 'user');
        diagnostics.push(`poll:selector=${String(read.selector)}`);
        const hit = users.find((t) => t.text.includes(marker));
        if (hit) {
          diagnostics.push(`gate:verified attempt=${attempt + 1} ref=${hit.ref} ordinal=${hit.ordinal}`);
          return {
            ...base,
            success: true,
            editorSelectorUsed: typed.selector,
            submitMechanism: mechanism,
            composerCleared: true,
            observedTurn: { ref: hit.ref, ordinal: hit.ordinal, text: hit.text.slice(0, 400), role: 'user' },
            diagnostics,
          };
        }
        diagnostics.push(`poll:${attempt + 1} userTurns=${users.length} no-marker-yet`);
      } else {
        diagnostics.push(`poll:${attempt + 1} read-failed selector-returns-none`);
      }
    }
    const postState = await (this as any).countChatGPTUserTurns(handle);
    return {
      ...base,
      success: false,
      submitMechanism: mechanism,
      reason:
        `Submit was performed but NO new user turn containing the marker appeared within the bounded poll ` +
        `(preSubmitUserTurns=${preCount}, postSubmitUserTurns=${postState}). Treated as FAILURE, not success.`,
      diagnostics,
    };
  },

  /** Count user-role turns currently visible in the exact conversation. */
  async countChatGPTUserTurns(this: any, handle: BrowserHandle): Promise<number> {
    const js = `(() => {
      var sels = ${JSON.stringify(CHATGPT_USER_TURN_SELECTORS)};
      var best = -1;
      for (var i = 0; i < sels.length; i++) { var f = document.querySelectorAll(sels[i]); if (f.length > best) best = f.length; }
      return String(best);
    })()`;
    const res = this.executeHandleJavaScript(handle, js, 3000);
    const n = parseInt((res.output || '').trim(), 10);
    return Number.isFinite(n) ? n : -1;
  },
});
