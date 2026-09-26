/**
 * Plan-First deterministic verification seam.
 *
 * Canonical contract: PLAN_FIRST_DOMAIN_FREEZE.md §G step 10 and §B.5.
 *
 * ## What is frozen here, and what is not
 *
 * FROZEN:
 *  - Verification is a separate linked record. It never mutates Attempt physical state
 *    (ATTEMPT_LIFECYCLE.md §1 Dimension B).
 *  - A WorkUnit becomes `completed` ONLY when `VerificationResult.result === 'passed'`
 *    (§C.2). Never from dispatch success, worker claim, handoff, or provider UI (§D.3).
 *  - Verification must be DETERMINISTIC and must NOT read provider UI to decide
 *    correctness (§G step 10).
 *
 * EXPLICITLY DEFERRED (PLAN_FIRST_DOMAIN_FREEZE.md §15 step 11):
 *  "Only then consider `mechanicalVerification.evaluate` as a real deterministic check."
 *  Building the real check (file fingerprints and similar) is sequenced AFTER the §H
 *  operational proof. This tranche therefore delivers the seam plus a fail-closed default,
 *  and the §H proof injects a deterministic evaluator.
 *
 * ## Why the default refuses to pass
 *
 * `MilestoneVerification` is the production default and it CANNOT return `passed`.
 * Asserting success with no deterministic evidence would create a second, weaker path to
 * `WorkUnit.completed` and silently violate §C.2. Fail-closed is the only honest option
 * while the check is unimplemented, and it degrades safely: the unit goes `blocked`, the
 * run goes `blocked`, an AttentionItem is raised, and a planner/human resolves.
 */

import type { Attempt } from './entities.ts';
import type { ContractRevision, WorkUnit } from './planFirst.ts';
import type { VerificationStatus } from './types.ts';

export interface PlanFirstVerificationInput {
  attempt: Attempt;
  revision: ContractRevision;
  unit: WorkUnit;
}

export interface PlanFirstVerificationOutcome {
  outcome: VerificationStatus;
  checkId?: string;
  evidence?: Record<string, unknown>;
}

/**
 * The only seam the Plan-First controller knows about. Implementations MUST be
 * deterministic functions of durable RelayX state: same persisted state in, same
 * outcome out. They MUST NOT inspect provider UI, window titles, or recency.
 */
export interface PlanFirstVerificationEvaluator {
  evaluate(
    input: PlanFirstVerificationInput,
  ): Promise<PlanFirstVerificationOutcome> | PlanFirstVerificationOutcome;
}

/**
 * Milestone-1 default: structural, deterministic, and fail-closed.
 *
 * It reports exactly what is durably true about the attempt and refuses to conclude
 * anything about work correctness, because no correctness check exists yet.
 */
export class MilestoneVerification implements PlanFirstVerificationEvaluator {
  public evaluate(input: PlanFirstVerificationInput): PlanFirstVerificationOutcome {
    const { attempt } = input;

    // Physical execution must have actually finished. Reaching here with anything else
    // means the caller routed a non-terminal attempt into verification.
    if (attempt.status !== 'completed_physical') {
      return {
        outcome: 'not_run',
        checkId: 'attempt_physically_complete',
        evidence: { attemptStatus: attempt.status, reason: 'physical execution has not completed' },
      };
    }

    // Execution authority must be frozen. Evidence from an unbound attempt is not
    // admissible (ATTEMPT_LIFECYCLE.md §6).
    if (!attempt.hasFrozenAuthority()) {
      return {
        outcome: 'blocked',
        checkId: 'attempt_authority_frozen',
        evidence: {
          reason: 'attempt carries no frozen dispatch authority',
          attemptId: attempt.id,
        },
      };
    }

    return {
      outcome: 'blocked',
      checkId: 'no_deterministic_check_configured',
      evidence: {
        reason:
          'Milestone 1 ships no deterministic correctness check; refusing to assert a ' +
          'passed verification without one (PLAN_FIRST_DOMAIN_FREEZE.md §15 step 11).',
        attemptId: attempt.id,
        workUnitId: input.unit.id,
        contractRevisionId: input.revision.id,
        attemptStatus: attempt.status,
        physicalEvidencePresent: attempt.evidence !== undefined,
      },
    };
  }
}
