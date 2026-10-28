import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  type Baseline,
  type BugTask,
  type ReviewResult,
  type StateTransitionOptions,
  type TaskState,
  type VerificationResult,
  validateRepositoryAdmissionV02,
  validateRepositoryExecutionReceiptV02,
  type RepositoryExecutionReceiptV02,
} from '../contracts/foundation/uc03.ts';
import { validateHostSnapshotFacts } from './investigation-snapshot.ts';
import type { TrustedHostExpectedContext, TrustedHostPort } from './investigation.ts';
import { extractCheckTestSelectors } from './selectors.ts';
import type { evaluateDeterministicCompletion, CompletionPredicateInput, TrustedReviewRecord } from './verification.ts';
import { buildFinalReport, type FinalReport } from './report.ts';
import { samePaths } from './graph-validation.ts';
import type { UC03GraphState } from './graph-state.ts';
import type { UC03RepositoryAdmission } from './graph-types.ts';
import { loadVerifiedPatchAncestry } from './graph-patch-ancestry.ts';
import { currentPlanApprovalIsCurrent } from './post-patch-verification-authority.ts';

type TrustedCompletion = NonNullable<NonNullable<StateTransitionOptions['trusted']>['completion']>;

export type CompletionInputResult =
  | { readonly ok: true; readonly input: CompletionPredicateInput }
  | { readonly ok: false; readonly reasons: readonly string[] };

