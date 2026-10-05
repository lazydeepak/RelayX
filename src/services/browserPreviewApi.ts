import type { IRelayApi } from '../types/relayApi.ts';

const emptyMetrics = {
  totalProjects: 0,
  totalPairs: 0,
  totalRuntimes: 0,
  activeWorkers: 0,
  activeAssignments: 0,
  waitingReview: 0,
  openAttentionItems: 0,
  ambiguousDeliveries: 0,
};

/**
 * Browser-only preview boundary.
 *
 * The real Relay engine, persistence, provider adapters, and native process access live in
 * Electron's main process and are reached through `window.relayApi`. A plain Vite browser
 * has no IPC peer, so it gets a deliberately inert preview API instead of importing backend
 * code into the renderer bundle.
 */
export const browserPreviewApi = new Proxy({} as IRelayApi, {
  get(_target, property) {
    const method = String(property);
    return async (..._args: unknown[]) => {
      if (method === 'getAppStatus') {
        return {
          isElectron: false,
          platform: 'browser',
          databasePath: ':unavailable:',
          databaseType: 'memory',
        };
      }
      if (method === 'getDashboardState') return { metrics: emptyMetrics, recentEvents: [] };
      if (method.startsWith('list')) return [];
      if (method === 'queryEvents') return { events: [], total: 0 };
      if (method === 'runSupervisionTick') {
        return { inspectedRuntimes: 0, inspectedAssignments: 0, handoffsCreated: 0, attentionItemsCreated: 0 };
      }
      if (method === 'getArchivePolicy' || method === 'setArchivePolicy') {
        return {
          interval: 'never',
          effectiveRetentionDays: null,
          note: 'Archive policy is available in the Electron app.',
        };
      }
      if (method === 'getStorageAccounting') {
        return {
          databaseSizeBytes: 0,
          databaseType: 'unavailable',
          databasePath: ':unavailable:',
          totalEvents: 0,
          activeEvents: 0,
          archivedEvents: 0,
          totalActivities: 0,
          totalCheckpoints: 0,
          totalAttentionItems: 0,
          traceLogs: [],
          totalStorageBytes: 0,
        };
      }
      if (method.startsWith('canDelete')) return { canDelete: false, reasons: ['Desktop IPC is unavailable in browser preview.'] };
      if (method.startsWith('get')) return null;
      if (method === 'activateRuntime') return false;
      // Never claim a browser open succeeded here: this surface cannot open a tab,
      // so an explicit failure is the only honest answer.
      if (method === 'openRuntimeSession') {
        return {
          success: false,
          error:
            'Opening in your browser requires the RelayX Electron backend; ' +
            'the browser preview cannot open or verify a ChatGPT tab.',
        };
      }
      return { success: false, error: 'This operation requires the RelayX Electron backend.' };
    };
  },
});
