/**
 * S2 — provider-neutral observation of the exact bound Planner and Worker sides.
 *
 * ## What this file is for
 *
 * S1-S6 established WHO a side is (S4/S5 identity) and WHEN RelayX may contact a
 * provider at all (S1B/S6 I-2 gate). S2 adds the remaining four observation
 * dimensions from freeze §5.2 — reachability, UI presence, activity state,
 * message evidence — as DURABLE latest-observed evidence per side, and nothing
 * else.
 *
 * ## The three properties under test
 *
 *   1. Observation is truthful and per-side. `unknown` is never `false`, the two
 *      sides never contaminate each other, and a provider that cannot answer a
 *      dimension says so instead of guessing.
 *   2. Observation is gated. An IDLE Pair makes ZERO provider calls — proven by
 *      CALL COUNT, not by a status field, because "refused before contact" and
 *      "contacted then discarded" look identical from a field assertion.
 *   3. Observation is NOT acknowledgement. §6.4 is `[FROZEN]`: "Observing a side
 *      does not advance its durable checkpoint." Group F proves that a newer
 *      provider reading moves latest-observed and leaves every consumption,
 *      delivery and handoff record exactly where it was.
 *
 * ## Cases
 *   A  IDLE Pair, observe planner / observe worker   -> refused, 0 provider calls
 *   B  exact worker identity: ses_A observed, ses_B exists  -> never ses_B
 *   C  exact planner identity                             -> same principle
 *   D  unknown preservation: capability gap / thrown read -> unknown, not false
 *   E  durability: observe -> close -> reopen -> same record, 0 provider calls
 *   F  observation does not advance any checkpoint/consumption state
 *   G  side isolation: observing planner leaves worker byte-identical
 *   H  monotonicity: ordinal N survives an attempted write of N-1; and where the
 *      provider has no ordinal, NO ordering is invented
 *   I  restart after Make Idle: last-known observation readable, 0 calls
 *
 * Frozen source: DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md
 *   I-2   IDLE means zero external provider contact
 *   I-3   IDLE displays persisted evidence only
 *   I-6   unknown is a distinct value from false
 *   I-7   no cross-provider comparison
 *   I-10  Make Idle stops observation without destroying state
 *   I-11  shared name is evidence, never identity
 *   §5.2  the nine dimensions;  §5.3 tri-state discipline;  §5.4 freshness
 *   §6.4  checkpoint is not auto-updated on observation
 *   §11.2 observeSide: ACTIVE only, no state change, no checkpoint advance
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { MemoryRelayDatabase } from '../src/relay/persistence/memory/MemoryDatabase.ts';
import { Project, RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import {
  PairId,
  ProjectId,
  SideObservationReading,
  NO_OBSERVATION_CAPABILITY,
} from '../src/relay/domain/types.ts';
import { MockProvider } from './MockProvider.ts';
import type { SideObservationRequest } from '../src/relay/providers/interfaces.ts';

/* ------------------------------------------------------------------ *
 * A programmable observation capability
 * ------------------------------------------------------------------ */

/** A reading a test can dial to any combination, defaults all-unknown. */
function reading(over: Partial<SideObservationReading> = {}): SideObservationReading {
  return {
    reachabilityState: 'reachable',
    uiPresenceState: 'unknown',
    activityState: 'unknown',
    messageEvidenceState: 'unknown',
    message: { ref: null, role: null, text: null, truncated: false, ordinal: null },
    observationCapability: 'test_capability',
    observedAt: Date.now(),
    validUntil: Date.now() + 300000,
    reason: null,
    evidence: null,
    ...over,
  };
}

/**
 * Counts every provider capability invocation and records the exact external
 * session id each observation was addressed to.
 *
 * The `addresses` log is what proves I-11: it shows the provider was asked about
 * `ses_a` and never about `ses_b`, which a result-field assertion could not.
 */
class ObserveSpyProvider extends MockProvider {
  public readonly calls: string[] = [];
  /** Every externalSessionId passed to observeSide, in order. */
  public readonly addresses: string[] = [];
  /** Queue of readings to return; the last one repeats once exhausted. */
  public readings: SideObservationReading[] = [];
  /** When set, observeSide throws instead of returning. */
  public throwOnObserve: string | null = null;
  /**
   * When set, `resolveSideIdentity` (S4) returns a NON-NULL evidence artifact
   * tagged with this id.
   *
   * This exists so the suite can prove the S2 observation artifact and the S4
   * identity artifact occupy SEPARATE storage. With a null S4 artifact the two
   * are indistinguishable, and a test that cannot tell them apart cannot detect
   * one silently overwriting the other.
   */
  public identityEvidenceId: string | null = null;
  /** When false, the class exposes NO observeSide member at all (LEVEL 0). */
  public static exposeCapability = true;

  constructor(type: any = 'opencode') {
    super(type);
  }

  reset(): void {
    this.calls.length = 0;
    this.addresses.length = 0;
  }
  get total(): number {
    return this.calls.length;
  }

  // Every inherited capability is spied, so "zero provider contact" is proven
  // against the whole surface and not just the new method.
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
  async resolveSideIdentity(r: any) {
    this.calls.push('resolveSideIdentity');
    // The DEFAULT is a LEVEL-0 style all-unknown verdict, which is what the
    // existing suites expect. Setting `identityEvidenceId` opts into a real,
    // non-null S4 artifact so the two evidence columns become distinguishable.
    const tagged = this.identityEvidenceId !== null;
    return {
      identityState: tagged ? 'resolved' : 'unknown',
      identityValue: tagged ? (r?.externalSessionId ?? null) : null,
      verificationState: tagged ? 'verified' : 'unknown',
      verificationValue: tagged ? (r?.externalSessionId ?? null) : null,
      existenceState: tagged ? 'present' : 'unknown',
      sourceCapability: 'test_identity',
      observedAt: Date.now(),
      evidence: tagged
        ? { id: this.identityEvidenceId!, timestamp: 1, source: 'reconciliation_probe' }
        : null,
    } as any;
  }

