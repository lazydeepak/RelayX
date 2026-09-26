import { parseChatGPTConversationUrl } from '../relay/providers/adapters.ts';
import type { ChatGPTConversationChoice, WorkerChoice } from '../types/relayApi.ts';

/**
 * Pure helper contract for PairModal's explicit ChatGPT conversation selection.
 * The user pastes the exact URL of the specific existing conversation they intend
 * to pair; nothing here reads Chrome, samples the active tab, or infers a
 * conversation from a window title or project. The confirmed URL is forwarded to
 * relayBridge.createPair(..., plannerConversationUrl) — the committed binding
 * contract — which performs the authoritative verification atomically.
 */

export interface ParsedConversationUrl {
  projectId: string;
  conversationId: string;
}

export type ConversationUrlValidation =
  | { ok: true; parsed: ParsedConversationUrl }
  | { ok: false; reason: string };

const VALIDATION_HINT = 'https://chatgpt.com/g/<g-p-project>/c/<conversationId>';

/** Strict validation of a pasted conversation URL (whitespace-trimmed). */
export function validateChatGPTConversationUrl(url: string): ConversationUrlValidation {
  const trimmed = url.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: 'Enter the URL of the specific ChatGPT conversation you intend to pair.',
    };
  }
  const parsed = parseChatGPTConversationUrl(trimmed);
  if (!parsed) {
    return {
      ok: false,
      reason: `URL must have the form ${VALIDATION_HINT} — paste the exact conversation URL.`,
    };
  }
  return { ok: true, parsed };
}

/** Shortened external-ID snippet for display; the full id stays in state/service. */
export function shortenExternalId(externalId: string | null | undefined, max = 16): string | null {
  if (!externalId) return null;
  return externalId.length <= max ? externalId : `${externalId.slice(0, max)}…`;
}

/**
 * The selected planner runtime is already bound to a DIFFERENT conversation:
 * returns the bound conversation id so the modal can block submission.
 * Re-binding the exact same conversation is idempotent and not a conflict.
 */
export function findPlannerIdConflict<T extends { externalSessionId?: string | null }>(
  planner: T | undefined,
  conversationId: string | null,
): string | null {
  if (!planner || !conversationId) return null;
  const bound = planner.externalSessionId;
  if (bound && bound !== conversationId) return bound;
  return null;
}

/**
 * The entered conversation is already bound to a DIFFERENT runtime: returns that
 * runtime so the modal can show a clear pre-submit conflict.
 */
export function findConversationConflict<T extends { id: string; externalSessionId?: string | null }>(
  runtimes: T[],
  selectedPlannerId: string,
  conversationId: string | null,
): T | null {
  if (!conversationId) return null;
  return runtimes.find((r) => r.id !== selectedPlannerId && r.externalSessionId === conversationId) ?? null;
}

/** Gate for the explicit confirmation control shown before submission. */
export interface ConfirmGateParams {
  plannerSelected: boolean;
  conversationValid: boolean;
  plannerConflictBoundId: string | null;
  conversationConflictRuntimeId: string | null;
}

export function canConfirmConversation(params: ConfirmGateParams): boolean {
  return (
    params.plannerSelected &&
    params.conversationValid &&
    !params.plannerConflictBoundId &&
    !params.conversationConflictRuntimeId
  );
}

/** Review line pairing the selected planner runtime with the full entered URL. */
export interface ConversationReview {
  plannerLabel: string;
  url: string;
}

export function describeConversationReview(
  plannerName: string,
  plannerProviderType: string,
  plannerBoundExternalId: string | null,
  url: string,
): ConversationReview {
  const bound = shortenExternalId(plannerBoundExternalId);
  return {
    plannerLabel: `${plannerName} (${plannerProviderType.toUpperCase()})${bound ? ` • bound: ${bound}` : ''}`,
    url: url.trim(),
  };
}

/**
 * The exact argument set the new UI flow forwards to
 * relayBridge.createPair(projectId, name, plannerSessionId, workerSessionId,
 * plannerConversationUrl). The confirmed conversation URL is always passed as
 * the 5th argument — never omitted, never replaced by a sampled chrome tab.
 */
export interface CreatePairArgs {
  projectId: string;
  name: string;
  plannerSessionId: string | undefined;
  workerSessionId: string | undefined;
  plannerConversationUrl: string;
}

export function buildCreatePairArgs(
  projectId: string,
  name: string,
  plannerSessionId: string | undefined,
  workerSessionId: string | undefined,
  plannerConversationUrl: string,
): CreatePairArgs {
  return {
    projectId,
    name: name.trim(),
    plannerSessionId: plannerSessionId || undefined,
    workerSessionId: workerSessionId || undefined,
    plannerConversationUrl: plannerConversationUrl.trim(),
  };
}

/** Select-option label for an enumerated ChatGPT conversation choice. */
export function describeConversationChoice(choice: Pick<ChatGPTConversationChoice, 'conversationId' | 'source' | 'paired' | 'lastSeenAt'>): string {
  const parts = [
    shortenExternalId(choice.conversationId, 14) ?? choice.conversationId,
    choice.source === 'bound' ? 'bound' : 'observed',
  ];
  if (choice.paired) parts.push('in active pair');
  if (choice.lastSeenAt) parts.push(`seen ${new Date(choice.lastSeenAt).toLocaleDateString()}`);
  return parts.join(' • ');
}

/** Select-option label for a discovered (adoptable) OpenCode worker session. */
export function describeDiscoveredWorkerChoice(choice: Extract<WorkerChoice, { kind: 'discovered' }>): string {
  const short = shortenExternalId(choice.sessionId, 14) ?? choice.sessionId;
  if (choice.sessionTitle) return `${choice.sessionTitle} — ${short}`;
  return choice.windowTitle ? `${short} — ${choice.windowTitle}` : short;
}
