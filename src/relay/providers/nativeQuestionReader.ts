import { normalizeNativeEndpoint } from './nativeOpenCodeDiscovery';
import type { NativeServerRecord } from './nativeServerLifecycle';

export interface NativePendingQuestion {
  requestId: string;
  sessionId: string;
  messageId: string;
  callId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple: boolean;
    custom: boolean;
  }>;
}
export type NativeQuestionRead = {
  status: 'READ'; serverId: string; serverRevision: number; apiSpecHash: string;
  observedAt: number; sessionId: string; directory: string;
  questions: NativePendingQuestion[];
  completePendingSet: true;
} | { status: 'BLOCKED'; reason: string };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function time(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
class QuestionReadError extends Error {}

/** Reads the server's current pending-question set and filters it to one exact
 * session. A question without tool message/call correlation is not actionable.
 */
export async function readNativePendingQuestions(
  store: { get(serverId: string): NativeServerRecord | undefined },
  options: {
    serverId: string; sessionId: string; directory: string; observedAt: number;
    maximumInspectionAgeMs: number; fetch: typeof fetch; signal: AbortSignal;
    resolveAuthorization: (keyRef: string) => Promise<string | undefined>;
  },
): Promise<NativeQuestionRead> {
  const blocked = (reason: string): NativeQuestionRead => ({ status: 'BLOCKED', reason });
  const stored = store.get(options.serverId);
  if (!stored || stored.lifecycle !== 'INSPECTED' || !stored.inspection) return blocked('SERVER_NOT_INSPECTED');
  const server = structuredClone(stored);
  if (!server.inspection) return blocked('SERVER_NOT_INSPECTED');
  if (server.inspection.compatibility?.questionRead !== true) return blocked('API_UNSUPPORTED');
  if (!time(options.observedAt) || !time(options.maximumInspectionAgeMs) || options.observedAt < server.updatedAt
    || options.observedAt < server.inspection.observedAt
    || options.observedAt - server.inspection.observedAt >= options.maximumInspectionAgeMs) return blocked('INSPECTION_NOT_CURRENT');
  if (!/^ses_[A-Za-z0-9_-]+$/.test(options.sessionId) || !server.projectRoots.includes(options.directory)) return blocked('SESSION_SCOPE_NOT_AUTHORIZED');
  let endpoint: string;
  try { endpoint = normalizeNativeEndpoint(server.endpoint); } catch { return blocked('INVALID_ENDPOINT'); }
  const current = () => {
    const record = store.get(server.serverId);
    return record?.revision === server.revision && record.lifecycle === 'INSPECTED'
      && record.endpoint === endpoint && record.inspection?.apiSpecHash === server.inspection?.apiSpecHash;
  };
  let authorization: string | undefined;
  try { authorization = await options.resolveAuthorization(server.authKeyRef); } catch { return blocked('AUTH_UNAVAILABLE'); }
  if (!current()) return blocked('SUPERSEDED');
  if (!authorization) return blocked('AUTH_UNAVAILABLE');
  try {
    const url = new URL('/question', endpoint); url.searchParams.set('directory', options.directory);
    const response = await options.fetch(url.href, { method: 'GET', headers: { Accept: 'application/json', Authorization: authorization },
      signal: options.signal, credentials: 'omit', redirect: 'error' });
    if (!current()) throw new QuestionReadError('SUPERSEDED');
    if (response.status === 401 || response.status === 403) throw new QuestionReadError('AUTH_FAILED');
    if (!response.ok) throw new QuestionReadError('SERVER_UNAVAILABLE');
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new QuestionReadError('RESPONSE_INVALID'); }
    if (!Array.isArray(raw)) throw new QuestionReadError('RESPONSE_INVALID');
    const requests = new Set<string>(); const calls = new Set<string>();
    const questions: NativePendingQuestion[] = [];
    for (const candidate of raw) {
      if (!object(candidate) || !text(candidate.id) || !text(candidate.sessionID) || !Array.isArray(candidate.questions)) throw new QuestionReadError('RESPONSE_INVALID');
      if (candidate.sessionID !== options.sessionId) continue;
      if (requests.has(candidate.id)) throw new QuestionReadError('QUESTION_IDENTITY_MISMATCH');
      requests.add(candidate.id);
      if (!object(candidate.tool) || !text(candidate.tool.messageID) || !text(candidate.tool.callID)) throw new QuestionReadError('QUESTION_CORRELATION_MISSING');
      const callKey = `${candidate.tool.messageID}\u0000${candidate.tool.callID}`;
      if (calls.has(callKey)) throw new QuestionReadError('QUESTION_CORRELATION_DUPLICATE');
      calls.add(callKey);
      if (candidate.questions.length === 0) throw new QuestionReadError('RESPONSE_INVALID');
      const normalized = candidate.questions.map(item => {
        if (!object(item) || !text(item.question) || !text(item.header) || !Array.isArray(item.options) || item.options.length === 0
          || (item.multiple !== undefined && typeof item.multiple !== 'boolean')
          || (item.custom !== undefined && typeof item.custom !== 'boolean')) throw new QuestionReadError('RESPONSE_INVALID');
        const labels = new Set<string>();
        const options = item.options.map(option => {
          if (!object(option) || !text(option.label) || !text(option.description) || labels.has(option.label)) throw new QuestionReadError('RESPONSE_INVALID');
          labels.add(option.label); return { label: option.label, description: option.description };
        });
        return { question: item.question, header: item.header, options, multiple: item.multiple === true, custom: item.custom === true };
      });
      questions.push({ requestId: candidate.id, sessionId: options.sessionId,
        messageId: candidate.tool.messageID, callId: candidate.tool.callID, questions: normalized });
    }
    if (!current()) return blocked('SUPERSEDED');
    return { status: 'READ', serverId: server.serverId, serverRevision: server.revision,
      apiSpecHash: server.inspection.apiSpecHash, observedAt: options.observedAt,
      sessionId: options.sessionId, directory: options.directory, questions, completePendingSet: true };
  } catch (error) { return blocked(error instanceof QuestionReadError ? error.message : 'SERVER_UNAVAILABLE'); }
}
