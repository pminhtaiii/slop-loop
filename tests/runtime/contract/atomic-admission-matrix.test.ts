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
  isAdmittedForProduction,
  validateAdmissionV02,
  validateAttemptOutcomeReceiptV02,
  computeActionDigest,
  computeCanonicalSha256,
  computeCheckSetDigest,
  CANONICAL_V02_SCHEMA_VERSION,
  REQUIRED_MIGRATION_CHECKPOINTS,
  createCanonicalCutoverSelectorV02,
  createNeutralCutoverSelectorV02,
  type TaskState,
  type RepositoryAdmissionContextV02,
  type ProviderAdmissionContextV02,
  type ClaimReceiptV02,
  type AttemptReceiptV02,
  type AttemptOutcomeReceiptV02,
  type RunCommandAction,
  type ExecutionLimits,
  type BugTask,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  createApprovalControlV02,
} from '../../../src/approvals/control.ts';
import {
  UC05_APPROVAL_SCHEMA_VERSION_V02,
  validateClaimClosureReceipt,
  computeDispatchClaimDigestV02,
  validateDispatchClaimV02,
  type DispatchClaimV02,
} from '../../../src/contracts/approvals/contracts.ts';
import type {
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
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
  createTestRepositoryOutcomeReceiptV02,
  createTestProviderAdmissionContextV02,
  createTestProviderRequest,
  createTestAttemptOutcomeValidationContextV02,
  createTestUncertainReconciliationReceiptV02,
  createTestObservedReconciliationReceiptV02,
  createTestAction,
} from '../support/uc03/state-fixtures.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
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
} from '../../../src/foundation/docker-workspace.ts';
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

function pauseProof(journal: MemoryStatePortV02, eventKind: 'pause' | 'denial', eventRef: string) {
  const eventDigest = (journal.getJournalSnapshot() as unknown as Record<string, unknown>)['holdEventDigest'];
  if (typeof eventDigest !== 'string') throw new Error('journal-hold-event-digest-unavailable');
  assert.match(eventDigest, /^sha256:[0-9a-f]{64}$/u);
  return { eventKind, eventRef, eventDigest };
}

class MockDockerLifecycleController implements DockerLifecycleController {
  readonly provenance = 'mock' as const;
  private readonly volumes = new Set<string>();
  readonly createdVolumes: string[] = [];
  readonly removedVolumes: string[] = [];
  snapshotToReturn?: CanonicalRepositorySnapshot;
  readonly executedPlans: DockerContainerPlan[] = [];

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

  async materializeView(): Promise<void> {}

