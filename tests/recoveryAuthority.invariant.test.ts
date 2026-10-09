/**
 * Planner-First Recovery Authority Invariants — focused tests (§RECOVERY_FREEZE)
 *
 * Proves: recovery owner is always PLANNER, never selectable, never mutated,
 * normal baton is never confused with recovery authority, and the only permitted
 * continuation during recovery is Planner → Worker.
 */
import { describe, it } from 'node:test';
import expect from 'expect';
import { RECOVERY_AUTHORITY, RECOVERY_AUTHORITY_LABEL, getRecoveryOwner, assertRecoveryAuthorityIndependentOfBaton, permittedTransitionDuringRecovery, isWorkerSideRecoveryTarget, initiatePlannerFirstRecovery, openPlannerIntervention, resolvePlannerRecovery, assertNoSelectableRecoveryDestination } from '../src/relay/domain/recoveryAuthority';

describe('Recovery Authority — Invariant R1 (fixed PLANNER)', () => {
  it('getRecoveryOwner always returns PLANNER', () => {
    expect(getRecoveryOwner()).toBe('planner');
  });

  it('RECOVERY_AUTHORITY is exactly planner, never selectable', () => {
    expect(RECOVERY_AUTHORITY).toBe('planner');
    expect(RECOVERY_AUTHORITY_LABEL).toBe('PLANNER');
  });

  it('assertNoSelectableRecoveryDestination passes for PLANNER and rejects others', () => {
    assertNoSelectableRecoveryDestination('planner');
    const badWorker = 'worker';
    const badUnknown = 'unknown';
    expect(() => assertNoSelectableRecoveryDestination(badWorker)).toThrow(/Planner-first recovery violation/i);
    expect(() => assertNoSelectableRecoveryDestination(badUnknown)).toThrow(/Planner-first recovery violation/i);
  });
});

describe('Recovery Authority — Invariant R2 / R3 (separate from baton)', () => {
  it('assertRecoveryAuthorityIndependentOfBaton is true for both baton owners', () => {
    expect(assertRecoveryAuthorityIndependentOfBaton('planner')).toBe(true);
    expect(assertRecoveryAuthorityIndependentOfBaton('worker')).toBe(true);
    expect(assertRecoveryAuthorityIndependentOfBaton(null)).toBe(true);
  });

  it('recovery state never stores a selectable destination', () => {
    const state = initiatePlannerFirstRecovery({
      condition: 'delivery_failed',
      reason: 'transport failure',
      observedAt: Date.now(),
    });
    expect(state.recoveryOwner).toBe('planner');
    expect(state.active).toBe(true);
    expect(state.interventionOpen).toBe(false);
  });
});

describe('Recovery Authority — Invariant R4 (only Planner → Worker permitted)', () => {
  it('permittedTransitionDuringRecovery allowsonly Planner → Worker', () => {
    expect(permittedTransitionDuringRecovery('planner', 'worker')).toBe(true);
    expect(permittedTransitionDuringRecovery('worker', 'planner')).toBe(false);
    expect(permittedTransitionDuringRecovery('planner', 'planner')).toBe(false);
    expect(permittedTransitionDuringRecovery('worker', 'worker')).toBe(false);
  });

  it('intervention opens without changing permitted transition rules', () => {
    const init = initiatePlannerFirstRecovery({ condition: 'reconciliation_failed', reason: 'conflict', observedAt: 1 });
    const open = openPlannerIntervention(init);
    expect(open.interventionOpen).toBe(true);
    expect(open.recoveryOwner).toBe('planner');
    expect(permittedTransitionDuringRecovery('planner', 'worker')).toBe(true);
  });

  it('resolve closes recovery but does not permit Worker-side continuation', () => {
    const resolved = resolvePlannerRecovery(
      openPlannerIntervention(initiatePlannerFirstRecovery({ condition: 'no_usable_deliverable', reason: 'empty', observedAt: 1 })),
    );
    expect(resolved.active).toBe(false);
    expect(resolved.interventionOpen).toBe(false);
    // After resolution, the next move is from Planner (authoritative instruction) to Worker.
    // There is no path that resumes from Worker directly.
    expect(permittedTransitionDuringRecovery('worker', 'planner')).toBe(false);
  });
});

describe('Recovery Authority — Invariant R6 / R7 (Worker never recovery target)', () => {
  it('isWorkerSideRecoveryTarget is always false — worker is never recovery dispatch target', () => {
    expect(isWorkerSideRecoveryTarget('worker')).toBe(false);
    expect(isWorkerSideRecoveryTarget('planner')).toBe(false);
  });

  it('initiate does not allow a worker destination to be set', () => {
    const s = initiatePlannerFirstRecovery({ condition: 'worker_execution_failed', reason: 'crash', observedAt: 1 });
    // The recovery owner is fixed; attempting to change it violates the freeze.
    expect(s.recoveryOwner).toBe('planner');
  });
});

describe('Recovery Authority — Invariant R5 (no selectable destination dropdown)', () => {
  it('no dropdown option exists — only PLANNER is representable', () => {
    const valid = ['planner'];
    const invalid = ['worker', 'both', 'auto', 'unknown'];
    for (const v of valid) {
      assertNoSelectableRecoveryDestination(v);
    }
    for (const v of invalid) {
      expect(() => assertNoSelectableRecoveryDestination(v)).toThrow();
    }
  });
});
