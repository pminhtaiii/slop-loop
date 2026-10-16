import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBugTask,
  validateProviderUsage,
  validateProviderRequest,
  validateReservationBundle,
  validateModelProposal,
  validateModelResult,
  validateDispatchAdmission,
  isAdmittedForDispatch,
  BudgetExhaustionError,
  BudgetConflictError,
  type ProviderUsage,
  type ProviderRequest,
  type ModelProposal,
  type ModelResult,
  type ProviderRequestValidationContext,
  type DispatchAdmissionContext,
  type ReservationBundle,
  type ReservationBundleItem,
  type ModelPortResult,
  validateExecutionLimits,
  validateBudgetLimits,
  validateNormalizedAction,
  validateApprovalBinding,
  validateCommandView,
  validateCheckDefinition,
  canonicalJsonStringify,
  computeCanonicalSha256,
  computeActionDigest,
  computeCommandViewDigest,
  isCanonicalRelativePath,
  isProtectedPath,
  type ApprovalBindingContext,
  type CommandViewValidationContext,
  validateTaskEnvelope,
  validateTaskNode,
  validateTaskOutcome,
  validateEnvelopeOutcome,
  validatePlanStep,
  validateFixPlan,
  validateBudgetLedger,
  validateTaskState,
  validateStateTransition,
  type ValidationError,
  type BugTask,
  type CheckDefinition,
  type ExecutionLimits,
  type BudgetLimits,
  type RunCommandAction,
  type ApplyPatchAction,
  type ApproveFixPlanAction,
  type ApprovalBinding,
  type CommandView,
  type TaskEnvelope,
  type TaskNode,
  type TaskOutcome,
  type EnvelopeOutcome,
  type PlanStep,
  type FixPlan,
  type BudgetLedger,
  type TaskState,
} from '../../../src/contracts/uc03.js';

function createValidCheck(): CheckDefinition {
  return {
    checkId: 'check-pytest-focused',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    purpose: 'focused',
    workingDirectory: '/workspace/repo',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };
}

function createValidLimits(): ExecutionLimits {
  return {
    timeoutMs: 60000,
    maxOutputBytes: 2097152,
    maxCpuCores: 2,
    maxMemoryBytes: 2147483648,
    maxPids: 64,
  };
}

function createValidBudgetLimits(): BudgetLimits {
  return {
    maxReplanCount: 3,
    maxTokens: 100000,
    maxCostUsd: 5.0,
    maxRepairAttempts: 2,
    maxReviewIterations: 2,
  };
}

function createValidBugTask(): BugTask {
  return {
    taskId: 'task-uc03-calc-001',
    repositoryId: 'repo-python-calc',
    initialRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    goal: 'Fix ZeroDivisionError when dividing by zero in Calculator.divide',
    observedBehavior: 'Calling Calculator.divide(10, 0) raises unhandled ZeroDivisionError',
    expectedBehavior: 'Calling Calculator.divide(10, 0) raises custom CalculationError with clear message',
    reproduction: 'python -m pytest tests/test_calculator.py -k test_divide_zero',
    acceptanceCriteria: [
      'Calculator.divide(x, 0) raises CalculationError',
      'Existing arithmetic operations remain unchanged',
    ],
    constraints: [
      'Do not modify external public API signatures',
      'No third-party math dependencies',
    ],
    requiredChecks: [createValidCheck()],
    limits: createValidLimits(),
    budgetLimits: createValidBudgetLimits(),
    configId: 'config-uc03-v1',
    configVersion: '1.0.0',
  };
}

test('BugTask validation: accepts a valid complete BugTask', (): void => {
  const task = createValidBugTask();
  const result = validateBugTask(task);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.taskId, 'task-uc03-calc-001');
    assert.equal(result.value.repositoryId, 'repo-python-calc');
    assert.equal(result.value.requiredChecks.length, 1);
  }
});

test('BugTask validation: rejects non-object inputs', (): void => {
  const inputs = [null, undefined, 42, 'string', true, []];
  for (const input of inputs) {
    const result = validateBugTask(input);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length > 0);
    }
  }
});

test('BugTask validation: rejects missing or empty mandatory string fields', (): void => {
  const fields: readonly (keyof BugTask)[] = [
    'taskId',
    'repositoryId',
    'initialRevisionDigest',
    'goal',
    'observedBehavior',
    'expectedBehavior',
    'reproduction',
  ];

  for (const field of fields) {
    const base = Object.fromEntries(
      Object.entries(createValidBugTask()).filter(([k]) => k !== field)
    );
    const missingRes = validateBugTask(base);
    assert.equal(missingRes.ok, false, `Expected missing ${field} to fail`);

    const empty = { ...createValidBugTask(), [field]: '   ' };
    const emptyRes = validateBugTask(empty);
    assert.equal(emptyRes.ok, false, `Expected empty ${field} to fail`);
  }
});

test('BugTask validation: rejects empty acceptanceCriteria', (): void => {
  const base = { ...createValidBugTask(), acceptanceCriteria: [] };
  const res = validateBugTask(base);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.path === 'acceptanceCriteria'));
  }
});

test('BugTask validation: rejects empty requiredChecks', (): void => {
  const base = { ...createValidBugTask(), requiredChecks: [] };
  const res = validateBugTask(base);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.path === 'requiredChecks'));
  }
});

test('BugTask validation: rejects malformed requiredChecks', (): void => {
  const badCheck = {
    checkId: 'check-1',
    executable: '', // empty executable
    argv: 'not-an-array',
    purpose: 'invalid-purpose',
  };
  const base = { ...createValidBugTask(), requiredChecks: [badCheck as unknown as CheckDefinition] };
  const res = validateBugTask(base);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.path.startsWith('requiredChecks[0]')));
  }
});

/* ------------------------------------------------------------------
 * Execution & Budget Limits Conformance Tests
 * ------------------------------------------------------------------ */

test('ExecutionLimits validation: accepts valid execution limits', (): void => {
  const limits: ExecutionLimits = {
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
    maxCpuCores: 4,
    maxMemoryBytes: 4294967296,
    maxPids: 128,
  };
  const res = validateExecutionLimits(limits);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.timeoutMs, 30000);
    assert.equal(res.value.maxOutputBytes, 1048576);
    assert.equal(res.value.maxCpuCores, 4);
    assert.equal(res.value.maxMemoryBytes, 4294967296);
    assert.equal(res.value.maxPids, 128);
  }
});

test('ExecutionLimits validation: rejects execution limits when mandatory CPU, memory, or PIDs are missing', (): void => {
  const limits = {
    timeoutMs: 10000,
    maxOutputBytes: 65536,
  };
  const res = validateExecutionLimits(limits);
  assert.equal(res.ok, false);
});

test('ExecutionLimits validation: rejects non-object, missing, zero, negative, or float limits', (): void => {
  assert.equal(validateExecutionLimits(null).ok, false);
  assert.equal(validateExecutionLimits({}).ok, false);

  // zero or negative timeoutMs
  assert.equal(validateExecutionLimits({ timeoutMs: 0, maxOutputBytes: 1000 }).ok, false);
  assert.equal(validateExecutionLimits({ timeoutMs: -100, maxOutputBytes: 1000 }).ok, false);

  // zero or negative maxOutputBytes
  assert.equal(validateExecutionLimits({ timeoutMs: 1000, maxOutputBytes: 0 }).ok, false);
  assert.equal(validateExecutionLimits({ timeoutMs: 1000, maxOutputBytes: -5 }).ok, false);

  // non-integer timeoutMs or maxOutputBytes
  assert.equal(validateExecutionLimits({ timeoutMs: 12.34, maxOutputBytes: 1000 }).ok, false);
  assert.equal(validateExecutionLimits({ timeoutMs: 1000, maxOutputBytes: 55.5 }).ok, false);

  // NaN or Infinity
  assert.equal(validateExecutionLimits({ timeoutMs: Number.NaN, maxOutputBytes: 1000 }).ok, false);
  assert.equal(validateExecutionLimits({ timeoutMs: Number.POSITIVE_INFINITY, maxOutputBytes: 1000 }).ok, false);

  // invalid optional fields
  assert.equal(validateExecutionLimits({ timeoutMs: 1000, maxOutputBytes: 1000, maxCpuCores: -1 }).ok, false);
  assert.equal(validateExecutionLimits({ timeoutMs: 1000, maxOutputBytes: 1000, maxMemoryBytes: -1 }).ok, false);
  assert.equal(validateExecutionLimits({ timeoutMs: 1000, maxOutputBytes: 1000, maxPids: 0 }).ok, false);
});

test('BudgetLimits validation: accepts valid budget limits within 3-replan cap', (): void => {
  for (const replan of [0, 1, 2, 3]) {
    const limits: BudgetLimits = {
      maxReplanCount: replan,
      maxTokens: 50000,
      maxCostUsd: 2.5,
      maxRepairAttempts: 3,
      maxReviewIterations: 3,
    };
    const res = validateBudgetLimits(limits);
    assert.equal(res.ok, true, `Expected replan ${replan} to be valid`);
    if (res.ok) {
      assert.equal(res.value.maxReplanCount, replan);
    }
  }
});

test('BudgetLimits validation: rejects replan count exceeding 3 (ADR-0004 & FR-007)', (): void => {
  const overCap = { maxReplanCount: 4 };
  const res = validateBudgetLimits(overCap);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'REPLAN_CAP_EXCEEDED'));
  }

  const hugeReplan = { maxReplanCount: 100 };
  assert.equal(validateBudgetLimits(hugeReplan).ok, false);
});

test('BudgetLimits validation: rejects negative, float, NaN, or non-finite budget limits', (): void => {
  assert.equal(validateBudgetLimits(null).ok, false);
  assert.equal(validateBudgetLimits({}).ok, false);

  // negative replan count
  assert.equal(validateBudgetLimits({ maxReplanCount: -1 }).ok, false);

  // float replan count
  assert.equal(validateBudgetLimits({ maxReplanCount: 1.5 }).ok, false);

  // NaN or Infinity replan
  assert.equal(validateBudgetLimits({ maxReplanCount: Number.NaN }).ok, false);
  assert.equal(validateBudgetLimits({ maxReplanCount: Number.POSITIVE_INFINITY }).ok, false);

  // negative optional fields
  assert.equal(validateBudgetLimits({ maxReplanCount: 2, maxTokens: -100 }).ok, false);
  assert.equal(validateBudgetLimits({ maxReplanCount: 2, maxCostUsd: -0.5 }).ok, false);
  assert.equal(validateBudgetLimits({ maxReplanCount: 2, maxRepairAttempts: 0 }).ok, false);
  assert.equal(validateBudgetLimits({ maxReplanCount: 2, maxReviewIterations: -1 }).ok, false);
});

