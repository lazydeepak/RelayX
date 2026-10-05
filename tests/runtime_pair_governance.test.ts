/**
 * S6 CLOSURE — runtime-addressed provider operations obey I-2.
 *
 * ## The hole this file closes
 *
 * Six Pair-addressed provider-contact sites were already gated. Two more are
 * addressed by `RuntimeSessionId` instead of `PairId`, so no `Pair` was in scope at
 * the call and nothing gated them:
 *
 *   - `RelayApiService.inspectRuntime()` — called `provider.inspectRuntime` directly
 *     on the service, bypassing the engine entirely
 *   - the re-check inside `unarchiveRuntimeSession()`
 *
 * So `Pair.operationalState === 'IDLE'` did not imply zero provider contact. This
 * file proves it now does.
 *
 * ## Asserted by CALL COUNT, not by status field
 *
 * Every negative case spies on the provider and counts invocations. A green field
 * assertion alone would not distinguish "refused before contact" from "contacted,
 * then discarded the result", which is the exact failure mode under test.
 *
 * ## Cases
 *   A  inspect a runtime owned by an IDLE Pair   → refused, 0 calls
 *   B  unarchive a runtime owned by an IDLE Pair  → refused, 0 calls
 *   C  runtime owned by an ACTIVE Pair           → permitted path still reachable
 *   D  runtime owned by no Pair                  → standalone semantics preserved
 *   E  legacy `status='active'` after migration   → refused, 0 calls
 *   F  persisted IDLE across close/reopen        → refused, 0 calls
 *   G  activation separation: startPair cannot activate; Load & Activate can
 *   H  ambiguous ownership (two Pairs, one runtime) → fails closed, 0 calls
 *
 * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md
 *   I-2   IDLE means zero external provider contact
 *   I-3   IDLE displays persisted evidence only
 *   I-11  shared name is evidence, never identity
 *   §11.5 every provider contact is gated on operational_state = ACTIVE
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { Pair, Project, RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import {
  PairId,
  ProjectId,
  RuntimeSessionId,
  RUNTIME_PAIR_NOT_ACTIVE,
  RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS,
} from '../src/relay/domain/types.ts';
import { MockProvider } from './MockProvider.ts';

/**
 * Counts every provider capability invocation.
 *
 * Exposes NO identity capability, so both sides report `unknown` and
 * `loadAndActivate` succeeds whenever both sides are bound and both providers are
 * registered. That is the correct model for these tests: the subject is the I-2
 * gate, not identity resolution (which `pair_activation_authority.test.ts` covers).
 */
class SpyProvider extends MockProvider {
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

/** A Project + bound planner/worker runtimes + a Pair, all on one database. */
async function seedPaired(db: SqliteRelayDatabase, engine: RelayEngine, opts: { activate?: boolean } = {}) {
  const project = Project.create('closure', '', '/dev/s6c', '/dev/s6c');
  await db.projects.save(project);

  const planner = RuntimeSession.create('chatgpt', 'Planner');
  planner.updateExternalIdentity('conv_s6c', 'https://chatgpt.com/g/g-p-s6c');
  await db.runtimes.save(planner);

  const worker = RuntimeSession.create('opencode', 'Worker');
  worker.updateExternalIdentity('ses_s6c', '/dev/s6c');
  await db.runtimes.save(worker);

  await db.associations.save(
    RuntimeProjectAssociation.create(planner.id, project.id, 'conv_s6c', 'verified', 'discovery', 'chatgpt'),
  );
  await db.associations.save(
    RuntimeProjectAssociation.create(worker.id, project.id, 'ses_s6c', 'verified', 'discovery', 'opencode'),
  );

  const pair = await engine.createPair(project.id, 'Closure Pair', planner.id, worker.id);

  if (opts.activate) {
    const result = await engine.loadAndActivate(pair.id);
    assert.strictEqual(result.outcome, 'activated', result.reason ?? '');
  }
  return { project, planner, worker, pair };
}

/** A runtime that belongs to NO Pair. Must keep working. */
async function seedUnpaired(db: SqliteRelayDatabase) {
  const runtime = RuntimeSession.create('opencode', 'Unpaired Worker');
  runtime.updateExternalIdentity('ses_unpaired', '/dev/unpaired');
  await db.runtimes.save(runtime);
  return runtime;
}

function tempDb(prefix: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `relay_${prefix}_`));
  const path = join(dir, 'x.sqlite');
  return { path, cleanup: () => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } };
}

