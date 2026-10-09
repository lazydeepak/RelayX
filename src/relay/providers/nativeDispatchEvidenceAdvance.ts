import type { SqliteNativeDispatchClaimRepository } from '../persistence/sqlite/SqliteNativeDispatchClaimRepository';
import type { SqliteNativeDispatchReconciliationRepository } from '../persistence/sqlite/SqliteNativeDispatchReconciliationRepository';
import type { SqliteNativeExecutionObservationRepository } from '../persistence/sqlite/SqliteNativeExecutionObservationRepository';
import type { SqliteNativeExecutionTerminalRepository } from '../persistence/sqlite/SqliteNativeExecutionTerminalRepository';

export type NativeDispatchEvidenceState =
  | 'WAITING_DELIVERY_EVIDENCE'
  | 'DELIVERY_AMBIGUOUS'
  | 'DELIVERY_CONFIRMED_WAITING_EXECUTION'
  | 'EXECUTION_RUNNING'
  | 'EXECUTION_COMPLETED_PHYSICAL'
  | 'EXECUTION_INTERRUPTED';

export type NativeDispatchEvidenceBlocker =
  | 'CLAIM_NOT_FOUND'
  | 'DELIVERY_EVIDENCE_INVALID'
  | 'EXECUTION_EVIDENCE_INVALID'
  | 'TERMINAL_EVIDENCE_INVALID';

/**
 * Deterministically advances one already-claimed dispatch from durable provider
 * observations. Each repository owns its own atomic transition, so a crash between
 * stages is resumed by calling this function again. This function never sends.
 */
export function advanceNativeDispatchEvidence(stores: {
  claims: SqliteNativeDispatchClaimRepository;
  reconciliations: SqliteNativeDispatchReconciliationRepository;
  executions: SqliteNativeExecutionObservationRepository;
  terminals: SqliteNativeExecutionTerminalRepository;
}, dispatchKey: string): { status: 'ADVANCED'; state: NativeDispatchEvidenceState }
  | { status: 'BLOCKED'; reason: NativeDispatchEvidenceBlocker } {
  if (!stores.claims.get(dispatchKey)) return { status: 'BLOCKED', reason: 'CLAIM_NOT_FOUND' };
  const terminal = stores.terminals.get(dispatchKey);
  if (terminal) return { status: 'ADVANCED', state: terminal.outcome === 'COMPLETED_PHYSICAL'
    ? 'EXECUTION_COMPLETED_PHYSICAL' : 'EXECUTION_INTERRUPTED' };
  let delivery;
  try { delivery = stores.reconciliations.reconcile(dispatchKey); }
  catch (error) {
    if (error instanceof Error && error.message === 'Post-claim transcript unavailable') {
      return { status: 'ADVANCED', state: 'WAITING_DELIVERY_EVIDENCE' };
    }
    return { status: 'BLOCKED', reason: 'DELIVERY_EVIDENCE_INVALID' };
  }
  if (delivery.verdict === 'AMBIGUOUS') return { status: 'ADVANCED', state: 'DELIVERY_AMBIGUOUS' };
  let execution;
  try { execution = stores.executions.observe(dispatchKey); }
  catch { return { status: 'BLOCKED', reason: 'EXECUTION_EVIDENCE_INVALID' }; }
  if (!execution.observed) return { status: 'ADVANCED', state: 'DELIVERY_CONFIRMED_WAITING_EXECUTION' };
  try {
    const observed = stores.terminals.observe(dispatchKey);
    if (!observed.terminal) return { status: 'ADVANCED', state: 'EXECUTION_RUNNING' };
    return { status: 'ADVANCED', state: observed.observation!.outcome === 'COMPLETED_PHYSICAL'
      ? 'EXECUTION_COMPLETED_PHYSICAL' : 'EXECUTION_INTERRUPTED' };
  } catch { return { status: 'BLOCKED', reason: 'TERMINAL_EVIDENCE_INVALID' }; }
}
