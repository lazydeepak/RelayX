/**
 * Authoritative ChatGPT tab URL acquisition — replaces front-window dependence.
 *
 * RULES (per user's instruction; verified against live Chrome evidence):
 * - No `front window` assumption (C above shows wrong-tab adoption risk).
 * - Read from the specific tab created/identified by BrowserHandle, not whichever
 *   window happens to be frontmost.
 * - Return URL only from that retained tab identity; never derive/synthesize id.
 * - Root `chatgpt.com/` accepted only as transient; must settle to `/c/<id>`.
 * - Auth: real URL from real Chrome tab; no mock, no UUID invention.
 */

// Build AppleScript that creates (or verifies) a tab at url, then returns
// the identity of that tab so the caller can read from it later.
export function buildAuthoritativeTabCreateAppleScript(url: string): string {
  const escapedUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // Create tab at END of a target window (not front) to avoid adoption error.
  // Return both window index + tab index for retention.
  return `
    tell application "Google Chrome"
      activate
      set targetWindow to window 1
      try
        tell targetWindow
          set newTab to (make new tab with properties {URL:"${escapedUrl}"})
        end tell
        set tabIndex to index of newTab
        return "TAB_CREATE_OK|||" & (index of targetWindow) & "|||" & tabIndex
      on error errMsg
        return "TAB_CREATE_FAIL|||" & errMsg
      end try
    end tell
  `;
}

// Read URL from the RETAINED tab identity (windowIndex + tabIndex), NOT front window.
export function buildAuthoritativeTabReadAppleScript(windowIndex: number, tabIndex: number): string {
  return `
    tell application "Google Chrome"
      try
        set w to window ${windowIndex}
        set t to tab ${tabIndex} of w
        set urlTxt to URL of t
        -- Only return authoritative if REAL conversation route (not root, not wrong site)
        if urlTxt contains "/chatgpt.com/c/" then
          return "TAB_OK|||" & urlTxt & "|||W" & ${windowIndex} & "T" & ${tabIndex}
        else
          return "TAB_TRANSIENT|||" & urlTxt & "|||W" & ${windowIndex} & "T" & ${tabIndex} & "||NOT_CONVERSATION"
        end if
      on error errMsg
        return "TAB_READ_FAIL|||" & errMsg & "|||W" & ${windowIndex} & "T" & ${tabIndex}
      end try
    end tell
  `;
}

// Bounded settlement: poll same retained tab; accept only real /c/; fail honestly.
export interface TabSettlementResult {
  ok: boolean;
  url?: string;
  transient?: boolean;     // was root /c/ present earlier but not settled
  settledAt?: number;
  failure?: string;         // honest failure — never synthesized success
  windowIndex?: number;
  tabIndex?: number;
  attempts: number;
  maxAttempts: number;
}

export async function pollTabSettlement(
  readFn: (w: number, t: number) => Promise<{ ok: boolean; url?: string; error?: string; identity?: string }>,
  windowIndex: number,
  tabIndex: number,
  maxAttempts = 10,
  intervalMs = 1500,
): Promise<TabSettlementResult> {
  let attempts = 0;
  let lastUrl: string | undefined;
  let transientSeen = false;

  for (let i = 0; i < maxAttempts; i++) {
    attempts++;
    const res = await readFn(windowIndex, tabIndex);
    if (res.ok && res.url) {
      lastUrl = res.url;
      // Root chatgpt.com/ is transient, NOT authoritative conversation.
      const hasConvRoute = /\/c\/[^/?#]/.test(lastUrl);
      if (hasConvRoute) {
        return {
          ok: true,
          url: lastUrl,
          settledAt: Date.now(),
          transient: transientSeen,
          failure: undefined,
          windowIndex,
          tabIndex,
          attempts,
          maxAttempts,
        };
      }
      // Root or other non-conversation URL: record as transient, continue polling.
      if (lastUrl.includes('chatgpt.com') && !hasConvRoute) {
        transientSeen = true;
      }
    } else if (res.error) {
      // Read failed — honest failure of this poll; continue if attempts remain.
      // If all attempts fail, return failure — do not invent success.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // Timeout / never settled — honest failure.
  return {
    ok: false,
    url: lastUrl,
    transient: transientSeen,
    failure: lastUrl ? `Tab ${windowIndex}/${tabIndex} never settled to /c/<id>; last URL: ${lastUrl}` : `Tab ${windowIndex}/${tabIndex} unreadable after ${maxAttempts} polls (window/tab identity preserved: W${windowIndex}T${tabIndex})`,
    windowIndex,
    tabIndex,
    attempts,
    maxAttempts,
  };
}
