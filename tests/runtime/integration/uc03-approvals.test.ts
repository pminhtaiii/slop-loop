/**
 * T052 — the UC-03 T025 approval-gating proof, CI-safe half (real-tier contract §(f) T025 row; UC-03
 * T025).
 *
 * Everything here is production: the UC-04 durable store (a temp root), the UC-05 approval service
 * over it, the host observed-action registry, the v0.2 execution guard and receiver, and the real
 * `AwaitPlan` barrier of the graph. No Docker, no provider, and no `ScriptedApprovalPort`: every
 * decision below is supplied explicitly by this test driver and every refusal is production code's.
 *
 * C13 rows: allowed, pending, approved, rejected, revised, stale and forbidden decisions; no edit
 * before an explicit plan approval; stale/rejected/forbidden decisions produce zero patches and zero
 * executor calls; a revision requires a fresh decision; continuation re-observes.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ApprovalServiceError, createApprovalService, type ApprovalService, type ApprovalServiceV02 } from '../../../src/approvals/service.ts';
import { computePlanBindingDigest, evaluatePlanBinding } from '../../../src/approvals/plan-binding.ts';
import { computeActionDigest, computeCanonicalSha256, computeCheckSetDigest, computeCommandViewDigest, CONTRACT_VERSION } from '../../../src/contracts/foundation/uc03.ts';
import { computeWorkspaceVolumeIds } from '../../../src/foundation/docker-workspace-policy.ts';
import type { validateStateTransition } from '../../../src/contracts/foundation/uc03.ts';
import type { ActionDecisionReceipt, PolicyEvaluationReceipt } from '../../../src/contracts/approvals/contracts.ts';
import { computeActionDecisionReceiptDigest, computePolicyEvaluationReceiptDigest } from '../../../src/contracts/approvals/contracts.ts';
import type { ApplyPatchAction, ApprovalBinding, BugTask, FixPlan, RunCommandAction, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { DockerWorkspaceManager, type DockerLifecycleController } from '../../../src/foundation/docker-workspace.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import { createRepositoryReceiverV02 } from '../../../src/foundation/repository-tools.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { DEFAULT_POLICY_PROFILE } from '../../../src/persistence/adapters/approval-types.ts';
import { DurableApprovalStore } from '../../../src/persistence/adapters/approval-store-adapter.ts';
import { createMaterialReplanPort } from '../../../src/persistence/adapters/material-replan-port.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { createHostActionContext, type HostActionContext } from '../../../src/runtime/host-action-context.ts';
import { seedLedgers } from '../../../src/runtime/real-tier-task-seed.ts';
import { createAwaitPlanNode } from '../../../src/uc03/graph.ts';
import type { UC03GraphPorts } from '../../../src/uc03/graph-types.ts';
import type { UC03GraphNode, UC03GraphState } from '../../../src/uc03/graph-state.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';

const TASK_ID = 'task-t052';
const RUN_ID = 'run-t052';
const WORKSPACE_ID = 'workspace-t052';
const REPOSITORY_ID = 'repo-t052';
const PLAN_DECISION = 'dec-plan-t052';
const PATCH_DECISION = 'dec-patch-t052';
const CONFIG = { configId: 'config-t052', configVersion: '1.0.0' };
/** The task's own policy identity: `decisionMatchesState` compares it against the task config. */
const POLICY = { policyId: CONFIG.configId, policyVersion: CONFIG.configVersion, configId: CONFIG.configId, configVersion: CONFIG.configVersion };
const PROFILE = { ...DEFAULT_POLICY_PROFILE, profileVersion: 'real-tier-2026-11-14', policyIdentity: POLICY };
const AUTHORITY = { ...POLICY, issuerKeyRef: `host-${CONFIG.configId}`, decisionAuthorityGeneration: 1 };
const REPO_FILES = {
  'src/calculator.py': 'def divide(a, b):\n    return a / b\n',
  'tests/test_calculator.py': 'from src.calculator import divide\n\n\ndef test_divide():\n    assert divide(10, 2) == 5\n',
} as const;
/** The bytes the approved patch writes, applied by the receiver under its workspace lease. */
const REPAIRED_SOURCE = 'def divide(a, b):\n    if b == 0:\n        raise ValueError("divisor")\n    return a / b\n';
// The default policy's own configured rule (`pytest -q tests/`), so this row really is the ALLOWED path.
const COMMAND: RunCommandAction = { actionId: 'act-cmd-t052', kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/'], workingDirectory: '/workspace/repo', purpose: 'verification' };

interface Domain {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly revision: string;
  readonly statePort: DurableStatePortV02;
  readonly service: ApprovalService & ApprovalServiceV02;
  readonly source: HostActionContext;
  readonly task: BugTask;
  readonly plan: FixPlan;
  readonly checkSetDigest: string;
  readonly planBindingDigest: string;
  /** Owner-issued trusted transitions, keyed by the resulting stateVersion. */
  readonly trustedTransitions: Record<number, NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted']>;
  /**
   * The plan the host currently observes. A replan moves it forward, so a later decision's freshness
   * describes the revised plan exactly as the owner's own context source would.
   */
  currentPlan(plan?: FixPlan): FixPlan;
  cleanup(): void;
}

function taskOf(revision: string): BugTask {
  return {
    taskId: TASK_ID,
    repositoryId: REPOSITORY_ID,
    initialRevisionDigest: revision,
    goal: 'Divide by zero must raise a domain error',
    observedBehavior: 'divide(1, 0) raises ZeroDivisionError',
    expectedBehavior: 'divide(1, 0) raises ValueError',
    reproduction: 'python -m pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['divide(1, 0) raises ValueError'],
    constraints: [],
    requiredChecks: [
      { checkId: 'check-1', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], purpose: 'reproduction', workingDirectory: 'tests', timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
    ],
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuCores: 1, maxMemoryBytes: 536_870_912, maxPids: 64 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 100_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: CONFIG.configId,
    configVersion: CONFIG.configVersion,
  };
}

/** One temp store, one temp repository, the seeded `AwaitPlan` task, and the real UC-05 service. */
async function domain(): Promise<Domain> {
  const root = mkdtempSync(join(tmpdir(), 'uc03-approvals-'));
  const repositoryRoot = join(root, 'repository');
  mkdirSync(join(repositoryRoot, 'src'), { recursive: true });
  mkdirSync(join(repositoryRoot, 'tests'), { recursive: true });
  for (const [path, content] of Object.entries(REPO_FILES)) writeFileSync(join(repositoryRoot, path), content, 'utf8');
  const filesystem = new WorkspaceFilesystemPort({ root: repositoryRoot });
  const revision = await filesystem.getCurrentRevisionDigest();
  const task = taskOf(revision);
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  const plan: FixPlan = {
    planVersion: 1,
    diagnosis: 'The divisor is not guarded',
    suspectedCauseLocations: ['src/calculator.py:1'],
    evidenceRefs: ['evidence-baseline-t052'],
    strategy: 'Reject a zero divisor before division',
    scopedChanges: ['src/calculator.py'],
    checkSetDigest,
    baselineRef: revision,
    strategyDigest: computeCanonicalSha256('Reject a zero divisor before division'),
    decisionRef: PLAN_DECISION,
  };
  const planBindingDigest = computePlanBindingDigest({
    taskId: TASK_ID,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest,
    decisionRef: plan.decisionRef ?? '',
  });

  const store = new DurableStore(join(root, 'store'));
  const trustedTransitions: Domain['trustedTransitions'] = {};
  // The seeded control head a bound real task starts with (T061): version 1, epoch 1.
  const statePort = new DurableStatePortV02({ store, taskId: TASK_ID, initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: AUTHORITY }, trustedTransitions });
  const approvals = new DurableApprovalStore({ storageDir: join(root, 'approvals'), durableStore: store, profile: PROFILE, provenance: 'real' });
  const source = createHostActionContext({ filesystem, workspaceId: WORKSPACE_ID, repositoryId: REPOSITORY_ID, policyIdentity: POLICY, ttlMs: 600_000 });
  let observedPlan = plan;
  // The host seam the service is given. The action, facts and elements are the host registry's
  // observed values (real provenance, re-measured); the freshness is the complete plan context that
  // `repair-types.ts` builds for the same state, because `createRealContextProvider` emits only the
  // six base fields and a fix-plan binding needs all twelve. The first-request convention is the
  // one `real-tier-owners.ts` applies: a decision id names its own registered action until a
  // stored request exists.
  const context = {
    loadForAction: async (taskId: string, actionId: string) => {
      const observed = await source.observe(taskId, actionId);
      // Freshness is always measured from the observation the host just re-measured, so a drifted
      // tree shows up here exactly as it does in `trusted-host-snapshot`'s refusal.
      return { ...observed, freshness: completePlanFreshness(task, observedPlan, observed.facts.repositoryRevisionDigest, observed.action), runId: RUN_ID };
    },
    loadForDecision: async (decisionId: string) => context.loadForAction(TASK_ID, decisionId),
  };
  // The operator identity is this driver, never a production default: the service refuses to record
  // any decision without one, and nothing here mints one on the operator's behalf.
  const service = createApprovalService({
    taskId: TASK_ID,
    profile: PROFILE,
    store: approvals,
    provenance: 'real',
    context,
    operator: { identity: { actorId: 'test-driver-t052', channelRef: 'host-t052', provenance: 'real' } },
    now: () => '2026-11-17T00:00:00.000Z',
  });
  await statePort.transition(taskStateOf(task, plan, revision), 0);
  return {
    root,
    repositoryRoot,
    revision,
    statePort,
    service,
    source,
    task,
    plan,
    checkSetDigest,
    planBindingDigest,
    trustedTransitions,
    currentPlan: (next?: FixPlan): FixPlan => {
      observedPlan = next ?? observedPlan;
      return observedPlan;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Every field an approval binding is compared against, naming the action that is actually being decided. */
function completePlanFreshness(task: BugTask, plan: FixPlan, revision: string, observed: { readonly actionId: string; readonly kind: string }): Record<string, unknown> {
  const planAction =
    observed.kind === 'approve_fix_plan'
      ? {
          actionId: observed.actionId,
          kind: 'approve_fix_plan' as const,
          planVersion: plan.planVersion,
          strategyDigest: plan.strategyDigest,
          diagnosisEvidenceRefs: plan.evidenceRefs,
          checkSetDigest: plan.checkSetDigest,
        }
      : null;
  return {
    currentTaskId: TASK_ID,
    currentWorkspaceId: WORKSPACE_ID,
    currentRepositoryRevisionDigest: revision,
    currentPolicyId: POLICY.policyId,
    currentPolicyVersion: POLICY.policyVersion,
    // For the plan decision the digest is the plan action's; for any other action it is that action's,
    // which is what `validateApprovalBinding` compares an `action` binding against.
    currentNormalizedActionDigest: planAction === null ? computeActionDigest(observed as never) : computeCanonicalSha256(planAction),
    currentPlanVersion: plan.planVersion,
    currentStrategyDigest: plan.strategyDigest,
    currentBaselineRef: plan.baselineRef,
    currentEvidenceRefs: [...plan.evidenceRefs],
    currentCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    currentCheckSetDigest: plan.checkSetDigest,
  };
}

function taskStateOf(task: BugTask, plan: FixPlan, revision: string): TaskState {
  return {
    schemaVersion: CONTRACT_VERSION,
    stateVersion: 1,
    taskId: TASK_ID,
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    repositoryRevisionDigest: revision,
    goal: task.goal,
    observedBehavior: task.observedBehavior,
    expectedBehavior: task.expectedBehavior,
    reproduction: task.reproduction,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: task.constraints,
    requiredCheckIds: task.requiredChecks.map(check => check.checkId),
    taskContext: task,
    node: 'AwaitPlan',
    planVersion: plan.planVersion,
    replanCount: 0,
    plan,
    activeDecisionId: PLAN_DECISION,
    evidenceRefs: [...plan.evidenceRefs],
    changedPaths: [],
    risks: [],
    nextAction: 'await-plan-approval',
    budgetLedgers: seedLedgers(task),
  };
}

const PLAN_ACTION = (d: Domain): { actionId: string; kind: 'approve_fix_plan'; planVersion: number; strategyDigest: string; diagnosisEvidenceRefs: readonly string[]; checkSetDigest: string } =>
  planActionOf(d.plan);

/** The plan action a decision id names: the same shape for the original plan and its revision. */
function planActionOf(plan: FixPlan, decisionId = PLAN_DECISION) {
  return {
    actionId: decisionId,
    kind: 'approve_fix_plan' as const,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    diagnosisEvidenceRefs: plan.evidenceRefs,
    checkSetDigest: plan.checkSetDigest,
  };
}

function planFreshness(d: Domain): Record<string, unknown> {
  return planFreshnessOf(d, d.plan, PLAN_DECISION);
}

function planFreshnessOf(d: Domain, plan: FixPlan, decisionId: string): Record<string, unknown> {
  return {
    currentTaskId: TASK_ID,
    currentWorkspaceId: WORKSPACE_ID,
    currentRepositoryRevisionDigest: d.revision,
    currentPolicyId: POLICY.policyId,
    currentPolicyVersion: POLICY.policyVersion,
    currentNormalizedActionDigest: computeCanonicalSha256(planActionOf(plan, decisionId)),
    currentPlanVersion: plan.planVersion,
    currentStrategyDigest: plan.strategyDigest,
    currentBaselineRef: plan.baselineRef,
    currentEvidenceRefs: [...plan.evidenceRefs],
    currentCriteriaDigest: computeCanonicalSha256(d.task.acceptanceCriteria),
    currentCheckSetDigest: d.checkSetDigest,
  };
}

function planBindingOf(d: Domain): ApprovalBinding {
  return planBindingOfPlan(d, d.plan, PLAN_DECISION);
}

function planBindingOfPlan(d: Domain, plan: FixPlan, decisionId: string): ApprovalBinding {
  return {
    decisionId,
    actionKind: 'fix_plan',
    normalizedActionDigest: computeCanonicalSha256(planActionOf(plan, decisionId)),
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    repositoryRevisionDigest: d.revision,
    policyId: POLICY.policyId,
    policyVersion: POLICY.policyVersion,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: [...plan.evidenceRefs],
    criteriaDigest: computeCanonicalSha256(d.task.acceptanceCriteria),
    checkSetDigest: d.checkSetDigest,
    status: 'pending',
  };
}

/** The plan-binding digest of a specific plan version, which admission binds to the task's own plan. */
function planBindingDigestOf(d: Domain, plan: FixPlan): string {
  return computePlanBindingDigest({
    taskId: TASK_ID,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(d.task.acceptanceCriteria),
    checkSetDigest: d.checkSetDigest,
    decisionRef: plan.decisionRef ?? '',
  });
}

/** v0.1 facts for the plan action: `approve_fix_plan` carries neither command nor patch facts. */
function planFacts(d: Domain): Record<string, unknown> {
  return planFactsOf(d, d.plan, PLAN_DECISION);
}

/**
 * Facts for a plan action. A revised plan (`planVersion > 1`) additionally needs the proposal the
 * policy re-checks: the binding for the exact action that would be approved, plus its freshness context.
 */
function planFactsOf(d: Domain, plan: FixPlan, decisionId: string, proposal?: { readonly binding: ApprovalBinding; readonly context: Record<string, unknown> }): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    repositoryRevisionDigest: d.revision,
    policyIdentity: POLICY,
    registeredActionDigest: computeActionDigest(planActionOf(plan, decisionId)),
    continuationRef: 'continuation-t052',
    role: 'coder',
    safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
    patch: null,
    command: null,
    plan: proposal === undefined ? null : { binding: { ...proposal.binding, status: 'approved' as const }, context: proposal.context, materialChange: false, replanSlot: null },
  };
}

const PLAN_ELEMENTS = {
  action: 'Approve the fix plan',
  necessity: 'Authorize the bounded repair',
  targets: ['src/calculator.py'],
  consequences: 'Approves one repair attempt',
  verificationStatus: 'Not executed',
};

/** Registers the plan action and asks for the plan decision; returns the pending binding. */
async function requestPlan(d: Domain): Promise<ApprovalBinding> {
  await d.source.register({ action: PLAN_ACTION(d), facts: planFacts(d), elements: PLAN_ELEMENTS });
  return d.service.requestDecision(planBindingOf(d));
}

/** Approves the plan through an explicit operator choice and returns the resolved (approved) binding. */
async function approvePlan(d: Domain, responseKey = 'approve-plan-t052'): Promise<ApprovalBinding> {
  await requestPlan(d);
  const view = await d.service.show(TASK_ID, PLAN_DECISION);
  const decided = await d.service.decide({
    taskId: TASK_ID,
    decisionId: PLAN_DECISION,
    taskVersion: view.control.version,
    requestVersion: 1,
    presentationDigest: view.presentation.presentationDigest,
    decision: 'approve',
    responseKey,
  });
  assert.equal(decided.outcome, 'ok', JSON.stringify(decided));
  return d.service.resolve(PLAN_DECISION);
}

const patchActionOf = (d: Domain): ApplyPatchAction => ({
  actionId: PATCH_DECISION,
  kind: 'apply_patch',
  patchContent: '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,2 +1,4 @@\n def divide(a, b):\n+    if b == 0:\n+        raise ValueError("divisor")\n     return a / b\n',
  targetPaths: ['src/calculator.py'],
  baseRevisionDigest: d.revision,
});

/** v0.2 patch facts: `sensitiveConfiguration` is what makes an ordinary patch APPROVAL_REQUIRED. */
function patchFacts(d: Domain, approvedPlan: ApprovalBinding, plan = d.plan, decisionId = PLAN_DECISION): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    repositoryRevisionDigest: d.revision,
    policyIdentity: POLICY,
    registeredActionDigest: computeActionDigest(patchActionOf(d)),
    continuationRef: 'continuation-t052',
    role: 'coder',
    safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
    patch: { fileCount: 1, addedDeletedLines: 3, dependencyChange: false, deletion: false, structuralChange: false, sensitiveConfiguration: true, productionCode: true },
    command: null,
    plan: { binding: approvedPlan, context: planFreshnessOf(d, plan, decisionId), materialChange: false, replanSlot: null },
    taskStateVersion: 1,
    taskNode: 'AwaitPlan',
    planApplicability: 'approved-plan',
    diagnosticPurpose: null,
    taskCriteriaDigest: null,
    checkSetDigest: d.checkSetDigest,
    testPath: null,
    checkId: null,
    planBindingDigest: planBindingDigestOf(d, plan),
    planDecisionRef: decisionId,
    providerRequest: null,
  };
}

