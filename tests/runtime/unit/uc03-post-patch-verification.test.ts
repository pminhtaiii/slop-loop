import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  expectedVerificationRequestIdentityV02,
  isVerificationApprovalResolutionV02,
  isRecordVerificationApprovalRequestV02,
  isVerificationApprovalContextV02,
  type ApprovalBinding,
  type ApprovalBindingContext,
  type PolicyAuthorityRefV02,
  type RecordVerificationApprovalRequestV02,
  type ContextualApprovalVerifierV02,
  type VerificationApprovalContextV02,
  type TaskState,
} from '../../../src/contracts/foundation/uc03.ts';
import { createGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import { createFixtureBugTask, createFixturePolicyAuthorityRefV02 } from '../support/uc03/port-fixtures.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';
import { prepareVerificationApproval } from '../../../src/uc03/post-patch-verification-authority.ts';

const D0 = 'decision-post-patch-original-001';

function createOwnerFixture(options: {
  readonly verifier?: boolean;
  readonly wrapVerifier?: (issuer: ScriptedApprovalPort) => ContextualApprovalVerifierV02;
} = {}) {
  const task = createFixtureBugTask();
  const base = createGraphTaskState(task);
  const baselineRef = `uc04://baseline/${task.taskId}/1`;
  const strategy = 'Apply the zero denominator guard.';
  const plan = {
    planVersion: base.planVersion,
    diagnosis: 'The divide operation does not reject a zero denominator.',
    suspectedCauseLocations: ['src/calculator.py'],
    evidenceRefs: [baselineRef],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef: D0,
  } as const;
  const state: TaskState = {
    ...base,
    stateVersion: 7,
    node: 'Verify',
    repositoryRevisionDigest: computeCanonicalSha256('settled-revision'),
    plan,
    approvalDecisionRefs: [D0],
    activeDecisionId: undefined,
  };
  const authorityRef = createFixturePolicyAuthorityRefV02({
    policyId: task.configId,
    policyVersion: task.configVersion,
    configId: task.configId,
    configVersion: task.configVersion,
    decisionAuthorityGeneration: 3,
  });
  const d0Action = {
    actionId: D0,
    kind: 'approve_fix_plan' as const,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    diagnosisEvidenceRefs: plan.evidenceRefs,
    checkSetDigest: plan.checkSetDigest,
  };
  const d0Context: ApprovalBindingContext = {
    currentTaskId: task.taskId,
    currentWorkspaceId: state.workspaceId,
    currentRepositoryRevisionDigest: task.initialRevisionDigest,
    currentPolicyId: task.configId,
    currentPolicyVersion: task.configVersion,
    currentNormalizedActionDigest: computeCanonicalSha256(d0Action),
    currentPlanVersion: plan.planVersion,
    currentStrategyDigest: plan.strategyDigest,
    currentBaselineRef: baselineRef,
    currentEvidenceRefs: [baselineRef],
    currentCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    currentCheckSetDigest: plan.checkSetDigest,
  };
  const d0: ApprovalBinding = {
    decisionId: D0,
    actionKind: 'fix_plan',
    normalizedActionDigest: d0Context.currentNormalizedActionDigest ?? '',
    taskId: task.taskId,
    workspaceId: state.workspaceId,
    repositoryRevisionDigest: task.initialRevisionDigest,
    policyId: task.configId,
    policyVersion: task.configVersion,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef,
    evidenceRefs: [baselineRef],
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    status: 'approved',
  };
  const issuer = new ScriptedApprovalPort({
    decisions: [d0],
    currentContext: d0Context,
    v02AuthorityRef: authorityRef,
  });
  const verifier = options.verifier ? issuer : options.wrapVerifier?.(issuer);
  const owner = new MemoryStatePortV02({
    initialTaskState: state,
    initialAuthorityRef: authorityRef,
    initialControlVersion: 12,
    initialEpoch: 4,
    ...(verifier ? { verificationApprovalVerifier: verifier } : {}),
  });
  return { task, state, authorityRef, issuer, owner };
}

function reidentifyRequest(
  request: RecordVerificationApprovalRequestV02,
  changes: Partial<RecordVerificationApprovalRequestV02>,
): RecordVerificationApprovalRequestV02 {
  const candidate = { ...request, ...changes };
  const requestIdentity = expectedVerificationRequestIdentityV02(candidate);
  return { ...candidate, requestIdentity, decisionId: `dec-verify-${requestIdentity.slice('sha256:'.length)}` };
}

async function requestD1(
  fixture: ReturnType<typeof createOwnerFixture>,
) {
  const snapshot = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(snapshot);
  const prepared = prepareVerificationApproval(fixture.task, fixture.state, snapshot, D0);
  assert.ok(prepared);
  const issued = await fixture.issuer.requestDecision(prepared.binding);
  assert.equal(issued.decisionId, prepared.request.decisionId);
  return prepared;
}

async function prepareApprovedRequest(fixture: ReturnType<typeof createOwnerFixture>) {
  const initial = await requestD1(fixture);
  const snapshot = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(snapshot);
  const nextAuthority: PolicyAuthorityRefV02 = {
    ...fixture.authorityRef,
    decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration + 1,
  };
  assert.equal((await fixture.owner.publishAuthority({ authorityRef: nextAuthority })).status, 'published');
  fixture.issuer.scriptDecision({ ...initial.binding, status: 'approved' }, nextAuthority.decisionAuthorityGeneration);
  const currentSnapshot = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(currentSnapshot);
  const current = prepareVerificationApproval(fixture.task, fixture.state, currentSnapshot, D0);
  assert.ok(current);
  await fixture.issuer.requestDecision(current.binding);
  return current;
}

test('verification request identity is stable and the contextual records reject omitted and unknown fields', async () => {
  const fixture = createOwnerFixture({ verifier: true });
  const first = await requestD1(fixture);
  const snapshot = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(snapshot);
  const second = prepareVerificationApproval(fixture.task, fixture.state, {
    ...snapshot,
    controlVersion: snapshot.controlVersion + 1,
    epoch: snapshot.epoch + 1,
    decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration + 1,
  }, D0);
  assert.ok(second);
  assert.equal(first.request.requestIdentity, second.request.requestIdentity);
  assert.equal(first.request.decisionId, second.request.decisionId);
  assert.equal(first.request.requestIdentity, expectedVerificationRequestIdentityV02(first.request));
  assert.equal(isRecordVerificationApprovalRequestV02(first.request), true);
  assert.equal(isRecordVerificationApprovalRequestV02({ ...first.request, extra: true }), false);
  assert.equal(isRecordVerificationApprovalRequestV02({ ...first.request, decisionId: D0 }), false);
  assert.equal(isVerificationApprovalContextV02(first.context), true);
  assert.equal(isVerificationApprovalContextV02({ ...first.context, extra: true }), false);
  assert.equal(isVerificationApprovalContextV02({
    ...first.context,
    approvalContext: { ...first.context.approvalContext, currentCheckSetDigest: undefined },
  }), false);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('proxy trap'); } });
  assert.equal(isVerificationApprovalContextV02(hostile), false);
  assert.equal(isRecordVerificationApprovalRequestV02(hostile), false);
  assert.equal(isVerificationApprovalResolutionV02(hostile), false);
});

