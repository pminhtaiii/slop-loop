/** Validation and clarification-projection helpers for the UC-03 evaluation graph adapter. */

import { computeCanonicalSha256, validateBugTask, type BugTask, type ClarificationQuestion, type TaskState } from '../contracts/foundation/uc03.ts';
import { checkControlledPortsV02, checkProductionPortsV02, type UC03GraphConfigV02, type UC03GraphPortsV02 } from '../uc03/graph-types-v02.ts';
import type { TrustedReplanDirection } from '../uc03/repair-types.ts';
import type { WorkflowCaseHost } from '../../eval/uc03/workflow-driver.ts';
import { isWorkflowEvidenceHost } from './evaluation-graph-report.ts';
import type { BoundSource, CaseBinding, CatalogEntry } from './evaluation-profile.ts';
import type { AnswerRecord, EvaluationGraphResult, ServiceControlReceipt } from './evaluation-service-types.ts';

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

export interface ValidatedCaseBinding {
  readonly task: BugTask;
  readonly ports: UC03GraphPortsV02;
  readonly config: UC03GraphConfigV02;
  readonly workflowEvidence?: WorkflowCaseHost['workflowEvidence'] | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sameBinding(entry: CatalogEntry, binding: CaseBinding): boolean {
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

export function taskMatchesSource(task: BugTask, source: BoundSource): boolean {
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

/** Validates a per-case binding before any owner state lookup or graph effect. */
export function validateCaseBinding(candidate: unknown, status: 'ready' | 'controlled-ready', source: BoundSource, expectedInitialRevision: string | undefined): ValidatedCaseBinding | undefined {
  if (!isPlainObject(candidate) || candidate['ok'] !== true) return undefined;
  const rawTask = candidate['task'];
  if (!isPlainObject(rawTask)) return undefined;
  const parsedTask = validateBugTask(rawTask);
  if (!parsedTask.ok) return undefined;
  const task = parsedTask.value;
  if (!taskMatchesSource(task, source)) return undefined;
  if (expectedInitialRevision !== undefined && task.initialRevisionDigest.replace(/^sha256:/u, '') !== expectedInitialRevision) return undefined;

  const rawPorts = candidate['ports'];
  const rejection = status === 'ready' ? checkProductionPortsV02(rawPorts) : checkControlledPortsV02(rawPorts);
  if (rejection !== null) return undefined;

  const rawConfig = candidate['config'];
  if (!isPlainObject(rawConfig) || rawConfig['generation'] !== undefined) return undefined;
  const expected = rawConfig['trustedExpectedContext'];
  if (
    !isPlainObject(expected) ||
    expected['taskId'] !== task.taskId ||
    typeof expected['workspaceId'] !== 'string' ||
    expected['workspaceId'].trim() === '' ||
    expected['repositoryId'] !== task.repositoryId ||
    expected['revisionDigest'] !== task.initialRevisionDigest ||
    typeof expected['criteriaDigest'] !== 'string' ||
    typeof expected['checkSetDigest'] !== 'string' ||
    !Array.isArray(expected['expectedTestFiles']) ||
    expected['expectedTestFiles'].some(file => typeof file !== 'string') ||
    typeof expected['admissionContextForCheck'] !== 'function'
  ) {
    return undefined;
  }

  const rawEvidence = candidate['workflowEvidence'];
  if (rawEvidence !== undefined && !isWorkflowEvidenceHost(rawEvidence)) return undefined;

  return {
    task,
    // Runtime checks above verify the v0.2 port surface and required trusted context fields.
    ports: rawPorts as UC03GraphPortsV02,
    config: rawConfig as unknown as UC03GraphConfigV02,
    ...(rawEvidence === undefined ? {} : { workflowEvidence: rawEvidence }),
  };
}

export function validDirection(direction: TrustedReplanDirection, state: TaskState, receipt: ServiceControlReceipt): boolean {
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

export function answerItems(record: TaskState['clarification'], answers: readonly AnswerRecord[]): Readonly<{ answer: AnswerRecord; items: readonly ClarificationQuestion[] }> | undefined {
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

export function validClarificationReceipt(
  receipt: ClarificationResumeReceipt | undefined,
  direction: ServiceControlReceipt,
  state: TaskState,
  questionId: string,
  questionDigest: string,
  answerDigest: string,
): receipt is ClarificationResumeReceipt {
  return (
    receipt !== undefined &&
    receipt.receiptRef === direction.receiptRef &&
    receipt.controlVersion === direction.controlVersion &&
    receipt.taskId === state.taskId &&
    receipt.runId === state.runId &&
    receipt.workspaceId === state.workspaceId &&
    receipt.stateVersion === state.stateVersion &&
    receipt.questionId === questionId &&
    receipt.questionDigest === questionDigest &&
    receipt.answerDigest === answerDigest
  );
}

export function clarificationView(state: TaskState | null): EvaluationGraphResult['workflowClarification'] {
  const record = state?.node === 'NeedsInfo' ? state.clarification : undefined;
  if (!record || record.answer) return null;
  return Object.freeze({
    questionId: record.questionId,
    questionDigest: record.questionDigest,
    questions: Object.freeze(record.questions.map(question => Object.freeze({ questionId: question.questionId, text: question.text }))),
  });
}
