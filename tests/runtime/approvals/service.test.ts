import { validatePolicyEvaluationReceipt, validateProviderAdmissionReceipt, validateActionDecisionReceipt, computePolicyEvaluationReceiptDigest } from '../../../src/contracts/approvals/contracts.ts';
import { computePlanBindingDigest } from '../../../src/approvals/plan-binding.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionDecisionReceipt, PolicyProfile, ProviderAdmissionReceipt } from '../../../src/contracts/approvals/contracts.ts';
import type { NormalizedAction } from '../../../src/contracts/foundation/uc03.ts';
import { computeActionDigest, computeCanonicalSha256, computeRequestContentDigest } from '../../../src/contracts/foundation/uc03.ts';
import { buildPresentation } from '../../../src/approvals/presentation.ts';
import { ApprovalServiceError, createApprovalService } from '../../../src/approvals/service.ts';
import { createMockApprovalStore } from '../support/uc05/mock-store.ts';
import { createMockActivityControl } from '../support/uc05/mock-context.ts';
import type { ApprovalContext } from '../../../src/approvals/service.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const identity = { policyId: 'policy-1', policyVersion: '1', configId: 'config-1', configVersion: '1' };
const profile: PolicyProfile = {
  schemaVersion: 'uc05-approval/0.1-draft', profileId: 'uc05-local-v1', profileVersion: '1',
  policyIdentity: identity, supportedActionKinds: ['run_command', 'apply_patch', 'approve_fix_plan'],
  commandRules: [{ ruleId: 'tests', executableRef: 'pytest', argvPrefix: ['-q', 'tests/'], workingDirectoryRef: 'repository-root', timeoutMs: 2000, maxOutputBytes: 8192 }],
  sensitivePaths: ['pyproject.toml'], patchBreadth: { maxFiles: 8, maxAddedDeletedLines: 400 },
  maxActionBytes: 65536, maxArgvEntries: 32, maxArgvEntryBytes: 4096,
  maxPresentationPageBytes: 8192, maxPresentationPages: 3, maxPresentationTotalBytes: 24576,
  maxEventBytes: 1024, operationDeadlineMs: 2000, maxMutationAttempts: 1,
  diagnosticRules: { maxBytes: 1024, redactSecrets: true, allowRawArtifacts: false, retainUnresolvedDecisions: true },
};
const action: NormalizedAction = { actionId: 'action-1', kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/other.py'], workingDirectory: '/workspace' };
const binding = { decisionId: 'decision-1', actionKind: 'action' as const, normalizedActionDigest: computeActionDigest(action), taskId: 'task-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest, policyId: 'policy-1', policyVersion: '1', status: 'pending' as const };
const freshness = { currentTaskId: 'task-1', currentWorkspaceId: 'workspace-1', currentRepositoryRevisionDigest: digest, currentPolicyId: 'policy-1', currentPolicyVersion: '1', currentNormalizedActionDigest: computeActionDigest(action) };
const elements = { action: 'Run focused tests', necessity: 'Verify the proposed repair', targets: ['tests/other.py'], consequences: 'Runs isolated tests', verificationStatus: 'Not yet executed' };

function versionedRead<T>(service: object, methodName: string): (id: string) => Promise<T> {
  const method: unknown = Reflect.get(service, methodName);
  assert.ok(typeof method === 'function', `${methodName} is available on the v0.2 service`);
  return id => Reflect.apply(method, service, [id]) as Promise<T>;
}
const input = { requestVersion: 1, action, binding, freshness, repositoryId: 'repository-1', continuationRef: 'continuation-1', policyIdentity: identity, elements };

test('presentation binds five elements and complete exact command to the displayed digest', () => {
  const result = buildPresentation(input, profile);
  assert.deepEqual(result.summary.elements, elements);
  assert.equal(result.pages.join(''), JSON.stringify(action));
  const changed = buildPresentation({ ...input, elements: { ...elements, necessity: 'Different purpose' } }, profile);
  assert.notEqual(result.summary.presentationDigest, changed.summary.presentationDigest);
});

function setup() {
  const store = createMockApprovalStore({ profile, initialControls: [{ schemaVersion: 'uc05-approval/0.1-draft', taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', version: 1, epoch: 1, mode: 'runnable', pendingDecisionId: null, continuationRef: null, reasonCode: 'ready', outstandingClaimRefs: [] }] });
  let current: ApprovalContext = { action, freshness, runId: 'run-1', elements, facts: ({
    taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest,
    policyIdentity: identity, registeredActionDigest: computeActionDigest(action), continuationRef: 'continuation-1', role: 'coder',
    safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
    command: { executableRef: 'pytest', resolvedExecutable: 'pytest', workingDirectoryRef: 'repository-root', workingDirectory: '/workspace', constrainedCapability: 'constrained-tests' }, patch: null, plan: null,
    taskStateVersion: 1, taskNode: 'Investigate', planApplicability: 'pre-plan-diagnostic', diagnosticPurpose: 'reproduction_check',
    taskCriteriaDigest: digest, checkSetDigest: digest, testPath: 'tests/other.py', checkId: 'baseline-tests',
    planBindingDigest: null, planDecisionRef: null, providerRequest: null, runId: 'run-1',
  } as unknown as ApprovalContext['facts']) };
  const context = { loadForAction: async () => current, loadForDecision: async () => current };
  const operator = { identity: { actorId: 'operator-1', channelRef: 'host-1', provenance: 'real' as const } };
  const service = createApprovalService({ taskId: 'task-1', profile, store, context, operator, now: () => '2026-10-19T00:00:00Z' });
  return { service, store, context, operator, setContext: (value: ApprovalContext) => { current = value; }, current: () => current };
}

function providerRequest(role: 'coder' | 'reviewer', applicability: 'pre-plan-diagnostic' | 'approved-plan', id: string) {
  return {
    providerRequestId: id, taskId: 'task-1', runId: 'run-1', role,
    purpose: applicability === 'pre-plan-diagnostic' ? 'reproduction_check' : 'approved_fix_work',
    providerId: 'provider-1', modelId: 'model-1', configId: identity.configId, pricingPolicyId: 'pricing-1',
    contextDigest: digest, timeoutMs: 2_000, maxInputTokens: 100, maxOutputTokens: 100, maxBillableTokens: 220,
    maxCostUsd: 0.25, reservationRef: `reservation-${id}`, dispatchState: 'reserved' as const,
  };
}

function providerFacts(current: ApprovalContext, request: ReturnType<typeof providerRequest>, applicability: 'pre-plan-diagnostic' | 'approved-plan') {
  const prePlan = applicability === 'pre-plan-diagnostic';
  const bindingPlan = {
    decisionId: 'plan-decision-1', actionKind: 'fix_plan' as const, normalizedActionDigest: digest,
    taskId: 'task-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest, policyId: identity.policyId, policyVersion: identity.policyVersion,
    status: 'approved' as const, planVersion: 1, strategyDigest: digest, baselineRef: 'baseline-1', evidenceRefs: ['evidence-1'],
    criteriaDigest: digest, checkSetDigest: digest,
  };
  const plan = prePlan ? null : {
    binding: bindingPlan,
    context: {
      currentTaskId: 'task-1', currentWorkspaceId: 'workspace-1', currentRepositoryRevisionDigest: digest,
      currentPolicyId: identity.policyId, currentPolicyVersion: identity.policyVersion, currentNormalizedActionDigest: digest,
      currentPlanVersion: 1, currentStrategyDigest: digest, currentBaselineRef: 'baseline-1', currentEvidenceRefs: ['evidence-1'],
      currentCriteriaDigest: digest, currentCheckSetDigest: digest,
    },
    materialChange: false, replanSlot: null,
  };
  return {
    ...current.facts,
    role: request.role,
    runId: request.runId,
    taskNode: prePlan ? 'Investigate' : 'Patch',
    planApplicability: applicability,
    diagnosticPurpose: prePlan ? request.purpose : null,
    taskCriteriaDigest: prePlan ? digest : null,
    checkSetDigest: digest,
    testPath: prePlan ? 'tests/other.py' : null,
    checkId: prePlan ? 'provider-diagnostic' : null,
    planBindingDigest: plan === null ? null : computePlanBindingDigest({
      taskId: bindingPlan.taskId, planVersion: bindingPlan.planVersion, strategyDigest: bindingPlan.strategyDigest,
      baselineRef: bindingPlan.baselineRef, evidenceRefs: bindingPlan.evidenceRefs, criteriaDigest: bindingPlan.criteriaDigest,
      checkSetDigest: bindingPlan.checkSetDigest, decisionRef: bindingPlan.decisionId,
    }),
    planDecisionRef: plan?.binding.decisionId ?? null,
    plan,
    providerRequest: request,
  };
}

test('a context exception cannot impersonate a deterministic stale binding assessment', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const original = scenario.store.readHistory('task-1');
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, operator: scenario.operator,
    context: { ...scenario.context, loadForDecision: async () => { throw new ApprovalServiceError('stale', 'MARKER_SECRET_DO_NOT_DISCLOSE'); } } });
  await assert.rejects(service.resolve('decision-1'), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable' && error.reasonCode === 'approval-operation-denied');
  assert.deepEqual(scenario.store.readHistory('task-1'), original);
});

test('context failure leaves a pending decision and its immutable assessment history intact', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const original = scenario.store.readHistory('task-1');
  const waiting = (await scenario.service.list('task-1')).control;
  const changed = `sha256:${'b'.repeat(64)}`;
  const current = scenario.current();
  const renewed = { ...current, freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...current.facts, repositoryRevisionDigest: changed } };
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, operator: scenario.operator,
    context: { loadForAction: async () => renewed, loadForDecision: async id => {
      if (id === 'decision-1') throw new ApprovalServiceError('stale', 'MARKER_SECRET_DO_NOT_DISCLOSE');
      return renewed;
    } } });
  await assert.rejects(service.requestDecision({ ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed }), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable' && error.reasonCode === 'approval-operation-denied');
  assert.deepEqual(scenario.store.readHistory('task-1'), original);
  assert.deepEqual((await service.list('task-1')).control, waiting);
  assert.equal(scenario.store.readRequest('decision-2').value, null);
});

test('a store exception is safe and keeps admission closed after the adapter recovers', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'approved-before-failure' });
  const approved = await scenario.service.resolve('decision-1');
  let failed = true;
  const backend = { ...scenario.store, readRequest: (id: string) => {
    if (failed) throw new ApprovalServiceError('stale', 'MARKER_SECRET_DO_NOT_DISCLOSE');
    return scenario.store.readRequest(id);
  } };
  const service = createApprovalService({ taskId: 'task-1', profile, store: backend, context: scenario.context, operator: scenario.operator });
  await assert.rejects(service.resolve('decision-1'), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable' && error.reasonCode === 'approval-operation-denied');
  failed = false;
  assert.equal(await service.validateBinding(approved), false);
});

