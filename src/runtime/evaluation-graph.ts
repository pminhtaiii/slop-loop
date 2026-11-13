/** Source adapter from the existing evaluation service to the shared UC-03 v0.2 graph. */

import { computeCanonicalSha256, computeClarificationAnswerDigest, validateBugTask, validateTaskState, type BugTask, type ClarificationQuestion, type TaskState } from '../contracts/foundation/uc03.ts';
import type { CoderBudget } from '../uc03/agent-types.ts';
import { recordClarificationAnswer } from '../uc03/clarification.ts';
import { reuseClarificationBaseline } from '../uc03/graph-investigation-baseline.ts';
import type { TrustedReplanDirection } from '../uc03/repair-types.ts';
import { runControlledUC03GraphV02, runUC03GraphV02 } from '../uc03/graph-v02.ts';
import type { UC03GraphConfigV02 } from '../uc03/graph-types-v02.ts';
import type { UC03ControlledHostReadiness, UC03HostReadiness } from './uc03-host-bootstrap.ts';
import { createHostCoderGeneration } from './host-coder.ts';
import type { BoundSource, CaseBinding, CatalogEntry } from './evaluation-profile.ts';
import type { AnswerRecord, EvaluationGraph, EvaluationGraphResult, EvaluationTaskIdentity, ServiceControlReceipt } from './evaluation-service-types.ts';

type ReadyHost = Extract<UC03HostReadiness, { readonly status: 'ready' }> | Extract<UC03ControlledHostReadiness, { readonly status: 'controlled-ready' }>;

export interface EvaluationTaskResolutionInput {
  readonly experimentId: string;
  readonly source: BoundSource;
  /** The prior owner identity is null only before first task allocation. */
  readonly priorState: EvaluationTaskIdentity | null;
  readonly answers: readonly AnswerRecord[];
}

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

/** Owner-read receipt for the exact current NeedsInfo continuation; it carries no task authority itself. */
export interface ClarificationResumeReceipt {
  readonly receiptRef: string;
  readonly controlVersion: number;
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly stateVersion: number;
  readonly questionId: string;
  readonly questionDigest: string;
  readonly answerDigest: string;
}

export interface UC03EvaluationGraphRoute {
  readonly entry?: CatalogEntry | undefined;
  readonly readiness: ReadyHost;
  readonly coderBudget: CoderBudget;
  readonly expectedWait: 'waiting-approval' | 'waiting-info' | null;
  readonly resolveTask: (input: EvaluationTaskResolutionInput) => BugTask | Promise<BugTask>;
  /** Called for every invocation after task allocation and current owner state reload. */
  readonly resolveDirection: (input: EvaluationDirectionResolutionInput) => TrustedReplanDirection | undefined | Promise<TrustedReplanDirection | undefined>;
  /** Resolves current owner control/state and binds the complete reporter answer set before its CAS write. */
  readonly resolveClarificationResume?: ((input: ClarificationResumeResolutionInput) => ClarificationResumeReceipt | undefined | Promise<ClarificationResumeReceipt | undefined>) | undefined;
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
  readonly taskDigest: string;
  readonly task: BugTask;
  readonly generation: NonNullable<UC03GraphConfigV02['generation']>;
}

const incomplete = (state: EvaluationTaskIdentity | null): EvaluationGraphResult => ({ outcome: 'INCOMPLETE', state });

function sameBinding(entry: CatalogEntry, binding: CaseBinding): boolean {
  return (
    entry.catalogEntryId === binding.catalogEntryId &&
    entry.caseId === binding.caseId &&
    entry.version === binding.version &&
    entry.caseDigest === binding.caseDigest &&
    entry.publicTaskDigest === binding.publicTaskDigest &&
    entry.initialRepositoryDigest === binding.initialRepositoryDigest &&
    entry.grader.version === binding.grader.version &&
    entry.grader.digest === binding.grader.digest
  );
}

function taskMatchesSource(task: BugTask, source: BoundSource): boolean {
  if (source.kind !== 'bug') return true;
  const input = source.bugInput;
  return (
    task.repositoryId === source.repositoryId &&
    task.goal === input.goal &&
    task.observedBehavior === input.observedBehavior &&
    task.expectedBehavior === input.expectedBehavior &&
    task.reproduction === input.reproduction &&
    computeCanonicalSha256(task.acceptanceCriteria) === computeCanonicalSha256(input.acceptanceCriteria) &&
    computeCanonicalSha256(task.constraints) === computeCanonicalSha256(input.constraints ?? [])
  );
}

