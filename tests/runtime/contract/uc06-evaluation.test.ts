import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runRegisteredEvaluation,
  runAdmittedEvaluation,
  issueRealExecutionAdmission,
  type RegisteredEvaluation,
  type SharedSelection,
  type SharedSelectionV2,
  type SharedEvaluationOptions,
  type SharedEvaluationOptionsV2,
} from '../../../eval/shared.ts';
import {
  registerUC06Evaluation,
  UC06_DATASET_ID,
  UC06_DATASET_VERSION,
  UC06_DATASET_ADAPTER_VERSION,
  UC06_GRADER_VERSION,
  UC06_ALL_ORACLE_PINS,
  type UC06EvaluationAdapter,
} from '../../../eval/uc06/registration.ts';
import { registerUC03WorkflowEvaluation, UC03_DATASET_ID } from '../../../eval/uc03/registration.ts';

let runSeq = 0;
const DUMMY_HASH = 'a'.repeat(64);
const CONFIG_HASH = 'b'.repeat(64);
const PRICING_HASH = 'c'.repeat(64);

function makeSelectionV1(registration: RegisteredEvaluation, level: 'contract' | 'mock-behavior' | 'model-quality', caseIds: readonly string[]): SharedSelection {
  return {
    ucId: registration.ucId,
    datasetId: registration.datasetId,
    datasetVersion: registration.datasetVersion,
    level,
    caseIds,
    requiredCases: caseIds.length,
    requiredAttacks: registration.cases.filter(c => caseIds.includes(c.caseId) && c.attack).length,
    configDigest: CONFIG_HASH,
  };
}

function makeSelectionV2(
  registration: RegisteredEvaluation,
  level: 'contract' | 'mock-behavior' | 'model-quality',
  caseIds: readonly string[],
  overrides?: Partial<SharedSelectionV2>,
): SharedSelectionV2 {
  return {
    ucId: registration.ucId,
    datasetId: registration.datasetId,
    datasetVersion: registration.datasetVersion,
    level,
    caseIds,
    requiredCases: caseIds.length,
    requiredAttacks: registration.cases.filter(c => caseIds.includes(c.caseId) && c.attack).length,
    configDigest: CONFIG_HASH,
    profileDigest: DUMMY_HASH,
    pricingDigest: PRICING_HASH,
    adapterVersions: [registration.adapterVersion],
    requestedModel: 'deepseek-chat',
    ...overrides,
  };
}

test('UC-06 registration registers public cases and isolates private labels and grader secrets', () => {
  const reg = registerUC06Evaluation();
  assert.equal(reg.ucId, 'UC-06');
  assert.equal(reg.datasetId, UC06_DATASET_ID);
  assert.equal(reg.datasetVersion, UC06_DATASET_VERSION);
  assert.equal(reg.adapterVersion, UC06_DATASET_ADAPTER_VERSION);
  assert.equal(reg.graderVersion, UC06_GRADER_VERSION);
  assert.equal(reg.cases.length, 32);

  assert.equal(reg.cases.filter(c => c.caseId.startsWith('UC-06:R')).length, 20);
  assert.equal(reg.cases.filter(c => c.caseId.startsWith('UC-06:Q')).length, 12);

  for (const c of reg.cases) {
    const raw = JSON.stringify(c.payload);
    assert.ok(!raw.includes('startLine'), `startLine leaked in public payload for ${c.caseId}`);
    assert.ok(!raw.includes('endLine'), `endLine leaked in public payload for ${c.caseId}`);
    assert.ok(!raw.includes('requiredKeywordGroups'), `requiredKeywordGroups leaked in ${c.caseId}`);
    assert.ok(!raw.includes('expectedStatus'), `expectedStatus leaked in ${c.caseId}`);
    assert.ok(!raw.includes('DEF-'), `defectId leaked in ${c.caseId}`);
  }

  assert.equal(Object.keys(UC06_ALL_ORACLE_PINS).length, 32);
  for (const pin of Object.values(UC06_ALL_ORACLE_PINS)) {
    assert.match(pin, /^[a-f0-9]{64}$/u);
  }
});

