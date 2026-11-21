/**
 * Durable verification-approval authority: the two owner methods the real-tier graph's Verify node
 * requires (`resolvePlanDecisionInContext`, `recordVerificationApproval`) plus the pre-patch
 * `planDecisionIsApproved`. Each row drives the method against a real approval-store record on disk
 * and asserts the durable outcome; no fake issuer stands in for the record.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
import { seedTaskState, type SeededTaskIds } from '../../../src/runtime/real-tier-task-seed.ts';
import { createTestBugTask } from '../support/uc03/state-fixtures.ts';

const TASK = createTestBugTask({ taskId: 'task-verify-1', repositoryId: 'repo-verify-1' });
const IDS: SeededTaskIds = { taskId: TASK.taskId, runId: 'run-verify-1', workspaceId: 'workspace-verify-1' };
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

/** The seeded task moved to a pre-rebind Verify node with the original plan still active. */
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
  // A decision's normalized action digest is keyed by its own id; the verify decision differs from the plan.
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
  readonly record: (decisionId: string, status: 'approved' | 'pending' | 'rejected') => void;
}

/** The seeded task paused at AwaitPlan with the original plan awaiting its human decision. */
function awaitPlanState(): TaskState {
  return { ...verifyState(), stateVersion: 6, node: 'AwaitPlan', activeDecisionId: ORIGINAL, nextAction: 'await-plan-approval' };
}

async function fixture(state: TaskState = verifyState()): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'va-unit-'));
  const approvals = join(base, 'approvals');
  const store = new DurableStore(join(base, 'store'));
  const port = new DurableStatePortV02({
    store,
    taskId: TASK.taskId,
    approvalStorageDir: approvals,
    trustedOperator: OPERATOR,
    initialControl: { controlVersion: 2, epoch: 1, mode: 'runnable', activeAuthorityRef: POLICY },
  });
  // Seed the durable task record at the target version directly, through the store's own write path:
  // the graph's `transition` requires one step per call, which is unrelated to what this unit
  // exercises (the authority methods read the persisted task, not how it arrived).
  const stateStore = new StatePortStore(store);
  await stateStore.writeTask(TASK.taskId, state);
  await stateStore.writeControl(TASK.taskId, { controlVersion: 2, epoch: 1, mode: 'runnable', holdRef: null, holdEventDigest: null, activeAuthorityRef: POLICY, activeClaimId: null });
  return {
    port,
    store,
    approvals,
    record(decisionId, status) {
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
      // The committed journal event the validated UC-05 reader requires beside the terminal row.
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
    },
  };
}

/** The one valid verification request: `decisionId` is derived from `requestIdentity`, not supplied. */
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

test('recordVerificationApproval: a pending decision holds the task unchanged', async () => {
  const f = await fixture();
  const { request, decisionId } = verificationRequest();
  f.record(decisionId, 'pending');
  const before = await f.port.loadTask(TASK.taskId);
  const result = await f.port.recordVerificationApproval(request);
  assert.equal(result.outcome, 'pending', JSON.stringify(result));
  assert.deepEqual(await f.port.loadTask(TASK.taskId), before);
});

test('recordVerificationApproval: an approved decision applies the exact one-field rebind', async () => {
  const f = await fixture();
  const { request, decisionId } = verificationRequest();
  f.record(decisionId, 'approved');
  const result = await f.port.recordVerificationApproval(request);
  assert.equal(result.outcome, 'approved', JSON.stringify(result));
  const after = await f.port.loadTask(TASK.taskId);
  assert.equal(after?.plan?.decisionRef, decisionId);
  assert.equal(after?.activeDecisionId, decisionId);
  assert.ok((after?.approvalDecisionRefs ?? []).includes(decisionId));
});

