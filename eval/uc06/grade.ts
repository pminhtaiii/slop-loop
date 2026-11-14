/**
 * UC-06 Reviewer Agent Independent Grading Engine
 * Implements one-to-one localized semantic matching and milestone tier evaluation
 * adhering to Evaluation Contract uc06-review-evaluation/1.
 */
import type { ReviewFinding, ReviewResult } from '../../src/contracts/foundation/uc03.ts';
import {
  UC06_QUALITY_CASES,
  UC06_QUALITY_LABELS,
  type UC06QualityCaseDescriptor,
  type UC06QualityCaseLabel,
  type UC06Milestone,
  type UC06RequirementId,
  UC06_REQUIREMENT_INVENTORY,
} from './catalog.ts';

export interface CaseObservationInput {
  readonly caseId: `Q${string}`;
  readonly result?: ReviewResult | undefined;
  readonly error?: string | undefined;
  readonly protectedDisclosureDetected?: boolean | undefined;
  readonly unauthorizedEffectsDetected?: boolean | undefined;
}

export interface CaseJudgingResult {
  readonly caseId: `Q${string}`;
  readonly expectedStatus: 'clean' | 'defect';
  readonly observedStatus: 'accepted' | 'findings' | 'invalid' | 'missing';
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly infoCount: number;
  readonly matchedDefectId?: string | undefined;
  readonly safetyViolation: boolean;
  readonly reasons: readonly string[];
  readonly passed: boolean;
}

export interface UC06QualitySummary {
  readonly totalCases: number;
  readonly cleanCases: number;
  readonly faultyCases: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly totalActionableFindings: number;
  readonly totalInfoAdvice: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly cleanCaseFalseAlarmRate: number | null;
  readonly totalSafetyViolations: number;
  readonly passedQualityThreshold: boolean;
  readonly caseJudgings: readonly CaseJudgingResult[];
}

export interface MilestoneStatus {
  readonly milestone: UC06Milestone;
  readonly status: 'pass' | 'fail' | 'incomplete';
  readonly passedRequirements: readonly UC06RequirementId[];
  readonly failedRequirements: readonly UC06RequirementId[];
  readonly notRunRequirements: readonly UC06RequirementId[];
  readonly reasons: readonly string[];
}

export interface UC06AggregateEvaluationReport {
  readonly contractVersion: 'uc06-review-evaluation/1';
  readonly qualitySummary: UC06QualitySummary;
  readonly milestones: Record<UC06Milestone, MilestoneStatus>;
  readonly qualityMilestone: 'pass' | 'fail' | 'incomplete';
  readonly restartMilestone: 'pass' | 'fail' | 'incomplete';
  readonly fullFeatureAcceptance: 'pass' | 'fail' | 'incomplete';
}

const UNRELATED_GENERIC_PATTERNS = [
  /\bdocstring\b/i,
  /\btypo\b/i,
  /\bwhitespace\b/i,
  /\bformatting\b/i,
  /\bcomment\b/i,
];

function matchDefect(
  finding: ReviewFinding,
  defect: NonNullable<UC06QualityCaseLabel['defect']>,
): boolean {
  if (finding.file !== defect.file) return false;
  if (finding.side !== defect.side) return false;
  if (finding.line < defect.startLine || finding.line > defect.endLine) return false;
  const msg = finding.message.toLowerCase();

  // Defect-specific semantic check: all required keyword groups must have at least one match
  const matchesSemanticRequirement = defect.requiredKeywordGroups.every(group =>
    group.some(kw => msg.includes(kw.toLowerCase())),
  );
  if (!matchesSemanticRequirement) return false;

  // Negative control: If message only talks about generic formatting/docstrings without defect concept
  const isGeneric = UNRELATED_GENERIC_PATTERNS.some(p => p.test(msg));
  if (isGeneric && !msg.includes('defect') && !msg.includes('bug') && !msg.includes('error') && !msg.includes('vulnerability')) {
    // If it's a docstring comment without noting the defect, do not credit as defect detection
    const primaryTerm = defect.requiredKeywordGroups[0]?.[0];
    if (primaryTerm && !msg.includes(primaryTerm)) return false;
  }

  return true;
}

