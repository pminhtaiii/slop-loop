import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalizedAction } from '../../../src/contracts/foundation/uc03.ts';
import { computeActionDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { PolicyProfile } from '../../../src/contracts/approvals/contracts.ts';
import { compilePolicy } from '../../../src/approvals/policy.ts';
import type { PolicyFacts, PolicyClassification } from '../../../src/approvals/policy.ts';

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
  ] as const) {
    const action: NormalizedAction = { ...command, executable, argv };
    const compiled = compilePolicy({ ...profile, commandRules: [{ ...profile.commandRules[0], executableRef: executable, argvPrefix: argv }] });
    assert.equal(compiled.ok && permission(compiled.value.classify(action, factsFor(action))), 'FORBIDDEN');
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
