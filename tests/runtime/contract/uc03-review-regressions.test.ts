import test from 'node:test';
import assert from 'node:assert/strict';
import { isProtectedPath, validateBugTask, validateNormalizedAction } from '../../../src/contracts/foundation/uc03.ts';

function validRunCommand(workingDirectory: string) {
  return {
    actionId: 'action-review-regression',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q'],
    workingDirectory,
  };
}

function validBugTask() {
  return {
    taskId: 'task-review-regression',
    repositoryId: 'repo-review-regression',
    initialRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    goal: 'Fix the reported behavior',
    observedBehavior: 'The observed result is incorrect',
    expectedBehavior: 'The intended result is returned',
    reproduction: 'Run the focused test',
    acceptanceCriteria: ['The focused regression passes'],
    constraints: ['Keep the public API stable'],
    requiredChecks: [{
      checkId: 'check-focused',
      executable: 'pytest',
      argv: ['-q'],
      purpose: 'focused',
      workingDirectory: '/workspace/repo',
      timeoutMs: 30000,
      maxOutputBytes: 1048576,
    }],
    limits: {
      timeoutMs: 60000,
      maxOutputBytes: 2097152,
      maxCpuCores: 2,
      maxMemoryBytes: 2147483648,
      maxPids: 64,
    },
    budgetLimits: {
      maxReplanCount: 3,
      maxTokens: 100000,
      maxCostUsd: 5,
      maxRepairAttempts: 2,
      maxReviewIterations: 2,
    },
    configId: 'config-review-regression',
    configVersion: '1.0.0',
  };
}

test('protected paths keep secret and grading rules without blocking ordinary names', () => {
  for (const protectedPath of [
    '.env',
    'credentials.json',
    'password',
    'password.json',
    'token',
    'token.txt',
    'passwords.yaml',
    'tokens.env',
    'eval/uc03/private',
    'eval/uc03/private/rubric.json',
    'private/grading/labels.json',
  ]) {
    assert.equal(isProtectedPath(protectedPath), true, `${protectedPath} remains protected`);
  }

  for (const ordinaryPath of [
    'src/tokenizer.ts',
    'src/password_reset.md',
    'src/tokens.ts',
    'src/private/cache.ts',
    'private/grading-notes.md',
  ]) {
    assert.equal(isProtectedPath(ordinaryPath), false, `${ordinaryPath} is ordinary repository content`);
  }
});

test('run-command actions reject protected working directories but accept workspace roots', () => {
  for (const workingDirectory of [
    '/workspace/repo/.git',
    '/workspace/repo/.git/hooks',
    '/workspace/repo/eval/uc03/private',
    '/workspace/repo/a/../.git',
    '/workspace/scratch/private/grading',
  ]) {
    const result = validateNormalizedAction(validRunCommand(workingDirectory));
    assert.equal(result.ok, false, `${workingDirectory} must be rejected`);
    if (!result.ok) assert.ok(result.errors.some((error) => error.code === 'PROTECTED_PATH_FORBIDDEN'));
  }

  for (const workingDirectory of [
    '/workspace/repo',
    '/workspace/scratch',
    '/workspace/repo/src/private/cache',
    '/workspace/scratch/src/private/cache',
  ]) {
    assert.equal(validateNormalizedAction(validRunCommand(workingDirectory)).ok, true, `${workingDirectory} is allowed`);
  }
});

test('BugTask validation rejects empty or whitespace-only constraints with indexed paths', () => {
  for (const constraint of ['', ' \t ']) {
    const result = validateBugTask({ ...validBugTask(), constraints: [constraint] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.some((error) => error.path === 'constraints[0]'));
  }
});