export async function loadCompletionPredicateInput(args: {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly baseline: Baseline | undefined;
  readonly verificationResults: readonly VerificationResult[] | undefined;
  readonly reviewResult: ReviewResult | undefined;
  readonly diffInfo: { readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] };
  readonly reviewRequest: { readonly reservationRef: string };
  readonly patchAdmission: UC03RepositoryAdmission | undefined;
  readonly patchReceipt: RepositoryExecutionReceiptV02 | undefined;
  readonly hostAuthority: TrustedHostPort | undefined;
  readonly trustedExpectedContext: TrustedHostExpectedContext | undefined;
  readonly trustedCompletion: TrustedCompletion | undefined;
}): Promise<CompletionInputResult> {
  const {
    task, state, baseline, verificationResults, reviewResult, diffInfo,
    reviewRequest, patchAdmission, patchReceipt, hostAuthority, trustedExpectedContext, trustedCompletion,
  } = args;
  if (!baseline || !verificationResults?.length || !reviewResult || !trustedCompletion || !patchAdmission || !patchReceipt) {
    return { ok: false, reasons: ['Independent baseline, verification, patch settlement, review, and completion authority are required'] };
  }
  if (!hostAuthority || !trustedExpectedContext || !hostContextMatchesTask(trustedExpectedContext, task, state)) {
    return { ok: false, reasons: ['Trusted host authority is required for the current protected-test snapshot'] };
  }
  if (!diffInfo.diff || computeCanonicalSha256(diffInfo.diff) !== diffInfo.diffDigest) {
    return { ok: false, reasons: ['Current repository diff digest is missing or inconsistent'] };
  }

  const admissionValidation = validateRepositoryAdmissionV02(patchAdmission.context, patchAdmission.trustedContext);
  const receiptValidation = validateRepositoryExecutionReceiptV02(patchReceipt, patchAdmission.context);
  const plan = state.plan;
  const owner = trustedExpectedContext.statePort;
  const ancestry = owner ? await loadVerifiedPatchAncestry(task, state, owner) : undefined;
  const currentDecisionId = plan?.decisionRef;
  const patchAncestry = admissionValidation.ok &&
    (admissionValidation.value.runnableNode === 'Patch' || admissionValidation.value.runnableNode === 'Repair');
  if (!admissionValidation.ok || !receiptValidation.ok || !plan || !plan.decisionRef ||
      (state.activeDecisionId !== undefined && state.activeDecisionId !== plan.decisionRef) ||
      !owner || !ancestry || !currentDecisionId ||
      computeCanonicalSha256(patchAdmission) !== computeCanonicalSha256(ancestry.admission) ||
      computeCanonicalSha256(patchReceipt) !== computeCanonicalSha256(ancestry.receipt) ||
      !await currentPlanApprovalIsCurrent(task, state, owner, currentDecisionId) ||
      admissionValidation.value.planApplicability !== 'approved-plan' ||
      admissionValidation.value.action.kind !== 'apply_patch' ||
      admissionValidation.value.taskId !== state.taskId || admissionValidation.value.runId !== state.runId ||
      admissionValidation.value.workspaceId !== state.workspaceId || admissionValidation.value.repositoryId !== state.repositoryId ||
      !patchAncestry || admissionValidation.value.planDecisionRef !== ancestry.originalDecisionId ||
      baseline.repositorySnapshotDigest !== task.initialRevisionDigest || baseline.evidenceId !== plan.baselineRef ||
      (admissionValidation.value.runnableNode === 'Patch' && admissionValidation.value.canonicalRevision !== baseline.repositorySnapshotDigest) ||
      admissionValidation.value.expectedTaskStateVersion + 2 > state.stateVersion ||
      admissionValidation.value.planBindingDigest !== currentPlanBindingDigest(task, ancestry.originalTaskState) ||
      !samePaths(admissionValidation.value.action.targetPaths, diffInfo.changedFiles) ||
      receiptValidation.value.outcome.repositoryOperation !== 'apply-patch' ||
      receiptValidation.value.outcome.observedResultRevisionDigest !== state.repositoryRevisionDigest) {
    return { ok: false, reasons: ['Owner-settled patch receipt does not bind the approved plan and current repository diff'] };
  }

  const expectedTestFiles = resolveExpectedTestFiles(task);
  if (expectedTestFiles.length === 0) {
    return { ok: false, reasons: ['Required test files could not be derived from the task check set'] };
  }
  const expected: TrustedHostExpectedContext = {
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    repositoryId: task.repositoryId,
    revisionDigest: state.repositoryRevisionDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    expectedTestFiles,
  };

  let snapshot: unknown;
  try {
    snapshot = await hostAuthority.loadSnapshot({
      taskId: state.taskId,
      workspaceId: state.workspaceId,
      repositoryId: task.repositoryId,
      expectedRevisionDigest: state.repositoryRevisionDigest,
      expectedCriteriaDigest: expected.criteriaDigest,
      expectedCheckSetDigest: expected.checkSetDigest,
      expectedTestFiles,
    });
  } catch {
    return { ok: false, reasons: ['Trusted host could not load the current protected-test snapshot'] };
  }

  const snapshotValidation = validateHostSnapshotFacts(snapshot, expected, task.requiredChecks);
  if (!snapshotValidation.ok) {
    return { ok: false, reasons: [snapshotValidation.reason] };
  }

  const review = trustedCompletion.review;
  if (!review || !('reviewerRoleConfigId' in review) || !('iterationReservationRef' in review) ||
      typeof review.reviewerRoleConfigId !== 'string' || !review.reviewerRoleConfigId.trim() ||
      typeof review.iterationReservationRef !== 'string' || !review.iterationReservationRef.trim() ||
      (review.status !== 'accepted' && review.status !== 'findings')) {
    return { ok: false, reasons: ['An owner-provided review receipt bound to its persisted reservation is required'] };
  }
  const trustedReviewRecord: TrustedReviewRecord = {
    reviewId: review.reviewId,
    reviewerRoleConfigId: review.reviewerRoleConfigId,
    iterationReservationRef: review.iterationReservationRef,
    repoDigest: review.repoDigest,
    diffDigest: review.diffDigest,
    checkSetDigest: review.checkSetDigest,
    status: review.status,
  };
  const currentProtectedTestsDigest = snapshotValidation.testProtectionDigest;
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  if (
    trustedCompletion.taskId !== task.taskId ||
    trustedCompletion.runId !== state.runId ||
    trustedCompletion.repositoryRevisionDigest !== state.repositoryRevisionDigest ||
    trustedCompletion.diffDigest !== diffInfo.diffDigest ||
    trustedCompletion.authorizedDiffDigest !== diffInfo.diffDigest ||
    trustedCompletion.baselineRef !== baseline.evidenceId ||
    trustedCompletion.criteriaDigest !== computeCanonicalSha256(task.acceptanceCriteria) ||
    trustedCompletion.checkSetDigest !== checkSetDigest ||
    trustedCompletion.originalProtectedTestsDigest !== baseline.testProtectionDigest ||
    trustedCompletion.protectedTestsDigest !== currentProtectedTestsDigest ||
    trustedCompletion.reviewerRoleConfigId !== reviewResult.reviewerRoleConfigId ||
    trustedCompletion.reviewIterationReservationRef !== reviewRequest.reservationRef ||
    !plan.baselineRef || !plan.evidenceRefs.includes(plan.baselineRef) ||
    plan.checkSetDigest !== checkSetDigest ||
    review.reviewId !== reviewResult.reviewId ||
    review.status !== 'accepted' ||
    review.reviewerRoleConfigId !== reviewResult.reviewerRoleConfigId ||
    review.iterationReservationRef !== reviewResult.iterationReservationRef ||
    review.iterationReservationRef !== reviewRequest.reservationRef ||
    review.repoDigest !== state.repositoryRevisionDigest ||
    review.diffDigest !== diffInfo.diffDigest ||
    review.checkSetDigest !== checkSetDigest ||
    reviewResult.status !== 'accepted' ||
    reviewResult.repoDigest !== state.repositoryRevisionDigest ||
    reviewResult.diffDigest !== diffInfo.diffDigest ||
    reviewResult.checkSetDigest !== checkSetDigest
    || state.latestReviewRef !== reviewResult.reviewId
    || !state.reviewRefs?.includes(reviewResult.reviewId)
  ) {
    return { ok: false, reasons: ['Owner-provided completion evidence is stale or does not match the current route'] };
  }
  if (!trustedChecksMatch(task, state, diffInfo.diffDigest, verificationResults, trustedCompletion.checks)) {
    return { ok: false, reasons: ['Owner-provided verification receipts do not match the current passing checks'] };
  }
  if (!samePaths(diffInfo.changedFiles, state.changedPaths)) {
    return { ok: false, reasons: ['Current diff changed-file inventory does not match persisted task state'] };
  }

  return {
    ok: true,
    input: {
      task,
      state,
      baseline,
      verificationResults,
      reviewResult,
      currentRepoDigest: state.repositoryRevisionDigest,
      currentDiffDigest: diffInfo.diffDigest,
      changedFiles: diffInfo.changedFiles,
      originalProtectedTestsDigest: baseline.testProtectionDigest,
      currentProtectedTestsDigest,
      trustedReviewRecord,
      authorizedDiffDigest: trustedCompletion.authorizedDiffDigest,
    },
  };
}

