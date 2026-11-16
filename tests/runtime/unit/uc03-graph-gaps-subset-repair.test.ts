/**
 * T053 gap 3 (SPEC-R3-001): a subset repair must be able to complete.
 *
 * Each repair round's admission binds only its own paths, so completion reconstructs the cumulative
 * inventory from the settled admissions. `state.changedPaths` is observed inventory, never admission
 * evidence, which rows (b) and (d) pin down. Row (a) is route-level with `MemoryStatePortV02` and
 * `FakeRepositoryPort`; both files change through settled `apply_patch` admissions.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeActionDigest, computeCanonicalSha256, type BugTask, type PolicyAuthorityRefV02, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { runUC03Graph, type UC03GraphConfig } from '../../../src/uc03/graph.ts';
import { createFixtureExecutorIdentityV02, createFixtureBugTask, createFixtureProviderAdmissionReceiptV02 } from '../support/uc03/port-fixtures.ts';
import { createGraphTaskState, seedGraphTaskState } from '../support/uc03/graph-fixtures.ts';
import { createTestRepositoryAdmissionContextV02, createTestRepositoryAdmissionTrustedContextV02 } from '../support/uc03/state-fixtures.ts';
import { createPendingApprovalRoute, ROUTE_PLAN_DETAILS, createPlanBindingDigest } from '../support/uc03/controlled-route.ts';
import type { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import type { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import type { BaselineEvidenceWriteRequest, BaselineEvidenceWriter } from '../../../src/uc03/investigation.ts';
import type { UC03CompletionContextRequest, UC03TrustedCompletion } from '../../../src/uc03/graph-types.ts';
import { reviewerContextDigest } from '../../../src/foundation/reviewer.ts';
import { createTestProviderAdmissionContextV02, createTestProviderAdmissionTrustedContextV02, createTestProviderRequest } from '../support/uc03/state-fixtures.ts';
import { computeRequestContentDigest, type ProviderPricingIdentityV02 } from '../../../src/contracts/foundation/uc03.ts';

const PATCH_AB = [
  '--- a/src/a.py',
  '+++ b/src/a.py',
  '@@ -0,0 +1,1 @@',
  '+def helper(): return 1',
  '--- a/src/b.py',
  '+++ b/src/b.py',
  '@@ -0,0 +1,1 @@',
  '@@ guards @@',
  '+def guard(b): return b == 0',
  '',
].join('\n');
const REPAIR_B = ['--- a/src/b.py', '+++ b/src/b.py', '@@ -1,1 +1,1 @@', '-def guard(b): return b == 0', '+def guard(b): return b != 0', ''].join('\n');
const REGRESSION_COMMAND = 'pytest -q tests/test_calculator.py';
const REPRODUCTION_COMMAND = 'pytest -q tests/test_calculator.py -k test_divide_zero';

/** Owner-issued patch admission bound to the current task state, as the route's own ports mint it. */
function patchAdmissionResolver(statePort: MemoryStatePortV02, repositoryPort: FakeRepositoryPort) {
  return async ({
    task,
    state,
    patchContent,
    targetPaths,
    actionId,
  }: {
    readonly task: BugTask;
    readonly state: TaskState;
    readonly patchContent: string;
    readonly targetPaths: readonly string[];
    readonly actionId?: string | undefined;
  }) => {
    const authority = await statePort.readVerificationAuthoritySnapshot(state.taskId);
    if (!authority) return undefined;
    // As in the shared helper: once a patch is admitted the reproduction check must pass, so a
    // failing Verify names only the regression check in its failure evidence.
    if (state.node === 'Patch' || state.node === 'Repair') repositoryPort.setCommandResult(REPRODUCTION_COMMAND, { exitCode: 0, stdout: '1 passed', stderr: '' });
    const action = {
      actionId: actionId ?? `patched-${state.taskId}-${state.stateVersion}`,
      kind: 'apply_patch' as const,
      patchContent,
      targetPaths,
      baseRevisionDigest: state.repositoryRevisionDigest,
    };
    const journal = statePort.getJournalSnapshot();
    const context = createTestRepositoryAdmissionContextV02({
      taskId: state.taskId,
      runId: state.runId,
      workspaceId: state.workspaceId,
      repositoryId: state.repositoryId,
      canonicalRevision: state.repositoryRevisionDigest,
      expectedTaskStateVersion: state.stateVersion,
      expectedControlVersion: journal.controlVersion,
      expectedEpoch: journal.epoch,
      policyAuthorityRef: { ...authority.policyIdentity, decisionAuthorityGeneration: authority.decisionAuthorityGeneration },
      action,
      baseRevision: state.repositoryRevisionDigest,
      targetPaths,
      patchDigest: computeCanonicalSha256(patchContent),
      planDecisionRef: state.plan?.decisionRef,
      planBindingDigest: createPlanBindingDigest(task, state),
      reservationRefs: [`repair-slot:${state.taskId}:${state.stateVersion}`],
      runnableNode: state.node,
      planApplicability: 'approved-plan',
    });
    repositoryPort.setExecutorIdentity(createFixtureExecutorIdentityV02({ payloadDigest: computeActionDigest(action) }));
    return { context, trustedContext: createTestRepositoryAdmissionTrustedContextV02(context) };
  };
}