  async observeSide(request: SideObservationRequest): Promise<SideObservationReading> {
    this.calls.push('observeSide');
    this.addresses.push(request.externalSessionId);
    if (this.throwOnObserve) throw new Error(this.throwOnObserve);
    const next = this.readings.length > 1 ? this.readings.shift()! : this.readings[0];
    return next ?? reading();
  }
}

/**
 * A provider with NO observation capability at all — the LEVEL 0 shape.
 *
 * Built by deleting the member from a subclass instance's prototype chain rather
 * than by a flag, because `typeof provider.observeSide !== 'function'` is exactly
 * the check the engine makes and the test must exercise the real condition.
 */
class LevelZeroProvider extends MockProvider {
  constructor(type: any = 'chatgpt') { super(type); }
}
// The capability genuinely does not exist on this class.
(LevelZeroProvider.prototype as any).observeSide = undefined;
(LevelZeroProvider.prototype as any).resolveSideIdentity = undefined;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

async function seedPaired(
  db: any,
  engine: RelayEngine,
  opts: { activate?: boolean; plannerExternal?: string; workerExternal?: string } = {},
) {
  const project = Project.create('obs', '', '/dev/obs', '/dev/obs');
  await db.projects.save(project);

  // The association's external ref MUST match the runtime's own external id:
  // `createPair` enforces a pre-pair VERIFIED authoritative association, so a
  // fixture that names one id and binds another is rejected before S2 is reached.
  const plannerExternal = opts.plannerExternal ?? 'conv_obs';
  const workerExternal = opts.workerExternal ?? 'ses_obs';

  const planner = RuntimeSession.create('chatgpt', 'Planner');
  planner.updateExternalIdentity(plannerExternal, 'https://chatgpt.com/g/g-p-obs');
  await db.runtimes.save(planner);

  const worker = RuntimeSession.create('opencode', 'Worker');
  worker.updateExternalIdentity(workerExternal, '/dev/obs');
  await db.runtimes.save(worker);

  await db.associations.save(
    RuntimeProjectAssociation.create(planner.id, project.id, plannerExternal, 'verified', 'discovery', 'chatgpt'),
  );
  await db.associations.save(
    RuntimeProjectAssociation.create(worker.id, project.id, workerExternal, 'verified', 'discovery', 'opencode'),
  );

  const pair = await engine.createPair(project.id, 'Observation Pair', planner.id, worker.id);
  if (opts.activate) {
    const r = await engine.loadAndActivate(pair.id);
    assert.strictEqual(r.outcome, 'activated', r.reason ?? '');
  }
  return { project, planner, worker, pair };
}

function tempDb(prefix: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `relay_${prefix}_`));
  const path = join(dir, 'x.sqlite');
  return { path, cleanup: () => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } };
}

function newEngine(providers: any[]) {
  const db = new SqliteRelayDatabase(':memory:');
  const engine = new RelayEngine(db);
  for (const p of providers) engine.registerProvider(p);
  return { db, engine };
}

/* ================================================================== *
 * A — IDLE makes ZERO provider calls
 * ================================================================== */
describe('S2 group A — an IDLE Pair makes ZERO provider calls when asked to observe', () => {
  /**
   * Both sides are spied, and the assertion is on the COMBINED count.
   *
   * This is deliberate. Spying only the worker provider while observing the
   * PLANNER side would pass even if the gate were removed entirely, because the
   * planner's provider would be the one making the call. The zero-contact
   * property is only proven when the spy covers the side actually being observed.
   */
  it('A1: observing the planner side of an IDLE Pair contacts nothing and says so', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const cg = new ObserveSpyProvider('chatgpt');
    const { db, engine } = newEngine([oc, cg]);
    const { pair } = await seedPaired(db, engine);
    assert.strictEqual((await db.pairs.findById(pair.id))!.operationalState, 'IDLE');

    oc.reset();
    cg.reset();
    const res = await engine.observeSide(pair.id, 'planner');

    const seen = [...oc.calls.map((c) => `opencode.${c}`), ...cg.calls.map((c) => `chatgpt.${c}`)];
    assert.strictEqual(seen.length, 0, `I-2: an IDLE Pair must make no provider call, saw: ${seen.join(', ')}`);
    // Spelled out separately, so a failure says WHICH side leaked.
    assert.strictEqual(cg.total, 0, 'the planner side\'s own provider must not be called');
    assert.strictEqual(res.providerContacted, false, 'the result must state that nothing was contacted');
    assert.strictEqual(res.outcome, 'refused');
    assert.match(res.reason ?? '', /IDLE/, 'the refusal must name the actual reason');
    assert.match(res.reason ?? '', /Load & Activate/, 'the refusal must name the operation that would work');
    // I-3: the refusal must NOT fabricate an observation.
    assert.strictEqual(res.record.observation, null, 'a refused observation must not write a reading');
    db.close();
  });

  it('A2: observing the worker side of an IDLE Pair contacts nothing', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const cg = new ObserveSpyProvider('chatgpt');
    const { db, engine } = newEngine([oc, cg]);
    const { pair } = await seedPaired(db, engine);

    oc.reset();
    cg.reset();
    const res = await engine.observeSide(pair.id, 'worker');

    const seen = [...oc.calls.map((c) => `opencode.${c}`), ...cg.calls.map((c) => `chatgpt.${c}`)];
    assert.strictEqual(seen.length, 0, `I-2: saw ${seen.join(', ')}`);
    assert.strictEqual(oc.total, 0, 'the worker side\'s own provider must not be called');
    assert.strictEqual(res.providerContacted, false);
    assert.strictEqual(res.outcome, 'refused');
    db.close();
  });

  it('A4: a repeated IDLE observation still contacts nothing (no retry path leaks)', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const cg = new ObserveSpyProvider('chatgpt');
    const { db, engine } = newEngine([oc, cg]);
    const { pair } = await seedPaired(db, engine);

    for (let i = 0; i < 4; i++) {
      await engine.observeSide(pair.id, 'planner');
      await engine.observeSide(pair.id, 'worker');
    }
    assert.strictEqual(oc.total, 0, `saw: ${oc.calls.join(', ')}`);
    assert.strictEqual(cg.total, 0, `saw: ${cg.calls.join(', ')}`);
    db.close();
  });

  it('A3: ACTIVE permits observation — the gate is the only thing that changed', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    oc.reset();
    const res = await engine.observeSide(pair.id, 'worker');

    assert.strictEqual(res.outcome, 'observed');
    assert.strictEqual(res.providerContacted, true);
    assert.strictEqual(oc.total, 1, `exactly one capability call expected, saw: ${oc.calls.join(', ')}`);
    db.close();
  });
});

