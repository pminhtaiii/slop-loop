/** Execute the shared repair/answered-clarification hidden check under the existing admission boundary. */
import { executeMockPrivateGrading } from './grading.ts';
import { isRealTierGrade, realTierGradeLabel } from './workflow-grade-tier.ts';
import type { SnapshotGraderHost } from './workflow-grade.ts';
import type { EvaluationSnapshotIdentity } from './types.ts';

export async function gradeHiddenSnapshot(
  host: SnapshotGraderHost,
  checkId: string,
  snapshot: EvaluationSnapshotIdentity,
): Promise<Readonly<{ passed: boolean; tierLabel: string | undefined }> | undefined> {
  const hidden = await executeMockPrivateGrading({
    checkId,
    finalSnapshot: snapshot,
    profile: host.profile,
    isolationAuthority: host.isolationAuthority,
    executor: host.executor,
    graderPayload: host.graderPayload,
  });
  if (hidden === undefined || hidden.checkId !== checkId) return undefined;
  return {
    passed: hidden.status === 'pass' && hidden.actualOutcome === 'COMPLETED',
    tierLabel: isRealTierGrade(hidden) && hidden.admissionId ? realTierGradeLabel(hidden.admissionId, host.executor.executorId) : undefined,
  };
}
