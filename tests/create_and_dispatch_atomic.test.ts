/**
 * Create & Dispatch: atomic create + slot claim, then the ordinary dispatch path.
 *
 * ## The durable shape
 *
 * The engine operation `createAssignmentAndClaimExecutionSlot` is a PURE DB
 * transaction (create + claim the slot). The application command
 * `createAndDispatchAssignment` then runs the UNCHANGED `dispatchAssignment`.
 * External delivery is deliberately NOT transactionally atomic.
 *
 * ## Post-claim failure semantics (this file's second half)
 *
 * Once the claim commits, a later dispatch failure means "work exists but needs
 * recovery", never "creation failed". The command returns a structured result so
 * the renderer can tell a PRE-claim refusal (nothing durable) from a POST-claim
 * dispatch failure (the Assignment exists and owns the slot). The claimed
 * Assignment is NEVER rolled back because external delivery failed.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveCreateAssignmentEligibility } from '../src/components/pairDispatchEligibility.ts';
import { shouldCloseCreateAssignmentModal } from '../src/components/createAssignmentOutcome.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { MockProvider } from './MockProvider.ts';
import { RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { createId } from '../src/relay/domain/types.ts';

const modalSource = readFileSync(new URL('../src/components/CreateAssignmentModal.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const engineSource = readFileSync(new URL('../src/relay/application/RelayEngine.ts', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('../src/relay/application/RelayApiService.ts', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../src/services/relayBridge.ts', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../src/types/relayApi.ts', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const contractsSource = readFileSync(new URL('../electron/ipc/contracts.ts', import.meta.url), 'utf8');

const ACTIVE_ASSIGNMENT_MESSAGE =
  'This Pair already has an active assignment. Complete, fail, cancel, retry, or reconcile it before dispatching new work.';

/** A worker provider whose external send throws — models a Phase-2 transport failure. */
class ThrowingDeliveryProvider extends MockProvider {
  async deliverInstruction(): Promise<any> {
    throw new Error('provider transport exploded during send');
  }
}

/* ======================================================================== *
 * Renderer projection
 * ======================================================================== */
describe('resolveCreateAssignmentEligibility — execution-slot precondition', () => {
  it('blocks when the Pair owns an unresolved active assignment, with the exact message', () => {
    const result = resolveCreateAssignmentEligibility({
      activeAssignmentId: 'asgn_mus7cb18_q2f3i2xj',
      activeAssignmentStatus: 'active',
      activeAssignmentTitle: 'Fix the thing',
    });
    assert.strictEqual(result.eligible, false);
    assert.strictEqual(result.blockedByActiveAssignment, true);
    assert.strictEqual(result.activeAssignmentId, 'asgn_mus7cb18_q2f3i2xj');
    assert.strictEqual(result.reason, ACTIVE_ASSIGNMENT_MESSAGE);
  });

  it('blocks pending and waiting_for_handoff holders too (all non-terminal)', () => {
    for (const status of ['pending', 'waiting_for_handoff'] as const) {
      const result = resolveCreateAssignmentEligibility({
        activeAssignmentId: 'asgn_x',
        activeAssignmentStatus: status,
      });
      assert.strictEqual(result.eligible, false, `status '${status}' must block`);
    }
  });

  it('does NOT block a terminal/dangling holder (the engine repairs those)', () => {
    const result = resolveCreateAssignmentEligibility({
      activeAssignmentId: 'asgn_stale',
      activeAssignmentStatus: undefined,
    });
    assert.strictEqual(result.eligible, true);
    assert.strictEqual(result.blockedByActiveAssignment, false);
  });

  it('allows a Pair with no active assignment', () => {
    assert.strictEqual(resolveCreateAssignmentEligibility({}).eligible, true);
    assert.strictEqual(resolveCreateAssignmentEligibility(undefined).eligible, false);
  });
});

/* ======================================================================== *
 * Renderer wiring — blocked UI makes no create/dispatch IPC call
 * ======================================================================== */