test('initial request lookup rejects receipt accessors without invoking them and keeps admission closed', async () => {
  for (const pending of [false, true]) {
    const scenario = setup();
    if (pending) await scenario.service.requestDecision(binding);
    const originalControl = scenario.store.loadTaskControl('task-1');
    const originalHistory = scenario.store.readHistory('task-1');
    let getterCalls = 0;
    let recovered = false;
    const backend = { ...scenario.store, readRequest: (id: string) => recovered ? scenario.store.readRequest(id) : {
      get safe(): never { getterCalls += 1; throw new ApprovalServiceError('stale', 'MARKER_SECRET_DO_NOT_DISCLOSE'); }, value: null,
    } };
    const service = createApprovalService({ taskId: 'task-1', profile, store: backend, context: scenario.context, operator: scenario.operator });
    await assert.rejects(service.requestDecision(binding), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable' && error.reasonCode === 'approval-operation-denied');
    assert.equal(getterCalls, 0);
    assert.deepEqual(scenario.store.loadTaskControl('task-1'), originalControl);
    assert.deepEqual(scenario.store.readHistory('task-1'), originalHistory);
    recovered = true;
    await assert.rejects(service.classify(action), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
    assert.equal(scenario.store.readRequest('decision-1').value !== null, pending);
  }
});

test('activity exceptions cannot expose adapter-selected outcomes or clear task control', async () => {
  const scenario = setup();
  const original = scenario.store.loadTaskControl('task-1');
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, operator: scenario.operator,
    context: { ...scenario.context, loadForTask: async () => ({ taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', runId: 'run-1', safeScopeRef: 'scope-1', policyIdentity: identity }) },
    activity: { ...createMockActivityControl(profile), inspectOutstanding: () => { throw new ApprovalServiceError('stale', 'MARKER_SECRET_DO_NOT_DISCLOSE'); } } });
  await assert.rejects(service.control({ taskId: 'task-1', taskVersion: 1, direction: 'end', responseKey: 'failed-end' }), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable' && error.reasonCode === 'approval-operation-denied');
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), original);
  assert.equal(scenario.store.readHistory('task-1').value?.directions.length, 0);
});

test('clock failure is safe and cannot create a request or retire its predecessor', async () => {
  const scenario = setup();
  const original = scenario.store.loadTaskControl('task-1');
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, context: scenario.context, operator: scenario.operator,
    now: () => { throw new ApprovalServiceError('stale', 'MARKER_SECRET_DO_NOT_DISCLOSE'); } });
  await assert.rejects(service.requestDecision(binding), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable' && error.reasonCode === 'approval-operation-denied');
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), original);
  assert.equal(scenario.store.readRequest('decision-1').value, null);
});

test('action context callbacks cannot supply raw stale outcomes through synchronous throws', async () => {
  const scenario = setup();
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, operator: scenario.operator,
    context: { ...scenario.context, loadForAction: () => { throw new ApprovalServiceError('stale', 'MARKER_SECRET_DO_NOT_DISCLOSE'); } } });
  await assert.rejects(service.classify(action), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable' && error.reasonCode === 'approval-operation-denied');
  assert.equal((await service.list('task-1')).decisionId, null);
});

test('task context rejection cannot turn an explicit direction into adapter-selected authority', async () => {
  const scenario = setup();
  const original = scenario.store.loadTaskControl('task-1');
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, operator: scenario.operator, activity: createMockActivityControl(profile),
    context: { ...scenario.context, loadForTask: async () => { throw new ApprovalServiceError('stale', 'MARKER_SECRET_DO_NOT_DISCLOSE'); } } });
  await assert.rejects(service.control({ taskId: 'task-1', taskVersion: 1, direction: 'end', responseKey: 'failed-context-end' }), error => error instanceof ApprovalServiceError && error.outcome === 'unavailable' && error.reasonCode === 'approval-operation-denied');
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), original);
  assert.equal(scenario.store.readHistory('task-1').value?.directions.length, 0);
});

test('repository drift projects approved consent stale without rewriting its immutable history', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' });
  const history = scenario.store.readHistory('task-1').value;
  const original = scenario.store.readRequest('decision-1').value;
  const changed = `sha256:${'b'.repeat(64)}`;
  scenario.setContext({ ...scenario.current(), freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...scenario.current().facts, repositoryRevisionDigest: changed } });
  const projected = await scenario.service.resolve('decision-1');
  assert.equal(projected.status, 'stale');
  assert.equal(projected.reason, 'changed-repositoryRevisionDigest');
  assert.equal(await scenario.service.validateBinding({ ...binding, status: 'approved' }), false);
  assert.deepEqual(scenario.store.readRequest('decision-1').value, original);
  assert.deepEqual(scenario.store.readHistory('task-1').value, history);
  await scenario.service.requestDecision({ ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed });
  assert.equal((await scenario.service.list('task-1')).control.pendingDecisionId, 'decision-2');
  assert.equal((await scenario.service.resolve('decision-2')).status, 'pending');
  assert.equal((await scenario.service.resolve('decision-1')).status, 'stale');
});

test('stale pending request is replaced under its waiting hold with a fresh decision and retained assessment', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const oldView = await scenario.service.show('task-1', 'decision-1');
  const original = scenario.store.readRequest('decision-1').value;
  const changed = `sha256:${'b'.repeat(64)}`;
  scenario.setContext({ ...scenario.current(), freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...scenario.current().facts, repositoryRevisionDigest: changed } });
  await assert.rejects(scenario.service.requestDecision({ ...binding, repositoryRevisionDigest: changed }));
  const replacement = { ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed };
  assert.equal((await scenario.service.requestDecision(replacement)).status, 'pending');
  const waiting = (await scenario.service.list('task-1')).control;
  assert.equal(waiting.mode, 'waiting');
  assert.equal(waiting.pendingDecisionId, 'decision-2');
  assert.equal(waiting.epoch, oldView.control.epoch + 1);
  assert.equal((await scenario.service.resolve('decision-1')).status, 'stale');
  assert.deepEqual(scenario.store.readRequest('decision-1').value, original);
  assert.equal(scenario.store.readHistory('task-1').value?.assessments[0]?.status, 'stale');
  assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, 0);
  await assert.rejects(scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: oldView.control.version, requestVersion: 1, presentationDigest: oldView.presentation.presentationDigest, decision: 'approve', responseKey: 'late-old' }));
  assert.deepEqual((await scenario.service.list('task-1')).control, waiting);
  scenario.setContext({ ...scenario.current(), freshness, facts: { ...scenario.current().facts, repositoryRevisionDigest: digest } });
  assert.equal((await scenario.service.resolve('decision-1')).status, 'stale', 'retired decision stays stale even if repository returns to its original digest');
});

