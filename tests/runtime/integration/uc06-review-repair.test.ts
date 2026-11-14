import assert from 'node:assert/strict';
import test from 'node:test';
import { runControlledUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import { controlledReviewFixture, controlledReviewCompletion } from '../support/uc06/review-evidence.ts';
import type { TaskState } from '../../../src/contracts/foundation/uc03.ts';

async function approveReview(fixture: Awaited<ReturnType<typeof controlledReviewFixture>>) {
  const pending = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(pending.outcome, 'pending-approval', JSON.stringify(pending));
  const d1 = fixture.approval.getRecordedBindings().find(binding => binding.decisionId.startsWith('dec-verify-'));
  const owner = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(d1 && owner);
  const authorityRef = { ...owner.policyIdentity, decisionAuthorityGeneration: owner.decisionAuthorityGeneration + 1 };
  assert.equal((await fixture.owner.publishAuthority({ authorityRef })).status, 'published');
  fixture.approval.setV02AuthorityRef(authorityRef);
  fixture.approval.scriptDecision({ ...d1, status: 'approved' });
}

async function completingFixture() {
  const probe = await controlledReviewFixture();
  await approveReview(probe);
  const result = await runControlledUC03GraphV02(probe.task, probe.ports, probe.config);
  assert.equal(probe.evidence.records.size, 1, JSON.stringify({ reasons: result.reasons, calls: probe.evidence.calls, requests: probe.requests.length }));
  const fixture = await controlledReviewFixture(controlledReviewCompletion(probe));
  await approveReview(fixture);
  return fixture;
}

// ==============================================================================
// R16: Actionable Review Findings Trigger Controlled Repair & Invalidate Prior Review
// ==============================================================================

test('R16: actionable review finding transitions graph to Repair and stores observation', async () => {
  const fixture = await completingFixture();
  fixture.response.content = JSON.stringify({
    status: 'findings',
    findings: [
      {
        file: 'src/calculator.py',
        line: 1,
        side: 'old',
        severity: 'warning',
        message: 'Removing this behavior without preserving the public contract violates the admitted convention.',
        evidenceRef: 'convention-current',
      },
    ],
  });

  let persistedBeforeRepair = false;
  const originalTransition = fixture.owner.transition.bind(fixture.owner);
  fixture.owner.transition = async (state: TaskState, version: number) => {
    if (state.node === 'Repair') {
      persistedBeforeRepair = [...fixture.evidence.records.values()].some(r => r.observation.status === 'findings');
    }
    return originalTransition(state, version);
  };

  const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);

  // In the controlled graph without a configured coder repair generator, the route transitions to Repair then halts safely
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(persistedBeforeRepair, true);
  const finalState = await fixture.owner.loadTask(fixture.task.taskId);
  assert.equal(finalState?.node, 'Repair');
  assert.equal(finalState?.latestReviewRef, [...fixture.evidence.records.values()][0]?.observation.result?.reviewId);
  assert.equal(finalState?.outcome, undefined, 'finding must not set terminal outcome COMPLETED');
  assert.equal([...fixture.evidence.records.values()][0]?.observation.status, 'findings');
  assert.equal(fixture.requests.length, 1);
});

// ==============================================================================
// R17: Authority Exhaustion & Bounded Loop Stops Without Replay
// ==============================================================================

test('R17: missing owner authority after actionable findings prevents unauthorized patch execution', async () => {
  const fixture = await completingFixture();
  fixture.response.content = JSON.stringify({
    status: 'findings',
    findings: [
      {
        file: 'src/calculator.py',
        line: 1,
        side: 'old',
        severity: 'error',
        message: 'Required regression guard is missing in new patch.',
        evidenceRef: 'convention-current',
      },
    ],
  });

  const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');

  // Verify journal does not contain unexpected patch execution or extra provider claims
  const journal = fixture.owner.getJournalSnapshot();
  const repairPatchClaims = journal.claims.filter(c => c.claimId.startsWith('claim-repair-patch-'));
  assert.equal(repairPatchClaims.length, 0, 'no repair patch executed without explicit authority');
});

test('R17: loop exhaustion or halted repair preserves charges and produces no duplicate provider dispatches', async () => {
  const fixture = await completingFixture();
  fixture.response.content = JSON.stringify({
    status: 'findings',
    findings: [
      {
        file: 'src/calculator.py',
        line: 1,
        side: 'old',
        severity: 'error',
        message: 'Critical finding that cannot proceed without renewal.',
        evidenceRef: 'convention-current',
      },
    ],
  });

  const firstRun = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(firstRun.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(fixture.requests.length, 1);

  // Attempting second run without new authority or repair patch proposal
  const secondRun = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(secondRun.outcome, 'IMPLEMENTED_UNVERIFIED');
  // No second model dispatch was triggered
  assert.equal(fixture.requests.length, 1);
});