test('owner holds a pending D1 without mutation, then commits one explicit approved rebind and replays idempotently', async () => {
  const fixture = createOwnerFixture({ verifier: true });
  const prepared = await requestD1(fixture);
  const before = await fixture.owner.loadTask(fixture.task.taskId);
  const beforeSnapshot = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(before && beforeSnapshot);
  const pending = await Promise.all([
    fixture.owner.recordVerificationApproval(prepared.request),
    fixture.owner.recordVerificationApproval(prepared.request),
  ]);
  assert.deepEqual(pending.map((result) => result.outcome), ['pending', 'pending']);
  const firstPending = pending[0];
  assert.ok(firstPending && firstPending.outcome === 'pending');
  assert.deepEqual(firstPending.state, before);
  assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), before);
  const pendingSnapshot = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.equal(pendingSnapshot?.controlVersion, beforeSnapshot.controlVersion);
  assert.equal(pendingSnapshot?.epoch, beforeSnapshot.epoch);
  assert.equal(pendingSnapshot?.decisionAuthorityGeneration, beforeSnapshot.decisionAuthorityGeneration);
  assert.equal(fixture.issuer.getRecordedBindings().filter((binding) => binding.decisionId === prepared.request.decisionId).length, 1);

  const nextAuthority: PolicyAuthorityRefV02 = {
    ...fixture.authorityRef,
    decisionAuthorityGeneration: beforeSnapshot.decisionAuthorityGeneration + 1,
  };
  assert.equal((await fixture.owner.publishAuthority({ authorityRef: nextAuthority })).status, 'published');
  fixture.issuer.scriptDecision({ ...prepared.binding, status: 'approved' }, nextAuthority.decisionAuthorityGeneration);
  const afterPublication = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(afterPublication);
  const resumed = prepareVerificationApproval(fixture.task, before, afterPublication, D0);
  assert.ok(resumed);
  assert.equal(resumed.request.requestIdentity, prepared.request.requestIdentity);
  await fixture.issuer.requestDecision(resumed.binding);
  const approvedResults = await Promise.all([
    fixture.owner.recordVerificationApproval(resumed.request),
    fixture.owner.recordVerificationApproval(resumed.request),
  ]);
  assert.deepEqual(approvedResults.map((result) => result.outcome), ['approved', 'approved']);
  const approved = approvedResults[0];
  assert.ok(approved && approved.outcome === 'approved');
  assert.equal(approved.state.stateVersion, before.stateVersion + 1);
  assert.equal(approved.state.plan?.decisionRef, resumed.request.decisionId);
  assert.equal(approved.state.activeDecisionId, resumed.request.decisionId);
  assert.deepEqual(approved.state.approvalDecisionRefs, [...(before.approvalDecisionRefs ?? []), resumed.request.decisionId]);
  assert.equal(approved.state.repositoryRevisionDigest, before.repositoryRevisionDigest);
  assert.equal(approved.state.replanCount, before.replanCount);
  assert.deepEqual(approved.state.budgetLedgers, before.budgetLedgers);
  assert.equal(approved.controlVersion, afterPublication.controlVersion + 1);
  assert.equal(approved.epoch, beforeSnapshot.epoch);
  assert.equal(approved.decisionAuthorityGeneration, nextAuthority.decisionAuthorityGeneration);
  const replay = await fixture.owner.recordVerificationApproval(resumed.request);
  assert.deepEqual(replay, approved);
  assert.equal((await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId))?.controlVersion, approved.controlVersion);
});

