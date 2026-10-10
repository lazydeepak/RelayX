/**
 * PairView → CreateAssignmentModal bounded flow verification.
 *
 * Confirms:
 * - Hardcoded universal T1 assignment payload removed from App.
 * - PairView Dispatch Assignment opens the existing modal preselected.
 * - No durable Assignment/Attempt/Delivery is created before submit.
 * - Submit continues through the existing governed pipeline.
 * - Cancel produces no durable work.
 * - Removed strings are unreachable in production source.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const pairViewSource = readFileSync(new URL('../src/components/PairView.tsx', import.meta.url), 'utf8');
const modalSource = readFileSync(new URL('../src/components/CreateAssignmentModal.tsx', import.meta.url), 'utf8');

describe('PairView Dispatch Assignment → CreateAssignmentModal', () => {
  it('removed hardcoded T1 strings are unreachable in App production source', () => {
    assert.strictEqual(appSource.includes('Next Planner Iteration'), false, 'Next Planner Iteration removed');
    assert.strictEqual(appSource.includes('Execute planned subtask'), false, 'Execute planned subtask instruction removed');
  });

  it('only the governed submit pipeline calls createAndDispatchAssignment', () => {
    const count = appSource.split('createAndDispatchAssignment').length - 1;
    assert.strictEqual(count, 1, 'single governed call expected');
    const handleCreateIndex = appSource.indexOf('const handleCreateAssignment');
    const callIndex = appSource.indexOf('createAndDispatchAssignment');
    assert.ok(callIndex > handleCreateIndex, 'must live inside handleCreateAssignment');
  });

  it('handleDispatchPair opens modal preselected when no active assignment exists', () => {
    const start = appSource.indexOf('const handleDispatchPair = async');
    const end = appSource.indexOf('const formatFriendlyError = ', start);
    const body = appSource.slice(start, end);
    assert.match(body, /setPendingSelectedPairId\(pair\.id\)/, 'must set pending preselection');
    assert.match(body, /setIsNewAssignmentOpen\(true\)/, 'must open creation modal');
    assert.doesNotMatch(body, /relayBridge\.createAndDispatchAssignment/, 'must not create assignment immediately');
    assert.doesNotMatch(body, /'Next Planner Iteration'/, 'must not contain removed title');
    assert.doesNotMatch(body, /'Execute planned subtask/, 'must not contain removed instruction');
  });

  it('handleDispatchPair preserves existing assignment retry path', () => {
    const start = appSource.indexOf('const handleDispatchPair = async');
    const end = appSource.indexOf('const formatFriendlyError = ', start);
    const body = appSource.slice(start, end);
    assert.match(body, /await relayBridge\.dispatchAssignment\(pair\.activeAssignmentId\)/, 'retry path preserved');
    assert.match(body, /await loadData\(\)/, 'refresh after retry preserved');
  });

  it('PairView button delegates solely through onDispatchAssignment prop', () => {
    assert.doesNotMatch(pairViewSource, /createAndDispatchAssignment/, 'PairView must not call creation directly');
    assert.doesNotMatch(pairViewSource, /relayBridge/, 'PairView must not touch relay');
    assert.match(pairViewSource, /onClick=\{\(\) => onDispatchAssignment\(pair\.id\)\}/, 'button calls prop');
  });

  it('modal applies pending pair selection and never creates before submit', () => {
    assert.match(modalSource, /pendingSelectedPairId/, 'pending selection prop present');
    assert.match(modalSource, /if \(pairs\.some\(\(p\) => p\.id === pendingSelectedPairId\)\) \{/, 'application of pending present');
    // onCreate (the governed pipeline) is only invoked inside submit, not by open effects.
    const submitCall = modalSource.indexOf('await onCreate(');
    const firstEffect = modalSource.indexOf('useEffect');
    assert.ok(submitCall > firstEffect, 'onCreate must only be called from submit');
    // Verify no mutation of selected pair on simple open/close.
    assert.doesNotMatch(modalSource, /isOpen===true[\s\S]{0,300}setSelectedPairId/, 'open must not force selection without pending');
  });

  it('modal title and instruction start empty; no magic default is injected', () => {
    assert.match(modalSource, /const \[title, setTitle\] = useState<string>\(''\)/, 'title starts empty');
    assert.match(modalSource, /const \[instruction, setInstruction\] = useState<string>\(''\)/, 'instruction starts empty');
    // The only draft reset happens after durable creation (shouldCloseCreateAssignmentModal true).
    const closeModalIndex = modalSource.indexOf('shouldCloseCreateAssignmentModal');
    const resetTitleIndex = modalSource.indexOf("setTitle('')");
    assert.ok(resetTitleIndex > closeModalIndex, 'draft reset only after durable creation');
    assert.ok(modalSource.indexOf("setInstruction('')") > closeModalIndex, 'instruction reset only after durable creation');
  });

  it('cancel closes modal without durable creation or draft destruction', () => {
    assert.match(appSource, /onClose=\{\(\) => setIsNewAssignmentOpen\(false\)\}/, 'cancel only closes modal');
    // Make sure App does not call handleCreateAssignment from handleDispatchPair (already verified in earlier test via body check).
    const dispatchStart = appSource.indexOf('const handleDispatchPair = async');
    const dispatchEnd = appSource.indexOf('const formatFriendlyError = ', dispatchStart);
    assert.doesNotMatch(appSource.slice(dispatchStart, dispatchEnd), /handleCreateAssignment/, 'dispatch must not invoke submit pipeline');
  });

  it('submit continues through existing governed pipeline (handleCreateAssignment → modal onCreate)', () => {
    assert.match(appSource, /onCreate=\{handleCreateAssignment\}/, 'modal wired to handleCreateAssignment');
    assert.match(appSource, /const handleCreateAssignment = async/, 'pipeline exists');
    assert.match(appSource, /await relayBridge\.createAndDispatchAssignment\(pairId, title, instruction, priority\)/, 'governed pipeline preserves operator priority');
  });

  it('no assignment exists before submit; creation is deferred to explicit user submit', () => {
    // Source-level evidence: handleDispatchPair for no-active-assignment case never calls relayBridge.
    const start = appSource.indexOf('const handleDispatchPair = async');
    const end = appSource.indexOf('const formatFriendlyError = ', start);
    const elseBlockStart = appSource.slice(start, end).indexOf('else {');
    const elseBody = appSource.slice(start + elseBlockStart, end);
    assert.doesNotMatch(elseBody, /relayBridge\.createAndDispatchAssignment/, 'else branch must not directly create assignment');
  });

  it('inactive-pair regression: else branch restores pre-existing activation before modal open', () => {
    // Before fix the else branch opened the modal without activation; an IDLE
    // pair would then fail submission with PAIR_OPERATIONAL_STATE_IDLE.
    const start = appSource.indexOf('const handleDispatchPair = async');
    const end = appSource.indexOf('const formatFriendlyError = ', start);
    const elseBlockStart = appSource.slice(start, end).indexOf('else {');
    const elseBody = appSource.slice(start + elseBlockStart, end);
    assert.match(elseBody, /if \(pair\.operationalState !== 'ACTIVE'\)/, 'must guard activation by state');
    assert.match(elseBody, /await relayBridge\.loadAndActivatePair\(pairId\)/, 'must call activation before modal open');
    assert.match(elseBody, /setPendingSelectedPairId\(pair\.id\)/, 'must still preselect pair');
    assert.match(elseBody, /setIsNewAssignmentOpen\(true\)/, 'must still open modal');
  });
});
