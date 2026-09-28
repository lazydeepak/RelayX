/**
 * Bootstrap isolation — the planner's provisioning turn must never be mistaken for
 * dispatched work.
 *
 * ## Why this needs a regression at all
 *
 * When RelayX creates a planner session it has to SAY something first, so the session is
 * live and the operator can see it. That opening instruction is a user turn in the
 * provider's transcript, indistinguishable in shape from an instruction RelayX later
 * dispatches as Assignment work.
 *
 * If correlation is not told the difference, the provisioning turn is read as the Planner
 * responding to dispatched work, and the engine concludes the Planner acted on an
 * Assignment it was never given. That is a false completion — a work item marked done
 * because the system talked to itself. Hence the exclusion list, and hence this test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  RELAYX_PLANNER_BOOTSTRAP_PROMPT,
  isBootstrapProvisioningTurn,
  isExcludedFromAssignmentCorrelation,
} from '../src/relay/providers/adapters.ts';

describe('Bootstrap Isolation Regression', () => {
  it('excludes the provisioning bootstrap user turn from planner assignment correlation', () => {
    assert.strictEqual(isBootstrapProvisioningTurn(RELAYX_PLANNER_BOOTSTRAP_PROMPT), true);
    assert.strictEqual(isExcludedFromAssignmentCorrelation(RELAYX_PLANNER_BOOTSTRAP_PROMPT), true);
  });

  it('excludes the assistant reply triggered by that bootstrap from assignment execution records', () => {
    // The reply itself is innocuous text. It is excluded because of WHAT CAUSED it, not
    // what it says: it answers RelayX's own provisioning prompt, never an Assignment.
    const assistantReply = 'Understood. Starting analysis...';
    assert.strictEqual(
      isExcludedFromAssignmentCorrelation(RELAYX_PLANNER_BOOTSTRAP_PROMPT, assistantReply),
      true,
    );
  });

  it('does NOT exclude ordinary Assignment work, so the guard cannot disable correlation', () => {
    // The negative direction matters as much as the positive one. An exclusion rule that
    // swallowed everything would make every Planner reply "not correlated", silently
    // freezing all progress while every test still passed.
    const realWork = 'Summarise the relay provider architecture.';
    assert.strictEqual(isExcludedFromAssignmentCorrelation(realWork), false);
  });
});
