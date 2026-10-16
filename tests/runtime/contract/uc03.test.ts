import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBugTask,
  validateExecutionLimits,
  validateBudgetLimits,
  validateNormalizedAction,
  validateApprovalBinding,
  validateCommandView,
  validateTaskEnvelope,
  validateTaskNode,
  validateTaskOutcome,
  validateEnvelopeOutcome,
  validatePlanStep,
  validateFixPlan,
  validateBudgetLedger,
  validateTaskState,
  validateStateTransition,
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

test('ExecutionLimits validation: accepts minimal execution limits without optional fields', (): void => {
  const limits = {
    timeoutMs: 10000,
    maxOutputBytes: 65536,
  };
  const res = validateExecutionLimits(limits);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.timeoutMs, 10000);
    assert.equal(res.value.maxOutputBytes, 65536);
    assert.equal(res.value.maxCpuCores, undefined);
  }
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
  const missingPlanFields: ApprovalBinding = {
    decisionId: 'dec-plan-bad',
    actionKind: 'fix_plan',
    normalizedActionDigest: 'sha256:plan-digest',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    repositoryRevisionDigest: 'sha256:repo-rev-123',
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    status: 'pending',
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
