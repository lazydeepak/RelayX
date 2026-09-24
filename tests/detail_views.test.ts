import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detailField,
  extractSessionIdentity,
  selectProjectDetail,
  selectSessionDetail,
} from '../src/components/detailViewModels.ts';
import type {
  UIProject,
  UIPair,
  UIRuntimeSession,
  UIAssignment,
  UIEvent,
  UIAttentionItem,
} from '../src/types/ui.ts';

/* --- Fixtures (all data shapes mirror what the renderer already receives) --- */

const project: UIProject = {
  id: 'proj_1',
  name: 'RelayX',
  description: 'AI work orchestration control plane',
  canonicalPath: '/Users/dev/RelayX',
  gitRoot: '/Users/dev/RelayX/.git',
  status: 'active',
  createdAt: 1000,
  updatedAt: 2000,
};

const emptyProject: UIProject = {
  id: 'proj_empty',
  name: 'Fresh Project',
  description: '',
  status: 'active',
  createdAt: 500,
};

const plannerSession: UIRuntimeSession = {
  id: 'runtime_planner',
  providerType: 'chatgpt',
  name: 'ChatGPT: RelayX',
  status: 'available',
  consecutiveObservationFailures: 0,
  integrationStatus: 'partial',
  lastObservedAt: 1500,
  lastEvidence: {
    id: 'ev_planner',
    timestamp: 1500,
    source: 'reconciliation_probe',
    details: { projectUrl: 'https://chatgpt.com/p/relayx' },
  },
  createdAt: 900,
  updatedAt: 1500,
};

const workerSession: UIRuntimeSession = {
  id: 'runtime_worker',
  providerType: 'opencode',
  name: 'OpenCode: RelayX',
  status: 'working',
  consecutiveObservationFailures: 0,
  integrationStatus: 'real',
  lastObservedAt: 1600,
  lastEvidence: {
    id: 'ev_worker',
    timestamp: 1600,
    source: 'reconciliation_probe',
    details: { sessionId: 'sess_abc', workspacePath: '/Users/dev/RelayX' },
  },
  createdAt: 950,
  updatedAt: 1600,
};

const unboundSession: UIRuntimeSession = {
  id: 'runtime_unbound',
  providerType: 'generic_ui',
  name: 'Standalone',
  status: 'unknown',
  consecutiveObservationFailures: 0,
};

const pair: UIPair = {
  id: 'pair_1',
  projectId: 'proj_1',
  projectName: 'RelayX',
  name: 'Default Pair',
  plannerSessionId: 'runtime_planner',
  workerSessionId: 'runtime_worker',
  plannerName: 'ChatGPT: RelayX',
  plannerProvider: 'chatgpt',
  plannerStatus: 'available',
  workerName: 'OpenCode: RelayX',
  workerProvider: 'opencode',
  workerStatus: 'working',
  status: 'active',
  lastSupervisedAt: 1650,
};

const activeAssignment: UIAssignment = {
  id: 'asg_1',
  pairId: 'pair_1',
  pairName: 'Default Pair',
  projectId: 'proj_1',
  title: 'Wire detail views',
  instruction: 'Implement',
  status: 'active',
  createdAt: 1200,
};

const completedAssignment: UIAssignment = {
  id: 'asg_done',
  pairId: 'pair_1',
  pairName: 'Default Pair',
  projectId: 'proj_1',
  title: 'Inspect surfaces',
  instruction: 'Inspect',
  status: 'completed',
  createdAt: 1100,
  completedAt: 1800,
};

const events: UIEvent[] = [
  {
    id: 'e_project',
    timestamp: 1700,
    resourceType: 'project',
    resourceId: 'proj_1',
    eventType: 'project_updated',
    actor: 'system',
  },
  {
    id: 'e_pair',
    timestamp: 1750,
    resourceType: 'pair',
    resourceId: 'pair_1',
    eventType: 'pair_started',
    actor: 'system',
  },
  {
    id: 'e_runtime',
    timestamp: 1650,
    resourceType: 'runtime',
    resourceId: 'runtime_worker',
    eventType: 'observation_success',
    actor: 'system',
    evidence: {
      id: 'ev_event',
      timestamp: 1650,
      source: 'reconciliation_probe',
    },
  },
  {
    id: 'e_other',
    timestamp: 9999,
    resourceType: 'project',
    resourceId: 'proj_2',
    eventType: 'other',
    actor: 'system',
  },
];

const attention: UIAttentionItem[] = [
  {
    id: 'att_1',
    pairId: 'pair_1',
    severity: 'warning',
    status: 'open',
    type: 'stuck',
    title: 'Worker stalled',
    message: 'No progress observed',
    createdAt: 1200,
  },
];

/* --- Project detail --- */

test('project detail opens for an existing project and is null for unknown ids', () => {
  const vm = selectProjectDetail({
    projectId: 'proj_1',
    projects: [project, emptyProject],
    pairs: [pair],
    sessions: [plannerSession, workerSession],
    assignments: [activeAssignment],
    events,
    attentionItems: attention,
  });

  assert.ok(vm);
  assert.equal(vm.id, 'proj_1');
  assert.equal(vm.name, 'RelayX');
  assert.equal(vm.description, 'AI work orchestration control plane');
  assert.equal(vm.status, 'active');

  const missing = selectProjectDetail({
    projectId: 'does_not_exist',
    projects: [project],
    pairs: [],
    sessions: [],
    assignments: [],
    events: [],
    attentionItems: [],
  });
  assert.equal(missing, null);
});

