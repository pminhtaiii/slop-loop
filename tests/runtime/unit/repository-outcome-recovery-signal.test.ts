import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlledRepositoryTools } from '../../../src/foundation/repository-tools.ts';
import type { TrustedFilesystemPort, ExecutionGuardReadCapability, GuardedReadOperation, RepositoryReadLimits, UnattemptedClaimClosureHandoffV02 } from '../../../src/foundation/repository-tools.ts';
import { computeActionDigest, computeCanonicalSha256, type ApplyPatchAction, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import type {
  RepositoryAdmissionContextV02,
  AdmissionContextV02,
  StatePortV02,
  AttemptReceiptV02,
  ExecutorIdentityV02,
  ClaimReceiptV02,
  AttemptOutcomeReceiptV02,
  AttemptReconciliationReceiptV02,
  OutcomeRecordResultV02,
  ReconciliationResultV02,
  ClaimClosureReceiptV02,
  ClaimClosureResultV02,
  RepositoryActionOutcomeReceiptV02,
} from '../../../src/contracts/foundation/uc03/v02/ports.ts';
import { createTestUncertainReconciliationReceiptV02, createTestReconciliationValidationContextV02 } from '../support/uc03/state-fixtures.ts';
import {
  DockerWorkspaceManager,
  type DockerLifecycleController,
  type CanonicalRepositorySnapshot,
  type DockerContainerPlan,
  type ContainerExecutionOutput,
  type MaterializeViewParams,
} from '../../../src/foundation/docker-workspace.ts';
import { PatchOutcomePendingError } from '../../../src/foundation/repository-outcome.ts';

const canonicalRev = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const defaultLimits: RepositoryReadLimits = {
  maxExcerptBytes: 4096,
  maxResultCount: 50,
};

class FakeGuardCapability implements ExecutionGuardReadCapability {
  readonly provenance = 'mock' as const;
  readonly capabilityId = 'cap-test-123';
  readonly workspaceId = 'ws-test-1';
  readonly taskId = 'task-test-1';

  async mediateRead<T>(operation: GuardedReadOperation<T>): Promise<T> {
    return await operation.execute();
  }
}

const fakeGuard = new FakeGuardCapability();

class FakeHostFilesystemPort implements TrustedFilesystemPort {
  readonly provenance = 'mock' as const;
  private currentRevision: string;

  constructor(revision: string) {
    this.currentRevision = revision;
  }

  setRevision(rev: string): void {
    this.currentRevision = rev;
  }

  async getCurrentRevisionDigest(): Promise<string> {
    return this.currentRevision;
  }

  async stat(): Promise<never> {
    throw new Error('not implemented');
  }

  async lstat(): Promise<never> {
    throw new Error('not implemented');
  }

  async realpath(): Promise<never> {
    throw new Error('not implemented');
  }

  async readDir(): Promise<never> {
    throw new Error('not implemented');
  }

  async readTextFile(): Promise<never> {
    throw new Error('not implemented');
  }
}

class FakeStatePortV02 implements StatePortV02 {
  readonly provenance = 'mock' as const;
  claimCalls: AdmissionContextV02[] = [];
  claimReceipts: ClaimReceiptV02[] = [];
  private readonly patchClaimIds = new Set<string>();
  beginAttemptCalls: { claimId: string; executor: ExecutorIdentityV02 }[] = [];
  attemptReceipts: AttemptReceiptV02[] = [];
  outcomeReceipts: AttemptOutcomeReceiptV02[] = [];
  recordOutcomeHandler?: ((receipt: AttemptOutcomeReceiptV02) => Promise<OutcomeRecordResultV02>) | undefined;

  async beginAttempt(claimId: string, executor: ExecutorIdentityV02): Promise<AttemptReceiptV02> {
    this.beginAttemptCalls.push({ claimId, executor });
    const isPatch = this.patchClaimIds.has(claimId);
    const receipt: AttemptReceiptV02 = {
      attemptId: `att-${claimId}`,
      claimId,
      taskId: 'task-test-1',
      executorIdentity: executor,
      preAttemptTaskStateVersion: 1,
      postBeginTaskStateVersion: isPatch ? 2 : 1,
      preAttemptControlVersion: 2,
      postBeginControlVersion: 3,
      epoch: 1,
      status: 'attempting',
    };
    this.attemptReceipts.push(receipt);
    return receipt;
  }

  async loadTask(taskId: string): Promise<TaskState | null> {
    void taskId;
    return null;
  }

  async transition(state: TaskState, expectedVersion: number): Promise<TaskState> {
    void expectedVersion;
    return state;
  }

  async claim(context: AdmissionContextV02): Promise<ClaimReceiptV02> {
    if (context.subjectKind !== 'repository-action' || context.action.kind !== 'apply_patch') {
      throw new Error('unsupported repository action');
    }
    this.claimCalls.push(context);
    const claimId = `claim-${context.action.actionId}`;
    this.patchClaimIds.add(claimId);
    const unsigned = {
      claimId,
      claimDigest: '',
      taskId: context.taskId,
      runId: context.runId,
      subjectKind: context.subjectKind,
      planApplicability: context.planApplicability,
      preClaimTaskStateVersion: context.expectedTaskStateVersion,
      preClaimControlVersion: context.expectedControlVersion,
      postClaimControlVersion: context.expectedControlVersion + 1,
      epoch: context.expectedEpoch,
      status: 'claimed' as const,
      reservationRefs: [...context.reservationRefs],
    };
    const receipt = { ...unsigned, claimDigest: computeCanonicalSha256({ ...unsigned, claimDigest: undefined }) };
    this.claimReceipts.push(receipt);
    return receipt;
  }

  async recordOutcome(receipt: AttemptOutcomeReceiptV02): Promise<OutcomeRecordResultV02> {
    this.outcomeReceipts.push(receipt);
    return await (this.recordOutcomeHandler?.(receipt) ?? Promise.resolve({ outcome: 'settled', receiptId: receipt.receiptId }));
  }

  async reconcileObservedOutcome(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    void receipt;
    throw new Error('not implemented');
  }

  async reconcileUncertain(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    void receipt;
    throw new Error('not implemented');
  }

  async closeUnattemptedClaim(receipt: ClaimClosureReceiptV02): Promise<ClaimClosureResultV02> {
    void receipt;
    throw new Error('not implemented');
  }

  async checkpoint(state: TaskState): Promise<void> {
    void state;
  }

  async recover(taskId: string): Promise<TaskState> {
    void taskId;
    throw new Error('not implemented');
  }
}

class RepositoryTestDockerController implements DockerLifecycleController {
  readonly provenance = 'mock' as const;
  private readonly volumes = new Set<string>();
  readonly executedPlans: DockerContainerPlan[] = [];
  snapshotRequests = 0;
  materializedViews = 0;
  snapshotToReturn?: CanonicalRepositorySnapshot;

  async createVolume(id: string): Promise<void> {
    this.volumes.add(id);
  }

  async hasVolume(id: string): Promise<boolean> {
    return this.volumes.has(id);
  }

  async removeVolume(id: string): Promise<void> {
    this.volumes.delete(id);
  }

  async getCanonicalSnapshot(workspaceId: string): Promise<CanonicalRepositorySnapshot> {
    this.snapshotRequests += 1;
    if (!this.snapshotToReturn) throw new Error(`NO_SNAPSHOT_CONFIGURED: ${workspaceId}`);
    return this.snapshotToReturn;
  }

  async materializeView(params: MaterializeViewParams): Promise<void> {
    void params;
    this.materializedViews += 1;
  }

  async executeContainer(plan: DockerContainerPlan): Promise<ContainerExecutionOutput> {
    this.executedPlans.push(plan);
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 50,
      timedOut: false,
    };
  }
}

