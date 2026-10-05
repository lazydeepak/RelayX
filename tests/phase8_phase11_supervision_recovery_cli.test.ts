import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { OpenCodeProvider } from '../src/relay/providers/adapters.ts';
import { Attempt } from '../src/relay/domain/entities.ts';
import { MockProvider } from './MockProvider.ts';
import type { SideIdentityRequest, SideIdentityResolution } from '../src/relay/providers/interfaces.ts';
import { buildWatermark, type ReconciliationMessage } from '../src/relay/providers/exactSessionReconciliation.ts';

/**
 * Hermetic identity read.
 *
 * Load & Activate (S6) is the only authorized `IDLE -> ACTIVE` grantor, and it
 * calls the provider's read-only identity capability. The production
 * `OpenCodeProvider.resolveSideIdentity` shells out to the real CLI, which would
 * make this restart test environment-dependent, so the test provider answers
 * in-process instead.
 */
class HermeticIdentityOpenCode extends OpenCodeProvider {
  public override async resolveSideIdentity(
    request: SideIdentityRequest,
  ): Promise<SideIdentityResolution> {
    return {
      identityState: 'resolved',
      identityValue: request.externalSessionId,
      verificationState: 'verified',
      verificationValue: request.externalSessionId,
      existenceState: 'present',
      sourceCapability: 'test_hermetic_identity',
      observedAt: Date.now(),
      reason: null,
    };
  }
}

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

    class ControllableProvider extends HermeticIdentityOpenCode {
      public isComplete = false;
      public isWorking = true;
      /** The hermetic exact session the relay baton reads. */
      private readonly turns: ReconciliationMessage[] = [];

      protected override probeMacOSProcess(_name: string) {
        return {
          running: true,
          pid: 5521,
          windowTitle: 'OpenCode — [sess_recover] /repo',
          details: { testEnvironment: true },
        };
      }

      public override async deliverInstruction(request: any): Promise<any> {
        // A confirmed send must land in the exact session, or there is nothing after the
        // boundary for the baton to observe on the far side of the restart.
        this.turns.push({
          messageId: `msg_dispatched_${this.turns.length}`,
          role: 'user',
          createdAt: 2_000,
          text: request.instructionText,
        });
        return {
          outcome: 'delivered',
          evidence: {
            id: `ev_recover_d_${Date.now()}`,
            timestamp: Date.now(),
            source: 'macos_system_events' as const,
            runtimeSessionId: request.runtimeSessionId,
          },
        };
      }

      /** The pre-dispatch boundary, from the hermetic transcript rather than the real CLI. */
      public override async captureTransportBoundary(request: any): Promise<any> {
        return {
          watermark: buildWatermark(request.externalSessionId ?? 'ses_recover', this.turns, Date.now()),
          failure: null,
        };
      }

      /**
       * The authoritative exact-session read, hermetic.
       *
       * A still-running turn has no terminator and no text; a finished one carries a
       * run-terminating `finish` and the response. That is the only difference the relay
       * baton looks at, so rendering `isWorking` / `isComplete` into the transcript is what
       * makes this restart test exercise the production path.
       */
      public override async readExactSessionTurnsForReconciliation(): Promise<any> {
        return {
          readable: true,
          messages: [
            ...this.turns,
            {
              messageId: 'msg_response',
              role: 'assistant',
              createdAt: 3_000,
              text: this.isComplete ? 'Feature refactored while RelayX was offline.' : '',
              finish: this.isWorking ? null : this.isComplete ? 'stop' : null,
            } as ReconciliationMessage,
          ],
          failure: null,
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
    // §4.4 per-side "provider capabilities present": the bound planner side needs a
    // registered provider, reported as `unknown` (LEVEL 0) rather than blocking.
    engine1.registerProvider(new MockProvider('chatgpt'));

    const project = await engine1.createProject('Offline Recovery Project');
    const planner = await engine1.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine1.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine1.createPair(project.id, 'Pair 1', planner.id, worker.id);
    // The relay baton addresses ONE exact provider session per side, so these fixtures bind a
    // real external session identity (I-11). Binding happens AFTER createPair on purpose:
    // createPair demands verified project-association evidence for a session that already has an
    // external id, and these fixtures exercise the relay loop rather than pairing authority.
    planner.updateExternalIdentity('ses_chatgpt_phase8_phase11_supervision_recovery_cli_pl1', '/dev/phase8_phase11_supervision_recovery_cli_pl1');
    worker.updateExternalIdentity('ses_opencode_phase8_phase11_supervision_recovery_cli_wr1', '/dev/phase8_phase11_supervision_recovery_cli_wr1');
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    // I-2 (S6): engine2's startup recovery reaches the provider, so the Pair must be
    // ACTIVE. This is also what makes the restart assertion meaningful: the pair is
    // activated, the engine is rebuilt, and the recovered operational state still
    // permits contact. Load & Activate is the only authorized grantor (§4.4, §11.5).
    assert.strictEqual((await engine1.loadAndActivate(pair.id)).outcome, 'activated');
    await engine1.startPair(pair.id);

    const assignment = await engine1.createAssignment(pair.id, 'Offline task', 'do something');
    // Dispatched for real, so a confirmed Delivery and its recorded pre-dispatch boundary
    // exist before the restart. The relay baton is defined as "recipient of the last
    // CONFIRMED Delivery", so an Assignment that was only ever given a hand-made Attempt
    // carries no baton and no boundary — work that was never sent cannot have a response to
    // recover, and fabricating one would report an external effect that never occurred.
    await engine1.dispatchAssignment(assignment.id);
    worker.recordObservationSuccess('working');
    await db.runtimes.save(worker);

    // Worker completes while RelayX is shut down!
    provider1.isWorking = false;
    provider1.isComplete = true;

    // Simulate Relay restart: new RelayEngine instance with same database!
    const engine2 = new RelayEngine(db);
    engine2.registerProvider(provider1);
    engine2.registerProvider(new MockProvider('chatgpt'));

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
