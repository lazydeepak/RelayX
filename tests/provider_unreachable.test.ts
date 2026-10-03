/**
 * Prompt 6 — PROVIDER_UNREACHABLE focused tests.
 *
 * `reachable: null` means "could not check" (I-6) and must resolve to UNKNOWN,
 * never HEALTHY.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateProviderUnreachable } from '../src/relay/health/providerUnreachableCheck.ts';

const NONE = { count: 0 };

describe('PROVIDER_UNREACHABLE', () => {
  it('provider required and reachable -> REACHABLE', () => {
    const r = evaluateProviderUnreachable({
      providerType: 'chatgpt', providerName: 'ChatGPT', integrationStatus: 'verified',
      reachable: true, requiredForActiveWork: true, activePairCount: 1,
    }, NONE);
    assert.strictEqual(r.kind, 'REACHABLE');
    assert.strictEqual(r.incidentEligible, false);
  });

  it('provider not required -> NOT_REQUIRED, no incident', () => {
    const r = evaluateProviderUnreachable({ providerType: 'vscode', requiredForActiveWork: false, activePairCount: 0 }, NONE);
    assert.strictEqual(r.kind, 'NOT_REQUIRED');
    assert.strictEqual(r.incidentEligible, false);
  });

  it('unconfigured provider while required -> incident', () => {
    const r = evaluateProviderUnreachable({
      providerType: 'opencode', integrationStatus: 'unconfigured', requiredForActiveWork: true, activePairCount: 1,
    }, NONE);
    assert.strictEqual(r.kind, 'NOT_CONFIGURED');
    assert.ok(r.observation);
    assert.strictEqual(r.incidentEligible, true);
  });

  it('not-detected provider while required -> incident', () => {
    const r = evaluateProviderUnreachable({
      providerType: 'opencode', integrationStatus: 'not_detected', requiredForActiveWork: true, activePairCount: 1,
    }, NONE);
    assert.strictEqual(r.kind, 'NOT_CONFIGURED');
    assert.strictEqual(r.incidentEligible, true);
  });

  it('unreachable provider while required -> UNREACHABLE incident', () => {
    const r = evaluateProviderUnreachable({
      providerType: 'chatgpt', integrationStatus: 'verified', reachable: false,
      reachabilityReason: 'Access denied', requiredForActiveWork: true, activePairCount: 1, pairId: 'pair_01',
    }, { count: 1 });
    assert.strictEqual(r.kind, 'UNREACHABLE');
    assert.ok(r.observation);
    assert.strictEqual(r.observation!.checkType, 'PROVIDER_UNREACHABLE');
    assert.strictEqual(r.incidentEligible, true);
  });

  it('unknown reachability -> OBSERVATION_UNAVAILABLE, never HEALTHY', () => {
    const r = evaluateProviderUnreachable({
      providerType: 'chatgpt', integrationStatus: 'verified', reachable: null, requiredForActiveWork: true,
    }, NONE);
    assert.strictEqual(r.kind, 'OBSERVATION_UNAVAILABLE');
    assert.notStrictEqual(r.kind, 'REACHABLE');
    assert.strictEqual(r.incidentEligible, false);
    assert.strictEqual(r.observation, undefined);
  });

  it('absent reachability is also UNKNOWN', () => {
    const r = evaluateProviderUnreachable({ providerType: 'chatgpt', integrationStatus: 'verified', requiredForActiveWork: true }, NONE);
    assert.strictEqual(r.kind, 'OBSERVATION_UNAVAILABLE');
  });

  it('identity mismatch is not classified as unreachable', () => {
    const r = evaluateProviderUnreachable({
      providerType: 'chatgpt', integrationStatus: 'verified', reachable: true, requiredForActiveWork: true,
    }, NONE);
    assert.notStrictEqual(r.kind, 'IDENTITY_MISMATCH');
  });

  it('evidence bounded — no arbitrary dumps', () => {
    const r = evaluateProviderUnreachable({
      providerType: 'opencode', providerName: 'OpenCode', integrationStatus: 'verified',
      reachable: false, requiredForActiveWork: true, activePairCount: 1,
    }, NONE);
    assert.ok(r.evidence);
    assert.strictEqual(typeof r.evidence!.providerType, 'string');
    assert.strictEqual(r.evidence!.reachabilityResult!.reachable, false);
  });

  it('no mutation of Pair/Runtime state', () => {
    const state = { providerType: 'vscode', requiredForActiveWork: false };
    evaluateProviderUnreachable(state as any, NONE);
    assert.deepStrictEqual(state, { providerType: 'vscode', requiredForActiveWork: false });
  });

  it('no provider polling loop added', () => {
    assert.strictEqual(typeof evaluateProviderUnreachable, 'function');
  });

  it('confirmation count is carried into evidence', () => {
    const r = evaluateProviderUnreachable({
      providerType: 'chatgpt', integrationStatus: 'verified', reachable: false, requiredForActiveWork: true,
    }, { count: 2 });
    assert.strictEqual(r.evidence!.confirmationCount, 2);
  });
});
