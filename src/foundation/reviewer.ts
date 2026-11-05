/**
 * Read-only runtime reviewer (runtime-evaluation/1, T005).
 *
 * One admitted transport dispatch per review; the reviewer holds no repository,
 * state or tool authority. Findings must land on real changed diff lines.
 * Owned path: src/foundation/reviewer.ts
 */

import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  computeRequestContentDigest,
  isCanonicalRelativePath,
  validateProviderRequest,
  validateReviewAdmission,
  type BugTask,
  type ModelPortV02,
  type ProviderAdmissionContextV02,
  type ProviderRequest,
  type ProviderUsage,
  type ReviewFinding,
  type ReviewResult,
  type SourceEvidence,
  type TaskState,
  type TrustedDiffLines,
} from '../contracts/foundation/uc03.ts';
import type { UC03ReviewerPort } from '../uc03/graph-types.ts';
import { computeContextDigest, deepClone, deepFreeze } from './model.ts';

/** The review node issues exactly this purpose; a coder-purpose request is a bypass. */
const REVIEWER_PURPOSE = 'final-review';
const DIFF_PATH = 'review/diff.patch';
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

export interface RuntimeReviewerOptions {
  /** Canonical v0.2 model boundary; it owns the durable claim, attempt and outcome accounting. */
  readonly model: ModelPortV02;
  /**
   * Current post-patch repository revision digest. The port receives no owner state, and
   * revision digests are not derivable from diff text, so the host must resolve it.
   */
  readonly resolveRepoDigest: (task: BugTask, diff: string) => string | undefined | Promise<string | undefined>;
}

export interface RuntimeReviewer extends UC03ReviewerPort {
  /** Usage observed on the last dispatch, including charged invalid/uncertain responses. */
  readonly lastObservedUsage: ProviderUsage | undefined;
  /** Safe failure code of the last review, never provider output or credentials. */
  readonly lastFailureReason: string | undefined;
}

function diffPath(raw: string, prefix: string): string | null {
  const token = raw.trim().split('\t')[0] ?? '';
  if (token === '/dev/null') return null;
  const path = token.startsWith(prefix) ? token.slice(prefix.length) : token;
  return isCanonicalRelativePath(path) ? path : null;
}

/** Changed lines only: old = removed lines, new = added lines. Null means "not a unified diff". */
export function parseUnifiedDiff(diff: string): TrustedDiffLines | null {
  const files: Record<string, { oldLines: number[]; newLines: number[] }> = {};
  let oldPath: string | null = null;
  let sawOldHeader = false;
  let current: { oldLines: number[]; newLines: number[] } | null = null;
  let hunk: { target: { oldLines: number[]; newLines: number[] }; oldNo: number; newNo: number; oldLeft: number; newLeft: number } | null = null;
  let sawHunk = false;
  for (const line of diff.split('\n')) {
    if (hunk === null) {
      if (line.startsWith('--- ')) {
        oldPath = diffPath(line.slice(4), 'a/');
        sawOldHeader = true;
      } else if (line.startsWith('+++ ')) {
        if (!sawOldHeader) return null;
        sawOldHeader = false;
        // shortcut: a rename binds findings to the new path only; upgrade if cross-path reviews appear.
        const path = diffPath(line.slice(4), 'b/') ?? oldPath;
        if (path === null) return null;
        current = files[path] ?? { oldLines: [], newLines: [] };
        files[path] = current;
      } else {
        const header = HUNK_HEADER.exec(line);
        if (!header) continue;
        if (current === null) return null;
        sawHunk = true;
        hunk = {
          target: current,
          oldNo: Number(header[1]),
          newNo: Number(header[3]),
          oldLeft: header[2] === undefined ? 1 : Number(header[2]),
          newLeft: header[4] === undefined ? 1 : Number(header[4]),
        };
        if (hunk.oldLeft === 0 && hunk.newLeft === 0) hunk = null;
      }
      continue;
    }
    if (line.startsWith('\\')) continue;
    const marker = line[0];
    if (marker === ' ') {
      hunk.oldNo++;
      hunk.newNo++;
      hunk.oldLeft--;
      hunk.newLeft--;
    } else if (marker === '-') {
      hunk.target.oldLines.push(hunk.oldNo++);
      hunk.oldLeft--;
    } else if (marker === '+') {
      hunk.target.newLines.push(hunk.newNo++);
      hunk.newLeft--;
    } else {
      return null;
    }
    if (hunk.oldLeft < 0 || hunk.newLeft < 0) return null;
    if (hunk.oldLeft === 0 && hunk.newLeft === 0) hunk = null;
  }
  if (hunk !== null || !sawHunk || Object.keys(files).length === 0) return null;
  return files;
}