function patchBindingOf(d: Domain): ApprovalBinding {
  return {
    decisionId: PATCH_DECISION,
    actionKind: 'action',
    normalizedActionDigest: computeActionDigest(patchActionOf(d)),
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    repositoryRevisionDigest: d.revision,
    policyId: POLICY.policyId,
    policyVersion: POLICY.policyVersion,
    status: 'pending',
  };
}

const PATCH_ELEMENTS = {
  action: 'Apply the approved repair patch',
  necessity: 'Repair the divisor guard',
  targets: ['src/calculator.py'],
  consequences: 'Changes production code',
  verificationStatus: 'Not executed',
};
const POLICY_OPTIONS = { planApplicability: 'approved-plan' as const };

/** Registers the patch action and asks for its decision, after the plan is approved. */
async function requestPatch(d: Domain): Promise<{ approval: ApprovalBinding; approvedPlan: ApprovalBinding }> {
  const approvedPlan = await approvePlan(d);
  await d.source.register({ action: patchActionOf(d), facts: patchFacts(d, approvedPlan), elements: PATCH_ELEMENTS });
  const approval = await d.service.requestDecision(patchBindingOf(d));
  return { approval, approvedPlan };
}

/** Approves the patch decision (after its request) and mints its receipt pair against the given plan. */
async function approvePatch(
  d: Domain,
  responseKey = 'approve-patch-t052',
  decisionId = PLAN_DECISION,
  bindingDigest = d.planBindingDigest,
): Promise<{ evaluation: PolicyEvaluationReceipt; decision: ActionDecisionReceipt }> {
  const view = await d.service.show(TASK_ID, PATCH_DECISION);
  const decided = await d.service.decide({
    taskId: TASK_ID,
    decisionId: PATCH_DECISION,
    taskVersion: view.control.version,
    requestVersion: 1,
    presentationDigest: view.presentation.presentationDigest,
    decision: 'approve',
    responseKey,
  });
  assert.equal(decided.outcome, 'ok', JSON.stringify(decided));
  const evaluation = await d.service.evaluatePolicy(patchActionOf(d), { ...POLICY_OPTIONS, planBindingDigest: bindingDigest, planDecisionRef: decisionId });
  const decision = await d.service.issueActionDecision(PATCH_DECISION, evaluation.receiptId);
  return { evaluation, decision };
}

