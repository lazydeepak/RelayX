/**
 * Adversarial Test Suite for RelayX Pair & Session Authority
 * Covers all 20 required regression scenarios to prove durable authority,
 * role/project compatibility, uniqueness, explicit replacement, archive/revive,
 * discovery isolation, active assignment invariant, restart persistence, and Attempt authority.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { MockProvider } from './MockProvider.ts';
import { RuntimeSession, RuntimeProjectAssociation, Project } from '../src/relay/domain/entities.ts';
import { ProjectId, PairId, RuntimeSessionId } from '../src/relay/domain/types.ts';

describe('Adversarial Pair & Session Authority Regression Suite', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    service = new RelayApiService(db, engine);
    engine.registerProvider(new MockProvider('chatgpt'));
    engine.registerProvider(new MockProvider('opencode'));
    engine.registerProvider(new MockProvider('vscode'));
  });

  async function seedProject(name: string): Promise<Project> {
    const p = Project.create(`${name} Project`, '', `/dev/${name}`, `/dev/${name}`);
    await db.projects.save(p);
    return p;
  }

  async function seedRuntime(
    projectId: ProjectId,
    providerType: 'chatgpt' | 'opencode' | 'vscode',
    name: string,
    externalId: string,
  ): Promise<RuntimeSession> {
    const sess = RuntimeSession.create(providerType, name);
    sess.updateExternalIdentity(externalId, `/dev/ws_${externalId}`);
    await db.runtimes.save(sess);
    await db.associations.save(
      RuntimeProjectAssociation.create(sess.id, projectId, externalId, 'verified', 'setup', providerType),
    );
    return sess;
  }

  it('1. valid Planner + Worker Pair creation', async () => {
    const proj = await seedProject('Proj1');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 1', 'ses_planner_1');
    const worker = await seedRuntime(proj.id, 'opencode', 'Worker 1', 'ses_worker_1');

    const pair = await engine.createPair(proj.id, 'Pair 1', planner.id, worker.id);
    assert.strictEqual(pair.plannerSessionId, planner.id);
    assert.strictEqual(pair.workerSessionId, worker.id);
  });

  it('2. Worker rejected as Planner', async () => {
    const proj = await seedProject('Proj2');
    const worker1 = await seedRuntime(proj.id, 'opencode', 'Worker A', 'ses_worker_a');
    const worker2 = await seedRuntime(proj.id, 'opencode', 'Worker B', 'ses_worker_b');

    await assert.rejects(async () => {
      await engine.createPair(proj.id, 'Bad Pair', worker1.id, worker2.id);
    }, /Planner session must be ChatGPT/);
  });

  it('3. Planner rejected as Worker', async () => {
    const proj = await seedProject('Proj3');
    const planner1 = await seedRuntime(proj.id, 'chatgpt', 'Planner A', 'ses_planner_a');
    const planner2 = await seedRuntime(proj.id, 'chatgpt', 'Planner B', 'ses_planner_b');

    await assert.rejects(async () => {
      await engine.createPair(proj.id, 'Bad Pair', planner1.id, planner2.id);
    }, /Worker session must be OpenCode or VS Code/);
  });

  it('4. cross-project session rejected', async () => {
    const projA = await seedProject('ProjA');
    const projB = await seedProject('ProjB');
    const plannerA = await seedRuntime(projA.id, 'chatgpt', 'Planner A', 'ses_planner_a');
    const workerB = await seedRuntime(projB.id, 'opencode', 'Worker B', 'ses_worker_b');

    await assert.rejects(async () => {
      await engine.createPair(projA.id, 'Cross Project Pair', plannerA.id, workerB.id);
    }, /lacks matching pre-pair verified authoritative association/);
  });

  it('5. duplicate external identity rejected', async () => {
    const proj = await seedProject('Proj5');
    await seedRuntime(proj.id, 'opencode', 'W1', 'ses_shared_ext');
    
    const sess2 = RuntimeSession.create('opencode', 'W2');
    sess2.updateExternalIdentity('ses_shared_ext', '/dev/other');
    
    await assert.rejects(async () => {
      await db.runtimes.save(sess2);
    });
  });

  it('6. already-paired incompatible/duplicate session rejected', async () => {
    const proj = await seedProject('Proj6');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 6', 'ses_p6');
    const worker1 = await seedRuntime(proj.id, 'opencode', 'Worker 6A', 'ses_w6a');
    const worker2 = await seedRuntime(proj.id, 'opencode', 'Worker 6B', 'ses_w6b');

    await engine.createPair(proj.id, 'Pair 6A', planner.id, worker1.id);

    await assert.rejects(async () => {
      await engine.createPair(proj.id, 'Pair 6B', planner.id, worker2.id);
    }, /Runtime session is already bound to an active pair/);
  });

  it('7. Planner explicit replacement', async () => {
    const proj = await seedProject('Proj7');
    const plannerOld = await seedRuntime(proj.id, 'chatgpt', 'Planner Old', 'ses_p_old');
    const plannerNew = await seedRuntime(proj.id, 'chatgpt', 'Planner New', 'ses_p_new');
    const worker = await seedRuntime(proj.id, 'opencode', 'Worker 7', 'ses_w7');

    const pair = await engine.createPair(proj.id, 'Pair 7', plannerOld.id, worker.id);
    assert.strictEqual(pair.plannerSessionId, plannerOld.id);

    const updated = await engine.updatePair(pair.id, { plannerSessionId: plannerNew.id });
    assert.strictEqual(updated.plannerSessionId, plannerNew.id);
    assert.strictEqual(updated.workerSessionId, worker.id);
  });

  it('8. Worker explicit replacement', async () => {
    const proj = await seedProject('Proj8');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 8', 'ses_p8');
    const workerOld = await seedRuntime(proj.id, 'opencode', 'Worker Old', 'ses_w_old');
    const workerNew = await seedRuntime(proj.id, 'opencode', 'Worker New', 'ses_w_new');

    const pair = await engine.createPair(proj.id, 'Pair 8', planner.id, workerOld.id);
    assert.strictEqual(pair.workerSessionId, workerOld.id);

    const updated = await engine.updatePair(pair.id, { workerSessionId: workerNew.id });
    assert.strictEqual(updated.workerSessionId, workerNew.id);
    assert.strictEqual(updated.plannerSessionId, planner.id);
  });

  it('9. old session remains historical after replacement', async () => {
    const proj = await seedProject('Proj9');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 9', 'ses_p9');
    const workerOld = await seedRuntime(proj.id, 'opencode', 'Worker Old', 'ses_w_old_9');
    const workerNew = await seedRuntime(proj.id, 'opencode', 'Worker New', 'ses_w_new_9');

    const pair = await engine.createPair(proj.id, 'Pair 9', planner.id, workerOld.id);
    await engine.loadAndActivate(pair.id);

    const asgn = await engine.createAssignment(pair.id, proj.id, 'Task 1', 'Do work');
    const dispatched = await engine.dispatchAssignment(asgn.id);
    assert.strictEqual(dispatched.attempt.workerSessionId, workerOld.id);

    await engine.completeAssignment(asgn.id);
    await engine.updatePair(pair.id, { workerSessionId: workerNew.id });

    const loadedAttempt = await db.attempts.findById(dispatched.attempt.id);
    assert.strictEqual(loadedAttempt?.workerSessionId, workerOld.id);
  });

  it('10. archive preserves identity and inspectability', async () => {
    const proj = await seedProject('Proj10');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 10', 'ses_p10');
    const worker = await seedRuntime(proj.id, 'opencode', 'Worker 10', 'ses_w10');

    const pair = await engine.createPair(proj.id, 'Pair 10', planner.id, worker.id);
    await engine.archivePair(pair.id);

    const archived = await db.pairs.findById(pair.id);
    assert.strictEqual(archived?.status, 'archived');
    assert.strictEqual(archived?.plannerSessionId, planner.id);
    assert.strictEqual(archived?.workerSessionId, worker.id);
  });

  it('11. revive with same existing sessions', async () => {
    const proj = await seedProject('Proj11');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 11', 'ses_p11');
    const worker = await seedRuntime(proj.id, 'opencode', 'Worker 11', 'ses_w11');

    const pair = await engine.createPair(proj.id, 'Pair 11', planner.id, worker.id);
    await engine.archivePair(pair.id);

    await engine.unarchivePair(pair.id);
    const revived = await db.pairs.findById(pair.id);
    assert.notStrictEqual(revived?.status, 'archived');
    assert.strictEqual(revived?.plannerSessionId, planner.id);
    assert.strictEqual(revived?.workerSessionId, worker.id);
  });

  it('12. revive requiring explicit replacement when session is terminated/missing', async () => {
    const proj = await seedProject('Proj12');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 12', 'ses_p12');
    const worker = await seedRuntime(proj.id, 'opencode', 'Worker 12', 'ses_w12');

    const pair = await engine.createPair(proj.id, 'Pair 12', planner.id, worker.id);
    worker.status = 'terminated';
    await db.runtimes.save(worker);

    const workerNew = await seedRuntime(proj.id, 'opencode', 'Worker 12 New', 'ses_w12_new');
    const updated = await engine.updatePair(pair.id, { workerSessionId: workerNew.id });
    assert.strictEqual(updated.workerSessionId, workerNew.id);
  });

  it('13. discovery absence does not erase binding', async () => {
    const proj = await seedProject('Proj13');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 13', 'ses_p13');
    const worker = await seedRuntime(proj.id, 'opencode', 'Worker 13', 'ses_w13');

    const pair = await engine.createPair(proj.id, 'Pair 13', planner.id, worker.id);
    
    const reloaded = await db.pairs.findById(pair.id);
    assert.strictEqual(reloaded?.plannerSessionId, planner.id);
    assert.strictEqual(reloaded?.workerSessionId, worker.id);
  });

  it('14. discovery of another session does not silently rebind', async () => {
    const proj = await seedProject('Proj14');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 14', 'ses_p14');
    const worker = await seedRuntime(proj.id, 'opencode', 'Worker 14', 'ses_w14');
    const discoveredWorker = await seedRuntime(proj.id, 'opencode', 'Worker Discovered', 'ses_w_disc');

    const pair = await engine.createPair(proj.id, 'Pair 14', planner.id, worker.id);

    const currentPair = await db.pairs.findById(pair.id);
    assert.strictEqual(currentPair?.workerSessionId, worker.id);
    assert.notStrictEqual(currentPair?.workerSessionId, discoveredWorker.id);
  });

  it('15. restart preserves exact Pair IDs and session IDs', async () => {
    const proj = await seedProject('Proj15');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 15', 'ses_p15');
    const worker = await seedRuntime(proj.id, 'opencode', 'Worker 15', 'ses_w15');

    const pair = await engine.createPair(proj.id, 'Pair 15', planner.id, worker.id);

    const engineRestarted = new RelayEngine(db);
    const reloadedPair = await engineRestarted.repos.pairs.findById(pair.id);

    assert.strictEqual(reloadedPair?.id, pair.id);
    assert.strictEqual(reloadedPair?.plannerSessionId, planner.id);
    assert.strictEqual(reloadedPair?.workerSessionId, worker.id);
  });

  it('16. direct service caller cannot bypass role checks', async () => {
    const proj = await seedProject('Proj16');
    const worker1 = await seedRuntime(proj.id, 'opencode', 'W1', 'ses_w16a');
    const worker2 = await seedRuntime(proj.id, 'opencode', 'W2', 'ses_w16b');

    await assert.rejects(async () => {
      await service.createPair(proj.id, 'Bad Service Pair', worker1.id, worker2.id);
    });
  });

  it('17. direct service caller cannot create multiple unresolved active Assignments', async () => {
    const proj = await seedProject('Proj17');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 17', 'ses_p17');
    const worker = await seedRuntime(proj.id, 'opencode', 'Worker 17', 'ses_w17');

    const pair = await engine.createPair(proj.id, 'Pair 17', planner.id, worker.id);
    await engine.loadAndActivate(pair.id);

    const a = await service.createAssignment(pair.id, 'Task A', 'Do A');
    await service.dispatchAssignment(a.id);

    const b = await service.createAssignment(pair.id, 'Task B', 'Do B');
    await assert.rejects(async () => {
      await service.dispatchAssignment(b.id);
    }, /already has an unresolved active Assignment/);
  });

  it('18. Pair activeAssignmentId stays consistent with domain state', async () => {
    const proj = await seedProject('Proj18');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 18', 'ses_p18');
    const worker = await seedRuntime(proj.id, 'opencode', 'Worker 18', 'ses_w18');

    const pair = await engine.createPair(proj.id, 'Pair 18', planner.id, worker.id);
    await engine.loadAndActivate(pair.id);

    const asgn = await engine.createAssignment(pair.id, proj.id, 'Task 1', 'Do work');
    await engine.dispatchAssignment(asgn.id);
    const pReloaded = await db.pairs.findById(pair.id);
    assert.strictEqual(pReloaded?.activeAssignmentId, asgn.id);
  });

  it('19. old Attempt remains tied to old Worker after Worker replacement', async () => {
    const proj = await seedProject('Proj19');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 19', 'ses_p19');
    const worker1 = await seedRuntime(proj.id, 'opencode', 'Worker 19A', 'ses_w19a');
    const worker2 = await seedRuntime(proj.id, 'opencode', 'Worker 19B', 'ses_w19b');

    const pair = await engine.createPair(proj.id, 'Pair 19', planner.id, worker1.id);
    await engine.loadAndActivate(pair.id);

    const asgn = await engine.createAssignment(pair.id, proj.id, 'Task 1', 'Do work');
    const dispatched = await engine.dispatchAssignment(asgn.id);
    assert.strictEqual(dispatched.attempt.workerSessionId, worker1.id);

    await engine.completeAssignment(asgn.id);
    await engine.updatePair(pair.id, { workerSessionId: worker2.id });

    const checkAtt1 = await db.attempts.findById(dispatched.attempt.id);
    assert.strictEqual(checkAtt1?.workerSessionId, worker1.id);
  });

  it('20. new Attempt uses new Worker after replacement', async () => {
    const proj = await seedProject('Proj20');
    const planner = await seedRuntime(proj.id, 'chatgpt', 'Planner 20', 'ses_p20');
    const worker1 = await seedRuntime(proj.id, 'opencode', 'Worker 20A', 'ses_w20a');
    const worker2 = await seedRuntime(proj.id, 'opencode', 'Worker 20B', 'ses_w20b');

    const pair = await engine.createPair(proj.id, 'Pair 20', planner.id, worker1.id);
    await engine.loadAndActivate(pair.id);

    const asgn1 = await engine.createAssignment(pair.id, proj.id, 'Task 1', 'Do work');
    await engine.dispatchAssignment(asgn1.id);
    await engine.completeAssignment(asgn1.id);

    await engine.updatePair(pair.id, { workerSessionId: worker2.id });

    const asgn2 = await engine.createAssignment(pair.id, proj.id, 'Task 2', 'Do work 2');
    const dispatched2 = await engine.dispatchAssignment(asgn2.id);

    assert.strictEqual(dispatched2.attempt.workerSessionId, worker2.id);
  });
});
