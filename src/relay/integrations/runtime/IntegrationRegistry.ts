import {
  AppIntegrationConfig,
  AppRole,
  IntegrationCapability,
  ProjectIntegrationOverride,
  RelayIntegration,
} from '../types.ts';
import { CapabilityResolver } from './CapabilityResolver.ts';
import { IRelayRepositories } from '../../persistence/interfaces.ts';

const SETTINGS_KEY = 'relayx_integrations_registry_v1';
const PROJECT_OVERRIDES_KEY = 'relayx_project_integration_overrides_v1';

export class IntegrationRegistry {
  private integrations = new Map<string, RelayIntegration>();
  private projectOverrides = new Map<string, ProjectIntegrationOverride>();
  private repos?: IRelayRepositories;
  private initialized = false;

  constructor(repos?: IRelayRepositories) {
    this.repos = repos;
  }

  public register(integration: RelayIntegration): void {
    this.integrations.set(integration.id, integration);
  }

  public unregister(id: string): boolean {
    return this.integrations.delete(id);
  }

  public get(id: string): RelayIntegration | undefined {
    return this.integrations.get(id);
  }

  public list(): RelayIntegration[] {
    return Array.from(this.integrations.values());
  }

  public listConfigs(): AppIntegrationConfig[] {
    return this.list().map((i) => i.config);
  }

  public async setProjectOverride(
    projectId: string,
    override: { plannerIntegrationId?: string | null; workerIntegrationId?: string | null },
  ): Promise<ProjectIntegrationOverride> {
    const existing = this.projectOverrides.get(projectId) || { projectId };
    const updated: ProjectIntegrationOverride = {
      projectId,
      plannerIntegrationId:
        override.plannerIntegrationId !== undefined
          ? override.plannerIntegrationId
          : existing.plannerIntegrationId,
      workerIntegrationId:
        override.workerIntegrationId !== undefined
          ? override.workerIntegrationId
          : existing.workerIntegrationId,
      updatedAt: Date.now(),
    };
    this.projectOverrides.set(projectId, updated);
    await this.persist();
    return updated;
  }

  public getProjectOverride(projectId: string): ProjectIntegrationOverride | undefined {
    return this.projectOverrides.get(projectId);
  }

  public listProjectOverrides(): ProjectIntegrationOverride[] {
    return Array.from(this.projectOverrides.values());
  }

  /**
   * Resolves the effective integration for a given role and project.
   * Hierarchy:
   *   1. Project override (if set, enabled, and meets capability)
   *   2. Global default for role
   *   3. Any enabled integration for role
   *   4. Error if unresolvable
   */
  public resolve(
    role: AppRole,
    options: {
      projectId?: string;
      capability?: IntegrationCapability;
    } = {},
  ): RelayIntegration {
    this.ensureInvariants();

    // 1. Project Override
    if (options.projectId) {
      const override = this.projectOverrides.get(options.projectId);
      const targetId =
        role === 'planner'
          ? override?.plannerIntegrationId
          : role === 'worker'
          ? override?.workerIntegrationId
          : override?.plannerIntegrationId || override?.workerIntegrationId;

      if (targetId) {
        const candidate = this.integrations.get(targetId);
        if (candidate && candidate.config.isEnabled) {
          if (!options.capability || CapabilityResolver.hasCapability(candidate, options.capability)) {
            return candidate;
          }
        }
      }
    }

    // 2. Global Default
    const defaultCandidate = Array.from(this.integrations.values()).find((i) => {
      if (!i.config.isEnabled) return false;
      if (role === 'planner') return i.config.isDefaultPlanner;
      if (role === 'worker') return i.config.isDefaultWorker;
      return i.config.isDefaultPlanner || i.config.isDefaultWorker;
    });

    if (defaultCandidate) {
      if (!options.capability || CapabilityResolver.hasCapability(defaultCandidate, options.capability)) {
        return defaultCandidate;
      }
    }

    // 3. Any enabled matching integration
    const matching = CapabilityResolver.filterMatching(Array.from(this.integrations.values()), {
      role,
      capabilities: options.capability ? [options.capability] : undefined,
      mustBeEnabled: true,
    });

    if (matching.length > 0) {
      return matching[0];
    }

    throw new Error(
      `No usable ${role} integration found${options.capability ? ` with capability "${options.capability}"` : ''}${options.projectId ? ` for project ${options.projectId}` : ''}. Please enable or configure a ${role} integration.`,
    );
  }

