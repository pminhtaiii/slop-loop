/** Bound review preparation/persist/discovery through injected owner ports, plus pure completion review checks. */
import {
  validateReviewAdmission,
  validateReviewResult,
  validateVerificationResult,
  computeCanonicalSha256 as hash,
  computeCheckSetDigest,
  isVerificationAuthoritySnapshotV02,
} from '../contracts/foundation/uc03.ts';
import type { ReviewResult, TaskState, BugTask, StatePortV02, ProviderAdmissionContextV02, VerificationResult } from '../contracts/foundation/uc03.ts';
import type { ReviewAuthorityV1, ReviewObservationV1 } from '../contracts/review.ts';
import type { PreparedReviewContext } from '../uc06/context.ts';
import { deepFreeze } from '../contracts/foundation/uc03/v02/admission/snapshot.ts';
import {
  validatePersistReviewObservationRequest,
  validatePersistReviewObservationResult,
  validateRecoverReviewObservationRequest,
  validateRecoverReviewObservationResult,
  validateLoadReviewObservationResult,
  validateReviewObservation,
} from '../uc06/validation.ts';
import { usesReviewContextResolver } from '../foundation/reviewer.ts';
import { currentPlanBindingDigest, restoreVerificationEvidence } from './graph-patch-ancestry.ts';
import { validDiffInfo, requiredChecksPassed } from './graph-validation.ts';
import type { UC03GraphState } from './graph-state.ts';
import type { UC03GraphConfig, UC03GraphPorts, UC03ReviewerAdmissionRequest } from './graph-types.ts';
import type { CompletionPredicateInput } from './verification-types.ts';
import { admitReviewMaterial } from './graph-types-v02.ts';

export function boundReviewEnabled(config: UC03GraphConfig | undefined): boolean {
  return !!config && (config.reviewContext !== undefined || config.reviewEvidence !== undefined || config.reviewPrompt !== undefined);
}

/** Port shape and declared tier are prerequisites, never proof of an owner delivery. */
export function boundReviewPortReady(config: UC03GraphConfig): boolean {
  const port = config.reviewEvidence;
  return (
    !!port &&
    port.reviewEvidenceApiVersion === 'uc06-review-evidence/1' &&
    port.provenance === (config.mode === 'production' ? 'real' : 'mock') &&
    ['persistObservation', 'loadObservation', 'recoverObservation'].every(key => typeof port[key as keyof typeof port] === 'function')
  );
}

async function currentReviewAuthority(owner: StatePortV02 | undefined, task: BugTask, state: TaskState): Promise<ReviewAuthorityV1 | undefined> {
  const snapshot = await owner?.readVerificationAuthoritySnapshot?.(task.taskId);
  if (
    !snapshot ||
    !isVerificationAuthoritySnapshotV02(snapshot) ||
    snapshot.taskId !== task.taskId ||
    snapshot.runId !== state.runId ||
    snapshot.stateVersion !== state.stateVersion ||
    snapshot.repositoryRevisionDigest !== state.repositoryRevisionDigest ||
    snapshot.controlMode !== 'runnable' ||
    snapshot.holdRef !== null ||
    snapshot.activeClaimId !== null ||
    !state.plan?.decisionRef
  )
    return undefined;
  return {
    taskStateVersion: state.stateVersion,
    controlVersion: snapshot.controlVersion,
    epoch: snapshot.epoch,
    decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration,
    planDecisionRef: state.plan.decisionRef,
    planBindingDigest: currentPlanBindingDigest(task, state),
  };
}

/** Resolve once before minting; the request-local reviewer resolver must be the same factory closure. */
export async function prepareBoundReview(config: UC03GraphConfig, reviewer: UC03GraphPorts['reviewerPort'], input: UC03ReviewerAdmissionRequest): Promise<PreparedReviewContext | undefined> {
  if (!boundReviewPortReady(config) || !config.reviewContext || !config.reviewerContextResolver || !usesReviewContextResolver(reviewer, config.reviewerContextResolver)) return undefined;
  const authority = await currentReviewAuthority(config.trustedExpectedContext?.statePort, input.task, input.state);
  if (!authority) return undefined;
  const prepared = await config.reviewContext({ ...input, phase: 'prepare' });
  if (!prepared) return undefined;
  return admitReviewMaterial(prepared, config.reviewPrompt, {
    binding: {
      taskId: input.task.taskId,
      runId: input.state.runId,
      repositoryId: input.task.repositoryId,
      workspaceId: input.state.workspaceId,
      baseRevisionDigest: input.task.initialRevisionDigest,
      headRevisionDigest: input.state.repositoryRevisionDigest,
      diffDigest: input.diff.diffDigest,
      criteriaDigest: hash({ acceptanceCriteria: input.task.acceptanceCriteria, constraints: input.task.constraints }),
      checkSetDigest: computeCheckSetDigest(input.task.requiredChecks),
    },
    authority,
    requiredCheckIds: input.task.requiredChecks.map(c => c.checkId),
  });
}

