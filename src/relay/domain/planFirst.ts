/**
 * Plan-First execution domain.
 *
 * Canonical contract: PLAN_FIRST_DOMAIN_FREEZE.md. This file implements sections B, C
 * and D of that document and nothing beyond it.
 *
 * Frozen decisions honoured here:
 *  - V1 has NO standalone `Contract` aggregate. A project's contract IS the ordered
 *    lineage of its ContractRevision rows (freeze N1).
 *  - ContractRevision content is immutable FROM CREATION, not merely after approval (N2).
 *  - The current WorkUnit cursor is DERIVED, never persisted (N6). There is therefore no
 *    `currentWorkUnitId` field anywhere in this file, by design.
 *  - WorkUnit order is an explicit immutable `ordinal`; there is no `dependsOn`/DAG (N9).
 *  - At most one WorkUnit executes at a time; no parallel execution.
 *  - No `Strategy`, no retry budget, no planner-assistance architecture.
 */

import { createHash } from 'node:crypto';

import {
  ProjectId,
  PairId,
  AssignmentId,
  ContractRevisionId,
  PlanFirstRunId,
  WorkUnitId,
  ContractRevisionStatus,
  PlanFirstRunStatus,
  WorkUnitStatus,
  createId,
} from './types.ts';
import { InvalidStateTransitionError, RelayDomainError } from './errors.ts';

/* ------------------------------------------------------------------ *
 * Canonicalization + digest
 * ------------------------------------------------------------------ */

/**
 * Frozen canonicalization rule (PLAN_FIRST_DOMAIN_FREEZE.md §B.1, derived from
 * core_slice7 C1-C3):
 *
 *   canonicalDigest = sha256( JSON.stringify(semanticFields, sortedKeyReplacer) )
 *
 * `semanticFields` is the AUTHOR-DECLARED set of semantic keys. This single rule
 * satisfies all three acceptance cases:
 *   C1 key order / whitespace irrelevant  -> sorted-key replacer
 *   C2 semantic change alters the digest  -> a changed value changes the hash
 *   C3 unrelated section does NOT alter it -> unlisted keys are never passed in, so
 *                                            they can never enter the hash
 *
 * The field list itself is deliberately NOT persisted: canonicalization happens once,
 * at creation, and `canonicalText` (already canonical) is stored, so the digest is
 * never recomputed.
 */
export function canonicalizeSemanticFields(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, Object.keys(fields).sort());
}

export function digestCanonicalText(canonicalText: string): string {
  return createHash('sha256').update(canonicalText).digest('hex');
}

/* ------------------------------------------------------------------ *
 * ContractRevision
 * ------------------------------------------------------------------ */

export interface ContractRevisionProps {
  id: ContractRevisionId;
  projectId: ProjectId;
  canonicalText: string;
  canonicalDigest: string;
  status: ContractRevisionStatus;
  sourceRef?: string | null;
  approvedBy?: string | null;
  approvedAt?: number | null;
  createdAt: number;
}

export class ContractRevision {
  public readonly id: ContractRevisionId;
  public readonly projectId: ProjectId;
  /** Immutable from creation. */
  public readonly canonicalText: string;
  /** Immutable from creation. The semantic identity of the intent. */
  public readonly canonicalDigest: string;
  public readonly sourceRef?: string | null;
  public readonly createdAt: number;
  public status: ContractRevisionStatus;
  public approvedBy?: string | null;
  public approvedAt?: number | null;

  constructor(props: ContractRevisionProps) {
    this.id = props.id;
    this.projectId = props.projectId;
    this.canonicalText = props.canonicalText;
    this.canonicalDigest = props.canonicalDigest;
    this.sourceRef = props.sourceRef ?? null;
    this.status = props.status;
    this.approvedBy = props.approvedBy ?? null;
    this.approvedAt = props.approvedAt ?? null;
    this.createdAt = props.createdAt;
    this._assertApprovalInvariant();
  }

