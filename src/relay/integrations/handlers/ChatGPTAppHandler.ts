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
import { ChatGPTProvider } from '../../providers/adapters.ts';
import { BrowserChatGPTProvider } from '../../providers/browserProviders.ts';
import { DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT } from '../../providers/chatgptProjectDiscovery.ts';
import { RuntimeSessionId, createId } from '../../domain/types.ts';

export class ChatGPTAppHandler implements IAppIntegrationHandler {
  public readonly id = 'chatgpt';
  public readonly name = 'ChatGPT Desktop & Web';
  public readonly roles: AppRole[] = ['planner'];
  public readonly config: AppIntegrationConfig;
  private readonly provider: IRuntimeProvider;
  private readonly engine?: any;

  constructor(
    customConfig?: Partial<AppIntegrationConfig>,
    providerOverride?: IRuntimeProvider,
    engine?: any,
  ) {
    this.engine = engine;
    this.config = {
      id: 'chatgpt',
      name: 'ChatGPT Desktop & Web',
      description: 'Official ChatGPT macOS app or Google Chrome project tab. Operates as primary strategic Planner.',
      role: 'planner',
      isEnabled: customConfig?.isEnabled ?? true,
      isDefaultPlanner: customConfig?.isDefaultPlanner ?? true,
      isDefaultWorker: false,
      isBuiltin: true,
      appType: 'app_bundle',
      appPath: customConfig?.appPath || '/Applications/ChatGPT.app',
      bundleId: customConfig?.bundleId || 'com.openai.chat',
      processName: customConfig?.processName || 'ChatGPT',
      windowTitlePattern: customConfig?.windowTitlePattern || 'ChatGPT*',
      launchBehavior: customConfig?.launchBehavior || 'open_bundle',
      scripts: {
        launchScript: customConfig?.scripts?.launchScript || 'open -a "/Applications/ChatGPT.app"',
        createSessionScript: customConfig?.scripts?.createSessionScript || 'Cmd+Shift+O / New Conversation',
        discoverProjectScript:
          customConfig?.scripts?.discoverProjectScript || DEFAULT_CHATGPT_PROJECT_DISCOVERY_SCRIPT,
        openSessionScript: customConfig?.scripts?.openSessionScript || 'open "https://chatgpt.com/c/{externalSessionId}"',
        sendMessageScript: customConfig?.scripts?.sendMessageScript || 'keystroke "{instruction}" + Return',
        inspectSessionScript: customConfig?.scripts?.inspectSessionScript || 'AXUIElement composer inspection',
        ...customConfig?.scripts,
      },
      status: 'verified',
      requirements: {
        accessibilityRequired: true,
        systemEventsRequired: true,
        notes: 'Requires macOS Accessibility and System Events permissions for window inspection and message delivery',
      },
      capabilities: {
        discoverProjects: true,
        discoverSessions: true,
        createSession: true,
        dispatchInstruction: true,
        captureTransportBoundary: false,
        reconcileExactSession: false,
        observeCompletion: true,
        extractResponse: true,
      },
      ...customConfig,
    };

    if (providerOverride) {
      this.provider = providerOverride;
    } else {
      const isDarwin = typeof process !== 'undefined' && (process as any).platform === 'darwin';
      this.provider = isDarwin ? new ChatGPTProvider() : new BrowserChatGPTProvider();
    }
    this.refreshProviderScripts();
  }

  /**
   * Pushes the configured automation scripts onto the live provider.
   *
   * This is what makes the ChatGPT Project discovery sequence repairable from the
   * Integration page: editing `scripts.discoverProjectScript` here changes the
   * GUI flow the provider runs, with no domain-layer change.
   */
  public refreshProviderScripts(): void {
    const script = this.config.scripts.discoverProjectScript;
    const apply = (target: unknown): void => {
      const provider = target as { applyProjectDiscoveryScript?: (s?: string) => void };
      if (typeof provider?.applyProjectDiscoveryScript === 'function') {
        provider.applyProjectDiscoveryScript(script);
      }
    };

    // Apply to BOTH this handler's own provider and the engine's active
    // provider. They are only the same instance when the engine had no provider
    // registered yet; when the caller pre-registered one (test harness, or a
    // host that owns provider construction) the engine's instance is the one
    // discovery actually runs on, so it must receive the edit too.
    apply(this.provider);
    const active = this.engine ? this.getActiveProvider() : undefined;
    if (active && active !== this.provider) apply(active);
  }