  async executeContainer(plan: DockerContainerPlan): Promise<ContainerExecutionOutput> {
    this.executedPlans.push(plan);
    return {
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
      durationMs: 25,
      timedOut: false,
    };
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

class StubTransport implements HostModelTransport {
  callCount = 0;
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
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const taskBefore = await journal.loadTask(context.taskId);
  const ledgersBefore = journal.getLedgers();
  const control = createApprovalControlV02({ taskId: context.taskId, journal });
  const authorityRef = publicationAfter(context);

  // Policy publication wins before beginAttempt
  const published = await control.publishAuthority({ authorityRef });
  assert.equal(published.outcome, 'ok');

  // Attempt using old claim ref denies
  const attempted = await journal.beginAttempt(claim.claimId, actor);
  assert.equal(isNeutralAttemptReceiptV02(attempted), true);

  // Assert zero invocations, old claim remains claimed, reservation held
  const snapshot = journal.getJournalSnapshot();
  assert.equal(snapshot.attempts.length, 0);
  assert.equal(snapshot.claims.find((c) => c.claimId === claim.claimId)?.status, 'claimed');
  assert.deepEqual(await journal.loadTask(context.taskId), taskBefore);
  assert.deepEqual(journal.getLedgers(), ledgersBefore);
  assert.deepEqual(snapshot.activeAuthorityRef, authorityRef);

  // Fenced closure releases unconsumed reservation after recipient fencing + non-dispatch proof
  await journal.setTaskControl(context.taskId, 'paused', 'policy-stale-001');
  const pauseEvent = pauseProof(journal, 'pause', 'policy-stale-001');
  const closeResult = await control.closeUnattemptedClaim({
    claim: dispatchClaim(context, claim),
    journalClaim: claim,
    recipientIdentity: actor,
    pauseOrDenialEvent: pauseEvent,
  });
  assert.equal(closeResult.closed, true);
  assert.equal('attemptId' in (closeResult.receipt ?? {}), false);
  const repairLedger = journal.getLedgers().find((l) => l.kind === 'repair');
  assert.equal(repairLedger?.consumed, 0);
  assert.deepEqual(repairLedger?.reservations, []);
});

// ---------------------------------------------------------------------------
// Section 10 Case 2: beginAttempt before policy publication or pause
// ---------------------------------------------------------------------------

test('Section 10 Case 2: beginAttempt before policy publication or pause admits one attempt under captured refs', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const authorityRef = publicationAfter(context);
  const control = createApprovalControlV02({ taskId: context.taskId, journal });

  // beginAttempt wins before publication
  const attempted = await journal.beginAttempt(claim.claimId, actor);
  assert.equal(isNeutralAttemptReceiptV02(attempted), false);

  // Subsequent publication succeeds and is active for future work
  const published = await control.publishAuthority({ authorityRef });
  assert.equal(published.outcome, 'ok');

  const snapshot = journal.getJournalSnapshot();
  assert.equal(snapshot.attempts.length, 1);
  assert.equal(snapshot.claims.find((c) => c.claimId === claim.claimId)?.status, 'attempting');
  assert.deepEqual(snapshot.activeAuthorityRef, authorityRef);

  const taskAfter = await journal.loadTask(context.taskId);
  assert.equal(taskAfter?.node, 'Patch');
  assert.equal(taskAfter?.stateVersion, context.expectedTaskStateVersion + 1);

  const repairLedger = journal.getLedgers().find((l) => l.kind === 'repair');
  assert.equal(repairLedger?.consumed, 1);

  // Attempting unattempted claim closure denies for this active attempt
  await journal.setTaskControl(context.taskId, 'paused', 'pause-after-begin-001');
  const pauseEvent = pauseProof(journal, 'pause', 'pause-after-begin-001');
  const closeResult = await control.closeUnattemptedClaim({
    claim: dispatchClaim(context, claim),
    journalClaim: claim,
    recipientIdentity: actor,
    pauseOrDenialEvent: pauseEvent,
  });
  assert.equal(closeResult.closed, false);
});

// ---------------------------------------------------------------------------
// Section 10 Case 3: Pause/rejection after claim, before beginAttempt
// ---------------------------------------------------------------------------

test('Section 10 Case 3: Pause/rejection after claim, before beginAttempt denies begin and closes claim without consuming allowance', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const control = createApprovalControlV02({ taskId: context.taskId, journal });

  // Pause committed before beginAttempt
  assert.equal(await journal.setTaskControl(context.taskId, 'paused', 'pause-event-c3'), true);
  const attempted = await journal.beginAttempt(claim.claimId, actor);
  assert.equal(isNeutralAttemptReceiptV02(attempted), true);

  const pauseEvent = pauseProof(journal, 'pause', 'pause-event-c3');

  const closeResult = await control.closeUnattemptedClaim({
    claim: dispatchClaim(context, claim),
    journalClaim: claim,
    recipientIdentity: actor,
    pauseOrDenialEvent: pauseEvent,
  });

  assert.equal(closeResult.closed, true);
  assert.ok(closeResult.receipt);
  assert.equal('attemptId' in (closeResult.receipt ?? {}), false, 'ClaimClosureReceipt must strictly omit attemptId');
  assert.equal(closeResult.receipt?.claimId, claim.claimId);
  assert.equal(closeResult.receipt?.claimDigest, dispatchClaim(context, claim).claimDigest);
  assert.equal(validateClaimClosureReceipt(closeResult.receipt).ok, true);

  const snapshot = journal.getJournalSnapshot();
  assert.equal(snapshot.mode, 'paused');
  assert.equal(snapshot.activeClaimId, null);
  assert.equal(snapshot.claims.find((c) => c.claimId === claim.claimId)?.status, 'closed');
  assert.equal(snapshot.attempts.length, 0);

  const repairLedger = journal.getLedgers().find((l) => l.kind === 'repair');
  assert.equal(repairLedger?.consumed, 0, 'No repair allowance consumed on unattempted closure');
  assert.deepEqual(repairLedger?.reservations, [], 'Unconsumed reservations released');
});

