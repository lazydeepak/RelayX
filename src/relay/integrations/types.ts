import {
  RuntimeSessionId,
  ObservableEvidence,
  ProviderType,
} from '../domain/types.ts';
import {
  IRuntimeProvider,
  RuntimeInspectionResult,
  DeliveryInstructionRequest,
  DeliveryInstructionResult,
} from '../providers/interfaces.ts';

export type AppRole = 'planner' | 'worker' | 'both';
export type AppType = 'app_bundle' | 'cli_service' | 'editor' | 'script';
export type AppLaunchBehavior =
  | 'open_bundle'
  | 'launch_url'
  | 'exec_cli'
  | 'applescript'
  | 'service_call';

/**
 * Standard capability identifiers. The Orchestration Engine queries capabilities,
 * not application or vendor names.
 */
export type IntegrationCapability =
  | 'APP_LAUNCH'
  | 'APP_ACTIVATE'
  | 'PROJECT_OPEN'
  | 'PROJECT_VERIFY'
  | 'SESSION_DISCOVER'
  | 'SESSION_CREATE'
  | 'SESSION_ACTIVATE'
  | 'SESSION_RENAME'
  | 'SESSION_VERIFY'
  | 'MESSAGE_SEND'
  | 'MESSAGE_OBSERVE'
  | 'RESPONSE_DETECT'
  | 'COMPLETION_DETECT'
  | 'MODEL_SELECT'
  | 'MODEL_VERIFY';

/** Standard manifest published by each integration adapter. */
export interface IntegrationManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  roles: AppRole[];
  capabilities: IntegrationCapability[];
  adapterType: 'native_builtin' | 'applescript' | 'cli' | 'rest_api' | 'websocket' | 'hybrid';
  appPath?: string;
  bundleId?: string;
  processName?: string;
  serviceUrl?: string;
  defaultLaunchBehavior?: AppLaunchBehavior;
  supportedModels?: string[];
  automationBreakdown?: {
    createSession?: string;
    renameSession?: string;
    sendMessage?: string;
    inspectSession?: string;
    discoverSessions?: string;
    verify?: string;
  };
}

/** 7-point readiness checklist for real-time verification and UI indicators. */
export interface ReadinessChecklist {
  applicationFound: boolean;
  accessibilityPermission: boolean;
  automationPermission: boolean;
  sessionCreation: boolean;
  sessionIdentity: boolean;
  messageSubmission: boolean;
  observation: boolean;
}

export interface IntegrationReadiness {
  ok: boolean;
  status: 'READY' | 'DEGRADED' | 'NOT_DETECTED' | 'UNCONFIGURED';
  message: string;
  lastVerifiedAt: number;
  checklist: ReadinessChecklist;
  details?: Record<string, unknown>;
}

/** Project-specific integration binding override */
export interface ProjectIntegrationOverride {
  projectId: string;
  plannerIntegrationId?: string | null;
  workerIntegrationId?: string | null;
  updatedAt?: number;
}

/** Structured script operation inputs and expected outputs. */
export interface ScriptOperationCreateSessionInput {
  projectPath?: string;
  projectName?: string;
  sessionTitle: string;
  bootstrapPrompt?: string;
  projectUrl?: string;
}

export interface ScriptOperationCreateSessionOutput {
  externalSessionId: string;
  title?: string;
  sessionUrl?: string;
  workspaceDir?: string;
}

export interface ScriptOperationDiscoverSessionsInput {
  projectPath?: string;
  gitRoot?: string;
}

export interface ScriptOperationDiscoverSessionsOutput {
  sessions: Array<{
    externalSessionId: string;
    title?: string;
    workspacePath?: string;
    windowTitle?: string;
  }>;
}

export interface ScriptOperationSendMessageInput {
  externalSessionId: string;
  instruction: string;
  idempotencyKey?: string;
}