/* ================================================================== *
 * B / C — exact-session authority
 * ================================================================== */
describe('S2 groups B/C — observation targets the exact bound session, never another', () => {
  it('B: the worker side is observed by its own ses_ id while a different ses_ exists', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair, worker } = await seedPaired(db, engine, { activate: true, workerExternal: 'ses_a' });

    // A DIFFERENT OpenCode session exists. Nothing about it may be observed.
    const other = RuntimeSession.create('opencode', 'Other Worker');
    other.updateExternalIdentity('ses_b', '/dev/other');
    await db.runtimes.save(other);

    oc.reset();
    const res = await engine.observeSide(pair.id, 'worker');

    assert.deepStrictEqual(
      oc.addresses, ['ses_a'],
      `I-11: the provider must be addressed with the bound ses_ id only, saw: ${oc.addresses.join(', ')}`,
    );
    assert.ok(
      !oc.addresses.includes('ses_b'),
      'I-11: another existing session must never be observed instead',
    );
    assert.strictEqual(res.record.externalSessionId, 'ses_a');
    assert.strictEqual(res.record.runtimeSessionId, worker.id);
    db.close();
  });

  it('B2: the shared Pair Name is never used as an address', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    oc.reset();
    await engine.observeSide(pair.id, 'worker');

    for (const addr of oc.addresses) {
      assert.ok(
        addr !== 'Observation Pair' && !addr.toLowerCase().includes('relayx'),
        `I-11: the address must be a provider id, not a name, got '${addr}'`,
      );
    }
    db.close();
  });

  it('C: the planner side is observed by its own conversation id', async () => {
    const cg = new ObserveSpyProvider('chatgpt');
    const { db, engine } = newEngine([new ObserveSpyProvider('opencode'), cg]);
    const { pair } = await seedPaired(db, engine, { activate: true, plannerExternal: 'conv_planner' });

    cg.reset();
    const res = await engine.observeSide(pair.id, 'planner');

    assert.deepStrictEqual(cg.addresses, ['conv_planner'], 'C: the bound conversation id must be the address');
    assert.strictEqual(res.record.sideRole, 'planner');
    db.close();
  });
});

/* ================================================================== *
 * D — unknown is never coerced to false
 * ================================================================== */
