import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeProvider } from '../src/relay/providers/adapters.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';

describe('Authoritative OpenCode Session Discovery Tests', () => {
  it('prioritizes authoritative persisted sessions over window titles and correlates exact directory match', async () => {
    class MockOpenCodeProvider extends OpenCodeProvider {
      public override async discoverPersistedSessions() {
        return {
          success: true,
          sessions: [
            {
              id: 'ses_alpha_authoritative',
              projectId: 'proj_alpha',
              directory: '/Users/alice/projects/alpha',
              title: 'Alpha Feature Dev',
            },
            {
              id: 'ses_beta_unrelated',
              projectId: 'proj_beta',
              directory: '/Users/alice/projects/beta',
              title: 'Beta Service',
            },
          ],
        };
      }

      public override async findAllRuntimes() {
        return [
          {
            found: true,
            status: 'available' as const,
            windowTitle: 'OpenCode — [ses_alpha_authoritative] /Users/alice/projects/alpha',
            applicationPid: 7712,
            bundleIdentifier: 'dev.opencode.desktop',
            composerVisible: true,
            composerHasFocus: true,
            sendButtonVisible: true,
            stopButtonVisible: false,
            cancelButtonVisible: false,
            isWorking: false,
            isComplete: false,
            evidence: {
              id: 'ev_ui_1',
              timestamp: Date.now(),
              source: 'macos_system_events' as const,
              details: {},
            },
          },
        ];
      }
    }

    const provider = new MockOpenCodeProvider();
    const res = await provider.matchSessionsByPath('/Users/alice/projects/alpha');

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.sessions.length, 1);
    assert.strictEqual((res.sessions[0].evidence.details as any)?.parsedSessionId, 'ses_alpha_authoritative');
    assert.strictEqual((res.sessions[0].evidence.details as any)?.matchedVia, 'exact_path');
    assert.strictEqual((res.sessions[0].evidence.details as any)?.hasUiCorrelation, true);
    assert.strictEqual(res.sessions[0].applicationPid, 7712);
  });

  it('matches persisted session without requiring an active UI window (headless or stopped service)', async () => {
    class HeadlessOpenCodeProvider extends OpenCodeProvider {
      public override async discoverPersistedSessions() {
        return {
          success: true,
          sessions: [
            {
              id: 'ses_headless_123',
              projectId: 'proj_headless',
              directory: '/workspaces/core-app',
            },
          ],
        };
      }

      public override async findAllRuntimes() {
        // No visible windows
        return [];
      }
    }

    const provider = new HeadlessOpenCodeProvider();
    const res = await provider.matchSessionsByPath('/workspaces/core-app');

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.sessions.length, 1);
    assert.strictEqual((res.sessions[0].evidence.details as any)?.parsedSessionId, 'ses_headless_123');
    assert.strictEqual((res.sessions[0].evidence.details as any)?.hasUiCorrelation, false);
    assert.strictEqual(res.sessions[0].status, 'available');
  });

  it('excludes unrelated sessions with non-matching directories', async () => {
    class OtherSessionsProvider extends OpenCodeProvider {
      public override async discoverPersistedSessions() {
        return {
          success: true,
          sessions: [
            {
              id: 'ses_other_1',
              directory: '/Users/bob/unrelated-repo',
            },
            {
              id: 'ses_other_2',
              directory: '/tmp/test-workspace',
            },
          ],
        };
      }

      public override async findAllRuntimes() {
        return [];
      }
    }

    const provider = new OtherSessionsProvider();
    const res = await provider.matchSessionsByPath('/Users/alice/projects/relay-client');

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.sessions.length, 0);
  });

  it('exposes multiple sessions with diagnostics when multiple sessions match git root / prefix', async () => {
    class MultiSessionProvider extends OpenCodeProvider {
      public override async discoverPersistedSessions() {
        return {
          success: true,
          sessions: [
            {
              id: 'ses_feature_branch',
              projectId: 'proj_main',
              directory: '/Users/alice/repo/packages/sub-package',
            },
            {
              id: 'ses_root_workspace',
              projectId: 'proj_main',
              directory: '/Users/alice/repo',
            },
          ],
        };
      }

      public override async findAllRuntimes() {
        return [];
      }
    }

    const provider = new MultiSessionProvider();
    const res = await provider.matchSessionsByPath('/Users/alice/repo/packages/sub-package', '/Users/alice/repo');

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.sessions.length, 2);
    // Exact path match should be ranked first
    assert.strictEqual((res.sessions[0].evidence.details as any)?.parsedSessionId, 'ses_feature_branch');
    assert.strictEqual((res.sessions[0].evidence.details as any)?.matchedVia, 'exact_path');
    // Git root / prefix correlation ranked second
    assert.strictEqual((res.sessions[1].evidence.details as any)?.parsedSessionId, 'ses_root_workspace');
  });

  it('RelayApiService prevents finalizeProjectSetup if worker session ID is missing or empty', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const apiService = new RelayApiService(db, engine);

    const res = await apiService.finalizeProjectSetup({
      name: 'Alpha Project',
      description: 'Test project',
      canonicalPath: '/workspaces/alpha',
      gitRoot: '/workspaces/alpha',
      plannerUrl: 'https://chatgpt.com/p/alpha',
      workerSessionId: undefined, // Missing!
    });

    assert.strictEqual(res.success, false);
    assert.match(res.error || '', /authoritative OpenCode worker session is required/i);

    // Database must not have created any dangling project or pair
    const projects = await db.projects.findAll();
    assert.strictEqual(projects.length, 0);
  });
});
