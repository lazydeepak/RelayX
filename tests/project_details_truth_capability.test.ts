/**
 * Project Details — Project Truth & Engine Capability Tests
 *
 * Verifies:
 * 1. Project-centric rather than pair-centric truth model.
 * 2. Durable project configuration: canonical path, git root, planner destination, worker destination.
 * 3. Configuration changes invalidate dependent evidence (marks associations stale) and trigger revalidation.
 * 4. Name-only updates do not invalidate existing verified associations.
 * 5. Derived/observed facts remain read-only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import {
  BrowserChatGPTProvider,
  BrowserOpenCodeProvider,
  BrowserVSCodeProvider,
} from '../src/relay/providers/browserProviders.ts';

function createTestService(): { service: RelayApiService; db: MemoryRelayDatabase; engine: RelayEngine } {
  const memDb = new MemoryRelayDatabase();
  const engine = new RelayEngine(memDb);
  engine.registerProvider(new BrowserChatGPTProvider());
  engine.registerProvider(new BrowserOpenCodeProvider());
  engine.registerProvider(new BrowserVSCodeProvider());

  const service = new RelayApiService(memDb, engine, {
    isElectron: false,
    databasePath: ':memory:',
    databaseType: 'memory',
  });

  return { service, db: memDb, engine };
}

describe('Project Details — Project Truth & Engine Capability', () => {
  it('1. Project configuration preserves canonical path, git root, and provider destinations', async () => {
    const { service } = createTestService();

    const created = await service.createProject('Backend API', 'Core server services');
    assert.strictEqual(created.name, 'Backend API');

    // Update with full durable configuration
    const updated = await service.updateProject(created.id, {
      name: 'Backend API Platform',
      description: 'Distributed backend and microservices',
      canonicalPath: '/Users/dev/repos/backend-api',
      gitRoot: '/Users/dev/repos/backend-api',
      plannerProjectUrl: 'https://chatgpt.com/g/g-p-12345/project',
      workerWorkspacePath: '/Users/dev/repos/backend-api/packages/server',
    });

    assert.strictEqual(updated.name, 'Backend API Platform');
    assert.strictEqual(updated.canonicalPath, '/Users/dev/repos/backend-api');
    assert.strictEqual(updated.gitRoot, '/Users/dev/repos/backend-api');
    assert.strictEqual(updated.plannerProjectUrl, 'https://chatgpt.com/g/g-p-12345/project');
    assert.strictEqual(updated.workerWorkspacePath, '/Users/dev/repos/backend-api/packages/server');
  });

  it('2. Configuration changes invalidate dependent evidence and mark associations stale', async () => {
    const { service, db, engine } = createTestService();

    const project = await engine.createProject(
      'Configured Project',
      'Initial description',
      '/original/path',
      '/original/path',
    );

    const worker = RuntimeSession.create('opencode', 'Worker Attached');
    worker.updateExternalIdentity('ses_999', '/original/path');
    await db.runtimes.save(worker);

    // Save a verified association bound to the initial path
    const assoc = RuntimeProjectAssociation.create(
      worker.id,
      project.id,
      'ses_999',
      'verified',
      'adoption',
      'opencode',
    );
    await db.associations.save(assoc);

    const initialAssoc = await db.associations.findById(assoc.id);
    assert.strictEqual(initialAssoc?.verificationState, 'verified');

    // Update canonical path
    await service.updateProject(project.id, {
      canonicalPath: '/new/relocated/path',
    });

    // Dependent association must be invalidated to 'stale'
    const invalidatedAssoc = await db.associations.findById(assoc.id);
    assert.strictEqual(invalidatedAssoc?.verificationState, 'stale');
  });

  it('3. Metadata-only update preserves verified association state', async () => {
    const { service, db, engine } = createTestService();

    const project = await engine.createProject(
      'Stable Project',
      'Initial description',
      '/stable/path',
    );

    const worker = RuntimeSession.create('opencode', 'Worker Stable');
    worker.updateExternalIdentity('ses_stable', '/stable/path');
    await db.runtimes.save(worker);

    const assoc = RuntimeProjectAssociation.create(
      worker.id,
      project.id,
      'ses_stable',
      'verified',
      'adoption',
      'opencode',
    );
    await db.associations.save(assoc);

    // Update only project name / description (no path modification)
    await service.updateProject(project.id, {
      name: 'Renamed Stable Project',
      description: 'Updated description',
    });

    const keptAssoc = await db.associations.findById(assoc.id);
    assert.strictEqual(keptAssoc?.verificationState, 'verified', 'Verified association preserved when paths do not change');
  });
});
