import test from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { ChatGPTProvider, OpenCodeProvider, VSCodeProvider } from '../src/relay/providers/adapters.ts';

test('Project, Pair, and Runtime Session Management Lifecycle and Deletion Guards', async (t) => {
  const db = new SqliteRelayDatabase(':memory:');
  const engine = new RelayEngine(db);
  engine.registerProvider(new ChatGPTProvider());
  engine.registerProvider(new OpenCodeProvider());
  engine.registerProvider(new VSCodeProvider());
  const service = new RelayApiService(db, engine);

  await t.test('1. Project Lifecycle: create, rename, archive, unarchive, and safe deletion', async () => {
    // Create
    const project = await service.createProject('Alpha Mobile App', 'Customer facing iOS/Android app');
    assert.strictEqual(project.name, 'Alpha Mobile App');
    assert.strictEqual(project.status, 'active');

    // Rename / Edit
    const updated = await service.updateProject(project.id, {
      name: 'Alpha SuperApp',
      description: 'Unified cross-platform client',
    });
    assert.strictEqual(updated.name, 'Alpha SuperApp');
    assert.strictEqual(updated.description, 'Unified cross-platform client');

    // Archive
    await service.archiveProject(project.id);
    const archived = await db.projects.findById(project.id as any);
    assert.strictEqual(archived?.status, 'archived');

    // Historical events remain readable after archival
    const eventsAfterArchive = await service.listEvents(100);
    const archiveEvent = eventsAfterArchive.find(
      (e) => e.resourceType === 'project' && e.eventType === 'project.archived',
    );
    assert.ok(archiveEvent, 'Historical archive event must be preserved in event store');

    // Unarchive
    await service.unarchiveProject(project.id);
    const unarchived = await db.projects.findById(project.id as any);
    assert.strictEqual(unarchived?.status, 'active');

    // Can delete check when clean
    const checkClean = await service.canDeleteProject(project.id);
    assert.strictEqual(checkClean.canDelete, true);
    assert.strictEqual(checkClean.reasons.length, 0);

    // Delete
    await service.deleteProject(project.id);
    const deleted = await db.projects.findById(project.id as any);
    assert.strictEqual(deleted, null, 'Project should be safely deleted when clean');
  });

  await t.test('2. Project Deletion Guard: blocks deletion when active pair/assignment exists', async () => {
    const project = await service.createProject('Beta Infrastructure');
    const planner = await service.registerRuntimeSession('chatgpt', 'Planner Bot');
    const worker = await service.registerRuntimeSession('opencode', 'Worker Bot');

    // Create Pair under Project
    const pair = await service.createPair(project.id, 'Infra Pair', planner.id, worker.id);
    assert.strictEqual(pair.projectId, project.id);
    assert.strictEqual(pair.status, 'idle');

    // Dispatch assignment to make it active
    const assignment = await service.createAssignment(
      pair.id,
      'Deploy Terraform',
      'Initialize and validate configurations',
    );
    await service.dispatchAssignment(assignment.id);

    // Try deleting project while pair is active
    const guardCheck = await service.canDeleteProject(project.id);
    assert.strictEqual(guardCheck.canDelete, false);
    assert.ok(
      guardCheck.reasons.some((r) => r.toLowerCase().includes('pair') || r.toLowerCase().includes('assignment') || r.toLowerCase().includes('running') || r.toLowerCase().includes('active')),
      `Expected deletion block reason, got: ${guardCheck.reasons.join(', ')}`,
    );

    // RelayApiService returns failure result
    const deleteAttempt = await service.deleteProject(project.id);
    assert.strictEqual(deleteAttempt.success, false);
    assert.ok(deleteAttempt.error && deleteAttempt.error.includes('Cannot delete project'));

    // Engine throws RelayDomainError directly
    await assert.rejects(
      async () => {
        await engine.deleteProject(project.id as any);
      },
      /Cannot delete project/i,
      'Engine must refuse hard deletion when active work is in flight',
    );

    // Completing assignment resolves active in-flight work
    await service.completeAssignment(assignment.id);

    // Archiving is allowed now
    await service.archiveProject(project.id);
    const projArchived = await db.projects.findById(project.id as any);
    assert.strictEqual(projArchived?.status, 'archived');
  });

  await t.test('3. Pair Management: edit, pause, resume, rebind runtimes, and safe deletion', async () => {
    const project = await service.createProject('Gamma Core');
    const planner1 = await service.registerRuntimeSession('chatgpt', 'Planner A');
    const worker1 = await service.registerRuntimeSession('opencode', 'Worker A');
    const worker2 = await service.registerRuntimeSession('vscode', 'Worker B (VS Code)');

    const pair = await service.createPair(project.id, 'Feature Team 1', planner1.id, worker1.id);
    assert.strictEqual(pair.workerSessionId, worker1.id);

    // Pause pair
    await service.pausePair(pair.id);
    const pausedPair = await db.pairs.findById(pair.id as any);
    assert.strictEqual(pausedPair?.status, 'paused');

    // Resume pair
    await service.startPair(pair.id);
    const resumedPair = await db.pairs.findById(pair.id as any);
    assert.strictEqual(resumedPair?.status, 'idle');

    // Rebind worker runtime to worker2
    await service.updatePair(pair.id, {
      name: 'Feature Team 1 (VS Code)',
      workerSessionId: worker2.id,
    });
    const updatedPair = await db.pairs.findById(pair.id as any);
    assert.strictEqual(updatedPair?.name, 'Feature Team 1 (VS Code)');
    assert.strictEqual(updatedPair?.workerSessionId, worker2.id);

    // Detach planner runtime
    await service.detachPairRuntime(pair.id, 'planner');
    const detachedPair = await db.pairs.findById(pair.id as any);
    assert.strictEqual(detachedPair?.plannerSessionId, undefined);

    // Archive pair
    await service.archivePair(pair.id);
    const archivedPair = await db.pairs.findById(pair.id as any);
    assert.strictEqual(archivedPair?.status, 'archived');

    // Unarchive pair
    await service.unarchivePair(pair.id);
    const restoredPair = await db.pairs.findById(pair.id as any);
    assert.strictEqual(restoredPair?.status, 'idle');

    // Safe delete clean pair
    const canDelete = await service.canDeletePair(pair.id);
    assert.strictEqual(canDelete.canDelete, true);
    await service.deletePair(pair.id);
    const deletedPair = await db.pairs.findById(pair.id as any);
    assert.strictEqual(deletedPair, null);
  });

  await t.test('4. Runtime Session: discovery, registration, detach from pairs, deletion guards', async () => {
    // Manually register
    const runtime = await service.registerRuntimeSession('opencode', 'Stale Process Worker');
    assert.strictEqual(runtime.name, 'Stale Process Worker');
    assert.strictEqual(runtime.status, 'unknown');

    // Attach to a pair
    const project = await service.createProject('Delta Ops');
    const pair = await service.createPair(project.id, 'Ops Pair', undefined, runtime.id);

    // Deletion guard checks: runtime is attached to active pair
    const checkAttached = await service.canDeleteRuntimeSession(runtime.id);
    assert.strictEqual(checkAttached.canDelete, false);
    assert.ok(checkAttached.reasons.some((r) => r.includes('attached')));

    // Detach runtime from all pairs
    const detachResult = await service.detachRuntime(runtime.id);
    assert.strictEqual(detachResult.success, true);
    assert.strictEqual(detachResult.detachedFromPairs.length, 1);

    const pairAfterDetach = await db.pairs.findById(pair.id as any);
    assert.strictEqual(pairAfterDetach?.workerSessionId, undefined);

    // Now safe to delete stale runtime record
    const checkAfterDetach = await service.canDeleteRuntimeSession(runtime.id);
    assert.strictEqual(checkAfterDetach.canDelete, true);

    await service.deleteRuntimeSession(runtime.id);
    const deletedRuntime = await db.runtimes.findById(runtime.id as any);
    assert.strictEqual(deletedRuntime, null);

    // Discover runtime session: on Linux/CI, truthful adapter reports unprobed/not running
    const discovery = await service.discoverRuntime('chatgpt');
    assert.ok(typeof discovery.success === 'boolean');
    assert.ok(discovery.runtime, 'Runtime record is tracked on discovery');

    // Register a mock provider with found: true to verify successful discovered attachment
    class MockAvailableProvider extends OpenCodeProvider {
      public override async findRuntime(_target?: any) {
        return {
          found: true,
          status: 'available' as const,
          applicationPid: 9912,
          windowTitle: 'OpenCode — Workspace',
          isWorking: false,
          isComplete: false,
          composerVisible: true,
          composerHasFocus: true,
          sendButtonVisible: true,
          stopButtonVisible: false,
          cancelButtonVisible: false,
          evidence: {
            id: 'ev_disc_1',
            timestamp: Date.now(),
            source: 'macos_system_events' as const,
            runtimeSessionId: 'mock_session' as any,
          },
        };
      }
    }
    engine.registerProvider(new MockAvailableProvider());
    const mockDiscovery = await service.discoverRuntime('opencode');
    assert.strictEqual(mockDiscovery.success, true);
    assert.strictEqual(mockDiscovery.runtime?.status, 'available');
    assert.strictEqual(mockDiscovery.runtime?.applicationPid, 9912);
  });

  await t.test('5. Add Project Workflow: finalize project setup with bindings', async () => {
    const setup = {
      name: 'Alpha Project',
      description: 'Discovered project via workflow',
      canonicalPath: '/Users/test/alpha-app',
      gitRoot: '/Users/test/alpha-app',
      plannerUrl: 'https://chatgpt.com/p/alpha-id',
      workerSessionId: 'session_alpha_99',
    };

    const result = await service.finalizeProjectSetup(setup);
    assert.strictEqual(result.success, true);
    assert.ok(result.projectId);

    // Verify Project
    const project = await db.projects.findById(result.projectId as any);
    assert.strictEqual(project?.name, 'Alpha Project');
    assert.strictEqual(project?.canonicalPath, '/Users/test/alpha-app');
    assert.strictEqual(project?.gitRoot, '/Users/test/alpha-app');

    // Verify Pair created
    const pairs = await db.pairs.findByProjectId(result.projectId as any);
    assert.strictEqual(pairs.length, 1);
    const pair = pairs[0];
    assert.strictEqual(pair.name, 'Default Pair');
    assert.ok(pair.plannerSessionId);
    assert.ok(pair.workerSessionId);

    // Verify Runtimes registered and bound
    const planner = await db.runtimes.findById(pair.plannerSessionId!);
    assert.strictEqual(planner?.providerType, 'chatgpt');
    assert.strictEqual((planner?.lastEvidence?.details as any)?.projectUrl, 'https://chatgpt.com/p/alpha-id');

    const worker = await db.runtimes.findById(pair.workerSessionId!);
    assert.strictEqual(worker?.providerType, 'opencode');
    assert.strictEqual((worker?.lastEvidence?.details as any)?.sessionId, 'session_alpha_99');
  });
});
