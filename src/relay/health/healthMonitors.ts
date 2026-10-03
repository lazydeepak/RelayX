/**
 * Phase 1 — confirmation-aware orchestration for the four detectors that
 * previously opened incidents on their first qualifying sample.
 *
 * Each detector keeps its OWN policy (see `healthConfirmation.ts`). This layer is
 * intentionally thin: evaluate the pure detector, ask the tracker whether this
 * sample is confirmed, and only then touch the incident engine.
 *
 * Read-only with respect to RelayX operational state.
 */
import { HealthIncident, HealthObservation } from '../domain/healthDomain.ts';
import { HealthIncidentEngine } from '../application/HealthIncidentEngine.ts';
import { HealthConfirmationTracker } from './healthConfirmation.ts';
import { evaluateTransportUnhealthy, TransportUnhealthyResult } from './transportUnhealthyCheck.ts';
import { evaluateProviderUnreachable, ProviderUnreachableResult } from './providerUnreachableCheck.ts';
import { evaluateSessionDrift, SessionDriftResult } from './sessionDriftCheck.ts';
import { evaluateUnexpectedIdleActivity, UnexpectedIdleResult } from './idleActivityCheck.ts';

export interface DetectorOutcome {
  /** The detector's own classification. */
  kind: string;
  /** True only when an incident may be created/updated for this sample. */
  confirmed: boolean;
  /** Why this outcome. */
  reason: string;
  /** The observation to persist, when one exists and is confirmed. */
  observation?: HealthObservation;
  /** The resulting incident, when one was opened or updated. */
  incident?: HealthIncident;
}

/* ---------------- TRANSPORT_UNHEALTHY ---------------- */

export class TransportUnhealthyMonitor {
  private readonly tracker = new HealthConfirmationTracker();

  constructor(private readonly engine: HealthIncidentEngine) {}

  evaluate(
    evidence: Parameters<typeof evaluateTransportUnhealthy>[0] & {
      /**
       * True only when THIS failure is what prevents active work from progressing.
       * Having active work is not the same as being blocked by it: a Delivery that
       * already reached a terminal `failed` disposition did not block anything, while
       * a transport that cannot proceed does. Defaulting to `false` keeps the
       * conservative "requires repetition" policy.
       */
      blocksActiveWork?: boolean;
    },
    nowMs: number = Date.now(),
  ): Promise<DetectorOutcome> {
    return this.handle(
      evaluateTransportUnhealthy(evidence, nowMs),
      `transport:${evidence.activePairId ?? 'unknown'}`,
      !!evidence.blocksActiveWork,
      evidence.authoritative !== false,
      nowMs,
    );
  }

  private async handle(
    result: TransportUnhealthyResult,
    key: string,
    blocksActiveWork: boolean,
    authoritative: boolean,
    nowMs: number,
  ): Promise<DetectorOutcome> {
    const qualifying = result.incidentEligible;
    const confirmation = this.tracker.evaluate({
      key,
      policy: 'repetition_or_blocking_authoritative',
      qualifying,
      authoritative,
      blocksActiveWork,
      nowMs,
    });
    if (!confirmation.confirmed || !result.observation) {
      return { kind: result.kind, confirmed: false, reason: confirmation.reason };
    }
    const incident = await this.engine.recordUnhealthyObservation(result.observation, confirmation.state.count);
    return { kind: result.kind, confirmed: true, reason: confirmation.reason, observation: result.observation, incident };
  }
}

/* ---------------- PROVIDER_UNREACHABLE ---------------- */

export class ProviderUnreachableMonitor {
  private readonly tracker = new HealthConfirmationTracker();

  constructor(private readonly engine: HealthIncidentEngine) {}

