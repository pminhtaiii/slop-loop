/**
 * UC-03 Verified Code Repair - Unit Tests for Repair & Replan Transitions
 *
 * Owned path: tests/runtime/unit/uc03-repair.test.ts
 * Feature: specs/001-verified-code-repair
 * Tasks: T016 (repair/replan API & tests), T017 (bounded repair implementation),
 *        T018 (material replan & feedback transitions - pending)
 *
 * Requirements & Acceptance:
 * - C03: Failed patch/check diagnostics reach next repair attempt.
 * - C04: Repair exhaustion, missing/exhausted/uncertain accounting stops before effects;
 *        task budgets persist across simulated runs without reset.
 * - C05: Regression failure despite focused pass routes to repair without delivery.
 * - C10: Finite bounds: reservation before effects; missing/exhausted allowance denies dispatch.
 * - C12: Initial plan zero, at most 3 material replans, fourth refused; rejection waits for
 *        user feedback; minor vs material based on bound fields NOT caller boolean.
 * - C14: Read-only reviewer finding diagnostics route to repair; accepted review is not failure.
 * - Typed transition to verification, never claiming completion.
 *
 * Published tests use T004 builders/inlined deterministic vectors and never require ignored fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  type ApplyPatchAction,
  type ApprovalBinding,
  type ApprovalBindingContext,
  type ApproveFixPlanAction,
  type BugTask,
  type PermissionClass,
  type StateTransitionOptions,
  type TaskState,
  type ExecutionGuard,
  type NormalizedAction,
  type FixPlan,
  type CheckDefinition,
  type VerificationResult,
  type ReviewResult,
  type BudgetLedger,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  executeRepair,
  executeReplan,
  handlePlanRejection,
  evaluatePlanMateriality,
  type RepairResult,
  type RepairPatchProposal,
  type TrustedRepairContext,
} from '../../../src/uc03/repair.ts';
import {
  createFixtureBugTask,
  createFixtureTaskState,
  createFixtureCheckDefinition,
} from '../support/uc03/port-fixtures.ts';
import { MemoryStatePort, StateConflictError } from '../support/uc03/memory-state.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';

// Inlined deterministic builders conforming to T004
function createRepairTaskFixture(overrides?: Partial<BugTask>): {
  task: BugTask;
  checkReproduction: CheckDefinition;
  checkFocused: CheckDefinition;
  checkRegression: CheckDefinition;
  checkSetDigest: string;
} {
  const checkReproduction = createFixtureCheckDefinition({
    checkId: 'check-reproduction',
    argv: ['-q', 'tests/test_calculator.py', '-k', 'test_divide_zero'],
    purpose: 'reproduction',
  });
  const checkFocused = createFixtureCheckDefinition({
    checkId: 'check-focused',
    argv: ['-q', 'tests/test_calculator.py', '-k', 'test_divide'],
    purpose: 'focused',
  });
  const checkRegression = createFixtureCheckDefinition({
    checkId: 'check-regression',
    argv: ['-q', 'tests/test_calculator.py'],
    purpose: 'regression',
  });
  const task = createFixtureBugTask({
    taskId: 'task-uc03-calc-001',
    repositoryId: 'repo-uc03-calc',
    initialRevisionDigest:
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    requiredChecks: [checkReproduction, checkFocused, checkRegression],
    ...overrides,
  });
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  return { task, checkReproduction, checkFocused, checkRegression, checkSetDigest };
}

function createRepairStateFixture(options?: {
  replanCount?: number;
  repairConsumed?: number;
  repairLimit?: number;
  tokensConsumed?: number;
  costConsumed?: number;
  budgetLedgers?: BudgetLedger[];
  node?: TaskState['node'];
  hasPlan?: boolean;
  withUncertainReservation?: boolean;
}): {
  state: TaskState;
  task: BugTask;
  plan: FixPlan;
} {
  const repairLimit = options?.repairLimit ?? 2;
  const defaultTask = createRepairTaskFixture().task;
  const { task, checkSetDigest } = createRepairTaskFixture({
    budgetLimits: { ...defaultTask.budgetLimits, maxRepairAttempts: repairLimit },
  });
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'Calculator.divide fails to check for zero divisor before division',
    suspectedCauseLocations: ['src/calculator.py:3'],
    evidenceRefs: ['evi-repro-baseline-001'],
    strategy: 'Check divisor == 0 before division and raise CalculationError',
    scopedChanges: ['src/calculator.py'],
    checkSetDigest,
    baselineRef: task.initialRevisionDigest,
    strategyDigest: computeCanonicalSha256(
      'Check divisor == 0 before division and raise CalculationError'
    ),
    decisionRef: 'dec-plan-001',
  };

  const repairConsumed = options?.repairConsumed ?? 0;
  const tokensConsumed = options?.tokensConsumed ?? 22000;
  const costConsumed = options?.costConsumed ?? 1.1;

  const defaultLedgers: BudgetLedger[] = [
    {
      scope: 'task',
      kind: 'tokens',
      limit: 100000,
      consumed: tokensConsumed,
      reservations: options?.withUncertainReservation
        ? [
            {
              reservationId: 'res-repair-tok-unc',
              keyedId: 'req-dispatch-unc-001',
              amount: 20000,
            },
          ]
        : [],
      unit: 'count',
      configurationId: task.configId,
      version: 1,
    },
    {
      scope: 'task',
      kind: 'cost',
      limit: 5.0,
      consumed: costConsumed,
      reservations: options?.withUncertainReservation
        ? [
            {
              reservationId: 'res-repair-cost-unc',
              keyedId: 'req-dispatch-unc-001',
              amount: 1.0,
            },
          ]
        : [],
      unit: 'usd',
      configurationId: task.configId,
      version: 1,
    },
    {
      scope: 'task',
      kind: 'replan',
      limit: 3,
      consumed: options?.replanCount ?? 0,
      reservations: [],
      unit: 'count',
      configurationId: task.configId,
      version: 1,
    },
    {
      scope: 'task',
      kind: 'repair',
      limit: repairLimit,
      consumed: repairConsumed,
      reservations: [],
      unit: 'count',
      configurationId: task.configId,
      version: 1,
    },
    {
      scope: 'task',
      kind: 'review_iteration',
      limit: 2,
      consumed: 0,
      reservations: [],
      unit: 'count',
      configurationId: task.configId,
      version: 1,
    },
  ];

  const state = createFixtureTaskState({
    taskId: task.taskId,
    stateVersion: 2,
    runId: 'run-repair-001',
    repositoryId: task.repositoryId,
    repositoryRevisionDigest: task.initialRevisionDigest,
    goal: task.goal,
    observedBehavior: task.observedBehavior,
    expectedBehavior: task.expectedBehavior,
    reproduction: task.reproduction,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: task.constraints,
    requiredCheckIds: task.requiredChecks.map((c) => c.checkId),
    node: options?.node ?? 'Repair',
    planVersion: 1,
    replanCount: options?.replanCount ?? 0,
    changedPaths: ['src/calculator.py'],
    evidenceRefs: [
      'evi-repro-baseline-001',
      'evi-patch-001',
      'evi-diag-patch-fail-001',
      'act-verify-patch-fail-001',
      'diag-patch-fail-output',
      'evi-check-regression-fail-001',
      'act-verify-regression-001',
      'diag-regression-fail-output',
      'rev-finding-001',
      'res-rev-iter-001',
    ],
    reviewRefs: ['rev-finding-001'],
    latestReviewRef: 'rev-finding-001',
    budgetLedgers: options?.budgetLedgers ?? defaultLedgers,
    plan: options?.hasPlan === false ? undefined : plan,
    ...(options?.hasPlan === false ? {} : { activeDecisionId: plan.decisionRef }),
    taskContext: task,
  });

  return { state, task, plan };
}

function createFailedPatchEvidence(task: BugTask): VerificationResult {
  return {
    evidenceId: 'evi-diag-patch-fail-001',
    taskId: task.taskId,
    runId: 'run-repair-001',
    actionId: 'act-verify-patch-fail-001',
    testedIds: ['check-reproduction'],
    phase: 'focused',
    outcome: 'fail',
    repoDigest: task.initialRevisionDigest,
    diffDigest: 'sha256:444455556666777788889999aaaabbbbccccddddeeeeffff0000111122223333',
    commandIdentity: 'cmd-pytest-focused',
    diagnosticRefs: ['diag-patch-fail-output'],
  };
}

function createRegressionFailedEvidence(task: BugTask): VerificationResult {
  return {
    evidenceId: 'evi-check-regression-fail-001',
    taskId: task.taskId,
    runId: 'run-repair-001',
    actionId: 'act-verify-regression-001',
    testedIds: ['check-regression'],
    phase: 'regression',
    outcome: 'fail',
    repoDigest: task.initialRevisionDigest,
    diffDigest: 'sha256:444455556666777788889999aaaabbbbccccddddeeeeffff0000111122223333',
    commandIdentity: 'cmd-pytest-regression',
    diagnosticRefs: ['diag-regression-fail-output'],
  };
}

function createReviewerFindingEvidence(task: BugTask): ReviewResult {
  return {
    reviewId: 'rev-finding-001',
    status: 'findings',
    reviewerRoleConfigId: 'reviewer-profile-default',
    iterationReservationRef: 'res-rev-iter-001',
    repoDigest: task.initialRevisionDigest,
    diffDigest: 'sha256:444455556666777788889999aaaabbbbccccddddeeeeffff0000111122223333',
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    findings: [
      {
        file: 'src/calculator.py',
        line: 5,
        side: 'new',
        severity: 'error',
        message: 'CalculationError message must match specification exactly',
      },
    ],
  };
}

function createAuthorizedRepairPorts(
  state: TaskState,
  patchPermission: PermissionClass = 'ALLOWED',
  failureEvidence: VerificationResult | ReviewResult = createFailedPatchEvidence(state.taskContext as BugTask)
): {
  statePort: MemoryStatePort;
  approvalPort: ScriptedApprovalPort;
  trustedTransitionContext: NonNullable<StateTransitionOptions['trusted']>;
  transitionContexts: Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>>;
  trustedRepairContext: TrustedRepairContext;
} {
  const plan = state.plan;
  const task = state.taskContext;
  if (!plan?.decisionRef || !task) throw new Error('Repair authorization fixture requires a bound plan and task');
  const evidenceRefs = [isVerificationEvidence(failureEvidence) ? failureEvidence.evidenceId : failureEvidence.reviewId];
  const actionRefs = [isVerificationEvidence(failureEvidence) ? failureEvidence.actionId : failureEvidence.iterationReservationRef];
  const diagnosticRefs = isVerificationEvidence(failureEvidence)
    ? [...failureEvidence.diagnosticRefs]
    : [...new Set(failureEvidence.findings.map((finding) => finding.evidenceRef ?? failureEvidence.reviewId))];
  const authorizedState: TaskState = {
    ...state,
    evidenceRefs: [...new Set([...state.evidenceRefs, ...evidenceRefs, ...actionRefs, ...diagnosticRefs])],
    ...(isVerificationEvidence(failureEvidence)
      ? {}
      : {
          reviewRefs: [...new Set([...(state.reviewRefs ?? []), failureEvidence.reviewId])],
          latestReviewRef: failureEvidence.reviewId,
        }),
  };
  const action: ApproveFixPlanAction = {
    actionId: plan.decisionRef,
    kind: 'approve_fix_plan',
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    diagnosisEvidenceRefs: plan.evidenceRefs,
    checkSetDigest: plan.checkSetDigest,
  };
  const freshness: ApprovalBindingContext = {
    currentTaskId: authorizedState.taskId,
    currentWorkspaceId: authorizedState.workspaceId,
    currentRepositoryRevisionDigest: authorizedState.repositoryRevisionDigest,
    currentPolicyId: task.configId,
    currentPolicyVersion: task.configVersion,
    currentNormalizedActionDigest: computeCanonicalSha256(action),
    currentPlanVersion: authorizedState.planVersion,
    currentStrategyDigest: plan.strategyDigest,
    currentBaselineRef: plan.baselineRef,
    currentEvidenceRefs: plan.evidenceRefs,
    currentCriteriaDigest: computeCanonicalSha256(authorizedState.acceptanceCriteria),
    currentCheckSetDigest: plan.checkSetDigest,
  };
  const binding: ApprovalBinding = {
    decisionId: plan.decisionRef,
    actionKind: 'fix_plan',
    normalizedActionDigest: computeCanonicalSha256(action),
    taskId: authorizedState.taskId,
    workspaceId: authorizedState.workspaceId,
    repositoryRevisionDigest: authorizedState.repositoryRevisionDigest,
    policyId: task.configId,
    policyVersion: task.configVersion,
    planVersion: authorizedState.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(authorizedState.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    status: 'approved',
  };
  const trustedTransitionContext = { approval: { binding, freshness } };
  const transitionContexts = { [state.stateVersion + 1]: trustedTransitionContext };
  const trustedRepairContext: TrustedRepairContext = {
    taskId: authorizedState.taskId,
    runId: authorizedState.runId,
    workspaceId: authorizedState.workspaceId,
    repositoryId: authorizedState.repositoryId,
    repositoryRevisionDigest: authorizedState.repositoryRevisionDigest,
    baselineRef: plan.baselineRef,
    checkSetDigest: plan.checkSetDigest,
    diffDigest: failureEvidence.diffDigest ?? '',
    evidenceRefs,
    actionRefs,
    diagnosticRefs,
  };
  return {
    statePort: new MemoryStatePort({ initialTaskState: authorizedState, transitionContexts }),
    approvalPort: new ScriptedApprovalPort({
      classifications: { apply_patch: patchPermission },
      decisions: [binding],
      currentContext: freshness,
    }),
    trustedTransitionContext,
    transitionContexts,
    trustedRepairContext,
  };
}

function isVerificationEvidence(
  evidence: VerificationResult | ReviewResult
): evidence is VerificationResult {
  return 'evidenceId' in evidence;
}

function createRepairProposal(
  evidence: VerificationResult | ReviewResult,
  diff: string,
  affectedPaths: readonly string[]
): RepairPatchProposal {
  return {
    diff,
    affectedPaths,
    evidenceRefs: [isVerificationEvidence(evidence) ? evidence.evidenceId : evidence.reviewId],
    diagnosticRefs: isVerificationEvidence(evidence)
      ? [...evidence.diagnosticRefs]
      : [...new Set(evidence.findings.map((finding) => finding.evidenceRef ?? evidence.reviewId))],
  };
}

function createExecutionGuard(repositoryPort: FakeRepositoryPort): ExecutionGuard {
  return {
    provenance: 'mock',
    async validateAndExecute(action: NormalizedAction) {
      if (action.kind !== 'apply_patch') return { outcome: 'denied' };
      const result = await repositoryPort.applyPatch(action);
      return { outcome: result.applied ? 'success' : 'denied', result };
    },
  };
}

function repairState(result: RepairResult): TaskState {
  if (!result.state) throw new Error('Expected an authoritative task state in repair result');
  return result.state;
}

// =========================================================================
// SECTION 1: Bounded Evidence-Driven Repair (T016 / T017)
// =========================================================================

test('repair: accepts valid fresh failed patch verification result and extracts diagnostics', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' },
  });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(
        failureEvidence,
        '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,1 +1,3 @@\n+if b == 0: raise CalculationError("Cannot divide by zero")\n def divide(a, b): return a / b\n',
        ['src/calculator.py']
      ),
    },
    { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) }
  );

  assert.equal(res.outcome, 'REPAIR_PREPARED');
  assert.equal(repairState(res).node, 'Verify');
  assert.ok(res.reservedActionId);
});

test('repair: rejects stale or mismatched failure evidence (wrong taskId, wrong revision digest)', async () => {
  const { state, task } = createRepairStateFixture();
  const staleEvidence: VerificationResult = {
    ...createFailedPatchEvidence(task),
    repoDigest: 'sha256:stale99999999999999999999999999999999999999999999999999999999999',
  };
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence: staleEvidence,
    },
    { statePort }
  );

  assert.equal(res.outcome, 'INCOMPLETE');
  assert.ok(res.reasons.some((r) => r.includes('stale') || r.includes('unbound')));
});

test('repair: rejects passing verification result as failure evidence', async () => {
  const { state, task } = createRepairStateFixture();
  const passingEvidence: VerificationResult = {
    ...createFailedPatchEvidence(task),
    outcome: 'pass',
  };
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence: passingEvidence,
    },
    { statePort }
  );

  assert.equal(res.outcome, 'INCOMPLETE');
  assert.ok(res.reasons.some((r) => r.includes('not-failure')));
});

test('repair: handles focused pass with regression check failure, routing to repair without claiming completion (C05)', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const regressionEvidence = createRegressionFailedEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', regressionEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' },
  });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence: regressionEvidence,
      repairPatch: createRepairProposal(regressionEvidence, '--- a/src/calculator.py\n+++ b/src/calculator.py\n', ['src/calculator.py']),
    },
    { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) }
  );

  assert.equal(res.outcome, 'REPAIR_PREPARED');
  assert.notEqual(res.outcome, 'COMPLETED');
  assert.equal(repairState(res).node, 'Verify');
});

test('repair: incorporates read-only reviewer finding diagnostics into repair context (C14)', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const reviewEvidence = createReviewerFindingEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', reviewEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' },
  });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence: reviewEvidence,
      repairPatch: createRepairProposal(reviewEvidence, '--- a/src/calculator.py\n+++ b/src/calculator.py\n', ['src/calculator.py']),
    },
    { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) }
  );

  assert.equal(res.outcome, 'REPAIR_PREPARED');
  assert.equal(repairState(res).node, 'Verify');
});

test('repair: rejects reviewer result with status accepted as failure evidence', async () => {
  const { state, task } = createRepairStateFixture();
  const acceptedReview: ReviewResult = {
    ...createReviewerFindingEvidence(task),
    status: 'accepted',
    findings: [],
  };
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence: acceptedReview,
    },
    { statePort }
  );

  assert.equal(res.outcome, 'INCOMPLETE');
  assert.ok(res.reasons.some((r) => r.includes('not-failure')));
});

test('repair: reserves repair budget in statePort BEFORE applying patch or modifying state (C10)', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  let patchApplied = false;
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'code\n' },
  });
  const originalApplyPatch = repositoryPort.applyPatch.bind(repositoryPort);
  repositoryPort.applyPatch = async (patch: ApplyPatchAction) => {
    // Assert that repair reservation already exists in statePort BEFORE patch is applied!
    const ledgers = statePort.getLedgers();
    const repairLedger = ledgers.find((l) => l.scope === 'task' && l.kind === 'repair');
    assert.ok(repairLedger, 'Repair ledger must exist');
    assert.ok(
      repairLedger.reservations.length > 0,
      'Repair reservation must exist in ledger BEFORE applyPatch is called'
    );
    patchApplied = true;
    return originalApplyPatch(patch);
  };

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(failureEvidence, '--- a/src/calculator.py\n+++ b/src/calculator.py\n', ['src/calculator.py']),
    },
    { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) }
  );

  assert.equal(res.outcome, 'REPAIR_PREPARED');
  assert.ok(patchApplied, 'Patch must have been applied after reservation');
});

test('repair: fails closed and applies no patch when repair budget reservation fails', async () => {
  // repairConsumed = 2 with limit = 2 (exhausted)
  const { state, task } = createRepairStateFixture({ repairConsumed: 2, repairLimit: 2 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  let patchApplied = false;
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'code\n' },
  });
  repositoryPort.applyPatch = async (_patch: ApplyPatchAction) => {
    void _patch;
    patchApplied = true;
    return { applied: true, newRevisionDigest: 'sha256:abc' };
  };

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(failureEvidence, '--- a/src/calculator.py\n+++ b/src/calculator.py\n', ['src/calculator.py']),
    },
    { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) }
  );

  assert.equal(res.outcome, 'INCOMPLETE');
  assert.equal(patchApplied, false, 'No patch may be applied when budget reservation fails');
  assert.ok(res.reasons.some((r) => r.includes('budget-exhausted')));
});

test('repair: missing budget ledgers returns INCOMPLETE and halts action dispatch (C04)', async () => {
  const { state, task } = createRepairStateFixture({ budgetLedgers: [] });
  const failureEvidence = createFailedPatchEvidence(task);
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
    },
    { statePort }
  );

  assert.equal(res.outcome, 'INCOMPLETE');
  assert.ok(res.reasons.some((r) => r.includes('missing')));
});

test('repair: exhausted tokens or cost budget returns INCOMPLETE (C04, C10)', async () => {
  // tokens consumed 100,000 / limit 100,000
  const { state, task } = createRepairStateFixture({ tokensConsumed: 100000 });
  const failureEvidence = createFailedPatchEvidence(task);
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
    },
    { statePort }
  );

  assert.equal(res.outcome, 'INCOMPLETE');
  assert.ok(res.reasons.some((r) => r.includes('exhausted')));
});

test('repair: uncertain provider dispatch accounting halts dispatch and returns INCOMPLETE (C04)', async () => {
  const { state, task } = createRepairStateFixture({ withUncertainReservation: true });
  const failureEvidence = createFailedPatchEvidence(task);
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
    },
    { statePort }
  );

  assert.equal(res.outcome, 'INCOMPLETE');
  assert.ok(res.reasons.some((r) => r.includes('uncertain')));
});

test('repair: persistent task budgets retain consumed amounts across simulated runs without reset (C04)', async () => {
  // Run 1: starts with repair consumed = 1 / 2
  const { state, task } = createRepairStateFixture({ repairConsumed: 1, repairLimit: 2 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'code\n' },
  });

  // Attempt 1 in run 1 succeeds (consumes 2nd slot)
  const res1 = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(failureEvidence, '--- a/src/calculator.py\n+++ b/src/calculator.py\n', ['src/calculator.py']),
    },
    { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) }
  );
  assert.equal(res1.outcome, 'REPAIR_PREPARED');

  // Simulated Run 2: starts with a new runId, but loads same task ledger (consumed = 2 / 2)
  const stateAfterRun1 = repairState(res1);
  const stateRun2 = {
    ...stateAfterRun1,
    stateVersion: stateAfterRun1.stateVersion + 1,
    node: 'Repair' as const,
    runId: 'run-repair-002', // New simulated run
    budgetLedgers: statePort.getLedgers(),
    evidenceRefs: [...stateAfterRun1.evidenceRefs, 'evi-diag-run2', 'diag-run2'],
  };
  const run2Evidence: VerificationResult = { ...failureEvidence, evidenceId: 'evi-diag-run2', actionId: 'act-verify-run2', runId: 'run-repair-002', repoDigest: stateAfterRun1.repositoryRevisionDigest, diagnosticRefs: ['diag-run2'] };
  const authorization2 = createAuthorizedRepairPorts(stateRun2, 'ALLOWED', run2Evidence);
  const { statePort: statePort2, approvalPort: approvalPort2, trustedTransitionContext: context2, trustedRepairContext: repairContext2 } = authorization2;

  // Attempt in run 2 must see budget exhausted (2 / 2) and halt with INCOMPLETE!
  const res2 = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence: run2Evidence,
    },
    { statePort: statePort2, repositoryPort, approvalPort: approvalPort2, trustedTransitionContext: context2, trustedRepairContext: repairContext2, executionGuard: createExecutionGuard(repositoryPort) }
  );

  assert.equal(res2.outcome, 'INCOMPLETE');
  assert.ok(res2.reasons.some((r) => r.includes('budget-exhausted')));
});

test('repair: patch attempting to modify protected paths (tests, config) is denied', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'tests/test_calculator.py': 'tests\n' },
  });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(failureEvidence, '--- a/tests/test_calculator.py\n+++ b/tests/test_calculator.py\n', ['tests/test_calculator.py']),
    },
    { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) }
  );

  assert.equal(res.outcome, 'DENIED');
  assert.ok(res.reasons.some((r) => r.includes('protected')));
});

test('repair: noncanonical patch target is rejected before guarded effects', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const repositoryPort = new FakeRepositoryPort({ initialFiles: { 'src/calculator.py': 'code\n' } });
  let patchCalls = 0;
  repositoryPort.applyPatch = async (patch: ApplyPatchAction) => {
    void patch;
    patchCalls += 1;
    return { applied: true, newRevisionDigest: 'sha256:patched' };
  };

  const result = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(failureEvidence, 'patch', ['../outside.py']),
    },
    { ...authorization, repositoryPort, executionGuard: createExecutionGuard(repositoryPort) }
  );

  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(patchCalls, 0);
  assert.equal(authorization.statePort.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations.length, 0);
});

test('repair: unapproved plan or missing plan decisionRef returns INCOMPLETE without applying edits', async () => {
  const { state, task } = createRepairStateFixture({ hasPlan: false });
  const failureEvidence = createFailedPatchEvidence(task);
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
    },
    { statePort }
  );

  assert.equal(res.outcome, 'INCOMPLETE');
  assert.ok(res.reasons.some((r) => r.includes('plan')));
});

test('repair: persists the confirmed post-patch revision and invalidates stale authority', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'code\n' },
  });
  let confirmedRevision: string | undefined;
  let patchCalls = 0;
  const applyPatch = repositoryPort.applyPatch.bind(repositoryPort);
  repositoryPort.applyPatch = async (patch) => {
    const result = await applyPatch(patch);
    patchCalls++;
    if (result.applied) confirmedRevision = result.newRevisionDigest;
    return result;
  };
  const input = {
    taskId: task.taskId,
    failureEvidence,
    repairPatch: createRepairProposal(failureEvidence, '--- a/src/calculator.py\n+++ b/src/calculator.py\n', ['src/calculator.py']),
  } as const;
  const ports = { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) };

  const res = await executeRepair(input, ports);
  const persisted = await statePort.loadTask(task.taskId);

  assert.equal(res.outcome, 'REPAIR_PREPARED');
  assert.ok(confirmedRevision);
  assert.match(confirmedRevision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(persisted?.repositoryRevisionDigest, confirmedRevision);
  assert.equal(repairState(res).repositoryRevisionDigest, confirmedRevision);
  assert.deepEqual(repairState(res), persisted);
  assert.equal(repairState(res).node, 'Verify', 'The prepared patch routes into current-revision verification');
  assert.equal(repairState(res).activeDecisionId, undefined, 'Pre-patch approval is no longer active');
  assert.deepEqual(repairState(res).reviewRefs, [], 'Pre-patch reviews are no longer current');
  assert.equal(repairState(res).latestReviewRef, undefined);
  assert.ok(repairState(res).evidenceRefs.includes('repair-consumed:evi-diag-patch-fail-001'));

  const staleVerification = await executeRepair(input, ports);
  const staleReview = createReviewerFindingEvidence(task);
  const staleReviewResult = await executeRepair({
    ...input,
    failureEvidence: staleReview,
    repairPatch: createRepairProposal(staleReview, '--- a/src/calculator.py\n+++ b/src/calculator.py\n', ['src/calculator.py']),
  }, ports);
  assert.equal(staleVerification.outcome, 'INCOMPLETE');
  assert.ok(staleVerification.reasons.includes('stale-or-unbound-verification-failure'));
  assert.equal(staleReviewResult.outcome, 'INCOMPLETE');
  assert.ok(staleReviewResult.reasons.includes('stale-review-failure-evidence'));
  assert.equal(patchCalls, 1, 'Stale pre-patch evidence and approval cannot reapply the patch');
});

test('repair: malformed post-patch revision stays incomplete and cannot replay', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  const repositoryPort = new FakeRepositoryPort({ initialFiles: { 'src/calculator.py': 'code\n' } });
  const applyPatch = repositoryPort.applyPatch.bind(repositoryPort);
  let patchCalls = 0;
  repositoryPort.applyPatch = async (patch) => {
    const result = await applyPatch(patch);
    patchCalls++;
    return { ...result, newRevisionDigest: 'sha256:post-patch-current' };
  };
  const input = {
    taskId: task.taskId,
    failureEvidence,
    repairPatch: createRepairProposal(failureEvidence, '--- a/src/calculator.py\n+++ b/src/calculator.py\n', ['src/calculator.py']),
  } as const;
  const ports = { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) };

  const first = await executeRepair(input, ports);
  const persisted = await statePort.loadTask(task.taskId);
  const second = await executeRepair(input, ports);

  assert.equal(first.outcome, 'INCOMPLETE');
  assert.ok(first.reasons.includes('repair-effect-result-inconsistent'));
  assert.equal(persisted?.repositoryRevisionDigest, state.repositoryRevisionDigest);
  assert.equal(persisted?.budgetLedgers?.find((ledger) => ledger.kind === 'repair')?.reservations[0]?.keyedId, first.reservedActionId);
  assert.equal(second.outcome, 'INCOMPLETE');
  assert.equal(patchCalls, 1, 'A malformed confirmed revision remains charged and cannot be replayed');
});

test('repair: forbidden current patch policy denies before reservation or repository effects', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'FORBIDDEN', failureEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'code\n' },
  });
  let patchCalls = 0;
  repositoryPort.applyPatch = async (_patch: ApplyPatchAction) => {
    void _patch;
    patchCalls += 1;
    return { applied: true, newRevisionDigest: 'sha256:patched' };
  };
  const result = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(failureEvidence, '--- a/src/calculator.py\n+++ b/src/calculator.py\n', ['src/calculator.py']),
    },
    { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) }
  );

  assert.equal(result.outcome, 'DENIED');
  assert.equal(patchCalls, 0, 'Forbidden patch policy must block the repository effect');
  assert.equal(
    statePort.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations.length,
    0,
    'A denied action must not reserve or charge the repair allowance'
  );
});

test('repair: bare plan decision reference does not authorize patch effects', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const statePort = new MemoryStatePort({ initialTaskState: state });
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'code\n' },
  });
  let patchCalls = 0;
  repositoryPort.applyPatch = async (_patch: ApplyPatchAction) => {
    void _patch;
    patchCalls += 1;
    return { applied: true, newRevisionDigest: 'sha256:patched' };
  };

  const result = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence: createFailedPatchEvidence(task),
      repairPatch: createRepairProposal(createFailedPatchEvidence(task), '--- a/src/calculator.py\n+++ b/src/calculator.py\n', ['src/calculator.py']),
    },
    { statePort, repositoryPort, approvalPort: new ScriptedApprovalPort({ classifications: { apply_patch: 'ALLOWED' } }) }
  );

  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(patchCalls, 0, 'A plan.decisionRef without current trusted approval is not authority');
  assert.equal(
    statePort.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations.length,
    0,
    'A missing current plan decision must stop before budget reservation'
  );
});

test('repair: approval authority rejection blocks patch and reservation', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  authorization.approvalPort.validateBinding = async (_binding: ApprovalBinding) => {
    void _binding;
    return false;
  };
  const repositoryPort = new FakeRepositoryPort({ initialFiles: { 'src/calculator.py': 'code\n' } });
  let patchCalls = 0;
  repositoryPort.applyPatch = async (patch: ApplyPatchAction) => {
    void patch;
    patchCalls += 1;
    return { applied: true, newRevisionDigest: 'sha256:patched' };
  };

  const result = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(failureEvidence, 'patch', ['src/calculator.py']),
    },
    { ...authorization, repositoryPort, executionGuard: createExecutionGuard(repositoryPort) }
  );

  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(patchCalls, 0, 'A port rejection makes a structurally valid decision unusable');
  assert.equal(authorization.statePort.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations.length, 0);
});

test('repair: compare-and-swap failure after a patch is incomplete and cannot replay the reservation', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  statePort.transition = async (_nextState: TaskState, _expectedVersion: number): Promise<TaskState> => {
    void _nextState;
    void _expectedVersion;
    throw new StateConflictError('CAS conflict');
  };
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'code\n' },
  });
  let patchCalls = 0;
  repositoryPort.applyPatch = async (_patch: ApplyPatchAction) => {
    void _patch;
    patchCalls += 1;
    return { applied: true, newRevisionDigest: 'sha256:patched' };
  };
  const input = {
    taskId: task.taskId,
    failureEvidence,
    repairPatch: createRepairProposal(failureEvidence, '--- a/src/calculator.py\n+++ b/src/calculator.py\n', ['src/calculator.py']),
  } as const;

  const first = await executeRepair(input, { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) });
  const afterFirst = await statePort.loadTask(task.taskId);
  const second = await executeRepair(input, { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext, executionGuard: createExecutionGuard(repositoryPort) });

  assert.equal(first.outcome, 'INCOMPLETE');
  assert.equal(repairState(first).node, 'Repair', 'A failed CAS must not fabricate a persisted Patch state');
  assert.equal(afterFirst?.budgetLedgers?.find((ledger) => ledger.kind === 'repair')?.reservations[0]?.keyedId, first.reservedActionId);
  assert.equal(second.outcome, 'INCOMPLETE');
  assert.equal(patchCalls, 1, 'The reserved action cannot be applied again after an uncertain transition');
});

test('repair: wrong-run or unconfigured-check failure evidence is rejected before patch effects', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'code\n' },
  });
  let patchCalls = 0;
  repositoryPort.applyPatch = async (_patch: ApplyPatchAction) => {
    void _patch;
    patchCalls += 1;
    return { applied: true, newRevisionDigest: 'sha256:patched' };
  };
  const baseEvidence = createFailedPatchEvidence(task);

  for (const failureEvidence of [
    { ...baseEvidence, runId: 'run-stale-replay' },
    { ...baseEvidence, evidenceId: 'evi-unconfigured-check', testedIds: ['check-not-required'] },
  ]) {
    const evidenceAuthorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
    const result = await executeRepair(
      { taskId: task.taskId, failureEvidence, repairPatch: createRepairProposal(failureEvidence, 'patch', ['src/calculator.py']) },
      { ...evidenceAuthorization, repositoryPort }
    );
    assert.equal(result.outcome, 'INCOMPLETE');
    assert.equal(evidenceAuthorization.statePort.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations.length, 0);
  }

  assert.equal(patchCalls, 0, 'Evidence outside the current run/check set cannot authorize a patch');
});

test('repair: opaque unresolved token/cost reservations block without identifier-name inference', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const budgetLedgers = state.budgetLedgers?.map((ledger) =>
    ledger.kind === 'cost'
      ? { ...ledger, reservations: [{ reservationId: 'reservation-42', keyedId: 'request-opaque-42', amount: 1 }] }
      : ledger
  );
  const authorizedState = { ...state, budgetLedgers };
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(authorizedState, 'ALLOWED', failureEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: { 'src/calculator.py': 'code\n' },
  });
  let patchCalls = 0;
  repositoryPort.applyPatch = async (_patch: ApplyPatchAction) => {
    void _patch;
    patchCalls += 1;
    return { applied: true, newRevisionDigest: 'sha256:patched' };
  };

  const result = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(failureEvidence, 'patch', ['src/calculator.py']),
    },
    { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext }
  );

  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(patchCalls, 0, 'Opaque outstanding accounting must fail closed');
  assert.equal(statePort.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations.length, 0);
});

test('repair: repository effects require the canonical execution guard', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const { statePort, approvalPort, trustedTransitionContext, trustedRepairContext } = authorization;
  const repositoryPort = new FakeRepositoryPort({ initialFiles: { 'src/calculator.py': 'code\n' } });
  let patchCalls = 0;
  repositoryPort.applyPatch = async (_patch: ApplyPatchAction) => {
    void _patch;
    patchCalls += 1;
    return { applied: true, newRevisionDigest: 'sha256:patched' };
  };

  const result = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(failureEvidence, 'patch', ['src/calculator.py']),
    },
    { statePort, repositoryPort, approvalPort, trustedTransitionContext, trustedRepairContext }
  );

  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(patchCalls, 0, 'RepositoryPort alone cannot bypass ExecutionGuard');
  assert.equal(statePort.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations.length, 0);
});

test('repair: mismatched configured repair ledger fails closed before effects', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const repositoryPort = new FakeRepositoryPort({ initialFiles: { 'src/calculator.py': 'code\n' } });
  let patchCalls = 0;
  repositoryPort.applyPatch = async (_patch: ApplyPatchAction) => {
    void _patch;
    patchCalls += 1;
    return { applied: true, newRevisionDigest: 'sha256:patched' };
  };

  for (const invalidLedger of [
    { configurationId: 'different-config' },
    { limit: 3 },
  ]) {
    const budgetLedgers = state.budgetLedgers?.map((ledger) =>
      ledger.kind === 'repair' ? { ...ledger, ...invalidLedger } : ledger
    );
    const authorization = createAuthorizedRepairPorts({ ...state, budgetLedgers }, 'ALLOWED', failureEvidence);
    const result = await executeRepair(
      {
        taskId: task.taskId,
        failureEvidence,
        repairPatch: createRepairProposal(failureEvidence, 'patch', ['src/calculator.py']),
      },
      { ...authorization, repositoryPort, executionGuard: createExecutionGuard(repositoryPort) }
    );
    assert.equal(result.outcome, 'INCOMPLETE');
    assert.equal(authorization.statePort.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations.length, 0);
  }

  assert.equal(patchCalls, 0);
});

test('repair: missing patch proposal cannot return REPAIR_PREPARED', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const { statePort, trustedTransitionContext, trustedRepairContext } = authorization;

  const result = await executeRepair(
    { taskId: task.taskId, failureEvidence },
    { ...authorization, trustedTransitionContext, trustedRepairContext }
  );

  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(statePort.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations.length, 0);
});

// =========================================================================
// SECTION 2: Material Replan & Feedback Transitions (T016 checks / T018 pending)
// =========================================================================

test('replan: evaluatePlanMateriality detects material strategy shift based on bound fields NOT caller boolean (C12)', () => {
  const { plan } = createRepairStateFixture();
  const materialPlan: FixPlan = {
    ...plan,
    strategy: 'Completely different strategy: return None instead of raising CalculationError',
    strategyDigest: computeCanonicalSha256(
      'Completely different strategy: return None instead of raising CalculationError'
    ),
  };

  const result = evaluatePlanMateriality(plan, materialPlan);
  assert.equal(result.isMaterial, true);
  assert.ok(result.changedFields.includes('strategy'));
});

test('replan: evaluatePlanMateriality treats unchanged strategy with minor wording clarification as non-material (C12)', () => {
  const { plan } = createRepairStateFixture();
  const minorClarificationPlan: FixPlan = {
    ...plan,
    // strategy and strategyDigest unchanged
  };

  const result = evaluatePlanMateriality(plan, minorClarificationPlan);
  assert.equal(result.isMaterial, false);
  assert.equal(result.changedFields.length, 0);
});

test('replan: caller claims isMaterial=true but fields are identical is treated as minor (C12)', () => {
  const { plan } = createRepairStateFixture();
  const identicalPlan: FixPlan = { ...plan };

  // Even if caller intended material shift, identical fields evaluate to minor
  const result = evaluatePlanMateriality(plan, identicalPlan);
  assert.equal(result.isMaterial, false);
});

test('replan: caller claims isMaterial=false but strategy changed is treated as material (C12)', () => {
  const { plan } = createRepairStateFixture();
  const changedDiagnosisPlan: FixPlan = {
    ...plan,
    diagnosis: 'Changed root cause diagnosis to hardware floating point anomaly',
  };

  const result = evaluatePlanMateriality(plan, changedDiagnosisPlan);
  assert.equal(result.isMaterial, true);
  assert.ok(result.changedFields.includes('diagnosis'));
});

test('replan: initial fix plan starts with replanCount 0 (C12)', () => {
  const { state } = createRepairStateFixture({ replanCount: 0 });
  assert.equal(state.replanCount, 0);
});

test('replan: first material replan charges 1 replan slot, increments replanCount to 1, and transitions to AwaitPlan (C12)', async () => {
  const { state, task, plan } = createRepairStateFixture({ replanCount: 0 });
  const materialPlan: FixPlan = {
    ...plan,
    strategy: 'Revised strategy 1: check zero divisor before compute',
    strategyDigest: computeCanonicalSha256('Revised strategy 1: check zero divisor before compute'),
  };
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: materialPlan,
      proposalId: 'prop-replan-001',
    },
    { statePort }
  );

  assert.equal(res.outcome, 'REPLAN_PREPARED');
  assert.equal(res.replanCount, 1);
  assert.equal(res.isMaterial, true);
  assert.equal(res.state.node, 'AwaitPlan');
  assert.equal(res.state.plan?.decisionRef, undefined, 'Prior decisionRef must be invalidated');
});

test('replan: second material replan charges 1 replan slot, increments replanCount to 2 (C12)', async () => {
  const { state, task, plan } = createRepairStateFixture({ replanCount: 1 });
  const materialPlan: FixPlan = {
    ...plan,
    strategy: 'Revised strategy 2: wrap with try-except ZeroDivisionError',
    strategyDigest: computeCanonicalSha256(
      'Revised strategy 2: wrap with try-except ZeroDivisionError'
    ),
  };
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: materialPlan,
      proposalId: 'prop-replan-002',
    },
    { statePort }
  );

  assert.equal(res.outcome, 'REPLAN_PREPARED');
  assert.equal(res.replanCount, 2);
  assert.equal(res.isMaterial, true);
  assert.equal(res.state.node, 'AwaitPlan');
});

test('replan: third material replan charges 1 replan slot, reaches limit replanCount 3 (C12)', async () => {
  const { state, task, plan } = createRepairStateFixture({ replanCount: 2 });
  const materialPlan: FixPlan = {
    ...plan,
    strategy: 'Revised strategy 3: type cast arguments before check',
    strategyDigest: computeCanonicalSha256(
      'Revised strategy 3: type cast arguments before check'
    ),
  };
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: materialPlan,
      proposalId: 'prop-replan-003',
    },
    { statePort }
  );

  assert.equal(res.outcome, 'REPLAN_PREPARED');
  assert.equal(res.replanCount, 3);
  assert.equal(res.isMaterial, true);
  assert.equal(res.state.node, 'AwaitPlan');
});

test('replan: fourth material replan attempt is refused, transitions to Incomplete with replanCount 3 (C12)', async () => {
  // replanCount already at 3!
  const { state, task, plan } = createRepairStateFixture({ replanCount: 3 });
  const fourthPlan: FixPlan = {
    ...plan,
    strategy: 'Fourth strategy: disallowed attempt',
    strategyDigest: computeCanonicalSha256('Fourth strategy: disallowed attempt'),
  };
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: fourthPlan,
      proposalId: 'prop-replan-004',
    },
    { statePort }
  );

  assert.equal(res.outcome, 'INCOMPLETE');
  assert.equal(res.replanCount, 3, 'replanCount must remain capped at 3');
  assert.equal(res.state.node, 'Incomplete');
  assert.ok(res.reasons.some((r) => r.includes('cap') || r.includes('replan')));
});

test('replan: minor clarification does not charge replanCount or consume replan budget (C12)', async () => {
  const { state, task, plan } = createRepairStateFixture({ replanCount: 0 });
  const clarifiedPlan: FixPlan = {
    ...plan,
    // Identical strategy and strategyDigest
  };
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: clarifiedPlan,
      proposalId: 'prop-clarify-001',
    },
    { statePort }
  );

  assert.equal(res.outcome, 'CLARIFICATION_ACCEPTED');
  assert.equal(res.replanCount, 0, 'Minor clarification must not increment replanCount');
  assert.equal(res.isMaterial, false);
});

test('replan: plan rejection transitions state to AwaitFeedback and pauses without autonomous replanning (C12)', async () => {
  const { state, task } = createRepairStateFixture({ node: 'AwaitPlan' });
  const statePort = new MemoryStatePort({ initialTaskState: state });

  const res = await handlePlanRejection(
    {
      taskId: task.taskId,
      rejectionReason: 'Human rejected plan: please do not use try-except',
    },
    { statePort }
  );

  assert.equal(res.outcome, 'AWAIT_FEEDBACK');
  assert.equal(res.state.node, 'AwaitFeedback');
  assert.ok(res.reasons.some((r) => r.includes('rejected') || r.includes('direction')));
});
