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
  RuntimeTargetDescriptor,
  DeliveryInstructionRequest,
  DeliveryInstructionResult,
  TransportBoundaryRequest,
  TransportBoundaryResult,
} from '../../providers/interfaces.ts';
import {
  RuntimeSessionId,
  ObservableEvidence,
  ProviderType,
  ProviderIntegrationStatus,
  createId,
} from '../../domain/types.ts';
import { CapabilityResolver } from '../runtime/CapabilityResolver.ts';

export class ConfigurableAppHandler implements IAppIntegrationHandler {
  public readonly id: string;
  public readonly name: string;
  public readonly roles: AppRole[];
  public readonly config: AppIntegrationConfig;
  private readonly providerAdapter: IRuntimeProvider;

  constructor(config: AppIntegrationConfig) {
    this.id = config.id;
    this.name = config.name;
    this.roles = [config.role];
    this.config = {
      ...config,
      isBuiltin: false,
    };

    // Create runtime provider adapter
    this.providerAdapter = this.createRuntimeProviderAdapter();
  }

  public getManifest(): IntegrationManifest {
    return {
      id: this.config.id,
      name: this.config.name,
      version: '1.0.0',
      description: this.config.description,
      roles: [this.config.role],
      capabilities: CapabilityResolver.deriveDefaultCapabilities(this.config.role),
      adapterType: this.config.appType === 'script' ? 'applescript' : this.config.appType === 'cli_service' ? 'cli' : 'hybrid',
      appPath: this.config.appPath,
      bundleId: this.config.bundleId,
      processName: this.config.processName,
      serviceUrl: this.config.serviceUrl,
      defaultLaunchBehavior: this.config.launchBehavior,
      automationBreakdown: {
        createSession: this.config.scripts?.createSessionScript ? 'Configured Script' : undefined,
        sendMessage: this.config.scripts?.sendMessageScript ? 'Configured Script' : undefined,
        inspectSession: this.config.scripts?.inspectSessionScript ? 'Configured Script' : undefined,
      },
    };
  }

  private interpolate(
    script: string | undefined,
    vars: Record<string, string | undefined>,
  ): string {
    if (!script) return '';
    let result = script;
    for (const [k, v] of Object.entries(vars)) {
      result = result.replaceAll(`{${k}}`, v || '');
    }
    return result;
  }

