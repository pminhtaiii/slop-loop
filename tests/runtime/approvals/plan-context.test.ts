import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApprovalBinding, ApprovalBindingContext, FixPlan, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import type { PolicyProfile } from '../../../src/contracts/approvals/contracts.ts';
import type { ApprovalContext, ApprovalService } from '../../../src/approvals/service.ts';
import { BudgetExhaustionError, computeActionDigest, computeCanonicalSha256, validateStateTransition } from '../../../src/contracts/foundation/uc03.ts';
import { createApprovalService } from '../../../src/approvals/service.ts';
import { createMockApprovalStore } from '../support/uc05/mock-store.ts';
import { createTestTaskState } from '../support/uc03/state-fixtures.ts';
import { MemoryStatePort } from '../support/uc03/memory-state.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const changedDigest = `sha256:${'b'.repeat(64)}`;
const identity = { policyId: 'policy-1', policyVersion: '1', configId: 'config-uc03-v1', configVersion: '1.0.0' };
const profile: PolicyProfile = {
  schemaVersion: 'uc05-approval/0.1-draft', profileId: 'uc05-local-v1', profileVersion: '1', policyIdentity: identity,
  supportedActionKinds: ['apply_patch', 'approve_fix_plan'], commandRules: [], sensitivePaths: ['pyproject.toml'],
  patchBreadth: { maxFiles: 8, maxAddedDeletedLines: 400 }, maxActionBytes: 65536, maxArgvEntries: 32, maxArgvEntryBytes: 4096,
  maxPresentationPageBytes: 8192, maxPresentationPages: 3, maxPresentationTotalBytes: 24576, maxEventBytes: 1024,
  operationDeadlineMs: 2000, maxMutationAttempts: 1,
  diagnosticRules: { maxBytes: 1024, redactSecrets: true, allowRawArtifacts: false, retainUnresolvedDecisions: true },
};

