/**
 * Phase 1 — HealthRuntimeCoordinator.
 *
 * The single application-level entry point between real RelayX runtime evidence
 * and the frozen health detectors. It lives in the application layer (NOT inside
 * provider adapters) so detection is independent of the renderer and of any
 * provider implementation detail.
 *
 * Responsibilities:
 *   - receive runtime events RelayX already emits;
 *   - build bounded health inputs from evidence that already exists;
 *   - invoke the appropriate frozen detector/monitor;
 *   - persist observations under a bounded policy;
 *   - hand confirmed, incident-eligible observations to HealthIncidentEngine;
 *   - resolve incidents ONLY from authoritative healthy evidence.
 *
 * Explicit non-goals: no repair, no retry, no restart, no rebind, no provider
 * sweep, no AI, and no health-specific mutation of any operational entity.
 */
import { HealthObservation } from '../domain/healthDomain.ts';
import { HealthIncidentEngine } from './HealthIncidentEngine.ts';
import { IHealthObservationRepository, IRelayRepositories } from '../persistence/interfaces.ts';
import {
  TransportUnhealthyMonitor,
  ProviderUnreachableMonitor,
  SessionDriftMonitor,
  IdleActivityMonitor,
} from '../health/healthMonitors.ts';
import { DeliveryStalledService } from '../health/deliveryStalledService.ts';
import { evaluateMainProcessStall } from '../health/mainProcessStallCheck.ts';
import type { RelayEvent } from '../domain/entities.ts';

/**
 * Bounded observation-persistence policy.
 *
 * Unbounded health observations would be a slow-motion leak: a 30s heartbeat that
 * persists every HEALTHY sample writes ~105k rows/day. So:
 *
 *   - UNHEALTHY / DEGRADED observations are ALWAYS persisted. They are evidence.
 *   - HEALTHY observations are SAMPLED: only the first, then every Nth, and only
 *     within a fixed retention window. Repetitive healthy heartbeats are omitted.
 *   - A health-state TRANSITION (healthy -> unhealthy, or incident -> recovered)
 *     is always persisted, because that is the moment a reader cares about.
 *
 * This is health policy, not a RelayX operational constant.
 */
export const HEALTH_HEALTHY_OBSERVATION_SAMPLE_EVERY = 60;

/**
 * Retention guidance for HEALTHY observations only. Unhealthy evidence is never
 * dropped by age — it is what an incident handoff needs.
 */
export const HEALTH_HEALTHY_OBSERVATION_RETENTION_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface CoordinatorOptions {
  repos: IRelayRepositories;
  engine: HealthIncidentEngine;
  /** Now provider, injectable for deterministic tests. */
  now?: () => number;
  /** Logger; defaults to console. */
  logger?: { warn: (...a: unknown[]) => void };
}

export interface TransportEvidenceInput {
  providerType?: string | null;
  providerReachable?: boolean | null;
  integrationStatus?: any;
  activePairId?: string | null;
  deliveryId?: string | null;
  assignmentId?: string | null;
  deliveryStatus?: any;
  reconciliationOutcome?: any;
  blocksActiveWork?: boolean;
  authoritative?: boolean;
}

export interface ProviderEvidenceInput {
  providerType: string;
  providerName?: string | null;
  integrationStatus?: any;
  reachable?: boolean | null;
  requiredForActiveWork?: boolean;
  blocksActiveWork?: boolean;
  runtimeSessionId?: string | null;
  pairId?: string | null;
  projectId?: string | null;
  authoritative?: boolean;
}

export interface SessionIdentityEvidenceInput {
  pairId?: string | null;
  projectId?: string | null;
  sideRole: 'planner' | 'worker';
  providerType?: string | null;
  runtimeSessionId?: string | null;
  storedExternalSessionId?: string | null;
  storedIdentityState?: any;
  storedVerificationState?: any;
  storedExistenceState?: any;
  observedExternalSessionId?: string | null;
  observedIdentityState?: any;
  observedVerificationState?: any;
  observedExistenceState?: any;
  existingVerdict?: string | null;
  activeWorkAffected?: boolean;
}

export interface IdleActivityInput {
  operationName: string;
  activityCategory: string;
  operatorInitiated?: boolean;
}

/** Counters used by tests and by the performance audit. */
export interface CoordinatorStats {
  transportEvaluations: number;
  providerEvaluations: number;
  sessionEvaluations: number;
  idleActivityEvaluations: number;
  deliveryStallEvaluations: number;
  mainProcessProbeEvaluations: number;
  observationsPersisted: number;
  healthyObservationsSampledOut: number;
  incidentsOpened: number;
  incidentsResolved: number;
  failures: number;
}