test('project detail surfaces repository path and git root, truthfully empty when absent', () => {
  const vm = selectProjectDetail({
    projectId: 'proj_1',
    projects: [project],
    pairs: [],
    sessions: [],
    assignments: [],
    events: [],
    attentionItems: [],
  });
  assert.ok(vm);
  assert.equal(vm.repository.canonicalPath.state, 'value');
  assert.equal(vm.repository.canonicalPath.value, '/Users/dev/RelayX');
  assert.equal(vm.repository.canonicalPath.mono, true);
  assert.equal(vm.repository.canonicalPath.copyable, true);
  assert.equal(vm.repository.gitRoot.value, '/Users/dev/RelayX/.git');

  const fresh = selectProjectDetail({
    projectId: 'proj_empty',
    projects: [emptyProject],
    pairs: [],
    sessions: [],
    assignments: [],
    events: [],
    attentionItems: [],
  });
  assert.ok(fresh);
  assert.equal(fresh.repository.canonicalPath.state, 'empty');
  assert.equal(fresh.repository.canonicalPath.value, 'Not available');
  assert.equal(fresh.repository.canonicalPath.copyable, false);
  assert.equal(fresh.repository.gitRoot.state, 'empty');
});

test('project detail renders planner and worker bindings with provider references', () => {
  const vm = selectProjectDetail({
    projectId: 'proj_1',
    projects: [project],
    pairs: [pair],
    sessions: [plannerSession, workerSession],
    assignments: [],
    events: [],
    attentionItems: [],
  });
  assert.ok(vm);
  assert.equal(vm.bindings.length, 1);

  const [binding] = vm.bindings;
  assert.equal(binding.pairName, 'Default Pair');
  assert.equal(binding.status, 'active');

  assert.equal(binding.planner.bound, true);
  assert.equal(binding.planner.role, 'planner');
  assert.equal(binding.planner.provider, 'chatgpt');
  assert.equal(binding.planner.sessionId, 'runtime_planner');
  assert.equal(binding.planner.sessionName, 'ChatGPT: RelayX');
  assert.equal(binding.planner.runtimeStatus, 'available');
  assert.equal(binding.planner.reference, 'https://chatgpt.com/p/relayx');

  assert.equal(binding.worker.bound, true);
  assert.equal(binding.worker.provider, 'opencode');
  assert.equal(binding.worker.sessionId, 'runtime_worker');
  assert.equal(binding.worker.runtimeStatus, 'working');
  assert.equal(binding.worker.reference, 'sess_abc');
});

test('project detail exposes unbound sides and clean empty states', () => {
  const unboundPair: UIPair = {
    id: 'pair_unbound',
    projectId: 'proj_empty',
    projectName: 'Fresh Project',
    name: 'Unbound Pair',
    status: 'idle',
  };
  const vm = selectProjectDetail({
    projectId: 'proj_empty',
    projects: [emptyProject],
    pairs: [unboundPair],
    sessions: [],
    assignments: [],
    events: [],
    attentionItems: [],
  });
  assert.ok(vm);
  assert.equal(vm.bindings.length, 1);
  assert.equal(vm.bindings[0].planner.bound, false);
  assert.equal(vm.bindings[0].planner.sessionId, undefined);
  assert.equal(vm.bindings[0].worker.bound, false);
  assert.equal(vm.work.active.length, 0);
  assert.equal(vm.work.recentCompleted.length, 0);
  assert.equal(vm.work.attention.length, 0);
  assert.equal(vm.activity.recentEvents.length, 0);
  assert.equal(vm.activity.lastActivityAt, undefined);
});

test('project detail scopes work, attention and events to the selected project', () => {
  const vm = selectProjectDetail({
    projectId: 'proj_1',
    projects: [project],
    pairs: [pair],
    sessions: [plannerSession, workerSession],
    assignments: [activeAssignment, completedAssignment],
    events,
    attentionItems: attention,
  });
  assert.ok(vm);
  assert.equal(vm.work.active.length, 1);
  assert.equal(vm.work.active[0].id, 'asg_1');
  assert.equal(vm.work.recentCompleted.length, 1);
  assert.equal(vm.work.recentCompleted[0].id, 'asg_done');
  assert.equal(vm.work.attention.length, 1);
  assert.equal(vm.work.attention[0].id, 'att_1');

  const eventIds = vm.activity.recentEvents.map((e) => e.id);
  assert.deepEqual(eventIds, ['e_pair', 'e_project']);
  assert.equal(eventIds.includes('e_other'), false);
  assert.equal(vm.activity.lastActivityAt, 2000);
  assert.equal(vm.metadata.createdAt, 1000);
  assert.equal(vm.metadata.updatedAt, 2000);
});

/* --- Session detail --- */

test('session detail opens from the sessions list and derives the bound role', () => {
  const worker = selectSessionDetail({
    sessionId: 'runtime_worker',
    sessions: [plannerSession, workerSession],
    pairs: [pair],
    projects: [project],
    assignments: [activeAssignment],
    events,
  });
  assert.ok(worker);
  assert.equal(worker.id, 'runtime_worker');
  assert.equal(worker.provider, 'opencode');
  assert.equal(worker.role, 'worker');

  const planner = selectSessionDetail({
    sessionId: 'runtime_planner',
    sessions: [plannerSession, workerSession],
    pairs: [pair],
    projects: [project],
    assignments: [],
    events,
  });
  assert.ok(planner);
  assert.equal(planner.role, 'planner');

  const missing = selectSessionDetail({
    sessionId: 'nope',
    sessions: [workerSession],
    pairs: [],
    projects: [],
    assignments: [],
    events: [],
  });
  assert.equal(missing, null);
});