/**
 * The owner's `AwaitPlan -> Patch` transition after an explicit plan approval: exactly what
 * `investigation-plan-resume.ts` issues, recorded so the durable port can validate the same move.
 */
async function enterPatch(d: Domain, plan = d.plan, decisionId = PLAN_DECISION): Promise<TaskState> {
  const current = (await d.statePort.loadTask(TASK_ID)) as TaskState;
  const decision = await d.service.resolve(decisionId);
  const next: TaskState = { ...current, stateVersion: current.stateVersion + 1, node: 'Patch', nextAction: 'apply-patch' };
  d.trustedTransitions[next.stateVersion] = { approval: { binding: decision, freshness: planFreshnessOf(d, plan, decisionId) } };
  return d.statePort.transition(next, current.stateVersion);
}

/**
 * The v0.2 admission receipt shape. The service's own receipt also carries `schemaVersion`, which the
 * admission validator refuses as unknown, so the caller projects it — and re-digests the projection,
 * because the admission recomputes the digest over exactly the bytes it is given.
 */
function admittedReceipt(receipt: PolicyEvaluationReceipt): Record<string, unknown> {
  const body = {
    receiptId: receipt.receiptId,
    actionDigest: receipt.actionDigest,
    freshnessContextDigest: receipt.freshnessContextDigest,
    policyId: receipt.policyId,
    policyVersion: receipt.policyVersion,
    configId: receipt.configId,
    configVersion: receipt.configVersion,
    decisionAuthorityGeneration: receipt.decisionAuthorityGeneration,
    result: receipt.result,
  };
  return { ...body, receiptDigest: computePolicyEvaluationReceiptDigest(body) };
}

