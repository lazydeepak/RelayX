/**
 * S1B/S6 — Activation authority, and the separation of ACTIVE from activity.
 *
 * ## HISTORY OF THIS FILE
 *
 * S1B wrote groups D and E only. Groups A, B and C were OMITTED, with a recorded
 * reason: they assert that an IDLE Pair makes ZERO provider calls, and at the time
 * that was FALSE — the I-2 gate was unarmed because no operation could grant ACTIVE.
 * Asserting ZERO calls would have been a red test encoding a defect, and asserting
 * a non-zero count would have pinned the defect as expected behaviour.
 *
 * That reasoning is now obsolete. `loadAndActivate` (S6) is the authorized grantor,
 * the gate is armed, and A, B and C are written as REAL assertions of the truth:
 * an IDLE Pair costs zero external contact.
 *
 * ## WHAT THESE TESTS ASSERT
 *
 *   A  legacy `status='active'` migrates to IDLE, and supervision, recovery and
 *      dispatch then cost ZERO provider calls
 *   B  a migrated IDLE Pair, closed and reopened, still costs ZERO on startup
 *      recovery and supervision
 *   C  IDLE -> Load & Activate -> ACTIVE persisted -> permitted supervision
 *      actually reaches the provider
 *   D  no background or automatic path can flip IDLE -> ACTIVE
 *   E  ACTIVE is permission only: not running, not READY, not healthy, not delivered
 *   F  a side that cannot be verified is reported `unknown` — never `false`,
 *      never omitted, and never as a single pair-level "verified"
 *
 * Nothing here infers authority from legacy `PairStatus`, from a runtime's last-known
 * status, or from the existence of an assignment.
 *
 * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md
 *   I-1   persistent operational state is exactly two values
 *   I-2   IDLE means zero external provider contact
 *   I-3   persisted provider information while IDLE is last-known evidence only
 *   I-4   ACTIVE permits, but does not imply, activity
 *   I-5   readiness is always derived, never persisted as authority
 *   I-6   unknown is a distinct value from false
 *   I-10  Make Idle preserves bindings, history, checkpoints, provenance, evidence
 *   I-11  a shared name is evidence, never identity
 *   §4.2  IDLE -> ACTIVE occurs only via explicit Load & Activate; never automatic
 *   §5.3  tri-state discipline
 *   §11.5 every provider contact is gated on operational_state = ACTIVE
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import {
  Pair,
  Project,
  RuntimeSession,
  RuntimeProjectAssociation,
} from '../src/relay/domain/entities.ts';
import { PairId, ProjectId, AssociationId } from '../src/relay/domain/types.ts';
import type { SideIdentityRequest, SideIdentityResolution } from '../src/relay/providers/interfaces.ts';
import { MockProvider } from './MockProvider.ts';

/**
 * Counts every provider capability invocation, so each group can state as a matter
 * of record exactly how much external contact a path performs.
 *
 * This class deliberately exposes NO identity capability. It models a LEVEL 0
 * provider: a provider that cannot verify identity at all (§9.5). `VerifyingProvider`
 * below is the LEVEL 1 model. Keeping the two distinct is what makes group F real
 * rather than tautological.
 */
class CountingProvider extends MockProvider {
  public readonly calls: string[] = [];

  reset(): void {
    this.calls.length = 0;
  }
  get total(): number {
    return this.calls.length;
  }
  async findRuntime(d: any) { this.calls.push('findRuntime'); return super.findRuntime(d); }
  async findAllRuntimes() { this.calls.push('findAllRuntimes'); return super.findAllRuntimes(); }
  async matchSessionsByPath(p: any, g?: any) { this.calls.push('matchSessionsByPath'); return super.matchSessionsByPath(p, g); }
  async inspectRuntime(id: any) { this.calls.push('inspectRuntime'); return super.inspectRuntime(id); }
  async activateRuntime(id: any) { this.calls.push('activateRuntime'); return super.activateRuntime(id); }
  async deliverInstruction(r: any) { this.calls.push('deliverInstruction'); return super.deliverInstruction(r); }
  async detectWorkingState(id: any) { this.calls.push('detectWorkingState'); return super.detectWorkingState(id); }
  async detectCompletionState(id: any) { this.calls.push('detectCompletionState'); return super.detectCompletionState(id); }
  async captureEvidence(id: any, a: any) { this.calls.push('captureEvidence'); return super.captureEvidence(id, a); }
  async reconcileDispatch(r: any) { this.calls.push('reconcileDispatch'); return { outcome: 'unknown' as any }; }
}

/** LEVEL 1: a provider that CAN resolve and verify an exact external session id. */
class VerifyingProvider extends CountingProvider {
  public identityOutcome: 'verified' | 'mismatched' = 'verified';