function parseVerdict(content: string): { readonly status: 'accepted' | 'findings'; readonly findings: readonly ReviewFinding[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('status') || !keys.includes('findings')) return null;
  const status = record['status'];
  if (status !== 'accepted' && status !== 'findings') return null;
  if (!Array.isArray(record['findings'])) return null;
  return { status, findings: record['findings'] as readonly ReviewFinding[] };
}

/**
 * Minting API for the reviewer projection. A host that must issue a matching reviewer
 * request builds the snapshot here and sets `contextDigest` to
 * `computeContextDigest(snapshot.state, snapshot.evidence)` — the value the model ingress
 * recomputes. Byte-identical to what the review closure dispatches.
 */
export function buildReviewerSnapshot(
  task: BugTask,
  diff: string,
  evidence: readonly SourceEvidence[],
  repoDigest: string,
  binding: { readonly runId: string; readonly expectedTaskStateVersion: number },
): { readonly state: TaskState; readonly evidence: readonly SourceEvidence[] } {
  const trustedDiffLines = parseUnifiedDiff(diff);
  // Callers mint only after the review path's own DIFF_NOT_UNIFIED guard; a non-unified diff here is a host bug.
  if (trustedDiffLines === null) throw new Error('DIFF_NOT_UNIFIED: buildReviewerSnapshot requires a unified diff');

  const state = deepClone<TaskState>({
    schemaVersion: '0.1.0',
    stateVersion: binding.expectedTaskStateVersion,
    taskId: task.taskId,
    runId: binding.runId,
    workspaceId: 'review-read-only',
    repositoryId: task.repositoryId,
    repositoryRevisionDigest: repoDigest,
    goal: task.goal,
    observedBehavior: task.observedBehavior,
    expectedBehavior: task.expectedBehavior,
    reproduction: task.reproduction,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: task.constraints,
    requiredCheckIds: task.requiredChecks.map(check => check.checkId),
    taskContext: task,
    node: 'Review',
    // The projection carries no plan; version 1 is the pre-plan baseline the graph itself starts from.
    planVersion: 1,
    replanCount: 0,
    changedPaths: Object.keys(trustedDiffLines),
    evidenceRefs: evidence.map(item => item.path),
    risks: [],
    nextAction: 'final-review',
  });
  return {
    state,
    evidence: [
      ...evidence.map(item => ({ ...item })),
      // The synthetic diff entry is read at the projected revision, not at the diff's own digest.
      { path: DIFF_PATH, revisionDigest: repoDigest, boundedExcerpt: diff, resultCount: 1, truncated: false },
    ],
  };
}

