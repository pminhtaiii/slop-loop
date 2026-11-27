/**
 * Shared controlled loopback-HTTP console test harness for Feature 007 T017.
 *
 * Wraps the composed console host, controlled UC-03 fixture, owner approval/control ports,
 * and loopback HTTP helpers. All adapters remain controlled/mock; never real-provider or browser evidence.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSnapshotGrader, type SnapshotGrader } from '../../../../eval/uc03/workflow-grade.ts';
import type { EvaluationGraderExecutionRequest, EvaluationGradingAdmissionRequest } from '../../../../eval/uc03/types.ts';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  validateApprovalBinding,
  type ApprovalBinding,
  type ApprovalBindingContext,
  type BugTask,
  type FixPlan,
  type StateTransitionOptions,
  type TaskState,
} from '../../../../src/contracts/foundation/uc03.ts';
import { createEvaluationConsoleHost, type EvaluationConsoleAssembly, type EvaluationConsoleConfiguration, type EvaluationConsoleHost } from '../../../../src/runtime/evaluation-console-host.ts';
import type { EvaluationGraphReportBinding } from '../../../../src/runtime/evaluation-graph-report.ts';
import type { ClarificationResumeReceipt } from '../../../../src/runtime/evaluation-graph.ts';
import { admitEvaluationProfile, type CatalogEntry, type EvaluationProfile } from '../../../../src/runtime/evaluation-profile.ts';
import type { ExperimentReceipt, ExperimentView, ServiceControlReceipt } from '../../../../src/runtime/evaluation-service.ts';
import { prepareControlledUC03Host, type UC03ControlledHostReadiness } from '../../../../src/runtime/uc03-host-bootstrap.ts';
import { sha256Text } from '../../../../src/uc01/contracts.ts';
import type { OwnerDelivery } from '../../../../src/runtime/evaluation-composition.ts';
import type { UC03CompletionContextRequest, UC03TrustedCompletion } from '../../../../src/uc03/graph-types.ts';
import type { MaterialReplanPortV02 } from '../../../../src/uc03/graph-types-v02.ts';
import { controlledGeneratedPlanFixture, type ControlledFixtureOptions, type ControlledGeneratedPlanFixture } from './controlled-host-journey.ts';
import { createPlanApprovalContext } from './controlled-route.ts';

export const DEFAULT_CONSOLE_TOKEN = 'controlled-journey-operator-token';
export const DEFAULT_CHECK_SET = 'checks-configured';
const TERMINAL_OWNER_NODES = new Set<TaskState['node']>(['Deliver', 'Incomplete']);

export type ConsoleEnvelope<T> = Readonly<{ ok: true; result: T }>;
export type ConsoleErrorBody = Readonly<{ ok: false; error: string }>;
export type ExperimentReply = Readonly<{ experiment: ExperimentView; receipt: ExperimentReceipt }>;
export type DirectionReply = Readonly<{ experiment: ExperimentView; receipt: ServiceControlReceipt | ExperimentReceipt }>;

export interface CustomBugInputConfig {
  readonly goal: string;
  readonly observedBehavior: string;
  readonly expectedBehavior: string;
  readonly reproduction: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints?: readonly string[] | undefined;
}

export interface ControlledConsoleOptions {
  readonly token?: string | undefined;
  readonly seed?: string | undefined;
  readonly entryOverrides?: Partial<CatalogEntry> | undefined;
  readonly firstResponse?: ControlledFixtureOptions['firstResponse'] | undefined;
  readonly replanResponse?: ControlledFixtureOptions['replanResponse'] | undefined;
  readonly taskState?: ControlledFixtureOptions['taskState'] | undefined;
  readonly graderStatus?: 'pass' | 'fail' | undefined;
  readonly includeCustomRoute?: boolean | undefined;
  readonly customRouteWorkflowReport?: EvaluationGraphReportBinding | undefined;
  readonly customBugInput?: CustomBugInputConfig | undefined;
}

export interface HttpReply<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ConsoleEnvelope<T>;
}

export interface HttpRawReply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface ConsoleHttpClient {
  get<T = ExperimentView>(path: string): Promise<HttpReply<T>>;
  getText(path: string): Promise<{ readonly status: number; readonly headers: Headers; readonly text: string }>;
  post<T = ExperimentReply>(path: string, body: unknown): Promise<HttpReply<T>>;
  postRaw(path: string, body: unknown): Promise<HttpRawReply>;
}

export interface ComposedControlledConsole {
  readonly files: string;
  readonly entry: CatalogEntry;
  readonly fixture: ControlledGeneratedPlanFixture;
  readonly profile: EvaluationProfile;
  readonly configuration: EvaluationConsoleConfiguration;
  readonly readiness: Extract<UC03ControlledHostReadiness, { readonly status: 'controlled-ready' }>;
  readonly assembly: EvaluationConsoleAssembly;
  readonly grader: SnapshotGrader;
  readonly workflowReportBinding: EvaluationGraphReportBinding;
  readonly approvalEffects: string[];
  readonly directions: { readonly kind: string; readonly expectedTaskVersion: number; readonly expectedControlVersion: number; readonly controlVersion: number }[];
  readonly counters: () => { readonly routeCalls: number };
  readonly graderExecutions: () => number;
}

function buildPlanApprovalBinding(
  decisionId: string,
  task: Readonly<{ taskId: string; configId: string; configVersion: string; acceptanceCriteria: readonly string[] }>,
  state: Readonly<{ workspaceId: string; repositoryRevisionDigest: string }>,
  plan: FixPlan,
): { readonly binding: ApprovalBinding; readonly freshness: ApprovalBindingContext } {
  const baselineRef = plan.baselineRef ?? '';
  const criteriaDigest = computeCanonicalSha256(task.acceptanceCriteria);
  const action = {
    actionId: decisionId,
    kind: 'approve_fix_plan' as const,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    diagnosisEvidenceRefs: plan.evidenceRefs,
    checkSetDigest: plan.checkSetDigest,
  };
  const normalizedActionDigest = computeCanonicalSha256(action);
  const binding: ApprovalBinding = {
    decisionId,
    actionKind: 'fix_plan',
    normalizedActionDigest,
    taskId: task.taskId,
    workspaceId: state.workspaceId,
    repositoryRevisionDigest: state.repositoryRevisionDigest,
    policyId: task.configId,
    policyVersion: task.configVersion,
    planVersion: plan.planVersion,
    strategyDigest: plan.strategyDigest,
    baselineRef,
    evidenceRefs: plan.evidenceRefs,
    criteriaDigest,
    checkSetDigest: plan.checkSetDigest,
    status: 'pending',
  };
  const freshness: ApprovalBindingContext = {
    currentTaskId: task.taskId,
    currentWorkspaceId: state.workspaceId,
    currentRepositoryRevisionDigest: state.repositoryRevisionDigest,
    currentPolicyId: task.configId,
    currentPolicyVersion: task.configVersion,
    currentNormalizedActionDigest: normalizedActionDigest,
    currentPlanVersion: plan.planVersion,
    currentStrategyDigest: plan.strategyDigest,
    currentBaselineRef: baselineRef,
    currentEvidenceRefs: plan.evidenceRefs,
    currentCriteriaDigest: criteriaDigest,
    currentCheckSetDigest: plan.checkSetDigest,
  };
  return { binding, freshness };
}

function isDirectionPermitted(ownerState: TaskState, kind: 'resume' | 'revise' | 'end', decisionRef?: string): boolean {
  if (TERMINAL_OWNER_NODES.has(ownerState.node)) return false;
  if (ownerState.node === 'AwaitFeedback') {
    if (kind === 'revise' || kind === 'end') {
      return typeof ownerState.activeDecisionId === 'string' && ownerState.activeDecisionId.length > 0 && decisionRef === ownerState.activeDecisionId;
    }
    return false;
  }
  if (ownerState.node === 'AwaitPlan' || ownerState.node === 'Verify' || ownerState.node === 'NeedsInfo') {
    return kind === 'resume';
  }
  return false;
}

export function createControlledSnapshotGrader(options: { readonly seed?: string | undefined; readonly status?: 'pass' | 'fail' | undefined; readonly onExecute?: () => void } = {}): SnapshotGrader {
  const suffix = options.seed ? `-${options.seed}` : '';
  const status = options.status ?? 'pass';
  return createSnapshotGrader(
    {
      criteria: {
        digest: `sha256:${sha256Text(`journey-criteria${suffix}`)}`,
        criteria: [{ criterionId: `criterion-C01-journey${suffix}`, caseId: 'C01', predicate: 'repair-success', hiddenCheckId: `hidden-C01-journey${suffix}` }],
      },
      profile: {
        profileId: 'controlled-journey-grader',
        digest: `sha256:${sha256Text(`journey-grader-profile${suffix}`)}`,
        bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
      },
      isolationAuthority: {
        admit: (request: EvaluationGradingAdmissionRequest) => ({
          kind: 'injected-mock-isolation-admission',
          admissionId: sha256Text(`mock-isolation-${request.finalSnapshot.digest}`),
          checkId: request.checkId,
          finalSnapshot: request.finalSnapshot,
          profile: request.profile,
          executorId: request.executorId,
        }),
      },
      executor: {
        executorId: 'controlled-journey-hidden-check',
        execute: (request: EvaluationGraderExecutionRequest) => {
          options.onExecute?.();
          return {
            checkId: request.checkId,
            finalSnapshot: request.finalSnapshot,
            profile: request.profile,
            executorId: request.executorId,
            status,
            actualOutcome: status === 'pass' ? ('COMPLETED' as const) : ('FAILED' as const),
            durationMs: 1,
            cpuMs: 1,
            outputBytes: 1,
          };
        },
      },
      graderPayload: null,
    },
    'controlled-tier',
  );
}

export async function composeControlledConsole(options: ControlledConsoleOptions = {}): Promise<ComposedControlledConsole> {
  const token = options.token ?? DEFAULT_CONSOLE_TOKEN;
  const transitionContexts = new Map<number, NonNullable<StateTransitionOptions['trusted']>>();
  const planApprovalContexts = new Map<string, ApprovalBindingContext>();
  const runtimeRefs: { task?: BugTask; approvals?: ControlledGeneratedPlanFixture['route']['approvalPort'] } = {};

  const fixture = await controlledGeneratedPlanFixture({
    firstResponse: options.firstResponse,
    replanResponse: options.replanResponse,
    taskState: options.taskState,
    transitionContextFor: next => {
      const explicit = transitionContexts.get(next.stateVersion);
      if (explicit) return explicit;
      if (next.node === 'Patch' && next.plan?.decisionRef && runtimeRefs.task) {
        const freshness = planApprovalContexts.get(next.plan.decisionRef);
        const recorded = runtimeRefs.approvals?.getRecordedBindings().find(item => item.decisionId === next.plan?.decisionRef);
        if (freshness && recorded) return { approval: { binding: { ...recorded, status: 'approved' }, freshness } };
        if (next.planVersion === 1) return createPlanApprovalContext(runtimeRefs.task, next.plan.decisionRef)[3];
      }
      return undefined;
    },
  });

  const resolvedTask: BugTask = options.customBugInput
    ? {
        ...fixture.task,
        goal: options.customBugInput.goal,
        observedBehavior: options.customBugInput.observedBehavior,
        expectedBehavior: options.customBugInput.expectedBehavior,
        reproduction: options.customBugInput.reproduction,
        acceptanceCriteria: [...options.customBugInput.acceptanceCriteria],
        constraints: [...(options.customBugInput.constraints ?? [])],
      }
    : fixture.task;
  runtimeRefs.task = resolvedTask;
  if (options.customBugInput) {
    const underlying = fixture.statePort.getUnderlying();
    const initialOwner = await underlying.loadTask(fixture.task.taskId);
    assert.ok(initialOwner);
    underlying.internalSetTask({
      ...initialOwner,
      goal: resolvedTask.goal,
      observedBehavior: resolvedTask.observedBehavior,
      expectedBehavior: resolvedTask.expectedBehavior,
      reproduction: resolvedTask.reproduction,
      acceptanceCriteria: [...resolvedTask.acceptanceCriteria],
      constraints: [...resolvedTask.constraints],
      taskContext: resolvedTask,
    });
  }

  const files = mkdtempSync(join(tmpdir(), 'uc03-console-journey-'));
  try {
    const fixturePath = join(files, 'case.json');
    const graderPath = join(files, 'grader.json');
    writeFileSync(fixturePath, '{}', 'utf8');
    writeFileSync(graderPath, '{}', 'utf8');

    const defaultEntry: CatalogEntry = {
      catalogEntryId: 'entry-C01-journey',
      caseId: 'C01',
      version: '1.0.0',
      caseDigest: sha256Text('journey-case'),
      publicTaskDigest: sha256Text('journey-task'),
      initialRepositoryDigest: fixture.task.initialRevisionDigest.replace(/^sha256:/u, ''),
      fixturePath,
      fixtureDigest: sha256Text('journey-fixture'),
      grader: { version: '1.0.0', digest: sha256Text('journey-grader'), path: graderPath },
    };
    const entry: CatalogEntry = {
      ...defaultEntry,
      ...options.entryOverrides,
      fixturePath: options.entryOverrides?.fixturePath || fixturePath,
      grader: options.entryOverrides?.grader ? { ...options.entryOverrides.grader, path: options.entryOverrides.grader.path || graderPath } : defaultEntry.grader,
    };

    const seedSuffix = options.seed ? `-${options.seed}` : '';
    const admitted = admitEvaluationProfile({
      endpoint: 'https://api.deepseek.com/v1/messages',
      model: 'controlled-model',
      mode: 'nonstreaming',
      credentialRef: 'controlled-journey-key',
      codeDigest: sha256Text(`journey-code${seedSuffix}`),
      configDigest: sha256Text(`journey-config${seedSuffix}`),
      imageDigest: `sha256:${sha256Text(`journey-image${seedSuffix}`)}`,
      platform: 'linux/amd64',
      adapterVersions: ['controlled-journey-adapter-1'],
      pricing: { pricingId: 'journey-price-1', inputRate: 1, outputRate: 1, cacheRate: 0, overheadRate: 0, denominator: 1 },
      limits: {
        totalModelCalls: 24,
        inputTokensPerRequest: 32768,
        outputTokensPerRequest: 8192,
        providerTimeoutMs: 60000,
        activeExecutionMs: 900000,
        repairs: 2,
        reviewerIterations: 2,
        materialReplans: 3,
        commandTimeoutMs: 30000,
        outputBytes: 1048576,
        memoryBytes: 2147483648,
        cpus: 2,
        processes: 64,
      },
      catalog: [entry],
    });
    assert.ok(admitted.ok, admitted.ok ? '' : admitted.reasonCode);
    const profile = admitted.value;
    const configuration: EvaluationConsoleConfiguration = {
      identity: { profileId: profile.profileId, profileDigest: profile.profileDigest, configDigest: profile.configDigest, pricingDigest: profile.pricingDigest },
      profileDigest: profile.profileDigest,
      configDigest: profile.configDigest,
      pricingDigest: profile.pricingDigest,
      requestedModel: profile.model,
      adapterVersions: profile.adapterVersions,
    };

    const approvals = fixture.route.approvalPort;
    runtimeRefs.approvals = approvals;
    const baseValidateBinding = approvals.validateBinding.bind(approvals);
    approvals.validateBinding = async (binding: ApprovalBinding): Promise<boolean> => {
      const boundContext = planApprovalContexts.get(binding.decisionId);
      if (!boundContext) return baseValidateBinding(binding);
      const known = approvals.getRecordedBindings().some(item => item.decisionId === binding.decisionId);
      if (!known) return false;
      const resolved = await approvals.resolve(binding.decisionId);
      if (computeCanonicalSha256(resolved) !== computeCanonicalSha256(binding)) return false;
      const checked = validateApprovalBinding(binding, boundContext);
      return checked.ok && checked.value.status === 'approved';
    };

    const replanPortAdapter: MaterialReplanPortV02 = {
      provenance: 'mock',
      async accept(request) {
        const owner = fixture.statePort.getUnderlying();
        const current = await owner.loadTask(request.taskId);
        assert.ok(current);
        const replanLedger = owner.getLedgers().find(ledger => ledger.scope === 'task' && ledger.kind === 'replan');
        assert.ok(replanLedger);
        const reservationId = `reservation-${request.proposalId}`;
        owner.internalSetLedger({
          ...replanLedger,
          reservations: [...replanLedger.reservations, { reservationId, keyedId: request.proposalId, amount: 1 }],
          version: replanLedger.version + 1,
        });
        const nextPlanVersion = request.priorPlanVersion + 1;
        const renewedDecisionId = `dec-plan-${request.taskId}-v${nextPlanVersion}`;
        const nextPlan: FixPlan = { ...request.candidatePlan, planVersion: nextPlanVersion, decisionRef: renewedDecisionId };
        const next: TaskState = {
          ...current,
          stateVersion: request.priorStateVersion + 2,
          node: 'AwaitPlan',
          nextAction: 'approve-fix-plan',
          planVersion: nextPlanVersion,
          plan: nextPlan,
          activeDecisionId: renewedDecisionId,
          latestReviewRef: undefined,
          reviewRefs: [],
          replanCount: request.expectedNextReplanCount,
          budgetLedgers: owner.getLedgers(),
        };
        const { binding, freshness } = buildPlanApprovalBinding(renewedDecisionId, resolvedTask, next, nextPlan);
        approvals.scriptDecision(binding);
        await approvals.requestDecision(binding);
        planApprovalContexts.set(renewedDecisionId, freshness);
        transitionContexts.set(next.stateVersion + 1, { approval: { binding: { ...binding, status: 'approved' }, freshness } });
        owner.internalSetTask(next);
        const saved = await owner.loadTask(request.taskId);
        assert.ok(saved);
        return { outcome: 'accepted', state: saved, reservationReceipt: reservationId, transitionReceipt: `transition-${request.proposalId}` };
      },
    };
    const ownerDeliveries: readonly OwnerDelivery[] = fixture.host.inputs.owner.map(delivery => (delivery.component === 'replanPort' ? { ...delivery, adapter: replanPortAdapter } : delivery));

    const readiness = prepareControlledUC03Host({
      ...fixture.host.inputs,
      owner: ownerDeliveries,
      identity: configuration.identity,
      config: { ...fixture.host.inputs.config, generation: undefined },
    });
    assert.equal(readiness.status, 'controlled-ready');
    if (readiness.status !== 'controlled-ready') throw new Error('Controlled readiness was refused');

    Object.assign(readiness.config, {
      async completionContextFor(input: UC03CompletionContextRequest): Promise<UC03TrustedCompletion | undefined> {
        const record: UC03TrustedCompletion = {
          taskId: input.task.taskId,
          runId: input.state.runId,
          repositoryRevisionDigest: input.state.repositoryRevisionDigest,
          diffDigest: input.diffInfo.diffDigest,
          checkSetDigest: input.checkSetDigest,
          baselineRef: input.baseline.evidenceId,
          criteriaDigest: computeCanonicalSha256(input.task.acceptanceCriteria),
          authorizedDiffDigest: input.diffInfo.diffDigest,
          protectedTestsDigest: input.protectedTestsDigest,
          originalProtectedTestsDigest: input.originalProtectedTestsDigest,
          reviewerRoleConfigId: input.reviewResult.reviewerRoleConfigId,
          reviewIterationReservationRef: input.reviewRequest.reservationRef,
          checks: input.verificationResults,
          review: input.reviewResult,
        };
        const prior = transitionContexts.get(input.state.stateVersion);
        if (prior?.completion) return structuredClone(prior.completion);
        transitionContexts.set(input.state.stateVersion, { completion: structuredClone(record) });
        return record;
      },
    });

    const finalTreeFor = async (binding: { taskId: string; runId: string; workspaceId: string; repositoryId: string; initialRevisionDigest: string; finalRevisionDigest: string }) => {
      const source = await fixture.route.repositoryPort.readFile('src/calculator.py');
      const snapshot = await readiness.ports.hostAuthority.loadSnapshot({
        taskId: binding.taskId,
        workspaceId: binding.workspaceId,
        repositoryId: binding.repositoryId,
        expectedRevisionDigest: binding.finalRevisionDigest,
        expectedCriteriaDigest: computeCanonicalSha256(fixture.task.acceptanceCriteria),
        expectedCheckSetDigest: computeCheckSetDigest(fixture.task.requiredChecks),
        expectedTestFiles: ['tests/test_calculator.py'],
      });
      const protectedTest = snapshot?.testFiles.find(file => file.path === 'tests/test_calculator.py');
      assert.ok(protectedTest);
      return {
        ...binding,
        snapshotId: `full.tree.${binding.finalRevisionDigest.replace(/^sha256:/u, '')}`,
        complete: true as const,
        files: [
          { path: 'src/calculator.py', content: source.boundedExcerpt },
          { path: protectedTest.path, content: protectedTest.content },
        ],
      };
    };

    let graderExecutions = 0;
    const grader = createControlledSnapshotGrader({
      seed: options.seed ?? entry.version,
      status: options.graderStatus,
      onExecute: () => {
        graderExecutions += 1;
      },
    });

    const decided = new Set<string>();
    const approvalEffects: string[] = [];
    const directions: { kind: string; expectedTaskVersion: number; expectedControlVersion: number; controlVersion: number }[] = [];
    const ownerDirections = new Map<string, Readonly<{ receipt: ServiceControlReceipt; taskVersion: number }>>();
    let currentControlVersion = 0;
    let routeCalls = 0;

    const resolveClarificationResume = async (input: { readonly direction: ServiceControlReceipt | null; readonly expectedAnswerDigest: string }): Promise<ClarificationResumeReceipt | undefined> => {
      const ownerState = await fixture.statePort.loadTask(fixture.task.taskId);
      const stored = input.direction ? ownerDirections.get(input.direction.receiptRef) : undefined;
      if (
        !ownerState ||
        !stored ||
        !input.direction ||
        stored.receipt.receiptRef !== input.direction.receiptRef ||
        stored.receipt.kind !== input.direction.kind ||
        stored.receipt.taskId !== input.direction.taskId ||
        stored.receipt.controlVersion !== input.direction.controlVersion ||
        stored.taskVersion !== ownerState.stateVersion
      )
        return undefined;
      if (ownerState.node !== 'NeedsInfo' || !ownerState.clarification || ownerState.clarification.answer) return undefined;
      return {
        receiptRef: input.direction.receiptRef,
        controlVersion: input.direction.controlVersion,
        taskId: ownerState.taskId,
        runId: ownerState.runId,
        workspaceId: ownerState.workspaceId,
        stateVersion: ownerState.stateVersion,
        questionId: ownerState.clarification.questionId,
        questionDigest: ownerState.clarification.questionDigest,
        answerDigest: input.expectedAnswerDigest,
      };
    };

    const resolveDirection = (input: { readonly currentState: TaskState; readonly direction: ServiceControlReceipt | null }) => {
      const { currentState, direction } = input;
      if (!direction || currentState.node !== 'AwaitFeedback' || !currentState.plan?.decisionRef || currentState.activeDecisionId !== currentState.plan.decisionRef) {
        return undefined;
      }
      if (direction.kind !== 'revise' && direction.kind !== 'end') return undefined;
      return {
        directive: direction.kind === 'end' ? ('terminate' as const) : ('revise' as const),
        taskId: currentState.taskId,
        workspaceId: currentState.workspaceId,
        repositoryRevisionDigest: currentState.repositoryRevisionDigest,
        stateVersion: currentState.stateVersion,
        planVersion: currentState.planVersion,
        rejectedDecisionId: currentState.activeDecisionId,
        strategyDigest: currentState.plan.strategyDigest,
      };
    };

    const workflowReportBinding: EvaluationGraphReportBinding = {
      profileDigest: profile.profileDigest,
      configDigest: profile.configDigest,
      pricingDigest: profile.pricingDigest,
      adapterVersions: profile.adapterVersions,
      requestedModel: profile.model,
      timestamp: '2026-11-13T00:00:00.000Z',
      workflowEvidence: {
        grader,
        finalTree: {
          async freezeFinalTree(binding: Parameters<typeof finalTreeFor>[0]) {
            return finalTreeFor(binding);
          },
          async recheckCurrentFinalTree(binding: Parameters<typeof finalTreeFor>[0]) {
            return finalTreeFor(binding);
          },
        },
      },
    };

    const taskExperimentIds = new Set<string>();
    const customRoute = options.includeCustomRoute
      ? {
          readiness,
          coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
          expectedWait: null,
          ...(options.customRouteWorkflowReport === undefined ? {} : { workflowReport: options.customRouteWorkflowReport }),
          resolveTask: (input: { readonly experimentId: string; readonly source: { readonly kind: string; readonly bugInput?: CustomBugInputConfig } }) => {
            taskExperimentIds.add(input.experimentId);
            return input.source.kind === 'bug' && input.source.bugInput
              ? {
                  ...fixture.task,
                  goal: input.source.bugInput.goal,
                  observedBehavior: input.source.bugInput.observedBehavior,
                  expectedBehavior: input.source.bugInput.expectedBehavior,
                  reproduction: input.source.bugInput.reproduction,
                  acceptanceCriteria: [...input.source.bugInput.acceptanceCriteria],
                  constraints: [...(input.source.bugInput.constraints ?? [])],
                }
              : fixture.task;
          },
          resolveDirection,
          resolveClarificationResume,
        }
      : undefined;

    const assembly: EvaluationConsoleAssembly = {
      profile,
      catalog: [entry],
      repositoryIds: [fixture.task.repositoryId],
      checkSetIds: [DEFAULT_CHECK_SET],
      control: {
        async versions(experimentId) {
          if (!taskExperimentIds.has(experimentId)) return null;
          const ownerState = await fixture.statePort.loadTask(fixture.task.taskId);
          if (!ownerState || (ownerState.node !== 'NeedsInfo' && ownerState.node !== 'AwaitPlan' && ownerState.node !== 'Verify' && ownerState.node !== 'AwaitFeedback')) {
            return null;
          }
          if (ownerState.node === 'AwaitPlan' || ownerState.node === 'Verify') {
            const pending = approvals.getRecordedBindings().at(-1);
            if (!pending || !decided.has(pending.decisionId)) return null;
          }
          return Object.freeze({ taskVersion: ownerState.stateVersion, controlVersion: currentControlVersion });
        },
        async issue(input) {
          const ownerState = await fixture.statePort.loadTask(fixture.task.taskId);
          // Refusal returns a malformed receipt so EvaluationService returns 409 INVALID_CONTROL_RECEIPT
          // without changing experiment version, directions log, or owner state.
          if (
            !ownerState ||
            input.expectedTaskVersion !== ownerState.stateVersion ||
            input.expectedControlVersion !== currentControlVersion ||
            !isDirectionPermitted(ownerState, input.kind, input.decisionRef)
          ) {
            return { receiptRef: '', kind: input.kind, taskId: fixture.task.taskId, controlVersion: -1 };
          }
          currentControlVersion += 1;
          const receipt: ServiceControlReceipt = Object.freeze({
            receiptRef: `journey-direction-${directions.length + 1}`,
            kind: input.kind,
            taskId: fixture.task.taskId,
            controlVersion: currentControlVersion,
          });
          directions.push({ kind: input.kind, expectedTaskVersion: input.expectedTaskVersion, expectedControlVersion: input.expectedControlVersion, controlVersion: currentControlVersion });
          ownerDirections.set(receipt.receiptRef, { receipt, taskVersion: ownerState.stateVersion });
          return receipt;
        },
      },
      approval: {
        presentation() {
          const pending = approvals.getRecordedBindings().at(-1);
          if (!pending) return { ok: false, status: 'not-found', reasonCode: 'NO_PRESENTATION' };
          return { ok: true, value: { taskId: pending.taskId, decisionId: pending.decisionId, actionKind: pending.actionKind, status: decided.has(pending.decisionId) ? 'decided' : pending.status } };
        },
        async decide(input) {
          const body = input as { decisionId?: unknown; choice?: unknown };
          const pending = approvals.getRecordedBindings().at(-1);
          if (!pending || body.decisionId !== pending.decisionId) return { ok: false, status: 'conflict', reasonCode: 'STALE_DECISION' };
          if (decided.has(pending.decisionId)) return { ok: false, status: 'conflict', reasonCode: 'DECISION_ALREADY_RECORDED' };
          if (body.choice !== 'approve' && body.choice !== 'reject') return { ok: false, status: 'invalid-input', reasonCode: 'UNSUPPORTED_CHOICE' };
          const snapshot = await fixture.statePort.readVerificationAuthoritySnapshot(fixture.task.taskId);
          assert.ok(snapshot);
          const next = { ...snapshot.policyIdentity, decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration + 1 };
          assert.equal((await fixture.statePort.publishAuthority({ authorityRef: next })).status, 'published');
          approvals.setV02AuthorityRef(next);
          const nextStatus = body.choice === 'approve' ? 'approved' : 'rejected';
          approvals.scriptDecision({
            ...pending,
            status: nextStatus,
            ...(nextStatus === 'rejected' ? { reason: 'Operator rejected proposed fix plan' } : {}),
          });
          decided.add(pending.decisionId);
          approvalEffects.push(pending.decisionId);
          // The route scripts the pre-patch reproduction as failing; after the patch the same command passes.
          if (nextStatus === 'approved' && pending.decisionId.startsWith('dec-verify-')) {
            fixture.route.repositoryPort.setCommandResult('pytest -q tests/test_calculator.py -k test_divide_zero', { exitCode: 0, stdout: '1 passed', stderr: '' });
          }
          return { ok: true, value: { decisionId: pending.decisionId, status: nextStatus } };
        },
      },
      routesFor(ready, catalog) {
        routeCalls += 1;
        return new Map([
          [
            'C01',
            {
              entry: catalog[0],
              readiness: ready,
              coderBudget: { maxModelCalls: 8, maxActiveMs: 60_000, maxRepairs: 2, maxReplans: 3 },
              expectedWait: null,
              workflowReport: workflowReportBinding,
              resolveTask: ({ experimentId }: { readonly experimentId: string }) => {
                taskExperimentIds.add(experimentId);
                return fixture.task;
              },
              resolveDirection,
              resolveClarificationResume,
            },
          ],
        ]);
      },
      ...(customRoute === undefined ? {} : { customRoute }),
      operatorToken: () => token,
    };

    return {
      files,
      entry,
      fixture,
      profile,
      configuration,
      readiness,
      assembly,
      grader,
      workflowReportBinding,
      approvalEffects,
      directions,
      counters: () => ({ routeCalls }),
      graderExecutions: () => graderExecutions,
    };
  } catch (error) {
    await rm(files, { recursive: true, force: true });
    throw error;
  }
}

export function createConsoleHttpClient(origin: string, token = DEFAULT_CONSOLE_TOKEN): ConsoleHttpClient {
  const headers = { 'content-type': 'application/json', origin, 'x-operator-token': token };
  return {
    async get<T = ExperimentView>(path: string): Promise<HttpReply<T>> {
      const response = await fetch(`${origin}${path}`);
      return { status: response.status, headers: response.headers, body: (await response.json()) as ConsoleEnvelope<T> };
    },
    async getText(path: string) {
      const response = await fetch(`${origin}${path}`);
      return { status: response.status, headers: response.headers, text: await response.text() };
    },
    async post<T = ExperimentReply>(path: string, body: unknown): Promise<HttpReply<T>> {
      const response = await fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: (await response.json()) as ConsoleEnvelope<T> };
    },
    async postRaw(path: string, body: unknown): Promise<HttpRawReply> {
      const response = await fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, headers: response.headers, body: (await response.json()) as ConsoleErrorBody | unknown };
    },
  };
}

export async function issueControlDirection(client: ConsoleHttpClient, experimentId: string, body: unknown): Promise<{ readonly experiment: ExperimentView; readonly receipt: ServiceControlReceipt }> {
  const reply = await client.post<DirectionReply>(`/api/experiments/${experimentId}/directions`, body);
  assert.equal(reply.status, 200);
  const { experiment, receipt } = reply.body.result;
  assert.ok('controlVersion' in receipt, 'expected UC-05 ServiceControlReceipt');
  return { experiment, receipt };
}

export async function approveCurrentAndContinue(
  client: ConsoleHttpClient,
  composed: ComposedControlledConsole,
  experimentId: string,
  expectedControlVersion: number,
  keyPrefix: string,
): Promise<{ readonly experiment: ExperimentView; readonly controlVersion: number }> {
  const pres = await client.get<{ decisionId: string }>(`/api/experiments/${experimentId}/approval`);
  assert.equal(pres.status, 200);
  const decided = await client.post(`/api/experiments/${experimentId}/decision`, { decisionId: pres.body.result.decisionId, choice: 'approve' });
  assert.equal(decided.status, 200);
  const ownerState = await composed.fixture.statePort.loadTask(composed.fixture.task.taskId);
  assert.ok(ownerState);
  const dirReply = await issueControlDirection(client, experimentId, {
    expectedTaskVersion: ownerState.stateVersion,
    expectedControlVersion,
    kind: 'resume',
    idempotencyKey: `${keyPrefix}-dir`,
  });
  const cont = await client.post(`/api/experiments/${experimentId}/continue`, {
    expectedVersion: dirReply.experiment.version,
    directionRef: dirReply.receipt.receiptRef,
    idempotencyKey: `${keyPrefix}-cont`,
  });
  assert.equal(cont.status, 200);
  return { experiment: cont.body.result.experiment, controlVersion: dirReply.receipt.controlVersion };
}

export async function withControlledConsole<T = void>(
  options: ControlledConsoleOptions,
  run: (ctx: { readonly composed: ComposedControlledConsole; readonly host: EvaluationConsoleHost; readonly origin: string; readonly client: ConsoleHttpClient }) => Promise<T>,
): Promise<T> {
  const composed = await composeControlledConsole(options);
  let startedHost: EvaluationConsoleHost | undefined;
  try {
    const started = await createEvaluationConsoleHost(composed.readiness, composed.configuration, () => composed.assembly);
    assert.equal(started.ok, true);
    if (!started.ok) throw new Error('Controlled console host failed to start');
    startedHost = started.host;
    const origin = `http://${started.host.address.host}:${started.host.address.port}`;
    const client = createConsoleHttpClient(origin, options.token);
    return await run({ composed, host: started.host, origin, client });
  } finally {
    if (startedHost) await startedHost.close();
    await rm(composed.files, { recursive: true, force: true });
  }
}