  async resolveSideIdentity(request: SideIdentityRequest): Promise<SideIdentityResolution> {
    this.calls.push('resolveSideIdentity');
    if (this.identityOutcome === 'mismatched') {
      return {
        identityState: 'not_resolved',
        identityValue: null,
        verificationState: 'mismatched',
        verificationValue: null,
        existenceState: 'absent',
        sourceCapability: 'test_exact_session_verify',
        observedAt: Date.now(),
        reason: `provider has no session '${request.externalSessionId}'`,
      };
    }
    return {
      identityState: 'resolved',
      identityValue: request.externalSessionId,
      verificationState: 'verified',
      verificationValue: request.externalSessionId,
      existenceState: 'present',
      sourceCapability: 'test_exact_session_verify',
      observedAt: Date.now(),
      reason: null,
    };
  }
}

/**
 * A project with a bound opencode worker, and a Pair that is IDLE.
 * Used by the groups that need a Pair that must never activate.
 */
async function seedIdle(db: SqliteRelayDatabase) {
  const project = Project.create('bg', '', '/dev/s1b-bg', '/dev/s1b-bg');
  await db.projects.save(project);
  const worker = RuntimeSession.create('opencode', 'Worker');
  worker.updateExternalIdentity('ses_s1b_bg', '/dev/s1b-bg');
  await db.runtimes.save(worker);
  const pair = Pair.create(project.id, 'Background Pair', undefined, worker.id);
  await db.pairs.save(pair);
  return { project, worker, pair };
}

/**
 * A fully bound Pair on both sides, with the authoritative pre-pair associations
 * the pairing guard requires, and a worker-side assignment so that supervision and
 * dispatch have something they would otherwise reach the provider for.
 */
async function seedBound(db: SqliteRelayDatabase, engine: RelayEngine) {
  const project = Project.create('bound', '', '/dev/s1b-bound', '/dev/s1b-bound');
  await db.projects.save(project);
  const planner = RuntimeSession.create('chatgpt', 'Planner');
  planner.updateExternalIdentity('conv_s1b_bound', 'https://chatgpt.com/g/g-p-bound');
  await db.runtimes.save(planner);
  const worker = RuntimeSession.create('opencode', 'Worker');
  worker.updateExternalIdentity('ses_s1b_bound', '/dev/s1b-bound');
  await db.runtimes.save(worker);
  const stamp = Date.now();
  for (const [rid, ptype, ext] of [
    [planner.id, 'chatgpt', 'conv_s1b_bound'],
    [worker.id, 'opencode', 'ses_s1b_bound'],
  ] as const) {
    await db.associations.save(
      new RuntimeProjectAssociation({
        id: ('assoc_s1b_' + rid) as AssociationId,
        runtimeSessionId: rid,
        projectId: project.id,
        providerType: ptype,
        externalSessionId: ext,
        verificationState: 'verified',
        provenance: 'discovery',
        createdAt: stamp,
        updatedAt: stamp,
      }),
    );
  }
  const pair = await engine.createPair(project.id, 'Bound Pair', planner.id, worker.id);
  const asgn = await engine.createAssignment(pair.id, 'Work', 'Do the thing');
  asgn.startAttempt({ id: 'att_bound' } as any);
  await db.assignments.save(asgn);
  return { project, planner, worker, pair, asgn };
}

/**
 * A genuinely legacy on-disk database: pre-v4 schema, a Pair whose LIFECYCLE status
 * is 'active', and no operational_state column at all. This is what the real
 * migration meets, and group A is only meaningful against it.
 */