test('session detail renders association, status, identity and metadata', () => {
  const vm = selectSessionDetail({
    sessionId: 'runtime_worker',
    sessions: [plannerSession, workerSession],
    pairs: [pair],
    projects: [project],
    assignments: [activeAssignment],
    events,
  });
  assert.ok(vm);

  assert.equal(vm.status, 'working');
  assert.equal(vm.integrationStatus, 'real');
  assert.equal(vm.association.projects.length, 1);
  assert.equal(vm.association.projects[0].name, 'RelayX');
  assert.equal(vm.association.pairs.length, 1);
  assert.equal(vm.association.pairs[0].role, 'worker');
  assert.equal(vm.association.activeAssignment?.id, 'asg_1');

  assert.equal(vm.identity.externalSessionId.state, 'value');
  assert.equal(vm.identity.externalSessionId.value, 'sess_abc');
  assert.equal(vm.identity.workspacePath.value, '/Users/dev/RelayX');
  assert.equal(vm.metadata.createdAt, 950);
  assert.equal(vm.metadata.updatedAt, 1600);

  assert.equal(vm.health.status, 'working');
  assert.equal(vm.health.consecutiveObservationFailures, 0);
  assert.equal(vm.health.lastObservedAt, 1600);
});

test('session detail exposes latest evidence and recent events for History/Evidence actions', () => {
  const worker = selectSessionDetail({
    sessionId: 'runtime_worker',
    sessions: [plannerSession, workerSession],
    pairs: [pair],
    projects: [project],
    assignments: [activeAssignment],
    events,
  });
  assert.ok(worker);
  assert.equal(worker.latestEvidence?.id, 'ev_worker');
  const eventIds = worker.recentEvents.map((e) => e.id);
  assert.deepEqual(eventIds, ['e_pair', 'e_runtime']);

  // Planner evidence reference is the project URL, not a session id.
  const planner = selectSessionDetail({
    sessionId: 'runtime_planner',
    sessions: [plannerSession],
    pairs: [pair],
    projects: [project],
    assignments: [],
    events,
  });
  assert.ok(planner);
  assert.equal(planner.identity.externalSessionId.state, 'empty');
  assert.equal(planner.identity.externalSessionId.value, 'Not available');
  assert.equal(planner.identity.providerReference.value, 'https://chatgpt.com/p/relayx');

  // A standalone session has no evidence/history to act on.
  const standalone = selectSessionDetail({
    sessionId: 'runtime_unbound',
    sessions: [unboundSession],
    pairs: [],
    projects: [],
    assignments: [],
    events: [],
  });
  assert.ok(standalone);
  assert.equal(standalone.latestEvidence, undefined);
  assert.equal(standalone.recentEvents.length, 0);
  assert.equal(standalone.association.activeAssignment, undefined);
  assert.equal(standalone.role, undefined);
  assert.equal(standalone.identity.workspacePath.state, 'empty');
});

test('session detail reports archived health truthfully', () => {
  const archived: UIRuntimeSession = {
    ...workerSession,
    status: 'archived',
    archivedAt: 1900,
    archiveReason: 'Completed',
  };
  const vm = selectSessionDetail({
    sessionId: 'runtime_worker',
    sessions: [archived],
    pairs: [pair],
    projects: [project],
    assignments: [],
    events: [],
  });
  assert.ok(vm);
  assert.equal(vm.health.status, 'archived');
  assert.equal(vm.health.archivedAt, 1900);
  assert.equal(vm.health.archiveReason, 'Completed');
});

test('detail selection resolves cleanly when switching or closing records', () => {
  const baseProjectInput = {
    projects: [project, emptyProject],
    pairs: [pair],
    sessions: [plannerSession, workerSession],
    assignments: [activeAssignment],
    events,
    attentionItems: attention,
  };
  assert.equal(selectProjectDetail({ projectId: 'proj_1', ...baseProjectInput })?.id, 'proj_1');
  assert.equal(
    selectProjectDetail({ projectId: 'proj_empty', ...baseProjectInput })?.id,
    'proj_empty',
  );
  // Closing / switching to an unknown id yields null rather than stale data.
  assert.equal(selectProjectDetail({ projectId: '', ...baseProjectInput }), null);

  const baseSessionInput = {
    sessions: [plannerSession, workerSession, unboundSession],
    pairs: [pair],
    projects: [project],
    assignments: [activeAssignment],
    events,
  };
  assert.equal(
    selectSessionDetail({ sessionId: 'runtime_planner', ...baseSessionInput })?.id,
    'runtime_planner',
  );
  assert.equal(
    selectSessionDetail({ sessionId: 'runtime_worker', ...baseSessionInput })?.id,
    'runtime_worker',
  );
  assert.equal(selectSessionDetail({ sessionId: '', ...baseSessionInput }), null);
});

/* --- Primitives --- */

test('detailField trims values and honours custom empty text', () => {
  assert.equal(detailField('X', undefined).state, 'empty');
  assert.equal(detailField('X', undefined).value, 'Not available');
  assert.equal(detailField('X', null).state, 'empty');
  assert.equal(detailField('X', '  ').state, 'empty');
  assert.equal(detailField('X', '  abc  ').value, 'abc');
  assert.equal(detailField('X', '', { emptyText: 'Not bound' }).value, 'Not bound');
  assert.equal(detailField('X', '').copyable, false);
  assert.equal(detailField('X', 'abc', { copyable: true }).copyable, true);
});

test('extractSessionIdentity reads only known evidence keys', () => {
  assert.deepEqual(extractSessionIdentity(workerSession), {
    externalSessionId: 'sess_abc',
    workspacePath: '/Users/dev/RelayX',
    openCodeProjectId: undefined,
    projectUrl: undefined,
  });
  assert.deepEqual(extractSessionIdentity(plannerSession), {
    externalSessionId: undefined,
    workspacePath: undefined,
    openCodeProjectId: undefined,
    projectUrl: 'https://chatgpt.com/p/relayx',
  });
  assert.deepEqual(extractSessionIdentity(unboundSession), {
    externalSessionId: undefined,
    workspacePath: undefined,
    openCodeProjectId: undefined,
    projectUrl: undefined,
  });
});

/* --- Saved-vs-discovered binding verification --- */