test('v1 runner executes UC-06 mock cases and refuses real-tier levels without fabricated pass', async () => {
  const reg = registerUC06Evaluation();
  const rCaseIds = ['UC-06:R01', 'UC-06:R02'];
  const selMock = makeSelectionV1(reg, 'mock-behavior', rCaseIds);

  const reqMock: SharedEvaluationOptions = {
    contractVersion: 'shared-evaluation-v1',
    scope: 'uc',
    mode: 'mock',
    runId: `v1-test-${++runSeq}`,
    attemptId: 'att-1',
    codeRevision: 'rev-1',
    perCaseTimeoutMs: 1000,
    registrations: [reg],
    selections: [selMock],
  };

  const reportMock = await runRegisteredEvaluation(reqMock);
  assert.equal(reportMock.contractVersion, 'shared-evaluation-v1');
  assert.equal(reportMock.results.length, 2);
  assert.equal(reportMock.results[0]?.status, 'not-run');
  assert.equal(reportMock.results[0]?.reasonCode, 'driver-or-grader-unavailable');

  const qCaseIds = ['UC-06:Q01'];
  const selQuality = makeSelectionV1(reg, 'model-quality', qCaseIds);
  const reqQuality: SharedEvaluationOptions = {
    contractVersion: 'shared-evaluation-v1',
    scope: 'uc',
    mode: 'mock',
    runId: `v1-test-${++runSeq}`,
    attemptId: 'att-1',
    codeRevision: 'rev-1',
    perCaseTimeoutMs: 1000,
    registrations: [reg],
    selections: [selQuality],
  };

  const reportQuality = await runRegisteredEvaluation(reqQuality);
  assert.equal(reportQuality.results[0]?.status, 'not-run');
  assert.equal(reportQuality.results[0]?.reasonCode, 'real-execution-unavailable');

  const reqReal: SharedEvaluationOptions = {
    ...reqMock,
    mode: 'real',
    runId: `v1-test-${++runSeq}`,
  };
  const reportReal = await runRegisteredEvaluation(reqReal);
  assert.equal(reportReal.results[0]?.status, 'not-run');
  assert.equal(reportReal.results[0]?.reasonCode, 'real-execution-unavailable');
});

test('v2 runner admits real execution with valid RealExecutionAdmission and rejects invalid or missing admission', async () => {
  let callCount = 0;
  const mockAdapter: UC06EvaluationAdapter = {
    version: 'test-real-adapter-v1',
    provenance: 'real',
    execute: async () => {
      callCount++;
      return { caseId: 'UC-06:Q01', result: { status: 'accepted', summary: 'clean', findings: [] } };
    },
  };

  const reg = registerUC06Evaluation(mockAdapter);
  const caseIds = ['UC-06:Q01'];

  const binding = {
    profileDigest: DUMMY_HASH,
    configDigest: CONFIG_HASH,
    pricingDigest: PRICING_HASH,
    adapterVersions: [mockAdapter.version],
    caseIds,
    requestedModel: 'deepseek-chat',
  };

  const admission = issueRealExecutionAdmission(binding);

  const selWithAdmission = makeSelectionV2(reg, 'model-quality', caseIds, {
    adapterVersions: [mockAdapter.version],
    realAdmission: admission,
  });

  const reqAdmitted: SharedEvaluationOptionsV2 = {
    contractVersion: 'shared-evaluation-v2',
    scope: 'uc',
    mode: 'real',
    runId: `v2-real-${++runSeq}`,
    attemptId: 'att-1',
    codeRevision: 'rev-1',
    perCaseTimeoutMs: 2000,
    registrations: [reg],
    selections: [selWithAdmission],
  };

  const reportAdmitted = await runAdmittedEvaluation(reqAdmitted);
  assert.equal(reportAdmitted.contractVersion, 'shared-evaluation-v2');
  assert.equal(reportAdmitted.results[0]?.status, 'pass');
  assert.equal(reportAdmitted.results[0]?.reasonCode, 'criteria-satisfied');
  assert.equal(callCount, 1);

  // Missing admission in real mode
  const selMissing = makeSelectionV2(reg, 'model-quality', caseIds, {
    adapterVersions: [mockAdapter.version],
    realAdmission: undefined,
  });

  const reqMissing: SharedEvaluationOptionsV2 = {
    contractVersion: 'shared-evaluation-v2',
    scope: 'uc',
    mode: 'real',
    runId: `v2-real-${++runSeq}`,
    attemptId: 'att-1',
    codeRevision: 'rev-1',
    perCaseTimeoutMs: 2000,
    registrations: [reg],
    selections: [selMissing],
  };

  const reportMissing = await runAdmittedEvaluation(reqMissing);
  assert.equal(reportMissing.results[0]?.status, 'not-run');
  assert.equal(reportMissing.results[0]?.reasonCode, 'real-admission-missing-or-invalid');
  assert.equal(callCount, 1, 'Callback must NOT be called when admission is missing');

  // Forged admission
  const forgedAdmission = {
    admissionId: 'forged-admission-id',
    profileDigest: DUMMY_HASH,
    bindingDigest: 'f'.repeat(64),
  };

  const selForged = makeSelectionV2(reg, 'model-quality', caseIds, {
    adapterVersions: [mockAdapter.version],
    realAdmission: forgedAdmission as unknown as typeof admission,
  });

  const reqForged: SharedEvaluationOptionsV2 = {
    contractVersion: 'shared-evaluation-v2',
    scope: 'uc',
    mode: 'real',
    runId: `v2-real-${++runSeq}`,
    attemptId: 'att-1',
    codeRevision: 'rev-1',
    perCaseTimeoutMs: 2000,
    registrations: [reg],
    selections: [selForged],
  };

  const reportForged = await runAdmittedEvaluation(reqForged);
  assert.equal(reportForged.results[0]?.status, 'not-run');
  assert.equal(reportForged.results[0]?.reasonCode, 'real-admission-missing-or-invalid');
  assert.equal(callCount, 1, 'Callback must NOT be called with forged admission');
});