test('resolvePlanDecisionInContext: a recorded approval resolves only in its exact context', async () => {
  const f = await fixture();
  const { request, decisionId } = verificationRequest();
  f.record(decisionId, 'approved');
  // A decision carries authority only once this owner consumed it at its issuing authority.
  assert.equal((await f.port.recordVerificationApproval(request)).outcome, 'approved');
  assert.equal((await f.port.resolvePlanDecisionInContext(decisionId, contextOf(decisionId))).outcome, 'resolved');
  assert.equal((await f.port.resolvePlanDecisionInContext(decisionId, { ...contextOf(decisionId), expectedDecisionAuthorityGeneration: POLICY.decisionAuthorityGeneration + 1 })).outcome, 'stale');
  assert.equal((await f.port.resolvePlanDecisionInContext(`dec-verify-${'2'.repeat(64)}`, contextOf(decisionId))).outcome, 'stale');
});

test('planDecisionIsApproved: only a recorded approval at the current authority passes', async () => {
  const f = await fixture(awaitPlanState());
  const approved = ORIGINAL;
  f.record(approved, 'approved');
  // The AwaitPlan→Patch trusted plan approval is where this owner consumes the plan decision.
  assert.ok(await f.port.trustedPlanApproval(TASK.taskId));
  assert.equal(await f.port.planDecisionIsApproved(approved, contextOf(approved)), true);
  const rejected = `dec-plan-${'4'.repeat(64)}`;
  f.record(rejected, 'rejected');
  assert.equal(await f.port.planDecisionIsApproved(rejected, contextOf(rejected)), false);
  assert.equal(await f.port.planDecisionIsApproved(approved, { ...contextOf(approved), expectedDecisionAuthorityGeneration: POLICY.decisionAuthorityGeneration + 1 }), false);
});

test('F-211-05: a malformed history row cannot confer a human approval', async () => {
  const f = await fixture();
  const { request, decisionId } = verificationRequest();
  f.record(decisionId, 'pending');
  const before = await f.port.loadTask(TASK.taskId);
  // Exactly the merger probe: a bare row with no schema, response key, operator or committed event.
  writeFileSync(join(taskDir(f.approvals, TASK.taskId), 'history.json'), JSON.stringify({ resolutions: [{ decisionId, decision: 'approved' }] }));
  const result = await f.port.recordVerificationApproval(request);
  assert.notEqual(result.outcome, 'approved', JSON.stringify(result));
  const after = await f.port.loadTask(TASK.taskId);
  assert.equal(after?.plan?.decisionRef, before?.plan?.decisionRef, 'the task is unchanged');
  assert.equal(after?.activeDecisionId, before?.activeDecisionId);
});

test('F-211-06: a resolution is refused once the durable plan no longer matches the approved one', async () => {
  const f = await fixture();
  const { request, decisionId } = verificationRequest();
  f.record(decisionId, 'approved');
  assert.equal((await f.port.recordVerificationApproval(request)).outcome, 'approved', 'the approved decision applies');
  // Change the durable plan strategy behind the recorded decision's back, keeping the caller's old
  // context: the owner-reconstructed context no longer matches, so the approval is stale.
  const stateStore = new StatePortStore(f.store);
  const current = await stateStore.readTask(TASK.taskId);
  assert.ok(current?.plan);
  const drifted = 'A different, unapproved strategy';
  await stateStore.writeTask(TASK.taskId, { ...current, plan: { ...current.plan, strategy: drifted, strategyDigest: computeCanonicalSha256(drifted) } });
  assert.equal((await f.port.resolvePlanDecisionInContext(decisionId, contextOf(decisionId))).outcome, 'stale');
});

test('F-211-07: a decision consumed at one generation is refused once the generation advances', async () => {
  const f = await fixture(awaitPlanState());
  f.record(ORIGINAL, 'approved');
  // Consuming the plan decision at the AwaitPlan→Patch edge binds it to generation 3.
  assert.ok(await f.port.trustedPlanApproval(TASK.taskId), 'the recorded decision is a trusted plan approval at generation 3');
  // Publishing the same policy at generation 4 is a successor authority; the old decision does not carry over.
  assert.equal((await f.port.publishAuthority({ authorityRef: { ...POLICY, decisionAuthorityGeneration: POLICY.decisionAuthorityGeneration + 1 } })).status, 'published');
  assert.equal(await f.port.planDecisionIsApproved(ORIGINAL, { ...contextOf(ORIGINAL), expectedDecisionAuthorityGeneration: POLICY.decisionAuthorityGeneration + 1 }), false);
});