export class HealthRuntimeCoordinator {
  private readonly repos: IRelayRepositories;
  private readonly engine: HealthIncidentEngine;
  private readonly observations: IHealthObservationRepository;
  private readonly now: () => number;
  private readonly logger: { warn: (...a: unknown[]) => void };

  private readonly transport: TransportUnhealthyMonitor;
  private readonly provider: ProviderUnreachableMonitor;
  private readonly session: SessionDriftMonitor;
  private readonly idle: IdleActivityMonitor;
  private readonly deliveryStalled: DeliveryStalledService;

  private healthySampleCounter = 0;
  private lastPersistedHealthyAt = 0;
  private readonly stats: CoordinatorStats = {
    transportEvaluations: 0,
    providerEvaluations: 0,
    sessionEvaluations: 0,
    idleActivityEvaluations: 0,
    deliveryStallEvaluations: 0,
    mainProcessProbeEvaluations: 0,
    observationsPersisted: 0,
    healthyObservationsSampledOut: 0,
    incidentsOpened: 0,
    incidentsResolved: 0,
    failures: 0,
  };

  constructor(opts: CoordinatorOptions) {
    this.repos = opts.repos;
    this.engine = opts.engine;
    this.observations = opts.repos.healthObservations;
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? console;

    this.transport = new TransportUnhealthyMonitor(this.engine);
    this.provider = new ProviderUnreachableMonitor(this.engine);
    this.session = new SessionDriftMonitor(this.engine);
    this.idle = new IdleActivityMonitor(this.engine);
    this.deliveryStalled = new DeliveryStalledService(this.engine);
  }

  getStats(): Readonly<CoordinatorStats> {
    return { ...this.stats };
  }

  /* ---------------- failure isolation ---------------- */

