/** Host-composition §8 clarification record validation, split out of `state/task.ts` to keep that module bounded. */

import { computeClarificationAnswerDigest, computeClarificationQuestionDigest, computeClarificationQuestionId } from '../../../identity.ts';
import { CLARIFICATION_ROUND_CAP } from '../../clarification-types.ts';
import type { ClarificationAnswer, ClarificationQuestion, ClarificationRecord, ValidationError } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validatePositiveInteger } from '../common.ts';

const CLARIFICATION_ALLOWED_KEYS = ['questionId', 'questionDigest', 'askedAtStateVersion', 'round', 'questions', 'evidenceRefs', 'answer'] as const;
const CLARIFICATION_ANSWER_ALLOWED_KEYS = ['answerDigest', 'answeredAtStateVersion', 'recorderRef', 'items'] as const;
const CLARIFICATION_MAX_ITEMS = 16;
const CLARIFICATION_MAX_TEXT_BYTES = 1024;
const CLARIFICATION_MAX_REFS = 16;
const CLARIFICATION_MAX_REF_BYTES = 128;

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

/** A non-empty raw string. Digests are re-derived from these exact bytes, never from a trimmed view. */
function validateRawString(val: unknown, path: string, errors: ValidationError[], maxBytes = Number.POSITIVE_INFINITY): string | undefined {
  if (typeof val !== 'string' || val.trim().length === 0) {
    errors.push({ path, code: 'INVALID_CLARIFICATION_STRING', message: `${path} must be a non-empty string` });
    return undefined;
  }
  if (byteLength(val) > maxBytes) {
    errors.push({ path, code: 'CLARIFICATION_REF_TOO_LONG', message: `${path} must be at most ${maxBytes} bytes` });
    return undefined;
  }
  return val;
}

/** One bounded question/answer item list; `questionId`s are the proposal's own ids. */
function validateClarificationItems(input: unknown, path: string, errors: ValidationError[]): ClarificationQuestion[] | undefined {
  // Non-empty: an empty ask would pause the task with nothing to answer, and an empty answer would
  // cover that nothing exactly.
  if (!Array.isArray(input) || input.length === 0 || input.length > CLARIFICATION_MAX_ITEMS) {
    errors.push({ path, code: 'INVALID_CLARIFICATION_ITEMS', message: `${path} must be a non-empty array of at most ${CLARIFICATION_MAX_ITEMS} items` });
    return undefined;
  }
  const items: ClarificationQuestion[] = [];
  for (let i = 0; i < input.length; i++) {
    const item: unknown = input[i];
    if (!isPlainObject(item)) {
      errors.push({ path: `${path}[${i}]`, code: 'INVALID_CLARIFICATION_ITEM', message: 'Clarification item must be an object' });
      continue;
    }
    rejectUnknownKeys(item, ['questionId', 'text'], `${path}[${i}]`, errors);
    const questionId = validateRawString(item['questionId'], `${path}[${i}].questionId`, errors);
    const text = validateRawString(item['text'], `${path}[${i}].text`, errors, CLARIFICATION_MAX_TEXT_BYTES);
    if (questionId !== undefined && text !== undefined) items.push({ questionId, text });
  }
  return items;
}