async function createWorkspaceManager(): Promise<{ readonly manager: DockerWorkspaceManager; readonly controller: RepositoryTestDockerController }> {
  const controller = new RepositoryTestDockerController();
  const manager = new DockerWorkspaceManager({ controller });
  await manager.createWorkspace({
    taskId: 'task-test-1',
    workspaceId: 'ws-test-1',
    initialRevisionDigest: canonicalRev,
    profile: {
      profileId: 'profile-uc03-test',
      image: 'ghcr.io/test:0.1',
      imageDigest: canonicalRev,
      user: '1000:1000',
      readOnlyRootFilesystem: true,
      network: 'none',
      limits: { timeoutMs: 30000, maxMemoryBytes: 2147483648, maxCpuCores: 2, maxPids: 256 },
      mounts: [],
    },
  });
  return { manager, controller };
}

function createTestPatchRecoveryHandoff() {
  return {
    async prepare(input: {
      readonly admission: RepositoryAdmissionContextV02;
      readonly claim: ClaimReceiptV02;
      readonly attempt: AttemptReceiptV02;
      readonly outcome: RepositoryActionOutcomeReceiptV02;
    }) {
      const receipt = createTestUncertainReconciliationReceiptV02(input.outcome, input.claim, input.attempt, input.admission, {
        disposition: 'proven-not-dispatched',
      });
      return {
        receipt,
        validationContext: createTestReconciliationValidationContextV02(receipt, input.outcome, input.claim, input.attempt, input.admission),
      };
    },
  };
}

