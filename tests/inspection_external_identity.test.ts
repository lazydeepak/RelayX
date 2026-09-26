import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { MockProvider } from './MockProvider.ts';
import {
  RuntimeInspectionResult,
  RuntimeTargetDescriptor,
} from '../src/relay/providers/interfaces.ts';
import { RuntimeSessionId } from '../src/relay/domain/types.ts';
import { RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';

/**
 * Provider stub that lets a test inject identity-shaped evidence details into
 * the inspection result (`inspectRuntime`) — mirroring what the real OpenCode /
 * ChatGPT adapters attach per source (authoritative, window-title, project).
 */
class InspectIdentityMockProvider extends MockProvider {
  public authoritativeSessionId?: string;
  public parsedSessionId?: string;
  public workspacePath?: string;
  public projectUrl?: string;
  public projectName?: string;
  public openCodeProjectId?: string;

  override async findRuntime(descriptor: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult> {
    const result = await super.findRuntime(descriptor);
    if (
      this.authoritativeSessionId ||
      this.parsedSessionId ||
      this.workspacePath ||
      this.projectUrl ||
      this.projectName ||
      this.openCodeProjectId
    ) {
      result.evidence = {
        ...result.evidence,
        details: {
          ...result.evidence.details,
          ...(this.authoritativeSessionId ? { authoritativeSessionId: this.authoritativeSessionId } : {}),
          ...(this.parsedSessionId ? { parsedSessionId: this.parsedSessionId } : {}),
          ...(this.workspacePath ? { workspacePath: this.workspacePath } : {}),
          ...(this.projectUrl ? { projectUrl: this.projectUrl } : {}),
          ...(this.projectName ? { projectName: this.projectName } : {}),
          ...(this.openCodeProjectId ? { openCodeProjectId: this.openCodeProjectId } : {}),
        },
      };
    }
    return result;
  }
}

describe('inspectRuntime persists identity only from an authoritative session ID', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;
  let provider: InspectIdentityMockProvider;
  let gptProvider: InspectIdentityMockProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    provider = new InspectIdentityMockProvider('opencode');
    gptProvider = new InspectIdentityMockProvider('chatgpt');
    engine.registerProvider(provider);
    engine.registerProvider(gptProvider);
    service = new RelayApiService(db, engine);
  });

  async function seedRuntime(providerType: 'opencode' | 'chatgpt'): Promise<string> {
    const { runtime } = await engine.discoverRuntime(providerType);
    return runtime.id;
  }

  it('a verified OpenCode session ID from inspection evidence is persisted', async () => {
    const id = await seedRuntime('opencode');
    provider.authoritativeSessionId = 'sess_alpha';
    provider.workspacePath = '/app/work';

    const res = await service.inspectRuntime(id);
    assert.equal(res.success, true);

    const reloaded = await db.runtimes.findById(id as RuntimeSessionId);
    assert.ok(reloaded);
    assert.equal(reloaded.externalSessionId, 'sess_alpha', 'Verified session ID must be persisted');
    assert.equal(reloaded.externalProjectRef, '/app/work', 'Workspace evidence is kept in the project ref');
  });

  it('project identity alone updates only the project reference, never the session ID', async () => {
    // OpenCode: project ID only (no session identity in the evidence).
    const opencodeId = await seedRuntime('opencode');
    provider.openCodeProjectId = 'proj_x';
    await service.inspectRuntime(opencodeId);

    let reloaded = await db.runtimes.findById(opencodeId as RuntimeSessionId);
    assert.ok(reloaded);
    assert.equal(reloaded.externalSessionId, null, 'Project ID must not become the session identity');
    assert.equal(reloaded.externalProjectRef, 'proj_x', 'Project ID is kept in externalProjectRef');

    // ChatGPT: project URL only.
    const chatgptId = await seedRuntime('chatgpt');
    gptProvider.projectUrl = 'https://chatgpt.com/c/proj-abc';
    gptProvider.projectName = 'Proj ABC';
    await service.inspectRuntime(chatgptId);

    reloaded = await db.runtimes.findById(chatgptId as RuntimeSessionId);
    assert.ok(reloaded);
    assert.equal(reloaded.externalSessionId, null, 'Project URL must not become the session identity');
    assert.equal(reloaded.externalProjectRef, 'https://chatgpt.com/c/proj-abc');
  });

  it('a window-title parsedSessionId alone never becomes the external session identity', async () => {
    const id = await seedRuntime('opencode');
    // Title-derived token only — never validated against the shared service.
    provider.parsedSessionId = 'sess_title_token';
    await service.inspectRuntime(id);

    const reloaded = await db.runtimes.findById(id as RuntimeSessionId);
    assert.ok(reloaded);
    assert.equal(reloaded.externalSessionId, null, 'Title token must not be persisted as the session identity');
    assert.equal(reloaded.externalProjectRef, null);

    const all = await db.runtimes.findAll();
    const stamped = all.find((r) => r.externalSessionId === 'sess_title_token');
    assert.equal(stamped, undefined, 'No runtime anywhere may carry the title-derived token');
  });

  it('an existing authoritative external ID survives a later inspection with no verified ID', async () => {
    // Runtime created with a verified session ID at discovery.
    provider.authoritativeSessionId = 'sess_real';
    const { runtime } = await engine.discoverRuntime('opencode');
    assert.equal(runtime.externalSessionId, 'sess_real');

    // A later inspection arrives with NO verified ID — only a window-title
    // token. The persisted authoritative identity must survive, un-nulled and
    // un-guessed.
    provider.authoritativeSessionId = undefined;
    provider.parsedSessionId = 'sess_title_token';
    provider.workspacePath = undefined;
    await service.inspectRuntime(runtime.id);

    const reloaded = await db.runtimes.findById(runtime.id);
    assert.ok(reloaded);
    assert.equal(reloaded.externalSessionId, 'sess_real', 'Existing authoritative ID must not be overwritten or nulled');
    assert.notEqual(reloaded.externalSessionId, 'sess_title_token');
    assert.equal(reloaded.externalProjectRef, null, 'Project ref unaffected when evidence carries no project info');
  });

  it('a paired runtime bound to ses_A is not reassigned when inspection verifies a different ses_B', async () => {
    // Runtime created with a verified session ID at discovery.
    provider.authoritativeSessionId = 'ses_A';
    const { runtime } = await engine.discoverRuntime('opencode');
    assert.equal(runtime.externalSessionId, 'ses_A');

    // Bind it to a pair as the worker. Pairing requires verified, project-scoped
    // evidence, so record the evidence that adoption of this discovered session
    // would have produced for the target project.
    const project = await engine.createProject('Identity Conflict Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'ChatGPT Planner');
    await db.associations.save(
      RuntimeProjectAssociation.create(
        runtime.id,
        project.id,
        'ses_A',
        'verified',
        'adoption',
        'opencode',
      ),
    );
    const pair = await engine.createPair(project.id, 'Default Pair', planner.id, runtime.id);
    assert.equal(pair.workerSessionId, runtime.id);

    // Inspection observes a DIFFERENT verified session ID.
    provider.authoritativeSessionId = 'ses_B';
    const res = await service.inspectRuntime(runtime.id);

    // Explicit conflict result via the existing error/evidence pattern.
    assert.equal(res.success, false, 'Identity conflict must be reported as a non-success result');
    assert.ok(res.error, 'Conflict must carry an error message');
    assert.match(res.error ?? '', /identity conflict/i);
    assert.equal((res.evidence?.details as any)?.identityConflict, true, 'Evidence must record the identity conflict');
    assert.equal((res.evidence?.details as any)?.persistedExternalSessionId, 'ses_A');
    assert.equal((res.evidence?.details as any)?.observedAuthoritativeSessionId, 'ses_B');

    // Persisted ID and pair binding are untouched.
    const reloaded = await db.runtimes.findById(runtime.id);
    assert.ok(reloaded);
    assert.equal(reloaded.externalSessionId, 'ses_A', 'Persisted external ID must not be replaced');
    assert.notEqual(reloaded.externalSessionId, 'ses_B');

    const reloadedPair = await db.pairs.findById(pair.id);
    assert.ok(reloadedPair);
    assert.equal(reloadedPair.workerSessionId, runtime.id, 'Pair binding must remain unchanged');

    // The new session is discovered as a DISTINCT runtime, never folded in.
    const { runtime: newRuntime, isNew } = await engine.discoverRuntime('opencode');
    assert.equal(isNew, true);
    assert.notEqual(newRuntime.id, runtime.id);
    assert.equal(newRuntime.externalSessionId, 'ses_B');
  });

  it('a verified ID refresh does not null a persisted project reference', async () => {
    const id = await seedRuntime('opencode');
    provider.authoritativeSessionId = 'sess_alpha';
    provider.workspacePath = '/app/work';
    await service.inspectRuntime(id);

    // Reinspect: same verified ID, workspace unchanged — project ref preserved.
    await service.inspectRuntime(id);

    const reloaded = await db.runtimes.findById(id as RuntimeSessionId);
    assert.ok(reloaded);
    assert.equal(reloaded.externalSessionId, 'sess_alpha');
    assert.equal(reloaded.externalProjectRef, '/app/work');
  });
});
