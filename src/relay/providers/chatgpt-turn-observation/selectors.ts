// ChatGPT Authoritative Transport Extension — BrowserHandle/DOM mechanism
// Uses existing executeHandleJavaScript() / BrowserHandle / AppleScript bridge.
// FAILS SAFELY: any DOM read failure → unknown/unavailable (never fabricated positive/negative).
// Does NOT change delivery mechanism (AppleScript/DOM injection stays); only adds observation/verification.

export interface ChatGPTTurnIdentity {
  sessionId: string;           // external session id (conversation id from URL)
  role: 'user' | 'assistant';
  ordinal: number;             // provider ordering (0, 1, 2, ... within session)
  fullContentHash: string;     // deterministic hash of full text content
  createdAt?: number;          // when turn was created (if DOM exposes)
}

export interface ChatGPTObservationResult {
  reachable: boolean;         // can BrowserHandle resolve?
  generating: boolean;         // is assistant producing?
  completedTurn?: ChatGPTTurnIdentity | null;  // latest completed assistant turn after any boundary
  previousTurn?: ChatGPTTurnIdentity | null;   // turn before completedTurn (for ordering)
  boundaryEstablished: boolean;
  watermark?: ChatGPTWatermark | null;
  evidence: {
    source: 'chrome_dom';
    handleValid: boolean;
    selectorUsed: string;
    domReadSuccess: boolean;
    extractionMethod: 'messageDataAttr' | 'messageContainer' | 'fallback';
    failureReason?: string;
  };
}

export interface ChatGPTWatermark {
  sessionId: string;
  messageCount: number;
  messageIds: string[];        // turn identifiers from DOM (best available)
  latestOrdinal: number;
  capturedAt: number;
}

// DOM extraction selectors — must be safe (fail to unknown if selector miss)
export const DOM_SELECTOR_PRIMARY = '[data-message-author-role="assistant"]';
export const DOM_SELECTOR_MESSAGE = '[data-testid="conversation-turn"]';
