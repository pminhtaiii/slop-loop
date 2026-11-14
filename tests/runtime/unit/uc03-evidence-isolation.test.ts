/**
 * UC-03 host execution evidence must not alias caller-owned mutable state.
 * Owned path: tests/runtime/unit/uc03-evidence-isolation.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { attachUC03ExecutionEvidence } from '../../../src/uc03/graph-types.ts';
import { createFixtureTaskState } from '../support/uc03/port-fixtures.ts';

test('execution evidence is a detached projection, not a frozen alias of the caller state', () => {
  const state = createFixtureTaskState();
  const result = attachUC03ExecutionEvidence({ outcome: 'needs-info', state: null, reasons: [], milestones: [] }, { state });
  const evidence = result.executionEvidence;
  assert.ok(evidence);
  assert.ok(evidence.finalState);
  assert.notEqual(evidence.finalState, state);
  assert.notEqual(evidence.finalState.changedPaths, state.changedPaths);

  // The caller's borrowed input stays mutable and unchanged.
  assert.equal(Object.isFrozen(state), false);
  assert.equal(Object.isFrozen(state.changedPaths), false);
  (state.changedPaths as string[]).push('src/calculator.py');
  assert.deepEqual(state.changedPaths, ['src/calculator.py']);

  // And the evidence it did not own is unchanged and still frozen.
  assert.deepEqual(evidence.finalState.changedPaths, []);
  assert.equal(Object.isFrozen(evidence.finalState), true);
  assert.equal(Object.isFrozen(evidence.finalState.changedPaths), true);
});