/** The same projection for the action-decision receipt: `schemaVersion` is not an admission key. */
function admittedDecision(receipt: ActionDecisionReceipt): Record<string, unknown> {
  const body = {
    decisionId: receipt.decisionId,
    actionDigest: receipt.actionDigest,
    evaluationReceiptRef: receipt.evaluationReceiptRef,
    decisionAuthorityGeneration: receipt.decisionAuthorityGeneration,
    status: 'approved' as const,
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
  };
  return { ...body, decisionDigest: computeActionDecisionReceiptDigest(body) };
}

/** The owner admission context for any action: a patch carries its bounds, a command its admitted view and bounds. */
function admissionContextFor(
  d: Domain,
  state: TaskState,
  receipts: { readonly pe: unknown; readonly ad?: unknown },
  action: ApplyPatchAction | RunCommandAction,
  plan: { readonly decisionId: string; readonly bindingDigest: string },
): Record<string, unknown> {
  const common = {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 1,
    expectedEpoch: 1,
    taskId: TASK_ID,
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    runnableNode: state.node,
    canonicalRevision: d.revision,
    executionProfileId: 'uc03-pytest:real-tier',
    action,
    actionDigest: computeActionDigest(action),
    policyAuthorityRef: AUTHORITY,
    policyEvaluationReceipt: receipts.pe,
    ...(receipts.ad === undefined ? {} : { actionDecisionReceipt: receipts.ad }),
    planBindingDigest: plan.bindingDigest,
    planDecisionRef: plan.decisionId,
  };
  if (action.kind === 'run_command') {
    // The v0.1 CommandView shape (with `canonicalRevisionDigest`) is what `computeCommandViewDigest`
    // hashes; the v0.2 admission view renames it to `canonicalRevision`, as the probe does.
    const view01 = {
      viewId: `view-${WORKSPACE_ID}-${'a'.repeat(12)}`,
      taskId: TASK_ID,
      workspaceId: WORKSPACE_ID,
      canonicalRevisionDigest: d.revision,
      admittedFiles: [{ path: 'tests/test_calculator.py', digest: computeCanonicalSha256('test-file') }],
      exclusionsPolicyVersion: '0.1.0',
      scratchIdentity: computeWorkspaceVolumeIds(TASK_ID, WORKSPACE_ID).scratchVolumeId,
      mountedReadOnly: true as const,
    };
    return {
      ...common,
      commandView: { ...view01, canonicalRevision: d.revision, isolationProfileRef: 'uc03-pytest:real-tier', viewDigest: computeCommandViewDigest(view01) },
      finiteBounds: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuSeconds: 120, maxMemoryBytes: 536_870_912, maxProcessCount: 64, isolationProfileRef: 'uc03-pytest:real-tier' },
      reservationRefs: ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].flatMap(kind => [`task-${kind}-act-cmd`, `run-${kind}-act-cmd`]),
    };
  }
  return {
    ...common,
    baseRevision: d.revision,
    targetPaths: ['src/calculator.py'],
    patchDigest: computeCanonicalSha256(action.patchContent),
    // The trusted execution profile's own patch ceilings (`state-port-v02-admission.ts`).
    finiteBounds: { maxPatchBytes: 4096, maxChangedPaths: 5 },
    reservationRefs: ['res-repair-t052'],
  };
}

interface Gate {
  /** One guard call through the production receiver chain over the durable journal. */
  dispatch(
    receipts: { readonly pe: unknown; readonly ad?: unknown },
    plan?: { readonly decisionId: string; readonly bindingDigest: string },
    action?: ApplyPatchAction | RunCommandAction,
  ): Promise<{ readonly outcome: string; readonly reason?: string | undefined }>;
  readonly patches: () => number;
  /** Every patch effect the production receiver admitted; zero proves no edit before a decision. */
  readonly effects: readonly string[];
  /** Every container the executor would have launched; zero proves no executor effect. */
  readonly containers: () => number;
}

/** The production patch receiver needs a workspace manager; this test controller owns no daemon. */
class TestDockerController implements DockerLifecycleController {
  readonly provenance = 'mock' as const;
  private readonly volumes = new Set<string>();
  /** Every container the executor would have launched: zero proves no executor effect. */
  containers = 0;
  async createVolume(id: string): Promise<void> {
    this.volumes.add(id);
  }
  async hasVolume(id: string): Promise<boolean> {
    return this.volumes.has(id);
  }
  async removeVolume(id: string): Promise<void> {
    this.volumes.delete(id);
  }
  async executeContainer(): Promise<never> {
    this.containers += 1;
    throw new Error('NO_CONTAINER: the approval test never executes a container');
  }
}