  /**
   * Create a revision from the author-declared SEMANTIC fields.
   * `semanticFields` must contain only the keys that carry intent — an unrelated
   * document section must simply not be passed (freeze C3).
   *
   * Idempotency is enforced at the persistence layer via
   * UNIQUE (project_id, canonical_digest) — see IContractRevisionRepository.findByDigest.
   */
  public static create(
    projectId: ProjectId,
    semanticFields: Record<string, unknown>,
    sourceRef?: string | null,
  ): ContractRevision {
    const canonicalText = canonicalizeSemanticFields(semanticFields);
    return new ContractRevision({
      id: createId<ContractRevisionId>('crev'),
      projectId,
      canonicalText,
      canonicalDigest: digestCanonicalText(canonicalText),
      status: 'draft',
      sourceRef: sourceRef ?? null,
      createdAt: Date.now(),
    });
  }

  /**
   * draft -> approved. Terminal.
   * Execution requires approval (P0 Invariant 9). Content is never mutated here:
   * a meaningful intent change means a NEW revision, never an edit.
   */
  public approve(actor: string): void {
    if (this.status !== 'draft') {
      throw new InvalidStateTransitionError(this.status, 'approved', 'ContractRevision');
    }
    this.status = 'approved';
    this.approvedBy = actor;
    this.approvedAt = Date.now();
  }

  public isApproved(): boolean {
    return this.status === 'approved';
  }

