import assert from 'node:assert/strict';
import test from 'node:test';
import { registerEvaluation, runEvaluation, type SharedEvaluationOptions, type RegisteredEvaluation, type SharedSelection } from '../../../eval/uc03/runner.ts';
import { registerUC01Evaluation } from '../../../eval/uc01/registration.ts';
import { UC01_PUBLIC_CASES, UC01_GRADING_CASES, trustedCatalogForCase, publicEvidenceForCase } from '../support/uc01/fixtures.ts';
import { canonicalDigest, fixtureLimits, oracleDigest, publicCaseDigest, type TrustedContext } from '../../../src/uc01/contracts.ts';
import { IssueAssessor } from '../../../src/uc01/assess.ts';
import { ScriptedUc01Ports, UC01_FIXTURE_PROFILE } from '../support/uc01/ports.ts';

test('shared registration accepts a versioned namespaced public dataset', () => {
  assert.doesNotThrow(() => registerEvaluation({ contractVersion: 'shared-evaluation-v1', ucId: 'UC-01',
    datasetId: 'synthetic', datasetVersion: '1', adapterVersion: 'test-adapter-v1', graderVersion: 'test-grader-v1',
    provenance: 'mock', cases: [{ caseId: 'UC-01:C01:synthetic', caseDigest: canonicalDigest('PublicCase', { report: 'synthetic issue' }), levels: ['contract'],
      gate: 'hard', classificationScored: false, attack: false, digestProfile: 'canonical-json-v1', payload: { report: 'synthetic issue' } }] }));
});

function synthetic(ucId = 'UC-02', changes: Record<string, unknown> = {}) {
  return { contractVersion: 'shared-evaluation-v1', ucId, datasetId: 'synthetic', datasetVersion: '1', adapterVersion: 'test-adapter-v1',
    graderVersion: 'test-grader-v1', provenance: 'mock', cases: [{ caseId: `${ucId}:C01:synthetic`, caseDigest: canonicalDigest('PublicCase', { report: 'synthetic issue' }), levels: ['contract'],
      gate: 'hard', classificationScored: false, attack: false, digestProfile: 'canonical-json-v1', payload: { report: 'synthetic issue' } }], ...changes };
}
function selected(registration: RegisteredEvaluation, caseIds = registration.cases.map(item => item.caseId)): SharedSelection {
  return { ucId: registration.ucId, datasetId: registration.datasetId, datasetVersion: registration.datasetVersion, level: 'contract',
    caseIds, requiredCases: caseIds.length, requiredAttacks: registration.cases.filter(item => caseIds.includes(item.caseId) && item.attack).length,
    configDigest: 'd'.repeat(64) };
}
let runSequence = 0;
function request(registrations: readonly RegisteredEvaluation[], selections = registrations.map(item => selected(item))): SharedEvaluationOptions {
  return { contractVersion: 'shared-evaluation-v1', scope: selections.length > 1 ? 'project' : 'uc', mode: 'mock', runId: `conformance-${++runSequence}`, attemptId: 'first',
    codeRevision: 'conformance-test-revision', perCaseTimeoutMs: 1000, registrations, selections };
}
const passing = { execute: async () => ({}), grade: async () => ({ status: 'pass', classification: 'not-applicable', safety: true, oracleDigest: 'b'.repeat(64), components: {} }) };

test('existing runner selects frozen UC-01 dataset and reports unavailable execution without fabricated pass', async () => {
  const registration = registerUC01Evaluation(UC01_PUBLIC_CASES, UC01_GRADING_CASES);
  const caseIds = registration.cases.filter(item => item.levels.includes('contract')).map(item => item.caseId);
  const report = await runEvaluation(request([registration], [selected(registration, caseIds)]));
  assert.equal(report.contractVersion, 'shared-evaluation-v1');
  assert.equal(report.exitCode, 1);
  assert.equal(report.acceptance, 'incomplete');
  assert.equal(report.results.length, caseIds.length);
  assert.ok(report.results.every(item => item.status === 'not-run' && item.reasonCode === 'driver-or-grader-unavailable'));
  for (const result of report.results) assert.equal(result.caseDigest, UC01_PUBLIC_CASES.find(item => item.caseId === result.caseId)?.caseDigest);
});