/** Reviewer admission shaped like the runtime's, so the review settles inside the model boundary. */
function reviewerAdmissionResolver(statePort: MemoryStatePortV02) {
  return async ({
    task,
    state,
    diff,
  }: {
    readonly task: BugTask;
    readonly state: TaskState;
    readonly diff: { readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] };
  }) => {
    const ownerAuthority = await statePort.readVerificationAuthoritySnapshot(task.taskId);
    if (!ownerAuthority) return undefined;
    const contextDigest = reviewerContextDigest(task, diff.diff, [], state.repositoryRevisionDigest, { runId: state.runId, expectedTaskStateVersion: state.stateVersion });
    if (contextDigest === null) return undefined;
    const request = createTestProviderRequest({
      providerRequestId: `provider-${task.taskId}-${state.stateVersion}`,
      taskId: task.taskId,
      runId: state.runId,
      role: 'reviewer',
      purpose: 'final-review',
      configId: ownerAuthority.policyIdentity.configId,
      pricingPolicyId: ownerAuthority.policyIdentity.policyId,
      contextDigest,
      reservationRef: `review-allowance:${task.taskId}:${state.stateVersion}`,
    });
    const providerIdentity: ProviderPricingIdentityV02 = {
      providerId: request.providerId,
      modelId: request.modelId,
      configId: request.configId,
      configVersion: ownerAuthority.policyIdentity.configVersion,
      pricingPolicyId: ownerAuthority.policyIdentity.policyId,
      pricingPolicyVersion: ownerAuthority.policyIdentity.policyVersion,
      issuerKeyRef: ownerAuthority.policyIdentity.issuerKeyRef,
      decisionAuthorityGeneration: ownerAuthority.decisionAuthorityGeneration,
    };
    const journal = statePort.getJournalSnapshot();
    const context = createTestProviderAdmissionContextV02({
      providerRequest: request,
      providerIdentity,
      providerAdmissionReceipt: createFixtureProviderAdmissionReceiptV02({
        providerRequestId: request.providerRequestId,
        role: 'reviewer',
        requestContentDigest: computeRequestContentDigest(request),
        providerId: providerIdentity.providerId,
        modelId: providerIdentity.modelId,
        configId: providerIdentity.configId,
        configVersion: providerIdentity.configVersion,
        decisionAuthorityGeneration: providerIdentity.decisionAuthorityGeneration,
      }),
      taskId: task.taskId,
      runId: state.runId,
      runnableNode: 'Review',
      role: 'reviewer',
      expectedTaskStateVersion: state.stateVersion,
      expectedControlVersion: journal.controlVersion,
      expectedEpoch: journal.epoch,
      planApplicability: 'approved-plan',
      planDecisionRef: state.plan?.decisionRef,
      planBindingDigest: createPlanBindingDigest(task, state),
      budgetRefs: [
        `task-tokens:${request.providerRequestId}`,
        `task-cost:${request.providerRequestId}`,
        `run-tokens:${request.providerRequestId}`,
        `run-cost:${request.providerRequestId}`,
        `task-iteration:${request.providerRequestId}`,
      ],
    });
    return { request, context, trustedContext: createTestProviderAdmissionTrustedContextV02(context) };
  };
}

