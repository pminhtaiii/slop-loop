import {
  computeCanonicalSha256,
  parseApprovalBinding,
  validateApprovalBinding,
  validateStateTransition,
} from '../contracts/foundation/uc03.ts';
import type {
  ApprovalBinding,
  ApprovalBindingContext,
  Baseline,
  FixPlan,
  TaskState,
} from '../contracts/foundation/uc03.ts';
import { validateHostSnapshotFacts } from './investigation-snapshot.ts';
import type { HostSnapshotValidationResult } from './investigation-snapshot.ts';
import type {
  BaselineEvidenceCandidate,
  InvestigationConfigPort,
  InvestigationPorts,
  PlanPreparationResult,
  TrustedHostPort,
  TrustedHostSnapshot,
} from './investigation-types.ts';

export interface PlanApprovalContinuation {
  readonly ports: InvestigationPorts;
  readonly validBaselineCandidate: BaselineEvidenceCandidate;
  readonly validBaseline: Baseline;
  readonly validState: TaskState;
  readonly fixPlan: FixPlan;
  readonly persistedAwaitPlanState: TaskState;
  readonly decision: ApprovalBinding;
  readonly binding: ApprovalBinding;
  readonly decisionId: string;
  readonly actionDigest: string;
  readonly criteriaDigest: string;
  readonly completeEvidenceRefs: readonly string[];
  readonly updatedEvidenceRefs: readonly string[];
  readonly policyId: string;
  readonly policyVersion: string;
}