// ---------------------------------------------------------------------------
// Section 10 Case 4: Repository writer/view drift before beginAttempt
// ---------------------------------------------------------------------------

test('Section 10 Case 4: Repository writer/view drift before beginAttempt yields zero invocations', async () => {
  const controller = new MockDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const rev1 = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const rev2 = 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  const ws = await manager.createWorkspace({
    taskId: 'task-drift-case4',
    workspaceId: 'ws-drift-case4',
    initialRevisionDigest: rev1,
    profile,
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev1,
    entries: [createSnapshotEntry('src/app.py', 'print("hello")\n')],
  };

  const view = await manager.admitCommandView({ workspaceId: ws.workspaceId });

  // Drift occurs in workspace revision before attempt execution
  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev2,
    entries: [createSnapshotEntry('src/app.py', 'print("drifted")\n')],
  };
  manager.setCanonicalRevision(ws.workspaceId, rev2);

  const executor = new StructuredCommandExecutor({
    manager,
    controller,
    profile,
    adapterIdentity: 'structured-command-executor',
    processIncarnation: 'inc-case4-drift',
    fencingGeneration: 1,
  });

  const action: RunCommandAction = {
    actionId: 'act-cmd-case4',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q'],
    workingDirectory: '/workspace/repo',
  };

  const attempt: AttemptReceiptV02 = {
    attemptId: 'att-case4-1',
    claimId: 'claim-case4-1',
    taskId: ws.taskId,
    executorIdentity: {
      adapterIdentity: 'structured-command-executor',
      processIncarnation: 'inc-case4-drift',
      fencingGeneration: 1,
      payloadDigest: computeActionDigest(action),
    },
    preAttemptTaskStateVersion: 1,
    postBeginTaskStateVersion: 1,
    preAttemptControlVersion: 1,
    postBeginControlVersion: 2,
    epoch: 1,
    status: 'attempting',
  };

  // Execution with drifted view is refused with ZERO controller dispatches
  await assert.rejects(
    () => executor.execute({ workspaceId: ws.workspaceId, action, limits: createValidLimits(), view, attempt }),
    /COMMAND_VIEW_REQUIRED|STALE_COMMAND_VIEW|COMMAND_VIEW_DRIFT/
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero low-level invocations on drift');
});

// ---------------------------------------------------------------------------
// Section 10 Case 5: Duplicate successful receipt to one executor incarnation
// ---------------------------------------------------------------------------

test('Section 10 Case 5: Duplicate successful receipt to same executor incarnation with pre-invoke barrier allows exactly one dispatch', async () => {
  const controller = new MockDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const rev = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const ws = await manager.createWorkspace({
    taskId: 'task-case5',
    workspaceId: 'ws-case5',
    initialRevisionDigest: rev,
    profile,
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [createSnapshotEntry('src/app.py', 'print("hello")\n')],
  };

  const view = await manager.admitCommandView({ workspaceId: ws.workspaceId });
  const executor = new StructuredCommandExecutor({
    manager,
    controller,
    profile,
    adapterIdentity: 'structured-command-executor',
    processIncarnation: 'inc-case5-active',
    fencingGeneration: 1,
  });

  const action: RunCommandAction = {
    actionId: 'act-cmd-case5',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q'],
    workingDirectory: '/workspace/repo',
  };
  const actionDigest = computeActionDigest(action);

  const attempt: AttemptReceiptV02 = {
    attemptId: 'att-case5-unique-1',
    claimId: 'claim-case5-1',
    taskId: ws.taskId,
    executorIdentity: {
      adapterIdentity: 'structured-command-executor',
      processIncarnation: 'inc-case5-active',
      fencingGeneration: 1,
      payloadDigest: actionDigest,
    },
    preAttemptTaskStateVersion: 1,
    postBeginTaskStateVersion: 1,
    preAttemptControlVersion: 1,
    postBeginControlVersion: 2,
    epoch: 1,
    status: 'attempting',
  };

  // Deterministic barrier
  const atBarrier = createBarrier();
  const releaseBarrier = createBarrier();

  const firstDeliveryPromise = executor.execute({
    workspaceId: ws.workspaceId,
    action,
    limits: createValidLimits(),
    view,
    attempt,
    preInvokeBarrier: async () => {
      atBarrier.signal();
      await releaseBarrier.wait();
    },
  });

  await atBarrier.wait();

  // Concurrently deliver duplicate receipt
  await assert.rejects(
    () => executor.execute({ workspaceId: ws.workspaceId, action, limits: createValidLimits(), view, attempt }),
    /DUPLICATE_ATTEMPT_CONSUMED/
  );

  // Release barrier to let winning delivery complete
  releaseBarrier.signal();
  const result = await firstDeliveryPromise;
  assert.equal(result.outcome, 'success');
  assert.equal(controller.executedPlans.length, 1, 'Exactly one low-level execution dispatch');

  // Subsequent call after first delivery completed is also rejected status-only
  await assert.rejects(
    () => executor.execute({ workspaceId: ws.workspaceId, action, limits: createValidLimits(), view, attempt }),
    /DUPLICATE_ATTEMPT_CONSUMED/
  );
  assert.equal(controller.executedPlans.length, 1);
});

// ---------------------------------------------------------------------------
// Section 10 Case 6: Protocol-owned version progression
// ---------------------------------------------------------------------------

test('Section 10 Case 6: Protocol-owned version progression increments task/control accurately and denies stale snapshots', async () => {
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
});

// ---------------------------------------------------------------------------
// Section 10 Case 7: Fresh action/run ID while a claim is open
// ---------------------------------------------------------------------------

test('Section 10 Case 7: Fresh action/run ID is denied task-wide while any claim is open', async () => {
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
});

// ---------------------------------------------------------------------------
// Section 10 Case 8: Stale/duplicate executor after reconciliation
// ---------------------------------------------------------------------------

test('Section 10 Case 8: Stale executor actor after fencing refuses execution', async () => {
  const controller = new MockDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const rev = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const ws = await manager.createWorkspace({
    taskId: 'task-fence-case8',
    workspaceId: 'ws-fence-case8',
    initialRevisionDigest: rev,
    profile,
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [createSnapshotEntry('src/app.py', 'print("hello")\n')],
  };

  const view = await manager.admitCommandView({ workspaceId: ws.workspaceId });
  const executor = new StructuredCommandExecutor({
    manager,
    controller,
    profile,
    adapterIdentity: 'structured-command-executor',
    processIncarnation: 'inc-case8-active',
    fencingGeneration: 1,
  });

  // Owner increments / fences generation to 2
  executor.setFencingGeneration(2);

  const action: RunCommandAction = {
    actionId: 'act-cmd-case8',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q'],
    workingDirectory: '/workspace/repo',
  };

  const staleAttempt: AttemptReceiptV02 = {
    attemptId: 'att-case8-stale',
    claimId: 'claim-case8-stale',
    taskId: ws.taskId,
    executorIdentity: {
      adapterIdentity: 'structured-command-executor',
      processIncarnation: 'inc-case8-active',
      fencingGeneration: 1, // Stale generation (1 < 2)
      payloadDigest: computeActionDigest(action),
    },
    preAttemptTaskStateVersion: 1,
    postBeginTaskStateVersion: 1,
    preAttemptControlVersion: 1,
    postBeginControlVersion: 2,
    epoch: 1,
    status: 'attempting',
  };

  await assert.rejects(
    () => executor.execute({ workspaceId: ws.workspaceId, action, limits: createValidLimits(), view, attempt: staleAttempt }),
    /STALE_FENCING_GENERATION/
  );
  assert.equal(controller.executedPlans.length, 0, 'Zero dispatches from fenced stale generation');
});

// ---------------------------------------------------------------------------
// Section 10 Case 9: Crash or lost response at every boundary
// ---------------------------------------------------------------------------

test('Section 10 Case 9: Crash or lost response rereads journal state; replaying outcome is idempotent with no blind retry', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await journal.beginAttempt(claim.claimId, actor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);

  // Crash / lost response yields uncertain outcome recording
  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
  const firstRecord = await journal.recordOutcome(outcomeReceipt);
  assert.equal(firstRecord.outcome, 'uncertain');

  // Re-read journal state
  const snapshot = journal.getJournalSnapshot();
  assert.equal(snapshot.attempts.find((a) => a.attemptId === attempt.attemptId)?.status, 'uncertain');

  // Replaying identical outcome receipt is idempotent
  const replayRecord = await journal.recordOutcome(outcomeReceipt);
  assert.equal(replayRecord.outcome, 'already-recorded');
  assert.equal(replayRecord.receiptId, outcomeReceipt.receiptId);

  // Blind retry of beginAttempt denies
  const retryAttempt = await journal.beginAttempt(claim.claimId, actor);
  assert.equal(isNeutralAttemptReceiptV02(retryAttempt), true);
});

// ---------------------------------------------------------------------------
// Section 10 Case 10: Settlement/checkpoint failure after patch
// ---------------------------------------------------------------------------

test('Section 10 Case 10: Settlement failure after patch records observed-unsettled and reconciles once without second patch', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await journal.beginAttempt(claim.claimId, actor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);

  const afterAttempt = await journal.loadTask(context.taskId);
  assert.ok(afterAttempt);

  // Simulate semantic task state drift prior to settlement commit
  journal.getUnderlying().internalSetTask({ ...afterAttempt, node: 'Repair' });

  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
  const recorded = await journal.recordOutcome(outcomeReceipt);
  assert.equal(recorded.outcome, 'recorded-unsettled');

  const snapshot = journal.getJournalSnapshot();
  assert.equal(snapshot.attempts[0]?.status, 'observed-unsettled');

  // Restore Patch state with observed revision for reconciliation
  assert.ok(outcomeReceipt.observedResultRevisionDigest);
  journal.getUnderlying().internalSetTask({
    ...afterAttempt,
    repositoryRevisionDigest: outcomeReceipt.observedResultRevisionDigest,
  });
  const currentTask = await journal.loadTask(context.taskId);
  assert.ok(currentTask);

  const reconciliation = createTestObservedReconciliationReceiptV02(outcomeReceipt, claim, attempt, context, {
    expectedCurrentTaskStateVersion: currentTask.stateVersion,
    expectedCurrentControlVersion: journal.getJournalSnapshot().controlVersion,
  });

  const settled = await journal.reconcileObservedOutcome(reconciliation);
  assert.equal(settled.outcome, 'settled');

  const finalTask = await journal.loadTask(context.taskId);
  assert.ok(finalTask);
  assert.equal(finalTask.node, 'Verify', 'Transitioned to Verify once');
  assert.equal(finalTask.repositoryRevisionDigest, outcomeReceipt.observedResultRevisionDigest);
  const repairLedger = journal.getLedgers().find((l) => l.kind === 'repair');
  assert.equal(repairLedger?.consumed, 1, 'Repair charged exactly once');
});

// ---------------------------------------------------------------------------
// Section 10 Case 11: Uncertain versus observed-outcome recovery
// ---------------------------------------------------------------------------

test('Section 10 Case 11: Uncertain versus observed-outcome recovery accepts only exact predecessors with idempotent replay', async () => {
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
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });

  // beginAttempt consumes 1 repair allowance
  const attempt = await journal.beginAttempt(claim.claimId, actor);
  assert.equal(isNeutralAttemptReceiptV02(attempt), false);
  const repairBefore = journal.getLedgers().find((l) => l.kind === 'repair');
  assert.equal(repairBefore?.consumed, 1);

  // Record failed / partial outcome as uncertain
  const outcomeReceipt = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, { outcome: 'uncertain' });
  await journal.recordOutcome(outcomeReceipt);

  const repairAfter = journal.getLedgers().find((l) => l.kind === 'repair');
  assert.equal(repairAfter?.consumed, 1, 'No refund on failed attempt');
  assert.deepEqual(repairAfter?.reservations, []);
});

