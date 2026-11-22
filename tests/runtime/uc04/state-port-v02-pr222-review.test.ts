import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { ApprovalBinding, PolicyAuthorityRefV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import type { TrustedOperatorIdentity } from '../../../src/contracts/approvals/contracts.ts';
import { atomicWrite, DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { DECISION_BINDINGS_FILE, bindIssuedDecision, readDecisionBindings } from '../../../src/persistence/adapters/state-port-v02-verification-records.ts';
import { seedTaskState, type SeededTaskIds } from '../../../src/runtime/real-tier-task-seed.ts';
import { createTestBugTask } from '../support/uc03/state-fixtures.ts';
import { decisionDir, taskDir } from '../../../src/persistence/adapters/approval-types.ts';

const baseTask = createTestBugTask({ taskId: 'task-pr222-1', repositoryId: 'repo-pr222-1' });
const TASK = {
  ...baseTask,
  requiredChecks: baseTask.requiredChecks.map(c => ({ ...c, timeoutMs: 1000, maxOutputBytes: 1000 })),
};
const IDS: SeededTaskIds = { taskId: TASK.taskId, runId: 'run-pr222-1', workspaceId: 'workspace-pr222-1' };
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

interface Fixture {
  readonly port: DurableStatePortV02;
  readonly store: DurableStore;
  readonly stateStore: StatePortStore;
  readonly approvals: string;
  readonly record: (decisionId: string, status: 'approved' | 'rejected' | 'pending') => void;
  readonly cleanup: () => void;
}

async function fixture(state: TaskState = awaitPlanState()): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'uc03-pr222-'));
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

