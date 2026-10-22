/**
 * UC-03 Verified Code Repair - Sanitized Milestone & Final Reporting
 *
 * Owned path: src/uc03/report.ts
 * Feature: specs/001-verified-code-repair
 * Task: T023 (sanitized milestone and final reporting)
 *
 * Requirements:
 * - C16: Milestone and final reports exclude prompts, streams, secrets, and raw reasoning;
 *   bounded redacted diagnostics; per-run and task-level usage/cost retained.
 * - FR-010: Protect credentials, secrets, and harness boundaries from reporting leak.
 * - FR-012: Milestone activity and final diff with outcome, evidence, limitations, and safe next action.
 * - SC-002: Zero unverified or drifted modifications claim COMPLETED status.
 * - SC-004: Every delivered fix links baseline, final checks, review, and diff evidence.
 * - SC-005: Milestone and final reports pass protected-data checks.
 */

import { randomUUID } from 'node:crypto';
import {
  isProtectedPath,
  type ActivityEvent,
  type Baseline,
  type BudgetLedger,
  type BugTask,
  type Delivery,
  type ReviewResult,
  type TaskOutcome,
  type TaskState,
  type VerificationResult,
} from '../contracts/foundation/uc03.ts';
import {
  isProtectedPathRef,
  sanitizeText,
  truncateUtf8ToBytes,
} from '../foundation/telemetry.ts';
import {
  evaluateDeterministicCompletion,
  type CompletionPredicateInput,
  type TrustedReviewRecord,
} from './verification.ts';

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

const FORBIDDEN_DETAIL_KEYS = new Set([
  'rawreasoning',
  'thinking',
  'prompt',
  'rawprompt',
  'stream',
  'tokenstream',
  'systemprompt',
]);

const DEFAULT_SUMMARY_BYTES = 1024;
const DEFAULT_DIFF_BYTES = 65536;
const TRUNCATION_SUFFIX = ' ... [TRUNCATED]';

function sanitizeDetails(
  details: Record<string, unknown> | undefined,
  customPatterns?: readonly (RegExp | string)[]
): Record<string, unknown> | undefined {
  if (!details || typeof details !== 'object') {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (typeof value === 'string') {
      result[key] = sanitizeText(value, customPatterns);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'string' ? sanitizeText(item, customPatterns) : item
      );
    } else if (value && typeof value === 'object') {
      result[key] = sanitizeDetails(value as Record<string, unknown>, customPatterns);
    } else {
      result[key] = value;
    }
  }
  return Object.freeze(result);
}

export function createMilestone(input: CreateMilestoneInput): Milestone {
  if (!input || typeof input !== 'object') {
    throw new TypeError('input must be an object');
  }
  if (!input.taskId || typeof input.taskId !== 'string') {
    throw new TypeError('taskId must be a non-empty string');
  }
  if (!input.runId || typeof input.runId !== 'string') {
    throw new TypeError('runId must be a non-empty string');
  }
  if (!input.node || typeof input.node !== 'string') {
    throw new TypeError('node must be a non-empty string');
  }
  if (!input.kind || typeof input.kind !== 'string') {
    throw new TypeError('kind must be a non-empty string');
  }

  const rawSummary = typeof input.summary === 'string' ? input.summary : '';
  const sanitizedSummary = sanitizeText(rawSummary, input.customSecretPatterns);
  const maxBytes =
    typeof input.maxSummaryBytes === 'number' && input.maxSummaryBytes > 0
      ? input.maxSummaryBytes
      : DEFAULT_SUMMARY_BYTES;

  let boundedSummary = sanitizedSummary;
  if (Buffer.byteLength(boundedSummary, 'utf8') > maxBytes) {
    const targetBytes = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_SUFFIX, 'utf8'));
    const prefix = truncateUtf8ToBytes(boundedSummary, targetBytes);
    boundedSummary = prefix.length > 0 ? prefix + TRUNCATION_SUFFIX : TRUNCATION_SUFFIX;
  }

  return Object.freeze({
    milestoneId: input.milestoneId ?? `ms-${randomUUID()}`,
    taskId: input.taskId,
    runId: input.runId,
    timestamp: input.timestamp ?? new Date().toISOString(),
    node: input.node,
    kind: input.kind,
    summary: boundedSummary,
    outcome: input.outcome ?? 'info',
    evidenceRefs: Array.isArray(input.evidenceRefs)
      ? Object.freeze([...input.evidenceRefs])
      : Object.freeze([]),
    details: sanitizeDetails(input.details, input.customSecretPatterns),
  });
}

export function milestoneToActivityEvent(
  milestone: Milestone,
  durationMs = 0
): ActivityEvent {
  return Object.freeze({
    eventId: milestone.milestoneId,
    taskId: milestone.taskId,
    runId: milestone.runId,
    timestamp: milestone.timestamp,
    node: milestone.node,
    actionType: milestone.kind,
    outcome: milestone.outcome,
    durationMs: Math.max(0, Math.floor(durationMs)),
    evidenceRefs: Object.freeze([...milestone.evidenceRefs]),
  });
}