// ---------------------------------------------------------------------------
// Section 10 Case 13: Pre-plan baseline/test-only regression path
// ---------------------------------------------------------------------------

test('Section 10 Case 13: Pre-plan baseline runTests succeeds without plan decision; production patch without plan binding denies', async () => {
  const task = createFixtureBugTask();
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

  const initial = createTestAdmissionTaskStateV02(baselineAdmission);
  const state = {
    ...initial,
    budgetLedgers: [
      ...(initial.budgetLedgers ?? []),
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
  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: baselineAdmission.expectedControlVersion,
    initialEpoch: baselineAdmission.expectedEpoch,
    initialAuthorityRef: baselineAdmission.policyAuthorityRef,
  });

  const repo = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: baselineAdmission.actionDigest }),
    testResults: {
      default: {
        checkId: reproCheck.checkId,
        outcome: 'fail',
        outputExcerpt: 'ZeroDivisionError: division by zero',
        durationMs: 40,
      },
    },
  });

  const hostPort = createBoundHostPort(task);
  const trustedContext = createTrustedAdmissionContext(task, {
    admissionContext: baselineAdmission,
    statePort: journal,
  });

  // Guarded baseline runTests succeeds without approved plan
  const baselineResult = await investigateBaseline(task, repo, hostPort, trustedContext);
  assert.equal(baselineResult.status, 'reproduced');
  const snapshot = journal.getJournalSnapshot();
  assert.ok(snapshot.claims.length > 0);
  assert.ok(snapshot.outcomes.length > 0);
  assert.equal(snapshot.outcomes[0]?.outcome, 'observed');
  assert.ok(repo.v02Calls.length > 0);
  assert.equal(repo.v02Calls[0]?.context.planApplicability, 'pre-plan-diagnostic');

  // Production patch without approved plan binding denies with zero dispatch
  const invalidProdPatch = createTestRepositoryAdmissionContextV02({
    planApplicability: 'approved-plan',
    planBindingDigest: undefined as unknown as string,
    planDecisionRef: undefined as unknown as string,
  });
  const validation = validateAdmissionV02(
    invalidProdPatch,
    createTestRepositoryAdmissionTrustedContextV02(invalidProdPatch)
  );
  assert.equal(validation.ok, false, 'Production patch without approved plan decision is denied');
});

