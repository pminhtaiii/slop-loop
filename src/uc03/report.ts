import {
  isProtectedPath,
  validateBaseline,
  validateBugTask,
  validateDelivery,
  validateTaskState,
  type Baseline,
  type BugTask,
  type Delivery,
  type ReviewResult,
  type TaskOutcome,
  type TaskState,
  type VerificationResult,
} from '../contracts/foundation/uc03.ts';
import {
  isProtectedPathRef,
  sanitizeDiagnostic,
} from '../foundation/telemetry.ts';
import {
  evaluateDeterministicCompletion,
  type CompletionPredicateInput,
  type TrustedReviewRecord,
} from './verification.ts';

import {
  DEFAULT_DIFF_BYTES,
  DEFAULT_SUMMARY_BYTES,
  MAX_REPORT_BYTES,
  MAX_REPORT_ITEMS,
  boundedText,
  combineChangedFiles,
  reportLimit,
  isTaskOutcome,
  reportMilestones,
  reviewSnapshot,
  safeMetadata,
  safeReference,
  safeReferences,
  safePaths,
  sanitizedStringList,
  usageSnapshot,
  usageSummarySnapshot,
  verificationSnapshot,
} from './report/sanitize.ts';

export { createMilestone } from './report/sanitize.ts';
export { formatMilestonesSummary, milestoneToActivityEvent } from './report/milestones.ts';

export type MilestoneKind =
  | 'task_started'
  | 'investigation_completed'
  | 'plan_proposed'
  | 'plan_approved'
  | 'plan_rejected'
  | 'patch_applied'
  | 'verification_completed'
  | 'review_completed'
  | 'replan_triggered'
  | 'budget_exhausted'
  | 'task_completed'
  | 'task_failed'
  | 'task_interrupted';

export interface Milestone {
  readonly milestoneId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly node: string;
  readonly kind: MilestoneKind;
  readonly summary: string;
  readonly outcome: 'success' | 'failure' | 'pending' | 'info';
  readonly evidenceRefs: readonly string[];
  readonly details?: Record<string, unknown> | undefined;
}

export interface CreateMilestoneInput {
  readonly taskId: string;
  readonly runId: string;
  readonly node: string;
  readonly kind: MilestoneKind;
  readonly summary: string;
  readonly outcome?: 'success' | 'failure' | 'pending' | 'info' | undefined;
  readonly evidenceRefs?: readonly string[] | undefined;
  readonly details?: Record<string, unknown> | undefined;
  readonly customSecretPatterns?: readonly (RegExp | string)[] | undefined;
  readonly maxSummaryBytes?: number | undefined;
  readonly timestamp?: string | undefined;
  readonly milestoneId?: string | undefined;
}

export interface BuildFinalReportInput {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly baseline?: Baseline | undefined;
  readonly verificationResults?: readonly VerificationResult[] | undefined;
  readonly reviewResult?: ReviewResult | undefined;
  readonly currentRepoDigest?: string | undefined;
  readonly currentDiffDigest?: string | undefined;
  readonly changedFiles?: readonly string[] | undefined;
  readonly patchContent?: string | undefined;
  readonly originalProtectedTestsDigest?: string | undefined;
  readonly currentProtectedTestsDigest?: string | undefined;
  readonly trustedReviewRecord?: TrustedReviewRecord | undefined;
  readonly authorizedDiffDigest?: string | undefined;
  readonly limitations?: readonly string[] | undefined;
  readonly milestones?: readonly Milestone[] | undefined;
  readonly customSecretPatterns?: readonly (RegExp | string)[] | undefined;
  readonly maxDiffBytes?: number | undefined;
  readonly overrideOutcome?: TaskOutcome | undefined;
  readonly failureReasons?: readonly string[] | undefined;
}

