import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import { RuntimeNotAvailableError } from '../src/relay/domain/errors.ts';

describe('RelayX Architectural Scenarios & Recovery Invariants', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let mockWorker: MockProvider;
  let mockPlanner: MockProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    mockWorker = new MockProvider('opencode');
    mockPlanner = new MockProvider('chatgpt');
    engine.registerProvider(mockWorker);
    engine.registerProvider(mockPlanner);

    // Provide a stub planner observer so Start Pair can establish its bootstrap arm
    const stubObserver = {
      armedArmId: null as string | null,
      async ensureBootstrapArmed(conversationId: string) {
        if (!this.armedArmId) this.armedArmId = `arm_${Date.now()}`;
        return { armId: this.armedArmId, conversationId, reused: false };
      },
      async bootstrapStatus() {
        return {
          available: true, unavailableReason: null, conversationId: '', armId: this.armedArmId,
          armActive: false, working: false, completion: null, lastState: null, lastObservedAt: null
        };
      },
      async acknowledgeBootstrapArm() {},
    };
    engine['plannerObserver'] = stubObserver as any;
  });

  it('Scenario 1: Worker finishes while RelayX is offline / between checks', async () => {
    const project = await engine.createProject('Offline Recovery Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner Alpha');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker Beta');
    const pair = await engine.createPair(project.id, 'Pair 1', planner.id, worker.id);
    // The relay baton addresses ONE exact provider session per side, so these fixtures bind a
    // real external session identity (I-11). Binding happens AFTER createPair on purpose:
    // createPair demands verified project-association evidence for a session that already has an
    // external id, and these fixtures exercise the relay loop rather than pairing authority.
    planner.updateExternalIdentity('ses_chatgpt_scenarios_pl1', '/dev/scenarios_pl1');
    worker.updateExternalIdentity('ses_opencode_scenarios_wr1', '/dev/scenarios_wr1');
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    // I-2 (S6): this test drives provider contact (dispatch/supervision/recovery),
    // which requires operational_state = ACTIVE. Load & Activate is the ONLY
    // authorized grantor (freeze §4.4, §11.5).
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    await engine.startPair(pair.id);

    const assignment = await engine.createAssignment(pair.id, 'Async Job', 'Compute long batch');
    await engine.dispatchAssignment(assignment.id);

    // External worker finishes offline
    mockWorker.isWorking = false;
    mockWorker.isComplete = true;
    mockWorker.responseSummary = 'Batch complete: 450 items processed';

    // Supervisor wakes up and inspects reality
    const tick = await engine.runSupervisionTick();
    assert.strictEqual(tick.handoffsCreated, 1);

    const updatedAsgn = await db.assignments.findById(assignment.id);
    assert.strictEqual(updatedAsgn?.status, 'waiting_for_handoff');

    const handoffs = await db.handoffs.findByAssignmentId(assignment.id);
    assert.strictEqual(handoffs.length, 1);
    assert.strictEqual(handoffs[0].resultSummary, 'Batch complete: 450 items processed');
  });

  it('Scenario 2: Runtime permanent termination requires exceeding failure thresholds', async () => {
    const project = await engine.createProject('Threshold Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner Alpha');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker Beta');
    const pair = await engine.createPair(project.id, 'Pair 1', planner.id, worker.id);
    // The relay baton addresses ONE exact provider session per side, so these fixtures bind a
    // real external session identity (I-11). Binding happens AFTER createPair on purpose:
    // createPair demands verified project-association evidence for a session that already has an
    // external id, and these fixtures exercise the relay loop rather than pairing authority.
    planner.updateExternalIdentity('ses_chatgpt_scenarios_pl2', '/dev/scenarios_pl2');
    worker.updateExternalIdentity('ses_opencode_scenarios_wr2', '/dev/scenarios_wr2');
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    // I-2 (S6): this test drives provider contact (dispatch/supervision/recovery),
    // which requires operational_state = ACTIVE. Load & Activate is the ONLY
    // authorized grantor (freeze §4.4, §11.5).
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    await engine.startPair(pair.id);

    const assignment = await engine.createAssignment(pair.id, 'Job', 'Run script');
    await engine.dispatchAssignment(assignment.id);

    // Threshold escalation is driven by genuine RUNTIME OBSERVATION failures — the provider
    // reporting that it cannot see the process at all.
    //
    // It is deliberately NOT driven by `shouldFailInspection`. That knob makes the exact-session
    // TRANSCRIPT unreadable, which is a different claim: a conversation can be open, addressable
    // and perfectly alive while RelayX cannot parse its turns (virtualized history, no stable
    // per-turn ids). Counting an unparseable transcript toward `terminated` is what drove the live
    // "RelayX Development" Planner runtime to `terminated` and then wedged the relay at
    // `session_identity_unproven` over a conversation that was open the entire time. An unreadable
    // transcript now suspends for retry and can never terminate; only a real observation failure
    // escalates, which is what `reconcileAndRecoverRuntime` records.
    mockWorker.shouldFailRuntimeObservation = true;

    // Fail 1: suspended
    await engine.reconcileAndRecoverRuntime(worker.id as any);
    let runtime = await db.runtimes.findById(worker.id);
    assert.strictEqual(runtime?.status, 'suspended');
    assert.strictEqual(runtime?.consecutiveObservationFailures, 1);

    // Fail 2: still suspended (threshold not yet exceeded)
    await engine.reconcileAndRecoverRuntime(worker.id as any);
    runtime = await db.runtimes.findById(worker.id);
    assert.strictEqual(runtime?.status, 'suspended');
    assert.strictEqual(runtime?.consecutiveObservationFailures, 2);

    // Fail 3: now marked terminated
    await engine.reconcileAndRecoverRuntime(worker.id as any);
    runtime = await db.runtimes.findById(worker.id);
    assert.strictEqual(runtime?.status, 'terminated');
    assert.strictEqual(runtime?.consecutiveObservationFailures, 3);

    // Dispatching to terminated runtime must be blocked
    const newAsgn = await engine.createAssignment(pair.id, 'Job 2', 'Run next');
    await assert.rejects(
      async () => engine.dispatchAssignment(newAsgn.id),
      RuntimeNotAvailableError,
      'Dispatching to terminated runtime must be rejected',
    );

    // And the threshold is a threshold, not a ratchet: an unreadable-but-alive conversation on
    // the supervision path must NEVER reach `terminated`, however many ticks pass. This is the
    // exact shape of the live blocker.
    mockWorker.shouldFailInspection = true;
    for (let i = 0; i < 30; i += 1) {
      await engine.runSupervisionTick();
    }
    runtime = await db.runtimes.findById(worker.id);
    assert.notStrictEqual(
      runtime?.status,
      'terminated',
      'an unparseable transcript must never terminate a runtime; the live Pair wedged exactly this way',
    );
  });

  it('Scenario 3: Event timeline captures complete traceable lineage with evidence', async () => {
    const project = await engine.createProject('Observability Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner Alpha');
    const worker = await engine.registerRuntimeSession('opencode', 'Worker Beta');
    const pair = await engine.createPair(project.id, 'Pair 1', planner.id, worker.id);
    // The relay baton addresses ONE exact provider session per side, so these fixtures bind a
    // real external session identity (I-11). Binding happens AFTER createPair on purpose:
    // createPair demands verified project-association evidence for a session that already has an
    // external id, and these fixtures exercise the relay loop rather than pairing authority.
    planner.updateExternalIdentity('ses_chatgpt_scenarios_pl3', '/dev/scenarios_pl3');
    worker.updateExternalIdentity('ses_opencode_scenarios_wr3', '/dev/scenarios_wr3');
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    // I-2 (S6): this test drives provider contact (dispatch/supervision/recovery),
    // which requires operational_state = ACTIVE. Load & Activate is the ONLY
    // authorized grantor (freeze §4.4, §11.5).
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    await engine.startPair(pair.id);

    const assignment = await engine.createAssignment(pair.id, 'Tracing Task', 'Log steps');
    await engine.dispatchAssignment(assignment.id);

    const events = await db.events.findRecent(50);
    assert.ok(events.length >= 5);

    // Confirm that delivery event has correlationId and evidence
    const deliveryConfirmedEvent = events.find((e) => e.eventType === 'delivery.confirmed');
    assert.ok(deliveryConfirmedEvent);
    assert.ok(deliveryConfirmedEvent?.correlationId);
    assert.ok(deliveryConfirmedEvent?.evidence);
    assert.strictEqual(deliveryConfirmedEvent?.evidence?.source, 'macos_accessibility');
  });
});