test('shared registration rejects malformed versions, duplicate IDs, wrong UC prefixes and conflicting selected versions', async () => {
  assert.throws(() => registerEvaluation(synthetic('UC-02', { contractVersion: 'future' })));
  const data = synthetic();
  assert.throws(() => registerEvaluation({ ...data, cases: [...data.cases, ...data.cases] }));
  assert.throws(() => registerEvaluation({ ...data, ucId: 'UC-01' }));
  const registration = registerEvaluation(data);
  assert.throws(() => registerEvaluation({ ...data, cases: [{ ...data.cases[0], caseDigest: 'invalid' }] }));
  await assert.rejects(runEvaluation(request([registration, registration])));
  await assert.rejects(runEvaluation(request([registration], [{ ...selected(registration), requiredCases: 2 }])));
});

test('scoped selection never executes another UC and run identity cannot overwrite an attempt', async () => {
  let otherExecuted = false;
  const one = registerEvaluation(synthetic('UC-01'), passing);
  const two = registerEvaluation(synthetic(), { ...passing, execute: async () => { otherExecuted = true; return {}; } });
  const options = request([one, two], [selected(one)]);
  const report = await runEvaluation(options);
  assert.equal(report.acceptance, 'pass');
  assert.equal(otherExecuted, false);
  assert.deepEqual(report.results.map(item => item.ucId), ['UC-01']);
  await assert.rejects(runEvaluation(options));
});

test('project manifest retains missing UCs as explicit not-run and cannot claim partial project success', async () => {
  const one = registerEvaluation(synthetic('UC-01'), passing);
  const missing = { ...selected(one), ucId: 'UC-04', caseIds: ['UC-04:C01:required'] };
  const report = await runEvaluation(request([one], [selected(one), missing]));
  assert.equal(report.acceptance, 'incomplete');
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.results.map(item => item.status), ['pass', 'not-run']);
  assert.equal(report.results[1]?.reasonCode, 'registration-unavailable');
  assert.equal(report.results[1]?.caseDigest, null);
});

test('project failure propagates while public inputs, per-UC context and error diagnostics remain isolated', async () => {
  let observed: unknown; const marker = 'PRIVATE_ORACLE_DO_NOT_FORWARD';
  const one = registerEvaluation(synthetic('UC-01'), { execute: async (payload, context) => { observed = { payload, context }; return marker; },
    grade: async () => ({ status: 'fail', classification: 'not-applicable', safety: false, oracleDigest: 'c'.repeat(64), components: {} }) });
  const two = registerEvaluation(synthetic(), { ...passing, execute: async () => { throw new Error(marker); } });
  const report = await runEvaluation(request([one, two]));
  assert.deepEqual(report.results.map(item => item.status), ['fail', 'error']);
  assert.equal(report.acceptance, 'fail');
  assert.ok(!JSON.stringify(report).includes(marker));
  assert.ok(!JSON.stringify(observed).includes(marker));
  assert.notEqual(report.results[0]?.isolationKey, report.results[1]?.isolationKey);
});

test('real mode cannot promote controlled execution to a real-model score', async () => {
  let called = false;
  const registration = registerEvaluation(synthetic(), { ...passing, execute: async () => { called = true; return {}; } });
  const report = await runEvaluation({ ...request([registration]), mode: 'real' });
  assert.equal(called, false);
  assert.equal(report.results[0]?.status, 'not-run');
  assert.equal(report.results[0]?.reasonCode, 'real-execution-unavailable');
  assert.equal(report.results[0]?.durationMs, null);
  assert.equal(report.acceptance, 'incomplete');
});

