import assert from 'node:assert/strict';
import type { NormalizedAction, ProviderPricingIdentityV02, ProviderRequest, RepositoryExecutionReceiptV02, RepositoryPortV02 } from '../../../../src/contracts/foundation/uc03.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceCandidate } from '../../../../src/uc03/investigation-types.ts';
import { computeCanonicalSha256, computeRequestContentDigest } from '../../../../src/contracts/foundation/uc03.ts';
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

export interface ControlledGeneratedPlanFixture {
  readonly route: ReturnType<typeof createPendingApprovalRoute>;
  readonly task: ReturnType<typeof createPendingApprovalRoute>['task'];
  readonly statePort: ReturnType<typeof createPendingApprovalRoute>['statePort'];
  readonly modelCalls: string[];
  readonly patchReceipts: RepositoryExecutionReceiptV02[];
  readonly host: ReturnType<typeof controlledHostFixture>;
  readonly config: UC03GraphConfigV02;
}

export async function controlledGeneratedPlanFixture(): Promise<ControlledGeneratedPlanFixture> {
  const fixtureSequence = ++controlledFixtureSequence;
  const route = createPendingApprovalRoute('pending', `dec-plan-${createFixtureBugTask().taskId}-1`);
  const statePort = route.statePort;
  const task = route.task;
  const graphState = createGraphTaskState(task);
  await seedGraphTaskState(statePort, graphState);
  const routeRepository = route.ports.repositoryPort;
  if (!('executionGuardApiVersion' in routeRepository) || routeRepository.executionGuardApiVersion !== '0.2.0') {
    throw new Error('Controlled route is missing its v0.2 repository adapter');
  }
  // The controlled-route factory installs this v0.2 adapter but declares the legacy compatibility union.
  const repositoryPort = routeRepository as RepositoryPortV02;
  const modelCalls: string[] = [];
  const responses = [
    {
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
  repositoryPort.applyPatch = async (action, context) => {
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
      const proposal = responses.shift();
      if (proposal) return { proposal, observedUsage: USAGE };
      const plan = payload.state.plan;
      if (payload.request.purpose !== 'propose-patch' || !plan?.strategyDigest || !plan.decisionRef) throw new Error('SCRIPT_EXHAUSTED');
      return {
        proposal: {
          proposalId: `controlled-patch-${plan.planVersion}`,
          content: JSON.stringify({
            kind: 'propose-patch',
            proposalId: `controlled-patch-${plan.planVersion}`,
            diff: PATCH_DIFF,
            targetPaths: ['src/calculator.py'],
            approvedPlanRef: plan.decisionRef,
          }),
        },
        observedUsage: USAGE,
      };
    },
  };
  const model = new HostModelPortV02({ transport, statePort, executorIdentity: actor, currentExecutorIdentity: () => actor });
  const reviewerModel = Object.assign(new HostModelPortV02({ transport: { execute: async () => ({ outcome: 'denied', reason: 'unused reviewer fixture' }) }, statePort }), {
    providerRole: 'reviewer' as const,
  });
  const agent = createCoderAgentV02({ model, repository: repositoryPort, budget: BUDGET, guardedRead });
  let admissionId = 0;
  const trustedExpectedContext = route.config.trustedExpectedContext;
  if (!trustedExpectedContext) throw new Error('Controlled route is missing its trusted expected context');
  const config: UC03GraphConfigV02 = {
    trustedExpectedContext,
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
    admissionContext: async ({ task: currentTask, state, patchContent, targetPaths, actionId }) => {
      const owner = await statePort.readVerificationAuthoritySnapshot(state.taskId);
      if (!owner || !state.plan?.decisionRef) return undefined;
      const action: NormalizedAction = {
        actionId: actionId ?? `patch-${state.taskId}-${state.stateVersion}`,
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
        runnableNode: 'Patch',
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
  return { route, task, statePort, modelCalls, patchReceipts, host: controlled, config };
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
