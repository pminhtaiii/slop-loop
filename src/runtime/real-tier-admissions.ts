/** Task-bound Investigate admissions. UC-05 issues receipts; the workspace manager measures views. */
import { randomUUID } from 'node:crypto';
import { evaluatePolicyV02, evaluateProviderAdmissionV02, type PolicyFactsV02 } from '../approvals/policy.ts';
import { computeActionDigest, computeCanonicalSha256, computeCheckSetDigest, computeRequestContentDigest } from '../contracts/foundation/uc03.ts';
import type { BugTask, ProviderAdmissionContextV02, ProviderAdmissionTrustedContextV02, ProviderRequest, TaskState, VerificationAuthoritySnapshotV02 } from '../contracts/foundation/uc03.ts';
import { normalizePytestSelector } from '../contracts/foundation/uc03/pytest-selector.ts';
import { computeContextDigest } from '../foundation/model.ts';
import { microUsd } from '../foundation/deepseek-transport-request.ts';
import { admissionCommandView } from '../foundation/repository-admission.ts';
import { DEFAULT_POLICY_PROFILE } from '../persistence/adapters/approval-types.ts';
import type { DurableStatePortV02 } from '../persistence/adapters/state-port-v02.ts';
import type { UC03CoderAdmissionResolver } from '../uc03/graph-types.ts';
import type { TrustedHostExpectedContext } from '../uc03/investigation-types.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import { executionProfileOf } from './real-tier-execution-profile.ts';
import { verifyCheckAdmission } from './real-tier-verify-admission.ts';
import { approvedPlanCoderAdmission } from './real-tier-coder-admission.ts';

interface Admissions {
  readonly admissionContextForCheck: NonNullable<TrustedHostExpectedContext['admissionContextForCheck']>;
  readonly coderAdmission: UC03CoderAdmissionResolver;
  /** The approved-plan (`Verify`) check admission; `Repair` re-checks resolve through the Verify branch. */
  readonly admissionContextForVerifyCheck: NonNullable<TrustedHostExpectedContext['admissionContextForCheck']>;
}

/** Bind only to current, runnable, idle owner authority and the same journal/state head. */
export async function currentAuthority(port: DurableStatePortV02, state: TaskState): Promise<VerificationAuthoritySnapshotV02 | undefined> {
  const owner = await port.readVerificationAuthoritySnapshot(state.taskId);
  if (!owner || owner.controlMode !== 'runnable' || owner.activeClaimId || owner.holdRef) return undefined;
  const journal = port.getJournalSnapshot(state.taskId) as { readonly controlVersion?: unknown; readonly epoch?: unknown } | null;
  const current = await port.loadTask(state.taskId);
  if (
    !current ||
    current.stateVersion !== state.stateVersion ||
    current.runId !== state.runId ||
    current.node !== state.node ||
    current.workspaceId !== state.workspaceId ||
    current.repositoryId !== state.repositoryId ||
    current.repositoryRevisionDigest !== state.repositoryRevisionDigest ||
    owner.runId !== state.runId ||
    owner.stateVersion !== state.stateVersion ||
    owner.repositoryRevisionDigest !== state.repositoryRevisionDigest ||
    journal?.controlVersion !== owner.controlVersion ||
    journal.epoch !== owner.epoch
  )
    return undefined;
  return owner;
}

export function pinnedTestPath(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (!arg.startsWith('tests/')) continue;
    const selector = normalizePytestSelector(arg);
    if (selector?.filePath.endsWith('.py')) return selector.filePath;
  }
  return undefined;
}

export function policyFacts(task: BugTask, state: TaskState, owner: VerificationAuthoritySnapshotV02, purpose: string): PolicyFactsV02 {
  const { policyId, policyVersion, configId, configVersion } = owner.policyIdentity;
  return {
    taskId: state.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: state.repositoryId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    taskStateVersion: state.stateVersion,
    taskNode: state.node,
    policyIdentity: { policyId, policyVersion, configId, configVersion },
    registeredActionDigest: computeCanonicalSha256({ taskId: state.taskId, stateVersion: state.stateVersion, purpose }),
    continuationRef: `investigate-${state.stateVersion}`,
    role: 'coder',
    // These admissions expose no mutation, grading, or arbitrary command capability. Commands must
    // additionally match the pinned check and execute only in the manager's filtered read-only view.
    safety: { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true },
    patch: null,
    command: null,
    plan: null,
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: purpose,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    testPath: pinnedTestPath(task.requiredChecks.flatMap(check => check.argv)) ?? null,
    checkId: task.requiredChecks[0]?.checkId ?? null,
    planBindingDigest: null,
    planDecisionRef: null,
    providerRequest: null,
  };
}

