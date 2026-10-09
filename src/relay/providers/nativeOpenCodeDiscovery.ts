import { createHash } from 'node:crypto';

export interface NativeServerReference {
  serverId: string;
  endpoint: string;
  ownership: 'MANAGED' | 'ADOPTED';
}
export interface NativeProviderInventory {
  providerId: string;
  connected: boolean;
  modelIds: string[];
}
export type NativeDiscovery = {
  status: 'INSPECTED';
  server: NativeServerReference;
  observedAt: number;
  serverVersion: string;
  apiVersion: string;
  apiSpecHash: string;
  rawApiSpec: string;
  providers: NativeProviderInventory[];
  declaredOperations: Array<{ method: string; path: string; operationId?: string }>;
  /** Discovery never grants dispatch or account billing permission. */
  dispatchAuthorized: false;
} | {
  status: 'BLOCKED';
  reason: 'SERVER_NOT_AUTHORIZED' | 'INVALID_ENDPOINT' | 'API_UNSUPPORTED' | 'AUTH_FAILED' | 'AUTH_UNAVAILABLE' | 'SERVER_UNAVAILABLE' | 'RESPONSE_INVALID';
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
class DiscoveryError extends Error {
  constructor(readonly reason: Extract<NativeDiscovery, { status: 'BLOCKED' }>['reason']) { super(reason); }
}

export function normalizeNativeEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Invalid native endpoint');
  if (endpoint.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new Error('Invalid native endpoint');
  return endpoint.origin;
}

/** Read-only compatibility adapter for the published /global/health + /provider
 * contract. Other contracts are blocked until explicitly implemented. Ownership
 * references must come from operator adoption or RelayX process supervision.
 * No process start, session creation, provider configuration or prompt is sent.
 */
export async function inspectNativeOpenCode(options: {
  server: NativeServerReference;
  fetch: typeof fetch;
  signal: AbortSignal;
  observedAt: number;
  /** Obtained from secure storage; never returned in evidence or errors. */
  authorization?: string;
}): Promise<NativeDiscovery> {
  const { server } = options;
  if (!server || !text(server.serverId) || !['MANAGED', 'ADOPTED'].includes(server.ownership)) {
    return { status: 'BLOCKED', reason: 'SERVER_NOT_AUTHORIZED' };
  }
  let endpoint: URL;
  try {
    endpoint = new URL(normalizeNativeEndpoint(server.endpoint));
  } catch { return { status: 'BLOCKED', reason: 'INVALID_ENDPOINT' }; }
  if (!Number.isFinite(options.observedAt) || options.observedAt < 0) return { status: 'BLOCKED', reason: 'RESPONSE_INVALID' };
  const get = async (path: string): Promise<string> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.authorization) headers.Authorization = options.authorization;
    const response = await options.fetch(new URL(path, endpoint).href, {
      method: 'GET', headers, signal: options.signal, redirect: 'error', credentials: 'omit',
    });
    if (response.status === 401 || response.status === 403) throw new DiscoveryError('AUTH_FAILED');
    if (!response.ok) throw new DiscoveryError('SERVER_UNAVAILABLE');
    return response.text();
  };
  const json = (raw: string): unknown => {
    try { return JSON.parse(raw); } catch { throw new DiscoveryError('RESPONSE_INVALID'); }
  };
  try {
    const rawApiSpec = await get('/doc');
    const spec = json(rawApiSpec);
    if (!record(spec) || !text(spec.openapi) || !spec.openapi.startsWith('3.')
      || !record(spec.info) || !text(spec.info.version) || !record(spec.paths)) throw new DiscoveryError('API_UNSUPPORTED');
    for (const path of ['/global/health', '/provider']) {
      const item = spec.paths[path];
      if (!record(item) || !record(item.get) || !record(item.get.responses) || !record(item.get.responses['200'])) {
        throw new DiscoveryError('API_UNSUPPORTED');
      }
    }
    const declaredOperations: Array<{ method: string; path: string; operationId?: string }> = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      if (!record(item)) continue;
      for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
        if (record(item[method])) declaredOperations.push({ method: method.toUpperCase(), path,
          operationId: text(item[method].operationId) ? item[method].operationId : undefined });
      }
    }
    const health = json(await get('/global/health'));
    if (!record(health) || health.healthy !== true || !text(health.version)) throw new DiscoveryError('RESPONSE_INVALID');
    const inventory = json(await get('/provider'));
    if (!record(inventory) || !Array.isArray(inventory.all) || !Array.isArray(inventory.connected)
      || !inventory.connected.every(text) || !record(inventory.default)
      || !Object.values(inventory.default).every(text)) throw new DiscoveryError('RESPONSE_INVALID');
    const ids = new Set<string>();
    const providers: NativeProviderInventory[] = [];
    for (const provider of inventory.all) {
      if (!record(provider) || !text(provider.id) || ids.has(provider.id) || !record(provider.models)) throw new DiscoveryError('RESPONSE_INVALID');
      ids.add(provider.id);
      const modelIds = Object.keys(provider.models);
      for (const id of modelIds) {
        const model = provider.models[id];
        if (!text(id) || !record(model) || model.id !== id || model.providerID !== provider.id) throw new DiscoveryError('RESPONSE_INVALID');
      }
      providers.push({ providerId: provider.id, connected: inventory.connected.includes(provider.id), modelIds });
    }
    if (new Set(inventory.connected).size !== inventory.connected.length || inventory.connected.some(id => !ids.has(id))) {
      throw new DiscoveryError('RESPONSE_INVALID');
    }
    return { status: 'INSPECTED', server: { serverId: server.serverId, endpoint: endpoint.origin, ownership: server.ownership },
      observedAt: options.observedAt, serverVersion: health.version, apiVersion: spec.info.version,
      apiSpecHash: createHash('sha256').update(rawApiSpec).digest('hex'), rawApiSpec, providers,
      declaredOperations, dispatchAuthorized: false };
  } catch (error) {
    return { status: 'BLOCKED', reason: error instanceof DiscoveryError ? error.reason : 'SERVER_UNAVAILABLE' };
  }
}
