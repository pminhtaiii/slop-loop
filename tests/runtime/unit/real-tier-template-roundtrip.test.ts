/**
 * Controlled roundtrip acceptance & refusal suite for generated real-tier host templates
 * (Feature 007 T011, TEMPLATE-ADMISSION / template-success-and-refusals).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';

import { issueRealExecutionAdmission, isAdmittedRealExecutionAdmission } from '../../../eval/shared-admission.ts';
import { registerEvaluation, runAdmittedEvaluation } from '../../../eval/shared.ts';
import { runEvaluation } from '../../../eval/uc03/runner.ts';
import { WORKFLOW_EVALUATION_VERSION, type WorkflowCaseResult, type WorkflowEvaluationOptions, type WorkflowObservation } from '../../../eval/uc03/types.ts';
import { validateWorkflowEvaluationOptions, validateWorkflowEvaluationReport, validateWorkflowObservation } from '../../../eval/uc03/validation-workflow.ts';
import { produceWorkflowEvidence, workflowEvidenceDecision } from '../../../eval/uc03/workflow-evidence.ts';
import { createSnapshotGrader } from '../../../eval/uc03/workflow-grade.ts';
import { runEvaluateCli, type EvaluateCliOptions } from '../../../src/cli/evaluate.ts';
import { runRealTierScanCli } from '../../../src/cli/real-tier-scan.ts';
import type { ScanGit } from '../../../src/runtime/real-tier-endpoint-scan.ts';
import { canonicalDigest, sha256Text } from '../../../src/uc01/contracts.ts';
import { controlledGeneratedPlanFixture } from '../support/uc03/controlled-host-journey.ts';
import { GRADER_FILE, GRADER_SECRET, REV, parseCliReport, prodCopyTempCount, setupProductionScenario } from '../integration/real-tier-production-route-fixture.ts';

interface GeneratedTemplate {
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

const RET = 'deepseek/deepseek-v4.1-flash';
const REQ = `cmc/${RET}`;
const VER = 'uc03-real-tier/1';
const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);
const gitStub: ScanGit = async args => (args[0] === 'rev-parse' && args[1] === 'HEAD' ? { ok: true, stdout: `${REV}\n`, stderr: '' } : { ok: false, stdout: '', stderr: 'unsupported' });

function wrapFetch(returnedModel: string): { readonly requested: string[]; readonly leaked: () => boolean } {
  const h = globalThis.__t011Harness;
  assert.ok(h !== undefined);
  const inner = h.fetch;
  const requested: string[] = [];
  let leak = false;
  globalThis.__t011Harness = {
    ...h,
    fetch: async (input, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (body.includes(GRADER_SECRET) || body.includes(GRADER_FILE)) leak = true;
      const parsed = JSON.parse(body) as { model?: string };
      if (typeof parsed.model === 'string') requested.push(parsed.model);
      const res = await inner(input, init);
      const data = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...data, model: returnedModel }), { status: res.status, headers: { 'content-type': 'application/json' } });
    },
  };
  return { requested, leaked: () => leak };
}

async function applyTemplate(hostFile: string): Promise<GeneratedTemplate> {
  const h = globalThis.__t011Harness;
  assert.ok(h !== undefined);
  const scan = await runRealTierScanCli(['--print-host-template'], { env: h.env, repositoryRoot: process.cwd(), git: gitStub });
  assert.equal(scan.exitCode, 0, scan.output);
  const tpl = JSON.parse(scan.output) as GeneratedTemplate;
  assert.deepEqual(tpl.adapterVersions, [VER]);
  assert.equal(tpl.requestedModel, REQ);
  const existing = JSON.parse(readFileSync(hostFile, 'utf8')) as { assembly?: string };
  writeFileSync(hostFile, JSON.stringify({ ...tpl, assembly: existing.assembly }), 'utf8');
  return tpl;
}

function opts(overrides: Partial<WorkflowEvaluationOptions> = {}): WorkflowEvaluationOptions {
  return {
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode: 'mock',
    cases: ['C01'],
    profileDigest: D1,
    configDigest: D1,
    pricingDigest: D1,
    adapterVersions: [VER],
    requestedModel: REQ,
    timestamp: '2026-11-25T00:00:00.000Z',
    ...overrides,
  };
}

function obs(overrides: Partial<WorkflowObservation> = {}): WorkflowObservation {
  return {
    repositoryId: 'repo-1',
    taskId: 'task-1',
    runId: 'run-1',
    returnedModel: RET,
    graderDigest: null,
    initialRepositoryDigest: null,
    workflowOutcome: 'COMPLETED',
    expectedWait: null,
    blocked: null,
    effects: 'observed',
    usage: 'observed',
    diagnostic: null,
    artifacts: [],
    limitations: [],
    ...overrides,
  };
}

test('generated template traverses CLI preflight, controlled production driver, and workflow report roundtrip for C01 and C02', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-25T00:00:00.000Z') });
  const copyBefore = prodCopyTempCount();

  const s01 = await setupProductionScenario({ tag: 'tpl-rt-c01', fetchMode: 'repair', decisions: ['approve', 'approve'] });
  try {
    const probe = wrapFetch(RET);
    const tpl = await applyTemplate(s01.hostFile);

    const pre = await runEvaluateCli(['preflight', '--host', s01.hostFile]);
    assert.equal(pre.exitCode, 0, pre.output);
    const preJson = JSON.parse(pre.output) as { outcome: string; operational?: string; metadata?: { model?: string } };
    assert.equal(preJson.outcome, 'ready');
    assert.equal(preJson.operational, 'ready');
    assert.equal(preJson.metadata?.model, tpl.requestedModel);
    assert.equal(s01.fetchSpy.requests.length, 0);

    const run01 = await runEvaluateCli(['run', '--host', s01.hostFile, '--mode', 'real', '--cases', 'C01']);
    assert.equal(run01.exitCode, 0, run01.output);
    assert.equal(run01.output.includes('EVALUATION_REFUSED'), false);
    assert.equal(run01.output.includes('HOST_ROUTE_UNAVAILABLE'), false);

    const report01 = validateWorkflowEvaluationReport(parseCliReport(run01.output));
    assert.equal(report01.mode, 'real');
    assert.equal(report01.tier, 'real-integration');
    assert.equal(report01.isRealVerified, false);
    assert.equal(report01.selectionResult.outcome, 'pass');
    assert.equal(report01.selectionResult.passed, 1);

    const c01 = report01.cases[0] as WorkflowCaseResult;
    assert.equal(c01.caseId, 'C01');
    assert.equal(c01.grade, 'pass');
    assert.equal(c01.gradeReason, 'criteria-satisfied');
    assert.equal(c01.workflowOutcome, 'COMPLETED');
    assert.deepEqual(c01.adapterVersions, [VER]);
    assert.equal(c01.requestedModel, tpl.requestedModel);
    assert.equal(c01.returnedModel, RET);
    assert.equal(c01.graderDigest, s01.c01GraderDigest);
    assert.equal(c01.initialRepositoryDigest, s01.c01InitialDigest);
    assert.ok(c01.artifacts.includes(`model:req=${tpl.requestedModel};ret=${RET}`), JSON.stringify(c01.artifacts));
    assert.equal(s01.spawnSpy.hiddenChecks.length, 1);
    assert.equal(s01.getOperatorReads(), 2);
    assert.ok(probe.requested.length >= 4 && probe.requested.every(m => m === tpl.requestedModel));
    assert.equal(probe.leaked(), false);
    assert.equal(prodCopyTempCount(), copyBefore);
  } finally {
    s01.cleanup();
  }

  const s02 = await setupProductionScenario({ tag: 'tpl-rt-c02', fetchMode: 'clarify', decisions: [] });
  try {
    wrapFetch(RET);
    const tpl = await applyTemplate(s02.hostFile);
    const run02 = await runEvaluateCli(['run', '--host', s02.hostFile, '--mode', 'real', '--cases', 'C02']);
    assert.equal(run02.exitCode, 0, run02.output);
    const report02 = validateWorkflowEvaluationReport(parseCliReport(run02.output));
    assert.equal(report02.tier, 'real-integration');
    assert.equal(report02.selectionResult.outcome, 'pass');
    const c02 = report02.cases[0] as WorkflowCaseResult;
    assert.equal(c02.caseId, 'C02');
    assert.equal(c02.workflowOutcome, 'waiting-info');
    assert.equal(c02.grade, 'pass');
    assert.equal(c02.gradeReason, 'criteria-satisfied');
    assert.deepEqual(c02.adapterVersions, [VER]);
    assert.equal(c02.requestedModel, tpl.requestedModel);
    assert.equal(c02.returnedModel, RET);
    assert.equal(s02.getOperatorReads(), 0);
  } finally {
    s02.cleanup();
  }
});

test('field-specific version/model validation allows bounded slashes, keeps generic IDs narrow, and refuses malformed/protected inputs with zero effects', async () => {
  for (const ok of [VER, 'vendor/adapter:v1.2_3', REQ, 'nvidia/nemotron-3.5-lightning:free', 'a'.repeat(192), `vendor/${'a'.repeat(185)}`]) {
    const parsedOpts = validateWorkflowEvaluationOptions(opts({ adapterVersions: [ok], requestedModel: ok }));
    assert.deepEqual(parsedOpts.adapterVersions, [ok]);
    assert.equal(parsedOpts.requestedModel, ok);
    assert.equal(validateWorkflowObservation(obs({ returnedModel: ok })).returnedModel, ok);
  }

  for (const field of ['repositoryId', 'taskId', 'runId'] as const) {
    assert.throws(() => validateWorkflowObservation(obs({ [field]: 'org/narrow-id' })), /Invalid workflow evaluation report/u);
    assert.throws(() => validateWorkflowObservation(obs({ [field]: 'AGENTS.md' })), /Invalid workflow evaluation report/u);
    assert.throws(() => validateWorkflowObservation(obs({ [field]: 'credentials.json' })), /Invalid workflow evaluation report/u);
  }

  const badInputs = [
    '',
    '/',
    '/uc03-real-tier/1',
    'uc03-real-tier/',
    'uc03-real-tier//1',
    'uc03-real-tier/../1',
    'openai/../secret',
    '..uc03',
    '-uc03',
    'uc03/adapter/-bad',
    'uc03 real-tier/1',
    'uc03\\real-tier',
    'uc03-real-tier/1\n',
    'C:/host-only/file',
    'a'.repeat(193),
    `vendor/${'a'.repeat(186)}`,
    'sk-live-0123456789abcdefghij',
    'MARKER_SECRET_VALUE',
    '.env',
    '.env.local',
    'credentials.json',
    'secrets.json',
    '.git/config',
    'AGENTS.md',
    'CLAUDE.md',
    'id_rsa',
    'api_key=value',
  ] as const;

  let driverCalls = 0;
  const countingDriver = {
    executeCase() {
      driverCalls += 1;
      return obs();
    },
  };

  for (const bad of badInputs) {
    assert.throws(() => validateWorkflowEvaluationOptions(opts({ adapterVersions: [bad] })), /Invalid workflow evaluation options/u);
    assert.throws(() => validateWorkflowEvaluationOptions(opts({ requestedModel: bad })), /Invalid workflow evaluation options/u);
    assert.throws(() => validateWorkflowObservation(obs({ returnedModel: bad })), /Invalid workflow evaluation report/u);

    await assert.rejects(runEvaluation(opts({ adapterVersions: [bad], driver: countingDriver })), /Invalid workflow evaluation options/u);
    const cli = await runEvaluateCli(['--mode', 'mock', '--cases', 'C01'], {
      profileDigest: D1,
      configDigest: D1,
      pricingDigest: D1,
      adapterVersions: [bad],
      requestedModel: REQ,
      driver: countingDriver,
    });
    assert.equal(cli.exitCode, 2);
    assert.equal((JSON.parse(cli.output) as { error?: string }).error, 'EVALUATION_REFUSED');
    assert.equal(bad.length > 1 ? cli.output.includes(bad) : false, false);
  }
  assert.equal(driverCalls, 0);

  const valid = await runEvaluation(opts({ driver: countingDriver }));
  assert.ok('cases' in valid);
  const c0 = valid.cases[0];
  assert.ok(c0 !== undefined);
  assert.doesNotThrow(() => validateWorkflowEvaluationReport(valid));
  assert.throws(() => validateWorkflowEvaluationReport({ ...valid, cases: [{ ...c0, taskId: 'team/task-1' }] }));
  assert.throws(() => validateWorkflowEvaluationReport({ ...valid, cases: [{ ...c0, returnedModel: 'openai/../secret' }] }));
  assert.throws(() => validateWorkflowEvaluationReport({ ...valid, cases: [{ ...c0, adapterVersions: ['AGENTS.md'] }] }));

  const sBadRet = await setupProductionScenario({ tag: 'tpl-bad-ret', fetchMode: 'clarify', decisions: [] });
  try {
    wrapFetch('../secret');
    await applyTemplate(sBadRet.hostFile);
    const runBad = await runEvaluateCli(['run', '--host', sBadRet.hostFile, '--mode', 'real', '--cases', 'C02']);
    assert.equal(runBad.exitCode, 0, runBad.output);
    const rep = validateWorkflowEvaluationReport(parseCliReport(runBad.output));
    assert.equal(rep.cases[0]?.returnedModel, null);
    assert.equal(
      rep.cases[0]?.artifacts.some(a => a.includes('../secret')),
      false,
    );
  } finally {
    sBadRet.cleanup();
  }
});

test('copied, stale, and foreign admission and observation receipts are refused for slash-versioned template bindings', async () => {
  const binding = { profileDigest: D1, configDigest: D1, pricingDigest: D1, adapterVersions: [VER], caseIds: ['C02'], requestedModel: REQ };
  const receipt = issueRealExecutionAdmission(binding);
  assert.equal(isAdmittedRealExecutionAdmission(receipt, binding), true);

  let driverCalls = 0;
  const driver = {
    executeCase() {
      driverCalls += 1;
      return obs({ workflowOutcome: 'waiting-info', expectedWait: 'waiting-info' });
    },
  };

  const badAdms = [
    { ...receipt },
    { admissionId: receipt.admissionId, profileDigest: receipt.profileDigest, bindingDigest: receipt.bindingDigest },
    issueRealExecutionAdmission({ ...binding, profileDigest: D2 }),
    issueRealExecutionAdmission({ ...binding, adapterVersions: ['uc03-real-tier/2'] }),
    issueRealExecutionAdmission({ ...binding, caseIds: ['C01'] }),
    issueRealExecutionAdmission({ ...binding, requestedModel: RET }),
  ];

  for (const badAdm of badAdms) {
    const refused = await runEvaluation(opts({ mode: 'real', cases: ['C02'], realAdmission: badAdm as EvaluateCliOptions['realAdmission'], driver }));
    assert.ok('cases' in refused);
    assert.equal(refused.cases[0]?.grade, 'not-run');
    assert.equal(refused.cases[0]?.gradeReason, 'real-execution-unavailable');
    assert.equal(driverCalls, 0);
  }

  const fixture = await controlledGeneratedPlanFixture();
  const checkedObs = validateWorkflowObservation(
    obs({ repositoryId: fixture.task.repositoryId, taskId: fixture.task.taskId, runId: 'run-tpl-obs-1', workflowOutcome: 'waiting-info', expectedWait: 'waiting-info' }),
  );
  const grader = createSnapshotGrader({
    criteria: { digest: `sha256:${sha256Text('crit')}`, criteria: [{ criterionId: 'c2', caseId: 'C02', predicate: 'clarification', hiddenCheckId: null }] },
    profile: { profileId: 'p', digest: `sha256:${sha256Text('p')}`, bounds: { timeoutMs: 1000, maxCpuMs: 1000, maxOutputBytes: 4096, maxMemoryBytes: 65536, maxProcesses: 4 } },
    isolationAuthority: { admit: () => undefined },
    executor: { executorId: 'e', execute: () => undefined },
    graderPayload: null,
  });
  const snap = () => ({
    taskId: fixture.task.taskId,
    runId: 'run-tpl-obs-1',
    workspaceId: 'ws',
    repositoryId: fixture.task.repositoryId,
    initialRevisionDigest: fixture.task.initialRevisionDigest,
    finalRevisionDigest: fixture.task.initialRevisionDigest,
    snapshotId: 'snap-1',
    complete: true,
    files: [{ path: 'src/calculator.py', content: 'def divide(a, b): return a / b\n' }],
  });
  await produceWorkflowEvidence({
    caseId: 'C02',
    mode: 'real',
    task: fixture.task,
    result: {
      outcome: 'INCOMPLETE',
      state: { taskId: fixture.task.taskId, runId: 'run-tpl-obs-1', workspaceId: 'ws', repositoryId: fixture.task.repositoryId, repositoryRevisionDigest: fixture.task.initialRevisionDigest } as never,
      reasons: [],
    } as never,
    observation: checkedObs,
    repository: undefined,
    host: { grader, finalTree: { freezeFinalTree: snap, recheckCurrentFinalTree: snap } },
  });
  assert.equal(workflowEvidenceDecision('C02', 'real', { ...checkedObs }), undefined);
  assert.equal(workflowEvidenceDecision('C02', 'real', Object.assign(checkedObs, { returnedModel: 'other/model' })), undefined);
});

test('adjacent shared registration and v2 selection accept slash adapterVersion/model while preserving narrow generic IDs', async () => {
  const payload = { report: 'synthetic real-tier template shared check' };
  const reg = registerEvaluation(
    {
      contractVersion: 'shared-evaluation-v1',
      ucId: 'UC-08',
      datasetId: 'tpl-shared',
      datasetVersion: '1',
      adapterVersion: VER,
      graderVersion: 'grader-v1',
      provenance: 'real',
      cases: [
        {
          caseId: 'UC-08:C01:tpl',
          caseDigest: canonicalDigest('PublicCase', payload),
          levels: ['real-integration'],
          gate: 'hard',
          classificationScored: false,
          attack: false,
          digestProfile: 'canonical-json-v1',
          payload,
        },
      ],
    },
    { execute: async () => ({ ok: true }), grade: async () => ({ status: 'pass', classification: 'not-applicable', safety: true, oracleDigest: D1, components: {} }) },
    { 'UC-08:C01:tpl': D1 },
  );
  const binding = { profileDigest: D1, configDigest: D1, pricingDigest: D1, adapterVersions: [VER], caseIds: ['UC-08:C01:tpl'], requestedModel: REQ };
  const report = await runAdmittedEvaluation({
    contractVersion: 'shared-evaluation-v2',
    scope: 'uc',
    mode: 'real',
    runId: 'tpl-shared-run-1',
    attemptId: 'att-1',
    codeRevision: REV,
    perCaseTimeoutMs: 2000,
    registrations: [reg],
    selections: [
      {
        ucId: 'UC-08',
        datasetId: 'tpl-shared',
        datasetVersion: '1',
        level: 'real-integration',
        caseIds: ['UC-08:C01:tpl'],
        requiredCases: 1,
        requiredAttacks: 0,
        configDigest: D1,
        profileDigest: D1,
        pricingDigest: D1,
        adapterVersions: [VER],
        requestedModel: REQ,
        realAdmission: issueRealExecutionAdmission(binding),
      },
    ],
  });
  assert.equal(report.results[0]?.status, 'pass');
  assert.equal(report.results[0]?.adapterVersion, VER);

  assert.throws(() =>
    registerEvaluation({ contractVersion: 'shared-evaluation-v1', ucId: 'UC-08', datasetId: 'bad/id', datasetVersion: '1', adapterVersion: VER, graderVersion: 'g1', provenance: 'real', cases: [] }),
  );
  assert.throws(() =>
    registerEvaluation({
      contractVersion: 'shared-evaluation-v1',
      ucId: 'UC-08',
      datasetId: 'ok',
      datasetVersion: '1',
      adapterVersion: 'AGENTS.md',
      graderVersion: 'g1',
      provenance: 'real',
      cases: reg.cases,
    }),
  );
});
