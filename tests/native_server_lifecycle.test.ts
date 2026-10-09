import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase';
import { probeRegisteredNativeServer } from '../src/relay/providers/nativeServerLifecycle';
import type { NativeDiscovery } from '../src/relay/providers/nativeOpenCodeDiscovery';
import { checkNativeApiCompatibility } from '../src/relay/providers/nativeApiCompatibility';

const registration = () => ({ serverId: 'server', endpoint: 'http://127.0.0.1:4096/', ownership: 'ADOPTED' as const,
  authKeyRef: 'secure-store-ref', projectRoots: ['/workspace/project'], registeredBy: 'operator', ownershipEvidenceRef: 'adoption-evidence', now: 100 });
const inspected = (): NativeDiscovery => ({ status: 'INSPECTED', server: { serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED' },
  observedAt: 200, serverVersion: '1', apiVersion: '1', apiSpecHash: 'digest', rawApiSpec: '{}', providers: [], declaredOperations: [], compatibility: checkNativeApiCompatibility({}), dispatchAuthorized: false });
const spec = { openapi: '3.1.0', info: { version: '1' }, paths: { '/global/health': { get: { responses: { '200': {} } } }, '/provider': { get: { responses: { '200': {} } } } } };
const probeOptions = () => ({ observedAt: 200, signal: AbortSignal.timeout(1000), resolveAuthorization: async () => 'Basic secret', fetch: (async url => {
  const path = new URL(String(url)).pathname;
  return new Response(JSON.stringify(path === '/doc' ? spec : path === '/global/health' ? { healthy: true, version: '1' } : { all: [], connected: [], default: {} }));
}) as typeof fetch });

describe('durable native server ownership and lifecycle', () => {
  it('requires explicit ownership evidence and loopback for managed servers', () => {
    const db = new SqliteRelayDatabase();
    try {
      assert.throws(() => db.nativeServers.register({ ...registration(), ownershipEvidenceRef: '' }), /ownership evidence/);
      assert.throws(() => db.nativeServers.register({ ...registration(), ownership: 'MANAGED', endpoint: 'https://remote.example' }), /loopback/);
      assert.equal(db.nativeServers.get('server'), undefined);
    } finally { db.close(); }
  });
  it('preserves explicit ownership and inspection across file-backed reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-native-')); let db: SqliteRelayDatabase | undefined;
    try {
      const path = join(dir, 'relay.sqlite'); db = new SqliteRelayDatabase(path);
      db.nativeServers.register(registration()); db.nativeServers.applyDiscovery('server', 1, 200, inspected());
      db.close(); db = new SqliteRelayDatabase(path);
      const record = db.nativeServers.get('server')!;
      assert.equal(record.ownership, 'ADOPTED'); assert.equal(record.lifecycle, 'INSPECTED'); assert.equal(record.lastHealthyAt, 200);
      assert.equal(record.authKeyRef, 'secure-store-ref'); assert.equal(record.inspection?.apiSpecHash, 'digest');
      assert.equal(record.inspection?.compatibility?.questionReply, false);
      assert.equal(db.db.prepare('PRAGMA user_version').get()?.user_version, 6);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM native_server_history').get()?.n, 2);
    } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not silently rebind an existing server ID or claim an occupied endpoint', () => {
    const db = new SqliteRelayDatabase();
    try {
      db.nativeServers.register(registration());
      assert.throws(() => db.nativeServers.register({ ...registration(), endpoint: 'http://127.0.0.1:4097' }));
      assert.throws(() => db.nativeServers.register({ ...registration(), serverId: 'second', endpoint: 'http://127.0.0.1:4096' }));
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM native_server_history').get()?.n, 1);
    } finally { db.close(); }
  });
  it('revocation is terminal and permits explicit adoption under a new identity', () => {
    const db = new SqliteRelayDatabase();
    try {
      db.nativeServers.register(registration()); assert.equal(db.nativeServers.revoke('server', 1, 150), true);
      assert.equal(db.nativeServers.applyDiscovery('server', 2, 200, inspected()), false);
      db.nativeServers.register({ ...registration(), serverId: 'new-server', now: 200 });
      assert.equal(db.nativeServers.get('server')?.lifecycle, 'REVOKED');
      assert.equal(db.nativeServers.get('new-server')?.lifecycle, 'REGISTERED');
    } finally { db.close(); }
  });
  it('rejects a delayed result after newer failure and retains historical healthy time', () => {
    const db = new SqliteRelayDatabase();
    try {
      db.nativeServers.register(registration()); db.nativeServers.applyDiscovery('server', 1, 200, inspected());
      assert.equal(db.nativeServers.applyDiscovery('server', 2, 300, { status: 'BLOCKED', reason: 'AUTH_FAILED' }), true);
      assert.equal(db.nativeServers.applyDiscovery('server', 2, 400, inspected()), false);
      const record = db.nativeServers.get('server')!;
      assert.equal(record.lifecycle, 'BLOCKED'); assert.equal(record.lastHealthyAt, 200); assert.equal(record.inspection, undefined);
    } finally { db.close(); }
  });
  it('rejects wrong endpoint evidence and backwards clocks without partial audit writes', () => {
    const db = new SqliteRelayDatabase();
    try {
      db.nativeServers.register(registration()); const result = inspected();
      if (result.status === 'INSPECTED') result.server.endpoint = 'http://127.0.0.1:4097';
      assert.throws(() => db.nativeServers.applyDiscovery('server', 1, 200, result), /identity mismatch/);
      assert.throws(() => db.nativeServers.revoke('server', 1, 99), /lifecycle time/);
      assert.equal(db.nativeServers.get('server')?.revision, 1);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM native_server_history').get()?.n, 1);
    } finally { db.close(); }
  });
  it('rolls registration and history back with an outer relay transaction', async () => {
    const db = new SqliteRelayDatabase();
    try {
      await assert.rejects(db.runInTransaction(async () => { db.nativeServers.register(registration()); throw new Error('abort'); }));
      assert.equal(db.nativeServers.get('server'), undefined);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM native_server_history').get()?.n, 0);
    } finally { db.close(); }
  });
  it('rolls lifecycle changes back when audit persistence fails', () => {
    const db = new SqliteRelayDatabase();
    try {
      db.nativeServers.register(registration());
      db.db.exec("CREATE TRIGGER reject_native_audit BEFORE INSERT ON native_server_history BEGIN SELECT RAISE(ABORT,'audit failed'); END");
      assert.throws(() => db.nativeServers.revoke('server', 1, 150), /audit failed/);
      assert.equal(db.nativeServers.get('server')?.revision, 1);
      assert.equal(db.nativeServers.get('server')?.lifecycle, 'REGISTERED');
    } finally { db.close(); }
  });
  it('rejects a backwards probe clock before resolving credentials', async () => {
    const db = new SqliteRelayDatabase();
    try {
      db.nativeServers.register(registration()); let calls = 0;
      await assert.rejects(probeRegisteredNativeServer(db.nativeServers, 'server', { ...probeOptions(), observedAt: 99,
        resolveAuthorization: async () => { calls++; return 'secret'; } }), /probe time/);
      assert.equal(calls, 0);
    } finally { db.close(); }
  });
  it('does not probe unregistered or revoked servers', async () => {
    const db = new SqliteRelayDatabase();
    try {
      let authCalls = 0; const options = { ...probeOptions(), resolveAuthorization: async () => { authCalls++; return 'secret'; } };
      assert.equal((await probeRegisteredNativeServer(db.nativeServers, 'server', options)).status, 'NOT_AUTHORIZED');
      db.nativeServers.register(registration()); db.nativeServers.revoke('server', 1, 150);
      assert.equal((await probeRegisteredNativeServer(db.nativeServers, 'server', options)).status, 'NOT_AUTHORIZED');
      assert.equal(authCalls, 0);
    } finally { db.close(); }
  });
  it('records a successful read-only probe without persisting authorization', async () => {
    const db = new SqliteRelayDatabase();
    try {
      db.nativeServers.register(registration());
      assert.equal((await probeRegisteredNativeServer(db.nativeServers, 'server', probeOptions())).status, 'RECORDED');
      assert.equal(db.nativeServers.get('server')?.lifecycle, 'INSPECTED');
      assert.equal(JSON.stringify(db.db.prepare('SELECT record_json FROM native_server_history').all()).includes('Basic secret'), false);
    } finally { db.close(); }
  });
  it('discards in-flight inspection after revocation', async () => {
    const db = new SqliteRelayDatabase();
    try {
      db.nativeServers.register(registration()); const options = probeOptions(); const fetchOriginal = options.fetch;
      let called = false;
      options.fetch = (async (url, init) => { if (!called) { called = true; db.nativeServers.revoke('server', 1, 150); } return fetchOriginal(url, init); }) as typeof fetch;
      assert.equal((await probeRegisteredNativeServer(db.nativeServers, 'server', options)).status, 'SUPERSEDED');
      assert.equal(db.nativeServers.get('server')?.lifecycle, 'REVOKED');
    } finally { db.close(); }
  });
  it('rechecks ownership after asynchronous credential resolution', async () => {
    const db = new SqliteRelayDatabase();
    try {
      db.nativeServers.register(registration()); const options = probeOptions(); let requests = 0;
      options.resolveAuthorization = async () => { db.nativeServers.revoke('server', 1, 150); return 'secret'; };
      options.fetch = (async () => { requests++; throw new Error('must not request'); }) as typeof fetch;
      assert.equal((await probeRegisteredNativeServer(db.nativeServers, 'server', options)).status, 'SUPERSEDED'); assert.equal(requests, 0);
    } finally { db.close(); }
  });
  it('reports missing credential access without probing or storing errors', async () => {
    const db = new SqliteRelayDatabase();
    try {
      db.nativeServers.register(registration());
      assert.equal((await probeRegisteredNativeServer(db.nativeServers, 'server', { ...probeOptions(), resolveAuthorization: async () => { throw new Error('secret'); } })).status, 'AUTH_UNAVAILABLE');
      assert.equal(db.nativeServers.get('server')?.revision, 2);
      assert.equal(db.nativeServers.get('server')?.lifecycle, 'BLOCKED');
      assert.equal(db.nativeServers.get('server')?.blocker, 'AUTH_UNAVAILABLE');
    } finally { db.close(); }
  });
  it('captures probe revision when a store returns mutable records', async () => {
    const db = new SqliteRelayDatabase();
    try {
      const record = db.nativeServers.register(registration()); let calls = 0;
      const result = await probeRegisteredNativeServer({ get: () => record, applyDiscovery: () => { throw new Error('must not apply'); } }, 'server', {
        ...probeOptions(), resolveAuthorization: async () => { record.revision++; return 'secret'; },
        fetch: (async () => { calls++; throw new Error('must not fetch'); }) as typeof fetch,
      });
      assert.equal(result.status, 'SUPERSEDED'); assert.equal(calls, 0);
    } finally { db.close(); }
  });
});