async function unexpectedRecovery(): Promise<never> {
  throw new Error('Unexpected recovery for an observed patch');
}

async function gate(d: Domain): Promise<Gate> {
  const controller = new TestDockerController();
  const filesystem = new WorkspaceFilesystemPort({ root: d.repositoryRoot });
  const manager = new DockerWorkspaceManager({ controller });
  // The receiver takes a workspace lease, so the manager must know this workspace at the base revision.
  await manager.createWorkspace({
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    initialRevisionDigest: d.revision,
    profile: {
      profileId: 'uc03-pytest:real-tier',
      image: 'uc03-pytest:real-tier',
      imageDigest: d.revision,
      user: '1000:1000',
      readOnlyRootFilesystem: true,
      network: 'none',
      limits: { timeoutMs: 30_000, maxMemoryBytes: 536_870_912, maxCpuCores: 1, maxPids: 64 },
      mounts: [],
    },
  });
  let patches = 0;
  const effects: string[] = [];
  const receiver = createRepositoryReceiverV02({
    guardCapability: { provenance: 'mock', capabilityId: 'cap-t052', workspaceId: WORKSPACE_ID, taskId: TASK_ID, mediateRead: async operation => await operation.execute() },
    fsPort: filesystem,
    limits: { maxExcerptBytes: 65_536, maxResultCount: 32 },
    expectedRevisionDigest: d.revision,
    provenance: 'real',
    workspaceRoot: d.repositoryRoot,
    statePort: d.statePort,
    workspaceManager: manager,
    adapterIdentity: 'adapter-t052',
    processIncarnation: 'incarnation-t052',
    fencingGeneration: 1,
    patchRecoveryHandoff: { prepare: unexpectedRecovery },
    attemptStartRecoveryHandoff: { queryAttemptStart: unexpectedRecovery },
    unattemptedClaimClosureHandoff: { closeUnattemptedClaim: unexpectedRecovery },
    patchReceiver: async inserted => {
      // The only place a patch lands: reached exclusively after the receiver's own admission.
      patches += 1;
      effects.push(inserted.patchContent);
      writeFileSync(join(d.repositoryRoot, 'src/calculator.py'), REPAIRED_SOURCE, 'utf8');
      const next = await filesystem.getCurrentRevisionDigest();
      manager.setCanonicalRevision(WORKSPACE_ID, next);
      return { applied: true, newRevisionDigest: next };
    },
  });
  const guard = createExecutionGuardV02({ ports: { statePort: d.statePort, approvalPort: d.service, repositoryPort: receiver }, config: { provenance: 'real' } });
  return {
    patches: () => patches,
    effects,
    containers: () => controller.containers,
    dispatch: async (receipts, plan = { decisionId: PLAN_DECISION, bindingDigest: d.planBindingDigest }, action = patchActionOf(d)) => {
      const state = (await d.statePort.loadTask(TASK_ID)) as TaskState;
      // A failed admission is the real path's own refusal, so a thrown receiver/guard error is a denial
      // here; the counters prove it dispatched nothing.
      return guard
        .validateAndExecute(action, state, admissionContextFor(d, state, receipts, action, plan) as never)
        .catch((error: unknown) => ({ outcome: 'denied', reason: error instanceof Error ? error.message : String(error) }));
    },
  };
}

test('C13 allowed: a configured verification command needs no human decision', async () => {
  const d = await domain();
  try {
    const approvedPlan = await approvePlan(d);
    await d.source.register({
      action: COMMAND,
      facts: {
        ...patchFacts(d, approvedPlan),
        registeredActionDigest: computeActionDigest(COMMAND),
        patch: null,
        command: { executableRef: 'pytest', resolvedExecutable: 'pytest', workingDirectoryRef: 'repository-root', workingDirectory: '/workspace/repo', constrainedCapability: null },
      },
      elements: { action: 'Run the focused test', necessity: 'Verify repair', targets: ['tests/test_calculator.py'], consequences: 'Runs pytest', verificationStatus: 'Not executed' },
    });
    assert.equal(await d.service.classify(COMMAND), 'ALLOWED', 'a configured command is admitted without a decision');
    const evaluation = await d.service.evaluatePolicy(COMMAND, { ...POLICY_OPTIONS, planBindingDigest: d.planBindingDigest, planDecisionRef: PLAN_DECISION });
    assert.equal(evaluation.result, 'ALLOWED');
  } finally {
    d.cleanup();
  }
});

test('C13 pending: no edit reaches the guard before an explicit approval', async () => {
  const d = await domain();
  try {
    // The evaluation is taken while the task is still runnable; asking for the decision pauses it.
    const approvedPlan = await approvePlan(d);
    await d.source.register({ action: patchActionOf(d), facts: patchFacts(d, approvedPlan), elements: PATCH_ELEMENTS });
    const evaluation = await d.service.evaluatePolicy(patchActionOf(d), { ...POLICY_OPTIONS, planBindingDigest: d.planBindingDigest, planDecisionRef: PLAN_DECISION });
    assert.equal(evaluation.result, 'APPROVAL_REQUIRED');
    const approval = await d.service.requestDecision(patchBindingOf(d));
    assert.equal(approval.status, 'pending');

    // No decision receipt exists while the request is pending, and the service refuses to mint one.
    await assert.rejects(d.service.issueActionDecision(PATCH_DECISION, evaluation.receiptId), (error: unknown) => error instanceof ApprovalServiceError);
    // The paused task refuses a fresh evaluation too: continuation needs the decision first.
    await assert.rejects(
      d.service.evaluatePolicy(patchActionOf(d), { ...POLICY_OPTIONS, planBindingDigest: d.planBindingDigest, planDecisionRef: PLAN_DECISION }),
      (error: unknown) => error instanceof ApprovalServiceError && (error as ApprovalServiceError).outcome === 'paused',
    );

    const { patches, containers, dispatch } = await gate(d);
    const refused = await dispatch({ pe: admittedReceipt(evaluation) });
    assert.equal(refused.outcome, 'denied', JSON.stringify(refused));
    assert.equal(patches(), 0, 'no edit lands before an explicit decision');
    assert.equal(containers(), 0, 'no container is dispatched before an explicit decision');
  } finally {
    d.cleanup();
  }
});