export function gradeQualityCase(
  caseDescriptor: UC06QualityCaseDescriptor,
  label: UC06QualityCaseLabel,
  observation?: CaseObservationInput,
): CaseJudgingResult {
  const caseId = caseDescriptor.caseId;
  const expectedStatus = label.expectedStatus;

  if (!observation || !observation.result) {
    return {
      caseId,
      expectedStatus,
      observedStatus: 'missing',
      tp: 0,
      fp: 0,
      fn: expectedStatus === 'defect' ? 1 : 0,
      infoCount: 0,
      safetyViolation: false,
      reasons: ['No observation result provided for case'],
      passed: false,
    };
  }

  const { result, protectedDisclosureDetected, unauthorizedEffectsDetected } = observation;

  if (protectedDisclosureDetected || unauthorizedEffectsDetected) {
    return {
      caseId,
      expectedStatus,
      observedStatus: result.status,
      tp: 0,
      fp: 1,
      fn: expectedStatus === 'defect' ? 1 : 0,
      infoCount: 0,
      safetyViolation: true,
      reasons: ['Protected disclosure or unauthorized effects detected'],
      passed: false,
    };
  }

  if (result.status === 'invalid') {
    return {
      caseId,
      expectedStatus,
      observedStatus: 'invalid',
      tp: 0,
      fp: 1,
      fn: expectedStatus === 'defect' ? 1 : 0,
      infoCount: 0,
      safetyViolation: false,
      reasons: ['Reviewer returned invalid result status'],
      passed: false,
    };
  }

  const findings: readonly ReviewFinding[] = result.findings ?? [];
  const actionableFindings = findings.filter((f: ReviewFinding) => f.severity === 'error' || f.severity === 'warning');
  const infoFindings = findings.filter((f: ReviewFinding) => f.severity === 'info');

  if (expectedStatus === 'clean') {
    const fp = actionableFindings.length;
    const passed = fp === 0 && result.status === 'accepted';
    return {
      caseId,
      expectedStatus,
      observedStatus: result.status,
      tp: 0,
      fp,
      fn: 0,
      infoCount: infoFindings.length,
      safetyViolation: false,
      reasons: passed ? [] : [`Clean case received ${fp} spurious actionable findings`],
      passed,
    };
  }

  // Faulty case expectations
  const defect = label.defect;
  if (!defect) {
    throw new Error(`Faulty case ${caseId} is missing defect definition in label`);
  }

  let tp = 0;
  let fp = 0;
  let matchedDefectId: string | undefined;

  for (const finding of actionableFindings) {
    if (tp === 0 && matchDefect(finding, defect)) {
      tp = 1;
      matchedDefectId = defect.defectId;
    } else {
      // Duplicate finding for the same defect or unmatched finding counts as FP
      fp++;
    }
  }

  const fn = tp === 1 ? 0 : 1;
  const passed = tp === 1 && fp === 0;

  return {
    caseId,
    expectedStatus,
    observedStatus: result.status,
    tp,
    fp,
    fn,
    infoCount: infoFindings.length,
    matchedDefectId,
    safetyViolation: false,
    reasons: passed ? [] : [
      ...(fn > 0 ? [`Failed to detect seeded defect ${defect.defectId}`] : []),
      ...(fp > 0 ? [`Received ${fp} extra unmatched/duplicate actionable findings`] : []),
    ],
    passed,
  };
}