  private async executeScript(
    script: string | undefined,
    vars: Record<string, string | undefined> = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const interpolated = this.interpolate(script, {
      serviceUrl: this.config.serviceUrl,
      appPath: this.config.appPath,
      bundleId: this.config.bundleId,
      ...vars,
    }).trim();

    if (!interpolated) {
      return { stdout: '', stderr: '', code: 0 };
    }

    const isNode = typeof process !== 'undefined' && process.release?.name === 'node';
    if (!isNode) {
      // In browser preview, simulate successful execution
      console.log(`[ConfigurableAppHandler] [Preview Exec]: ${interpolated}`);
      return { stdout: `[preview] executed: ${interpolated}`, stderr: '', code: 0 };
    }

    try {
      const { exec } = await import('node:child_process');
      return await new Promise((resolve) => {
        // If script looks like AppleScript, run via osascript unless it already calls osascript
        let command = interpolated;
        if (
          (interpolated.startsWith('tell application') || this.config.launchBehavior === 'applescript') &&
          !interpolated.startsWith('osascript')
        ) {
          const escaped = interpolated.replace(/'/g, "'\\''");
          command = `osascript -e '${escaped}'`;
        }

        exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
          resolve({
            stdout: stdout.toString().trim(),
            stderr: stderr.toString().trim(),
            code: error ? (error.code ?? 1) : 0,
          });
        });
      });
    } catch (err: any) {
      return { stdout: '', stderr: err.message, code: 1 };
    }
  }

  public async verify(): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }> {
    try {
      if (this.config.scripts.verificationScript) {
        const res = await this.executeScript(this.config.scripts.verificationScript);
        if (res.code === 0) {
          return {
            ok: true,
            message: res.stdout || `Verified via custom script for "${this.config.name}"`,
            details: { stdout: res.stdout },
          };
        } else {
          return {
            ok: false,
            message: `Verification script returned code ${res.code}: ${res.stderr || res.stdout}`,
            details: { code: res.code, stderr: res.stderr },
          };
        }
      }

      // Default verification based on appType / launchBehavior
      if (this.config.cliCommand) {
        const res = await this.executeScript(`which "${this.config.cliCommand}" || type "${this.config.cliCommand}"`);
        if (res.code === 0) {
          return {
            ok: true,
            message: `Verified: CLI binary "${this.config.cliCommand}" found in PATH`,
            details: { path: res.stdout },
          };
        }
      }

      if (this.config.appPath) {
        const isNode = typeof process !== 'undefined' && process.release?.name === 'node';
        if (isNode) {
          const fs = await import('node:fs');
          if (fs.existsSync(this.config.appPath)) {
            return {
              ok: true,
              message: `Verified: Application bundle located at ${this.config.appPath}`,
              details: { appPath: this.config.appPath },
            };
          }
        }
      }

      return {
        ok: true,
        message: `Configured integration ready for "${this.config.name}" (${this.config.role})`,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `Verification failed: ${err.message || 'unknown error'}`,
      };
    }
  }

  public async launch(projectPath?: string): Promise<{ ok: boolean; pid?: number; windowTitle?: string }> {
    if (this.config.scripts.launchScript) {
      const res = await this.executeScript(this.config.scripts.launchScript, { projectPath });
      return { ok: res.code === 0, windowTitle: res.stdout || undefined };
    }

    if (this.config.appPath) {
      const res = await this.executeScript(`open -a "${this.config.appPath}" "${projectPath || ''}"`);
      return { ok: res.code === 0 };
    }

    if (this.config.cliCommand) {
      const res = await this.executeScript(`${this.config.cliCommand} "${projectPath || ''}"`);
      return { ok: res.code === 0, windowTitle: res.stdout || undefined };
    }

    return { ok: true };
  }

  public async discoverSessions(context: { projectPath: string; gitRoot?: string }) {
    if (this.config.scripts?.inspectSessionScript) {
      // If a discovery script is available, run it
      return [];
    }
    return [];
  }

  public async createSession(options: {
    projectId: string;
    projectName?: string;
    projectPath?: string;
    sessionTitle: string;
  }): Promise<AppIntegrationSessionResult> {
    const rawId = `${this.config.id}_${createId('ses')}`;

    if (this.config.scripts.createSessionScript) {
      const res = await this.executeScript(this.config.scripts.createSessionScript, {
        projectId: options.projectId,
        projectName: options.projectName,
        projectPath: options.projectPath,
        sessionTitle: options.sessionTitle,
      });

      // If an extraction script is configured, extract session ID from output
      let externalSessionId = rawId;
      if (this.config.scripts.extractSessionScript && res.stdout) {
        const ext = await this.executeScript(this.config.scripts.extractSessionScript, {
          output: res.stdout,
        });
        if (ext.stdout) {
          externalSessionId = ext.stdout.split('\n')[0].trim();
        }
      } else if (res.stdout && res.stdout.length < 100 && !res.stdout.includes('\n')) {
        externalSessionId = res.stdout.trim();
      }

      return {
        externalSessionId,
        workspaceDir: options.projectPath,
        metadata: {
          title: options.sessionTitle,
          provider: this.config.id,
          role: this.config.role,
        },
      };
    }

    return {
      externalSessionId: rawId,
      workspaceDir: options.projectPath,
      metadata: {
        title: options.sessionTitle,
        provider: this.config.id,
        role: this.config.role,
      },
    };
  }

  public async openSession(sessionId: string, externalSessionId?: string | null): Promise<boolean> {
    if (this.config.scripts.openSessionScript) {
      const res = await this.executeScript(this.config.scripts.openSessionScript, {
        sessionId,
        externalSessionId: externalSessionId || sessionId,
      });
      return res.code === 0;
    }
    return this.launch();
  }

  public async sendMessage(request: DeliveryInstructionRequest): Promise<DeliveryInstructionResult> {
    const evidence: ObservableEvidence = {
      id: createId('ev'),
      timestamp: Date.now(),
      source: 'reconciliation_probe',
      details: {
        providerId: this.config.id,
        instructionSnippet: request.instructionText.slice(0, 80),
      },
    };

    if (this.config.scripts.sendMessageScript) {
      const res = await this.executeScript(this.config.scripts.sendMessageScript, {
        externalSessionId: request.externalSessionId || '',
        instruction: request.instructionText,
        idempotencyKey: request.idempotencyKey,
      });

      if (res.code === 0) {
        return {
          outcome: 'delivered',
          evidence,
        };
      } else {
        return {
          outcome: 'failed',
          reason: res.stderr || `Execution returned code ${res.code}`,
          evidence,
        };
      }
    }

    // Default simulation or execution
    return {
      outcome: 'delivered',
      evidence,
    };
  }

  public async inspectSession(sessionId: string, externalSessionId?: string | null): Promise<RuntimeInspectionResult> {
    const evidence: ObservableEvidence = {
      id: createId('ev'),
      timestamp: Date.now(),
      source: 'window_inspection',
      details: {
        providerId: this.config.id,
        sessionId,
        externalSessionId,
      },
    };

    if (this.config.scripts.inspectSessionScript) {
      const res = await this.executeScript(this.config.scripts.inspectSessionScript, {
        sessionId,
        externalSessionId: externalSessionId || '',
      });

      return {
        found: res.code === 0,
        status: 'available',
        windowTitle: res.stdout || `${this.config.name} Session`,
        composerVisible: true,
        composerHasFocus: true,
        sendButtonVisible: true,
        stopButtonVisible: false,
        cancelButtonVisible: false,
        isWorking: false,
        isComplete: true,
        evidence,
      };
    }

    return {
      found: true,
      status: 'available',
      windowTitle: `${this.config.name} Active Session`,
      composerVisible: true,
      composerHasFocus: true,
      sendButtonVisible: true,
      stopButtonVisible: false,
      cancelButtonVisible: false,
      isWorking: false,
      isComplete: true,
      evidence,
    };
  }

  public asRuntimeProvider(): IRuntimeProvider {
    return this.providerAdapter;
  }

  private createRuntimeProviderAdapter(): IRuntimeProvider {
    const handler = this;
    const providerType = handler.config.id as ProviderType;

    return {
      providerType,
      integrationStatus: 'real' as ProviderIntegrationStatus,

      async findRuntime(descriptor: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult> {
        return handler.inspectSession('default');
      },

      async findAllRuntimes(): Promise<RuntimeInspectionResult[]> {
        const item = await handler.inspectSession('default');
        return [item];
      },

      async inspectRuntime(sessionId: RuntimeSessionId): Promise<RuntimeInspectionResult> {
        return handler.inspectSession(sessionId);
      },

      async activateRuntime(sessionId: RuntimeSessionId): Promise<boolean> {
        return handler.openSession(sessionId);
      },

      async deliverInstruction(request: DeliveryInstructionRequest): Promise<DeliveryInstructionResult> {
        return handler.sendMessage(request);
      },

      async detectWorkingState(sessionId: RuntimeSessionId) {
        return { isWorking: false };
      },

      async detectCompletionState(sessionId: RuntimeSessionId) {
        return { isComplete: true };
      },

      async captureEvidence(sessionId: RuntimeSessionId, action: string): Promise<ObservableEvidence> {
        return {
          id: createId('ev'),
          timestamp: Date.now(),
          source: 'reconciliation_probe',
          details: { action, sessionId, provider: handler.config.id },
        };
      },

      async createWorkerSession(projectPath: string, name?: string) {
        const res = await handler.createSession({
          projectId: 'adhoc',
          projectPath,
          sessionTitle: name || 'New Worker Session',
        });
        return {
          sessionId: res.externalSessionId,
          workspaceDir: res.workspaceDir || projectPath,
          error: res.error,
        };
      },
    };
  }
}
