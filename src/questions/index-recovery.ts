/** Validates the current-head publication receipt; it grants no authority or question-session recovery. */
import { validateQuestionIndexGeneration } from '../contracts/questions/validation.ts';
import type { SourceSnapshotV1 } from '../contracts/questions/contracts.ts';
import { matches } from './index-admission.ts';
import type { IndexWorkerReply, QuestionIndexOptions } from './index-types.ts';

export function validOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
}

export function publicationMatches(
  result: IndexWorkerReply,
  operationId: string,
  expectedGenerationId: string | null,
  snapshot: SourceSnapshotV1,
  options: QuestionIndexOptions,
): 'match' | 'missing' | 'mismatch' | 'invalid' {
  const receipt = result.publication;
  if (receipt === undefined) return 'missing';
  if (
    !receipt ||
    !validOperationId(receipt.operationId) ||
    (receipt.expectedGenerationId !== null && (typeof receipt.expectedGenerationId !== 'string' || receipt.expectedGenerationId.length < 1 || receipt.expectedGenerationId.length > 256)) ||
    !validateQuestionIndexGeneration(receipt.generation).ok ||
    !result.generation ||
    JSON.stringify(receipt.generation) !== JSON.stringify(result.generation)
  )
    return 'invalid';
  if (receipt.operationId !== operationId) return 'missing';
  return receipt.expectedGenerationId === expectedGenerationId && matches(receipt.generation, snapshot, options) ? 'match' : 'mismatch';
}
