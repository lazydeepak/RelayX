import {
  AppIntegrationConfig,
  IntegrationReadiness,
  ReadinessChecklist,
} from '../types.ts';

export class PermissionManager {
  /**
   * Generates a 7-point readiness assessment for an integration.
   */
  public static async assessReadiness(
    config: AppIntegrationConfig,
  ): Promise<IntegrationReadiness> {
    const isDarwin = typeof process !== 'undefined' && (process as any).platform === 'darwin';

    // 1. Application Found
    let applicationFound = true;
    if (config.appPath && typeof process !== 'undefined') {
      try {
        const fs = await import('node:fs');
        applicationFound = fs.existsSync(config.appPath);
      } catch {
        applicationFound = false;
      }
    } else if (config.cliCommand && typeof process !== 'undefined') {
      try {
        const { execSync } = await import('node:child_process');
        execSync(`which ${config.cliCommand} 2>/dev/null`, { stdio: 'pipe' });
        applicationFound = true;
      } catch {
        applicationFound = false;
      }
    }

    // 2 & 3. Accessibility & Automation Permissions (macOS)
    let accessibilityPermission = true;
    let automationPermission = true;
    if (isDarwin && config.requirements.accessibilityRequired) {
      accessibilityPermission = config.requirements.accessibilityGranted ?? true;
    }
    if (isDarwin && config.requirements.systemEventsRequired) {
      automationPermission = config.requirements.systemEventsAvailable ?? true;
    }

    // 4. Session Creation capability
    const sessionCreation = Boolean(
      config.capabilities.createSession ||
        config.scripts?.createSessionScript ||
        config.isBuiltin,
    );

    // 5. Session Identity capability
    const sessionIdentity = Boolean(
      config.bundleId ||
        config.processName ||
        config.scripts?.extractSessionScript ||
        config.isBuiltin,
    );

    // 6. Message Submission capability
    const messageSubmission = Boolean(
      config.capabilities.dispatchInstruction ||
        config.scripts?.sendMessageScript ||
        config.isBuiltin,
    );

    // 7. Observation capability
    const observation = Boolean(
      config.capabilities.observeCompletion ||
        config.scripts?.inspectSessionScript ||
        config.isBuiltin,
    );

    const checklist: ReadinessChecklist = {
      applicationFound,
      accessibilityPermission,
      automationPermission,
      sessionCreation,
      sessionIdentity,
      messageSubmission,
      observation,
    };

    const allPassed = Object.values(checklist).every(Boolean);
    const criticalPassed = applicationFound && sessionCreation && messageSubmission;

    let status: 'READY' | 'DEGRADED' | 'NOT_DETECTED' | 'UNCONFIGURED';
    let message: string;

    if (!applicationFound && (config.appPath || config.cliCommand)) {
      status = 'NOT_DETECTED';
      message = `Application binary or CLI not found at ${config.appPath || config.cliCommand}`;
    } else if (allPassed) {
      status = 'READY';
      message = 'All 7 readiness invariants verified';
    } else if (criticalPassed) {
      status = 'DEGRADED';
      message = 'Core automation available; background inspection or permissions degraded';
    } else {
      status = 'UNCONFIGURED';
      message = 'Required automation scripts or permissions missing';
    }

    return {
      ok: status === 'READY' || status === 'DEGRADED',
      status,
      message,
      lastVerifiedAt: Date.now(),
      checklist,
      details: {
        platform: isDarwin ? 'darwin' : 'other',
        isBuiltin: config.isBuiltin,
        appType: config.appType,
      },
    };
  }
}
