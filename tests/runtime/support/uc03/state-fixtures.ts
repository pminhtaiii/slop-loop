import {
  type TaskState,
  type ExecutorIdentityV02,
  type RepositoryAdmissionContextV02,
  type ProviderAdmissionContextV02,
  type ClaimReceiptV02,
  type AttemptReceiptV02,
  type ClaimClosureReceiptV02,
  type RepositoryActionOutcomeReceiptV02,
  type ProviderRequestOutcomeReceiptV02,
  type UncertainAttemptReconciliationReceiptV02,
  type ObservedOutcomeReconciliationReceiptV02,
  type NormalizedAction,
  type ProviderRequest,
  computeActionDigest,
  computeClaimClosureDigest,
  computeAttemptOutcomeDigest,
  computeReconciliationDigest,
  type BugTask,
  type BudgetLedger,
  type ApprovalBinding,
  type RunCommandAction,
  type ProviderUsage,
  CONTRACT_VERSION,
  computeCanonicalSha256,
} from '../../../../src/contracts/foundation/uc03.ts';
import { computeRequestContentDigest } from '../../../../src/contracts/foundation/uc03/admission-v02.ts';
export function createTestBugTask(overrides?: Partial<BugTask>): BugTask {
  return {
    taskId: 'task-uc03-test-001',
    repositoryId: 'repo-mock-001',
    initialRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    goal: 'Fix off-by-one error in calculator parser',
    observedBehavior: 'Calculator throws index out of range on trailing operator',
    expectedBehavior: 'Calculator returns syntax error on trailing operator',
    reproduction: 'pytest tests/test_calculator.py -k test_trailing_operator',
    acceptanceCriteria: ['Trailing operator emits syntax error', 'All existing tests pass'],
    constraints: ['Do not change public API signature', 'Maintain single-threaded execution'],
    requiredChecks: [
      {
        checkId: 'check-pytest-repro',
        executable: 'pytest',
        argv: ['-q', 'tests/test_calculator.py'],
        purpose: 'reproduction',
      },
    ],
    limits: {
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
      maxCpuCores: 2,
      maxMemoryBytes: 2147483648,
      maxPids: 64,
    },
    budgetLimits: {
      maxReplanCount: 3,
      maxTokens: 500000,
      maxCostUsd: 10.0,
      maxRepairAttempts: 3,
      maxReviewIterations: 3,
    },
    configId: 'config-uc03-v1',
    configVersion: '1.0.0',
    ...overrides,
  };
}

export function createTestLedgers(configId = 'config-uc03-v1'): BudgetLedger[] {
  return [
    {
      scope: 'task',
      kind: 'tokens',
      limit: 100000,
      consumed: 0,
      reservations: [],
      unit: 'count',
      configurationId: configId,
      version: 1,
    },
    {
      scope: 'task',
      kind: 'cost',
      limit: 5.0,
      consumed: 0,
      reservations: [],
      unit: 'usd',
      configurationId: configId,
      version: 1,
    },
    {
      scope: 'run',
      kind: 'tokens',
      limit: 50000,
      consumed: 0,
      reservations: [],
      unit: 'count',
      configurationId: configId,
      version: 1,
    },
    {
      scope: 'run',
      kind: 'cost',
      limit: 2.0,
      consumed: 0,
      reservations: [],
      unit: 'usd',
      configurationId: configId,
      version: 1,
    },
    {
      scope: 'task',
      kind: 'replan',
      limit: 3,
      consumed: 0,
      reservations: [],
      unit: 'count',
      configurationId: configId,
      version: 1,
    },
    {
      scope: 'task',
      kind: 'iteration',
      limit: 5,
      consumed: 0,
      reservations: [],
      unit: 'count',
      configurationId: configId,
      version: 1,
    },
  ];
}

