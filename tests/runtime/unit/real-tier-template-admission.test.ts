/**
 * Controlled acceptance witness for real-tier host template adapterVersions through admission
 * (Feature 007 T011, TEMPLATE-ADMISSION / template-success-and-refusals).
 *
 * Exercises `runRealTierScanCli(['--print-host-template'])` -> `issueRealExecutionAdmission` and
 * `runEvaluateCli(['preflight' | 'run'])` with RFC 5737 `.invalid` / synthetic fixtures only:
 * zero live provider calls, zero live Docker invocations.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isAdmittedRealExecutionAdmission, issueRealExecutionAdmission } from '../../../eval/shared-admission.ts';
import type { RealExecutionBinding } from '../../../eval/shared-types.ts';
import { validateWorkflowEvaluationReport } from '../../../eval/uc03/validation-workflow.ts';
import { runEvaluateCli } from '../../../src/cli/evaluate.ts';
import { runRealTierScanCli } from '../../../src/cli/real-tier-scan.ts';
import type { ScanGit } from '../../../src/runtime/real-tier-endpoint-scan.ts';
import { parseCliReport } from '../integration/real-tier-production-route-fixture.ts';
import { createScanFixture } from './real-tier-scan-fixtures.ts';

interface GeneratedHostTemplate {
  profileId: string;
  profileDigest: string;
  configDigest: string;
  pricingDigest: string;
  requestedModel: string;
  adapterVersions: string[];
  contractVersion: string;
  revisions: Record<string, string>;
  assembly?: string;
}

interface ProbeRecord {
  assemblyCalls: number;
  productionCalls: number;
  productionErrors: number;
  fetchCalls: number;
  admissions: unknown[];
}

const REV = 'a'.repeat(40);
const SOURCE = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const PROBE_KEY = '__t011TemplateAdmissionProbe' as const;
const gitHeadStub: ScanGit = async args => (args[0] === 'rev-parse' && args[1] === 'HEAD' ? { ok: true, stdout: `${REV}\n`, stderr: '' } : { ok: false, stdout: '', stderr: 'unsupported' });

function writeControlledAssemblyModule(dir: string, env: Readonly<Record<string, string | undefined>>, repositoryRoot: string, imageId: string): string {
  const path = join(dir, 'controlled-assembly.mjs');
  const assemblyUrl = pathToFileURL(fileURLToPath(new URL(`../../../src/runtime/real-tier-assembly${SOURCE}`, import.meta.url))).href;
  const source = `import { createHostAssembly as realCreateHostAssembly } from ${JSON.stringify(assemblyUrl)};
const ENV = ${JSON.stringify(env)};
const REPOSITORY_ROOT = ${JSON.stringify(repositoryRoot)};
const REVISION = ${JSON.stringify(REV)};
const IMAGE_ID = ${JSON.stringify(imageId)};
const PROBE_KEY = ${JSON.stringify(PROBE_KEY)};

const probe = () => globalThis[PROBE_KEY];

const spawn = async (_cmd, args) => {
  if (args[0] === 'version') {
    return { exitCode: 0, stdout: '27.0.0\\n', stderr: '', timedOut: false, truncated: false };
  }
  if (args[0] === 'image' && args[1] === 'inspect') {
    return { exitCode: 0, stdout: IMAGE_ID + '\\n', stderr: '', timedOut: false, truncated: false };
  }
  return { exitCode: 1, stdout: '', stderr: 'unexpected command', timedOut: false, truncated: false };
};

const fetch = async () => {
  const state = probe();
  if (state) state.fetchCalls += 1;
  throw new Error('controlled-fetch-refused');
};

export function createHostAssembly() {
  const state = probe();
  if (state) state.assemblyCalls += 1;
  const built = realCreateHostAssembly({ env: ENV, repositoryRoot: REPOSITORY_ROOT, revision: REVISION, spawn, fetch });
  if (built.status === 'unavailable') return built;
  const realProduction = built.production;
  return {
    ...built,
    production(ready, context) {
      if (state) state.productionCalls += 1;
      let produced;
      try {
        produced = realProduction(ready, context);
      } catch (error) {
        if (state) state.productionErrors += 1;
        throw error;
      }
      if (state && typeof produced === 'object' && produced !== null && 'realAdmission' in produced && produced.realAdmission !== undefined) {
        state.admissions.push(produced.realAdmission);
      }
      return produced;
    },
  };
}
`;
  writeFileSync(path, source, 'utf8');
  return path;
}

function bindingFromTemplate(template: GeneratedHostTemplate, caseIds: readonly string[] = ['C01']): RealExecutionBinding {
  return {
    profileDigest: template.profileDigest,
    configDigest: template.configDigest,
    pricingDigest: template.pricingDigest,
    adapterVersions: template.adapterVersions,
    caseIds,
    requestedModel: template.requestedModel,
  };
}

test('generated real-tier template adapterVersions traverse admission with exact identity and copy refusals', async () => {
  const fixture = createScanFixture('t011-tpl-unit-', 't011-tpl-unit-digest-key');
  try {
    const templateResult = await runRealTierScanCli(['--print-host-template'], { env: fixture.envOf(), repositoryRoot: fixture.REPO, git: gitHeadStub });
    assert.equal(templateResult.exitCode, 0);
    const template = JSON.parse(templateResult.output) as GeneratedHostTemplate;
    assert.deepEqual(template.adapterVersions, ['uc03-real-tier/1']);

    const binding = bindingFromTemplate(template);
    const receipt = issueRealExecutionAdmission(binding);
    assert.equal(isAdmittedRealExecutionAdmission(receipt, binding), true);
    assert.equal(isAdmittedRealExecutionAdmission({ ...receipt }, binding), false, 'spread copy must be denied');
    assert.equal(
      isAdmittedRealExecutionAdmission({ admissionId: receipt.admissionId, profileDigest: receipt.profileDigest, bindingDigest: receipt.bindingDigest }, binding),
      false,
      'forged shape must be denied',
    );
    assert.equal(isAdmittedRealExecutionAdmission(receipt, { ...binding, adapterVersions: ['uc03-real-tier/2'] }), false, 'changed adapterVersions must be denied');
    assert.equal(isAdmittedRealExecutionAdmission(receipt, { ...binding, caseIds: ['C02'] }), false, 'changed caseIds must be denied');
    assert.equal(isAdmittedRealExecutionAdmission(receipt, { ...binding, requestedModel: 'other/model' }), false, 'changed requestedModel must be denied');
    assert.equal(isAdmittedRealExecutionAdmission(receipt, { ...binding, configDigest: 'c'.repeat(64) }), false, 'changed digest must be denied');
  } finally {
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});

test('adapterVersions preserves compatibility, enforces 192-char bounds, and refuses malformed or protected payloads with no effects', () => {
  const digest = 'sha256:' + 'b'.repeat(64);
  const base: RealExecutionBinding = {
    profileDigest: digest,
    configDigest: digest,
    pricingDigest: digest,
    adapterVersions: ['uc03-real-tier/1'],
    caseIds: ['C01'],
    requestedModel: 'cmc/deepseek/deepseek-v4.1-flash',
  };

  const priorReceipt = issueRealExecutionAdmission(base);
  assert.equal(isAdmittedRealExecutionAdmission(priorReceipt, base), true);

  for (const allowed of [['uc03-adapter-1'], ['mock-adapter-v1'], ['uc03-real-tier/1'], ['controlled/1'], ['vendor/adapter:v1.2_3'], ['a'.repeat(192)], ['vendor/' + 'a'.repeat(185)]]) {
    const binding = { ...base, adapterVersions: allowed };
    const receipt = issueRealExecutionAdmission(binding);
    assert.equal(isAdmittedRealExecutionAdmission(receipt, binding), true, `expected allowed adapterVersions: ${JSON.stringify(allowed)}`);
  }

  const invalidAdapters: readonly unknown[] = [
    [''],
    ['/'],
    ['/uc03-real-tier/1'],
    ['uc03-real-tier/'],
    ['uc03-real-tier//1'],
    ['uc03-real-tier/../1'],
    ['..uc03'],
    ['-uc03'],
    ['uc03 real-tier/1'],
    ['uc03\\real-tier'],
    ['uc03-real-tier/1\n'],
    ['uc03/adapter/-bad'],
    ['a'.repeat(193)],
    ['vendor/' + 'a'.repeat(186)],
    ['uc03-real-tier/1', '../bad'],
    [123],
    [null],
    // Protected payload sentinels must stay refused
    ['sk-live-0123456789abcdefghij'],
    ['MARKER_SECRET_VALUE'],
    ['.env'],
    ['.env.local'],
    ['credentials.json'],
    ['secrets.json'],
    ['.git/config'],
    ['AGENTS.md'],
    ['CLAUDE.md'],
    ['id_rsa'],
    ['api_key=value'],
  ];

  for (const bad of invalidAdapters) {
    assert.throws(() => issueRealExecutionAdmission({ ...base, adapterVersions: bad }), /Invalid shared evaluation contract/u, `expected refusal for ${JSON.stringify(bad)}`);
  }

  // requestedModel protected/path/length refusals remain unchanged.
  for (const badModel of ['openai/../secret', 'sk-live-0123456789abcdefghij', 'a'.repeat(193)]) {
    assert.throws(() => issueRealExecutionAdmission({ ...base, requestedModel: badModel }), /Invalid shared evaluation contract/u, `expected requestedModel refusal for ${badModel}`);
  }

  // Refusals leave prior receipts valid and do not interfere with subsequent valid issuance.
  assert.equal(isAdmittedRealExecutionAdmission(priorReceipt, base), true);
  const afterRefusal = issueRealExecutionAdmission(base);
  assert.equal(isAdmittedRealExecutionAdmission(afterRefusal, base), true);
  assert.notEqual(afterRefusal.admissionId, priorReceipt.admissionId);
});

test('generated template traverses real CLI production admission and rejects invalid hosts with zero live effects', async () => {
  const fixture = createScanFixture('t011-tpl-cli-', 't011-tpl-cli-digest-key');
  const workDir = mkdtempSync(join(tmpdir(), 't011-tpl-host-'));
  const probe: ProbeRecord = { assemblyCalls: 0, productionCalls: 0, productionErrors: 0, fetchCalls: 0, admissions: [] };
  Reflect.set(globalThis, PROBE_KEY, probe);

  try {
    const env = fixture.envOf();
    const profilePath = env.UC03_REAL_TIER_PROFILE;
    assert.ok(profilePath !== undefined);
    const profileRaw = JSON.parse(readFileSync(profilePath, 'utf8')) as { image: { imageId: string } };
    const templateResult = await runRealTierScanCli(['--print-host-template'], { env, repositoryRoot: fixture.REPO, git: gitHeadStub });
    assert.equal(templateResult.exitCode, 0);
    const template = JSON.parse(templateResult.output) as GeneratedHostTemplate;
    const assemblyPath = writeControlledAssemblyModule(workDir, env, fixture.REPO, profileRaw.image.imageId);

    const hostFile = join(workDir, 'host.json');
    writeFileSync(hostFile, JSON.stringify({ ...template, assembly: assemblyPath }), 'utf8');

    const preflight = await runEvaluateCli(['preflight', '--host', hostFile]);
    assert.equal(preflight.exitCode, 0, preflight.output);
    const preflightJson = JSON.parse(preflight.output) as { outcome: string; operational?: string; metadata?: { model?: string } };
    assert.equal(preflightJson.outcome, 'ready');
    assert.equal(preflightJson.operational, 'ready');
    assert.equal(preflightJson.metadata?.model, template.requestedModel);
    assert.equal(probe.fetchCalls, 0);

    const runResult = await runEvaluateCli(['run', '--host', hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.equal(probe.productionCalls, 1);
    assert.equal(probe.productionErrors, 0, 'createRealTierProductionRoute must not fail in issueRealExecutionAdmission');
    assert.equal(probe.admissions.length, 1);
    assert.equal(isAdmittedRealExecutionAdmission(probe.admissions[0], bindingFromTemplate(template, ['C01'])), true);
    assert.notEqual(runResult.exitCode, 2, `generated template must not be refused by options validation: ${runResult.output}`);
    assert.equal(runResult.output.includes('EVALUATION_REFUSED'), false);
    assert.equal(runResult.output.includes('HOST_ROUTE_UNAVAILABLE'), false);
    const parsedReport = validateWorkflowEvaluationReport(parseCliReport(runResult.output));
    assert.equal(parsedReport.tier, 'real-integration');
    assert.deepEqual(parsedReport.cases[0]?.adapterVersions, ['uc03-real-tier/1']);
    assert.equal(parsedReport.cases[0]?.requestedModel, template.requestedModel);
    assert.equal(parsedReport.cases[0]?.gradeReason, 'prerequisite-unavailable');
    assert.equal(probe.fetchCalls, 0);

    // Malformed & protected adapterVersions that pass host-config syntax still fail inside issueRealExecutionAdmission with exit 4.
    for (const [label, badAdapters] of [
      ['traversal', ['uc03-real-tier/../1']],
      ['protected', ['sk-live-0123456789abcdefghij']],
    ] as const) {
      probe.productionErrors = 0;
      probe.admissions.length = 0;
      const badHost = join(workDir, `host-${label}.json`);
      writeFileSync(badHost, JSON.stringify({ ...template, adapterVersions: badAdapters, assembly: assemblyPath }), 'utf8');

      const badRun = await runEvaluateCli(['run', '--host', badHost, '--mode', 'real', '--cases', 'C01']);
      assert.equal(badRun.exitCode, 4, badRun.output);
      assert.equal((JSON.parse(badRun.output) as { error?: string }).error, 'HOST_ROUTE_UNAVAILABLE');
      assert.equal(probe.productionErrors, 1);
      assert.equal(probe.admissions.length, 0);
      assert.equal(probe.fetchCalls, 0);
      assert.equal(badRun.output.includes(badAdapters[0]), false);
    }

    // Credential keyword in adapterVersions is refused before assembly with exit 2.
    probe.assemblyCalls = 0;
    const credHost = join(workDir, 'host-credential.json');
    writeFileSync(credHost, JSON.stringify({ ...template, adapterVersions: ['credential:private-value'], assembly: assemblyPath }), 'utf8');
    const credRun = await runEvaluateCli(['run', '--host', credHost, '--mode', 'real', '--cases', 'C01']);
    assert.equal(credRun.exitCode, 2);
    assert.equal((JSON.parse(credRun.output) as { error?: string }).error, 'HOST_CONFIG_UNSAFE_FIELD');
    assert.equal(probe.assemblyCalls, 0);
    assert.equal(probe.fetchCalls, 0);

    // Tampered digest fails preflight/route before issuing any admission.
    probe.admissions.length = 0;
    const tamperedHost = join(workDir, 'host-tampered.json');
    writeFileSync(tamperedHost, JSON.stringify({ ...template, profileDigest: `sha256:${'f'.repeat(64)}`, assembly: assemblyPath }), 'utf8');
    const tamperedRun = await runEvaluateCli(['run', '--host', tamperedHost, '--mode', 'real', '--cases', 'C01']);
    assert.notEqual(tamperedRun.exitCode, 0);
    assert.equal(probe.admissions.length, 0);
    assert.equal(probe.fetchCalls, 0);
  } finally {
    Reflect.deleteProperty(globalThis, PROBE_KEY);
    rmSync(workDir, { recursive: true, force: true });
    rmSync(fixture.OUTSIDE, { recursive: true, force: true });
    rmSync(fixture.REPO, { recursive: true, force: true });
    rmSync(fixture.BASE, { recursive: true, force: true });
  }
});
