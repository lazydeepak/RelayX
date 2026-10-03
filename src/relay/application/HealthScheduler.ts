/**
 * Phase 1 — the ONE health scheduler.
 *
 * Explicit design constraint: the health system gets exactly ONE timer for the
 * whole application. Detectors never own timers.
 *
 * Two cadences, both deliberately conservative:
 *
 *   delivery stall sweep — piggybacks RelayX's EXISTING supervision loop. No new
 *     timer at all. `attachToSupervision()` is the intended entry point.
 *
 *   main-process lag probe — needs an idle-period measurement, and no existing
 *     cadence measures main-process event-loop lag, so this is the one permitted
 *     dedicated heartbeat. It is a single `setTimeout` chain (never
 *     `setInterval`, so a slow probe can never queue up behind itself),
 *     `unref()`ed so it can never hold the process open, and it performs no
 *     provider call, no filesystem scan, and no sync subprocess.
 *
 * Health policy: 60s. Long enough that a healthy idle RelayX spends a
 * negligible fraction of its time here, and short enough that a genuine
 * multi-second UI freeze is caught within a minute.
 */
import { HealthRuntimeCoordinator } from './HealthRuntimeCoordinator.ts';

export const HEALTH_HEARTBEAT_INTERVAL_MS = 60_000;

export interface HealthSchedulerOptions {
  coordinator: HealthRuntimeCoordinator;
  intervalMs?: number;
  logger?: { warn: (...a: unknown[]) => void };
}

export class HealthScheduler {
  private readonly coordinator: HealthRuntimeCoordinator;
  private readonly intervalMs: number;
  private readonly logger: { warn: (...a: unknown[]) => void };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticks = 0;

  constructor(opts: HealthSchedulerOptions) {
    this.coordinator = opts.coordinator;
    this.intervalMs = opts.intervalMs ?? HEALTH_HEARTBEAT_INTERVAL_MS;
    this.logger = opts.logger ?? console;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  getTicks(): number {
    return this.ticks;
  }

  /**
   * Start the single health heartbeat.
   *
   * The lag probe MUST run in the Electron main process; a renderer-side probe
   * would measure the renderer event loop and report a healthy main process as
   * stalled (or the reverse).
   */
  start(): void {
    if (this.timer) return;
    const schedule = () => {
      this.timer = setTimeout(async () => {
        this.timer = null;
        await this.tick();
        if (this.running) schedule();
      }, this.intervalMs);

      // Never keep the process alive for monitoring alone.
      const t = this.timer as unknown as { unref?: () => void };
      if (typeof t?.unref === 'function') t.unref();
    };
    this.running = true;
    schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * One heartbeat. Failures are contained: a health tick that throws must never
   * disturb RelayX execution.
   */
  async tick(): Promise<void> {
    this.ticks += 1;
    try {
      // Only the main-process lag probe lives here. The delivery-stall sweep rides
      // RelayX's supervision cadence, so this heartbeat stays a single cheap
      // measurement with no database work at all.
      await this.coordinator.probeMainProcessLag();
    } catch (err: any) {
      this.logger.warn('[health] heartbeat tick failed (monitoring only):', err?.message ?? err);
    }
  }
}

/**
 * Reuse RelayX's EXISTING supervision loop for the time-based delivery check
 * instead of adding another timer.
 *
 * `supervisionTick` is wrapped, not replaced: RelayX's own supervision behaviour
 * runs first and unchanged, and the delivery-stall sweep runs afterwards, is
 * self-throttled to the health policy cadence, and can never delay or fail the
 * supervision tick it rides on. Returns a disposer so the caller keeps full
 * control of the loop lifetime.
 */
/**
 * Build the throttled delivery-stall sweep that rides RelayX's EXISTING
 * supervision cadence.
 *
 * This deliberately does NOT wrap or re-run supervision: the supervision loop
 * already owns its interval, and health is handed only a sweep callback to invoke
 * after it. `sweepIfDue()` is therefore the single integration point, and it is a
 * no-op until the health cadence has elapsed — so the existing 5s supervision loop
 * costs at most one indexed `findUnresolved()` per health interval.
 *
 * Failures are contained inside the coordinator, so a sweep problem can never
 * disturb supervision.
 */
export function withHealthDeliverySweep(
  coordinator: HealthRuntimeCoordinator,
  now: () => number = () => Date.now(),
  sweepIntervalMs: number = HEALTH_HEARTBEAT_INTERVAL_MS,
): { sweepIfDue: () => Promise<number>; sweepNow: () => Promise<number>; sweeps: () => number } {
  let lastSweepAt = 0;
  let sweepCount = 0;

  const sweepNow = async (): Promise<number> => {
    lastSweepAt = now();
    sweepCount += 1;
    // Containment lives HERE as well as inside the coordinator: this sweep is
    // invoked from the supervision loop, so a monitoring failure must never
    // propagate into supervision even if the coordinator's own guard is bypassed.
    try {
      return await coordinator.evaluateStalledDeliveries();
    } catch (err: any) {
      console.warn('[health] delivery-stall sweep failed (monitoring only, supervision unaffected):', err?.message ?? err);
      return 0;
    }
  };

  const sweepIfDue = async (): Promise<number> => {
    if (now() - lastSweepAt < sweepIntervalMs) return 0;
    return sweepNow();
  };

  return { sweepIfDue, sweepNow, sweeps: () => sweepCount };
}