test('replacement assessment identifies the old decision context that actually proved repository drift', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const original = scenario.store.readRequest('decision-1').value;
  const changed = `sha256:${'b'.repeat(64)}`;
  const assessed = { ...scenario.current(), runId: 'run-assessed-old', freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...scenario.current().facts, repositoryRevisionDigest: changed } };
  const replacement = { ...assessed, runId: 'run-replacement' };
  let oldContext = assessed;
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, operator: scenario.operator,
    context: { loadForAction: async () => replacement, loadForDecision: async id => {
      if (id !== 'decision-1') return replacement;
      const current = oldContext;
      oldContext = { ...assessed, runId: 'run-later-old' };
      return current;
    } } });
  assert.equal((await service.requestDecision({ ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed })).status, 'pending');
  const assessment = scenario.store.readHistory('task-1').value?.assessments[0];
  assert.equal(assessment?.trustedContextDigest, computeCanonicalSha256(assessed));
  assert.deepEqual(assessment?.reasonCodes, ['changed-repositoryRevisionDigest']);
  assert.deepEqual(scenario.store.readRequest('decision-1').value, original);
  assert.equal((await service.list('task-1')).control.pendingDecisionId, 'decision-2');
});

test('request-context retirement retains its own assessment context without exposing that context in safe errors', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const assessed = { ...scenario.current(), runId: 'run-assessed-request', facts: { ...scenario.current().facts, continuationRef: 'continuation-renewed' } };
  const replacement = { ...assessed, runId: 'run-replacement' };
  let oldContext = assessed;
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, operator: scenario.operator,
    context: { loadForAction: async () => replacement, loadForDecision: async id => {
      if (id !== 'decision-1') return replacement;
      const current = oldContext;
      oldContext = { ...assessed, runId: 'run-later-old' };
      return current;
    } } });
  await assert.rejects(service.show('task-1', 'decision-1'), error => {
    assert.ok(error instanceof ApprovalServiceError);
    assert.equal(error.outcome, 'stale');
    assert.equal(error.reasonCode, 'changed-request-context');
    assert.equal(JSON.stringify(error), '{"outcome":"stale","reasonCode":"changed-request-context"}');
    return true;
  });
  oldContext = assessed;
  assert.equal((await service.requestDecision({ ...binding, decisionId: 'decision-2' })).status, 'pending');
  const assessment = scenario.store.readHistory('task-1').value?.assessments[0];
  assert.equal(assessment?.trustedContextDigest, computeCanonicalSha256(assessed));
  assert.deepEqual(assessment?.reasonCodes, ['changed-request-context']);
});

test('companion repository mapping drift is a concrete stale projection and cannot silently rebind', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  scenario.setContext({ ...scenario.current(), facts: { ...scenario.current().facts, repositoryId: 'repository-foreign' } });
  const stale = await scenario.service.resolve('decision-1');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.reason, 'changed-repository-mapping');
  await assert.rejects(scenario.service.requestDecision({ ...binding, decisionId: 'decision-2' }));
  assert.equal(scenario.store.readRequest('decision-2').value, null);
  assert.equal((await scenario.service.list('task-1')).control.pendingDecisionId, 'decision-1');
});

test('binding arguments cannot run accessors while requesting or validating authority', async () => {
  const scenario = setup();
  let reads = 0;
  const malicious = Object.defineProperty({ ...binding }, 'decisionId', { enumerable: true, get: () => { reads += 1; return 'decision-1'; } });
  await assert.rejects(scenario.service.requestDecision(malicious));
  assert.equal(await scenario.service.validateBinding(malicious), false);
  assert.equal(reads, 0);
  assert.equal(scenario.store.readRequest('decision-1').value, null);
});

test('proxy binding arguments deny authority before running reflective traps', async () => {
  const scenario = setup();
  let reads = 0;
  const malicious = new Proxy(binding, { ownKeys: target => { reads += 1; return Reflect.ownKeys(target); } });
  await assert.rejects(scenario.service.requestDecision(malicious));
  assert.equal(await scenario.service.validateBinding(malicious), false);
  assert.equal(reads, 0);
  assert.equal(scenario.store.readRequest('decision-1').value, null);
});

test('journal and request accessors are rejected before reading persisted authority', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  let reads = 0;
  for (const operation of ['readRequest', 'readHistory'] as const) {
    const store = { ...scenario.store, [operation]: () => Object.defineProperty({}, 'value', { enumerable: true, get: () => { reads += 1; throw new Error('untrusted accessor'); } }) };
    const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
    await assert.rejects(service.resolve('decision-1'));
  }
  assert.equal(reads, 0);
});

test('actual service projects every exact plan freshness change stale and refuses the original approval', async () => {
  const scenario = setup();
  const plan: NormalizedAction = { actionId: 'plan-1', kind: 'approve_fix_plan', planVersion: 1, strategyDigest: digest, diagnosisEvidenceRefs: ['evidence-1'], checkSetDigest: digest };
  const planFields = { planVersion: 1, strategyDigest: digest, baselineRef: 'baseline-1', evidenceRefs: ['evidence-1'], criteriaDigest: digest, checkSetDigest: digest };
  const planBinding = { ...binding, ...planFields, actionKind: 'fix_plan' as const, normalizedActionDigest: computeActionDigest(plan) };
  const planFreshness = { ...freshness, currentNormalizedActionDigest: computeActionDigest(plan), currentPlanVersion: 1, currentStrategyDigest: digest, currentBaselineRef: 'baseline-1', currentEvidenceRefs: ['evidence-1'], currentCriteriaDigest: digest, currentCheckSetDigest: digest };
  const current = { ...scenario.current(), action: plan, facts: { ...scenario.current().facts, registeredActionDigest: computeActionDigest(plan), command: null }, freshness: planFreshness };
  scenario.setContext(current);
  await scenario.service.requestDecision(planBinding);
  const view = await scenario.service.show('task-1', 'decision-1');
  await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'approve-plan' });
  const approved = await scenario.service.resolve('decision-1');
  assert.equal(await scenario.service.validateBinding(approved), true);
  const history = scenario.store.readHistory('task-1').value;
  for (const [field, value] of Object.entries(planFreshness)) {
    const changed = typeof value === 'number' ? 2 : Array.isArray(value) ? ['different-evidence'] : String(value).startsWith('sha256:') ? `sha256:${'b'.repeat(64)}` : 'different';
    scenario.setContext({ ...current, freshness: { ...planFreshness, [field]: changed } });
    assert.equal((await scenario.service.resolve('decision-1')).status, 'stale', field);
    assert.equal(await scenario.service.validateBinding(approved), false, field);
    assert.deepEqual(scenario.store.readHistory('task-1').value, history);
  }
  const changedRevision = `sha256:${'b'.repeat(64)}`;
  scenario.setContext({ ...current, freshness: { ...planFreshness, currentRepositoryRevisionDigest: changedRevision }, facts: { ...current.facts, repositoryRevisionDigest: changedRevision } });
  const refreshed = { ...planBinding, decisionId: 'plan-refreshed', repositoryRevisionDigest: changedRevision };
  await scenario.service.requestDecision(refreshed);
  const stored = scenario.store.readRequest('plan-refreshed').value?.binding;
  assert.equal(stored?.planVersion, 1);
  assert.equal(stored?.strategyDigest, digest);
  assert.equal(stored?.baselineRef, 'baseline-1');
  assert.deepEqual(stored?.evidenceRefs, ['evidence-1']);
  assert.deepEqual(scenario.store.readHistory('task-1').value?.resolutions, history?.resolutions);
});

test('racing contradictory operator responses preserve one terminal decision and duplicate delivery is harmless', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  const response = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'race' };
  const outcomes = await Promise.allSettled([scenario.service.decide(response), scenario.service.decide({ ...response, decision: 'reject', responseKey: 'other-race' })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const history = scenario.store.readHistory('task-1').value;
  assert.equal(history?.resolutions.length, 1);
  assert.equal(history?.resolutions[0]?.decision, 'approved');
  assert.equal((await scenario.service.decide(response)).outcome, 'ok');
  assert.deepEqual(scenario.store.readHistory('task-1').value, history);
});

test('explicit direction after rejection requires a fresh decision and preserves rejection across drift', async () => {
  const scenario = setup();
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, context: { ...scenario.context, loadForTask: async () => ({ taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', runId: 'run-1', safeScopeRef: 'scope-1', policyIdentity: identity }) }, activity: createMockActivityControl(profile), operator: scenario.operator });
  await service.requestDecision(binding);
  const view = await service.show('task-1', 'decision-1');
  await service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'reject', responseKey: 'reject' });
  const history = scenario.store.readHistory('task-1').value?.resolutions;
  await assert.rejects(service.requestDecision({ ...binding, decisionId: 'decision-2' }));
  const rejected = (await service.list('task-1')).control;
  await service.control({ taskId: 'task-1', taskVersion: rejected.version, direction: 'revise', responseKey: 'revise' });
  const changed = `sha256:${'b'.repeat(64)}`;
  scenario.setContext({ ...scenario.current(), freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...scenario.current().facts, repositoryRevisionDigest: changed } });
  assert.equal((await service.resolve('decision-1')).status, 'rejected');
  await service.requestDecision({ ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed });
  assert.equal((await service.resolve('decision-2')).status, 'pending');
  assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
  assert.deepEqual(scenario.store.readHistory('task-1').value?.resolutions, history);
});

