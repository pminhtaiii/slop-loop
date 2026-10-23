import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalizedAction } from '../../../src/contracts/foundation/uc03.ts';
import { computeActionDigest, computeCanonicalSha256, computeRequestContentDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { PolicyProfile } from '../../../src/contracts/approvals/contracts.ts';
import {
  validatePolicyEvaluationReceipt,
  validateProviderAdmissionReceipt,
} from '../../../src/contracts/approvals/contracts.ts';
import { compilePolicy, evaluatePolicyV02 } from '../../../src/approvals/policy.ts';
import type { PolicyFacts, PolicyClassification } from '../../../src/approvals/policy.ts';
import { computePlanBindingDigest } from '../../../src/approvals/plan-binding.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const identity = { policyId: 'policy-1', policyVersion: '1', configId: 'config-1', configVersion: '1' };
const profile: PolicyProfile = {
  schemaVersion: 'uc05-approval/0.1-draft', profileId: 'uc05-local-v1', profileVersion: '1',
  policyIdentity: identity, supportedActionKinds: ['run_command', 'apply_patch', 'approve_fix_plan'],
  commandRules: [{ ruleId: 'tests', executableRef: 'pytest', argvPrefix: ['-q', 'tests/'], workingDirectoryRef: 'repository-root', timeoutMs: 2000, maxOutputBytes: 8192 }],
  sensitivePaths: ['.github/workflows', 'pyproject.toml'], patchBreadth: { maxFiles: 8, maxAddedDeletedLines: 400 },
  maxActionBytes: 65536, maxArgvEntries: 32, maxArgvEntryBytes: 4096,
  maxPresentationPageBytes: 8192, maxPresentationPages: 3, maxPresentationTotalBytes: 24576,
  maxEventBytes: 1024, operationDeadlineMs: 2000, maxMutationAttempts: 1,
  diagnosticRules: { maxBytes: 1024, redactSecrets: true, allowRawArtifacts: false, retainUnresolvedDecisions: true },
};
const command: NormalizedAction = { actionId: 'action-1', kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/'], workingDirectory: '/workspace' };
const patch: NormalizedAction = { actionId: 'patch-1', kind: 'apply_patch', patchContent: '--- a/src/auth.py\n+++ b/src/auth.py\n@@ -1 +1 @@\n-old\n+new\n', targetPaths: ['src/auth.py'], baseRevisionDigest: digest };

function approvedPlan(): NonNullable<PolicyFacts['plan']> {
  const binding = {
    decisionId: 'plan-decision-1', actionKind: 'fix_plan' as const, normalizedActionDigest: digest,
    taskId: 'task-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest,
    policyId: identity.policyId, policyVersion: identity.policyVersion, status: 'approved' as const,
    planVersion: 1, strategyDigest: digest, baselineRef: 'baseline-1', evidenceRefs: ['evidence-1'], criteriaDigest: digest, checkSetDigest: digest,
  };
  return { binding, context: {
    currentTaskId: binding.taskId, currentWorkspaceId: binding.workspaceId, currentRepositoryRevisionDigest: digest,
    currentPolicyId: identity.policyId, currentPolicyVersion: identity.policyVersion, currentNormalizedActionDigest: digest,
    currentPlanVersion: 1, currentStrategyDigest: digest, currentBaselineRef: 'baseline-1', currentEvidenceRefs: ['evidence-1'], currentCriteriaDigest: digest, currentCheckSetDigest: digest,
  }, materialChange: false, replanSlot: null };
}

function permission(result: PolicyClassification): string {
  return result.ok ? result.permission : result.reasonCode;
}

/** Test-only trusted-provider output; these facts establish no real executor safety. */
function factsFor(action: NormalizedAction): PolicyFacts {
  return {
    taskId: 'task-1', workspaceId: 'workspace-1', repositoryId: 'repository-1', repositoryRevisionDigest: digest,
    policyIdentity: identity, registeredActionDigest: computeActionDigest(action), continuationRef: 'continuation-1', role: 'coder',
    safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
    command: action.kind === 'run_command' ? { executableRef: action.executable, resolvedExecutable: action.executable, workingDirectoryRef: 'repository-root', workingDirectory: action.workingDirectory, constrainedCapability: null } : null,
    patch: action.kind === 'apply_patch' ? { fileCount: action.targetPaths.length, addedDeletedLines: 2, dependencyChange: false, deletion: false, structuralChange: false, sensitiveConfiguration: false, productionCode: true } : null,
    plan: null,
  };
}

function planDigest(plan: NonNullable<PolicyFacts['plan']>): string {
  return computePlanBindingDigest({
    taskId: plan.binding.taskId,
    planVersion: plan.binding.planVersion,
    strategyDigest: plan.binding.strategyDigest,
    baselineRef: plan.binding.baselineRef,
    evidenceRefs: plan.binding.evidenceRefs,
    criteriaDigest: plan.binding.criteriaDigest,
    checkSetDigest: plan.binding.checkSetDigest,
    decisionRef: plan.binding.decisionId,
  });
}

function factsV02(
  action: NormalizedAction,
  applicability: 'pre-plan-diagnostic' | 'approved-plan' = 'pre-plan-diagnostic',
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const plan = applicability === 'approved-plan' ? approvedPlan() : null;
  const prePlan = applicability === 'pre-plan-diagnostic';
  return {
    ...factsFor(action),
    runId: 'run-1',
    taskStateVersion: 3,
    taskNode: prePlan ? 'Investigate' : 'Patch',
    planApplicability: applicability,
    diagnosticPurpose: prePlan ? 'reproduction_check' : null,
    taskCriteriaDigest: prePlan ? digest : null,
    checkSetDigest: prePlan ? digest : plan?.binding.checkSetDigest ?? null,
    testPath: prePlan ? 'tests/' : null,
    checkId: prePlan ? 'focused-tests' : null,
    planBindingDigest: plan === null ? null : planDigest(plan),
    planDecisionRef: plan?.binding.decisionId ?? null,
    providerRequest: null,
    plan,
    ...extras,
  };
}

function providerRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerRequestId: 'provider-request-1',
    taskId: 'task-1',
    runId: 'run-1',
    role: 'coder',
    purpose: 'reproduction_check',
    providerId: 'provider-1',
    modelId: 'model-1',
    configId: identity.configId,
    pricingPolicyId: 'pricing-1',
    contextDigest: digest,
    timeoutMs: 2_000,
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxBillableTokens: 220,
    maxCostUsd: 0.25,
    reservationRef: 'reservation-1',
    dispatchState: 'reserved',
    ...overrides,
  };
}

