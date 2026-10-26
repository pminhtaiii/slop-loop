/**
 * UC-03 Section 10 Integrated Atomic Admission Acceptance Matrix (T066).
 *
 * Owned path: tests/runtime/contract/atomic-admission-matrix.test.ts
 * Feature: specs/001-verified-code-repair
 * Amendment: contracts/atomic-admission-amendment.md (Section 10)
 *
 * All 22 Section 10 deterministic mock acceptance cases in one integrated matrix:
 * 1. Policy/config publication before beginAttempt
 * 2. beginAttempt before policy publication or pause
 * 3. Pause/rejection after claim, before beginAttempt
 * 4. Repository writer/view drift before beginAttempt
 * 5. Duplicate successful receipt to one executor incarnation
 * 6. Protocol-owned version progression
 * 7. Fresh action/run ID while a claim is open
 * 8. Stale/duplicate executor after reconciliation
 * 9. Crash or lost response at every boundary
 * 10. Settlement/checkpoint failure after patch
 * 11. Uncertain versus observed-outcome recovery
 * 12. Failed/partial repair accounting
 * 13. Pre-plan baseline/test-only regression path
 * 14. Provider request/claim race
 * 15. Coder and reviewer provider branches
 * 16. Pre-plan outcome/idempotent settlement
 * 17. Cross-branch outcome/reconciliation fields
 * 18. Observed patch plus task-state conflict
 * 19. Provider budget regression
 * 20. Patch workspace-gate lifetime
 * 21. Uncertain receipt versus final reconciliation (critical)
 * 22. Version migration and old continuation receipt
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  computeAdmissionDigest,
  computeAttemptOutcomeDigest,
  computeActionDigest,
  isAdmittedForProduction,
  validateAdmissionV02,
  validateAttemptOutcomeReceiptV02,
  computeCanonicalSha256,
  computeCommandViewDigest,
  computeCheckSetDigest,
  CANONICAL_V02_SCHEMA_VERSION,
  REQUIRED_MIGRATION_CHECKPOINTS,
  createCanonicalCutoverSelectorV02,
  createNeutralCutoverSelectorV02,
  type TaskState,
  type AdmissionContextV02,
  type RepositoryAdmissionContextV02,
  type ProviderAdmissionContextV02,
  type ClaimReceiptV02,
  type AttemptReceiptV02,
  type AttemptOutcomeReceiptV02,
  type ClaimClosureReceiptV02,
  type RunCommandAction,
  type ApplyPatchAction,
  type CommandView,
  type ExecutionLimits,
  type BugTask,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  createApprovalControlV02,
  createApprovalContinuation,
  createApprovalContinuationV02,
} from '../../../src/approvals/control.ts';
import { buildPresentationV02 } from '../../../src/approvals/presentation.ts';
import { runApprovalCliV02 } from '../../../src/approvals/cli.ts';
import {
  UC05_APPROVAL_SCHEMA_VERSION_V02,
  computeDispatchClaimDigestV02,
  validateDispatchClaimV02,
  type DispatchClaimV02,
} from '../../../src/contracts/approvals/contracts.ts';
import type {
  AttemptReconciliationReceiptV02,
  PolicyAuthorityRefV02,
} from '../../../src/contracts/foundation/uc03/ports-v02.ts';
import {
  MemoryStatePortV02,
  isNeutralClaimReceiptV02,
  isNeutralAttemptReceiptV02,
  isNeutralOutcomeRecordResultV02,
} from '../support/uc03/memory-state.ts';
import {
  createTestAdmissionTaskStateV02,
  createTestAdmissionTransitionContextsV02,
  createTestExecutorIdentityV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryOutcomeReceiptV02,
  createTestProviderAdmissionContextV02,
  createTestProviderRequest,
  createTestAttemptOutcomeValidationContextV02,
  createTestUncertainReconciliationReceiptV02,
  createTestObservedReconciliationReceiptV02,
  createTestReconciliationValidationContextV02,
  createTestAction,
  createTestDiagnosticPatchAdmissionContextV02,
  createTestClaimClosureReceiptV02,
} from '../support/uc03/state-fixtures.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { createRecoveryScenario, recoveryProfile } from '../support/uc05/mock-recovery.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import {
  HostModelPortV02,
  computeContextDigest,
  type HostModelTransport,
  type HostModelTransportPayload,
} from '../../../src/foundation/model.ts';
import {
  computeFileDigest,
} from '../../../src/foundation/docker-workspace-policy.ts';
import {
  createFixtureSourceEvidence,
  createFixtureBugTask,
  createFixtureTaskState,
} from '../support/uc03/port-fixtures.ts';
import {
  DockerWorkspaceManager,
  StructuredCommandExecutor,
  type DockerProfile,
  type CanonicalSnapshotEntry,
  type DockerLifecycleController,
  type CanonicalRepositorySnapshot,
  type DockerContainerPlan,
  type ContainerExecutionOutput,
  type MaterializeViewParams,
} from '../../../src/foundation/docker-workspace.ts';
import { ControlledRepositoryTools } from '../../../src/foundation/repository-tools.ts';
import type { ExecutionGuardReadCapability, TrustedFilesystemPort } from '../../../src/foundation/repository-tools.ts';
import {
  investigateBaseline,
  type TrustedHostPort,
  type TrustedHostExpectedContext,
  type TrustedHostSnapshot,
} from '../../../src/uc03/investigation.ts';

// ---------------------------------------------------------------------------
// Deterministic Barrier & Helper Utilities (No sleeps, no timeouts)
// ---------------------------------------------------------------------------

function createBarrier(): {
  signal: () => void;
  wait: () => Promise<void>;
  isSignaled: () => boolean;
} {
  let signaled = false;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => {
      signaled = true;
      r();
    };
  });
  return {
    signal: resolve,
    wait: () => promise,
    isSignaled: () => signaled,
  };
}

function publicationAfter(context: RepositoryAdmissionContextV02): PolicyAuthorityRefV02 {
  return {
    policyId: context.policyAuthorityRef.policyId,
    policyVersion: `${context.policyAuthorityRef.policyVersion}.1`,
    configId: context.policyAuthorityRef.configId,
    configVersion: `${context.policyAuthorityRef.configVersion}.1`,
    issuerKeyRef: `${context.policyAuthorityRef.issuerKeyRef}-next`,
    decisionAuthorityGeneration: context.policyAuthorityRef.decisionAuthorityGeneration + 1,
  };
}

function createJournal(
  context: RepositoryAdmissionContextV02,
  options?: { readonly neutral?: boolean }
): MemoryStatePortV02 {
  const initialTaskState = createTestAdmissionTaskStateV02(context);
  return new MemoryStatePortV02({
    initialTaskState,
    transitionContexts: createTestAdmissionTransitionContextsV02(context, initialTaskState),
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: context.policyAuthorityRef,
    neutral: options?.neutral,
  });
}

function captureJournalReceipts(journal: MemoryStatePortV02) {
  const claims: ClaimReceiptV02[] = [];
  const attempts: AttemptReceiptV02[] = [];
  const outcomes: AttemptOutcomeReceiptV02[] = [];
  const claim = journal.claim.bind(journal);
  journal.claim = async (admission: AdmissionContextV02) => {
    const receipt = await claim(admission);
    if (receipt.claimId) claims.push(receipt);
    return receipt;
  };
  const beginAttempt = journal.beginAttempt.bind(journal);
  journal.beginAttempt = async (claimId, identity) => {
    const receipt = await beginAttempt(claimId, identity);
    if (!isNeutralAttemptReceiptV02(receipt)) attempts.push(receipt);
    return receipt;
  };
  const recordOutcome = journal.recordOutcome.bind(journal);
  journal.recordOutcome = async (receipt) => {
    outcomes.push(receipt);
    return await recordOutcome(receipt);
  };
  return { claims, attempts, outcomes };
}

function asRepositoryOutcome(receipt: AttemptOutcomeReceiptV02) {
  if (receipt.subjectKind !== 'repository-action') throw new Error('matrix expected a repository-action outcome');
  return receipt;
}

function asProviderOutcome(receipt: AttemptOutcomeReceiptV02) {
  if (receipt.subjectKind !== 'provider-request') throw new Error('matrix expected a provider-request outcome');
  return receipt;
}

async function createIntegratedPatchHarness(options?: {
  readonly context?: RepositoryAdmissionContextV02;
  readonly statePort?: MemoryStatePortV02;
  readonly beforePatch?: (input: {
    readonly patch: ApplyPatchAction;
    readonly context: RepositoryAdmissionContextV02;
    readonly attempt: AttemptReceiptV02;
    readonly apply: () => { readonly applied: true; readonly newRevisionDigest: string };
  }) => Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }>;
  readonly uncertainEvidence?: 'observed-patch' | 'proven-not-dispatched' | 'unavailable';
  readonly beforeUnattemptedClaimFence?: () => Promise<void>;
}) {
  const context = options?.context ?? createTestRepositoryAdmissionContextV02();
  if (context.action.kind !== 'apply_patch') throw new Error('matrix patch harness requires apply_patch context');
  const patch = context.action as ApplyPatchAction;
  const controller = new MockDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile({ profileId: context.executionProfileId });
  await manager.createWorkspace({
    taskId: context.taskId,
    workspaceId: context.workspaceId,
    initialRevisionDigest: context.canonicalRevision,
    profile,
  });
  let currentRevision = context.canonicalRevision;
  let effectCount = 0;
  let receiverCallCount = 0;
  const fsPort = createTestFilesystemPort(() => currentRevision);
  const journal = options?.statePort ?? createJournal(context);
  const initialTaskState = await journal.loadTask(context.taskId) ?? createTestAdmissionTaskStateV02(context);
  const claims: ClaimReceiptV02[] = [];
  const attempts: AttemptReceiptV02[] = [];
  const outcomes: AttemptOutcomeReceiptV02[] = [];
  const claimClosures: ClaimClosureReceiptV02[] = [];
  const originalClaim = journal.claim.bind(journal);
  journal.claim = async (admission) => {
    const receipt = await originalClaim(admission);
    if (receipt.claimId) claims.push(receipt);
    return receipt;
  };
  const beginAttempt = journal.beginAttempt.bind(journal);
  journal.beginAttempt = async (claimId, identity) => {
    const receipt = await beginAttempt(claimId, identity);
    if (!isNeutralAttemptReceiptV02(receipt)) attempts.push(receipt);
    return receipt;
  };
  const recordOutcome = journal.recordOutcome.bind(journal);
  journal.recordOutcome = async (receipt) => {
    outcomes.push(receipt);
    return await recordOutcome(receipt);
  };
  const recoveryIds: string[] = [];
  const applyEffect = () => {
    effectCount++;
    const newRevisionDigest = computeCanonicalSha256({
      actionDigest: context.actionDigest,
      attemptId: journal.getJournalSnapshot().attempts.at(-1)?.attemptId,
      priorRevision: currentRevision,
    });
    currentRevision = newRevisionDigest;
    manager.setCanonicalRevision(context.workspaceId, newRevisionDigest);
    controller.snapshotToReturn = {
      canonicalRevisionDigest: newRevisionDigest,
      entries: [createSnapshotEntry('tests/test_calculator.py', 'def test_reproduction(): pass\n')],
    };
    return { applied: true as const, newRevisionDigest };
  };
  const patchRecoveryHandoff = createMatrixRecoveryHandoff(journal, () => currentRevision, options?.uncertainEvidence);
  const unattemptedClaimClosureHandoff = {
    async closeUnattemptedClaim(input: {
      readonly admission: RepositoryAdmissionContextV02;
      readonly claim: ClaimReceiptV02;
      readonly recipientIdentity: import('../../../src/contracts/foundation/uc03.ts').ExecutorIdentityV02;
    }) {
      let snapshot = journal.getJournalSnapshot();
      if (snapshot.mode === 'runnable') {
        const eventRef = `matrix-unattempted-${input.claim.claimId}`;
        if (!await journal.setTaskControl(input.admission.taskId, 'paused', eventRef)) return { closed: false, receiptId: '' };
        snapshot = journal.getJournalSnapshot();
      }
      if (!snapshot.holdEventDigest) return { closed: false, receiptId: '' };
      const eventRef = snapshot.holdRef;
      if (!eventRef) return { closed: false, receiptId: '' };
      const result = await createApprovalControlV02({ taskId: input.admission.taskId, journal }).closeUnattemptedClaim({
        claim: dispatchClaim(input.admission, input.claim),
        journalClaim: input.claim,
        recipientIdentity: input.recipientIdentity,
        pauseOrDenialEvent: {
          eventKind: snapshot.mode === 'rejected' ? 'denial' : 'pause',
          eventRef,
          eventDigest: snapshot.holdEventDigest,
        },
      });
      const journalClosure = journal.getJournalSnapshot().closures.find((row) => row.claimId === input.claim.claimId);
      if (journalClosure && result.receipt) {
        const committed = createTestClaimClosureReceiptV02(input.claim, result.receipt?.fencedExecutorIdentity, {
          receiptId: result.receipt.receiptId,
          reason: result.receipt.reason,
        });
        assert.equal(committed.receiptId, journalClosure.receiptId);
        assert.equal(committed.receiptDigest, journalClosure.receiptDigest);
        claimClosures.push(committed);
      }
      return { closed: result.closed, receiptId: result.receipt?.receiptId ?? '' };
    },
  };
  const attemptStartHandoff = createMatrixAttemptStartRecoveryHandoff(
    journal,
    attempts,
    claimClosures,
    options?.beforeUnattemptedClaimFence,
  );
  const tools = new ControlledRepositoryTools({
    guardCapability: createTestReadCapability(context.workspaceId, context.taskId),
    fsPort,
    limits: { maxExcerptBytes: 1024, maxResultCount: 20 },
    statePort: journal,
    taskControl: journal,
    workspaceManager: manager,
    adapterIdentity: 'matrix-patch-receiver',
    processIncarnation: 'matrix-patch-actor-1',
    fencingGeneration: 1,
    patchRecoveryHandoff,
    attemptStartRecoveryHandoff: attemptStartHandoff,
    unattemptedClaimClosureHandoff,
    patchReceiver: async (receivedPatch, receivedContext, attempt) => {
      receiverCallCount++;
      if (options?.beforePatch) return await options.beforePatch({
        patch: receivedPatch,
        context: receivedContext,
        attempt,
        apply: applyEffect,
      });
      return applyEffect();
    },
  });
  const guardRepository = new Proxy(tools, {
    get(target, property) {
      if (property === 'applyPatch') return async (receivedPatch: ApplyPatchAction, receivedContext: RepositoryAdmissionContextV02) => {
        try {
          return await tools.applyPatch(receivedPatch, receivedContext);
        } catch (error: unknown) {
          const recoveryId = (error as { readonly recoveryId?: unknown } | null)?.recoveryId;
          if (typeof recoveryId === 'string') recoveryIds.push(recoveryId);
          throw error;
        }
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const guard = createExecutionGuardV02({ ports: { statePort: journal, repositoryPort: guardRepository } });
  return {
    context,
    patch,
    initialTaskState,
    journal,
    guard,
    tools,
    claims,
    attempts,
    outcomes,
    claimClosures,
    attemptStartQueries: attemptStartHandoff.queriedIdentities,
    recoveryIds,
    recoveryReceipts: patchRecoveryHandoff.preparedReceipts,
    manager,
    controller,
    fsPort,
    get currentRevision() { return currentRevision; },
    setFilesystemRevision(revisionDigest: string) { currentRevision = revisionDigest; },
    setUncertainRecoveryEvidence(evidence: 'observed-patch' | 'proven-not-dispatched' | 'unavailable') {
      patchRecoveryHandoff.setUncertainEvidence(evidence);
    },
    get effectCount() { return effectCount; },
    get receiverCallCount() { return receiverCallCount; },
  };
}

async function createIntegratedCommandHarness(options?: {
  readonly context?: RepositoryAdmissionContextV02;
  readonly statePort?: MemoryStatePortV02;
  readonly uncertainEvidence?: 'proven-not-dispatched' | 'unavailable';
  readonly beforeExecute?: () => Promise<void>;
  readonly preInvokeBarrier?: () => Promise<void>;
  readonly executionOutput?: ContainerExecutionOutput;
  readonly timeoutLimit?: number;
}) {
  const preliminary = options?.context ?? createTestRepositoryCommandAdmissionContextV02({
    action: createTestAction({
      actionId: 'act-matrix-command',
      argv: ['-q', 'tests/test_calculator.py'],
      purpose: 'Run admitted matrix check',
      workingDirectory: '/workspace/repo',
    }),
  });
  if (preliminary.action.kind !== 'run_command') throw new Error('matrix command harness requires run_command context');
  const controller = new MockDockerLifecycleController();
  controller.executionOutput = options?.executionOutput ?? controller.executionOutput;
  if (options?.beforeExecute) controller.beforeExecute = options.beforeExecute;
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile({ profileId: preliminary.executionProfileId });
  await manager.createWorkspace({
    taskId: preliminary.taskId,
    workspaceId: preliminary.workspaceId,
    initialRevisionDigest: preliminary.canonicalRevision,
    profile,
  });
  controller.snapshotToReturn = {
    canonicalRevisionDigest: preliminary.canonicalRevision,
    entries: [createSnapshotEntry('tests/test_calculator.py', 'def test_reproduction(): pass\n')],
  };
  const activeView = await manager.admitCommandView({ workspaceId: preliminary.workspaceId });
  const commandViewIdentity = {
    viewId: activeView.viewId,
    taskId: activeView.taskId,
    workspaceId: activeView.workspaceId,
    canonicalRevision: activeView.canonicalRevisionDigest,
    admittedFiles: activeView.admittedFiles,
    exclusionsPolicyVersion: 'exclusions-v1',
    scratchIdentity: 'scratch-admission-v02',
    mountedReadOnly: true as const,
    isolationProfileRef: preliminary.executionProfileId,
  };
  const commandView = {
    ...commandViewIdentity,
    viewDigest: computeCommandViewDigest(commandViewIdentity as unknown as Omit<CommandView, 'viewDigest'>),
  };
  const adaptedActiveView: CommandView = {
    viewId: commandView.viewId,
    viewDigest: commandView.viewDigest,
    taskId: commandView.taskId,
    workspaceId: commandView.workspaceId,
    canonicalRevisionDigest: commandView.canonicalRevision,
    admittedFiles: commandView.admittedFiles,
    exclusionsPolicyVersion: commandView.exclusionsPolicyVersion,
    scratchIdentity: commandView.scratchIdentity,
    mountedReadOnly: true,
  };
  const contextWorkspaceId = preliminary.workspaceId;
  manager.getActiveCommandView = (workspaceId) => workspaceId === contextWorkspaceId ? adaptedActiveView : null;
  const withoutAdmissionDigest = { ...preliminary, commandView, admissionDigest: '' };
  const context = {
    ...withoutAdmissionDigest,
    admissionDigest: computeAdmissionDigest(withoutAdmissionDigest),
  } as RepositoryAdmissionContextV02;
  const initialBase = createTestAdmissionTaskStateV02(context);
  const initialTaskState: TaskState = {
    ...initialBase,
    budgetLedgers: [
      ...(initialBase.budgetLedgers ?? []),
      {
        scope: 'task',
        kind: 'timeoutMs',
        limit: options?.timeoutLimit ?? 60_000,
        consumed: 0,
        reservations: [],
        unit: 'count',
        configurationId: 'config-v1',
        version: 1,
      },
    ],
  };
  const journal = options?.statePort ?? new MemoryStatePortV02({
    initialTaskState,
    transitionContexts: createTestAdmissionTransitionContextsV02(context, initialTaskState),
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: context.policyAuthorityRef,
  });
  const admittedTaskState = await journal.loadTask(context.taskId) ?? initialTaskState;
  const claims: ClaimReceiptV02[] = [];
  const outcomes: AttemptOutcomeReceiptV02[] = [];
  const claim = journal.claim.bind(journal);
  journal.claim = async (admission) => {
    const receipt = await claim(admission);
    if (receipt.claimId) claims.push(receipt);
    return receipt;
  };
  const recordOutcome = journal.recordOutcome.bind(journal);
  journal.recordOutcome = async (receipt) => {
    outcomes.push(receipt);
    return await recordOutcome(receipt);
  };
  const attempts: AttemptReceiptV02[] = [];
  const beginAttempt = journal.beginAttempt.bind(journal);
  journal.beginAttempt = async (claimId, identity) => {
    const receipt = await beginAttempt(claimId, identity);
    if (!isNeutralAttemptReceiptV02(receipt)) attempts.push(receipt);
    return receipt;
  };
  const fsPort = createTestFilesystemPort(() => context.canonicalRevision);
  const executor = new StructuredCommandExecutor({
    manager,
    controller,
    profile,
    adapterIdentity: 'matrix-command-receiver',
    processIncarnation: 'matrix-command-actor-1',
    fencingGeneration: 1,
  });
  let executorError: unknown;
  const execute = executor.execute.bind(executor);
  executor.execute = async (params) => {
    try {
      return await execute({ ...params, ...(options?.preInvokeBarrier ? { preInvokeBarrier: options.preInvokeBarrier } : {}) });
    } catch (error: unknown) {
      executorError = error;
      throw error;
    }
  };
  const unattemptedClaimClosureHandoff = {
    async closeUnattemptedClaim(input: {
      readonly admission: RepositoryAdmissionContextV02;
      readonly claim: ClaimReceiptV02;
      readonly recipientIdentity: import('../../../src/contracts/foundation/uc03.ts').ExecutorIdentityV02;
    }) {
      const eventRef = `matrix-unattempted-${input.claim.claimId}`;
      if (!await journal.setTaskControl(input.admission.taskId, 'paused', eventRef)) return { closed: false, receiptId: '' };
      const snapshot = journal.getJournalSnapshot();
      if (!snapshot.holdEventDigest) return { closed: false, receiptId: '' };
      const result = await createApprovalControlV02({ taskId: input.admission.taskId, journal }).closeUnattemptedClaim({
        claim: dispatchClaim(input.admission, input.claim),
        journalClaim: input.claim,
        recipientIdentity: input.recipientIdentity,
        pauseOrDenialEvent: { eventKind: 'pause', eventRef, eventDigest: snapshot.holdEventDigest },
      });
      return { closed: result.closed, receiptId: result.receipt?.receiptId ?? '' };
    },
  };
  const tools = new ControlledRepositoryTools({
    guardCapability: createTestReadCapability(context.workspaceId, context.taskId),
    fsPort,
    limits: { maxExcerptBytes: 1024, maxResultCount: 20 },
    statePort: journal,
    taskControl: journal,
    workspaceManager: manager,
    commandExecutor: executor,
    trustedCommandResourcePolicy: {
      isolationProfileRef: context.executionProfileId,
      limits: { timeoutMs: 30_000, maxOutputBytes: 65_536, maxCpuCores: 1, maxMemoryBytes: 536_870_912, maxPids: 5 },
    },
    adapterIdentity: 'matrix-command-receiver',
    processIncarnation: 'matrix-command-actor-1',
    fencingGeneration: 1,
    patchRecoveryHandoff: createMatrixRecoveryHandoff(journal, () => context.canonicalRevision, options?.uncertainEvidence),
    attemptStartRecoveryHandoff: { async queryAttemptStart() { return { outcome: 'unknown' }; } },
    unattemptedClaimClosureHandoff,
  });
  const guard = createExecutionGuardV02({ ports: { statePort: journal, repositoryPort: tools } });
  return {
    context,
    action: context.action as RunCommandAction,
    initialTaskState: admittedTaskState,
    journal,
    claims,
    attempts,
    outcomes,
    guard,
    tools,
    manager,
    controller,
    executor,
    activeView: adaptedActiveView,
    get executorError() { return executorError; },
  };
}

function dispatchClaim(
  context: RepositoryAdmissionContextV02,
  journalClaim: ClaimReceiptV02
): DispatchClaimV02 {
  const authority = context.policyAuthorityRef;
  const unsigned = {
    schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
    claimId: journalClaim.claimId,
    claimDigest: '',
    taskId: journalClaim.taskId,
    runId: journalClaim.runId,
    taskStateSchemaVersion: context.taskStateSchemaVersion,
    expectedTaskStateVersion: journalClaim.preClaimTaskStateVersion,
    controlSchemaVersion: context.controlSchemaVersion,
    expectedControlVersion: journalClaim.preClaimControlVersion,
    expectedEpoch: journalClaim.epoch,
    policyIdentity: {
      policyId: authority.policyId,
      policyVersion: authority.policyVersion,
      configId: authority.configId,
      configVersion: authority.configVersion,
    },
    decisionRefs: context.actionDecisionReceipt ? [context.actionDecisionReceipt.decisionId] : [context.planDecisionRef],
    reservationRefs: [...journalClaim.reservationRefs],
    phase: 'claimed' as const,
    resultRef: null,
    subjectKind: 'repository-action' as const,
    planApplicability: context.planApplicability,
    actionId: context.action.actionId,
    actionDigest: context.actionDigest,
    repositoryStateDigest: context.canonicalRevision,
    planBindingDigest: context.planBindingDigest,
    planDecisionRef: context.planDecisionRef,
  };
  const candidate = { ...unsigned, claimDigest: computeDispatchClaimDigestV02(unsigned) };
  const checked = validateDispatchClaimV02(candidate);
  assert.equal(checked.ok, true);
  if (!checked.ok) throw new Error('test-dispatch-claim-is-invalid');
  return checked.value;
}

class MockDockerLifecycleController implements DockerLifecycleController {
  readonly provenance = 'mock' as const;
  private readonly volumes = new Set<string>();
  readonly createdVolumes: string[] = [];
  readonly removedVolumes: string[] = [];
  snapshotToReturn?: CanonicalRepositorySnapshot;
  readonly executedPlans: DockerContainerPlan[] = [];
  readonly materializedViews: MaterializeViewParams[] = [];
  readonly executionOutputs: ContainerExecutionOutput[] = [];
  beforeExecute?: () => Promise<void>;
  executionOutput: ContainerExecutionOutput = {
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    durationMs: 25,
    timedOut: false,
  };

  async createVolume(id: string): Promise<void> {
    this.volumes.add(id);
    this.createdVolumes.push(id);
  }

  async hasVolume(id: string): Promise<boolean> {
    return this.volumes.has(id);
  }

  async removeVolume(id: string): Promise<void> {
    this.volumes.delete(id);
    this.removedVolumes.push(id);
  }

  async getCanonicalSnapshot(workspaceId: string): Promise<CanonicalRepositorySnapshot> {
    if (!this.snapshotToReturn) {
      throw new Error(`NO_SNAPSHOT: workspace ${workspaceId}`);
    }
    return this.snapshotToReturn;
  }

  async materializeView(params: MaterializeViewParams): Promise<void> {
    this.materializedViews.push(structuredClone(params));
  }

  async executeContainer(plan: DockerContainerPlan): Promise<ContainerExecutionOutput> {
    const invocationIndex = this.executedPlans.length;
    this.executedPlans.push(plan);
    await this.beforeExecute?.();
    return this.executionOutputs[invocationIndex] ?? this.executionOutput;
  }

  async cleanup(): Promise<void> {}
}

function createSnapshotEntry(path: string, content: string): CanonicalSnapshotEntry {
  return {
    path,
    kind: 'file',
    digest: computeFileDigest(content),
    content: Buffer.from(content, 'utf8'),
  };
}

function createValidProfile(overrides?: Partial<DockerProfile>): DockerProfile {
  return {
    profileId: 'profile-uc03-standard',
    image: 'ghcr.io/pminhtaiii/slop-loop-runtime:0.1.0',
    imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    user: '1000:1000',
    readOnlyRootFilesystem: true,
    network: 'none',
    limits: {
      timeoutMs: 60000,
      maxMemoryBytes: 2147483648,
      maxCpuCores: 2,
      maxPids: 256,
    },
    mounts: [
      { source: 'vol-repo', target: '/workspace/repo', readOnly: true },
      { source: 'vol-scratch', target: '/workspace/scratch', readOnly: false },
    ],
    ...overrides,
  };
}

function createValidLimits(): ExecutionLimits {
  return {
    timeoutMs: 10000,
    maxMemoryBytes: 1024 * 1024 * 1024,
    maxCpuCores: 1,
    maxPids: 256,
    maxOutputBytes: 100000,
  };
}

function createTestFilesystemPort(readRevision: () => string): TrustedFilesystemPort {
  const stat = { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0 };
  return {
    provenance: 'mock',
    stat: async () => stat,
    lstat: async () => stat,
    realpath: async (path) => path,
    readDir: async () => [],
    readTextFile: async () => '',
    getCurrentRevisionDigest: async () => readRevision(),
  };
}

function createTestReadCapability(workspaceId: string, taskId: string): ExecutionGuardReadCapability {
  return {
    provenance: 'mock',
    capabilityId: `matrix-read-${taskId}`,
    workspaceId,
    taskId,
    mediateRead: async (operation) => operation.execute(),
  };
}

function createMatrixRecoveryHandoff(
  journal: MemoryStatePortV02,
  readRevision: () => string,
  uncertainEvidence: 'observed-patch' | 'proven-not-dispatched' | 'unavailable' = 'unavailable',
) {
  let selectedEvidence = uncertainEvidence;
  const preparedReceipts: AttemptReconciliationReceiptV02[] = [];
  return {
    preparedReceipts,
    setUncertainEvidence(evidence: 'observed-patch' | 'proven-not-dispatched' | 'unavailable') {
      selectedEvidence = evidence;
    },
    async prepare(input: {
      readonly admission: RepositoryAdmissionContextV02;
      readonly claim: ClaimReceiptV02;
      readonly attempt: AttemptReceiptV02;
      readonly outcome: AttemptOutcomeReceiptV02;
    }) {
      if (input.outcome.outcome === 'observed') {
        const currentTask = await journal.loadTask(input.admission.taskId);
        assert.ok(currentTask);
        const receipt = createTestObservedReconciliationReceiptV02(input.outcome, input.claim, input.attempt, input.admission, {
          expectedCurrentTaskStateVersion: currentTask.stateVersion,
          expectedCurrentControlVersion: journal.getJournalSnapshot().controlVersion,
        });
        preparedReceipts.push(receipt);
        return {
          receipt,
          validationContext: createTestReconciliationValidationContextV02(
            receipt, input.outcome, input.claim, input.attempt, input.admission,
          ),
        };
      }

      const eventRef = `matrix-recovery-${input.attempt.attemptId}`;
      assert.equal(await journal.setTaskControl(input.admission.taskId, 'paused', eventRef), true);
      assert.ok(await journal.fenceAttemptRecipient(input.claim.claimId, input.attempt.executorIdentity));
      let receipt: AttemptReconciliationReceiptV02;
      const observedRevision = readRevision();
      if (selectedEvidence === 'unavailable') throw new Error('NO_TRUSTED_RECOVERY_EVIDENCE');
      if (selectedEvidence === 'observed-patch' && observedRevision !== input.admission.canonicalRevision && input.admission.action.kind === 'apply_patch') {
        const accountingEvidenceRefs = [{
          reference: `matrix-accounting-${input.attempt.attemptId}`,
          digest: computeCanonicalSha256(`matrix-accounting-${input.attempt.attemptId}`),
        }];
        const effectEvidenceRef = {
          reference: `matrix-effect-${input.attempt.attemptId}`,
          digest: computeCanonicalSha256({
            schemaVersion: 'uc03-observed-patch-recovery/0.2-draft',
            predecessorReceiptId: input.outcome.receiptId,
            observedRevisionDigest: observedRevision,
            invalidatedEvidence: [],
            accountingEvidenceRefs,
          }),
        };
        assert.equal(await journal.publishRecoveryEvidence({
          predecessorReceiptId: input.outcome.receiptId,
          effectEvidenceRef,
          accountingEvidenceRefs,
          observedRevisionDigest: observedRevision,
          invalidatedEvidence: [],
        }), true);
        receipt = createTestUncertainReconciliationReceiptV02(input.outcome, input.claim, input.attempt, input.admission, {
          disposition: 'observed-and-accounted',
          effectEvidenceRef,
          accountingEvidenceRefs,
          evidenceRefs: [effectEvidenceRef, ...accountingEvidenceRefs],
          expectedCurrentTaskStateVersion: (await journal.loadTask(input.admission.taskId))?.stateVersion ?? input.attempt.postBeginTaskStateVersion,
          expectedCurrentControlVersion: journal.getJournalSnapshot().controlVersion,
        });
      } else if (selectedEvidence === 'proven-not-dispatched') {
        assert.equal(observedRevision, input.admission.canonicalRevision, 'No-dispatch evidence must retain the admitted revision');
        receipt = createTestUncertainReconciliationReceiptV02(input.outcome, input.claim, input.attempt, input.admission, {
          disposition: 'proven-not-dispatched',
          expectedCurrentTaskStateVersion: (await journal.loadTask(input.admission.taskId))?.stateVersion ?? input.attempt.postBeginTaskStateVersion,
          expectedCurrentControlVersion: journal.getJournalSnapshot().controlVersion,
        });
      } else {
        throw new Error('RECOVERY_EVIDENCE_DOES_NOT_MATCH_OUTCOME');
      }
      preparedReceipts.push(receipt);
      return {
        receipt,
        validationContext: createTestReconciliationValidationContextV02(
          receipt, input.outcome, input.claim, input.attempt, input.admission,
        ),
      };
    },
  };
}

function createMatrixAttemptStartRecoveryHandoff(
  journal: MemoryStatePortV02,
  attempts: readonly AttemptReceiptV02[],
  claimClosures: ClaimClosureReceiptV02[],
  beforeUnattemptedFence?: () => Promise<void>,
) {
  const queriedIdentities: import('../../../src/contracts/foundation/uc03.ts').ExecutorIdentityV02[] = [];
  return {
    queriedIdentities,
    async queryAttemptStart(request: {
      readonly recoveryId: string;
      readonly admission: RepositoryAdmissionContextV02;
      readonly claim: ClaimReceiptV02;
      readonly executorIdentity: import('../../../src/contracts/foundation/uc03.ts').ExecutorIdentityV02;
    }): Promise<unknown> {
      queriedIdentities.push(structuredClone(request.executorIdentity));
      const snapshot = journal.getJournalSnapshot();
      const committed = attempts.find((attempt) => attempt.claimId === request.claim.claimId);
      if (committed && snapshot.attempts.some((attempt) =>
        attempt.claimId === request.claim.claimId && attempt.attemptId === committed.attemptId)) {
        return { outcome: 'committed', attempt: committed };
      }
      const claimState = snapshot.claims.find((claim) => claim.claimId === request.claim.claimId);
      if (!claimState || claimState.status !== 'claimed' || claimState.attemptId !== null ||
        snapshot.activeClaimId !== request.claim.claimId) return { outcome: 'unknown' };
      if (snapshot.mode === 'runnable') {
        const eventRef = `matrix-attempt-start-${request.claim.claimId}`;
        if (!await journal.setTaskControl(request.admission.taskId, 'paused', eventRef)) return { outcome: 'unknown' };
      }
      await beforeUnattemptedFence?.();
      const fence = await journal.fenceClaimRecipient(request.claim.claimId, request.executorIdentity);
      if (!fence) return { outcome: 'unknown' };
      const closureReceipt = createTestClaimClosureReceiptV02(
        request.claim,
        fence.fencedExecutorIdentity,
        { reason: fence.holdRef },
      );
      claimClosures.push(closureReceipt);
      return {
        outcome: 'unattempted',
        claim: { ...request.claim, hasCommittedAttempt: false },
        closureReceipt,
      };
    },
  };
}

class StubTransport implements HostModelTransport {
  callCount = 0;
  beforeExecute?: () => Promise<void>;
  lastPayload: HostModelTransportPayload | null = null;
  response: unknown = {
    proposal: {
      proposalId: 'proposal-valid-001',
      content: 'Proposed fix for zero division',
    },
    observedUsage: {
      inputTokens: 150,
      outputTokens: 75,
      billableTokens: 225,
      costUsd: 0.005,
    },
  };
  throwError: Error | null = null;

  async execute(payload: HostModelTransportPayload): Promise<unknown> {
    this.callCount++;
    this.lastPayload = payload;
    await this.beforeExecute?.();
    if (this.throwError) {
      throw this.throwError;
    }
    return this.response;
  }
}

function createBoundHostPort(task: BugTask): TrustedHostPort {
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  const expectedTestFiles = ['tests/test_calculator.py'];
  const snapshot: TrustedHostSnapshot = {
    taskId: task.taskId,
    workspaceId: 'workspace-uc03-test',
    repositoryId: task.repositoryId,
    currentRevision: task.initialRevisionDigest,
    checkSetDigest,
    expectedTestFiles,
    testFiles: [{ path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' }],
  };
  return {
    loadSnapshot: async () => snapshot,
  };
}

function createTrustedAdmissionContext(
  task: BugTask,
  overrides?: Partial<TrustedHostExpectedContext>
): TrustedHostExpectedContext {
  return {
    taskId: task.taskId,
    workspaceId: 'workspace-uc03-test',
    repositoryId: task.repositoryId,
    revisionDigest: task.initialRevisionDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    expectedTestFiles: ['tests/test_calculator.py'],
    ...overrides,
  };
}


function authorityForV02(context: ProviderAdmissionContextV02): PolicyAuthorityRefV02 {
  return {
    policyId: context.providerIdentity.pricingPolicyId,
    policyVersion: context.providerIdentity.pricingPolicyVersion,
    configId: context.providerIdentity.configId,
    configVersion: context.providerIdentity.configVersion,
    issuerKeyRef: context.providerIdentity.issuerKeyRef,
    decisionAuthorityGeneration: context.providerIdentity.decisionAuthorityGeneration,
  };
}

function createValidV02Setup(options?: {
  role?: 'coder' | 'reviewer';
  planApplicability?: 'approved-plan' | 'pre-plan-diagnostic';
  requestId?: string;
  transport?: StubTransport;
  statePort?: MemoryStatePortV02;
}) {
  const role = options?.role ?? 'coder';
  const planApplicability = options?.planApplicability ?? 'approved-plan';
  const requestId = options?.requestId ?? 'req-model-001';
  const transport = options?.transport ?? new StubTransport();

  const state = createFixtureTaskState();
  const evidence = [createFixtureSourceEvidence({ revisionDigest: state.repositoryRevisionDigest })];

  const dummyReq = createTestProviderRequest({
    providerRequestId: requestId,
    taskId: state.taskId,
    runId: state.runId,
    role,
    contextDigest: 'sha256:dummy',
  });

  const dummyContext = createTestProviderAdmissionContextV02({
    taskId: state.taskId,
    runId: state.runId,
    planApplicability,
    runnableNode: planApplicability === 'pre-plan-diagnostic' ? 'Investigate' : 'Repair',
    ...(planApplicability === 'pre-plan-diagnostic'
      ? {
          diagnosticPurpose: 'baseline diagnostic',
          taskCriteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
          planBindingDigest: undefined,
          planDecisionRef: undefined,
        }
      : {}),
    providerRequest: dummyReq,
  });

  const initialTaskState = createTestAdmissionTaskStateV02(dummyContext);
  const taskState: TaskState = {
    ...initialTaskState,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
  };

  const contextDigest = computeContextDigest(taskState, evidence);

  const baseRequest = createTestProviderRequest({
    providerRequestId: requestId,
    taskId: taskState.taskId,
    runId: taskState.runId,
    role,
    contextDigest,
  });

  const baseContext = createTestProviderAdmissionContextV02({
    taskId: taskState.taskId,
    runId: taskState.runId,
    planApplicability,
    runnableNode: planApplicability === 'pre-plan-diagnostic' ? 'Investigate' : 'Repair',
    ...(planApplicability === 'pre-plan-diagnostic'
      ? {
          diagnosticPurpose: 'baseline diagnostic',
          taskCriteriaDigest: computeCanonicalSha256(taskState.acceptanceCriteria),
          planBindingDigest: undefined,
          planDecisionRef: undefined,
        }
      : {}),
    providerRequest: baseRequest,
  });

  const authority = authorityForV02(baseContext);
  const statePort = options?.statePort ?? new MemoryStatePortV02({
    initialTaskState: taskState,
    initialAuthorityRef: authority,
    initialControlVersion: baseContext.expectedControlVersion,
    initialEpoch: baseContext.expectedEpoch,
  });

  const actor = { adapterIdentity: 'test-provider', processIncarnation: randomUUID(), fencingGeneration: 1 };
  const port = new HostModelPortV02({
    transport,
    statePort,
    executorIdentity: actor,
    currentExecutorIdentity: () => actor,
    providerConfig: {
      providerId: baseRequest.providerId,
      modelId: baseRequest.modelId,
      configId: baseRequest.configId,
      pricingPolicyId: baseRequest.pricingPolicyId,
    },
  });

  return { port, transport, statePort, actor, state: taskState, evidence, request: baseRequest, context: baseContext };
}

// ---------------------------------------------------------------------------
// Invariants: Controlled Mock Provenance
// ---------------------------------------------------------------------------

test('Controlled mock composition rejects production admission via isAdmittedForProduction', () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const selector = createCanonicalCutoverSelectorV02();
  const repo = new FakeRepositoryPort();
  assert.equal(isAdmittedForProduction([journal]), false);
  assert.equal(isAdmittedForProduction([selector]), false);
  assert.equal(isAdmittedForProduction([repo]), false);
});

// ---------------------------------------------------------------------------
// Section 10 Case 1: Policy/config publication before beginAttempt
// ---------------------------------------------------------------------------

test('Section 10 Case 1: Policy/config publication before beginAttempt leaves old receipt stale and invocation count zero', async () => {
  const entered = createBarrier();
  const release = createBarrier();
  const closureReady = createBarrier();
  const releaseClosure = createBarrier();
  const harness = await createIntegratedPatchHarness({
    beforeUnattemptedClaimFence: async () => {
      closureReady.signal();
      await releaseClosure.wait();
    },
  });
  const beginAttempt = harness.journal.beginAttempt.bind(harness.journal);
  harness.journal.beginAttempt = async (claimId, identity) => {
    entered.signal();
    await release.wait();
    return await beginAttempt(claimId, identity);
  };
  const guarded = harness.guard.validateAndExecute(harness.patch, harness.initialTaskState, harness.context);
  await entered.wait();

  const claim = harness.claims[0];
  assert.ok(claim);
  assert.equal(claim.status, 'claimed');
  assert.equal(claim.preClaimTaskStateVersion, harness.context.expectedTaskStateVersion);
  assert.equal(claim.preClaimControlVersion, harness.context.expectedControlVersion);
  assert.equal(claim.postClaimControlVersion, harness.context.expectedControlVersion + 1);
  assert.deepEqual(claim.reservationRefs, harness.context.reservationRefs);
  const claimTask = await harness.journal.loadTask(harness.context.taskId);
  assert.equal(claimTask?.stateVersion, harness.context.expectedTaskStateVersion);
  const heldRepair = harness.journal.getLedgers().find((ledger) => ledger.kind === 'repair');
  assert.deepEqual(heldRepair?.reservations.map((item) => item.reservationId), claim.reservationRefs,
    'The claim reservation remains held while the stale receipt is fenced');

  const authorityRef = publicationAfter(harness.context);
  const published = await createApprovalControlV02({ taskId: harness.context.taskId, journal: harness.journal })
    .publishAuthority({ authorityRef });
  assert.equal(published.outcome, 'ok');
  release.signal();
  const result = await guarded;
  assert.equal(result.outcome, 'uncertain-effect');
  assert.equal(harness.recoveryIds.length, 1);
  const recovery = harness.tools.recoverAttemptStart(harness.recoveryIds[0]!);
  await closureReady.wait();
  const beforeFence = harness.journal.getJournalSnapshot();
  assert.equal(beforeFence.claims[0]?.status, 'claimed');
  assert.equal(beforeFence.attempts.length, 0);
  assert.equal(beforeFence.mode, 'paused');
  assert.equal(beforeFence.controlVersion, harness.context.expectedControlVersion + 3);
  assert.equal(beforeFence.fenceProofs.length, 0);
  assert.deepEqual(harness.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations.map((item) => item.reservationId), claim.reservationRefs,
    'No reservation is released before the recipient fence and closure proof exist');
  releaseClosure.signal();
  const recovered = await recovery;
  assert.equal(recovered.outcome, 'settled', 'Fenced no-attempt evidence closes the claim');

  const snapshot = harness.journal.getJournalSnapshot();
  assert.equal(harness.controller.executedPlans.length, 0);
  assert.equal(harness.receiverCallCount, 0);
  assert.equal(snapshot.attempts.length, 0);
  assert.equal(snapshot.claims[0]?.status, 'closed');
  assert.equal(snapshot.fenceProofs.length, 1);
  assert.deepEqual(harness.claimClosures.map((receipt) => receipt.unconsumedReservations), [claim.reservationRefs]);
  assert.equal('attemptId' in harness.claimClosures[0]!, false, 'Unattempted closure carries no attempt identity');
  assert.equal(harness.claimClosures[0]?.reason, snapshot.holdRef);
  const oldActor = harness.attemptStartQueries[0];
  assert.ok(oldActor);
  assert.ok(snapshot.fencedIncarnations.length === 1, 'The owner fences the old actor before releasing its reservation');
  assert.equal(isNeutralAttemptReceiptV02(await harness.journal.beginAttempt(claim.claimId, oldActor)), true,
    'A fenced actor cannot begin or launch after the unattempted closure');
  assert.deepEqual(snapshot.activeAuthorityRef, authorityRef);
  const repairLedger = harness.journal.getLedgers().find((ledger) => ledger.kind === 'repair');
  assert.equal(repairLedger?.consumed, 0);
  assert.deepEqual(repairLedger?.reservations, []);
});

// ---------------------------------------------------------------------------
// Section 10 Case 2: beginAttempt before policy publication or pause
// ---------------------------------------------------------------------------

test('Section 10 Case 2: beginAttempt before policy publication or pause admits one attempt under captured refs', async () => {
  const entered = createBarrier();
  const release = createBarrier();
  const harness = await createIntegratedPatchHarness({
    beforePatch: async ({ apply }) => {
      entered.signal();
      await release.wait();
      return apply();
    },
  });
  const guarded = harness.guard.validateAndExecute(harness.patch, harness.initialTaskState, harness.context);
  await entered.wait();
  const capturedClaim = harness.claims[0];
  const capturedAttempt = harness.attempts[0];
  assert.ok(capturedClaim);
  assert.ok(capturedAttempt);
  const admittedControlVersion = capturedAttempt.postBeginControlVersion;
  assert.equal(capturedAttempt.status, 'attempting');
  assert.equal(capturedAttempt.preAttemptTaskStateVersion, capturedClaim.preClaimTaskStateVersion);
  assert.equal(capturedAttempt.preAttemptControlVersion, capturedClaim.postClaimControlVersion);
  assert.deepEqual(capturedClaim.reservationRefs, harness.context.reservationRefs);
  assert.equal(harness.journal.getJournalSnapshot().attempts.length, 1, 'The journal committed beginAttempt before the receiver barrier');

  const authorityRef = publicationAfter(harness.context);
  const published = await createApprovalControlV02({ taskId: harness.context.taskId, journal: harness.journal })
    .publishAuthority({ authorityRef });
  assert.equal(published.outcome, 'ok');
  const pauseRef = 'pause-after-admitted-attempt-case-2';
  assert.equal(await harness.journal.setTaskControl(harness.context.taskId, 'paused', pauseRef), true);
  release.signal();
  const result = await guarded;
  assert.equal(result.outcome, 'success');

  const snapshot = harness.journal.getJournalSnapshot();
  assert.equal(snapshot.attempts.length, 1);
  assert.equal(snapshot.claims[0]?.status, 'settled');
  assert.deepEqual(snapshot.activeAuthorityRef, authorityRef, 'New authority remains active for later work');
  assert.equal(snapshot.mode, 'paused', 'The later hold remains active for the next operation');
  assert.equal(snapshot.holdRef, pauseRef);
  assert.deepEqual(harness.claims[0]?.reservationRefs, capturedClaim.reservationRefs);
  const observed = harness.outcomes[0];
  assert.ok(observed);
  const repositoryObserved = asRepositoryOutcome(observed);
  assert.equal(repositoryObserved.outcome, 'observed');
  assert.equal(repositoryObserved.actionDigest, harness.context.actionDigest);
  assert.equal(repositoryObserved.admissionDigest, computeAdmissionDigest(harness.context));
  assert.deepEqual(repositoryObserved.proposedEffects.accounting.reservationRefs, capturedClaim.reservationRefs);
  assert.equal(computeCanonicalSha256(repositoryObserved.policyAuthorityRef), computeCanonicalSha256(harness.context.policyAuthorityRef),
    'The completed attempt settles under the policy refs captured before publication');
  assert.equal(repositoryObserved.versions.postAttemptControlVersion, admittedControlVersion);
  assert.equal(harness.effectCount, 1);
  const taskAfter = await harness.journal.loadTask(harness.context.taskId);
  assert.equal(taskAfter?.node, 'Verify');
  assert.equal(taskAfter?.stateVersion, harness.context.expectedTaskStateVersion + 2);
  const repairLedger = harness.journal.getLedgers().find((ledger) => ledger.kind === 'repair');
  assert.equal(repairLedger?.consumed, 1);

  // An ended/cancel request after begin also cannot erase an already admitted call's observed result.
  const endingEntered = createBarrier();
  const endingRelease = createBarrier();
  const ending = await createIntegratedPatchHarness({
    beforePatch: async ({ apply }) => {
      endingEntered.signal();
      await endingRelease.wait();
      return apply();
    },
  });
  const endingRun = ending.guard.validateAndExecute(ending.patch, ending.initialTaskState, ending.context);
  await endingEntered.wait();
  const endingAttempt = ending.attempts[0];
  assert.ok(endingAttempt);
  const endedRef = 'cancel-after-begin-case-2';
  assert.equal(await ending.journal.setTaskControl(ending.context.taskId, 'ended', endedRef), true);
  endingRelease.signal();
  assert.equal((await endingRun).outcome, 'success');
  assert.equal(ending.journal.getJournalSnapshot().mode, 'ended');
  assert.equal(ending.journal.getJournalSnapshot().holdRef, endedRef);
  assert.equal(ending.journal.getJournalSnapshot().attempts[0]?.status, 'settled');
  assert.equal(ending.effectCount, 1);
  assert.equal(ending.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);
});

// ---------------------------------------------------------------------------
// Section 10 Case 3: Pause/rejection after claim, before beginAttempt
// ---------------------------------------------------------------------------

test('Section 10 Case 3: Pause and rejection after claim deny begin, then close only with a tagged fenced proof', async () => {
  for (const mode of ['paused', 'rejected'] as const) {
    const entered = createBarrier();
    const release = createBarrier();
    const closureReady = createBarrier();
    const releaseClosure = createBarrier();
    const harness = await createIntegratedPatchHarness({
      beforeUnattemptedClaimFence: async () => {
        closureReady.signal();
        await releaseClosure.wait();
      },
    });
    const beginAttempt = harness.journal.beginAttempt.bind(harness.journal);
    harness.journal.beginAttempt = async (claimId, identity) => {
      entered.signal();
      await release.wait();
      return await beginAttempt(claimId, identity);
    };
    const guarded = harness.guard.validateAndExecute(harness.patch, harness.initialTaskState, harness.context);
    await entered.wait();
    const claim = harness.claims[0];
    assert.ok(claim);
    const holdRef = `${mode}-event-c3`;
    assert.equal(await harness.journal.setTaskControl(harness.context.taskId, mode, holdRef), true);
    release.signal();
    const result = await guarded;
    assert.equal(result.outcome, 'uncertain-effect');
    assert.equal(harness.recoveryIds.length, 1);
    const recovery = harness.tools.recoverAttemptStart(harness.recoveryIds[0]!);
    await closureReady.wait();

    const beforeFence = harness.journal.getJournalSnapshot();
    assert.equal(beforeFence.mode, mode);
    assert.equal(beforeFence.holdRef, holdRef);
    assert.equal(beforeFence.claims[0]?.status, 'claimed');
    assert.equal(beforeFence.attempts.length, 0);
    assert.equal(beforeFence.fenceProofs.length, 0);
    assert.deepEqual(harness.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations.map((item) => item.reservationId), claim.reservationRefs,
      'The unused reservation stays held until the fenced closure is accepted');
    releaseClosure.signal();

    const recovered = await recovery;
    assert.equal(recovered.outcome, 'settled');

    const snapshot = harness.journal.getJournalSnapshot();
    assert.equal(snapshot.mode, mode);
    assert.equal(snapshot.holdRef, holdRef);
    assert.equal(snapshot.activeClaimId, null);
    assert.equal(snapshot.claims[0]?.status, 'closed');
    assert.equal(snapshot.attempts.length, 0);
    assert.equal(harness.effectCount, 0);
    assert.equal(harness.receiverCallCount, 0);
    const closure = harness.claimClosures[0];
    assert.ok(closure);
    assert.deepEqual(closure.unconsumedReservations, claim.reservationRefs);
    assert.equal('attemptId' in closure, false);
    assert.equal(closure.reason, holdRef);
    assert.equal(closure.fencedExecutorIdentity.fencingGeneration, harness.attemptStartQueries[0]?.fencingGeneration! + 1);
    const repairLedger = harness.journal.getLedgers().find((ledger) => ledger.kind === 'repair');
    assert.equal(repairLedger?.consumed, 0, 'No repair allowance is consumed without a beginAttempt receipt');
    assert.deepEqual(repairLedger?.reservations, []);
  }
});

// ---------------------------------------------------------------------------
// Section 10 Case 4: Repository writer/view drift before beginAttempt
// ---------------------------------------------------------------------------

test('Section 10 Case 4: Repository writer/view drift before beginAttempt yields zero invocations', async () => {
  const command = await createIntegratedCommandHarness();
  const rev2 = 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  command.manager.setCanonicalRevision(command.context.workspaceId, rev2);
  const commandResult = await command.guard.validateAndExecute(command.action, command.initialTaskState, command.context);
  assert.equal(commandResult.outcome, 'uncertain-effect', 'A pinned view invalidated before beginAttempt is refused by the receiver');
  assert.equal(command.journal.getJournalSnapshot().claims.length, 0);
  assert.equal(command.controller.executedPlans.length, 0);

  const patch = await createIntegratedPatchHarness();
  patch.setFilesystemRevision(rev2);
  const patchResult = await patch.guard.validateAndExecute(patch.patch, patch.initialTaskState, patch.context);
  assert.equal(patchResult.outcome, 'uncertain-effect', 'The patch receiver compares the locked base with the trusted filesystem revision');
  assert.equal(patch.journal.getJournalSnapshot().claims.length, 0);
  assert.equal(patch.receiverCallCount, 0);
  assert.equal(patch.effectCount, 0);

  // When the admitted immutable view wins, later live snapshot changes cannot replace its bytes.
  const pinned = await createIntegratedCommandHarness();
  const entered = createBarrier();
  const release = createBarrier();
  const beginAttempt = pinned.journal.beginAttempt.bind(pinned.journal);
  pinned.journal.beginAttempt = async (claimId, identity) => {
    entered.signal();
    await release.wait();
    return await beginAttempt(claimId, identity);
  };
  const originalBytes = pinned.controller.materializedViews[0]?.files['tests/test_calculator.py'];
  assert.ok(originalBytes instanceof Uint8Array);
  assert.equal(Buffer.from(originalBytes).toString('utf8'), 'def test_reproduction(): pass\n');
  const pinnedView = pinned.activeView;
  const pinnedRun = pinned.guard.validateAndExecute(pinned.action, pinned.initialTaskState, pinned.context);
  await entered.wait();
  pinned.controller.snapshotToReturn = {
    canonicalRevisionDigest: pinned.context.canonicalRevision,
    entries: [createSnapshotEntry('tests/test_calculator.py', 'def test_reproduction(): fail\n')],
  };
  release.signal();
  assert.equal((await pinnedRun).outcome, 'success');
  assert.equal(pinned.controller.executedPlans.length, 1);
  assert.equal(pinned.controller.executedPlans[0]?.mounts.find((mount) => mount.target === '/workspace/repo')?.source, pinnedView.viewId);
  assert.deepEqual(pinned.controller.materializedViews[0]?.files['tests/test_calculator.py'], originalBytes,
    'Execution stays on the exact bytes admitted before the concurrent source changed');
  assert.equal(pinned.journal.getJournalSnapshot().attempts[0]?.status, 'settled');
});

// ---------------------------------------------------------------------------
// Section 10 Case 5: Duplicate successful receipt to one executor incarnation
// ---------------------------------------------------------------------------

test('Section 10 Case 5: Duplicate successful receipt to same executor incarnation with pre-invoke barrier allows exactly one dispatch', async () => {
  const atBarrier = createBarrier();
  const releaseBarrier = createBarrier();
  const harness = await createIntegratedCommandHarness({
    preInvokeBarrier: async () => {
      atBarrier.signal();
      await releaseBarrier.wait();
    },
  });
  const attempts: AttemptReceiptV02[] = [];
  const beginAttempt = harness.journal.beginAttempt.bind(harness.journal);
  harness.journal.beginAttempt = async (claimId, identity) => {
    const receipt = await beginAttempt(claimId, identity);
    attempts.push(receipt);
    return receipt;
  };

  const firstDeliveryPromise = harness.guard.validateAndExecute(
    harness.action, harness.initialTaskState, harness.context,
  );
  let completedBeforeInvokeBarrier = false;
  let earlyResult: Awaited<typeof firstDeliveryPromise> | undefined;
  void firstDeliveryPromise.then((result) => {
    if (!atBarrier.isSignaled()) {
      completedBeforeInvokeBarrier = true;
      earlyResult = result;
      atBarrier.signal();
    }
  });
  await atBarrier.wait();
  assert.equal(completedBeforeInvokeBarrier, false, `The guard must reach the receiver pre-invoke barrier before returning: ${JSON.stringify(earlyResult)}`);
  const attempt = attempts[0];
  assert.ok(attempt, 'The receiver reached the barrier with a journal-issued attempt');
  assert.equal(harness.controller.executedPlans.length, 0, 'The barrier is before low-level invocation');

  // Deliver the same real UC-04 attempt to the same adapter incarnation while its winner is held.
  await assert.rejects(
    () => harness.executor.execute({
      workspaceId: harness.context.workspaceId,
      action: harness.action,
      limits: createValidLimits(),
      view: harness.activeView,
      attempt,
    }),
    /DUPLICATE_ATTEMPT_CONSUMED/
  );

  releaseBarrier.signal();
  const result = await firstDeliveryPromise;
  assert.equal(result.outcome, 'success');
  assert.equal(harness.controller.executedPlans.length, 1, 'Exactly one low-level execution dispatch');

  // Process restart retains the journal but starts a fresh executor incarnation.
  const restarted = new StructuredCommandExecutor({
    manager: harness.manager,
    controller: harness.controller,
    profile: createValidProfile({ profileId: harness.context.executionProfileId }),
    adapterIdentity: 'matrix-command-receiver',
    processIncarnation: 'matrix-command-actor-2',
    fencingGeneration: 1,
  });
  await assert.rejects(
    () => restarted.execute({
      workspaceId: harness.context.workspaceId,
      action: harness.action,
      limits: createValidLimits(),
      view: harness.activeView,
      attempt,
    }),
    /RESTART_INCARNATION_MISMATCH/
  );
  assert.equal(harness.controller.executedPlans.length, 1);
  assert.equal(harness.journal.getJournalSnapshot().attempts[0]?.status, 'settled');

  // A lost low-level response after invocation remains uncertain and cannot mint a second permit.
  const lostResponse = await createIntegratedCommandHarness({
    beforeExecute: async () => { throw new Error('controller response lost after invoke'); },
  });
  const lostResult = await lostResponse.guard.validateAndExecute(
    lostResponse.action, lostResponse.initialTaskState, lostResponse.context,
  );
  assert.equal(lostResult.outcome, 'uncertain-effect');
  const lostAttempt = lostResponse.attempts[0];
  assert.ok(lostAttempt);
  const uncertain = lostResponse.journal.getJournalSnapshot();
  assert.equal(lostResponse.controller.executedPlans.length, 1);
  assert.equal(uncertain.attempts[0]?.status, 'uncertain');
  assert.equal(uncertain.claims[0]?.status, 'uncertain');
  assert.equal(uncertain.outcomes[0]?.outcome, 'uncertain');
  const heldCommandLedger = lostResponse.journal.getLedgers().find((ledger) => ledger.kind === 'timeoutMs');
  assert.deepEqual(heldCommandLedger?.reservations.map((item) => item.reservationId), lostResponse.claims[0]?.reservationRefs);
  await assert.rejects(
    () => lostResponse.executor.execute({
      workspaceId: lostResponse.context.workspaceId,
      action: lostResponse.action,
      limits: createValidLimits(),
      view: lostResponse.activeView,
      attempt: lostAttempt,
    }),
    /DUPLICATE_ATTEMPT_CONSUMED/
  );
  const restartedWithLostAttempt = new StructuredCommandExecutor({
    manager: lostResponse.manager,
    controller: lostResponse.controller,
    profile: createValidProfile({ profileId: lostResponse.context.executionProfileId }),
    adapterIdentity: 'matrix-command-receiver',
    processIncarnation: 'matrix-command-actor-after-lost-response',
    fencingGeneration: 1,
  });
  await assert.rejects(
    () => restartedWithLostAttempt.execute({
      workspaceId: lostResponse.context.workspaceId,
      action: lostResponse.action,
      limits: createValidLimits(),
      view: lostResponse.activeView,
      attempt: lostAttempt,
    }),
    /RESTART_INCARNATION_MISMATCH/
  );
  assert.equal(lostResponse.controller.executedPlans.length, 1);
  assert.equal(lostResponse.journal.getJournalSnapshot().attempts[0]?.status, 'uncertain');
});

// ---------------------------------------------------------------------------
// Section 10 Case 6: Protocol-owned version progression
// ---------------------------------------------------------------------------

test('Section 10 Case 6: Protocol-owned version progression increments task/control accurately and denies stale snapshots', async () => {
  const integrated = await createIntegratedPatchHarness();
  const dispatched = await integrated.guard.validateAndExecute(
    integrated.patch,
    integrated.initialTaskState,
    integrated.context,
  );
  assert.equal(dispatched.outcome, 'success');
  const integratedTask = await integrated.journal.loadTask(integrated.context.taskId);
  assert.ok(integratedTask);
  assert.equal(integratedTask.node, 'Verify');
  assert.equal(integratedTask.stateVersion, integrated.context.expectedTaskStateVersion + 2,
    'The public receiver owns begin and settlement version increments');
  assert.equal(integrated.journal.getJournalSnapshot().controlVersion, integrated.context.expectedControlVersion + 3,
    'Claim, beginAttempt and settlement each advance control state');
  assert.equal(integrated.attempts.length, 1);
  assert.equal(integrated.journal.getJournalSnapshot().attempts[0]?.status, 'settled');
  assert.equal(integrated.effectCount, 1);
  assert.equal(integrated.journal.getLedgers().find((ledger) => ledger.kind === 'tokens')?.consumed ?? 0, 0);
  assert.equal(integrated.journal.getLedgers().find((ledger) => ledger.kind === 'cost')?.consumed ?? 0, 0);

  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const task0 = await journal.loadTask(context.taskId);
  assert.ok(task0);
  assert.equal(task0.stateVersion, context.expectedTaskStateVersion); // S0
  assert.equal(journal.getJournalSnapshot().controlVersion, context.expectedControlVersion); // C0

  // Claim commit: S0 / C1 / E0
  const claim = await journal.claim(context);
  assert.equal(claim.preClaimTaskStateVersion, context.expectedTaskStateVersion); // S0
  assert.equal(claim.preClaimControlVersion, context.expectedControlVersion); // C0
  assert.equal(claim.postClaimControlVersion, context.expectedControlVersion + 1); // C1
  assert.equal(journal.getJournalSnapshot().controlVersion, context.expectedControlVersion + 1);

  // Repair begin: commits S1 / C2 / E0
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await journal.beginAttempt(claim.claimId, actor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);
  assert.equal(attempt.preAttemptTaskStateVersion, context.expectedTaskStateVersion); // S0
  assert.equal(attempt.postBeginTaskStateVersion, context.expectedTaskStateVersion + 1); // S1
  assert.equal(attempt.preAttemptControlVersion, context.expectedControlVersion + 1); // C1
  assert.equal(attempt.postBeginControlVersion, context.expectedControlVersion + 2); // C2

  const task1 = await journal.loadTask(context.taskId);
  assert.ok(task1);
  assert.equal(task1.node, 'Patch');
  assert.equal(task1.stateVersion, context.expectedTaskStateVersion + 1);
  assert.equal(journal.getJournalSnapshot().controlVersion, context.expectedControlVersion + 2);

  // Stale claim attempt on another task denies with neutral claim receipt
  const staleContext = createTestRepositoryAdmissionContextV02({
    taskId: 'task-stale-test-001',
    expectedControlVersion: 999, // Stale snapshot
  });
  const staleJournal = createJournal(staleContext);
  const staleClaim = await staleJournal.claim({
    ...staleContext,
    expectedControlVersion: 0, // Mismatched control version
  });
  assert.equal(isNeutralClaimReceiptV02(staleClaim), true);

  const unrelatedContext = createTestRepositoryAdmissionContextV02({ taskId: 'task-unrelated-update-006' });
  const unrelatedJournal = createJournal(unrelatedContext);
  const unrelatedClaim = await unrelatedJournal.claim(unrelatedContext);
  const unrelatedActor = createTestExecutorIdentityV02({ payloadDigest: unrelatedContext.actionDigest });
  const unrelatedBefore = await unrelatedJournal.loadTask(unrelatedContext.taskId);
  assert.ok(unrelatedBefore);
  unrelatedJournal.getUnderlying().internalSetTask({
    ...unrelatedBefore,
    goal: `${unrelatedBefore.goal} (concurrent owner update)`,
    stateVersion: unrelatedBefore.stateVersion + 1,
  });
  const taskAfterUnrelatedUpdate = await unrelatedJournal.loadTask(unrelatedContext.taskId);
  assert.ok(taskAfterUnrelatedUpdate);
  const journalBeforeStaleBegin = unrelatedJournal.getJournalSnapshot();
  const ledgersBeforeStaleBegin = unrelatedJournal.getLedgers();
  const staleBegin = await unrelatedJournal.beginAttempt(unrelatedClaim.claimId, unrelatedActor);
  assert.equal(isNeutralAttemptReceiptV02(staleBegin), true,
    'A task-state update after claim invalidates the old snapshot before beginAttempt');
  assert.equal(taskAfterUnrelatedUpdate.stateVersion, unrelatedContext.expectedTaskStateVersion + 1);
  assert.deepEqual(unrelatedJournal.getJournalSnapshot(), journalBeforeStaleBegin,
    'Stale beginAttempt leaves claim/control state unchanged');
  assert.deepEqual(unrelatedJournal.getLedgers(), ledgersBeforeStaleBegin,
    'Stale beginAttempt retains the exact outstanding reservation');
  assert.equal(unrelatedJournal.getJournalSnapshot().claims[0]?.status, 'claimed');
  assert.equal(unrelatedJournal.getJournalSnapshot().attempts.length, 0);

  const provider = createValidV02Setup({ requestId: 'req-version-progression-006' });
  const providerReceipts = captureJournalReceipts(provider.statePort);
  const providerBefore = await provider.statePort.loadTask(provider.context.taskId);
  assert.ok(providerBefore);
  assert.equal((await provider.port.propose(provider.state, provider.evidence, provider.request, provider.context)).outcome, 'observed');
  const providerClaim = providerReceipts.claims[0];
  const providerAttempt = providerReceipts.attempts[0];
  const providerOutcome = providerReceipts.outcomes[0];
  assert.ok(providerClaim);
  assert.ok(providerAttempt);
  assert.ok(providerOutcome);
  const providerObserved = asProviderOutcome(providerOutcome);
  assert.equal(providerClaim.preClaimTaskStateVersion, provider.context.expectedTaskStateVersion);
  assert.equal(providerClaim.preClaimControlVersion, provider.context.expectedControlVersion);
  assert.equal(providerClaim.postClaimControlVersion, provider.context.expectedControlVersion + 1);
  assert.deepEqual(providerClaim.reservationRefs, [provider.context.requestReservationReceipt, ...provider.context.budgetRefs]);
  assert.equal(providerAttempt.preAttemptTaskStateVersion, providerBefore.stateVersion);
  assert.equal(providerAttempt.postBeginTaskStateVersion, providerBefore.stateVersion);
  assert.equal(providerAttempt.preAttemptControlVersion, providerClaim.postClaimControlVersion);
  assert.equal(providerAttempt.postBeginControlVersion, providerClaim.postClaimControlVersion + 1);
  assert.equal(providerObserved.admissionDigest, computeAdmissionDigest(provider.context));
  assert.equal(providerObserved.providerRequestId, provider.request.providerRequestId);
  assert.equal(providerObserved.requestContentDigest, provider.context.requestContentDigest);
  assert.equal(providerObserved.providerAdmissionReceiptRef, provider.context.providerAdmissionReceipt.receiptId);
  assert.equal(providerObserved.providerAdmissionReceiptDigest, provider.context.providerAdmissionReceipt.receiptDigest);
  assert.equal(providerObserved.requestReservationReceiptRef, provider.context.requestReservationReceipt);
  assert.deepEqual(providerObserved.budgetRefs, provider.context.budgetRefs);
  assert.deepEqual(providerObserved.proposedEffects.accounting.reservationRefs, providerClaim.reservationRefs);
  assert.equal(providerObserved.observedUsage?.inputTokens, 150);
  assert.equal(providerObserved.observedUsage?.outputTokens, 75);
  assert.equal(providerObserved.observedUsage?.billableTokens, 225);
  assert.equal(providerObserved.observedUsage?.costUsd, 0.005);
  assert.equal(provider.statePort.getJournalSnapshot().controlVersion, provider.context.expectedControlVersion + 3);
  assert.equal((await provider.statePort.loadTask(provider.context.taskId))?.stateVersion, providerBefore.stateVersion);
});

// ---------------------------------------------------------------------------
// Section 10 Case 7: Fresh action/run ID while a claim is open
// ---------------------------------------------------------------------------

test('Section 10 Case 7: Fresh action/run ID is denied task-wide while any claim is open', async () => {
  const receiverEntered = createBarrier();
  const releaseReceiver = createBarrier();
  const integrated = await createIntegratedPatchHarness({
    beforePatch: async ({ apply }) => {
      receiverEntered.signal();
      await releaseReceiver.wait();
      return apply();
    },
  });
  const dispatch = integrated.guard.validateAndExecute(integrated.patch, integrated.initialTaskState, integrated.context);
  await receiverEntered.wait();
  const freshPublicClaim = await integrated.journal.claim(createTestRepositoryAdmissionContextV02({
    taskId: integrated.context.taskId,
    runId: 'run-public-competitor-007',
  }));
  assert.equal(isNeutralClaimReceiptV02(freshPublicClaim), true,
    'A fresh task/run claim cannot pass the receiver-owned active attempt');
  assert.equal(integrated.controller.executedPlans.length, 0);
  releaseReceiver.signal();
  assert.equal((await dispatch).outcome, 'success');
  assert.equal(integrated.controller.executedPlans.length, 0, 'Patch receiver dispatch remains separate from command plans');
  assert.equal(integrated.effectCount, 1);

  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });

  // 1. claimed status
  const freshClaim1 = await journal.claim(
    createTestRepositoryAdmissionContextV02({
      taskId: context.taskId,
      runId: 'run-fresh-competitor-001',
    })
  );
  assert.equal(isNeutralClaimReceiptV02(freshClaim1), true, 'Deny fresh claim while claimed');

  // 2. attempting status
  const attempt = await journal.beginAttempt(claim.claimId, actor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);
  const freshClaim2 = await journal.claim(
    createTestRepositoryAdmissionContextV02({
      taskId: context.taskId,
      runId: 'run-fresh-competitor-002',
    })
  );
  assert.equal(isNeutralClaimReceiptV02(freshClaim2), true, 'Deny fresh claim while attempting');

  // 3. uncertain status
  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
  const recorded = await journal.recordOutcome(outcomeReceipt);
  assert.equal(recorded.outcome, 'uncertain');
  const freshClaim3 = await journal.claim(
    createTestRepositoryAdmissionContextV02({
      taskId: context.taskId,
      runId: 'run-fresh-competitor-003',
    })
  );
  assert.equal(isNeutralClaimReceiptV02(freshClaim3), true, 'Deny fresh claim while uncertain');

  let unsettled!: Awaited<ReturnType<typeof createIntegratedPatchHarness>>;
  unsettled = await createIntegratedPatchHarness({
    beforePatch: async ({ apply }) => {
      const effect = apply();
      const current = await unsettled.journal.loadTask(unsettled.context.taskId);
      assert.ok(current);
      unsettled.journal.getUnderlying().internalSetTask({ ...current, node: 'Repair' });
      return effect;
    },
  });
  assert.equal((await unsettled.guard.validateAndExecute(
    unsettled.patch, unsettled.initialTaskState, unsettled.context,
  )).outcome, 'uncertain-effect');
  const unsettledSnapshot = unsettled.journal.getJournalSnapshot();
  assert.equal(unsettledSnapshot.claims[0]?.status, 'observed-unsettled');
  assert.ok(unsettledSnapshot.activeClaimId);
  const unsettledTask = await unsettled.journal.loadTask(unsettled.context.taskId);
  assert.ok(unsettledTask);
  const freshObservedClaim = await unsettled.journal.claim(createTestRepositoryAdmissionContextV02({
    taskId: unsettled.context.taskId,
    runId: 'run-observed-unsettled-competitor-007',
    expectedTaskStateVersion: unsettledTask.stateVersion,
    expectedControlVersion: unsettledSnapshot.controlVersion,
  }));
  assert.equal(isNeutralClaimReceiptV02(freshObservedClaim), true);
  assert.equal(unsettled.journal.getJournalSnapshot().activeClaimId, unsettledSnapshot.activeClaimId);
  assert.equal(unsettled.effectCount, 1);
});

// ---------------------------------------------------------------------------
// Section 10 Case 8: Stale/duplicate executor after reconciliation
// ---------------------------------------------------------------------------

test('Section 10 Case 8: Stale executor actor after fencing refuses execution', async () => {
  let harness!: Awaited<ReturnType<typeof createIntegratedCommandHarness>>;
  let stateAtAttempt: TaskState | undefined;
  harness = await createIntegratedCommandHarness({
    beforeExecute: async () => {
      stateAtAttempt = await harness.journal.loadTask(harness.context.taskId) ?? undefined;
      assert.ok(stateAtAttempt);
      harness.journal.getUnderlying().internalSetTask({ ...stateAtAttempt, node: 'Investigate' });
    },
  });
  const result = await harness.guard.validateAndExecute(harness.action, harness.initialTaskState, harness.context);
  assert.equal(result.outcome, 'uncertain-effect', 'The command was observed but its first settlement conflicted');
  assert.equal(harness.controller.executedPlans.length, 1);
  const attempt = harness.attempts[0];
  assert.ok(attempt);
  assert.equal(harness.journal.getJournalSnapshot().attempts[0]?.status, 'observed-unsettled');
  const openClaim = harness.claims[0];
  assert.ok(openClaim);
  const recoveryHold = 'pause-before-observed-unsettled-reconcile-case8';
  assert.equal(await harness.journal.setTaskControl(harness.context.taskId, 'paused', recoveryHold), true);
  assert.equal(await harness.journal.fenceAttemptRecipient(openClaim.claimId, attempt.executorIdentity), null,
    'The current mock fence API only accepts uncertain attempts, so this observed-unsettled owner cannot be fenced');
  assert.equal(harness.journal.getJournalSnapshot().holdRef, recoveryHold);
  assert.equal(harness.journal.getJournalSnapshot().activeClaimId, openClaim.claimId);

  harness.journal.getUnderlying().internalSetTask(stateAtAttempt!);
  const recovered = await harness.tools.recoverCommandOutcome(attempt.attemptId);
  assert.equal(recovered.outcome, 'settled', 'Recovery settles the exact observed predecessor before fencing the old actor');
  assert.equal(harness.journal.getJournalSnapshot().attempts[0]?.status, 'settled');

  harness.manager.setFencingGeneration(harness.context.workspaceId, 2);
  harness.executor.setFencingGeneration(2);
  await assert.rejects(
    () => harness.executor.execute({
      workspaceId: harness.context.workspaceId,
      action: harness.action,
      limits: createValidLimits(),
      view: harness.activeView,
      attempt,
    }),
    /STALE_FENCING_GENERATION/
  );
  assert.equal(harness.controller.executedPlans.length, 1, 'A reconciled, fenced attempt cannot dispatch a second time');
});

// ---------------------------------------------------------------------------
// Section 10 Case 9: Crash or lost response at every boundary
// ---------------------------------------------------------------------------

test('Section 10 Case 9: Crash or lost response rereads journal state; replaying outcome is idempotent with no blind retry', async () => {
  let harness!: Awaited<ReturnType<typeof createIntegratedPatchHarness>>;
  harness = await createIntegratedPatchHarness({
    uncertainEvidence: 'observed-patch',
    beforePatch: async ({ apply }) => {
      apply();
      throw new Error('simulated lost receiver response after patch dispatch');
    },
  });
  const guarded = await harness.guard.validateAndExecute(harness.patch, harness.initialTaskState, harness.context);
  assert.equal(guarded.outcome, 'uncertain-effect');
  assert.equal(harness.effectCount, 1, 'The mock receiver applied the patch once before losing its response');
  const attempt = harness.attempts[0];
  const uncertainOutcome = harness.outcomes.find((outcome) => outcome.outcome === 'uncertain');
  assert.ok(attempt);
  assert.ok(uncertainOutcome);

  // The caller rereads the retained journal and recovers from its exact uncertain predecessor.
  const pending = harness.journal.getJournalSnapshot();
  assert.equal(pending.attempts[0]?.attemptId, attempt.attemptId);
  assert.equal(pending.attempts[0]?.status, 'uncertain');
  assert.equal(pending.outcomes[0]?.receiptId, uncertainOutcome.receiptId);
  const recovered = await harness.tools.recoverPatchOutcome(attempt.attemptId);
  assert.equal(recovered.outcome, 'settled');
  const replay = await harness.journal.recordOutcome(uncertainOutcome);
  assert.deepEqual(replay, { outcome: 'already-recorded', receiptId: uncertainOutcome.receiptId });
  assert.equal(harness.effectCount, 1, 'Recovery and exact receipt replay do not blind-retry the patch');
  assert.equal(harness.journal.getJournalSnapshot().attempts[0]?.status, 'settled');

  const baseContext = createTestRepositoryAdmissionContextV02();
  const lostClaimContext = createTestRepositoryAdmissionContextV02({
    action: { ...baseContext.action as ApplyPatchAction, actionId: 'act-claim-response-lost-009' },
  });
  const lostClaimJournal = createJournal(lostClaimContext);
  const commitClaim = lostClaimJournal.claim.bind(lostClaimJournal);
  let loseClaimResponse = true;
  lostClaimJournal.claim = async (admission) => {
    const receipt = await commitClaim(admission);
    if (loseClaimResponse) {
      loseClaimResponse = false;
      throw new Error('claim reply lost after journal commit');
    }
    return receipt;
  };
  await assert.rejects(() => lostClaimJournal.claim(lostClaimContext), /claim reply lost/);
  assert.equal(lostClaimJournal.getJournalSnapshot().controlVersion, lostClaimContext.expectedControlVersion + 1);
  assert.equal(lostClaimJournal.getJournalSnapshot().claims.length, 1);
  const reservedOnce = lostClaimJournal.getLedgers();
  const replayedClaim = await lostClaimJournal.claim(lostClaimContext);
  assert.equal(replayedClaim.claimId, 'claim-act-claim-response-lost-009');
  assert.deepEqual(lostClaimJournal.getLedgers(), reservedOnce, 'Exact claim replay does not duplicate or resize its reservation');
  assert.equal(lostClaimJournal.getJournalSnapshot().claims.length, 1);

  const lostBegin = await createIntegratedPatchHarness({ uncertainEvidence: 'unavailable' });
  const originalBegin = lostBegin.journal.beginAttempt.bind(lostBegin.journal);
  let loseBeginResponse = true;
  lostBegin.journal.beginAttempt = async (claimId, identity) => {
    const receipt = await originalBegin(claimId, identity);
    if (loseBeginResponse) {
      loseBeginResponse = false;
      throw new Error('beginAttempt reply lost after journal commit');
    }
    return receipt;
  };
  assert.equal((await lostBegin.guard.validateAndExecute(
    lostBegin.patch, lostBegin.initialTaskState, lostBegin.context,
  )).outcome, 'uncertain-effect');
  assert.equal(lostBegin.receiverCallCount, 0, 'No patch launch follows an unconfirmed beginAttempt response');
  assert.equal(lostBegin.journal.getJournalSnapshot().attempts[0]?.status, 'attempting');
  assert.equal(lostBegin.journal.getJournalSnapshot().claims[0]?.status, 'attempting');
  assert.equal(lostBegin.journal.getJournalSnapshot().activeClaimId, lostBegin.claims[0]?.claimId);
  const newActor = createTestExecutorIdentityV02({
    payloadDigest: lostBegin.context.actionDigest,
    processIncarnation: 'matrix-after-begin-loss',
  });
  assert.equal(isNeutralAttemptReceiptV02(await lostBegin.journal.beginAttempt(lostBegin.claims[0]!.claimId, newActor)), true,
    'A restarted actor cannot mint a second attempt from the still-active claim');
  const restartedReceiver = await createIntegratedPatchHarness({
    context: lostBegin.context,
    statePort: lostBegin.journal,
  });
  assert.throws(
    () => restartedReceiver.tools.recoverAttemptStart(lostBegin.recoveryIds[0]!),
    /ATTEMPT_START_RECOVERY_NOT_FOUND/,
    'The retained StatePort does not restore the first receiver incarnation’s pending recovery identity',
  );

  const lostSettlement = await createIntegratedPatchHarness();
  const originalRecordOutcome = lostSettlement.journal.recordOutcome.bind(lostSettlement.journal);
  let loseSettlementResponse = true;
  lostSettlement.journal.recordOutcome = async (receipt) => {
    const result = await originalRecordOutcome(receipt);
    if (loseSettlementResponse && result.outcome === 'settled') {
      loseSettlementResponse = false;
      throw new Error('settlement reply lost after journal commit');
    }
    return result;
  };
  assert.equal((await lostSettlement.guard.validateAndExecute(
    lostSettlement.patch, lostSettlement.initialTaskState, lostSettlement.context,
  )).outcome, 'uncertain-effect');
  assert.equal(lostSettlement.effectCount, 1);
  assert.equal(lostSettlement.journal.getJournalSnapshot().attempts[0]?.status, 'settled');
  assert.equal(lostSettlement.journal.getJournalSnapshot().activeClaimId, null);
  assert.equal(lostSettlement.manager.hasActiveWriterLease(lostSettlement.context.workspaceId), true,
    'The receiver retains its lease while the committed settlement response is unresolved');
  const settlementAttempt = lostSettlement.attempts[0];
  assert.ok(settlementAttempt);
  await assert.rejects(
    () => lostSettlement.tools.recoverPatchOutcome(settlementAttempt.attemptId),
    /STALE_CURRENT_SNAPSHOT/,
    'Observed recovery cannot replay its local pending record after the journal already committed settlement',
  );
  assert.equal(lostSettlement.effectCount, 1);
  assert.equal(lostSettlement.manager.hasActiveWriterLease(lostSettlement.context.workspaceId), true);
});

// ---------------------------------------------------------------------------
// Section 10 Case 10: Settlement/checkpoint failure after patch
// ---------------------------------------------------------------------------

test('Section 10 Case 10: Settlement failure after patch records observed-unsettled and reconciles once without second patch', async () => {
  let harness!: Awaited<ReturnType<typeof createIntegratedPatchHarness>>;
  let stateAtAttempt: TaskState | undefined;
  harness = await createIntegratedPatchHarness({
    beforePatch: async ({ apply }) => {
      const effect = apply();
      stateAtAttempt = await harness.journal.loadTask(harness.context.taskId) ?? undefined;
      assert.ok(stateAtAttempt);
      harness.journal.getUnderlying().internalSetTask({ ...stateAtAttempt, node: 'Repair' });
      return effect;
    },
  });
  const first = await harness.guard.validateAndExecute(harness.patch, harness.initialTaskState, harness.context);
  assert.equal(first.outcome, 'uncertain-effect', 'Settlement conflict leaves the observed patch held for reconciliation');
  assert.equal(harness.effectCount, 1);
  assert.equal(harness.journal.getJournalSnapshot().attempts[0]?.status, 'observed-unsettled');
  const attempt = harness.attempts[0];
  const claim = harness.claims[0];
  const observedOutcome = harness.outcomes.find((outcome) => outcome.outcome === 'observed');
  assert.ok(attempt);
  assert.ok(claim);
  assert.ok(observedOutcome);
  assert.ok(stateAtAttempt);
  const repositoryObservedOutcome = asRepositoryOutcome(observedOutcome);
  assert.equal(harness.journal.getJournalSnapshot().claims[0]?.status, 'observed-unsettled');
  assert.equal(harness.journal.getJournalSnapshot().activeClaimId, claim.claimId);
  assert.equal(repositoryObservedOutcome.claimId, claim.claimId);
  assert.equal(repositoryObservedOutcome.claimDigest, claim.claimDigest);
  assert.equal(repositoryObservedOutcome.attemptId, attempt.attemptId);
  assert.equal(repositoryObservedOutcome.actionDigest, harness.context.actionDigest);
  assert.equal(repositoryObservedOutcome.admissionDigest, computeAdmissionDigest(harness.context));
  assert.equal(repositoryObservedOutcome.versions.preClaimTaskStateVersion, harness.context.expectedTaskStateVersion);
  assert.equal(repositoryObservedOutcome.versions.postAttemptTaskStateVersion, attempt.postBeginTaskStateVersion);
  assert.equal(repositoryObservedOutcome.versions.postAttemptControlVersion, attempt.postBeginControlVersion);
  assert.equal(repositoryObservedOutcome.observedResultRevisionDigest, harness.currentRevision);
  assert.deepEqual(repositoryObservedOutcome.proposedEffects.accounting.reservationRefs, claim.reservationRefs);
  assert.deepEqual(repositoryObservedOutcome.proposedEffects.invalidatedEvidence, [],
    'The current patch receiver records an exact empty invalidation set; named invalidations are not produced by this path');
  const unsettledTask = await harness.journal.loadTask(harness.context.taskId);
  assert.ok(unsettledTask);
  const unsettledSnapshot = harness.journal.getJournalSnapshot();
  const unsettledLedgers = harness.journal.getLedgers();
  const competingAdmission = createTestRepositoryAdmissionContextV02({
    taskId: unsettledTask.taskId,
    runId: unsettledTask.runId,
    workspaceId: unsettledTask.workspaceId,
    repositoryId: unsettledTask.repositoryId,
    canonicalRevision: unsettledTask.repositoryRevisionDigest,
    expectedTaskStateVersion: unsettledTask.stateVersion,
    expectedControlVersion: unsettledSnapshot.controlVersion,
    expectedEpoch: unsettledSnapshot.epoch,
    runnableNode: unsettledTask.node,
    action: {
      ...harness.context.action,
      actionId: 'act-observed-unsettled-competitor-010',
    },
  });
  assert.equal(isNeutralClaimReceiptV02(await harness.journal.claim(competingAdmission)), true,
    'A fresh public claim remains blocked while an observed-unsettled owner claim is open');
  assert.deepEqual(harness.journal.getJournalSnapshot(), unsettledSnapshot);
  assert.deepEqual(harness.journal.getLedgers(), unsettledLedgers);
  assert.equal(harness.receiverCallCount, 1);
  assert.equal(harness.effectCount, 1);
  const pauseRef = 'pause-observed-unsettled-case10';
  assert.equal(await harness.journal.setTaskControl(harness.context.taskId, 'paused', pauseRef), true);
  assert.equal(harness.journal.getJournalSnapshot().holdRef, pauseRef);
  assert.equal(harness.journal.getJournalSnapshot().activeClaimId, claim.claimId);

  // Restore authoritative pre-settlement task fields while retaining the observed repository revision.
  harness.journal.getUnderlying().internalSetTask({ ...stateAtAttempt, repositoryRevisionDigest: harness.currentRevision });
  const settled = await harness.tools.recoverPatchOutcome(attempt.attemptId);
  assert.equal(settled.outcome, 'settled');
  const finalTask = await harness.journal.loadTask(harness.context.taskId);
  assert.ok(finalTask);
  assert.equal(finalTask.node, 'Verify', 'The receiver reconciliation transitions to Verify once');
  assert.equal(finalTask.repositoryRevisionDigest, harness.currentRevision);
  assert.equal(harness.journal.getJournalSnapshot().attempts[0]?.status, 'settled');
  assert.equal(harness.journal.getJournalSnapshot().claims[0]?.status, 'settled');
  assert.equal(harness.journal.getJournalSnapshot().mode, 'paused');
  assert.equal(harness.journal.getJournalSnapshot().holdRef, pauseRef);
  assert.equal(harness.journal.getJournalSnapshot().activeClaimId, null);
  assert.equal(harness.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);
  assert.equal(harness.effectCount, 1, 'Recovery does not execute a second patch');
  const exactObservedReconciliation = harness.recoveryReceipts[0];
  assert.ok(exactObservedReconciliation);
  assert.equal(exactObservedReconciliation.reconciliationKind, 'observed-unsettled');
  assert.equal(exactObservedReconciliation.predecessorReceiptId, observedOutcome.receiptId);
  assert.deepEqual(await harness.journal.reconcileObservedOutcome(exactObservedReconciliation), {
    outcome: 'settled', receiptId: exactObservedReconciliation.reconciliationId,
  }, 'Exact observed reconciliation replay is idempotent');
  assert.equal(harness.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);

  let lostRecoveryHarness!: Awaited<ReturnType<typeof createIntegratedPatchHarness>>;
  let lostRecoveryStateAtAttempt: TaskState | undefined;
  lostRecoveryHarness = await createIntegratedPatchHarness({
    beforePatch: async ({ apply }) => {
      const effect = apply();
      lostRecoveryStateAtAttempt = await lostRecoveryHarness.journal.loadTask(lostRecoveryHarness.context.taskId) ?? undefined;
      assert.ok(lostRecoveryStateAtAttempt);
      lostRecoveryHarness.journal.getUnderlying().internalSetTask({ ...lostRecoveryStateAtAttempt, node: 'Repair' });
      return effect;
    },
  });
  assert.equal((await lostRecoveryHarness.guard.validateAndExecute(
    lostRecoveryHarness.patch, lostRecoveryHarness.initialTaskState, lostRecoveryHarness.context,
  )).outcome, 'uncertain-effect');
  const lostRecoveryAttempt = lostRecoveryHarness.attempts[0];
  assert.ok(lostRecoveryAttempt);
  assert.equal(lostRecoveryHarness.journal.getJournalSnapshot().attempts[0]?.status, 'observed-unsettled');
  assert.equal(await lostRecoveryHarness.journal.setTaskControl(
    lostRecoveryHarness.context.taskId, 'paused', 'pause-lost-observed-recovery-010',
  ), true);
  lostRecoveryHarness.journal.getUnderlying().internalSetTask({
    ...lostRecoveryStateAtAttempt!,
    repositoryRevisionDigest: lostRecoveryHarness.currentRevision,
  });
  const originalObservedReconcile = lostRecoveryHarness.journal.reconcileObservedOutcome.bind(lostRecoveryHarness.journal);
  let loseRecoveryResponse = true;
  lostRecoveryHarness.journal.reconcileObservedOutcome = async (receipt) => {
    const result = await originalObservedReconcile(receipt);
    if (loseRecoveryResponse && result.outcome === 'settled') {
      loseRecoveryResponse = false;
      throw new Error('observed recovery response lost after journal commit');
    }
    return result;
  };
  await assert.rejects(
    () => lostRecoveryHarness.tools.recoverPatchOutcome(lostRecoveryAttempt.attemptId),
    /observed recovery response lost after journal commit/,
  );
  const committedRecoverySnapshot = lostRecoveryHarness.journal.getJournalSnapshot();
  const committedRecoveryLedgers = lostRecoveryHarness.journal.getLedgers();
  assert.equal(committedRecoverySnapshot.attempts[0]?.status, 'settled');
  assert.equal(committedRecoverySnapshot.claims[0]?.status, 'settled');
  assert.equal(committedRecoverySnapshot.activeClaimId, null);
  assert.equal((await lostRecoveryHarness.journal.loadTask(lostRecoveryHarness.context.taskId))?.node, 'Verify');
  assert.equal(lostRecoveryHarness.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);
  assert.equal(lostRecoveryHarness.effectCount, 1);
  assert.equal(lostRecoveryHarness.manager.hasActiveWriterLease(lostRecoveryHarness.context.workspaceId), true,
    'The local receiver keeps its workspace lease after the recovery commit reply is lost');
  await assert.rejects(
    () => lostRecoveryHarness.tools.recoverPatchOutcome(lostRecoveryAttempt.attemptId),
    /STALE_CURRENT_SNAPSHOT/,
    'A recovery retry prepares current versions and cannot replay its lost committed receipt',
  );
  assert.deepEqual(lostRecoveryHarness.journal.getJournalSnapshot(), committedRecoverySnapshot);
  assert.deepEqual(lostRecoveryHarness.journal.getLedgers(), committedRecoveryLedgers);
  assert.equal(lostRecoveryHarness.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);
  assert.equal(lostRecoveryHarness.manager.hasActiveWriterLease(lostRecoveryHarness.context.workspaceId), true,
    'The unrecoverable lost recovery reply retains the workspace writer lease');
  assert.equal(lostRecoveryHarness.effectCount, 1);
});

// ---------------------------------------------------------------------------
// Section 10 Case 11: Uncertain versus observed-outcome recovery
// ---------------------------------------------------------------------------

test('Section 10 Case 11: Uncertain versus observed-outcome recovery accepts only exact predecessors with idempotent replay', async () => {
  const withoutEvidence = await createIntegratedPatchHarness({
    uncertainEvidence: 'unavailable',
    beforePatch: async () => { throw new Error('receiver response lost before a proven patch effect'); },
  });
  const unresolved = await withoutEvidence.guard.validateAndExecute(
    withoutEvidence.patch,
    withoutEvidence.initialTaskState,
    withoutEvidence.context,
  );
  assert.equal(unresolved.outcome, 'uncertain-effect');
  assert.equal(withoutEvidence.effectCount, 0);
  const uncertainAttempt = withoutEvidence.attempts[0];
  assert.ok(uncertainAttempt);
  assert.equal(withoutEvidence.journal.getJournalSnapshot().attempts[0]?.status, 'uncertain');
  await assert.rejects(
    () => withoutEvidence.tools.recoverPatchOutcome(uncertainAttempt.attemptId),
    /NO_TRUSTED_RECOVERY_EVIDENCE/
  );
  assert.equal(withoutEvidence.journal.getJournalSnapshot().attempts[0]?.status, 'uncertain',
    'An unproven outcome remains held and cannot be converted into an observed receipt');

  const observed = await createIntegratedPatchHarness({
    uncertainEvidence: 'observed-patch',
    beforePatch: async ({ apply }) => {
      apply();
      throw new Error('receiver response lost after the mock patch effect');
    },
  });
  const observedResult = await observed.guard.validateAndExecute(observed.patch, observed.initialTaskState, observed.context);
  assert.equal(observedResult.outcome, 'uncertain-effect');
  const observedAttempt = observed.attempts[0];
  assert.ok(observedAttempt);
  assert.equal(observed.effectCount, 1);
  const restartedObservedReceiver = await createIntegratedPatchHarness({
    context: observed.context,
    statePort: observed.journal,
  });
  await assert.rejects(
    () => restartedObservedReceiver.tools.recoverPatchOutcome(observedAttempt.attemptId),
    /PATCH_RECOVERY_NOT_FOUND/,
    'A new receiver has no durable recovery cursor for the observed predecessor retained in StatePort',
  );
  assert.equal((await observed.tools.recoverPatchOutcome(observedAttempt.attemptId)).outcome, 'settled');
  assert.equal(observed.journal.getJournalSnapshot().attempts[0]?.status, 'settled');
  assert.equal(observed.effectCount, 1, 'Only the exact observed predecessor authorizes recovery, never a retry');
  await assert.rejects(() => observed.tools.recoverPatchOutcome(observedAttempt.attemptId), /PATCH_RECOVERY_NOT_FOUND/,
    'The completed local recovery cannot be applied a second time');
  assert.equal(observed.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);

  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await journal.beginAttempt(claim.claimId, actor);

  // Record uncertain outcome U
  const outcomeU = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
  const recU = await journal.recordOutcome(outcomeU);
  assert.equal(recU.outcome, 'uncertain');

  // Calling reconcileObservedOutcome on uncertain predecessor U is rejected
  const fakeObservedRec = createTestObservedReconciliationReceiptV02(
    { ...outcomeU, outcome: 'observed' } as unknown as AttemptOutcomeReceiptV02,
    claim,
    attempt,
    context
  );
  const rejectedObserved = await journal.reconcileObservedOutcome(fakeObservedRec);
  assert.equal(rejectedObserved.outcome, 'conflict');

  // Calling reconcileUncertain on exact uncertain predecessor U succeeds
  const invalidatedEvidence: { reference: string; digest: string }[] = [];
  const accountingEvidenceRefs = [{ reference: 'ev-acc-11', digest: computeCanonicalSha256('ev-acc-11') }];
  const observedRevisionDigest = context.canonicalRevision;
  const effectEvidenceRef = {
    reference: 'ev-eff-11',
    digest: computeCanonicalSha256({
      schemaVersion: 'uc03-observed-patch-recovery/0.2-draft',
      predecessorReceiptId: outcomeU.receiptId,
      observedRevisionDigest,
      invalidatedEvidence,
      accountingEvidenceRefs,
    }),
  };
  await journal.publishRecoveryEvidence({
    predecessorReceiptId: outcomeU.receiptId,
    effectEvidenceRef,
    accountingEvidenceRefs,
    observedRevisionDigest,
    invalidatedEvidence,
  });
  await journal.setTaskControl(context.taskId, 'paused', 'pause-recovery-11');
  assert.ok(await journal.fenceAttemptRecipient(claim.claimId, actor));

  const reconU = createTestUncertainReconciliationReceiptV02(outcomeU, claim, attempt, context, {
    disposition: 'observed-and-accounted',
    effectEvidenceRef,
    accountingEvidenceRefs,
    evidenceRefs: [effectEvidenceRef, ...accountingEvidenceRefs],
    expectedCurrentTaskStateVersion: attempt.postBeginTaskStateVersion,
    expectedCurrentControlVersion: journal.getJournalSnapshot().controlVersion,
  });
  const settledU = await journal.reconcileUncertain(reconU);
  assert.equal(settledU.outcome, 'settled');

  // Replay of reconcileUncertain is idempotent
  const replayU = await journal.reconcileUncertain(reconU);
  assert.deepEqual(replayU, settledU);
});

// ---------------------------------------------------------------------------
// Section 10 Case 12: Failed/partial repair accounting
// ---------------------------------------------------------------------------

test('Section 10 Case 12: Failed or partial repair attempt charges repair allowance once without refund', async () => {
  const harness = await createIntegratedPatchHarness({
    uncertainEvidence: 'observed-patch',
    beforePatch: async ({ apply }) => {
      apply();
      throw new Error('simulated partial patch response failure');
    },
  });
  const result = await harness.guard.validateAndExecute(harness.patch, harness.initialTaskState, harness.context);
  assert.equal(result.outcome, 'uncertain-effect');
  const attempt = harness.attempts[0];
  assert.ok(attempt);
  const repairDuringHold = harness.journal.getLedgers().find((ledger) => ledger.kind === 'repair');
  assert.equal(repairDuringHold?.consumed, 1, 'beginAttempt charges the repair allowance before dispatch');
  assert.equal(repairDuringHold?.reservations.length, 0);
  assert.equal(harness.effectCount, 1);

  assert.equal((await harness.tools.recoverPatchOutcome(attempt.attemptId)).outcome, 'settled');
  const repairAfter = harness.journal.getLedgers().find((ledger) => ledger.kind === 'repair');
  assert.equal(repairAfter?.consumed, 1, 'Failed or partial repair is charged exactly once without refund');
  assert.deepEqual(repairAfter?.reservations, []);
  assert.equal(harness.effectCount, 1);

  const failedRevisionCheck = await createIntegratedPatchHarness({
    uncertainEvidence: 'observed-patch',
    beforePatch: async ({ apply }) => {
      apply();
      return { applied: true, newRevisionDigest: computeCanonicalSha256('receiver-returned-wrong-revision') };
    },
  });
  const failedVerificationResult = await failedRevisionCheck.guard.validateAndExecute(
    failedRevisionCheck.patch, failedRevisionCheck.initialTaskState, failedRevisionCheck.context,
  );
  assert.equal(failedVerificationResult.outcome, 'uncertain-effect',
    'A patch whose reported revision fails receiver verification remains uncertain and held');
  assert.equal(failedRevisionCheck.effectCount, 1);
  assert.equal(failedRevisionCheck.journal.getJournalSnapshot().attempts[0]?.status, 'uncertain');
  const repairAtFailure = failedRevisionCheck.journal.getLedgers().find((ledger) => ledger.kind === 'repair');
  assert.equal(repairAtFailure?.consumed, 1);
  assert.deepEqual(repairAtFailure?.reservations, []);
  const failedAttempt = failedRevisionCheck.attempts[0];
  assert.ok(failedAttempt);
  assert.equal((await failedRevisionCheck.tools.recoverPatchOutcome(failedAttempt.attemptId)).outcome, 'settled');
  const repairAfterVerificationFailure = failedRevisionCheck.journal.getLedgers().find((ledger) => ledger.kind === 'repair');
  assert.equal(repairAfterVerificationFailure?.consumed, 1,
    'Failed result verification cannot refund the repair attempt already charged at beginAttempt');
  assert.equal(failedRevisionCheck.effectCount, 1);
});

// ---------------------------------------------------------------------------
// Section 10 Case 13: Pre-plan baseline/test-only regression path
// ---------------------------------------------------------------------------

test('Section 10 Case 13: Pre-plan baseline runTests succeeds without plan decision; production patch without plan binding denies', async () => {
  const fixtureTask = createFixtureBugTask();
  const additionalBaselineCheck = {
    ...fixtureTask.requiredChecks[0]!,
    checkId: 'check-baseline-regression-013',
    purpose: 'regression' as const,
    workingDirectory: '/workspace/repo/tests',
  };
  const task = {
    ...fixtureTask,
    requiredChecks: [
      ...fixtureTask.requiredChecks.map((check) => check.purpose === 'reproduction'
        ? { ...check, workingDirectory: '/workspace/repo/tests' }
        : check),
      additionalBaselineCheck,
    ],
  };
  const reproCheck = task.requiredChecks.find((c) => c.purpose === 'reproduction')!;
  const action = {
    actionId: reproCheck.checkId,
    kind: 'run_command' as const,
    executable: reproCheck.executable,
    argv: [...reproCheck.argv],
    workingDirectory: reproCheck.workingDirectory ?? 'tests',
    purpose: reproCheck.purpose,
  };

  const baselineAdmission = createTestRepositoryCommandAdmissionContextV02({
    taskId: task.taskId,
    workspaceId: 'workspace-uc03-test',
    repositoryId: task.repositoryId,
    canonicalRevision: task.initialRevisionDigest,
    action,
    reservationRefs: ['res-command-001'],
    runnableNode: 'Investigate',
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: reproCheck.purpose,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: reproCheck.checkId,
    testPath: 'tests/test_calculator.py',
    planBindingDigest: undefined,
    planDecisionRef: undefined,
  });

  const commandHarness = await createIntegratedCommandHarness({
    context: baselineAdmission,
    timeoutLimit: 120_000,
    executionOutput: {
      exitCode: 1,
      stdout: '',
      stderr: 'ZeroDivisionError: division by zero',
      durationMs: 40,
      timedOut: false,
    },
  });
  commandHarness.controller.executionOutputs.push(
    { exitCode: 1, stdout: '', stderr: 'ZeroDivisionError: division by zero', durationMs: 40, timedOut: false },
    { exitCode: 0, stdout: '1 passed', stderr: '', durationMs: 25, timedOut: false },
  );

  const hostPort = createBoundHostPort(task);
  const trustedContext = createTrustedAdmissionContext(task, {
    statePort: commandHarness.journal,
    executionGuard: commandHarness.guard,
    admissionContextForCheck: ({ check, action: checkAction, currentState }) => {
      const admission = createTestRepositoryCommandAdmissionContextV02({
        taskId: currentState.taskId,
        runId: currentState.runId,
        workspaceId: currentState.workspaceId,
        repositoryId: currentState.repositoryId,
        canonicalRevision: currentState.repositoryRevisionDigest,
        expectedTaskStateVersion: currentState.stateVersion,
        expectedControlVersion: commandHarness.journal.getJournalSnapshot().controlVersion,
        expectedEpoch: commandHarness.journal.getJournalSnapshot().epoch,
        action: checkAction,
        reservationRefs: [`res-baseline-${check.checkId}`],
        runnableNode: 'Investigate',
        planApplicability: 'pre-plan-diagnostic',
        diagnosticPurpose: check.purpose,
        taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
        checkSetDigest: computeCheckSetDigest(task.requiredChecks),
        checkId: check.checkId,
        testPath: check.argv.find((argument) => argument.endsWith('.py')) ?? 'tests/test_calculator.py',
        planBindingDigest: undefined,
        planDecisionRef: undefined,
      });
      const withActiveView = {
        ...admission,
        commandView: commandHarness.context.commandView,
        admissionDigest: '',
      };
      const bound = {
        ...withActiveView,
        admissionDigest: computeAdmissionDigest(withActiveView),
      } as RepositoryAdmissionContextV02;
      baselineCheckAdmissions.push(bound);
      return bound;
    },
  });

  // Guarded baseline runTests succeeds without approved plan
  const baselineCheckAdmissions: RepositoryAdmissionContextV02[] = [];
  const baselineResult = await investigateBaseline(task, commandHarness.tools, hostPort, trustedContext);
  assert.equal(baselineResult.status, 'reproduced');
  const snapshot = commandHarness.journal.getJournalSnapshot();
  assert.equal(snapshot.claims.length, task.requiredChecks.length);
  assert.equal(snapshot.outcomes.length, task.requiredChecks.length);
  assert.equal(snapshot.attempts.length, task.requiredChecks.length);
  assert.ok(snapshot.outcomes.every((outcome) => outcome.outcome === 'observed'));
  assert.ok(snapshot.claims.every((claim) => claim.status === 'settled'));
  assert.equal(commandHarness.controller.executedPlans.length, task.requiredChecks.length,
    'Each baseline check uses its own current public command admission and receiver call');
  assert.equal(baselineCheckAdmissions.length, task.requiredChecks.length);
  assert.equal(new Set(baselineCheckAdmissions.map((admission) => admission.actionDigest)).size, task.requiredChecks.length);
  assert.deepEqual(commandHarness.claims.map((claim) => claim.reservationRefs),
    baselineCheckAdmissions.map((admission) => admission.reservationRefs));
  assert.ok(commandHarness.outcomes.every((outcome, index) => outcome.admissionDigest === computeAdmissionDigest(baselineCheckAdmissions[index]!)));
  const baselineTaskAfter = await commandHarness.journal.loadTask(task.taskId);
  assert.ok(baselineTaskAfter);
  assert.equal(baselineTaskAfter.stateVersion, commandHarness.initialTaskState.stateVersion,
    'Pre-plan command checks advance control without changing task-state version');
  for (const [index, admission] of baselineCheckAdmissions.entries()) {
    const claim = commandHarness.claims[index];
    const attempt = commandHarness.attempts[index];
    const outcome = commandHarness.outcomes[index];
    assert.ok(claim);
    assert.ok(attempt);
    assert.ok(outcome);
    const repositoryReceipt = asRepositoryOutcome(outcome);
    assert.equal(claim.subjectKind, 'repository-action');
    assert.equal(claim.preClaimTaskStateVersion, admission.expectedTaskStateVersion);
    assert.equal(claim.preClaimControlVersion, admission.expectedControlVersion);
    assert.equal(claim.postClaimControlVersion, admission.expectedControlVersion + 1);
    assert.deepEqual(claim.reservationRefs, admission.reservationRefs);
    assert.equal(attempt.claimId, claim.claimId);
    assert.equal(attempt.preAttemptTaskStateVersion, admission.expectedTaskStateVersion);
    assert.equal(attempt.postBeginTaskStateVersion, admission.expectedTaskStateVersion);
    assert.equal(attempt.preAttemptControlVersion, claim.postClaimControlVersion);
    assert.equal(attempt.postBeginControlVersion, admission.expectedControlVersion + 2);
    assert.equal(outcome.attemptId, attempt.attemptId);
    assert.equal(admission.action.actionId, admission.checkId);
    assert.equal(repositoryReceipt.checkSetDigest, admission.checkSetDigest);
    assert.equal(repositoryReceipt.actionDigest, admission.actionDigest);
    assert.deepEqual(repositoryReceipt.proposedEffects.accounting.reservationRefs, admission.reservationRefs);
    assert.equal(repositoryReceipt.versions.postAttemptTaskStateVersion, admission.expectedTaskStateVersion);
    assert.equal(repositoryReceipt.versions.postAttemptControlVersion, admission.expectedControlVersion + 2);
    assert.equal(snapshot.claims[index]?.status, 'settled');
  }
  assert.equal(snapshot.controlVersion, baselineAdmission.expectedControlVersion + 3 * task.requiredChecks.length);
  assert.equal(commandHarness.action.purpose, reproCheck.purpose);
  assert.equal(baselineAdmission.planApplicability, 'pre-plan-diagnostic');
  const baselineOutcome = commandHarness.outcomes[0];
  assert.ok(baselineOutcome);
  const firstBaselineOutcome = asRepositoryOutcome(baselineOutcome);
  assert.equal(firstBaselineOutcome.planApplicability, 'pre-plan-diagnostic');
  assert.equal(firstBaselineOutcome.actionDigest, baselineCheckAdmissions[0]?.actionDigest);
  assert.deepEqual(await commandHarness.journal.recordOutcome(baselineOutcome), {
    outcome: 'already-recorded', receiptId: baselineOutcome.receiptId,
  });

  // The controlled test-only patch branch is exercised through the public guard and receiver.
  const diagnosticPatchBase = createTestDiagnosticPatchAdmissionContextV02();
  const currentBeforeTestPatch = await commandHarness.journal.loadTask(task.taskId);
  assert.ok(currentBeforeTestPatch);
  const patchControlBefore = commandHarness.journal.getJournalSnapshot().controlVersion;
  const patchAction = {
    ...diagnosticPatchBase.action as ApplyPatchAction,
    baseRevisionDigest: currentBeforeTestPatch.repositoryRevisionDigest,
  };
  const patchActionDigest = computeActionDigest(patchAction);
  const patchFreshnessDigest = computeCanonicalSha256({
    taskId: currentBeforeTestPatch.taskId,
    runId: currentBeforeTestPatch.runId,
    actionDigest: patchActionDigest,
    canonicalRevision: currentBeforeTestPatch.repositoryRevisionDigest,
    policyAuthorityRef: baselineAdmission.policyAuthorityRef,
  });
  const patchPolicyReceiptBase = {
    ...diagnosticPatchBase.policyEvaluationReceipt,
    actionDigest: patchActionDigest,
    freshnessContextDigest: patchFreshnessDigest,
    receiptDigest: undefined,
  };
  const { receiptDigest: _priorPatchReceiptDigest, ...patchPolicyReceiptUnsigned } = patchPolicyReceiptBase;
  const patchAdmissionBase = {
    ...diagnosticPatchBase,
    taskId: currentBeforeTestPatch.taskId,
    runId: currentBeforeTestPatch.runId,
    workspaceId: currentBeforeTestPatch.workspaceId,
    repositoryId: currentBeforeTestPatch.repositoryId,
    canonicalRevision: currentBeforeTestPatch.repositoryRevisionDigest,
    expectedTaskStateVersion: currentBeforeTestPatch.stateVersion,
    expectedControlVersion: patchControlBefore,
    expectedEpoch: commandHarness.journal.getJournalSnapshot().epoch,
    action: patchAction,
    actionDigest: patchActionDigest,
    policyAuthorityRef: baselineAdmission.policyAuthorityRef,
    policyEvaluationReceipt: {
      ...patchPolicyReceiptUnsigned,
      receiptDigest: computeCanonicalSha256(patchPolicyReceiptUnsigned),
    },
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baseRevision: currentBeforeTestPatch.repositoryRevisionDigest,
    targetPaths: [...patchAction.targetPaths],
    patchDigest: computeCanonicalSha256(patchAction.patchContent),
    reservationRefs: ['res-diagnostic-test-retained-013'],
    admissionDigest: '',
  };
  const diagnosticPatch = {
    ...patchAdmissionBase,
    admissionDigest: computeAdmissionDigest(patchAdmissionBase),
  } as RepositoryAdmissionContextV02;
  const diagnosticPatchHarness = await createIntegratedPatchHarness({
    context: diagnosticPatch,
    statePort: commandHarness.journal,
  });
  const diagnosticPatchResult = await diagnosticPatchHarness.guard.validateAndExecute(
    diagnosticPatchHarness.patch,
    diagnosticPatchHarness.initialTaskState,
    diagnosticPatchHarness.context,
  );
  assert.equal(diagnosticPatchResult.outcome, 'success');
  assert.equal(diagnosticPatchHarness.receiverCallCount, 1);
  assert.equal(diagnosticPatchHarness.effectCount, 1);
  assert.equal(diagnosticPatchHarness.journal.getJournalSnapshot().attempts.length, task.requiredChecks.length + 1);
  assert.equal(diagnosticPatchHarness.journal.getJournalSnapshot().attempts.at(-1)?.status, 'settled');
  assert.equal(diagnosticPatchHarness.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 0,
    'A diagnostic regression-test patch does not consume production repair allowance');
  const diagnosticPatchOutcome = diagnosticPatchHarness.outcomes[0];
  assert.ok(diagnosticPatchOutcome);
  const repositoryTestPatchOutcome = asRepositoryOutcome(diagnosticPatchOutcome);
  assert.equal(repositoryTestPatchOutcome.planApplicability, 'pre-plan-diagnostic');
  assert.equal(repositoryTestPatchOutcome.actionDigest, diagnosticPatch.actionDigest);
  assert.equal(repositoryTestPatchOutcome.admissionDigest, computeAdmissionDigest(diagnosticPatch));
  assert.equal(repositoryTestPatchOutcome.versions.preClaimTaskStateVersion, currentBeforeTestPatch.stateVersion);
  assert.equal(repositoryTestPatchOutcome.versions.postAttemptTaskStateVersion, diagnosticPatchHarness.attempts[0]?.postBeginTaskStateVersion);
  assert.deepEqual(repositoryTestPatchOutcome.proposedEffects.accounting.reservationRefs, diagnosticPatch.reservationRefs);
  assert.equal(repositoryTestPatchOutcome.observedResultRevisionDigest, diagnosticPatchHarness.currentRevision);
  assert.deepEqual(await diagnosticPatchHarness.journal.recordOutcome(diagnosticPatchOutcome), {
    outcome: 'already-recorded', receiptId: diagnosticPatchOutcome.receiptId,
  });

  const afterTestPatch = await diagnosticPatchHarness.journal.loadTask(task.taskId);
  assert.ok(afterTestPatch);
  assert.equal(afterTestPatch.node, 'Investigate');
  assert.equal(afterTestPatch.stateVersion, currentBeforeTestPatch.stateVersion + 1);
  assert.equal(afterTestPatch.repositoryRevisionDigest, diagnosticPatchHarness.currentRevision);
  assert.equal(diagnosticPatchHarness.journal.getJournalSnapshot().controlVersion, patchControlBefore + 3);

  const newlyRequiredCheck = {
    ...additionalBaselineCheck,
    checkId: 'check-new-revision-013',
    argv: ['-q', 'tests/test_calculator.py'],
  };
  const nextRequiredChecks = [...task.requiredChecks, newlyRequiredCheck];
  const nextCheckSetDigest = computeCheckSetDigest(nextRequiredChecks);
  const baselineCheckSetDigest = computeCheckSetDigest(task.requiredChecks);
  assert.notEqual(nextCheckSetDigest, baselineCheckSetDigest,
    'The post-patch verification action is bound to the newly accepted check set');
  const nextCheckAction = {
    actionId: newlyRequiredCheck.checkId,
    kind: 'run_command' as const,
    executable: newlyRequiredCheck.executable,
    argv: [...newlyRequiredCheck.argv],
    workingDirectory: newlyRequiredCheck.workingDirectory ?? 'tests',
    purpose: newlyRequiredCheck.purpose,
  };
  const checkTaskNow = await diagnosticPatchHarness.journal.loadTask(task.taskId);
  assert.ok(checkTaskNow);
  const nextCheckContext = createTestRepositoryCommandAdmissionContextV02({
    taskId: checkTaskNow.taskId,
    runId: checkTaskNow.runId,
    workspaceId: checkTaskNow.workspaceId,
    repositoryId: checkTaskNow.repositoryId,
    canonicalRevision: checkTaskNow.repositoryRevisionDigest,
    expectedTaskStateVersion: checkTaskNow.stateVersion,
    expectedControlVersion: diagnosticPatchHarness.journal.getJournalSnapshot().controlVersion,
    expectedEpoch: diagnosticPatchHarness.journal.getJournalSnapshot().epoch,
    action: nextCheckAction,
    reservationRefs: [`res-${newlyRequiredCheck.checkId}`],
    runnableNode: 'Investigate',
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: newlyRequiredCheck.purpose,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: nextCheckSetDigest,
    checkId: newlyRequiredCheck.checkId,
    testPath: newlyRequiredCheck.argv.find((argument) => argument.endsWith('.py')) ?? 'tests/test_calculator.py',
    planBindingDigest: undefined,
    planDecisionRef: undefined,
  });
  const nextCheckHarness = await createIntegratedCommandHarness({
    context: nextCheckContext,
    statePort: diagnosticPatchHarness.journal,
    executionOutput: { exitCode: 0, stdout: '1 passed', stderr: '', durationMs: 15, timedOut: false },
  });
  const nextAdmissionValidation = validateAdmissionV02(
    nextCheckHarness.context,
    createTestRepositoryAdmissionTrustedContextV02(nextCheckHarness.context),
  );
  assert.equal(nextAdmissionValidation.ok, true, JSON.stringify(nextAdmissionValidation));
  const nextCheckResult = await nextCheckHarness.guard.validateAndExecute(
    nextCheckHarness.action, nextCheckHarness.initialTaskState, nextCheckHarness.context,
  );
  assert.equal(nextCheckResult.outcome, 'success');
  assert.equal(nextCheckHarness.controller.executedPlans.length, 1);
  const nextCheckClaim = nextCheckHarness.claims[0];
  const nextCheckAttempt = nextCheckHarness.attempts[0];
  const nextCheckOutcome = nextCheckHarness.outcomes[0];
  assert.ok(nextCheckClaim);
  assert.ok(nextCheckAttempt);
  assert.ok(nextCheckOutcome);
  const nextCheckRepositoryOutcome = asRepositoryOutcome(nextCheckOutcome);
  assert.equal(nextCheckClaim.preClaimTaskStateVersion, afterTestPatch.stateVersion);
  assert.equal(nextCheckClaim.preClaimControlVersion, patchControlBefore + 3);
  assert.equal(nextCheckClaim.postClaimControlVersion, patchControlBefore + 4);
  assert.deepEqual(nextCheckClaim.reservationRefs, nextCheckContext.reservationRefs);
  assert.equal(nextCheckAttempt.postBeginTaskStateVersion, afterTestPatch.stateVersion);
  assert.equal(nextCheckAttempt.preAttemptControlVersion, nextCheckClaim.postClaimControlVersion);
  assert.equal(nextCheckAttempt.postBeginControlVersion, patchControlBefore + 5);
  assert.equal(nextCheckRepositoryOutcome.admissionDigest, computeAdmissionDigest(nextCheckHarness.context));
  assert.equal(nextCheckRepositoryOutcome.actionDigest, nextCheckHarness.context.actionDigest);
  assert.equal(nextCheckOutcome.attemptId, nextCheckAttempt.attemptId);
  assert.equal(nextCheckHarness.context.action.actionId, newlyRequiredCheck.checkId);
  assert.equal(nextCheckRepositoryOutcome.checkSetDigest, nextCheckSetDigest);
  assert.equal(nextCheckRepositoryOutcome.proposedEffects.accounting.disposition, 'settle');
  assert.deepEqual(nextCheckRepositoryOutcome.proposedEffects.accounting.reservationRefs, nextCheckClaim.reservationRefs);
  assert.equal(nextCheckRepositoryOutcome.versions.postAttemptTaskStateVersion, afterTestPatch.stateVersion);
  assert.equal(nextCheckRepositoryOutcome.versions.postAttemptControlVersion, patchControlBefore + 5);
  assert.equal(nextCheckHarness.journal.getJournalSnapshot().attempts.at(-1)?.status, 'settled');
  assert.equal(nextCheckHarness.journal.getJournalSnapshot().controlVersion, patchControlBefore + 6);
  assert.equal((await nextCheckHarness.journal.loadTask(task.taskId))?.stateVersion, afterTestPatch.stateVersion,
    'The next pre-plan verification command preserves the task-state version');
  assert.equal((await nextCheckHarness.journal.loadTask(task.taskId))?.repositoryRevisionDigest, afterTestPatch.repositoryRevisionDigest);

  // Production patch without approved plan binding denies with zero dispatch
  const invalidProdPatch = createTestRepositoryAdmissionContextV02({
    planApplicability: 'approved-plan',
    planBindingDigest: undefined as unknown as string,
    planDecisionRef: undefined as unknown as string,
  });
  const invalidProdHarness = await createIntegratedPatchHarness({ context: invalidProdPatch });
  const invalidProdResult = await invalidProdHarness.guard.validateAndExecute(
    invalidProdHarness.patch,
    invalidProdHarness.initialTaskState,
    invalidProdHarness.context,
  );
  assert.notEqual(invalidProdResult.outcome, 'success', 'Production patch without approved plan decision is denied by the guard');
  assert.equal(invalidProdHarness.receiverCallCount, 0);
  assert.equal(invalidProdHarness.effectCount, 0);
  assert.equal(invalidProdHarness.controller.executedPlans.length, 0);
});

// ---------------------------------------------------------------------------
// Section 10 Case 14: Provider request/claim race
// ---------------------------------------------------------------------------

test('Section 10 Case 14: Exact provider request ID reuses single claim; fresh competitor denied without transport', async () => {
  const entered = createBarrier();
  const release = createBarrier();
  const transport = new StubTransport();
  transport.beforeExecute = async () => {
    entered.signal();
    await release.wait();
  };
  const setup = createValidV02Setup({ requestId: 'req-race-014', transport });
  const captured = captureJournalReceipts(setup.statePort);
  const firstPromise = setup.port.propose(setup.state, setup.evidence, setup.request, setup.context);
  await entered.wait();
  const ownerClaim = captured.claims[0];
  const ownerAttempt = captured.attempts[0];
  assert.ok(ownerClaim);
  assert.ok(ownerAttempt);
  const stateAtTransport = setup.statePort.getJournalSnapshot();
  const ledgersAtTransport = setup.statePort.getLedgers();
  assert.equal(stateAtTransport.claims[0]?.status, 'attempting',
    'Provider dispatch has a durable attempting claim while the transport is live');
  assert.equal(ownerClaim.preClaimControlVersion, setup.context.expectedControlVersion);
  assert.equal(ownerClaim.postClaimControlVersion, setup.context.expectedControlVersion + 1);
  assert.equal(ownerAttempt.preAttemptControlVersion, ownerClaim.postClaimControlVersion);
  assert.equal(ownerAttempt.postBeginControlVersion, ownerClaim.postClaimControlVersion + 1);
  assert.deepEqual(ownerClaim.reservationRefs, [setup.context.requestReservationReceipt, ...setup.context.budgetRefs]);
  for (const [index, reservationRef] of setup.context.budgetRefs.entries()) {
    const reservations = ledgersAtTransport.flatMap((ledger) => ledger.reservations)
      .filter((reservation) => reservation.reservationId === reservationRef);
    assert.equal(reservations.length, 1, `One pre-network reservation is held for budget ref ${reservationRef}`);
    const expectedAmount = index === 0 || index === 2
      ? setup.context.finiteBounds.maxBillableTokens
      : index === 1 || index === 3
        ? setup.context.finiteBounds.maxCostUsd
        : 1;
    assert.equal(reservations[0]?.amount, expectedAmount);
  }

  // The same request ID joins the in-flight public provider operation.
  const duplicatePromise = setup.port.propose(setup.state, setup.evidence, setup.request, setup.context);
  assert.equal(transport.callCount, 1);

  // A competing request goes through a second public provider port on the same retained journal.
  const competing = createValidV02Setup({ requestId: 'req-competitor-014', statePort: setup.statePort });
  const competingResultPromise = competing.port.propose(
    competing.state,
    competing.evidence,
    competing.request,
    competing.context,
  );
  const competingResult = await competingResultPromise;
  assert.equal(competingResult.outcome, 'denied');
  assert.equal(competing.transport.callCount, 0, 'A fresh competing provider request is refused before transport');
  assert.equal(transport.callCount, 1);
  assert.deepEqual(setup.statePort.getLedgers(), ledgersAtTransport,
    'A fresh competitor leaves the first request’s complete reservation ledger unchanged');
  assert.deepEqual(setup.statePort.getJournalSnapshot(), stateAtTransport,
    'The denied competitor does not advance task/control state or replace the owner claim');

  release.signal();
  const [firstResult, duplicateResult] = await Promise.all([firstPromise, duplicatePromise]);
  assert.equal(firstResult.outcome, 'observed');
  assert.deepEqual(duplicateResult, firstResult);
  assert.equal(transport.callCount, 1, 'One exact request races to one transport call and one owner claim');
  assert.equal(setup.statePort.getJournalSnapshot().claims.length, 1);
  const providerOutcome = captured.outcomes[0];
  assert.ok(providerOutcome);
  const providerReceipt = asProviderOutcome(providerOutcome);
  assert.equal(providerReceipt.providerRequestId, setup.request.providerRequestId);
  assert.equal(providerReceipt.requestContentDigest, setup.context.requestContentDigest);
  assert.equal(providerReceipt.providerAdmissionReceiptRef, setup.context.providerAdmissionReceipt.receiptId);
  assert.equal(providerReceipt.providerAdmissionReceiptDigest, setup.context.providerAdmissionReceipt.receiptDigest);
  assert.equal(providerReceipt.role, setup.context.role);
  assert.deepEqual(providerReceipt.budgetRefs, setup.context.budgetRefs);
  assert.equal(setup.statePort.getJournalSnapshot().controlVersion, setup.context.expectedControlVersion + 3);
});

// ---------------------------------------------------------------------------
// Section 10 Case 15: Coder and reviewer provider branches
// ---------------------------------------------------------------------------

test('Section 10 Case 15: Coder and reviewer provider branches each use branch receipt and single reservation', async () => {
  // Coder branch
  const coderEntered = createBarrier();
  const coderRelease = createBarrier();
  const coderSetup = createValidV02Setup({ role: 'coder', requestId: 'req-branch-coder-15' });
  coderSetup.transport.beforeExecute = async () => { coderEntered.signal(); await coderRelease.wait(); };
  const coderReceipts = captureJournalReceipts(coderSetup.statePort);
  const coderPromise = coderSetup.port.propose(coderSetup.state, coderSetup.evidence, coderSetup.request, coderSetup.context);
  await coderEntered.wait();
  const coderClaim = coderReceipts.claims[0];
  const coderAttempt = coderReceipts.attempts[0];
  assert.ok(coderClaim);
  assert.ok(coderAttempt);
  assert.equal(coderClaim.subjectKind, 'provider-request');
  assert.deepEqual(coderClaim.reservationRefs, [coderSetup.context.requestReservationReceipt, ...coderSetup.context.budgetRefs]);
  assert.equal(coderSetup.statePort.getJournalSnapshot().claims[0]?.status, 'attempting');
  for (const reservationRef of coderSetup.context.budgetRefs) {
    assert.equal(coderSetup.statePort.getLedgers().flatMap((ledger) => ledger.reservations)
      .filter((reservation) => reservation.reservationId === reservationRef).length, 1);
  }
  coderRelease.signal();
  const coderResult = await coderPromise;
  assert.equal(coderSetup.transport.callCount, 1);
  assert.equal(coderResult.outcome, 'observed');
  assert.equal(coderSetup.statePort.getJournalSnapshot().outcomes[0]?.outcome, 'observed');
  const coderOutcome = coderReceipts.outcomes[0];
  assert.ok(coderOutcome);
  const coderProviderOutcome = asProviderOutcome(coderOutcome);
  assert.equal(coderProviderOutcome.role, 'coder');
  assert.equal(coderProviderOutcome.providerRequestId, coderSetup.request.providerRequestId);
  assert.equal(coderProviderOutcome.requestContentDigest, coderSetup.context.requestContentDigest);
  assert.equal(coderProviderOutcome.providerAdmissionReceiptRef, coderSetup.context.providerAdmissionReceipt.receiptId);
  assert.equal(coderProviderOutcome.providerAdmissionReceiptDigest, coderSetup.context.providerAdmissionReceipt.receiptDigest);
  assert.deepEqual(coderProviderOutcome.proposedEffects.accounting.reservationRefs, coderClaim.reservationRefs);
  const coderLedgers = coderSetup.statePort.getLedgers().filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost');
  assert.equal(coderLedgers.length, coderSetup.context.budgetRefs.length);
  assert.ok(coderLedgers.every((ledger) => ledger.reservations.length === 0), 'Coder reservations settle exactly once');

  // Reviewer branch
  const reviewerEntered = createBarrier();
  const reviewerRelease = createBarrier();
  const reviewerSetup = createValidV02Setup({ role: 'reviewer', requestId: 'req-branch-rev-15' });
  reviewerSetup.transport.beforeExecute = async () => { reviewerEntered.signal(); await reviewerRelease.wait(); };
  const reviewerReceipts = captureJournalReceipts(reviewerSetup.statePort);
  const reviewerPromise = reviewerSetup.port.propose(reviewerSetup.state, reviewerSetup.evidence, reviewerSetup.request, reviewerSetup.context);
  await reviewerEntered.wait();
  const reviewerClaim = reviewerReceipts.claims[0];
  const reviewerAttempt = reviewerReceipts.attempts[0];
  assert.ok(reviewerClaim);
  assert.ok(reviewerAttempt);
  assert.equal(reviewerClaim.subjectKind, 'provider-request');
  assert.deepEqual(reviewerClaim.reservationRefs, [reviewerSetup.context.requestReservationReceipt, ...reviewerSetup.context.budgetRefs]);
  assert.equal(reviewerSetup.statePort.getJournalSnapshot().claims[0]?.status, 'attempting');
  for (const reservationRef of reviewerSetup.context.budgetRefs.filter((reference) => !reference.includes('iteration'))) {
    assert.equal(reviewerSetup.statePort.getLedgers().flatMap((ledger) => ledger.reservations)
      .filter((reservation) => reservation.reservationId === reservationRef).length, 1);
  }
  reviewerRelease.signal();
  const reviewerResult = await reviewerPromise;
  assert.equal(reviewerSetup.transport.callCount, 1);
  assert.equal(reviewerResult.outcome, 'observed');
  assert.equal(reviewerSetup.statePort.getJournalSnapshot().outcomes[0]?.outcome, 'observed');
  const reviewerOutcome = reviewerReceipts.outcomes[0];
  assert.ok(reviewerOutcome);
  const reviewerProviderOutcome = asProviderOutcome(reviewerOutcome);
  assert.equal(reviewerProviderOutcome.role, 'reviewer');
  assert.equal(reviewerProviderOutcome.providerRequestId, reviewerSetup.request.providerRequestId);
  assert.equal(reviewerProviderOutcome.requestContentDigest, reviewerSetup.context.requestContentDigest);
  assert.equal(reviewerProviderOutcome.providerAdmissionReceiptRef, reviewerSetup.context.providerAdmissionReceipt.receiptId);
  assert.equal(reviewerProviderOutcome.providerAdmissionReceiptDigest, reviewerSetup.context.providerAdmissionReceipt.receiptDigest);
  assert.deepEqual(reviewerProviderOutcome.proposedEffects.accounting.reservationRefs, reviewerClaim.reservationRefs);
  const reviewerLedgers = reviewerSetup.statePort.getLedgers();
  assert.equal(reviewerLedgers.filter((ledger) => ledger.kind === 'tokens' || ledger.kind === 'cost').length,
    reviewerSetup.context.budgetRefs.filter((reference) => !reference.includes('iteration')).length);
  assert.ok(reviewerLedgers.every((ledger) => ledger.reservations.length === 0), 'Reviewer reservations settle exactly once');
});

// ---------------------------------------------------------------------------
// Section 10 Case 16: Pre-plan outcome/idempotent settlement
// ---------------------------------------------------------------------------

test('Section 10 Case 16: Pre-plan outcomes settle with exact branch fields and replay is idempotent', async () => {
  // Pre-plan diagnostic command outcome
  const diagnosticPurpose = 'Verify reproduction check failure before plan';
  const testPath = 'tests/test_calculator.py';
  const action = createTestAction({
    actionId: 'act-command-admission-001',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q', testPath],
    workingDirectory: 'workspace/repo',
    purpose: diagnosticPurpose,
  });

  const cmdContext = createTestRepositoryCommandAdmissionContextV02({
    planApplicability: 'pre-plan-diagnostic',
    runnableNode: 'Investigate',
    diagnosticPurpose,
    taskCriteriaDigest: computeCanonicalSha256(['Calculator.divide raises CalculationError on zero denominator']),
    checkSetDigest: computeCanonicalSha256(['check-pytest-repro']),
    checkId: 'check-pytest-repro',
    testPath,
    action,
    actionDigest: computeCanonicalSha256(action),
    planBindingDigest: undefined,
    planDecisionRef: undefined,
  });
  const cmdInitial = createTestAdmissionTaskStateV02(cmdContext);
  const cmdTask = {
    ...cmdInitial,
    budgetLedgers: [
      ...(cmdInitial.budgetLedgers ?? []),
      {
        scope: 'task' as const,
        kind: 'timeoutMs' as const,
        limit: 60000,
        consumed: 0,
        reservations: [],
        unit: 'count' as const,
        configurationId: 'config-v1',
        version: 1,
      },
    ],
  };
  const cmdJournal = new MemoryStatePortV02({
    initialTaskState: cmdTask,
    initialControlVersion: cmdContext.expectedControlVersion,
    initialEpoch: cmdContext.expectedEpoch,
    initialAuthorityRef: cmdContext.policyAuthorityRef,
  });
  const cmdClaim = await cmdJournal.claim(cmdContext);
  const cmdActor = createTestExecutorIdentityV02({ payloadDigest: cmdContext.actionDigest });
  const cmdAttempt = await cmdJournal.beginAttempt(cmdClaim.claimId, cmdActor);

  const cmdOutcome = createTestRepositoryOutcomeReceiptV02(cmdClaim, cmdAttempt, cmdContext);
  const cmdRec = await cmdJournal.recordOutcome(cmdOutcome);
  assert.equal(cmdRec.outcome, 'settled');

  // Exact receipt replay is idempotent
  const cmdReplay = await cmdJournal.recordOutcome(cmdOutcome);
  assert.deepEqual(cmdReplay, { outcome: 'already-recorded', receiptId: cmdOutcome.receiptId });

  // Test-only regression patch is also a tagged repository-action receipt with exact replay.
  const testPatchContext = createTestDiagnosticPatchAdmissionContextV02();
  const testPatchHarness = await createIntegratedPatchHarness({ context: testPatchContext });
  assert.equal((await testPatchHarness.guard.validateAndExecute(
    testPatchHarness.patch,
    testPatchHarness.initialTaskState,
    testPatchHarness.context,
  )).outcome, 'success');
  const testPatchOutcome = testPatchHarness.outcomes[0];
  assert.ok(testPatchOutcome);
  const repositoryTestPatchReceipt = asRepositoryOutcome(testPatchOutcome);
  assert.equal(repositoryTestPatchReceipt.planApplicability, 'pre-plan-diagnostic');
  assert.equal(repositoryTestPatchReceipt.actionDigest, testPatchContext.actionDigest);
  assert.deepEqual(await testPatchHarness.journal.recordOutcome(testPatchOutcome), {
    outcome: 'already-recorded', receiptId: testPatchOutcome.receiptId,
  });
  assert.equal(testPatchHarness.effectCount, 1, 'Receipt replay does not replay the test-only patch effect');

  // Pre-plan diagnostic provider outcome
  const prePlanSetup = createValidV02Setup({ planApplicability: 'pre-plan-diagnostic', requestId: 'req-preplan-016' });
  const prePlanReceipts = captureJournalReceipts(prePlanSetup.statePort);
  const provResult = await prePlanSetup.port.propose(prePlanSetup.state, prePlanSetup.evidence, prePlanSetup.request, prePlanSetup.context);
  assert.equal(prePlanSetup.transport.callCount, 1);
  assert.equal(provResult.outcome, 'observed');
  assert.equal(prePlanSetup.statePort.getJournalSnapshot().outcomes[0]?.outcome, 'observed');
  const prePlanProviderClaim = prePlanReceipts.claims[0];
  const prePlanProviderOutcome = prePlanReceipts.outcomes[0];
  assert.ok(prePlanProviderClaim);
  assert.ok(prePlanProviderOutcome);
  const prePlanProviderReceipt = asProviderOutcome(prePlanProviderOutcome);
  assert.equal(prePlanProviderReceipt.planApplicability, 'pre-plan-diagnostic');
  assert.equal(prePlanProviderReceipt.providerRequestId, prePlanSetup.request.providerRequestId);
  assert.equal(prePlanProviderReceipt.requestContentDigest, prePlanSetup.context.requestContentDigest);
  assert.equal(prePlanProviderReceipt.role, prePlanSetup.context.role);
  assert.equal(prePlanProviderReceipt.providerAdmissionReceiptRef, prePlanSetup.context.providerAdmissionReceipt.receiptId);
  assert.equal(prePlanProviderReceipt.providerAdmissionReceiptDigest, prePlanSetup.context.providerAdmissionReceipt.receiptDigest);
  assert.equal(prePlanProviderReceipt.requestReservationReceiptRef, prePlanSetup.context.requestReservationReceipt);
  assert.deepEqual(prePlanProviderReceipt.budgetRefs, prePlanSetup.context.budgetRefs);
  assert.deepEqual(prePlanProviderReceipt.proposedEffects.accounting.reservationRefs, prePlanProviderClaim.reservationRefs);
  const providerLedgersBeforeReplay = prePlanSetup.statePort.getLedgers();
  assert.deepEqual(await prePlanSetup.statePort.recordOutcome(prePlanProviderReceipt), {
    outcome: 'already-recorded', receiptId: prePlanProviderReceipt.receiptId,
  });
  assert.deepEqual(prePlanSetup.statePort.getLedgers(), providerLedgersBeforeReplay,
    'Exact provider receipt replay does not charge observed usage twice');
});

// ---------------------------------------------------------------------------
// Section 10 Case 17: Cross-branch outcome/reconciliation fields
// ---------------------------------------------------------------------------

test('Section 10 Case 17: Cross-branch and fabricated fields are rejected fail-closed without mutating state', async () => {
  const integrated = await createIntegratedPatchHarness();
  const applied = await integrated.guard.validateAndExecute(integrated.patch, integrated.initialTaskState, integrated.context);
  assert.equal(applied.outcome, 'success');
  const actualOutcome = integrated.outcomes[0];
  assert.ok(actualOutcome);
  const stateBeforeCrossBranch = integrated.journal.getJournalSnapshot();
  const foreignRepositoryOutcome = {
    ...actualOutcome,
    providerRequestId: 'req-foreign-17',
  } as unknown as AttemptOutcomeReceiptV02;
  const rejectedCrossBranch = await integrated.journal.recordOutcome(foreignRepositoryOutcome);
  assert.equal(isNeutralOutcomeRecordResultV02(rejectedCrossBranch), true);
  assert.deepEqual(integrated.journal.getJournalSnapshot(), stateBeforeCrossBranch,
    'The retained journal owner refuses a cross-branch outcome without mutation');
  assert.equal(integrated.effectCount, 1);

  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await journal.beginAttempt(claim.claimId, actor);
  const validReceipt = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);

  // 1. Repository receipt with foreign provider field
  const foreignRepoReceipt = {
    ...validReceipt,
    providerRequestId: 'req-foreign-17',
  };
  const val1 = validateAttemptOutcomeReceiptV02(
    foreignRepoReceipt as unknown as AttemptOutcomeReceiptV02,
    createTestAttemptOutcomeValidationContextV02(claim, attempt, context)
  );
  assert.equal(val1.ok, false, 'Reject repository receipt carrying provider field');

  // 2. Pre-plan receipt with fabricated plan fields
  const fabPreplanReceipt = {
    ...validReceipt,
    planApplicability: 'pre-plan-diagnostic' as const,
    planDecisionRef: 'dec-fabricated-17',
  };
  const val2 = validateAttemptOutcomeReceiptV02(
    fabPreplanReceipt as unknown as AttemptOutcomeReceiptV02,
    createTestAttemptOutcomeValidationContextV02(claim, attempt, context)
  );
  assert.equal(val2.ok, false, 'Reject pre-plan receipt with fabricated plan ref');

  const provider = createValidV02Setup({ planApplicability: 'pre-plan-diagnostic', requestId: 'req-malformed-provider-17' });
  const providerReceipts = captureJournalReceipts(provider.statePort);
  assert.equal((await provider.port.propose(provider.state, provider.evidence, provider.request, provider.context)).outcome, 'observed');
  const providerClaim = providerReceipts.claims[0];
  const providerAttempt = providerReceipts.attempts[0];
  const providerOutcome = providerReceipts.outcomes[0];
  assert.ok(providerClaim);
  assert.ok(providerAttempt);
  assert.ok(providerOutcome);
  const providerReceipt = asProviderOutcome(providerOutcome);
  const providerValidationContext = createTestAttemptOutcomeValidationContextV02(
    providerClaim, providerAttempt, provider.context,
  );
  const providerStateBeforeInvalidVectors = provider.statePort.getJournalSnapshot();
  const providerLedgersBeforeInvalidVectors = provider.statePort.getLedgers();
  const malformedProvider = (remove: readonly string[], add: Readonly<Record<string, unknown>> = {}) => {
    const raw = structuredClone(providerReceipt) as unknown as Record<string, unknown>;
    for (const field of remove) delete raw[field];
    Object.assign(raw, add);
    raw['receiptDigest'] = computeAttemptOutcomeDigest({ ...raw, receiptDigest: undefined });
    return raw as unknown as AttemptOutcomeReceiptV02;
  };
  for (const field of [
    'providerRequestId', 'requestContentDigest', 'role', 'providerAdmissionReceiptRef',
    'providerAdmissionReceiptDigest', 'requestReservationReceiptRef', 'budgetRefs',
  ]) {
    const invalid = malformedProvider([field]);
    assert.equal(validateAttemptOutcomeReceiptV02(invalid, providerValidationContext).ok, false,
      `Missing provider branch field ${field} is rejected`);
  }
  const providerWithRepositoryFields = malformedProvider([], {
    actionDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    repositoryOperation: 'apply-patch',
  });
  assert.equal(validateAttemptOutcomeReceiptV02(providerWithRepositoryFields, providerValidationContext).ok, false,
    'Provider outcomes reject repository action fields instead of filling them from admission');
  const providerWithPlanFields = malformedProvider([], { planDecisionRef: 'dec-fabricated-provider-17' });
  assert.equal(validateAttemptOutcomeReceiptV02(providerWithPlanFields, providerValidationContext).ok, false,
    'Pre-plan provider outcome rejects fabricated plan authority');
  assert.equal(isNeutralOutcomeRecordResultV02(await provider.statePort.recordOutcome(
    malformedProvider(['providerAdmissionReceiptDigest']),
  )), true);
  assert.deepEqual(provider.statePort.getJournalSnapshot(), providerStateBeforeInvalidVectors);
  assert.deepEqual(provider.statePort.getLedgers(), providerLedgersBeforeInvalidVectors,
    'Malformed provider replays leave settled task/control and accounting unchanged');
});

// ---------------------------------------------------------------------------
// Section 10 Case 18: Observed patch plus task-state conflict
// ---------------------------------------------------------------------------

test('Section 10 Case 18: Observed patch plus task-state conflict reconciles from stored receipt with monotone versions', async () => {
  let integrated!: Awaited<ReturnType<typeof createIntegratedPatchHarness>>;
  let taskAtAttempt: TaskState | undefined;
  integrated = await createIntegratedPatchHarness({
    beforePatch: async ({ apply }) => {
      const effect = apply();
      taskAtAttempt = await integrated.journal.loadTask(integrated.context.taskId) ?? undefined;
      assert.ok(taskAtAttempt);
      assert.equal(await integrated.journal.setTaskControl(integrated.context.taskId, 'paused', 'pause-case18'), true);
      integrated.journal.getUnderlying().internalSetTask({ ...taskAtAttempt, node: 'Repair' });
      return effect;
    },
  });
  const guardResult = await integrated.guard.validateAndExecute(
    integrated.patch,
    integrated.initialTaskState,
    integrated.context,
  );
  assert.equal(guardResult.outcome, 'uncertain-effect');
  assert.equal(integrated.journal.getJournalSnapshot().attempts[0]?.status, 'observed-unsettled');
  assert.equal(integrated.journal.getJournalSnapshot().mode, 'paused');
  assert.ok(taskAtAttempt);
  const conflictedTask = await integrated.journal.loadTask(integrated.context.taskId);
  assert.ok(conflictedTask);
  const conflictTaskVersion = conflictedTask.stateVersion;
  const conflictControlVersion = integrated.journal.getJournalSnapshot().controlVersion;
  integrated.journal.getUnderlying().internalSetTask({ ...taskAtAttempt, repositoryRevisionDigest: integrated.currentRevision });
  const recovered = await integrated.tools.recoverPatchOutcome(integrated.attempts[0]!.attemptId);
  assert.equal(recovered.outcome, 'settled');
  const recoveredTask = await integrated.journal.loadTask(integrated.context.taskId);
  assert.ok(recoveredTask);
  assert.equal(recoveredTask.node, 'Verify');
  assert.equal(recoveredTask.repositoryRevisionDigest, integrated.currentRevision);
  assert.ok(recoveredTask.stateVersion > conflictTaskVersion, 'Reconciliation advances the task version monotonically');
  assert.ok(integrated.journal.getJournalSnapshot().controlVersion > conflictControlVersion,
    'Reconciliation advances the control version monotonically');
  assert.equal(integrated.journal.getJournalSnapshot().mode, 'paused', 'The pause hold survives observed-outcome reconciliation');
  assert.equal(integrated.journal.getJournalSnapshot().activeClaimId, null);
  assert.equal(integrated.effectCount, 1);

  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await journal.beginAttempt(claim.claimId, actor);

  const afterAttempt = await journal.loadTask(context.taskId);
  assert.ok(afterAttempt);

  // Inject compatible state drift to produce recorded-unsettled
  journal.getUnderlying().internalSetTask({ ...afterAttempt, node: 'Repair' });
  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
  const recorded = await journal.recordOutcome(outcomeReceipt);
  assert.equal(recorded.outcome, 'recorded-unsettled');

  // Reconcile from stored receipt
  assert.ok(outcomeReceipt.observedResultRevisionDigest);
  journal.getUnderlying().internalSetTask({
    ...afterAttempt,
    repositoryRevisionDigest: outcomeReceipt.observedResultRevisionDigest,
  });
  const current = await journal.loadTask(context.taskId);
  assert.ok(current);

  const reconciliation = createTestObservedReconciliationReceiptV02(outcomeReceipt, claim, attempt, context, {
    expectedCurrentTaskStateVersion: current.stateVersion,
    expectedCurrentControlVersion: journal.getJournalSnapshot().controlVersion,
  });

  const result = await journal.reconcileObservedOutcome(reconciliation);
  assert.equal(result.outcome, 'settled');

  const finalTask = await journal.loadTask(context.taskId);
  assert.ok(finalTask);
  assert.equal(finalTask.node, 'Verify');
  assert.equal(finalTask.repositoryRevisionDigest, outcomeReceipt.observedResultRevisionDigest);

  let incompatible!: Awaited<ReturnType<typeof createIntegratedPatchHarness>>;
  incompatible = await createIntegratedPatchHarness({
    beforePatch: async ({ apply }) => {
      const effect = apply();
      const current = await incompatible.journal.loadTask(incompatible.context.taskId);
      assert.ok(current);
      incompatible.journal.getUnderlying().internalSetTask({ ...current, repositoryId: 'repo-incompatible-recovery-018' });
      return effect;
    },
  });
  assert.equal((await incompatible.guard.validateAndExecute(
    incompatible.patch, incompatible.initialTaskState, incompatible.context,
  )).outcome, 'uncertain-effect');
  const incompatibleAttempt = incompatible.attempts[0];
  const incompatibleOutcome = incompatible.outcomes.find((outcome) => outcome.outcome === 'observed');
  assert.ok(incompatibleAttempt);
  assert.ok(incompatibleOutcome);
  const incompatiblePause = 'pause-incompatible-observed-recovery-018';
  assert.equal(await incompatible.journal.setTaskControl(incompatible.context.taskId, 'paused', incompatiblePause), true);
  const incompatibleBeforeRecovery = incompatible.journal.getJournalSnapshot();
  const incompatibleLedgers = incompatible.journal.getLedgers();
  assert.equal((await incompatible.tools.recoverPatchOutcome(incompatibleAttempt.attemptId)).outcome, 'conflict');
  assert.deepEqual(incompatible.journal.getJournalSnapshot(), incompatibleBeforeRecovery,
    'An incompatible repository identity leaves the exact observed predecessor, open claim and hold unchanged');
  assert.deepEqual(incompatible.journal.getLedgers(), incompatibleLedgers);
  assert.equal(incompatible.manager.hasActiveWriterLease(incompatible.context.workspaceId), true,
    'Incompatible recovery retains the workspace writer lease while the old actor cannot be proven fenced');
  assert.equal(incompatible.effectCount, 1);
  assert.equal(incompatible.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);
  assert.equal(incompatibleOutcome.proposedEffects.invalidatedEvidence.length, 0,
    'The integrated patch receiver supplies no named evidence invalidation refs for this conflict path');
});

// ---------------------------------------------------------------------------
// Section 10 Case 19: Provider budget regression
// ---------------------------------------------------------------------------

test('Section 10 Case 19: Repository actions create zero provider token/cost entries; budget exhaustion denies transport', async () => {
  const repositoryHarness = await createIntegratedPatchHarness();
  const repositoryResult = await repositoryHarness.guard.validateAndExecute(
    repositoryHarness.patch,
    repositoryHarness.initialTaskState,
    repositoryHarness.context,
  );
  assert.equal(repositoryResult.outcome, 'success');

  // Assert the public repository receiver created ZERO token or cost entries / consumption.
  const ledgers = repositoryHarness.journal.getLedgers();
  const providerLedgers = ledgers.filter((l) => l.kind === 'tokens' || l.kind === 'cost');
  for (const ledger of providerLedgers) {
    assert.equal(ledger.reservations.length, 0, 'Zero provider reservations created by repository action');
    assert.equal(ledger.consumed, 0, 'Zero provider consumed amount in repository action');
  }

  const observedProvider = createValidV02Setup({ requestId: 'req-observed-usage-019' });
  const observedProviderReceipts = captureJournalReceipts(observedProvider.statePort);
  assert.equal((await observedProvider.port.propose(
    observedProvider.state, observedProvider.evidence, observedProvider.request, observedProvider.context,
  )).outcome, 'observed');
  const observedProviderClaim = observedProviderReceipts.claims[0];
  const observedProviderOutcome = observedProviderReceipts.outcomes[0];
  assert.ok(observedProviderClaim);
  assert.ok(observedProviderOutcome);
  const observedProviderReceipt = asProviderOutcome(observedProviderOutcome);
  assert.equal(observedProviderReceipt.observedUsage?.inputTokens, 150);
  assert.equal(observedProviderReceipt.observedUsage?.outputTokens, 75);
  assert.equal(observedProviderReceipt.observedUsage?.billableTokens, 225);
  assert.equal(observedProviderReceipt.observedUsage?.costUsd, 0.005);
  assert.deepEqual(observedProviderReceipt.proposedEffects.accounting.reservationRefs, observedProviderClaim.reservationRefs);
  for (const ledger of observedProvider.statePort.getLedgers()) {
    if (ledger.kind === 'tokens') assert.equal(ledger.consumed, 225);
    if (ledger.kind === 'cost') assert.equal(ledger.consumed, 0.005);
    assert.deepEqual(ledger.reservations, []);
  }

  const failingTransport = new StubTransport();
  failingTransport.throwError = new Error('provider response unavailable after transport dispatch');
  const uncertainProvider = createValidV02Setup({ requestId: 'req-uncertain-usage-019', transport: failingTransport });
  const uncertainProviderReceipts = captureJournalReceipts(uncertainProvider.statePort);
  const uncertainProviderTaskBefore = await uncertainProvider.statePort.loadTask(uncertainProvider.context.taskId);
  assert.ok(uncertainProviderTaskBefore);
  const uncertainProviderResult = await uncertainProvider.port.propose(
    uncertainProvider.state, uncertainProvider.evidence, uncertainProvider.request, uncertainProvider.context,
  );
  assert.equal(uncertainProviderResult.outcome, 'uncertain');
  const uncertainProviderClaim = uncertainProviderReceipts.claims[0];
  const uncertainProviderOutcome = uncertainProviderReceipts.outcomes[0];
  assert.ok(uncertainProviderClaim);
  assert.ok(uncertainProviderOutcome);
  const uncertainProviderReceipt = asProviderOutcome(uncertainProviderOutcome);
  assert.equal(uncertainProvider.statePort.getJournalSnapshot().claims[0]?.status, 'uncertain');
  assert.equal(uncertainProvider.statePort.getJournalSnapshot().attempts[0]?.status, 'uncertain');
  assert.equal(uncertainProviderReceipt.outcome, 'uncertain');
  assert.equal(uncertainProviderReceipt.observedUsage, undefined,
    'An unobserved provider response does not invent actual usage or release the reservation');
  assert.equal(uncertainProviderReceipt.proposedEffects.accounting.disposition, 'hold');
  assert.deepEqual(uncertainProviderReceipt.proposedEffects.accounting.reservationRefs, uncertainProviderClaim.reservationRefs);
  for (const budgetRef of uncertainProvider.context.budgetRefs) {
    const held = uncertainProvider.statePort.getLedgers().flatMap((ledger) => ledger.reservations)
      .filter((reservation) => reservation.reservationId === budgetRef);
    assert.equal(held.length, 1);
  }
  assert.equal((await uncertainProvider.statePort.loadTask(uncertainProvider.context.taskId))?.stateVersion,
    uncertainProviderTaskBefore.stateVersion);

  // Provider budget exhaustion in statePort denies claim with zero transport
  const dummyContext = createTestProviderAdmissionContextV02({
    providerRequest: createTestProviderRequest({ role: 'coder', contextDigest: 'sha256:placeholder' }),
  });
  const baseTaskState = createTestAdmissionTaskStateV02(dummyContext);

  const exhaustedTaskState: TaskState = {
    ...baseTaskState,
    budgetLedgers: (baseTaskState.budgetLedgers ?? []).map((ledger) => ({
      ...ledger,
      consumed: ledger.limit,
      reservations: [],
    })),
  };

  const evidence = [createFixtureSourceEvidence({ revisionDigest: exhaustedTaskState.repositoryRevisionDigest })];
  const contextDigest = computeContextDigest(exhaustedTaskState, evidence);

  const request = createTestProviderRequest({
    providerRequestId: 'req-budget-exhausted-19',
    taskId: exhaustedTaskState.taskId,
    runId: exhaustedTaskState.runId,
    role: 'coder',
    contextDigest,
  });

  const provContext = createTestProviderAdmissionContextV02({
    taskId: exhaustedTaskState.taskId,
    runId: exhaustedTaskState.runId,
    planApplicability: 'approved-plan',
    providerRequest: request,
  });

  const provJournal = new MemoryStatePortV02({
    initialTaskState: exhaustedTaskState,
    initialAuthorityRef: authorityForV02(provContext),
    initialControlVersion: provContext.expectedControlVersion,
    initialEpoch: provContext.expectedEpoch,
  });

  const transport = new StubTransport();
  const actor19 = { adapterIdentity: 'test-provider', processIncarnation: randomUUID(), fencingGeneration: 1 };
  const modelPort = new HostModelPortV02({
    transport,
    statePort: provJournal,
    executorIdentity: actor19,
    currentExecutorIdentity: () => actor19,
    providerConfig: {
      providerId: request.providerId,
      modelId: request.modelId,
      configId: request.configId,
      pricingPolicyId: request.pricingPolicyId,
    },
  });

  const result = await modelPort.propose(exhaustedTaskState, evidence, request, provContext);
  assert.equal(result.outcome, 'denied');
  assert.equal(transport.callCount, 0, 'Zero transport calls on budget exhaustion');
});

// ---------------------------------------------------------------------------
// Section 10 Case 20: Patch workspace-gate lifetime
// ---------------------------------------------------------------------------

test('Section 10 Case 20: Patch workspace gate lifetime blocks competing writer and command-view builder until settlement', async () => {
  const receiverEntered = createBarrier();
  const releaseReceiver = createBarrier();
  let harness!: Awaited<ReturnType<typeof createIntegratedPatchHarness>>;
  harness = await createIntegratedPatchHarness({
    beforePatch: async ({ apply }) => {
      receiverEntered.signal();
      await releaseReceiver.wait();
      return apply();
    },
  });
  harness.controller.snapshotToReturn = {
    canonicalRevisionDigest: harness.context.canonicalRevision,
    entries: [createSnapshotEntry('tests/test_calculator.py', 'def test_reproduction(): pass\n')],
  };
  const patchResult = harness.guard.validateAndExecute(harness.patch, harness.initialTaskState, harness.context);
  await receiverEntered.wait();
  assert.equal(harness.manager.hasActiveWriterLease(harness.context.workspaceId), true,
    'The public patch receiver holds the exclusive workspace lease while its callback is pending');

  let viewCompleted = false;
  let competingWriteCompleted = false;
  const viewPromise = harness.manager.admitCommandView({ workspaceId: harness.context.workspaceId }).then((view) => {
    viewCompleted = true;
    return view;
  }, (error: unknown) => {
    viewCompleted = true;
    return error;
  });
  const competingWritePromise = harness.manager.acquireWriteLease(
    harness.context.workspaceId,
    harness.context.canonicalRevision,
  ).then((lease) => {
    competingWriteCompleted = true;
    return lease;
  }, (error: unknown) => {
    competingWriteCompleted = true;
    return error;
  });
  assert.equal(viewCompleted, false, 'A real command-view build is blocked behind patch settlement');
  assert.equal(competingWriteCompleted, false, 'A competing writer waits behind the patch receiver lease');

  releaseReceiver.signal();
  assert.equal((await patchResult).outcome, 'success');
  const [admittedView, competingWrite] = await Promise.all([viewPromise, competingWritePromise]);
  assert.equal(viewCompleted, true);
  assert.equal(competingWriteCompleted, true);
  assert.ok(admittedView instanceof Error);
  assert.match(admittedView.message, /STALE_REVISION_DRIFT/,
    'A view build queued with the old revision fails closed after settlement');
  assert.ok(competingWrite instanceof Error);
  assert.match(competingWrite.message, /STALE_REVISION_DRIFT/,
    'The writer queued with the old revision fails closed after settlement');
  assert.equal(harness.manager.hasActiveWriterLease(harness.context.workspaceId), false);
  assert.equal(harness.effectCount, 1);

  const settlementEntered = createBarrier();
  const releaseSettlement = createBarrier();
  const afterInvoke = await createIntegratedPatchHarness();
  const originalRecord = afterInvoke.journal.recordOutcome.bind(afterInvoke.journal);
  afterInvoke.journal.recordOutcome = async (receipt) => {
    if (receipt.outcome === 'observed') {
      settlementEntered.signal();
      await releaseSettlement.wait();
    }
    return await originalRecord(receipt);
  };
  const afterInvokeResult = afterInvoke.guard.validateAndExecute(
    afterInvoke.patch, afterInvoke.initialTaskState, afterInvoke.context,
  );
  await settlementEntered.wait();
  assert.equal(afterInvoke.effectCount, 1, 'The patch effect has completed before settlement begins');
  assert.equal(afterInvoke.receiverCallCount, 1);
  assert.equal(afterInvoke.journal.getJournalSnapshot().attempts[0]?.status, 'attempting');
  assert.equal(afterInvoke.journal.getJournalSnapshot().claims[0]?.status, 'attempting');
  assert.equal(afterInvoke.journal.getJournalSnapshot().outcomes.length, 0,
    'The observed outcome is not durable until the barrier is released');
  assert.equal(afterInvoke.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);
  assert.equal(afterInvoke.manager.hasActiveWriterLease(afterInvoke.context.workspaceId), true);
  let postInvokeViewCompleted = false;
  let postInvokeWriterCompleted = false;
  const postInvokeView = afterInvoke.manager.admitCommandView({ workspaceId: afterInvoke.context.workspaceId }).then((view) => {
    postInvokeViewCompleted = true;
    return view;
  }, (error: unknown) => { postInvokeViewCompleted = true; return error; });
  const postInvokeWriter = afterInvoke.manager.acquireWriteLease(
    afterInvoke.context.workspaceId, afterInvoke.currentRevision,
  ).then((lease) => {
    postInvokeWriterCompleted = true;
    return { lease };
  }, (error: unknown) => {
    postInvokeWriterCompleted = true;
    return { error };
  });
  assert.equal(postInvokeViewCompleted, false,
    'A command-view builder remains queued after invocation while settlement awaits');
  assert.equal(postInvokeWriterCompleted, false,
    'A competing writer remains queued after invocation while settlement awaits');
  releaseSettlement.signal();
  assert.equal((await afterInvokeResult).outcome, 'success');
  const [settledView, settledWriter] = await Promise.all([postInvokeView, postInvokeWriter]);
  assert.equal(postInvokeViewCompleted, true);
  assert.equal(postInvokeWriterCompleted, true);
  assert.ok(!(settledView instanceof Error));
  assert.ok('lease' in settledWriter);
  assert.equal(afterInvoke.journal.getJournalSnapshot().attempts[0]?.status, 'settled');
  if ('lease' in settledWriter) await settledWriter.lease.release();
  assert.equal(afterInvoke.manager.hasActiveWriterLease(afterInvoke.context.workspaceId), false);
  assert.equal(afterInvoke.effectCount, 1);

  const recoveryEntered = createBarrier();
  const releaseRecovery = createBarrier();
  const fencedRecovery = await createIntegratedPatchHarness({
    uncertainEvidence: 'observed-patch',
    beforePatch: async ({ apply }) => {
      apply();
      throw new Error('patch response lost before outcome settlement');
    },
  });
  assert.equal((await fencedRecovery.guard.validateAndExecute(
    fencedRecovery.patch, fencedRecovery.initialTaskState, fencedRecovery.context,
  )).outcome, 'uncertain-effect');
  const fencedAttempt = fencedRecovery.attempts[0];
  assert.ok(fencedAttempt);
  assert.equal(fencedRecovery.effectCount, 1);
  assert.equal(fencedRecovery.manager.hasActiveWriterLease(fencedRecovery.context.workspaceId), true);
  const reconcileUncertain = fencedRecovery.journal.reconcileUncertain.bind(fencedRecovery.journal);
  fencedRecovery.journal.reconcileUncertain = async (receipt) => {
    recoveryEntered.signal();
    await releaseRecovery.wait();
    return await reconcileUncertain(receipt);
  };
  const recoveryPromise = fencedRecovery.tools.recoverPatchOutcome(fencedAttempt.attemptId);
  await recoveryEntered.wait();
  const fencedRecoveryBeforeCommit = fencedRecovery.journal.getJournalSnapshot();
  assert.equal(fencedRecoveryBeforeCommit.mode, 'paused');
  assert.equal(fencedRecoveryBeforeCommit.attempts[0]?.status, 'uncertain');
  assert.equal(fencedRecoveryBeforeCommit.claims[0]?.status, 'uncertain');
  assert.equal(fencedRecoveryBeforeCommit.fenceProofs.length, 1,
    'The UC-04 owner fence is durable before the reconciliation commit');
  assert.equal(fencedRecoveryBeforeCommit.fenceProofs[0]?.holdRef, `matrix-recovery-${fencedAttempt.attemptId}`);
  assert.equal(fencedRecoveryBeforeCommit.fenceProofs[0]?.fencingGeneration, fencedAttempt.executorIdentity.fencingGeneration + 1);
  assert.equal(fencedRecovery.manager.hasActiveWriterLease(fencedRecovery.context.workspaceId), true,
    'The workspace gate stays held during fenced recovery');
  assert.equal(fencedRecovery.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);
  assert.equal(isNeutralAttemptReceiptV02(await fencedRecovery.journal.beginAttempt(
    fencedRecovery.claims[0]!.claimId, fencedAttempt.executorIdentity,
  )), true, 'The fenced old actor cannot mint a new attempt during reconciliation');
  let recoveryWriterCompleted = false;
  const recoveryWriter = fencedRecovery.manager.acquireWriteLease(
    fencedRecovery.context.workspaceId, fencedRecovery.context.canonicalRevision,
  ).then((lease) => {
    recoveryWriterCompleted = true;
    return lease;
  }, (error: unknown) => {
    recoveryWriterCompleted = true;
    return error;
  });
  assert.equal(recoveryWriterCompleted, false,
    'A competing writer remains queued until the fenced recovery is durable');
  releaseRecovery.signal();
  assert.equal((await recoveryPromise).outcome, 'settled');
  const recoveredWriter = await recoveryWriter;
  assert.ok(recoveryWriterCompleted);
  assert.ok(recoveredWriter instanceof Error);
  assert.match(recoveredWriter.message, /STALE_REVISION_DRIFT/);
  const fencedRecoveryAfterCommit = fencedRecovery.journal.getJournalSnapshot();
  assert.equal(fencedRecoveryAfterCommit.attempts[0]?.status, 'settled');
  assert.equal(fencedRecoveryAfterCommit.claims[0]?.status, 'settled');
  assert.equal(fencedRecoveryAfterCommit.fencedIncarnations.length, 1);
  assert.equal(fencedRecovery.manager.hasActiveWriterLease(fencedRecovery.context.workspaceId), false);
  assert.equal(fencedRecovery.effectCount, 1);
  assert.equal(fencedRecovery.journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);
});

// ---------------------------------------------------------------------------
// Section 10 Case 21: Uncertain receipt vs final reconciliation (critical)
// ---------------------------------------------------------------------------

test('Section 10 Case 21: Conflicting outcome receipt cannot replace U; only reconcileUncertain finalizes; repeated reconciliation idempotent', async () => {
  const integrated = await createIntegratedPatchHarness({
    beforePatch: async ({ apply }) => {
      apply();
      throw new Error('lost response leaves an immutable uncertain predecessor');
    },
  });
  const guardResult = await integrated.guard.validateAndExecute(integrated.patch, integrated.initialTaskState, integrated.context);
  assert.equal(guardResult.outcome, 'uncertain-effect');
  const integratedAttempt = integrated.attempts[0];
  const integratedClaim = integrated.claims[0];
  const uncertainOutcome = integrated.outcomes.find((outcome) => outcome.outcome === 'uncertain');
  assert.ok(integratedAttempt);
  assert.ok(integratedClaim);
  assert.ok(uncertainOutcome);
  assert.equal(integrated.journal.getJournalSnapshot().attempts[0]?.status, 'uncertain');

  const fabricatedObserved = createTestObservedReconciliationReceiptV02(
    { ...uncertainOutcome, outcome: 'observed' } as unknown as AttemptOutcomeReceiptV02,
    integratedClaim,
    integratedAttempt,
    integrated.context,
  );
  assert.equal((await integrated.journal.reconcileObservedOutcome(fabricatedObserved)).outcome, 'conflict',
    'An observed reconciliation cannot replace uncertain predecessor U');
  assert.equal(integrated.journal.getJournalSnapshot().attempts[0]?.status, 'uncertain');

  // Recovery evidence is published only after the retained journal confirms the exact predecessor.
  integrated.setUncertainRecoveryEvidence('observed-patch');
  const integratedSettled = await integrated.tools.recoverPatchOutcome(integratedAttempt.attemptId);
  assert.equal(integratedSettled.outcome, 'settled');
  const exactReconciliation = integrated.recoveryReceipts[0];
  assert.ok(exactReconciliation);
  assert.equal(exactReconciliation.reconciliationKind, 'uncertain-attempt');
  assert.equal((await integrated.journal.reconcileUncertain(exactReconciliation)).outcome, 'settled',
    'The exact final reconciliation replays idempotently');
  const ledgersBeforeConflict = integrated.journal.getLedgers();
  const conflictingReconciliation = createTestUncertainReconciliationReceiptV02(
    uncertainOutcome,
    integratedClaim,
    integratedAttempt,
    integrated.context,
    { reconciliationId: 'recon-conflict-integrated-21' },
  );
  assert.equal((await integrated.journal.reconcileUncertain(conflictingReconciliation)).outcome, 'conflict');
  assert.deepEqual(integrated.journal.getLedgers(), ledgersBeforeConflict);
  assert.equal(integrated.journal.getJournalSnapshot().mode, 'paused');
  assert.equal(integrated.journal.getJournalSnapshot().activeClaimId, null);
  assert.equal(integrated.effectCount, 1, 'Neither bad receipt replay nor final recovery repeats the patch');

  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await journal.beginAttempt(claim.claimId, actor);

  // 1. Record uncertain outcome U
  const outcomeU = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
  const recU = await journal.recordOutcome(outcomeU);
  assert.equal(recU.outcome, 'uncertain');

  // 2. Conflicting outcome receipt cannot replace U
  const conflictingObserved = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'observed' });
  const recConflicting = await journal.recordOutcome(conflictingObserved);
  // Journal must not rewrite U: returned result is either neutral or rejected
  assert.equal(isNeutralOutcomeRecordResultV02(recConflicting), true);
  assert.equal(journal.getJournalSnapshot().attempts[0]?.status, 'uncertain', 'Attempt status remains uncertain');

  // 3. reconcileObservedOutcome refuses uncertain predecessor U
  const fakeObservedRec = createTestObservedReconciliationReceiptV02(
    { ...outcomeU, outcome: 'observed' } as unknown as AttemptOutcomeReceiptV02,
    claim,
    attempt,
    context
  );
  const fakeRes = await journal.reconcileObservedOutcome(fakeObservedRec);
  assert.equal(fakeRes.outcome, 'conflict');

  // 4. Only reconcileUncertain with exact uncertain predecessor finalizes
  const invalidatedEvidence: { reference: string; digest: string }[] = [];
  const accountingEvidenceRefs = [{ reference: 'ev-acc-21', digest: computeCanonicalSha256('ev-acc-21') }];
  const observedRevisionDigest = context.canonicalRevision;
  const effectEvidenceRef = {
    reference: 'ev-eff-21',
    digest: computeCanonicalSha256({
      schemaVersion: 'uc03-observed-patch-recovery/0.2-draft',
      predecessorReceiptId: outcomeU.receiptId,
      observedRevisionDigest,
      invalidatedEvidence,
      accountingEvidenceRefs,
    }),
  };
  await journal.publishRecoveryEvidence({
    predecessorReceiptId: outcomeU.receiptId,
    effectEvidenceRef,
    accountingEvidenceRefs,
    observedRevisionDigest,
    invalidatedEvidence,
  });
  await journal.setTaskControl(context.taskId, 'paused', 'pause-recovery-21');
  assert.ok(await journal.fenceAttemptRecipient(claim.claimId, actor));

  const reconU = createTestUncertainReconciliationReceiptV02(outcomeU, claim, attempt, context, {
    disposition: 'observed-and-accounted',
    effectEvidenceRef,
    accountingEvidenceRefs,
    evidenceRefs: [effectEvidenceRef, ...accountingEvidenceRefs],
    expectedCurrentTaskStateVersion: attempt.postBeginTaskStateVersion,
    expectedCurrentControlVersion: journal.getJournalSnapshot().controlVersion,
  });

  const settled = await journal.reconcileUncertain(reconU);
  assert.equal(settled.outcome, 'settled');

  // 5. Repeated final reconciliation is idempotent
  const replaySettled = await journal.reconcileUncertain(reconU);
  assert.deepEqual(replaySettled, settled);

  // 6. Stale/conflicting replay leaves holds and accounting unchanged
  const ledgersBeforeBad = journal.getLedgers();
  const modeBeforeBad = journal.getJournalSnapshot().mode;
  const conflictingRecon = createTestUncertainReconciliationReceiptV02(outcomeU, claim, attempt, context, {
    disposition: 'observed-and-accounted',
    reconciliationId: 'recon-conflict-bad-21',
  });
  const badReconResult = await journal.reconcileUncertain(conflictingRecon);
  assert.equal(badReconResult.outcome, 'conflict', 'Conflicting replay rejected');
  assert.deepEqual(journal.getLedgers(), ledgersBeforeBad, 'Ledgers unchanged on conflicting replay');
  assert.equal(journal.getJournalSnapshot().mode, modeBeforeBad, 'Mode unchanged on conflicting replay');
});

// ---------------------------------------------------------------------------
// Section 10 Case 22: Version migration and old continuation receipt
// ---------------------------------------------------------------------------

test('Section 10 Case 22: Version migration cutover admits explicit v0.2 records; rejects legacy context and raw claim IDs', async () => {
  const cutoverSelector = createCanonicalCutoverSelectorV02();
  const harness = await createIntegratedPatchHarness();
  const { context, journal: port, tools: repo, guard } = harness;

  assert.equal(context.schemaVersion, CANONICAL_V02_SCHEMA_VERSION);
  assert.equal(port.getJournalSnapshot().activeClaimId, null, 'Task must not have open claims');

  // 1. Positive cutover selection: admitted canonically under v0.2 selector
  const decision = cutoverSelector.select({
    context,
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    statePort: port,
    repositoryPort: repo,
  });
  assert.equal(decision.admitted, true);
  assert.equal(decision.selectedVersion, '0.2.0');
  assert.equal(decision.code, 'CANONICAL_V02_ADMITTED');
  assert.equal(decision.zeroEffects, true, 'Version selection does not authorize effects');
  assert.equal(harness.effectCount, 0, 'Selection itself has no effect authority');

  // 2. Canonical execution passes through the guard and the public controlled receiver.
  const positiveResult = await guard.validateAndExecute(context.action, harness.initialTaskState, context);
  assert.equal(positiveResult.outcome, 'success');
  assert.equal(harness.receiverCallCount, 1);
  assert.equal(harness.effectCount, 1);
  assert.equal(port.getJournalSnapshot().outcomes[0]?.outcome, 'observed');

  // 3. Missing migration checkpoints affect selection only and never dispatch.
  const missingResult = cutoverSelector.select({
    context,
    checkpoints: ['T038'], // Missing other 12 checkpoints
    statePort: port,
    repositoryPort: repo,
  });
  assert.equal(missingResult.admitted, false);
  assert.equal(missingResult.code, 'MISSING_MIGRATION_CHECKPOINTS');
  assert.equal(harness.effectCount, 1, 'No additional patch dispatch on missing checkpoints');

  // 4. The real guard rejects legacy context before invoking the receiver.
  const legacyResult = await guard.validateAndExecute(
    context.action,
    harness.initialTaskState,
    { schemaVersion: '0.1.0' } as unknown as RepositoryAdmissionContextV02,
  );
  assert.equal(legacyResult.outcome, 'denied');
  assert.equal(harness.effectCount, 1, 'No additional patch dispatch on legacy context');

  // 5. Negative vector: raw old claim ID alone never authorizes effect
  const rawClaimDecision = cutoverSelector.select({
    context: { claimId: 'claim-raw-legacy-022' },
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    statePort: port,
    repositoryPort: repo,
  });
  assert.equal(rawClaimDecision.admitted, false);
  assert.equal(rawClaimDecision.code, 'RAW_OLD_CLAIM_ID_REJECTED');
  assert.equal(rawClaimDecision.zeroEffects, true);
  const versionedRawClaimDecision = cutoverSelector.select({
    context: { schemaVersion: '0.2.0', claimId: 'unverified-old-claim' },
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
  });
  assert.equal(versionedRawClaimDecision.admitted, false);
  assert.equal(versionedRawClaimDecision.code, 'RAW_OLD_CLAIM_ID_REJECTED');
  assert.equal(harness.effectCount, 1, 'A v0.2 version label cannot make an old claim authoritative');

  // 6. Retained neutral selector remains fail-closed
  const neutralSelector = createNeutralCutoverSelectorV02();
  const neutralAdm = neutralSelector.select({
    context,
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    statePort: port,
    repositoryPort: repo,
  });
  assert.equal(neutralAdm.admitted, false);
  assert.equal(neutralAdm.code, 'NEUTRAL_CUTOVER_PENDING_T065');
  assert.equal(neutralAdm.zeroEffects, true);
  const neutralOverride = neutralSelector.select({
    context,
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    statePort: port,
    repositoryPort: repo,
    neutral: false,
  });
  assert.equal(neutralOverride.admitted, false);
  assert.equal(neutralOverride.neutral, true);
  assert.equal(port.getJournalSnapshot().claims.length, 1, 'Selection never changes journal state');
  assert.equal(harness.effectCount, 1);

  // A versioned presentation and CLI decision lead into the owner continuation,
  // then the actual execution guard consumes that retained journal claim.
  const decisionId = 'decision-matrix-022';
  const continuedContext = createTestRepositoryAdmissionContextV02({
    taskId: 'task-matrix-022',
    runId: 'run-matrix-022',
    planDecisionRef: decisionId,
  });
  const continuedPlanBindingDigest = continuedContext.planBindingDigest;
  const continuedPlanDecisionRef = continuedContext.planDecisionRef;
  if (!continuedPlanBindingDigest || !continuedPlanDecisionRef) throw new Error('matrix plan context fixture is incomplete');
  const continuedTrustedContext = createTestRepositoryAdmissionTrustedContextV02(continuedContext);
  const continuedProfile = {
    ...recoveryProfile,
    policyIdentity: {
      policyId: continuedContext.policyAuthorityRef.policyId,
      policyVersion: continuedContext.policyAuthorityRef.policyVersion,
      configId: continuedContext.policyAuthorityRef.configId,
      configVersion: continuedContext.policyAuthorityRef.configVersion,
    },
  };
  const presentation = buildPresentationV02({
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    requestVersion: 1,
    decisionId,
    repositoryId: continuedContext.repositoryId,
    continuationRef: 'continuation-matrix-022',
    policyIdentity: continuedProfile.policyIdentity,
    elements: {
      action: 'Apply the approved repair patch',
      necessity: 'Resolve the verified defect',
      targets: ['src/calculator.py'],
      consequences: 'Updates the workspace revision',
      verificationStatus: 'Not executed',
    },
    action: continuedContext.action,
    planBindingDigest: continuedPlanBindingDigest,
    planDecisionRef: continuedPlanDecisionRef,
  }, continuedProfile).summary;
  assert.equal(presentation.subjectKind, 'repository-action');
  assert.equal(presentation.planApplicability, 'approved-plan');
  assert.equal(presentation.actionDigest, continuedContext.actionDigest);
  assert.equal(presentation.planBindingDigest, continuedContext.planBindingDigest);
  assert.equal(presentation.planDecisionRef, decisionId);

  let decisionCommitted = false;
  const cliService = {
    cliSchemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
    presentationProfileV02: continuedProfile,
    listV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, items: [presentation] }),
    historyV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, records: [] }),
    showV02: async () => presentation,
    inspectV02: async () => presentation,
    decideV02: async (input: unknown) => {
      const request = input as Record<string, unknown>;
      if (request['taskId'] !== continuedContext.taskId || request['decisionId'] !== decisionId ||
        request['requestVersion'] !== presentation.requestVersion ||
        request['presentationDigest'] !== presentation.presentationDigest || request['decision'] !== 'approve') {
        return { schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, outcome: 'denied', safeReasonCode: 'decision-not-bound' };
      }
      decisionCommitted = true;
      return { schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, outcome: 'ok', safeReasonCode: 'decision-recorded' };
    },
    controlV02: async () => ({ schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02, outcome: 'denied' }),
  };
  const cliView = await runApprovalCliV02([
    'show', '--task', continuedContext.taskId, '--request', decisionId,
  ], cliService);
  assert.equal(cliView.exitCode, 0);
  assert.deepEqual(JSON.parse(cliView.output).value, presentation,
    'CLI exposes the validated versioned presentation tied to the approved plan context');
  const cliDecision = await runApprovalCliV02([
    'decide', '--task', continuedContext.taskId, '--request', decisionId,
    '--task-version', '2', '--request-version', String(presentation.requestVersion),
    '--presentation-digest', presentation.presentationDigest, '--decision', 'approve',
    '--response-key', 'response-matrix-022',
  ], cliService);
  assert.equal(cliDecision.exitCode, 0);
  assert.equal(JSON.parse(cliDecision.output).schemaVersion, UC05_APPROVAL_SCHEMA_VERSION_V02);
  assert.equal(decisionCommitted, true);

  const continuedApproval = {
    provenance: 'mock' as const,
    resolve: async () => ({
      decisionId,
      actionKind: 'action' as const,
      normalizedActionDigest: continuedContext.actionDigest,
      taskId: continuedContext.taskId,
      workspaceId: continuedContext.workspaceId,
      repositoryRevisionDigest: continuedContext.canonicalRevision,
      policyId: continuedContext.policyAuthorityRef.policyId,
      policyVersion: continuedContext.policyAuthorityRef.policyVersion,
      status: decisionCommitted ? 'approved' as const : 'pending' as const,
    }),
    validateBinding: async () => decisionCommitted,
  };
  const continuedJournal = createJournal(continuedContext);
  const continuation = createApprovalContinuationV02({
    taskId: continuedContext.taskId,
    profile: continuedProfile,
    approval: continuedApproval as unknown as import('../../../src/approvals/service.ts').ApprovalService,
    recovery: {
      provenance: 'mock',
      loadAdmission: async (candidateDecisionId: string) => candidateDecisionId === decisionId
        ? { context: continuedContext, trustedContext: continuedTrustedContext }
        : null,
    },
    journal: continuedJournal,
  });
  const continued = await continuation.admit(decisionId);
  assert.equal(continued.outcome, 'claimed');
  assert.equal(continued.claimId, continued.claimState?.journalReceipt.claimId);
  assert.equal(validateDispatchClaimV02(continued.claimState?.claim).ok, true);
  assert.equal(continued.claimState?.claim.planBindingDigest, continuedContext.planBindingDigest);
  assert.equal(continued.claimState?.claim.planDecisionRef, decisionId);
  assert.equal(continued.claimState?.claim.actionDigest, continuedContext.actionDigest);
  assert.deepEqual(continued.claimState?.claim.reservationRefs, continuedContext.reservationRefs);
  const continuedClaim = continued.claimState?.journalReceipt;
  assert.ok(continuedClaim);
  assert.equal(continuedClaim.preClaimTaskStateVersion, continuedContext.expectedTaskStateVersion);
  assert.equal(continuedClaim.preClaimControlVersion, continuedContext.expectedControlVersion);
  assert.equal(continuedClaim.postClaimControlVersion, continuedContext.expectedControlVersion + 1);
  assert.deepEqual(continuedClaim.reservationRefs, continuedContext.reservationRefs);
  assert.equal(continuedJournal.getJournalSnapshot().claims[0]?.status, 'claimed');
  assert.equal(continuedJournal.getJournalSnapshot().attempts.length, 0,
    'The continuation returns an owner claim without starting an attempt');
  for (const reservationRef of continuedContext.reservationRefs) {
    assert.equal(continuedJournal.getLedgers().flatMap((ledger) => ledger.reservations)
      .filter((reservation) => reservation.reservationId === reservationRef).length, 1);
  }

  const consumingHarness = await createIntegratedPatchHarness({
    context: continuedContext,
    statePort: continuedJournal,
  });
  const consumedResult = await consumingHarness.guard.validateAndExecute(
    continuedContext.action, consumingHarness.initialTaskState, continuedContext,
  );
  assert.equal(consumedResult.outcome, 'success');
  assert.equal(consumingHarness.receiverCallCount, 1,
    'The current guard and receiver consume the exact owner-issued continuation claim once');
  assert.equal(consumingHarness.claims[0]?.claimId, continued.claimId);
  assert.equal(consumingHarness.attempts[0]?.claimId, continued.claimId);
  assert.equal(consumingHarness.outcomes[0]?.claimId, continued.claimId);
  assert.equal(continuedJournal.getJournalSnapshot().controlVersion, continuedContext.expectedControlVersion + 3);
  assert.equal((await continuedJournal.loadTask(continuedContext.taskId))?.stateVersion,
    continuedContext.expectedTaskStateVersion + 2);
  assert.equal(continuedJournal.getJournalSnapshot().claims[0]?.status, 'settled');
  assert.equal(continuedJournal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);
  assert.deepEqual(continuedJournal.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations, []);

  // Obtain a literal v0.1 continuation claim and prove it cannot cross the v0.2 cutover.
  const oldScenario = createRecoveryScenario();
  const oldApproval = oldScenario.service();
  await oldApproval.requestDecision(oldScenario.binding);
  await oldScenario.decide(oldApproval);
  const oldContinuation = createApprovalContinuation({
    taskId: 'task-1',
    profile: recoveryProfile,
    approval: oldScenario.service(),
    recovery: oldScenario.owner,
  });
  const oldResult = await oldContinuation.admit('decision-1');
  assert.equal(oldResult.outcome, 'claimed');
  assert.ok(oldResult.claimId);
  assert.deepEqual(Object.keys(oldResult).sort(), ['claimId', 'outcome'],
    'The old continuation returns coordination state only, with no executor capability');
  const oldClaimJournal = createJournal(continuedContext);
  const oldClaimReceiver = new FakeRepositoryPort({
    statePort: oldClaimJournal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: continuedContext.actionDigest }),
  });
  const oldContinuationDecision = createCanonicalCutoverSelectorV02().select({
    rawClaimId: oldResult.claimId,
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    statePort: oldClaimJournal,
    repositoryPort: oldClaimReceiver,
  });
  assert.equal(oldContinuationDecision.admitted, false);
  assert.equal(oldContinuationDecision.code, 'RAW_OLD_CLAIM_ID_REJECTED');
  assert.deepEqual(oldClaimJournal.getJournalSnapshot().claims, []);
  assert.deepEqual(oldClaimJournal.getLedgers().find((ledger) => ledger.kind === 'repair')?.reservations, []);
  assert.equal(oldClaimReceiver.patches.length, 0);
  assert.equal(oldClaimReceiver.commands.length, 0);
});

test('R1 selector regression: a forged v0.2 label without ports cannot execute a callback or fake guard', async () => {
  const selector = createCanonicalCutoverSelectorV02();
  const forged = {
    context: { schemaVersion: '0.2.0', claimId: 'unverified-old-claim' },
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
  };
  let effects = 0;

  const callbackEntry = Reflect.get(selector, 'executeIfAdmitted');
  if (typeof callbackEntry === 'function') {
    await Reflect.apply(callbackEntry, selector, [forged, async () => {
      effects++;
      return 'executed-without-admission';
    }]);
  }

  const fakeGuardEntry = Reflect.get(selector, 'executeGuardedAction');
  if (typeof fakeGuardEntry === 'function') {
    await Reflect.apply(fakeGuardEntry, selector, [{
      ...forged,
      action: {},
      taskState: {},
      guard: {
        validateAndExecute: async () => {
          effects++;
          return { outcome: 'success' };
        },
      },
    }]);
  }

  assert.equal(effects, 0, 'Version label and raw claim ID must not reach any effect callback');
});

test('R1 neutral regression: request options cannot override the neutral factory invariant', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const repo = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });
  const selector = createNeutralCutoverSelectorV02();
  const beforeTask = await journal.loadTask(context.taskId);
  const beforeLedgers = journal.getLedgers();
  const beforeJournal = journal.getJournalSnapshot();
  const options = {
    context,
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    statePort: journal,
    repositoryPort: repo,
    neutral: false,
  } as unknown as Parameters<typeof selector.select>[0];

  const decision = selector.select(options);
  assert.equal(decision.admitted, false);
  assert.equal(decision.code, 'NEUTRAL_CUTOVER_PENDING_T065');
  assert.equal(decision.neutral, true);

  let effects = 0;
  const callbackEntry = Reflect.get(selector, 'executeIfAdmitted');
  if (typeof callbackEntry === 'function') {
    await Reflect.apply(callbackEntry, selector, [options, async () => {
      effects++;
      return 'neutral-override-executed';
    }]);
  }

  assert.equal(effects, 0, 'Neutral selector must refuse even when a caller requests neutral:false');
  assert.deepEqual(await journal.loadTask(context.taskId), beforeTask);
  assert.deepEqual(journal.getLedgers(), beforeLedgers);
  assert.deepEqual(journal.getJournalSnapshot(), beforeJournal);
  assert.equal(repo.patches.length, 0);
  assert.equal(repo.commands.length, 0);
  assert.equal(repo.tests.length, 0);
});