function validateClarificationRefs(input: unknown, path: string, errors: ValidationError[]): string[] | undefined {
  if (!Array.isArray(input) || input.length > CLARIFICATION_MAX_REFS) {
    errors.push({ path, code: 'INVALID_CLARIFICATION_REFS', message: `${path} must be an array of at most ${CLARIFICATION_MAX_REFS} refs` });
    return undefined;
  }
  const refs: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const ref = validateRawString(input[i], `${path}[${i}]`, errors, CLARIFICATION_MAX_REF_BYTES);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

/**
 * Re-derive every digest from the record as stored. Integrity only: any caller that knows the values
 * can compute a self-consistent record, so this detects corruption, not forgery (§8).
 */
export function validateClarification(
  input: unknown,
  path: string,
  identity: { readonly taskId: string | undefined; readonly runId: string | undefined },
  errors: ValidationError[],
): ClarificationRecord | undefined {
  if (!isPlainObject(input)) {
    errors.push({ path, code: 'INVALID_CLARIFICATION_RECORD', message: 'clarification must be an object' });
    return undefined;
  }
  const before = errors.length;
  rejectUnknownKeys(input, CLARIFICATION_ALLOWED_KEYS, path, errors);
  const questionId = validateRawString(input['questionId'], `${path}.questionId`, errors, CLARIFICATION_MAX_REF_BYTES);
  const questionDigest = validateRawString(input['questionDigest'], `${path}.questionDigest`, errors);
  const askedAtStateVersion = validatePositiveInteger(input['askedAtStateVersion'], `${path}.askedAtStateVersion`, errors);
  const round = validatePositiveInteger(input['round'], `${path}.round`, errors);
  if (round !== undefined && round > CLARIFICATION_ROUND_CAP) {
    errors.push({ path: `${path}.round`, code: 'CLARIFICATION_ROUND_EXCEEDED', message: `Clarification round cannot exceed ${CLARIFICATION_ROUND_CAP}` });
  }
  const questions = validateClarificationItems(input['questions'], `${path}.questions`, errors);
  const evidenceRefs = validateClarificationRefs(input['evidenceRefs'], `${path}.evidenceRefs`, errors);

  let answer: ClarificationAnswer | undefined;
  if (input['answer'] !== undefined) {
    const answerPath = `${path}.answer`;
    const raw: unknown = input['answer'];
    if (!isPlainObject(raw)) {
      errors.push({ path: answerPath, code: 'INVALID_CLARIFICATION_ANSWER', message: 'clarification.answer must be an object' });
    } else {
      rejectUnknownKeys(raw, CLARIFICATION_ANSWER_ALLOWED_KEYS, answerPath, errors);
      const answerDigest = validateRawString(raw['answerDigest'], `${answerPath}.answerDigest`, errors);
      const answeredAtStateVersion = validatePositiveInteger(raw['answeredAtStateVersion'], `${answerPath}.answeredAtStateVersion`, errors);
      const recorderRef = validateRawString(raw['recorderRef'], `${answerPath}.recorderRef`, errors, CLARIFICATION_MAX_REF_BYTES);
      const items = validateClarificationItems(raw['items'], `${answerPath}.items`, errors);
      if (answerDigest !== undefined && answeredAtStateVersion !== undefined && recorderRef !== undefined && items !== undefined) {
        answer = { answerDigest, answeredAtStateVersion, recorderRef, items };
        // The answer must cover the asked set exactly once each (§8), so the digest cannot hide an omission.
        if (questions !== undefined) {
          const asked = new Set(questions.map(question => question.questionId));
          const answered = new Set(items.map(item => item.questionId));
          if (answered.size !== items.length || answered.size !== asked.size || items.some(item => !asked.has(item.questionId)))
            errors.push({ path: `${answerPath}.items`, code: 'CLARIFICATION_ANSWER_INCOMPLETE', message: 'The answer must cover the asked set exactly, once each' });
        }
      }
    }
  }

  if (questionId !== undefined && questionDigest !== undefined && askedAtStateVersion !== undefined && round !== undefined && questions !== undefined && evidenceRefs !== undefined) {
    if (identity.taskId !== undefined && identity.runId !== undefined) {
      if (computeClarificationQuestionId({ taskId: identity.taskId, runId: identity.runId, round, questions, evidenceRefs }) !== questionId) {
        errors.push({ path: `${path}.questionId`, code: 'CLARIFICATION_QUESTION_ID_MISMATCH', message: 'questionId does not derive from the stored record' });
      }
      if (computeClarificationQuestionDigest({ taskId: identity.taskId, runId: identity.runId, askedAtStateVersion, round, questionId, questions, evidenceRefs }) !== questionDigest) {
        errors.push({ path: `${path}.questionDigest`, code: 'CLARIFICATION_QUESTION_DIGEST_MISMATCH', message: 'questionDigest does not recompute from the stored record' });
      }
    }
    if (answer !== undefined && computeClarificationAnswerDigest({ questionDigest, recorderRef: answer.recorderRef, items: answer.items }) !== answer.answerDigest) {
      errors.push({ path: `${path}.answer.answerDigest`, code: 'CLARIFICATION_ANSWER_DIGEST_MISMATCH', message: 'answerDigest does not recompute from the stored record' });
    }
  }

  if (errors.length > before) return undefined;
  return {
    questionId: questionId as string,
    questionDigest: questionDigest as string,
    askedAtStateVersion: askedAtStateVersion as number,
    round: round as number,
    questions: questions as ClarificationQuestion[],
    evidenceRefs: evidenceRefs as string[],
    ...(answer !== undefined ? { answer } : {}),
  };
}