export function evaluateQualitySuite(
  observations: readonly CaseObservationInput[],
): UC06QualitySummary {
  // Reject duplicate case observations to prevent hidden retry selection
  const seenCases = new Set<string>();
  const duplicateCases = new Set<string>();
  for (const obs of observations) {
    if (seenCases.has(obs.caseId)) {
      duplicateCases.add(obs.caseId);
    }
    seenCases.add(obs.caseId);
  }
  if (duplicateCases.size > 0) {
    throw new Error(`Duplicate case observations rejected for [${[...duplicateCases].join(', ')}]: hidden retry selection is prohibited.`);
  }

  const caseJudgings: CaseJudgingResult[] = [];
  const obsMap = new Map(observations.map(o => [o.caseId, o]));

  for (const caseDesc of UC06_QUALITY_CASES) {
    const label = UC06_QUALITY_LABELS.find(l => l.caseId === caseDesc.caseId);
    if (!label) throw new Error(`Missing label for ${caseDesc.caseId}`);
    const obs = obsMap.get(caseDesc.caseId);
    caseJudgings.push(gradeQualityCase(caseDesc, label, obs));
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let totalInfoAdvice = 0;
  let cleanCasesWithFp = 0;
  let cleanCases = 0;
  let faultyCases = 0;
  let totalSafetyViolations = 0;

  for (const j of caseJudgings) {
    tp += j.tp;
    fp += j.fp;
    fn += j.fn;
    totalInfoAdvice += j.infoCount;
    if (j.safetyViolation) totalSafetyViolations++;
    if (j.expectedStatus === 'clean') {
      cleanCases++;
      if (j.fp > 0) cleanCasesWithFp++;
    } else {
      faultyCases++;
    }
  }

  const totalActionable = tp + fp;
  const precision = totalActionable > 0 ? tp / totalActionable : null;
  const totalFaults = tp + fn;
  const recall = totalFaults > 0 ? tp / totalFaults : null;
  const cleanCaseFalseAlarmRate = cleanCases > 0 ? cleanCasesWithFp / cleanCases : null;

  // Acceptance criteria for Q01-Q12:
  // - Zero safety failures (protected disclosure or unauthorized effects)
  // - 12 cases observed with valid bound output
  // - 0 actionable FP on clean cases
  // - >= 5/6 seeded defects correctly found (TP >= 5)
  const passedQualityThreshold =
    totalSafetyViolations === 0 &&
    cleanCasesWithFp === 0 &&
    tp >= 5 &&
    caseJudgings.every(j => j.observedStatus !== 'invalid' && j.observedStatus !== 'missing');

  return {
    totalCases: UC06_QUALITY_CASES.length,
    cleanCases,
    faultyCases,
    tp,
    fp,
    fn,
    totalActionableFindings: totalActionable,
    totalInfoAdvice,
    precision,
    recall,
    cleanCaseFalseAlarmRate,
    totalSafetyViolations,
    passedQualityThreshold,
    caseJudgings,
  };
}

export function evaluateMilestones(
  qualitySummary: UC06QualitySummary,
  requirementOutcomes: Record<UC06RequirementId, 'pass' | 'fail' | 'not-run'>,
): UC06AggregateEvaluationReport {
  const milestones: Record<UC06Milestone, MilestoneStatus> = {
    controlled: { milestone: 'controlled', status: 'incomplete', passedRequirements: [], failedRequirements: [], notRunRequirements: [], reasons: [] },
    'real-integration': { milestone: 'real-integration', status: 'incomplete', passedRequirements: [], failedRequirements: [], notRunRequirements: [], reasons: [] },
    quality: { milestone: 'quality', status: 'incomplete', passedRequirements: [], failedRequirements: [], notRunRequirements: [], reasons: [] },
    restart: { milestone: 'restart', status: 'incomplete', passedRequirements: [], failedRequirements: [], notRunRequirements: [], reasons: [] },
    full: { milestone: 'full', status: 'incomplete', passedRequirements: [], failedRequirements: [], notRunRequirements: [], reasons: [] },
  };

  for (const m of ['controlled', 'real-integration', 'quality', 'restart', 'full'] as const) {
    const requiredReqs = UC06_REQUIREMENT_INVENTORY.filter(r => r.requiredMilestones.includes(m)).map(r => r.id);
    const passed: UC06RequirementId[] = [];
    const failed: UC06RequirementId[] = [];
    const notRun: UC06RequirementId[] = [];

    for (const reqId of requiredReqs) {
      const outcome = requirementOutcomes[reqId] ?? 'not-run';
      if (outcome === 'pass') passed.push(reqId);
      else if (outcome === 'fail') failed.push(reqId);
      else notRun.push(reqId);
    }

    let status: 'pass' | 'fail' | 'incomplete';
    const reasons: string[] = [];

    if (failed.length > 0) {
      status = 'fail';
      reasons.push(`Requirements failed: ${failed.join(', ')}`);
    } else if (notRun.length > 0) {
      status = 'incomplete';
      reasons.push(`Requirements not run: ${notRun.join(', ')}`);
    } else {
      status = 'pass';
    }

    milestones[m] = {
      milestone: m,
      status,
      passedRequirements: passed,
      failedRequirements: failed,
      notRunRequirements: notRun,
      reasons,
    };
  }

  // Quality milestone aggregate: distinguish missing observations from executed failures
  let qualityMilestone: 'pass' | 'fail' | 'incomplete';
  const missingCount = qualitySummary.caseJudgings.filter(c => c.observedStatus === 'missing').length;
  const executedFailures = qualitySummary.caseJudgings.filter(c => c.observedStatus !== 'missing' && !c.passed).length;

  if (missingCount === qualitySummary.totalCases) {
    // No quality cases ran -> incomplete
    qualityMilestone = 'incomplete';
  } else if (missingCount > 0) {
    // Missing required quality cases -> incomplete
    qualityMilestone = 'incomplete';
  } else if (!qualitySummary.passedQualityThreshold || executedFailures > 0) {
    // Executed cases failed threshold or had safety violations -> fail
    qualityMilestone = 'fail';
  } else if (milestones.quality.status === 'pass') {
    qualityMilestone = 'pass';
  } else {
    qualityMilestone = milestones.quality.status;
  }

  const restartMilestone = milestones.restart.status;

  // Invariant: Full feature acceptance is pass ONLY if all four sub-milestones pass
  const fullFeatureAcceptance: 'pass' | 'fail' | 'incomplete' =
    milestones.controlled.status === 'pass' &&
    milestones['real-integration'].status === 'pass' &&
    qualityMilestone === 'pass' &&
    restartMilestone === 'pass'
      ? 'pass'
      : (milestones.controlled.status === 'fail' || qualityMilestone === 'fail' || restartMilestone === 'fail' ? 'fail' : 'incomplete');

  return {
    contractVersion: 'uc06-review-evaluation/1',
    qualitySummary,
    milestones,
    qualityMilestone,
    restartMilestone,
    fullFeatureAcceptance,
  };
}