export interface FinalReport {
  readonly taskId: string;
  readonly runId: string;
  readonly repositoryId: string;
  readonly outcome: TaskOutcome;
  readonly isComplete: boolean;
  readonly diff: {
    readonly diffDigest: string;
    readonly changedFiles: readonly string[];
    readonly patch?: string | undefined;
    readonly truncated?: boolean | undefined;
  };
  readonly evidence: {
    readonly baselineRef?: string | undefined;
    readonly verificationRefs: readonly string[];
    readonly reviewRef?: string | undefined;
    readonly evidenceRefs: readonly string[];
  };
  readonly limitations: readonly string[];
  readonly failureReasons: readonly string[];
  readonly safeNextAction: string;
  readonly usage: {
    readonly tokensConsumed: number;
    readonly costUsd: number;
    readonly replanCount: number;
    readonly perLedger: readonly {
      readonly scope: string;
      readonly kind: string;
      readonly limit: number;
      readonly consumed: number;
      readonly unit: string;
    }[];
  };
  readonly milestones: readonly Milestone[];
  readonly delivery?: Delivery | undefined;
  readonly generatedAt: string;
}

const issuedReports = new WeakSet<FinalReport>();

function freezeReportGraph(value: object): void {
  // The validated builder snapshot has already passed JSON serialization for the byte bound.
  for (const child of Object.values(value) as unknown[]) {
    if (child && typeof child === 'object') freezeReportGraph(child);
  }
  Object.freeze(value);
}

function hasValidCompletionBoundary(input: BuildFinalReportInput): boolean {
  try {
    const review = input.trustedReviewRecord;
    if (review !== undefined && (!review || typeof review !== 'object' || Array.isArray(review))) return false;
    const record = review as unknown as Record<string, unknown> | undefined;
    return validateBugTask(input.task).ok &&
      validateTaskState(input.state).ok &&
      validateBaseline(input.baseline).ok &&
      (input.authorizedDiffDigest === undefined || typeof input.authorizedDiffDigest === 'string') &&
      (!record || Object.values(record).every((field) => typeof field === 'string'));
  } catch {
    return false;
  }
}

