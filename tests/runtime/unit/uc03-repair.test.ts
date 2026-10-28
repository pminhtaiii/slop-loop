/**
 * UC-03 Verified Code Repair - Unit Tests for Repair & Replan Transitions
 *
 * Owned path: tests/runtime/unit/uc03-repair.test.ts
 * Feature: specs/001-verified-code-repair
 * Tasks: T016 (repair/replan API & tests), T017 (bounded repair implementation),
 *        T018 (material replan & feedback transitions)
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
  type StatePort,
  type ExecutionGuard,
  type NormalizedAction,
  type FixPlan,
  type CheckDefinition,
  type VerificationResult,
  type ReviewResult,
  type BudgetLedger,
  type StatePortV02,
  type RepositoryAdmissionContextV02,
  type ProviderUsage,
  type RepositoryPort,
  type RepositoryPatchResultV02,
  type RepositoryActionOutcomeReceiptV02,
  type ContextualApprovalVerifierV02,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  executeRepair,
  executeReplan,
  handlePlanRejection,
  evaluatePlanMateriality,
  createRepairActionId,
  type RepairResult,
  type RepairPatchProposal,
  type TrustedRepairContext,
} from '../../../src/uc03/repair.ts';
import { executeVerificationChecks } from '../../../src/uc03/verification.ts';
import {
  createFixtureBugTask,
  createFixtureTaskState,
  createFixtureCheckDefinition,
} from '../support/uc03/port-fixtures.ts';
import { MemoryStatePort, MemoryStatePortV02, StateConflictError } from '../support/uc03/memory-state.ts';
import {
  createTestRepositoryAdmissionContextV02,
  createTestAdmissionTaskStateV02,
  createTestAdmissionTransitionContextsV02,
  createTestExecutorIdentityV02,
  createTestObservedReconciliationReceiptV02,
  createTestReconciliationValidationContextV02,
} from '../support/uc03/state-fixtures.ts';
import {
  createExecutionGuardV02,
  type ExecutionGuardStatePortV02,
} from '../../../src/foundation/execution-guard.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { ControlledRepositoryTools, type TrustedFilesystemPort } from '../../../src/foundation/repository-tools.ts';
import { DockerWorkspaceManager } from '../../../src/foundation/docker-workspace.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';

function asLegacyV01RepositoryPort(repositoryPort: FakeRepositoryPort): FakeRepositoryPort {
  Object.defineProperty(repositoryPort, 'executionGuardApiVersion', { value: undefined });
  return repositoryPort;
}

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

function createReplanReservation(state: TaskState, proposalId: string) {
  return {
    proposalId,
    taskId: state.taskId,
    configurationId: state.taskContext?.configId ?? '',
    priorCount: state.replanCount,
    nextCount: state.replanCount + 1,
    reservationId: `res-task-replan-${proposalId}`,
  };
}

function createReplanTransitionContext(state: TaskState, proposalId: string): NonNullable<StateTransitionOptions['trusted']> {
  return { replanReservation: createReplanReservation(state, proposalId) };
}

function isStatePortV02(port: unknown): port is StatePortV02 {
  if (typeof port !== 'object' || port === null || Array.isArray(port)) return false;
  const marker = Object.getOwnPropertyDescriptor(port, 'executionGuardApiVersion');
  return marker !== undefined && 'value' in marker && marker.value === '0.2.0';
}

function forwardPublicStatePort(statePort: MemoryStatePortV02): StatePort & ExecutionGuardStatePortV02;
function forwardPublicStatePort(statePort: StatePortV02): ExecutionGuardStatePortV02;
function forwardPublicStatePort(statePort: StatePort): StatePort;
function forwardPublicStatePort(
  statePort: StatePort | StatePortV02
): StatePort | ExecutionGuardStatePortV02 {
  if (isStatePortV02(statePort)) {
    const v02Port = statePort;
    const underlying = statePort instanceof MemoryStatePortV02 ? statePort.getUnderlying() : undefined;
    const forwardedV02: ExecutionGuardStatePortV02 = {
      provenance: v02Port.provenance,
      executionGuardApiVersion: '0.2.0',
      loadTask: (taskId) => v02Port.loadTask(taskId),
      transition: (state, expectedVersion) => v02Port.transition(state, expectedVersion),
      claim: (context) => v02Port.claim(context),
      beginAttempt: (claimId, executor) => v02Port.beginAttempt(claimId, executor),
      recordOutcome: (receipt) => v02Port.recordOutcome(receipt),
      reconcileObservedOutcome: (receipt) => v02Port.reconcileObservedOutcome(receipt),
      reconcileUncertain: (receipt) => v02Port.reconcileUncertain(receipt),
      closeUnattemptedClaim: (receipt) => v02Port.closeUnattemptedClaim(receipt),
      checkpoint: (state) => v02Port.checkpoint(state),
      recover: (taskId) => v02Port.recover(taskId),
    };
    if (underlying) {
      return Object.assign(forwardedV02, {
        reserve: (scope: 'task' | 'run', kind: string, amount: number, actionId: string) =>
          underlying.reserve(scope, kind, amount, actionId),
        reserveMany: (
          reservations: readonly {
            readonly scope: 'task' | 'run';
            readonly kind: string;
            readonly amount: number;
          }[],
          requestId: string,
          transactionRef?: string
        ) => underlying.reserveMany(reservations, requestId, transactionRef),
        settle: (actionId: string, usage: ProviderUsage) => underlying.settle(actionId, usage),
      });
    }
    return forwardedV02;
  }
  return {
    provenance: statePort.provenance,
    loadTask: (taskId) => statePort.loadTask(taskId),
    transition: (state, expectedVersion) => statePort.transition(state, expectedVersion),
    reserve: (scope, kind, amount, actionId) => statePort.reserve(scope, kind, amount, actionId),
    reserveMany: (reservations, requestId, transactionRef) =>
      statePort.reserveMany(reservations, requestId, transactionRef),
    settle: (actionId, usage) => statePort.settle(actionId, usage),
    reconcileUncertain: (requestId, reconciliation) =>
      statePort.reconcileUncertain(requestId, reconciliation),
    checkpoint: (state) => statePort.checkpoint(state),
    recover: (taskId) => statePort.recover(taskId),
  };
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

function createRejectedPlanApproval(state: TaskState): {
  readonly statePort: MemoryStatePort;
  readonly approvalPort: ScriptedApprovalPort;
  readonly decisionId: string;
} {
  const authorization = createAuthorizedRepairPorts(state);
  const approvalContext = authorization.trustedTransitionContext.approval;
  if (!approvalContext) throw new Error('Plan rejection fixture requires bound approval context');
  const approved = approvalContext.binding as ApprovalBinding;
  const rejected: ApprovalBinding = { ...approved, status: 'rejected', reason: 'human-rejected-plan' };
  return {
    statePort: authorization.statePort,
    approvalPort: new ScriptedApprovalPort({ decisions: [rejected], currentContext: approvalContext.freshness }),
    decisionId: rejected.decisionId,
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
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    // Assert that repair reservation already exists in statePort BEFORE patch is applied!
    const ledgers = statePort.getLedgers();
    const repairLedger = ledgers.find((l) => l.scope === 'task' && l.kind === 'repair');
    assert.ok(repairLedger, 'Repair ledger must exist');
    assert.ok(
      repairLedger.reservations.length > 0,
      'Repair reservation must exist in ledger BEFORE applyPatch is called'
    );
    patchApplied = true;
    return (context ? originalApplyPatch(patch, context) : originalApplyPatch(patch));
  }
  repositoryPort.applyPatch = wrappedApplyPatch;

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
  const wrappedOriginal = repositoryPort.applyPatch.bind(repositoryPort);
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(_patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    void _patch;
    patchApplied = true;
    return context ? wrappedOriginal(_patch, context) : wrappedOriginal(_patch);
  }
  repositoryPort.applyPatch = wrappedApplyPatch;

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

test('repair: protects test paths at any depth and admits ordinary tests_helpers source before guarded effects', async () => {
  const protectedPaths = [
    'package/tests/support.py',
    'src/test/support.txt',
    'test_root.py',
    'nested/Test_Fixture.PY',
    'nested/check_test.py',
    'pkg/conftest.py',
    'Project/TeStS/support.txt',
    'Pkg\\test\\helper.py',
  ];
  const observations: {
    readonly path: string;
    readonly outcome: string;
    readonly reserves: number;
    readonly guardCalls: number;
    readonly patchCalls: number;
  }[] = [];

  for (const path of protectedPaths) {
    const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
    const failureEvidence = createFailedPatchEvidence(task);
    const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
    const repositoryPort = new FakeRepositoryPort();
    const applyPatch = repositoryPort.applyPatch.bind(repositoryPort);
    let patchCalls = 0;
    function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
    function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
    async function wrappedApplyPatch(patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
      patchCalls += 1;
      return (context ? applyPatch(patch, context) : applyPatch(patch));
    }
    repositoryPort.applyPatch = wrappedApplyPatch;
    const forwarded = forwardPublicStatePort(authorization.statePort);
    let reserves = 0;
    const statePort: StatePort = {
      ...forwarded,
      reserve: async (scope, kind, amount, actionId) => {
        reserves += 1;
        return forwarded.reserve(scope, kind, amount, actionId);
      },
    };
    let guardCalls = 0;
    const baseGuard = createExecutionGuard(repositoryPort);
    const executionGuard: ExecutionGuard = {
      provenance: 'mock',
      validateAndExecute: async (action, state) => {
        guardCalls += 1;
        return baseGuard.validateAndExecute(action, state);
      },
    };

    const result = await executeRepair(
      {
        taskId: task.taskId,
        failureEvidence,
        repairPatch: createRepairProposal(failureEvidence, 'path-protection-probe', [path]),
      },
      {
        statePort,
        repositoryPort,
        approvalPort: authorization.approvalPort,
        trustedTransitionContext: authorization.trustedTransitionContext,
        trustedRepairContext: authorization.trustedRepairContext,
        executionGuard,
      }
    );
    observations.push({ path, outcome: result.outcome, reserves, guardCalls, patchCalls });
  }

  assert.deepEqual(
    observations,
    protectedPaths.map((path) => ({ path, outcome: 'DENIED', reserves: 0, guardCalls: 0, patchCalls: 0 }))
  );

  const allowedPath = 'src/tests_helpers/helper.py';
  const { state: baseState, task } = createRepairStateFixture({ repairConsumed: 0 });
  assert.ok(baseState.plan);
  const state: TaskState = {
    ...baseState,
    plan: { ...baseState.plan, scopedChanges: [allowedPath] },
  };
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const repositoryPort = new FakeRepositoryPort({ initialFiles: { [allowedPath]: 'helper\\n' } });
  const forwarded = forwardPublicStatePort(authorization.statePort);
  let reserves = 0;
  const statePort: StatePort = {
    ...forwarded,
    reserve: async (scope, kind, amount, actionId) => {
      reserves += 1;
      return forwarded.reserve(scope, kind, amount, actionId);
    },
  };
  let guardCalls = 0;
  const baseGuard = createExecutionGuard(repositoryPort);
  const executionGuard: ExecutionGuard = {
    provenance: 'mock',
    validateAndExecute: async (action, state) => {
      guardCalls += 1;
      return baseGuard.validateAndExecute(action, state);
    },
  };

  const allowed = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(failureEvidence, 'ordinary source patch', [allowedPath]),
    },
    {
      statePort,
      repositoryPort,
      approvalPort: authorization.approvalPort,
      trustedTransitionContext: authorization.trustedTransitionContext,
      trustedRepairContext: authorization.trustedRepairContext,
      executionGuard,
    }
  );

  assert.equal(allowed.outcome, 'REPAIR_PREPARED');
  assert.equal(reserves, 1);
  assert.equal(guardCalls, 1);
  assert.equal(repositoryPort.patches.length, 1);
});

test('repair: noncanonical patch target is rejected before guarded effects', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const repositoryPort = new FakeRepositoryPort({ initialFiles: { 'src/calculator.py': 'code\n' } });
  let patchCalls = 0;
  const wrappedOriginal = repositoryPort.applyPatch.bind(repositoryPort);
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    void patch;
    patchCalls += 1;
    return context ? wrappedOriginal(patch, context) : wrappedOriginal(patch);
  }
  repositoryPort.applyPatch = wrappedApplyPatch;

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
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    const result = await (context ? applyPatch(patch, context) : applyPatch(patch));
    patchCalls++;
    if (result.applied) confirmedRevision = result.newRevisionDigest;
    return result;
  }
  repositoryPort.applyPatch = wrappedApplyPatch;
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
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    const result = await (context ? applyPatch(patch, context) : applyPatch(patch));
    patchCalls++;
    return { ...result, newRevisionDigest: 'sha256:post-patch-current' };
  }
  repositoryPort.applyPatch = wrappedApplyPatch;
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
  const wrappedOriginal = repositoryPort.applyPatch.bind(repositoryPort);
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(_patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    void _patch;
    patchCalls += 1;
    return context ? wrappedOriginal(_patch, context) : wrappedOriginal(_patch);
  }
  repositoryPort.applyPatch = wrappedApplyPatch;
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
  const wrappedOriginal = repositoryPort.applyPatch.bind(repositoryPort);
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(_patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    void _patch;
    patchCalls += 1;
    return context ? wrappedOriginal(_patch, context) : wrappedOriginal(_patch);
  }
  repositoryPort.applyPatch = wrappedApplyPatch;

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
  const wrappedOriginal = repositoryPort.applyPatch.bind(repositoryPort);
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    void patch;
    patchCalls += 1;
    return context ? wrappedOriginal(patch, context) : wrappedOriginal(patch);
  }
  repositoryPort.applyPatch = wrappedApplyPatch;

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
  const wrappedOriginal = repositoryPort.applyPatch.bind(repositoryPort);
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(_patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    void _patch;
    patchCalls += 1;
    return context ? wrappedOriginal(_patch, context) : wrappedOriginal(_patch);
  }
  repositoryPort.applyPatch = wrappedApplyPatch;
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
  const wrappedOriginal = repositoryPort.applyPatch.bind(repositoryPort);
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(_patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    void _patch;
    patchCalls += 1;
    return context ? wrappedOriginal(_patch, context) : wrappedOriginal(_patch);
  }
  repositoryPort.applyPatch = wrappedApplyPatch;
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
  const wrappedOriginal = repositoryPort.applyPatch.bind(repositoryPort);
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(_patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    void _patch;
    patchCalls += 1;
    return context ? wrappedOriginal(_patch, context) : wrappedOriginal(_patch);
  }
  repositoryPort.applyPatch = wrappedApplyPatch;

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
  const wrappedOriginal = repositoryPort.applyPatch.bind(repositoryPort);
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(_patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    void _patch;
    patchCalls += 1;
    return context ? wrappedOriginal(_patch, context) : wrappedOriginal(_patch);
  }
  repositoryPort.applyPatch = wrappedApplyPatch;

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
  const wrappedOriginal = repositoryPort.applyPatch.bind(repositoryPort);
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(_patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    void _patch;
    patchCalls += 1;
    return context ? wrappedOriginal(_patch, context) : wrappedOriginal(_patch);
  }
  repositoryPort.applyPatch = wrappedApplyPatch;

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

test('replan: changed scoped edits or suspected causes are material bound fields', () => {
  const { plan } = createRepairStateFixture();
  assert.equal(evaluatePlanMateriality(plan, { ...plan, scopedChanges: ['src/other.py'] }).isMaterial, true);
  assert.equal(evaluatePlanMateriality(plan, { ...plan, suspectedCauseLocations: ['src/other.py:4'] }).isMaterial, true);
});

test('replan: minor evidence binding changes clear stale authority without charging', async () => {
  const { state, task, plan } = createRepairStateFixture({ node: 'Investigate' });
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  let reserves = 0;
  const statePort: StatePort = {
    ...forwardPublicStatePort(memoryState),
    reserve: async (...args) => {
      reserves += 1;
      return memoryState.reserve(...args);
    },
  };

  const result = await executeReplan(
    { taskId: task.taskId, proposalId: 'minor-evidence-update', candidatePlan: { ...plan, evidenceRefs: ['fresh-diagnosis-evidence'] } },
    { statePort }
  );

  assert.equal(result.outcome, 'CLARIFICATION_ACCEPTED');
  assert.equal(result.state.node, 'AwaitPlan');
  assert.equal(result.state.plan?.decisionRef, undefined);
  assert.equal(result.state.activeDecisionId, undefined);
  assert.equal(result.state.latestReviewRef, undefined);
  assert.deepEqual(result.state.reviewRefs, []);
  assert.equal(reserves, 0);
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
  const trustedTransitionContext = createReplanTransitionContext(state, 'prop-replan-001');
  const statePort = new MemoryStatePort({ initialTaskState: state, transitionContexts: { [state.stateVersion + 1]: trustedTransitionContext } });

  const res = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: materialPlan,
      proposalId: 'prop-replan-001',
    },
    { statePort, trustedTransitionContext }
  );

  assert.equal(res.outcome, 'REPLAN_PREPARED');
  assert.equal(res.replanCount, 1);
  assert.equal(res.isMaterial, true);
  assert.equal(res.state.node, 'AwaitPlan');
  assert.equal(res.state.plan?.decisionRef, undefined, 'Prior decisionRef must be invalidated');
});

test('replan: material change from Investigate returns the persisted charged reservation', async () => {
  const { state, task, plan } = createRepairStateFixture({ node: 'Investigate' });
  const proposalId = 'investigate-material-001';
  const trustedTransitionContext = createReplanTransitionContext(state, proposalId);
  const memoryState = new MemoryStatePort({
    initialTaskState: state,
    transitionContexts: { [state.stateVersion + 1]: trustedTransitionContext },
  });
  const statePort = forwardPublicStatePort(memoryState);
  const materialPlan: FixPlan = {
    ...plan,
    strategy: 'Investigate found a different bounded repair strategy',
    strategyDigest: computeCanonicalSha256('Investigate found a different bounded repair strategy'),
  };

  const result = await executeReplan(
    { taskId: task.taskId, candidatePlan: materialPlan, proposalId },
    { statePort, trustedTransitionContext }
  );
  const persisted = await statePort.loadTask(task.taskId);

  assert.equal(result.outcome, 'REPLAN_PREPARED');
  assert.equal(result.replanCount, 1);
  assert.equal(result.state.node, 'AwaitPlan');
  assert.equal(result.state.replanCount, 1);
  assert.equal(result.state.plan?.decisionRef, undefined);
  assert.equal(result.state.activeDecisionId, undefined);
  assert.ok(persisted);
  assert.equal(persisted.node, 'AwaitPlan');
  assert.equal(persisted.replanCount, 1);
  assert.equal(persisted.plan?.decisionRef, undefined);
  assert.equal(persisted.activeDecisionId, undefined);

  const chargedReservation = {
    reservationId: createReplanReservation(state, proposalId).reservationId,
    keyedId: proposalId,
    amount: 1,
  };
  for (const chargedState of [result.state, persisted]) {
    const ledger = chargedState.budgetLedgers?.find((item) => item.kind === 'replan');
    assert.ok(ledger);
    assert.equal(ledger.consumed, 0);
    assert.deepEqual(ledger.reservations, [chargedReservation]);
  }
  const persistedLedger = persisted.budgetLedgers?.find((item) => item.kind === 'replan');
  assert.deepEqual(result.state.budgetLedgers?.find((item) => item.kind === 'replan'), persistedLedger);

  const replayPlan: FixPlan = {
    ...materialPlan,
    strategy: 'Material replay of the reserved Investigate proposal',
    strategyDigest: computeCanonicalSha256('Material replay of the reserved Investigate proposal'),
  };
  const replay = await executeReplan(
    { taskId: task.taskId, candidatePlan: replayPlan, proposalId },
    { statePort, trustedTransitionContext }
  );
  const nextProposalId = 'investigate-material-002';
  const nextPlan: FixPlan = {
    ...materialPlan,
    strategy: 'A distinct strategy while the revised plan awaits approval',
    strategyDigest: computeCanonicalSha256('A distinct strategy while the revised plan awaits approval'),
  };
  const next = await executeReplan(
    { taskId: task.taskId, candidatePlan: nextPlan, proposalId: nextProposalId },
    { statePort, trustedTransitionContext: createReplanTransitionContext(persisted, nextProposalId) }
  );
  const afterAttempts = await statePort.loadTask(task.taskId);

  assert.equal(replay.outcome, 'DENIED');
  assert.equal(next.outcome, 'DENIED');
  assert.ok(afterAttempts);
  assert.equal(afterAttempts.replanCount, 1);
  assert.deepEqual(afterAttempts.budgetLedgers?.find((item) => item.kind === 'replan'), persistedLedger);
});

test('replan: failed canonical admission returns the reloaded charged reservation', async () => {
  const { state, task, plan } = createRepairStateFixture({ node: 'Investigate' });
  const proposalId = 'investigate-admission-failure-001';
  const trustedTransitionContext = {
    replanReservation: {
      ...createReplanReservation(state, proposalId),
      reservationId: 'different-reservation-receipt',
    },
  } satisfies NonNullable<StateTransitionOptions['trusted']>;
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  let transitions = 0;
  const statePort: StatePort = {
    ...forwardPublicStatePort(memoryState),
    transition: (next, expectedVersion) => {
      transitions += 1;
      return memoryState.transition(next, expectedVersion);
    },
  };
  const candidatePlan: FixPlan = {
    ...plan,
    strategy: 'Investigate material plan with rejected reservation admission',
    strategyDigest: computeCanonicalSha256('Investigate material plan with rejected reservation admission'),
  };

  const result = await executeReplan(
    { taskId: task.taskId, candidatePlan, proposalId },
    { statePort, trustedTransitionContext }
  );
  const persisted = await statePort.loadTask(task.taskId);

  assert.equal(result.outcome, 'INCOMPLETE');
  assert.ok(result.reasons.includes('replan-transition-to-await-plan-prevalidation-failed'));
  assert.equal(transitions, 0);
  assert.ok(persisted);
  assert.equal(result.state.replanCount, 0);
  assert.equal(persisted.replanCount, 0);
  const returnedLedger = result.state.budgetLedgers?.find((item) => item.kind === 'replan');
  const persistedLedger = persisted.budgetLedgers?.find((item) => item.kind === 'replan');
  assert.ok(returnedLedger);
  assert.equal(returnedLedger.reservations.length, 1);
  assert.equal(returnedLedger.reservations[0]?.keyedId, proposalId);
  assert.deepEqual(returnedLedger, persistedLedger);
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
  const trustedTransitionContext = createReplanTransitionContext(state, 'prop-replan-002');
  const statePort = new MemoryStatePort({ initialTaskState: state, transitionContexts: { [state.stateVersion + 1]: trustedTransitionContext } });

  const res = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: materialPlan,
      proposalId: 'prop-replan-002',
    },
    { statePort, trustedTransitionContext }
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
  const trustedTransitionContext = createReplanTransitionContext(state, 'prop-replan-003');
  const statePort = new MemoryStatePort({ initialTaskState: state, transitionContexts: { [state.stateVersion + 1]: trustedTransitionContext } });

  const res = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: materialPlan,
      proposalId: 'prop-replan-003',
    },
    { statePort, trustedTransitionContext }
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
  const authority = createRejectedPlanApproval(state);

  const res = await handlePlanRejection(
    {
      taskId: task.taskId,
      rejectionReason: 'Human rejected plan: please do not use try-except',
      decisionId: authority.decisionId,
    },
    { statePort: authority.statePort, approvalPort: authority.approvalPort }
  );

  assert.equal(res.outcome, 'AWAIT_FEEDBACK');
  assert.equal(res.state.node, 'AwaitFeedback');
  assert.ok(res.reasons.some((r) => r.includes('rejected') || r.includes('direction')));
});

test('replan: task-scoped replanCount persists across simulated new runs without reset (C04, C12)', async () => {
  const { state, task, plan } = createRepairStateFixture({ replanCount: 2 });
  assert.equal(state.replanCount, 2);
  const materialPlan3: FixPlan = {
    ...plan,
    strategy: 'Simulated new run material strategy 3',
    strategyDigest: computeCanonicalSha256('Simulated new run material strategy 3'),
  };
  const trustedTransitionContext = createReplanTransitionContext(state, 'prop-replan-run2-003');
  const statePort = new MemoryStatePort({ initialTaskState: state, transitionContexts: { [state.stateVersion + 1]: trustedTransitionContext } });
  const res3 = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: materialPlan3,
      proposalId: 'prop-replan-run2-003',
    },
    { statePort, trustedTransitionContext }
  );
  assert.equal(res3.outcome, 'REPLAN_PREPARED');
  assert.equal(res3.replanCount, 3);
  assert.equal(res3.state.node, 'AwaitPlan');

  const materialPlan4: FixPlan = {
    ...plan,
    strategy: 'Simulated new run material strategy 4',
    strategyDigest: computeCanonicalSha256('Simulated new run material strategy 4'),
  };
  const res4 = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: materialPlan4,
      proposalId: 'prop-replan-run2-004',
    },
    { statePort }
  );
  assert.equal(res4.outcome, 'INCOMPLETE');
  assert.equal(res4.replanCount, 3);
  assert.equal(res4.state.node, 'Incomplete');
  assert.ok(res4.reasons.some((r) => r.includes('cap') || r.includes('replan')));
});

test('replan: idempotent replay of an already-reserved proposal does not recharge replan budget', async () => {
  const { state, task, plan } = createRepairStateFixture({ replanCount: 1 });
  const existingReservation = {
    reservationId: 'res-task-replan-prop-replan-replay',
    keyedId: 'prop-replan-replay',
    amount: 1,
  };
  const stateWithExistingReservation: TaskState = {
    ...state,
    budgetLedgers: state.budgetLedgers?.map((l) =>
      l.scope === 'task' && l.kind === 'replan'
        ? { ...l, consumed: 0, reservations: [...l.reservations, existingReservation], version: l.version + 1 }
        : l
    ),
  };
  const statePort = new MemoryStatePort({ initialTaskState: stateWithExistingReservation });
  const materialPlan: FixPlan = {
    ...plan,
    strategy: 'Replayed proposal strategy',
    strategyDigest: computeCanonicalSha256('Replayed proposal strategy'),
  };
  const res = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: materialPlan,
      proposalId: 'prop-replan-replay',
    },
    { statePort }
  );
  assert.equal(res.outcome, 'DENIED');
  assert.equal(res.replanCount, 1);
  assert.ok(res.reasons.some((r) => r.includes('replay') || r.includes('denied')));
});

test('replan: uncertain token or cost accounting reservations fail closed before replan effects', async () => {
  const { state, task, plan } = createRepairStateFixture({ withUncertainReservation: true });
  const materialPlan: FixPlan = {
    ...plan,
    strategy: 'Strategy under uncertain accounting',
    strategyDigest: computeCanonicalSha256('Strategy under uncertain accounting'),
  };
  const statePort = new MemoryStatePort({ initialTaskState: state });
  const res = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: materialPlan,
      proposalId: 'prop-replan-uncertain',
    },
    { statePort }
  );
  assert.equal(res.outcome, 'INCOMPLETE');
  assert.ok(res.reasons.some((r) => r.includes('uncertain')));
});

test('replan: missing replan budget ledger fails closed before replan effects', async () => {
  const { state, task, plan } = createRepairStateFixture();
  const stateWithoutReplanLedger: TaskState = {
    ...state,
    budgetLedgers: state.budgetLedgers?.filter((l) => l.kind !== 'replan'),
  };
  const statePort = new MemoryStatePort({ initialTaskState: stateWithoutReplanLedger });
  const materialPlan: FixPlan = {
    ...plan,
    strategy: 'Strategy without replan ledger',
    strategyDigest: computeCanonicalSha256('Strategy without replan ledger'),
  };
  const res = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan: materialPlan,
      proposalId: 'prop-replan-no-ledger',
    },
    { statePort }
  );
  assert.equal(res.outcome, 'INCOMPLETE');
  assert.ok(res.reasons.some((r) => r.includes('replan') || r.includes('ledger')));
});

test('replan: rejection in AwaitFeedback requires explicit direction; feedback text alone provides no repair authority', async () => {
  const { state, task } = createRepairStateFixture({ node: 'AwaitPlan' });
  const authority = createRejectedPlanApproval(state);
  const rejectionRes = await handlePlanRejection(
    {
      taskId: task.taskId,
      rejectionReason: 'Human rejected: do not use try-except; use validation instead',
      decisionId: authority.decisionId,
    },
    { statePort: authority.statePort, approvalPort: authority.approvalPort }
  );
  assert.equal(rejectionRes.outcome, 'AWAIT_FEEDBACK');
  assert.equal(rejectionRes.state.node, 'AwaitFeedback');
  assert.equal(rejectionRes.state.activeDecisionId, undefined, 'Rejection must invalidate activeDecisionId');
});

test('replan: three sequential revisions persist through a public StatePort wrapper and the fourth stops', async () => {
  const { state: initial, task } = createRepairStateFixture({ replanCount: 0 });
  let current = initial;

  for (const count of [0, 1, 2]) {
    const currentPlan = current.plan;
    assert.ok(currentPlan);
    const resumed: TaskState = count === 0
      ? current
      : {
          ...current,
          stateVersion: current.stateVersion + 1,
          node: 'Repair',
          plan: { ...currentPlan, decisionRef: `dec-approved-${count}` },
          activeDecisionId: `dec-approved-${count}`,
          latestReviewRef: `review-${count}`,
          reviewRefs: [`review-${count}`],
        };
    const proposalId = `public-port-replan-${count + 1}`;
    const reservation = createReplanReservation(resumed, proposalId);
    const trustedTransitionContext = { replanReservation: reservation };
    const statePort = new MemoryStatePort({
      initialTaskState: resumed,
      transitionContexts: { [resumed.stateVersion + 1]: trustedTransitionContext },
    });
    const candidatePlan: FixPlan = {
      ...currentPlan,
      strategy: `Public-port revised strategy ${count + 1}`,
      strategyDigest: computeCanonicalSha256(`Public-port revised strategy ${count + 1}`),
    };

    const result = await executeReplan(
      { taskId: task.taskId, candidatePlan, proposalId },
      { statePort: forwardPublicStatePort(statePort), trustedTransitionContext }
    );

    assert.equal(result.outcome, 'REPLAN_PREPARED');
    assert.equal(result.replanCount, count + 1);
    assert.equal(result.state.replanCount, count + 1);
    assert.equal(result.state.node, 'AwaitPlan');
    assert.equal(result.state.plan?.decisionRef, undefined);
    assert.equal(result.state.activeDecisionId, undefined);
    assert.equal(result.state.latestReviewRef, undefined);
    assert.deepEqual(result.state.reviewRefs, []);
    assert.equal(statePort.getLedgers().find((ledger) => ledger.kind === 'replan')?.reservations.length, count + 1);
    current = result.state;
  }

  const finalPort = new MemoryStatePort({ initialTaskState: current });
  const finalPlan = current.plan;
  assert.ok(finalPlan);
  const fourthPlan: FixPlan = {
    ...finalPlan,
    strategy: 'Fourth public-port strategy must stop',
    strategyDigest: computeCanonicalSha256('Fourth public-port strategy must stop'),
  };
  const fourth = await executeReplan(
    { taskId: task.taskId, candidatePlan: fourthPlan, proposalId: 'public-port-replan-4' },
    { statePort: forwardPublicStatePort(finalPort) }
  );

  assert.equal(fourth.outcome, 'INCOMPLETE');
  assert.equal(fourth.replanCount, 3);
  assert.equal(fourth.state.node, 'Incomplete');
  assert.equal(finalPort.getLedgers().find((ledger) => ledger.kind === 'replan')?.reservations.length, 3);
});

test('replan: caller rejection text without a stored rejected decision cannot pause a plan', async () => {
  const { state, task } = createRepairStateFixture({ node: 'AwaitPlan' });
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  let transitions = 0;
  const statePort: StatePort = {
    ...forwardPublicStatePort(memoryState),
    transition: (next, expectedVersion) => {
      transitions += 1;
      return memoryState.transition(next, expectedVersion);
    },
  };

  const result = await handlePlanRejection(
    { taskId: task.taskId, decisionId: 'forged-decision', rejectionReason: 'I reject this plan; use a different strategy.' },
    { statePort }
  );

  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(result.state.node, 'AwaitPlan');
  assert.equal(transitions, 0);
  assert.equal((await memoryState.loadTask(task.taskId))?.stateVersion, state.stateVersion);
});

test('replan: feedback text without trusted direction leaves AwaitFeedback unchanged and uncharged', async () => {
  const { state: initial, task, plan } = createRepairStateFixture({ node: 'AwaitFeedback', replanCount: 0 });
  const state: TaskState = { ...initial, activeDecisionId: undefined };
  const proposalId = 'feedback-only-replan';
  const trustedTransitionContext = createReplanTransitionContext(state, proposalId);
  const memoryState = new MemoryStatePort({
    initialTaskState: state,
    transitionContexts: { [state.stateVersion + 1]: trustedTransitionContext },
  });
  let transitions = 0;
  const statePort: StatePort = {
    ...forwardPublicStatePort(memoryState),
    transition: (next, expectedVersion) => {
      transitions += 1;
      return memoryState.transition(next, expectedVersion);
    },
  };
  const candidatePlan: FixPlan = {
    ...plan,
    strategy: 'Feedback text alone must not change strategy',
    strategyDigest: computeCanonicalSha256('Feedback text alone must not change strategy'),
  };

  const result = await executeReplan(
    {
      taskId: task.taskId,
      candidatePlan,
      proposalId,
      reason: 'Human feedback says to replace the plan with this strategy.',
    },
    { statePort, trustedTransitionContext }
  );

  assert.equal(result.outcome, 'AWAIT_FEEDBACK');
  assert.equal(result.state.node, 'AwaitFeedback');
  assert.equal(result.replanCount, 0);
  assert.equal(transitions, 0);
  assert.equal(memoryState.getLedgers().find((ledger) => ledger.kind === 'replan')?.reservations.length, 0);
  assert.equal((await memoryState.loadTask(task.taskId))?.stateVersion, state.stateVersion);
});

test('replan: explicit bound revise direction prepares a new plan but never approves it', async () => {
  const { state: initial, task, plan } = createRepairStateFixture({ node: 'AwaitFeedback' });
  const rejectedDecisionId = plan.decisionRef;
  assert.ok(rejectedDecisionId);
  const state: TaskState = { ...initial, stateVersion: initial.stateVersion + 1, activeDecisionId: undefined };
  const proposalId = 'directed-replan';
  const trustedTransitionContext = createReplanTransitionContext(state, proposalId);
  const statePort = new MemoryStatePort({
    initialTaskState: state,
    transitionContexts: { [state.stateVersion + 1]: trustedTransitionContext },
  });
  const candidatePlan: FixPlan = {
    ...plan,
    strategy: 'Human directed revised strategy',
    strategyDigest: computeCanonicalSha256('Human directed revised strategy'),
  };

  const result = await executeReplan(
    { taskId: task.taskId, candidatePlan, proposalId },
    {
      statePort,
      trustedTransitionContext,
      trustedDirection: {
        directive: 'revise',
        taskId: state.taskId,
        workspaceId: state.workspaceId,
        repositoryRevisionDigest: state.repositoryRevisionDigest,
        stateVersion: state.stateVersion,
        planVersion: state.planVersion,
        rejectedDecisionId,
        strategyDigest: plan.strategyDigest,
      },
    }
  );

  assert.equal(result.outcome, 'REPLAN_PREPARED');
  assert.equal(result.state.node, 'AwaitPlan');
  assert.equal(result.replanCount, 1);
  assert.equal(result.state.plan?.decisionRef, undefined);
  assert.equal(result.state.activeDecisionId, undefined);
});

test('replan: stale trusted direction cannot resume a newer paused plan', async () => {
  const { state: initial, task, plan } = createRepairStateFixture({ node: 'AwaitFeedback' });
  const rejectedDecisionId = plan.decisionRef;
  assert.ok(rejectedDecisionId);
  const state: TaskState = { ...initial, stateVersion: initial.stateVersion + 1, activeDecisionId: undefined };
  const proposalId = 'stale-directed-replan';
  const trustedTransitionContext = createReplanTransitionContext(state, proposalId);
  const memoryState = new MemoryStatePort({
    initialTaskState: state,
    transitionContexts: { [state.stateVersion + 1]: trustedTransitionContext },
  });
  let transitions = 0;
  const statePort: StatePort = {
    ...forwardPublicStatePort(memoryState),
    transition: (next, expectedVersion) => {
      transitions += 1;
      return memoryState.transition(next, expectedVersion);
    },
  };

  const result = await executeReplan(
    {
      taskId: task.taskId,
      proposalId,
      candidatePlan: {
        ...plan,
        strategy: 'A stale direction must not authorize this strategy',
        strategyDigest: computeCanonicalSha256('A stale direction must not authorize this strategy'),
      },
    },
    {
      statePort,
      trustedTransitionContext,
      trustedDirection: {
        directive: 'revise',
        taskId: state.taskId,
        workspaceId: state.workspaceId,
        repositoryRevisionDigest: state.repositoryRevisionDigest,
        stateVersion: state.stateVersion - 1,
        planVersion: state.planVersion,
        rejectedDecisionId,
        strategyDigest: plan.strategyDigest,
      },
    }
  );

  assert.equal(result.outcome, 'AWAIT_FEEDBACK');
  assert.equal(result.state.stateVersion, state.stateVersion);
  assert.equal(result.replanCount, 0);
  assert.equal(transitions, 0);
  assert.equal(memoryState.getLedgers().find((ledger) => ledger.kind === 'replan')?.reservations.length, 0);
});

test('replan: malformed trusted direction cannot authorize a paused-plan transition', async () => {
  const { state: initial, task, plan } = createRepairStateFixture({ node: 'AwaitFeedback' });
  const state: TaskState = { ...initial, activeDecisionId: undefined };
  const proposalId = 'malformed-direction-proposal';
  const trustedTransitionContext = createReplanTransitionContext(state, proposalId);
  const memoryState = new MemoryStatePort({
    initialTaskState: state,
    transitionContexts: { [state.stateVersion + 1]: trustedTransitionContext },
  });
  let transitions = 0;
  let reservations = 0;
  const statePort: StatePort = {
    ...forwardPublicStatePort(memoryState),
    transition: async (...args) => {
      transitions += 1;
      return memoryState.transition(...args);
    },
    reserve: async (...args) => {
      reservations += 1;
      return memoryState.reserve(...args);
    },
  };

  const result = await executeReplan(
    {
      taskId: task.taskId,
      proposalId,
      candidatePlan: {
        ...plan,
        strategy: 'An unknown direction must not admit a revision',
        strategyDigest: computeCanonicalSha256('An unknown direction must not admit a revision'),
      },
    },
    {
      statePort,
      trustedTransitionContext,
      trustedDirection: {
        directive: 'invented' as never,
        taskId: state.taskId,
        workspaceId: state.workspaceId,
        repositoryRevisionDigest: state.repositoryRevisionDigest,
        stateVersion: state.stateVersion,
        planVersion: state.planVersion,
        rejectedDecisionId: plan.decisionRef ?? '',
        strategyDigest: plan.strategyDigest,
      },
    }
  );

  assert.equal(result.outcome, 'AWAIT_FEEDBACK');
  assert.equal(transitions, 0);
  assert.equal(reservations, 0);
});

test('replan: missing, mismatched, exhausted, or inconsistent task ledgers stop before reservation and transition', async () => {
  const { state: base, task, plan } = createRepairStateFixture();
  const original = base.budgetLedgers ?? [];
  const cases: readonly { readonly name: string; readonly state: TaskState }[] = [
    { name: 'missing tokens', state: { ...base, budgetLedgers: original.filter((ledger) => ledger.kind !== 'tokens') } },
    { name: 'missing cost', state: { ...base, budgetLedgers: original.filter((ledger) => ledger.kind !== 'cost') } },
    {
      name: 'foreign token configuration',
      state: { ...base, budgetLedgers: original.map((ledger) => ledger.kind === 'tokens' ? { ...ledger, configurationId: 'foreign-budget-config' } : ledger) },
    },
    {
      name: 'wrong cost unit',
      state: { ...base, budgetLedgers: original.map((ledger) => ledger.kind === 'cost' ? { ...ledger, unit: 'count' } : ledger) },
    },
    {
      name: 'wrong configured replan limit',
      state: { ...base, budgetLedgers: original.map((ledger) => ledger.kind === 'replan' ? { ...ledger, limit: 2 } : ledger) },
    },
    {
      name: 'wrong configured repair limit',
      state: { ...base, budgetLedgers: original.map((ledger) => ledger.kind === 'repair' ? { ...ledger, limit: 1 } : ledger) },
    },
    {
      name: 'consumed token budget',
      state: { ...base, budgetLedgers: original.map((ledger) => ledger.kind === 'tokens' ? { ...ledger, consumed: ledger.limit } : ledger) },
    },
    {
      name: 'consumed cost budget',
      state: { ...base, budgetLedgers: original.map((ledger) => ledger.kind === 'cost' ? { ...ledger, consumed: ledger.limit } : ledger) },
    },
    {
      name: 'consumed repair budget',
      state: { ...base, budgetLedgers: original.map((ledger) => ledger.kind === 'repair' ? { ...ledger, consumed: ledger.limit } : ledger) },
    },
    {
      name: 'replan count does not match charged ledger',
      state: { ...base, budgetLedgers: original.map((ledger) => ledger.kind === 'replan' ? { ...ledger, consumed: 1 } : ledger) },
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    const proposalId = `invalid-accounting-${index}`;
    const trustedTransitionContext = createReplanTransitionContext(scenario.state, proposalId);
    const memoryState = new MemoryStatePort({ initialTaskState: base });
    let initialLoad = true;
    let transitions = 0;
    const statePort: StatePort = {
      ...forwardPublicStatePort(memoryState),
      loadTask: async (taskId) => {
        if (initialLoad) {
          initialLoad = false;
          return scenario.state;
        }
        return memoryState.loadTask(taskId);
      },
      transition: (next, expectedVersion) => {
        transitions += 1;
        return memoryState.transition(next, expectedVersion);
      },
    };
    const candidatePlan: FixPlan = {
      ...plan,
      strategy: `Strategy for ${scenario.name}`,
      strategyDigest: computeCanonicalSha256(`Strategy for ${scenario.name}`),
    };

    const result = await executeReplan(
      { taskId: task.taskId, candidatePlan, proposalId },
      { statePort, trustedTransitionContext }
    );

    assert.equal(result.outcome, 'INCOMPLETE', scenario.name);
    assert.equal(memoryState.getLedgers().find((ledger) => ledger.kind === 'replan')?.reservations.length, 0, scenario.name);
    assert.equal(transitions, 0, scenario.name);
    assert.equal((await memoryState.loadTask(task.taskId))?.stateVersion, scenario.state.stateVersion, scenario.name);
  }
});

test('replan: malformed public candidates return typed incomplete before any port effect', async () => {
  const { state, task, plan } = createRepairStateFixture();
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  let loads = 0;
  let reserves = 0;
  let transitions = 0;
  const statePort: StatePort = {
    ...forwardPublicStatePort(memoryState),
    loadTask: async (taskId) => {
      loads += 1;
      return memoryState.loadTask(taskId);
    },
    reserve: async (...args) => {
      reserves += 1;
      return memoryState.reserve(...args);
    },
    transition: async (...args) => {
      transitions += 1;
      return memoryState.transition(...args);
    },
  };
  const candidates: readonly unknown[] = [
    null,
    { ...plan, strategyDigest: undefined },
    { ...plan, strategy: 42 },
  ];

  for (const [index, candidatePlan] of candidates.entries()) {
    let result: Awaited<ReturnType<typeof executeReplan>> | undefined;
    await assert.doesNotReject(async () => {
      result = await executeReplan(
        { taskId: task.taskId, proposalId: `malformed-${index}`, candidatePlan } as never,
        { statePort }
      );
    });
    assert.equal(result?.outcome, 'INCOMPLETE');
    assert.equal(loads, 0);
    assert.equal(reserves, 0);
    assert.equal(transitions, 0);
  }
});

test('replan: initial plan records version zero without reserving a revision', async () => {
  const { state: source, task, plan } = createRepairStateFixture({ hasPlan: false, node: 'Investigate' });
  const state = { ...source, planVersion: 1 };
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  let reserves = 0;
  const statePort: StatePort = {
    ...forwardPublicStatePort(memoryState),
    reserve: async (...args) => {
      reserves += 1;
      return memoryState.reserve(...args);
    },
  };

  const result = await executeReplan(
    { taskId: task.taskId, proposalId: 'initial-plan-001', candidatePlan: { ...plan, planVersion: 1 } },
    { statePort }
  );

  assert.equal(result.outcome, 'REPLAN_PREPARED');
  assert.equal(result.isMaterial, false);
  assert.equal(result.replanCount, 0);
  assert.equal(result.state.planVersion, 1);
  assert.equal(result.state.node, 'AwaitPlan');
  assert.equal(result.state.activeDecisionId, undefined);
  assert.equal(reserves, 0);
});

test('replan: opaque reservation identifiers containing uncertain are treated as data', async () => {
  const { state: source, task, plan } = createRepairStateFixture({ replanCount: 1 });
  const state = {
    ...source,
    budgetLedgers: source.budgetLedgers?.map((ledger) => ledger.kind === 'replan'
      ? { ...ledger, consumed: 0, reservations: [{ reservationId: 'opaque-uncertain-reservation', keyedId: 'opaque-uncertain-proposal', amount: 1 }] }
      : ledger),
  };
  const proposalId = 'opaque-next-proposal';
  const trustedTransitionContext = createReplanTransitionContext(state, proposalId);
  const memoryState = new MemoryStatePort({
    initialTaskState: state,
    transitionContexts: { [state.stateVersion + 1]: trustedTransitionContext },
  });
  const candidatePlan: FixPlan = {
    ...plan,
    strategy: 'Strategy with opaque prior reservation identity',
    strategyDigest: computeCanonicalSha256('Strategy with opaque prior reservation identity'),
  };

  const result = await executeReplan(
    { taskId: task.taskId, candidatePlan, proposalId },
    { statePort: forwardPublicStatePort(memoryState), trustedTransitionContext }
  );

  assert.equal(result.outcome, 'REPLAN_PREPARED');
  assert.equal(result.replanCount, 2);
});

test('replan: transition and reload failures resolve as typed incomplete without raw errors', async () => {
  const { state, task, plan } = createRepairStateFixture();
  const proposalId = 'transition-and-reload-failures';
  const trustedTransitionContext = createReplanTransitionContext(state, proposalId);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  let loads = 0;
  const statePort: StatePort = {
    ...forwardPublicStatePort(memoryState),
    loadTask: async (taskId) => {
      loads += 1;
      if (loads === 3) throw new Error('raw reload detail');
      return memoryState.loadTask(taskId);
    },
    transition: async () => { throw new Error('raw transition detail'); },
  };
  const candidatePlan: FixPlan = {
    ...plan,
    strategy: 'Transition failure boundary strategy',
    strategyDigest: computeCanonicalSha256('Transition failure boundary strategy'),
  };

  let result: Awaited<ReturnType<typeof executeReplan>> | undefined;
  await assert.doesNotReject(async () => {
    result = await executeReplan(
      { taskId: task.taskId, candidatePlan, proposalId },
      { statePort, trustedTransitionContext }
    );
  });

  assert.equal(result?.outcome, 'INCOMPLETE');
  assert.ok(result?.reasons.every((reason) => !reason.includes('raw')));
  assert.equal(result?.state.budgetLedgers?.find((ledger) => ledger.kind === 'replan')?.reservations.length, 1);
});

test('replan: failed post-repair verification preserves confirmed repair charges and requires reconciliation for unresolved effects', async () => {
  const { state, task, plan } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const initialState = await authorization.statePort.loadTask(task.taskId);
  assert.ok(initialState);

  const proposalId = 'replan-after-failed-repair-verification';
  const trustedReplanContext = createReplanTransitionContext(initialState, proposalId);
  const memoryStatePort = new MemoryStatePort({
    initialTaskState: initialState,
    transitionContexts: {
      [initialState.stateVersion + 1]: authorization.trustedTransitionContext,
      [initialState.stateVersion + 4]: trustedReplanContext,
      [initialState.stateVersion + 5]: trustedReplanContext,
    },
  });
  const forwarded = forwardPublicStatePort(memoryStatePort);
  const reservationKinds: string[] = [];
  const statePort: StatePort = {
    ...forwarded,
    reserve: async (scope, kind, amount, actionId) => {
      reservationKinds.push(kind);
      return forwarded.reserve(scope, kind, amount, actionId);
    },
  };
  const repositoryPort = asLegacyV01RepositoryPort(new FakeRepositoryPort());
  for (const check of task.requiredChecks) {
    repositoryPort.setTestResult(check.checkId, {
      checkId: check.checkId,
      outcome: 'fail',
      outputExcerpt: 'controlled post-repair verification failure',
    });
  }
  let patchCalls = 0;
  const applyPatch = repositoryPort.applyPatch.bind(repositoryPort);
  function wrappedApplyPatch(patch: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  function wrappedApplyPatch(patch: ApplyPatchAction): ReturnType<RepositoryPort["applyPatch"]>;
  async function wrappedApplyPatch(patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02 | Awaited<ReturnType<RepositoryPort["applyPatch"]>>> {
    patchCalls += 1;
    return (context ? applyPatch(patch, context) : applyPatch(patch));
  }
  repositoryPort.applyPatch = wrappedApplyPatch;
  let guardCalls = 0;
  const baseGuard = createExecutionGuard(repositoryPort);
  const executionGuard: ExecutionGuard = {
    provenance: 'mock',
    validateAndExecute: async (action, state) => {
      guardCalls += 1;
      return baseGuard.validateAndExecute(action, state);
    },
  };

  const repair = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: createRepairProposal(failureEvidence, 'confirmed source repair', ['src/calculator.py']),
    },
    {
      statePort,
      repositoryPort,
      approvalPort: authorization.approvalPort,
      trustedTransitionContext: authorization.trustedTransitionContext,
      trustedRepairContext: authorization.trustedRepairContext,
      executionGuard,
    }
  );
  assert.equal(repair.outcome, 'REPAIR_PREPARED');
  assert.ok(repair.reservedActionId);

  const repairedState = await statePort.loadTask(task.taskId);
  assert.ok(repairedState);
  const repairLedgerBefore = repairedState.budgetLedgers?.find((ledger) => ledger.kind === 'repair');
  assert.ok(repairLedgerBefore);
  const repairReservationBefore = repairLedgerBefore.reservations[0];
  assert.ok(repairReservationBefore);
  assert.equal(repairReservationBefore.keyedId, repair.reservedActionId);
  assert.ok(repair.appliedPatchDigest);

  const verificationResults = await executeVerificationChecks(task, repositoryPort, {
    runId: repairedState.runId,
    repoDigest: repairedState.repositoryRevisionDigest,
    diffDigest: repair.appliedPatchDigest,
    actionIdPrefix: 'verify-after-repair',
  });
  assert.ok(verificationResults.length > 0);
  assert.ok(verificationResults.every((result) => result.outcome === 'fail'));
  const failedVerification = verificationResults[0];
  assert.ok(failedVerification);
  assert.equal(failedVerification.repoDigest, repairedState.repositoryRevisionDigest);
  assert.equal(failedVerification.diffDigest, repair.appliedPatchDigest);
  const verificationFailedState = await statePort.transition(
    {
      ...repairedState,
      stateVersion: repairedState.stateVersion + 1,
      node: 'Repair',
      nextAction: 'repair-after-failed-verification',
      evidenceRefs: [...new Set([
        ...repairedState.evidenceRefs,
        ...verificationResults.flatMap((result) => [result.evidenceId, result.actionId, ...result.diagnosticRefs]),
      ])],
    },
    repairedState.stateVersion
  );

  const nextStrategy = 'Use the failed post-repair checks to revise the fix strategy';
  const result = await executeReplan(
    {
      taskId: task.taskId,
      proposalId,
      candidatePlan: { ...plan, strategy: nextStrategy, strategyDigest: computeCanonicalSha256(nextStrategy) },
    },
    { statePort, trustedTransitionContext: trustedReplanContext }
  );

  assert.equal(result.outcome, 'REPLAN_PREPARED');
  assert.equal(result.state.node, 'AwaitPlan');
  assert.equal(result.replanCount, 1);
  assert.equal(verificationFailedState.node, 'Repair');
  assert.equal(patchCalls, 1);
  assert.equal(guardCalls, 1);
  assert.deepEqual(reservationKinds.filter((kind) => kind === 'repair'), ['repair']);
  assert.deepEqual(reservationKinds.filter((kind) => kind === 'replan'), ['replan']);

  const finalState = await statePort.loadTask(task.taskId);
  assert.ok(finalState);
  const repairLedgerAfter = finalState.budgetLedgers?.find((ledger) => ledger.kind === 'repair');
  assert.ok(repairLedgerAfter);
  assert.equal(repairLedgerAfter.consumed, repairLedgerBefore.consumed);
  assert.deepEqual(repairLedgerAfter.reservations, repairLedgerBefore.reservations);

  const { state: unresolvedBase, task: unresolvedTask, plan: unresolvedPlan } = createRepairStateFixture({ node: 'Repair' });
  const unresolvedActionId = 'act-repair-unconfirmed-effect';
  const unresolvedState: TaskState = {
    ...unresolvedBase,
    budgetLedgers: unresolvedBase.budgetLedgers?.map((ledger) => ledger.kind === 'repair'
      ? { ...ledger, reservations: [{ reservationId: 'res-repair-unconfirmed-effect', keyedId: unresolvedActionId, amount: 1 }] }
      : ledger),
  };
  const unresolvedProposalId = 'replan-blocked-by-unresolved-repair-effect';
  const unresolvedContext = createReplanTransitionContext(unresolvedState, unresolvedProposalId);
  const unresolvedMemory = new MemoryStatePort({ initialTaskState: unresolvedState });
  const unresolvedForwarded = forwardPublicStatePort(unresolvedMemory);
  let unresolvedReservations = 0;
  let unresolvedTransitions = 0;
  const unresolvedPort: StatePort = {
    ...unresolvedForwarded,
    reserve: async (scope, kind, amount, actionId) => {
      unresolvedReservations += 1;
      return unresolvedForwarded.reserve(scope, kind, amount, actionId);
    },
    transition: async (next, expectedVersion) => {
      unresolvedTransitions += 1;
      return unresolvedForwarded.transition(next, expectedVersion);
    },
  };
  const unresolvedStrategy = 'Do not replan while an unconfirmed repair effect remains';
  const unresolvedResult = await executeReplan(
    {
      taskId: unresolvedTask.taskId,
      proposalId: unresolvedProposalId,
      candidatePlan: { ...unresolvedPlan, strategy: unresolvedStrategy, strategyDigest: computeCanonicalSha256(unresolvedStrategy) },
    },
    { statePort: unresolvedPort, trustedTransitionContext: unresolvedContext }
  );

  assert.equal(unresolvedResult.outcome, 'INCOMPLETE');
  assert.ok(unresolvedResult.reasons.includes('repair-effect-needs-trusted-reconciliation'));
  assert.equal(unresolvedReservations, 0);
  assert.equal(unresolvedTransitions, 0);
});

// =========================================================================
// SECTION 3: v0.2 Atomic Admission & Guarded Repair Consumer (T060 RED)
// =========================================================================

test('v0.2 repair refuses valid evidence without owner admission context before mutations', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const proposal = createRepairProposal(failureEvidence,
    '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1 +1 @@\n-def divide(a, b): return a / b\n+def divide(a, b): return a / b if b else 0\n',
    ['src/calculator.py']);
  const journal = new MemoryStatePortV02({ initialTaskState: state });
  const statePort = forwardPublicStatePort(journal);
  const repositoryPort = new FakeRepositoryPort({
    statePort,
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' },
  });
  const executionGuard = createExecutionGuardV02({ ports: {
    statePort, repositoryPort, approvalPort: authorization.approvalPort,
  } });
  const beforeState = await statePort.loadTask(task.taskId);
  const beforeJournal = journal.getJournalSnapshot();
  const result = await executeRepair({ taskId: task.taskId, failureEvidence, repairPatch: proposal }, {
    statePort, repositoryPort, executionGuard,
    approvalPort: authorization.approvalPort,
    trustedTransitionContext: authorization.trustedTransitionContext,
    trustedRepairContext: authorization.trustedRepairContext,
  });
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.deepEqual(result.reasons, ['repair-admission-context-required']);
  assert.deepEqual(await statePort.loadTask(task.taskId), beforeState);
  assert.deepEqual(journal.getJournalSnapshot(), beforeJournal);
  assert.equal(repositoryPort.patches.length, 0);
});

function createRepairAdmissionContextV02(
  state: TaskState,
  action: ApplyPatchAction,
  overrides?: Partial<RepositoryAdmissionContextV02>
): RepositoryAdmissionContextV02 {
  const plan = state.plan;
  if (!plan) {
    throw new Error("state.plan is required for repair admission context");
  }
  const planBindingDigest = computeCanonicalSha256({
    taskId: state.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });

  return createTestRepositoryAdmissionContextV02({
    taskId: state.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: state.repositoryId,
    canonicalRevision: state.repositoryRevisionDigest,
    expectedTaskStateVersion: state.stateVersion,
    runnableNode: state.node,
    action,
    targetPaths: action.targetPaths,
    planDecisionRef: plan.decisionRef,
    planBindingDigest,
    ...overrides,
  });
}

test('v0.2 wrapper: forwardPublicStatePort transparently forwards StatePortV02 journal operations and exact results', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const initialTaskState = createTestAdmissionTaskStateV02(context);
  const memoryJournal = new MemoryStatePortV02({
    initialTaskState,
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: context.policyAuthorityRef,
    transitionContexts: createTestAdmissionTransitionContextsV02(context, initialTaskState),
  });

  const forwarded = forwardPublicStatePort(memoryJournal);
  assert.equal(forwarded.provenance, 'mock');

  // Verify loadTask forwarding and exact result
  const loaded = await forwarded.loadTask(initialTaskState.taskId);
  assert.deepEqual(loaded, initialTaskState);

  // Verify checkpoint forwarding and exact result
  await assert.doesNotReject(async () => {
    await forwarded.checkpoint(initialTaskState);
  });

  // Verify claim forwarding and exact result
  const claimReceipt = await forwarded.claim(context);
  assert.ok(claimReceipt.claimId);
  assert.equal(claimReceipt.claimId, `claim-${context.action.actionId}`);
  assert.equal(claimReceipt.taskId, initialTaskState.taskId);

  // Verify beginAttempt forwarding and exact result
  const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attemptReceipt = await forwarded.beginAttempt(claimReceipt.claimId, executor);
  assert.ok(attemptReceipt.attemptId);
  assert.equal(attemptReceipt.claimId, claimReceipt.claimId);

  // Verify recover forwarding and exact result
  const recovered = await forwarded.recover(initialTaskState.taskId);
  assert.ok(recovered);
  assert.equal(recovered.taskId, initialTaskState.taskId);
});

test('v0.2 repair admission: single-owner repair reservation and attempt accounting (behavioral RED against pre-migration repair consumer)', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const patchContent =
    '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,1 +1,3 @@\n+if b == 0: raise CalculationError("Cannot divide by zero")\n def divide(a, b): return a / b\n';
  const proposal = createRepairProposal(failureEvidence, patchContent, ['src/calculator.py']);

  const actionId = `act-repair-${computeCanonicalSha256({
    taskId: state.taskId,
    runId: state.runId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    baselineRef: state.plan ? state.plan.baselineRef : '',
    checkSetDigest: state.plan ? state.plan.checkSetDigest : '',
    diffDigest: authorization.trustedRepairContext.diffDigest,
    evidenceRefs: [failureEvidence.evidenceId],
    actionRefs: [failureEvidence.actionId],
    diagnosticRefs: failureEvidence.diagnosticRefs,
  })}`;

  const patchAction: ApplyPatchAction = {
    actionId,
    kind: 'apply_patch',
    patchContent: proposal.diff,
    targetPaths: [...proposal.affectedPaths],
    baseRevisionDigest: state.repositoryRevisionDigest,
  };

  const context = createRepairAdmissionContextV02(state, patchAction);
  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: context.policyAuthorityRef,
    transitionContexts: authorization.transitionContexts,
  });

  const forwarded = forwardPublicStatePort(journal);
  const repositoryPort = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' },
  });

  // Guard ports use clean approvalPort without conflicting plan binding decisions in v0.1 approval cache
  const guardApprovalPort = new ScriptedApprovalPort({
    classifications: { apply_patch: 'ALLOWED' },
  });
  const executionGuard = createExecutionGuardV02({
    ports: {
      statePort: journal,
      approvalPort: guardApprovalPort,
      repositoryPort,
    },
  });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: proposal,
    },
    {
      statePort: forwarded,
      repositoryPort,
      approvalPort: authorization.approvalPort,
      trustedTransitionContext: authorization.trustedTransitionContext,
      trustedRepairContext: {
        ...authorization.trustedRepairContext,
        admissionContext: context,
      },
      executionGuard,
    }
  );

  assert.equal(res.outcome, 'REPAIR_PREPARED');
  // Target v0.2 acceptance: The ExecutionGuardV02 and StatePortV02 journal own the single reservation
  // and attempt accounting. Pre-migration repair consumer does not invoke v0.2 claim/attempt protocol.
  const snapshot = journal.getJournalSnapshot();
  assert.equal(snapshot.claims.length, 1, 'v0.2 journal must record single repair claim');
  assert.equal(snapshot.attempts.length, 1, 'v0.2 journal must record single repair attempt');
  assert.equal(snapshot.outcomes.length, 1, 'v0.2 journal must record repair outcome');
});

test('v0.2 repair validates active D1 against the current owner and issuer context', async () => {
  const { state: original, task } = createRepairStateFixture({ repairConsumed: 0 });
  const currentRevision = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const decisionId = 'dec-verify-current-001';
  const originalPlan = original.plan;
  assert.ok(originalPlan);
  const state: TaskState = {
    ...original,
    repositoryRevisionDigest: currentRevision,
    plan: { ...originalPlan, decisionRef: decisionId },
    activeDecisionId: decisionId,
  };
  const failureEvidence = { ...createFailedPatchEvidence(task), repoDigest: currentRevision };
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const proposal = createRepairProposal(
    failureEvidence,
    '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1 +1,2 @@\n+if b == 0: raise CalculationError("Cannot divide by zero")\n def divide(a, b): return a / b\n',
    ['src/calculator.py'],
  );
  const actionId = createRepairActionId(state, [failureEvidence]);
  assert.ok(actionId);
  const action: ApplyPatchAction = {
    actionId,
    kind: 'apply_patch',
    patchContent: proposal.diff,
    targetPaths: [...proposal.affectedPaths],
    baseRevisionDigest: currentRevision,
  };
  const admission = createRepairAdmissionContextV02(state, action, { expectedTaskStateVersion: state.stateVersion });
  const approvedD1 = authorization.trustedTransitionContext.approval;
  assert.ok(approvedD1);
  const staleTransitionContext: NonNullable<StateTransitionOptions['trusted']> = {
    ...authorization.trustedTransitionContext,
    approval: {
      ...approvedD1,
      binding: { ...(approvedD1.binding as ApprovalBinding), repositoryRevisionDigest: task.initialRevisionDigest },
      freshness: { ...approvedD1.freshness, currentRepositoryRevisionDigest: task.initialRevisionDigest },
    },
  };
  const staleVerifier: ContextualApprovalVerifierV02 = {
    async resolvePlanDecisionInContext() {
      return { outcome: 'stale', reasonCode: 'CURRENT_D1_REVOKED' };
    },
  };
  const staleJournal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialAuthorityRef: admission.policyAuthorityRef,
    transitionContexts: authorization.transitionContexts,
    verificationApprovalVerifier: staleVerifier,
  });
  const staleRepository = new FakeRepositoryPort({
    statePort: staleJournal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: admission.actionDigest }),
    initialRevision: currentRevision,
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' },
  });
  const staleExecutionGuard = createExecutionGuardV02({ ports: {
    statePort: staleJournal,
    repositoryPort: staleRepository,
    approvalPort: new ScriptedApprovalPort({ classifications: { apply_patch: 'ALLOWED' } }),
  } });
  const originalValidateBinding = authorization.approvalPort.validateBinding.bind(authorization.approvalPort);
  authorization.approvalPort.validateBinding = async () => true;
  const staleResult = await executeRepair(
    { taskId: task.taskId, failureEvidence, repairPatch: proposal },
    {
      statePort: staleJournal,
      repositoryPort: staleRepository,
      executionGuard: staleExecutionGuard,
      approvalPort: authorization.approvalPort,
      admissionContext: admission,
      trustedTransitionContext: staleTransitionContext,
      trustedRepairContext: { ...authorization.trustedRepairContext, admissionContext: admission },
    },
  );
  authorization.approvalPort.validateBinding = originalValidateBinding;
  assert.equal(staleResult.outcome, 'INCOMPLETE');
  assert.deepEqual(await staleJournal.loadTask(task.taskId), state);
  assert.equal(staleJournal.getJournalSnapshot().attempts.length, 0);
  assert.equal(staleRepository.patches.length, 0);

  const verifier: ContextualApprovalVerifierV02 = {
    async resolvePlanDecisionInContext(resolvedDecisionId, context) {
      const freshness = context.approvalContext;
      return {
        outcome: 'resolved',
        decisionId: resolvedDecisionId,
        binding: {
          decisionId: resolvedDecisionId,
          actionKind: 'fix_plan',
          normalizedActionDigest: freshness.currentNormalizedActionDigest,
          taskId: freshness.currentTaskId,
          workspaceId: freshness.currentWorkspaceId,
          repositoryRevisionDigest: freshness.currentRepositoryRevisionDigest,
          policyId: freshness.currentPolicyId,
          policyVersion: freshness.currentPolicyVersion,
          planVersion: freshness.currentPlanVersion,
          strategyDigest: freshness.currentStrategyDigest,
          baselineRef: freshness.currentBaselineRef,
          evidenceRefs: freshness.currentEvidenceRefs,
          criteriaDigest: freshness.currentCriteriaDigest,
          checkSetDigest: freshness.currentCheckSetDigest,
          status: 'approved',
        },
        issuerKeyRef: context.expectedIssuerKeyRef,
        decisionAuthorityGeneration: context.expectedDecisionAuthorityGeneration,
        contextDigest: computeCanonicalSha256(context),
      };
    },
  };
  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialAuthorityRef: admission.policyAuthorityRef,
    transitionContexts: authorization.transitionContexts,
    verificationApprovalVerifier: verifier,
  });
  const repositoryPort = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: admission.actionDigest }),
    initialRevision: currentRevision,
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' },
  });
  const guardApprovalPort = new ScriptedApprovalPort({ classifications: { apply_patch: 'ALLOWED' } });
  const executionGuard = createExecutionGuardV02({ ports: {
    statePort: journal,
    repositoryPort,
    approvalPort: guardApprovalPort,
  } });

  const result = await executeRepair(
    { taskId: task.taskId, failureEvidence, repairPatch: proposal },
    {
      statePort: journal,
      repositoryPort,
      executionGuard,
      approvalPort: authorization.approvalPort,
      admissionContext: admission,
      trustedTransitionContext: authorization.trustedTransitionContext,
      trustedRepairContext: { ...authorization.trustedRepairContext, admissionContext: admission },
    },
  );

  assert.equal(result.outcome, 'REPAIR_PREPARED', result.reasons.join('; '));
  assert.equal(result.state?.node, 'Verify');
  assert.equal(result.state?.repositoryRevisionDigest, repositoryPort.currentRevision);
  assert.equal(journal.getJournalSnapshot().attempts.length, 1);
  assert.equal(repositoryPort.patches.length, 1);
});

test('v0.2 repair admission: exact admitted patch identity and confirmed revision outcome (behavioral RED against pre-migration repair consumer)', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const patchContent =
    '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,1 +1,3 @@\n+if b == 0: raise CalculationError("Cannot divide by zero")\n def divide(a, b): return a / b\n';
  const proposal = createRepairProposal(failureEvidence, patchContent, ['src/calculator.py']);

  const actionId = `act-repair-${computeCanonicalSha256({
    taskId: state.taskId,
    runId: state.runId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    baselineRef: state.plan ? state.plan.baselineRef : '',
    checkSetDigest: state.plan ? state.plan.checkSetDigest : '',
    diffDigest: authorization.trustedRepairContext.diffDigest,
    evidenceRefs: [failureEvidence.evidenceId],
    actionRefs: [failureEvidence.actionId],
    diagnosticRefs: failureEvidence.diagnosticRefs,
  })}`;

  const patchAction: ApplyPatchAction = {
    actionId,
    kind: 'apply_patch',
    patchContent: proposal.diff,
    targetPaths: [...proposal.affectedPaths],
    baseRevisionDigest: state.repositoryRevisionDigest,
  };

  const context = createRepairAdmissionContextV02(state, patchAction);
  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: context.policyAuthorityRef,
    transitionContexts: authorization.transitionContexts,
  });

  const forwarded = forwardPublicStatePort(journal);
  const repositoryPort = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' },
  });

  const guardApprovalPort = new ScriptedApprovalPort({
    classifications: { apply_patch: 'ALLOWED' },
  });
  const executionGuard = createExecutionGuardV02({
    ports: {
      statePort: journal,
      approvalPort: guardApprovalPort,
      repositoryPort,
    },
  });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: proposal,
    },
    {
      statePort: forwarded,
      repositoryPort,
      approvalPort: authorization.approvalPort,
      trustedTransitionContext: authorization.trustedTransitionContext,
      trustedRepairContext: {
        ...authorization.trustedRepairContext,
        admissionContext: context,
      },
      executionGuard,
    }
  );

  assert.equal(res.outcome, 'REPAIR_PREPARED');
  // Target v0.2 acceptance: Exact admitted patch identity and confirmed revision outcome must be
  // committed to the journal outcome receipt.
  const snapshot = journal.getJournalSnapshot();
  assert.ok(snapshot.outcomes.length > 0, 'An authoritative outcome receipt must be recorded in StatePortV02 journal');
  const outcomeReceipt = snapshot.outcomes[0];
  assert.equal(outcomeReceipt?.outcome, 'observed');
  assert.equal(outcomeReceipt?.claimId, snapshot.claims[0]?.claimId);
  assert.equal(outcomeReceipt?.attemptId, snapshot.attempts[0]?.attemptId);
  assert.ok(res.appliedPatchDigest);
});

test('v0.2 repair admission: guard and journal own state transition with no consumer-level second state CAS (behavioral RED against pre-migration repair consumer)', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const patchContent =
    '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,1 +1,3 @@\n+if b == 0: raise CalculationError("Cannot divide by zero")\n def divide(a, b): return a / b\n';
  const proposal = createRepairProposal(failureEvidence, patchContent, ['src/calculator.py']);

  const actionId = `act-repair-${computeCanonicalSha256({
    taskId: state.taskId,
    runId: state.runId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    baselineRef: state.plan ? state.plan.baselineRef : '',
    checkSetDigest: state.plan ? state.plan.checkSetDigest : '',
    diffDigest: authorization.trustedRepairContext.diffDigest,
    evidenceRefs: [failureEvidence.evidenceId],
    actionRefs: [failureEvidence.actionId],
    diagnosticRefs: failureEvidence.diagnosticRefs,
  })}`;

  const patchAction: ApplyPatchAction = {
    actionId,
    kind: 'apply_patch',
    patchContent: proposal.diff,
    targetPaths: [...proposal.affectedPaths],
    baseRevisionDigest: state.repositoryRevisionDigest,
  };

  const context = createRepairAdmissionContextV02(state, patchAction);
  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: context.policyAuthorityRef,
    transitionContexts: authorization.transitionContexts,
  });

  const forwarded = forwardPublicStatePort(journal);
  let consumerTransitionCalls = 0;
  const instrumentedStatePort = {
    ...forwarded,
    transition: async (nextState: TaskState, expectedVersion: number) => {
      consumerTransitionCalls += 1;
      return forwarded.transition(nextState, expectedVersion);
    },
  };

  const repositoryPort = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' },
  });

  const guardApprovalPort = new ScriptedApprovalPort({
    classifications: { apply_patch: 'ALLOWED' },
  });
  const executionGuard = createExecutionGuardV02({
    ports: {
      statePort: journal,
      approvalPort: guardApprovalPort,
      repositoryPort,
    },
  });

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: proposal,
    },
    {
      statePort: instrumentedStatePort,
      repositoryPort,
      approvalPort: authorization.approvalPort,
      trustedTransitionContext: authorization.trustedTransitionContext,
      trustedRepairContext: {
        ...authorization.trustedRepairContext,
        admissionContext: context,
      },
      executionGuard,
    }
  );

  assert.equal(res.outcome, 'REPAIR_PREPARED');
  // Target v0.2 acceptance: Repair submits its proposed patch to ExecutionGuardV02; the guard and
  // StatePortV02 journal own the transition without a second consumer-level state CAS.
  assert.equal(
    consumerTransitionCalls,
    0,
    'Repair consumer must not perform separate direct state CAS transitions; guard and journal own the transition'
  );
});

test('v0.2 repair admission: zero effects on open claim blocking second dispatch (behavioral RED against pre-migration repair consumer)', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const patchContent =
    '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,1 +1,3 @@\n+if b == 0: raise CalculationError("Cannot divide by zero")\n def divide(a, b): return a / b\n';
  const proposal = createRepairProposal(failureEvidence, patchContent, ['src/calculator.py']);

  const actionId = `act-repair-${computeCanonicalSha256({
    taskId: state.taskId,
    runId: state.runId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    baselineRef: state.plan ? state.plan.baselineRef : '',
    checkSetDigest: state.plan ? state.plan.checkSetDigest : '',
    diffDigest: authorization.trustedRepairContext.diffDigest,
    evidenceRefs: [failureEvidence.evidenceId],
    actionRefs: [failureEvidence.actionId],
    diagnosticRefs: failureEvidence.diagnosticRefs,
  })}`;

  const patchAction: ApplyPatchAction = {
    actionId,
    kind: 'apply_patch',
    patchContent: proposal.diff,
    targetPaths: [...proposal.affectedPaths],
    baseRevisionDigest: state.repositoryRevisionDigest,
  };

  const context = createRepairAdmissionContextV02(state, patchAction);
  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: context.policyAuthorityRef,
    transitionContexts: authorization.transitionContexts,
  });

  // Open an active claim on the journal prior to repair invocation
  const claimReceipt = await journal.claim(context);
  assert.ok(claimReceipt.claimId);
  assert.equal(journal.getJournalSnapshot().activeClaimId, claimReceipt.claimId);

  const forwarded = forwardPublicStatePort(journal);
  const repositoryPort = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' },
  });

  const guardApprovalPort = new ScriptedApprovalPort({
    classifications: { apply_patch: 'ALLOWED' },
  });
  const executionGuard = createExecutionGuardV02({
    ports: {
      statePort: journal,
      approvalPort: guardApprovalPort,
      repositoryPort,
    },
  });

  await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence,
      repairPatch: proposal,
    },
    {
      statePort: forwarded,
      repositoryPort,
      approvalPort: authorization.approvalPort,
      trustedTransitionContext: authorization.trustedTransitionContext,
      trustedRepairContext: {
        ...authorization.trustedRepairContext,
        admissionContext: context,
      },
      executionGuard,
    }
  );

  // Target v0.2 acceptance: An existing open claim blocks new attempts; zero repository effects
  // and zero attempts recorded.
  assert.equal(repositoryPort.patches.length, 0, 'Zero patch dispatches while an open claim is active');
  assert.equal(journal.getJournalSnapshot().attempts.length, 0, 'Zero attempts admitted while an open claim is active');
});

test('v0.2 repair admission: zero effects on missing or stale failure evidence context', async () => {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const patchContent =
    '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,1 +1,3 @@\n+if b == 0: raise CalculationError("Cannot divide by zero")\n def divide(a, b): return a / b\n';
  const proposal = createRepairProposal(failureEvidence, patchContent, ['src/calculator.py']);

  const journal = new MemoryStatePortV02({ initialTaskState: state });
  const forwarded = forwardPublicStatePort(journal);
  const repositoryPort = new FakeRepositoryPort({
    statePort: journal,
    initialFiles: { 'src/calculator.py': 'def divide(a, b): return a / b\n' },
  });

  const staleEvidence: VerificationResult = {
    ...failureEvidence,
    repoDigest: 'sha256:stale000000000000000000000000000000000000000000000000000000000000',
  };

  const res = await executeRepair(
    {
      taskId: task.taskId,
      failureEvidence: staleEvidence,
      repairPatch: proposal,
    },
    {
      statePort: forwarded,
      repositoryPort,
      approvalPort: authorization.approvalPort,
    }
  );

  assert.notEqual(res.outcome, 'REPAIR_PREPARED');
  assert.equal(repositoryPort.patches.length, 0, 'Zero patch dispatches on stale failure evidence');
  assert.equal(journal.getJournalSnapshot().attempts.length, 0, 'Zero attempts admitted on stale evidence');
  assert.equal(journal.getJournalSnapshot().claims.length, 0, 'Zero claims admitted on stale evidence');
});


async function createRepairReceiverHarness(mode: 'failed' | 'partial' | 'observed-conflict' | 'observed') {
  const { state, task } = createRepairStateFixture({ repairConsumed: 0 });
  const failureEvidence = createFailedPatchEvidence(task);
  const authorization = createAuthorizedRepairPorts(state, 'ALLOWED', failureEvidence);
  const proposal = createRepairProposal(failureEvidence, 'controlled repair diff', ['src/calculator.py']);
  const action: ApplyPatchAction = {
    actionId: `act-repair-${computeCanonicalSha256({
      taskId: state.taskId, runId: state.runId, repositoryRevisionDigest: state.repositoryRevisionDigest,
      baselineRef: state.plan?.baselineRef, checkSetDigest: state.plan?.checkSetDigest,
      diffDigest: authorization.trustedRepairContext.diffDigest,
      evidenceRefs: [failureEvidence.evidenceId], actionRefs: [failureEvidence.actionId],
      diagnosticRefs: failureEvidence.diagnosticRefs,
    })}`,
    kind: 'apply_patch', patchContent: proposal.diff, targetPaths: proposal.affectedPaths,
    baseRevisionDigest: state.repositoryRevisionDigest,
  };
  const admission = createRepairAdmissionContextV02(state, action);
  const journal = new MemoryStatePortV02({
    initialTaskState: state, initialAuthorityRef: admission.policyAuthorityRef,
    initialControlVersion: admission.expectedControlVersion, initialEpoch: admission.expectedEpoch,
    transitionContexts: authorization.transitionContexts,
  });
  const publicPort = forwardPublicStatePort(journal);
  const calls = { claim: 0, begin: 0, record: 0, consumerCas: 0, effects: 0 };
  let submitted: RepositoryActionOutcomeReceiptV02 | undefined;
  let settlement: Awaited<ReturnType<StatePortV02['recordOutcome']>> | undefined;
  const receiverPort: StatePortV02 = {
    ...publicPort,
    claim: async (context) => { calls.claim++; return publicPort.claim(context); },
    beginAttempt: async (claimId, executor) => { calls.begin++; return publicPort.beginAttempt(claimId, executor); },
    recordOutcome: async (receipt) => {
      calls.record++;
      assert.equal(receipt.subjectKind, 'repository-action');
      if (receipt.subjectKind !== 'repository-action') throw new Error('repository outcome required');
      submitted = receipt;
      if (mode === 'observed-conflict') {
        const current = await journal.loadTask(task.taskId);
        assert.ok(current);
        // Simulate owner state drift after the effect, before settlement.
        journal.getUnderlying().internalSetTask({ ...current, node: 'Repair' });
      }
      settlement = await publicPort.recordOutcome(receipt);
      return settlement;
    },
  };
  const manager = new DockerWorkspaceManager({ controller: {
    provenance: 'mock', createVolume: async () => undefined, hasVolume: async () => true,
    removeVolume: async () => undefined,
  } });
  await manager.createWorkspace({
    taskId: task.taskId, workspaceId: state.workspaceId, initialRevisionDigest: state.repositoryRevisionDigest,
    profile: { profileId: admission.executionProfileId, image: 'test', imageDigest: state.repositoryRevisionDigest,
      user: '1000:1000', readOnlyRootFilesystem: true, network: 'none', mounts: [],
      limits: { timeoutMs: 30000, maxMemoryBytes: 2147483648, maxCpuCores: 2, maxPids: 256 } },
  });
  let revision = state.repositoryRevisionDigest;
  const observedRevision = 'sha256:' + 'b'.repeat(64);
  const unused = async (): Promise<never> => { throw new Error('unexpected read'); };
  const fsPort: TrustedFilesystemPort = {
    provenance: 'mock', stat: unused, lstat: unused, realpath: unused, readDir: unused, readTextFile: unused,
    getCurrentRevisionDigest: async () => revision,
  };
  const repositoryPort = new ControlledRepositoryTools({
    provenance: 'mock', fsPort, limits: { maxExcerptBytes: 1024, maxResultCount: 10 },
    guardCapability: { provenance: 'mock', capabilityId: 'unused-read', workspaceId: state.workspaceId,
      taskId: task.taskId, mediateRead: unused },
    workspaceManager: manager, statePort: receiverPort,
    adapterIdentity: 'repair-test', processIncarnation: 'repair-test-1', fencingGeneration: 1,
    attemptStartRecoveryHandoff: { queryAttemptStart: async () => ({ outcome: 'unknown' }) },
    unattemptedClaimClosureHandoff: { closeUnattemptedClaim: async () => ({ closed: false, receiptId: '' }) },
    patchRecoveryHandoff: {
      prepare: async (input) => {
        assert.deepEqual(input.outcome, submitted, 'Recovery receives the exact retained receiver outcome');
        assert.equal(input.outcome.outcome, 'observed');
        const current = await journal.loadTask(task.taskId);
        assert.ok(current);
        const receipt = createTestObservedReconciliationReceiptV02(input.outcome, input.claim, input.attempt, input.admission, {
          expectedCurrentTaskStateVersion: current.stateVersion,
          expectedCurrentControlVersion: journal.getJournalSnapshot().controlVersion,
        });
        return { receipt, validationContext: createTestReconciliationValidationContextV02(
          receipt, input.outcome, input.claim, input.attempt, input.admission,
        ) };
      },
    },
    patchReceiver: async () => {
      calls.effects++;
      if (mode === 'failed') throw new Error('controlled patch failure');
      revision = observedRevision;
      manager.setCanonicalRevision(state.workspaceId, revision);
      if (mode === 'partial') throw new Error('controlled interruption after partial effect');
      return { applied: true, newRevisionDigest: revision };
    },
  });
  const executionGuard = createExecutionGuardV02({ ports: {
    statePort: publicPort, repositoryPort,
    approvalPort: new ScriptedApprovalPort({ classifications: { apply_patch: 'ALLOWED' } }),
  } });
  const ports = {
    statePort: { ...publicPort, transition: async (next: TaskState, expected: number) => {
      calls.consumerCas++; return publicPort.transition(next, expected);
    } },
    repositoryPort, executionGuard, approvalPort: authorization.approvalPort,
    trustedTransitionContext: authorization.trustedTransitionContext,
    trustedRepairContext: authorization.trustedRepairContext, admissionContext: admission,
  };
  const input = { taskId: task.taskId, failureEvidence, repairPatch: proposal };
  return { state, journal, repositoryPort, manager, calls, ports, input, observedRevision,
    submitted: () => submitted, settlement: () => settlement, revision: () => revision };
}

for (const mode of ['failed', 'partial'] as const) {
  test(`v0.2 repair: ${mode} receiver consumes allowance once without refund or reapply`, async () => {
    const h = await createRepairReceiverHarness(mode);
    const result = await executeRepair(h.input, h.ports);
    assert.equal(result.outcome, 'INCOMPLETE');
    const persisted = await h.journal.loadTask(h.input.taskId);
    assert.deepEqual(result.state, persisted);
    assert.equal(persisted?.node, 'Patch');
    const ledger = persisted?.budgetLedgers?.find((entry) => entry.kind === 'repair');
    assert.equal(ledger?.consumed, 1);
    assert.deepEqual(ledger?.reservations, []);
    assert.equal(h.revision(), mode === 'partial' ? h.observedRevision : h.state.repositoryRevisionDigest);
    assert.equal(persisted?.repositoryRevisionDigest, h.state.repositoryRevisionDigest);
    const snapshot = h.journal.getJournalSnapshot();
    assert.equal(snapshot.claims.length, 1);
    assert.equal(snapshot.attempts.length, 1);
    assert.equal(snapshot.outcomes.length, 1);
    assert.equal(snapshot.attempts[0]?.status, 'uncertain');
    assert.equal(snapshot.outcomes[0]?.receiptDigest, h.submitted()?.receiptDigest);
    assert.equal(snapshot.outcomes[0]?.receiptId, h.submitted()?.receiptId);
    assert.equal(h.submitted()?.outcome, 'uncertain');
    assert.equal(h.settlement()?.outcome, 'uncertain');
    assert.equal(h.manager.hasActiveWriterLease(h.state.workspaceId), true);
    const retry = await executeRepair(h.input, h.ports);
    assert.equal(retry.outcome, 'INCOMPLETE');
    assert.deepEqual(await h.journal.loadTask(h.input.taskId), persisted);
    assert.deepEqual(h.journal.getJournalSnapshot(), snapshot);
    assert.deepEqual(h.calls, { claim: 1, begin: 1, record: 1, consumerCas: 0, effects: 1 });
  });
}

test('v0.2 repair: observed patch conflict retains exact outcome and reconciles without reapply or reset', async () => {
  const h = await createRepairReceiverHarness('observed-conflict');
  const result = await executeRepair(h.input, h.ports);
  assert.equal(result.outcome, 'INCOMPLETE');
  assert.equal(h.settlement()?.outcome, 'recorded-unsettled');
  const held = await h.journal.loadTask(h.input.taskId);
  assert.ok(held);
  assert.deepEqual(result.state, held);
  assert.equal(held.node, 'Repair');
  assert.equal(held.repositoryRevisionDigest, h.state.repositoryRevisionDigest);
  assert.equal(held.budgetLedgers?.find((entry) => entry.kind === 'repair')?.consumed, 1);
  const snapshot = h.journal.getJournalSnapshot();
  assert.equal(snapshot.claims.length, 1);
  assert.equal(snapshot.attempts.length, 1);
  assert.equal(snapshot.outcomes.length, 1);
  assert.equal(snapshot.attempts[0]?.status, 'observed-unsettled');
  assert.equal(snapshot.outcomes[0]?.receiptDigest, h.submitted()?.receiptDigest);
  assert.equal(snapshot.outcomes[0]?.receiptId, h.submitted()?.receiptId);
  assert.equal(h.submitted()?.observedResultRevisionDigest, h.observedRevision);
  assert.equal(h.revision(), h.observedRevision);
  assert.equal(h.manager.hasActiveWriterLease(h.state.workspaceId), true);
  assert.equal((await executeRepair(h.input, h.ports)).outcome, 'DENIED');
  assert.deepEqual(h.journal.getJournalSnapshot(), snapshot);
  assert.deepEqual(await h.journal.loadTask(h.input.taskId), held);
  // Simulated UC-04 recovery confirms the observed workspace revision without resetting accounting.
  h.journal.getUnderlying().internalSetTask({ ...held, node: 'Patch', repositoryRevisionDigest: h.observedRevision });
  const attemptId = snapshot.attempts[0]?.attemptId;
  assert.ok(attemptId);
  assert.equal((await h.repositoryPort.recoverPatchOutcome(attemptId)).outcome, 'settled');
  const recovered = await h.journal.loadTask(h.input.taskId);
  assert.ok(recovered);
  assert.equal(recovered.node, 'Verify');
  assert.equal(recovered.repositoryRevisionDigest, h.observedRevision);
  assert.equal(recovered.budgetLedgers?.find((entry) => entry.kind === 'repair')?.consumed, 1);
  assert.deepEqual(recovered.budgetLedgers?.find((entry) => entry.kind === 'repair')?.reservations, []);
  assert.equal(recovered.activeDecisionId, undefined);
  assert.deepEqual(recovered.reviewRefs, []);
  assert.equal(h.manager.hasActiveWriterLease(h.state.workspaceId), false);
  const settled = h.journal.getJournalSnapshot();
  assert.equal(settled.activeClaimId, null);
  assert.equal(settled.attempts[0]?.status, 'settled');
  assert.deepEqual(settled.outcomes, snapshot.outcomes);
  assert.equal((await executeRepair(h.input, h.ports)).outcome, 'INCOMPLETE');
  await assert.rejects(() => h.repositoryPort.recoverPatchOutcome(attemptId), /RECOVERY_NOT_FOUND/);
  assert.deepEqual(await h.journal.loadTask(h.input.taskId), recovered);
  assert.deepEqual(h.journal.getJournalSnapshot(), settled);
  assert.deepEqual(h.calls, { claim: 1, begin: 1, record: 1, consumerCas: 0, effects: 1 });
});


for (const stale of ['control', 'authority'] as const) {
  test(`v0.2 repair: stale owner ${stale} context refuses with unchanged state and journal`, async () => {
    const h = await createRepairReceiverHarness('observed');
    if (stale === 'control') {
      h.ports.admissionContext = { ...h.ports.admissionContext,
        expectedControlVersion: h.ports.admissionContext.expectedControlVersion + 1 };
    } else {
      const old = h.ports.admissionContext.policyAuthorityRef;
      const publication = await h.journal.publishAuthority({ authorityRef: {
        ...old, decisionAuthorityGeneration: old.decisionAuthorityGeneration + 1,
      } });
      assert.equal(publication.status, 'published');
    }
    const before = await h.journal.loadTask(h.input.taskId);
    const snapshot = h.journal.getJournalSnapshot();
    const result = await executeRepair(h.input, h.ports);
    assert.equal(result.outcome, 'INCOMPLETE');
    assert.deepEqual(result.reasons, ['RECEIVER_OUTCOME_UNVERIFIED: Receiver invocation requires recovery']);
    assert.deepEqual(result.state, before);
    assert.deepEqual(await h.journal.loadTask(h.input.taskId), before);
    assert.deepEqual(h.journal.getJournalSnapshot(), snapshot);
    assert.equal(h.calls.effects, 0);
    assert.equal(h.calls.begin, 0);
    assert.equal(h.calls.record, 0);
    assert.equal(h.calls.consumerCas, 0);
    assert.equal(h.manager.hasActiveWriterLease(h.state.workspaceId), false);
  });
}
