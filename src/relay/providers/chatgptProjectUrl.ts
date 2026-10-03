/**
 * THE single ChatGPT Project URL parser for RelayX.
 *
 * Identity distinction enforced here (never to be conflated):
 *
 *   ChatGPT Project ID        = external PROJECT identity  (`/g/<g-p-...>`)
 *   ChatGPT Conversation ID   = external SESSION identity  (`/c/<conversationId>`)
 *   ChatGPT Project URL       = canonical navigation/supporting value
 *
 * A conversation ID must never be adopted as a Project ID. A bare
 * `https://chatgpt.com/c/<conversationId>` URL therefore yields `null` here.
 *
 * Both the automatic GUI Project discovery flow and the manual pasted-URL
 * fallback go through this module, so both produce the same canonical Project
 * binding for the same input.
 */

/** The stable ChatGPT Project identity plus its canonical navigation URL. */
export interface ChatGPTProjectUrlIdentity {
  /** Stable ChatGPT Project identifier, e.g. `g-p-<key>` or `g-p-<key>-name`. */
  projectId: string;
  /** Canonical Project root URL: `https://chatgpt.com/g/<projectId>/project`. */
  canonicalProjectUrl: string;
}

/** True when the host is ChatGPT itself (never a look-alike such as `notchatgpt.com`). */
export function isChatGPTHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return h === 'chatgpt.com' || h.endsWith('.chatgpt.com');
}

/**
 * Extracts the `g-p-…` Project identifier from any observed ChatGPT URL.
 *
 * Supported shapes (project identity present, trailing content allowed):
 *   https://chatgpt.com/g/<g-p-id>
 *   https://chatgpt.com/g/<g-p-id>/project
 *   https://chatgpt.com/g/<g-p-id>/c/<conversationId>
 *   https://chatgpt.com/g/<g-p-id>/…?query#hash
 *
 * Returns `null` for: off-host URLs, custom-GPT `/g/g-…` links that carry no
 * project identity, bare `/c/<conversationId>` conversation URLs, and junk.
 *
 * This is deliberately the STRICT modern-shape extractor. It stays
 * `g-p-`-only because conversation reconciliation relies on it rejecting
 * custom-GPT links and anything that is not a modern Project. Legacy `/p/<id>`
 * project URLs are handled by `parseChatGPTProjectUrl` instead.
 */
export function extractChatGPTProjectIdFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed) {
    if (!isChatGPTHost(parsed.hostname)) return null;
    const match = parsed.pathname.match(/\/g\/(g-p-[^/]+)(?:\/|$)/);
    return match?.[1] ?? null;
  }
  // Non-absolute reference (e.g. a stored bare slug or a relative path).
  const raw = url.trim().match(/(?:^|\/g\/)(g-p-[^/?#]+)/i);
  return raw?.[1] ?? null;
}

/**
 * Canonicalizes a ChatGPT Project URL to its project root form.
 * `…/g/<g-p-id>/c/<conv>` -> `https://chatgpt.com/g/<g-p-id>/project`
 */
export function canonicalizeChatGPTProjectUrlFromUrl(url: string | null | undefined): string | null {
  const projectId = extractChatGPTProjectIdFromUrl(url);
  if (!projectId) return null;
  try {
    const parsed = new URL(String(url));
    if (isChatGPTHost(parsed.hostname)) {
      return `https://chatgpt.com/g/${projectId}/project`;
    }
  } catch {
    // fall through to the chatgpt.com default below
  }
  return `https://chatgpt.com/g/${projectId}/project`;
}

/**
 * Parses an observed URL into the stable ChatGPT Project identity.
 *
 * Two Project URL shapes are recognized, matching the formats this codebase has
 * always observed:
 *
 *   modern   https://chatgpt.com/g/<g-p-id>[/…]   identity `g-p-<id>`
 *   legacy   https://chatgpt.com/p/<slug>[/…]      identity `<slug>`
 *
 * Each is canonicalized to its own root form, so a legacy binding round-trips
 * unchanged instead of being rewritten into a shape ChatGPT never produced.
 *
 * Fails closed: returns `null` whenever the URL carries no Project identity —
 * including a standalone `/c/<conversationId>` URL, which is SESSION identity and
 * must never be bound as a Project.
 */
export function parseChatGPTProjectUrl(url: string | null | undefined): ChatGPTProjectUrlIdentity | null {
  const modernId = extractChatGPTProjectIdFromUrl(url);
  if (modernId) {
    return { projectId: modernId, canonicalProjectUrl: `https://chatgpt.com/g/${modernId}/project` };
  }

  const legacyId = extractLegacyChatGPTProjectIdFromUrl(url);
  if (legacyId) {
    return { projectId: legacyId, canonicalProjectUrl: `https://chatgpt.com/p/${legacyId}` };
  }

  return null;
}

/**
 * Extracts the identifier from a legacy `https://chatgpt.com/p/<slug>` Project
 * URL. Legacy projects have no `g-p-` prefix, so this shape is kept separate
 * from the modern extractor rather than folded into it.
 */
export function extractLegacyChatGPTProjectIdFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (!isChatGPTHost(parsed.hostname)) return null;
  const match = parsed.pathname.match(/^\/p\/([^/?#]+)(?:\/|$)/);
  const slug = match?.[1];
  // A bare `/p/` with no slug is not a Project identity.
  return slug ? slug : null;
}

/**
 * True when the URL is a ChatGPT URL with no Project identity — a standalone
 * conversation (`/c/<conversationId>`) or a non-project route such as the
 * `/projects` listing.
 *
 * Used only to choose the most precise failure stage; never to bind anything.
 */
export function isChatGPTProjectLessUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string' || !url.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (!isChatGPTHost(parsed.hostname)) return false;
  return !parseChatGPTProjectUrl(url);
}