/* ======================================================================== *
 * A / B — the two holes
 * ======================================================================== */
describe('S6 closure group A/B — runtime-level operations on an IDLE Pair make ZERO provider calls', () => {
  it('A: inspectRuntime on a runtime owned by an IDLE Pair is refused before any contact', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const service = new RelayApiService(db, engine);

    const { worker } = await seedPaired(db, engine);
    assert.strictEqual((await db.pairs.findAll())[0].operationalState, 'IDLE');

    opencode.reset();
    const res = await service.inspectRuntime(worker.id);

    assert.strictEqual(
      opencode.total,
      0,
      `I-2: inspect must not contact the provider for an IDLE Pair, saw: ${opencode.calls.join(', ')}`,
    );
    assert.strictEqual(res.success, false, 'the refusal must be reported as a non-success result');
    assert.match(res.error ?? '', /IDLE/, `the reason must be truthful, got: ${res.error}`);
    assert.match(res.error ?? '', /Load & Activate/, 'the reason must name the operation that would work');
    // No fabricated observation: a refused inspect must not record a status.
    const reloaded = (await db.runtimes.findById(worker.id))!;
    assert.strictEqual(reloaded.status, worker.status, 'a refused inspect must not rewrite runtime status');
    db.close();
  });

  it('B: unarchiveRuntimeSession on a runtime owned by an IDLE Pair makes ZERO provider calls', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const service = new RelayApiService(db, engine);

    const { worker } = await seedPaired(db, engine);

    // Archive it first, so unarchive has something to undo.
    const stored = (await db.runtimes.findById(worker.id))!;
    stored.archive('test');
    await db.runtimes.save(stored);

    opencode.reset();
    await assert.rejects(
      () => service.unarchiveRuntimeSession(worker.id),
      (err: any) => {
        assert.strictEqual(err?.code, RUNTIME_PAIR_NOT_ACTIVE);
        // The refusal must not misreport what happened. The local unarchive DID
        // commit, so the message has to say so, and it has to say the Pair was not
        // activated — otherwise a caller would retry or render stale state.
        assert.match(err?.message ?? '', /was unarchived locally/i, 'the partial result must be stated');
        assert.match(err?.message ?? '', /NOT activated/i, 'the refusal must state that the Pair was not activated');
        assert.match(err?.message ?? '', /IDLE/, 'the real reason must survive the wrapping');
        return true;
      },
      'unarchive must refuse for an IDLE Pair rather than silently skipping the re-check',
    );

    assert.strictEqual(
      opencode.total,
      0,
      `I-2: unarchive must not contact the provider, saw: ${opencode.calls.join(', ')}`,
    );
    // The LOCAL record change is not gated — that is deliberate (Case C), and it is
    // what keeps standalone runtime management usable.
    const after = (await db.runtimes.findById(worker.id))!;
    assert.notStrictEqual(after.status, 'archived', 'the local unarchive must still have happened');

    // And the refusal must not have activated anything.
    assert.strictEqual((await db.pairs.findAll())[0].operationalState, 'IDLE', 'refusal must leave the Pair IDLE');
    db.close();
  });

  it('B2: reconcileAndRecoverRuntime (the engine path) also makes ZERO calls', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const { worker } = await seedPaired(db, engine);

    opencode.reset();
    await assert.rejects(() => engine.reconcileAndRecoverRuntime(worker.id), (err: any) => {
      assert.strictEqual(err?.code, RUNTIME_PAIR_NOT_ACTIVE);
      return true;
    });
    assert.strictEqual(
      opencode.total,
      0,
      `I-2: the engine recovery path must not contact, saw: ${opencode.calls.join(', ')}`,
    );
    db.close();
  });

  it('B3: recoverRuntime reports a governance refusal as such, not as a provider failure', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const service = new RelayApiService(db, engine);

    const { worker } = await seedPaired(db, engine);

    opencode.reset();
    const res = await service.recoverRuntime(worker.id);

    assert.strictEqual(
      opencode.total,
      0,
      `I-2: recovery must not contact, saw: ${opencode.calls.join(', ')}`,
    );
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.restored, false);

    // The distinction I-2 exists to protect: a refusal carries a REASON, so a caller
    // is never told "the provider is unreachable" when the real answer is "you are not
    // permitted to ask". The previous bare `catch {}` erased the reason and made the
    // two indistinguishable.
    assert.ok(res.error, 'a governance refusal must carry its reason');
    assert.match(res.error!, /IDLE/, `the real reason must be reported, got: ${res.error}`);
    assert.match(res.error!, /Load & Activate/, 'the reason must name the operation that would work');
    db.close();
  });

  it('B4: a genuine contact on recovery is never dressed up as a governance refusal', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    opencode.shouldFailInspection = true;
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const service = new RelayApiService(db, engine);

    // An ACTIVE pair, so the guard permits and the provider is genuinely consulted.
    const { worker } = await seedPaired(db, engine, { activate: true });

    opencode.reset();
    const res = await service.recoverRuntime(worker.id);
    assert.ok(opencode.total > 0, 'ACTIVE must permit the contact');
    // The converse of B3: a real attempt must not acquire an invented governance reason.
    assert.strictEqual(res.error, undefined, 'a contact attempt must not be reported as a governance refusal');
    db.close();
  });
});

