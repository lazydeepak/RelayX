import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeProvider } from '../src/relay/providers/adapters.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { AmbiguousDeliveryResendError } from '../src/relay/domain/errors.ts';

describe('Phase 3 & Phase 4 — OpenCode UI Control & Worker Supervision', () => {
  it('delivers instruction visibly and marks delivered when post-send state is verified', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);

    class ControllableOpenCodeProvider extends OpenCodeProvider {
      public sendScriptSucceeds = true;

      protected override probeMacOSProcess(_name: string) {
        return {
          running: true,
          pid: 7721,
          windowTitle: 'OpenCode — [sess_control] /repo',
          evidenceSource: 'macos_system_events',
          details: { testEnvironment: true },
        };
      }

      public override runAppleScript(script: string) {
        if (script.includes('activate')) {
          return { success: true, output: 'focused' };
        }
        if (script.includes('key code 36')) {
          if (this.sendScriptSucceeds) {
            // Post-send: Stop button became visible
            return { success: true, output: 'sent::true' };
          }
          return { success: false, output: '', error: 'AppleScript execution timeout waiting for UI response' };
        }
        return { success: true, output: '' };
      }
    }

    const testProvider = new ControllableOpenCodeProvider();
    engine.registerProvider(testProvider);

    const project = await engine.createProject('Test Control Proj');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner ChatGPT');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker OpenCode');
    const pair = await engine.createPair(project.id, 'Control Pair', planner.id, worker.id);

    const assignment = await engine.createAssignment(pair.id, 'Implement Feature X', 'export function featureX() {}');

    // Dispatch assignment: should succeed with delivered
    const dispatch = await engine.dispatchAssignment(assignment.id);
    assert.equal(dispatch.delivery.status, 'delivered');

    const updatedAssignment = await db.assignments.findById(assignment.id);
    assert.equal(updatedAssignment?.status, 'active');

    const updatedWorker = await db.runtimes.findById(worker.id);
    assert.equal(updatedWorker?.status, 'working');
    assert.ok(updatedWorker?.lastEvidence);
    assert.equal(updatedWorker?.lastEvidence?.visibleButtonState?.stopButtonVisible, true);
  });

  it('marks delivery as ambiguous when post-send proof is missing and blocks automated resend', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);

    class AmbiguousOpenCodeProvider extends OpenCodeProvider {
      protected override probeMacOSProcess(_name: string) {
        return {
          running: true,
          pid: 9912,
          windowTitle: 'OpenCode Session',
          details: { testEnvironment: true },
        };
      }

      public override runAppleScript(script: string) {
        if (script.includes('activate')) {
          return { success: true, output: 'focused' };
        }
        if (script.includes('key code 36')) {
          // Send key was hit, but post-send verification encountered an AppleScript timeout!
          return { success: false, output: '', error: 'System Events UI scripting timeout' };
        }
        return { success: true, output: '' };
      }
    }

    const provider = new AmbiguousOpenCodeProvider();
    engine.registerProvider(provider);

    const project = await engine.createProject('Ambiguous Proj');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine.createPair(project.id, 'Ambiguous Pair', planner.id, worker.id);

    const assignment = await engine.createAssignment(pair.id, 'Risky Refactor', 'refactor codebase');

    const dispatch = await engine.dispatchAssignment(assignment.id);
    assert.equal(dispatch.delivery.status, 'ambiguous');

    // Deliveries table should have ambiguous delivery
    const deliveries = await db.deliveries.findByAssignmentId(assignment.id);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].status, 'ambiguous');

    // Critical attention item must be open
    const attentionItems = await db.attention.findOpen();
    const ambigItem = attentionItems.find((a) => a.type === 'ambiguous_delivery');
    assert.ok(ambigItem, 'Critical attention item for ambiguous delivery must be created');

    // Invariant: Automated resend MUST be blocked!
    await assert.rejects(
      async () => {
        await engine.dispatchAssignment(assignment.id);
      },
      AmbiguousDeliveryResendError,
      'Automated dispatch on ambiguous delivery must be strictly blocked',
    );
  });

  it('supervises worker lifecycle: idle -> working -> completed, producing handoff without completing assignment', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);

    class SupervisedOpenCodeProvider extends OpenCodeProvider {
      public state: 'working' | 'complete' = 'working';

      protected override probeMacOSProcess(_name: string) {
        return { running: true, pid: 1122, windowTitle: 'OpenCode Workspace', details: { testEnvironment: true } };
      }

      public override async deliverInstruction(req: any): Promise<any> {
        return {
          outcome: 'delivered',
          evidence: {
            id: `ev_test_${Date.now()}`,
            timestamp: Date.now(),
            source: 'macos_system_events',
            runtimeSessionId: req.runtimeSessionId,
          },
        };
      }

      public override async detectWorkingState() {
        return { isWorking: this.state === 'working' };
      }

      public override async detectCompletionState() {
        if (this.state === 'complete') {
          return {
            isComplete: true,
            responseSummary: 'Feature implemented cleanly in 3 files.',
          };
        }
        return { isComplete: false };
      }
    }

    const provider = new SupervisedOpenCodeProvider();
    engine.registerProvider(provider);

    const project = await engine.createProject('Supervision Proj');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine.createPair(project.id, 'Supervision Pair', planner.id, worker.id);

    const assignment = await engine.createAssignment(pair.id, 'Supervised Task', 'code');
    await engine.dispatchAssignment(assignment.id);

    // Initial supervision tick: worker is still working
    const tick1 = await engine.runSupervisionTick();
    assert.equal(tick1.handoffsCreated, 0);

    // Worker completes output
    provider.state = 'complete';

    // Next supervision tick: detects worker completion and creates handoff
    const tick2 = await engine.runSupervisionTick();
    assert.equal(tick2.handoffsCreated, 1);

    const handoffs = await db.handoffs.findByAssignmentId(assignment.id);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].status, 'ready');

    // CRITICAL INVARIANT: Handoff completion != assignment completion
    const asg = await db.assignments.findById(assignment.id);
    assert.notEqual(asg?.status, 'completed', 'Assignment must NOT be marked completed when handoff is created');
    assert.equal(asg?.status, 'waiting_for_handoff');
  });
});
