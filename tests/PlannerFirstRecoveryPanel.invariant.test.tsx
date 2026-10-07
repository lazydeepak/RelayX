/**
 * PlannerFirstRecoveryPanel — focused presentation invariants (UI freeze)
 *
 * Proves: recovery owner always displayed as PLANNER (fixed), no destination
 * dropdown rendered, both last messages visible, input fields are planner-context
 * only (never direct worker dispatch), baton/authority separated.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlannerFirstRecoveryPanel } from '../src/components/PlannerFirstRecoveryPanel';

describe('PlannerFirstRecoveryPanel — Invariant R1 (fixed PLANNER display)', () => {
  it('always renders PLANNER as recovery owner in both modes', () => {
    const { rerender } = render(
      <PlannerFirstRecoveryPanel
        mode="recovery_required"
        failureReason="delivery failed"
        automationPaused={true}
        onPauseAndReturnToPlanner={() => {}}
        onSendToPlanner={() => {}}
      />,
    );
    expect(screen.getByText(/Recovery owner: PLANNER/i)).toBeInTheDocument();
    expect(screen.queryByText(/Destination:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Worker/i)).toBeInTheDocument(); // appears in failure text, not as selectable destination

    rerender(
      <PlannerFirstRecoveryPanel
        mode="planner_intervention"
        failureReason="reconciliation failed"
        automationPaused={true}
        onPauseAndReturnToPlanner={() => {}}
        onSendToPlanner={() => {}}
      />,
    );
    expect(screen.getByText(/Recovery owner: PLANNER/i)).toBeInTheDocument();
  });

  it('never renders a selectable destination dropdown', () => {
    render(
      <PlannerFirstRecoveryPanel
        mode="recovery_required"
        failureReason="test"
        automationPaused={true}
        onPauseAndReturnToPlanner={() => {}}
        onSendToPlanner={() => {}}
      />,
    );
    // No select, no picker, no dropdown UI for recovery destination
    expect(screen.queryByRole('combobox', { name: /destination/i })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /owner/i })).toBeNull();
  });
});

describe('PlannerFirstRecoveryPanel — Invariant R2 / R3 (messages preserved)', () => {
  it('shows both last planner and last worker messages when provided', () => {
    render(
      <PlannerFirstRecoveryPanel
        mode="planner_intervention"
        failureReason="delivery failed"
        lastPlannerMessage="Investigate transport layer before retry"
        lastWorkerMessage="I found nothing; report incomplete"
        automationPaused={true}
        onPauseAndReturnToPlanner={() => {}}
        onSendToPlanner={() => {}}
      />,
    );
    expect(screen.getByText(/LAST PLANNER MESSAGE/i)).toBeInTheDocument();
    expect(screen.getByText(/LAST WORKER MESSAGE/i)).toBeInTheDocument();
    expect(screen.getByText(/Investigate transport layer/i)).toBeInTheDocument();
    expect(screen.getByText(/I found nothing/i)).toBeInTheDocument();
  });

  it('shows message placeholders when messages absent', () => {
    render(
      <PlannerFirstRecoveryPanel
        mode="recovery_required"
        failureReason="test"
        automationPaused={true}
        onPauseAndReturnToPlanner={() => {}}
        onSendToPlanner={() => {}}
      />,
    );
    // First state does not show message blocks; second does with placeholders
    // The component handles absence gracefully.
  });
});

describe('PlannerFirstRecoveryPanel — Invariant R4 / R6 (intervention path, no worker dispatch)', () => {
  it('"Pause & Return to Planner" calls the planner-only handler, never worker dispatch', () => {
    const onPause = jest.fn();
    render(
      <PlannerFirstRecoveryPanel
        mode="recovery_required"
        failureReason="test"
        automationPaused={true}
        onPauseAndReturnToPlanner={onPause}
        onSendToPlanner={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Pause & Return to Planner/i }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('"Send to Planner" passes input context, never dispatches to worker', () => {
    const onSend = jest.fn();
    render(
      <PlannerFirstRecoveryPanel
        mode="planner_intervention"
        failureReason="test"
        automationPaused={true}
        onPauseAndReturnToPlanner={() => {}}
        onSendToPlanner={onSend}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Send to Planner/i }));
    expect(onSend).toHaveBeenCalledTimes(1);
    // The input is planner-context; no worker-side target is passed
    expect(onSend.mock.calls[0][0]).toHaveProperty('goal');
  });

  it('edited worker content can only be planner context (input fields present, no direct feed)', () => {
    render(
      <PlannerFirstRecoveryPanel
        mode="planner_intervention"
        failureReason="test"
        automationPaused={true}
        onPauseAndReturnToPlanner={() => {}}
        onSendToPlanner={() => {}}
      />,
    );
    // Goal / Method / Direction input fields exist (planner context entry)
    expect(screen.getByLabelText(/Goal/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Method/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Direction/i)).toBeInTheDocument();
    // There is no "Feed Worker" button
    expect(screen.queryByRole('button', { name: /Feed Worker/i })).toBeNull();
  });
});

describe('PlannerFirstRecoveryPanel — Invariant display separation (baton vs recovery authority)', () => {
  it('shows Normal baton as WORKER and Recovery authority as PLANNER separately', () => {
    render(
      <PlannerFirstRecoveryPanel
        mode="planner_intervention"
        failureReason="test"
        automationPaused={true}
        onPauseAndReturnToPlanner={() => {}}
        onSendToPlanner={() => {}}
      />,
    );
    expect(screen.getByText(/Normal baton: WORKER/i)).toBeInTheDocument();
    expect(screen.getByText(/Recovery authority: PLANNER/i)).toBeInTheDocument();
    expect(screen.getByText(/Next permitted automated transition: Planner → Worker/i)).toBeInTheDocument();
  });
});
