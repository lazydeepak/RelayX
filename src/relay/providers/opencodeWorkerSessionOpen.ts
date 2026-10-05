/**
 * Session-ID-authoritative resolution + deterministic foreground gating for
 * "Open Worker session" in OpenCode Desktop.
 *
 * ## Why this module exists
 *
 * `OpenCodeProvider.activateRuntime` used to drive OpenCode Desktop with four blind
 * keystrokes (`Cmd+B`, `Cmd+K`, the session TITLE, `Return`) and reported success from
 * the `osascript` exit code. Two independent defects made that unreliable:
 *
 * 1. **It searched by a mutable label, not by the authoritative session id.** The
 *    keystrokes typed `runtime.name`, which RelayX owns and which is never refreshed from
 *    OpenCode. Rename the session in OpenCode and the search silently matched nothing (or a
 *    different session). The persisted `externalSessionId` (`ses_…`) is the only stable
 *    identity OpenCode itself agrees with, so it is now read FIRST, through the shared
 *    OpenCode service (`GET /api/session/{id}`), and only the resulting TITLE is used as
 *    navigation metadata for the Desktop UI.
 *
 * 2. **It never verified that OpenCode owned the foreground before each keystroke.**
 *    `tell application "System Events" to tell process "OpenCode" to keystroke …` does NOT
 *    address the keystroke to that process: System Events delivers synthetic events to
 *    whatever application is frontmost. The old code called `activate` once, slept a fixed
 *    0.5 s, and then fired ~2.4 s of keystrokes on trust. If anything stole focus in that
 *    window — including RelayX's OWN ChatGPT planner discovery, which runs
 *    `tell application "Google Chrome" to activate` — every keystroke was delivered to that
 *    other application: OpenCode never opened, the typed title landed in a browser, and
 *    `osascript` still exited 0 so RelayX reported success.
 *
 *    This module makes each keystroke conditional on an OBSERVED foreground state instead
 *    of on a sleep having elapsed. There is deliberately no "wait longer and hope": if the
 *    foreground cannot be confirmed before the budget expires, the automation aborts
 *    WITHOUT sending the remaining keystrokes and reports why.
 */

import {
  discoverOpenCodeSessionClient,
  type OpenCodeSessionClient,
} from './opencodeSessionClient.ts';

/* ------------------------------------------------------------------ */
/* Session-ID-authoritative preflight                                  */
/* ------------------------------------------------------------------ */

export type WorkerOpenPreflightFailure =
  /** No authoritative `ses_…` id is bound, so there is nothing to resolve. */
  | 'no_authoritative_session_id'
  /** The shared OpenCode service could not be reached / authenticated. */
  | 'metadata_service_unavailable'
  /** The bound id does not exist on the service any more. */
  | 'session_not_found'
  /** More than one session in the same directory carries this exact title. */
  | 'ambiguous_title'
  /** The session has no usable title, so it cannot be selected in the Desktop UI. */
  | 'title_unusable';

export interface OpenCodeWorkerOpenTarget {
  /** The authoritative id. NEVER inferred, never replaced by a title match. */
  externalSessionId: string;
  /** Live title read from OpenCode for that exact id. */
  title: string;
  /** Workspace directory that id belongs to, as OpenCode reports it. */
  directory: string;
  /** True when the caller's stored display title is stale and should be refreshed. */
  titleChanged: boolean;
  /** The caller's stored display title, for the record. */
  storedTitle: string | null;
  /** Other session ids in the same directory that share this exact title (case-folded). */
  duplicateTitleSessionIds: string[];
}

export type OpenCodeWorkerOpenPreflight =
  | { ok: true; target: OpenCodeWorkerOpenTarget }
  | { ok: false; failure: WorkerOpenPreflightFailure; error: string; externalSessionId?: string };

/**
 * Resolve the exact title to type into OpenCode Desktop's session switcher.
 *
 * Rules, in order, and none of them is negotiable:
 *   - the bound `externalSessionId` is the identity; a missing id is a refusal, not a
 *     fallback to "find something that looks like the title";
 *   - a metadata lookup failure is reported as a failure; nothing is rebound;
 *   - the title is refreshed from the provider whenever it drifted;
 *   - if the refreshed title is ambiguous inside the session's own directory, the open is
 *     REFUSED, because the Desktop UI can only be driven by title and guessing between two
 *     identically named sessions is exactly the "silently opened the wrong session" bug.
 */