function providerFacts(request: Record<string, unknown>, applicability: 'pre-plan-diagnostic' | 'approved-plan'): Record<string, unknown> {
  return factsV02(command, applicability, {
    taskId: request['taskId'],
    runId: request['runId'],
    role: request['role'],
    diagnosticPurpose: applicability === 'pre-plan-diagnostic' ? request['purpose'] : null,
    providerRequest: request,
  });
}

function policy(): ReturnType<typeof compilePolicy> & { ok: true } {
  const compiled = compilePolicy(profile);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error('invalid test profile');
  return compiled;
}

test('an exact configured bounded command is allowed without a prompt', () => {
  assert.deepEqual(policy().value.classify(command, factsFor(command)), {
    ok: true, permission: 'ALLOWED', reasonCode: 'configured-command', actionDigest: computeActionDigest(command),
  });
});

test('missing, malformed, unknown or unbound trusted facts cannot authorize a command', () => {
  const facts = factsFor(command);
  for (const input of [undefined, {}, { ...facts, safe: true }, { ...facts, registeredActionDigest: digest },
    { ...facts, policyIdentity: { ...identity, configVersion: '2' } }, { ...facts, role: 'model' },
    { ...facts, safety: { ...facts.safety, isolated: undefined } }, { ...facts, repositoryId: '' }]) {
    assert.equal(policy().value.classify(command, input).ok, false);
  }
});

test('hard boundaries and reviewer authority cannot be overridden by a configured command', () => {
  const facts = factsFor(command);
  for (const key of Object.keys(facts.safety)) {
    const result = policy().value.classify(command, { ...facts, safety: { ...facts.safety, [key]: false } });
    if (key === 'isolated') assert.equal(result.ok, false);
    else assert.deepEqual(result, { ok: true, permission: 'FORBIDDEN', reasonCode: 'hard-boundary', actionDigest: computeActionDigest(command) });
  }
  assert.equal(permission(policy().value.classify(command, { ...facts, role: 'reviewer' })), 'FORBIDDEN');
});

test('ordinary authentication source edits need an exact approved plan, then add no path-only prompt', () => {
  const facts = factsFor(patch);
  assert.deepEqual(policy().value.classify(patch, facts), { ok: false, outcome: 'prerequisite-denied', reasonCode: 'fix-plan-required' });
  assert.equal(permission(policy().value.classify(patch, { ...facts, plan: approvedPlan() })), 'ALLOWED');
  const dangerous = { ...facts, safety: { ...facts.safety, testsPreserved: false } };
  assert.equal(permission(policy().value.classify(patch, dangerous)), 'FORBIDDEN');
});