/* ------------------------------------------------------------------
 * Normalized Action & Approval Binding Conformance Tests
 * ------------------------------------------------------------------ */

test('NormalizedAction validation: accepts valid run_command action', (): void => {
  const action: RunCommandAction = {
    actionId: 'act-cmd-1',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q', 'tests/test_foo.py'],
    workingDirectory: '/workspace/repo',
    purpose: 'run reproduction test',
  };
  const res = validateNormalizedAction(action);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.kind, 'run_command');
    assert.equal(res.value.actionId, 'act-cmd-1');
  }
});

test('NormalizedAction validation: rejects run_command with shell metacharacters or invalid argv', (): void => {
  const shellInjection = {
    actionId: 'act-cmd-bad',
    kind: 'run_command',
    executable: 'pytest; rm -rf /',
    argv: ['-q'],
    workingDirectory: '/workspace/repo',
  };
  assert.equal(validateNormalizedAction(shellInjection).ok, false);

  const nonArrayArgv = {
    actionId: 'act-cmd-bad2',
    kind: 'run_command',
    executable: 'pytest',
    argv: 'not-array',
    workingDirectory: '/workspace/repo',
  };
  assert.equal(validateNormalizedAction(nonArrayArgv).ok, false);
});

test('NormalizedAction validation: accepts valid apply_patch action', (): void => {
  const action: ApplyPatchAction = {
    actionId: 'act-patch-1',
    kind: 'apply_patch',
    patchContent: '--- a/src/calc.py\n+++ b/src/calc.py\n@@ -1,1 +1,2 @@\n',
    targetPaths: ['src/calc.py'],
    baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  const res = validateNormalizedAction(action);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.kind, 'apply_patch');
    assert.equal(res.value.actionId, 'act-patch-1');
  }
});

test('NormalizedAction validation: rejects apply_patch with escaping targetPaths or empty content', (): void => {
  const escapePatch = {
    actionId: 'act-patch-escape',
    kind: 'apply_patch',
    patchContent: 'diff content',
    targetPaths: ['../outside.py'],
    baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  assert.equal(validateNormalizedAction(escapePatch).ok, false);

  const emptyPatch = {
    actionId: 'act-patch-empty',
    kind: 'apply_patch',
    patchContent: '   ',
    targetPaths: ['src/calc.py'],
    baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  assert.equal(validateNormalizedAction(emptyPatch).ok, false);
});

test('NormalizedAction validation: accepts valid approve_fix_plan action', (): void => {
  const action: ApproveFixPlanAction = {
    actionId: 'act-plan-1',
    kind: 'approve_fix_plan',
    planVersion: 1,
    strategyDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    diagnosisEvidenceRefs: ['evidence-baseline-001'],
    checkSetDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  };
  const res = validateNormalizedAction(action);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.kind, 'approve_fix_plan');
    assert.equal(res.value.planVersion, 1);
  }
});

test('NormalizedAction validation: rejects approve_fix_plan with invalid version or empty digests', (): void => {
  const badVersion = {
    actionId: 'act-plan-bad',
    kind: 'approve_fix_plan',
    planVersion: 0,
    strategyDigest: 'sha256:111',
    diagnosisEvidenceRefs: ['ref1'],
    checkSetDigest: 'sha256:222',
  };
  assert.equal(validateNormalizedAction(badVersion).ok, false);

  const emptyEvidence = {
    actionId: 'act-plan-no-evidence',
    kind: 'approve_fix_plan',
    planVersion: 1,
    strategyDigest: 'sha256:111',
    diagnosisEvidenceRefs: [],
    checkSetDigest: 'sha256:222',
  };
  assert.equal(validateNormalizedAction(emptyEvidence).ok, false);
});

test('ApprovalBinding validation: accepts valid action approval binding', (): void => {
  const binding: ApprovalBinding = {
    decisionId: 'dec-001',
    actionKind: 'action',
    normalizedActionDigest: 'sha256:action-digest-123',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    repositoryRevisionDigest: 'sha256:repo-rev-123',
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    status: 'pending',
  };
  const res = validateApprovalBinding(binding);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.decisionId, 'dec-001');
    assert.equal(res.value.status, 'pending');
  }
});

test('ApprovalBinding validation: accepts valid fix_plan approval binding with planVersion and strategyDigest', (): void => {
  const binding: ApprovalBinding = {
    decisionId: 'dec-plan-001',
    actionKind: 'fix_plan',
    normalizedActionDigest: 'sha256:plan-action-digest',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    repositoryRevisionDigest: 'sha256:repo-rev-123',
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    planVersion: 1,
    strategyDigest: 'sha256:strategy-digest-456',
    baselineRef: 'evidence-baseline-001',
    evidenceRefs: ['evidence-baseline-001'],
    criteriaDigest: 'sha256:criteria-digest-789',
    checkSetDigest: 'sha256:checkset-digest-101',
    status: 'approved',
  };
  const res = validateApprovalBinding(binding);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.actionKind, 'fix_plan');
    assert.equal(res.value.status, 'approved');
  }
});

test('ApprovalBinding validation: rejects fix_plan binding missing planVersion or strategyDigest', (): void => {
  const missingPlanFields = {
    decisionId: 'dec-plan-bad',
    actionKind: 'fix_plan' as const,
    normalizedActionDigest: 'sha256:plan-digest',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    repositoryRevisionDigest: 'sha256:repo-rev-123',
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    baselineRef: 'evidence-baseline-001',
    evidenceRefs: ['evidence-baseline-001'],
    criteriaDigest: 'sha256:criteria-digest-789',
    checkSetDigest: 'sha256:checkset-digest-101',
    status: 'pending' as const,
  };
  const res = validateApprovalBinding(missingPlanFields);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'MISSING_PLAN_FIELD'));
  }
});

test('ApprovalBinding validation: rejects invalid status or missing required digests', (): void => {
  const badStatus = {
    decisionId: 'dec-002',
    actionKind: 'action',
    normalizedActionDigest: 'sha256:action',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    repositoryRevisionDigest: 'sha256:repo',
    policyId: 'policy-1',
    policyVersion: '1.0.0',
    status: 'unknown_status',
  };
  assert.equal(validateApprovalBinding(badStatus).ok, false);
});

/* ------------------------------------------------------------------
 * CommandView Conformance Tests
 * ------------------------------------------------------------------ */

function createValidCommandView(): CommandView {
  return {
    viewId: 'view-001',
    viewDigest: 'sha256:viewdigest1234567890abcdef1234567890abcdef1234567890abcdef12345678',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    canonicalRevisionDigest: 'sha256:canondigest1234567890abcdef1234567890abcdef1234567890abcdef1234',
    admittedFiles: [
      { path: 'src/calculator.py', digest: 'sha256:file1' },
      { path: 'tests/test_calculator.py', digest: 'sha256:file2' },
    ],
    exclusionsPolicyVersion: '1.0.0',
    scratchIdentity: 'scratch-vol-001',
    mountedReadOnly: true,
  };
}

test('CommandView validation: accepts valid read-only CommandView with admitted files', (): void => {
  const view = createValidCommandView();
  const res = validateCommandView(view);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.viewId, 'view-001');
    assert.equal(res.value.mountedReadOnly, true);
    assert.equal(res.value.admittedFiles.length, 2);
  }
});

test('CommandView validation: rejects when mountedReadOnly is false or missing', (): void => {
  const writableView = {
    ...createValidCommandView(),
    mountedReadOnly: false,
  };
  const res = validateCommandView(writableView);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'READONLY_REQUIRED'));
  }
});

test('CommandView validation: rejects when protected files are in admittedFiles (FR-009, FR-010, C08)', (): void => {
  const forbiddenNames = [
    '.env',
    '.env.local',
    'id_rsa',
    'id_ed25519',
    'secret.pem',
    'deploy.key',
    'credentials.json',
    '.git/config',
    'certs/privkey.pem',
  ];

  for (const forbiddenPath of forbiddenNames) {
    const badView = {
      ...createValidCommandView(),
      admittedFiles: [
        { path: 'src/calculator.py', digest: 'sha256:file1' },
        { path: forbiddenPath, digest: 'sha256:secretfile' },
      ],
    };
    const res = validateCommandView(badView);
    assert.equal(res.ok, false, `Expected admitting ${forbiddenPath} to fail`);
    if (!res.ok) {
      assert.ok(res.errors.some((e) => e.code === 'PROTECTED_DATA_ADMITTED'));
    }
  }
});

test('CommandView validation: rejects escaping paths in admittedFiles', (): void => {
  const escapingView = {
    ...createValidCommandView(),
    admittedFiles: [
      { path: '../outside.py', digest: 'sha256:file1' },
    ],
  };
  assert.equal(validateCommandView(escapingView).ok, false);
});

test('CommandView validation: detects stale view when currentCanonicalRevisionDigest does not match', (): void => {
  const view = createValidCommandView();
  const res = validateCommandView(view, {
    currentCanonicalRevisionDigest: 'sha256:different-new-canonical-revision',
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'STALE_COMMAND_VIEW'));
  }

  // Matches
  const matchingRes = validateCommandView(view, {
    currentCanonicalRevisionDigest: view.canonicalRevisionDigest,
  });
  assert.equal(matchingRes.ok, true);
});

/* ------------------------------------------------------------------
 * Slice 2 Tests: TaskEnvelope, TaskNode, Outcomes, PlanStep, FixPlan,
 * BudgetLedger, TaskState/Checkpoint, and State Transitions
 * ------------------------------------------------------------------ */

function createValidTaskEnvelope(): TaskEnvelope {
  return {
    schemaVersion: '0.1.0',
    requestId: 'req-001',
    taskId: 'task-uc03-calc-001',
    runId: 'run-001',
    workspaceId: 'ws-001',
    expectedStateVersion: 0,
    repositoryRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    trustedConfigId: 'config-uc03-v1',
  };
}

function createValidPlanStep(): PlanStep {
  return {
    stepId: 'step-1',
    description: 'Diagnose root cause in calculator.py',
    status: 'todo',
    actionRefs: ['act-cmd-1'],
    evidenceRefs: ['ev-001'],
  };
}

