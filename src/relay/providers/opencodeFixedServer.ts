import http from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import type { ReconciliationMessage } from './exactSessionReconciliation.ts';

/**
 * Managed, fixed-endpoint OpenCode server client — monitoring and extraction ONLY.
 *
 * ## Scope, deliberately narrow
 *
 * This client READS. It has no method that sends a prompt, a message, or any instruction, and
 * that omission is the architecture, not an oversight: Worker message delivery stays on the
 * visible OpenCode UI/CLI path so the user and RelayX keep operating the SAME session the user
 * can see. Everything here exists so that observing that session does not depend on the Desktop
 * app's sidecar port, which is reassigned per launch and was the reason a Worker turn became
 * unreadable (`shared service is unreachable at http://127.0.0.1:49374`).
 *
 * ## Schema, measured on OpenCode 2.0.21 (not copied from the older Agent Relay client)
 *
 *   user      : { id, type:'user',      text: string, files, time:{created} }
 *   assistant : { id, type:'assistant', content: Part[], finish, time:{created,streamed,completed} }
 *   Part      : { type:'reasoning'|'text'|'tool', text?, name?, state?:{ status } }
 *
 * Two things differ from the older client and are the reason guessing would have failed:
 *   - the role is the top-level `type` field, NOT `info.role`/`role`;
 *   - assistant text lives in `content` parts, while USER text is a top-level `text` string.
 *     There is no `parts` array on this build.
 *
 * `finish` is the run terminator: absent means the run is still going, `tool-calls` means the run
 * CONTINUES (a tool round-trip, not an answer), and `stop`/`error` end it.
 */

export interface OpenCodeFixedServerConfig {
  host?: string;
  port?: number;
  /**
   * Server password. When omitted a random one is generated for the spawned process only: it is
   * passed through the child environment, never written to disk, never logged, and never sent
   * anywhere but loopback.
   */
  password?: string;
  /** Working directory for the spawned server. Must be the Worker session's own directory. */
  sessionDirectory?: string;
  cliPath?: string;
  timeoutMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export interface FixedServerReadiness {
  ready: boolean;
  /** The endpoint that was actually probed, so evidence names it. */
  endpoint: string;
  /** Which check decided it. `/api/health` is 404 on 2.0.21, so this is not assumed. */
  check: string;
  status: number | null;
  startedByUs: boolean;
  reason: string;
}

interface RawMessage {
  id?: string;
  type?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string; name?: string; state?: { status?: string } }>;
  finish?: string | null;
  time?: { created?: number; streamed?: number; completed?: number };
  error?: { message?: string; type?: string; status?: number } | string;
  model?: { id?: string; providerID?: string; variant?: string };
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4096;
const DEFAULT_CLI = '/Users/lazydeepak/.opencode/bin/opencode';

export class OpenCodeFixedServerClient {
  private readonly host: string;
  private readonly port: number;
  private readonly cliPath: string;
  private readonly sessionDirectory: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private password: string | undefined;
  private child: ChildProcess | null = null;
  private lastReadiness: FixedServerReadiness | null = null;

  constructor(config: OpenCodeFixedServerConfig = {}) {
    this.host = config.host ?? process.env.RELAYX_OPENCODE_HOST ?? DEFAULT_HOST;
    this.port = config.port ?? Number(process.env.RELAYX_OPENCODE_PORT ?? DEFAULT_PORT);
    this.cliPath = config.cliPath ?? process.env.RELAYX_OPENCODE_CLI ?? DEFAULT_CLI;
    this.sessionDirectory = config.sessionDirectory;
    this.timeoutMs = config.timeoutMs ?? 8000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.password =
      config.password ?? process.env.RELAYX_OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD;
  }

  get endpoint(): string {
    return `http://${this.host}:${this.port}`;
  }

  get readiness(): FixedServerReadiness | null {
    return this.lastReadiness;
  }