test('historical rejected projections refuse shape-valid protected request metadata', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'reject', responseKey: 'reject' });
  const store = { ...scenario.store, readRequest: (id: string) => {
    const response = scenario.store.readRequest(id);
    return { ...response, value: response.value && { ...response.value, policyId: 'marker-secret', binding: { ...response.value.binding, policyId: 'marker-secret' } } };
  } };
  const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
  await assert.rejects(service.resolve('decision-1'), error => error instanceof Error && error.message === 'approval-operation-denied');
  assert.equal((await scenario.service.resolve('decision-1')).status, 'rejected');
});

test('policy configuration and continuation drift invalidate the stored request identity', async () => {
  for (const dimension of ['configId', 'configVersion', 'continuationRef'] as const) {
    const scenario = setup();
    await scenario.service.requestDecision(binding);
    const changedIdentity = dimension === 'continuationRef' ? identity : { ...identity, [dimension]: 'changed' };
    scenario.setContext({ ...scenario.current(), facts: { ...scenario.current().facts, policyIdentity: changedIdentity, continuationRef: dimension === 'continuationRef' ? 'continuation-new' : 'continuation-1' } });
    const service = createApprovalService({ taskId: 'task-1', profile: { ...profile, policyIdentity: changedIdentity }, store: scenario.store, context: scenario.context, operator: scenario.operator });
    assert.equal((await service.resolve('decision-1')).status, 'stale', dimension);
    assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
    assert.equal(scenario.store.readRequest('decision-1').value?.configId, 'config-1');
    assert.equal(scenario.store.readRequest('decision-1').value?.configVersion, '1');
    assert.equal(scenario.store.readRequest('decision-1').value?.continuationRef, 'continuation-1');
  }
});

test('missing trusted decision context denies stored approval and fresh request creation', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' });
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, context: { ...scenario.context, loadForDecision: async () => undefined }, operator: scenario.operator });
  assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
  await assert.rejects(service.resolve('decision-1'));
  await assert.rejects(service.requestDecision({ ...binding, decisionId: 'decision-2' }));
  assert.equal(scenario.store.readRequest('decision-2').value, null);
  assert.equal(scenario.store.readHistory('task-1').value?.resolutions[0]?.decision, 'approved');
});

test('failed stale replacement retains the old waiting hold and creates no decision or assessment', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const waiting = (await scenario.service.list('task-1')).control;
  const changed = `sha256:${'b'.repeat(64)}`;
  scenario.setContext({ ...scenario.current(), freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...scenario.current().facts, repositoryRevisionDigest: changed } });
  scenario.store.failNext('replaceStalePending');
  await assert.rejects(scenario.service.requestDecision({ ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed }));
  assert.deepEqual((await scenario.service.list('task-1')).control, waiting);
  assert.equal(scenario.store.readRequest('decision-2').value, null);
  assert.equal(scenario.store.readHistory('task-1').value?.assessments.length, 0);
  assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, 0);
});

test('replacement success receipts must exactly identify the committed request control and event', async () => {
  for (const change of [{ taskId: 'foreign-task' }, { decisionId: 'foreign-decision' }, { requestVersion: 99 }, { controlVersion: 99 }, { eventRef: 'foreign-event' }, { safeNextAction: 'retry-read' }, { eventRef: 'marker-secret' }] as const) {
    const scenario = setup();
    await scenario.service.requestDecision(binding);
    const changed = `sha256:${'b'.repeat(64)}`;
    scenario.setContext({ ...scenario.current(), freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...scenario.current().facts, repositoryRevisionDigest: changed } });
    const store = { ...scenario.store, replaceStalePending: (input: unknown) => {
      const response = scenario.store.replaceStalePending(input);
      return { ...response, safe: { ...response.safe, ...change } };
    } };
    const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
    await assert.rejects(service.requestDecision({ ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed }), error => error instanceof Error && error.message === 'approval-operation-denied');
    const view = await scenario.service.show('task-1', 'decision-2');
    await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-2', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'approve-valid-replacement' });
    assert.equal(await service.validateBinding(await service.resolve('decision-2')), false);
  }
});

test('replacement success requires authoritative committed request control assessment and journal evidence', async () => {
  for (const corruption of ['assessment', 'events', 'request', 'previousRequest', 'controlEpoch', 'controlVersion', 'controlClaims'] as const) {
    const scenario = setup();
    await scenario.service.requestDecision(binding);
    const changed = `sha256:${'b'.repeat(64)}`;
    scenario.setContext({ ...scenario.current(), freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...scenario.current().facts, repositoryRevisionDigest: changed } });
    let committed = false;
    const store = { ...scenario.store,
      replaceStalePending: (input: unknown) => { const result = scenario.store.replaceStalePending(input); committed = true; return result; },
      readHistory: (taskId: string) => { const result = scenario.store.readHistory(taskId); return committed && corruption === 'assessment' && result.value ? { ...result, value: { ...result.value, assessments: [] } } : result; },
      readEvents: (taskId: string) => { const result = scenario.store.readEvents(taskId); return committed && corruption === 'events' ? { ...result, value: [] } : result; },
      readRequest: (id: string) => {
        const result = scenario.store.readRequest(id);
        return committed && result.value && (corruption === 'request' && id === 'decision-2' || corruption === 'previousRequest' && id === 'decision-1') ? { ...result, value: { ...result.value, createdRunId: 'foreign-run' } } : result;
      },
      loadTaskControl: (taskId: string) => {
        const result = scenario.store.loadTaskControl(taskId);
        if (!committed || !result.value) return result;
        return { ...result, value: { ...result.value, ...(corruption === 'controlEpoch' ? { epoch: 99 } : {}), ...(corruption === 'controlVersion' ? { version: 99 } : {}), ...(corruption === 'controlClaims' ? { outstandingClaimRefs: ['foreign-claim'] } : {}) } };
      },
    };
    const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
    await assert.rejects(service.requestDecision({ ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed }), error => error instanceof Error && error.message === 'approval-operation-denied', corruption);
    assert.equal((await scenario.service.list('task-1')).control.mode, 'waiting');
    assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
  }
});

test('replacement adapter cannot rewrite the host expected assessment or event through its input references', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const changed = `sha256:${'b'.repeat(64)}`;
  scenario.setContext({ ...scenario.current(), freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...scenario.current().facts, repositoryRevisionDigest: changed } });
  const store = { ...scenario.store, replaceStalePending: (input: unknown) => {
    assert.ok(input && typeof input === 'object' && 'assessment' in input && 'events' in input);
    const assessment = input.assessment;
    assert.ok(assessment && typeof assessment === 'object' && 'trustedContextDigest' in assessment);
    assessment.trustedContextDigest = digest;
    Object.assign(input, { trustedContextDigest: digest });
    assert.ok(Array.isArray(input.events) && input.events[1]);
    Object.assign(input.events[1], { eventId: 'foreign-event' });
    return scenario.store.replaceStalePending(input);
  } };
  const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
  await assert.rejects(service.requestDecision({ ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed }));
});

test('validated definite replacement refusal restores admission without releasing current waiting holds', async () => {
  for (const outcome of ['denied', 'conflict', 'invalid', 'stale'] as const) {
    const scenario = setup();
    await scenario.service.requestDecision(binding);
    const original = scenario.current();
    const waiting = (await scenario.service.list('task-1')).control;
    const changed = `sha256:${'b'.repeat(64)}`;
    scenario.setContext({ ...original, freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...original.facts, repositoryRevisionDigest: changed } });
    const store = { ...scenario.store, replaceStalePending: (input: unknown) => {
      scenario.store.failNext('replaceStalePending');
      const response = scenario.store.replaceStalePending(input);
      return { ...response, safe: { ...response.safe, outcome } };
    } };
    const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
    await assert.rejects(service.requestDecision({ ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed }));
    assert.deepEqual((await service.list('task-1')).control, waiting);
    scenario.setContext(original);
    const view = await service.show('task-1', 'decision-1');
    const response = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'approve-after-refusal' };
    await service.decide(response);
    assert.equal(await service.validateBinding(await service.resolve('decision-1')), true, outcome);
    await service.requestDecision({ ...binding, decisionId: 'decision-3' });
    const later = (await service.list('task-1')).control;
    assert.equal(later.mode, 'waiting');
    assert.equal((await service.decide(response)).outcome, 'ok');
    assert.deepEqual((await service.list('task-1')).control, later);
    assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
  }
});

test('a refusal receipt hiding a committed replacement remains closed until reconciliation', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const changed = `sha256:${'b'.repeat(64)}`;
  scenario.setContext({ ...scenario.current(), freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...scenario.current().facts, repositoryRevisionDigest: changed } });
  const store = { ...scenario.store, replaceStalePending: (input: unknown) => {
    const response = scenario.store.replaceStalePending(input);
    return { ...response, value: null, safe: { ...response.safe, outcome: 'conflict' as const, eventRef: null } };
  } };
  const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
  await assert.rejects(service.requestDecision({ ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed }));
  const view = await service.show('task-1', 'decision-2');
  await service.decide({ taskId: 'task-1', decisionId: 'decision-2', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'approve-after-hidden-commit' });
  assert.equal(await service.validateBinding(await service.resolve('decision-2')), false);
});

