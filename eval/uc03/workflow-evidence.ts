/** Host-only producer for snapshot-bound workflow grades. */

import { computeCanonicalSha256, type BugTask, type RepositoryPort, type RepositoryPortV02, type StatePortV02 } from '../../src/contracts/foundation/uc03.ts';
import type { BaselineEvidenceCandidate } from '../../src/uc03/investigation.ts';
import { deriveWorkflowEvidenceFacts, parseWorkflowFinalTree, type DerivedWorkflowFacts, type FinalTreeBinding, type TrustedFinalTreeSnapshotPort } from './workflow-evidence-facts.ts';
import { isSnapshotGradeCurrent, type SnapshotGradeResult, type SnapshotGrader } from './workflow-grade.ts';
import { validateWorkflowObservation } from './validation.ts';
import type { EvaluationSnapshotIdentity, WorkflowGrade, WorkflowObservation, WorkflowReason } from './types.ts';
import type { UC03WorkflowResult } from '../../src/uc03/graph-types.ts';

export type { DerivedWorkflowFacts, FinalTreeBinding, TrustedFinalTreeSnapshotPort, WorkflowFinalTreeSnapshot } from './workflow-evidence-facts.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const GRADES = new Set<WorkflowGrade>(['pass', 'fail', 'not-run']);
const REASONS = new Set<WorkflowReason>([
  'criteria-satisfied',
  'expected-wait-satisfied',
  'criteria-violation',
  'unresolved-wait',
  'unpinned-criteria',
  'real-execution-unavailable',
  'driver-unavailable',
  'invalid-observation',
  'not-selected',
  'private-grading',
  'prerequisite-unavailable',
  'busy',
  'reconciliation-required',
]);

export interface WorkflowEvidenceHost {
  readonly grader: SnapshotGrader;
  readonly finalTree: TrustedFinalTreeSnapshotPort;
}

export interface WorkflowGradeDecision {
  readonly grade: WorkflowGrade;
  readonly reason: WorkflowReason;
  readonly evidenceIds: readonly string[];
  readonly limitations: readonly string[];
}

const decisions = new WeakMap<object, Readonly<{ caseId: string; fingerprint: string; decision: WorkflowGradeDecision }>>();

/** The graded inputs, so a mutated or reused observation object cannot inherit the stored verdict. */
function remember(key: object, caseId: string, graded: unknown, decision: WorkflowGradeDecision): void {
  decisions.set(key, Object.freeze({ caseId, fingerprint: computeCanonicalSha256(graded), decision }));
}

function decisionFrom(result: SnapshotGradeResult, caseId: string, snapshot?: EvaluationSnapshotIdentity, evidenceDigest?: string): WorkflowGradeDecision | undefined {
  if (
    result.caseId !== caseId ||
    !GRADES.has(result.grade) ||
    !REASONS.has(result.reason) ||
    !Array.isArray(result.evidenceIds) ||
    result.evidenceIds.length > 32 ||
    !result.evidenceIds.every(item => typeof item === 'string' && ID.test(item)) ||
    !Array.isArray(result.limitations) ||
    result.limitations.length > 16 ||
    !result.limitations.every(item => typeof item === 'string' && Buffer.byteLength(item, 'utf8') <= 512)
  )
    return undefined;
  if (result.snapshot === null) {
    if (result.grade !== 'not-run' || snapshot !== undefined) return undefined;
  } else if (!snapshot || !evidenceDigest || !isSnapshotGradeCurrent(result, snapshot, evidenceDigest)) return undefined;
  return Object.freeze({
    grade: result.grade,
    reason: result.reason,
    evidenceIds: Object.freeze([...result.evidenceIds]),
    limitations: Object.freeze([...result.limitations]),
  });
}

async function notRunDecision(grader: SnapshotGrader, caseId: string, reason: string): Promise<WorkflowGradeDecision> {
  try {
    const result = await grader.grade(caseId, {});
    const decision = decisionFrom(result, caseId);
    if (decision) return Object.freeze({ ...decision, limitations: Object.freeze([...decision.limitations, reason]) });
  } catch {
    /* Translate a host grader failure into a bounded not-run result. */
  }
  return Object.freeze({ grade: 'not-run', reason: 'private-grading', evidenceIds: Object.freeze([]), limitations: Object.freeze([reason]) });
}

