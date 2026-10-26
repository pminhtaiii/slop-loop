import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  isCanonicalRelativePath,
  isProtectedPath,
  validateBaselineAdmission,
  validateBugTask,
} from '../contracts/foundation/uc03.ts';
import type { Baseline, TaskState } from '../contracts/foundation/uc03.ts';
import type { BaselineEvidenceCandidate } from './investigation-types.ts';

export function validateBaselineEvidenceCandidate(
  input: unknown,
  state: TaskState
):
  | { readonly ok: true; readonly candidate: BaselineEvidenceCandidate; readonly baseline: Baseline }
  | { readonly ok: false; readonly reason: string } {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'Baseline evidence candidate must be an object' };
    }
    const candidateKeys = [
      'taskId',
      'workspaceId',
      'repositoryId',
      'acceptanceCriteria',
      'criteriaDigest',
      'requiredChecks',
      'expectedPassingCheckIds',
      'reproductionCheckId',
      'expectedTestFiles',
      'repositorySnapshotDigest',
      'checkSetDigest',
      'reproductionFailureSignature',
      'checkResults',
      'testProtectionDigest',
    ].sort();
    const actualKeys = Reflect.ownKeys(input).map(String).sort();
    if (
      actualKeys.length !== candidateKeys.length ||
      actualKeys.some((key, index) => key !== candidateKeys[index])
    ) {
      return { ok: false, reason: 'Baseline evidence candidate fields are incomplete or unexpected' };
    }

    const candidate = structuredClone(input) as BaselineEvidenceCandidate;
    const taskResult = validateBugTask(state.taskContext);
    if (!taskResult.ok) {
      return { ok: false, reason: 'Task context is required to validate baseline evidence' };
    }
    const task = taskResult.value;
    const requiredChecks = task.requiredChecks;
    const requiredCheckIds = requiredChecks.map((check) => check.checkId);
    const reproductionChecks = requiredChecks.filter((check) => check.purpose === 'reproduction');
    if (reproductionChecks.length !== 1 || !reproductionChecks[0]) {
      return { ok: false, reason: 'Task context must contain exactly one reproduction check' };
    }
    const reproductionCheckId = reproductionChecks[0].checkId;
    const expectedPassingCheckIds = requiredChecks
      .filter((check) => check.checkId !== reproductionCheckId)
      .map((check) => check.checkId);
    const criteriaDigest = computeCanonicalSha256(state.acceptanceCriteria);
    const checkSetDigest = computeCheckSetDigest(requiredChecks);
    const testFiles = candidate.expectedTestFiles;
    const expectedPathSet = new Set<string>();

    if (
      candidate.taskId !== state.taskId ||
      candidate.workspaceId !== state.workspaceId ||
      candidate.repositoryId !== state.repositoryId ||
      candidate.repositoryId !== task.repositoryId ||
      candidate.repositorySnapshotDigest !== state.repositoryRevisionDigest ||
      candidate.repositorySnapshotDigest !== task.initialRevisionDigest ||
      computeCanonicalSha256(candidate.acceptanceCriteria) !== criteriaDigest ||
      criteriaDigest !== computeCanonicalSha256(task.acceptanceCriteria) ||
      candidate.criteriaDigest !== criteriaDigest ||
      computeCheckSetDigest(candidate.requiredChecks) !== checkSetDigest ||
      candidate.checkSetDigest !== checkSetDigest ||
      computeCanonicalSha256(state.requiredCheckIds) !== computeCanonicalSha256(requiredCheckIds) ||
      candidate.reproductionCheckId !== reproductionCheckId ||
      computeCanonicalSha256(candidate.expectedPassingCheckIds) !==
        computeCanonicalSha256(expectedPassingCheckIds)
    ) {
      return { ok: false, reason: 'Baseline candidate does not match accepted task, criteria, check set, or revision facts' };
    }

    if (
      !Array.isArray(testFiles) ||
      testFiles.length === 0 ||
      testFiles.some((filePath) =>
        typeof filePath !== 'string' || !isCanonicalRelativePath(filePath) || isProtectedPath(filePath)
      )
    ) {
      return { ok: false, reason: 'Baseline candidate has an invalid protected test inventory' };
    }
    for (const filePath of testFiles) {
      const key = filePath.toLowerCase();
      if (expectedPathSet.has(key)) {
        return { ok: false, reason: 'Baseline candidate has a duplicate protected test path' };
      }
      expectedPathSet.add(key);
    }

    if (
      !Array.isArray(candidate.checkResults) ||
      candidate.checkResults.length !== requiredCheckIds.length ||
      candidate.checkResults.some((result, index) => result.checkId !== requiredCheckIds[index])
    ) {
      return { ok: false, reason: 'Baseline results do not match the exact required check set' };
    }

    const provisionalBaseline: Baseline = {
      evidenceId: 'pending-baseline-evidence',
      repositorySnapshotDigest: candidate.repositorySnapshotDigest,
      checkSetDigest: candidate.checkSetDigest,
      reproductionFailureSignature: candidate.reproductionFailureSignature,
      checkResults: candidate.checkResults,
      testProtectionDigest: candidate.testProtectionDigest,
    };
    const admission = validateBaselineAdmission(provisionalBaseline, {
      expectedEvidenceId: 'pending-baseline-evidence',
      expectedRepositorySnapshotDigest: state.repositoryRevisionDigest,
      expectedCheckSetDigest: checkSetDigest,
      expectedTestProtectionDigest: candidate.testProtectionDigest,
      expectedReproductionCheckId: reproductionCheckId,
      expectedPassingCheckIds,
    });
    if (!admission.ok) {
      return {
        ok: false,
        reason: `Baseline admission failed: ${admission.errors.map((error) => error.message).join(', ')}`,
      };
    }

    return {
      ok: true,
      candidate: {
        taskId: state.taskId,
        workspaceId: state.workspaceId,
        repositoryId: state.repositoryId,
        acceptanceCriteria: [...state.acceptanceCriteria],
        criteriaDigest,
        requiredChecks: structuredClone(requiredChecks),
        expectedPassingCheckIds,
        reproductionCheckId,
        expectedTestFiles: [...testFiles],
        repositorySnapshotDigest: state.repositoryRevisionDigest,
        checkSetDigest,
        reproductionFailureSignature: admission.value.reproductionFailureSignature,
        checkResults: structuredClone(admission.value.checkResults),
        testProtectionDigest: admission.value.testProtectionDigest,
      },
      baseline: admission.value,
    };
  } catch {
    return { ok: false, reason: 'Baseline evidence candidate validation failed safely' };
  }
}

/**
 * Prepares fix plan, transitions and checkpoints state via StatePort,
 * and requests human plan approval via ApprovalPort.
 *
 * Ensures no production edits are performed prior to approval.
 * Transitions to AwaitPlan and pauses on pending approval; transitions
 * to AwaitFeedback on rejection with zero production modifications.
 */
