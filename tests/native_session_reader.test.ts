import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readNativeSession } from '../src/relay/providers/nativeSessionReader';
import type { NativeServerRecord } from '../src/relay/providers/nativeServerLifecycle';

function record(): NativeServerRecord {
  return { serverId: 'server', endpoint: 'http://127.0.0.1:4096', ownership: 'ADOPTED', revision: 2, lifecycle: 'INSPECTED',
    authKeyRef: 'opaque-key-ref', projectRoots: ['/project with space'], registeredBy: 'operator', ownershipEvidenceRef: 'adopted', createdAt: 100, updatedAt: 200,
    inspection: { observedAt: 200, apiSpecHash: 'digest', apiVersion: '1', serverVersion: '1', declaredOperations: [],
      compatibility: { sessionRead: true, messageRead: true, messageSend: false, executionTerminalRead: true, questionRead: false, questionReply: false, eventStream: false, blockers: [] } } };
}
const session = () => ({ id: 'ses_exact', directory: '/project with space', title: 'Renamed session', unknown: 'private-extra' });
function transcript() {
  return [{ info: { id: 'msg_user', sessionID: 'ses_exact', role: 'user', time: { created: 100 }, model: { providerID: 'provider', modelID: 'model' } },
    parts: [{ id: 'part_user', sessionID: 'ses_exact', messageID: 'msg_user', type: 'text', text: 'Instruction' }] },
  { info: { id: 'msg_assistant', sessionID: 'ses_exact', role: 'assistant', time: { created: 150, completed: 180 }, finish: 'stop', parentID: 'msg_user', providerID: 'provider', modelID: 'model' },
    parts: [{ id: 'part_answer', sessionID: 'ses_exact', messageID: 'msg_assistant', type: 'text', text: 'Answer' }] }];
}
function setup() {
  const server = record(); const calls: string[] = []; const messages = transcript(); const bound = session();
  const options = { serverId: 'server', sessionId: 'ses_exact', directory: '/project with space', observedAt: 250, maximumInspectionAgeMs: 100,
    messageLimit: 20, signal: AbortSignal.timeout(2000), resolveAuthorization: async () => 'Basic secret', fetch: (async (url, init) => {
      const parsed = new URL(String(url)); calls.push(parsed.pathname);
      assert.equal(parsed.searchParams.get('directory'), '/project with space'); assert.equal(init?.method, 'GET');
      assert.equal(parsed.searchParams.get('limit'), parsed.pathname.endsWith('/message') ? '20' : null);
      assert.equal(init?.body, undefined); assert.equal(init?.redirect, 'error');
      return new Response(JSON.stringify(parsed.pathname.endsWith('/message') ? messages : bound));
    }) as typeof fetch };
  return { server, store: { get: () => server }, options, calls, messages, bound };
}
describe('exact native session transcript reader', () => {
  it('reads renamed sessions by exact ID and preserves message/part identities', async () => {
    const { store, options, calls } = setup(); const result = await readNativeSession(store, options);
    assert.equal(result.status, 'READ'); assert.deepEqual(calls, ['/session/ses_exact', '/session/ses_exact/message']);
    if (result.status !== 'READ') return;
    assert.equal(result.session.title, 'Renamed session'); assert.equal(result.messages[1].parentId, 'msg_user');
    assert.equal(result.messages[1].completedAt, 180); assert.equal(result.messages[1].finish, 'stop');
    assert.equal(result.messages[1].parts[0].text, 'Answer'); assert.equal(result.completeHistory, false);
    assert.equal(JSON.stringify(result).includes('private-extra'), false); assert.equal(JSON.stringify(result).includes('Basic secret'), false);
  });
  it('retains only the typed error discriminator, never provider error content', async () => {
    const value = setup(); const info = value.messages[1].info as Record<string,unknown>; delete info.finish;
    info.error = { name: 'ProviderAuthError', data: { message: 'secret provider body' } };
    const result = await readNativeSession(value.store,value.options); assert.equal(result.status,'READ');
    if (result.status === 'READ') { assert.equal(result.messages[1].errorType,'ProviderAuthError'); assert.equal(JSON.stringify(result).includes('secret provider body'),false); }
    (info.error as { name: string }).name = 'secret provider body!';
    assert.deepEqual(await readNativeSession(value.store,value.options),{status:'BLOCKED',reason:'RESPONSE_INVALID'});
  });
  it('blocks records without schema compatibility before credentials or network', async () => {
    const value = setup(); value.server.inspection!.compatibility = undefined;
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'API_UNSUPPORTED' }); assert.deepEqual(value.calls, []);
  });
  for (const lifecycle of ['REGISTERED', 'BLOCKED', 'REVOKED'] as const) {
    it(`blocks ${lifecycle} lifecycle`, async () => {
      const value = setup(); value.server.lifecycle = lifecycle;
      assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'SERVER_NOT_INSPECTED' }); assert.deepEqual(value.calls, []);
    });
  }
  it('requires explicit inspection freshness and blocks the expiry boundary', async () => {
    const value = setup(); value.options.observedAt = 300;
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'INSPECTION_NOT_CURRENT' });
    assert.deepEqual(value.calls, []);
  });
  for (const id of ['..', 'ses_a/other', 'ses_a?directory=other', '']) {
    it(`rejects invalid session path identity ${id}`, async () => {
      const value = setup(); value.options.sessionId = id;
      assert.equal((await readNativeSession(value.store, value.options)).status, 'BLOCKED'); assert.deepEqual(value.calls, []);
    });
  }
  it('requires a registered project directory', async () => {
    const value = setup(); value.options.directory = '/another';
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'SESSION_SCOPE_NOT_AUTHORIZED' }); assert.deepEqual(value.calls, []);
  });
  it('rejects an oversized page and invalid page limits', async () => {
    const value = setup(); value.options.messageLimit = 0;
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'INVALID_PAGE_LIMIT' });
    value.options.messageLimit = 1;
    value.options.fetch = (async url => new Response(JSON.stringify(String(url).includes('/message') ? value.messages : value.bound))) as typeof fetch;
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'RESPONSE_INVALID' });
  });
  for (const field of ['id', 'directory'] as const) {
    it(`rejects cross-session/project ${field} without fetching transcript`, async () => {
      const value = setup(); value.bound[field] = 'different';
      assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'SESSION_IDENTITY_MISMATCH' });
      assert.equal(value.calls.length, 1);
    });
  }
  it('rejects stale cross-session messages', async () => {
    const value = setup(); value.messages[1].info.sessionID = 'ses_stale';
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'MESSAGE_IDENTITY_MISMATCH' });
  });
  it('rejects duplicate message identities', async () => {
    const value = setup(); value.messages.push(value.messages[0]);
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'MESSAGE_IDENTITY_MISMATCH' });
  });
  for (const field of ['sessionID', 'messageID'] as const) {
    it(`rejects mismatched part ${field}`, async () => {
      const value = setup(); value.messages[1].parts[0][field] = 'other';
      assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'PART_IDENTITY_MISMATCH' });
    });
  }
  it('rejects duplicate part identities', async () => {
    const value = setup(); value.messages[1].parts[0].id = 'part_user';
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'PART_IDENTITY_MISMATCH' });
  });
  it('rejects unknown roles and malformed timestamps without fabricating content', async () => {
    const value = setup(); value.messages[1].info.role = 'unknown';
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'RESPONSE_INVALID' });
    value.messages[1].info.role = 'assistant'; value.messages[1].info.time.completed = 99;
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'RESPONSE_INVALID' });
  });
  it('does not claim complete history for an empty returned page', async () => {
    const value = setup(); value.messages.length = 0;
    const result = await readNativeSession(value.store, value.options);
    assert.equal(result.status, 'READ'); if (result.status === 'READ') assert.deepEqual(result.messages, []);
  });
  it('rechecks ownership after credential resolution', async () => {
    const value = setup(); value.options.resolveAuthorization = async () => { value.server.revision++; value.server.lifecycle = 'REVOKED'; return 'secret'; };
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'SUPERSEDED' }); assert.deepEqual(value.calls, []);
  });
  it('captures revision even if a store returns mutable objects', async () => {
    const value = setup(); value.options.resolveAuthorization = async () => { value.server.revision++; return 'secret'; };
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'SUPERSEDED' }); assert.deepEqual(value.calls, []);
  });
  it('discards a transcript retrieved during revocation', async () => {
    const value = setup(); const original = value.options.fetch;
    value.options.fetch = (async (url, init) => {
      const response = await original(url, init);
      if (String(url).includes('/message')) { value.server.revision++; value.server.lifecycle = 'REVOKED'; }
      return response;
    }) as typeof fetch;
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'SUPERSEDED' });
  });
  for (const status of [401, 404, 500]) {
    it(`reports HTTP ${status} without leaking bodies`, async () => {
      const value = setup(); value.options.fetch = (async () => new Response('secret body', { status })) as typeof fetch;
      assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: status === 401 ? 'AUTH_FAILED' : status === 404 ? 'SESSION_NOT_FOUND' : 'SERVER_UNAVAILABLE' });
    });
  }
  it('reports unavailable credentials without sending requests', async () => {
    const value = setup(); value.options.resolveAuthorization = async () => { throw new Error('secret'); };
    assert.deepEqual(await readNativeSession(value.store, value.options), { status: 'BLOCKED', reason: 'AUTH_UNAVAILABLE' }); assert.deepEqual(value.calls, []);
  });
  it('reads through a real loopback HTTP boundary with directory isolation', async () => {
    const value = setup(); const calls: string[] = [];
    const http = createServer((req, res) => {
      const url = new URL(req.url!, 'http://127.0.0.1'); calls.push(url.pathname);
      assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, 'Basic secret');
      assert.equal(url.searchParams.get('directory'), '/project with space');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(url.pathname.endsWith('/message') ? value.messages : value.bound));
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    try {
      const address = http.address(); assert.ok(address && typeof address !== 'string'); value.server.endpoint = `http://127.0.0.1:${address.port}`;
      assert.equal((await readNativeSession(value.store, { ...value.options, fetch })).status, 'READ'); assert.equal(calls.length, 2);
    } finally { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); }
  });
});
