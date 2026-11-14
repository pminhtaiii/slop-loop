import { randomUUID } from 'node:crypto';
import { deepFreeze } from '../contracts/foundation/uc03/v02/admission/snapshot.ts';
import { sha256Text } from '../uc01/contracts.ts';
import { bindEvaluationSource, isAdmittedEvaluationProfile, type BoundSource, type EvaluationProfile } from './evaluation-profile.ts';
import {
  bindingsExplained,
  fail,
  ID,
  idValue,
  keyValue,
  ok,
  questionsOf,
  record,
  statusOf,
  TERMINAL,
  textValue,
  versionValue,
  viewOf,
  type EvaluationGraphResult,
  type EvaluationService,
  type EvaluationServiceDeps,
  type ExperimentReceipt,
  type ExperimentRecord,
  type ExperimentView,
  type ServiceControlReceipt,
  type ServiceResult,
  type SubmissionView,
} from './evaluation-service-types.ts';

export function createEvaluationService(deps: EvaluationServiceDeps): EvaluationService {
  if (typeof deps !== 'object' || deps === null || typeof deps.control?.issue !== 'function' || typeof deps.graph?.run !== 'function' || typeof deps.graph?.portsFor !== 'function') {
    throw new Error('Invalid evaluation service dependencies');
  }
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.ids ?? (() => `exp-${randomUUID()}`);
  const host = { profile: deps.profile as EvaluationProfile, catalog: deps.catalog, repositoryIds: deps.repositoryIds, checkSetIds: deps.checkSetIds };
  const experiments = new Map<string, ExperimentRecord>();
  const receipts = new Map<string, Readonly<{ fingerprint: string; receipt: ExperimentReceipt }>>();
  let activeId: string | undefined;

  /** Callers deny a conflicting or stale replay before reaching here. */
  const remember = (key: string, fingerprint: string, receipt: ExperimentReceipt): ExperimentReceipt => {
    const frozen = Object.freeze(receipt);
    receipts.set(key, Object.freeze({ fingerprint, receipt: frozen }));
    return frozen;
  };

  const preflight = (profileId: unknown, source: unknown): ServiceResult<BoundSource> => {
    if (!isAdmittedEvaluationProfile(deps.profile)) return fail('blocked', 'NOT_ADMITTED');
    if (profileId !== deps.profile.profileId) return fail('blocked', 'PROFILE_MISMATCH');
    const bound = bindEvaluationSource(source, host);
    if (!bound.ok) return fail('blocked', bound.reasonCode);
    if (bound.value.kind === 'catalog' && !bindingsExplained(bound.value.bindings, deps.catalog)) return fail('blocked', 'CATALOG_MISMATCH');
    return ok(bound.value);
  };

  const execute = async (experiment: ExperimentRecord, direction: ServiceControlReceipt | null = null): Promise<EvaluationGraphResult> => {
    const ports = deps.graph.portsFor(Object.freeze({ experimentId: experiment.id, source: experiment.startedSource }));
    return deps.graph.run(
      Object.freeze({
        experimentId: experiment.id,
        source: experiment.startedSource,
        ports,
        priorState: experiment.task,
        direction,
        answers: Object.freeze([...experiment.answers]),
      }),
    );
  };

  const applyResult = (experiment: ExperimentRecord, result: EvaluationGraphResult): void => {
    experiment.status = statusOf(result.outcome);
    experiment.version += 1;
    // Task identity comes from owner state only; a continuation never reallocates it.
    if (result.state !== null) experiment.task = Object.freeze({ taskId: result.state.taskId, runId: result.state.runId, workspaceId: result.state.workspaceId });
    if (result.usage !== undefined) experiment.usage = Object.freeze({ tokensConsumed: result.usage.tokensConsumed, costUsd: result.usage.costUsd });
    if (result.workflowClarification !== undefined) {
      const clarification = result.workflowClarification;
      experiment.workflowClarification =
        clarification === null
          ? null
          : Object.freeze({
              questionId: clarification.questionId,
              questionDigest: clarification.questionDigest,
              questions: Object.freeze(clarification.questions.map(question => Object.freeze({ questionId: question.questionId, text: question.text }))),
            });
    }
    // Detach and freeze once: neither the graph's retained report nor a returned view rewrites stored evidence.
    // A result without a report has none: the previous execution's report is not the current one.
    const report = result.workflowReport;
    experiment.workflowReport = report == null ? null : deepFreeze(structuredClone(report));
    if (TERMINAL.has(experiment.status)) activeId = activeId === experiment.id ? undefined : activeId;
  };

  return {
    async startExperiment(input: unknown): Promise<ServiceResult<Readonly<{ experiment: ExperimentView; receipt: ExperimentReceipt }>>> {
      const request = record(input, ['source', 'profileId', 'idempotencyKey']);
      if (!request) return fail('invalid-input', 'INVALID_REQUEST');
      const key = keyValue(request['idempotencyKey']);
      if (!key) return fail('invalid-input', 'INVALID_IDEMPOTENCY_KEY');
      const fingerprint = sha256Text(JSON.stringify([request['profileId'], request['source']]));

      const stored = receipts.get(key);
      if (stored) {
        if (stored.fingerprint !== fingerprint) return fail('conflict', 'CONFLICTING_REPLAY');
        const existing = experiments.get(stored.receipt.experimentId);
        if (!existing) return fail('not-found', 'UNKNOWN_EXPERIMENT');
        return ok({ experiment: viewOf(existing), receipt: stored.receipt });
      }
      if (activeId !== undefined) {
        const active = experiments.get(activeId);
        if (active && !TERMINAL.has(active.status)) return fail('busy', 'EXPERIMENT_ACTIVE');
        activeId = undefined;
      }

      const bound = preflight(request['profileId'], request['source']);
      if (!bound.ok) return fail(bound.status, bound.reasonCode);
      const source = bound.value;
      const id = nextId();
      if (!ID.test(id)) return fail('invalid-input', 'INVALID_EXPERIMENT_ID');
      const submission: SubmissionView | null =
        source.kind === 'bug'
          ? Object.freeze({
              submissionId: source.submissionId,
              submissionDigest: source.submissionDigest,
              repositoryId: source.repositoryId,
              checkSetId: source.checkSetId,
              questions: source.status === 'needs-info' ? Object.freeze(questionsOf(source)) : Object.freeze([]),
            })
          : null;

      const experiment: ExperimentRecord = {
        id,
        scope: source.kind === 'catalog' ? 'catalog' : 'exploratory',
        bindings: source.kind === 'catalog' ? source.bindings : Object.freeze([]),
        submission,
        task: null,
        startedSource: source,
        status: 'running',
        version: 1,
        usage: null,
        workflowClarification: null,
        workflowReport: null,
        answers: [],
        directions: [],
      };
      experiments.set(id, experiment);
      activeId = id;

      // Incomplete bug intake is non-executable: no task, run, workspace, port or graph call.
      if (source.kind === 'bug' && source.status === 'needs-info') {
        experiment.status = 'waiting-info';
        const receipt = remember(key, fingerprint, { receiptId: `rcpt-start-${id}`, kind: 'start', idempotencyKey: key, experimentId: id, version: experiment.version });
        return ok({ experiment: viewOf(experiment), receipt });
      }

      applyResult(experiment, await execute(experiment));
      const receipt = remember(key, fingerprint, { receiptId: `rcpt-start-${id}`, kind: 'start', idempotencyKey: key, experimentId: id, version: experiment.version });
      return ok({ experiment: viewOf(experiment), receipt });
    },

    getExperiment(id: unknown): ServiceResult<ExperimentView> {
      const experimentId = idValue(id);
      if (!experimentId) return fail('invalid-input', 'INVALID_EXPERIMENT_ID');
      const experiment = experiments.get(experimentId);
      return experiment ? ok(viewOf(experiment)) : fail('not-found', 'UNKNOWN_EXPERIMENT');
    },

    async answerClarification(input: unknown): Promise<ServiceResult<Readonly<{ experiment: ExperimentView; receipt: ExperimentReceipt }>>> {
      const request = record(input, ['id', 'questionId', 'questionDigest', 'expectedVersion', 'answers', 'idempotencyKey']);
      if (!request) return fail('invalid-input', 'INVALID_REQUEST');
      const key = keyValue(request['idempotencyKey']);
      const experimentId = idValue(request['id']);
      const version = versionValue(request['expectedVersion']);
      if (!key || !experimentId || version === undefined) return fail('invalid-input', 'INVALID_REQUEST');
      const fingerprint = sha256Text(JSON.stringify([experimentId, request['questionId'], request['questionDigest'], version, request['answers']]));
      const stored = receipts.get(key);
      if (stored) {
        if (stored.fingerprint !== fingerprint) return fail('conflict', 'CONFLICTING_REPLAY');
        const existing = experiments.get(stored.receipt.experimentId);
        return existing ? ok({ experiment: viewOf(existing), receipt: stored.receipt }) : fail('not-found', 'UNKNOWN_EXPERIMENT');
      }

      const experiment = experiments.get(experimentId);
      if (!experiment) return fail('not-found', 'UNKNOWN_EXPERIMENT');
      if (experiment.version !== version) return fail('conflict', 'STALE_VERSION');
      const submission = experiment.submission;
      const currentClarification = experiment.workflowClarification;
      const intakeQuestion = submission?.questions.find(item => item.questionId === request['questionId']);
      const graphClarification =
        currentClarification !== null && currentClarification.questionId === request['questionId'] && currentClarification.questionDigest === request['questionDigest']
          ? currentClarification
          : undefined;
      const questionDigest = intakeQuestion?.questionDigest ?? graphClarification?.questionDigest;
      if (questionDigest === undefined || questionDigest !== request['questionDigest']) return fail('conflict', submission || currentClarification ? 'UNKNOWN_QUESTION' : 'NO_SUBMISSION');
      const answers = request['answers'];
      if (!Array.isArray(answers) || answers.length === 0 || answers.length > 16 || answers.some(answer => textValue(answer, 1024) === undefined)) {
        return fail('invalid-input', 'INVALID_ANSWERS');
      }
      if (graphClarification && answers.length !== graphClarification.questions.length) return fail('invalid-input', 'INVALID_ANSWERS');
      if (experiment.answers.some(answer => answer.questionId === request['questionId'])) return fail('conflict', 'QUESTION_ALREADY_ANSWERED');

      // Reporter data only: answers never approve, resume or advance the task.
      experiment.answers = [
        ...experiment.answers,
        Object.freeze({ questionId: request['questionId'] as string, questionDigest, answers: Object.freeze([...(answers as string[])]), recordedAt: now() }),
      ];
      experiment.version += 1;
      const receipt = remember(key, fingerprint, {
        receiptId: `rcpt-answer-${experiment.id}-${experiment.version}`,
        kind: 'answer',
        idempotencyKey: key,
        experimentId: experiment.id,
        version: experiment.version,
      });
      return ok({ experiment: viewOf(experiment), receipt });
    },

    async issueDirection(input: unknown): Promise<ServiceResult<Readonly<{ experiment: ExperimentView; receipt: ServiceControlReceipt | ExperimentReceipt }>>> {
      const request = record(input, ['id', 'expectedTaskVersion', 'expectedControlVersion', 'kind', 'decisionRef', 'feedback', 'idempotencyKey']);
      if (!request) return fail('invalid-input', 'INVALID_REQUEST');
      const key = keyValue(request['idempotencyKey']);
      const experimentId = idValue(request['id']);
      const taskVersion = versionValue(request['expectedTaskVersion']);
      const controlVersion = versionValue(request['expectedControlVersion']);
      const kind = request['kind'];
      if (!key || !experimentId || taskVersion === undefined || controlVersion === undefined || (kind !== 'resume' && kind !== 'revise' && kind !== 'end')) {
        return fail('invalid-input', 'INVALID_REQUEST');
      }
      if (request['decisionRef'] !== undefined && idValue(request['decisionRef']) === undefined) return fail('invalid-input', 'INVALID_DECISION_REF');
      if (request['feedback'] !== undefined && textValue(request['feedback'], 4096) === undefined) return fail('invalid-input', 'INVALID_FEEDBACK');
      const fingerprint = sha256Text(JSON.stringify([experimentId, taskVersion, controlVersion, kind, request['decisionRef'], request['feedback']]));

      const stored = receipts.get(key);
      if (stored) {
        if (stored.fingerprint !== fingerprint) return fail('conflict', 'CONFLICTING_REPLAY');
        const existing = experiments.get(stored.receipt.experimentId);
        if (!existing) return fail('not-found', 'UNKNOWN_EXPERIMENT');
        const direction = existing.directions.find(receipt => receipt.receiptRef === stored.receipt.receiptId);
        // Only the local end-of-intake receipt has kind 'direction' without a UC-05 direction record.
        if (direction) return ok({ experiment: viewOf(existing), receipt: direction });
        return stored.receipt.kind === 'direction' ? ok({ experiment: viewOf(existing), receipt: stored.receipt }) : fail('conflict', 'UNKNOWN_DIRECTION');
      }

      const experiment = experiments.get(experimentId);
      if (!experiment) return fail('not-found', 'UNKNOWN_EXPERIMENT');
      // Pre-task intake accepts answers but never execution directions.
      if (experiment.task === null && (experiment.status === 'waiting-info' || experiment.submission?.questions.length)) {
        // Only a taskless intake can end locally; a graph-produced wait still belongs to UC-05 control.
        if (kind !== 'end') return fail('conflict', 'INCOMPLETE_INTAKE');
        // No UC-05 task exists here, so termination is recorded locally rather than issued by control.
        experiment.status = 'incomplete';
        experiment.version += 1;
        if (activeId === experiment.id) activeId = undefined;
        const receipt = remember(key, fingerprint, {
          receiptId: `rcpt-direction-${experiment.id}-${experiment.version}`,
          kind: 'direction',
          idempotencyKey: key,
          experimentId: experiment.id,
          version: experiment.version,
        });
        return ok({ experiment: viewOf(experiment), receipt });
      }
      const receipt = await deps.control.issue(
        Object.freeze({
          experimentId,
          kind,
          expectedTaskVersion: taskVersion,
          expectedControlVersion: controlVersion,
          ...(typeof request['decisionRef'] === 'string' ? { decisionRef: request['decisionRef'] } : {}),
          ...(typeof request['feedback'] === 'string' ? { feedback: request['feedback'] } : {}),
        }),
      );
      if (
        !record(receipt, ['receiptRef', 'kind', 'taskId', 'controlVersion']) ||
        idValue(receipt.receiptRef) === undefined ||
        idValue(receipt.taskId) === undefined ||
        receipt.kind !== kind ||
        versionValue(receipt.controlVersion) === undefined
      ) {
        return fail('conflict', 'INVALID_CONTROL_RECEIPT');
      }
      const validated: ServiceControlReceipt = Object.freeze({ receiptRef: receipt.receiptRef, kind: receipt.kind, taskId: receipt.taskId, controlVersion: receipt.controlVersion });
      experiment.directions = [...experiment.directions, validated];
      experiment.version += 1;
      receipts.set(key, Object.freeze({ fingerprint, receipt: Object.freeze({ receiptId: validated.receiptRef, kind: 'direction', idempotencyKey: key, experimentId, version: experiment.version }) }));
      return ok({ experiment: viewOf(experiment), receipt: validated });
    },

    async continueExperiment(input: unknown): Promise<ServiceResult<Readonly<{ experiment: ExperimentView; receipt: ExperimentReceipt }>>> {
      const request = record(input, ['id', 'expectedVersion', 'directionRef', 'idempotencyKey']);
      if (!request) return fail('invalid-input', 'INVALID_REQUEST');
      const key = keyValue(request['idempotencyKey']);
      const experimentId = idValue(request['id']);
      const version = versionValue(request['expectedVersion']);
      const directionRef = idValue(request['directionRef']);
      if (!key || !experimentId || version === undefined || !directionRef) return fail('invalid-input', 'INVALID_REQUEST');
      const fingerprint = sha256Text(JSON.stringify([experimentId, version, directionRef]));

      const stored = receipts.get(key);
      if (stored) {
        if (stored.fingerprint !== fingerprint) return fail('conflict', 'CONFLICTING_REPLAY');
        const existing = experiments.get(stored.receipt.experimentId);
        return existing ? ok({ experiment: viewOf(existing), receipt: stored.receipt }) : fail('not-found', 'UNKNOWN_EXPERIMENT');
      }

      const experiment = experiments.get(experimentId);
      if (!experiment) return fail('not-found', 'UNKNOWN_EXPERIMENT');
      if (experiment.version !== version) return fail('conflict', 'STALE_VERSION');
      if (!experiment.directions.some(receipt => receipt.receiptRef === directionRef)) return fail('conflict', 'UNKNOWN_DIRECTION');

      // Reload owner state; continuation preserves task identity and accumulated usage.
      const direction = experiment.directions.find(receipt => receipt.receiptRef === directionRef);
      if (!direction) return fail('conflict', 'UNKNOWN_DIRECTION');
      applyResult(experiment, await execute(experiment, direction));
      const receipt = remember(key, fingerprint, {
        receiptId: `rcpt-continue-${experiment.id}-${experiment.version}`,
        kind: 'continue',
        idempotencyKey: key,
        experimentId: experiment.id,
        version: experiment.version,
      });
      return ok({ experiment: viewOf(experiment), receipt });
    },
  };
}
