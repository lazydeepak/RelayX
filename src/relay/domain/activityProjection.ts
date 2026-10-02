import { RelayEvent } from './entities.ts';
import { ActivityRecord } from './types.ts';

export function projectEventToActivity(event: RelayEvent): ActivityRecord {
  let category = 'system';
  let title = formatTitle(event.eventType);
  let summary = '';
  let status = 'info';

  if (event.severity === 'critical' || event.severity === 'error') {
    status = 'failed';
  } else if (event.severity === 'warn') {
    status = 'warning';
  } else if (
    event.eventType.endsWith('.completed') ||
    event.eventType.endsWith('.confirmed') ||
    event.eventType.endsWith('.complete') ||
    event.outcome === 'delivered' ||
    event.outcome === 'completed'
  ) {
    status = 'completed';
  } else if (event.eventType.endsWith('.started') || event.eventType.endsWith('.in_progress')) {
    status = 'in_progress';
  }

  const details = event.details || {};
  const nameStr = (details.name as string) || (details.title as string) || '';

  switch (event.resourceType) {
    case 'project':
      category = 'lifecycle';
      if (event.eventType === 'project.created') {
        title = 'Project Created';
        summary = nameStr ? `Project "${nameStr}" initialized` : `Project ${event.resourceId} initialized`;
      } else if (event.eventType === 'project.archived') {
        title = 'Project Archived';
        summary = `Project ${event.resourceId} transitioned to archived state`;
      } else if (event.eventType === 'project.deleted') {
        title = 'Project Deleted';
        summary = `Project ${event.resourceId} removed from registry`;
      } else {
        summary = `Project ${event.resourceId} updated`;
      }
      break;

    case 'pair':
      if (event.eventType.includes('checkpoint')) {
        category = 'checkpoint';
        title = 'Checkpoint Established';
        summary = (details.summary as string) || `Pair ${event.resourceId} state checkpointed`;
      } else if (event.eventType === 'pair.archived') {
        category = 'lifecycle';
        title = 'Pair Archived';
        summary = `Pair ${event.resourceId} archived with final state preserved`;
      } else {
        category = 'execution';
        if (event.eventType === 'pair.created') {
          title = 'Pair Formed';
          summary = nameStr ? `Pair "${nameStr}" created` : `Pair ${event.resourceId} created`;
        } else if (event.eventType === 'pair.activated') {
          title = 'Pair Activated';
          summary = `Pair ${event.resourceId} became active and ready for work`;
        } else if (event.eventType === 'pair.paused') {
          title = 'Pair Paused';
          summary = `Pair execution paused by operator`;
        } else if (event.eventType === 'pair.stopped') {
          title = 'Pair Stopped';
          summary = `Pair execution stopped`;
        } else {
          summary = `Pair ${event.resourceId} state changed (${event.eventType})`;
        }
      }
      break;

    case 'assignment':
      category = 'assignment';
      if (event.eventType === 'assignment.created') {
        title = 'Assignment Created';
        summary = nameStr ? `Assignment "${nameStr}" assigned to pair` : `Assignment ${event.resourceId} created`;
      } else if (event.eventType === 'assignment.completed') {
        title = 'Assignment Completed';
        summary = `Assignment ${event.resourceId} verified and completed`;
      } else if (event.eventType === 'assignment.cancelled') {
        title = 'Assignment Cancelled';
        summary = `Assignment ${event.resourceId} cancelled`;
      } else {
        summary = `Assignment ${event.resourceId} ${event.eventType}`;
      }
      break;

    case 'delivery':
      category = 'delivery';
      if (event.eventType === 'delivery.started') {
        title = 'Delivery Dispatched';
        summary = `Prompt delivery dispatched to worker`;
      } else if (event.eventType === 'delivery.confirmed') {
        title = 'Delivery Confirmed';
        summary = `Worker confirmed receipt of instruction delivery`;
      } else if (event.eventType === 'delivery.failed') {
        title = 'Delivery Failed';
        summary = (details.error as string) || `Worker delivery rejected or failed`;
      } else if (event.eventType === 'delivery.ambiguous') {
        title = 'Ambiguous Delivery Alert';
        summary = `Delivery dispatch outcome unconfirmed; operator attention required`;
      } else if (event.eventType === 'delivery.reconciled') {
        title = 'Delivery Reconciled';
        summary = `Ambiguous delivery resolved deterministically`;
      } else {
        summary = `Delivery ${event.resourceId} updated`;
      }
      break;

    case 'handoff':
      category = 'delivery';
      if (event.eventType === 'handoff.received') {
        title = 'Handoff Received';
        summary = `Worker produced handoff response payload`;
      } else if (event.eventType === 'handoff.complete') {
        title = 'Handoff Completed';
        summary = `Handoff verified and accepted by planner`;
      } else {
        summary = `Handoff ${event.resourceId} ${event.eventType}`;
      }
      break;

    case 'runtime':
      category = 'runtime';
      if (event.eventType === 'runtime.registered' || event.eventType === 'runtime.discovered') {
        title = 'Runtime Discovered';
        summary = `Runtime session observed (${details.providerType || 'unknown provider'})`;
      } else if (event.eventType === 'runtime.suspended') {
        title = 'Runtime Suspended';
        summary = `Runtime session suspended after failure threshold exceeded`;
      } else if (event.eventType === 'runtime.recovered') {
        title = 'Runtime Recovered';
        summary = `Runtime probe successful; session restored`;
      } else if (event.eventType === 'runtime.attached') {
        title = 'Runtime Bound to Pair';
        summary = `Session attached to pair`;
      } else if (event.eventType === 'runtime.detached') {
        title = 'Runtime Detached';
        summary = `Session unlinked from pair`;
      } else {
        summary = `Runtime ${event.resourceId} ${event.eventType}`;
      }
      break;

    case 'attention':
      category = 'attention';
      title = 'Attention Item Raised';
      summary = (details.title as string) || (details.message as string) || `Anomaly detected requiring supervision`;
      break;

    default:
      category = event.resourceType;
      summary = `Lineage event ${event.eventType} on ${event.resourceType}:${event.resourceId}`;
      break;
  }

  return {
    id: `act_${event.id}`,
    timestamp: event.timestamp,
    title,
    summary,
    category,
    status,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    correlationId: event.correlationId,
    evidence: event.evidence,
    details: event.details,
  };
}

function formatTitle(eventType: string): string {
  const parts = eventType.split(/[._]/);
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}
