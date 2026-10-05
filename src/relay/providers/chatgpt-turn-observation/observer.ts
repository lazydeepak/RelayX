// ChatGPT Plan — observeSide / captureTransportBoundary / readExactSessionTurns implementation
// Uses BrowserHandle (existing mechanism) — not new automation.
// FAILS SAFELY: DOM miss / handle lost / selector miss → unknown/unavailable, NEVER fabricated.

import { ChatGPTTurnIdentity, ChatGPTWatermark } from './selectors';

// 1. observeSide — observe exact session turn state
// Returns enough to say: no new turn / generating / completed turn / unavailable
export interface ChatGPTObserverResult {
  sideRole: 'planner';
  externalSessionId: string; // conversation id
  sessionUrl: string;
  observing: boolean;         // did BrowserHandle resolve?
  state: 'idle' | 'generating' | 'completed_new' | 'completed_same' | 'unknown';
  completedTurn?: ChatGPTTurnIdentity | null;
  previousTurn?: ChatGPTTurnIdentity | null;
  boundaryEstablished: boolean;
  watermark?: ChatGPTWatermark | null;
  stale: boolean;            // is observed turn older than stored watermark?
  evidenceSource: 'chrome_dom';
  failureReason?: string;
}

// 2. captureTransportBoundary — read pre-send turn set
export interface ChatGPTBoundaryResult {
  watermark: ChatGPTWatermark | null;
  failure: string | null;    // never fabricated null — must be honest failure
  readable: boolean;
}

// 3. readExactSessionTurnsForReconciliation — post-send transcript
export interface ChatGPTTranscriptResult {
  readable: boolean;
  turns: ChatGPTTurnIdentity[];  // ordered by ordinal
  failure: string | null;
}
