import { refreshCatalog, type CatalogRefresh, type CatalogSnapshot, type CatalogSource } from './catalog';

export interface ModelCatalogStore {
  latest(source: CatalogSource): CatalogSnapshot | undefined;
  save(snapshot: CatalogSnapshot): void;
}

/** Fetch outside database transactions; persist only successful observations.
 * Persistence errors remain visible to callers, never reported as refresh success.
 */
export async function refreshStoredCatalog(store: ModelCatalogStore, source: CatalogSource,
  options: { fetch: typeof fetch; now: number; signal: AbortSignal }): Promise<CatalogRefresh> {
  const result = await refreshCatalog(source, { ...options, previous: store.latest(source) });
  if (result.status !== 'UNAVAILABLE') store.save(result.snapshot);
  return result;
}