test('dependency, deletion, structural, configuration and configured breadth gates survive plan approval', () => {
  const facts = { ...factsFor(patch), plan: approvedPlan() };
  for (const change of [{ dependencyChange: true }, { deletion: true }, { structuralChange: true },
    { sensitiveConfiguration: true }, { fileCount: 9 }, { addedDeletedLines: 401 }]) {
    assert.equal(permission(policy().value.classify(patch, { ...facts, patch: { ...facts.patch, ...change } })), 'APPROVAL_REQUIRED');
  }
  const configured = compilePolicy({ ...profile, patchBreadth: { maxFiles: 1, maxAddedDeletedLines: 1 } });
  assert.equal(configured.ok && permission(configured.value.classify(patch, facts)), 'APPROVAL_REQUIRED');
  for (const path of ['pyproject.toml', '.github/workflows/new.yml']) {
    const action: NormalizedAction = { ...patch, targetPaths: [path] };
    assert.equal(permission(policy().value.classify(action, { ...factsFor(action), plan: approvedPlan() })), 'APPROVAL_REQUIRED');
  }
});

test('repository drift and incomplete plan freshness require new approval; material strategy needs a retained slot capped at three', () => {
  const facts = factsFor(patch);
  const plan = approvedPlan();
  for (const drift of [
    { repositoryRevisionDigest: `sha256:${'b'.repeat(64)}` },
    { plan: { ...plan, binding: { ...plan.binding, status: 'pending' } } },
    { plan: { ...plan, context: { ...plan.context, currentCriteriaDigest: digest.replaceAll('a', 'b') } } },
    { plan: { ...plan, context: { ...plan.context, currentBaselineRef: undefined } } },
    { plan: { ...plan, materialChange: true, replanSlot: null } },
    { plan: { ...plan, materialChange: true, replanSlot: 4 } },
  ]) assert.equal(policy().value.classify(patch, { ...facts, plan, ...drift }).ok, false);
  for (const replanSlot of [1, 2, 3]) {
    assert.equal(permission(policy().value.classify(patch, { ...facts, plan: { ...plan, materialChange: true, replanSlot } })), 'ALLOWED');
  }
  assert.equal(permission(policy().value.classify(patch, { ...facts, plan })), 'ALLOWED');
});

test('fix-plan actions always need explicit human approval, including materially revised plans', () => {
  const action: NormalizedAction = { actionId: 'plan-1', kind: 'approve_fix_plan', planVersion: 1, strategyDigest: digest, diagnosisEvidenceRefs: ['evidence-1'], checkSetDigest: digest };
  assert.equal(permission(policy().value.classify(action, factsFor(action))), 'APPROVAL_REQUIRED');
  const facts = { ...factsFor(action), plan: { ...approvedPlan(), materialChange: true, replanSlot: 4 } };
  assert.equal(policy().value.classify(action, facts).ok, false);
  assert.equal(permission(policy().value.classify(action, { ...facts, plan: { ...facts.plan, replanSlot: 3 } })), 'APPROVAL_REQUIRED');
});

test('command grammar binds executable, cwd and the entire argv tuple; unsupported suffixes need a real constrained capability fact', () => {
  for (const action of [
    { ...command, argv: ['-q', 'tests/', 'extra.py'] }, { ...command, argv: ['tests/', '-q'] },
    { ...command, executable: 'other' }, { ...command, workingDirectory: '/elsewhere' },
  ]) {
    const facts = factsFor(action);
    assert.equal(policy().value.classify(action, action.workingDirectory === '/elsewhere' ? { ...facts, command: { ...facts.command, workingDirectoryRef: 'other-directory' } } : facts).ok, false);
  }
  const outside = { ...command, argv: ['-q', 'tests/other.py'] };
  const facts = factsFor(outside);
  assert.equal(permission(policy().value.classify(outside, { ...facts, command: { ...facts.command, constrainedCapability: 'host-constrained-test-1' } })), 'APPROVAL_REQUIRED');
  assert.equal(policy().value.classify(command, { ...factsFor(command), command: null }).ok, false);
  assert.equal(policy().value.classify(command, { ...factsFor(command), command: { ...factsFor(command).command, resolvedExecutable: 'different' } }).ok, false);
});

test('shell evaluation and unconfigured interpreters stay forbidden even with constrained capability assertions', () => {
  for (const change of [
    { executable: 'sh', argv: ['-c', 'echo hi'] }, { executable: 'python', argv: ['-c', 'print(1)'] },
    { executable: 'python', argv: ['-m', 'other'] }, { executable: 'node', argv: ['unregistered.js'] },
    { executable: 'pytest', argv: ['-q', 'tests/;curl'] }, { executable: 'pytest', argv: ['$(payload)'] },
  ]) {
    const action: NormalizedAction = { ...command, ...change };
    const facts = factsFor(action);
    assert.equal(permission(policy().value.classify(action, { ...facts, command: { ...facts.command, constrainedCapability: 'host-constrained-test-1' } })), 'FORBIDDEN');
  }
  const action = { ...command, executable: '/usr/bin/python', argv: ['-m', 'pytest', '-q'] };
  const compiled = compilePolicy({ ...profile, commandRules: [{ ...profile.commandRules[0], executableRef: 'python', argvPrefix: action.argv }] });
  const facts = factsFor(action);
  assert.equal(compiled.ok && permission(compiled.value.classify(action, { ...facts, command: { ...facts.command, executableRef: 'python' } })), 'ALLOWED');
});