  async evaluate(
    evidence: Parameters<typeof evaluateProviderUnreachable>[0] & {
      /**
       * True only when this unreachable provider is what prevents active work from
       * progressing. Required-but-merely-unreachable still needs repetition, because
       * a single unreachable reading is the most common transient in the system.
       */
      blocksActiveWork?: boolean;
    },
    nowMs: number = Date.now(),
  ): Promise<DetectorOutcome> {
    const result = evaluateProviderUnreachable(
      evidence,
      this.tracker.get(`provider:${evidence.providerType}`) ?? { count: 0 },
      nowMs,
    );
    const qualifying = result.incidentEligible;
    const confirmation = this.tracker.evaluate({
      key: `provider:${evidence.providerType}`,
      policy: 'repetition_or_blocking_authoritative',
      qualifying,
      authoritative: evidence.authoritative !== false,
      blocksActiveWork: !!evidence.blocksActiveWork,
      nowMs,
    });
    if (!confirmation.confirmed || !result.observation) {
      return { kind: result.kind, confirmed: false, reason: confirmation.reason };
    }
    return this.commit(result, confirmation.state.count, confirmation.reason, nowMs);
  }

  private async commit(
    result: ProviderUnreachableResult,
    count: number,
    reason: string,
    nowMs: number,
  ): Promise<DetectorOutcome> {
    const incident = await this.engine.recordUnhealthyObservation(result.observation!, count);
    return { kind: result.kind, confirmed: true, reason, observation: result.observation, incident };
  }

  getTracker(): HealthConfirmationTracker {
    return this.tracker;
  }
}

/* ---------------- SESSION_DRIFT ---------------- */

export class SessionDriftMonitor {
  private readonly tracker = new HealthConfirmationTracker();

  constructor(private readonly engine: HealthIncidentEngine) {}

  async evaluate(
    evidence: Parameters<typeof evaluateSessionDrift>[0],
    nowMs: number = Date.now(),
  ): Promise<DetectorOutcome> {
    const result = evaluateSessionDrift(evidence, nowMs);
    const sideKey = `${evidence.pairId ?? 'unknown'}:${evidence.sideRole}`;

    // A strong authoritative mismatch may confirm on the first observation.
    // A provisional one needs a second consistent sample. UNKNOWN never confirms.
    const qualifying = !!result.observation;
    const authoritative = qualifying && evidence.observedIdentityState === 'resolved';
    const confirmation = this.tracker.evaluate({
      key: `drift:${sideKey}`,
      policy: 'immediate_if_authoritative',
      qualifying,
      authoritative,
      blocksActiveWork: false,
      nowMs,
    });

    if (!confirmation.confirmed || !result.observation) {
      return { kind: result.kind, confirmed: false, reason: confirmation.reason };
    }
    const incident = await this.engine.recordUnhealthyObservation(result.observation, confirmation.state.count);
    return {
      kind: result.kind,
      confirmed: true,
      reason: confirmation.reason,
      observation: result.observation,
      incident,
    };
  }
}

/* ---------------- UNEXPECTED_IDLE_ACTIVITY ---------------- */

export class IdleActivityMonitor {
  private readonly tracker = new HealthConfirmationTracker();

  constructor(private readonly engine: HealthIncidentEngine) {}

  async evaluate(
    operationName: string,
    activityCategory: string,
    evidenceTimestamp: number,
    workState: Parameters<typeof evaluateUnexpectedIdleActivity>[3],
    options: { operatorInitiated?: boolean; nowMs?: number } = {},
  ): Promise<DetectorOutcome> {
    const nowMs = options.nowMs ?? evidenceTimestamp;
    const result: UnexpectedIdleResult = evaluateUnexpectedIdleActivity(
      operationName,
      activityCategory,
      evidenceTimestamp,
      workState,
    );
    const key = `idle:${activityCategory}`;
    const qualifying = !!result.observation;
    const confirmation = this.tracker.evaluate({
      key,
      policy: 'repetition_only',
      qualifying,
      // Any idle activity is by definition unjustified, so it is authoritative
      // as a FACT; what it is not is operator-initiated.
      authoritative: true,
      blocksActiveWork: false,
      operatorInitiated: options.operatorInitiated,
      nowMs,
    });

    if (!confirmation.confirmed || !result.observation) {
      return { kind: result.kind, confirmed: false, reason: confirmation.reason };
    }
    const incident = await this.engine.recordUnhealthyObservation(result.observation, confirmation.state.count);
    return {
      kind: result.kind,
      confirmed: true,
      reason: confirmation.reason,
      observation: result.observation,
      incident,
    };
  }
}