test('C13 approved: the explicit decision mints the receipt and the real guard applies exactly one patch', async () => {
  const d = await domain();
  try {
    await requestPatch(d);
    const { evaluation, decision } = await approvePatch(d);
    assert.equal(decision.status, 'approved');
    await enterPatch(d);

    const { patches, containers, dispatch } = await gate(d);
    const applied = await dispatch({ pe: admittedReceipt(evaluation), ad: admittedDecision(decision) });
    assert.equal(applied.outcome, 'success', JSON.stringify(applied));
    assert.equal(patches(), 1, 'the approved decision is the only path that dispatches a patch');
    assert.equal(containers(), 0, 'a host patch settlement launches no container');
  } finally {
    d.cleanup();
  }
});

test('C13 rejected: a rejection mints nothing and the guard dispatches no patch', async () => {
  const d = await domain();
  try {
    const approvedPlan = await approvePlan(d);
    // An equivalent action — the same edit re-presented under a new identity — is not downgraded by the
    // plan approval: production policy still classifies it APPROVAL_REQUIRED, so it needs its own decision.
    const equivalent: ApplyPatchAction = { ...patchActionOf(d), actionId: 'act-patch-equivalent-t052' };
    assert.notEqual(computeActionDigest(equivalent), computeActionDigest(patchActionOf(d)), 'the equivalent action is a distinct identity');
    await d.source.register({ action: equivalent, facts: { ...patchFacts(d, approvedPlan), registeredActionDigest: computeActionDigest(equivalent) }, elements: PATCH_ELEMENTS });
    assert.equal(await d.service.classify(equivalent), 'APPROVAL_REQUIRED', 'an equivalent action is never downgraded to ALLOWED');
    await d.source.register({ action: patchActionOf(d), facts: patchFacts(d, approvedPlan), elements: PATCH_ELEMENTS });
    const pending = await d.service.requestDecision(patchBindingOf(d));
    const view = await d.service.show(TASK_ID, PATCH_DECISION);
    const rejected = await d.service.decide({
      taskId: TASK_ID,
      decisionId: PATCH_DECISION,
      taskVersion: view.control.version,
      requestVersion: 1,
      presentationDigest: view.presentation.presentationDigest,
      decision: 'reject',
      responseKey: 'reject-patch-t052',
    });
    assert.equal(rejected.outcome, 'ok', JSON.stringify(rejected));
    assert.equal(pending.status, 'pending', 'the same action was pending before the rejection');
    assert.equal((await d.service.resolve(PATCH_DECISION)).status, 'rejected', 'continuation reads the rejected decision');
    await assert.rejects(d.service.issueActionDecision(PATCH_DECISION, 'receipt-eval-unused'), (error: unknown) => error instanceof ApprovalServiceError);

    // Attempt the rejected edit through the same guarded receiver the approved row uses: the service
    // cannot mint the decision receipt a rejection never produced, so the guard refuses before an effect.
    const { patches, containers, dispatch } = await gate(d);
    const refused = await dispatch({ pe: receiptStub(d) });
    assert.equal(refused.outcome, 'denied', JSON.stringify(refused));
    assert.equal(patches(), 0, 'a rejected decision produces zero patches');
    assert.equal(containers(), 0, 'a rejected decision produces zero executor calls');
  } finally {
    d.cleanup();
  }
});

test('C13 equivalent substitution: the approval for one action cannot authorize an equivalent action', async () => {
  const d = await domain();
  try {
    // Genuine approved authority for action A, in an otherwise admissible runnable state (task in Patch).
    await requestPatch(d);
    const { evaluation, decision } = await approvePatch(d);
    assert.equal(decision.status, 'approved');
    await enterPatch(d);
    const receipts = { pe: admittedReceipt(evaluation), ad: admittedDecision(decision) };

    // B is the same edit under a new identity. A's receipts name A's digest, not B's.
    const equivalent: ApplyPatchAction = { ...patchActionOf(d), actionId: 'act-patch-equivalent-t052' };
    assert.notEqual(computeActionDigest(equivalent), computeActionDigest(patchActionOf(d)), 'the equivalent action is a distinct identity');
    assert.equal(decision.actionDigest, computeActionDigest(patchActionOf(d)), 'the decision is bound to A');

    // Presenting B with A's decision and evaluation through the bound guard is refused for the identity
    // binding itself, with zero patches and zero container launches.
    const { patches, containers, dispatch } = await gate(d);
    const substituted = await dispatch(receipts, undefined, equivalent);
    assert.equal(substituted.outcome, 'denied', JSON.stringify(substituted));
    assert.match(substituted.reason ?? '', /actionDigest mismatch/u, 'the refusal is the action-identity binding, not a missing decision or a stale state');
    assert.equal(patches(), 0, 'the equivalent action lands no patch with the original approval');
    assert.equal(containers(), 0, 'the equivalent action launches no container');

    // Positive control on the same state and the same receipts: A itself lands exactly one patch, so the
    // refusal above is the substitution, not an unrelated reason the task could not run.
    const applied = await dispatch(receipts);
    assert.equal(applied.outcome, 'success', JSON.stringify(applied));
    assert.equal(patches(), 1, 'the approved action is the only one that lands');
  } finally {
    d.cleanup();
  }
});

test('C13 forbidden: the production service classifies a forbidden patch and the guard dispatches no patch', async () => {
  const d = await domain();
  try {
    const approvedPlan = await approvePlan(d);
    // The default command-rule profile classifies a `pytest` invocation whose argv diverges from the
    // configured rule as FORBIDDEN through production policy, not a fabricated receipt. The task must
    // still be runnable, so this row observes before it asks for the patch decision.
    const forbidden: RunCommandAction = { ...COMMAND, actionId: 'act-cmd-forbidden-t052', argv: ['-q', 'tests/', '&&', 'id'] };
    await d.source.register({
      action: forbidden,
      facts: {
        ...patchFacts(d, approvedPlan),
        registeredActionDigest: computeActionDigest(forbidden),
        patch: null,
        command: { executableRef: 'pytest', resolvedExecutable: 'pytest', workingDirectoryRef: 'repository-root', workingDirectory: '/workspace/repo', constrainedCapability: null },
      },
      elements: {
        action: 'Run a forbidden command',
        necessity: 'Prove FORBIDDEN is production-classified',
        targets: ['tests/test_calculator.py'],
        consequences: 'Runs pytest',
        verificationStatus: 'Not executed',
      },
    });
    assert.equal(await d.service.classify(forbidden), 'FORBIDDEN', 'production policy classifies the shell-chained command as FORBIDDEN');
    // Production policy itself returns the FORBIDDEN verdict as a receipt; nothing is fabricated here.
    const evaluation = await d.service.evaluatePolicy(forbidden, { ...POLICY_OPTIONS, planBindingDigest: d.planBindingDigest, planDecisionRef: PLAN_DECISION });
    assert.equal(evaluation.result, 'FORBIDDEN', 'the production evaluation receipt records FORBIDDEN');
    // A forbidden action never reaches a human decision: no request can be recorded and no decision minted.
    await assert.rejects(
      d.service.requestDecision({ ...patchBindingOf(d), decisionId: forbidden.actionId, normalizedActionDigest: computeActionDigest(forbidden) }),
      (error: unknown) => error instanceof ApprovalServiceError && (error as ApprovalServiceError).outcome === 'denied',
      'the service refuses to request a decision for a forbidden action',
    );
    await assert.rejects(d.service.issueActionDecision(forbidden.actionId, evaluation.receiptId), (error: unknown) => error instanceof ApprovalServiceError);

    // The guard is fail-closed even when handed that FORBIDDEN receipt. The dispatch carries the
    // forbidden command itself, so the receipt's action digest matches and the refusal is the
    // FORBIDDEN policy, not a digest mismatch against a different action (SPEC-W5-110).
    const { patches, containers, dispatch } = await gate(d);
    const refused = await dispatch({ pe: admittedReceipt(evaluation) }, undefined, forbidden);
    assert.equal(refused.outcome, 'denied', JSON.stringify(refused));
    assert.match(refused.reason ?? '', /FORBIDDEN result never admits/u, 'the refusal is the FORBIDDEN policy, not an unrelated digest mismatch');
    assert.equal(patches(), 0, 'a forbidden decision produces zero patches');
    assert.equal(containers(), 0, 'a forbidden decision produces zero executor calls');
  } finally {
    d.cleanup();
  }
});