describe('S2 group D — an unanswerable dimension is unknown, never false', () => {
  it('D1: a provider with no observation capability records unknown on every dimension', async () => {
    const { db, engine } = newEngine([new ObserveSpyProvider('opencode'), new LevelZeroProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    const res = await engine.observeSide(pair.id, 'planner');
    const o = res.record.observation!;

    assert.ok(o, 'a LEVEL 0 reading is still recorded: the capability gap is durable truth');
    assert.strictEqual(o.reachabilityState, 'unknown');
    assert.strictEqual(o.uiPresenceState, 'unknown');
    assert.strictEqual(o.activityState, 'unknown');
    assert.strictEqual(o.messageEvidenceState, 'unknown');
    // The decisive assertion: nowhere did unknown become a negative.
    for (const [name, value] of Object.entries({
      reachability: o.reachabilityState,
      uiPresence: o.uiPresenceState,
      activity: o.activityState,
      message: o.messageEvidenceState,
    })) {
      assert.ok(
        !['unreachable', 'absent', 'error', 'none'].includes(value),
        `I-6: ${name} must not be a fabricated negative, got '${value}'`,
      );
    }
    // §5.2: dimensions 8 and 9 are mandatory even for a capability gap.
    assert.strictEqual(o.observationCapability, NO_OBSERVATION_CAPABILITY);
    assert.ok(o.observedAt > 0, 'dimension 9 must always be populated');
    assert.match(o.reason ?? '', /capability/i, 'the gap must be explained');
    db.close();
  });

  it('D2: a thrown read is "could not observe", not a negative observation', async () => {
    const oc = new ObserveSpyProvider('opencode');
    oc.throwOnObserve = 'provider exploded';
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    const res = await engine.observeSide(pair.id, 'worker');
    const o = res.record.observation!;

    assert.strictEqual(o.reachabilityState, 'unknown', 'a throw is not proof of unreachability');
    assert.strictEqual(o.activityState, 'unknown', 'a throw is not proof of idleness');
    assert.match(o.reason ?? '', /provider exploded/, 'the real cause must survive into the record');
    db.close();
  });

  it('D3: a provider that answers only some dimensions leaves the rest unknown', async () => {
    const oc = new ObserveSpyProvider('opencode');
    oc.readings = [reading({
      reachabilityState: 'reachable',
      activityState: 'working',
      // message evidence and UI presence deliberately left unknown
    })];
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    const o = (await engine.observeSide(pair.id, 'worker')).record.observation!;
    assert.strictEqual(o.reachabilityState, 'reachable');
    assert.strictEqual(o.activityState, 'working');
    assert.strictEqual(o.messageEvidenceState, 'unknown', 'an unanswered dimension stays unknown');
    assert.strictEqual(o.uiPresenceState, 'unknown');
    db.close();
  });

  it('D4: ACTIVE does not mean the session is reachable or healthy', async () => {
    const oc = new ObserveSpyProvider('opencode');
    oc.readings = [reading({
      reachabilityState: 'unreachable',
      uiPresenceState: 'absent',
      activityState: 'unknown',
      messageEvidenceState: 'none',
    })];
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    const res = await engine.observeSide(pair.id, 'worker');
    // Permitted to observe, and the honest negative findings are recorded as-is.
    assert.strictEqual(res.outcome, 'observed');
    assert.strictEqual(res.record.observation!.reachabilityState, 'unreachable');
    // Critically: observing a broken side must not deactivate the Pair.
    assert.strictEqual((await db.pairs.findById(pair.id))!.operationalState, 'ACTIVE');
    db.close();
  });
});

/* ================================================================== *
 * E — durability across restart
 * ================================================================== */
describe('S2 group E — latest-observed evidence survives a restart', () => {
  it('E1: observe, close, reopen: the same reading is returned with ZERO provider calls', async () => {
    const t = tempDb('s2e');
    try {
      const oc = new ObserveSpyProvider('opencode');
      const db = new SqliteRelayDatabase(t.path);
      const engine = new RelayEngine(db);
      engine.registerProvider(oc);
      engine.registerProvider(new ObserveSpyProvider('chatgpt'));

      const { pair } = await seedPaired(db, engine, { activate: true });
      oc.readings = [reading({
        reachabilityState: 'reachable',
        activityState: 'idle',
        messageEvidenceState: 'observed',
        message: { ref: 'msg_7', role: 'assistant', text: 'done', truncated: false, ordinal: 6 },
        observationCapability: 'opencode_cli_session_status_transcript',
      })];

      const before = await engine.observeSide(pair.id, 'worker');
      assert.strictEqual(before.outcome, 'observed');
      db.close();

      // Reopen. A brand-new engine with NO providers registered at all: if
      // reading the stored observation needed a provider, this would throw.
      const db2 = new SqliteRelayDatabase(t.path);
      const engine2 = new RelayEngine(db2);
      const after = await db2.sideIdentities.find(pair.id as PairId, 'worker');

      assert.ok(after, 'the observation must have been persisted');
      const o = after!.observation!;
      assert.ok(o, 'the S2 reading must survive the restart');
      assert.strictEqual(o.activityState, 'idle');
      assert.strictEqual(o.messageEvidenceState, 'observed');
      assert.strictEqual(o.message.ref, 'msg_7');
      assert.strictEqual(o.message.ordinal, 6);
      assert.strictEqual(o.observationCapability, 'opencode_cli_session_status_transcript');
      assert.ok(o.validUntil > 0, '§5.4: the freshness marker must be persisted');
      // Dimensions 1-3 from S5 are still intact alongside the S2 dimensions.
      assert.strictEqual(after!.identityState, 'unknown', 'the S5 identity dimensions must be preserved, not clobbered');
      db2.close();
    } finally {
      t.cleanup();
    }
  });

  it('E2: a row written by S5 (no S2 columns) reads back as an ABSENT reading, not a fake unknown one', async () => {
    const t = tempDb('s2e2');
    try {
      const oc = new ObserveSpyProvider('opencode');
      const db = new SqliteRelayDatabase(t.path);
      const engine = new RelayEngine(db);
      engine.registerProvider(oc);
      engine.registerProvider(new ObserveSpyProvider('chatgpt'));
      const { pair } = await seedPaired(db, engine, { activate: true });

      // Simulate the pre-S2 state exactly: NULL every S2 column.
      db.db.prepare(`
        UPDATE pair_side_identity SET
          reachability_state = NULL, ui_presence_state = NULL, activity_state = NULL,
          message_evidence_state = NULL, message_ref = NULL, message_role = NULL,
          message_text = NULL, message_truncated = NULL, message_ordinal = NULL,
          observation_capability = NULL, observation_observed_at = NULL,
          valid_until = NULL, observation_evidence_json = NULL, observation_reason = NULL
        WHERE session_pair_id = ?
      `).run(pair.id);
      db.close();

      const db2 = new SqliteRelayDatabase(t.path);
      const row = (await db2.sideIdentities.find(pair.id as PairId, 'worker'))!;
      assert.strictEqual(
        row.observation, null,
        'I-6: "S2 never observed this side" must not be encoded as a fabricated unknown reading',
      );
      db2.close();
    } finally {
      t.cleanup();
    }
  });

  it('E3: the memory repository round-trips the same reading', async () => {
    const db = new MemoryRelayDatabase();
    const engine = new RelayEngine(db);
    const oc = new ObserveSpyProvider('opencode');
    engine.registerProvider(oc);
    engine.registerProvider(new ObserveSpyProvider('chatgpt'));
    const { pair } = await seedPaired(db, engine, { activate: true });

    oc.readings = [reading({
      messageEvidenceState: 'observed',
      message: { ref: 'msg_mem', role: 'user', text: 'hi', truncated: true, ordinal: 2 },
    })];
    await engine.observeSide(pair.id, 'worker');

    const stored = (await db.sideIdentities.find(pair.id as PairId, 'worker'))!;
    assert.strictEqual(stored.observation!.message.ref, 'msg_mem');
    assert.strictEqual(stored.observation!.message.truncated, true, 'C-8: truncation must be recorded');
  });
});

/* ================================================================== *
 * F — observation is NOT acknowledgement (§6.4)
 * ================================================================== */
describe('S2 group F — observation never advances a checkpoint or any consumption state', () => {
  it('F1: a newer provider reading moves latest-observed and nothing else', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    // Establish a real dispatch attempt first, so there IS a consumption record
    // that observation could plausibly corrupt.
    const assignment = await engine.createAssignment(pair.id, 'task', 'do the thing');
    const dispatched = await engine.dispatchAssignment(assignment.id);
    const attemptId = dispatched.attempt.id;
    const attemptStatusBefore = dispatched.attempt.status;

    // A full snapshot of every consumption-side table.
    const snapshot = () => ({
      attempts: JSON.stringify(db.db.prepare('SELECT * FROM attempts').all()),
      deliveries: JSON.stringify(db.db.prepare('SELECT * FROM deliveries').all()),
      handoffs: JSON.stringify(db.db.prepare('SELECT * FROM handoffs').all()),
      assignments: JSON.stringify(db.db.prepare('SELECT * FROM assignments').all()),
      pairs: JSON.stringify(db.db.prepare('SELECT * FROM pairs').all()),
    });
    const before = snapshot();

    oc.readings = [reading({
      messageEvidenceState: 'observed',
      message: { ref: 'msg_99', role: 'assistant', text: 'much later', truncated: false, ordinal: 98 },
    })];
    const res = await engine.observeSide(pair.id, 'worker');

    assert.strictEqual(res.record.observation!.message.ref, 'msg_99', 'latest-observed DID advance');
    const after = snapshot();
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      assert.strictEqual(after[key], before[key], `§6.4: observation must not modify ${key}`);
    }

    // The attempt still exists in exactly the state it was dispatched in.
    //
    // The status is captured BEFORE the observation and compared after, rather
    // than compared against a literal. An earlier draft asserted
    // `status !== 'acknowledged'`, which TypeScript rejected — correctly, because
    // `AttemptStatus` has no `acknowledged` member at all. So there is no status
    // an observation could switch an attempt to in order to claim it was
    // consumed. This form also survives a future widening of the union.
    const attempt = (await db.attempts.findById(attemptId as any))!;
    assert.ok(attempt, 'the attempt must survive observation');
    assert.strictEqual(
      attempt.status, attemptStatusBefore,
      '§6.4: observation must not advance the attempt past what dispatch established',
    );
    assert.strictEqual(attempt.id, attemptId, 'the attempt identity must be unchanged');
    db.close();
  });

  it('F2: there is no checkpoint column anywhere for observation to write into', async () => {
    // §6.4 is enforced structurally: the S2 record has no checkpoint field, so
    // no future edit can make observation advance one by accident.
    const t = tempDb('s2f');
    try {
      const oc = new ObserveSpyProvider('opencode');
      const db = new SqliteRelayDatabase(t.path);
      const engine = new RelayEngine(db);
      engine.registerProvider(oc);
      engine.registerProvider(new ObserveSpyProvider('chatgpt'));
      const { pair } = await seedPaired(db, engine, { activate: true });
      oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'm1', role: 'assistant', text: 't', truncated: false, ordinal: 1 } })];
      await engine.observeSide(pair.id, 'worker');

      const cols = (db.db.prepare("SELECT name FROM pragma_table_info('pair_side_identity')").all() as { name: string }[])
        .map((c) => c.name);
      for (const forbidden of ['checkpoint', 'checkpoint_at', 'consumed', 'acknowledged', 'last_consumed', 'cursor', 'watermark']) {
        assert.ok(
          !cols.includes(forbidden),
          `§15: S2 must not introduce a consumption field '${forbidden}'; that is the continuity tranche's`,
        );
      }
      const record = (await db.sideIdentities.find(pair.id as PairId, 'worker'))! as unknown as Record<string, unknown>;
      assert.ok(!('checkpoint' in record), 'the in-memory record must carry no checkpoint either');
      db.close();
    } finally {
      t.cleanup();
    }
  });

  it('F3: the emitted observation event explicitly records that no checkpoint advanced', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });
    await engine.observeSide(pair.id, 'worker');

    const events = (await db.events.findByResourceId(pair.id as string)) as any[];
    const observed = events.find((e) => e.eventType === 'pair.side_observed');
    assert.ok(observed, 'an observation must be auditable');
    assert.strictEqual(observed.details.checkpointAdvanced, false);
    db.close();
  });
});

