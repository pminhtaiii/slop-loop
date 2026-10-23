/**
 * UC-03 Phase 5 - Authoritative Execution Guard Contract Tests (T021)
 *
 * Owned path: tests/runtime/contract/execution-guard.test.ts
 * Feature: specs/001-verified-code-repair
 *
 * Acceptance Checks for T021:
 * - Tests execute against actual ExecutionGuard SUT in src/foundation/execution-guard.ts.
 * - Injected dependencies use T004 controlled port mocks (MemoryStatePort, ScriptedApprovalPort, FakeRepositoryPort).
 * - Verifies port provenance and rejection of mock ports by isAdmittedForProduction.
 * - Asserts zero dispatch before valid configuration and limits.
 * - Asserts zero dispatch before valid isolation and command-view freshness.
 * - Asserts zero dispatch before atomic budget reservation in StatePort.
 * - Asserts zero dispatch on FORBIDDEN action and delegation to ApprovalPort (no UC-05 policy reimplementation).
 * - Asserts pending, rejected, and stale decision handling with zero repository dispatch.
 * - Asserts exact action identity enforcement against approved bindings.
 * - Asserts CAS conflict handling returning conflict outcome without unhandled crashes.
 * - Asserts uncertain-effect reconciliation and retained reservations.
 * - Behavioral RED: Valid action success expectation fails behaviorally against neutral no-dispatch skeleton.
 * - Zero collection/import/type failures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type TaskState,
  type ApplyPatchAction,
  type RunCommandAction,
  type ApprovalBinding,
  type CommandView,
  computeCanonicalSha256,
  isAdmittedForProduction,
} from '../../../src/contracts/foundation/uc03.ts';
import { MemoryStatePort } from '../support/uc03/memory-state.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import {
  createFixtureTaskState,
  createFixtureBugTask,
  createFixtureExecutionLimits,
  createFixtureBudgetLimits,
} from '../support/uc03/port-fixtures.ts';
import {
  createExecutionGuard,
  AuthoritativeExecutionGuard,
  type ExecutionGuardPorts,
  type ExecutionGuardOptions,
} from '../../../src/foundation/execution-guard.ts';

function createTestHarness(options?: {
  readonly initialFiles?: Readonly<Record<string, string>> | undefined;
  readonly classifications?: Readonly<Record<string, 'ALLOWED' | 'APPROVAL_REQUIRED' | 'FORBIDDEN'>> | undefined;
  readonly decisions?: readonly ApprovalBinding[] | undefined;
  readonly initialTaskState?: TaskState | undefined;
  readonly commandView?: CommandView | undefined;
  readonly guardProvenance?: 'mock' | 'real' | undefined;
}) {
  const taskState = options?.initialTaskState ?? createFixtureTaskState();
  const statePort = new MemoryStatePort({ initialTaskState: taskState });
  const approvalPort = new ScriptedApprovalPort({
    classifications: options?.classifications,
    decisions: options?.decisions,
  });
  const repositoryPort = new FakeRepositoryPort({
    initialFiles: options?.initialFiles ?? {
      'src/calculator.py': 'class Calculator:\n    def divide(self, a, b):\n        return a / b\n',
      'tests/test_calculator.py': 'import pytest\nfrom src.calculator import Calculator\n\ndef test_divide():\n    calc = Calculator()\n    assert calc.divide(10, 2) == 5\n',
    },
  });

  const ports: ExecutionGuardPorts = {
    statePort,
    approvalPort,
    repositoryPort,
  };

  const guardOptions: ExecutionGuardOptions = {
    ports,
    config: {
      provenance: options?.guardProvenance ?? 'mock',
      commandView: options?.commandView,
    },
  };

  const guard = createExecutionGuard(guardOptions);

  return {
    guard,
    ports,
    statePort,
    approvalPort,
    repositoryPort,
    taskState,
  };
}

function createValidPatchAction(overrides?: Partial<ApplyPatchAction>): ApplyPatchAction {
  const patchContent = [
    '--- a/src/calculator.py',
    '+++ b/src/calculator.py',
    '@@ -2,2 +2,4 @@',
    '     def divide(self, a, b):',
    '+        if b == 0:',
    '+            raise ValueError("divisor cannot be zero")',
    '         return a / b',
    '',
  ].join('\n');

  return {
    actionId: 'act-patch-001',
    kind: 'apply_patch',
    patchContent,
    targetPaths: ['src/calculator.py'],
    baseRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ...overrides,
  };
}

function createValidCommandAction(overrides?: Partial<RunCommandAction>): RunCommandAction {
  return {
    actionId: 'act-cmd-001',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    workingDirectory: 'tests',
    purpose: 'reproduction',
    ...overrides,
  };
}

function createValidCommandView(overrides?: Partial<CommandView>): CommandView {
  return {
    viewId: 'view-cmd-001',
    viewDigest: 'sha256:viewdigest0123456789abcdef0123456789abcdef0123456789abcdef',
    taskId: 'task-calc-001',
    workspaceId: 'workspace-001',
    canonicalRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    admittedFiles: [
      {
        path: 'src/calculator.py',
        digest: 'sha256:file0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      },
      {
        path: 'tests/test_calculator.py',
        digest: 'sha256:fileabcdef0123456789abcdef0123456789abcdef0123456789abcdef01',
      },
    ],
    exclusionsPolicyVersion: '1.0.0',
    scratchIdentity: 'scratch-vol-001',
    mountedReadOnly: true,
    ...overrides,
  };
}

// =========================================================================
// SECTION 1: Port Provenance & Production Guard Rejection
// =========================================================================

test('ExecutionGuard: declares port provenance and is evaluated by isAdmittedForProduction', () => {
  const { guard } = createTestHarness();
  assert.equal(guard.provenance, 'mock', 'Guard must declare mock provenance by default in test configuration');
  assert.equal(
    isAdmittedForProduction([guard]),
    false,
    'Production guard must reject mock execution guard'
  );
  assert.ok(guard instanceof AuthoritativeExecutionGuard, 'Guard is instance of AuthoritativeExecutionGuard SUT');
});

test('ExecutionGuard: class instance provenance is recognized without admitting mock dependencies or execution', async () => {
  const { guard, ports, repositoryPort } = createTestHarness({ guardProvenance: 'real' });
  assert.equal(guard.provenance, 'real');
  assert.equal(isAdmittedForProduction([guard]), true, 'Own real provenance is recognized on the guard class instance');
  assert.equal(
    isAdmittedForProduction([guard, ports.statePort, ports.approvalPort, ports.repositoryPort]),
    false,
    'Mock dependencies prevent overall production admission even if guard claims real provenance'
  );

  const result = await guard.validateAndExecute(createValidPatchAction(), createFixtureTaskState());
  assert.equal(result.outcome, 'denied', 'T021 guard remains neutral and no-dispatch');
  assert.equal(repositoryPort.patches.length, 0, 'Provenance admission does not imply patch execution');
});

// =========================================================================
// SECTION 2: Pre-Dispatch Zero-Dispatch Invariants (Config & Limits)
// =========================================================================

test('Zero dispatch: invalid or malformed task state halts before calling ports', async () => {
  const { guard, repositoryPort } = createTestHarness();
  const invalidState = {
    ...createFixtureTaskState(),
    schemaVersion: 'invalid.version',
    taskId: '',
  } as unknown as TaskState;

  const patchAction = createValidPatchAction();
  const result = await guard.validateAndExecute(patchAction, invalidState);

  assert.equal(result.outcome, 'denied', 'Invalid task state must be denied before execution');
  assert.equal(repositoryPort.patches.length, 0, 'Zero dispatch to repositoryPort on invalid task state');
  assert.equal(repositoryPort.commands.length, 0, 'Zero dispatch to repositoryPort commands');
});

test('Zero dispatch: missing or unbounded execution limits halt execution before dispatch', async () => {
  const { guard, repositoryPort } = createTestHarness();
  const unboundedTask = createFixtureBugTask({
    limits: {
      ...createFixtureExecutionLimits(),
      timeoutMs: -1, // invalid finite timeout
    },
  });
  const stateWithUnboundedLimits = createFixtureTaskState({
    taskContext: unboundedTask,
  });

  const patchAction = createValidPatchAction();
  const result = await guard.validateAndExecute(patchAction, stateWithUnboundedLimits);

  assert.equal(result.outcome, 'denied', 'Missing or unbounded limits must fail closed before execution');
  assert.equal(repositoryPort.patches.length, 0, 'Zero dispatch to repositoryPort on unbounded limits');
});

// =========================================================================
// SECTION 3: Pre-Dispatch Zero-Dispatch (Isolation & Command View Boundary)
// =========================================================================

test('Zero dispatch: command execution without admitted command view halts before repository dispatch', async () => {
  // Command view omitted in guard options
  const { guard, repositoryPort } = createTestHarness();
  const cmdAction = createValidCommandAction();

  const result = await guard.validateAndExecute(cmdAction, createFixtureTaskState());

  assert.equal(result.outcome, 'denied', 'Command execution without fresh admitted command view must be denied');
  assert.equal(repositoryPort.commands.length, 0, 'Zero dispatch to repositoryPort.runCommand');
});

test('Zero dispatch: stale command view revision drift halts execution before dispatch', async () => {
  const staleView = createValidCommandView({
    canonicalRevisionDigest: 'sha256:staledigest00000000000000000000000000000000000000000000000000',
  });
  const { guard, repositoryPort } = createTestHarness({ commandView: staleView });
  const cmdAction = createValidCommandAction();

  const result = await guard.validateAndExecute(cmdAction, createFixtureTaskState());

  assert.equal(result.outcome, 'denied', 'Stale command view with revision drift must be denied');
  assert.equal(repositoryPort.commands.length, 0, 'Zero dispatch to repositoryPort.runCommand on stale view');
});

// =========================================================================
// SECTION 4: Zero Dispatch Before Budget Reservation
// =========================================================================

test('Zero dispatch: exhausted or missing budget stops execution before repository dispatch', async () => {
  const task = createFixtureBugTask({
    budgetLimits: {
      ...createFixtureBudgetLimits(),
      maxRepairAttempts: 0,
    },
  });
  const exhaustedState = createFixtureTaskState({
    taskContext: task,
  });

  const { guard, repositoryPort } = createTestHarness({ initialTaskState: exhaustedState });
  const patchAction = createValidPatchAction();

  const result = await guard.validateAndExecute(patchAction, exhaustedState);

  assert.equal(result.outcome, 'denied', 'Exhausted budget must halt before repository modification');
  assert.equal(repositoryPort.patches.length, 0, 'Zero dispatch to repositoryPort.applyPatch on exhausted budget');
});

// =========================================================================
// SECTION 5: Approval Classification & Decision Handling (UC-05 Delegation)
// =========================================================================

test('Approval handling: FORBIDDEN action is denied unconditionally with zero repository dispatch', async () => {
  const forbiddenCmd = createValidCommandAction({
    executable: 'rm',
    argv: ['-rf', '/'],
  });
  const cmdKey = `${forbiddenCmd.executable} ${forbiddenCmd.argv.join(' ')}`;

  const { guard, repositoryPort } = createTestHarness({
    classifications: {
      [cmdKey]: 'FORBIDDEN',
    },
  });

  const result = await guard.validateAndExecute(forbiddenCmd, createFixtureTaskState());

  assert.equal(result.outcome, 'denied', 'FORBIDDEN action must be denied unconditionally');
  assert.equal(repositoryPort.commands.length, 0, 'Zero dispatch to repositoryPort on FORBIDDEN action');
});

test('Approval handling: rejected decision terminates with denial and zero repository dispatch', async () => {
  const patchAction = createValidPatchAction();
  const rejectedBinding: ApprovalBinding = {
    decisionId: 'dec-rejected-001',
    actionKind: 'action',
    normalizedActionDigest: computeCanonicalSha256(patchAction),
    taskId: 'task-calc-001',
    workspaceId: 'workspace-001',
    repositoryRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    status: 'rejected',
    reason: 'Reviewer rejected patch strategy',
  };

  const { guard, repositoryPort } = createTestHarness({
    classifications: {
      [patchAction.actionId]: 'APPROVAL_REQUIRED',
    },
    decisions: [rejectedBinding],
  });

  const result = await guard.validateAndExecute(patchAction, createFixtureTaskState());

  assert.equal(result.outcome, 'denied', 'Rejected decision must result in denied outcome');
  assert.equal(repositoryPort.patches.length, 0, 'Zero dispatch to repositoryPort on rejected decision');
});

test('Approval handling: stale approval binding rejects execution with zero repository dispatch', async () => {
  const patchAction = createValidPatchAction();
  const staleBinding: ApprovalBinding = {
    decisionId: 'dec-stale-001',
    actionKind: 'action',
    normalizedActionDigest: computeCanonicalSha256(patchAction),
    taskId: 'task-calc-001',
    workspaceId: 'workspace-001',
    repositoryRevisionDigest: 'sha256:staledigest00000000000000000000000000000000000000000000000000',
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    status: 'stale',
    reason: 'Repository revision advanced since approval was granted',
  };

  const { guard, repositoryPort } = createTestHarness({
    classifications: {
      [patchAction.actionId]: 'APPROVAL_REQUIRED',
    },
    decisions: [staleBinding],
  });

  const result = await guard.validateAndExecute(patchAction, createFixtureTaskState());

  assert.equal(result.outcome, 'denied', 'Stale approval binding must reject execution');
  assert.equal(repositoryPort.patches.length, 0, 'Zero dispatch to repositoryPort on stale approval');
});

test('Exact action identity: tampered action payload fails binding authorization with zero dispatch', async () => {
  const originalAction = createValidPatchAction();
  const approvedBinding: ApprovalBinding = {
    decisionId: 'dec-approved-001',
    actionKind: 'action',
    normalizedActionDigest: computeCanonicalSha256(originalAction),
    taskId: 'task-calc-001',
    workspaceId: 'workspace-001',
    repositoryRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    status: 'approved',
  };

  const { guard, repositoryPort } = createTestHarness({
    classifications: {
      [originalAction.actionId]: 'APPROVAL_REQUIRED',
    },
    decisions: [approvedBinding],
  });

  // Tamper: same actionId, but different patch content
  const tamperedAction = createValidPatchAction({
    patchContent: '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1 +1 @@\n- malicious code\n',
  });

  const result = await guard.validateAndExecute(tamperedAction, createFixtureTaskState());

  assert.equal(result.outcome, 'denied', 'Tampered action failing exact digest match must be denied');
  assert.equal(repositoryPort.patches.length, 0, 'Zero dispatch to repositoryPort on tampered action');
});

// =========================================================================
// SECTION 6: Behavioral RED Expectations (Executable Checks Failing against Skeleton)
// =========================================================================

test('Approval handling: pending approval returns pending-approval outcome (behavioral RED against skeleton)', async () => {
  const patchAction = createValidPatchAction();
  const pendingBinding: ApprovalBinding = {
    decisionId: 'dec-pending-001',
    actionKind: 'action',
    normalizedActionDigest: computeCanonicalSha256(patchAction),
    taskId: 'task-calc-001',
    workspaceId: 'workspace-001',
    repositoryRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    status: 'pending',
  };

  const { guard, repositoryPort } = createTestHarness({
    classifications: {
      [patchAction.actionId]: 'APPROVAL_REQUIRED',
    },
    decisions: [pendingBinding],
  });

  const result = await guard.validateAndExecute(patchAction, createFixtureTaskState());

  // In T021 skeleton, this fails with AssertionError: + 'denied' - 'pending-approval'
  assert.equal(
    result.outcome,
    'pending-approval',
    'Pending approval must return pending-approval outcome so caller can pause and await decision'
  );
  assert.equal(repositoryPort.patches.length, 0, 'Zero dispatch to repositoryPort while pending');
});

test('CAS conflict: state version transition conflict returns conflict outcome (behavioral RED against skeleton)', async () => {
  const { guard } = createTestHarness();
  const patchAction = createValidPatchAction();

  // Create state with mismatched expectedStateVersion (simulating concurrent state modification)
  const staleState: TaskState = {
    ...createFixtureTaskState(),
    stateVersion: 999, // Mismatched version triggering CAS conflict
  };

  const result = await guard.validateAndExecute(patchAction, staleState);

  // In T021 skeleton, this fails with AssertionError: + 'denied' - 'conflict'
  assert.equal(
    result.outcome,
    'conflict',
    'State CAS conflict must return conflict outcome rather than crashing or replaying blindly'
  );
});

test('Uncertain effect: execution timeout/uncertainty returns uncertain-effect outcome (behavioral RED against skeleton)', async () => {
  const { guard, repositoryPort } = createTestHarness({
    commandView: createValidCommandView(),
    classifications: { 'pytest -q tests/test_calculator.py': 'ALLOWED' },
  });
  let invocations = 0;
  repositoryPort.runCommand = async () => {
    invocations++;
    throw new Error('simulated timeout after command handoff; physical outcome is unknown');
  };
  const cmdAction = createValidCommandAction({
    purpose: 'timeout-simulation',
  });

  const result = await guard.validateAndExecute(cmdAction, createFixtureTaskState());

  // In T021 skeleton, this fails with AssertionError: + 'denied' - 'uncertain-effect'
  assert.equal(
    result.outcome,
    'uncertain-effect',
    'Execution timeout or unverified effect must return uncertain-effect outcome to trigger reconciliation'
  );
  assert.equal(invocations, 1, 'The uncertainty branch is exercised only after a valid admitted command reaches the adapter');
});

test('Valid action execution: fully authorized patch executes cleanly and returns success (behavioral RED against skeleton)', async () => {
  const patchAction = createValidPatchAction();
  const approvedBinding: ApprovalBinding = {
    decisionId: 'dec-approved-valid-001',
    actionKind: 'action',
    normalizedActionDigest: computeCanonicalSha256(patchAction),
    taskId: 'task-calc-001',
    workspaceId: 'workspace-001',
    repositoryRevisionDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policyId: 'policy-default',
    policyVersion: '1.0.0',
    status: 'approved',
  };

  const { guard, repositoryPort } = createTestHarness({
    classifications: {
      [patchAction.actionId]: 'ALLOWED',
    },
    decisions: [approvedBinding],
  });

  const result = await guard.validateAndExecute(patchAction, createFixtureTaskState());

  // BEHAVIORAL RED: SUT skeleton returns { outcome: 'denied', reason: 'SKELETON_NO_DISPATCH...' }
  // This assertion fails with AssertionError: + 'denied' - 'success'
  assert.equal(
    result.outcome,
    'success',
    'Valid authorized patch must execute cleanly and return success outcome'
  );
  assert.ok(result.result, 'Success result must contain patch application result');
  assert.equal(repositoryPort.patches.length, 1, 'RepositoryPort.applyPatch must be dispatched exactly once');
});