test('v2 runner executes mock and quality evaluation with exact localized grading and oracle pins', async () => {
  const adapter: UC06EvaluationAdapter = {
    version: 'mock-eval-adapter-v1',
    provenance: 'real',
    execute: async payload => {
      const p = payload as { caseId: string };
      if (p.caseId === 'Q01') {
        return { caseId: 'UC-06:Q01', result: { status: 'accepted', summary: 'clean', findings: [] } };
      }
      if (p.caseId === 'Q07') {
        return {
          caseId: 'UC-06:Q07',
          result: {
            status: 'changes_requested',
            summary: 'Defect detected',
            findings: [
              {
                findingId: 'F1',
                file: 'src/calculator.py',
                side: 'new',
                line: 15,
                category: 'logic',
                severity: 'error',
                message: 'Division by zero check has inverted comparison allowing zero denominator',
              },
            ],
          },
        };
      }
      return { caseId: p.caseId, status: 'pass' };
    },
  };

  const reg = registerUC06Evaluation(adapter);
  const qCaseIds = ['UC-06:Q01', 'UC-06:Q07'];

  // Test mode: 'mock' on model-quality returns real-execution-unavailable
  const selMock = makeSelectionV2(reg, 'model-quality', qCaseIds);
  const reqMock: SharedEvaluationOptionsV2 = {
    contractVersion: 'shared-evaluation-v2',
    scope: 'uc',
    mode: 'mock',
    runId: `v2-mock-q-${++runSeq}`,
    attemptId: 'att-1',
    codeRevision: 'rev-1',
    perCaseTimeoutMs: 2000,
    registrations: [reg],
    selections: [selMock],
  };
  const reportMock = await runAdmittedEvaluation(reqMock);
  assert.equal(reportMock.results[0]?.status, 'not-run');
  assert.equal(reportMock.results[0]?.reasonCode, 'real-execution-unavailable');

  // Test mode: 'real' with admission passes localized grading
  const binding = {
    profileDigest: DUMMY_HASH,
    configDigest: CONFIG_HASH,
    pricingDigest: PRICING_HASH,
    adapterVersions: [adapter.version],
    caseIds: qCaseIds,
    requestedModel: 'deepseek-chat',
  };
  const admission = issueRealExecutionAdmission(binding);
  const selReal = makeSelectionV2(reg, 'model-quality', qCaseIds, {
    adapterVersions: [adapter.version],
    realAdmission: admission,
  });

  const reqReal: SharedEvaluationOptionsV2 = {
    contractVersion: 'shared-evaluation-v2',
    scope: 'uc',
    mode: 'real',
    runId: `v2-real-q-${++runSeq}`,
    attemptId: 'att-1',
    codeRevision: 'rev-1',
    perCaseTimeoutMs: 2000,
    registrations: [reg],
    selections: [selReal],
  };

  const report = await runAdmittedEvaluation(reqReal);
  assert.equal(report.contractVersion, 'shared-evaluation-v2');
  assert.equal(report.results.length, 2);

  const resQ01 = report.results.find(r => r.caseId === 'UC-06:Q01');
  assert.equal(resQ01?.status, 'pass');
  assert.equal(resQ01?.classification, 'correct');
  assert.equal(resQ01?.safety, true);
  assert.equal(resQ01?.reasonCode, 'criteria-satisfied');

  const resQ07 = report.results.find(r => r.caseId === 'UC-06:Q07');
  assert.equal(resQ07?.status, 'pass');
  assert.equal(resQ07?.classification, 'correct');
  assert.equal(resQ07?.safety, true);
  assert.equal(resQ07?.reasonCode, 'criteria-satisfied');
});

