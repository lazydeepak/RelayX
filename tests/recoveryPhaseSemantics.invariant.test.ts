/**
 * INVARIANT TESTS: Recovery Phase Semantics & Evidence-Driven Transitions
 *
 * Tests that recovery state transitions are driven by durable evidence,
 * not by calling phase-mutator functions in sequence.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecoveryState,
  recordRecoveryIngressDeliveryCreated,
  recordRecoveryIngressConfirmed,
  recordPlannerDecision,
  authorizeContinuation,
  recordContinuationDeliveryCreated,
  recordContinuationDispatched,
  validateRecoveryOperation,
  getRecoveryOwner,
  assertRecoveryAuthorityIndependentOfBaton,
  assertNoSelectableRecoveryDestination,
  RECOVERY_AUTHORITY,
  type RecoveryState,
  type RecoveryEvidence,
} from '../src/relay/domain/recoveryAuthority';

describe('Recovery Phase Semantics', () => {
  const evidence: RecoveryEvidence = {
    condition: 'delivery_failed',
    sourceDeliveryId: 'del_trigger_123',
    sourceAssignmentId: 'ass_source_456',
    reason: 'Worker delivery timed out after 300s',
    observedAt: 1728280800000,
  };

  describe('Phase lifecycle driven by durable evidence', () => {
    it('creates recovery in REQUIRED phase with evidence', () => {
      const state = createRecoveryState(evidence);
      assert.strictEqual(state.phase, 'required');
      assert.deepEqual(state.evidence, evidence);
      assert.strictEqual(state.plannerIngressDeliveryId, undefined);
      assert.strictEqual(state.plannerIngressConfirmedAt, undefined);
      assert.strictEqual(state.plannerDecisionAssignmentId, undefined);
      assert.strictEqual(state.continuationAuthorizedAt, undefined);
    });

    it('stays in REQUIRED after ingress delivery created but NOT confirmed', () => {
      const state = createRecoveryState(evidence);
      const withIngress = recordRecoveryIngressDeliveryCreated(state, 'del_ingress_789');
      assert.strictEqual(withIngress.phase, 'required'); // Still required!
      assert.strictEqual(withIngress.plannerIngressDeliveryId, 'del_ingress_789');
      assert.strictEqual(withIngress.plannerIngressConfirmedAt, undefined);
    });

    it('transitions to PLANNER_INTERVENTION only after ingress CONFIRMED', () => {
      const state = createRecoveryState(evidence);
      const withIngress = recordRecoveryIngressDeliveryCreated(state, 'del_ingress_789');
      const confirmed = recordRecoveryIngressConfirmed(withIngress, 1728280805000);
      assert.strictEqual(confirmed.phase, 'planner_intervention');
      assert.strictEqual(confirmed.plannerIngressConfirmedAt, 1728280805000);
    });

    it('cannot confirm ingress without delivery created first', () => {
      const state = createRecoveryState(evidence);
      assert.throws(
        () => recordRecoveryIngressConfirmed(state, 1728280805000),
        /Cannot confirm ingress/
      );
    });

    it('transitions to PLANNER_DECIDED only after planner decision observed', () => {
      const state = createRecoveryState(evidence);
      const withIngress = recordRecoveryIngressDeliveryCreated(state, 'del_ingress_789');
      const intervention = recordRecoveryIngressConfirmed(withIngress, 1728280805000);
      const decided = recordPlannerDecision(intervention, 'ass_planner_decision_012', 1728280810000);
      assert.strictEqual(decided.phase, 'planner_decided');
      assert.strictEqual(decided.plannerDecisionAssignmentId, 'ass_planner_decision_012');
      assert.strictEqual(decided.plannerDecisionAt, 1728280810000);
    });

    it('cannot record planner decision without intervention phase', () => {
      const state = createRecoveryState(evidence);
      const withIngress = recordRecoveryIngressDeliveryCreated(state, 'del_ingress_789');
      assert.throws(
        () => recordPlannerDecision(withIngress, 'ass_012', 1728280810000),
        /Cannot record planner decision/
      );
    });

    it('transitions to CONTINUATION_AUTHORIZED after relay authorization', () => {
      const state = createRecoveryState(evidence);
      const withIngress = recordRecoveryIngressDeliveryCreated(state, 'del_ingress_789');
      const intervention = recordRecoveryIngressConfirmed(withIngress, 1728280805000);
      const decided = recordPlannerDecision(intervention, 'ass_012', 1728280810000);
      const authorized = authorizeContinuation(decided, 1728280815000);
      assert.strictEqual(authorized.phase, 'continuation_authorized');
      assert.strictEqual(authorized.continuationAuthorizedAt, 1728280815000);
    });

    it('cannot authorize continuation without planner decision', () => {
      const state = createRecoveryState(evidence);
      const withIngress = recordRecoveryIngressDeliveryCreated(state, 'del_ingress_789');
      const intervention = recordRecoveryIngressConfirmed(withIngress, 1728280805000);
      assert.throws(
        () => authorizeContinuation(intervention, 1728280815000),
        /Cannot authorize continuation/
      );
    });

    it('stays in CONTINUATION_AUTHORIZED after delivery created but NOT dispatched', () => {
      const state = createRecoveryState(evidence);
      const withIngress = recordRecoveryIngressDeliveryCreated(state, 'del_ingress_789');
      const intervention = recordRecoveryIngressConfirmed(withIngress, 1728280805000);
      const decided = recordPlannerDecision(intervention, 'ass_012', 1728280810000);
      const authorized = authorizeContinuation(decided, 1728280815000);
      const withContinuation = recordContinuationDeliveryCreated(authorized, 'del_continuation_345');
      assert.strictEqual(withContinuation.phase, 'continuation_authorized');
      assert.strictEqual(withContinuation.continuationDeliveryId, 'del_continuation_345');
      assert.strictEqual(withContinuation.continuationDispatchedAt, undefined);
    });

    it('transitions to RESOLVED only after continuation CONFIRMED dispatched', () => {
      const state = createRecoveryState(evidence);
      const withIngress = recordRecoveryIngressDeliveryCreated(state, 'del_ingress_789');
      const intervention = recordRecoveryIngressConfirmed(withIngress, 1728280805000);
      const decided = recordPlannerDecision(intervention, 'ass_012', 1728280810000);
      const authorized = authorizeContinuation(decided, 1728280815000);
      const withContinuation = recordContinuationDeliveryCreated(authorized, 'del_continuation_345');
      const resolved = recordContinuationDispatched(withContinuation, 1728280820000);
      assert.strictEqual(resolved.phase, 'resolved');
      assert.strictEqual(resolved.continuationDispatchedAt, 1728280820000);
    });

    it('cannot confirm continuation without delivery created', () => {
      const state = createRecoveryState(evidence);
      const withIngress = recordRecoveryIngressDeliveryCreated(state, 'del_ingress_789');
      const intervention = recordRecoveryIngressConfirmed(withIngress, 1728280805000);
      const decided = recordPlannerDecision(intervention, 'ass_012', 1728280810000);
      const authorized = authorizeContinuation(decided, 1728280815000);
      assert.throws(
        () => recordContinuationDispatched(authorized, 1728280820000),
        /Cannot confirm continuation/
      );
    });
  });

  describe('Recovery Operation Validation by Phase', () => {
    let required: RecoveryState;
    let intervention: RecoveryState;
    let decided: RecoveryState;
    let authorized: RecoveryState;
    let resolved: RecoveryState;

    const setupStates = () => {
      required = createRecoveryState(evidence);
      const ingress = recordRecoveryIngressDeliveryCreated(required, 'del_ingress_789');
      intervention = recordRecoveryIngressConfirmed(ingress, 1728280805000);
      decided = recordPlannerDecision(intervention, 'ass_012', 1728280810000);
      authorized = authorizeContinuation(decided, 1728280815000);
      const continuation = recordContinuationDeliveryCreated(authorized, 'del_continuation_345');
      resolved = recordContinuationDispatched(continuation, 1728280820000);
    };

    describe('REQUIRED phase (no ingress confirmed yet)', () => {
      it('allows recovery ingress to Planner', () => {
        setupStates();
        const result = validateRecoveryOperation(required, {
          kind: 'recovery_ingress',
          destination: 'planner',
        });
        assert.strictEqual(result.decision, 'allow');
      });

      it('denies recovery ingress to Worker', () => {
        setupStates();
        const result = validateRecoveryOperation(required, {
          kind: 'recovery_ingress',
          destination: 'worker',
        });
        assert.strictEqual(result.decision, 'deny');
        assert.match(result.reason, /destination must be PLANNER/);
      });

      it('denies relay continuation', () => {
        setupStates();
        const result = validateRecoveryOperation(required, {
          kind: 'relay_continuation',
          from: 'planner',
          to: 'worker',
        });
        assert.strictEqual(result.decision, 'deny');
        assert.match(result.reason, /phase='required'/);
        assert.match(result.reason, /required='continuation_authorized'/);
      });
    });

    describe('PLANNER_INTERVENTION phase (ingress confirmed, awaiting planner response)', () => {
      it('allows recovery ingress to Planner', () => {
        setupStates();
        const result = validateRecoveryOperation(intervention, {
          kind: 'recovery_ingress',
          destination: 'planner',
        });
        assert.strictEqual(result.decision, 'allow');
      });

      it('denies relay continuation (no planner decision yet)', () => {
        setupStates();
        const result = validateRecoveryOperation(intervention, {
          kind: 'relay_continuation',
          from: 'planner',
          to: 'worker',
        });
        assert.strictEqual(result.decision, 'deny');
        assert.match(result.reason, /phase='planner_intervention'/);
        assert.match(result.reason, /Planner decision evidence/);
      });
    });

    describe('PLANNER_DECIDED phase (planner response observed, not yet authorized)', () => {
      it('allows recovery ingress to Planner', () => {
        setupStates();
        const result = validateRecoveryOperation(decided, {
          kind: 'recovery_ingress',
          destination: 'planner',
        });
        assert.strictEqual(result.decision, 'allow');
      });

      it('denies relay continuation (not yet authorized by relay engine)', () => {
        setupStates();
        const result = validateRecoveryOperation(decided, {
          kind: 'relay_continuation',
          from: 'planner',
          to: 'worker',
        });
        assert.strictEqual(result.decision, 'deny');
        assert.match(result.reason, /phase='planner_decided'/);
        assert.match(result.reason, /relay authorization required/);
      });
    });

    describe('CONTINUATION_AUTHORIZED phase (relay authorized Planner → Worker)', () => {
      it('allows Planner → Worker continuation', () => {
        setupStates();
        const result = validateRecoveryOperation(authorized, {
          kind: 'relay_continuation',
          from: 'planner',
          to: 'worker',
        });
        assert.strictEqual(result.decision, 'allow');
      });

      it('denies Worker → Planner continuation', () => {
        setupStates();
        const result = validateRecoveryOperation(authorized, {
          kind: 'relay_continuation',
          from: 'worker',
          to: 'planner',
        });
        assert.strictEqual(result.decision, 'deny');
        assert.match(result.reason, /must be Planner → Worker/);
      });

      it('denies Worker → Worker continuation', () => {
        setupStates();
        const result = validateRecoveryOperation(authorized, {
          kind: 'relay_continuation',
          from: 'worker',
          to: 'worker',
        });
        assert.strictEqual(result.decision, 'deny');
        assert.match(result.reason, /must be Planner → Worker/);
      });

      it('denies Planner → Planner continuation', () => {
        setupStates();
        const result = validateRecoveryOperation(authorized, {
          kind: 'relay_continuation',
          from: 'planner',
          to: 'planner',
        });
        assert.strictEqual(result.decision, 'deny');
        assert.match(result.reason, /must be Planner → Worker/);
      });

      it('allows recovery ingress to Planner', () => {
        setupStates();
        const result = validateRecoveryOperation(authorized, {
          kind: 'recovery_ingress',
          destination: 'planner',
        });
        assert.strictEqual(result.decision, 'allow');
      });
    });

    describe('RESOLVED phase (recovery completed)', () => {
      it('defers to normal baton authority', () => {
        setupStates();
        const result = validateRecoveryOperation(resolved, {
          kind: 'relay_continuation',
          from: 'planner',
          to: 'worker',
        });
        assert.strictEqual(result.decision, 'defer_to_normal_authority');
        assert.match(result.reason, /normal baton authority applies/);
      });
    });

    describe('No active recovery', () => {
      it('defers to normal baton authority', () => {
        const result = validateRecoveryOperation(null, {
          kind: 'relay_continuation',
          from: 'worker',
          to: 'planner',
        });
        assert.strictEqual(result.decision, 'defer_to_normal_authority');
        assert.match(result.reason, /No active recovery/);
      });
    });
  });

  describe('Recovery Authority Invariants', () => {
    it('R1: recovery owner is always PLANNER', () => {
      assert.strictEqual(getRecoveryOwner(), 'planner');
      assert.strictEqual(RECOVERY_AUTHORITY, 'planner');
    });

    it('R2: recovery authority is independent of baton ownership', () => {
      assert.strictEqual(assertRecoveryAuthorityIndependentOfBaton('planner'), true);
      assert.strictEqual(assertRecoveryAuthorityIndependentOfBaton('worker'), true);
      assert.strictEqual(assertRecoveryAuthorityIndependentOfBaton(null), true);
    });

    it('R5: recovery destination is NOT selectable — only PLANNER allowed', () => {
      assert.doesNotThrow(() => assertNoSelectableRecoveryDestination('planner'));
      assert.throws(() => assertNoSelectableRecoveryDestination('worker'), /recovery destination/);
      assert.throws(() => assertNoSelectableRecoveryDestination('none'), /recovery destination/);
      assert.throws(() => assertNoSelectableRecoveryDestination(''), /recovery destination/);
    });

    it('R6: Worker is never a recovery ingress target', () => {
      const required = createRecoveryState(evidence);
      const result = validateRecoveryOperation(required, {
        kind: 'recovery_ingress',
        destination: 'worker',
      });
      assert.strictEqual(result.decision, 'deny');
    });

    it('R4/R8: continuation denied until continuation_authorized phase', () => {
      const required = createRecoveryState(evidence);
      const ingress = recordRecoveryIngressDeliveryCreated(required, 'del_ingress');
      const intervention = recordRecoveryIngressConfirmed(ingress, 1728280805000);

      // Even in intervention phase (ingress confirmed), continuation denied
      const result = validateRecoveryOperation(intervention, {
        kind: 'relay_continuation',
        from: 'planner',
        to: 'worker',
      });
      assert.strictEqual(result.decision, 'deny');
    });
  });

  describe('Durable Evidence Requirements', () => {
    it('phase transitions require evidence recording, not arbitrary function calls', () => {
      const state = createRecoveryState(evidence);

      // Cannot jump to continuation_authorized without prior evidence
      assert.throws(() => authorizeContinuation(state, 1728280815000));
    });

    it('cannot bypass planner_intervention by direct decision recording', () => {
      const state = createRecoveryState(evidence);
      const ingress = recordRecoveryIngressDeliveryCreated(state, 'del_ingress');

      // Cannot record planner decision without intervention
      assert.throws(
        () => recordPlannerDecision(ingress, 'ass_012', 1728280810000),
        /Cannot record planner decision/
      );
    });

    it('cannot bypass planner_decided by direct continuation authorization', () => {
      const state = createRecoveryState(evidence);
      const ingress = recordRecoveryIngressDeliveryCreated(state, 'del_ingress');
      const intervention = recordRecoveryIngressConfirmed(ingress, 1728280805000);

      // Cannot authorize continuation without planner decision
      assert.throws(
        () => authorizeContinuation(intervention, 1728280815000),
        /Cannot authorize continuation/
      );
    });
  });
});
