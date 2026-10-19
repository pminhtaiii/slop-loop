import {
  type TaskState,
  type BugTask,
  type BudgetLedger,
  type ApprovalBinding,
  type RunCommandAction,
  type ProviderUsage,
  CONTRACT_VERSION,
  computeCanonicalSha256,
} from '../../../../src/contracts/foundation/uc03.ts';

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
