/**
 * Bound clarification producer — the only place either clarification record is assembled.
 *
 * Both writes go through the owner transition helper, so `stateVersion` bumps by exactly one and the
 * persisted state is reloaded and compared. The digests are integrity checks, not provenance: any
 * caller that knows the field values can compute a self-consistent record (§8).
 */
import {
  computeClarificationAnswerDigest,
  computeClarificationQuestionDigest,
  computeClarificationQuestionId,
  type ClarificationAnswer,
  type ClarificationRecord,
  type StatePort,
  type TaskState,
} from '../contracts/foundation/uc03.ts';
import type { CoderProposal } from './agent-types.ts';
import { transitionState } from './graph-transitions.ts';

/** The single source of the round bound; the transition guard enforces the same number. */
export const CLARIFICATION_ROUND_CAP = 3;

export type ClarificationPort = Pick<StatePort, 'loadTask' | 'transition'>;

export interface ClarificationWrite {
  readonly state: TaskState;
  readonly replayed: boolean;
}

function sameQuestions(left: readonly { readonly questionId: string; readonly text: string }[], right: readonly { readonly questionId: string; readonly text: string }[]): boolean {
  return left.length === right.length && left.every((item, index) => item.questionId === right[index]?.questionId && item.text === right[index]?.text);
}

/**
 * Persist the asked record. A replay re-derives both ids from the record's own fields — including its
 * stored `askedAtStateVersion` — and returns the prior state without touching the port.
 */
export async function askClarification(input: {
  readonly statePort: ClarificationPort;
  readonly prior: TaskState;
  readonly proposal: Extract<CoderProposal, { kind: 'request-info' }>;
}): Promise<ClarificationWrite> {
  const questions = input.proposal.questions.map(question => ({ questionId: question.questionId, text: question.text }));
  const evidenceRefs = [...input.proposal.evidenceRefs];
  const existing = input.prior.clarification;

  if (
    existing &&
    computeClarificationQuestionId({ taskId: input.prior.taskId, runId: input.prior.runId, round: existing.round, questions: existing.questions, evidenceRefs: existing.evidenceRefs }) ===
      existing.questionId &&
    computeClarificationQuestionDigest({
      taskId: input.prior.taskId,
      runId: input.prior.runId,
      askedAtStateVersion: existing.askedAtStateVersion,
      round: existing.round,
      questionId: existing.questionId,
      questions: existing.questions,
      evidenceRefs: existing.evidenceRefs,
    }) === existing.questionDigest &&
    sameQuestions(existing.questions, questions) &&
    existing.evidenceRefs.length === evidenceRefs.length &&
    existing.evidenceRefs.every((ref, index) => ref === evidenceRefs[index])
  ) {
    return { state: input.prior, replayed: true };
  }

  const round = (existing?.round ?? 0) + 1;
  const questionId = computeClarificationQuestionId({ taskId: input.prior.taskId, runId: input.prior.runId, round, questions, evidenceRefs });
  const questionDigest = computeClarificationQuestionDigest({
    taskId: input.prior.taskId,
    runId: input.prior.runId,
    askedAtStateVersion: input.prior.stateVersion,
    round,
    questionId,
    questions,
    evidenceRefs,
  });
  const record: ClarificationRecord = { questionId, questionDigest, askedAtStateVersion: input.prior.stateVersion, round, questions, evidenceRefs };
  // The write carries its refs in; the guard checks the subset against this same array, once.
  const next: TaskState = {
    ...input.prior,
    stateVersion: input.prior.stateVersion + 1,
    node: 'NeedsInfo',
    evidenceRefs: [...new Set([...input.prior.evidenceRefs, ...evidenceRefs])],
    clarification: record,
  };
  return { state: await transitionState(input.statePort, next, input.prior.stateVersion), replayed: false };
}

/**
 * Persist the answered record on `NeedsInfo → Investigate`. Accepts the prior record unanswered
 * (normal write) or already answered with an identical digest (replay); a different digest refuses.
 */
export async function recordClarificationAnswer(input: {
  readonly statePort: ClarificationPort;
  readonly prior: TaskState;
  readonly answer: { readonly recorderRef: string; readonly items: readonly { readonly questionId: string; readonly text: string }[] };
}): Promise<ClarificationWrite> {
  const record = input.prior.clarification;
  if (!record) throw new Error('CLARIFICATION_RECORD_REQUIRED: the prior state carries no clarification record');
  const items = input.answer.items.map(item => ({ questionId: item.questionId, text: item.text }));
  const answerDigest = computeClarificationAnswerDigest({ questionDigest: record.questionDigest, recorderRef: input.answer.recorderRef, items });
  const asked = new Set(record.questions.map(question => question.questionId));
  if (new Set(items.map(item => item.questionId)).size !== items.length || asked.size !== items.length || items.some(item => !asked.has(item.questionId)))
    throw new Error('CLARIFICATION_ANSWER_INCOMPLETE: the answer must cover the asked set exactly, once each');
  if (record.answer) {
    if (record.answer.answerDigest === answerDigest) return { state: input.prior, replayed: true };
    throw new Error('CLARIFICATION_ANSWER_SUBSTITUTED: the open record already carries a different answer');
  }
  const answer: ClarificationAnswer = { answerDigest, answeredAtStateVersion: input.prior.stateVersion, recorderRef: input.answer.recorderRef, items };
  const next: TaskState = {
    ...input.prior,
    stateVersion: input.prior.stateVersion + 1,
    node: 'Investigate',
    clarification: { ...record, answer },
  };
  return { state: await transitionState(input.statePort, next, input.prior.stateVersion), replayed: false };
}