function extractUsage(ledgers: readonly BudgetLedger[] | undefined, stateReplanCount: number) {
  let tokensConsumed = 0;
  let costUsd = 0;
  let replans = stateReplanCount;
  const perLedger: {
    readonly scope: string;
    readonly kind: string;
    readonly limit: number;
    readonly consumed: number;
    readonly unit: string;
  }[] = [];

  if (Array.isArray(ledgers)) {
    for (const ledger of ledgers) {
      if (ledger && typeof ledger === 'object') {
        perLedger.push(
          Object.freeze({
            scope: ledger.scope,
            kind: ledger.kind,
            limit: ledger.limit,
            consumed: ledger.consumed,
            unit: ledger.unit,
          })
        );
        if (ledger.scope === 'task' && ledger.kind === 'tokens') {
          tokensConsumed = Math.max(tokensConsumed, ledger.consumed);
        }
        if (ledger.scope === 'task' && ledger.kind === 'cost') {
          costUsd = Math.max(costUsd, ledger.consumed);
        }
        if (ledger.kind === 'replan') {
          replans = Math.max(replans, ledger.consumed);
        }
      }
    }
  }

  return {
    tokensConsumed,
    costUsd,
    replanCount: replans,
    perLedger: Object.freeze(perLedger),
  };
}

export function buildFinalReport(input: BuildFinalReportInput): FinalReport {
  if (!input || typeof input !== 'object') {
    throw new TypeError('BuildFinalReportInput must be an object');
  }
  const { task, state } = input;
  if (!task || typeof task !== 'object') {
    throw new TypeError('task must be a valid BugTask');
  }
  if (!state || typeof state !== 'object') {
    throw new TypeError('state must be a valid TaskState');
  }

  const customPatterns = input.customSecretPatterns;
  const failureReasons: string[] = [];
  const changedFiles = Array.isArray(input.changedFiles)
    ? [...input.changedFiles]
    : Array.isArray(state.changedPaths)
      ? [...state.changedPaths]
      : [];

  for (const file of changedFiles) {
    if (isProtectedPath(file) || isProtectedPathRef(file)) {
      failureReasons.push(`Changed file '${file}' is a protected path or credential file`);
    }
  }

  let isComplete = false;
  let finalOutcome: TaskOutcome;
  let delivery: Delivery | undefined;
  const fallbackUnverifiedOutcome: TaskOutcome = changedFiles.length > 0
    ? 'IMPLEMENTED_UNVERIFIED'
    : 'INCOMPLETE';

  const baseline = input.baseline;
  const verifications = input.verificationResults;
  const review = input.reviewResult;
  const repoDigest = input.currentRepoDigest;
  const diffDigest = input.currentDiffDigest;
  const origProtected = input.originalProtectedTestsDigest;
  const currProtected = input.currentProtectedTestsDigest;

  const canRunCompletionEvaluation =
    baseline !== undefined &&
    Array.isArray(verifications) &&
    review !== undefined &&
    typeof repoDigest === 'string' &&
    typeof diffDigest === 'string' &&
    typeof origProtected === 'string' &&
    typeof currProtected === 'string';

  if (canRunCompletionEvaluation && failureReasons.length === 0) {
    const predicateInput: CompletionPredicateInput = {
      task,
      state,
      baseline,
      verificationResults: verifications,
      reviewResult: review,
      currentRepoDigest: repoDigest,
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
    } else if (!canRunCompletionEvaluation) {
      failureReasons.push('Incomplete verification or review evidence for completion');
    }
  }

  if (input.overrideOutcome === 'COMPLETED' && !isComplete) {
    finalOutcome = fallbackUnverifiedOutcome;
    failureReasons.push('Requested COMPLETED outcome refused: verification is incomplete or failed');
  }

  if (Array.isArray(input.failureReasons)) {
    for (const r of input.failureReasons) {
      if (typeof r === 'string' && r.length > 0) {
        failureReasons.push(r);
      }
    }
  }

  const sanitizedReasons = failureReasons.map((r) => sanitizeText(r, customPatterns));
  const rawLimitations = Array.isArray(input.limitations) ? input.limitations : [];
  const sanitizedLimitations = rawLimitations.map((l) => sanitizeText(l, customPatterns));

  let patch: string | undefined;
  let truncated = false;
  if (typeof input.patchContent === 'string') {
    const sanitizedPatch = sanitizeText(input.patchContent, customPatterns);
    const maxDiffBytes =
      typeof input.maxDiffBytes === 'number' && input.maxDiffBytes > 0
        ? input.maxDiffBytes
        : DEFAULT_DIFF_BYTES;

    if (Buffer.byteLength(sanitizedPatch, 'utf8') > maxDiffBytes) {
      truncated = true;
      const targetBytes = Math.max(0, maxDiffBytes - Buffer.byteLength(TRUNCATION_SUFFIX, 'utf8'));
      const prefix = truncateUtf8ToBytes(sanitizedPatch, targetBytes);
      patch = prefix.length > 0 ? prefix + TRUNCATION_SUFFIX : TRUNCATION_SUFFIX;
    } else {
      patch = sanitizedPatch;
    }
  }

  let safeNextAction = 'investigate-or-abort';
  if (isComplete && finalOutcome === 'COMPLETED') {
    safeNextAction = 'ready-for-human-review';
  } else if (finalOutcome === 'IMPLEMENTED_UNVERIFIED') {
    safeNextAction = 're-verify-or-repair';
  } else if (state.node === 'AwaitFeedback') {
    safeNextAction = 'await-feedback';
  }

  const verificationRefs = Array.isArray(input.verificationResults)
    ? input.verificationResults.map((v) => v.evidenceId)
    : [];

  const evidenceRefs = [
    ...(input.baseline?.evidenceId ? [input.baseline.evidenceId] : []),
    ...verificationRefs,
    ...(input.reviewResult?.reviewId ? [input.reviewResult.reviewId] : []),
  ];

  return Object.freeze({
    taskId: task.taskId,
    runId: state.runId,
    repositoryId: task.repositoryId,
    outcome: finalOutcome,
    isComplete,
    diff: Object.freeze({
      diffDigest: input.currentDiffDigest ?? '',
      changedFiles: Object.freeze(changedFiles),
      patch,
      truncated: truncated ? true : undefined,
    }),
    evidence: Object.freeze({
      baselineRef: input.baseline?.evidenceId,
      verificationRefs: Object.freeze(verificationRefs),
      reviewRef: input.reviewResult?.reviewId,
      evidenceRefs: Object.freeze(evidenceRefs),
    }),
    limitations: Object.freeze(sanitizedLimitations),
    failureReasons: Object.freeze(sanitizedReasons),
    safeNextAction,
    usage: Object.freeze(extractUsage(state.budgetLedgers, state.replanCount ?? 0)),
    milestones: Object.freeze(Array.isArray(input.milestones) ? [...input.milestones] : []),
    delivery,
    generatedAt: new Date().toISOString(),
  });
}

