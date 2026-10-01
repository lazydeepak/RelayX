import { IRelayRepositories } from '../persistence/interfaces.ts';
import { RelayEngine } from '../application/RelayEngine.ts';
import {
  AppIntegrationConfig,
  IAppIntegrationHandler,
  AppRole,
  IntegrationCapability,
  RelayIntegration,
  ProjectIntegrationOverride,
} from './types.ts';
import { ChatGPTAppHandler } from './handlers/ChatGPTAppHandler.ts';
import { OpenCodeAppHandler } from './handlers/OpenCodeAppHandler.ts';
import { VSCodeAppHandler } from './handlers/VSCodeAppHandler.ts';
import { ConfigurableAppHandler } from './handlers/ConfigurableAppHandler.ts';
import { ClaudeDesktopAdapter } from './adapters/ClaudeDesktopAdapter.ts';
import { IntegrationRegistry } from './runtime/IntegrationRegistry.ts';
import { CapabilityResolver } from './runtime/CapabilityResolver.ts';
import { IntegrationLifecycle, IntegrationTestResult } from './runtime/IntegrationLifecycle.ts';

const SETTINGS_KEY = 'app_integrations_list';

export class IntegrationManager {
  private handlers = new Map<string, IAppIntegrationHandler>();
  private registry: IntegrationRegistry;
  private initialized = false;

  constructor(
    public readonly repos?: IRelayRepositories,
    private readonly engine?: RelayEngine,
  ) {
    this.registry = new IntegrationRegistry(repos);
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    let savedConfigs: AppIntegrationConfig[] | null = null;
    if (this.repos?.providerSettings) {
      try {
        const setting = await this.repos.providerSettings.get(SETTINGS_KEY);
        if (setting && setting.value) {
          savedConfigs = JSON.parse(setting.value);
        }
      } catch (err) {
        console.warn('[IntegrationManager] Failed to load persisted integrations, using defaults:', err);
      }
    }

    if (savedConfigs && Array.isArray(savedConfigs) && savedConfigs.length > 0) {
      for (const cfg of savedConfigs) {
        this.instantiateAndRegister(cfg);
      }
    } else {
      // Seed default baseline integrations (ChatGPT, OpenCode, VSCode, Claude Desktop)
      const chatgpt = new ChatGPTAppHandler();
      const opencode = new OpenCodeAppHandler();
      const vscode = new VSCodeAppHandler();
      const claude = new ClaudeDesktopAdapter();

      this.handlers.set(chatgpt.config.id, chatgpt);
      this.handlers.set(opencode.config.id, opencode);
      this.handlers.set(vscode.config.id, vscode);
      this.handlers.set(claude.config.id, claude);

      this.registry.register(chatgpt);
      this.registry.register(opencode);
      this.registry.register(vscode);
      this.registry.register(claude);

      await this.persist();
    }

    // Load persisted project overrides into registry
    await this.registry.loadPersisted();

    this.ensureDefaultInvariants();

    if (this.engine) {
      this.registerAllWithEngine(this.engine);
    }

    this.initialized = true;
  }

  private instantiateAndRegister(cfg: AppIntegrationConfig): IAppIntegrationHandler {
    let handler: IAppIntegrationHandler;
    if (cfg.id === 'chatgpt') {
      handler = new ChatGPTAppHandler(cfg);
    } else if (cfg.id === 'opencode') {
      handler = new OpenCodeAppHandler(cfg);
    } else if (cfg.id === 'vscode') {
      handler = new VSCodeAppHandler(cfg);
    } else if (cfg.id === 'claude_desktop') {
      handler = new ClaudeDesktopAdapter(cfg);
    } else {
      handler = new ConfigurableAppHandler(cfg);
    }
    this.handlers.set(cfg.id, handler);
    this.registry.register(handler);
    return handler;
  }