  public getDefault(role: AppRole): RelayIntegration {
    return this.resolve(role);
  }

  public ensureInvariants(): void {
    const list = this.list().map((i) => i.config);
    if (list.length === 0) return;

    // Ensure at least one default planner
    let defaultPlanner = list.find((c) => c.isEnabled && c.isDefaultPlanner && (c.role === 'planner' || c.role === 'both'));
    if (!defaultPlanner) {
      const anyPlanner = list.find((c) => c.isEnabled && (c.role === 'planner' || c.role === 'both'));
      if (anyPlanner) {
        anyPlanner.isDefaultPlanner = true;
        defaultPlanner = anyPlanner;
      } else {
        const first = list.find((c) => c.role === 'planner' || c.role === 'both');
        if (first) {
          first.isEnabled = true;
          first.isDefaultPlanner = true;
          defaultPlanner = first;
        }
      }
    }

    // Ensure exactly one default planner
    for (const c of list) {
      if (c.id !== defaultPlanner?.id) {
        c.isDefaultPlanner = false;
      }
    }

    // Ensure at least one default worker
    let defaultWorker = list.find((c) => c.isEnabled && c.isDefaultWorker && (c.role === 'worker' || c.role === 'both'));
    if (!defaultWorker) {
      const anyWorker = list.find((c) => c.isEnabled && (c.role === 'worker' || c.role === 'both'));
      if (anyWorker) {
        anyWorker.isDefaultWorker = true;
        defaultWorker = anyWorker;
      } else {
        const first = list.find((c) => c.role === 'worker' || c.role === 'both');
        if (first) {
          first.isEnabled = true;
          first.isDefaultWorker = true;
          defaultWorker = first;
        }
      }
    }

    // Ensure exactly one default worker
    for (const c of list) {
      if (c.id !== defaultWorker?.id) {
        c.isDefaultWorker = false;
      }
    }
  }

  public async persist(): Promise<void> {
    if (!this.repos?.providerSettings) return;
    try {
      const configs = this.listConfigs();
      const now = Date.now();
      await this.repos.providerSettings.save({
        key: SETTINGS_KEY,
        value: JSON.stringify(configs),
        note: 'IntegrationRegistry configured integrations',
        setBy: 'system',
        createdAt: now,
        updatedAt: now,
      });

      const overrides = Array.from(this.projectOverrides.values());
      await this.repos.providerSettings.save({
        key: PROJECT_OVERRIDES_KEY,
        value: JSON.stringify(overrides),
        note: 'IntegrationRegistry project integration overrides',
        setBy: 'system',
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      console.warn('[IntegrationRegistry] Persist error:', err);
    }
  }

  public async loadPersisted(): Promise<{
    configs: AppIntegrationConfig[] | null;
    overrides: ProjectIntegrationOverride[] | null;
  }> {
    if (!this.repos?.providerSettings) return { configs: null, overrides: null };
    try {
      const setting = await this.repos.providerSettings.get(SETTINGS_KEY);
      const configs = setting ? JSON.parse(setting.value) : null;

      const overrideSetting = await this.repos.providerSettings.get(PROJECT_OVERRIDES_KEY);
      const overrides = overrideSetting ? JSON.parse(overrideSetting.value) : null;

      if (Array.isArray(overrides)) {
        for (const item of overrides) {
          if (item?.projectId) {
            this.projectOverrides.set(item.projectId, item);
          }
        }
      }

      return { configs, overrides };
    } catch {
      return { configs: null, overrides: null };
    }
  }
}
