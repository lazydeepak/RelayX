import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { OpenCodeProvider } from '../src/relay/providers/adapters.ts';
import { Attempt } from '../src/relay/domain/entities.ts';

describe('Phase 8 & Phase 9 — Background Supervision & Crash/Restart Recovery', () => {
  it('starts and cleanly stops background supervision loop without leaks', () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);

    assert.equal(engine.isSupervisingLoopActive(), false);
    engine.startSupervisionLoop(10000);
    assert.equal(engine.isSupervisingLoopActive(), true);

    // Repeated call is idempotent
    engine.startSupervisionLoop(10000);
    assert.equal(engine.isSupervisingLoopActive(), true);

    engine.stopSupervisionLoop();
    assert.equal(engine.isSupervisingLoopActive(), false);
  });

  it('recovers active assignments and discovers completed work upon engine restart', async () => {
    const db = new MemoryRelayDatabase();
    const engine1 = new RelayEngine(db);

    class ControllableProvider extends OpenCodeProvider {
      public isComplete = false;
      public isWorking = true;

      protected override probeMacOSProcess(_name: string) {
        return {
          running: true,
          pid: 5521,
          windowTitle: 'OpenCode — [sess_recover] /repo',
          details: { testEnvironment: true },
        };
      }

      public override async inspectRuntime(_sessionId: any) {
        return {
          found: true,
          status: this.isWorking ? 'working' as const : 'available' as const,
          applicationPid: 5521,
          windowTitle: 'OpenCode — [sess_recover] /repo',
          isWorking: this.isWorking,
          isComplete: this.isComplete,
          lastResponseSnippet: this.isComplete ? 'Feature refactored while RelayX was offline.' : undefined,
          composerVisible: true,
          composerHasFocus: true,
          sendButtonVisible: true,
          stopButtonVisible: this.isWorking,
          cancelButtonVisible: false,
          evidence: {
            id: 'ev_recover_1',
            timestamp: Date.now(),
            source: 'macos_system_events' as const,
            runtimeSessionId: (_sessionId ?? 'rt_worker') as any,
          },
        };
      }
    }

    const provider1 = new ControllableProvider();
    engine1.registerProvider(provider1);

    const project = await engine1.createProject('Offline Recovery Project');
    const planner = await engine1.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine1.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine1.createPair(project.id, 'Pair 1', planner.id, worker.id);

    const assignment = await engine1.createAssignment(pair.id, 'Offline task', 'do something');
    // Dispatch assignment
    const attempt = Attempt.create(assignment.id, 1);
    await db.attempts.save(attempt);
    assignment.startAttempt(attempt);
    await db.assignments.save(assignment);
    worker.recordObservationSuccess('working');
    await db.runtimes.save(worker);

    // Worker completes while RelayX is shut down!
    provider1.isWorking = false;
    provider1.isComplete = true;

    // Simulate Relay restart: new RelayEngine instance with same database!
    const engine2 = new RelayEngine(db);
    engine2.registerProvider(provider1);

    const recoveryReport = await engine2.recoverOnStartup();
    assert.equal(recoveryReport.recoveredHandoffs, 1, 'Should recover 1 completed handoff');

    const updatedAsg = await db.assignments.findById(assignment.id);
    assert.equal(updatedAsg?.status, 'waiting_for_handoff');

    const handoffs = await db.handoffs.findByAssignmentId(assignment.id);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].status, 'ready');
    assert.equal(handoffs[0].resultSummary, 'Feature refactored while RelayX was offline.');
  });
});
