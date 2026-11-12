import assert from 'node:assert/strict';
import type {
  NormalizedAction,
  ProviderPricingIdentityV02,
  ProviderRequest,
  RepositoryExecutionReceiptV02,
  RepositoryPortV02,
  ReviewFinding,
  StateTransitionOptions,
  TaskState,
} from '../../../../src/contracts/foundation/uc03.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceCandidate } from '../../../../src/uc03/investigation-types.ts';
import { computeCanonicalSha256, computeCheckSetDigest, computeRequestContentDigest } from '../../../../src/contracts/foundation/uc03.ts';
import { createFixtureExecutorIdentityV02, createFixtureProviderAdmissionReceiptV02 } from './port-fixtures.ts';
import { createGraphTaskState, seedGraphTaskState } from './graph-fixtures.ts';
import {
  createTestProviderAdmissionContextV02,
  createTestProviderAdmissionTrustedContextV02,
  createTestProviderRequest,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
} from './state-fixtures.ts';
import { createPendingApprovalRoute, ROUTE_PLAN_DETAILS } from './controlled-route.ts';
import { HostModelPortV02 } from '../../../../src/foundation/model-v02.ts';
import type { HostModelTransport } from '../../../../src/foundation/model.ts';
import { computeContextDigest } from '../../../../src/foundation/model.ts';
import { createGuardedReadCapability, type GuardedReadControlObservation } from '../../../../src/foundation/guarded-read-capability.ts';
import { createBaselineEvidenceAdapter } from '../../../../src/runtime/baseline-evidence-adapter.ts';
import { prepareControlledUC03Host } from '../../../../src/runtime/uc03-host-bootstrap.ts';
import { createCoderAgentV02 } from '../../../../src/uc03/agent.ts';
import { runControlledUC03GraphV02 } from '../../../../src/uc03/graph-v02.ts';
import { currentPlanBindingDigest } from '../../../../src/uc03/graph-validation.ts';
import { reviewerContextDigest } from '../../../../src/foundation/reviewer.ts';
import { computeTestProtectionDigest, type TrustedHostPort } from '../../../../src/uc03/investigation.ts';
import type { UC03GraphConfigV02, UC03GraphPortsV02, UC03ProductionExecutionGuardV02 } from '../../../../src/uc03/graph-types-v02.ts';
import { controlledHostFixture } from './host-pipeline-fixtures.ts';
import { createFixtureBugTask } from './port-fixtures.ts';

const USAGE = { inputTokens: 1, outputTokens: 1, billableTokens: 2, costUsd: 0.001 };
const BUDGET = { maxModelCalls: 4, maxActiveMs: 60_000, maxRepairs: 1, maxReplans: 1 };
let controlledFixtureSequence = 0;
const PATCH_DIFF = [
  '--- a/src/calculator.py',
  '+++ b/src/calculator.py',
  '@@ -1,1 +1,3 @@',
  '-def divide(a, b): return a / b',
  '+def divide(a, b):',
  '+    if b == 0: raise CalculationError("denominator must be non-zero")',
  '+    return a / b',
  '',
].join('\n');
const REPAIR_DIFF = [
  '--- a/src/calculator.py',
  '+++ b/src/calculator.py',
  '@@ -1,3 +1,3 @@',
  ' def divide(a, b):',
  '     if b == 0: raise CalculationError("denominator must be non-zero")',
  '-    return a / b',
  '+    return a / b  # repair: guard reviewed',
  '',
].join('\n');

export interface ControlledGeneratedPlanFixture {
  readonly route: ReturnType<typeof createPendingApprovalRoute>;
  readonly task: ReturnType<typeof createPendingApprovalRoute>['task'];
  readonly statePort: ReturnType<typeof createPendingApprovalRoute>['statePort'];
  /** Transport dispatch log, `${role}:${purpose}` per dispatch. */
  readonly modelCalls: string[];
  /** Owner-issued coder providerRequestIds, in admission order; the journal claim is `claim-${id}`. */
  readonly coderAdmissions: string[];
  readonly patchReceipts: RepositoryExecutionReceiptV02[];
  readonly host: ReturnType<typeof controlledHostFixture>;
  readonly config: UC03GraphConfigV02;
  /** The mock baseline the route persisted, once it ran past Investigate. */
  readonly baselineEvidence: () => { readonly content: BaselineEvidenceCandidate; readonly acknowledgement: BaselineEvidenceAcknowledgement } | undefined;
}