/** Persist only a settled response at the exact post-call owner tuple; this adds no accounting. */
export async function persistBoundReview(
  config: UC03GraphConfig,
  task: BugTask,
  state: TaskState,
  prepared: PreparedReviewContext,
  admission: ProviderAdmissionContextV02,
  result: ReviewResult,
): Promise<ReviewObservationV1 | undefined> {
  if (!boundReviewPortReady(config)) return undefined;
  const authority = await currentReviewAuthority(config.trustedExpectedContext?.statePort, task, state),
    before = prepared.context.authority;
  if (
    !authority ||
    authority.taskStateVersion !== before.taskStateVersion ||
    authority.controlVersion !== before.controlVersion + 3 ||
    authority.epoch !== before.epoch ||
    authority.decisionAuthorityGeneration !== before.decisionAuthorityGeneration ||
    authority.planDecisionRef !== before.planDecisionRef ||
    authority.planBindingDigest !== before.planBindingDigest
  )
    return undefined;
  const status = result.status === 'accepted' || result.status === 'findings' ? result.status : 'invalid';
  const observation: ReviewObservationV1 = {
    schemaVersion: 'uc06-review-observation/1',
    contextDigest: prepared.context.contextDigest,
    binding: prepared.context.binding,
    authority,
    reviewId: result.reviewId,
    providerRequestId: admission.providerRequestId,
    status,
    reasonCode: status === 'accepted' ? 'OK' : status === 'findings' ? 'FINDINGS' : 'MODEL_OUTPUT_INVALID',
    result,
    accountingRefs: [...new Set([admission.requestReservationReceipt, ...admission.budgetRefs])],
    evidenceTier: config.mode === 'production' ? 'real-integration' : 'controlled',
  };
  const observationDigest = hash(observation),
    request = { observation, observationDigest, expectedAuthority: authority, idempotencyKey: `review-${observationDigest.slice(7)}` };
  if (!validatePersistReviewObservationRequest(request).ok) return undefined;
  const reply = await config.reviewEvidence?.persistObservation(request),
    checked = validatePersistReviewObservationResult(reply, request);
  const after = await currentReviewAuthority(config.trustedExpectedContext?.statePort, task, state);
  return checked.ok && checked.value.outcome === 'acknowledged' && after && hash(after) === hash(authority) ? deepFreeze(observation) : undefined;
}

/** Always discover latest by independently measured candidate, then exact-load retained owner bytes. */
export async function loadBoundReview(
  config: UC03GraphConfig,
  task: BugTask,
  state: TaskState,
  diff: UC03ReviewerAdmissionRequest['diff'],
  results: readonly VerificationResult[],
): Promise<ReviewObservationV1 | undefined> {
  const diffDigest = diff.diffDigest;
  if (!boundReviewPortReady(config)) return undefined;
  const owner = config.trustedExpectedContext?.statePort,
    current = await owner?.loadTask(task.taskId);
  if (!current || current.runId !== state.runId || current.repositoryRevisionDigest !== state.repositoryRevisionDigest || current.workspaceId !== state.workspaceId) return undefined;
  const authority = await currentReviewAuthority(owner, task, current);
  if (!authority) return undefined;
  const request = {
    taskId: task.taskId,
    repositoryId: task.repositoryId,
    workspaceId: state.workspaceId,
    headRevisionDigest: state.repositoryRevisionDigest,
    diffDigest,
    expectedAuthority: authority,
  };
  if (!validateRecoverReviewObservationRequest(request).ok) return undefined;
  const recovered = validateRecoverReviewObservationResult(await config.reviewEvidence?.recoverObservation(request), request);
  if (!recovered.ok || recovered.value.outcome !== 'found') return undefined;
  const found = recovered.value,
    exact = {
      taskId: task.taskId,
      runId: found.ack.runId,
      providerRequestId: found.ack.providerRequestId,
      contextDigest: found.ack.contextDigest,
      observationDigest: found.ack.observationDigest,
      expectedAuthority: authority,
    };
  const loaded = validateLoadReviewObservationResult(await config.reviewEvidence?.loadObservation(exact), exact);
  if (!loaded.ok || loaded.value.outcome !== 'found' || hash(loaded.value) !== hash(found)) return undefined;
  const observation = loaded.value.observation,
    b = observation.binding,
    a = observation.authority;
  const material = await config.reviewContext?.({ task, state: current, diff, phase: 'completion' });
  if (!admitReviewMaterial(material, config.reviewPrompt, { binding: b, authority, requiredCheckIds: task.requiredChecks.map(c => c.checkId) })) return undefined;
  const currentAfter = await owner?.loadTask(task.taskId),
    afterAuthority = currentAfter && (await currentReviewAuthority(owner, task, currentAfter));
  if (
    !currentAfter ||
    !afterAuthority ||
    hash(currentAfter) !== hash(current) ||
    hash(afterAuthority) !== hash(authority) ||
    b.runId !== state.runId ||
    b.baseRevisionDigest !== task.initialRevisionDigest ||
    b.criteriaDigest !== hash({ acceptanceCriteria: task.acceptanceCriteria, constraints: task.constraints }) ||
    b.checkSetDigest !== computeCheckSetDigest(task.requiredChecks) ||
    a.controlVersion !== authority.controlVersion ||
    a.epoch !== authority.epoch ||
    a.decisionAuthorityGeneration !== authority.decisionAuthorityGeneration ||
    a.planDecisionRef !== authority.planDecisionRef ||
    a.planBindingDigest !== authority.planBindingDigest ||
    !(
      (current.node === 'Review' && current.stateVersion === a.taskStateVersion) ||
      (current.node === 'Deliver' && current.stateVersion === a.taskStateVersion + 1 && current.latestReviewRef === observation.reviewId)
    ) ||
    (state.node === 'Deliver' && state.latestReviewRef !== observation.reviewId)
  )
    return undefined;
  const verification = {
    baselineRef: state.plan?.baselineRef,
    results: task.requiredChecks.map(check => {
      const result = results.find(r => r.testedIds.includes(check.checkId));
      return (
        result && {
          evidenceId: result.evidenceId,
          checkId: check.checkId,
          phase: result.phase,
          outcome: result.outcome,
          repoDigest: result.repoDigest,
          diffDigest: result.diffDigest,
          contentDigest: hash(result),
        }
      );
    }),
  };
  return results.length === task.requiredChecks.length && b.verificationDigest === hash(verification) ? deepFreeze(observation) : undefined;
}

