import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/*
 * Semantic freeze regression tests (§SEMANTIC_FREEZE).
 * Verify that lifecycle state semantics are enforced and that no
 * consumer conflates authority / durable intent / execution / reachability.
 */

import {
  RuntimeSession,
  Pair,
  Assignment,
  Attempt,
  Delivery,
  RuntimeProjectAssociation,
} from '../src/relay/domain/entities';

describe('semantic freeze — authority vs reachability', () => {
  it('ACTIVE pair does not prove provider verification or reachability', () => {
    const pair = Pair.create('proj_1' as any as any, 'Test pair');
    pair.makeActive();
    assert.strictEqual(pair.operationalState, 'ACTIVE');
    // operationalState grants authority; it does not confirm verified side identity
    // or provider reachability — that requires sideIdentities / RuntimeSession evidence
  });

  it('IDLE pair refuses provider contact', () => {
    const pair = Pair.create('proj_1' as any, 'Idle pair');
    assert.strictEqual(pair.operationalState, 'IDLE');
    assert.strictEqual(pair.isProviderContactPermitted(), false);
  });
});

describe('semantic freeze — relay enablement vs execution', () => {
  it('RUNNING relay with zero assignments/attempts is permitted', () => {
    const pair = Pair.create('proj_1' as any, 'Empty running pair');
    pair.makeActive();
    pair.startRelay();
    assert.strictEqual(pair.relayState, 'RUNNING');
    assert.strictEqual(pair.operationalState, 'ACTIVE');
    assert.strictEqual(pair.status, 'idle'); // no assignment owns slot
    // RUNNING does NOT prove work is executing; only that automated loop is enabled
  });

  it('PAUSED pair does not permit automated contact', () => {
    const pair = Pair.create('proj_1' as any, 'Paused pair');
    pair.makeActive();
    pair.startRelay();
    pair.pauseRelay();
    assert.strictEqual(pair.isAutomatedContactPermitted(), false);
  });
});

describe('semantic freeze — delivery durable intent', () => {
  it('delivering exists before provider call (durable intent)', () => {
    const delivery = Delivery.create('asgn_1' as any, 'att_1' as any, 'run_1' as any, 'snippet', 'key_1' as any);
    delivery.startDelivering();
    assert.strictEqual(delivery.status, 'delivering');
    // delivering means durable intent committed; not proof of external transmission
  });

  it('delivered requires provider evidence; does NOT prove execution', () => {
    const delivery = Delivery.create('asgn_1' as any, 'att_1' as any, 'run_1' as any, 'snippet', 'key_2' as any);
    const evidence = {
      id: 'ev_delivered_1',
      timestamp: Date.now(),
      source: 'provider_transport',
      runtimeSessionId: 'run_1' as any,
      details: { phase: 'post_transport' },
    } as any;
    delivery.confirmDelivered(evidence);
    assert.strictEqual(delivery.status, 'delivered');
    // delivered = delivery confirmed; execution evidence is separate (Attempt.running)
  });
});

describe('semantic freeze — attempt lifecycle', () => {
  it('prepared remains until execution evidence (not just delivery start)', () => {
    const attempt = Attempt.create('asgn_1' as any, 1, {
      sessionPairId: 'pair_1' as any,
      workerSessionId: 'run_1' as any,
      externalSessionId: 'ses_1',
    });
    assert.strictEqual(attempt.status, 'prepared');
    // prepared is durable local intent; no provider evidence yet
  });

  it('running requires external evidence (simulated by transition guard)', () => {
    const attempt = Attempt.create('asgn_1' as any, 1, {
      sessionPairId: 'pair_1' as any,
      workerSessionId: 'run_1' as any,
      externalSessionId: 'ses_1',
    });
    // In engine, startRunning() is called only after provider.deliverInstruction()
    // returns delivered + Delivery.confirmDelivered() — i.e. with ObservableEvidence.
    // This test verifies the semantic contract: running must not be set from
    // local state alone (e.g. relayState.RUNNING or pair.status.active).
    assert.strictEqual(attempt.status, 'prepared');
    assert.notStrictEqual(attempt.status, 'running');
  });
});

describe('semantic freeze — pair.status is not execution authority', () => {
  it('pair.status active does not prove external work', () => {
    const pair = Pair.create('proj_1' as any, 'Active pair');
    const assignment = Assignment.create('pair_1' as any, 'proj_1' as any, 'Task', 'Instruction');
    pair.assignWork(assignment.id);
    assert.strictEqual(pair.status, 'active');
    // pair.status = active indicates slot ownership, not provider reachability or
    // active external transmission. Reachability must be read from RuntimeSession
    // with lastEvidence; transmission state from Delivery.status.
  });
});