export function buildFinalReport(input: BuildFinalReportInput): FinalReport {
  if (!input || typeof input !== 'object') {
    throw new TypeError('BuildFinalReportInput must be an object');
  }
  if (input.overrideOutcome !== undefined && !isTaskOutcome(input.overrideOutcome)) {
    throw new Error('Invalid report outcome');
  }
  const { task, state } = input;
  if (!task || typeof task !== 'object') {
    throw new TypeError('task must be a valid BugTask');
  }
  if (!state || typeof state !== 'object') {
    throw new TypeError('state must be a valid TaskState');
  }

  const customPatterns = input.customSecretPatterns;
  const usage = usageSnapshot(state.budgetLedgers, state.replanCount, customPatterns);
  const taskId = safeMetadata(task.taskId, 'task.taskId', customPatterns);
  const runId = safeMetadata(state.runId, 'state.runId', customPatterns);
  const repositoryId = safeMetadata(task.repositoryId, 'task.repositoryId', customPatterns);
  const diffDigest = input.currentDiffDigest
    ? safeMetadata(input.currentDiffDigest, 'currentDiffDigest', customPatterns)
    : '';
  const currentRepoDigest = input.currentRepoDigest
    ? safeMetadata(input.currentRepoDigest, 'currentRepoDigest', customPatterns)
    : '';
  const baselineRef = input.baseline
    ? safeReference(input.baseline.evidenceId, 'baseline.evidenceId', customPatterns)
    : undefined;
  const inventory = combineChangedFiles(input.changedFiles, state.changedPaths, customPatterns);
  const changedFiles = inventory.files;
  const verifications = verificationSnapshot(input.verificationResults, customPatterns);
  const review = reviewSnapshot(input.reviewResult, customPatterns);
  const failureReasons: string[] = [];
  if (changedFiles.some((file) => isProtectedPath(file) || isProtectedPathRef(file))) {
    failureReasons.push('Changed-file inventory contains a protected path');
  }
  if (!inventory.consistent) failureReasons.push('Changed-file inventory does not match persisted task state');
  if (input.verificationResults !== undefined && !verifications.valid) {
    failureReasons.push('Malformed verification evidence; completion withheld');
  }
  if (input.reviewResult !== undefined && !review.valid) {
    failureReasons.push('Malformed review evidence; completion withheld');
  }

  let isComplete = false;
  let finalOutcome: TaskOutcome;
  let delivery: Delivery | undefined;
  const hasModifications = changedFiles.length > 0 || (Array.isArray(state.changedPaths) && state.changedPaths.length > 0);
  const fallbackUnverifiedOutcome: TaskOutcome = hasModifications
    ? 'IMPLEMENTED_UNVERIFIED'
    : 'INCOMPLETE';

  const baseline = input.baseline;
  const origProtected = input.originalProtectedTestsDigest;
  const currProtected = input.currentProtectedTestsDigest;
  if (origProtected) safeMetadata(origProtected, 'originalProtectedTestsDigest', customPatterns);
  if (currProtected) safeMetadata(currProtected, 'currentProtectedTestsDigest', customPatterns);

  const hasCompletionEvidence =
    baseline !== undefined &&
    Array.isArray(input.verificationResults) &&
    verifications.valid &&
    review.valid &&
    Boolean(currentRepoDigest) &&
    Boolean(diffDigest) &&
    typeof origProtected === 'string' &&
    typeof currProtected === 'string' &&
    inventory.consistent &&
    failureReasons.length === 0;
  const invalidBoundary = hasCompletionEvidence && !hasValidCompletionBoundary(input);
  if (invalidBoundary) {
    failureReasons.push('Invalid completion evidence input; completion withheld');
  }
  const canRunCompletionEvaluation = hasCompletionEvidence && !invalidBoundary;

  if (canRunCompletionEvaluation && baseline && review.result) {
    const predicateInput: CompletionPredicateInput = {
      task,
      state,
      baseline,
      verificationResults: verifications.results,
      reviewResult: review.result,
      currentRepoDigest,
      currentDiffDigest: diffDigest,
      changedFiles,
      originalProtectedTestsDigest: origProtected,
      currentProtectedTestsDigest: currProtected,
      trustedReviewRecord: input.trustedReviewRecord,
      authorizedDiffDigest: input.authorizedDiffDigest,
    };

    const completionResult = evaluateDeterministicCompletion(predicateInput);
    if (completionResult.isComplete && completionResult.delivery) {
      isComplete = true;
      finalOutcome = 'COMPLETED';
      delivery = completionResult.delivery;
    } else {
      isComplete = false;
      finalOutcome = completionResult.outcome;
      delivery = undefined;
      for (const reason of completionResult.reasons) {
        failureReasons.push(reason);
      }
    }
  } else {
    isComplete = false;
    finalOutcome = input.overrideOutcome && input.overrideOutcome !== 'COMPLETED'
      ? input.overrideOutcome
      : fallbackUnverifiedOutcome;
    delivery = undefined;
    if (canRunCompletionEvaluation && failureReasons.length > 0) {
      finalOutcome = 'IMPLEMENTED_UNVERIFIED';
    } else if (!canRunCompletionEvaluation && !invalidBoundary) {
      failureReasons.push('Incomplete verification or review evidence for completion');
    }
  }

  if (input.overrideOutcome === 'COMPLETED' && !isComplete) {
    finalOutcome = fallbackUnverifiedOutcome;
    failureReasons.push('Requested COMPLETED outcome refused: verification is incomplete or failed');
  }

  if (Array.isArray(input.failureReasons)) {
    failureReasons.push(...sanitizedStringList(input.failureReasons, 'failureReasons', customPatterns));
  }

  const sanitizedReasons = Object.freeze(failureReasons.slice(0, MAX_REPORT_ITEMS)
    .map((reason) => boundedText(reason, DEFAULT_SUMMARY_BYTES, customPatterns)));
  const sanitizedLimitations = sanitizedStringList(input.limitations, 'limitations', customPatterns);

  let patch: string | undefined;
  let truncated = false;
  if (typeof input.patchContent === 'string') {
    const maxDiffBytes = reportLimit(input.maxDiffBytes, DEFAULT_DIFF_BYTES, DEFAULT_DIFF_BYTES, 'maxDiffBytes');
    const boundedPatch = sanitizeDiagnostic(input.patchContent, {
      maxBytes: maxDiffBytes,
      ...(customPatterns !== undefined ? { customPatterns } : {}),
    });
    patch = boundedPatch.sanitizedContent;
    truncated = boundedPatch.truncated;
  } else if (input.maxDiffBytes !== undefined) {
    reportLimit(input.maxDiffBytes, DEFAULT_DIFF_BYTES, DEFAULT_DIFF_BYTES, 'maxDiffBytes');
  }

  let safeNextAction = 'investigate-or-abort';
  if (isComplete && finalOutcome === 'COMPLETED') {
    safeNextAction = 'ready-for-human-review';
  } else if (finalOutcome === 'IMPLEMENTED_UNVERIFIED') {
    safeNextAction = 're-verify-or-repair';
  } else if (state.node === 'AwaitFeedback') {
    safeNextAction = 'await-feedback';
  }

  const verificationRefs = verifications.refs;

  const evidenceRefs = [
    ...(baselineRef ? [baselineRef] : []),
    ...verificationRefs,
    ...(review.ref ? [review.ref] : []),
  ];

  const report: FinalReport = {
    taskId,
    runId,
    repositoryId,
    outcome: finalOutcome,
    isComplete,
    diff: {
      diffDigest,
      changedFiles,
      patch,
      truncated: truncated ? true : undefined,
    },
    evidence: {
      baselineRef,
      verificationRefs,
      reviewRef: review.ref,
      evidenceRefs,
    },
    limitations: Object.freeze(sanitizedLimitations),
    failureReasons: Object.freeze(sanitizedReasons),
    safeNextAction,
    usage,
    milestones: reportMilestones(input.milestones, customPatterns),
    delivery,
    generatedAt: new Date().toISOString(),
  };
  try {
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_REPORT_BYTES) throw new Error();
  } catch {
    throw new Error('Final report exceeds safe output bounds');
  }
  freezeReportGraph(report);
  issuedReports.add(report);
  return report;
}

