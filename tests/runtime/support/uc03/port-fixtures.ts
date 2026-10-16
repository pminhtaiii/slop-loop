/**
 * UC-03 Phase 2 - Port Mock Fixture Profiles
 *
 * Owned path: tests/runtime/support/uc03/port-fixtures.ts
 * Feature: specs/001-verified-code-repair
 *
 * Deterministic test-only fixture profiles for ModelPort, ReviewerPort,
 * and RepositoryPort mocks. These are controlled fixtures and do NOT
 * attest to real production provider, isolation, or durability quality.
 */

import {
  type BugTask,
  type TaskState,
  type ProviderRequest,
  type DispatchAdmissionContext,
  type BudgetLedger,
  type ReservationBundle,
  type ReservationBundleItem,
  type SourceEvidence,
  type CheckDefinition,
  type ExecutionLimits,
  type BudgetLimits,
  CONTRACT_VERSION,
} from '../../../../src/contracts/uc03.ts';

export function createFixtureExecutionLimits(): ExecutionLimits {
  return {
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
    maxCpuCores: 2,
    maxMemoryBytes: 2147483648,
    maxPids: 64,
  };
}

export function createFixtureBudgetLimits(): BudgetLimits {
  return {
    maxReplanCount: 3,
    maxTokens: 100000,
    maxCostUsd: 5.0,
    maxRepairAttempts: 2,
    maxReviewIterations: 2,
  };
}

export function createFixtureCheckDefinition(
  overrides?: Partial<CheckDefinition>
): CheckDefinition {
  return {
    checkId: 'check-pytest-reproduction',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    purpose: 'reproduction',
    workingDirectory: 'tests',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
    ...overrides,
  };
}

export function createFixtureBugTask(overrides?: Partial<BugTask>): BugTask {
  return {
    taskId: 'task-calc-001',
    repositoryId: 'repo-calc',
    initialRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    goal: 'Fix ZeroDivisionError in Calculator.divide',
    observedBehavior: 'ZeroDivisionError raised without handling',
    expectedBehavior: 'CalculationError raised with clean message',
    reproduction: 'pytest tests/test_calculator.py',
    acceptanceCriteria: ['Calculator.divide raises CalculationError on zero denominator'],
    constraints: ['Preserve existing method signature'],
    requiredChecks: [createFixtureCheckDefinition()],
    limits: createFixtureExecutionLimits(),
    budgetLimits: createFixtureBudgetLimits(),
    configId: 'config-v1',
    configVersion: '1.0.0',
    ...overrides,
  };
}

export function createFixtureTaskState(overrides?: Partial<TaskState>): TaskState {
  const task = createFixtureBugTask();
  return {
    schemaVersion: CONTRACT_VERSION,
    stateVersion: 1,
    taskId: task.taskId,
    runId: 'run-001',
    workspaceId: 'workspace-001',
    repositoryId: task.repositoryId,
    repositoryRevisionDigest: task.initialRevisionDigest,
    goal: task.goal,
    observedBehavior: task.observedBehavior,
    expectedBehavior: task.expectedBehavior,
    reproduction: task.reproduction,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: task.constraints,
    requiredCheckIds: task.requiredChecks.map((c) => c.checkId),
    taskContext: task,
    node: 'Investigate',
    planVersion: 1,
    replanCount: 0,
    changedPaths: [],
    evidenceRefs: ['evidence-baseline-001'],
    risks: [],
    nextAction: 'propose-fix-plan',
    ...overrides,
  };
}

export function createFixtureProviderRequest(
  overrides?: Partial<ProviderRequest>
): ProviderRequest {
  return {
    providerRequestId: 'req-coder-001',
    taskId: 'task-calc-001',
    runId: 'run-001',
    role: 'coder',
    purpose: 'investigate-and-propose',
    providerId: 'provider-test',
    modelId: 'model-test-v1',
    configId: 'config-v1',
    pricingPolicyId: 'pricing-v1',
    contextDigest: 'sha256:context-001',
    timeoutMs: 30000,
    maxInputTokens: 2000,
    maxOutputTokens: 1000,
    maxBillableTokens: 4000,
    maxCostUsd: 0.1,
    reservationRef: 'bundle-001',
    dispatchState: 'reserved',
    ...overrides,
  };
}

