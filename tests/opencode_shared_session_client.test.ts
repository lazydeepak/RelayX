import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OpenCodeSessionClient,
  OpenCodeServiceError,
  discoverOpenCodeService,
  discoverOpenCodeSessionClient,
  parseServiceRegistration,
  type FetchLike,
} from '../src/relay/providers/opencodeSessionClient.ts';
import { OpenCodeProvider } from '../src/relay/providers/adapters.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';

/* ------------------------------------------------------------------ */
/* HTTP fixture harness (no live service is ever contacted)            */
/* ------------------------------------------------------------------ */

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

interface CannedResponse {
  status?: number;
  body?: unknown;
  rawBody?: string;
  throw?: boolean;
}

function makeFetch(handler: (req: RecordedRequest) => CannedResponse) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const req: RecordedRequest = { method: init.method, url, headers: init.headers };
    requests.push(req);
    const res = handler(req);
    if (res.throw) throw new Error('ECONNREFUSED');
    const status = res.status ?? 200;
    const text = res.rawBody !== undefined ? res.rawBody : JSON.stringify(res.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    };
  };
  return { fetchImpl, requests };
}

const SERVICE_URL = 'http://127.0.0.1:49374';

function makeClient(fetchImpl: FetchLike, overrides: Partial<{ password: string; serviceVersion: string; expectedVersion: string }> = {}) {
  return new OpenCodeSessionClient({
    baseUrl: SERVICE_URL,
    password: overrides.password ?? 'secret-pw',
    serviceVersion: overrides.serviceVersion,
    expectedVersion: overrides.expectedVersion,
    fetchImpl,
  });
}

/* ------------------------------------------------------------------ */
/* Service metadata parsing + discovery                                */
/* ------------------------------------------------------------------ */

describe('OpenCode shared service discovery', () => {
  it('parses a valid service registration', () => {
    const reg = parseServiceRegistration(
      JSON.stringify({
        id: 'svc_1',
        version: '2.0.12',
        url: SERVICE_URL,
        pid: 21660,
        password: 'pw-123',
      }),
    );
    assert.equal(reg.url, SERVICE_URL);
    assert.equal(reg.password, 'pw-123');
    assert.equal(reg.version, '2.0.12');
    assert.equal(reg.pid, 21660);
  });

  it('reports malformed metadata truthfully (invalid JSON)', async () => {
    const discovery = await discoverOpenCodeService({
      serviceFile: '/tmp/relay-nonexistent/service.json',
      readFile: () => '{ not valid json',
    });
    assert.equal(discovery.status, 'unavailable');
    if (discovery.status === 'unavailable') {
      assert.equal(discovery.failure, 'service_metadata_malformed');
    }
  });

  it('reports malformed metadata truthfully (missing url/password)', () => {
    assert.throws(
      () => parseServiceRegistration(JSON.stringify({ version: '2.0.12' })),
      (err: unknown) =>
        err instanceof OpenCodeServiceError && err.code === 'service_metadata_malformed',
    );
    assert.throws(
      () => parseServiceRegistration(JSON.stringify({ url: SERVICE_URL })),
      (err: unknown) =>
        err instanceof OpenCodeServiceError && err.code === 'service_metadata_malformed',
    );
  });

  it('reports a missing service registration truthfully (not "no sessions")', async () => {
    const discovery = await discoverOpenCodeService({
      serviceFile: '/tmp/relay-nonexistent/service.json',
      readFile: () => {
        const err: any = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      },
    });
    assert.equal(discovery.status, 'unavailable');
    if (discovery.status === 'unavailable') {
      assert.equal(discovery.failure, 'service_metadata_missing');
    }
  });

  it('builds an authenticated client only from valid metadata', async () => {
    const ok = await discoverOpenCodeSessionClient({
      serviceFile: '/x/service.json',
      readFile: () => JSON.stringify({ url: SERVICE_URL, password: 'pw', version: '2.0.12' }),
    });
    assert.equal(ok.discovery.status, 'available');
    assert.ok(ok.client);

    const bad = await discoverOpenCodeSessionClient({
      serviceFile: '/x/service.json',
      readFile: () => 'nonsense',
    });
    assert.equal(bad.discovery.status, 'unavailable');
    assert.equal(bad.client, null);
  });
});

/* ------------------------------------------------------------------ */
/* Client transport, auth and read capabilities                        */
/* ------------------------------------------------------------------ */