export interface ControlledReviewVerdict {
  readonly status: 'accepted' | 'findings';
  readonly findings: readonly ReviewFinding[];
}

export interface ControlledFixtureOptions {
  readonly taskState?: Partial<TaskState> | undefined;
  /** Replaces the first scripted coder response, e.g. with a `request-info` proposal. */
  readonly firstResponse?: { readonly proposalId: string; readonly content: string } | undefined;
  /** Reviewer verdicts returned in order by the controlled reviewer transport; the last repeats. */
  readonly reviewVerdict?: ControlledReviewVerdict | readonly ControlledReviewVerdict[] | undefined;
  /** Extra owner trusted transition contexts, keyed by target state version. */
  readonly transitionContexts?: Readonly<Record<number, NonNullable<StateTransitionOptions['trusted']>>> | undefined;
  /** Replaces the reproduction check's id, e.g. to exercise a long-but-valid durable id. */
  readonly reproductionCheckId?: string | undefined;
  /**
   * Makes the owner-settled patch receiver throw once, on its first call. The execution guard's own
   * `catch` turns that into `uncertain-effect`, which is the only seam that reaches the patch node's
   * `IMPLEMENTED_UNVERIFIED` recovery branch — the model transport is a different fault.
   */
  readonly failFirstPatch?: boolean | undefined;
  /**
   * Makes the coder transport throw on its first dispatch. The seeded script otherwise wins, so an
   * exhausted script is not a reliable provider fault: it only fires once the queue is dry *and* no
   * plan is bound, which a fresh fixture never reaches on its opening turns.
   */
  readonly failFirstResponse?: boolean | undefined;
  /**
   * Replaces the protected-test content the mock host reports. Baseline and completion both read the
   * same authority, so any change here moves both digests together; to exercise the drift refusal,
   * mint the completion context from a default fixture and run it against a fixture using this.
   */
  readonly hostTestFileContent?: string | undefined;
}