interface SubsetRepairRoute {
  readonly run: Awaited<ReturnType<typeof runUC03Graph>>;
  readonly statePort: MemoryStatePortV02;
  readonly repositoryPort: FakeRepositoryPort;
  /** Owner state after the B-only repair settled at Verify, before the completion attempt. */
  readonly stateBeforeCompletion: TaskState;
  readonly patchesBeforeCompletion: number;
}

/**
 * Drive the controlled route through an A+B patch, a failing check, a B-only repair and the
 * completion attempt. `beforeCompletion` runs with the repair settled at Verify and no approval yet,
 * which is where rows (b) and (c) inject their faults.
 */
async function driveSubsetRepair(
  beforeCompletion?: (context: { readonly task: BugTask; readonly statePort: MemoryStatePortV02; readonly repositoryPort: FakeRepositoryPort; readonly state: TaskState }) => Promise<void>,
): Promise<SubsetRepairRoute> {
  let minted: UC03TrustedCompletion | undefined;
  // A `dec-plan-`-prefixed decision keeps the two approval rounds distinguishable by prefix.
  const decisionRef = `dec-plan-${createFixtureBugTask().taskId}-1`;
  const route = createPendingApprovalRoute('pending', decisionRef, {}, undefined, undefined, next =>
    next.node === 'Deliver' && next.outcome === 'COMPLETED' && minted?.repositoryRevisionDigest === next.repositoryRevisionDigest ? { completion: minted } : undefined,
  );
  const { task, statePort, repositoryPort, approvalPort } = route;
  // The controlled writer keeps its records private, which a resumed Verify cannot read back; wrap
  // it so each settled baseline stays loadable, as the production owner's does.
  const stored = new Map<string, Awaited<ReturnType<NonNullable<BaselineEvidenceWriter['loadBaselineEvidence']>>>>();
  const inner = route.ports.baselineEvidenceWriter;
  assert.ok(inner);
  const ports = {
    ...route.ports,
    baselineEvidenceWriter: {
      async persistBaselineEvidence(request: BaselineEvidenceWriteRequest) {
        const acknowledgement = await inner.persistBaselineEvidence(request);
        stored.set(acknowledgement.evidenceId, { content: structuredClone(request.content), acknowledgement: structuredClone(acknowledgement) });
        return acknowledgement;
      },
      async loadBaselineEvidence(_taskId: string, _workspaceId: string, _repositoryId: string, evidenceId: string) {
        return stored.get(evidenceId) ?? null;
      },
    } satisfies BaselineEvidenceWriter,
  };
  await seedGraphTaskState(statePort, createGraphTaskState(task));
  const approveLatest = async (prefix: 'dec-plan-' | 'dec-verify-') => {
    const binding = approvalPort
      .getRecordedBindings()
      .filter(candidate => candidate.decisionId.startsWith(prefix))
      .at(-1);
    assert.ok(binding, `owner issued no ${prefix} decision`);
    const snapshot = await statePort.readVerificationAuthoritySnapshot(task.taskId);
    assert.ok(snapshot);
    const authorityRef: PolicyAuthorityRefV02 = { ...snapshot.policyIdentity, decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration + 1 };
    assert.equal((await statePort.publishAuthority({ authorityRef })).status, 'published');
    approvalPort.setV02AuthorityRef(authorityRef);
    approvalPort.scriptDecision({ ...binding, status: 'approved' });
  };
  const completionContextFor = async (input: UC03CompletionContextRequest): Promise<UC03TrustedCompletion | undefined> => {
    const record: UC03TrustedCompletion = {
      taskId: input.task.taskId,
      runId: input.state.runId,
      repositoryRevisionDigest: input.state.repositoryRevisionDigest,
      diffDigest: input.diffInfo.diffDigest,
      checkSetDigest: input.checkSetDigest,
      baselineRef: input.baseline.evidenceId,
      criteriaDigest: computeCanonicalSha256(input.task.acceptanceCriteria),
      authorizedDiffDigest: input.diffInfo.diffDigest,
      protectedTestsDigest: input.protectedTestsDigest,
      originalProtectedTestsDigest: input.originalProtectedTestsDigest,
      reviewerRoleConfigId: input.reviewResult.reviewerRoleConfigId,
      reviewIterationReservationRef: input.reviewRequest.reservationRef,
      checks: input.verificationResults,
      review: input.reviewResult,
    };
    minted = record;
    return structuredClone(record);
  };
  approvalPort.scriptClassification('apply_patch', 'ALLOWED');
  const config: UC03GraphConfig = {
    mode: 'development',
    trustedExpectedContext: route.config.trustedExpectedContext,
    planDetails: { diagnosis: ROUTE_PLAN_DETAILS.diagnosis, strategy: ROUTE_PLAN_DETAILS.strategy, suspectedCauseLocations: ['src/a.py', 'src/b.py'], scopedChanges: ['src/a.py', 'src/b.py'] },
    admissionContext: patchAdmissionResolver(statePort, repositoryPort),
    reviewerAdmission: reviewerAdmissionResolver(statePort),
    completionContextFor,
    patchContent: PATCH_AB,
    targetPaths: ['src/a.py', 'src/b.py'],
  };

  const plan = await runUC03Graph(task, ports, config);
  assert.equal(plan.outcome, 'pending-approval', JSON.stringify(plan.reasons));
  await approveLatest('dec-plan-');
  const patched = await runUC03Graph(task, ports, config);
  assert.equal(patched.outcome, 'pending-approval', JSON.stringify({ reasons: patched.reasons, node: patched.state?.node }));
  const [firstPatch] = repositoryPort.patches;
  assert.ok(firstPatch, 'the A+B patch settled');
  assert.deepEqual([...firstPatch.targetPaths].sort(), ['src/a.py', 'src/b.py']);

  // The first Verify must fail so the route reaches Repair; the reproduction command is reset by the
  // patch admission itself, so the regression check is what fails this round.
  const regression = task.requiredChecks.find(check => check.purpose === 'regression');
  assert.ok(regression);
  repositoryPort.setCommandResult(REGRESSION_COMMAND, { exitCode: 1, stdout: 'FAILED after the A+B patch', stderr: '' });
  const afterPatch = await statePort.loadTask(task.taskId);
  assert.ok(afterPatch);
  const failedDiff = await repositoryPort.inspectDiff(task.initialRevisionDigest);
  const failureEvidenceId = `evidence-verif-${regression.checkId}-${computeCanonicalSha256([afterPatch.runId, regression.checkId, afterPatch.repositoryRevisionDigest, failedDiff.diffDigest])}`;
  await approveLatest('dec-verify-');
  const repaired = await runUC03Graph(task, ports, {
    ...config,
    repairPatch: { diff: REPAIR_B, affectedPaths: ['src/b.py'], evidenceRefs: [failureEvidenceId], diagnosticRefs: ['execution-guard:success'] },
  });
  assert.equal(repaired.outcome, 'pending-approval', JSON.stringify({ reasons: repaired.reasons, node: repaired.state?.node }));
  const repairPatch = repositoryPort.patches[1];
  assert.ok(repairPatch, 'the B-only repair settled');
  assert.deepEqual([...repairPatch.targetPaths], ['src/b.py']);
  // Both files really changed through settled admissions, so the cumulative diff is honest.
  const cumulative = await repositoryPort.inspectDiff(task.initialRevisionDigest);
  assert.deepEqual([...cumulative.changedFiles].sort(), ['src/a.py', 'src/b.py']);

  const stateBeforeCompletion = await statePort.loadTask(task.taskId);
  assert.ok(stateBeforeCompletion);
  assert.equal(stateBeforeCompletion.node, 'Verify');
  await beforeCompletion?.({ task, statePort, repositoryPort, state: structuredClone(stateBeforeCompletion) });

  repositoryPort.setCommandResult(REGRESSION_COMMAND, { exitCode: 0, stdout: '1 passed', stderr: '' });
  await approveLatest('dec-verify-');
  const run = await runUC03Graph(task, ports, config);
  return { run, statePort, repositoryPort, stateBeforeCompletion, patchesBeforeCompletion: repositoryPort.patches.length };
}

