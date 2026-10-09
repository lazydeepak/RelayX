import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COST_DIMENSIONS, evaluateEligibility, type EligibilityRequest } from '../src/relay/model-intelligence/eligibility';

function request(): EligibilityRequest {
  const route = { providerId: 'provider', endpointId: 'endpoint', publishedModelId: 'model:free', accountId: 'opaque-account', runtimeConfigFingerprint: 'config-hash' };
  const source = { sourceUrl: 'https://provider.example/account', fetchedAt: 90, contentHash: 'hash', parserVersion: '1' };
  return {
    route, now: 150, accountPolicyHash: 'policy', taskClass: 'coding', purpose: 'TASK',
    lease: { route: { ...route }, verifiedAt: 100, expiresAt: 200, verdict: 'VERIFIED_FREE', pricingEvidence: { ...source }, accountEvidence: { ...source }, accountPolicyHash: 'policy', conflicts: [], costs: Object.fromEntries(COST_DIMENSIONS.map(key => [key, 'FREE'])) as NonNullable<EligibilityRequest['lease']>['costs'] },
    qualification: { route: { ...route }, taskClass: 'coding', verifiedAt: 100, expiresAt: 200, accepted: true, evidenceHash: 'accepted-artifact' },
    taskQuota: 'AVAILABLE', evaluationQuota: 'AVAILABLE', privacy: 'APPROVED', runtime: 'HEALTHY',
  };
}
function blocked(value: EligibilityRequest, reason: string) {
  const result = evaluateEligibility(value);
  assert.equal(result.dispatchable, false);
  assert.ok(result.reasons.includes(reason), JSON.stringify(result));
}

describe('zero paid inference eligibility boundary', () => {
  it('accepts a current exact account lease and task evidence without mutating inputs', () => {
    const value = request(); const before = structuredClone(value);
    assert.deepEqual(evaluateEligibility(value), { dispatchable: true, reasons: [] });
    assert.deepEqual(value, before);
  });
  it('does not authorize a free alias without account evidence', () => {
    const value = request(); delete value.lease;
    blocked(value, 'MISSING_LEASE');
  });
  for (const dimension of COST_DIMENSIONS) {
    for (const status of ['PAID', 'MIXED', 'PROMOTIONAL_CREDIT_ONLY', 'UNKNOWN'] as const) {
      it(`rejects ${status} ${dimension} even with VERIFIED_FREE verdict`, () => {
        const value = request(); value.lease!.costs[dimension] = status;
        blocked(value, `COST_UNVERIFIED:${dimension}`);
      });
    }
  }
  it('rejects missing output billing evidence', () => {
    const value = request(); delete (value.lease!.costs as Partial<NonNullable<EligibilityRequest['lease']>['costs']>).output;
    blocked(value, 'COST_UNVERIFIED:output');
  });
  for (const key of ['providerId', 'endpointId', 'publishedModelId', 'accountId', 'runtimeConfigFingerprint'] as const) {
    it(`cannot reuse authorization after ${key} changes`, () => {
      const value = request(); value.route[key] += '-changed';
      blocked(value, 'LEASE_ROUTE_MISMATCH');
    });
  }
  for (const now of [99, 200, 201, NaN, Infinity]) {
    it(`rejects future, expired, or invalid clock ${now}`, () => {
      const value = request(); value.now = now;
      blocked(value, 'LEASE_NOT_CURRENT');
    });
  }
  it('rejects changed account policy and conflicting evidence', () => {
    const value = request(); value.accountPolicyHash = 'changed'; value.lease!.conflicts.push('account charges');
    blocked(value, 'ACCOUNT_POLICY_CHANGED'); blocked(value, 'CONFLICTING_EVIDENCE');
  });
  it('rejects missing provenance and evidence fetched after verification', () => {
    const value = request(); value.lease!.accountEvidence.contentHash = '';
    blocked(value, 'INVALID_EVIDENCE');
    value.lease!.accountEvidence.contentHash = 'hash'; value.lease!.pricingEvidence.fetchedAt = 101;
    blocked(value, 'INVALID_EVIDENCE');
  });
  it('requires local routes to have task qualification too', () => {
    const value = request(); value.route.providerId = 'local'; value.lease!.route.providerId = 'local'; delete value.qualification;
    blocked(value, 'TASK_NOT_QUALIFIED');
  });
  it('does not reuse qualification for another task class', () => {
    const value = request(); value.taskClass = 'recovery'; blocked(value, 'TASK_NOT_QUALIFIED');
  });
  for (const quota of ['UNKNOWN', 'EXHAUSTED'] as const) {
    it(`blocks ${quota} task quota without selecting a paid fallback`, () => {
      const value = request(); value.taskQuota = quota; blocked(value, 'QUOTA_NOT_AVAILABLE');
    });
  }
  it('allows evaluation to establish qualification but requires separate evaluation quota', () => {
    const value = request(); value.purpose = 'EVALUATION'; delete value.qualification; value.taskQuota = 'EXHAUSTED';
    assert.equal(evaluateEligibility(value).dispatchable, true);
    value.evaluationQuota = 'EXHAUSTED'; blocked(value, 'QUOTA_NOT_AVAILABLE');
  });
  it('requires verified cost for benchmark calls', () => {
    const value = request(); value.purpose = 'EVALUATION'; value.lease!.verdict = 'UNKNOWN';
    blocked(value, 'FREE_ACCOUNT_NOT_VERIFIED');
  });
  it('blocks unknown privacy and unhealthy runtime', () => {
    const value = request(); value.privacy = 'UNKNOWN'; value.runtime = 'UNAVAILABLE';
    blocked(value, 'PRIVACY_NOT_APPROVED'); blocked(value, 'RUNTIME_NOT_HEALTHY');
  });
});
