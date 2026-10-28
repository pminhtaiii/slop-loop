import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ControlledRepositoryTools,
  type ExecutionGuardReadCapability,
  type TrustedFilesystemPort,
} from '../../../src/foundation/repository-tools.ts';
import {
  DockerWorkspaceManager,
  type DockerLifecycleController,
} from '../../../src/foundation/docker-workspace.ts';
import type { BudgetLedger } from '../../../src/contracts/foundation/uc03.ts';
import {
  validateAttemptReceiptV02,
  validateRepositoryExecutionReceiptV02,
} from '../../../src/contracts/foundation/uc03/v02/attempt.ts';
import type { RepositoryAdmissionContextV02 } from '../../../src/contracts/foundation/uc03/v02/ports.ts';
import { beginRepositoryAttemptWithClaim } from '../../../src/foundation/repository-receiver.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestDiagnosticPatchAdmissionContextV02,
  createTestExecutorIdentityV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryCommandAdmissionContextV02,
} from '../support/uc03/state-fixtures.ts';

const initialRevision = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const nextRevision = `sha256:${'a'.repeat(64)}`;

class PatchTestFilesystem implements TrustedFilesystemPort {
  readonly provenance = 'mock' as const;
  constructor(private revision: string) {}
  setRevision(revision: string): void { this.revision = revision; }
  async stat() { return { isFile: false, isDirectory: false, isSymbolicLink: false, size: 0 }; }
  async lstat() { return { isFile: false, isDirectory: false, isSymbolicLink: false, size: 0 }; }
  async realpath(path: string): Promise<string> { return path; }
  async readDir() { return []; }
  async readTextFile(): Promise<string> { return ''; }
  async getCurrentRevisionDigest(): Promise<string> { return this.revision; }
}

class PatchTestDockerController implements DockerLifecycleController {
  readonly provenance = 'mock' as const;
  private readonly volumes = new Set<string>();
  async createVolume(id: string): Promise<void> { this.volumes.add(id); }
  async hasVolume(id: string): Promise<boolean> { return this.volumes.has(id); }
  async removeVolume(id: string): Promise<void> { this.volumes.delete(id); }
}

async function unexpectedRecovery(): Promise<never> {
  throw new Error('Unexpected recovery for an observed patch');
}

function resourceLedger(scope: 'task' | 'run', kind: string, limit: number, configurationId: string): BudgetLedger {
  return { scope, kind, limit, consumed: 0, reservations: [], unit: 'count', configurationId, version: 1 };
}

async function applyPatchThroughReceiver(context: RepositoryAdmissionContextV02) {
  if (context.action.kind !== 'apply_patch') throw new Error('Patch admission required');
  const taskState = createTestAdmissionTaskStateV02(context);
  const statePort = new MemoryStatePortV02({
    initialTaskState: taskState,
    initialAuthorityRef: context.policyAuthorityRef,
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
  });
  const filesystem = new PatchTestFilesystem(context.canonicalRevision);
  const manager = new DockerWorkspaceManager({ controller: new PatchTestDockerController() });
  await manager.createWorkspace({
    taskId: context.taskId,
    workspaceId: context.workspaceId,
    initialRevisionDigest: context.canonicalRevision,
    profile: {
      profileId: context.executionProfileId,
      image: 'test-image',
      imageDigest: context.canonicalRevision,
      user: '1000:1000',
      readOnlyRootFilesystem: true,
      network: 'none',
      limits: { timeoutMs: 30000, maxMemoryBytes: 2147483648, maxCpuCores: 2, maxPids: 64 },
      mounts: [],
    },
  });
  const guard: ExecutionGuardReadCapability = {
    provenance: 'mock',
    capabilityId: 'cap-patch-receipt-test',
    workspaceId: context.workspaceId,
    taskId: context.taskId,
    mediateRead: async (operation) => await operation.execute(),
  };
  const tools = new ControlledRepositoryTools({
    guardCapability: guard,
    fsPort: filesystem,
    limits: { maxExcerptBytes: 1024, maxResultCount: 10 },
    statePort,
    workspaceManager: manager,
    adapterIdentity: 'patch-receipt-test',
    processIncarnation: 'patch-receipt-test-incarnation',
    fencingGeneration: 1,
    patchRecoveryHandoff: { prepare: unexpectedRecovery },
    attemptStartRecoveryHandoff: { queryAttemptStart: unexpectedRecovery },
    unattemptedClaimClosureHandoff: { closeUnattemptedClaim: unexpectedRecovery },
    patchReceiver: async () => {
      filesystem.setRevision(nextRevision);
      manager.setCanonicalRevision(context.workspaceId, nextRevision);
      return { applied: true, newRevisionDigest: nextRevision };
    },
  });
  const result = await tools.applyPatch(context.action, context);
  return { result, statePort, taskState };
}

