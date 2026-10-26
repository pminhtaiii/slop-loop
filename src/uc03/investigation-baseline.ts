import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  isCanonicalRelativePath,
  isProtectedPath,
  validateBaselineAdmission,
  validateBugTask,
  validateCheckDefinition,
} from '../contracts/foundation/uc03.ts';
import { isCollectionOrSyntaxError, validateHostSnapshotFacts } from './investigation-snapshot.ts';
import { runBaselineChecks } from './investigation-baseline-checks.ts';
import type { Baseline, BugTask, RepositoryPort, RepositoryPortV02 } from '../contracts/foundation/uc03.ts';
import type {
  BaselineEvidenceCandidate,
  BaselineInvestigationResult,
  TrustedHostExpectedContext,
  TrustedHostPort,
  TrustedHostSnapshotRequest,
} from './investigation-types.ts';

export function investigateBaseline(
  task: BugTask,
  repository: RepositoryPort | RepositoryPortV02
): Promise<BaselineInvestigationResult>;
export function investigateBaseline(
  task: BugTask,
  repository: RepositoryPort | RepositoryPortV02,
  hostAuthority: TrustedHostPort,
  trustedExpectedContext: TrustedHostExpectedContext
): Promise<BaselineInvestigationResult>;
export async function investigateBaseline(
  task: BugTask,
  repository: RepositoryPort | RepositoryPortV02,
  hostAuthority?: TrustedHostPort,
  trustedExpectedContext?: TrustedHostExpectedContext
): Promise<BaselineInvestigationResult> {
  const taskValidation = validateBugTask(task);
  if (!taskValidation.ok) {
    return {
      status: 'error',
      reason: `BugTask validation failed: ${taskValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }
  const validTask = taskValidation.value;

  // Detach every task fact used after a host or test await.
  const taskId = validTask.taskId;
  const repositoryId = validTask.repositoryId;
  const taskRevisionDigest = validTask.initialRevisionDigest;
  const requiredChecks = validTask.requiredChecks.map((check) =>
    Object.freeze({ ...check, argv: Object.freeze([...check.argv]) })
  );
  const checkSetDigest = computeCheckSetDigest(requiredChecks);
  const criteriaDigest = computeCanonicalSha256(validTask.acceptanceCriteria);

  const reproductionChecks = requiredChecks.filter((check) => check.purpose === 'reproduction');
  const reproductionCheck = reproductionChecks[0];

  if (!reproductionCheck) {
    return {
      status: 'error',
      reason: 'No reproduction check found with explicit purpose reproduction in requiredChecks',
    };
  }
  if (reproductionChecks.length !== 1) {
    return {
      status: 'error',
      reason: 'Exactly one check may have explicit purpose reproduction in requiredChecks',
    };
  }

  const checkValidation = validateCheckDefinition(reproductionCheck, 'reproductionCheck', []);
  if (!checkValidation) {
    return {
      status: 'error',
      reason: 'Reproduction check definition failed validation',
    };
  }

  // Trusted host snapshot authority is strictly REQUIRED. Fail closed before ANY test execution.
  const rawExpectedContext: unknown = trustedExpectedContext;
  if (!hostAuthority) {
    return {
      status: 'error',
      reason: 'Missing trusted host authority: explicit TrustedHostPort with loadSnapshot is required',
    };
  }

  if (!rawExpectedContext || typeof rawExpectedContext !== 'object') {
    return {
      status: 'error',
      reason: 'Missing separate trusted admission context for task, workspace, repository, checks, and inventory',
    };
  }

  let contextTaskId: unknown;
  let contextWorkspaceId: unknown;
  let contextRepositoryId: unknown;
  let contextRevisionDigest: unknown;
  let contextCriteriaDigest: unknown;
  let contextCheckSetDigest: unknown;
  let rawContextTestFiles: unknown;
  try {
    const context = rawExpectedContext as Record<string, unknown>;
    const keys = Reflect.ownKeys(context);
    if (
      !keys.includes('taskId') ||
      !keys.includes('workspaceId') ||
      !keys.includes('repositoryId') ||
      !keys.includes('revisionDigest') ||
      !keys.includes('criteriaDigest') ||
      !keys.includes('checkSetDigest') ||
      !keys.includes('expectedTestFiles')
    ) {
      return {
        status: 'error',
        reason: 'Trusted expected context is missing a required binding',
      };
    }
    contextTaskId = context.taskId;
    contextWorkspaceId = context.workspaceId;
    contextRepositoryId = context.repositoryId;
    contextRevisionDigest = context.revisionDigest;
    contextCriteriaDigest = context.criteriaDigest;
    contextCheckSetDigest = context.checkSetDigest;
    rawContextTestFiles = context.expectedTestFiles;
  } catch {
    return {
      status: 'error',
      reason: 'Trusted expected context access failed during extraction',
    };
  }

  if (
    typeof contextTaskId !== 'string' ||
    contextTaskId !== taskId ||
    typeof contextWorkspaceId !== 'string' ||
    contextWorkspaceId.length === 0 ||
    typeof contextRepositoryId !== 'string' ||
    contextRepositoryId !== repositoryId ||
    typeof contextRevisionDigest !== 'string' ||
    contextRevisionDigest !== taskRevisionDigest ||
    typeof contextCriteriaDigest !== 'string' ||
    contextCriteriaDigest !== criteriaDigest ||
    typeof contextCheckSetDigest !== 'string' ||
    contextCheckSetDigest !== checkSetDigest
  ) {
    return {
      status: 'error',
      reason: 'Trusted expected context does not match the current task, workspace, repository, revision, or check set',
    };
  }

  const expectedTaskId = contextTaskId;
  const expectedWorkspaceId = contextWorkspaceId;
  const expectedRepositoryId = contextRepositoryId;
  const expectedRevisionDigest = contextRevisionDigest;
  const expectedCriteriaDigest = contextCriteriaDigest;
  const expectedCheckSetDigest = contextCheckSetDigest;
  const detachedExpectedTestFiles: string[] = [];
  const expectedPathSet = new Set<string>();
  let contextTestFileCount = 0;
  try {
    if (!Array.isArray(rawContextTestFiles)) {
      return { status: 'error', reason: 'Trusted expected test inventory must be a non-empty array' };
    }
    contextTestFileCount = rawContextTestFiles.length;
    if (!Number.isSafeInteger(contextTestFileCount) || contextTestFileCount === 0) {
      return { status: 'error', reason: 'Trusted expected test inventory must be a non-empty array' };
    }
    for (let i = 0; i < contextTestFileCount; i++) {
      const filePath = rawContextTestFiles[i];
      if (typeof filePath !== 'string' || !isCanonicalRelativePath(filePath) || isProtectedPath(filePath)) {
        return { status: 'error', reason: 'Trusted expected test inventory contains an invalid path' };
      }
      const key = filePath.toLowerCase();
      if (expectedPathSet.has(key)) {
        return { status: 'error', reason: 'Trusted expected test inventory contains a duplicate path' };
      }
      expectedPathSet.add(key);
      detachedExpectedTestFiles.push(filePath);
    }
  } catch {
    return {
      status: 'error',
      reason: 'Trusted expected test inventory access failed during extraction',
    };
  }
  Object.freeze(detachedExpectedTestFiles);

  // Detach trusted admission facts before interacting with the producer object.
  let loadSnapshotFn: unknown;
  try {
    loadSnapshotFn = hostAuthority.loadSnapshot;
  } catch {
    return {
      status: 'error',
      reason: 'Trusted host snapshot producer access failed while reading its loader',
    };
  }
  if (typeof loadSnapshotFn !== 'function') {
    return {
      status: 'error',
      reason: 'Missing trusted host authority: explicit TrustedHostPort with loadSnapshot is required',
    };
  }

  const request: TrustedHostSnapshotRequest = Object.freeze({
    taskId: expectedTaskId,
    workspaceId: expectedWorkspaceId,
    repositoryId: expectedRepositoryId,
    expectedRevisionDigest: expectedRevisionDigest,
    expectedCriteriaDigest: expectedCriteriaDigest,
    expectedCheckSetDigest: expectedCheckSetDigest,
    expectedTestFiles: detachedExpectedTestFiles,
  });

  let rawSnapshot: unknown;
  try {
    rawSnapshot = await (
      loadSnapshotFn as (request: TrustedHostSnapshotRequest) => Promise<unknown> | unknown
    ).call(hostAuthority, request);
  } catch {
    return {
      status: 'error',
      reason: 'Trusted host snapshot loading failed',
    };
  }

  const snapshotValidation = validateHostSnapshotFacts(
    rawSnapshot,
    {
      taskId: expectedTaskId,
      workspaceId: expectedWorkspaceId,
      repositoryId: expectedRepositoryId,
      revisionDigest: expectedRevisionDigest,
      criteriaDigest: expectedCriteriaDigest,
      checkSetDigest: expectedCheckSetDigest,
      expectedTestFiles: detachedExpectedTestFiles,
    },
    requiredChecks
  );
  if (!snapshotValidation.ok) {
    return {
      status: 'error',
      reason: snapshotValidation.reason,
    };
  }
  const testProtectionDigest = snapshotValidation.testProtectionDigest;

  const checkRun = await runBaselineChecks({
    rawExpectedContext,
    repository,
    expectedTaskId,
    expectedRevisionDigest,
    criteriaDigest,
    checkSetDigest,
    requiredChecks,
  });
  if (checkRun.status !== 'checks') return checkRun;
  const { checkResults } = checkRun;

  const reproductionCheckId = reproductionCheck.checkId;
  const reproResult = checkResults.find((result) => result.checkId === reproductionCheckId);
  if (!reproResult) {
    return { status: 'error', reason: 'The required reproduction check result is missing' };
  }

  const expectedCheckIds = requiredChecks.map((check) => check.checkId);
  if (
    checkResults.length !== expectedCheckIds.length ||
    checkResults.some((result, index) => result.checkId !== expectedCheckIds[index])
  ) {
    return { status: 'error', reason: 'Required check results do not match the exact required check set' };
  }

  const expectedPassingChecks = requiredChecks.filter((check) => check.checkId !== reproductionCheckId);
  const expectedPassingCheckIds = expectedPassingChecks.map((check) => check.checkId);

  if (reproResult.outcome === 'pass') {
    const failedPreviouslyPassingCheck = expectedPassingChecks.find((check) =>
      checkResults.find((result) => result.checkId === check.checkId)?.outcome !== 'pass'
    );
    if (failedPreviouslyPassingCheck) {
      return {
        status: 'error',
        reason: `Required ${failedPreviouslyPassingCheck.purpose} check '${failedPreviouslyPassingCheck.checkId}' did not pass`,
      };
    }
    return {
      status: 'non-reproducing',
      reason: reproResult.outputExcerpt ?? 'Reproduction check passed; reported defect did not reproduce',
    };
  }

  if (reproResult.outcome === 'error' || isCollectionOrSyntaxError(reproResult.outputExcerpt)) {
    if (isCollectionOrSyntaxError(reproResult.outputExcerpt)) {
      return {
        status: 'collection-error',
        reproductionSignature: reproResult.outputExcerpt,
        reason: reproResult.outputExcerpt ?? 'Test collection or syntax error encountered during reproduction',
      };
    }
    return {
      status: 'error',
      reason: reproResult.outputExcerpt ?? 'Reproduction check encountered error',
    };
  }

  if (reproResult.outcome !== 'fail') {
    return {
      status: 'error',
      reason: `Reproduction check must fail; got '${reproResult.outcome}'`,
    };
  }

  const reproductionFailureSignature = reproResult.outputExcerpt ?? 'reproduction-failure';
  const candidateFields = {
    repositorySnapshotDigest: expectedRevisionDigest,
    checkSetDigest,
    reproductionFailureSignature,
    checkResults,
    testProtectionDigest,
  };
  const admissionBaseline: Baseline = {
    evidenceId: 'pending-baseline-evidence',
    ...candidateFields,
  };
  const baselineValidation = validateBaselineAdmission(admissionBaseline, {
    expectedEvidenceId: 'pending-baseline-evidence',
    expectedRepositorySnapshotDigest: expectedRevisionDigest,
    expectedCheckSetDigest,
    expectedTestProtectionDigest: testProtectionDigest,
    expectedReproductionCheckId: reproductionCheckId,
    expectedPassingCheckIds,
  });
  if (!baselineValidation.ok) {
    return {
      status: 'error',
      reason: `Baseline admission failed: ${baselineValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }

  const baselineCandidate: BaselineEvidenceCandidate = {
    taskId: expectedTaskId,
    workspaceId: expectedWorkspaceId,
    repositoryId: expectedRepositoryId,
    acceptanceCriteria: Object.freeze([...validTask.acceptanceCriteria]),
    criteriaDigest: expectedCriteriaDigest,
    requiredChecks: Object.freeze(requiredChecks),
    expectedPassingCheckIds: Object.freeze(expectedPassingCheckIds),
    reproductionCheckId,
    expectedTestFiles: Object.freeze([...detachedExpectedTestFiles]),
    ...candidateFields,
  };

  return {
    status: 'reproduced',
    baseline: baselineCandidate,
    reproductionSignature: reproductionFailureSignature,
  };
}
