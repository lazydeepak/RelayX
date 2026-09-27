/**
 * S3 — Session Pair continuity and checkpoint semantics test suite.
 *
 * Covers:
 * - Group A: Missing checkpoint baseline yields UNKNOWN continuity.
 * - Group B: Explicit operator initial-baseline establishment.
 * - Group C: Zero provider contact on continuity computation & checkpoint capture.
 * - Group D: Observation alone cannot create or advance checkpoints.
 * - Group E: Advance state classification: UNCHANGED, PLANNER_ADVANCED, WORKER_ADVANCED, BOTH_ADVANCED.
 * - Group F: Stable identity is not ordering (equal refs => unchanged, differing refs => unknown).
 * - Group G: Explicit operator acknowledgment/reconciliation resolving BOTH_ADVANCED.
 * - Group H: Append-only checkpoint persistence & durability across database restarts.
 * - Group I: Regression guards (operational state, assignments, handoffs untouched).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import {
  ProjectId,
  PairId,
  createId,
  SideObservationReading,
  CHECKPOINT_BASELINE_ALREADY_EXISTS,
  CHECKPOINT_BASELINE_REQUIRED,
  CHECKPOINT_OBSERVATION_REQUIRED,
} from '../src/relay/domain/types.ts';
import { Pair, RuntimeSession } from '../src/relay/domain/entities.ts';
import { IRuntimeProvider } from '../src/relay/providers/interfaces.ts';
import { MockProvider } from './MockProvider.ts';

class ObserveSpyProvider extends MockProvider {
  public observeCalls: number = 0;
  public inspectCalls: number = 0;
  public nextReading?: Partial<SideObservationReading>;

  constructor(type: 'chatgpt' | 'opencode') {
    super(type);
  }

  async inspectRuntime(sessionId: any) {
    this.inspectCalls++;
    return super.inspectRuntime(sessionId);
  }

  async observeSide(target: { externalSessionId?: string | null; projectPath?: string | null }): Promise<SideObservationReading> {
    this.observeCalls++;
    const defaultReading: SideObservationReading = {
      reachabilityState: 'reachable',
      uiPresenceState: 'present',
      activityState: 'idle',
      messageEvidenceState: 'observed',
      message: {
        ref: 'msg-default',
        role: 'user',
        text: 'hello',
        truncated: false,
        ordinal: 1,
      },
      observationCapability: 'exact_session_verifiable',
      observedAt: Date.now(),
      validUntil: Date.now() + 60000,
      reason: null,
      evidence: null,
    };
    return { ...defaultReading, ...this.nextReading };
  }
}

async function createActivePairFixture(db: SqliteRelayDatabase | MemoryRelayDatabase) {
  const project = new (await import('../src/relay/domain/entities.ts')).Project({
    id: createId<ProjectId>('proj'),
    name: 'Test Project',
    description: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await db.projects.save(project);

  const plannerSpy = new ObserveSpyProvider('chatgpt');
  const workerSpy = new ObserveSpyProvider('opencode');

  const engine = new RelayEngine(db);
  engine.registerProvider(plannerSpy);
  engine.registerProvider(workerSpy);

  const plannerSession = new RuntimeSession({
    id: createId('sess'),
    providerType: 'chatgpt',
    name: 'ChatGPT Planner',
    status: 'available',
    consecutiveObservationFailures: 0,
    externalSessionId: 'ses_chatgpt_planner',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const workerSession = new RuntimeSession({
    id: createId('sess'),
    providerType: 'opencode',
    name: 'OpenCode Worker',
    status: 'available',
    consecutiveObservationFailures: 0,
    externalSessionId: 'ses_opencode_worker',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  await db.runtimes.save(plannerSession);
  await db.runtimes.save(workerSession);

  const pair = new Pair({
    id: createId<PairId>('pair'),
    projectId: project.id,
    name: 'Test Pair',
    plannerSessionId: plannerSession.id,
    workerSessionId: workerSession.id,
    status: 'active',
    operationalState: 'ACTIVE',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await db.pairs.save(pair);

  return { engine, db, pair, plannerSession, workerSession, plannerSpy, workerSpy };
}

describe('S3 — Session Pair continuity and checkpoint semantics', () => {

  describe('Group A — Missing checkpoint baseline yields UNKNOWN continuity', () => {
    test('A1: fresh observations with zero checkpoints yields UNKNOWN continuity', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair } = await createActivePairFixture(db);

      // Perform observation on both sides (so observations exist).
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');

      const continuity = await engine.computeContinuity(pair.id);
      assert.equal(continuity.state, 'UNKNOWN');
      assert.equal(continuity.planner.state, 'unknown');
      assert.equal(continuity.worker.state, 'unknown');
      assert.equal(continuity.planner.checkpointId, null);
      assert.equal(continuity.worker.checkpointId, null);
      assert.match(continuity.planner.reason, /No checkpoint baseline exists/);
    });

    test('A2: planner has checkpoint baseline but worker does not => pair is UNKNOWN', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair } = await createActivePairFixture(db);

      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');

      // Operator establishes baseline only on planner.
      await engine.captureInitialBaseline(pair.id, 'planner', 'operator-1');

      const continuity = await engine.computeContinuity(pair.id);
      assert.equal(continuity.state, 'UNKNOWN');
      assert.equal(continuity.planner.state, 'unchanged');
      assert.equal(continuity.worker.state, 'unknown');
    });

    test('A3: completely unobserved side with no checkpoints yields UNKNOWN', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair } = await createActivePairFixture(db);

      const continuity = await engine.computeContinuity(pair.id);
      assert.equal(continuity.state, 'UNKNOWN');
      assert.equal(continuity.planner.state, 'unknown');
      assert.equal(continuity.worker.state, 'unknown');
    });
  });

  describe('Group B — Initial-baseline establishment', () => {
    test('B1: explicit captureInitialBaseline establishes baseline with INITIAL_BASELINE authority', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy } = await createActivePairFixture(db);

      plannerSpy.nextReading = {
        message: { ref: 'msg-1', role: 'user', text: 'Task 1', truncated: false, ordinal: 10 },
      };
      await engine.observeSide(pair.id, 'planner');

      const chk = await engine.captureInitialBaseline(pair.id, 'planner', 'admin-user', 'Initial pair baseline');
      assert.equal(chk.sessionPairId, pair.id);
      assert.equal(chk.sideRole, 'planner');
      assert.equal(chk.messageRef, 'msg-1');
      assert.equal(chk.messageOrdinal, 10);
      assert.equal(chk.authority.kind, 'INITIAL_BASELINE');
      if (chk.authority.kind === 'INITIAL_BASELINE') {
        assert.equal(chk.authority.operatorId, 'admin-user');
      }

      // Checkpoint lookup from repository.
      const stored = await db.sideCheckpoints.findLatest(pair.id, 'planner');
      assert.ok(stored);
      assert.equal(stored.id, chk.id);
      assert.equal(stored.messageOrdinal, 10);
    });

    test('B2: captureInitialBaseline fails if side has no observation', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair } = await createActivePairFixture(db);

      await assert.rejects(
        async () => engine.captureInitialBaseline(pair.id, 'planner', 'operator-1'),
        (err: any) => err.code === CHECKPOINT_OBSERVATION_REQUIRED,
      );
    });

    test('B3: captureInitialBaseline fails if a baseline already exists', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair } = await createActivePairFixture(db);

      await engine.observeSide(pair.id, 'planner');
      await engine.captureInitialBaseline(pair.id, 'planner', 'operator-1');

      await assert.rejects(
        async () => engine.captureInitialBaseline(pair.id, 'planner', 'operator-2'),
        (err: any) => err.code === CHECKPOINT_BASELINE_ALREADY_EXISTS,
      );
    });
  });

  describe('Group C — Zero provider contact for continuity & checkpoint operations', () => {
    test('C1: computeContinuity makes ZERO provider calls', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
      await engine.captureInitialBaseline(pair.id, 'planner', 'op1');
      await engine.captureInitialBaseline(pair.id, 'worker', 'op1');

      const pCallsBefore = plannerSpy.observeCalls;
      const wCallsBefore = workerSpy.observeCalls;

      const continuity = await engine.computeContinuity(pair.id);
      assert.equal(continuity.state, 'UNCHANGED');

      assert.equal(plannerSpy.observeCalls, pCallsBefore);
      assert.equal(workerSpy.observeCalls, wCallsBefore);
    });

    test('C2: captureInitialBaseline and acknowledgeSideCheckpoint make ZERO provider calls', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      await engine.observeSide(pair.id, 'planner');
      const pCallsBefore = plannerSpy.observeCalls;

      await engine.captureInitialBaseline(pair.id, 'planner', 'op1');
      assert.equal(plannerSpy.observeCalls, pCallsBefore);

      await engine.acknowledgeSideCheckpoint(pair.id, 'planner', { operatorId: 'op1' });
      assert.equal(plannerSpy.observeCalls, pCallsBefore);
      assert.equal(workerSpy.observeCalls, 0);
    });

    test('C3: computeContinuity on an IDLE Pair executes with ZERO provider contact', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
      await engine.captureInitialBaseline(pair.id, 'planner', 'op1');
      await engine.captureInitialBaseline(pair.id, 'worker', 'op1');

      pair.makeIdle();
      await db.pairs.save(pair);

      const pCalls = plannerSpy.observeCalls;
      const wCalls = workerSpy.observeCalls;

      const continuity = await engine.computeContinuity(pair.id);
      assert.equal(continuity.state, 'UNCHANGED');
      assert.equal(plannerSpy.observeCalls, pCalls);
      assert.equal(workerSpy.observeCalls, wCalls);
    });
  });

  describe('Group D — Observation alone cannot establish or advance checkpoints', () => {
    test('D1: observeSide on uncheckpointed side creates observation but 0 checkpoints', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair } = await createActivePairFixture(db);

      await engine.observeSide(pair.id, 'planner');
      const chks = await db.sideCheckpoints.findAll(pair.id, 'planner');
      assert.equal(chks.length, 0);
    });

    test('D2: newer observeSide on checkpointed side moves observation but leaves checkpoint untouched', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, workerSpy } = await createActivePairFixture(db);

      workerSpy.nextReading = {
        message: { ref: 'msg-1', role: 'assistant', text: 'Part 1', truncated: false, ordinal: 1 },
      };
      await engine.observeSide(pair.id, 'worker');
      const chk1 = await engine.captureInitialBaseline(pair.id, 'worker', 'op1');

      // Next observation has advanced ordinal
      workerSpy.nextReading = {
        message: { ref: 'msg-2', role: 'assistant', text: 'Part 2', truncated: false, ordinal: 2 },
      };
      const obsResult = await engine.observeSide(pair.id, 'worker');
      assert.equal(obsResult.outcome, 'observed');

      // Verify checkpoint table did NOT change
      const chksAfter = await db.sideCheckpoints.findAll(pair.id, 'worker');
      assert.equal(chksAfter.length, 1);
      assert.equal(chksAfter[0].id, chk1.id);
      assert.equal(chksAfter[0].messageOrdinal, 1);
    });

    test('D3: observeSide event explicitly records checkpointAdvanced: false', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair } = await createActivePairFixture(db);

      await engine.observeSide(pair.id, 'planner');
      const events = await db.events.findByResourceId(pair.id);
      const obsEvent = events.find((e) => e.eventType === 'pair.side_observed');
      assert.ok(obsEvent);
      assert.equal(obsEvent.details?.checkpointAdvanced, false);
    });
  });

  describe('Group E — Advance state classification transitions', () => {
    test('E1: UNCHANGED when both sides match checkpoints', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      plannerSpy.nextReading = {
        message: { ref: 'p-1', role: 'user', text: 'Plan', truncated: false, ordinal: 5 },
      };
      workerSpy.nextReading = {
        message: { ref: 'w-1', role: 'assistant', text: 'Work', truncated: false, ordinal: 12 },
      };
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
      await engine.captureInitialBaseline(pair.id, 'planner', 'op');
      await engine.captureInitialBaseline(pair.id, 'worker', 'op');

      const c = await engine.computeContinuity(pair.id);
      assert.equal(c.state, 'UNCHANGED');
      assert.equal(c.planner.state, 'unchanged');
      assert.equal(c.worker.state, 'unchanged');
    });

    test('E2: PLANNER_ADVANCED when planner ordinal increases and worker remains same', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      plannerSpy.nextReading = {
        message: { ref: 'p-1', role: 'user', text: 'Plan', truncated: false, ordinal: 5 },
      };
      workerSpy.nextReading = {
        message: { ref: 'w-1', role: 'assistant', text: 'Work', truncated: false, ordinal: 12 },
      };
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
      await engine.captureInitialBaseline(pair.id, 'planner', 'op');
      await engine.captureInitialBaseline(pair.id, 'worker', 'op');

      // Planner advances to ordinal 6
      plannerSpy.nextReading = {
        message: { ref: 'p-2', role: 'user', text: 'Plan step 2', truncated: false, ordinal: 6 },
      };
      await engine.observeSide(pair.id, 'planner');

      const c = await engine.computeContinuity(pair.id);
      assert.equal(c.state, 'PLANNER_ADVANCED');
      assert.equal(c.planner.state, 'advanced');
      assert.equal(c.worker.state, 'unchanged');
    });

    test('E3: WORKER_ADVANCED when worker ordinal increases and planner remains same', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      plannerSpy.nextReading = {
        message: { ref: 'p-1', role: 'user', text: 'Plan', truncated: false, ordinal: 5 },
      };
      workerSpy.nextReading = {
        message: { ref: 'w-1', role: 'assistant', text: 'Work', truncated: false, ordinal: 12 },
      };
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
      await engine.captureInitialBaseline(pair.id, 'planner', 'op');
      await engine.captureInitialBaseline(pair.id, 'worker', 'op');

      // Worker advances to ordinal 15
      workerSpy.nextReading = {
        message: { ref: 'w-2', role: 'assistant', text: 'Work step 2', truncated: false, ordinal: 15 },
      };
      await engine.observeSide(pair.id, 'worker');

      const c = await engine.computeContinuity(pair.id);
      assert.equal(c.state, 'WORKER_ADVANCED');
      assert.equal(c.planner.state, 'unchanged');
      assert.equal(c.worker.state, 'advanced');
    });

    test('E4: BOTH_ADVANCED when both sides advance ordinals', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      plannerSpy.nextReading = {
        message: { ref: 'p-1', role: 'user', text: 'Plan', truncated: false, ordinal: 5 },
      };
      workerSpy.nextReading = {
        message: { ref: 'w-1', role: 'assistant', text: 'Work', truncated: false, ordinal: 12 },
      };
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
      await engine.captureInitialBaseline(pair.id, 'planner', 'op');
      await engine.captureInitialBaseline(pair.id, 'worker', 'op');

      // Both advance
      plannerSpy.nextReading = {
        message: { ref: 'p-2', role: 'user', text: 'Plan step 2', truncated: false, ordinal: 7 },
      };
      workerSpy.nextReading = {
        message: { ref: 'w-2', role: 'assistant', text: 'Work step 2', truncated: false, ordinal: 14 },
      };
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');

      const c = await engine.computeContinuity(pair.id);
      assert.equal(c.state, 'BOTH_ADVANCED');
      assert.equal(c.planner.state, 'advanced');
      assert.equal(c.worker.state, 'advanced');
    });
  });

  describe('Group F — Stable identity is not ordering (Correction 1)', () => {
    test('F1: equal stable refs without ordinals evaluates to UNCHANGED', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      // Level 1 provider with stable ref but null ordinal
      plannerSpy.nextReading = {
        message: { ref: 'msg-same-ref', role: 'assistant', text: 'Same', truncated: false, ordinal: null },
      };
      workerSpy.nextReading = {
        message: { ref: 'w-ord', role: 'assistant', text: 'W', truncated: false, ordinal: 1 },
      };
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
      await engine.captureInitialBaseline(pair.id, 'planner', 'op');
      await engine.captureInitialBaseline(pair.id, 'worker', 'op');

      const c = await engine.computeContinuity(pair.id);
      assert.equal(c.planner.state, 'unchanged');
      assert.equal(c.state, 'UNCHANGED');
    });

    test('F2: different stable refs without trustworthy ordering evaluates to UNKNOWN, NOT advanced', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      plannerSpy.nextReading = {
        message: { ref: 'msg-ref-1', role: 'assistant', text: 'First', truncated: false, ordinal: null },
      };
      workerSpy.nextReading = {
        message: { ref: 'w-ord', role: 'assistant', text: 'W', truncated: false, ordinal: 1 },
      };
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
      await engine.captureInitialBaseline(pair.id, 'planner', 'op');
      await engine.captureInitialBaseline(pair.id, 'worker', 'op');

      // Observation sees a different ref, but ordinal is still null (unordered)
      plannerSpy.nextReading = {
        message: { ref: 'msg-ref-2', role: 'assistant', text: 'Second', truncated: false, ordinal: null },
      };
      await engine.observeSide(pair.id, 'planner');

      const c = await engine.computeContinuity(pair.id);
      // Correction 1: must evaluate to unknown, NEVER advanced!
      assert.equal(c.planner.state, 'unknown');
      assert.equal(c.state, 'UNKNOWN');
      assert.match(c.planner.reason, /no trustworthy ordinal is available/);
    });

    test('F3: regressive ordinal (observed < checkpoint) evaluates to UNKNOWN', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      plannerSpy.nextReading = {
        message: { ref: 'p-1', role: 'user', text: 'Plan', truncated: false, ordinal: 10 },
      };
      workerSpy.nextReading = {
        message: { ref: 'w-1', role: 'assistant', text: 'Work', truncated: false, ordinal: 1 },
      };
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
      await engine.captureInitialBaseline(pair.id, 'planner', 'op');
      await engine.captureInitialBaseline(pair.id, 'worker', 'op');

      // Directly simulate a lower ordinal in observation
      const obs = await db.sideIdentities.find(pair.id, 'planner');
      assert.ok(obs && obs.observation);
      obs.observation.message.ordinal = 8;
      await db.sideIdentities.save(obs);

      const c = await engine.computeContinuity(pair.id);
      assert.equal(c.planner.state, 'unknown');
      assert.equal(c.state, 'UNKNOWN');
      assert.match(c.planner.reason, /anomalous regressive ordinal/);
    });
  });

  describe('Group G — Explicit operator acknowledgment resolving BOTH_ADVANCED', () => {
    test('G1: acknowledgeSideCheckpoint shifts BOTH_ADVANCED to WORKER_ADVANCED, then UNCHANGED', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      plannerSpy.nextReading = { message: { ref: 'p-1', role: 'user', text: 'P1', truncated: false, ordinal: 1 } };
      workerSpy.nextReading = { message: { ref: 'w-1', role: 'assistant', text: 'W1', truncated: false, ordinal: 1 } };
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
      await engine.captureInitialBaseline(pair.id, 'planner', 'op');
      await engine.captureInitialBaseline(pair.id, 'worker', 'op');

      // Both advance
      plannerSpy.nextReading = { message: { ref: 'p-2', role: 'user', text: 'P2', truncated: false, ordinal: 2 } };
      workerSpy.nextReading = { message: { ref: 'w-2', role: 'assistant', text: 'W2', truncated: false, ordinal: 2 } };
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');

      const cBefore = await engine.computeContinuity(pair.id);
      assert.equal(cBefore.state, 'BOTH_ADVANCED');

      // Operator acknowledges planner side
      const ackP = await engine.acknowledgeSideCheckpoint(pair.id, 'planner', {
        operatorId: 'operator-alice',
        resolutionNote: 'Reviewed planner output and accepted',
      });
      assert.equal(ackP.authority.kind, 'OPERATOR_ACKNOWLEDGED');
      assert.equal(ackP.messageOrdinal, 2);

      // Now planner is unchanged, worker is still advanced => WORKER_ADVANCED
      const cMid = await engine.computeContinuity(pair.id);
      assert.equal(cMid.state, 'WORKER_ADVANCED');
      assert.equal(cMid.planner.state, 'unchanged');
      assert.equal(cMid.worker.state, 'advanced');

      // Operator acknowledges worker side
      await engine.acknowledgeSideCheckpoint(pair.id, 'worker', {
        operatorId: 'operator-alice',
        resolutionNote: 'Reviewed worker output and accepted',
      });

      // Now both unchanged => UNCHANGED
      const cAfter = await engine.computeContinuity(pair.id);
      assert.equal(cAfter.state, 'UNCHANGED');
      assert.equal(cAfter.planner.state, 'unchanged');
      assert.equal(cAfter.worker.state, 'unchanged');
    });

    test('G2: acknowledgeSideCheckpoint throws CHECKPOINT_BASELINE_REQUIRED if no baseline exists', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair } = await createActivePairFixture(db);

      await engine.observeSide(pair.id, 'planner');

      await assert.rejects(
        async () => engine.acknowledgeSideCheckpoint(pair.id, 'planner', { operatorId: 'op' }),
        (err: any) => err.code === CHECKPOINT_BASELINE_REQUIRED,
      );
    });
  });

  describe('Group H — Append-only persistence & durability across database restarts', () => {
    test('H1: all checkpoints are preserved in append-only sequence', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair, plannerSpy } = await createActivePairFixture(db);

      plannerSpy.nextReading = { message: { ref: 'p-1', role: 'user', text: 'P1', truncated: false, ordinal: 1 } };
      await engine.observeSide(pair.id, 'planner');
      const chk1 = await engine.captureInitialBaseline(pair.id, 'planner', 'op1');

      plannerSpy.nextReading = { message: { ref: 'p-2', role: 'user', text: 'P2', truncated: false, ordinal: 2 } };
      await engine.observeSide(pair.id, 'planner');
      const chk2 = await engine.acknowledgeSideCheckpoint(pair.id, 'planner', { operatorId: 'op1' });

      plannerSpy.nextReading = { message: { ref: 'p-3', role: 'user', text: 'P3', truncated: false, ordinal: 3 } };
      await engine.observeSide(pair.id, 'planner');
      const chk3 = await engine.acknowledgeSideCheckpoint(pair.id, 'planner', { operatorId: 'op1' });

      const all = await db.sideCheckpoints.findAll(pair.id, 'planner');
      assert.equal(all.length, 3);
      assert.equal(all[0].id, chk1.id);
      assert.equal(all[1].id, chk2.id);
      assert.equal(all[2].id, chk3.id);

      const latest = await db.sideCheckpoints.findLatest(pair.id, 'planner');
      assert.equal(latest?.id, chk3.id);
      assert.equal(latest?.messageOrdinal, 3);
    });

    test('H2: memory database round-trips checkpoint repository correctly', async () => {
      const db = new MemoryRelayDatabase();
      const { engine, pair, plannerSpy, workerSpy } = await createActivePairFixture(db);

      plannerSpy.nextReading = { message: { ref: 'p-1', role: 'user', text: 'P1', truncated: false, ordinal: 1 } };
      workerSpy.nextReading = { message: { ref: 'w-1', role: 'assistant', text: 'W1', truncated: false, ordinal: 1 } };
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
      await engine.captureInitialBaseline(pair.id, 'planner', 'op');
      await engine.captureInitialBaseline(pair.id, 'worker', 'op');

      const c = await engine.computeContinuity(pair.id);
      assert.equal(c.state, 'UNCHANGED');
    });

    test('H3: Sqlite file database preserves checkpoints and continuity across close and reopen', async () => {
      const dbPath = `/tmp/test_s3_restart_${Date.now()}.db`;
      const db1 = new SqliteRelayDatabase(dbPath);
      const { engine: engine1, pair, plannerSpy, workerSpy } = await createActivePairFixture(db1);

      plannerSpy.nextReading = { message: { ref: 'p-1', role: 'user', text: 'P1', truncated: false, ordinal: 1 } };
      workerSpy.nextReading = { message: { ref: 'w-1', role: 'assistant', text: 'W1', truncated: false, ordinal: 1 } };
      await engine1.observeSide(pair.id, 'planner');
      await engine1.observeSide(pair.id, 'worker');
      await engine1.captureInitialBaseline(pair.id, 'planner', 'op');
      await engine1.captureInitialBaseline(pair.id, 'worker', 'op');

      // Advance planner
      plannerSpy.nextReading = { message: { ref: 'p-2', role: 'user', text: 'P2', truncated: false, ordinal: 4 } };
      await engine1.observeSide(pair.id, 'planner');

      const cBefore = await engine1.computeContinuity(pair.id);
      assert.equal(cBefore.state, 'PLANNER_ADVANCED');

      db1.close();

      // Reopen in a fresh database handle
      const db2 = new SqliteRelayDatabase(dbPath);
      const freshPlannerSpy = new ObserveSpyProvider('chatgpt');
      const freshWorkerSpy = new ObserveSpyProvider('opencode');
      const engine2 = new RelayEngine(db2);
      engine2.registerProvider(freshPlannerSpy);
      engine2.registerProvider(freshWorkerSpy);

      const cAfter = await engine2.computeContinuity(pair.id);
      assert.equal(cAfter.state, 'PLANNER_ADVANCED');
      assert.equal(cAfter.planner.observedOrdinal, 4);
      assert.equal(cAfter.planner.checkpointOrdinal, 1);
      assert.equal(freshPlannerSpy.observeCalls, 0);
      assert.equal(freshWorkerSpy.observeCalls, 0);

      db2.close();
    });
  });

  describe('Group I — Regression guards', () => {
    test('I1: continuity and checkpoint operations never alter operationalState', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair } = await createActivePairFixture(db);

      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');

      const pBefore = await db.pairs.findById(pair.id);
      assert.equal(pBefore?.operationalState, 'ACTIVE');

      await engine.captureInitialBaseline(pair.id, 'planner', 'op');
      await engine.computeContinuity(pair.id);
      await engine.acknowledgeSideCheckpoint(pair.id, 'planner', { operatorId: 'op' });

      const pAfter = await db.pairs.findById(pair.id);
      assert.equal(pAfter?.operationalState, 'ACTIVE');
    });

    test('I2: checkpoints do not alter pair_side_identity columns', async () => {
      const db = new SqliteRelayDatabase(':memory:');
      const { engine, pair } = await createActivePairFixture(db);

      await engine.observeSide(pair.id, 'planner');
      const obsBefore = await db.sideIdentities.find(pair.id, 'planner');

      await engine.captureInitialBaseline(pair.id, 'planner', 'op');
      const obsAfter = await db.sideIdentities.find(pair.id, 'planner');

      assert.deepEqual(obsBefore, obsAfter);
    });
  });

});