export async function resolveOpenCodeWorkerOpenTarget(options: {
  externalSessionId: string | null | undefined;
  storedTitle?: string | null;
  client?: OpenCodeSessionClient | null;
  discover?: () => Promise<{ discovery: any; client: OpenCodeSessionClient | null }>;
}): Promise<OpenCodeWorkerOpenPreflight> {
  const externalSessionId = (options.externalSessionId || '').trim();
  if (!externalSessionId) {
    return {
      ok: false,
      failure: 'no_authoritative_session_id',
      error:
        'No authoritative OpenCode session id (ses_…) is bound to this worker, so there is no identity to open.',
    };
  }

  let client = options.client ?? null;
  if (!client) {
    const discover =
      options.discover ??
      (async () => {
        const r = await discoverOpenCodeSessionClient();
        return { discovery: r.discovery, client: r.client };
      });
    const resolved = await discover();
    client = resolved.client;
    if (!client) {
      const failure = (resolved.discovery?.failure ?? 'service_metadata_missing') as string;
      return {
        ok: false,
        failure: 'metadata_service_unavailable',
        externalSessionId,
        error:
          `OpenCode session metadata is unavailable (${failure}): ` +
          `${resolved.discovery?.error ?? 'the shared OpenCode service could not be discovered'}. ` +
          'The worker was NOT rebound and no other session was chosen.',
      };
    }
  }

  let live: { title?: string; directory?: string };
  try {
    const res = await client.getSession(externalSessionId);
    live = res.session;
  } catch (err: any) {
    if (err?.code === 'session_not_found') {
      return {
        ok: false,
        failure: 'session_not_found',
        externalSessionId,
        error:
          `OpenCode session ${externalSessionId} no longer exists on the shared service. ` +
          'The worker was NOT rebound and no other session was chosen.',
      };
    }
    return {
      ok: false,
      failure: 'metadata_service_unavailable',
      externalSessionId,
      error:
        `OpenCode session metadata lookup failed for ${externalSessionId}: ` +
        `${err?.message ?? String(err)}. The worker was NOT rebound and no other session was chosen.`,
    };
  }

  const title = (live.title || '').trim();
  if (!title) {
    return {
      ok: false,
      failure: 'title_unusable',
      externalSessionId,
      error:
        `OpenCode session ${externalSessionId} reports no title, so the Desktop UI cannot be ` +
        'driven to it. The worker was NOT rebound and no other session was chosen.',
    };
  }

  // Uniqueness gate. Scoped to the session's OWN directory, because that is the scope the
  // Desktop UI lists and searches: two identically named sessions there are
  // indistinguishable through the title search, so refuse instead of guessing.
  const directory = (live.directory || '').trim();
  const duplicates: string[] = [];
  if (directory) {
    try {
      const listed = await client.listSessionsByDirectory(directory, { limit: 500 });
      const needle = title.toLowerCase();
      for (const s of listed.sessions) {
        if (s.sessionId === externalSessionId) continue;
        if ((s.title || '').trim().toLowerCase() === needle) duplicates.push(s.sessionId);
      }
      // Bounded set; the count is reported separately so the message stays readable.
      duplicates.sort();
    } catch (err: any) {
      // The directory listing is an ADDITIONAL safety gate, not the identity. If it cannot
      // be read we must not invent ambiguity, but we also must not claim the open is safe:
      // report it so the caller decides.
      return {
        ok: false,
        failure: 'metadata_service_unavailable',
        externalSessionId,
        error:
          `Could not enumerate OpenCode sessions in ${directory} to prove title uniqueness: ` +
          `${err?.message ?? String(err)}. The worker was NOT rebound and no other session was chosen.`,
      };
    }
  }

  if (duplicates.length > 0) {
    return {
      ok: false,
      failure: 'ambiguous_title',
      externalSessionId,
      error:
        `OpenCode session ${externalSessionId} is titled "${title}", but ` +
        `${duplicates.length} other session(s) in ${directory} share that exact title ` +
        `(${duplicates.join(', ')}). OpenCode Desktop can only be driven by title, so the ` +
        'Worker was NOT opened and no session was guessed. Rename one of them, or bind a ' +
        'session with a unique title.',
    };
  }

  const storedTitle = (options.storedTitle ?? '').trim() || null;
  return {
    ok: true,
    target: {
      externalSessionId,
      title,
      directory,
      titleChanged: storedTitle !== null && storedTitle !== title,
      storedTitle,
      duplicateTitleSessionIds: duplicates,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Foreground-gated keystroke execution                                */
/* ------------------------------------------------------------------ */

export type ForegroundStep =
  | { kind: 'key'; keys: string; label: string }
  | { kind: 'code'; code: number; label: string }
  | { kind: 'wait'; ms: number; label: string };

export interface ForegroundGateHooks {
  /** Read the CURRENT foreground application name. */
  readForegroundApp: () => string | null;
  /** Bring `appName` to the foreground. */
  activateApp: (appName: string) => boolean;
  /** Send one keystroke (`a`, `a using {command down}`, …). */
  sendKey: (keys: string) => void;
  /** Send one raw key code (36 = Return, 53 = Escape). */
  sendKeyCode: (code: number) => void;
  /** Sleep. */
  sleep: (ms: number) => Promise<void>;
  /** Short bounded wait used while polling for a state change to settle. */
  settleMs?: number;
}

export interface ForegroundGatedRunResult {
  /** True only when EVERY step was sent while the target app was verified frontmost. */
  ok: boolean;
  /** Labels of the steps actually sent, in order. */
  sent: string[];
  /** Set when the run aborted; the automation stopped and nothing further was typed. */
  failure?: 'foreground_never_verified' | 'step_send_failed';
  /** Human-readable reason, suitable for surfacing in the UI. */
  error?: string;
  /** Foreground observed immediately before each keystroke — the audit trail. */
  foregroundBeforeEachStep: Array<{ label: string; foreground: string | null }>;
}

/**
 * Run an ordered list of UI steps, but emit each keystroke ONLY while `targetApp` is the
 * OBSERVED foreground application.
 *
 * `settleMs` replaces the old blind sleeps *between* steps with a bounded poll that waits
 * for the target app to become frontmost again after a re-activation. Nothing here waits
 * "longer and hopes": the loop either observes the required state, or it stops.
 */
export async function runForegroundGatedSteps(
  steps: ForegroundStep[],
  targetApp: string,
  hooks: ForegroundGateHooks,
  options: { settleMs?: number; maxForegroundWaitMs?: number } = {},
): Promise<ForegroundGatedRunResult> {
  const settleMs = options.settleMs ?? hooks.settleMs ?? 250;
  const maxForegroundWaitMs = options.maxForegroundWaitMs ?? 3000;

  const sent: string[] = [];
  const foregroundBeforeEachStep: Array<{ label: string; foreground: string | null }> = [];

  /** Wait (bounded) until `targetApp` is the observed foreground app. */
  const ensureForeground = async (): Promise<boolean> => {
    const deadline = Date.now() + maxForegroundWaitMs;
    for (;;) {
      let current: string | null = null;
      try {
        current = hooks.readForegroundApp();
      } catch {
        current = null;
      }
      if (current === targetApp) return true;
      if (Date.now() >= deadline) return false;
      try {
        hooks.activateApp(targetApp);
      } catch {
        /* keep polling; the observed state is the only thing that counts */
      }
      await hooks.sleep(settleMs);
    }
  };

  for (const step of steps) {
    if (step.kind === 'wait') {
      await hooks.sleep(step.ms);
      continue;
    }

    // GATE: nothing is typed until the foreground is observed, not assumed.
    if (!(await ensureForeground())) {
      const observed = (() => {
        try {
          return hooks.readForegroundApp();
        } catch {
          return null;
        }
      })();
      return {
        ok: false,
        sent,
        failure: 'foreground_never_verified',
        foregroundBeforeEachStep,
        error:
          `Aborted before "${step.label}": ${targetApp} never became the foreground application ` +
          `(observed ${observed ?? 'unknown'}). No further keystrokes were sent, so no other ` +
          'application could have received the session title. Close or finish whatever is ' +
          `stealing focus, or bring ${targetApp} forward, and try again.`,
      };
    }

    let observed: string | null = null;
    try {
      observed = hooks.readForegroundApp();
    } catch {
      observed = null;
    }
    foregroundBeforeEachStep.push({ label: step.label, foreground: observed });

    try {
      if (step.kind === 'key') hooks.sendKey(step.keys);
      else hooks.sendKeyCode(step.code);
    } catch (err: any) {
      return {
        ok: false,
        sent,
        failure: 'step_send_failed',
        foregroundBeforeEachStep,
        error: `Failed to send "${step.label}": ${err?.message ?? String(err)}`,
      };
    }
    sent.push(step.label);
    await hooks.sleep(settleMs);
  }

  return { ok: true, sent, foregroundBeforeEachStep };
}

/**
 * The OpenCode Desktop sequence, expressed as explicit steps.
 *
 * `escape` first clears any palette/switcher left over from an earlier attempt: a stale
 * open palette is what makes the typed title land in the wrong surface.
 */
export function buildOpenCodeWorkerOpenSteps(title: string): ForegroundStep[] {
  const escaped = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    { kind: 'code', code: 53, label: 'dismiss any leftover switcher (Escape)' },
    { kind: 'wait', ms: 150, label: 'settle after Escape' },
    // The character MUST stay a quoted AppleScript string literal: `keystroke b` (bare
    // identifier) fails with `The variable b is not defined (-2753)` and would abort the
    // sequence before the session search ever ran.
    { kind: 'key', keys: '"b" using {command down}', label: 'normalize to Home (Cmd+B)' },
    { kind: 'key', keys: '"k" using {command down}', label: 'open session switcher (Cmd+K)' },
    { kind: 'key', keys: `"${escaped}"`, label: 'type the refreshed session title' },
    { kind: 'code', code: 36, label: 'open the selected session (Return)' },
  ];
}