export interface ScriptOperationSendMessageOutput {
  deliveryId?: string;
  outcome: 'delivered' | 'failed' | 'queued';
  message?: string;
}

export interface ScriptOperationInspectSessionInput {
  externalSessionId: string;
}

export interface ScriptOperationInspectSessionOutput {
  isWorking: boolean;
  isComplete: boolean;
  responseSummary?: string;
  windowTitle?: string;
}

export interface AppAutomationScripts {
  /** Shell command or AppleScript to launch or activate the application. */
  launchScript?: string;
  /** Script / command to create a new session. Placeholders: {projectPath}, {projectName}, {sessionTitle}. */
  createSessionScript?: string;
  /**
   * Editable ChatGPT-style Project discovery profile. Describes the exact GUI
   * sequence used to resolve an external Project identity, e.g.
   * `open https://chatgpt.com/projects` / `input {{projectName}}` / `Enter` /
   * `Tab x 7` / `Enter` / `capture current URL`.
   *
   * The Tab count is UI-dependent and changes without notice when the host app
   * ships a new UI, so it belongs here — in the integration configuration —
   * rather than in domain logic.
   */
  discoverProjectScript?: string;
  /** Script / command to focus or open an existing session. Placeholders: {externalSessionId}, {sessionTitle}, {projectPath}. */
  openSessionScript?: string;
  /** Script / command to send an instruction or message. Placeholders: {externalSessionId}, {instruction}, {idempotencyKey}. */
  sendMessageScript?: string;
  /** Script / command to inspect session state, returns JSON with isWorking, isComplete, visibleButtons. */
  inspectSessionScript?: string;
  /** Script / command to extract external session ID from stdout, window title, or service. */
  extractSessionScript?: string;
  /** Script / command to verify application readiness or CLI installation. */
  verificationScript?: string;
}

export interface AppIntegrationConfig {
  id: string;
  name: string;
  description?: string;
  role: AppRole;
  isEnabled: boolean;
  isDefaultPlanner: boolean;
  isDefaultWorker: boolean;
  isBuiltin: boolean;
  appType: AppType;

  // Host identification
  appPath?: string;
  bundleId?: string;
  processName?: string;
  windowTitlePattern?: string;
  launchBehavior: AppLaunchBehavior;
  serviceUrl?: string;
  cliCommand?: string;
  cliArguments?: string[];

  // Script definitions
  scripts: AppAutomationScripts;

  // Status & requirements
  status: 'verified' | 'degraded' | 'not_detected' | 'unconfigured';
  requirements: {
    accessibilityRequired: boolean;
    accessibilityGranted?: boolean;
    systemEventsRequired: boolean;
    systemEventsAvailable?: boolean;
    cliRequired?: boolean;
    cliInstalled?: boolean;
    serviceRequired?: boolean;
    serviceRunning?: boolean;
    notes?: string;
  };

  capabilities: {
    discoverProjects: boolean;
    discoverSessions: boolean;
    createSession: boolean;
    dispatchInstruction: boolean;
    captureTransportBoundary: boolean;
    reconcileExactSession: boolean;
    observeCompletion: boolean;
    extractResponse: boolean;
  };

