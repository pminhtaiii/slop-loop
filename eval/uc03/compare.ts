/**
 * UC-03 workflow (uc03-workflow-evaluation/1) comparison.
 *
 * The legacy tagged-report comparison and its CLI live in `compare-legacy.ts`; they are
 * re-exported here so existing imports and the documented `node dist/eval/uc03/compare.js`
 * entry keep working.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkflowEvaluationReport } from './validation.ts';
import { EVALUATION_CASE_IDS, WORKFLOW_EVALUATION_VERSION } from './types.ts';
import type { EvaluationCaseId, WorkflowEvaluationReport, WorkflowGrade, WorkflowSuiteAcceptance } from './types.ts';
import { main } from './compare-legacy.ts';

export * from './compare-legacy.ts';

/* Workflow (uc03-workflow-evaluation/1) comparison - additive, tagged. */

/** Guard false when the reports differ on it; every failed guard refuses the comparison. */
export type WorkflowComparisonGuard =
  'suite' | 'contractVersion' | 'mode' | 'selected' | 'manifestDigest' | 'caseCardinality' | 'repositoryId' | 'graderDigest' | 'initialRepositoryDigest' | 'expectedOutcome' | 'strictSameConfig';

export type WorkflowComparisonFactor = 'profileDigest' | 'configDigest' | 'pricingDigest' | 'adapterVersions' | 'requestedModel' | 'returnedModel';

export interface WorkflowComparisonCase {
  readonly caseId: EvaluationCaseId;
  readonly baselineGrade: WorkflowGrade | 'missing';
  readonly candidateGrade: WorkflowGrade | 'missing';
  readonly transition: 'stable' | 'improved' | 'regressed' | 'added' | 'removed';
}

export interface WorkflowComparisonSummary {
  readonly totalCommon: number;
  readonly totalAdded: number;
  readonly totalRemoved: number;
  readonly stableCount: number;
  readonly improvementsCount: number;
  readonly regressionsCount: number;
  readonly unknownUsageCases: number;
  readonly observedUsageCases: number;
}

export interface WorkflowComparisonReport {
  readonly suite: 'uc03';
  readonly contractVersion: typeof WORKFLOW_EVALUATION_VERSION;
  readonly baselineConfigDigest: string;
  readonly candidateConfigDigest: string;
  readonly compatible: boolean;
  readonly verdict: 'IDENTICAL' | 'IMPROVED' | 'REGRESSED' | 'INCOMPLETE';
  readonly exitCode: 0 | 1;
  readonly failedGuards: readonly WorkflowComparisonGuard[];
  readonly unverifiedGuards: readonly WorkflowComparisonGuard[];
  readonly changedFactors: readonly WorkflowComparisonFactor[];
  readonly configurationConfounded: boolean;
  readonly cases: readonly WorkflowComparisonCase[];
  readonly summary: WorkflowComparisonSummary;
  readonly selectedCases: readonly EvaluationCaseId[];
  /** Both sides' waits are kept visible; a wait is not a failure. */
  readonly pendingWaits: Readonly<{ baseline: readonly EvaluationCaseId[]; candidate: readonly EvaluationCaseId[] }>;
  /** Cases outside the selection never silently become coverage. */
  readonly notSelectedCases: Readonly<{ baseline: readonly EvaluationCaseId[]; candidate: readonly EvaluationCaseId[] }>;
  /** Workflow reports carry no numeric usage amounts, so both deltas are unknown, never zero. */
  readonly tokensDelta: null;
  readonly costDeltaUsd: null;
  readonly baselineAcceptance: WorkflowSuiteAcceptance;
  readonly candidateAcceptance: WorkflowSuiteAcceptance;
  readonly limitations: readonly string[];
}

export interface WorkflowCompareOptions {
  readonly strictSameConfig?: boolean | undefined;
}

const sameList = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((value, index) => value === right[index]);

const notSelected = (report: WorkflowEvaluationReport): readonly EvaluationCaseId[] => EVALUATION_CASE_IDS.filter(caseId => !report.selectionResult.selected.includes(caseId));

