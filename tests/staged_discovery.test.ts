import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLANNER_IDLE_STATE,
  OPENCODE_IDLE_STATE,
  areBothBindingsValid,
  beginPlannerDiscovery,
  beginOpenCodeDiscovery,
  reducePlannerDiscovery,
  reduceOpenCodeDiscovery,
  failPlannerDiscovery,
  failOpenCodeDiscovery,
  isPlannerBindingValid,
  isOpenCodeBindingValid,
  selectPlannerCandidate,
} from '../src/relay/application/stagedDiscovery.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { ChatGPTProvider, OpenCodeProvider } from '../src/relay/providers/adapters.ts';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const PLANNER_URL = 'https://chatgpt.com/g/g-p-alpha-project/project';
const WORKER_SESSION = 'ses_alpha_authoritative_1';

const plannerSuccess = (finalUrl = PLANNER_URL, projectName = 'Alpha Project') => ({
  success: true,
  finalUrl,
  projectName,
});

const plannerFailure = (error = 'no matching ChatGPT project found') => ({
  success: false,
  error,
});

const openCodeSuccess = (sessionId = WORKER_SESSION, windowTitle = 'OpenCode — Alpha Project') => ({
  success: true,
  sessions: [
    {
      sessionId,
      windowTitle,
      workspacePath: '/workspaces/alpha',
      matchedVia: 'exact_path',
      matchScore: 100,
    },
  ],
});

const openCodeFailure = (error = 'no matching OpenCode session found') => ({
  success: false,
  sessions: [] as Array<{ sessionId?: string }>,
  error,
});

/* ------------------------------------------------------------------ */
/* 1. Planner succeeds while OpenCode fails                            */
/* ------------------------------------------------------------------ */

