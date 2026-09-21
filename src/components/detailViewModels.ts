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
  /** Provider-side reference (external session id or planner project URL). */
  reference?: string;
}

export interface ProjectPairBinding {
  pairId: string;
  pairName: string;
  status: UIPair['status'];
  archived: boolean;
  planner: ProjectBindingSide;
  worker: ProjectBindingSide;
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
  bindings: ProjectPairBinding[];
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

  const bindings = projectPairs.map((pair) => buildPairBinding(pair, input.sessions));

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
    bindings,
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

function buildPairBinding(pair: UIPair, sessions: UIRuntimeSession[]): ProjectPairBinding {
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
    planner: buildBindingSide('planner', pair, plannerSession),
    worker: buildBindingSide('worker', pair, workerSession),
  };
}

function buildBindingSide(
  role: BindingRole,
  pair: UIPair,
  session: UIRuntimeSession | undefined,
): ProjectBindingSide {
  const sessionId = role === 'planner' ? pair.plannerSessionId : pair.workerSessionId;
  const bound = Boolean(sessionId);
  const identity = session ? extractSessionIdentity(session) : {};
  const fallbackProvider = role === 'planner' ? pair.plannerProvider : pair.workerProvider;
  const fallbackName = role === 'planner' ? pair.plannerName : pair.workerName;
  const fallbackStatus = role === 'planner' ? pair.plannerStatus : pair.workerStatus;

  return {
    role,
    bound,
    provider: bound ? (session?.providerType ?? fallbackProvider) : undefined,
    sessionId,
    sessionName: bound ? (session?.name ?? fallbackName) : undefined,
    runtimeStatus: bound ? (session?.status ?? fallbackStatus) : undefined,
    reference: identity.externalSessionId ?? identity.projectUrl,
  };
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
