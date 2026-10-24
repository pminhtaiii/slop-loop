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
  type NormalizedAction,
  type RepositoryAdmissionContextV02,
  type ProviderAdmissionContextV02,
  type PolicyAuthorityRefV02,
  type PolicyEvaluationReceiptV02,
  type ActionDecisionReceiptV02,
  type ProviderAdmissionReceiptV02,
  type AttemptReceiptV02,
  type ClaimReceiptV02,
  type ExecutorIdentityV02,
  type ProviderRoleV02,
  computeCanonicalSha256,
  computeAdmissionDigest,
  computeActionDigest,
  computeRequestContentDigest,
  CONTRACT_VERSION,
} from '../../../../src/contracts/foundation/uc03.ts';
import { createTestRepositoryCommandAdmissionContextV02 } from './state-fixtures.ts';

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

  // Compatibility aliases
  includeTaskTokens?: boolean | undefined;
  includeTaskCost?: boolean | undefined;
  includeRunTokens?: boolean | undefined;
  includeRunCost?: boolean | undefined;
  includeTaskIteration?: boolean | undefined;
  includeRunIteration?: boolean | undefined;
  taskCostLimitUsd?: number | undefined;
  taskCostConsumedUsd?: number | undefined;
  runCostLimitUsd?: number | undefined;
  runCostConsumedUsd?: number | undefined;
  taskIterationsLimit?: number | undefined;
  taskIterationsConsumed?: number | undefined;
  runIterationsLimit?: number | undefined;
  runIterationsConsumed?: number | undefined;
  requestHistoryStatus?: 'uncertain' | 'healthy' | undefined;
  contextProvenance?: string | undefined;
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

  const omitTaskTokenRes = options?.omitTaskTokenRes ?? (options?.includeTaskTokens === false);
  const omitTaskCostRes = options?.omitTaskCostRes ?? (options?.includeTaskCost === false);
  const omitRunTokenRes = options?.omitRunTokenRes ?? (options?.includeRunTokens === false);
  const omitRunCostRes = options?.omitRunCostRes ?? (options?.includeRunCost === false);
  const omitReviewerIterationRes = options?.omitReviewerIterationRes ?? (options?.includeTaskIteration === false);

  const bundleReservations: ReservationBundleItem[] = [];

  if (!omitTaskTokenRes) {
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

  if (!omitTaskCostRes) {
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

  if (!omitRunTokenRes) {
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

  if (!omitRunCostRes) {
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

  if (isReviewer && !omitReviewerIterationRes) {
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

  const taskTokensLimit = options?.taskTokensLimit ?? 100000;
  const taskTokensConsumed = options?.taskTokensConsumed ?? 0;
  const taskCostLimit = options?.taskCostLimit ?? options?.taskCostLimitUsd ?? 5.0;
  const taskCostConsumed = options?.taskCostConsumed ?? options?.taskCostConsumedUsd ?? 0;
  const runTokensLimit = options?.runTokensLimit ?? 50000;
  const runTokensConsumed = options?.runTokensConsumed ?? 0;
  const runCostLimit = options?.runCostLimit ?? options?.runCostLimitUsd ?? 2.0;
  const runCostConsumed = options?.runCostConsumed ?? options?.runCostConsumedUsd ?? 0;
  const reviewerIterationLimit = options?.reviewerIterationLimit ?? options?.taskIterationsLimit ?? 5;
  const reviewerIterationConsumed = options?.reviewerIterationConsumed ?? options?.taskIterationsConsumed ?? 0;

  const requireRunReviewIteration =
    options?.requireRunReviewIteration ??
    (options?.includeRunIteration !== undefined || options?.runIterationsConsumed !== undefined);
  const runReviewerIterationConsumed =
    options?.runReviewerIterationConsumed ?? options?.runIterationsConsumed;

  const ledgers: BudgetLedger[] = [
    {
      scope: 'task',
      kind: 'tokens',
      limit: taskTokensLimit,
      consumed: taskTokensConsumed,
      reservations: omitTaskTokenRes
        ? []
        : [{ reservationId: 'res-task-tokens-1', keyedId: requestId, amount: taskTokenResAmount }],
      unit: 'tokens',
      configurationId: configId,
      version: 1,
    },
    {
      scope: 'task',
      kind: 'cost',
      limit: taskCostLimit,
      consumed: taskCostConsumed,
      reservations: omitTaskCostRes
        ? []
        : [{ reservationId: 'res-task-cost-1', keyedId: requestId, amount: taskCostResAmount }],
      unit: 'usd',
      configurationId: configId,
      version: 1,
    },
    {
      scope: 'run',
      kind: 'tokens',
      limit: runTokensLimit,
      consumed: runTokensConsumed,
      reservations: omitRunTokenRes
        ? []
        : [{ reservationId: 'res-run-tokens-1', keyedId: requestId, amount: runTokenResAmount }],
      unit: 'tokens',
      configurationId: configId,
      version: 1,
    },
    {
      scope: 'run',
      kind: 'cost',
      limit: runCostLimit,
      consumed: runCostConsumed,
      reservations: omitRunCostRes
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
      limit: reviewerIterationLimit,
      consumed: reviewerIterationConsumed,
      reservations: omitReviewerIterationRes
        ? []
        : [{ reservationId: 'res-task-iter-1', keyedId: requestId, amount: reviewerIterResAmount }],
      unit: 'count',
      configurationId: configId,
      version: 1,
    });
    ledgerIdentities.push(taskIterLedgerId);
    reservationIds[taskIterLedgerId] = 'res-task-iter-1';
  }

  if (isReviewer && (options?.runReviewerIterationConsumed !== undefined || options?.runIterationsConsumed !== undefined)) {
    ledgers.push({
      scope: 'run',
      kind: 'iteration',
      limit: options?.runIterationsLimit ?? 5,
      consumed: runReviewerIterationConsumed ?? 0,
      reservations: [{ reservationId: 'res-run-iter-1', keyedId: requestId, amount: 1 }],
      unit: 'count',
      configurationId: configId,
      version: 1,
    });
    ledgerIdentities.push('ledger-run-iter');
    reservationIds['ledger-run-iter'] = 'res-run-iter-1';
    bundleReservations.push({
      ledgerIdentity: 'ledger-run-iter',
      scope: 'run',
      kind: 'iteration',
      configurationId: configId,
      version: 1,
      requestId,
      amount: 1,
    });
  }

  const includeUncertainStoredRequest =
    options?.includeUncertainStoredRequest ?? (options?.requestHistoryStatus === 'uncertain');
  const storedRequests: ProviderRequest[] = [req];
  if (includeUncertainStoredRequest) {
    storedRequests.push({
      ...req,
      providerRequestId: 'req-prior-uncertain',
      dispatchState: 'uncertain',
      uncertainReason: 'Timeout on simulated upstream call',
    });
  }

  const isTelemetryEstimate =
    options?.isTelemetryEstimate ?? (options?.contextProvenance === 'estimate');

  const context: DispatchAdmissionContext = {
    expectedRequest: req,
    storedRequests,
    taskAccountingStatus: options?.taskAccountingStatus ?? 'healthy',
    transactionRef: 'tx-001',
    ledgerIdentities,
    requireRunReviewIteration,
    reservationIds,
    ledgers,
    reservationBundle,
    ...(isTelemetryEstimate ? { isTelemetryEstimate: true } : {}),
  };

  return { context, request: req };
}

/* ============================================================================
 * v0.2 Fixture Helpers (T053 / T054)
 * ============================================================================ */

export function createFixtureExecutorIdentityV02(
  overrides?: Partial<ExecutorIdentityV02>
): ExecutorIdentityV02 {
  return {
    adapterIdentity: 'adapter-fixture-worker',
    processIncarnation: 'proc-fixture-001',
    fencingGeneration: 1,
    payloadDigest: computeCanonicalSha256('fixture-payload'),
    ...overrides,
  };
}

export function createFixturePolicyAuthorityRefV02(
  overrides?: Partial<PolicyAuthorityRefV02>
): PolicyAuthorityRefV02 {
  return {
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    configId: 'config-default',
    configVersion: '1.0.0',
    issuerKeyRef: 'key-authority-001',
    decisionAuthorityGeneration: 1,
    ...overrides,
  };
}

export function createFixturePolicyEvaluationReceiptV02(
  overrides?: Partial<PolicyEvaluationReceiptV02>
): PolicyEvaluationReceiptV02 {
  const auth = createFixturePolicyAuthorityRefV02();
  const receipt = {
    receiptId: 'pe-fixture-001',
    receiptDigest: '',
    actionDigest: computeCanonicalSha256('action-default'),
    freshnessContextDigest: computeCanonicalSha256('freshness-default'),
    policyId: auth.policyId,
    policyVersion: auth.policyVersion,
    configId: auth.configId,
    configVersion: auth.configVersion,
    decisionAuthorityGeneration: auth.decisionAuthorityGeneration,
    result: 'ALLOWED' as const,
    ...overrides,
  };
  return {
    ...receipt,
    receiptDigest: receipt.receiptDigest || computeCanonicalSha256({ ...receipt, receiptDigest: undefined }),
  };
}

export function createFixtureActionDecisionReceiptV02(
  overrides?: Partial<ActionDecisionReceiptV02>
): ActionDecisionReceiptV02 {
  const decision = {
    decisionId: 'ad-fixture-001',
    decisionDigest: '',
    actionDigest: computeCanonicalSha256('action-default'),
    evaluationReceiptRef: 'pe-fixture-001',
    decisionAuthorityGeneration: 1,
    status: 'approved' as const,
    ...overrides,
  };
  return {
    ...decision,
    decisionDigest: decision.decisionDigest || computeCanonicalSha256({ ...decision, decisionDigest: undefined }),
  };
}

export function createFixtureProviderAdmissionReceiptV02(
  overrides?: Partial<ProviderAdmissionReceiptV02>
): ProviderAdmissionReceiptV02 {
  const req = createFixtureProviderRequest();
  const receipt = {
    receiptId: `par-${req.providerRequestId}`,
    receiptDigest: '',
    providerRequestId: req.providerRequestId,
    role: req.role as ProviderRoleV02,
    requestContentDigest: computeRequestContentDigest(req),
    providerId: req.providerId,
    modelId: req.modelId,
    configId: req.configId,
    configVersion: '1.0.0',
    decisionAuthorityGeneration: 1,
    ...overrides,
  };
  return {
    ...receipt,
    receiptDigest: receipt.receiptDigest || computeCanonicalSha256({ ...receipt, receiptDigest: undefined }),
  };
}

export function createFixtureClaimReceiptV02(
  overrides?: Partial<ClaimReceiptV02>
): ClaimReceiptV02 {
  const claim = {
    claimId: 'claim-fixture-001',
    claimDigest: '',
    taskId: 'task-calc-001',
    runId: 'run-001',
    subjectKind: 'repository-action' as const,
    planApplicability: 'approved-plan' as const,
    preClaimTaskStateVersion: 1,
    preClaimControlVersion: 2,
    postClaimControlVersion: 3,
    epoch: 1,
    status: 'claimed' as const,
    reservationRefs: ['res-repair-slot-001'],
    ...overrides,
  };
  return {
    ...claim,
    claimDigest: claim.claimDigest || computeCanonicalSha256({ ...claim, claimDigest: undefined }),
  };
}

export function createFixtureAttemptReceiptV02(
  overrides?: Partial<AttemptReceiptV02>
): AttemptReceiptV02 {
  return {
    attemptId: 'att-fixture-001',
    claimId: 'claim-fixture-001',
    taskId: 'task-calc-001',
    executorIdentity: createFixtureExecutorIdentityV02(),
    preAttemptTaskStateVersion: 1,
    postBeginTaskStateVersion: 1,
    preAttemptControlVersion: 3,
    postBeginControlVersion: 4,
    epoch: 1,
    status: 'attempting' as const,
    ...overrides,
  };
}

export function createFixtureRepositoryAdmissionContextV02(
  overrides?: Partial<Record<string, unknown>>
): RepositoryAdmissionContextV02 {
  const taskId = (overrides?.taskId as string | undefined) ?? 'task-calc-001';
  const runId = (overrides?.runId as string | undefined) ?? 'run-001';
  const canonicalRevision = (overrides?.canonicalRevision as string | undefined) ??
    'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const action = (overrides?.action as NormalizedAction | undefined) ?? {
    actionId: 'act-patch-fixture-001',
    kind: 'apply_patch',
    patchContent: '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,1 +1,2 @@\n+# fix\n',
    targetPaths: ['src/calculator.py'],
    baseRevisionDigest: canonicalRevision,
  };
  const actionDigest = (overrides?.actionDigest as string | undefined) ?? computeActionDigest(action);
  const policyAuthorityRef = (overrides?.policyAuthorityRef as PolicyAuthorityRefV02 | undefined) ??
    createFixturePolicyAuthorityRefV02();
  const policyEvaluationReceipt = (overrides?.policyEvaluationReceipt as PolicyEvaluationReceiptV02 | undefined) ??
    createFixturePolicyEvaluationReceiptV02({ actionDigest, policyId: policyAuthorityRef.policyId });
  const rawContext: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 1,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 2,
    expectedEpoch: 1,
    taskId,
    runId,
    workspaceId: 'workspace-001',
    repositoryId: 'repo-calc',
    runnableNode: 'Repair',
    canonicalRevision,
    executionProfileId: 'profile-docker-isolated',
    action,
    actionDigest,
    policyAuthorityRef,
    policyEvaluationReceipt,
    planBindingDigest: computeCanonicalSha256({ taskId, planVersion: 1 }),
    planDecisionRef: 'dec-plan-001',
    baseRevision: canonicalRevision,
    targetPaths: ['src/calculator.py'],
    patchDigest: computeCanonicalSha256(action.kind === 'apply_patch' ? action.patchContent : ''),
    finiteBounds: {
      maxPatchBytes: 4096,
      maxChangedPaths: 5,
    },
    reservationRefs: ['res-repair-slot-001'],
    ...overrides,
  };
  return {
    ...rawContext,
    admissionDigest: (rawContext.admissionDigest as string | undefined) ?? computeAdmissionDigest(rawContext as unknown as RepositoryAdmissionContextV02),
  } as unknown as RepositoryAdmissionContextV02;
}

export function createFixtureRepositoryCommandAdmissionContextV02(
  overrides?: Partial<Record<string, unknown>>,
): RepositoryAdmissionContextV02 {
  const canonicalRevision = (overrides?.canonicalRevision as string | undefined) ??
    'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const action = (overrides?.action as NormalizedAction | undefined) ?? {
    actionId: 'act-command-fixture-001',
    kind: 'run_command' as const,
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    workingDirectory: 'tests',
    purpose: 'reproduction',
  };
  return createTestRepositoryCommandAdmissionContextV02({
    ...overrides,
    action,
    canonicalRevision,
  });
}

