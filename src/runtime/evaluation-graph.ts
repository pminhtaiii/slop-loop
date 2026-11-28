/** Source adapter from the existing evaluation service to the shared UC-03 v0.2 graph. */

import { computeCanonicalSha256, validateBugTask, validateTaskState, type BugTask, type ClarificationQuestion, type TaskState } from '../contracts/foundation/uc03.ts';
import type { CoderBudget } from '../uc03/agent-types.ts';
import type { TrustedReplanDirection } from '../uc03/repair-types.ts';
import { runControlledUC03GraphV02, runUC03GraphV02 } from '../uc03/graph-v02.ts';
import type { UC03GraphConfigV02, UC03GraphPortsV02 } from '../uc03/graph-types-v02.ts';
import type { UC03ControlledHostReadiness, UC03HostReadiness } from './uc03-host-bootstrap.ts';
import { createHostCoderGeneration } from './host-coder.ts';
import type { BoundSource, CatalogEntry } from './evaluation-profile.ts';
import type { AnswerRecord, EvaluationGraph, EvaluationGraphResult, EvaluationTaskIdentity, ServiceControlReceipt } from './evaluation-service-types.ts';
import { projectMilestones } from './evaluation-milestone-view.ts';
import { reportUC03GraphResult, validateEvaluationGraphReportBinding, type EvaluationGraphReportBinding } from './evaluation-graph-report.ts';
import {
  clarificationView,
  resolveNeedsInfoDirection,
  sameBinding,
  taskMatchesSource,
  validateCaseBinding,
  validDirection,
  type ClarificationEndReceipt,
  type ClarificationResumeReceipt,
} from './evaluation-graph-validation.ts';
import type { WorkflowCaseHost } from '../../eval/uc03/workflow-driver.ts';
import type { UC03WorkflowResult } from '../uc03/graph-types.ts';

export type { ClarificationEndReceipt, ClarificationResumeReceipt };

type ReadyHost = Extract<UC03HostReadiness, { readonly status: 'ready' }> | Extract<UC03ControlledHostReadiness, { readonly status: 'controlled-ready' }>;

export interface EvaluationTaskResolutionInput {
  readonly experimentId: string;
  readonly source: BoundSource;
  /** The prior owner identity is null only before first task allocation. */
  readonly priorState: EvaluationTaskIdentity | null;
  readonly answers: readonly AnswerRecord[];
}

export interface EvaluationCaseBindingInput {
  readonly experimentId: string;
  readonly source: BoundSource;
  readonly task: BugTask;
  readonly priorState: EvaluationTaskIdentity | null;
  readonly answers: readonly AnswerRecord[];
}

export type EvaluationCaseBinding =
  | Readonly<{ ok: true; task: BugTask; ports: UC03GraphPortsV02; config: UC03GraphConfigV02; workflowEvidence?: WorkflowCaseHost['workflowEvidence'] | undefined }>
  | Readonly<{ ok: false; reasonCode: string }>;

export interface EvaluationDirectionResolutionInput {
  readonly experimentId: string;
  readonly task: BugTask;
  readonly currentState: TaskState;
  /** The exact control receipt selected by continueExperiment; null on initial execution. */
  readonly direction: ServiceControlReceipt | null;
  readonly answers: readonly AnswerRecord[];
}

export interface ClarificationResumeResolutionInput extends EvaluationDirectionResolutionInput {
  readonly answer: AnswerRecord;
  readonly answerItems: readonly ClarificationQuestion[];
  readonly expectedAnswerDigest: string;
}