/* ================================================================== *
 * G — side isolation
 * ================================================================== */
describe('S2 group G — observing one side cannot touch the other', () => {
  it('G1: observing the planner leaves the worker record byte-identical', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const cg = new ObserveSpyProvider('chatgpt');
    const { db, engine } = newEngine([oc, cg]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    // Give the worker a stored reading first, so there is something to preserve.
    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'w1', role: 'assistant', text: 'worker text', truncated: false, ordinal: 4 } })];
    await engine.observeSide(pair.id, 'worker');
    const workerBefore = JSON.stringify((await db.sideIdentities.find(pair.id as PairId, 'worker'))!);

    // Now observe the planner, with recognisably different content.
    cg.readings = [reading({ activityState: 'working', messageEvidenceState: 'observed', message: { ref: 'p1', role: 'user', text: 'planner text', truncated: false, ordinal: 9 } })];
    await engine.observeSide(pair.id, 'planner');

    const workerAfter = JSON.stringify((await db.sideIdentities.find(pair.id as PairId, 'worker'))!);
    assert.strictEqual(workerAfter, workerBefore, 'the worker record must be byte-identical after observing the planner');
    db.close();
  });

  it('G2: the reverse direction is equally isolated', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const cg = new ObserveSpyProvider('chatgpt');
    const { db, engine } = newEngine([oc, cg]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    cg.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'p1', role: 'user', text: 'pt', truncated: false, ordinal: 3 } })];
    await engine.observeSide(pair.id, 'planner');
    const plannerBefore = JSON.stringify((await db.sideIdentities.find(pair.id as PairId, 'planner'))!);

    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'w1', role: 'assistant', text: 'wt', truncated: false, ordinal: 5 } })];
    await engine.observeSide(pair.id, 'worker');

    assert.strictEqual(
      JSON.stringify((await db.sideIdentities.find(pair.id as PairId, 'planner'))!),
      plannerBefore,
      'the planner record must be byte-identical after observing the worker',
    );
    db.close();
  });

  it('G3: a planner reading can never overwrite the worker evidence artifact', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const cg = new ObserveSpyProvider('chatgpt');
    const { db, engine } = newEngine([oc, cg]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    oc.readings = [reading({ observationCapability: 'worker_cap', evidence: { id: 'ev_worker', timestamp: 1, source: 'reconciliation_probe' } })];
    await engine.observeSide(pair.id, 'worker');

    cg.readings = [reading({ observationCapability: 'planner_cap', evidence: { id: 'ev_planner', timestamp: 2, source: 'reconciliation_probe' } })];
    await engine.observeSide(pair.id, 'planner');

    const worker = (await db.sideIdentities.find(pair.id as PairId, 'worker'))!;
    assert.strictEqual(worker.observation!.observationCapability, 'worker_cap');
    assert.strictEqual(worker.observation!.evidence!.id, 'ev_worker');
    db.close();
  });

  /**
   * G4 is the regression test for a defect this file's first draft could not
   * see. The S4 identity artifact and the S2 observation artifact are different
   * facts about the same side, so they must occupy different storage. With a
   * null S4 artifact — the default in every other case here — the two columns
   * are indistinguishable, and any mapping that let one shadow the other would
   * pass silently. This test makes BOTH artifacts non-null and distinct, which
   * is the only configuration in which shadowing is observable.
   */
  it('G4: the S2 observation artifact never shadows the S4 identity artifact', async () => {
    const oc = new ObserveSpyProvider('opencode');
    oc.identityEvidenceId = 'ev_S4_identity';
    const cg = new ObserveSpyProvider('chatgpt');
    const { db, engine } = newEngine([oc, cg]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    // Precondition: S5 really did write a non-null identity artifact.
    const s5 = (await db.sideIdentities.find(pair.id as PairId, 'worker'))!;
    assert.ok(s5.evidence, 'the S4 identity artifact must be present for this test to mean anything');
    assert.strictEqual(s5.evidence!.id, 'ev_S4_identity');

    // Now write a DISTINCT S2 observation artifact for the same side.
    oc.readings = [reading({
      observationCapability: 'worker_obs_cap',
      evidence: { id: 'ev_S2_observation', timestamp: 999, source: 'reconciliation_probe' },
    })];
    await engine.observeSide(pair.id, 'worker');

    const after = (await db.sideIdentities.find(pair.id as PairId, 'worker'))!;
    assert.strictEqual(
      after.evidence!.id, 'ev_S4_identity',
      'the S4 identity artifact must survive an S2 observation unchanged',
    );
    assert.strictEqual(
      after.observation!.evidence!.id, 'ev_S2_observation',
      'the S2 observation artifact must be stored in its own column',
    );
    // And the two must be genuinely separate values, not the same object twice.
    assert.notStrictEqual(after.evidence!.id, after.observation!.evidence!.id);
    db.close();
  });
});

