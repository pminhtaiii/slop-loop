/**
 * Regression tests for post-renew task state transitions in `real-tier-owners.ts`:
 * moving out of `AwaitPlan` after `renew` (or during the reload window before
 * `observedPlan`) must yield a bounded non-sticky refusal and keep the service
 * instance open for subsequent valid approval operations, while genuine faults
 * such as revision drift still fail closed.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { ApprovalServiceError } from '../../../src/approvals/service.ts';
import {
  CONTRACT_VERSION,
  computeActionDigest,
  computeCanonicalSha256,
  computeCheckSetDigest,
  type ApprovalBinding,
  type BugTask,
  type FixPlan,
  type PolicyAuthorityRefV02,
  type RunCommandAction,
  type TaskState,
} from '../../../src/contracts/foundation/uc03.ts';
import type { TrustedOperatorIdentity } from '../../../src/contracts/approvals/contracts.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { createHostActionContext, type HostActionContext } from '../../../src/runtime/host-action-context.ts';
import { createRealTierOwners } from '../../../src/runtime/real-tier-owners.ts';
import { realTierPlanApproval } from '../../../src/runtime/real-tier-plan-approval.ts';
import { seedLedgers } from '../../../src/runtime/real-tier-task-seed.ts';

const TASK_ID = 'task-renew-race-1';
const WORKSPACE_ID = 'ws-renew-race-1';
const REPOSITORY_ID = 'repo-renew-race-1';
const RUN_ID = 'run-renew-race-1';
const PLAN_DECISION_ID = 'dec-plan-renew-1';
const VERIFY_DECISION_ID = 'dec-verify-renew-1';
const REVISION = 'a'.repeat(40);
const CONFIG_ID = 'config-renew-1';
const CONFIG_VERSION = '1.0.0';
const POLICY_IDENTITY = {
  policyId: 'uc05-local-v1',
  policyVersion: '1',
  configId: CONFIG_ID,
  configVersion: CONFIG_VERSION,
} as const;
const AUTHORITY_REF: PolicyAuthorityRefV02 = {
  ...POLICY_IDENTITY,
  issuerKeyRef: `host-${CONFIG_ID}`,
  decisionAuthorityGeneration: 1,
};
const OPERATOR: TrustedOperatorIdentity = {
  actorId: 'host-operator',
  channelRef: 'host-console',
  provenance: 'real',
};
const ALLOWED_COMMAND: RunCommandAction = {
  actionId: 'act-cmd-verify-1',
  kind: 'run_command',
  executable: 'pytest',
  argv: ['-q', 'tests/'],
  workingDirectory: '/workspace/repo',
};

function makeTask(initialRevisionDigest: string): BugTask {
  return {
    taskId: TASK_ID,
    repositoryId: REPOSITORY_ID,
    initialRevisionDigest,
    goal: 'Handle division by zero cleanly',
    observedBehavior: 'ZeroDivisionError on zero divisor',
    expectedBehavior: 'Raise ValueError on zero divisor',
    reproduction: 'pytest -q tests/test_calc.py',
    acceptanceCriteria: ['Raises ValueError on zero divisor'],
    constraints: [],
    requiredChecks: [
      {
        checkId: 'check-1',
        executable: 'pytest',
        argv: ['-q', 'tests/test_calc.py'],
        purpose: 'reproduction',
        workingDirectory: 'tests',
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
      },
    ],
    limits: { timeoutMs: 30_000, maxOutputBytes: 65_536, maxCpuCores: 1, maxMemoryBytes: 536_870_912, maxPids: 64 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 100_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: CONFIG_ID,
    configVersion: CONFIG_VERSION,
  };
}

function makeAwaitPlanState(task: BugTask, plan: FixPlan): TaskState {
  return {
    schemaVersion: CONTRACT_VERSION,
    stateVersion: 1,
    taskId: TASK_ID,
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    repositoryRevisionDigest: task.initialRevisionDigest,
    goal: task.goal,
    observedBehavior: task.observedBehavior,
    expectedBehavior: task.expectedBehavior,
    reproduction: task.reproduction,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: task.constraints,
    requiredCheckIds: task.requiredChecks.map(c => c.checkId),
    taskContext: task,
    node: 'AwaitPlan',
    planVersion: plan.planVersion,
    replanCount: 0,
    plan,
    activeDecisionId: PLAN_DECISION_ID,
    evidenceRefs: [...plan.evidenceRefs],
    changedPaths: [],
    risks: [],
    nextAction: 'await-plan-approval',
    budgetLedgers: seedLedgers(task),
  };
}

function makePlanBinding(task: BugTask, plan: FixPlan, decisionId: string): ApprovalBinding {
  const action = {
    actionId: decisionId,
    kind: 'approve_fix_plan' as const,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    diagnosisEvidenceRefs: plan.evidenceRefs,
    checkSetDigest: plan.checkSetDigest,
  };
  return {
    decisionId,
    actionKind: 'fix_plan',
    normalizedActionDigest: computeActionDigest(action),
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    repositoryRevisionDigest: task.initialRevisionDigest,
    policyId: POLICY_IDENTITY.policyId,
    policyVersion: POLICY_IDENTITY.policyVersion,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: [...plan.evidenceRefs],
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    status: 'pending',
  };
}

async function setupRenewRace(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'uc03-renew-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoDir = join(root, 'repo');
  const stateRoot = join(root, 'state');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  mkdirSync(join(repoDir, 'tests'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'calc.py'), 'def divide(a, b):\n    return a / b\n', 'utf8');
  writeFileSync(join(repoDir, 'tests', 'test_calc.py'), 'def test_ok():\n    pass\n', 'utf8');

  const filesystem = new WorkspaceFilesystemPort({ root: repoDir });
  const initialDigest = await filesystem.getCurrentRevisionDigest();
  const task = makeTask(initialDigest);
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'Unchecked zero divisor',
    suspectedCauseLocations: ['src/calc.py:1'],
    evidenceRefs: ['evidence-1'],
    strategy: 'Guard b == 0 and raise ValueError',
    scopedChanges: ['src/calc.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef: initialDigest,
    strategyDigest: computeCanonicalSha256('Guard b == 0 and raise ValueError'),
    decisionRef: PLAN_DECISION_ID,
  };

  let clock = 1_000;
  const baseSource = createHostActionContext({
    filesystem,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    policyIdentity: POLICY_IDENTITY,
    ttlMs: 100,
    now: () => clock,
  });

  let afterRenew: (() => Promise<void>) | undefined;
  let beforeReloadObserveReturn: (() => Promise<void>) | undefined;
  const sourceWrapper: HostActionContext = {
    provenance: 'real',
    register: reg => baseSource.register(reg),
    observe: async (tId, aId) => {
      const observed = await baseSource.observe(tId, aId);
      const hook = beforeReloadObserveReturn;
      beforeReloadObserveReturn = undefined;
      if (hook) await hook();
      return observed;
    },
    renew: async (tId, aId) => {
      const renewed = await baseSource.renew(tId, aId);
      const hook = afterRenew;
      afterRenew = undefined;
      if (hook) await hook();
      return renewed;
    },
  };

  const owners = createRealTierOwners({
    stateRoot,
    revision: REVISION,
    approvalProfileVersion: 'real-tier-2026-11-14',
    operator: OPERATOR,
  });
  const bound = owners.taskOwners({
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    policyIdentity: POLICY_IDENTITY,
    authorityRef: AUTHORITY_REF,
    createContext: () => sourceWrapper,
  });

  const awaitPlanState = makeAwaitPlanState(task, plan);
  await bound.statePort.transition(awaitPlanState, 0);
  const registerAllowedCommand = (): Promise<{ readonly actionId: string; readonly expiresAtEpochMs: number }> =>
    sourceWrapper.register({
      action: ALLOWED_COMMAND,
      facts: {
        taskId: TASK_ID,
        workspaceId: WORKSPACE_ID,
        repositoryId: REPOSITORY_ID,
        repositoryRevisionDigest: initialDigest,
        policyIdentity: POLICY_IDENTITY,
        registeredActionDigest: computeActionDigest(ALLOWED_COMMAND),
        continuationRef: 'cont-cmd-verify-1',
        role: 'coder',
        safety: {
          workspaceContained: true,
          protectedContentAbsent: true,
          hiddenGradingAbsent: true,
          policyBypassAbsent: true,
          testsPreserved: true,
          commandSourceWritesAbsent: true,
          isolated: true,
        },
        patch: null,
        command: {
          executableRef: 'pytest',
          resolvedExecutable: 'pytest',
          workingDirectoryRef: 'repository-root',
          workingDirectory: '/workspace/repo',
          constrainedCapability: null,
        },
        plan: null,
      },
      elements: {
        action: 'Run verification tests',
        necessity: 'Verify repair',
        targets: ['tests/test_calc.py'],
        consequences: 'Runs isolated verification command',
        verificationStatus: 'Pending execution',
      },
    });
  const planPort = realTierPlanApproval(bound);
  const planBinding = makePlanBinding(task, plan, PLAN_DECISION_ID);
  await planPort.requestDecision(planBinding);
  const initialView = await bound.approvalService.show(TASK_ID, PLAN_DECISION_ID);

  return {
    repoDir,
    task,
    plan,
    awaitPlanState,
    bound,
    planPort,
    initialView,
    registerAllowedCommand,
    setClock: (next: number) => {
      clock = next;
    },
    armAfterRenew: (hook: () => Promise<void>) => {
      afterRenew = hook;
    },
    armBeforeReloadObserveReturn: (hook: () => Promise<void>) => {
      beforeReloadObserveReturn = hook;
    },
  };
}

test('moving task out of AwaitPlan immediately after renew returns a bounded refusal without closing approval admission', async t => {
  const s = await setupRenewRace(t);
  s.setClock(1_150);

  let renewHookRan = false;
  s.armAfterRenew(async () => {
    renewHookRan = true;
    await s.bound.approvalService.decide({
      taskId: TASK_ID,
      decisionId: PLAN_DECISION_ID,
      taskVersion: s.initialView.control.version,
      requestVersion: s.initialView.presentation.requestVersion,
      presentationDigest: s.initialView.presentation.presentationDigest,
      decision: 'approve',
      responseKey: 'concurrent-approve-after-renew',
    });
    await s.bound.statePort.transition({ ...s.awaitPlanState, node: 'Patch', stateVersion: 2 }, 1);
  });

  await assert.rejects(
    s.bound.approvalService.show(TASK_ID, PLAN_DECISION_ID),
    (error: unknown) => error instanceof ApprovalServiceError && error.outcome !== 'unavailable' && error.outcome !== 'uncertain',
  );
  assert.equal(renewHookRan, true);

  // Subsequent operations on the same approvalService instance must still be admitted.
  await s.registerAllowedCommand();
  assert.equal(await s.bound.approvalService.classify(ALLOWED_COMMAND), 'ALLOWED');

  const patchState = await s.bound.statePort.loadTask(TASK_ID);
  assert.ok(patchState);
  await s.bound.statePort.transition({ ...patchState, node: 'Verify', activeDecisionId: undefined, stateVersion: patchState.stateVersion + 1 }, patchState.stateVersion);

  const verifyBinding = makePlanBinding(s.task, s.plan, VERIFY_DECISION_ID);
  await s.planPort.requestDecision(verifyBinding);
  const verifyView = await s.bound.approvalService.show(TASK_ID, VERIFY_DECISION_ID);
  assert.equal(verifyView.binding.decisionId, VERIFY_DECISION_ID);
  assert.equal(verifyView.binding.status, 'pending');
});

test('moving task out of AwaitPlan between post-renew reload and observedPlan keeps approval admission open', async t => {
  const s = await setupRenewRace(t);
  s.setClock(1_150);

  let observeHookRan = false;
  s.armAfterRenew(async () => {
    s.armBeforeReloadObserveReturn(async () => {
      observeHookRan = true;
      await s.bound.approvalService.decide({
        taskId: TASK_ID,
        decisionId: PLAN_DECISION_ID,
        taskVersion: s.initialView.control.version,
        requestVersion: s.initialView.presentation.requestVersion,
        presentationDigest: s.initialView.presentation.presentationDigest,
        decision: 'approve',
        responseKey: 'concurrent-approve-during-reload',
      });
      await s.bound.statePort.transition({ ...s.awaitPlanState, node: 'Patch', stateVersion: 2 }, 1);
    });
  });

  await assert.rejects(
    s.bound.approvalService.show(TASK_ID, PLAN_DECISION_ID),
    (error: unknown) => error instanceof ApprovalServiceError && error.outcome !== 'unavailable' && error.outcome !== 'uncertain',
  );
  assert.equal(observeHookRan, true);

  await s.registerAllowedCommand();
  assert.equal(await s.bound.approvalService.classify(ALLOWED_COMMAND), 'ALLOWED');

  const patchState = await s.bound.statePort.loadTask(TASK_ID);
  assert.ok(patchState);
  await s.bound.statePort.transition({ ...patchState, node: 'Verify', activeDecisionId: undefined, stateVersion: patchState.stateVersion + 1 }, patchState.stateVersion);

  const verifyBinding = makePlanBinding(s.task, s.plan, VERIFY_DECISION_ID);
  await s.planPort.requestDecision(verifyBinding);
  const verifyView = await s.bound.approvalService.show(TASK_ID, VERIFY_DECISION_ID);
  assert.equal(verifyView.binding.decisionId, VERIFY_DECISION_ID);
  assert.equal(verifyView.binding.status, 'pending');
});

test('genuine loader fault during renew such as revision drift still closes approval admission', async t => {
  const s = await setupRenewRace(t);
  s.setClock(1_150);
  writeFileSync(join(s.repoDir, 'src', 'calc.py'), 'def divide(a, b):\n    return a // b\n', 'utf8');

  await assert.rejects(s.bound.approvalService.show(TASK_ID, PLAN_DECISION_ID), (error: unknown) => error instanceof ApprovalServiceError && error.outcome === 'unavailable');

  await assert.rejects(s.bound.approvalService.classify(ALLOWED_COMMAND), (error: unknown) => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
});
