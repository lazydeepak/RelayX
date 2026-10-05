/**
 * OpenCode shared-session client (read/observe only).
 *
 * Relay must operate the *same* persisted `ses_*` records that the human
 * OpenCode UI sees. OpenCode runs a single shared background service per user
 * (registered at `~/.local/state/opencode/service.json`) which owns those
 * records. This module connects to that already-running service over its HTTP
 * API and exposes typed, read-only access.
 *
 * Invariants enforced by construction:
 *   - Never starts a private OpenCode server (`--standalone` is never used).
 *   - Only issues HTTP GET requests. There is deliberately no create/fork/move,
 *     prompt, interrupt or model-switch capability in this client scope.
 *   - Failures are surfaced truthfully (unavailable / malformed metadata /
 *     auth failure / version mismatch / session not found). They are never
 *     silently converted into "no sessions exist".
 *
 * The service password is never included in returned diagnostics.
 */

export const OPENCODE_SERVICE_AUTH_USERNAME = 'opencode';

/* ------------------------------------------------------------------ */
/* Service registration discovery                                      */
/* ------------------------------------------------------------------ */

export interface OpenCodeServiceRegistration {
  id?: string;
  version?: string;
  url: string;
  pid?: number;
  /** Service password. Never echoed back in diagnostics. */
  password: string;
}

export type ServiceDiscoveryFailure =
  | 'service_metadata_missing'
  | 'service_metadata_malformed';

export type ServiceDiscovery =
  | { status: 'available'; registration: OpenCodeServiceRegistration; path: string }
  | { status: 'unavailable'; failure: ServiceDiscoveryFailure; path: string; error: string };

export function defaultServiceFilePath(homeDir?: string): string {
  const home = homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? '';
  return `${home}/.local/state/opencode/service.json`;
}

/**
 * Parse the on-disk service registration. Throws an `OpenCodeServiceError`
 * with code `service_metadata_malformed` when the JSON is invalid or required
 * fields are missing.
 */