function projectBindingVM(overrides: {
  project?: UIProject;
  pairs?: UIPair[];
  sessions?: UIRuntimeSession[];
}) {
  const selected = selectProjectDetail({
    projectId: overrides.project?.id ?? 'proj_1',
    projects: [overrides.project ?? project],
    pairs: overrides.pairs ?? [pair],
    sessions: overrides.sessions ?? [plannerSession, workerSession],
    assignments: [],
    events: [],
    attentionItems: [],
  });
  assert.ok(selected, `view model must exist for ${overrides.project?.id ?? 'proj_1'}`);
  return selected;
}

test('binding verification resolves verified when the saved binding matches the latest discovered identity', () => {
  const savedProject: UIProject = {
    ...project,
    updatedAt: 2000,
    plannerProjectUrl: 'https://chatgpt.com/p/relayx',
    workerWorkspacePath: '/Users/dev/RelayX',
  };

  // Planner: fresh browser observation of the URL matches the saved project URL.
  const verifiedPlanner: UIRuntimeSession = {
    ...plannerSession,
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_planner_verify',
      timestamp: 2500,
      source: 'window_inspection',
      details: { projectUrl: 'https://chatgpt.com/p/relayx' },
    },
  };
  // Worker: real finalizeProjectSetup shape — saved workspace path plus the
  // persisted worker session id observed in the bind-time evidence.
  const verifiedWorker: UIRuntimeSession = {
    ...workerSession,
    lastObservedAt: 2500,
    externalSessionId: 'sess_abc',
    lastEvidence: {
      id: 'ev_worker_verify',
      timestamp: 2500,
      source: 'reconciliation_probe',
      details: { sessionId: 'sess_abc', workspacePath: '/Users/dev/RelayX' },
    },
  };

  const vm = projectBindingVM({ project: savedProject, sessions: [verifiedPlanner, verifiedWorker] });
  const [binding] = vm.bindings;

  assert.equal(binding.planner.verification.status, 'verified');
  assert.equal(binding.planner.savedBinding?.value, 'https://chatgpt.com/p/relayx');
  assert.equal(binding.planner.savedBinding?.kind, 'project_url');
  assert.equal(binding.planner.savedBinding?.source, 'project');
  assert.equal(binding.planner.discovered?.reference, 'https://chatgpt.com/p/relayx');

  assert.equal(binding.worker.verification.status, 'verified');
  assert.equal(binding.worker.savedBinding?.value, '/Users/dev/RelayX');
  assert.equal(binding.worker.savedBinding?.kind, 'workspace_path');
  assert.equal(binding.worker.savedBinding?.source, 'project');
  assert.equal(binding.worker.discovered?.sessionId, 'sess_abc');
  assert.equal(binding.worker.discovered?.sessionIdVerified, true);
});

test('a worker saved via its persisted session id verifies against an authoritative observation', () => {
  // Legacy shape: no project-level worker workspace field; the saved binding
  // lives on the runtime as externalSessionId.
  const legacyWorker: UIRuntimeSession = {
    ...workerSession,
    externalSessionId: 'sess_abc',
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_worker_authoritative',
      timestamp: 2500,
      source: 'reconciliation_probe',
      details: { authoritativeSessionId: 'sess_abc', workspacePath: '/Users/dev/RelayX' },
    },
  };
  const legacyProject: UIProject = { ...project, plannerProjectUrl: 'https://chatgpt.com/p/relayx' };
  const legacyPair: UIPair = {
    ...pair,
    plannerSessionId: undefined,
    plannerName: undefined,
    plannerProvider: undefined,
    plannerStatus: undefined,
  };

  const vm = projectBindingVM({ project: legacyProject, pairs: [legacyPair], sessions: [legacyWorker] });
  const [binding] = vm.bindings;

  // Planner side: saved project URL persists on an unbound side, flagged stale.
  assert.equal(binding.planner.bound, false);
  assert.equal(binding.planner.savedBinding?.value, 'https://chatgpt.com/p/relayx');
  assert.equal(binding.planner.verification.status, 'stale');

  assert.equal(binding.worker.verification.status, 'verified');
  assert.equal(binding.worker.savedBinding?.value, 'sess_abc');
  assert.equal(binding.worker.savedBinding?.kind, 'session_id');
  assert.equal(binding.worker.savedBinding?.source, 'runtime');
  assert.equal(binding.worker.discovered?.sessionIdSource, 'authoritative');
  assert.equal(binding.worker.discovered?.sessionIdVerified, true);
});

test('binding verification reports mismatch when the saved binding differs from the latest discovered identity', () => {
  const driftedProject: UIProject = {
    ...project,
    plannerProjectUrl: 'https://chatgpt.com/p/old-project',
    workerWorkspacePath: '/Users/dev/RelayX',
  };
  const driftedPlanner: UIRuntimeSession = {
    ...plannerSession,
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_planner_drift',
      timestamp: 2500,
      source: 'window_inspection',
      details: { projectUrl: 'https://chatgpt.com/p/relayx' },
    },
  };
  const driftedWorker: UIRuntimeSession = {
    ...workerSession,
    externalSessionId: 'sess_abc',
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_worker_drift',
      timestamp: 2500,
      source: 'reconciliation_probe',
      details: { authoritativeSessionId: 'sess_different', workspacePath: '/Users/dev/RelayX' },
    },
  };

  const vm = projectBindingVM({ project: driftedProject, sessions: [driftedPlanner, driftedWorker] });
  const [binding] = vm.bindings;

  assert.equal(binding.planner.verification.status, 'mismatch');
  // The saved binding is retained even though latest discovery disagrees.
  assert.equal(binding.planner.savedBinding?.value, 'https://chatgpt.com/p/old-project');
  assert.equal(binding.planner.discovered?.reference, 'https://chatgpt.com/p/relayx');

  // A verified different session id for the worker is a true mismatch, not a stale note.
  assert.equal(binding.worker.verification.status, 'mismatch');
  assert.equal(binding.worker.savedBinding?.value, '/Users/dev/RelayX');
  assert.equal(binding.worker.discovered?.reference, 'sess_different');
  assert.equal(binding.worker.discovered?.sessionIdVerified, true);
});

