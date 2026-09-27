/**
 * S1 — external-effect evidence integrity.
 *
 * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md
 *   I-6  unknown is a distinct value from false
 *   I-13 provenance is preserved for every delivered message
 *   §7.3 delivery records preserve the distinction between sent / not sent
 *   §7.4 no cross-origin inference
 *   §9.4 no capability delivers into a specific planner conversation
 *   §9.4.1 the existing planner-delivery path contacts nothing
 *   §9.6 requirements for any future exact-session capability
 *
 * The defect these tests exist to make unregressable: RelayX wrote a durable
 * record asserting the Planner had been notified while contacting nothing at
 * all. Every assertion below is executable, not documentary.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { Handoff, Assignment, Attempt, Delivery } from '../src/relay/domain/entities.ts';
import { MissingEvidenceError } from '../src/relay/domain/errors.ts';
import {
  DeliveryStatus,
  AttemptStatus,
  HandoffStatus,
  ExternalEffectClass,
  ObservableEvidence,
  AssignmentId,
  AttemptId,
  RuntimeSessionId,
  PairId,
  ProjectId,
  HandoffId,
  classifyDeliveryStatus,
  classifyAttemptStatus,
  classifyHandoffStatus,
  EXTERNAL_EFFECT_CLASS_ASSERTS_OCCURRED,
} from '../src/relay/domain/types.ts';
import { MockProvider } from './MockProvider.ts';

/** Every event type that would assert an external effect happened. */
const EXTERNALLY_ASSERTING_EVENT_TYPES = ['planner.notified'] as const;

function providerEvidence(runtimeSessionId?: RuntimeSessionId): ObservableEvidence {
  return {
    id: 'ev_provider_proof',
    timestamp: Date.now(),
    source: 'macos_accessibility',
    runtimeSessionId,
  };
}

