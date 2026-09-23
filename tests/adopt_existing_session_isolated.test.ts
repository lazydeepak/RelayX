import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Project, RuntimeSession } from '../src/relay/domain/entities.ts';
import { ProjectId, ProviderType } from '../src/relay/domain/types.ts';

// Isolated workspace matching the service-tested workspace.
const DISPOSABLE_WORKSPACE = '/tmp/opencode_disposable_workspace';
const SESSION_ID = 'ses_f36097667ffe7DDdSTkROUCzOk';

describe('adoptOpenCodeSession: isolated adoption of existing session', () => {
  it('binds the discovered session id to a runtime in an isolated DB and verifies persistence', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);

    // Project aligned with the disposable workspace.
    const proj = new Project({
      id: 'proj-adopt' as ProjectId,
      name: 'Adopt Project',
      description: '',
      canonicalPath: DISPOSABLE_WORKSPACE,
      plannerProjectUrl: 'https://chatgpt.com/g/g-p-adopt',
      workerWorkspacePath: DISPOSABLE_WORKSPACE,
      gitRoot: DISPOSABLE_WORKSPACE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.projects.save(proj);

    // Adoption of the externally-created authoritative session.
    const adopted = await api.adoptOpenCodeSession('proj-adopt', SESSION_ID, 'Adopted Session');
    assert.strictEqual(adopted.providerType, 'opencode');
    assert.strictEqual(adopted.externalSessionId, SESSION_ID);
    assert.strictEqual(adopted.externalProjectRef, DISPOSABLE_WORKSPACE);
    assert.strictEqual(adopted.name, 'Adopted Session');

    // Idempotent re-adoption returns the same runtime (same DB row, same id).
    const adoptedAgain = await api.adoptOpenCodeSession('proj-adopt', SESSION_ID);
    assert.strictEqual(adoptedAgain.id, adopted.id);
    assert.strictEqual(adoptedAgain.externalSessionId, SESSION_ID);

    // Verify the adopted runtime persisted in the isolated DB by direct lookup.
    const stored = await db.runtimes.findById(adopted.id as any);
    assert.ok(stored, 'Adopted runtime must exist in isolated DB');
    assert.strictEqual(stored?.externalSessionId, SESSION_ID);
    assert.strictEqual(stored?.providerType, 'opencode');
  });

  it('rejects adoption when the session is already bound to a different workspace', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const api = new RelayApiService(db, engine);

    await db.projects.save(
      new Project({
        id: 'proj-conflict' as ProjectId,
        name: 'Conflict',
        description: '',
        canonicalPath: '/dev/other',
        plannerProjectUrl: 'https://chatgpt.com/g/g-p-conflict',
        workerWorkspacePath: '/dev/other',
        gitRoot: '/dev/other',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    // Bind the session to a different workspace first.
    await api.adoptOpenCodeSession('proj-conflict', SESSION_ID, 'Bound Elsewhere');

    // Now attempt adoption into a project with a DIFFERENT workspace path.
    await db.projects.save(
      new Project({
        id: 'proj-adopt' as ProjectId,
        name: 'Adopt Conflict',
        description: '',
        canonicalPath: '/dev/adopt',
        plannerProjectUrl: 'https://chatgpt.com/g/g-p-adopt',
        workerWorkspacePath: '/dev/adopt',
        gitRoot: '/dev/adopt',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await assert.rejects(
      async () => await api.adoptOpenCodeSession('proj-adopt', SESSION_ID),
      /different workspace/i,
    );
  });

  it('confirms no message delivery and unchanged service state', async () => {
    // Read-only confirmation only — no additional DB/state mutation.
    const res = await fetch(
      'http://127.0.0.1:49374/api/session/ses_f36097667ffe7DDdSTkROUCzOk/message',
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from('opencode:EzuqNXu7RKaZltqfoGxYlyjzERvR7U8Y-lJ2Q-J04po').toString('base64')}`,
          Accept: 'application/json',
        },
      },
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.data, []);
    assert.strictEqual(body.cursor?.previous, null);
  });
});
