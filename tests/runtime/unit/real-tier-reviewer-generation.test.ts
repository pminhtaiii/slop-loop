/** Regression row for CodeRabbit PR #219 finding CR-4655935718: reviewer admission checks the issued decision binding. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { realTierReviewerAdmission } from '../../../src/runtime/real-tier-reviewer-admission.ts';
import { POLICY, TASK, TEST_DIFF, createFixture, makeAssembly, makeTaskState, tokenLedgersWith } from '../support/uc03/real-tier-admission-fixture.ts';

test('CR-4655935718: reviewer admission refuses a plan approval issued under an older authority generation', async () => {
  const state = makeTaskState('Review', tokenLedgersWith(1500));
  const f = await createFixture(state);
  const assembly = makeAssembly();
  const request = { task: TASK, state, diff: TEST_DIFF, evidence: [] };

  assert.ok(await realTierReviewerAdmission(assembly, TASK, f.port, request), 'the approval issued at the current generation admits the review');

  // The owner advances its authority generation; the plan's approval was issued at the old one.
  const rotated = { ...POLICY, decisionAuthorityGeneration: POLICY.decisionAuthorityGeneration + 1 };
  await f.stateStore.writeControl(TASK.taskId, { controlVersion: 3, epoch: 1, mode: 'runnable', holdRef: null, holdEventDigest: null, activeAuthorityRef: rotated, activeClaimId: null });

  assert.equal(await realTierReviewerAdmission(assembly, TASK, f.port, request), undefined);
});