function hostContextMatchesTask(
  trusted: TrustedHostExpectedContext,
  task: BugTask,
  state: TaskState,
): boolean {
  const expectedTestFiles = resolveExpectedTestFiles(task);
  return trusted.taskId === task.taskId && trusted.workspaceId === state.workspaceId &&
    trusted.repositoryId === task.repositoryId && trusted.revisionDigest === task.initialRevisionDigest &&
    trusted.criteriaDigest === computeCanonicalSha256(task.acceptanceCriteria) &&
    trusted.checkSetDigest === computeCheckSetDigest(task.requiredChecks) && expectedTestFiles.length > 0 &&
    samePaths(trusted.expectedTestFiles, expectedTestFiles);
}

function currentPlanBindingDigest(task: BugTask, state: TaskState): string {
  const plan = state.plan;
  if (!plan?.decisionRef) return '';
  return computeCanonicalSha256({
    taskId: state.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef ?? '',
    evidenceRefs: plan.evidenceRefs ?? [],
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef: plan.decisionRef,
  });
}

function resolveExpectedTestFiles(task: BugTask): readonly string[] {
  const files = new Set<string>();
  for (const check of task.requiredChecks) {
    for (const selector of extractCheckTestSelectors(check)) {
      if (!selector.isDirectory) files.add(selector.filePath);
    }
  }
  return [...files].sort();
}

