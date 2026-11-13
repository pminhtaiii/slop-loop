/** Host-fed immutable review preparation; this pure boundary never resolves or mints owner authority. */
import type {
  BugTask,
  SettledPatchAncestryV02,
  SourceEvidence,
  TaskState,
  TrustedTransitionContext,
  VerificationApprovalResolutionV02,
  VerificationAuthoritySnapshotV02,
  VerificationResult,
} from '../contracts/foundation/uc03.ts';
import type { ReviewContextV1, ReviewEvidenceV1, ReviewProfileV1, ReviewReasonV1 } from '../contracts/review.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceCandidate } from '../uc03/investigation-types.ts';
import {
  computeCanonicalSha256 as hash,
  computeCheckSetDigest,
  validateBugTask,
  validateTaskState,
  validateRepositoryAdmissionV02,
  validateRepositoryExecutionReceiptV02,
  validateVerificationAdmission,
  validateSourceEvidence,
  isVerificationAuthoritySnapshotV02,
  isVerificationApprovalResolutionV02,
} from '../contracts/foundation/uc03.ts';
import { safeSnapshot, deepFreeze } from '../contracts/foundation/uc03/v02/admission/snapshot.ts';
import { validateReviewProfile, validateReviewDiff, validateReviewContextAdmission } from './validation.ts';
import { baselineEvidenceAcknowledgementMatches } from '../uc03/investigation-snapshot.ts';
import { validateBaselineEvidenceCandidate } from '../uc03/investigation-baseline-evidence.ts';
import { currentPlanBindingDigest } from '../uc03/graph-patch-ancestry.ts';
import { createVerificationApprovalContext, currentApprovalMatches, expectedPlanMaterialDigest } from '../uc03/post-patch-verification-authority.ts';

export interface ReviewContextInputs {
  readonly task: BugTask;
  readonly state: TaskState;
  readonly repository: { readonly baseRevisionDigest: string; readonly headRevisionDigest: string; readonly diff: string; readonly diffDigest: string };
  readonly authoritySnapshot: VerificationAuthoritySnapshotV02;
  readonly currentApproval: VerificationApprovalResolutionV02;
  readonly historicalApproval: VerificationApprovalResolutionV02;
  readonly ancestry: SettledPatchAncestryV02;
  readonly baseline: { readonly content: BaselineEvidenceCandidate; readonly acknowledgement: BaselineEvidenceAcknowledgement };
  readonly verificationResults: readonly VerificationResult[];
  readonly acknowledgedChecks: NonNullable<TrustedTransitionContext['completion']>['checks'];
  readonly profile: ReviewProfileV1;
  /** Host-selected required current source spans; explicit [] uses the exact diff for changed lines. */
  readonly requiredSourcePaths: readonly string[];
  readonly evidence: readonly { readonly evidenceRef: string; readonly kind: ReviewEvidenceV1['kind']; readonly source: SourceEvidence }[];
}

export interface PreparedReviewContext {
  readonly context: ReviewContextV1;
  readonly evidence: readonly SourceEvidence[];
}
export type ReviewContextPreparation = ({ readonly status: 'ready' } & PreparedReviewContext) | { readonly status: 'blocked'; readonly reasonCode: ReviewReasonV1 };

