import assert from 'node:assert/strict';
import test from 'node:test';
import { runControlledUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import { controlledReviewFixture, controlledReviewCompletion } from '../support/uc06/review-evidence.ts';
import { prepareControlledUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { controlledCompletionContext, controlledGeneratedPlanFixture, type ControlledReviewVerdict } from '../support/uc03/controlled-host-journey.ts';
import type { TaskState } from '../../../src/contracts/foundation/uc03.ts';

const REPAIR_VERDICTS: readonly ControlledReviewVerdict[] = [
  {
    status: 'findings',
    findings: [{ file: 'src/calculator.py', line: 2, side: 'new', severity: 'error', message: 'Guard message is not actionable for the operator' }],
  },
  { status: 'accepted', findings: [] },
];

type ControlledFixture = Awaited<ReturnType<typeof controlledGeneratedPlanFixture>>;

async function bumpAuthority(fixture: ControlledFixture) {
  const snapshot = await fixture.statePort.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(snapshot, 'owner published no authority');
  const next = { ...snapshot.policyIdentity, decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration + 1 };
  assert.equal((await fixture.statePort.publishAuthority({ authorityRef: next })).status, 'published');
  fixture.route.approvalPort.setV02AuthorityRef(next);
}

async function approveD0AndD1(fixture: ControlledFixture) {
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') throw new Error('Controlled host was not ready');
  await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  const d0 = fixture.route.approvalPort.getRecordedBindings().find(binding => binding.decisionId.startsWith('dec-plan-'));
  assert.ok(d0, 'owner did not issue D0');
  await bumpAuthority(fixture);
  fixture.route.approvalPort.scriptDecision({ ...d0, status: 'approved' });
  const patched = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(patched.outcome, 'pending-approval', JSON.stringify({ reasons: patched.reasons, modelCalls: fixture.modelCalls }));
  const d1 = fixture.route.approvalPort.getRecordedBindings().find(binding => binding.decisionId.startsWith('dec-verify-'));
  assert.ok(d1, 'owner did not issue D1');
  await bumpAuthority(fixture);
  fixture.route.approvalPort.scriptDecision({ ...d1, status: 'approved' });
  fixture.route.repositoryPort.setCommandResult('pytest -q tests/test_calculator.py -k test_divide_zero', { exitCode: 0, stdout: '1 passed', stderr: '' });
}

async function driveRepairRound(fixture: ControlledFixture) {
  await approveD0AndD1(fixture);
  fixture.route.approvalPort.scriptClassification('apply_patch', 'ALLOWED');
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') throw new Error('Controlled host was not ready');
  const first = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  assert.equal(first.outcome, 'pending-approval', JSON.stringify({ reasons: first.reasons, node: first.state?.node, modelCalls: fixture.modelCalls }));
  const repairDecision = fixture.route.approvalPort
    .getRecordedBindings()
    .filter(binding => binding.decisionId.startsWith('dec-verify-'))
    .at(-1);
  assert.ok(repairDecision, 'owner issued no repair verification decision');
  await bumpAuthority(fixture);
  fixture.route.approvalPort.scriptDecision({ ...repairDecision, status: 'approved' });
  return runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
}

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

test('R16: actionable finding invalidates prior completion and blocks delivery until fresh accepted review is produced', async () => {
  const fixture = await completingFixture();
  fixture.response.content = JSON.stringify({
    status: 'findings',
    findings: [
      {
        file: 'src/calculator.py',
        line: 1,
        side: 'old',
        severity: 'error',
        message: 'Prior logic regression must be addressed.',
        evidenceRef: 'convention-current',
      },
    ],
  });

  const repairRun = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(repairRun.outcome, 'IMPLEMENTED_UNVERIFIED');
  const repairState = await fixture.owner.loadTask(fixture.task.taskId);
  assert.equal(repairState?.node, 'Repair');
  assert.equal(repairState?.outcome, undefined, 'finding must not allow terminal outcome COMPLETED');

  // Verify that failure evidence and review observation are durably recorded
  const recorded = [...fixture.evidence.records.values()];
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.observation.status, 'findings');

  // Stale plan binding or authority mismatch refuses observation lookup
  assert.ok(repairState?.plan?.decisionRef);
  const record = recorded[0];
  assert.ok(record);
  const loadResult = await fixture.evidence.loadObservation({
    taskId: fixture.task.taskId,
    runId: record.observation.binding.runId,
    providerRequestId: record.observation.providerRequestId,
    contextDigest: record.observation.contextDigest,
    observationDigest: record.ack.observationDigest,
    expectedAuthority: {
      taskStateVersion: repairState.stateVersion,
      controlVersion: 2,
      epoch: 1,
      decisionAuthorityGeneration: 2,
      planDecisionRef: repairState.plan.decisionRef,
      planBindingDigest: 'invalid-stale-digest',
    },
  });
  assert.equal(loadResult.outcome, 'denied', 'stale authority must deny loading observation');
});

test('R16/R17: full review-repair-verification-review journey drives repair patch to delivery completion', async () => {
  const probe = await controlledGeneratedPlanFixture({ reviewVerdict: REPAIR_VERDICTS });
  const probeRepaired = await driveRepairRound(probe);
  assert.equal(probeRepaired.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.ok(probeRepaired.state, 'the repair probe halted without a state');
  const reviewStateVersion = probeRepaired.state.stateVersion - 1;
  const deliveryStateVersion = probeRepaired.state.stateVersion;
  const completionContext = await controlledCompletionContext(probe, { ...probeRepaired.state, stateVersion: reviewStateVersion });

  const fixture = await controlledGeneratedPlanFixture({
    reviewVerdict: REPAIR_VERDICTS,
    transitionContexts: { [deliveryStateVersion]: completionContext },
  });
  const repaired = await driveRepairRound(fixture);
  assert.equal(repaired.outcome, 'COMPLETED', JSON.stringify({ reasons: repaired.reasons, node: repaired.state?.node }));
  assert.equal(repaired.state?.node, 'Deliver');
  assert.equal(repaired.finalReport?.isComplete, true);
  assert.equal(repaired.finalReport?.delivery?.outcome, 'COMPLETED');
  // Two patches produced and settled across the two review rounds
  assert.equal(fixture.route.repositoryPort.patches.length, 2);
  assert.notEqual(fixture.route.repositoryPort.patches[0]?.actionId, fixture.route.repositoryPort.patches[1]?.actionId);
});