test('unavailable uncertain malformed and thrown replacement results retain closed admission', async () => {
  for (const failure of ['unavailable', 'uncertain', 'malformed', 'throw'] as const) {
    const scenario = setup();
    await scenario.service.requestDecision(binding);
    const original = scenario.current();
    const waiting = (await scenario.service.list('task-1')).control;
    const changed = `sha256:${'b'.repeat(64)}`;
    scenario.setContext({ ...original, freshness: { ...freshness, currentRepositoryRevisionDigest: changed }, facts: { ...original.facts, repositoryRevisionDigest: changed } });
    const store = { ...scenario.store, replaceStalePending: (input: unknown) => {
      scenario.store.failNext('replaceStalePending');
      const response = scenario.store.replaceStalePending(input);
      if (failure === 'throw') throw new Error('unsafe-adapter-message');
      return { ...response, safe: { ...response.safe, outcome: failure === 'malformed' ? 'conflict' as const : failure, ...(failure === 'malformed' ? { controlVersion: 99 } : {}) } };
    } };
    const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
    await assert.rejects(service.requestDecision({ ...binding, decisionId: 'decision-2', repositoryRevisionDigest: changed }), error => error instanceof Error && error.message === 'approval-operation-denied');
    assert.deepEqual((await service.list('task-1')).control, waiting);
    assert.equal(scenario.store.readRequest('decision-2').value, null);
    scenario.setContext(original);
    const view = await service.show('task-1', 'decision-1');
    await service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'approve-after-uncertainty' });
    assert.equal(await service.validateBinding(await service.resolve('decision-1')), false, failure);
  }
});

test('canonical service atomically pauses a required request and only stored human consent admits it', async () => {
  const { service, store } = setup();
  assert.equal(service.provenance, 'mock');
  assert.equal(await service.classify(action), 'APPROVAL_REQUIRED');
  assert.equal((await service.requestDecision(binding)).status, 'pending');
  assert.equal((await service.list('task-1')).control.mode, 'waiting');
  assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
  assert.equal((await service.resolve(binding.decisionId)).status, 'pending');
  assert.equal(store.readHistory('task-1').value?.resolutions.length, 0);
});

test('host decision checks displayed versions, persists once and reuses the original response on retry', async () => {
  const { service, store } = setup();
  await service.requestDecision(binding);
  const view = await service.show('task-1', 'decision-1');
  const response = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' };
  assert.equal((await service.decide(response)).outcome, 'ok');
  assert.equal(await service.validateBinding(await service.resolve('decision-1')), true);
  assert.equal((await service.decide(response)).outcome, 'ok');
  assert.equal(store.readHistory('task-1').value?.resolutions.length, 1);
  await assert.rejects(service.decide({ ...response, decision: 'reject' }));
  assert.equal((await service.resolve('decision-1')).status, 'approved');
});

test('presentation refuses protected payloads, terminal controls and uninspectable complete details', () => {
  for (const necessity of ['token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', '\u001b]0;approve\u0007', '\u202ereject', '\u009b31m']) {
    assert.throws(() => buildPresentation({ ...input, elements: { ...elements, necessity } }, profile), /unsafe-presentation/);
  }
  assert.throws(() => buildPresentation(input, { ...profile, maxPresentationPageBytes: 16, maxPresentationTotalBytes: 48 }), /unsafe-presentation/);
  assert.notEqual(buildPresentation(input, profile).summary.presentationDigest, buildPresentation({ ...input, requestVersion: 2 }, profile).summary.presentationDigest);
});

test('fresh context, exact identity and stored content are rechecked before consent and admission', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  const response = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' };
  for (const change of [{ taskId: 'other' }, { decisionId: 'foreign' }, { taskVersion: 99 }, { requestVersion: 99 }, { presentationDigest: digest }, { actorId: 'operator-1' }]) {
    await assert.rejects(scenario.service.decide({ ...response, ...change }));
  }
  scenario.setContext({ ...scenario.current(), elements: { ...elements, necessity: 'Changed display' } });
  await assert.rejects(scenario.service.decide(response));
  assert.equal(scenario.store.loadTaskControl('task-1').value?.mode, 'waiting');
  assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, 0);
  scenario.setContext({ ...scenario.current(), elements, facts: { ...scenario.current().facts, repositoryId: 'other-repository' } });
  await assert.rejects(scenario.service.show('task-1', 'decision-1'));
  assert.equal(await scenario.service.validateBinding({ ...binding, status: 'approved' }), false);
});

test('failed decision leaves waiting hold and host authority cannot come from input fields', async () => {
  const scenario = setup();
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  const response = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' };
  const unprivileged = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, context: scenario.context });
  await assert.rejects(unprivileged.decide(response));
  scenario.store.failNext('resolvePending');
  assert.equal((await scenario.service.decide(response)).outcome, 'unavailable');
  assert.equal((await scenario.service.list('task-1')).control.mode, 'waiting');
  assert.equal((await scenario.service.resolve('decision-1')).status, 'pending');
  assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, 0);
});

test('request retry reuses immutable creation and rejection never becomes valid admission', async () => {
  const scenario = setup();
  let clock = 0;
  const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, context: scenario.context, operator: scenario.operator, now: () => `2026-10-19T00:00:0${clock++}Z` });
  await service.requestDecision(binding);
  const original = scenario.store.readRequest('decision-1').value;
  await service.requestDecision(binding);
  assert.deepEqual(scenario.store.readRequest('decision-1').value, original);
  const view = await service.show('task-1', 'decision-1');
  const response = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'reject', responseKey: 'response-1' };
  assert.equal((await service.decide(response)).outcome, 'paused');
  const recorded = scenario.store.readHistory('task-1').value;
  assert.equal((await service.decide(response)).outcome, 'ok');
  assert.deepEqual(scenario.store.readHistory('task-1').value, recorded);
  assert.equal((await service.list('task-1')).control.mode, 'rejected');
  assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
});

test('missing store and stalled trusted context fail closed with bounded safe errors', async () => {
  const scenario = setup();
  const unavailable = createApprovalService({ taskId: 'task-1', profile, context: scenario.context });
  await assert.rejects(unavailable.classify(action), /approval-operation-denied/);
  const stalled = createApprovalService({ taskId: 'task-1', profile: { ...profile, operationDeadlineMs: 20, commandRules: [{ ...profile.commandRules[0], timeoutMs: 20 }] }, store: scenario.store, context: { loadForAction: () => new Promise(() => { /* Simulate absent host response. */ }), loadForDecision: () => new Promise(() => { /* Simulate absent host response. */ }) } });
  await assert.rejects(stalled.classify(action), /approval-operation-denied/);
});

test('preexisting pause and a pause during fresh context loading deny classification', async () => {
  const scenario = setup();
  scenario.context.loadForAction = async () => { await scenario.service.requestDecision(binding); return scenario.current(); };
  await assert.rejects(scenario.service.classify(action), /approval-operation-denied/);
  await assert.rejects(scenario.service.classify(action), /approval-operation-denied/);
  assert.equal((await scenario.service.list('task-1')).control.mode, 'waiting');
});

test('fix-plan request fields must describe the exact registered plan action', async () => {
  const scenario = setup();
  const plan: NormalizedAction = { actionId: 'plan-1', kind: 'approve_fix_plan', planVersion: 1, strategyDigest: digest, diagnosisEvidenceRefs: ['evidence-1'], checkSetDigest: digest };
  const planFields = { planVersion: 2, strategyDigest: digest, baselineRef: 'baseline-1', evidenceRefs: ['evidence-1'], criteriaDigest: digest, checkSetDigest: digest };
  const planBinding = { ...binding, ...planFields, actionKind: 'fix_plan' as const, normalizedActionDigest: computeActionDigest(plan) };
  scenario.setContext({ ...scenario.current(), action: plan, facts: { ...scenario.current().facts, registeredActionDigest: computeActionDigest(plan), command: null }, freshness: { ...freshness, currentNormalizedActionDigest: computeActionDigest(plan), currentPlanVersion: 2, currentStrategyDigest: digest, currentBaselineRef: 'baseline-1', currentEvidenceRefs: ['evidence-1'], currentCriteriaDigest: digest, currentCheckSetDigest: digest } });
  await assert.rejects(scenario.service.requestDecision(planBinding));
  assert.equal(scenario.store.readRequest('decision-1').value, null);
});

test('maximum bounded request and response identities remain recordable', async () => {
  const scenario = setup();
  const longBinding = { ...binding, decisionId: 'd'.repeat(127) };
  await scenario.service.requestDecision(longBinding);
  const view = await scenario.service.show('task-1', longBinding.decisionId);
  const response = await scenario.service.decide({ taskId: 'task-1', decisionId: longBinding.decisionId, taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'r'.repeat(127) });
  assert.equal(response.outcome, 'ok');
  assert.equal((response.eventRef ?? '').length <= 127, true);
});