function createValidFixPlan(): FixPlan {
  return {
    planVersion: 1,
    diagnosis: 'ZeroDivisionError unhandled in divide method',
    suspectedCauseLocations: ['src/calculator.py:42'],
    evidenceRefs: ['evidence-baseline-001'],
    strategy: 'Check denominator and raise CalculationError if zero',
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    baselineRef: 'evidence-baseline-001',
    strategyDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    decisionRef: 'dec-plan-001',
  };
}

function createValidBudgetLedger(): BudgetLedger {
  return {
    scope: 'task',
    kind: 'replan',
    limit: 3,
    consumed: 0,
    reservations: [],
    unit: 'count',
    configurationId: 'config-uc03-v1',
    version: 1,
  };
}

function createValidTaskState(node: TaskNode = 'Validate'): TaskState {
  return {
    schemaVersion: '0.1.0',
    stateVersion: 1,
    taskId: 'task-uc03-calc-001',
    runId: 'run-001',
    workspaceId: 'ws-001',
    repositoryId: 'repo-python-calc',
    repositoryRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    goal: 'Fix ZeroDivisionError when dividing by zero in Calculator.divide',
    observedBehavior: 'Calling Calculator.divide(10, 0) raises unhandled ZeroDivisionError',
    expectedBehavior: 'Calling Calculator.divide(10, 0) raises custom CalculationError',
    reproduction: 'python -m pytest tests/test_calculator.py -k test_divide_zero',
    acceptanceCriteria: ['Calculator.divide(x, 0) raises CalculationError'],
    constraints: ['Do not modify external public API signatures'],
    requiredCheckIds: ['check-pytest-focused'],
    node,
    planVersion: 1,
    replanCount: 0,
    changedPaths: [],
    evidenceRefs: ['evidence-baseline-001'],
    risks: ['Regression in floating-point division'],
    nextAction: 'Validate bug intake',
    outcome: node === 'Deliver' ? 'COMPLETED' : node === 'Incomplete' ? 'FAILED' : undefined,
  };
}

test('TaskEnvelope validation: accepts valid envelope', (): void => {
  const env = createValidTaskEnvelope();
  const res = validateTaskEnvelope(env);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.taskId, 'task-uc03-calc-001');
    assert.equal(res.value.schemaVersion, '0.1.0');
    assert.equal(res.value.expectedStateVersion, 0);
  }
});

test('TaskEnvelope validation: rejects non-object, missing fields, or invalid version/numbers', (): void => {
  assert.equal(validateTaskEnvelope(null).ok, false);
  assert.equal(validateTaskEnvelope('not-an-object').ok, false);

  // Wrong schema version
  const badVersion = { ...createValidTaskEnvelope(), schemaVersion: '2.0.0' };
  assert.equal(validateTaskEnvelope(badVersion).ok, false);

  // Negative expectedStateVersion
  const negativeVersion = { ...createValidTaskEnvelope(), expectedStateVersion: -1 };
  assert.equal(validateTaskEnvelope(negativeVersion).ok, false);

  // Float expectedStateVersion
  const floatVersion = { ...createValidTaskEnvelope(), expectedStateVersion: 1.5 };
  assert.equal(validateTaskEnvelope(floatVersion).ok, false);

  // Missing required string fields
  const missingTask = { ...createValidTaskEnvelope(), taskId: '' };
  assert.equal(validateTaskEnvelope(missingTask).ok, false);

  const missingDigest = { ...createValidTaskEnvelope(), repositoryRevisionDigest: '   ' };
  assert.equal(validateTaskEnvelope(missingDigest).ok, false);
});

test('TaskEnvelope validation: rejects unknown execution-affecting properties', (): void => {
  const extraProp = {
    ...createValidTaskEnvelope(),
    unknownExecutionProperty: 'malicious-override',
  };
  const res = validateTaskEnvelope(extraProp);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'UNKNOWN_PROPERTY'));
  }
});

test('TaskNode validation: accepts all 11 canonical node enum values', (): void => {
  const nodes: readonly TaskNode[] = [
    'Validate',
    'NeedsInfo',
    'Investigate',
    'AwaitPlan',
    'AwaitFeedback',
    'Patch',
    'Verify',
    'Review',
    'Repair',
    'Deliver',
    'Incomplete',
  ];
  for (const node of nodes) {
    const res = validateTaskNode(node);
    assert.equal(res.ok, true, `Expected node ${node} to be valid`);
    if (res.ok) {
      assert.equal(res.value, node);
    }
  }
});

test('TaskNode validation: rejects invalid or non-string node names', (): void => {
  assert.equal(validateTaskNode('Pending').ok, false);
  assert.equal(validateTaskNode('Running').ok, false);
  assert.equal(validateTaskNode('').ok, false);
  assert.equal(validateTaskNode(123).ok, false);
  assert.equal(validateTaskNode(null).ok, false);
});

test('TaskOutcome and EnvelopeOutcome validation: validates canonical outcomes', (): void => {
  // TaskOutcome
  assert.equal(validateTaskOutcome('COMPLETED').ok, true);
  assert.equal(validateTaskOutcome('IMPLEMENTED_UNVERIFIED').ok, true);
  assert.equal(validateTaskOutcome('INCOMPLETE').ok, true);
  assert.equal(validateTaskOutcome('FAILED').ok, true);
  assert.equal(validateTaskOutcome('INVALID').ok, false);

  // EnvelopeOutcome
  const validEnvelopeOutcomes: readonly EnvelopeOutcome[] = [
    'success',
    'needs-info',
    'pending-approval',
    'denied',
    'conflict',
    'exhausted',
    'timeout',
    'error',
    'uncertain-effect',
  ];
  for (const out of validEnvelopeOutcomes) {
    assert.equal(validateEnvelopeOutcome(out).ok, true);
  }
  assert.equal(validateEnvelopeOutcome('unknown-outcome').ok, false);
});

test('PlanStep validation: accepts valid step and rejects invalid status or unknown properties', (): void => {
  const step = createValidPlanStep();
  const res = validatePlanStep(step);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.stepId, 'step-1');
    assert.equal(res.value.status, 'todo');
  }

  // Invalid status
  const badStatus = { ...createValidPlanStep(), status: 'invalid-status' };
  assert.equal(validatePlanStep(badStatus).ok, false);

  // Unknown property
  const unknownKey = { ...createValidPlanStep(), unexpectedPayload: true };
  const unknownRes = validatePlanStep(unknownKey);
  assert.equal(unknownRes.ok, false);
  if (!unknownRes.ok) {
    assert.ok(unknownRes.errors.some((e) => e.code === 'UNKNOWN_PROPERTY'));
  }
});

test('FixPlan validation: accepts valid complete FixPlan and rejects missing required fields or unknown properties', (): void => {
  const plan = createValidFixPlan();
  const res = validateFixPlan(plan);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.planVersion, 1);
    assert.equal(res.value.scopedChanges.length, 1);
  }

  // Non-positive planVersion
  const zeroVersion = { ...createValidFixPlan(), planVersion: 0 };
  assert.equal(validateFixPlan(zeroVersion).ok, false);

  // Empty scopedChanges
  const emptyScope = { ...createValidFixPlan(), scopedChanges: [] };
  assert.equal(validateFixPlan(emptyScope).ok, false);

  // Empty suspectedCauseLocations
  const emptyLocations = { ...createValidFixPlan(), suspectedCauseLocations: [] };
  assert.equal(validateFixPlan(emptyLocations).ok, false);

  // Unknown property
  const unknownKey = { ...createValidFixPlan(), autoApproved: true };
  const unknownRes = validateFixPlan(unknownKey);
  assert.equal(unknownRes.ok, false);
  if (!unknownRes.ok) {
    assert.ok(unknownRes.errors.some((e) => e.code === 'UNKNOWN_PROPERTY'));
  }
});

test('BudgetLedger validation: accepts valid ledger and rejects negative amounts or unknown properties', (): void => {
  const ledger = createValidBudgetLedger();
  const res = validateBudgetLedger(ledger);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.limit, 3);
    assert.equal(res.value.scope, 'task');
  }

  // Negative limit
  const negLimit = { ...createValidBudgetLedger(), limit: -1 };
  assert.equal(validateBudgetLedger(negLimit).ok, false);

  // Negative consumed
  const negConsumed = { ...createValidBudgetLedger(), consumed: -5 };
  assert.equal(validateBudgetLedger(negConsumed).ok, false);

  // Unknown property in ledger
  const unknownLedger = { ...createValidBudgetLedger(), overdraftAllowed: true };
  assert.equal(validateBudgetLedger(unknownLedger).ok, false);
});

test('TaskState validation: accepts valid TaskState with original task context and repository binding', (): void => {
  const state = createValidTaskState('Validate');
  const res = validateTaskState(state);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.taskId, 'task-uc03-calc-001');
    assert.equal(res.value.repositoryId, 'repo-python-calc');
    assert.equal(res.value.repositoryRevisionDigest.startsWith('sha256:'), true);
    assert.equal(res.value.node, 'Validate');
    assert.equal(res.value.replanCount, 0);
  }
});

test('TaskState validation: accepts finite checkpoint config and ledgers', (): void => {
  const state: TaskState = {
    ...createValidTaskState('Investigate'),
    checkpointConfigId: 'checkpoint-cfg-001',
    checkpointVersion: 1,
    budgetLedgers: [createValidBudgetLedger()],
  };
  const res = validateTaskState(state);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.checkpointConfigId, 'checkpoint-cfg-001');
    assert.equal(res.value.budgetLedgers?.length, 1);
  }
});

test('TaskState validation: rejects missing repository binding or invalid replanCount', (): void => {
  // Missing repositoryId
  const noRepo = { ...createValidTaskState('Validate'), repositoryId: '' };
  assert.equal(validateTaskState(noRepo).ok, false);

  // Missing repositoryRevisionDigest
  const noDigest = { ...createValidTaskState('Validate'), repositoryRevisionDigest: '  ' };
  assert.equal(validateTaskState(noDigest).ok, false);

  // replanCount exceeding 3
  const overCap = { ...createValidTaskState('Validate'), replanCount: 4 };
  const overCapRes = validateTaskState(overCap);
  assert.equal(overCapRes.ok, false);
  if (!overCapRes.ok) {
    assert.ok(overCapRes.errors.some((e) => e.code === 'REPLAN_CAP_EXCEEDED'));
  }

  // Negative replanCount
  const negReplan = { ...createValidTaskState('Validate'), replanCount: -1 };
  assert.equal(validateTaskState(negReplan).ok, false);
});

