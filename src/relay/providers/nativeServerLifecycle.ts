import { inspectNativeOpenCode, type NativeDiscovery, type NativeServerReference } from './nativeOpenCodeDiscovery';

export interface NativeServerRecord extends NativeServerReference {
  revision: number;
  lifecycle: 'REGISTERED' | 'INSPECTED' | 'BLOCKED' | 'REVOKED';
  authKeyRef: string;
  projectRoots: string[];
  registeredBy: string;
  ownershipEvidenceRef: string;
  createdAt: number;
  updatedAt: number;
  lastHealthyAt?: number;
  blocker?: string;
  inspection?: {
    observedAt: number;
    apiSpecHash: string;
    apiVersion: string;
    serverVersion: string;
    declaredOperations: Extract<NativeDiscovery, { status: 'INSPECTED' }>['declaredOperations'];
  };
}
export interface NativeServerStore {
  get(serverId: string): NativeServerRecord | undefined;
  applyDiscovery(serverId: string, revision: number, observedAt: number, result: NativeDiscovery): boolean;
}

/** Resolve auth by opaque secure-store reference; probe outside transactions;
 * discard observations superseded by concurrent revocation or another probe.
 */
export async function probeRegisteredNativeServer(store: NativeServerStore, serverId: string, options: {
  fetch: typeof fetch;
  signal: AbortSignal;
  observedAt: number;
  resolveAuthorization: (keyRef: string) => Promise<string | undefined>;
}): Promise<{ status: 'RECORDED' | 'SUPERSEDED' | 'NOT_AUTHORIZED' | 'AUTH_UNAVAILABLE' }> {
  const record = store.get(serverId);
  if (!record || record.lifecycle === 'REVOKED') return { status: 'NOT_AUTHORIZED' };
  if (!Number.isFinite(options.observedAt) || options.observedAt < record.updatedAt) throw new Error('Invalid native probe time');
  const unavailableAuth = () => ({ status: store.applyDiscovery(serverId, record.revision, options.observedAt,
    { status: 'BLOCKED', reason: 'AUTH_UNAVAILABLE' }) ? 'AUTH_UNAVAILABLE' as const : 'SUPERSEDED' as const });
  let authorization: string | undefined;
  try { authorization = await options.resolveAuthorization(record.authKeyRef); }
  catch { return unavailableAuth(); }
  if (!authorization) return unavailableAuth();
  const current = store.get(serverId);
  if (!current || current.lifecycle === 'REVOKED' || current.revision !== record.revision) return { status: 'SUPERSEDED' };
  const result = await inspectNativeOpenCode({
    server: { serverId: record.serverId, endpoint: record.endpoint, ownership: record.ownership },
    fetch: options.fetch, signal: options.signal, observedAt: options.observedAt, authorization,
  });
  return { status: store.applyDiscovery(serverId, record.revision, options.observedAt, result) ? 'RECORDED' : 'SUPERSEDED' };
}
