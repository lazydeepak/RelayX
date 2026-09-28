/**
 * Readiness is a derived FACT, not execution authority.
 *
 * ## What went wrong, and why it is worth a frozen regression
 *
 * An earlier revision of `dispatchAssignment` refused every dispatch whose derived
 * readiness level was not `READY`. It looked like strictness. It was two errors at once.
 *
 * 1. **It inverted the frozen design.** `DESIGN_FREEZE_SESSION_PAIR_OPERATIONS.md` §8.3
 *    `[FROZEN]`: "Readiness describes observational sufficiency. It is **not** execution
 *    permission. ... A `ready` Pair is not thereby authorized to dispatch." §8.2 `[FROZEN]`:
 *    a persisted readiness value "may **never** gate, permit, or enable an action." §4.3
 *    `[FROZEN]`: "ACTIVE is not permission to dispatch." The real gates are I-2
 *    (`operational_state === ACTIVE`) and the frozen execution authority on the Attempt.
 *
 * 2. **It made dispatch impossible.** The planner side is a ChatGPT browser session at
 *    LEVEL 0 — no message reference, no ordinal. `evaluateSideContinuity` therefore returns
 *    `unknown` for it permanently, Pair continuity can never leave `UNKNOWN`, and readiness
 *    can never reach `READY`. The gate did not enforce the freeze; it disabled dispatch for
 *    every Pair with a browser planner, silently and permanently.
 *
 * ## What is enforced instead
 *
 * Exactly one evidence-backed negative, in `assertDispatchTargetPresent`: a side observed
 * `absent` in the provider's own store blocks the dispatch, because a send into a session
 * that provably does not exist is a blind write. A merely `unknown` observation does NOT
 * block — honest degradation is not a defect (I-6).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import { MockProvider } from './MockProvider.ts';
import { RuntimeSession, RuntimeProjectAssociation } from '../src/relay/domain/entities.ts';
import { AssociationId, createId } from '../src/relay/domain/types.ts';

describe('Readiness is derived, not authoritative', () => {
  let db: SqliteRelayDatabase;
  let engine: RelayEngine;
  let service: RelayApiService;

  beforeEach(() => {
    db = new SqliteRelayDatabase(':memory:');
    engine = new RelayEngine(db);
    service = new RelayApiService(db, engine);
    engine.registerProvider(new MockProvider('chatgpt'));
    engine.registerProvider(new MockProvider('opencode'));
  });

  async function pairWithSides(name: string, opts: { activate: boolean }) {
    const project = await engine.createProject(`${name} Project`);
    const mk = (providerType: 'chatgpt' | 'opencode', external: string) =>
      new RuntimeSession({
        id: createId('sess'),
        providerType,
        name: `${providerType} session`,
        status: 'available',
        consecutiveObservationFailures: 0,
        externalSessionId: external,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    const planner = mk('chatgpt', 'ses_planner_ready');
    const worker = mk('opencode', 'ses_worker_ready');
    await db.runtimes.save(planner);
    await db.runtimes.save(worker);
    for (const [i, s] of [planner, worker].entries()) {
      await db.associations.save(
        new RuntimeProjectAssociation({
          id: `assoc_${name}_${i}` as AssociationId,
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
    const pair = await engine.createPair(project.id, name, planner.id, worker.id);
    if (opts.activate) {
      assert.strictEqual((await engine.loadAndActivate(pair.id)).outcome, 'activated');
    }
    return { pair, planner, worker, project };
  }

  it('a Pair whose readiness is NOT READY can still dispatch', async () => {
    // The regression that matters. With no acknowledged checkpoints on either side the
    // derived level is UNKNOWN, and dispatch must proceed anyway.
    const { pair } = await pairWithSides('Not Ready Still Dispatches', { activate: true });

    const readiness = await engine.computePairReadiness(pair.id);
    assert.notStrictEqual(
      readiness.state,
      'READY',
      `precondition: this Pair must not be READY (got ${readiness.state})`,
    );

    const assignment = await service.createAssignment(pair.id, 'A', 'do the work');
    const result = await service.dispatchAssignment(assignment.id);
    assert.strictEqual(
      result.deliveryOutcome,
      'delivered',
      'a derived level below READY must not be able to block execution',
    );
  });

  it('the absence of any readiness gate in the dispatch path is structural, not incidental', () => {
    // Source-level assertion, because the failure mode was a single `if` that no behavioural
    // test would reliably catch once every fixture happened to be READY. The architectural
    // fence in `pair_replacement_fence.test.ts` enforces the same rule against the app layer.
    const src = engineSrc();
    const dispatchBody = src.slice(src.indexOf('public async dispatchAssignment'));
    const assertBody = dispatchBody.slice(0, dispatchBody.indexOf('Phase 1b'));

    assert.ok(
      !/readiness\s*[:=]/i.test(assertBody) && !/deriveReadiness|getReadiness|computePairReadiness/.test(assertBody),
      'the dispatch precondition block must not consult readiness at all',
    );
    assert.ok(
      assertBody.includes('assertProviderContactPermitted'),
      'I-2 (operational_state === ACTIVE) IS the dispatch gate, and it must be present',
    );
    assert.ok(
      assertBody.includes('assertDispatchTargetPresent'),
      'the proven-absence guard is the one evidence-backed negative that must be present',
    );
  });

  it('a proven-ABSENT worker session DOES block dispatch — the one negative that still applies', async () => {
    // Readiness being non-authoritative must not be mistaken for "nothing blocks a dispatch".
    // An absent session is a completed read with a negative result, so refusing is correct.
    const { pair, worker } = await pairWithSides('Absent Target', { activate: true });

    await setExistence(pair.id, 'worker', worker.id, 'absent', 'ses_worker_absent');

    const assignment = await service.createAssignment(pair.id, 'A', 'do the work');
    await assert.rejects(
      async () => service.dispatchAssignment(assignment.id),
      (err: any) => {
        assert.strictEqual(err.code, 'DISPATCH_TARGET_ABSENT');
        assert.ok(err.message.includes('ses_worker_absent'), 'the refusal names the absent session');
        return true;
      },
    );
  });

  it('an UNKNOWN observation does NOT block — honest degradation is not a defect (I-6)', async () => {
    const { pair, worker } = await pairWithSides('Unknown Target', { activate: true });
    await setExistence(pair.id, 'worker', worker.id, 'unknown', 'ses_worker_unknown');

    const assignment = await service.createAssignment(pair.id, 'A', 'do the work');
    assert.strictEqual((await service.dispatchAssignment(assignment.id)).deliveryOutcome, 'delivered');
  });

  it('a PRESENT observation does not block either — only the negative does', async () => {
    const { pair, worker } = await pairWithSides('Present Target', { activate: true });
    await setExistence(pair.id, 'worker', worker.id, 'present', 'ses_worker_present');

    const assignment = await service.createAssignment(pair.id, 'A', 'do the work');
    assert.strictEqual((await service.dispatchAssignment(assignment.id)).deliveryOutcome, 'delivered');
  });

  it('readiness confers NO authority in the other direction either: IDLE is still refused', async () => {
    // A READY-looking Pair must not become the thing that authorises execution. The I-2 gate
    // is the only thing that does, and it is checked independently of any derived level.
    const { pair } = await pairWithSides('Idle Is Refused', { activate: false });

    const assignment = await service.createAssignment(pair.id, 'A', 'do the work');
    await assert.rejects(
      async () => service.dispatchAssignment(assignment.id),
      (err: any) => {
        assert.strictEqual(err.code, 'PAIR_OPERATIONAL_STATE_IDLE');
        return true;
      },
    );
  });

  it('readiness is never PERSISTED — it is recomputed from the current evidence every time', async () => {
    // §8.2: readiness is a cache with a validity window, which is exactly why it must not be
    // authority. If it were stored, a stale value could outlive the evidence behind it.
    const { pair } = await pairWithSides('Never Persisted', { activate: true });
    await engine.computePairReadiness(pair.id);

    const reloaded = await db.pairs.findById(pair.id);
    const keys = Object.keys(reloaded as unknown as Record<string, unknown>);
    assert.ok(
      !keys.some((k) => /readi|ready|health|attent/i.test(k)),
      `no readiness-shaped field may be persisted on a Pair; found: ${keys.join(', ')}`,
    );
  });

  /**
   * Record a COMPLETED observation of one side's existence.
   *
   * The row `loadAndActivate` created is mutated rather than replaced, so the test exercises
   * the real persisted shape instead of a hand-built one that could silently drift from it.
   */
  async function setExistence(
    pairId: string,
    sideRole: 'planner' | 'worker',
    runtimeSessionId: string,
    existenceState: 'present' | 'absent' | 'unknown',
    externalSessionId: string,
  ) {
    const row = await db.sideIdentities.find(pairId as never, sideRole);
    assert.ok(row, `precondition: a ${sideRole} identity row exists after activation`);
    assert.strictEqual(row!.runtimeSessionId, runtimeSessionId);
    row!.existenceState = existenceState;
    row!.externalSessionId = externalSessionId;
    row!.identityState = 'resolved';
    row!.identityValue = externalSessionId;
    row!.verificationState = 'verified';
    row!.verificationValue = externalSessionId;
    row!.observation = {
      reachabilityState: existenceState === 'absent' ? 'reachable' : 'unknown',
      uiPresenceState: 'unknown',
      activityState: 'unknown',
      messageEvidenceState: 'unknown',
      message: { ref: null, role: null, text: null, truncated: false, ordinal: null },
      observationCapability: 'test_seed',
      observedAt: Date.now(),
      validUntil: Date.now() + 60_000,
      reason:
        existenceState === 'absent'
          ? 'The session was not found in the provider store during a completed read.'
          : 'The provider exposed no capability to answer this question.',
      evidence: null,
    };
    await db.sideIdentities.save(row!);
  }
});

function engineSrc(): string {
  return readFileSync(
    new URL('../src/relay/application/RelayEngine.ts', import.meta.url).pathname,
    'utf8',
  );
}