test('safety violation in observation fails grade with safety: false', async () => {
  const unsafeAdapter: UC06EvaluationAdapter = {
    version: 'unsafe-mock-adapter-v1',
    provenance: 'real',
    execute: async () => ({
      caseId: 'UC-06:Q01',
      protectedDisclosureDetected: true,
      result: { status: 'accepted', summary: 'leaked credentials', findings: [] },
    }),
  };

  const reg = registerUC06Evaluation(unsafeAdapter);
  const caseIds = ['UC-06:Q01'];
  const binding = {
    profileDigest: DUMMY_HASH,
    configDigest: CONFIG_HASH,
    pricingDigest: PRICING_HASH,
    adapterVersions: [unsafeAdapter.version],
    caseIds,
    requestedModel: 'deepseek-chat',
  };
  const admission = issueRealExecutionAdmission(binding);
  const sel = makeSelectionV2(reg, 'model-quality', caseIds, {
    adapterVersions: [unsafeAdapter.version],
    realAdmission: admission,
  });

  const req: SharedEvaluationOptionsV2 = {
    contractVersion: 'shared-evaluation-v2',
    scope: 'uc',
    mode: 'real',
    runId: `v2-safety-${++runSeq}`,
    attemptId: 'att-1',
    codeRevision: 'rev-1',
    perCaseTimeoutMs: 2000,
    registrations: [reg],
    selections: [sel],
  };

  const report = await runAdmittedEvaluation(req);
  assert.equal(report.results[0]?.status, 'fail');
  assert.equal(report.results[0]?.safety, false);
  assert.equal(report.results[0]?.reasonCode, 'criteria-violation');
});

test('regression: UC-03 registration remains compatible with v2 runner', async () => {
  const uc03Cases = [
    {
      caseId: 'C01',
      name: 'Controlled repair',
      description: 'Single attempt repair verification',
      category: 'correctness',
      required: true,
      expectedOutcome: 'COMPLETED',
      requirements: ['FR-001'],
    },
  ];

  const reg03 = registerUC03WorkflowEvaluation(uc03Cases);
  assert.equal(reg03.ucId, 'UC-03');
  assert.equal(reg03.datasetId, UC03_DATASET_ID);

  const sel03 = makeSelectionV2(reg03, 'mock-behavior', ['UC-03:C01']);
  const req: SharedEvaluationOptionsV2 = {
    contractVersion: 'shared-evaluation-v2',
    scope: 'uc',
    mode: 'mock',
    runId: `v2-uc03-reg-${++runSeq}`,
    attemptId: 'att-1',
    codeRevision: 'rev-1',
    perCaseTimeoutMs: 2000,
    registrations: [reg03],
    selections: [sel03],
  };

  const report = await runAdmittedEvaluation(req);
  assert.equal(report.contractVersion, 'shared-evaluation-v2');
  assert.equal(report.results[0]?.status, 'not-run');
  assert.equal(report.results[0]?.reasonCode, 'driver-or-grader-unavailable');
});
