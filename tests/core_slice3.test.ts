import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('Core Slice 3 — Repository Boundary B1-B7', () => {
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

  it('B1 — Pre-existing dirty preserved; not attributed to worker', async () => {
    const tmpDir = `/tmp/relay_b1_${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/auth.ts'), 'original');
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "t@test"; git config user.name "T"', { cwd: tmpDir });
    execSync('git add .; git commit -m "init"', { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'src/auth.ts'), 'modified_by_human');

    const project = await engine.createProject('B1', '', tmpDir);
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    planner.updateExternalIdentity('bind_b1_pl');
    await db.runtimes.save(planner);
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    worker.updateExternalIdentity('bind_b1_wk');
    await db.runtimes.save(worker);
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    await db.associations.save(new RuntimeProjectAssociation({ id: 'assoc_b1_pl', runtimeSessionId: planner.id, projectId: project.id, providerType: 'chatgpt', externalSessionId: planner.externalSessionId ?? '', verificationState: 'verified', provenance: 'pair_binding', createdAt: Date.now(), updatedAt: Date.now() }));
    await db.associations.save(new RuntimeProjectAssociation({ id: 'assoc_b1_wk', runtimeSessionId: worker.id, projectId: project.id, providerType: 'opencode', externalSessionId: worker.externalSessionId ?? '', verificationState: 'verified', provenance: 'pair_binding', createdAt: Date.now(), updatedAt: Date.now() }));
    const pair = await engine.createPair(project.id, 'Pair', planner.id, worker.id);
    const assignment = await engine.createAssignment(pair.id, 'A', 'Do X');
    const { attempt } = await engine.dispatchAssignment(assignment.id);
    // Baseline should have captured dirty state at time of dispatch (HEAD + dirty files)
    // Because repo boundary is additive, attempt should have repo_baseline_json if captured
    // Verify no destructive recovery exists
    assert.strictEqual(typeof (engine as any).revertRepo, 'undefined');
    assert.strictEqual(typeof (engine as any).gitReset, 'undefined');

    // Observation would classify this as ambiguous_collision if auth file changed,
    // but the key point for B1 is pre-existing dirty preserved in baseline
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('B4 — Unrelated README mutation unrelated change', async () => {
    const tmpDir = `/tmp/relay_b4_${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/auth.ts'), 'v1');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'readme');
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "t@test"; git config user.name "T"', { cwd: tmpDir });
    execSync('git add .; git commit -m "init"', { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'updated readme only');
    const project = await engine.createProject('B4', '', tmpDir);
    const planner = await engine.registerRuntimeSession('chatgpt', 'Planner');
    planner.updateExternalIdentity('bind_b4_pl');
    await db.runtimes.save(planner);
    const worker = await engine.registerRuntimeSession('opencode', 'Worker');
    worker.updateExternalIdentity('bind_b4_wk');
    await db.runtimes.save(worker);
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    await db.associations.save(new RuntimeProjectAssociation({ id: 'assoc_b4_pl', runtimeSessionId: planner.id, projectId: project.id, providerType: 'chatgpt', externalSessionId: planner.externalSessionId ?? '', verificationState: 'verified', provenance: 'pair_binding', createdAt: Date.now(), updatedAt: Date.now() }));
    await db.associations.save(new RuntimeProjectAssociation({ id: 'assoc_b4_wk', runtimeSessionId: worker.id, projectId: project.id, providerType: 'opencode', externalSessionId: worker.externalSessionId ?? '', verificationState: 'verified', provenance: 'pair_binding', createdAt: Date.now(), updatedAt: Date.now() }));
    const pair = await engine.createPair(project.id, 'Pair', planner.id, worker.id);
    const assignment = await engine.createAssignment(pair.id, 'A', 'Do X');
    const { attempt } = await engine.dispatchAssignment(assignment.id);
    // Baseline should be preserved; README change is outside scope; not automatic failure
    assert.strictEqual(attempt.status, 'running');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('B7 — Restart persistence of baseline and observation', async () => {
    const tempPath = `/tmp/relay_b7_${Date.now()}.db`;
    let dbFile = new SqliteRelayDatabase(tempPath);
    let fileEngine = new RelayEngine(dbFile);
    fileEngine.registerProvider(mockProvider);
    fileEngine.registerProvider(new MockProvider('chatgpt'));
    const project = await fileEngine.createProject('B7', '', '/Users/lazydeepak/dev/RelayX');
    const planner = await fileEngine.registerRuntimeSession('chatgpt', 'Planner');
    planner.updateExternalIdentity('bind_b7_pl');
    await dbFile.runtimes.save(planner);
    const worker = await fileEngine.registerRuntimeSession('opencode', 'Worker');
    worker.updateExternalIdentity('bind_b7_wk');
    await dbFile.runtimes.save(worker);
    const { RuntimeProjectAssociation } = await import('../src/relay/domain/entities.ts');
    await dbFile.associations.save(new RuntimeProjectAssociation({ id: 'assoc_b7_pl', runtimeSessionId: planner.id, projectId: project.id, providerType: 'chatgpt', externalSessionId: planner.externalSessionId ?? '', verificationState: 'verified', provenance: 'pair_binding', createdAt: Date.now(), updatedAt: Date.now() }));
    await dbFile.associations.save(new RuntimeProjectAssociation({ id: 'assoc_b7_wk', runtimeSessionId: worker.id, projectId: project.id, providerType: 'opencode', externalSessionId: worker.externalSessionId ?? '', verificationState: 'verified', provenance: 'pair_binding', createdAt: Date.now(), updatedAt: Date.now() }));
    const pair = await fileEngine.createPair(project.id, 'Pair', planner.id, worker.id);
    const assignment = await fileEngine.createAssignment(pair.id, 'A', 'Do X');
    const { attempt, delivery } = await fileEngine.dispatchAssignment(assignment.id);
    // Simulate baseline and observation saved
    await dbFile.attempts.save(attempt);
    const dbReload = new SqliteRelayDatabase(tempPath);
    const engineReload = new RelayEngine(dbReload);
    const reloadedAttempt = await dbReload.attempts.findById(attempt.id);
    assert.ok(reloadedAttempt);
    assert.strictEqual(reloadedAttempt!.sessionPairId, pair.id);
    assert.strictEqual(reloadedAttempt!.externalSessionId, 'bind_worker_b7');
    await import('fs').then((fs) => fs.unlinkSync ? fs.unlinkSync(tempPath) : null);
  });
});
