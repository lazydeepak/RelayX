import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeProvider, BaseMacOSProvider } from '../src/relay/providers/adapters.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { ObservableEvidence } from '../src/relay/domain/types.ts';

describe('Phase 2 — Real OpenCode Discovery', () => {
  it('correctly parses session identity and workspace paths from window titles', () => {
    const provider = new OpenCodeProvider();

    const title1 = 'OpenCode — [sess_alpha_99] /Users/alice/projects/relay-core';
    const parsed1 = provider.parseSessionIdentity(title1);
    assert.equal(parsed1.sessionId, 'sess_alpha_99');
    assert.equal(parsed1.workspacePath, '/Users/alice/projects/relay-core');

    const title2 = 'OpenCode: ~/work/codebase';
    const parsed2 = provider.parseSessionIdentity(title2);
    assert.equal(parsed2.workspacePath, '~/work/codebase');
    assert.equal(parsed2.sessionId, undefined);

    const title3 = 'OpenCode';
    const parsed3 = provider.parseSessionIdentity(title3);
    assert.equal(parsed3.displayName, 'OpenCode');
    assert.equal(parsed3.sessionId, undefined);
  });

  it('reports truthful unavailable state on non-macOS or when process is not running', async () => {
    const provider = new OpenCodeProvider();
    const result = await provider.findRuntime({ providerType: 'opencode' });

    assert.equal(result.found, false);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.composerVisible, false);
    assert.ok(result.evidence);
    assert.ok(result.evidence.timestamp > 0);
    assert.equal(result.evidence.source, 'reconciliation_probe');
  });

  it('repeated discovery updates existing runtime without creating duplicates', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);

    // Create a mockable OpenCode provider that simulates an active running instance
    class TestableOpenCodeProvider extends OpenCodeProvider {
      private mockPid: number | undefined = 45120;
      private mockTitle: string | undefined = 'OpenCode — [sess_101] /app/work';

      public setMockState(pid: number | undefined, title: string | undefined) {
        this.mockPid = pid;
        this.mockTitle = title;
      }

      protected override probeMacOSProcess(_name: string) {
        if (!this.mockPid) {
          return { running: false, details: { reason: 'Process not running' } };
        }
        return {
          running: true,
          pid: this.mockPid,
          windowTitle: this.mockTitle,
          evidenceSource: 'macos_system_events',
          details: { matchedProcessName: 'opencode' },
        };
      }
    }

    const testProvider = new TestableOpenCodeProvider();
    engine.registerProvider(testProvider);

    // First discovery: creates new runtime
    const first = await engine.discoverRuntime('opencode');
    assert.equal(first.isNew, true);
    assert.equal(first.inspection.found, true);
    assert.equal(first.runtime.applicationPid, 45120);
    assert.equal(first.runtime.windowTitle, 'OpenCode — [sess_101] /app/work');
    assert.equal(first.runtime.status, 'available');

    const runtimesAfterFirst = await db.runtimes.findAll();
    assert.equal(runtimesAfterFirst.length, 1);

    // Second discovery with updated window title: must UPDATE existing runtime, NOT duplicate
    testProvider.setMockState(45120, 'OpenCode — [sess_101] /app/work (editing main.ts)');
    const second = await engine.discoverRuntime('opencode');
    assert.equal(second.isNew, false);
    assert.equal(second.runtime.id, first.runtime.id, 'Runtime ID must remain identical');
    assert.equal(second.runtime.windowTitle, 'OpenCode — [sess_101] /app/work (editing main.ts)');

    const runtimesAfterSecond = await db.runtimes.findAll();
    assert.equal(runtimesAfterSecond.length, 1, 'Duplicate runtime must not be created');
  });

  it('captures observation failures and transitions to suspended without terminating', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);

    class FlakyOpenCodeProvider extends OpenCodeProvider {
      public running = true;
      protected override probeMacOSProcess(_name: string) {
        if (!this.running) {
          return { running: false, details: { reason: 'Window temporarily hidden' } };
        }
        return {
          running: true,
          pid: 8891,
          windowTitle: 'OpenCode Workspace',
        };
      }
    }

    const flaky = new FlakyOpenCodeProvider();
    engine.registerProvider(flaky);

    const initial = await engine.discoverRuntime('opencode');
    assert.equal(initial.runtime.status, 'available');

    // Simulate transient failure
    flaky.running = false;
    const recheck = await engine.discoverRuntime('opencode');
    assert.equal(recheck.isNew, false);
    assert.equal(recheck.runtime.consecutiveObservationFailures, 1);
    assert.equal(recheck.runtime.status, 'suspended', 'Single failure transitions to suspended, not dead');

    const runtimes = await db.runtimes.findAll();
    assert.equal(runtimes.length, 1);
  });
});