export function createFixtureReviewerRequest(
  overrides?: Partial<ProviderRequest>
): ProviderRequest {
  return {
    providerRequestId: 'req-reviewer-001',
    taskId: 'task-calc-001',
    runId: 'run-001',
    role: 'reviewer',
    purpose: 'review-diff-lines',
    providerId: 'provider-test',
    modelId: 'model-reviewer-v1',
    configId: 'config-reviewer-v1',
    pricingPolicyId: 'pricing-v1',
    contextDigest: 'sha256:reviewer-context-001',
    timeoutMs: 30000,
    maxInputTokens: 2000,
    maxOutputTokens: 1000,
    maxBillableTokens: 4000,
    maxCostUsd: 0.1,
    reservationRef: 'bundle-reviewer-001',
    dispatchState: 'reserved',
    ...overrides,
  };
}

export function createFixtureSourceEvidence(
  overrides?: Partial<SourceEvidence>
): SourceEvidence {
  return {
    path: 'src/calculator.py',
    revisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    boundedExcerpt: 'def divide(a, b):\n    return a / b\n',
    resultCount: 1,
    truncated: false,
    ...overrides,
  };
}

export interface BuildAdmissionContextOptions {
  request?: ProviderRequest | undefined;
  taskTokensLimit?: number | undefined;
  taskCostLimit?: number | undefined;
  runTokensLimit?: number | undefined;
  runCostLimit?: number | undefined;
  taskTokensConsumed?: number | undefined;
  taskCostConsumed?: number | undefined;
  runTokensConsumed?: number | undefined;
  runCostConsumed?: number | undefined;
  omitTaskTokenRes?: boolean | undefined;
  omitTaskCostRes?: boolean | undefined;
  omitRunTokenRes?: boolean | undefined;
  omitRunCostRes?: boolean | undefined;
  omitReviewerIterationRes?: boolean | undefined;
  runReviewerIterationConsumed?: number | undefined;
  reviewerIterationLimit?: number | undefined;
  reviewerIterationConsumed?: number | undefined;
  taskAccountingStatus?: 'healthy' | 'unknown' | undefined;
  isTelemetryEstimate?: boolean | undefined;
  requireRunReviewIteration?: boolean | undefined;
  includeUncertainStoredRequest?: boolean | undefined;
}

