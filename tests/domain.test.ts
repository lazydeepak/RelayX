import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  Project,
  Pair,
  RuntimeSession,
  Assignment,
  Attempt,
  Delivery,
  Handoff,
  RelayEvent,
  AttentionItem,
} from '../src/relay/domain/entities.ts';
import {
  DuplicateDeliveryAttemptError,
  MissingEvidenceError,
  InvalidStateTransitionError,
} from '../src/relay/domain/errors.ts';
import { ObservableEvidence } from '../src/relay/domain/types.ts';

describe('Relay Domain Model & Invariants', () => {
  it('enforces single timeout transitions to suspended, NOT permanently terminated', () => {
    const runtime = RuntimeSession.create('opencode', 'Worker-1', 'com.opencode.desktop');
    runtime.recordObservationSuccess('working');
    assert.strictEqual(runtime.status, 'working');

    // 1st failure: must move to suspended, NOT terminated
    const { previousStatus, newStatus } = runtime.recordObservationFailure(3);
    assert.strictEqual(previousStatus, 'working');
    assert.strictEqual(newStatus, 'suspended');
    assert.strictEqual(runtime.status, 'suspended');
    assert.strictEqual(runtime.consecutiveObservationFailures, 1);

    // 2nd failure: still suspended
    runtime.recordObservationFailure(3);
    assert.strictEqual(runtime.status, 'suspended');

    // 3rd failure: reaches max failure threshold, now terminated
    runtime.recordObservationFailure(3);
    assert.strictEqual(runtime.status, 'terminated');
  });

  it('restores suspended runtime to available upon observation success', () => {
    const runtime = RuntimeSession.create('chatgpt', 'Planner-1', 'com.openai.chat');
    runtime.recordObservationFailure(3);
    assert.strictEqual(runtime.status, 'suspended');

    const evidence: ObservableEvidence = {
      id: 'ev_test_1',
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      windowTitle: 'ChatGPT',
      applicationPid: 1234,
    };

    runtime.recordObservationSuccess('available', evidence);
    assert.strictEqual(runtime.status, 'available');
    assert.strictEqual(runtime.consecutiveObservationFailures, 0);
    assert.strictEqual(runtime.lastEvidence?.id, 'ev_test_1');
  });

  it('prohibits duplicate deliveries on the same assignment without resolution', () => {
    const project = Project.create('Alpha');
    const planner = RuntimeSession.create('chatgpt', 'Planner');
    const worker = RuntimeSession.create('opencode', 'Worker');
    const pair = Pair.create(project.id, 'Pair 1', planner.id, worker.id);
    const assignment = Assignment.create(pair.id, project.id, 'Task 1', 'Fix bug');

    const attempt = Attempt.create(assignment.id, 1);
    assignment.startAttempt(attempt);

    const delivery1 = Delivery.create(assignment.id, attempt.id, worker.id, 'snippet', 'idemp_1');
    assignment.attachDelivery(delivery1);

    const delivery2 = Delivery.create(assignment.id, attempt.id, worker.id, 'snippet', 'idemp_2');
    assert.throws(
      () => assignment.attachDelivery(delivery2),
      DuplicateDeliveryAttemptError,
      'Duplicate delivery should throw DuplicateDeliveryAttemptError',
    );
  });

  it('requires observable evidence to confirm delivery', () => {
    const assignment = Assignment.create('pair_1' as any, 'proj_1' as any, 'Task', 'Test instruction');
    const attempt = Attempt.create(assignment.id, 1);
    const delivery = Delivery.create(assignment.id, attempt.id, 'runtime_1' as any, 'instruction', 'idemp_test');

    delivery.startDelivering();
    assert.strictEqual(delivery.status, 'delivering');

    assert.throws(
      () => (delivery as any).confirmDelivered(null),
      MissingEvidenceError,
      'Delivered state requires non-null verified observable evidence',
    );

    const evidence: ObservableEvidence = {
      id: 'ev_deliv_test',
      timestamp: Date.now(),
      source: 'macos_accessibility',
      composerCleared: true,
      responseActivityObserved: true,
    };
    delivery.confirmDelivered(evidence);
    assert.strictEqual(delivery.status, 'delivered');
    assert.strictEqual(delivery.evidence?.id, 'ev_deliv_test');
  });

  it('strictly decouples handoff completion from assignment completion', () => {
    const assignment = Assignment.create('pair_1' as any, 'proj_1' as any, 'Task', 'Test');
    const attempt = Attempt.create(assignment.id, 1);
    assignment.startAttempt(attempt);

    const handoff = Handoff.create(assignment.id, attempt.id);
    handoff.markReady('Summary of result');
    assignment.markWaitingForHandoff(handoff.id);

    assert.strictEqual(assignment.status, 'waiting_for_handoff');

    // Planner receives and marks handoff complete
    handoff.markDeliveredToPlanner();
    handoff.completeHandoff();

    assert.strictEqual(handoff.status, 'complete');
    // Invariant: assignment must NOT be automatically completed!
    assert.strictEqual(
      assignment.status,
      'waiting_for_handoff',
      'Handoff completion must not silently complete assignment',
    );

    // Explicit assignment completion by planner / operator
    assignment.complete();
    assert.strictEqual(assignment.status, 'completed');
  });
});
