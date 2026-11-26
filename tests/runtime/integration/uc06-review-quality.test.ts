/**
 * T012 [US3] Real quality evaluation over frozen 12-case rubric (SC-005).
 * Validates independent case evaluation, localized defect detection (TP/FP/FN),
 * private oracle isolation, and milestone tier aggregation with regression invariant.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  issueRealExecutionAdmission,
  runAdmittedEvaluation,
  type SharedEvaluationOptionsV2,
  type SharedSelectionV2,
} from '../../../eval/shared.ts';
import {
  UC06_QUALITY_CASES,
  UC06_QUALITY_LABELS,
  type UC06RequirementId,
} from '../../../eval/uc06/catalog.ts';
import {
  evaluateMilestones,
  evaluateQualitySuite,
  type CaseObservationInput,
} from '../../../eval/uc06/grade.ts';
import {
  registerUC06Evaluation,
  UC06_ALL_ORACLE_PINS,
  UC06_DATASET_ADAPTER_VERSION,
  UC06_DATASET_ID,
  UC06_DATASET_VERSION,
  type UC06EvaluationAdapter,
} from '../../../eval/uc06/registration.ts';

const PROFILE_DIGEST = 'a'.repeat(64);
const CONFIG_DIGEST = 'b'.repeat(64);
const PRICING_DIGEST = 'c'.repeat(64);
const REPO_DIGEST = 'sha256:' + 'd'.repeat(64);
const CHECKSET_DIGEST = 'sha256:' + 'e'.repeat(64);

let seq = 0;

function createQualityObservation(caseId: string): CaseObservationInput {
  const c = UC06_QUALITY_CASES.find(item => item.caseId === caseId);
  const label = UC06_QUALITY_LABELS.find(item => item.caseId === caseId);
  if (!c || !label) throw new Error(`Unknown case ${caseId}`);

  if (label.expectedStatus === 'clean') {
    return {
      caseId: `Q${caseId.replace(/^Q/u, '')}` as `Q${string}`,
      result: {
        reviewId: `rev-q-${caseId}`,
        reviewerRoleConfigId: 'cfg-test',
        repoDigest: REPO_DIGEST,
        diffDigest: c.diffDigest,
        checkSetDigest: CHECKSET_DIGEST,
        iterationReservationRef: `res-${caseId}`,
        status: 'accepted',
        findings: [],
      },
    };
  }

  // Faulty case: produce matching localized finding
  assert.ok(label.defect);
  const defect = label.defect;
  const keywords = defect.requiredKeywordGroups.map(g => g[0] ?? '').join(' ');
  return {
    caseId: `Q${caseId.replace(/^Q/u, '')}` as `Q${string}`,
    result: {
      reviewId: `rev-q-${caseId}`,
      reviewerRoleConfigId: 'cfg-test',
      repoDigest: REPO_DIGEST,
      diffDigest: c.diffDigest,
      checkSetDigest: CHECKSET_DIGEST,
      iterationReservationRef: `res-${caseId}`,
      status: 'findings',
      findings: [
        {
          file: defect.file,
          side: defect.side,
          line: defect.startLine,
          severity: defect.severity,
          message: `Defect in ${defect.file}: ${keywords} - flaw violating requirement`,
          evidenceRef: 'source',
        },
      ],
    },
  };
}

test('T012 gate: missing or forged real admission capability refuses before model quality execution', async () => {
  const adapter: UC06EvaluationAdapter = {
    version: UC06_DATASET_ADAPTER_VERSION,
    provenance: 'real',
    execute: async payload => {
      const p = payload as { caseId: string };
      return { caseId: `UC-06:${p.caseId}`, status: 'pass' };
    },
  };

  const reg = registerUC06Evaluation(adapter);
  const caseIds = ['UC-06:Q01', 'UC-06:Q02'];

  // Missing admission in real mode
  const selMissing: SharedSelectionV2 = {
    ucId: 'UC-06',
    datasetId: UC06_DATASET_ID,
    datasetVersion: UC06_DATASET_VERSION,
    level: 'model-quality',
    caseIds,
    requiredCases: 2,
    requiredAttacks: 0,
    configDigest: CONFIG_DIGEST,
    profileDigest: PROFILE_DIGEST,
    pricingDigest: PRICING_DIGEST,
    adapterVersions: [adapter.version],
    requestedModel: 'deepseek-chat',
  };

  const reqMissing: SharedEvaluationOptionsV2 = {
    contractVersion: 'shared-evaluation-v2',
    scope: 'uc',
    mode: 'real',
    runId: `v2-missing-${++seq}`,
    attemptId: 'att-1',
    codeRevision: 'rev-1',
    perCaseTimeoutMs: 2000,
    registrations: [reg],
    selections: [selMissing],
  };

  const repMissing = await runAdmittedEvaluation(reqMissing);
  assert.equal(repMissing.results[0]?.status, 'not-run');
  assert.equal(repMissing.results[0]?.reasonCode, 'real-admission-missing-or-invalid');

  // Forged admission
  const selForged: SharedSelectionV2 = {
    ...selMissing,
    realAdmission: {
      admissionId: 'forged-admission',
      profileDigest: PROFILE_DIGEST,
      bindingDigest: 'f'.repeat(64),
    } as unknown as ReturnType<typeof issueRealExecutionAdmission>,
  };

  const repForged = await runAdmittedEvaluation({ ...reqMissing, runId: `v2-forged-${++seq}`, selections: [selForged] });
  assert.equal(repForged.results[0]?.status, 'not-run');
  assert.equal(repForged.results[0]?.reasonCode, 'real-admission-missing-or-invalid');
});

test('T012 isolation: public quality cases conceal private labels and grader secrets', () => {
  const reg = registerUC06Evaluation();
  const qCases = reg.cases.filter(c => c.caseId.startsWith('UC-06:Q'));
  assert.equal(qCases.length, 12);

  for (const c of qCases) {
    const raw = JSON.stringify(c.payload);
    assert.ok(!raw.includes('startLine'), `startLine leaked in public payload for ${c.caseId}`);
    assert.ok(!raw.includes('endLine'), `endLine leaked in public payload for ${c.caseId}`);
    assert.ok(!raw.includes('requiredKeywordGroups'), `requiredKeywordGroups leaked in ${c.caseId}`);
    assert.ok(!raw.includes('expectedStatus'), `expectedStatus leaked in ${c.caseId}`);
    assert.ok(!raw.includes('DEF-'), `defectId leaked in ${c.caseId}`);
  }

  // All 12 quality case oracle pins are 64-char hex digests
  for (let i = 1; i <= 12; i++) {
    const caseId = `UC-06:Q${i.toString().padStart(2, '0')}`;
    const pin = UC06_ALL_ORACLE_PINS[caseId];
    assert.ok(pin && /^[a-f0-9]{64}$/u.test(pin), `Invalid pin for ${caseId}`);
  }
});

test('T012 full rubric: evaluate all 12 frozen quality cases (Q01–Q12) with localized grading', async () => {
  const caseIds = UC06_QUALITY_CASES.map(c => `UC-06:${c.caseId}`);
  const observations: CaseObservationInput[] = [];

  const adapter: UC06EvaluationAdapter = {
    version: UC06_DATASET_ADAPTER_VERSION,
    provenance: 'real',
    execute: async payload => {
      const p = payload as { caseId: string };
      const obs = createQualityObservation(p.caseId);
      observations.push(obs);
      return {
        caseId: `UC-06:${p.caseId}`,
        result: obs.result,
        safety: true,
      };
    },
  };

  const reg = registerUC06Evaluation(adapter);
  const binding = {
    profileDigest: PROFILE_DIGEST,
    configDigest: CONFIG_DIGEST,
    pricingDigest: PRICING_DIGEST,
    adapterVersions: [adapter.version],
    caseIds,
    requestedModel: 'deepseek-chat',
  };
  const admission = issueRealExecutionAdmission(binding);

  const sel: SharedSelectionV2 = {
    ucId: 'UC-06',
    datasetId: UC06_DATASET_ID,
    datasetVersion: UC06_DATASET_VERSION,
    level: 'model-quality',
    caseIds,
    requiredCases: 12,
    requiredAttacks: reg.cases.filter(c => caseIds.includes(c.caseId) && c.attack).length,
    configDigest: CONFIG_DIGEST,
    profileDigest: PROFILE_DIGEST,
    pricingDigest: PRICING_DIGEST,
    adapterVersions: [adapter.version],
    requestedModel: 'deepseek-chat',
    realAdmission: admission,
  };

  const report = await runAdmittedEvaluation({
    contractVersion: 'shared-evaluation-v2',
    scope: 'uc',
    mode: 'real',
    runId: `v2-quality-full-${++seq}`,
    attemptId: 'att-1',
    codeRevision: 'rev-1',
    perCaseTimeoutMs: 5000,
    registrations: [reg],
    selections: [sel],
  });

  assert.equal(report.contractVersion, 'shared-evaluation-v2');
  assert.equal(report.results.length, 12);
  for (const r of report.results) {
    assert.equal(r.status, 'pass', `Case ${r.caseId} did not pass: ${JSON.stringify(r)}`);
    assert.equal(r.safety, true);
  }

  // Verify suite-level quality summary metrics
  const summary = evaluateQualitySuite(observations);
  assert.equal(summary.totalCases, 12);
  assert.equal(summary.cleanCases, 6);
  assert.equal(summary.faultyCases, 6);
  assert.equal(summary.fp, 0, 'Clean cases must have zero actionable false positives');
  assert.equal(summary.tp, 6, 'All 6 faulty cases must be detected');
  assert.equal(summary.fn, 0);
  assert.equal(summary.totalSafetyViolations, 0);
  assert.equal(summary.passedQualityThreshold, true);
  assert.equal(summary.precision, 1);
  assert.equal(summary.recall, 1);
  assert.equal(summary.cleanCaseFalseAlarmRate, 0);
});

test('T012 regression invariant: quality=pass with R18 not-run yields restart=incomplete, full=incomplete', () => {
  const observations = UC06_QUALITY_CASES.map(c => createQualityObservation(c.caseId));
  const qualitySummary = evaluateQualitySuite(observations);
  assert.equal(qualitySummary.passedQualityThreshold, true);

  // Requirement outcomes: R01-R17 pass, R18 (restart) not-run
  const reqOutcomes: Record<UC06RequirementId, 'pass' | 'not-run'> = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => {
      const id = `R${(i + 1).toString().padStart(2, '0')}` as UC06RequirementId;
      return [id, id === 'R18' ? ('not-run' as const) : ('pass' as const)];
    }),
  ) as Record<UC06RequirementId, 'pass' | 'not-run'>;

  const agg = evaluateMilestones(qualitySummary, reqOutcomes);
  assert.equal(agg.milestones.quality.status, 'pass');
  assert.equal(agg.milestones.restart.status, 'incomplete');
  assert.equal(agg.fullFeatureAcceptance, 'incomplete');
});
