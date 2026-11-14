import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UC06_REQUIREMENT_INVENTORY,
  UC06_QUALITY_CASES,
  UC06_QUALITY_LABELS,
  type UC06RequirementId,
} from '../../../eval/uc06/catalog.ts';
import {
  gradeQualityCase,
  evaluateQualitySuite,
  evaluateMilestones,
  type CaseObservationInput,
} from '../../../eval/uc06/grade.ts';
import type { ReviewResult } from '../../../src/contracts/foundation/uc03.ts';

const REPO_DIGEST = 'sha256:' + 'a'.repeat(64);
const DIFF_DIGEST = 'sha256:' + 'b'.repeat(64);
const CHECKSET_DIGEST = 'sha256:' + 'c'.repeat(64);

function mockReviewResult(status: 'accepted' | 'findings' | 'invalid', findings: ReviewResult['findings'] = []): ReviewResult {
  return {
    reviewId: 'rev-test',
    reviewerRoleConfigId: 'cfg-test',
    repoDigest: REPO_DIGEST,
    diffDigest: DIFF_DIGEST,
    checkSetDigest: CHECKSET_DIGEST,
    iterationReservationRef: 'res-test',
    status,
    findings,
  };
}

// ==============================================================================
// 1. Catalog & Inventory Verification
// ==============================================================================

test('catalog contains exact R01-R20 inventory with required milestone bindings', () => {
  assert.equal(UC06_REQUIREMENT_INVENTORY.length, 20);
  const ids = UC06_REQUIREMENT_INVENTORY.map(r => r.id);
  for (let i = 1; i <= 20; i++) {
    const id = `R${i.toString().padStart(2, '0')}` as UC06RequirementId;
    assert.ok(ids.includes(id), `Missing requirement ${id}`);
  }

  // Verify tiers and families
  const r01 = UC06_REQUIREMENT_INVENTORY.find(r => r.id === 'R01');
  assert.equal(r01?.family, 'correctness');
  assert.ok(r01?.requiredMilestones.includes('controlled'));

  const r11 = UC06_REQUIREMENT_INVENTORY.find(r => r.id === 'R11');
  assert.equal(r11?.family, 'security');
  assert.equal(r11?.tier, 'controlled');

  const r18 = UC06_REQUIREMENT_INVENTORY.find(r => r.id === 'R18');
  assert.equal(r18?.family, 'restart');
  assert.equal(r18?.tier, 'real-restart');
});