describe('independent planner/worker discovery stages', () => {
  it('keeps the planner binding when OpenCode discovery fails', () => {
    const planner = reducePlannerDiscovery(PLANNER_IDLE_STATE, plannerSuccess());
    const opencode = reduceOpenCodeDiscovery(OPENCODE_IDLE_STATE, openCodeFailure());

    assert.equal(planner.status, 'discovered');
    assert.equal(planner.url, PLANNER_URL);
    assert.equal(planner.evidence?.finalUrl, PLANNER_URL);
    assert.ok(isPlannerBindingValid(planner), 'planner binding should be valid');

    assert.equal(opencode.status, 'failed');
    assert.equal(opencode.error, 'no matching OpenCode session found');
    assert.equal(opencode.selectedSessionId, undefined);
    assert.ok(!isOpenCodeBindingValid(opencode), 'worker binding should be invalid');

    // Setup cannot complete with only one side valid.
    assert.equal(areBothBindingsValid(planner, opencode), false);
  });

  /* ---------------------------------------------------------------- */
  /* 2. OpenCode succeeds while planner fails                          */
  /* ---------------------------------------------------------------- */

  it('keeps the OpenCode binding when planner discovery fails', () => {
    const planner = reducePlannerDiscovery(PLANNER_IDLE_STATE, plannerFailure());
    const opencode = reduceOpenCodeDiscovery(OPENCODE_IDLE_STATE, openCodeSuccess());

    assert.equal(planner.status, 'failed');
    assert.equal(planner.error, 'no matching ChatGPT project found');
    assert.equal(planner.url, undefined);
    assert.ok(!isPlannerBindingValid(planner));

    assert.equal(opencode.status, 'discovered');
    assert.equal(opencode.selectedSessionId, WORKER_SESSION);
    assert.equal(opencode.evidence?.sessionId, WORKER_SESSION);
    assert.ok(isOpenCodeBindingValid(opencode), 'worker binding should be valid');

    assert.equal(areBothBindingsValid(planner, opencode), false);
  });

  /* ---------------------------------------------------------------- */
  /* 3. Retrying one side preserves the successful side                */
  /* ---------------------------------------------------------------- */

  it('retrying the failed OpenCode side preserves the confirmed planner binding', () => {
    const planner = reducePlannerDiscovery(PLANNER_IDLE_STATE, plannerSuccess());
    const plannerSnapshot = { ...planner };

    let opencode = reduceOpenCodeDiscovery(OPENCODE_IDLE_STATE, openCodeFailure());
    assert.equal(opencode.status, 'failed');

    // Retry ONLY OpenCode.
    opencode = beginOpenCodeDiscovery(opencode);
    assert.equal(opencode.status, 'discovering');
    opencode = reduceOpenCodeDiscovery(opencode, openCodeSuccess());

    assert.equal(opencode.status, 'discovered');
    assert.ok(isOpenCodeBindingValid(opencode));

    // The planner binding must be completely untouched by the retry.
    assert.deepEqual(planner, plannerSnapshot);
    assert.equal(planner.url, PLANNER_URL);
    assert.ok(areBothBindingsValid(planner, opencode));
  });

  it('retrying the failed planner side preserves the confirmed OpenCode binding', () => {
    const opencode = reduceOpenCodeDiscovery(OPENCODE_IDLE_STATE, openCodeSuccess());
    const opencodeSnapshot = { ...opencode };

    let planner = reducePlannerDiscovery(PLANNER_IDLE_STATE, plannerFailure());

    // Retry ONLY the planner.
    planner = beginPlannerDiscovery(planner);
    assert.equal(planner.status, 'discovering');
    planner = reducePlannerDiscovery(planner, plannerSuccess());

    assert.equal(planner.status, 'discovered');
    assert.ok(isPlannerBindingValid(planner));

    assert.deepEqual(opencode, opencodeSnapshot);
    assert.equal(opencode.selectedSessionId, WORKER_SESSION);
    assert.ok(areBothBindingsValid(planner, opencode));
  });

  /* ---------------------------------------------------------------- */
  /* 4. Independent progress / error state                             */
  /* ---------------------------------------------------------------- */

  it('tracks progress and errors per stage without cross-contamination', () => {
    // OpenCode already confirmed.
    const opencode = reduceOpenCodeDiscovery(OPENCODE_IDLE_STATE, openCodeSuccess());
    assert.equal(opencode.status, 'discovered');

    // Planner is in progress: OpenCode stays discovered.
    const discoveringPlanner = beginPlannerDiscovery(PLANNER_IDLE_STATE);
    assert.equal(discoveringPlanner.status, 'discovering');
    assert.equal(opencode.status, 'discovered');
    assert.equal(opencode.error, undefined);

    // Planner then fails: its own error is set, OpenCode remains clean/valid.
    const failedPlanner = reducePlannerDiscovery(
      discoveringPlanner,
      plannerFailure('ChatGPT window not found'),
    );
    assert.equal(failedPlanner.status, 'failed');
    assert.equal(failedPlanner.error, 'ChatGPT window not found');
    assert.equal(opencode.status, 'discovered');
    assert.equal(opencode.error, undefined);
    assert.equal(opencode.selectedSessionId, WORKER_SESSION);
    assert.ok(isOpenCodeBindingValid(opencode));

    // A thrown OpenCode error must not clear a confirmed planner binding.
    const confirmedPlanner = reducePlannerDiscovery(PLANNER_IDLE_STATE, plannerSuccess());
    const thrownOpenCode = failOpenCodeDiscovery(
      beginOpenCodeDiscovery(OPENCODE_IDLE_STATE),
      'bridge unavailable',
    );
    assert.equal(thrownOpenCode.status, 'failed');
    assert.equal(thrownOpenCode.error, 'bridge unavailable');
    assert.equal(confirmedPlanner.status, 'discovered');
    assert.equal(confirmedPlanner.error, undefined);
    assert.ok(isPlannerBindingValid(confirmedPlanner));
  });

  /* ---------------------------------------------------------------- */
  /* 5. Activation-only "success" is rejected                          */
  /* ---------------------------------------------------------------- */

  it('rejects planner success that carries no validated project URL', () => {
    const noUrl = reducePlannerDiscovery(PLANNER_IDLE_STATE, { success: true } as any);
    assert.equal(noUrl.status, 'failed');
    assert.equal(noUrl.url, undefined);
    assert.ok(!isPlannerBindingValid(noUrl));

    const blankUrl = reducePlannerDiscovery(PLANNER_IDLE_STATE, {
      success: true,
      finalUrl: '   ',
    } as any);
    assert.equal(blankUrl.status, 'failed');
    assert.ok(!isPlannerBindingValid(blankUrl));

    // A bare projectUrl without a resolved finalUrl is activation-only noise.
    const projectUrlOnly = reducePlannerDiscovery(PLANNER_IDLE_STATE, {
      success: true,
      projectUrl: 'https://chatgpt.com/p/some-id',
    } as any);
    assert.equal(projectUrlOnly.status, 'failed');
    assert.ok(!isPlannerBindingValid(projectUrlOnly));
  });

  it('rejects OpenCode success that carries no authoritative session id', () => {
    const noSessions = reduceOpenCodeDiscovery(OPENCODE_IDLE_STATE, {
      success: true,
      sessions: [],
    });
    assert.equal(noSessions.status, 'failed');
    assert.equal(noSessions.selectedSessionId, undefined);
    assert.ok(!isOpenCodeBindingValid(noSessions));

    const noId = reduceOpenCodeDiscovery(OPENCODE_IDLE_STATE, {
      success: true,
      sessions: [{ windowTitle: 'OpenCode window opened' }],
    } as any);
    assert.equal(noId.status, 'failed');
    assert.ok(!isOpenCodeBindingValid(noId));

    const blankId = reduceOpenCodeDiscovery(OPENCODE_IDLE_STATE, {
      success: true,
      sessions: [{ sessionId: '   ' }],
    } as any);
    assert.equal(blankId.status, 'failed');
    assert.ok(!isOpenCodeBindingValid(blankId));
  });

  it('requires explicit confirmation for an ambiguous planner match', () => {
    const ambiguous = reducePlannerDiscovery(PLANNER_IDLE_STATE, {
      success: false,
      error: 'Multiple projects found',
      foundMultiple: [
        { name: 'Alpha Project', url: 'https://chatgpt.com/p/alpha-1' },
        { name: 'Alpha Project (Archived)', url: 'https://chatgpt.com/p/alpha-old' },
      ],
    } as any);

    assert.equal(ambiguous.status, 'failed');
    assert.equal(ambiguous.multiple?.length, 2);
    assert.ok(!isPlannerBindingValid(ambiguous));

    const confirmed = selectPlannerCandidate(ambiguous, ambiguous.multiple![0]);
    assert.equal(confirmed.status, 'discovered');
    assert.equal(confirmed.url, 'https://chatgpt.com/p/alpha-1');
    assert.equal(confirmed.multiple, undefined);
    assert.ok(isPlannerBindingValid(confirmed));
  });

  /* ---------------------------------------------------------------- */
  /* 6. Both validated bindings allow setup completion                 */
  /* ---------------------------------------------------------------- */

  it('completes project setup when both bindings are independently validated', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    engine.registerProvider(new ChatGPTProvider());
    engine.registerProvider(new OpenCodeProvider());
    const service = new RelayApiService(db, engine);

    // Mock the provider-specific discovery only; orchestration stays real.
    const chatgpt = engine.getProvider('chatgpt') as any;
    chatgpt.resolveChatGPTProject = async () => plannerSuccess();

    const opencodeProvider = engine.getProvider('opencode') as any;
    opencodeProvider.matchSessionsByPath = async () => ({
      success: true,
      sessions: [
        {
          found: true,
          status: 'available',
          windowTitle: 'OpenCode — Alpha Project',
          bundleIdentifier: 'dev.opencode.desktop',
          evidence: {
            id: 'ev_alpha_1',
            timestamp: Date.now(),
            source: 'macos_system_events',
            details: {
              parsedSessionId: WORKER_SESSION,
              workspacePath: '/workspaces/alpha',
              matchedVia: 'exact_path',
              matchScore: 100,
            },
          },
        },
      ],
    });

    // Drive each independent discovery through the real API boundary,
    // then translate the results with the shared state reducers.
    const plannerResult = await service.discoverChatGPTPlanner('Alpha Project');
    const planner = reducePlannerDiscovery(PLANNER_IDLE_STATE, plannerResult);

    const opencodeResult = await service.discoverOpenCodeSessions('/workspaces/alpha', '/workspaces/alpha');
    const opencode = reduceOpenCodeDiscovery(OPENCODE_IDLE_STATE, opencodeResult);

    assert.ok(isPlannerBindingValid(planner));
    assert.ok(isOpenCodeBindingValid(opencode));
    assert.ok(areBothBindingsValid(planner, opencode));

    const res = await service.finalizeProjectSetup({
      name: 'Alpha Project',
      description: 'Independent discovery workflow',
      canonicalPath: '/workspaces/alpha',
      gitRoot: '/workspaces/alpha',
      plannerUrl: planner.url,
      workerSessionId: opencode.selectedSessionId,
    });

    assert.equal(res.success, true);
    assert.ok(res.projectId);

    const pairs = await db.pairs.findByProjectId(res.projectId as any);
    assert.equal(pairs.length, 1);
    assert.ok(pairs[0].plannerSessionId, 'planner binding persisted');
    assert.ok(pairs[0].workerSessionId, 'worker binding persisted');

    const persistedPlanner = await db.runtimes.findById(pairs[0].plannerSessionId!);
    assert.equal(persistedPlanner?.providerType, 'chatgpt');
    assert.equal(
      (persistedPlanner?.lastEvidence?.details as any)?.projectUrl,
      PLANNER_URL,
    );

    const persistedWorker = await db.runtimes.findById(pairs[0].workerSessionId!);
    assert.equal(persistedWorker?.providerType, 'opencode');
    assert.equal(
      (persistedWorker?.lastEvidence?.details as any)?.sessionId,
      WORKER_SESSION,
    );
  });
});