test('TaskState validation: enforces node-appropriate terminal outcomes', (): void => {
  // Non-terminal node must NOT have outcome set
  const nonTerminalWithOutcome = {
    ...createValidTaskState('Investigate'),
    outcome: 'COMPLETED' as TaskOutcome,
  };
  const resNonTerm = validateTaskState(nonTerminalWithOutcome);
  assert.equal(resNonTerm.ok, false);
  if (!resNonTerm.ok) {
    assert.ok(resNonTerm.errors.some((e) => e.code === 'NON_TERMINAL_OUTCOME_SET'));
  }

  // Deliver node requires COMPLETED or IMPLEMENTED_UNVERIFIED
  const deliverValid1 = {
    ...createValidTaskState('Deliver'),
    outcome: 'COMPLETED' as TaskOutcome,
  };
  assert.equal(validateTaskState(deliverValid1).ok, true);

  const deliverValid2 = {
    ...createValidTaskState('Deliver'),
    outcome: 'IMPLEMENTED_UNVERIFIED' as TaskOutcome,
  };
  assert.equal(validateTaskState(deliverValid2).ok, true);

  const deliverInvalid = {
    ...createValidTaskState('Deliver'),
    outcome: 'FAILED' as TaskOutcome,
  };
  assert.equal(validateTaskState(deliverInvalid).ok, false);

  const deliverMissingOutcome = {
    ...createValidTaskState('Deliver'),
    outcome: undefined,
  };
  assert.equal(validateTaskState(deliverMissingOutcome).ok, false);

  // Incomplete node requires INCOMPLETE or FAILED
  const incompleteValid1 = {
    ...createValidTaskState('Incomplete'),
    outcome: 'INCOMPLETE' as TaskOutcome,
  };
  assert.equal(validateTaskState(incompleteValid1).ok, true);

  const incompleteValid2 = {
    ...createValidTaskState('Incomplete'),
    outcome: 'FAILED' as TaskOutcome,
  };
  assert.equal(validateTaskState(incompleteValid2).ok, true);

  const incompleteInvalid = {
    ...createValidTaskState('Incomplete'),
    outcome: 'COMPLETED' as TaskOutcome,
  };
  assert.equal(validateTaskState(incompleteInvalid).ok, false);
});

test('TaskState validation: rejects unknown execution-affecting properties (including nested)', (): void => {
  const unknownTop = {
    ...createValidTaskState('Validate'),
    unknownField: 'bad-value',
  };
  const res1 = validateTaskState(unknownTop);
  assert.equal(res1.ok, false);
  if (!res1.ok) {
    assert.ok(res1.errors.some((e) => e.code === 'UNKNOWN_PROPERTY'));
  }

  const unknownNestedPlan = {
    ...createValidTaskState('AwaitPlan'),
    plan: {
      ...createValidFixPlan(),
      bypassApprovalFlag: true,
    },
  };
  const res2 = validateTaskState(unknownNestedPlan);
  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.ok(res2.errors.some((e) => e.code === 'UNKNOWN_PROPERTY'));
  }
});

/* ------------------------------------------------------------------
 * State Transition Conformance Tests
 * ------------------------------------------------------------------ */

test('validateStateTransition: accepts valid canonical transitions per data-model diagram', (): void => {
  // Validate -> Investigate
  const s0 = createValidTaskState('Validate');
  const s1: TaskState = {
    ...s0,
    stateVersion: 2,
    node: 'Investigate',
    nextAction: 'Prepare baseline reproduction',
  };
  const res1 = validateStateTransition(s0, s1);
  assert.equal(res1.ok, true);

  // Investigate -> AwaitPlan (with valid plan)
  const plan = createValidFixPlan();
  const s2: TaskState = {
    ...s1,
    stateVersion: 3,
    node: 'AwaitPlan',
    plan,
    nextAction: 'Await human fix-plan approval',
  };
  const res2 = validateStateTransition(s1, s2);
  assert.equal(res2.ok, true);

  // AwaitPlan -> AwaitFeedback (rejected plan await-feedback)
  const s3Rejected: TaskState = {
    ...s2,
    stateVersion: 4,
    node: 'AwaitFeedback',
    nextAction: 'Await user feedback or direction on rejected plan',
  };
  const resRejected = validateStateTransition(s2, s3Rejected);
  assert.equal(resRejected.ok, true);

  // AwaitFeedback -> Investigate (user requests revision)
  const s4Revision: TaskState = {
    ...s3Rejected,
    stateVersion: 5,
    node: 'Investigate',
    replanCount: 1,
    nextAction: 'Investigate revised strategy per feedback',
  };
  const resRevision = validateStateTransition(s3Rejected, s4Revision);
  assert.equal(resRevision.ok, true);

  // AwaitPlan -> Patch (approved plan)
  const s3Patch: TaskState = {
    ...s2,
    stateVersion: 4,
    node: 'Patch',
    activeDecisionId: 'dec-plan-001',
    nextAction: 'Apply controlled code patch',
  };
  const resPatch = validateStateTransition(s2, s3Patch);
  assert.equal(resPatch.ok, true);

  // Patch -> Verify
  const s4Verify: TaskState = {
    ...s3Patch,
    stateVersion: 5,
    node: 'Verify',
    changedPaths: ['src/calculator.py'],
    nextAction: 'Run verification test suite',
  };
  const resVerify = validateStateTransition(s3Patch, s4Verify);
  assert.equal(resVerify.ok, true);

  // Verify -> Review
  const s5Review: TaskState = {
    ...s4Verify,
    stateVersion: 6,
    node: 'Review',
    nextAction: 'Run read-only automated review',
  };
  const resReview = validateStateTransition(s4Verify, s5Review);
  assert.equal(resReview.ok, true);

  // Review -> Deliver (accepted current diff, terminal completed)
  const s6Deliver: TaskState = {
    ...s5Review,
    stateVersion: 7,
    node: 'Deliver',
    outcome: 'COMPLETED',
    nextAction: 'Delivery complete',
  };
  const resDeliver = validateStateTransition(s5Review, s6Deliver);
  assert.equal(resDeliver.ok, true);

  // Verify -> Repair (failed checks)
  const s5Repair: TaskState = {
    ...s4Verify,
    stateVersion: 6,
    node: 'Repair',
    nextAction: 'Evaluate repair options',
  };
  const resRepair = validateStateTransition(s4Verify, s5Repair);
  assert.equal(resRepair.ok, true);

  // Repair -> Patch (same approved strategy)
  const s6Patch: TaskState = {
    ...s5Repair,
    stateVersion: 7,
    node: 'Patch',
    nextAction: 'Apply revised patch under same strategy',
  };
  const resRepairPatch = validateStateTransition(s5Repair, s6Patch);
  assert.equal(resRepairPatch.ok, true);

  // Repair -> Investigate (material replan within limit)
  const s6Replan: TaskState = {
    ...s5Repair,
    stateVersion: 7,
    node: 'Investigate',
    replanCount: 1,
    nextAction: 'Prepare revised fix plan',
  };
  const resReplan = validateStateTransition(s5Repair, s6Replan);
  assert.equal(resReplan.ok, true);

  // Repair -> Incomplete (exhaustion)
  const s6Incomplete: TaskState = {
    ...s5Repair,
    stateVersion: 7,
    node: 'Incomplete',
    outcome: 'INCOMPLETE',
    nextAction: 'Task terminated due to exhaustion',
  };
  const resIncomplete = validateStateTransition(s5Repair, s6Incomplete);
  assert.equal(resIncomplete.ok, true);
});

test('validateStateTransition: rejects invalid transitions not in data-model diagram', (): void => {
  const sValidate = createValidTaskState('Validate');

  // Validate -> Patch (skipping Investigate and AwaitPlan)
  const sPatch: TaskState = {
    ...sValidate,
    stateVersion: 2,
    node: 'Patch',
  };
  const res1 = validateStateTransition(sValidate, sPatch);
  assert.equal(res1.ok, false);
  if (!res1.ok) {
    assert.ok(res1.errors.some((e) => e.code === 'INVALID_NODE_TRANSITION'));
  }

  // Investigate -> Patch (bypassing AwaitPlan approval)
  const sInvestigate = createValidTaskState('Investigate');
  const res2 = validateStateTransition(sInvestigate, sPatch);
  assert.equal(res2.ok, false);

  // AwaitPlan -> Deliver (bypassing Patch, Verify, Review)
  const sAwaitPlan = { ...createValidTaskState('AwaitPlan'), plan: createValidFixPlan() };
  const sDeliver: TaskState = {
    ...sAwaitPlan,
    stateVersion: 2,
    node: 'Deliver',
    outcome: 'COMPLETED',
  };
  const res3 = validateStateTransition(sAwaitPlan, sDeliver);
  assert.equal(res3.ok, false);

  // AwaitPlan -> Investigate directly (rejected plan MUST go to AwaitFeedback first)
  const sDirectInvestigate: TaskState = {
    ...sAwaitPlan,
    stateVersion: 2,
    node: 'Investigate',
  };
  const res4 = validateStateTransition(sAwaitPlan, sDirectInvestigate);
  assert.equal(res4.ok, false);
});

test('validateStateTransition: rejects transition out of terminal nodes (Deliver, Incomplete)', (): void => {
  const sDeliver = createValidTaskState('Deliver');
  const sNext: TaskState = {
    ...sDeliver,
    stateVersion: 2,
    node: 'Validate',
    outcome: undefined,
  };
  const res = validateStateTransition(sDeliver, sNext);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'TERMINAL_NODE_CANNOT_TRANSITION'));
  }
});

