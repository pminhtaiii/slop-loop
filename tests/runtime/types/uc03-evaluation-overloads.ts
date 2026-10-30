import {
  runEvaluation,
  SHARED_EVALUATION_VERSION,
  type EvaluationReport,
  type RunEvaluationOptions,
  type SharedEvaluationOptions,
  type SharedEvaluationReport,
} from '../../../eval/uc03/runner.ts';

// Compile-time regression coverage for overload selection and union narrowing.
export function checkEvaluationOverloads(
  legacy: RunEvaluationOptions,
  shared: SharedEvaluationOptions,
  ambiguous: RunEvaluationOptions | SharedEvaluationOptions,
): void {
  const legacyReport: Promise<EvaluationReport> = runEvaluation(legacy);
  const omittedVersion: Promise<EvaluationReport> = runEvaluation({ mode: 'mock' });
  const undefinedVersion: Promise<EvaluationReport> = runEvaluation({ mode: 'mock', contractVersion: undefined });
  const sharedReport: Promise<SharedEvaluationReport> = runEvaluation(shared);
  const ambiguousReport: Promise<EvaluationReport | SharedEvaluationReport> = runEvaluation(ambiguous);

  // @ts-expect-error Shared requests cannot be treated as legacy requests.
  const invalidLegacy: RunEvaluationOptions = shared;
  // @ts-expect-error Union requests require narrowing before assuming a legacy report.
  const invalidLegacyReport: Promise<EvaluationReport> = runEvaluation(ambiguous);
  // @ts-expect-error Union requests require narrowing before assuming a shared report.
  const invalidSharedReport: Promise<SharedEvaluationReport> = runEvaluation(ambiguous);

  if (ambiguous.contractVersion === SHARED_EVALUATION_VERSION) {
    const narrowed: Promise<SharedEvaluationReport> = runEvaluation(ambiguous);
    void narrowed;
  } else {
    const narrowed: Promise<EvaluationReport> = runEvaluation(ambiguous);
    void narrowed;
  }

  void [legacyReport, omittedVersion, undefinedVersion, sharedReport, ambiguousReport,
    invalidLegacy, invalidLegacyReport, invalidSharedReport];
}
