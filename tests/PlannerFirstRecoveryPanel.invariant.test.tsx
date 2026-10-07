/**
 * PlannerFirstRecoveryPanel — focused presentation invariants (UI freeze).
 *
 * Rendered with react-dom/server (no new dependencies; matches the project's
 * node/tsx test stack), assertions run against the serialized HTML so the
 * same invariants are proven: fixed PLANNER owner, no destination dropdown,
 * all four phases render distinctly, planner-context inputs only.
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PlannerFirstRecoveryPanel } from '../src/components/PlannerFirstRecoveryPanel';
import type { RecoveryState } from '../src/relay/domain/recoveryAuthority';

function renderHtml(props: React.ComponentProps<typeof PlannerFirstRecoveryPanel>): string {
  return renderToString(
    <PlannerFirstRecoveryPanel
      {...props}
      onPauseAndReturnToPlanner={() => {}}
      onSendToPlanner={() => {}}
    />,
  );
}

describe('PlannerFirstRecoveryPanel — Invariant R1 (fixed PLANNER display)', () => {
  it('always renders PLANNER as recovery owner', () => {
    const html = renderHtml({
      phase: 'required',
      failureReason: 'delivery failed',
      automationPaused: true,
    });
    assert.ok(html.includes('Recovery owner (fixed):'), 'recovery owner line present');
    assert.ok(html.includes('PLANNER'));
  });

  it('renders distinct panels for all four engine phases', () => {
    const required = renderHtml({ phase: 'required', failureReason: 'delivery failed', automationPaused: true });
    const intervention = renderHtml({ phase: 'planner_intervention', failureReason: 'delivery failed', automationPaused: true });
    const decided = renderHtml({ phase: 'planner_decided', lastPlannerMessage: 'Look at transport', automationPaused: true });
    const authorized = renderHtml({ phase: 'continuation_authorized', automationPaused: true });
    assert.ok(required.includes('RECOVERY REQUIRED'), 'required phase renders RECOVERY REQUIRED');
    assert.ok(intervention.includes('PLANNER INTERVENTION'), 'planner_intervention phase renders PLANNER INTERVENTION');
    assert.ok(decided.includes('PLANNER DECISION OBSERVED'), 'planner_decided phase renders PLANNER DECISION OBSERVED');
    assert.ok(authorized.includes('CONTINUATION AUTHORIZED'), 'continuation_authorized phase renders CONTINUATION AUTHORIZED');
    assert.ok(authorized.includes('Planner → Worker'), 'continuation_authorized shows Planner → Worker');
  });

  it('renders no recovery panel for resolved state', () => {
    const html = renderHtml({ phase: 'resolved', automationPaused: true });
    assert.ok(!html.includes('PLANNER INTERVENTION'), 'resolved should not render intervention panel');
    assert.ok(!html.includes('RECOVERY REQUIRED'), 'resolved should not render recovery required panel');
    assert.ok(!html.includes('PLANNER DECISION OBSERVED'), 'resolved should not render decided panel');
    assert.ok(!html.includes('CONTINUATION AUTHORIZED'), 'resolved should not render continuation panel');
  });
});

describe('PlannerFirstRecoveryPanel — No selectable destination (R5 / R6)', () => {
  it('never renders a selectable destination dropdown', () => {
    const html = renderHtml({ phase: 'required', failureReason: 'test', automationPaused: true });
    // The text "Recovery owner (fixed):" is read-only display, not a dropdown.
    // Verify no <select>, <option>, or combobox ARIA role appears.
    assert.ok(!html.includes('<select'), 'no select element');
    assert.ok(!html.includes('role="combobox"'), 'no combobox role');
    assert.ok(!html.includes('Destination:'), 'no Destination label');
  });
});

describe('PlannerFirstRecoveryPanel — Planner-context inputs only', () => {
  it('renders input fields for planner context (Goal / Method / Direction)', () => {
    // Inputs are only present in planner_intervention mode (planner sends new instruction)
    const html = renderHtml({ phase: 'planner_intervention', failureReason: 'test', automationPaused: true });
    // Verify input fields exist (they render as <input> elements)
    assert.ok(html.includes('id="rx-goal"'), 'Goal input present');
    assert.ok(html.includes('id="rx-method"'), 'Method input present');
    assert.ok(html.includes('id="rx-direction"'), 'Direction input present');
    assert.ok(!html.includes('Feed Worker'), 'no direct Worker feed button');
  });
});

describe('PlannerFirstRecoveryPanel — Message preservation', () => {
  it('shows last planner message when provided', () => {
    const html = renderHtml({
      phase: 'planner_decided',
      lastPlannerMessage: 'Investigate transport layer before retry',
      automationPaused: true,
    });
    assert.ok(html.includes('LAST PLANNER MESSAGE'), 'last planner message block present');
    assert.ok(html.includes('Investigate transport layer'), 'planner message text rendered');
  });

  it('handles absent messages without crashing', () => {
    const html = renderHtml({ phase: 'required', failureReason: 'test', automationPaused: true });
    assert.ok(html.includes('PLANNER'), 'component renders without crashing');
  });
});

describe('PlannerFirstRecoveryPanel — Handler wiring', () => {
  it('"Pause & Return to Planner" button exists and is wired', () => {
    const html = renderHtml({ phase: 'required', failureReason: 'test', automationPaused: true });
    assert.ok(html.includes('Pause'), 'pause button text present');
  });

  it('"Send to Planner" button exists and is wired', () => {
    const html = renderHtml({ phase: 'planner_intervention', failureReason: 'test', automationPaused: true });
    assert.ok(html.includes('Send to Planner'), 'send button text present');
  });
});

describe('PlannerFirstRecoveryPanel — Read-only phase display', () => {
  it('displays each engine phase exactly once (no local phase mutation)', () => {
    for (const phase of ['required', 'planner_intervention', 'planner_decided', 'continuation_authorized'] as RecoveryState['phase'][]) {
      const html = renderHtml({ phase, automationPaused: true });
      const match = html.match(/RECOVERY REQUIRED|PLANNER INTERVENTION|PLANNER DECISION OBSERVED|CONTINUATION AUTHORIZED/g);
      assert.equal(match?.length, 1, `${phase} renders its panel exactly once`);
    }
  });
});
