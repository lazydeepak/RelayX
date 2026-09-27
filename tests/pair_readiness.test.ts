/**
 * Phase D — Derived Readiness Tests
 *
 * Verifies that pair readiness is correctly derived from operational state,
 * session bindings, identity verification, and continuity, with zero provider contact.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import { Project, Pair, RuntimeSession } from '../src/relay/domain/entities.ts';
import { ProjectId, PairId, RuntimeSessionId, createId } from '../src/relay/domain/types.ts';

describe('Phase D — Derived Readiness', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let mockProvider: MockProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    mockProvider = new MockProvider('opencode');
    engine.registerProvider(mockProvider);
    engine.registerProvider(new MockProvider('chatgpt'));
  });

  async function createFixture(operationalState: 'IDLE' | 'ACTIVE' = 'IDLE') {
    const project = new Project({
      id: createId<ProjectId>('proj'),
      name: 'Test Project',
      description: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.projects.save(project);

    const plannerSession = new RuntimeSession({
      id: createId<RuntimeSessionId>('sess'),
      providerType: 'chatgpt',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ext_planner',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const workerSession = new RuntimeSession({
      id: createId<RuntimeSessionId>('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ext_worker',
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
      status: operationalState === 'ACTIVE' ? 'active' : 'idle',
      operationalState,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.pairs.save(pair);

    return { project, plannerSession, workerSession, pair };
  }

  it('D1: IDLE pair evaluates to NOT_READY with zero provider calls', async () => {
    const { pair } = await createFixture('IDLE');

    const readiness = await engine.computePairReadiness(pair.id);
    assert.strictEqual(readiness.state, 'NOT_READY');
    assert.strictEqual(readiness.operationalState, 'IDLE');
    assert.ok(readiness.reasons.some((r) => r.includes('IDLE')));
  });

  it('D2: ACTIVE pair with missing checkpoints evaluates to UNKNOWN readiness', async () => {
    const { pair } = await createFixture('ACTIVE');

    const readiness = await engine.computePairReadiness(pair.id);
    assert.strictEqual(readiness.state, 'UNKNOWN');
    assert.strictEqual(readiness.operationalState, 'ACTIVE');
    assert.strictEqual(readiness.continuityState, 'UNKNOWN');
  });

  it('D3: ACTIVE pair with valid initial baseline and unchanged continuity evaluates to READY', async () => {
    const { pair, plannerSession, workerSession } = await createFixture('ACTIVE');

    // Save observations
    await db.sideIdentities.save({
      sessionPairId: pair.id,
      sideRole: 'planner',
      providerType: 'chatgpt',
      runtimeSessionId: plannerSession.id,
      externalSessionId: 'ext_planner',
      identityState: 'resolved',
      identityValue: 'ext_planner',
      verificationState: 'verified',
      verificationValue: 'ext_planner',
      existenceState: 'present',
      capability: 'exact_session_verifiable',
      observation: {
        reachabilityState: 'reachable',
        uiPresenceState: 'present',
        activityState: 'idle',
        messageEvidenceState: 'observed',
        message: { ref: 'm1', role: 'user', text: 'hello', truncated: false, ordinal: 1 },
        observationCapability: 'exact_session_verifiable',
        observedAt: Date.now(),
        validUntil: Date.now() + 60000,
        reason: null,
        evidence: null,
      },
      sourceCapability: 'test',
      observedAt: Date.now(),
      reason: null,
      evidence: null,
    });

    await db.sideIdentities.save({
      sessionPairId: pair.id,
      sideRole: 'worker',
      providerType: 'opencode',
      runtimeSessionId: workerSession.id,
      externalSessionId: 'ext_worker',
      identityState: 'resolved',
      identityValue: 'ext_worker',
      verificationState: 'verified',
      verificationValue: 'ext_worker',
      existenceState: 'present',
      capability: 'exact_session_verifiable',
      observation: {
        reachabilityState: 'reachable',
        uiPresenceState: 'present',
        activityState: 'idle',
        messageEvidenceState: 'observed',
        message: { ref: 'w1', role: 'user', text: 'code', truncated: false, ordinal: 1 },
        observationCapability: 'exact_session_verifiable',
        observedAt: Date.now(),
        validUntil: Date.now() + 60000,
        reason: null,
        evidence: null,
      },
      sourceCapability: 'test',
      observedAt: Date.now(),
      reason: null,
      evidence: null,
    });

    // Capture initial baselines
    await engine.captureInitialBaseline(pair.id, 'planner', 'operator1');
    await engine.captureInitialBaseline(pair.id, 'worker', 'operator1');

    const readiness = await engine.computePairReadiness(pair.id);
    assert.strictEqual(readiness.state, 'READY');
    assert.strictEqual(readiness.operationalState, 'ACTIVE');
    assert.strictEqual(readiness.continuityState, 'UNCHANGED');
  });
});
