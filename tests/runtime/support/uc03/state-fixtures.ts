import {
  type TaskState,
  type FixPlan,
  type AdmissionContextV02,
  type RepositoryAdmissionContextV02,
  type ProviderAdmissionContextV02,
  type RepositoryAdmissionTrustedContextV02,
  type ProviderAdmissionTrustedContextV02,
  type ExecutorIdentityV02,
  type ClaimReceiptV02,
  type AttemptReceiptV02,
  type AttemptOutcomeReceiptV02,
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
  type StateTransitionOptions,
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
    payloadDigest: computeCanonicalSha256('atomic-admission-test-payload'),
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
    contextDigest: computeCanonicalSha256('provider request context'),
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

const TEST_REPOSITORY_REVISION = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function createTestAdmissionPlan(task: BugTask, decisionRef: string): FixPlan {
  const strategy = 'Apply the approved bounded repair';
  return {
    planVersion: 1,
    diagnosis: 'The current implementation needs the approved bounded repair.',
    suspectedCauseLocations: ['src/calculator.py'],
    evidenceRefs: ['baseline-admission-v02'],
    strategy,
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCanonicalSha256(task.requiredChecks),
    baselineRef: task.initialRevisionDigest,
    strategyDigest: computeCanonicalSha256(strategy),
    decisionRef,
  };
}

function testPlanBindingDigest(task: BugTask, plan: FixPlan): string {
  return computeCanonicalSha256({
    taskId: task.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });
}

export function createTestAdmissionTaskStateV02(context: AdmissionContextV02): TaskState {
  const taskId = context.taskId;
  const runId = context.runId;
  const repositoryContext = context.subjectKind === 'repository-action' ? context : undefined;
  const providerContext = context.subjectKind === 'provider-request' ? context : undefined;
  const task = createTestBugTask({
    taskId,
    repositoryId: repositoryContext?.repositoryId ?? 'repo-mock-001',
    initialRevisionDigest: repositoryContext?.canonicalRevision ?? TEST_REPOSITORY_REVISION,
  });
  const planDecisionRef = (repositoryContext?.planApplicability === 'approved-plan' || providerContext?.planApplicability === 'approved-plan')
    ? (repositoryContext?.planDecisionRef ?? providerContext?.planDecisionRef)
    : undefined;
  const plan = planDecisionRef ? createTestAdmissionPlan(task, planDecisionRef) : undefined;
  const node: TaskState['node'] = repositoryContext
    ? repositoryContext.runnableNode as TaskState['node']
    : plan ? 'Repair' : 'Investigate';
  return createTestTaskState({
    stateVersion: context.expectedTaskStateVersion,
    taskId,
    runId,
    workspaceId: repositoryContext?.workspaceId ?? 'workspace-001',
    repositoryId: task.repositoryId,
    repositoryRevisionDigest: task.initialRevisionDigest,
    goal: task.goal,
    observedBehavior: task.observedBehavior,
    expectedBehavior: task.expectedBehavior,
    reproduction: task.reproduction,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: task.constraints,
    requiredCheckIds: task.requiredChecks.map((check) => check.checkId),
    taskContext: task,
    node,
    planVersion: plan?.planVersion ?? 1,
    plan,
    activeDecisionId: plan?.decisionRef,
    evidenceRefs: plan?.evidenceRefs ?? [],
    budgetLedgers: createTestAdmissionLedgers(task.configId),
  });
}

export function createTestAdmissionTransitionContextsV02(
  context: AdmissionContextV02,
  state: TaskState,
): Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>> {
  if (context.subjectKind !== 'repository-action' || context.action.kind !== 'apply_patch' ||
    context.planApplicability !== 'approved-plan' || !state.plan?.decisionRef) return {};
  const decision = context.planDecisionRef;
  const policy = context.policyAuthorityRef;
  const binding = createTestApprovalBinding({
    decisionId: decision,
    actionKind: 'fix_plan',
    normalizedActionDigest: context.planBindingDigest,
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    planVersion: state.plan.planVersion,
    strategyDigest: state.plan.strategyDigest,
    baselineRef: state.plan.baselineRef,
    evidenceRefs: state.plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
    checkSetDigest: state.plan.checkSetDigest,
    status: 'approved',
  });
  const freshness = {
    currentTaskId: binding.taskId,
    currentWorkspaceId: binding.workspaceId,
    currentRepositoryRevisionDigest: binding.repositoryRevisionDigest,
    currentPolicyId: binding.policyId,
    currentPolicyVersion: binding.policyVersion,
    currentNormalizedActionDigest: binding.normalizedActionDigest,
    currentPlanVersion: binding.planVersion,
    currentStrategyDigest: binding.strategyDigest,
    currentBaselineRef: binding.baselineRef,
    currentEvidenceRefs: binding.evidenceRefs,
    currentCriteriaDigest: binding.criteriaDigest,
    currentCheckSetDigest: binding.checkSetDigest,
  };
  return { [state.stateVersion + 1]: { approval: { binding, freshness } } };
}

export function createTestAdmissionLedgers(configId = 'config-uc03-v1'): BudgetLedger[] {
  return [
    ...createTestLedgers(configId),
    {
      scope: 'task',
      kind: 'repair',
      limit: 3,
      consumed: 0,
      reservations: [],
      unit: 'count',
      configurationId: configId,
      version: 1,
    },
  ];
}

export function createTestRepositoryAdmissionContextV02(
  overrides?: Partial<Record<string, unknown>>
): RepositoryAdmissionContextV02 {
  const taskId = (overrides?.taskId as string | undefined) ?? 'task-calc-001';
  const runId = (overrides?.runId as string | undefined) ?? 'run-001';
  const workspaceId = (overrides?.workspaceId as string | undefined) ?? 'workspace-001';
  const repositoryId = (overrides?.repositoryId as string | undefined) ?? 'repo-001';
  const canonicalRevision = (overrides?.canonicalRevision as string | undefined) ?? TEST_REPOSITORY_REVISION;
  const planDecisionRef = (overrides?.planDecisionRef as string | undefined) ?? 'dec-plan-001';
  const bugTask = createTestBugTask({ taskId, repositoryId, initialRevisionDigest: canonicalRevision });
  const plan = createTestAdmissionPlan(bugTask, planDecisionRef);
  const action: NormalizedAction = (overrides?.action as NormalizedAction | undefined) ?? {
    actionId: 'act-patch-001',
    kind: 'apply_patch',
    patchContent: '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,1 +1,2 @@\n+# fix\n',
    targetPaths: ['src/calculator.py'],
    baseRevisionDigest: canonicalRevision,
  };
  const actionDigest = (overrides?.actionDigest as string | undefined) ?? computeActionDigest(action);
  const policyAuthorityRef = {
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    configId: 'config-default',
    configVersion: '1.0.0',
    issuerKeyRef: 'key-authority-001',
    decisionAuthorityGeneration: 3,
  };
  const freshnessContextDigest = computeCanonicalSha256({ taskId, runId, actionDigest, canonicalRevision, policyAuthorityRef });
  const evaluationReceipt = {
    receiptId: 'pe-receipt-001',
    receiptDigest: '',
    actionDigest,
    freshnessContextDigest,
    policyId: policyAuthorityRef.policyId,
    policyVersion: policyAuthorityRef.policyVersion,
    configId: policyAuthorityRef.configId,
    configVersion: policyAuthorityRef.configVersion,
    decisionAuthorityGeneration: policyAuthorityRef.decisionAuthorityGeneration,
    result: 'ALLOWED' as const,
  };
  evaluationReceipt.receiptDigest = computeCanonicalSha256({ ...evaluationReceipt, receiptDigest: undefined });
  const context: Record<string, unknown> = {
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
    workspaceId,
    repositoryId,
    runnableNode: 'Repair',
    canonicalRevision,
    executionProfileId: 'profile-docker-isolated',
    action,
    actionDigest,
    policyAuthorityRef,
    policyEvaluationReceipt: evaluationReceipt,
    planBindingDigest: testPlanBindingDigest(bugTask, plan),
    planDecisionRef,
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
  return context as unknown as RepositoryAdmissionContextV02;
}

export function createTestProviderAdmissionContextV02(
  overrides?: Partial<Record<string, unknown>>
): ProviderAdmissionContextV02 {
  const requestOverrides = overrides?.providerRequest as Partial<ProviderRequest> | undefined;
  const providerRequest: ProviderRequest = createTestProviderRequest({
    ...(requestOverrides ?? {}),
    taskId: (overrides?.taskId as string | undefined) ?? requestOverrides?.taskId ?? 'task-calc-001',
    runId: (overrides?.runId as string | undefined) ?? requestOverrides?.runId ?? 'run-001',
  });
  const requestContentDigest = computeRequestContentDigest(providerRequest);
  const role = providerRequest.role;
  const bugTask = createTestBugTask({ taskId: providerRequest.taskId });
  const planDecisionRef = (overrides?.planDecisionRef as string | undefined) ?? 'dec-plan-001';
  const plan = createTestAdmissionPlan(bugTask, planDecisionRef);
  const budgetRefs = (overrides?.budgetRefs as readonly string[] | undefined) ?? [
    `${providerRequest.providerRequestId}-tokens`,
    `${providerRequest.providerRequestId}-cost`,
  ];
  const providerIdentity = {
    providerId: providerRequest.providerId,
    modelId: providerRequest.modelId,
    configId: providerRequest.configId,
    configVersion: '1.0.0',
    pricingPolicyId: providerRequest.pricingPolicyId,
    pricingPolicyVersion: '1.0.0',
    issuerKeyRef: 'key-authority-provider-001',
    decisionAuthorityGeneration: 2,
  };
  const providerAdmissionReceipt = {
    receiptId: `par-${providerRequest.providerRequestId}`,
    receiptDigest: '',
    providerRequestId: providerRequest.providerRequestId,
    role,
    requestContentDigest,
    providerId: providerIdentity.providerId,
    modelId: providerIdentity.modelId,
    configId: providerIdentity.configId,
    configVersion: providerIdentity.configVersion,
    decisionAuthorityGeneration: providerIdentity.decisionAuthorityGeneration,
  };
  providerAdmissionReceipt.receiptDigest = computeCanonicalSha256({ ...providerAdmissionReceipt, receiptDigest: undefined });
  const context: Record<string, unknown> = {
    schemaVersion: '0.2.0',
    subjectKind: 'provider-request',
    planApplicability: 'approved-plan',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 1,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 2,
    expectedEpoch: 1,
    taskId: providerRequest.taskId,
    runId: providerRequest.runId,
    providerRequest,
    providerRequestId: providerRequest.providerRequestId,
    role,
    requestContentDigest,
    providerIdentity,
    providerAdmissionReceipt,
    requestReservationReceipt: providerRequest.reservationRef,
    budgetRefs,
    finiteBounds: {
      maxInputTokens: providerRequest.maxInputTokens,
      maxOutputTokens: providerRequest.maxOutputTokens,
      maxCostUsd: providerRequest.maxCostUsd,
      ...(role === 'reviewer' ? { maxReviewerIterations: 3 } : {}),
    },
    planBindingDigest: testPlanBindingDigest(bugTask, plan),
    planDecisionRef,
    ...overrides,
  };
  return context as unknown as ProviderAdmissionContextV02;
}

export function createTestRepositoryAdmissionTrustedContextV02(
  context: RepositoryAdmissionContextV02,
): RepositoryAdmissionTrustedContextV02 {
  return {
    subjectKind: 'repository-action',
    taskStateSchemaVersion: context.taskStateSchemaVersion,
    expectedTaskStateVersion: context.expectedTaskStateVersion,
    controlSchemaVersion: context.controlSchemaVersion,
    expectedControlVersion: context.expectedControlVersion,
    expectedEpoch: context.expectedEpoch,
    taskId: context.taskId,
    runId: context.runId,
    workspaceId: context.workspaceId,
    repositoryId: context.repositoryId,
    runnableNode: context.runnableNode,
    canonicalRevision: context.canonicalRevision,
    executionProfileId: context.executionProfileId,
    planApplicability: context.planApplicability,
    planBindingDigest: context.planApplicability === 'approved-plan' ? context.planBindingDigest : undefined,
    planDecisionRef: context.planApplicability === 'approved-plan' ? context.planDecisionRef : undefined,
    policyAuthorityRef: context.policyAuthorityRef,
    policyEvaluationReceiptRef: context.policyEvaluationReceipt.receiptId,
    policyEvaluationReceiptDigest: context.policyEvaluationReceipt.receiptDigest,
    freshnessContextDigest: context.policyEvaluationReceipt.freshnessContextDigest,
    executionProfile: {
      isolationProfileRef: context.executionProfileId,
      exclusionsPolicyVersion: 'exclusions-v1',
      scratchIdentity: 'scratch-admission-v02',
      commandBounds: {
        timeoutMs: 30_000,
        maxOutputBytes: 1_048_576,
        maxCpuSeconds: 120,
        maxMemoryBytes: 536_870_912,
        maxProcessCount: 64,
      },
      patchBounds: {
        maxPatchBytes: 4096,
        maxChangedPaths: 5,
      },
    },
    allowedDiagnosticChecks: [],
    allowedDiagnosticTestPaths: [],
  };
}

export function createTestProviderAdmissionTrustedContextV02(
  context: ProviderAdmissionContextV02,
): ProviderAdmissionTrustedContextV02 {
  return {
    subjectKind: 'provider-request',
    taskId: context.taskId,
    runId: context.runId,
    role: context.role,
    providerRequestId: context.providerRequestId,
    requestContentDigest: context.requestContentDigest,
    providerAdmissionReceiptRef: context.providerAdmissionReceipt.receiptId,
    providerAdmissionReceiptDigest: context.providerAdmissionReceipt.receiptDigest,
    budgetRefs: context.budgetRefs,
    providerIdentity: context.providerIdentity,
  };
}

export function createTestClaimReceiptV02(
  overrides?: Partial<ClaimReceiptV02>
): ClaimReceiptV02 {
  const raw: ClaimReceiptV02 = {
    claimId: 'claim-001',
    claimDigest: '',
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
  return { ...raw, claimDigest: computeCanonicalSha256({ ...raw, claimDigest: undefined }) };
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
    postBeginTaskStateVersion: 2,
    preAttemptControlVersion: 3,
    postBeginControlVersion: 4,
    epoch: 1,
    status: 'attempting',
    ...overrides,
  };
}

export function createTestClaimClosureReceiptV02(
  claim?: ClaimReceiptV02,
  executorIdentity: ExecutorIdentityV02 = createTestExecutorIdentityV02(),
  overrides?: Partial<ClaimClosureReceiptV02>
): ClaimClosureReceiptV02 {
  const raw = {
    receiptId: 'closure-001',
    receiptDigest: 'sha256:placeholder',
    claimId: claim?.claimId ?? 'claim-001',
    taskId: claim?.taskId ?? 'task-calc-001',
    reason: 'worker cancelled before attempt dispatch',
    fencedExecutorIdentity: executorIdentity,
    unconsumedReservations: claim?.reservationRefs ?? ['res-repair-slot-001'],
    ...overrides,
  };
  return {
    ...raw,
    receiptDigest: computeClaimClosureDigest(raw),
  };
}

export function createTestRepositoryOutcomeReceiptV02(
  claim: ClaimReceiptV02,
  attempt: AttemptReceiptV02,
  context: RepositoryAdmissionContextV02,
  overrides?: Partial<RepositoryActionOutcomeReceiptV02>
): RepositoryActionOutcomeReceiptV02 {
  const outcome = overrides?.outcome ?? 'observed';
  const raw: Record<string, unknown> = {
    receiptId: 'repo-out-001',
    receiptDigest: 'sha256:placeholder',
    claimId: claim.claimId,
    attemptId: attempt.attemptId,
    subjectKind: 'repository-action',
    planApplicability: context.planApplicability,
    actionDigest: context.actionDigest,
    outcome,
    ...(outcome === 'observed' && context.action.kind === 'apply_patch'
      ? { observedResultRevisionDigest: computeCanonicalSha256({ baseRevision: context.canonicalRevision, actionDigest: context.actionDigest }) }
      : {}),
    ...(context.planApplicability === 'approved-plan'
      ? { planBindingDigest: context.planBindingDigest, planDecisionRef: context.planDecisionRef }
      : {}),
    ...overrides,
  };
  return {
    ...raw,
    receiptDigest: computeAttemptOutcomeDigest(raw),
  } as unknown as RepositoryActionOutcomeReceiptV02;
}

export function createTestProviderOutcomeReceiptV02(
  claim: ClaimReceiptV02,
  attempt: AttemptReceiptV02,
  context: ProviderAdmissionContextV02,
  overrides?: Partial<ProviderRequestOutcomeReceiptV02>
): ProviderRequestOutcomeReceiptV02 {
  const raw: Record<string, unknown> = {
    receiptId: 'prov-out-001',
    receiptDigest: 'sha256:placeholder',
    claimId: claim.claimId,
    attemptId: attempt.attemptId,
    subjectKind: 'provider-request',
    planApplicability: context.planApplicability,
    providerRequestId: context.providerRequestId,
    requestContentDigest: context.requestContentDigest,
    role: context.role,
    outcome: 'observed',
    observedUsage: createTestProviderUsage({ inputTokens: 100, outputTokens: 20, billableTokens: 120, costUsd: 0.003 }),
    providerAdmissionReceiptRef: context.providerAdmissionReceipt.receiptId,
    budgetRefs: [...context.budgetRefs],
    ...(context.planApplicability === 'approved-plan'
      ? { planBindingDigest: context.planBindingDigest, planDecisionRef: context.planDecisionRef }
      : {}),
    ...overrides,
  };
  return {
    ...raw,
    receiptDigest: computeAttemptOutcomeDigest(raw),
  } as unknown as ProviderRequestOutcomeReceiptV02;
}

export function createTestUncertainReconciliationReceiptV02(
  predecessor: AttemptOutcomeReceiptV02,
  overrides?: Partial<UncertainAttemptReconciliationReceiptV02>
): UncertainAttemptReconciliationReceiptV02 {
  if (predecessor.outcome !== 'uncertain') throw new Error('Uncertain reconciliation requires a recorded uncertain outcome receipt');
  const raw: Record<string, unknown> = {
    reconciliationId: 'recon-001',
    reconciliationDigest: 'sha256:placeholder',
    reconciliationKind: 'uncertain-attempt',
    predecessorReceiptId: predecessor.receiptId,
    predecessorReceiptDigest: predecessor.receiptDigest,
    claimId: predecessor.claimId,
    attemptId: predecessor.attemptId,
    subjectKind: predecessor.subjectKind,
    planApplicability: predecessor.planApplicability,
    disposition: 'observed-and-accounted',
    ...overrides,
  };
  return {
    ...raw,
    reconciliationDigest: computeReconciliationDigest(raw),
  } as unknown as UncertainAttemptReconciliationReceiptV02;
}

export function createTestObservedReconciliationReceiptV02(
  predecessor: AttemptOutcomeReceiptV02,
  overrides?: Partial<ObservedOutcomeReconciliationReceiptV02>
): ObservedOutcomeReconciliationReceiptV02 {
  if (predecessor.outcome !== 'observed') throw new Error('Observed reconciliation requires a recorded observed outcome receipt');
  const raw: Record<string, unknown> = {
    reconciliationId: 'recon-002',
    reconciliationDigest: 'sha256:placeholder',
    reconciliationKind: 'observed-unsettled',
    predecessorReceiptId: predecessor.receiptId,
    predecessorReceiptDigest: predecessor.receiptDigest,
    claimId: predecessor.claimId,
    attemptId: predecessor.attemptId,
    subjectKind: predecessor.subjectKind,
    planApplicability: predecessor.planApplicability,
    ...overrides,
  };
  return {
    ...raw,
    reconciliationDigest: computeReconciliationDigest(raw),
  } as unknown as ObservedOutcomeReconciliationReceiptV02;
}
