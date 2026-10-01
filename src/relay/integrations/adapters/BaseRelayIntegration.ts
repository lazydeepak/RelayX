import {
  RelayIntegration,
  IntegrationManifest,
  IntegrationReadiness,
  AppRole,
  AppIntegrationConfig,
  AppIntegrationSessionResult,
} from '../types.ts';
import {
  IRuntimeProvider,
  RuntimeInspectionResult,
  DeliveryInstructionRequest,
  DeliveryInstructionResult,
  RuntimeTargetDescriptor,
} from '../../providers/interfaces.ts';
import { PermissionManager } from '../runtime/PermissionManager.ts';
import { RuntimeSessionId } from '../../domain/types.ts';

export abstract class BaseRelayIntegration implements RelayIntegration {
  public abstract readonly id: string;
  public abstract readonly name: string;
  public abstract readonly roles: AppRole[];
  public abstract readonly config: AppIntegrationConfig;

  public abstract getManifest(): IntegrationManifest;

  public async verify(): Promise<IntegrationReadiness> {
    const readiness = await PermissionManager.assessReadiness(this.config);
    this.config.status = readiness.status.toLowerCase() as any;
    this.config.lastVerifiedAt = readiness.lastVerifiedAt;
    this.config.lastVerificationResult = {
      ok: readiness.ok,
      message: readiness.message,
      details: readiness.details,
    };
    return readiness;
  }

  public abstract launch(projectPath?: string): Promise<{ ok: boolean; pid?: number; windowTitle?: string }>;

  public async discoverProjects?(context?: { workspaceRoot?: string }): Promise<Array<{ id: string; name: string; path: string }>> {
    return [];
  }

  public abstract discoverSessions(context: { projectPath: string; gitRoot?: string }): Promise<Array<{
    externalSessionId: string;
    title?: string;
    workspacePath?: string;
    windowTitle?: string;
  }>>;

  public abstract createSession(request: {
    projectId: string;
    projectName?: string;
    projectPath?: string;
    projectUrl?: string;
    sessionTitle: string;
    bootstrapPrompt?: string;
  }): Promise<AppIntegrationSessionResult>;

  public async renameSession?(session: { externalSessionId: string }, title: string): Promise<void> {
    // Optional implementation
  }

  public abstract sendMessage(
    session: { externalSessionId: string },
    message: { instruction: string; deliveryId?: string; idempotencyKey?: string },
  ): Promise<DeliveryInstructionResult>;

  public abstract inspectSession(session: { externalSessionId: string; runtimeSessionId?: string }): Promise<RuntimeInspectionResult>;

  public async openSession(sessionId: string, externalSessionId?: string | null): Promise<boolean> {
    const res = await this.launch();
    return res.ok;
  }

  /**
   * Adapts this RelayIntegration into an engine-compatible IRuntimeProvider.
   */
  public asRuntimeProvider(): IRuntimeProvider {
    const self = this;
    const providerType = (self.config.providerType || self.id) as any;
    return {
      providerType,
      integrationStatus: (self.config.status === 'verified' ? 'verified' : self.config.status === 'degraded' ? 'partial' : 'unsupported') as any,
      defaultBundleId: self.config.bundleId,
      defaultProcessName: self.config.processName,
      defaultWindowTitle: self.config.windowTitlePattern,

      async findRuntime(target: RuntimeTargetDescriptor): Promise<RuntimeInspectionResult> {
        return self.inspectSession({
          externalSessionId: target.externalSessionId ?? '',
          runtimeSessionId: target.runtimeSessionId,
        });
      },

      async findAllRuntimes(): Promise<RuntimeInspectionResult[]> {
        const inspected = await self.inspectSession({ externalSessionId: '' });
        return inspected.status !== 'unsupported' ? [inspected] : [];
      },

      async deliverInstruction(request: DeliveryInstructionRequest): Promise<DeliveryInstructionResult> {
        return self.sendMessage(
          { externalSessionId: request.externalSessionId ?? '' },
          { instruction: request.instruction, deliveryId: request.deliveryId, idempotencyKey: request.idempotencyKey },
        );
      },

      async detectWorkingState(sessionId: RuntimeSessionId) {
        const obs = await self.inspectSession({ externalSessionId: '', runtimeSessionId: sessionId });
        return { isWorking: obs.status === 'busy', evidence: obs.evidence };
      },

      async detectCompletionState(sessionId: RuntimeSessionId) {
        const obs = await self.inspectSession({ externalSessionId: '', runtimeSessionId: sessionId });
        return { isComplete: obs.status === 'idle', evidence: obs.evidence };
      },

      async reconcileDispatch(request) {
        return {
          outcome: 'supporting_evidence_only' as const,
          reason: 'Dispatch handled by integration adapter',
        };
      },

      async captureEvidence(sessionId: RuntimeSessionId, action: string) {
        const obs = await self.inspectSession({ externalSessionId: '', runtimeSessionId: sessionId });
        return obs.evidence;
      },
    };
  }
}
