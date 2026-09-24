/**
 * Pure presentation view-models for the Project and Session detail surfaces.
 *
 * These builders derive display-ready state from data the renderer already
 * receives (projects, pairs, sessions, assignments, events, attention items).
 * They contain no React and no I/O so the rendering rules and empty states can
 * be unit-tested without a DOM.
 */
import type {
  UIProject,
  UIPair,
  UIRuntimeSession,
  UIAssignment,
  UIEvent,
  UIAttentionItem,
  ObservableEvidence,
} from '../types/ui.ts';

export const EMPTY_TEXT = {
  notAvailable: 'Not available',
  notBound: 'Not bound',
} as const;

export type BindingRole = 'planner' | 'worker';

/** A single labelled, human-readable field with an honest empty state. */
export interface DetailField {
  label: string;
  value: string;
  state: 'value' | 'empty';
  mono?: boolean;
  copyable?: boolean;
}

export interface DetailFieldOptions {
  mono?: boolean;
  copyable?: boolean;
  emptyText?: string;
}

export function detailField(
  label: string,
  raw: unknown,
  options: DetailFieldOptions = {},
): DetailField {
  const value =
    typeof raw === 'string'
      ? raw.trim()
      : raw === undefined || raw === null
        ? ''
        : String(raw);
  const present = value.length > 0;
  return {
    label,
    value: present ? value : (options.emptyText ?? EMPTY_TEXT.notAvailable),
    state: present ? 'value' : 'empty',
    mono: options.mono,
    copyable: present ? (options.copyable ?? false) : false,
  };
}

/* --- Provider identity extraction (truthful, from recorded evidence) --- */

export interface SessionIdentity {
  externalSessionId?: string;
  workspacePath?: string;
  openCodeProjectId?: string;
  projectUrl?: string;
}