test('a saved binding is flagged stale when its runtime cannot reverify it (suspended / never observed since save)', () => {
  const suspendedPlanner: UIRuntimeSession = {
    ...plannerSession,
    status: 'suspended',
    lastObservedAt: 900, // last observed before the binding was saved
    lastEvidence: {
      id: 'ev_planner_stale',
      timestamp: 900,
      source: 'reconciliation_probe',
      details: { windowTitle: 'ChatGPT - RelayX' },
    },
  };
  const savedProject: UIProject = {
    ...project,
    updatedAt: 2000,
    plannerProjectUrl: 'https://chatgpt.com/p/relayx',
    workerWorkspacePath: '/Users/dev/RelayX',
  };

  const vm = projectBindingVM({ project: savedProject, sessions: [suspendedPlanner] });
  const [binding] = vm.bindings;

  assert.equal(binding.planner.verification.status, 'stale');
  assert.equal(binding.planner.savedBinding?.value, 'https://chatgpt.com/p/relayx');
  assert.equal(binding.planner.savedBinding?.kind, 'project_url');
  assert.equal(binding.planner.savedBinding?.source, 'project');
  assert.match(binding.planner.verification.note ?? '', /could not reverify/);
});

test('a recent observation without an identity keeps the saved binding but marks it unverified, not stale', () => {
  const observedNoIdentity: UIRuntimeSession = {
    ...plannerSession,
    lastObservedAt: 2500, // observed after the binding was saved
    lastEvidence: {
      id: 'ev_planner_no_identity',
      timestamp: 2500,
      source: 'reconciliation_probe',
      details: { windowTitle: 'ChatGPT - RelayX' },
    },
  };
  const savedProject: UIProject = {
    ...project,
    updatedAt: 2000,
    plannerProjectUrl: 'https://chatgpt.com/p/relayx',
  };

  const vm = projectBindingVM({ project: savedProject, sessions: [observedNoIdentity] });
  const [binding] = vm.bindings;

  assert.equal(binding.planner.verification.status, 'unverified');
  assert.equal(binding.planner.savedBinding?.value, 'https://chatgpt.com/p/relayx');
  assert.match(binding.planner.verification.note ?? '', /no identity the current implementation can verify/);
});

test('a discovered identity without a saved binding is unverified and never fabricates a saved value', () => {
  const freshProject: UIProject = { ...project, updatedAt: 1000 };
  const discoveredPlanner: UIRuntimeSession = {
    ...plannerSession,
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_planner_discovered',
      timestamp: 2500,
      source: 'window_inspection',
      details: { projectUrl: 'https://chatgpt.com/p/relayx' },
    },
  };
  const discoveredWorker: UIRuntimeSession = {
    ...workerSession,
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_worker_discovered',
      timestamp: 2500,
      source: 'reconciliation_probe',
      details: { parsedSessionId: 'sess_parsed_9', workspacePath: '/Users/dev/RelayX' },
    },
  };

  const vm = projectBindingVM({ project: freshProject, sessions: [discoveredPlanner, discoveredWorker] });
  const [binding] = vm.bindings;

  assert.equal(binding.planner.verification.status, 'unverified');
  assert.equal(binding.planner.savedBinding, undefined);
  assert.equal(binding.planner.discovered?.reference, 'https://chatgpt.com/p/relayx');

  assert.equal(binding.worker.verification.status, 'unverified');
  assert.equal(binding.worker.savedBinding, undefined);
  assert.equal(binding.worker.discovered?.reference, 'sess_parsed_9');
  assert.equal(binding.worker.discovered?.sessionIdVerified, false);
  assert.equal(binding.worker.discovered?.displayOnly, true);
});

test('worker observations with disagreeing authoritative and window-derived session ids are ambiguous', () => {
  const ambiguousWorker: UIRuntimeSession = {
    ...workerSession,
    externalSessionId: 'sess_abc',
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_worker_ambiguous',
      timestamp: 2500,
      source: 'window_inspection',
      details: {
        authoritativeSessionId: 'sess_abc',
        observedWindowSessionId: 'sess_window_other',
        workspacePath: '/Users/dev/RelayX',
      },
    },
  };

  const vm = projectBindingVM({ sessions: [ambiguousWorker] });
  const [binding] = vm.bindings;

  assert.equal(binding.worker.verification.status, 'ambiguous');
  assert.equal(binding.worker.discovered?.sessionId, 'sess_abc');
  assert.equal(binding.worker.discovered?.ambiguous, true);
  assert.match(binding.worker.verification.note ?? '', /Multiple window-derived session identities/);
});

test('a display-only parsed id that matches the saved binding stays unverified (not verified)', () => {
  const windowFallbackWorker: UIRuntimeSession = {
    ...workerSession,
    externalSessionId: 'sess_abc',
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_worker_window_only',
      timestamp: 2500,
      source: 'window_inspection',
      details: { parsedSessionId: 'sess_abc', workspacePath: '/Users/dev/RelayX' },
    },
  };

  const vm = projectBindingVM({ sessions: [windowFallbackWorker] });
  const [binding] = vm.bindings;

  // Saved binding falls back to the runtime's persisted session id.
  assert.equal(binding.worker.savedBinding?.value, 'sess_abc');
  assert.equal(binding.worker.savedBinding?.kind, 'session_id');
  assert.equal(binding.worker.savedBinding?.source, 'runtime');
  assert.equal(binding.worker.discovered?.sessionId, 'sess_abc');
  assert.equal(binding.worker.discovered?.displayOnly, true);
  assert.equal(binding.worker.verification.status, 'unverified');
  assert.match(binding.worker.verification.note ?? '', /not verified authoritatively/);
});

