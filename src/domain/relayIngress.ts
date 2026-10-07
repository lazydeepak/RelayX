/**
 * RelayIngress — durable bootstrap root for automatic assignment materialization.
 *
 * Represents one identity-proven completed Planner turn observed after the arm
 * boundary. State progression: armed -> observed -> materialized -> superseded.
 *
 * Uniqueness: (stable_pair_id, source_side, external_session_id, provider_turn_identity)
 */
export interface RelayIngress {
  ingressId: string;
  stablePairId: string;
  sourceSide: 'planner';
  providerType: string;
  externalSessionId: string;
  providerTurnIdentity: string;
  observedText: string;
  contentHash?: string;
  armEvidence: { armId: string; boundarySource?: string };
  state: 'armed' | 'observed' | 'materialized' | 'superseded';
  materializedAssignmentId?: string | null;
  createdAt: number;
  updatedAt: number;
  observedAt?: number;
}