/* ======================================================================== *
 * C — ACTIVE compatibility
 * ======================================================================== */
describe('S6 closure group C — an ACTIVE Pair keeps its existing permitted path', () => {
  it('C1: inspect and unarchive both reach the provider once the Pair is ACTIVE', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const service = new RelayApiService(db, engine);

    const { worker } = await seedPaired(db, engine, { activate: true });
    assert.strictEqual((await db.pairs.findById((await db.pairs.findAll())[0].id))!.operationalState, 'ACTIVE');

    opencode.reset();
    const res = await service.inspectRuntime(worker.id);
    assert.ok(opencode.calls.includes('inspectRuntime'), `expected real contact, saw: ${opencode.calls.join(', ')}`);
    assert.strictEqual(res.success, true, res.error ?? '');

    const stored = (await db.runtimes.findById(worker.id))!;
    stored.archive('test');
    await db.runtimes.save(stored);

    opencode.reset();
    await service.unarchiveRuntimeSession(worker.id);
    assert.ok(opencode.calls.includes('inspectRuntime'), 'unarchive re-check must be reachable when ACTIVE');
    db.close();
  });

  it('C2: ACTIVE is permission only — it is not READY, not proof of health, not delivery', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    // A provider that is failing outright.
    opencode.shouldFailInspection = true;
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const service = new RelayApiService(db, engine);

    const { pair, worker } = await seedPaired(db, engine, { activate: true });

    // ACTIVE while the provider is unreachable is a valid state.
    assert.strictEqual((await db.pairs.findById(pair.id))!.isProviderContactPermitted(), true);
    opencode.reset();
    const res = await service.inspectRuntime(worker.id);

    // The contact was permitted and actually attempted.
    assert.ok(opencode.calls.includes('inspectRuntime'), 'ACTIVE must permit the attempt');

    // `success: false` here is a NEGATIVE OBSERVATION, not a transport error: the
    // provider answered, and the answer was "not found". The distinction is the
    // whole point of I-6, so it is asserted rather than assumed. A transport failure
    // would carry an `error`; a negative observation must not.
    assert.strictEqual(res.success, false, 'a not-found inspection is honestly reported as unsuccessful');
    assert.strictEqual(res.error, undefined, 'a negative observation is not dressed up as a transport failure');
    assert.ok(res.evidence, 'the negative observation still carries its evidence');

    // The failure is recorded on the runtime, not invented anywhere else.
    const after = (await db.runtimes.findById(worker.id))!;
    assert.ok(after.consecutiveObservationFailures > 0, 'the real observation failure is persisted');

    // ACTIVE neither grants a readiness claim nor implies provider health.
    const stillActive = (await db.pairs.findById(pair.id))!;
    assert.strictEqual(stillActive.operationalState, 'ACTIVE', 'a failed contact must not flip operational state');
    assert.strictEqual((stillActive as any).readiness, undefined, 'I-5: no readiness is derived here');
    db.close();
  });
});

