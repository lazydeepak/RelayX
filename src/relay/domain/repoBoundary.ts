/* Minimal deterministic repository observation and classification (Slice 3) */
import { Attempt } from '../domain/entities.ts';
import type { RuntimeSessionId, ProjectId, AttemptId } from '../domain/types.ts';

export type RepoClassification =
  | 'no_change'
  | 'consistent_with_assignment'
  | 'unrelated_change'
  | 'ambiguous_collision'
  | 'baseline_diverged';

export interface RepoObservationResult {
  classification: RepoClassification;
  baselineHead?: string;
  observedHead?: string;
  changedFiles?: string[];
  newFiles?: string[];
  removedFiles?: string[];
  evidence?: Record<string, unknown>;
}

export interface RepoBaselineReference {
  repoRoot?: string;
  gitRoot?: string;
  headCommit?: string;
  dirtyState?: boolean;
  dirtyFiles?: string[];
  untrackedFiles?: string[];
  expectedWrites?: string[];
  dependencyInputs?: string[];
  capturedAt: number;
}

export interface VerificationResult {
  id: string;
  attemptId: string;
  checkId?: string;
  result: 'passed' | 'failed' | 'blocked' | 'not_run';
  evidence?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