test('validateStateTransition: enforces CAS stateVersion and preserves identity', (): void => {
  const s0 = createValidTaskState('Validate');

  // CAS conflict: version skipped (+2) or stale (+0)
  const staleVersion: TaskState = {
    ...s0,
    stateVersion: 1, // should be 2
    node: 'Investigate',
  };
  assert.equal(validateStateTransition(s0, staleVersion).ok, false);

  const skippedVersion: TaskState = {
    ...s0,
    stateVersion: 3, // should be 2
    node: 'Investigate',
  };
  assert.equal(validateStateTransition(s0, skippedVersion).ok, false);

  // Task identity mismatch
  const badTask: TaskState = {
    ...s0,
    stateVersion: 2,
    node: 'Investigate',
    taskId: 'different-task-id',
  };
  assert.equal(validateStateTransition(s0, badTask).ok, false);

  // Workspace identity mismatch
  const badWs: TaskState = {
    ...s0,
    stateVersion: 2,
    node: 'Investigate',
    workspaceId: 'different-workspace-id',
  };
  assert.equal(validateStateTransition(s0, badWs).ok, false);

  // Repository identity mismatch
  const badRepo: TaskState = {
    ...s0,
    stateVersion: 2,
    node: 'Investigate',
    repositoryId: 'different-repo-id',
  };
  assert.equal(validateStateTransition(s0, badRepo).ok, false);
});

test('validateStateTransition: enforces maximum 3 material replans and prohibits replenishment', (): void => {
  const sRepair = { ...createValidTaskState('Repair'), replanCount: 3 };

  // 4th material replan attempt must fail
  const fourthReplan: TaskState = {
    ...sRepair,
    stateVersion: 2,
    node: 'Investigate',
    replanCount: 4,
  };
  const res1 = validateStateTransition(sRepair, fourthReplan);
  assert.equal(res1.ok, false);
  if (!res1.ok) {
    assert.ok(res1.errors.some((e) => e.code === 'REPLAN_CAP_EXCEEDED'));
  }

  // replan count decrease (replenishment attempt) must fail
  const replenishedReplan: TaskState = {
    ...sRepair,
    stateVersion: 2,
    node: 'Investigate',
    replanCount: 2,
  };
  const res2 = validateStateTransition(sRepair, replenishedReplan);
  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.ok(res2.errors.some((e) => e.code === 'REPLAN_COUNT_DECREASED'));
  }
});

test('validateStateTransition: enforces required plan before entering AwaitPlan', (): void => {
  const sInvestigate = createValidTaskState('Investigate');
  const sAwaitPlanNoPlan: TaskState = {
    ...sInvestigate,
    stateVersion: 2,
    node: 'AwaitPlan',
    plan: undefined,
  };
  const res = validateStateTransition(sInvestigate, sAwaitPlanNoPlan);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'MISSING_PLAN'));
  }
});

test('validateStateTransition: respects allowSameNode option and rejects unpermitted same-node transitions', (): void => {
  const s0 = createValidTaskState('Investigate');
  const sSame: TaskState = {
    ...s0,
    stateVersion: 2,
    evidenceRefs: [...s0.evidenceRefs, 'evidence-new-002'],
  };

  // Default: same-node transition not permitted by strict diagram edges
  assert.equal(validateStateTransition(s0, sSame).ok, false);

  // With allowSameNode: true
  const allowedRes = validateStateTransition(s0, sSame, { allowSameNode: true });
  assert.equal(allowedRes.ok, true);
});

/* ------------------------------------------------------------------
 * T003 Core Correction Regression Tests (Defects 1-6)
 * ------------------------------------------------------------------ */

// Defect 1: Limits & BugTask profile
test('T003 Defect 1 Regression: ExecutionLimits requires all finite CPU, memory, and PID limits', (): void => {
  const missingCpu = {
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    maxMemoryBytes: 1024 * 1024,
    maxPids: 10,
  };
  const res = validateExecutionLimits(missingCpu);
  assert.equal(res.ok, false, 'Expected missing maxCpuCores to fail validation');

  const missingMem = {
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    maxCpuCores: 2,
    maxPids: 10,
  };
  assert.equal(validateExecutionLimits(missingMem).ok, false, 'Expected missing maxMemoryBytes to fail validation');

  const missingPids = {
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    maxCpuCores: 2,
    maxMemoryBytes: 1024 * 1024,
  };
  assert.equal(validateExecutionLimits(missingPids).ok, false, 'Expected missing maxPids to fail validation');
});

test('T003 Defect 1 Regression: BudgetLimits requires all finite limits and accepts finite 0 budget as valid exhausted budget', (): void => {
  const missingTokens = {
    maxReplanCount: 3,
    maxCostUsd: 1.0,
    maxRepairAttempts: 2,
    maxReviewIterations: 2,
  };
  assert.equal(validateBudgetLimits(missingTokens).ok, false, 'Expected missing maxTokens to fail');

  const exhaustedBudget: BudgetLimits = {
    maxReplanCount: 0,
    maxTokens: 0,
    maxCostUsd: 0,
    maxRepairAttempts: 0,
    maxReviewIterations: 0,
  };
  const res = validateBudgetLimits(exhaustedBudget);
  assert.equal(res.ok, true, 'Finite 0 budget should be valid exhausted budget');
  if (res.ok) {
    assert.equal(res.value.maxTokens, 0);
    assert.equal(res.value.maxCostUsd, 0);
  }
});

test('T003 Defect 1 Regression: BugTask requires configId and configVersion', (): void => {
  const taskNoConfigId = Object.fromEntries(
    Object.entries(createValidBugTask()).filter(([k]) => k !== 'configId')
  );
  assert.equal(validateBugTask(taskNoConfigId).ok, false, 'Expected missing configId to fail');

  const taskNoConfigVer = Object.fromEntries(
    Object.entries(createValidBugTask()).filter(([k]) => k !== 'configVersion')
  );
  assert.equal(validateBugTask(taskNoConfigVer).ok, false, 'Expected missing configVersion to fail');
});