// ---------------------------------------------------------------------------
// Section 10 Case 14: Provider request/claim race
// ---------------------------------------------------------------------------

test('Section 10 Case 14: Exact provider request ID reuses single claim; fresh competitor denied without transport', async () => {
  const { port, transport, state, evidence, request, context, statePort } = createValidV02Setup({ requestId: 'req-race-014' });

  // First request proposes and records outcome
  const firstResult = await port.propose(state, evidence, request, context);
  assert.equal(transport.callCount, 1);
  assert.equal(firstResult.outcome, 'observed');

  // Exact duplicate request reuses claim and does not call transport again
  const dupResult = await port.propose(state, evidence, request, context);
  assert.equal(transport.callCount, 1, 'Transport called only once for duplicate request ID');
  assert.equal(dupResult.outcome, 'observed');

  // Fresh competitor request with different requestId while claim is active is denied
  const competing = createValidV02Setup({ requestId: 'req-competitor-014', statePort });
  const compClaim = await statePort.claim(competing.context);
  assert.equal(isNeutralClaimReceiptV02(compClaim), true, 'Competing provider request denied');
  assert.equal(transport.callCount, 1);
});

// ---------------------------------------------------------------------------
// Section 10 Case 15: Coder and reviewer provider branches
// ---------------------------------------------------------------------------