test('identical response keys on unrelated tasks have distinct journal identities', async () => {
  const scenario = setup();
  const initial = scenario.store.loadTaskControl('task-1').value;
  assert.ok(initial);
  const store = createMockApprovalStore({ profile, initialControls: [initial, { ...initial, taskId: 'task-2' }] });
  const context2 = { ...scenario.current(), facts: { ...scenario.current().facts, taskId: 'task-2' }, freshness: { ...freshness, currentTaskId: 'task-2' } };
  const context = { loadForAction: async (taskId: string) => taskId === 'task-1' ? scenario.current() : context2, loadForDecision: async (decisionId: string) => decisionId === 'decision-1' ? scenario.current() : context2 };
  const eventRefs: (string | null)[] = [];
  for (const [taskId, decisionId] of [['task-1', 'decision-1'], ['task-2', 'decision-2']] as const) {
    const service = createApprovalService({ taskId, profile, store, context, operator: scenario.operator });
    await service.requestDecision({ ...binding, taskId, decisionId });
    const view = await service.show(taskId, decisionId);
    const response = await service.decide({ taskId, decisionId, taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'same-key' });
    assert.equal(response.outcome, 'ok');
    eventRefs.push(response.eventRef);
  }
  assert.notEqual(eventRefs[0], eventRefs[1]);
});

test('a delayed provider cannot start a pending or decision mutation after its operation timed out', async () => {
  for (const operation of ['request', 'decide']) {
    const scenario = setup();
    let release: ((value: ApprovalContext) => void) | undefined;
    const delayed = new Promise<ApprovalContext>(resolve => { release = resolve; });
    if (operation === 'decide') await scenario.service.requestDecision(binding);
    const view = operation === 'decide' ? await scenario.service.show('task-1', 'decision-1') : undefined;
    const service = createApprovalService({ taskId: 'task-1', profile: { ...profile, operationDeadlineMs: 20, commandRules: [{ ...profile.commandRules[0], timeoutMs: 20 }] }, store: scenario.store,
      context: { loadForAction: async () => scenario.current(), loadForDecision: () => delayed }, operator: scenario.operator });
    const pending = operation === 'request' ? service.requestDecision(binding) : service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view?.control.version, requestVersion: 1, presentationDigest: view?.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' });
    await assert.rejects(pending, /approval-operation-denied/);
    assert.ok(release);
    release(scenario.current());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scenario.store.loadTaskControl('task-1').value?.mode, operation === 'request' ? 'runnable' : 'waiting');
    assert.equal(scenario.store.readHistory('task-1').value?.resolutions.length, 0);
  }
});

test('public reads reject protected stored control metadata without leaking its reason', async () => {
  const scenario = setup();
  const store = { ...scenario.store, loadTaskControl: (taskId: string) => {
    const result = scenario.store.loadTaskControl(taskId);
    return { ...result, value: result.value === null ? null : { ...result.value, reasonCode: 'MARKER_SECRET_DO_NOT_DISCLOSE' } };
  } };
  const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
  await assert.rejects(service.list('task-1'), error => error instanceof Error && error.message === 'approval-operation-denied');
});

test('UTF-8 inspection pages retain all exact patch bytes and refuse oversized content', () => {
  const patch: NormalizedAction = { actionId: 'patch-1', kind: 'apply_patch', targetPaths: ['src/a.py'], baseRevisionDigest: digest, patchContent: `--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-old\n+${'é'.repeat(5000)}\n` };
  const patchInput = { ...input, action: patch, binding: { ...binding, normalizedActionDigest: computeActionDigest(patch) }, freshness: { ...freshness, currentNormalizedActionDigest: computeActionDigest(patch) } };
  const result = buildPresentation(patchInput, profile);
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages.join(''), JSON.stringify(patch));
  assert.equal(result.pages.every(page => Buffer.byteLength(page) <= 8192 && !page.includes('\ufffd')), true);
  const tooBig = { ...patch, patchContent: patch.patchContent.repeat(3) };
  assert.throws(() => buildPresentation({ ...patchInput, action: tooBig, binding: { ...binding, normalizedActionDigest: computeActionDigest(tooBig) }, freshness: { ...freshness, currentNormalizedActionDigest: computeActionDigest(tooBig) } }, profile), /unsafe-presentation/);
  assert.throws(() => Reflect.apply(buildPresentation, undefined, [undefined, profile]), error => error instanceof Error && error.message === 'unsafe-presentation');
});

test('failed pending persistence closes local agent admission instead of trusting a runnable snapshot', async () => {
  const scenario = setup();
  scenario.store.failNext('createPendingAndPause');
  await assert.rejects(scenario.service.requestDecision(binding));
  await assert.rejects(scenario.service.classify(action));
  assert.equal(await scenario.service.validateBinding({ ...binding, status: 'approved' }), false);
});

test('a corrupted decision receipt never leaks protected metadata or admits work after an accepted resolution', async () => {
  for (const change of [{ eventRef: 'MARKER_SECRET_DO_NOT_DISCLOSE' }, { eventRef: 'foreign-event' }, { controlVersion: 99 }]) {
    const scenario = setup();
    await scenario.service.requestDecision(binding);
    const view = await scenario.service.show('task-1', 'decision-1');
    const store = { ...scenario.store, resolvePending: (input: unknown) => {
      const response = scenario.store.resolvePending(input);
      return { ...response, safe: { ...response.safe, ...change } };
    } };
    const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
    const input = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' };
    await assert.rejects(service.decide(input), error => error instanceof Error && error.message === 'approval-operation-denied');
    const accepted = await service.resolve('decision-1');
    assert.equal(accepted.status, 'approved');
    assert.equal(await service.validateBinding(accepted), false);
    await assert.rejects(service.classify(action));
    await assert.rejects(service.decide({ ...input, decision: 'reject' }));
    assert.deepEqual(await service.resolve('decision-1'), accepted);
  }
});

test('an uncertain decision requires reconciliation whether its commit happened or not', async () => {
  for (const committed of [false, true]) {
    const scenario = setup();
    await scenario.service.requestDecision(binding);
    const view = await scenario.service.show('task-1', 'decision-1');
    const store = { ...scenario.store, resolvePending: (input: unknown) => {
      if (!committed) scenario.store.failNext('resolvePending');
      const response = scenario.store.resolvePending(input);
      return { ...response, value: null, safe: { ...response.safe, outcome: 'uncertain' as const } };
    } };
    const service = createApprovalService({ taskId: 'task-1', profile, store, context: scenario.context, operator: scenario.operator });
    const response = await service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'response-1' });
    assert.equal(response.outcome, 'uncertain');
    assert.equal(response.safeReasonCode, 'decision-reconciliation-required');
    assert.equal(response.safeNextAction, 'reconcile');
    assert.equal(response.eventRef, null);
    assert.equal((await service.resolve('decision-1')).status, committed ? 'approved' : 'pending');
    assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
    await assert.rejects(service.classify(action));
  }
});

test('retrying an earlier approval preserves a later pending request and prior admission state', async () => {
  for (const admissionClosed of [false, true]) {
    const { service, store } = setup();
    await service.requestDecision(binding);
    const first = await service.show('task-1', 'decision-1');
    const responseA = { taskId: 'task-1', decisionId: 'decision-1', taskVersion: first.control.version, requestVersion: 1, presentationDigest: first.presentation.presentationDigest, decision: 'approve', responseKey: 'response-a' };
    const accepted = await service.decide(responseA);
    assert.equal(accepted.outcome, 'ok');
    const bindingB = { ...binding, decisionId: 'decision-2' };
    await service.requestDecision(bindingB);
    const waiting = await service.show('task-1', 'decision-2');
    const responseB = { ...responseA, decisionId: 'decision-2', taskVersion: waiting.control.version, presentationDigest: waiting.presentation.presentationDigest, responseKey: 'response-b' };
    if (admissionClosed) {
      store.failNext('resolvePending');
      assert.equal((await service.decide(responseB)).outcome, 'unavailable');
    }
    const retried = await service.decide(responseA);
    assert.equal(retried.outcome, 'ok');
    assert.equal(retried.eventRef, accepted.eventRef);
    assert.deepEqual((await service.list('task-1')).control, waiting.control);
    assert.equal(await service.validateBinding({ ...binding, status: 'approved' }), false);
    await assert.rejects(service.classify(action));
    assert.equal((await service.decide(responseB)).outcome, 'ok');
    assert.equal(await service.validateBinding(await service.resolve('decision-2')), !admissionClosed);
    assert.equal((await service.resolve('decision-1')).status, 'approved');
  }
});