/* ======================================================================== *
 * D — standalone runtime management
 * ======================================================================== */
describe('S6 closure group D — a runtime with no Pair keeps standalone semantics (Case C)', () => {
  it('D1: inspect and unarchive an unpaired runtime still work', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const service = new RelayApiService(db, engine);

    const runtime = await seedUnpaired(db);
    assert.strictEqual((await db.pairs.findAll()).length, 0, 'precondition: no Pair exists');

    opencode.reset();
    const res = await service.inspectRuntime(runtime.id);
    assert.strictEqual(res.success, true, res.error ?? '');
    assert.ok(opencode.calls.includes('inspectRuntime'), 'an unpaired runtime must remain inspectable');

    const stored = (await db.runtimes.findById(runtime.id))!;
    stored.archive('test');
    await db.runtimes.save(stored);
    opencode.reset();
    await service.unarchiveRuntimeSession(runtime.id);
    assert.ok(opencode.calls.includes('inspectRuntime'), 'an unpaired runtime must remain unarchivable');
    db.close();
  });

  it('D2: governance resolution reports `unpaired` rather than inventing a permission', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const engine = new RelayEngine(db);
    const runtime = await seedUnpaired(db);
    const governance = await engine.resolveRuntimePairGovernance(runtime.id);
    assert.strictEqual(governance.kind, 'unpaired');
    // The distinction matters: `unpaired` is the absence of a governance subject.
    const stored = (await db.pairs.findAll())[0];
    assert.strictEqual(stored, undefined, 'no Pair may be conjured by a resolution');
    db.close();
  });

  it('D3: runtime management stays usable even when an unrelated Pair is IDLE', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const service = new RelayApiService(db, engine);

    await seedPaired(db, engine);           // an IDLE Pair exists
    const loose = await seedUnpaired(db);   // plus an unrelated unpaired runtime

    opencode.reset();
    const res = await service.inspectRuntime(loose.id);
    assert.strictEqual(res.success, true, `an IDLE Pair elsewhere must not break standalone use: ${res.error}`);
    assert.ok(opencode.calls.includes('inspectRuntime'));
    db.close();
  });
});

/* ======================================================================== *
 * E / F — migration and restart
 * ======================================================================== */