function plan(version = 1, decisionRef = 'plan-decision-1'): FixPlan {
  return { planVersion: version, diagnosis: 'Trailing operator reaches an invalid parser index', suspectedCauseLocations: ['src/auth.py'],
    evidenceRefs: ['diagnosis-1', 'baseline-original'], strategy: `Check parser boundary version ${version}`,
    scopedChanges: ['src/auth.py', 'src/authorization.py'], checkSetDigest: computeCanonicalSha256(['check-pytest-repro']), baselineRef: 'baseline-original',
    strategyDigest: computeCanonicalSha256(`Check parser boundary version ${version}`), decisionRef };
}
function initial(): TaskState {
  return createTestTaskState({ node: 'AwaitPlan', plan: plan(), repositoryRevisionDigest: digest, evidenceRefs: ['diagnosis-1', 'baseline-original'] });
}
function bundle(state: TaskState, decisionId: string) {
  assert.ok(state.plan);
  const action = { actionId: `plan-action-${decisionId}`, kind: 'approve_fix_plan' as const, planVersion: state.planVersion,
    strategyDigest: state.plan.strategyDigest, diagnosisEvidenceRefs: state.plan.evidenceRefs, checkSetDigest: state.plan.checkSetDigest };
  const binding: ApprovalBinding = { decisionId, actionKind: 'fix_plan', status: 'pending', normalizedActionDigest: computeActionDigest(action),
    taskId: state.taskId, workspaceId: state.workspaceId, repositoryRevisionDigest: state.repositoryRevisionDigest,
    policyId: identity.policyId, policyVersion: identity.policyVersion, planVersion: state.planVersion,
    strategyDigest: state.plan.strategyDigest, baselineRef: state.plan.baselineRef, evidenceRefs: state.plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(state.acceptanceCriteria), checkSetDigest: state.plan.checkSetDigest };
  const freshness: ApprovalBindingContext = { currentTaskId: state.taskId, currentWorkspaceId: state.workspaceId,
    currentRepositoryRevisionDigest: state.repositoryRevisionDigest, currentPolicyId: identity.policyId, currentPolicyVersion: identity.policyVersion,
    currentNormalizedActionDigest: binding.normalizedActionDigest, currentPlanVersion: state.planVersion, currentStrategyDigest: state.plan.strategyDigest,
    currentBaselineRef: state.plan.baselineRef, currentEvidenceRefs: state.plan.evidenceRefs, currentCriteriaDigest: binding.criteriaDigest,
    currentCheckSetDigest: state.plan.checkSetDigest };
  const context: ApprovalContext = { action, freshness, runId: state.runId,
    elements: { action: 'Approve the diagnosis and fix plan', necessity: 'Guard the parser boundary', targets: state.plan.scopedChanges,
      consequences: 'Allows covered production edits after separate policy checks', verificationStatus: 'Baseline recorded; repair not executed' },
    facts: { taskId: state.taskId, workspaceId: state.workspaceId, repositoryId: state.repositoryId, repositoryRevisionDigest: state.repositoryRevisionDigest,
      policyIdentity: identity, registeredActionDigest: binding.normalizedActionDigest, continuationRef: 'continuation-1', role: 'coder',
      safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
      command: null, patch: null, plan: { binding, context: freshness, materialChange: false, replanSlot: null } } };
  return { binding, context };
}
function setup(state = initial()) {
  assert.ok(state.plan?.decisionRef);
  let current = bundle(state, state.plan.decisionRef);
  const store = createMockApprovalStore({ profile, initialControls: [{ schemaVersion: 'uc05-approval/0.1-draft', taskId: state.taskId,
    repositoryId: state.repositoryId, workspaceId: state.workspaceId, version: 1, epoch: 1, mode: 'runnable', pendingDecisionId: null,
    continuationRef: null, reasonCode: 'ready', outstandingClaimRefs: [] }] });
  const service = createApprovalService({ taskId: state.taskId, profile, store, operator: { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' } },
    context: { loadForAction: async () => current.context, loadForDecision: async () => current.context }, now: () => '2026-10-20T00:00:00Z' });
  return { service, store, current: () => current, setState: (next: TaskState, decisionId: string) => { current = bundle(next, decisionId); } };
}
async function decide(service: ApprovalService, state: TaskState, decisionId: string, decision: 'approve' | 'reject' = 'approve'): Promise<ApprovalBinding> {
  const view = await service.show(state.taskId, decisionId);
  await service.decide({ taskId: state.taskId, decisionId, taskVersion: view.control.version, requestVersion: 1,
    presentationDigest: view.presentation.presentationDigest, decision, responseKey: `response-${decisionId}` });
  return service.resolve(decisionId);
}
function patch(state: TaskState, binding: ApprovalBinding, freshness: ApprovalBindingContext) {
  return validateStateTransition(state, { ...state, stateVersion: state.stateVersion + 1, node: 'Patch', activeDecisionId: state.plan?.decisionRef },
    { trusted: { approval: { binding, freshness } } });
}

test('actual human plan decision is required by the canonical Patch consumer', async () => {
  const state = initial();
  const scenario = setup(state);
  const { binding, context } = scenario.current();
  const pending = await scenario.service.requestDecision(binding);
  assert.equal(patch(state, pending, context.freshness).ok, false);
  const approved = await decide(scenario.service, state, binding.decisionId);
  assert.equal(await scenario.service.validateBinding(approved), true);
  assert.equal(patch(state, approved, context.freshness).ok, true);
});

test('Patch refuses rejected stale foreign and altered actual plan decisions', async () => {
  const state = initial();
  const original = structuredClone(state);
  const scenario = setup(state);
  await scenario.service.requestDecision(scenario.current().binding);
  const approved = await decide(scenario.service, state, 'plan-decision-1');
  for (const altered of [{ status: 'pending' }, { status: 'rejected' }, { status: 'stale' }, { decisionId: 'foreign' },
    { taskId: 'foreign' }, { workspaceId: 'foreign' }, { repositoryRevisionDigest: changedDigest }, { policyId: 'foreign' }, { policyVersion: '2' },
    { normalizedActionDigest: changedDigest }, { planVersion: 2 }, { strategyDigest: changedDigest }, { baselineRef: 'baseline-foreign' },
    { evidenceRefs: ['evidence-foreign'] }, { criteriaDigest: changedDigest }, { checkSetDigest: changedDigest }] as const) {
    assert.equal(patch(state, { ...approved, ...altered }, scenario.current().context.freshness).ok, false);
  }
  assert.ok(state.plan);
  for (const changedPlan of [{ baselineRef: 'baseline-foreign' }, { evidenceRefs: ['evidence-foreign'] }, { strategyDigest: changedDigest },
    { checkSetDigest: changedDigest }, { decisionRef: 'foreign-decision' }] as const) {
    assert.equal(patch({ ...state, plan: { ...state.plan, ...changedPlan } }, approved, scenario.current().context.freshness).ok, false, 'fresh consent cannot authorize a different consumer plan');
  }
  assert.equal(patch({ ...state, planVersion: 2, plan: { ...state.plan, planVersion: 2 } }, approved, scenario.current().context.freshness).ok, false);
  assert.equal(patch({ ...state, acceptanceCriteria: ['Different acceptance criteria'] }, approved, scenario.current().context.freshness).ok, false);
  const rejected = setup(state);
  await rejected.service.requestDecision(rejected.current().binding);
  assert.equal(patch(state, await decide(rejected.service, state, 'plan-decision-1', 'reject'), rejected.current().context.freshness).ok, false);
  assert.ok(state.taskContext);
  const foreign = setup({ ...state, taskId: 'foreign-task', taskContext: { ...state.taskContext, taskId: 'foreign-task' }, plan: plan(1, 'foreign-decision') });
  await foreign.service.requestDecision(foreign.current().binding);
  const foreignDecision = await decide(foreign.service, { ...state, taskId: 'foreign-task' }, 'foreign-decision');
  assert.equal(patch(state, foreignDecision, foreign.current().context.freshness).ok, false);
  const changed = { ...state, repositoryRevisionDigest: changedDigest };
  scenario.setState(changed, 'plan-decision-1');
  const stale = await scenario.service.resolve('plan-decision-1');
  assert.equal(stale.status, 'stale');
  assert.equal(patch(changed, stale, scenario.current().context.freshness).ok, false);
  assert.deepEqual(state, original);
});

test('a new regression baseline and nonmaterial repository refresh require exact fresh decisions without replans', async () => {
  const before = createTestTaskState({ node: 'Investigate', repositoryRevisionDigest: digest, evidenceRefs: ['diagnosis-1', 'baseline-original'] });
  const original = structuredClone(before);
  const state: TaskState = { ...before, stateVersion: 2, node: 'AwaitPlan', repositoryRevisionDigest: changedDigest,
    evidenceRefs: [...before.evidenceRefs, 'baseline-regression'], plan: { ...plan(), baselineRef: 'baseline-regression', evidenceRefs: [...before.evidenceRefs, 'baseline-regression'] } };
  assert.equal(validateStateTransition(before, state).ok, true);
  const scenario = setup(state);
  await scenario.service.requestDecision(scenario.current().binding);
  const approved = await decide(scenario.service, state, 'plan-decision-1');
  assert.equal(approved.repositoryRevisionDigest, changedDigest);
  assert.equal(approved.baselineRef, 'baseline-regression');
  assert.deepEqual(approved.evidenceRefs, ['diagnosis-1', 'baseline-original', 'baseline-regression']);
  assert.equal(patch(state, approved, scenario.current().context.freshness).ok, true);
  const history = scenario.store.readHistory(state.taskId).value?.resolutions;
  assert.ok(state.plan);
  const refreshed: TaskState = { ...state, stateVersion: 3, repositoryRevisionDigest: computeCanonicalSha256('ordinary implementation adjustment'), plan: { ...state.plan, decisionRef: 'fresh-plan-decision' } };
  assert.equal(validateStateTransition(state, refreshed, { allowSameNode: true }).ok, true);
  scenario.setState(refreshed, 'fresh-plan-decision');
  assert.equal((await scenario.service.resolve('plan-decision-1')).status, 'stale');
  const pending = await scenario.service.requestDecision(scenario.current().binding);
  assert.equal(patch(refreshed, pending, scenario.current().context.freshness).ok, false);
  const renewed = await decide(scenario.service, refreshed, 'fresh-plan-decision');
  assert.equal(patch(refreshed, renewed, scenario.current().context.freshness).ok, true);
  assert.equal(renewed.planVersion, approved.planVersion);
  assert.equal(renewed.strategyDigest, approved.strategyDigest);
  assert.equal(renewed.baselineRef, approved.baselineRef);
  assert.deepEqual(renewed.evidenceRefs, approved.evidenceRefs);
  assert.equal(refreshed.replanCount, 0);
  assert.deepEqual(refreshed.budgetLedgers, state.budgetLedgers);
  assert.deepEqual(scenario.store.readHistory(state.taskId).value?.resolutions.slice(0, 1), history);
  assert.deepEqual(before, original);
});

test('three material replans retain real mock reservations and a fourth cannot be authorized by consent or a new run', async () => {
  let state: TaskState = { ...initial(), node: 'Repair' };
  const scenario = setup(state);
  const accounting = new MemoryStatePort({ initialTaskState: state });
  await scenario.service.requestDecision(scenario.current().binding);
  await decide(scenario.service, state, 'plan-decision-1');
  for (let slot = 1; slot <= 3; slot += 1) {
    const before = structuredClone(state);
    const proposalId = `material-proposal-${slot}`;
    const reservationId = await accounting.reserve('task', 'replan', 1, proposalId);
    const candidate: TaskState = { ...state, stateVersion: state.stateVersion + 1, node: 'Investigate', plan: undefined,
      planVersion: state.planVersion + 1, replanCount: slot, budgetLedgers: accounting.getLedgers() };
    const replanReservation = { proposalId, reservationId, taskId: state.taskId, configurationId: identity.configId, priorCount: slot - 1, nextCount: slot };
    const admitted = validateStateTransition(state, candidate, { trusted: { replanReservation } });
    assert.equal(admitted.ok, true);
    assert.equal(validateStateTransition(state, candidate).ok, false, 'a count or human approval cannot invent the trusted reservation');
    assert.equal(validateStateTransition(state, { ...candidate, budgetLedgers: state.budgetLedgers }, { trusted: { replanReservation } }).ok, false);
    assert.equal(validateStateTransition(state, { ...candidate, planVersion: state.planVersion }, { trusted: { replanReservation } }).ok, false);
    assert.equal(validateStateTransition(state, { ...candidate, planVersion: state.planVersion, plan: { ...plan(state.planVersion), strategy: 'A materially different approach', strategyDigest: changedDigest } }, { trusted: { replanReservation } }).ok, false);
    assert.ok(admitted.ok);
    const awaiting: TaskState = { ...admitted.value, stateVersion: admitted.value.stateVersion + 1, node: 'AwaitPlan', plan: plan(slot + 1, `material-decision-${slot}`) };
    assert.equal(validateStateTransition(admitted.value, awaiting).ok, true);
    scenario.setState(awaiting, `material-decision-${slot}`);
    await scenario.service.requestDecision(scenario.current().binding);
    const approved = await decide(scenario.service, awaiting, `material-decision-${slot}`);
    const edited = patch(awaiting, approved, scenario.current().context.freshness);
    assert.ok(edited.ok);
    const repair: TaskState = { ...edited.value, stateVersion: edited.value.stateVersion + 1, node: 'Repair' };
    assert.equal(validateStateTransition(edited.value, repair).ok, true);
    assert.deepEqual(state, before);
    state = repair;
    const ledger = accounting.getLedgers().find(value => value.kind === 'replan');
    assert.equal(ledger?.limit, 3);
    assert.equal(ledger?.reservations.length, slot);
    assert.equal(ledger?.reservations.at(-1)?.reservationId, reservationId);
  }
  const retained = structuredClone(state);
  await assert.rejects(accounting.reserve('task', 'replan', 1, 'fourth-proposal'), BudgetExhaustionError);
  const resumed = new MemoryStatePort({ initialTaskState: { ...state, runId: 'simulated-new-run' } });
  assert.deepEqual(resumed.getLedgers(), accounting.getLedgers());
  await assert.rejects(resumed.reserve('task', 'replan', 1, 'fourth-new-run'), BudgetExhaustionError);
  const restored = await resumed.loadTask(state.taskId);
  assert.equal(restored?.replanCount, 3);
  assert.equal(validateStateTransition(state, { ...state, stateVersion: state.stateVersion + 1, node: 'Investigate', runId: 'simulated-new-run', replanCount: 0 }).ok, false);
  const fourth: TaskState = { ...state, planVersion: 5, plan: plan(5, 'fourth-decision') };
  scenario.setState(fourth, 'fourth-decision');
  await scenario.service.requestDecision(scenario.current().binding);
  const consent = await decide(scenario.service, fourth, 'fourth-decision');
  assert.equal(validateStateTransition(state, { ...fourth, stateVersion: state.stateVersion + 1, node: 'Patch', activeDecisionId: 'fourth-decision' }, { trusted: { approval: { binding: consent, freshness: scenario.current().context.freshness } } }).ok, false);
  const overLimit = validateStateTransition(state, { ...fourth, stateVersion: state.stateVersion + 1, node: 'Patch', activeDecisionId: 'fourth-decision', replanCount: 4 }, { trusted: { approval: { binding: consent, freshness: scenario.current().context.freshness } } });
  assert.ok(!overLimit.ok && overLimit.errors.some(error => error.code === 'REPLAN_CAP_EXCEEDED'));
  assert.deepEqual(state, retained);
  assert.deepEqual(accounting.getLedgers(), retained.budgetLedgers);
});

test('covered authentication edits need no path-only prompt while separate risky-action gates survive plan approval', async () => {
  const state = initial();
  const scenario = setup(state);
  await scenario.service.requestDecision(scenario.current().binding);
  const approved = await decide(scenario.service, state, 'plan-decision-1');
  const action = { actionId: 'patch-action', kind: 'apply_patch' as const, targetPaths: ['src/auth.py', 'src/authorization.py'],
    patchContent: '--- a/src/auth.py\n+++ b/src/auth.py\n@@ -1 +1 @@\n-old\n+new\n--- a/src/authorization.py\n+++ b/src/authorization.py\n@@ -1 +1 @@\n-old\n+new\n', baseRevisionDigest: digest };
  const ordinary = { fileCount: 2, addedDeletedLines: 2, dependencyChange: false, deletion: false, structuralChange: false, sensitiveConfiguration: false, productionCode: true };
  const planContext = scenario.current().context;
  let context: ApprovalContext = { ...planContext, action, freshness: { ...planContext.freshness, currentNormalizedActionDigest: computeActionDigest(action) },
    facts: { ...planContext.facts, registeredActionDigest: computeActionDigest(action), patch: ordinary,
      plan: { binding: approved, context: planContext.freshness, materialChange: false, replanSlot: null } } };
  const service = createApprovalService({ taskId: state.taskId, profile, store: scenario.store,
    context: { loadForAction: async () => context, loadForDecision: async () => planContext } });
  assert.equal(await service.classify(action), 'ALLOWED');
  assert.equal((await service.list(state.taskId)).decisionId, null);
  for (const risk of [{ dependencyChange: true }, { deletion: true }, { structuralChange: true }, { sensitiveConfiguration: true }, { fileCount: 9 }, { addedDeletedLines: 401 }]) {
    context = { ...context, facts: { ...context.facts, patch: { ...ordinary, ...risk } } };
    assert.equal(await service.classify(action), 'APPROVAL_REQUIRED');
    assert.equal(await scenario.service.validateBinding(approved), true);
  }
  context = { ...context, facts: { ...context.facts, patch: ordinary, safety: { ...context.facts.safety, testsPreserved: false } } };
  assert.equal(await service.classify(action), 'FORBIDDEN');
  assert.equal(scenario.store.readHistory(state.taskId).value?.resolutions.length, 1);
});
