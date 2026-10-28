import {
  C17_NOT_RUN_LIMITATION,
  UC03_CONTRACT_VERSION,
  type CaseResult,
  type EvaluationCaseContext,
  type EvaluationManifest,
  type EvaluationMode,
  type EvaluationReport,
  type EvaluationSummary,
} from './types.ts';

export type NotRunReason = 'not-selected' | 'no-driver' | 'real-refused' | 'private-grading' | 'mock-grading-exercised';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function notRunCase(context: EvaluationCaseContext, reason: NotRunReason): CaseResult {
  const privateGrading = context.spec.caseId === 'C17' || reason === 'private-grading';
  const limitations = [
    reason === 'not-selected' ? 'Case was not selected.' : '',
    reason === 'no-driver' ? 'No evaluation case driver is configured.' : '',
    reason === 'real-refused' ? 'Real mode was refused before driver invocation.' : '',
    reason === 'mock-grading-exercised' ? 'Injected mock grading boundary returned a snapshot-bound result; real C17 grading remains not-run.' : '',
    privateGrading ? C17_NOT_RUN_LIMITATION : '',
  ].filter((value) => value.length > 0);
  return {
    caseId: context.spec.caseId,
    useCase: 'UC-03',
    contractVersion: UC03_CONTRACT_VERSION,
    taskId: null,
    runId: null,
    mode: context.mode,
    status: 'not-run',
    expectedOutcome: context.spec.expectedOutcome,
    actualOutcome: context.mode === 'real' ? 'REFUSED_BEFORE_DISPATCH' : 'NOT_RUN',
    timing: { startMs: 0, endMs: 0, durationMs: 0 },
    usage: { tokensConsumed: 0, costUsd: 0 },
    digests: { manifestDigest: context.manifestDigest, configDigest: context.configDigest },
    ...(reason === 'real-refused' ? { denialReason: 'Real mode dispatch was refused.' } : {}),
    sideEffectObserved: false,
    limitations,
  };
}

export function driverErrorCase(
  context: EvaluationCaseContext,
  error: 'driver-threw' | 'invalid-result',
): CaseResult {
  const actualOutcome = error === 'driver-threw' ? 'DRIVER_ERROR' : 'DRIVER_RESULT_INVALID';
  return {
    caseId: context.spec.caseId,
    useCase: 'UC-03',
    contractVersion: UC03_CONTRACT_VERSION,
    taskId: null,
    runId: null,
    mode: context.mode,
    status: 'error',
    expectedOutcome: context.spec.expectedOutcome,
    actualOutcome,
    timing: { startMs: 0, endMs: 0, durationMs: 0 },
    usage: { tokensConsumed: 0, costUsd: 0 },
    digests: { manifestDigest: context.manifestDigest, configDigest: context.configDigest },
    denialReason: error === 'driver-threw' ? 'Evaluation driver failed.' : 'Evaluation driver returned an invalid case result.',
    sideEffectObserved: null,
    limitations: ['Driver timing and usage were unavailable.'],
  };
}

function summaryValue(value: unknown, integer = false, rate = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)) || (rate && value > 1)) {
    throw new Error('Invalid evaluation report');
  }
  return value;
}

export function parseSummary(value: unknown): EvaluationSummary {
  if (!isRecord(value)) throw new Error('Invalid evaluation report');
  return {
    totalCases: summaryValue(value['totalCases'], true),
    passedCases: summaryValue(value['passedCases'], true),
    failedCases: summaryValue(value['failedCases'], true),
    errorCases: summaryValue(value['errorCases'], true),
    notRunCases: summaryValue(value['notRunCases'], true),
    requiredFailuresOrNotRun: summaryValue(value['requiredFailuresOrNotRun'], true),
    successRate: summaryValue(value['successRate'], false, true),
    expectedDenialRate: summaryValue(value['expectedDenialRate'], false, true),
    replanCountsTotal: summaryValue(value['replanCountsTotal'], true),
    repairIterationsTotal: summaryValue(value['repairIterationsTotal'], true),
    reviewIterationsTotal: summaryValue(value['reviewIterationsTotal'], true),
    totalDurationMs: summaryValue(value['totalDurationMs']),
    totalTokensConsumed: summaryValue(value['totalTokensConsumed'], true),
    totalCostUsd: summaryValue(value['totalCostUsd']),
  };
}

export function summarizeCases(cases: readonly CaseResult[], manifest: EvaluationManifest): EvaluationSummary {
  const passedCases = cases.filter((item) => item.status === 'pass').length;
  const failedCases = cases.filter((item) => item.status === 'fail').length;
  const errorCases = cases.filter((item) => item.status === 'error').length;
  const notRunCases = cases.filter((item) => item.status === 'not-run').length;
  const requiredFailuresOrNotRun = failedCases + errorCases + notRunCases;
  const expectedDenials = manifest.cases.filter((item) => item.expectedOutcome === 'FAILED').length;
  const expectedDenialsPassed = cases.filter((item) => item.expectedOutcome === 'FAILED' && item.status === 'pass').length;
  return {
    totalCases: cases.length,
    passedCases,
    failedCases,
    errorCases,
    notRunCases,
    requiredFailuresOrNotRun,
    successRate: cases.length > 0 ? passedCases / cases.length : 0,
    expectedDenialRate: expectedDenials > 0 ? expectedDenialsPassed / expectedDenials : 0,
    replanCountsTotal: cases.reduce((total, item) => total + (item.usage.replanCount ?? 0), 0),
    repairIterationsTotal: cases.reduce((total, item) => total + (item.usage.repairAttempts ?? 0), 0),
    reviewIterationsTotal: cases.reduce((total, item) => total + (item.usage.reviewIterations ?? 0), 0),
    totalDurationMs: cases.reduce((total, item) => total + item.timing.durationMs, 0),
    totalTokensConsumed: cases.reduce((total, item) => total + item.usage.tokensConsumed, 0),
    totalCostUsd: cases.reduce((total, item) => total + item.usage.costUsd, 0),
  };
}

export interface BuildReportInput {
  readonly mode: EvaluationMode;
  readonly manifest: EvaluationManifest;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly timestamp: string;
  readonly cases: readonly CaseResult[];
  readonly hasDriver: boolean;
}

export function createEvaluationReport(input: BuildReportInput): EvaluationReport {
  const summary = summarizeCases(input.cases, input.manifest);
  const verdict = input.mode === 'real'
    ? 'REFUSED'
    : summary.requiredFailuresOrNotRun > 0 ? 'FAIL' : 'PASS';
  const limitations = [
    input.mode === 'real'
      ? 'Real mode dispatch was refused before driver invocation.'
      : input.hasDriver
        ? 'Injected fake-driver results exercise the evaluation harness only; they do not establish UC-03 workflow evidence.'
        : 'No evaluation case driver is configured; required workflow cases remain not-run.',
    C17_NOT_RUN_LIMITATION,
  ];

  return {
    suite: 'uc03',
    contractVersion: UC03_CONTRACT_VERSION,
    mode: input.mode,
    manifestDigest: input.manifestDigest,
    configDigest: input.configDigest,
    timestamp: input.timestamp,
    isRealVerified: false,
    verdict,
    exitCode: verdict === 'PASS' ? 0 : 1,
    summary,
    cases: input.cases,
    limitations,
  };
}
