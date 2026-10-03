/**
 * Phase 1 — DELIVERY_STALLED thin orchestration layer.
 *
 * Combines the pure detector (`deliveryStalledCheck`) with confirmation tracking
 * (`deliveryStalledConfirmation`) and the incident engine (`HealthIncidentEngine`).
 *
 * Non-goals: no repair, no retry, no provider contact, no timer loop.
 */
import { HealthObservation } from '../domain/healthDomain.ts';
import { HealthIncidentEngine } from '../application/HealthIncidentEngine.ts';
import { evaluateDeliveryStalled, DeliveryStalledEvidence } from './deliveryStalledCheck.ts';
import { DeliveryStalledConfirmation, StalledCandidate } from './deliveryStalledConfirmation.ts';

export interface DeliveryStalledReport {
  deliveryId: string;
  status: string;
  kind: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  confirmed: boolean;
  incident?: import('../domain/healthDomain.ts').HealthIncident;
  observation?: HealthObservation;
  candidate?: StalledCandidate;
  evidence?: DeliveryStalledEvidence;
  message?: string;
}

export class DeliveryStalledService {
  constructor(
    private readonly engine: HealthIncidentEngine,
    private readonly tracker: DeliveryStalledConfirmation = new DeliveryStalledConfirmation(),
  ) {}

  /**
   * Evaluate a delivery and, if the stall is confirmed, create/update the
   * durable incident.
   *
   * The confirmation tracker is peeked BEFORE the detector runs so the pure
   * detector knows whether this sample is the first qualifying one (candidate
   * only, no observation) or a confirmed repeat (observation emitted). The
   * tracker is only mutated after the detector has classified the sample, so
   * a detector exception cannot corrupt confirmation state.
   */
  async evaluate(
    deliveryStatus: string,
    deliveryId: string,
    createdAt: number,
    updatedAt: number,
    nowMs: number,
    optionalIds?: {
      assignmentId?: string | null;
      attemptId?: string | null;
      pairId?: string | null;
    },
  ): Promise<DeliveryStalledReport> {
    const existingCandidate = this.tracker.getCandidates().get(deliveryId);
    const checkResult = evaluateDeliveryStalled(
      deliveryStatus as import('../domain/types.ts').DeliveryStatus,
      createdAt,
      updatedAt,
      deliveryId,
      nowMs,
      optionalIds,
      { count: existingCandidate?.count ?? 0 },
    );

    // Unknown: do not create any incident or candidate
    if (checkResult.kind === 'UNKNOWN') {
      return {
        deliveryId,
        status: deliveryStatus,
        kind: 'UNKNOWN',
        confirmed: false,
        observation: checkResult.observation,
        evidence: checkResult.evidence,
        message: checkResult.message,
      };
    }

    // HEALTHY clears any existing candidate (no premature resolution call to engine).
    if (checkResult.kind === 'HEALTHY') {
      this.tracker.evaluateConfirmation(deliveryId, deliveryStatus, nowMs, false);
      return {
        deliveryId,
        status: deliveryStatus,
        kind: 'HEALTHY',
        confirmed: false,
        observation: checkResult.observation,
        evidence: checkResult.evidence,
        message: checkResult.message,
      };
    }

    // Evaluate confirmation for stall candidates.
    //
    // `incidentEligible === false` means this sample must never become a
    // DELIVERY_STALLED incident even though it is DEGRADED. An ambiguous outcome
    // is uncertain, not stuck, so it is reported as a bounded observation only and
    // deliberately does not feed the stall confirmation counter.
    const incidentEligible = checkResult.incidentEligible !== false;
    const isStalled =
      incidentEligible && (checkResult.kind === 'DEGRADED' || checkResult.kind === 'UNHEALTHY');
    const confirmation = this.tracker.evaluateConfirmation(
      deliveryId,
      deliveryStatus,
      nowMs,
      isStalled,
    );

    if (!incidentEligible) {
      return {
        deliveryId,
        status: deliveryStatus,
        kind: checkResult.kind,
        confirmed: false,
        observation: checkResult.observation,
        evidence: checkResult.evidence,
        message: checkResult.message,
      };
    }

    // Only a CONFIRMED observation reaches the incident engine. A first
    // qualifying sample stays a candidate: evidence and candidate are
    // reported, but no observation exists and no incident is opened.
    if (confirmation.confirmed && checkResult.observation) {
      const incident = await this.engine.recordUnhealthyObservation(
        checkResult.observation,
        confirmation.candidate?.count,
      );
      return {
        deliveryId,
        status: deliveryStatus,
        kind: checkResult.kind,
        confirmed: true,
        incident,
        observation: checkResult.observation,
        candidate: confirmation.candidate,
        evidence: checkResult.evidence,
        message: checkResult.message,
      };
    }

    return {
      deliveryId,
      status: deliveryStatus,
      kind: checkResult.kind,
      confirmed: confirmation.confirmed,
      observation: checkResult.observation,
      candidate: confirmation.candidate,
      evidence: checkResult.evidence,
      message: checkResult.message,
    };
  }

  getTracker(): DeliveryStalledConfirmation {
    return this.tracker;
  }
}