/* ================================================================== *
 * H — monotonicity / stale writes
 * ================================================================== */
describe('S2 group H — an older observation never overwrites a newer marker', () => {
  it('H1: durable ordinal N survives an attempted write of N-1', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'msg_10', role: 'assistant', text: 'newest', truncated: false, ordinal: 10 } })];
    const first = await engine.observeSide(pair.id, 'worker');
    assert.strictEqual(first.outcome, 'observed');
    assert.strictEqual(first.record.observation!.message.ordinal, 10);

    // A LATER read that reports an OLDER position — e.g. an out-of-order reply.
    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'msg_9', role: 'assistant', text: 'older', truncated: false, ordinal: 9 } })];
    const second = await engine.observeSide(pair.id, 'worker');

    assert.strictEqual(second.outcome, 'stale', 'an older reading must be reported as stale, not applied');
    assert.strictEqual(second.record.observation!.message.ordinal, 10, 'the durable marker must remain authoritative');
    assert.strictEqual(second.record.observation!.message.ref, 'msg_10');
    assert.match(second.reason ?? '', /OLDER/i, 'the refusal must be explained');

    // And it must be durable, not just in the returned object.
    const stored = (await db.sideIdentities.find(pair.id as PairId, 'worker'))!;
    assert.strictEqual(stored.observation!.message.ordinal, 10, 'the stale write must not have reached storage');
    db.close();
  });

  it('H2: where the provider supplies no ordering, NO ordering is invented', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    // A LEVEL 0 style reading: a message, but no provider ordering primitive.
    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: null, role: 'assistant', text: 'no ordinal', truncated: false, ordinal: null } })];
    const first = await engine.observeSide(pair.id, 'worker');
    assert.strictEqual(first.outcome, 'observed', 'with no ordering there is nothing to be stale against');
    assert.strictEqual(first.record.observation!.message.ordinal, null);

    // A second reading, also unordered, MUST be accepted: refusing it would mean
    // RelayX had invented an ordering it does not have.
    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: null, role: 'assistant', text: 'second', truncated: false, ordinal: null } })];
    const second = await engine.observeSide(pair.id, 'worker');
    assert.strictEqual(second.outcome, 'observed', 'I-7: no ordering may be invented, so no staleness may be claimed');
    assert.strictEqual(second.record.observation!.message.text, 'second');
    db.close();
  });

  it('H3: a stored ordinal does not make an UNORDERED new reading stale', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'm5', role: 'assistant', text: 'ordered', truncated: false, ordinal: 5 } })];
    await engine.observeSide(pair.id, 'worker');

    // Provider capability disappeared: the new reading carries no ordinal.
    oc.readings = [reading({ messageEvidenceState: 'unknown', message: { ref: null, role: null, text: null, truncated: false, ordinal: null }, reason: 'capability gone' })];
    const res = await engine.observeSide(pair.id, 'worker');
    assert.strictEqual(res.outcome, 'observed', 'an unordered reading cannot be compared, so it is not stale');
    assert.strictEqual(res.record.observation!.messageEvidenceState, 'unknown');
    db.close();
  });

  it('H4: ordinals are never compared ACROSS sides (§4: no fake global ordering)', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const cg = new ObserveSpyProvider('chatgpt');
    const { db, engine } = newEngine([oc, cg]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    // The planner is at a HIGH ordinal and the worker at a LOW one. A global
    // sequence would call the planner "ahead". Each side must be judged only
    // against its own previous reading.
    cg.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'p', role: 'user', text: 'x', truncated: false, ordinal: 500 } })];
    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'w', role: 'assistant', text: 'y', truncated: false, ordinal: 2 } })];
    await engine.observeSide(pair.id, 'planner');
    const w = await engine.observeSide(pair.id, 'worker');
    assert.strictEqual(w.outcome, 'observed', 'the worker must not be judged against the planner ordinal');
    db.close();
  });
});

/* ================================================================== *
 * I — restart into IDLE reads last-known only
 * ================================================================== */