test('(a) an A+B patch followed by a B-only repair completes the route', async () => {
  const { run, statePort } = await driveSubsetRepair();
  assert.equal(run.outcome, 'COMPLETED', JSON.stringify({ reasons: run.reasons, node: run.state?.node }));
  assert.equal(run.state?.node, 'Deliver');
  assert.equal(run.finalReport?.isComplete, true);
  assert.ok(run.state);
  const persisted = await statePort.loadTask(run.state.taskId);
  assert.deepEqual(persisted, run.state);
  assert.deepEqual([...run.state.changedPaths].sort(), ['src/a.py', 'src/b.py']);
});

test('(b) a cumulative-diff path no settled admission declared is refused', async () => {
  const { run, statePort, repositoryPort, stateBeforeCompletion, patchesBeforeCompletion } = await driveSubsetRepair(async ({ repositoryPort: repository, state }) => {
    // Written straight into the fake snapshot, outside any admission, so only observed inventory
    // knows about it. Verify will union it into `changedPaths`.
    const files: Record<string, string> = {};
    for (const path of ['tests/test_calculator.py', 'src/a.py', 'src/b.py']) files[path] = (await repository.readFile(path)).boundedExcerpt;
    files['src/c.py'] = 'def unadmitted(): return None\n';
    repository.setSnapshot(state.repositoryRevisionDigest, files);
  });
  assert.notEqual(run.outcome, 'COMPLETED', JSON.stringify(run.reasons));
  assert.equal(run.finalReport?.outcome, run.outcome);
  assert.equal(run.finalReport?.isComplete, false);
  assert.ok(
    run.reasons.some(reason => reason.includes('Owner-settled patch receipt does not bind the approved plan and current repository diff')),
    JSON.stringify(run.reasons),
  );
  const persisted = await statePort.loadTask(stateBeforeCompletion.taskId);
  // The only write is the route's own documented halt; no Deliver/COMPLETED evidence was recorded
  // and the repository saw no further effects.
  assert.equal(persisted?.node, 'Repair');
  assert.equal(persisted?.nextAction, 'halt-missing-completion-evidence');
  assert.equal(persisted?.outcome, undefined);
  assert.equal(persisted?.repositoryRevisionDigest, stateBeforeCompletion.repositoryRevisionDigest);
  assert.equal(repositoryPort.patches.length, patchesBeforeCompletion);
  assert.deepEqual(persisted, run.state);
});

