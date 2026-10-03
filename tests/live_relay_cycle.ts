/**
 * Opt-in live RelayX lifecycle qualification.
 *
 * This is intentionally not named `*.test.ts`: the normal suite must never contact a
 * provider. Run it only with two real, independently addressable OpenCode sessions:
 *
 *   RELAYX_LIVE=1 \
 *   RELAYX_LIVE_WORKER_SESSION=ses_... \
 *   RELAYX_LIVE_PLANNER_SESSION=ses_... \
 *   node --import tsx tests/live_relay_cycle.ts
 *
 * The two sessions act as the worker and planner sides of the Pair. Using the same provider
 * type on both sides is deliberate: both sides expose exact-session delivery and transcript
 * evidence, so this test can verify the orchestration state machine without substituting
 * frontmost-window activity for exact Planner evidence.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { Pair, Project, RuntimeSession } from '../src/relay/domain/entities.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { OpenCodeProvider } from '../src/relay/providers/adapters.ts';

if (process.env.RELAYX_LIVE !== '1') {
  throw new Error('Live provider contact is disabled. Set RELAYX_LIVE=1 explicitly.');
}

const workerExternalId = process.env.RELAYX_LIVE_WORKER_SESSION;
const plannerExternalId = process.env.RELAYX_LIVE_PLANNER_SESSION;
const workspace = process.env.RELAYX_LIVE_WORKSPACE ?? process.cwd();
const relayCount = Number(process.env.RELAYX_LIVE_RELAYS ?? '3');

assert.match(workerExternalId ?? '', /^ses_/, 'RELAYX_LIVE_WORKER_SESSION must be authoritative');
assert.match(plannerExternalId ?? '', /^ses_/, 'RELAYX_LIVE_PLANNER_SESSION must be authoritative');
assert.notEqual(workerExternalId, plannerExternalId, 'live sides must be different sessions');
assert.ok(Number.isInteger(relayCount) && relayCount >= 1 && relayCount <= 3);

type DispatchSnapshot = {
  externalSessionId: string | null;
  assignmentId: string;
  attemptStatus: string;
  deliveryStatus: string;
};

class AuditedLiveOpenCodeProvider extends OpenCodeProvider {
  readonly preTransportSnapshots: DispatchSnapshot[] = [];

  constructor(private readonly repos: SqliteRelayDatabase) {
    super();
  }

  override async deliverInstruction(request: any): Promise<any> {
    const row = this.repos.db.prepare(`
      SELECT d.assignment_id assignmentId, d.status deliveryStatus, a.status attemptStatus
      FROM deliveries d JOIN attempts a ON a.id = d.attempt_id
      WHERE d.idempotency_key = ?
    `).get(request.idempotencyKey) as any;
    assert.ok(row, 'durable Delivery intent must exist before provider contact');
    assert.equal(row.deliveryStatus, 'delivering');
    assert.equal(row.attemptStatus, 'prepared', 'delivery start must not promote execution');
    this.preTransportSnapshots.push({
      externalSessionId: request.externalSessionId ?? null,
      assignmentId: row.assignmentId,
      attemptStatus: row.attemptStatus,
      deliveryStatus: row.deliveryStatus,
    });
    return super.deliverInstruction(request);
  }
}

function makeEngine(db: SqliteRelayDatabase) {
  const engine = new RelayEngine(db);
  const provider = new AuditedLiveOpenCodeProvider(db);
  engine.registerProvider(provider);
  return { engine, provider };
}

function counts(db: SqliteRelayDatabase, pairId: string) {
  const assignments = db.db.prepare('SELECT * FROM assignments WHERE pair_id = ? ORDER BY created_at, id').all(pairId) as any[];
  const assignmentIds = assignments.map((item) => item.id);
  const attempts = assignmentIds.length
    ? db.db.prepare(`SELECT * FROM attempts WHERE assignment_id IN (${assignmentIds.map(() => '?').join(',')}) ORDER BY started_at, id`).all(...assignmentIds) as any[]
    : [];
  const deliveries = assignmentIds.length
    ? db.db.prepare(`SELECT * FROM deliveries WHERE assignment_id IN (${assignmentIds.map(() => '?').join(',')}) ORDER BY created_at, id`).all(...assignmentIds) as any[]
    : [];
  const handoffs = assignmentIds.length
    ? db.db.prepare(`SELECT * FROM handoffs WHERE assignment_id IN (${assignmentIds.map(() => '?').join(',')}) ORDER BY created_at, id`).all(...assignmentIds) as any[]
    : [];
  return { assignments, attempts, deliveries, handoffs };
}

function assertNoDuplicates(state: ReturnType<typeof counts>) {
  assert.equal(new Set(state.assignments.map((item) => item.id)).size, state.assignments.length);
  assert.equal(new Set(state.attempts.map((item) => item.id)).size, state.attempts.length);
  assert.equal(new Set(state.deliveries.map((item) => item.id)).size, state.deliveries.length);
  assert.equal(new Set(state.handoffs.map((item) => item.id)).size, state.handoffs.length);
  const sourced = state.assignments.filter((item) => item.source_handoff_id);
  assert.equal(new Set(sourced.map((item) => item.source_handoff_id)).size, sourced.length,
    'one Handoff may create at most one opposite-side Assignment');
  for (const assignment of state.assignments) {
    assert.equal(state.attempts.filter((item) => item.assignment_id === assignment.id).length, 1);
    assert.equal(state.deliveries.filter((item) => item.assignment_id === assignment.id).length, 1);
    assert.ok(state.handoffs.filter((item) => item.assignment_id === assignment.id).length <= 1);
  }
}

const runId = `rx-live-${Date.now()}`;
const directory = mkdtempSync(join(tmpdir(), `${runId}-`));
const databasePath = join(directory, 'relay.sqlite');
let db = new SqliteRelayDatabase(databasePath);
let { engine, provider } = makeEngine(db);

const project = Project.create('RelayX live lifecycle', runId, workspace, workspace);
const worker = RuntimeSession.create('opencode', 'Live Worker');
worker.updateExternalIdentity(workerExternalId!, workspace);
const planner = RuntimeSession.create('opencode', 'Live Planner');
planner.updateExternalIdentity(plannerExternalId!, workspace);
const pair = Pair.create(project.id, runId, planner.id, worker.id);
pair.makeActive('isolated live lifecycle qualification');
await db.projects.save(project);
await db.runtimes.save(worker);
await db.runtimes.save(planner);
await db.pairs.save(pair);

const token = `RELAYX_LIVE_${Date.now()}`;
await engine.createAssignment(
  pair.id,
  'Live lifecycle probe',
  `Live RelayX orchestration probe. Do not use tools or modify files. Reply exactly with: ${token}`,
);

await engine.startPair(pair.id);
let state = counts(db, pair.id);
assert.equal(state.assignments.length, 1, 'Start must not duplicate the initial Assignment');
assert.equal(state.attempts.length, 1);
assert.equal(state.deliveries.length, 1);
assert.equal(state.deliveries[0].status, 'delivered');
assert.equal(provider.preTransportSnapshots.length, 1);
assertNoDuplicates(state);

// PAUSE blocks all new automated work. RESUME keeps the same execution records.
await engine.pausePair(pair.id);
const pausedCounts = counts(db, pair.id);
await engine.runSupervisionTick();
assert.deepEqual(counts(db, pair.id), pausedCounts);

// Real engine restart: reopen the durable DB, then resume. A delivered Attempt must not be
// resent, and resume must not create a second Assignment/Attempt/Delivery.
db.close();
db = new SqliteRelayDatabase(databasePath);
({ engine, provider } = makeEngine(db));
await engine.resumePair(pair.id);
state = counts(db, pair.id);
assert.equal(provider.preTransportSnapshots.length, 0, 'restart/resume must not redispatch delivered work');
assert.equal(state.assignments.length, 1);
assert.equal(state.attempts.length, 1);
assert.equal(state.deliveries.length, 1);

for (let index = 0; index < relayCount; index += 1) {
  // Completion tick: observe exact provider evidence and create one Handoff.
  await engine.runSupervisionTick();
  state = counts(db, pair.id);
  const assignment = state.assignments[index];
  const attempt = state.attempts.find((item) => item.assignment_id === assignment.id)!;
  assert.equal(attempt.status, 'completed_physical');
  assert.equal(state.handoffs.filter((item) => item.assignment_id === assignment.id).length, 1);
  assertNoDuplicates(state);

  // Repeated supervision of the completion boundary must not duplicate the Handoff. For
  // the last requested relay we stop here, leaving no extra automated dispatch behind.
  if (index === relayCount - 1) break;

  await engine.runSupervisionTick();
  state = counts(db, pair.id);
  assert.equal(state.assignments.length, index + 2);
  const next = state.assignments[index + 1];
  assert.equal(next.target_side_role, assignment.target_side_role === 'worker' ? 'planner' : 'worker');
  assert.equal(next.source_handoff_id, state.handoffs.find((item) => item.assignment_id === assignment.id)!.id);
  assert.equal(state.deliveries.find((item) => item.assignment_id === next.id)!.status, 'delivered');
  assertNoDuplicates(state);
}

await engine.pausePair(pair.id);
state = counts(db, pair.id);
assertNoDuplicates(state);

console.log(JSON.stringify({
  outcome: 'passed',
  runId,
  databasePath,
  pairId: pair.id,
  relayCount,
  assignments: state.assignments.map((item) => ({
    id: item.id,
    targetSideRole: item.target_side_role,
    status: item.status,
    sourceHandoffId: item.source_handoff_id,
  })),
  attempts: state.attempts.map((item) => ({ id: item.id, assignmentId: item.assignment_id, status: item.status })),
  deliveries: state.deliveries.map((item) => ({ id: item.id, assignmentId: item.assignment_id, status: item.status })),
  handoffs: state.handoffs.map((item) => ({ id: item.id, assignmentId: item.assignment_id, status: item.status })),
  preTransportSnapshots: provider.preTransportSnapshots,
}, null, 2));

db.close();
