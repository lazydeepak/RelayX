import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Project, RuntimeSession } from '../src/relay/domain/entities.ts';
import { ProjectId, ProviderType } from '../src/relay/domain/types.ts';

const PROJECT_ID = 'proj-planner-creation' as ProjectId;
const PROJECT_SLUG = 'g-p-6a9d699a8a488191a554385d74bb9422';
const PLANNER_PROJECT_URL = `https://chatgpt.com/g/${PROJECT_SLUG}/project`;
const WORKSPACE = '/workspaces/relay-fresh-test';

interface HarnessOptions {
  createPlanner?: () => Promise<{
    conversationId: string;
    conversationUrl: string;
    projectSlug: string;
    error?: string;
  }>;
  createWorker?: () => Promise<{
    sessionId: string;
    workspaceDir: string;
    error?: string;
  }>;
  confirmWorker?: (sessionId: string, projectPath: string) => Promise<{
    confirmed: boolean;
    externalSessionId?: string | null;
    projectPath?: string;
  }>;
}

async function makeHarness(options: HarnessOptions = {}) {
  const db = new MemoryRelayDatabase();
  const engine = new RelayEngine(db);

  let plannerCreateCalls = 0;
  let workerCreateCalls = 0;

  engine.registerProvider({
    providerType: 'chatgpt',
    integrationStatus: 'partial',
    canonicalizeChatGPTProjectUrl(url: string) {
      return `https://chatgpt.com/g/${PROJECT_SLUG}/project`;
    },
    async createPlannerSession(projectUrl: string, name?: string) {
      plannerCreateCalls += 1;
      if (options.createPlanner) {
        return options.createPlanner();
      }
      return {
        conversationId: 'conv_default_123',
        conversationUrl: `https://chatgpt.com/g/${PROJECT_SLUG}/c/conv_default_123`,
        projectSlug: PROJECT_SLUG,
      };
    },
  } as any);

  engine.registerProvider({
    providerType: 'opencode',
    integrationStatus: 'partial',
    async createWorkerSession(workspaceDir: string, name?: string) {
      workerCreateCalls += 1;
      if (options.createWorker) {
        return options.createWorker();
      }
      return {
        sessionId: 'ses_worker_default_456',
        workspaceDir: WORKSPACE,
      };
    },
    async confirmSessionForProject(sessionId: string, projectPath: string) {
      if (options.confirmWorker) {
        return options.confirmWorker(sessionId, projectPath);
      }
      return {
        confirmed: true,
        externalSessionId: sessionId,
        projectPath,
      };
    },
  } as any);

  await db.projects.save(
    new Project({
      id: PROJECT_ID,
      name: 'Fresh Pair Project',
      description: 'Project testing fresh planner creation',
      canonicalPath: WORKSPACE,
      plannerProjectUrl: PLANNER_PROJECT_URL,
      workerWorkspacePath: WORKSPACE,
      gitRoot: WORKSPACE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  return {
    db,
    engine,
    api: new RelayApiService(db, engine),
    plannerCreateCalls: () => plannerCreateCalls,
    workerCreateCalls: () => workerCreateCalls,
  };
}

describe('Fresh Planner session creation & atomic new/new Pair provisioning', () => {
  it('1. successful fresh Planner creation returns authoritative external identity', async () => {
    const harness = await makeHarness({
      createPlanner: async () => ({
        conversationId: 'conv_auth_789',
        conversationUrl: `https://chatgpt.com/g/${PROJECT_SLUG}/c/conv_auth_789`,
        projectSlug: PROJECT_SLUG,
      }),
    });

    const result = await harness.api.createChatGPTPlannerSession(PROJECT_ID, 'Fresh Lead Planner');
    assert.strictEqual(harness.plannerCreateCalls(), 1);
    assert.strictEqual(result.adopted, true);
    assert.strictEqual(result.conversationId, 'conv_auth_789');
    assert.strictEqual(result.conversationUrl, `https://chatgpt.com/g/${PROJECT_SLUG}/c/conv_auth_789`);
    assert.ok(result.runtime);
    assert.strictEqual(result.runtime.externalSessionId, 'conv_auth_789');
    assert.strictEqual(result.runtime.externalProjectRef, PLANNER_PROJECT_URL);

    // Verify persisted in DB with authoritative adoption evidence
    const reloaded = await harness.db.runtimes.findByExternalSessionId('chatgpt', 'conv_auth_789');
    assert.ok(reloaded);
    assert.strictEqual(reloaded.id, result.runtime.id);
    const associations = await harness.db.associations.findBySessionId(reloaded.id);
    assert.strictEqual(associations.length, 1);
    assert.strictEqual(associations[0].provenance, 'adoption');
    assert.strictEqual(associations[0].externalSessionId, 'conv_auth_789');
  });

  it('2. planner creation with no verifiable external identity fails closed', async () => {
    const harness = await makeHarness({
      createPlanner: async () => ({
        conversationId: '',
        conversationUrl: '',
        projectSlug: PROJECT_SLUG,
        error: 'Chrome automation could not verify /c/<id> URL',
      }),
    });

    const result = await harness.api.createChatGPTPlannerSession(PROJECT_ID, 'Failed Planner');
    assert.strictEqual(harness.plannerCreateCalls(), 1);
    assert.strictEqual(result.adopted, false);
    assert.strictEqual(result.partial, true);
    assert.match(result.error ?? '', /could not verify/i);

    // DB must not store any runtime or association
    const runtimes = await harness.db.runtimes.findAll();
    assert.strictEqual(runtimes.length, 0);
  });

  it('3. existing Planner adoption still works', async () => {
    const harness = await makeHarness();

    // Create an existing unbound planner runtime and a worker runtime
    const existingPlanner = RuntimeSession.create('chatgpt' as ProviderType, 'Existing Unbound Planner');
    existingPlanner.updateExternalIdentity(null, PLANNER_PROJECT_URL);
    await harness.db.runtimes.save(existingPlanner);

    const existingWorker = RuntimeSession.create('opencode' as ProviderType, 'Existing Worker');
    existingWorker.updateExternalIdentity('ses_worker_existing_111', WORKSPACE);
    await harness.db.runtimes.save(existingWorker);
    await harness.db.associations.save({
      id: 'assoc-w-1',
      runtimeSessionId: existingWorker.id,
      projectId: PROJECT_ID,
      providerType: 'opencode',
      externalSessionId: 'ses_worker_existing_111',
      externalProjectRef: WORKSPACE,
      verificationState: 'verified',
      provenance: 'adoption',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const pair = await harness.api.createPair(
      PROJECT_ID,
      'Adopted Existing Pair',
      existingPlanner.id,
      existingWorker.id,
      `https://chatgpt.com/g/${PROJECT_SLUG}/c/conv-adopted-manually`,
    );

    assert.ok(pair);
    assert.strictEqual(pair.plannerSessionId, existingPlanner.id);
    assert.strictEqual(pair.workerSessionId, existingWorker.id);

    const reloadedPlanner = await harness.db.runtimes.findById(existingPlanner.id);
    assert.strictEqual(reloadedPlanner?.externalSessionId, 'conv-adopted-manually');
  });

  it('4. fresh Planner + fresh Worker creates one correct Pair', async () => {
    const harness = await makeHarness({
      createPlanner: async () => ({
        conversationId: 'conv_fresh_101',
        conversationUrl: `https://chatgpt.com/g/${PROJECT_SLUG}/c/conv_fresh_101`,
        projectSlug: PROJECT_SLUG,
      }),
      createWorker: async () => ({
        sessionId: 'ses_fresh_202',
        workspaceDir: WORKSPACE,
      }),
    });

    const result = await harness.api.provisionPairWithNewSessions(PROJECT_ID, 'New/New Feature Pair', {
      plannerName: 'Sprint Planner',
      workerName: 'Feature Worker',
    });

    assert.strictEqual(harness.plannerCreateCalls(), 1);
    assert.strictEqual(harness.workerCreateCalls(), 1);

    assert.ok(result.pair);
    assert.strictEqual(result.pair.name, 'New/New Feature Pair');
    assert.strictEqual(result.pair.plannerSessionId, result.plannerRuntime.id);
    assert.strictEqual(result.pair.workerSessionId, result.workerRuntime.id);
    assert.strictEqual(result.plannerRuntime.externalSessionId, 'conv_fresh_101');
    assert.strictEqual(result.workerRuntime.externalSessionId, 'ses_fresh_202');

    // Exactly one pair in database
    const allPairs = await harness.db.pairs.findAll();
    assert.strictEqual(allPairs.length, 1);
    assert.strictEqual(allPairs[0].id, result.pair.id);
  });

  it('5. Planner creation failure prevents falsely completed Pair creation', async () => {
    const harness = await makeHarness({
      createPlanner: async () => ({
        conversationId: '',
        conversationUrl: '',
        projectSlug: PROJECT_SLUG,
        error: 'Failed to access Chrome ChatGPT tab',
      }),
      createWorker: async () => ({
        sessionId: 'ses_should_not_be_created',
        workspaceDir: WORKSPACE,
      }),
    });

    await assert.rejects(
      () =>
        harness.api.provisionPairWithNewSessions(PROJECT_ID, 'Failed Provision Pair', {
          plannerName: 'Failing Planner',
        }),
      /Failed to access Chrome ChatGPT tab/,
    );

    // Planner failed: Worker creation must not even be attempted
    assert.strictEqual(harness.plannerCreateCalls(), 1);
    assert.strictEqual(harness.workerCreateCalls(), 0);

    // No pair must exist
    const pairs = await harness.db.pairs.findAll();
    assert.strictEqual(pairs.length, 0);

    // No runtimes must exist
    const runtimes = await harness.db.runtimes.findAll();
    assert.strictEqual(runtimes.length, 0);
  });

  it('6. Worker creation failure after Planner creation cleans up orphaned planner session so no half-pair/half-binding survives', async () => {
    const harness = await makeHarness({
      createPlanner: async () => ({
        conversationId: 'conv_preserved_planner_777',
        conversationUrl: `https://chatgpt.com/g/${PROJECT_SLUG}/c/conv_preserved_planner_777`,
        projectSlug: PROJECT_SLUG,
      }),
      createWorker: async () => ({
        sessionId: '',
        workspaceDir: '',
        error: 'OpenCode CLI exited with error 1',
      }),
    });

    await assert.rejects(
      () =>
        harness.api.provisionPairWithNewSessions(PROJECT_ID, 'Partially Failed Pair', {
          plannerName: 'Preserved Planner',
        }),
      /Failed to create worker session/,
    );

    assert.strictEqual(harness.plannerCreateCalls(), 1);
    assert.strictEqual(harness.workerCreateCalls(), 1);

    // No pair was created
    const pairs = await harness.db.pairs.findAll();
    assert.strictEqual(pairs.length, 0);

    // No orphaned runtime survives in database (half-pair/half-binding cleaned up)
    const runtimes = await harness.db.runtimes.findAll();
    assert.strictEqual(runtimes.length, 0);
  });

  it('7. Pair stores the exact returned Planner and Worker Session IDs', async () => {
    const harness = await makeHarness({
      createPlanner: async () => ({
        conversationId: 'conv_exact_p1',
        conversationUrl: `https://chatgpt.com/g/${PROJECT_SLUG}/c/conv_exact_p1`,
        projectSlug: PROJECT_SLUG,
      }),
      createWorker: async () => ({
        sessionId: 'ses_exact_w1',
        workspaceDir: WORKSPACE,
      }),
    });

    const result = await harness.api.provisionPairWithNewSessions(PROJECT_ID, 'Exact Binding Pair');

    const pairInDb = await harness.db.pairs.findById(result.pair.id as any);
    assert.ok(pairInDb);
    assert.strictEqual(pairInDb.plannerSessionId, result.plannerRuntime.id);
    assert.strictEqual(pairInDb.workerSessionId, result.workerRuntime.id);

    const plannerInDb = await harness.db.runtimes.findById(result.plannerRuntime.id as any);
    assert.strictEqual(plannerInDb?.externalSessionId, 'conv_exact_p1');

    const workerInDb = await harness.db.runtimes.findById(result.workerRuntime.id as any);
    assert.strictEqual(workerInDb?.externalSessionId, 'ses_exact_w1');
  });

  it('8. no accidental reuse of an existing Planner conversation', async () => {
    const harness = await makeHarness({
      createPlanner: async () => ({
        conversationId: 'conv_already_bound',
        conversationUrl: `https://chatgpt.com/g/${PROJECT_SLUG}/c/conv_already_bound`,
        projectSlug: PROJECT_SLUG,
      }),
    });

    // Seed existing runtime already bound to conv_already_bound
    const preExisting = RuntimeSession.create('chatgpt' as ProviderType, 'Already Bound Runtime');
    preExisting.updateExternalIdentity('conv_already_bound', PLANNER_PROJECT_URL);
    await harness.db.runtimes.save(preExisting);

    // Attempting to create a planner session that returns conv_already_bound must fail closed
    const res = await harness.api.createChatGPTPlannerSession(PROJECT_ID, 'Duplicate Planner Attempt');
    assert.strictEqual(res.adopted, false);
    assert.strictEqual(res.partial, true);
    assert.match(res.error ?? '', /already (?:bound|observed)/i);

    // Only the pre-existing runtime exists in DB; no new runtime was created
    const allRuntimes = await harness.db.runtimes.findAll();
    assert.strictEqual(allRuntimes.length, 1);
    assert.strictEqual(allRuntimes[0].id, preExisting.id);
  });

  it('9. pre-create UI path: pre-creating planner session reuses it on Pair submit without creating a second external session', async () => {
    const harness = await makeHarness({
      createPlanner: async () => ({
        conversationId: 'conv_precreated_1',
        conversationUrl: `https://chatgpt.com/g/${PROJECT_SLUG}/c/conv_precreated_1`,
        projectSlug: PROJECT_SLUG,
      }),
      createWorker: async () => ({
        sessionId: 'ses_worker_precreate_1',
        workspaceDir: WORKSPACE,
      }),
    });

    // Step A: Operator clicks "Create Session" in PairModal before submitting the pair
    const preCreatePlannerRes = await harness.api.createChatGPTPlannerSession(
      PROJECT_ID,
      'Pre-created Planner',
    );
    assert.strictEqual(preCreatePlannerRes.adopted, true);
    assert.strictEqual(preCreatePlannerRes.conversationId, 'conv_precreated_1');
    assert.strictEqual(harness.plannerCreateCalls(), 1);

    // Also pre-create worker session
    const preCreateWorkerRes = await harness.api.createOpenCodeWorkerSession(
      PROJECT_ID,
      'Pre-created Worker',
    );
    assert.strictEqual(preCreateWorkerRes.adopted, true);
    assert.strictEqual(preCreateWorkerRes.sessionId, 'ses_worker_precreate_1');
    assert.strictEqual(harness.workerCreateCalls(), 1);

    // Step B: Operator submits PairModal (createPair with pre-created session IDs)
    const pair = await harness.api.createPair(
      PROJECT_ID,
      'Precreated Pair',
      preCreatePlannerRes.runtime!.id,
      preCreateWorkerRes.runtime!.id,
      preCreatePlannerRes.conversationUrl,
    );

    assert.ok(pair);
    assert.strictEqual(pair.plannerSessionId, preCreatePlannerRes.runtime!.id);
    assert.strictEqual(pair.workerSessionId, preCreateWorkerRes.runtime!.id);

    // INVARIANT: Exactly one external planner session and one external worker session created
    assert.strictEqual(harness.plannerCreateCalls(), 1);
    assert.strictEqual(harness.workerCreateCalls(), 1);

    const runtimes = await harness.db.runtimes.findAll();
    assert.strictEqual(runtimes.length, 2);
  });

  it('10. persistence uniqueness constraint: duplicate provider_type + external_session_id is rejected at DB layer', async () => {
    const harness = await makeHarness();

    const runtime1 = RuntimeSession.create('chatgpt' as ProviderType, 'Runtime One');
    runtime1.updateExternalIdentity('conv_duplicate_constraint', PLANNER_PROJECT_URL);
    await harness.db.runtimes.save(runtime1);

    const runtime2 = RuntimeSession.create('chatgpt' as ProviderType, 'Runtime Two');
    runtime2.updateExternalIdentity('conv_duplicate_constraint', PLANNER_PROJECT_URL);

    await assert.rejects(
      () => harness.db.runtimes.save(runtime2),
      /UNIQUE constraint failed/i,
    );
  });

  it('11. pre-existing unadopted conversation rejection: returns failure if provider returns a conversation known before creation', async () => {
    const harness = await makeHarness({
      createPlanner: async () => ({
        conversationId: 'conv_already_known_before',
        conversationUrl: `https://chatgpt.com/g/${PROJECT_SLUG}/c/conv_already_known_before`,
        projectSlug: PROJECT_SLUG,
      }),
    });

    // Simulate an observed conversation in the project's conversations (e.g. from an existing session)
    const observed = RuntimeSession.create('chatgpt' as ProviderType, 'Observed Prior Session');
    observed.updateExternalIdentity('conv_already_known_before', PLANNER_PROJECT_URL);
    await harness.db.runtimes.save(observed);

    // Calling createChatGPTPlannerSession when that ID is already known must fail closed
    const res = await harness.api.createChatGPTPlannerSession(PROJECT_ID, 'Attempted Reuse');
    assert.strictEqual(res.adopted, false);
    assert.strictEqual(res.partial, true);
    assert.match(res.error ?? '', /already/i);
  });
});