test('PR222 A: atomicWrite resolves with new content on successful rename without stray temp files, and cleans up temp file on rename failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
  try {
    const targetFile = join(dir, 'target.txt');
    await atomicWrite(targetFile, 'initial content');
    assert.equal(readFileSync(targetFile, 'utf8'), 'initial content');

    await atomicWrite(targetFile, 'updated content');
    assert.equal(readFileSync(targetFile, 'utf8'), 'updated content');

    const tempFiles = readdirSync(dir).filter(f => f.startsWith('.tmp-'));
    assert.equal(tempFiles.length, 0, 'no stray temp files remain after successful writes');

    const subDir = join(dir, 'sub-dir');
    mkdirSync(subDir);
    await assert.rejects(() => atomicWrite(subDir, 'cannot overwrite dir'));
    const tempFilesAfterFailure = readdirSync(dir).filter(f => f.startsWith('.tmp-'));
    assert.equal(tempFilesAfterFailure.length, 0, 'temp file was cleaned up after rename failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PR222 B1: writeTask failure with rollback failure marks original error with recoveryRequired, taskId, and rollbackError', async () => {
  // Scenario 1: non-empty prior bindings, rollback writeJson fails
  {
    const f = await fixture(awaitPlanState());
    try {
      f.record(ORIGINAL, 'approved');
      const priorBinding = {
        decisionId: 'prior-dec-b1',
        issuerKeyRef: POLICY.issuerKeyRef,
        decisionAuthorityGeneration: POLICY.decisionAuthorityGeneration,
        bindingDigest: `sha256:${'e'.repeat(64)}`,
      };
      await bindIssuedDecision(f.stateStore, TASK.taskId, priorBinding);

      const current = await f.port.loadTask(TASK.taskId);
      assert.ok(current);
      const candidate: TaskState = {
        ...current,
        stateVersion: current.stateVersion + 1,
        node: 'Patch',
        nextAction: 'apply-patch',
      };

      const targetStore = (f.port as unknown as { statePort: StatePortStore }).statePort;
      const origWriteTask = targetStore.writeTask.bind(targetStore);
      const origWriteJson = targetStore.writeJson.bind(targetStore);
      const writeTaskErr = new Error('SIMULATED_WRITE_TASK_FAILURE_JSON');
      const rollbackErr = new Error('SIMULATED_ROLLBACK_JSON_FAILURE');

      targetStore.writeTask = async (taskId, task) => {
        if (task.node === 'Patch') throw writeTaskErr;
        return origWriteTask(taskId, task);
      };
      targetStore.writeJson = async (path, value) => {
        if (path.includes(DECISION_BINDINGS_FILE) && typeof value === 'object' && value !== null && 'decisions' in value) {
          const decisions = (value as { decisions: { decisionId: string }[] }).decisions;
          if (!decisions.some(d => d.decisionId === ORIGINAL)) {
            throw rollbackErr;
          }
        }
        return origWriteJson(path, value);
      };

      let caught: unknown;
      try {
        await f.port.transition(candidate, current.stateVersion);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.equal(caught, writeTaskErr);
      assert.equal((caught as { recoveryRequired?: boolean }).recoveryRequired, true);
      assert.equal((caught as { taskId?: string }).taskId, TASK.taskId);
      assert.equal((caught as { rollbackError?: unknown }).rollbackError, rollbackErr);
      assert.ok((caught as Error).message.startsWith('PATCH_RECOVERY_REQUIRED:'));
      assert.ok((caught as Error).message.includes('SIMULATED_WRITE_TASK_FAILURE_JSON'));
    } finally {
      f.cleanup();
    }
  }

  // Scenario 2: empty prior bindings, rollback rm fails and propagates
  {
    const f = await fixture(awaitPlanState());
    try {
      f.record(ORIGINAL, 'approved');
      const current = await f.port.loadTask(TASK.taskId);
      assert.ok(current);
      const candidate: TaskState = {
        ...current,
        stateVersion: current.stateVersion + 1,
        node: 'Patch',
        nextAction: 'apply-patch',
      };

      const targetStore = (f.port as unknown as { statePort: StatePortStore }).statePort;
      const origWriteTask = targetStore.writeTask.bind(targetStore);
      const writeTaskErr = new Error('SIMULATED_WRITE_TASK_FAILURE_RM');

      targetStore.writeTask = async (taskId, task) => {
        if (task.node === 'Patch') {
          const bindingsPath = targetStore.statePath(taskId, DECISION_BINDINGS_FILE);
          rmSync(bindingsPath, { force: true });
          mkdirSync(bindingsPath);
          throw writeTaskErr;
        }
        return origWriteTask(taskId, task);
      };

      let caught: unknown;
      try {
        await f.port.transition(candidate, current.stateVersion);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.equal(caught, writeTaskErr);
      assert.equal((caught as { recoveryRequired?: boolean }).recoveryRequired, true);
      assert.equal((caught as { taskId?: string }).taskId, TASK.taskId);
      assert.ok((caught as { rollbackError?: unknown }).rollbackError instanceof Error);
      assert.ok((caught as Error).message.startsWith('PATCH_RECOVERY_REQUIRED:'));
      assert.ok((caught as Error).message.includes('SIMULATED_WRITE_TASK_FAILURE_RM'));
    } finally {
      f.cleanup();
    }
  }
});

test('PR222 B2: writeTask failure with rollback success rethrows original error without recoveryRequired and restores bindings', async () => {
  const f = await fixture(awaitPlanState());
  try {
    f.record(ORIGINAL, 'approved');
    const priorBinding = {
      decisionId: 'prior-dec-b2',
      issuerKeyRef: POLICY.issuerKeyRef,
      decisionAuthorityGeneration: POLICY.decisionAuthorityGeneration,
      bindingDigest: `sha256:${'f'.repeat(64)}`,
    };
    await bindIssuedDecision(f.stateStore, TASK.taskId, priorBinding);

    const current = await f.port.loadTask(TASK.taskId);
    assert.ok(current);
    const candidate: TaskState = {
      ...current,
      stateVersion: current.stateVersion + 1,
      node: 'Patch',
      nextAction: 'apply-patch',
    };

    const targetStore = (f.port as unknown as { statePort: StatePortStore }).statePort;
    const origWriteTask = targetStore.writeTask.bind(targetStore);
    const writeTaskErr = new Error('SIMULATED_WRITE_TASK_FAILURE_B2');

    targetStore.writeTask = async (taskId, task) => {
      if (task.node === 'Patch') throw writeTaskErr;
      return origWriteTask(taskId, task);
    };

    let caught: unknown;
    try {
      await f.port.transition(candidate, current.stateVersion);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught, writeTaskErr);
    assert.equal((caught as { recoveryRequired?: boolean }).recoveryRequired, undefined);
    assert.equal((caught as { rollbackError?: unknown }).rollbackError, undefined);
    assert.equal((caught as Error).message, 'SIMULATED_WRITE_TASK_FAILURE_B2');
    assert.equal((caught as Error).message.startsWith('PATCH_RECOVERY_REQUIRED:'), false);

    const bindings = readDecisionBindings(targetStore, TASK.taskId);
    assert.ok(bindings);
    assert.equal(bindings.size, 1);
    assert.ok(bindings.has('prior-dec-b2'));
    assert.equal(bindings.has(ORIGINAL), false);
  } finally {
    f.cleanup();
  }
});