  /**
   * Enforces Requirement 5:
   * "There must be at least one enabled default on each side:
   *  - Default Planner
   *  - Default Worker"
   */
  public ensureDefaultInvariants(): void {
    const list = Array.from(this.handlers.values()).map((h) => h.config);

    // 1. Planner default
    let defaultPlanner = list.find((c) => c.isEnabled && c.isDefaultPlanner && (c.role === 'planner' || c.role === 'both'));
    if (!defaultPlanner) {
      // Find any enabled planner
      const anyPlanner = list.find((c) => c.isEnabled && (c.role === 'planner' || c.role === 'both'));
      if (anyPlanner) {
        anyPlanner.isDefaultPlanner = true;
        defaultPlanner = anyPlanner;
      } else {
        // Fallback to chatgpt
        const chatgpt = this.handlers.get('chatgpt')?.config;
        if (chatgpt) {
          chatgpt.isEnabled = true;
          chatgpt.isDefaultPlanner = true;
          defaultPlanner = chatgpt;
        }
      }
    }

    // Ensure only one default planner
    for (const c of list) {
      if (c.id !== defaultPlanner?.id) {
        c.isDefaultPlanner = false;
      }
    }

    // 2. Worker default
    let defaultWorker = list.find((c) => c.isEnabled && c.isDefaultWorker && (c.role === 'worker' || c.role === 'both'));
    if (!defaultWorker) {
      // Find any enabled worker
      const anyWorker = list.find((c) => c.isEnabled && (c.role === 'worker' || c.role === 'both'));
      if (anyWorker) {
        anyWorker.isDefaultWorker = true;
        defaultWorker = anyWorker;
      } else {
        // Fallback to opencode
        const opencode = this.handlers.get('opencode')?.config;
        if (opencode) {
          opencode.isEnabled = true;
          opencode.isDefaultWorker = true;
          defaultWorker = opencode;
        }
      }
    }

    // Ensure only one default worker
    for (const c of list) {
      if (c.id !== defaultWorker?.id) {
        c.isDefaultWorker = false;
      }
    }
  }

