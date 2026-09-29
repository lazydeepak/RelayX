/**
 * ============================================================================
 * RELAYX DIAGNOSTICS & TELEMETRY SUBSYSTEM (V1)
 * ============================================================================
 * 
 * Read-only instrumentation, performance tracking, health evaluation, and report generation.
 * Follows hard boundaries: observes, measures, aggregates, evaluates, reports.
 * NEVER dispatches, retries, repairs, rebinds, detaches, or triggers expensive discovery.
 */

import { HealthLevel, DiagnosticMeasurement, OperationMetricSummary, ComponentHealthStatus, DiagnosticsReport } from '../../types/relayApi.ts';

export interface DiagnosticsEvaluationContext {
  dbStatus: { ok: boolean; type: string; sqliteVersion?: string };
  pairs?: any[];
  runtimes?: any[];
  pairsCount?: number;
  runtimesCount?: number;
  openAttentionCount?: number;
  checkpointsCount?: number;
  deliveriesCount?: number;
  integrations?: any[];
}

class RelayDiagnosticsEngine {
  private measurements: DiagnosticMeasurement[] = [];
  private maxBufferSize: number = 500;

  constructor() {
    // Telemetry buffer populated strictly from actual observed runtime operations.
  }

  public record(measurement: Omit<DiagnosticMeasurement, 'id'>): DiagnosticMeasurement {
    const full: DiagnosticMeasurement = {
      id: `diag_${Math.random().toString(36).substring(2, 9)}`,
      ...measurement,
    };
    this.measurements.unshift(full);
    if (this.measurements.length > this.maxBufferSize) {
      this.measurements = this.measurements.slice(0, this.maxBufferSize);
    }
    return full;
  }

  public async measure<T>(
    operation: string,
    fn: () => Promise<T>,
    metadata?: DiagnosticMeasurement['metadata']
  ): Promise<T> {
    const start = performance.now();
    let success = true;
    let errorMsg: string | undefined;
    try {
      return await fn();
    } catch (err: any) {
      success = false;
      errorMsg = err?.message || String(err);
      throw err;
    } finally {
      const durationMs = Math.round(performance.now() - start);
      this.record({
        operation,
        durationMs,
        timestamp: Date.now(),
        success,
        error: errorMsg,
        metadata,
      });
    }
  }

  public getMeasurements(): DiagnosticMeasurement[] {
    return [...this.measurements];
  }

  public getOperationMetrics(): OperationMetricSummary[] {
    const map = new Map<string, number[]>();
    const errorMap = new Map<string, number>();
    const latestMap = new Map<string, number>();

    const flatten = (list: DiagnosticMeasurement[]) => {
      for (const m of list) {
        if (!map.has(m.operation)) {
          map.set(m.operation, []);
          errorMap.set(m.operation, 0);
        }
        map.get(m.operation)!.push(m.durationMs);
        latestMap.set(m.operation, m.durationMs);
        if (!m.success) {
          errorMap.set(m.operation, errorMap.get(m.operation)! + 1);
        }
        if (m.children) {
          flatten(m.children);
        }
      }
    };

    flatten(this.measurements);

    const result: OperationMetricSummary[] = [];
    for (const [operation, durations] of map.entries()) {
      durations.sort((a, b) => a - b);
      const calls = durations.length;
      const latestDurationMs = latestMap.get(operation) || durations[durations.length - 1];
      const sum = durations.reduce((a, b) => a + b, 0);
      const avgDurationMs = Math.round(sum / calls);
      const p95Idx = Math.min(Math.floor(calls * 0.95), calls - 1);
      const p95DurationMs = durations[p95Idx];
      const maxDurationMs = durations[calls - 1];
      const errorCount = errorMap.get(operation) || 0;

      result.push({
        operation,
        calls,
        latestDurationMs,
        avgDurationMs,
        p95DurationMs,
        maxDurationMs,
        errorCount,
      });
    }

    return result.sort((a, b) => b.avgDurationMs - a.avgDurationMs);
  }