export async function controlledGeneratedPlanFixture(options: ControlledFixtureOptions = {}): Promise<ControlledGeneratedPlanFixture> {
  const fixtureSequence = ++controlledFixtureSequence;
  const route = createPendingApprovalRoute('pending', `dec-plan-${createFixtureBugTask().taskId}-1`, options.transitionContexts ?? {}, options.reproductionCheckId, options.hostTestFileContent);
  const statePort = route.statePort;
  const task = route.task;
  const graphState = createGraphTaskState(task, options.taskState ?? {});
  await seedGraphTaskState(statePort, graphState);
  const routeRepository = route.ports.repositoryPort;
  if (!('executionGuardApiVersion' in routeRepository) || routeRepository.executionGuardApiVersion !== '0.2.0') {
    throw new Error('Controlled route is missing its v0.2 repository adapter');
  }
  // The controlled-route factory installs this v0.2 adapter but declares the legacy compatibility union.
  const repositoryPort = routeRepository as RepositoryPortV02;
  const modelCalls: string[] = [];
  const coderAdmissions: string[] = [];
  const responses = [
    options.firstResponse ?? {
      proposalId: 'controlled-inspect-1',
      content: JSON.stringify({ kind: 'inspect', proposalId: 'controlled-inspect-1', operation: 'read_file', args: { path: 'src/calculator.py' } }),
    },
    {
      proposalId: 'controlled-plan-1',
      content: JSON.stringify({
        kind: 'propose-plan',
        proposalId: 'controlled-plan-1',
        diagnosis: 'The denominator is not guarded.',
        strategy: ROUTE_PLAN_DETAILS.strategy,
        suspectedLocations: ['src/calculator.py'],
        scopedPaths: ['src/calculator.py'],
        evidenceRefs: ['src/calculator.py'],
      }),
    },
  ];
  const patchReceipts: RepositoryExecutionReceiptV02[] = [];
  const applyPatch = repositoryPort.applyPatch.bind(repositoryPort);
  let patchAttempts = 0;
  repositoryPort.applyPatch = async (action, context) => {
    if (options.failFirstPatch && patchAttempts++ === 0) throw new Error('CONTROLLED_PATCH_FAULT: simulated receiver loss');
    const result = await applyPatch(action, context);
    patchReceipts.push(result.executionReceipt);
    return result;
  };
  const actor = createFixtureExecutorIdentityV02({ processIncarnation: `controlled-proc-${fixtureSequence}` });
  const readControl: GuardedReadControlObservation = {
    taskId: graphState.taskId,
    workspaceId: graphState.workspaceId,
    repositoryId: graphState.repositoryId,
    revisionDigest: graphState.repositoryRevisionDigest,
    controlVersion: 1,
    mode: 'runnable',
    holdRef: null,
    fencingGeneration: 1,
    policyDigest: `sha256:${'d'.repeat(64)}`,
    readAllowed: true,
  };
  const guardedRead = createGuardedReadCapability({
    capabilityId: 'controlled-read-1',
    taskId: graphState.taskId,
    workspaceId: graphState.workspaceId,
    repositoryId: graphState.repositoryId,
    expectedRevisionDigest: graphState.repositoryRevisionDigest,
    policyDigest: readControl.policyDigest,
    bounds: { maxPathLength: 512, maxQueryLength: 256 },
    provenance: 'mock',
    owner: {
      observeReadControl: () => readControl,
      fenceReadControl: observation => {
        if (
          observation.taskId !== readControl.taskId ||
          observation.workspaceId !== readControl.workspaceId ||
          observation.repositoryId !== readControl.repositoryId ||
          observation.revisionDigest !== readControl.revisionDigest ||
          observation.controlVersion !== readControl.controlVersion ||
          observation.mode !== readControl.mode ||
          observation.holdRef !== readControl.holdRef ||
          observation.fencingGeneration !== readControl.fencingGeneration ||
          observation.policyDigest !== readControl.policyDigest ||
          observation.readAllowed !== readControl.readAllowed
        )
          return null;
        return {
          receiptId: 'controlled-read-fence-1',
          taskId: readControl.taskId,
          workspaceId: readControl.workspaceId,
          repositoryId: readControl.repositoryId,
          revisionDigest: readControl.revisionDigest,
          controlVersion: readControl.controlVersion,
          fencingGeneration: readControl.fencingGeneration,
          policyDigest: readControl.policyDigest,
        };
      },
    },
  });
  const transport: HostModelTransport = {
    async execute(payload) {
      modelCalls.push(`${payload.request.role}:${payload.request.purpose}`);
      if (options.failFirstResponse && modelCalls.length === 1) throw new Error('CONTROLLED_PROVIDER_FAULT: simulated uncertain dispatch');
      const proposal = responses.shift();
      if (proposal) return { proposal, observedUsage: USAGE };
      const plan = payload.state.plan;
      if (!plan?.strategyDigest || !plan.decisionRef) throw new Error('SCRIPT_EXHAUSTED');
      const repair = payload.request.purpose === 'propose-repair';
      if (!repair && payload.request.purpose !== 'propose-patch') throw new Error('SCRIPT_EXHAUSTED');
      const proposalId = `controlled-${repair ? 'repair' : 'patch'}-${plan.planVersion}`;
      return {
        proposal: {
          proposalId,
          content: JSON.stringify({
            kind: 'propose-patch',
            proposalId,
            diff: repair ? REPAIR_DIFF : PATCH_DIFF,
            targetPaths: ['src/calculator.py'],
            approvedPlanRef: plan.decisionRef,
          }),
        },
        observedUsage: USAGE,
      };
    },
  };
  const model = new HostModelPortV02({ transport, statePort, executorIdentity: actor, currentExecutorIdentity: () => actor });
  const reviewVerdicts = Array.isArray(options.reviewVerdict) ? [...options.reviewVerdict] : [options.reviewVerdict ?? { status: 'accepted', findings: [] }];
  // Keep the last verdict so a repeated review round replays it instead of running dry.
  let reviewCursor = 0;
  const nextReviewVerdict = (): ControlledReviewVerdict => reviewVerdicts[Math.min(reviewCursor++, reviewVerdicts.length - 1)] ?? { status: 'accepted', findings: [] };
  const reviewerActor = createFixtureExecutorIdentityV02({ processIncarnation: `controlled-reviewer-${fixtureSequence}` });
  const reviewerModel = Object.assign(
    new HostModelPortV02({
      transport: {
        execute: async () => ({
          proposal: { proposalId: 'controlled-review-1', content: JSON.stringify(nextReviewVerdict()) },
          observedUsage: USAGE,
        }),
      },
      statePort,
      executorIdentity: reviewerActor,
      currentExecutorIdentity: () => reviewerActor,
    }),
    { providerRole: 'reviewer' as const },
  );
  const agent = createCoderAgentV02({ model, repository: repositoryPort, budget: BUDGET, guardedRead });
  let admissionId = 0;
  const trustedExpectedContext = route.config.trustedExpectedContext;
  if (!trustedExpectedContext) throw new Error('Controlled route is missing its trusted expected context');
  const config: UC03GraphConfigV02 = {
    trustedExpectedContext,
    trustedTransitionContext: Object.values(options.transitionContexts ?? {}).find(trusted => trusted.completion),
    generation: { agent },
    coderAdmission: async ({ task: currentTask, state, purpose, evidence }) => {
      const owner = await statePort.readVerificationAuthoritySnapshot(state.taskId);
      if (!owner) return undefined;
      const identity: ProviderPricingIdentityV02 = {
        providerId: 'provider-test',
        modelId: 'model-test-01',
        configId: owner.policyIdentity.configId,
        configVersion: owner.policyIdentity.configVersion,
        pricingPolicyId: owner.policyIdentity.policyId,
        pricingPolicyVersion: owner.policyIdentity.policyVersion,
        issuerKeyRef: owner.policyIdentity.issuerKeyRef,
        decisionAuthorityGeneration: owner.decisionAuthorityGeneration,
      };
      const request: ProviderRequest = createTestProviderRequest({
        providerRequestId: `controlled-${purpose}-${++admissionId}`,
        taskId: state.taskId,
        runId: state.runId,
        role: 'coder',
        purpose,
        configId: identity.configId,
        pricingPolicyId: identity.pricingPolicyId,
        contextDigest: computeContextDigest(state, evidence),
        reservationRef: `coder-allowance-${admissionId}`,
      });
      coderAdmissions.push(request.providerRequestId);
      const receipt = createFixtureProviderAdmissionReceiptV02({
        providerRequestId: request.providerRequestId,
        role: 'coder',
        requestContentDigest: computeRequestContentDigest(request),
        providerId: identity.providerId,
        modelId: identity.modelId,
        configId: identity.configId,
        configVersion: identity.configVersion,
        decisionAuthorityGeneration: identity.decisionAuthorityGeneration,
      });
      const journal = statePort.getJournalSnapshot();
      const context = createTestProviderAdmissionContextV02({
        providerRequest: request,
        providerIdentity: identity,
        providerAdmissionReceipt: receipt,
        taskId: state.taskId,
        runId: state.runId,
        runnableNode: state.node,
        role: 'coder',
        expectedTaskStateVersion: state.stateVersion,
        expectedControlVersion: journal.controlVersion,
        expectedEpoch: journal.epoch,
        planApplicability: purpose === 'propose-plan' ? 'pre-plan-diagnostic' : 'approved-plan',
        ...(purpose === 'propose-plan' ? { diagnosticPurpose: 'diagnose-zero-denominator', taskCriteriaDigest: computeCanonicalSha256(currentTask.acceptanceCriteria) } : {}),
        planDecisionRef: state.plan?.decisionRef,
        planBindingDigest: currentPlanBindingDigest(currentTask, state),
        budgetRefs: [`task-tokens:${request.providerRequestId}`, `task-cost:${request.providerRequestId}`, `run-tokens:${request.providerRequestId}`, `run-cost:${request.providerRequestId}`],
      });
      if (purpose === 'propose-plan') {
        // The fixture builder includes approved-plan fields; strip them for this pre-plan request.
        const mutable = context as unknown as Record<string, unknown>;
        delete mutable['planDecisionRef'];
        delete mutable['planBindingDigest'];
      }
      return { request, context, trustedContext: createTestProviderAdmissionTrustedContextV02(context) };
    },
    reviewerAdmission: async ({ task: currentTask, state, diff }) => {
      const owner = await statePort.readVerificationAuthoritySnapshot(state.taskId);
      if (!owner) return undefined;
      const contextDigest = reviewerContextDigest(currentTask, diff.diff, [], state.repositoryRevisionDigest, {
        runId: state.runId,
        expectedTaskStateVersion: state.stateVersion,
      });
      if (contextDigest === null) return undefined;
      const request = createTestProviderRequest({
        providerRequestId: `provider-${state.taskId}-${state.stateVersion}`,
        taskId: state.taskId,
        runId: state.runId,
        role: 'reviewer',
        purpose: 'final-review',
        configId: owner.policyIdentity.configId,
        pricingPolicyId: owner.policyIdentity.policyId,
        contextDigest,
        reservationRef: `review-allowance:${state.taskId}:${state.stateVersion}`,
      });
      const identity: ProviderPricingIdentityV02 = {
        providerId: request.providerId,
        modelId: request.modelId,
        configId: request.configId,
        configVersion: owner.policyIdentity.configVersion,
        pricingPolicyId: owner.policyIdentity.policyId,
        pricingPolicyVersion: owner.policyIdentity.policyVersion,
        issuerKeyRef: owner.policyIdentity.issuerKeyRef,
        decisionAuthorityGeneration: owner.decisionAuthorityGeneration,
      };
      const receipt = createFixtureProviderAdmissionReceiptV02({
        providerRequestId: request.providerRequestId,
        role: 'reviewer',
        requestContentDigest: computeRequestContentDigest(request),
        providerId: identity.providerId,
        modelId: identity.modelId,
        configId: identity.configId,
        configVersion: identity.configVersion,
        decisionAuthorityGeneration: identity.decisionAuthorityGeneration,
      });
      const journal = statePort.getJournalSnapshot();
      const context = createTestProviderAdmissionContextV02({
        providerRequest: request,
        providerIdentity: identity,
        providerAdmissionReceipt: receipt,
        taskId: state.taskId,
        runId: state.runId,
        runnableNode: 'Review',
        role: 'reviewer',
        expectedTaskStateVersion: state.stateVersion,
        expectedControlVersion: journal.controlVersion,
        expectedEpoch: journal.epoch,
        planApplicability: 'approved-plan',
        planDecisionRef: state.plan?.decisionRef,
        planBindingDigest: currentPlanBindingDigest(currentTask, state),
        budgetRefs: [
          `task-tokens:${request.providerRequestId}`,
          `task-cost:${request.providerRequestId}`,
          `run-tokens:${request.providerRequestId}`,
          `run-cost:${request.providerRequestId}`,
          `task-iteration:${request.providerRequestId}`,
        ],
      });
      return { request, context, trustedContext: createTestProviderAdmissionTrustedContextV02(context) };
    },
    admissionContext: async ({ task: currentTask, state, patchContent, targetPaths, actionId }) => {
      const owner = await statePort.readVerificationAuthoritySnapshot(state.taskId);
      if (!owner || !state.plan?.decisionRef) return undefined;
      const action: NormalizedAction = {
        // The fake repository echoes the action id into file content; it must not contain a
        // `sk-`-shaped run (a task-id-derived id does: `patch-task-calc-…` → `sk-calc-…`), which
        // the model boundary refuses as protected content before the reviewer ever dispatches.
        actionId: actionId ?? `controlled-patch-${state.stateVersion}`,
        kind: 'apply_patch',
        patchContent,
        targetPaths,
        baseRevisionDigest: state.repositoryRevisionDigest,
      };
      const journal = statePort.getJournalSnapshot();
      const context = createTestRepositoryAdmissionContextV02({
        taskId: state.taskId,
        runId: state.runId,
        workspaceId: state.workspaceId,
        repositoryId: state.repositoryId,
        canonicalRevision: state.repositoryRevisionDigest,
        expectedTaskStateVersion: state.stateVersion,
        expectedControlVersion: journal.controlVersion,
        expectedEpoch: journal.epoch,
        runnableNode: state.node === 'Repair' ? 'Repair' : 'Patch',
        planDecisionRef: state.plan.decisionRef,
        planBindingDigest: currentPlanBindingDigest(currentTask, state),
        policyAuthorityRef: { ...owner.policyIdentity, decisionAuthorityGeneration: owner.decisionAuthorityGeneration },
        action,
        baseRevision: state.repositoryRevisionDigest,
        targetPaths,
        patchDigest: computeCanonicalSha256(patchContent),
        reservationRefs: [`repair-slot:${state.taskId}:${state.stateVersion}`],
      });
      return { context, trustedContext: createTestRepositoryAdmissionTrustedContextV02(context) };
    },
  };
  const baselineWriter = route.ports.baselineEvidenceWriter;
  if (!baselineWriter) throw new Error('Controlled route is missing its baseline evidence writer');
  let storedBaseline: { readonly content: BaselineEvidenceCandidate; readonly acknowledgement: BaselineEvidenceAcknowledgement } | undefined;
  const baseline = createBaselineEvidenceAdapter({
    provenance: 'mock',
    async persist(request) {
      const acknowledgement = await baselineWriter.persistBaselineEvidence(request);
      storedBaseline = { content: request.content, acknowledgement };
      return { outcome: 'durable', acknowledgement };
    },
    load(request) {
      const stored = storedBaseline;
      if (!stored || stored.acknowledgement.evidenceId !== request.evidenceId) return { outcome: 'missing' };
      return { outcome: 'found', content: stored.content, acknowledgement: stored.acknowledgement };
    },
  });
  const guard = route.ports.executionGuard;
  if (!guard || !('executionGuardApiVersion' in guard) || guard.executionGuardApiVersion !== '0.2.0') throw new Error('Controlled route is missing its v0.2 execution guard');
  const executionGuard = guard as UC03ProductionExecutionGuardV02;
  const ports: UC03GraphPortsV02 = {
    statePort,
    approvalPort: route.approvalPort,
    repositoryPort,
    modelPort: model,
    reviewerModelPort: reviewerModel,
    executionGuard,
    guardedRead,
    baselineEvidence: baseline,
    hostAuthority: route.hostAuthority,
    configPort: { loadConfig: async taskId => (taskId === task.taskId ? { configId: task.configId, configVersion: task.configVersion } : null) },
    contextSource: { provenance: 'mock', observe: () => null },
    replanPort: { provenance: 'mock', accept: async () => ({ outcome: 'denied' as const, reason: 'not scripted' }) },
  };
  const controlled = controlledHostFixture(graphState, config, ports, {
    guardedRead,
    baselineEvidence: baseline,
    hostAuthority: route.hostAuthority,
    contextSource: ports.contextSource,
  });
  return { route, task, statePort, modelCalls, coderAdmissions, patchReceipts, host: controlled, config, baselineEvidence: () => storedBaseline };
}