/** No Verify/approved-plan authority is issued here. Recheck freshness after every owner/view await. */
export function createRealTierAdmissions(assembly: RealTierAssembly, boundTask: BugTask, port: DurableStatePortV02): Admissions {
  const task = structuredClone(boundTask);
  const policyFor = (facts: PolicyFactsV02) => ({
    ...DEFAULT_POLICY_PROFILE,
    profileVersion: assembly.profile.approvalPolicy.profileVersion,
    policyIdentity: facts.policyIdentity,
    commandRules: task.requiredChecks.map(check => ({
      ruleId: check.checkId,
      executableRef: check.executable,
      argvPrefix: [...check.argv],
      workingDirectoryRef: 'repository-root',
      timeoutMs: check.timeoutMs,
      maxOutputBytes: check.maxOutputBytes,
    })),
  });
  return {
    admissionContextForVerifyCheck: ({ check, action, currentState }) => verifyCheckAdmission(task, policyFor, assembly, port, { check, action, currentState }),
    admissionContextForCheck: async ({ check, action, currentState: state }) => {
      if (state.taskId !== task.taskId || state.node !== 'Investigate' || action.kind !== 'run_command') return undefined;
      const pinned = task.requiredChecks.find(candidate => computeCanonicalSha256(candidate) === computeCanonicalSha256(check));
      const testPath = pinned && pinnedTestPath(pinned.argv);
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
      const facts: PolicyFactsV02 = {
        ...policyFacts(task, state, owner, check.purpose),
        registeredActionDigest: computeActionDigest(action),
        testPath,
        checkId: check.checkId,
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
        planApplicability: 'pre-plan-diagnostic',
        diagnosticPurpose: check.purpose,
        taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
      });
      if (
        !result.ok ||
        result.receipt.result !== 'ALLOWED' ||
        computeCanonicalSha256((await currentAuthority(port, state)) ?? null) !== computeCanonicalSha256(owner) ||
        computeCanonicalSha256(executorIdentity()) !== computeCanonicalSha256(executor)
      )
        return undefined;
      const profile = executionProfileOf(task, isolationProfileRef, state);
      // Foundation's repository envelope omits the UC-05 schema marker and hashes that projection.
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
      const policyEvaluationReceipt = { ...evaluationBody, receiptDigest: computeCanonicalSha256(evaluationBody) };
      return {
        schemaVersion: '0.2.0',
        subjectKind: 'repository-action',
        planApplicability: 'pre-plan-diagnostic',
        taskStateSchemaVersion: '0.2.0',
        controlSchemaVersion: '0.2.0',
        expectedTaskStateVersion: state.stateVersion,
        expectedControlVersion: owner.controlVersion,
        expectedEpoch: owner.epoch,
        taskId: state.taskId,
        runId: state.runId,
        workspaceId: state.workspaceId,
        repositoryId: state.repositoryId,
        runnableNode: 'Investigate',
        canonicalRevision: state.repositoryRevisionDigest,
        executionProfileId: isolationProfileRef,
        action,
        actionDigest: computeActionDigest(action),
        policyAuthorityRef: { ...owner.policyIdentity, decisionAuthorityGeneration: owner.decisionAuthorityGeneration },
        policyEvaluationReceipt,
        commandView: admissionCommandView(issued.view, issued.measured),
        finiteBounds: { ...profile.commandBounds, isolationProfileRef },
        reservationRefs: (['task', 'run'] as const).flatMap(scope =>
          ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].map(kind => `${scope}-${kind}-${action.actionId}`),
        ),
        diagnosticPurpose: check.purpose,
        taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
        checkSetDigest: computeCheckSetDigest(task.requiredChecks),
        checkId: check.checkId,
        testPath,
      };
    },
    coderAdmission: async ({ task: requestedTask, state, purpose, evidence }) => {
      if (computeCanonicalSha256(requestedTask) !== computeCanonicalSha256(task)) return undefined;
      // Once the plan is approved the coder still needs an owner admission to propose its patch.
      if (purpose !== 'propose-plan') return approvedPlanCoderAdmission(assembly, task, port, { task, state, purpose, evidence });
      if (state.taskId !== task.taskId || state.node !== 'Investigate') return undefined;
      const owner = await currentAuthority(port, state);
      if (!owner) return undefined;
      const { limits, pricing, runLimits } = assembly.profile;
      const current = await port.loadTask(state.taskId);
      if (!current?.budgetLedgers) return undefined;
      const remainingCost = Math.min(
        ...current.budgetLedgers.filter(ledger => ledger.kind === 'cost').map(ledger => ledger.limit - ledger.consumed - ledger.reservations.reduce((sum, reservation) => sum + reservation.amount, 0)),
      );
      // The transport charges pending calls at their maxima and replaces those charges on settlement.
      const usage = assembly.runUsageCountersFor(state.taskId, state.runId);
      const maxInputTokens = Math.min(limits.inputTokensPerRequest, runLimits.perRunInputTokens - (usage?.inputTokensCharged ?? 0), task.budgetLimits.maxTokens);
      const maxOutputTokens = Math.min(limits.outputTokensPerRequest, runLimits.perRunOutputTokens - (usage?.outputTokensCharged ?? 0), task.budgetLimits.maxTokens);
      if (maxInputTokens <= 0 || maxOutputTokens <= 0) return undefined;
      const maxBillableTokens = maxInputTokens + maxOutputTokens;
      const maxCostUsd = Math.min(remainingCost, task.budgetLimits.maxCostUsd, microUsd(pricing, maxInputTokens, maxOutputTokens, maxInputTokens) / 1_000_000);
      const providerRequestId = `coder-${randomUUID()}`;
      const request: ProviderRequest = {
        providerRequestId,
        taskId: state.taskId,
        runId: state.runId,
        role: 'coder',
        purpose,
        ...assembly.providerIdentity,
        configId: owner.policyIdentity.configId,
        pricingPolicyId: owner.policyIdentity.policyId,
        contextDigest: computeContextDigest(state, evidence),
        timeoutMs: limits.providerTimeoutMs,
        maxInputTokens,
        maxOutputTokens,
        maxBillableTokens,
        maxCostUsd,
        reservationRef: `res-${providerRequestId}`,
        dispatchState: 'reserved',
      };
      const facts: PolicyFactsV02 = { ...policyFacts(task, state, owner, purpose), providerRequest: request };
      const result = evaluateProviderAdmissionV02(policyFor(facts), request, facts, {
        decisionAuthorityGeneration: owner.decisionAuthorityGeneration,
        role: 'coder',
        planApplicability: 'pre-plan-diagnostic',
        diagnosticPurpose: purpose,
        taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
      });
      if (!result.ok || computeCanonicalSha256((await currentAuthority(port, state)) ?? null) !== computeCanonicalSha256(owner)) return undefined;
      const providerIdentity = {
        ...assembly.providerIdentity,
        configId: owner.policyIdentity.configId,
        configVersion: owner.policyIdentity.configVersion,
        pricingPolicyId: owner.policyIdentity.policyId,
        pricingPolicyVersion: owner.policyIdentity.policyVersion,
        issuerKeyRef: owner.policyIdentity.issuerKeyRef,
        decisionAuthorityGeneration: owner.decisionAuthorityGeneration,
      };
      const common = {
        subjectKind: 'provider-request' as const,
        taskStateSchemaVersion: '0.2.0',
        controlSchemaVersion: '0.2.0',
        expectedTaskStateVersion: state.stateVersion,
        expectedControlVersion: owner.controlVersion,
        expectedEpoch: owner.epoch,
        taskId: state.taskId,
        runId: state.runId,
        runnableNode: state.node,
        planApplicability: 'pre-plan-diagnostic' as const,
        diagnosticPurpose: purpose,
        taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
        role: 'coder' as const,
        providerRequestId,
        requestContentDigest: computeRequestContentDigest(request),
        providerIdentity,
        requestReservationReceipt: request.reservationRef,
        budgetRefs: ['task-tokens', 'task-cost', 'run-tokens', 'run-cost'].map(kind => `${kind}-${providerRequestId}`),
      };
      const finiteBounds = { maxInputTokens, maxOutputTokens, maxBillableTokens, maxCostUsd };
      const receipt = result.receipt;
      // Preserve the UC-05 issuer's digest; the foundation provider envelope carries its identity projection.
      const providerAdmissionReceipt = {
        receiptId: receipt.receiptId,
        receiptDigest: receipt.receiptDigest,
        providerRequestId,
        role: receipt.role,
        requestContentDigest: receipt.requestContentDigest,
        ...assembly.providerIdentity,
        configId: receipt.configId,
        configVersion: receipt.configVersion,
        decisionAuthorityGeneration: receipt.decisionAuthorityGeneration,
      };
      const context: ProviderAdmissionContextV02 = { ...common, schemaVersion: '0.2.0', providerRequest: request, providerAdmissionReceipt, finiteBounds };
      const trustedContext: ProviderAdmissionTrustedContextV02 = {
        ...common,
        providerAdmissionReceiptRef: result.receipt.receiptId,
        providerAdmissionReceiptDigest: result.receipt.receiptDigest,
        requestLimits: { timeoutMs: request.timeoutMs, ...finiteBounds },
      };
      return { request, context, trustedContext };
    },
  };
}