test('stale authority publication and missing issuer capability fail closed without task mutation', async () => {
  const fixture = createOwnerFixture({ verifier: true });
  const prepared = await requestD1(fixture);
  const before = await fixture.owner.loadTask(fixture.task.taskId);
  const nextAuthority: PolicyAuthorityRefV02 = {
    ...fixture.authorityRef,
    decisionAuthorityGeneration: fixture.authorityRef.decisionAuthorityGeneration + 1,
  };
  await fixture.owner.publishAuthority({ authorityRef: nextAuthority });
  const afterPublication = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  const stale = await fixture.owner.recordVerificationApproval(prepared.request);
  assert.equal(stale.outcome, 'stale');
  assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), before);
  assert.equal((await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId))?.controlVersion, afterPublication?.controlVersion);

  const missing = createOwnerFixture();
  const missingRequest = await requestD1(missing);
  const missingBefore = await missing.owner.loadTask(missing.task.taskId);
  const unavailable = await missing.owner.recordVerificationApproval(missingRequest.request);
  assert.equal(unavailable.outcome, 'unavailable');
  assert.deepEqual(await missing.owner.loadTask(missing.task.taskId), missingBefore);
});

test('rejection establishes one owner hold and a pause blocks a current approval request', async () => {
  const rejectedFixture = createOwnerFixture({ verifier: true });
  const pendingRequest = await requestD1(rejectedFixture);
  const before = await rejectedFixture.owner.loadTask(rejectedFixture.task.taskId);
  const beforeSnapshot = await rejectedFixture.owner.readVerificationAuthoritySnapshot(rejectedFixture.task.taskId);
  assert.ok(before && beforeSnapshot);
  assert.equal((await rejectedFixture.owner.recordVerificationApproval(pendingRequest.request)).outcome, 'pending');
  const authority: PolicyAuthorityRefV02 = { ...rejectedFixture.authorityRef, decisionAuthorityGeneration: 4 };
  await rejectedFixture.owner.publishAuthority({ authorityRef: authority });
  rejectedFixture.issuer.scriptDecision({ ...pendingRequest.binding, status: 'rejected' }, authority.decisionAuthorityGeneration);
  const currentSnapshot = await rejectedFixture.owner.readVerificationAuthoritySnapshot(rejectedFixture.task.taskId);
  assert.ok(currentSnapshot);
  const rejectedRequest = prepareVerificationApproval(rejectedFixture.task, before, currentSnapshot, D0);
  assert.ok(rejectedRequest);
  await rejectedFixture.issuer.requestDecision(rejectedRequest.binding);
  const rejected = await rejectedFixture.owner.recordVerificationApproval(rejectedRequest.request);
  assert.equal(rejected.outcome, 'rejected');
  assert.deepEqual(await rejectedFixture.owner.loadTask(rejectedFixture.task.taskId), before);
  const hold = await rejectedFixture.owner.readVerificationAuthoritySnapshot(rejectedFixture.task.taskId);
  assert.equal(hold?.controlMode, 'rejected');
  assert.ok(hold?.holdRef);
  assert.equal(hold?.epoch, beforeSnapshot.epoch);
  assert.equal(hold?.controlVersion, currentSnapshot.controlVersion + 1);
  assert.deepEqual(await rejectedFixture.owner.recordVerificationApproval(rejectedRequest.request), rejected);

  const paused = createOwnerFixture({ verifier: true });
  const pausedRequest = await requestD1(paused);
  await paused.owner.setTaskControl(paused.task.taskId, 'paused', 'verification-pause-test');
  const pausedSnapshot = await paused.owner.readVerificationAuthoritySnapshot(paused.task.taskId);
  assert.ok(pausedSnapshot);
  const blocked = await paused.owner.recordVerificationApproval({
    ...pausedRequest.request,
    expectedControlVersion: pausedSnapshot.controlVersion,
  });
  assert.equal(blocked.outcome, 'blocked');
  const pausedState = await paused.owner.loadTask(paused.task.taskId);
  assert.ok(pausedState);
  assert.equal(computeCanonicalSha256(pausedState), computeCanonicalSha256(paused.state));
});

