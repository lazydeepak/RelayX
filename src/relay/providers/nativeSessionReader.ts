import { normalizeNativeEndpoint } from './nativeOpenCodeDiscovery';
import type { NativeServerRecord } from './nativeServerLifecycle';

export interface NativeTranscriptMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  createdAt: number;
  completedAt?: number;
  parentId?: string;
  providerId: string;
  modelId: string;
  parts: Array<{ id: string; type: string; text?: string }>;
}
export type NativeSessionRead = {
  status: 'READ'; serverId: string; serverRevision: number; apiSpecHash: string;
  observedAt: number; session: { id: string; directory: string; title?: string };
  messages: NativeTranscriptMessage[];
  /** A fetched page is not proof of a complete transcript or task completion. */
  completeHistory: false;
} | { status: 'BLOCKED'; reason: string };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function time(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
class ReadError extends Error {}

/** Exact-session GET-only reader. Caller explicitly supplies inspection freshness
 * policy; no default TTL, task completion inference or GUI/CLI fallback exists.
 */
export async function readNativeSession(store: { get(serverId: string): NativeServerRecord | undefined }, options: {
  serverId: string; sessionId: string; directory: string; observedAt: number;
  maximumInspectionAgeMs: number; fetch: typeof fetch; signal: AbortSignal;
  messageLimit: number;
  resolveAuthorization: (keyRef: string) => Promise<string | undefined>;
}): Promise<NativeSessionRead> {
  const blocked = (reason: string): NativeSessionRead => ({ status: 'BLOCKED', reason });
  const stored = store.get(options.serverId);
  if (!stored || stored.lifecycle !== 'INSPECTED' || !stored.inspection) return blocked('SERVER_NOT_INSPECTED');
  const server = structuredClone(stored);
  if (!server.inspection) return blocked('SERVER_NOT_INSPECTED');
  if (server.inspection.compatibility?.sessionRead !== true || server.inspection.compatibility?.messageRead !== true) return blocked('API_UNSUPPORTED');
  if (!time(options.observedAt) || !time(options.maximumInspectionAgeMs) || options.observedAt < server.updatedAt
    || options.observedAt < server.inspection.observedAt || options.observedAt - server.inspection.observedAt >= options.maximumInspectionAgeMs) return blocked('INSPECTION_NOT_CURRENT');
  if (!/^ses_[A-Za-z0-9_-]+$/.test(options.sessionId) || !server.projectRoots.includes(options.directory)) return blocked('SESSION_SCOPE_NOT_AUTHORIZED');
  if (!Number.isSafeInteger(options.messageLimit) || options.messageLimit < 1) return blocked('INVALID_PAGE_LIMIT');
  let endpoint: string;
  try { endpoint = normalizeNativeEndpoint(server.endpoint); } catch { return blocked('INVALID_ENDPOINT'); }
  const current = () => {
    const record = store.get(server.serverId);
    return record?.revision === server.revision && record.lifecycle === 'INSPECTED'
      && record.endpoint === endpoint && record.inspection?.apiSpecHash === server.inspection?.apiSpecHash;
  };
  let authorization: string | undefined;
  try { authorization = await options.resolveAuthorization(server.authKeyRef); }
  catch { return blocked('AUTH_UNAVAILABLE'); }
  if (!current()) return blocked('SUPERSEDED');
  if (!authorization) return blocked('AUTH_UNAVAILABLE');
  const get = async (path: string): Promise<unknown> => {
    if (!current()) throw new ReadError('SUPERSEDED');
    const url = new URL(path, endpoint); url.searchParams.set('directory', options.directory);
    if (path.endsWith('/message')) url.searchParams.set('limit', String(options.messageLimit));
    const response = await options.fetch(url.href, { method: 'GET', headers: { Accept: 'application/json', Authorization: authorization! },
      signal: options.signal, credentials: 'omit', redirect: 'error' });
    if (!current()) throw new ReadError('SUPERSEDED');
    if (response.status === 401 || response.status === 403) throw new ReadError('AUTH_FAILED');
    if (response.status === 404) throw new ReadError('SESSION_NOT_FOUND');
    if (!response.ok) throw new ReadError('SERVER_UNAVAILABLE');
    try { return await response.json(); } catch { throw new ReadError('RESPONSE_INVALID'); }
  };
  try {
    const path = `/session/${encodeURIComponent(options.sessionId)}`;
    const session = await get(path);
    if (!object(session) || session.id !== options.sessionId || session.directory !== options.directory) throw new ReadError('SESSION_IDENTITY_MISMATCH');
    const rawMessages = await get(`${path}/message`);
    if (!Array.isArray(rawMessages) || rawMessages.length > options.messageLimit) throw new ReadError('RESPONSE_INVALID');
    const messageIds = new Set<string>(); const partIds = new Set<string>();
    const messages: NativeTranscriptMessage[] = [];
    for (const message of rawMessages) {
      if (!object(message) || !object(message.info) || !Array.isArray(message.parts)) throw new ReadError('RESPONSE_INVALID');
      const info = message.info;
      if (!text(info.id) || info.sessionID !== options.sessionId || messageIds.has(info.id)) throw new ReadError('MESSAGE_IDENTITY_MISMATCH');
      messageIds.add(info.id);
      if ((info.role !== 'user' && info.role !== 'assistant') || !object(info.time) || !time(info.time.created)) throw new ReadError('RESPONSE_INVALID');
      const role = info.role as 'user' | 'assistant';
      if (info.time.completed !== undefined && (role !== 'assistant' || !time(info.time.completed) || info.time.completed < info.time.created)) throw new ReadError('RESPONSE_INVALID');
      const model = role === 'user' ? info.model : { providerID: info.providerID, modelID: info.modelID };
      if (!object(model) || !text(model.providerID) || !text(model.modelID) || (role === 'assistant' && (!text(info.parentID) || info.parentID === info.id))) throw new ReadError('RESPONSE_INVALID');
      const parts: NativeTranscriptMessage['parts'] = [];
      for (const part of message.parts) {
        if (!object(part) || !text(part.id) || part.sessionID !== options.sessionId || part.messageID !== info.id || partIds.has(part.id)) throw new ReadError('PART_IDENTITY_MISMATCH');
        partIds.add(part.id);
        if (!text(part.type)) throw new ReadError('RESPONSE_INVALID');
        if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text !== 'string') throw new ReadError('RESPONSE_INVALID');
        parts.push({ id: part.id, type: part.type, ...((part.type === 'text' || part.type === 'reasoning') ? { text: part.text as string } : {}) });
      }
      messages.push({ id: info.id, sessionId: options.sessionId, role, createdAt: info.time.created,
        ...(info.time.completed !== undefined ? { completedAt: info.time.completed as number } : {}),
        ...(role === 'assistant' ? { parentId: info.parentID as string } : {}), providerId: model.providerID, modelId: model.modelID, parts });
    }
    if (!current()) return blocked('SUPERSEDED');
    return { status: 'READ', serverId: server.serverId, serverRevision: server.revision, apiSpecHash: server.inspection.apiSpecHash,
      observedAt: options.observedAt, session: { id: options.sessionId, directory: options.directory, ...(text(session.title) ? { title: session.title } : {}) },
      messages, completeHistory: false };
  } catch (error) { return blocked(error instanceof ReadError ? error.message : 'SERVER_UNAVAILABLE'); }
}