describe('OpenCodeSessionClient read-only capabilities', () => {
  it('authenticates with HTTP Basic opencode:<password>', async () => {
    const { fetchImpl, requests } = makeFetch(() => ({ body: { data: [] } }));
    const client = makeClient(fetchImpl, { password: 'top-secret' });
    await client.listSessionsByDirectory('/Users/relay/alpha');

    assert.equal(requests.length, 1);
    const expected = 'Basic ' + Buffer.from('opencode:top-secret', 'utf8').toString('base64');
    assert.equal(requests[0].headers.Authorization, expected);
  });

  it('lists sessions via a directory-scoped query and returns typed results', async () => {
    const { fetchImpl, requests } = makeFetch((req) => {
      assert.match(req.url, /\/api\/session\?directory=/);
      return {
        body: {
          data: [
            {
              id: 'ses_alpha_1',
              projectID: 'proj_alpha',
              agent: 'build',
              model: { id: 'big-pickle', providerID: 'opencode', variant: 'default' },
              title: 'Alpha work',
              outcome: 'idle',
              location: { directory: '/Users/relay/alpha' },
              time: { created: 1000, updated: 2000, idle: 2500 },
            },
            {
              id: 'ses_alpha_2',
              projectID: 'proj_alpha',
              location: { directory: '/Users/relay/alpha' },
            },
          ],
        },
      };
    });

    const client = makeClient(fetchImpl, { serviceVersion: '2.0.12' });
    const res = await client.listSessionsByDirectory('/Users/relay/alpha');

    assert.equal(requests[0].url, `${SERVICE_URL}/api/session?directory=${encodeURIComponent('/Users/relay/alpha')}&limit=100`);
    assert.equal(res.sessions.length, 2);
    assert.equal(res.sessions[0].sessionId, 'ses_alpha_1');
    assert.equal(res.sessions[0].projectId, 'proj_alpha');
    assert.equal(res.sessions[0].directory, '/Users/relay/alpha');
    assert.equal(res.sessions[0].model?.providerID, 'opencode');
    assert.equal(res.sessions[0].createdAt, 1000);
    assert.equal(res.sessions[1].sessionId, 'ses_alpha_2');
    assert.equal(res.serviceVersion, '2.0.12');
    assert.equal(res.versionMismatch, false);
  });

  it('retrieves an exact ses_* session by id', async () => {
    const { fetchImpl, requests } = makeFetch((req) => {
      assert.equal(req.url, `${SERVICE_URL}/api/session/ses_exact_1`);
      return {
        body: {
          data: {
            id: 'ses_exact_1',
            projectID: 'proj_x',
            title: 'Exact',
            location: { directory: '/Users/relay/x' },
          },
        },
      };
    });

    const client = makeClient(fetchImpl);
    const res = await client.getSession('ses_exact_1');
    assert.equal(res.session.sessionId, 'ses_exact_1');
    assert.equal(res.session.title, 'Exact');
    assert.equal(requests[0].method, 'GET');
  });

  it('surfaces session_not_found on 404 instead of an empty result', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 404, body: { error: 'not found' } }));
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.getSession('ses_missing'),
      (err: unknown) => err instanceof OpenCodeServiceError && err.code === 'session_not_found',
    );
  });

  it('surfaces service_unavailable when the service cannot be reached', async () => {
    const { fetchImpl } = makeFetch(() => ({ throw: true }));
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.listSessionsByDirectory('/Users/relay/alpha'),
      (err: unknown) => err instanceof OpenCodeServiceError && err.code === 'service_unavailable',
    );
  });

  it('surfaces authentication_failed on 401', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 401, body: {} }));
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.listSessionsByDirectory('/Users/relay/alpha'),
      (err: unknown) => err instanceof OpenCodeServiceError && err.code === 'authentication_failed',
    );
  });

  it('maps active sessions to running / idle / unknown truthfully', async () => {
    const { fetchImpl } = makeFetch(() => ({
      body: {
        data: {
          ses_a: { type: 'running' },
          ses_b: { type: 'idle' },
          ses_c: { type: 'something-else' },
        },
      },
    }));
    const client = makeClient(fetchImpl);
    const active = await client.getActiveSessions();
    assert.deepEqual(active.byId, {
      ses_a: 'running',
      ses_b: 'idle',
      ses_c: 'unknown',
    });

    const statusA = await client.getSessionStatus('ses_a');
    assert.equal(statusA.state, 'running');
    const statusUnknown = await client.getSessionStatus('ses_not_present');
    assert.equal(statusUnknown.state, 'unknown');
  });

  it('reports a service version mismatch without hiding it', async () => {
    const { fetchImpl } = makeFetch(() => ({ body: { data: [] } }));
    const mismatched = makeClient(fetchImpl, { serviceVersion: '2.0.12', expectedVersion: '2.0.10' });
    assert.equal(mismatched.versionMismatch, true);
    const res = await mismatched.listSessionsByDirectory('/Users/relay/alpha');
    assert.equal(res.versionMismatch, true);
    assert.equal(res.serviceVersion, '2.0.12');

    const matched = makeClient(fetchImpl, { serviceVersion: '2.0.12', expectedVersion: '2.0.12' });
    assert.equal(matched.versionMismatch, false);
  });

  it('provides bounded read-only transcript/context access', async () => {
    const { fetchImpl, requests } = makeFetch(() => ({
      body: {
        data: [
          { id: 'msg_1', type: 'user', content: [{ type: 'text', text: 'hello' }], time: { created: 1 } },
          { id: 'msg_2', type: 'assistant', content: [{ type: 'text', text: 'hi there' }], time: { created: 2 } },
          { id: 'msg_3', type: 'assistant', content: [{ type: 'text', text: 'third' }], time: { created: 3 } },
        ],
      },
    }));
    const client = makeClient(fetchImpl);
    const transcript = await client.getTranscript('ses_x', { limit: 2 });
    assert.equal(transcript.messages.length, 2);
    assert.equal(transcript.totalMessages, 3);
    assert.equal(transcript.truncated, true);
    assert.equal(transcript.messages[0].role, 'user');
    assert.equal(transcript.messages[1].text, 'hi there');
    assert.match(requests[0].url, /\/api\/session\/ses_x\/message$/);
  });

  it('exposes no session-create/fork/move or prompt/abort/model capability', () => {
    const { fetchImpl } = makeFetch(() => ({ body: { data: [] } }));
    const client: any = makeClient(fetchImpl);
    for (const forbidden of [
      'createSession',
      'forkSession',
      'moveSession',
      'prompt',
      'interrupt',
      'abort',
      'switchModel',
      'deleteSession',
    ]) {
      assert.equal(client[forbidden], undefined, `${forbidden} must not exist in this read-only scope`);
    }
  });

  it('issues only GET requests across all read operations', async () => {
    const { fetchImpl, requests } = makeFetch((req) => {
      if (req.url.endsWith('/api/info')) return { body: { version: '2.0.12', pid: 1, urls: [SERVICE_URL] } };
      if (req.url.includes('/api/session/active')) return { body: { data: {} } };
      if (req.url.includes('/api/session/ses_read/message')) return { body: { data: [] } };
      if (req.url.endsWith('/api/session/ses_read')) {
        return { body: { data: { id: 'ses_read', location: { directory: '/Users/relay/alpha' } } } };
      }
      return { body: { data: [] } };
    });
    const client = makeClient(fetchImpl);
    await client.listSessionsByDirectory('/Users/relay/alpha');
    await client.getSession('ses_read');
    await client.getActiveSessions();
    await client.getServiceInfo();
    await client.getTranscript('ses_read');
    assert.ok(requests.length >= 5);
    assert.ok(requests.every((r) => r.method === 'GET'), 'all requests must be GET');
  });
});

