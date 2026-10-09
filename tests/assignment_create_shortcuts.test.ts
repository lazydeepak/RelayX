/**
 * Tests for the Create Project / Create Pair shortcuts inside the Create New
 * Assignment modal.
 *
 * The shortcuts must reuse the existing creation flows (AddProjectWizard /
 * PairModal), preserve the assignment draft across the round trip, refresh the
 * Target Pair list after creation, and auto-select a newly created pair.
 *
 * Follows the repo's UI test conventions: source-inspection for component
 * wiring plus pure-logic tests for the selection-consumption contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const modalSource = readFileSync(new URL('../src/components/CreateAssignmentModal.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const pairModalSource = readFileSync(new URL('../src/components/PairModal.tsx', import.meta.url), 'utf8');

describe('Assignment modal — Create Project / Create Pair shortcuts', () => {
  it('shortcuts are visible near the pair selector', () => {
    // Rendered button labels (not merely identifiers/comments).
    assert.match(modalSource, />\s*Create Project\s*</);
    assert.match(modalSource, />\s*Create Pair\s*</);
    // Both actions render immediately after the pair selector and before the
    // Assignment Title field, regardless of the selector's label text.
    const pairSelectIndex = modalSource.indexOf('value={selectedPairId}');
    const assignmentTitleIndex = modalSource.indexOf('Assignment Title');
    const createProjectIndex = modalSource.indexOf('onClick={onCreateProject}');
    const createPairIndex = modalSource.indexOf('onClick={() => onCreatePair(');
    assert.ok(pairSelectIndex > 0, 'the pair selector must exist');
    assert.ok(createProjectIndex > pairSelectIndex, 'Create Project renders after the pair selector');
    assert.ok(createPairIndex > pairSelectIndex, 'Create Pair renders after the pair selector');
    assert.ok(createProjectIndex < assignmentTitleIndex, 'Create Project renders before Assignment Title');
    assert.ok(createPairIndex < assignmentTitleIndex, 'Create Pair renders before Assignment Title');
  });

  it('shortcuts are secondary link-style actions, not primary buttons', () => {
    // They must be type="button" links, visually quieter than Create & Dispatch.
    const createProjectBtn = modalSource.slice(
      modalSource.indexOf('Create Project') - 400,
      modalSource.indexOf('Create Project') + 20,
    );
    assert.match(createProjectBtn, /type="button"/);
    assert.match(createProjectBtn, /text-blue-400/);
    assert.doesNotMatch(createProjectBtn, /bg-blue-600/);
  });

  it('Create Project invokes the existing project creation flow prop', () => {
    assert.match(modalSource, /onCreateProject: \(\) => void/);
    assert.match(modalSource, /onClick=\{onCreateProject\}/);
  });

  it('Create Pair invokes the existing pair creation flow prop with project context', () => {
    assert.match(modalSource, /onCreatePair: \(projectId\?: string\) => void/);
    // The current selection's project is forwarded as preselection context.
    assert.match(modalSource, /onCreatePair\(pairs\.find\(\(p\) => p\.id === selectedPairId\)\?\.projectId\)/);
  });

  it('App wires Create Project to the existing AddProjectWizard', () => {
    assert.match(appSource, /onCreateProject=\{\(\) => setIsAddProjectWizardOpen\(true\)\}/);
  });

  it('App wires Create Pair to the existing PairModal in create mode', () => {
    assert.match(appSource, /onCreatePair=\{\(projectId\) =>\s*setPairModal\(\{ isOpen: true, mode: 'create', pair: null, initialProjectId: projectId \}\)\s*\}/);
  });

  it('assignment draft survives the round trip: modal stays mounted with isOpen unchanged', () => {
    // The modal is always mounted in App and only returns null when closed;
    // opening a creation flow must not close or remount it (state hooks keep
    // title/instruction/selectedPairId alive).
    assert.match(appSource, /isOpen=\{isNewAssignmentOpen\}/);
    assert.doesNotMatch(appSource, /isOpen=\{isNewAssignmentOpen && !isAddProjectWizardOpen\}/);
    // Draft state is component-local and never reset by the shortcut handlers.
    assert.match(modalSource, /const \[title, setTitle\] = useState<string>\(''\)/);
    assert.match(modalSource, /const \[instruction, setInstruction\] = useState<string>\(''\)/);
    assert.doesNotMatch(modalSource, /onCreateProject[\s\S]{0,200}setTitle\(''\)/);
  });

  it('pair list refreshes after creation via loadData', () => {
    // AddProjectWizard success path refreshes pairs.
    assert.match(appSource, /<AddProjectWizard[\s\S]*?onSuccess=\{\(id, msg\) => \{\s*notify\(msg\);\s*loadData\(\);/);
    // PairModal success path refreshes pairs and applies the pending selection.
    assert.match(appSource, /onSuccess=\{\(msg, createdPairId\) => \{\s*notify\(msg\);\s*loadData\(\)\.then\(\(\) => \{\s*if \(createdPairId\) \{\s*setPendingSelectedPairId\(createdPairId\);/);
  });

  it('newly created pair becomes the selected Target Pair', () => {
    // PairModal reports the created pair id through onSuccess.
    assert.match(pairModalSource, /onSuccess: \(message: string, createdPairId\?: string\) => void/);
    assert.match(pairModalSource, /const created = await relayBridge\.createPair\(/);
    assert.match(pairModalSource, /onSuccess\(`Pair "\$\{name\.trim\(\)\}" created successfully`, created\?\.id\)/);
    // The assignment modal consumes the pending selection once the pair appears.
    assert.match(modalSource, /pendingSelectedPairId/);
    assert.match(modalSource, /if \(pairs\.some\(\(p\) => p\.id === pendingSelectedPairId\)\) \{\s*setSelectedPairId\(pendingSelectedPairId\);\s*onPendingSelectedPairIdConsumed\?\.\(\);/);
  });

  it('existing Create & Dispatch contract remains: submit still calls onCreate with the selected pair', () => {
    // The submit path now ALSO refuses when the selected Pair already owns an
    // unresolved active assignment (see create_and_dispatch_atomic.test.ts), but
    // the core contract is unchanged: required fields, onCreate(pair, title, instr).
    assert.match(modalSource, /const handleSubmit = async \(e: React\.FormEvent\) => \{\s*e\.preventDefault\(\);/);
    assert.match(modalSource, /if \(!title\.trim\(\) \|\| !instruction\.trim\(\)\) return;/);
    assert.match(modalSource, /onCreate\(selectedPairId \|\| pairs\[0\]\?\.id, title, instruction, priority\);/);
    assert.match(modalSource, /Create & Dispatch/);
  });

  it('cancellation returns to the assignment modal with the draft unchanged', () => {
    // Inner flows close via their own onClose; the assignment modal's onClose
    // (which would clear nothing anyway) is not invoked by cancelling them.
    assert.match(appSource, /onClose=\{\(\) => setPairModal\(\(prev\) => \(\{ \.\.\.prev, isOpen: false \}\)\)\}/);
    assert.match(appSource, /onClose=\{\(\) => setIsAddProjectWizardOpen\(false\)\}/);
    // No draft-clearing effect keyed on the creation-flow modals.
    assert.doesNotMatch(modalSource, /isAddProjectWizardOpen|pairModal/);
  });
});

/**
 * Pure-logic contract for the pending-selection consumption, mirroring the
 * effect inside CreateAssignmentModal (same rules as ui_pair_filter.test.ts
 * mirrors PairModal's filters).
 */