test('UC-01 executable registration grades actual C13 refusal against the unchanged oracle with private input separation', async () => {
  const caseId = 'UC-01:C13:reserved-destination';
  const record = UC01_PUBLIC_CASES.find(item => item.caseId === caseId); assert.ok(record);
  const oracle = UC01_GRADING_CASES.find(item => item.caseId === caseId); assert.ok(oracle);
  let publicInput = '';
  const context: TrustedContext = { taskId: record.input.invocation.taskId, runId: record.input.invocation.runId,
    repositoryId: record.input.invocation.repositoryId, workspaceId: 'evaluation', repositorySnapshotDigest: record.input.repositorySnapshotDigest,
    configId: record.prerequisites.configId, configVersion: record.prerequisites.configVersion, policyId: record.prerequisites.policyId,
    policyVersion: record.prerequisites.policyVersion, catalog: trustedCatalogForCase(caseId), limits: fixtureLimits,
    accountingRef: 'evaluation-accounting', evidenceRegistry: publicEvidenceForCase(caseId), continuation: undefined };
  const registration = registerUC01Evaluation(UC01_PUBLIC_CASES, UC01_GRADING_CASES, { version: 'controlled-observation-v1', provenance: 'mock', execute: async (input, execution) => {
    publicInput = JSON.stringify({ input, execution });
    const outcome = await new IssueAssessor({ ports: new ScriptedUc01Ports({ taskId: context.taskId, profile: UC01_FIXTURE_PROFILE, now: () => 100 }), profileId: 'uc01-fixture-v1', now: () => 100,
      ceiling: { inputTokens: 500, outputTokens: 250, totalTokens: 750, costUnits: 750, pricingId: 'uc01-fixture-token-units-v1' },
      excerpts: { resolveExcerpt: () => undefined } }).assessIssue(input.invocation, context);
    return { outcome, context };
  } }, async () => ({ provenance: true, evidenceSupport: true, clarification: true, destination: true, safety: true }));
  const report = await runEvaluation(request([registration], [selected(registration, [caseId])]));
  assert.equal(report.results[0]?.status, 'pass');
  assert.equal(report.exitCode, 0);
  assert.equal(report.results[0]?.oracleDigest, oracle.oracleDigest);
  assert.equal(report.results[0]?.caseDigest, record.caseDigest);
  assert.ok(!publicInput.includes('expectedLabels'));
  assert.ok(!publicInput.includes('oracleDigest'));
  assert.ok(!publicInput.includes('grader-only'));
  assert.ok(!publicInput.includes('prohibitedEffects'));
});

test('malformed grader results become error without accepting forged metrics or leaking exception payload', async () => {
  const registration = registerEvaluation(synthetic(), { ...passing,
    grade: async () => ({ status: 'pass', classification: 'incorrect', safety: true, oracleDigest: 'b'.repeat(64), components: {} }) });
  const report = await runEvaluation(request([registration]));
  assert.equal(report.results[0]?.status, 'error');
  assert.equal(report.results[0]?.classification, 'not-observed');
  assert.equal(report.results[0]?.oracleDigest, null);
  assert.equal(report.exitCode, 1);
});

test('unknown selected cases and attack-count mismatches refuse before any execution', async () => {
  let effects = 0;
  const registration = registerEvaluation(synthetic(), { ...passing, execute: async () => { effects++; return {}; } });
  await assert.rejects(runEvaluation(request([registration], [{ ...selected(registration), caseIds: ['UC-02:C99:missing'] }])));
  await assert.rejects(runEvaluation(request([registration], [{ ...selected(registration), requiredAttacks: 1 }])));
  assert.equal(effects, 0);
});

test('shared runner bounds unavailable driver execution and preserves not-observed metrics', async () => {
  const registration = registerEvaluation(synthetic(), { ...passing, execute: () => new Promise(() => undefined) });
  const report = await runEvaluation({ ...request([registration]), perCaseTimeoutMs: 10 });
  assert.equal(report.results[0]?.status, 'error');
  assert.equal(report.results[0]?.classification, 'not-observed');
  assert.equal(report.acceptance, 'incomplete');
});

test('frozen UC-01 held-out identities register unchanged but cannot run as mock quality', async () => {
  const records = UC01_PUBLIC_CASES.filter(item => item.levels.includes('model-quality'));
  const registration = registerUC01Evaluation(UC01_PUBLIC_CASES, UC01_GRADING_CASES);
  const selection = { ...selected(registration, records.map(item => item.caseId)), level: 'model-quality' as const };
  const report = await runEvaluation({ ...request([registration], [selection]), mode: 'real' });
  assert.equal(report.results.length, 5);
  assert.ok(report.results.every(item => item.status === 'not-run' && item.classification === 'not-observed'));
  assert.ok(report.results.every(item => item.durationMs === null && item.oracleDigest === null));
  assert.equal(report.groups[0]?.quality.total, 5);
  assert.equal(report.groups[0]?.quality.correct, 0);
  assert.equal(report.groups[0]?.completeness, 'incomplete');
});

test('case identity remains stable across versions but conflicting same-version registrations are rejected', async () => {
  const first = registerEvaluation(synthetic(), passing);
  const next = registerEvaluation(synthetic('UC-02', { datasetVersion: '2' }), passing);
  const conflicting = registerEvaluation(synthetic('UC-02', { adapterVersion: 'changed-adapter' }), passing);
  await assert.rejects(runEvaluation(request([first, conflicting], [selected(first)])));
  const report = await runEvaluation(request([first, next], [selected(next)]));
  assert.equal(report.acceptance, 'pass');
  assert.equal(report.results[0]?.datasetVersion, '2');
  assert.equal(report.results[0]?.caseId, first.cases[0]?.caseId);
});

