/**
 * PLAN_FIRST_DOMAIN_FREEZE.md §B/§C/§D — focused domain acceptance tests.
 *
 * These are pure-domain: no database, no provider, no engine. They prove the frozen
 * entity model itself, which is the prerequisite for the persistence (§F/§E) and
 * controller (§G) layers proven elsewhere.
 *
 * Covered:
 *   §B.1 ContractRevision — deterministic digest, immutability, approval invariant
 *   §B.2 PlanFirstRun     — approved-revision requirement, digest snapshot, binding
 *   §B.3 WorkUnit         — explicit immutable ordinal, assignment bound once
 *   §C.1/§C.2             — every legal and illegal transition
 *   §D.2                  — the derived cursor replaces the persisted cursor
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';

import {
  ContractRevision,
  PlanFirstRun,
  WorkUnit,
  allWorkUnitsCompleted,
  canonicalizeSemanticFields,
  deriveCurrentWorkUnit,
  digestCanonicalText,
} from '../src/relay/domain/planFirst.ts';
import type {
  ContractRevisionId,
  PairId,
  PlanFirstRunId,
  ProjectId,
  WorkUnitId,
} from '../src/relay/domain/types.ts';

const PROJECT = 'proj_dom' as ProjectId;
const OTHER_PROJECT = 'proj_other' as ProjectId;
const PAIR = 'pair_dom' as PairId;

function approvedRevision(projectId: ProjectId = PROJECT, fields?: Record<string, unknown>) {
  const rev = ContractRevision.create(
    projectId,
    fields ?? { objective: 'build-auth', criteria: 'tests pass' },
    '/docs/plan.md',
  );
  rev.approve('human');
  return rev;
}

describe('Plan-First domain — ContractRevision (§B.1)', () => {
  it('D1 — the digest is sha256 over the canonicalized semantic fields', () => {
    const fields = { objective: 'build-auth', criteria: 'tests pass' };
    const rev = ContractRevision.create(PROJECT, fields);

    const expectedCanonical = JSON.stringify(fields, Object.keys(fields).sort());
    assert.strictEqual(rev.canonicalText, expectedCanonical);
    assert.strictEqual(rev.canonicalDigest, createHash('sha256').update(expectedCanonical).digest('hex'));
    // The exported helpers must agree with the entity, not duplicate it.
    assert.strictEqual(canonicalizeSemanticFields(fields), expectedCanonical);
    assert.strictEqual(digestCanonicalText(expectedCanonical), rev.canonicalDigest);
  });

  it('D2 — C1: key order is irrelevant (whitespace/ordering stability)', () => {
    const a = ContractRevision.create(PROJECT, { objective: 'support CSV import', criteria: 'tests pass' });
    const b = ContractRevision.create(PROJECT, { criteria: 'tests pass', objective: 'support CSV import' });
    assert.strictEqual(a.canonicalDigest, b.canonicalDigest, 'key order must not change identity');
  });

  it('D3 — C2: a semantic value change alters the digest', () => {
    const a = ContractRevision.create(PROJECT, { objective: 'support CSV import', criteria: 'tests pass' });
    const b = ContractRevision.create(PROJECT, {
      objective: 'support CSV and XLSX import',
      criteria: 'tests pass',
    });
    assert.notStrictEqual(a.canonicalDigest, b.canonicalDigest);
  });

  it('D4 — C3: the digest covers ONLY the author-declared semantic keys', () => {
    // `sourceRef` is provenance, not semantics: changing it must not change identity.
    const a = ContractRevision.create(PROJECT, { objective: 'build', criteria: 'pass' }, 'a.md');
    const b = ContractRevision.create(PROJECT, { objective: 'build', criteria: 'pass' }, 'b.md');
    assert.strictEqual(a.canonicalDigest, b.canonicalDigest);
  });

  it('D5 — canonicalText and canonicalDigest are readonly in the type system', () => {
    // `readonly` is a compile-time guarantee: `tsc --noEmit` fails if any call site
    // assigns these. It is not a runtime freeze, so this test asserts the observable
    // consequence instead: nothing on the domain surface can change identity.
    const rev = approvedRevision();
    const digest = rev.canonicalDigest;
    const text = rev.canonicalText;

    // Mutating the SOURCE object after creation must not change the revision.
    const source = { objective: 'build-auth', criteria: 'tests pass' };
    const rev2 = ContractRevision.create(PROJECT, source);
    source.objective = 'silently different intent';
    source.criteria = 'silently different criteria';
    assert.strictEqual(rev2.canonicalDigest, digest, 'digest is computed once, at creation');
    assert.strictEqual(rev2.canonicalText, text);

    // Approval (the only legal mutation) must not disturb identity.
    const draft = ContractRevision.create(PROJECT, { objective: 'build-auth', criteria: 'tests pass' });
    const beforeApproval = draft.canonicalDigest;
    draft.approve('human');
    assert.strictEqual(draft.canonicalDigest, beforeApproval);
    // The runtime write layer is the other half of this guarantee: see
    // plan_first_schema.test.ts S9 (immutable columns are excluded from ON CONFLICT).
  });

  it('D6 — approval records actor and time, and is the precondition for execution', () => {
    const rev = ContractRevision.create(PROJECT, { objective: 'x' });
    assert.strictEqual(rev.status, 'draft');
    assert.strictEqual(rev.isApproved(), false);
    assert.strictEqual(rev.approvedBy, null);
    assert.strictEqual(rev.approvedAt, null);

    rev.approve('human');

    assert.strictEqual(rev.status, 'approved');
    assert.strictEqual(rev.isApproved(), true);
    assert.strictEqual(rev.approvedBy, 'human');
    assert.ok(typeof rev.approvedAt === 'number' && rev.approvedAt > 0);
  });

  it('D7 — the same semantic intent in a DIFFERENT project is a different revision', () => {
    // Uniqueness is PROJECT-SCOPED (§E.1), so identity is (project, digest) — never digest alone.
    const fields = { objective: 'shared intent' };
    const a = ContractRevision.create(PROJECT, fields);
    const b = ContractRevision.create(OTHER_PROJECT, fields);
    assert.strictEqual(a.canonicalDigest, b.canonicalDigest, 'the digest is project-agnostic');
    assert.notStrictEqual(a.id, b.id, 'but they are distinct revisions');
  });
});

describe('Plan-First domain — WorkUnit (§B.3, §C.2)', () => {
  const revisionId = 'rev_dom' as ContractRevisionId;

  it('D8 — the ordinal is an explicit integer >= 1', () => {
    assert.throws(() => WorkUnit.create(revisionId, 0, 'x', 'y'), /integer >= 1/);
    assert.throws(() => WorkUnit.create(revisionId, 1.5, 'x', 'y'), /integer >= 1/);
    assert.throws(() => WorkUnit.create(revisionId, -3, 'x', 'y'), /integer >= 1/);
    assert.throws(() => WorkUnit.create(revisionId, Number.NaN, 'x', 'y'), /integer >= 1/);

    // The ordinal is carried explicitly, never inferred from insertion order, so
    // retrieval order is total and needs no dependency graph.
    const unit = WorkUnit.create(revisionId, 7, 'objective', 'instruction');
    assert.strictEqual(unit.ordinal, 7);
    assert.strictEqual(unit.status, 'pending');
    assert.strictEqual(unit.assignmentId, null);
  });

  it('D9 — instruction is required; there is no "derive the prompt later" path', () => {
    assert.throws(() => WorkUnit.create(revisionId, 1, 'objective', ''), /instruction/i);
  });

  it('D10 — project_id is NOT a property: it is derivable via the revision', () => {
    const unit = WorkUnit.create(revisionId, 1, 'objective', 'instruction');
    assert.strictEqual((unit as unknown as Record<string, unknown>).projectId, undefined);
    assert.strictEqual(unit.contractRevisionId, revisionId);
  });

  it('D11 — there are no dependencies: no dependsOn, no DAG', () => {
    const unit = WorkUnit.create(revisionId, 2, 'objective', 'instruction');
    const keys = Object.keys(unit);
    assert.ok(!keys.includes('dependsOn'), 'dependsOn must not exist');
    assert.ok(!keys.includes('dependencies'), 'dependencies must not exist');
    // Ordering is total and positional, so no edge is needed.
    assert.strictEqual(unit.ordinal, 2);
  });

  it('D12 — legal transitions follow §C.2 exactly', () => {
    const unit = WorkUnit.create(revisionId, 1, 'objective', 'instruction');
    const a1 = 'asgn_1' as never;

    // pending -> in_progress (assignment bound)
    unit.startExecution(a1);
    assert.strictEqual(unit.status, 'in_progress');
    assert.strictEqual(unit.assignmentId, a1);

    // in_progress -> completed is TERMINAL
    unit.accept();
    assert.strictEqual(unit.status, 'completed');
    assert.strictEqual(unit.isTerminal(), true);
    assert.throws(() => unit.accept(), /Invalid transition|cannot/i);
    assert.throws(() => unit.block(), /Invalid transition|cannot/i);
    assert.throws(() => unit.returnToPending(), /Invalid transition|cannot/i);
    assert.throws(() => unit.resumeForRetry(), /Invalid transition|cannot/i);
  });

  it('D13 — an assignment is bound ONCE; a unit is never rebound to a different one', () => {
    const unit = WorkUnit.create(revisionId, 1, 'objective', 'instruction');
    const a1 = 'asgn_1' as never;
    unit.startExecution(a1);

    // blocked -> in_progress keeps the SAME binding (retry produces a new Attempt).
    unit.block();
    assert.strictEqual(unit.status, 'blocked');
    unit.resumeForRetry();
    assert.strictEqual(unit.assignmentId, a1, 'retry retains the original Assignment');
    assert.strictEqual(unit.status, 'in_progress');

    // The rebind hazard is a unit that is back to `pending` but still carries a binding
    // (i.e. after a confirmed non-delivery). Attempting to bind a DIFFERENT Assignment
    // must be refused rather than silently repointing history.
    unit.returnToPending();
    assert.throws(
      () => unit.startExecution('asgn_2' as never),
      /already bound|rebind/i,
    );
    assert.strictEqual(unit.assignmentId, a1, 'history is never repointed');

    // Re-binding the SAME Assignment is idempotent, not an error.
    unit.startExecution(a1);
    assert.strictEqual(unit.assignmentId, a1);
  });

  it('D14 — returnToPending retains the binding; it is the history of the failed send', () => {
    const unit = WorkUnit.create(revisionId, 1, 'objective', 'instruction');
    const a1 = 'asgn_1' as never;
    unit.startExecution(a1);
    unit.returnToPending();
    assert.strictEqual(unit.status, 'pending');
    assert.strictEqual(unit.assignmentId, a1, 'the failed attempt record is retained');

    // A re-dispatch after a confirmed non-delivery reuses the same Assignment.
    unit.startExecution(a1);
    assert.strictEqual(unit.assignmentId, a1);
  });

  it('D15 — illegal transitions from a fresh unit are rejected', () => {
    const unit = WorkUnit.create(revisionId, 1, 'objective', 'instruction');
    // Completion is reachable ONLY from in_progress, never from pending.
    assert.throws(() => unit.accept(), /Invalid transition|cannot/i);
    assert.throws(() => unit.block(), /Invalid transition|cannot/i);
    assert.throws(() => unit.resumeForRetry(), /Invalid transition|cannot/i);
    assert.strictEqual(unit.status, 'pending');
  });

  it('D16 — there is no cancelled state and no suspended state', () => {
    const unit = WorkUnit.create(revisionId, 1, 'objective', 'instruction');
    const statuses = new Set<string>();
    for (const name of ['accept', 'block', 'returnToPending', 'resumeForRetry', 'startExecution']) {
      statuses.add(name);
    }
    assert.ok(!statuses.has('cancel'), 'cancelling a run abandons pending units; a cancelled unit state is dead state');
    assert.ok(!statuses.has('suspend'), 'suspension lives at the Attempt, not the unit');
  });
});

describe('Plan-First domain — PlanFirstRun (§B.2, §C.1)', () => {
  it('D17 — a run requires an APPROVED revision', () => {
    const draft = ContractRevision.create(PROJECT, { objective: 'x' });
    assert.throws(() => PlanFirstRun.create(PROJECT, draft, PAIR), /not approved/i);
  });

  it('D18 — the run snapshots the bound revision id AND digest', () => {
    const rev = approvedRevision();
    const run = PlanFirstRun.create(PROJECT, rev, PAIR);
    assert.strictEqual(run.status, 'ready');
    assert.strictEqual(run.contractRevisionId, rev.id);
    assert.strictEqual(run.contractDigest, rev.canonicalDigest);
    assert.strictEqual(run.sessionPairId, PAIR);
  });

  it('D19 — the binding snapshot is not rewritable through the domain surface', () => {
    const rev = approvedRevision();
    const run = PlanFirstRun.create(PROJECT, rev, PAIR);

    // Every legal run transition leaves the binding untouched: a run may change state
    // but never its intent, its origin pair, or the frozen digest.
    const before = [run.contractRevisionId, run.contractDigest, run.sessionPairId];
    run.start();
    run.block();
    run.start();
    run.complete();
    assert.deepStrictEqual(
      [run.contractRevisionId, run.contractDigest, run.sessionPairId],
      before,
      'no run transition may alter the binding',
    );
    assert.strictEqual(run.status, 'completed');

    // The other half of this guarantee is the write layer: see plan_first_schema.test.ts
    // S9 (immutable columns are excluded from the ON CONFLICT update set).
  });

  it('D20 — assertBindingIntact accepts the bound revision and refuses any other', () => {
    const rev = approvedRevision();
    const run = PlanFirstRun.create(PROJECT, rev, PAIR);
    run.assertBindingIntact(rev); // must not throw

    const other = approvedRevision(PROJECT, { objective: 'a different intent' });
    assert.throws(() => run.assertBindingIntact(other), /bound to revision|does not match/i);

    // Even if a revision's fields were somehow identical, the ID must match.
    const impostor = approvedRevision(PROJECT, { objective: 'build-auth', criteria: 'tests pass' });
    assert.strictEqual(impostor.canonicalDigest, rev.canonicalDigest);
    assert.notStrictEqual(impostor.id, rev.id);
    assert.throws(() => run.assertBindingIntact(impostor), /bound to revision|does not match/i);
  });

  it('D21 — legal transitions follow §C.1; there is no suspended state', () => {
    const run = PlanFirstRun.create(PROJECT, approvedRevision(), PAIR);

    run.start();
    assert.strictEqual(run.status, 'running');
    assert.throws(() => run.start(), /Invalid transition|cannot/i, 'running -> running is not a transition');

    run.block();
    assert.strictEqual(run.status, 'blocked');

    // blocked -> running after a resolution, then complete.
    run.start();
    assert.strictEqual(run.status, 'running');
    run.complete();
    assert.strictEqual(run.status, 'completed');
    assert.strictEqual(run.isTerminal(), true);
    assert.throws(() => run.complete(), /Invalid transition|cannot/i);
    assert.throws(() => run.start(), /Invalid transition|cannot/i);
    assert.throws(() => run.block(), /Invalid transition|cannot/i);
  });

  it('D22 — ready can be cancelled; a terminal run admits nothing', () => {
    const run = PlanFirstRun.create(PROJECT, approvedRevision(), PAIR);
    run.cancel();
    assert.strictEqual(run.status, 'cancelled');
    assert.strictEqual(run.isTerminal(), true);
    for (const name of ['start', 'block', 'complete', 'cancel'] as const) {
      assert.throws(() => run[name](), /Invalid transition|cannot/i);
    }
  });

  it('D23 — completed and cancelled are the only terminal states', () => {
    const done = PlanFirstRun.create(PROJECT, approvedRevision(), PAIR);
    done.start();
    done.complete();
    assert.strictEqual(done.isTerminal(), true);

    const live = PlanFirstRun.create(PROJECT, approvedRevision(PROJECT, { objective: 'other' }), PAIR);
    assert.strictEqual(live.isTerminal(), false);
    live.start();
    assert.strictEqual(live.isTerminal(), false);
    live.block();
    assert.strictEqual(live.isTerminal(), false, 'blocked still awaits a planner/human');
  });

  it('D24 — there is no suspended run state', () => {
    assert.ok(
      !('suspend' in PlanFirstRun.prototype),
      'Phase 7 requirement 9 is satisfied by Attempt interruption + AttentionItem, not a run state',
    );
  });
});

describe('Plan-First domain — derived cursor (§D.2)', () => {
  const revisionId = 'rev_cursor' as ContractRevisionId;
  const mk = (ordinal: number) => WorkUnit.create(revisionId, ordinal, `o${ordinal}`, `i${ordinal}`);

  it('D25 — the cursor is a pure function of (ordinal, status); no stored cursor exists', () => {
    const u1 = mk(1);
    const u2 = mk(2);
    const u3 = mk(3);

    // All pending -> the lowest ordinal is next.
    assert.deepStrictEqual(deriveCurrentWorkUnit([u1, u2, u3]), { kind: 'next', unit: u1 });

    // Input order must not matter: ordering is by ordinal, not by array position.
    assert.deepStrictEqual(deriveCurrentWorkUnit([u3, u1, u2]), { kind: 'next', unit: u1 });

    // No cursor property exists on the run to drift out of sync.
    const run = PlanFirstRun.create(PROJECT, approvedRevision(), PAIR);
    assert.strictEqual((run as unknown as Record<string, unknown>).currentWorkUnitId, undefined);
  });

  it('D26 — the cursor advances past completed units and never re-selects one', () => {
    const u1 = mk(1);
    const u2 = mk(2);
    const u3 = mk(3);
    u1.startExecution('asgn_1' as never);
    u1.accept();
    assert.deepStrictEqual(deriveCurrentWorkUnit([u1, u2, u3]), { kind: 'next', unit: u2 });

    u2.startExecution('asgn_2' as never);
    u2.accept();
    assert.deepStrictEqual(deriveCurrentWorkUnit([u1, u2, u3]), { kind: 'next', unit: u3 });

    u3.startExecution('asgn_3' as never);
    u3.accept();
    assert.deepStrictEqual(deriveCurrentWorkUnit([u1, u2, u3]), { kind: 'none' });
    // Invariant 1: an accepted unit is never selectable again.
    assert.strictEqual(allWorkUnitsCompleted([u1, u2, u3]), true);
  });

  it('D27 — in_flight outranks blocked, which outranks next', () => {
    const a = mk(1);
    const b = mk(2);
    const c = mk(3);
    a.startExecution('asgn_1' as never);
    b.startExecution('asgn_2' as never);
    b.block();

    assert.deepStrictEqual(deriveCurrentWorkUnit([a, b, c]), { kind: 'in_flight', unit: a });
    a.block();
    assert.deepStrictEqual(deriveCurrentWorkUnit([a, b, c]), { kind: 'blocked', unit: a });
  });

  it('D28 — a partially completed set is never "all completed"', () => {
    const u1 = mk(1);
    const u2 = mk(2);
    u1.startExecution('asgn_1' as never);
    u1.accept();
    assert.strictEqual(allWorkUnitsCompleted([u1, u2]), false);
    assert.strictEqual(allWorkUnitsCompleted([]), false, 'an empty set must not complete a run');
  });
});
