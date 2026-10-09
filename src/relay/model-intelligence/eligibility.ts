/** Metadata is discovery evidence, never account billing authority. */
export interface CatalogEntry {
  providerId: string;
  endpointId: string;
  publishedModelId: string;
  displayName: string;
  provenance: EvidenceSource;
}

export interface EvidenceSource {
  sourceUrl: string;
  fetchedAt: number;
  contentHash: string;
  parserVersion: string;
}

/** accountId is an opaque reference, never a credential or API key. */
export interface ModelRoute {
  providerId: string;
  endpointId: string;
  publishedModelId: string;
  accountId: string;
  runtimeConfigFingerprint: string;
}

export const COST_DIMENSIONS = [
  'input', 'output', 'cached', 'reasoning', 'media', 'tool',
  'perRequest', 'routing', 'byok', 'surcharge', 'promotionalConditions',
] as const;
export type CostDimension = typeof COST_DIMENSIONS[number];
export type CostStatus = 'FREE' | 'NOT_APPLICABLE' | 'PAID' | 'MIXED' | 'PROMOTIONAL_CREDIT_ONLY' | 'UNKNOWN';

export interface EligibilityLease {
  route: ModelRoute;
  verifiedAt: number;
  expiresAt: number;
  verdict: 'VERIFIED_FREE' | 'DENIED' | 'UNKNOWN';
  pricingEvidence: EvidenceSource;
  accountEvidence: EvidenceSource;
  accountPolicyHash: string;
  costs: Record<CostDimension, CostStatus>;
  conflicts: string[];
}

export interface EligibilityRequest {
  route: ModelRoute;
  now: number;
  accountPolicyHash: string;
  lease?: EligibilityLease;
  taskClass: string;
  purpose: 'TASK' | 'EVALUATION';
  qualification?: {
    route: ModelRoute;
    taskClass: string;
    verifiedAt: number;
    expiresAt: number;
    accepted: boolean;
    evidenceHash: string;
  };
  taskQuota: 'AVAILABLE' | 'EXHAUSTED' | 'UNKNOWN';
  evaluationQuota: 'AVAILABLE' | 'EXHAUSTED' | 'UNKNOWN';
  privacy: 'APPROVED' | 'DENIED' | 'UNKNOWN';
  runtime: 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN';
}

const ROUTE_FIELDS = ['providerId', 'endpointId', 'publishedModelId', 'accountId', 'runtimeConfigFingerprint'] as const;
function validRoute(route: ModelRoute): boolean {
  return !!route && ROUTE_FIELDS.every(key => typeof route[key] === 'string' && route[key].trim().length > 0);
}
export function sameRoute(a: ModelRoute, b: ModelRoute): boolean {
  return validRoute(a) && validRoute(b) && ROUTE_FIELDS.every(key => a[key] === b[key]);
}
function fresh(start: number, end: number, now: number): boolean {
  return [start, end, now].every(Number.isFinite) && start <= now && now < end;
}
function validSource(source: EvidenceSource, verifiedAt: number): boolean {
  return !!source && [source.sourceUrl, source.contentHash, source.parserVersion]
    .every(value => typeof value === 'string' && value.trim().length > 0)
    && Number.isFinite(source.fetchedAt) && source.fetchedAt <= verifiedAt;
}

/** Pure policy gate. Verified adapters must supply authoritative leases; this
 * function does not turn catalog claims into billing evidence or send requests.
 * Evaluation can establish qualification, but must pass the same cost gate.
 */
export function evaluateEligibility(request: EligibilityRequest): { dispatchable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const { lease, route, now } = request;
  if (!validRoute(route)) reasons.push('INVALID_ROUTE');
  if (!lease) reasons.push('MISSING_LEASE');
  else {
    if (!sameRoute(route, lease.route)) reasons.push('LEASE_ROUTE_MISMATCH');
    if (!fresh(lease.verifiedAt, lease.expiresAt, now)) reasons.push('LEASE_NOT_CURRENT');
    if (lease.verdict !== 'VERIFIED_FREE') reasons.push('FREE_ACCOUNT_NOT_VERIFIED');
    if (!request.accountPolicyHash || request.accountPolicyHash !== lease.accountPolicyHash) reasons.push('ACCOUNT_POLICY_CHANGED');
    if (!validSource(lease.pricingEvidence, lease.verifiedAt) || !validSource(lease.accountEvidence, lease.verifiedAt)) reasons.push('INVALID_EVIDENCE');
    if (!Array.isArray(lease.conflicts) || lease.conflicts.length !== 0) reasons.push('CONFLICTING_EVIDENCE');
    for (const dimension of COST_DIMENSIONS) {
      if (!['FREE', 'NOT_APPLICABLE'].includes(lease.costs?.[dimension])) reasons.push(`COST_UNVERIFIED:${dimension}`);
    }
  }
  if (request.purpose !== 'TASK' && request.purpose !== 'EVALUATION') reasons.push('INVALID_PURPOSE');
  if (!request.taskClass?.trim()) reasons.push('MISSING_TASK_CLASS');
  if (request.purpose === 'TASK') {
    const qualification = request.qualification;
    if (!qualification || !sameRoute(route, qualification.route)
      || qualification.taskClass !== request.taskClass || qualification.accepted !== true
      || !qualification.evidenceHash?.trim() || !fresh(qualification.verifiedAt, qualification.expiresAt, now)) {
      reasons.push('TASK_NOT_QUALIFIED');
    }
  }
  const quota = request.purpose === 'EVALUATION' ? request.evaluationQuota : request.taskQuota;
  if (quota !== 'AVAILABLE') reasons.push('QUOTA_NOT_AVAILABLE');
  if (request.privacy !== 'APPROVED') reasons.push('PRIVACY_NOT_APPROVED');
  if (request.runtime !== 'HEALTHY') reasons.push('RUNTIME_NOT_HEALTHY');
  return { dispatchable: reasons.length === 0, reasons };
}