export function createFixtureProviderAdmissionContextV02(
  overrides?: Partial<Record<string, unknown>>
): ProviderAdmissionContextV02 {
  const req = (overrides?.providerRequest as ProviderRequest | undefined) ?? createFixtureProviderRequest();
  const role = ((overrides?.role as ProviderRoleV02 | undefined) ?? req.role) as ProviderRoleV02;
  const requestContentDigest = computeRequestContentDigest(req);
  const providerIdentity = {
    providerId: req.providerId,
    modelId: req.modelId,
    configId: req.configId,
    configVersion: '1.0.0',
    pricingPolicyId: req.pricingPolicyId,
    pricingPolicyVersion: '1.0.0',
    issuerKeyRef: 'key-authority-provider-001',
    decisionAuthorityGeneration: 1,
  };
  const providerAdmissionReceipt = createFixtureProviderAdmissionReceiptV02({
    providerRequestId: req.providerRequestId,
    role,
    requestContentDigest,
    providerId: req.providerId,
    modelId: req.modelId,
    configId: req.configId,
  });
  const rawContext: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'provider-request',
    planApplicability: 'approved-plan',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 1,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 2,
    expectedEpoch: 1,
    taskId: req.taskId,
    runId: req.runId,
    runnableNode: 'Investigate',
    providerRequest: req,
    providerRequestId: req.providerRequestId,
    role,
    requestContentDigest,
    providerIdentity,
    providerAdmissionReceipt,
    requestReservationReceipt: req.reservationRef,
    budgetRefs: [req.reservationRef],
    finiteBounds: {
      maxInputTokens: req.maxInputTokens,
      maxOutputTokens: req.maxOutputTokens,
      maxBillableTokens: req.maxBillableTokens,
      maxCostUsd: req.maxCostUsd,
      ...(role === 'reviewer' ? { maxReviewerIterations: 3 } : {}),
    },
    planBindingDigest: computeCanonicalSha256({ taskId: req.taskId, planVersion: 1 }),
    planDecisionRef: 'dec-plan-001',
    ...overrides,
  };
  return {
    ...rawContext,
    admissionDigest: (rawContext.admissionDigest as string | undefined) ?? computeAdmissionDigest(rawContext as unknown as ProviderAdmissionContextV02),
  } as unknown as ProviderAdmissionContextV02;
}