/* ------------------------------------------------------------------ */
/* Provider + service layer integration                                */
/* ------------------------------------------------------------------ */

class ServiceBackedProvider extends OpenCodeProvider {
  public runtimes: any[] = [];
  public cliCalled = false;

  constructor(private readonly client: OpenCodeSessionClient) {
    super();
  }

  protected override async resolveSharedServiceClient() {
    return {
      discovery: {
        status: 'available' as const,
        registration: { url: this.client.baseUrl, password: 'pw', version: '2.0.12' },
        path: '/x/service.json',
      },
      client: this.client,
    };
  }

  public override async findAllRuntimes() {
    return this.runtimes;
  }

  public override async discoverPersistedSessions() {
    this.cliCalled = true;
    return { success: true, sessions: [] };
  }
}

describe('OpenCode provider shared-service discovery integration', () => {
  it('prefers directory-scoped shared-service sessions and binds the exact ses_*', async () => {
    const { fetchImpl } = makeFetch(() => ({
      body: {
        data: [
          { id: 'ses_service_authoritative', projectID: 'proj_relay', location: { directory: '/Users/relay/alpha' } },
        ],
      },
    }));
    const provider = new ServiceBackedProvider(makeClient(fetchImpl));
    const res = await provider.matchSessionsByPath('/Users/relay/alpha');

    assert.equal(res.success, true);
    assert.equal(res.sessions.length, 1);
    assert.equal((res.sessions[0].evidence.details as any).authoritativeSessionId, 'ses_service_authoritative');
    assert.equal(res.diagnostics.source, 'opencode_shared_service');
    // Shared service is authoritative, so the CLI fallback is never consulted.
    assert.equal(provider.cliCalled, false);
  });

  it('represents a genuinely empty project cleanly without falling back to CLI/UI', async () => {
    const { fetchImpl } = makeFetch(() => ({ body: { data: [] } }));
    const provider = new ServiceBackedProvider(makeClient(fetchImpl));
    const res = await provider.matchSessionsByPath('/Users/relay/alpha');

    assert.equal(res.success, true);
    assert.equal(res.sessions.length, 0);
    assert.equal(res.diagnostics.source, 'opencode_shared_service');
    assert.equal(provider.cliCalled, false);
  });

  it('preserves multiple project sessions from the shared service', async () => {
    const { fetchImpl } = makeFetch(() => ({
      body: {
        data: [
          { id: 'ses_a', location: { directory: '/Users/relay/alpha' } },
          { id: 'ses_b', location: { directory: '/Users/relay/alpha' } },
        ],
      },
    }));
    const provider = new ServiceBackedProvider(makeClient(fetchImpl));
    const res = await provider.matchSessionsByPath('/Users/relay/alpha');
    assert.equal(res.sessions.length, 2);
    const ids = res.sessions
      .map((s) => (s.evidence.details as any).authoritativeSessionId)
      .sort();
    assert.deepEqual(ids, ['ses_a', 'ses_b']);
  });

  it('falls back to CLI when the shared service is unavailable', async () => {
    class FallbackProvider extends OpenCodeProvider {
      protected override async resolveSharedServiceClient() {
        return {
          discovery: {
            status: 'unavailable' as const,
            failure: 'service_metadata_missing' as const,
            path: '/x/service.json',
            error: 'ENOENT',
          },
          client: null,
        };
      }
      public override async findAllRuntimes() {
        return [];
      }
      public override async discoverPersistedSessions() {
        return {
          success: true,
          sessions: [{ id: 'ses_cli_fallback', directory: '/Users/relay/alpha' }],
        };
      }
    }

    const res = await new FallbackProvider().matchSessionsByPath('/Users/relay/alpha');
    assert.equal(res.sessions.length, 1);
    assert.equal((res.sessions[0].evidence.details as any).authoritativeSessionId, 'ses_cli_fallback');
    assert.equal(res.diagnostics.source, 'opencode session list --format json');
    assert.equal(res.diagnostics.sharedService.failure, 'service_metadata_missing');
  });

  it('never lets a window title manufacture an authoritative session binding', async () => {
    class UiOnlyProvider extends OpenCodeProvider {
      protected override async resolveSharedServiceClient() {
        return {
          discovery: {
            status: 'unavailable' as const,
            failure: 'service_metadata_missing' as const,
            path: '/x/service.json',
            error: 'ENOENT',
          },
          client: null,
        };
      }
      public override async findAllRuntimes() {
        return [
          {
            found: true,
            status: 'available' as const,
            windowTitle: 'OpenCode — [ses_ui_guess] /Users/relay/alpha',
            applicationPid: 999,
            bundleIdentifier: 'dev.opencode.desktop',
            composerVisible: true,
            composerHasFocus: true,
            sendButtonVisible: true,
            stopButtonVisible: false,
            cancelButtonVisible: false,
            isWorking: false,
            isComplete: false,
            evidence: {
              id: 'ev_ui',
              timestamp: Date.now(),
              source: 'macos_system_events' as const,
              windowTitle: 'OpenCode — [ses_ui_guess] /Users/relay/alpha',
              details: {},
            },
          },
        ];
      }
      public override async discoverPersistedSessions() {
        return { success: true, sessions: [] };
      }
    }

    const provider = new UiOnlyProvider();
    const res = await provider.matchSessionsByPath('/Users/relay/alpha');

    // The window candidate is retained as non-authoritative evidence only.
    assert.equal(res.diagnostics.source, 'ui_fallback');
    assert.equal(res.sessions.length, 1);
    const details = res.sessions[0].evidence.details as any;
    assert.equal(details.authoritativeSessionId, undefined);
    assert.equal(details.parsedSessionId, undefined);
    assert.equal(details.observedWindowSessionId, 'ses_ui_guess');
    assert.equal(details.authoritative, false);

    // Through the service layer: the window-only candidate yields no binding.
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    engine.registerProvider(provider);
    const api = new RelayApiService(db, engine);
    const apiRes = await api.discoverOpenCodeSessions('/Users/relay/alpha');
    assert.equal(apiRes.success, true);
    assert.equal(apiRes.sessions.length, 1);
    assert.equal(apiRes.sessions[0].sessionId, undefined);
    assert.equal(apiRes.sessions[0].authoritative, false);
    assert.equal(apiRes.sessions[0].observedWindowSessionId, 'ses_ui_guess');
  });
});
