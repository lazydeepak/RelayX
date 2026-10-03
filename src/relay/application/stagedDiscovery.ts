/**
 * Pure, framework-agnostic state model for the two independent "Add Project"
 * discovery stages:
 *
 *   1. ChatGPT planner binding (`PlannerDiscoveryState`)
 *   2. OpenCode worker binding  (`OpenCodeDiscoveryState`)
 *
 * Each stage is modelled independently. Every reducer here only consumes and
 * returns its own stage's state, so discovering (or failing to discover) one
 * provider can never mutate or erase the other provider's confirmed binding.
 *
 * This module deliberately contains NO provider-specific discovery behaviour.
 * The actual discovery is performed by the ChatGPT and OpenCode providers
 * (see `relay/providers/adapters.ts`); the orchestration/API boundary is
 * `RelayApiService`. This module only translates a discovery *result* into
 * stage state and enforces the "bindings must carry a real identifier" rule.
 */

import type { IRelayApi } from '../../types/relayApi.ts';
import {
  isChatGPTProjectLessUrl,
  parseChatGPTProjectUrl,
  type ChatGPTProjectUrlIdentity,
} from '../providers/chatgptProjectUrl.ts';
import { chatgptProjectDiscoveryError } from '../providers/chatgptProjectDiscovery.ts';

/** Independent lifecycle for a single provider's discovery stage. */
export type DiscoveryStageStatus = 'idle' | 'discovering' | 'discovered' | 'failed';

export interface PlannerDiscoveryEvidence {
  finalUrl?: string;
  projectName?: string;
  /** The stable external ChatGPT Project identity (`/g/<g-p-…>`). */
  projectId?: string;
  /** The canonical ChatGPT Project URL persisted as the project binding. */
  canonicalProjectUrl?: string;
  recordedAt: number;
}

export interface PlannerDiscoveryState {
  status: DiscoveryStageStatus;
  /** The validated ChatGPT project binding identifier (URL). */
  url?: string;
  /** Candidate projects that matched ambiguously and need user confirmation. */
  multiple?: Array<{ name: string; url: string }>;
  error?: string;
  diagnostics?: unknown;
  /** Truthful evidence recorded for the confirmed binding. */
  evidence?: PlannerDiscoveryEvidence;
}

/**
 * Resolves ANY ChatGPT Project URL — automatic GUI discovery output or manually
 * pasted — into the one canonical Project binding.
 *
 * This is the shared gate that makes the manual and automatic paths equivalent:
 * both call the same parser, both get the same Project identity, and both reject
 * a URL that carries no Project identity (notably a standalone
 * `/c/<conversationId>` conversation URL, which is SESSION identity).
 */
export function resolvePlannerProjectBinding(
  url: string | null | undefined,
): { ok: true; identity: ChatGPTProjectUrlIdentity } | { ok: false; error: string } {
  const trimmed = (url || '').trim();
  if (!trimmed) {
    return {
      ok: false,
      error: chatgptProjectDiscoveryError('INVALID_PROJECT_URL', 'no URL was provided'),
    };
  }
  const identity = parseChatGPTProjectUrl(trimmed);
  if (!identity) {
    return {
      ok: false,
      error: chatgptProjectDiscoveryError(
        isChatGPTProjectLessUrl(trimmed) ? 'PROJECT_ID_PARSE_FAILED' : 'INVALID_PROJECT_URL',
        trimmed,
      ),
    };
  }
  return { ok: true, identity };
}

export interface OpenCodeWorkerCandidate {
  sessionId: string;
  sessionTitle?: string;
  windowTitle?: string;
  workspacePath?: string;
  matchScore?: number;
  matchedVia?: string;
  openCodeProjectId?: string;
  hasUiCorrelation?: boolean;
}

export interface OpenCodeDiscoveryEvidence {
  sessionId?: string;
  sessionTitle?: string;
  windowTitle?: string;
  matchedVia?: string;
  recordedAt: number;
}

export interface OpenCodeDiscoveryState {
  status: DiscoveryStageStatus;
  workers: OpenCodeWorkerCandidate[];
  /** The validated authoritative OpenCode worker binding identifier. */
  selectedSessionId?: string;
  error?: string;
  diagnostics?: unknown;
  /** Truthful evidence recorded for the confirmed binding. */
  evidence?: OpenCodeDiscoveryEvidence;
}

export const PLANNER_IDLE_STATE: PlannerDiscoveryState = { status: 'idle' };
export const OPENCODE_IDLE_STATE: OpenCodeDiscoveryState = { status: 'idle', workers: [] };

export type PlannerDiscoveryResult = Awaited<
  ReturnType<IRelayApi['discoverChatGPTPlanner']>
>;
export type OpenCodeDiscoveryResult = Awaited<
  ReturnType<IRelayApi['discoverOpenCodeSessions']>
>;

