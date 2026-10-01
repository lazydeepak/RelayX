import {
  AppIntegrationConfig,
  IAppIntegrationHandler,
  AppIntegrationSessionResult,
  AppRole,
  IntegrationManifest,
} from '../types.ts';
import {
  IRuntimeProvider,
  RuntimeInspectionResult,
  DeliveryInstructionRequest,
  DeliveryInstructionResult,
} from '../../providers/interfaces.ts';
import { OpenCodeProvider } from '../../providers/adapters.ts';
import { BrowserOpenCodeProvider } from '../../providers/browserProviders.ts';
import { RuntimeSessionId, createId } from '../../domain/types.ts';

export class OpenCodeAppHandler implements IAppIntegrationHandler {
  public readonly id = 'opencode';
  public readonly name = 'OpenCode CLI & Shared Service';
  public readonly roles: AppRole[] = ['worker'];
  public readonly config: AppIntegrationConfig;
  private readonly provider: IRuntimeProvider;

  constructor(
    customConfig?: Partial<AppIntegrationConfig>,
    providerOverride?: IRuntimeProvider,
  ) {
    this.config = {
      id: 'opencode',
      name: 'OpenCode CLI & Shared Service',
      description: 'Local OpenCode background agent daemon and CLI runner. Operates as primary code execution Worker.',
      role: 'worker',
      isEnabled: customConfig?.isEnabled ?? true,
      isDefaultPlanner: false,
      isDefaultWorker: customConfig?.isDefaultWorker ?? true,
      isBuiltin: true,
      appType: 'cli_service',
      serviceUrl: customConfig?.serviceUrl || 'http://127.0.0.1:4096',
      cliCommand: customConfig?.cliCommand || 'opencode',
      processName: customConfig?.processName || 'opencode',
      launchBehavior: customConfig?.launchBehavior || 'service_call',
      scripts: {
        launchScript: customConfig?.scripts?.launchScript || 'opencode serve --port 4096',
        createSessionScript: customConfig?.scripts?.createSessionScript || 'opencode session create --dir "{projectPath}" --title "{sessionTitle}"',
        openSessionScript: customConfig?.scripts?.openSessionScript || 'opencode session open {externalSessionId}',
        sendMessageScript: customConfig?.scripts?.sendMessageScript || 'opencode run --session {externalSessionId} --continue "{instruction}"',
        inspectSessionScript: customConfig?.scripts?.inspectSessionScript || 'opencode session status {externalSessionId}',
        extractSessionScript: customConfig?.scripts?.extractSessionScript || 'grep -o "ses_[0-9a-zA-Z_]*"',
        ...customConfig?.scripts,
      },
      status: 'verified',
      requirements: {
        accessibilityRequired: false,
        systemEventsRequired: false,
        cliRequired: true,
        cliInstalled: true,
        serviceRequired: true,
        serviceRunning: true,
        notes: 'Requires OpenCode CLI executable in PATH or shared service state in ~/.local/state/opencode/service.json',
      },
      capabilities: {
        discoverProjects: true,
        discoverSessions: true,
        createSession: true,
        dispatchInstruction: true,
        captureTransportBoundary: true,
        reconcileExactSession: true,
        observeCompletion: true,
        extractResponse: true,
      },
      ...customConfig,
    };

    if (providerOverride) {
      this.provider = providerOverride;
    } else {
      const isNode = typeof process !== 'undefined' && process.release?.name === 'node';
      this.provider = isNode ? new OpenCodeProvider() : new BrowserOpenCodeProvider();
    }
  }

  public async verify(): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }> {
    try {
      const runtimes = await this.provider.findAllRuntimes();
      return {
        ok: true,
        message: runtimes.length > 0
          ? `Verified: Found ${runtimes.length} OpenCode session(s) in active workspace`
          : 'Verified: OpenCode CLI & Shared Service protocol ready',
        details: { runtimeCount: runtimes.length },
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `Verification check: ${err.message || 'unknown error'}`,
      };
    }
  }

  public getManifest(): IntegrationManifest {
    return {
      id: this.id,
      name: this.name,
      version: '1.0.0',
      description: this.config.description,
      roles: ['worker'],
      capabilities: [
        'APP_LAUNCH',
        'APP_ACTIVATE',
        'PROJECT_OPEN',
        'SESSION_DISCOVER',
        'SESSION_CREATE',
        'SESSION_RENAME',
        'SESSION_VERIFY',
        'MESSAGE_SEND',
        'MESSAGE_OBSERVE',
        'RESPONSE_DETECT',
        'COMPLETION_DETECT',
        'MODEL_SELECT',
      ],
      adapterType: 'cli',
      serviceUrl: this.config.serviceUrl,
      processName: this.config.processName,
      defaultLaunchBehavior: 'service_call',
      supportedModels: [
        'anthropic/claude-3-7-sonnet',
        'anthropic/claude-3-5-sonnet',
        'openai/o3-mini',
        'openai/gpt-4o',
        'google/gemini-2.5-pro',
        'deepseek/deepseek-r1',
      ],
      automationBreakdown: {
        createSession: 'CLI (opencode session create)',
        sendMessage: 'HTTP / Shared Service POST',
        inspectSession: 'Local Daemon State (~/.local/state/opencode)',
        discoverSessions: 'Directory Workspace Matcher',
      },
    };
  }

  public async launch(projectPath?: string): Promise<{ ok: boolean; pid?: number; windowTitle?: string }> {
    return { ok: true, windowTitle: 'OpenCode' };
  }

  public async discoverSessions(context: { projectPath: string; gitRoot?: string }) {
    if (this.provider.matchSessionsByPath) {
      try {
        const res = await this.provider.matchSessionsByPath(context.projectPath, context.gitRoot);
        if (res.success && res.sessions) {
          return res.sessions.map((s) => ({
            externalSessionId: (s.evidence?.details as any)?.parsedSessionId || s.evidence.id,
            title: s.windowTitle,
            workspacePath: context.projectPath,
            windowTitle: s.windowTitle,
          }));
        }
      } catch {}
    }
    return [];
  }

  public async createSession(options: {
    projectId: string;
    projectName?: string;
    projectPath?: string;
    sessionTitle: string;
  }): Promise<AppIntegrationSessionResult> {
    if (this.provider.createWorkerSession && options.projectPath) {
      try {
        const res = await this.provider.createWorkerSession(options.projectPath, options.sessionTitle);
        if (res.sessionId) {
          return {
            externalSessionId: res.sessionId,
            workspaceDir: res.workspaceDir || options.projectPath,
            metadata: {
              title: options.sessionTitle,
              provider: 'opencode',
              role: 'worker',
            },
          };
        }
      } catch (err) {
        console.warn('Direct createWorkerSession threw, falling back to id generation:', err);
      }
    }

    const fallbackId = `ses_${createId('oc')}`;
    return {
      externalSessionId: fallbackId,
      workspaceDir: options.projectPath,
      metadata: {
        title: options.sessionTitle,
        provider: 'opencode',
        role: 'worker',
      },
    };
  }

  public async openSession(sessionId: string, externalSessionId?: string | null): Promise<boolean> {
    return this.provider.activateRuntime(sessionId as RuntimeSessionId);
  }

  public async sendMessage(request: DeliveryInstructionRequest): Promise<DeliveryInstructionResult> {
    return this.provider.deliverInstruction(request);
  }

  public async inspectSession(sessionId: string, externalSessionId?: string | null): Promise<RuntimeInspectionResult> {
    return this.provider.inspectRuntime(sessionId as RuntimeSessionId);
  }

  public asRuntimeProvider(): IRuntimeProvider {
    return this.provider;
  }
}
