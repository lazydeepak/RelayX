import {
  AssignmentStatus,
  AssignmentPriority,
  AttemptStatus,
  RuntimeSessionStatus,
  DeliveryStatus,
  HandoffStatus,
  AttentionSeverity,
  AttentionStatus,
  ProviderType,
  ProviderIntegrationStatus,
  ObservableEvidence,
} from '../relay/domain/types.ts';

export type {
  AssignmentStatus,
  AssignmentPriority,
  AttemptStatus,
  RuntimeSessionStatus,
  DeliveryStatus,
  HandoffStatus,
  AttentionSeverity,
  AttentionStatus,
  ProviderType,
  ProviderIntegrationStatus,
  ObservableEvidence,
};

export type NavTab =
  | 'dashboard'
  | 'pairs'
  | 'sessions'
  | 'assignments'
  | 'timeline'
  | 'attention'
  | 'diagnostics'
  | 'integrations'
  | 'settings';

export interface UIProject {
  id: string;
  name: string;
  description: string;
  canonicalPath?: string;
  gitRoot?: string;
  /** Persisted ChatGPT planner project binding (URL) set when the project was created. */
  plannerProjectUrl?: string;
  /** Persisted OpenCode/VS Code worker workspace binding (path) set when the project was created. */
  workerWorkspacePath?: string;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt?: number;
}

export interface UIPair {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  plannerSessionId?: string;
  workerSessionId?: string;
  plannerName?: string;
  plannerProvider?: ProviderType;
  plannerStatus?: RuntimeSessionStatus;
  plannerUrl?: string;
  workerName?: string;
  workerProvider?: ProviderType;
  workerStatus?: RuntimeSessionStatus;
  activeAssignmentId?: string;
  activeAssignmentTitle?: string;
  activeAssignmentStatus?: AssignmentStatus;
  activeAssignmentPriority?: AssignmentPriority;
  deliveryStatus?: DeliveryStatus;
  deliveryEvidence?: ObservableEvidence;
  handoffStatus?: HandoffStatus;
  handoffSummary?: string;
  status: 'idle' | 'active' | 'paused' | 'recovering' | 'blocked' | 'archived';
  operationalState?: 'IDLE' | 'ACTIVE';
  relayState?: 'STOPPED' | 'RUNNING' | 'PAUSED';
  lastSupervisedAt?: number;
}

export interface UIRuntimeSession {
  id: string;
  providerType: ProviderType;
  name: string;
  bundleIdentifier?: string;
  windowTitle?: string;
  applicationPid?: number;
  status: RuntimeSessionStatus;
  consecutiveObservationFailures: number;
  integrationStatus?: ProviderIntegrationStatus;
  lastHeartbeatAt?: number;
  lastObservedAt?: number;
  lastEvidence?: ObservableEvidence;
  archivedAt?: number;
  archiveReason?: string;
  createdAt?: number;
  updatedAt?: number;
  externalSessionId?: string | null;
  externalProjectRef?: string | null;
  sessionUrl?: string | null;
}

export interface UIAssignment {
  id: string;
  pairId: string;
  pairName: string;
  projectId: string;
  title: string;
  instruction: string;
  priority: AssignmentPriority;
  status: AssignmentStatus;
  currentAttemptNumber?: number;
  activeDeliveryStatus?: DeliveryStatus;
  activeHandoffStatus?: HandoffStatus;
  createdAt: number;
  completedAt?: number;
  updatedAt?: number;
  targetSideRole?: 'planner' | 'worker';
  source?: 'manual' | 'handoff' | 'other';
  currentAttemptId?: string;
  currentAttemptStatus?: 'prepared' | 'running' | 'completed_physical' | 'interrupted';
  currentAttemptStartedAt?: number;
  currentAttemptFinishedAt?: number;
  currentAttemptFailureReason?: string;
  currentAttemptEvidence?: ObservableEvidence;
  deliveryStatus?: DeliveryStatus;
  deliveryEvidence?: ObservableEvidence;
  deliveryFailureReason?: string;
  attentionStatus?: 'open' | 'acknowledged' | 'resolved';
  attentionCount?: number;
  attentionTitle?: string;
  attentionMessage?: string;
  pairStatus?: string;
  pairOperationalState?: 'IDLE' | 'ACTIVE';
  pairRelayState?: 'STOPPED' | 'RUNNING' | 'PAUSED';
  blockerReason?: string;
}

export interface UIEvent {
  id: string;
  timestamp: number;
  resourceType: string;
  resourceId: string;
  eventType: string;
  actor: string;
  previousState?: string;
  newState?: string;
  correlationId?: string;
  evidence?: ObservableEvidence;
  details?: Record<string, unknown>;
  severity?: 'info' | 'warn' | 'error' | 'critical';
  area?: string;
  outcome?: string;
  isArchived?: boolean;
}

export interface UIFilteredEventsResult {
  events: UIEvent[];
  total: number;
  offset?: number;
  limit?: number;
}

export interface UIActivityRecord {
  id: string;
  timestamp: number;
  title: string;
  summary: string;
  category: string;
  status: string;
  resourceType: string;
  resourceId: string;
  correlationId?: string;
  evidence?: ObservableEvidence;
  details?: Record<string, unknown>;
}

export interface ArchivePolicy {
  interval: string;
  effectiveRetentionDays: number | null;
  note?: string | null;
  updatedAt?: number;
}

export interface ClearLogsResult {
  clearedCount: number;
  remainingCount: number;
  cutoffTimestamp?: number;
}

export interface AuxiliaryLogInfo {
  name: string;
  path: string;
  sizeBytes: number;
  lineCount: number;
  exists: boolean;
  lastModified?: number;
}

export interface StorageAccounting {
  databaseSizeBytes: number;
  databaseType: string;
  databasePath: string;
  totalEvents: number;
  activeEvents: number;
  archivedEvents: number;
  totalActivities: number;
  totalCheckpoints: number;
  totalAttentionItems: number;
  traceLogs: AuxiliaryLogInfo[];
  totalStorageBytes: number;
}

export interface AuditExportBundle {
  exportedAt: number;
  version: string;
  environment: {
    isElectron: boolean;
    databaseType: string;
  };
  counts: {
    projects: number;
    pairs: number;
    runtimeSessions: number;
    assignments: number;
    deliveries: number;
    events: number;
    activities: number;
    checkpoints: number;
    attentionItems: number;
  };
  projects: any[];
  pairs: any[];
  runtimeSessions: any[];
  assignments: any[];
  events: UIEvent[];
  activities: any[];
  checkpoints: any[];
  attentionItems: any[];
  storageAccounting?: StorageAccounting;
}

export interface UIAttentionItem {
  id: string;
  pairId?: string;
  assignmentId?: string;
  deliveryId?: string;
  /** Number of ambiguous deliveries for the assignment; set when >1 so the UI can explain withheld recovery. */
  ambiguousDeliveryCount?: number;
  severity: AttentionSeverity;
  status: AttentionStatus;
  type: string;
  title: string;
  message: string;
  suggestedAction?: string;
  suggestedTier?: string;
  createdAt: number;
  evidence?: ObservableEvidence;
}
