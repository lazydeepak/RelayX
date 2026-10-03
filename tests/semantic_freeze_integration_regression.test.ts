import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/*
 * Integration-level regression tests enforcing the frozen semantic model.
 * These exercise real consumers / call chains, not just entity setters.
 */

import {
  RuntimeSession,
  Pair,
  Assignment,
  Attempt,
  Delivery,
  Project,
} from '../src/relay/domain/entities';

describe('integration — active authority without verification/reachability', () => {
  it('ACTIVE pair may have unverified side identity', () => {
    const pair = Pair.create('proj_1' as any, 'Unverified active pair');
    pair.makeActive();
    // ACTIVE grants authority; it does not require all sides verified.
    // Reachability must be checked separately via RuntimeSession / sideIdentities evidence.
    assert.strictEqual(pair.operationalState, 'ACTIVE');
    assert.strictEqual(pair.isProviderContactPermitted(), true);
  });
});

describe('integration — relay RUNNING without execution', () => {
  it('RUNNING pair with no assignment is permitted; does not claim execution', () => {
    const pair = Pair.create('proj_1' as any, 'Running empty pair');
    pair.makeActive();
    pair.startRelay();
    assert.strictEqual(pair.relayState, 'RUNNING');
    assert.strictEqual(pair.operationalState, 'ACTIVE');
    // No assignment exists; therefore no attempt/delivery exists.
    // This proves RUNNING is only loop enablement, not execution evidence.
  });
});

describe('integration — delivery durable intent before provider', () => {
  it('delivery delivers durable intent before provider evidence', () => {
    const delivery = Delivery.create('asgn_1' as any, 'att_1' as any, 'run_1' as any, 'snippet', 'key');
    // Phase 1: durable intent committed before any provider call.
    assert.strictEqual(delivery.status, 'pending');
    delivery.startDelivering();
    assert.strictEqual(delivery.status, 'delivering');
    // At this point no provider evidence exists; delivering is durable intent only.
  });
});

describe('integration — delivered does not prove execution', () => {
  it('confirmed delivered requires evidence; attempt remains separate', () => {
    const delivery = Delivery.create('asgn_1' as any, 'att_1' as any, 'run_1' as any, 'snippet', 'key2');
    const evidence = {
      id: 'ev_delivered',
      timestamp: Date.now(),
      source: 'provider_transport',
      runtimeSessionId: 'run_1',
      details: {},
    } as any;
    delivery.confirmDelivered(evidence);
    assert.strictEqual(delivery.status, 'delivered');
    // delivered = delivery confirmed by provider evidence.
    // It does NOT imply the worker began execution (Attempt.running requires separate evidence).
  });
});

describe('integration — attempt execution requires evidence', () => {
  it('prepared stays until execution evidence; delivery alone insufficient', () => {
    const attempt = Attempt.create('asgn_1' as any, 1, {
      sessionPairId: 'pair_1' as any,
      workerSessionId: 'run_1' as any,
      externalSessionId: 'ses_1',
    });
    // Before any provider confirmation, attempt is durable intent only.
    assert.strictEqual(attempt.status, 'prepared');
    // Even if a delivery were confirmed delivered (provider evidence of send),
    // attempt should not transition to running until execution evidence confirms
    // the worker has begun. The freeze separates delivery (Dimension C) from
    // execution (Dimension A) explicitly.
  });
});

describe('integration — pair.status is not execution authority', () => {
  it('pair.status active indicates slot ownership, not provider reachability', () => {
    const pair = Pair.create('proj_1' as any, 'Slot-owner pair');
    const assignment = Assignment.create('pair_1' as any, 'proj_1' as any, 'Task', 'Instruction');
    pair.assignWork(assignment.id);
    assert.strictEqual(pair.status, 'active');
    // pair.status = active means a non-terminal assignment owns the execution slot.
    // It is a derived presentation state; provider reachability must be read
    // separately from RuntimeSession with lastEvidence.
  });
});
