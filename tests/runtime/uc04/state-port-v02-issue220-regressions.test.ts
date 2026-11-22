/**
 * Regression tests for GitHub issue #220 (state-port and verification-authority failure windows):
 * - Item 1: deriving trusted plan approval is read-only; binding is persisted only on accepted AwaitPlan->Patch transition
 * - Item 2: approved rebind and control-version advance one recoverable unit; retry finishes control write, replay doesn't advance
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest, expectedVerificationRequestIdentityV02 } from '../../../src/contracts/foundation/uc03.ts';
import type { ApprovalBinding, PolicyAuthorityRefV02, RecordVerificationApprovalRequestV02, TaskState, VerificationApprovalContextV02 } from '../../../src/contracts/foundation/uc03.ts';
import type { TrustedOperatorIdentity } from '../../../src/contracts/approvals/contracts.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { DECISION_BINDINGS_FILE } from '../../../src/persistence/adapters/state-port-v02-verification-records.ts';
import { seedTaskState, type SeededTaskIds } from '../../../src/runtime/real-tier-task-seed.ts';
import { createTestBugTask } from '../support/uc03/state-fixtures.ts';
import { decisionDir, taskDir } from '../../../src/persistence/adapters/approval-types.ts';

const baseTask = createTestBugTask({ taskId: 'task-issue220-1', repositoryId: 'repo-issue220-1' });
const TASK = {
  ...baseTask,
  requiredChecks: baseTask.requiredChecks.map(c => ({ ...c, timeoutMs: 1000, maxOutputBytes: 1000 })),
};
const IDS: SeededTaskIds = { taskId: TASK.taskId, runId: 'run-issue220-1', workspaceId: 'workspace-issue220-1' };
const REVISION = TASK.initialRevisionDigest;
const POLICY: PolicyAuthorityRefV02 = {
  policyId: TASK.configId,
  policyVersion: TASK.configVersion,
  configId: TASK.configId,
  configVersion: TASK.configVersion,
  issuerKeyRef: `host-${TASK.configId}`,
  decisionAuthorityGeneration: 3,
};
const OPERATOR: TrustedOperatorIdentity = { actorId: 'host-operator', channelRef: 'host-console', provenance: 'real' };
const BASELINE_REF = `uc04-baseline://${'a'.repeat(64)}`;
const ORIGINAL = `dec-plan-${'c'.repeat(64)}`;
const STRATEGY = 'Guard the zero denominator';
const STRATEGY_DIGEST = computeCanonicalSha256(STRATEGY);
const CHECK_SET_DIGEST = computeCheckSetDigest(TASK.requiredChecks);
const CRITERIA_DIGEST = computeCanonicalSha256(TASK.acceptanceCriteria);
const NORMALIZED_ACTION_DIGEST = computeCanonicalSha256({
  actionId: ORIGINAL,
  kind: 'approve_fix_plan',
  planVersion: 1,
  strategyDigest: STRATEGY_DIGEST,
  diagnosisEvidenceRefs: [BASELINE_REF],
  checkSetDigest: CHECK_SET_DIGEST,
});

const PLAN = {
  planVersion: 1,
  diagnosis: 'The denominator is unchecked',
  suspectedCauseLocations: ['src/calculator.py'],
  evidenceRefs: [BASELINE_REF],
  strategy: STRATEGY,
  scopedChanges: ['src/calculator.py'],
  checkSetDigest: CHECK_SET_DIGEST,
  baselineRef: BASELINE_REF,
  strategyDigest: STRATEGY_DIGEST,
  decisionRef: ORIGINAL,
} as const;

const PLAN_MATERIAL_DIGEST = computeCanonicalSha256({
  taskId: TASK.taskId,
  planVersion: 1,
  diagnosis: PLAN.diagnosis,
  suspectedCauseLocations: PLAN.suspectedCauseLocations,
  evidenceRefs: PLAN.evidenceRefs,
  strategy: PLAN.strategy,
  scopedChanges: PLAN.scopedChanges,
  checkSetDigest: CHECK_SET_DIGEST,
  baselineRef: BASELINE_REF,
  strategyDigest: STRATEGY_DIGEST,
  criteriaDigest: CRITERIA_DIGEST,
});

function awaitPlanState(): TaskState {
  const seeded = seedTaskState(TASK, IDS);
  return {
    ...seeded,
    stateVersion: 6,
    node: 'AwaitPlan',
    planVersion: 1,
    plan: { ...PLAN },
    evidenceRefs: [BASELINE_REF],
    approvalDecisionRefs: [ORIGINAL],
    activeDecisionId: ORIGINAL,
    nextAction: 'await-plan-approval',
  };
}

function verifyState(): TaskState {
  const seeded = seedTaskState(TASK, IDS);
  return {
    ...seeded,
    stateVersion: 7,
    node: 'Verify',
    planVersion: 1,
    plan: { ...PLAN },
    evidenceRefs: [BASELINE_REF],
    approvalDecisionRefs: [ORIGINAL],
    activeDecisionId: undefined,
    nextAction: 'verify-patch',
  };
}

function binding(status: ApprovalBinding['status'], decisionId = ORIGINAL): ApprovalBinding {
  const actionDigest =
    decisionId === ORIGINAL
      ? NORMALIZED_ACTION_DIGEST
      : computeCanonicalSha256({
          actionId: decisionId,
          kind: 'approve_fix_plan',
          planVersion: 1,
          strategyDigest: STRATEGY_DIGEST,
          diagnosisEvidenceRefs: [BASELINE_REF],
          checkSetDigest: CHECK_SET_DIGEST,
        });
  return {
    decisionId,
    actionKind: 'fix_plan',
    normalizedActionDigest: actionDigest,
    taskId: TASK.taskId,
    workspaceId: IDS.workspaceId,
    repositoryRevisionDigest: REVISION,
    policyId: POLICY.policyId,
    policyVersion: POLICY.policyVersion,
    planVersion: 1,
    strategyDigest: STRATEGY_DIGEST,
    baselineRef: BASELINE_REF,
    evidenceRefs: [BASELINE_REF],
    criteriaDigest: CRITERIA_DIGEST,
    checkSetDigest: CHECK_SET_DIGEST,
    status,
  };
}

function contextOf(decisionId = ORIGINAL): VerificationApprovalContextV02 {
  return {
    purpose: 'current-verification',
    expectedIssuerKeyRef: POLICY.issuerKeyRef,
    expectedDecisionAuthorityGeneration: POLICY.decisionAuthorityGeneration,
    approvalContext: {
      currentTaskId: TASK.taskId,
      currentWorkspaceId: IDS.workspaceId,
      currentRepositoryRevisionDigest: REVISION,
      currentPolicyId: POLICY.policyId,
      currentPolicyVersion: POLICY.policyVersion,
      currentNormalizedActionDigest: binding('approved', decisionId).normalizedActionDigest,
      currentPlanVersion: 1,
      currentStrategyDigest: STRATEGY_DIGEST,
      currentBaselineRef: BASELINE_REF,
      currentEvidenceRefs: [BASELINE_REF],
      currentCriteriaDigest: CRITERIA_DIGEST,
      currentCheckSetDigest: CHECK_SET_DIGEST,
    },
  };
}

interface Fixture {
  readonly port: DurableStatePortV02;
  readonly store: DurableStore;
  readonly stateStore: StatePortStore;
  readonly approvals: string;
  readonly record: (decisionId: string, status: 'approved' | 'rejected' | 'pending') => void;
  readonly cleanup: () => void;
}

async function fixture(state: TaskState = awaitPlanState()): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'uc03-issue220-'));
  const approvals = join(base, 'approvals');
  const store = new DurableStore(join(base, 'store'));
  const port = new DurableStatePortV02({
    store,
    taskId: TASK.taskId,
    approvalStorageDir: approvals,
    trustedOperator: OPERATOR,
    initialControl: { controlVersion: 2, epoch: 1, mode: 'runnable', activeAuthorityRef: POLICY },
  });
  const stateStore = new StatePortStore(store);
  await stateStore.writeTask(TASK.taskId, state);
  await stateStore.writeControl(TASK.taskId, {
    controlVersion: 2,
    epoch: 1,
    mode: 'runnable',
    holdRef: null,
    holdEventDigest: null,
    activeAuthorityRef: POLICY,
    activeClaimId: null,
  });

  const record = (decisionId: string, status: 'approved' | 'rejected' | 'pending'): void => {
    const dir = decisionDir(approvals, decisionId);
    mkdirSync(dir, { recursive: true });
    const request = {
      schemaVersion: 'uc05-approval/0.1-draft',
      decisionId,
      binding: binding('pending', decisionId),
      taskId: TASK.taskId,
      repositoryId: TASK.repositoryId,
      workspaceId: IDS.workspaceId,
      createdRunId: IDS.runId,
      continuationRef: ORIGINAL,
      requestVersion: 1,
      policyId: POLICY.policyId,
      policyVersion: POLICY.policyVersion,
      configId: POLICY.configId,
      configVersion: POLICY.configVersion,
      actionRef: decisionId,
      actionDigest: binding('pending', decisionId).normalizedActionDigest,
      presentationDigest: `sha256:${'d'.repeat(64)}`,
      createdAt: new Date(0).toISOString(),
      submissionKey: decisionId,
    };
    writeFileSync(join(dir, 'request.json'), JSON.stringify(request));
    const historyDir = taskDir(approvals, TASK.taskId);
    mkdirSync(historyDir, { recursive: true });
    if (status === 'pending') {
      writeFileSync(join(historyDir, 'history.json'), JSON.stringify({ resolutions: [] }));
      writeFileSync(join(historyDir, 'events.json'), JSON.stringify([]));
      return;
    }
    const decidedAt = new Date(0).toISOString();
    const resolution = {
      schemaVersion: 'uc05-approval/0.1-draft',
      decisionId,
      responseKey: `key-${decisionId}`,
      expectedRequestVersion: 1,
      operatorChannelRef: 'host-console',
      decision: status,
      safeReasonCode: status === 'approved' ? 'developer-approved' : 'developer-rejected',
      decidedAt,
      eventId: `evt-${decisionId}`,
    };
    const event = {
      schemaVersion: 'uc05-approval/0.1-draft',
      eventId: resolution.eventId,
      taskId: TASK.taskId,
      runId: IDS.runId,
      decisionId,
      directionId: null,
      claimId: null,
      type: 'human-resolution-recorded',
      outcome: status === 'approved' ? 'ok' : 'paused',
      policyRef: { policyId: POLICY.policyId, policyVersion: POLICY.policyVersion, configId: POLICY.configId, configVersion: POLICY.configVersion },
      safeReasonCode: resolution.safeReasonCode,
      timestamp: decidedAt,
    };
    writeFileSync(join(historyDir, 'history.json'), JSON.stringify({ resolutions: [resolution] }));
    writeFileSync(join(historyDir, 'events.json'), JSON.stringify([event]));
  };

  const cleanup = (): void => {
    rmSync(base, { recursive: true, force: true });
  };

  return { port, store, stateStore, approvals, record, cleanup };
}

function verificationRequest(): { readonly request: RecordVerificationApprovalRequestV02; readonly decisionId: string } {
  const policyIdentity = { policyId: POLICY.policyId, policyVersion: POLICY.policyVersion, configId: POLICY.configId, configVersion: POLICY.configVersion, issuerKeyRef: POLICY.issuerKeyRef };
  const requestIdentity = expectedVerificationRequestIdentityV02({
    taskId: TASK.taskId,
    runId: IDS.runId,
    originalDecisionId: ORIGINAL,
    expectedPlanMaterialDigest: PLAN_MATERIAL_DIGEST,
    expectedRepositoryRevisionDigest: REVISION,
    policyIdentity,
  });
  const decisionId = `dec-verify-${requestIdentity.slice('sha256:'.length)}`;
  const request: RecordVerificationApprovalRequestV02 = {
    taskId: TASK.taskId,
    runId: IDS.runId,
    workspaceId: IDS.workspaceId,
    repositoryId: TASK.repositoryId,
    originalDecisionId: ORIGINAL,
    decisionId,
    expectedStateVersion: 7,
    expectedRepositoryRevisionDigest: REVISION,
    expectedPlanVersion: 1,
    expectedPlanMaterialDigest: PLAN_MATERIAL_DIGEST,
    expectedControlVersion: 2,
    expectedEpoch: 1,
    expectedDecisionAuthorityGeneration: POLICY.decisionAuthorityGeneration,
    policyIdentity,
    requestIdentity,
  };
  return { request, decisionId };
}

/* ---------------- Item 1 Tests ---------------- */

