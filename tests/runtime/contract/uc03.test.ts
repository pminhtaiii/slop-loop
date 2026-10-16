import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBugTask,
  validateExecutionLimits,
  validateBudgetLimits,
  validateNormalizedAction,
  validateApprovalBinding,
  validateCommandView,
  type BugTask,
  type CheckDefinition,
  type ExecutionLimits,
  type BudgetLimits,
  type RunCommandAction,
  type ApplyPatchAction,
  type ApproveFixPlanAction,
  type ApprovalBinding,
  type CommandView,
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