// Defect 2: Patch content byte-for-byte preservation
test('T003 Defect 2 Regression: apply_patch preserves patchContent byte-for-byte while rejecting whitespace-only string', (): void => {
  const rawDiff = '  --- a/file.py\n+++ b/file.py\n@@ -1 +1 @@\n- old\n+ new\n  \n';
  const action = {
    actionId: 'act-patch-preserve',
    kind: 'apply_patch',
    patchContent: rawDiff,
    targetPaths: ['src/calculator.py'],
    baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
  const res = validateNormalizedAction(action);
  assert.equal(res.ok, true);
  if (res.ok && res.value.kind === 'apply_patch') {
    assert.equal(res.value.patchContent, rawDiff, 'patchContent must preserve bytes and whitespace byte-for-byte');
  }

  const whitespaceOnly = {
    ...action,
    patchContent: '   \n  \t  \n',
  };
  assert.equal(validateNormalizedAction(whitespaceOnly).ok, false, 'Whitespace-only patchContent must be rejected');
});

// Defect 3: Relative path normalization and protected path rejection
test('T003 Defect 3 Regression: rejects non-canonical relative path aliases (./ prefix, trailing slashes, NUL bytes, traversal endings)', (): void => {
  const badPaths = [
    './src/calculator.py',
    'src/calculator.py/',
    'src/\0calculator.py',
    'src/..',
    'src/./calculator.py',
    'src//calculator.py',
    '/workspace/calculator.py',
  ];

  assert.equal(isCanonicalRelativePath('src/calculator.py'), true);
  for (const badPath of badPaths) {
    assert.equal(isCanonicalRelativePath(badPath), false, `Expected isCanonicalRelativePath(${badPath}) to be false`);
    const action = {
      actionId: 'act-patch-badpath',
      kind: 'apply_patch',
      patchContent: 'diff',
      targetPaths: [badPath],
      baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
    const res = validateNormalizedAction(action);
    assert.equal(res.ok, false, `Expected non-canonical path ${badPath} to be rejected`);
  }
});

test('T003 Defect 3 Regression: rejects protected agent files (.agents, .codex, AGENTS.md, CLAUDE.md, .git) and private grading', (): void => {
  const protectedPaths = [
    '.agents/skills/tool.md',
    '.codex/instructions.md',
    'AGENTS.md',
    'CLAUDE.md',
    '.git/HEAD',
    'eval/uc03/private/rubric.json',
    'tests/private/grading/secret.py',
  ];

  assert.equal(isProtectedPath('src/calculator.py'), false);
  for (const p of protectedPaths) {
    assert.equal(isProtectedPath(p), true, `Expected isProtectedPath(${p}) to be true`);
    const view = {
      ...createValidCommandView(),
      admittedFiles: [
        { path: 'src/calculator.py', digest: 'sha256:file1' },
        { path: p, digest: 'sha256:protected' },
      ],
    };
    const res = validateCommandView(view);
    assert.equal(res.ok, false, `Expected protected path ${p} to be rejected`);
    if (!res.ok) {
      assert.ok(res.errors.some((e) => e.code === 'PROTECTED_DATA_ADMITTED'));
    }
  }
});

// Defect 4: Per-object allowlists reject unknown fields recursively
test('T003 Defect 4 Regression: per-object allowlists reject unknown fields recursively', (): void => {
  // run_command unknown properties (e.g. shell, env)
  const cmdWithShell = {
    actionId: 'act-cmd-1',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q'],
    workingDirectory: '/workspace/repo',
    shell: '/bin/bash',
  };
  const resCmd = validateNormalizedAction(cmdWithShell);
  assert.equal(resCmd.ok, false, 'run_command with shell property must be rejected');
  if (!resCmd.ok) {
    assert.ok(resCmd.errors.some((e) => e.code === 'UNKNOWN_PROPERTY'));
  }

  // CheckDefinition unknown properties
  const checkWithUnknown = {
    ...createValidCheck(),
    shell: true,
  };
  const errorsCheck: ValidationError[] = [];
  const resCheck = validateCheckDefinition(checkWithUnknown, 'check', errorsCheck);
  assert.equal(resCheck, undefined);
  assert.ok(errorsCheck.some((e) => e.code === 'UNKNOWN_PROPERTY'));

  // AdmittedFile unknown properties in CommandView
  const viewWithAdmittedUnknown = {
    ...createValidCommandView(),
    admittedFiles: [
      { path: 'src/calculator.py', digest: 'sha256:file1', unadmittedFlag: true },
    ],
  };
  const resView = validateCommandView(viewWithAdmittedUnknown);
  assert.equal(resView.ok, false);
  if (!resView.ok) {
    assert.ok(resView.errors.some((e) => e.code === 'UNKNOWN_PROPERTY'));
  }

  // ExecutionLimits unknown property
  const limitsUnknown = {
    ...createValidLimits(),
    unlimited: true,
  };
  assert.equal(validateExecutionLimits(limitsUnknown).ok, false);

  // BudgetLimits unknown property
  const budgetUnknown = {
    ...createValidBudgetLimits(),
    infiniteBudget: true,
  };
  assert.equal(validateBudgetLimits(budgetUnknown).ok, false);
});

// Defect 5: Exported validateCheckDefinition must never return typed check definition on local errors
test('T003 Defect 5 Regression: validateCheckDefinition returns undefined when invalid argv or options cause local errors', (): void => {
  const badArgvCheck = {
    checkId: 'check-1',
    executable: 'pytest',
    argv: ['-q', 12345 as unknown as string],
    purpose: 'focused',
  };
  const errors1: ValidationError[] = [];
  const res1 = validateCheckDefinition(badArgvCheck, 'check', errors1);
  assert.equal(res1, undefined, 'validateCheckDefinition must return undefined when argv has non-string elements');
  assert.ok(errors1.length > 0);

  const badTimeoutCheck = {
    ...createValidCheck(),
    timeoutMs: -500,
  };
  const errors2: ValidationError[] = [];
  const res2 = validateCheckDefinition(badTimeoutCheck, 'check', errors2);
  assert.equal(res2, undefined, 'validateCheckDefinition must return undefined when timeoutMs is invalid');
  assert.ok(errors2.length > 0);
});

// Defect 6: ApprovalBinding freshness, context verification, deterministic digest
test('T003 Defect 6 Regression: ApprovalBinding includes fix-plan identities and rejects stale material identity against context', (): void => {
  const validFixPlanBinding: ApprovalBinding = {
    decisionId: 'dec-plan-001',
    actionKind: 'fix_plan',
    normalizedActionDigest: 'sha256:plan-action-digest',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    repositoryRevisionDigest: 'sha256:repo-rev-123',
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    planVersion: 1,
    strategyDigest: 'sha256:strategy-digest-456',
    baselineRef: 'evidence-baseline-001',
    evidenceRefs: ['evidence-baseline-001'],
    criteriaDigest: 'sha256:criteria-digest-789',
    checkSetDigest: 'sha256:checkset-digest-101',
    status: 'approved',
  };

  // Missing fix-plan specific identity
  const missingBaseline = {
    ...validFixPlanBinding,
    baselineRef: undefined,
  };
  assert.equal(validateApprovalBinding(missingBaseline).ok, false, 'Missing baselineRef must fail');

  // Stale check against trusted context
  const context: ApprovalBindingContext = {
    currentTaskId: 'task-1',
    currentWorkspaceId: 'ws-1',
    currentRepositoryRevisionDigest: 'sha256:repo-rev-123',
    currentPlanVersion: 2, // material mismatch: current plan version is 2, binding has 1!
  };
  const staleRes = validateApprovalBinding(validFixPlanBinding, context);
  assert.equal(staleRes.ok, false, 'Validation must fail against stale trusted context');
  if (!staleRes.ok) {
    assert.ok(staleRes.errors.some((e) => e.code === 'STALE_APPROVAL_BINDING'));
  }
});

test('T003 Defect 6 Regression: computeCanonicalSha256 produces exact deterministic conformance vector regardless of key order', (): void => {
  const objA = {
    actionId: 'act-1',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q'],
    workingDirectory: '/workspace/repo',
  };
  const objB = {
    workingDirectory: '/workspace/repo',
    argv: ['-q'],
    executable: 'pytest',
    kind: 'run_command',
    actionId: 'act-1',
  };

  const jsonA = canonicalJsonStringify(objA);
  const jsonB = canonicalJsonStringify(objB);
  assert.equal(jsonA, jsonB);

  const digestA = computeCanonicalSha256(objA);
  const digestB = computeCanonicalSha256(objB);
  assert.equal(digestA, digestB, 'Digests must match regardless of key order');

  // Literal conformance vector verification
  // Canonical JSON: {"actionId":"act-1","argv":["-q"],"executable":"pytest","kind":"run_command","workingDirectory":"/workspace/repo"}
  const expectedCanonical = '{"actionId":"act-1","argv":["-q"],"executable":"pytest","kind":"run_command","workingDirectory":"/workspace/repo"}';
  assert.equal(jsonA, expectedCanonical);
  assert.equal(digestA, 'sha256:1cf5b6e6dc5c926b7dfc51b9f140d4b057e1262e03beeb279579d14afe537e0a');
  assert.equal(computeActionDigest(objA as unknown as RunCommandAction), digestA);

  const sampleView = createValidCommandView();
  assert.equal(computeCommandViewDigest(sampleView).startsWith('sha256:'), true);
});

test('T003 Defect 6 Regression: validateCommandView verifies view digest and rejects unevidenced files against trusted context', (): void => {
  const view = createValidCommandView();
  const contextWithTrustedEvidence: CommandViewValidationContext = {
    currentCanonicalRevisionDigest: view.canonicalRevisionDigest,
    currentExclusionsPolicyVersion: view.exclusionsPolicyVersion,
    trustedFileDigests: {
      'src/calculator.py': 'sha256:file1',
      // 'tests/test_calculator.py' is missing from trusted evidence!
    },
  };
  const res = validateCommandView(view, contextWithTrustedEvidence);
  assert.equal(res.ok, false, 'Unevidenced file admission must be rejected when trusted evidence context is supplied');
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'UNTRUSTED_FILE_ADMISSION'));
  }
});

/* ------------------------------------------------------------------
 * T003 Provider Accounting Slice Tests:
 * ProviderUsage, ProviderRequest, ModelProposal, ModelResult,
 * ReservationBundle, Dispatch Admission, and Budget Errors
 * ------------------------------------------------------------------ */

function createValidProviderUsage(): ProviderUsage {
  return {
    inputTokens: 1200,
    outputTokens: 450,
    costUsd: 0.015,
    billableTokens: 1750, // includes 100 overhead tokens
  };
}

function createValidProviderRequest(role: 'coder' | 'reviewer' = 'coder'): ProviderRequest {
  return {
    providerRequestId: 'req-prov-001',
    taskId: 'task-uc03-calc-001',
    runId: 'run-001',
    role,
    purpose: role === 'coder' ? 'propose_code_patch' : 'review_code_diff',
    providerId: 'provider-test',
    modelId: 'model-v1',
    configId: 'config-uc03-v1',
    pricingPolicyId: 'pricing-standard-v1',
    contextDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    timeoutMs: 30000,
    maxInputTokens: 8000,
    maxOutputTokens: 2000,
    maxBillableTokens: 11000, // conservative ceiling >= 8000 + 2000
    maxCostUsd: 0.15,
    reservationRef: 'res-bundle-001',
    dispatchState: 'reserved',
  };
}

function createValidReservationBundle(role: 'coder' | 'reviewer' = 'coder'): ReservationBundle {
  const reservations: ReservationBundleItem[] = [
    {
      ledgerIdentity: 'ledger-task-tokens',
      scope: 'task',
      kind: 'tokens',
      configurationId: 'config-uc03-v1',
      version: 1,
      requestId: 'req-prov-001',
      amount: 11000,
    },
    {
      ledgerIdentity: 'ledger-task-cost',
      scope: 'task',
      kind: 'cost',
      configurationId: 'config-uc03-v1',
      version: 1,
      requestId: 'req-prov-001',
      amount: 0.15,
    },
    {
      ledgerIdentity: 'ledger-run-tokens',
      scope: 'run',
      kind: 'tokens',
      configurationId: 'config-uc03-v1',
      version: 1,
      requestId: 'req-prov-001',
      amount: 11000,
    },
    {
      ledgerIdentity: 'ledger-run-cost',
      scope: 'run',
      kind: 'cost',
      configurationId: 'config-uc03-v1',
      version: 1,
      requestId: 'req-prov-001',
      amount: 0.15,
    },
  ];

  if (role === 'reviewer') {
    reservations.push({
      ledgerIdentity: 'ledger-task-iteration',
      scope: 'task',
      kind: 'iteration',
      configurationId: 'config-uc03-v1',
      version: 1,
      requestId: 'req-prov-001',
      amount: 1,
    });
  }

  return {
    bundleId: 'bundle-001',
    transactionRef: 'tx-atomic-001',
    taskId: 'task-uc03-calc-001',
    runId: 'run-001',
    reservations,
  };
}

function createMatchingLedgers(role: 'coder' | 'reviewer' = 'coder'): BudgetLedger[] {
  const ledgers: BudgetLedger[] = [
    {
      scope: 'task',
      kind: 'tokens',
      limit: 100000,
      consumed: 5000,
      reservations: [{ reservationId: 'res-1', keyedId: 'req-prov-001', amount: 11000 }],
      unit: 'count',
      configurationId: 'config-uc03-v1',
      version: 1,
    },
    {
      scope: 'task',
      kind: 'cost',
      limit: 5.0,
      consumed: 0.10,
      reservations: [{ reservationId: 'res-2', keyedId: 'req-prov-001', amount: 0.15 }],
      unit: 'usd',
      configurationId: 'config-uc03-v1',
      version: 1,
    },
    {
      scope: 'run',
      kind: 'tokens',
      limit: 50000,
      consumed: 2000,
      reservations: [{ reservationId: 'res-3', keyedId: 'req-prov-001', amount: 11000 }],
      unit: 'count',
      configurationId: 'config-uc03-v1',
      version: 1,
    },
    {
      scope: 'run',
      kind: 'cost',
      limit: 2.0,
      consumed: 0.05,
      reservations: [{ reservationId: 'res-4', keyedId: 'req-prov-001', amount: 0.15 }],
      unit: 'usd',
      configurationId: 'config-uc03-v1',
      version: 1,
    },
  ];

  if (role === 'reviewer') {
    ledgers.push({
      scope: 'task',
      kind: 'iteration',
      limit: 5,
      consumed: 1,
      reservations: [{ reservationId: 'res-5', keyedId: 'req-prov-001', amount: 1 }],
      unit: 'count',
      configurationId: 'config-uc03-v1',
      version: 1,
    });
  }

  return ledgers;
}

// 1. ProviderUsage validation tests
test('ProviderUsage validation: accepts valid usage with inputTokens, outputTokens, costUsd, and billableTokens', (): void => {
  const usage = createValidProviderUsage();
  const res = validateProviderUsage(usage);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.inputTokens, 1200);
    assert.equal(res.value.outputTokens, 450);
    assert.equal(res.value.costUsd, 0.015);
    assert.equal(res.value.billableTokens, 1750);
  }

  // Without optional billableTokens
  const withoutOverhead = {
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.002,
  };
  const res2 = validateProviderUsage(withoutOverhead);
  assert.equal(res2.ok, true);
});