test('Item 1: trustedPlanApproval is read-only and does not consume decision', async () => {
  const f = await fixture(awaitPlanState());
  try {
    f.record(ORIGINAL, 'approved');
    const approval = await f.port.trustedPlanApproval(TASK.taskId);
    assert.ok(approval, 'trustedPlanApproval should return approval facts');
    const bindingsPath = f.stateStore.statePath(TASK.taskId, DECISION_BINDINGS_FILE);
    assert.equal(existsSync(bindingsPath), false, 'decision bindings file must not be created by read-only derivation');
    assert.equal(f.port.readIssuedDecisionBinding(TASK.taskId, ORIGINAL), null, 'decision remains unconsumed');
  } finally {
    f.cleanup();
  }
});

test('Item 1: transition rejected by validateStateTransition leaves decision unconsumed', async () => {
  const f = await fixture(awaitPlanState());
  try {
    f.record(ORIGINAL, 'approved');
    const current = await f.port.loadTask(TASK.taskId);
    assert.ok(current);
    // Invalid candidate: different workspaceId
    const invalidCandidate: TaskState = {
      ...current,
      stateVersion: current.stateVersion + 1,
      workspaceId: 'foreign-workspace-id',
      node: 'Patch',
      nextAction: 'apply-patch',
    };
    await assert.rejects(() => f.port.transition(invalidCandidate, current.stateVersion), /State transition validation failed/);
    // Persisted task must be unchanged
    const after = await f.port.loadTask(TASK.taskId);
    assert.equal(after?.node, 'AwaitPlan');
    assert.equal(after?.stateVersion, 6);
    // Binding must not exist
    const bindingsPath = f.stateStore.statePath(TASK.taskId, DECISION_BINDINGS_FILE);
    assert.equal(existsSync(bindingsPath), false, 'binding must not be persisted on rejected transition');
    assert.equal(f.port.readIssuedDecisionBinding(TASK.taskId, ORIGINAL), null, 'decision remains unconsumed');
  } finally {
    f.cleanup();
  }
});