function workflowChangedFactors(baseline: WorkflowEvaluationReport, candidate: WorkflowEvaluationReport): readonly WorkflowComparisonFactor[] {
  const factors = new Set<WorkflowComparisonFactor>();
  if (baseline.configDigest !== candidate.configDigest) factors.add('configDigest');
  const candidateById = new Map(candidate.cases.map(item => [item.caseId, item]));
  for (const baseCase of baseline.cases) {
    const candCase = candidateById.get(baseCase.caseId);
    if (!candCase) continue;
    if (baseCase.profileDigest !== candCase.profileDigest) factors.add('profileDigest');
    if (baseCase.configDigest !== candCase.configDigest) factors.add('configDigest');
    if (baseCase.pricingDigest !== candCase.pricingDigest) factors.add('pricingDigest');
    if (!sameList(baseCase.adapterVersions, candCase.adapterVersions)) factors.add('adapterVersions');
    if (baseCase.requestedModel !== candCase.requestedModel) factors.add('requestedModel');
    if (baseCase.returnedModel !== candCase.returnedModel) factors.add('returnedModel');
  }
  return [...factors].sort();
}

function workflowCases(baseline: WorkflowEvaluationReport, candidate: WorkflowEvaluationReport): readonly WorkflowComparisonCase[] {
  const baselineById = new Map(baseline.cases.map(item => [item.caseId, item]));
  const candidateById = new Map(candidate.cases.map(item => [item.caseId, item]));
  const caseIds = [...new Set([...baselineById.keys(), ...candidateById.keys()])].sort();
  return caseIds.map(caseId => {
    const baseCase = baselineById.get(caseId);
    const candCase = candidateById.get(caseId);
    const baselineGrade = baseCase ? baseCase.grade : ('missing' as const);
    const candidateGrade = candCase ? candCase.grade : ('missing' as const);
    let transition: WorkflowComparisonCase['transition'];
    if (baselineGrade === 'missing') transition = 'added';
    else if (candidateGrade === 'missing') transition = 'removed';
    else if (baselineGrade === 'pass' && candidateGrade !== 'pass') transition = 'regressed';
    else if (baselineGrade !== 'pass' && candidateGrade === 'pass') transition = 'improved';
    else transition = 'stable';
    return { caseId, baselineGrade, candidateGrade, transition };
  });
}

/**
 * Guards over facts two reports must share. An identity fact observed on neither side (`null`)
 * is unprovable rather than equal, so it lands in `unverified` and still refuses the pair.
 */
function workflowGuards(
  baseline: WorkflowEvaluationReport,
  candidate: WorkflowEvaluationReport,
): Readonly<{ failed: readonly WorkflowComparisonGuard[]; unverified: readonly WorkflowComparisonGuard[] }> {
  const failed = new Set<WorkflowComparisonGuard>();
  const unverified = new Set<WorkflowComparisonGuard>();
  if (baseline.suite !== candidate.suite) failed.add('suite');
  if (baseline.contractVersion !== candidate.contractVersion) failed.add('contractVersion');
  if (baseline.mode !== candidate.mode) failed.add('mode');
  if (!sameList(baseline.selectionResult.selected, candidate.selectionResult.selected)) failed.add('selected');
  if (baseline.manifestDigest !== candidate.manifestDigest) failed.add('manifestDigest');
  if (baseline.cases.length !== candidate.cases.length) failed.add('caseCardinality');
  const candidateById = new Map(candidate.cases.map(item => [item.caseId, item]));
  for (const baseCase of baseline.cases) {
    const candCase = candidateById.get(baseCase.caseId);
    if (!candCase) continue;
    for (const guard of ['repositoryId', 'graderDigest', 'initialRepositoryDigest'] as const) {
      const baseValue = baseCase[guard];
      const candValue = candCase[guard];
      if (baseValue === null || candValue === null) unverified.add(guard);
      else if (baseValue !== candValue) failed.add(guard);
    }
    if (baseCase.expectedOutcome !== candCase.expectedOutcome) failed.add('expectedOutcome');
  }
  return { failed: [...failed].sort(), unverified: [...unverified].sort() };
}

function workflowVerdict(
  failedGuards: readonly WorkflowComparisonGuard[],
  unverifiedGuards: readonly WorkflowComparisonGuard[],
  cases: readonly WorkflowComparisonCase[],
  candidate: WorkflowEvaluationReport,
): Readonly<{ verdict: WorkflowComparisonReport['verdict']; exitCode: 0 | 1 }> {
  // Any failed or unproven guard refuses a verdict: the pair is not comparable.
  if (failedGuards.length > 0 || unverifiedGuards.length > 0) return { verdict: 'INCOMPLETE', exitCode: 1 };
  if (cases.some(item => item.transition === 'regressed' || item.transition === 'removed')) return { verdict: 'REGRESSED', exitCode: 1 };
  if (candidate.suiteAcceptance.outcome !== 'pass') return { verdict: 'INCOMPLETE', exitCode: 1 };
  if (cases.some(item => item.transition === 'improved' || item.transition === 'added')) return { verdict: 'IMPROVED', exitCode: 0 };
  return { verdict: 'IDENTICAL', exitCode: 0 };
}

