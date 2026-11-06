import type { ProviderPricingIdentityV02, ProviderRequest, RepositoryPortV02 } from '../../../../src/contracts/foundation/uc03.ts';
import { computeCanonicalSha256, computeRequestContentDigest } from '../../../../src/contracts/foundation/uc03.ts';
import { createFixtureExecutorIdentityV02, createFixtureProviderAdmissionReceiptV02 } from './port-fixtures.ts';
import { createGraphTaskState, seedGraphTaskState } from './graph-fixtures.ts';
import { createTestProviderAdmissionContextV02, createTestProviderAdmissionTrustedContextV02, createTestProviderRequest } from './state-fixtures.ts';
import { createPendingApprovalRoute, ROUTE_PLAN_DETAILS } from './controlled-route.ts';
import { HostModelPortV02 } from '../../../../src/foundation/model-v02.ts';
import type { HostModelTransport } from '../../../../src/foundation/model.ts';
import { computeContextDigest } from '../../../../src/foundation/model.ts';
import { createGuardedReadCapability, type GuardedReadControlObservation } from '../../../../src/foundation/guarded-read-capability.ts';
import { createCoderAgentV02 } from '../../../../src/uc03/agent.ts';
import { currentPlanBindingDigest } from '../../../../src/uc03/graph-validation.ts';
import type { UC03GraphConfigV02, UC03GraphPortsV02 } from '../../../../src/uc03/graph-types-v02.ts';
import { controlledHostFixture } from './host-pipeline-fixtures.ts';

const USAGE = { inputTokens: 1, outputTokens: 1, billableTokens: 2, costUsd: 0.001 };
const BUDGET = { maxModelCalls: 4, maxActiveMs: 60_000, maxRepairs: 1, maxReplans: 1 };

type ControlledGeneratedPlanFixture = {
  readonly route: ReturnType<typeof createPendingApprovalRoute>;
  readonly task: ReturnType<typeof createPendingApprovalRoute>['task'];
  readonly statePort: ReturnType<typeof createPendingApprovalRoute>['statePort'];
  readonly modelCalls: string[];
  readonly host: ReturnType<typeof controlledHostFixture>;
  readonly config: UC03GraphConfigV02;
};

export async function controlledGeneratedPlanFixture(): Promise<ControlledGeneratedPlanFixture> {
  const route = createPendingApprovalRoute('pending');
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
  const actor = createFixtureExecutorIdentityV02();
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
      if (!proposal) throw new Error('SCRIPT_EXHAUSTED');
      return { proposal, observedUsage: USAGE };
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
        diagnosticPurpose: 'diagnose-zero-denominator',
        taskCriteriaDigest: computeCanonicalSha256(currentTask.acceptanceCriteria),
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
  };
  const baselineWriter = route.ports.baselineEvidenceWriter;
  const loadBaselineEvidence = baselineWriter?.loadBaselineEvidence;
  if (!baselineWriter || !loadBaselineEvidence) throw new Error('Controlled route is missing its readable baseline evidence writer');
  const baseline = { ...baselineWriter, loadBaselineEvidence: loadBaselineEvidence.bind(baselineWriter), provenance: 'mock' as const };
  const executionGuard = route.ports.executionGuard;
  if (!executionGuard) throw new Error('Controlled route is missing its execution guard');
  const approvalPort = {
    ...route.approvalPort,
    async requestDecision(binding: Parameters<typeof route.approvalPort.requestDecision>[0]) {
      route.approvalPort.scriptDecision({ ...binding, status: 'pending' });
      return route.approvalPort.requestDecision(binding);
    },
  };
  const ports: UC03GraphPortsV02 = {
    statePort,
    approvalPort,
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
  return { route, task, statePort, modelCalls, host: controlled, config };
}
