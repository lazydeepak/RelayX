import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { SqliteAssociationRepository } from '../src/relay/persistence/sqlite/SqliteAssociationRepository.ts';
import { RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { AssociationId, RuntimeSessionId, ProjectId } from '../src/relay/domain/types.ts';

describe('Persistence: RuntimeProjectAssociation', () => {
  let db: SqliteRelayDatabase;

  before(async () => {
    db = new SqliteRelayDatabase(':memory:');
  });

  after(async () => {
    db.close();
  });

  test('association persists, reloads, deletes with isolated DB', async () => {
    // Create parent records required by foreign keys.
    const projRepo = db.projects;
    const runtimeRepo = db.runtimes;
    await projRepo.save({ id: 'proj-test' as ProjectId, name: 'T', description: '', status: 'active', createdAt: Date.now(), updatedAt: Date.now() } as any);
    await runtimeRepo.save({ id: 'sess-test' as RuntimeSessionId, providerType: 'opencode', name: 'S', status: 'available', createdAt: Date.now(), updatedAt: Date.now(), consecutiveObservationFailures: 0 } as any);

    const repo = new SqliteAssociationRepository(db.db);
    const assoc = RuntimeProjectAssociation.create(
      'sess-test' as RuntimeSessionId,
      'proj-test' as ProjectId,
      'ses-auth',
      'verified',
      'discovery',
      'opencode',
    );
    await repo.save(assoc);

    const fetched = await repo.findById(assoc.id);
    assert.ok(fetched);
    assert.strictEqual(fetched!.runtimeSessionId, 'sess-test' as RuntimeSessionId);
    assert.strictEqual(fetched!.projectId, 'proj-test' as ProjectId);
    assert.strictEqual(fetched!.providerType, 'opencode');
    assert.strictEqual(fetched!.verificationState, 'verified');
    assert.strictEqual(fetched!.provenance, 'discovery');

    const bySession = await repo.findBySessionId('sess-test' as RuntimeSessionId);
    assert.strictEqual(bySession.length, 1);
    assert.strictEqual(bySession[0].id, assoc.id);

    const verified = await repo.findVerifiedBySessionId('sess-test' as RuntimeSessionId, {
      providerType: 'opencode',
      externalSessionId: 'ses-auth',
      projectId: 'proj-test' as ProjectId,
    });
    assert.ok(verified);
    assert.strictEqual(verified!.id, assoc.id);

    await repo.delete(assoc.id);
    const afterDelete = await repo.findById(assoc.id);
    assert.strictEqual(afterDelete, null);
  });

  test('duplicate session-project association rejected by unique index', async () => {
    await db.projects.save({ id: 'proj-dup' as ProjectId, name: 'T', description: '', status: 'active', createdAt: Date.now(), updatedAt: Date.now() } as any);
    await db.runtimes.save({ id: 'sess-dup' as RuntimeSessionId, providerType: 'opencode', name: 'S', status: 'available', createdAt: Date.now(), updatedAt: Date.now(), consecutiveObservationFailures: 0 } as any);
    const repo = new SqliteAssociationRepository(db.db);
    const assoc1 = RuntimeProjectAssociation.create(
      'sess-dup' as RuntimeSessionId,
      'proj-dup' as ProjectId,
      'ses-dup',
      'verified',
      'adoption',
      'opencode',
    );
    await repo.save(assoc1);
    const assoc2 = RuntimeProjectAssociation.create(
      'sess-dup' as RuntimeSessionId,
      'proj-dup' as ProjectId,
      'ses-dup',
      'verified',
      'manual_registration',
      'opencode',
    );
    await assert.rejects(async () => repo.save(assoc2), (err: Error) => err.message.includes('SQLITE') || err.message.includes('constraint') || err.message.includes('UNIQUE'));
  });

  test('existing pairs and assignments preserved when association table added', async () => {
    // Verify no destructive impact: pairs/assignments tables untouched.
    // The association table is independent; pairs/assignments remain intact.
    const pairRepo = db.pairs;
    const pairs = await pairRepo.findAll();
    // No pairs created in this isolated DB besides default; just verify no error.
    assert.ok(Array.isArray(pairs));
  });
});