test('Item 1: accepted AwaitPlan->Patch transition persists binding and makes Patch admission succeed', async () => {
  const f = await fixture(awaitPlanState());
  try {
    f.record(ORIGINAL, 'approved');
    const current = await f.port.loadTask(TASK.taskId);
    assert.ok(current);
    const validCandidate: TaskState = {
      ...current,
      stateVersion: current.stateVersion + 1,
      node: 'Patch',
      nextAction: 'apply-patch',
    };
    const saved = await f.port.transition(validCandidate, current.stateVersion);
    assert.equal(saved.node, 'Patch');
    assert.equal(saved.stateVersion, 7);

    // Binding must now be persisted
    const issued = f.port.readIssuedDecisionBinding(TASK.taskId, ORIGINAL);
    assert.ok(issued, 'issued binding must be persisted after accepted transition');
    assert.equal(issued.decisionId, ORIGINAL);
    assert.equal(issued.decisionAuthorityGeneration, POLICY.decisionAuthorityGeneration);
    assert.equal(issued.issuerKeyRef, POLICY.issuerKeyRef);

    // planDecisionIsApproved must now find the issued binding
    const isApproved = await f.port.planDecisionIsApproved(ORIGINAL, contextOf(ORIGINAL));
    assert.equal(isApproved, true, 'Patch admission can read the issued binding');
  } finally {
    f.cleanup();
  }
});