  public async persist(): Promise<void> {
    if (!this.repos?.providerSettings) return;
    try {
      const list = Array.from(this.handlers.values()).map((h) => h.config);
      const now = Date.now();
      await this.repos.providerSettings.save({
        key: SETTINGS_KEY,
        value: JSON.stringify(list),
        note: 'IntegrationManager configured apps and defaults',
        setBy: 'system',
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      console.warn('[IntegrationManager] Persist error:', err);
    }
  }

  public registerAllWithEngine(engine: RelayEngine): void {
    for (const handler of this.handlers.values()) {
      if (handler.config.isEnabled) {
        const providerType = (handler.config as any).providerType || (handler.config.id as any);
        try {
          const existing = engine.getProvider(providerType);
          if (existing) {
            // Engine already has a registered provider (e.g. test harness custom provider)
            continue;
          }
        } catch {
          // Not registered yet
        }
        engine.registerProvider(handler.asRuntimeProvider());
      }
    }
  }

  public listConfigs(): AppIntegrationConfig[] {
    return Array.from(this.handlers.values()).map((h) => h.config);
  }

  public getHandler(id: string): IAppIntegrationHandler | undefined {
    return this.handlers.get(id);
  }

  public getRegistry(): IntegrationRegistry {
    return this.registry;
  }

  /**
   * Orchestration Engine API:
   * Resolves the effective integration according to:
   * 1. Project override (if specified, enabled, and meets capability)
   * 2. Global role default
   * 3. First enabled role match
   * Throws clean error if unresolvable.
   */
  public async resolve(options: {
    role: AppRole;
    capability?: IntegrationCapability;
    projectId?: string;
  }): Promise<RelayIntegration> {
    await this.initialize();
    this.ensureDefaultInvariants();
    return this.registry.resolve(options.role, {
      projectId: options.projectId,
      capability: options.capability,
    });
  }

  public async resolveForProject(
    projectId: string | undefined,
    role: AppRole,
    capability?: IntegrationCapability,
  ): Promise<IAppIntegrationHandler> {
    await this.initialize();
    this.ensureDefaultInvariants();
    const resolved = this.registry.resolve(role, { projectId, capability });
    return resolved as IAppIntegrationHandler;
  }

  public async setProjectOverride(
    projectId: string,
    override: { plannerIntegrationId?: string | null; workerIntegrationId?: string | null },
  ): Promise<ProjectIntegrationOverride> {
    await this.initialize();
    return this.registry.setProjectOverride(projectId, override);
  }

  public getProjectOverride(projectId: string): ProjectIntegrationOverride | undefined {
    return this.registry.getProjectOverride(projectId);
  }

  public listProjectOverrides(): ProjectIntegrationOverride[] {
    return this.registry.listProjectOverrides();
  }

  public async testIntegration(id: string): Promise<IntegrationTestResult> {
    await this.initialize();
    const handler = this.handlers.get(id);
    if (!handler) {
      throw new Error(`Integration "${id}" not found`);
    }
    return IntegrationLifecycle.testIntegration(handler);
  }

  /**
   * Resolves the current default Planner integration handler.
   */
  public async getDefaultPlanner(): Promise<IAppIntegrationHandler> {
    await this.initialize();
    this.ensureDefaultInvariants();

    for (const h of this.handlers.values()) {
      if (h.config.isEnabled && h.config.isDefaultPlanner && (h.config.role === 'planner' || h.config.role === 'both')) {
        return h;
      }
    }

    const fallback = this.handlers.get('chatgpt');
    if (fallback) return fallback;
    throw new Error('No default Planner integration available');
  }

  /**
   * Resolves the current default Worker integration handler.
   */
  public async getDefaultWorker(): Promise<IAppIntegrationHandler> {
    await this.initialize();
    this.ensureDefaultInvariants();

    for (const h of this.handlers.values()) {
      if (h.config.isEnabled && h.config.isDefaultWorker && (h.config.role === 'worker' || h.config.role === 'both')) {
        return h;
      }
    }

    const fallback = this.handlers.get('opencode');
    if (fallback) return fallback;
    throw new Error('No default Worker integration available');
  }

  /**
   * Set an app as Default Planner or Default Worker.
   */
  public async setDefault(id: string, role: 'planner' | 'worker'): Promise<{ success: boolean; error?: string }> {
    await this.initialize();
    const handler = this.handlers.get(id);
    if (!handler) {
      return { success: false, error: `Integration "${id}" not found` };
    }

    if (!handler.config.isEnabled) {
      return { success: false, error: `Cannot set disabled app "${handler.config.name}" as default. Enable it first.` };
    }

    if (role === 'planner') {
      if (handler.config.role !== 'planner' && handler.config.role !== 'both') {
        return { success: false, error: `"${handler.config.name}" does not have Planner capability.` };
      }
      for (const h of this.handlers.values()) {
        h.config.isDefaultPlanner = h.config.id === id;
      }
    } else {
      if (handler.config.role !== 'worker' && handler.config.role !== 'both') {
        return { success: false, error: `"${handler.config.name}" does not have Worker capability.` };
      }
      for (const h of this.handlers.values()) {
        h.config.isDefaultWorker = h.config.id === id;
      }
    }

    this.ensureDefaultInvariants();
    await this.persist();
    return { success: true };
  }

  /**
   * Enable or disable an integration app.
   */
  public async toggleEnabled(id: string, enabled: boolean): Promise<AppIntegrationConfig> {
    await this.initialize();
    const handler = this.handlers.get(id);
    if (!handler) {
      throw new Error(`Integration "${id}" not found`);
    }

    if (!enabled) {
      // Check if trying to disable the active default planner
      if (handler.config.isDefaultPlanner) {
        const otherPlanners = Array.from(this.handlers.values()).filter(
          (h) => h.config.id !== id && h.config.isEnabled && (h.config.role === 'planner' || h.config.role === 'both'),
        );
        if (otherPlanners.length === 0) {
          throw new Error(`Cannot disable "${handler.config.name}" because it is the only active Default Planner. Please configure or enable another Planner first.`);
        }
        // Switch default to the first available other planner
        otherPlanners[0].config.isDefaultPlanner = true;
        handler.config.isDefaultPlanner = false;
      }

      // Check if trying to disable the active default worker
      if (handler.config.isDefaultWorker) {
        const otherWorkers = Array.from(this.handlers.values()).filter(
          (h) => h.config.id !== id && h.config.isEnabled && (h.config.role === 'worker' || h.config.role === 'both'),
        );
        if (otherWorkers.length === 0) {
          throw new Error(`Cannot disable "${handler.config.name}" because it is the only active Default Worker. Please configure or enable another Worker first.`);
        }
        // Switch default to the first available other worker
        otherWorkers[0].config.isDefaultWorker = true;
        handler.config.isDefaultWorker = false;
      }
    }

    handler.config.isEnabled = enabled;
    this.ensureDefaultInvariants();
    await this.persist();

    if (this.engine) {
      if (enabled) {
        this.engine.registerProvider(handler.asRuntimeProvider());
      }
    }

    return handler.config;
  }

  /**
   * Add a new Planner or Worker application (+ Add App).
   */
  public async addApp(input: Partial<AppIntegrationConfig>): Promise<AppIntegrationConfig> {
    await this.initialize();

    const name = input.name?.trim();
    if (!name) {
      throw new Error('Application Name is required');
    }

    const rawId = input.id?.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    let id = rawId;
    let counter = 1;
    while (this.handlers.has(id)) {
      id = `${rawId}_${counter++}`;
    }

    const role = input.role || 'worker';
    const appType = input.appType || 'app_bundle';
    const launchBehavior = input.launchBehavior || 'exec_cli';

    const fullConfig: AppIntegrationConfig = {
      id,
      name,
      description: input.description || `Custom ${role} integration for ${name}`,
      role,
      isEnabled: input.isEnabled ?? true,
      isDefaultPlanner: false,
      isDefaultWorker: false,
      isBuiltin: false,
      appType,
      appPath: input.appPath,
      bundleId: input.bundleId,
      processName: input.processName,
      windowTitlePattern: input.windowTitlePattern,
      launchBehavior,
      serviceUrl: input.serviceUrl,
      cliCommand: input.cliCommand,
      cliArguments: input.cliArguments,
      scripts: {
        launchScript: input.scripts?.launchScript,
        createSessionScript: input.scripts?.createSessionScript,
        openSessionScript: input.scripts?.openSessionScript,
        sendMessageScript: input.scripts?.sendMessageScript,
        inspectSessionScript: input.scripts?.inspectSessionScript,
        extractSessionScript: input.scripts?.extractSessionScript,
        verificationScript: input.scripts?.verificationScript,
      },
      status: 'verified',
      requirements: {
        accessibilityRequired: input.requirements?.accessibilityRequired ?? false,
        systemEventsRequired: input.requirements?.systemEventsRequired ?? false,
        cliRequired: input.requirements?.cliRequired ?? false,
        serviceRequired: input.requirements?.serviceRequired ?? false,
        notes: input.requirements?.notes,
      },
      capabilities: {
        discoverProjects: input.capabilities?.discoverProjects ?? true,
        discoverSessions: input.capabilities?.discoverSessions ?? true,
        createSession: input.capabilities?.createSession ?? true,
        dispatchInstruction: input.capabilities?.dispatchInstruction ?? true,
        captureTransportBoundary: input.capabilities?.captureTransportBoundary ?? false,
        reconcileExactSession: input.capabilities?.reconcileExactSession ?? false,
        observeCompletion: input.capabilities?.observeCompletion ?? true,
        extractResponse: input.capabilities?.extractResponse ?? true,
      },
      metadata: input.metadata,
    };

    const handler = new ConfigurableAppHandler(fullConfig);
    this.handlers.set(id, handler);

    if (input.isDefaultPlanner && (role === 'planner' || role === 'both')) {
      await this.setDefault(id, 'planner');
    }
    if (input.isDefaultWorker && (role === 'worker' || role === 'both')) {
      await this.setDefault(id, 'worker');
    }

    this.ensureDefaultInvariants();
    await this.persist();

    if (this.engine && fullConfig.isEnabled) {
      this.engine.registerProvider(handler.asRuntimeProvider());
    }

    return handler.config;
  }

  /**
   * Update an existing app configuration.
   */
  public async updateApp(id: string, updates: Partial<AppIntegrationConfig>): Promise<AppIntegrationConfig> {
    await this.initialize();
    const handler = this.handlers.get(id);
    if (!handler) {
      throw new Error(`Integration "${id}" not found`);
    }

    Object.assign(handler.config, {
      ...updates,
      id: handler.config.id, // prevent id mutation
      isBuiltin: handler.config.isBuiltin,
      scripts: {
        ...handler.config.scripts,
        ...updates.scripts,
      },
      requirements: {
        ...handler.config.requirements,
        ...updates.requirements,
      },
      capabilities: {
        ...handler.config.capabilities,
        ...updates.capabilities,
      },
    });

    if (updates.isDefaultPlanner !== undefined) {
      if (updates.isDefaultPlanner) {
        await this.setDefault(id, 'planner');
      }
    }
    if (updates.isDefaultWorker !== undefined) {
      if (updates.isDefaultWorker) {
        await this.setDefault(id, 'worker');
      }
    }

    this.ensureDefaultInvariants();
    await this.persist();

    if (this.engine) {
      this.engine.registerProvider(handler.asRuntimeProvider());
    }

    return handler.config;
  }

  /**
   * Delete a custom app integration.
   */
  public async deleteApp(id: string): Promise<{ success: boolean; error?: string }> {
    await this.initialize();
    const handler = this.handlers.get(id);
    if (!handler) {
      return { success: false, error: `Integration "${id}" not found` };
    }

    if (handler.config.isBuiltin) {
      return { success: false, error: `Cannot delete built-in integration "${handler.config.name}". You can disable it instead.` };
    }

    if (handler.config.isDefaultPlanner || handler.config.isDefaultWorker) {
      return {
        success: false,
        error: `Cannot delete "${handler.config.name}" while it is set as default. Please designate another default app first.`,
      };
    }

    this.handlers.delete(id);
    this.ensureDefaultInvariants();
    await this.persist();
    return { success: true };
  }

  /**
   * Verify an integration app.
   */
  public async verifyApp(id: string): Promise<AppIntegrationConfig> {
    await this.initialize();
    const handler = this.handlers.get(id);
    if (!handler) {
      throw new Error(`Integration "${id}" not found`);
    }

    const res = await handler.verify();
    handler.config.lastVerifiedAt = Date.now();
    handler.config.lastVerificationResult = res;
    handler.config.status = res.ok ? 'verified' : 'degraded';

    await this.persist();
    return handler.config;
  }
}