test('ProviderUsage validation: rejects non-object, negative, float, NaN, or infinite limits', (): void => {
  assert.equal(validateProviderUsage(null).ok, false);
  assert.equal(validateProviderUsage('not-an-object').ok, false);
  assert.equal(validateProviderUsage([]).ok, false);

  // Negative tokens
  assert.equal(validateProviderUsage({ inputTokens: -1, outputTokens: 10, costUsd: 0.01 }).ok, false);
  assert.equal(validateProviderUsage({ inputTokens: 10, outputTokens: -5, costUsd: 0.01 }).ok, false);

  // Float tokens (tokens must be integers)
  assert.equal(validateProviderUsage({ inputTokens: 10.5, outputTokens: 10, costUsd: 0.01 }).ok, false);
  assert.equal(validateProviderUsage({ inputTokens: 10, outputTokens: 2.25, costUsd: 0.01 }).ok, false);

  // Negative cost
  assert.equal(validateProviderUsage({ inputTokens: 10, outputTokens: 10, costUsd: -0.01 }).ok, false);

  // NaN or Infinity
  assert.equal(validateProviderUsage({ inputTokens: NaN, outputTokens: 10, costUsd: 0.01 }).ok, false);
  assert.equal(validateProviderUsage({ inputTokens: 10, outputTokens: Infinity, costUsd: 0.01 }).ok, false);
  assert.equal(validateProviderUsage({ inputTokens: 10, outputTokens: 10, costUsd: Infinity }).ok, false);
});

test('ProviderUsage validation: rejects unknown properties', (): void => {
  const withUnknown = {
    ...createValidProviderUsage(),
    unexpectedField: 'unauthorized',
  };
  const res = validateProviderUsage(withUnknown);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'UNKNOWN_PROPERTY'));
  }
});

test('ProviderUsage validation: rejects billableTokens less than sum of input and output tokens', (): void => {
  const invalidOverhead = {
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.02,
    billableTokens: 1400, // less than 1000 + 500!
  };
  const res = validateProviderUsage(invalidOverhead);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'INVALID_BILLABLE_TOKENS'));
  }
});

// 2. ModelProposal and ModelResult validation tests
test('ModelProposal validation: accepts valid proposal with actions and rejects unknown properties', (): void => {
  const proposal: ModelProposal = {
    proposalId: 'prop-001',
    content: 'Here is the proposed fix in calculator.py',
    actions: [
      {
        actionId: 'act-patch-1',
        kind: 'apply_patch',
        patchContent: '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1 +1 @@\n- x\n+ y\n',
        targetPaths: ['src/calculator.py'],
        baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
    ],
  };
  const res = validateModelProposal(proposal);
  assert.equal(res.ok, true);

  // Unknown property
  const unknownProp = {
    ...proposal,
    unauthorizedTelemetry: true,
  };
  const resUnknown = validateModelProposal(unknownProp);
  assert.equal(resUnknown.ok, false);
  if (!resUnknown.ok) {
    assert.ok(resUnknown.errors.some((e) => e.code === 'UNKNOWN_PROPERTY'));
  }
});

test('ModelProposal validation: recursively rejects invalid actions (forbidden chars, escaping paths, etc.)', (): void => {
  const badActionProposal = {
    proposalId: 'prop-bad-action',
    content: 'Attempting directory escape action',
    actions: [
      {
        actionId: 'act-escape',
        kind: 'apply_patch',
        patchContent: 'diff',
        targetPaths: ['../outside.py'], // escaping relative path!
        baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
    ],
  };
  const res = validateModelProposal(badActionProposal);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'WORKSPACE_ESCAPE'));
  }
});

test('ModelResult validation: accepts valid result and rejects invalid proposal or usage', (): void => {
  const result: ModelResult = {
    proposal: {
      proposalId: 'prop-001',
      content: 'Fix proposed',
    },
    observedUsage: createValidProviderUsage(),
  };
  const res = validateModelResult(result);
  assert.equal(res.ok, true);

  // Bad proposal
  assert.equal(validateModelResult({ ...result, proposal: { proposalId: '' } }).ok, false);

  // Bad usage
  assert.equal(validateModelResult({ ...result, observedUsage: { inputTokens: -1 } }).ok, false);

  // Unknown property
  assert.equal(validateModelResult({ ...result, extraScore: 99 }).ok, false);
});

// 3. ProviderRequest validation tests
test('ProviderRequest validation: accepts valid reserved request with coder/reviewer role, ceilings, and digests', (): void => {
  const coderReq = createValidProviderRequest('coder');
  const resCoder = validateProviderRequest(coderReq);
  assert.equal(resCoder.ok, true);
  if (resCoder.ok) {
    assert.equal(resCoder.value.role, 'coder');
    assert.equal(resCoder.value.dispatchState, 'reserved');
  }

  const reviewerReq = createValidProviderRequest('reviewer');
  const resReviewer = validateProviderRequest(reviewerReq);
  assert.equal(resReviewer.ok, true);
  if (resReviewer.ok) {
    assert.equal(resReviewer.value.role, 'reviewer');
  }
});

test('ProviderRequest validation: rejects unknown properties or invalid roles', (): void => {
  const unknownProp = {
    ...createValidProviderRequest(),
    arbitraryExecutionFlag: true,
  };
  assert.equal(validateProviderRequest(unknownProp).ok, false);

  const invalidRole = {
    ...createValidProviderRequest(),
    role: 'administrator',
  };
  assert.equal(validateProviderRequest(invalidRole).ok, false);
});

test('ProviderRequest validation: rejects missing, negative, NaN, infinite, or unsafe token/cost limits', (): void => {
  const base = createValidProviderRequest();

  // Negative timeout
  assert.equal(validateProviderRequest({ ...base, timeoutMs: -100 }).ok, false);

  // Float tokens (tokens must be finite non-negative integers)
  assert.equal(validateProviderRequest({ ...base, maxInputTokens: 500.5 }).ok, false);
  assert.equal(validateProviderRequest({ ...base, maxOutputTokens: -1 }).ok, false);
  assert.equal(validateProviderRequest({ ...base, maxBillableTokens: NaN }).ok, false);

  // Negative or infinite cost
  assert.equal(validateProviderRequest({ ...base, maxCostUsd: -1 }).ok, false);
  assert.equal(validateProviderRequest({ ...base, maxCostUsd: Infinity }).ok, false);
});

test('ProviderRequest validation: enforces maxBillableTokens >= maxInputTokens + maxOutputTokens', (): void => {
  const base = createValidProviderRequest();
  const insufficientBillable = {
    ...base,
    maxInputTokens: 5000,
    maxOutputTokens: 5000,
    maxBillableTokens: 9000, // less than input + output ceiling!
  };
  const res = validateProviderRequest(insufficientBillable);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'INVALID_BILLABLE_CEILING'));
  }
});

test('ProviderRequest validation: discriminates dispatchState (reserved, dispatched, settled, uncertain)', (): void => {
  const base = createValidProviderRequest();
  const validUsage = createValidProviderUsage();

  // Reserved cannot have observedUsage or uncertainReason
  const reservedWithUsage = {
    ...base,
    dispatchState: 'reserved' as const,
    observedUsage: validUsage,
  };
  assert.equal(validateProviderRequest(reservedWithUsage).ok, false);

  // Dispatched cannot have observedUsage or uncertainReason
  const dispatched = {
    ...base,
    dispatchState: 'dispatched' as const,
  };
  assert.equal(validateProviderRequest(dispatched).ok, true);

  const dispatchedWithUsage = {
    ...base,
    dispatchState: 'dispatched' as const,
    observedUsage: validUsage,
  };
  assert.equal(validateProviderRequest(dispatchedWithUsage).ok, false);

  // Settled requires observedUsage and cannot have uncertainReason
  const settledValid = {
    ...base,
    dispatchState: 'settled' as const,
    observedUsage: validUsage,
  };
  assert.equal(validateProviderRequest(settledValid).ok, true);

  const settledMissingUsage = {
    ...base,
    dispatchState: 'settled' as const,
    observedUsage: undefined,
  };
  assert.equal(validateProviderRequest(settledMissingUsage).ok, false);

  // Uncertain requires uncertainReason; observedUsage is optional
  const uncertainValid = {
    ...base,
    dispatchState: 'uncertain' as const,
    uncertainReason: 'Gateway timeout after 30000ms prior to response headers',
  };
  assert.equal(validateProviderRequest(uncertainValid).ok, true);

  const uncertainMissingReason = {
    ...base,
    dispatchState: 'uncertain' as const,
    uncertainReason: undefined,
  };
  assert.equal(validateProviderRequest(uncertainMissingReason).ok, false);
});

test('ProviderRequest validation: checks trusted expected request identity context and rejects mismatches', (): void => {
  const req = createValidProviderRequest('coder');
  const validContext: ProviderRequestValidationContext = {
    expectedTaskId: req.taskId,
    expectedRunId: req.runId,
    expectedRole: 'coder',
    expectedPurpose: req.purpose,
    expectedProviderId: req.providerId,
    expectedModelId: req.modelId,
    expectedConfigId: req.configId,
    expectedPricingPolicyId: req.pricingPolicyId,
    expectedContextDigest: req.contextDigest,
    expectedProviderRequestId: req.providerRequestId,
  };

  const matchingRes = validateProviderRequest(req, validContext);
  assert.equal(matchingRes.ok, true);

  // Mismatch in role
  const badRoleCtx: ProviderRequestValidationContext = { ...validContext, expectedRole: 'reviewer' };
  const resBadRole = validateProviderRequest(req, badRoleCtx);
  assert.equal(resBadRole.ok, false);
  if (!resBadRole.ok) {
    assert.ok(resBadRole.errors.some((e) => e.code === 'REQUEST_IDENTITY_MISMATCH'));
  }

  // Mismatch in context digest
  const badDigestCtx: ProviderRequestValidationContext = { ...validContext, expectedContextDigest: 'sha256:different' };
  assert.equal(validateProviderRequest(req, badDigestCtx).ok, false);
});

// 4. ReservationBundle validation tests
test('ReservationBundle validation: accepts valid bundle with transactionRef and per-scope reservations', (): void => {
  const bundle = createValidReservationBundle('coder');
  const res = validateReservationBundle(bundle);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.transactionRef, 'tx-atomic-001');
    assert.equal(res.value.reservations.length, 4);
  }
});

