/**
 * Active-process retention for an investigation paused on reporter clarification.
 * The key is the exact run-scoped generation capability, so a new process or substituted route
 * cannot reuse the candidate. Reuse is read-only and revalidates owner state and protected tests.
 */
import { computeCanonicalSha256, computeCheckSetDigest, validateTaskState, type BugTask, type CheckDefinition, type StatePort, type TaskState } from '../contracts/foundation/uc03.ts';
import { validateHostSnapshotFacts, type BaselineEvidenceCandidate, type TrustedHostExpectedContext, type TrustedHostPort } from './investigation.ts';
import { resolveExpectedTestFiles, samePersistedTransition, taskStateMatchesTask } from './graph-validation.ts';

interface RetainedBaseline {
  readonly bindingDigest: string;
  readonly candidateDigest: string;
  readonly candidate: BaselineEvidenceCandidate;
}

export type RetainedBaselineResult = Readonly<{ ok: true; baseline: BaselineEvidenceCandidate }> | Readonly<{ ok: false; reason: string }>;

const retained = new WeakMap<object, RetainedBaseline>();
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function detachedCandidate(candidate: BaselineEvidenceCandidate): BaselineEvidenceCandidate {
  return Object.freeze({
    ...candidate,
    acceptanceCriteria: Object.freeze([...candidate.acceptanceCriteria]),
    requiredChecks: Object.freeze(candidate.requiredChecks.map((check: CheckDefinition) => Object.freeze({ ...check, argv: Object.freeze([...check.argv]) }))),
    expectedPassingCheckIds: Object.freeze([...candidate.expectedPassingCheckIds]),
    expectedTestFiles: Object.freeze([...candidate.expectedTestFiles]),
    checkResults: Object.freeze(candidate.checkResults.map(result => Object.freeze({ ...result }))),
  });
}

function expectedBinding(
  task: BugTask,
  state: TaskState,
):
  | Readonly<{
      readonly taskId: string;
      readonly runId: string;
      readonly workspaceId: string;
      readonly repositoryId: string;
      readonly revisionDigest: string;
      readonly criteriaDigest: string;
      readonly checkSetDigest: string;
      readonly expectedTestFiles: readonly string[];
      readonly reproductionCheckId: string;
    }>
  | undefined {
  const reproductionChecks = task.requiredChecks.filter(check => check.purpose === 'reproduction');
  if (reproductionChecks.length !== 1 || state.taskId !== task.taskId || state.repositoryId !== task.repositoryId || state.repositoryRevisionDigest !== task.initialRevisionDigest) return undefined;
  const reproductionCheck = reproductionChecks[0];
  if (!reproductionCheck) return undefined;
  const expectedTestFiles = resolveExpectedTestFiles(task);
  if (!expectedTestFiles.length) return undefined;
  return Object.freeze({
    taskId: task.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: task.repositoryId,
    revisionDigest: task.initialRevisionDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    expectedTestFiles,
    reproductionCheckId: reproductionCheck.checkId,
  });
}

function candidateMatches(candidate: BaselineEvidenceCandidate, task: BugTask, binding: NonNullable<ReturnType<typeof expectedBinding>>): boolean {
  const expectedPassingCheckIds = task.requiredChecks.filter(check => check.checkId !== binding.reproductionCheckId).map(check => check.checkId);
  return (
    candidate.taskId === binding.taskId &&
    candidate.workspaceId === binding.workspaceId &&
    candidate.repositoryId === binding.repositoryId &&
    candidate.repositorySnapshotDigest === binding.revisionDigest &&
    candidate.criteriaDigest === binding.criteriaDigest &&
    computeCanonicalSha256(candidate.acceptanceCriteria) === binding.criteriaDigest &&
    candidate.checkSetDigest === binding.checkSetDigest &&
    computeCanonicalSha256(candidate.requiredChecks) === computeCanonicalSha256(task.requiredChecks) &&
    candidate.reproductionCheckId === binding.reproductionCheckId &&
    sameList(candidate.expectedPassingCheckIds, expectedPassingCheckIds) &&
    sameList(candidate.expectedTestFiles, binding.expectedTestFiles) &&
    SHA256.test(candidate.testProtectionDigest) &&
    typeof candidate.reproductionFailureSignature === 'string' &&
    candidate.reproductionFailureSignature.length > 0 &&
    candidate.checkResults.length === task.requiredChecks.length &&
    task.requiredChecks.every((check, index) => {
      const result = candidate.checkResults[index];
      return result?.checkId === check.checkId && result.outcome === (check.checkId === binding.reproductionCheckId ? 'fail' : 'pass');
    })
  );
}