function writeLegacy(path: string, now: number): void {
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      canonical_path TEXT, git_root TEXT, planner_project_url TEXT, worker_workspace_path TEXT,
      status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE runtime_sessions (id TEXT PRIMARY KEY, provider_type TEXT NOT NULL, name TEXT NOT NULL,
      bundle_identifier TEXT, window_title TEXT, application_pid INTEGER, status TEXT NOT NULL,
      consecutive_observation_failures INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE pairs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      planner_session_id TEXT, worker_session_id TEXT, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE assignments (id TEXT PRIMARY KEY, pair_id TEXT NOT NULL, project_id TEXT NOT NULL,
      title TEXT NOT NULL, instruction TEXT NOT NULL, status TEXT NOT NULL, current_attempt_id TEXT,
      active_delivery_id TEXT, active_handoff_id TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, completed_at INTEGER);
    CREATE TABLE attempts (id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL, session_pair_id TEXT, worker_session_id TEXT, external_session_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    PRAGMA user_version = 0;
  `);
  raw.prepare('INSERT INTO projects (id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run('proj_l', 'Legacy', 'k', now, now);
  raw.prepare('INSERT INTO runtime_sessions (id,provider_type,name,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('rs_l_worker', 'opencode', 'Legacy Worker', 'available', now, now);
  // Lifecycle status is 'active'. This must never become an operational permission.
  raw.prepare('INSERT INTO pairs (id,project_id,name,planner_session_id,worker_session_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('pair_l', 'proj_l', 'Legacy Pair', null, 'rs_l_worker', 'active', now, now);
  raw.prepare('INSERT INTO assignments (id,pair_id,project_id,title,instruction,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('asgn_l', 'pair_l', 'proj_l', 'Legacy Work', 'do it', 'active', now, now);
  raw.close();
}

describe('S6 closure group E/F — migrated and restarted IDLE Pairs stay contact-free', () => {
  it('E: a legacy `status="active"` Pair migrates to IDLE and then blocks runtime contact', async () => {
    const t = tempDb('s6c_e');
    try {
      writeLegacy(t.path, 1_700_000_000_000);
      const db = new SqliteRelayDatabase(t.path);
      const opencode = new SpyProvider('opencode');
      const engine = new RelayEngine(db);
      engine.registerProvider(opencode);
      engine.registerProvider(new SpyProvider('chatgpt'));
      const service = new RelayApiService(db, engine);

      const migrated = (await db.pairs.findById('pair_l' as PairId))!;
      assert.strictEqual(migrated.status, 'active', 'the legacy lifecycle status is preserved');
      assert.strictEqual(migrated.operationalState, 'IDLE', '§17.3: migration backfills IDLE');

      opencode.reset();
      const res = await service.inspectRuntime('rs_l_worker' as RuntimeSessionId);
      assert.strictEqual(opencode.total, 0, `I-2 after migration, saw: ${opencode.calls.join(', ')}`);
      assert.strictEqual(res.success, false);
      assert.match(res.error ?? '', /IDLE/);
      db.close();
    } finally {
      t.cleanup();
    }
  });

  it('F: a persisted IDLE Pair survives close/reopen and still blocks every runtime path', async () => {
    const t = tempDb('s6c_f');
    try {
      writeLegacy(t.path, 1_700_000_000_000);
      {
        const db = new SqliteRelayDatabase(t.path);
        const engine = new RelayEngine(db);
        engine.registerProvider(new SpyProvider('opencode'));
        engine.registerProvider(new SpyProvider('chatgpt'));
        assert.strictEqual((await db.pairs.findById('pair_l' as PairId))!.operationalState, 'IDLE');
        db.close();
      }

      // A genuinely new process.
      const db = new SqliteRelayDatabase(t.path);
      const opencode = new SpyProvider('opencode');
      const engine = new RelayEngine(db);
      engine.registerProvider(opencode);
      engine.registerProvider(new SpyProvider('chatgpt'));
      const service = new RelayApiService(db, engine);

      opencode.reset();
      await engine.recoverOnStartup();
      await engine.runSupervisionTick();
      await engine.reconcileUnresolvedDispatches();
      const inspect = await service.inspectRuntime('rs_l_worker' as RuntimeSessionId);
      await engine.reconcileAndRecoverRuntime('rs_l_worker' as RuntimeSessionId).catch(() => {});

      assert.strictEqual(
        opencode.total,
        0,
        `F: every runtime path must be contact-free after restart, saw: ${opencode.calls.join(', ')}`,
      );
      assert.strictEqual(inspect.success, false);
      assert.strictEqual(
        (await db.pairs.findById('pair_l' as PairId))!.operationalState,
        'IDLE',
        'restart must never activate (§4.2)',
      );
      db.close();
    } finally {
      t.cleanup();
    }
  });
});

/* ======================================================================== *
 * G — activation separation
 * ======================================================================== */
describe('S6 closure group G — startPair cannot activate; Load & Activate still can', () => {
  it('G1: IDLE -> startPair neither activates nor contacts the provider', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const { pair } = await seedPaired(db, engine);

    opencode.reset();
    await assert.rejects(() => engine.startPair(pair.id), (err: any) => {
      assert.strictEqual(err?.code, RUNTIME_PAIR_NOT_ACTIVE);
      return true;
    });
    assert.strictEqual(opencode.total, 0, `saw: ${opencode.calls.join(', ')}`);
    assert.strictEqual((await db.pairs.findById(pair.id))!.operationalState, 'IDLE');
    db.close();
  });

  it('G2: Load & Activate is the sole path to ACTIVE, and it unlocks the runtime paths', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const service = new RelayApiService(db, engine);
    const { pair, worker } = await seedPaired(db, engine);

    const result = await engine.loadAndActivate(pair.id);
    assert.strictEqual(result.outcome, 'activated');
    assert.strictEqual((await db.pairs.findById(pair.id))!.operationalState, 'ACTIVE');

    opencode.reset();
    assert.strictEqual((await service.inspectRuntime(worker.id)).success, true);
    assert.ok(opencode.calls.includes('inspectRuntime'), 'activation must unlock the permitted path');
    db.close();
  });
});

/* ======================================================================== *
 * H — ambiguous ownership fails closed
 * ======================================================================== */
describe('S6 closure group H — ambiguous ownership fails closed (Case D)', () => {
  it('H1: a runtime bound to two Pairs is refused, and the refusal is not a guess', async () => {
    const db = new SqliteRelayDatabase(':memory:');
    const opencode = new SpyProvider('opencode');
    const engine = new RelayEngine(db);
    engine.registerProvider(opencode);
    engine.registerProvider(new SpyProvider('chatgpt'));
    const service = new RelayApiService(db, engine);
    const { worker } = await seedPaired(db, engine, { activate: true });

    // Force the corrupt state the application layer normally prevents. Both Pairs are
    // ACTIVE, so a "pick the first" heuristic would happily authorise the contact.
    const second = Pair.create((await db.pairs.findAll())[0].projectId, 'Second Pair', undefined, worker.id);
    await db.pairs.save(second);
    assert.strictEqual((await db.pairs.findById(second.id))!.operationalState, 'IDLE');
    (await db.pairs.findById(second.id))!.makeActive('for the test');
    await db.pairs.save((await db.pairs.findById(second.id))!);

    const governance = await engine.resolveRuntimePairGovernance(worker.id);
    assert.strictEqual(governance.kind, 'ambiguous', 'the ambiguity must be representable, not collapsed');
    assert.strictEqual((governance as any).pairIds.length, 2);

    opencode.reset();
    const res = await service.inspectRuntime(worker.id);
    assert.strictEqual(opencode.total, 0, `ambiguous ownership must not contact, saw: ${opencode.calls.join(', ')}`);
    assert.strictEqual(res.success, false);
    assert.match(res.error ?? '', /more than one Pair/i, 'the reason must name the real problem');

    // The refusal must be classifiable by machine code, not only by prose. A caller
    // that can only string-match cannot reliably tell "activate the Pair first"
    // (recoverable) from "repair the duplicate binding" (an operator data fault).
    opencode.reset();
    await assert.rejects(() => engine.reconcileAndRecoverRuntime(worker.id), (err: any) => {
      assert.strictEqual(err?.code, RUNTIME_PAIR_OWNERSHIP_AMBIGUOUS);
      return true;
    });
    assert.strictEqual(opencode.total, 0, 'the fail-closed refusal must also make no contact');
    db.close();
  });

  it('H2: both sqlite and memory repositories return ALL owners, not the first', async () => {
    const { MemoryRelayDatabase } = await import('../src/relay/persistence/memory/MemoryDatabase.ts');
    const mem = new MemoryRelayDatabase();
    const project = Project.create('amb', '', '/dev/amb', '/dev/amb');
    await mem.projects.save(project);
    const w1 = RuntimeSession.create('opencode', 'W1'); await mem.runtimes.save(w1);
    const w2 = RuntimeSession.create('opencode', 'W2'); await mem.runtimes.save(w2);
    const shared = RuntimeSession.create('opencode', 'Shared'); await mem.runtimes.save(shared);
    await mem.pairs.save(Pair.create(project.id, 'A', undefined, shared.id));
    await mem.pairs.save(Pair.create(project.id, 'B', undefined, shared.id));
    assert.strictEqual((await mem.pairs.findByRuntimeSessionId(shared.id)).length, 2,
      'memory repo must expose the ambiguity');
    assert.strictEqual((await mem.pairs.findByRuntimeSessionId(w1.id)).length, 0,
      'an unrelated runtime has no owner');

    const sq = new SqliteRelayDatabase(':memory:');
    await sq.projects.save(project);
    for (const r of [w1, w2, shared]) await sq.runtimes.save(r);
    await sq.pairs.save(Pair.create(project.id, 'A', undefined, shared.id));
    await sq.pairs.save(Pair.create(project.id, 'B', undefined, shared.id));
    assert.strictEqual((await sq.pairs.findByRuntimeSessionId(shared.id)).length, 2,
      'sqlite repo must expose the ambiguity');
    sq.close();
  });
});

/* ======================================================================== *
 * I — the re-audit, enforced as a test
 * ======================================================================== */
describe('S6 closure group I — the provider-contact surface cannot grow silently', () => {
  it('I1: every capability invocation in the app layer is on the known, classified list', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../src/relay/application/', import.meta.url).pathname;

    // Each entry is `file:line` of a capability invocation, with its enforcement.
    // Adding a provider call without adding a row here fails this test, which is
    // what makes the surface hard to extend by accident.
    const ENFORCED: Record<string, string> = {
      'RelayEngine.ts:deliverInstruction': 'pair.assertProviderContactPermitted() in dispatchAssignment',
      'RelayEngine.ts:captureTransportBoundary': 'pair.assertProviderContactPermitted() in dispatchAssignment; the Phase-1b boundary read runs after the I-2 gate and immediately before the send',
      'RelayEngine.ts:readExactSessionTurnsForReconciliation': 'the I-2 gate in reconcileDeliveryAgainstExactSession, resolved through the Attempt FROZEN authority (attempt.sessionPairId) exactly as probeDispatchOutcome does; a non-ACTIVE Pair yields disposition=insufficient with no contact and no inferred external state',
      'RelayEngine.ts:inspectRuntime': 'runSupervisionTick / recoverOnStartup continue-guard, and reconcileAndRecoverRuntime shared guard',
      'RelayEngine.ts:reconcileDispatch': 'probeDispatchOutcome via attempt.sessionPairId',
      'RelayEngine.ts:confirmExactSessionReachable': 'called only from tryReviveTerminalRuntime, reached only from resolveBatonSide, which is reached only from resumeRelayContinuity AFTER its I-2 authority gate (pair.isAutomatedContactPermitted() / isProviderContactPermitted()) has passed and BEFORE any provider is resolved. A Pair that does not permit contact never reaches it, and the read itself is read-only: it resolves an already-recorded conversation id and never sends.',
      'RelayEngine.ts:detectWorkingState': 'reconcileInFlightPlanFirstUnit via run.sessionPairId',
      'RelayEngine.ts:observeSide': 'S2: pair.isProviderContactPermitted() checked inside observeSide before getProvider is ever resolved',
      'RelayApiService.ts:inspectRuntime': 'engine.assertRuntimeProviderContactPermitted()',
      'RelayApiService.ts:activateRuntime': 'engine.assertRuntimeProviderContactPermitted()',
      'RelayApiService.ts:openExactWorkerSession': 'inside activateRuntime, behind the same engine.assertRuntimeProviderContactPermitted() I-2 gate that opens the method; the OpenCode worker surface can only be navigated by title, and the authoritative ses_… id is resolved through the shared OpenCode service before the refreshed title is used',
    };
    // Exempt by documented classification, not by omission.
    const EXEMPT: Record<string, string> = {
      'RelayEngine.ts:findRuntime': 'pre-Pair discovery; no Pair can exist yet',
      'RelayEngine.ts:resolveSideIdentity': 'the Load & Activate grantor itself; read-only, authorised by the operator',
      'RelayApiService.ts:resolveChatGPTProject': 'pre-Pair project resolution',
      'RelayApiService.ts:matchSessionsByPath': 'pre-Pair discovery / adoption',
      'RelayApiService.ts:createWorkerSession': 'pre-Pair creation',
      'RelayApiService.ts:createPlannerSession': 'pre-Pair creation',
      'RelayApiService.ts:canonicalizeChatGPTProjectUrl': 'pre-Pair URL canonicalization; pure helper',
    };

    const found: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const src = readFileSync(join(dir, file), 'utf8');
      for (const m of src.matchAll(/(?:^|[^\w.])((?:this\.)?(?:engine\.)?getProvider\([^)]*\)|provider)\.([a-zA-Z]+)\(/g)) {
        const method = m[2];
        if (method === 'getProvider') continue;   // registration lookup, not a contact
        found.push(`${file}:${method}`);
      }
    }
    const uniq = Array.from(new Set(found));
    const known = new Set([...Object.keys(ENFORCED), ...Object.keys(EXEMPT)]);
    const unknown = uniq.filter((f) => !known.has(f));
    assert.deepStrictEqual(unknown, [],
      `unclassified provider contact: ${unknown.join(', ')}. Add it to ENFORCED (with its gate) or EXEMPT (with its justification).`);
  });

  it('I2: the shared guard is the one ownership resolution behind the runtime paths', async () => {
    const { readFileSync } = await import('node:fs');
    const engine = readFileSync(
      new URL('../src/relay/application/RelayEngine.ts', import.meta.url).pathname, 'utf8');

    // Exactly ONE place in the engine asks the repository which Pair owns a runtime.
    // A second one would be a second resolution path, and the two could disagree —
    // which is precisely how this hole opened in the first place.
    const resolutions = engine.match(/findByRuntimeSessionId\(/g) ?? [];
    assert.strictEqual(
      resolutions.length,
      1,
      `ownership must be resolved in exactly one place, saw ${resolutions.length} calls to findByRuntimeSessionId`,
    );

    // The resolution is not allowed to pick a winner when the schema has been
    // bypassed: no `.find(` over owners, no `[0]` indexing of the candidate list.
    const resolutionBody = engine.slice(
      engine.indexOf('public async resolveRuntimePairGovernance'),
      engine.indexOf('public async assertRuntimeProviderContactPermitted'),
    );
    assert.ok(
      !/owners\s*\.\s*find\s*\(/.test(resolutionBody),
      'ambiguous ownership must never be narrowed by searching the candidates',
    );
    assert.ok(
      /ambiguous/.test(resolutionBody) && /owners\.length\s*>\s*1|owners\.length\s*===\s*1/.test(resolutionBody),
      'both the single-owner and the many-owner cases must be decided explicitly',
    );

    // `reconcileAndRecoverRuntime` must call the guard, not re-derive the answer.
    const recoveryBody = engine.slice(
      engine.indexOf('public async reconcileAndRecoverRuntime'),
      engine.indexOf('public async reconcileAndRecoverRuntime') + 1200,
    );
    assert.ok(
      /assertRuntimeProviderContactPermitted\s*\(/.test(recoveryBody),
      'runtime recovery must go through the shared guard',
    );
    assert.ok(
      !/plannerSessionId\s*===|workerSessionId\s*===/.test(recoveryBody),
      'runtime recovery must not resolve ownership by an inline binding comparison',
    );
  });
});
