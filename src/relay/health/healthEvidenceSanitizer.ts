/**
 * Phase 1 health — shared evidence sanitizer.
 *
 * ## Why this is shared, not duplicated
 *
 * The Health UI and the external-worker handoff report both surface detector
 * evidence to a human or an external agent. Two independent filters would mean the
 * weaker one eventually governs, so there is exactly ONE sanitiser and both
 * consumers use it.
 *
 * ## The rule
 *
 * DROP, do not truncate. A truncated transcript still ships user content; a
 * dropped one does not. Oversized and non-scalar values are simply absent from
 * the output, which is also why every consumer must be able to state "this field
 * is unavailable" rather than implying it is empty.
 */

/** Maximum length of a string that may be surfaced at all. */
export const HEALTH_EVIDENCE_MAX_STRING_LENGTH = 200;

/** Keys that are never surfaced regardless of their value. */
const ALWAYS_DENIED_KEY_PATTERNS: RegExp[] = [
  /transcript/i,
  /prompt/i,
  /instruction/i,
  /message(body|text|content)/i,
  /instruction(snippet|text)/i,
  /script/i,
  /command/i,
  /argv/i,
  /stdout/i,
  /stderr/i,
  /env(ironment)?/i,
  /secret/i,
  /token/i,
  /password/i,
  /api[-_]?key/i,
  /credential/i,
  /cookie/i,
  /authorization/i,
  /bootstrap/i,
];

export type SanitizedScalar = string | number | boolean | null;

export interface SanitizeResult {
  values: Record<string, SanitizedScalar>;
  /** Keys dropped because of a denied name. */
  redactedKeys: string[];
  /** Keys dropped because of their type or size. */
  omittedKeys: string[];
}

function isDeniedKey(key: string): boolean {
  return ALWAYS_DENIED_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Sanitize one evidence record.
 *
 * Guarantees:
 *   - only string | number | boolean | null survive;
 *   - denied key names never appear in the output at all;
 *   - strings longer than the limit are omitted, never shortened;
 *   - objects and arrays are omitted entirely.
 */
export function sanitizeHealthEvidence(evidence: Record<string, unknown> | null | undefined): SanitizeResult {
  const values: Record<string, SanitizedScalar> = {};
  const redactedKeys: string[] = [];
  const omittedKeys: string[] = [];

  for (const [key, value] of Object.entries(evidence ?? {})) {
    if (isDeniedKey(key)) {
      redactedKeys.push(key);
      continue;
    }
    if (value === null) { values[key] = null; continue; }
    const t = typeof value;
    if (t === 'string') {
      const s = value as string;
      if (s.length > HEALTH_EVIDENCE_MAX_STRING_LENGTH) { omittedKeys.push(key); continue; }
      values[key] = s;
      continue;
    }
    if (t === 'number' || t === 'boolean') { values[key] = value as SanitizedScalar; continue; }
    omittedKeys.push(key);
  }

  return { values, redactedKeys, omittedKeys };
}

/**
 * Sanitize a free-text reason/message before it reaches a report.
 *
 * A reason string can legitimately contain a fragment of a prompt, so an
 * over-long or newline-bearing reason is reduced to a single bounded line rather
 * than reproduced.
 */
export function sanitizeHealthText(value: unknown, maxLength = 160): string | null {
  if (typeof value !== 'string') return null;
  const flattened = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!flattened) return null;
  if (flattened.length > maxLength) {
    return `${flattened.slice(0, maxLength)} [truncated: ${flattened.length} chars]`;
  }
  return flattened;
}