export function formatMilestonesSummary(milestones: readonly Milestone[]): string {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    return 'No milestone events recorded.';
  }
  return milestones
    .map((m) => {
      const mark = m.outcome === 'success' ? '✓' : m.outcome === 'failure' ? '✗' : '•';
      return `[${m.timestamp}] ${mark} [${m.node}] ${m.kind}: ${m.summary}`;
    })
    .join('\n');
}

export function formatReportMarkdown(report: FinalReport): string {
  const lines: string[] = [
    `# UC-03 Code Repair Report: ${report.taskId}`,
    `**Run ID**: \`${report.runId}\` | **Repository**: \`${report.repositoryId}\``,
    `**Generated**: ${report.generatedAt}`,
    '',
    `## Verdict: **${report.outcome}** (${report.isComplete ? 'Complete' : 'Incomplete'})`,
    `**Safe Next Action**: \`${report.safeNextAction}\``,
    '',
    '### Changes and Diff',
    `- **Diff Digest**: \`${report.diff.diffDigest || 'none'}\``,
    `- **Changed Files**: ${report.diff.changedFiles.length > 0 ? report.diff.changedFiles.map((f) => `\`${f}\``).join(', ') : 'none'}`,
  ];

  if (report.diff.patch) {
    lines.push('```diff', report.diff.patch, '```');
    if (report.diff.truncated) {
      lines.push('> *Note: Diff output was truncated to stay within bounded diagnostic limits.*');
    }
  }
  lines.push('');

  lines.push(
    '### Evidence',
    `- **Baseline**: \`${report.evidence.baselineRef ?? 'none'}\``,
    `- **Verification Checks**: ${report.evidence.verificationRefs.length > 0 ? report.evidence.verificationRefs.map((r) => `\`${r}\``).join(', ') : 'none'}`,
    `- **Review**: \`${report.evidence.reviewRef ?? 'none'}\``,
    '',
    '### Resource Usage & Accounting',
    `- **Tokens Consumed**: ${report.usage.tokensConsumed.toLocaleString()}`,
    `- **Estimated Cost**: $${report.usage.costUsd.toFixed(4)} USD`,
    `- **Material Replans**: ${report.usage.replanCount}`,
    ''
  );

  if (report.failureReasons.length > 0) {
    lines.push('### Incompletion & Failure Reasons');
    for (const reason of report.failureReasons) {
      lines.push(`- ${reason}`);
    }
    lines.push('');
  }

  if (report.limitations.length > 0) {
    lines.push('### Limitations');
    for (const lim of report.limitations) {
      lines.push(`- ${lim}`);
    }
    lines.push('');
  }

  if (report.milestones.length > 0) {
    lines.push('### Milestone Timeline');
    for (const m of report.milestones) {
      lines.push(`- \`${m.timestamp}\` [${m.node}] **${m.kind}** (${m.outcome}): ${m.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
