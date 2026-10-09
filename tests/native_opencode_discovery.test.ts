import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { inspectNativeOpenCode, type NativeServerReference } from '../src/relay/providers/nativeOpenCodeDiscovery';

const server: NativeServerReference = { serverId: 'owned-server', endpoint: 'http://127.0.0.1:4096', ownership: 'MANAGED' };
const spec = { openapi: '3.1.0', info: { version: 'api-version' }, paths: {
  '/global/health': { get: { operationId: 'global.health', responses: { '200': {} } } },
  '/provider': { get: { operationId: 'provider.list', responses: { '200': {} } } },
  '/session/{sessionID}/message': { post: { operationId: 'session.prompt', responses: { '200': {} } } },
} };
const health = { healthy: true, version: '1.18.35' };
const inventory = { all: [{ id: 'provider', models: { 'vendor/model': { id: 'vendor/model', providerID: 'provider' } }, key: 'must-not-return' }], connected: ['provider'], default: { provider: 'vendor/model' } };
function options(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return { calls, request: { server, observedAt: 100, signal: AbortSignal.timeout(2000), authorization: 'Basic secret', fetch: (async (url, init) => {
    const path = new URL(String(url)).pathname; calls.push(path);
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.equal(init?.body, undefined);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Basic secret');
    return new Response(JSON.stringify(path in overrides ? overrides[path] : path === '/doc' ? spec : path === '/global/health' ? health : inventory));
  }) as typeof fetch } };
}
describe('native OpenCode read-only discovery', () => {
  it('inspects advertised API, health and models without granting billing or dispatch permission', async () => {
    const { request, calls } = options(); const result = await inspectNativeOpenCode(request);
    assert.equal(result.status, 'INSPECTED'); assert.deepEqual(calls, ['/doc', '/global/health', '/provider']);
    if (result.status !== 'INSPECTED') return;
    assert.equal(result.apiSpecHash, createHash('sha256').update(JSON.stringify(spec)).digest('hex'));
    assert.equal(result.serverVersion, '1.18.35'); assert.equal(result.dispatchAuthorized, false);
    assert.equal(result.compatibility.sessionRead, false);
    assert.ok(result.compatibility.blockers.includes('UNSUPPORTED_CONTRACT:sessionRead'));
    assert.deepEqual(result.providers, [{ providerId: 'provider', connected: true, modelIds: ['vendor/model'] }]);
    assert.ok(result.declaredOperations.some(op => op.method === 'POST'));
    assert.equal(JSON.stringify(result).includes('Basic secret'), false);
    assert.equal(JSON.stringify(result).includes('must-not-return'), false);
  });
  for (const endpoint of ['http://example.com', 'http://localhost:4096', 'file:///tmp/server', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?key=secret', 'https://example.com/#secret']) {
    it(`blocks invalid/unprotected endpoint ${endpoint}`, async () => {
      const { request, calls } = options();
      assert.deepEqual(await inspectNativeOpenCode({ ...request, server: { ...server, endpoint } }), { status: 'BLOCKED', reason: 'INVALID_ENDPOINT' });
      assert.deepEqual(calls, []);
    });
  }
  it('does not adopt an arbitrary service', async () => {
    const { request, calls } = options();
    const reference = { ...server, ownership: 'UNOWNED' } as unknown as NativeServerReference;
    assert.deepEqual(await inspectNativeOpenCode({ ...request, server: reference }), { status: 'BLOCKED', reason: 'SERVER_NOT_AUTHORIZED' });
    assert.deepEqual(calls, []);
  });
  for (const doc of [null, {}, { ...spec, openapi: '2.0' }, { ...spec, paths: { '/provider': spec.paths['/provider'] } }]) {
    it(`blocks unsupported API before probing runtime ${JSON.stringify(doc)}`, async () => {
      const { request, calls } = options({ '/doc': doc });
      assert.deepEqual(await inspectNativeOpenCode(request), { status: 'BLOCKED', reason: 'API_UNSUPPORTED' });
      assert.deepEqual(calls, ['/doc']);
    });
  }
  it('rejects false health rather than treating 2xx as readiness', async () => {
    const { request, calls } = options({ '/global/health': { healthy: false, version: 'x' } });
    assert.deepEqual(await inspectNativeOpenCode(request), { status: 'BLOCKED', reason: 'RESPONSE_INVALID' });
    assert.deepEqual(calls, ['/doc', '/global/health']);
  });
  for (const providers of [{}, { ...inventory, connected: ['unknown'] }, { ...inventory, connected: ['provider', 'provider'] },
    { ...inventory, all: [...inventory.all, ...inventory.all] }, { ...inventory, all: [{ id: 'provider', models: { model: { id: 'alias' } } }] },
    { ...inventory, all: [{ id: 'provider', models: { model: { id: 'model', providerID: 'wrong-provider' } } }] }]) {
    it(`rejects malformed or ambiguous provider identities ${JSON.stringify(providers)}`, async () => {
      const { request } = options({ '/provider': providers });
      assert.deepEqual(await inspectNativeOpenCode(request), { status: 'BLOCKED', reason: 'RESPONSE_INVALID' });
    });
  }
  it('treats no connected providers as truthful inventory, never fake availability', async () => {
    const { request } = options({ '/provider': { ...inventory, connected: [] } });
    const result = await inspectNativeOpenCode(request);
    assert.equal(result.status, 'INSPECTED');
    if (result.status === 'INSPECTED') assert.equal(result.providers[0].connected, false);
  });
  for (const status of [401, 403, 404, 500]) {
    it(`reports HTTP ${status} without error-body leakage`, async () => {
      const { request } = options();
      const result = await inspectNativeOpenCode({ ...request, fetch: (async () => new Response('secret body', { status })) as typeof fetch });
      assert.deepEqual(result, { status: 'BLOCKED', reason: status === 401 || status === 403 ? 'AUTH_FAILED' : 'SERVER_UNAVAILABLE' });
    });
  }
  it('reports malformed JSON without leaking response text', async () => {
    const { request } = options();
    assert.deepEqual(await inspectNativeOpenCode({ ...request, fetch: (async () => new Response('secret malformed body')) as typeof fetch }), { status: 'BLOCKED', reason: 'RESPONSE_INVALID' });
  });
  it('reports network failure without leaking auth or transport text', async () => {
    const { request } = options();
    assert.deepEqual(await inspectNativeOpenCode({ ...request, fetch: (async () => { throw new Error('Basic secret'); }) as typeof fetch }), { status: 'BLOCKED', reason: 'SERVER_UNAVAILABLE' });
  });
  it('uses only GETs against a real loopback HTTP boundary', async () => {
    const calls: string[] = [];
    const http = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      assert.equal(req.headers.authorization, 'Basic secret');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/doc' ? spec : req.url === '/global/health' ? health : inventory));
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    try {
      const address = http.address(); assert.ok(address && typeof address !== 'string');
      const result = await inspectNativeOpenCode({ server: { ...server, endpoint: `http://127.0.0.1:${address.port}` }, fetch, signal: AbortSignal.timeout(2000), observedAt: 100, authorization: 'Basic secret' });
      assert.equal(result.status, 'INSPECTED');
      assert.deepEqual(calls, ['GET /doc', 'GET /global/health', 'GET /provider']);
    } finally { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); }
  });
});