test('legacy scripted updates remain available while a contextual D1 rejection stays terminal across generations', async () => {
  const fixture = createOwnerFixture({ verifier: true });
  const pending = await requestD1(fixture);
  const legacyRejected: ApprovalBinding = { ...pending.binding, status: 'rejected', reason: 'Rejected legacy decision' };
  const legacyApproved: ApprovalBinding = { ...pending.binding, status: 'approved' };
  const legacy = new ScriptedApprovalPort({ decisions: [legacyRejected] });
  legacy.scriptDecision(legacyApproved);
  assert.equal((await legacy.resolve(legacyApproved.decisionId)).status, 'approved');
  assert.equal(await legacy.validateBinding(legacyApproved, pending.context.approvalContext), true);

  const rejectedGeneration = fixture.authorityRef.decisionAuthorityGeneration + 1;
  assert.equal((await fixture.owner.publishAuthority({
    authorityRef: { ...fixture.authorityRef, decisionAuthorityGeneration: rejectedGeneration },
  })).status, 'published');
  fixture.issuer.scriptDecision({ ...pending.binding, status: 'rejected', reason: 'Rejected D1' }, rejectedGeneration);
  const rejected = await fixture.owner.resolvePlanDecisionInContext(pending.request.decisionId, {
    ...pending.context,
    expectedDecisionAuthorityGeneration: rejectedGeneration,
  });
  assert.equal(rejected.outcome, 'resolved');
  if (rejected.outcome !== 'resolved') assert.fail('expected rejected D1 to resolve at its published generation');
  assert.equal(rejected.binding.status, 'rejected');

  const laterGeneration = rejectedGeneration + 1;
  assert.equal((await fixture.owner.publishAuthority({
    authorityRef: { ...fixture.authorityRef, decisionAuthorityGeneration: laterGeneration },
  })).status, 'published');
  fixture.issuer.scriptDecision({ ...pending.binding, status: 'approved' }, laterGeneration);
  const afterRejectedUpdate = await fixture.owner.resolvePlanDecisionInContext(pending.request.decisionId, {
    ...pending.context,
    expectedDecisionAuthorityGeneration: laterGeneration,
  });
  assert.equal(afterRejectedUpdate.outcome, 'resolved');
  if (afterRejectedUpdate.outcome !== 'resolved') assert.fail('expected contextual resolution to retain the terminal rejection');
  assert.equal(afterRejectedUpdate.binding.status, 'rejected');

  const state = await fixture.owner.loadTask(fixture.task.taskId);
  const snapshot = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(state && snapshot);
  const current = prepareVerificationApproval(fixture.task, state, snapshot, D0);
  assert.ok(current);
  const ownerResult = await fixture.owner.recordVerificationApproval(current.request);
  assert.equal(ownerResult.outcome, 'rejected');
  assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), state);
});