/** Inputs must be selected from current owner reads by the host; a ready result is data, never admission. */
export function prepareReviewContext(inputs: unknown): ReviewContextPreparation {
  const snapshot = safeSnapshot(inputs);
  if (!snapshot.ok || !record(snapshot.value)) return blocked('INPUT_UNSUPPORTED');
  // Canonical authority guards require ordinary plain records, whereas safeSnapshot uses null prototypes.
  const value = structuredClone(snapshot.value) as Record<string, unknown>;
  const keys = [
    'task',
    'state',
    'repository',
    'authoritySnapshot',
    'currentApproval',
    'historicalApproval',
    'ancestry',
    'baseline',
    'verificationResults',
    'acknowledgedChecks',
    'profile',
    'requiredSourcePaths',
    'evidence',
  ];
  if (
    !exact(value, keys) ||
    !record(value['repository']) ||
    !record(value['ancestry']) ||
    !record(value['baseline']) ||
    !Array.isArray(value['verificationResults']) ||
    !Array.isArray(value['acknowledgedChecks']) ||
    !Array.isArray(value['evidence'])
  )
    return blocked('INPUT_UNSUPPORTED');
  if (!exact(value['repository'], ['baseRevisionDigest', 'headRevisionDigest', 'diff', 'diffDigest']) || !exact(value['baseline'], ['content', 'acknowledgement'])) return blocked('INPUT_UNSUPPORTED');
  const a = value['ancestry'];
  if (!exact(a, ['admissionContext', 'trustedAdmissionContext', 'claim', 'attempt', 'outcome', 'settlement', 'originalTaskState', 'originalAuthorityRef']) || Object.values(a).some(v => !record(v)))
    return blocked('INPUT_UNSUPPORTED');
  if (!validateBugTask(value['task']).ok || !validateTaskState(value['state']).ok || !validateTaskState(a['originalTaskState']).ok) return blocked('INPUT_UNSUPPORTED');
  if (!validateReviewProfile(value['profile']).ok) return blocked('LIMIT_INVALID');
  if (!validateReviewProfile({ ...(value['profile'] as ReviewProfileV1), requiredConventionPaths: value['requiredSourcePaths'] }).ok) return blocked('INPUT_UNSUPPORTED');
  if (
    !isVerificationAuthoritySnapshotV02(value['authoritySnapshot']) ||
    !isVerificationApprovalResolutionV02(value['currentApproval']) ||
    !isVerificationApprovalResolutionV02(value['historicalApproval'])
  )
    return blocked('AUTHORITY_UNAVAILABLE');
  // All canonical owner records below are detached data; each is validated before contributing facts.
  const i = value as unknown as ReviewContextInputs;
  const { task, state, repository: repo, authoritySnapshot: authority, ancestry, profile } = i;
  const diff = validateReviewDiff(repo.diff, profile.maxDiffBytes);
  if (typeof repo.diff !== 'string' || !diff.ok) return blocked('INPUT_UNSUPPORTED');
  if (
    repo.baseRevisionDigest !== task.initialRevisionDigest ||
    repo.headRevisionDigest !== state.repositoryRevisionDigest ||
    repo.diffDigest !== hash(repo.diff) ||
    hash(state.taskContext) !== hash(task) ||
    hash(state.acceptanceCriteria) !== hash(task.acceptanceCriteria) ||
    hash(state.constraints) !== hash(task.constraints) ||
    state.taskId !== task.taskId ||
    state.repositoryId !== task.repositoryId ||
    state.node !== 'Review'
  )
    return blocked('BINDING_STALE');
  if (
    authority.taskId !== task.taskId ||
    authority.runId !== state.runId ||
    authority.stateVersion !== state.stateVersion ||
    authority.repositoryRevisionDigest !== state.repositoryRevisionDigest ||
    authority.controlMode !== 'runnable' ||
    authority.holdRef !== null ||
    authority.activeClaimId !== null ||
    !state.plan?.decisionRef ||
    state.plan.checkSetDigest !== computeCheckSetDigest(task.requiredChecks) ||
    state.activeDecisionId !== state.plan.decisionRef
  )
    return blocked('AUTHORITY_UNAVAILABLE');
  const current = createVerificationApprovalContext(task, state, authority.policyIdentity, authority.decisionAuthorityGeneration, state.plan.decisionRef);
  if (!current || !currentApprovalMatches(i.currentApproval, state.plan.decisionRef, current)) return blocked('AUTHORITY_UNAVAILABLE');
  if (!validAncestry(i)) return blocked('BINDING_STALE');
  const original = ancestry.originalTaskState;
  const baselineState = original.node === 'Repair' ? { ...original, repositoryRevisionDigest: task.initialRevisionDigest } : original;
  const baselineRef = state.plan.baselineRef;
  if (
    !baselineRef ||
    !validateBaselineEvidenceCandidate(i.baseline.content, baselineState).ok ||
    !baselineEvidenceAcknowledgementMatches(i.baseline.acknowledgement, { content: i.baseline.content, contentDigest: hash(i.baseline.content) }) ||
    i.baseline.acknowledgement.evidenceId !== baselineRef
  )
    return blocked('EVIDENCE_UNACKNOWLEDGED');
  const verification = { baselineRef, results: [] as ReviewContextV1['verification']['results'][number][] };
  if (i.verificationResults.length !== task.requiredChecks.length || i.acknowledgedChecks.length !== task.requiredChecks.length) return blocked('REQUIRED_EVIDENCE_MISSING');
  for (const check of task.requiredChecks) {
    const phase = check.purpose === 'reproduction' ? 'focused' : check.purpose;
    const matches = i.verificationResults.filter(r => record(r) && Array.isArray(r.testedIds) && r.testedIds.includes(check.checkId));
    const result = matches[0];
    if (
      matches.length !== 1 ||
      !result ||
      !validateVerificationAdmission(result, {
        expectedTaskId: task.taskId,
        expectedRunId: state.runId,
        expectedRepoDigest: repo.headRevisionDigest,
        expectedDiffDigest: repo.diffDigest,
        requiredPhase: phase,
        expectedCheckId: check.checkId,
      }).ok ||
      result.commandIdentity !== hash({ executable: check.executable, argv: check.argv })
    )
      return blocked('REQUIRED_EVIDENCE_MISSING');
    const acknowledgements = i.acknowledgedChecks.filter(
      ack =>
        record(ack) &&
        ('testedIds' in ack
          ? hash(ack) === hash(result)
          : exact(ack, ['checkId', 'outcome', 'repositoryRevisionDigest', 'diffDigest']) &&
            ack.checkId === check.checkId &&
            ack.outcome === 'pass' &&
            ack.repositoryRevisionDigest === repo.headRevisionDigest &&
            ack.diffDigest === repo.diffDigest),
    );
    if (acknowledgements.length !== 1) return blocked('EVIDENCE_UNACKNOWLEDGED');
    verification.results.push({
      evidenceId: result.evidenceId,
      checkId: check.checkId,
      phase,
      outcome: 'pass',
      repoDigest: result.repoDigest,
      diffDigest: repo.diffDigest,
      contentDigest: hash(result),
    });
  }
  if (i.evidence.some(e => !record(e) || !exact(e, ['evidenceRef', 'kind', 'source']) || !validateSourceEvidence(e.source, { maxExcerptBytes: profile.maxEvidenceBytes }).ok))
    return blocked('INPUT_UNSUPPORTED');
  if (
    i.requiredSourcePaths.some(
      path =>
        !i.evidence.some(e => e.kind === 'source' && e.source.path === path && e.source.resultCount > 0 && typeof e.source.boundedExcerpt === 'string' && e.source.boundedExcerpt.trim().length > 0),
    )
  )
    return blocked('REQUIRED_EVIDENCE_MISSING');
  const evidence = i.evidence.map(e => ({ evidenceRef: e.evidenceRef, kind: e.kind, path: e.source.path, revisionDigest: e.source.revisionDigest, contentDigest: hash(e.source.boundedExcerpt) }));
  const excerpts = i.evidence.map(e => e.source);
  const conventions = evidence.filter(e => e.kind === 'convention').map(e => ({ evidenceRef: e.evidenceRef, path: e.path, revisionDigest: e.revisionDigest, contentDigest: e.contentDigest }));
  if (
    profile.requiredConventionPaths.some(
      path => !i.evidence.some(e => e.kind === 'convention' && e.source.path === path && typeof e.source.boundedExcerpt === 'string' && e.source.boundedExcerpt.trim().length > 0),
    )
  )
    return blocked('REQUIRED_EVIDENCE_MISSING');
  const binding = {
    taskId: task.taskId,
    runId: state.runId,
    repositoryId: task.repositoryId,
    workspaceId: state.workspaceId,
    baseRevisionDigest: repo.baseRevisionDigest,
    headRevisionDigest: repo.headRevisionDigest,
    diffDigest: repo.diffDigest,
    criteriaDigest: hash({ acceptanceCriteria: task.acceptanceCriteria, constraints: task.constraints }),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    verificationDigest: hash(verification),
    conventionsDigest: hash(conventions),
    evidenceDigest: hash(excerpts),
    profileDigest: hash(profile),
  };
  const contextAuthority = {
    taskStateVersion: state.stateVersion,
    controlVersion: authority.controlVersion,
    epoch: authority.epoch,
    decisionAuthorityGeneration: authority.decisionAuthorityGeneration,
    planDecisionRef: state.plan.decisionRef,
    planBindingDigest: currentPlanBindingDigest(task, state),
  };
  const body = { schemaVersion: 'uc06-review-context/1' as const, binding, authority: contextAuthority, profile, verification, conventions, evidence };
  const parsed = validateReviewContextAdmission(
    { ...body, contextDigest: hash(body) },
    { binding, authority: contextAuthority, sourceEvidence: excerpts, requiredCheckIds: task.requiredChecks.map(c => c.checkId) },
  );
  return parsed.ok ? deepFreeze({ status: 'ready', context: parsed.value, evidence: excerpts }) : blocked('INPUT_UNSUPPORTED');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function blocked(reasonCode: ReviewReasonV1): ReviewContextPreparation {
  return Object.freeze({ status: 'blocked', reasonCode });
}

function validAncestry(i: ReviewContextInputs): boolean {
  const { task, state, ancestry: a } = i;
  const original = a.originalTaskState,
    plan = original.plan,
    admission = a.admissionContext;
  if (
    !plan ||
    !state.plan ||
    plan.decisionRef === state.plan.decisionRef ||
    original.activeDecisionId !== plan.decisionRef ||
    (original.node !== 'Patch' && original.node !== 'Repair') ||
    original.taskId !== state.taskId ||
    original.runId !== state.runId ||
    original.workspaceId !== state.workspaceId ||
    original.repositoryId !== task.repositoryId ||
    hash(original.taskContext) !== hash(task) ||
    (original.node === 'Patch' && original.repositoryRevisionDigest !== task.initialRevisionDigest) ||
    expectedPlanMaterialDigest(task, original) !== expectedPlanMaterialDigest(task, state)
  )
    return false;
  if (
    !validateRepositoryAdmissionV02(admission, a.trustedAdmissionContext).ok ||
    !validateRepositoryExecutionReceiptV02({ claim: a.claim, attempt: a.attempt, outcome: a.outcome, settlement: a.settlement }, admission).ok ||
    admission.planApplicability !== 'approved-plan' ||
    admission.action.kind !== 'apply_patch' ||
    admission.runnableNode !== original.node ||
    admission.taskId !== original.taskId ||
    admission.runId !== original.runId ||
    admission.workspaceId !== original.workspaceId ||
    admission.repositoryId !== original.repositoryId ||
    admission.expectedTaskStateVersion !== original.stateVersion ||
    admission.canonicalRevision !== original.repositoryRevisionDigest ||
    admission.planDecisionRef !== plan.decisionRef ||
    admission.planBindingDigest !== currentPlanBindingDigest(task, original) ||
    hash(admission.policyAuthorityRef) !== hash(a.originalAuthorityRef) ||
    a.outcome.subjectKind !== 'repository-action' ||
    a.outcome.observedResultRevisionDigest !== state.repositoryRevisionDigest
  )
    return false;
  const authority = a.originalAuthorityRef;
  const policy = { policyId: authority.policyId, policyVersion: authority.policyVersion, configId: authority.configId, configVersion: authority.configVersion, issuerKeyRef: authority.issuerKeyRef };
  const historical = createVerificationApprovalContext(task, original, policy, authority.decisionAuthorityGeneration, plan.decisionRef, 'historical-patch');
  return !!historical && currentApprovalMatches(i.historicalApproval, plan.decisionRef, historical);
}