/** Recursively lists every .ts file under `dir`, for static source assertions. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('S1 — Handoff.markDeliveredToPlanner requires provider evidence (I-13, §7.3)', () => {
  it('refuses to record Planner delivery without evidence', () => {
    const handoff = Handoff.create('asgn_1' as AssignmentId, 'att_1' as AttemptId);
    handoff.markReady('Result exists; delivery intended.');

    assert.throws(
      () => handoff.markDeliveredToPlanner(undefined as unknown as ObservableEvidence),
      MissingEvidenceError,
      'a durable "the Planner was told" claim must require provider evidence',
    );
    assert.throws(
      () => handoff.markDeliveredToPlanner(null as unknown as ObservableEvidence),
      MissingEvidenceError,
    );

    // The refused transition wrote nothing at all.
    assert.strictEqual(handoff.status, 'ready');
    assert.strictEqual(handoff.deliveredToPlannerAt, undefined);
    assert.strictEqual(handoff.plannerDeliveryEvidence, undefined);
    assert.strictEqual(handoff.resultSummary, 'Result exists; delivery intended.');
  });

  it('is the same gate shape as Delivery.confirmDelivered, so the rule is uniform', () => {
    const delivery = Delivery.create(
      'asgn_1' as AssignmentId,
      'att_1' as AttemptId,
      'runtime_1' as RuntimeSessionId,
      'snippet',
      'idem-1',
    );
    assert.throws(
      () => delivery.confirmDelivered(undefined as unknown as ObservableEvidence),
      MissingEvidenceError,
    );
    assert.strictEqual(delivery.status, 'pending', 'a refused transition writes nothing');
    assert.strictEqual(delivery.deliveredAt, undefined);
  });

  it('records delivery when — and only when — evidence is supplied', () => {
    const handoff = Handoff.create('asgn_1' as AssignmentId, 'att_1' as AttemptId);
    handoff.markReady('Result', undefined, providerEvidence('runtime_worker' as RuntimeSessionId));
    handoff.markDeliveredToPlanner(providerEvidence('runtime_planner' as RuntimeSessionId));

    assert.strictEqual(handoff.status, 'delivered');
    assert.ok(handoff.deliveredToPlannerAt, 'the timestamp is recorded alongside the evidence');
    assert.strictEqual(handoff.plannerDeliveryEvidence?.id, 'ev_provider_proof');
    assert.strictEqual(
      handoff.plannerDeliveryEvidence?.runtimeSessionId,
      'runtime_planner',
      'the Planner-side evidence names the Planner side',
    );
  });

  it('does not destroy the Worker-produced result evidence when recording Planner delivery (I-13, §7.3)', () => {
    const workerEvidence: ObservableEvidence = {
      id: 'ev_worker_produced',
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      runtimeSessionId: 'runtime_worker' as RuntimeSessionId,
    };
    const handoff = Handoff.create('asgn_1' as AssignmentId, 'att_1' as AttemptId);
    handoff.markReady('Result', undefined, workerEvidence);
    handoff.markDeliveredToPlanner(providerEvidence('runtime_planner' as RuntimeSessionId));

    assert.deepStrictEqual(
      handoff.evidence,
      workerEvidence,
      'the provider-produced record must survive the Planner-side record',
    );
    assert.strictEqual(handoff.plannerDeliveryEvidence?.runtimeSessionId, 'runtime_planner');
    assert.notDeepStrictEqual(handoff.evidence, handoff.plannerDeliveryEvidence);
  });
});

describe('S1 — the external-effect vocabulary asserts occurrence only for externally_confirmed (I-6, §7.3)', () => {
  const ALL_DELIVERY: DeliveryStatus[] = ['pending', 'delivering', 'delivered', 'ambiguous', 'failed'];
  const ALL_ATTEMPT: AttemptStatus[] = ['prepared', 'running', 'completed_physical', 'interrupted'];
  const ALL_HANDOFF: HandoffStatus[] = ['pending', 'ready', 'delivered', 'complete', 'suspended'];

  it('classifyDeliveryStatus is total and only "delivered" asserts occurrence', () => {
    assert.strictEqual(ALL_DELIVERY.length, 5);
    for (const status of ALL_DELIVERY) {
      const cls = classifyDeliveryStatus(status) as ExternalEffectClass;
      assert.ok(cls, `${status} must classify`);
      if (status === 'delivered') {
        assert.strictEqual(EXTERNAL_EFFECT_CLASS_ASSERTS_OCCURRED(cls), true);
      } else {
        assert.strictEqual(
          EXTERNAL_EFFECT_CLASS_ASSERTS_OCCURRED(cls),
          false,
          `${status} (${cls}) must not assert that the external effect occurred`,
        );
      }
    }
  });

  it('"ambiguous" is its own value and never collapses to false (I-6)', () => {
    const cls = classifyDeliveryStatus('ambiguous');
    assert.strictEqual(cls, 'ambiguous');
    assert.notStrictEqual(cls, 'failed', 'unknown is a distinct value from false');
    assert.notStrictEqual(cls, 'externally_confirmed');
  });

  it('classifyAttemptStatus asserts occurrence only from a provider-confirmed state', () => {
    for (const status of ALL_ATTEMPT) {
      assert.ok(classifyAttemptStatus(status), `${status} must classify`);
    }
    assert.strictEqual(classifyAttemptStatus('prepared'), 'intended', 'a stored intent asserts nothing');
    assert.strictEqual(classifyAttemptStatus('interrupted'), 'ambiguous', 'a local conclusion asserts nothing');
  });

  it('classifyHandoffStatus returns null for states that make no external claim at all', () => {
    for (const status of ALL_HANDOFF) {
      classifyHandoffStatus(status); // must be total
    }
    assert.strictEqual(
      classifyHandoffStatus('complete'),
      null,
      '"the RelayX record is closed" is not evidence that the Planner was told',
    );
    assert.strictEqual(
      classifyHandoffStatus('suspended'),
      null,
      '"the RelayX record is suspended" is not evidence that the Planner was told',
    );
    assert.strictEqual(classifyHandoffStatus('ready'), 'intended', 'ready means delivery intended, NOT done');
    assert.strictEqual(classifyHandoffStatus('delivered'), 'externally_confirmed');
  });

  it('a ready handoff classifies as "intended", so the durable record cannot be read as confirmation', () => {
    const handoff = Handoff.create('asgn_1' as AssignmentId, 'att_1' as AttemptId);
    handoff.markReady('Done');
    const cls = classifyHandoffStatus(handoff.status)!;
    assert.strictEqual(cls, 'intended');
    assert.strictEqual(EXTERNAL_EFFECT_CLASS_ASSERTS_OCCURRED(cls), false);
  });
});

describe('S1 — deliverHandoffToPlanner cannot mark external delivery (§9.4, §9.4.1)', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let worker: MockProvider;
  let planner: MockProvider;
  let handoffId: HandoffId;

  beforeEach(async () => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    worker = new MockProvider('opencode');
    planner = new MockProvider('chatgpt');
    engine.registerProvider(worker);
    engine.registerProvider(planner);

    const project = await engine.createProject('Evidence Project');
    const plannerSession = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const workerSession = await engine.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine.createPair(project.id, 'Pair 1', plannerSession.id, workerSession.id);
    // I-2 (S6): the dispatch and supervision this S1 test observes are provider
    // contact, so the Pair must be ACTIVE. Load & Activate is the ONLY authorized
    // grantor (freeze §4.4, §11.5). Nothing here weakens an S1 evidence assertion:
    // the external-effect semantics under test are unaffected by activation.
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    const assignment = await engine.createAssignment(pair.id, 'Build Component', 'Write a button');
    await engine.dispatchAssignment(assignment.id);

    // Worker finishes; a supervision tick assembles the result into a handoff.
    worker.isWorking = false;
    worker.isComplete = true;
    const tick = await engine.runSupervisionTick();
    assert.strictEqual(tick.handoffsCreated, 1);

    const reloaded = await db.assignments.findById(assignment.id);
    handoffId = reloaded!.activeHandoffId!;
    const handoff = await db.handoffs.findById(handoffId);
    assert.strictEqual(handoff?.status, 'ready');
  });

  it('rejects instead of returning a handoff, so a discarding caller cannot read success', async () => {
    await assert.rejects(
      () => engine.deliverHandoffToPlanner(handoffId),
      /NOT delivered to the Planner/,
    );
  });

  it('leaves the durable handoff untouched: still ready, no delivery timestamp, no evidence', async () => {
    const before = await db.handoffs.findById(handoffId);
    await assert.rejects(() => engine.deliverHandoffToPlanner(handoffId));
    const after = await db.handoffs.findById(handoffId);

    assert.strictEqual(after!.status, 'ready', 'an unsupported delivery must not be recorded as delivered');
    assert.strictEqual(after!.deliveredToPlannerAt, undefined);
    assert.strictEqual(after!.deliveredToPlannerAt, before!.deliveredToPlannerAt);
    assert.strictEqual(after!.resultSummary, before!.resultSummary, 'no durable data is silently rewritten');
    assert.strictEqual(after!.payload ? JSON.stringify(after!.payload) : null, before!.payload ? JSON.stringify(before!.payload) : null);
    assert.strictEqual(
      classifyOf(after!.status),
      'intended',
      'the handoff still makes no external claim',
    );
  });

  it('contacts no provider on either side of the loop', async () => {
    let workerCalls = 0;
    let plannerCalls = 0;
    const original = worker.deliverInstruction.bind(worker);
    worker.deliverInstruction = async (req: any) => {
      plannerCalls++;
      return original(req);
    };
    const originalInspect = planner.inspectRuntime.bind(planner);
    planner.inspectRuntime = async (id: any) => {
      workerCalls++;
      return originalInspect(id);
    };

    await assert.rejects(() => engine.deliverHandoffToPlanner(handoffId));
    assert.strictEqual(plannerCalls, 0, 'no Planner-facing send may be attempted');
    assert.strictEqual(workerCalls, 0, 'no Worker-facing contact may be attempted');
  });

  it('emits no externally-asserting event type, at all, in the whole stream', async () => {
    await assert.rejects(() => engine.deliverHandoffToPlanner(handoffId));
    const events = await db.events.findRecent(500);
    const types = events.map((e) => e.eventType);
    for (const forbidden of EXTERNALLY_ASSERTING_EVENT_TYPES) {
      assert.ok(!types.includes(forbidden), `event stream must never contain ${forbidden}; got: ${types.join(', ')}`);
    }
    // And the truthful event IS present, carrying no evidence.
    const unverified = events.filter((e) => e.eventType === 'planner.delivery.unverified');
    assert.strictEqual(unverified.length, 1);
    assert.strictEqual(unverified[0]!.evidence, undefined, 'an unverified event must carry no evidence');
    assert.strictEqual(unverified[0]!.previousState, 'ready');
    assert.strictEqual(unverified[0]!.newState, 'ready', 'the event must not pretend the handoff advanced');
    assert.strictEqual(unverified[0]!.details?.externalContactAttempted, false);
  });
});

function classifyOf(status: HandoffStatus): string | null {
  return classifyHandoffStatus(status);
}

describe('S1 — attemptPlannerDelivery reports a truthful, typed outcome (§9.4.1, §9.6)', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let worker: MockProvider;
  let handoffId: HandoffId;

  beforeEach(async () => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    worker = new MockProvider('opencode');
    engine.registerProvider(worker);
    engine.registerProvider(new MockProvider('chatgpt'));

    const project = await engine.createProject('Attempt Project');
    const plannerSession = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const workerSession = await engine.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine.createPair(project.id, 'Pair 1', plannerSession.id, workerSession.id);
    // I-2 (S6): the dispatch and supervision this S1 test observes are provider
    // contact, so the Pair must be ACTIVE. Load & Activate is the ONLY authorized
    // grantor (freeze §4.4, §11.5). Nothing here weakens an S1 evidence assertion:
    // the external-effect semantics under test are unaffected by activation.
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    const assignment = await engine.createAssignment(pair.id, 'Task', 'Instruction');
    await engine.dispatchAssignment(assignment.id);
    worker.isWorking = false;
    worker.isComplete = true;
    await engine.runSupervisionTick();
    const reloaded = await db.assignments.findById(assignment.id);
    handoffId = reloaded!.activeHandoffId!;
  });

  it('returns the unverified variant with externalContactAttempted: false', async () => {
    const attempt = await engine.attemptPlannerDelivery(handoffId);
    assert.strictEqual(attempt.outcome, 'unverified');
    assert.strictEqual(attempt.externalContactAttempted, false);
    assert.ok(attempt.reason.length > 0, 'an unverified outcome must say why');
    assert.ok(
      /exact|transport|conversation/i.test(attempt.reason),
      'the reason must name the missing capability rather than a generic failure',
    );
  });

  it('cannot return the externally_confirmed variant: no construction path exists in S1', async () => {
    const attempts = await Promise.all([
      engine.attemptPlannerDelivery(handoffId),
      engine.attemptPlannerDelivery(handoffId),
      engine.attemptPlannerDelivery(handoffId),
    ]);
    assert.ok(attempts.every((a) => a.outcome === 'unverified'));
    assert.ok(attempts.every((a) => a.externalContactAttempted === false));
  });

  it('the handoff object it returns is the unchanged record, not a mutated copy', async () => {
    const attempt = await engine.attemptPlannerDelivery(handoffId);
    assert.strictEqual(attempt.handoff.status, 'ready');
    assert.strictEqual(attempt.handoff.deliveredToPlannerAt, undefined);
    assert.strictEqual(attempt.handoff.plannerDeliveryEvidence, undefined);
    // The Worker-produced result evidence is untouched: this operation did not
    // claim anything about the Worker either.
    assert.ok(attempt.handoff.evidence, 'the pre-existing result evidence is preserved');
  });

  it('rejects an unknown handoff id rather than inventing a delivery outcome', async () => {
    await assert.rejects(
      () => engine.attemptPlannerDelivery('handoff_does_not_exist' as HandoffId),
      /not found/,
    );
  });

  it('the API surface cannot report success for an unverified delivery', async () => {
    // RelayApiService is the only caller of deliverHandoffToPlanner. It discards
    // the return value, so the ONLY truthful option was for the engine to reject.
    const api = new RelayApiService(db, engine);
    await assert.rejects(
      () => api.deliverHandoff(handoffId as string),
      /NOT delivered to the Planner/,
      'a { success: true } response must never be returned for an unverified delivery',
    );
  });
});

describe('S1 — no event type in src/ asserts the Planner was notified', () => {
  it('`planner.notified` appears nowhere in src/ except as documentation of the defect', () => {
    const root = resolve(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const file of tsFiles(root)) {
      const text = readFileSync(file, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (!line.includes('planner.notified')) continue;
        // Allowed only inside a comment that says it is no longer emitted.
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
        if (!isComment) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'planner.notified may appear only in comments; any executable occurrence would re-assert an external fact',
    );
  });

  it('`handoff.complete` records the real previous state, not a hardcoded "delivered"', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new MockProvider('opencode'));
    engine.registerProvider(new MockProvider('chatgpt'));

    const project = await engine.createProject('Complete Project');
    const plannerSession = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const workerSession = await engine.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine.createPair(project.id, 'Pair 1', plannerSession.id, workerSession.id);
    // I-2 (S6): the dispatch and supervision this S1 test observes are provider
    // contact, so the Pair must be ACTIVE. Load & Activate is the ONLY authorized
    // grantor (freeze §4.4, §11.5). Nothing here weakens an S1 evidence assertion:
    // the external-effect semantics under test are unaffected by activation.
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    const assignment = await engine.createAssignment(pair.id, 'Task', 'Instruction');
    await engine.dispatchAssignment(assignment.id);
    (engine.getProvider('opencode') as MockProvider).isComplete = true;
    (engine.getProvider('opencode') as MockProvider).isWorking = false;
    await engine.runSupervisionTick();
    const reloaded = await db.assignments.findById(assignment.id);
    const handoffId = reloaded!.activeHandoffId!;

    await engine.completeHandoff(handoffId);
    const events = await db.handoffs.findById(handoffId).then((h) => db.events.findByResourceId(h!.id));
    const completeEvent = events.find((e) => e.eventType === 'handoff.complete');
    assert.ok(completeEvent, 'handoff.complete must be recorded');
    assert.strictEqual(
      completeEvent!.previousState,
      'ready',
      'the handoff was never delivered; recording "delivered" would assert an external fact',
    );
    assert.strictEqual(completeEvent!.newState, 'complete');
    assert.strictEqual(completeEvent!.evidence, undefined);
    db.close();
  });
});

describe('S1 — the handoff lifecycle cannot manufacture a delivery record', () => {
  it('replaying attemptPlannerDelivery never accumulates a delivery assertion', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new MockProvider('opencode'));
    engine.registerProvider(new MockProvider('chatgpt'));

    const project = await engine.createProject('Replay Project');
    const plannerSession = await engine.registerRuntimeSession('chatgpt', 'Planner');
    const workerSession = await engine.registerRuntimeSession('opencode', 'Worker');
    const pair = await engine.createPair(project.id, 'Pair 1', plannerSession.id, workerSession.id);
    // I-2 (S6): the dispatch and supervision this S1 test observes are provider
    // contact, so the Pair must be ACTIVE. Load & Activate is the ONLY authorized
    // grantor (freeze §4.4, §11.5). Nothing here weakens an S1 evidence assertion:
    // the external-effect semantics under test are unaffected by activation.
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    const assignment = await engine.createAssignment(pair.id, 'Task', 'Instruction');
    await engine.dispatchAssignment(assignment.id);
    const worker = engine.getProvider('opencode') as MockProvider;
    worker.isComplete = true;
    worker.isWorking = false;
    await engine.runSupervisionTick();
    const reloaded = await db.assignments.findById(assignment.id);
    const handoffId = reloaded!.activeHandoffId!;

    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => engine.deliverHandoffToPlanner(handoffId));
    }
    const handoff = await db.handoffs.findById(handoffId);
    assert.strictEqual(handoff!.status, 'ready');
    assert.strictEqual(handoff!.deliveredToPlannerAt, undefined);
    assert.strictEqual(classifyOf(handoff!.status), 'intended');

    // The stream contains five truthful unverified records and zero assertions.
    const events = await db.events.findByResourceId(handoffId);
    assert.strictEqual(events.filter((e) => e.eventType === 'planner.delivery.unverified').length, 5);
    for (const forbidden of EXTERNALLY_ASSERTING_EVENT_TYPES) {
      assert.ok(!events.some((e) => e.eventType === forbidden));
    }
    db.close();
  });

  it('an assignment/handoff chain built by hand cannot reach "delivered" without evidence', () => {
    const pairId = 'pair_1' as PairId;
    const projectId = 'proj_1' as ProjectId;
    const assignment = Assignment.create(pairId, projectId, 'Title', 'Instruction');
    const attempt = Attempt.create(assignment.id, 1, {
      sessionPairId: pairId,
      workerSessionId: 'runtime_1' as RuntimeSessionId,
      externalSessionId: 'ses_1',
    });
    const handoff = Handoff.create(assignment.id, attempt.id);

    assert.strictEqual(classifyOf(handoff.status), 'intended');
    handoff.markReady('Result');
    assert.strictEqual(classifyOf(handoff.status), 'intended');

    // `delivered` is unreachable from a hand-built record without provider evidence.
    assert.throws(() => handoff.markDeliveredToPlanner(undefined as unknown as ObservableEvidence), MissingEvidenceError);
    assert.strictEqual(handoff.status, 'ready');
    assert.strictEqual(handoff.plannerDeliveryEvidence, undefined);

    handoff.completeHandoff();
    assert.strictEqual(classifyOf(handoff.status), null, 'a closed record asserts nothing external');
  });
});