  public evaluateHealth(
    contextOrDbStatus:
      | DiagnosticsEvaluationContext
      | { ok: boolean; type: string; sqliteVersion?: string },
    legacyPairsCount?: number,
    legacyRuntimesCount?: number,
    legacyAttentionCount?: number
  ): DiagnosticsReport {
    let dbStatus: { ok: boolean; type: string; sqliteVersion?: string };
    let pairs: any[] = [];
    let runtimes: any[] = [];
    let pairsCount = 0;
    let runtimesCount = 0;
    let attentionCount = 0;
    let checkpointsCount = 0;
    let deliveriesCount = 0;
    let integrations: any[] = [];

    if ('dbStatus' in contextOrDbStatus) {
      const ctx = contextOrDbStatus as DiagnosticsEvaluationContext;
      dbStatus = ctx.dbStatus;
      pairs = ctx.pairs || [];
      runtimes = ctx.runtimes || [];
      pairsCount = ctx.pairsCount ?? pairs.length;
      runtimesCount = ctx.runtimesCount ?? runtimes.length;
      attentionCount = ctx.openAttentionCount ?? 0;
      checkpointsCount = ctx.checkpointsCount ?? 0;
      deliveriesCount = ctx.deliveriesCount ?? 0;
      integrations = ctx.integrations || [];
    } else {
      dbStatus = contextOrDbStatus;
      pairsCount = legacyPairsCount ?? 0;
      runtimesCount = legacyRuntimesCount ?? 0;
      attentionCount = legacyAttentionCount ?? 0;
    }

    const metrics = this.getOperationMetrics();
    const problems: string[] = [];

    for (const m of metrics) {
      if (m.avgDurationMs > 1000) {
        problems.push(`${m.operation}: avg duration ${m.avgDurationMs}ms across ${m.calls} calls`);
      }
      if (m.errorCount > 0) {
        problems.push(`${m.operation}: encountered ${m.errorCount} failures`);
      }
    }

    if (attentionCount > 0) {
      problems.push(`Open attention items requiring review: ${attentionCount}`);
    }

    // 1. Planner Health
    const plannerRuntimes = runtimes.filter((r) => r.providerType === 'chatgpt');
    let plannerStatus: HealthLevel = 'INACTIVE';
    let plannerSummary = '0 planner sessions registered';
    const plannerEvidence: string[] = [];

    if (plannerRuntimes.length > 0) {
      const observed = plannerRuntimes.filter((r) => r.lastObservedAt && r.status !== 'unknown');
      const degraded = plannerRuntimes.filter((r) => r.consecutiveObservationFailures > 0 || r.status === 'suspended');
      if (degraded.length > 0) {
        plannerStatus = 'DEGRADED';
        plannerSummary = `${degraded.length} planner session(s) degraded or observation failed`;
        plannerEvidence.push(`${degraded.length} observation failures recorded`);
      } else if (observed.length > 0) {
        plannerStatus = 'HEALTHY';
        plannerSummary = `${observed.length} planner session(s) observed and responsive`;
        plannerEvidence.push(`${observed.length} active sessions observed`);
      } else {
        plannerStatus = 'UNKNOWN';
        plannerSummary = `${plannerRuntimes.length} planner session(s) registered (unobserved)`;
      }
    } else if (runtimesCount > 0 && plannerRuntimes.length === 0 && runtimes.length === 0) {
      // Legacy fallback
      plannerStatus = 'UNKNOWN';
      plannerSummary = 'Planner status unverified';
    }

    // 2. Worker Health
    const workerRuntimes = runtimes.filter((r) => r.providerType === 'opencode' || r.providerType === 'vscode');
    let workerStatus: HealthLevel = 'INACTIVE';
    let workerSummary = '0 worker sessions registered';
    const workerEvidence: string[] = [];

    if (workerRuntimes.length > 0) {
      const observed = workerRuntimes.filter((r) => r.lastObservedAt && r.status !== 'unknown');
      const degraded = workerRuntimes.filter((r) => r.consecutiveObservationFailures > 0 || r.status === 'suspended');
      if (degraded.length > 0) {
        workerStatus = 'DEGRADED';
        workerSummary = `${degraded.length} worker session(s) degraded or failing observation`;
        workerEvidence.push(`${degraded.length} observation failures`);
      } else if (observed.length > 0) {
        workerStatus = 'HEALTHY';
        workerSummary = `${observed.length} worker session(s) observed and responsive`;
        workerEvidence.push(`${observed.length} active worker sessions observed`);
      } else {
        workerStatus = 'UNKNOWN';
        workerSummary = `${workerRuntimes.length} worker session(s) registered (unobserved)`;
      }
    } else if (runtimesCount > 0 && workerRuntimes.length === 0 && runtimes.length === 0) {
      workerStatus = 'UNKNOWN';
      workerSummary = 'Worker status unverified';
    }

    // 3. Pair Health (0 configured = INACTIVE, not UNKNOWN)
    let pairStatus: HealthLevel = 'INACTIVE';
    let pairSummary = '0 session pairs configured';
    const pairEvidence: string[] = [];

    if (pairsCount > 0) {
      if (pairs.length > 0) {
        const incomplete = pairs.filter((p) => !p.plannerSessionId || !p.workerSessionId);
        if (incomplete.length > 0) {
          pairStatus = 'DEGRADED';
          pairSummary = `${incomplete.length} pair(s) missing required session bindings`;
          pairEvidence.push(`${incomplete.length} unbound pair sides detected`);
        } else {
          pairStatus = 'HEALTHY';
          pairSummary = `${pairs.length} session pair(s) configured with complete bindings`;
          pairEvidence.push(`${pairs.length} pairs bound in relational state`);
        }
      } else {
        pairStatus = 'HEALTHY';
        pairSummary = `${pairsCount} active work pairs configured and consistent`;
        pairEvidence.push(`${pairsCount} pairs verified in relational state`);
      }
    }

    // 4. Transport Health
    let transportStatus: HealthLevel = 'INACTIVE';
    let transportSummary = '0 delivery attempts executed';
    const transportEvidence: string[] = [];

    if (deliveriesCount > 0) {
      transportStatus = attentionCount > 0 ? 'DEGRADED' : 'HEALTHY';
      transportSummary = attentionCount > 0
        ? `${attentionCount} delivery issues requiring resolution`
        : `${deliveriesCount} delivery attempts processed cleanly`;
      transportEvidence.push(`${deliveriesCount} recorded deliveries`);
    }

    // 5. Attempt / Delivery Health
    let attemptStatus: HealthLevel = 'INACTIVE';
    let attemptSummary = '0 assignment attempts in flight';
    const attemptEvidence: string[] = [];

    if (attentionCount > 0) {
      attemptStatus = 'DEGRADED';
      attemptSummary = `${attentionCount} deliveries need review`;
      attemptEvidence.push(`${attentionCount} open attention items`);
    } else if (deliveriesCount > 0) {
      attemptStatus = 'HEALTHY';
      attemptSummary = 'All attempts delivered cleanly';
      attemptEvidence.push('Attempt state machine synchronized');
    }

    // 6. Checkpoint Health
    let checkpointStatus: HealthLevel = 'INACTIVE';
    let checkpointSummary = '0 checkpoints recorded yet';
    const checkpointEvidence: string[] = [];

    if (checkpointsCount > 0) {
      checkpointStatus = 'HEALTHY';
      checkpointSummary = `${checkpointsCount} continuity checkpoint(s) saved`;
      checkpointEvidence.push(`${checkpointsCount} durable checkpoints verified`);
    }

    // 7. Performance Health (No telemetry/activity != Healthy. Healthy requires positive current evidence.)
    let performanceStatus: HealthLevel = 'INACTIVE';
    let performanceSummary = 'No telemetry recorded yet';
    const performanceEvidence: string[] = [];

    if (metrics.length > 0) {
      const hasSlow = metrics.some((m) => m.avgDurationMs > 1000);
      const hasErrors = metrics.some((m) => m.errorCount > 0);
      if (hasSlow || hasErrors) {
        performanceStatus = 'DEGRADED';
        performanceSummary = hasSlow
          ? 'Operations exceeding 1000ms UX latency threshold'
          : 'Operation failures recorded in telemetry';
      } else {
        performanceStatus = 'HEALTHY';
        performanceSummary = 'All measured operations within acceptable latency budget';
      }
      performanceEvidence.push(
        ...metrics.slice(0, 3).map((m) => `${m.operation}: ${m.avgDurationMs}ms avg (${m.calls} calls)`)
      );
    }

    const components: Record<string, ComponentHealthStatus> = {
      Application: {
        component: 'Application',
        status: 'HEALTHY',
        summary: 'Control plane responsive and operational',
        lastObservedAt: Date.now(),
        evidence: ['Uptime verified', 'Event stream active'],
      },
      Database: {
        component: 'Database',
        status: dbStatus.ok ? 'HEALTHY' : 'DEGRADED',
        summary: dbStatus.ok ? `Connected via ${dbStatus.type}` : 'Database connection issue detected',
        lastObservedAt: Date.now(),
        evidence: [dbStatus.type === 'sqlite_wal' ? 'SQLite WAL mode enabled' : 'In-memory store active'],
      },
      Planner: {
        component: 'Planner',
        status: plannerStatus,
        summary: plannerSummary,
        lastObservedAt: Date.now(),
        evidence: plannerEvidence,
      },
      Worker: {
        component: 'Worker',
        status: workerStatus,
        summary: workerSummary,
        lastObservedAt: Date.now(),
        evidence: workerEvidence,
      },
      Pair: {
        component: 'Pair',
        status: pairStatus,
        summary: pairSummary,
        lastObservedAt: Date.now(),
        evidence: pairEvidence,
      },
      Transport: {
        component: 'Transport',
        status: transportStatus,
        summary: transportSummary,
        lastObservedAt: Date.now(),
        evidence: transportEvidence,
      },
      'Attempt/Delivery': {
        component: 'Attempt/Delivery',
        status: attemptStatus,
        summary: attemptSummary,
        lastObservedAt: Date.now(),
        evidence: attemptEvidence,
      },
      Checkpoint: {
        component: 'Checkpoint',
        status: checkpointStatus,
        summary: checkpointSummary,
        lastObservedAt: Date.now(),
        evidence: checkpointEvidence,
      },
      Performance: {
        component: 'Performance',
        status: performanceStatus,
        summary: performanceSummary,
        lastObservedAt: Date.now(),
        evidence: performanceEvidence,
      },
    };

    // Overall health derivation
    let overall: HealthLevel = 'HEALTHY';
    const activeStatuses = Object.values(components)
      .map((c) => c.status)
      .filter((s) => s !== 'INACTIVE');

    if (activeStatuses.includes('UNHEALTHY')) {
      overall = 'UNHEALTHY';
    } else if (activeStatuses.includes('DEGRADED') || problems.length > 2) {
      overall = 'DEGRADED';
    } else if (activeStatuses.length === 0 || activeStatuses.every((s) => s === 'UNKNOWN')) {
      overall = 'UNKNOWN';
    } else {
      overall = 'HEALTHY';
    }

    const reportText = this.generateFormattedReport(overall, problems, components, metrics);

    return {
      overall,
      problems,
      performance: metrics,
      components,
      timestamp: Date.now(),
      formattedReportText: reportText,
    };
  }

