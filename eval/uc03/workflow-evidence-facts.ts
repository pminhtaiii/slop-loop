/** Validate host-owned final-tree and graph facts before independent grading. */

import { createHash } from 'node:crypto';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  isCanonicalRelativePath,
  validateBaselineAdmission,
  type Baseline,
  type BugTask,
  type RepositoryPort,
  type RepositoryPortV02,
  type TaskState,
  type VerificationResult,
} from '../../src/contracts/foundation/uc03.ts';
import { computeTestProtectionDigest, type BaselineEvidenceCandidate, type TrustedTestFileSnapshot } from '../../src/uc03/investigation.ts';
import { requiredChecksPassed, resolveExpectedTestFiles, samePaths, validDiffInfo, validSettledPatchEvidence } from '../../src/uc03/graph-validation.ts';
import type { UC03ExecutionEvidence, UC03WorkflowResult } from '../../src/uc03/graph-types.ts';
import type { UC03GraphState } from '../../src/uc03/graph-state.ts';
import type { EvaluationSnapshotIdentity, WorkflowObservation } from './types.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_FILES = 100_000;
const MAX_TOTAL_BYTES = 1_073_741_824;

export interface FinalTreeBinding {
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly initialRevisionDigest: string;
  readonly finalRevisionDigest: string;
}

/** A host capability that freezes and then rechecks the entire final worktree for one graph run. */
export interface TrustedFinalTreeSnapshotPort {
  freezeFinalTree(binding: FinalTreeBinding): unknown | Promise<unknown>;
  recheckCurrentFinalTree(binding: FinalTreeBinding, expected: EvaluationSnapshotIdentity): unknown | Promise<unknown>;
}

export interface WorkflowFinalTreeSnapshot extends FinalTreeBinding {
  readonly snapshotId: string;
  readonly complete: true;
  readonly files: readonly Readonly<{ path: string; content: string | Uint8Array }>[];
}

export interface DerivedWorkflowFacts {
  readonly snapshot: EvaluationSnapshotIdentity;
  readonly evidence: {
    readonly digest: string;
    readonly snapshotDigest: string;
    readonly diffDigest: string;
    readonly baselineFailed: boolean;
    readonly requiredChecksPassed: boolean;
    readonly focusedCheckPassed: boolean;
    readonly testsProtected: boolean;
    readonly reviewAccepted: boolean;
    readonly reviewedDiffDigest: string | null;
    readonly sentinelsUnchanged: boolean;
    readonly speculativePatchApplied: boolean;
    readonly stoppedBeforeEffect: boolean;
    readonly completionWithheld: boolean;
  };
}

