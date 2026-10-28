import { ControlledRepositoryTools, type TrustedFilesystemPort } from '../../../src/foundation/repository-tools.ts';
import { DockerWorkspaceManager } from '../../../src/foundation/docker-workspace.ts';
import { computeAttemptOutcomeDigest } from '../../../src/contracts/foundation/uc03/v02/attempt.ts';
/**
 * UC-03 Phase 5 - Authoritative Execution Guard Contract Tests (T021 / T059 / T022)
 *
 * Owned path: tests/runtime/contract/execution-guard.test.ts
 * Feature: specs/001-verified-code-repair
 *
 * Acceptance Checks for T021, T059 & T022:
 * - Tests execute against actual ExecutionGuard SUT in src/foundation/execution-guard.ts.
 * - Injected dependencies use controlled port mocks (MemoryStatePort, MemoryStatePortV02, ScriptedApprovalPort, FakeRepositoryPort).
 * - Verifies port provenance and rejection of mock ports by isAdmittedForProduction.
 * - Asserts zero dispatch before valid configuration and limits.
 * - Asserts zero dispatch before valid isolation and command-view freshness.
 * - Asserts zero dispatch before atomic budget reservation in StatePort.
 * - Asserts zero dispatch on FORBIDDEN action and delegation to ApprovalPort (no UC-05 policy reimplementation).
 * - Asserts pending, rejected, and stale decision handling with zero repository dispatch.
 * - Asserts exact action identity enforcement against approved bindings.
 * - Asserts CAS conflict handling returning conflict outcome without unhandled crashes.
 * - Asserts uncertain-effect reconciliation and retained reservations.
 * - Preserves existing v0.1 denial and tampered-approvable-digest regressions.
 * - Add positive admission and typed receipt/state/control/context/receiver-handoff assertions against real neutral SUT.
 * - All v0.1 and v0.2 assertions pass in GREEN state for T022.
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
  type RepositoryAdmissionContextV02,
  type RepositoryPort,
  type RepositoryPortV02,
  type RepositoryPatchResultV02,
  type RepositoryCommandResultV02,
  type StatePortV02,
  computeCanonicalSha256,
  isAdmittedForProduction,
} from '../../../src/contracts/foundation/uc03.ts';
import { MemoryStatePort, MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';
import { FakeRepositoryPort, type ScriptedCommandResult } from '../support/uc03/fake-repository.ts';
import {
  createFixtureTaskState,
  createFixtureBugTask,
  createFixtureExecutionLimits,
  createFixtureBudgetLimits,
} from '../support/uc03/port-fixtures.ts';
import {
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestAdmissionTaskStateV02,
  createTestAdmissionTransitionContextsV02,
  createTestExecutorIdentityV02,
} from '../support/uc03/state-fixtures.ts';
import {
  createExecutionGuard,
  createExecutionGuardV02,
  AuthoritativeExecutionGuard,
  AuthoritativeExecutionGuardV02,
  type ExecutionGuardPorts,
  type ExecutionGuardOptions,
  type ExecutionGuardStatePortV02,
  type ExecutionGuardRepositoryPortV02,
  type ExecutionGuardPortsV02,
  type ExecutionGuardOptionsV02,
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

function createTestHarnessV02(options?: {
  readonly initialFiles?: Readonly<Record<string, string>> | undefined;
  readonly initialTaskState?: TaskState | undefined;
  readonly guardProvenance?: 'mock' | 'real' | undefined;
  readonly context?: RepositoryAdmissionContextV02 | undefined;
  readonly commandResults?: Readonly<Record<string, ScriptedCommandResult>> | undefined;
  readonly failAuthoritativeLoad?: boolean | undefined;
}) {
  const context = options?.context;
  const initialTaskState =
    options?.initialTaskState ??
    (context ? createTestAdmissionTaskStateV02(context) : createFixtureTaskState());
  const isCommand = context?.action?.kind === 'run_command';
  const taskState: TaskState = isCommand
    ? {
        ...initialTaskState,
        budgetLedgers: [
          ...(initialTaskState.budgetLedgers ?? []),
          {
            scope: 'task',
            kind: 'timeoutMs',
            limit: 60_000,
            consumed: 0,
            reservations: [],
            unit: 'count',
            configurationId: 'config-uc03-v1',
            version: 1,
          },
        ],
      }
    : initialTaskState;
  const authorityRef = context?.policyAuthorityRef;
  const statePort = new MemoryStatePortV02({
    initialTaskState: taskState,
    initialControlVersion: context?.expectedControlVersion ?? 0,
    initialEpoch: context?.expectedEpoch ?? 0,
    initialAuthorityRef: authorityRef,
    transitionContexts: context
      ? createTestAdmissionTransitionContextsV02(context, taskState)
      : undefined,
  });
  const approvalPort = new ScriptedApprovalPort();
  const executorIdentity = createTestExecutorIdentityV02(
    context ? { payloadDigest: context.actionDigest } : undefined
  );
  const repositoryPort = new FakeRepositoryPort({
    statePort,
    executorIdentity,
    commandResults: options?.commandResults ?? {
      default: { exitCode: 0, stdout: 'ok', stderr: '' },
    },
    initialFiles: options?.initialFiles ?? {
      'src/calculator.py': 'class Calculator:\n    def divide(self, a, b):\n        return a / b\n',
      'tests/test_calculator.py': 'import pytest\nfrom src.calculator import Calculator\n\ndef test_divide():\n    calc = Calculator()\n    assert calc.divide(10, 2) == 5\n',
    },
  });

  const portCalls = { loadTask: 0, claim: 0, beginAttempt: 0, patches: 0, commands: 0, tests: 0 };
  const forwardedStatePort = forwardStatePortV02(
    statePort,
    portCalls,
    options?.failAuthoritativeLoad
      ? async () => { throw new Error('authoritative state store unavailable'); }
      : undefined
  );
  const forwardedRepositoryPort = forwardRepositoryPortV02(repositoryPort, portCalls);

  const ports: ExecutionGuardPortsV02 = {
    statePort: forwardedStatePort,
    approvalPort,
    repositoryPort: forwardedRepositoryPort,
  };

  const guardOptions: ExecutionGuardOptionsV02 = {
    ports,
    config: {
      provenance: options?.guardProvenance ?? 'mock',
    },
  };

  const guard = createExecutionGuardV02(guardOptions);

  return {
    guard,
    ports,
    statePort,
    approvalPort,
    repositoryPort,
    taskState,
    portCalls,
  };
}

interface V02PortCalls {
  loadTask: number;
  claim: number;
  beginAttempt: number;
  patches: number;
  commands: number;
  tests: number;
}

function forwardStatePortV02(
  port: StatePortV02,
  calls: V02PortCalls,
  loadTask: StatePortV02['loadTask'] = (taskId) => port.loadTask(taskId)
): ExecutionGuardStatePortV02 {
  return {
    provenance: port.provenance,
    executionGuardApiVersion: '0.2.0',
    loadTask: (taskId) => {
      calls.loadTask++;
      return loadTask(taskId);
    },
    transition: (state, expectedVersion) => port.transition(state, expectedVersion),
    claim: (context) => {
      calls.claim++;
      return port.claim(context);
    },
    beginAttempt: (claimId, executor) => {
      calls.beginAttempt++;
      return port.beginAttempt(claimId, executor);
    },
    recordOutcome: (receipt) => port.recordOutcome(receipt),
    reconcileObservedOutcome: (receipt) => port.reconcileObservedOutcome(receipt),
    reconcileUncertain: (receipt) => port.reconcileUncertain(receipt),
    closeUnattemptedClaim: (receipt) => port.closeUnattemptedClaim(receipt),
    checkpoint: (state) => port.checkpoint(state),
    recover: (taskId) => port.recover(taskId),
  };
}

function forwardRepositoryPortV02(
  port: RepositoryPortV02,
  calls: V02PortCalls
): ExecutionGuardRepositoryPortV02 {
  return {
    provenance: port.provenance,
    executionGuardApiVersion: '0.2.0',
    listDir: (path) => port.listDir(path),
    readFile: (path) => port.readFile(path),
    searchCode: (query) => port.searchCode(query),
    applyPatch: (patch, context) => {
      calls.patches++;
      return port.applyPatch(patch, context);
    },
    runCommand: (action, context) => {
      calls.commands++;
      return port.runCommand(action, context);
    },
    runTests: (check, context) => {
      calls.tests++;
      return port.runTests(check, context);
    },
    inspectDiff: (revision) => port.inspectDiff(revision),
  };
}

function createV01RepositorySpy(
  port: RepositoryPort,
  revisionDigest: string,
  onPatch: () => void
): RepositoryPort {
  return {
    provenance: port.provenance,
    listDir: (path) => port.listDir(path),
    readFile: (path) => port.readFile(path),
    searchCode: (query) => port.searchCode(query),
    applyPatch: async () => {
      onPatch();
      return { applied: true, newRevisionDigest: revisionDigest };
    },
    runCommand: async (action) => port.runCommand(action),
    runTests: (check) => port.runTests(check),
    inspectDiff: (revision) => port.inspectDiff(revision),
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
// SECTION 6: Historical v0.1 Behavioral RED Expectations (T021 Baseline)
// =========================================================================

test('v0.1 compatibility: an approval-required legacy call remains fail-closed without dispatch', async () => {
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

  assert.equal(result.outcome, 'denied', 'Legacy v0.1 calls are retained only as a no-dispatch compatibility surface');
  assert.match(result.reason ?? '', /v0\.1.*no-dispatch/i);
  assert.equal(repositoryPort.patches.length, 0, 'Legacy v0.1 compatibility must never dispatch');
});

test('v0.1 compatibility: stale caller state cannot reach the repository receiver', async () => {
  const { guard } = createTestHarness();
  const patchAction = createValidPatchAction();

  // Create state with mismatched expectedStateVersion (simulating concurrent state modification)
  const staleState: TaskState = {
    ...createFixtureTaskState(),
    stateVersion: 999, // Mismatched version triggering CAS conflict
  };

  const result = await guard.validateAndExecute(patchAction, staleState);

  assert.equal(result.outcome, 'denied', 'The legacy surface refuses execution before any state or repository mutation');
  assert.match(result.reason ?? '', /v0\.1.*no-dispatch/i);
});

test('v0.1 compatibility: an uncertain adapter hook is never reached without v0.2 admission', async () => {
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

  assert.equal(result.outcome, 'denied', 'A v0.1 call cannot start an effect whose outcome would need reconciliation');
  assert.match(result.reason ?? '', /v0\.1.*no-dispatch/i);
  assert.equal(invocations, 0, 'Legacy v0.1 compatibility must not reach the repository adapter');
});

test('v0.1 compatibility: a valid approved action stays no-dispatch until the v0.2 boundary is used', async () => {
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

  assert.equal(result.outcome, 'denied', 'v0.1 decision records are not effect authority at the v0.2 boundary');
  assert.match(result.reason ?? '', /v0\.1.*no-dispatch/i);
  assert.equal(repositoryPort.patches.length, 0, 'Legacy v0.1 compatibility must never dispatch');
});

// =========================================================================
// SECTION 7: v0.2 Atomic Admission & Receiver Handoff (T022 Green Checks)
// =========================================================================

test('ExecutionGuardV02: declares port provenance and type conformance on real neutral v0.2 SUT', async () => {
  const { guard, ports, repositoryPort, taskState } = createTestHarnessV02({ guardProvenance: 'mock' });
  assert.equal(guard.provenance, 'mock', 'Guard must declare mock provenance by default in test configuration');
  assert.equal(
    isAdmittedForProduction([guard]),
    false,
    'Production guard must reject mock execution guard'
  );
  assert.equal(
    isAdmittedForProduction([guard, ports.statePort, ports.repositoryPort]),
    false,
    'Production guard must reject mock execution guard and mock v0.2 dependencies'
  );
  assert.ok(guard instanceof AuthoritativeExecutionGuardV02, 'Guard is instance of AuthoritativeExecutionGuardV02 SUT');
  assert.ok(guard instanceof AuthoritativeExecutionGuard, 'Guard is also instance of AuthoritativeExecutionGuard base');

  const patchAction = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({ action: patchAction });
  const result = await guard.validateAndExecute(patchAction, taskState, context);
  assert.equal(result.outcome, 'denied', 'Mismatched taskState returns fail-closed denied outcome before valid admission match');
  assert.equal(repositoryPort.patches.length, 0, 'Zero dispatch to repository receiver on mismatched taskState');
});

test('v0.2 missing context fails closed without entering the v0.1 path or mutating state', async () => {
  const patchAction = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({ action: patchAction });
  const { guard, repositoryPort, statePort, taskState, portCalls } = createTestHarnessV02({ context });
  const before = await statePort.loadTask(taskState.taskId);

  const result = await guard.validateAndExecute(patchAction, taskState);
  const after = await statePort.loadTask(taskState.taskId);

  assert.equal(result.outcome, 'denied');
  assert.match(result.reason ?? '', /admission context.*required/i);
  assert.equal(portCalls.patches, 0, 'Missing v0.2 context must not reach the public repository port');
  assert.equal(repositoryPort.patches.length, 0, 'Missing v0.2 context must not produce a patch effect');
  assert.equal(portCalls.claim, 0, 'The guard must not create or replay a journal claim');
  assert.equal(portCalls.beginAttempt, 0, 'The guard must not consume an attempt without context');
  assert.deepEqual(after, before, 'A missing-context refusal leaves the owner-persisted state unchanged');
});

test('v0.2 unavailable authoritative state fails closed before receiver or journal effects', async () => {
  const patchAction = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({ action: patchAction });
  const { guard, repositoryPort, statePort, taskState, portCalls } = createTestHarnessV02({
    context,
    failAuthoritativeLoad: true,
  });
  const before = await statePort.loadTask(taskState.taskId);

  const result = await guard.validateAndExecute(patchAction, taskState, context);
  const after = await statePort.loadTask(taskState.taskId);

  assert.equal(result.outcome, 'denied');
  assert.match(result.reason ?? '', /authoritative state.*unavailable/i);
  assert.equal(portCalls.loadTask, 1, 'The guard must load current owner state through the public StatePortV02');
  assert.equal(portCalls.patches, 0, 'An unavailable state owner must not reach the repository receiver');
  assert.equal(repositoryPort.patches.length, 0, 'An unavailable state owner must not produce a patch effect');
  assert.equal(portCalls.claim, 0, 'An unavailable state owner must not start a claim');
  assert.equal(portCalls.beginAttempt, 0, 'An unavailable state owner must not consume an attempt');
  assert.deepEqual(after, before, 'A reload failure leaves the owner-persisted task state unchanged');
});

test('v0.2 positive admission: valid approved-plan patch executes cleanly via repository receiver handoff (behavioral RED against neutral SUT)', async () => {
  const patchAction = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({ action: patchAction });
  const { guard, repositoryPort, statePort, taskState, portCalls } = createTestHarnessV02({ context });
  const before = await statePort.loadTask(taskState.taskId);

  const result = await guard.validateAndExecute(patchAction, taskState, context);
  const after = await statePort.loadTask(taskState.taskId);

  assert.equal(
    result.outcome,
    'success',
    'Valid approved patch must execute cleanly via receiver handoff'
  );
  assert.ok(result.result, 'Success result must contain patch application result');
  assert.equal(repositoryPort.patches.length, 1, 'The controlled repository effect must be persisted once');
  assert.equal(portCalls.patches, 1, 'The public RepositoryPortV02 wrapper forwards the receiver call once');
  assert.equal(portCalls.claim, 0, 'ExecutionGuard does not duplicate the receiver-owned journal claim');
  assert.equal(portCalls.beginAttempt, 0, 'ExecutionGuard does not duplicate the receiver-owned beginAttempt');
  assert.notDeepEqual(after, before, 'The owner-persisted task state records the patch attempt progression');
  assert.equal(result.attemptId, (result.result as RepositoryPatchResultV02 | RepositoryCommandResultV02).executionReceipt.attempt.attemptId, 'The guard forwards the exact owner-issued identity');
});

test('v0.2 positive admission: valid approved-plan command executes cleanly via repository receiver handoff (behavioral RED against neutral SUT)', async () => {
  const cmdAction = createValidCommandAction();
  const context = createTestRepositoryCommandAdmissionContextV02({ action: cmdAction });
  const { guard, repositoryPort, statePort, taskState, portCalls } = createTestHarnessV02({ context });
  const before = await statePort.loadTask(taskState.taskId);

  const result = await guard.validateAndExecute(cmdAction, taskState, context);
  const after = await statePort.loadTask(taskState.taskId);

  assert.equal(
    result.outcome,
    'success',
    'Valid approved command must execute cleanly via receiver handoff'
  );
  assert.ok(result.result, 'Success result must contain command execution result');
  assert.equal(repositoryPort.commands.length, 1, 'The controlled repository effect must be persisted once');
  assert.equal(portCalls.commands, 1, 'The public RepositoryPortV02 wrapper forwards the receiver call once');
  assert.equal(portCalls.claim, 0, 'ExecutionGuard does not duplicate the receiver-owned journal claim');
  assert.equal(portCalls.beginAttempt, 0, 'ExecutionGuard does not duplicate the receiver-owned beginAttempt');
  assert.equal(after?.stateVersion, before?.stateVersion, 'Command settlement preserves the task state version');
  assert.equal(after?.repositoryRevisionDigest, before?.repositoryRevisionDigest);
  const timeoutLedger = after?.budgetLedgers?.find((ledger) => ledger.kind === 'timeoutMs');
  assert.equal(timeoutLedger?.consumed, 30_000, 'The receiver settles the configured command reservation once');
  assert.deepEqual(timeoutLedger?.reservations, []);
  assert.equal(result.attemptId, (result.result as RepositoryPatchResultV02 | RepositoryCommandResultV02).executionReceipt.attempt.attemptId, 'The guard forwards the exact owner-issued identity');
});

test('v0.2 positive admission: pre-plan diagnostic check executes without requiring approved plan decision (behavioral RED against neutral SUT)', async () => {
  const diagAction = createValidCommandAction({ purpose: 'baseline-reproduction-check' });
  const context = createTestRepositoryCommandAdmissionContextV02({
    action: diagAction,
    runnableNode: 'Investigate',
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: 'baseline-reproduction-check',
    taskCriteriaDigest: 'sha256:criteria00000000000000000000000000000000000000000000000000000000000000',
    checkSetDigest: 'sha256:checkset00000000000000000000000000000000000000000000000000000000000000',
    testPath: 'tests/test_calculator.py',
    checkId: 'check-pytest-repro',
    planBindingDigest: undefined,
    planDecisionRef: undefined,
  });
  const { guard, repositoryPort, taskState } = createTestHarnessV02({ context });

  const result = await guard.validateAndExecute(diagAction, taskState, context);

  assert.equal(
    result.outcome,
    'success',
    'Valid pre-plan diagnostic check must execute cleanly without requiring approved plan decision'
  );
  assert.equal(repositoryPort.commands.length, 1, 'RepositoryPort.runCommand must be dispatched for diagnostic check');
});

test('v0.2 typed receipt and state/control progression: validates and binds protocol versions on attempt handoff (behavioral RED against neutral SUT)', async () => {
  const patchAction = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({
    action: patchAction,
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 1,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 2,
    expectedEpoch: 1,
  });
  const { guard, taskState, statePort } = createTestHarnessV02({ context });
  let issuedAttemptId: string | undefined;
  const begin = statePort.beginAttempt.bind(statePort);
  statePort.beginAttempt = async (claimId, executor) => {
    const receipt = await begin(claimId, executor);
    issuedAttemptId = receipt.attemptId;
    return receipt;
  };

  const result = await guard.validateAndExecute(patchAction, taskState, context);

  assert.equal(
    result.outcome,
    'success',
    'Valid attempt handoff must bind receipt and version progression'
  );
  assert.ok(result.attemptId, 'Execution result must include assigned attemptId from UC-04 claim/attempt handoff');
  assert.equal(result.attemptId, issuedAttemptId, 'Guard projects the exact UC-04-issued attempt identity');
});


test('v0.2 authoritative state missing or changed denies before receiver mutation', async () => {
  for (const missing of [true, false]) {
    const action = createValidPatchAction();
    const context = createTestRepositoryAdmissionContextV02({ action });
    const { ports, taskState, repositoryPort, portCalls, statePort } = createTestHarnessV02({ context });
    const before = await statePort.loadTask(taskState.taskId);
    const guard = createExecutionGuardV02({ ports: {
      ...ports,
      statePort: { ...ports.statePort, loadTask: async () => missing ? null : { ...taskState, stateVersion: 99 } },
    } });
    const result = await guard.validateAndExecute(action, taskState, context);
    assert.equal(result.outcome, missing ? 'denied' : 'conflict');
    assert.equal(repositoryPort.patches.length, 0);
    assert.equal(portCalls.claim, 0);
    assert.equal(portCalls.beginAttempt, 0);
    assert.deepEqual(await statePort.loadTask(taskState.taskId), before);
  }
});

test('v0.2 ignores uncontracted mismatched receiver identity rather than treating it as authority', async () => {
  const action = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({ action });
  const { ports, taskState, portCalls } = createTestHarnessV02({ context });
  const guard = createExecutionGuardV02({ ports: {
    ...ports,
    repositoryPort: {
      ...ports.repositoryPort,
      applyPatch: async (patch, admission) => ({
        ...await ports.repositoryPort.applyPatch(patch, admission),
        attemptId: 'unrelated-attempt',
      }),
    },
  } });
  const result = await guard.validateAndExecute(action, taskState, context);
  assert.equal(result.attemptId, (result.result as RepositoryPatchResultV02).executionReceipt.attempt.attemptId);
  assert.notEqual(result.attemptId, 'unrelated-attempt');
  assert.equal(portCalls.patches, 1);
  assert.equal(portCalls.claim, 0);
  assert.equal(portCalls.beginAttempt, 0);
});

for (const kind of ['patch', 'command'] as const) {
  for (const mutation of ['missing', 'digest', 'foreign-attempt', 'payload', 'branch', 'policy', 'versions', 'reservations', 'revision-or-output', 'unsettled', 'already-recorded', 'settlement-id', 'throw', 'wrong-successor', 'no-transition', 'foreign-invalidation'] as const) {
    test(`v0.2 ${kind}: ${mutation} after dispatch is uncertain without a second effect or accounting`, async () => {
      const action = kind === 'patch' ? createValidPatchAction() : createValidCommandAction();
      const context = action.kind === 'apply_patch'
        ? createTestRepositoryAdmissionContextV02({ action })
        : createTestRepositoryCommandAdmissionContextV02({ action });
      const { ports, statePort, taskState, repositoryPort, portCalls } = createTestHarnessV02({ context });
      const counts = { claim: 0, begin: 0, settle: 0 };
      const claim = statePort.claim.bind(statePort), begin = statePort.beginAttempt.bind(statePort), settle = statePort.recordOutcome.bind(statePort);
      statePort.claim = async (admission) => { counts.claim++; return claim(admission); };
      statePort.beginAttempt = async (id, executor) => { counts.begin++; return begin(id, executor); };
      statePort.recordOutcome = async (receipt) => { counts.settle++; return settle(receipt); };
      let persisted: TaskState | null = null;
      function tamper<T extends RepositoryPatchResultV02 | RepositoryCommandResultV02>(result: T): T {
        if (mutation === 'throw') throw new Error('receiver lost response');
        const copy = structuredClone(result) as unknown as Record<string, unknown>;
        if (mutation === 'missing') { delete copy['executionReceipt']; return copy as unknown as T; }
        const bundle = copy['executionReceipt'] as Record<string, Record<string, unknown>>;
        const outcome = bundle['outcome'];
        const attempt = bundle['attempt'];
        const settlement = bundle['settlement'];
        assert.ok(outcome && attempt && settlement);
        if (mutation === 'wrong-successor') (outcome['proposedEffects'] as Record<string, unknown>)['taskTransition'] = { kind: 'transition', fromNode: kind === 'patch' ? 'Patch' : context.runnableNode, toNode: 'Completed' };
        if (mutation === 'no-transition') (outcome['proposedEffects'] as Record<string, unknown>)['taskTransition'] = { kind: 'none' };
        if (mutation === 'foreign-invalidation') (outcome['proposedEffects'] as Record<string, unknown>)['invalidatedEvidence'] = [{ reference: 'foreign-evidence', digest: 'sha256:' + 'a'.repeat(64) }];
        if (mutation === 'digest') outcome['receiptDigest'] = 'sha256:' + '0'.repeat(64);
        if (mutation === 'foreign-attempt') attempt['attemptId'] = 'foreign-attempt';
        if (mutation === 'payload') (attempt['executorIdentity'] as Record<string, unknown>)['payloadDigest'] = 'sha256:' + '1'.repeat(64);
        if (mutation === 'branch') outcome['planApplicability'] = 'pre-plan-diagnostic';
        if (mutation === 'policy') outcome['policyEvaluationReceiptRef'] = 'foreign-policy';
        if (mutation === 'versions') (outcome['versions'] as Record<string, unknown>)['epoch'] = 99;
        if (mutation === 'reservations') (outcome['proposedEffects'] as { accounting: { reservationRefs: string[] } }).accounting.reservationRefs = [];
        if (mutation === 'revision-or-output') copy[kind === 'patch' ? 'newRevisionDigest' : 'stdout'] = 'tampered';
        if (mutation === 'unsettled') settlement['outcome'] = 'recorded-unsettled';
        if (mutation === 'already-recorded') settlement['outcome'] = 'already-recorded';
        if (mutation === 'settlement-id') settlement['receiptId'] = 'foreign-outcome';
        if (mutation !== 'digest') outcome['receiptDigest'] = computeAttemptOutcomeDigest(outcome);
        return copy as unknown as T;
      }
      const receiver = ports.repositoryPort;
      const guard = createExecutionGuardV02({ ports: { ...ports, repositoryPort: {
        ...receiver,
        applyPatch: async (patch, admission) => { const result = await receiver.applyPatch(patch, admission); persisted = await statePort.loadTask(taskState.taskId); return tamper(result); },
        runCommand: async (command, admission) => { const result = await receiver.runCommand(command, admission); persisted = await statePort.loadTask(taskState.taskId); return tamper(result); },
      } } });
      const result = await guard.validateAndExecute(action, taskState, context);
      const preservationControl = kind === 'command' && mutation === 'no-transition';
      assert.equal(result.outcome, preservationControl ? 'success' : 'uncertain-effect');
      if (!preservationControl) assert.equal(result.attemptId, undefined);
      assert.deepEqual(counts, { claim: 1, begin: 1, settle: 1 });
      assert.equal(kind === 'patch' ? repositoryPort.patches.length : repositoryPort.commands.length, 1);
      assert.equal(kind === 'patch' ? portCalls.patches : portCalls.commands, 1);
      assert.deepEqual(await statePort.loadTask(taskState.taskId), persisted, 'Guard does not mutate the settled owner state or refund accounting');
    });
  }
}

test('v0.2 observed nonzero command exit is receipted without becoming verification success', async () => {
  const action = createValidCommandAction();
  const context = createTestRepositoryCommandAdmissionContextV02({ action });
  const { guard, taskState } = createTestHarnessV02({ context, commandResults: { default: { exitCode: 1, stdout: '', stderr: 'failed check' } } });
  const result = await guard.validateAndExecute(action, taskState, context);
  assert.equal(result.outcome, 'success');
  assert.equal((result.result as RepositoryCommandResultV02).exitCode, 1);
  assert.equal(result.attemptId, (result.result as RepositoryCommandResultV02).executionReceipt.attempt.attemptId);
});

test('v0.2 real receiver: redigested successor handoff is uncertain after one settled patch', async () => {
  const action = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({ action });
  const h = createTestHarnessV02({ context });
  const manager = new DockerWorkspaceManager({ controller: {
    provenance: 'mock', createVolume: async () => undefined, hasVolume: async () => true,
    removeVolume: async () => undefined,
  } });
  await manager.createWorkspace({
    taskId: context.taskId, workspaceId: context.workspaceId, initialRevisionDigest: context.canonicalRevision,
    profile: { profileId: context.executionProfileId, image: 'test', imageDigest: context.canonicalRevision,
      user: '1000:1000', readOnlyRootFilesystem: true, network: 'none', mounts: [],
      limits: { timeoutMs: 30000, maxMemoryBytes: 2147483648, maxCpuCores: 2, maxPids: 256 } },
  });
  let revision = context.canonicalRevision;
  let effects = 0;
  const unused = async (): Promise<never> => { throw new Error('unexpected read'); };
  const fsPort: TrustedFilesystemPort = {
    provenance: 'mock', stat: unused, lstat: unused, realpath: unused, readDir: unused, readTextFile: unused,
    getCurrentRevisionDigest: async () => revision,
  };
  const receiver = new ControlledRepositoryTools({
    provenance: 'mock', fsPort, limits: { maxExcerptBytes: 1024, maxResultCount: 10 },
    guardCapability: { provenance: 'mock', capabilityId: 'unused-read', workspaceId: context.workspaceId,
      taskId: context.taskId, mediateRead: unused },
    workspaceManager: manager, statePort: h.ports.statePort,
    patchRecoveryHandoff: { prepare: unused },
    adapterIdentity: 'effects-test', processIncarnation: 'effects-test-1', fencingGeneration: 1,
    attemptStartRecoveryHandoff: { queryAttemptStart: async () => ({ outcome: 'unknown' }) },
    unattemptedClaimClosureHandoff: { closeUnattemptedClaim: async () => ({ closed: false, receiptId: '' }) },
    patchReceiver: async () => {
      effects++;
      revision = 'sha256:' + 'b'.repeat(64);
      manager.setCanonicalRevision(context.workspaceId, revision);
      return { applied: true, newRevisionDigest: revision };
    },
  });
  let settledTask: TaskState | null = null;
  let settledJournal: ReturnType<typeof h.statePort.getJournalSnapshot> | undefined;
  const guard = createExecutionGuardV02({ ports: { ...h.ports, repositoryPort: {
    ...h.ports.repositoryPort,
    applyPatch: async (patch, admission) => {
      const result = await receiver.applyPatch(patch, admission);
      assert.equal(result.executionReceipt.outcome.proposedEffects.invalidatedEvidence.length, 0);
      assert.equal((await h.statePort.loadTask(context.taskId))?.node, 'Verify');
      settledTask = await h.statePort.loadTask(context.taskId);
      settledJournal = h.statePort.getJournalSnapshot();
      const outcome = { ...result.executionReceipt.outcome, proposedEffects: {
        ...result.executionReceipt.outcome.proposedEffects,
        taskTransition: { kind: 'transition' as const, fromNode: 'Patch', toNode: 'Completed' },
      } };
      return { ...result, executionReceipt: { ...result.executionReceipt,
        outcome: { ...outcome, receiptDigest: computeAttemptOutcomeDigest(outcome) } } };
    },
  } } });
  const result = await guard.validateAndExecute(action, h.taskState, context);
  assert.equal(result.outcome, 'uncertain-effect');
  assert.equal(result.attemptId, undefined);
  assert.equal(effects, 1);
  assert.deepEqual(await h.statePort.loadTask(context.taskId), settledTask);
  assert.deepEqual(h.statePort.getJournalSnapshot(), settledJournal);
  assert.equal(settledJournal?.claims.length, 1);
  assert.equal(settledJournal?.attempts.length, 1);
  assert.equal(settledJournal?.outcomes.length, 1);
  const persisted = await h.statePort.loadTask(context.taskId);
  assert.equal(persisted?.budgetLedgers?.find((ledger) => ledger.kind === 'repair')?.consumed, 1);
});

test('v0.1 guard refuses a valid v0.2 context before state or receiver calls', async () => {
  const action = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({ action });
  const { taskState } = createTestHarnessV02({ context });
  const h = createTestHarness({ initialTaskState: taskState });
  const loadTask = h.statePort.loadTask.bind(h.statePort);
  const before = await loadTask(taskState.taskId);
  let stateCalls = 0;
  let receiverCalls = 0;
  h.statePort.loadTask = async (taskId) => {
    stateCalls++;
    return loadTask(taskId);
  };
  const ports: ExecutionGuardPorts = {
    ...h.ports,
    repositoryPort: createV01RepositorySpy(
      h.repositoryPort,
      taskState.repositoryRevisionDigest,
      () => { receiverCalls++; }
    ),
  };
  const guard = createExecutionGuard({ ports });

  const result = await guard.validateAndExecute(action, taskState, context);

  assert.deepEqual({ stateCalls, receiverCalls }, { stateCalls: 0, receiverCalls: 0 });
  assert.equal(result.outcome, 'denied');
  assert.deepEqual(await loadTask(taskState.taskId), before, 'Refusal leaves persisted task state unchanged');
});

test('v0.2 guard refuses an unmarked v0.1 repository before state or receiver calls', async () => {
  const action = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({ action });
  const h = createTestHarnessV02({ context });
  const beforeTask = await h.statePort.loadTask(h.taskState.taskId);
  const beforeJournal = h.statePort.getJournalSnapshot();
  const legacy = createTestHarness({ initialTaskState: h.taskState }).repositoryPort;
  let receiverCalls = 0;
  const unmarkedRepositoryPort = createV01RepositorySpy(
    legacy,
    h.taskState.repositoryRevisionDigest,
    () => { receiverCalls++; }
  );
  const ports: ExecutionGuardPortsV02 = {
    ...h.ports,
    repositoryPort: unmarkedRepositoryPort as unknown as ExecutionGuardPortsV02['repositoryPort'],
  };

  const guard = createExecutionGuardV02({ ports });
  const result = await guard.validateAndExecute(action, h.taskState, context);

  assert.equal(receiverCalls, 0, 'Unmarked v0.1 receiver must not be invoked');
  assert.deepEqual(h.portCalls, { loadTask: 0, claim: 0, beginAttempt: 0, patches: 0, commands: 0, tests: 0 });
  assert.equal(result.outcome, 'denied');
  assert.deepEqual(await h.statePort.loadTask(h.taskState.taskId), beforeTask);
  assert.deepEqual(h.statePort.getJournalSnapshot(), beforeJournal);
});

test('v0.2 guard refuses an unmarked v0.1 state port before state or receiver calls', async () => {
  const action = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({ action });
  const h = createTestHarnessV02({ context });
  const beforeTask = await h.statePort.loadTask(h.taskState.taskId);
  const beforeJournal = h.statePort.getJournalSnapshot();
  const legacy = createTestHarness({ initialTaskState: h.taskState });
  const loadTask = legacy.statePort.loadTask.bind(legacy.statePort);
  let stateCalls = 0;
  legacy.statePort.loadTask = async (taskId) => {
    stateCalls++;
    return loadTask(taskId);
  };
  const ports: ExecutionGuardPortsV02 = {
    ...h.ports,
    statePort: legacy.statePort as unknown as ExecutionGuardPortsV02['statePort'],
  };

  const guard = createExecutionGuardV02({ ports });
  const result = await guard.validateAndExecute(action, h.taskState, context);

  assert.deepEqual({ stateCalls, ...h.portCalls }, {
    stateCalls: 0, loadTask: 0, claim: 0, beginAttempt: 0, patches: 0, commands: 0, tests: 0,
  });
  assert.equal(result.outcome, 'denied');
  assert.deepEqual(await h.statePort.loadTask(h.taskState.taskId), beforeTask);
  assert.deepEqual(h.statePort.getJournalSnapshot(), beforeJournal);
});

test('v0.2 guard with missing context refuses before any port call or mutation', async () => {
  const action = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({ action });
  const h = createTestHarnessV02({ context });
  const beforeTask = await h.statePort.loadTask(h.taskState.taskId);
  const beforeJournal = h.statePort.getJournalSnapshot();

  const result = await h.guard.validateAndExecute(action, h.taskState);

  assert.equal(result.outcome, 'denied');
  assert.deepEqual(h.portCalls, { loadTask: 0, claim: 0, beginAttempt: 0, patches: 0, commands: 0, tests: 0 });
  assert.deepEqual(await h.statePort.loadTask(h.taskState.taskId), beforeTask);
  assert.deepEqual(h.statePort.getJournalSnapshot(), beforeJournal);
});

test('v0.2 guard refuses malformed marked ports before any port call or mutation', async () => {
  const action = createValidPatchAction();
  const context = createTestRepositoryAdmissionContextV02({ action });
  for (const malformed of ['state', 'repository'] as const) {
    const h = createTestHarnessV02({ context });
    const beforeTask = await h.statePort.loadTask(h.taskState.taskId);
    const beforeJournal = h.statePort.getJournalSnapshot();
    const ports: ExecutionGuardPortsV02 = malformed === 'state'
      ? {
          ...h.ports,
          statePort: { ...h.ports.statePort, claim: undefined } as unknown as ExecutionGuardPortsV02['statePort'],
        }
      : {
          ...h.ports,
          repositoryPort: { ...h.ports.repositoryPort, applyPatch: undefined } as unknown as ExecutionGuardPortsV02['repositoryPort'],
        };

    const result = await createExecutionGuardV02({ ports }).validateAndExecute(action, h.taskState, context);

    assert.equal(result.outcome, 'denied');
    assert.deepEqual(h.portCalls, { loadTask: 0, claim: 0, beginAttempt: 0, patches: 0, commands: 0, tests: 0 });
    assert.deepEqual(await h.statePort.loadTask(h.taskState.taskId), beforeTask);
    assert.deepEqual(h.statePort.getJournalSnapshot(), beforeJournal);
  }
});