test('ReservationBundle validation: rejects bundle missing transactionRef or with invalid/negative amounts', (): void => {
  const noTxRef = {
    ...createValidReservationBundle(),
    transactionRef: '',
  };
  assert.equal(validateReservationBundle(noTxRef).ok, false);

  const negAmount = {
    ...createValidReservationBundle(),
    reservations: [
      {
        ledgerIdentity: 'ledger-task-tokens',
        scope: 'task' as const,
        kind: 'tokens',
        configurationId: 'config-uc03-v1',
        version: 1,
        requestId: 'req-prov-001',
        amount: -500,
      },
    ],
  };
  assert.equal(validateReservationBundle(negAmount).ok, false);
});

test('ReservationBundle validation: rejects unknown properties on bundle and items', (): void => {
  const unknownBundleProp = {
    ...createValidReservationBundle(),
    bypassCheck: true,
  };
  assert.equal(validateReservationBundle(unknownBundleProp).ok, false);

  const unknownItemProp = {
    ...createValidReservationBundle(),
    reservations: [
      {
        ...createValidReservationBundle().reservations[0],
        overdraftAllowed: true,
      },
    ],
  };
  assert.equal(validateReservationBundle(unknownItemProp).ok, false);
});

// 5. Shared Dispatch Admission Predicate tests
test('validateDispatchAdmission: accepts valid coder request with full task/run token and cost reservations', (): void => {
  const req = createValidProviderRequest('coder');
  const bundle = createValidReservationBundle('coder');
  const ledgers = createMatchingLedgers('coder');

  const context: DispatchAdmissionContext = {
    reservationBundle: bundle,
    ledgers,
  };

  const res = validateDispatchAdmission(req, context);
  assert.equal(res.ok, true);
  assert.equal(isAdmittedForDispatch(req, context), true);
});

test('validateDispatchAdmission: accepts valid reviewer request with task/run token, cost, and reviewer iteration reservations', (): void => {
  const req = createValidProviderRequest('reviewer');
  const bundle = createValidReservationBundle('reviewer');
  const ledgers = createMatchingLedgers('reviewer');

  const context: DispatchAdmissionContext = {
    reservationBundle: bundle,
    ledgers,
  };

  const res = validateDispatchAdmission(req, context);
  assert.equal(res.ok, true);
  assert.equal(isAdmittedForDispatch(req, context), true);
});

test('validateDispatchAdmission: rejects bare ref or missing context (untrusted claimed reservation alone cannot permit dispatch)', (): void => {
  const req = createValidProviderRequest('coder');

  // Bare request without context must NOT authorize
  assert.equal(isAdmittedForDispatch(req, null), false);
  assert.equal(isAdmittedForDispatch(req, undefined), false);

  const resBare = validateDispatchAdmission(req, {});
  assert.equal(resBare.ok, false);
  if (!resBare.ok) {
    assert.ok(resBare.errors.some((e) => e.code === 'ABSENT_RESERVATION_BUNDLE' || e.code === 'UNTRUSTED_DISPATCH_AUTHORIZATION'));
  }
});

test('validateDispatchAdmission: rejects telemetry estimate (bare ref or telemetry estimate must NOT authorize)', (): void => {
  const req = createValidProviderRequest('coder');
  const bundle = createValidReservationBundle('coder');
  const ledgers = createMatchingLedgers('coder');

  const contextWithTelemetry: DispatchAdmissionContext = {
    reservationBundle: bundle,
    ledgers,
    isTelemetryEstimate: true,
  };

  const res = validateDispatchAdmission(req, contextWithTelemetry);
  assert.equal(res.ok, false);
  assert.equal(isAdmittedForDispatch(req, contextWithTelemetry), false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'TELEMETRY_ESTIMATE_CANNOT_AUTHORIZE'));
  }
});

test('validateDispatchAdmission: rejects partial reservation bundle (missing run cost, task token, or reviewer iteration)', (): void => {
  const req = createValidProviderRequest('coder');
  const bundle = createValidReservationBundle('coder');
  const ledgers = createMatchingLedgers('coder');

  // Missing run cost reservation
  const partialBundle: ReservationBundle = {
    ...bundle,
    reservations: bundle.reservations.filter((r) => !(r.scope === 'run' && r.kind === 'cost')),
  };

  const res = validateDispatchAdmission(req, { reservationBundle: partialBundle, ledgers });
  assert.equal(res.ok, false);
  assert.equal(isAdmittedForDispatch(req, { reservationBundle: partialBundle, ledgers }), false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'PARTIAL_RESERVATION'));
  }

  // Reviewer role missing iteration reservation
  const reviewerReq = createValidProviderRequest('reviewer');
  const reviewerBundleNoIteration = createValidReservationBundle('coder'); // coder bundle has no iteration reservation
  const reviewerLedgers = createMatchingLedgers('reviewer');

  const resReviewer = validateDispatchAdmission(reviewerReq, {
    reservationBundle: reviewerBundleNoIteration,
    ledgers: reviewerLedgers,
  });
  assert.equal(resReviewer.ok, false);
  if (!resReviewer.ok) {
    assert.ok(resReviewer.errors.some((e) => e.code === 'PARTIAL_RESERVATION'));
  }
});

test('validateDispatchAdmission: rejects exhausted budget (ledger limit exceeded)', (): void => {
  const req = createValidProviderRequest('coder');
  const bundle = createValidReservationBundle('coder');
  const ledgers = createMatchingLedgers('coder');

  // Exhausted task cost ledger (consumed 4.95 out of 5.0, requesting 0.15 exceeds limit 5.0)
  const exhaustedLedgers = ledgers.map((l) => {
    if (l.scope === 'task' && l.kind === 'cost') {
      return {
        ...l,
        consumed: 4.95,
        reservations: [],
      };
    }
    return l;
  });

  const res = validateDispatchAdmission(req, { reservationBundle: bundle, ledgers: exhaustedLedgers });
  assert.equal(res.ok, false);
  assert.equal(isAdmittedForDispatch(req, { reservationBundle: bundle, ledgers: exhaustedLedgers }), false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'BUDGET_EXHAUSTED'));
  }
});

test('validateDispatchAdmission: rejects mismatched task, run, or request IDs', (): void => {
  const req = createValidProviderRequest('coder');
  const bundle = createValidReservationBundle('coder');
  const ledgers = createMatchingLedgers('coder');

  // Bundle for different task
  const badTaskBundle = { ...bundle, taskId: 'different-task-id' };
  assert.equal(validateDispatchAdmission(req, { reservationBundle: badTaskBundle, ledgers }).ok, false);

  // Bundle for different request
  const badReqBundle: ReservationBundle = {
    ...bundle,
    reservations: bundle.reservations.map((r) => ({ ...r, requestId: 'different-req-id' })),
  };
  assert.equal(validateDispatchAdmission(req, { reservationBundle: badReqBundle, ledgers }).ok, false);
});

test('validateDispatchAdmission: rejects uncertain request (uncertain retains charge and cannot replay)', (): void => {
  const uncertainReq: ProviderRequest = {
    ...createValidProviderRequest('coder'),
    dispatchState: 'uncertain',
    uncertainReason: 'Network socket reset',
  };
  const bundle = createValidReservationBundle('coder');
  const ledgers = createMatchingLedgers('coder');

  const res = validateDispatchAdmission(uncertainReq, { reservationBundle: bundle, ledgers });
  assert.equal(res.ok, false);
  assert.equal(isAdmittedForDispatch(uncertainReq, { reservationBundle: bundle, ledgers }), false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'UNCERTAIN_CANNOT_REPLAY' || e.code === 'INVALID_DISPATCH_STATE'));
  }
});

// 6. Budget error classes and ModelPort typed outcome tests
test('Budget error classes: instantiate with typed codes and details', (): void => {
  const exErr = new BudgetExhaustionError('Tokens limit exhausted', { scope: 'task', kind: 'tokens', limit: 1000, requested: 1500 });
  assert.equal(exErr.code, 'BUDGET_EXHAUSTED');
  assert.equal(exErr.details?.scope, 'task');

  const confErr = new BudgetConflictError('CAS version conflict in ledger', { scope: 'task', kind: 'cost', version: 3 });
  assert.equal(confErr.code, 'BUDGET_CONFLICT');
  assert.equal(confErr.details?.version, 3);
});

test('ModelPort and observed usage accounting: observed malformed-response usage remains valid accounting', (): void => {
  // Even if a model proposal response is malformed or invalid schema,
  // observedUsage returned by the provider is still valid accounting and can be validated.
  const malformedProposal = {
    proposalId: 'prop-malformed',
    content: 'Truncated json output',
    actions: 'not-an-array' as unknown as readonly unknown[],
  };
  assert.equal(validateModelProposal(malformedProposal).ok, false);

  // But the provider usage recorded during that failed call is valid
  const observedUsageFromFailedCall = {
    inputTokens: 5000,
    outputTokens: 200,
    costUsd: 0.05,
    billableTokens: 5200,
  };
  const usageRes = validateProviderUsage(observedUsageFromFailedCall);
  assert.equal(usageRes.ok, true);

  // ModelPort typed outcomes verify discriminated union shape
  const observedOutcome: ModelPortResult = {
    outcome: 'observed',
    result: {
      proposal: { proposalId: 'prop-1', content: 'ok' },
      observedUsage: createValidProviderUsage(),
    },
  };
  assert.equal(observedOutcome.outcome, 'observed');

  const uncertainOutcome: ModelPortResult = {
    outcome: 'uncertain',
    reason: 'Timeout waiting for provider headers',
  };
  assert.equal(uncertainOutcome.outcome, 'uncertain');

  const deniedOutcome: ModelPortResult = {
    outcome: 'denied',
    reason: 'Task budget tokens exhausted prior to network dispatch',
  };
  assert.equal(deniedOutcome.outcome, 'denied');

  const invalidOutcome: ModelPortResult = {
    outcome: 'invalid',
    errors: [{ path: 'proposal.actions', message: 'Invalid action', code: 'INVALID_TYPE' }],
    observedUsage: observedUsageFromFailedCall,
  };
  assert.equal(invalidOutcome.outcome, 'invalid');
  assert.equal(invalidOutcome.observedUsage?.costUsd, 0.05);
});