/**
 * Compares two tagged workflow reports. Legacy reports are refused (and stay owned by
 * `compareEvaluations`); an invalid report makes the validator throw, never a "compatible" result.
 */
export function compareWorkflowEvaluations(baseline: unknown, candidate: unknown, options: WorkflowCompareOptions = {}): WorkflowComparisonReport {
  const validBaseline = validateWorkflowEvaluationReport(baseline);
  const validCandidate = validateWorkflowEvaluationReport(candidate);

  const { failed: guardFailures, unverified: unverifiedGuards } = workflowGuards(validBaseline, validCandidate);
  const failedGuards = [...guardFailures];
  const changedFactors = workflowChangedFactors(validBaseline, validCandidate);
  const configurationConfounded = changedFactors.length >= 2;
  if (options.strictSameConfig === true && changedFactors.length > 0) failedGuards.push('strictSameConfig');

  const cases = workflowCases(validBaseline, validCandidate);
  const common = cases.filter(item => item.baselineGrade !== 'missing' && item.candidateGrade !== 'missing');
  const unknownUsageCases = validBaseline.cases.filter(item => item.usage !== 'observed').length + validCandidate.cases.filter(item => item.usage !== 'observed').length;
  const observations = [...validBaseline.cases, ...validCandidate.cases];
  const summary: WorkflowComparisonSummary = {
    totalCommon: common.length,
    totalAdded: cases.filter(item => item.transition === 'added').length,
    totalRemoved: cases.filter(item => item.transition === 'removed').length,
    stableCount: cases.filter(item => item.transition === 'stable').length,
    improvementsCount: cases.filter(item => item.transition === 'improved').length,
    regressionsCount: cases.filter(item => item.transition === 'regressed').length,
    unknownUsageCases,
    observedUsageCases: observations.length - unknownUsageCases,
  };
  const { verdict, exitCode } = workflowVerdict(failedGuards, unverifiedGuards, cases, validCandidate);
  const acceptanceComplete = validBaseline.suiteAcceptance.outcome === 'pass' && validCandidate.suiteAcceptance.outcome === 'pass';

  return {
    suite: 'uc03',
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    baselineConfigDigest: validBaseline.configDigest,
    candidateConfigDigest: validCandidate.configDigest,
    compatible: failedGuards.length === 0 && unverifiedGuards.length === 0,
    verdict,
    exitCode,
    failedGuards,
    unverifiedGuards,
    changedFactors,
    configurationConfounded,
    cases,
    summary,
    selectedCases: validCandidate.selectionResult.selected,
    pendingWaits: { baseline: validBaseline.selectionResult.pendingWaits, candidate: validCandidate.selectionResult.pendingWaits },
    notSelectedCases: { baseline: notSelected(validBaseline), candidate: notSelected(validCandidate) },
    tokensDelta: null,
    costDeltaUsd: null,
    baselineAcceptance: validBaseline.suiteAcceptance,
    candidateAcceptance: validCandidate.suiteAcceptance,
    limitations: [
      'Two attempts are observations; this comparison supports no causal or statistical quality claim.',
      'A selected-case pass does not make the full suite pass; suite acceptance is mirrored from each report and never inferred.',
      ...(unverifiedGuards.length > 0 ? [`Guards not provable from the reports are reported unverified and refuse the pair: ${unverifiedGuards.join(', ')}.`] : []),
      ...(failedGuards.length > 0 ? [`Comparison refused: incompatible reports failed guards ${failedGuards.join(', ')}.`] : []),
      ...(configurationConfounded ? ['Multiple configuration factors changed; outcome differences are configuration-confounded.'] : []),
      ...(acceptanceComplete ? [] : ['At least one report does not certify complete suite acceptance, so complete acceptance cannot be presented.']),
      ...(unknownUsageCases > 0 ? [`Usage is unknown for ${unknownUsageCases} case observation(s); cost and token deltas are null, never zero.`] : []),
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