  lastVerifiedAt?: number;
  lastVerificationResult?: {
    ok: boolean;
    message: string;
    details?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

export interface AppIntegrationSessionResult {
  externalSessionId: string;
  sessionUrl?: string;
  workspaceDir?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

/**
 * Driver / Adapter Contract.
 * Every third-party application implements this common interface.
 * The core orchestration engine sees ONLY this contract.
 */
export interface RelayIntegration {
  readonly id: string;
  readonly name: string;
  readonly roles: AppRole[];
  readonly config: AppIntegrationConfig;

  getManifest(): IntegrationManifest;
  verify(): Promise<IntegrationReadiness>;
  launch(projectPath?: string): Promise<{ ok: boolean; pid?: number; windowTitle?: string }>;
  discoverProjects?(context?: { workspaceRoot?: string }): Promise<Array<{ id: string; name: string; path: string }>>;
  discoverSessions(context: { projectPath: string; gitRoot?: string }): Promise<Array<{ externalSessionId: string; title?: string; workspacePath?: string; windowTitle?: string }>>;
  createSession(request: {
    projectId: string;
    projectName?: string;
    projectPath?: string;
    projectUrl?: string;
    sessionTitle: string;
    bootstrapPrompt?: string;
    conversationUrl?: string;
  }): Promise<AppIntegrationSessionResult>;
  renameSession?(session: { externalSessionId: string }, title: string): Promise<void>;
  sendMessage(
    session: { externalSessionId: string },
    message: { instruction: string; deliveryId?: string; idempotencyKey?: string },
  ): Promise<DeliveryInstructionResult>;
  inspectSession(session: { externalSessionId: string; runtimeSessionId?: string }): Promise<RuntimeInspectionResult>;
  detectCompletion?(observation: RuntimeInspectionResult): Promise<{ isComplete: boolean; responseSummary?: string }>;
  asRuntimeProvider(): IRuntimeProvider;
}

export interface IntegrationTestResult {
  ok: boolean;
  message: string;
  durationMs: number;
  steps: Array<{
    name: string;
    passed: boolean;
    durationMs: number;
    details?: string;
  }>;
}

export interface IAppIntegrationHandler extends RelayIntegration {
  openSession(sessionId: string, externalSessionId?: string | null, windowTitle?: string): Promise<boolean>;
  /**
   * Optional: re-push `config.scripts` onto the live runtime provider after the
   * configuration is edited. Implemented by handlers whose provider behaviour is
   * script-driven (e.g. ChatGPT Project discovery).
   */
  refreshProviderScripts?(): void;
}

/** Pre-configured templates for quick app onboarding via + Add App */
export interface AppIntegrationTemplate {
  name: string;
  description: string;
  role: AppRole;
  appType: AppType;
  launchBehavior: AppLaunchBehavior;
  defaultConfig: Partial<AppIntegrationConfig>;
}

export const APP_INTEGRATION_TEMPLATES: AppIntegrationTemplate[] = [
  {
    name: 'Claude Desktop (Planner)',
    description: 'Anthropic Claude desktop client on macOS. Orchestrates high-level planning and instructions.',
    role: 'planner',
    appType: 'app_bundle',
    launchBehavior: 'open_bundle',
    defaultConfig: {
      id: 'claude_desktop',
      name: 'Claude Desktop',
      appPath: '/Applications/Claude.app',
      bundleId: 'com.anthropic.claude-desktop',
      processName: 'Claude',
      windowTitlePattern: 'Claude*',
      scripts: {
        launchScript: 'tell application "Claude" to activate',
        createSessionScript: 'tell application "System Events" to tell process "Claude" to keystroke "n" using command down',
        sendMessageScript: 'tell application "System Events" to tell process "Claude"\n  keystroke "{instruction}"\n  key code 36\nend tell',
        inspectSessionScript: 'tell application "System Events" to tell process "Claude" to return (name of front window)',
      },
      requirements: {
        accessibilityRequired: true,
        systemEventsRequired: true,
        notes: 'Requires macOS Accessibility and System Events permissions for window focus and input injection',
      },
    },
  },
  {
    name: 'Cursor IDE (Worker)',
    description: 'Cursor AI-first Code Editor. Executes coding tasks, terminal commands, and edits in workspace.',
    role: 'worker',
    appType: 'editor',
    launchBehavior: 'exec_cli',
    defaultConfig: {
      id: 'cursor',
      name: 'Cursor AI Editor',
      appPath: '/Applications/Cursor.app',
      bundleId: 'com.todesktop.230313mzl4w4u92',
      processName: 'Cursor',
      cliCommand: 'cursor',
      cliArguments: ['--folder', '{projectPath}'],
      scripts: {
        launchScript: 'cursor "{projectPath}"',
        createSessionScript: 'cursor "{projectPath}"',
        openSessionScript: 'cursor "{projectPath}"',
        sendMessageScript: 'tell application "System Events" to tell process "Cursor"\n  keystroke "i" using command down\n  delay 0.5\n  keystroke "{instruction}"\n  key code 36\nend tell',
        inspectSessionScript: 'tell application "System Events" to tell process "Cursor" to return (name of front window)',
      },
      requirements: {
        accessibilityRequired: true,
        systemEventsRequired: true,
        cliRequired: true,
        notes: 'Requires `cursor` command in PATH and directory access permissions',
      },
    },
  },
  {
    name: 'Windsurf IDE (Worker)',
    description: 'Codeium Windsurf AI-powered coding editor with integrated Cascade agent execution.',
    role: 'worker',
    appType: 'editor',
    launchBehavior: 'exec_cli',
    defaultConfig: {
      id: 'windsurf',
      name: 'Windsurf IDE',
      appPath: '/Applications/Windsurf.app',
      bundleId: 'com.codeium.windsurf',
      processName: 'Windsurf',
      cliCommand: 'windsurf',
      cliArguments: ['{projectPath}'],
      scripts: {
        launchScript: 'windsurf "{projectPath}"',
        createSessionScript: 'windsurf "{projectPath}"',
        openSessionScript: 'windsurf "{projectPath}"',
        sendMessageScript: 'tell application "System Events" to tell process "Windsurf"\n  keystroke "l" using command down\n  delay 0.5\n  keystroke "{instruction}"\n  key code 36\nend tell',
      },
      requirements: {
        accessibilityRequired: true,
        systemEventsRequired: true,
        cliRequired: true,
      },
    },
  },
  {
    name: 'Custom CLI / Service Agent',
    description: 'Local background HTTP daemon or custom CLI coding agent (e.g. Aider, Goose, Auto-GPT).',
    role: 'worker',
    appType: 'cli_service',
    launchBehavior: 'exec_cli',
    defaultConfig: {
      id: 'custom_cli_agent',
      name: 'Custom CLI Agent',
      cliCommand: 'python3 -m my_agent',
      serviceUrl: 'http://127.0.0.1:8000',
      scripts: {
        launchScript: 'python3 -m my_agent --workspace "{projectPath}"',
        createSessionScript: 'curl -X POST "{serviceUrl}/sessions" -d "{\\"title\\": \\"{sessionTitle}\\", \\"path\\": \\"{projectPath}\\"}"',
        sendMessageScript: 'curl -X POST "{serviceUrl}/sessions/{externalSessionId}/messages" -d "{\\"text\\": \\"{instruction}\\"}"',
        inspectSessionScript: 'curl -s "{serviceUrl}/sessions/{externalSessionId}/status"',
      },
      requirements: {
        accessibilityRequired: false,
        systemEventsRequired: false,
        serviceRequired: true,
        cliRequired: true,
      },
    },
  },
  {
    name: 'Custom AppleScript UI Automation',
    description: 'Arbitrary native macOS application automated through AppleScript and UI scripting.',
    role: 'both',
    appType: 'script',
    launchBehavior: 'applescript',
    defaultConfig: {
      id: 'custom_ui_app',
      name: 'Custom macOS App',
      scripts: {
        launchScript: 'tell application "YourApp" to activate',
        createSessionScript: 'tell application "System Events" to tell process "YourApp"\n  keystroke "n" using command down\nend tell',
        sendMessageScript: 'tell application "System Events" to tell process "YourApp"\n  keystroke "{instruction}"\n  key code 36\nend tell',
        inspectSessionScript: 'tell application "System Events" to tell process "YourApp" to return (name of front window)',
      },
      requirements: {
        accessibilityRequired: true,
        systemEventsRequired: true,
      },
    },
  },
];