test('provider contexts reject arrays, accessors and incomplete fields before reading untrusted properties', async () => {
  const scenario = setup();
  let getterReads = 0;
  const accessor = (object: object, key: string, value: unknown): object => Object.defineProperty({ ...object }, key, { enumerable: true, get: () => { getterReads += 1; return value; } });
  const current = scenario.current();
  const invalid: readonly unknown[] = [
    Object.assign([], current),
    accessor(current, 'action', action),
    { ...current, facts: accessor(current.facts, 'taskId', 'task-1') },
    { ...current, freshness: accessor(freshness, 'currentTaskId', 'task-1') },
    { ...current, elements: accessor(elements, 'necessity', elements.necessity) },
    { ...current, runId: undefined },
    { ...current, facts: { ...current.facts, repositoryId: undefined } },
    { ...current, freshness: {} },
    { ...current, elements: { ...elements, verificationStatus: undefined } },
  ];
  for (const raw of invalid) {
    const service = createApprovalService({ taskId: 'task-1', profile, store: scenario.store, context: { loadForAction: async () => raw, loadForDecision: async () => raw }, operator: scenario.operator });
    await assert.rejects(service.classify(action), /approval-operation-denied/);
    await assert.rejects(service.requestDecision(binding), /approval-operation-denied/);
  }
  assert.equal(getterReads, 0);
  assert.equal((await scenario.service.list('task-1')).control.mode, 'runnable');
  assert.equal(await scenario.service.classify(action), 'APPROVAL_REQUIRED');
});
test('v0.2 service: evaluatePolicy issues valid immutable PolicyEvaluationReceipt and respects pause', async () => {
  const scenario = setup();
  const beforeControl = scenario.store.loadTaskControl('task-1');
  const beforeHistory = scenario.store.readHistory('task-1');
  const callerDigest = `sha256:${'f'.repeat(64)}`;
  const receipt = await scenario.service.evaluatePolicy(action, { decisionAuthorityGeneration: 999, freshnessContextDigest: callerDigest });
  assert.equal(receipt.result, 'APPROVAL_REQUIRED');
  assert.equal(receipt.decisionAuthorityGeneration, scenario.service.decisionAuthorityGeneration);
  assert.equal(receipt.freshnessContextDigest, computeCanonicalSha256({ action, facts: scenario.current().facts, policyIdentity: identity, decisionAuthorityGeneration: 1 }));
  assert.notEqual(receipt.freshnessContextDigest, callerDigest);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(validatePolicyEvaluationReceipt(receipt).ok, true);
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), beforeControl);
  assert.deepEqual(scenario.store.readHistory('task-1'), beforeHistory);
  await scenario.service.requestDecision(binding);
  await assert.rejects(
    scenario.service.evaluatePolicy(action),
    error => error instanceof ApprovalServiceError && error.outcome === 'paused'
  );
});

test('v0.2 service: admitProvider binds every role/plan branch to trusted full request facts and service generation', async () => {
  const scenario = setup();
  const original = scenario.current();
  for (const role of ['coder', 'reviewer'] as const) {
    for (const applicability of ['pre-plan-diagnostic', 'approved-plan'] as const) {
      const request = providerRequest(role, applicability, `provider-req-${role}-${applicability}`);
      scenario.setContext({ ...original, facts: providerFacts(original, request, applicability) });
      const receipt = await scenario.service.admitProvider(request, {
        decisionAuthorityGeneration: 999,
        planApplicability: applicability,
        ...(applicability === 'pre-plan-diagnostic' ? { diagnosticPurpose: request.purpose, taskCriteriaDigest: digest } : {}),
      });
      assert.equal(receipt.role, role);
      assert.equal(receipt.policyId, identity.policyId);
      assert.equal(receipt.policyVersion, identity.policyVersion);
      assert.equal(receipt.planApplicability, applicability);
      assert.equal(receipt.decisionAuthorityGeneration, scenario.service.decisionAuthorityGeneration);
      assert.equal(receipt.requestContentDigest, computeRequestContentDigest(request));
      assert.equal(Object.isFrozen(receipt), true);
      assert.equal(validateProviderAdmissionReceipt(receipt).ok, true);
    }
  }
  scenario.setContext(original);
  await scenario.service.requestDecision(binding);
  await assert.rejects(
    scenario.service.admitProvider(providerRequest('coder', 'approved-plan', 'provider-req-paused')),
    error => error instanceof ApprovalServiceError && error.outcome === 'paused'
  );
});

test('v0.2 service replays the retained provider receipt for the same caller receipt ID', async () => {
  const scenario = setup();
  const original = scenario.current();
  const request = providerRequest('coder', 'pre-plan-diagnostic', 'provider-request-exact-replay');
  scenario.setContext({ ...original, facts: providerFacts(original, request, 'pre-plan-diagnostic') });
  const options = {
    receiptId: 'caller-provider-receipt',
    planApplicability: 'pre-plan-diagnostic' as const,
    diagnosticPurpose: request.purpose,
    taskCriteriaDigest: digest,
  };

  const first = await scenario.service.admitProvider(request, options);
  const replay = await scenario.service.admitProvider(request, options);
  assert.deepEqual(replay, first);
  assert.equal(replay, first);
});

test('v0.2 service refuses a changed provider request that reuses a retained receipt ID without changing approval state', async () => {
  const scenario = setup();
  const original = scenario.current();
  const request = providerRequest('reviewer', 'pre-plan-diagnostic', 'provider-request-collision');
  scenario.setContext({ ...original, facts: providerFacts(original, request, 'pre-plan-diagnostic') });
  const options = {
    receiptId: 'caller-provider-receipt-collision',
    planApplicability: 'pre-plan-diagnostic' as const,
    diagnosticPurpose: request.purpose,
    taskCriteriaDigest: digest,
  };
  const first = await scenario.service.admitProvider(request, options);
  const beforeControl = scenario.store.loadTaskControl('task-1');
  const beforeHistory = scenario.store.readHistory('task-1');
  const changed = { ...request, contextDigest: `sha256:${'b'.repeat(64)}` };
  scenario.setContext({ ...original, facts: providerFacts(original, changed, 'pre-plan-diagnostic') });

  await assert.rejects(scenario.service.admitProvider(changed, options), error =>
    error instanceof ApprovalServiceError && error.outcome === 'conflict'
  );
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), beforeControl);
  assert.deepEqual(scenario.store.readHistory('task-1'), beforeHistory);

  scenario.setContext({ ...original, facts: providerFacts(original, request, 'pre-plan-diagnostic') });
  const read = versionedRead<ProviderAdmissionReceipt>(scenario.service, 'readProviderAdmissionReceipt');
  assert.equal(await read(first.receiptId), first);
});

test('v0.2 provider receipt lookup revalidates current trusted request and authority', async () => {
  const scenario = setup();
  const original = scenario.current();
  const request = providerRequest('coder', 'approved-plan', 'provider-request-freshness');
  scenario.setContext({ ...original, facts: providerFacts(original, request, 'approved-plan') });
  const receipt = await scenario.service.admitProvider(request, { planApplicability: 'approved-plan' });
  const read = versionedRead<ProviderAdmissionReceipt>(scenario.service, 'readProviderAdmissionReceipt');
  assert.equal(await read(receipt.receiptId), receipt);
  await assert.rejects(read('never-issued-provider-receipt'), error => error instanceof ApprovalServiceError && error.outcome === 'denied');

  const beforeControl = scenario.store.loadTaskControl('task-1');
  const beforeHistory = scenario.store.readHistory('task-1');
  const changed = { ...request, maxInputTokens: request.maxInputTokens + 1 };
  scenario.setContext({ ...original, facts: providerFacts(original, changed, 'approved-plan') });
  await assert.rejects(read(receipt.receiptId), error => error instanceof ApprovalServiceError && error.outcome === 'stale');
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), beforeControl);
  assert.deepEqual(scenario.store.readHistory('task-1'), beforeHistory);

  scenario.setContext({ ...original, facts: providerFacts(original, request, 'approved-plan') });
  assert.equal(await read(receipt.receiptId), receipt);
});

test('v0.2 service: a provider context load failure denies without fabricating trusted safety facts or changing state', async () => {
  const scenario = setup();
  const beforeControl = scenario.store.loadTaskControl('task-1');
  const beforeHistory = scenario.store.readHistory('task-1');
  const failedContextService = createApprovalService({
    taskId: 'task-1', profile, store: scenario.store, operator: scenario.operator,
    context: { ...scenario.context, loadForAction: async () => { throw new Error('provider context unavailable'); } },
  });
  await assert.rejects(failedContextService.admitProvider(providerRequest('coder', 'pre-plan-diagnostic', 'provider-req-no-context')),
    error => error instanceof ApprovalServiceError && error.outcome === 'unavailable');
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), beforeControl);
  assert.deepEqual(scenario.store.readHistory('task-1'), beforeHistory);
});