export function createTestTaskState(overrides?: Partial<TaskState>): TaskState {
  const bugTask = createTestBugTask();
  return {
    schemaVersion: CONTRACT_VERSION,
    stateVersion: 1,
    taskId: bugTask.taskId,
    runId: 'run-mock-001',
    workspaceId: 'ws-mock-001',
    repositoryId: bugTask.repositoryId,
    repositoryRevisionDigest: bugTask.initialRevisionDigest,
    goal: bugTask.goal,
    observedBehavior: bugTask.observedBehavior,
    expectedBehavior: bugTask.expectedBehavior,
    reproduction: bugTask.reproduction,
    acceptanceCriteria: bugTask.acceptanceCriteria,
    constraints: bugTask.constraints,
    requiredCheckIds: ['check-pytest-repro'],
    taskContext: bugTask,
    node: 'Validate',
    planVersion: 1,
    replanCount: 0,
    changedPaths: [],
    evidenceRefs: [],
    budgetLedgers: createTestLedgers(),
    risks: [],
    nextAction: 'Validate bug context and reproduction',
    ...overrides,
  };
}

export function createTestAction(overrides?: Partial<RunCommandAction>): RunCommandAction {
  return {
    actionId: 'act-run-001',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    workingDirectory: 'workspace/repo',
    purpose: 'Run reproduction test',
    ...overrides,
  };
}

export function createTestApprovalBinding(overrides?: Partial<ApprovalBinding>): ApprovalBinding {
  const action = createTestAction();
  return {
    decisionId: 'dec-mock-001',
    actionKind: 'action',
    normalizedActionDigest: computeCanonicalSha256(action),
    taskId: 'task-uc03-test-001',
    workspaceId: 'ws-mock-001',
    repositoryRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policyId: 'policy-default-v1',
    policyVersion: '1.0.0',
    status: 'pending',
    reason: 'Initial command execution requires human approval',
    ...overrides,
  };
}

export function createTestProviderUsage(overrides?: Partial<ProviderUsage>): ProviderUsage {
  return {
    inputTokens: 1000,
    outputTokens: 250,
    costUsd: 0.025,
    billableTokens: 1250,
    ...overrides,
  };
}

export function createTestExecutorIdentityV02(
  overrides?: Partial<ExecutorIdentityV02>
): ExecutorIdentityV02 {
  return {
    adapterIdentity: 'adapter-worker-01',
    processIncarnation: 'proc-100',
    fencingGeneration: 1,
    payloadDigest: 'sha256:payload00000000000000000000000000000000000000000000000000000000',
    ...overrides,
  };
}

export function createTestProviderRequest(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    providerRequestId: 'req-prov-001',
    taskId: 'task-calc-001',
    runId: 'run-001',
    role: 'coder',
    purpose: 'generate_repair',
    providerId: 'provider-test',
    modelId: 'model-test-01',
    configId: 'config-coder-v1',
    pricingPolicyId: 'pricing-standard-v1',
    contextDigest: 'sha256:ctxdigest000000000000000000000000000000000000000000000000000000000',
    timeoutMs: 60000,
    maxInputTokens: 8000,
    maxOutputTokens: 2000,
    maxBillableTokens: 10000,
    maxCostUsd: 0.5,
    reservationRef: 'res-req-prov-001',
    dispatchState: 'reserved',
    ...overrides,
  };
}

export function createTestRepositoryAdmissionContextV02(
  overrides?: Partial<Record<string, unknown>>
): RepositoryAdmissionContextV02 {
  const action: NormalizedAction = (overrides?.action as NormalizedAction | undefined) ?? {
    actionId: 'act-patch-001',
    kind: 'apply_patch',
    patchContent: '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,1 +1,2 @@\n+# fix\n',
    targetPaths: ['src/calculator.py'],
    baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  const actionDigest = (overrides?.actionDigest as string | undefined) ?? computeActionDigest(action);
  const context: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 1,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 2,
    expectedEpoch: 1,
    taskId: 'task-calc-001',
    runId: 'run-001',
    workspaceId: 'workspace-001',
    repositoryId: 'repo-001',
    runnableNode: 'Repair',
    canonicalRevision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    executionProfileId: 'profile-docker-isolated',
    action,
    actionDigest,
    policyAuthorityRef: {
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      issuerKeyRef: 'key-authority-001',
      decisionAuthorityGeneration: 3,
    },
    policyEvaluationReceipt: {
      receiptId: 'pe-receipt-001',
      receiptDigest: 'sha256:pereceiptdigest00000000000000000000000000000000000000000000000000',
      actionDigest,
      freshnessContextDigest: 'sha256:freshness00000000000000000000000000000000000000000000000000',
      policyId: 'policy-default',
      policyVersion: '1.0.0',
      configId: 'config-default',
      configVersion: '1.0.0',
      decisionAuthorityGeneration: 3,
      result: 'ALLOWED',
    },
    planBindingDigest: 'sha256:planbindingdigest00000000000000000000000000000000000000000000000',
    planDecisionRef: 'dec-plan-001',
    baseRevision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    targetPaths: ['src/calculator.py'],
    patchDigest: computeCanonicalSha256(action.kind === 'apply_patch' ? action.patchContent : ''),
    finiteBounds: {
      maxPatchBytes: 4096,
      maxChangedPaths: 5,
    },
    reservationRefs: ['res-repair-slot-001'],
    ...overrides,
  };
  return context as unknown as RepositoryAdmissionContextV02;
}