test('explicit finite configuration and action bounds are enforced and compiled policy cannot mutate', () => {
  for (const change of [{ operationDeadlineMs: Infinity }, { maxArgvEntries: 0 }, { maxActionBytes: NaN },
    { patchBreadth: undefined }, { productionDefault: true }]) assert.equal(compilePolicy({ ...profile, ...change }).ok, false);
  const mutable = structuredClone(profile);
  const compiled = compilePolicy(mutable);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  Object.assign(mutable, { commandRules: [], policyIdentity: { ...identity, policyVersion: 'changed' } });
  assert.equal(permission(compiled.value.classify(command, factsFor(command))), 'ALLOWED');
  assert.throws(() => Object.assign(compiled.value.profile, { maxActionBytes: Infinity }), TypeError);
  const bounded = compilePolicy({ ...profile, maxArgvEntries: 1 });
  assert.equal(bounded.ok && bounded.value.classify(command, factsFor(command)).ok, false);
  const large = { ...command, purpose: 'x'.repeat(65536) };
  assert.equal(compiled.value.classify(large, factsFor(large)).ok, false);
  let read = false;
  const accessor = Object.defineProperty({ ...command }, 'argv', { get: () => { read = true; return []; }, enumerable: true });
  assert.equal(compiled.value.classify(accessor, factsFor(command)).ok, false);
  assert.equal(read, false);
});

test('invalid canonical paths deny safely and validated embedded protected payloads are forbidden', () => {
  for (const targetPaths of [['../outside.py'], ['.env']]) {
    const action: NormalizedAction = { ...patch, targetPaths };
    assert.deepEqual(policy().value.classify(action, factsFor(action)), { ok: false, outcome: 'prerequisite-denied', reasonCode: 'forbidden-action-input' });
  }
  for (const action of [{ ...patch, patchContent: '+MARKER_SECRET_DO_NOT_DISCLOSE' }, { ...command, argv: ['MARKER_SECRET_DO_NOT_DISCLOSE'] }]) {
    const result = policy().value.classify(action, { ...factsFor(action), plan: approvedPlan() });
    assert.equal(permission(result), 'FORBIDDEN');
    assert.equal(JSON.stringify(result).includes('MARKER_SECRET'), false);
  }
});

test('unsupported operations and inconsistent affected-action facts deny before any permission result', () => {
  const compiled = compilePolicy({ ...profile, supportedActionKinds: ['run_command'] });
  assert.equal(compiled.ok && compiled.value.classify(patch, { ...factsFor(patch), plan: approvedPlan() }).ok, false);
  assert.equal(policy().value.classify({ kind: 'read_file', actionId: 'unknown' }, factsFor(command)).ok, false);
  assert.equal(policy().value.classify(command, { ...factsFor(command), patch: factsFor(patch).patch }).ok, false);
  assert.equal(policy().value.classify(patch, { ...factsFor(patch), patch: { ...factsFor(patch).patch, fileCount: 0 }, plan: approvedPlan() }).ok, false);
  const changed = { ...command, actionId: 'changed-id' };
  assert.equal(policy().value.classify(changed, factsFor(command)).ok, false);
  const bytes = { ...patch, patchContent: patch.patchContent.replace('+new', '+new ') };
  assert.equal(policy().value.classify(bytes, { ...factsFor(patch), plan: approvedPlan() }).ok, false);
});

test('sparse fact arrays and inconsistent fix-plan facts fail closed', () => {
  const plan = approvedPlan();
  const sparse: string[] = new Array<string>(1);
  Object.assign(sparse, { unexpected: 'evidence-1' });
  assert.equal(policy().value.classify(patch, { ...factsFor(patch), plan: { ...plan, binding: { ...plan.binding, evidenceRefs: sparse }, context: { ...plan.context, currentEvidenceRefs: sparse } } }).ok, false);
  const action: NormalizedAction = { actionId: 'plan-1', kind: 'approve_fix_plan', planVersion: 1, strategyDigest: digest, diagnosisEvidenceRefs: ['evidence-1'], checkSetDigest: digest };
  assert.equal(policy().value.classify(action, { ...factsFor(action), command: factsFor(command).command }).ok, false);
});

test('malformed object roles return typed invalid without coercion or throwing', () => {
  for (const role of [Object.create(null) as unknown, {}, ['coder']]) {
    assert.deepEqual(policy().value.classify(command, { ...factsFor(command), role }), {
      ok: false, outcome: 'invalid', reasonCode: 'invalid-trusted-facts',
    });
  }
});