test('owner rejects stale CAS fences and changed task, repository, policy, revision, or plan identity without mutation', async () => {
  const fixture = createOwnerFixture({ verifier: true });
  const prepared = await requestD1(fixture);
  const before = await fixture.owner.loadTask(fixture.task.taskId);
  const snapshot = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(before && snapshot);
  const alteredDigest = computeCanonicalSha256('different-revision');
  const variants: readonly RecordVerificationApprovalRequestV02[] = [
    { ...prepared.request, expectedStateVersion: prepared.request.expectedStateVersion + 1 },
    { ...prepared.request, expectedControlVersion: prepared.request.expectedControlVersion + 1 },
    { ...prepared.request, expectedEpoch: prepared.request.expectedEpoch + 1 },
    { ...prepared.request, expectedDecisionAuthorityGeneration: prepared.request.expectedDecisionAuthorityGeneration + 1 },
    { ...prepared.request, expectedPlanVersion: prepared.request.expectedPlanVersion + 1 },
    reidentifyRequest(prepared.request, { expectedRepositoryRevisionDigest: alteredDigest }),
    reidentifyRequest(prepared.request, { expectedPlanMaterialDigest: alteredDigest }),
    reidentifyRequest(prepared.request, { taskId: 'task-other' }),
    reidentifyRequest(prepared.request, { runId: 'run-other' }),
    reidentifyRequest(prepared.request, { workspaceId: 'workspace-other' }),
    reidentifyRequest(prepared.request, { repositoryId: 'repository-other' }),
    reidentifyRequest(prepared.request, { originalDecisionId: 'decision-other' }),
    reidentifyRequest(prepared.request, { policyIdentity: { ...prepared.request.policyIdentity, policyId: 'policy-other' } }),
  ];
  for (const variant of variants) {
    const result = await fixture.owner.recordVerificationApproval(variant);
    assert.ok(result.outcome === 'stale' || result.outcome === 'unavailable' || result.outcome === 'conflict');
    assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), before);
    const after = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
    assert.equal(after?.controlVersion, snapshot.controlVersion);
    assert.equal(after?.epoch, snapshot.epoch);
    assert.equal(after?.decisionAuthorityGeneration, snapshot.decisionAuthorityGeneration);
  }
  assert.equal(await fixture.owner.recordVerificationApproval({ ...prepared.request, decisionId: D0 }).then((result) => result.outcome), 'conflict');
});

test('contextual issuer resolution is bound to its issuer, generation, revision, and full explicit context', async () => {
  const fixture = createOwnerFixture({ verifier: true });
  const prepared = await requestD1(fixture);
  const resolved = await fixture.owner.resolvePlanDecisionInContext(prepared.request.decisionId, prepared.context);
  assert.equal(resolved.outcome, 'resolved');
  if (resolved.outcome !== 'resolved') assert.fail('expected the scripted issuer to resolve the pending D1 record');
  assert.equal(resolved.binding.status, 'pending');
  assert.equal(resolved.issuerKeyRef, prepared.context.expectedIssuerKeyRef);
  assert.equal(resolved.decisionAuthorityGeneration, prepared.context.expectedDecisionAuthorityGeneration);
  assert.equal(resolved.contextDigest, computeCanonicalSha256(prepared.context));

  const wrongIssuer: VerificationApprovalContextV02 = {
    ...prepared.context,
    expectedIssuerKeyRef: 'key-substituted-issuer',
  };
  const wrongGeneration: VerificationApprovalContextV02 = {
    ...prepared.context,
    expectedDecisionAuthorityGeneration: prepared.context.expectedDecisionAuthorityGeneration + 1,
  };
  const wrongRevision: VerificationApprovalContextV02 = {
    ...prepared.context,
    approvalContext: { ...prepared.context.approvalContext, currentRepositoryRevisionDigest: computeCanonicalSha256('other-revision') },
  };
  for (const context of [wrongIssuer, wrongGeneration, wrongRevision]) {
    const result = await fixture.owner.resolvePlanDecisionInContext(prepared.request.decisionId, context);
    assert.equal(result.outcome, 'stale');
  }
  assert.equal(isVerificationApprovalContextV02({
    ...prepared.context,
    approvalContext: { ...prepared.context.approvalContext, extra: true },
  }), false);
});