test('a confirmed session id with a drifted observed workspace is a mismatch, not an unqualified verified', () => {
  // Saved workspace binding '/Users/dev/RelayX', worker session persisted as
  // 'sess_abc', and the latest discovery confirms that same session id — but
  // the observed workspace path has moved. The path drift must be exposed.
  const driftedWorkspaceWorker: UIRuntimeSession = {
    ...workerSession,
    externalSessionId: 'sess_abc',
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_worker_path_drift',
      timestamp: 2500,
      source: 'reconciliation_probe',
      details: { authoritativeSessionId: 'sess_abc', workspacePath: '/Users/moved/RelayX2' },
    },
  };
  const driftProject: UIProject = { ...project, workerWorkspacePath: '/Users/dev/RelayX' };

  const vm = projectBindingVM({ project: driftProject, sessions: [driftedWorkspaceWorker] });
  const [binding] = vm.bindings;

  assert.equal(binding.worker.verification.status, 'mismatch');
  assert.match(binding.worker.verification.note ?? '', /workspace path differs/);
  assert.equal(binding.worker.discovered?.sessionId, 'sess_abc');
  assert.equal(binding.worker.discovered?.sessionIdVerified, true);
  assert.equal(binding.worker.discovered?.workspacePath, '/Users/moved/RelayX2');
  assert.equal(binding.worker.savedBinding?.value, '/Users/dev/RelayX');
  assert.equal(binding.worker.savedBinding?.kind, 'workspace_path');
});

test('a matching observed workspace with no persisted session id is never a mismatch', () => {
  // No externalSessionId is persisted, the evidence only carries a bind-time
  // session id, and the observed workspace path matches the saved workspace.
  // The discovered value being a session id must not flip this to mismatch.
  const unverifiedSessionWorker: UIRuntimeSession = {
    ...workerSession,
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_worker_workspace_only_match',
      timestamp: 2500,
      source: 'reconciliation_probe',
      details: { sessionId: 'sess_bind_9', workspacePath: '/Users/dev/RelayX' },
    },
  };
  const matchProject: UIProject = { ...project, workerWorkspacePath: '/Users/dev/RelayX' };

  const vm = projectBindingVM({ project: matchProject, sessions: [unverifiedSessionWorker] });
  const [binding] = vm.bindings;

  assert.notEqual(binding.worker.verification.status, 'mismatch');
  assert.equal(binding.worker.verification.status, 'unverified');
  assert.match(binding.worker.verification.note ?? '', /workspace matches/);
  assert.equal(binding.worker.discovered?.reference, 'sess_bind_9');
  assert.equal(binding.worker.discovered?.sessionIdVerified, false);
  assert.equal(binding.worker.savedBinding?.value, '/Users/dev/RelayX');
  assert.equal(binding.worker.savedBinding?.kind, 'workspace_path');
});

test('a recorded identity conflict reports mismatch with a conflict note while retaining the saved binding', () => {
  const conflictedPlanner: UIRuntimeSession = {
    ...plannerSession,
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_planner_conflict',
      timestamp: 2500,
      source: 'window_inspection',
      details: { projectUrl: 'https://chatgpt.com/p/relayx', identityConflict: true },
    },
  };
  const conflictedProject: UIProject = {
    ...project,
    plannerProjectUrl: 'https://chatgpt.com/p/relayx',
  };

  const vm = projectBindingVM({ project: conflictedProject, sessions: [conflictedPlanner] });
  const [binding] = vm.bindings;

  assert.equal(binding.planner.verification.status, 'mismatch');
  assert.match(binding.planner.verification.note ?? '', /identity conflict/);
  assert.equal(binding.planner.savedBinding?.value, 'https://chatgpt.com/p/relayx');
  assert.equal(binding.planner.savedBinding?.kind, 'project_url');
});

test('unbound sides report unavailable without a saved binding and stale with one', () => {
  const unboundPair: UIPair = {
    ...pair,
    plannerSessionId: undefined,
    plannerName: undefined,
    plannerProvider: undefined,
    plannerStatus: undefined,
  };

  // No saved binding anywhere: unavailable.
  const vm = projectBindingVM({ pairs: [unboundPair] });
  const [binding] = vm.bindings;
  assert.equal(binding.planner.bound, false);
  assert.equal(binding.planner.savedBinding, undefined);
  assert.equal(binding.planner.verification.status, 'unavailable');

  // Saved project URL on an unbound side: retained, flagged stale.
  const savedProject: UIProject = { ...project, plannerProjectUrl: 'https://chatgpt.com/p/relayx' };
  const vm2 = projectBindingVM({ project: savedProject, pairs: [unboundPair] });
  const [binding2] = vm2.bindings;
  assert.equal(binding2.planner.bound, false);
  assert.equal(binding2.planner.savedBinding?.value, 'https://chatgpt.com/p/relayx');
  assert.equal(binding2.planner.verification.status, 'stale');
});

test('project detail exposes project-level saved bindings persisted at setup time', () => {
  const boundProject: UIProject = {
    ...project,
    updatedAt: 2000,
    plannerProjectUrl: 'https://chatgpt.com/p/relayx',
    workerWorkspacePath: '/Users/dev/RelayX',
  };
  const vm = projectBindingVM({ project: boundProject, sessions: [plannerSession, workerSession] });
  assert.equal(vm.savedBindings.planner?.value, 'https://chatgpt.com/p/relayx');
  assert.equal(vm.savedBindings.planner?.kind, 'project_url');
  assert.equal(vm.savedBindings.planner?.source, 'project');
  assert.equal(vm.savedBindings.planner?.savedAt, 2000);
  assert.equal(vm.savedBindings.worker?.value, '/Users/dev/RelayX');
  assert.equal(vm.savedBindings.worker?.kind, 'workspace_path');

  const bare = projectBindingVM({ project: { ...project, updatedAt: 1000 } });
  assert.equal(bare.savedBindings.planner, undefined);
  assert.equal(bare.savedBindings.worker, undefined);
});

