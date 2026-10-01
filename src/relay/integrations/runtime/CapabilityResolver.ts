import {
  IntegrationCapability,
  IntegrationManifest,
  RelayIntegration,
  AppRole,
} from '../types.ts';

export class CapabilityResolver {
  /**
   * Evaluates if a given integration or manifest satisfies a required capability.
   */
  public static hasCapability(
    target: RelayIntegration | IntegrationManifest,
    capability: IntegrationCapability,
  ): boolean {
    const manifest = 'getManifest' in target ? target.getManifest() : target;
    if (manifest.capabilities && manifest.capabilities.includes(capability)) {
      return true;
    }

    // Also check backwards-compatible capabilities object on config if present
    if ('config' in target && (target as any).config?.capabilities) {
      const caps = (target as any).config.capabilities;
      switch (capability) {
        case 'APP_LAUNCH':
        case 'APP_ACTIVATE':
          return Boolean(caps.discoverProjects || caps.createSession || (target as any).config.appPath);
        case 'PROJECT_OPEN':
        case 'PROJECT_VERIFY':
          return Boolean(caps.discoverProjects);
        case 'SESSION_DISCOVER':
          return Boolean(caps.discoverSessions);
        case 'SESSION_CREATE':
          return Boolean(caps.createSession);
        case 'SESSION_RENAME':
          return Boolean(caps.createSession);
        case 'SESSION_ACTIVATE':
        case 'SESSION_VERIFY':
          return Boolean(caps.reconcileExactSession || caps.discoverSessions);
        case 'MESSAGE_SEND':
          return Boolean(caps.dispatchInstruction);
        case 'MESSAGE_OBSERVE':
        case 'RESPONSE_DETECT':
          return Boolean(caps.extractResponse || caps.observeCompletion);
        case 'COMPLETION_DETECT':
          return Boolean(caps.observeCompletion);
        case 'MODEL_SELECT':
        case 'MODEL_VERIFY':
          return Boolean((manifest.supportedModels && manifest.supportedModels.length > 0) || caps.dispatchInstruction);
      }
    }

    return false;
  }

  /**
   * Filters integrations that satisfy all given criteria.
   */
  public static filterMatching(
    integrations: RelayIntegration[],
    criteria: {
      role?: AppRole;
      capabilities?: IntegrationCapability[];
      mustBeEnabled?: boolean;
    },
  ): RelayIntegration[] {
    return integrations.filter((integration) => {
      if (criteria.mustBeEnabled !== false && !integration.config.isEnabled) {
        return false;
      }
      if (criteria.role) {
        const matchesRole =
          criteria.role === 'both'
            ? true
            : integration.roles.includes(criteria.role) || integration.roles.includes('both');
        if (!matchesRole) return false;
      }
      if (criteria.capabilities && criteria.capabilities.length > 0) {
        for (const cap of criteria.capabilities) {
          if (!CapabilityResolver.hasCapability(integration, cap)) {
            return false;
          }
        }
      }
      return true;
    });
  }

  /**
   * Derives default capabilities array from config or adapter type.
   */
  public static deriveDefaultCapabilities(role: AppRole): IntegrationCapability[] {
    const common: IntegrationCapability[] = [
      'APP_LAUNCH',
      'APP_ACTIVATE',
      'SESSION_CREATE',
      'MESSAGE_SEND',
      'MESSAGE_OBSERVE',
      'COMPLETION_DETECT',
    ];
    if (role === 'planner' || role === 'both') {
      common.push('PROJECT_VERIFY', 'SESSION_VERIFY', 'MODEL_SELECT');
    }
    if (role === 'worker' || role === 'both') {
      common.push('PROJECT_OPEN', 'SESSION_DISCOVER', 'SESSION_RENAME', 'RESPONSE_DETECT');
    }
    return Array.from(new Set(common));
  }
}