  private authHeader(): string | null {
    if (!this.password) return null;
    return `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body) headers.set('content-type', 'application/json');
    const auth = this.authHeader();
    if (auth) headers.set('authorization', auth);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(new URL(path, this.endpoint), {
        ...init,
        headers,
        signal: controller.signal,
      });
      const text = await res.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Readiness for OpenCode 2.0.21.
   *
   * `/api/health` returns 404 on this build, so it is not used. `/api/session/active` is the
   * smallest endpoint that is simultaneously (a) present, (b) authenticated, and (c) JSON — so
   * a 200 proves the server is up AND that our credentials are accepted, which is the only
   * combination under which monitoring can actually proceed.
   */
  private async probe(): Promise<{ ready: boolean; status: number | null; reason: string }> {
    const check = 'GET /api/session/active';
    try {
      const { status, body } = await this.request('/api/session/active');
      if (status === 200 && body && typeof body === 'object') {
        return { ready: true, status, reason: 'authenticated 200 with JSON body' };
      }
      if (status === 401 || status === 403) {
        return {
          ready: false,
          status,
          reason: `server reachable but rejected our credentials (${status}); it must be started with the same OPENCODE_SERVER_PASSWORD this client holds`,
        };
      }
      return { ready: false, status, reason: `unexpected status ${status} from ${check}` };
    } catch (err) {
      return { ready: false, status: null, reason: `${check} failed: ${(err as Error).message}` };
    }
  }

  /** Start the managed server if it is not already answering. Idempotent. */
  private async startServer(): Promise<string | null> {
    if (!this.password) {
      // Never inherit an unknown password: the spawned server would reject our own reads.
      this.password = crypto.randomBytes(24).toString('base64url');
    }
    return new Promise<string | null>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(
          this.cliPath,
          ['serve', '--hostname', this.host, '--port', String(this.port)],
          {
            cwd: this.sessionDirectory,
            stdio: 'ignore',
            // The password travels to the child through its environment only.
            env: { ...process.env, OPENCODE_SERVER_PASSWORD: this.password },
          },
        );
      } catch (err) {
        resolve(`spawn failed: ${(err as Error).message}`);
        return;
      }
      this.child = child;
      child.once('exit', () => {
        if (this.child === child) this.child = null;
      });
      child.once('error', (err) => resolve(`spawn error: ${err.message}`));
      setTimeout(() => resolve(null), 2000); // resolved properly by the readiness poll
    });
  }

  /**
   * Ensure the managed server is up, starting it if necessary, and return WHY.
   *
   * Readiness evidence is returned rather than thrown so callers can record an unreadable
   * observation instead of guessing. A dead server is never a reason to resend anything.
   */
  async ensureReady(): Promise<FixedServerReadiness> {
    let probe = await this.probe();
    let startedByUs = false;

    if (!probe.ready) {
      const startNote = await this.startServer();
      if (startNote) {
        this.lastReadiness = {
          ready: false,
          endpoint: this.endpoint,
          check: 'GET /api/session/active',
          status: null,
          startedByUs: false,
          reason: startNote,
        };
        return this.lastReadiness;
      }
      startedByUs = true;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        probe = await this.probe();
        if (probe.ready) break;
      }
    }

    this.lastReadiness = {
      ready: probe.ready,
      endpoint: this.endpoint,
      check: 'GET /api/session/active',
      status: probe.status,
      startedByUs,
      reason: probe.reason,
    };
    return this.lastReadiness;
  }

  /** Session existence/metadata for the bound Worker session. */
  async getSession(
    sessionId: string,
  ): Promise<{ ok: boolean; session: Record<string, unknown> | null; reason: string }> {
    const { status, body } = await this.request(`/api/session/${encodeURIComponent(sessionId)}`);
    if (status === 200 && body && typeof body === 'object') {
      const data = (body as { data?: Record<string, unknown> }).data ?? (body as Record<string, unknown>);
      return { ok: true, session: data, reason: 'session present on the fixed server' };
    }
    if (status === 404) return { ok: false, session: null, reason: 'session not present on the fixed server' };
    return { ok: false, session: null, reason: `GET /api/session/{id} -> ${status}` };
  }

  /**
   * Normalise one v2 message into RelayX's reconciliation shape.
   *
   * Role comes from `type`; assistant text from `content` text parts; USER text from the
   * top-level `text` field. Reasoning and tool parts are deliberately excluded from the
   * response body — a tool call is not an answer.
   */
  private normalise(raw: RawMessage): ReconciliationMessage | null {
    const id = raw.id;
    if (!id) return null;
    const type = String(raw.type ?? '');

    let role: ReconciliationMessage['role'];
    if (type === 'user') role = 'user';
    else if (type === 'assistant') role = 'assistant';
    else if (type === 'system') role = 'system';
    else return null; // idle / agent-switched / model-switched rows are not messages

    let text = '';
    if (role === 'user') {
      text = String(raw.text ?? '');
    } else if (role === 'assistant') {
      text = (raw.content ?? [])
        .filter((p) => p?.type === 'text')
        .map((p) => String(p?.text ?? ''))
        .join('');
    } else {
      text = String(raw.text ?? '');
    }

    const toolRunning = (raw.content ?? []).some(
      (p) => p?.type === 'tool' && String(p?.state?.status ?? '') === 'running',
    );

    return {
      messageId: id,
      role,
      createdAt: raw.time?.created,
      completedAt: raw.time?.completed ?? null,
      text,
      // A run with a running tool has no terminator yet, and must not be reported as finished.
      finish: toolRunning ? null : (raw.finish ?? null),
      error:
        typeof raw.error === 'string'
          ? { message: raw.error, type: null, status: null }
          : (raw.error ?? null),
      model: raw.model
        ? { providerID: raw.model.providerID ?? null, modelId: raw.model.id ?? null, variant: raw.model.variant ?? null }
        : null,
    };
  }

  /**
   * Read the bound session's messages, oldest first.
   *
   * `order=asc` is explicit rather than defaulted. The server returns newest-first when `order`
   * is omitted, and with a long-lived session that makes the OLDEST turns — where a dispatched
   * instruction and its boundary live — structurally unreachable.
   */
  async readExactSessionMessages(
    sessionId: string,
    options: { order?: 'asc' | 'desc'; limit?: number } = {},
  ): Promise<{ readable: boolean; messages: ReconciliationMessage[]; reason: string; endpoint: string }> {
    const readiness = this.lastReadiness ?? (await this.ensureReady());
    if (!readiness.ready) {
      return { readable: false, messages: [], reason: readiness.reason, endpoint: this.endpoint };
    }
    const order = options.order ?? 'asc';
    // MEASURED on 2.0.21: the endpoint serves ONE page and hard-caps `limit` at 200 —
    // `limit=500` is answered with HTTP 400. `offset`, `skip` and `before` are all ignored and
    // `/api/session/{id}/history` is 404, so ascending and descending are the only two reachable
    // pages. The clamp is therefore a correctness requirement, not politeness.
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const { status, body } = await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/message?order=${order}&limit=${limit}`,
    );
    if (status !== 200 || !body || typeof body !== 'object') {
      return {
        readable: false,
        messages: [],
        reason: `GET /api/session/{id}/message -> ${status}`,
        endpoint: this.endpoint,
      };
    }
    const rows = (body as { data?: RawMessage[] }).data ?? [];
    const messages = rows
      .map((r) => this.normalise(r))
      .filter((m): m is ReconciliationMessage => m !== null);
    // Guarantee chronological order regardless of what the server did.
    messages.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return { readable: true, messages, reason: `${messages.length} messages via fixed server`, endpoint: this.endpoint };
  }

