/**
 * Relay Domain Core Types & Strong Identifiers
 * macOS-first AI work orchestration control plane
 */

export type Brand<T, B> = T & { readonly __brand: B };

export type ProjectId = Brand<string, 'ProjectId'>;
export type PairId = Brand<string, 'PairId'>;
export type PlannerId = Brand<string, 'PlannerId'>;
export type WorkerId = Brand<string, 'WorkerId'>;
export type RuntimeSessionId = Brand<string, 'RuntimeSessionId'>;
export type AssignmentId = Brand<string, 'AssignmentId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type DeliveryId = Brand<string, 'DeliveryId'>;
export type HandoffId = Brand<string, 'HandoffId'>;
export type EventId = Brand<string, 'EventId'>;
export type AttentionItemId = Brand<string, 'AttentionItemId'>;
export type RecoveryActionId = Brand<string, 'RecoveryActionId'>;

export const createId = <T extends Brand<string, string>>(prefix: string): T => {
  const rand = Math.random().toString(36).substring(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${rand}` as T;
};

/* --- Lifecycle States --- */

export type ProjectStatus = 'active' | 'archived';

export type PairStatus =
  | 'idle'
  | 'active'
  | 'paused'
  | 'recovering'
  | 'blocked'
  | 'archived';

export type AssignmentStatus =
  | 'pending'
  | 'active'
  | 'waiting_for_handoff'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AttemptStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type RuntimeSessionStatus =
  | 'unknown'
  | 'available'
  | 'working'
  | 'idle'
  | 'suspended'
  | 'unavailable'
  | 'terminated'
  | 'archived';

export type DeliveryStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'ambiguous'
  | 'failed';

export type HandoffStatus =
  | 'pending'
  | 'ready'
  | 'delivered'
  | 'complete'
  | 'suspended';

export type AttentionSeverity = 'info' | 'warning' | 'critical';

export type AttentionStatus = 'open' | 'acknowledged' | 'resolved';

export type RecoveryTier = 'tier_1_deterministic' | 'tier_2_planner_assisted' | 'tier_3_ai_agent';

export type ProviderType = 'chatgpt' | 'opencode' | 'vscode' | 'generic_ui' | 'mock';

export type ProviderIntegrationStatus = 'real' | 'partial' | 'mock' | 'unsupported';

/* --- Observable UI Evidence Model --- */

export interface ObservableEvidence {
  id: string;
  timestamp: number;
  source:
    | 'macos_accessibility'
    | 'macos_system_events'
    | 'applescript'
    | 'system_events'
    | 'window_inspection'
    | 'filesystem_heartbeat'
    | 'reconciliation_probe';
  windowTitle?: string;
  applicationPid?: number;
  bundleIdentifier?: string;
  runtimeSessionId?: RuntimeSessionId;
  visibleButtonState?: {
    sendButtonVisible?: boolean;
    stopButtonVisible?: boolean;
    cancelButtonVisible?: boolean;
  };
  composerSignature?: string;
  composerCleared?: boolean;
  responseActivityObserved?: boolean;
  screenshotRef?: string;
  accessibilityElementId?: string;
  details?: Record<string, unknown>;
}

/* --- Heartbeat & Filesystem Signaling --- */

export interface FilesystemSignalingHeartbeat {
  schemaVersion: '1.0';
  runtimeId: string;
  assignmentId?: string;
  state: RuntimeSessionStatus;
  timestamp: number;
  sequence: number;
  source: string;
  processPid?: number;
}