test('C13 stale: continuation re-observes, and a drifted tree withdraws the decision', async () => {
  const d = await domain();
  try {
    const { approvedPlan } = await requestPatch(d);
    // The receipt pair is minted while the tree still matches; drift below is what withdraws it.
    const { evaluation, decision } = await approvePatch(d);
    assert.equal(await d.service.validateBinding(planBindingOf(d) as never), false, 'a pending binding is never authority');
    assert.equal(await d.service.validateBinding({ ...(await d.service.resolve(PLAN_DECISION)), status: 'pending' } as never), false);

    // The host re-measures on every continuation; a changed tree is reported as drift.
    writeFileSync(join(d.repositoryRoot, 'src/calculator.py'), 'def divide(a, b):\n    return b / a\n', 'utf8');
    assert.equal(await d.service.validateBinding(approvedPlan), false, 'the approved plan decision is withdrawn once its revision moved');

    // The stale decision's own receipts reach the real guard against the drifted tree. The guard's
    // receiver detects the drift and refuses the edit, so nothing settles and the counters stay zero.
    // The old plan decision id is still the state's active one, so no transition is needed to attempt it.
    const { patches, containers, dispatch } = await gate(d);
    const refused = await dispatch({ pe: admittedReceipt(evaluation), ad: admittedDecision(decision) });
    assert.notEqual(refused.outcome, 'success', 'a stale decision never settles a patch');
    assert.equal(patches(), 0, 'a stale decision produces zero patches');
    assert.equal(containers(), 0, 'a stale decision produces zero executor calls');
  } finally {
    d.cleanup();
  }
});

test('C13 revised: a revised plan needs a fresh decision and cannot reuse the old one', async () => {
  const d = await domain();
  try {
    const approvedPlan = await approvePlan(d);
    // A revised strategy is a different plan: the approved binding's freshness no longer matches.
    const revisedStrategy = computeCanonicalSha256('Raise a domain error for a zero divisor');
    const revisedFreshness = { ...planFreshness(d), currentStrategyDigest: revisedStrategy, currentPlanVersion: 2 };
    assert.equal(evaluatePlanBinding(approvedPlan, revisedFreshness).status, 'stale', 'the old approval does not survive a revised plan');
    assert.equal(evaluatePlanBinding(approvedPlan, planFreshness(d)).status, 'valid', 'the unchanged plan stays approved');

    // A revised plan also cannot reuse the decision id: the registry refuses a replaced action.
    const revisedAction = { ...PLAN_ACTION(d), strategyDigest: revisedStrategy };
    await d.source.register({ action: revisedAction, facts: { ...planFacts(d), registeredActionDigest: computeActionDigest(revisedAction) }, elements: PLAN_ELEMENTS }).then(
      () => assert.fail('a replaced action id must be refused'),
      (error: unknown) => assert.match(String(error), /REPLACED_ACTION/u),
    );
  } finally {
    d.cleanup();
  }

  // A second, fresh task drives the production material-replan transaction: the owner commits v2 with a
  // freshly minted decision id, and only a new explicit decision re-authorizes it.
  const r = await domain();
  try {
    const revisedStrategy = computeCanonicalSha256('Raise a domain error for a zero divisor');
    // The task must reach AwaitFeedback before a replan: Approve the seeded plan, then pause for feedback.
    const originalApproved = await approvePlan(r);
    const current = (await r.statePort.loadTask(TASK_ID)) as TaskState;
    const feedback: TaskState = { ...current, stateVersion: current.stateVersion + 1, node: 'AwaitFeedback', nextAction: 'await-feedback' };
    await r.statePort.transition(feedback, current.stateVersion);
    const replan = createMaterialReplanPort({ state: r.statePort, verifyDirection: () => true });
    const prior = (await r.statePort.loadTask(TASK_ID)) as TaskState;
    const candidatePlan: FixPlan = { ...r.plan, planVersion: 1, strategy: 'Raise a domain error for a zero divisor', strategyDigest: revisedStrategy, decisionRef: undefined };
    const replanned = await replan.accept({
      taskId: TASK_ID,
      runId: RUN_ID,
      workspaceId: WORKSPACE_ID,
      repositoryId: REPOSITORY_ID,
      configurationId: CONFIG.configId,
      configurationVersion: CONFIG.configVersion,
      proposalId: 'proposal-t052-revised',
      candidatePlan,
      candidatePlanDigest: computeCanonicalSha256(candidatePlan),
      priorPlanVersion: prior.planVersion,
      priorStateVersion: prior.stateVersion,
      priorReplanCount: prior.replanCount,
      expectedNextReplanCount: prior.replanCount + 1,
      direction: {
        directive: 'revise',
        taskId: TASK_ID,
        workspaceId: WORKSPACE_ID,
        repositoryRevisionDigest: r.revision,
        stateVersion: prior.stateVersion,
        planVersion: prior.planVersion,
        rejectedDecisionId: prior.activeDecisionId ?? '',
        strategyDigest: prior.plan?.strategyDigest ?? '',
      },
    });
    assert.equal(replanned.outcome, 'accepted', JSON.stringify(replanned));
    const revisedPlan = (await r.statePort.loadTask(TASK_ID))?.plan as FixPlan;
    const revisedDecisionId = revisedPlan.decisionRef as string;
    assert.notEqual(revisedDecisionId, PLAN_DECISION, 'the revision mints its own decision id');
    r.currentPlan(revisedPlan);

    // A fresh decision authorizes the revised plan; it is not the old one re-used.
    const revisedProposalBinding = { ...planBindingOfPlan(r, revisedPlan, revisedDecisionId), status: 'approved' as const };
    await r.source.register({
      action: planActionOf(revisedPlan, revisedDecisionId),
      facts: planFactsOf(r, revisedPlan, revisedDecisionId, { binding: revisedProposalBinding, context: planFreshnessOf(r, revisedPlan, revisedDecisionId) }),
      elements: PLAN_ELEMENTS,
    });
    const revisedPending = await r.service.requestDecision(planBindingOfPlan(r, revisedPlan, revisedDecisionId));
    assert.equal(revisedPending.status, 'pending', 'the revised plan starts pending again');
    const revisedView = await r.service.show(TASK_ID, revisedDecisionId);
    const revisedDecision = await r.service.decide({
      taskId: TASK_ID,
      decisionId: revisedDecisionId,
      taskVersion: revisedView.control.version,
      requestVersion: 1,
      presentationDigest: revisedView.presentation.presentationDigest,
      decision: 'approve',
      responseKey: 'approve-revised-plan-t052',
    });
    assert.equal(revisedDecision.outcome, 'ok', JSON.stringify(revisedDecision));
    assert.equal((await r.service.resolve(revisedDecisionId)).status, 'approved', 'the fresh decision authorizes the revised plan');
    assert.equal(await r.service.validateBinding(originalApproved), false, 'the superseded v1 decision is no longer valid');

    // The old v1 decision cannot reach the guard once the revised plan is the state's active plan: the
    // admission names the old decision and digest, and the guard refuses before any effect. The revised
    // v2 decision, through the same guarded chain, is the only path that settles its patch.
    const revisedBindingDigest = planBindingDigestOf(r, revisedPlan);
    assert.notEqual(revisedBindingDigest, r.planBindingDigest, 'the revision binds a different plan digest');
    await enterPatch(r, revisedPlan, revisedDecisionId);

    // Re-register the patch action against the revised plan so its facts name the v2 binding, then ask
    // for and approve a fresh patch decision through the production service against the revised plan.
    await r.source.register({
      action: patchActionOf(r),
      facts: patchFacts(r, { ...planBindingOfPlan(r, revisedPlan, revisedDecisionId), status: 'approved' }, revisedPlan, revisedDecisionId),
      elements: PATCH_ELEMENTS,
    });
    const revisedPatchRequest = await r.service.requestDecision(patchBindingOf(r));
    assert.equal(revisedPatchRequest.status, 'pending', 'the revised patch is pending again');
    const revisedApproval = await approvePatch(r, 'approve-revised-patch-t052', revisedDecisionId, revisedBindingDigest);

    const { patches, containers, dispatch } = await gate(r);
    const oldPlanRefused = await dispatch({ pe: receiptStub(r) }, { decisionId: PLAN_DECISION, bindingDigest: r.planBindingDigest });
    assert.equal(oldPlanRefused.outcome, 'denied', JSON.stringify(oldPlanRefused));
    assert.equal(patches(), 0, 'the superseded v1 plan produces zero patches');
    assert.equal(containers(), 0, 'the superseded v1 plan produces zero executor calls');

    const revisedApplied = await dispatch(
      { pe: admittedReceipt(revisedApproval.evaluation), ad: admittedDecision(revisedApproval.decision) },
      { decisionId: revisedDecisionId, bindingDigest: revisedBindingDigest },
    );
    assert.equal(revisedApplied.outcome, 'success', JSON.stringify(revisedApplied));
    assert.equal(patches(), 1, 'the fresh v2 decision settles exactly one patch');
  } finally {
    r.cleanup();
  }
});

