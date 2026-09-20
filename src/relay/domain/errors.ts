/**
 * Relay Domain Invariant Errors
 */

export class RelayDomainError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'RelayDomainError';
  }
}

export class DuplicateDeliveryAttemptError extends RelayDomainError {
  constructor(message = 'Cannot deliver assignment while another delivery is active or ambiguous') {
    super(message, 'DUPLICATE_DELIVERY_ATTEMPT');
  }
}

export class AmbiguousDeliveryResendError extends RelayDomainError {
  constructor(message = 'Cannot automatically resend an ambiguous delivery without reconciliation') {
    super(message, 'AMBIGUOUS_DELIVERY_RESEND_BLOCKED');
  }
}

export class InvalidStateTransitionError extends RelayDomainError {
  constructor(from: string, to: string, entity: string) {
    super(`Invalid transition for ${entity} from ${from} to ${to}`, 'INVALID_STATE_TRANSITION');
  }
}

export class MissingEvidenceError extends RelayDomainError {
  constructor(transition: string) {
    super(`Cannot complete transition '${transition}' without verified observable evidence`, 'MISSING_OBSERVABLE_EVIDENCE');
  }
}

export class PrematureAssignmentCompletionError extends RelayDomainError {
  constructor() {
    super('Handoff completion does not equal assignment completion', 'PREMATURE_ASSIGNMENT_COMPLETION');
  }
}

export class RuntimeNotAvailableError extends RelayDomainError {
  constructor(runtimeId: string, status: string) {
    super(`Runtime ${runtimeId} is not available (current status: ${status})`, 'RUNTIME_NOT_AVAILABLE');
  }
}
