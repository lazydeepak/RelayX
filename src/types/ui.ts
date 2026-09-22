import {
  AssignmentStatus,
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
  | 'settings';

export interface UIProject {
  id: string;
  name: string;
  description: string;
  canonicalPath?: string;
  gitRoot?: string;
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
  workerName?: string;
  workerProvider?: ProviderType;
  workerStatus?: RuntimeSessionStatus;
  activeAssignmentId?: string;
  activeAssignmentTitle?: string;
  activeAssignmentStatus?: AssignmentStatus;
  deliveryStatus?: DeliveryStatus;
  deliveryEvidence?: ObservableEvidence;
  handoffStatus?: HandoffStatus;
  handoffSummary?: string;
  status: 'idle' | 'active' | 'paused' | 'recovering' | 'blocked' | 'archived';
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
}

export interface UIAssignment {
  id: string;
  pairId: string;
  pairName: string;
  projectId: string;
  title: string;
  instruction: string;
  status: AssignmentStatus;
  currentAttemptNumber?: number;
  activeDeliveryStatus?: DeliveryStatus;
  activeHandoffStatus?: HandoffStatus;
  createdAt: number;
  completedAt?: number;
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
}

export interface UIAttentionItem {
  id: string;
  pairId?: string;
  assignmentId?: string;
  deliveryId?: string;
  severity: AttentionSeverity;
  status: AttentionStatus;
  type: string;
  title: string;
  message: string;
  suggestedAction?: string;
  suggestedTier?: string;
  createdAt: number;
}
