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
