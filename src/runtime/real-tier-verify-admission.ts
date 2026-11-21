/**
 * The approved-plan (`Verify`) check admission for the real tier.
 *
 * It binds the current owner head, the approved plan decision and plan binding digest, the current
 * revision and the exact pinned check, and issues a UC-05 receipt for exactly one `run_command` in
 * exactly the manager's measured read-only view. `Repair` re-checks are the same action shape on a
 * new revision, so they resolve through this branch too. Everything it reads is owner state; the
 * receipt is issued by the production UC-05 evaluator (`evaluatePolicyV02`).
 */
import { evaluatePolicyV02, type PolicyFactsV02 } from '../approvals/policy.ts';
import { computeActionDigest, computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import type { BugTask, TaskState } from '../contracts/foundation/uc03.ts';
import { admissionCommandView } from '../foundation/repository-admission.ts';
import type { DurableStatePortV02 } from '../persistence/adapters/state-port-v02.ts';
import type { TrustedHostExpectedContext } from '../uc03/investigation-types.ts';
import { currentAuthority, policyFacts } from './real-tier-admissions.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import { executionProfileOf } from './real-tier-execution-profile.ts';

type CheckRequest = Parameters<NonNullable<TrustedHostExpectedContext['admissionContextForCheck']>>[0];
type CheckAdmission = Awaited<ReturnType<NonNullable<TrustedHostExpectedContext['admissionContextForCheck']>>>;

/** The plan binding digest `graph-validation.ts` and the UC-05 evaluator both compute for this plan. */
export function approvedPlanBindingDigest(task: BugTask, state: TaskState, decisionRef: string): string | undefined {
  const plan = state.plan;
  if (!plan || plan.decisionRef !== decisionRef) return undefined;
  return computeCanonicalSha256({
    taskId: state.taskId,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: plan.checkSetDigest,
    decisionRef,
  });
}

export async function verifyCheckAdmission(
  task: BugTask,
  policyFor: (facts: PolicyFactsV02) => unknown,
  assembly: RealTierAssembly,
  port: DurableStatePortV02,
  { check, action, currentState: state }: CheckRequest,
): Promise<CheckAdmission> {
  if (state.taskId !== task.taskId || (state.node !== 'Verify' && state.node !== 'Repair') || action.kind !== 'run_command') return undefined;
  const plan = state.plan;
  const decisionRef = plan?.decisionRef;
  const planBindingDigest = decisionRef === undefined ? undefined : approvedPlanBindingDigest(task, state, decisionRef);
  if (!plan || !decisionRef || !planBindingDigest) return undefined;
  const pinned = task.requiredChecks.find(candidate => computeCanonicalSha256(candidate) === computeCanonicalSha256(check));
  const testPath = pinned?.argv.find(arg => arg.startsWith('tests/') && arg.endsWith('.py'));
  if (
    !pinned ||
    !testPath ||
    action.purpose !== pinned.purpose ||
    action.executable !== pinned.executable ||
    action.workingDirectory !== (pinned.workingDirectory ?? '.') ||
    computeCanonicalSha256(action.argv) !== computeCanonicalSha256(pinned.argv)
  )
    return undefined;
  const owner = await currentAuthority(port, state);
  if (!owner) return undefined;
  const manager = assembly.workspaceManager;
  const executorIdentity = () => ({
    adapterIdentity: assembly.executor.getAdapterIdentity(),
    processIncarnation: assembly.executor.getProcessIncarnation(),
    fencingGeneration: assembly.executor.getFencingGeneration(),
  });
  const executor = executorIdentity();
  if (!executor.adapterIdentity || !executor.processIncarnation || executor.fencingGeneration !== manager.getFencingGeneration(state.workspaceId)) return undefined;
  const isolationProfileRef = assembly.profile.image.label;
  const { view } = await manager.admitMeasuredCommandView({ workspaceId: state.workspaceId, expectedRevisionDigest: state.repositoryRevisionDigest, requiredFiles: [testPath] });
  const issued = await manager.admitMeasuredCommandView({
    workspaceId: state.workspaceId,
    expectedRevisionDigest: state.repositoryRevisionDigest,
    requiredFiles: [testPath],
    trustedIsolationProfileRef: isolationProfileRef,
    ownerView: {
      canonicalRevision: view.canonicalRevisionDigest,
      exclusionsPolicyVersion: view.exclusionsPolicyVersion,
      scratchIdentity: view.scratchIdentity,
      admittedFiles: view.admittedFiles,
      mountedReadOnly: true,
      isolationProfileRef,
    },
  });
  if (!issued.measured) return undefined;
  const ownerIdentity = owner.policyIdentity;
  const criteriaDigest = computeCanonicalSha256(task.acceptanceCriteria);
  // The approved plan, as the evaluator's `approvedPlanIsCurrent` re-reads it from the recorded facts.
  const binding = {
    decisionId: plan.decisionRef,
    actionKind: 'fix_plan' as const,
    normalizedActionDigest: computeCanonicalSha256({
      actionId: plan.decisionRef,
      kind: 'approve_fix_plan',
      planVersion: plan.planVersion,
      strategyDigest: plan.strategyDigest,
      diagnosisEvidenceRefs: plan.evidenceRefs,
      checkSetDigest: plan.checkSetDigest,
    }),
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    policyId: ownerIdentity.policyId,
    policyVersion: ownerIdentity.policyVersion,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef: plan.baselineRef,
    evidenceRefs: [...plan.evidenceRefs],
    criteriaDigest,
    checkSetDigest: plan.checkSetDigest,
    status: 'approved' as const,
  };
  const facts: PolicyFactsV02 = {
    ...policyFacts(task, state, owner, check.purpose),
    registeredActionDigest: computeActionDigest(action),
    plan: {
      binding,
      context: {
        currentTaskId: state.taskId,
        currentWorkspaceId: state.workspaceId,
        currentRepositoryRevisionDigest: state.repositoryRevisionDigest,
        currentPolicyId: ownerIdentity.policyId,
        currentPolicyVersion: ownerIdentity.policyVersion,
        currentNormalizedActionDigest: binding.normalizedActionDigest,
        currentPlanVersion: plan.planVersion,
        currentStrategyDigest: plan.strategyDigest,
        currentBaselineRef: plan.baselineRef,
        currentEvidenceRefs: [...plan.evidenceRefs],
        currentCriteriaDigest: criteriaDigest,
        currentCheckSetDigest: plan.checkSetDigest,
      },
      materialChange: false,
      replanSlot: null,
    },
    planApplicability: 'approved-plan',
    diagnosticPurpose: null,
    taskCriteriaDigest: null,
    planBindingDigest,
    planDecisionRef: plan.decisionRef,
    testPath: null,
    checkId: null,
    command: {
      executableRef: action.executable,
      resolvedExecutable: action.executable,
      workingDirectoryRef: 'repository-root',
      workingDirectory: action.workingDirectory,
      constrainedCapability: 'constrained-tests',
    },
  };
  const result = evaluatePolicyV02(policyFor(facts), action, facts, {
    decisionAuthorityGeneration: owner.decisionAuthorityGeneration,
    planApplicability: 'approved-plan',
    planBindingDigest,
    planDecisionRef: plan.decisionRef,
  });
  if (
    !result.ok ||
    result.receipt.result !== 'ALLOWED' ||
    computeCanonicalSha256((await currentAuthority(port, state)) ?? null) !== computeCanonicalSha256(owner) ||
    computeCanonicalSha256(executorIdentity()) !== computeCanonicalSha256(executor)
  )
    return undefined;
  const profile = executionProfileOf(task, isolationProfileRef, state);
  const { receipt } = result;
  // Foundation's receipt wire shape omits UC-05's schema tag and hashes that exact body.
  const evaluationBody = {
    receiptId: receipt.receiptId,
    actionDigest: receipt.actionDigest,
    freshnessContextDigest: receipt.freshnessContextDigest,
    policyId: receipt.policyId,
    policyVersion: receipt.policyVersion,
    configId: receipt.configId,
    configVersion: receipt.configVersion,
    decisionAuthorityGeneration: receipt.decisionAuthorityGeneration,
    result: receipt.result,
  };
  return {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    taskStateSchemaVersion: '0.2.0',
    controlSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    expectedControlVersion: owner.controlVersion,
    expectedEpoch: owner.epoch,
    taskId: state.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: state.repositoryId,
    runnableNode: state.node,
    canonicalRevision: state.repositoryRevisionDigest,
    executionProfileId: isolationProfileRef,
    action,
    actionDigest: computeActionDigest(action),
    policyAuthorityRef: { ...ownerIdentity, decisionAuthorityGeneration: owner.decisionAuthorityGeneration },
    policyEvaluationReceipt: { ...evaluationBody, receiptDigest: computeCanonicalSha256(evaluationBody) },
    commandView: admissionCommandView(issued.view, issued.measured),
    finiteBounds: { ...profile.commandBounds, isolationProfileRef },
    reservationRefs: (['task', 'run'] as const).flatMap(scope =>
      ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].map(kind => `${scope}-${kind}-${action.actionId}`),
    ),
    planBindingDigest,
    planDecisionRef: plan.decisionRef,
    checkSetDigest: plan.checkSetDigest,
    checkId: check.checkId,
  };
}