test('pause after issuer resolution defeats the owner CAS without changing task state or accounting', async () => {
  const afterResolution: { run?: () => Promise<void> } = {};
  const fixture = createOwnerFixture({
    wrapVerifier: (issuer) => ({
      async resolvePlanDecisionInContext(decisionId, context) {
        const result = await issuer.resolvePlanDecisionInContext(decisionId, context);
        if (context.purpose === 'current-verification') await afterResolution.run?.();
        return result;
      },
    }),
  });
  const initial = await requestD1(fixture);
  const firstSnapshot = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(firstSnapshot);
  const nextAuthority: PolicyAuthorityRefV02 = {
    ...fixture.authorityRef,
    decisionAuthorityGeneration: firstSnapshot.decisionAuthorityGeneration + 1,
  };
  await fixture.owner.publishAuthority({ authorityRef: nextAuthority });
  fixture.issuer.scriptDecision({ ...initial.binding, status: 'approved' }, nextAuthority.decisionAuthorityGeneration);
  const currentSnapshot = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(currentSnapshot);
  const current = prepareVerificationApproval(fixture.task, fixture.state, currentSnapshot, D0);
  assert.ok(current);
  await fixture.issuer.requestDecision(current.binding);
  const before = await fixture.owner.loadTask(fixture.task.taskId);
  const beforeLedgers = fixture.owner.getLedgers();
  afterResolution.run = async () => { await fixture.owner.setTaskControl(fixture.task.taskId, 'paused', 'pause-after-issuer-resolution'); };
  const result = await fixture.owner.recordVerificationApproval(current.request);
  assert.ok(result.outcome === 'blocked' || result.outcome === 'stale');
  assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), before);
  assert.deepEqual(fixture.owner.getLedgers(), beforeLedgers);
  const paused = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.equal(paused?.controlMode, 'paused');
  assert.equal(paused?.controlVersion, currentSnapshot.controlVersion + 1);
  assert.equal(paused?.epoch, currentSnapshot.epoch);
});

test('owner refuses changed verification scope after cached approval while preserving stale-fence replay', async () => {
  let resolutionCalls = 0;
  const fixture = createOwnerFixture({
    wrapVerifier: (issuer) => ({
      async resolvePlanDecisionInContext(decisionId, context) {
        resolutionCalls++;
        return issuer.resolvePlanDecisionInContext(decisionId, context);
      },
    }),
  });
  const current = await prepareApprovedRequest(fixture);
  const approved = await fixture.owner.recordVerificationApproval(current.request);
  assert.equal(approved.outcome, 'approved');
  const committed = await fixture.owner.loadTask(fixture.task.taskId);
  const committedLedgers = fixture.owner.getLedgers();
  const committedAuthority = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(committed && committedAuthority);

  const staleFenceReplay = {
    ...current.request,
    expectedStateVersion: current.request.expectedStateVersion + 10,
    expectedControlVersion: current.request.expectedControlVersion + 10,
    expectedEpoch: current.request.expectedEpoch + 10,
    expectedDecisionAuthorityGeneration: current.request.expectedDecisionAuthorityGeneration + 10,
  };
  assert.equal(isRecordVerificationApprovalRequestV02(staleFenceReplay), true);
  assert.deepEqual(await fixture.owner.recordVerificationApproval(staleFenceReplay), approved);
  assert.deepEqual(await fixture.owner.recordVerificationApproval(current.request), approved);

  const mismatchedRequests: readonly RecordVerificationApprovalRequestV02[] = [
    { ...current.request, workspaceId: 'workspace-other' },
    { ...current.request, repositoryId: 'repository-other' },
    { ...current.request, expectedPlanVersion: current.request.expectedPlanVersion + 1 },
  ];
  for (const request of mismatchedRequests) {
    assert.equal(isRecordVerificationApprovalRequestV02(request), true);
    assert.equal(request.requestIdentity, current.request.requestIdentity);
    const result = await fixture.owner.recordVerificationApproval(request);
    assert.equal(result.outcome, 'conflict');
    assert.equal('state' in result, false);
    assert.equal('decisionId' in result, false);
    assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), committed);
    assert.deepEqual(fixture.owner.getLedgers(), committedLedgers);
    assert.equal(resolutionCalls, 1);
    const after = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
    assert.equal(after?.controlVersion, committedAuthority.controlVersion);
    assert.equal(after?.epoch, committedAuthority.epoch);
    assert.equal(after?.decisionAuthorityGeneration, committedAuthority.decisionAuthorityGeneration);
  }
});

