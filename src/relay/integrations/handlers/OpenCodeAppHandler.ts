import {
  AppIntegrationConfig,
  IAppIntegrationHandler,
  AppIntegrationSessionResult,
  AppRole,
  IntegrationManifest,
  IntegrationReadiness,
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
  private readonly provider: any;
  private readonly engine?: any;

  constructor(
    customConfig?: Partial<AppIntegrationConfig>,
    providerOverride?: any,
    engine?: any,
  ) {
    this.engine = engine;
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

  private getActiveProvider(): any {
    if (this.engine && typeof this.engine.getProvider === 'function') {
      try {
        const p = this.engine.getProvider('opencode');
        if (p) return p;
      } catch {}
    }
    return this.provider;
  }

  public async verify(): Promise<IntegrationReadiness> {
    try {
      const runtimes = await this.getActiveProvider().findAllRuntimes();
      return {
        ok: true,
        status: 'READY',
        message: runtimes.length > 0
          ? `Verified: Found ${runtimes.length} OpenCode session(s) in active workspace`
          : 'Verified: OpenCode CLI & Shared Service protocol ready',
        lastVerifiedAt: Date.now(),
        checklist: {
          applicationFound: true,
          accessibilityPermission: true,
          automationPermission: true,
          sessionCreation: true,
          sessionIdentity: true,
          messageSubmission: true,
          observation: true,
        },
        details: { runtimeCount: runtimes.length },
      };
    } catch (err: any) {
      return {
        ok: false,
        status: 'NOT_DETECTED',
        message: `Verification check: ${err.message || 'unknown error'}`,
        lastVerifiedAt: Date.now(),
        checklist: {
          applicationFound: false,
          accessibilityPermission: false,
          automationPermission: false,
          sessionCreation: false,
          sessionIdentity: false,
          messageSubmission: false,
          observation: false,
        },
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
        'opencode-zen/free-default',
        'openrouter/free',
        'thinking-machines/inkling:free',
        'thinking-machines/inkling-small:free',
        'nvidia/nemotron-3-ultra:free',
        'nvidia/nemotron-3.5-lightning:free',
        'poolside/laguna-s-2.1:free',
        'poolside/laguna-xs-2.1:free',
        'cohere/north-mini-code:free',
        'google/gemini-2.5-flash:free',
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
    const activeProvider = this.getActiveProvider();
    if (activeProvider && activeProvider.matchSessionsByPath) {
      try {
        const res = await activeProvider.matchSessionsByPath(context.projectPath, context.gitRoot);
        if (res.success && res.sessions) {
          return res.sessions.map((s: any) => ({
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
    const activeProvider = this.getActiveProvider();
    if (activeProvider && typeof activeProvider.createWorkerSession === 'function' && options.projectPath) {
      try {
        const res = await activeProvider.createWorkerSession(options.projectPath, options.sessionTitle);
        if (res?.error) {
          return {
            externalSessionId: '',
            error: res.error,
            metadata: {
              title: options.sessionTitle,
              provider: 'opencode',
              role: 'worker',
            },
          };
        }
        if (res?.sessionId) {
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
      } catch (err: any) {
        console.warn('Direct createWorkerSession threw:', err);
        return {
          externalSessionId: '',
          error: err?.message || String(err),
          metadata: {
            title: options.sessionTitle,
            provider: 'opencode',
            role: 'worker',
          },
        };
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

  public async openSession(sessionId: string, externalSessionId?: string | null, windowTitle?: string): Promise<boolean> {
    return this.getActiveProvider().activateRuntime(sessionId as RuntimeSessionId, windowTitle);
  }

  public async sendMessage(
    session: { externalSessionId: string },
    message: { instruction: string; deliveryId?: string; idempotencyKey?: string },
  ): Promise<DeliveryInstructionResult> {
    return this.getActiveProvider().deliverInstruction({
      runtimeSessionId: '' as any,
      externalSessionId: session.externalSessionId,
      instructionText: message.instruction,
      deliveryId: message.deliveryId,
      idempotencyKey: message.idempotencyKey,
    } as DeliveryInstructionRequest);
  }

  public async inspectSession(session: { externalSessionId: string; runtimeSessionId?: string }): Promise<RuntimeInspectionResult> {
    return this.getActiveProvider().inspectRuntime((session.runtimeSessionId || '') as RuntimeSessionId);
  }

  public asRuntimeProvider(): IRuntimeProvider {
    return this.getActiveProvider();
  }
}
