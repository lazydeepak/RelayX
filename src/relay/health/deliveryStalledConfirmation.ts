/**
 * Phase 1 — Delivery stalled confirmation/debounce tracker.
 *
 * Confirmed rule: first qualifying observation = candidate only;
 * second qualifying observation (same delivery key, same unhealthy condition) = confirmed.
 * Only confirmed observations are passed to HealthIncidentEngine for incident creation/update.
 */

export interface StalledCandidate {
  deliveryId: string;
  firstObservedMs: number;
  lastObservedMs: number;
  count: number;
  status: string; // captured status at confirmation
}

export class DeliveryStalledConfirmation {
  private candidates = new Map<string, StalledCandidate>();

  /** Evaluate confirmation for a delivery. Returns true only on the second confirmed observation. */
  evaluateConfirmation(
    deliveryId: string,
    status: string,
    nowMs: number,
    isStalled: boolean,
  ): { confirmed: boolean; candidate?: StalledCandidate; message?: string } {
    const existing = this.candidates.get(deliveryId);

    if (!isStalled) {
      // Condition no longer present: clear candidate (no premature resolution from detector).
      if (existing) {
        this.candidates.delete(deliveryId);
      }
      return { confirmed: false, message: 'Stalled condition cleared' };
    }

    if (!existing) {
      // First qualifying observation: register as candidate only.
      this.candidates.set(deliveryId, {
        deliveryId,
        firstObservedMs: nowMs,
        lastObservedMs: nowMs,
        count: 1,
        status,
      });
      return { confirmed: false, candidate: this.candidates.get(deliveryId)!, message: 'Candidate registered; confirmation required' };
    }

    // Second (or later) qualifying observation: update and confirm.
    existing.lastObservedMs = nowMs;
    existing.count += 1;
    existing.status = status;
    this.candidates.set(deliveryId, existing);
    return { confirmed: true, candidate: existing, message: 'Confirmed stalled' };
  }

  /** Expose current candidates for inspection / testing (read-only). */
  getCandidates(): ReadonlyMap<string, StalledCandidate> {
    return this.candidates;
  }

  /** Clear all candidate state (e.g., for tests). */
  clear(): void {
    this.candidates.clear();
  }
}