test('re-registering the same dataset cannot overwrite a completed result namespace', async () => {
  const first = registerEvaluation(synthetic(), passing);
  const options = request([first]);
  await runEvaluation(options);
  const duplicate = registerEvaluation(synthetic(), passing);
  await assert.rejects(runEvaluation({ ...options, registrations: [duplicate] }));
  assert.equal(first.datasetDigest, duplicate.datasetDigest);
});

test('registration snapshots caller data and dataset digest excludes adapter revision changes', async () => {
  const data = synthetic();
  const first = registerEvaluation(data, passing);
  const second = registerEvaluation({ ...data, adapterVersion: 'later-adapter' }, passing);
  assert.equal(first.datasetDigest, second.datasetDigest);
  const caseRecord = data.cases[0]; assert.ok(caseRecord);
  caseRecord.payload.report = 'changed after registration';
  assert.deepEqual(first.cases[0]?.payload, { report: 'synthetic issue' });
});

test('changing frozen public payload at the same version rejects registration before execution', () => {
  const data = synthetic('UC-06');
  registerEvaluation(data);
  assert.throws(() => registerEvaluation({ ...data, cases: [{ ...data.cases[0], payload: { report: 'silently changed corpus' } }] }));
});

test('expired execution cannot invoke private grading when its late result resolves', async () => {
  let resolveExecution: ((value: unknown) => void) | undefined;
  let gradingCalls = 0;
  const registration = registerEvaluation(synthetic(), { ...passing,
    execute: () => new Promise(resolve => { resolveExecution = resolve; }),
    grade: async () => { gradingCalls++; return passing.grade(); } });
  const report = await runEvaluation({ ...request([registration]), perCaseTimeoutMs: 10 });
  assert.equal(report.results[0]?.status, 'error');
  assert.ok(resolveExecution);
  resolveExecution({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gradingCalls, 0);
  assert.equal(report.results[0]?.status, 'error');
  assert.equal(report.results[0]?.oracleDigest, null);
});

test('untrusted enum objects reject without invoking their coercion hooks', async () => {
  let coercions = 0;
  const hostile = { toString: () => { coercions++; return 'hostile'; } };
  const data = synthetic();
  assert.throws(() => registerEvaluation({ ...data, provenance: hostile }));
  assert.throws(() => registerEvaluation({ ...data, cases: [{ ...data.cases[0], gate: hostile }] }));
  assert.throws(() => registerEvaluation({ ...data, cases: [{ ...data.cases[0], levels: [hostile] }] }));
  const registration = registerEvaluation(data, passing);
  const options = request([registration]);
  await assert.rejects(runEvaluation({ ...options, scope: hostile }));
  await assert.rejects(runEvaluation({ ...options, mode: hostile }));
  await assert.rejects(runEvaluation({ ...options, selections: [{ ...selected(registration), level: hostile }] }));
  for (const field of ['status', 'classification', 'components'] as const) {
    const invalidGrade = { ...await passing.grade(), [field]: field === 'components' ? { severity: hostile } : hostile };
    const invalid = registerEvaluation(data, { ...passing, grade: async () => invalidGrade });
    const report = await runEvaluation(request([invalid]));
    assert.equal(report.results[0]?.status, 'error');
  }
  assert.equal(coercions, 0);
});

function nativeProbe(suffix: string) {
  const source = UC01_PUBLIC_CASES.find(item => item.caseId === 'UC-01:C02:all-users-locked-out'); assert.ok(source);
  // New synthetic metadata probes leave the frozen dataset and its native digests untouched.
  const changed = { ...source, datasetId: `uc01-native-binding-${suffix}`, datasetVersion: '1' };
  const record = { ...changed, caseDigest: publicCaseDigest(changed) };
  return synthetic('UC-01', { datasetId: record.datasetId, datasetVersion: record.datasetVersion,
    cases: [{ caseId: record.caseId, caseDigest: record.caseDigest, levels: record.levels, gate: record.gate,
      classificationScored: false, attack: false, digestProfile: 'uc01-evaluation-sha256-v1', payload: record }] });
}

test('native UC-01 registration rejects relabelled outer dataset identity', () => {
  const data = nativeProbe('dataset'); const pins = Object.fromEntries(data.cases.map(item => [item.caseId, 'a'.repeat(64)]));
  assert.doesNotThrow(() => registerEvaluation(data, undefined, pins));
  assert.throws(() => registerEvaluation({ ...data, datasetId: 'foreign-dataset' }, undefined, pins));
});

test('native UC-01 registration rejects relabelled outer dataset version', () => {
  const data = nativeProbe('version'); const pins = Object.fromEntries(data.cases.map(item => [item.caseId, 'a'.repeat(64)]));
  assert.doesNotThrow(() => registerEvaluation(data, undefined, pins));
  assert.throws(() => registerEvaluation({ ...data, datasetVersion: 'foreign-version' }, undefined, pins));
});

test('native UC-01 registration rejects forged attack categorization', () => {
  const data = nativeProbe('attack');
  const pins = Object.fromEntries(data.cases.map(item => [item.caseId, 'a'.repeat(64)]));
  // Separate baseline identity keeps the negative sensitive to native attack validation, rather than a prior dataset hash conflict.
  assert.doesNotThrow(() => registerEvaluation(nativeProbe('attack-baseline'), undefined, pins));
  assert.throws(() => registerEvaluation({ ...data, cases: data.cases.map(item => ({ ...item, attack: true })) }, undefined, pins));
});

test('UC-01 registration captures its adapter method before caller mutation', async () => {
  let originalCalls = 0; let replacementCalls = 0;
  const adapter = { version: 'captured-adapter-v1', provenance: 'mock' as const,
    execute: async () => { originalCalls++; throw new Error('Controlled execution stop'); } };
  const registration = registerUC01Evaluation(UC01_PUBLIC_CASES, UC01_GRADING_CASES, adapter,
    async () => ({ provenance: true, evidenceSupport: true, clarification: true, destination: true, safety: true }));
  adapter.execute = async () => { replacementCalls++; throw new Error('Replacement must not execute'); };
  const report = await runEvaluation(request([registration], [selected(registration, ['UC-01:C02:all-users-locked-out'])]));
  assert.equal(report.results[0]?.status, 'error');
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
});

test('UC-01 registration rejects changed oracle labels at the same frozen dataset and grader version', () => {
  const source = UC01_PUBLIC_CASES.find(item => item.caseId === 'UC-01:C02:all-users-locked-out'); assert.ok(source);
  const sourceOracle = UC01_GRADING_CASES.find(item => item.caseId === source.caseId); assert.ok(sourceOracle);
  const publicProbe = { ...source, datasetId: 'uc01-oracle-pinning-probe', datasetVersion: '1' };
  const record = { ...publicProbe, caseDigest: publicCaseDigest(publicProbe) };
  const oracleProbe = { ...sourceOracle, datasetVersion: record.datasetVersion, publicCaseDigest: record.caseDigest };
  const oracle = { ...oracleProbe, oracleDigest: oracleDigest(oracleProbe) };
  const registration = registerUC01Evaluation([record], [oracle]);
  const changedProbe = { ...oracle, expectedLabels: { ...oracle.expectedLabels, severity: 'P1' as const },
    allowedValues: { ...oracle.allowedValues, severity: ['P1' as const] } };
  const changed = { ...changedProbe, oracleDigest: oracleDigest(changedProbe) };
  assert.throws(() => registerUC01Evaluation([record], [changed]));
  const { datasetDigest, ...descriptor } = registration; void datasetDigest;
  assert.throws(() => registerEvaluation({ ...descriptor, graderVersion: 'changed-grader-v2' }, undefined, { [record.caseId]: changed.oracleDigest }));
  const changedRefs = { ...oracle, privateEvidenceRefs: ['grader-only://different-artifact'] };
  assert.throws(() => registerUC01Evaluation([record], [{ ...changedRefs, oracleDigest: oracleDigest(changedRefs) }]));
});

test('shared grading rejects a returned oracle digest that contradicts its host-private pinned manifest', async () => {
  const data = synthetic('UC-07'); const caseId = data.cases[0]?.caseId; assert.ok(caseId);
  const expectedDigest = 'f'.repeat(64); let observedContext = '';
  const registration = registerEvaluation(data, { ...passing, execute: async (payload, context) => {
    observedContext = JSON.stringify({ payload, context }); return {};
  } }, { [caseId]: expectedDigest });
  const report = await runEvaluation(request([registration]));
  assert.equal(report.results[0]?.status, 'error');
  assert.equal(report.results[0]?.oracleDigest, null);
  assert.ok(!observedContext.includes(expectedDigest));
});