function keysExactly(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every(key => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function treeContentDigest(content: string | Uint8Array): Readonly<{ digest: string; byteLength: number }> {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  return { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byteLength: bytes.byteLength };
}

export function parseWorkflowFinalTree(value: unknown, binding: FinalTreeBinding): Readonly<{ tree: WorkflowFinalTreeSnapshot; snapshot: EvaluationSnapshotIdentity }> | undefined {
  if (!isRecord(value) || !keysExactly(value, ['taskId', 'runId', 'workspaceId', 'repositoryId', 'initialRevisionDigest', 'finalRevisionDigest', 'snapshotId', 'complete', 'files'])) return undefined;
  if (
    value['taskId'] !== binding.taskId || value['runId'] !== binding.runId || value['workspaceId'] !== binding.workspaceId ||
    value['repositoryId'] !== binding.repositoryId || value['initialRevisionDigest'] !== binding.initialRevisionDigest ||
    value['finalRevisionDigest'] !== binding.finalRevisionDigest || value['complete'] !== true ||
    typeof value['snapshotId'] !== 'string' || !ID.test(value['snapshotId']) || !Array.isArray(value['files']) ||
    value['files'].length > MAX_FILES
  ) return undefined;

  const files: { path: string; content: string | Uint8Array }[] = [];
  const digestEntries: { path: string; contentDigest: string; byteLength: number }[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const rawFile of value['files']) {
    if (!isRecord(rawFile) || !keysExactly(rawFile, ['path', 'content'])) return undefined;
    const path = rawFile['path'];
    const content = rawFile['content'];
    if (typeof path !== 'string' || !isCanonicalRelativePath(path) || (typeof content !== 'string' && !(content instanceof Uint8Array))) return undefined;
    const pathKey = path.toLowerCase();
    if (seen.has(pathKey)) return undefined;
    seen.add(pathKey);
    const fact = treeContentDigest(content);
    totalBytes += fact.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) return undefined;
    files.push(Object.freeze({ path, content }));
    digestEntries.push({ path, contentDigest: fact.digest, byteLength: fact.byteLength });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  digestEntries.sort((left, right) => left.path.localeCompare(right.path));
  const digest = computeCanonicalSha256({ ...binding, files: digestEntries });
  const snapshot = Object.freeze({ snapshotId: value['snapshotId'], digest });
  const tree = Object.freeze({ ...binding, snapshotId: value['snapshotId'], complete: true as const, files: Object.freeze(files) });
  return { tree, snapshot };
}

function ownerAndPatchFacts(evidence: UC03ExecutionEvidence, task: BugTask, state: TaskState, result: UC03WorkflowResult): boolean | undefined {
  if (evidence.patchAdmission === undefined && evidence.patchReceipt === undefined) {
    if (state.changedPaths.length === 0 && ['Investigate', 'NeedsInfo', 'AwaitPlan', 'AwaitFeedback'].includes(state.node)) return false;
    return undefined;
  }
  if (evidence.patchAdmission === undefined || evidence.patchReceipt === undefined) return undefined;
  const candidate: UC03GraphState = {
    task,
    state,
    baseline: evidence.baseline,
    verificationResults: evidence.verificationResults ?? [],
    reviewRequest: evidence.reviewRequest,
    reviewResult: evidence.reviewResult,
    patchAdmission: evidence.patchAdmission,
    patchReceipt: evidence.patchReceipt,
    failureEvidence: [],
    finalReport: result.finalReport,
    reasons: result.reasons,
    terminalOutcome: result.outcome,
    milestones: result.milestones,
  };
  return validSettledPatchEvidence(candidate, task, state) ? true : undefined;
}

function verifyBaseline(baseline: Baseline | BaselineEvidenceCandidate | undefined, task: BugTask, state: TaskState): Readonly<{ failed: boolean; evidenceId: string; testProtectionDigest: string }> | undefined {
  if (!baseline) return undefined;
  const reproductions = task.requiredChecks.filter(check => check.purpose === 'reproduction');
  if (reproductions.length !== 1) return undefined;
  const reproduction = reproductions[0];
  if (!reproduction) return undefined;
  const expectedPassing = task.requiredChecks.filter(check => check.checkId !== reproduction.checkId).map(check => check.checkId);
  if ('evidenceId' in baseline) {
    if (!SHA256.test(baseline.evidenceId)) return undefined;
    const checked = validateBaselineAdmission(baseline, {
      expectedEvidenceId: baseline.evidenceId,
      expectedRepositorySnapshotDigest: task.initialRevisionDigest,
      expectedCheckSetDigest: computeCheckSetDigest(task.requiredChecks),
      expectedTestProtectionDigest: baseline.testProtectionDigest,
      expectedReproductionCheckId: reproduction.checkId,
      expectedPassingCheckIds: expectedPassing,
    });
    if (!checked.ok) return undefined;
    const result = checked.value.checkResults.find(item => item.checkId === reproduction.checkId);
    if (!result || result.outcome !== 'fail') return undefined;
    return { failed: true, evidenceId: checked.value.evidenceId, testProtectionDigest: checked.value.testProtectionDigest };
  }
  if (
    baseline.taskId !== task.taskId || baseline.workspaceId !== state.workspaceId || baseline.repositoryId !== task.repositoryId ||
    baseline.repositorySnapshotDigest !== task.initialRevisionDigest || baseline.criteriaDigest !== computeCanonicalSha256(task.acceptanceCriteria) ||
    baseline.checkSetDigest !== computeCheckSetDigest(task.requiredChecks) || baseline.reproductionCheckId !== reproduction.checkId ||
    computeCanonicalSha256(baseline.requiredChecks) !== computeCanonicalSha256(task.requiredChecks) ||
    !samePaths(baseline.expectedPassingCheckIds, expectedPassing) ||
    !samePaths(baseline.expectedTestFiles, resolveExpectedTestFiles(task)) || !SHA256.test(baseline.testProtectionDigest) ||
    baseline.checkResults.length !== task.requiredChecks.length ||
    !task.requiredChecks.every((check, index) => baseline.checkResults[index]?.checkId === check.checkId && baseline.checkResults[index]?.outcome === (check.checkId === reproduction.checkId ? 'fail' : 'pass'))
  ) return undefined;
  return { failed: true, evidenceId: computeCanonicalSha256(baseline), testProtectionDigest: baseline.testProtectionDigest };
}

function exactVerificationResults(value: readonly VerificationResult[] | undefined): readonly VerificationResult[] | undefined {
  return value && value.every(item => item && SHA256.test(item.evidenceId) && typeof item.taskId === 'string' && typeof item.runId === 'string') ? value : undefined;
}

function verificationFacts(task: BugTask, state: TaskState, diffDigest: string, results: readonly VerificationResult[] | undefined): Readonly<{ required: boolean; focused: boolean }> {
  const checked = exactVerificationResults(results);
  if (!checked) return { required: false, focused: false };
  const reproduction = task.requiredChecks.find(check => check.purpose === 'reproduction');
  const focused = reproduction && checked.filter(result => result.testedIds.includes(reproduction.checkId));
  const focusedPassed = !!focused && focused.length === 1 && focused[0]?.outcome === 'pass' && focused[0].phase === 'focused' &&
    focused[0].taskId === task.taskId && focused[0].runId === state.runId && focused[0].repoDigest === state.repositoryRevisionDigest && focused[0].diffDigest === diffDigest;
  return { required: requiredChecksPassed(task, state, diffDigest, checked), focused: focusedPassed };
}

function reviewFacts(evidence: UC03ExecutionEvidence, state: TaskState, diffDigest: string): Readonly<{ accepted: boolean; reviewedDiffDigest: string | null }> | undefined {
  const review = evidence.reviewResult;
  const request = evidence.reviewRequest;
  if (!review && !request) return state.latestReviewRef || (state.reviewRefs?.length ?? 0) > 0 ? undefined : { accepted: false, reviewedDiffDigest: null };
  if (!review || !request || review.reviewId !== state.latestReviewRef || !state.reviewRefs?.includes(review.reviewId) ||
    review.diffDigest !== diffDigest || request.role !== 'reviewer' || request.purpose !== 'final-review' ||
    request.taskId !== state.taskId || request.runId !== state.runId || request.reservationRef !== review.iterationReservationRef) return undefined;
  return { accepted: review.status === 'accepted', reviewedDiffDigest: review.diffDigest };
}

function completionWasWithheld(result: UC03WorkflowResult, state: TaskState): boolean | undefined {
  if (state.outcome === 'COMPLETED' || result.finalReport?.isComplete === true) return false;
  if (['NeedsInfo', 'AwaitPlan', 'AwaitFeedback', 'Repair', 'Verify', 'Incomplete'].includes(state.node)) return true;
  return undefined;
}

export async function deriveWorkflowEvidenceFacts(input: {
  readonly caseId: string;
  readonly task: BugTask;
  readonly result: UC03WorkflowResult;
  readonly observation: WorkflowObservation;
  readonly repository: Pick<RepositoryPort, 'inspectDiff'> | Pick<RepositoryPortV02, 'inspectDiff'> | undefined;
  readonly finalTree: TrustedFinalTreeSnapshotPort;
  readonly retainedBaseline?: BaselineEvidenceCandidate | undefined;
}): Promise<DerivedWorkflowFacts | undefined> {
  const execution = input.result.executionEvidence;
  const state = execution?.finalState;
  if (!execution || !state || !input.repository || !input.observation.taskId || !input.observation.runId || !input.observation.repositoryId ||
    state.taskId !== input.observation.taskId || state.runId !== input.observation.runId || state.repositoryId !== input.observation.repositoryId ||
    state.taskId !== input.task.taskId || state.repositoryId !== input.task.repositoryId ||
    input.observation.initialRepositoryDigest?.replace(/^sha256:/u, '') !== input.task.initialRevisionDigest.replace(/^sha256:/u, '')) return undefined;

  const binding: FinalTreeBinding = Object.freeze({
    taskId: state.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: state.repositoryId,
    initialRevisionDigest: input.task.initialRevisionDigest,
    finalRevisionDigest: state.repositoryRevisionDigest,
  });
  if (!SHA256.test(binding.finalRevisionDigest) || !SHA256.test(binding.initialRevisionDigest)) return undefined;

  let rawTree: unknown;
  let diffInfo: unknown;
  try {
    [rawTree, diffInfo] = await Promise.all([
      input.finalTree.freezeFinalTree(binding),
      input.repository.inspectDiff(input.task.initialRevisionDigest),
    ]);
  } catch {
    return undefined;
  }
  const parsedTree = parseWorkflowFinalTree(rawTree, binding);
  if (!parsedTree || !validDiffInfo(diffInfo) || !samePaths(diffInfo.changedFiles, state.changedPaths)) return undefined;

  const baseline = verifyBaseline(execution.baseline ?? input.retainedBaseline, input.task, state);
  if (!baseline) return undefined;
  const expectedTestFiles = resolveExpectedTestFiles(input.task);
  const protectedFiles: TrustedTestFileSnapshot[] = [];
  for (const path of expectedTestFiles) {
    const file = parsedTree.tree.files.find(candidate => candidate.path === path);
    if (!file) return undefined;
    protectedFiles.push(file);
  }
  let protectedDigest: string;
  try {
    protectedDigest = computeTestProtectionDigest(protectedFiles);
  } catch {
    return undefined;
  }
  const testsProtected = protectedDigest === baseline.testProtectionDigest;
  const patchApplied = ownerAndPatchFacts(execution, input.task, state, input.result);
  const review = reviewFacts(execution, state, diffInfo.diffDigest);
  const withheld = completionWasWithheld(input.result, state);
  if (patchApplied === undefined || review === undefined || withheld === undefined) return undefined;

  const checks = verificationFacts(input.task, state, diffInfo.diffDigest, execution.verificationResults);
  const unmodifiedChecks = expectedTestFiles.every(path => !diffInfo.changedFiles.includes(path));
  const sentinelsUnchanged = testsProtected && unmodifiedChecks;
  const exhaustedBeforeNextEffect = input.result.reasons.some(reason => /(?:MODEL_CALL_BUDGET_EXHAUSTED|ACTIVE_TIME_BUDGET_EXHAUSTED|REPAIR_BUDGET_EXHAUSTED|REPLAN_BUDGET_EXHAUSTED)/u.test(reason));
  const stoppedBeforeEffect = input.result.outcome === 'INCOMPLETE' ? (exhaustedBeforeNextEffect ? true : undefined) : false;
  if (stoppedBeforeEffect === undefined) return undefined;
  const factsWithoutDigest = {
    snapshotDigest: parsedTree.snapshot.digest,
    diffDigest: diffInfo.diffDigest,
    baselineFailed: baseline.failed,
    requiredChecksPassed: checks.required,
    focusedCheckPassed: checks.focused,
    testsProtected,
    reviewAccepted: review.accepted,
    reviewedDiffDigest: review.reviewedDiffDigest,
    sentinelsUnchanged,
    speculativePatchApplied: patchApplied,
    stoppedBeforeEffect,
    completionWithheld: withheld,
  } as const;
  const evidenceDigest = computeCanonicalSha256({
    caseId: input.caseId,
    binding,
    snapshot: parsedTree.snapshot,
    baselineEvidenceId: baseline.evidenceId,
    baseline: execution.baseline,
    verifications: execution.verificationResults ?? [],
    reviewRequest: execution.reviewRequest ?? null,
    reviewResult: execution.reviewResult ?? null,
    patchAdmission: execution.patchAdmission ?? null,
    patchReceipt: execution.patchReceipt ?? null,
    finalState: state,
    facts: factsWithoutDigest,
  });
  return {
    snapshot: parsedTree.snapshot,
    evidence: Object.freeze({ digest: evidenceDigest, ...factsWithoutDigest }),
  };
}
