import { createHash } from 'node:crypto';
import type { CatalogEntry } from './eligibility';

export type CatalogSource = 'OPENROUTER' | 'MODELS_DEV';
export const CATALOG_URLS: Record<CatalogSource, string> = {
  OPENROUTER: 'https://openrouter.ai/api/v1/models',
  MODELS_DEV: 'https://models.dev/api.json',
};
export interface DiscoveredModel extends CatalogEntry {
  /** Uninterpreted public metadata; never an account entitlement. */
  publishedPricing: Record<string, unknown> | null;
  publishedCapabilities: Record<string, unknown>;
}
export interface CatalogSnapshot {
  source: CatalogSource;
  sourceUrl: string;
  fetchedAt: number;
  checkedAt: number;
  etag?: string;
  contentHash: string;
  parserVersion: string;
  rawBody: string;
  models: DiscoveredModel[];
  warnings: string[];
}
const PARSER_VERSION = '1';
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseCatalog(source: CatalogSource, rawBody: string, fetchedAt: number, etag?: string): CatalogSnapshot {
  if (!Number.isFinite(fetchedAt) || fetchedAt < 0) throw new Error('Invalid catalog timestamp');
  const data: unknown = JSON.parse(rawBody);
  const sourceUrl = CATALOG_URLS[source];
  const contentHash = createHash('sha256').update(rawBody).digest('hex');
  const snapshot: CatalogSnapshot = { source, sourceUrl, fetchedAt, checkedAt: fetchedAt, etag, contentHash,
    parserVersion: PARSER_VERSION, rawBody, models: [], warnings: [] };
  const seen = new Set<string>();
  const add = (providerId: string, endpointId: string, model: unknown, fallbackId?: string) => {
    if (!record(model)) { snapshot.warnings.push('INVALID_MODEL'); return; }
    const id = model.id === undefined ? fallbackId : model.id;
    if (!nonempty(id) || !nonempty(endpointId)) { snapshot.warnings.push('MISSING_IDENTITY'); return; }
    if (fallbackId && id !== fallbackId) { snapshot.warnings.push('CONFLICTING_MODEL_ID'); return; }
    const identity = JSON.stringify([providerId, endpointId, id]);
    if (seen.has(identity)) throw new Error('Duplicate catalog model identity');
    seen.add(identity);
    snapshot.models.push({ providerId, endpointId, publishedModelId: id,
      displayName: nonempty(model.name) ? model.name : id,
      provenance: { sourceUrl, fetchedAt, contentHash, parserVersion: PARSER_VERSION },
      publishedPricing: record(model.pricing) ? model.pricing : record(model.cost) ? model.cost : null,
      publishedCapabilities: source === 'OPENROUTER'
        ? { architecture: model.architecture, contextLength: model.context_length, supportedParameters: model.supported_parameters }
        : { toolCall: model.tool_call, reasoning: model.reasoning, modalities: model.modalities, limit: model.limit },
    });
  };
  if (source === 'OPENROUTER') {
    if (!record(data) || !Array.isArray(data.data)) throw new Error('Invalid OpenRouter catalog envelope');
    for (const model of data.data) add('openrouter', 'https://openrouter.ai/api/v1', model);
  } else if (source === 'MODELS_DEV') {
    if (!record(data)) throw new Error('Invalid Models.dev catalog envelope');
    for (const [key, provider] of Object.entries(data)) {
      if (!record(provider) || !record(provider.models)
        || (provider.id !== undefined && provider.id !== key)) {
        snapshot.warnings.push('INVALID_PROVIDER'); continue;
      }
      if (!nonempty(provider.api)) {
        snapshot.warnings.push(`MISSING_PROVIDER_ENDPOINT:${key}`); continue;
      }
      for (const [id, model] of Object.entries(provider.models)) add(key, provider.api, model, id);
    }
  } else throw new Error('Unknown catalog source');
  return snapshot;
}

export type CatalogRefresh =
  | { status: 'UPDATED' | 'NOT_MODIFIED'; snapshot: CatalogSnapshot }
  | { status: 'UNAVAILABLE'; snapshot?: CatalogSnapshot; reason: string };

/** Public GET only. No API keys, inference payloads or account evidence. Caller
 * owns scheduling/backoff and persistence of returned raw snapshots. */
export async function refreshCatalog(source: CatalogSource, options: {
  fetch: typeof fetch;
  now: number;
  signal: AbortSignal;
  previous?: CatalogSnapshot;
}): Promise<CatalogRefresh> {
  const { previous, now } = options;
  if (!Number.isFinite(now) || now < 0) throw new Error('Invalid refresh timestamp');
  if (previous && (previous.source !== source || previous.sourceUrl !== CATALOG_URLS[source])) throw new Error('Cache source mismatch');
  if (previous && (!Number.isFinite(previous.checkedAt) || now < previous.checkedAt)) throw new Error('Catalog clock moved backwards');
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (previous?.etag) headers['If-None-Match'] = previous.etag;
    const response = await options.fetch(CATALOG_URLS[source], { method: 'GET', headers, signal: options.signal, redirect: 'error', credentials: 'omit' });
    if (response.status === 304) {
      if (!previous) throw new Error('304 without cached snapshot');
      return { status: 'NOT_MODIFIED', snapshot: { ...previous, checkedAt: now } };
    }
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    return { status: 'UPDATED', snapshot: parseCatalog(source, await response.text(), now, response.headers.get('etag') ?? undefined) };
  } catch {
    // Do not include remote error bodies or transport messages in logs/UI.
    return { status: 'UNAVAILABLE', snapshot: previous, reason: 'CATALOG_REFRESH_FAILED' };
  }
}
