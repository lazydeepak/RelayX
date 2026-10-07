/**
 * Bootstrap idempotency: one completed Planner turn -> EXACTLY ONE Assignment,
 * across repeated supervision ticks AND a restart.
 *
 * ## What this pins
 *
 * The RelayIngress bootstrap materialises the first normal Assignment from one
 * identity-proven Planner turn. The failure mode that matters is duplication: a second
 * tick, or a process that restarted and re-derived the baton, must not create a second
 * ingress, a second Assignment, or a second send. Everything is asserted against a real
 * file-backed SQLite database, because "restart" is only honest if the durable state is
 * re-read by a genuinely new engine object.
 *
 * ## What is NOT modelled, deliberately
 *
 * No observer arm, completion or transport outcome is fabricated at the provider layer: the
 * Planner observer is a stub reporting exactly what a real arm reports, and the Worker
 * transport is the repo's MockProvider. The subject under test is the bootstrap's own
 * durable bookkeeping, not OpenCode or ChatGPT.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { MockProvider } from './MockProvider.ts';
import { RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { createId } from '../src/relay/domain/types.ts';

const PLANNER_EXTERNAL = 'conv-planner-bootstrap';
const WORKER_EXTERNAL = 'ses_worker_bootstrap';

/** Historical turn that existed BEFORE the bootstrap boundary. Must never be consumed. */
const PRE_ARM_TEXT = 'PRE-ARM HISTORICAL PLANNER TEXT - must never become an Assignment';
const PRE_ARM_KEY = 'pre-arm-turn-key';

/** The one post-arm completed turn that legitimately materialises work. */
const POST_ARM_TEXT = 'POST-ARM COMPLETED PLANNER TURN - this is the work';
const POST_ARM_KEY = 'b6c16ae0-0089-4528-814a-16691b77b62e';

/**
 * A Planner observer stub that behaves the way the real arm/boundary mechanism does: a
 * completion is only surfaced once an arm exists for THAT conversation, and it carries the
 * id of the arm that produced it — including after the bridge retires that arm.
 */
class StubPlannerObserver {
  public armedArmId: string | null = null;
  public armIssueCount = 0;
  /** Set to simulate the completion being attributable only to a RETIRED arm. */
  public retiredArmId: string | null = null;

  async ensureArmed(conversationId: string) {
    if (this.armedArmId) return { armId: this.armedArmId, conversationId, reused: true };
    this.armIssueCount += 1;
    this.armedArmId = `arm_bootstrap_${this.armIssueCount}`;
    return { armId: this.armedArmId, conversationId, reused: false };
  }

  async status(conversationId: string) {
    if (!this.armedArmId) {
      // No boundary exists yet. The only thing visible is pre-arm history, and the engine
      // must not be able to consume it because it has no boundary to judge "after".
      return {
        available: true,
        unavailableReason: null,
        conversationId,
        armId: null,
        armActive: false,
        working: false,
        completion: null,
        lastState: 'identity',
        lastObservedAt: null,
      };
    }
    const armThatProduced = this.retiredArmId ?? this.armedArmId;
    return {
      available: true,
      unavailableReason: null,
      conversationId,
      armId: null,
      armActive: false,
      working: false,
      completion: {
        armId: armThatProduced,
        conversationId,
        responseText: POST_ARM_TEXT,
        responseHash: 'sha256_stub_post_arm',
        responseLength: POST_ARM_TEXT.length,
        completedTurnKey: POST_ARM_KEY,
        observedAt: new Date().toISOString(),
        adoptedFromUnresolvableArm: this.retiredArmId !== null,
      },
      lastState: 'finished',
      lastObservedAt: new Date().toISOString(),
    };
  }
}

type Db = SqliteRelayDatabase;
const one = (db: Db, sql: string, ...p: any[]) => db.db.prepare(sql).get(...p) as any;
const all = (db: Db, sql: string, ...p: any[]) => db.db.prepare(sql).all(...p) as any[];
const count = (db: Db, sql: string, ...p: any[]) => Number(one(db, sql, ...p).c);

