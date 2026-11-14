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
  type StatePortV02,
  type TaskState,
  type VerificationResult,
  validateVerificationAdmission,
  validateVerificationResult,
} from '../../src/contracts/foundation/uc03.ts';
import { computeTestProtectionDigest, type BaselineEvidenceCandidate, type TrustedTestFileSnapshot } from '../../src/uc03/investigation.ts';
import { loadVerifiedPatchAncestry } from '../../src/uc03/graph-patch-ancestry.ts';
import { resolveExpectedTestFiles, samePaths, validDiffInfo } from '../../src/uc03/graph-validation.ts';
import type { UC03ExecutionEvidence, UC03WorkflowResult } from '../../src/uc03/graph-types.ts';
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
    value['taskId'] !== binding.taskId ||
    value['runId'] !== binding.runId ||
    value['workspaceId'] !== binding.workspaceId ||
    value['repositoryId'] !== binding.repositoryId ||
    value['initialRevisionDigest'] !== binding.initialRevisionDigest ||
    value['finalRevisionDigest'] !== binding.finalRevisionDigest ||
    value['complete'] !== true ||
    typeof value['snapshotId'] !== 'string' ||
    !ID.test(value['snapshotId']) ||
    !Array.isArray(value['files']) ||
    value['files'].length > MAX_FILES
  )
    return undefined;

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

// The coder agent emits `REPAIR_BUDGET_EXHAUSTED`; the repair/replan ledgers emit `repair-budget-exhausted`.
const BUDGET_STOP = /budget[-_]exhausted/iu;

/** A coder-or-repair budget refusal is the only stop that can justify a patch-free stop as "no effect yet". */
export function budgetStopEvidence(reasons: readonly string[]): boolean {
  return reasons.some(reason => BUDGET_STOP.test(reason));
}

/**
 * A patch-free state proves nothing was applied only at a pre-patch wait, or at a Repair/Incomplete
 * stop whose own budget-exhaustion evidence says the route halted before the next effect.
 */
export function patchFreeFacts(state: TaskState, stoppedOnBudget: boolean): boolean | undefined {
  if (state.changedPaths.length !== 0) return undefined;
  if (['Investigate', 'NeedsInfo', 'AwaitPlan', 'AwaitFeedback'].includes(state.node)) return false;
  return (state.node === 'Repair' || state.node === 'Incomplete') && stoppedOnBudget ? false : undefined;
}

async function ownerAndPatchFacts(evidence: UC03ExecutionEvidence, task: BugTask, state: TaskState, owner: StatePortV02 | undefined, stoppedOnBudget: boolean): Promise<boolean | undefined> {
  if (evidence.patchAdmission === undefined && evidence.patchReceipt === undefined) return patchFreeFacts(state, stoppedOnBudget);
  if (!owner || !evidence.patchAdmission || !evidence.patchReceipt) return undefined;
  let ancestry;
  try {
    ancestry = await loadVerifiedPatchAncestry(task, state, owner);
  } catch {
    return undefined;
  }
  if (
    !ancestry ||
    computeCanonicalSha256(ancestry.admission) !== computeCanonicalSha256(evidence.patchAdmission) ||
    computeCanonicalSha256(ancestry.receipt) !== computeCanonicalSha256(evidence.patchReceipt) ||
    ancestry.receipt.outcome.observedResultRevisionDigest !== state.repositoryRevisionDigest
  )
    return undefined;
  return true;
}

function verifyBaseline(
  baseline: Baseline | BaselineEvidenceCandidate | undefined,
  task: BugTask,
  state: TaskState,
): Readonly<{ failed: boolean; evidenceId: string; testProtectionDigest: string }> | undefined {
  if (!baseline) return undefined;
  const reproductions = task.requiredChecks.filter(check => check.purpose === 'reproduction');
  if (reproductions.length !== 1) return undefined;
  const reproduction = reproductions[0];
  if (!reproduction) return undefined;
  const expectedPassing = task.requiredChecks.filter(check => check.checkId !== reproduction.checkId).map(check => check.checkId);
  if ('taskId' in baseline) {
    if (
      baseline.taskId !== task.taskId ||
      baseline.workspaceId !== state.workspaceId ||
      baseline.repositoryId !== task.repositoryId ||
      baseline.repositorySnapshotDigest !== task.initialRevisionDigest ||
      baseline.criteriaDigest !== computeCanonicalSha256(task.acceptanceCriteria) ||
      baseline.checkSetDigest !== computeCheckSetDigest(task.requiredChecks) ||
      baseline.reproductionCheckId !== reproduction.checkId ||
      computeCanonicalSha256(baseline.requiredChecks) !== computeCanonicalSha256(task.requiredChecks) ||
      !samePaths(baseline.expectedPassingCheckIds, expectedPassing) ||
      !samePaths(baseline.expectedTestFiles, resolveExpectedTestFiles(task)) ||
      !SHA256.test(baseline.testProtectionDigest) ||
      baseline.checkResults.length !== task.requiredChecks.length ||
      !task.requiredChecks.every(
        (check, index) => baseline.checkResults[index]?.checkId === check.checkId && baseline.checkResults[index]?.outcome === (check.checkId === reproduction.checkId ? 'fail' : 'pass'),
      )
    )
      return undefined;
    return { failed: true, evidenceId: computeCanonicalSha256(baseline), testProtectionDigest: baseline.testProtectionDigest };
  }

  const checked = validateBaselineAdmission(baseline, {
    expectedEvidenceId: baseline.evidenceId,
    expectedRepositorySnapshotDigest: task.initialRevisionDigest,
    expectedCheckSetDigest: computeCheckSetDigest(task.requiredChecks),
    expectedTestProtectionDigest: baseline.testProtectionDigest,
    expectedReproductionCheckId: reproduction.checkId,
    expectedPassingCheckIds: expectedPassing,
  });
  if (!checked.ok) return undefined;
  return { failed: true, evidenceId: checked.value.evidenceId, testProtectionDigest: checked.value.testProtectionDigest };
}

