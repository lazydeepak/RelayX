import { describe, it } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import {
  Project,
  Pair,
  RuntimeSession,
  Assignment,
  Attempt,
  Delivery,
  RelayEvent,
  AttentionItem,
} from '../src/relay/domain/entities.ts';

describe('Relay SQLite Persistence & Restart Verification', () => {
  it('persists and recovers domain resources across clean restarts', async () => {
    const testDbPath = join(tmpdir(), `relay_restart_test_${Date.now()}.sqlite`);
    if (existsSync(testDbPath)) unlinkSync(testDbPath);

    try {
      // 1. First lifecycle session
      const db1 = new SqliteRelayDatabase(testDbPath);
      const project = Project.create('Restart Test Project', 'Testing durable persistence');
      await db1.projects.save(project);

      const planner = RuntimeSession.create('chatgpt', 'Planner Alpha', 'com.openai.chat');
      const worker = RuntimeSession.create('opencode', 'Worker Beta', 'com.opencode.desktop');
      worker.recordObservationSuccess('working', {
        id: 'ev_init',
        timestamp: Date.now(),
        source: 'macos_accessibility',
        windowTitle: 'OpenCode Session - Main',
        applicationPid: 9876,
      });
      await db1.runtimes.save(planner);
      await db1.runtimes.save(worker);

      const pair = Pair.create(project.id, 'Pair 1', planner.id, worker.id);
      await db1.pairs.save(pair);

      const assignment = Assignment.create(pair.id, project.id, 'Implement parser', 'Write tests first');
      await db1.assignments.save(assignment);
      const attempt = Attempt.create(assignment.id, 1);
      assignment.startAttempt(attempt);
      await db1.attempts.save(attempt);
      await db1.assignments.save(assignment);

      const delivery = Delivery.create(assignment.id, attempt.id, worker.id, 'Write tests', 'idemp_key_1');
      delivery.startDelivering();
      delivery.confirmDelivered({
        id: 'ev_deliv_ok',
        timestamp: Date.now(),
        source: 'macos_accessibility',
        composerCleared: true,
        responseActivityObserved: true,
      });
      await db1.deliveries.save(delivery);

      const event = RelayEvent.create('delivery', delivery.id, 'delivery.confirmed', {
        actor: 'provider',
        newState: 'delivered',
        correlationId: 'idemp_key_1',
      });
      await db1.events.save(event);

      const attention = AttentionItem.create('info', 'startup', 'System Initialized', 'Relay started cleanly');
      await db1.attention.save(attention);

      // Close connection (simulating unexpected termination / shutdown)
      db1.close();

      // 2. Second session: Restart and inspect reality from SQLite
      const db2 = new SqliteRelayDatabase(testDbPath);

      const loadedProject = await db2.projects.findById(project.id);
      assert.ok(loadedProject, 'Project must survive restart');
      assert.strictEqual(loadedProject.name, 'Restart Test Project');

      const loadedWorker = await db2.runtimes.findById(worker.id);
      assert.ok(loadedWorker, 'Worker runtime must survive restart');
      assert.strictEqual(loadedWorker.status, 'working');
      assert.strictEqual(loadedWorker.lastEvidence?.windowTitle, 'OpenCode Session - Main');
      assert.strictEqual(loadedWorker.applicationPid, 9876);

      const loadedAssignment = await db2.assignments.findById(assignment.id);
      assert.ok(loadedAssignment, 'Assignment must survive restart');
      assert.strictEqual(loadedAssignment.status, 'active');
      assert.strictEqual(loadedAssignment.currentAttemptId, attempt.id);

      const loadedDeliveries = await db2.deliveries.findByAssignmentId(assignment.id);
      assert.strictEqual(loadedDeliveries.length, 1);
      assert.strictEqual(loadedDeliveries[0].status, 'delivered');
      assert.strictEqual(loadedDeliveries[0].idempotencyKey, 'idemp_key_1');

      const loadedEvents = await db2.events.findByResourceId(delivery.id);
      assert.strictEqual(loadedEvents.length, 1);
      assert.strictEqual(loadedEvents[0].eventType, 'delivery.confirmed');

      const openAttentions = await db2.attention.findOpen();
      assert.strictEqual(openAttentions.length, 1);
      assert.strictEqual(openAttentions[0].title, 'System Initialized');

      db2.close();
    } finally {
      if (existsSync(testDbPath)) {
        try {
          unlinkSync(testDbPath);
        } catch {}
      }
    }
  });

  it('enforces foreign key constraints', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const pair = Pair.create('non_existent_project' as any, 'Invalid Pair', 'r1' as any, 'r2' as any);

    await assert.rejects(
      async () => db.pairs.save(pair),
      /FOREIGN KEY constraint failed/,
      'Should reject creating a pair referencing a non-existent project or runtimes',
    );

    db.close();
  });
});