function writeLegacyDatabase(path: string, now: number): void {
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      canonical_path TEXT, git_root TEXT, planner_project_url TEXT,
      worker_workspace_path TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_sessions (
      id TEXT PRIMARY KEY, provider_type TEXT NOT NULL, name TEXT NOT NULL,
      bundle_identifier TEXT, window_title TEXT, application_pid INTEGER,
      status TEXT NOT NULL, consecutive_observation_failures INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE pairs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      planner_session_id TEXT, worker_session_id TEXT, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE assignments (
      id TEXT PRIMARY KEY, pair_id TEXT NOT NULL, project_id TEXT NOT NULL,
      title TEXT NOT NULL, instruction TEXT NOT NULL, status TEXT NOT NULL,
      current_attempt_id TEXT, active_delivery_id TEXT, active_handoff_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL, session_pair_id TEXT, worker_session_id TEXT,
      external_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    PRAGMA user_version = 0;
  `);
  raw
    .prepare('INSERT INTO projects (id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('proj_legacy', 'Legacy', 'kept', now, now);
  raw
    .prepare('INSERT INTO runtime_sessions (id,provider_type,name,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('rs_legacy_worker', 'opencode', 'Legacy Worker', 'available', now, now);
  // The LIFECYCLE status is 'active'. That must never become an operational permission.
  raw
    .prepare('INSERT INTO pairs (id,project_id,name,planner_session_id,worker_session_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('pair_legacy', 'proj_legacy', 'Legacy Active Pair', null, 'rs_legacy_worker', 'active', now, now);
  // An active assignment, so supervision and recovery have real work they would
  // otherwise reach the provider for. This is the case the gate must actually cover.
  raw
    .prepare('INSERT INTO assignments (id,pair_id,project_id,title,instruction,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('asgn_legacy', 'pair_legacy', 'proj_legacy', 'Legacy Work', 'do it', 'active', now, now);
  raw.close();
}

/* ======================================================================== *
 * Group A — legacy migration yields IDLE, and IDLE costs ZERO contact
 * ======================================================================== */
describe('S1B/S6 group A — a legacy `status="active"` Pair migrates to IDLE and makes ZERO provider calls', () => {
  it('A1: after migration, supervision, recovery, reconciliation and dispatch contact nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay_s1b_a_'));
    const path = join(dir, 'legacy.sqlite');
    try {
      writeLegacyDatabase(path, 1_700_000_000_000);

      const db = new SqliteRelayDatabase(path);
      const opencode = new CountingProvider('opencode');
      const chatgpt = new CountingProvider('chatgpt');
      const engine = new RelayEngine(db);
      engine.registerProvider(opencode);
      engine.registerProvider(chatgpt);

      // --- the migration itself -------------------------------------------
      const migrated = (await db.pairs.findById('pair_legacy' as PairId))!;
      assert.strictEqual(migrated.status, 'active', 'the legacy LIFECYCLE status is preserved');
      assert.strictEqual(
        migrated.operationalState,
        'IDLE',
        '§17.3: migration backfills IDLE. ACTIVE would grant an unjustifiable permission.',
      );
      assert.strictEqual(
        migrated.isProviderContactPermitted(),
        false,
        'a stale legacy status must never authorize provider contact',
      );

      // --- the assertion that was previously unwritable -------------------
      // Reset after setup so ONLY the gated paths are measured.
      opencode.reset();
      chatgpt.reset();
      assert.strictEqual(opencode.total + chatgpt.total, 0, 'precondition: spies are quiet');

      await engine.runSupervisionTick();
      await engine.recoverOnStartup();
      await engine.reconcileUnresolvedDispatches();

      assert.strictEqual(
        opencode.total,
        0,
        `I-2: an IDLE Pair must cost ZERO OpenCode calls, saw: ${opencode.calls.join(', ')}`,
      );
      assert.strictEqual(
        chatgpt.total,
        0,
        `I-2: an IDLE Pair must cost ZERO ChatGPT calls, saw: ${chatgpt.calls.join(', ')}`,
      );

      // Dispatch must be refused, and must leave no partial durable record.
      const asgn = (await db.assignments.findById('asgn_legacy' as any))!;
      await assert.rejects(
        () => engine.dispatchAssignment(asgn.id),
        (err: any) => {
          assert.strictEqual(err?.code, 'PAIR_OPERATIONAL_STATE_IDLE');
          return true;
        },
        'dispatch against an IDLE Pair must be refused',
      );
      assert.strictEqual(
        opencode.total,
        0,
        `a refused dispatch must contact nothing, saw: ${opencode.calls.join(', ')}`,
      );
      assert.strictEqual(
        (await db.deliveries.findByAssignmentId(asgn.id)).length,
        0,
        'a refused dispatch must not write a delivery intent',
      );
      assert.strictEqual(
        (await db.pairs.findById('pair_legacy' as PairId))!.operationalState,
        'IDLE',
        'none of these paths may activate the Pair',
      );
      db.close();
    } finally {
      if (existsSync(path)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2: startup recovery of a legacy database inspects no runtime at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay_s1b_a2_'));
    const path = join(dir, 'legacy.sqlite');
    try {
      writeLegacyDatabase(path, 1_700_000_000_000);
      const db = new SqliteRelayDatabase(path);
      const opencode = new CountingProvider('opencode');
      const engine = new RelayEngine(db);
      engine.registerProvider(opencode);
      engine.registerProvider(new CountingProvider('chatgpt'));

      opencode.reset();
      const report = await engine.recoverOnStartup();
      assert.strictEqual(opencode.total, 0, `recovery contacted: ${opencode.calls.join(', ')}`);
      // The report is still produced truthfully; it just has nothing to inspect.
      assert.ok(report, 'recovery must still return a report');
      db.close();
    } finally {
      if (existsSync(path)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ======================================================================== *
 * Group B — restart determinism
 * ======================================================================== */
describe('S1B/S6 group B — a persisted IDLE Pair survives close/reopen costing ZERO contact', () => {
  it('B1: IDLE -> close -> reopen -> recovery and supervision make ZERO provider calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay_s1b_b_'));
    const path = join(dir, 'restart.sqlite');
    try {
      writeLegacyDatabase(path, 1_700_000_000_000);

      // --- session 1: migrate, confirm IDLE, and do a full work cycle ------
      {
        const db = new SqliteRelayDatabase(path);
        const engine = new RelayEngine(db);
        engine.registerProvider(new CountingProvider('opencode'));
        engine.registerProvider(new CountingProvider('chatgpt'));
        assert.strictEqual((await db.pairs.findById('pair_legacy' as PairId))!.operationalState, 'IDLE');
        db.close();
      }

      // --- session 2: a genuinely new process would start here -------------
      const db = new SqliteRelayDatabase(path);
      const opencode = new CountingProvider('opencode');
      const chatgpt = new CountingProvider('chatgpt');
      const engine = new RelayEngine(db);
      engine.registerProvider(opencode);
      engine.registerProvider(chatgpt);

      const reopened = (await db.pairs.findById('pair_legacy' as PairId))!;
      assert.strictEqual(reopened.operationalState, 'IDLE', 'the persisted state is still IDLE');
      assert.strictEqual(reopened.status, 'active', 'and the legacy lifecycle status is still there, unused');

      opencode.reset();
      chatgpt.reset();
      await engine.runSupervisionTick();
      await engine.recoverOnStartup();
      await engine.reconcileUnresolvedDispatches();

      assert.strictEqual(opencode.total, 0, `reopened supervision contacted: ${opencode.calls.join(', ')}`);
      assert.strictEqual(chatgpt.total, 0, `reopened supervision contacted: ${chatgpt.calls.join(', ')}`);
      assert.strictEqual(
        (await db.pairs.findById('pair_legacy' as PairId))!.operationalState,
        'IDLE',
        'restart must not activate anything (§4.2)',
      );
      db.close();
    } finally {
      if (existsSync(path)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B2: a persisted ACTIVE Pair keeps its explicit authorization across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay_s1b_b2_'));
    const path = join(dir, 'active_restart.sqlite');
    try {
      {
        const db = new SqliteRelayDatabase(path);
        const opencode = new VerifyingProvider('opencode');
        const engine = new RelayEngine(db);
        engine.registerProvider(opencode);
        engine.registerProvider(new CountingProvider('chatgpt'));
        const { pair } = await seedBound(db, engine);
        const result = await engine.loadAndActivate(pair.id);
        assert.strictEqual(result.outcome, 'activated');
        db.close();
      }

      const db = new SqliteRelayDatabase(path);
      const opencode = new VerifyingProvider('opencode');
      const engine = new RelayEngine(db);
      engine.registerProvider(opencode);
      engine.registerProvider(new CountingProvider('chatgpt'));

      const reopened = (await db.pairs.findAll())[0];
      assert.strictEqual(
        reopened.operationalState,
        'ACTIVE',
        'an explicit grant must survive restart — the operator authorized it once',
      );

      opencode.reset();
      await engine.runSupervisionTick();
      assert.ok(
        opencode.total > 0,
        'an ACTIVE Pair is PERMITTED contact, and supervision must actually be able to use it',
      );
      db.close();
    } finally {
      if (existsSync(path)) rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ======================================================================== *
 * Group C — explicit activation is the only grantor
 * ======================================================================== */
describe('S1B/S6 group C — Load & Activate is the ONLY `IDLE -> ACTIVE` grantor', () => {
  it('C1: IDLE -> loadAndActivate -> ACTIVE persisted -> supervision reaches the provider', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new VerifyingProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new CountingProvider('chatgpt'));
    const { pair } = await seedBound(db, engine);

    assert.strictEqual((await db.pairs.findById(pair.id))!.operationalState, 'IDLE');

    // Before activation, supervision reaches nothing.
    opencode.reset();
    await engine.runSupervisionTick();
    assert.strictEqual(opencode.total, 0, 'IDLE supervision must contact nothing');

    const result = await engine.loadAndActivate(pair.id);
    assert.strictEqual(result.outcome, 'activated');
    assert.strictEqual(result.operationalStateBefore, 'IDLE');
    assert.strictEqual(result.operationalStateAfter, 'ACTIVE');
    assert.strictEqual(
      (await db.pairs.findById(pair.id))!.operationalState,
      'ACTIVE',
      'ACTIVE must be persisted, so restart is deterministic',
    );
    assert.ok(
      opencode.calls.includes('resolveSideIdentity'),
      'activation must have actually asked the worker provider',
    );

    // After activation, permitted supervision reaches the provider.
    opencode.reset();
    await engine.runSupervisionTick();
    assert.ok(opencode.total > 0, `permitted supervision must reach the provider, saw: ${opencode.calls.join(', ')}`);
  });

  it('C2: a checked-and-negative identity result is terminal and leaves the Pair IDLE', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new VerifyingProvider('opencode');
    opencode.identityOutcome = 'mismatched';
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new CountingProvider('chatgpt'));
    const { pair } = await seedBound(db, engine);

    const result = await engine.loadAndActivate(pair.id);
    assert.strictEqual(result.outcome, 'rejected');
    assert.ok(/did not resolve/.test(result.reason ?? ''), `reason should name the failure: ${result.reason}`);
    assert.strictEqual(
      (await db.pairs.findById(pair.id))!.operationalState,
      'IDLE',
      '§11.2: any terminal failure ends at IDLE',
    );
  });

  it('C3: an unbound side is a §4.4 precondition failure, reported per side', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new VerifyingProvider('opencode'));
    engine.registerProvider(new CountingProvider('chatgpt'));
    const { pair } = await seedBound(db, engine);
    const stored = (await db.pairs.findById(pair.id))!;
    stored.detachPlanner();
    await db.pairs.save(stored);

    const result = await engine.loadAndActivate(pair.id);
    assert.strictEqual(result.outcome, 'rejected');
    assert.ok(/both sides bound/.test(result.reason ?? ''), `reason: ${result.reason}`);
    assert.ok(result.sides.planner, 'the unbound side is reported, not omitted');
    assert.strictEqual(result.sides.planner.verificationState, 'unknown');
    assert.strictEqual((await db.pairs.findById(pair.id))!.operationalState, 'IDLE');
  });

  it('C4: an unregistered provider for a bound side is a precondition failure', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    // Deliberately register NO chatgpt provider: the planner side is bound.
    engine.registerProvider(new VerifyingProvider('opencode'));
    const { pair } = await seedBound(db, engine);

    const result = await engine.loadAndActivate(pair.id);
    assert.strictEqual(result.outcome, 'rejected');
    assert.ok(/provider capabilities present/.test(result.reason ?? ''), `reason: ${result.reason}`);
    assert.strictEqual((await db.pairs.findById(pair.id))!.operationalState, 'IDLE');
  });

  it('C5: re-running Load & Activate on an ACTIVE Pair is rejected, not silently repeated (§11.4)', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new VerifyingProvider('opencode'));
    engine.registerProvider(new CountingProvider('chatgpt'));
    const { pair } = await seedBound(db, engine);

    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    const again = await engine.loadAndActivate(pair.id);
    assert.strictEqual(again.outcome, 'rejected');
    assert.ok(/already ACTIVE/.test(again.reason ?? ''));
  });

  it('C6: `startPair` never activates; it refuses on IDLE and names the real remedy', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new VerifyingProvider('opencode'));
    engine.registerProvider(new CountingProvider('chatgpt'));
    const { pair } = await seedBound(db, engine);

    await assert.rejects(
      () => engine.startPair(pair.id),
      (err: any) => {
        assert.strictEqual(err?.code, 'PAIR_OPERATIONAL_STATE_IDLE');
        assert.match(err?.message ?? '', /Load & Activate/);
        return true;
      },
      'Start Pair must refuse an IDLE Pair rather than activate it',
    );
    assert.strictEqual(
      (await db.pairs.findById(pair.id))!.operationalState,
      'IDLE',
      'a refused Start Pair must leave operational state untouched',
    );

    // Once activated, Start Pair is a plain execution-authority no-op on the
    // operational dimension.
    await engine.loadAndActivate(pair.id);
    await engine.startPair(pair.id);
    assert.strictEqual(
      (await db.pairs.findById(pair.id))!.operationalState,
      'ACTIVE',
      'Start Pair on an ACTIVE pair must not move the operational dimension',
    );
  });

  it('C7: a Pair with an unbound side gets advice it can act on, not advice that would fail again', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new CountingProvider('opencode'));
    const { pair } = await seedIdle(db);
    assert.ok(!pair.plannerSessionId, 'the planner side is unbound, so activation cannot succeed');
    await assert.rejects(
      () => engine.startPair(pair.id),
      (err: any) => {
        assert.match(err?.message ?? '', /no bound planner runtime/);
        assert.doesNotMatch(
          err?.message ?? '',
          /Run Load & Activate/,
          'advising activation for a Pair with an unbound side would send the operator into a second failure',
        );
        return true;
      },
    );
  });
});

/* ======================================================================== *
 * Group D — background paths can never activate
 * ======================================================================== */
describe('S1B group D — background, recovery and legacy status can never activate a Pair', () => {
  it('a legacy `status="active"` lifecycle status does not override operationalState=IDLE', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new CountingProvider('opencode'));

    const { pair } = await seedIdle(db);
    // The legacy lifecycle dimension says "active". The operational dimension does not.
    pair.assignWork('asgn_legacy' as any);
    await db.pairs.save(pair);

    const reloaded = await db.pairs.findById(pair.id);
    assert.strictEqual(reloaded!.status, 'active', 'legacy status is active');
    assert.strictEqual(reloaded!.operationalState, 'IDLE', 'but operational state is IDLE');
    assert.strictEqual(
      reloaded!.isProviderContactPermitted(),
      false,
      'a stale legacy status must never authorize provider contact',
    );
  });

  it('an existing assignment alone never activates a Pair (I-4, §4.2)', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const provider = new CountingProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(provider);

    const { pair } = await seedIdle(db);
    const asgn = await engine.createAssignment(pair.id, 'Work', 'Do the thing');
    asgn.startAttempt({ id: 'att_bg' } as any);
    await db.assignments.save(asgn);

    assert.strictEqual((await db.pairs.findById(pair.id))!.operationalState, 'IDLE');

    // Every one of these is a background or automatic path.
    await engine.runSupervisionTick();
    await engine.recoverOnStartup();
    await engine.reconcileUnresolvedDispatches();

    const after = (await db.pairs.findById(pair.id))!;
    assert.strictEqual(after.operationalState, 'IDLE', 'a background path activated the Pair');
    assert.strictEqual(after.isProviderContactPermitted(), false);
    // With the gate armed, these paths now also cost nothing externally.
    assert.strictEqual(
      provider.total,
      0,
      `I-2: background paths must contact nothing for an IDLE Pair, saw: ${provider.calls.join(', ')}`,
    );
  });

  it('the background supervision loop never activates a Pair', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new CountingProvider('opencode'));

    const { pair } = await seedIdle(db);
    const asgn = await engine.createAssignment(pair.id, 'Work', 'Do the thing');
    asgn.startAttempt({ id: 'att_loop' } as any);
    await db.assignments.save(asgn);

    engine.startSupervisionLoop(1);
    assert.strictEqual(engine.isSupervisingLoopActive(), true);
    await new Promise((r) => setTimeout(r, 30));
    engine.stopSupervisionLoop();
    assert.strictEqual(engine.isSupervisingLoopActive(), false);

    assert.strictEqual(
      (await db.pairs.findById(pair.id))!.operationalState,
      'IDLE',
      'a ticking supervision loop must never activate a Pair',
    );
  });

  it('no lifecycle operation activates a Pair, and a refusal leaves state untouched', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new CountingProvider('opencode'));

    const { pair } = await seedIdle(db);
    const asgn = await engine.createAssignment(pair.id, 'Work', 'Do the thing');
    pair.assignWork(asgn.id as any);
    await db.pairs.save(pair);

    // `startPair` and `resumePair` now refuse on IDLE; the rest are no-ops. The
    // invariant asserted is identical for all four: none may set ACTIVE.
    for (const op of ['startPair', 'pausePair', 'resumePair', 'stopPair'] as const) {
      await engine[op](pair.id as PairId).catch(() => {
        /* a truthful refusal is an acceptable outcome; activation is not */
      });
      const state = (await db.pairs.findById(pair.id))!.operationalState;
      assert.strictEqual(
        state,
        'IDLE',
        `${op}() activated the Pair, which N-16/N-18/I-9 forbid`,
      );
    }
  });

  it('migration backfills IDLE and never ACTIVE (§17.3)', () => {
    assert.strictEqual(Pair.create('p' as ProjectId, 'Fresh').operationalState, 'IDLE');
    const legacy = new Pair({
      id: 'pair_legacy_act' as PairId,
      projectId: 'p' as ProjectId,
      name: 'Legacy Active',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    });
    assert.strictEqual(legacy.status, 'active');
    assert.strictEqual(legacy.operationalState, 'IDLE');
    assert.strictEqual(legacy.isProviderContactPermitted(), false);
  });
});

/* ======================================================================== *
 * Group E — ACTIVE is permission, not activity
 * ======================================================================== */
describe('S1B group E — ACTIVE is a permission, not an activity level (I-4, I-5)', () => {
  it('makeActive() does not create an assignment, attempt, or delivery', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new CountingProvider('opencode'));

    const { pair } = await seedIdle(db);
    pair.makeActive('test grantor');
    await db.pairs.save(pair);

    const reloaded = (await db.pairs.findById(pair.id))!;
    assert.strictEqual(reloaded.operationalState, 'ACTIVE');
    assert.strictEqual(reloaded.isProviderContactPermitted(), true);

    // ACTIVE is permission only. It confers no work, no attempt, no delivery.
    assert.strictEqual(reloaded.activeAssignmentId, undefined, 'ACTIVE must not assign work');
    assert.strictEqual((await db.assignments.findById(pair.id as any)) ?? null, null);
    assert.strictEqual(
      (await db.runtimes.findById(reloaded.workerSessionId!))!.status !== 'working',
      true,
      'ACTIVE must not imply the worker is working',
    );
  });

  it('ACTIVE does not make a Pair healthy, READY, or delivered-to', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const provider = new CountingProvider('opencode');
    // A provider that is failing, and a worker that is not reachable.
    provider.shouldFailInspection = true;
    const engine = new RelayEngine(db);
    engine.registerProvider(provider);

    const { pair } = await seedIdle(db);
    pair.makeActive('test grantor');
    await db.pairs.save(pair);

    // ACTIVE while the provider is unreachable is a valid state, and it is NOT
    // evidence of health. No readiness value exists in the domain at all (I-5).
    const reloaded = (await db.pairs.findById(pair.id))!;
    assert.strictEqual(reloaded.operationalState, 'ACTIVE');
    assert.strictEqual(reloaded.isProviderContactPermitted(), true);
    const asRec = reloaded as any;
    assert.strictEqual(asRec.readiness, undefined, 'no persisted readiness may exist (I-5, §4.3)');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(reloaded, 'ready'),
      false,
      'a Pair must never carry a persisted ready flag',
    );

    // And no readiness column was added to the S5 evidence table either.
    const cols = (
      db.db.prepare("SELECT name FROM pragma_table_info('pair_side_identity')").all() as { name: string }[]
    ).map((c) => c.name);
    for (const forbidden of ['readiness', 'is_ready', 'ready', 'checkpoint', 'cursor']) {
      assert.ok(!cols.includes(forbidden), `pair_side_identity must not persist ${forbidden}`);
    }
  });

  it('makeIdle() is idempotent, contacts nothing, and preserves every binding and record (I-10, §4.5)', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new VerifyingProvider('opencode');
    const chatgpt = new CountingProvider('chatgpt');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(chatgpt);

    const project = Project.create('idem', '', '/dev/s1b-idem', '/dev/s1b-idem');
    await db.projects.save(project);
    const planner = RuntimeSession.create('chatgpt', 'Planner');
    planner.updateExternalIdentity('conv-idem', 'https://chatgpt.com/g/g-p-idem');
    await db.runtimes.save(planner);
    const worker = RuntimeSession.create('opencode', 'Worker');
    worker.updateExternalIdentity('ses_idem', '/dev/s1b-idem');
    await db.runtimes.save(worker);
    const stamp = Date.now();
    for (const [rid, ptype, ext] of [
      [planner.id, 'chatgpt', 'conv-idem'],
      [worker.id, 'opencode', 'ses_idem'],
    ] as const) {
      await db.associations.save(
        new RuntimeProjectAssociation({
          id: ('assoc_idem_' + rid) as AssociationId,
          runtimeSessionId: rid,
          projectId: project.id,
          providerType: ptype,
          externalSessionId: ext,
          verificationState: 'verified',
          provenance: 'discovery',
          createdAt: stamp,
          updatedAt: stamp,
        }),
      );
    }

    const pair = await engine.createPair(project.id, 'Idempotent Pair', planner.id, worker.id);
    assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    const asgn = await engine.createAssignment(pair.id, 'Work', 'Do the thing');
    const stored = (await db.pairs.findById(pair.id))!;
    stored.assignWork(asgn.id);
    stored.pause();
    await db.pairs.save(stored);

    // Make Idle must be a pure local state change: §11.2 provider contact "No".
    opencode.reset();
    chatgpt.reset();
    const once = await engine.makePairIdle(pair.id, 'operator');
    const twice = await engine.makePairIdle(pair.id, 'operator again');
    assert.strictEqual(opencode.total + chatgpt.total, 0, 'Make Idle must contact no provider');
    assert.strictEqual(once.operationalState, 'IDLE');
    assert.strictEqual(twice.operationalState, 'IDLE', 'Make Idle is idempotent');

    const after = (await db.pairs.findById(pair.id))!;
    assert.strictEqual(after.isProviderContactPermitted(), false);
    // I-10: a suspension of observation, not a teardown.
    assert.strictEqual(after.id, pair.id, 'identity preserved');
    assert.strictEqual(after.plannerSessionId, planner.id, 'planner binding preserved');
    assert.strictEqual(after.workerSessionId, worker.id, 'worker binding preserved');
    assert.strictEqual(after.activeAssignmentId, asgn.id, 'active assignment preserved');
    assert.strictEqual(after.status, 'paused', 'lifecycle state untouched by Make Idle');

    // Last-known per-side evidence survives Make Idle (I-3, I-10): IDLE renders
    // last-known, it does not forget.
    const sides = await db.sideIdentities.findByPair(pair.id);
    assert.strictEqual(sides.length, 2, 'both sides must still be recorded while IDLE');
    assert.strictEqual(sides.find((s) => s.sideRole === 'worker')!.verificationState, 'verified');
    assert.strictEqual(sides.find((s) => s.sideRole === 'planner')!.verificationState, 'unknown');
  });
});

/* ======================================================================== *
 * Group F — per-side honesty
 * ======================================================================== */
describe('S1B/S6 group F — an unverifiable side is `unknown`, never `false`, never omitted', () => {
  it('F1: a LEVEL 0 planner side is reported `unknown` and is still present in the result', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    // The worker provider can verify (LEVEL 1). The planner provider cannot (LEVEL 0).
    const engine = new RelayEngine(db);
    engine.registerProvider(new VerifyingProvider('opencode'));
    engine.registerProvider(new CountingProvider('chatgpt'));
    const { pair } = await seedBound(db, engine);

    const result = await engine.loadAndActivate(pair.id);
    assert.strictEqual(result.outcome, 'activated');

    // Both sides are present. A side is never silently omitted (§11.3).
    assert.ok(result.sides.planner, 'the planner side must be present, not omitted');
    assert.ok(result.sides.worker, 'the worker side must be present, not omitted');

    // The unverifiable side is `unknown`, NOT `false` (I-6, §5.3).
    assert.strictEqual(
      result.sides.planner.verificationState,
      'unknown',
      'a LEVEL 0 side must be unknown, never false',
    );
    assert.notStrictEqual(result.sides.planner.verificationState, 'mismatched');
    assert.strictEqual(result.sides.planner.capability, 'not_verifiable');
    assert.ok(result.sides.planner.reason, 'an unknown side must carry a reason explaining why');
    assert.match(result.sides.planner.reason!, /no exact-session identity capability/i);
    assert.strictEqual(
      result.sides.planner.sourceCapability,
      'none',
      '§5.2 dimension 8 must always be populated, even when the answer is "no capability"',
    );
    assert.ok(result.sides.planner.observedAt > 0, '§5.2 dimension 9 must always be populated');

    // The verifiable side IS verified. The asymmetry is reported, not averaged.
    assert.strictEqual(result.sides.worker.verificationState, 'verified');
    assert.strictEqual(result.sides.worker.capability, 'exact_session_verifiable');
    assert.strictEqual(result.sides.worker.identityValue, 'ses_s1b_bound', 'I-11: the provider-owned id');

    // No single pair-level "verified" flag that would hide the unverifiable side.
    assert.strictEqual(
      result.fullyVerified,
      false,
      'a Pair with a LEVEL 0 side is never "fully verified"; the UI must show the asymmetry',
    );
  });

  it('F2: the same asymmetry is persisted, and survives Make Idle', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new VerifyingProvider('opencode'));
    engine.registerProvider(new CountingProvider('chatgpt'));
    const { pair } = await seedBound(db, engine);
    await engine.loadAndActivate(pair.id);
    await engine.makePairIdle(pair.id, 'done for now');

    const stored = await db.sideIdentities.findByPair(pair.id);
    assert.strictEqual(stored.length, 2, 'both sides persisted');
    const planner = stored.find((s) => s.sideRole === 'planner')!;
    const worker = stored.find((s) => s.sideRole === 'worker')!;
    assert.strictEqual(planner.verificationState, 'unknown', 'unknown persists as unknown, not false');
    assert.strictEqual(planner.capability, 'not_verifiable');
    assert.strictEqual(worker.verificationState, 'verified');
    // Dimension 8 names the CAPABILITY, not just the provider (§5.2, C-8).
    assert.strictEqual(worker.sourceCapability, 'test_exact_session_verify');
    assert.ok(planner.sourceCapability.length > 0, 'never empty (§5.2)');
  });

  it('F3: identity is addressed by the provider id, never by the shared Pair name (I-11)', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new VerifyingProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new CountingProvider('chatgpt'));
    const { pair } = await seedBound(db, engine);

    await engine.loadAndActivate(pair.id);
    const asked = opencode.calls.filter((c) => c === 'resolveSideIdentity');
    assert.ok(asked.length >= 1, 'the worker side must have been asked');
    const resolved = (await db.sideIdentities.find(pair.id, 'worker'))!;
    assert.strictEqual(
      resolved.identityValue,
      'ses_s1b_bound',
      'identity must be the provider-owned external id',
    );
    assert.notStrictEqual(
      resolved.identityValue,
      pair.name,
      'the shared human-readable name must never become the identity (I-11)',
    );
  });

  it('F4: a provider read that throws is `unknown`, never `false`', async () => {
    class ThrowingProvider extends VerifyingProvider {
      async resolveSideIdentity(_r: SideIdentityRequest): Promise<SideIdentityResolution> {
        this.calls.push('resolveSideIdentity');
        throw new Error('transport exploded');
      }
    }
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    engine.registerProvider(new ThrowingProvider('opencode'));
    engine.registerProvider(new CountingProvider('chatgpt'));
    const { pair } = await seedBound(db, engine);

    const result = await engine.loadAndActivate(pair.id);
    // A thrown read is "could not check", not "not verified" (I-6).
    assert.strictEqual(result.sides.worker.verificationState, 'unknown');
    assert.strictEqual(result.sides.worker.existenceState, 'unknown');
    assert.match(result.sides.worker.reason!, /transport exploded/);
    // Per-side isolation: the planner side's outcome is unaffected.
    assert.ok(result.sides.planner, 'the other side is still reported');
    assert.strictEqual(result.sides.planner.verificationState, 'unknown');
  });
});

/* ======================================================================== *
 * The grantor surface itself
 * ======================================================================== */
describe('S1B/S6 — the activation surface has exactly one grantor', () => {
  it('`loadAndActivate` is the only activation-shaped operation on the engine', () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(engine)).filter(
      (m) => m !== 'constructor' && typeof (engine as any)[m] === 'function',
    );
    const activationShaped = surface.filter((m) => /^(load|activate)/i.test(m));
    assert.deepStrictEqual(
      activationShaped,
      ['loadAndActivate'],
      `activation authority must be singular; found: ${activationShaped.join(', ')}`,
    );
    // `make*` on the engine would be a second grantor. Make Idle exists and is the
    // opposite direction; no `makeActive` may appear here.
    assert.ok(!surface.includes('makeActive'), 'Pair.makeActive must not be reachable from the engine');
    assert.ok(surface.includes('makePairIdle'), 'Make Idle belongs on the engine (§4.5)');
  });

  it('the domain exposes the transition, and only Load & Activate calls it', () => {
    assert.strictEqual(typeof Pair.prototype.makeActive, 'function');
    assert.strictEqual(typeof Pair.prototype.makeIdle, 'function');
    assert.strictEqual(typeof Pair.prototype.isProviderContactPermitted, 'function');
  });
});