export function formatReportMarkdown(report: FinalReport): string {
  try {
    if (!report || typeof report !== 'object' || !isTaskOutcome(report.outcome)) throw new Error('Invalid report outcome');
    if (!issuedReports.has(report) || !Object.isFrozen(report)) throw new Error();
    if (typeof report.isComplete !== 'boolean' || report.isComplete !== (report.outcome === 'COMPLETED') ||
      !report.diff || typeof report.diff !== 'object' || !report.evidence || typeof report.evidence !== 'object') throw new Error();
    const taskId = safeMetadata(report.taskId, 'taskId');
    const runId = safeMetadata(report.runId, 'runId');
    const repositoryId = safeMetadata(report.repositoryId, 'repositoryId');
    const generatedAt = safeMetadata(report.generatedAt, 'generatedAt');
    const safeNextAction = safeMetadata(report.safeNextAction, 'safeNextAction');
    if (!['investigate-or-abort', 'ready-for-human-review', 're-verify-or-repair', 'await-feedback'].includes(safeNextAction)) throw new Error();
    if ((report.outcome === 'COMPLETED') !== (safeNextAction === 'ready-for-human-review')) throw new Error();
    const diffDigest = report.diff.diffDigest === '' ? '' : safeMetadata(report.diff.diffDigest, 'diff.diffDigest');
    const changedFiles = safePaths(report.diff.changedFiles, 'diff.changedFiles');
    const rawPatch = report.diff.patch;
    if (rawPatch !== undefined && typeof rawPatch !== 'string') throw new Error();
    const patch = typeof rawPatch === 'string'
      ? sanitizeDiagnostic(rawPatch, { maxBytes: DEFAULT_DIFF_BYTES })
      : undefined;
    if (report.diff.truncated !== undefined && typeof report.diff.truncated !== 'boolean') throw new Error();
    const baselineRef = report.evidence.baselineRef === undefined ? undefined : safeReference(report.evidence.baselineRef, 'evidence.baselineRef');
    const verificationRefs = safeReferences(report.evidence.verificationRefs, 'evidence.verificationRefs');
    const reviewRef = report.evidence.reviewRef === undefined ? undefined : safeReference(report.evidence.reviewRef, 'evidence.reviewRef');
    const usage = usageSummarySnapshot(report.usage);
    const failureReasons = sanitizedStringList(report.failureReasons, 'failureReasons');
    const limitations = sanitizedStringList(report.limitations, 'limitations');
    const milestones = reportMilestones(report.milestones);
    if (report.outcome === 'COMPLETED') {
      const checked = validateDelivery(report.delivery, {
        expectedTaskId: taskId, expectedRunId: runId, expectedDiffDigest: diffDigest,
        expectedBaselineRef: baselineRef ?? '', expectedReviewRef: reviewRef ?? '',
      });
      const expectedRefs = [baselineRef, ...verificationRefs, reviewRef];
      const matchesDelivery = checked.ok && checked.value.outcome === 'COMPLETED' &&
        JSON.stringify(checked.value.changedFiles) === JSON.stringify(changedFiles) &&
        JSON.stringify(checked.value.verificationRefs) === JSON.stringify(verificationRefs) &&
        checked.value.safeNextAction === safeNextAction;
      if (!matchesDelivery || safeNextAction !== 'ready-for-human-review' ||
        JSON.stringify(report.evidence.evidenceRefs) !== JSON.stringify(expectedRefs)) throw new Error();
    } else if (report.delivery !== undefined) {
      throw new Error();
    }
    const lines: string[] = [
      `# UC-03 Code Repair Report: ${taskId}`,
      `**Run ID**: \`${runId}\` | **Repository**: \`${repositoryId}\``,
      `**Generated**: ${generatedAt}`,
      '',
      `## Verdict: **${report.outcome}** (${report.isComplete ? 'Complete' : 'Incomplete'})`,
      `**Safe Next Action**: \`${safeNextAction}\``,
      '',
      '### Changes and Diff',
      `- **Diff Digest**: \`${diffDigest || 'none'}\``,
      `- **Changed Files**: ${changedFiles.length > 0 ? changedFiles.map((f) => `\`${f}\``).join(', ') : 'none'}`,
    ];

    if (patch?.sanitizedContent) {
      lines.push('```diff', patch.sanitizedContent, '```');
      if (report.diff.truncated === true || patch.truncated) {
        lines.push('> *Note: Diff output was truncated to stay within bounded diagnostic limits.*');
      }
    }
    lines.push('');

    lines.push(
      '### Evidence',
      `- **Baseline**: \`${baselineRef ?? 'none'}\``,
      `- **Verification Checks**: ${verificationRefs.length > 0 ? verificationRefs.map((r) => `\`${r}\``).join(', ') : 'none'}`,
      `- **Review**: \`${reviewRef ?? 'none'}\``,
      '',
      '### Resource Usage & Accounting',
      `- **Tokens Consumed**: ${usage.tokensConsumed.toLocaleString()}`,
      `- **Estimated Cost**: $${usage.costUsd.toFixed(4)} USD`,
      `- **Material Replans**: ${usage.replanCount}`,
      ''
    );

    if (failureReasons.length > 0) {
      lines.push('### Incompletion & Failure Reasons');
      for (const reason of failureReasons) {
        lines.push(`- ${reason}`);
      }
      lines.push('');
    }

    if (limitations.length > 0) {
      lines.push('### Limitations');
      for (const lim of limitations) {
        lines.push(`- ${lim}`);
      }
      lines.push('');
    }

    if (milestones.length > 0) {
      lines.push('### Milestone Timeline');
      for (const m of milestones) {
        lines.push(`- \`${m.timestamp}\` [${m.node}] **${m.kind}** (${m.outcome}): ${m.summary}`);
      }
      lines.push('');
    }

    return boundedText(lines.join('\n'), MAX_REPORT_BYTES);
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid report outcome') throw error;
    throw new Error('Invalid report');
  }
}