function validDirection(direction: TrustedReplanDirection, state: TaskState, receipt: ServiceControlReceipt): boolean {
  const directive = receipt.kind === 'revise' ? 'revise' : receipt.kind === 'end' ? 'terminate' : 'resume';
  return (
    state.node === 'AwaitFeedback' &&
    direction.directive === directive &&
    direction.taskId === state.taskId &&
    direction.workspaceId === state.workspaceId &&
    direction.repositoryRevisionDigest === state.repositoryRevisionDigest &&
    direction.stateVersion === state.stateVersion &&
    direction.planVersion === state.planVersion &&
    !!state.plan?.decisionRef &&
    state.activeDecisionId === state.plan.decisionRef &&
    direction.rejectedDecisionId === state.activeDecisionId &&
    direction.strategyDigest === state.plan.strategyDigest &&
    receipt.taskId === state.taskId
  );
}

function answerItems(record: TaskState['clarification'], answers: readonly AnswerRecord[]): Readonly<{ answer: AnswerRecord; items: readonly ClarificationQuestion[] }> | undefined {
  if (!record || record.answer) return undefined;
  const matching = answers.filter(answer => answer.questionId === record.questionId);
  if (matching.length !== 1) return undefined;
  const answer = matching[0];
  if (!answer || answer.questionDigest !== record.questionDigest || answer.answers.length !== record.questions.length) return undefined;
  const items = record.questions.map((question, index) => {
    const text = answer.answers[index];
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 1024) return undefined;
    return Object.freeze({ questionId: question.questionId, text });
  });
  if (items.some(item => item === undefined)) return undefined;
  return { answer, items: Object.freeze(items as ClarificationQuestion[]) };
}

function validClarificationReceipt(
  receipt: ClarificationResumeReceipt | undefined,
  direction: ServiceControlReceipt,
  state: TaskState,
  questionId: string,
  questionDigest: string,
  answerDigest: string,
): receipt is ClarificationResumeReceipt {
  return receipt !== undefined &&
    receipt.receiptRef === direction.receiptRef &&
    receipt.controlVersion === direction.controlVersion &&
    receipt.taskId === state.taskId &&
    receipt.runId === state.runId &&
    receipt.workspaceId === state.workspaceId &&
    receipt.stateVersion === state.stateVersion &&
    receipt.questionId === questionId &&
    receipt.questionDigest === questionDigest &&
    receipt.answerDigest === answerDigest;
}

function clarificationView(state: TaskState | null): EvaluationGraphResult['workflowClarification'] {
  const record = state?.node === 'NeedsInfo' ? state.clarification : undefined;
  if (!record || record.answer) return null;
  return Object.freeze({
    questionId: record.questionId,
    questionDigest: record.questionDigest,
    questions: Object.freeze(record.questions.map(question => Object.freeze({ questionId: question.questionId, text: question.text }))),
  });
}

/**
 * Uses only a previously assembled route in `portsFor`; owner allocation, state lookup and direction
 * resolution happen in `run`. Continuations retain the route's task-scoped coder generation.
 */