/** Grades the exact observation before it crosses the driver boundary and stores only its safe verdict privately. */
export async function produceWorkflowEvidence(input: {
  readonly caseId: string;
  readonly task: BugTask;
  readonly result: UC03WorkflowResult;
  readonly observation: WorkflowObservation;
  readonly repository: Pick<RepositoryPort, 'inspectDiff'> | Pick<RepositoryPortV02, 'inspectDiff'> | undefined;
  readonly statePort?: StatePortV02 | undefined;
  readonly host: WorkflowEvidenceHost;
  readonly retainedBaseline?: BaselineEvidenceCandidate | undefined;
}): Promise<void> {
  const key: unknown = input.observation;
  if (typeof key !== 'object' || key === null) return;
  let observation: WorkflowObservation;
  try {
    observation = validateWorkflowObservation(input.observation);
  } catch {
    // Nothing gradeable to bind: the runner re-validates and reports the observation as invalid.
    decisions.delete(key);
    return;
  }

  let facts: DerivedWorkflowFacts | undefined;
  try {
    facts = await deriveWorkflowEvidenceFacts({
      caseId: input.caseId,
      task: input.task,
      result: input.result,
      observation,
      repository: input.repository,
      statePort: input.statePort,
      finalTree: input.host.finalTree,
      retainedBaseline: input.retainedBaseline,
    });
  } catch {
    remember(key, input.caseId, observation, await notRunDecision(input.host.grader, input.caseId, 'Host evidence could not be validated.'));
    return;
  }
  if (!facts) {
    remember(
      key,
      input.caseId,
      observation,
      await notRunDecision(input.host.grader, input.caseId, 'Required task, snapshot, diff, protected-test, check, review or patch-effect evidence was missing or inconsistent.'),
    );
    return;
  }
  let grade: SnapshotGradeResult;
  try {
    grade = await input.host.grader.grade(input.caseId, { observation, snapshot: facts.snapshot, evidence: facts.evidence });
  } catch {
    remember(key, input.caseId, observation, await notRunDecision(input.host.grader, input.caseId, 'The independent snapshot grader failed.'));
    return;
  }
  const decision = decisionFrom(grade, input.caseId, facts.snapshot, facts.evidence.digest);
  if (!decision) {
    remember(key, input.caseId, observation, await notRunDecision(input.host.grader, input.caseId, 'The snapshot grader returned an invalid or stale receipt.'));
    return;
  }

  let rechecked: unknown;
  try {
    rechecked = await input.host.finalTree.recheckCurrentFinalTree(
      {
        taskId: input.task.taskId,
        runId: observation.runId ?? '',
        workspaceId: input.result.executionEvidence?.finalState?.workspaceId ?? '',
        repositoryId: input.task.repositoryId,
        initialRevisionDigest: input.task.initialRevisionDigest,
        finalRevisionDigest: input.result.executionEvidence?.finalState?.repositoryRevisionDigest ?? '',
      },
      facts.snapshot,
    );
  } catch {
    remember(key, input.caseId, observation, await notRunDecision(input.host.grader, input.caseId, 'The final snapshot could not be stability-checked after grading.'));
    return;
  }
  const binding: FinalTreeBinding = {
    taskId: input.task.taskId,
    runId: observation.runId ?? '',
    workspaceId: input.result.executionEvidence?.finalState?.workspaceId ?? '',
    repositoryId: input.task.repositoryId,
    initialRevisionDigest: input.task.initialRevisionDigest,
    finalRevisionDigest: input.result.executionEvidence?.finalState?.repositoryRevisionDigest ?? '',
  };
  const checkedTree = parseWorkflowFinalTree(rechecked, binding);
  if (!checkedTree || checkedTree.snapshot.snapshotId !== facts.snapshot.snapshotId || checkedTree.snapshot.digest !== facts.snapshot.digest) {
    remember(key, input.caseId, observation, await notRunDecision(input.host.grader, input.caseId, 'The final tree changed while the independent grade was being produced.'));
    return;
  }
  remember(key, input.caseId, observation, decision);
}

/**
 * Object identity plus the exact graded inputs: a copied observation, a case switch or a mutated
 * `workflowOutcome`/`runId` on the same object yields no verdict.
 */
export function workflowEvidenceDecision(caseId: string, observation: unknown): WorkflowGradeDecision | undefined {
  if (typeof observation !== 'object' || observation === null) return undefined;
  const stored = decisions.get(observation);
  return stored !== undefined && stored.caseId === caseId && stored.fingerprint === computeCanonicalSha256(observation) ? stored.decision : undefined;
}