function exactVerificationResults(value: readonly VerificationResult[] | undefined): readonly VerificationResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const evidenceIds = new Set<string>();
  const results: VerificationResult[] = [];
  for (const item of value) {
    const checked = validateVerificationResult(item);
    if (!checked.ok || !ID.test(checked.value.evidenceId) || evidenceIds.has(checked.value.evidenceId)) return undefined;
    evidenceIds.add(checked.value.evidenceId);
    results.push(checked.value);
  }
  return results;
}

export function deriveVerificationFacts(task: BugTask, state: TaskState, diffDigest: string, results: readonly VerificationResult[] | undefined): Readonly<{ required: boolean; focused: boolean }> {
  const checked = exactVerificationResults(results);
  if (!checked || checked.length !== task.requiredChecks.length) return { required: false, focused: false };
  const reproduction = task.requiredChecks.find(check => check.purpose === 'reproduction');
  const matchedResults = new Set<VerificationResult>();
  let focusedPassed = false;
  for (const check of task.requiredChecks) {
    const resultMatches = checked.filter(result => result.testedIds.includes(check.checkId));
    if (resultMatches.length !== 1) return { required: false, focused: false };
    const result = resultMatches[0];
    if (!result || task.requiredChecks.filter(candidate => result.testedIds.includes(candidate.checkId)).length !== 1 || matchedResults.has(result)) {
      return { required: false, focused: false };
    }
    const expectedPhase = check.purpose === 'reproduction' ? 'focused' : check.purpose;
    // Admit identity, phase and binding per check as pass; a non-pass outcome then only withholds `required`.
    const admission = validateVerificationAdmission(
      { ...result, outcome: 'pass' },
      {
        expectedTaskId: task.taskId,
        expectedRunId: state.runId,
        expectedRepoDigest: state.repositoryRevisionDigest,
        expectedDiffDigest: diffDigest,
        expectedCheckId: check.checkId,
        requiredPhase: expectedPhase,
      },
    );
    if (!admission.ok) return { required: false, focused: false };
    matchedResults.add(result);
    if (check === reproduction) focusedPassed = result.outcome === 'pass';
  }
  // The regression check failing is exactly the withheld-completion case: keep its bound focused pass.
  const required = matchedResults.size === checked.length && checked.every(result => result.outcome === 'pass');
  return { required, focused: focusedPassed };
}

function reviewFacts(evidence: UC03ExecutionEvidence, state: TaskState, diffDigest: string): Readonly<{ accepted: boolean; reviewedDiffDigest: string | null }> | undefined {
  const review = evidence.reviewResult;
  const request = evidence.reviewRequest;
  if (!review && !request) return state.latestReviewRef || (state.reviewRefs?.length ?? 0) > 0 ? undefined : { accepted: false, reviewedDiffDigest: null };
  if (
    !review ||
    !request ||
    review.reviewId !== state.latestReviewRef ||
    !state.reviewRefs?.includes(review.reviewId) ||
    review.diffDigest !== diffDigest ||
    request.role !== 'reviewer' ||
    request.purpose !== 'final-review' ||
    request.taskId !== state.taskId ||
    request.runId !== state.runId ||
    request.reservationRef !== review.iterationReservationRef
  )
    return undefined;
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
  readonly statePort?: StatePortV02 | undefined;
  readonly finalTree: TrustedFinalTreeSnapshotPort;
  readonly retainedBaseline?: BaselineEvidenceCandidate | undefined;
}): Promise<DerivedWorkflowFacts | undefined> {
  const execution = input.result.executionEvidence;
  const state = execution?.finalState;
  if (
    !execution ||
    !state ||
    !input.repository ||
    !input.observation.taskId ||
    !input.observation.runId ||
    !input.observation.repositoryId ||
    state.taskId !== input.observation.taskId ||
    state.runId !== input.observation.runId ||
    state.repositoryId !== input.observation.repositoryId ||
    state.taskId !== input.task.taskId ||
    state.repositoryId !== input.task.repositoryId ||
    input.observation.initialRepositoryDigest?.replace(/^sha256:/u, '') !== input.task.initialRevisionDigest.replace(/^sha256:/u, '')
  )
    return undefined;

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
    [rawTree, diffInfo] = await Promise.all([input.finalTree.freezeFinalTree(binding), input.repository.inspectDiff(input.task.initialRevisionDigest)]);
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
  const exhaustedBeforeNextEffect = budgetStopEvidence(input.result.reasons);
  const patchApplied = await ownerAndPatchFacts(execution, input.task, state, input.statePort, exhaustedBeforeNextEffect);
  const review = reviewFacts(execution, state, diffInfo.diffDigest);
  const withheld = completionWasWithheld(input.result, state);
  if (patchApplied === undefined || review === undefined || withheld === undefined) return undefined;

  const checks = deriveVerificationFacts(input.task, state, diffInfo.diffDigest, execution.verificationResults);
  const unmodifiedChecks = expectedTestFiles.every(path => !diffInfo.changedFiles.includes(path));
  const sentinelsUnchanged = testsProtected && unmodifiedChecks;
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