test('catalog contains 12 frozen Q01-Q12 quality cases with valid digests and categories', () => {
  assert.equal(UC06_QUALITY_CASES.length, 12);
  assert.equal(UC06_QUALITY_LABELS.length, 12);

  const cleanCases = UC06_QUALITY_CASES.filter(c => c.kind === 'clean');
  const faultyCases = UC06_QUALITY_CASES.filter(c => c.kind === 'faulty');
  assert.equal(cleanCases.length, 6);
  assert.equal(faultyCases.length, 6);

  const logicFaults = faultyCases.filter(c => c.defectCategory === 'logic');
  const securityFaults = faultyCases.filter(c => c.defectCategory === 'security');
  const missingTestFaults = faultyCases.filter(c => c.defectCategory === 'missing-test');
  assert.equal(logicFaults.length, 2);
  assert.equal(securityFaults.length, 2);
  assert.equal(missingTestFaults.length, 2);

  for (const c of UC06_QUALITY_CASES) {
    assert.match(c.diffDigest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(c.diff.length > 0);
  }

  for (const l of UC06_QUALITY_LABELS) {
    assert.match(l.oracleDigest, /^sha256:[0-9a-f]{64}$/);
    if (l.expectedStatus === 'defect') {
      assert.ok(l.defect);
      assert.ok(l.defect.signatureKeywords.length > 0);
    }
  }
});

// ==============================================================================
// 2. Case-Level Grading Logic
// ==============================================================================

test('gradeQualityCase passes clean case with accepted status and 0 actionable findings', () => {
  const caseDesc = UC06_QUALITY_CASES[0];
  assert.ok(caseDesc);
  const label = UC06_QUALITY_LABELS.find(l => l.caseId === caseDesc.caseId);
  assert.ok(label);

  const cleanResult = mockReviewResult('accepted', []);

  const judged = gradeQualityCase(caseDesc, label, { caseId: caseDesc.caseId, result: cleanResult });
  assert.equal(judged.passed, true);
  assert.equal(judged.tp, 0);
  assert.equal(judged.fp, 0);
  assert.equal(judged.fn, 0);
});

test('gradeQualityCase flags spurious actionable finding on clean case as FP', () => {
  const caseDesc = UC06_QUALITY_CASES[0];
  assert.ok(caseDesc);
  const label = UC06_QUALITY_LABELS.find(l => l.caseId === caseDesc.caseId);
  assert.ok(label);

  const falseAlarmResult = mockReviewResult('findings', [
    {
      file: 'src/math_util.py',
      line: 10,
      side: 'new',
      severity: 'warning',
      message: 'Unnecessary whitespace.',
      evidenceRef: 'source',
    },
  ]);

  const judged = gradeQualityCase(caseDesc, label, { caseId: caseDesc.caseId, result: falseAlarmResult });
  assert.equal(judged.passed, false);
  assert.equal(judged.tp, 0);
  assert.equal(judged.fp, 1);
});

test('gradeQualityCase correctly matches seeded defect on faulty case as TP', () => {
  const caseDesc = UC06_QUALITY_CASES.find(c => c.caseId === 'Q07');
  assert.ok(caseDesc);
  const label = UC06_QUALITY_LABELS.find(l => l.caseId === 'Q07');
  assert.ok(label && label.defect);

  const detectedResult = mockReviewResult('findings', [
    {
      file: label.defect.file,
      line: label.defect.startLine,
      side: label.defect.side,
      severity: 'error',
      message: 'Division by zero check is inverted: b < 0 allowing zero denominator.',
      evidenceRef: 'source',
    },
  ]);

  const judged = gradeQualityCase(caseDesc, label, { caseId: 'Q07', result: detectedResult });
  assert.equal(judged.passed, true);
  assert.equal(judged.tp, 1);
  assert.equal(judged.fp, 0);
  assert.equal(judged.fn, 0);
  assert.equal(judged.matchedDefectId, label.defect.defectId);
});

test('gradeQualityCase penalizes duplicate findings for the same defect as FP', () => {
  const caseDesc = UC06_QUALITY_CASES.find(c => c.caseId === 'Q07');
  assert.ok(caseDesc);
  const label = UC06_QUALITY_LABELS.find(l => l.caseId === 'Q07');
  assert.ok(label && label.defect);

  const duplicateResult = mockReviewResult('findings', [
    {
      file: label.defect.file,
      line: label.defect.startLine,
      side: label.defect.side,
      severity: 'error',
      message: 'Division by zero check is inverted.',
      evidenceRef: 'source',
    },
    {
      file: label.defect.file,
      line: label.defect.startLine + 1,
      side: label.defect.side,
      severity: 'warning',
      message: 'Another division zero warning on the same block.',
      evidenceRef: 'source',
    },
  ]);

  const judged = gradeQualityCase(caseDesc, label, { caseId: 'Q07', result: duplicateResult });
  assert.equal(judged.passed, false);
  assert.equal(judged.tp, 1);
  assert.equal(judged.fp, 1);
});

test('gradeQualityCase rejects protected disclosure or unauthorized effects', () => {
  const caseDesc = UC06_QUALITY_CASES[0];
  assert.ok(caseDesc);
  const label = UC06_QUALITY_LABELS[0];
  assert.ok(label);

  const cleanResult = mockReviewResult('accepted', []);

  const judged = gradeQualityCase(caseDesc, label, {
    caseId: caseDesc.caseId,
    result: cleanResult,
    protectedDisclosureDetected: true,
  });
  assert.equal(judged.passed, false);
  assert.equal(judged.fp, 1);
});

// ==============================================================================
// 3. Suite Evaluation & Milestone Aggregation
// ==============================================================================

test('evaluateQualitySuite calculates precision, recall, and clean-case false-alarm rate', () => {
  const observations: CaseObservationInput[] = [];

  // Generate clean cases (all accepted, 0 findings)
  for (let i = 1; i <= 6; i++) {
    const caseId = `Q${i.toString().padStart(2, '0')}` as const;
    observations.push({
      caseId,
      result: mockReviewResult('accepted', []),
    });
  }

  // Generate 5 detected faults (Q07-Q11) and 1 missed fault (Q12)
  for (let i = 7; i <= 11; i++) {
    const caseId = `Q${i.toString().padStart(2, '0')}` as const;
    const label = UC06_QUALITY_LABELS.find(l => l.caseId === caseId);
    assert.ok(label && label.defect);
    observations.push({
      caseId,
      result: mockReviewResult('findings', [
        {
          file: label.defect.file,
          line: label.defect.startLine,
          side: label.defect.side,
          severity: 'error',
          message: `${label.defect.signatureKeywords[0]} detected violation`,
          evidenceRef: 'source',
        },
      ]),
    });
  }

  // Q12 missed
  observations.push({
    caseId: 'Q12',
    result: mockReviewResult('accepted', []),
  });

  const summary = evaluateQualitySuite(observations);
  assert.equal(summary.totalCases, 12);
  assert.equal(summary.cleanCases, 6);
  assert.equal(summary.faultyCases, 6);
  assert.equal(summary.tp, 5);
  assert.equal(summary.fp, 0);
  assert.equal(summary.fn, 1);
  assert.equal(summary.precision, 1.0);
  assert.equal(summary.recall, 5 / 6);
  assert.equal(summary.cleanCaseFalseAlarmRate, 0.0);
  assert.equal(summary.passedQualityThreshold, true, '5/6 detected and 0 clean FP passes threshold');
});

test('evaluateMilestones enforces regression invariant: quality=pass with R18 not-run yields restart=incomplete and full=incomplete', () => {
  const observations: CaseObservationInput[] = [];
  // 6 clean cases pass
  for (let i = 1; i <= 6; i++) {
    const caseId = `Q${i.toString().padStart(2, '0')}` as const;
    observations.push({
      caseId,
      result: mockReviewResult('accepted', []),
    });
  }
  // 6 faulty cases detected
  for (let i = 7; i <= 12; i++) {
    const caseId = `Q${i.toString().padStart(2, '0')}` as const;
    const label = UC06_QUALITY_LABELS.find(l => l.caseId === caseId);
    assert.ok(label && label.defect);
    observations.push({
      caseId,
      result: mockReviewResult('findings', [
        {
          file: label.defect.file,
          line: label.defect.startLine,
          side: label.defect.side,
          severity: 'error',
          message: `${label.defect.signatureKeywords[0]} detected defect`,
          evidenceRef: 'source',
        },
      ]),
    });
  }
  const qualitySummary = evaluateQualitySuite(observations);

  // Requirement status: Controlled safety R01-R17 and R19-R20 pass; R18 is explicitly not-run
  const reqOutcomes: Record<UC06RequirementId, 'pass' | 'fail' | 'not-run'> = {
    R01: 'pass', R02: 'pass', R03: 'pass', R04: 'pass', R05: 'pass',
    R06: 'pass', R07: 'pass', R08: 'pass', R09: 'pass', R10: 'pass',
    R11: 'pass', R12: 'pass', R13: 'pass', R14: 'pass', R15: 'pass',
    R16: 'pass', R17: 'pass', R18: 'not-run', R19: 'pass', R20: 'pass',
  };

  const report = evaluateMilestones(qualitySummary, reqOutcomes);
  assert.equal(report.qualityMilestone, 'pass');
  assert.equal(report.restartMilestone, 'incomplete');
  assert.equal(report.fullFeatureAcceptance, 'incomplete', 'Full acceptance cannot pass while restart is incomplete');
});