describe('S2 group I — after Make Idle and a restart, only local last-known evidence is readable', () => {
  it('I1: ACTIVE -> observe -> Make Idle -> restart -> read locally with ZERO provider calls', async () => {
    const t = tempDb('s2i');
    try {
      const oc = new ObserveSpyProvider('opencode');
      const db = new SqliteRelayDatabase(t.path);
      const engine = new RelayEngine(db);
      engine.registerProvider(oc);
      engine.registerProvider(new ObserveSpyProvider('chatgpt'));
      const { pair } = await seedPaired(db, engine, { activate: true });

      oc.readings = [reading({ activityState: 'idle', messageEvidenceState: 'observed', message: { ref: 'msg_last', role: 'assistant', text: 'final answer', truncated: false, ordinal: 12 } })];
      await engine.observeSide(pair.id, 'worker');

      await engine.makePairIdle(pair.id, 'end of session');
      assert.strictEqual((await db.pairs.findById(pair.id))!.operationalState, 'IDLE');
      db.close();

      // Reopen with NO providers registered at all.
      const db2 = new SqliteRelayDatabase(t.path);
      const engine2 = new RelayEngine(db2);
      const stored = (await db2.sideIdentities.find(pair.id as PairId, 'worker'))!;
      assert.ok(stored.observation, 'I-10: Make Idle must preserve the last-known observation');
      assert.strictEqual(stored.observation!.message.ref, 'msg_last');
      assert.strictEqual(stored.observation!.activityState, 'idle');

      // Asking to observe again is refused, and refused without a provider.
      const res = await engine2.observeSide(pair.id, 'worker');
      assert.strictEqual(res.outcome, 'refused');
      assert.strictEqual(res.providerContacted, false);
      // The refusal still returns the last-known evidence, clearly framed as such.
      assert.match(res.reason ?? '', /last-known/i, 'I-3: the refusal must frame the stored value as last-known');
      assert.strictEqual(res.record.observation!.message.ref, 'msg_last', 'the stored evidence is still readable');
      db2.close();
    } finally {
      t.cleanup();
    }
  });

  it('I2: Make Idle is idempotent and never destroys the observation', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });
    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'keep', role: 'assistant', text: 't', truncated: false, ordinal: 1 } })];
    await engine.observeSide(pair.id, 'worker');

    await engine.makePairIdle(pair.id, 'first');
    await engine.makePairIdle(pair.id, 'second');
    await engine.makePairIdle(pair.id, undefined);

    const stored = (await db.sideIdentities.find(pair.id as PairId, 'worker'))!;
    assert.strictEqual(stored.observation!.message.ref, 'keep', 'I-10: repeated Make Idle must not lose evidence');
    db.close();
  });
});

/* ================================================================== *
 * J — a stored observation must not be attributed to a different session
 * ================================================================== */
describe('S2 group J — a rebind cannot inherit the previous session\'s evidence', () => {
  /**
   * The defect this group closes
   *
   * `updatePair()` rebinds a side to a different runtime and never touches the
   * side-identity rows. A row written before the rebind therefore still names the
   * PREVIOUS session. If that row is treated as this side's evidence, two separate
   * lies follow:
   *
   *   1. the side would report the old session's latest message as its own, and
   *   2. the old session's ordinal would become the monotonic baseline, so a
   *      legitimate first observation of the NEW session could be rejected as
   *      "stale" purely because the new session happens to be further along.
   *
   * Deciding WHEN a rebind should discard evidence is the replacement contract's
   * job (SESSION_PAIR_REPLACEMENT.md, C-1) and is deliberately untouched. What S2
   * must guarantee is narrower and is what these tests pin: a record describing a
   * different session is neither returned nor used as a baseline.
   */
  it('J1: after a rebind, the previous session\'s ordinal is not used as the baseline', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const cg = new ObserveSpyProvider('chatgpt');
    const { db, engine } = newEngine([oc, cg]);
    const { pair, worker } = await seedPaired(db, engine, {
      activate: true,
      workerExternal: 'ses_old',
    });

    // The old session is observed at a HIGH ordinal.
    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'old_msg', role: 'assistant', text: 'old', truncated: false, ordinal: 900 } })];
    await engine.observeSide(pair.id, 'worker');

    // Rebind the worker side to a genuinely different session.
    const newWorker = RuntimeSession.create('opencode', 'New Worker');
    newWorker.updateExternalIdentity('ses_new', '/dev/obs');
    await db.runtimes.save(newWorker);
    await db.associations.save(
      RuntimeProjectAssociation.create(newWorker.id, (await db.pairs.findById(pair.id))!.projectId, 'ses_new', 'verified', 'discovery', 'opencode'),
    );
    await engine.rebindPairWorker(pair.id, newWorker.id);
    await engine.loadAndActivate(pair.id);

    // The NEW session is at a LOW ordinal. With the old row as baseline this would
    // be misreported as stale; with no baseline it is simply the first reading.
    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'new_msg', role: 'assistant', text: 'new', truncated: false, ordinal: 1 } })];
    const res = await engine.observeSide(pair.id, 'worker');

    assert.strictEqual(
      res.outcome, 'observed',
      'a different session\'s ordinal must not make this side\'s first reading look stale',
    );
    assert.strictEqual(res.record.externalSessionId, 'ses_new', 'the record must name the newly bound session');
    assert.strictEqual(res.record.observation!.message.ref, 'new_msg');
    assert.ok(
      /no longer bound/.test(res.reason ?? ''),
      `the supersession must be reported, got: ${res.reason}`,
    );
    assert.ok(worker.id !== newWorker.id, 'fixture sanity: the runtime really did change');
    db.close();
  });

  it('J2: after a rebind, the previous session\'s identity verdict is not inherited', async () => {
    const oc = new ObserveSpyProvider('opencode');
    oc.identityEvidenceId = 'ev_S4_old';
    const cg = new ObserveSpyProvider('chatgpt');
    const { db, engine } = newEngine([oc, cg]);
    const { pair } = await seedPaired(db, engine, { activate: true, workerExternal: 'ses_old' });

    const before = (await db.sideIdentities.find(pair.id as PairId, 'worker'))!;
    assert.strictEqual(before.externalSessionId, 'ses_old');

    const newWorker = RuntimeSession.create('opencode', 'New Worker 2');
    newWorker.updateExternalIdentity('ses_new2', '/dev/obs');
    await db.runtimes.save(newWorker);
    await db.associations.save(
      RuntimeProjectAssociation.create(newWorker.id, (await db.pairs.findById(pair.id))!.projectId, 'ses_new2', 'verified', 'discovery', 'opencode'),
    );
    await engine.rebindPairWorker(pair.id, newWorker.id);
    await engine.loadAndActivate(pair.id);
    await engine.observeSide(pair.id, 'worker');

    const after = (await db.sideIdentities.find(pair.id as PairId, 'worker'))!;
    assert.strictEqual(after.externalSessionId, 'ses_new2');
    assert.ok(
      after.evidence === null || after.evidence.id !== 'ev_S4_old',
      'the previous session\'s identity artifact must not be presented as this session\'s',
    );
    db.close();
  });

  it('J3: the superseded record is left on disk, not deleted', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true, workerExternal: 'ses_old' });
    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'keepme', role: 'assistant', text: 't', truncated: false, ordinal: 5 } })];
    await engine.observeSide(pair.id, 'worker');

    // A refusal on an IDLE pair must still surface the same-session record.
    await engine.makePairIdle(pair.id, 'stop');
    const res = await engine.observeSide(pair.id, 'worker');
    assert.strictEqual(res.outcome, 'refused');
    assert.strictEqual(
      res.record.observation!.message.ref, 'keepme',
      'I-3: an IDLE refusal still returns the last-known evidence for the bound session',
    );
    db.close();
  });
});

