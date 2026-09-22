import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import {
  RuntimeInspectionResult,
  RuntimeTargetDescriptor,
} from '../src/relay/providers/interfaces.ts';

/**
 * Provider stub that lets a test inject an authoritative external session
 * identity into the inspection evidence the engine observes at discovery.
 */
class IdentityMockProvider extends MockProvider {
  public authoritativeSessionId?: string;
  public parsedSessionId?: string;
  public workspacePath?: string;
  public projectUrl?: string;
  public openCodeProjectId?: string;

  override async findRuntime(descriptor: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult> {
    const result = await super.findRuntime(descriptor);
    if (this.authoritativeSessionId || this.parsedSessionId || this.openCodeProjectId) {
      result.evidence = {
        ...result.evidence,
        details: {
          ...result.evidence.details,
          ...(this.authoritativeSessionId ? { authoritativeSessionId: this.authoritativeSessionId } : {}),
          ...(this.parsedSessionId ? { parsedSessionId: this.parsedSessionId } : {}),
          ...(this.workspacePath ? { workspacePath: this.workspacePath } : {}),
          ...(this.projectUrl ? { projectUrl: this.projectUrl } : {}),
          ...(this.openCodeProjectId ? { openCodeProjectId: this.openCodeProjectId } : {}),
        },
      };
    }
    return result;
  }
}

describe('Runtime discovery respects authoritative external session identity', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let provider: IdentityMockProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    provider = new IdentityMockProvider('opencode');
    provider.windowTitle = 'OpenCode — [sess_a] /app/work';
    provider.applicationPid = 45120;
    engine.registerProvider(provider);
  });

  it('rediscovery of the same external ID reuses the exact runtime even when the PID changes', async () => {
    provider.authoritativeSessionId = 'sess_alpha';

    const first = await engine.discoverRuntime('opencode');
    assert.equal(first.isNew, true);
    assert.equal(first.runtime.externalSessionId, 'sess_alpha');

    // Simulate an app restart: the process gets a new PID but the OpenCode
    // session still carries the same persisted authoritative `ses_*` ID.
    provider.applicationPid = 99999;
    const second = await engine.discoverRuntime('opencode');
    assert.equal(second.isNew, false);
    assert.equal(second.runtime.id, first.runtime.id, 'External-ID match must reuse the exact runtime');
    assert.equal(second.runtime.externalSessionId, 'sess_alpha');
    assert.equal(second.runtime.applicationPid, 99999, 'Observation refresh still applies on reuse');

    const all = await db.runtimes.findAll();
    assert.equal(all.length, 1, 'No duplicate runtime may be created for the same external ID');
  });

  it('two sessions in the same app/workspace with different external IDs remain distinct', async () => {
    provider.authoritativeSessionId = 'sess_a';
    const runtimeA = await engine.discoverRuntime('opencode');
    assert.equal(runtimeA.isNew, true);
    assert.equal(runtimeA.runtime.externalSessionId, 'sess_a');

    // Same window title, same PID, same workspace — only the authoritative
    // session identity differs.
    provider.authoritativeSessionId = 'sess_b';
    const runtimeB = await engine.discoverRuntime('opencode');
    assert.equal(runtimeB.isNew, true, 'A different external ID must not reuse the other session');
    assert.notEqual(runtimeB.runtime.id, runtimeA.runtime.id, 'Sessions must remain distinct runtimes');
    assert.equal(runtimeB.runtime.externalSessionId, 'sess_b');

    const all = await db.runtimes.findAll();
    assert.equal(all.length, 2);

    // Rediscovering the first external ID still resolves to the original runtime.
    provider.authoritativeSessionId = 'sess_a';
    const recheckA = await engine.discoverRuntime('opencode');
    assert.equal(recheckA.isNew, false);
    assert.equal(recheckA.runtime.id, runtimeA.runtime.id);
    assert.equal(runtimeA.runtime.externalSessionId, 'sess_a', 'Original runtime identity must be preserved');
  });

  it('a legacy null-ID paired runtime is not silently claimed by an authoritative discovery', async () => {
    // 1. Legacy discovery WITHOUT any external identity creates a null-ID runtime.
    const legacy = await engine.discoverRuntime('opencode');
    assert.equal(legacy.isNew, true);
    assert.equal(legacy.runtime.externalSessionId, null);

    // 2. Bind the legacy runtime to a pair as its worker.
    const project = await engine.createProject('Legacy Pair Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'ChatGPT Planner');
    const pair = await engine.createPair(project.id, 'Default Pair', planner.id, legacy.runtime.id);
    assert.equal(pair.workerSessionId, legacy.runtime.id);

    // 3. Authoritative discovery carries the SAME pid/windowTitle as the legacy
    //    runtime, but with a real external session ID.
    provider.authoritativeSessionId = 'sess_gold';
    const discovered = await engine.discoverRuntime('opencode');
    assert.equal(discovered.isNew, true, 'An authoritative ID must create its own runtime, not claim the legacy one');
    assert.notEqual(discovered.runtime.id, legacy.runtime.id);
    assert.equal(discovered.runtime.externalSessionId, 'sess_gold');

    // 4. The legacy runtime keeps its null identity and stays bound to the pair.
    const reloadedPair = await db.pairs.findById(pair.id);
    assert.ok(reloadedPair);
    assert.equal(reloadedPair.workerSessionId, legacy.runtime.id, 'Pair binding must not be rebound');
    assert.equal(legacy.runtime.externalSessionId, null, 'Legacy runtime must not be stamped with the new identity');

    const allOpencode = (await db.runtimes.findAll()).filter((r) => r.providerType === 'opencode');
    assert.equal(allOpencode.length, 2, 'One legacy null-ID opencode runtime plus one authoritative runtime');
  });

  it('two OpenCode sessions in one project remain distinct when only openCodeProjectId is present', async () => {
    // No session identity at all — only project-scoped identity from the shared
    // OpenCode service. A project ID never identifies a single session.
    provider.openCodeProjectId = 'proj_x';
    provider.workspacePath = '/app/work';
    provider.applicationPid = 45120;

    const sessionOne = await engine.discoverRuntime('opencode');
    assert.equal(sessionOne.isNew, true);
    assert.equal(sessionOne.runtime.externalSessionId, null, 'Project ID must not become the session identity');
    assert.equal(sessionOne.runtime.externalProjectRef, '/app/work', 'Project identity lives in externalProjectRef');
    assert.equal(sessionOne.runtime.applicationPid, 45120);

    // A second session in the SAME project (new PID, only openCodeProjectId in
    // evidence). It must NOT collapse onto the first runtime via the project ID.
    provider.applicationPid = 99999;
    provider.workspacePath = undefined;
    const sessionTwo = await engine.discoverRuntime('opencode');
    assert.equal(sessionTwo.isNew, true, 'No proven session ID: must create a distinct runtime, not reuse via project ID');
    assert.notEqual(sessionTwo.runtime.id, sessionOne.runtime.id, 'Two sessions in one project must stay distinct');
    assert.equal(sessionTwo.runtime.externalSessionId, null);
    assert.equal(sessionTwo.runtime.externalProjectRef, 'proj_x', 'openCodeProjectId is kept as project ref, not session ID');

    const all = await db.runtimes.findAll();
    assert.equal(all.length, 2);
  });

  it('an unverified window-title token cannot claim an existing paired runtime', async () => {
    // 1. Legacy discovery WITHOUT any external identity creates a null-ID runtime.
    const legacy = await engine.discoverRuntime('opencode');
    assert.equal(legacy.isNew, true);
    assert.equal(legacy.runtime.externalSessionId, null);

    // 2. Bind the legacy runtime to a pair as its worker.
    const project = await engine.createProject('Title Token Pair Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'ChatGPT Planner');
    const pair = await engine.createPair(project.id, 'Default Pair', planner.id, legacy.runtime.id);
    assert.equal(pair.workerSessionId, legacy.runtime.id);

    // 3. A discovery arrives carrying ONLY a parsedSessionId extracted from a
    //    window title, with NO authoritativeSessionId (never validated against
    //    the shared OpenCode service or a persisted session record).
    provider.parsedSessionId = 'sess_title_token';
    const discovered = await engine.discoverRuntime('opencode');

    // The title token must not be treated as authoritative: the legacy runtime is
    // reused by PID, keeps its null identity, and the pair binding is untouched.
    assert.equal(discovered.isNew, false, 'An unverified title token must not mint a new runtime');
    assert.equal(discovered.runtime.id, legacy.runtime.id, 'Legacy PID match is retained when no session ID is proven');
    assert.equal(discovered.runtime.externalSessionId, null, 'Title token must never be stamped as the session identity');

    // 4. No runtime anywhere may carry the unverified token, and the pair stands.
    const allOpencode = (await db.runtimes.findAll()).filter((r) => r.providerType === 'opencode');
    assert.equal(allOpencode.length, 1, 'No extra runtime may be created from an unverified title token');
    const stamped = allOpencode.find((r) => r.externalSessionId === 'sess_title_token');
    assert.equal(stamped, undefined, 'Title-derived token must not exist as an external session ID');

    const reloadedPair = await db.pairs.findById(pair.id);
    assert.ok(reloadedPair);
    assert.equal(reloadedPair.workerSessionId, legacy.runtime.id, 'Pair binding must not be claimed');
    assert.equal(legacy.runtime.externalSessionId, null, 'Legacy runtime identity must remain unchanged');
  });

  it('discovery without an external ID retains the documented legacy fallback behavior', async () => {
    // No authoritative identity anywhere in the evidence.
    assert.equal(provider.authoritativeSessionId, undefined);

    const first = await engine.discoverRuntime('opencode');
    assert.equal(first.isNew, true);

    // Repeated discovery with the same PID updates the existing runtime.
    const second = await engine.discoverRuntime('opencode');
    assert.equal(second.isNew, false);
    assert.equal(second.runtime.id, first.runtime.id);

    // Provider-only fallback retained: a discovery with no shared PID/bundle
    // still reuses the existing runtime of the provider rather than duplicating.
    provider.applicationPid = 77777;
    const third = await engine.discoverRuntime('opencode');
    assert.equal(third.isNew, false);
    assert.equal(third.runtime.id, first.runtime.id);

    const all = await db.runtimes.findAll();
    assert.equal(all.length, 1, 'Legacy discovery must not create duplicates');
  });
});