test('configured interpreter tuples cannot authorize attached, combined or long evaluation flags', () => {
  for (const [executable, argv] of [
    ['python', ['-cprint(1)']], ['python', ['-Iqcprint(1)']],
    ['node', ['--eval=console.log(1)']], ['node', ['--print=1']],
    ['node', ['-p', '1']], ['node', ['-p1']], ['node', ['-peconsole.log(1)']],
    ['pythonw', ['-c', 'print(1)']], ['py', ['-cprint(1)']],
    ['nodejs', ['--eval=console.log(1)']],
    ['php', ['-r', 'echo 1']], ['php', ['-recho 1']], ['php', ['-nrecho 1']],
    ['perl', ['-E', 'say 1']], ['perl', ['-Esay 1']], ['perl', ['-wEsay 1']],
    ['deno', ['eval', 'console.log(1)']], ['deno', ['--quiet', 'eval', 'console.log(1)']],
    ['deno', ['--config', 'deno.json', 'eval', 'console.log(1)']],
    ['node', ['--input-type=module']], ['node', ['--input-type', 'module', '-']],
    ['nodejs', ['--input-type=commonjs', '-']], ['nodejs', ['--input-type', 'module']],
  ] as const) {
    const action: NormalizedAction = { ...command, executable, argv };
    const compiled = compilePolicy({ ...profile, commandRules: [{ ...profile.commandRules[0], executableRef: executable, argvPrefix: argv }] });
    assert.equal(compiled.ok && permission(compiled.value.classify(action, factsFor(action))), 'FORBIDDEN', `${executable} ${argv.join(' ')}`);
  }
});

test('configured standalone stdin tokens and unrelated uppercase interpreter flags remain allowed', () => {
  for (const [executable, argv] of [
    ['node', ['-']], ['nodejs', ['-']], ['python', ['-']], ['pytest', ['-']],
    ['python', ['-E', '-m', 'pytest']], ['ruby', ['-E', 'UTF-8', 'script.rb']],
    ['perl', ['-W', 'script.pl']], ['php', ['-H', 'script.php']],
  ] as const) {
    const action: NormalizedAction = { ...command, executable, argv };
    const compiled = compilePolicy({ ...profile, commandRules: [{ ...profile.commandRules[0], executableRef: executable, argvPrefix: argv }] });
    assert.equal(compiled.ok && permission(compiled.value.classify(action, factsFor(action))), 'ALLOWED', `${executable} ${argv.join(' ')}`);
  }
});

test('unconfigured interpreter aliases cannot gain approval through constrained capabilities', () => {
  for (const executable of ['pythonw', 'pythonw3.12', 'py', 'nodejs', 'C:\\\\Python\\\\PYTHONW.EXE']) {
    const action: NormalizedAction = { ...command, executable, argv: ['script.py'] };
    const facts = factsFor(action);
    assert.deepEqual(policy().value.classify(action, { ...facts, command: { ...facts.command, executableRef: 'interpreter', constrainedCapability: 'host-constrained-test-1' } }), {
      ok: true, permission: 'FORBIDDEN', reasonCode: 'unconfigured-interpreter', actionDigest: computeActionDigest(action),
    }, executable);
  }
});

test('revised plans require complete matched proposal context and trusted materiality before requesting approval', () => {
  const action: NormalizedAction = { actionId: 'plan-revised', kind: 'approve_fix_plan', planVersion: 2, strategyDigest: digest, diagnosisEvidenceRefs: ['evidence-1'], checkSetDigest: digest };
  const initial = approvedPlan();
  const actionDigest = computeActionDigest(action);
  const plan = { ...initial, materialChange: true, replanSlot: 1,
    binding: { ...initial.binding, status: 'pending' as const, planVersion: 2, normalizedActionDigest: actionDigest },
    context: { ...initial.context, currentPlanVersion: 2, currentNormalizedActionDigest: actionDigest },
  };
  const facts = { ...factsFor(action), plan };
  for (const proposal of [null, { ...plan, replanSlot: null }, { ...plan, replanSlot: 4 },
    { ...plan, context: {} }, { ...plan, context: { ...plan.context, currentEvidenceRefs: null } },
    { ...plan, binding: { ...plan.binding, normalizedActionDigest: digest }, context: { ...plan.context, currentNormalizedActionDigest: digest } },
    { ...plan, binding: { ...plan.binding, taskId: 'foreign-task' }, context: { ...plan.context, currentTaskId: 'foreign-task' } },
    { ...plan, binding: { ...plan.binding, strategyDigest: `sha256:${'b'.repeat(64)}` }, context: { ...plan.context, currentStrategyDigest: `sha256:${'b'.repeat(64)}` } },
  ]) assert.equal(policy().value.classify(action, { ...facts, plan: proposal }).ok, false);
  assert.equal(permission(policy().value.classify(action, facts)), 'APPROVAL_REQUIRED');
  assert.equal(permission(policy().value.classify(action, { ...facts, plan: { ...plan, materialChange: false, replanSlot: null } })), 'APPROVAL_REQUIRED');
});