test('(c) an unreachable chain link is refused', async () => {
  const { run, statePort, repositoryPort, stateBeforeCompletion, patchesBeforeCompletion } = await driveSubsetRepair(async ({ statePort: owner, state }) => {
    const readAncestry = owner.readSettledPatchAncestry.bind(owner);
    const initialPatchRevision = state.repositoryRevisionDigest;
    // Stand in for an owner that cannot reach the link its own journal recorded earlier.
    owner.readSettledPatchAncestry = async request => (request.resultingRepositoryRevisionDigest === initialPatchRevision ? readAncestry(request) : null);
  });
  assert.notEqual(run.outcome, 'COMPLETED', JSON.stringify(run.reasons));
  assert.equal(run.finalReport?.isComplete, false);
  assert.ok(
    run.reasons.some(reason => reason.includes('Owner-settled patch receipt does not bind the approved plan and current repository diff')),
    JSON.stringify(run.reasons),
  );
  const persisted = await statePort.loadTask(stateBeforeCompletion.taskId);
  assert.equal(persisted?.node, 'Repair');
  assert.equal(persisted?.nextAction, 'halt-missing-completion-evidence');
  assert.equal(persisted?.repositoryRevisionDigest, stateBeforeCompletion.repositoryRevisionDigest);
  assert.equal(repositoryPort.patches.length, patchesBeforeCompletion);
});
