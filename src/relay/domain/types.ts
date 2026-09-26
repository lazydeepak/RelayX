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
export type AssociationId = Brand<string, 'AssociationId'>;
export type RecoveryActionId = Brand<string, 'RecoveryActionId'>;

/* --- Plan-First identifiers (PLAN_FIRST_DOMAIN_FREEZE.md §A) --- */
export type ContractRevisionId = Brand<string, 'ContractRevisionId'>;
export type PlanFirstRunId = Brand<string, 'PlanFirstRunId'>;
export type WorkUnitId = Brand<string, 'WorkUnitId'>;
export type VerificationResultId = Brand<string, 'VerificationResultId'>;

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
  | 'prepared'
  | 'running'
  | 'completed_physical'
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

export type ProviderType = 'chatgpt' | 'opencode' | 'vscode' | 'generic_ui';

export type ProviderIntegrationStatus = 'real' | 'partial' | 'unsupported';

export type VerificationState = 'verified' | 'unverified' | 'manual' | 'stale';

export type AssociationProvenance = 'discovery' | 'adoption' | 'manual_registration' | 'pair_binding' | 'setup';

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

export type VerificationStatus = 'not_run' | 'passed' | 'failed' | 'blocked';

export type PlannerActionResult = 'pending' | 'applied' | 'rejected_stale' | 'rejected_unauthorized' | 'rejected_invalid_transition' | 'duplicate';
export type PlannerAssistanceStatus = 'open' | 'resolved' | 'stale';

/* --- Plan-First lifecycle states (PLAN_FIRST_DOMAIN_FREEZE.md §C) --- */

/** draft -> approved (terminal). Content is immutable from creation. */
export type ContractRevisionStatus = 'draft' | 'approved';

export const PLAN_FIRST_RUN_TERMINAL_STATES: readonly PlanFirstRunStatus[] = [
  'completed',
  'cancelled',
] as const;

export type PlanFirstRunStatus = 'ready' | 'running' | 'blocked' | 'completed' | 'cancelled';

export const WORK_UNIT_TERMINAL_STATES: readonly WorkUnitStatus[] = ['completed'] as const;

export type WorkUnitStatus = 'pending' | 'in_progress' | 'blocked' | 'completed';