test('Item 1: failure during writeTask rolls back the persisted decision binding', async () => {
  const f = await fixture(awaitPlanState());
  try {
    f.record(ORIGINAL, 'approved');
    const current = await f.port.loadTask(TASK.taskId);
    assert.ok(current);

    // Simulate writeTask failure after binding write
    const origWriteTask = StatePortStore.prototype.writeTask;
    StatePortStore.prototype.writeTask = async function (this: StatePortStore, taskId: string, task: TaskState) {
      if (task.node === 'Patch') throw new Error('SIMULATED_TASK_WRITE_FAILURE');
      return origWriteTask.call(this, taskId, task);
    };

    const candidate: TaskState = {
      ...current,
      stateVersion: current.stateVersion + 1,
      node: 'Patch',
      nextAction: 'apply-patch',
    };
    try {
      await assert.rejects(() => f.port.transition(candidate, current.stateVersion), /SIMULATED_TASK_WRITE_FAILURE/);
    } finally {
      StatePortStore.prototype.writeTask = origWriteTask;
    }

    // Binding must be rolled back!
    const bindingsPath = f.stateStore.statePath(TASK.taskId, DECISION_BINDINGS_FILE);
    assert.equal(existsSync(bindingsPath), false, 'binding must be rolled back on writeTask failure');
    assert.equal(f.port.readIssuedDecisionBinding(TASK.taskId, ORIGINAL), null);
  } finally {
    f.cleanup();
  }
});