function trustedChecksMatch(
  task: BugTask,
  state: TaskState,
  diffDigest: string,
  results: readonly VerificationResult[],
  trusted: TrustedCompletion['checks'],
): boolean {
  return task.requiredChecks.every((check) => {
    const matches = results.filter((result) => result.testedIds.includes(check.checkId));
    const trustedMatches = trusted.filter((record) => 'checkId' in record
      ? record.checkId === check.checkId
      : record.testedIds.includes(check.checkId));
    if (matches.length !== 1 || trustedMatches.length !== 1) return false;
    const result = matches[0];
    const record = trustedMatches[0];
    if (!result || !record) return false;
    const actualPhase = check.purpose === 'reproduction' ? 'focused' : check.purpose;
    const recordMatches = 'checkId' in record
      ? record.outcome === 'pass' && record.repositoryRevisionDigest === state.repositoryRevisionDigest && record.diffDigest === diffDigest
      : record.outcome === 'pass' && record.phase === actualPhase && record.taskId === task.taskId &&
        record.runId === state.runId && record.repoDigest === state.repositoryRevisionDigest && record.diffDigest === diffDigest &&
        record.testedIds.includes(check.checkId);
    return result.outcome === 'pass' && result.phase === actualPhase && result.taskId === task.taskId &&
      result.runId === state.runId && result.repoDigest === state.repositoryRevisionDigest &&
      result.diffDigest === diffDigest && recordMatches;
  });
}

export function reportForPredicate(
  task: BugTask,
  state: TaskState,
  baseline: Baseline,
  verificationResults: readonly VerificationResult[],
  reviewResult: ReviewResult,
  diffInfo: { readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] },
  input: Parameters<typeof evaluateDeterministicCompletion>[0],
  completion: ReturnType<typeof evaluateDeterministicCompletion>,
  milestones: UC03GraphState['milestones'],
): FinalReport {
  return buildFinalReport({
    task,
    state,
    baseline,
    verificationResults,
    reviewResult,
    currentRepoDigest: input.currentRepoDigest,
    currentDiffDigest: input.currentDiffDigest,
    changedFiles: input.changedFiles,
    patchContent: diffInfo.diff,
    originalProtectedTestsDigest: input.originalProtectedTestsDigest,
    currentProtectedTestsDigest: input.currentProtectedTestsDigest,
    trustedReviewRecord: input.trustedReviewRecord,
    authorizedDiffDigest: input.authorizedDiffDigest,
    overrideOutcome: completion.outcome,
    failureReasons: completion.reasons,
    milestones,
  });
}

export function incompleteDelivery(
  state: UC03GraphState,
  reasons: readonly string[],
  diffInfo?: { readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] },
): Partial<UC03GraphState> {
  if (!state.task || !state.state) return { state: undefined, terminalOutcome: 'INCOMPLETE' as const, reasons };
  const report = buildFinalReport({
    task: state.task,
    state: state.state,
    baseline: state.baseline,
    verificationResults: state.verificationResults,
    reviewResult: state.reviewResult,
    currentRepoDigest: state.state.repositoryRevisionDigest,
    ...(diffInfo ? { currentDiffDigest: diffInfo.diffDigest, changedFiles: diffInfo.changedFiles, patchContent: diffInfo.diff } : { changedFiles: state.state.changedPaths }),
    overrideOutcome: state.state.changedPaths.length > 0 ? 'IMPLEMENTED_UNVERIFIED' : 'INCOMPLETE',
    failureReasons: reasons,
    milestones: state.milestones,
  });
  return {
    state: state.state.outcome === 'COMPLETED' ? undefined : state.state,
    finalReport: report,
    terminalOutcome: report.outcome,
    reasons: report.failureReasons,
    milestones: state.milestones,
  };
}

