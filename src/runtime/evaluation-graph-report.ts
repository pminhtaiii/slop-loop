/** Converts one completed service graph result into its bounded operator report. */

import type { BugTask } from '../contracts/foundation/uc03.ts';
import type { StructuredSpawn } from '../foundation/docker-controller.ts';
import { structuredSpawn } from '../foundation/docker-spawn.ts';
import { sha256Text } from '../uc01/contracts.ts';
import type { UC03GraphPortsV02 } from '../uc03/graph-types-v02.ts';
import type { TrustedHostExpectedContext } from '../uc03/investigation.ts';
import type { UC03WorkflowResult } from '../uc03/graph-types.ts';
import { issueRealExecutionAdmission } from '../../eval/shared-admission.ts';
import { runEvaluation } from '../../eval/uc03/runner.ts';
import { EVALUATION_CASE_IDS, WORKFLOW_EVALUATION_VERSION, type EvaluationCaseId, type WorkflowEvaluationReport } from '../../eval/uc03/types.ts';
import { validateWorkflowEvaluationOptions } from '../../eval/uc03/validation.ts';
import { observeAndGradeWorkflowResult, type WorkflowCaseHost } from '../../eval/uc03/workflow-driver.ts';
import type { WorkflowEvidenceHost } from '../../eval/uc03/workflow-evidence.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import { PINS, resolvePinnedGrader, type GraderCapability } from './real-tier-case-grade.ts';
import { createRealTierGraderCapability } from './real-tier-grader.ts';

export interface EvaluationGraphReportBinding {
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly adapterVersions: readonly string[];
  readonly requestedModel: string;
  readonly timestamp?: string | undefined;
  readonly workflowEvidence?: WorkflowCaseHost['workflowEvidence'] | undefined;
}

export interface RealTierReportEvidenceInput {
  readonly assembly: RealTierAssembly;
  readonly caseId: string;
  readonly task?: BugTask | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly spawn?: StructuredSpawn | undefined;
  readonly graderCapability?: GraderCapability | undefined;
}

/** Structural guard for a host-private `WorkflowEvidenceHost` capability. */
export function isWorkflowEvidenceHost(value: unknown): value is WorkflowEvidenceHost {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const grader = candidate['grader'] as Record<string, unknown> | null | undefined;
  const finalTree = candidate['finalTree'] as Record<string, unknown> | null | undefined;
  return (
    typeof grader === 'object' &&
    grader !== null &&
    !Array.isArray(grader) &&
    typeof grader['grade'] === 'function' &&
    typeof finalTree === 'object' &&
    finalTree !== null &&
    !Array.isArray(finalTree) &&
    typeof finalTree['freezeFinalTree'] === 'function' &&
    typeof finalTree['recheckCurrentFinalTree'] === 'function'
  );
}

function safeNotRunEvidenceHost(caseId: string, reason: 'unpinned-criteria' | 'private-grading', limitation: string): WorkflowEvidenceHost {
  const criteriaDigest = `sha256:${sha256Text('not-run')}`;
  const knownCase = (EVALUATION_CASE_IDS as readonly string[]).includes(caseId) ? (caseId as EvaluationCaseId) : null;
  return Object.freeze({
    grader: Object.freeze({
      async grade(requestedCaseId: string) {
        return Object.freeze({
          caseId: requestedCaseId === caseId ? knownCase : null,
          criterionId: null,
          grade: 'not-run' as const,
          reason,
          evidenceIds: Object.freeze([]),
          snapshot: null,
          evidenceDigest: null,
          criteriaDigest,
          limitations: Object.freeze([limitation]),
        });
      },
    }),
    finalTree: Object.freeze({
      freezeFinalTree: () => undefined,
      recheckCurrentFinalTree: () => undefined,
    }),
  });
}

function resolveRealTierEvidenceHost(input: RealTierReportEvidenceInput): WorkflowEvidenceHost {
  if (PINS[input.caseId] === undefined) {
    return safeNotRunEvidenceHost(input.caseId, 'unpinned-criteria', 'No pinned grader exists for this case.');
  }
  const capability = input.graderCapability ?? createRealTierGraderCapability({ spawn: input.spawn ?? structuredSpawn });
  const grader = resolvePinnedGrader(input.assembly, input.caseId, capability);
  if (grader.status !== 'ready') {
    return safeNotRunEvidenceHost(input.caseId, 'private-grading', `Grader prerequisite unavailable (${grader.reasonCode}).`);
  }
  if (!grader.hasCriterion) {
    return safeNotRunEvidenceHost(input.caseId, 'unpinned-criteria', 'Grader criterion is missing for pinned case.');
  }
  if (input.graderCapability === undefined && PINS[input.caseId] === 'repair-success' && !grader.hasValidPayload) {
    return safeNotRunEvidenceHost(input.caseId, 'private-grading', 'Grader payload is missing or invalid for pinned case.');
  }
  if (input.task === undefined || input.repositoryRoot === undefined) {
    return safeNotRunEvidenceHost(input.caseId, 'private-grading', 'Task-bound repository root is unavailable for real grading.');
  }
  return Object.freeze(grader.evidenceHost(input.task, input.repositoryRoot));
}

