// Simple test to verify recovery authority
const { getRecoveryOwner, permittedTransitionDuringRecovery, isWorkerSideRecoveryTarget, assertNoSelectableRecoveryDestination } = require('./src/relay/domain/recoveryAuthority');

function testRecoveryAuthority() {
  console.log('Testing recovery authority...');
  
  // Test R1: Recovery owner is always PLANNER, never selectable.
  const recoveryOwner = getRecoveryOwner();
  console.log(`Recovery owner: ${recoveryOwner}`);
  if (recoveryOwner !== 'planner') {
    throw new Error(`Planner-first recovery violation: recovery owner is ${recoveryOwner}, expected 'planner'`);
  }
  
  // Test R5: No selectable recovery destination exists.
  assertNoSelectableRecoveryDestination('planner');
  
  try {
    assertNoSelectableRecoveryDestination('worker');
    console.error('Test failed: Should have thrown for worker');
    process.exit(1);
  } catch (error) {
    if (!error.message.includes('Planner-first recovery violation')) {
      console.error('Test failed: Wrong error message:', error.message);
      process.exit(1);
    }
  }
  
  console.log('✓ Recovery owner is always PLANNER');
  console.log('✓ Worker is never a recovery target');
  console.log('✓ No selectable destination exists');
}

testRecoveryAuthority();