/* ---------------- Item 2 Tests ---------------- */

test('Item 2: approved rebind where control write fails is recovered on exact retry without double-increment', async () => {
  const f = await fixture(verifyState());
  try {
    const { request, decisionId } = verificationRequest();
    f.record(decisionId, 'approved');

    // Simulate writeControl failure on the first attempt
    let controlWrites = 0;
    const origWriteControl = StatePortStore.prototype.writeControl;
    StatePortStore.prototype.writeControl = async function (this: StatePortStore, taskId: string, ctrl) {
      controlWrites += 1;
      if (controlWrites === 1) throw new Error('SIMULATED_CONTROL_WRITE_FAILURE');
      return origWriteControl.call(this, taskId, ctrl);
    };

    try {
      // First attempt fails at writeControl after writeTask succeeds
      await assert.rejects(() => f.port.recordVerificationApproval(request), /SIMULATED_CONTROL_WRITE_FAILURE/);
    } finally {
      StatePortStore.prototype.writeControl = origWriteControl;
    }

    // Task is at version 8, but control is still at version 2
    const taskAfterFail = await f.port.loadTask(TASK.taskId);
    assert.equal(taskAfterFail?.stateVersion, 8);
    assert.equal(taskAfterFail?.activeDecisionId, decisionId);
    const controlAfterFail = await f.stateStore.readControl(TASK.taskId, f.port.controlSeed);
    assert.equal(controlAfterFail.controlVersion, 2, 'control version was not advanced yet');

    // Retry the exact same request: must recover the missing control write!
    const retryResult = await f.port.recordVerificationApproval(request);
    assert.equal(retryResult.outcome, 'approved');
    assert.equal(retryResult.controlVersion, 3, 'control version advanced to 3');

    const controlAfterRetry = await f.stateStore.readControl(TASK.taskId, f.port.controlSeed);
    assert.equal(controlAfterRetry.controlVersion, 3, 'persisted control version is 3');

    // Replay when both landed: must not increment either version again!
    const replayResult = await f.port.recordVerificationApproval(request);
    assert.equal(replayResult.outcome, 'approved');
    assert.equal(replayResult.controlVersion, 3, 'replay returns control version 3');

    const controlAfterReplay = await f.stateStore.readControl(TASK.taskId, f.port.controlSeed);
    assert.equal(controlAfterReplay.controlVersion, 3, 'control version must not advance again');
    const taskAfterReplay = await f.port.loadTask(TASK.taskId);
    assert.equal(taskAfterReplay?.stateVersion, 8, 'task state version must not advance again');
  } finally {
    f.cleanup();
  }
});