export interface UC03EvaluationGraphRoute {
  readonly entry?: CatalogEntry | undefined;
  readonly readiness: ReadyHost;
  readonly coderBudget: CoderBudget;
  readonly expectedWait: 'waiting-approval' | 'waiting-info' | null;
  readonly resolveTask: (input: EvaluationTaskResolutionInput) => BugTask | Promise<BugTask>;
  /** Optional per-case binding resolved once per experiment after task resolution; overrides startup readiness ports and config. */
  readonly bindCase?: ((input: EvaluationCaseBindingInput) => EvaluationCaseBinding | Promise<EvaluationCaseBinding>) | undefined;
  /** Called for every invocation after task allocation and current owner state reload. */
  readonly resolveDirection: (input: EvaluationDirectionResolutionInput) => TrustedReplanDirection | undefined | Promise<TrustedReplanDirection | undefined>;
  /** Resolves current owner control/state and binds the complete reporter answer set before its CAS write. */
  readonly resolveClarificationResume?: ((input: ClarificationResumeResolutionInput) => ClarificationResumeReceipt | undefined | Promise<ClarificationResumeReceipt | undefined>) | undefined;
  /** Resolves current owner control/state for ending an unresolved NeedsInfo wait without resuming the graph. */
  readonly resolveClarificationEnd?: ((input: EvaluationDirectionResolutionInput) => ClarificationEndReceipt | undefined | Promise<ClarificationEndReceipt | undefined>) | undefined;
  /** Runs terminal host effects only after the NeedsInfo end receipt is accepted. */
  readonly onClarificationEndAccepted?: ((experimentId: string) => void) | undefined;
  /** Host-only report identity and optional controlled grader wiring; never accepted from service input. */
  readonly workflowReport?: EvaluationGraphReportBinding | undefined;
}

export interface UC03EvaluationGraphOptions {
  /** Host routes keyed by the bound catalog case id. */
  readonly catalogRoutes: ReadonlyMap<string, UC03EvaluationGraphRoute>;
  /** Custom submissions stay ungraded; a route may execute them through the same graph. */
  readonly customRoute?: UC03EvaluationGraphRoute | undefined;
}

interface GraphPortToken {
  readonly experimentId: string;
  readonly source: BoundSource;
  readonly route: UC03EvaluationGraphRoute | undefined;
  readonly refusal: string | undefined;
}

interface RunSession {
  readonly route: UC03EvaluationGraphRoute;
  readonly resolvedTaskDigest: string;
  readonly taskDigest: string;
  readonly task: BugTask;
  readonly ports: UC03GraphPortsV02;
  readonly config: UC03GraphConfigV02;
  readonly generation: NonNullable<UC03GraphConfigV02['generation']>;
  readonly workflowEvidence?: WorkflowCaseHost['workflowEvidence'] | undefined;
}

const incomplete = (state: EvaluationTaskIdentity | null): EvaluationGraphResult => ({ outcome: 'INCOMPLETE', state });

/**
 * Uses only a previously assembled route in `portsFor`; owner allocation, state lookup and direction
 * resolution happen in `run`. Continuations retain the experiment's bound task, ports, config and coder generation.
 */