describe('Create Assignment modal blocks dispatch on an occupied slot', () => {
  it('disables Create & Dispatch and short-circuits the submit handler', () => {
    assert.match(modalSource, /import \{ resolveCreateAssignmentEligibility \} from '\.\/pairDispatchEligibility\.ts'/);
    assert.match(modalSource, /const createEligibility = resolveCreateAssignmentEligibility\(selectedPair\)/);
    assert.match(modalSource, /if \(!createEligibility\.eligible\) return;/);
    assert.match(modalSource, /disabled=\{!createEligibility\.eligible \|\| isSubmitting\}/);
  });

  it('explains why and routes to the existing Attention & Recovery surface', () => {
    assert.match(modalSource, /createEligibility\.blockedByActiveAssignment/);
    assert.match(modalSource, /onOpenAttentionRecovery/);
    assert.match(modalSource, /Open Attention &amp; Recovery/);
  });

  it('never talks to IPC directly — creation only flows through the injected onCreate handler', () => {
    assert.doesNotMatch(modalSource, /relayBridge/);
    assert.doesNotMatch(modalSource, /createAndDispatchAssignment|dispatchAssignment/);
    assert.match(appSource, /onCreate=\{handleCreateAssignment\}/);
  });

  it('App uses the orchestration command for Create & Dispatch and the PairView create-branch', () => {
    const calls = appSource.match(/relayBridge\.createAndDispatchAssignment\(/g) ?? [];
    assert.ok(calls.length >= 2, `expected both create-and-dispatch call sites, saw ${calls.length}`);
  });
});

/* ======================================================================== *
 * Post-claim failure semantics (renderer + application boundary)
 * ======================================================================== */
describe('post-claim dispatch failure is reported as recoverable, never as "nothing created"', () => {
  it('the command returns a discriminated result rather than throwing', () => {
    assert.match(typesSource, /export interface CreateAndDispatchResult/);
    assert.match(typesSource, /created: boolean;/);
    assert.match(typesSource, /dispatchError\?: string;/);
    assert.match(typesSource, /error\?: string;/);
    assert.match(serviceSource, /return \{ created: false, error:/);
    assert.match(serviceSource, /return \{[\s\S]*?created: true,[\s\S]*?dispatchError:/);
  });

  it('the renderer refreshes on EVERY outcome and distinguishes pre-claim from post-claim failure', () => {
    const body = appSource.slice(
      appSource.indexOf('const handleCreateAssignment'),
      appSource.indexOf('const handleDispatchPair'),
    );
    assert.ok(body.length > 0);
    assert.ok(
      body.indexOf('await loadData()') < body.indexOf('if (!result.created)'),
      'the UI must refresh before reporting, so a committed slot-holder is visible immediately',
    );
    assert.match(body, /if \(!result\.created\)/);
    assert.match(body, /if \(result\.dispatchError\)/);
    assert.match(body, /It is saved and can be retried from the Pair\./);
    // Ambiguous delivery keeps flowing through the existing reconciliation path.
    assert.match(body, /result\.deliveryOutcome === 'ambiguous'/);
    assert.match(body, /Attention & Recovery/);
  });
});

/* ======================================================================== *
 * Modal close semantics — driven by the durable outcome, not the exception
 * ======================================================================== */
describe('Create Assignment modal closes on durable creation, keeps the draft otherwise', () => {
  it('shouldCloseCreateAssignmentModal keys only on the durable fact', () => {
    assert.strictEqual(shouldCloseCreateAssignmentModal({ created: true }), true);
    assert.strictEqual(shouldCloseCreateAssignmentModal({ created: false }), false);
    assert.strictEqual(shouldCloseCreateAssignmentModal(undefined), false);
    assert.strictEqual(shouldCloseCreateAssignmentModal(null), false);
  });

  it('pre-claim refusal keeps the modal open with title/instruction/pair preserved', () => {
    const submitBody = modalSource.slice(
      modalSource.indexOf('const handleSubmit = async'),
      modalSource.indexOf('return (', modalSource.indexOf('const handleSubmit = async')),
    );
    const guard = submitBody.indexOf('shouldCloseCreateAssignmentModal(result)');
    assert.ok(guard > 0, 'the close decision must be driven by the structured result');
    // Nothing clears the draft or closes before the durable-creation check.
    const beforeGuard = submitBody.slice(0, guard);
    assert.doesNotMatch(beforeGuard, /onClose\(\)/);
    assert.doesNotMatch(beforeGuard, /setTitle\(''\)/);
    assert.doesNotMatch(beforeGuard, /setInstruction\(''\)/);
    // Close + clear happen ONLY inside the created:true branch.
    const afterGuard = submitBody.slice(guard);
    assert.match(afterGuard, /onClose\(\)/);
    assert.match(afterGuard, /setTitle\(''\)/);
    assert.match(afterGuard, /setInstruction\(''\)/);
    // The modal awaits the outcome (not fire-and-forget).
    assert.match(modalSource, /await onCreate\(selectedPairId \|\| pairs\[0\]\?\.id, title, instruction\)/);
    assert.match(modalSource, /onCreate: \(pairId: string, title: string, instruction: string\) => Promise<\{ created: boolean \}>/);
  });

  it('an unexpected thrown error keeps the modal open (creation unproven)', () => {
    const submitBody = modalSource.slice(
      modalSource.indexOf('const handleSubmit = async'),
      modalSource.indexOf('return (', modalSource.indexOf('const handleSubmit = async')),
    );
    // The catch block does not close or clear; only isSubmitting is reset.
    assert.match(submitBody, /catch \{/);
    const catchBody = submitBody.slice(submitBody.indexOf('catch {'));
    assert.doesNotMatch(catchBody.slice(0, catchBody.indexOf('finally')), /onClose\(\)|setTitle\(''\)|setInstruction\(''\)/);
  });

  it('prevents double-submit while the request is in flight', () => {
    assert.match(modalSource, /const \[isSubmitting, setIsSubmitting\] = useState\(false\)/);
    assert.match(modalSource, /if \(isSubmitting\) return;/);
    assert.match(modalSource, /setIsSubmitting\(true\)/);
    assert.match(modalSource, /finally \{\s*setIsSubmitting\(false\);/);
    assert.match(modalSource, /disabled=\{!createEligibility\.eligible \|\| isSubmitting\}/);
  });

  it('App returns the durable outcome to the modal (and keeps it open on an unexpected throw)', () => {
    const appBody = appSource.slice(
      appSource.indexOf('const handleCreateAssignment'),
      appSource.indexOf('const handleDispatchPair'),
    );
    assert.match(appBody, /Promise<\{ created: boolean \}>/);
    assert.match(appBody, /return \{ created: false \};/);
    assert.match(appBody, /return \{ created: true \};/);
    // The unexpected-throw branch returns created:false (modal stays open).
    const catchBranch = appBody.slice(appBody.indexOf('catch (err'), appBody.indexOf('try {', appBody.indexOf('catch (err')));
    assert.match(catchBranch, /return \{ created: false \};/);
  });
});

/* ======================================================================== *
 * Layer wiring + semantic precision
 * ======================================================================== */
describe('semantic precision: engine claims the slot; application orchestrates dispatch', () => {
  it('exposes the precise engine operation and the application command at each layer', () => {
    assert.match(engineSource, /public async createAssignmentAndClaimExecutionSlot\(/);
    assert.match(serviceSource, /public async createAndDispatchAssignment\(/);
    assert.match(typesSource, /createAndDispatchAssignment\(/);
    assert.match(bridgeSource, /createAndDispatchAssignment: async \(pairId: string, title: string, instruction: string\)/);
    assert.match(preloadSource, /CREATE_AND_DISPATCH_ASSIGNMENT/);
    assert.match(contractsSource, /CREATE_AND_DISPATCH_ASSIGNMENT: 'relay:create-and-dispatch-assignment'/);
    assert.doesNotMatch(engineSource, /public async createAndDispatchAssignment\(/);
  });

  it('the engine claim operation contacts NO provider (no duplicated delivery logic)', () => {
    const start = engineSource.indexOf('public async createAssignmentAndClaimExecutionSlot');
    const end = engineSource.indexOf('EXECUTION-SLOT INVARIANT', start);
    const claimBody = engineSource.slice(start, end);
    assert.ok(claimBody.length > 0);
    assert.ok(!claimBody.includes('deliverInstruction'), 'claim must not send');
    assert.ok(!claimBody.includes('getProvider'), 'claim must not resolve a provider');
    assert.ok(!claimBody.includes('inspectRuntime'), 'claim must not inspect');
  });

  it('the application command performs dispatch by calling the ordinary dispatch path', () => {
    assert.match(serviceSource, /await this\.engine\.createAssignmentAndClaimExecutionSlot\(/);
    assert.match(serviceSource, /await this\.engine\.dispatchAssignment\(assignment\.id\)/);
  });

  it('no DB transaction spans the provider contact', () => {
    const start = engineSource.indexOf('public async dispatchAssignment');
    const phase1b = engineSource.indexOf('Phase 1b', start);
    assert.ok(phase1b > start, 'Phase 1b marker must exist');
    const phase1 = engineSource.slice(start, phase1b);
    assert.ok(!phase1.includes('deliverInstruction'), 'the provider send must NOT be inside the Phase-1 transaction');
    const afterPhase1 = engineSource.slice(phase1b, phase1b + 8000);
    assert.ok(afterPhase1.includes('provider.deliverInstruction'), 'delivery happens outside the transaction');
  });
});

/* ======================================================================== *
 * Behaviour
 * ======================================================================== */
describe('createAndDispatchAssignment behaviour', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;
  let workerProvider: MockProvider;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    service = new RelayApiService(db, engine);
    engine.registerProvider(new MockProvider('chatgpt'));
    workerProvider = new MockProvider('opencode');
    engine.registerProvider(workerProvider);
  });

  async function seedPair(
    ctx: { db: SqliteRelayDatabase; engine: RelayEngine },
    name: string,
    opts: { activate?: boolean } = {},
  ) {
    const project = await ctx.engine.createProject(`${name} Project`);
    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'chatgpt',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ses_planner_cad',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const worker = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: 'ses_worker_cad',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.runtimes.save(planner);
    await ctx.db.runtimes.save(worker);
    for (const [i, s] of [planner, worker].entries()) {
      await ctx.db.associations.save(
        new RuntimeProjectAssociation({
          id: `assoc_cad_${name}_${i}` as any,
          runtimeSessionId: s.id,
          projectId: project.id,
          providerType: s.providerType,
          externalSessionId: s.externalSessionId ?? '',
          verificationState: 'verified',
          provenance: 'setup',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    }
    const pair = await ctx.engine.createPair(project.id, name, planner.id, worker.id);
    if (opts.activate !== false) {
      assert.strictEqual((await ctx.engine.loadAndActivate(pair.id)).outcome, 'activated');
    }
    return { project, planner, worker, pair };
  }

  const pairWithSides = (name: string, opts?: { activate?: boolean }) =>
    seedPair({ db, engine }, name, opts);

  it('a Pair with no active assignment creates and dispatches via the normal path', async () => {
    const { pair } = await pairWithSides('Fresh');
    workerProvider.deliveryOutcome = 'delivered';

    const result = await service.createAndDispatchAssignment(pair.id, 'A', 'do A');

    assert.strictEqual(result.created, true);
    assert.strictEqual(result.deliveryOutcome, 'delivered');
    const stored = await db.pairs.findById(pair.id);
    assert.strictEqual(stored?.activeAssignmentId, result.assignment!.id);
    assert.strictEqual((await db.attempts.findByAssignmentId(result.assignment!.id as any)).length, 1);
    assert.strictEqual((await db.deliveries.findByAssignmentId(result.assignment!.id as any)).length, 1);
    assert.strictEqual((await db.assignments.findByPairId(pair.id)).length, 1);
    db.close();
  });

  it('a Pair with an unresolved active assignment refuses WITHOUT creating an assignment', async () => {
    const { pair } = await pairWithSides('Occupied');
    workerProvider.deliveryOutcome = 'delivered';

    const first = await service.createAndDispatchAssignment(pair.id, 'First', 'do first');
    assert.strictEqual(first.created, true);

    const refused = await service.createAndDispatchAssignment(pair.id, 'Second', 'do second');
    assert.strictEqual(refused.created, false);
    assert.strictEqual(refused.errorCode, 'PAIR_ACTIVE_ASSIGNMENT_EXISTS');
    assert.strictEqual(refused.assignment, undefined);

    assert.strictEqual((await db.assignments.findByPairId(pair.id)).length, 1);
    assert.strictEqual((await db.pairs.findById(pair.id))?.activeAssignmentId, first.assignment!.id);
    assert.strictEqual((await db.assignments.findById(first.assignment!.id as any))?.status, 'active');

    const events = await db.events.findRecent(200);
    assert.ok(!events.some((e) => e.eventType === 'pair.assignment_slot_released'));
    db.close();
  });

  it('a stale/racing caller cannot leave an orphan merely because dispatch authority rejects it', async () => {
    const { pair } = await pairWithSides('Race');
    workerProvider.deliveryOutcome = 'delivered';
    await service.createAndDispatchAssignment(pair.id, 'Holder', 'holder');

    const before = (await db.assignments.findByPairId(pair.id)).length;
    const refused = await service.createAndDispatchAssignment(pair.id, 'Racer', 'racer');
    assert.strictEqual(refused.created, false);
    assert.strictEqual((await db.assignments.findByPairId(pair.id)).length, before);
    db.close();
  });

  it('an IDLE Pair creates nothing (I-2 gate runs before the durable create)', async () => {
    const { pair } = await pairWithSides('Idle', { activate: false });

    const result = await service.createAndDispatchAssignment(pair.id, 'Idle Work', 'do it');
    assert.strictEqual(result.created, false);
    assert.strictEqual(result.errorCode, 'PAIR_OPERATIONAL_STATE_IDLE');
    assert.strictEqual((await db.assignments.findByPairId(pair.id)).length, 0);
    db.close();
  });

  /* ---- the audit: claim succeeds, dispatch fails ---- */

  it('POST-claim Phase-1 failure reports created=true and NEVER rolls back the claimed assignment', async () => {
    const { pair, worker } = await pairWithSides('PostClaimPhase1');
    // Terminate the worker so the ordinary dispatch refuses AFTER the claim.
    const stored = await db.runtimes.findById(worker.id);
    stored!.status = 'terminated';
    await db.runtimes.save(stored!);

    const result = await service.createAndDispatchAssignment(pair.id, 'Interrupted', 'do it');

    assert.strictEqual(result.created, true, 'the claim committed');
    assert.ok(result.assignment, 'the existing Assignment is reported');
    assert.ok(result.dispatchError, 'the dispatch failure is reported separately');
    assert.strictEqual(result.deliveryOutcome, undefined);

    // No rollback: the Assignment exists and owns the slot.
    assert.strictEqual((await db.assignments.findByPairId(pair.id)).length, 1);
    assert.strictEqual((await db.pairs.findById(pair.id))?.activeAssignmentId, result.assignment!.id);
    assert.strictEqual((await db.assignments.findById(result.assignment!.id as any))?.status, 'pending');
    db.close();
  });

  it('POST-claim Phase-2 provider failure leaves durable intent (active + delivering) and reports created=true', async () => {
    const db2 = new SqliteRelayDatabase(':memory:');
    const engine2 = new RelayEngine(db2);
    const service2 = new RelayApiService(db2, engine2);
    engine2.registerProvider(new MockProvider('chatgpt'));
    engine2.registerProvider(new ThrowingDeliveryProvider('opencode'));

    const { pair } = await seedPair({ db: db2, engine: engine2 }, 'PostClaimPhase2');

    const result = await service2.createAndDispatchAssignment(pair.id, 'Exploding', 'do it');

    assert.strictEqual(result.created, true);
    assert.ok(result.dispatchError);
    // Phase-1 committed the durable dispatch intent before the send threw.
    assert.strictEqual((await db2.assignments.findById(result.assignment!.id as any))?.status, 'active');
    const deliveries = await db2.deliveries.findByAssignmentId(result.assignment!.id as any);
    assert.strictEqual(deliveries.length, 1);
    assert.strictEqual(deliveries[0].status, 'delivering', 'durable intent survives for reconciliation');
    assert.strictEqual((await db2.pairs.findById(pair.id))?.activeAssignmentId, result.assignment!.id);
    db2.close();
  });

  it('an AMBIGUOUS delivery returns created=true with no dispatchError (existing reconciliation path)', async () => {
    const { pair } = await pairWithSides('AmbiguousOutcome');
    workerProvider.deliveryOutcome = 'ambiguous';

    const result = await service.createAndDispatchAssignment(pair.id, 'Maybe', 'do it');

    assert.strictEqual(result.created, true);
    assert.strictEqual(result.deliveryOutcome, 'ambiguous');
    assert.strictEqual(result.dispatchError, undefined);
    const attention = (await db.attention.findOpen()).filter((a) => a.type === 'ambiguous_delivery');
    assert.strictEqual(attention.length, 1, 'ambiguity still raises the existing attention item');
    db.close();
  });

  it('re-clicking Create & Dispatch in the post-claim state does not create another assignment', async () => {
    const { pair, worker } = await pairWithSides('ReClick');
    const stored = await db.runtimes.findById(worker.id);
    stored!.status = 'terminated';
    await db.runtimes.save(stored!);

    const first = await service.createAndDispatchAssignment(pair.id, 'Interrupted', 'do it');
    assert.strictEqual(first.created, true);
    assert.ok(first.dispatchError);

    const second = await service.createAndDispatchAssignment(pair.id, 'Duplicate', 'dup');
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.errorCode, 'PAIR_ACTIVE_ASSIGNMENT_EXISTS');
    assert.strictEqual((await db.assignments.findByPairId(pair.id)).length, 1, 'no second assignment');
    db.close();
  });

  /* ---- recovery boundary ---- */

  it('a crash after slot acquisition leaves a coherent state that resumes via the normal dispatch path', async () => {
    const { pair } = await pairWithSides('CrashWindow');
    const claimed = await engine.createAssignmentAndClaimExecutionSlot(pair.id, 'Interrupted', 'do it');

    assert.strictEqual((await db.pairs.findById(pair.id))?.activeAssignmentId, claimed.id);
    assert.strictEqual((await db.assignments.findById(claimed.id))?.status, 'pending');
    assert.strictEqual((await db.attempts.findByAssignmentId(claimed.id)).length, 0);
    assert.strictEqual((await db.deliveries.findByAssignmentId(claimed.id)).length, 0);

    await engine.recoverOnStartup();
    assert.strictEqual((await db.handoffs.findByAssignmentId(claimed.id)).length, 0, 'no fabricated handoff');
    assert.strictEqual((await db.assignments.findById(claimed.id))?.status, 'pending');

    await assert.rejects(
      async () => engine.createAssignmentAndClaimExecutionSlot(pair.id, 'Duplicate', 'dup'),
      (err: any) => err.code === 'PAIR_ACTIVE_ASSIGNMENT_EXISTS',
    );

    workerProvider.deliveryOutcome = 'delivered';
    const { delivery } = await engine.dispatchAssignment(claimed.id);
    assert.strictEqual(delivery.status, 'delivered');
    db.close();
  });

  it('recovery does not fabricate a handoff for a claimed-but-undispatched assignment even when RUNNING + complete', async () => {
    const { pair } = await pairWithSides('CrashRunning');
    const claimed = await engine.createAssignmentAndClaimExecutionSlot(pair.id, 'Interrupted', 'do it');

    const running = await db.pairs.findById(pair.id);
    running!.startRelay();
    await db.pairs.save(running!);
    workerProvider.isComplete = true;

    await engine.recoverOnStartup();

    assert.strictEqual((await db.handoffs.findByAssignmentId(claimed.id)).length, 0);
    assert.strictEqual((await db.assignments.findById(claimed.id))?.status, 'pending');
    db.close();
  });

  it('reconcilePairAssignmentAuthority keeps the claimed holder (never implicitly superseded)', async () => {
    const { pair } = await pairWithSides('Reconcile');
    const claimed = await engine.createAssignmentAndClaimExecutionSlot(pair.id, 'Holder', 'do it');

    const result = await engine.reconcilePairAssignmentAuthority(pair.id);

    assert.strictEqual(result.adoptedAssignmentId, claimed.id);
    assert.strictEqual((await db.assignments.findById(claimed.id))?.status, 'pending');
    assert.strictEqual((await db.pairs.findById(pair.id))?.activeAssignmentId, claimed.id);
    db.close();
  });

  it('the backend execution-authority guard remains intact for direct dispatch callers', async () => {
    const { pair } = await pairWithSides('Guard');
    workerProvider.deliveryOutcome = 'delivered';
    const first = await service.createAndDispatchAssignment(pair.id, 'First', 'first');

    const backlog = await engine.createAssignment(pair.id, 'Backlog', 'backlog');
    await assert.rejects(
      async () => engine.dispatchAssignment(backlog.id),
      (err: any) => err.code === 'PAIR_ACTIVE_ASSIGNMENT_EXISTS',
    );
    assert.strictEqual((await db.pairs.findById(pair.id))?.activeAssignmentId, first.assignment!.id);
    db.close();
  });
});