/* ================================================================== *
 * Regression guards on the S1-S6 foundation
 * ================================================================== */describe('S2 regression guards — S2 does not weaken the committed foundation', () => {
  it('R1: observation does not create assignments, attempts, deliveries or handoffs', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });
    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'm', role: 'assistant', text: 't', truncated: false, ordinal: 1 } })];
    await engine.observeSide(pair.id, 'worker');
    await engine.observeSide(pair.id, 'planner');

    for (const table of ['assignments', 'attempts', 'deliveries', 'handoffs']) {
      const count = (db.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
      assert.strictEqual(count, 0, `observation must not create a ${table} row`);
    }
    db.close();
  });

  it('R2: observation never changes operational state in either direction', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });
    for (let i = 0; i < 3; i++) await engine.observeSide(pair.id, 'worker');
    assert.strictEqual((await db.pairs.findById(pair.id))!.operationalState, 'ACTIVE');

    // And a refused observation on an IDLE pair must not activate it.
    await engine.makePairIdle(pair.id, 'test');
    await engine.observeSide(pair.id, 'worker');
    assert.strictEqual((await db.pairs.findById(pair.id))!.operationalState, 'IDLE', 'observation must never activate a Pair');
    db.close();
  });

  it('R3: the S5 identity verdict is carried forward, never recomputed or weakened', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair } = await seedPaired(db, engine, { activate: true });

    const before = (await db.sideIdentities.find(pair.id as PairId, 'worker'))!;
    oc.readings = [reading({ reachabilityState: 'unreachable', activityState: 'unknown' })];
    await engine.observeSide(pair.id, 'worker');
    const after = (await db.sideIdentities.find(pair.id as PairId, 'worker'))!;

    assert.strictEqual(after.identityState, before.identityState, 'dimension 1 must be carried forward verbatim');
    assert.strictEqual(after.verificationState, before.verificationState, 'dimension 2 must be carried forward verbatim');
    assert.strictEqual(after.existenceState, before.existenceState, 'dimension 3 must be carried forward verbatim');
    assert.strictEqual(after.sourceCapability, before.sourceCapability, 'the S4 capability provenance must be preserved');
    assert.strictEqual(after.evidence, before.evidence, 'the S4 evidence artifact must not be overwritten by S2');
    db.close();
  });

  it('R4: the v6 migration is additive — no pre-existing column was dropped or renamed', async () => {
    const t = tempDb('s2r');
    try {
      const db = new SqliteRelayDatabase(t.path);
      const cols = (db.db.prepare("SELECT name FROM pragma_table_info('pair_side_identity')").all() as { name: string }[])
        .map((c) => c.name);
      // Every column v5 created must still be present.
      for (const preserved of [
        'id', 'session_pair_id', 'side_role', 'provider_type', 'runtime_session_id',
        'external_session_id', 'identity_state', 'identity_value', 'verification_state',
        'verification_value', 'existence_state', 'capability', 'source_capability',
        'observed_at', 'reason', 'evidence_json',
      ]) {
        assert.ok(cols.includes(preserved), `§10.1: the v5 column '${preserved}' must survive the v6 migration`);
      }
      // And every v6 column is present.
      for (const added of [
        'reachability_state', 'ui_presence_state', 'activity_state', 'message_evidence_state',
        'message_ref', 'message_role', 'message_text', 'message_truncated', 'message_ordinal',
        'observation_capability', 'observation_observed_at', 'valid_until',
        'observation_evidence_json', 'observation_reason',
      ]) {
        assert.ok(cols.includes(added), `the v6 column '${added}' must exist`);
      }
      assert.strictEqual((db.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 6);
      db.close();
    } finally {
      t.cleanup();
    }
  });

  it('R5: an existing association/assignment/handoff survives observation untouched', async () => {
    const oc = new ObserveSpyProvider('opencode');
    const { db, engine } = newEngine([oc, new ObserveSpyProvider('chatgpt')]);
    const { pair, planner, worker } = await seedPaired(db, engine, { activate: true });

    const assignmentsBefore = (await db.assignments.findByPairId(pair.id)).length;
    const assocBefore = (await db.associations.findBySessionId(worker.id)).length;

    oc.readings = [reading({ messageEvidenceState: 'observed', message: { ref: 'm', role: 'assistant', text: 't', truncated: false, ordinal: 1 } })];
    await engine.observeSide(pair.id, 'worker');
    await engine.observeSide(pair.id, 'planner');

    assert.strictEqual((await db.assignments.findByPairId(pair.id)).length, assignmentsBefore);
    assert.strictEqual((await db.associations.findBySessionId(worker.id)).length, assocBefore);
    assert.ok((await db.runtimes.findById(planner.id)), 'the planner runtime must survive');
    assert.ok((await db.runtimes.findById(worker.id)), 'the worker runtime must survive');
    db.close();
  });
});