/**
 * A planner binding is valid only when a real project URL was resolved.
 * Activation of Chrome/ChatGPT is NOT sufficient.
 */
export function isPlannerBindingValid(state: PlannerDiscoveryState): boolean {
  return (
    state.status === 'discovered' &&
    typeof state.url === 'string' &&
    state.url.trim().length > 0
  );
}

/**
 * A worker binding is valid only when a real authoritative session identifier
 * was resolved. Opening VS Code/OpenCode is NOT sufficient.
 */
export function isOpenCodeBindingValid(state: OpenCodeDiscoveryState): boolean {
  return (
    state.status === 'discovered' &&
    typeof state.selectedSessionId === 'string' &&
    state.selectedSessionId.trim().length > 0
  );
}

/** Both required bindings are present and validated: setup may complete. */
export function areBothBindingsValid(
  planner: PlannerDiscoveryState,
  opencode: OpenCodeDiscoveryState,
): boolean {
  return isPlannerBindingValid(planner) && isOpenCodeBindingValid(opencode);
}

/** Move the planner stage into `discovering` without touching any other stage. */
export function beginPlannerDiscovery(
  prev: PlannerDiscoveryState,
): PlannerDiscoveryState {
  return { ...prev, status: 'discovering', error: undefined, diagnostics: undefined };
}

/** Move the OpenCode stage into `discovering` without touching any other stage. */
export function beginOpenCodeDiscovery(
  prev: OpenCodeDiscoveryState,
): OpenCodeDiscoveryState {
  return { ...prev, status: 'discovering', error: undefined, diagnostics: undefined };
}

/**
 * Translate a ChatGPT planner discovery result into planner stage state.
 *
 * Success is accepted ONLY when the provider returns an actual validated
 * project URL. A result that merely reports `success: true` without a binding
 * identifier (i.e. "activation-only" success) is rejected as a failure.
 */
export function reducePlannerDiscovery(
  prev: PlannerDiscoveryState,
  result: PlannerDiscoveryResult,
): PlannerDiscoveryState {
  const observedUrl = typeof result.finalUrl === 'string' ? result.finalUrl.trim() : '';

  if (result.success && observedUrl) {
    // The automatic GUI path is validated through the SAME parser as the manual
    // path, so a "success" that carries no Project identity cannot be confirmed.
    const binding = resolvePlannerProjectBinding(observedUrl);
    if (!binding.ok) {
      return {
        ...prev,
        status: 'failed',
        url: undefined,
        multiple: undefined,
        error: binding.error,
        diagnostics: result.diagnostics,
      };
    }
    return {
      ...prev,
      status: 'discovered',
      url: binding.identity.canonicalProjectUrl,
      multiple: undefined,
      error: undefined,
      diagnostics: result.diagnostics,
      evidence: {
        finalUrl: observedUrl,
        canonicalProjectUrl: binding.identity.canonicalProjectUrl,
        projectId: binding.identity.projectId,
        projectName: result.projectName,
        recordedAt: Date.now(),
      },
    };
  }

  // Ambiguous match: retain candidates so the user can explicitly confirm one.
  if (Array.isArray(result.foundMultiple) && result.foundMultiple.length > 0) {
    return {
      ...prev,
      status: 'failed',
      url: undefined,
      multiple: result.foundMultiple,
      error:
        result.error || 'Multiple ChatGPT projects matched. Select one to confirm.',
      diagnostics: result.diagnostics,
    };
  }

  return {
    ...prev,
    status: 'failed',
    url: undefined,
    multiple: undefined,
    error:
      result.error ||
      'ChatGPT planner discovery failed: no validated project URL was found.',
    diagnostics: result.diagnostics,
  };
}

/** Record a planner discovery failure (e.g. thrown bridge error). */
export function failPlannerDiscovery(
  prev: PlannerDiscoveryState,
  message: string,
): PlannerDiscoveryState {
  return { ...prev, status: 'failed', error: message, diagnostics: undefined };
}

/**
 * Translate an OpenCode discovery result into OpenCode stage state.
 *
 * Success is accepted ONLY when at least one candidate carries a real session
 * identifier. A result that merely reports `success: true` without a session
 * identifier (i.e. "activation-only" success) is rejected as a failure.
 */