for (const runnableNode of ['Patch', 'Repair'] as const) {
  test(`approved-plan ${runnableNode} patch receipt uses one version advance and one allowance`, async () => {
    const context = createTestRepositoryAdmissionContextV02({
      taskId: `task-${runnableNode.toLowerCase()}-receipt`,
      runId: `run-${runnableNode.toLowerCase()}-receipt`,
      workspaceId: `workspace-${runnableNode.toLowerCase()}-receipt`,
      runnableNode,
      canonicalRevision: initialRevision,
    });
    const { result, statePort, taskState } = await applyPatchThroughReceiver(context);
    const receipt = result.executionReceipt;
    const begin = validateAttemptReceiptV02(receipt.attempt, {
      expectedTaskId: context.taskId,
      expectedClaimId: receipt.claim.claimId,
      expectedEpoch: context.expectedEpoch,
      isRepairPatch: true,
    });

    assert.equal(result.applied, true);
    assert.equal(receipt.claim.preClaimTaskStateVersion, taskState.stateVersion);
    assert.equal(receipt.attempt.preAttemptTaskStateVersion, taskState.stateVersion);
    assert.equal(receipt.attempt.postBeginTaskStateVersion, taskState.stateVersion + 1);
    assert.equal(begin.ok, true);
    assert.equal(validateRepositoryExecutionReceiptV02(receipt, context).ok, true);
    const settled = await statePort.loadTask(context.taskId);
    assert.equal(settled?.stateVersion, taskState.stateVersion + 2);
    assert.equal(settled?.node, 'Verify');
    assert.equal(settled?.budgetLedgers?.find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair')?.consumed, 1);
    assert.equal(validateRepositoryExecutionReceiptV02({
      ...receipt,
      attempt: { ...receipt.attempt, postBeginTaskStateVersion: taskState.stateVersion },
    }, context).ok, false, 'A stale attempt version is rejected');
  });
}

test('diagnostic patch preserves begin version and repair allowance', async () => {
  const context = createTestDiagnosticPatchAdmissionContextV02();
  const { result, statePort, taskState } = await applyPatchThroughReceiver(context);
  const receipt = result.executionReceipt;

  assert.equal(receipt.attempt.preAttemptTaskStateVersion, taskState.stateVersion);
  assert.equal(receipt.attempt.postBeginTaskStateVersion, taskState.stateVersion);
  assert.equal(validateRepositoryExecutionReceiptV02(receipt, context).ok, true);
  const settled = await statePort.loadTask(context.taskId);
  assert.equal(settled?.stateVersion, taskState.stateVersion + 1);
  assert.equal(settled?.node, 'Investigate');
  assert.equal(settled?.budgetLedgers?.find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair')?.consumed, 0);
});

test('non-patch begin attempt preserves task version', async () => {
  const context = createTestRepositoryCommandAdmissionContextV02({
    taskId: 'task-command-version',
    runId: 'run-command-version',
    workspaceId: 'workspace-command-version',
    canonicalRevision: initialRevision,
    reservationRefs: ['res-task-cpu-version', 'res-run-output-version'],
  });
  const initialTaskState = createTestAdmissionTaskStateV02(context);
  const taskState = {
    ...initialTaskState,
    budgetLedgers: [
      ...(initialTaskState.budgetLedgers ?? []),
      resourceLedger('task', 'maxCpuSeconds', 10, 'config-uc03-v1'),
      resourceLedger('run', 'maxOutputBytes', 65_536, 'config-uc03-v1'),
    ],
  };
  const statePort = new MemoryStatePortV02({
    initialTaskState: taskState,
    initialAuthorityRef: context.policyAuthorityRef,
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
  });
  const executor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const { attempt } = await beginRepositoryAttemptWithClaim(statePort, context, executor, false, () => undefined);

  assert.equal(attempt.preAttemptTaskStateVersion, taskState.stateVersion);
  assert.equal(attempt.postBeginTaskStateVersion, taskState.stateVersion);
  assert.equal((await statePort.loadTask(context.taskId))?.stateVersion, taskState.stateVersion);
  assert.equal(statePort.getLedgers().find((ledger) => ledger.scope === 'task' && ledger.kind === 'repair')?.consumed, 0);
});
