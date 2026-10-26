import {
  computeCanonicalSha256,
  isCanonicalRelativePath,
  isProtectedPath,
  validateBaselineAdmission,
  validateFixPlan,
  validateStateTransition,
  validateTaskState,
} from '../contracts/foundation/uc03.ts';
import type {
  ApprovalBinding,
  ApproveFixPlanAction,
  Baseline,
  FixPlan,
  TaskState,
} from '../contracts/foundation/uc03.ts';
import { baselineEvidenceAcknowledgementMatches } from './investigation-snapshot.ts';
import { validateBaselineEvidenceCandidate } from './investigation-baseline-evidence.ts';
import { finishPlanApproval } from './investigation-plan-resume.ts';
import type {
  BaselineEvidenceCandidate,
  BaselineEvidenceWriteRequest,
  InvestigationPorts,
  PlanPreparationResult,
} from './investigation-types.ts';

export async function prepareFixPlanAndApproval(
  state: TaskState,
  baseline: BaselineEvidenceCandidate,
  ports: InvestigationPorts,
  planDetails?: Partial<FixPlan>
): Promise<PlanPreparationResult> {
  const stateValidation = validateTaskState(state);
  if (!stateValidation.ok) {
    return {
      outcome: 'rejected',
      reason: `TaskState validation failed: ${stateValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }
  const validState = stateValidation.value;

  const baselineValidation = validateBaselineEvidenceCandidate(baseline, validState);
  if (!baselineValidation.ok) {
    return {
      outcome: 'rejected',
      reason: baselineValidation.reason,
    };
  }
  const validBaselineCandidate = baselineValidation.candidate;

  if (!ports?.repository || !ports.state || !ports.approval) {
    return {
      outcome: 'rejected',
      reason: 'Missing required ports: repository, state, and approval are mandatory',
    };
  }

  if (validState.node !== 'Investigate') {
    return {
      outcome: 'rejected',
      reason: `Invalid starting node: expected 'Investigate', got '${validState.node}'`,
    };
  }

  const planVersion = planDetails?.planVersion ?? validState.planVersion ?? 1;

  const diagnosis = planDetails?.diagnosis;
  if (!diagnosis || diagnosis.trim().length === 0) {
    return {
      outcome: 'rejected',
      reason: 'Missing actual diagnosis: diagnosis must be explicitly provided in planDetails',
    };
  }

  const strategy = planDetails?.strategy;
  if (!strategy || strategy.trim().length === 0) {
    return {
      outcome: 'rejected',
      reason: 'Missing actual strategy: strategy must be explicitly provided in planDetails',
    };
  }

  const strategyDigest = computeCanonicalSha256(strategy);
  const decisionId = planDetails?.decisionRef ?? `dec-plan-${validState.taskId}-${planVersion}`;

  const suspectedCauseLocations = planDetails?.suspectedCauseLocations;
  if (
    !suspectedCauseLocations ||
    !Array.isArray(suspectedCauseLocations) ||
    suspectedCauseLocations.length === 0
  ) {
    return {
      outcome: 'rejected',
      reason: 'Missing suspected cause locations: suspectedCauseLocations must be explicitly provided in planDetails',
    };
  }

  for (const loc of suspectedCauseLocations) {
    if (
      typeof loc !== 'string' ||
      !isCanonicalRelativePath(loc) ||
      isProtectedPath(loc)
    ) {
      return {
        outcome: 'rejected',
        reason: `Invalid suspected cause location: '${loc}' is not a valid canonical relative path or is protected`,
      };
    }
  }

  const scopedChanges = planDetails?.scopedChanges;
  if (
    !scopedChanges ||
    !Array.isArray(scopedChanges) ||
    scopedChanges.length === 0
  ) {
    return {
      outcome: 'rejected',
      reason: 'Missing scoped changes: scopedChanges must be explicitly provided in planDetails',
    };
  }

  for (const chg of scopedChanges) {
    if (
      typeof chg !== 'string' ||
      !isCanonicalRelativePath(chg) ||
      isProtectedPath(chg)
    ) {
      return {
        outcome: 'rejected',
        reason: `Invalid scoped change path: '${chg}' is not a valid canonical relative path or is protected`,
      };
    }
  }

  const policyId = validState.taskContext?.configId;
  if (!policyId || policyId.trim().length === 0) {
    return {
      outcome: 'rejected',
      reason: 'Missing configId in task context: cannot fabricate default policy ID',
    };
  }

  const policyVersion = validState.taskContext?.configVersion;
  if (!policyVersion || policyVersion.trim().length === 0) {
    return {
      outcome: 'rejected',
      reason: 'Missing configVersion in task context: cannot fabricate default policy version',
    };
  }

  const evidenceWriter = ports.baselineEvidenceWriter;
  if (!evidenceWriter || typeof evidenceWriter.persistBaselineEvidence !== 'function') {
    return {
      outcome: 'rejected',
      reason: 'Missing trusted UC-04 baseline evidence writer',
    };
  }

  const evidenceContent: BaselineEvidenceCandidate = Object.freeze({
    ...validBaselineCandidate,
    acceptanceCriteria: Object.freeze([...validBaselineCandidate.acceptanceCriteria]),
    requiredChecks: Object.freeze(
      validBaselineCandidate.requiredChecks.map((check) =>
        Object.freeze({ ...check, argv: Object.freeze([...check.argv]) })
      )
    ),
    expectedPassingCheckIds: Object.freeze([...validBaselineCandidate.expectedPassingCheckIds]),
    expectedTestFiles: Object.freeze([...validBaselineCandidate.expectedTestFiles]),
    checkResults: Object.freeze(
      validBaselineCandidate.checkResults.map((result) => Object.freeze({ ...result }))
    ),
  });
  const writeRequest: BaselineEvidenceWriteRequest = Object.freeze({
    content: evidenceContent,
    contentDigest: computeCanonicalSha256(evidenceContent),
  });

  let rawAcknowledgement: unknown;
  try {
    rawAcknowledgement = await evidenceWriter.persistBaselineEvidence(writeRequest);
  } catch {
    return {
      outcome: 'rejected',
      reason: 'Trusted UC-04 baseline evidence persistence failed',
    };
  }
  if (!baselineEvidenceAcknowledgementMatches(rawAcknowledgement, writeRequest)) {
    return {
      outcome: 'rejected',
      reason: 'Trusted UC-04 baseline evidence acknowledgement did not match the persisted content',
    };
  }
  const acknowledgement = rawAcknowledgement;

  const persistedBaselineCandidate: Baseline = {
    evidenceId: acknowledgement.evidenceId,
    repositorySnapshotDigest: evidenceContent.repositorySnapshotDigest,
    checkSetDigest: evidenceContent.checkSetDigest,
    reproductionFailureSignature: evidenceContent.reproductionFailureSignature,
    checkResults: evidenceContent.checkResults,
    testProtectionDigest: evidenceContent.testProtectionDigest,
  };
  const persistedBaselineValidation = validateBaselineAdmission(persistedBaselineCandidate, {
    expectedEvidenceId: acknowledgement.evidenceId,
    expectedRepositorySnapshotDigest: evidenceContent.repositorySnapshotDigest,
    expectedCheckSetDigest: evidenceContent.checkSetDigest,
    expectedTestProtectionDigest: evidenceContent.testProtectionDigest,
    expectedReproductionCheckId: evidenceContent.reproductionCheckId,
    expectedPassingCheckIds: evidenceContent.expectedPassingCheckIds,
  });
  if (!persistedBaselineValidation.ok) {
    return {
      outcome: 'rejected',
      reason: `Persisted baseline admission failed: ${persistedBaselineValidation.errors.map((error) => error.message).join(', ')}`,
    };
  }
  const validBaseline = persistedBaselineValidation.value;
  const requestedEvidenceRefs = planDetails?.evidenceRefs;
  let completeEvidenceRefs: readonly string[];
  if (requestedEvidenceRefs === undefined) {
    completeEvidenceRefs = Object.freeze([validBaseline.evidenceId]);
  } else if (!Array.isArray(requestedEvidenceRefs)) {
    return {
      outcome: 'rejected',
      state: validState,
      reason: 'Invalid evidence references: planDetails.evidenceRefs must be an array',
    };
  } else {
    const stateRefs = validState.evidenceRefs ?? [];
    for (const ref of requestedEvidenceRefs) {
      if (typeof ref !== 'string' || ref.trim().length === 0) {
        return {
          outcome: 'rejected',
          state: validState,
          reason: 'Invalid evidence reference: reference must be a non-empty string',
        };
      }
      const isKnownProvenance =
        ref === validBaseline.evidenceId ||
        stateRefs.includes(ref);
      if (!isKnownProvenance) {
        return {
          outcome: 'rejected',
          state: validState,
          reason: `Untrusted or missing evidence reference: '${ref}' has no proven provenance in task state`,
        };
      }
    }
    const extra = requestedEvidenceRefs
      .filter((r) => r !== validBaseline.evidenceId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    completeEvidenceRefs = Object.freeze([validBaseline.evidenceId, ...new Set(extra)]);
  }

  const checkSetDigest = validBaseline.checkSetDigest;
  const baselineRef = validBaseline.evidenceId;

  const planCandidate: FixPlan = {
    planVersion,
    diagnosis,
    suspectedCauseLocations,
    evidenceRefs: completeEvidenceRefs,
    strategy,
    scopedChanges,
    checkSetDigest,
    baselineRef,
    strategyDigest,
    decisionRef: decisionId,
  };

  const planValidation = validateFixPlan(planCandidate);
  if (!planValidation.ok) {
    return {
      outcome: 'rejected',
      reason: `FixPlan validation failed: ${planValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }
  const fixPlan = planValidation.value;

  const existingEvidenceRefs = validState.evidenceRefs ?? [];
  const updatedEvidenceRefs = [
    ...existingEvidenceRefs,
    ...completeEvidenceRefs.filter((r) => !existingEvidenceRefs.includes(r)),
  ];

  const awaitPlanCandidate: TaskState = {
    ...validState,
    stateVersion: validState.stateVersion + 1,
    node: 'AwaitPlan',
    plan: fixPlan,
    activeDecisionId: decisionId,
    nextAction: 'await-plan-approval',
    evidenceRefs: updatedEvidenceRefs,
    ...(validState.budgetLedgers !== undefined
      ? { budgetLedgers: validState.budgetLedgers }
      : { budgetLedgers: [] }),
  };

  const transitionValidation = validateStateTransition(validState, awaitPlanCandidate);
  if (!transitionValidation.ok) {
    return {
      outcome: 'rejected',
      reason: `State transition to AwaitPlan failed: ${transitionValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }

  let persistedAwaitPlanState: TaskState;
  try {
    persistedAwaitPlanState = await ports.state.transition(
      awaitPlanCandidate,
      validState.stateVersion
    );
    await ports.state.checkpoint(persistedAwaitPlanState);
  } catch (err: unknown) {
    return {
      outcome: 'rejected',
      reason: `StatePort transition/checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const action: ApproveFixPlanAction = {
    actionId: decisionId,
    kind: 'approve_fix_plan',
    planVersion: fixPlan.planVersion,
    strategyDigest: fixPlan.strategyDigest,
    diagnosisEvidenceRefs: completeEvidenceRefs,
    checkSetDigest: validBaseline.checkSetDigest,
  };
  const actionDigest = computeCanonicalSha256(action);

  const criteriaDigest = computeCanonicalSha256(validState.acceptanceCriteria);

  const binding: ApprovalBinding = {
    decisionId,
    actionKind: 'fix_plan',
    normalizedActionDigest: actionDigest,
    taskId: validState.taskId,
    workspaceId: validState.workspaceId,
    repositoryRevisionDigest: validState.repositoryRevisionDigest,
    policyId,
    policyVersion,
    planVersion: fixPlan.planVersion,
    strategyDigest: fixPlan.strategyDigest,
    baselineRef: validBaseline.evidenceId,
    evidenceRefs: completeEvidenceRefs,
    criteriaDigest,
    checkSetDigest: validBaseline.checkSetDigest,
    status: 'pending',
    reason: 'Fix plan requires human review and explicit approval',
  };

  let decision: ApprovalBinding;
  try {
    decision = await ports.approval.requestDecision(binding);
  } catch (err: unknown) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `Approval request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return finishPlanApproval({
    ports,
    validBaselineCandidate,
    validBaseline,
    validState,
    fixPlan,
    persistedAwaitPlanState,
    decision,
    binding,
    decisionId,
    actionDigest,
    criteriaDigest,
    completeEvidenceRefs,
    updatedEvidenceRefs,
    policyId,
    policyVersion,
  });
}
