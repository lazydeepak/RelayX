import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';

describe('Manual planner without verified identity rejected', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;

  before(async () => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    service = new RelayApiService(db, engine);
  });

  after(async () => {
    db.close();
  });

  test('manual planner with null externalSessionId is rejected by the pre-pair association gate', async () => {
    const proj = await service.engine.createProject('ManualGate', '', '/dev/manual-gate', '/dev/manual-gate');
    proj.update(undefined, undefined, undefined, undefined, 'https://chatgpt.com/g/g-p-gate', '/dev/manual-gate');
    await db.projects.save(proj);

    // Verified planner with authoritative identity
    const verifiedPlanner = await service.engine.registerRuntimeSession('chatgpt', 'VerifiedPlanner', 'com.openai.chat');
    verifiedPlanner.updateExternalIdentity('conv-verified', 'https://chatgpt.com/g/g-p-gate');
    await db.runtimes.save(verifiedPlanner);

    // Manual planner with NO authoritative external session ID
    const manualPlanner = await service.engine.registerRuntimeSession('chatgpt', 'ManualPlanner', 'com.openai.chat');
    // Intentionally leave externalSessionId = null and externalProjectRef = null (manual unverified entry)
    await db.runtimes.save(manualPlanner);

    // Pre-pair state
    const preAssocManual = await db.associations.findBySessionId(manualPlanner.id);
    assert.strictEqual(preAssocManual ? preAssocManual.length : 0, 0);
    const preAssocVerified = await db.associations.findBySessionId(verifiedPlanner.id);
    assert.strictEqual(preAssocVerified ? preAssocVerified.length : 0, 0);

    // Manual planner with only project reference but no session identity — must NOT pass verified pairing gate.
    const manualPlannerOnlyRef = await service.engine.registerRuntimeSession('chatgpt', 'ManualPlannerRefOnly', 'com.openai.chat');
    manualPlannerOnlyRef.updateExternalIdentity(null, 'https://chatgpt.com/g/g-p-gate');
    await db.runtimes.save(manualPlannerOnlyRef);

    // Pairing with verified planner (conv-verified/g-p-gate) + verified worker (opencode + ses_verified) should succeed; pairing with manual planner must be rejected.
    const verifiedWorker = await service.engine.registerRuntimeSession('opencode', 'VerifiedWorker', 'dev.opencode.desktop');
    verifiedWorker.updateExternalIdentity('ses_verified', '/dev/manual-gate');
    await db.runtimes.save(verifiedWorker);
    // A null ID does not bypass the association check; the selected runtime
    // still must have matching pre-pair evidence.
    await assert.rejects(
      async () => service.createPair(proj.id, 'ManualGatePair', manualPlanner.id, verifiedWorker.id),
      /planner session lacks matching pre-pair verified authoritative association/,
    );

    // After failure: pair must NOT exist; verified association for verified planner must NOT exist; manual association must NOT exist; no false verified/pair_binding.
    // Project-reference-only manual planner must also be rejected (no session identity).
    await assert.rejects(
      async () => service.createPair(proj.id, 'ManualGatePairRef', manualPlannerOnlyRef.id, verifiedWorker.id),
      /planner session lacks matching pre-pair verified authoritative association/,
    );
    const pairs = await db.pairs.findByProjectId(proj.id);
    assert.strictEqual(pairs.length, 0);

    const postAssocManual = await db.associations.findBySessionId(manualPlanner.id);
    assert.strictEqual(postAssocManual ? postAssocManual.length : 0, 0);

    const postAssocVerified = await db.associations.findBySessionId(verifiedPlanner.id);
    assert.strictEqual(postAssocVerified ? postAssocVerified.length : 0, 0);
  });
});
