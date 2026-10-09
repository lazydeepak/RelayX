import { createHash } from 'node:crypto';
import { normalizeNativeEndpoint } from './nativeOpenCodeDiscovery';
import type { NativeServerRecord } from './nativeServerLifecycle';

export interface NativeEventObservation {
  providerEventId: string;
  eventType: string;
  sessionId: string;
  messageId?: string;
  partId?: string;
  dataHash: string;
  observedOrder: number;
}
export type NativeEventRead = {
  status: 'READ'; serverId: string; serverRevision: number; apiSpecHash: string;
  observedAt: number; directory: string; sessionId: string;
  priorEventId?: string; lastEventId?: string;
  continuity: 'INITIAL' | 'UNVERIFIED_RECONNECT';
  events: NativeEventObservation[];
  connectionEnded: boolean;
  streamBoundary: 'EOF' | 'EVENT_LIMIT';
  requiresAuthoritativeReconciliation: boolean;
} | { status: 'BLOCKED'; reason: string };

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function time(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
class EventError extends Error {}

/** Observes a bounded prefix of one SSE connection. Last-Event-ID is a reconnect
 * request, not proof the server replayed every missed event, so reconnects always
 * require authoritative transcript/question reconciliation.
 */
export async function observeNativeEvents(store: { get(serverId: string): NativeServerRecord | undefined }, options: {
  serverId: string; sessionId: string; directory: string; observedAt: number; maximumInspectionAgeMs: number;
  maximumEvents: number; maximumBytes: number; priorEventId?: string;
  fetch: typeof fetch; signal: AbortSignal; resolveAuthorization: (keyRef: string) => Promise<string | undefined>;
}): Promise<NativeEventRead> {
  const blocked = (reason: string): NativeEventRead => ({ status: 'BLOCKED', reason });
  const stored = store.get(options.serverId);
  if (!stored || stored.lifecycle !== 'INSPECTED' || !stored.inspection) return blocked('SERVER_NOT_INSPECTED');
  const server = structuredClone(stored);
  if (!server.inspection) return blocked('SERVER_NOT_INSPECTED');
  if (server.inspection.compatibility?.eventStream !== true) return blocked('API_UNSUPPORTED');
  if (!time(options.observedAt) || !time(options.maximumInspectionAgeMs) || options.observedAt < server.updatedAt
    || options.observedAt < server.inspection.observedAt || options.observedAt - server.inspection.observedAt >= options.maximumInspectionAgeMs) return blocked('INSPECTION_NOT_CURRENT');
  if (!/^ses_[A-Za-z0-9_-]+$/.test(options.sessionId) || !server.projectRoots.includes(options.directory)) return blocked('SESSION_SCOPE_NOT_AUTHORIZED');
  if (!Number.isSafeInteger(options.maximumEvents) || options.maximumEvents < 1
    || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1
    || (options.priorEventId !== undefined && !text(options.priorEventId))) return blocked('INVALID_EVENT_LIMIT');
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
    const url = new URL('/event', endpoint); url.searchParams.set('directory', options.directory);
    const headers: Record<string, string> = { Accept: 'text/event-stream', Authorization: authorization };
    if (options.priorEventId) headers['Last-Event-ID'] = options.priorEventId;
    const response = await options.fetch(url.href, { method: 'GET', headers, signal: options.signal, credentials: 'omit', redirect: 'error' });
    if (!current()) throw new EventError('SUPERSEDED');
    if (response.status === 401 || response.status === 403) throw new EventError('AUTH_FAILED');
    if (!response.ok || !response.body) throw new EventError('SERVER_UNAVAILABLE');
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'text/event-stream') throw new EventError('RESPONSE_INVALID');
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let buffer = ''; let bytes = 0; let ended = false; const events: NativeEventObservation[] = []; const ids = new Map<string, string>();
    const consume = (block: string) => {
      let sseId: string | undefined; const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') { if (value.includes('\0')) throw new EventError('RESPONSE_INVALID'); sseId = value; }
        else if (field === 'data') data.push(value);
      }
      if (data.length === 0) return;
      let envelope: unknown;
      try { envelope = JSON.parse(data.join('\n')); } catch { throw new EventError('RESPONSE_INVALID'); }
      if (!object(envelope) || envelope.directory !== options.directory || !object(envelope.payload)
        || !text(envelope.payload.id) || !text(envelope.payload.type) || !object(envelope.payload.properties)) throw new EventError('RESPONSE_INVALID');
      if (sseId !== undefined && sseId !== envelope.payload.id) throw new EventError('EVENT_IDENTITY_MISMATCH');
      const properties = envelope.payload.properties;
      const info = object(properties.info) ? properties.info : undefined;
      const part = object(properties.part) ? properties.part : undefined;
      const sessionId = text(properties.sessionID) ? properties.sessionID
        : text(info?.sessionID) ? info.sessionID : text(part?.sessionID) ? part.sessionID : undefined;
      if (sessionId !== options.sessionId) return;
      const messageId = text(properties.messageID) ? properties.messageID
        : text(info?.id) ? info.id : text(part?.messageID) ? part.messageID : undefined;
      const partId = text(part?.id) ? part.id : undefined;
      const raw = data.join('\n'); const hash = createHash('sha256').update(raw).digest('hex');
      const previous = ids.get(envelope.payload.id);
      if (previous && previous !== hash) throw new EventError('CONFLICTING_EVENT_ID');
      if (previous) return;
      ids.set(envelope.payload.id, hash);
      events.push({ providerEventId: envelope.payload.id, eventType: envelope.payload.type,
        sessionId: options.sessionId, ...(messageId ? { messageId } : {}), ...(partId ? { partId } : {}),
        dataHash: hash, observedOrder: events.length });
    };
    while (events.length < options.maximumEvents) {
      const result = await reader.read();
      if (result.done) { ended = true; buffer += decoder.decode(); break; }
      bytes += result.value.byteLength;
      if (bytes > options.maximumBytes) { await reader.cancel(); throw new EventError('EVENT_LIMIT_EXCEEDED'); }
      buffer += decoder.decode(result.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while (events.length < options.maximumEvents && (boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length); consume(block);
      }
    }
    if (events.length >= options.maximumEvents) await reader.cancel();
    else if (ended && buffer.trim()) consume(buffer);
    if (!current()) return blocked('SUPERSEDED');
    return { status: 'READ', serverId: server.serverId, serverRevision: server.revision, apiSpecHash: server.inspection.apiSpecHash,
      observedAt: options.observedAt, directory: options.directory, sessionId: options.sessionId,
      ...(options.priorEventId ? { priorEventId: options.priorEventId } : {}),
      ...(events.length ? { lastEventId: events[events.length - 1].providerEventId } : {}),
      continuity: options.priorEventId ? 'UNVERIFIED_RECONNECT' : 'INITIAL', events, connectionEnded: ended,
      streamBoundary: ended ? 'EOF' : 'EVENT_LIMIT', requiresAuthoritativeReconciliation: true };
  } catch (error) { return blocked(error instanceof EventError ? error.message : 'SERVER_UNAVAILABLE'); }
}