  /** Whether the session currently has an in-flight run (a tool part still running). */
  async isSessionWorking(sessionId: string): Promise<{ working: boolean; reason: string }> {
    const { status, body } = await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/message?order=desc&limit=1`,
    );
    if (status !== 200 || !body || typeof body !== 'object') {
      return { working: false, reason: `could not read newest message (${status})` };
    }
    const rows = (body as { data?: RawMessage[] }).data ?? [];
    const newest = rows.find((r) => r?.type === 'assistant') ?? rows[0];
    if (!newest) return { working: false, reason: 'no assistant message present' };
    const running = (newest.content ?? []).some(
      (p) => p?.type === 'tool' && String(p?.state?.status ?? '') === 'running',
    );
    const hasTerminal = newest.finish === 'stop' || newest.finish === 'error';
    return {
      working: running || !hasTerminal,
      reason: running
        ? 'newest assistant message has a tool part with state.status=running'
        : hasTerminal
          ? `newest assistant message is terminated (finish=${newest.finish})`
          : 'newest assistant message has no terminal finish',
    };
  }

  /**
   * Establish whether a known boundary message is still inside an observable page.
   *
   * The API exposes only the newest 200 and the oldest 200 messages, with no pagination. On a
   * long-lived session a boundary can therefore age out of BOTH pages. When that happens the
   * honest answer is an explicit overrun, never a correlation guess: a fabricated "close enough"
   * match is how a later turn gets attributed to the wrong instruction.
   */
  async locateBoundary(
    sessionId: string,
    boundaryMessageId: string,
  ): Promise<{
    found: boolean;
    overrun: boolean;
    window: 'ascending' | 'descending' | 'none';
    messages: ReconciliationMessage[];
    reason: string;
  }> {
    const readiness = this.lastReadiness ?? (await this.ensureReady());
    if (!readiness.ready) {
      return { found: false, overrun: false, window: 'none', messages: [], reason: readiness.reason };
    }
    // The boundary of a dispatch is recent, so the descending page is the one that matters; the
    // ascending page is checked too so an old boundary is still found while it is young.
    const desc = await this.readExactSessionMessages(sessionId, { order: 'desc', limit: 200 });
    if (desc.readable && desc.messages.some((m) => m.messageId === boundaryMessageId)) {
      return {
        found: true,
        overrun: false,
        window: 'descending',
        messages: desc.messages,
        reason: 'boundary located in the descending page',
      };
    }
    const asc = await this.readExactSessionMessages(sessionId, { order: 'asc', limit: 200 });
    if (asc.readable && asc.messages.some((m) => m.messageId === boundaryMessageId)) {
      return {
        found: true,
        overrun: false,
        window: 'ascending',
        messages: asc.messages,
        reason: 'boundary located in the ascending page',
      };
    }
    return {
      found: false,
      overrun: true,
      window: 'none',
      messages: desc.readable ? desc.messages : [],
      reason:
        `Boundary message ${boundaryMessageId} is no longer inside an observable page. This ` +
        'OpenCode build serves only the newest 200 and oldest 200 messages and ignores ' +
        'offset/before, so the boundary has aged out of both. Correlation is NOT guessed.',
    };
  }

  /**
   * The question a running Worker turn is blocked on.
   *
   * Reported, never answered. A `question` tool with `state.status === 'running'` means the
   * Worker is waiting for a human, and the only correct resolution is the human answering in the
   * visible session.
   */
  async readPendingQuestion(sessionId: string): Promise<{
    pending: boolean;
    messageId: string | null;
    toolName: string | null;
    questions: unknown[];
    reason: string;
  }> {
    const { status, body } = await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/message?order=desc&limit=1`,
    );
    if (status !== 200 || !body || typeof body !== 'object') {
      return { pending: false, messageId: null, toolName: null, questions: [], reason: `newest message read failed (${status})` };
    }
    const rows = (body as { data?: RawMessage[] }).data ?? [];
    for (const m of rows) {
      for (const p of m?.content ?? []) {
        if (p?.type === 'tool' && String(p?.state?.status ?? '') === 'running') {
          const st = (p as { state?: { input?: { questions?: unknown[] } } }).state;
          return {
            pending: true,
            messageId: m?.id ?? null,
            toolName: p?.name ?? null,
            questions: st?.input?.questions ?? [],
            reason: `newest assistant message has a running tool '${p?.name ?? 'unknown'}'`,
          };
        }
      }
    }
    return { pending: false, messageId: null, toolName: null, questions: [], reason: 'no running tool on the newest message' };
  }

  /** Stop a server this client started. Used on shutdown; never touches a foreign server. */
  async stopManagedServer(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}