test('v0.2 service: malformed provider envelopes and accessor options deny before context reads or authority changes', async () => {
  const scenario = setup();
  const beforeControl = scenario.store.loadTaskControl('task-1');
  const beforeHistory = scenario.store.readHistory('task-1');
  let contextReads = 0;
  let getterReads = 0;
  const countingService = createApprovalService({
    taskId: 'task-1', profile, store: scenario.store, operator: scenario.operator,
    context: { ...scenario.context, loadForAction: async () => { contextReads += 1; return scenario.current(); } },
  });
  const request = providerRequest('coder', 'pre-plan-diagnostic', 'provider-req-invalid');
  const accessorRequest = Object.defineProperty({ ...request }, 'providerId', { enumerable: true, get: () => { getterReads += 1; return 'provider-1'; } });
  await assert.rejects(countingService.admitProvider(accessorRequest), error => error instanceof ApprovalServiceError && error.outcome === 'invalid');
  const accessorOptions = Object.defineProperty({}, 'role', { enumerable: true, get: () => { getterReads += 1; return 'coder'; } });
  await assert.rejects(countingService.admitProvider(request, accessorOptions as never), error => error instanceof ApprovalServiceError && error.outcome === 'invalid');
  assert.equal(getterReads, 0);
  assert.equal(contextReads, 0);
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), beforeControl);
  assert.deepEqual(scenario.store.readHistory('task-1'), beforeHistory);
});

test('v0.2 service: issueActionDecision issues valid ActionDecisionReceipt for approved decision', async () => {
  const scenario = setup();
  const evaluation = await scenario.service.evaluatePolicy(action);
  assert.equal(evaluation.result, 'APPROVAL_REQUIRED');
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  await scenario.service.decide({
    taskId: 'task-1',
    decisionId: 'decision-1',
    taskVersion: view.control.version,
    requestVersion: 1,
    presentationDigest: view.presentation.presentationDigest,
    decision: 'approve',
    responseKey: 'approve-action-1',
  });
  const decisionReceipt = await scenario.service.issueActionDecision('decision-1', evaluation.receiptId);
  const replay = await scenario.service.issueActionDecision('decision-1', evaluation.receiptId);
  assert.equal(replay, decisionReceipt);
  const read = versionedRead<ActionDecisionReceipt>(scenario.service, 'readActionDecisionReceipt');
  assert.equal(await read('decision-1'), decisionReceipt);
  assert.equal(decisionReceipt.status, 'approved');
  assert.equal(decisionReceipt.decisionId, 'decision-1');
  assert.equal(decisionReceipt.evaluationReceiptRef, evaluation.receiptId);
  assert.equal(decisionReceipt.actionDigest, computeActionDigest(action));
  assert.equal(decisionReceipt.decisionAuthorityGeneration, scenario.service.decisionAuthorityGeneration);
  assert.equal(Object.isFrozen(decisionReceipt), true);
  assert.equal(validateActionDecisionReceipt(decisionReceipt).ok, true);
  await assert.rejects(
    scenario.service.issueActionDecision('nonexistent-decision', evaluation.receiptId),
    error => error instanceof ApprovalServiceError && (error.outcome === 'unavailable' || error.outcome === 'invalid')
  );
});

test('v0.2 action-decision lookup revalidates current approval and policy freshness', async () => {
  const scenario = setup();
  const evaluation = await scenario.service.evaluatePolicy(action);
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'approve-action-freshness' });
  const receipt = await scenario.service.issueActionDecision('decision-1', evaluation.receiptId);
  const read = versionedRead<ActionDecisionReceipt>(scenario.service, 'readActionDecisionReceipt');
  assert.equal(await read('decision-1'), receipt);
  await assert.rejects(read('never-issued-action-decision'), error => error instanceof ApprovalServiceError && error.outcome === 'denied');

  const beforeControl = scenario.store.loadTaskControl('task-1');
  const beforeHistory = scenario.store.readHistory('task-1');
  const current = scenario.current();
  scenario.setContext({ ...current, facts: { ...current.facts, taskStateVersion: 2 } as ApprovalContext['facts'] });
  await assert.rejects(read('decision-1'), error => error instanceof ApprovalServiceError && error.outcome === 'stale');
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), beforeControl);
  assert.deepEqual(scenario.store.readHistory('task-1'), beforeHistory);

  scenario.setContext(current);
  assert.equal(await read('decision-1'), receipt);
});

test('v0.2 action-decision receipt ID collision refuses a changed valid evaluation without replacing authority', async () => {
  const scenario = setup();
  const evaluation = await scenario.service.evaluatePolicy(action);
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'approve-action-collision' });
  const originalReceipt = await scenario.service.issueActionDecision('decision-1', evaluation.receiptId);
  const beforeControl = scenario.store.loadTaskControl('task-1');
  const beforeHistory = scenario.store.readHistory('task-1');
  const alternateEvaluation = await scenario.service.evaluatePolicy(action, { receiptId: 'caller-evaluation-receipt-2' });

  await assert.rejects(scenario.service.issueActionDecision('decision-1', alternateEvaluation.receiptId), error =>
    error instanceof ApprovalServiceError && error.outcome === 'conflict'
  );
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), beforeControl);
  assert.deepEqual(scenario.store.readHistory('task-1'), beforeHistory);
  const read = versionedRead<ActionDecisionReceipt>(scenario.service, 'readActionDecisionReceipt');
  assert.equal(await read('decision-1'), originalReceipt);
});

test('v0.2 service: issueActionDecision rejects unknown, forged, forbidden and foreign-action evaluations without authority writes', async () => {
  const scenario = setup();
  const current = scenario.current();
  const evaluation = await scenario.service.evaluatePolicy(action);
  const otherAction: NormalizedAction = { ...action, actionId: 'action-foreign' };
  scenario.setContext({ ...current, action: otherAction, facts: { ...current.facts, registeredActionDigest: computeActionDigest(otherAction) } });
  const foreignEvaluation = await scenario.service.evaluatePolicy(otherAction);
  scenario.setContext({ ...current, facts: { ...current.facts, role: 'reviewer' } });
  const forbiddenEvaluation = await scenario.service.evaluatePolicy(action);
  assert.equal(forbiddenEvaluation.result, 'FORBIDDEN');
  scenario.setContext(current);
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'approve-evaluation-refs' });
  const beforeControl = scenario.store.loadTaskControl('task-1');
  const beforeHistory = scenario.store.readHistory('task-1');
  const forged = {
    ...evaluation,
    result: 'ALLOWED' as const,
  };
  const authenticatedForgery = { ...forged, receiptDigest: computePolicyEvaluationReceiptDigest(forged) };
  const staleGeneration = { ...evaluation, decisionAuthorityGeneration: 999 };
  const authenticatedStaleGeneration = { ...staleGeneration, receiptDigest: computePolicyEvaluationReceiptDigest(staleGeneration) };
  for (const ref of ['never-issued-evaluation', foreignEvaluation.receiptId, forbiddenEvaluation.receiptId]) {
    await assert.rejects(scenario.service.issueActionDecision('decision-1', ref), error => error instanceof ApprovalServiceError);
  }
  await assert.rejects(scenario.service.issueActionDecision('decision-1', authenticatedForgery), error => error instanceof ApprovalServiceError);
  await assert.rejects(scenario.service.issueActionDecision('decision-1', authenticatedStaleGeneration), error => error instanceof ApprovalServiceError);
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), beforeControl);
  assert.deepEqual(scenario.store.readHistory('task-1'), beforeHistory);
});

test('v0.2 service: action authority is rechecked after the awaited current-context load', async () => {
  const scenario = setup();
  const evaluation = await scenario.service.evaluatePolicy(action);
  await scenario.service.requestDecision(binding);
  const view = await scenario.service.show('task-1', 'decision-1');
  await scenario.service.decide({ taskId: 'task-1', decisionId: 'decision-1', taskVersion: view.control.version, requestVersion: 1, presentationDigest: view.presentation.presentationDigest, decision: 'approve', responseKey: 'approve-before-current-authority-change' });

  let endState: { control: unknown; history: unknown } | undefined;
  const racingService: ReturnType<typeof createApprovalService> = createApprovalService({
    taskId: 'task-1', profile, store: scenario.store, operator: scenario.operator, activity: createMockActivityControl(profile),
    context: {
      ...scenario.context,
      loadForTask: async () => ({ taskId: 'task-1', repositoryId: 'repository-1', workspaceId: 'workspace-1', runId: 'run-1', safeScopeRef: 'scope-1', policyIdentity: identity }),
      loadForDecision: async () => {
        const currentControl = scenario.store.loadTaskControl('task-1').value;
        assert.ok(currentControl);
        await racingService.control({ taskId: 'task-1', taskVersion: currentControl.version, direction: 'end', responseKey: 'end-during-evaluation-load' });
        endState = { control: scenario.store.loadTaskControl('task-1'), history: scenario.store.readHistory('task-1') };
        return scenario.current();
      },
    },
  });
  await assert.rejects(racingService.issueActionDecision('decision-1', evaluation.receiptId), error => error instanceof ApprovalServiceError);
  assert.ok(endState);
  assert.deepEqual(scenario.store.loadTaskControl('task-1'), endState.control);
  assert.deepEqual(scenario.store.readHistory('task-1'), endState.history);
});