export function createUC03EvaluationGraph(options: UC03EvaluationGraphOptions): EvaluationGraph {
  if (!(options?.catalogRoutes instanceof Map)) throw new Error('Invalid UC-03 evaluation graph routes');
  const catalogRoutes = new Map(options.catalogRoutes);
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
      if (readiness.status !== 'ready' && readiness.status !== 'controlled-ready') return incomplete(input.priorState);
      if (readiness.config.generation !== undefined) return incomplete(input.priorState);

      let task: BugTask;
      try {
        task = await route.resolveTask({
          experimentId: input.experimentId,
          source: input.source,
          priorState: input.priorState,
          answers: input.answers,
        });
      } catch {
        return incomplete(input.priorState);
      }
      if (!validateBugTask(task).ok || !taskMatchesSource(task, input.source)) return incomplete(input.priorState);
      const expectedInitialRevision = input.source.kind === 'catalog' ? input.source.bindings[0]?.initialRepositoryDigest : undefined;
      if (expectedInitialRevision !== undefined && task.initialRevisionDigest.replace(/^sha256:/u, '') !== expectedInitialRevision) return incomplete(input.priorState);

      let current: TaskState | null;
      try {
        current = await readiness.ports.statePort.loadTask(task.taskId);
      } catch {
        return incomplete(input.priorState);
      }
      if (!current || !validateTaskState(current).ok || current.taskId !== task.taskId || current.repositoryId !== task.repositoryId) return incomplete(input.priorState);
      if (
        input.priorState !== null &&
        (input.priorState.taskId !== current.taskId || input.priorState.runId !== current.runId || input.priorState.workspaceId !== current.workspaceId)
      ) return incomplete(input.priorState);

      const priorSession = sessions.get(input.experimentId);
      if (priorSession && (priorSession.route !== route || priorSession.taskDigest !== computeCanonicalSha256(task))) return incomplete(input.priorState);
      let session = priorSession;
      if (!session) {
        try {
          const generation = createHostCoderGeneration({
            model: readiness.ports.modelPort,
            repository: readiness.ports.repositoryPort,
            guardedRead: readiness.ports.guardedRead,
            admissionContextForCheck: readiness.config.trustedExpectedContext.admissionContextForCheck,
            budget: route.coderBudget,
          });
          session = { route, taskDigest: computeCanonicalSha256(task), task, generation };
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
      if (input.direction !== null && current.node === 'NeedsInfo') {
        const clarification = current.clarification;
        const answer = answerItems(clarification, input.answers);
        if (!clarification || !answer || input.direction.kind !== 'resume' || !route.resolveClarificationResume || trustedDirection !== undefined) {
          return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
        }
        const expectedAnswerDigest = computeClarificationAnswerDigest({
          questionDigest: clarification.questionDigest,
          recorderRef: input.direction.receiptRef,
          items: answer.items,
        });
        let receipt: ClarificationResumeReceipt | undefined;
        try {
          receipt = await route.resolveClarificationResume({
            experimentId: input.experimentId,
            task,
            currentState: current,
            direction: input.direction,
            answers: input.answers,
            answer: answer.answer,
            answerItems: answer.items,
            expectedAnswerDigest,
          });
        } catch {
          return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
        }
        if (!validClarificationReceipt(receipt, input.direction, current, clarification.questionId, clarification.questionDigest, expectedAnswerDigest)) {
          return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
        }
        const retainedBaseline = await reuseClarificationBaseline({
          generation: session.generation,
          task,
          state: current,
          statePort: readiness.ports.statePort,
          hostAuthority: readiness.ports.hostAuthority,
          expectedContext: readiness.config.trustedExpectedContext,
        });
        if (!retainedBaseline.ok) return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
        try {
          const answered = await recordClarificationAnswer({
            statePort: readiness.ports.statePort,
            prior: current,
            answer: { recorderRef: receipt.receiptRef, items: answer.items },
          });
          if (answered.replayed || answered.state.node !== 'Investigate' || answered.state.clarification?.answer?.answerDigest !== receipt.answerDigest) {
            return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
          }
          graphInitialState = answered.state;
        } catch {
          return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
        }
      }
      if (input.direction === null && trustedDirection !== undefined) return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
      if (trustedDirection && (!input.direction || !validDirection(trustedDirection, current, input.direction))) {
        return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });
      }
      if (input.direction && input.direction.taskId !== current.taskId) return incomplete(input.priorState ?? { taskId: current.taskId, runId: current.runId, workspaceId: current.workspaceId });

      const config: UC03GraphConfigV02 = {
        ...readiness.config,
        generation: session.generation,
        trustedDirection,
      };
      const graphResult = readiness.status === 'ready'
        ? await runUC03GraphV02(task, readiness.ports, config, graphInitialState)
        : await runControlledUC03GraphV02(task, readiness.ports, config, graphInitialState);
      const state = graphResult.executionEvidence?.finalState ?? graphResult.state;
      return {
        outcome: graphResult.outcome,
        state: state ? { taskId: state.taskId, runId: state.runId, workspaceId: state.workspaceId } : null,
        workflowClarification: clarificationView(state),
        ...(graphResult.finalReport ? { usage: { tokensConsumed: graphResult.finalReport.usage.tokensConsumed, costUsd: graphResult.finalReport.usage.costUsd } } : {}),
      };
    },
  };
}