test('v0.2 policy evaluation: allowed command produces valid immutable PolicyEvaluationReceipt without provider or plan fields', () => {
  const result = policy().value.evaluatePolicyV02(command, factsV02(command), { decisionAuthorityGeneration: 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.receipt.result, 'ALLOWED');
  assert.equal(result.receipt.policyId, identity.policyId);
  assert.equal(result.receipt.policyVersion, identity.policyVersion);
  assert.equal(result.receipt.configId, identity.configId);
  assert.equal(result.receipt.configVersion, identity.configVersion);
  assert.equal(result.receipt.decisionAuthorityGeneration, 1);
  assert.equal(result.receipt.actionDigest, computeActionDigest(command));
  assert.equal(Object.isFrozen(result.receipt), true);
  const validated = validatePolicyEvaluationReceipt(result.receipt);
  assert.equal(validated.ok, true);
  // Also verify standalone evaluatePolicyV02 function export
  const standalone = evaluatePolicyV02(profile, command, factsV02(command), { decisionAuthorityGeneration: 1 });
  assert.equal(standalone.ok, true);
});

test('v0.2 policy evaluation: approved plan vs unapproved patch vs forbidden command', () => {
  // Unapproved patch requires fix plan
  const unapproved = policy().value.evaluatePolicyV02(patch, factsV02(patch), { decisionAuthorityGeneration: 1 });
  assert.equal(unapproved.ok, false);
  if (!unapproved.ok) {
    assert.equal(unapproved.outcome, 'prerequisite-denied');
    assert.equal(unapproved.reasonCode, 'invalid-plan-applicability-or-binding');
  }

  // Approved patch produces ALLOWED receipt
  const approved = policy().value.evaluatePolicyV02(patch, factsV02(patch, 'approved-plan'), { decisionAuthorityGeneration: 1 });
  assert.equal(approved.ok, true);
  if (approved.ok) {
    assert.equal(approved.receipt.result, 'ALLOWED');
    assert.equal(validatePolicyEvaluationReceipt(approved.receipt).ok, true);
  }

  // Risky patch produces APPROVAL_REQUIRED receipt
  const patchFacts = factsFor(patch).patch;
  assert.ok(patchFacts);
  const riskyPatch = { ...factsV02(patch, 'approved-plan'), patch: { ...patchFacts, dependencyChange: true } };
  const risky = policy().value.evaluatePolicyV02(patch, riskyPatch, { decisionAuthorityGeneration: 1 });
  assert.equal(risky.ok, true);
  if (risky.ok) {
    assert.equal(risky.receipt.result, 'APPROVAL_REQUIRED');
    assert.equal(validatePolicyEvaluationReceipt(risky.receipt).ok, true);
  }

  // Hard boundary / reviewer role produces FORBIDDEN receipt
  const forbiddenFacts = factsV02(command, 'pre-plan-diagnostic', { role: 'reviewer' });
  const forbidden = policy().value.evaluatePolicyV02(command, forbiddenFacts, { decisionAuthorityGeneration: 1 });
  assert.equal(forbidden.ok, true);
  if (forbidden.ok) {
    assert.equal(forbidden.receipt.result, 'FORBIDDEN');
    assert.equal(validatePolicyEvaluationReceipt(forbidden.receipt).ok, true);
  }
});

test('v0.2 policy evaluation computes freshness from exact current facts and ignores caller digest overrides', () => {
  const facts = factsV02(command);
  const result = policy().value.evaluatePolicyV02(command, facts, {
    decisionAuthorityGeneration: 1,
    freshnessContextDigest: `sha256:${'f'.repeat(64)}`,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.receipt.freshnessContextDigest, computeCanonicalSha256({ action: command, facts, policyIdentity: identity, decisionAuthorityGeneration: 1 }));
  assert.notEqual(result.receipt.freshnessContextDigest, `sha256:${'f'.repeat(64)}`);
  const changed = policy().value.evaluatePolicyV02(command, { ...facts, taskStateVersion: 4 }, { decisionAuthorityGeneration: 1 });
  assert.equal(changed.ok, true);
  if (changed.ok) assert.notEqual(changed.receipt.freshnessContextDigest, result.receipt.freshnessContextDigest);
});

test('v0.2 provider admission validates the full reserved ProviderRequest for both roles and applicability branches', () => {
  for (const role of ['coder', 'reviewer'] as const) {
    for (const applicability of ['pre-plan-diagnostic', 'approved-plan'] as const) {
      const request = providerRequest({
        providerRequestId: `request-${role}-${applicability}`,
        role,
        purpose: applicability === 'pre-plan-diagnostic' ? 'reproduction_check' : 'approved_fix_work',
      });
      const facts = providerFacts(request, applicability);
      const branchOptions = applicability === 'pre-plan-diagnostic'
        ? { planApplicability: applicability, diagnosticPurpose: 'reproduction_check', taskCriteriaDigest: digest }
        : { planApplicability: applicability, planBindingDigest: facts['planBindingDigest'] as string, planDecisionRef: facts['planDecisionRef'] as string };
      const result = policy().value.evaluateProviderAdmissionV02(request, facts, { decisionAuthorityGeneration: 1, ...branchOptions });
      assert.equal(result.ok, true, `${role}/${applicability}`);
      if (!result.ok) continue;
      assert.equal(result.receipt.role, role);
      assert.equal(result.receipt.policyId, identity.policyId);
      assert.equal(result.receipt.policyVersion, identity.policyVersion);
      assert.equal(result.receipt.planApplicability, applicability);
      assert.equal(result.receipt.configId, identity.configId);
      assert.equal(result.receipt.configVersion, identity.configVersion);
      assert.equal(result.receipt.decisionAuthorityGeneration, 1);
      assert.equal(result.receipt.requestContentDigest, computeRequestContentDigest(request));
      assert.equal(Object.isFrozen(result.receipt), true);
      assert.equal(validateProviderAdmissionReceipt(result.receipt).ok, true);
    }
  }
});

test('v0.2 provider admission refuses absent trusted facts, mismatched identity, malformed envelopes and unbounded limits', () => {
  const request = providerRequest();
  const facts = providerFacts(request, 'pre-plan-diagnostic');
  const options = { decisionAuthorityGeneration: 1, planApplicability: 'pre-plan-diagnostic' as const, diagnosticPurpose: 'reproduction_check', taskCriteriaDigest: digest };
  const noTimeout = { ...request };
  delete noTimeout['timeoutMs'];
  const infiniteCost = { ...request, maxCostUsd: Number.POSITIVE_INFINITY };
  const exhaustedEnvelope = { ...request, maxBillableTokens: 50 };
  const dispatched = { ...request, dispatchState: 'dispatched' };
  const unknownField = { ...request, prompt: 'not part of ProviderRequest' };
  for (const candidate of [noTimeout, infiniteCost, exhaustedEnvelope, dispatched, unknownField]) {
    assert.equal(policy().value.evaluateProviderAdmissionV02(candidate, facts, options).ok, false);
  }
  assert.equal(policy().value.evaluateProviderAdmissionV02(request, null, options).ok, false);
  assert.equal(policy().value.evaluateProviderAdmissionV02(request, factsV02(command), options).ok, false);
  assert.equal(policy().value.evaluateProviderAdmissionV02(request, { ...facts, providerRequest: { ...request, dispatchState: 'dispatched' } }, options).ok, false);
  assert.equal(policy().value.evaluateProviderAdmissionV02(request, facts, { ...options, role: 'reviewer' }).ok, false);
  assert.equal(policy().value.evaluateProviderAdmissionV02({ ...request, modelId: 'foreign-model' }, facts, options).ok, false);
  assert.equal(policy().value.evaluateProviderAdmissionV02(request, { ...facts, policyIdentity: { ...identity, configVersion: 'stale' } }, options).ok, false);
  assert.equal(policy().value.evaluateProviderAdmissionV02(request, { ...facts, diagnosticPurpose: null }, options).ok, false);
  assert.equal(policy().value.evaluateProviderAdmissionV02(request, { ...facts, taskNode: 'Patch' }, options).ok, false);
  assert.equal(policy().value.evaluateProviderAdmissionV02(request, facts, { ...options, taskCriteriaDigest: `sha256:${'b'.repeat(64)}` }).ok, false);
});

test('v0.2 provider request digest changes with each immutable identity and ceiling field', () => {
  const original = providerRequest();
  const baseFacts = providerFacts(original, 'pre-plan-diagnostic');
  const opts = { decisionAuthorityGeneration: 1, planApplicability: 'pre-plan-diagnostic' as const, diagnosticPurpose: 'reproduction_check', taskCriteriaDigest: digest };
  const first = policy().value.evaluateProviderAdmissionV02(original, baseFacts, opts);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const changes: readonly Record<string, unknown>[] = [
    { providerRequestId: 'provider-request-2' }, { taskId: 'task-2' }, { runId: 'run-2' }, { role: 'reviewer' },
    { purpose: 'different-purpose' }, { providerId: 'provider-2' }, { modelId: 'model-2' },
    { pricingPolicyId: 'pricing-2' }, { contextDigest: `sha256:${'b'.repeat(64)}` }, { timeoutMs: 2_001 },
    { maxInputTokens: 101 }, { maxOutputTokens: 101 }, { maxBillableTokens: 222 }, { maxCostUsd: 0.26 },
  ];
  for (const change of changes) {
    const changed = { ...original, ...change };
    const res = policy().value.evaluateProviderAdmissionV02(changed, providerFacts(changed, 'pre-plan-diagnostic'), { ...opts, diagnosticPurpose: changed['purpose'] as string });
    assert.equal(res.ok, true);
    if (res.ok) assert.notEqual(res.receipt.requestContentDigest, first.receipt.requestContentDigest, Object.keys(change)[0]);
  }
  assert.equal(policy().value.evaluateProviderAdmissionV02({ ...original, configId: 'foreign-config' }, providerFacts({ ...original, configId: 'foreign-config' }, 'pre-plan-diagnostic'), opts).ok, false);
});

test('v0.2 provider reservation is separately matched and excluded from the canonical request-content digest', () => {
  const request = providerRequest();
  const facts = providerFacts(request, 'pre-plan-diagnostic');
  const options = { decisionAuthorityGeneration: 1, planApplicability: 'pre-plan-diagnostic' as const, diagnosticPurpose: 'reproduction_check', taskCriteriaDigest: digest };
  const issued = policy().value.evaluateProviderAdmissionV02(request, facts, options);
  assert.equal(issued.ok, true);
  if (!issued.ok) return;

  const changedReservation = { ...request, reservationRef: 'reservation-2' };
  assert.equal(computeRequestContentDigest(changedReservation), issued.receipt.requestContentDigest);
  assert.equal(policy().value.evaluateProviderAdmissionV02(changedReservation, facts, options).ok, false);

  const separatelyBound = policy().value.evaluateProviderAdmissionV02(
    changedReservation,
    providerFacts(changedReservation, 'pre-plan-diagnostic'),
    options,
  );
  assert.equal(separatelyBound.ok, true);
  if (!separatelyBound.ok) return;
  assert.equal(separatelyBound.receipt.requestContentDigest, issued.receipt.requestContentDigest);
  assert.equal(separatelyBound.receipt.receiptDigest, issued.receipt.receiptDigest);
});

test('v0.2 provider admission rejects cross-branch plans and a caller role that disagrees with trusted facts', () => {
  const request = providerRequest();
  const facts = providerFacts(request, 'pre-plan-diagnostic');
  assert.equal(policy().value.evaluateProviderAdmissionV02(request, facts, {
    decisionAuthorityGeneration: 1, planApplicability: 'approved-plan', planBindingDigest: digest, planDecisionRef: 'foreign-plan',
  }).ok, false);
  assert.equal(policy().value.evaluateProviderAdmissionV02(request, { ...facts, providerRequest: { ...request, providerId: 'foreign-provider' } }, {
    decisionAuthorityGeneration: 1, planApplicability: 'pre-plan-diagnostic', diagnosticPurpose: 'reproduction_check', taskCriteriaDigest: digest,
  }).ok, false);
});

test('v0.2 repository policy binds pre-plan diagnostics to Investigate criteria and approved work to the exact current plan', () => {
  const goodDiagnostic = policy().value.evaluatePolicyV02(command, factsV02(command), { decisionAuthorityGeneration: 1 });
  assert.equal(goodDiagnostic.ok, true);
  const wrongNode = policy().value.evaluatePolicyV02(command, factsV02(command, 'pre-plan-diagnostic', { taskNode: 'Verify' }), { decisionAuthorityGeneration: 1 });
  assert.equal(wrongNode.ok, false);
  const wrongPath = policy().value.evaluatePolicyV02(command, factsV02(command, 'pre-plan-diagnostic', { testPath: 'tests/other.py' }), { decisionAuthorityGeneration: 1 });
  assert.equal(wrongPath.ok, false);
  const approvedFacts = factsV02(patch, 'approved-plan');
  assert.equal(policy().value.evaluatePolicyV02(patch, approvedFacts, { decisionAuthorityGeneration: 1 }).ok, true);
  assert.equal(policy().value.evaluatePolicyV02(patch, { ...approvedFacts, planBindingDigest: digest }, { decisionAuthorityGeneration: 1 }).ok, false);
  assert.equal(policy().value.evaluatePolicyV02(patch, { ...approvedFacts, plan: null }, { decisionAuthorityGeneration: 1 }).ok, false);
  assert.equal(policy().value.evaluatePolicyV02(patch, approvedFacts, { decisionAuthorityGeneration: 1, planDecisionRef: 'foreign-plan' }).ok, false);
  assert.equal(policy().value.evaluatePolicyV02(patch, approvedFacts, { decisionAuthorityGeneration: 1, planApplicability: 'pre-plan-diagnostic' }).ok, false);
});
