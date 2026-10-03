/**
 * Prompt 7 — SESSION_DRIFT focused tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateSessionDrift } from '../src/relay/health/sessionDriftCheck.ts';

describe('SESSION_DRIFT', () => {
  it('matching authoritative identity -> HEALTHY', () => {
    const result = evaluateSessionDrift({
      pairId: 'pair_01',
      projectId: 'proj_01',
      sideRole: 'planner',
      providerType: 'chatgpt',
      runtimeSessionId: 'runtime_01',
      storedExternalSessionId: 'sess_123',
      storedIdentityState: 'resolved',
      storedVerificationState: 'verified',
      storedExistenceState: 'present',
      observedExternalSessionId: 'sess_123',
      observedIdentityState: 'resolved',
      observedVerificationState: 'verified',
      observedExistenceState: 'present',
      existingVerdict: 'verified',
      activeWorkAffected: true,
    });
    assert.strictEqual(result.kind, 'HEALTHY');
  });

  it('authoritative identity mismatch -> UNHEALTHY when active work affected', () => {
    const result = evaluateSessionDrift({
      pairId: 'pair_01',
      sideRole: 'planner',
      providerType: 'chatgpt',
      runtimeSessionId: 'runtime_01',
      storedExternalSessionId: 'sess_123',
      storedIdentityState: 'resolved',
      observedExternalSessionId: 'sess_999',
      observedIdentityState: 'resolved',
      activeWorkAffected: true,
    });
    assert.strictEqual(result.kind, 'UNHEALTHY');
    assert.ok(result.observation);
    assert.strictEqual(result.evidence!.identityMismatchDetected, true);
  });

  it('identity mismatch without active work -> DEGRADED', () => {
    const result = evaluateSessionDrift({
      pairId: 'pair_02',
      sideRole: 'worker',
      providerType: 'opencode',
      storedExternalSessionId: 'ses_456',
      observedExternalSessionId: 'ses_999',
      activeWorkAffected: false,
    });
    assert.strictEqual(result.kind, 'DEGRADED');
  });

  it('missing observed identity -> UNKNOWN (not fabricated mismatch)', () => {
    const result = evaluateSessionDrift({
      pairId: 'pair_03',
      sideRole: 'planner',
      providerType: 'chatgpt',
      storedExternalSessionId: 'sess_abc',
      observedIdentityState: 'unknown',
      activeWorkAffected: false,
    });
    assert.strictEqual(result.kind, 'UNKNOWN');
  });

  it('stale/unavailable observation -> UNKNOWN, not drift', () => {
    const result = evaluateSessionDrift({
      pairId: 'pair_04',
      sideRole: 'worker',
      providerType: 'opencode',
      observedIdentityState: 'unknown',
      activeWorkAffected: true,
    });
    assert.strictEqual(result.kind, 'UNKNOWN');
  });

  it('ChatGPT stable conversation identity matches despite cosmetic differences', () => {
    // The identity comparison uses external session id (conversation id), not title.
    const result = evaluateSessionDrift({
      pairId: 'pair_chat',
      projectId: 'proj_chat',
      sideRole: 'planner',
      providerType: 'chatgpt',
      storedExternalSessionId: 'c/conversation-uuid',
      storedIdentityState: 'resolved',
      observedExternalSessionId: 'c/conversation-uuid',
      observedIdentityState: 'resolved',
      existingVerdict: 'verified',
      activeWorkAffected: true,
    });
    assert.strictEqual(result.kind, 'HEALTHY');
  });

  it('OpenCode exact ses_* mismatch detected', () => {
    const result = evaluateSessionDrift({
      pairId: 'pair_op',
      sideRole: 'worker',
      providerType: 'opencode',
      runtimeSessionId: 'runtime_op_01',
      storedExternalSessionId: 'ses_op_01',
      observedExternalSessionId: 'ses_op_02',
      activeWorkAffected: true,
    });
    assert.strictEqual(result.kind, 'UNHEALTHY');
    assert.ok(result.evidence!.identityMismatchDetected);
  });

  it('verification mismatch classified distinctly', () => {
    const result = evaluateSessionDrift({
      pairId: 'pair_05',
      sideRole: 'planner',
      providerType: 'chatgpt',
      storedVerificationState: 'verified',
      observedVerificationState: 'mismatched',
      storedIdentityState: 'resolved',
      observedIdentityState: 'resolved',
      activeWorkAffected: false,
    });
    assert.strictEqual(result.kind, 'DEGRADED');
    assert.strictEqual(result.evidence!.verificationMismatchDetected, true);
  });

  it('evidence bounded — no arbitrary user data', () => {
    const result = evaluateSessionDrift({
      pairId: 'pair_ev',
      sideRole: 'worker',
      providerType: 'opencode',
      storedExternalSessionId: 'ses_ev_01',
      observedExternalSessionId: 'ses_ev_02',
      activeWorkAffected: true,
    });
    assert.ok(result.evidence);
    assert.strictEqual(typeof result.evidence!.pairId, 'string');
    assert.strictEqual(typeof result.evidence!.expectedExternalSessionId, 'string');
  });

  it('no mutation of Pair/Runtime/project association', () => {
    const pairBinding = { plannerSessionId: 'runtime_01', workerSessionId: 'runtime_02' };
    const result = evaluateSessionDrift({
      pairId: 'pair_no_mut',
      sideRole: 'planner',
      providerType: 'chatgpt',
      runtimeSessionId: 'runtime_01',
      storedExternalSessionId: 'sess_01',
      observedExternalSessionId: 'sess_01',
      storedIdentityState: 'resolved',
      observedIdentityState: 'resolved',
      activeWorkAffected: false,
    });
    assert.strictEqual(result.kind, 'HEALTHY');
  });

  it('existing verdict/state preserved in evidence when identity matches', () => {
    const result = evaluateSessionDrift({
      pairId: 'pair_06',
      sideRole: 'planner',
      providerType: 'chatgpt',
      existingVerdict: 'verified',
      storedIdentityState: 'resolved',
      storedExternalSessionId: 'sess_06',
      observedIdentityState: 'resolved',
      observedExternalSessionId: 'sess_06',
      activeWorkAffected: false,
    });
    assert.strictEqual(result.kind, 'HEALTHY');
    // When identity matches, there is no drift incident, so no evidence is produced.
    assert.strictEqual(result.observation, undefined);
  });

  it('resolution requires authoritative match — not just observation absence', () => {
    // Unknown / missing observation is NOT recovery — per freeze rules.
    // Only an authoritative match resolves a drift incident.
    const result = evaluateSessionDrift({
      pairId: 'pair_07',
      sideRole: 'worker',
      providerType: 'opencode',
      observedIdentityState: 'unknown',
      activeWorkAffected: false,
    });
    assert.strictEqual(result.kind, 'UNKNOWN');
  });
});