function createUnknownAttemptStartRecoveryHandoff() {
  return {
    async queryAttemptStart(): Promise<unknown> {
      return { outcome: 'unknown' };
    },
  };
}

function createRefusingClaimClosureHandoff(): UnattemptedClaimClosureHandoffV02 {
  return {
    async closeUnattemptedClaim(): Promise<ClaimClosureResultV02> {
      return { closed: false, receiptId: '' };
    },
  };
}

function createTestAdmissionContext(patch: ApplyPatchAction): RepositoryAdmissionContextV02 {
  const actionDigest = computeActionDigest(patch);
  return {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 1,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 1,
    expectedEpoch: 1,
    taskId: 'task-test-1',
    runId: 'run-1',
    workspaceId: 'ws-test-1',
    repositoryId: 'repo-1',
    runnableNode: 'Repair',
    canonicalRevision: patch.baseRevisionDigest,
    executionProfileId: 'profile-uc03-test',
    action: patch,
    actionDigest,
    policyAuthorityRef: {
      policyId: 'policy-1',
      policyVersion: '1',
      configId: 'config-1',
      configVersion: '1',
      issuerKeyRef: 'key-1',
      decisionAuthorityGeneration: 1,
    },
    policyEvaluationReceipt: {
      receiptId: 'rec-eval-1',
      receiptDigest: 'sha256:eval1',
      actionDigest,
      freshnessContextDigest: 'sha256:fresh1',
      policyId: 'policy-1',
      policyVersion: '1',
      configId: 'config-1',
      configVersion: '1',
      decisionAuthorityGeneration: 1,
      result: 'ALLOWED',
    },
    reservationRefs: ['res-1'],
    planApplicability: 'approved-plan',
    planBindingDigest: 'sha256:plan-binding-1',
    planDecisionRef: 'plan-decision-1',
    baseRevision: patch.baseRevisionDigest,
    targetPaths: [...patch.targetPaths],
    patchDigest: computeCanonicalSha256(patch.patchContent),
    finiteBounds: { maxPatchBytes: 65536, maxChangedPaths: 5 },
  };
}

