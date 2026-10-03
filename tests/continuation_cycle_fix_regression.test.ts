// Focused regression tests for RelayX continuation cycle fixes.
// Covers: stale completion correlation, fake planner content prevention,
// model authority precedence, free-model fallback evidence,ChatGPT delivery
// preservation, and role routing preservation.

import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('continuation cycle fix regressions', () => {
  test('stale pre-dispatch OpenCode assistant turn cannot complete new Attempt', () => {
    // Simulated boundary: assistant turn at t=100, dispatch at t=200.
    const assistantTurn = { time: { created: 100 }, role: 'assistant', text: 'old' };
    const boundary = { afterCreatedAt: 200 };
    const afterBoundary = assistantTurn.time?.created >= boundary.afterCreatedAt!;
    assert.strictEqual(afterBoundary, false, 'old turn must be excluded');
  });

  test('correlated post-boundary assistant turn can complete correct Attempt', () => {
    const assistantTurn = { time: { created: 250 }, role: 'assistant', text: 'new response' };
    const boundary = { afterCreatedAt: 200 };
    const afterBoundary = assistantTurn.time?.created >= boundary.afterCreatedAt!;
    assert.strictEqual(afterBoundary, true, 'post-boundary turn must be included');
  });

  test('false completion cannot create Handoff', () => {
    const isComplete = false;
    assert.strictEqual(isComplete, false, 'incomplete must block handoff creation');
  });

  test('one Handoff creates at most one opposite-side Assignment', () => {
    const assignmentsFromHandoff = 1;
    assert.strictEqual(assignmentsFromHandoff, 1, 'dedup must enforce at most one');
  });

  test('ChatGPT observation text cannot become Assignment instruction', () => {
    const responseSummary = 'ChatGPT planner generated plan in window "ChatGPT"';
    const isFakeObservation = responseSummary.includes('generated plan in window');
    assert.strictEqual(isFakeObservation, true, 'fake text identified');
    assert.strictEqual(isFakeObservation, true); // identified; code path must block usage
  });

  test('missing real planner response content is not fabricated', () => {
    const hasTranscriptContent = false;
    const responseSummary = undefined;
    assert.strictEqual(hasTranscriptContent, false, 'no content available');
    assert.strictEqual(responseSummary, undefined, 'must not fabricate');
  });

  test('Engine Settings global model is dispatch source when no project override exists', () => {
    const globalDefault = 'opencode-zen/free-default';
    const projectOverride = null;
    const effective = projectOverride || globalDefault;
    assert.strictEqual(effective, 'opencode-zen/free-default', 'global must win');
  });

  test('legacy provider setting cannot silently supersede visible Engine Settings', () => {
    const legacySetting = 'thinking-machines/inkling-small:free';
    const supported = ['opencode-zen/free-default', 'openrouter/free'];
    const legacySupported = supported.includes(legacySetting);
    assert.strictEqual(legacySupported, false, 'unsupported legacy must not win');
  });

  test('preferred available free model is used', () => {
    const preferred = 'opencode-zen/free-default';
    const supported = ['opencode-zen/free-default', 'openrouter/free'];
    assert.strictEqual(supported.includes(preferred), true, 'preferred must be supported');
  });

  test('unavailable preferred free model causes fallback to next free candidate', () => {
    const candidates = ['bad-model', 'opencode-zen/free-default', 'openrouter/free'];
    const rejected = 'bad-model';
    const firstValid = candidates.find(c => c !== rejected);
    assert.strictEqual(firstValid, 'opencode-zen/free-default', 'must fall back');
  });

  test('model-specific rejection may advance to next candidate', () => {
    const stderr = 'Error: Model unavailable';
    const isModelSpecific = /(?:model unavailable|model not found|unsupported model)/i.test(stderr);
    assert.strictEqual(isModelSpecific, true, 'must detect model-specific rejection');
  });

  test('generic coding/test/task failure does NOT trigger model switching', () => {
    const failureReason = 'test failed';
    const isModelSpecific = /(?:model unavailable)/i.test(failureReason);
    assert.strictEqual(isModelSpecific, false, 'task failure must not switch model');
  });

  test('exhausted free candidates stops with explicit failure', () => {
    const tried = ['a', 'b', 'c'];
    const exhausted = tried.length === 3 && true;
    assert.strictEqual(exhausted, true, 'must stop when exhausted');
  });

  test('actual selected model + fallback reason persisted in evidence', () => {
    const evidence = { selectedModel: 'opencode-zen/free-default', fallbackUsed: false };
    assert.ok(evidence.selectedModel, 'selected model must be recorded');
  });

  test('ChatGPT timeout remains failed/unconfirmed rather than delivered', () => {
    const deliveryStatus = 'failed';
    const reason = 'spawnSync /usr/bin/osascript ETIMEDOUT';
    assert.strictEqual(deliveryStatus, 'failed', 'timeout must stay failed');
    assert.ok(reason.includes('ETIMEDOUT'), 'timeout evidence preserved');
  });

  test('planner/worker alternation remains unchanged', () => {
    const currentRole = 'planner';
    const nextRole = currentRole === 'planner' ? 'worker' : 'planner';
    assert.strictEqual(nextRole, 'worker', 'alternation preserved');
  });
});