export function createRuntimeReviewer(options: RuntimeReviewerOptions): RuntimeReviewer {
  if (!options?.model || typeof options.model.propose !== 'function') throw new Error('INVALID_MODEL: a ModelPortV02 reviewer ingress is required');
  if (typeof options.resolveRepoDigest !== 'function') throw new Error('INVALID_REPO_DIGEST_RESOLVER: the host must resolve the current revision digest');
  let lastObservedUsage: ProviderUsage | undefined;
  let lastFailureReason: string | undefined;

  return {
    provenance: options.model.provenance,
    get lastObservedUsage() {
      return lastObservedUsage;
    },
    get lastFailureReason() {
      return lastFailureReason;
    },
    async review(task: BugTask, diff: string, evidence: readonly SourceEvidence[], request: ProviderRequest, admission: ProviderAdmissionContextV02): Promise<ReviewResult> {
      lastObservedUsage = undefined;
      lastFailureReason = undefined;

      const diffDigest = computeCanonicalSha256(diff);
      const repoDigest = await options.resolveRepoDigest(task, diff);
      if (typeof repoDigest !== 'string' || !repoDigest.trim()) throw new Error('REPO_DIGEST_UNAVAILABLE: the host could not resolve the current repository revision');
      const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
      const iterationReservationRef = request?.reservationRef ?? '';
      const reviewerRoleConfigId = admission?.providerIdentity?.configId ?? request?.configId ?? '';
      const base = { reviewId: `review-${request?.providerRequestId ?? 'unknown'}`, reviewerRoleConfigId, repoDigest, diffDigest, checkSetDigest, iterationReservationRef };
      const invalid = (reason: string): ReviewResult => {
        lastFailureReason = reason;
        return deepFreeze<ReviewResult>({ ...base, status: 'invalid', findings: [] });
      };

      // Separate reviewer role and accounting are checked before any dispatch can happen.
      // The model boundary owns the claim, attempt and outcome accounting.
      if (request?.role !== 'reviewer') return invalid('ROLE_NOT_REVIEWER');
      if (admission?.schemaVersion !== '0.2.0' || admission.subjectKind !== 'provider-request' || admission.role !== 'reviewer') return invalid('ADMISSION_NOT_REVIEWER');
      if (admission.taskId !== task.taskId || admission.runId !== request.runId || request.taskId !== task.taskId) return invalid('TASK_BINDING_MISMATCH');

      const identity = admission.providerIdentity;
      if (!identity || typeof identity.configId !== 'string' || !identity.configId.trim()) return invalid('ADMISSION_NOT_REVIEWER');
      const trustedDiffLines = parseUnifiedDiff(diff);
      if (trustedDiffLines === null) return invalid('DIFF_NOT_UNIFIED');

      // One projection serves both the request check and the dispatch, so the minted and the
      // recomputed context digests cannot drift.
      const snapshot = buildReviewerSnapshot(task, diff, evidence, repoDigest, {
        runId: admission.runId,
        expectedTaskStateVersion: admission.expectedTaskStateVersion,
      });
      const requestCheck = validateProviderRequest(request, {
        expectedTaskId: task.taskId,
        expectedRunId: admission.runId,
        expectedRole: 'reviewer',
        expectedPurpose: REVIEWER_PURPOSE,
        expectedContextDigest: computeContextDigest(snapshot.state, snapshot.evidence),
        expectedProviderRequestId: admission.providerRequestId,
        expectedProviderId: identity.providerId,
        expectedModelId: identity.modelId,
        expectedConfigId: identity.configId,
        expectedPricingPolicyId: identity.pricingPolicyId,
      });
      if (!requestCheck.ok) return invalid(`REQUEST_REJECTED:${requestCheck.errors[0]?.code ?? 'INVALID_REQUEST'}`);
      if (admission.providerRequestId !== request.providerRequestId || identity.configId !== request.configId) return invalid('REQUEST_IDENTITY_MISMATCH');
      if (computeCanonicalSha256(request) !== computeCanonicalSha256(admission.providerRequest)) return invalid('REQUEST_PAYLOAD_MISMATCH');
      if (admission.requestContentDigest !== computeRequestContentDigest(request)) return invalid('REQUEST_DIGEST_MISMATCH');
      if (request.reservationRef !== admission.requestReservationReceipt) return invalid('RESERVATION_MISMATCH');

      const bounds = admission.finiteBounds;
      if (
        !bounds ||
        request.maxInputTokens > bounds.maxInputTokens ||
        request.maxOutputTokens > bounds.maxOutputTokens ||
        request.maxBillableTokens > bounds.maxBillableTokens ||
        request.maxCostUsd > bounds.maxCostUsd
      ) {
        return invalid('REQUEST_EXCEEDS_ADMITTED_BOUNDS');
      }
      const snapshotRequest = deepClone(request);

      const executed = await options.model.propose(snapshot.state, snapshot.evidence, snapshotRequest, admission);
      if (executed.observedUsage !== undefined) lastObservedUsage = executed.observedUsage;
      if (executed.outcome === 'uncertain' || executed.outcome === 'denied') return invalid(`PROVIDER_${executed.outcome.toUpperCase()}:${executed.reason ?? 'UNKNOWN'}`);
      if (executed.outcome === 'invalid') return invalid(`PROVIDER_INVALID:${executed.errors?.[0]?.code ?? 'UNKNOWN'}`);

      const proposal = typeof executed.result === 'object' && executed.result !== null && 'proposal' in executed.result ? executed.result.proposal : null;
      const content = typeof proposal === 'object' && proposal !== null && 'content' in proposal && typeof proposal.content === 'string' ? proposal.content : null;
      const verdict = content === null ? null : parseVerdict(content);
      if (!verdict) return invalid('REVIEW_CONTENT_INVALID');

      const admissionCheck = validateReviewAdmission(
        { ...base, status: verdict.status, findings: verdict.findings },
        {
          expectedTaskId: task.taskId,
          expectedRepoDigest: repoDigest,
          expectedDiffDigest: diffDigest,
          expectedCheckSetDigest: checkSetDigest,
          expectedRoleConfigId: identity.configId,
          expectedIterationReservationRef: request.reservationRef,
          trustedDiffLines,
        },
      );
      if (!admissionCheck.ok) return invalid(`REVIEW_REJECTED:${admissionCheck.errors[0]?.code ?? 'INVALID_REVIEW'}`);
      return deepFreeze<ReviewResult>(admissionCheck.value);
    },
  };
}