export async function finishPlanApproval(input: PlanApprovalContinuation): Promise<PlanPreparationResult> {
  const {
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
  } = input;
  if (!ports.state || typeof ports.state.loadTask !== 'function') {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'Missing StatePort loadTask capability: cannot reload authoritative state after approval await',
    };
  }

  let reloadedState: TaskState | null = null;
  try {
    reloadedState = await ports.state.loadTask(validState.taskId);
  } catch (err: unknown) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `Authoritative StatePort reload failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!reloadedState) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'Authoritative state missing from StatePort after approval await',
    };
  }

  if (reloadedState.stateVersion !== persistedAwaitPlanState.stateVersion) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State CAS version drift detected while awaiting approval: expected version ${persistedAwaitPlanState.stateVersion}, observed ${reloadedState.stateVersion}`,
    };
  }

  if (reloadedState.node !== 'AwaitPlan') {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State node drift detected while awaiting approval: expected 'AwaitPlan', observed '${reloadedState.node}'`,
    };
  }

  if (reloadedState.activeDecisionId !== decisionId) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State active decision ID drift detected while awaiting approval: expected '${decisionId}', observed '${reloadedState.activeDecisionId}'`,
    };
  }

  if (reloadedState.repositoryRevisionDigest !== persistedAwaitPlanState.repositoryRevisionDigest) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State repository revision drift detected while awaiting approval: expected '${persistedAwaitPlanState.repositoryRevisionDigest}', observed '${reloadedState.repositoryRevisionDigest}'`,
    };
  }

  if (reloadedState.workspaceId !== validState.workspaceId) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State workspace ID drift detected while awaiting approval: expected '${validState.workspaceId}', observed '${reloadedState.workspaceId}'`,
    };
  }

  if (reloadedState.repositoryId !== validState.repositoryId) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State repository ID drift detected while awaiting approval: expected '${validState.repositoryId}', observed '${reloadedState.repositoryId}'`,
    };
  }

  if (computeCanonicalSha256(reloadedState.acceptanceCriteria) !== criteriaDigest) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'State acceptance criteria drift detected while awaiting approval',
    };
  }

  if (reloadedState.plan?.strategyDigest !== fixPlan.strategyDigest) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'State plan strategy digest drift detected while awaiting approval',
    };
  }

  if (reloadedState.plan?.baselineRef !== validBaseline.evidenceId) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'State plan baseline reference drift detected while awaiting approval',
    };
  }

  if (
    !Array.isArray(reloadedState.plan?.evidenceRefs) ||
    computeCanonicalSha256(reloadedState.plan.evidenceRefs) !== computeCanonicalSha256(completeEvidenceRefs)
  ) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'State plan evidence references drift detected while awaiting approval',
    };
  }

  if (
    !Array.isArray(reloadedState.evidenceRefs) ||
    computeCanonicalSha256(reloadedState.evidenceRefs) !== computeCanonicalSha256(updatedEvidenceRefs)
  ) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'State evidence references drift detected while awaiting approval',
    };
  }

  let revalidatedSnapshotValidation: HostSnapshotValidationResult | null = null;
  const hostPort = ports.host ?? (ports as { hostAuthority?: TrustedHostPort }).hostAuthority;
  if (hostPort && typeof hostPort.loadSnapshot === 'function') {
    let hostSnapshot: TrustedHostSnapshot;
    try {
      hostSnapshot = await hostPort.loadSnapshot({
        taskId: reloadedState.taskId,
        workspaceId: reloadedState.workspaceId,
        repositoryId: reloadedState.repositoryId,
        expectedRevisionDigest: reloadedState.repositoryRevisionDigest,
        expectedCriteriaDigest: criteriaDigest,
        expectedCheckSetDigest: validBaseline.checkSetDigest,
        expectedTestFiles: validBaselineCandidate.expectedTestFiles,
      });
    } catch (err: unknown) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: `Host snapshot reload failed after approval await: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const snapshotValidation = validateHostSnapshotFacts(
      hostSnapshot,
      {
        taskId: reloadedState.taskId,
        workspaceId: reloadedState.workspaceId,
        repositoryId: reloadedState.repositoryId,
        revisionDigest: reloadedState.repositoryRevisionDigest,
        criteriaDigest: criteriaDigest,
        checkSetDigest: validBaseline.checkSetDigest,
        expectedTestFiles: validBaselineCandidate.expectedTestFiles,
      },
      validBaselineCandidate.requiredChecks
    );
    if (!snapshotValidation.ok) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: snapshotValidation.reason ?? 'Host snapshot validation failed after approval await',
      };
    }

    if (snapshotValidation.testProtectionDigest !== validBaseline.testProtectionDigest) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: 'Host protected test files drift detected while awaiting approval',
      };
    }

    revalidatedSnapshotValidation = snapshotValidation;
  }

  let reloadedPolicyId = policyId;
  let reloadedPolicyVersion = policyVersion;
  const configPort = ports.config ?? (ports as { configPort?: InvestigationConfigPort }).configPort;
  if (configPort && typeof configPort.loadConfig === 'function') {
    let loadedConfig: { readonly configId?: string; readonly configVersion?: string } | null = null;
    try {
      loadedConfig = await configPort.loadConfig(reloadedState.taskId);
    } catch (err: unknown) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: `Config port reload failed after approval await: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!loadedConfig || !loadedConfig.configId || !loadedConfig.configVersion) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: 'Config port returned missing or incomplete config after approval await',
      };
    }

    if (loadedConfig.configId !== policyId || loadedConfig.configVersion !== policyVersion) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: `Config drift detected while awaiting approval: expected ${policyId}@${policyVersion}, observed ${loadedConfig.configId}@${loadedConfig.configVersion}`,
      };
    }
    reloadedPolicyId = loadedConfig.configId;
    reloadedPolicyVersion = loadedConfig.configVersion;
  } else if (reloadedState.taskContext?.configId && reloadedState.taskContext?.configVersion) {
    if (
      reloadedState.taskContext.configId !== policyId ||
      reloadedState.taskContext.configVersion !== policyVersion
    ) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: `State taskContext config drift detected while awaiting approval: expected ${policyId}@${policyVersion}, observed ${reloadedState.taskContext.configId}@${reloadedState.taskContext.configVersion}`,
      };
    }
    reloadedPolicyId = reloadedState.taskContext.configId;
    reloadedPolicyVersion = reloadedState.taskContext.configVersion;
  }

  const freshnessContext: ApprovalBindingContext = {
    currentTaskId: reloadedState.taskId,
    currentWorkspaceId: reloadedState.workspaceId,
    currentRepositoryRevisionDigest: reloadedState.repositoryRevisionDigest,
    currentPolicyId: reloadedPolicyId,
    currentPolicyVersion: reloadedPolicyVersion,
    currentNormalizedActionDigest: actionDigest,
    currentPlanVersion: fixPlan.planVersion,
    currentStrategyDigest: fixPlan.strategyDigest,
    currentBaselineRef: validBaseline.evidenceId,
    currentEvidenceRefs: completeEvidenceRefs,
    currentCriteriaDigest: criteriaDigest,
    currentCheckSetDigest: validBaseline.checkSetDigest,
  };

  const bindingValidation = parseApprovalBinding(decision, freshnessContext);
  if (!bindingValidation.ok) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      binding: decision,
      state: persistedAwaitPlanState,
      reason: `Approval binding validation failed: ${bindingValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }

  if (decision.decisionId !== binding.decisionId) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      binding: decision,
      state: persistedAwaitPlanState,
      reason: `Approval decisionId mismatch: expected '${binding.decisionId}', got '${decision.decisionId}'`,
    };
  }

  if (decision.actionKind !== 'fix_plan') {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      binding: decision,
      state: persistedAwaitPlanState,
      reason: `Approval actionKind mismatch: expected 'fix_plan', got '${decision.actionKind}'`,
    };
  }

  if (decision.status === 'stale') {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      binding: decision,
      state: persistedAwaitPlanState,
      reason: decision.reason ?? 'Approval binding is stale',
    };
  }

  if (decision.status === 'pending') {
    return {
      outcome: 'pending',
      plan: fixPlan,
      binding: decision,
      state: persistedAwaitPlanState,
      reason: decision.reason ?? 'Fix plan approval pending; paused at AwaitPlan',
    };
  }

  if (decision.status === 'rejected') {
    const awaitFeedbackCandidate: TaskState = {
      ...persistedAwaitPlanState,
      stateVersion: persistedAwaitPlanState.stateVersion + 1,
      node: 'AwaitFeedback',
      nextAction: 'await-feedback',
      ...(persistedAwaitPlanState.budgetLedgers !== undefined
        ? { budgetLedgers: persistedAwaitPlanState.budgetLedgers }
        : { budgetLedgers: [] }),
    };

    const feedbackTransitionVal = validateStateTransition(
      persistedAwaitPlanState,
      awaitFeedbackCandidate
    );
    if (!feedbackTransitionVal.ok) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: `State transition to AwaitFeedback failed: ${feedbackTransitionVal.errors.map((e) => e.message).join(', ')}`,
      };
    }

    let finalFeedbackState: TaskState;
    try {
      finalFeedbackState = await ports.state.transition(
        awaitFeedbackCandidate,
        persistedAwaitPlanState.stateVersion
      );
      await ports.state.checkpoint(finalFeedbackState);
    } catch (err: unknown) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: `Failed transitioning to AwaitFeedback: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      outcome: 'rejected',
      plan: fixPlan,
      binding: decision,
      state: finalFeedbackState,
      reason: decision.reason ?? 'Fix plan was rejected during review',
    };
  }

  if (decision.status === 'approved') {
    if (!revalidatedSnapshotValidation) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: 'Missing HostPort loadSnapshot capability: fresh host snapshot revalidation is required before Patch transition',
      };
    }

    const admission = validateApprovalBinding(decision, freshnessContext);
    if (!admission.ok) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: `Approval binding freshness validation failed: ${admission.errors.map((e) => e.message).join(', ')}`,
      };
    }

    const patchCandidate: TaskState = {
      ...persistedAwaitPlanState,
      stateVersion: persistedAwaitPlanState.stateVersion + 1,
      node: 'Patch',
      nextAction: 'apply-patch',
      plan: fixPlan,
      planVersion: fixPlan.planVersion,
      activeDecisionId: decision.decisionId,
      evidenceRefs: updatedEvidenceRefs,
      ...(persistedAwaitPlanState.budgetLedgers !== undefined
        ? { budgetLedgers: persistedAwaitPlanState.budgetLedgers }
        : { budgetLedgers: [] }),
    };

    const patchTransitionVal = validateStateTransition(
      persistedAwaitPlanState,
      patchCandidate,
      {
        trusted: {
          approval: {
            binding: decision,
            freshness: freshnessContext,
          },
        },
      }
    );
    if (!patchTransitionVal.ok) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: `State transition to Patch failed: ${patchTransitionVal.errors.map((e) => e.message).join(', ')}`,
      };
    }

    let finalPatchState: TaskState;
    try {
      finalPatchState = await ports.state.transition(
        patchCandidate,
        persistedAwaitPlanState.stateVersion
      );
      await ports.state.checkpoint(finalPatchState);
    } catch (err: unknown) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: `StatePort transition/checkpoint to Patch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      outcome: 'approved',
      plan: fixPlan,
      binding: decision,
      state: finalPatchState,
    };
  }

  return {
    outcome: 'rejected',
    plan: fixPlan,
    binding: decision,
    state: persistedAwaitPlanState,
    reason: `Unexpected approval status: ${(decision as { status?: unknown }).status}`,
  };
}