test('Section 10 Case 15: Coder and reviewer provider branches each use branch receipt and single reservation', async () => {
  // Coder branch
  const coderSetup = createValidV02Setup({ role: 'coder', requestId: 'req-branch-coder-15' });
  const coderResult = await coderSetup.port.propose(coderSetup.state, coderSetup.evidence, coderSetup.request, coderSetup.context);
  assert.equal(coderSetup.transport.callCount, 1);
  assert.equal(coderResult.outcome, 'observed');
  assert.equal(coderSetup.statePort.getJournalSnapshot().outcomes[0]?.outcome, 'observed');

  // Reviewer branch
  const reviewerSetup = createValidV02Setup({ role: 'reviewer', requestId: 'req-branch-rev-15' });
  const reviewerResult = await reviewerSetup.port.propose(reviewerSetup.state, reviewerSetup.evidence, reviewerSetup.request, reviewerSetup.context);
  assert.equal(reviewerSetup.transport.callCount, 1);
  assert.equal(reviewerResult.outcome, 'observed');
  assert.equal(reviewerSetup.statePort.getJournalSnapshot().outcomes[0]?.outcome, 'observed');
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

  // Pre-plan diagnostic provider outcome
  const prePlanSetup = createValidV02Setup({ planApplicability: 'pre-plan-diagnostic', requestId: 'req-preplan-016' });
  const provResult = await prePlanSetup.port.propose(prePlanSetup.state, prePlanSetup.evidence, prePlanSetup.request, prePlanSetup.context);
  assert.equal(prePlanSetup.transport.callCount, 1);
  assert.equal(provResult.outcome, 'observed');
  assert.equal(prePlanSetup.statePort.getJournalSnapshot().outcomes[0]?.outcome, 'observed');
});