test('PR222 C1: executor throws an error with recoveryRequired true and unrecoveredPaths -> the held-outcome error carries the recovery signal and uncertain outcome is recorded', async () => {
  const { manager, controller } = await createWorkspaceManager();
  controller.snapshotToReturn = {
    canonicalRevisionDigest: canonicalRev,
    entries: [{ path: 'src/a.py', kind: 'regular', content: 'test', digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }],
  };
  const fsPort = new FakeHostFilesystemPort(canonicalRev);
  const statePort = new FakeStatePortV02();
  statePort.recordOutcomeHandler = async receipt => ({ outcome: 'uncertain', receiptId: receipt.receiptId });

  const recoveryError = new Error('PATCH_RECOVERY_REQUIRED: rollback failed (unrecovered paths: src/a.py)');
  (recoveryError as { recoveryRequired?: boolean; unrecoveredPaths?: readonly string[] }).recoveryRequired = true;
  (recoveryError as { recoveryRequired?: boolean; unrecoveredPaths?: readonly string[] }).unrecoveredPaths = Object.freeze(['src/a.py']);

  const tools = new ControlledRepositoryTools({
    guardCapability: fakeGuard,
    fsPort,
    limits: defaultLimits,
    statePort,
    workspaceManager: manager,
    adapterIdentity: 'patch-uncertain-recovery',
    processIncarnation: 'inc-patch-uncertain-recovery',
    fencingGeneration: 1,
    patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
    attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
    unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
    patchReceiver: async () => {
      throw recoveryError;
    },
  });

  const patch: ApplyPatchAction = {
    actionId: 'act-patch-recovery-signal',
    kind: 'apply_patch',
    patchContent: '--- a/src/a.py\n+++ b/src/a.py\n+mod\n',
    targetPaths: ['src/a.py'],
    baseRevisionDigest: canonicalRev,
  };
  const context = createTestAdmissionContext(patch);

  await assert.rejects(
    () => tools.applyPatch(patch, context),
    (err: unknown) => {
      assert.ok(err instanceof PatchOutcomePendingError, 'the held outcome stays visible');
      const typed = err as { recoveryRequired?: boolean; unrecoveredPaths?: readonly string[]; recoveryError?: unknown };
      assert.strictEqual(typed.recoveryError, recoveryError);
      assert.equal(typed.recoveryRequired, true);
      assert.deepEqual(typed.unrecoveredPaths, ['src/a.py']);
      return true;
    },
  );

  const attempt = statePort.attemptReceipts.at(-1);
  assert.ok(attempt);
  assert.equal(statePort.outcomeReceipts.at(-1)?.outcome, 'uncertain');
});

test("PR222 C2: executor throws an ordinary error -> today's behavior (resolves with the recorded uncertain outcome)", async () => {
  const { manager, controller } = await createWorkspaceManager();
  controller.snapshotToReturn = {
    canonicalRevisionDigest: canonicalRev,
    entries: [{ path: 'src/a.py', kind: 'regular', content: 'test', digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }],
  };
  const fsPort = new FakeHostFilesystemPort(canonicalRev);
  const statePort = new FakeStatePortV02();
  statePort.recordOutcomeHandler = async receipt => ({ outcome: 'uncertain', receiptId: receipt.receiptId });

  const ordinaryError = new Error('ordinary patch executor failure');

  const tools = new ControlledRepositoryTools({
    guardCapability: fakeGuard,
    fsPort,
    limits: defaultLimits,
    statePort,
    workspaceManager: manager,
    adapterIdentity: 'patch-uncertain-recovery',
    processIncarnation: 'inc-patch-uncertain-recovery',
    fencingGeneration: 1,
    patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
    attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
    unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
    patchReceiver: async () => {
      throw ordinaryError;
    },
  });

  const patch: ApplyPatchAction = {
    actionId: 'act-patch-ordinary-failure',
    kind: 'apply_patch',
    patchContent: '--- a/src/a.py\n+++ b/src/a.py\n+mod\n',
    targetPaths: ['src/a.py'],
    baseRevisionDigest: canonicalRev,
  };
  const context = createTestAdmissionContext(patch);

  await assert.rejects(
    () => tools.applyPatch(patch, context),
    (err: unknown) => {
      assert.ok(err instanceof PatchOutcomePendingError, 'Must reject with PatchOutcomePendingError');
      assert.match((err as Error).message, /PATCH_OUTCOME_PENDING/);
      return true;
    },
  );

  const attempt = statePort.attemptReceipts.at(-1);
  assert.ok(attempt);
  assert.equal(statePort.outcomeReceipts.at(-1)?.outcome, 'uncertain');
});
