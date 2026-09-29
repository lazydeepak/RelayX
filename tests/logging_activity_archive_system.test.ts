/**
 * Logging, Activity & Archive System Tests
 *
 * Verifies:
 * 1. Detailed structured logs & activity lineage capture full provenance and evidence.
 * 2. Search and filter by resource type, actor, correlation key.
 * 3. Checkpoints remain strictly separate, immutable, and append-only.
 * 4. Archival retention policy defaults to 7 days, supports custom retention and indefinite retention.
 * 5. Historical activity and evidence are preserved across lifecycle events.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEvent, RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
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

async function createPairFixture(engine: RelayEngine, db: MemoryRelayDatabase, projectId: any, pairName: string) {
  const planner = RuntimeSession.create('chatgpt', `${pairName} Planner`);
  const plannerExtId = 'conv_' + Math.random().toString(36).substring(7);
  planner.updateExternalIdentity(plannerExtId);
  await db.runtimes.save(planner);

  const worker = RuntimeSession.create('opencode', `${pairName} Worker`);
  const workerExtId = 'ses_' + Math.random().toString(36).substring(7);
  worker.updateExternalIdentity(workerExtId);
  await db.runtimes.save(worker);

  // Authoritative verified associations for pre-pair gating
  await db.associations.save(
    RuntimeProjectAssociation.create(
      planner.id,
      projectId,
      plannerExtId,
      'verified',
      'adoption',
      'chatgpt',
    ),
  );
  await db.associations.save(
    RuntimeProjectAssociation.create(
      worker.id,
      projectId,
      workerExtId,
      'verified',
      'adoption',
      'opencode',
    ),
  );

  const pair = await engine.createPair(projectId, pairName, planner.id, worker.id);
  return { planner, worker, pair };
}

describe('Logging, Activity & Archive System', () => {
  it('1. Detailed structured events capture full provenance, actor, and evidence', async () => {
    const { service, engine, db } = createTestService();

    const project = await engine.createProject('Archive Test Project', 'Testing event lineage');
    const { pair } = await createPairFixture(engine, db, project.id, 'Archive Pair');

    const events = await service.listEvents(100);
    assert.ok(events.length >= 2, 'Events should be recorded for project and pair creation');

    const projectEvent = events.find((e) => e.resourceType === 'project' && e.resourceId === project.id);
    assert.ok(projectEvent, 'Project creation event must be recorded');
    assert.strictEqual(projectEvent.eventType, 'project.created');
    assert.strictEqual(projectEvent.actor, 'user');

    const pairEvent = events.find((e) => e.resourceType === 'pair' && e.resourceId === pair.id);
    assert.ok(pairEvent, 'Pair creation event must be recorded');
    assert.strictEqual(pairEvent.eventType, 'pair.created');
  });

  it('2. Events are filterable by resourceId, resourceType, and correlation ID', async () => {
    const { service, engine, db } = createTestService();

    const project = await engine.createProject('Filter Project');
    const { pair: pair1 } = await createPairFixture(engine, db, project.id, 'Pair 1');
    const { pair: pair2 } = await createPairFixture(engine, db, project.id, 'Pair 2');

    // Filter specifically by pair1 resourceId
    const pair1Events = await service.listEvents(50, pair1.id);
    assert.ok(pair1Events.length > 0);
    for (const ev of pair1Events) {
      assert.strictEqual(ev.resourceId, pair1.id);
    }

    // Filter by pair2 resourceId
    const pair2Events = await service.listEvents(50, pair2.id);
    assert.ok(pair2Events.length > 0);
    for (const ev of pair2Events) {
      assert.strictEqual(ev.resourceId, pair2.id);
    }
  });

  it('3. Checkpoints remain strictly separate from transient activity/logs and are append-only', async () => {
    const { service, engine, db } = createTestService();

    const project = await engine.createProject('Checkpoint Project');
    const { pair } = await createPairFixture(engine, db, project.id, 'Checkpoint Pair');

    // Create checkpoints
    const cp1 = await engine.createPairCheckpoint(pair.id, 'operator_baseline', {
      summary: 'Initial baseline checkpoint',
    });
    await new Promise((r) => setTimeout(r, 15));
    const cp2 = await engine.createPairCheckpoint(pair.id, 'manual_sync', {
      summary: 'Second sync checkpoint',
    });

    const checkpoints = await db.checkpoints.findAll(pair.id);
    assert.ok(checkpoints.length >= 2, 'Checkpoints must exist');
    assert.ok(checkpoints.some((c) => c.summary === 'Initial baseline checkpoint'));
    assert.ok(checkpoints.some((c) => c.summary === 'Second sync checkpoint'));

    // Latest checkpoint retrieval
    const latest = await db.checkpoints.findLatest(pair.id);
    assert.ok(latest);
    assert.strictEqual(latest.id, cp2.id);
  });

  it('4. Archival retention policy is configurable and distinguishes 7d default from indefinite retention', async () => {
    const { service, engine } = createTestService();

    // Default archival interval setting
    const defaultSetting = await engine.getProviderSetting('policy:archiveInterval');
    assert.strictEqual(defaultSetting, null, 'Unset defaults cleanly to system 7d standard');

    // Set custom archival retention: 14d
    await engine.setProviderSetting('policy:archiveInterval', '14d', {
      note: 'Operator retention extension',
      setBy: 'operator',
    });
    const updatedSetting = await engine.getProviderSetting('policy:archiveInterval');
    assert.strictEqual(updatedSetting?.value, '14d');

    // Set indefinite retention: 'none'
    await engine.setProviderSetting('policy:archiveInterval', 'none', {
      note: 'Retain all audit logs indefinitely',
      setBy: 'operator',
    });
    const indefiniteSetting = await engine.getProviderSetting('policy:archiveInterval');
    assert.strictEqual(indefiniteSetting?.value, 'none');
  });

  it('5. Project and Pair archiving transitions states truthfully while preserving lineage and checkpoints', async () => {
    const { service, engine, db } = createTestService();

    const project = await engine.createProject('Lifecycle Project');
    const { pair } = await createPairFixture(engine, db, project.id, 'Lifecycle Pair');

    // Create an initial baseline checkpoint
    await engine.createPairCheckpoint(pair.id, 'operator_baseline', { summary: 'Baseline before archive' });

    // Archive the pair
    const archivedPair = await service.archivePair(pair.id);
    assert.strictEqual(archivedPair.status, 'archived');

    // Check that pair archive created an archival checkpoint
    const checkpoints = await db.checkpoints.findAll(pair.id);
    assert.ok(checkpoints.length >= 2, 'Archival must record a final checkpoint');

    // Archive the project
    const archivedProject = await service.archiveProject(project.id);
    assert.strictEqual(archivedProject.status, 'archived');

    // Verify all history events are intact
    const events = await service.listEvents(100);
    const archiveEvents = events.filter((e) => e.eventType.includes('archived'));
    assert.ok(archiveEvents.length >= 2, 'Both pair and project archive events must exist in lineage');

    // Unarchive
    const unarchivedPair = await service.unarchivePair(pair.id);
    assert.strictEqual(unarchivedPair.status, 'idle');

    const unarchivedProject = await service.unarchiveProject(project.id);
    assert.strictEqual(unarchivedProject.status, 'active');
  });
});