test('no edit before explicit plan approval: the AwaitPlan barrier pauses, then admits the approved plan', async () => {
  const d = await domain();
  try {
    await requestPlan(d);
    const repository = new FakeRepositoryPort({ initialRevision: d.revision, initialFiles: { ...REPO_FILES } });
    const ports = { statePort: d.statePort, approvalPort: d.service, repositoryPort: repository, modelPort: { provenance: 'mock' }, reviewerPort: { provenance: 'mock' } } as unknown as UC03GraphPorts;
    const awaitPlan: UC03GraphNode = createAwaitPlanNode(ports);
    const paused = await awaitPlan({ task: d.task, state: (await d.statePort.loadTask(TASK_ID)) as TaskState, reasons: [], milestones: [] } as unknown as UC03GraphState);
    assert.equal(paused.terminalOutcome, 'pending-approval', JSON.stringify(paused.reasons));
    assert.equal(paused.state?.node, 'AwaitPlan', 'a pending plan decision leaves the task before any edit node');
    assert.equal(repository.patches.length, 0, 'no edit is dispatched while the plan is pending');

    const view = await d.service.show(TASK_ID, PLAN_DECISION);
    await d.service.decide({
      taskId: TASK_ID,
      decisionId: PLAN_DECISION,
      taskVersion: view.control.version,
      requestVersion: 1,
      presentationDigest: view.presentation.presentationDigest,
      decision: 'approve',
      responseKey: 'approve-barrier-t052',
    });
    // With the decision approved the barrier stops pausing; the transition to Patch is the owner's,
    // so the port needs the same trusted approval binding `investigation-plan-resume.ts` issues.
    const nextVersion = ((await d.statePort.loadTask(TASK_ID)) as TaskState).stateVersion + 1;
    d.trustedTransitions[nextVersion] = { approval: { binding: await d.service.resolve(PLAN_DECISION), freshness: planFreshness(d) } };
    const admitted = await awaitPlan({ task: d.task, state: (await d.statePort.loadTask(TASK_ID)) as TaskState, reasons: [], milestones: [] } as unknown as UC03GraphState);
    assert.equal(admitted.terminalOutcome, undefined, JSON.stringify(admitted.reasons));
    assert.equal(admitted.state?.node, 'Patch', 'the approved plan is the only path into an edit node');
    assert.equal(repository.patches.length, 0, 'the barrier itself dispatches no edit');
  } finally {
    d.cleanup();
  }
});

/** A structurally valid APPROVAL_REQUIRED evaluation receipt with no decision behind it. */
function receiptStub(d: Domain): Record<string, unknown> {
  const base = {
    receiptId: 'receipt-eval-stub-t052',
    actionDigest: computeActionDigest(patchActionOf(d)),
    freshnessContextDigest: computeCanonicalSha256({ stub: 'freshness' }),
    policyId: AUTHORITY.policyId,
    policyVersion: AUTHORITY.policyVersion,
    configId: AUTHORITY.configId,
    configVersion: AUTHORITY.configVersion,
    decisionAuthorityGeneration: AUTHORITY.decisionAuthorityGeneration,
    result: 'APPROVAL_REQUIRED' as const,
  };
  return { ...base, receiptDigest: computeCanonicalSha256(base) };
}