/**
 * Owner trusted completion for the accepted-review delivery transition. `state` is the post-review
 * owner state, so the review admission it records was issued one version earlier. Every field comes
 * from the deterministic controlled route, so a fresh fixture reaches the same delivery version.
 */
export async function controlledCompletionContext(fixture: ControlledGeneratedPlanFixture, state: TaskState): Promise<NonNullable<StateTransitionOptions['trusted']>> {
  const stored = fixture.baselineEvidence();
  const owner = await fixture.statePort.readVerificationAuthoritySnapshot(state.taskId);
  if (!stored || !owner) throw new Error('Controlled fixture has no persisted baseline or owner authority');
  const repositoryPort = fixture.route.ports.repositoryPort;
  if (!('inspectDiff' in repositoryPort) || !('loadSnapshot' in fixture.route.hostAuthority)) throw new Error('Controlled fixture is missing its repository or host authority');
  const diffInfo = await repositoryPort.inspectDiff(fixture.task.initialRevisionDigest);
  const hostAuthority = fixture.route.hostAuthority as TrustedHostPort;
  const snapshot = await hostAuthority.loadSnapshot({
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    repositoryId: fixture.task.repositoryId,
    expectedRevisionDigest: state.repositoryRevisionDigest,
    expectedCriteriaDigest: computeCanonicalSha256(fixture.task.acceptanceCriteria),
    expectedCheckSetDigest: computeCheckSetDigest(fixture.task.requiredChecks),
    expectedTestFiles: ['tests/test_calculator.py'],
  });
  const providerRequestId = `provider-${state.taskId}-${state.stateVersion}`;
  const checkSetDigest = computeCheckSetDigest(fixture.task.requiredChecks);
  return {
    completion: {
      taskId: state.taskId,
      runId: state.runId,
      repositoryRevisionDigest: state.repositoryRevisionDigest,
      diffDigest: diffInfo.diffDigest,
      checkSetDigest,
      baselineRef: stored.acknowledgement.evidenceId,
      criteriaDigest: computeCanonicalSha256(fixture.task.acceptanceCriteria),
      authorizedDiffDigest: diffInfo.diffDigest,
      protectedTestsDigest: computeTestProtectionDigest(snapshot.testFiles),
      originalProtectedTestsDigest: stored.acknowledgement.testProtectionDigest,
      reviewerRoleConfigId: owner.policyIdentity.configId,
      reviewIterationReservationRef: `review-allowance:${state.taskId}:${state.stateVersion}`,
      checks: fixture.task.requiredChecks.map(check => ({
        checkId: check.checkId,
        outcome: 'pass' as const,
        repositoryRevisionDigest: state.repositoryRevisionDigest,
        diffDigest: diffInfo.diffDigest,
      })),
      review: {
        reviewId: `review-${providerRequestId}`,
        reviewerRoleConfigId: owner.policyIdentity.configId,
        repoDigest: state.repositoryRevisionDigest,
        diffDigest: diffInfo.diffDigest,
        checkSetDigest,
        status: 'accepted',
        findings: [],
        iterationReservationRef: `review-allowance:${state.taskId}:${state.stateVersion}`,
      },
    },
  };
}