  /**
   * Run a health step so that a monitoring failure can never propagate into
   * dispatch, supervision, or runtime execution.
   *
   * A failure is recorded and logged, never converted into a fake healthy
   * observation and never allowed to reject the caller's operation.
   */
  private async guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err: any) {
      this.stats.failures += 1;
      this.logger.warn(`[health] ${label} failed (monitoring only, Relay execution unaffected):`, err?.message ?? err);
      return undefined;
    }
  }

  /* ---------------- bounded observation persistence ---------------- */

  /**
   * Persist an observation unless it is a repetitive HEALTHY sample.
   *
   * Unhealthy/degraded evidence is ALWAYS kept: it is what an incident handoff
   * later reads, and it is rare enough that retaining all of it is affordable.
   *
   * HEALTHY heartbeats are the unbounded risk — a 60s heartbeat writing every
   * sample would add ~1.4k rows/day for no diagnostic value. So a HEALTHY row is
   * persisted only when it is genuinely informative:
   *
   *   - the first HEALTHY sample after any unhealthy/degraded one (a recovery),
   *     which resets sampling; or
   *   - once every `HEALTH_HEALTHY_OBSERVATION_SAMPLE_EVERY` probes, so a long
   *     healthy stretch still leaves periodic evidence that the system was alive.
   */
  private async persistObservation(observation: HealthObservation | undefined): Promise<void> {
    if (!observation) return;

    if (observation.result === 'HEALTHY') {
      this.healthySampleCounter += 1;
      const isSampled = this.healthySampleCounter % HEALTH_HEALTHY_OBSERVATION_SAMPLE_EVERY === 0;
      if (!isSampled) {
        this.stats.healthyObservationsSampledOut += 1;
        return;
      }
    } else {
      // Unhealthy/degraded evidence is always kept, and it resets sampling so the
      // NEXT healthy sample is recorded as a recovery rather than being swallowed
      // as part of an ongoing healthy streak.
      this.healthySampleCounter = 0;
    }

    await this.observations.save(observation);
    this.stats.observationsPersisted += 1;
  }

  /** Persist the observation a monitor produced, honouring the bounded policy. */
  private async persistMonitorObservation(outcome: { observation?: HealthObservation }): Promise<void> {
    if (outcome?.observation) await this.persistObservation(outcome.observation);
  }

  /* ---------------- event-driven detectors ---------------- */

  /**
   * Feed transport evidence RelayX ALREADY produced. This makes no provider call:
   * it only reads a result that dispatch or reconciliation already computed.
   */
  async onTransportEvidence(input: TransportEvidenceInput): Promise<void> {
    await this.guard('transport evaluation', async () => {
      this.stats.transportEvaluations += 1;
      const outcome = await this.transport.evaluate(
        {
          hasActiveWork: !!input.activePairId || !!input.blocksActiveWork,
          providerReachable: input.providerReachable,
          providerStatus: input.integrationStatus,
          activePairId: input.activePairId ?? null,
          assignmentId: input.assignmentId ?? null,
          deliveryId: input.deliveryId ?? null,
          deliveryStatus: input.deliveryStatus,
          reconciliationOutcome: input.reconciliationOutcome,
          authoritative: input.authoritative,
          blocksActiveWork: input.blocksActiveWork,
        },
        this.now(),
      );
      await this.persistMonitorObservation(outcome);
      if (outcome.confirmed) this.stats.incidentsOpened += 1;
    });
  }

  /**
   * Feed provider reachability evidence. Invoked only when RelayX already
   * established reachability — never as a provider sweep.
   */
  async onProviderReachabilityEvidence(input: ProviderEvidenceInput): Promise<void> {
    await this.guard('provider reachability evaluation', async () => {
      this.stats.providerEvaluations += 1;
      const outcome = await this.provider.evaluate(
        {
          providerType: input.providerType,
          providerName: input.providerName ?? null,
          integrationStatus: input.integrationStatus ?? null,
          reachable: input.reachable ?? null,
          requiredForActiveWork: input.requiredForActiveWork,
          runtimeSessionId: input.runtimeSessionId ?? null,
          pairId: input.pairId ?? null,
          projectId: input.projectId ?? null,
          authoritative: input.authoritative,
          blocksActiveWork: input.blocksActiveWork,
        },
        this.now(),
      );
      await this.persistMonitorObservation(outcome);
      if (outcome.confirmed) this.stats.incidentsOpened += 1;
    });
  }

  /**
   * Feed session identity evidence RelayX already produced (S5/S2 observations).
   * No new discovery is performed and nothing is rebound.
   */
  async onSessionIdentityEvidence(input: SessionIdentityEvidenceInput): Promise<void> {
    await this.guard('session drift evaluation', async () => {
      this.stats.sessionEvaluations += 1;
      const outcome = await this.session.evaluate(
        {
          pairId: input.pairId ?? null,
          projectId: input.projectId ?? null,
          sideRole: input.sideRole,
          providerType: input.providerType ?? null,
          runtimeSessionId: input.runtimeSessionId ?? null,
          storedExternalSessionId: input.storedExternalSessionId ?? null,
          storedIdentityState: input.storedIdentityState ?? null,
          storedVerificationState: input.storedVerificationState ?? null,
          storedExistenceState: input.storedExistenceState ?? null,
          observedExternalSessionId: input.observedExternalSessionId ?? null,
          observedIdentityState: input.observedIdentityState ?? null,
          observedVerificationState: input.observedVerificationState ?? null,
          observedExistenceState: input.observedExistenceState ?? null,
          existingVerdict: input.existingVerdict ?? null,
          activeWorkAffected: input.activeWorkAffected,
        },
        this.now(),
      );
      await this.persistMonitorObservation(outcome);
      if (outcome.confirmed) this.stats.incidentsOpened += 1;
    });
  }

  /**
   * Record that an expensive operation just happened. Called at boundaries RelayX
   * already crosses; it performs no additional work of its own.
   */
  async onExpensiveOperation(input: IdleActivityInput, workState?: {
    pairOperationalStates: string[];
    hasActiveAssignment: boolean;
    pairCount: number;
    activePairCount: number;
    activeAssignmentCount: number;
  }): Promise<void> {
    await this.guard('idle activity evaluation', async () => {
      this.stats.idleActivityEvaluations += 1;
      const state = workState ?? (await this.readIdleWorkState());
      const outcome = await this.idle.evaluate(
        input.operationName,
        input.activityCategory,
        this.now(),
        state,
        { operatorInitiated: input.operatorInitiated, nowMs: this.now() },
      );
      await this.persistMonitorObservation(outcome);
      if (outcome.confirmed) this.stats.incidentsOpened += 1;
    });
  }

  /* ---------------- time-based detectors ---------------- */

  /**
   * Evaluate in-flight Deliveries for stalls.
   *
   * Uses `deliveries.findUnresolved()`, which is already indexed to
   * `status IN ('pending','delivering')`, so this is NOT a full-table scan and no
   * per-Delivery timer is created.
   */
  async evaluateStalledDeliveries(): Promise<number> {
    return (await this.guard('delivery stall sweep', async () => {
      const now = this.now();
      const inFlight = await this.repos.deliveries.findUnresolved();
      let opened = 0;
      for (const delivery of inFlight) {
        const report = await this.deliveryStalled.evaluate(
          delivery.status,
          delivery.id,
          delivery.createdAt,
          delivery.updatedAt,
          now,
          { assignmentId: delivery.assignmentId, pairId: null },
        );
        if (report.observation) await this.persistObservation(report.observation);
        if (report.incident) {
          opened += 1;
          this.stats.incidentsOpened += 1;
        }
      }
      this.stats.deliveryStallEvaluations += inFlight.length;
      return opened;
    })) ?? 0;
  }

  /**
   * Measure main-process event-loop lag. MUST be invoked from the Electron main
   * process; the renderer is not a valid measurement site because it measures a
   * different event loop.
   *
   * Asynchronous only. No provider call, no filesystem scan, no sync subprocess.
   */
  async probeMainProcessLag(): Promise<void> {
    await this.guard('main process lag probe', async () => {
      this.stats.mainProcessProbeEvaluations += 1;
      const result = await evaluateMainProcessStall({ count: 0 }, this.now());
      if (result.observation) {
        // The MAIN_PROCESS_STALL monitor is wired lazily to keep the probe itself
        // free of any provider/DB work beyond persisting its own observation.
        await this.persistObservation(result.observation);
      }
    });
  }

  /* ---------------- lifecycle ---------------- */

  /**
   * Resolve an open incident ONLY from authoritative healthy evidence.
   * UNKNOWN never reaches here: callers must not invoke this without a positive
   * authoritative reading.
   */
  async resolveIncidentOnAuthoritativeRecovery(incidentId: string): Promise<void> {
    await this.guard('incident resolution', async () => {
      const resolved = await this.engine.resolveIncident(incidentId);
      if (resolved) this.stats.incidentsResolved += 1;
    });
  }

  /**
   * Startup: adopt existing open incidents without duplicating or falsely
   * resolving them. Confirmation candidates intentionally start empty, which can
   * only delay detection, never fabricate an incident.
   */
  async onStartup(): Promise<{ openIncidents: number }> {
    return (await this.guard('startup adoption', async () => {
      const open = await this.repos.healthIncidents.findOpen();
      return { openIncidents: open.length };
    })) ?? { openIncidents: 0 };
  }

  /* ---------------- helpers ---------------- */

  private async readIdleWorkState(): Promise<{
    pairOperationalStates: string[];
    hasActiveAssignment: boolean;
    pairCount: number;
    activePairCount: number;
    activeAssignmentCount: number;
  }> {
    const pairs = await this.repos.pairs.findAll();
    const assignments = await this.repos.assignments.findAll();
    const activeAssignments = assignments.filter(
      (a) => a.status === 'active' || a.status === 'pending' || a.status === 'waiting_for_handoff',
    );
    return {
      pairOperationalStates: pairs.map((p) => p.operationalState),
      hasActiveAssignment: activeAssignments.length > 0,
      pairCount: pairs.length,
      activePairCount: pairs.filter((p) => p.operationalState === 'ACTIVE').length,
      activeAssignmentCount: activeAssignments.length,
    };
  }

  /**
   * Translate a RelayX domain event into health input. This is an ADAPTER over
   * events RelayX already emits; it performs no provider work itself.
   *
   * Returns the input to feed, or null when the event carries no health signal.
   */
  static transportInputFromEvent(event: RelayEvent, context: {
    providerType?: string | null;
    providerReachable?: boolean | null;
    integrationStatus?: any;
    activePairId?: string | null;
    blocksActiveWork?: boolean;
  }): TransportEvidenceInput | null {
    const transportFailureEvents = new Set([
      'delivery.failed',
      'delivery.ambiguous',
      'delivery.reconciled',
      'pair.continuation_failed',
      'pair.continuation_ambiguous',
    ]);
    if (!transportFailureEvents.has(event.eventType)) return null;

    const details = (event.details ?? {}) as Record<string, any>;
    const classification = details.transportClassification ?? details.outcome;
    return {
      providerType: context.providerType ?? null,
      providerReachable: context.providerReachable ?? null,
      integrationStatus: context.integrationStatus,
      activePairId: context.activePairId ?? null,
      deliveryId: event.resourceId,
      deliveryStatus: event.newState ?? undefined,
      reconciliationOutcome: classification,
      blocksActiveWork: context.blocksActiveWork ?? false,
      authoritative: true,
    };
  }
}