function applyPendingSelection(
  pendingId: string | null,
  pairs: Array<{ id: string }>,
  currentSelectedId: string,
): { selectedId: string; consumed: boolean } {
  if (!pendingId) return { selectedId: currentSelectedId, consumed: false };
  if (pairs.some((p) => p.id === pendingId)) {
    return { selectedId: pendingId, consumed: true };
  }
  return { selectedId: currentSelectedId, consumed: false };
}

describe('Assignment modal — pending pair selection contract', () => {
  const pairs = [{ id: 'pair_1' }, { id: 'pair_2' }];

  it('no pending id leaves the current selection untouched', () => {
    assert.deepEqual(applyPendingSelection(null, pairs, 'pair_1'), { selectedId: 'pair_1', consumed: false });
  });

  it('pending id present in the refreshed list becomes the selection', () => {
    assert.deepEqual(applyPendingSelection('pair_2', pairs, 'pair_1'), { selectedId: 'pair_2', consumed: true });
  });

  it('pending id not yet in the list waits for the next refresh instead of selecting nothing', () => {
    // The effect re-runs when `pairs` changes, so a not-yet-visible pair is
    // selected as soon as the refreshed list arrives.
    assert.deepEqual(applyPendingSelection('pair_new', pairs, 'pair_1'), { selectedId: 'pair_1', consumed: false });
    assert.deepEqual(applyPendingSelection('pair_new', [...pairs, { id: 'pair_new' }], 'pair_1'), { selectedId: 'pair_new', consumed: true });
  });
});
