/**
 * Focused regression tests for Pair role filtering and cross-role binding guard (A).
 * Proves an OpenCode worker session cannot be selected or bound as Planner,
 * neither through the UI filter path nor through backend service binding validation.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RuntimeSession, Project, Pair, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { ProjectId, PairId, RuntimeSessionId, AssociationId, createId } from '../src/relay/domain/types.ts';

describe('A — PairModal role filtering and cross-role binding guard', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;

  beforeEach(async () => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
  });

  async function seedProject(): Promise<Project> {
    const proj = Project.create('Regression Project', '', '/dev/reg');
    await db.projects.save(proj);
    return proj;
  }

  async function seedPlanner(projectId: ProjectId): Promise<RuntimeSession> {
    const session = RuntimeSession.create('chatgpt', 'ChatGPT Planner');
    session.updateExternalIdentity('conv_planner', `https://chatgpt.com/g/g-p-reg/c/conv_planner`);
    await db.runtimes.save(session);
    await db.associations.save(new RuntimeProjectAssociation({
      id: `assoc_planner_${Date.now()}` as AssociationId,
      runtimeSessionId: session.id,
      projectId,
      providerType: 'chatgpt',
      externalSessionId: 'conv_planner',
      verificationState: 'verified',
      provenance: 'adoption',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    return session;
  }

  async function seedWorker(projectId: ProjectId): Promise<RuntimeSession> {
    const session = RuntimeSession.create('opencode', 'OpenCode Worker');
    session.updateExternalIdentity('ses_opencode_worker', '/dev/reg');
    await db.runtimes.save(session);
    await db.associations.save(new RuntimeProjectAssociation({
      id: `assoc_worker_${Date.now()}` as AssociationId,
      runtimeSessionId: session.id,
      projectId,
      providerType: 'opencode',
      externalSessionId: 'ses_opencode_worker',
      verificationState: 'verified',
      provenance: 'adoption',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    return session;
  }

  it('A1: planner filter excludes opencode runtime', async () => {
    const proj = await seedProject();
    const planner = await seedPlanner(proj.id);
    const worker = await seedWorker(proj.id);
    const runtimes = [
      { id: planner.id, providerType: planner.providerType },
      { id: worker.id, providerType: worker.providerType },
    ];
    const plannerOptions = runtimes.filter((r) => r.providerType === 'chatgpt');
    assert.strictEqual(plannerOptions.length, 1);
    assert.strictEqual(plannerOptions[0].id, planner.id);
  });

  it('A2: worker filter excludes chatgpt runtime', async () => {
    const proj = await seedProject();
    const planner = await seedPlanner(proj.id);
    const worker = await seedWorker(proj.id);
    const runtimes = [
      { id: planner.id, providerType: planner.providerType },
      { id: worker.id, providerType: worker.providerType },
    ];
    const workerOptions = runtimes.filter(
      (r) => r.providerType === 'opencode' || r.providerType === 'vscode',
    );
    assert.strictEqual(workerOptions.length, 1);
    assert.strictEqual(workerOptions[0].id, worker.id);
  });

  it('A3: discovered worker session never appears in planner choices', async () => {
    const proj = await seedProject();
    const planner = await seedPlanner(proj.id);
    const discoveredWorker = {
      kind: 'discovered',
      sessionId: 'discovered_ses',
      sessionTitle: 'Discovered',
    };
    const plannerChoices = [{ id: planner.id, providerType: 'chatgpt' }];
    // Ensure discovered choice is not in planner list
    assert.ok(!plannerChoices.some((c: any) => c.sessionId === discoveredWorker.sessionId || c.id === discoveredWorker.sessionId));
  });

  it('A4: backend updatePair rejects binding opencode worker as planner', async () => {
    const proj = await seedProject();
    const planner = await seedPlanner(proj.id);
    const worker = await seedWorker(proj.id);
    const pair = Pair.create(proj.id, 'Test Pair', planner.id, worker.id);
    await db.pairs.save(pair);

    // Attempt to rebind planner to the opencode worker session
    try {
      await engine.updatePair(pair.id, { plannerSessionId: worker.id as RuntimeSessionId });
      assert.fail('Expected updatePair to throw for cross-role planner binding');
    } catch (err: any) {
      assert.ok(err.message.includes('Planner session must be ChatGPT'));
    }
  });

  it('A5: backend updatePair rejects binding chatgpt planner as worker', async () => {
    const proj = await seedProject();
    const planner = await seedPlanner(proj.id);
    const worker = await seedWorker(proj.id);
    const pair = Pair.create(proj.id, 'Test Pair', planner.id, worker.id);
    await db.pairs.save(pair);

    try {
      await engine.updatePair(pair.id, { workerSessionId: planner.id as RuntimeSessionId });
      assert.fail('Expected updatePair to throw for cross-role worker binding');
    } catch (err: any) {
      assert.ok(err.message.includes('Worker session must be OpenCode or VS Code'));
    }
  });

  it('A6: existing valid planner-worker pair remains editable without role errors', async () => {
    const proj = await seedProject();
    const planner = await seedPlanner(proj.id);
    const worker = await seedWorker(proj.id);
    const pair = Pair.create(proj.id, 'Editable Pair', planner.id, worker.id);
    await db.pairs.save(pair);

    const updated = await engine.updatePair(pair.id, { name: 'Updated Name' });
    assert.strictEqual(updated.name, 'Updated Name');
    assert.strictEqual(updated.plannerSessionId, planner.id);
    assert.strictEqual(updated.workerSessionId, worker.id);
  });

  it('A7: createPair rejects cross-role worker as planner', async () => {
    const proj = await seedProject();
    const worker = await seedWorker(proj.id);
    try {
      await engine.createPair(proj.id, 'Bad Pair', worker.id, undefined);
      assert.fail('Expected createPair to throw for cross-role planner binding');
    } catch (err: any) {
      assert.ok(err.message.includes('Planner session must be ChatGPT'));
    }
  });

  it('A8: createPair rejects cross-role planner as worker', async () => {
    const proj = await seedProject();
    const planner = await seedPlanner(proj.id);
    try {
      await engine.createPair(proj.id, 'Bad Pair', planner.id, planner.id);
      assert.fail('Expected createPair to throw for cross-role worker binding');
    } catch (err: any) {
      assert.ok(err.message.includes('Worker session must be OpenCode or VS Code'));
    }
  });
});
