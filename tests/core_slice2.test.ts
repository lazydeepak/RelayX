import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';

describe('Core Slice 2 — Restart Reconciliation', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let mockProvider: MockProvider;

  async function bindPair(projectId: string, plannerId: string, workerId: string) {
    const planner = await db.runtimes.findById(plannerId);
    if (planner) { planner.updateExternalIdentity('bind_planner'); await db.runtimes.save(planner); }
    const worker = await db.runtimes.findById(workerId);
    if (worker) { worker.updateExternalIdentity('bind_worker'); await db.runtimes.save(worker); }
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r_' + Date.now() + '_pl', runtimeSessionId: plannerId, projectId,
      providerType: 'chatgpt', externalSessionId: planner?.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r_' + Date.now() + '_wk', runtimeSessionId: workerId, projectId,
      providerType: 'opencode', externalSessionId: worker?.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    const p = (await import('../src/relay/domain/entities.ts')).Pair.create(projectId, 'Pair', plannerId, workerId);
    await db.pairs.save(p);
    return p;
  }

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    mockProvider = new MockProvider('opencode');
    engine.registerProvider(mockProvider);
    engine.registerProvider(new MockProvider('chatgpt'));
  });

  it('R1 — LEVEL 0 restart resolves delivering to ambiguous + attention', async () => {
    const project = await engine.createProject('R1 Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    planner.updateExternalIdentity('bind_r1_pl');
    await db.runtimes.save(planner);
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    worker.updateExternalIdentity('bind_r1_wk');
    await db.runtimes.save(worker);
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r1_pl', runtimeSessionId: planner.id, projectId: project.id,
      providerType: 'chatgpt', externalSessionId: planner.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r1_wk', runtimeSessionId: worker.id, projectId: project.id,
      providerType: 'opencode', externalSessionId: worker.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    const pair = await engine.createPair(project.id, 'Pair', planner.id, worker.id);
    const assignment = await engine.createAssignment(pair.id, 'A', 'Do X');
    const { attempt, delivery } = await engine.dispatchAssignment(assignment.id);
    // Simulate crash: delivery remains delivering (already the case if mock returned delivered but we model uncertain)
    delivery.status = 'delivering';
    await db.deliveries.save(delivery);

    const result = await engine.reconcileUncertainDeliveries();
    assert.strictEqual(result.reconciled, 1);
    assert.strictEqual(result.attentionCreated, 1);
    assert.strictEqual(result.unsupported, 1); // ChatGPT provider unsupported

    const updatedDelivery = await db.deliveries.findById(delivery.id);
    assert.ok(updatedDelivery);
    assert.strictEqual(updatedDelivery!.status, 'ambiguous');

    const updatedAttempt = await db.attempts.findById(attempt.id);
    assert.strictEqual(updatedAttempt?.status, 'prepared'); // not falsely running

    const updatedAssignment = await db.assignments.findById(assignment.id);
    assert.strictEqual(updatedAssignment?.status, 'pending'); // unresolved
  });

  it('R2 — Idempotent repeated restart', async () => {
    const project = await engine.createProject('R2 Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    planner.updateExternalIdentity('bind_r2_pl');
    await db.runtimes.save(planner);
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    worker.updateExternalIdentity('bind_r2_wk');
    await db.runtimes.save(worker);
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r2_pl', runtimeSessionId: planner.id, projectId: project.id,
      providerType: 'chatgpt', externalSessionId: planner.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r2_wk', runtimeSessionId: worker.id, projectId: project.id,
      providerType: 'opencode', externalSessionId: worker.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    const pair = await engine.createPair(project.id, 'Pair', planner.id, worker.id);
    const assignment = await engine.createAssignment(pair.id, 'A', 'Do X');
    const { attempt, delivery } = await engine.dispatchAssignment(assignment.id);
    delivery.status = 'delivering';
    await db.deliveries.save(delivery);

    const r1 = await engine.reconcileUncertainDeliveries();
    assert.strictEqual(r1.reconciled, 1);
    const r2 = await engine.reconcileUncertainDeliveries();
    assert.strictEqual(r2.reconciled, 1); // same delivery reconciled again (idempotent state)
    // No duplicate attention created (same delivery)
    const attentionItems = await db.attention.findAll(); // may need to check via repos if available; simplified
    assert.strictEqual(attentionItems.filter((a) => a.sourceContext?.deliveryId === delivery.id).length <= 1);
  });

  it('R3 — unsupported / unknown provider result', async () => {
    // ChatGPT provider returns unsupported (default in browserProviders); verify conservative ambiguous
    const project = await engine.createProject('R3 Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    planner.updateExternalIdentity('bind_r3_pl');
    await db.runtimes.save(planner);
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    worker.updateExternalIdentity('bind_r3_wk');
    await db.runtimes.save(worker);
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r3_pl', runtimeSessionId: planner.id, projectId: project.id,
      providerType: 'chatgpt', externalSessionId: planner.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r3_wk', runtimeSessionId: worker.id, projectId: project.id,
      providerType: 'opencode', externalSessionId: worker.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    const pair = await engine.createPair(project.id, 'Pair', planner.id, worker.id);
    const assignment = await engine.createAssignment(pair.id, 'A', 'Do X');
    const { attempt, delivery } = await engine.dispatchAssignment(assignment.id);
    delivery.status = 'delivering';
    await db.deliveries.save(delivery);
    const result = await engine.reconcileUncertainDeliveries();
    assert.strictEqual(result.unsupported, 1);
    const updated = await db.deliveries.findById(delivery.id);
    assert.strictEqual(updated!.status, 'ambiguous');
  });

  it('R4 — confirmed delivered result', async () => {
    // Use mock that returns delivered (already default for opencode; we simulate delivered reconciliation directly via provider double?)
    // Since reconcileDispatch is optional and MockProvider doesn't have it, this is best-effort via direct evidence injection
    const project = await engine.createProject('R4 Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    planner.updateExternalIdentity('bind_r4_pl');
    await db.runtimes.save(planner);
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    worker.updateExternalIdentity('bind_r4_wk');
    await db.runtimes.save(worker);
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r4_pl', runtimeSessionId: planner.id, projectId: project.id,
      providerType: 'chatgpt', externalSessionId: planner.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r4_wk', runtimeSessionId: worker.id, projectId: project.id,
      providerType: 'opencode', externalSessionId: worker.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    const pair = await engine.createPair(project.id, 'Pair', planner.id, worker.id);
    const assignment = await engine.createAssignment(pair.id, 'A', 'Do X');
    const { attempt, delivery } = await engine.dispatchAssignment(assignment.id);
    delivery.status = 'delivering';
    await db.deliveries.save(delivery);
    // Directly call reconciliation with a temporary provider that reports delivered
    const tempProvider = {
      providerType: 'opencode',
      reconciliation: true,
      reconcileDispatch: async () => ({ outcome: 'delivered', evidence: { reason: 'sim_confirmed' } }),
    } as any;
    (engine as any).providers.set('opencode', tempProvider);
    const result = await engine.reconcileUncertainDeliveries();
    const updatedDelivery = await db.deliveries.findById(delivery.id);
    const updatedAttempt = await db.attempts.findById(attempt.id);
    assert.strictEqual(updatedDelivery!.status, 'delivered');
    assert.strictEqual(updatedAttempt!.status, 'running');
    assert.strictEqual(result.reconciled, 1);
  });

  it('R5 — confirmed not delivered', async () => {
    const project = await engine.createProject('R5 Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    planner.updateExternalIdentity('bind_r5_pl');
    await db.runtimes.save(planner);
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    worker.updateExternalIdentity('bind_r5_wk');
    await db.runtimes.save(worker);
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r5_pl', runtimeSessionId: planner.id, projectId: project.id,
      providerType: 'chatgpt', externalSessionId: planner.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r5_wk', runtimeSessionId: worker.id, projectId: project.id,
      providerType: 'opencode', externalSessionId: worker.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    const pair = await bindPair(project.id, planner.id, worker.id);
    const assignment = await engine.createAssignment(pair.id, 'A', 'Do X');
    const { attempt: att5, delivery: del5 } = await engine.dispatchAssignment(assignment.id);
    del5.status = 'delivering';
    await db.deliveries.save(del5);
    const tempProvider = {
      providerType: 'opencode',
      reconciliation: true,
      reconcileDispatch: async () => ({ outcome: 'not_delivered', evidence: { reason: 'provider_confirmed_absent' } }),
    } as any;
    (engine as any).providers.set('opencode', tempProvider);
    const result = await engine.reconcileUncertainDeliveries();
    const updated = await db.deliveries.findById(del5.id);
    assert.strictEqual(updated!.status, 'failed');
    const updatedAssignment = await db.assignments.findById(assignment.id);
    assert.strictEqual(updatedAssignment?.status, 'pending'); // assignment unresolved
  });

  it('R6 — LEVEL 1 supporting evidence alone', async () => {
    const project = await engine.createProject('R6 Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    planner.updateExternalIdentity('bind_r6_pl');
    await db.runtimes.save(planner);
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    worker.updateExternalIdentity('bind_r6_wk');
    await db.runtimes.save(worker);
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r6_pl', runtimeSessionId: planner.id, projectId: project.id,
      providerType: 'chatgpt', externalSessionId: planner.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r6_wk', runtimeSessionId: worker.id, projectId: project.id,
      providerType: 'opencode', externalSessionId: worker.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    const pair = await bindPair(project.id, planner.id, worker.id);
    const assignment = await engine.createAssignment(pair.id, 'A', 'Do X');
    const { attempt: att6, delivery: del6 } = await engine.dispatchAssignment(assignment.id);
    del6.status = 'delivering';
    await db.deliveries.save(del6);
    const tempProvider = {
      providerType: 'opencode',
      reconciliation: true,
      reconcileDispatch: async () => ({ outcome: 'supporting_evidence_only', evidence: { snippet: 'message found' } }),
    } as any;
    (engine as any).providers.set('opencode', tempProvider);
    const result = await engine.reconcileUncertainDeliveries();
    assert.strictEqual(result.unsupported, 0); // not unsupported; evidence provided
    const updated = await db.deliveries.findById(del6.id);
    assert.strictEqual(updated!.status, 'ambiguous'); // conservative
    const updatedAttempt = await db.attempts.findById(att6.id);
    assert.strictEqual(updatedAttempt!.status, 'prepared');
  });

  it('R7 — frozen authority used after Pair replacement', async () => {
    const project = await engine.createProject('R7 Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    planner.updateExternalIdentity('bind_r7_pl');
    await db.runtimes.save(planner);
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    worker.updateExternalIdentity('bind_r7_wk');
    await db.runtimes.save(worker);
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r7_pl', runtimeSessionId: planner.id, projectId: project.id,
      providerType: 'chatgpt', externalSessionId: planner.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    await db.associations.save(new RuntimeProjectAssociation({
      id: 'assoc_r7_wk', runtimeSessionId: worker.id, projectId: project.id,
      providerType: 'opencode', externalSessionId: worker.externalSessionId ?? '',
      verificationState: 'verified', provenance: 'pair_binding',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    const pair = await bindPair(project.id, planner.id, worker.id);
    const assignment = await engine.createAssignment(pair.id, 'A', 'Do X');
    const { attempt } = await engine.dispatchAssignment(assignment.id);
    // Replace current pair/worker session after dispatch
    const newWorker = await engine.registerRuntimeSession('opencode', 'Worker2');
    newWorker.updateExternalIdentity('bind_r7_wk2');
    await db.runtimes.save(newWorker);
    const newPair = await bindPair(project.id, planner.id, newWorker.id);
    // After restart/reload simulation, reconciliation must use frozen authority (old pair/worker)
    const simulationDelivery = await db.deliveries.findById((await db.deliveries.findByAssignmentId(assignment.id))[0]?.id ?? '');
    if (simulationDelivery) {
      simulationDelivery.status = 'delivering';
      await db.deliveries.save(simulationDelivery);
    }
    mockProvider.deliveryOutcome = 'delivered';
    const result = await engine.reconcileUncertainDeliveries();
    assert.strictEqual(result.reconciled, 1);
    const updatedAttempt = await db.attempts.findById(attempt.id);
    assert.strictEqual(updatedAttempt!.sessionPairId, pair.id); // frozen to original, not newPair
    assert.strictEqual(updatedAttempt!.workerSessionId, worker.id);
  });
});
