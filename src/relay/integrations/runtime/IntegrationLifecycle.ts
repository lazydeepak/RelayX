import {
  RelayIntegration,
  IntegrationReadiness,
  IntegrationTestResult,
} from '../types.ts';

export type { IntegrationTestResult };
import { PermissionManager } from './PermissionManager.ts';

export class IntegrationLifecycle {
  /**
   * Performs an in-depth active diagnostic test of an integration.
   */
  public static async testIntegration(
    integration: RelayIntegration,
  ): Promise<IntegrationTestResult> {
    const startTime = Date.now();
    const steps: IntegrationTestResult['steps'] = [];

    // Step 1: Readiness and permissions check
    const step1Start = Date.now();
    let readiness: IntegrationReadiness;
    try {
      readiness = await integration.verify();
      steps.push({
        name: 'Host Binary & Permissions',
        passed: readiness.ok,
        durationMs: Date.now() - step1Start,
        details: readiness.message,
      });
    } catch (err: any) {
      steps.push({
        name: 'Host Binary & Permissions',
        passed: false,
        durationMs: Date.now() - step1Start,
        details: err?.message || 'Verification threw error',
      });
      return {
        ok: false,
        message: `Verification check failed: ${err?.message}`,
        durationMs: Date.now() - startTime,
        steps,
      };
    }

    // Step 2: Launch or readiness check
    const step2Start = Date.now();
    try {
      const launchRes = await integration.launch();
      steps.push({
        name: 'Launch / Activation Probe',
        passed: launchRes.ok,
        durationMs: Date.now() - step2Start,
        details: launchRes.windowTitle ? `Window: ${launchRes.windowTitle}` : 'Process responsive',
      });
    } catch (err: any) {
      steps.push({
        name: 'Launch / Activation Probe',
        passed: false,
        durationMs: Date.now() - step2Start,
        details: err?.message,
      });
    }

    // Step 3: Session creation probe
    const step3Start = Date.now();
    let createdSessionId = '';
    try {
      const createRes = await integration.createSession({
        projectId: 'test_diag_project',
        projectName: 'RelayX Diagnostic Probe',
        projectPath: '/tmp/relayx_test_diag',
        sessionTitle: 'RelayX Self-Test Session',
      });
      createdSessionId = createRes.externalSessionId;
      steps.push({
        name: 'Authoritative Session Creation',
        passed: Boolean(createRes.externalSessionId),
        durationMs: Date.now() - step3Start,
        details: `External session: ${createRes.externalSessionId}`,
      });
    } catch (err: any) {
      steps.push({
        name: 'Authoritative Session Creation',
        passed: false,
        durationMs: Date.now() - step3Start,
        details: err?.message,
      });
    }

    // Step 4: Observation and inspection probe
    if (createdSessionId) {
      const step4Start = Date.now();
      try {
        const inspectRes = await integration.inspectSession({
          externalSessionId: createdSessionId,
        });
        steps.push({
          name: 'Session Observation & Status',
          passed: inspectRes.found,
          durationMs: Date.now() - step4Start,
          details: `Observed status: ${inspectRes.status}, PID: ${inspectRes.applicationPid ?? 'Running'}`,
        });
      } catch (err: any) {
        steps.push({
          name: 'Session Observation & Status',
          passed: false,
          durationMs: Date.now() - step4Start,
          details: err?.message,
        });
      }
    }

    const allPassed = steps.every((s) => s.passed);
    return {
      ok: allPassed,
      message: allPassed
        ? `Integration "${integration.name}" successfully passed all diagnostic checks`
        : `Diagnostic checks completed with warnings or failures`,
      durationMs: Date.now() - startTime,
      steps,
    };
  }
}
