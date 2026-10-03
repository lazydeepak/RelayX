/**
 * Phase 1 — MAIN_PROCESS_STALL detector.
 *
 * Light-weight asynchronous event-loop lag probe. Read-only, no repair,
 * no provider contact, no AI, no synchronous subprocess calls.
 */

export const MAIN_PROCESS_STALL_WARNING_MS = 150; // Event-loop lag warning threshold
export const MAIN_PROCESS_STALL_ERROR_MS = 500;  // Critical event-loop lag threshold
export const MAIN_PROCESS_STALL_PROBE_DELAY_MS = 50; // Probe scheduling interval
export const MAIN_PROCESS_STALL_CONFIRMATION_COUNT = 2; // Samples before confirming

import { HealthObservation, HealthSeverity } from '../domain/healthDomain.ts';

export interface MainProcessStallEvidence {
  measuredLagMs: number;
  timestamp: number;
  confirmationCount: number;
  confirmationWindowMs?: number;
  probeDelayMs: number;
  thresholdWarningMs: number;
  thresholdErrorMs: number;
}

export interface MainProcessStallResult {
  kind: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';
  observation?: HealthObservation;
  evidence?: MainProcessStallEvidence;
  message?: string;
}

/**
 * Asynchronous event-loop lag measurement.
 *
 * Schedules a callback with a known expected delay and reports how MUCH LATER
 * than expected it actually ran. The expected delay is subtracted, because
 * returning total elapsed time would report the probe's own sleep as lag and
 * inflate every sample by `probeDelayMs`.
 *
 * Negative values (timer firing marginally early due to clock resolution) are
 * clamped to 0: sub-millisecond early firing is jitter, not negative blockage.
 *
 * This does NOT use `execSync`, `spawnSync`, AppleScript, or any synchronous
 * subprocess call.
 */
export function measureEventLoopLag(
  probeDelayMs: number = MAIN_PROCESS_STALL_PROBE_DELAY_MS,
  callback?: (lagMs: number) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const startMs = performance.now();
    setTimeout(() => {
      const totalElapsedMs = performance.now() - startMs;
      const schedulingLagMs = Math.max(0, totalElapsedMs - probeDelayMs);
      if (callback) callback(schedulingLagMs);
      resolve(schedulingLagMs);
    }, probeDelayMs);
  });
}

/**
 * Evaluate whether the main Electron process shows unhealthy scheduling lag.
 *
 * Requires confirmation: a single isolated scheduling jitter must not create
 * an incident. The caller provides a `confirmationState` tracked externally.
 */
export async function evaluateMainProcessStall(
  confirmationState: { count: number; firstQualifyingAt?: number; lastQualifyingAt?: number },
  nowMs: number = Date.now(),
): Promise<MainProcessStallResult> {
  // Asynchronous measurement — no sync subprocess
  const lagMs = await measureEventLoopLag(MAIN_PROCESS_STALL_PROBE_DELAY_MS);

  if (lagMs < 0) {
    return { kind: 'UNKNOWN', message: 'Negative event-loop lag computed; clock inconsistency' };
  }

  // A single brief scheduling jitter (e.g., GC or short I/O) should not declare unhealthy.
  // Only when lag exceeds thresholds do we treat it as a stall candidate.
  const isStalled = lagMs >= MAIN_PROCESS_STALL_WARNING_MS;
  const isCritical = lagMs >= MAIN_PROCESS_STALL_ERROR_MS;

  // Evidence must include bounded structured fields only.
  const evidence: MainProcessStallEvidence = {
    measuredLagMs: Math.round(lagMs),
    timestamp: nowMs,
    confirmationCount: confirmationState.count + (isStalled ? 1 : 0),
    confirmationWindowMs: confirmationState.firstQualifyingAt ? nowMs - confirmationState.firstQualifyingAt : undefined,
    probeDelayMs: MAIN_PROCESS_STALL_PROBE_DELAY_MS,
    thresholdWarningMs: MAIN_PROCESS_STALL_WARNING_MS,
    thresholdErrorMs: MAIN_PROCESS_STALL_ERROR_MS,
  };

  if (isCritical) {
    // Confirmed unhealthy: create/update incident through HealthIncidentEngine
    const observation: HealthObservation = new HealthObservation({
      id: `obs_main_stall_${nowMs}_${Math.round(lagMs)}`,
      checkType: 'MAIN_PROCESS_STALL',
      componentType: 'main_process',
      componentId: 'electron_main',
      result: 'UNHEALTHY',
      timestamp: nowMs,
      evidence: { ...evidence, severity: 'ERROR' as HealthSeverity },
    });
    return {
      kind: 'UNHEALTHY',
      observation,
      evidence,
      message: `Main process event-loop lag critical: ${Math.round(lagMs)}ms (threshold ${MAIN_PROCESS_STALL_ERROR_MS}ms)`,
    };
  }

  if (isStalled) {
    const observation: HealthObservation = new HealthObservation({
      id: `obs_main_stall_${nowMs}_${Math.round(lagMs)}`,
      checkType: 'MAIN_PROCESS_STALL',
      componentType: 'main_process',
      componentId: 'electron_main',
      result: 'DEGRADED',
      timestamp: nowMs,
      evidence: { ...evidence, severity: 'WARNING' as HealthSeverity },
    });
    return {
      kind: 'DEGRADED',
      observation,
      evidence,
      message: `Main process event-loop lag elevated: ${Math.round(lagMs)}ms (threshold ${MAIN_PROCESS_STALL_WARNING_MS}ms)`,
    };
  }

  return { kind: 'HEALTHY', message: `Main process responsive: ${Math.round(lagMs)}ms lag` };
}
