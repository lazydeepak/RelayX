// Full message retrieval — exact bound conversation via BrowserHandle/DOM
// Returns complete latest assistant turn; does NOT use snippet.
// Failure → null (not fabricated); caller treats as unavailable.

import { ChatGPTTurnIdentity, ChatGPTWatermark } from './selectors';

export interface RetrievalEvidence {
  source: 'chrome_dom';
  handleValid: boolean;
  selectorMatched: boolean;
  fullTextLength: number;
  extractionMethod: string;
  failure?: string;
}

export function extractTurnIdentity(
  sessionUrl: string,
  domText: string,
  ordinal: number,
  handleValid: boolean,
): ChatGPTTurnIdentity | null {
  // Deterministic identity: session + role + ordinal + content hash
  // Timestamp NOT used as identity (per user's instruction — avoid timestamp-only)
  if (!handleValid || !domText || domText.length === 0) return null;
  const sessionId = sessionUrl.match(/\/c\/([^/?#]+)/)?.[1] ?? 'unknown';
  // Simple deterministic hash (production: use js-sha256 or similar)
  let hash = 0;
  for (let i = 0; i < domText.length; i++) hash = ((hash << 5) - hash) + domText.charCodeAt(i);
  return {
    sessionId,
    role: 'assistant',
    ordinal,
    fullContentHash: String(hash >>> 0),
    createdAt: undefined, // prefer ordinal + hash; timestamp only corroboration
  };
}

export function buildWatermark(
  sessionId: string,
  turns: ChatGPTTurnIdentity[],
  capturedAt: number,
): ChatGPTWatermark {
  return {
    sessionId,
    messageCount: turns.length,
    messageIds: turns.map((t) => `${t.sessionId}::${t.ordinal}::${t.fullContentHash}`),
    latestOrdinal: turns.length > 0 ? turns[turns.length - 1].ordinal : -1,
    capturedAt,
  };
}