export function parseServiceRegistration(raw: string): OpenCodeServiceRegistration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new OpenCodeServiceError(
      'service_metadata_malformed',
      `OpenCode service metadata is not valid JSON: ${err?.message ?? String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OpenCodeServiceError(
      'service_metadata_malformed',
      'OpenCode service metadata must be a JSON object',
    );
  }
  const obj = parsed as Record<string, unknown>;
  const url = typeof obj.url === 'string' ? obj.url.trim() : '';
  const password = typeof obj.password === 'string' ? obj.password : '';
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new OpenCodeServiceError(
      'service_metadata_malformed',
      'OpenCode service metadata is missing a valid http(s) "url"',
    );
  }
  if (!password) {
    throw new OpenCodeServiceError(
      'service_metadata_malformed',
      'OpenCode service metadata is missing a "password"',
    );
  }
  return {
    id: typeof obj.id === 'string' ? obj.id : undefined,
    version: typeof obj.version === 'string' ? obj.version : undefined,
    url,
    pid: typeof obj.pid === 'number' ? obj.pid : undefined,
    password,
  };
}

export interface DiscoverServiceOptions {
  /** Explicit service.json path (defaults to `~/.local/state/opencode/service.json`). */
  serviceFile?: string;
  /** Injectable file reader (primarily for tests). */
  readFile?: (path: string) => string;
  homeDir?: string;
}

/**
 * Resolve the registered shared OpenCode service. Never throws: all failure
 * modes are represented in the returned union so callers cannot mistake an
 * unavailable/misconfigured service for an empty session list.
 */
export async function discoverOpenCodeService(
  options: DiscoverServiceOptions = {},
): Promise<ServiceDiscovery> {
  const path = options.serviceFile ?? defaultServiceFilePath(options.homeDir);

  let raw: string;
  try {
    if (options.readFile) {
      raw = options.readFile(path);
    } else {
      const { readFileSync } = await import('fs');
      raw = readFileSync(path, 'utf8');
    }
  } catch (err: any) {
    return {
      status: 'unavailable',
      failure: 'service_metadata_missing',
      path,
      error: err?.message ?? String(err),
    };
  }

  try {
    return { status: 'available', registration: parseServiceRegistration(raw), path };
  } catch (err: any) {
    return {
      status: 'unavailable',
      failure: 'service_metadata_malformed',
      path,
      error: err?.message ?? String(err),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Typed transport primitives                                          */
/* ------------------------------------------------------------------ */

export type OpenCodeServiceErrorCode =
  | 'service_unavailable'
  | 'authentication_failed'
  | 'session_not_found'
  | 'version_mismatch'
  | 'invalid_response'
  | 'request_failed'
  | 'service_metadata_missing'
  | 'service_metadata_malformed';

export class OpenCodeServiceError extends Error {
  readonly code: OpenCodeServiceErrorCode;
  readonly status?: number;

  constructor(code: OpenCodeServiceErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'OpenCodeServiceError';
    this.code = code;
    this.status = status;
  }
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

export interface OpenCodeSessionModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface OpenCodeSessionSummary {
  sessionId: string;
  projectId?: string;
  directory?: string;
  title?: string;
  agent?: string;
  model?: OpenCodeSessionModelRef;
  outcome?: string;
  createdAt?: number;
  updatedAt?: number;
  idleAt?: number;
  parentSessionId?: string;
  isFork?: boolean;
}

export type OpenCodeActiveState = 'running' | 'idle' | 'unknown';

export interface OpenCodeActiveSession {
  sessionId: string;
  state: OpenCodeActiveState;
}

export interface OpenCodeMessageError {
  type?: string | null;
  message?: string | null;
  status?: number | null;
}

export interface OpenCodeMessageSummary {
  messageId: string;
  type?: string;
  role: 'user' | 'assistant' | 'system' | 'other';
  createdAt?: number;
  completedAt?: number;
  /** Bounded text extract. */
  text?: string;
  /**
   * Provider-reported terminator for an assistant turn (`stop`, `error`, `length`, ...).
   * Additive read-only field. Absent on a turn that has not finished; it is NEVER inferred.
   */
  finish?: string | null;
  /**
   * Provider-reported terminal error on an assistant turn (e.g. `provider.quota`, HTTP 402).
   * Additive read-only field, and the ONLY basis on which a worker execution failure is ever
   * claimed. An absent `error` is never read as success.
   */
  error?: OpenCodeMessageError | null;
  /** The model the provider ACTUALLY used for this turn. Additive read-only field. */
  model?: { providerID?: string | null; modelId?: string | null; variant?: string | null } | null;
  /**
   * Provider run-outcome marker. OpenCode emits `idle` rows carrying
   * `{ outcome: 'failed' | 'success' }` after a run; recorded as corroboration only.
   */
  outcome?: string | null;
}

/** Common read-result envelope: carries service version + mismatch truthfully. */
export interface OpenCodeResultMeta {
  serviceVersion?: string;
  versionMismatch: boolean;
}

export interface ListSessionsResult extends OpenCodeResultMeta {
  directory: string;
  sessions: OpenCodeSessionSummary[];
}

export interface GetSessionResult extends OpenCodeResultMeta {
  session: OpenCodeSessionSummary;
}

export interface ActiveSessionsResult extends OpenCodeResultMeta {
  sessions: OpenCodeActiveSession[];
  byId: Record<string, OpenCodeActiveState>;
}

export interface SessionStatusResult extends OpenCodeResultMeta {
  sessionId: string;
  state: OpenCodeActiveState;
}

export interface ServiceInfoResult extends OpenCodeResultMeta {
  version?: string;
  pid?: number;
  urls: string[];
}

export interface TranscriptResult extends OpenCodeResultMeta {
  sessionId: string;
  messages: OpenCodeMessageSummary[];
  totalMessages: number;
  truncated: boolean;
}

export interface OpenCodeSessionClientConfig {
  baseUrl: string;
  password: string;
  /** Version reported by the service registration (`service.json`). */
  serviceVersion?: string;
  /** Optional version Relay expects; a mismatch is reported, not hidden. */
  expectedVersion?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TEXT_CHARS = 2_000;
const DEFAULT_LIST_LIMIT = 100;
/**
 * HARD provider page size for the message endpoint.
 *
 * The OpenCode shared service IGNORES `limit` and `offset` on
 * `GET /api/session/{id}/message` (observed against live service 2.0.22: any `limit`
 * yields an empty `data` array, and `offset` is a no-op). It always returns exactly one
 * page of at most this many rows, and the page is selected by `order`, not by offset.
 *
 * Consequence, and it is a correctness matter rather than a performance one: the DEFAULT
 * order is newest-first, so for any session longer than one page the earliest messages —
 * which is exactly where a session's first dispatched instruction lives — are NOT in the
 * default window. A dispatch-correlation read must ask for `order: 'asc'`.
 */
const DEFAULT_TRANSCRIPT_LIMIT = 50;

function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined') return undefined;
  const candidate = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof candidate.timeout === 'function') {
    try {
      return candidate.timeout(ms);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Only `order` is a real query parameter on the message endpoint; nothing else is sent. */
function orderQuery(order: 'asc' | 'desc' | undefined): string {
  return order ? `?order=${order}` : '';
}

function roleFromType(type: string | undefined): OpenCodeMessageSummary['role'] {
  switch (type) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
    case 'synthetic':
      return 'system';
    default:
      return 'other';
  }
}

function mapActiveState(type: string | undefined): OpenCodeActiveState {
  if (type === 'running' || type === 'idle') return type;
  return 'unknown';
}

/**
 * Read/observe-only client for the shared OpenCode service.
 *
 * Every method performs an HTTP GET. There is intentionally no mutating
 * capability (no prompt/abort/model/create/fork/move) in this scope.
 */
export class OpenCodeSessionClient {
  readonly baseUrl: string;
  readonly serviceVersion?: string;
  readonly expectedVersion?: string;

  private readonly password: string;
  private readonly fetchImpl?: FetchLike;
  private readonly timeoutMs: number;

  constructor(config: OpenCodeSessionClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.password = config.password;
    this.serviceVersion = config.serviceVersion;
    this.expectedVersion = config.expectedVersion;
    this.fetchImpl = config.fetchImpl;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** True when a caller-supplied expected version differs from the service's. */
  get versionMismatch(): boolean {
    return (
      !!this.expectedVersion &&
      !!this.serviceVersion &&
      this.expectedVersion !== this.serviceVersion
    );
  }

  /* --------------------------- high-level reads --------------------------- */

  async listSessionsByDirectory(
    directory: string,
    options: { limit?: number } = {},
  ): Promise<ListSessionsResult> {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    const query = `?directory=${encodeURIComponent(directory)}&limit=${limit}`;
    const { data, meta } = await this.request('GET', `/api/session${query}`);
    const rows = asRecord(data)?.data;
    if (!Array.isArray(rows)) {
      throw new OpenCodeServiceError(
        'invalid_response',
        'GET /api/session did not return a `data` array',
      );
    }
    return {
      directory,
      sessions: rows.map((row) => this.mapSession(row)),
      ...meta,
    };
  }

  async getSession(sessionId: string): Promise<GetSessionResult> {
    let response: { data: unknown; meta: OpenCodeResultMeta };
    try {
      response = await this.request('GET', `/api/session/${encodeURIComponent(sessionId)}`);
    } catch (err) {
      if (err instanceof OpenCodeServiceError && err.status === 404) {
        throw new OpenCodeServiceError(
          'session_not_found',
          `OpenCode session ${sessionId} was not found on the shared service`,
          404,
        );
      }
      throw err;
    }
    const row = asRecord(response.data)?.data;
    if (!asRecord(row)) {
      throw new OpenCodeServiceError(
        'invalid_response',
        `GET /api/session/${sessionId} did not return a session object`,
      );
    }
    return { session: this.mapSession(row), ...response.meta };
  }

  async getActiveSessions(): Promise<ActiveSessionsResult> {
    const { data, meta } = await this.request('GET', '/api/session/active');
    const rows = asRecord(data)?.data;
    const record = asRecord(rows);
    if (!record) {
      throw new OpenCodeServiceError(
        'invalid_response',
        'GET /api/session/active did not return an object map',
      );
    }
    const sessions: OpenCodeActiveSession[] = Object.entries(record).map(([id, value]) => ({
      sessionId: id,
      state: mapActiveState(asString(asRecord(value)?.type)),
    }));
    const byId: Record<string, OpenCodeActiveState> = {};
    for (const entry of sessions) byId[entry.sessionId] = entry.state;
    return { sessions, byId, ...meta };
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatusResult> {
    const active = await this.getActiveSessions();
    return {
      sessionId,
      state: active.byId[sessionId] ?? 'unknown',
      serviceVersion: active.serviceVersion,
      versionMismatch: active.versionMismatch,
    };
  }

  async getServiceInfo(): Promise<ServiceInfoResult> {
    const { data, meta } = await this.request('GET', '/api/info');
    const info = asRecord(data);
    return {
      version: asString(info?.version),
      pid: asNumber(info?.pid),
      urls: Array.isArray(info?.urls)
        ? (info!.urls as unknown[]).filter((u): u is string => typeof u === 'string')
        : [],
      ...meta,
    };
  }

  /**
   * Bounded read-only transcript (text parts only).
   *
   * `order` selects WHICH page of the session comes back — `'desc'` (default) is the newest
   * page, `'asc'` is the oldest page. See `DEFAULT_TRANSCRIPT_LIMIT`: the provider has no
   * offset, so these two windows are the only two readable, and a caller that must
   * corroborate an early event has to ask for `'asc'` explicitly.
   */
  async getTranscript(
    sessionId: string,
    options: { limit?: number; order?: 'asc' | 'desc' } = {},
  ): Promise<TranscriptResult> {
    return this.readMessages(
      sessionId,
      `/api/session/${encodeURIComponent(sessionId)}/message${orderQuery(options.order)}`,
      options.limit ?? DEFAULT_TRANSCRIPT_LIMIT,
    );
  }

  /** Bounded read-only model context (text parts only). */
  async getContext(
    sessionId: string,
    options: { limit?: number; order?: 'asc' | 'desc' } = {},
  ): Promise<TranscriptResult> {
    return this.readMessages(
      sessionId,
      `/api/session/${encodeURIComponent(sessionId)}/context${orderQuery(options.order)}`,
      options.limit ?? DEFAULT_TRANSCRIPT_LIMIT,
    );
  }

  /* ------------------------------ internals ------------------------------ */

  private async readMessages(
    sessionId: string,
    path: string,
    limit: number,
  ): Promise<TranscriptResult> {
    const { data, meta } = await this.request('GET', path);
    const rows = asRecord(data)?.data;
    if (!Array.isArray(rows)) {
      throw new OpenCodeServiceError(
        'invalid_response',
        `GET ${path} did not return a \`data\` array`,
      );
    }
    const total = rows.length;
    const slice = rows.slice(0, Math.max(0, limit));
    const messages = slice
      .map((row) => this.mapMessage(row))
      .filter((m): m is OpenCodeMessageSummary => m !== undefined);
    // `totalMessages` is the size of the ONE page the provider returned, not the size of the
    // session: the endpoint exposes no session-wide count, so `truncated` can only report that
    // the page itself was cut short, and a caller must NOT read `totalMessages` as
    // "the session has N messages". Reconciliation treats this as a bounded window.
    return {
      sessionId,
      messages,
      totalMessages: total,
      truncated: total > slice.length,
      ...meta,
    };
  }

  private mapSession(raw: unknown): OpenCodeSessionSummary {
    const row = asRecord(raw);
    const id = asString(row?.id);
    if (!row || !id || !id.startsWith('ses_')) {
      throw new OpenCodeServiceError(
        'invalid_response',
        'OpenCode session entry is missing an authoritative `ses_*` id',
      );
    }
    const modelRecord = asRecord(row.model);
    const model = modelRecord
      ? {
          id: asString(modelRecord.id) ?? '',
          providerID: asString(modelRecord.providerID) ?? '',
          variant: asString(modelRecord.variant),
        }
      : undefined;
    const time = asRecord(row.time);
    const location = asRecord(row.location);
    return {
      sessionId: id,
      projectId: asString(row.projectID),
      directory: asString(location?.directory) ?? asString(row.directory),
      title: asString(row.title),
      agent: asString(row.agent),
      model,
      outcome: asString(row.outcome),
      createdAt: asNumber(time?.created),
      updatedAt: asNumber(time?.updated),
      idleAt: asNumber(time?.idle),
      parentSessionId: asString(row.parentID),
      isFork: !!row.fork,
    };
  }

  /**
   * Map one provider message row to the bounded summary shape.
   *
   * ## Why BOTH `row.text` and `row.content[].text` are read
   *
   * The provider returns two different shapes for one endpoint:
   *
   * - a USER turn carries its instruction in a TOP-LEVEL `text` field, and that value is a
   *   JSON-ENCODED string (`"\"Inspect RelayX ...\""`), not the raw instruction;
   * - an ASSISTANT turn carries its reply in `content[]` as `{ type: 'text', text }` parts.
   *
   * Reading only `content[].text` — which is what this mapper did before — silently produced
   * `text: undefined` for EVERY user turn, and therefore every transcript message reported
   * "(none)". That made exact-session instruction fingerprint matching structurally impossible
   * and is the mechanical reason a durably-delivered instruction was once classified as
   * "nothing was delivered".
   *
   * Both are read and merged here. The JSON-encoded form is preserved verbatim: decoding it is
   * a COMPARISON concern and belongs to `normalizeInstructionText`, so that the stored evidence
   * always shows exactly what the provider wrote.
   */
  private mapMessage(raw: unknown): OpenCodeMessageSummary | undefined {
    const row = asRecord(raw);
    const id = asString(row?.id);
    if (!row || !id) return undefined;
    const type = asString(row.type);
    const time = asRecord(row.time);
    const content = Array.isArray(row.content) ? row.content : [];
    const contentText = content
      .map((part) => {
        const p = asRecord(part);
        return p && p.type === 'text' ? asString(p.text) ?? '' : '';
      })
      .filter((t) => t.length > 0)
      .join('\n');
    const topLevelText = asString(row.text);
    const text = (topLevelText ?? contentText).slice(0, MAX_TEXT_CHARS);
    const modelRef = asRecord(row.model);
    const errorRecord = asRecord(row.error);
    return {
      messageId: id,
      type,
      role: roleFromType(type),
      createdAt: asNumber(time?.created),
      completedAt: asNumber(time?.completed),
      text: text || undefined,
      finish: asString(row.finish) ?? null,
      error: errorRecord
        ? {
            type: asString(errorRecord.type) ?? null,
            message: asString(errorRecord.message) ?? null,
            status: asNumber(errorRecord.status) ?? null,
          }
        : null,
      model: modelRef
        ? {
            providerID: asString(modelRef.providerID) ?? null,
            modelId: asString(modelRef.id) ?? null,
            variant: asString(modelRef.variant) ?? null,
          }
        : null,
      outcome: asString(row.outcome) ?? null,
    };
  }

  private authHeader(): string {
    const token = Buffer.from(
      `${OPENCODE_SERVICE_AUTH_USERNAME}:${this.password}`,
      'utf8',
    ).toString('base64');
    return `Basic ${token}`;
  }

  private async request(
    method: string,
    path: string,
  ): Promise<{ data: unknown; meta: OpenCodeResultMeta }> {
    const doFetch =
      this.fetchImpl ??
      (typeof globalThis.fetch === 'function'
        ? (globalThis.fetch as unknown as FetchLike)
        : undefined);
    if (!doFetch) {
      throw new OpenCodeServiceError(
        'service_unavailable',
        'No fetch implementation is available for OpenCode shared service requests',
      );
    }

    const url = `${this.baseUrl}${path}`;
    let res: HttpResponseLike;
    try {
      res = await doFetch(url, {
        method,
        headers: { Authorization: this.authHeader(), Accept: 'application/json' },
        signal: timeoutSignal(this.timeoutMs),
      });
    } catch (err: any) {
      throw new OpenCodeServiceError(
        'service_unavailable',
        `OpenCode shared service is unreachable at ${this.baseUrl}: ${err?.message ?? String(err)}`,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new OpenCodeServiceError(
        'authentication_failed',
        'OpenCode shared service rejected the configured credentials',
        res.status,
      );
    }
    if (res.status >= 500) {
      throw new OpenCodeServiceError(
        'service_unavailable',
        `OpenCode shared service returned ${res.status} for ${path}`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new OpenCodeServiceError(
        'request_failed',
        `OpenCode shared service request failed (${res.status}) for ${path}`,
        res.status,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(await res.text());
    } catch (err: any) {
      throw new OpenCodeServiceError(
        'invalid_response',
        `OpenCode shared service returned invalid JSON for ${path}: ${err?.message ?? String(err)}`,
      );
    }

    return {
      data: json,
      meta: { serviceVersion: this.serviceVersion, versionMismatch: this.versionMismatch },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Convenience discovery + construction                                 */
/* ------------------------------------------------------------------ */

export interface DiscoverClientOptions extends DiscoverServiceOptions {
  expectedVersion?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface DiscoveredSessionClient {
  discovery: ServiceDiscovery;
  client: OpenCodeSessionClient | null;
}

/**
 * Discover the shared service and build a client when metadata is valid.
 * The caller decides how to treat an unavailable/malformed service; this
 * helper never falls back to starting a private server.
 */
export async function discoverOpenCodeSessionClient(
  options: DiscoverClientOptions = {},
): Promise<DiscoveredSessionClient> {
  const discovery = await discoverOpenCodeService(options);
  if (discovery.status !== 'available') {
    return { discovery, client: null };
  }
  const client = new OpenCodeSessionClient({
    baseUrl: discovery.registration.url,
    password: discovery.registration.password,
    serviceVersion: discovery.registration.version,
    expectedVersion: options.expectedVersion,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  return { discovery, client };
}