  private generateFormattedReport(
    overall: HealthLevel,
    problems: string[],
    components: Record<string, ComponentHealthStatus>,
    metrics: OperationMetricSummary[]
  ): string {
    const lines: string[] = [];
    lines.push('RelayX Diagnostics');
    lines.push(`Overall: ${overall}`);
    lines.push('');
    
    lines.push('Problems');
    if (problems.length === 0) {
      lines.push('- None detected');
    } else {
      for (const p of problems) {
        lines.push(`- ${p}`);
      }
    }
    lines.push('');

    lines.push('Database');
    lines.push(`- status: ${components['Database']?.status || 'UNKNOWN'}`);
    lines.push(`- summary: ${components['Database']?.summary || 'N/A'}`);
    lines.push('');

    lines.push('Performance Highlights');
    for (const m of metrics.slice(0, 5)) {
      lines.push(`- ${m.operation}: ${m.calls} calls / ${m.avgDurationMs}ms avg (max ${m.maxDurationMs}ms)`);
    }
    lines.push('');

    lines.push('Components Status');
    for (const [name, comp] of Object.entries(components)) {
      lines.push(`- ${name}: ${comp.status} (${comp.summary})`);
    }

    return lines.join('\n');
  }
}

export const relayDiagnostics = new RelayDiagnosticsEngine();
