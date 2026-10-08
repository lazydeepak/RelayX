/**
 * THE RELAY BATON — pure derivation rules.
 *
 * `deriveRelayBaton` is the only place that answers "who owes the next completed turn", so it
 * is tested here directly rather than only through the engine. These are the rules that would
 * be hardest to diagnose from an integration failure: which Delivery counts, which side is the
 * recipient, and which links are dropped as belonging to a superseded chain.
 *
 * No repository, no provider, no clock — the function is pure, so every case here is exact.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveRelayBaton,
  batonSessionIdentity,
  oppositeSide,
  relayDirectionBetween,
} from '../src/relay/domain/baton.ts';
import { Assignment, Attempt, Delivery } from '../src/relay/domain/entities.ts';
import type { AssignmentId, AttemptId, DeliveryId, PairSideRole, RuntimeSessionId } from '../src/relay/domain/types.ts';

const PLANNER_RUNTIME = 'rt_planner' as RuntimeSessionId;
const WORKER_RUNTIME = 'rt_worker' as RuntimeSessionId;

let seq = 0;

function makeAssignment(target: PairSideRole, chainIndex: number): Assignment {
  seq += 1;
  const assignment = Assignment.create(
    'pair_1' as any,
    'proj_1' as any,
    `Assignment ${seq}`,
    `instruction ${seq}`,
    'normal',
    target,
  );
  // `create` mints its own id; the chain index is supplied by the caller because it is a
  // SEQUENCING fact about the Pair, not something a single record knows.
  (assignment as unknown as { __chainIndex: number }).__chainIndex = chainIndex;
  return assignment;
}

function makeAttempt(assignment: Assignment, attemptNumber: number, externalSessionId: string | null): Attempt {
  return Attempt.create(assignment.id, attemptNumber, {
    sessionPairId: 'pair_1' as any,
    workerSessionId: WORKER_RUNTIME,
    externalSessionId,
  });
}

interface LinkSpec {
  target: PairSideRole;
  chainIndex: number;
  attemptNumber?: number;
  status?: Delivery['status'];
  runtimeId?: RuntimeSessionId;
  externalSessionId?: string | null;
  messageIds?: string[];
}

function makeLinks(specs: LinkSpec[]) {
  return specs.map((spec) => {
    const assignment = makeAssignment(spec.target, spec.chainIndex);
    const attempt = makeAttempt(
      assignment,
      spec.attemptNumber ?? 1,
      spec.externalSessionId === undefined ? `ses_${spec.target}_${spec.chainIndex}` : spec.externalSessionId,
    );
    const delivery = Delivery.create(
      assignment.id,
      attempt.id,
      spec.runtimeId ?? (spec.target === 'planner' ? PLANNER_RUNTIME : WORKER_RUNTIME),
      `instruction ${spec.chainIndex}`,
      `idem_${seq}`,
    );
    delivery.status = spec.status ?? 'delivered';
    return {
      delivery,
      assignment,
      attempt,
      chainIndex: spec.chainIndex,
      boundary: spec.messageIds
        ? {
            sessionId: `ses_${spec.target}_${spec.chainIndex}`,
            messageIds: spec.messageIds,
            messageCount: spec.messageIds.length,
            capturedAt: 1_000,
            provenance: 'captured_pre_dispatch' as const,
          }
        : null,
    };
  });
}

describe('relay baton derivation', () => {
  it('reports no baton when nothing is confirmed', () => {
    const baton = deriveRelayBaton({
      links: makeLinks([
        { target: 'worker', chainIndex: 0, status: 'pending' },
        { target: 'worker', chainIndex: 1, status: 'delivering' },
        { target: 'worker', chainIndex: 2, status: 'ambiguous' },
        { target: 'worker', chainIndex: 3, status: 'failed' },
      ]),
    });

    assert.equal(baton.basis, 'no_confirmed_delivery');
    assert.equal(baton.owner, null);
    assert.equal(baton.direction, null);
  });

  it('gives the baton to the RECIPIENT of the last confirmed Delivery', () => {
    const baton = deriveRelayBaton({
      links: makeLinks([{ target: 'worker', chainIndex: 0 }]),
    });
    assert.equal(baton.basis, 'confirmed_delivery');
    assert.equal(baton.owner, 'worker', 'the recipient owes the next turn, not the sender');
    assert.equal(baton.sender, 'planner');
    assert.equal(baton.direction, 'planner_to_worker');

    const reverse = deriveRelayBaton({
      links: makeLinks([{ target: 'planner', chainIndex: 0 }]),
    });
    assert.equal(reverse.owner, 'planner');
    assert.equal(reverse.direction, 'worker_to_planner');
  });

  it('takes the LAST confirmed Delivery in chain order, not the newest by timestamp', () => {
    const links = makeLinks([
      { target: 'worker', chainIndex: 0, attemptNumber: 1 },
      { target: 'planner', chainIndex: 1, attemptNumber: 1 },
      { target: 'worker', chainIndex: 2, attemptNumber: 1 },
    ]);
    // Scramble the `updatedAt` clocks so a timestamp-based reader would pick the wrong link.
    links[0]!.delivery.updatedAt = 9_000;
    links[1]!.delivery.updatedAt = 1;
    links[2]!.delivery.updatedAt = 5_000;

    const baton = deriveRelayBaton({ links });
    assert.equal(baton.owner, 'worker');
    assert.equal(baton.direction, 'planner_to_worker');
    assert.equal(baton.assignment?.id, links[2]!.assignment.id);
  });

  it('uses the Attempt number to order repeated attempts on one Assignment', () => {
    const links = makeLinks([{ target: 'worker', chainIndex: 0, attemptNumber: 1 }]);
    const first = links[0]!;

    const second = makeLinks([{ target: 'worker', chainIndex: 0, attemptNumber: 2 }])[0]!;
    // Same Assignment, later attempt.
    (second.assignment as any).id = first.assignment.id;

    const baton = deriveRelayBaton({ links: [first, second] });
    assert.equal(baton.attempt?.attemptNumber, 2, 'a later attempt on the same Assignment is later');
  });

  it('ignores a Delivery whose session this Pair is no longer bound to', () => {
    const links = makeLinks([
      { target: 'worker', chainIndex: 0, runtimeId: 'rt_superseded_worker' as RuntimeSessionId },
      { target: 'planner', chainIndex: 1, runtimeId: PLANNER_RUNTIME },
    ]);

    const baton = deriveRelayBaton({
      links,
      boundRuntimeIds: { planner: PLANNER_RUNTIME, worker: WORKER_RUNTIME },
    });

    assert.equal(baton.owner, 'planner');
    assert.equal(baton.supersededCount, 1, 'the dropped link is reported, not silently absorbed');
    assert.equal(baton.confirmedDeliveryCount, 2, 'both were confirmed; one is not current');
  });

  it('carries the persisted boundary of the establishing Delivery', () => {
    const baton = deriveRelayBaton({
      links: makeLinks([{ target: 'worker', chainIndex: 0, messageIds: ['m1', 'm2', 'm3'] }]),
    });
    assert.deepEqual([...baton.boundary!.messageIds], ['m1', 'm2', 'm3']);
    assert.equal(baton.boundary!.messageCount, 3);
    assert.equal(baton.boundary!.provenance, 'captured_pre_dispatch');
  });

  it('records every current-chain link so a decision is auditable', () => {
    const baton = deriveRelayBaton({
      links: makeLinks([
        { target: 'worker', chainIndex: 0 },
        { target: 'planner', chainIndex: 1 },
      ]),
    });
    assert.equal(baton.chain.length, 2);
    assert.equal(baton.owner, 'planner');
  });
});

describe('baton session identity', () => {
  it('matches only when both sides carry the same provider-owned id', () => {
    const link = makeLinks([{ target: 'worker', chainIndex: 0, externalSessionId: 'ses_a' }])[0]!;
    assert.equal(batonSessionIdentity(link, 'ses_a').matches, true);
    assert.equal(batonSessionIdentity(link, 'ses_b').matches, false);
  });

  it('fails closed when either side is unknown', () => {
    const withId = makeLinks([{ target: 'worker', chainIndex: 0, externalSessionId: 'ses_a' }])[0]!;
    assert.equal(batonSessionIdentity(withId, null).matches, false, 'an unbound side is not "the same"');

    const withoutId = makeLinks([{ target: 'worker', chainIndex: 0, externalSessionId: null }])[0]!;
    assert.equal(batonSessionIdentity(withoutId, 'ses_a').matches, false);
  });
});

describe('baton helpers', () => {
  it('oppositeSide and relayDirectionBetween are total and consistent', () => {
    assert.equal(oppositeSide('worker'), 'planner');
    assert.equal(oppositeSide('planner'), 'worker');
    assert.equal(relayDirectionBetween('planner', 'worker'), 'planner_to_worker');
    assert.equal(relayDirectionBetween('worker', 'planner'), 'worker_to_planner');
  });
});