// ---------------------------------------------------------------------------
// Section 10 Case 17: Cross-branch outcome/reconciliation fields
// ---------------------------------------------------------------------------

test('Section 10 Case 17: Cross-branch and fabricated fields are rejected fail-closed without mutating state', async () => {
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
});

// ---------------------------------------------------------------------------
// Section 10 Case 18: Observed patch plus task-state conflict
// ---------------------------------------------------------------------------

test('Section 10 Case 18: Observed patch plus task-state conflict reconciles from stored receipt with monotone versions', async () => {
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
});

// ---------------------------------------------------------------------------
// Section 10 Case 19: Provider budget regression
// ---------------------------------------------------------------------------

test('Section 10 Case 19: Repository actions create zero provider token/cost entries; budget exhaustion denies transport', async () => {
  const context = createTestRepositoryAdmissionContextV02();
  const journal = createJournal(context);
  const claim = await journal.claim(context);
  const actor = createTestExecutorIdentityV02({ payloadDigest: context.actionDigest });
  const attempt = await journal.beginAttempt(claim.claimId, actor);
  const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context);
  await journal.recordOutcome(outcome);

  // Assert repository flow created ZERO token or cost entries / consumption
  const ledgers = journal.getLedgers();
  const providerLedgers = ledgers.filter((l) => l.kind === 'tokens' || l.kind === 'cost');
  for (const ledger of providerLedgers) {
    assert.equal(ledger.reservations.length, 0, 'Zero provider reservations created by repository action');
    assert.equal(ledger.consumed, 0, 'Zero provider consumed amount in repository action');
  }

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
  const controller = new MockDockerLifecycleController();
  const manager = new DockerWorkspaceManager({ controller });
  const profile = createValidProfile();
  const rev = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const ws = await manager.createWorkspace({
    taskId: 'task-gate-case20',
    workspaceId: 'ws-gate-case20',
    initialRevisionDigest: rev,
    profile,
  });

  controller.snapshotToReturn = {
    canonicalRevisionDigest: rev,
    entries: [createSnapshotEntry('src/app.py', 'print("hello")\n')],
  };

  // Acquire exclusive writer lease
  const writeLease = await manager.acquireWriteLease(ws.workspaceId, rev);
  assert.equal(manager.hasActiveWriterLease(ws.workspaceId), true);

  let viewCompleted = false;
  let competingWriteCompleted = false;

  const viewPromise = manager.admitCommandView({ workspaceId: ws.workspaceId }).then((v) => {
    viewCompleted = true;
    return v;
  });

  const competingWritePromise = manager.acquireWriteLease(ws.workspaceId, rev).then((l) => {
    competingWriteCompleted = true;
    return l;
  });

  // Both competing operations are blocked while writer lease is held
  assert.equal(viewCompleted, false);
  assert.equal(competingWriteCompleted, false);

  // Release lease after simulated settlement
  writeLease.release();
  assert.equal(manager.hasActiveWriterLease(ws.workspaceId), false);

  const [admittedView, competingLease] = await Promise.all([viewPromise, competingWritePromise]);
  assert.ok(admittedView);
  assert.ok(competingLease);
  assert.equal(viewCompleted, true);
  assert.equal(competingWriteCompleted, true);

  competingLease.release();
});