export function createUC03EvaluationGraph(options: UC03EvaluationGraphOptions): EvaluationGraph {
  if (!(options?.catalogRoutes instanceof Map)) throw new Error('Invalid UC-03 evaluation graph routes');
  const catalogRoutes = new Map(options.catalogRoutes);
  const reportBindings = new Map<UC03EvaluationGraphRoute, EvaluationGraphReportBinding>();
  for (const [caseId, route] of catalogRoutes) {
    if (route.workflowReport === undefined) continue;
    if ((route.readiness.status !== 'controlled-ready' && route.readiness.status !== 'ready') || route.entry?.caseId !== caseId) throw new Error('Invalid workflow report route');
    const mode = route.readiness.status === 'ready' ? 'real' : 'mock';
    reportBindings.set(route, validateEvaluationGraphReportBinding(caseId, route.readiness.identity, route.workflowReport, mode));
  }
  if (options.customRoute?.workflowReport !== undefined) throw new Error('Custom workflow submissions cannot carry a catalog report binding');
  const portTokens = new WeakMap<object, GraphPortToken>();
  const sessions = new Map<string, RunSession>();

  const select = (source: BoundSource): Readonly<{ route: UC03EvaluationGraphRoute | undefined; refusal: string | undefined }> => {
    if (source.kind === 'catalog') {
      if (source.bindings.length !== 1) return { route: undefined, refusal: 'CATALOG_CASE_COUNT_UNSUPPORTED' };
      const binding = source.bindings[0];
      if (!binding) return { route: undefined, refusal: 'CATALOG_BINDING_UNAVAILABLE' };
      const route = catalogRoutes.get(binding.caseId);
      if (!route?.entry || !sameBinding(route.entry, binding)) return { route: undefined, refusal: 'CATALOG_ROUTE_UNAVAILABLE' };
      return { route, refusal: undefined };
    }
    if (source.status !== 'complete') return { route: undefined, refusal: 'INCOMPLETE_INTAKE' };
    return options.customRoute ? { route: options.customRoute, refusal: undefined } : { route: undefined, refusal: 'CUSTOM_ROUTE_UNAVAILABLE' };
  };

  return {
    portsFor(input) {
      const selected = select(input.source);
      const token = Object.freeze({ experimentId: input.experimentId, source: input.source, ...selected });
      portTokens.set(token, token);
      return token;
    },

    async run(input) {
      if (typeof input.ports !== 'object' || input.ports === null) return incomplete(input.priorState);
      const token = portTokens.get(input.ports);
      if (!token || token.experimentId !== input.experimentId || token.source !== input.source || token.refusal || !token.route) return incomplete(input.priorState);
      const route = token.route;
      const readiness = route.readiness;
      if (readiness?.status !== 'ready' && readiness?.status !== 'controlled-ready') return incomplete(input.priorState);
      if (route.bindCase === undefined) {
        if (readiness.config.generation !== undefined) return incomplete(input.priorState);
      } else if (typeof route.bindCase !== 'function') {
        return incomplete(input.priorState);
      }

      let resolvedTask: BugTask;
      try {
        resolvedTask = await route.resolveTask({
          experimentId: input.experimentId,
          source: input.source,
          priorState: input.priorState,
          answers: input.answers,
        });
      } catch {
        return incomplete(input.priorState);
      }
      if (!validateBugTask(resolvedTask).ok || !taskMatchesSource(resolvedTask, input.source)) return incomplete(input.priorState);
      const expectedInitialRevision = input.source.kind === 'catalog' ? input.source.bindings[0]?.initialRepositoryDigest : undefined;
      if (expectedInitialRevision !== undefined && resolvedTask.initialRevisionDigest.replace(/^sha256:/u, '') !== expectedInitialRevision) return incomplete(input.priorState);

      const resolvedTaskDigest = computeCanonicalSha256(resolvedTask);
      const priorSession = sessions.get(input.experimentId);
      if (priorSession && (priorSession.route !== route || (priorSession.resolvedTaskDigest !== resolvedTaskDigest && priorSession.taskDigest !== resolvedTaskDigest))) {
        return incomplete(input.priorState);
      }

      let task: BugTask;
      let activePorts: UC03GraphPortsV02;
      let activeConfig: UC03GraphConfigV02;
      let boundEvidence: WorkflowCaseHost['workflowEvidence'] | undefined;
      if (priorSession) {
        task = priorSession.task;
        activePorts = priorSession.ports;
        activeConfig = priorSession.config;
        boundEvidence = priorSession.workflowEvidence;
      } else if (route.bindCase !== undefined) {
        let bound: ReturnType<typeof validateCaseBinding>;
        try {
          const rawBinding = await route.bindCase({
            experimentId: input.experimentId,
            source: input.source,
            task: resolvedTask,
            priorState: input.priorState,
            answers: input.answers,
          });
          bound = validateCaseBinding(rawBinding, readiness.status, input.source, expectedInitialRevision);
        } catch {
          return incomplete(input.priorState);
        }
        if (!bound) return incomplete(input.priorState);
        task = bound.task;
        activePorts = bound.ports;
        activeConfig = bound.config;
        boundEvidence = bound.workflowEvidence;
      } else {
        task = resolvedTask;
        activePorts = readiness.ports;
        activeConfig = readiness.config;
      }

      let current: TaskState | null;
      try {
        current = await activePorts.statePort.loadTask(task.taskId);
      } catch {
        return incomplete(input.priorState);
      }
      if (!current || !validateTaskState(current).ok || current.taskId !== task.taskId || current.repositoryId !== task.repositoryId) return incomplete(input.priorState);
      if (input.priorState !== null && (input.priorState.taskId !== current.taskId || input.priorState.runId !== current.runId || input.priorState.workspaceId !== current.workspaceId))
        return incomplete(input.priorState);
      if (input.direction && input.direction.taskId !== current.taskId) return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });

      let session = priorSession;
      if (!session) {
        try {
          const generation = createHostCoderGeneration({
            model: activePorts.modelPort,
            repository: activePorts.repositoryPort,
            guardedRead: activePorts.guardedRead,
            admissionContextForCheck: activeConfig.trustedExpectedContext.admissionContextForCheck,
            budget: route.coderBudget,
          });
          session = {
            route,
            resolvedTaskDigest,
            taskDigest: computeCanonicalSha256(task),
            task,
            ports: activePorts,
            config: activeConfig,
            generation,
            ...(boundEvidence === undefined ? {} : { workflowEvidence: boundEvidence }),
          };
          sessions.set(input.experimentId, session);
        } catch {
          return incomplete(input.priorState);
        }
      }

      let trustedDirection: TrustedReplanDirection | undefined;
      try {
        trustedDirection = await route.resolveDirection({
          experimentId: input.experimentId,
          task,
          currentState: current,
          direction: input.direction,
          answers: input.answers,
        });
      } catch {
        return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
      }
      let graphInitialState: TaskState | undefined;
      let endedNeedsInfo: UC03WorkflowResult | undefined;
      if (input.direction !== null && current.node === 'NeedsInfo') {
        const resolvedNeeds = await resolveNeedsInfoDirection({
          experimentId: input.experimentId,
          task,
          current,
          direction: input.direction,
          answers: input.answers,
          ports: activePorts,
          expectedContext: activeConfig.trustedExpectedContext,
          generation: session.generation,
          trustedDirection,
          resolveClarificationResume: route.resolveClarificationResume,
          resolveClarificationEnd: route.resolveClarificationEnd,
        });
        if (resolvedNeeds.kind === 'refused') {
          return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
        }
        if (resolvedNeeds.kind === 'end') {
          route.onClarificationEndAccepted?.(input.experimentId);
          endedNeedsInfo = resolvedNeeds.result;
        } else graphInitialState = resolvedNeeds.initialState;
      }
      if (input.direction === null && trustedDirection !== undefined) return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
      if (trustedDirection && (!input.direction || !validDirection(trustedDirection, current, input.direction))) {
        return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
      }
      const config: UC03GraphConfigV02 = {
        ...activeConfig,
        generation: session.generation,
        trustedDirection,
      };
      const graphResult =
        endedNeedsInfo ??
        (readiness.status === 'ready' ? await runUC03GraphV02(task, activePorts, config, graphInitialState) : await runControlledUC03GraphV02(task, activePorts, config, graphInitialState));
      const state = graphResult.executionEvidence?.finalState ?? graphResult.state;
      const reportBinding = reportBindings.get(route);
      const workflowEvidence = session.workflowEvidence ?? reportBinding?.workflowEvidence;
      const workflowReport =
        reportBinding && route.entry
          ? await reportUC03GraphResult({
              host: {
                entry: route.entry,
                task,
                expectedWait: route.expectedWait,
                ...(workflowEvidence === undefined ? {} : { workflowEvidence }),
              } satisfies WorkflowCaseHost,
              result: graphResult,
              ports: activePorts,
              generation: session.generation,
              trustedExpectedContext: activeConfig.trustedExpectedContext,
              binding: reportBinding,
              mode: readiness.status === 'ready' ? 'real' : 'mock',
            })
          : undefined;
      const milestones = projectMilestones(graphResult.milestones);
      return {
        outcome: graphResult.outcome,
        state: state ? { taskId: state.taskId, runId: state.runId, workspaceId: state.workspaceId } : null,
        workflowClarification: endedNeedsInfo ? null : clarificationView(state),
        ...(graphResult.finalReport ? { usage: { tokensConsumed: graphResult.finalReport.usage.tokensConsumed, costUsd: graphResult.finalReport.usage.costUsd } } : {}),
        ...(workflowReport === undefined ? {} : { workflowReport }),
        ...(milestones === null ? {} : { milestones }),
      };
    },
  };
}