export function createTestProviderAdmissionContextV02(
  overrides?: Partial<Record<string, unknown>>
): ProviderAdmissionContextV02 {
  const providerRequest: ProviderRequest = (overrides?.providerRequest as ProviderRequest | undefined) ?? createTestProviderRequest();
  const requestContentDigest = (overrides?.requestContentDigest as string | undefined) ?? computeRequestContentDigest(providerRequest);
  const context: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'provider-request',
    planApplicability: 'approved-plan',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 1,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 2,
    expectedEpoch: 1,
    taskId: 'task-calc-001',
    runId: 'run-001',
    providerRequest,
    providerRequestId: providerRequest.providerRequestId,
    role: 'coder',
    requestContentDigest,
    providerIdentity: {
      providerId: 'provider-test',
      modelId: 'model-test-01',
      configId: 'config-coder-v1',
      configVersion: '1.0.0',
      pricingPolicyId: 'pricing-standard-v1',
      pricingPolicyVersion: '1.0.0',
      issuerKeyRef: 'key-authority-001',
      decisionAuthorityGeneration: 2,
    },
    providerAdmissionReceipt: {
      receiptId: 'par-001',
      receiptDigest: 'sha256:pardigest00000000000000000000000000000000000000000000000000000000',
      providerRequestId: providerRequest.providerRequestId,
      role: 'coder',
      requestContentDigest,
      providerId: 'provider-test',
      modelId: 'model-test-01',
      configId: 'config-coder-v1',
      configVersion: '1.0.0',
      decisionAuthorityGeneration: 2,
    },
    requestReservationReceipt: 'res-bundle-001',
    budgetRefs: ['res-tokens-001', 'res-cost-001'],
    finiteBounds: {
      maxInputTokens: 10000,
      maxOutputTokens: 2000,
      maxCostUsd: 1.0,
    },
    planBindingDigest: 'sha256:planbindingdigest00000000000000000000000000000000000000000000000',
    planDecisionRef: 'dec-plan-001',
    ...overrides,
  };
  return context as unknown as ProviderAdmissionContextV02;
}

export function createTestClaimReceiptV02(
  overrides?: Partial<ClaimReceiptV02>
): ClaimReceiptV02 {
  return {
    claimId: 'claim-001',
    claimDigest: 'sha256:claimdigest00000000000000000000000000000000000000000000000000000',
    taskId: 'task-calc-001',
    runId: 'run-001',
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    preClaimTaskStateVersion: 1,
    preClaimControlVersion: 2,
    postClaimControlVersion: 3,
    epoch: 1,
    status: 'claimed',
    reservationRefs: ['res-repair-slot-001'],
    ...overrides,
  };
}

export function createTestAttemptReceiptV02(
  overrides?: Partial<AttemptReceiptV02>
): AttemptReceiptV02 {
  return {
    attemptId: 'att-001',
    claimId: 'claim-001',
    taskId: 'task-calc-001',
    executorIdentity: createTestExecutorIdentityV02(),
    preAttemptTaskStateVersion: 1,
    postBeginTaskStateVersion: 1,
    preAttemptControlVersion: 2,
    postBeginControlVersion: 3,
    epoch: 1,
    status: 'attempting',
    ...overrides,
  };
}