// ---------------------------------------------------------------------------
// Section 10 Case 21: Uncertain receipt vs final reconciliation (critical)
// ---------------------------------------------------------------------------

test('Section 10 Case 21: Conflicting outcome receipt cannot replace U; only reconcileUncertain finalizes; repeated reconciliation idempotent', async () => {
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
  const context = createTestRepositoryAdmissionContextV02();
  const port = createJournal(context);
  const repo = new FakeRepositoryPort({
    statePort: port,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: context.actionDigest }),
  });

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
  assert.equal(decision.zeroEffects, false);

  // 2. Effect boundary governance: executeGuardedAction executes patch on admitted context
  const adaptedStatePort = Object.assign(Object.create(port), { executionGuardApiVersion: '0.2.0' as const });
  const adaptedRepositoryPort = Object.assign(Object.create(repo), { executionGuardApiVersion: '0.2.0' as const });
  const guard = createExecutionGuardV02({
    ports: {
      statePort: adaptedStatePort,
      repositoryPort: adaptedRepositoryPort,
    },
  });
  const initialTaskState = createTestAdmissionTaskStateV02(context);

  const positiveResult = await cutoverSelector.executeGuardedAction({
    guard,
    action: context.action,
    taskState: initialTaskState,
    context,
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    statePort: port,
    repositoryPort: repo,
  });
  assert.equal(positiveResult.admitted, true);
  assert.equal((positiveResult.result as { outcome: string })?.outcome, 'success');
  assert.equal(repo.patches.length, 1);

  // 3. Negative vector: missing migration checkpoints rejects with zero dispatches
  const missingResult = await cutoverSelector.executeGuardedAction({
    guard,
    action: context.action,
    taskState: initialTaskState,
    context,
    checkpoints: ['T038'], // Missing other 12 checkpoints
    statePort: port,
    repositoryPort: repo,
  });
  assert.equal(missingResult.admitted, false);
  assert.equal(missingResult.decision.code, 'MISSING_MIGRATION_CHECKPOINTS');
  assert.equal(repo.patches.length, 1, 'No additional patch dispatch on missing checkpoints');

  // 4. Negative vector: legacy v0.1 context rejected with zero dispatches
  const legacyResult = await cutoverSelector.executeGuardedAction({
    guard,
    action: context.action,
    taskState: initialTaskState,
    context: { schemaVersion: '0.1.0' },
    checkpoints: REQUIRED_MIGRATION_CHECKPOINTS,
    statePort: port,
    repositoryPort: repo,
  });
  assert.equal(legacyResult.admitted, false);
  assert.equal(legacyResult.decision.code, 'LEGACY_V01_CONTEXT_REJECTED');
  assert.equal(repo.patches.length, 1, 'No additional patch dispatch on legacy context');

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
});