export function createFixtureAdmissionContext(
  options?: BuildAdmissionContextOptions
): { context: DispatchAdmissionContext; request: ProviderRequest } {
  const req = options?.request ?? createFixtureProviderRequest();
  const configId = req.configId;
  const requestId = req.providerRequestId;

  const isReviewer = req.role === 'reviewer';

  const taskTokenLedgerId = 'ledger-task-tokens';
  const taskCostLedgerId = 'ledger-task-cost';
  const runTokenLedgerId = 'ledger-run-tokens';
  const runCostLedgerId = 'ledger-run-cost';
  const taskIterLedgerId = 'ledger-task-iter';

  const taskTokenResAmount = req.maxBillableTokens;
  const taskCostResAmount = req.maxCostUsd;
  const runTokenResAmount = req.maxBillableTokens;
  const runCostResAmount = req.maxCostUsd;
  const reviewerIterResAmount = 1;

  const bundleReservations: ReservationBundleItem[] = [];

  if (!options?.omitTaskTokenRes) {
    bundleReservations.push({
      ledgerIdentity: taskTokenLedgerId,
      scope: 'task',
      kind: 'tokens',
      configurationId: configId,
      version: 1,
      requestId,
      amount: taskTokenResAmount,
    });
  }

  if (!options?.omitTaskCostRes) {
    bundleReservations.push({
      ledgerIdentity: taskCostLedgerId,
      scope: 'task',
      kind: 'cost',
      configurationId: configId,
      version: 1,
      requestId,
      amount: taskCostResAmount,
    });
  }

  if (!options?.omitRunTokenRes) {
    bundleReservations.push({
      ledgerIdentity: runTokenLedgerId,
      scope: 'run',
      kind: 'tokens',
      configurationId: configId,
      version: 1,
      requestId,
      amount: runTokenResAmount,
    });
  }

  if (!options?.omitRunCostRes) {
    bundleReservations.push({
      ledgerIdentity: runCostLedgerId,
      scope: 'run',
      kind: 'cost',
      configurationId: configId,
      version: 1,
      requestId,
      amount: runCostResAmount,
    });
  }

  if (isReviewer && !options?.omitReviewerIterationRes) {
    bundleReservations.push({
      ledgerIdentity: taskIterLedgerId,
      scope: 'task',
      kind: 'iteration',
      configurationId: configId,
      version: 1,
      requestId,
      amount: reviewerIterResAmount,
    });
  }

  const reservationBundle: ReservationBundle = {
    bundleId: req.reservationRef,
    transactionRef: 'tx-001',
    taskId: req.taskId,
    runId: req.runId,
    reservations: bundleReservations,
  };

  const ledgers: BudgetLedger[] = [
    {
      scope: 'task',
      kind: 'tokens',
      limit: options?.taskTokensLimit ?? 100000,
      consumed: options?.taskTokensConsumed ?? 0,
      reservations: options?.omitTaskTokenRes
        ? []
        : [{ reservationId: 'res-task-tokens-1', keyedId: requestId, amount: taskTokenResAmount }],
      unit: 'tokens',
      configurationId: configId,
      version: 1,
    },
    {
      scope: 'task',
      kind: 'cost',
      limit: options?.taskCostLimit ?? 5.0,
      consumed: options?.taskCostConsumed ?? 0,
      reservations: options?.omitTaskCostRes
        ? []
        : [{ reservationId: 'res-task-cost-1', keyedId: requestId, amount: taskCostResAmount }],
      unit: 'usd',
      configurationId: configId,
      version: 1,
    },
    {
      scope: 'run',
      kind: 'tokens',
      limit: options?.runTokensLimit ?? 50000,
      consumed: options?.runTokensConsumed ?? 0,
      reservations: options?.omitRunTokenRes
        ? []
        : [{ reservationId: 'res-run-tokens-1', keyedId: requestId, amount: runTokenResAmount }],
      unit: 'tokens',
      configurationId: configId,
      version: 1,
    },
    {
      scope: 'run',
      kind: 'cost',
      limit: options?.runCostLimit ?? 2.0,
      consumed: options?.runCostConsumed ?? 0,
      reservations: options?.omitRunCostRes
        ? []
        : [{ reservationId: 'res-run-cost-1', keyedId: requestId, amount: runCostResAmount }],
      unit: 'usd',
      configurationId: configId,
      version: 1,
    },
  ];

  const ledgerIdentities = [
    taskTokenLedgerId,
    taskCostLedgerId,
    runTokenLedgerId,
    runCostLedgerId,
  ];

  const reservationIds: Record<string, string> = {
    [taskTokenLedgerId]: 'res-task-tokens-1',
    [taskCostLedgerId]: 'res-task-cost-1',
    [runTokenLedgerId]: 'res-run-tokens-1',
    [runCostLedgerId]: 'res-run-cost-1',
  };

  if (isReviewer) {
    ledgers.push({
      scope: 'task',
      kind: 'iteration',
      limit: options?.reviewerIterationLimit ?? 5,
      consumed: options?.reviewerIterationConsumed ?? 0,
      reservations: options?.omitReviewerIterationRes
        ? []
        : [{ reservationId: 'res-task-iter-1', keyedId: requestId, amount: reviewerIterResAmount }],
      unit: 'count',
      configurationId: configId,
      version: 1,
    });
    ledgerIdentities.push(taskIterLedgerId);
    reservationIds[taskIterLedgerId] = 'res-task-iter-1';
  }

  if (isReviewer && options?.runReviewerIterationConsumed !== undefined) {
    ledgers.push({ scope: 'run', kind: 'iteration', limit: 5,
      consumed: options.runReviewerIterationConsumed,
      reservations: [{ reservationId: 'res-run-iter-1', keyedId: requestId, amount: 1 }],
      unit: 'count', configurationId: configId, version: 1 });
    ledgerIdentities.push('ledger-run-iter');
    reservationIds['ledger-run-iter'] = 'res-run-iter-1';
    bundleReservations.push({ ledgerIdentity: 'ledger-run-iter', scope: 'run', kind: 'iteration',
      configurationId: configId, version: 1, requestId, amount: 1 });
  }

  const storedRequests: ProviderRequest[] = [req];
  if (options?.includeUncertainStoredRequest) {
    storedRequests.push({
      ...req,
      providerRequestId: 'req-prior-uncertain',
      dispatchState: 'uncertain',
      uncertainReason: 'Timeout on simulated upstream call',
    });
  }

  const context: DispatchAdmissionContext = {
    expectedRequest: req,
    storedRequests,
    taskAccountingStatus: options?.taskAccountingStatus ?? 'healthy',
    transactionRef: 'tx-001',
    ledgerIdentities,
    requireRunReviewIteration: options?.requireRunReviewIteration ?? false,
    reservationIds,
    ledgers,
    reservationBundle,
    ...(options?.isTelemetryEstimate !== undefined
      ? { isTelemetryEstimate: options.isTelemetryEstimate }
      : {}),
  };

  return { context, request: req };
}