export function createTestClaimClosureReceiptV02(
  overrides?: Partial<ClaimClosureReceiptV02>
): ClaimClosureReceiptV02 {
  const raw = {
    receiptId: 'closure-001',
    receiptDigest: 'sha256:placeholder',
    claimId: 'claim-001',
    taskId: 'task-calc-001',
    reason: 'worker cancelled before attempt dispatch',
    fencedExecutorIdentity: createTestExecutorIdentityV02(),
    unconsumedReservations: ['res-repair-slot-001'],
    ...overrides,
  };
  return {
    ...raw,
    receiptDigest: computeClaimClosureDigest(raw),
  };
}

export function createTestRepositoryOutcomeReceiptV02(
  overrides?: Partial<RepositoryActionOutcomeReceiptV02>
): RepositoryActionOutcomeReceiptV02 {
  const raw: Record<string, unknown> = {
    receiptId: 'repo-out-001',
    receiptDigest: 'sha256:placeholder',
    claimId: 'claim-001',
    attemptId: 'att-001',
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    actionDigest: 'sha256:act00000000000000000000000000000000000000000000000000000000000000',
    outcome: 'observed',
    planBindingDigest: 'sha256:binding000000000000000000000000000000000000000000000000000000',
    planDecisionRef: 'dec-001',
    ...overrides,
  };
  return {
    ...raw,
    receiptDigest: computeAttemptOutcomeDigest(raw),
  } as unknown as RepositoryActionOutcomeReceiptV02;
}

export function createTestProviderOutcomeReceiptV02(
  overrides?: Partial<ProviderRequestOutcomeReceiptV02>
): ProviderRequestOutcomeReceiptV02 {
  const raw: Record<string, unknown> = {
    receiptId: 'prov-out-001',
    receiptDigest: 'sha256:placeholder',
    claimId: 'claim-001',
    attemptId: 'att-001',
    subjectKind: 'provider-request',
    planApplicability: 'approved-plan',
    providerRequestId: 'req-prov-001',
    requestContentDigest: 'sha256:reqcontent000000000000000000000000000000000000000000000000000',
    role: 'coder',
    outcome: 'observed',
    planBindingDigest: 'sha256:binding000000000000000000000000000000000000000000000000000000',
    planDecisionRef: 'dec-001',
    ...overrides,
  };
  return {
    ...raw,
    receiptDigest: computeAttemptOutcomeDigest(raw),
  } as unknown as ProviderRequestOutcomeReceiptV02;
}

export function createTestUncertainReconciliationReceiptV02(
  overrides?: Partial<UncertainAttemptReconciliationReceiptV02>
): UncertainAttemptReconciliationReceiptV02 {
  const raw: Record<string, unknown> = {
    reconciliationId: 'recon-001',
    reconciliationDigest: 'sha256:placeholder',
    reconciliationKind: 'uncertain-attempt',
    predecessorReceiptId: 'repo-out-001',
    claimId: 'claim-001',
    attemptId: 'att-001',
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    disposition: 'observed-and-accounted',
    ...overrides,
  };
  return {
    ...raw,
    reconciliationDigest: computeReconciliationDigest(raw),
  } as unknown as UncertainAttemptReconciliationReceiptV02;
}

export function createTestObservedReconciliationReceiptV02(
  overrides?: Partial<ObservedOutcomeReconciliationReceiptV02>
): ObservedOutcomeReconciliationReceiptV02 {
  const raw: Record<string, unknown> = {
    reconciliationId: 'recon-002',
    reconciliationDigest: 'sha256:placeholder',
    reconciliationKind: 'observed-unsettled',
    predecessorReceiptId: 'repo-out-001',
    claimId: 'claim-001',
    attemptId: 'att-001',
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    ...overrides,
  };
  return {
    ...raw,
    reconciliationDigest: computeReconciliationDigest(raw),
  } as unknown as ObservedOutcomeReconciliationReceiptV02;
}
