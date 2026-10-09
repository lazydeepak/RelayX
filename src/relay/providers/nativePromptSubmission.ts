import { createHash } from 'node:crypto';
import { normalizeNativeEndpoint } from './nativeOpenCodeDiscovery';
import type { NativeServerRecord } from './nativeServerLifecycle';
import type { SqliteNativeDispatchIntentRepository } from '../persistence/sqlite/SqliteNativeDispatchIntentRepository';
import type { NativeDispatchClaimEvidence, SqliteNativeDispatchClaimRepository } from '../persistence/sqlite/SqliteNativeDispatchClaimRepository';

export type NativePromptSubmission =
  | { status: 'BLOCKED'; reason: string }
  | { status: 'RECONCILIATION_REQUIRED'; dispatchKey: string; providerMessageId: string;
      transport: 'NOT_ATTEMPTED_EXISTING_CLAIM' | 'NOT_ATTEMPTED_SUPERSEDED'
        | 'ATTEMPTED_204' | 'ATTEMPTED_HTTP_ERROR' | 'ATTEMPTED_NETWORK_ERROR'; httpStatus?: number };

export async function claimAndSubmitNativePrompt(stores: {
  servers: { get(serverId: string): NativeServerRecord | undefined };
  intents: SqliteNativeDispatchIntentRepository;
  claims: SqliteNativeDispatchClaimRepository;
}, options: {
  dispatchKey: string; claimEvidence: NativeDispatchClaimEvidence;
  fetch: typeof fetch; signal: AbortSignal;
  resolveAuthorization: (keyRef: string) => Promise<string | undefined>;
}): Promise<NativePromptSubmission> {
  const blocked = (reason: string): NativePromptSubmission => ({ status: 'BLOCKED', reason });
  const intent = stores.intents.get(options.dispatchKey);
  if (!intent) return blocked('INTENT_NOT_FOUND');
  const providerMessageId = providerMessageIdFor(options.dispatchKey);
  if (stores.claims.get(options.dispatchKey)) return { status: 'RECONCILIATION_REQUIRED', dispatchKey: options.dispatchKey,
    providerMessageId, transport: 'NOT_ATTEMPTED_EXISTING_CLAIM' };
  if (options.signal.aborted) return blocked('ABORTED_BEFORE_CLAIM');
  const stored = stores.servers.get(intent.serverId);
  if (!stored || stored.lifecycle !== 'INSPECTED' || !stored.inspection) return blocked('SERVER_NOT_INSPECTED');
  const server = structuredClone(stored);
  const inspection = structuredClone(stored.inspection);
  if (server.revision !== intent.serverRevision || inspection.apiSpecHash !== intent.boundary.apiSpecHash) return blocked('SERVER_SUPERSEDED');
  if (inspection.compatibility?.messageSend !== true) return blocked('API_UNSUPPORTED');
  let endpoint: string;
  try { endpoint = normalizeNativeEndpoint(server.endpoint); } catch { return blocked('INVALID_ENDPOINT'); }
  let authorization: string | undefined;
  try { authorization = await options.resolveAuthorization(server.authKeyRef); } catch { return blocked('AUTH_UNAVAILABLE'); }
  if (!authorization) return blocked('AUTH_UNAVAILABLE');
  if (options.signal.aborted) return blocked('ABORTED_BEFORE_CLAIM');

  const acquired = stores.claims.claim(options.dispatchKey, options.claimEvidence);
  if (!acquired.acquired) return { status: 'RECONCILIATION_REQUIRED', dispatchKey: options.dispatchKey,
    providerMessageId, transport: 'NOT_ATTEMPTED_EXISTING_CLAIM' };

  const current = stores.servers.get(intent.serverId);
  if (!current || current.lifecycle !== 'INSPECTED' || current.revision !== server.revision
    || current.endpoint !== endpoint || current.inspection?.apiSpecHash !== inspection.apiSpecHash) {
    return { status: 'RECONCILIATION_REQUIRED', dispatchKey: options.dispatchKey,
      providerMessageId, transport: 'NOT_ATTEMPTED_SUPERSEDED' };
  }
  const url = new URL(`/session/${encodeURIComponent(intent.sessionId)}/prompt_async`, endpoint);
  url.searchParams.set('directory', intent.directory);
  const body = JSON.stringify({ messageID: providerMessageId,
    model: { providerID: intent.modelRoute.providerId, modelID: intent.modelRoute.publishedModelId },
    parts: intent.payload.parts.map(part => ({ type: 'text', text: part.text })) });
  try {
    const response = await options.fetch(url.href, { method: 'POST', headers: { Accept: 'application/json',
      'Content-Type': 'application/json', Authorization: authorization }, body, signal: options.signal,
      credentials: 'omit', redirect: 'error' });
    if (response.status === 204) return { status: 'RECONCILIATION_REQUIRED', dispatchKey: options.dispatchKey,
      providerMessageId, transport: 'ATTEMPTED_204', httpStatus: 204 };
    try { await response.body?.cancel(); } catch { /* response content is intentionally discarded */ }
    return { status: 'RECONCILIATION_REQUIRED', dispatchKey: options.dispatchKey,
      providerMessageId, transport: 'ATTEMPTED_HTTP_ERROR', httpStatus: response.status };
  } catch {
    return { status: 'RECONCILIATION_REQUIRED', dispatchKey: options.dispatchKey,
      providerMessageId, transport: 'ATTEMPTED_NETWORK_ERROR' };
  }
}

export function providerMessageIdFor(dispatchKey: string): string {
  return `msg_relayx_${createHash('sha256').update(dispatchKey).digest('hex').slice(0, 48)}`;
}
