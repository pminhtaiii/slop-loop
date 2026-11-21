/**
 * Regression tests for CodeRabbit PR #218 findings:
 * - 4652881403: verification authority reads control head using port controlSeed fallback when not persisted
 * - 4652881400: verification-decisions.json distinguishes missing from invalid (malformed or null) and fails closed without overwriting
 * - 4652881385: trustedPlanApproval and resolveDecision refuse when request policy identity differs from current authority
 * - 4652881391: recordVerificationApproval replay path checks persisted issuance generation and refuses after generation bump
 * - 4652881411: approvedPlanCoderAdmission refuses plan decision whose recorded approval generation differs from current authority generation
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest, expectedVerificationRequestIdentityV02 } from '../../../src/contracts/foundation/uc03.ts';
import type {
  ApprovalBinding,
  CompleteApprovalBindingContextV02,
  PolicyAuthorityRefV02,
  RecordVerificationApprovalRequestV02,
  TaskState,
  VerificationApprovalContextV02,
} from '../../../src/contracts/foundation/uc03.ts';
import type { TrustedOperatorIdentity } from '../../../src/contracts/approvals/contracts.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { decisionDir, taskDir } from '../../../src/persistence/adapters/approval-types.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import { bindIssuedDecision, readDecisionBindings } from '../../../src/persistence/adapters/state-port-v02-verification-records.ts';
import { approvedPlanCoderAdmission } from '../../../src/runtime/real-tier-coder-admission.ts';
import type { RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { seedTaskState, type SeededTaskIds } from '../../../src/runtime/real-tier-task-seed.ts';
import { createTestBugTask } from '../support/uc03/state-fixtures.ts';

const baseTask = createTestBugTask({ taskId: 'task-verify-reg-1', repositoryId: 'repo-verify-reg-1' });
const TASK = {
  ...baseTask,
  requiredChecks: baseTask.requiredChecks.map(c => ({ ...c, timeoutMs: 1000, maxOutputBytes: 1000 })),
};
const IDS: SeededTaskIds = { taskId: TASK.taskId, runId: 'run-verify-reg-1', workspaceId: 'workspace-verify-reg-1' };
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

function awaitPlanState(): TaskState {
  return { ...verifyState(), stateVersion: 6, node: 'AwaitPlan', activeDecisionId: ORIGINAL, nextAction: 'await-plan-approval' };
}

function patchState(): TaskState {
  return {
    ...verifyState(),
    stateVersion: 7,
    node: 'Patch',
    activeDecisionId: ORIGINAL,
    budgetLedgers: [
      {
        scope: 'task',
        kind: 'cost',
        limit: 10,
        consumed: 0,
        reservations: [],
        unit: 'USD',
        configurationId: 'config-uc03-v1',
        version: 1,
      },
    ],
  };
}

function binding(status: ApprovalBinding['status'], decisionId = ORIGINAL): ApprovalBinding {
  const normalizedActionDigest =
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
    normalizedActionDigest,
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

function freshness(decisionId = ORIGINAL): CompleteApprovalBindingContextV02 {
  return {
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
  };
}

function contextOf(decisionId = ORIGINAL): VerificationApprovalContextV02 {
  return {
    purpose: 'current-verification',
    expectedIssuerKeyRef: POLICY.issuerKeyRef,
    expectedDecisionAuthorityGeneration: POLICY.decisionAuthorityGeneration,
    approvalContext: freshness(decisionId),
  };
}

interface Fixture {
  readonly port: DurableStatePortV02;
  readonly store: DurableStore;
  readonly approvals: string;
  readonly stateStore: StatePortStore;
  readonly record: (decisionId: string, status: 'approved' | 'pending' | 'rejected', overrides?: { policyId?: string; policyVersion?: string; configId?: string; configVersion?: string }) => void;
}

async function fixture(state: TaskState = verifyState(), persistControl = true): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'va-reg-'));
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
  if (persistControl) {
    await stateStore.writeControl(TASK.taskId, { controlVersion: 2, epoch: 1, mode: 'runnable', holdRef: null, holdEventDigest: null, activeAuthorityRef: POLICY, activeClaimId: null });
  }
  return {
    port,
    store,
    approvals,
    stateStore,
    record(decisionId, status, overrides = {}) {
      const dir = decisionDir(approvals, decisionId);
      mkdirSync(dir, { recursive: true });
      const policyId = overrides.policyId ?? POLICY.policyId;
      const policyVersion = overrides.policyVersion ?? POLICY.policyVersion;
      const configId = overrides.configId ?? POLICY.configId;
      const configVersion = overrides.configVersion ?? POLICY.configVersion;
      const reqBinding = { ...binding('pending', decisionId), policyId, policyVersion };
      const request = {
        schemaVersion: 'uc05-approval/0.1-draft',
        decisionId,
        binding: reqBinding,
        taskId: TASK.taskId,
        repositoryId: TASK.repositoryId,
        workspaceId: IDS.workspaceId,
        createdRunId: IDS.runId,
        continuationRef: ORIGINAL,
        requestVersion: 1,
        policyId,
        policyVersion,
        configId,
        configVersion,
        actionRef: decisionId,
        actionDigest: reqBinding.normalizedActionDigest,
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
        policyRef: { policyId, policyVersion, configId, configVersion },
        safeReasonCode: resolution.safeReasonCode,
        timestamp: decidedAt,
      };
      writeFileSync(join(historyDir, 'history.json'), JSON.stringify({ resolutions: [resolution] }));
      writeFileSync(join(historyDir, 'events.json'), JSON.stringify([event]));
    },
  };
}

// ---------------------------------------------------------------------------
// 1. (4652881403) verification-authority read of control head falls back to controlSeed
// ---------------------------------------------------------------------------
test('regression (4652881403): verification authority reads control head using port controlSeed fallback when not persisted', async () => {
  const f = await fixture(awaitPlanState(), false);
  f.record(ORIGINAL, 'approved');

  const planApproval = await f.port.trustedPlanApproval(TASK.taskId);
  assert.ok(planApproval, 'trustedPlanApproval should succeed using controlSeed fallback');

  const decisionApproved = await f.port.planDecisionIsApproved(ORIGINAL, contextOf(ORIGINAL));
  assert.equal(decisionApproved, true, 'planDecisionIsApproved should succeed using controlSeed fallback');
});

// ---------------------------------------------------------------------------
// 2. (4652881400) Distinguish missing verification-decisions.json from invalid/malformed/null
// ---------------------------------------------------------------------------
test('regression (4652881400): verification-decisions.json distinguishes missing from invalid (malformed or null) and fails closed without overwriting', async () => {
  const f = await fixture(verifyState());
  const filePath = f.stateStore.statePath(TASK.taskId, 'verification-decisions.json');

  const initialBindings = readDecisionBindings(f.stateStore, TASK.taskId);
  assert.ok(initialBindings instanceof Map && initialBindings.size === 0, 'Missing file returns empty Map');

  writeFileSync(filePath, '{ not valid json');
  const malformedBindings = readDecisionBindings(f.stateStore, TASK.taskId);
  assert.equal(malformedBindings, null, 'Malformed JSON must return null (fail closed)');

  const bindAttempt1 = await bindIssuedDecision(f.stateStore, TASK.taskId, {
    decisionId: 'dec-test-1',
    issuerKeyRef: POLICY.issuerKeyRef,
    decisionAuthorityGeneration: POLICY.decisionAuthorityGeneration,
    bindingDigest: computeCanonicalSha256({ test: 1 }),
  });
  assert.equal(bindAttempt1, false, 'bindIssuedDecision must refuse when file is malformed');
  assert.equal(readFileSync(filePath, 'utf8'), '{ not valid json', 'Malformed file must not be overwritten');

  writeFileSync(filePath, 'null');
  const nullBindings = readDecisionBindings(f.stateStore, TASK.taskId);
  assert.equal(nullBindings, null, 'Parsed null must return null (fail closed)');

  const bindAttempt2 = await bindIssuedDecision(f.stateStore, TASK.taskId, {
    decisionId: 'dec-test-2',
    issuerKeyRef: POLICY.issuerKeyRef,
    decisionAuthorityGeneration: POLICY.decisionAuthorityGeneration,
    bindingDigest: computeCanonicalSha256({ test: 2 }),
  });
  assert.equal(bindAttempt2, false, 'bindIssuedDecision must refuse when file contains null');
  assert.equal(readFileSync(filePath, 'utf8'), 'null', 'Null file must not be overwritten');
});

// ---------------------------------------------------------------------------
// 3. (4652881385) Request policy identity compared with current authority before first issuance
// ---------------------------------------------------------------------------
test('regression (4652881385): trustedPlanApproval and resolveDecision refuse when request policy identity differs from current authority', async () => {
  const f = await fixture(awaitPlanState());
  f.record(ORIGINAL, 'approved', { configVersion: 'v0-outdated-config' });

  const planApproval = await f.port.trustedPlanApproval(TASK.taskId);
  assert.equal(planApproval, undefined, 'trustedPlanApproval must refuse when request configVersion differs from authority');

  const resolution = await f.port.resolvePlanDecisionInContext(ORIGINAL, contextOf(ORIGINAL));
  assert.notEqual(resolution.outcome, 'resolved', 'resolvePlanDecisionInContext must refuse mismatched configVersion');
  assert.equal(resolution.outcome, 'stale');
});

// ---------------------------------------------------------------------------
// 4. (4652881391) Replay path checks persisted issuance generation against current authority
// ---------------------------------------------------------------------------
test('regression (4652881391): recordVerificationApproval replay path checks persisted issuance generation and refuses after generation bump', async () => {
  const f = await fixture(verifyState());
  const policyIdentity = {
    policyId: POLICY.policyId,
    policyVersion: POLICY.policyVersion,
    configId: POLICY.configId,
    configVersion: POLICY.configVersion,
    issuerKeyRef: POLICY.issuerKeyRef,
  };
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
  f.record(decisionId, 'approved');

  const firstResult = await f.port.recordVerificationApproval(request);
  assert.equal(firstResult.outcome, 'approved');
  assert.equal(firstResult.decisionAuthorityGeneration, 3);

  const replayResult = await f.port.recordVerificationApproval(request);
  assert.equal(replayResult.outcome, 'approved');
  assert.equal(replayResult.decisionAuthorityGeneration, 3);

  await f.stateStore.writeControl(TASK.taskId, {
    controlVersion: 3,
    epoch: 1,
    mode: 'runnable',
    holdRef: null,
    holdEventDigest: null,
    activeAuthorityRef: { ...POLICY, decisionAuthorityGeneration: 4 },
    activeClaimId: null,
  });

  const bumpedReplay = await f.port.recordVerificationApproval(request);
  assert.equal(bumpedReplay.outcome, 'stale', 'Replay after generation bump must refuse as stale');
});

// ---------------------------------------------------------------------------
// 5. (4652881411) approvedPlanCoderAdmission refuses plan decision whose recorded approval generation differs
// ---------------------------------------------------------------------------
test('regression (4652881411): approvedPlanCoderAdmission refuses plan decision whose recorded approval generation differs from current authority generation', async () => {
  const f = await fixture(patchState());
  await bindIssuedDecision(f.stateStore, TASK.taskId, {
    decisionId: ORIGINAL,
    issuerKeyRef: POLICY.issuerKeyRef,
    decisionAuthorityGeneration: 2,
    bindingDigest: computeCanonicalSha256(binding('approved', ORIGINAL)),
  });

  const mockAssembly: RealTierAssembly = {
    status: 'assembly-ready',
    providerIdentity: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    profile: {
      provider: { providerId: 'deepseek', modelId: 'deepseek-chat', pricingId: 'p-1', limitsId: 'l-1', timeoutMs: 1000 },
      limits: { inputTokensPerRequest: 1000, outputTokensPerRequest: 1000, providerTimeoutMs: 1000 },
      runLimits: { perRunInputTokens: 5000, perRunOutputTokens: 5000, perRunCostUsd: 1 },
      pricing: { inputRate: 1, outputRate: 2, cacheRate: 0, overheadRate: 0, denominator: 1000 },
      approvalPolicy: { profileVersion: '1' },
      executionPolicy: { limits: { providerTimeoutMs: 1000 } },
    } as unknown as RealTierAssembly['profile'],
  } as unknown as RealTierAssembly;

  const coderRequest = {
    task: TASK,
    state: patchState(),
    purpose: 'propose-patch' as const,
    evidence: [],
  };

  const admission = await approvedPlanCoderAdmission(mockAssembly, TASK, f.port, coderRequest);
  assert.equal(admission, undefined, 'approvedPlanCoderAdmission must refuse when recorded approval generation differs from current generation');
});
