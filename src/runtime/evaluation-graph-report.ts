/** Converts one completed service graph result into its bounded operator report. */

import type { UC03GraphPortsV02 } from '../uc03/graph-types-v02.ts';
import type { TrustedHostExpectedContext } from '../uc03/investigation.ts';
import type { UC03WorkflowResult } from '../uc03/graph-types.ts';
import { runEvaluation } from '../../eval/uc03/runner.ts';
import { WORKFLOW_EVALUATION_VERSION, type WorkflowEvaluationReport } from '../../eval/uc03/types.ts';
import { validateWorkflowEvaluationOptions } from '../../eval/uc03/validation.ts';
import { observeAndGradeWorkflowResult, type WorkflowCaseHost } from '../../eval/uc03/workflow-driver.ts';

export interface EvaluationGraphReportBinding {
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly adapterVersions: readonly string[];
  readonly requestedModel: string;
  readonly timestamp?: string | undefined;
  readonly workflowEvidence?: WorkflowCaseHost['workflowEvidence'] | undefined;
}

/** Validates trusted host report metadata before the service can allocate or run a task. */
export function validateEvaluationGraphReportBinding(
  caseId: string,
  identity: Readonly<Record<string, string>>,
  binding: EvaluationGraphReportBinding,
): EvaluationGraphReportBinding {
  if (
    binding.profileDigest !== identity.profileDigest ||
    binding.configDigest !== identity.configDigest ||
    binding.pricingDigest !== identity.pricingDigest
  ) throw new Error('Workflow report identity does not match the validated host route');
  const checked = validateWorkflowEvaluationOptions({
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode: 'mock',
    cases: [caseId],
    profileDigest: binding.profileDigest,
    configDigest: binding.configDigest,
    pricingDigest: binding.pricingDigest,
    adapterVersions: binding.adapterVersions,
    requestedModel: binding.requestedModel,
    ...(binding.timestamp === undefined ? {} : { timestamp: binding.timestamp }),
    driver: { executeCase: () => undefined },
  });
  return Object.freeze({
    profileDigest: checked.profileDigest,
    configDigest: checked.configDigest,
    pricingDigest: checked.pricingDigest,
    adapterVersions: Object.freeze([...checked.adapterVersions]),
    requestedModel: checked.requestedModel,
    ...(checked.timestamp === undefined ? {} : { timestamp: checked.timestamp }),
    ...(binding.workflowEvidence === undefined ? {} : { workflowEvidence: binding.workflowEvidence }),
  });
}

/**
 * Reuses the exact graph result for observation, private grading, and report assembly. The driver
 * passed to `runEvaluation` returns that already-built observation; it never starts another graph.
 */
export async function reportUC03GraphResult(input: {
  readonly host: WorkflowCaseHost;
  readonly result: UC03WorkflowResult;
  readonly ports: UC03GraphPortsV02;
  readonly generation: object;
  readonly trustedExpectedContext: TrustedHostExpectedContext;
  readonly binding: EvaluationGraphReportBinding;
  readonly mode: 'mock';
}): Promise<WorkflowEvaluationReport | undefined> {
  // An approval wait is an unfinished service step, not a failed repair predicate. Leave that
  // lifecycle pending for the runner; a later completed result still enters the independent grader.
  const host = input.result.outcome === 'pending-approval'
    ? { ...input.host, workflowEvidence: undefined }
    : input.host;
  const observation = await observeAndGradeWorkflowResult(
    host,
    input.result,
    input.ports,
    input.binding.requestedModel,
    input.mode,
    input.generation,
    input.trustedExpectedContext,
  );
  const options = {
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode: input.mode,
    cases: [input.host.entry.caseId],
    profileDigest: input.binding.profileDigest,
    configDigest: input.binding.configDigest,
    pricingDigest: input.binding.pricingDigest,
    adapterVersions: input.binding.adapterVersions,
    requestedModel: input.binding.requestedModel,
    ...(input.binding.timestamp === undefined ? {} : { timestamp: input.binding.timestamp }),
    driver: { executeCase: () => observation },
  } as const;
  const report = await runEvaluation(options);
  return 'selectionResult' in report ? report : undefined;
}