function readEvidenceDetails(session: UIRuntimeSession): Record<string, unknown> {
  const details = session.lastEvidence?.details;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Reads the provider-side identifiers out of the recorded observation evidence.
 * Only known keys are surfaced; anything absent is reported as unavailable.
 */
export function extractSessionIdentity(session: UIRuntimeSession): SessionIdentity {
  const details = readEvidenceDetails(session);
  return {
    externalSessionId: firstString(details, [
      'sessionId',
      'parsedSessionId',
      'authoritativeSessionId',
      'externalSessionId',
    ]),
    workspacePath: firstString(details, ['workspacePath']),
    openCodeProjectId: firstString(details, ['openCodeProjectId']),
    projectUrl: firstString(details, ['projectUrl']),
  };
}

/* --- Saved-vs-discovered binding model ---
 *
 * A binding side (planner/worker) carries two independent facts:
 *   1. SAVED — the identity persisted when the binding was established
 *      (project.plannerProjectUrl/workerWorkspacePath, or the runtime's
 *      externalSessionId/externalProjectRef). This is the source of truth the
 *      app acts on and must NEVER be erased by a later discovery failure.
 *   2. DISCOVERED — the latest identity recorded in observation evidence.
 *      It may be authoritative (verified against a shared service / URL bar),
 *      binding-recorded, or a display-only window/title parse that the current
 *      implementation cannot verify.
 * The verification status compares the two and marks facts we cannot verify.
 */

/** Normalizes a ChatGPT project reference to its bare `g-p-…` slug (mirrors RelayApiService). */
function normalizeChatSlug(ref: string | null | undefined): string {
  if (!ref) return '';
  const match = String(ref).match(/(?:^|\/g\/)(g-p-[^/?#]+)/i);
  return (match?.[1] ?? String(ref)).replace(/\/$/, '').toLowerCase();
}

/** Normalizes a workspace path reference (mirrors RelayApiService). */
function normalizeWorkspacePath(ref: string | null | undefined): string {
  if (!ref) return '';
  return String(ref).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

export interface SavedBinding {
  /** Persisted reference value (planner project URL, worker workspace path, or session id). */
  value: string;
  kind: 'project_url' | 'workspace_path' | 'session_id';
  /** Where the value was persisted. */
  source: 'project' | 'runtime';
  savedAt?: number;
}

export interface DiscoveredIdentity {
  /** The identity value observed in the latest evidence. */
  reference?: string;
  kind: 'project_url' | 'workspace_path' | 'session_id';
  sessionId?: string;
  sessionIdSource?: 'authoritative' | 'external' | 'binding' | 'parsed';
  /** True only when the observed session id was verified authoritatively. */
  sessionIdVerified: boolean;
  projectUrl?: string;
  workspacePath?: string;
  openCodeProjectId?: string;
  /** Window/title-derived id the current implementation cannot verify. */
  displayOnly?: boolean;
  /** Multiple window-derived ids were observed and disagreed. */
  ambiguous?: boolean;
  /** Inspection recorded an identity conflict; the persisted binding was retained. */
  conflict?: boolean;
  /** True when this discovery is the binding-origin evidence written at setup (not independent verification). */
  bindingRecorded?: boolean;
  observedAt?: number;
}

export type BindingVerificationStatus =
  | 'verified' // saved binding matches the latest discovered identity
  | 'mismatch' // saved binding differs from the latest discovered identity
  | 'unverified' // an identity was observed but cannot be trusted/confirmed
  | 'stale' // saved binding retained; latest discovery could not reverify it
  | 'ambiguous' // discovery produced multiple, disagreeing identities
  | 'unavailable'; // no saved binding and no discovered identity

export interface BindingVerification {
  status: BindingVerificationStatus;
  note?: string;
}

function latestTimestamp(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((v): v is number => typeof v === 'number');
  if (defined.length === 0) return undefined;
  return Math.max(...defined);
}

function sortByRecency<T>(items: T[], pick: (item: T) => number | undefined): T[] {
  return [...items].sort((a, b) => (pick(b) ?? 0) - (pick(a) ?? 0));
}

/* --- Project detail --- */

export interface ProjectBindingSide {
  role: BindingRole;
  bound: boolean;
  provider?: string;
  sessionId?: string;
  sessionName?: string;
  runtimeStatus?: string;
  /** Provider-side reference (external session id or planner project URL) from latest evidence. */
  reference?: string;
  /** Persisted (saved) binding for this side, if any. Never cleared by discovery failures. */
  savedBinding?: SavedBinding;
  /** Latest discovered identity from recorded observation evidence, if any. */
  discovered?: DiscoveredIdentity;
  verification: BindingVerification;
}

export interface ProjectPairBinding {
  pairId: string;
  pairName: string;
  status: UIPair['status'];
  archived: boolean;
  planner: ProjectBindingSide;
  worker: ProjectBindingSide;
}

/** An active planner/worker runtime session bound to the project, as a child record. */
export interface ProjectChildSession {
  sessionId: string;
  role: BindingRole;
  sessionName: string;
  provider: string;
  runtimeStatus: string;
  pairId: string;
  pairName: string;
  savedBinding?: SavedBinding;
  discovered?: DiscoveredIdentity;
  verification: BindingVerification;
}

export interface ProjectDetailViewModel {
  id: string;
  name: string;
  description: string;
  status: UIProject['status'];
  repository: {
    canonicalPath: DetailField;
    gitRoot: DetailField;
  };
  /** Project-level saved bindings persisted at setup time (planner URL / worker workspace). */
  savedBindings: {
    planner?: SavedBinding;
    worker?: SavedBinding;
  };
  bindings: ProjectPairBinding[];
  /** Active planner/worker sessions bound to this project (deduplicated). */
  sessions: ProjectChildSession[];
  work: {
    active: UIAssignment[];
    recentCompleted: UIAssignment[];
    attention: UIAttentionItem[];
  };
  activity: {
    lastActivityAt?: number;
    recentEvents: UIEvent[];
  };
  metadata: {
    createdAt?: number;
    updatedAt?: number;
  };
}

export interface ProjectDetailInput {
  projectId: string;
  projects: UIProject[];
  pairs: UIPair[];
  sessions: UIRuntimeSession[];
  assignments: UIAssignment[];
  events: UIEvent[];
  attentionItems: UIAttentionItem[];
}

export function selectProjectDetail(input: ProjectDetailInput): ProjectDetailViewModel | null {
  const project = input.projects.find((p) => p.id === input.projectId);
  if (!project) return null;
  return buildProjectDetail(project, input);
}

export function buildProjectDetail(
  project: UIProject,
  input: Omit<ProjectDetailInput, 'projectId'>,
): ProjectDetailViewModel {
  const projectPairs = input.pairs.filter((pair) => pair.projectId === project.id);
  const projectPairIds = new Set(projectPairs.map((pair) => pair.id));
  const projectAssignments = input.assignments.filter((a) => a.projectId === project.id);
  const projectAssignmentIds = new Set(projectAssignments.map((a) => a.id));

  const bindings = projectPairs.map((pair) => buildPairBinding(pair, input.sessions, project));
  const sessions = buildChildSessions(project, projectPairs, input.sessions);

  const activeWork = sortByRecency(
    projectAssignments.filter(
      (a) => a.status === 'active' || a.status === 'pending' || a.status === 'waiting_for_handoff',
    ),
    (a) => a.createdAt,
  );

  const recentCompleted = sortByRecency(
    projectAssignments.filter(
      (a) => a.status === 'completed' || a.status === 'failed' || a.status === 'cancelled',
    ),
    (a) => a.completedAt ?? a.createdAt,
  ).slice(0, 5);

  const attention = input.attentionItems.filter(
    (item) =>
      (item.pairId !== undefined && projectPairIds.has(item.pairId)) ||
      (item.assignmentId !== undefined && projectAssignmentIds.has(item.assignmentId)),
  );

  const recentEvents = sortByRecency(
    input.events.filter(
      (event) =>
        event.resourceId === project.id ||
        projectPairIds.has(event.resourceId) ||
        projectAssignmentIds.has(event.resourceId),
    ),
    (event) => event.timestamp,
  ).slice(0, 8);

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    repository: {
      canonicalPath: detailField('Canonical Path', project.canonicalPath, {
        mono: true,
        copyable: true,
      }),
      gitRoot: detailField('Git Root', project.gitRoot, { mono: true, copyable: true }),
    },
    savedBindings: buildProjectSavedBindings(project),
    bindings,
    sessions,
    work: {
      active: activeWork,
      recentCompleted,
      attention,
    },
    activity: {
      lastActivityAt: latestTimestamp([
        project.updatedAt,
        ...recentEvents.map((event) => event.timestamp),
        ...projectPairs.map((pair) => pair.lastSupervisedAt),
      ]),
      recentEvents,
    },
    metadata: {
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
  };
}

function buildPairBinding(
  pair: UIPair,
  sessions: UIRuntimeSession[],
  project: UIProject,
): ProjectPairBinding {
  const plannerSession = pair.plannerSessionId
    ? sessions.find((s) => s.id === pair.plannerSessionId)
    : undefined;
  const workerSession = pair.workerSessionId
    ? sessions.find((s) => s.id === pair.workerSessionId)
    : undefined;

  return {
    pairId: pair.id,
    pairName: pair.name,
    status: pair.status,
    archived: pair.status === 'archived',
    planner: buildBindingSide('planner', pair, plannerSession, project),
    worker: buildBindingSide('worker', pair, workerSession, project),
  };
}

function buildBindingSide(
  role: BindingRole,
  pair: UIPair,
  session: UIRuntimeSession | undefined,
  project: UIProject,
): ProjectBindingSide {
  const sessionId = role === 'planner' ? pair.plannerSessionId : pair.workerSessionId;
  const bound = Boolean(sessionId);
  const identity = session ? extractSessionIdentity(session) : {};
  const fallbackProvider = role === 'planner' ? pair.plannerProvider : pair.workerProvider;
  const fallbackName = role === 'planner' ? pair.plannerName : pair.workerName;
  const fallbackStatus = role === 'planner' ? pair.plannerStatus : pair.workerStatus;

  const savedBinding = buildSavedBinding(role, session, project);
  const discovered = session ? extractDiscoveredIdentity(session, role) : undefined;
  const verification = buildVerification(role, bound, savedBinding, discovered, session);

  return {
    role,
    bound,
    provider: bound ? (session?.providerType ?? fallbackProvider) : undefined,
    sessionId,
    sessionName: bound ? (session?.name ?? fallbackName) : undefined,
    runtimeStatus: bound ? (session?.status ?? fallbackStatus) : undefined,
    reference: identity.externalSessionId ?? identity.projectUrl,
    savedBinding,
    discovered,
    verification,
  };
}

/** Project-level persisted bindings (planner project URL / worker workspace path). */
function buildProjectSavedBindings(project: UIProject): ProjectDetailViewModel['savedBindings'] {
  const plannerUrl = project.plannerProjectUrl?.trim();
  const workerPath = project.workerWorkspacePath?.trim();
  return {
    planner: plannerUrl
      ? { value: plannerUrl, kind: 'project_url', source: 'project', savedAt: project.updatedAt }
      : undefined,
    worker: workerPath
      ? { value: workerPath, kind: 'workspace_path', source: 'project', savedAt: project.updatedAt }
      : undefined,
  };
}

/**
 * Builds the persisted (saved) binding for a side. Project-level fields are
 * preferred; the runtime's persisted external identity is the fallback so
 * pre-existing projects without project-level binding fields stay truthful.
 */
function buildSavedBinding(
  role: BindingRole,
  session: UIRuntimeSession | undefined,
  project: UIProject,
): SavedBinding | undefined {
  if (role === 'planner') {
    const projectUrl = project.plannerProjectUrl?.trim();
    if (projectUrl) {
      return { value: projectUrl, kind: 'project_url', source: 'project', savedAt: project.updatedAt };
    }
    const externalRef = session?.externalProjectRef?.trim();
    if (externalRef) {
      return { value: externalRef, kind: 'project_url', source: 'runtime', savedAt: session?.updatedAt };
    }
    return undefined;
  }
  // worker
  const workspacePath = project.workerWorkspacePath?.trim();
  if (workspacePath) {
    return {
      value: workspacePath,
      kind: 'workspace_path',
      source: 'project',
      savedAt: project.updatedAt,
    };
  }
  const externalRef = session?.externalProjectRef?.trim();
  if (externalRef) {
    return { value: externalRef, kind: 'workspace_path', source: 'runtime', savedAt: session?.updatedAt };
  }
  const externalSessionId = session?.externalSessionId?.trim();
  if (externalSessionId) {
    return { value: externalSessionId, kind: 'session_id', source: 'runtime', savedAt: session?.updatedAt };
  }
  return undefined;
}

/**
 * Reads the provider-side identity out of the latest observation evidence,
 * keeping the AUTHORITY of each fact separate from its value:
 *  - planner: the project URL is authoritative (read from the browser URL bar).
 *  - worker: only an authoritativeSessionId (proven via the shared OpenCode
 *    service or a persisted session record) is verified. parsedSessionId and
 *    observedWindowSessionId are display-only parses the current implementation
 *    cannot verify. A binding-recorded `sessionId` is verified only when it
 *    matches the runtime's persisted external id.
 */
function extractDiscoveredIdentity(
  session: UIRuntimeSession,
  role: BindingRole,
): DiscoveredIdentity | undefined {
  const details = readEvidenceDetails(session);
  const observedAt = session.lastEvidence?.timestamp ?? session.lastObservedAt;
  const conflict = details.identityConflict === true;

  const projectUrl = firstString(details, ['projectUrl', 'finalUrl']);
  const workspacePath = firstString(details, ['workspacePath']);
  const openCodeProjectId = firstString(details, ['openCodeProjectId']);
  const observedWindowId = firstString(details, ['observedWindowSessionId']);
  const authoritativeId = firstString(details, ['authoritativeSessionId']);
  const externalId = firstString(details, ['externalSessionId']);
  const bindId = firstString(details, ['sessionId']);
  const parsedId = firstString(details, ['parsedSessionId']);

  // A window/title-derived id that disagrees with the strongest observed session
  // identity makes the observation ambiguous rather than merely unverified.
  const strongestWorkerId = authoritativeId ?? externalId ?? bindId ?? parsedId;
  const windowAmbiguous = Boolean(
    observedWindowId &&
      strongestWorkerId &&
      observedWindowId !== strongestWorkerId,
  );

  if (role === 'planner') {
    if (!projectUrl) return undefined;
    const bindingRecorded = details.bindingRecorded === true || details.source === 'binding_setup';
    return {
      reference: projectUrl,
      kind: 'project_url',
      sessionIdVerified: !bindingRecorded,
      projectUrl,
      ...(bindingRecorded ? { bindingRecorded: true } : {}),
      conflict,
      observedAt,
    };
  }

  // worker session identities, strongest source first.
  if (authoritativeId) {
    return {
      reference: authoritativeId,
      kind: 'session_id',
      sessionId: authoritativeId,
      sessionIdSource: 'authoritative',
      sessionIdVerified: true,
      workspacePath,
      openCodeProjectId,
      ambiguous: windowAmbiguous,
      conflict,
      observedAt,
    };
  }
  if (externalId) {
    return {
      reference: externalId,
      kind: 'session_id',
      sessionId: externalId,
      sessionIdSource: 'external',
      sessionIdVerified: true,
      workspacePath,
      openCodeProjectId,
      ambiguous: windowAmbiguous,
      conflict,
      observedAt,
    };
  }
  if (bindId) {
    // Recorded when the binding was established; verified only if it agrees
    // with the runtime's persisted external session id.
    return {
      reference: bindId,
      kind: 'session_id',
      sessionId: bindId,
      sessionIdSource: 'binding',
      sessionIdVerified: Boolean(session.externalSessionId === bindId),
      workspacePath,
      openCodeProjectId,
      ambiguous: windowAmbiguous,
      conflict,
      observedAt,
    };
  }
  if (parsedId) {
    return {
      reference: parsedId,
      kind: 'session_id',
      sessionId: parsedId,
      sessionIdSource: 'parsed',
      sessionIdVerified: false,
      displayOnly: true,
      workspacePath,
      openCodeProjectId,
      ambiguous: windowAmbiguous,
      conflict,
      observedAt,
    };
  }
  if (observedWindowId) {
    return {
      reference: observedWindowId,
      kind: 'session_id',
      sessionId: observedWindowId,
      sessionIdSource: 'parsed',
      sessionIdVerified: false,
      displayOnly: true,
      workspacePath,
      openCodeProjectId,
      conflict,
      observedAt,
    };
  }
  if (workspacePath) {
    return {
      reference: workspacePath,
      kind: 'workspace_path',
      sessionIdVerified: false,
      workspacePath,
      openCodeProjectId,
      conflict,
      observedAt,
    };
  }
  return undefined;
}

/** True when the runtime is not currently observable or has not been observed since the binding was saved. */
function isRuntimeStale(session: UIRuntimeSession | undefined, savedBinding?: SavedBinding): boolean {
  if (!session) return true;
  if (session.status === 'suspended' || session.status === 'terminated' || session.status === 'unknown') {
    return true;
  }
  if (session.lastObservedAt == null) return true;
  if (savedBinding?.savedAt != null && session.lastObservedAt < savedBinding.savedAt) return true;
  return false;
}

function sameIdentity(
  role: BindingRole,
  a: string,
  b: string,
  kindA?: SavedBinding['kind'],
  kindB?: DiscoveredIdentity['kind'],
): boolean {
  if (role === 'planner') return normalizeChatSlug(a) === normalizeChatSlug(b);
  if (kindA === 'workspace_path' && kindB === 'workspace_path') {
    return normalizeWorkspacePath(a) === normalizeWorkspacePath(b);
  }
  return a === b;
}

/**
 * Worker-side identity verdict.
 *
 * The worker's saved binding is usually a WORKSPACE PATH (project field) while
 * the latest discovery is a SESSION ID (observed via the shared service or a
 * window parse). Comparing those across kinds as plain strings would report a
 * mismatch for every freshly finalized project, so the comparison is
 * identity-aware instead:
 *  - A VERIFIED session id is the strongest signal: it confirms the binding
 *    when it matches the worker session the app persists (externalSessionId).
 *    A matching session id is still not enough on its own when the saved
 *    binding is a workspace path — a different OBSERVED workspace path is a
 *    real path drift and is reported as a mismatch ('pathDrift') instead of an
 *    unqualified 'verified'.
 *  - An observed workspace path confirms a saved workspace binding even when
 *    the session id in the same observation is unverifiable (no persisted
 *    external session id to compare it against). That reads as
 *    'workspaceConfirmed' (unverified), NOT a mismatch, so a freshly observed
 *    workspace is never reported as mismatched just because the discovered
 *    value happens to be a session id.
 *  - An unverified (parsed/window) id only confirms an exact same-kind match
 *    ('unverifiedSession') — and even then stays unverified until confirmed
 *    authoritatively.
 *  - When no session identity was observed, the observed workspace path is
 *    compared against the saved workspace path.
 */
type WorkerBindingVerdict =
  | 'confirmed' // saved binding confirmed against a verified session id / observed workspace
  | 'pathDrift' // session id matches the persisted worker session, but the observed workspace differs
  | 'workspaceConfirmed' // saved workspace confirmed by an observed workspace; session id unverifiable
  | 'unverifiedSession' // unverified id equals the saved session-id binding (exact same-kind match)
  | 'none'; // no confirmation — handled by the shared mismatch / display-only logic

function workerBindingVerdict(
  savedRef: string,
  savedKind: SavedBinding['kind'],
  discovered: DiscoveredIdentity,
  persistedSessionId?: string | null,
): WorkerBindingVerdict {
  const observedSessionId = discovered.sessionId;
  const observedWorkspace = discovered.workspacePath;

  if (observedSessionId) {
    if (discovered.sessionIdVerified) {
      if (!persistedSessionId || observedSessionId !== persistedSessionId) return 'none';
      // Session confirmed. A saved workspace binding still requires the
      // observed workspace to agree; otherwise the path has drifted.
      if (savedKind === 'workspace_path' && observedWorkspace) {
        return normalizeWorkspacePath(observedWorkspace) === normalizeWorkspacePath(savedRef)
          ? 'confirmed'
          : 'pathDrift';
      }
      return 'confirmed';
    }
    // Unverified identity (bind-time id or window/title parse). Only an exact
    // same-kind match counts; a matching observed workspace confirms the saved
    // workspace binding even though the session id cannot be verified.
    if (savedKind === 'session_id' && observedSessionId === savedRef) {
      return 'unverifiedSession';
    }
    if (savedKind === 'workspace_path' && observedWorkspace) {
      return normalizeWorkspacePath(observedWorkspace) === normalizeWorkspacePath(savedRef)
        ? 'workspaceConfirmed'
        : 'none';
    }
    return 'none';
  }
  // No session identity observed this round.
  // A saved session_id binding without an observed session ID is unverified,
  // never a mismatch — the binding is retained and the observation cannot
  // confirm or refute the persisted session.
  if (savedKind === 'session_id') {
    return 'unverifiedSession';
  }
  // A saved workspace binding with only an observed workspace (no verified
  // session ID) is unverified — the workspace is observed but no session
  // identity confirms or refutes the binding.
  if (savedKind === 'workspace_path' && observedWorkspace) {
    return normalizeWorkspacePath(observedWorkspace) === normalizeWorkspacePath(savedRef)
      ? 'workspaceConfirmed'
      : 'none';
  }
  return 'none';
}

/**
 * Compares the saved binding against the latest discovered identity.
 *
 * Rules:
 *  - A recorded identity conflict (`identityConflict`) is always surfaced as a
 *    mismatch — the persisted binding was retained by inspection and never
 *    overwritten.
 *  - Worker observations whose window/title-level ids disagree are ambiguous.
 *  - Equal saved+discovered → verified (when the discovery is authoritative).
 *  - Different saved+discovered → mismatch.
 *  - Worker saved bindings are identity-aware: a saved workspace path is
 *    confirmed against the observed session id via the persisted worker session
 *    (externalSessionId) or the observed workspace path, so a freshly finalized
 *    project does not read as a false mismatch across kinds.
 *  - Discovered-only → unverified (observed identity is not this project's
 *    saved binding yet).
 *  - Saved-only → stale when the runtime cannot currently reverify it
 *    (suspended/terminated/unknown or never observed since saved), otherwise
 *    unverified (recent observation carried no identity we can verify).
 *  - A discovery failure NEVER erases the saved binding — it stays visible.
 */
function buildVerification(
  role: BindingRole,
  bound: boolean,
  savedBinding: SavedBinding | undefined,
  discovered: DiscoveredIdentity | undefined,
  session: UIRuntimeSession | undefined,
): BindingVerification {
  if (!bound) {
    if (!savedBinding) return { status: 'unavailable' };
    return {
      status: 'stale',
      note:
        role === 'planner'
          ? 'Saved planner binding retained; no bound planner session to reverify.'
          : 'Saved worker binding retained; no bound worker session to reverify.',
    };
  }

  // Ambiguous: a window/title-derived id was observed and disagrees with the
  // session identity the side would rely on.
  if (role === 'worker' && discovered?.ambiguous) {
    return {
      status: 'ambiguous',
      note: 'Multiple window-derived session identities observed; could not resolve a single verified session.',
    };
  }

  const conflictNote = discovered?.conflict
    ? 'Inspection recorded an identity conflict; the persisted binding was retained and never overwritten.'
    : undefined;

  const discoveredRef = discovered?.reference;
  const savedRef = savedBinding?.value;

  if (!discoveredRef) {
    if (!savedRef) return { status: 'unavailable' };
    if (isRuntimeStale(session, savedBinding)) {
      return {
        status: 'stale',
        note: conflictNote ?? 'Saved binding retained; latest discovery recorded no identity (could not reverify).',
      };
    }
    return {
      status: 'unverified',
      note:
        conflictNote ??
        'Saved binding retained; latest observation carried no identity the current implementation can verify.',
    };
  }

  if (conflictNote) return { status: 'mismatch', note: conflictNote };

  if (!savedRef) {
    return {
      status: 'unverified',
      note:
        role === 'planner'
          ? 'ChatGPT project URL observed but not saved as this project\'s binding.'
          : 'Worker session observed but not saved as this project\'s binding.',
    };
  }

  // Worker bindings compare SAVED workspace/session vs DISCOVERED identity in an
  // identity-aware way (see workerBindingVerdict). Planner and any side without
  // a saved binding use the plain kind-aware comparison below.
  if (role === 'worker' && savedBinding && discovered) {
    const verdict = workerBindingVerdict(
      savedRef,
      savedBinding.kind,
      discovered,
      session?.externalSessionId,
    );
    switch (verdict) {
      case 'confirmed':
        return { status: 'verified', note: 'Saved binding matches the latest discovered identity.' };
      case 'pathDrift':
        return {
          status: 'mismatch',
          note: 'Worker session matches, but the observed workspace path differs from the saved worker workspace binding.',
        };
      case 'workspaceConfirmed':
        return {
          status: 'unverified',
          note: 'Observed workspace matches the saved worker workspace binding, but the observed session id could not be verified.',
        };
      case 'unverifiedSession':
        return {
          status: 'unverified',
          note: discovered?.displayOnly
            ? 'Observed identity matches the saved binding but was not verified authoritatively.'
            : 'No session ID was observed; the saved session ID could not be verified.',
        };
      case 'none':
        break; // no confirmation — fall through to the shared displayOnly / mismatch handling
    }
  }

  const equal =
    role === 'worker' ? false : sameIdentity(role, savedRef, discoveredRef, savedBinding?.kind, discovered?.kind);
  if (!equal && discovered.displayOnly) {
    return {
      status: 'unverified',
      note: 'Observed identity (window/title-derived, unverified) differs from the saved binding; not confirmed.',
    };
  }
  if (equal) {
    if (discovered.sessionIdVerified === false || discovered.displayOnly) {
      return {
        status: 'unverified',
        note: 'Observed identity matches the saved binding but was not verified authoritatively.',
      };
    }
    return { status: 'verified', note: 'Saved binding matches the latest discovered identity.' };
  }
  return {
    status: 'mismatch',
    note: 'Saved binding differs from the latest discovered identity.',
  };
}

/** Active planner/worker sessions bound to the project, one child record per session. */
function buildChildSessions(
  project: UIProject,
  projectPairs: UIPair[],
  sessions: UIRuntimeSession[],
): ProjectChildSession[] {
  const seen = new Set<string>();
  const records: ProjectChildSession[] = [];
  for (const pair of projectPairs) {
    for (const role of ['planner', 'worker'] as const) {
      const sessionId = role === 'planner' ? pair.plannerSessionId : pair.workerSessionId;
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      const session = sessions.find((s) => s.id === sessionId);
      const side = buildBindingSide(role, pair, session, project);
      records.push({
        sessionId,
        role,
        sessionName: side.sessionName ?? (role === 'planner' ? 'Planner' : 'Worker'),
        provider: side.provider ?? 'unknown',
        runtimeStatus: side.runtimeStatus ?? 'unknown',
        pairId: pair.id,
        pairName: pair.name,
        savedBinding: side.savedBinding,
        discovered: side.discovered,
        verification: side.verification,
      });
    }
  }
  return records;
}

/* --- Session detail --- */

export interface SessionAssociation {
  role?: BindingRole;
  projects: Array<{ id: string; name: string }>;
  pairs: Array<{ id: string; name: string; role: BindingRole }>;
  activeAssignment?: { id: string; title: string; status: UIAssignment['status'] };
}

export interface SessionDetailViewModel {
  id: string;
  name: string;
  provider: UIRuntimeSession['providerType'];
  status: UIRuntimeSession['status'];
  integrationStatus?: UIRuntimeSession['integrationStatus'];
  windowTitle?: string;
  applicationPid?: number;
  bundleIdentifier?: string;
  role?: BindingRole;
  association: SessionAssociation;
  identity: {
    externalSessionId: DetailField;
    workspacePath: DetailField;
    providerReference: DetailField;
  };
  health: {
    status: UIRuntimeSession['status'];
    consecutiveObservationFailures: number;
    lastObservedAt?: number;
    lastHeartbeatAt?: number;
    archivedAt?: number;
    archiveReason?: string;
  };
  latestEvidence?: ObservableEvidence;
  recentEvents: UIEvent[];
  metadata: {
    createdAt?: number;
    updatedAt?: number;
  };
}

export interface SessionDetailInput {
  sessionId: string;
  sessions: UIRuntimeSession[];
  pairs: UIPair[];
  projects: UIProject[];
  assignments: UIAssignment[];
  events: UIEvent[];
}

export function selectSessionDetail(input: SessionDetailInput): SessionDetailViewModel | null {
  const session = input.sessions.find((s) => s.id === input.sessionId);
  if (!session) return null;
  return buildSessionDetail(session, input);
}

export function buildSessionDetail(
  session: UIRuntimeSession,
  input: Omit<SessionDetailInput, 'sessionId'>,
): SessionDetailViewModel {
  const boundPairs = input.pairs.filter(
    (pair) => pair.plannerSessionId === session.id || pair.workerSessionId === session.id,
  );

  const roles = new Set<BindingRole>();
  for (const pair of boundPairs) {
    if (pair.plannerSessionId === session.id) roles.add('planner');
    if (pair.workerSessionId === session.id) roles.add('worker');
  }
  const role = roles.size === 1 ? [...roles][0] : undefined;

  const projectNames = new Map(input.projects.map((p) => [p.id, p.name]));
  const projectMap = new Map<string, { id: string; name: string }>();
  for (const pair of boundPairs) {
    if (projectMap.has(pair.projectId)) continue;
    projectMap.set(pair.projectId, {
      id: pair.projectId,
      name: pair.projectName || projectNames.get(pair.projectId) || 'Unknown Project',
    });
  }

  const associatedPairs: SessionAssociation['pairs'] = boundPairs.map((pair) => ({
    id: pair.id,
    name: pair.name,
    role: pair.plannerSessionId === session.id ? 'planner' : 'worker',
  }));
  const boundPairIds = new Set(boundPairs.map((pair) => pair.id));

  const activeAssignment = sortByRecency(
    input.assignments.filter(
      (a) =>
        boundPairIds.has(a.pairId) &&
        (a.status === 'active' || a.status === 'pending' || a.status === 'waiting_for_handoff'),
    ),
    (a) => a.createdAt,
  )[0];

  const recentEvents = sortByRecency(
    input.events.filter(
      (event) => event.resourceId === session.id || boundPairIds.has(event.resourceId),
    ),
    (event) => event.timestamp,
  ).slice(0, 8);

  const identity = extractSessionIdentity(session);

  return {
    id: session.id,
    name: session.name,
    provider: session.providerType,
    status: session.status,
    integrationStatus: session.integrationStatus,
    windowTitle: session.windowTitle,
    applicationPid: session.applicationPid,
    bundleIdentifier: session.bundleIdentifier,
    role,
    association: {
      role,
      projects: [...projectMap.values()],
      pairs: associatedPairs,
      activeAssignment: activeAssignment
        ? { id: activeAssignment.id, title: activeAssignment.title, status: activeAssignment.status }
        : undefined,
    },
    identity: {
      externalSessionId: detailField('Provider Session ID', identity.externalSessionId, {
        mono: true,
        copyable: true,
      }),
      workspacePath: detailField('Workspace / Directory', identity.workspacePath, {
        mono: true,
        copyable: true,
      }),
      providerReference: detailField(
        'Provider Reference',
        identity.projectUrl ?? identity.openCodeProjectId,
        { mono: true, copyable: true },
      ),
    },
    health: {
      status: session.status,
      consecutiveObservationFailures: session.consecutiveObservationFailures,
      lastObservedAt: session.lastObservedAt,
      lastHeartbeatAt: session.lastHeartbeatAt,
      archivedAt: session.archivedAt,
      archiveReason: session.archiveReason,
    },
    latestEvidence: session.lastEvidence,
    recentEvents,
    metadata: {
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
  };
}