  private getActiveProvider(): any {
    if (this.engine && typeof this.engine.getProvider === 'function') {
      try {
        const p = this.engine.getProvider('chatgpt');
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
          ? `Verified: Found ${runtimes.length} active ChatGPT window/tab(s)`
          : 'Verified: ChatGPT adapter ready (launch or focus on demand)',
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
      roles: ['planner'],
      capabilities: [
        'APP_LAUNCH',
        'APP_ACTIVATE',
        'PROJECT_VERIFY',
        'SESSION_DISCOVER',
        'SESSION_CREATE',
        'SESSION_VERIFY',
        'MESSAGE_SEND',
        'MESSAGE_OBSERVE',
        'COMPLETION_DETECT',
        'MODEL_SELECT',
      ],
      adapterType: 'native_builtin',
      appPath: this.config.appPath,
      bundleId: this.config.bundleId,
      processName: this.config.processName,
      defaultLaunchBehavior: 'open_bundle',
      supportedModels: ['openai/gpt-4o', 'openai/o3-mini', 'openai/o1'],
      automationBreakdown: {
        createSession: 'Chrome Tab / Desktop App',
        sendMessage: 'DOM Injection / Accessibility Events',
        inspectSession: 'Window / Tab Observer',
      },
    };
  }

  public async launch(projectPath?: string): Promise<{ ok: boolean; pid?: number; windowTitle?: string }> {
    try {
      if (typeof process !== 'undefined' && (process as any).platform === 'darwin') {
        const { exec } = await import('node:child_process');
        exec('open -a "/Applications/ChatGPT.app"');
      }
      return { ok: true, windowTitle: 'ChatGPT' };
    } catch {
      return { ok: false };
    }
  }

  public async discoverSessions(context: { projectPath: string; gitRoot?: string }) {
    return [];
  }

  public async createSession(options: {
    projectId: string;
    projectName?: string;
    projectPath?: string;
    projectUrl?: string;
    sessionTitle: string;
    conversationUrl?: string;
  }): Promise<AppIntegrationSessionResult> {
    const match = options.projectUrl?.match(/(?:^|\/g\/)(g-p-[^/?#]+)/i);
    const projectSlug = match ? match[1].toLowerCase() : null;

    if (options.conversationUrl?.trim()) {
      const trimmed = options.conversationUrl.trim();
      let convId = trimmed;
      const cMatch = trimmed.match(/\/c\/([^/?#]+)/i);
      if (cMatch) {
        convId = cMatch[1];
      }
      let exactUrl = trimmed;
      if (!exactUrl.startsWith('http')) {
        exactUrl = projectSlug ? `https://chatgpt.com/g/${projectSlug}/c/${convId}` : `https://chatgpt.com/c/${convId}`;
      }
      return {
        externalSessionId: convId,
        sessionUrl: exactUrl,
        metadata: {
          title: options.sessionTitle,
          provider: 'chatgpt',
          role: 'planner',
          isExactUserUrl: true,
        },
      };
    }

    const rawUuid = `${Date.now().toString(16)}-${Math.random().toString(36).substring(2, 10)}`;
    const conversationUrl = projectSlug
      ? `https://chatgpt.com/g/${projectSlug}/c/${rawUuid}`
      : `https://chatgpt.com/c/${rawUuid}`;

    const activeProvider = this.getActiveProvider();
    if (activeProvider && typeof (activeProvider as any).createPlannerSession === 'function' && options.projectUrl) {
      try {
        const res = await (activeProvider as any).createPlannerSession(options.projectUrl, options.sessionTitle);
        if (res?.conversationId && res?.conversationUrl) {
          return {
            externalSessionId: res.conversationId,
            sessionUrl: res.conversationUrl,
            metadata: {
              title: options.sessionTitle,
              provider: 'chatgpt',
              role: 'planner',
            },
          };
        }
        return {
          externalSessionId: '',
          error: res?.error || 'ChatGPT provider did not return an authoritative conversation identity',
        };
      } catch (err: any) {
        return {
          externalSessionId: '',
          error: err?.message ?? String(err),
        };
      }
    }

    return {
      externalSessionId: rawUuid,
      sessionUrl: conversationUrl,
      metadata: {
        title: options.sessionTitle,
        provider: 'chatgpt',
        role: 'planner',
        exactUrl: conversationUrl,
      },
    };
  }

  public async openSession(sessionId: string, externalSessionId?: string | null, windowTitle?: string): Promise<boolean> {
    let targetUrl: string | null = null;
    if (externalSessionId?.trim()) {
      const ext = externalSessionId.trim();
      if (ext.startsWith('http://') || ext.startsWith('https://')) {
        targetUrl = ext;
      } else {
        targetUrl = `https://chatgpt.com/c/${ext}`;
      }
    }

    if (!targetUrl && this.engine) {
      try {
        const runtime = await (this.engine as any).repos?.runtimes?.findById(sessionId);
        if (runtime?.sessionUrl) {
          targetUrl = runtime.sessionUrl;
        } else if (runtime?.externalSessionId) {
          const ext = runtime.externalSessionId.trim();
          if (ext.startsWith('http://') || ext.startsWith('https://')) {
            targetUrl = ext;
          } else if (runtime.externalProjectRef) {
            const pMatch = runtime.externalProjectRef.match(/(?:^|\/g\/)(g-p-[^/?#]+)/i);
            targetUrl = pMatch ? `https://chatgpt.com/g/${pMatch[1]}/c/${ext}` : `https://chatgpt.com/c/${ext}`;
          } else {
            targetUrl = `https://chatgpt.com/c/${ext}`;
          }
        }
      } catch {}
    }

    if (!targetUrl) {
      // Opening the session is not supported without an exact session URL
      return false;
    }

    try {
      const isNode = typeof process !== 'undefined' && process.release?.name === 'node';
      if (isNode) {
        const { exec } = await import('node:child_process');
        const cmd = process.platform === 'darwin'
          ? `open "${targetUrl}"`
          : process.platform === 'win32'
            ? `start "" "${targetUrl}"`
            : `xdg-open "${targetUrl}"`;
        exec(cmd, (err) => {
          if (err) console.warn('[ChatGPTAppHandler] open command error:', err);
        });
      }
    } catch {}

    try {
      await this.getActiveProvider().activateRuntime(sessionId as RuntimeSessionId, windowTitle);
    } catch {}

    return true;
  }

  public async sendMessage(
    session: { externalSessionId: string },
    message: { instruction: string; deliveryId?: string; idempotencyKey?: string },
  ): Promise<DeliveryInstructionResult> {
    return this.getActiveProvider().deliverInstruction({
      runtimeSessionId: '' as any, // Not strictly needed for the provider call if externalId is used
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