test('bound planner/worker sessions surface as deduplicated child records with per-session verification', () => {
  // Realistic finalized-project worker: persisted session id confirms the record.
  const boundWorker: UIRuntimeSession = { ...workerSession, externalSessionId: 'sess_abc' };
  const plannerB: UIRuntimeSession = {
    ...plannerSession,
    id: 'runtime_planner_b',
    name: 'ChatGPT: RelayX (archive)',
  };
  const pairB: UIPair = {
    ...pair,
    id: 'pair_2',
    name: 'Archival Pair',
    plannerSessionId: 'runtime_planner_b',
    plannerName: 'ChatGPT: RelayX (archive)',
    workerSessionId: 'runtime_worker',
  };
  const savedProject: UIProject = {
    ...project,
    plannerProjectUrl: 'https://chatgpt.com/p/relayx',
    workerWorkspacePath: '/Users/dev/RelayX',
  };

  const vm = projectBindingVM({
    project: savedProject,
    pairs: [pair, pairB],
    sessions: [plannerSession, boundWorker, plannerB],
  });

  // runtime_worker is referenced by both pairs but appears exactly once.
  assert.deepEqual(
    vm.sessions.map((s) => s.sessionId),
    ['runtime_planner', 'runtime_worker', 'runtime_planner_b'],
  );

  const worker = vm.sessions.find((s) => s.sessionId === 'runtime_worker');
  assert.ok(worker);
  assert.equal(worker.role, 'worker');
  assert.equal(worker.pairName, 'Default Pair');
  assert.equal(worker.savedBinding?.value, '/Users/dev/RelayX');
  assert.equal(worker.savedBinding?.kind, 'workspace_path');
  // Verified via the persisted worker session id the app is bound to.
  assert.equal(worker.verification.status, 'verified');

  const planner = vm.sessions.find((s) => s.sessionId === 'runtime_planner');
  assert.ok(planner);
  assert.equal(planner.role, 'planner');
  assert.equal(planner.savedBinding?.value, 'https://chatgpt.com/p/relayx');
  assert.equal(planner.verification.status, 'verified');
});

/* --- D1/D2 regression: legacy saved session-id + workspace-only discovery --- */
test('legacy saved session-id binding with workspace-only observation is unverified, not mismatch', () => {
  const legacyWorker: UIRuntimeSession = {
    ...workerSession,
    externalSessionId: 'sess_legacy',
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_legacy_workspace_only',
      timestamp: 2500,
      source: 'reconciliation_probe',
      details: { workspacePath: '/Users/dev/RelayX' },
    },
  };
  const legacyProject: UIProject = {
    ...project,
    plannerProjectUrl: 'https://chatgpt.com/p/relayx',
  };
  const vm = projectBindingVM({ project: legacyProject, pairs: [pair], sessions: [legacyWorker] });
  const [binding] = vm.bindings;
  assert.equal(binding.worker.verification.status, 'unverified');
  assert.notEqual(binding.worker.verification.status, 'mismatch');
  assert.equal(binding.worker.savedBinding?.value, 'sess_legacy');
  assert.equal(binding.worker.savedBinding?.kind, 'session_id');
  assert.equal(binding.worker.savedBinding?.source, 'runtime');
  assert.equal(binding.worker.discovered?.kind, 'workspace_path');
  assert.equal(binding.worker.discovered?.sessionIdVerified, false);
  assert.equal(binding.worker.discovered?.workspacePath, '/Users/dev/RelayX');
  assert.match(binding.worker.verification.note ?? '', /No session ID was observed/);
});

test('matching workspace path with no verified session id stays unverified (not verified)', () => {
  const workspaceOnlyWorker: UIRuntimeSession = {
    ...workerSession,
    externalSessionId: undefined,
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_workspace_match_unverified',
      timestamp: 2500,
      source: 'window_inspection',
      details: { workspacePath: '/Users/dev/RelayX' },
    },
  };
  const workspaceProject: UIProject = { ...project, workerWorkspacePath: '/Users/dev/RelayX' };
  const vm = projectBindingVM({ project: workspaceProject, pairs: [pair], sessions: [workspaceOnlyWorker] });
  const [binding] = vm.bindings;
  assert.equal(binding.worker.verification.status, 'unverified');
  assert.equal(binding.worker.savedBinding?.value, '/Users/dev/RelayX');
  assert.equal(binding.worker.savedBinding?.kind, 'workspace_path');
  assert.equal(binding.worker.discovered?.sessionIdVerified, false);
  assert.equal(binding.worker.discovered?.workspacePath, '/Users/dev/RelayX');
});