test('owner refuses changed verification scope while the identical request is in flight', async () => {
  let releaseResolution: (() => void) | undefined;
  let signalResolution: (() => void) | undefined;
  let resolutionCalls = 0;
  const resolutionEntered = new Promise<void>((resolve) => { signalResolution = resolve; });
  const resolutionHold = new Promise<void>((resolve) => { releaseResolution = resolve; });
  const fixture = createOwnerFixture({
    wrapVerifier: (issuer) => ({
      async resolvePlanDecisionInContext(decisionId, context) {
        resolutionCalls++;
        const result = await issuer.resolvePlanDecisionInContext(decisionId, context);
        if (context.purpose === 'current-verification') {
          signalResolution?.();
          await resolutionHold;
        }
        return result;
      },
    }),
  });
  const current = await prepareApprovedRequest(fixture);
  const before = await fixture.owner.loadTask(fixture.task.taskId);
  const beforeLedgers = fixture.owner.getLedgers();
  const beforeAuthority = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(before && beforeAuthority);

  try {
    const inFlight = fixture.owner.recordVerificationApproval(current.request);
    await resolutionEntered;
    const mismatchedRequests: readonly RecordVerificationApprovalRequestV02[] = [
      { ...current.request, workspaceId: 'workspace-other' },
      { ...current.request, repositoryId: 'repository-other' },
      { ...current.request, expectedPlanVersion: current.request.expectedPlanVersion + 1 },
    ];
    const mismatchedResults = mismatchedRequests.map((request) => fixture.owner.recordVerificationApproval(request));
    const coalesced = fixture.owner.recordVerificationApproval(current.request);
    assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), before);
    assert.deepEqual(fixture.owner.getLedgers(), beforeLedgers);
    const stillBefore = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
    assert.equal(stillBefore?.controlVersion, beforeAuthority.controlVersion);
    assert.equal(stillBefore?.epoch, beforeAuthority.epoch);
    assert.equal(resolutionCalls, 1);

    releaseResolution?.();
    const [approved, sameRequest, ...refused] = await Promise.all([inFlight, coalesced, ...mismatchedResults]);
    assert.equal(approved?.outcome, 'approved');
    assert.deepEqual(sameRequest, approved);
    assert.equal(refused.length, mismatchedRequests.length);
    for (const result of refused) {
      assert.equal(result?.outcome, 'conflict');
      assert.ok(result && !('state' in result));
      assert.ok(result && !('decisionId' in result));
    }
    const after = await fixture.owner.loadTask(fixture.task.taskId);
    assert.ok(after && approved?.outcome === 'approved');
    assert.deepEqual(after.approvalDecisionRefs, [...(before.approvalDecisionRefs ?? []), current.request.decisionId]);
    assert.equal(after.stateVersion, before.stateVersion + 1);
    assert.equal(after.repositoryRevisionDigest, before.repositoryRevisionDigest);
    assert.deepEqual(fixture.owner.getLedgers(), beforeLedgers);
    assert.equal(resolutionCalls, 1);
  } finally {
    releaseResolution?.();
  }
});