/**
 * Wraps `resolvePinnedGrader` and `PINS` as a lazy host-private `WorkflowEvidenceHost`.
 * Unpinned cases and grader refusals fail closed to `not-run` without disclosing grader paths or secrets.
 */
export function createRealTierReportEvidenceHost(input: RealTierReportEvidenceInput): WorkflowEvidenceHost {
  let resolved: WorkflowEvidenceHost | undefined;
  const ensure = (): WorkflowEvidenceHost => {
    if (resolved === undefined) resolved = resolveRealTierEvidenceHost(input);
    return resolved;
  };
  const graderObj: WorkflowEvidenceHost['grader'] = {
    grade: (caseId, gradeInput) => ensure().grader.grade(caseId, gradeInput),
  };
  const finalTreeObj: WorkflowEvidenceHost['finalTree'] = {
    freezeFinalTree: binding => ensure().finalTree.freezeFinalTree(binding),
    recheckCurrentFinalTree: (binding, snapshot) => ensure().finalTree.recheckCurrentFinalTree(binding, snapshot),
  };
  return Object.freeze({ grader: Object.freeze(graderObj), finalTree: Object.freeze(finalTreeObj) });
}

/** Validates trusted host report metadata before the service can allocate or run a task. */
export function validateEvaluationGraphReportBinding(
  caseId: string,
  identity: Readonly<Record<string, string>>,
  binding: EvaluationGraphReportBinding,
  mode: 'mock' | 'real' = 'mock',
): EvaluationGraphReportBinding {
  if (binding.profileDigest !== identity.profileDigest || binding.configDigest !== identity.configDigest || binding.pricingDigest !== identity.pricingDigest)
    throw new Error('Workflow report identity does not match the validated host route');
  const checked = validateWorkflowEvaluationOptions({
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode,
    cases: [caseId],
    profileDigest: binding.profileDigest,
    configDigest: binding.configDigest,
    pricingDigest: binding.pricingDigest,
    adapterVersions: binding.adapterVersions,
    requestedModel: binding.requestedModel,
    ...(binding.timestamp === undefined ? {} : { timestamp: binding.timestamp }),
    driver: { executeCase: () => undefined },
  });
  if (binding.workflowEvidence !== undefined && !isWorkflowEvidenceHost(binding.workflowEvidence)) {
    throw new Error('Invalid workflow report evidence binding');
  }
  if (mode === 'real' && binding.workflowEvidence === undefined) {
    throw new Error('Real workflow report route requires host grading evidence');
  }
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
  readonly mode: 'mock' | 'real';
}): Promise<WorkflowEvaluationReport | undefined> {
  if (input.mode === 'real' && input.result.outcome !== 'pending-approval' && !isWorkflowEvidenceHost(input.host.workflowEvidence)) {
    throw new Error('Real workflow report requires host grading evidence');
  }
  // An approval wait is an unfinished service step, not a failed repair predicate. Leave that
  // lifecycle pending for the runner; a later completed result still enters the independent grader.
  const host = input.result.outcome === 'pending-approval' ? { ...input.host, workflowEvidence: undefined } : input.host;
  const observation = await observeAndGradeWorkflowResult(host, input.result, input.ports, input.binding.requestedModel, input.mode, input.generation, input.trustedExpectedContext);
  const realAdmission =
    input.mode === 'real'
      ? issueRealExecutionAdmission({
          profileDigest: input.binding.profileDigest,
          configDigest: input.binding.configDigest,
          pricingDigest: input.binding.pricingDigest,
          adapterVersions: input.binding.adapterVersions,
          caseIds: [input.host.entry.caseId],
          requestedModel: input.binding.requestedModel,
        })
      : undefined;
  const options = {
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode: input.mode,
    cases: [input.host.entry.caseId],
    profileDigest: input.binding.profileDigest,
    configDigest: input.binding.configDigest,
    pricingDigest: input.binding.pricingDigest,
    adapterVersions: input.binding.adapterVersions,
    requestedModel: input.binding.requestedModel,
    ...(realAdmission === undefined ? {} : { realAdmission }),
    ...(input.binding.timestamp === undefined ? {} : { timestamp: input.binding.timestamp }),
    driver: { executeCase: () => observation },
  } as const;
  const report = await runEvaluation(options);
  return 'selectionResult' in report ? report : undefined;
}