test('conflicting verified session id and genuine workspace drift both remain mismatch', () => {
  const conflictWorker: UIRuntimeSession = {
    ...workerSession,
    externalSessionId: 'sess_conflict',
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_conflict_id',
      timestamp: 2500,
      source: 'reconciliation_probe',
      details: {
        authoritativeSessionId: 'sess_different',
        identityConflict: true,
        persistedExternalSessionId: 'sess_conflict',
        observedAuthoritativeSessionId: 'sess_different',
        workspacePath: '/Users/dev/RelayX',
      },
    },
  };
  const driftWorker: UIRuntimeSession = {
    ...workerSession,
    externalSessionId: 'sess_abc',
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_path_drift',
      timestamp: 2500,
      source: 'reconciliation_probe',
      details: { authoritativeSessionId: 'sess_abc', workspacePath: '/Users/moved/RelayX2' },
    },
  };
  const savedProject: UIProject = {
    ...project,
    plannerProjectUrl: 'https://chatgpt.com/p/relayx',
    workerWorkspacePath: '/Users/dev/RelayX',
  };
  const conflictVM = projectBindingVM({ project: savedProject, pairs: [pair], sessions: [conflictWorker] });
  const conflictBinding = conflictVM.bindings[0].worker;
  assert.equal(conflictBinding.verification.status, 'mismatch');
  assert.match(conflictBinding.verification.note ?? '', /identity conflict/);
  const driftVM = projectBindingVM({ project: savedProject, pairs: [pair], sessions: [driftWorker] });
  const driftBinding = driftVM.bindings[0].worker;
  assert.equal(driftBinding.verification.status, 'mismatch');
  assert.match(driftBinding.verification.note ?? '', /workspace path differs/);
  assert.equal(driftBinding.discovered?.sessionIdVerified, true);
});
/* --- D3 regression: planner binding-origin vs independent authoritative observation --- */
test('setup-only planner evidence is unverified, not self-verified', () => {
  const setupPlanner: UIRuntimeSession = {
    ...plannerSession,
    id: 'runtime_planner_setup',
    lastObservedAt: 1500,
    lastEvidence: {
      id: 'ev_bind_setup',
      timestamp: 1500,
      source: 'reconciliation_probe',
      details: { projectUrl: 'https://chatgpt.com/p/setup-project', bindingRecorded: true },
    },
  };
  const savedProject: UIProject = {
    ...project,
    plannerProjectUrl: 'https://chatgpt.com/p/setup-project',
    workerWorkspacePath: '/Users/dev/RelayX',
  };
  const setupPair: UIPair = {
    ...pair,
    plannerSessionId: 'runtime_planner_setup',
    plannerName: 'ChatGPT: Setup',
    plannerProvider: 'chatgpt',
    plannerStatus: 'available',
  };
  const vm = projectBindingVM({ project: savedProject, pairs: [setupPair], sessions: [setupPlanner] });
  const [binding] = vm.bindings;
  assert.equal(binding.planner.bound, true);
  assert.equal(binding.planner.savedBinding?.value, 'https://chatgpt.com/p/setup-project');
  assert.equal(binding.planner.verification.status, 'unverified');
  assert.notEqual(binding.planner.verification.status, 'verified');
  assert.equal(binding.planner.discovered?.bindingRecorded, true);
  assert.equal(binding.planner.discovered?.sessionIdVerified, false);
});

test('independent authoritative planner observation confirms saved binding as verified', () => {
  const verifiedPlanner: UIRuntimeSession = {
    ...plannerSession,
    id: 'runtime_planner_verified',
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_planner_verified_indep',
      timestamp: 2500,
      source: 'window_inspection',
      details: { projectUrl: 'https://chatgpt.com/p/relayx' },
    },
  };
  const savedProject: UIProject = {
    ...project,
    plannerProjectUrl: 'https://chatgpt.com/p/relayx',
    workerWorkspacePath: '/Users/dev/RelayX',
  };
  const verifiedPair: UIPair = {
    ...pair,
    plannerSessionId: 'runtime_planner_verified',
    plannerName: 'ChatGPT: Verified',
    plannerProvider: 'chatgpt',
    plannerStatus: 'available',
  };
  const vm = projectBindingVM({ project: savedProject, pairs: [verifiedPair], sessions: [verifiedPlanner] });
  const [binding] = vm.bindings;
  assert.equal(binding.planner.verification.status, 'verified');
  assert.equal(binding.planner.savedBinding?.value, 'https://chatgpt.com/p/relayx');
  assert.equal(binding.planner.discovered?.bindingRecorded, undefined);
  assert.equal(binding.planner.discovered?.sessionIdVerified, true);
});

test('planner discovery failure after setup keeps saved URL unverified or stale', () => {
  const stalePlanner: UIRuntimeSession = {
    ...plannerSession,
    status: 'suspended',
    lastObservedAt: 900,
    lastEvidence: {
      id: 'ev_planner_stale',
      timestamp: 900,
      source: 'reconciliation_probe',
      details: { windowTitle: 'ChatGPT - RelayX' },
    },
  };
  const savedProject: UIProject = {
    ...project,
    updatedAt: 2000,
    plannerProjectUrl: 'https://chatgpt.com/p/relayx',
  };
  const vm = projectBindingVM({ project: savedProject, pairs: [pair], sessions: [stalePlanner] });
  const [binding] = vm.bindings;
  assert.equal(binding.planner.savedBinding?.value, 'https://chatgpt.com/p/relayx');
  assert.equal(binding.planner.savedBinding?.kind, 'project_url');
  assert.equal(binding.planner.savedBinding?.source, 'project');
  assert.equal(binding.planner.verification.status, 'stale');
  assert.match(binding.planner.verification.note ?? '', /could not reverify/);
});

test('conflicting planner observation produces mismatch without erasing saved binding', () => {
  const conflictPlanner: UIRuntimeSession = {
    ...plannerSession,
    id: 'runtime_planner_conflict',
    lastObservedAt: 2500,
    lastEvidence: {
      id: 'ev_planner_conflict',
      timestamp: 2500,
      source: 'reconciliation_probe',
      details: { projectUrl: 'https://chatgpt.com/p/different-project', identityConflict: true },
    },
  };
  const savedProject: UIProject = {
    ...project,
    plannerProjectUrl: 'https://chatgpt.com/p/relayx',
  };
  const conflictPair: UIPair = {
    ...pair,
    plannerSessionId: 'runtime_planner_conflict',
    plannerName: 'ChatGPT: Conflict',
    plannerProvider: 'chatgpt',
    plannerStatus: 'available',
  };
  const vm = projectBindingVM({ project: savedProject, pairs: [conflictPair], sessions: [conflictPlanner] });
  const [binding] = vm.bindings;
  assert.equal(binding.planner.savedBinding?.value, 'https://chatgpt.com/p/relayx');
  assert.equal(binding.planner.verification.status, 'mismatch');
  assert.equal(binding.planner.discovered?.reference, 'https://chatgpt.com/p/different-project');
});