export function reduceOpenCodeDiscovery(
  prev: OpenCodeDiscoveryState,
  result: OpenCodeDiscoveryResult,
): OpenCodeDiscoveryState {
  const workers: OpenCodeWorkerCandidate[] = (result.sessions || [])
    .map((s: any) => ({
      sessionId: typeof s.sessionId === 'string' ? s.sessionId.trim() : '',
      sessionTitle: s.sessionTitle,
      windowTitle: s.windowTitle,
      workspacePath: s.workspacePath,
      matchScore: s.matchScore,
      matchedVia: s.matchedVia,
      openCodeProjectId: s.openCodeProjectId,
      hasUiCorrelation: s.hasUiCorrelation,
    }))
    .filter((s) => s.sessionId.length > 0);

  if (result.success && workers.length > 0 && result.diagnostics?.ambiguous !== true) {
    const best = workers[0];
    return {
      ...prev,
      status: 'discovered',
      workers,
      selectedSessionId: best.sessionId,
      error: undefined,
      diagnostics: result.diagnostics,
      evidence: {
        sessionId: best.sessionId,
        sessionTitle: best.sessionTitle,
        windowTitle: best.windowTitle,
        matchedVia: best.matchedVia,
        recordedAt: Date.now(),
      },
    };
  }

  if (result.success && workers.length > 0 && result.diagnostics?.ambiguous === true) {
    return {
      ...prev,
      status: 'failed',
      workers,
      selectedSessionId: undefined,
      error: 'Multiple OpenCode sessions matched. Select one to confirm.',
      diagnostics: result.diagnostics,
      evidence: undefined,
    };
  }

  return {
    ...prev,
    status: 'failed',
    workers: [],
    selectedSessionId: undefined,
    error:
      result.error ||
      'OpenCode discovery failed: no matching worker session was found.',
    diagnostics: result.diagnostics,
  };
}

/** Record an OpenCode discovery failure (e.g. thrown bridge error). */
export function failOpenCodeDiscovery(
  prev: OpenCodeDiscoveryState,
  message: string,
): OpenCodeDiscoveryState {
  return { ...prev, status: 'failed', error: message, diagnostics: undefined };
}

/** Confirm one of several ambiguous planner candidates. */
export function selectPlannerCandidate(
  prev: PlannerDiscoveryState,
  candidate: { name: string; url: string },
): PlannerDiscoveryState {
  const binding = resolvePlannerProjectBinding(candidate.url);
  if (!binding.ok) {
    return {
      ...prev,
      status: 'failed',
      url: undefined,
      multiple: prev.multiple,
      error: binding.error,
    };
  }
  return {
    ...prev,
    status: 'discovered',
    url: binding.identity.canonicalProjectUrl,
    multiple: undefined,
    error: undefined,
    evidence: {
      finalUrl: candidate.url,
      canonicalProjectUrl: binding.identity.canonicalProjectUrl,
      projectId: binding.identity.projectId,
      projectName: candidate.name,
      recordedAt: Date.now(),
    },
  };
}

/** Confirm a specific OpenCode worker candidate. */
export function selectOpenCodeWorker(
  prev: OpenCodeDiscoveryState,
  worker: OpenCodeWorkerCandidate,
): OpenCodeDiscoveryState {
  return {
    ...prev,
    status: 'discovered',
    selectedSessionId: worker.sessionId,
    error: undefined,
    evidence: {
      sessionId: worker.sessionId,
      sessionTitle: worker.sessionTitle,
      windowTitle: worker.windowTitle,
      matchedVia: worker.matchedVia,
      recordedAt: Date.now(),
    },
  };
}

/**
 * Manually confirm a ChatGPT project URL entered by the user.
 *
 * Runs through the same parser as automatic discovery, so a manual paste and an
 * automated run produce the identical canonical Project binding — and an
 * unbindable URL (no `/g/<g-p-…>`, e.g. a bare `/c/<conversationId>`) is
 * rejected instead of being bound.
 */
export function applyPlannerUrl(
  prev: PlannerDiscoveryState,
  url: string,
): PlannerDiscoveryState {
  const trimmed = (url || '').trim();
  if (!trimmed) {
    return {
      ...prev,
      status: 'failed',
      url: undefined,
      error: 'Enter a ChatGPT project URL or session identifier.',
    };
  }
  const binding = resolvePlannerProjectBinding(trimmed);
  if (!binding.ok) {
    return {
      ...prev,
      status: 'failed',
      url: undefined,
      error: binding.error,
    };
  }
  return {
    ...prev,
    status: 'discovered',
    url: binding.identity.canonicalProjectUrl,
    multiple: undefined,
    error: undefined,
    evidence: {
      finalUrl: trimmed,
      canonicalProjectUrl: binding.identity.canonicalProjectUrl,
      projectId: binding.identity.projectId,
      recordedAt: Date.now(),
    },
  };
}

/** Manually confirm an authoritative OpenCode session id entered by the user. */
export function applyOpenCodeSession(
  prev: OpenCodeDiscoveryState,
  sessionId: string,
): OpenCodeDiscoveryState {
  const trimmed = (sessionId || '').trim();
  if (!trimmed) {
    return {
      ...prev,
      status: 'failed',
      selectedSessionId: undefined,
      error: 'Enter an authoritative OpenCode session identifier.',
    };
  }
  return {
    ...prev,
    status: 'discovered',
    selectedSessionId: trimmed,
    error: undefined,
    evidence: { sessionId: trimmed, recordedAt: Date.now() },
  };
}
