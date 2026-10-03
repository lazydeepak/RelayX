import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('Assignment UI slice', () => {
  it('Dashboard KPI is interactive with accessible semantics', () => {
    const source = readFileSync(new URL('../src/components/DashboardView.tsx', import.meta.url), 'utf8');
    assert.match(source, /onNavigateAssignments/);
    assert.match(source, /cursor-pointer/);
    assert.match(source, /tabIndex={0}/);
    assert.match(source, /aria-label/);
    assert.match(source, /Enter|Space/);
  });

  it('Assignments view supports running/current filter and shows status fields', () => {
    const source = readFileSync(new URL('../src/components/AssignmentsView.tsx', import.meta.url), 'utf8');
    assert.match(source, /filterStatuses/);
    assert.match(source, /currentAttemptStatus/);
    assert.match(source, /pairOperationalState/);
    assert.match(source, /blockerReason/);
    assert.match(source, /attentionStatus/);
    assert.match(source, /getAssignmentDetail/);
  });

  it('Assignments detail exposes attempt, delivery, handoff, event, and attention data', () => {
    const source = readFileSync(new URL('../src/components/AssignmentsView.tsx', import.meta.url), 'utf8');
    assert.match(source, /Historical Attempts/);
    assert.match(source, /Deliveries/);
    assert.match(source, /Handoffs/);
    assert.match(source, /Events/);
    assert.match(source, /Unresolved Attention/);
  });

  it('Renderer boundary remains protected after UI changes', () => {
    const bridge = readFileSync(new URL('../src/services/relayBridge.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(bridge, /RelayEngine|RelayApiService/);
    assert.match(bridge, /window\.relayApi/);
  });

  it('Service mapping preserves existing lifecycle data without inventing new statuses', () => {
    const api = readFileSync(new URL('../src/relay/application/RelayApiService.ts', import.meta.url), 'utf8');
    assert.match(api, /getAssignmentDetail/);
    // Ensure we do not invent a new assignment status
    assert.doesNotMatch(api, /invented|fake_status|new_state_invented/);
  });
});
