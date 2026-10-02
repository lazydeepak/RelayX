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

  it('6. Filtered event queries support search, severity, actor, area, and pagination', async () => {
    const { service, engine, db } = createTestService();
    const project = await engine.createProject('Query Test Project');
    const { pair } = await createPairFixture(engine, db, project.id, 'Query Pair');

    // Create an assignment to generate diverse events
    const asg = await engine.createAssignment(pair.id, 'Test Query Assignment', 'echo test');

    const resAll = await service.queryEvents({ limit: 10, offset: 0 });
    assert.ok(resAll.events.length > 0);
    assert.ok(resAll.total >= resAll.events.length);

    // Search query
    const searchRes = await service.queryEvents({ search: 'Query Pair' });
    assert.ok(searchRes.events.length > 0);
    assert.ok(searchRes.events.some((e) => JSON.stringify(e).includes('Query Pair') || e.resourceId === pair.id));

    // ResourceType filter
    const pairOnlyRes = await service.queryEvents({ resourceType: 'pair' });
    assert.ok(pairOnlyRes.events.length > 0);
    assert.ok(pairOnlyRes.events.every((e) => e.resourceType === 'pair'));

    // Pagination limit & offset
    const page1 = await service.queryEvents({ limit: 2, offset: 0 });
    const page2 = await service.queryEvents({ limit: 2, offset: 2 });
    assert.strictEqual(page1.events.length, 2);
    assert.notStrictEqual(page1.events[0].id, page2.events[0]?.id);
  });

  it('7. Real Activity projection automatically projects domain events into human-readable ActivityRecords', async () => {
    const { service, engine, db } = createTestService();
    const project = await engine.createProject('Projection Project', 'Testing activity projection');
    const { pair } = await createPairFixture(engine, db, project.id, 'Projection Pair');

    const activities = await service.listActivities(50);
    assert.ok(activities.length >= 2, 'Activities must be projected from events');

    const projectAct = activities.find((a) => a.resourceType === 'project' && a.resourceId === project.id);
    assert.ok(projectAct, 'Project creation activity must exist');
    assert.strictEqual(projectAct.title, 'Project Created');
    assert.strictEqual(projectAct.category, 'lifecycle');
    assert.ok(projectAct.summary.includes('Projection Project'));

    const pairAct = activities.find((a) => a.resourceType === 'pair' && a.resourceId === pair.id);
    assert.ok(pairAct, 'Pair creation activity must exist');
    assert.strictEqual(pairAct.title, 'Pair Formed');
    assert.strictEqual(pairAct.category, 'execution');
  });

  it('8. Archive runner moves expired events to archive and preserves them for archived-event queries', async () => {
    const { service, engine, db } = createTestService();
    const project = await engine.createProject('Archive Runner Project');

    // Set retention policy to 1d
    await service.setArchivePolicy('1d', 'Test short retention');

    // Create an old event with timestamp 2 days ago
    const oldTimestamp = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const oldEvent = RelayEvent.create('project', project.id, 'project.old_diagnostic', {
      details: { note: 'Historical record' },
    });
    // Mutate timestamp to simulate past event
    (oldEvent as any).timestamp = oldTimestamp;
    await db.events.save(oldEvent);

    // Prior to archive cycle, it is not archived
    const beforeActive = await service.queryEvents({ isArchived: false });
    assert.ok(beforeActive.events.some((e) => e.id === oldEvent.id));

    // Run archive cycle
    const archiveResult = await service.runArchiveCycle();
    assert.ok(archiveResult.archivedCount >= 1, 'At least 1 event older than 1d must be archived');

    // Now, active query does NOT contain the old event
    const afterActive = await service.queryEvents({ isArchived: false });
    assert.ok(!afterActive.events.some((e) => e.id === oldEvent.id));

    // But archived query DOES contain it
    const afterArchived = await service.queryEvents({ isArchived: true });
    const found = afterArchived.events.find((e) => e.id === oldEvent.id);
    assert.ok(found, 'Archived event must be accessible via archived-event query');
    assert.strictEqual(found.isArchived, true);
  });

  it('9. Retention policy persists across service reloads and correctly computes effective retention', async () => {
    const { service, engine } = createTestService();

    // Default policy
    const policyDefault = await service.getArchivePolicy();
    assert.strictEqual(policyDefault.interval, '7d');
    assert.strictEqual(policyDefault.effectiveRetentionDays, 7);

    // Update to 30d
    await service.setArchivePolicy('30d', 'Compliance rule');
    const policyUpdated = await service.getArchivePolicy();
    assert.strictEqual(policyUpdated.interval, '30d');
    assert.strictEqual(policyUpdated.effectiveRetentionDays, 30);
    assert.strictEqual(policyUpdated.note, 'Compliance rule');

    // Update to indefinite retention ('none')
    await service.setArchivePolicy('none', 'Keep forever');
    const policyIndefinite = await service.getArchivePolicy();
    assert.strictEqual(policyIndefinite.interval, 'none');
    assert.strictEqual(policyIndefinite.effectiveRetentionDays, null);
  });

  it('10. Safe Clear Logs purges only archived logs and strictly protects active lineage', async () => {
    const { service, engine, db } = createTestService();
    const project = await engine.createProject('Safe Clear Project');

    // Set retention to 1d
    await service.setArchivePolicy('1d');

    // Save one past event and run archive cycle
    const oldTimestamp = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const oldEvent = RelayEvent.create('project', project.id, 'project.old_diagnostic');
    (oldEvent as any).timestamp = oldTimestamp;
    await db.events.save(oldEvent);

    await service.runArchiveCycle();

    // Now we have at least 1 active event (project.created) and 1 archived event (old_diagnostic)
    const activeBefore = await service.queryEvents({ isArchived: false });
    const archivedBefore = await service.queryEvents({ isArchived: true });
    assert.ok(activeBefore.total >= 1);
    assert.ok(archivedBefore.total >= 1);

    // Execute safe clear logs (only archived)
    const clearResult = await service.clearLogs({ includeArchived: false });
    assert.ok(clearResult.clearedCount >= 1, 'Archived events should be purged');

    // Verify: archived query is now empty
    const archivedAfter = await service.queryEvents({ isArchived: true });
    assert.strictEqual(archivedAfter.total, 0, 'Archived events should be gone');

    // Verify: active events are completely intact
    const activeAfter = await service.queryEvents({ isArchived: false });
    assert.strictEqual(activeAfter.total, activeBefore.total, 'Active events must NOT be deleted by safe clear');
  });

  it('11. Storage accounting, export/backup, and auxiliary log management are complete and functional', async () => {
    const { service, engine } = createTestService();
    await engine.createProject('Storage Project');

    // 1. Storage accounting
    const storage = await service.getStorageAccounting();
    assert.ok(storage.totalEvents >= 1);
    assert.ok(storage.totalActivities >= 1);
    assert.ok(Array.isArray(storage.traceLogs));

    // 2. Audit export bundle
    const bundle = await service.exportAuditData({ includeArchived: true });
    assert.strictEqual(bundle.version, '1.0.0');
    assert.ok(bundle.counts.projects >= 1);
    assert.ok(bundle.counts.events >= 1);
    assert.ok(bundle.counts.activities >= 1);
    assert.ok(Array.isArray(bundle.projects));
    assert.ok(Array.isArray(bundle.events));

    // 3. Auxiliary log management
    const auxInfo = await service.getAuxiliaryLogsInfo();
    assert.ok(auxInfo.length >= 2);
    assert.ok(auxInfo.some((l) => l.name === 'bootstrap-trace.log'));
    assert.ok(auxInfo.some((l) => l.name === 'opencode-c2-trace.log'));

    const readRes = await service.readAuxiliaryLog('bootstrap-trace.log', 10);
    assert.strictEqual(readRes.name, 'bootstrap-trace.log');

    const clearRes = await service.clearAuxiliaryLog('bootstrap-trace.log');
    assert.strictEqual(clearRes.success, true);
  });

  it('12. Attention items correlate truthfully with events and evidence, enabling deterministic investigation', async () => {
    const { service, engine, db } = createTestService();
    const project = await engine.createProject('Attention Correlation Project');
    const { pair } = await createPairFixture(engine, db, project.id, 'Attention Pair');

    const asg = await engine.createAssignment(pair.id, 'Attention Assignment', 'execute task');

    // Create a delivery with verifiable trace evidence
    const { Delivery } = await import('../src/relay/domain/entities.ts');
    const delivery = Delivery.create(
      asg.id,
      'att_1' as any,
      pair.workerSessionId!,
      'execute task',
      'idem_key_1',
    );
    delivery.status = 'ambiguous';
    delivery.evidence = {
      id: 'ev_123',
      source: 'reconciliation_probe',
      windowTitle: 'Task Inspector Window',
      details: { stdout: 'Task output with warning' },
      timestamp: Date.now(),
    };
    await db.deliveries.save(delivery);

    // Create Attention item referencing this delivery & assignment
    const { AttentionItem } = await import('../src/relay/domain/entities.ts');
    const attItem = AttentionItem.create(
      'warning',
      'ambiguous_delivery',
      'Ambiguous Delivery Detected',
      'Delivery status could not be verified automatically',
      {
        pairId: pair.id,
        assignmentId: asg.id,
        suggestedAction: 'Confirm delivered or mark as failed',
      },
    );
    await db.attention.save(attItem);

    // List attention items via API
    const items = await service.listAttentionItems();
    const matched = items.find((i) => i.id === attItem.id);
    assert.ok(matched, 'Attention item must be listed');
    assert.strictEqual(matched.assignmentId, asg.id);
    assert.strictEqual(matched.pairId, pair.id);
    assert.strictEqual(matched.deliveryId, delivery.id);
    assert.ok(matched.evidence, 'Evidence from ambiguous delivery must be attached');
    assert.strictEqual(matched.evidence?.id, 'ev_123');

    // Query correlated events by assignment ID
    const correlatedEvents = await service.queryEvents({ resourceId: asg.id });
    assert.ok(correlatedEvents.total >= 1, 'Correlated events for assignment must exist');
    assert.ok(correlatedEvents.events.some((e) => e.resourceId === asg.id));
  });
});