describe('RelayIngress bootstrap — exactly one Assignment across ticks and restart', () => {
  let dir: string;
  let dbPath: string;
  let workerProvider: MockProvider;
  let observer: StubPlannerObserver;
  let pairId: string;

  const openEngine = () => {
    const db = new SqliteRelayDatabase(dbPath);
    const engine = new RelayEngine(db, undefined, undefined, observer as any);
    engine.registerProvider(new MockProvider('chatgpt'));
    workerProvider = new MockProvider('opencode');
    engine.registerProvider(workerProvider);
    return { db, engine };
  };

  const tick = (engine: RelayEngine) =>
    engine.resumeRelayContinuity(pairId as any, { context: 'AUTOMATED', actor: 'supervisor' });

  const ingressRows = (db: Db) => all(db, 'SELECT * FROM relay_ingress WHERE stable_pair_id = ?', pairId);
  const assignmentCount = (db: Db) =>
    count(db, 'SELECT COUNT(*) AS c FROM assignments WHERE pair_id = ?', pairId);

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'relayx-bootstrap-idem-'));
    dbPath = join(dir, 'relay.sqlite');
    observer = new StubPlannerObserver();

    const { db, engine } = openEngine();

    const project = await engine.createProject('Bootstrap Idempotency Project');
    const planner = new RuntimeSession({
      id: createId('sess'),
      providerType: 'chatgpt',
      name: 'Planner',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: PLANNER_EXTERNAL,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const worker = new RuntimeSession({
      id: createId('sess'),
      providerType: 'opencode',
      name: 'Worker',
      status: 'available',
      consecutiveObservationFailures: 0,
      externalSessionId: WORKER_EXTERNAL,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    for (const [i, s] of [planner, worker].entries()) {
      await db.associations.save(
        new RuntimeProjectAssociation({
          id: `assoc_bootstrap_${i}` as any,
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
    const pair = await engine.createPair(project.id, 'Bootstrap Pair', planner.id, worker.id);
    pairId = pair.id;
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    await engine.startPair(pair.id);

    const fresh = await db.pairs.findById(pair.id);
    assert.strictEqual(fresh!.operationalState, 'ACTIVE', 'pair is ACTIVE');
    assert.strictEqual(fresh!.relayState, 'RUNNING', 'pair is RUNNING');
    assert.ok(fresh!.activeAssignmentId == null, 'no active assignment to start');
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS c FROM deliveries'), 0, 'no deliveries to start');
    assert.strictEqual(count(db, 'SELECT COUNT(*) AS c FROM relay_ingress'), 0, 'no ingress to start');
  });

  after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('tick 1: exactly one ingress and one Assignment, carrying the exact post-arm text', async () => {
    const { db, engine } = openEngine();
    workerProvider.deliveryOutcome = 'ambiguous'; // no confirmed delivery in this scope

    const report = await tick(engine);
    assert.strictEqual(report.decision, 'materialized', `reason=${report.reason}\ntrail=${report.relayDecisionTrail.join(' | ')}`);

    const rows = ingressRows(db);
    assert.strictEqual(rows.length, 1, 'exactly one RelayIngress');
    assert.strictEqual(rows[0].state, 'materialized');
    assert.strictEqual(rows[0].provider_turn_identity, POST_ARM_KEY, 'stable provider turn identity');
    assert.strictEqual(rows[0].observed_text, POST_ARM_TEXT, 'exact observed Planner turn text');
    assert.ok(rows[0].materialized_assignment_id, 'ingress references its Assignment');

    const assignment = await db.assignments.findById(rows[0].materialized_assignment_id);
    assert.ok(assignment, 'materialized Assignment exists');
    assert.strictEqual(
      assignment!.instruction,
      POST_ARM_TEXT,
      'Assignment instruction is the EXACT observed Planner turn text',
    );
    assert.notStrictEqual(assignment!.instruction, PRE_ARM_TEXT, 'pre-arm text must never be consumed');
    assert.notStrictEqual(
      rows[0].provider_turn_identity,
      PRE_ARM_KEY,
      'pre-arm turn key must never be consumed',
    );
  });

  it('ticks 2 and 3: still exactly one ingress and one Assignment', async () => {
    const { db, engine } = openEngine();
    workerProvider.deliveryOutcome = 'ambiguous';

    for (const n of [2, 3]) {
      await tick(engine);
      assert.strictEqual(ingressRows(db).length, 1, `tick ${n}: still one ingress`);
      assert.strictEqual(assignmentCount(db), 1, `tick ${n}: still one Assignment`);
    }
  });

  it('restart: a NEW engine over the SAME database materialises nothing further', async () => {
    // Genuinely new engine + repositories: only the file carries state across.
    const { db, engine } = openEngine();
    workerProvider.deliveryOutcome = 'ambiguous';

    const report = await tick(engine);
    assert.ok(
      report.decision === 'no_confirmed_delivery' || report.decision === 'observe_baton_owner_working',
      `restart must not materialise again (got ${report.decision})`,
    );

    assert.strictEqual(ingressRows(db).length, 1, 'restart: still one ingress');
    assert.strictEqual(assignmentCount(db), 1, 'restart: still one Assignment');

    const attempts = Number(
      one(
        db,
        'SELECT COUNT(*) AS c FROM attempts WHERE assignment_id = (SELECT materialized_assignment_id FROM relay_ingress WHERE stable_pair_id = ?)',
        pairId,
      ).c,
    );
    assert.strictEqual(attempts, 1, 'restart: exactly one Attempt, no duplicate send');
  });

  it('restart after the arm was retired: the retired-arm completion is honoured, exactly once', async () => {
    // The bridge retires an arm the instant its turn completes, so a later tick finds no
    // reusable arm. Binding to the ingress's stored armId is what keeps this working.
    observer.retiredArmId = observer.armedArmId;

    const { db, engine } = openEngine();
    workerProvider.deliveryOutcome = 'ambiguous';
    await tick(engine);

    assert.strictEqual(assignmentCount(db), 1, 'retired-arm tick must not duplicate the Assignment');
    const rows = ingressRows(db);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].state, 'materialized');
    assert.strictEqual(rows[0].observed_text, POST_ARM_TEXT);
  });

  it('baton stays ownerless until a Delivery is actually confirmed delivered', async () => {
    const { db, engine } = openEngine();
    const report = await tick(engine);

    assert.strictEqual(count(db, "SELECT COUNT(*) AS c FROM deliveries WHERE status = 'delivered'"), 0);
    assert.notStrictEqual(
      report.baton.basis,
      'latest_confirmed_delivery',
      'nothing may claim a baton without a confirmed Delivery',
    );
  });
});
