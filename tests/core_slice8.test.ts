import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { ContractRevision, PlanFirstRun, WorkUnit } from '../src/relay/domain/entities.ts';
import { MockProvider } from './MockProvider.ts';

/**
 * Plan-First contract binding.
 *
 * Reconciled against PLAN_FIRST_DOMAIN_FREEZE.md:
 *  - `ContractRevision.create(projectId, semanticFields, sourceRef?)` — the frozen argument
 *    order. The previous fixture passed a sourceRef as the 2nd argument and a JSON string as
 *    the 3rd, and referenced an unimported `createHash`.
 *  - The suite title claimed it binds a "strategy". `Strategy` is REJECTED for this
 *    milestone (freeze §B.6), so the test now proves what actually binds: the approved
 *    revision and the PlanFirstRun that snapshots its digest.
 */
describe('Core Slice 8 — Plan-First Contract Binding (design verified)', () => {
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

  it('PF1 — Happy path contract approval binds revision digest and run', async () => {
    const project = await engine.createProject('PF1 Project');
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    planner.updateExternalIdentity('bind_pf1_pl');
    await db.runtimes.save(planner);
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    worker.updateExternalIdentity('bind_pf1_wk');
    await db.runtimes.save(worker);
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    // Provenance must be AUTHORITATIVE (discovery | adoption | setup). The previous
    // fixture used 'pair_binding', which is not proof of project membership and is
    // correctly rejected by the pre-pair gate. The guard is not weakened here; the
    // fixture is corrected to satisfy it.
    await db.associations.save(new RuntimeProjectAssociation({ id: 'assoc_pf1_pl' as never, runtimeSessionId: planner.id, projectId: project.id, providerType: 'chatgpt', externalSessionId: planner.externalSessionId ?? '', verificationState: 'verified', provenance: 'setup', createdAt: Date.now(), updatedAt: Date.now() }));
    await db.associations.save(new RuntimeProjectAssociation({ id: 'assoc_pf1_wk' as never, runtimeSessionId: worker.id, projectId: project.id, providerType: 'opencode', externalSessionId: worker.externalSessionId ?? '', verificationState: 'verified', provenance: 'setup', createdAt: Date.now(), updatedAt: Date.now() }));
    const pair = await engine.createPair(project.id, 'Pair', planner.id, worker.id);

    // Canonicalization happens once, at creation, over the author-declared semantic fields.
    const semanticFields = { objective: 'build-auth', criteria: 'tests pass' };
    const contract = ContractRevision.create(project.id, semanticFields, '/docs/plan.md');
    assert.strictEqual(contract.status, 'draft');

    contract.approve('human');
    await db.contractRevisions.save(contract);
    assert.strictEqual(contract.status, 'approved');
    assert.strictEqual(
      contract.canonicalDigest,
      createHash('sha256')
        .update(JSON.stringify(semanticFields, Object.keys(semanticFields).sort()))
        .digest('hex'),
    );
    assert.strictEqual(contract.sourceRef, '/docs/plan.md');

    // Project-scoped uniqueness: the same semantic intent is the same revision.
    const found = await db.contractRevisions.findByDigest(project.id, contract.canonicalDigest);
    assert.strictEqual(found?.id, contract.id);

    // An unapproved revision can never back a run (freeze P0 Invariant 9).
    const draftOnly = ContractRevision.create(project.id, { objective: 'other' });
    await db.contractRevisions.save(draftOnly);
    assert.throws(
      () => PlanFirstRun.create(project.id, draftOnly, pair.id),
      /not approved/,
      'a draft revision must not be executable',
    );

    // The run snapshots the bound revision's digest and starts ready.
    const run = PlanFirstRun.create(project.id, contract, pair.id);
    await db.planFirstRuns.save(run);
    assert.strictEqual(run.status, 'ready');
    assert.strictEqual(run.contractRevisionId, contract.id);
    assert.strictEqual(run.contractDigest, contract.canonicalDigest);
    assert.strictEqual(run.sessionPairId, pair.id);

    // Binding drift is refused, never repaired (Invariant 7).
    run.assertBindingIntact(contract);
    const otherRevision = ContractRevision.create(project.id, { objective: 'different intent' });
    otherRevision.approve('human');
    assert.throws(() => run.assertBindingIntact(otherRevision), /does not match|bound to revision/);

    // Work units are ordered by an explicit, immutable ordinal.
    const wu1 = WorkUnit.create(contract.id, 1, 'step one', 'Do step one');
    const wu2 = WorkUnit.create(contract.id, 2, 'step two', 'Do step two');
    await db.workUnits.save(wu1);
    await db.workUnits.save(wu2);
    const ordered = await db.workUnits.findByContractRevisionId(contract.id);
    assert.deepStrictEqual(ordered.map((u) => u.ordinal), [1, 2]);
  });
});