export async function assertControlledPlanApprovalPatchBarrier(fixture: ControlledGeneratedPlanFixture): Promise<void> {
  const readiness = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(readiness.status, 'controlled-ready');
  if (readiness.status !== 'controlled-ready') return;
  const before = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  const initialState = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(before.outcome, 'pending-approval', JSON.stringify({ reasons: before.reasons, modelCalls: fixture.modelCalls, node: initialState?.node }));
  assert.equal(fixture.route.repositoryPort.patches.length, 0);
  const sentinel = await fixture.route.repositoryPort.readFile('tests/test_calculator.py');
  const currentAuthority = await fixture.statePort.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(currentAuthority);
  const approvalAuthority = {
    ...currentAuthority.policyIdentity,
    decisionAuthorityGeneration: currentAuthority.decisionAuthorityGeneration + 1,
  };
  const publication = await fixture.statePort.publishAuthority({ authorityRef: approvalAuthority });
  assert.equal(publication.status, 'published', JSON.stringify(publication));
  fixture.route.approvalPort.setV02AuthorityRef(approvalAuthority);
  const decisionRef = `dec-plan-${fixture.task.taskId}-1`;
  const pendingDecision = fixture.route.approvalPort.getRecordedBindings().find(binding => binding.decisionId === decisionRef);
  assert.ok(pendingDecision, `Missing owner-issued D0 binding ${decisionRef}`);
  fixture.route.approvalPort.scriptDecision({ ...pendingDecision, status: 'approved' });

  const result = await runControlledUC03GraphV02(fixture.task, readiness.ports, readiness.config);
  const state = await fixture.statePort.loadTask(fixture.task.taskId);
  assert.equal(
    result.outcome,
    'pending-approval',
    JSON.stringify({
      reasons: result.reasons,
      node: state?.node,
      patchCount: fixture.route.repositoryPort.patches.length,
      patchReceiptCount: fixture.patchReceipts.length,
      receiverFailures: fixture.route.patchFailureReasons,
      modelCalls: fixture.modelCalls,
    }),
  );
  assert.equal(state?.node, 'Verify');
  assert.equal(fixture.route.repositoryPort.patches.length, 1);
  assert.deepEqual(fixture.modelCalls, ['coder:propose-plan', 'coder:propose-plan', 'coder:propose-patch']);
  assert.equal(fixture.patchReceipts.length, 1);
  const receipt = fixture.patchReceipts[0];
  assert.ok(receipt);
  assert.equal(receipt.outcome.repositoryOperation, 'apply-patch');
  const transition = receipt.outcome.proposedEffects.taskTransition;
  if (transition.kind !== 'transition') throw new Error('Patch receipt did not include the Verify transition');
  assert.equal(transition.toNode, 'Verify');
  assert.equal(receipt.outcome.observedResultRevisionDigest, state?.repositoryRevisionDigest);
  assert.equal(receipt.settlement.outcome, 'settled');
  assert.equal((await fixture.route.repositoryPort.readFile('tests/test_calculator.py')).boundedExcerpt, sentinel.boundedExcerpt);
}