/** TaskState-only continuation restores owner evidence; missing discovery never authorizes another call. */
export async function restoreBoundReview(task: BugTask, current: TaskState, ports: UC03GraphPorts, config: UC03GraphConfig): Promise<Partial<UC03GraphState> | undefined> {
  const trusted = config.trustedExpectedContext,
    owner = trusted?.statePort;
  if (!owner || !trusted) return undefined;
  const restored = await restoreVerificationEvidence(task, current, owner, ports.baselineEvidenceWriter, trusted.expectedTestFiles);
  const checks = config.trustedTransitionContext?.completion?.checks;
  if (!restored || !checks || !checks.every(check => validateVerificationResult(check).ok)) return undefined;
  const results = structuredClone(checks) as readonly VerificationResult[],
    diff = await ports.repositoryPort.inspectDiff(task.initialRevisionDigest);
  if (!validDiffInfo(diff) || !requiredChecksPassed(task, current, diff.diffDigest, results)) return undefined;
  const observation = await loadBoundReview(config, task, current, diff, results);
  if (!observation?.result || (observation.status !== 'accepted' && observation.status !== 'findings')) return undefined;
  return {
    state: current,
    baseline: restored.baseline,
    patchAdmission: restored.admission,
    patchReceipt: restored.receipt,
    verificationResults: results,
    reviewObservation: observation,
    reviewResult: observation.result,
    reviewRequest: { reservationRef: observation.result.iterationReservationRef },
  };
}