  private _assertApprovalInvariant(): void {
    if (this.status === 'approved' && (!this.approvedBy || this.approvedAt == null)) {
      throw new RelayDomainError(
        'Approved ContractRevision requires approvedBy and approvedAt',
        'CONTRACT_APPROVAL_INCOMPLETE',
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * WorkUnit
 * ------------------------------------------------------------------ */

export interface WorkUnitProps {
  id: WorkUnitId;
  contractRevisionId: ContractRevisionId;
  ordinal: number;
  objective: string;
  instruction: string;
  status: WorkUnitStatus;
  assignmentId?: AssignmentId | null;
  createdAt: number;
  updatedAt: number;
}

export class WorkUnit {
  public readonly id: WorkUnitId;
  public readonly contractRevisionId: ContractRevisionId;
  /** Immutable, 1-based execution order. The ONLY ordering primitive in V1. */
  public readonly ordinal: number;
  /** Immutable. */
  public readonly objective: string;
  /** Immutable. The exact text dispatched to the worker; NOT NULL in the schema. */
  public readonly instruction: string;
  public readonly createdAt: number;
  public status: WorkUnitStatus;
  /**
   * The single Assignment that executes this unit. Written ONCE, on first dispatch,
   * and never changed. This is what makes "already dispatched" durably knowable and
   * makes silent re-dispatch impossible (freeze N11, Invariant 1).
   */
  public assignmentId?: AssignmentId | null;
  public updatedAt: number;

  constructor(props: WorkUnitProps) {
    this.id = props.id;
    this.contractRevisionId = props.contractRevisionId;
    this.ordinal = props.ordinal;
    this.objective = props.objective;
    this.instruction = props.instruction;
    this.status = props.status;
    this.assignmentId = props.assignmentId ?? null;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  public static create(
    contractRevisionId: ContractRevisionId,
    ordinal: number,
    objective: string,
    instruction: string,
  ): WorkUnit {
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      throw new RelayDomainError(
        `WorkUnit ordinal must be an integer >= 1, received ${ordinal}`,
        'INVALID_ORDINAL',
      );
    }
    if (!instruction) {
      throw new RelayDomainError('WorkUnit instruction is required', 'INVALID_INSTRUCTION');
    }
    const now = Date.now();
    return new WorkUnit({
      id: createId<WorkUnitId>('wu'),
      contractRevisionId,
      ordinal,
      objective,
      instruction,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * pending -> in_progress. Binds the unit's ONE assignment.
   * Rejects a second bind: one WorkUnit executes under exactly one Assignment.
   */
  public startExecution(assignmentId: AssignmentId): void {
    if (this.status !== 'pending') {
      throw new InvalidStateTransitionError(this.status, 'in_progress', 'WorkUnit');
    }
    if (this.assignmentId && this.assignmentId !== assignmentId) {
      throw new RelayDomainError(
        `WorkUnit ${this.id} is already bound to Assignment ${this.assignmentId}; ` +
          `refusing to rebind to ${assignmentId}`,
        'WORK_UNIT_ALREADY_BOUND',
      );
    }
    this.assignmentId = assignmentId;
    this.status = 'in_progress';
    this.updatedAt = Date.now();
  }

  /**
   * in_progress -> completed. TERMINAL.
   * The ONLY legal path to completion, and it is reachable only from the controller's
   * verification branch — never from dispatch success, worker claim, or provider UI.
   */
  public accept(): void {
    if (this.status !== 'in_progress') {
      throw new InvalidStateTransitionError(this.status, 'completed', 'WorkUnit');
    }
    this.status = 'completed';
    this.updatedAt = Date.now();
  }

  /**
   * in_progress -> blocked. Verification failed / inconclusive, or delivery was ambiguous.
   * The engine never auto-declares terminal failure; a planner/human must resolve.
   */
  public block(): void {
    if (this.status !== 'in_progress') {
      throw new InvalidStateTransitionError(this.status, 'blocked', 'WorkUnit');
    }
    this.status = 'blocked';
    this.updatedAt = Date.now();
  }

  /**
   * in_progress -> pending. Delivery was CONFIRMED not delivered, so no physical
   * execution occurred and re-dispatch is safe. The assignment binding is RETAINED as
   * the historical record of the failed attempt.
   */
  public returnToPending(): void {
    if (this.status !== 'in_progress') {
      throw new InvalidStateTransitionError(this.status, 'pending', 'WorkUnit');
    }
    this.status = 'pending';
    this.updatedAt = Date.now();
  }

  /**
   * blocked -> in_progress. An explicit retry after a planner/human resolution.
   * The unit keeps its original assignment binding; the retry produces a new Attempt
   * (attemptNumber + 1) through the established dispatch path.
   */
  public resumeForRetry(): void {
    if (this.status !== 'blocked') {
      throw new InvalidStateTransitionError(this.status, 'in_progress', 'WorkUnit');
    }
    this.status = 'in_progress';
    this.updatedAt = Date.now();
  }

  public isTerminal(): boolean {
    return this.status === 'completed';
  }
}

/* ------------------------------------------------------------------ *
 * PlanFirstRun
 * ------------------------------------------------------------------ */

export interface PlanFirstRunProps {
  id: PlanFirstRunId;
  projectId: ProjectId;
  contractRevisionId: ContractRevisionId;
  contractDigest: string;
  sessionPairId: PairId;
  status: PlanFirstRunStatus;
  createdAt: number;
  updatedAt: number;
}

export class PlanFirstRun {
  public readonly id: PlanFirstRunId;
  public readonly projectId: ProjectId;
  /** Immutable. A run can never silently switch intent (Invariant 7). */
  public readonly contractRevisionId: ContractRevisionId;
  /**
   * Immutable snapshot of the bound revision's digest at creation. Both sides are
   * immutable, so this cannot drift; it lets recovery verify the binding without a join.
   */
  public readonly contractDigest: string;
  /**
   * Immutable ORIGIN pair. Never changes, including across pair replacement
   * (Invariant 8). Persisted as a soft reference with no FK.
   */
  public readonly sessionPairId: PairId;
  public readonly createdAt: number;
  public status: PlanFirstRunStatus;
  public updatedAt: number;

  constructor(props: PlanFirstRunProps) {
    this.id = props.id;
    this.projectId = props.projectId;
    this.contractRevisionId = props.contractRevisionId;
    this.contractDigest = props.contractDigest;
    this.sessionPairId = props.sessionPairId;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  /**
   * A run may only be created against an APPROVED revision, and it snapshots that
   * revision's digest. The single-non-terminal-run-per-revision rule is enforced at the
   * persistence layer by a partial unique index (freeze §E.2).
   */
  public static create(
    projectId: ProjectId,
    revision: ContractRevision,
    sessionPairId: PairId,
  ): PlanFirstRun {
    if (revision.projectId !== projectId) {
      throw new RelayDomainError(
        `ContractRevision ${revision.id} does not belong to project ${projectId}`,
        'CONTRACT_PROJECT_MISMATCH',
      );
    }
    if (!revision.isApproved()) {
      throw new RelayDomainError(
        `ContractRevision ${revision.id} is not approved; execution requires approved intent`,
        'CONTRACT_NOT_APPROVED',
      );
    }
    const now = Date.now();
    return new PlanFirstRun({
      id: createId<PlanFirstRunId>('pfr'),
      projectId,
      contractRevisionId: revision.id,
      contractDigest: revision.canonicalDigest,
      sessionPairId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Assert the run is still bound to exactly the intent it was created for.
   * Called on every load by the controller; refuses rather than repairs (Invariant 7).
   */
  public assertBindingIntact(revision: ContractRevision): void {
    if (revision.id !== this.contractRevisionId) {
      throw new RelayDomainError(
        `PlanFirstRun ${this.id} is bound to revision ${this.contractRevisionId}, ` +
          `but revision ${revision.id} was supplied`,
        'CONTRACT_BINDING_MISMATCH',
      );
    }
    if (revision.canonicalDigest !== this.contractDigest) {
      throw new RelayDomainError(
        `PlanFirstRun ${this.id} digest ${this.contractDigest} does not match ` +
          `revision ${revision.id} digest ${revision.canonicalDigest}`,
        'CONTRACT_BINDING_MISMATCH',
      );
    }
  }

  /**
   * ready -> running, and blocked -> running.
   * Selecting a unit puts the run in `running` from EITHER state, so a run can never be
   * left `blocked` while one of its units is executing.
   */
  public start(): void {
    if (this.status !== 'ready' && this.status !== 'blocked') {
      throw new InvalidStateTransitionError(this.status, 'running', 'PlanFirstRun');
    }
    this.status = 'running';
    this.updatedAt = Date.now();
  }

  /** running -> blocked. Verification failed/inconclusive, or ambiguous delivery. */
  public block(): void {
    if (this.status !== 'running') {
      throw new InvalidStateTransitionError(this.status, 'blocked', 'PlanFirstRun');
    }
    this.status = 'blocked';
    this.updatedAt = Date.now();
  }

  /** running -> completed. TERMINAL. A completed run never executes again. */
  public complete(): void {
    if (this.status !== 'running') {
      throw new InvalidStateTransitionError(this.status, 'completed', 'PlanFirstRun');
    }
    this.status = 'completed';
    this.updatedAt = Date.now();
  }

  /** ready|running|blocked -> cancelled. TERMINAL. */
  public cancel(): void {
    if (this.status === 'completed' || this.status === 'cancelled') {
      throw new InvalidStateTransitionError(this.status, 'cancelled', 'PlanFirstRun');
    }
    this.status = 'cancelled';
    this.updatedAt = Date.now();
  }

  public isTerminal(): boolean {
    return this.status === 'completed' || this.status === 'cancelled';
  }
}

/* ------------------------------------------------------------------ *
 * Derived cursor
 * ------------------------------------------------------------------ */

/**
 * The frozen replacement for the rejected persisted `currentWorkUnitId`
 * (freeze §D.2). A PURE FUNCTION of persisted (ordinal, status) state — it cannot drift
 * and needs no repair on recovery.
 *
 * Invariant 1 is enforced here: only a `pending` unit can ever be selected, and
 * `completed` is terminal, so an accepted WorkUnit is never dispatched again.
 */
export type DerivedCursor =
  | { kind: 'in_flight'; unit: WorkUnit }
  | { kind: 'blocked'; unit: WorkUnit }
  | { kind: 'next'; unit: WorkUnit }
  | { kind: 'none' };

export function deriveCurrentWorkUnit(units: readonly WorkUnit[]): DerivedCursor {
  const ordered = [...units].sort((a, b) => a.ordinal - b.ordinal);

  // At most one in_progress unit per revision is guaranteed by the partial unique index.
  const inFlight = ordered.find((u) => u.status === 'in_progress');
  if (inFlight) return { kind: 'in_flight', unit: inFlight };

  const blocked = ordered.find((u) => u.status === 'blocked');
  if (blocked) return { kind: 'blocked', unit: blocked };

  const next = ordered.find((u) => u.status === 'pending');
  if (next) return { kind: 'next', unit: next };

  return { kind: 'none' };
}

/** True when every unit of the revision is accepted. Drives the run's terminal state. */
export function allWorkUnitsCompleted(units: readonly WorkUnit[]): boolean {
  return units.length > 0 && units.every((u) => u.status === 'completed');
}