/** Retains only a validated candidate for the exact generation object used by this task/run. */
export function retainClarificationBaseline(generation: object | undefined, task: BugTask, state: TaskState, candidate: BaselineEvidenceCandidate): boolean {
  if (!generation) return false;
  const binding = expectedBinding(task, state);
  if (!binding || !candidateMatches(candidate, task, binding)) return false;
  const candidateCopy = detachedCandidate(candidate);
  const bindingDigest = computeCanonicalSha256(binding);
  const candidateDigest = computeCanonicalSha256(candidateCopy);
  const prior = retained.get(generation);
  if (prior) return prior.bindingDigest === bindingDigest && prior.candidateDigest === candidateDigest;
  retained.set(generation, Object.freeze({ bindingDigest, candidateDigest, candidate: candidateCopy }));
  return true;
}

/** Reuses retained evidence only while the exact owner task and protected-test snapshot still match. */
export async function reuseClarificationBaseline(input: {
  readonly generation: object | undefined;
  readonly task: BugTask;
  readonly state: TaskState;
  readonly statePort: Pick<StatePort, 'loadTask'>;
  readonly hostAuthority: TrustedHostPort;
  readonly expectedContext: TrustedHostExpectedContext;
}): Promise<RetainedBaselineResult> {
  const binding = expectedBinding(input.task, input.state);
  const baseline = input.generation ? retained.get(input.generation) : undefined;
  if (!binding || !baseline || baseline.bindingDigest !== computeCanonicalSha256(binding) || !candidateMatches(baseline.candidate, input.task, binding)) {
    return { ok: false, reason: 'CLARIFICATION_BASELINE_UNAVAILABLE: matching in-process baseline evidence was not retained' };
  }
  const expectedContext = input.expectedContext;
  if (
    expectedContext.taskId !== binding.taskId ||
    expectedContext.workspaceId !== binding.workspaceId ||
    expectedContext.repositoryId !== binding.repositoryId ||
    expectedContext.revisionDigest !== binding.revisionDigest ||
    expectedContext.criteriaDigest !== binding.criteriaDigest ||
    expectedContext.checkSetDigest !== binding.checkSetDigest ||
    !sameList(expectedContext.expectedTestFiles, binding.expectedTestFiles)
  )
    return { ok: false, reason: 'CLARIFICATION_BASELINE_STALE: trusted task or check bindings changed' };

  let current: TaskState | null;
  try {
    current = await input.statePort.loadTask(binding.taskId);
  } catch {
    return { ok: false, reason: 'CLARIFICATION_BASELINE_STALE: current owner task state could not be loaded' };
  }
  if (!current || !validateTaskState(current).ok || !taskStateMatchesTask(current, input.task) || !samePersistedTransition(current, input.state)) {
    return { ok: false, reason: 'CLARIFICATION_BASELINE_STALE: current owner task state changed' };
  }

  let snapshot: unknown;
  try {
    snapshot = await input.hostAuthority.loadSnapshot({
      taskId: binding.taskId,
      workspaceId: binding.workspaceId,
      repositoryId: binding.repositoryId,
      expectedRevisionDigest: binding.revisionDigest,
      expectedCriteriaDigest: binding.criteriaDigest,
      expectedCheckSetDigest: binding.checkSetDigest,
      expectedTestFiles: binding.expectedTestFiles,
    });
  } catch {
    return { ok: false, reason: 'CLARIFICATION_BASELINE_STALE: protected-test snapshot could not be reloaded' };
  }
  const snapshotFacts = validateHostSnapshotFacts(
    snapshot,
    {
      taskId: binding.taskId,
      workspaceId: binding.workspaceId,
      repositoryId: binding.repositoryId,
      revisionDigest: binding.revisionDigest,
      criteriaDigest: binding.criteriaDigest,
      checkSetDigest: binding.checkSetDigest,
      expectedTestFiles: binding.expectedTestFiles,
    },
    input.task.requiredChecks,
  );
  if (!snapshotFacts.ok || snapshotFacts.testProtectionDigest !== baseline.candidate.testProtectionDigest) {
    return { ok: false, reason: 'CLARIFICATION_BASELINE_STALE: protected-test snapshot changed' };
  }

  let afterSnapshot: TaskState | null;
  try {
    afterSnapshot = await input.statePort.loadTask(binding.taskId);
  } catch {
    return { ok: false, reason: 'CLARIFICATION_BASELINE_STALE: owner task state could not be rechecked' };
  }
  if (!afterSnapshot || !validateTaskState(afterSnapshot).ok || !samePersistedTransition(afterSnapshot, input.state)) {
    return { ok: false, reason: 'CLARIFICATION_BASELINE_STALE: owner task state changed during snapshot revalidation' };
  }
  return { ok: true, baseline: baseline.candidate };
}