export function completionReviewReasons(context: {
  readonly input: CompletionPredicateInput;
  readonly rawState: TaskState | undefined;
  readonly rawReview: ReviewResult | undefined;
  readonly currentRepoDigest: string;
  readonly currentDiffDigest: string;
  readonly expectedCheckSetDigest: string;
}): string[] {
  const { input, rawState, rawReview, currentRepoDigest, currentDiffDigest, expectedCheckSetDigest } = context;
  const reasons: string[] = [];
  if (input.reviewContextRequired) {
    const observation = input.trustedReviewObservation;
    if (
      !observation ||
      !validateReviewObservation(observation).ok ||
      observation.status !== 'accepted' ||
      hash(observation.result) !== hash(rawReview) ||
      observation.binding.headRevisionDigest !== currentRepoDigest ||
      observation.binding.diffDigest !== currentDiffDigest
    )
      reasons.push('Current owner-loaded bound review observation is required for completion');
  }
  // 7. Review Result Validation & Acceptance
  if (!rawReview) {
    reasons.push('Missing required review result');
  } else {
    const revShape = validateReviewResult(rawReview);
    if (!revShape.ok) {
      reasons.push(`Review result schema error: ${revShape.errors.map(e => e.message).join('; ')}`);
    }
    if (!rawReview.reviewerRoleConfigId || rawReview.reviewerRoleConfigId.trim().length === 0) {
      reasons.push('Review result reviewerRoleConfigId is required for completion');
    }
    if (!rawReview.iterationReservationRef || rawReview.iterationReservationRef.trim().length === 0) {
      reasons.push('Review result iterationReservationRef is required for completion');
    }
    if (currentRepoDigest && rawReview.repoDigest !== currentRepoDigest) {
      reasons.push(`Review result repository digest drift: expected ${currentRepoDigest}, got ${rawReview.repoDigest}`);
    }
    if (currentDiffDigest && rawReview.diffDigest !== currentDiffDigest) {
      reasons.push(`Review result diff digest drift: expected ${currentDiffDigest}, got ${rawReview.diffDigest}`);
    }
    if (expectedCheckSetDigest && rawReview.checkSetDigest !== expectedCheckSetDigest) {
      reasons.push(`Review result checkSetDigest mismatch: expected ${expectedCheckSetDigest}, got ${rawReview.checkSetDigest}`);
    }

    if (rawReview.status === 'findings') {
      const findingList = Array.isArray(rawReview.findings) ? rawReview.findings : [];
      const msgs = findingList.length > 0 ? findingList.map(f => `${f.file}:${f.line} ${f.message}`).join('; ') : 'unspecified review findings';
      reasons.push(`Review result contains actionable findings: ${msgs}`);
    } else if (rawReview.status !== 'accepted') {
      reasons.push(`Review result status is not accepted: ${rawReview.status}`);
    }

    if (Array.isArray(rawReview.findings)) {
      const actionable = rawReview.findings.filter(f => f.severity === 'error' || f.severity === 'warning');
      if (actionable.length > 0 && rawReview.status === 'accepted') {
        reasons.push('Review result with status accepted contains actionable findings (error or warning)');
      }
    }

    if (!rawState?.latestReviewRef || rawState.latestReviewRef.trim().length === 0) {
      reasons.push('State latestReviewRef is required for completion');
    } else if (rawReview.reviewId !== rawState.latestReviewRef) {
      reasons.push(`Review ID (${rawReview.reviewId}) does not match state latestReviewRef (${rawState.latestReviewRef})`);
    }
    if (rawState?.reviewRefs && !rawState.reviewRefs.includes(rawReview.reviewId)) {
      reasons.push(`Review ID (${rawReview.reviewId}) is not included in state reviewRefs`);
    }

    const trustedReview = input.trustedReviewRecord;
    if (!trustedReview) {
      reasons.push('Independent trustedReviewRecord is required for completion');
    } else {
      if (trustedReview.reviewId !== rawReview.reviewId) {
        reasons.push(`Trusted review record reviewId mismatch: expected '${trustedReview.reviewId}', got '${rawReview.reviewId}'`);
      }
      if (trustedReview.reviewerRoleConfigId !== rawReview.reviewerRoleConfigId) {
        reasons.push(`Reviewer role config ID mismatch with independent review record: expected '${trustedReview.reviewerRoleConfigId}', got '${rawReview.reviewerRoleConfigId}'`);
      }
      if (trustedReview.iterationReservationRef !== rawReview.iterationReservationRef) {
        reasons.push(`Review iteration reservation ref mismatch with independent review record: expected '${trustedReview.iterationReservationRef}', got '${rawReview.iterationReservationRef}'`);
      }
      if (currentRepoDigest && trustedReview.repoDigest !== currentRepoDigest) {
        reasons.push(`Trusted review record repository digest mismatch: expected '${currentRepoDigest}', got '${trustedReview.repoDigest}'`);
      }
      if (currentDiffDigest && trustedReview.diffDigest !== currentDiffDigest) {
        reasons.push(`Trusted review record diff digest mismatch: expected '${currentDiffDigest}', got '${trustedReview.diffDigest}'`);
      }
      if (trustedReview.status !== 'accepted') {
        reasons.push(`Trusted review record status is not accepted: '${trustedReview.status}'`);
      }
      if (expectedCheckSetDigest && trustedReview.checkSetDigest !== expectedCheckSetDigest) {
        reasons.push(`Trusted review record checkSetDigest mismatch: expected '${expectedCheckSetDigest}', got '${trustedReview.checkSetDigest}'`);
      }

      if (rawState && currentRepoDigest && currentDiffDigest && expectedCheckSetDigest) {
        const reviewAdmission = validateReviewAdmission(rawReview, {
          expectedReviewId: rawState.latestReviewRef,
          expectedRepoDigest: currentRepoDigest,
          expectedDiffDigest: currentDiffDigest,
          expectedCheckSetDigest,
          expectedRoleConfigId: trustedReview.reviewerRoleConfigId,
          expectedIterationReservationRef: trustedReview.iterationReservationRef,
        });
        if (!reviewAdmission.ok) {
          for (const err of reviewAdmission.errors) {
            reasons.push(`Review admission error: ${err.message}`);
          }
        }
      }
    }
  }

  return reasons;
}
